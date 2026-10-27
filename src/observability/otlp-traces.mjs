import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

const MAX_OPEN_SPANS = 1_024;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_REQUEST_BYTES = 1_048_576;
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);

const SPAN_FAMILIES = [
  { name: 'api.run', starts: ['api_run_started'], ends: ['api_run_finished', 'api_run_failed'], parent: null },
  { name: 'agent.run', starts: ['run_started'], ends: ['run_finished', 'run_failed', 'run_stopped'], parent: 'api' },
  { name: 'model.call', starts: ['model_call_started'], ends: ['model_call_finished', 'model_call_failed'], parent: 'run' },
  {
    name: 'model.load',
    starts: ['model_load_started'],
    ends: ['model_load_finished', 'model_load_failed', 'model_load_skipped'],
    parent: 'run',
  },
  { name: 'tool.execution', starts: ['tool_started'], ends: ['tool_finished', 'tool_failed'], parent: 'run' },
  {
    name: 'retrieval.context',
    starts: ['retrieval_context_started'],
    ends: ['retrieval_context_ready', 'retrieval_context_failed'],
    parent: 'run',
  },
  { name: 'memory.context', starts: ['memory_context_started'], ends: ['memory_context_finished', 'memory_context_failed'], parent: 'run' },
  {
    name: 'session.persist',
    starts: ['session_persist_started'],
    ends: ['session_persist_finished', 'session_persist_failed'],
    parent: 'run',
  },
  { name: 'context.compaction', starts: ['compaction_started'], ends: ['compaction_finished', 'compaction_failed'], parent: 'run' },
  {
    name: 'recovery.summary',
    starts: ['recovery_summary_started'],
    ends: ['recovery_summary_finished', 'recovery_summary_failed'],
    parent: 'run',
  },
  { name: 'subagent.task', starts: ['subagent_task_started'], ends: ['subagent_task_finished'], parent: 'run' },
];

const START_EVENTS = new Map();
const END_EVENTS = new Map();
const FAMILY_BY_NAME = new Map();
for (const family of SPAN_FAMILIES) {
  FAMILY_BY_NAME.set(family.name, family);
  for (const event of family.starts) START_EVENTS.set(event, family);
  for (const event of family.ends) END_EVENTS.set(event, family);
}

