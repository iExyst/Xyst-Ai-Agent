import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteFile } from './files.mjs';
import { safeProcessEnvironment, terminateProcessTree } from './process.mjs';
import { findBubblewrap, buildBubblewrapArgs, validateBubblewrapWorkspace } from './sandbox.mjs';
import { waitForBubblewrapStart } from './bubblewrap-status.mjs';
import { redactSecrets } from './redaction.mjs';
import { resolveToolPath } from './paths.mjs';
import {
  captureProcessIdentity,
  terminateVerifiedLinuxProcessGroup,
  terminateVerifiedWindowsProcess,
  verifyProcessIdentity,
} from './process-identity.mjs';
import { isReadOnlySandbox, requiresProcessIsolation, resolveSandboxMode } from './sandbox-modes.mjs';

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PROCESSES = 100;
const MAX_PROCESS_RECORD_BYTES = 8 * 1024 * 1024;
const PROCESS_STATUSES = [
  'starting',
  'running',
  'stopping',
  'exited',
  'failed',
  'orphaned',
  'unmanaged',
  'recoverable',
  'identity_mismatch',
  'timed_out',
];

/** Persistent metadata and bounded live output for explicitly approved argv-only jobs. */
export class BackgroundProcessManager {
  constructor(workspaceRoot, config = {}) {
    if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)) throw new TypeError('workspaceRoot must be absolute');
    this.workspaceRoot = workspaceRoot;
    this.config = config;
    this.directory = path.join(workspaceRoot, '.agent', 'processes');
    this.records = new Map();
    this.children = new Map();
    this.writeChains = new Map();
    this.finishes = new Map();
    this.managerId = randomUUID();
    this.managerIdentity = null;
    this.managerIdentityPromise = null;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    const safeDirectory = await ensureSafeProcessDirectory(this.workspaceRoot, this.directory);
    this.directory = safeDirectory.path;
    await restoreProcessRecordBackups(this.workspaceRoot, this.directory, safeDirectory.info);
    const names = (await fs.readdir(this.directory)).filter((entry) => entry.endsWith('.json'));
    if (names.length) {
      this.managerIdentity = await captureProcessIdentity(process.pid).catch(() => null);
      this.managerIdentityPromise = Promise.resolve(this.managerIdentity);
    }
    for (const name of names) {
      const id = name.slice(0, -5);
      if (!ID_PATTERN.test(id)) continue;
      try {
        const record = await readSafeProcessRecord(this.workspaceRoot, this.directory, name);
        if (!isProcessRecordForId(record, id)) continue;
        if (['starting', 'running', 'stopping'].includes(record.status)) {
          const ownerStatus = await managerIdentityStatus(record);
          if (ownerStatus === 'match' || (ownerStatus === 'unavailable' && isProcessAlive(record.manager_pid))) {
            record.status = 'unmanaged';
            record.exit_reason = 'process_owned_by_another_manager_or_pid_identity_unverified';
          } else {
            classifyRecoveredRecord(record, await verifyProcessIdentity(record.process_identity));
            await this.#persist(record);
          }
        }
        this.records.set(id, record);
      } catch {
        /* corrupt job records are excluded from listing and reported by explicit id reads */
      }
    }
    this.initialized = true;
  }

  async start({ command, args = [], timeout_seconds = 3600, session_id = null, cwd = this.workspaceRoot, interactive = false } = {}) {
    await this.initialize();
    const unrestricted = this.config.tools?.autonomy === 'unrestricted';
    if (this.config.tools?.shell_enabled !== true && !unrestricted) throw new Error('Process execution is disabled');
    if (typeof command !== 'string' || !command.trim() || command.length > 2048 || /[\u0000-\u001f]/.test(command))
      throw new TypeError('command must be a valid executable name or path');
    if (
      !Array.isArray(args) ||
      args.length > 256 ||
      args.some((arg) => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\u0000'))
    )
      throw new TypeError('args must contain at most 256 strings of at most 8192 characters');
    if (
      !(unrestricted && timeout_seconds === null) &&
      (!Number.isInteger(timeout_seconds) || timeout_seconds < 1 || timeout_seconds > 86_400)
    )
      throw new TypeError('timeout_seconds must be between 1 and 86400');
    if (typeof interactive !== 'boolean') throw new TypeError('interactive must be a boolean');
    const sandboxMode = resolveSandboxMode(this.config, 'start_background_process');
    if (isReadOnlySandbox(this.config, 'start_background_process'))
      throw new Error('Background process execution is disabled by the read-only sandbox policy');
    if (session_id !== null && !ID_PATTERN.test(session_id)) throw new TypeError('session_id must be a UUID');
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new TypeError('cwd must be an absolute workspace path');
    const canonicalCwd = await resolveToolPath(this.workspaceRoot, cwd, {
      mustExist: true,
      machineScope: unrestricted || this.config.tools?.filesystem_scope === 'machine',
    });
    const relativeCwd = path.relative(await fs.realpath(this.workspaceRoot), canonicalCwd);
    if (
      !unrestricted &&
      this.config.tools?.filesystem_scope !== 'machine' &&
      (relativeCwd === '..' || relativeCwd.startsWith(`..${path.sep}`) || path.isAbsolute(relativeCwd))
    )
      throw new Error('Process working directory must remain inside the workspace');
    if (this.records.size >= MAX_PROCESSES)
      throw new Error(`Process record limit reached (${MAX_PROCESSES}); remove old records before starting another job`);

    const id = randomUUID();
    const now = new Date().toISOString();
    const record = {
      schema_version: 1,
      id,
      session_id,
      manager_id: this.managerId,
      manager_pid: process.pid,
      manager_identity: this.managerIdentity,
      process_identity: null,
      command: unrestricted ? command : redactSecrets(command),
      args: unrestricted ? args : args.map(redactSecrets),
      cwd: canonicalCwd,
      status: 'starting',
      pid: null,
      created_at: now,
      started_at: null,
      finished_at: null,
      timeout_seconds,
      exit_code: null,
      signal: null,
      exit_reason: null,
      stdout: '',
      stderr: '',
      output_truncated: false,
      interactive,
      sandbox: sandboxMode,
      sandboxed: false,
    };
    this.records.set(id, record);
    await this.#persist(record);

    let workspaceIdentityFailureToken = null;
    try {
      let executable = command;
      let executableArgs = args;
      const sandboxRequired = requiresProcessIsolation(sandboxMode);
      if (sandboxRequired) {
        if (process.platform !== 'linux')
          throw new Error(`Required process isolation is not implemented for ${process.platform}; refusing to run unsandboxed`);
        const bwrap = await findBubblewrap();
        if (!bwrap) throw new Error('Required process isolation needs a trusted system Bubblewrap executable; refusing to run unsandboxed');
        const sandboxWorkspace = await validateBubblewrapWorkspace(canonicalCwd, { includeIdentity: true });
        executable = bwrap;
        workspaceIdentityFailureToken = randomUUID();
        executableArgs = buildBubblewrapArgs({
          workspaceRoot: sandboxWorkspace.path,
          workspaceIdentity: sandboxWorkspace.identity,
          workspaceIdentityFailureToken,
          workspaceReadOnly: sandboxMode === 'workspace-read',
          command,
          args,
          bwrap,
        });
      }
      const child = spawn(executable, executableArgs, {
        cwd: sandboxRequired ? '/' : canonicalCwd,
        env: sandboxRequired ? {} : unrestricted ? process.env : safeProcessEnvironment(process.env),
        shell: false,
        windowsHide: true,
        detached: true,
        stdio: sandboxRequired
          ? [interactive ? 'pipe' : 'ignore', 'pipe', 'pipe', 'pipe']
          : [interactive ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
      this.children.set(id, child);
      child.stdout.on('data', (chunk) => this.#capture(record, 'stdout', chunk));
      child.stderr.on('data', (chunk) => this.#capture(record, 'stderr', chunk));
      const sandboxStart = sandboxRequired ? waitForBubblewrapStart(child) : null;
      child.stdout.unref?.();
      child.stderr.unref?.();
      child.stdin?.unref?.();
      const onError = (error) => {
        record.status = 'failed';
        record.exit_reason = error.code || 'spawn_failed';
        record.stderr = appendTail(
          record.stderr,
          this.config.tools?.autonomy === 'unrestricted' ? error.message : redactSecrets(error.message),
          this.#outputLimit(),
        );
        void this.#queueFinish(record);
      };
      child.once('error', onError);
      child.once('close', (code, signal) => {
        record.exit_code = code;
        record.signal = signal;
        const identityFailureMarker = workspaceIdentityFailureToken
          ? `XYST_WORKSPACE_IDENTITY_MISMATCH:${workspaceIdentityFailureToken}`
          : null;
        if (identityFailureMarker && record.stderr.includes(identityFailureMarker)) {
          record.stderr = record.stderr.replace(identityFailureMarker, 'Sandbox workspace changed during launch; command was not started');
          record.exit_reason = 'sandbox_workspace_changed';
        }
        if (record.status !== 'timed_out' && record.status !== 'stopping') record.status = code === 0 ? 'exited' : 'failed';
        if (record.status === 'stopping') record.status = 'exited';
        record.exit_reason ||= code === 0 ? 'completed' : signal ? 'terminated' : 'nonzero_exit';
        void this.#queueFinish(record);
      });
      record.pid = child.pid;
      record.started_at = new Date().toISOString();
      if (sandboxRequired) {
        const sandboxStarted = await sandboxStart;
        if (!sandboxStarted) {
          terminateProcessTree(child, 'force');
          throw Object.assign(new Error('Bubblewrap did not confirm that the background process entered its sandbox'), {
            code: 'SANDBOX_SETUP_FAILED',
          });
        }
        record.sandboxed = true;
        child.stdio[3]?.unref?.();
      }
      if (record.status === 'starting') record.status = 'running';
      await this.#persist(record);
      child.unref();
      void Promise.all([captureProcessIdentity(child.pid).catch(() => null), this.#ensureManagerIdentity()])
        .then(async ([processIdentity, managerIdentity]) => {
          if (this.records.get(record.id) !== record) return;
          if (processIdentity) record.process_identity = processIdentity;
          if (managerIdentity) record.manager_identity = managerIdentity;
          await this.#persist(record);
        })
        .catch(() => {});
      if (timeout_seconds !== null) {
        const timer = setTimeout(() => {
          if (record.status !== 'running') return;
          record.status = 'timed_out';
          record.exit_reason = 'timeout';
          terminateProcessTree(child, 'force');
          void this.#persist(record);
        }, timeout_seconds * 1000);
        timer.unref?.();
        child.once('close', () => clearTimeout(timer));
      }
      return publicRecord(record);
    } catch (error) {
      record.status = 'failed';
      record.exit_reason = error.code || 'spawn_failed';
      record.finished_at = new Date().toISOString();
      await this.#persist(record);
      throw error;
    }
  }

  async list({ session_id = null, limit = 100 } = {}) {
    await this.initialize();
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PROCESSES) throw new TypeError(`limit must be between 1 and ${MAX_PROCESSES}`);
    for (const record of this.records.values())
      if (['unmanaged', 'recoverable'].includes(record.status)) await this.#refreshUnmanaged(record);
    return [...this.records.values()]
      .filter((record) => session_id === null || record.session_id === session_id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map(publicRecord);
  }

  async read(id, { session_id = null } = {}) {
    const record = await this.#get(id);
    assertSessionScope(record, session_id);
    return { ...publicRecord(record), stdout: record.stdout, stderr: record.stderr, output_truncated: record.output_truncated };
  }

  async writeInput(id, input, { session_id = null } = {}) {
    if (typeof input !== 'string' || Buffer.byteLength(input) > 65_536)
      throw new TypeError('input must be a string of at most 65536 bytes');
    const record = await this.#get(id);
    assertSessionScope(record, session_id);
    if (!record.interactive)
      throw Object.assign(new Error('Process was not started with interactive input enabled'), { code: 'PROCESS_INPUT_DISABLED' });
    if (record.status !== 'running')
      throw Object.assign(new Error(`Process is ${record.status}; input is only accepted while running`), { code: 'PROCESS_NOT_RUNNING' });
    const child = this.children.get(id);
    if (!child?.stdin || child.stdin.destroyed || child.stdin.writableEnded)
      throw Object.assign(new Error('Process input stream is no longer available'), { code: 'PROCESS_INPUT_CLOSED' });
    await writeProcessInput(child.stdin, input);
    return { id: record.id, bytes_written: Buffer.byteLength(input), status: record.status };
  }

  async stop(id, { session_id = null } = {}) {
    const record = await this.#get(id);
    assertSessionScope(record, session_id);
    if (record.status === 'orphaned')
      throw Object.assign(new Error('Process state is unknown after restart; verify and stop it through the operating system'), {
        code: 'PROCESS_STATE_UNKNOWN',
      });
    if (record.status === 'unmanaged')
      throw Object.assign(
        new Error('Process belongs to another manager or its PID identity is unverified; stop it through its owning service'),
        { code: 'PROCESS_OWNER_UNAVAILABLE' },
      );
    if (record.status === 'identity_mismatch')
      throw Object.assign(new Error('The recorded PID now belongs to a different process; it was not signaled'), {
        code: 'PROCESS_IDENTITY_MISMATCH',
      });
    if (record.status === 'recoverable') return this.#stopRecovered(record);
    const child = this.children.get(id);
    if (!child || !['starting', 'running'].includes(record.status)) return { ...publicRecord(record), stopped: false };
    record.status = 'stopping';
    record.exit_reason = 'user_requested';
    await this.#persist(record);
    terminateProcessTree(child, process.platform === 'win32' ? 'force' : 'graceful');
    if (!(await waitForChildClose(child, 1500))) {
      terminateProcessTree(child, 'force');
      if (!(await waitForChildClose(child, 1500)))
        throw Object.assign(new Error(`Process '${id}' did not exit after termination was requested`), { code: 'PROCESS_STOP_TIMEOUT' });
    }
    await this.finishes.get(id);
    return { ...publicRecord(record), stopped: true };
  }

  async settle() {
    await Promise.allSettled([...this.writeChains.values(), ...this.finishes.values()]);
  }

  async remove(id) {
    const record = await this.#get(id);
    if (record.status === 'orphaned')
      throw Object.assign(new Error('Process state is unknown after restart; inspect the OS process before removing its record'), {
        code: 'PROCESS_STATE_UNKNOWN',
      });
    if (record.status === 'unmanaged')
      throw Object.assign(new Error('Process is owned by another manager or has an unverified PID; its record cannot be removed'), {
        code: 'PROCESS_OWNER_UNAVAILABLE',
      });
    if (['starting', 'running', 'stopping', 'recoverable'].includes(record.status))
      throw Object.assign(new Error('A running process record cannot be removed'), { code: 'PROCESS_ACTIVE' });
    await this.writeChains.get(id)?.catch(() => {});
    const safeDirectory = await ensureSafeProcessDirectory(this.workspaceRoot, this.directory, { create: false });
    this.directory = safeDirectory.path;
    const file = path.join(this.directory, `${id}.json`);
    const fileInfo = await fs.lstat(file);
    assertSafeProcessRecord(fileInfo);
    await assertProcessDirectoryIdentity(this.directory, safeDirectory.info);
    this.children.delete(id);
    await fs.rm(file);
    this.records.delete(id);
    return { removed: true, id };
  }

  async #get(id) {
    await this.initialize();
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new TypeError('Process ID must be a UUID');
    let record = this.records.get(id);
    if (!record) throw Object.assign(new Error(`Process '${id}' was not found`), { code: 'PROCESS_NOT_FOUND' });
    if (['unmanaged', 'recoverable'].includes(record.status)) record = await this.#refreshUnmanaged(record);
    return record;
  }

  #ensureManagerIdentity() {
    if (this.managerIdentity) return Promise.resolve(this.managerIdentity);
    if (!this.managerIdentityPromise) {
      this.managerIdentityPromise = captureProcessIdentity(process.pid)
        .then((identity) => {
          this.managerIdentity = identity;
          return identity;
        })
        .catch(() => null);
    }
    return this.managerIdentityPromise;
  }

  async #refreshUnmanaged(record) {
    try {
      const current = JSON.parse(await fs.readFile(path.join(this.directory, `${record.id}.json`), 'utf8'));
      if (current.id !== record.id) return record;
      if (['starting', 'running', 'stopping'].includes(current.status)) {
        const ownerStatus = await managerIdentityStatus(current);
        if (ownerStatus === 'match' || (ownerStatus === 'unavailable' && isProcessAlive(current.manager_pid))) current.status = 'unmanaged';
        else {
          classifyRecoveredRecord(current, await verifyProcessIdentity(current.process_identity));
          await atomicWriteJson(path.join(this.directory, `${record.id}.json`), current, { mode: 0o600 });
        }
      }
      if (current.status === 'recoverable') {
        const result = await verifyProcessIdentity(current.process_identity);
        if (result !== 'match') {
          classifyRecoveredRecord(current, result);
          await atomicWriteJson(path.join(this.directory, `${record.id}.json`), current, { mode: 0o600 });
        }
      }
      this.records.set(record.id, current);
      return current;
    } catch {
      return record;
    }
  }

  async #stopRecovered(record) {
    const identityResult = await verifyProcessIdentity(record.process_identity);
    if (identityResult !== 'match') {
      classifyRecoveredRecord(record, identityResult);
      await this.#persist(record);
      if (record.status === 'identity_mismatch')
        throw Object.assign(new Error('The recorded PID now belongs to a different process; it was not signaled'), {
          code: 'PROCESS_IDENTITY_MISMATCH',
        });
      if (record.status === 'exited') return { ...publicRecord(record), stopped: false };
      throw Object.assign(new Error('Process identity could not be verified; the process was not signaled'), {
        code: 'PROCESS_STATE_UNKNOWN',
      });
    }
    if (process.platform === 'win32') {
      const outcome = await terminateVerifiedWindowsProcess(record.process_identity);
      if (outcome === 'mismatch') {
        classifyRecoveredRecord(record, 'mismatch');
        await this.#persist(record);
        throw Object.assign(new Error('The recorded PID now belongs to a different process; it was not signaled'), {
          code: 'PROCESS_IDENTITY_MISMATCH',
        });
      }
      if (outcome === 'absent') {
        classifyRecoveredRecord(record, 'absent');
        await this.#persist(record);
        return { ...publicRecord(record), stopped: false };
      }
      if (outcome !== 'terminated')
        throw Object.assign(new Error('Windows could not terminate the process through a verified process handle'), {
          code: 'PROCESS_STATE_UNKNOWN',
        });
    } else {
      const outcome = await terminateVerifiedLinuxProcessGroup(record.process_identity, 'SIGTERM');
      if (outcome === 'mismatch') {
        classifyRecoveredRecord(record, 'mismatch');
        await this.#persist(record);
        throw Object.assign(new Error('The recorded PID now belongs to a different process; it was not signaled'), {
          code: 'PROCESS_IDENTITY_MISMATCH',
        });
      }
      if (outcome === 'absent') {
        classifyRecoveredRecord(record, 'absent');
        await this.#persist(record);
        return { ...publicRecord(record), stopped: false };
      }
      if (outcome !== 'terminated')
        throw Object.assign(new Error('Linux could not signal the process group through a verified pidfd'), {
          code: 'PROCESS_STATE_UNKNOWN',
        });
    }
    let observed = await waitForRecoveredExit(record, 5_000);
    if (!['absent', 'mismatch'].includes(observed)) {
      if (process.platform === 'win32') {
        const outcome = await terminateVerifiedWindowsProcess(record.process_identity);
        if (outcome === 'mismatch') observed = 'mismatch';
        else if (outcome === 'absent') observed = 'absent';
        else if (outcome === 'unavailable')
          throw Object.assign(new Error('Windows could not re-verify the process for force termination'), {
            code: 'PROCESS_STATE_UNKNOWN',
          });
      } else {
        const outcome = await terminateVerifiedLinuxProcessGroup(record.process_identity, 'SIGKILL');
        if (outcome === 'mismatch') observed = 'mismatch';
        else if (outcome === 'absent') observed = 'absent';
        else if (outcome === 'unavailable')
          throw Object.assign(new Error('Linux could not re-verify the process group for force termination'), {
            code: 'PROCESS_STATE_UNKNOWN',
          });
      }
    }
    if (!['absent', 'mismatch'].includes(observed)) {
      observed = await waitForRecoveredExit(record, 5_000);
      if (!['absent', 'mismatch'].includes(observed))
        throw Object.assign(new Error(`Process '${record.id}' identity remained ${observed} after termination was requested`), {
          code: 'PROCESS_STOP_TIMEOUT',
        });
    }
    if (observed === 'mismatch') {
      classifyRecoveredRecord(record, 'mismatch');
      await this.#persist(record);
      throw Object.assign(new Error('The recorded PID changed identity during termination; it was not signaled again'), {
        code: 'PROCESS_IDENTITY_MISMATCH',
      });
    }
    record.status = 'exited';
    record.finished_at = new Date().toISOString();
    record.exit_reason = 'stopped_after_identity_verification';
    await this.#persist(record);
    return { ...publicRecord(record), stopped: true };
  }

  #outputLimit() {
    return Math.min(1_000_000, Math.max(1024, this.config.budgets?.max_tool_output_bytes || 100_000));
  }

  #capture(record, key, chunk) {
    const limit = Math.floor(this.#outputLimit() / 2);
    const current = Buffer.from(record[key]);
    const joined = Buffer.concat([current, chunk]);
    if (joined.length > limit) record.output_truncated = true;
    const output = joined.subarray(Math.max(0, joined.length - limit)).toString('utf8');
    record[key] = this.config.tools?.autonomy === 'unrestricted' ? output : redactSecrets(output);
    void this.#persist(record);
  }

  async #finish(record) {
    record.finished_at ||= new Date().toISOString();
    await this.#persist(record).catch(() => {});
    this.children.delete(record.id);
  }

  #queueFinish(record) {
    if (this.finishes.has(record.id)) return this.finishes.get(record.id);
    const finishing = this.#finish(record);
    this.finishes.set(record.id, finishing);
    void finishing.finally(() => {
      if (this.finishes.get(record.id) === finishing) this.finishes.delete(record.id);
    });
    return finishing;
  }

  async #persist(record) {
    const previous = this.writeChains.get(record.id) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        const serialized = `${JSON.stringify(record, null, 2)}\n`;
        if (Buffer.byteLength(serialized) > MAX_PROCESS_RECORD_BYTES)
          throw Object.assign(new Error('Background process record exceeds its size limit'), { code: 'PROCESS_RECORD_TOO_LARGE' });
        const safeDirectory = await ensureSafeProcessDirectory(this.workspaceRoot, this.directory);
        this.directory = safeDirectory.path;
        const destination = path.join(this.directory, `${record.id}.json`);
        await atomicWriteFile(destination, serialized, {
          mode: 0o600,
          beforeReplace: async () => {
            await assertProcessDirectoryIdentity(this.directory, safeDirectory.info);
            await assertSafeProcessDestination(destination);
          },
        });
      });
    this.writeChains.set(record.id, next);
    try {
      await next;
    } finally {
      if (this.writeChains.get(record.id) === next) this.writeChains.delete(record.id);
    }
  }
}

