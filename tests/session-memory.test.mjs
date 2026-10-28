import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAX_SESSION_EXPORT_BYTES, SESSION_ARCHIVE_SCHEMA_VERSION, SessionStore, sessionFailureFromError } from '../src/session/store.mjs';
import {
  GlobalMemoryStore,
  MAX_MEMORY_EXPORT_BYTES,
  MAX_MEMORY_FILE_BYTES,
  MAX_MEMORY_ITEM_CHARS,
  MEMORY_SCHEMA_VERSION,
  MemoryStore,
} from '../src/memory/store.mjs';
import { MEMORY_PROVENANCE_ACTORS, PERSISTENCE_SCHEMA_REGISTRY } from '../src/persistence/schema-registry.mjs';
import { defaultUserDataDirectory } from '../src/memory/paths.mjs';
import { GoalStore } from '../src/goals/store.mjs';
import { createSessionGrant, findSessionGrant } from '../src/tools/grants.mjs';
import { atomicWriteJson } from '../src/platform/files.mjs';
import { createSymlinkOrSkip, createTempDirectory } from './helpers.mjs';
import { runProcess, safeProcessEnvironment } from '../src/platform/process.mjs';
import { ToolAuditStore } from '../src/tools/audit.mjs';

test('session MCP server selection is persisted and validated', async (t) => {
  const root = await createTempDirectory('xyst-session-mcp-selection-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  const session = store.create();
  session.mcp_servers = ['docs', 'calendar'];
  await store.save(session);
  assert.deepEqual((await store.load(session.id)).mcp_servers, ['docs', 'calendar']);

  const invalid = store.create();
  invalid.mcp_servers = ['docs', 'docs'];
  await assert.rejects(store.save(invalid), /mcp_servers/);
});
import { UsageBudgetStore } from '../src/session/usage-budget.mjs';

test('sessions save, load, list, fork, rename, archive and delete', async (t) => {
  const root = await createTempDirectory('xyst-session-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  const session = store.create({ model: 'local' });
  session.mode = 'plan';
  session.worktree_path = path.join(root, '.agent', 'worktrees', 'private-checkout');
  session.messages.push({ role: 'user', content: 'hello' });
  await store.save(session);
  assert.equal((await store.load(session.id)).messages.length, 1);
  const [listed] = await store.list();
  assert.equal(listed.has_worktree, true);
  assert.equal(listed.model, 'local');
  assert.equal(listed.mode, 'plan');
  assert.equal(listed.status, 'active');
  assert.equal(listed.last_message_role, 'user');
  assert.equal(listed.last_message_has_tool_calls, false);
  assert.equal('worktree_path' in listed, false);
  const fork = await store.fork(session.id);
  assert.notEqual(fork.id, session.id);
  await store.rename(fork.id, 'review');
  assert.equal((await store.load(fork.id)).title, 'review');
  await store.rename(fork.id, 'review API_KEY=supersecret');
  assert.equal((await store.load(fork.id)).title, 'review API_KEY=[REDACTED]');
  await store.archive(fork.id);
  assert.equal((await store.load(fork.id)).status, 'archived');
  await assert.rejects(store.load('../escape'), /Invalid session ID/);
  await store.delete(fork.id);
  assert.equal((await store.list()).length, 1);
});

test('session load keeps ordinary missing records distinguishable from interrupted-write recovery', async (t) => {
  const root = await createTempDirectory('xyst-session-missing-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  const id = '00000000-0000-4000-8000-000000000001';
  await assert.rejects(store.load(id), { code: 'ENOENT' });
});

test('session load restores one validated Windows atomic-replacement backup', async (t) => {
  const root = await createTempDirectory('xyst-session-backup-recovery-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  const session = store.create({ messages: [{ role: 'user', content: 'Keep this session.' }] });
  await store.save(session);

  const filename = path.join(root, '.agent', 'sessions', `${session.id}.json`);
  const backup = `${filename}.00000000-0000-4000-8000-000000000001.bak`;
  await fs.rename(filename, backup);

  const recovered = await store.load(session.id);
  assert.equal(recovered.id, session.id);
  assert.equal(recovered.messages[0].content, 'Keep this session.');
  assert.match(await fs.readFile(filename, 'utf8'), /Keep this session/);
  await assert.rejects(fs.lstat(backup), { code: 'ENOENT' });
  assert.equal((await store.load(session.id)).revision, session.revision);
});

test('session load preserves ambiguous atomic-replacement backups for manual recovery', async (t) => {
  const root = await createTempDirectory('xyst-session-backup-ambiguous-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  const session = store.create();
  await store.save(session);

  const filename = path.join(root, '.agent', 'sessions', `${session.id}.json`);
  const first = `${filename}.00000000-0000-4000-8000-000000000001.bak`;
  const second = `${filename}.00000000-0000-4000-8000-000000000002.bak`;
  await fs.rename(filename, first);
  await fs.copyFile(first, second);

  await assert.rejects(store.load(session.id), { code: 'SESSION_BACKUP_RECOVERY_REQUIRED' });
  assert.equal(await fs.readFile(first, 'utf8'), await fs.readFile(second, 'utf8'));
  await assert.rejects(fs.lstat(filename), { code: 'ENOENT' });
});

test('session store advances its revision when rename committed but directory sync failed', async (t) => {
  if (process.platform === 'win32') {
    t.skip('The session store directory-sync durability boundary is exercised on Linux');
    return;
  }
  const root = await createTempDirectory('xyst-session-committed-sync-warning-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const warnings = [];
  const store = new SessionStore(root, { onPersistenceWarning: (warning) => warnings.push(warning) });
  const session = store.create({ messages: [{ role: 'user', content: 'First revision.' }] });
  await store.save(session);
  assert.equal(session.revision, 1);

  session.title = 'Committed despite directory sync failure';
  const probe = await fs.open(path.join(root, 'probe'), 'w');
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
    await store.save(session);
  } finally {
    fileHandlePrototype.sync = sync;
  }

  assert.equal(syncCount, 2);
  assert.equal(session.revision, 2);
  assert.equal((await store.load(session.id)).title, 'Committed despite directory sync failure');
  assert.deepEqual(warnings, [{ session_id: session.id, code: 'EIO' }]);

  session.title = 'Retry with the committed revision';
  await store.save(session);
  assert.equal(session.revision, 3);
  assert.equal((await store.load(session.id)).title, 'Retry with the committed revision');
});

test('session write failure preserves the committed record, releases its lock, and permits retry', async (t) => {
  const root = await createTempDirectory('xyst-session-write-failure-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  const session = store.create({ messages: [{ role: 'user', content: 'Committed before failure.' }] });
  await store.save(session);
  const recordPath = path.join(root, '.agent', 'sessions', `${session.id}.json`);
  const originalRecord = await fs.readFile(recordPath, 'utf8');
  session.title = 'Retry after write failure';

  const probe = await fs.open(path.join(root, 'probe'), 'w');
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  const writeFile = fileHandlePrototype.writeFile;
  let writeCount = 0;
  fileHandlePrototype.writeFile = async function (...args) {
    writeCount += 1;
    if (writeCount === 2) throw Object.assign(new Error('simulated temporary record write failure'), { code: 'EIO' });
    return writeFile.apply(this, args);
  };
  try {
    await assert.rejects(store.save(session), { code: 'EIO' });
  } finally {
    fileHandlePrototype.writeFile = writeFile;
  }

  assert.equal(session.revision, 1);
  assert.equal(await fs.readFile(recordPath, 'utf8'), originalRecord);
  assert.deepEqual(await fs.readdir(path.join(root, '.agent', 'session-locks')), []);
  assert.deepEqual(await fs.readdir(path.join(root, '.agent', 'sessions')), [`${session.id}.json`]);
  assert.equal((await store.load(session.id)).title, undefined);

  await store.save(session);
  assert.equal(session.revision, 2);
  assert.equal((await store.load(session.id)).title, 'Retry after write failure');
});

test('session summaries expose pending assistant tool calls for crash recovery UI', async (t) => {
  const root = await createTempDirectory('xyst-session-pending-tool-summary-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  const session = store.create({
    messages: [
      { role: 'user', content: 'Create a file.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call-write-1', type: 'function', function: { name: 'write_file', arguments: '{"path":"result.txt"}' } }],
      },
    ],
  });
  await store.save(session);
  const [summary] = await store.list();
  assert.equal(summary.last_message_role, 'assistant');
  assert.equal(summary.last_message_has_tool_calls, true);
});

test('session persistence redacts credentials at rest without mutating active model context', async (t) => {
  const root = await createTempDirectory('xyst-session-at-rest-redaction-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  const session = store.create({
    messages: [
      { role: 'user', content: 'Use API_KEY=prompt-session-canary for this task.' },
      { role: 'tool', content: JSON.stringify({ type: 'untrusted_observation', content: { result: 'TOKEN=tool-session-canary' } }) },
    ],
  });
  session.title = 'API_KEY=title-session-canary';
  session.plan = 'Use password=plan-session-canary only for this current operation.';

  await store.save(session);

  assert.match(JSON.stringify(session), /prompt-session-canary|tool-session-canary|title-session-canary|plan-session-canary/);
  assert.equal(session.revision, 1);
  const filename = path.join(root, '.agent', 'sessions', `${session.id}.json`);
  const rawRecord = await fs.readFile(filename, 'utf8');
  assert.doesNotMatch(rawRecord, /prompt-session-canary|tool-session-canary|title-session-canary|plan-session-canary/);
  assert.match(rawRecord, /API_KEY=\[REDACTED\]/);
  assert.match(rawRecord, /TOKEN=\[REDACTED\]/);
  assert.match(rawRecord, /password=\[REDACTED\]/);

  const loaded = await store.load(session.id);
  assert.match(JSON.stringify(loaded), /API_KEY=\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(loaded), /prompt-session-canary|tool-session-canary|title-session-canary|plan-session-canary/);

  session.messages.push({ role: 'assistant', content: 'Follow up with Authorization: Bearer repeat-session-canary.' });
  await store.save(session);
  assert.equal(session.revision, 2);
  const updatedRecord = await fs.readFile(filename, 'utf8');
  assert.doesNotMatch(updatedRecord, /repeat-session-canary/);
  assert.match(updatedRecord, /Authorization: \[REDACTED\]/);
});

test('session forks preserve project goal identity and progress without owning the goal records', async (t) => {
  const root = await createTempDirectory('xyst-session-fork-goals-');
  const portableRoot = await createTempDirectory('xyst-session-fork-goals-portable-');
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(portableRoot, { recursive: true, force: true })]));
  const goals = new GoalStore(root);
  const goal = await goals.add('Keep project state available across forks');
  const { progress } = await goals.addProgress(goal.id, 'Preserve this progress record and reference.', 'docs/BUILD_ROADMAP.md');
  const sessions = new SessionStore(root);
  const source = sessions.create({ messages: [{ role: 'user', content: 'Continue the project goal.' }] });
  source.persistent_goal_ids = [goal.id];
  await sessions.save(source);

  const fork = await sessions.fork(source.id);
  assert.notEqual(fork.id, source.id);
  assert.deepEqual(fork.persistent_goal_ids, [goal.id]);
  assert.deepEqual((await new GoalStore(root).list())[0].progress[0], progress[0]);
  assert.equal(fork.permission_grants.length, 0);

  const imported = await new SessionStore(portableRoot).importSession(await sessions.exportSession(fork.id));
  assert.deepEqual(imported.persistent_goal_ids, [goal.id]);
  assert.deepEqual((await new GoalStore(portableRoot).list())[0].progress[0], progress[0]);
  await sessions.delete(source.id);
  await sessions.delete(fork.id);
  assert.deepEqual((await new GoalStore(root).list())[0].progress[0], progress[0]);
  assert.deepEqual(await new SessionStore(root).list(), []);
});

