import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SubagentManager } from '../src/subagents/manager.mjs';
import { SubagentTaskStore } from '../src/subagents/task-store.mjs';
import { acquireWorktreeLease, createWorktree, getGitFilterOverrides } from '../src/platform/worktrees.mjs';
import { runProcess } from '../src/platform/process.mjs';
import { createTempDirectory } from './helpers.mjs';

async function git(cwd, ...args) {
  const result = await runProcess('git', args, { cwd, timeoutMs: 15_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
}

async function gitStatusWithoutFilters(cwd) {
  const filterOverrides = await getGitFilterOverrides(cwd);
  const result = await runProcess(
    'git',
    [...filterOverrides.flatMap((value) => ['-c', value]), 'status', '--porcelain', '--untracked-files=all'],
    { cwd, timeoutMs: 15_000 },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout;
}

test('subagent task store persists bounded task records and enforces cross-process slots', async (t) => {
  const root = await createTempDirectory('xyst-subagent-store-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const parentSessionId = randomUUID();
  const store = new SubagentTaskStore(root, { maxConcurrent: 1, lockWaitMs: 100 });
  const record = await store.create({ parentSessionId, task: 'Review token=abcdefghijklmnop' });
  assert.equal(record.status, 'starting');
  assert.match(record.task, /token=\[REDACTED\]/);
  const release = await store.acquireSlot(record.id);
  const secondStore = new SubagentTaskStore(root, { maxConcurrent: 1, lockWaitMs: 100 });
  const second = await secondStore.create({ parentSessionId, task: 'Second task' });
  await assert.rejects(secondStore.acquireSlot(second.id), { code: 'SUBAGENT_CAPACITY' });
  await release();
  const releaseAgain = await secondStore.acquireSlot(second.id);
  await releaseAgain();
  const updated = await store.update(record.id, {
    status: 'complete',
    child_session_id: randomUUID(),
    result: 'Done',
    usage: { input_tokens: 12, output_tokens: 4, estimated_cost: null },
  });
  assert.equal(updated.status, 'complete');
  assert.equal((await store.read(record.id)).result, 'Done');
  assert.deepEqual((await store.read(record.id)).usage, { input_tokens: 12, output_tokens: 4, estimated_cost: null });
  assert.equal((await store.list({ limit: 1 }))[0].id, second.id);
  await assert.rejects(store.update(record.id, { parent_session_id: randomUUID() }), /unsupported field/);
  await assert.rejects(store.update(record.id, { status: 'invented' }), /Invalid subagent task status/);
  await assert.rejects(
    store.update(record.id, { usage: { input_tokens: -1, output_tokens: 0, estimated_cost: 0 } }),
    /usage must contain non-negative/,
  );
});

test('subagent task store records explicit retry lineage and prevents overlapping attempts', async (t) => {
  const root = await createTempDirectory('xyst-subagent-retry-store-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const parentSessionId = randomUUID();
  const store = new SubagentTaskStore(root);
  const first = await store.create({ parentSessionId, task: 'Retry this operation' });
  await store.update(first.id, { status: 'failed', error: 'Transient provider failure' });

  const second = await store.create({ parentSessionId, task: first.task, retryOf: first.id });
  assert.equal(second.retry_of, first.id);
  assert.equal(second.attempt, 2);
  await assert.rejects(store.create({ parentSessionId, task: first.task, retryOf: first.id }), {
    code: 'SUBAGENT_RETRY_ACTIVE',
  });
  await assert.rejects(store.create({ parentSessionId: randomUUID(), task: first.task, retryOf: first.id }), {
    code: 'SUBAGENT_PARENT_MISMATCH',
  });

  await store.update(second.id, { status: 'timed_out' });
  const third = await store.create({ parentSessionId, task: second.task, retryOf: second.id });
  assert.equal(third.retry_of, second.id);
  assert.equal(third.attempt, 3);
  assert.equal((await store.read(third.id)).retry_of, second.id);

  const completed = await store.create({ parentSessionId, task: 'Already completed' });
  await store.update(completed.id, { status: 'complete' });
  await assert.rejects(store.create({ parentSessionId, task: completed.task, retryOf: completed.id }), {
    code: 'SUBAGENT_NOT_RETRYABLE',
  });
});

test('subagent task store reclaims a mutation lock only when its recorded owner is absent', async (t) => {
  const root = await createTempDirectory('xyst-subagent-stale-mutation-lock-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, '.agent', 'subagents');
  await fs.mkdir(directory, { recursive: true });
  const pid = 2_147_483_647;
  const processIdentity =
    process.platform === 'win32'
      ? { platform: 'win32', pid, creation_time: '1', image_hash: 'a'.repeat(64) }
      : { platform: 'linux', pid, boot_id: '00000000-0000-4000-8000-000000000000', start_ticks: '1', command_hash: 'a'.repeat(64) };
  await fs.writeFile(
    path.join(directory, 'tasks.lock'),
    JSON.stringify({
      schema_version: 1,
      lock_token: randomUUID(),
      pid,
      hostname: os.hostname(),
      started_at: new Date().toISOString(),
      process_identity: processIdentity,
    }),
  );
  const task = await new SubagentTaskStore(root).create({ parentSessionId: randomUUID(), task: 'Recover after crash' });
  assert.equal(task.status, 'starting');
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'tasks.json'), 'utf8')).tasks.length, 1);
  await assert.rejects(fs.access(path.join(directory, 'tasks.lock')), { code: 'ENOENT' });
});

test('subagent recovery marks a force-killed task interrupted and releases its stale slot', async (t) => {
  const root = await createTempDirectory('xyst-subagent-crash-recovery-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, 'init', '-q');
  await git(root, 'config', 'user.name', 'Xyst AI Assistant Tests');
  await git(root, 'config', 'user.email', 'xyst-test@example.invalid');
  await fs.writeFile(path.join(root, 'README.md'), 'initial\n');
  await git(root, 'add', 'README.md');
  await git(root, 'commit', '-q', '-m', 'initial');
  const taskStoreUrl = pathToFileURL(path.resolve('src/subagents/task-store.mjs')).href;
  const marker = path.join(root, 'task-id.txt');
  const childCode = `
    import fs from 'node:fs/promises';
    import { SubagentTaskStore } from ${JSON.stringify(taskStoreUrl)};
    const store = new SubagentTaskStore(${JSON.stringify(root)}, { maxConcurrent: 1 });
    const task = await store.create({ parentSessionId: '00000000-0000-4000-8000-000000000001', task: 'die mid-run' });
    await store.update(task.id, { status: 'running', started_at: new Date().toISOString() });
    await store.acquireSlot(task.id);
    await fs.writeFile(${JSON.stringify(marker)}, task.id);
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  t.after(() => child.kill());
  let output = '';
  const waitForMarker = async () => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        return (await fs.readFile(marker, 'utf8')).trim();
      } catch {
        if (child.exitCode !== null) throw new Error(`Subagent crash fixture exited early: ${output}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    child.kill();
    throw new Error(`Timed out waiting for crash fixture: ${output}`);
  };
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    output += chunk;
  });
  const id = await waitForMarker();
  child.kill();
  await once(child, 'exit');

  const store = new SubagentTaskStore(root, { maxConcurrent: 1 });
  const inspected = await store.inspectInterrupted();
  assert.equal(inspected.find((item) => item.id === id)?.owner_state, 'interrupted');
  const recovered = await store.recoverInterrupted(id);
  assert.equal(recovered.task.status, 'failed');
  assert.match(recovered.task.error, /interrupted because its owning process/);
  const replacement = await store.create({ parentSessionId: randomUUID(), task: 'slot should be free' });
  const release = await store.acquireSlot(replacement.id);
  await release();

  const manager = new SubagentManager({
    workspaceRoot: root,
    taskStore: store,
    config: { subagents: { max_concurrent: 1 }, budgets: {} },
    executeTask: async () => ({
      status: 'complete',
      content: 'Recovered task completed on retry.',
      session: { id: randomUUID(), usage: { input_tokens: 12, output_tokens: 4, estimated_cost: null } },
    }),
  });
  const retried = await manager.retry({ taskId: id, parentSessionId: '00000000-0000-4000-8000-000000000001' });
  assert.equal(retried.status, 'complete');
  assert.equal(retried.attempt, 2);
  assert.equal(retried.retry_of, id);
  assert.equal((await store.read(id)).status, 'failed', 'the recovered attempt remains available for diagnosis');
});