export class OtlpHttpTraceExporter {
  constructor({
    endpoint,
    headers = {},
    secretStore = null,
    env = process.env,
    fetchImpl = fetch,
    maxBatchSpans = 64,
    maxQueueSpans = 512,
    flushIntervalMs = 1_000,
    timeoutMs = 5_000,
    maxRetries = 3,
    maxRetryDelayMs = 5_000,
    now = Date.now,
    random = Math.random,
    sleep = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)),
  } = {}) {
    if (!isSupportedOtlpEndpoint(endpoint)) throw new TypeError('OTLP traces endpoint must use HTTPS or loopback HTTP');
    if (typeof fetchImpl !== 'function') throw new TypeError('OTLP fetch implementation must be a function');
    if (!Number.isInteger(maxBatchSpans) || maxBatchSpans < 1 || maxBatchSpans > 256)
      throw new TypeError('OTLP maxBatchSpans must be between 1 and 256');
    if (!Number.isInteger(maxQueueSpans) || maxQueueSpans < maxBatchSpans || maxQueueSpans > 4_096)
      throw new TypeError('OTLP maxQueueSpans must be between maxBatchSpans and 4096');
    if (!Number.isInteger(flushIntervalMs) || flushIntervalMs < 100 || flushIntervalMs > 60_000)
      throw new TypeError('OTLP flushIntervalMs must be between 100 and 60000');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000)
      throw new TypeError('OTLP timeoutMs must be between 1000 and 60000');
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) throw new TypeError('OTLP maxRetries must be between 0 and 5');
    if (!Number.isInteger(maxRetryDelayMs) || maxRetryDelayMs < 0 || maxRetryDelayMs > 5_000)
      throw new TypeError('OTLP maxRetryDelayMs must be between 0 and 5000');
    if (typeof now !== 'function' || typeof random !== 'function' || typeof sleep !== 'function')
      throw new TypeError('OTLP clock, random, and sleep dependencies must be functions');

    this.endpoint = endpoint;
    this.headers = validateHeaderReferences(headers);
    this.secretStore = secretStore;
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.maxBatchSpans = maxBatchSpans;
    this.maxQueueSpans = maxQueueSpans;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.maxRetryDelayMs = maxRetryDelayMs;
    this.now = now;
    this.random = random;
    this.sleep = sleep;
    this.queue = [];
    this.openSpans = new Map();
    this.openSpanCount = 0;
    this.parentSpanIds = new Map();
    this.flushing = null;
    this.closed = false;
    this.stats = { exportedSpans: 0, rejectedSpans: 0, droppedSpans: 0, exportFailures: 0, requests: 0 };
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, flushIntervalMs);
    this.flushTimer.unref?.();
  }

  record(record) {
    if (this.closed || !record || typeof record !== 'object') {
      this.stats.droppedSpans += 1;
      return false;
    }
    const startFamily = START_EVENTS.get(record.event);
    if (startFamily) {
      this.#startSpan(record, startFamily);
      return true;
    }
    const endFamily = END_EVENTS.get(record.event);
    if (endFamily) {
      if (endFamily.name === 'agent.run') this.#finishOpenSpans(record.run_id, record.timestamp, ['agent.run', 'api.run']);
      if (endFamily.name === 'api.run') this.#finishOpenSpans(record.run_id, record.timestamp, ['api.run']);
      const pending = this.#takeOpenSpan(record, endFamily);
      const span = pending
        ? buildSpan(pending.record, record, endFamily, pending.spanId, pending.parentSpanId)
        : this.#buildInstantSpan(record, endFamily.name);
      this.#enqueue(span);
      if (endFamily.name === 'agent.run') this.parentSpanIds.delete(`${record.run_id}:run`);
      if (endFamily.name === 'api.run') {
        this.parentSpanIds.delete(`${record.run_id}:api`);
        this.parentSpanIds.delete(`${record.run_id}:run`);
      }
      return true;
    }
    this.#enqueue(this.#buildInstantSpan(record, eventSpanName(record.event)));
    return true;
  }

  async flush() {
    if (this.flushing) {
      await this.flushing;
      if (this.queue.length) return this.flush();
      return;
    }
    if (!this.queue.length) return;
    this.flushing = this.#drainQueue();
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
    if (this.queue.length) await this.flush();
  }

  async close() {
    if (!this.closed) {
      this.closed = true;
      clearInterval(this.flushTimer);
      this.#finishOpenSpans(null, new Date(this.now()).toISOString(), null);
    }
    await this.flush();
  }

  #startSpan(record, family) {
    if (this.openSpanCount >= MAX_OPEN_SPANS) {
      this.stats.droppedSpans += 1;
      return;
    }
    const parentSpanId = this.#parentFor(record.run_id, family);
    const spanId = createSpanId();
    const pending = { family, record, runId: record.run_id, spanId, parentSpanId };
    const key = spanKey(record, family);
    const entries = this.openSpans.get(key) || [];
    entries.push(pending);
    this.openSpans.set(key, entries);
    this.openSpanCount += 1;
    if (family.name === 'api.run') this.parentSpanIds.set(`${record.run_id}:api`, spanId);
    if (family.name === 'agent.run') this.parentSpanIds.set(`${record.run_id}:run`, spanId);
  }

  #takeOpenSpan(record, family) {
    const key = spanKey(record, family);
    const entries = this.openSpans.get(key);
    if (!entries?.length) return null;
    const pending = entries.shift();
    this.openSpanCount -= 1;
    if (!entries.length) this.openSpans.delete(key);
    return pending;
  }

  #finishOpenSpans(runId, timestamp, preservedFamilies) {
    for (const [key, entries] of this.openSpans) {
      const retained = [];
      for (const pending of entries) {
        if ((runId === null || pending.runId === runId) && !preservedFamilies?.includes(pending.family.name)) {
          const end = { ...pending.record, event: 'span_incomplete', timestamp };
          this.#enqueue(buildSpan(pending.record, end, pending.family, pending.spanId, pending.parentSpanId, true));
          this.openSpanCount -= 1;
        } else retained.push(pending);
      }
      if (retained.length) this.openSpans.set(key, retained);
      else this.openSpans.delete(key);
    }
  }

  #parentFor(runId, family) {
    if (family.parent === 'api') return this.parentSpanIds.get(`${runId}:api`);
    if (family.parent === 'run') return this.parentSpanIds.get(`${runId}:run`) || this.parentSpanIds.get(`${runId}:api`);
    return undefined;
  }

  #buildInstantSpan(record, name) {
    const parent = this.parentSpanIds.get(`${record.run_id}:run`) || this.parentSpanIds.get(`${record.run_id}:api`);
    return buildSpan(record, record, { name }, createSpanId(), parent);
  }

  #enqueue(span) {
    if (!span) return;
    if (this.queue.length >= this.maxQueueSpans) {
      this.stats.droppedSpans += 1;
      return;
    }
    this.queue.push(span);
    if (this.queue.length >= this.maxBatchSpans) void this.flush();
  }

  async #drainQueue() {
    while (this.queue.length) {
      const batch = this.queue.splice(0, this.maxBatchSpans);
      await this.#exportBatch(batch);
    }
  }

  async #exportBatch(spans) {
    let body;
    try {
      body = JSON.stringify(createExportRequest(spans));
      if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) throw new Error('request too large');
    } catch {
      this.stats.exportFailures += 1;
      this.stats.droppedSpans += spans.length;
      return;
    }

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let headers;
      try {
        headers = await this.#resolveHeaders();
      } catch {
        this.stats.exportFailures += 1;
        this.stats.droppedSpans += spans.length;
        return;
      }
      this.stats.requests += 1;
      let response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'Xyst AI Assistant/0.1.0 OTel-OTLP-Exporter-Node/1',
            ...headers,
          },
          body,
          redirect: 'error',
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        if (attempt < this.maxRetries) {
          await this.#waitBeforeRetry(attempt);
          continue;
        }
        this.stats.exportFailures += 1;
        this.stats.droppedSpans += spans.length;
        return;
      }

      if (response.status !== 200) {
        const retryable = RETRYABLE_STATUS_CODES.has(response.status);
        const retryAfterMs = retryable ? parseRetryAfter(response.headers?.get('retry-after'), this.now()) : null;
        await response.body?.cancel().catch(() => {});
        if (retryable && attempt < this.maxRetries) {
          await this.#waitBeforeRetry(attempt, retryAfterMs);
          continue;
        }
        this.stats.exportFailures += 1;
        this.stats.droppedSpans += spans.length;
        return;
      }

      let partial;
      try {
        const contentType = response.headers?.get('content-type');
        if (contentType?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw new Error('invalid response type');
        const text = await readBoundedResponse(response, MAX_RESPONSE_BYTES);
        const payload = JSON.parse(text);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid response payload');
        partial = Object.hasOwn(payload, 'partialSuccess') ? payload.partialSuccess : undefined;
      } catch {
        this.stats.exportFailures += 1;
        this.stats.droppedSpans += spans.length;
        return;
      }

      if (partial === undefined) {
        this.stats.exportedSpans += spans.length;
        return;
      }
      if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
        this.stats.exportFailures += 1;
        this.stats.droppedSpans += spans.length;
        return;
      }
      const rawRejected = partial.rejectedSpans ?? 0;
      const rejected = typeof rawRejected === 'string' && /^(0|[1-9][0-9]*)$/.test(rawRejected) ? Number(rawRejected) : rawRejected;
      if (!Number.isSafeInteger(rejected) || rejected < 0 || rejected > spans.length) {
        this.stats.exportFailures += 1;
        this.stats.droppedSpans += spans.length;
        return;
      }
      if (partial.errorMessage !== undefined && typeof partial.errorMessage !== 'string') {
        this.stats.exportFailures += 1;
        this.stats.droppedSpans += spans.length;
        return;
      }
      if (rejected === 0 && !partial.errorMessage) {
        this.stats.exportFailures += 1;
        this.stats.droppedSpans += spans.length;
        return;
      }
      this.stats.rejectedSpans += rejected;
      this.stats.exportedSpans += spans.length - rejected;
      return;
    }
  }

  async #resolveHeaders() {
    const headers = {};
    for (const [name, reference] of Object.entries(this.headers)) {
      let value;
      if (reference.startsWith('env:')) value = this.env[reference.slice(4)];
      else value = await this.secretStore?.get(reference.slice(7));
      if (typeof value !== 'string' || !value || value.length > 8_192 || /[\u0000\r\n]/.test(value))
        throw new Error('OTLP header reference is unavailable or invalid');
      headers[name] = value;
    }
    return headers;
  }

  async #waitBeforeRetry(attempt, retryAfterMs = null) {
    const exponential = Math.min(this.maxRetryDelayMs, 100 * 2 ** attempt);
    const jitter = Math.floor(Math.max(0, Math.min(1, this.random())) * Math.max(1, exponential / 2));
    const delay =
      retryAfterMs === null ? Math.min(this.maxRetryDelayMs, exponential / 2 + jitter) : Math.min(this.maxRetryDelayMs, retryAfterMs);
    if (delay > 0) await this.sleep(delay);
  }
}

