import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { isSecretFieldName, redactSecrets } from '../platform/redaction.mjs';

const OMITTED_FIELDS = new Set(['content', 'old_text', 'new_text', 'replacement', 'patch', 'body', 'stdin', 'input']);
const MAX_AUDIT_ARGUMENTS = 3_000;
const MAX_AUDIT_READ_BYTES = 256 * 1024;

/** Append-only, content-minimized audit records. Tool payloads and results are
 * deliberately excluded because they may contain source or user data.
 */
export class ToolAuditStore {
  constructor(workspaceRoot) {
    this.workspaceRoot = workspaceRoot;
    this.directory = path.join(workspaceRoot, '.agent', 'audit');
    this.file = path.join(this.directory, 'tool-events.jsonl');
  }

  async record({
    sessionId,
    toolCallId,
    tool,
    args,
    decision,
    policySource = 'default_policy',
    policyRuleId = null,
    approvalResult = null,
    approvedHunks = null,
    sandboxDecision = 'not_applicable',
    outcome = null,
    durationMs = null,
    errorCode = null,
  }) {
    if (typeof sessionId !== 'string' || typeof toolCallId !== 'string' || typeof tool !== 'string')
      throw new TypeError('Audit identity fields are required');
    const safeDirectory = await ensureSafeAuditDirectory(this.workspaceRoot, this.directory);
    const safeFile = path.join(safeDirectory, path.basename(this.file));
    const record = {
      schema_version: 1,
      timestamp: new Date().toISOString(),
      session_id: redactSecrets(sessionId).slice(0, 100),
      tool_call_id: redactSecrets(toolCallId).slice(0, 200),
      tool: redactSecrets(tool).slice(0, 200),
      arguments: sanitizeArguments(args),
      decision,
      policy_source: redactSecrets(policySource).slice(0, 100),
      policy_rule_id: typeof policyRuleId === 'string' ? redactSecrets(policyRuleId).slice(0, 100) : null,
      approval_result: approvalResult,
      approved_hunks: Array.isArray(approvedHunks)
        ? approvedHunks
            .filter((id) => typeof id === 'string')
            .map((id) => redactSecrets(id).slice(0, 64))
            .slice(0, 100)
        : null,
      sandbox_decision: sandboxDecision,
      outcome,
      result_summary:
        outcome === 'succeeded'
          ? 'Tool completed successfully'
          : outcome === 'failed'
            ? 'Tool failed'
            : outcome === 'denied'
              ? 'Tool was not executed'
              : null,
      duration_ms: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : null,
      error_code: typeof errorCode === 'string' ? redactSecrets(errorCode).slice(0, 100) : null,
    };
    const line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line) > 4_096) throw new Error('Audit record exceeded the 4096-byte limit');
    const directoryInfo = await fs.lstat(safeDirectory);
    assertSafeAuditDirectory(directoryInfo);
    const handle = await openVerifiedAuditFile(safeFile);
    try {
      await assertAuditDirectoryUnchanged(safeDirectory, directoryInfo);
      await handle.write(line);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return record;
  }

  async listMcpHistory({ limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new TypeError('limit must be an integer from 1 to 200');
    const safeDirectory = await findExistingSafeAuditDirectory(this.workspaceRoot);
    if (!safeDirectory) return { entries: [], truncated: false };
    const file = path.join(safeDirectory.path, path.basename(this.file));
    await assertAuditDirectoryIdentity(safeDirectory.path, safeDirectory.info);
    let beforeFile;
    try {
      beforeFile = await fs.lstat(file);
      assertSafeAuditFile(beforeFile);
    } catch (error) {
      if (error.code === 'ENOENT') return { entries: [], truncated: false };
      throw error;
    }
    let handle;
    try {
      handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    } catch (error) {
      if (error.code === 'ENOENT') return { entries: [], truncated: false };
      throw error;
    }
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink > 1) throw new Error('Audit destination must be a regular single-link file');
      if (before.dev !== beforeFile.dev || before.ino !== beforeFile.ino)
        throw new Error('Audit destination changed while it was being opened');
      await assertAuditDirectoryIdentity(safeDirectory.path, safeDirectory.info);
      const readBytes = Math.min(before.size, MAX_AUDIT_READ_BYTES);
      const offset = Math.max(0, before.size - readBytes);
      const buffer = Buffer.alloc(readBytes);
      const { bytesRead } = await handle.read(buffer, 0, readBytes, offset);
      const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
      if (offset > 0) lines.shift();
      const entries = [];
      let truncated = offset > 0;
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (!line || Buffer.byteLength(line) > 4_096) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isMcpAuditRecord(record)) continue;
        if (entries.length === limit) {
          truncated = true;
          break;
        }
        entries.push(toPublicMcpAuditRecord(record));
      }
      return { entries, truncated };
    } finally {
      await handle.close();
    }
  }
}

