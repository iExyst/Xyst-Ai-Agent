import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionStore, MAX_SESSION_EXPORT_BYTES } from '../session/store.mjs';
import { MemoryStore, MAX_MEMORY_EXPORT_BYTES } from '../memory/store.mjs';
import { GoalStore } from '../goals/store.mjs';

export const PROJECT_BACKUP_VERSION = 1;
export const MAX_PROJECT_BACKUP_BYTES = 256 * 1024 * 1024;
export const MAX_PROJECT_BACKUP_SESSIONS = 1_000;

/** Export portable project work records; machine-local policy/runtime state is deliberately excluded. */
export async function exportProjectBackup(workspaceRoot) {
  const workspace = await fs.realpath(workspaceRoot);
  const sessions = new SessionStore(workspace);
  const report = await sessions.inspectRecords();
  if (report.unreadable.length || report.unexpected.length)
    throw Object.assign(
      new Error('Project backup refused because session records are corrupt or unexpected; inspect sessions before retrying.'),
      {
        code: 'PROJECT_BACKUP_SESSIONS_UNREADABLE',
      },
    );
  const sessionList = await sessions.list();
  if (sessionList.length > MAX_PROJECT_BACKUP_SESSIONS)
    throw Object.assign(new Error(`Project backup cannot exceed ${MAX_PROJECT_BACKUP_SESSIONS} sessions`), {
      code: 'PROJECT_BACKUP_TOO_LARGE',
    });
  const sessionExports = [];
  let componentBytes = 0;
  for (const session of sessionList) {
    const document = await sessions.exportSession(session.id, { includeGoals: false });
    const bytes = Buffer.byteLength(JSON.stringify(document), 'utf8');
    if (bytes > MAX_SESSION_EXPORT_BYTES)
      throw Object.assign(new Error('A session exceeds the portable session size limit'), { code: 'PROJECT_BACKUP_TOO_LARGE' });
    componentBytes += bytes;
    if (componentBytes > MAX_PROJECT_BACKUP_BYTES)
      throw Object.assign(new Error('Project backup exceeds its size limit'), { code: 'PROJECT_BACKUP_TOO_LARGE' });
    sessionExports.push(document);
  }
  const [memory, goals] = await Promise.all([new MemoryStore(workspace).exportMemory(), new GoalStore(workspace).exportGoals()]);
  componentBytes += Buffer.byteLength(JSON.stringify(memory), 'utf8') + Buffer.byteLength(JSON.stringify(goals), 'utf8');
  if (componentBytes > MAX_PROJECT_BACKUP_BYTES)
    throw Object.assign(new Error('Project backup exceeds its size limit'), { code: 'PROJECT_BACKUP_TOO_LARGE' });
  const backup = {
    format: 'xyst-project-backup',
    format_version: PROJECT_BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    manifest: {
      sessions: sessionExports.length,
      goals: goals.goals.length,
      memory_items: Object.values(memory.memory.sections).reduce((count, items) => count + items.length, 0),
    },
    contents: { sessions: sessionExports, memory, goals },
    excluded: [
      'configuration and credentials',
      'approval rules and grants',
      'audit and usage ledgers',
      'processes and worktrees',
      'semantic indexes',
      'observability records',
    ],
  };
  assertProjectBackupSize(backup);
  return backup;
}

