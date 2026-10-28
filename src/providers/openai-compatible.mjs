import { readBoundedJsonResponse, readBoundedTextResponse } from './http-json.mjs';

const MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_MODEL_LIST_RESPONSE_BYTES = 1024 * 1024;
const MAX_MODELS = 500;
const MAX_MODEL_ID_LENGTH = 256;
const MAX_STREAM_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 4 * 1024;

export class ProviderError extends Error {
  constructor(message, { code = 'PROVIDER_ERROR', status = null, retryable = false, retryAfterMs = null, cause } = {}) {
    super(message, { cause });
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export class OpenAICompatibleProvider {
  constructor({ baseUrl, model, apiKey = null, timeoutMs = 120_000, fetchImpl = fetch, promptCache = null, reasoningEffort }) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('Provider URL must use HTTP or HTTPS');
    if (url.username || url.password || url.search || url.hash)
      throw new TypeError('Provider URL cannot contain credentials, query parameters, or a fragment');
    this.baseUrl = url.toString().replace(/\/$/, '');
    this.model = model;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    if (reasoningEffort !== undefined && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(reasoningEffort))
      throw new TypeError('Reasoning effort must be none, minimal, low, medium, high, or xhigh');
    this.reasoningEffort = reasoningEffort;
    if (promptCache !== null && (!promptCache || typeof promptCache !== 'object' || Array.isArray(promptCache)))
      throw new TypeError('Prompt cache options must be an object or null');
    if (promptCache?.enabled !== undefined && typeof promptCache.enabled !== 'boolean')
      throw new TypeError('Prompt cache enabled option must be boolean');
    if (
      promptCache?.key !== undefined &&
      (typeof promptCache.key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(promptCache.key))
    )
      throw new TypeError('Prompt cache key must be a non-sensitive identifier of at most 64 characters');
    if (promptCache?.retention !== undefined && promptCache.retention !== '24h') throw new TypeError('Prompt cache retention must be 24h');
    this.promptCache = promptCache?.enabled === true ? { ...promptCache } : null;
  }

  async listModels({ signal } = {}) {
    return (await this.listModelsDetailed({ signal })).models;
  }

  async listModelsDetailed({ signal } = {}) {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const response = await this.#fetch('/models', { method: 'GET', signal, timeoutSignal });
    const data = await parseJson(response, MAX_MODEL_LIST_RESPONSE_BYTES, 'Model list response', { signal, timeoutSignal });
    if (!isRecord(data) || !Array.isArray(data.data))
      throw new ProviderError('Provider returned an invalid model list', { code: 'INVALID_RESPONSE' });
    const models = [];
    const seenIds = new Set();
    let truncated = data.data.length > MAX_MODELS;
    for (const item of data.data) {
      if (typeof item?.id !== 'string' || !item.id.trim() || item.id.length > MAX_MODEL_ID_LENGTH || seenIds.has(item.id)) {
        truncated = true;
        continue;
      }
      if (models.length >= MAX_MODELS) {
        truncated = true;
        continue;
      }
      seenIds.add(item.id);
      models.push({
        id: item.id,
        ...(typeof item.object === 'string' && item.object.length <= 64 ? { object: item.object } : {}),
        ...(Number.isSafeInteger(item.created) && item.created >= 0 ? { created: item.created } : {}),
        ...(typeof item.owned_by === 'string' && item.owned_by.length <= 128 ? { owned_by: item.owned_by } : {}),
      });
    }
    return { models, truncated };
  }

  async chat(messages, { tools = [], toolChoice, temperature, maxTokens, responseFormat, signal, timeoutMs = this.timeoutMs } = {}) {
    const body = { model: this.model, messages, stream: false };
    if (tools.length) body.tools = tools.map(toOpenAITool);
    if (tools.length && toolChoice !== undefined) body.tool_choice = toolChoice;
    if (temperature !== undefined) body.temperature = temperature;
    if (maxTokens !== undefined) body.max_tokens = maxTokens;
    if (responseFormat !== undefined) body.response_format = responseFormat;
    if (this.reasoningEffort !== undefined) body.reasoning_effort = this.reasoningEffort;
    applyPromptCacheOptions(body, this.promptCache);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const response = await this.#fetch('/chat/completions', {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
      timeoutSignal,
    });
    const data = await parseJson(response, MAX_JSON_RESPONSE_BYTES, 'Provider response', { signal, timeoutSignal });
    if (!isRecord(data) || !Array.isArray(data.choices))
      throw new ProviderError('Provider returned an invalid assistant response', { code: 'INVALID_RESPONSE' });
    const choice = data.choices?.[0];
    if (!choice?.message) throw new ProviderError('Provider returned no assistant message', { code: 'INVALID_RESPONSE' });
    if (!isValidFinishReason(choice.finish_reason))
      throw new ProviderError('Provider returned an invalid finish reason', { code: 'INVALID_RESPONSE' });
    return normalizeResponse(choice.message, data.usage, choice.finish_reason);
  }

  async *stream(messages, { tools = [], toolChoice, temperature, maxTokens, responseFormat, signal, timeoutMs = this.timeoutMs } = {}) {
    const body = { model: this.model, messages, stream: true, stream_options: { include_usage: true } };
    if (tools.length) body.tools = tools.map(toOpenAITool);
    if (tools.length && toolChoice !== undefined) body.tool_choice = toolChoice;
    if (temperature !== undefined) body.temperature = temperature;
    if (maxTokens !== undefined) body.max_tokens = maxTokens;
    if (responseFormat !== undefined) body.response_format = responseFormat;
    if (this.reasoningEffort !== undefined) body.reasoning_effort = this.reasoningEffort;
    applyPromptCacheOptions(body, this.promptCache);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const response = await this.#fetch('/chat/completions', {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
      timeoutSignal,
    });
    if (!response.body) throw new ProviderError('Provider response has no stream body', { code: 'INVALID_RESPONSE' });
    const decoder = new TextDecoder();
    let buffer = '';
    let responseBytes = 0;
    const state = { content: '', calls: new Map(), usage: null, finishReason: null, sawEvent: false };
    try {
      for await (const chunk of response.body) {
        responseBytes += chunk.byteLength;
        if (responseBytes > MAX_STREAM_RESPONSE_BYTES)
          throw new ProviderError('Provider stream exceeded the 16777216-byte limit', { code: 'INVALID_STREAM' });
        buffer += decoder.decode(chunk, { stream: true });
        let boundary;
        while ((boundary = findSseBoundary(buffer))) {
          const frame = normalizeSseLineEndings(buffer.slice(0, boundary.index));
          buffer = buffer.slice(boundary.index + boundary.length);
          for (const data of parseSseFrame(frame)) {
            if (data === '[DONE]') {
              if (!state.sawEvent) throw new ProviderError('Provider stream ended before any response events', { code: 'INVALID_STREAM' });
              completeStreamFromDone(state);
              yield { type: 'done', response: finishStream(state) };
              return;
            }
            let event;
            try {
              event = JSON.parse(data);
            } catch (cause) {
              throw new ProviderError('Malformed JSON in provider event stream', { code: 'INVALID_STREAM', cause });
            }
            validateStreamEvent(event, state);
            const delta = event.choices?.[0]?.delta;
            if (typeof delta?.content === 'string' && delta.content) {
              state.content += delta.content;
              yield { type: 'text', text: delta.content };
            }
            for (const call of delta?.tool_calls || []) {
              const current = state.calls.get(call.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
              if (call.id) current.id = call.id;
              if (call.function?.name) current.function.name += call.function.name;
              if (call.function?.arguments) current.function.arguments += call.function.arguments;
              state.calls.set(call.index, current);
            }
            if (event.usage) state.usage = event.usage;
            if (event.choices?.[0]?.finish_reason) state.finishReason = event.choices[0].finish_reason;
          }
        }
      }
      buffer += decoder.decode();
      for (const data of parseSseFrame(normalizeSseLineEndings(buffer))) {
        if (data === '[DONE]') {
          if (!state.sawEvent) throw new ProviderError('Provider stream ended before any response events', { code: 'INVALID_STREAM' });
          completeStreamFromDone(state);
          break;
        }
        let event;
        try {
          event = JSON.parse(data);
        } catch (cause) {
          throw new ProviderError('Malformed final JSON in provider event stream', { code: 'INVALID_STREAM', cause });
        }
        validateStreamEvent(event, state);
        const delta = event.choices?.[0]?.delta;
        if (typeof delta?.content === 'string' && delta.content) {
          state.content += delta.content;
          yield { type: 'text', text: delta.content };
        }
        for (const call of delta?.tool_calls || []) {
          const current = state.calls.get(call.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (call.id) current.id = call.id;
          if (call.function?.name) current.function.name += call.function.name;
          if (call.function?.arguments) current.function.arguments += call.function.arguments;
          state.calls.set(call.index, current);
        }
        if (event.usage) state.usage = event.usage;
        if (event.choices?.[0]?.finish_reason) state.finishReason = event.choices[0].finish_reason;
      }
      if (!state.sawEvent) throw new ProviderError('Provider stream ended before any response events', { code: 'INVALID_STREAM' });
      assertStreamFinished(state);
      yield { type: 'done', response: finishStream(state) };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      const cancelled = signal?.aborted === true;
      const timedOut = !cancelled && (timeoutSignal.aborted || error?.name === 'TimeoutError');
      throw new ProviderError(
        cancelled ? 'Provider request cancelled' : timedOut ? 'Provider request timed out' : 'Provider stream failed',
        {
          code: cancelled ? 'CANCELLED' : timedOut ? 'REQUEST_TIMEOUT' : 'STREAM_FAILED',
          retryable: timedOut,
          cause: error,
        },
      );
    }
  }

  async #fetch(endpoint, { method, body, signal, timeoutSignal }) {
    const headers = {
      'content-type': 'application/json',
      accept: endpoint === '/chat/completions' && JSON.parse(body || '{}').stream ? 'text/event-stream' : 'application/json',
    };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${endpoint}`, {
        method,
        headers,
        body,
        redirect: 'error',
        signal: combineSignals(signal, timeoutSignal),
      });
    } catch (cause) {
      const cancelled = signal?.aborted === true;
      const timedOut = !cancelled && (timeoutSignal.aborted || cause?.name === 'TimeoutError');
      const code = cancelled ? 'CANCELLED' : timedOut ? 'REQUEST_TIMEOUT' : 'CONNECTION_FAILED';
      const message = cancelled ? 'Provider request cancelled' : timedOut ? 'Provider request timed out' : 'Could not connect to provider';
      throw new ProviderError(message, {
        code,
        retryable: !cancelled,
        cause,
      });
    }
    if (!response.ok) {
      const detail = await readBoundedTextResponse(response, MAX_ERROR_RESPONSE_BYTES).catch(() => '');
      const safeDetail = detail
        .slice(0, 500)
        .replace(/(authorization|api[_-]?key|token)\s*[:=]\s*[^\s,;"']+/gi, '$1=[redacted]')
        .replaceAll(this.apiKey || '\u0000', '[redacted]');
      const status = response.status;
      const code = classifyHttpError(status, safeDetail, endpoint);
      throw new ProviderError(`Provider returned HTTP ${status}${safeDetail ? `: ${safeDetail}` : ''}`, {
        code,
        status,
        retryable: status === 429 || code === 'PROVIDER_UNAVAILABLE',
        retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
      });
    }
    return response;
  }
}

function applyPromptCacheOptions(body, options) {
  if (!options) return;
  if (options.key) body.prompt_cache_key = options.key;
  if (options.retention === '24h') body.prompt_cache_retention = '24h';
}

function parseRetryAfter(value) {
  if (!value) return null;
  const normalized = value.trim();
  if (/^\d+$/.test(normalized)) return Math.min(60_000, Number(normalized) * 1000);
  if (!/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(normalized)) return null;
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toUTCString() !== normalized) return null;
  return Math.max(0, Math.min(60_000, timestamp - Date.now()));
}

function classifyHttpError(status, detail, endpoint) {
  if (status === 401 || status === 403) return 'AUTHENTICATION_FAILED';
  if (status === 429) return 'RATE_LIMITED';
  const isChatRequest = endpoint === '/chat/completions';
  if (isChatRequest && (status === 413 || (status === 400 && indicatesContextOverflow(detail)))) return 'CONTEXT_OVERFLOW';
  if ([500, 502, 503, 504].includes(status)) return 'PROVIDER_UNAVAILABLE';
  if (status === 400) return 'BAD_REQUEST';
  return 'HTTP_ERROR';
}

function indicatesContextOverflow(detail) {
  return (
    /context(?:[_\s-]+(?:length|window|size))?[_\s-]*(?:has[_\s-]+been[_\s-]+)?(?:exceeded|exceeds|overflow|limit)/i.test(detail) ||
    /(?:exceeded|exceeds|overflow|too many tokens).{0,100}context/i.test(detail) ||
    /maximum context length|too many tokens/i.test(detail)
  );
}

function combineSignals(first, second) {
  return first ? AbortSignal.any([first, second]) : second;
}

async function parseJson(response, maxBytes = MAX_JSON_RESPONSE_BYTES, label = 'Provider response', { signal, timeoutSignal } = {}) {
  try {
    return await readBoundedJsonResponse(response, maxBytes, label);
  } catch (cause) {
    const cancelled = signal?.aborted === true;
    const timedOut = !cancelled && (timeoutSignal?.aborted || cause?.name === 'TimeoutError');
    if (cancelled) throw new ProviderError('Provider request cancelled', { code: 'CANCELLED', retryable: false, cause });
    if (timedOut) throw new ProviderError('Provider request timed out', { code: 'REQUEST_TIMEOUT', retryable: true, cause });
    throw new ProviderError(`${label} is invalid or exceeds its size limit`, { code: 'INVALID_RESPONSE', cause });
  }
}

function normalizeResponse(message, usage, finishReason = null) {
  if (!message || typeof message !== 'object' || Array.isArray(message))
    throw new ProviderError('Provider returned an invalid assistant message', { code: 'INVALID_RESPONSE' });
  if (message.content !== undefined && message.content !== null && typeof message.content !== 'string')
    throw new ProviderError('Provider returned invalid assistant content', { code: 'INVALID_RESPONSE' });
  const rawToolCalls = message.tool_calls ?? [];
  if (!Array.isArray(rawToolCalls)) throw new ProviderError('Provider returned an invalid tool call list', { code: 'INVALID_RESPONSE' });
  if (rawToolCalls.some((call) => !call || typeof call !== 'object' || Array.isArray(call)))
    throw new ProviderError('Provider returned an invalid tool call', { code: 'INVALID_RESPONSE' });
  if (
    rawToolCalls.some(
      (call) =>
        !call.function ||
        typeof call.function !== 'object' ||
        Array.isArray(call.function) ||
        (call.function.name !== undefined && typeof call.function.name !== 'string') ||
        (call.function.arguments !== undefined && typeof call.function.arguments !== 'string'),
    )
  )
    throw new ProviderError('Provider returned an invalid tool call function', { code: 'INVALID_RESPONSE' });
  const toolCalls = normalizeToolCallIds(
    rawToolCalls.map((call) => ({
      id: call?.id,
      name: call?.function?.name,
      arguments: call?.function?.arguments ?? '{}',
    })),
  );
  if (toolCalls.some((call) => typeof call.name !== 'string' || !call.name || typeof call.arguments !== 'string')) {
    throw new ProviderError('Provider returned an incomplete tool call', { code: 'INVALID_RESPONSE' });
  }
  const normalized = {
    content: typeof message.content === 'string' ? message.content : '',
    toolCalls,
    usage: normalizeUsage(usage),
    finishReason,
  };
  assertUsableCompletion(normalized);
  return normalized;
}

function finishStream(state) {
  const toolCalls = normalizeToolCallIds(
    [...state.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments || '{}',
      })),
  );
  if (toolCalls.some((call) => !call.name))
    throw new ProviderError('Provider stream returned an incomplete tool call', { code: 'INVALID_STREAM' });
  const normalized = {
    content: state.content,
    toolCalls,
    usage: normalizeUsage(state.usage),
    finishReason: state.finishReason,
  };
  assertUsableCompletion(normalized);
  return normalized;
}

function assertUsableCompletion(response) {
  if (response.content.trim() || response.toolCalls.length || response.finishReason !== 'length') return;
  throw new ProviderError('Provider exhausted its output limit without returning assistant text or a tool call', {
    code: 'PROVIDER_UNAVAILABLE',
  });
}

function completeStreamFromDone(state) {
  if (!state.finishReason) state.finishReason = state.calls.size ? 'tool_calls' : 'stop';
}

function assertStreamFinished(state) {
  if (!state.finishReason) throw new ProviderError('Provider stream ended before a finish event', { code: 'INVALID_STREAM' });
}

function isValidFinishReason(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim().length > 0);
}

function normalizeToolCallIds(toolCalls) {
  const seen = new Set();
  return toolCalls.map((call, index) => {
    let id = call.id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(id) || seen.has(id)) {
      const base = `xyst_call_${index}`;
      id = base;
      let suffix = 1;
      while (seen.has(id)) id = `${base}_${suffix++}`;
    }
    seen.add(id);
    return { ...call, id };
  });
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const safeCount = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
  const inputTokens = safeCount(usage.prompt_tokens);
  const normalized = {
    inputTokens,
    outputTokens: safeCount(usage.completion_tokens),
    totalTokens: safeCount(usage.total_tokens),
  };
  const cachedInputTokens = safeCount(usage.prompt_tokens_details?.cached_tokens);
  if (cachedInputTokens !== null && inputTokens !== null && cachedInputTokens <= inputTokens)
    normalized.cachedInputTokens = cachedInputTokens;
  return Object.values(normalized).some((value) => value !== null) ? normalized : null;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseSseFrame(frame) {
  const data = [];
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data:')) continue;
    let value = line.slice(5);
    if (value.startsWith(' ')) value = value.slice(1);
    data.push(value);
  }
  return data.length ? [data.join('\n')] : [];
}

function findSseBoundary(buffer) {
  const match = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
  return match ? { index: match.index, length: match[0].length } : null;
}

function normalizeSseLineEndings(frame) {
  return frame.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function validateStreamEvent(event, state) {
  if (!event || typeof event !== 'object' || Array.isArray(event))
    throw new ProviderError('Provider returned an invalid event in its stream', { code: 'INVALID_STREAM' });
  if (event.error !== undefined && event.error !== null)
    throw new ProviderError('Provider returned an error event in its stream', { code: 'STREAM_FAILED' });
  const hasUsage = event.usage && typeof event.usage === 'object' && !Array.isArray(event.usage);
  if (event.choices !== undefined && !Array.isArray(event.choices))
    throw new ProviderError('Provider returned an invalid event in its stream', { code: 'INVALID_STREAM' });
  if ((!Array.isArray(event.choices) || event.choices.length === 0) && !hasUsage)
    throw new ProviderError('Provider returned an invalid event in its stream', { code: 'INVALID_STREAM' });
  for (const choice of event.choices || []) {
    if (!choice || typeof choice !== 'object' || Array.isArray(choice))
      throw new ProviderError('Provider returned an invalid choice in its stream', { code: 'INVALID_STREAM' });
    if (choice.delta !== undefined && (!choice.delta || typeof choice.delta !== 'object' || Array.isArray(choice.delta)))
      throw new ProviderError('Provider returned an invalid delta in its stream', { code: 'INVALID_STREAM' });
    if (choice.delta?.content !== undefined && choice.delta.content !== null && typeof choice.delta.content !== 'string')
      throw new ProviderError('Provider returned invalid content in its stream', { code: 'INVALID_STREAM' });
    if (choice.delta?.tool_calls !== undefined && !Array.isArray(choice.delta.tool_calls))
      throw new ProviderError('Provider returned an invalid tool call list in its stream', { code: 'INVALID_STREAM' });
    for (const call of choice.delta?.tool_calls || []) {
      if (!call || typeof call !== 'object' || Array.isArray(call) || !Number.isSafeInteger(call.index) || call.index < 0)
        throw new ProviderError('Provider returned an invalid tool call fragment in its stream', { code: 'INVALID_STREAM' });
      if (call.function !== undefined && (!call.function || typeof call.function !== 'object' || Array.isArray(call.function)))
        throw new ProviderError('Provider returned an invalid tool call function in its stream', { code: 'INVALID_STREAM' });
      if (
        (call.function?.name !== undefined && typeof call.function.name !== 'string') ||
        (call.function?.arguments !== undefined && typeof call.function.arguments !== 'string')
      )
        throw new ProviderError('Provider returned invalid tool call fields in its stream', { code: 'INVALID_STREAM' });
    }
    if (!isValidFinishReason(choice.finish_reason))
      throw new ProviderError('Provider returned an invalid finish reason in its stream', { code: 'INVALID_STREAM' });
  }
  state.sawEvent = true;
}

function toOpenAITool(tool) {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: toOpenAISchema(tool.parameters) },
  };
}

function toOpenAISchema(schema) {
  const { properties, items } = schema;
  const standardSchema = Object.fromEntries(
    Object.entries(schema).filter(([key]) => key !== 'maxBytes' && key !== 'properties' && key !== 'items'),
  );
  return {
    ...standardSchema,
    ...(properties
      ? { properties: Object.fromEntries(Object.entries(properties).map(([name, property]) => [name, toOpenAISchema(property)])) }
      : {}),
    ...(items ? { items: toOpenAISchema(items) } : {}),
  };
}
