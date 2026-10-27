import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPublicKey } from 'node:crypto';
import { isIP } from 'node:net';
import { parseToml } from './toml.mjs';
import { createPlatformSecretStore } from '../platform/secrets.mjs';
import { loadRuntimeOverrides } from './runtime-overrides.mjs';
import { assertUniqueUiShortcuts } from '../core/keybindings.mjs';
import { isSupportedOtlpEndpoint, validateOtlpHeaderReferences } from '../observability/otlp-traces.mjs';
import {
  normalizeSandboxMode,
  requiresProcessIsolation,
  resolveSandboxMode,
  SANDBOX_MODES,
  SANDBOX_PROCESS_TOOLS,
  sandboxModeRank,
} from '../platform/sandbox-modes.mjs';

export function defaultConfigPath(env = process.env, platform = process.platform, home = os.homedir()) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32')
    return pathApi.join(env.APPDATA || pathApi.join(home, 'AppData', 'Roaming'), 'Xyst AI Assistant', 'config.toml');
  return pathApi.join(env.XDG_CONFIG_HOME || pathApi.join(home, '.config'), 'xyst-ai-assistant', 'config.toml');
}

export async function loadConfig({ configPath, projectPath, env = process.env } = {}) {
  const userPath = configPath || defaultConfigPath(env);
  // The product default follows the requested full-autonomy profile. A user can
  // still select Assisted mode explicitly in their user config or settings.
  const userConfig = deepMerge(
    {
      tools: { autonomy: 'unrestricted', filesystem_scope: 'machine', shell_enabled: true, recursive_listing: true },
      memory: { global_enabled: false },
      web_search: { enabled: true, provider: 'automatic', max_results: 5 },
    },
    await readOptionalToml(userPath),
  );
  const projectConfig = projectPath ? await readOptionalToml(path.join(projectPath, '.xyst.toml')) : {};
  const runtimeOverridePath = `${userPath}.runtime.json`;
  const runtimeOverrides = await loadRuntimeOverrides(runtimeOverridePath);
  validateProjectCannotElevate(userConfig, projectConfig, runtimeOverrides);
  const config = deepMerge(deepMerge(userConfig, projectConfig), runtimeOverrides);
  if (runtimeOverrides.app_data?.directory === null) delete config.app_data?.directory;
  for (const [toolName, mode] of Object.entries(runtimeOverrides.sandbox?.tools || {})) {
    if (mode === null) delete config.sandbox?.tools?.[toolName];
  }
  for (const [key, value] of Object.entries(runtimeOverrides.budgets || {})) if (value === null) delete config.budgets[key];
  for (const [key, value] of Object.entries(runtimeOverrides.web_search || {})) if (value === null) delete config.web_search?.[key];
  for (const field of ['review_model', 'plan_model']) if (runtimeOverrides[field] === null) delete config[field];
  for (const [name, fields] of Object.entries(runtimeOverrides.models || {})) {
    if (fields === null) {
      delete config.models?.[name];
      continue;
    }
    for (const [key, value] of Object.entries(fields)) if (value === null) delete config.models?.[name]?.[key];
  }
  for (const [name, server] of Object.entries(runtimeOverrides.mcp?.servers || {})) {
    if (server === null) {
      delete config.mcp?.servers?.[name];
      continue;
    }
    for (const [setting, override] of Object.entries(server)) {
      if (override === null) delete config.mcp?.servers?.[name]?.[setting];
    }
  }
  applyEnvironmentOverrides(config, env, 'XYST__');
  validateConfig(config);
  config._source = { userPath, projectPath: projectPath || null, runtimeOverridePath };
  return config;
}

function validateProjectCannotElevate(userConfig, projectConfig, runtimeOverrides = {}) {
  const projectTools = projectConfig.tools || {};
  const userTools = { ...(userConfig.tools || {}), ...(runtimeOverrides.tools || {}) };
  const projectApprovals = projectConfig.approvals || {};
  const broadensTools =
    (projectTools.autonomy === 'unrestricted' && userTools.autonomy !== 'unrestricted') ||
    (projectTools.filesystem_scope === 'machine' && userTools.filesystem_scope !== 'machine' && userTools.autonomy !== 'unrestricted') ||
    (projectTools.shell_enabled === true && userTools.shell_enabled !== true && userTools.autonomy !== 'unrestricted') ||
    ['deny_tools', 'deny_write_paths', 'deny_process_commands'].some(
      (key) =>
        Array.isArray(projectApprovals[key]) && !(userConfig.approvals?.[key] || []).every((item) => projectApprovals[key].includes(item)),
    ) ||
    ['auto_approve_tools', 'auto_approve_write_paths', 'auto_approve_process_commands'].some(
      (key) =>
        Array.isArray(projectApprovals[key]) &&
        projectApprovals[key].length > 0 &&
        !(projectApprovals[key] || []).every((item) => (userConfig.approvals?.[key] || []).includes(item)),
    );
  const effectiveUserConfig = { ...userConfig, sandbox: deepMerge(userConfig.sandbox || {}, runtimeOverrides.sandbox || {}) };
  const sandboxTargets = [null, ...SANDBOX_PROCESS_TOOLS];
  const weakensSandbox = sandboxTargets.some((toolName) => {
    const userMode = resolveSandboxMode(effectiveUserConfig, toolName);
    const projectMode = resolveSandboxMode(projectConfig, toolName);
    return Boolean(projectConfig.sandbox) && sandboxModeRank(projectMode) < sandboxModeRank(userMode);
  });
  if (
    broadensTools ||
    weakensSandbox ||
    projectConfig.mcp !== undefined ||
    projectConfig.skills !== undefined ||
    projectConfig.hooks !== undefined ||
    projectConfig.extensions !== undefined ||
    projectConfig.app_updates !== undefined ||
    projectConfig.observability !== undefined ||
    projectConfig.architect !== undefined ||
    projectConfig.memory?.global_enabled !== undefined
  )
    throw new Error(
      'Project config may not enable Architect, elevate tool access, define MCP servers, skills, or application update trust roots, configure observability exporters, or weaken the user-configured sandbox; configure these settings in the user config',
    );
}

async function readOptionalToml(filePath) {
  try {
    return parseToml(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    if (error instanceof SyntaxError) throw new Error(`Invalid config at ${filePath}: ${error.message}`, { cause: error });
    throw error;
  }
}

function deepMerge(base, overlay) {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(overlay)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      result[key] &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], value);
    } else result[key] = structuredClone(value);
  }
  return result;
}