test('session goal references validate existing records and serialize with project goal deletion', async (t) => {
  const root = await createTempDirectory('xyst-session-goal-assignment-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const goals = new GoalStore(root);
  const sessions = new SessionStore(root);
  const first = await goals.add('First session goal');
  const second = await goals.add('Second session goal');
  const session = sessions.create();
  await sessions.save(session);

  const updated = await sessions.setPersistentGoals(session.id, [first.id, second.id]);
  assert.deepEqual(updated.persistent_goal_ids, [first.id, second.id]);
  await assert.rejects(sessions.setPersistentGoals(session.id, [first.id, first.id]), { code: 'INVALID_SESSION_GOALS' });
  await assert.rejects(sessions.setPersistentGoals(session.id, ['8c2d8c80-840a-41ce-b121-78a5b8694af3']), { code: 'GOAL_NOT_FOUND' });
  assert.deepEqual((await sessions.load(session.id)).persistent_goal_ids, [first.id, second.id]);

  const [attachResult, deleteResult] = await Promise.allSettled([
    sessions.setPersistentGoals(session.id, [first.id]),
    goals.delete(first.id),
  ]);
  assert.equal(deleteResult.status, 'fulfilled');
  if (attachResult.status === 'rejected') assert.equal(attachResult.reason.code, 'GOAL_NOT_FOUND');
  assert.equal((await sessions.load(session.id)).persistent_goal_ids.includes(first.id), false);
  assert.deepEqual(
    (await goals.list()).map((goal) => goal.id),
    [second.id],
  );

  const [forkResult, secondDeleteResult] = await Promise.allSettled([sessions.fork(session.id), goals.delete(second.id)]);
  assert.equal(secondDeleteResult.status, 'fulfilled');
  if (forkResult.status === 'rejected') assert.equal(forkResult.reason.code, 'SESSION_GOAL_REFERENCE_MISSING');
  for (const { id } of await sessions.list())
    assert.equal((await sessions.load(id)).persistent_goal_ids?.includes(second.id) || false, false);
  assert.deepEqual(await goals.list(), []);

  const cleared = await sessions.setPersistentGoals(session.id, []);
  assert.deepEqual(cleared.persistent_goal_ids, []);
});

test('deleting a project goal detaches session references so sessions remain portable and forkable', async (t) => {
  const root = await createTempDirectory('xyst-session-fork-missing-goal-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const goals = new GoalStore(root);
  const goal = await goals.add('A goal that is later removed');
  const sessions = new SessionStore(root);
  const session = sessions.create();
  session.persistent_goal_ids = [goal.id];
  await sessions.save(session);
  await goals.delete(goal.id);

  assert.deepEqual((await sessions.load(session.id)).persistent_goal_ids, []);
  const exported = await sessions.exportSession(session.id);
  assert.equal(exported.goals, undefined);
  const fork = await sessions.fork(session.id);
  assert.deepEqual(fork.persistent_goal_ids, []);
  assert.deepEqual(new Set((await sessions.list()).map(({ id }) => id)), new Set([session.id, fork.id]));
});

test('global memory uses a separate user data root and keeps the project memory schema and protections', async (t) => {
  const userDataParent = await createTempDirectory('xyst-global-memory-');
  const userData = path.join(userDataParent, 'missing', 'data-root');
  const workspace = await createTempDirectory('xyst-project-memory-');
  t.after(() => Promise.all([fs.rm(userDataParent, { recursive: true, force: true }), fs.rm(workspace, { recursive: true, force: true })]));
  const global = new GlobalMemoryStore(userData);
  const project = new MemoryStore(workspace);
  const item = await global.append('user_preferences', 'Prefer concise summaries.', { source: 'user' });
  assert.equal((await global.read()).sections.user_preferences[0].id, item.id);
  assert.equal((await project.read()).sections.user_preferences.length, 0);
  assert.equal(await fs.stat(path.join(userData, '.agent', 'global-memory.json')).then((info) => info.isFile()), true);
  await assert.rejects(fs.access(path.join(workspace, '.agent', 'memory.json')), { code: 'ENOENT' });
});

test('global memory data-directory migration merges exact records and keeps the source as a backup', async (t) => {
  const sourceRoot = await createTempDirectory('xyst-global-memory-migration-source-');
  const destinationRoot = await createTempDirectory('xyst-global-memory-migration-destination-');
  t.after(() =>
    Promise.all([fs.rm(sourceRoot, { recursive: true, force: true }), fs.rm(destinationRoot, { recursive: true, force: true })]),
  );
  const source = new GlobalMemoryStore(sourceRoot);
  const destination = new GlobalMemoryStore(destinationRoot);
  const sourceItem = await source.append('user_preferences', 'Keep global preferences during a directory change.', { source: 'user' });
  const destinationItem = await destination.append('conventions', 'Keep destination-only records too.', { source: 'user' });

  assert.deepEqual(await source.migrateTo(destinationRoot), { copied: 1, already_present: 0 });
  const migrated = await destination.read();
  assert.deepEqual(migrated.sections.user_preferences, [sourceItem]);
  assert.deepEqual(migrated.sections.conventions, [destinationItem]);
  assert.deepEqual(await new GlobalMemoryStore(sourceRoot).read().then((memory) => memory.sections.user_preferences), [sourceItem]);
  assert.deepEqual(await source.migrateTo(destinationRoot), { copied: 0, already_present: 1 });
});

test('global memory data-directory migration refuses conflicting record IDs without overwriting either copy', async (t) => {
  const sourceRoot = await createTempDirectory('xyst-global-memory-conflict-source-');
  const destinationRoot = await createTempDirectory('xyst-global-memory-conflict-destination-');
  t.after(() =>
    Promise.all([fs.rm(sourceRoot, { recursive: true, force: true }), fs.rm(destinationRoot, { recursive: true, force: true })]),
  );
  const source = new GlobalMemoryStore(sourceRoot);
  const sourceItem = await source.append('user_preferences', 'Source copy.', { source: 'user' });
  const destinationPath = path.join(destinationRoot, '.agent', 'global-memory.json');
  await atomicWriteJson(destinationPath, {
    schema_version: MEMORY_SCHEMA_VERSION,
    updated_at: new Date().toISOString(),
    sections: {
      conventions: [],
      architecture_decisions: [],
      user_preferences: [{ ...sourceItem, text: 'Destination copy.' }],
      lessons_learned: [],
      open_questions: [],
    },
  });

  await assert.rejects(source.migrateTo(destinationRoot), { code: 'GLOBAL_MEMORY_MIGRATION_CONFLICT' });
  assert.equal((await source.read()).sections.user_preferences[0].text, 'Source copy.');
  assert.equal((await new GlobalMemoryStore(destinationRoot).read()).sections.user_preferences[0].text, 'Destination copy.');
});

test('user data directory follows Windows and Linux conventions', () => {
  assert.equal(
    defaultUserDataDirectory({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'win32'),
    'C:\\Users\\me\\AppData\\Local\\Xyst AI Assistant',
  );
  assert.equal(defaultUserDataDirectory({ XDG_DATA_HOME: '/home/me/.local/share' }, 'linux'), '/home/me/.local/share/xyst');
});

test('session diagnostics identify damaged records without exposing or changing their contents', async (t) => {
  const root = await createTempDirectory('xyst-session-diagnostics-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  const valid = store.create();
  await store.save(valid);
  const damagedId = '00000000-0000-4000-8000-000000000001';
  const damagedPath = path.join(root, '.agent', 'sessions', `${damagedId}.json`);
  const damagedBytes = '{"private":"API_KEY=keep-this-secret",';
  await fs.writeFile(damagedPath, damagedBytes);
  const invalidNamePath = path.join(root, '.agent', 'sessions', 'not-a-session.json');
  await fs.writeFile(invalidNamePath, '{}');

  const report = await store.inspectRecords();
  assert.equal(report.readable, 1);
  assert.equal(report.unreadable.length, 1);
  assert.equal(report.unreadable[0].path, path.join('.agent', 'sessions', `${damagedId}.json`));
  assert.equal(report.unreadable[0].size_bytes, Buffer.byteLength(damagedBytes));
  assert.match(report.unreadable[0].reason, /JSON|position|property/i);
  assert.deepEqual(report.unexpected, [
    { path: path.join('.agent', 'sessions', 'not-a-session.json'), reason: 'session entry is not a UUID-named regular file' },
  ]);
  assert.equal(JSON.stringify(report).includes('keep-this-secret'), false);
  assert.equal(await fs.readFile(damagedPath, 'utf8'), damagedBytes);
  assert.equal((await store.list()).length, 1);
});

test('session deletion removes transcript archives but preserves project data, audit history, usage totals, and worktrees', async (t) => {
  const root = await createTempDirectory('xyst-session-delete-semantics-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  const worktree = path.join(root, '.agent', 'worktrees', 'kept-checkout');
  const archivePath = path.join(
    '.agent',
    'compactions',
    '00000000-0000-4000-8000-000000000000',
    '12345678-1234-4234-8234-123456789abc.json',
  );
  const session = store.create({ model: 'local' });
  session.worktree_path = worktree;
  session.compaction_archive = archivePath.replace('00000000-0000-4000-8000-000000000000', session.id);
  session.compaction_archives = [session.compaction_archive];
  await fs.mkdir(worktree, { recursive: true });
  await fs.writeFile(path.join(worktree, 'user-change.txt'), 'preserve this checkout');
  await atomicWriteJson(path.join(root, session.compaction_archive), {
    schema_version: 1,
    session_id: session.id,
    archived_at: new Date().toISOString(),
    messages: [{ role: 'assistant', content: 'older transcript' }],
  });
  await store.save(session);

  const memory = new MemoryStore(root);
  await memory.append('conventions', 'Project-level memory survives deleting one conversation.', { source: 'user' });
  const audit = new ToolAuditStore(root);
  await audit.record({
    sessionId: session.id,
    toolCallId: '12345678-1234-4234-8234-123456789abc',
    tool: 'read_file',
    args: { path: 'README.md' },
    decision: 'allow',
    outcome: 'succeeded',
  });
  const usage = new UsageBudgetStore(root);
  const reservation = await usage.reserve({ inputTokens: 10, outputTokens: 5, limits: { max_daily_input_tokens: 100 } });
  await usage.settle(reservation, { inputTokens: 10, outputTokens: 5, costUsd: 0.01 });

  await store.delete(session.id);

  await assert.rejects(store.load(session.id), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(root, session.compaction_archive)));
  await assert.rejects(fs.access(path.join(root, '.agent', 'compactions', session.id)));
  assert.equal(await fs.readFile(path.join(worktree, 'user-change.txt'), 'utf8'), 'preserve this checkout');
  assert.equal((await memory.read()).sections.conventions.length, 1);
  assert.match(await fs.readFile(audit.file, 'utf8'), new RegExp(session.id));
  const usageSnapshot = await usage.snapshot();
  assert.equal(usageSnapshot.daily.input_tokens, 10);
  assert.equal(usageSnapshot.daily.output_tokens, 5);
  assert.equal(usageSnapshot.daily.cost_usd, 0.01);
});

test('session store rejects unsupported schema versions before validating or rewriting their records', async (t) => {
  const root = await createTempDirectory('xyst-session-version-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  const session = store.create();
  const sessionPath = path.join(root, '.agent', 'sessions', `${session.id}.json`);
  await fs.mkdir(path.dirname(sessionPath), { recursive: true });
  const futureRecord = { schema_version: 99, future_field: 'preserve-me' };
  await fs.writeFile(sessionPath, JSON.stringify(futureRecord));

  await assert.rejects(store.load(session.id), {
    code: 'UNSUPPORTED_SESSION_SCHEMA_VERSION',
    message: /newer session schema version 99/,
  });
  assert.deepEqual(JSON.parse(await fs.readFile(sessionPath, 'utf8')), futureRecord);

  session.schema_version = 1;
  await assert.rejects(store.save(session), {
    code: 'UNSUPPORTED_SESSION_SCHEMA_VERSION',
    message: /newer session schema version 99/,
  });
  assert.deepEqual(JSON.parse(await fs.readFile(sessionPath, 'utf8')), futureRecord);

  session.schema_version = 99;
  await assert.rejects(store.save(session), {
    code: 'UNSUPPORTED_SESSION_SCHEMA_VERSION',
    message: /newer session schema version 99/,
  });
  await assert.rejects(store.importSession({ format: 'xyst-session', format_version: 1, session: futureRecord, archives: [] }), {
    code: 'INVALID_SESSION_EXPORT',
    message: /newer session schema version 99/,
  });
});

test('session persistence rejects statuses outside the shared run-status contract', async (t) => {
  const root = await createTempDirectory('xyst-session-invalid-status-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  const session = store.create();
  await store.save(session);

  const recordPath = path.join(store.directory, `${session.id}.json`);
  const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
  record.status = 'unexpected_status';
  await fs.writeFile(recordPath, `${JSON.stringify(record)}\n`);
  await assert.rejects(store.load(session.id), /Session status is invalid/);

  session.status = 'unexpected_status';
  await assert.rejects(store.save(session), /Session status is invalid/);
});

test('session failure details are bounded, redacted, validated, and retained', async (t) => {
  const root = await createTempDirectory('xyst-session-failure-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  const session = store.create();
  session.status = 'failed';
  session.failure = sessionFailureFromError(
    Object.assign(new Error('Provider rejected api_key = "session-test-secret"'), { code: 'PROVIDER_ERROR' }),
    '2026-10-24T12:00:00.000Z',
  );
  await store.save(session);
  assert.deepEqual((await store.load(session.id)).failure, {
    code: 'PROVIDER_ERROR',
    message: 'Provider rejected api_key = [REDACTED]',
    failed_at: '2026-10-24T12:00:00.000Z',
  });

  session.failure = { code: 'x'.repeat(129), message: 'invalid', failed_at: 'not-a-date' };
  await assert.rejects(store.save(session), /Session failure is invalid/);
});

test('session reads reject oversized records before parsing and preserve them on save', async (t) => {
  const root = await createTempDirectory('xyst-session-size-limit-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  const session = store.create();
  await store.save(session);
  const recordPath = path.join(root, '.agent', 'sessions', `${session.id}.json`);
  await fs.truncate(recordPath, MAX_SESSION_EXPORT_BYTES + 1);
  await assert.rejects(store.load(session.id), { code: 'SESSION_RECORD_TOO_LARGE' });
  await assert.rejects(store.save(session), { code: 'SESSION_RECORD_TOO_LARGE' });
  assert.equal((await fs.stat(recordPath)).size, MAX_SESSION_EXPORT_BYTES + 1);
});

test('session reads stop at the configured limit plus one byte when a record grows during reading', async (t) => {
  const root = await createTempDirectory('xyst-session-bounded-read-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  const session = store.create();
  await store.save(session);
  const recordPath = path.join(root, '.agent', 'sessions', `${session.id}.json`);

  const probe = await fs.open(recordPath, 'r');
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  const read = fileHandlePrototype.read;
  let bytesRead = 0;
  fileHandlePrototype.read = async (buffer, offset, length) => {
    buffer.fill(0, offset, offset + length);
    bytesRead += length;
    return { bytesRead: length, buffer };
  };
  try {
    await assert.rejects(store.load(session.id), { code: 'SESSION_RECORD_TOO_LARGE' });
    assert.equal(bytesRead, MAX_SESSION_EXPORT_BYTES + 1);
  } finally {
    fileHandlePrototype.read = read;
  }
});

test('session reads reject linked session state directories', async (t) => {
  const root = await createTempDirectory('xyst-session-link-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  const outsideStore = new SessionStore(outside);
  const externalSession = outsideStore.create();
  await outsideStore.save(externalSession);
  const linkedStoreRoot = path.join(root, 'linked-store');
  await fs.mkdir(linkedStoreRoot);
  const linkedStore = new SessionStore(linkedStoreRoot);
  if (!(await createSymlinkOrSkip(t, path.join(outside, '.agent'), path.join(linkedStoreRoot, '.agent'), 'dir'))) return;
  await assert.rejects(linkedStore.load(externalSession.id), { code: 'SESSION_DIRECTORY_INVALID' });
  await assert.rejects(linkedStore.list(), { code: 'SESSION_DIRECTORY_INVALID' });
  await assert.rejects(linkedStore.inspectRecords(), { code: 'SESSION_DIRECTORY_INVALID' });
  await assert.rejects(linkedStore.delete(externalSession.id), { code: 'SESSION_DIRECTORY_INVALID' });
  assert.equal((await outsideStore.load(externalSession.id)).id, externalSession.id);
});

test('session reads reject linked session files', async (t) => {
  const root = await createTempDirectory('xyst-session-file-link-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outside = path.join(root, 'outside');
  await fs.mkdir(path.join(outside, 'sessions'), { recursive: true });
  const store = new SessionStore(root);
  const session = store.create();
  await fs.mkdir(store.directory, { recursive: true });
  const target = path.join(outside, 'sessions', 'linked.json');
  await fs.writeFile(target, JSON.stringify(session));
  const link = path.join(store.directory, `${session.id}.json`);
  if (!(await createSymlinkOrSkip(t, target, link, 'file'))) return;
  await assert.rejects(store.load(session.id), { code: 'SESSION_FILE_INVALID' });
});

test('session export/import preserves compacted history while removing grants, paths, and secret-like text', async (t) => {
  const root = await createTempDirectory('xyst-session-export-');
  const importRoot = await createTempDirectory('xyst-session-export-import-');
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(importRoot, { recursive: true, force: true })]));
  const store = new SessionStore(root);
  const goalStore = new GoalStore(root);
  const goal = await goalStore.add('Deliver safely API_KEY=goal-secret');
  await goalStore.addProgress(goal.id, 'Complete with API_KEY=progress-secret', 'docs/API_KEY=reference-secret.md');
  const session = store.create({ model: 'local' });
  session.persistent_goal_ids = [goal.id];
  session.title = 'Portable session API_KEY=supersecret';
  session.worktree_path = path.join(root, '.agent', 'worktrees', 'private-checkout');
  session.budget_state = { custom: 'access_token=legacy-secret' };
  session.permission_grants.push(createSessionGrant('write_file', { path: 'src/file.txt', content: 'approved' }, 60_000));
  session.messages.push({ role: 'user', content: 'Use API_KEY=prompt-secret' });
  session.compaction_summary = 'Earlier API_KEY=summary-secret';
  const archivedAt = new Date().toISOString();
  const relativeArchive = path.join('.agent', 'compactions', session.id, '12345678-1234-4234-8234-123456789abc.json');
  await atomicWriteJson(path.join(root, relativeArchive), {
    schema_version: 1,
    session_id: session.id,
    archived_at: archivedAt,
    messages: [{ role: 'assistant', content: 'Archived API_KEY=archive-secret' }],
  });
  session.compaction_archive = relativeArchive;
  session.compaction_archives = [relativeArchive];
  await store.save(session);

  const exported = await store.exportSession(session.id);
  assert.equal(exported.format, 'xyst-session');
  assert.equal(exported.session.permission_grants.length, 0);
  assert.equal(exported.session.worktree_path, null);
  assert.deepEqual(exported.session.compaction_archives, []);
  assert.match(exported.session.title, /\[REDACTED\]/);
  assert.match(exported.session.messages[0].content, /\[REDACTED\]/);
  assert.match(exported.session.compaction_summary, /\[REDACTED\]/);
  assert.match(exported.session.budget_state.custom, /\[REDACTED\]/);
  assert.match(exported.archives[0].messages[0].content, /\[REDACTED\]/);
  assert.deepEqual(
    exported.goals.goals.map(({ id }) => id),
    [goal.id],
  );
  assert.match(exported.goals.goals[0].title, /\[REDACTED\]/);
  assert.match(exported.goals.goals[0].progress[0].text, /\[REDACTED\]/);
  assert.match(exported.goals.goals[0].progress[0].reference, /\[REDACTED\]/);

  const importStore = new SessionStore(importRoot);
  const imported = await importStore.importSession(exported);
  assert.notEqual(imported.id, session.id);
  assert.equal(imported.status, 'active');
  assert.equal(imported.permission_grants.length, 0);
  assert.equal(imported.worktree_path, null);
  assert.deepEqual(imported.budget_state, {});
  assert.deepEqual(imported.persistent_goal_ids, [goal.id]);
  assert.equal(imported.compaction_archives.length, 1);
  const importedArchive = JSON.parse(await fs.readFile(path.join(importRoot, imported.compaction_archive), 'utf8'));
  assert.equal(importedArchive.session_id, imported.id);
  assert.match(importedArchive.messages[0].content, /\[REDACTED\]/);
  const importedGoal = (await new GoalStore(importRoot).list())[0];
  assert.equal(importedGoal.id, goal.id);
  assert.match(importedGoal.title, /\[REDACTED\]/);
  const importedAgain = await importStore.importSession(exported);
  assert.notEqual(importedAgain.id, imported.id);
  assert.equal((await new GoalStore(importRoot).list()).length, 1);
});

test('session import preserves failed status and sanitized failure details', async (t) => {
  const sourceRoot = await createTempDirectory('xyst-failed-session-export-');
  const destinationRoot = await createTempDirectory('xyst-failed-session-import-');
  t.after(() =>
    Promise.all([fs.rm(sourceRoot, { recursive: true, force: true }), fs.rm(destinationRoot, { recursive: true, force: true })]),
  );
  const sourceStore = new SessionStore(sourceRoot);
  const session = sourceStore.create({ messages: [{ role: 'user', content: 'Fix the agent run' }] });
  session.status = 'failed';
  session.failure = sessionFailureFromError(
    Object.assign(new Error('Provider rejected the request with API_KEY=private-value'), { code: 'PROVIDER_ERROR' }),
    '2026-10-24T12:00:00.000Z',
  );
  await sourceStore.save(session);

  const imported = await new SessionStore(destinationRoot).importSession(await sourceStore.exportSession(session.id));
  assert.equal(imported.status, 'failed');
  assert.equal(imported.failure.code, 'PROVIDER_ERROR');
  assert.match(imported.failure.message, /\[REDACTED\]/);
  assert.doesNotMatch(imported.failure.message, /private-value/);
});

test('failed session import preserves unrelated files in its archive directory', async (t) => {
  const sourceRoot = await createTempDirectory('xyst-session-import-cleanup-source-');
  const destinationRoot = await createTempDirectory('xyst-session-import-cleanup-destination-');
  t.after(() =>
    Promise.all([fs.rm(sourceRoot, { recursive: true, force: true }), fs.rm(destinationRoot, { recursive: true, force: true })]),
  );
  const sourceStore = new SessionStore(sourceRoot);
  const session = sourceStore.create({ messages: [{ role: 'user', content: 'Import two archives' }] });
  await sourceStore.save(session);
  const exported = await sourceStore.exportSession(session.id);
  exported.archives = [
    {
      schema_version: SESSION_ARCHIVE_SCHEMA_VERSION,
      archived_at: new Date().toISOString(),
      messages: [{ role: 'assistant', content: 'first' }],
    },
    {
      schema_version: SESSION_ARCHIVE_SCHEMA_VERSION,
      archived_at: new Date().toISOString(),
      messages: [{ role: 'assistant', content: 'second' }],
    },
  ];

  const originalOpen = fs.open;
  let archiveWriteCount = 0;
  let archiveDirectory;
  fs.open = async (filePath, flags, ...args) => {
    if (filePath.includes(`${path.sep}.agent${path.sep}compactions${path.sep}`) && filePath.endsWith('.tmp') && flags === 'wx') {
      archiveWriteCount += 1;
      archiveDirectory = path.dirname(filePath);
      if (archiveWriteCount === 2) {
        const sentinel = await originalOpen(path.join(archiveDirectory, 'keep.txt'), 'wx', 0o600);
        await sentinel.writeFile('unrelated archive file');
        await sentinel.close();
        throw Object.assign(new Error('simulated second archive write failure'), { code: 'EIO' });
      }
    }
    return originalOpen(filePath, flags, ...args);
  };
  try {
    await assert.rejects(new SessionStore(destinationRoot).importSession(exported), { code: 'EIO' });
  } finally {
    fs.open = originalOpen;
  }

  assert.equal(await fs.readFile(path.join(archiveDirectory, 'keep.txt'), 'utf8'), 'unrelated archive file');
  assert.deepEqual(await fs.readdir(archiveDirectory), ['keep.txt']);
  assert.deepEqual(await new SessionStore(destinationRoot).list(), []);
});

test('session import rejects conflicting goal identities without leaving a partial session', async (t) => {
  const source = await createTempDirectory('xyst-session-goal-source-');
  const destination = await createTempDirectory('xyst-session-goal-destination-');
  t.after(() => Promise.all([fs.rm(source, { recursive: true, force: true }), fs.rm(destination, { recursive: true, force: true })]));
  const sourceGoals = new GoalStore(source);
  const goal = await sourceGoals.add('Source goal');
  const sessionStore = new SessionStore(source);
  const session = sessionStore.create({ messages: [{ role: 'user', content: 'session with goal' }] });
  session.persistent_goal_ids = [goal.id];
  await sessionStore.save(session);
  const portable = await sessionStore.exportSession(session.id);
  await new GoalStore(destination).add('Unrelated goal with colliding identity');
  const destinationGoals = new GoalStore(destination);
  const existing = await destinationGoals.list();
  const collided = structuredClone(portable.goals.goals[0]);
  collided.id = existing[0].id;
  portable.goals.goals = [collided];
  portable.session.persistent_goal_ids = [existing[0].id];
  await assert.rejects(new SessionStore(destination).importSession(portable), { code: 'GOAL_ID_CONFLICT' });
  assert.equal((await new SessionStore(destination).list()).length, 0);
  assert.equal((await destinationGoals.list()).length, 1);
});

test('session export refuses a compaction archive path outside the session archive directory', async (t) => {
  const root = await createTempDirectory('xyst-session-export-path-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  const session = store.create();
  await store.save(session);
  session.compaction_archive = path.join('..', '..', 'outside.json');
  session.compaction_archives = [session.compaction_archive];
  await store.save(session);
  await assert.rejects(store.exportSession(session.id), { code: 'INVALID_SESSION_ARCHIVE' });
});

test('session revisions prevent stale writers from overwriting newer data', async (t) => {
  const root = await createTempDirectory('xyst-session-conflict-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const firstStore = new SessionStore(root);
  const secondStore = new SessionStore(root);
  const created = firstStore.create();
  await firstStore.save(created);
  const stale = await secondStore.load(created.id);
  const current = await firstStore.load(created.id);
  current.title = 'newer';
  await firstStore.save(current);
  stale.title = 'stale';
  await assert.rejects(secondStore.save(stale), { code: 'SESSION_CONFLICT' });
  assert.equal((await firstStore.load(created.id)).title, 'newer');
  const beforeDelete = await secondStore.load(created.id);
  await firstStore.delete(created.id);
  await assert.rejects(secondStore.save(beforeDelete), { code: 'SESSION_CONFLICT' });
  await assert.rejects(firstStore.load(created.id), { code: 'ENOENT' });
});

test('concurrent session mutations serialize and report stale revisions', async (t) => {
  const root = await createTempDirectory('xyst-session-race-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stores = Array.from({ length: 8 }, () => new SessionStore(root));
  const session = stores[0].create();
  await stores[0].save(session);
  const staleCopies = await Promise.all(stores.map((store) => store.load(session.id)));
  const results = await Promise.allSettled(
    stores.map((store, index) => {
      staleCopies[index].title = `title ${index}`;
      return store.save(staleCopies[index]);
    }),
  );
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(
    results.filter((result) => result.status === 'rejected' && result.reason.code === 'SESSION_CONFLICT').length,
    stores.length - 1,
  );
  assert.ok((await stores[0].load(session.id)).title.startsWith('title '));
});

test('session lock timeout reports contention without changing the session', async (t) => {
  const root = await createTempDirectory('xyst-session-lock-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root, { lockWaitMs: 0 });
  const session = store.create();
  await store.save(session);
  await fs.mkdir(store.lockDirectory, { recursive: true });
  const lockPath = path.join(store.lockDirectory, `${session.id}.lock`);
  await fs.writeFile(lockPath, 'test owner');
  session.title = 'must not be saved';
  await assert.rejects(store.save(session), { code: 'SESSION_LOCKED' });
  assert.equal((await store.load(session.id)).title, undefined);
});

test('session lock cleanup preserves a replacement lock owned by another writer', async (t) => {
  const root = await createTempDirectory('xyst-session-lock-replacement-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  const session = store.create();
  const lockPath = path.join(store.lockDirectory, `${session.id}.lock`);
  const rename = fs.rename;
  let replaced = false;
  let unavailable;
  fs.rename = async (source, destination) => {
    const result = await rename(source, destination);
    if (!replaced && path.resolve(destination) === path.resolve(path.join(store.directory, `${session.id}.json`))) {
      try {
        await fs.rm(lockPath);
        await fs.writeFile(lockPath, 'replacement session writer lock');
        replaced = true;
      } catch (error) {
        if (process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) unavailable = error.code;
        else throw error;
      }
    }
    return result;
  };
  try {
    await store.save(session);
  } finally {
    fs.rename = rename;
  }
  if (unavailable) return t.skip(`Open lock replacement is unavailable: ${unavailable}`);
  assert.equal(replaced, true);
  assert.equal(await fs.readFile(lockPath, 'utf8'), 'replacement session writer lock');
});

test('session grants match only the exact tool arguments, expire, revoke, and do not fork', async (t) => {
  const root = await createTempDirectory('xyst-session-grants-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  const session = store.create();
  const args = { path: 'src/app.js', content: 'approved text' };
  const grant = createSessionGrant('write_file', args, 60_000);
  session.permission_grants.push(grant);
  await store.save(session);
  const loaded = await store.load(session.id);
  assert.equal(findSessionGrant(loaded, 'write_file', { content: 'approved text', path: 'src/app.js' })?.id, grant.id);
  assert.equal(findSessionGrant(loaded, 'write_file', { path: 'src/other.js', content: 'approved text' }), null);
  assert.equal(findSessionGrant(loaded, 'edit_file', args), null);
  assert.equal(findSessionGrant(loaded, 'write_file', args, Date.now() + 60_001), null);
  assert.equal((await store.listPermissionGrants(session.id))[0].status, 'active');
  const fork = await store.fork(session.id);
  assert.deepEqual(fork.permission_grants, []);
  assert.equal(await store.revokePermissionGrant(session.id, grant.id), true);
  assert.deepEqual(await store.listPermissionGrants(session.id), []);
  assert.equal(await store.revokePermissionGrant(session.id, grant.id), false);
  const audit = (await fs.readFile(path.join(root, '.agent', 'audit', 'tool-events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    audit.map((entry) => entry.outcome),
    ['revocation_requested', 'succeeded'],
  );
  assert.throws(() => createSessionGrant('write_file', args, 59_999), /duration/);
});

test('memory store separates sections and supports append, update and delete', async (t) => {
  const root = await createTempDirectory('xyst-memory-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new MemoryStore(root);
  const credential = await store.append('user_preferences', 'API_KEY=supersecret', { source: 'user' });
  assert.equal(credential.text, 'API_KEY=[REDACTED]');
  await store.update('user_preferences', credential.id, 'token=anothersecret');
  assert.equal((await store.read()).sections.user_preferences[0].text, 'token=[REDACTED]');
  const created = await store.append('conventions', 'Use ESM', { source: 'user' });
  assert.equal((await store.read()).sections.conventions[0].text, 'Use ESM');
  await store.update('conventions', created.id, 'Use ECMAScript modules');
  assert.equal((await store.read()).sections.conventions[0].text, 'Use ECMAScript modules');
  assert.equal(await store.delete('conventions', created.id), true);
  assert.equal(await store.delete('conventions', created.id), false);
  await assert.rejects(store.append('instructions', 'no'), /Unknown memory section/);
});

test('project and global memory restore one validated replacement backup instead of reading empty memory', async (t) => {
  const projectRoot = await createTempDirectory('xyst-memory-backup-recovery-');
  const globalRoot = await createTempDirectory('xyst-global-memory-backup-recovery-');
  t.after(() => Promise.all([fs.rm(projectRoot, { recursive: true, force: true }), fs.rm(globalRoot, { recursive: true, force: true })]));
  for (const store of [new MemoryStore(projectRoot), new GlobalMemoryStore(globalRoot)]) {
    await store.append('lessons_learned', 'Preserve this memory entry.', { source: 'user' });
    const backup = `${store.filePath}.00000000-0000-4000-8000-000000000001.bak`;
    await fs.rename(store.filePath, backup);

    const memory = await store.read();
    assert.equal(memory.sections.lessons_learned[0].text, 'Preserve this memory entry.');
    await assert.rejects(fs.lstat(backup), { code: 'ENOENT' });
  }
});

test('project goals restore one validated replacement backup instead of reading an empty goal store', async (t) => {
  const root = await createTempDirectory('xyst-goals-backup-recovery-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new GoalStore(root);
  const created = await store.add('Preserve this project goal.');
  const backup = `${store.filePath}.00000000-0000-4000-8000-000000000001.bak`;
  await fs.rename(store.filePath, backup);

  assert.equal((await store.list())[0].id, created.id);
  await assert.rejects(fs.lstat(backup), { code: 'ENOENT' });
});

test('concurrent memory appends from independent stores preserve every update', async (t) => {
  const root = await createTempDirectory('xyst-memory-concurrent-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stores = Array.from({ length: 8 }, () => new MemoryStore(root));
  const results = await Promise.all(stores.map((store, index) => store.append('lessons_learned', `lesson ${index}`)));
  const entries = (await stores[0].read()).sections.lessons_learned;
  assert.equal(entries.length, stores.length);
  assert.deepEqual(new Set(entries.map((item) => item.text)), new Set(results.map((item) => item.text)));
});

test('memory appends from separate Node processes preserve every update', async (t) => {
  const root = await createTempDirectory('xyst-memory-processes-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const moduleUrl = pathToFileURL(path.resolve('src/memory/store.mjs')).href;
  const source = `import { MemoryStore } from ${JSON.stringify(moduleUrl)};\nawait new MemoryStore(process.env.XYST_MEMORY_ROOT, { lockWaitMs: 10000 }).append('lessons_learned', process.env.XYST_MEMORY_ENTRY);`;
  const workers = Array.from({ length: 6 }, (_, index) =>
    runProcess(process.execPath, ['--input-type=module', '-e', source], {
      cwd: process.cwd(),
      env: {
        ...safeProcessEnvironment(process.env),
        XYST_MEMORY_ROOT: root,
        XYST_MEMORY_ENTRY: `worker ${index}`,
      },
      timeoutMs: 15_000,
      maxOutputBytes: 2_000,
    }),
  );
  const results = await Promise.all(workers);
  assert.deepEqual(
    results.map((result) => result.exitCode),
    Array(6).fill(0),
  );
  const entries = (await new MemoryStore(root).read()).sections.lessons_learned;
  assert.equal(entries.length, 6);
  assert.deepEqual(new Set(entries.map((item) => item.text)), new Set(Array.from({ length: 6 }, (_, index) => `worker ${index}`)));
});

test('memory lock contention fails closed without overwriting the current document', async (t) => {
  const root = await createTempDirectory('xyst-memory-locked-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new MemoryStore(root, { lockWaitMs: 0 });
  await fs.mkdir(path.dirname(store.filePath), { recursive: true });
  await fs.writeFile(
    store.filePath,
    JSON.stringify({
      schema_version: 1,
      sections: { conventions: [], architecture_decisions: [], user_preferences: [], lessons_learned: [], open_questions: [] },
    }),
  );
  await fs.writeFile(store.lockPath, JSON.stringify({ pid: 123, hostname: 'test' }));
  await assert.rejects(store.append('conventions', 'must not be written'), { code: 'MEMORY_LOCKED' });
  const memory = JSON.parse(await fs.readFile(store.filePath, 'utf8'));
  assert.deepEqual(memory.sections.conventions, []);
});

test('memory write failure preserves the committed document and releases the writer lock', async (t) => {
  const root = await createTempDirectory('xyst-memory-write-failure-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new MemoryStore(root);
  await store.append('conventions', 'committed before injected failure');
  const original = await fs.readFile(store.filePath, 'utf8');
  const failingStore = new MemoryStore(root, {
    writeJson: async () => {
      throw Object.assign(new Error('simulated atomic persistence failure'), { code: 'EIO' });
    },
  });

  await assert.rejects(failingStore.append('conventions', 'must not persist'), { code: 'EIO' });
  assert.equal(await fs.readFile(store.filePath, 'utf8'), original);
  await assert.rejects(fs.lstat(store.lockPath), { code: 'ENOENT' });

  await store.append('conventions', 'retry after failed write');
  assert.deepEqual(
    (await store.read()).sections.conventions.map((item) => item.text),
    ['committed before injected failure', 'retry after failed write'],
  );
});

test('memory lock cleanup preserves a replacement lock owned by another writer', async (t) => {
  const root = await createTempDirectory('xyst-memory-lock-replacement-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let replaced = false;
  let replacementUnavailable;
  const store = new MemoryStore(root, {
    writeJson: async (filePath, document, options) => {
      try {
        await fs.rm(path.join(root, '.agent', 'memory.lock'));
        await fs.writeFile(path.join(root, '.agent', 'memory.lock'), 'replacement writer lock');
        replaced = true;
      } catch (error) {
        if (process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) {
          replacementUnavailable = error.code;
        } else {
          throw error;
        }
      }
      return atomicWriteJson(filePath, document, options);
    },
  });
  await store.append('conventions', 'preserve replacement lock');
  if (replacementUnavailable) return t.skip(`Open lock replacement is unavailable: ${replacementUnavailable}`);
  assert.equal(replaced, true);
  assert.equal(await fs.readFile(store.lockPath, 'utf8'), 'replacement writer lock');
});

test('memory reads reject oversized files before parsing and validate entry bounds', async (t) => {
  const root = await createTempDirectory('xyst-memory-bounds-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new MemoryStore(root);
  await fs.mkdir(path.dirname(store.filePath), { recursive: true });
  await fs.writeFile(store.filePath, Buffer.alloc(MAX_MEMORY_FILE_BYTES + 1, 0x20));
  await assert.rejects(store.read(), { code: 'MEMORY_LIMIT' });

  const invalid = {
    schema_version: 1,
    updated_at: new Date().toISOString(),
    sections: {
      conventions: [{ id: 'entry', text: 'too long', source: 'user', created_at: 'not-a-date' }],
      architecture_decisions: [],
      user_preferences: [],
      lessons_learned: [],
      open_questions: [],
    },
  };
  await fs.writeFile(store.filePath, JSON.stringify(invalid));
  await assert.rejects(store.read(), /Memory item in 'conventions' is invalid/);
  await assert.rejects(store.append('conventions', 'x'.repeat(MAX_MEMORY_ITEM_CHARS + 1)), /characters/);
});

test('memory refuses a workspace .agent directory that resolves through a symbolic link', async (t) => {
  const root = await createTempDirectory('xyst-memory-link-root-');
  const outside = await createTempDirectory('xyst-memory-link-outside-');
  t.after(async () => {
    await Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })]);
  });
  const externalStore = new MemoryStore(outside);
  await externalStore.append('conventions', 'external data');
  if (!(await createSymlinkOrSkip(t, path.join(outside, '.agent'), path.join(root, '.agent')))) return;

  const store = new MemoryStore(root);
  await assert.rejects(store.read(), { code: 'MEMORY_PATH_UNSAFE' });
  await assert.rejects(store.append('conventions', 'must stay in this workspace'), { code: 'MEMORY_PATH_UNSAFE' });
  assert.equal((await externalStore.read()).sections.conventions.length, 1);
});

test('memory export redacts secrets and import is additive, idempotent, and version checked', async (t) => {
  const sourceRoot = await createTempDirectory('xyst-memory-export-source-');
  const targetRoot = await createTempDirectory('xyst-memory-export-target-');
  t.after(async () => {
    await Promise.all([fs.rm(sourceRoot, { recursive: true, force: true }), fs.rm(targetRoot, { recursive: true, force: true })]);
  });
  const sourceStore = new MemoryStore(sourceRoot);
  const sourceItem = await sourceStore.append('conventions', 'API_KEY=export-canary', { source: 'user' });
  const document = await sourceStore.exportMemory();
  assert.equal(document.format, 'xyst-memory');
  assert.equal(document.format_version, 2);
  assert.equal(JSON.stringify(document).includes('export-canary'), false);
  const targetStore = new MemoryStore(targetRoot);
  const imported = await targetStore.importMemory(document);
  assert.deepEqual(
    { imported: imported.imported, skipped_duplicates: imported.skipped_duplicates },
    { imported: 1, skipped_duplicates: 0 },
  );
  const storedItem = (await targetStore.read()).sections.conventions[0];
  assert.equal(storedItem.text, 'API_KEY=[REDACTED]');
  assert.equal(storedItem.source, 'import');
  assert.equal(storedItem.created_by, 'import');
  assert.notEqual(storedItem.id, sourceItem.id);
  assert.equal(sourceItem.created_by, 'user');
  assert.equal(sourceItem.updated_by, undefined);
  assert.equal(MEMORY_SCHEMA_VERSION, PERSISTENCE_SCHEMA_REGISTRY.currentVersion('memory'));
  assert.deepEqual(MEMORY_PROVENANCE_ACTORS, ['agent', 'import', 'unknown', 'user']);
  assert.equal((await targetStore.importMemory(document)).imported, 0);
  assert.equal((await targetStore.importMemory(document)).skipped_duplicates, 1);

  const unsupported = { format: 'xyst-memory', format_version: 99 };
  await assert.rejects(targetStore.importMemory(unsupported), { code: 'UNSUPPORTED_MEMORY_EXPORT_VERSION' });
  assert.equal((await targetStore.read()).sections.conventions.length, 1);
});

test('memory import rejects a project-wide item overflow without changing stored data', async (t) => {
  const root = await createTempDirectory('xyst-memory-import-limit-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new MemoryStore(root);
  const existing = await store.append('conventions', 'existing entry');
  const createdAt = new Date().toISOString();
  const document = {
    format: 'xyst-memory',
    format_version: 1,
    exported_at: createdAt,
    memory: {
      schema_version: 1,
      updated_at: createdAt,
      sections: {
        conventions: Array.from({ length: 1_000 }, (_, index) => ({
          id: `import-${index}`,
          text: `imported entry ${index}`,
          source: 'test',
          created_at: createdAt,
        })),
        architecture_decisions: [],
        user_preferences: [],
        lessons_learned: [],
        open_questions: [],
      },
    },
  };
  const before = await fs.readFile(store.filePath, 'utf8');

  await assert.rejects(store.importMemory(document), { code: 'MEMORY_LIMIT' });

  assert.equal(await fs.readFile(store.filePath, 'utf8'), before);
  const memory = await store.read();
  assert.equal(memory.sections.conventions.length, 1);
  assert.equal(memory.sections.conventions[0].id, existing.id);
  assert.equal(memory.sections.conventions[0].text, 'existing entry');

  await assert.rejects(store.importMemory({ ...document, padding: 'x'.repeat(MAX_MEMORY_EXPORT_BYTES) }), {
    code: 'MEMORY_EXPORT_TOO_LARGE',
  });
  assert.equal(await fs.readFile(store.filePath, 'utf8'), before);
});

test('project goals persist independently and support completion and removal', async (t) => {
  const root = await createTempDirectory('xyst-goals-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new GoalStore(root);
  const goal = await store.add('Ship the CLI API_KEY=supersecret', 'Keep Windows and Linux in CI; token=anothersecret');
  assert.equal(goal.title, 'Ship the CLI API_KEY=[REDACTED]');
  assert.equal(goal.details, 'Keep Windows and Linux in CI; token=[REDACTED]');
  const progressed = await store.addProgress(goal.id, 'The CI matrix now covers Windows and Linux.', 'docs/IMPLEMENTATION_STATUS.md');
  assert.equal(progressed.progress.length, 1);
  assert.equal(progressed.progress[0].source, 'user');
  assert.equal(progressed.progress[0].reference, 'docs/IMPLEMENTATION_STATUS.md');
  assert.ok(Number.isFinite(Date.parse(progressed.progress[0].created_at)));
  const originalCreatedAt = progressed.progress[0].created_at;
  await store.addProgress(goal.id, 'token=progress-secret');
  assert.equal((await store.list())[0].progress[1].text, 'token=[REDACTED]');
  await assert.rejects(store.addProgress(goal.id, '  '), /progress/);
  const updated = await store.updateProgress(
    goal.id,
    progressed.progress[0].id,
    'Reviewed the recovery journal.',
    'docs/security-review.md',
  );
  assert.equal(updated.progress[0].created_at, originalCreatedAt);
  assert.equal(updated.progress[0].text, 'Reviewed the recovery journal.');
  assert.equal(updated.progress[0].reference, 'docs/security-review.md');
  assert.ok(Number.isFinite(Date.parse(updated.progress[0].updated_at)));
  assert.equal(await store.deleteProgress(goal.id, updated.progress[1].id), true);
  assert.equal(await store.deleteProgress(goal.id, updated.progress[1].id), false);
  assert.equal((await store.list())[0].progress.length, 1);
  assert.equal((await store.list({ includeCompleted: false })).length, 1);
  await store.setStatus(goal.id, 'completed');
  assert.equal((await store.list({ includeCompleted: false })).length, 0);
  assert.equal((await store.list()).length, 1);
  assert.equal(await store.delete(goal.id), true);
});

test('legacy project goals without progress remain readable and do not gain implicit model-authored entries', async (t) => {
  const root = await createTempDirectory('xyst-goals-legacy-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new GoalStore(root);
  await fs.mkdir(path.dirname(store.filePath), { recursive: true });
  const legacy = {
    schema_version: 1,
    updated_at: new Date().toISOString(),
    goals: [
      {
        id: 'legacy-id',
        title: 'Existing goal',
        details: 'Existing detail',
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ],
  };
  await fs.writeFile(store.filePath, JSON.stringify(legacy));
  const [goal] = await store.list();
  assert.deepEqual(goal.progress, []);
  assert.deepEqual(JSON.parse(await fs.readFile(store.filePath, 'utf8')), legacy);
});

test('project goals reject linked .agent directories and linked goals files', async (t) => {
  const root = await createTempDirectory('xyst-goals-link-root-');
  const outside = await createTempDirectory('xyst-goals-link-outside-');
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })]));
  const store = new GoalStore(root);
  if (!(await createSymlinkOrSkip(t, outside, path.join(root, '.agent')))) return;
  await assert.rejects(store.add('Must not write through a linked state directory'), { code: 'GOAL_PATH_UNSAFE' });
  await fs.rm(path.join(root, '.agent'), { force: true });
  await fs.mkdir(path.join(root, '.agent'));
  await fs.writeFile(path.join(outside, 'goals.json'), JSON.stringify({ schema_version: 1, goals: [] }));
  if (!(await createSymlinkOrSkip(t, path.join(outside, 'goals.json'), store.filePath, 'file'))) return;
  await assert.rejects(store.list(), { code: 'GOAL_PATH_UNSAFE' });
});

test('goal lock is released when lock metadata inspection fails', async (t) => {
  const root = await createTempDirectory('xyst-goals-lock-stat-eio-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new GoalStore(root);
  const lockPath = path.join(root, '.agent', 'goals.lock');
  const open = fs.open;
  let injected = false;
  fs.open = async (filePath, ...args) => {
    const handle = await open(filePath, ...args);
    if (path.resolve(filePath) !== path.resolve(lockPath) || injected) return handle;
    injected = true;
    return {
      writeFile: handle.writeFile.bind(handle),
      stat: async () => {
        const error = new Error('injected goal lock metadata failure');
        error.code = 'EIO';
        throw error;
      },
      close: handle.close.bind(handle),
    };
  };
  try {
    await assert.rejects(store.add('Retry after lock metadata failure'), { code: 'EIO' });
  } finally {
    fs.open = open;
  }
  await assert.rejects(fs.access(lockPath), { code: 'ENOENT' });
  assert.equal((await new GoalStore(root).add('Retry after lock metadata failure')).title, 'Retry after lock metadata failure');
});

test('goal write failure leaves no partial state or lock and permits retry', async (t) => {
  const root = await createTempDirectory('xyst-goals-write-failure-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new GoalStore(root);
  const probe = await fs.open(path.join(root, 'probe'), 'w');
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  const writeFile = fileHandlePrototype.writeFile;
  let writeCount = 0;
  fileHandlePrototype.writeFile = async function (...args) {
    writeCount += 1;
    if (writeCount === 2) throw Object.assign(new Error('simulated goal write failure'), { code: 'EIO' });
    return writeFile.apply(this, args);
  };
  try {
    await assert.rejects(store.add('Retry after interrupted goal save'), { code: 'EIO' });
  } finally {
    fileHandlePrototype.writeFile = writeFile;
  }

  assert.deepEqual(await fs.readdir(path.dirname(store.filePath)), []);
  assert.equal((await store.add('Retry after interrupted goal save')).title, 'Retry after interrupted goal save');
  assert.equal((await store.list()).length, 1);
});

test('goal progress appends from independent stores serialize without losing references', async (t) => {
  const root = await createTempDirectory('xyst-goals-concurrent-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stores = Array.from({ length: 8 }, () => new GoalStore(root, { lockWaitMs: 10_000 }));
  const goal = await stores[0].add('Preserve concurrent progress.');
  await Promise.all(stores.map((store, index) => store.addProgress(goal.id, `Progress ${index}`, `ref-${index}`)));
  const [saved] = await stores[0].list();
  assert.equal(saved.progress.length, stores.length);
  assert.deepEqual(saved.progress.map(({ reference }) => reference).sort(), stores.map((_store, index) => `ref-${index}`).sort());
});
