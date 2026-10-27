import fs from 'node:fs/promises';
import path from 'node:path';
import { redactSecrets } from '../platform/redaction.mjs';
import { OtlpHttpTraceExporter } from './otlp-traces.mjs';

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_TYPES = new Set([
  'api_run_started',
  'api_run_finished',
  'api_run_failed',
  'run_started',
  'model_load_started',
  'model_load_finished',
  'model_load_failed',
  'model_load_skipped',
  'run_finished',
  'run_failed',
  'run_stopped',
  'model_call_started',
  'model_call_finished',
  'model_call_failed',
  'model_retry_scheduled',
  'model_fallback',
  'tool_proposed',
  'tool_started',
  'tool_finished',
  'tool_failed',
  'tool_denied',
  'approval_required',
  'approval_resolved',
  'retrieval_context_ready',
  'retrieval_context_failed',
  'retrieval_context_started',
  'memory_context_started',
  'memory_context_finished',
  'memory_context_failed',
  'session_persist_started',
  'session_persist_finished',
  'session_persist_failed',
  'usage_recording_failed',
  'hook_failed',
  'compaction_started',
  'compaction_finished',
  'compaction_failed',
  'recovery_summary_started',
  'recovery_summary_finished',
  'recovery_summary_failed',
  'subagent_task_started',
  'subagent_task_finished',
  'run_pause_requested',
  'run_pause_cancelled',
  'run_paused',
  'run_resumed',
  'run_direction_queued',
  'user_direction_added',
]);
const MAX_EVENT_BYTES = 4_096;
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const MIN_MAX_FILE_BYTES = 1_000;
const MAX_MAX_FILE_BYTES = 100 * 1024 * 1024;

export class ObservabilityEventStore {
  constructor(
    stateRoot,
    {
      enabled = false,
      consoleEnabled = false,
      consoleWriter = (line) => process.stderr.write(line),
      maxFileBytes = DEFAULT_MAX_FILE_BYTES,
      otlp = null,
      secretStore = null,
      fetchImpl = fetch,
      env = process.env,
    } = {},
  ) {
    if (typeof enabled !== 'boolean') throw new TypeError('observability enabled must be boolean');
    if (typeof consoleEnabled !== 'boolean') throw new TypeError('observability consoleEnabled must be boolean');
    if (typeof consoleWriter !== 'function') throw new TypeError('observability consoleWriter must be a function');
    if (!Number.isInteger(maxFileBytes) || maxFileBytes < MIN_MAX_FILE_BYTES || maxFileBytes > MAX_MAX_FILE_BYTES)
      throw new TypeError(`observability maxFileBytes must be between ${MIN_MAX_FILE_BYTES} and ${MAX_MAX_FILE_BYTES}`);
    this.enabled = enabled;
    this.consoleEnabled = consoleEnabled;
    this.consoleWriter = consoleWriter;
    this.stateRoot = stateRoot;
    this.directory = path.join(stateRoot, '.agent', 'observability');
    this.file = path.join(this.directory, 'events.jsonl');
    this.previousFile = path.join(this.directory, 'events.1.jsonl');
    this.maxFileBytes = maxFileBytes;
    this.pending = Promise.resolve();
    this.writeFailures = 0;
    this.exportFailures = 0;
    this.otlpTraceExporter =
      otlp?.enabled === true
        ? new OtlpHttpTraceExporter({
            endpoint: otlp.traces_endpoint,
            headers: otlp.headers,
            timeoutMs: otlp.timeout_ms,
            maxBatchSpans: otlp.max_batch_spans,
            secretStore,
            fetchImpl,
            env,
          })
        : null;
  }

