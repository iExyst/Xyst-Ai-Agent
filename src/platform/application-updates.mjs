import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson, restoreAtomicWriteBackup } from './files.mjs';
import { canonicalJson } from '../extensions/signed-packages.mjs';
import { withFeedCacheLock } from '../extensions/feed-cache-lock.mjs';

export const APPLICATION_UPDATE_MAX_FEED_BYTES = 256 * 1024;
const PACKAGE_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
export const APPLICATION_VERSION = process.env.XYST_APP_VERSION || JSON.parse(fs.readFileSync(PACKAGE_FILE, 'utf8')).version;

const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PLATFORMS = new Set(['win32', 'linux']);
const ARCHITECTURES = new Set(['x64', 'arm64']);
const CHANNELS = new Set(['stable', 'preview']);

/** Fetches and verifies a signed release feed. It never downloads or installs an artifact. */
export async function checkApplicationUpdates({
  settings,
  currentVersion = APPLICATION_VERSION,
  platform = process.platform,
  arch = process.arch,
  fetchImpl = globalThis.fetch,
  cacheDirectory,
  now = Date.now(),
  signal,
} = {}) {
  const mode = settings?.mode || 'disabled';
  if (!['manual', 'notify'].includes(mode)) throw updateError('Application update checks are disabled', 'APP_UPDATES_DISABLED');
  const channel = settings?.channel || 'stable';
  if (!CHANNELS.has(channel)) throw updateError('Application update channel is invalid', 'APP_UPDATE_CONFIG_INVALID');
  const feedUrl = validateFeedUrl(settings?.feed_url);
  const keyId = settings?.key_id;
  if (typeof keyId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(keyId))
    throw updateError('Application update signing key ID is not configured', 'APP_UPDATE_NOT_CONFIGURED');
  const publicKey = parsePublicKey(settings?.public_key);
  if (!VERSION_PATTERN.test(currentVersion) || !PLATFORMS.has(platform) || !ARCHITECTURES.has(arch))
    throw updateError('Current version or platform is unsupported by the update feed', 'APP_UPDATE_CONFIG_INVALID');
  if (typeof fetchImpl !== 'function') throw updateError('Application update fetch is unavailable', 'APP_UPDATE_FETCH_UNAVAILABLE');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetchImpl(feedUrl, {
      redirect: 'error',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw updateError(`Update service returned HTTP ${response.status}`, 'APP_UPDATE_HTTP_ERROR');
    const raw = await readBoundedJson(response);
    const feed = verifyFeed(raw, { keyId, publicKey, channel, now });
    if (cacheDirectory) await commitSequence(cacheDirectory, channel, feed);
    const matching = feed.releases
      .filter((release) => release.platform === platform && release.arch === arch && release.channel === channel)
      .sort((left, right) => compareVersions(right.version, left.version));
    const release = matching.find((candidate) => compareVersions(candidate.version, currentVersion) > 0) || null;
    return {
      current_version: currentVersion,
      channel,
      checked_at: new Date(now).toISOString(),
      sequence: feed.sequence,
      update_available: Boolean(release),
      release,
    };
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError')
      throw updateError('Application update check timed out', 'APP_UPDATE_TIMEOUT');
    if (error?.code?.startsWith('APP_UPDATE_')) throw error;
    throw updateError('Application update check failed', 'APP_UPDATE_CHECK_FAILED', error);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

/** Fetches the selected signed release again, downloads it to a private staging directory,
 * and returns it only after its exact size and SHA-256 have been verified. It never installs it.
 */
export async function downloadApplicationUpdate({
  settings,
  version,
  sequence,
  currentVersion = APPLICATION_VERSION,
  platform = process.platform,
  arch = process.arch,
  fetchImpl = globalThis.fetch,
  cacheDirectory,
  stagingDirectory,
  now = Date.now(),
  signal,
} = {}) {
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version) || !Number.isSafeInteger(sequence) || sequence < 1)
    throw updateError('Application update selection is invalid', 'APP_UPDATE_SELECTION_INVALID');
  if (typeof stagingDirectory !== 'string' || !path.isAbsolute(stagingDirectory))
    throw updateError('Application update staging directory is invalid', 'APP_UPDATE_STAGING_INVALID');

  const checked = await checkApplicationUpdates({
    settings,
    currentVersion,
    platform,
    arch,
    fetchImpl,
    cacheDirectory,
    now,
    signal,
  });
  if (!checked.update_available || checked.sequence !== sequence || checked.release.version !== version)
    throw updateError('The selected application release changed. Check for updates again.', 'APP_UPDATE_RELEASE_CHANGED');

  const release = checked.release;
  let stagingInfo;
  try {
    stagingInfo = await fsp.lstat(stagingDirectory);
  } catch (error) {
    throw updateError('Application update staging directory is unavailable', 'APP_UPDATE_STAGING_INVALID', error);
  }
  if (stagingInfo.isSymbolicLink() || !stagingInfo.isDirectory())
    throw updateError('Application update staging directory must be a regular directory', 'APP_UPDATE_STAGING_INVALID');

  const filePath = path.join(stagingDirectory, `xyst-${randomFileId()}.download`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30 * 60_000);
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  let stagedHandle;
  try {
    const response = await fetchImpl(release.download_url, {
      redirect: 'error',
      signal: controller.signal,
      headers: { accept: 'application/octet-stream', 'accept-encoding': 'identity' },
    });
    if (!response.ok) throw updateError(`Release artifact service returned HTTP ${response.status}`, 'APP_UPDATE_ARTIFACT_HTTP_ERROR');
    if (!response.body) throw updateError('Release artifact response is empty', 'APP_UPDATE_ARTIFACT_INVALID');
    const declaredSize = response.headers.get('content-length');
    if (declaredSize !== null && (!/^\d+$/.test(declaredSize) || Number(declaredSize) !== release.size_bytes))
      throw updateError('Release artifact size does not match the signed metadata', 'APP_UPDATE_ARTIFACT_SIZE_INVALID');

    const digest = createHash('sha256');
    let size = 0;
    const verifier = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > release.size_bytes) {
          callback(updateError('Release artifact exceeds its signed size', 'APP_UPDATE_ARTIFACT_SIZE_INVALID'));
          return;
        }
        digest.update(chunk);
        callback(null, chunk);
      },
    });
    stagedHandle = await fsp.open(filePath, 'wx', 0o600);
    const stagedWriter = new Writable({
      write(chunk, _encoding, callback) {
        let offset = 0;
        const writeAll = async () => {
          while (offset < chunk.length) {
            const { bytesWritten } = await stagedHandle.write(chunk, offset, chunk.length - offset);
            if (bytesWritten === 0) throw new Error('Application update staging write made no progress');
            offset += bytesWritten;
          }
        };
        writeAll().then(() => callback(), callback);
      },
    });
    await pipeline(Readable.fromWeb(response.body), verifier, stagedWriter, { signal: controller.signal });
    if (size !== release.size_bytes)
      throw updateError('Release artifact size does not match the signed metadata', 'APP_UPDATE_ARTIFACT_SIZE_INVALID');
    if (digest.digest('hex') !== release.sha256)
      throw updateError('Release artifact checksum does not match the signed metadata', 'APP_UPDATE_ARTIFACT_DIGEST_INVALID');
    await stagedHandle.sync();
    const fileInfo = await stagedHandle.stat();
    const currentInfo = await fsp.lstat(filePath);
    if (
      currentInfo.isSymbolicLink() ||
      !currentInfo.isFile() ||
      currentInfo.nlink !== 1 ||
      currentInfo.dev !== fileInfo.dev ||
      currentInfo.ino !== fileInfo.ino ||
      fileInfo.nlink !== 1 ||
      fileInfo.size !== release.size_bytes
    )
      throw updateError('Staged application update changed during verification', 'APP_UPDATE_STAGING_INVALID');
    await stagedHandle.close();
    stagedHandle = null;
    return {
      path: filePath,
      filename: safeReleaseFilename(release),
      size_bytes: release.size_bytes,
      sha256: release.sha256,
      dev: fileInfo.dev,
      ino: fileInfo.ino,
    };
  } catch (error) {
    await stagedHandle?.close().catch(() => {});
    await fsp.rm(filePath, { force: true }).catch(() => {});
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError')
      throw updateError('Application update download timed out or was cancelled', 'APP_UPDATE_TIMEOUT');
    if (error?.code?.startsWith('APP_UPDATE_')) throw error;
    throw updateError('Application update download failed', 'APP_UPDATE_ARTIFACT_FETCH_FAILED', error);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

async function commitSequence(directory, channel, feed) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory))
    throw updateError('Application update cache path must be absolute', 'APP_UPDATE_CACHE_INVALID');
  try {
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryInfo = await fsp.lstat(directory);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory())
      throw updateError('Application update cache directory must be a regular directory', 'APP_UPDATE_CACHE_INVALID');
    const root = await fsp.realpath(directory);
    const name = `application-updates-${channel}.json`;
    return await withFeedCacheLock(root, name, async () => {
      const filePath = path.join(root, name);
      await restoreAtomicWriteBackup(filePath, { maxBytes: 4096, decode: (serialized) => JSON.parse(serialized) });
      const previous = await readSequenceState(filePath).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      const digest = createHash('sha256').update(canonicalJson(feed)).digest('hex');
      if (previous && previous.key_id === feed.key_id) {
        if (feed.sequence < previous.sequence)
          throw updateError('Application update feed sequence rollback detected', 'APP_UPDATE_FEED_REPLAY');
        if (feed.sequence === previous.sequence && digest !== previous.digest)
          throw updateError('Application update feed sequence equivocation detected', 'APP_UPDATE_FEED_REPLAY');
        if (feed.sequence === previous.sequence) return;
      }
      await atomicWriteJson(filePath, { schema_version: 1, key_id: feed.key_id, sequence: feed.sequence, digest }, { mode: 0o600 });
    });
  } catch (error) {
    if (error?.code?.startsWith('APP_UPDATE_') || error?.code === 'FEED_CACHE_LOCKED') throw error;
    throw updateError('Application update sequence cache is unavailable', 'APP_UPDATE_CACHE_INVALID', error);
  }
}

