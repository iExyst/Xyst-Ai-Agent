import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Write through a same-directory temporary file. On Windows, replace an
 * existing destination through a recoverable backup when rename cannot replace
 * it directly (some filesystems and restricted environments return EPERM).
 */
export async function atomicWriteFile(destination, content, { mode = 0o600, beforeReplace } = {}) {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    const existing = await fs.lstat(destination).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing && !existing.isFile()) throw new Error('Atomic write destination must be a regular file');
    const destinationMode = existing ? existing.mode & 0o777 : null;
    const handle = await fs.open(temporary, 'wx', destinationMode ?? mode);
    try {
      // Replacing a source file must not silently remove executable or
      // read permissions. New files still use the caller's private default.
      if (destinationMode !== null) await handle.chmod(destinationMode);
      // Keep untrusted or sensitive payloads out of a parent directory that
      // changed after the caller validated its destination path.
      await beforeReplace?.();
      await handle.writeFile(content, 'utf8');
      // Flush the completed payload before it can replace the destination.
      // This keeps a successful rename from publishing data that only lived
      // in the process or OS cache when the machine loses power.
      await handle.sync();
    } finally {
      await handle.close();
    }
    await beforeReplace?.();
    try {
      await fs.rename(temporary, destination);
    } catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      await replaceExisting(temporary, destination, beforeReplace);
    }
    try {
      await syncParentDirectory(destination);
    } catch (error) {
      // The rename already made the new file visible. Preserve that fact so
      // callers do not mistake a durability error for an uncommitted write.
      error.committed = true;
      throw error;
    }
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function replaceExisting(temporary, destination, beforeReplace) {
  const backup = `${destination}.${randomUUID()}.bak`;
  let hasDestination = false;
  try {
    await beforeReplace?.();
    await fs.rename(destination, backup);
    hasDestination = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    await fs.rename(temporary, destination);
  } catch (error) {
    if (hasDestination)
      await fs.rename(backup, destination).catch((restoreError) => {
        error.restoreError = restoreError;
      });
    throw error;
  }
  if (hasDestination) await fs.rm(backup, { force: true });
}

async function syncParentDirectory(destination) {
  if (process.platform === 'win32') return;
  const directory = await fs.open(path.dirname(destination), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function atomicWriteJson(destination, value, options) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await atomicWriteFile(destination, `${JSON.stringify(value, null, 2)}\n`, options);
}
