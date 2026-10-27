import { createHash, createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '../platform/files.mjs';
import { canonicalJson } from './signed-packages.mjs';
import { withFeedCacheLock } from './feed-cache-lock.mjs';

const CACHE_NAME = 'revocations.json';
const MAX_BYTES = 256 * 1024;

export async function refreshRevocationFeed({
  installRoot,
  url,
  keyId,
  trustedKeys,
  maxAgeHours = 72,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  signal,
}) {
  if (!url || !keyId) throw feedError('A revocation URL and signing key ID are required', 'REVOCATION_FEED_NOT_CONFIGURED');
  const cacheRoot = await prepareCacheRoot(installRoot);
  const cached = await readCache(cacheRoot).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
  if (cached) {
    const prior = validateFeed(cached.feed, { keyId, trustedKeys, now, maxAgeHours, allowExpired: true });
    const priorDigest = createHash('sha256').update(canonicalJson(prior.statement)).digest('hex');
    if (prior.statement.sequence !== cached.sequence || priorDigest !== cached.digest)
      throw feedError('Cached revocation data does not match its signed sequence', 'REVOCATION_CACHE_INVALID');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetchImpl(url, { redirect: 'error', signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) throw feedError(`Revocation server returned HTTP ${response.status}`, 'REVOCATION_FEED_HTTP_ERROR');
    const bytes = await readResponse(response);
    const feed = validateFeed(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), {
      keyId,
      trustedKeys,
      now,
      maxAgeHours,
    });
    const digest = createHash('sha256').update(canonicalJson(feed.statement)).digest('hex');
    return await withFeedCacheLock(cacheRoot, CACHE_NAME, async () => {
      const latest = await readCache(cacheRoot).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
      if (latest) {
        const prior = validateFeed(latest.feed, { keyId, trustedKeys, now, maxAgeHours, allowExpired: true });
        const priorDigest = createHash('sha256').update(canonicalJson(prior.statement)).digest('hex');
        if (prior.statement.sequence !== latest.sequence || priorDigest !== latest.digest)
          throw feedError('Cached revocation data does not match its signed sequence', 'REVOCATION_CACHE_INVALID');
        if (feed.statement.sequence < latest.sequence || (feed.statement.sequence === latest.sequence && digest !== latest.digest))
          throw feedError('Revocation feed sequence rollback or equivocation detected', 'REVOCATION_FEED_REPLAY');
      }
      await atomicWriteJson(
        path.join(cacheRoot, CACHE_NAME),
        { schema_version: 1, sequence: feed.statement.sequence, digest, feed: feed.raw },
        { mode: 0o600 },
      );
      return feed.statement;
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export async function getCachedRevocations({ installRoot, url, keyId, trustedKeys, maxAgeHours = 72, now = Date.now() }) {
  if (!url) return { revokedKeyIds: [], revokedPackages: [] };
  let cache;
  try {
    cache = await readCache(installRoot);
  } catch (error) {
    if (error.code === 'ENOENT')
      throw feedError(
        'Configured revocation cache is missing; refresh it before using active installed packages',
        'REVOCATION_DATA_UNAVAILABLE',
      );
    throw error;
  }
  if (cache.sequence < 0) throw feedError('Cached revocation sequence is invalid', 'REVOCATION_CACHE_INVALID');
  const feed = validateFeed(cache.feed, { keyId, trustedKeys, now, maxAgeHours });
  const digest = createHash('sha256').update(canonicalJson(feed.statement)).digest('hex');
  if (digest !== cache.digest || feed.statement.sequence !== cache.sequence)
    throw feedError('Cached revocation data does not match its integrity record', 'REVOCATION_CACHE_INVALID');
  return { revokedKeyIds: feed.statement.revoked_key_ids, revokedPackages: feed.statement.revoked_packages };
}

/** Validate a signed revocation feed before a publisher writes it to distribution storage. */
export function validateRevocationFeed(feed, { keyId, trustedKeys, maxAgeHours = 72, now = Date.now() } = {}) {
  return validateFeed(feed, { keyId, trustedKeys, maxAgeHours, now }).statement;
}

function validateFeed(raw, { keyId, trustedKeys, now, maxAgeHours, allowExpired = false }) {
  if (!record(raw) || typeof raw.signature !== 'string') throw feedError('Revocation feed is invalid JSON data', 'REVOCATION_FEED_INVALID');
  const { signature, ...statement } = raw;
  if (Object.keys(statement).sort().join(',') !== 'expires_at,issued_at,key_id,revoked_key_ids,revoked_packages,schema_version,sequence')
    throw feedError('Revocation feed contains unsupported fields', 'REVOCATION_FEED_INVALID');
  if (statement.schema_version !== 1 || !Number.isSafeInteger(statement.sequence) || statement.sequence < 0 || statement.key_id !== keyId)
    throw feedError('Revocation feed schema, sequence, or signing key is invalid', 'REVOCATION_FEED_INVALID');
  if (
    !Array.isArray(statement.revoked_key_ids) ||
    statement.revoked_key_ids.length > 512 ||
    statement.revoked_key_ids.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id))
  )
    throw feedError('Revocation feed key list is invalid', 'REVOCATION_FEED_INVALID');
  if (
    !Array.isArray(statement.revoked_packages) ||
    statement.revoked_packages.length > 4096 ||
    statement.revoked_packages.some(
      (item) =>
        typeof item !== 'string' ||
        item.length > 200 ||
        !/^(skill|mcp):[a-z0-9]+(?:[.-][a-z0-9]+)*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(item),
    )
  )
    throw feedError('Revocation feed package list is invalid', 'REVOCATION_FEED_INVALID');
  if (
    new Set(statement.revoked_key_ids).size !== statement.revoked_key_ids.length ||
    new Set(statement.revoked_packages).size !== statement.revoked_packages.length
  )
    throw feedError('Revocation feed lists contain duplicates', 'REVOCATION_FEED_INVALID');
  const issued = Date.parse(statement.issued_at),
    expires = Date.parse(statement.expires_at);
  if (
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    expires <= issued ||
    issued > now + 5 * 60_000 ||
    (!allowExpired && now > expires) ||
    (!allowExpired && now - issued > maxAgeHours * 3_600_000)
  )
    throw feedError('Revocation feed is expired or outside its allowed age', 'REVOCATION_FEED_EXPIRED');
  let publicKey;
  try {
    publicKey = createPublicKey(trustedKeys?.[keyId]);
    if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('wrong type');
  } catch {
    throw feedError(`Revocation signing key '${keyId}' is not trusted`, 'REVOCATION_FEED_KEY_UNTRUSTED');
  }
  let signatureBytes;
  try {
    signatureBytes = Buffer.from(signature, 'base64');
  } catch {
    signatureBytes = Buffer.alloc(0);
  }
  if (signatureBytes.length !== 64 || !verify(null, Buffer.from(canonicalJson(statement)), publicKey, signatureBytes))
    throw feedError('Revocation feed signature verification failed', 'REVOCATION_FEED_SIGNATURE_INVALID');
  return { raw, statement };
}

async function readCache(installRoot) {
  const rootInfo = await fs.lstat(installRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
    throw feedError('Revocation cache root must be a regular directory', 'REVOCATION_CACHE_INVALID');
  const file = path.join(await fs.realpath(installRoot), CACHE_NAME);
  const before = await fs.lstat(file);
  if (before.isSymbolicLink() || !before.isFile() || before.size > MAX_BYTES)
    throw feedError('Revocation cache must be a bounded regular file', 'REVOCATION_CACHE_INVALID');
  const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
      throw feedError('Revocation cache changed while reading', 'REVOCATION_CACHE_INVALID');
    const chunks = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(32 * 1024, MAX_BYTES + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > MAX_BYTES) throw feedError('Revocation cache exceeds size limit', 'REVOCATION_CACHE_INVALID');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    if (total !== before.size) throw feedError('Revocation cache changed while reading', 'REVOCATION_CACHE_INVALID');
    const bytes = Buffer.concat(chunks, total);
    const cache = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (
      !record(cache) ||
      Object.keys(cache).sort().join(',') !== 'digest,feed,schema_version,sequence' ||
      cache.schema_version !== 1 ||
      !Number.isSafeInteger(cache.sequence) ||
      typeof cache.digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(cache.digest)
    )
      throw feedError('Revocation cache has an unsupported schema', 'REVOCATION_CACHE_INVALID');
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
    throw feedError('Revocation cache root must be a regular directory', 'REVOCATION_CACHE_INVALID');
  return fs.realpath(installRoot);
}

async function readResponse(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw feedError('Revocation feed exceeds size limit', 'REVOCATION_FEED_TOO_LARGE');
  if (!response.body) throw feedError('Revocation server returned an empty response', 'REVOCATION_FEED_INVALID');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) throw feedError('Revocation feed exceeds size limit', 'REVOCATION_FEED_TOO_LARGE');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, total);
}
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function feedError(message, code) {
  return Object.assign(new Error(message), { code });
}
