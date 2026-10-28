import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { atomicWriteFile, hasAtomicWriteBackup, restoreAtomicWriteBackup } from '../platform/files.mjs';
import { ToolAuditStore } from './audit.mjs';

export const MIN_APPROVAL_RULE_MS = 60_000;
export const MAX_APPROVAL_RULE_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_APPROVAL_RULES = 500;
const MAX_APPROVAL_RULE_BYTES = 1_000_000;
const MAX_APPROVAL_LOCK_BYTES = 1_024;
const TOOLS = new Set([
  'read_file',
  'list_dir',
  'search_files',
  'semantic_search',
  'web_search',
  'delegate_task',
  'write_file',
  'edit_file',
  'run_process',
  'run_shell_script',
  'start_background_process',
  'send_background_input',
  'list_background_processes',
  'read_background_process',
  'stop_background_process',
]);

export class ApprovalRuleStore {
  constructor(workspaceRoot, { lockWaitMs = 10_000 } = {}) {
    this.workspaceRoot = workspaceRoot;
    this.directory = path.join(workspaceRoot, '.agent', 'approvals');
    this.file = path.join(this.directory, 'rules.json');
    this.lockFile = path.join(this.directory, 'rules.lock');
    this.lockWaitMs = lockWaitMs;
    this.audit = new ToolAuditStore(workspaceRoot);
  }

  async list() {
    const state = await this.#read();
    const now = Date.now();
    return state.rules.map((rule) => ({ ...rule, status: Date.parse(rule.expires_at) > now ? 'active' : 'expired' }));
  }

