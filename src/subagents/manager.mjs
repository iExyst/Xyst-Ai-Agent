import { randomUUID } from 'node:crypto';
import { runProcess } from '../platform/process.mjs';
import { acquireWorktreeLease, createWorktree, getGitFilterOverrides } from '../platform/worktrees.mjs';
import { isSensitivePath } from '../platform/redaction.mjs';
import { resolveToolTimeoutMs, TOOL_DEFINITIONS } from '../tools/schemas.mjs';
import { SubagentTaskStore } from './task-store.mjs';
import { AGENT_RUN_STATUSES } from '../core/statuses.mjs';

/** Runs a child agent with a fresh transcript and a dedicated managed worktree. */
export class SubagentManager {
  constructor({ workspaceRoot, stateRoot = workspaceRoot, config, executeTask, taskStore, onEvent = () => {} } = {}) {
    this.workspaceRoot = workspaceRoot;
    this.stateRoot = stateRoot;
    this.config = config;
    this.executeTask = executeTask;
    this.onEvent = onEvent;
    this.store = taskStore || new SubagentTaskStore(stateRoot, { maxConcurrent: config.subagents?.max_concurrent || 2 });
    if (typeof executeTask !== 'function') throw new TypeError('executeTask callback is required');
  }

  list(options) {
    return this.store.list(options);
  }
  read(id) {
    return this.store.read(id);
  }