function applyEnvironmentOverrides(config, env, prefix) {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(prefix)) continue;
    const parts = key.slice(prefix.length).toLowerCase().split('__').filter(Boolean);
    if (!parts.length) continue;
    if (parts.some((part) => ['__proto__', 'constructor', 'prototype'].includes(part)))
      throw new Error(`Unsafe configuration override key '${key}'`);
    let node = config;
    for (const part of parts.slice(0, -1)) node = node[part] ??= {};
    node[parts.at(-1)] = parseEnvironmentValue(value);
  }
}

function parseEnvironmentValue(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?(?:0|[1-9][0-9]*)$/.test(value)) return Number(value);
  return value;
}

export function resolveApiKey(modelConfig, env = process.env) {
  if (modelConfig.api_key_env) return env[modelConfig.api_key_env] || null;
  return null;
}

/** Resolve a configured credential only at the point a provider is created. */
export async function resolveModelApiKey(modelConfig, { env = process.env, secretStore } = {}) {
  if (modelConfig.api_key_env) return env[modelConfig.api_key_env] || null;
  if (modelConfig.api_key_secret) {
    const value = await (secretStore || createPlatformSecretStore()).get(modelConfig.api_key_secret);
    if (value === null) throw new Error(`Configured credential '${modelConfig.api_key_secret}' was not found in the OS credential vault`);
    return value;
  }
  return null;
}