  async record({ correlationId, runId, sessionId = null, event }) {
    if (!this.enabled) return Promise.resolve(false);
    const record = createRecord({ correlationId, runId, sessionId, event });
    if (!record) return Promise.resolve(false);
    try {
      this.otlpTraceExporter?.record(record);
    } catch {
      this.exportFailures += 1;
    }
    const operation = this.pending.catch(() => {}).then(() => this.#append(record));
    this.pending = operation;
    return operation;
  }

  async flush() {
    let appendError;
    try {
      await this.pending;
    } catch (error) {
      appendError = error;
    }
    await this.otlpTraceExporter?.flush();
    if (appendError) throw appendError;
  }

  async close() {
    let flushError;
    try {
      await this.flush();
    } catch (error) {
      flushError = error;
    }
    await this.otlpTraceExporter?.close();
    if (flushError) throw flushError;
  }

  async #append(record) {
    const line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line, 'utf8') > MAX_EVENT_BYTES) throw new Error('Observability record exceeds the size limit');
    await ensureSafeDirectory(this.stateRoot, this.directory);
    try {
      const info = await fs.lstat(this.file);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error('Observability destination must be a regular non-symlink file');
      if (info.size + Buffer.byteLength(line, 'utf8') > this.maxFileBytes) await this.#rotate();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const handle = await fs.open(this.file, 'a', 0o600);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('Observability destination must be a regular file');
      await handle.chmod(0o600);
      await handle.writeFile(line, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (this.consoleEnabled) this.consoleWriter(line);
    return true;
  }

  async #rotate() {
    try {
      const previous = await fs.lstat(this.previousFile);
      if (previous.isSymbolicLink() || !previous.isFile()) throw new Error('Observability backup must be a regular non-symlink file');
      await fs.rm(this.previousFile);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await fs.rename(this.file, this.previousFile);
  }
}

function createRecord({ correlationId, runId, sessionId, event }) {
  if (!ID_PATTERN.test(correlationId || '') || !ID_PATTERN.test(runId || '') || (sessionId !== null && !ID_PATTERN.test(sessionId || '')))
    throw new TypeError('Observability identifiers must be UUIDs');
  if (!event || typeof event !== 'object' || !EVENT_TYPES.has(event.type)) return null;
  const record = {
    schema_version: 1,
    timestamp: Number.isFinite(Date.parse(event.timestamp)) ? new Date(event.timestamp).toISOString() : new Date().toISOString(),
    correlation_id: correlationId,
    run_id: runId,
    session_id: sessionId,
    event: event.type,
  };
  const turn = safeInteger(event.turn);
  const sequence = safeInteger(event.sequence);
  const matches = safeInteger(event.matches);
  const memoryItems = safeInteger(event.memory_items);
  const activeGoals = safeInteger(event.active_goals);
  const archivedMessages = safeInteger(event.archived_messages);
  const retainedMessages = safeInteger(event.retained_messages);
  const inputTokens = safeNumber(event.usage?.inputTokens);
  const outputTokens = safeNumber(event.usage?.outputTokens);
  const cachedInputTokensValue = safeInteger(event.usage?.cachedInputTokens);
  const cachedInputTokens =
    cachedInputTokensValue !== null && (inputTokens === null || cachedInputTokensValue <= inputTokens) ? cachedInputTokensValue : null;
  const durationMs = safeNumber(event.duration_ms);
  const cost = safeNumber(event.estimated_cost ?? event.estimated_cost_usd);
  const fields = {
    sequence,
    turn,
    matches,
    memory_items: memoryItems,
    active_goals: activeGoals,
    archived_messages: archivedMessages,
    retained_messages: retainedMessages,
    model: safeLabel(event.model || event.to_model),
    tool: safeLabel(event.tool),
    status: safeLabel(event.status),
    outcome: safeLabel(event.outcome),
    error_code: safeCode(event.code || event.error_code || event.error?.code),
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cached_input_tokens: cachedInputTokens,
    duration_ms: durationMs,
    estimated_cost_usd: cost,
  };
  for (const [key, value] of Object.entries(fields)) if (value !== null) record[key] = value;
  return record;
}

function safeLabel(value) {
  if (typeof value !== 'string' || !value || value.length > 128) return null;
  return redactSecrets(value)
    .replace(/[\r\n\t]/g, ' ')
    .slice(0, 128);
}

function safeCode(value) {
  return typeof value === 'string' && /^[A-Z0-9_]{1,64}$/.test(value) ? value : null;
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

async function ensureSafeDirectory(stateRoot, target) {
  const root = await fs.realpath(stateRoot);
  const absolute = path.resolve(target);
  const relative = path.relative(root, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw Object.assign(new Error('Observability path must remain inside the state directory'), { code: 'OBSERVABILITY_PATH_UNSAFE' });
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const info = await fs.lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw Object.assign(new Error('Observability path contains a non-directory or symlink'), { code: 'OBSERVABILITY_PATH_UNSAFE' });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (mkdirError.code !== 'EEXIST') throw mkdirError;
        const raced = await fs.lstat(current);
        if (raced.isSymbolicLink() || !raced.isDirectory())
          throw Object.assign(new Error('Observability path contains a non-directory or symlink'), { code: 'OBSERVABILITY_PATH_UNSAFE' });
      }
    }
  }
}
