import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { inspectWorkspace, readWorkspaceFile } from '../src/platform/workspace-inspector.mjs';
import { runProcess } from '../src/platform/process.mjs';
import { createTempDirectory } from './helpers.mjs';

test('workspace inspector returns a sorted bounded tree and Git status without following symlinks', async (t) => {
  const root = await createTempDirectory('xyst-inspector-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = async (...args) => {
    const result = await runProcess('git', args, { cwd: root, timeoutMs: 15_000 });
    if (result.exitCode !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  };
  try {
    await git('-C', root, 'init', '-q');
  } catch (error) {
    if (/not found|ENOENT/i.test(error.message)) return t.skip('Git executable is unavailable');
    throw error;
  }
  await git('-C', root, 'config', 'user.name', 'Xyst AI Assistant Tests');
  await git('-C', root, 'config', 'user.email', 'xyst-test@example.invalid');
  await fs.mkdir(path.join(root, 'folder'));
  await fs.writeFile(path.join(root, 'folder', 'tracked.txt'), 'tracked\n');
  await git('-C', root, 'add', 'folder/tracked.txt');
  await git('-C', root, 'commit', '-q', '-m', 'initial');
  await fs.writeFile(path.join(root, 'changed.txt'), 'new\n');
  let hasSymlink = true;
  try {
    await fs.symlink(path.dirname(root), path.join(root, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) hasSymlink = false;
    else throw error;
  }

  const view = await inspectWorkspace(root);
  assert.equal(view.path, '');
  assert.equal(view.git.available, true);
  assert.ok(view.git.branch);
  assert.ok(view.git.entries.some((entry) => entry.path === 'changed.txt' && entry.code === '??'));
  if (hasSymlink) assert.ok(!view.entries.some((entry) => entry.name === 'outside-link'));
  assert.ok(view.entries.some((entry) => entry.name === 'folder' && entry.type === 'directory'));
  assert.equal((await inspectWorkspace(root, { relativePath: 'folder' })).entries[0].name, 'tracked.txt');
  assert.deepEqual(await readWorkspaceFile(root, 'folder/tracked.txt'), { path: 'folder/tracked.txt', text: 'tracked\n', bytes: 8 });
  await assert.rejects(inspectWorkspace(root, { relativePath: '../outside' }), /traversal/);
  if (hasSymlink) await assert.rejects(inspectWorkspace(root, { relativePath: 'outside-link' }), /symbolic link/);
  await fs.writeFile(path.join(root, 'binary.dat'), Buffer.from([0, 1, 2]));
  await fs.writeFile(path.join(root, 'large.txt'), Buffer.alloc(256 * 1024 + 1, 65));
  await assert.rejects(readWorkspaceFile(root, 'binary.dat'), /Binary files/);
  await assert.rejects(readWorkspaceFile(root, 'large.txt'), /preview limit/);
  if (hasSymlink) {
    try {
      await fs.symlink(path.join(root, 'folder', 'tracked.txt'), path.join(root, 'linked.txt'), 'file');
      await assert.rejects(readWorkspaceFile(root, 'linked.txt'), /Symbolic links/);
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    }
  }
});

test('workspace inspector gives useful state for a non-Git directory and rejects file paths', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xyst-inspector-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'file.txt'), 'content');
  const view = await inspectWorkspace(root);
  assert.equal(view.git.available, false);
  await assert.rejects(inspectWorkspace(root, { relativePath: 'file.txt' }), /directory/);
});
