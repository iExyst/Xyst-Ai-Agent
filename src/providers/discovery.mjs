import { readBoundedJsonResponse } from './http-json.mjs';

const DEFAULT_LOCAL_SERVERS = Object.freeze([
  { name: 'ollama', base_url: 'http://127.0.0.1:11434/v1' },
  { name: 'lm-studio', base_url: 'http://127.0.0.1:1234/v1' },
  { name: 'llama-cpp', base_url: 'http://127.0.0.1:8080/v1' },
]);
const LM_STUDIO_API_ROOT = 'http://127.0.0.1:1234/api/v1';
const CACHE_TTL_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_MODELS = 500;
const MAX_CONCURRENT_PROBES = 4;
const discoveryCache = new Map();

/** Probe explicitly configured and common localhost OpenAI-compatible endpoints.
 * Configured endpoints are returned first. No process scan or external network
 * scan is performed.
 */
export async function discoverLocalServers({ config = {}, fetchImpl = fetch, timeoutMs = 800, now = Date.now() } = {}) {
  const configuredEntries = Object.entries(config.local_servers || {});
  if (configuredEntries.length > 16) throw new TypeError('Local server discovery accepts at most 16 configured endpoints');
  const configured = configuredEntries.map(([name, value]) => ({ name, ...value, configured: true }));
  const candidates = [...configured];
  if (config.discovery?.enabled !== false) candidates.push(...DEFAULT_LOCAL_SERVERS.map((server) => ({ ...server, configured: false })));
  const seen = new Set();
  const pending = [];
  for (const candidate of candidates) {
    if (typeof candidate.base_url !== 'string') continue;
    const baseUrl = normalizeBaseUrl(candidate.base_url);
    if (seen.has(baseUrl)) continue;
    seen.add(baseUrl);
    const cached = fetchImpl === fetch ? discoveryCache.get(baseUrl) : null;
    if (cached && cached.expiresAt > now) {
      if (cached.value)
        pending.push(async () => ({
          ...cached.value,
          name: candidate.name || cached.value.name,
          configured: candidate.configured || cached.value.configured,
        }));
      continue;
    }
    pending.push(async () => {
      const value = await probe(candidate, baseUrl, { fetchImpl, timeoutMs });
      if (fetchImpl === fetch) discoveryCache.set(baseUrl, { value, expiresAt: now + CACHE_TTL_MS });
      return value;
    });
  }
  const results = [];
  for (let start = 0; start < pending.length; start += MAX_CONCURRENT_PROBES) {
    const batch = await Promise.all(pending.slice(start, start + MAX_CONCURRENT_PROBES).map((run) => run()));
    results.push(...batch.filter(Boolean));
  }
  return results;
}

/** Return loaded LLM model IDs from a local LM Studio endpoint, or null when its management API is unavailable. */
export async function getLoadedLmStudioModelIds(baseUrl, { fetchImpl = fetch, signal, timeoutMs = 800 } = {}) {
  if (typeof baseUrl !== 'string' || typeof fetchImpl !== 'function') return null;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000)
    throw new TypeError('LM Studio status timeout must be between 1 and 10000 ms');
  let endpoint;
  try {
    endpoint = new URL(baseUrl);
  } catch {
    return null;
  }
  if (
    endpoint.protocol !== 'http:' ||
    endpoint.hostname !== '127.0.0.1' ||
    endpoint.port !== '1234' ||
    endpoint.pathname.replace(/\/$/, '') !== '/v1' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    return null;

  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchImpl(`${endpoint.origin}/api/v1/models`, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: requestSignal,
    });
    if (!response.ok) return null;
    const payload = await readBoundedJsonResponse(response, MAX_RESPONSE_BYTES, 'LM Studio loaded model status');
    if (!Array.isArray(payload?.models)) return null;
    const loaded = new Set();
    for (const model of payload.models.slice(0, MAX_MODELS)) {
      if (
        typeof model?.key === 'string' &&
        model.key.length > 0 &&
        model.key.length <= 256 &&
        model.type === 'llm' &&
        Array.isArray(model.loaded_instances) &&
        model.loaded_instances.length > 0
      )
        loaded.add(model.key);
    }
    return loaded;
  } catch (error) {
    if (signal?.aborted) throw signal.reason || error;
    return null;
  }
}