export function validateConfig(config) {
  if (!isRecord(config)) throw new TypeError('Configuration must be a table');
  for (const section of [
    'models',
    'local_servers',
    'routing',
    'budgets',
    'compaction',
    'sandbox',
    'memory',
    'app_data',
    'retrieval',
    'tools',
    'approvals',
    'discovery',
    'api',
    'web_search',
    'subagents',
    'mcp',
    'skills',
    'hooks',
    'extensions',
    'observability',
    'architect',
    'app_updates',
  ]) {
    if (config[section] !== undefined && !isRecord(config[section])) throw new TypeError(`${section} must be a table`);
  }
  if (
    config.app_data?.directory !== undefined &&
    (typeof config.app_data.directory !== 'string' ||
      !config.app_data.directory.trim() ||
      config.app_data.directory.length > 4096 ||
      !path.isAbsolute(config.app_data.directory))
  )
    throw new TypeError('app_data.directory must be an absolute path for this platform, up to 4096 characters');
  if (config.observability?.enabled !== undefined && typeof config.observability.enabled !== 'boolean')
    throw new TypeError('observability.enabled must be boolean');
  if (config.observability?.console_enabled !== undefined && typeof config.observability.console_enabled !== 'boolean')
    throw new TypeError('observability.console_enabled must be boolean');
  validateOtlpConfig(config.observability, config.observability?.enabled === true);
  if (config.architect?.enabled !== undefined && typeof config.architect.enabled !== 'boolean')
    throw new TypeError('architect.enabled must be boolean');
  if (
    config.architect?.interval_hours !== undefined &&
    (!Number.isInteger(config.architect.interval_hours) || config.architect.interval_hours < 1 || config.architect.interval_hours > 168)
  )
    throw new TypeError('architect.interval_hours must be an integer between 1 and 168');
  if (config.architect?.run_on_start !== undefined && typeof config.architect.run_on_start !== 'boolean')
    throw new TypeError('architect.run_on_start must be boolean');
  if (config.architect?.allow_remote !== undefined && typeof config.architect.allow_remote !== 'boolean')
    throw new TypeError('architect.allow_remote must be boolean');
  validateApplicationUpdates(config.app_updates);
  validateLifecycleHooks(config.hooks, config);
  validateExtensionTrustConfig(config.extensions);
  if (
    config.observability?.max_file_bytes !== undefined &&
    (!Number.isInteger(config.observability.max_file_bytes) ||
      config.observability.max_file_bytes < 1_000 ||
      config.observability.max_file_bytes > 100 * 1024 * 1024)
  )
    throw new TypeError('observability.max_file_bytes must be between 1000 and 104857600');
  if (config.sandbox !== undefined) {
    if (!isRecord(config.sandbox)) throw new TypeError('sandbox must be a table');
    if (config.sandbox.mode !== undefined) {
      const mode = normalizeSandboxMode(config.sandbox.mode);
      if (mode === null) throw new TypeError(`sandbox.mode must be one of ${SANDBOX_MODES.join(', ')}`);
      config.sandbox.mode = mode;
    }
    if (config.sandbox.tools !== undefined) {
      if (!isRecord(config.sandbox.tools)) throw new TypeError('sandbox.tools must be a table');
      for (const [toolName, value] of Object.entries(config.sandbox.tools)) {
        if (!SANDBOX_PROCESS_TOOLS.includes(toolName)) throw new TypeError(`sandbox.tools.${toolName} is not a process-capable tool`);
        const mode = normalizeSandboxMode(value);
        if (mode === null) throw new TypeError(`sandbox.tools.${toolName} must be one of ${SANDBOX_MODES.join(', ')}`);
        config.sandbox.tools[toolName] = mode;
      }
    }
  }
  if (config.skills) {
    if (config.skills.enabled !== undefined && typeof config.skills.enabled !== 'boolean')
      throw new TypeError('skills.enabled must be boolean');
    if (
      config.skills.directories !== undefined &&
      (!Array.isArray(config.skills.directories) ||
        config.skills.directories.some((directory) => typeof directory !== 'string' || !path.isAbsolute(directory)))
    )
      throw new TypeError('skills.directories must contain absolute paths configured by the user');
    if (config.skills.directories?.length > 16) throw new TypeError('skills.directories supports at most 16 paths');
    if (config.skills.enabled === true && !config.skills.directories?.length)
      throw new TypeError('skills.enabled requires at least one user-configured directory');
  }
  if (
    config.api?.allowed_origins !== undefined &&
    (!Array.isArray(config.api.allowed_origins) ||
      config.api.allowed_origins.some(
        (origin) =>
          typeof origin !== 'string' || !/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]+$/.test(origin) || /[@?#]/.test(origin) || origin === '*',
      ))
  )
    throw new TypeError('api.allowed_origins must be an array of explicit origins without credentials, paths, queries, or fragments');
  if (
    config.api?.max_concurrent_runs !== undefined &&
    (!Number.isInteger(config.api.max_concurrent_runs) || config.api.max_concurrent_runs < 1 || config.api.max_concurrent_runs > 16)
  )
    throw new TypeError('api.max_concurrent_runs must be between 1 and 16');
  if (
    config.api?.approval_timeout_ms !== undefined &&
    (!Number.isInteger(config.api.approval_timeout_ms) || config.api.approval_timeout_ms < 1000 || config.api.approval_timeout_ms > 300_000)
  )
    throw new TypeError('api.approval_timeout_ms must be between 1000 and 300000');
  if (config.default_model !== undefined && typeof config.default_model !== 'string') throw new TypeError('default_model must be a string');
  if (config.ui?.shortcuts !== undefined) assertUniqueUiShortcuts(config.ui.shortcuts);
  if (config.workspace !== undefined && typeof config.workspace !== 'string') throw new TypeError('workspace must be a string path');
  const localServers = Object.entries(config.local_servers || {});
  if (localServers.length > 16) throw new TypeError('local_servers may contain at most 16 endpoints');
  for (const [name, server] of localServers) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name))
      throw new TypeError(`local_servers.${name} must use a lowercase name of at most 32 characters`);
    if (!isRecord(server) || !isValidHttpBaseUrl(server.base_url))
      throw new TypeError(`local_servers.${name}.base_url must be an HTTP(S) URL without embedded credentials, query, or fragment`);
    if (
      server.api_key_env !== undefined &&
      (typeof server.api_key_env !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(server.api_key_env))
    )
      throw new TypeError(`local_servers.${name}.api_key_env must name an environment variable`);
  }
  if (config.discovery?.enabled !== undefined && typeof config.discovery.enabled !== 'boolean')
    throw new TypeError('discovery.enabled must be boolean');
  if (config.web_search) {
    const search = config.web_search;
    if (search.enabled !== undefined && typeof search.enabled !== 'boolean') throw new TypeError('web_search.enabled must be boolean');
    if (search.provider !== undefined && !['automatic', 'brave', 'wikipedia'].includes(search.provider))
      throw new TypeError("web_search.provider must be 'automatic', 'brave', or 'wikipedia'");
    if (
      search.api_key_env !== undefined &&
      (typeof search.api_key_env !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(search.api_key_env))
    )
      throw new TypeError('web_search.api_key_env must name an environment variable');
    if (
      search.api_key_secret !== undefined &&
      (typeof search.api_key_secret !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(search.api_key_secret))
    )
      throw new TypeError('web_search.api_key_secret must be a valid OS credential key');
    if (search.api_key_env && search.api_key_secret)
      throw new TypeError('web_search must configure only one of api_key_env or api_key_secret');
    if (search.max_results !== undefined && (!Number.isInteger(search.max_results) || search.max_results < 1 || search.max_results > 10))
      throw new TypeError('web_search.max_results must be between 1 and 10');
    if (search.timeout_ms !== undefined && (!Number.isInteger(search.timeout_ms) || search.timeout_ms < 1000 || search.timeout_ms > 60_000))
      throw new TypeError('web_search.timeout_ms must be between 1000 and 60000');
  }
  if (config.retrieval?.semantic !== undefined) {
    const semantic = config.retrieval.semantic;
    if (!isRecord(semantic)) throw new TypeError('retrieval.semantic must be a table');
    if (semantic.enabled !== undefined && typeof semantic.enabled !== 'boolean')
      throw new TypeError('retrieval.semantic.enabled must be boolean');
    if (semantic.allow_remote !== undefined && typeof semantic.allow_remote !== 'boolean')
      throw new TypeError('retrieval.semantic.allow_remote must be boolean');
    if (
      semantic.input_cost_per_million !== undefined &&
      (typeof semantic.input_cost_per_million !== 'number' ||
        !Number.isFinite(semantic.input_cost_per_million) ||
        semantic.input_cost_per_million < 0)
    )
      throw new TypeError('retrieval.semantic.input_cost_per_million must be a non-negative USD amount');
    if (
      semantic.timeout_ms !== undefined &&
      (!Number.isInteger(semantic.timeout_ms) || semantic.timeout_ms < 1000 || semantic.timeout_ms > 600_000)
    )
      throw new TypeError('retrieval.semantic.timeout_ms must be between 1000 and 600000');
    if (
      semantic.api_key_env !== undefined &&
      (typeof semantic.api_key_env !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(semantic.api_key_env))
    )
      throw new TypeError('retrieval.semantic.api_key_env must name an environment variable');
    if (
      semantic.api_key_secret !== undefined &&
      (typeof semantic.api_key_secret !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(semantic.api_key_secret))
    )
      throw new TypeError('retrieval.semantic.api_key_secret must be a valid OS credential key');
    if (semantic.api_key_env && semantic.api_key_secret)
      throw new TypeError('retrieval.semantic must configure only one of api_key_env or api_key_secret');
    if (semantic.enabled === true) {
      if (!isValidHttpBaseUrl(semantic.base_url))
        throw new TypeError('retrieval.semantic.base_url must be an HTTP(S) URL without embedded credentials, query, or fragment');
      if (typeof semantic.model !== 'string' || !semantic.model.trim() || semantic.model.length > 200)
        throw new TypeError('retrieval.semantic.model must be a non-empty model name');
      const url = new URL(semantic.base_url);
      const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
      if (!localHost && semantic.allow_remote !== true)
        throw new TypeError(
          'Remote embeddings require retrieval.semantic.allow_remote = true because workspace text will be sent to that service',
        );
      if (!localHost && url.protocol !== 'https:') throw new TypeError('Remote embedding services must use HTTPS');
    }
  }
  if (config.retrieval?.auto_context !== undefined && typeof config.retrieval.auto_context !== 'boolean')
    throw new TypeError('retrieval.auto_context must be boolean');
  if (config.retrieval?.auto_context === true && config.retrieval.semantic?.enabled !== true)
    throw new TypeError('retrieval.auto_context requires retrieval.semantic.enabled = true');
  if (
    config.retrieval?.auto_context_max_results !== undefined &&
    (!Number.isInteger(config.retrieval.auto_context_max_results) ||
      config.retrieval.auto_context_max_results < 1 ||
      config.retrieval.auto_context_max_results > 10)
  )
    throw new TypeError('retrieval.auto_context_max_results must be an integer from 1 to 10');
  if (
    config.retrieval?.auto_context_max_chars !== undefined &&
    (!Number.isInteger(config.retrieval.auto_context_max_chars) ||
      config.retrieval.auto_context_max_chars < 512 ||
      config.retrieval.auto_context_max_chars > 20_000)
  )
    throw new TypeError('retrieval.auto_context_max_chars must be an integer from 512 to 20000');
  if (config.subagents) {
    const subagents = config.subagents;
    if (subagents.enabled !== undefined && typeof subagents.enabled !== 'boolean') throw new TypeError('subagents.enabled must be boolean');
    if (
      subagents.max_concurrent !== undefined &&
      (!Number.isInteger(subagents.max_concurrent) || subagents.max_concurrent < 1 || subagents.max_concurrent > 8)
    )
      throw new TypeError('subagents.max_concurrent must be between 1 and 8');
    if (
      subagents.max_turns !== undefined &&
      (!Number.isInteger(subagents.max_turns) || subagents.max_turns < 1 || subagents.max_turns > 20)
    )
      throw new TypeError('subagents.max_turns must be between 1 and 20');
    if (
      subagents.timeout_ms !== undefined &&
      (!Number.isInteger(subagents.timeout_ms) || subagents.timeout_ms < 1000 || subagents.timeout_ms > 1_800_000)
    )
      throw new TypeError('subagents.timeout_ms must be between 1000 and 1800000');
  }
  validateMcpConfig(config.mcp);
  if (config.routing?.enabled !== undefined && typeof config.routing.enabled !== 'boolean')
    throw new TypeError('routing.enabled must be boolean');
  if (config.routing?.prefer_local !== undefined && typeof config.routing.prefer_local !== 'boolean')
    throw new TypeError('routing.prefer_local must be boolean');
  if (config.routing?.classifier !== undefined) {
    if (!isRecord(config.routing.classifier) || Object.keys(config.routing.classifier).some((key) => key !== 'enabled'))
      throw new TypeError('routing.classifier may contain only enabled');
    if (config.routing.classifier.enabled !== undefined && typeof config.routing.classifier.enabled !== 'boolean')
      throw new TypeError('routing.classifier.enabled must be boolean');
  }
  if (
    config.routing?.minimum_context_tokens !== undefined &&
    (!Number.isInteger(config.routing.minimum_context_tokens) || config.routing.minimum_context_tokens < 1)
  )
    throw new TypeError('routing.minimum_context_tokens must be a positive integer');
  if (config.routing?.selection !== undefined && !['balanced', 'quality', 'cost', 'speed'].includes(config.routing.selection))
    throw new TypeError("routing.selection must be 'balanced', 'quality', 'cost', or 'speed'");
  if (
    config.routing?.health_check_timeout_ms !== undefined &&
    (!Number.isInteger(config.routing.health_check_timeout_ms) ||
      config.routing.health_check_timeout_ms < 100 ||
      config.routing.health_check_timeout_ms > 30_000)
  )
    throw new TypeError('routing.health_check_timeout_ms must be between 100 and 30000');
  if (config.routing?.fallback_chain !== undefined) {
    const chain = config.routing.fallback_chain;
    if (!Array.isArray(chain) || chain.length < 1 || chain.length > 16 || chain.some((name) => typeof name !== 'string' || !name.trim()))
      throw new TypeError('routing.fallback_chain must contain between 1 and 16 model profile names');
    if (new Set(chain).size !== chain.length) throw new TypeError('routing.fallback_chain cannot contain duplicate model names');
  }
  for (const [name, model] of Object.entries(config.models || {})) {
    if (!isRecord(model)) throw new TypeError(`models.${name} must be a table`);
    if (model.provider !== 'openai-compatible') throw new TypeError(`models.${name}.provider must be 'openai-compatible'`);
    if (!isValidHttpBaseUrl(model.base_url))
      throw new TypeError(`models.${name}.base_url must be an HTTP(S) URL without embedded credentials, query, or fragment`);
    if (typeof model.model !== 'string' || !model.model.trim()) throw new TypeError(`models.${name}.model must be a non-empty string`);
    if (model.context_length !== undefined && (!Number.isInteger(model.context_length) || model.context_length < 1))
      throw new TypeError(`models.${name}.context_length must be a positive integer`);
    if (
      model.temperature !== undefined &&
      (typeof model.temperature !== 'number' || !Number.isFinite(model.temperature) || model.temperature < 0 || model.temperature > 2)
    )
      throw new TypeError(`models.${name}.temperature must be a number from 0 to 2`);
    if (
      model.max_output_tokens !== undefined &&
      (!Number.isInteger(model.max_output_tokens) || model.max_output_tokens < 1 || model.max_output_tokens > 1_000_000)
    )
      throw new TypeError(`models.${name}.max_output_tokens must be an integer between 1 and 1000000`);
    for (const field of ['coding_strength', 'tool_calling_quality', 'speed_score'])
      if (model[field] !== undefined && (!Number.isInteger(model[field]) || model[field] < 1 || model[field] > 10))
        throw new TypeError(`models.${name}.${field} must be an integer from 1 to 10`);
    if (model.priority !== undefined && (!Number.isInteger(model.priority) || model.priority < 0 || model.priority > 1000))
      throw new TypeError(`models.${name}.priority must be an integer from 0 to 1000`);
    if (model.timeout_ms !== undefined && (!Number.isInteger(model.timeout_ms) || model.timeout_ms < 1 || model.timeout_ms > 600_000))
      throw new TypeError(`models.${name}.timeout_ms must be between 1 and 600000`);
    if (
      model.retry_attempts !== undefined &&
      (!Number.isInteger(model.retry_attempts) || model.retry_attempts < 0 || model.retry_attempts > 2)
    )
      throw new TypeError(`models.${name}.retry_attempts must be an integer from 0 to 2`);
    if (model.reasoning_effort !== undefined && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(model.reasoning_effort))
      throw new TypeError(`models.${name}.reasoning_effort must be none, minimal, low, medium, high, or xhigh`);
    if (model.prompt_cache_enabled !== undefined && typeof model.prompt_cache_enabled !== 'boolean')
      throw new TypeError(`models.${name}.prompt_cache_enabled must be boolean`);
    if (
      model.prompt_cache_key !== undefined &&
      (typeof model.prompt_cache_key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(model.prompt_cache_key))
    )
      throw new TypeError(`models.${name}.prompt_cache_key must be a non-sensitive identifier of at most 64 characters`);
    if (model.prompt_cache_retention !== undefined && model.prompt_cache_retention !== '24h')
      throw new TypeError(`models.${name}.prompt_cache_retention must be '24h'`);
    if (model.api_key_env !== undefined && (typeof model.api_key_env !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(model.api_key_env)))
      throw new TypeError(`models.${name}.api_key_env must name an environment variable`);
    if (
      model.api_key_secret !== undefined &&
      (typeof model.api_key_secret !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(model.api_key_secret))
    )
      throw new TypeError(`models.${name}.api_key_secret must be a valid OS credential key`);
    if (model.api_key_env && model.api_key_secret)
      throw new TypeError(`models.${name} must configure only one of api_key_env or api_key_secret`);
    for (const field of ['input_cost_per_million', 'cached_input_cost_per_million', 'output_cost_per_million'])
      if (model[field] !== undefined && (typeof model[field] !== 'number' || !Number.isFinite(model[field]) || model[field] < 0))
        throw new TypeError(`models.${name}.${field} must be a non-negative number`);
    if (model.pricing_updated_at !== undefined && !isValidPricingDate(model.pricing_updated_at))
      throw new TypeError(`models.${name}.pricing_updated_at must be a valid date no later than today (YYYY-MM-DD)`);
    if (
      model.pricing_source !== undefined &&
      (typeof model.pricing_source !== 'string' ||
        !model.pricing_source.trim() ||
        model.pricing_source.length > 256 ||
        /[\u0000-\u001f]/.test(model.pricing_source))
    )
      throw new TypeError(`models.${name}.pricing_source must be a non-empty note of at most 256 characters`);
    if (model.capabilities_updated_at !== undefined && !isValidPricingDate(model.capabilities_updated_at))
      throw new TypeError(`models.${name}.capabilities_updated_at must be a valid date no later than today (YYYY-MM-DD)`);
    if (
      model.capabilities_source !== undefined &&
      (typeof model.capabilities_source !== 'string' ||
        !model.capabilities_source.trim() ||
        model.capabilities_source.length > 256 ||
        /[\u0000-\u001f]/.test(model.capabilities_source))
    )
      throw new TypeError(`models.${name}.capabilities_source must be a non-empty note of at most 256 characters`);
    for (const field of ['local', 'supports_tools', 'supports_vision'])
      if (model[field] !== undefined && typeof model[field] !== 'boolean') throw new TypeError(`models.${name}.${field} must be boolean`);
  }
  if (config.default_model && config.models && !config.models[config.default_model])
    throw new TypeError(`default_model '${config.default_model}' is not defined in models`);
  for (const name of config.routing?.fallback_chain || [])
    if (!config.models?.[name]) throw new TypeError(`routing.fallback_chain model '${name}' is not defined in models`);
  for (const field of ['review_model', 'plan_model'])
    if (config[field] !== undefined && !config.models?.[config[field]]) throw new TypeError(`${field} must name a configured model`);
  for (const field of [
    'max_turns',
    'max_input_tokens',
    'max_output_tokens',
    'max_tool_output_bytes',
    'max_session_input_tokens',
    'max_session_output_tokens',
    'recovery_summary_input_tokens',
    'max_daily_input_tokens',
    'max_daily_output_tokens',
    'max_monthly_input_tokens',
    'max_monthly_output_tokens',
    'final_response_reserve_tokens',
  ]) {
    const value = config.budgets?.[field];
    if (value === undefined) continue;
    if (field === 'recovery_summary_input_tokens') {
      if (!Number.isSafeInteger(value) || value < 0)
        throw new TypeError('budgets.recovery_summary_input_tokens must be a non-negative integer');
    } else if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`budgets.${field} must be a positive integer`);
    }
  }
  if (
    config.budgets?.final_response_reserve_tokens !== undefined &&
    config.budgets.max_output_tokens !== undefined &&
    config.budgets.final_response_reserve_tokens >= config.budgets.max_output_tokens
  )
    throw new TypeError('budgets.final_response_reserve_tokens must be smaller than max_output_tokens');
  if (config.compaction?.enabled !== undefined && typeof config.compaction.enabled !== 'boolean')
    throw new TypeError('compaction.enabled must be boolean');
  if (
    config.compaction?.trigger_ratio !== undefined &&
    (typeof config.compaction.trigger_ratio !== 'number' ||
      !Number.isFinite(config.compaction.trigger_ratio) ||
      config.compaction.trigger_ratio < 0.5 ||
      config.compaction.trigger_ratio > 0.95)
  )
    throw new TypeError('compaction.trigger_ratio must be between 0.5 and 0.95');
  if (
    config.compaction?.budget_trigger_ratio !== undefined &&
    (typeof config.compaction.budget_trigger_ratio !== 'number' ||
      !Number.isFinite(config.compaction.budget_trigger_ratio) ||
      config.compaction.budget_trigger_ratio < 0.5 ||
      config.compaction.budget_trigger_ratio > 0.95)
  )
    throw new TypeError('compaction.budget_trigger_ratio must be between 0.5 and 0.95');
  if (
    config.compaction?.keep_recent_turns !== undefined &&
    (!Number.isInteger(config.compaction.keep_recent_turns) ||
      config.compaction.keep_recent_turns < 1 ||
      config.compaction.keep_recent_turns > 20)
  )
    throw new TypeError('compaction.keep_recent_turns must be between 1 and 20');
  if (
    config.budgets?.max_session_cost !== undefined &&
    (typeof config.budgets.max_session_cost !== 'number' ||
      !Number.isFinite(config.budgets.max_session_cost) ||
      config.budgets.max_session_cost < 0)
  )
    throw new TypeError('budgets.max_session_cost must be a non-negative USD amount');
  for (const field of ['max_daily_cost', 'max_monthly_cost'])
    if (
      config.budgets?.[field] !== undefined &&
      (typeof config.budgets[field] !== 'number' || !Number.isFinite(config.budgets[field]) || config.budgets[field] < 0)
    )
      throw new TypeError(`budgets.${field} must be a non-negative USD amount`);
  for (const field of ['max_files', 'max_file_bytes', 'max_results'])
    if (config.retrieval?.[field] !== undefined && (!Number.isInteger(config.retrieval[field]) || config.retrieval[field] < 1))
      throw new TypeError(`retrieval.${field} must be a positive integer`);
  if (config.retrieval?.max_files > 10_000) throw new TypeError('retrieval.max_files must not exceed 10000');
  if (config.retrieval?.max_file_bytes > 1_000_000) throw new TypeError('retrieval.max_file_bytes must not exceed 1000000');
  if (config.retrieval?.max_results > 100) throw new TypeError('retrieval.max_results must not exceed 100');
  if (config.tools?.shell_enabled !== undefined && typeof config.tools.shell_enabled !== 'boolean')
    throw new TypeError('tools.shell_enabled must be boolean');
  if (config.tools?.filesystem_scope !== undefined && !['workspace', 'machine'].includes(config.tools.filesystem_scope))
    throw new TypeError("tools.filesystem_scope must be 'workspace' or 'machine'");
  if (config.tools?.autonomy !== undefined && !['assisted', 'unrestricted'].includes(config.tools.autonomy))
    throw new TypeError("tools.autonomy must be 'assisted' or 'unrestricted'");
  if (
    (config.tools?.filesystem_scope === 'machine' || config.tools?.autonomy === 'unrestricted') &&
    [null, ...SANDBOX_PROCESS_TOOLS].some((toolName) => requiresProcessIsolation(resolveSandboxMode(config, toolName)))
  )
    throw new TypeError(
      'Machine-wide file access cannot be combined with process isolation; the configured sandbox only exposes the workspace',
    );
  if (config.tools?.recursive_listing !== undefined && typeof config.tools.recursive_listing !== 'boolean')
    throw new TypeError('tools.recursive_listing must be boolean');
  for (const field of ['max_file_bytes', 'max_write_bytes', 'max_list_entries'])
    if (config.tools?.[field] !== undefined && (!Number.isInteger(config.tools[field]) || config.tools[field] < 1))
      throw new TypeError(`tools.${field} must be a positive integer`);
  const knownTools = new Set([
    'read_file',
    'list_dir',
    'search_files',
    'semantic_search',
    'web_search',
    'delegate_task',
    'list_skills',
    'load_skill',
    'write_file',
    'edit_file',
    'run_process',
    'run_shell_script',
    'computer_control',
    'start_background_process',
    'send_background_input',
    'list_background_processes',
    'read_background_process',
    'stop_background_process',
  ]);
  for (const field of ['deny_tools', 'auto_approve_tools']) {
    const list = config.approvals?.[field];
    if (list !== undefined && (!Array.isArray(list) || list.some((name) => typeof name !== 'string' || !knownTools.has(name))))
      throw new TypeError(`approvals.${field} must contain known tool names`);
  }
  for (const field of ['deny_write_paths', 'auto_approve_write_paths']) {
    const list = config.approvals?.[field];
    if (
      list !== undefined &&
      (!Array.isArray(list) ||
        list.some(
          (pattern) =>
            typeof pattern !== 'string' ||
            !pattern.trim() ||
            pattern.length > 500 ||
            pattern.startsWith('/') ||
            /^[A-Za-z]:/.test(pattern) ||
            pattern.includes('\\') ||
            /[\u0000-\u001f]/.test(pattern) ||
            pattern.split('/').some((part) => part === '..'),
        ))
    ) {
      throw new TypeError(`approvals.${field} must contain relative workspace glob patterns without parent traversal`);
    }
  }
  for (const field of ['deny_process_commands', 'auto_approve_process_commands']) {
    const list = config.approvals?.[field];
    if (
      list !== undefined &&
      (!Array.isArray(list) ||
        list.some((pattern) => typeof pattern !== 'string' || !pattern.trim() || pattern.length > 500 || /[\u0000-\u001f]/.test(pattern)))
    )
      throw new TypeError(`approvals.${field} must contain non-empty command patterns of at most 500 characters`);
  }
  if (
    config.memory?.max_context_chars !== undefined &&
    (!Number.isInteger(config.memory.max_context_chars) || config.memory.max_context_chars < 1)
  )
    throw new TypeError('memory.max_context_chars must be a positive integer');
  if (config.memory?.global_enabled !== undefined && typeof config.memory.global_enabled !== 'boolean')
    throw new TypeError('memory.global_enabled must be boolean');
}

