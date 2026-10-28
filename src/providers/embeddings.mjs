import { createHash } from 'node:crypto';

const MAX_BATCH = 32;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** OpenAI-compatible embedding endpoint with strict vector and response bounds. */
export class OpenAICompatibleEmbeddingProvider {
  constructor({ baseUrl, model, apiKey = null, timeoutMs = 60_000, fetchImpl = fetch } = {}) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new TypeError('Embedding URL must be HTTP(S) without credentials, query, or fragment');
    }
    if (typeof model !== 'string' || !model.trim() || model.length > 200) throw new TypeError('Embedding model must be a non-empty name');
    this.endpoint = `${url.toString().replace(/\/$/, '')}/embeddings`;
    this.model = model;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  async embed(input, { signal, onUsage } = {}) {
    const texts = typeof input === 'string' ? [input] : input;
    if (
      !Array.isArray(texts) ||
      texts.length < 1 ||
      texts.length > MAX_BATCH ||
      texts.some((text) => typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 16_000)
    ) {
      throw new TypeError(`Embedding input must contain 1-${MAX_BATCH} non-empty strings of at most 16000 bytes`);
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(Object.assign(new Error('Embedding request timed out'), { code: 'REQUEST_TIMEOUT' })),
      this.timeoutMs,
    );
    const abort = () => controller.abort(signal.reason || Object.assign(new Error('Embedding request cancelled'), { code: 'CANCELLED' }));
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) abort();
      const response = await this.fetch(this.endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify({ model: this.model, input: texts }),
      });
      const raw = await readBounded(response, MAX_RESPONSE_BYTES);
      if (!response.ok)
        throw Object.assign(new Error(`Embedding provider returned HTTP ${response.status}`), {
          code: response.status === 429 ? 'RATE_LIMITED' : 'EMBEDDING_PROVIDER_ERROR',
        });
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        throw Object.assign(new Error('Embedding provider returned invalid JSON'), { code: 'INVALID_RESPONSE' });
      }
      if (!isRecord(data) || !Array.isArray(data.data) || data.data.length !== texts.length)
        throw Object.assign(new Error('Embedding provider returned an unexpected vector count'), { code: 'INVALID_RESPONSE' });
      const vectors = new Array(texts.length);
      let dimensions = null;
      for (const item of data.data) {
        if (!isRecord(item) || !Number.isInteger(item.index) || item.index < 0 || item.index >= texts.length || vectors[item.index])
          throw Object.assign(new Error('Embedding response contains an invalid index'), { code: 'INVALID_RESPONSE' });
        const vector = item.embedding;
        if (
          !Array.isArray(vector) ||
          vector.length < 1 ||
          vector.length > 8192 ||
          vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))
        )
          throw Object.assign(new Error('Embedding response contains an invalid vector'), { code: 'INVALID_RESPONSE' });
        if (dimensions !== null && dimensions !== vector.length)
          throw Object.assign(new Error('Embedding vectors have inconsistent dimensions'), { code: 'INVALID_RESPONSE' });
        dimensions = vector.length;
        vectors[item.index] = vector;
      }
      if (typeof onUsage === 'function') {
        const reported = data.usage?.prompt_tokens;
        const validReported = Number.isSafeInteger(reported) && reported >= 0;
        await onUsage({
          inputTokens: validReported ? reported : texts.reduce((sum, text) => sum + Math.max(1, Math.ceil(text.length / 4)), 0),
          outputTokens: 0,
          inputTokenSource: validReported ? 'provider_reported' : 'estimated',
          outputTokenSource: 'estimated',
          model: this.model,
        });
      }
      return vectors;
    } catch (error) {
      if (controller.signal.aborted)
        throw controller.signal.reason || Object.assign(new Error('Embedding request cancelled'), { code: 'CANCELLED' });
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
}

export function embeddingIdentity(model, dimensions) {
  return createHash('sha256').update(`${model}\0${dimensions}`).digest('hex');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readBounded(response, maxBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw Object.assign(new Error('Embedding response exceeded its size limit'), { code: 'RESPONSE_TOO_LARGE' });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(all);
  } catch (cause) {
    throw Object.assign(new Error('Embedding provider returned invalid UTF-8 JSON', { cause }), { code: 'INVALID_RESPONSE' });
  }
}
