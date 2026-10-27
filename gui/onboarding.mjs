const PROFILE_NAME_LIMIT = 64;
const MODEL_ID_LIMIT = 200;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function markDiscoveredModelLoaded(choice, loadResult) {
  if (!choice?.server || typeof choice.model !== 'string') return;
  choice.server.model_states = { ...choice.server.model_states, [choice.model]: 'loaded' };
  const contextLength = loadResult?.context_length;
  if (Number.isSafeInteger(contextLength) && contextLength > 0)
    choice.server.model_context_lengths = { ...choice.server.model_context_lengths, [choice.model]: contextLength };
}

export function postLoadModelChoice(choice, choices, alreadyConfigured) {
  if (alreadyConfigured) return null;
  return choices.find((item) => item.model === choice.model && item.server.base_url === choice.server.base_url) || choice;
}

export function localProfileFromDiscovery(server, modelId, existingProfiles = {}) {
  if (!server || typeof server !== 'object' || typeof server.name !== 'string' || typeof server.base_url !== 'string')
    throw new TypeError('A discovered local model server is required');
  if (typeof modelId !== 'string' || !modelId.trim() || modelId.length > MODEL_ID_LIMIT)
    throw new TypeError(`Model ID must contain between 1 and ${MODEL_ID_LIMIT} characters`);
  let endpoint;
  try {
    endpoint = new URL(server.base_url);
  } catch {
    throw new TypeError('Discovered model server URL is invalid');
  }
  if (!['http:', 'https:'].includes(endpoint.protocol) || !LOOPBACK_HOSTS.has(endpoint.hostname))
    throw new TypeError('First-run setup accepts loopback model servers only');
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new TypeError('Discovered model server URL contains unsupported components');

  const baseName =
    `${server.name}-${modelId}`
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, '-')
      .replace(/[-_.]{2,}/g, '-')
      .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
      .slice(0, PROFILE_NAME_LIMIT) || 'local-model';
  let name = baseName;
  for (let suffix = 2; Object.hasOwn(existingProfiles, name); suffix += 1) {
    const tail = `-${suffix}`;
    name = `${baseName.slice(0, PROFILE_NAME_LIMIT - tail.length).replace(/[-_.]+$/g, '')}${tail}`;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) throw new Error('Could not create a valid model profile name');
  const contextLength = server.model_context_lengths?.[modelId.trim()];
  const reportedCapabilities = server.model_capabilities?.[modelId.trim()];
  return {
    name,
    profile: {
      provider: 'openai-compatible',
      base_url: endpoint.toString().replace(/\/$/, ''),
      model: modelId.trim(),
      local: true,
      supports_tools: typeof reportedCapabilities?.supports_tools === 'boolean' ? reportedCapabilities.supports_tools : true,
      ...(typeof reportedCapabilities?.supports_vision === 'boolean' ? { supports_vision: reportedCapabilities.supports_vision } : {}),
      ...(Number.isSafeInteger(contextLength) && contextLength > 0 && contextLength <= 10_000_000 ? { context_length: contextLength } : {}),
    },
  };
}
