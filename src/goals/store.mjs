import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteJson, restoreAtomicWriteBackup } from '../platform/files.mjs';
import { redactSecrets } from '../platform/redaction.mjs';
import { PERSISTENCE_SCHEMA_REGISTRY } from '../persistence/schema-registry.mjs';

const STATUS = new Set(['active', 'completed']);
const MAX_GOALS = 500;
const MAX_PROGRESS_ENTRIES = 100;
const MAX_GOAL_FILE_BYTES = 4 * 1024 * 1024;
export const GOALS_SCHEMA_VERSION = PERSISTENCE_SCHEMA_REGISTRY.currentVersion('goals');
export const GOALS_EXPORT_VERSION = PERSISTENCE_SCHEMA_REGISTRY.currentVersion('goals_export');

export class GoalStore {
  constructor(workspaceRoot, { lockWaitMs = 2_000 } = {}) {
    if (!Number.isInteger(lockWaitMs) || lockWaitMs < 0 || lockWaitMs > 30_000)
      throw new TypeError('lockWaitMs must be between 0 and 30000');
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.filePath = path.join(this.workspaceRoot, '.agent', 'goals.json');
    this.lockWaitMs = lockWaitMs;
  }

  async list({ includeCompleted = true } = {}) {
    const document = await this.#read();
    return document.goals
      .filter((goal) => includeCompleted || goal.status === 'active')
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async exportGoals() {
    const document = await this.#read();
    const result = {
      format: 'xyst-goals',
      format_version: GOALS_EXPORT_VERSION,
      exported_at: new Date().toISOString(),
      goals: structuredClone(document.goals).map((goal) => ({
        ...goal,
        title: redactSecrets(goal.title),
        details: redactSecrets(goal.details || ''),
        progress: (goal.progress || []).map((entry) => ({
          ...entry,
          text: redactSecrets(entry.text),
          reference: redactSecrets(entry.reference || ''),
        })),
      })),
    };
    if (Buffer.byteLength(`${JSON.stringify(result, null, 2)}\n`, 'utf8') > MAX_GOAL_FILE_BYTES)
      throw Object.assign(new Error('Project goals export exceeds the file limit'), { code: 'GOALS_EXPORT_TOO_LARGE' });
    return result;
  }

  /** Restore an exact goal snapshot only into an empty goal store, preserving IDs for session references. */
  async importGoals(document) {
    validateGoalsExport(document);
    return this.#withLock(async () => {
      const current = await this.#readUnlocked();
      if (current.goals.length)
        throw Object.assign(new Error('Goals can only be restored into an empty project goal store'), {
          code: 'GOALS_IMPORT_TARGET_NOT_EMPTY',
        });
      const now = new Date().toISOString();
      const goals = redactGoalRecords(document.goals);
      await this.#save({ schema_version: GOALS_SCHEMA_VERSION, updated_at: now, goals });
      return { imported: goals.length, updated_at: now };
    });
  }

  /** Merge goal records referenced by a portable session without replacing project state. */
  async importReferencedGoals(document) {
    validateGoalsExport(document);
    return this.#withLock(async () => {
      const current = await this.#readUnlocked();
      const byId = new Map(current.goals.map((goal) => [goal.id, goal]));
      const incoming = redactGoalRecords(document.goals);
      for (const goal of incoming) {
        const existing = byId.get(goal.id);
        if (existing && JSON.stringify(redactGoalRecords([existing])[0]) !== JSON.stringify(goal))
          throw Object.assign(new Error(`Goal ID '${goal.id}' already exists with different project data`), { code: 'GOAL_ID_CONFLICT' });
      }
      const additions = incoming.filter((goal) => !byId.has(goal.id));
      if (current.goals.length + additions.length > MAX_GOALS)
        throw Object.assign(new Error(`Project goals cannot exceed ${MAX_GOALS} entries`), { code: 'GOAL_LIMIT' });
      if (additions.length) {
        const now = new Date().toISOString();
        current.goals.push(...additions);
        current.updated_at = now;
        await this.#save(current);
      }
      return { imported: additions.length, existing: incoming.length - additions.length };
    });
  }

  async add(title, details = '') {
    if (typeof title !== 'string' || !title.trim() || title.length > 500)
      throw new TypeError('Goal title must contain 1 to 500 characters');
    return this.#withLock(async () => {
      const document = await this.#readUnlocked();
      if (document.goals.length >= MAX_GOALS) throw new TypeError(`Project goals cannot exceed ${MAX_GOALS} entries`);
      const now = new Date().toISOString();
      const safeTitle = redactSecrets(title.trim());
      const safeDetails = redactSecrets(String(details).trim());
      if (safeDetails.length > 10_000) throw new TypeError('Goal details cannot exceed 10000 characters');
      const goal = {
        id: randomUUID(),
        title: safeTitle,
        details: safeDetails,
        progress: [],
        status: 'active',
        created_at: now,
        updated_at: now,
      };
      document.goals.push(goal);
      document.updated_at = now;
      await this.#save(document);
      return goal;
    });
  }

  async setStatus(id, status) {
    if (!STATUS.has(status)) throw new TypeError(`Goal status must be one of: ${[...STATUS].join(', ')}`);
    return this.#withLock(async () => {
      const document = await this.#readUnlocked();
      const goal = document.goals.find((entry) => entry.id === id);
      if (!goal) throw Object.assign(new Error(`Goal '${id}' was not found`), { code: 'NOT_FOUND' });
      goal.status = status;
      goal.updated_at = new Date().toISOString();
      document.updated_at = goal.updated_at;
      await this.#save(document);
      return goal;
    });
  }

  async addProgress(id, text, reference = '') {
    if (typeof text !== 'string' || !text.trim() || text.trim().length > 2_000)
      throw new TypeError('Goal progress must contain 1 to 2000 characters');
    if (typeof reference !== 'string' || reference.length > 1_000)
      throw new TypeError('Goal progress reference must be a string of at most 1000 characters');
    return this.#withLock(async () => {
      const document = await this.#readUnlocked();
      const goal = document.goals.find((entry) => entry.id === id);
      if (!goal) throw Object.assign(new Error(`Goal '${id}' was not found`), { code: 'NOT_FOUND' });
      goal.progress ||= [];
      if (goal.progress.length >= MAX_PROGRESS_ENTRIES) throw new TypeError(`Goal progress cannot exceed ${MAX_PROGRESS_ENTRIES} entries`);
      const entry = {
        id: randomUUID(),
        text: redactSecrets(text.trim()),
        reference: redactSecrets(reference.trim()),
        source: 'user',
        created_at: new Date().toISOString(),
      };
      goal.progress.push(entry);
      goal.updated_at = entry.created_at;
      document.updated_at = entry.created_at;
      await this.#save(document);
      return goal;
    });
  }

  async updateProgress(id, progressId, text, reference = undefined) {
    if (typeof text !== 'string' || !text.trim() || text.trim().length > 2_000)
      throw new TypeError('Goal progress must contain 1 to 2000 characters');
    if (reference !== undefined && (typeof reference !== 'string' || reference.length > 1_000))
      throw new TypeError('Goal progress reference must be a string of at most 1000 characters');
    return this.#withLock(async () => {
      const document = await this.#readUnlocked();
      const goal = document.goals.find((entry) => entry.id === id);
      if (!goal) throw Object.assign(new Error(`Goal '${id}' was not found`), { code: 'NOT_FOUND' });
      const entry = (goal.progress || []).find((item) => item.id === progressId);
      if (!entry) throw Object.assign(new Error(`Goal progress '${progressId}' was not found`), { code: 'NOT_FOUND' });
      entry.text = redactSecrets(text.trim());
      if (reference !== undefined) entry.reference = redactSecrets(reference.trim());
      entry.updated_at = new Date().toISOString();
      goal.updated_at = entry.updated_at;
      document.updated_at = entry.updated_at;
      await this.#save(document);
      return goal;
    });
  }

  async deleteProgress(id, progressId) {
    return this.#withLock(async () => {
      const document = await this.#readUnlocked();
      const goal = document.goals.find((entry) => entry.id === id);
      if (!goal) throw Object.assign(new Error(`Goal '${id}' was not found`), { code: 'NOT_FOUND' });
      const progress = goal.progress || [];
      const remaining = progress.filter((entry) => entry.id !== progressId);
      if (remaining.length === progress.length) return false;
      goal.progress = remaining;
      goal.updated_at = new Date().toISOString();
      document.updated_at = goal.updated_at;
      await this.#save(document);
      return true;
    });
  }

  async delete(id) {
    // Persist reference cleanup before removing the goal so interruption cannot
    // leave sessions pointing at a record that no longer exists.
    const { SessionStore } = await import('../session/store.mjs');
    return this.#withLock(async () => {
      await new SessionStore(this.workspaceRoot, { lockWaitMs: this.lockWaitMs }).removeGoalReference(id);
      const document = await this.#readUnlocked();
      const before = document.goals.length;
      document.goals = document.goals.filter((goal) => goal.id !== id);
      if (document.goals.length === before) return false;
      document.updated_at = new Date().toISOString();
      await this.#save(document);
      return true;
    });
  }

  /** Keep session references serialized with goal deletion and import. */
  async withExistingIds(ids, operation) {
    if (
      !Array.isArray(ids) ||
      ids.length > MAX_GOALS ||
      ids.some((id) => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) ||
      new Set(ids).size !== ids.length ||
      typeof operation !== 'function'
    )
      throw Object.assign(new TypeError('Goal references must be a unique list of at most 500 valid IDs'), {
        code: 'INVALID_SESSION_GOALS',
      });
    return this.#withLock(async () => {
      const available = new Set((await this.#readUnlocked()).goals.map((goal) => goal.id));
      const missing = ids.filter((id) => !available.has(id));
      if (missing.length)
        throw Object.assign(new Error(`Project goals were not found: ${missing.join(', ')}`), { code: 'GOAL_NOT_FOUND', ids: missing });
      return operation();
    });
  }

  async #read() {
    return this.#withLock(() => this.#readUnlocked());
  }

  async #readUnlocked() {
    try {
      const directory = await resolveAgentDirectory(this.workspaceRoot);
      if (!directory) return { schema_version: GOALS_SCHEMA_VERSION, updated_at: new Date().toISOString(), goals: [] };
      const filePath = path.join(directory, 'goals.json');
      try {
        return decodeGoals(await readBoundedGoalFile(filePath));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return (
          (await restoreAtomicWriteBackup(filePath, { maxBytes: MAX_GOAL_FILE_BYTES, decode: decodeGoals })) ?? {
            schema_version: GOALS_SCHEMA_VERSION,
            updated_at: new Date().toISOString(),
            goals: [],
          }
        );
      }
    } catch (error) {
      if (error.code === 'ENOENT') return { schema_version: GOALS_SCHEMA_VERSION, updated_at: new Date().toISOString(), goals: [] };
      throw error;
    }
  }

  async #save(document) {
    const directory = await resolveAgentDirectory(this.workspaceRoot, { create: true });
    const serialized = `${JSON.stringify(document, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_GOAL_FILE_BYTES)
      throw Object.assign(new Error(`Project goals exceed the ${MAX_GOAL_FILE_BYTES}-byte file limit`), { code: 'GOAL_LIMIT' });
    await atomicWriteJson(path.join(directory, 'goals.json'), document, { mode: 0o600 });
  }

  async #withLock(operation) {
    const directory = await resolveAgentDirectory(this.workspaceRoot, { create: true });
    const lockPath = path.join(directory, 'goals.lock');
    const deadline = Date.now() + this.lockWaitMs;
    let handle;
    while (!handle) {
      try {
        handle = await fs.open(lockPath, 'wx', 0o600);
      } catch (error) {
        const contention = error.code === 'EEXIST' || (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code));
        if (!contention) throw error;
        if (Date.now() >= deadline)
          throw Object.assign(
            new Error(
              `Project goals are locked at ${lockPath}. If the writer crashed, verify it is no longer running before removing the lock.`,
            ),
            { code: 'GOAL_LOCKED' },
          );
        await new Promise((resolve) => setTimeout(resolve, Math.min(20, Math.max(1, deadline - Date.now()))));
      }
    }
    const lockRecord = JSON.stringify({
      lock_id: randomUUID(),
      pid: process.pid,
      hostname: os.hostname(),
      started_at: new Date().toISOString(),
    });
    let identity;
    try {
      await handle.writeFile(lockRecord);
      identity = await handle.stat();
      return await operation();
    } finally {
      await handle.close().catch(() => {});
      const current = await fs.lstat(lockPath).catch(() => null);
      const stableIdentity = identity && Number.isFinite(identity.ino) && identity.ino !== 0;
      if (
        current?.isFile() &&
        !current.isSymbolicLink() &&
        (!stableIdentity || (current.dev === identity.dev && current.ino === identity.ino))
      ) {
        const currentRecord = await fs.readFile(lockPath, 'utf8').catch(() => null);
        if (currentRecord === lockRecord) await fs.rm(lockPath, { force: true }).catch(() => {});
      }
    }
  }
}

function decodeGoals(serialized) {
  const document = JSON.parse(serialized);
  PERSISTENCE_SCHEMA_REGISTRY.assertVersion('goals', document?.schema_version);
  if (document.schema_version !== GOALS_SCHEMA_VERSION || !Array.isArray(document.goals))
    throw new Error('Goals file has an unsupported schema');
  if (document.goals.length > MAX_GOALS) throw new Error('Goals file exceeds its entry limit');
  for (const goal of document.goals) {
    if (!goal.id || !goal.title || !STATUS.has(goal.status)) throw new Error('Goals file contains an invalid entry');
    goal.progress ||= [];
    if (!Array.isArray(goal.progress) || goal.progress.length > MAX_PROGRESS_ENTRIES)
      throw new Error('Goals file contains invalid progress entries');
    for (const entry of goal.progress)
      if (
        !entry ||
        typeof entry.id !== 'string' ||
        typeof entry.text !== 'string' ||
        !entry.text ||
        entry.text.length > 2_000 ||
        typeof entry.reference !== 'string' ||
        entry.reference.length > 1_000 ||
        entry.source !== 'user' ||
        !Number.isFinite(Date.parse(entry.created_at)) ||
        (entry.updated_at !== undefined && !Number.isFinite(Date.parse(entry.updated_at)))
      )
        throw new Error('Goals file contains an invalid progress entry');
  }
  return document;
}

export function validateGoalsExport(document) {
  let versionError;
  try {
    PERSISTENCE_SCHEMA_REGISTRY.assertVersion('goals_export', document?.format_version);
  } catch (error) {
    versionError = error;
  }
  if (
    !document ||
    typeof document !== 'object' ||
    Array.isArray(document) ||
    document.format !== 'xyst-goals' ||
    versionError ||
    !Array.isArray(document.goals) ||
    document.goals.length > MAX_GOALS ||
    (document.exported_at !== undefined && !Number.isFinite(Date.parse(document.exported_at))) ||
    Buffer.byteLength(JSON.stringify(document), 'utf8') > MAX_GOAL_FILE_BYTES
  )
    throw Object.assign(new Error('Project goals export is invalid or exceeds its limit'), { code: 'INVALID_GOALS_EXPORT' });
  const ids = new Set();
  for (const goal of document.goals) {
    if (
      !goal ||
      typeof goal !== 'object' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(goal.id || '') ||
      ids.has(goal.id) ||
      typeof goal.title !== 'string' ||
      !goal.title.trim() ||
      goal.title.length > 500 ||
      typeof (goal.details ?? '') !== 'string' ||
      (goal.details || '').length > 10_000 ||
      !STATUS.has(goal.status) ||
      !Number.isFinite(Date.parse(goal.created_at)) ||
      !Number.isFinite(Date.parse(goal.updated_at)) ||
      !Array.isArray(goal.progress) ||
      goal.progress.length > MAX_PROGRESS_ENTRIES
    )
      throw Object.assign(new Error('Project goals export contains an invalid goal'), { code: 'INVALID_GOALS_EXPORT' });
    ids.add(goal.id);
    const progressIds = new Set();
    for (const entry of goal.progress) {
      if (
        !entry ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entry.id || '') ||
        progressIds.has(entry.id) ||
        typeof entry.text !== 'string' ||
        !entry.text.trim() ||
        entry.text.length > 2_000 ||
        typeof (entry.reference ?? '') !== 'string' ||
        (entry.reference || '').length > 1_000 ||
        entry.source !== 'user' ||
        !Number.isFinite(Date.parse(entry.created_at)) ||
        (entry.updated_at !== undefined && !Number.isFinite(Date.parse(entry.updated_at)))
      )
        throw Object.assign(new Error('Project goals export contains invalid progress'), { code: 'INVALID_GOALS_EXPORT' });
      progressIds.add(entry.id);
    }
  }
}

function redactGoalRecords(goals) {
  return goals.map((goal) => ({
    id: goal.id,
    title: redactSecrets(goal.title.trim()),
    details: redactSecrets((goal.details || '').trim()),
    progress: goal.progress.map((entry) => ({
      id: entry.id,
      text: redactSecrets(entry.text.trim()),
      reference: redactSecrets((entry.reference || '').trim()),
      source: 'user',
      created_at: entry.created_at,
      ...(entry.updated_at ? { updated_at: entry.updated_at } : {}),
    })),
    status: goal.status,
    created_at: goal.created_at,
    updated_at: goal.updated_at,
  }));
}

async function resolveAgentDirectory(workspaceRoot, { create = false } = {}) {
  const realWorkspace = await fs.realpath(workspaceRoot);
  const directory = path.join(realWorkspace, '.agent');
  try {
    await fs.lstat(directory);
  } catch (error) {
    if (error.code !== 'ENOENT' || !create) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    await fs.mkdir(directory, { mode: 0o700 });
  }
  const info = await fs.lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw Object.assign(new Error('Project goals directory must be a real directory inside the workspace'), { code: 'GOAL_PATH_UNSAFE' });
  const realDirectory = await fs.realpath(directory);
  const samePath = process.platform === 'win32' ? realDirectory.toLowerCase() === directory.toLowerCase() : realDirectory === directory;
  if (!samePath) throw Object.assign(new Error('Project goals directory resolves outside the workspace'), { code: 'GOAL_PATH_UNSAFE' });
  return realDirectory;
}

async function readBoundedGoalFile(filePath) {
  const initial = await fs.lstat(filePath);
  if (initial.isSymbolicLink() || !initial.isFile())
    throw Object.assign(new Error('Project goals must be a regular non-symbolic-link file'), { code: 'GOAL_PATH_UNSAFE' });
  if (initial.size > MAX_GOAL_FILE_BYTES)
    throw Object.assign(new Error(`Project goals exceed the ${MAX_GOAL_FILE_BYTES}-byte file limit`), { code: 'GOAL_LIMIT' });
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.dev !== initial.dev || info.ino !== initial.ino || info.size !== initial.size)
      throw Object.assign(new Error('Project goals changed while being opened'), { code: 'GOAL_PATH_UNSAFE' });
    const buffer = Buffer.allocUnsafe(initial.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== initial.size) throw Object.assign(new Error('Project goals changed while being read'), { code: 'GOAL_CHANGED' });
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } finally {
    await handle.close();
  }
}