test('subagent recovery lists unlinked worktrees with safe cleanup proposals and preserves their contents', async (t) => {
  const root = await createTempDirectory('xyst-subagent-orphan-worktrees-');
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
  await git(root, 'add', 'README.md');
  await git(root, 'commit', '-q', '-m', 'initial');

  const suffix = randomUUID().slice(0, 8);
  const active = await createWorktree(root, `xyst/orphan-active-${suffix}`);
  const dirty = await createWorktree(root, `xyst/orphan-dirty-${suffix}`);
  const clean = await createWorktree(root, `xyst/orphan-clean-${suffix}`);
  const releaseActive = await acquireWorktreeLease(root, active.id);
  const linked = await createWorktree(root, `xyst/task-linked-${suffix}`);
  await fs.writeFile(path.join(dirty.path, 'draft.txt'), 'keep this for review\n');
  const store = new SubagentTaskStore(root);
  const task = await store.create({ parentSessionId: randomUUID(), task: 'Keep linked worktree' });
  await store.update(task.id, { worktree_id: linked.id });

  let inspected;
  try {
    inspected = await store.inspectOrphanedWorktrees();
  } finally {
    await releaseActive();
  }
  assert.deepEqual(
    inspected.map((item) => item.id),
    [active.id, clean.id, dirty.id],
  );
  const activeReport = inspected.find((item) => item.id === active.id);
  const cleanReport = inspected.find((item) => item.id === clean.id);
  const dirtyReport = inspected.find((item) => item.id === dirty.id);
  assert.equal(activeReport.lock_state, 'active');
  assert.equal(activeReport.suggested_action, 'preserve_active');
  assert.equal(cleanReport.dirty, false);
  assert.equal(cleanReport.suggested_action, 'review_before_removal');
  assert.equal(dirtyReport.dirty, true);
  assert.deepEqual(dirtyReport.changed_paths, ['draft.txt']);
  assert.equal(dirtyReport.suggested_action, 'preserve_for_review');
  assert.equal(await fs.readFile(path.join(dirty.path, 'draft.txt'), 'utf8'), 'keep this for review\n');
  assert.equal((await store.read(task.id)).worktree_id, linked.id);
});