  async add({ tool, scope, pattern, decision = 'allow', durationMs } = {}) {
    const createdAt = new Date();
    const rule = validateRule({
      id: randomUUID(),
      tool,
      scope,
      pattern: scope === 'tool' ? null : pattern,
      decision,
      created_at: createdAt.toISOString(),
      expires_at: expiry(durationMs, createdAt),
    });
    return this.#withLock(async () => {
      const state = await this.#read();
      if (state.rules.length >= MAX_APPROVAL_RULES)
        throw Object.assign(new Error(`At most ${MAX_APPROVAL_RULES} approval rules can be stored`), { code: 'RULE_LIMIT' });
      await this.#auditChange(rule, 'rule_add_requested');
      state.rules.push(rule);
      await this.#write(state);
      try {
        await this.#auditChange(rule, 'succeeded');
      } catch (error) {
        state.rules.pop();
        await this.#write(state).catch(() => {});
        throw error;
      }
      return { ...rule, status: 'active' };
    });
  }

  async revoke(id) {
    if (typeof id !== 'string' || !isUuid(id)) throw new TypeError('Invalid approval rule ID');
    return this.#withLock(async () => {
      const state = await this.#read();
      const rule = state.rules.find((item) => item.id === id);
      if (!rule) return false;
      await this.#auditChange(rule, 'rule_revoke_requested');
      state.rules = state.rules.filter((item) => item.id !== id);
      await this.#write(state);
      try {
        await this.#auditChange(rule, 'revoked');
      } catch (error) {
        state.rules.push(rule);
        await this.#write(state).catch(() => {});
        throw error;
      }
      return true;
    });
  }

  async #auditChange(rule, outcome) {
    await this.audit.record({
      sessionId: 'workspace',
      toolCallId: rule.id,
      tool: 'approval_rule',
      args: { rule_id: rule.id, target_tool: rule.tool, scope: rule.scope, pattern: rule.pattern || null, expires_at: rule.expires_at },
      decision: rule.decision,
      policySource: 'user_managed_policy',
      approvalResult: outcome,
      outcome,
    });
  }

  async #read() {
    let directory;
    try {
      directory = await this.#ensureDirectory({ create: false });
    } catch (error) {
      if (error.code === 'ENOENT') return { schema_version: 1, rules: [] };
      throw error;
    }
    await this.#assertDirectoryChain(directory);
    const file = path.join(directory.path, 'rules.json');
    let before;
    try {
      before = await fs.lstat(file);
      assertRuleFile(before);
    } catch (error) {
      if (error.code === 'ENOENT') {
        if (await hasAtomicWriteBackup(file))
          throw Object.assign(new Error('Approval rules have an interrupted replacement backup; update rules to recover them safely'), {
            code: 'APPROVAL_RULE_RECOVERY_REQUIRED',
          });
        return { schema_version: 1, rules: [] };
      }
      throw error;
    }

    let handle;
    let state;
    try {
      handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
      const opened = await handle.stat();
      assertRuleFile(opened);
      if (!sameFileIdentity(before, opened)) throw invalidRuleStore('Approval rule store changed while it was being opened');
      await this.#assertDirectoryChain(directory);

      const buffer = Buffer.alloc(MAX_APPROVAL_RULE_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_APPROVAL_RULE_BYTES || opened.size !== bytesRead)
        throw invalidRuleStore('Approval rule store changed or exceeded its read limit');
      const after = await handle.stat();
      const current = await fs.lstat(file);
      assertRuleFile(current);
      if (!sameFileIdentity(before, after) || !sameFileIdentity(before, current) || after.size !== bytesRead || current.size !== after.size)
        throw invalidRuleStore('Approval rule store changed while it was being read');
      await this.#assertDirectoryChain(directory);
      state = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    } finally {
      await handle?.close();
    }
    if (
      state?.schema_version !== 1 ||
      !Array.isArray(state.rules) ||
      state.rules.length > MAX_APPROVAL_RULES ||
      state.rules.some((rule) => !isValidRule(rule))
    ) {
      throw Object.assign(new Error('Approval rule store is invalid; refusing to apply rules'), { code: 'INVALID_RULE_STORE' });
    }
    return state;
  }

  async #write(state) {
    const directory = await this.#ensureDirectory();
    const file = path.join(directory.path, 'rules.json');
    await this.#assertDirectoryChain(directory);
    await assertRuleDestination(file);
    await atomicWriteFile(file, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
      beforeReplace: async () => {
        await this.#assertDirectoryChain(directory);
        await assertRuleDestination(file);
      },
    });
    await this.#assertDirectoryChain(directory);
  }

  async #withLock(operation) {
    const directory = await this.#ensureDirectory();
    const lockFile = path.join(directory.path, 'rules.lock');
    const lockToken = randomUUID();
    const deadline = Date.now() + this.lockWaitMs;
    let handle;
    let lockIdentity;
    while (!handle) {
      await this.#assertDirectoryChain(directory);
      try {
        handle = await fs.open(lockFile, 'wx', 0o600);
        await handle.writeFile(
          JSON.stringify({ lock_token: lockToken, pid: process.pid, hostname: os.hostname(), started_at: new Date().toISOString() }),
        );
        await handle.sync();
        lockIdentity = await handle.stat();
        assertRuleFile(lockIdentity, 'Approval rule lock must be a regular single-link file', MAX_APPROVAL_LOCK_BYTES);
        const lockPathInfo = await fs.lstat(lockFile);
        assertRuleFile(lockPathInfo, 'Approval rule lock must be a regular single-link file', MAX_APPROVAL_LOCK_BYTES);
        if (!sameFileIdentity(lockIdentity, lockPathInfo)) throw invalidRuleStore('Approval rule lock changed while it was being opened');
        await this.#assertDirectoryChain(directory);
      } catch (error) {
        if (handle) {
          const openedInfo = lockIdentity || (await handle.stat().catch(() => null));
          await handle.close().catch(() => {});
          try {
            await this.#assertDirectoryChain(directory);
            await removeApprovalLockIfOwned(lockFile, lockToken, openedInfo);
          } catch {
            // Preserve a lock when its directory or ownership cannot be confirmed.
          }
          handle = null;
          lockIdentity = null;
        }
        const contention = error.code === 'EEXIST' || (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code));
        if (!contention) throw error;
        await this.#assertDirectoryChain(directory);
        let lockInfo;
        try {
          lockInfo = await fs.lstat(lockFile);
          assertRuleFile(lockInfo, 'Approval rule lock must be a regular single-link file', MAX_APPROVAL_LOCK_BYTES);
        } catch (inspectError) {
          if (inspectError.code === 'ENOENT') continue;
          throw inspectError;
        }
        if (Date.now() >= deadline) {
          throw Object.assign(new Error(`Approval rules are locked. Verify that no writer is active before removing ${lockFile}.`), {
            code: 'RULES_LOCKED',
          });
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(20, Math.max(1, deadline - Date.now()))));
      }
    }
    try {
      await this.#assertDirectoryChain(directory);
      await restoreAtomicWriteBackup(path.join(directory.path, 'rules.json'), {
        maxBytes: MAX_APPROVAL_RULE_BYTES,
        decode: (serialized) => {
          const state = JSON.parse(serialized);
          if (
            state?.schema_version !== 1 ||
            !Array.isArray(state.rules) ||
            state.rules.length > MAX_APPROVAL_RULES ||
            state.rules.some((rule) => !isValidRule(rule))
          )
            throw invalidRuleStore('Approval rule recovery backup has an invalid schema');
          return state;
        },
      });
      return await operation();
    } finally {
      await handle.close().catch(() => {});
      try {
        await this.#assertDirectoryChain(directory);
        await removeApprovalLockIfOwned(lockFile, lockToken, lockIdentity);
      } catch {
        // A replaced or unsafe lock path is left for explicit operator recovery.
      }
    }
  }

  async #ensureDirectory({ create = true } = {}) {
    const root = await fs.realpath(this.workspaceRoot);
    const chain = [{ path: root, info: await fs.lstat(root) }];
    assertRuleDirectory(chain[0].info);
    let current = root;
    for (const segment of ['.agent', 'approvals']) {
      current = path.join(current, segment);
      let info;
      try {
        info = await fs.lstat(current);
      } catch (error) {
        if (error.code !== 'ENOENT' || !create) throw error;
        await fs.mkdir(current, { mode: 0o700 }).catch(async (mkdirError) => {
          if (mkdirError.code !== 'EEXIST') throw mkdirError;
        });
        info = await fs.lstat(current);
      }
      assertRuleDirectory(info);
      chain.push({ path: current, info });
    }
    return { path: current, chain };
  }

  async #assertDirectoryChain(directory) {
    for (const expected of directory.chain) {
      const current = await fs.lstat(expected.path);
      assertRuleDirectory(current);
      if (!sameFileIdentity(expected.info, current)) throw invalidRuleStore('Approval rule state directory changed during access');
    }
  }
}