async function readSequenceState(filePath) {
  const info = await fsp.lstat(filePath);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || info.size > 4096)
    throw updateError('Application update sequence cache is invalid', 'APP_UPDATE_CACHE_INVALID');
  const handle = await fsp.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size)
      throw updateError('Application update sequence cache changed while reading', 'APP_UPDATE_CACHE_INVALID');
    const bytes = await handle.readFile();
    if (bytes.length > 4096 || bytes.length !== info.size)
      throw updateError('Application update sequence cache exceeds its limit', 'APP_UPDATE_CACHE_INVALID');
    const state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (
      !isRecord(state) ||
      Object.keys(state).sort().join(',') !== 'digest,key_id,schema_version,sequence' ||
      state.schema_version !== 1 ||
      typeof state.key_id !== 'string' ||
      !Number.isSafeInteger(state.sequence) ||
      state.sequence < 1 ||
      !/^[a-f0-9]{64}$/.test(state.digest)
    )
      throw updateError('Application update sequence cache has an invalid schema', 'APP_UPDATE_CACHE_INVALID');
    return state;
  } finally {
    await handle.close();
  }
}

export function verifyApplicationUpdateFeed(raw, options) {
  return verifyFeed(raw, options);
}

export function applicationUpdateKeyFingerprint(pem) {
  const der = parsePublicKey(pem).export({ type: 'spki', format: 'der' });
  return `SHA256:${createHash('sha256').update(der).digest('base64').replace(/=+$/, '')}`;
}

