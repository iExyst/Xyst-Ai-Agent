import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../src/platform/process.mjs';
import {
  acquireWorktreeLease,
  createWorktree,
  inspectWorktreeLocks,
  listWorktrees,
  recoverWorktreeLock,
  removeWorktree,
} from '../src/platform/worktrees.mjs';
import { createTempDirectory } from './helpers.mjs';

async function git(cwd, ...args) {
  const result = await runProcess('git', args, { cwd, timeoutMs: 15_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || `git ${args.join(' ')} exited ${result.exitCode}`);
  return result;
}

test('worktree lifecycle is confined to .agent/worktrees and refuses to remove dirty work', async (t) => {
  const root = await createTempDirectory('xyst-worktree-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  try {
    await git(root, 'init', '-q');
  } catch (error) {
    if (/not found|ENOENT/i.test(error.message)) return t.skip('Git executable is unavailable');
    throw error;
  }
  await git(root, 'config', 'user.name', 'Xyst AI Assistant Tests');
  await git(root, 'config', 'user.email', 'xyst-test@example.invalid');
  await fs.writeFile(path.join(root, 'README.md'), 'initial\n');
  await fs.writeFile(path.join(root, '.gitattributes'), 'README.md filter=xyst-smudge\n');
  const markerPath = path.join(root, 'smudge-ran');
  const filterScript = path.join(root, 'smudge.mjs');
  await fs.writeFile(
    filterScript,
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(markerPath)}, 'executed'); process.stdin.pipe(process.stdout);\n`,
  );
  await git(root, 'config', 'filter.xyst-smudge.smudge', `node ${JSON.stringify(filterScript)}`);
  await git(root, 'config', 'filter.xyst-smudge.required', 'false');
  await git(root, 'add', 'README.md');
  await git(root, 'add', '.gitattributes');
  await git(root, 'commit', '-q', '-m', 'initial');

  const created = await createWorktree(root, 'agent/feature');
  assert.match(created.id, /^[0-9a-f-]{36}$/i);
  assert.equal(created.branch, 'agent/feature');
  assert.equal((await fs.readFile(path.join(created.path, 'README.md'), 'utf8')).replaceAll('\r\n', '\n'), 'initial\n');
  await assert.rejects(fs.access(markerPath), { code: 'ENOENT' });
  assert.deepEqual(
    (await listWorktrees(root)).map(({ id, branch }) => ({ id, branch })),
    [{ id: created.id, branch: 'agent/feature' }],
  );

  const release = await acquireWorktreeLease(root, created.id);
  await assert.rejects(acquireWorktreeLease(root, created.id), /is in use/);
  await assert.rejects(removeWorktree(root, created.id), /is in use/);
  await release();

  await fs.writeFile(path.join(created.path, 'untracked.txt'), 'keep me');
  await assert.rejects(removeWorktree(root, created.id), /has tracked/);
  assert.equal(await fs.readFile(path.join(created.path, 'untracked.txt'), 'utf8'), 'keep me');
  await fs.rm(path.join(created.path, 'untracked.txt'));
  await fs.appendFile(path.join(root, '.git', 'info', 'exclude'), '\nignored.txt\n');
  await fs.writeFile(path.join(created.path, 'ignored.txt'), 'also keep');
  await assert.rejects(removeWorktree(root, created.id), /ignored files/);
  assert.equal(await fs.readFile(path.join(created.path, 'ignored.txt'), 'utf8'), 'also keep');
  await fs.rm(path.join(created.path, 'ignored.txt'));
  const removed = await removeWorktree(root, created.id);
  assert.equal(removed.removed, true);
  assert.deepEqual(await listWorktrees(root), []);
});

test('worktree operations reject invalid branch names and IDs before invoking Git', async () => {
  await assert.rejects(createWorktree(process.cwd(), '../outside'), /valid Git branch/);
  await assert.rejects(removeWorktree(process.cwd(), '../outside'), /Invalid worktree ID/);
});

test('unborn repositories give child worktrees a private snapshot without staging parent files or copying agent state', async (t) => {
  const root = await createTempDirectory('xyst-worktree-unborn-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  try {
    await git(root, 'init', '-q');
  } catch (error) {
    if (/not found|ENOENT/i.test(error.message)) return t.skip('Git executable is unavailable');
    throw error;
  }

  await fs.mkdir(path.join(root, '.agent', 'sessions'), { recursive: true });
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'main.mjs'), 'export const answer = 42;\n');
  await fs.mkdir(path.join(root, 'src', 'with spaces'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'with spaces', 'π.mjs'), 'export const greeting = "γειά";\n');
  await fs.writeFile(path.join(root, '.agent', 'sessions', 'private.json'), '{"private":true}\n');
  await fs.writeFile(path.join(root, '.gitattributes'), 'src/main.mjs filter=xyst-snapshot-clean\n');

  const markerPath = path.join(root, 'clean-filter-ran');
  const filterPath = path.join(root, 'clean-filter.mjs');
  await fs.writeFile(
    filterPath,
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(markerPath)}, 'executed'); process.stdin.pipe(process.stdout);\n`,
  );
  await git(root, 'config', 'filter.xyst-snapshot-clean.clean', `"${process.execPath}" "${filterPath}"`);
  await git(root, 'config', 'filter.xyst-snapshot-clean.required', 'true');
  await fs.appendFile(path.join(root, '.git', 'info', 'exclude'), '\n.agent/worktrees/\n');

  const parentStatusBefore = (await git(root, 'status', '--porcelain', '--untracked-files=all')).stdout;
  const parentHeadBefore = await runProcess('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, timeoutMs: 15_000 });
  assert.notEqual(parentHeadBefore.exitCode, 0, 'fixture starts with an unborn HEAD');

  const created = await createWorktree(root, 'agent/unborn');
  assert.equal(
    (await fs.readFile(path.join(created.path, 'src', 'main.mjs'), 'utf8')).replaceAll('\r\n', '\n'),
    'export const answer = 42;\n',
  );
  await assert.rejects(fs.access(path.join(created.path, '.agent', 'sessions', 'private.json')), { code: 'ENOENT' });
  await assert.rejects(fs.access(markerPath), { code: 'ENOENT' }, 'Git clean filters must not execute during snapshot creation');
  const childHead = await runProcess('git', ['rev-parse', '--verify', 'HEAD'], { cwd: created.path, timeoutMs: 15_000 });
  assert.equal(childHead.exitCode, 0, 'the child worktree must start from the private snapshot commit');
  const childSource = await runProcess('git', ['show', 'HEAD:src/main.mjs'], { cwd: created.path, timeoutMs: 15_000 });
  assert.equal(childSource.exitCode, 0);
  assert.equal(childSource.stdout.replaceAll('\r\n', '\n'), 'export const answer = 42;\n');
  const unicodeSource = await runProcess('git', ['show', 'HEAD:src/with spaces/π.mjs'], { cwd: created.path, timeoutMs: 15_000 });
  assert.equal(unicodeSource.exitCode, 0);
  assert.equal(unicodeSource.stdout.replaceAll('\r\n', '\n'), 'export const greeting = "γειά";\n');
  assert.equal((await git(root, 'status', '--porcelain', '--untracked-files=all')).stdout, parentStatusBefore);
  assert.notEqual((await runProcess('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, timeoutMs: 15_000 })).exitCode, 0);
  assert.equal((await git(root, 'diff', '--cached', '--quiet')).exitCode, 0, 'snapshot must not stage files in the parent index');
  assert.equal((await removeWorktree(root, created.id)).removed, true);
  await assert.rejects(fs.access(markerPath), { code: 'ENOENT' }, 'Git filters must remain disabled while removing the child worktree');
});

test('worktree lock recovery removes only a same-host lock whose captured process is absent', async (t) => {
  const root = await createTempDirectory('xyst-worktree-lock-recovery-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = '00000000-0000-4000-8000-000000000123';
  const lockDirectory = path.join(root, '.agent', 'worktree-locks');
  const lockPath = path.join(lockDirectory, `${id}.lock`);
  await fs.mkdir(lockDirectory, { recursive: true });
  const record = {
    schema_version: 1,
    lock_token: '00000000-0000-4000-8000-000000000124',
    pid: 456,
    hostname: os.hostname(),
    started_at: new Date().toISOString(),
    process_identity:
      process.platform === 'win32'
        ? { platform: 'win32', pid: 456, creation_time: '1', image_hash: 'a'.repeat(64) }
        : { platform: 'linux', pid: 456, boot_id: '00000000-0000-4000-8000-000000000000', start_ticks: '1', command_hash: 'a'.repeat(64) },
  };
  await fs.writeFile(lockPath, JSON.stringify(record));
  const inspect = (state) => inspectWorktreeLocks(root, { verifyIdentity: async () => state });
  assert.equal((await inspect('match'))[0].state, 'active');
  await assert.rejects(recoverWorktreeLock(root, id, { verifyIdentity: async () => 'match' }), { code: 'WORKTREE_LOCK_ACTIVE' });
  assert.equal((await fs.stat(lockPath)).isFile(), true);
  assert.deepEqual(await recoverWorktreeLock(root, id, { verifyIdentity: async () => 'absent' }), {
    id,
    removed: true,
    owner_state: 'absent',
  });
  await assert.rejects(fs.access(lockPath), { code: 'ENOENT' });
});

test('worktree lease release preserves a replacement lock file', async (t) => {
  const root = await createTempDirectory('xyst-worktree-lock-replacement-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = '00000000-0000-4000-8000-000000000125';
  const lockDirectory = path.join(root, '.agent', 'worktree-locks');
  const lockPath = path.join(lockDirectory, `${id}.lock`);
  const backupPath = path.join(lockDirectory, 'held-lock.backup');
  const release = await acquireWorktreeLease(root, id);
  await fs.rename(lockPath, backupPath);
  await fs.writeFile(lockPath, JSON.stringify({ lock_token: '00000000-0000-4000-8000-000000000126' }));
  await release();
  assert.equal(JSON.parse(await fs.readFile(lockPath, 'utf8')).lock_token, '00000000-0000-4000-8000-000000000126');
});

test('worktree lease acquisition failure preserves a replacement lock file', async (t) => {
  const root = await createTempDirectory('xyst-worktree-lock-acquire-replacement-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = '00000000-0000-4000-8000-000000000127';
  const lockDirectory = path.join(root, '.agent', 'worktree-locks');
  const lockPath = path.join(lockDirectory, `${id}.lock`);
  const backupPath = path.join(lockDirectory, 'failed-lock.backup');
  const originalOpen = fs.open;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] !== lockPath || args[1] !== 'wx') return handle;
    let swapped = false;
    return {
      writeFile: (...writeArgs) => handle.writeFile(...writeArgs),
      sync: async () => {
        await handle.sync();
        throw Object.assign(new Error('injected sync failure'), { code: 'EIO' });
      },
      stat: () => handle.stat(),
      close: async () => {
        await handle.close();
        if (!swapped) {
          swapped = true;
          await fs.rename(lockPath, backupPath);
          await fs.writeFile(lockPath, JSON.stringify({ lock_token: 'replacement-lock' }));
        }
      },
    };
  };
  try {
    await assert.rejects(acquireWorktreeLease(root, id), { code: 'EIO' });
  } finally {
    fs.open = originalOpen;
  }
  assert.equal(JSON.parse(await fs.readFile(lockPath, 'utf8')).lock_token, 'replacement-lock');
});
