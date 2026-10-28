import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, restoreAtomicWriteBackup } from '../src/platform/files.mjs';
import { createTempDirectory } from './helpers.mjs';

test('atomic writes flush file data before rename and directory metadata after on Linux', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Directory handles cannot be flushed portably through Node on Windows');
    return;
  }
  const root = await createTempDirectory('xyst-atomic-write-sync-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'settings.json');
  const events = [];
  const probe = await fs.open(destination, 'w');
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  const sync = fileHandlePrototype.sync;
  const rename = fs.rename;
  let syncCount = 0;
  fileHandlePrototype.sync = async function () {
    syncCount += 1;
    events.push(syncCount === 1 ? 'file-sync' : 'directory-sync');
    return sync.call(this);
  };
  fs.rename = async (...args) => {
    events.push('rename');
    return rename(...args);
  };
  try {
    await atomicWriteFile(destination, 'durable');
    assert.deepEqual(events, ['file-sync', 'rename', 'directory-sync']);
    assert.equal(await fs.readFile(destination, 'utf8'), 'durable');
  } finally {
    fileHandlePrototype.sync = sync;
    fs.rename = rename;
  }
});

test('atomic writes keep the old destination when flushing the temporary file fails', async (t) => {
  const root = await createTempDirectory('xyst-atomic-write-sync-failure-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'settings.json');
  await fs.writeFile(destination, 'original');
  const probe = await fs.open(destination, 'r');
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  const sync = fileHandlePrototype.sync;
  fileHandlePrototype.sync = async () => {
    throw Object.assign(new Error('simulated flush failure'), { code: 'EIO' });
  };
  try {
    await assert.rejects(atomicWriteFile(destination, 'replacement'), { code: 'EIO' });
    assert.equal(await fs.readFile(destination, 'utf8'), 'original');
    assert.deepEqual(await fs.readdir(root), ['settings.json']);
  } finally {
    fileHandlePrototype.sync = sync;
  }
});

test('atomic writes preserve a temporary-path collision when exclusive creation fails', async (t) => {
  const root = await createTempDirectory('xyst-atomic-write-temp-collision-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'settings.json');
  const open = fs.open;
  let collisionPath;
  fs.open = async (filePath, flags, ...args) => {
    if (filePath.startsWith(`${destination}.`) && filePath.endsWith('.tmp') && flags === 'wx') {
      collisionPath = filePath;
      const collision = await open(filePath, 'wx');
      await collision.writeFile('pre-existing file');
      await collision.close();
      throw Object.assign(new Error('simulated exclusive-create collision'), { code: 'EEXIST' });
    }
    return open(filePath, flags, ...args);
  };
  try {
    await assert.rejects(atomicWriteFile(destination, 'replacement'), { code: 'EEXIST' });
    assert.equal(await fs.readFile(collisionPath, 'utf8'), 'pre-existing file');
  } finally {
    fs.open = open;
  }
});

test('atomic writes report committed content when Linux directory flushing fails', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Directory handles cannot be flushed portably through Node on Windows');
    return;
  }
  const root = await createTempDirectory('xyst-atomic-write-directory-sync-failure-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'settings.json');
  await fs.writeFile(destination, 'original');
  const probe = await fs.open(destination, 'r');
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  const sync = fileHandlePrototype.sync;
  let syncCount = 0;
  fileHandlePrototype.sync = async function () {
    syncCount += 1;
    if (syncCount === 2) throw Object.assign(new Error('simulated directory flush failure'), { code: 'EIO' });
    return sync.call(this);
  };
  try {
    await assert.rejects(atomicWriteFile(destination, 'replacement'), (error) => {
      assert.equal(error.code, 'EIO');
      assert.equal(error.committed, true);
      return true;
    });
    assert.equal(await fs.readFile(destination, 'utf8'), 'replacement');
  } finally {
    fileHandlePrototype.sync = sync;
  }
});

test('atomic backup recovery reads no more than its configured limit plus one byte', async (t) => {
  const root = await createTempDirectory('xyst-atomic-write-bounded-recovery-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'settings.json');
  const backup = `${destination}.550e8400-e29b-41d4-a716-446655440000.bak`;
  await fs.writeFile(backup, 'x');

  const probe = await fs.open(backup, 'r');
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  const read = fileHandlePrototype.read;
  const requests = [];
  fileHandlePrototype.read = async (buffer, offset, length, _position) => {
    requests.push(length);
    buffer.fill(0, offset, offset + length);
    return { bytesRead: length, buffer };
  };
  try {
    await assert.rejects(restoreAtomicWriteBackup(destination, { maxBytes: 4, decode: (content) => content }), {
      code: 'ATOMIC_WRITE_RECOVERY_REQUIRED',
    });
    assert.deepEqual(requests, [5]);
    assert.equal(await fs.readFile(backup, 'utf8'), 'x');
    assert.equal(
      await fs.lstat(destination).then(
        () => true,
        (error) => error.code === 'ENOENT',
      ),
      true,
    );
  } finally {
    fileHandlePrototype.read = read;
  }
});

test('Windows replacement fallback commits the temporary file and removes the backup', async (t) => {
  const root = await createTempDirectory('xyst-atomic-write-fallback-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'settings.json');
  await fs.writeFile(destination, 'original');

  await withWindowsPlatform(async () => {
    const rename = fs.rename;
    let destinationCommitAttempts = 0;
    fs.rename = async (source, target) => {
      if (source.endsWith('.tmp') && target === destination) {
        destinationCommitAttempts += 1;
        if (destinationCommitAttempts === 1) throw Object.assign(new Error('simulated replace failure'), { code: 'EPERM' });
      }
      return rename(source, target);
    };
    try {
      await atomicWriteFile(destination, 'replacement');
      assert.equal(destinationCommitAttempts, 2);
      assert.equal(await fs.readFile(destination, 'utf8'), 'replacement');
      assert.deepEqual(await fs.readdir(root), ['settings.json']);
    } finally {
      fs.rename = rename;
    }
  });
});

test('Windows replacement fallback warns and succeeds if backup cleanup fails after commit', async (t) => {
  const root = await createTempDirectory('xyst-atomic-write-backup-cleanup-failure-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'settings.json');
  await fs.writeFile(destination, 'original');

  await withWindowsPlatform(async () => {
    const rename = fs.rename;
    const remove = fs.rm;
    let backupPath;
    let destinationCommitAttempts = 0;
    const warnings = [];
    fs.rename = async (source, target) => {
      if (source === destination && target.endsWith('.bak')) backupPath = target;
      if (source.endsWith('.tmp') && target === destination) {
        destinationCommitAttempts += 1;
        if (destinationCommitAttempts === 1) throw Object.assign(new Error('simulated replace failure'), { code: 'EPERM' });
      }
      return rename(source, target);
    };
    fs.rm = async (target, options) => {
      if (target === backupPath) throw Object.assign(new Error('simulated backup cleanup failure'), { code: 'EACCES' });
      return remove(target, options);
    };
    try {
      await atomicWriteFile(destination, 'replacement', { onPersistenceWarning: (error) => warnings.push(error) });
      assert.equal(await fs.readFile(destination, 'utf8'), 'replacement');
      assert.equal(await fs.readFile(backupPath, 'utf8'), 'original');
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0].code, 'EACCES');
      assert.equal(warnings[0].committed, true);
    } finally {
      fs.rename = rename;
      fs.rm = remove;
    }
  });
});

test('Windows replacement fallback restores the original file when commit fails', async (t) => {
  const root = await createTempDirectory('xyst-atomic-write-rollback-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'settings.json');
  await fs.writeFile(destination, 'original');

  await withWindowsPlatform(async () => {
    const rename = fs.rename;
    let destinationCommitAttempts = 0;
    fs.rename = async (source, target) => {
      if (source.endsWith('.tmp') && target === destination) {
        destinationCommitAttempts += 1;
        throw Object.assign(new Error('simulated replace failure'), { code: destinationCommitAttempts === 1 ? 'EPERM' : 'EIO' });
      }
      return rename(source, target);
    };
    try {
      await assert.rejects(atomicWriteFile(destination, 'replacement'), (error) => error.code === 'EIO');
      assert.equal(destinationCommitAttempts, 2);
      assert.equal(await fs.readFile(destination, 'utf8'), 'original');
      assert.deepEqual(await fs.readdir(root), ['settings.json']);
    } finally {
      fs.rename = rename;
    }
  });
});

test('Windows replacement fallback retains the original backup if rollback also fails', async (t) => {
  const root = await createTempDirectory('xyst-atomic-write-retained-backup-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'settings.json');
  await fs.writeFile(destination, 'original');

  await withWindowsPlatform(async () => {
    const rename = fs.rename;
    let destinationCommitAttempts = 0;
    let backupPath;
    fs.rename = async (source, target) => {
      if (source === destination && target.endsWith('.bak')) backupPath = target;
      if (source.endsWith('.tmp') && target === destination) {
        destinationCommitAttempts += 1;
        throw Object.assign(new Error('simulated replace failure'), { code: destinationCommitAttempts === 1 ? 'EPERM' : 'EIO' });
      }
      if (source.endsWith('.bak') && target === destination)
        throw Object.assign(new Error('simulated restore failure'), { code: 'EACCES' });
      return rename(source, target);
    };
    try {
      await assert.rejects(atomicWriteFile(destination, 'replacement'), (error) => {
        assert.equal(error.code, 'EIO');
        assert.equal(error.restoreError?.code, 'EACCES');
        return true;
      });
      assert.ok(backupPath);
      assert.equal(await fs.readFile(backupPath, 'utf8'), 'original');
      assert.equal(
        await fs.readFile(destination).then(
          () => false,
          (error) => error.code === 'ENOENT',
        ),
        true,
      );
      assert.equal(
        (await fs.readdir(root)).some((entry) => entry.endsWith('.tmp')),
        false,
      );
    } finally {
      fs.rename = rename;
    }
  });
});

async function withWindowsPlatform(callback) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
  try {
    await callback();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
}
