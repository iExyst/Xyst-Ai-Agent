import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/** Serialize the short monotonic-cache commit across processes. A stale lock is
 * deliberately not reclaimed automatically: a crashed writer must be checked
 * before an operator removes the adjacent lock file.
 */
export async function withFeedCacheLock(directory, cacheName, operation, { waitMs = 5_000 } = {}) {
  if (!path.isAbsolute(directory) || typeof cacheName !== 'string' || !cacheName || typeof operation !== 'function')
    throw new TypeError('A cache directory, file name, and operation are required');
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 60_000) throw new TypeError('waitMs must be between 0 and 60000');

  const lockPath = path.join(directory, `${cacheName}.lock`);
  const deadline = Date.now() + waitMs;
  let handle;
  let identity;
  let lockToken;
  while (!handle) {
    let created = false;
    try {
      handle = await fs.open(lockPath, 'wx', 0o600);
      created = true;
      lockToken = randomUUID();
      await handle.writeFile(JSON.stringify({ lock_token: lockToken, pid: process.pid, started_at: new Date().toISOString() }));
      await handle.sync();
      identity = await handle.stat();
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => {});
        await removeOwnedLock(lockPath, identity, lockToken);
        handle = null;
        identity = null;
        lockToken = null;
      }
      if (created) throw error;
      const contention = error.code === 'EEXIST' || (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code));
      if (!contention) throw error;
      if (Date.now() >= deadline)
        throw Object.assign(new Error(`Feed cache is locked; verify no writer is active before removing ${lockPath}`), {
          code: 'FEED_CACHE_LOCKED',
        });
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
    }
  }

  let result;
  let operationError;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }
  const cleanupError = await releaseLock(handle, lockPath, identity, lockToken);
  if (operationError) {
    if (cleanupError) operationError.cleanupError = cleanupError;
    throw operationError;
  }
  if (cleanupError) throw cleanupError;
  return result;
}

async function releaseLock(handle, lockPath, identity, lockToken) {
  let failure;
  await handle.close().catch((error) => (failure = error));
  const cleanupError = await removeOwnedLock(lockPath, identity, lockToken);
  return failure || cleanupError;
}

async function removeOwnedLock(lockPath, identity, lockToken) {
  let current;
  try {
    current = await fs.lstat(lockPath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    return error;
  }
  if (!current.isFile() || current.isSymbolicLink() || (identity && (current.dev !== identity.dev || current.ino !== identity.ino))) return;
  try {
    const record = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    if (record.lock_token === lockToken) await fs.rm(lockPath, { force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') return error;
  }
}