function publicRecord(record) {
  const { schema_version, stdout, stderr, process_identity, manager_identity, manager_id, manager_pid, ...summary } = record;
  return summary;
}

function appendTail(current, addition, maxBytes) {
  const joined = Buffer.from(current + addition);
  return joined.subarray(Math.max(0, joined.length - maxBytes)).toString('utf8');
}

function assertSessionScope(record, sessionId) {
  if (sessionId !== null && record.session_id !== sessionId)
    throw Object.assign(new Error('Process does not belong to this session'), { code: 'PROCESS_SCOPE_DENIED' });
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function managerIdentityStatus(record) {
  if (record.manager_identity) return verifyProcessIdentity(record.manager_identity);
  if (isProcessAlive(record.manager_pid)) return 'unavailable';
  return 'absent';
}

function classifyRecoveredRecord(record, identityStatus) {
  if (identityStatus === 'match') {
    record.status = 'recoverable';
    record.exit_reason = 'owner_exited_process_identity_verified';
    record.finished_at = null;
  } else if (identityStatus === 'absent') {
    record.status = 'exited';
    record.exit_reason = 'process_not_running_at_recovery';
    record.finished_at = new Date().toISOString();
  } else if (identityStatus === 'mismatch') {
    record.status = 'identity_mismatch';
    record.exit_reason = 'pid_reused_or_process_identity_changed';
    record.finished_at = new Date().toISOString();
  } else {
    record.status = 'orphaned';
    record.exit_reason = 'process_identity_unavailable_after_owner_exit';
    record.finished_at = null;
  }
}

async function waitForRecoveredExit(record, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastState = 'unavailable';
  while (Date.now() < deadline) {
    lastState = await verifyProcessIdentity(record.process_identity);
    if (lastState === 'absent' || lastState === 'mismatch') return lastState;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return lastState;
}

function waitForChildClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    const onClose = () => finish(true);
    const finish = (closed) => {
      clearTimeout(timer);
      child.off('close', onClose);
      resolve(closed);
    };
    child.once('close', onClose);
  });
}