export function isSupportedOtlpEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) return false;
    if (url.protocol === 'https:') return true;
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const version = isIP(hostname);
    return hostname === 'localhost' || (version === 4 && hostname.startsWith('127.')) || (version === 6 && hostname === '::1');
  } catch {
    return false;
  }
}

export function validateOtlpHeaderReferences(headers) {
  return validateHeaderReferences(headers);
}

function validateHeaderReferences(headers) {
  if (headers === undefined) return {};
  const blocked = /^(accept|connection|content-length|content-type|host|transfer-encoding|user-agent)$/i;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers) || Object.keys(headers).length > 32)
    throw new TypeError('OTLP headers must be a table with at most 32 entries');
  for (const [name, reference] of Object.entries(headers)) {
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) ||
      blocked.test(name) ||
      typeof reference !== 'string' ||
      (!/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(reference) && !/^secret:[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(reference))
    ) {
      throw new TypeError('OTLP headers must map safe header names to env:VARIABLE or secret:vault.key references');
    }
  }
  return { ...headers };
}

function spanKey(record, family) {
  return `${record.run_id}\0${family.name}\0${family.name === 'tool.execution' ? record.tool || '' : ''}`;
}

function buildSpan(start, end, family, spanId, parentSpanId, incomplete = false) {
  const traceId = String(start.correlation_id || '')
    .replaceAll('-', '')
    .toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(traceId) || traceId === '00000000000000000000000000000000') return null;
  const endMs = validTime(end.timestamp);
  const startMs = Math.min(validTime(start.timestamp), endMs);
  const merged = { ...start, ...end };
  const attributes = [
    stringAttribute('xyst.event.started', start.event),
    stringAttribute('xyst.event.ended', incomplete ? 'incomplete' : end.event),
    stringAttribute('xyst.run_id', start.run_id),
    stringAttribute('xyst.correlation_id', start.correlation_id),
    stringAttribute('xyst.session_id', merged.session_id),
    stringAttribute('xyst.model', merged.model),
    stringAttribute('xyst.tool', merged.tool),
    stringAttribute('xyst.status', merged.status),
    stringAttribute('xyst.outcome', merged.outcome),
    stringAttribute('xyst.error_code', merged.error_code),
    integerAttribute('xyst.sequence', merged.sequence),
    integerAttribute('xyst.turn', merged.turn),
    integerAttribute('xyst.matches', merged.matches),
    integerAttribute('xyst.memory_items', merged.memory_items),
    integerAttribute('xyst.active_goals', merged.active_goals),
    integerAttribute('xyst.archived_messages', merged.archived_messages),
    integerAttribute('xyst.retained_messages', merged.retained_messages),
    integerAttribute('xyst.input_tokens', merged.input_tokens),
    integerAttribute('xyst.output_tokens', merged.output_tokens),
    integerAttribute('xyst.cached_input_tokens', merged.cached_input_tokens),
    numberAttribute('xyst.duration_ms', merged.duration_ms),
    numberAttribute('xyst.estimated_cost_usd', merged.estimated_cost_usd),
    incomplete ? { key: 'xyst.incomplete', value: { boolValue: true } } : null,
  ].filter(Boolean);
  const failed =
    !incomplete &&
    (String(end.event).endsWith('_failed') || Boolean(end.error_code) || ['failed', 'timed_out', 'error'].includes(merged.status));
  return {
    traceId,
    spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    name: family.name,
    kind: 1,
    flags: 1,
    startTimeUnixNano: (BigInt(startMs) * 1_000_000n).toString(),
    endTimeUnixNano: (BigInt(endMs) * 1_000_000n).toString(),
    attributes,
    ...(failed ? { status: { code: 2 } } : {}),
  };
}

