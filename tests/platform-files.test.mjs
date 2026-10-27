import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from '../src/platform/files.mjs';
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