async function probe(candidate, baseUrl, { fetchImpl, timeoutMs }) {
  try {
    const headers = { accept: 'application/json' };
    const apiKey = candidate.api_key_env ? process.env[candidate.api_key_env] : null;
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const response = await fetchImpl(`${baseUrl}/models`, { headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const data = await readBoundedJsonResponse(response, MAX_RESPONSE_BYTES, 'Model list response');
    if (!Array.isArray(data.data)) return null;
    const models = data.data
      .filter((model) => typeof model?.id === 'string' && model.id.length <= 256)
      .slice(0, MAX_MODELS)
      .map((model) => model.id);
    const result = {
      name: candidate.name || new URL(baseUrl).host,
      base_url: baseUrl,
      configured: candidate.configured === true,
      models,
      models_truncated: data.data.length > models.length,
    };
    const modelMetadata = await probeLmStudioModels(baseUrl, models, { fetchImpl, timeoutMs });
    if (Object.keys(modelMetadata.contextLengths).length) result.model_context_lengths = modelMetadata.contextLengths;
    if (Object.keys(modelMetadata.states).length) result.model_states = modelMetadata.states;
    if (Object.keys(modelMetadata.capabilities).length) result.model_capabilities = modelMetadata.capabilities;
    return result;
  } catch {
    return null;
  }
}

async function probeLmStudioModels(baseUrl, modelIds, { fetchImpl, timeoutMs }) {
  const endpoint = new URL(baseUrl);
  if (endpoint.protocol !== 'http:' || endpoint.port !== '1234' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname))
    return { contextLengths: {}, states: {}, capabilities: {} };
  try {
    const response = await fetchImpl(`${endpoint.origin}/api/v1/models`, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { contextLengths: {}, states: {}, capabilities: {} };
    const data = await readBoundedJsonResponse(response, MAX_RESPONSE_BYTES, 'LM Studio model metadata response');
    if (!Array.isArray(data.models)) return { contextLengths: {}, states: {}, capabilities: {} };
    const ids = new Set(modelIds);
    const contexts = {};
    const states = {};
    const capabilities = {};
    const contextsByModel = new Map();
    for (const model of data.models.slice(0, MAX_MODELS)) {
      if (typeof model?.key !== 'string' || !ids.has(model.key)) continue;
      if (Array.isArray(model.loaded_instances)) {
        if (model.loaded_instances.length > 0) states[model.key] = 'loaded';
        else if (states[model.key] !== 'loaded') states[model.key] = 'not_loaded';
        const lengths = model.loaded_instances
          .map((instance) => instance?.config?.context_length)
          .filter((value) => Number.isSafeInteger(value) && value > 0 && value <= 10_000_000);
        if (lengths.length) contextsByModel.set(model.key, [...(contextsByModel.get(model.key) || []), ...lengths]);
      }
      const reported = {};
      if (typeof model.capabilities?.trained_for_tool_use === 'boolean') reported.supports_tools = model.capabilities.trained_for_tool_use;
      if (typeof model.capabilities?.vision === 'boolean') reported.supports_vision = model.capabilities.vision;
      if (Object.keys(reported).length) {
        const combined = (capabilities[model.key] ||= {});
        for (const [name, supported] of Object.entries(reported)) {
          combined[name] = combined[name] === undefined ? supported : combined[name] && supported;
        }
      }
    }
    for (const [model, lengths] of contextsByModel) contexts[model] = Math.min(...lengths);
    return { contextLengths: contexts, states, capabilities };
  } catch {
    // Older LM Studio versions may not expose the native model-management API.
    return { contextLengths: {}, states: {}, capabilities: {} };
  }
}

/** Load an already-installed LM Studio LLM. This never downloads a model. */
export async function loadLmStudioModel(modelId, { fetchImpl = fetch, signal, timeoutMs = 10 * 60_000 } = {}) {
  if (typeof modelId !== 'string' || !modelId.trim() || modelId.length > 256 || /[\u0000-\u001f\u007f]/.test(modelId))
    throw modelManagementError('LM_STUDIO_MODEL_INVALID', 'A valid LM Studio model ID is required', 400);
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15 * 60_000)
    throw new TypeError('LM Studio load timeout must be between 1 ms and 15 minutes');

  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const model = modelId.trim();
  let catalog;
  try {
    const response = await fetchImpl(`${LM_STUDIO_API_ROOT}/models`, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: requestSignal,
    });
    if (!response.ok) throw modelManagementError('LM_STUDIO_UNAVAILABLE', 'LM Studio model management is unavailable', 502);
    catalog = await readBoundedJsonResponse(response, MAX_RESPONSE_BYTES, 'LM Studio model catalog');
  } catch (error) {
    if (error.code) throw error;
    if (signal?.aborted) throw error;
    if (requestSignal.aborted)
      throw modelManagementError('LM_STUDIO_TIMEOUT', 'LM Studio did not respond before the model load request timed out', 504);
    throw modelManagementError('LM_STUDIO_UNAVAILABLE', 'Could not read the LM Studio model catalog', 502);
  }

  const entries = Array.isArray(catalog?.models)
    ? catalog.models.filter((candidate) => candidate?.key === model && candidate.type === 'llm')
    : [];
  if (!entries.length) throw modelManagementError('LM_STUDIO_MODEL_NOT_FOUND', 'That installed LLM was not found in LM Studio', 404);
  const loadedEntry = entries.find((candidate) => Array.isArray(candidate.loaded_instances) && candidate.loaded_instances.length > 0);
  if (loadedEntry) {
    const contextLength = getModelContextLength(loadedEntry);
    return { model, loaded: true, already_loaded: true, ...(contextLength ? { context_length: contextLength } : {}) };
  }

  let loaded;
  try {
    const response = await fetchImpl(`${LM_STUDIO_API_ROOT}/models/load`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ model, echo_load_config: true }),
      redirect: 'error',
      signal: requestSignal,
    });
    if (!response.ok)
      throw modelManagementError('LM_STUDIO_LOAD_FAILED', `LM Studio rejected the model load (HTTP ${response.status})`, 502);
    loaded = await readBoundedJsonResponse(response, MAX_RESPONSE_BYTES, 'LM Studio model load response');
  } catch (error) {
    if (error.code) throw error;
    if (signal?.aborted) throw error;
    if (requestSignal.aborted)
      throw modelManagementError('LM_STUDIO_TIMEOUT', 'LM Studio did not finish loading the model before the request timed out', 504);
    throw modelManagementError('LM_STUDIO_LOAD_FAILED', 'LM Studio could not load the selected model', 502);
  }
  if (loaded?.status !== 'loaded')
    throw modelManagementError('LM_STUDIO_LOAD_FAILED', 'LM Studio did not confirm that the model finished loading', 502);
  discoveryCache.delete('http://127.0.0.1:1234/v1');
  const contextLength = Number.isSafeInteger(loaded.load_config?.context_length) ? loaded.load_config.context_length : null;
  return { model, loaded: true, already_loaded: false, ...(contextLength ? { context_length: contextLength } : {}) };
}

function getModelContextLength(model) {
  const lengths = model.loaded_instances
    .map((instance) => instance?.config?.context_length)
    .filter((value) => Number.isSafeInteger(value) && value > 0 && value <= 10_000_000);
  return lengths.length ? Math.min(...lengths) : null;
}

function modelManagementError(code, message, statusCode) {
  return Object.assign(new Error(message), { code, statusCode });
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('Local server URL must use HTTP or HTTPS');
  if (url.username || url.password || url.search || url.hash)
    throw new TypeError('Local server URL cannot contain credentials, query parameters, or a fragment');
  return url.toString().replace(/\/$/, '');
}
