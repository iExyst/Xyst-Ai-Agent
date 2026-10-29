import { readBoundedJsonResponse } from './http-json.mjs';

const valid = (value) => Number.isSafeInteger(value) && value >= 1 && value <= 10_000_000;
export const DEFAULT_CONTEXT_CEILING = 250000;

/** Read the capacity actually allocated by the inference host. Never substitute
 * this computer's RAM for the resources of a remote or proxied model server. */
export async function resolveContextCapacity(profile, { fetchImpl = fetch, apiKey, signal, timeoutMs = 1500 } = {}) {
  const configured = valid(profile.context_length) ? profile.context_length : 8192;
  if (profile.context_mode === 'manual') return { context_length: configured, source: 'manual', automatic: false };
  let endpoint;
  try {
    endpoint = new URL(profile.base_url);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
      throw new Error('Invalid model endpoint');
  } catch {
    return { context_length: Math.min(8192, configured), source: 'configured-fallback', automatic: true };
  }
  const automatic = profile.context_mode !== 'manual';
  const headers = { accept: 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean));
  const read = async (path) => {
    try {
      const response = await fetchImpl(`${endpoint.origin}${path}`, { headers, redirect: 'error', signal: requestSignal });
      if (!response.ok) return null;
      return await readBoundedJsonResponse(response, 1_048_576, 'Model context capacity');
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      return null;
    }
  };
  // Native management APIs apply only to the standard /v1 root. Custom proxy
  // paths and hosted providers use their own advertised metadata instead.
  const native = endpoint.pathname.replace(/\/$/, '') === '/v1';
  const probes = native ? await Promise.all([read('/api/v1/models'), read('/api/ps'), read('/props')]) : [null, null, null];
  const [studio, ollama, llama] = probes;
  const studioLengths = (Array.isArray(studio?.models) ? studio.models : [])
    .flatMap((item) =>
      (Array.isArray(item?.loaded_instances) ? item.loaded_instances : []).filter(
        (instance) => instance && (item.key === profile.model || instance.id === profile.model),
      ),
    )
    .map((instance) => instance.config?.context_length)
    .filter(valid);
  const ollamaLengths = (Array.isArray(ollama?.models) ? ollama.models : [])
    .filter((item) => item && (item.name === profile.model || item.model === profile.model || `${profile.model}:latest` === item.name))
    .map((item) => item.context_length)
    .filter(valid);
  let reported;
  let source;
  if (studioLengths.length) {
    reported = Math.min(...studioLengths);
    source = 'lm-studio-loaded';
  } else if (ollamaLengths.length) {
    reported = Math.min(...ollamaLengths);
    source = 'ollama-loaded';
  } else if (
    valid(llama?.default_generation_settings?.n_ctx) &&
    (llama.model_alias === profile.model || llama.default_generation_settings.model === profile.model)
  ) {
    reported = llama.default_generation_settings.n_ctx;
    source = 'llama-cpp-loaded';
  } else {
    const catalog = await read(`${endpoint.pathname.replace(/\/$/, '')}/models`);
    const item = (Array.isArray(catalog?.data) ? catalog.data : []).find((model) => model?.id === profile.model);
    const value = item?.max_model_len ?? item?.context_length;
    if (valid(value)) {
      reported = value;
      source = 'provider-reported';
    }
  }
  if (signal?.aborted) throw signal.reason || new Error('Cancelled');
  return {
    context_length: Math.min(DEFAULT_CONTEXT_CEILING, reported || Math.min(8192, configured)),
    source: source || 'configured-fallback',
    automatic,
  };
}