function verifyFeed(raw, { keyId, publicKey, channel, now }) {
  if (!isRecord(raw) || typeof raw.signature !== 'string')
    throw updateError('Application update feed is invalid', 'APP_UPDATE_FEED_INVALID');
  const { signature, ...statement } = raw;
  if (Object.keys(statement).sort().join(',') !== 'channel,expires_at,issued_at,key_id,releases,schema_version,sequence')
    throw updateError('Application update feed contains unsupported fields', 'APP_UPDATE_FEED_INVALID');
  if (
    statement.schema_version !== 1 ||
    !Number.isSafeInteger(statement.sequence) ||
    statement.sequence < 1 ||
    statement.key_id !== keyId ||
    statement.channel !== channel ||
    !Array.isArray(statement.releases) ||
    statement.releases.length > 512
  )
    throw updateError('Application update feed metadata is invalid', 'APP_UPDATE_FEED_INVALID');
  const issuedAt = Date.parse(statement.issued_at);
  const expiresAt = Date.parse(statement.expires_at);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > now + 5 * 60_000 || expiresAt <= now || expiresAt <= issuedAt)
    throw updateError('Application update feed is expired or has invalid timestamps', 'APP_UPDATE_FEED_EXPIRED');
  if (expiresAt - issuedAt > 7 * 24 * 60 * 60_000)
    throw updateError('Application update feed validity exceeds seven days', 'APP_UPDATE_FEED_INVALID');
  const coordinates = new Set();
  for (const release of statement.releases) validateRelease(release, coordinates);
  const signatureBytes = Buffer.from(signature, 'base64');
  if (signatureBytes.length !== 64 || signatureBytes.toString('base64') !== signature)
    throw updateError('Application update signature encoding is invalid', 'APP_UPDATE_SIGNATURE_INVALID');
  if (!verify(null, Buffer.from(canonicalJson(statement)), publicKey, signatureBytes))
    throw updateError('Application update feed signature is invalid', 'APP_UPDATE_SIGNATURE_INVALID');
  return statement;
}

