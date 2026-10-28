import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createTempDirectory } from './helpers.mjs';
import { withFeedCacheLock } from '../src/extensions/feed-cache-lock.mjs';

test('feed cache lock release preserves a replacement lock record', async (t) => {
  const root = await createTempDirectory('xyst-feed-cache-lock-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'updates.lock');
  const backupPath = path.join(root, 'held-lock.backup');

  const result = await withFeedCacheLock(root, 'updates', async () => {
    const original = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    assert.match(original.lock_token, /^[0-9a-f-]{36}$/i);
    await fs.rename(lockPath, backupPath);
    await fs.writeFile(lockPath, JSON.stringify({ lock_token: 'replacement-lock' }));
    return 'updated';
  });

  assert.equal(result, 'updated');
  assert.equal(JSON.parse(await fs.readFile(lockPath, 'utf8')).lock_token, 'replacement-lock');
});
