import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SessionStore } from '../src/session/store.mjs';
import { MemoryStore } from '../src/memory/store.mjs';
import { GoalStore } from '../src/goals/store.mjs';
import { createSessionGrant } from '../src/tools/grants.mjs';
import { exportProjectBackup, readProjectBackupFile, restoreProjectBackup } from '../src/backup/project-backup.mjs';
import { createTempDirectory } from './helpers.mjs';

test('project backup exports portable sessions, memory and goals, then restores them as one staged state tree', async (t) => {
  const source = await createTempDirectory('xyst-project-backup-source-');
  const destination = await createTempDirectory('xyst-project-backup-target-');
  t.after(() => Promise.all([fs.rm(source, { recursive: true, force: true }), fs.rm(destination, { recursive: true, force: true })]));
  const goals = new GoalStore(source);
  const goal = await goals.add('Ship the project backup');
  await goals.addProgress(goal.id, 'Portable records preserve goal identity.', 'docs/backup.md');
  await new MemoryStore(source).append('conventions', 'Keep portable state versioned.', { source: 'user' });
  const sessionStore = new SessionStore(source);
  const session = sessionStore.create({ messages: [{ role: 'user', content: 'backup transcript' }] });
  session.persistent_goal_ids = [goal.id];
  session.worktree_path = path.join(source, '.agent', 'worktrees', 'machine-specific');
  session.permission_grants = [createSessionGrant('write_file', { path: 'notes.md', content: 'safe' }, 60_000)];
  await sessionStore.save(session);

  const backup = await exportProjectBackup(source);
  assert.equal(backup.manifest.sessions, 1);
  assert.equal(backup.manifest.goals, 1);
  assert.equal(backup.manifest.memory_items, 1);
  assert.deepEqual(backup.contents.sessions[0].session.permission_grants, []);
  assert.equal(backup.contents.sessions[0].session.worktree_path, null);
  const serialized = JSON.stringify(backup);
  assert.doesNotMatch(serialized, /machine-specific|arguments_hash/);

  const backupPath = path.join(source, 'project-backup.json');
  await fs.writeFile(backupPath, `${JSON.stringify(backup, null, 2)}\n`);
  const fromDisk = await readProjectBackupFile(backupPath);
  const result = await restoreProjectBackup(destination, fromDisk);
  assert.equal(result.restored, true);
  assert.equal(result.sessions, 1);
  assert.equal(result.goals, 1);
  assert.equal(result.memory_items, 1);
  assert.notEqual(result.session_ids[0], session.id);
  const restoredGoal = (await new GoalStore(destination).list())[0];
  assert.equal(restoredGoal.id, goal.id);
  assert.equal(restoredGoal.progress[0].text, 'Portable records preserve goal identity.');
  assert.equal((await new MemoryStore(destination).read()).sections.conventions[0].text, 'Keep portable state versioned.');
  const restoredSession = await new SessionStore(destination).load(result.session_ids[0]);
  assert.equal(restoredSession.messages[0].content, 'backup transcript');
  assert.deepEqual(restoredSession.persistent_goal_ids, [goal.id]);
  assert.equal(restoredSession.worktree_path, null);
  assert.deepEqual(restoredSession.permission_grants, []);
});

test('project backup rejects corrupt bundles before creating destination state', async (t) => {
  const workspace = await createTempDirectory('xyst-project-backup-invalid-');
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await assert.rejects(restoreProjectBackup(workspace, { format: 'xyst-project-backup', format_version: 999 }), {
    code: 'INVALID_PROJECT_BACKUP',
  });
  await assert.rejects(fs.access(path.join(workspace, '.agent')), { code: 'ENOENT' });
});

test('project backup rejects duplicate source session IDs during preflight', async (t) => {
  const source = await createTempDirectory('xyst-project-backup-duplicates-source-');
  const destination = await createTempDirectory('xyst-project-backup-duplicates-target-');
  t.after(() => Promise.all([fs.rm(source, { recursive: true, force: true }), fs.rm(destination, { recursive: true, force: true })]));
  const sessions = new SessionStore(source);
  const session = sessions.create({ messages: [] });
  await sessions.save(session);
  const backup = await exportProjectBackup(source);
  backup.contents.sessions.push(structuredClone(backup.contents.sessions[0]));
  backup.manifest.sessions += 1;
  await assert.rejects(restoreProjectBackup(destination, backup), { code: 'INVALID_PROJECT_BACKUP' });
  await assert.rejects(fs.access(path.join(destination, '.agent')), { code: 'ENOENT' });
});

test('project backup restore refuses existing state and preserves every existing file', async (t) => {
  const source = await createTempDirectory('xyst-project-backup-existing-source-');
  const destination = await createTempDirectory('xyst-project-backup-existing-target-');
  t.after(() => Promise.all([fs.rm(source, { recursive: true, force: true }), fs.rm(destination, { recursive: true, force: true })]));
  const backup = await exportProjectBackup(source);
  const existing = path.join(destination, '.agent', 'keep.txt');
  await fs.mkdir(path.dirname(existing), { recursive: true });
  await fs.writeFile(existing, 'preserve');
  await assert.rejects(restoreProjectBackup(destination, backup), { code: 'PROJECT_STATE_EXISTS' });
  assert.equal(await fs.readFile(existing, 'utf8'), 'preserve');
});