function validateRelease(release, coordinates) {
  if (
    !isRecord(release) ||
    Object.keys(release).sort().join(',') !== 'arch,channel,download_url,notes,platform,published_at,sha256,size_bytes,version'
  )
    throw updateError('Application update release record is invalid', 'APP_UPDATE_FEED_INVALID');
  if (
    !PLATFORMS.has(release.platform) ||
    !ARCHITECTURES.has(release.arch) ||
    !CHANNELS.has(release.channel) ||
    !VERSION_PATTERN.test(release.version) ||
    !Number.isSafeInteger(release.size_bytes) ||
    release.size_bytes < 1 ||
    release.size_bytes > 2 * 1024 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(release.sha256) ||
    typeof release.notes !== 'string' ||
    release.notes.length > 4_000 ||
    !Number.isFinite(Date.parse(release.published_at))
  )
    throw updateError('Application update release metadata is invalid', 'APP_UPDATE_FEED_INVALID');
  const coordinate = `${release.platform}:${release.arch}:${release.channel}:${release.version}`;
  if (coordinates.has(coordinate))
    throw updateError('Application update feed has duplicate release coordinates', 'APP_UPDATE_FEED_INVALID');
  coordinates.add(coordinate);
  let downloadUrl;
  try {
    downloadUrl = new URL(release.download_url);
  } catch {
    throw updateError('Application update URL must use HTTPS', 'APP_UPDATE_FEED_INVALID');
  }
  if (
    downloadUrl.protocol !== 'https:' ||
    !downloadUrl.hostname ||
    isIpLiteral(downloadUrl.hostname) ||
    downloadUrl.username ||
    downloadUrl.password ||
    downloadUrl.hash ||
    downloadUrl.search
  )
    throw updateError(
      'Application update URL must be a public HTTPS URL without credentials, query, or fragment',
      'APP_UPDATE_FEED_INVALID',
    );
}

function validateFeedUrl(value) {
  let url;
  try {
    if (typeof value !== 'string' || value.length > 2048) throw new Error('invalid length');
    url = new URL(value);
  } catch {
    throw updateError('Application update feed URL is not configured', 'APP_UPDATE_NOT_CONFIGURED');
  }
  if (url.protocol !== 'https:' || !url.hostname || isIpLiteral(url.hostname) || url.username || url.password || url.hash || url.search)
    throw updateError('Application update feed URL must be HTTPS without credentials, query, or fragment', 'APP_UPDATE_CONFIG_INVALID');
  return url.toString();
}

function parsePublicKey(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8_192)
    throw updateError('Application update public key is not configured', 'APP_UPDATE_NOT_CONFIGURED');
  try {
    const pem = value.trim();
    if (!/^-----BEGIN PUBLIC KEY-----\r?\n[\s\S]+\r?\n-----END PUBLIC KEY-----$/.test(pem)) throw new Error('expected public-key PEM');
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('unsupported key type');
    return key;
  } catch (error) {
    throw updateError('Application update public key must be a valid Ed25519 PEM key', 'APP_UPDATE_CONFIG_INVALID', error);
  }
}

function isIpLiteral(hostname) {
  return isIP(hostname.replace(/^\[|\]$/g, '')) !== 0;
}

function randomFileId() {
  return randomUUID();
}

function safeReleaseFilename(release) {
  const encodedName = new URL(release.download_url).pathname.split('/').at(-1) || '';
  let candidate;
  try {
    candidate = decodeURIComponent(encodedName);
  } catch {
    candidate = '';
  }
  if (
    /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(candidate) &&
    candidate !== '.' &&
    candidate !== '..' &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(candidate)
  )
    return candidate;
  return `xyst-${release.version}-${release.platform}-${release.arch}.update`;
}

async function readBoundedJson(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > APPLICATION_UPDATE_MAX_FEED_BYTES)
    throw updateError('Application update feed exceeds the size limit', 'APP_UPDATE_FEED_TOO_LARGE');
  if (!response.body) throw updateError('Application update feed response is empty', 'APP_UPDATE_FEED_INVALID');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > APPLICATION_UPDATE_MAX_FEED_BYTES)
      throw updateError('Application update feed exceeds the size limit', 'APP_UPDATE_FEED_TOO_LARGE');
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
  } catch (error) {
    if (error?.code?.startsWith('APP_UPDATE_')) throw error;
    throw updateError('Application update feed is not valid UTF-8 JSON', 'APP_UPDATE_FEED_INVALID', error);
  }
}

function compareVersions(left, right) {
  const parse = (version) => {
    const [, major, minor, patch, pre = ''] = version.match(VERSION_PATTERN);
    return { core: [major, minor, patch], pre: pre ? pre.split('.') : [] };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index++) {
    const comparison = compareNumericIdentifiers(a.core[index], b.core[index]);
    if (comparison) return comparison;
  }
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
    if (a.pre[index] === undefined || b.pre[index] === undefined) return a.pre.length - b.pre.length;
    if (a.pre[index] === b.pre[index]) continue;
    const aNumeric = /^\d+$/.test(a.pre[index]);
    const bNumeric = /^\d+$/.test(b.pre[index]);
    if (aNumeric && bNumeric) return compareNumericIdentifiers(a.pre[index], b.pre[index]);
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a.pre[index] < b.pre[index] ? -1 : 1;
  }
  return 0;
}

function compareNumericIdentifiers(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function updateError(message, code, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}
