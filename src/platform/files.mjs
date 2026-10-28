import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Write through a same-directory temporary file. On Windows, replace an
 * existing destination through a recoverable backup when rename cannot replace
 * it directly (some filesystems and restricted environments return EPERM).
 */
export async function atomicWriteFile(
  destination,
  content,
  {
    mode = 0o600,
    beforeReplace,
    onPersistenceWarning = () =>
      process.emitWarning('An atomic write committed but its previous-file backup could not be removed', {
        code: 'ATOMIC_WRITE_BACKUP_CLEANUP',
      }),
  } = {},
) {
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
      await replaceExisting(temporary, destination, beforeReplace, onPersistenceWarning);
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

async function replaceExisting(temporary, destination, beforeReplace, onPersistenceWarning) {
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
  if (hasDestination) {
    try {
      await fs.rm(backup, { force: true });
    } catch (error) {
      // The replacement rename committed. Preserve the previous copy and
      // report a warning without turning the committed write into a failure.
      error.committed = true;
      try {
        onPersistenceWarning?.(error);
      } catch {
        // A warning handler must not turn a committed write into a failure.
      }
    }
  }
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

export async function hasAtomicWriteBackup(destination) {
  const directory = path.dirname(destination);
  const prefix = `${path.basename(destination)}.`;
  const names = await fs.readdir(directory).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return names.some(
    (name) =>
      name.startsWith(prefix) &&
      name.endsWith('.bak') &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(name.slice(prefix.length, -'.bak'.length)),
  );
}

/** Restore the one validated Windows replacement backup after a crash between
 * moving the old destination aside and installing the new file. The caller
 * must hold the store's cross-process mutation lock and validate the decoded
 * record with its own schema rules.
 */
export async function restoreAtomicWriteBackup(destination, { maxBytes, decode }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || typeof decode !== 'function')
    throw new TypeError('Backup recovery requires a positive size limit and decoder');
  const directory = path.dirname(destination);
  const directoryInfo = await fs.lstat(directory);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory())
    throw Object.assign(new Error('Atomic-write recovery directory is unsafe'), { code: 'ATOMIC_WRITE_RECOVERY_UNSAFE' });
  const destinationInfo = await fs.lstat(destination).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const prefix = `${path.basename(destination)}.`;
  const names = (await fs.readdir(directory)).filter((name) => {
    if (!name.startsWith(prefix) || !name.endsWith('.bak')) return false;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(name.slice(prefix.length, -'.bak'.length));
  });

  if (destinationInfo) {
    // Finish the narrowly defined crash state left after link-based recovery.
    if (destinationInfo.isFile() && !destinationInfo.isSymbolicLink() && destinationInfo.nlink === 2) {
      for (const name of names) {
        const candidate = path.join(directory, name);
        const info = await fs.lstat(candidate).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
        if (
          info?.isFile() &&
          !info.isSymbolicLink() &&
          info.nlink === 2 &&
          info.dev === destinationInfo.dev &&
          info.ino === destinationInfo.ino
        )
          await fs.rm(candidate);
      }
    }
    return null;
  }
  if (names.length === 0) return null;
  if (names.length !== 1)
    throw Object.assign(new Error('Multiple atomic-write recovery backups exist; preserve them for manual recovery'), {
      code: 'ATOMIC_WRITE_RECOVERY_REQUIRED',
    });

  const backup = path.join(directory, names[0]);
  const before = await fs.lstat(backup);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes)
    throw Object.assign(new Error('Atomic-write recovery backup is unsafe or oversized; preserve it for manual recovery'), {
      code: 'ATOMIC_WRITE_RECOVERY_REQUIRED',
    });
  const handle = await fs.open(backup, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  let record;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > maxBytes || opened.dev !== before.dev || opened.ino !== before.ino)
      throw Object.assign(new Error('Atomic-write recovery backup changed during inspection'), { code: 'ATOMIC_WRITE_RECOVERY_REQUIRED' });
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes)
      throw Object.assign(new Error('Atomic-write recovery backup is oversized'), { code: 'ATOMIC_WRITE_RECOVERY_REQUIRED' });
    record = decode(bytes.toString('utf8'));
    const after = await fs.lstat(backup);
    if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1)
      throw Object.assign(new Error('Atomic-write recovery backup changed during validation'), { code: 'ATOMIC_WRITE_RECOVERY_REQUIRED' });
  } catch (cause) {
    if (cause.code === 'ATOMIC_WRITE_RECOVERY_REQUIRED') throw cause;
    throw Object.assign(new Error('Atomic-write recovery backup is invalid; preserve it for manual recovery', { cause }), {
      code: 'ATOMIC_WRITE_RECOVERY_REQUIRED',
    });
  } finally {
    await handle.close();
  }

  try {
    await fs.link(backup, destination);
  } catch (cause) {
    throw Object.assign(new Error('Could not restore the atomic-write backup; preserve it for manual recovery', { cause }), {
      code: 'ATOMIC_WRITE_RECOVERY_REQUIRED',
    });
  }
  const [linked, remaining] = await Promise.all([fs.lstat(destination), fs.lstat(backup)]);
  if (
    !linked.isFile() ||
    linked.isSymbolicLink() ||
    linked.dev !== before.dev ||
    linked.ino !== before.ino ||
    remaining.dev !== before.dev ||
    remaining.ino !== before.ino ||
    linked.nlink !== 2 ||
    remaining.nlink !== 2
  )
    throw Object.assign(new Error('Atomic-write recovery could not verify the restored record; preserve the backup'), {
      code: 'ATOMIC_WRITE_RECOVERY_REQUIRED',
    });
  await fs.rm(backup);
  return record;
}