test('subagent manager runs with an isolated managed worktree and leaves changes for review', async (t) => {
  const root = await createTempDirectory('xyst-subagent-run-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  try {
    await git(root, 'init', '-q');
  } catch (error) {
    if (/not found|ENOENT/i.test(error.message)) return t.skip('Git executable is unavailable');
    throw error;
  }
  await git(root, 'config', 'user.name', 'Xyst AI Assistant Tests');
  await git(root, 'config', 'user.email', 'xyst-test@example.invalid');
  await fs.writeFile(path.join(root, 'README.md'), 'parent checkout\n');
  await git(root, 'add', 'README.md');
  await git(root, 'commit', '-q', '-m', 'initial');

  const parentSessionId = randomUUID();
  const childSessionId = randomUUID();
  const childSummary = 'Created child-change.txt. '.repeat(400);
  let childPrompt;
  let childDirectory;
  const events = [];
  const manager = new SubagentManager({
    workspaceRoot: root,
    config: {
      subagents: { max_concurrent: 1, timeout_ms: 10_000, max_turns: 2 },
      budgets: { max_input_tokens: 1000, max_output_tokens: 500, max_tool_output_bytes: 10_000 },
    },
    onEvent: (event) => events.push(event),
    executeTask: async ({ task, workspaceRoot, budget }) => {
      childPrompt = task;
      childDirectory = workspaceRoot;
      assert.ok(budget.max_input_tokens <= 400);
      assert.ok(budget.max_output_tokens <= 200);
      assert.equal((await fs.readFile(path.join(workspaceRoot, 'README.md'), 'utf8')).replaceAll('\r\n', '\n'), 'parent checkout\n');
      await fs.writeFile(path.join(workspaceRoot, 'child-change.txt'), 'isolated result\n');
      await Promise.all(
        Array.from({ length: 101 }, (_, index) =>
          fs.writeFile(path.join(workspaceRoot, `generated-${String(index).padStart(3, '0')}.txt`), 'generated\n'),
        ),
      );
      return {
        status: 'complete',
        content: childSummary,
        session: { id: childSessionId, usage: { input_tokens: 80, output_tokens: 20, estimated_cost: 0.001 } },
      };
    },
  });
  const result = await manager.delegate({
    task: 'Create child-change.txt',
    parentSessionId,
    remainingBudget: { inputTokens: 1000, outputTokens: 500 },
  });
  assert.equal(childPrompt, 'Create child-change.txt');
  assert.equal(result.schema_version, 1);
  assert.equal(result.status, 'complete');
  assert.equal(result.child_status, 'complete');
  assert.equal(result.child_session_id, childSessionId);
  assert.equal(result.summary.length, 8000);
  assert.equal(result.summary_truncated, true);
  assert.ok(result.changed_paths.length < 100, 'the configured output budget bounds serialized changed paths');
  assert.equal(result.changed_paths_truncated, true);
  assert.ok(result.changed_paths.includes('child-change.txt'));
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 10_000);
  assert.deepEqual(result.usage, { input_tokens: 80, output_tokens: 20, estimated_cost: 0.001 });
  assert.equal('owner' in result, false, 'the tool result must not expose host process identity');
  assert.equal('worktree_path' in result, false, 'the tool result must not expose an absolute host path');
  const persistedTask = await manager.store.read(result.task_id);
  assert.equal(persistedTask.parent_session_id, parentSessionId);
  assert.equal(persistedTask.result, childSummary);
  assert.equal(persistedTask.changed_paths.length, 102);
  assert.deepEqual(persistedTask.usage, result.usage);
  assert.ok(childDirectory.startsWith(path.join(root, '.agent', 'worktrees')));
  await assert.rejects(fs.access(path.join(root, 'child-change.txt')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(childDirectory, 'child-change.txt'), 'utf8'), 'isolated result\n');
  assert.ok(events.some((event) => event.type === 'subagent_task_started'));
  assert.ok(events.some((event) => event.type === 'subagent_task_finished' && event.status === 'complete'));
  const release = await manager.store.acquireSlot(result.task_id);
  await release();
});