function validateApplicationUpdates(updates) {
  if (!updates) return;
  if (Object.keys(updates).some((key) => !['mode', 'channel', 'feed_url', 'key_id', 'public_key'].includes(key)))
    throw new TypeError('app_updates contains an unsupported setting');
  if (updates.mode !== undefined && !['disabled', 'manual', 'notify'].includes(updates.mode))
    throw new TypeError('app_updates.mode must be disabled, manual, or notify');
  if (updates.channel !== undefined && !['stable', 'preview'].includes(updates.channel))
    throw new TypeError('app_updates.channel must be stable or preview');
  if (updates.feed_url !== undefined && updates.feed_url !== null) {
    let url;
    try {
      url = new URL(updates.feed_url);
    } catch {
      throw new TypeError('app_updates.feed_url must be HTTPS without credentials, query, or fragment');
    }
    if (
      typeof updates.feed_url !== 'string' ||
      updates.feed_url.length > 2048 ||
      url.protocol !== 'https:' ||
      !url.hostname ||
      isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0 ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new TypeError('app_updates.feed_url must be HTTPS without credentials, query, or fragment');
  }
  if (
    updates.key_id !== undefined &&
    updates.key_id !== null &&
    (typeof updates.key_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(updates.key_id))
  )
    throw new TypeError('app_updates.key_id is invalid');
  if (updates.public_key !== undefined && updates.public_key !== null) {
    if (typeof updates.public_key !== 'string' || updates.public_key.length > 8192)
      throw new TypeError('app_updates.public_key must be an Ed25519 PEM key up to 8192 characters');
    try {
      if (!/^-----BEGIN PUBLIC KEY-----\r?\n[\s\S]+\r?\n-----END PUBLIC KEY-----$/.test(updates.public_key.trim()))
        throw new Error('expected public-key PEM');
      if (createPublicKey(updates.public_key).asymmetricKeyType !== 'ed25519') throw new Error('wrong key type');
    } catch {
      throw new TypeError('app_updates.public_key must be a valid Ed25519 PEM key');
    }
  }
  if (['manual', 'notify'].includes(updates.mode || 'disabled') && (!updates.feed_url || !updates.key_id || !updates.public_key))
    throw new TypeError('app_updates manual or notify mode requires a feed URL, signing key ID, and trusted public key');
}

function validateLifecycleHooks(hooks, config) {
  if (hooks === undefined) return;
  const events = new Set(['pre_model', 'post_model', 'pre_tool', 'post_tool', 'on_error']);
  if (Object.keys(hooks).some((event) => !events.has(event))) throw new TypeError('hooks contains an unsupported lifecycle event');
  for (const [event, hook] of Object.entries(hooks)) {
    if (!isRecord(hook)) throw new TypeError(`hooks.${event} must be a table`);
    if (Object.keys(hook).some((key) => !['command', 'args', 'timeout_ms'].includes(key)))
      throw new TypeError(`hooks.${event} contains an unsupported setting`);
    if (typeof hook.command !== 'string' || !hook.command.trim() || hook.command.includes('\0'))
      throw new TypeError(`hooks.${event}.command must be a non-empty executable path or name`);
    if (
      hook.args !== undefined &&
      (!Array.isArray(hook.args) ||
        hook.args.length > 64 ||
        hook.args.some((arg) => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0')))
    )
      throw new TypeError(`hooks.${event}.args must contain at most 64 strings of at most 4096 characters`);
    if (hook.timeout_ms !== undefined && (!Number.isInteger(hook.timeout_ms) || hook.timeout_ms < 1 || hook.timeout_ms > 10_000))
      throw new TypeError(`hooks.${event}.timeout_ms must be an integer between 1 and 10000`);
  }
  if (config.tools?.shell_enabled !== true && config.tools?.autonomy !== 'unrestricted')
    throw new TypeError(
      'Lifecycle hooks require explicit process execution authorization via tools.shell_enabled or unrestricted autonomy',
    );
}

function validateExtensionTrustConfig(extensions) {
  if (extensions === undefined) return;
  if (
    Object.keys(extensions).some(
      (key) =>
        ![
          'trusted_keys',
          'revoked_key_ids',
          'revoked_packages',
          'install_directory',
          'revocation_url',
          'revocation_key_id',
          'revocation_max_age_hours',
          'update_feed_url',
          'update_key_id',
          'update_max_age_hours',
        ].includes(key),
    )
  )
    throw new TypeError('extensions contains an unsupported setting');
  if (extensions.trusted_keys !== undefined && !isRecord(extensions.trusted_keys))
    throw new TypeError('extensions.trusted_keys must be a table of named Ed25519 public keys');
  const trustedKeys = Object.entries(extensions.trusted_keys || {});
  if (trustedKeys.length > 64) throw new TypeError('extensions.trusted_keys may contain at most 64 entries');
  for (const [keyId, pem] of trustedKeys) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(keyId)) throw new TypeError(`extensions.trusted_keys.${keyId} has an invalid key ID`);
    if (typeof pem !== 'string' || pem.length > 8192 || !/^-----BEGIN PUBLIC KEY-----\s/.test(pem.trim()))
      throw new TypeError(`extensions.trusted_keys.${keyId} must be a bounded PEM public key`);
    try {
      if (createPublicKey(pem).asymmetricKeyType !== 'ed25519') throw new Error('wrong type');
    } catch {
      throw new TypeError(`extensions.trusted_keys.${keyId} must contain a valid Ed25519 public key`);
    }
  }
  for (const field of ['revoked_key_ids', 'revoked_packages']) {
    const values = extensions[field];
    if (
      values !== undefined &&
      (!Array.isArray(values) ||
        values.length > 512 ||
        values.some((value) => typeof value !== 'string' || !value.trim() || value.length > 200))
    )
      throw new TypeError(`extensions.${field} must contain at most 512 non-empty strings of at most 200 characters`);
  }
  if (
    extensions.revoked_packages?.some(
      (value) => !/^(skill|mcp):[a-z0-9]+(?:[.-][a-z0-9]+)*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value),
    )
  )
    throw new TypeError('extensions.revoked_packages entries must use type:package-id@version format');
  if (
    extensions.install_directory !== undefined &&
    (typeof extensions.install_directory !== 'string' || !path.isAbsolute(extensions.install_directory))
  )
    throw new TypeError('extensions.install_directory must be an absolute user-selected path');
  if ((extensions.revocation_url === undefined) !== (extensions.revocation_key_id === undefined))
    throw new TypeError('extensions.revocation_url and extensions.revocation_key_id must be configured together');
  if (extensions.revocation_url !== undefined) {
    let url;
    try {
      url = new URL(extensions.revocation_url);
    } catch {
      throw new TypeError('extensions.revocation_url must be an HTTPS URL');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
      throw new TypeError('extensions.revocation_url must use HTTPS without credentials or a fragment');
    if (
      typeof extensions.revocation_key_id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(extensions.revocation_key_id) ||
      !extensions.trusted_keys?.[extensions.revocation_key_id]
    )
      throw new TypeError('extensions.revocation_key_id must name a configured trusted key');
  }
  if (
    extensions.revocation_max_age_hours !== undefined &&
    (!Number.isInteger(extensions.revocation_max_age_hours) ||
      extensions.revocation_max_age_hours < 1 ||
      extensions.revocation_max_age_hours > 720)
  )
    throw new TypeError('extensions.revocation_max_age_hours must be between 1 and 720');
  if ((extensions.update_feed_url === undefined) !== (extensions.update_key_id === undefined))
    throw new TypeError('extensions.update_feed_url and extensions.update_key_id must be configured together');
  if (extensions.update_feed_url !== undefined) {
    let url;
    try {
      url = new URL(extensions.update_feed_url);
    } catch {
      throw new TypeError('extensions.update_feed_url must be an HTTPS URL');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      throw new TypeError('extensions.update_feed_url must use HTTPS without credentials, query parameters, or a fragment');
    if (
      typeof extensions.update_key_id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(extensions.update_key_id) ||
      !extensions.trusted_keys?.[extensions.update_key_id]
    )
      throw new TypeError('extensions.update_key_id must name a configured trusted key');
  }
  if (
    extensions.update_max_age_hours !== undefined &&
    (!Number.isInteger(extensions.update_max_age_hours) || extensions.update_max_age_hours < 1 || extensions.update_max_age_hours > 720)
  )
    throw new TypeError('extensions.update_max_age_hours must be between 1 and 720');
}

function validateOtlpConfig(observability, masterEnabled) {
  const otlp = observability?.otlp;
  if (otlp === undefined) return;
  if (!isRecord(otlp)) throw new TypeError('observability.otlp must be a table');
  const allowed = new Set(['enabled', 'traces_endpoint', 'headers', 'timeout_ms', 'max_batch_spans']);
  if (Object.keys(otlp).some((key) => !allowed.has(key))) throw new TypeError('observability.otlp contains an unsupported setting');
  if (otlp.enabled !== undefined && typeof otlp.enabled !== 'boolean') throw new TypeError('observability.otlp.enabled must be boolean');
  if (otlp.enabled === true && !masterEnabled) throw new TypeError('observability.otlp.enabled requires observability.enabled = true');
  if (otlp.traces_endpoint !== undefined && !isSupportedOtlpEndpoint(otlp.traces_endpoint))
    throw new TypeError('observability.otlp.traces_endpoint must use HTTPS or loopback HTTP without credentials');
  if (otlp.enabled === true && typeof otlp.traces_endpoint !== 'string')
    throw new TypeError('observability.otlp.traces_endpoint is required when the OTLP exporter is enabled');
  validateOtlpHeaderReferences(otlp.headers);
  if (otlp.timeout_ms !== undefined && (!Number.isInteger(otlp.timeout_ms) || otlp.timeout_ms < 1_000 || otlp.timeout_ms > 60_000))
    throw new TypeError('observability.otlp.timeout_ms must be between 1000 and 60000');
  if (
    otlp.max_batch_spans !== undefined &&
    (!Number.isInteger(otlp.max_batch_spans) || otlp.max_batch_spans < 1 || otlp.max_batch_spans > 256)
  )
    throw new TypeError('observability.otlp.max_batch_spans must be between 1 and 256');
}

function validateMcpConfig(mcp) {
  if (mcp === undefined) return;
  if (mcp.enabled !== undefined && typeof mcp.enabled !== 'boolean') throw new TypeError('mcp.enabled must be boolean');
  if (mcp.timeout_ms !== undefined && (!Number.isInteger(mcp.timeout_ms) || mcp.timeout_ms < 1000 || mcp.timeout_ms > 120_000))
    throw new TypeError('mcp.timeout_ms must be between 1000 and 120000');
  if (mcp.servers !== undefined && !isRecord(mcp.servers)) throw new TypeError('mcp.servers must be a table of named servers');
  const servers = Object.entries(mcp.servers || {});
  if (servers.length > 16) throw new TypeError('mcp.servers may contain at most 16 entries');
  for (const [name, server] of servers) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name))
      throw new TypeError(`mcp.servers.${name} must use a lowercase name of at most 32 characters`);
    if (!isRecord(server)) throw new TypeError(`mcp.servers.${name} must be a table`);
    if (server.enabled !== undefined && typeof server.enabled !== 'boolean')
      throw new TypeError(`mcp.servers.${name}.enabled must be boolean`);
    const transport = server.transport ?? 'stdio';
    if (!['stdio', 'streamable_http', 'sse'].includes(transport))
      throw new TypeError(`mcp.servers.${name}.transport must be stdio, streamable_http, or sse`);
    if (transport === 'streamable_http' || transport === 'sse') {
      const httpKeys = new Set(['enabled', 'transport', 'url', 'headers', 'timeout_ms']);
      if (Object.keys(server).some((key) => !httpKeys.has(key)))
        throw new TypeError(`mcp.servers.${name} contains an unsupported ${transport} setting`);
      if (server.enabled !== false && server.enabled !== true && server.enabled !== undefined)
        throw new TypeError(`mcp.servers.${name}.enabled must be boolean`);
      if (server.enabled === true && !isSecureMcpUrl(server.url))
        throw new TypeError(`mcp.servers.${name}.url must be HTTPS or a loopback HTTP URL`);
      if (server.command !== undefined || server.args !== undefined || server.cwd !== undefined || server.env !== undefined)
        throw new TypeError(`mcp.servers.${name} cannot use process settings with ${transport}`);
      if (server.headers !== undefined) {
        if (!isRecord(server.headers) || Object.keys(server.headers).length > 32)
          throw new TypeError(`mcp.servers.${name}.headers must be a table with at most 32 entries`);
        for (const [header, reference] of Object.entries(server.headers)) {
          if (
            !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(header) ||
            /^(accept|content-type|mcp-protocol-version|mcp-method|mcp-name|mcp-session-id|host|content-length)$/i.test(header) ||
            typeof reference !== 'string' ||
            (!/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(reference) && !/^secret:[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(reference))
          )
            throw new TypeError(`mcp.servers.${name}.headers must map safe header names to env:VARIABLE or secret:vault.key references`);
        }
      }
      if (
        server.timeout_ms !== undefined &&
        (!Number.isInteger(server.timeout_ms) || server.timeout_ms < 1000 || server.timeout_ms > 120_000)
      )
        throw new TypeError(`mcp.servers.${name}.timeout_ms must be between 1000 and 120000`);
      continue;
    }
    const packageId = server.package_id;
    if (
      packageId !== undefined &&
      (typeof packageId !== 'string' || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(packageId) || packageId.length > 96)
    )
      throw new TypeError(`mcp.servers.${name}.package_id must be a lowercase signed MCP package ID`);
    const stdioKeys = new Set(['enabled', 'transport', 'command', 'package_id', 'args', 'cwd', 'timeout_ms', 'env']);
    if (Object.keys(server).some((key) => !stdioKeys.has(key)))
      throw new TypeError(`mcp.servers.${name} contains an unsupported stdio setting`);
    if (packageId !== undefined && (server.command !== undefined || server.cwd !== undefined))
      throw new TypeError(`mcp.servers.${name} must not override command or cwd for an activated signed package`);
    if (
      server.command !== undefined &&
      (typeof server.command !== 'string' ||
        !server.command.trim() ||
        server.command.length > 2048 ||
        /[\u0000-\u001f]/.test(server.command))
    )
      throw new TypeError(`mcp.servers.${name}.command must be a valid executable name or path`);
    if (server.enabled === true && server.command === undefined && packageId === undefined)
      throw new TypeError(`mcp.servers.${name} requires command or package_id when enabled`);
    if (server.enabled === true && server.command !== undefined && packageId !== undefined)
      throw new TypeError(`mcp.servers.${name} cannot set both command and package_id`);
    if (
      server.args !== undefined &&
      (!Array.isArray(server.args) ||
        server.args.length > 128 ||
        server.args.some((arg) => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\u0000')))
    )
      throw new TypeError(`mcp.servers.${name}.args must contain at most 128 strings of at most 8192 characters`);
    if (
      server.cwd !== undefined &&
      (typeof server.cwd !== 'string' || !server.cwd.trim() || server.cwd.length > 4096 || /[\u0000-\u001f]/.test(server.cwd))
    )
      throw new TypeError(`mcp.servers.${name}.cwd must be a valid directory path`);
    if (
      server.timeout_ms !== undefined &&
      (!Number.isInteger(server.timeout_ms) || server.timeout_ms < 1000 || server.timeout_ms > 120_000)
    )
      throw new TypeError(`mcp.servers.${name}.timeout_ms must be between 1000 and 120000`);
    if (server.env !== undefined) {
      if (!isRecord(server.env) || Object.keys(server.env).length > 64)
        throw new TypeError(`mcp.servers.${name}.env must be a table with at most 64 entries`);
      for (const [target, reference] of Object.entries(server.env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(target) || typeof reference !== 'string')
          throw new TypeError(`mcp.servers.${name}.env entries must map valid environment names to references`);
        if (!/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(reference) && !/^secret:[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(reference))
          throw new TypeError(`mcp.servers.${name}.env references must use env:VARIABLE or secret:vault.key`);
      }
    }
  }
}

function isSecureMcpUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
    return (
      !url.username && !url.password && !url.hash && !url.search && (url.protocol === 'https:' || (url.protocol === 'http:' && loopback))
    );
  } catch {
    return false;
  }
}

function isValidHttpBaseUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function isValidPricingDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && value <= new Date().toISOString().slice(0, 10);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