function eventSpanName(event) {
  return `xyst.event.${String(event || 'unknown')
    .replace(/[^a-z0-9_]/gi, '_')
    .replaceAll('_', '.')}`;
}

function stringAttribute(key, value) {
  return typeof value === 'string' && value.length <= 256 ? { key, value: { stringValue: value } } : null;
}

function integerAttribute(key, value) {
  return Number.isSafeInteger(value) && value >= 0 ? { key, value: { intValue: String(value) } } : null;
}

function numberAttribute(key, value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? { key, value: { doubleValue: value } } : null;
}

function createExportRequest(spans) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'xyst-agent' } }] },
        scopeSpans: [{ scope: { name: 'xyst.observability', version: '1' }, spans: spans.filter(Boolean) }],
      },
    ],
  };
}

function createSpanId() {
  let id = '0000000000000000';
  while (id === '0000000000000000') id = randomBytes(8).toString('hex');
  return id;
}

function validTime(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function parseRetryAfter(value, nowMs) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(5_000, Math.ceil(seconds * 1_000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(5_000, Math.max(0, date - nowMs)) : null;
}

async function readBoundedResponse(response, maxBytes) {
  const declaredLength = Number(response.headers?.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error('response too large');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel();
        throw new Error('response too large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, receivedBytes).toString('utf8');
}