async function findExistingSafeAuditDirectory(workspaceRoot) {
  const root = await fs.realpath(workspaceRoot);
  let current = root;
  let expectedInfo;
  for (const segment of ['.agent', 'audit']) {
    current = path.join(current, segment);
    try {
      expectedInfo = await fs.lstat(current);
      assertSafeAuditDirectory(expectedInfo);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  await assertAuditDirectoryIdentity(current, expectedInfo);
  return { path: current, info: expectedInfo };
}

async function assertAuditDirectoryIdentity(directory, expectedInfo) {
  const info = await fs.lstat(directory);
  assertSafeAuditDirectory(info);
  if (info.dev !== expectedInfo.dev || info.ino !== expectedInfo.ino) throw new Error('Audit directory changed while it was being read');
}

function isMcpAuditRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.schema_version !== 1) return false;
  return (
    record.tool === 'mcp_server' ||
    record.tool === 'manage_mcp_server' ||
    record.tool === 'test_mcp_server' ||
    (typeof record.tool === 'string' && record.tool.startsWith('mcp__'))
  );
}

function toPublicMcpAuditRecord(record) {
  const result = {};
  for (const key of [
    'timestamp',
    'session_id',
    'tool_call_id',
    'tool',
    'decision',
    'policy_source',
    'approval_result',
    'outcome',
    'result_summary',
    'duration_ms',
    'error_code',
  ]) {
    const value = record[key];
    if (typeof value === 'string') result[key] = redactSecrets(value).slice(0, key === 'result_summary' ? 120 : 200);
    else if (typeof value === 'boolean' || typeof value === 'number' || value === null) result[key] = value;
  }
  if (record.arguments && typeof record.arguments.server === 'string') result.server = redactSecrets(record.arguments.server).slice(0, 48);
  if (record.arguments && typeof record.arguments.action === 'string') result.action = redactSecrets(record.arguments.action).slice(0, 40);
  return result;
}

async function ensureSafeAuditDirectory(workspaceRoot, directory) {
  const rootPath = path.resolve(workspaceRoot);
  const relative = path.relative(rootPath, directory);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error('Audit directory must remain inside its state root');
  let current = await fs.realpath(rootPath);
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const info = await fs.lstat(current);
      assertSafeAuditDirectory(info);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (mkdirError.code !== 'EEXIST') throw mkdirError;
      }
      const created = await fs.lstat(current);
      assertSafeAuditDirectory(created);
    }
  }
  return current;
}

function assertSafeAuditDirectory(info) {
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Audit directory components must be non-symlink directories');
}

async function assertAuditDirectoryUnchanged(directory, expectedInfo) {
  const currentInfo = await fs.lstat(directory);
  assertSafeAuditDirectory(currentInfo);
  if (currentInfo.dev !== expectedInfo.dev || currentInfo.ino !== expectedInfo.ino)
    throw new Error('Audit directory changed while the destination was being opened');
}

async function openVerifiedAuditFile(file) {
  let before = null;
  try {
    before = await fs.lstat(file);
    assertSafeAuditFile(before);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const noFollow = fsConstants.O_NOFOLLOW || 0;
  const appendFlags = fsConstants.O_WRONLY | fsConstants.O_APPEND | noFollow;
  let handle;
  if (before) {
    handle = await fs.open(file, appendFlags);
  } else {
    try {
      handle = await fs.open(file, appendFlags | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      before = await fs.lstat(file);
      assertSafeAuditFile(before);
      handle = await fs.open(file, appendFlags);
    }
  }

  try {
    const opened = await handle.stat();
    assertSafeAuditFile(opened);
    if (before && (opened.dev !== before.dev || opened.ino !== before.ino))
      throw new Error('Audit destination changed while it was being opened');
    await handle.chmod(0o600);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function assertSafeAuditFile(info) {
  if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1)
    throw new Error('Audit destination must be a regular single-link non-symlink file');
}

function sanitizeArguments(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const safe = {};
  for (const [key, value] of Object.entries(args)) {
    const safeKey = redactSecrets(key).slice(0, 100);
    if (OMITTED_FIELDS.has(key.toLowerCase())) {
      safe[safeKey] = '[OMITTED]';
      continue;
    }
    safe[safeKey] = sanitizeValue(value, 0, key);
  }
  let serialized = JSON.stringify(safe);
  while (Buffer.byteLength(serialized) > MAX_AUDIT_ARGUMENTS) {
    const keys = Object.keys(safe);
    const key = keys.at(-1);
    if (!key) return { omitted: '[TRUNCATED]' };
    safe[key] = '[TRUNCATED]';
    serialized = JSON.stringify(safe);
  }
  return safe;
}

function sanitizeValue(value, depth = 0, fieldName = null) {
  if (isSecretFieldName(fieldName)) return value === null || value === undefined ? value : '[REDACTED]';
  if (depth > 4) return '[MAX_DEPTH]';
  if (typeof value === 'string') return redactSecrets(value).slice(0, 500);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitizeValue(item, depth + 1));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, 30)) {
      const safeKey = redactSecrets(key).slice(0, 100);
      result[safeKey] = OMITTED_FIELDS.has(key.toLowerCase()) ? '[OMITTED]' : sanitizeValue(item, depth + 1, key);
    }
    return result;
  }
  return `[${typeof value}]`;
}