test('subagent manager starts from an unborn project snapshot without changing the parent checkout', async (t) => {
  const root = await createTempDirectory('xyst-subagent-unborn-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  try {
    await git(root, 'init', '-q');
  } catch (error) {
    if (/not found|ENOENT/i.test(error.message)) return t.skip('Git executable is unavailable');
    throw error;
  }
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'main.mjs'), 'export const state = "parent";\n');
  await fs.writeFile(path.join(root, '.gitattributes'), 'src/main.mjs filter=xyst-subagent-clean\n');

  const filterMarker = path.join(root, 'filter-ran');
  const filterPath = path.join(root, 'clean-filter.mjs');
  await fs.writeFile(
    filterPath,
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(filterMarker)}, 'executed'); process.stdin.pipe(process.stdout);\n`,
  );
  await git(root, 'config', 'filter.xyst-subagent-clean.clean', `"${process.execPath}" "${filterPath}"`);
  await git(root, 'config', 'filter.xyst-subagent-clean.required', 'true');
  await fs.appendFile(path.join(root, '.git', 'info', 'exclude'), '\n.agent/\n');
  const parentStatus = await gitStatusWithoutFilters(root);

  const childSessionId = randomUUID();
  let childPath;
  const manager = new SubagentManager({
    workspaceRoot: root,
    config: { subagents: { max_concurrent: 1 }, budgets: { max_input_tokens: 1000, max_output_tokens: 500 } },
    executeTask: async ({ workspaceRoot }) => {
      childPath = workspaceRoot;
      await assert.rejects(
        fs.access(filterMarker),
        { code: 'ENOENT' },
        'Git filters must stay disabled through snapshot creation and checkout',
      );
      assert.equal((await fs.readFile(path.join(workspaceRoot, 'src', 'main.mjs'), 'utf8')).includes('parent'), true);
      await fs.writeFile(path.join(workspaceRoot, 'src', 'main.mjs'), 'export const state = "child";\n');
      await fs.writeFile(path.join(workspaceRoot, 'child-result.txt'), 'delegated\n');
      await assert.rejects(fs.access(filterMarker), { code: 'ENOENT' }, 'Git filters must stay disabled while the child edits files');
      return { status: 'complete', content: 'Implemented in the child worktree.', session: { id: childSessionId } };
    },
  });

  const result = await manager.delegate({ task: 'Update the project in isolation.', parentSessionId: randomUUID() });
  assert.equal(result.status, 'complete');
  assert.ok(result.changed_paths.includes('src/main.mjs'));
  assert.ok(result.changed_paths.includes('child-result.txt'));
  assert.equal(await fs.readFile(path.join(root, 'src', 'main.mjs'), 'utf8'), 'export const state = "parent";\n');
  assert.notEqual((await runProcess('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root })).exitCode, 0);
  assert.equal((await runProcess('git', ['diff', '--cached', '--quiet'], { cwd: root })).exitCode, 0);
  await assert.rejects(fs.access(filterMarker), { code: 'ENOENT' }, 'Git filters must stay disabled for snapshot and diff inspection');
  assert.equal(await gitStatusWithoutFilters(root), parentStatus);
  assert.ok(childPath.startsWith(path.join(root, '.agent', 'worktrees')));
});

test('subagent result preserves the invalid-review-output child status', async (t) => {
  const root = await createTempDirectory('xyst-subagent-invalid-review-');
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
  await git(root, 'add', 'README.md');
  await git(root, 'commit', '-q', '-m', 'initial');

  const manager = new SubagentManager({
    workspaceRoot: root,
    config: { tools: { autonomy: 'assisted' }, budgets: { max_input_tokens: 1000, max_output_tokens: 500, max_tool_output_bytes: 10_000 } },
    executeTask: async () => ({
      status: 'invalid_review_output',
      content: 'Reviewer did not return a valid findings array.',
      session: { id: randomUUID(), usage: { input_tokens: 12, output_tokens: 5, estimated_cost: null } },
    }),
  });
  const result = await manager.delegate({ task: 'Review the child worktree.', parentSessionId: randomUUID() });

  assert.equal(result.status, 'stopped');
  assert.equal(result.child_status, 'invalid_review_output');
  assert.equal((await manager.store.read(result.task_id)).status, 'stopped');
});

test('subagent rejects malformed child results and preserves the worktree for diagnosis', async (t) => {
  const root = await createTempDirectory('xyst-subagent-invalid-result-');
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
  await git(root, 'add', 'README.md');
  await git(root, 'commit', '-q', '-m', 'initial');

  const manager = new SubagentManager({
    workspaceRoot: root,
    config: { subagents: { max_concurrent: 1 }, budgets: {} },
    executeTask: async () => ({
      status: 'invented_status',
      content: 'Malformed child response',
      session: { id: randomUUID(), usage: { input_tokens: -1, output_tokens: 2, estimated_cost: null } },
    }),
  });

  await assert.rejects(
    manager.delegate({ task: 'Do work', parentSessionId: randomUUID() }),
    (error) => error.code === 'SUBAGENT_INVALID_RESULT' && /child-run contract/.test(error.message),
  );
  const [record] = await manager.list();
  assert.equal(record.status, 'failed');
  assert.match(record.error, /child-run contract/);
  assert.ok(record.worktree_id);
  assert.ok(await fs.stat(record.worktree_path));
});

test('explicitly retrying a failed subagent starts a new worktree and preserves its previous attempt', async (t) => {
  const root = await createTempDirectory('xyst-subagent-retry-');
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
  await git(root, 'add', 'README.md');
  await git(root, 'commit', '-q', '-m', 'initial');

  const parentSessionId = randomUUID();
  const taskStore = new SubagentTaskStore(root);
  const worktrees = [];
  let calls = 0;
  const manager = new SubagentManager({
    workspaceRoot: root,
    config: { subagents: { max_concurrent: 1, max_turns: 4 }, budgets: {} },
    taskStore,
    executeTask: async ({ task, worktree }) => {
      calls += 1;
      assert.equal(task, 'Fix the flaky generated file.');
      worktrees.push(worktree);
      return calls === 1
        ? {
            status: 'failed',
            content: 'Provider connection failed.',
            session: { id: randomUUID(), usage: { input_tokens: 20, output_tokens: 3, estimated_cost: null } },
          }
        : {
            status: 'complete',
            content: 'Retry completed successfully.',
            session: { id: randomUUID(), usage: { input_tokens: 30, output_tokens: 5, estimated_cost: null } },
          };
    },
  });

  const first = await manager.delegate({ task: 'Fix the flaky generated file.', parentSessionId });
  assert.equal(first.status, 'failed');
  assert.equal(first.attempt, 1);
  assert.equal(first.retry_of, null);

  const second = await manager.retry({ taskId: first.task_id, parentSessionId });
  assert.equal(second.status, 'complete');
  assert.equal(second.attempt, 2);
  assert.equal(second.retry_of, first.task_id);
  assert.equal(second.summary, 'Retry completed successfully.');
  assert.deepEqual(second.usage, { input_tokens: 30, output_tokens: 5, estimated_cost: null });
  assert.notEqual(worktrees[0].id, worktrees[1].id);
  assert.ok(await fs.stat(worktrees[0].path), 'the first attempt worktree remains available');
  assert.ok(await fs.stat(worktrees[1].path), 'the retry uses a separate worktree');
  assert.equal((await taskStore.read(first.task_id)).status, 'failed');
  assert.equal((await taskStore.read(second.task_id)).retry_of, first.task_id);

  await assert.rejects(manager.retry({ taskId: second.task_id, parentSessionId }), { code: 'SUBAGENT_NOT_RETRYABLE' });
  await assert.rejects(manager.retry({ taskId: first.task_id, parentSessionId: randomUUID() }), {
    code: 'SUBAGENT_PARENT_MISMATCH',
  });
  assert.equal(calls, 2);
});

test('unrestricted subagents ignore configured usage, output, turn, and runtime caps', async (t) => {
  const root = await createTempDirectory('xyst-subagent-unrestricted-');
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
  await git(root, 'add', 'README.md');
  await git(root, 'commit', '-q', '-m', 'initial');
  let childBudget;
  const manager = new SubagentManager({
    workspaceRoot: root,
    config: {
      tools: { autonomy: 'unrestricted' },
      subagents: { max_concurrent: 1, timeout_ms: 1_000, max_turns: 1 },
      budgets: { max_input_tokens: 1000, max_output_tokens: 500, max_tool_output_bytes: 1000, max_session_cost: 0 },
    },
    executeTask: async ({ budget, signal }) => {
      childBudget = budget;
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      assert.equal(signal.aborted, false, 'unrestricted autonomy must not apply the configured child timeout');
      return { status: 'complete', content: 'Done', session: { id: randomUUID(), usage: null } };
    },
  });
  await manager.delegate({
    task: 'Do work',
    parentSessionId: randomUUID(),
    remainingBudget: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: Number.MAX_SAFE_INTEGER },
  });
  assert.equal(childBudget.max_turns, Number.MAX_SAFE_INTEGER);
  assert.equal(childBudget.max_input_tokens, Number.MAX_SAFE_INTEGER);
  assert.equal(childBudget.max_output_tokens, Number.MAX_SAFE_INTEGER);
  assert.equal(childBudget.max_tool_output_bytes, Number.MAX_SAFE_INTEGER);
  assert.equal(Object.hasOwn(childBudget, 'max_session_cost'), false);
});

test('assisted subagents receive a bounded share of the parent remaining session cost', async (t) => {
  const root = await createTempDirectory('xyst-subagent-cost-budget-');
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
  await git(root, 'add', 'README.md');
  await git(root, 'commit', '-q', '-m', 'initial');

  let childBudget;
  const manager = new SubagentManager({
    workspaceRoot: root,
    config: {
      tools: { autonomy: 'assisted' },
      subagents: { max_concurrent: 1, timeout_ms: 10_000 },
      budgets: { max_session_cost: 10 },
    },
    executeTask: async ({ budget }) => {
      childBudget = budget;
      return {
        status: 'complete',
        content: 'Done',
        session: { id: randomUUID(), usage: { input_tokens: 1, output_tokens: 1, estimated_cost: 0.25 } },
      };
    },
  });
  await manager.delegate({
    task: 'Do bounded work',
    parentSessionId: randomUUID(),
    remainingBudget: { inputTokens: 1000, outputTokens: 500, costUsd: 2.5 },
  });
  assert.equal(childBudget.max_session_cost, 1);
});

test('unrestricted subagents still stop when the parent explicitly cancels them', async (t) => {
  const root = await createTempDirectory('xyst-subagent-unrestricted-cancel-');
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
  await git(root, 'add', 'README.md');
  await git(root, 'commit', '-q', '-m', 'initial');
  const controller = new AbortController();
  const manager = new SubagentManager({
    workspaceRoot: root,
    config: { tools: { autonomy: 'unrestricted' }, subagents: { max_concurrent: 1, timeout_ms: 1_000 } },
    onEvent: (event) => {
      if (event.type === 'subagent_task_started') setTimeout(() => controller.abort(new Error('parent cancelled')), 10);
    },
    executeTask: async ({ signal }) =>
      new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
  });
  const result = await manager.delegate({ task: 'Wait until cancelled', parentSessionId: randomUUID(), signal: controller.signal });
  assert.equal(result.child_status, 'cancelled');
  assert.equal(result.status, 'cancelled');
});

test('active subagent tasks can be cancelled by task ID without cancelling the parent run', async (t) => {
  const root = await createTempDirectory('xyst-subagent-task-cancel-');
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
  await git(root, 'add', 'README.md');
  await git(root, 'commit', '-q', '-m', 'initial');

  const parentController = new AbortController();
  const store = new SubagentTaskStore(root);
  let signalFromChild;
  let finishChild;
  let resolveStarted;
  const childStarted = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  const manager = new SubagentManager({
    workspaceRoot: root,
    taskStore: store,
    config: { subagents: { max_concurrent: 1 }, budgets: {} },
    executeTask: async ({ signal }) => {
      signalFromChild = signal;
      return new Promise((resolve) => {
        finishChild = resolve;
        resolveStarted();
      });
    },
  });

  const delegatedTask = manager.delegate({
    task: 'Wait for cancellation',
    parentSessionId: randomUUID(),
    signal: parentController.signal,
  });
  await childStarted;
  const [activeTask] = await store.list({ limit: 1 });
  assert.equal(activeTask.status, 'running');

  const requested = await store.requestCancellation(activeTask.id);
  assert.equal(requested.accepted, true);
  assert.equal(requested.already_requested, false);
  assert.equal(signalFromChild.aborted, true);
  assert.equal(parentController.signal.aborted, false);

  const repeated = await store.requestCancellation(activeTask.id);
  assert.equal(repeated.accepted, true);
  assert.equal(repeated.already_requested, true);
  finishChild({ status: 'cancelled', content: 'Cancelled by task ID', session: { id: randomUUID(), usage: null } });

  const result = await delegatedTask;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.child_status, 'cancelled');
  assert.equal(parentController.signal.aborted, false);
  const saved = await store.read(activeTask.id);
  assert.equal(saved.status, 'cancelled');
  assert.ok(saved.worktree_id, 'the cancelled child worktree remains available for review');
  assert.deepEqual(await store.requestCancellation(activeTask.id), { accepted: false, reason: 'not_running', task: saved });
});

test('subagent manager records a failed task and retains its isolated worktree for diagnosis', async (t) => {
  const root = await createTempDirectory('xyst-subagent-fail-');
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
  await git(root, 'add', 'README.md');
  await git(root, 'commit', '-q', '-m', 'initial');
  const manager = new SubagentManager({
    workspaceRoot: root,
    config: { subagents: { max_concurrent: 1 }, budgets: {} },
    executeTask: async () => {
      throw new Error('child provider failed');
    },
  });
  await assert.rejects(manager.delegate({ task: 'Do work', parentSessionId: randomUUID() }), /child provider failed/);
  const [record] = await manager.list();
  assert.equal(record.status, 'failed');
  assert.ok(record.worktree_id);
  assert.ok(await fs.stat(record.worktree_path));
});

test('subagent timeout aborts the child signal, records timed_out, and releases its slot', async (t) => {
  const root = await createTempDirectory('xyst-subagent-timeout-');
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
  await git(root, 'add', 'README.md');
  await git(root, 'commit', '-q', '-m', 'initial');
  let childAborted = false;
  const manager = new SubagentManager({
    workspaceRoot: root,
    config: { subagents: { max_concurrent: 1, timeout_ms: 1_000 }, budgets: {} },
    executeTask: async ({ signal }) => {
      if (signal.aborted) {
        childAborted = true;
        return { status: 'cancelled', content: 'timed out', session: { id: randomUUID(), usage: null } };
      }
      return new Promise((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            childAborted = true;
            resolve({ status: 'cancelled', content: 'timed out', session: { id: randomUUID(), usage: null } });
          },
          { once: true },
        ),
      );
    },
  });
  const result = await manager.delegate({ task: 'Wait until cancelled', parentSessionId: randomUUID() });
  assert.equal(result.status, 'timed_out');
  assert.equal(childAborted, true);
  const release = await manager.store.acquireSlot(result.task_id);
  await release();
});
