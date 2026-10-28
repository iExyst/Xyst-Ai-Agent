import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { atomicWriteJson, restoreAtomicWriteBackup } from '../platform/files.mjs';
import { isSensitivePath, redactSecrets, redactStructuredSecrets } from '../platform/redaction.mjs';
import { captureProcessIdentity, verifyProcessIdentity } from '../platform/process-identity.mjs';
import { inspectWorktreeLocks, listWorktrees, recoverWorktreeLock } from '../platform/worktrees.mjs';
import { runProcess, safeProcessEnvironment } from '../platform/process.mjs';

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const MAX_SUBAGENT_TASKS = 500;
const MAX_TASK_STORE_BYTES = 16 * 1024 * 1024;
const RETRYABLE_TASK_STATUSES = new Set(['stopped', 'failed', 'cancelled', 'timed_out']);
let currentProcessIdentityPromise = null;

function getCurrentProcessIdentity() {
  if (!currentProcessIdentityPromise) {
    currentProcessIdentityPromise = captureProcessIdentity(process.pid).then((identity) => {
      if (!identity) currentProcessIdentityPromise = null;
      return identity;
    });
  }
  return currentProcessIdentityPromise;
}

/** Persistent task history plus fail-closed cross-process execution slots. */
export class SubagentTaskStore {
  constructor(stateRoot, { maxConcurrent = 2, lockWaitMs = 10_000 } = {}) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8)
      throw new TypeError('maxConcurrent must be between 1 and 8');
    this.stateRoot = stateRoot;
    this.directory = path.join(stateRoot, '.agent', 'subagents');
    this.file = path.join(this.directory, 'tasks.json');
    this.mutationLock = path.join(this.directory, 'tasks.lock');
    this.maxConcurrent = maxConcurrent;
    this.lockWaitMs = lockWaitMs;
    this.activeCancellations = new Map();
  }

  async list({ limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new TypeError('limit must be between 1 and 500');
    return (await this.#readLocked()).tasks
      .slice(-limit)
      .reverse()
      .map((task) => structuredClone(task));
  }

  async read(id) {
    if (!ID_PATTERN.test(id || '')) throw new TypeError('Invalid subagent task ID');
    return (await this.#readLocked()).tasks.find((task) => task.id === id) || null;
  }

  registerActiveCancellation(id, cancel) {
    if (!ID_PATTERN.test(id || '')) throw new TypeError('Invalid subagent task ID');
    if (typeof cancel !== 'function') throw new TypeError('cancel must be a function');
    if (this.activeCancellations.has(id))
      throw Object.assign(new Error('Subagent task already has an active cancellation handler'), { code: 'SUBAGENT_ALREADY_ACTIVE' });
    this.activeCancellations.set(id, cancel);
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      if (this.activeCancellations.get(id) === cancel) this.activeCancellations.delete(id);
    };
  }

  async requestCancellation(id) {
    if (!ID_PATTERN.test(id || '')) throw new TypeError('Invalid subagent task ID');
    const task = await this.read(id);
    if (!task) return { accepted: false, reason: 'not_found' };
    if (!['starting', 'running'].includes(task.status)) return { accepted: false, reason: 'not_running', task };
    const cancel = this.activeCancellations.get(id);
    if (!cancel) return { accepted: false, reason: 'not_active_here', task };
    const requested = cancel(Object.assign(new Error('Subagent task cancellation was requested'), { code: 'CANCELLED' }));
    if (requested === 'finished') return { accepted: false, reason: 'not_running', task };
    return { accepted: true, already_requested: requested === false, task };
  }

  async create({ parentSessionId, task, retryOf = null }) {
    if (retryOf !== null && !ID_PATTERN.test(retryOf || '')) throw new TypeError('Invalid source subagent task ID');
    const now = new Date().toISOString();
    const owner = {
      pid: process.pid,
      hostname: os.hostname(),
      process_identity: await getCurrentProcessIdentity(),
    };
    const record = {
      id: randomUUID(),
      status: 'starting',
      task: redactSecrets(task).slice(0, 5000),
      attempt: 1,
      parent_session_id: parentSessionId,
      child_session_id: null,
      worktree_id: null,
      branch: null,
      worktree_path: null,
      result: null,
      changed_paths: [],
      usage: null,
      error: null,
      created_at: now,
      started_at: null,
      completed_at: null,
      owner,
    };
    await this.#mutate((state) => {
      let retryRootId = null;
      let taskById = null;
      if (retryOf) {
        taskById = new Map(state.tasks.map((item) => [item.id, item]));
        const previous = taskById.get(retryOf);
        if (!previous) throw Object.assign(new Error('Subagent task to retry was not found'), { code: 'NOT_FOUND' });
        if (previous.parent_session_id !== parentSessionId)
          throw Object.assign(new Error('Subagent task belongs to another parent session'), { code: 'SUBAGENT_PARENT_MISMATCH' });
        if (!RETRYABLE_TASK_STATUSES.has(previous.status))
          throw Object.assign(new Error('Only stopped, failed, cancelled, or timed-out subagent tasks can be retried'), {
            code: 'SUBAGENT_NOT_RETRYABLE',
          });
        retryRootId = retryRoot(previous, taskById);
        if (state.tasks.some((item) => ['starting', 'running'].includes(item.status) && retryRoot(item, taskById) === retryRootId))
          throw Object.assign(new Error('A retry for this subagent task is already active'), { code: 'SUBAGENT_RETRY_ACTIVE' });
        const attempts = state.tasks
          .filter((item) => retryRoot(item, taskById) === retryRootId)
          .map((item) => (Number.isSafeInteger(item.attempt) && item.attempt > 0 ? item.attempt : 1));
        record.attempt = Math.max(1, ...attempts) + 1;
        record.retry_of = previous.id;
      }
      if (state.tasks.length >= MAX_SUBAGENT_TASKS) {
        state.tasks = state.tasks.filter(
          (item) =>
            ['starting', 'running'].includes(item.status) ||
            Date.now() - Date.parse(item.created_at) < 30 * 24 * 60 * 60 * 1000 ||
            (retryRootId !== null && retryRoot(item, taskById) === retryRootId),
        );
      }
      if (state.tasks.length >= MAX_SUBAGENT_TASKS)
        throw Object.assign(new Error(`Subagent task history is full (${MAX_SUBAGENT_TASKS}); remove old task records before continuing`), {
          code: 'SUBAGENT_TASK_LIMIT',
        });
      state.tasks.push(record);
    });
    return structuredClone(record);
  }

  async update(id, patch) {
    if (!ID_PATTERN.test(id || '') || !patch || typeof patch !== 'object' || Array.isArray(patch))
      throw new TypeError('Invalid subagent task update');
    let updated;
    await this.#mutate((state) => {
      const task = state.tasks.find((item) => item.id === id);
      if (!task) throw Object.assign(new Error(`Subagent task ${id} was not found`), { code: 'NOT_FOUND' });
      Object.assign(task, sanitizePatch(patch));
      updated = structuredClone(task);
    });
    return updated;
  }

  /** Find unfinished tasks whose owning OS process is verifiably gone, without mutating state. */
  async inspectInterrupted({ verifyIdentity = verifyProcessIdentity } = {}) {
    const tasks = (await this.#readLocked()).tasks;
    const result = [];
    for (const task of tasks) {
      if (!['starting', 'running'].includes(task.status)) continue;
      const owner = task.owner;
      let ownerState = 'unverifiable';
      if (isValidOwner(owner) && owner.hostname !== os.hostname()) ownerState = 'remote_owner';
      else if (isValidOwner(owner) && owner.process_identity.platform !== process.platform) ownerState = 'identity_platform_mismatch';
      else if (isValidOwner(owner)) {
        const state = await verifyIdentity(owner.process_identity);
        ownerState = state === 'match' ? 'active' : state === 'absent' || state === 'mismatch' ? 'interrupted' : 'unverifiable';
      }
      result.push({
        id: task.id,
        status: task.status,
        owner_state: ownerState,
        worktree_id: task.worktree_id || null,
        started_at: task.started_at || task.created_at,
      });
    }
    return result;
  }

  /** Mark one task interrupted only after same-host process identity proves its owner is gone. */
  async recoverInterrupted(id, { verifyIdentity = verifyProcessIdentity, workspaceRoot = this.stateRoot } = {}) {
    const inspected = (await this.inspectInterrupted({ verifyIdentity })).find((item) => item.id === id);
    if (!inspected) return { id, recovered: false, reason: 'not_unfinished' };
    if (inspected.owner_state !== 'interrupted')
      throw Object.assign(new Error(`Subagent task owner is ${inspected.owner_state}; refusing recovery`), {
        code: 'SUBAGENT_OWNER_UNVERIFIABLE',
      });
    await this.#recoverSlot(id, verifyIdentity);
    const task = await this.read(id);
    if (task?.worktree_id) {
      try {
        await recoverWorktreeLock(workspaceRoot, task.worktree_id, { verifyIdentity });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    const updated = await this.update(id, {
      status: 'failed',
      error: 'Subagent task was interrupted because its owning process is no longer running.',
      completed_at: new Date().toISOString(),
    });
    return { id, recovered: true, task: updated };
  }

  async recoverInterruptedTasks({ verifyIdentity = verifyProcessIdentity, workspaceRoot = this.stateRoot } = {}) {
    const candidates = (await this.inspectInterrupted({ verifyIdentity })).filter((item) => item.owner_state === 'interrupted');
    const recovered = [];
    for (const candidate of candidates) recovered.push(await this.recoverInterrupted(candidate.id, { verifyIdentity, workspaceRoot }));
    return recovered;
  }

  /** Report managed worktrees that have no task record, without changing Git or lock state. */
  async inspectOrphanedWorktrees({ workspaceRoot = this.stateRoot, signal } = {}) {
    const [worktrees, tasks, locks] = await Promise.all([
      listWorktrees(workspaceRoot, { signal }),
      this.#readLocked().then((state) => state.tasks),
      inspectWorktreeLocks(workspaceRoot),
    ]);
    const linkedWorktrees = new Set(tasks.map((task) => task.worktree_id).filter(Boolean));
    const lockById = new Map(locks.map((lock) => [lock.id, lock]));
    const orphans = [];
    for (const worktree of worktrees) {
      if (linkedWorktrees.has(worktree.id)) continue;
      const result = await runProcess(
        'git',
        [
          '-c',
          'core.fsmonitor=false',
          '-C',
          worktree.path,
          'status',
          '--porcelain=v1',
          '-z',
          '--untracked-files=all',
          '--ignored=matching',
        ],
        {
          cwd: worktree.path,
          env: { ...safeProcessEnvironment(process.env), GIT_OPTIONAL_LOCKS: '0' },
          signal,
          timeoutMs: 15_000,
          maxOutputBytes: 128 * 1024,
        },
      );
      if (result.exitCode !== 0) throw new Error('Could not inspect a managed subagent worktree');
      const changedPaths = parseChangedPaths(result.stdout);
      const lockState = lockById.get(worktree.id)?.state || 'unlocked';
      const suggestedAction =
        lockState === 'active'
          ? 'preserve_active'
          : lockState === 'stale'
            ? 'recover_stale_lock_then_review'
            : lockState !== 'unlocked'
              ? 'manual_review'
              : changedPaths.dirty
                ? 'preserve_for_review'
                : 'review_before_removal';
      orphans.push({
        ...worktree,
        lock_state: lockState,
        dirty: changedPaths.dirty,
        changed_paths: changedPaths.paths,
        suggested_action: suggestedAction,
      });
    }
    return orphans;
  }

  async acquireSlot(taskId, { signal } = {}) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + this.lockWaitMs;
    while (Date.now() <= deadline) {
      if (signal?.aborted) throw signal.reason || new Error('Subagent task was cancelled');
      for (let slot = 0; slot < this.maxConcurrent; slot += 1) {
        const lockPath = path.join(this.directory, `slot-${slot}.lock`);
        let handle;
        try {
          handle = await fs.open(lockPath, 'wx', 0o600);
        } catch (error) {
          if (error.code === 'EEXIST') continue;
          throw error;
        }
        const lockToken = randomUUID();
        try {
          await handle.writeFile(
            JSON.stringify({
              schema_version: 1,
              lock_token: lockToken,
              pid: process.pid,
              hostname: os.hostname(),
              task_id: taskId,
              started_at: new Date().toISOString(),
              process_identity: await getCurrentProcessIdentity(),
            }),
          );
          await handle.sync();
          let released = false;
          return async () => {
            if (released) return;
            released = true;
            const openedInfo = await handle.stat().catch(() => null);
            await handle.close().catch(() => {});
            if (!openedInfo) return;
            const currentInfo = await fs.lstat(lockPath).catch(() => null);
            if (!currentInfo?.isFile() || currentInfo.isSymbolicLink() || !sameFileIdentity(openedInfo, currentInfo)) return;
            let currentRecord;
            try {
              currentRecord = JSON.parse(await fs.readFile(lockPath, 'utf8'));
            } catch {
              return;
            }
            if (currentRecord.lock_token === lockToken) await fs.rm(lockPath).catch(() => {});
          };
        } catch (error) {
          const openedInfo = await handle.stat().catch(() => null);
          await handle.close().catch(() => {});
          if (openedInfo) {
            const currentInfo = await fs.lstat(lockPath).catch(() => null);
            if (currentInfo?.isFile() && !currentInfo.isSymbolicLink() && sameFileIdentity(openedInfo, currentInfo)) {
              try {
                const currentRecord = JSON.parse(await fs.readFile(lockPath, 'utf8'));
                if (currentRecord.lock_token === lockToken) await fs.rm(lockPath).catch(() => {});
              } catch {
                // Keep the path when ownership cannot be confirmed.
              }
            }
          }
          throw error;
        }
      }
      await new Promise((resolve, reject) => {
        const finish = (callback, value) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          callback(value);
        };
        const timer = setTimeout(() => finish(resolve), 50);
        const onAbort = () => finish(reject, signal.reason || new Error('Subagent task was cancelled'));
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    }
    throw Object.assign(new Error('All configured subagent execution slots are in use'), { code: 'SUBAGENT_CAPACITY' });
  }

  async #recoverSlot(taskId, verifyIdentity) {
    const names = (await fs.readdir(this.directory).catch((error) => (error.code === 'ENOENT' ? [] : Promise.reject(error)))).filter(
      (name) => /^slot-\d+\.lock$/.test(name),
    );
    for (const name of names) {
      const lockPath = path.join(this.directory, name);
      const info = await fs.lstat(lockPath).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
      if (!info) continue;
      if (info.isSymbolicLink() || !info.isFile() || info.size > 4_096)
        throw Object.assign(new Error('Subagent slot lock is unsafe; refusing task recovery'), { code: 'SUBAGENT_SLOT_UNSAFE' });
      let record;
      try {
        record = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      } catch {
        throw Object.assign(new Error('Subagent slot lock is unreadable; refusing task recovery'), { code: 'SUBAGENT_SLOT_UNVERIFIABLE' });
      }
      if (record.task_id !== taskId) continue;
      if (!isValidSlotRecord(record) || record.hostname !== os.hostname() || record.process_identity.platform !== process.platform)
        throw Object.assign(new Error('Subagent slot owner cannot be verified; refusing task recovery'), {
          code: 'SUBAGENT_SLOT_UNVERIFIABLE',
        });
      const state = await verifyIdentity(record.process_identity);
      if (!['absent', 'mismatch'].includes(state))
        throw Object.assign(new Error(`Subagent slot owner is ${state}; refusing task recovery`), { code: 'SUBAGENT_SLOT_ACTIVE' });
      const currentInfo = await fs.lstat(lockPath);
      if (!sameFileIdentity(info, currentInfo))
        throw Object.assign(new Error('Subagent slot changed during recovery; retry'), { code: 'SUBAGENT_SLOT_CHANGED' });
      const currentRecord = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      if (currentRecord.lock_token !== record.lock_token)
        throw Object.assign(new Error('Subagent slot owner changed during recovery; retry'), { code: 'SUBAGENT_SLOT_CHANGED' });
      await fs.rm(lockPath);
    }
  }

  async #read() {
    try {
      return decodeTaskStore(await fs.readFile(this.file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') {
        return (
          (await restoreAtomicWriteBackup(this.file, { maxBytes: MAX_TASK_STORE_BYTES, decode: decodeTaskStore })) ?? {
            version: 1,
            tasks: [],
          }
        );
      }
      throw error;
    }
  }

  async #readLocked() {
    return this.#mutate((state) => structuredClone(state), { persist: false });
  }

  async #mutate(change, { persist = true } = {}) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + this.lockWaitMs;
    let handle;
    let lockToken;
    while (!handle && Date.now() <= deadline) {
      try {
        handle = await fs.open(this.mutationLock, 'wx', 0o600);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await this.#recoverMutationLock();
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    if (!handle) throw Object.assign(new Error('Timed out waiting for subagent task store lock'), { code: 'SUBAGENT_STORE_LOCKED' });
    try {
      lockToken = randomUUID();
      await handle.writeFile(
        JSON.stringify({
          schema_version: 1,
          lock_token: lockToken,
          pid: process.pid,
          hostname: os.hostname(),
          started_at: new Date().toISOString(),
          process_identity: await getCurrentProcessIdentity(),
        }),
      );
      await handle.sync();
      const state = await this.#read();
      const result = change(state);
      if (persist) await atomicWriteJson(this.file, state, { mode: 0o600 });
      return result;
    } finally {
      const openedInfo = await handle.stat().catch(() => null);
      await handle.close().catch(() => {});
      if (openedInfo) {
        const currentInfo = await fs.lstat(this.mutationLock).catch(() => null);
        if (currentInfo?.isFile() && !currentInfo.isSymbolicLink() && sameFileIdentity(openedInfo, currentInfo)) {
          let currentRecord;
          try {
            currentRecord = JSON.parse(await fs.readFile(this.mutationLock, 'utf8'));
          } catch {
            currentRecord = null;
          }
          if (currentRecord?.lock_token === lockToken) await fs.rm(this.mutationLock).catch(() => {});
        }
      }
    }
  }

  async #recoverMutationLock() {
    const lockPath = this.mutationLock;
    const info = await fs.lstat(lockPath).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
    if (!info || info.isSymbolicLink() || !info.isFile() || info.size > 4_096) return false;
    let record;
    try {
      record = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    } catch {
      return false;
    }
    if (!isValidOwnerLockRecord(record) || record.hostname !== os.hostname()) return false;
    if (record.process_identity.platform !== process.platform) return false;
    const state = await verifyProcessIdentity(record.process_identity);
    if (!['absent', 'mismatch'].includes(state)) return false;
    const currentInfo = await fs.lstat(lockPath).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
    if (!currentInfo || !sameFileIdentity(info, currentInfo)) return false;
    const currentRecord = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    if (currentRecord.lock_token !== record.lock_token) return false;
    await fs.rm(lockPath);
    return true;
  }
}