async function ensureSafeProcessDirectory(workspaceRoot, targetDirectory, { create = true } = {}) {
  const root = await fs.realpath(workspaceRoot);
  const target = path.resolve(targetDirectory);
  let relative = path.relative(path.resolve(workspaceRoot), target);
  if (!isRelativeStatePath(relative)) relative = path.relative(root, target);
  if (!isRelativeStatePath(relative))
    throw Object.assign(new Error('Background process state directory must remain inside the workspace'), {
      code: 'PROCESS_STATE_PATH_UNSAFE',
    });
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      assertSafeProcessDirectory(await fs.lstat(current));
    } catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (mkdirError.code !== 'EEXIST') throw mkdirError;
      }
      assertSafeProcessDirectory(await fs.lstat(current));
    }
  }
  const info = await fs.lstat(current);
  assertSafeProcessDirectory(info);
  return { path: current, info };
}

function isRelativeStatePath(relative) {
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isProcessRecordForId(record, id) {
  return record?.id === id && PROCESS_STATUSES.includes(record.status);
}

async function restoreProcessRecordBackups(workspaceRoot, directory, expectedDirectoryInfo) {
  const names = await fs.readdir(directory);
  const primaryIds = new Set(
    names
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .filter((id) => ID_PATTERN.test(id)),
  );
  const backupsById = new Map();
  for (const name of names) {
    const marker = '.json.';
    const markerIndex = name.lastIndexOf(marker);
    if (markerIndex < 0 || !name.endsWith('.bak')) continue;
    const id = name.slice(0, markerIndex);
    const backupId = name.slice(markerIndex + marker.length, -'.bak'.length);
    if (!ID_PATTERN.test(id) || !ID_PATTERN.test(backupId)) continue;
    const candidates = backupsById.get(id) || [];
    candidates.push(name);
    backupsById.set(id, candidates);
  }

  for (const [id, candidates] of backupsById) {
    const destination = path.join(directory, `${id}.json`);
    if (primaryIds.has(id)) {
      // Recovery uses a same-directory hard link so a competing manager
      // cannot overwrite a primary record. If the process crashed before it
      // removed that link's backup name, drop only the duplicate directory
      // entry after proving both names reference the same single file.
      await removeInterruptedRecoveryLink(directory, destination, candidates, expectedDirectoryInfo);
      continue;
    }
    // Multiple candidates are intentionally left intact because their order
    // cannot be trusted.
    if (candidates.length !== 1) continue;
    const backupName = candidates[0];
    let record;
    let backupInfo;
    try {
      backupInfo = await fs.lstat(path.join(directory, backupName));
      assertSafeProcessRecord(backupInfo);
      record = await readSafeProcessRecord(workspaceRoot, directory, backupName);
      const checkedBackupInfo = await fs.lstat(path.join(directory, backupName));
      if (checkedBackupInfo.dev !== backupInfo.dev || checkedBackupInfo.ino !== backupInfo.ino || checkedBackupInfo.nlink !== 1) continue;
    } catch {
      continue;
    }
    if (!isProcessRecordForId(record, id)) continue;

    const backup = path.join(directory, backupName);
    await assertProcessDirectoryIdentity(directory, expectedDirectoryInfo);
    try {
      await fs.lstat(destination);
      continue;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      await fs.link(backup, destination);
      const [linkedInfo, remainingBackupInfo] = await Promise.all([fs.lstat(destination), fs.lstat(backup)]);
      if (
        linkedInfo.dev !== backupInfo.dev ||
        linkedInfo.ino !== backupInfo.ino ||
        remainingBackupInfo.dev !== backupInfo.dev ||
        remainingBackupInfo.ino !== backupInfo.ino
      ) {
        const currentDestination = await fs.lstat(destination).catch(() => null);
        if (
          currentDestination?.isFile() &&
          !currentDestination.isSymbolicLink() &&
          currentDestination.dev === backupInfo.dev &&
          currentDestination.ino === backupInfo.ino
        )
          await fs.rm(destination).catch(() => {});
        continue;
      }
      await fs.rm(backup);
      primaryIds.add(id);
    } catch (error) {
      if (error.code === 'EEXIST' || error.code === 'ENOENT') continue;
      throw Object.assign(
        new Error(`Could not safely restore the interrupted background process record for ${id}; its backup was preserved.`, {
          cause: error,
        }),
        { code: 'PROCESS_BACKUP_RECOVERY_FAILED' },
      );
    }
  }
}

async function removeInterruptedRecoveryLink(directory, destination, candidates, expectedDirectoryInfo) {
  const primaryInfo = await fs.lstat(destination).catch(() => null);
  if (!primaryInfo?.isFile() || primaryInfo.isSymbolicLink() || primaryInfo.nlink !== 2) return;
  for (const name of candidates) {
    const backup = path.join(directory, name);
    const backupInfo = await fs.lstat(backup).catch(() => null);
    if (
      !backupInfo?.isFile() ||
      backupInfo.isSymbolicLink() ||
      backupInfo.nlink !== 2 ||
      backupInfo.dev !== primaryInfo.dev ||
      backupInfo.ino !== primaryInfo.ino
    )
      continue;
    await assertProcessDirectoryIdentity(directory, expectedDirectoryInfo);
    await fs.rm(backup).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    return;
  }
}

function assertSafeProcessDirectory(info) {
  if (info.isSymbolicLink() || !info.isDirectory())
    throw Object.assign(new Error('Background process state path contains a non-directory or symbolic link'), {
      code: 'PROCESS_STATE_PATH_UNSAFE',
    });
}

async function assertProcessDirectoryIdentity(directory, expected) {
  const current = await fs.lstat(directory);
  assertSafeProcessDirectory(current);
  if (current.dev !== expected.dev || current.ino !== expected.ino)
    throw Object.assign(new Error('Background process state directory changed during access'), { code: 'PROCESS_STATE_PATH_CHANGED' });
}

function assertSafeProcessRecord(info) {
  if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1)
    throw Object.assign(new Error('Background process record must be a regular single-link file'), { code: 'PROCESS_RECORD_INVALID' });
  if (info.size > MAX_PROCESS_RECORD_BYTES)
    throw Object.assign(new Error('Background process record exceeds its size limit'), { code: 'PROCESS_RECORD_TOO_LARGE' });
}