async function removeApprovalLockIfOwned(lockFile, lockToken, identity) {
  const current = await fs.lstat(lockFile).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
  if (!current) return false;
  assertRuleFile(current, 'Approval rule lock must be a regular single-link file', MAX_APPROVAL_LOCK_BYTES);
  if (identity && !sameFileIdentity(identity, current)) return false;
  let record;
  try {
    record = JSON.parse(await fs.readFile(lockFile, 'utf8'));
  } catch {
    return false;
  }
  if (record.lock_token !== lockToken) return false;
  await fs.unlink(lockFile);
  return true;
}

function validateRule(rule) {
  if (!isValidRule(rule)) throw new TypeError('Approval rule has invalid fields or scope');
  return rule;
}

function isValidRule(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule) || !isUuid(rule.id)) return false;
  if (Object.keys(rule).sort().join(',') !== ['created_at', 'decision', 'expires_at', 'id', 'pattern', 'scope', 'tool'].join(','))
    return false;
  if (!TOOLS.has(rule.tool) || !['tool', 'path_glob', 'command_glob'].includes(rule.scope) || !['allow', 'deny'].includes(rule.decision))
    return false;
  if (rule.scope === 'tool') {
    if (rule.pattern !== null || !rule.tool) return false;
  } else if (typeof rule.pattern !== 'string' || !rule.pattern.trim() || rule.pattern.length > 500 || /[\u0000-\u001f]/.test(rule.pattern))
    return false;
  if (rule.scope === 'path_glob') {
    if (
      !['write_file', 'edit_file'].includes(rule.tool) ||
      rule.pattern.startsWith('/') ||
      /^[A-Za-z]:/.test(rule.pattern) ||
      rule.pattern.includes('\\') ||
      rule.pattern.split('/').some((part) => part === '..')
    )
      return false;
  }
  if (rule.scope === 'command_glob' && rule.tool !== 'run_process') return false;
  const created = Date.parse(rule.created_at);
  const expires = Date.parse(rule.expires_at);
  return (
    Number.isFinite(created) &&
    Number.isFinite(expires) &&
    expires > created &&
    expires - created >= MIN_APPROVAL_RULE_MS &&
    expires - created <= MAX_APPROVAL_RULE_MS
  );
}

function expiry(durationMs, createdAt) {
  if (!Number.isInteger(durationMs) || durationMs < MIN_APPROVAL_RULE_MS || durationMs > MAX_APPROVAL_RULE_MS) {
    throw new TypeError(`Approval rule duration must be between ${MIN_APPROVAL_RULE_MS} and ${MAX_APPROVAL_RULE_MS} milliseconds`);
  }
  return new Date(createdAt.getTime() + durationMs).toISOString();
}

function assertRuleDirectory(info) {
  if (info.isSymbolicLink() || !info.isDirectory()) throw invalidRuleStore('Approval rule state path contains a non-directory or symlink');
}

function assertRuleFile(info, message = 'Approval rule store must be a regular single-link file', maxBytes = MAX_APPROVAL_RULE_BYTES) {
  if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1) throw invalidRuleStore(message);
  if (info.size > maxBytes) throw invalidRuleStore('Approval rule state file exceeds its read limit');
}

async function assertRuleDestination(file) {
  try {
    assertRuleFile(await fs.lstat(file));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function sameFileIdentity(first, second) {
  return first.dev === second.dev && first.ino === second.ino;
}

function invalidRuleStore(message) {
  return Object.assign(new Error(message), { code: 'INVALID_RULE_STORE' });
}

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