function decodeTaskStore(serialized) {
  const state = JSON.parse(serialized);
  if (state.version !== 1 || !Array.isArray(state.tasks) || state.tasks.length > MAX_SUBAGENT_TASKS)
    throw new Error('Subagent task store is invalid');
  return state;
}

function sanitizePatch(patch) {
  const allowed = new Set([
    'status',
    'child_session_id',
    'worktree_id',
    'branch',
    'worktree_path',
    'result',
    'changed_paths',
    'usage',
    'error',
    'started_at',
    'completed_at',
  ]);
  if (Object.keys(patch).some((key) => !allowed.has(key))) throw new TypeError('Subagent task update contains an unsupported field');
  const safe = redactStructuredSecrets(structuredClone(patch));
  if (
    safe.status !== undefined &&
    !['starting', 'running', 'complete', 'stopped', 'failed', 'cancelled', 'timed_out'].includes(safe.status)
  )
    throw new TypeError('Invalid subagent task status');
  for (const key of ['child_session_id', 'worktree_id'])
    if (safe[key] !== undefined && safe[key] !== null && (typeof safe[key] !== 'string' || !ID_PATTERN.test(safe[key])))
      throw new TypeError(`${key} must be a UUID or null`);
  if (safe.branch !== undefined && safe.branch !== null && (typeof safe.branch !== 'string' || safe.branch.length > 200))
    throw new TypeError('branch must be a short string or null');
  if (safe.worktree_path !== undefined && safe.worktree_path !== null && typeof safe.worktree_path !== 'string')
    throw new TypeError('worktree_path must be a string or null');
  if (typeof safe.result === 'string') safe.result = redactSecrets(safe.result).slice(0, 20_000);
  if (typeof safe.error === 'string') safe.error = redactSecrets(safe.error).slice(0, 2000);
  if (Array.isArray(safe.changed_paths)) safe.changed_paths = safe.changed_paths.filter((item) => typeof item === 'string').slice(0, 500);
  if (safe.usage !== undefined && safe.usage !== null) {
    const usage = safe.usage;
    if (
      !usage ||
      typeof usage !== 'object' ||
      Array.isArray(usage) ||
      !Number.isSafeInteger(usage.input_tokens) ||
      usage.input_tokens < 0 ||
      !Number.isSafeInteger(usage.output_tokens) ||
      usage.output_tokens < 0 ||
      (usage.estimated_cost !== null && (!Number.isFinite(usage.estimated_cost) || usage.estimated_cost < 0)) ||
      Object.keys(usage).some((key) => !['input_tokens', 'output_tokens', 'estimated_cost'].includes(key))
    )
      throw new TypeError('usage must contain non-negative input/output token counts and a non-negative cost or null');
    safe.usage = {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      estimated_cost: usage.estimated_cost,
    };
  }
  return safe;
}

