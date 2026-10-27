import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, restoreAtomicWriteBackup } from '../platform/files.mjs';
import { canonicalJson, installSignedPackageBundle } from './signed-packages.mjs';
import { withFeedCacheLock } from './feed-cache-lock.mjs';

const CACHE_NAME = 'updates.json';
const COHORT_NAME = 'update-cohort.json';
const MAX_BYTES = 256 * 1024;
const MAX_BUNDLE_BYTES = 40 * 1024 * 1024;
const PACKAGE_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Fetch, authenticate, and persist package update metadata. No package is downloaded or activated. */
export async function refreshPackageUpdateFeed({
  installRoot,
  url,
  keyId,
  trustedKeys,
  revokedKeyIds = [],
  maxAgeHours = 72,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  signal,
}) {
  if (!url || !keyId) throw updateError('A package update URL and signing key ID are required', 'UPDATE_FEED_NOT_CONFIGURED');
  const cacheRoot = await prepareCacheRoot(installRoot);
  const cached = await readCache(cacheRoot).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
  if (cached) {
    const prior = validateFeed(cached.feed, { keyId, trustedKeys, revokedKeyIds, now, maxAgeHours, allowExpired: true });
    const priorDigest = digest(prior.statement);
    if (prior.statement.sequence !== cached.sequence || priorDigest !== cached.digest)
      throw updateError('Cached update metadata does not match its signed sequence', 'UPDATE_CACHE_INVALID');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetchImpl(url, { redirect: 'error', signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) throw updateError(`Update server returned HTTP ${response.status}`, 'UPDATE_FEED_HTTP_ERROR');
    const bytes = await readResponse(response);
    const feed = validateFeed(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), {
      keyId,
      trustedKeys,
      revokedKeyIds,
      now,
      maxAgeHours,
    });
    const hash = digest(feed.statement);
    return await withFeedCacheLock(cacheRoot, CACHE_NAME, async () => {
      await restoreAtomicWriteBackup(path.join(cacheRoot, CACHE_NAME), {
        maxBytes: MAX_BYTES,
        decode: (serialized) => JSON.parse(serialized),
      });
      const latest = await readCache(cacheRoot).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
      if (latest) {
        const prior = validateFeed(latest.feed, { keyId, trustedKeys, revokedKeyIds, now, maxAgeHours, allowExpired: true });
        if (prior.statement.sequence !== latest.sequence || digest(prior.statement) !== latest.digest)
          throw updateError('Cached update metadata does not match its signed sequence', 'UPDATE_CACHE_INVALID');
        if (feed.statement.sequence < latest.sequence || (feed.statement.sequence === latest.sequence && hash !== latest.digest))
          throw updateError('Update metadata sequence rollback or equivocation detected', 'UPDATE_FEED_REPLAY');
      }
      await atomicWriteJson(
        path.join(cacheRoot, CACHE_NAME),
        { schema_version: 1, sequence: feed.statement.sequence, digest: hash, feed: feed.raw },
        { mode: 0o600 },
      );
      return feed.statement;
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export async function getCachedPackageUpdateFeed({
  installRoot,
  url,
  keyId,
  trustedKeys,
  revokedKeyIds = [],
  maxAgeHours = 72,
  now = Date.now(),
}) {
  if (!url) throw updateError('Package update metadata is not configured', 'UPDATE_FEED_NOT_CONFIGURED');
  let cache;
  try {
    cache = await readCache(installRoot);
  } catch (error) {
    if (error.code === 'ENOENT')
      throw updateError('No cached update metadata; run extensions check-updates first', 'UPDATE_DATA_UNAVAILABLE');
    throw error;
  }
  const feed = validateFeed(cache.feed, { keyId, trustedKeys, revokedKeyIds, now, maxAgeHours });
  if (feed.statement.sequence !== cache.sequence || digest(feed.statement) !== cache.digest)
    throw updateError('Cached update metadata failed integrity validation', 'UPDATE_CACHE_INVALID');
  return feed.statement;
}

/** Validate a signed update feed before a publisher writes it to distribution storage. */
export function validatePackageUpdateFeed(feed, { keyId, trustedKeys, revokedKeyIds = [], maxAgeHours = 72, now = Date.now() } = {}) {
  const validated = validateFeed(feed, { keyId, trustedKeys, revokedKeyIds, maxAgeHours, now });
  return validated.statement;
}

export async function getPackageUpdateCohortId(installRoot) {
  const root = await prepareCacheRoot(installRoot);
  const file = path.join(root, COHORT_NAME);
  try {
    return await readCohortId(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const id = randomUUID();
  await atomicWriteJson(file, { schema_version: 1, id }, { mode: 0o600 });
  try {
    return await readCohortId(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return id;
  }
}

export function availablePackageUpdates(installedPackages, feed, { cohortId } = {}) {
  const installed = new Map(installedPackages.map((item) => [`${item.package_type}:${item.package_id}`, item.active_version]));
  return feed.packages
    .filter((item) => {
      const current = installed.get(`${item.package_type}:${item.package_id}`);
      if (!current || compareVersions(item.version, current) <= 0) return false;
      const rolloutPercentage = item.rollout_percentage ?? 100;
      if (rolloutPercentage === 100) return true;
      if (typeof cohortId !== 'string' || !cohortId)
        throw updateError('A stable update rollout cohort is required', 'UPDATE_COHORT_REQUIRED');
      const bucket =
        Number.parseInt(createHash('sha256').update(`${cohortId}\n${item.rollout_salt}`).digest('hex').slice(0, 8), 16) % 10_000;
      return bucket < rolloutPercentage * 100;
    })
    .map((item) => ({ ...item, current_version: installed.get(`${item.package_type}:${item.package_id}`) }));
}

/** Download one authenticated bundle, verify it in memory, and stage only verified files. */
export async function downloadAndInstallPackageUpdate({
  release,
  installRoot,
  trustedKeys,
  revokedKeyIds = [],
  revokedPackages = [],
  feedExpiresAt,
  fetchImpl = globalThis.fetch,
  signal,
  now = Date.now,
}) {
  if (!isRecord(release) || typeof release.package_url !== 'string' || typeof release.manifest_sha256 !== 'string')
    throw updateError('Invalid authenticated package release record', 'UPDATE_FEED_INVALID');
  if (
    !['skill', 'mcp'].includes(release.package_type) ||
    typeof release.package_id !== 'string' ||
    !PACKAGE_ID.test(release.package_id) ||
    typeof release.version !== 'string' ||
    !VERSION.test(release.version)
  )
    throw updateError('Invalid authenticated package identity', 'UPDATE_FEED_INVALID');
  let packageUrl;
  try {
    packageUrl = new URL(release.package_url);
  } catch {
    throw updateError('Update package URL must use HTTPS', 'UPDATE_FEED_INVALID');
  }
  if (
    packageUrl.protocol !== 'https:' ||
    packageUrl.username ||
    packageUrl.password ||
    packageUrl.search ||
    packageUrl.hash ||
    !/^[a-f0-9]{64}$/.test(release.manifest_sha256)
  )
    throw updateError('Update package URL or manifest digest is invalid', 'UPDATE_FEED_INVALID');
  const expires = Date.parse(feedExpiresAt);
  if (!Number.isFinite(expires) || now() > expires)
    throw updateError('Authenticated update metadata expired before download', 'UPDATE_FEED_EXPIRED');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetchImpl(release.package_url, {
      redirect: 'error',
      signal: controller.signal,
      headers: { accept: 'application/vnd.xyst.package+json, application/json' },
    });
    if (!response.ok) throw updateError(`Package server returned HTTP ${response.status}`, 'UPDATE_PACKAGE_HTTP_ERROR');
    const bundleBytes = await readPackageResponse(response);
    if (now() > expires) throw updateError('Authenticated update metadata expired during download', 'UPDATE_FEED_EXPIRED');
    const installed = await installSignedPackageBundle(bundleBytes, {
      installRoot,
      trustedKeys,
      revokedKeyIds,
      revokedPackages,
      expectedManifestSha256: release.manifest_sha256,
      expectedPackage: {
        package_type: release.package_type,
        package_id: release.package_id,
        version: release.version,
      },
    });
    return { ...installed, activated: false, authenticated_update: true };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

function validateFeed(raw, { keyId, trustedKeys, revokedKeyIds, now, maxAgeHours, allowExpired = false }) {
  if (!isRecord(raw) || typeof raw.signature !== 'string') throw updateError('Update feed is invalid JSON data', 'UPDATE_FEED_INVALID');
  const { signature, ...statement } = raw;
  if (Object.keys(statement).sort().join(',') !== 'expires_at,issued_at,key_id,packages,schema_version,sequence')
    throw updateError('Update feed contains unsupported fields', 'UPDATE_FEED_INVALID');
  if (statement.schema_version !== 1 || !Number.isSafeInteger(statement.sequence) || statement.sequence < 0 || statement.key_id !== keyId)
    throw updateError('Update feed schema, sequence, or signing key is invalid', 'UPDATE_FEED_INVALID');
  if (revokedKeyIds.includes(keyId)) throw updateError(`Update signing key '${keyId}' is revoked`, 'UPDATE_FEED_KEY_REVOKED');
  if (!Array.isArray(statement.packages) || statement.packages.length > 4096)
    throw updateError('Update feed package list is invalid', 'UPDATE_FEED_INVALID');
  const coordinates = new Set();
  for (const item of statement.packages) {
    const packageFields = Object.keys(item || {})
      .sort()
      .join(',');
    if (
      !isRecord(item) ||
      ![
        'manifest_sha256,package_id,package_type,package_url,version',
        'manifest_sha256,package_id,package_type,package_url,rollout_percentage,rollout_salt,version',
      ].includes(packageFields)
    )
      throw updateError('Update feed contains an invalid package record', 'UPDATE_FEED_INVALID');
    const coordinate = `${item.package_type}:${item.package_id}`;
    if (
      !['skill', 'mcp'].includes(item.package_type) ||
      typeof item.package_id !== 'string' ||
      !PACKAGE_ID.test(item.package_id) ||
      item.package_id.length > 96
    )
      throw updateError('Update feed package identity is invalid', 'UPDATE_FEED_INVALID');
    if (typeof item.version !== 'string' || !VERSION.test(item.version) || item.version.length > 128)
      throw updateError('Update feed package version is invalid', 'UPDATE_FEED_INVALID');
    if (typeof item.manifest_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.manifest_sha256))
      throw updateError('Update feed manifest digest is invalid', 'UPDATE_FEED_INVALID');
    if (packageFields.includes('rollout_percentage')) {
      if (
        !Number.isInteger(item.rollout_percentage) ||
        item.rollout_percentage < 0 ||
        item.rollout_percentage > 100 ||
        typeof item.rollout_salt !== 'string' ||
        !item.rollout_salt.trim() ||
        item.rollout_salt.length > 64
      )
        throw updateError('Update rollout must include a percentage from 0 to 100 and a bounded non-empty salt', 'UPDATE_FEED_INVALID');
    }
    let packageUrl;
    try {
      packageUrl = new URL(item.package_url);
    } catch {
      throw updateError('Update package URL must use HTTPS', 'UPDATE_FEED_INVALID');
    }
    if (packageUrl.protocol !== 'https:' || packageUrl.username || packageUrl.password || packageUrl.search || packageUrl.hash)
      throw updateError('Update package URL must use HTTPS without credentials, query parameters, or a fragment', 'UPDATE_FEED_INVALID');
    if (coordinates.has(coordinate)) throw updateError('Update feed contains duplicate package identities', 'UPDATE_FEED_INVALID');
    coordinates.add(coordinate);
  }
  const issued = Date.parse(statement.issued_at);
  const expires = Date.parse(statement.expires_at);
  if (
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    expires <= issued ||
    issued > now + 300_000 ||
    (!allowExpired && (now > expires || now - issued > maxAgeHours * 3_600_000))
  )
    throw updateError('Update feed is expired or outside its allowed age', 'UPDATE_FEED_EXPIRED');
  let publicKey;
  try {
    publicKey = createPublicKey(trustedKeys?.[keyId]);
    if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('wrong key type');
  } catch {
    throw updateError(`Update signing key '${keyId}' is not trusted`, 'UPDATE_FEED_KEY_UNTRUSTED');
  }
  const bytes = Buffer.from(signature, 'base64');
  if (bytes.length !== 64 || !verify(null, Buffer.from(canonicalJson(statement)), publicKey, bytes))
    throw updateError('Update feed signature verification failed', 'UPDATE_FEED_SIGNATURE_INVALID');
  return { raw, statement };
}

function compareVersions(left, right) {
  const a = VERSION.exec(left);
  const b = VERSION.exec(right);
  if (!a || !b) return 0;
  for (let index = 1; index <= 3; index++) {
    const difference = BigInt(a[index]) - BigInt(b[index]);
    if (difference) return difference < 0n ? -1 : 1;
  }
  if (a[4] === b[4]) return 0;
  if (a[4] === undefined) return 1;
  if (b[4] === undefined) return -1;
  const leftParts = a[4].split('.');
  const rightParts = b[4].split('.');
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
    if (leftParts[index] === undefined) return -1;
    if (rightParts[index] === undefined) return 1;
    const leftNumeric = /^(0|[1-9]\d*)$/.test(leftParts[index]);
    const rightNumeric = /^(0|[1-9]\d*)$/.test(rightParts[index]);
    if (leftNumeric && rightNumeric) {
      const difference = BigInt(leftParts[index]) - BigInt(rightParts[index]);
      if (difference) return difference < 0n ? -1 : 1;
    } else if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    else if (leftParts[index] !== rightParts[index]) return leftParts[index] < rightParts[index] ? -1 : 1;
  }
  return 0;
}

async function readCache(installRoot) {
  const rootInfo = await fs.lstat(installRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
    throw updateError('Update cache root must be a regular directory', 'UPDATE_CACHE_INVALID');
  const file = path.join(await fs.realpath(installRoot), CACHE_NAME);
  const before = await fs.lstat(file);
  if (before.isSymbolicLink() || !before.isFile() || before.size > MAX_BYTES)
    throw updateError('Update cache must be a bounded regular file', 'UPDATE_CACHE_INVALID');
  const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
      throw updateError('Update cache changed while reading', 'UPDATE_CACHE_INVALID');
    const chunks = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(32 * 1024, MAX_BYTES + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > MAX_BYTES) throw updateError('Update cache exceeds size limit', 'UPDATE_CACHE_INVALID');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    if (total !== before.size) throw updateError('Update cache changed while reading', 'UPDATE_CACHE_INVALID');
    const cache = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)));
    if (
      !isRecord(cache) ||
      Object.keys(cache).sort().join(',') !== 'digest,feed,schema_version,sequence' ||
      cache.schema_version !== 1 ||
      !Number.isSafeInteger(cache.sequence) ||
      !/^[a-f0-9]{64}$/.test(cache.digest)
    )
      throw updateError('Update cache schema is invalid', 'UPDATE_CACHE_INVALID');
    return cache;
  } finally {
    await handle.close();
  }
}

async function prepareCacheRoot(installRoot) {
  if (typeof installRoot !== 'string' || !path.isAbsolute(installRoot)) throw new TypeError('installRoot must be an absolute path');
  await fs.mkdir(installRoot, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(installRoot);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw updateError('Update cache root must be a regular directory', 'UPDATE_CACHE_INVALID');
  return fs.realpath(installRoot);
}

async function readResponse(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw updateError('Update feed exceeds size limit', 'UPDATE_FEED_TOO_LARGE');
  if (!response.body) throw updateError('Update server returned an empty response', 'UPDATE_FEED_INVALID');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) throw updateError('Update feed exceeds size limit', 'UPDATE_FEED_TOO_LARGE');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, total);
}

async function readPackageResponse(response) {
  if (!response.body) throw updateError('Package server returned an empty response', 'UPDATE_PACKAGE_INVALID');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BUNDLE_BYTES)
    throw updateError('Package bundle exceeds the download size limit', 'UPDATE_PACKAGE_TOO_LARGE');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BUNDLE_BYTES) throw updateError('Package bundle exceeds the download size limit', 'UPDATE_PACKAGE_TOO_LARGE');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, total);
}

function digest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

async function readCohortId(file) {
  const before = await fs.lstat(file);
  if (before.isSymbolicLink() || !before.isFile() || before.size > 1024)
    throw updateError('Update rollout cohort record is invalid', 'UPDATE_COHORT_INVALID');
  const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
      throw updateError('Update rollout cohort record changed while reading', 'UPDATE_COHORT_INVALID');
    const buffer = Buffer.alloc(1025);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 1024 || bytesRead !== opened.size || bytesRead !== before.size)
      throw updateError('Update rollout cohort record changed while reading', 'UPDATE_COHORT_INVALID');
    const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)));
    if (
      !isRecord(record) ||
      Object.keys(record).sort().join(',') !== 'id,schema_version' ||
      record.schema_version !== 1 ||
      typeof record.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.id)
    )
      throw updateError('Update rollout cohort record is invalid', 'UPDATE_COHORT_INVALID');
    return record.id;
  } finally {
    await handle.close();
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function updateError(message, code) {
  return Object.assign(new Error(message), { code });
}