  async delegate({
    task,
    parentSessionId,
    signal,
    approveTool,
    retryOf = null,
    remainingBudget = {},
    mcpServers = null,
    runtimeConfig = this.config,
  } = {}) {
    if (typeof task !== 'string' || !task.trim() || task.length > 5000) throw new TypeError('task must contain 1-5000 characters');
    if (signal?.aborted) throw signal.reason || new Error('Subagent request was cancelled');
    const config = runtimeConfig && typeof runtimeConfig === 'object' ? runtimeConfig : this.config;
    const unrestricted = config.tools?.autonomy === 'unrestricted';
    const record = await this.store.create({ parentSessionId, task: task.trim(), retryOf });
    let releaseSlot;
    let releaseWorktree;
    let timeout;
    let worktree;
    const timeoutController = new AbortController();
    const cancellationController = new AbortController();
    const childSignal = AbortSignal.any([signal, timeoutController.signal, cancellationController.signal].filter(Boolean));
    const timeoutMs = resolveToolTimeoutMs(TOOL_DEFINITIONS.delegate_task, config);
    let unregisterCancellation;
    let childExecutionSettled = false;
    try {
      unregisterCancellation = this.store.registerActiveCancellation(record.id, (reason) => {
        if (childExecutionSettled) return 'finished';
        if (childSignal.aborted) return false;
        if (cancellationController.signal.aborted) return false;
        cancellationController.abort(reason);
        return true;
      });
      releaseSlot = await this.store.acquireSlot(record.id, { signal: childSignal });
      const branch = `xyst/task-${record.id.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
      worktree = await createWorktree(this.workspaceRoot, branch, {
        signal: childSignal,
        sandboxable: true,
        destinationRoot: this.stateRoot,
      });
      releaseWorktree = await acquireWorktreeLease(this.stateRoot, worktree.id);
      await this.store.update(record.id, {
        status: 'running',
        started_at: new Date().toISOString(),
        worktree_id: worktree.id,
        worktree_path: worktree.path,
        branch,
      });
      this.#emit({
        type: 'subagent_task_started',
        task_id: record.id,
        parent_session_id: parentSessionId,
        worktree_id: worktree.id,
        branch,
      });
      if (!unrestricted) {
        timeout = setTimeout(
          () => timeoutController.abort(Object.assign(new Error('Subagent task timed out'), { code: 'SUBAGENT_TIMEOUT' })),
          timeoutMs,
        );
      }
      const inputAvailable = remainingBudget.inputTokens ?? config.budgets?.max_input_tokens ?? 20_000;
      const outputAvailable = remainingBudget.outputTokens ?? config.budgets?.max_output_tokens ?? 4_000;
      const maxInput = unrestricted
        ? Number.MAX_SAFE_INTEGER
        : Math.max(1, Math.floor(Math.min(inputAvailable, config.budgets?.max_input_tokens || inputAvailable) * 0.4));
      const maxOutput = unrestricted
        ? Number.MAX_SAFE_INTEGER
        : Math.max(1, Math.floor(Math.min(outputAvailable, config.budgets?.max_output_tokens || outputAvailable) * 0.4));
      let childResponse;
      try {
        childResponse = await this.executeTask({
          task: task.trim(),
          taskId: record.id,
          parentSessionId,
          workspaceRoot: worktree.path,
          worktree,
          signal: childSignal,
          approveTool,
          mcpServers,
          runtimeConfig: config,
          budget: {
            max_turns: unrestricted ? Number.MAX_SAFE_INTEGER : config.subagents?.max_turns || Math.min(4, config.budgets?.max_turns || 4),
            max_input_tokens: maxInput,
            max_output_tokens: maxOutput,
            max_tool_output_bytes: unrestricted ? Number.MAX_SAFE_INTEGER : config.budgets?.max_tool_output_bytes || 32_000,
            ...(!unrestricted && Number.isFinite(remainingBudget.costUsd)
              ? { max_session_cost: Math.max(0, remainingBudget.costUsd * 0.4) }
              : {}),
          },
        });
      } finally {
        childExecutionSettled = true;
      }
      const result = validateChildExecutionResult(childResponse);
      const changedPaths = await listChangedPaths(worktree.path);
      const status = timeoutController.signal.aborted
        ? 'timed_out'
        : childSignal.aborted
          ? 'cancelled'
          : result.status === 'complete'
            ? 'complete'
            : result.status === 'cancelled'
              ? 'cancelled'
              : result.status === 'failed'
                ? 'failed'
                : 'stopped';
      const usage = normalizeSubagentUsage(result.session?.usage);
      const updated = await this.store.update(record.id, {
        status,
        child_session_id: result.session?.id || null,
        result: result.content || '',
        changed_paths: changedPaths,
        usage,
        ...(status === 'failed' ? { error: result.content || 'Child agent failed' } : {}),
        completed_at: new Date().toISOString(),
      });
      this.#emit({
        type: 'subagent_task_finished',
        task_id: record.id,
        status,
        child_session_id: result.session?.id || null,
        changed_paths: changedPaths,
      });
      return toSubagentExecutionResult(updated, result.status, usage, {
        unrestricted,
        configuredOutputLimit: config.budgets?.max_tool_output_bytes,
      });
    } catch (error) {
      const status = timeoutController.signal.aborted ? 'timed_out' : childSignal.aborted ? 'cancelled' : 'failed';
      if (worktree && !releaseWorktree) {
        releaseWorktree = await acquireWorktreeLease(this.stateRoot, worktree.id).catch(() => null);
      }
      const updated = await this.store
        .update(record.id, {
          status,
          ...(worktree ? { worktree_id: worktree.id, worktree_path: worktree.path, branch: worktree.branch } : {}),
          error: error.message,
          completed_at: new Date().toISOString(),
        })
        .catch(() => record);
      this.#emit({ type: 'subagent_task_finished', task_id: record.id, status, error: error.message });
      if (childSignal.aborted)
        return toSubagentExecutionResult(updated, status === 'cancelled' ? 'cancelled' : null, null, {
          unrestricted,
          configuredOutputLimit: config.budgets?.max_tool_output_bytes,
        });
      throw Object.assign(new Error(`Subagent task ${record.id} failed: ${error.message}`, { cause: error }), {
        code: error.code || 'SUBAGENT_TASK_FAILED',
        task_id: record.id,
      });
    } finally {
      clearTimeout(timeout);
      unregisterCancellation?.();
      await releaseWorktree?.();
      await releaseSlot?.();
    }
  }

  async retry({ taskId, parentSessionId, signal, approveTool, remainingBudget = {}, mcpServers = null, runtimeConfig = this.config } = {}) {
    const previous = await this.store.read(taskId);
    if (!previous) throw Object.assign(new Error('Subagent task to retry was not found'), { code: 'NOT_FOUND' });
    if (previous.parent_session_id !== parentSessionId)
      throw Object.assign(new Error('Subagent task belongs to another parent session'), { code: 'SUBAGENT_PARENT_MISMATCH' });
    if (!['stopped', 'failed', 'cancelled', 'timed_out'].includes(previous.status))
      throw Object.assign(new Error('Only stopped, failed, cancelled, or timed-out subagent tasks can be retried'), {
        code: 'SUBAGENT_NOT_RETRYABLE',
      });
    return this.delegate({
      task: previous.task,
      parentSessionId,
      signal,
      approveTool,
      remainingBudget,
      mcpServers,
      runtimeConfig,
      retryOf: previous.id,
    });
  }

  #emit(event) {
    try {
      this.onEvent(event);
    } catch {
      /* observer failures do not change task outcomes */
    }
  }
}

const MAX_RESULT_SUMMARY_CHARS = 8_000;
const MAX_RESULT_PATHS = 100;
const MAX_RESULT_PATH_CHARS = 512;
const MAX_RESULT_BYTES = 24_000;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateChildExecutionResult(result) {
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    !AGENT_RUN_STATUSES.includes(result.status) ||
    typeof result.content !== 'string' ||
    !result.session ||
    typeof result.session !== 'object' ||
    Array.isArray(result.session) ||
    !SESSION_ID_PATTERN.test(result.session.id || '')
  ) {
    throw Object.assign(new Error('Subagent returned a result that does not match the child-run contract'), {
      code: 'SUBAGENT_INVALID_RESULT',
    });
  }
  const usage = result.session.usage === undefined || result.session.usage === null ? null : normalizeSubagentUsage(result.session.usage);
  if (result.session.usage !== undefined && result.session.usage !== null && usage === null) {
    throw Object.assign(new Error('Subagent returned invalid usage data'), { code: 'SUBAGENT_INVALID_RESULT' });
  }
  return { status: result.status, content: result.content, session: { id: result.session.id, usage } };
}

function normalizeSubagentUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const { input_tokens: inputTokens, output_tokens: outputTokens, estimated_cost: estimatedCost = null } = usage;
  if (
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0 ||
    (estimatedCost !== null && (!Number.isFinite(estimatedCost) || estimatedCost < 0))
  )
    return null;
  return { input_tokens: inputTokens, output_tokens: outputTokens, estimated_cost: estimatedCost };
}

function toSubagentExecutionResult(task, childStatus, usage, { unrestricted, configuredOutputLimit } = {}) {
  const sourceSummary = typeof task.result === 'string' ? task.result : '';
  const sourcePaths = Array.isArray(task.changed_paths) ? task.changed_paths : [];
  const changedPaths = sourcePaths
    .filter((item) => typeof item === 'string' && item.length <= MAX_RESULT_PATH_CHARS)
    .slice(0, MAX_RESULT_PATHS);
  const sourceError = task.error || null;
  const summary = truncateCodeUnits(sourceSummary, MAX_RESULT_SUMMARY_CHARS);
  const result = {
    schema_version: 1,
    task_id: task.id,
    attempt: Number.isSafeInteger(task.attempt) && task.attempt > 0 ? task.attempt : 1,
    retry_of: task.retry_of || null,
    status: task.status,
    child_status: AGENT_RUN_STATUSES.includes(childStatus) ? childStatus : null,
    child_session_id: task.child_session_id || null,
    worktree_id: task.worktree_id || null,
    branch: task.branch || null,
    summary,
    summary_truncated: summary !== sourceSummary,
    changed_paths: changedPaths,
    changed_paths_truncated: changedPaths.length < sourcePaths.length,
    usage,
    error: sourceError,
    error_truncated: false,
  };

  const maxBytes = unrestricted ? MAX_RESULT_BYTES : Math.min(MAX_RESULT_BYTES, configuredOutputLimit || MAX_RESULT_BYTES);
  while (Buffer.byteLength(JSON.stringify(result), 'utf8') > maxBytes) {
    if (result.changed_paths.length > 0) {
      result.changed_paths.pop();
      result.changed_paths_truncated = true;
    } else if (result.summary) {
      const overage = Buffer.byteLength(JSON.stringify(result), 'utf8') - maxBytes;
      const currentBytes = Buffer.byteLength(result.summary, 'utf8');
      result.summary = truncateUtf8(result.summary, Math.max(0, currentBytes - overage - 64));
      result.summary_truncated = true;
    } else if (result.error) {
      const overage = Buffer.byteLength(JSON.stringify(result), 'utf8') - maxBytes;
      const currentBytes = Buffer.byteLength(result.error, 'utf8');
      result.error = truncateUtf8(result.error, Math.max(0, currentBytes - overage - 64));
      result.error_truncated = true;
    } else {
      break;
    }
  }
  return result;
}

function truncateCodeUnits(value, maxCodeUnits) {
  const wellFormed = value.toWellFormed();
  let end = Math.min(wellFormed.length, maxCodeUnits);
  if (end > 0 && end < wellFormed.length) {
    const last = wellFormed.charCodeAt(end - 1);
    const next = wellFormed.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  }
  return wellFormed.slice(0, end);
}

function truncateUtf8(value, maxBytes) {
  let output = '';
  let bytes = 0;
  for (const character of value.toWellFormed()) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) break;
    output += character;
    bytes += characterBytes;
  }
  return output;
}

async function listChangedPaths(workspaceRoot) {
  const disabledFilters = await getGitFilterOverrides(workspaceRoot);
  const result = await runProcess(
    'git',
    [
      '-c',
      'core.fsmonitor=false',
      ...disabledFilters.flatMap((value) => ['-c', value]),
      '-C',
      workspaceRoot,
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ],
    { cwd: workspaceRoot, timeoutMs: 15_000, maxOutputBytes: 128 * 1024 },
  );
  if (result.exitCode !== 0) throw new Error('Could not inspect subagent worktree changes');
  const entries = result.stdout.split('\0').filter(Boolean);
  const paths = [];
  for (const entry of entries) {
    const relative = entry.slice(3);
    if (relative && !isSensitivePath(relative)) paths.push(relative);
  }
  return [...new Set(paths)].slice(0, 500);
}