async function assertSafeProcessDestination(destination) {
  try {
    assertSafeProcessRecord(await fs.lstat(destination));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function readSafeProcessRecord(workspaceRoot, directory, name) {
  const safeDirectory = await ensureSafeProcessDirectory(workspaceRoot, directory, { create: false });
  const destination = path.join(safeDirectory.path, name);
  const before = await fs.lstat(destination);
  assertSafeProcessRecord(before);
  if (path.dirname(await fs.realpath(destination)) !== safeDirectory.path)
    throw Object.assign(new Error('Background process record resolves outside its state directory'), { code: 'PROCESS_RECORD_INVALID' });
  const handle = await fs.open(destination, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    assertSafeProcessRecord(opened);
    if (opened.dev !== before.dev || opened.ino !== before.ino)
      throw Object.assign(new Error('Background process record changed while being opened'), { code: 'PROCESS_RECORD_INVALID' });
    await assertProcessDirectoryIdentity(safeDirectory.path, safeDirectory.info);
    const buffer = Buffer.alloc(MAX_PROCESS_RECORD_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > MAX_PROCESS_RECORD_BYTES)
      throw Object.assign(new Error('Background process record exceeds its size limit'), { code: 'PROCESS_RECORD_TOO_LARGE' });
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally {
    await handle.close();
  }
}

function writeProcessInput(stream, input) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      stream.off('error', onError);
      if (error) {
        const stdinErrorCode = typeof error.code === 'string' && /^[A-Z0-9_]{1,32}$/i.test(error.code) ? error.code : 'UNKNOWN';
        const failure = Object.assign(new Error('Could not deliver input to the background process'), {
          code: 'PROCESS_INPUT_FAILED',
          stdinErrorCode,
        });
        reject(failure);
      } else resolve();
    };
    const onError = (error) => finish(error);
    stream.once('error', onError);
    try {
      stream.write(input, (error) => finish(error));
    } catch (error) {
      finish(error);
    }
  });
}
