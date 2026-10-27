import { OpenAICompatibleProvider } from './openai-compatible.mjs';

/** Default factory for the configured local and remote OpenAI-compatible profiles. */
export function createOpenAICompatibleProvider(profile, { apiKey = null, fetchImpl = fetch, timeoutMs } = {}) {
  if (!profile || typeof profile !== 'object') throw new TypeError('A model profile is required to create a provider');
  return new OpenAICompatibleProvider({
    baseUrl: profile.base_url,
    model: profile.model,
    apiKey,
    timeoutMs: timeoutMs ?? profile.timeout_ms ?? 120_000,
    fetchImpl,
    reasoningEffort: profile.reasoning_effort,
    promptCache: profile.prompt_cache_enabled
      ? {
          enabled: true,
          ...(profile.prompt_cache_key ? { key: profile.prompt_cache_key } : {}),
          ...(profile.prompt_cache_retention ? { retention: profile.prompt_cache_retention } : {}),
        }
      : null,
  });
}

export function assertModelProvider(provider) {
  if (
    !provider ||
    typeof provider.listModels !== 'function' ||
    typeof provider.chat !== 'function' ||
    typeof provider.stream !== 'function'
  ) {
    throw new TypeError('Provider factory must return a ModelProvider with listModels, chat, and stream methods');
  }
  return provider;
}