function retryRoot(task, taskById) {
  let current = task;
  const visited = new Set([current.id]);
  while (ID_PATTERN.test(current.retry_of || '')) {
    const previous = taskById.get(current.retry_of);
    if (!previous || visited.has(previous.id)) break;
    current = previous;
    visited.add(current.id);
  }
  return current.id;
}

function parseChangedPaths(output) {
  const entries = output.split('\0').filter(Boolean);
  const paths = [];
  let dirty = false;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    dirty = true;
    const status = entry.slice(0, 2);
    const relativePath = entry.slice(3);
    if (relativePath && !isSensitivePath(relativePath)) paths.push(relativePath);
    if (/[RC]/.test(status) && index + 1 < entries.length) {
      const originalPath = entries[++index];
      if (originalPath && !isSensitivePath(originalPath)) paths.push(originalPath);
    }
  }
  return { dirty, paths: [...new Set(paths)].slice(0, 500) };
}

function isValidOwner(owner) {
  return Boolean(
    owner &&
      Number.isInteger(owner.pid) &&
      owner.pid > 0 &&
      typeof owner.hostname === 'string' &&
      isValidProcessIdentity(owner.process_identity, owner.pid),
  );
}

function isValidSlotRecord(record) {
  return Boolean(isValidOwnerLockRecord(record) && ID_PATTERN.test(record.task_id || ''));
}

function isValidOwnerLockRecord(record) {
  return Boolean(
    record &&
      record.schema_version === 1 &&
      /^[0-9a-f-]{36}$/i.test(record.lock_token || '') &&
      Number.isInteger(record.pid) &&
      record.pid > 0 &&
      typeof record.hostname === 'string' &&
      isValidProcessIdentity(record.process_identity, record.pid) &&
      Number.isFinite(Date.parse(record.started_at)),
  );
}

function isValidProcessIdentity(identity, pid) {
  if (!identity || identity.pid !== pid) return false;
  if (identity.platform === 'linux')
    return (
      /^[0-9a-f-]{16,64}$/i.test(identity.boot_id || '') &&
      /^\d+$/.test(identity.start_ticks || '') &&
      /^[0-9a-f]{64}$/i.test(identity.command_hash || '')
    );
  if (identity.platform === 'win32') return /^\d+$/.test(identity.creation_time || '') && /^[0-9a-f]{64}$/i.test(identity.image_hash || '');
  return false;
}

function sameFileIdentity(first, second) {
  return first.dev === second.dev && first.ino === second.ino;
}