/** Read-only validation and staged restore. Existing .agent state is never merged or overwritten. */
export async function restoreProjectBackup(workspaceRoot, backup) {
  validateProjectBackup(backup);
  const workspace = await fs.realpath(workspaceRoot);
  const destination = path.join(workspace, '.agent');
  await assertNoProjectState(destination);
  const staging = await fs.mkdtemp(path.join(workspace, `.xyst-restore-${randomUUID()}-`));
  const stagedAgent = path.join(staging, '.agent');
  try {
    const goals = await new GoalStore(staging).importGoals(backup.contents.goals);
    const memory = await new MemoryStore(staging).importMemory(backup.contents.memory);
    const sessions = new SessionStore(staging);
    const importedSessions = [];
    for (const item of backup.contents.sessions) importedSessions.push(await sessions.importSession(item));

    await assertNoProjectState(destination);
    try {
      await fs.rename(stagedAgent, destination);
    } catch (error) {
      if (['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code))
        throw Object.assign(new Error('Project state appeared during restore; staged data was discarded without overwriting it.'), {
          code: 'PROJECT_STATE_EXISTS',
          cause: error,
        });
      throw error;
    }
    return {
      restored: true,
      sessions: importedSessions.length,
      session_ids: importedSessions.map((session) => session.id),
      goals: goals.imported,
      memory_items: memory.imported,
    };
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

export async function readProjectBackupFile(filePath) {
  const initial = await fs.lstat(filePath);
  if (initial.isSymbolicLink() || !initial.isFile())
    throw Object.assign(new Error('Project backup must be a regular non-symlink file'), { code: 'PROJECT_BACKUP_UNSAFE' });
  if (initial.size > MAX_PROJECT_BACKUP_BYTES)
    throw Object.assign(new Error('Project backup exceeds its size limit'), { code: 'PROJECT_BACKUP_TOO_LARGE' });
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== initial.dev || opened.ino !== initial.ino || opened.size !== initial.size)
      throw Object.assign(new Error('Project backup changed while being opened'), { code: 'PROJECT_BACKUP_CHANGED' });
    const buffer = Buffer.allocUnsafe(initial.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== initial.size)
      throw Object.assign(new Error('Project backup changed while being read'), { code: 'PROJECT_BACKUP_CHANGED' });
    let backup;
    try {
      backup = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
    } catch (error) {
      throw Object.assign(new Error('Project backup is not valid UTF-8 JSON'), { code: 'INVALID_PROJECT_BACKUP', cause: error });
    }
    validateProjectBackup(backup);
    return backup;
  } finally {
    await handle.close();
  }
}

function validateProjectBackup(backup) {
  if (
    !backup ||
    typeof backup !== 'object' ||
    Array.isArray(backup) ||
    backup.format !== 'xyst-project-backup' ||
    backup.format_version !== PROJECT_BACKUP_VERSION ||
    !Number.isFinite(Date.parse(backup.exported_at)) ||
    !backup.contents ||
    typeof backup.contents !== 'object' ||
    Array.isArray(backup.contents) ||
    !Array.isArray(backup.contents.sessions) ||
    backup.contents.sessions.length > MAX_PROJECT_BACKUP_SESSIONS ||
    !backup.contents.memory ||
    typeof backup.contents.memory !== 'object' ||
    Array.isArray(backup.contents.memory) ||
    !backup.contents.goals ||
    typeof backup.contents.goals !== 'object' ||
    Array.isArray(backup.contents.goals) ||
    !Array.isArray(backup.excluded) ||
    backup.excluded.some((item) => typeof item !== 'string') ||
    Buffer.byteLength(JSON.stringify(backup), 'utf8') > MAX_PROJECT_BACKUP_BYTES
  )
    throw Object.assign(new Error('Project backup is invalid, unsupported, or too large'), { code: 'INVALID_PROJECT_BACKUP' });
  if (Buffer.byteLength(JSON.stringify(backup.contents.memory), 'utf8') > MAX_MEMORY_EXPORT_BYTES)
    throw Object.assign(new Error('Project backup memory section exceeds its size limit'), { code: 'INVALID_PROJECT_BACKUP' });
  if (Buffer.byteLength(JSON.stringify(backup.contents.goals), 'utf8') > 4 * 1024 * 1024)
    throw Object.assign(new Error('Project backup goals section exceeds its size limit'), { code: 'INVALID_PROJECT_BACKUP' });
  if (
    !backup.manifest ||
    backup.manifest.sessions !== backup.contents.sessions.length ||
    !Array.isArray(backup.contents.goals.goals) ||
    backup.manifest.goals !== backup.contents.goals.goals.length ||
    !backup.contents.memory.memory?.sections ||
    !Number.isInteger(backup.manifest.memory_items) ||
    backup.manifest.memory_items !==
      Object.values(backup.contents.memory.memory.sections).reduce((count, items) => count + (Array.isArray(items) ? items.length : 0), 0)
  )
    throw Object.assign(new Error('Project backup manifest does not match its contents'), { code: 'INVALID_PROJECT_BACKUP' });
  const sessionIds = new Set();
  for (const document of backup.contents.sessions) {
    const id = document?.session?.id;
    if (
      document?.format !== 'xyst-session' ||
      !Number.isInteger(document.format_version) ||
      typeof id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ||
      sessionIds.has(id)
    )
      throw Object.assign(new Error('Project backup contains an invalid or duplicate session export'), { code: 'INVALID_PROJECT_BACKUP' });
    sessionIds.add(id);
  }
}

function assertProjectBackupSize(backup) {
  if (Buffer.byteLength(`${JSON.stringify(backup, null, 2)}\n`, 'utf8') > MAX_PROJECT_BACKUP_BYTES)
    throw Object.assign(new Error('Project backup exceeds its size limit'), { code: 'PROJECT_BACKUP_TOO_LARGE' });
}

async function assertNoProjectState(directory) {
  try {
    await fs.lstat(directory);
    throw Object.assign(new Error('Project backup restore requires a workspace with no existing .agent state; nothing was overwritten.'), {
      code: 'PROJECT_STATE_EXISTS',
    });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
