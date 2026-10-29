import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { createPublicKey, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { atomicWriteJson, hasAtomicWriteBackup, readBoundedFileHandle, restoreAtomicWriteBackup } from '../platform/files.mjs';
import { isValidUiShortcut } from '../core/keybindings.mjs';
import { RUN_BUDGET_FIELDS } from '../core/budgets.mjs';
import { normalizeSandboxMode, SANDBOX_MODES, SANDBOX_PROCESS_TOOLS } from '../platform/sandbox-modes.mjs';

export const RUNTIME_OVERRIDE_BUDGET_FIELDS = RUN_BUDGET_FIELDS;
const MAX_OVERRIDE_BYTES = 64 * 1024;

export function validateRuntimeOverrides(value) {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          'default_model',
          'review_model',
          'plan_model',
          'routing',
          'budgets',
          'tools',
          'subagents',
          'ui',
          'models',
          'sandbox',
          'app_updates',
          'memory',
          'web_search',
          'mcp',
          'app_data',
        ].includes(key),
    )
  )
    throw new TypeError('Runtime settings contain an unsupported section');
  if (
    'default_model' in value &&
    (typeof value.default_model !== 'string' || !value.default_model.trim() || value.default_model.length > 200)
  )
    throw new TypeError('default_model must be a configured profile name');
  for (const key of ['review_model', 'plan_model'])
    if (key in value && value[key] !== null && (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 200))
      throw new TypeError(`${key} must be a configured profile name or null`);
  if ('routing' in value) {
    if (!isRecord(value.routing) || Object.keys(value.routing).some((key) => !['enabled', 'selection', 'prefer_local'].includes(key)))
      throw new TypeError('routing settings may contain only enabled, selection, and prefer_local');
    if ('enabled' in value.routing && typeof value.routing.enabled !== 'boolean') throw new TypeError('routing.enabled must be boolean');
    if ('selection' in value.routing && !['balanced', 'quality', 'cost', 'speed'].includes(value.routing.selection))
      throw new TypeError('routing.selection must be balanced, quality, cost, or speed');
    if ('prefer_local' in value.routing && typeof value.routing.prefer_local !== 'boolean')
      throw new TypeError('routing.prefer_local must be boolean');
  }
  if ('budgets' in value) {
    if (!isRecord(value.budgets) || Object.keys(value.budgets).some((key) => !RUNTIME_OVERRIDE_BUDGET_FIELDS.includes(key)))
      throw new TypeError('budgets contains an unsupported setting');
    for (const [key, amount] of Object.entries(value.budgets)) {
      const isCost = key.endsWith('_cost');
      if (
        amount !== null &&
        (typeof amount !== 'number' ||
          !Number.isFinite(amount) ||
          amount < 0 ||
          (!isCost && (!Number.isSafeInteger(amount) || (key !== 'recovery_summary_input_tokens' && amount < 1) || amount > 1_000_000_000)))
      )
        throw new TypeError(`budgets.${key} must be null or a non-negative ${isCost ? 'number' : 'positive integer'}`);
    }
    if (
      value.budgets.final_response_reserve_tokens !== undefined &&
      value.budgets.final_response_reserve_tokens !== null &&
      value.budgets.max_output_tokens !== undefined &&
      value.budgets.max_output_tokens !== null &&
      value.budgets.final_response_reserve_tokens >= value.budgets.max_output_tokens
    )
      throw new TypeError('budgets.final_response_reserve_tokens must be smaller than max_output_tokens');
  }
  if ('tools' in value) {
    if (!isRecord(value.tools) || Object.keys(value.tools).some((key) => key !== 'autonomy'))
      throw new TypeError('Runtime tools settings may contain only autonomy');
    if (!['assisted', 'unrestricted'].includes(value.tools.autonomy))
      throw new TypeError('tools.autonomy must be assisted or unrestricted');
  }
  if ('subagents' in value) {
    const subagents = value.subagents;
    if (
      !isRecord(subagents) ||
      Object.keys(subagents).some((key) => !['enabled', 'max_concurrent', 'max_turns', 'timeout_ms'].includes(key))
    )
      throw new TypeError('subagents contains an unsupported setting');
    if ('enabled' in subagents && typeof subagents.enabled !== 'boolean') throw new TypeError('subagents.enabled must be boolean');
    if (
      'max_concurrent' in subagents &&
      (!Number.isInteger(subagents.max_concurrent) || subagents.max_concurrent < 1 || subagents.max_concurrent > 8)
    )
      throw new TypeError('subagents.max_concurrent must be an integer from 1 to 8');
    if ('max_turns' in subagents && (!Number.isInteger(subagents.max_turns) || subagents.max_turns < 1 || subagents.max_turns > 20))
      throw new TypeError('subagents.max_turns must be an integer from 1 to 20');
    if (
      'timeout_ms' in subagents &&
      (!Number.isInteger(subagents.timeout_ms) || subagents.timeout_ms < 1000 || subagents.timeout_ms > 1_800_000)
    )
      throw new TypeError('subagents.timeout_ms must be an integer from 1000 to 1800000');
    if (Object.keys(subagents).length === 0) throw new TypeError('subagents requires at least one setting');
  }
  if ('ui' in value) {
    if (
      !isRecord(value.ui) ||
      Object.keys(value.ui).some((key) => !['sidebar_collapsed', 'theme', 'shortcuts_enabled', 'shortcuts'].includes(key))
    )
      throw new TypeError('Runtime UI settings contain an unsupported setting');
    if ('sidebar_collapsed' in value.ui && typeof value.ui.sidebar_collapsed !== 'boolean')
      throw new TypeError('ui.sidebar_collapsed must be boolean');
    if ('theme' in value.ui && !['system', 'dark', 'light'].includes(value.ui.theme))
      throw new TypeError('ui.theme must be system, dark, or light');
    if ('shortcuts_enabled' in value.ui && typeof value.ui.shortcuts_enabled !== 'boolean')
      throw new TypeError('ui.shortcuts_enabled must be boolean');
    if ('shortcuts' in value.ui) {
      const allowed = ['toggle_sidebar', 'new_session', 'focus_search'];
      const shortcuts = value.ui.shortcuts;
      if (!isRecord(shortcuts) || !Object.keys(shortcuts).length || Object.keys(shortcuts).some((key) => !allowed.includes(key)))
        throw new TypeError('ui.shortcuts must contain supported shortcut actions');
      for (const [action, binding] of Object.entries(shortcuts))
        if (binding !== null && !isValidUiShortcut(binding))
          throw new TypeError(`ui.shortcuts.${action} must be Ctrl/Alt plus a letter or number, optionally Shift, or /`);
    }
  }
  if (
    'memory' in value &&
    (!isRecord(value.memory) ||
      Object.keys(value.memory).some((key) => key !== 'global_enabled') ||
      ('global_enabled' in value.memory && typeof value.memory.global_enabled !== 'boolean'))
  )
    throw new TypeError('memory settings may contain only a boolean global_enabled');
  if ('web_search' in value) {
    const search = value.web_search;
    if (
      !isRecord(search) ||
      Object.keys(search).some(
        (key) => !['enabled', 'provider', 'api_key_env', 'api_key_secret', 'max_results', 'timeout_ms'].includes(key),
      )
    )
      throw new TypeError('web_search contains an unsupported setting');
    if ('enabled' in search && typeof search.enabled !== 'boolean') throw new TypeError('web_search.enabled must be boolean');
    if ('provider' in search && !['automatic', 'brave', 'wikipedia'].includes(search.provider))
      throw new TypeError("web_search.provider must be 'automatic', 'brave', or 'wikipedia'");
    if (
      'api_key_env' in search &&
      search.api_key_env !== null &&
      (typeof search.api_key_env !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(search.api_key_env))
    )
      throw new TypeError('web_search.api_key_env must be an environment variable name or null');
    if (
      'api_key_secret' in search &&
      search.api_key_secret !== null &&
      (typeof search.api_key_secret !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(search.api_key_secret))
    )
      throw new TypeError('web_search.api_key_secret must be a vault key or null');
    if (search.api_key_env && search.api_key_secret)
      throw new TypeError('web_search must configure only one of api_key_env or api_key_secret');
    if ('max_results' in search && (!Number.isInteger(search.max_results) || search.max_results < 1 || search.max_results > 10))
      throw new TypeError('web_search.max_results must be between 1 and 10');
    if ('timeout_ms' in search && (!Number.isInteger(search.timeout_ms) || search.timeout_ms < 1000 || search.timeout_ms > 60000))
      throw new TypeError('web_search.timeout_ms must be between 1000 and 60000');
    if (!Object.keys(search).length) throw new TypeError('web_search requires at least one setting');
  }
  if ('app_data' in value) {
    const directory = value.app_data?.directory;
    if (
      !isRecord(value.app_data) ||
      Object.keys(value.app_data).some((key) => key !== 'directory') ||
      (directory !== null &&
        (typeof directory !== 'string' ||
          !directory.trim() ||
          directory.length > 4096 ||
          /[\u0000-\u001f]/.test(directory) ||
          !path.isAbsolute(directory)))
    )
      throw new TypeError('app_data.directory must be an absolute path for this platform, up to 4096 characters');
  }
  if ('mcp' in value) {
    if (!isRecord(value.mcp) || Object.keys(value.mcp).some((key) => key !== 'servers'))
      throw new TypeError('mcp runtime settings may contain only servers');
    if (!isRecord(value.mcp.servers) || Object.keys(value.mcp.servers).length > 16)
      throw new TypeError('mcp.servers must contain at most 16 server overrides');
    for (const [name, server] of Object.entries(value.mcp.servers)) {
      if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) throw new TypeError(`mcp.servers.${name} has an invalid name`);
      const allowed = ['enabled', 'transport', 'command', 'package_id', 'args', 'cwd', 'timeout_ms', 'env', 'url', 'headers'];
      if (server === null) continue;
      if (!isRecord(server) || Object.keys(server).some((key) => !allowed.includes(key)) || !Object.keys(server).length)
        throw new TypeError(`mcp.servers.${name} contains an unsupported server setting`);
      if ('enabled' in server && typeof server.enabled !== 'boolean') throw new TypeError(`mcp.servers.${name}.enabled must be boolean`);
      if ('transport' in server && !['stdio', 'streamable_http', 'sse'].includes(server.transport))
        throw new TypeError(`mcp.servers.${name}.transport must be stdio, streamable_http, or sse`);
      if (
        'command' in server &&
        server.command !== null &&
        (typeof server.command !== 'string' ||
          !server.command.trim() ||
          server.command.length > 2048 ||
          /[\u0000-\u001f]/.test(server.command))
      )
        throw new TypeError(`mcp.servers.${name}.command must be a string up to 2048 characters or null`);
      if (
        'package_id' in server &&
        server.package_id !== null &&
        (typeof server.package_id !== 'string' || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(server.package_id) || server.package_id.length > 96)
      )
        throw new TypeError(`mcp.servers.${name}.package_id must be a signed MCP package ID or null`);
      if (
        'args' in server &&
        server.args !== null &&
        (!Array.isArray(server.args) ||
          server.args.length > 128 ||
          server.args.some((arg) => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\u0000')))
      )
        throw new TypeError(`mcp.servers.${name}.args must be an array of at most 128 bounded strings or null`);
      if (
        'cwd' in server &&
        server.cwd !== null &&
        (typeof server.cwd !== 'string' || !server.cwd.trim() || server.cwd.length > 4096 || /[\u0000-\u001f]/.test(server.cwd))
      )
        throw new TypeError(`mcp.servers.${name}.cwd must be a string up to 4096 characters or null`);
      if (
        'timeout_ms' in server &&
        server.timeout_ms !== null &&
        (!Number.isInteger(server.timeout_ms) || server.timeout_ms < 1000 || server.timeout_ms > 120_000)
      )
        throw new TypeError(`mcp.servers.${name}.timeout_ms must be between 1000 and 120000 or null`);
      for (const key of ['env', 'headers']) {
        if (!(key in server) || server[key] === null) continue;
        if (!isRecord(server[key]) || Object.keys(server[key]).length > (key === 'env' ? 64 : 32))
          throw new TypeError(`mcp.servers.${name}.${key} must be a bounded reference object or null`);
        for (const [target, reference] of Object.entries(server[key])) {
          if (
            (key === 'env' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(target)) ||
            (key === 'headers' &&
              (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(target) ||
                /^(accept|content-type|mcp-protocol-version|mcp-method|mcp-name|mcp-session-id|host|content-length)$/i.test(target))) ||
            typeof reference !== 'string' ||
            (!/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(reference) && !/^secret:[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(reference))
          )
            throw new TypeError(`mcp.servers.${name}.${key} values must be credential references`);
        }
      }
      if ('url' in server && server.url !== null && (typeof server.url !== 'string' || server.url.length > 2048))
        throw new TypeError(`mcp.servers.${name}.url must be a string up to 2048 characters or null`);
    }
  }
  if ('sandbox' in value) {
    if (!isRecord(value.sandbox) || Object.keys(value.sandbox).some((key) => !['mode', 'tools'].includes(key)))
      throw new TypeError('sandbox settings contain an unsupported setting');
    if ('mode' in value.sandbox) {
      const mode = normalizeSandboxMode(value.sandbox.mode);
      if (mode === null) throw new TypeError(`sandbox.mode must be one of ${SANDBOX_MODES.join(', ')}`);
      value.sandbox.mode = mode;
    }
    if ('tools' in value.sandbox) {
      if (!isRecord(value.sandbox.tools) || Object.keys(value.sandbox.tools).some((toolName) => !SANDBOX_PROCESS_TOOLS.includes(toolName)))
        throw new TypeError('sandbox.tools may contain only supported process-capable tools');
      for (const [toolName, override] of Object.entries(value.sandbox.tools)) {
        if (override === null) continue;
        const mode = normalizeSandboxMode(override);
        if (mode === null) throw new TypeError(`sandbox.tools.${toolName} must be one of ${SANDBOX_MODES.join(', ')}`);
        value.sandbox.tools[toolName] = mode;
      }
    }
  }
  if ('app_updates' in value) {
    const allowed = ['mode', 'channel', 'feed_url', 'key_id', 'public_key'];
    const updates = value.app_updates;
    if (!isRecord(updates) || Object.keys(updates).some((key) => !allowed.includes(key)))
      throw new TypeError('app_updates contains an unsupported setting');
    if ('mode' in updates && !['disabled', 'manual', 'notify'].includes(updates.mode))
      throw new TypeError('app_updates.mode must be disabled, manual, or notify');
    if ('channel' in updates && !['stable', 'preview'].includes(updates.channel))
      throw new TypeError('app_updates.channel must be stable or preview');
    if ('feed_url' in updates && updates.feed_url !== null) {
      let url;
      try {
        url = new URL(updates.feed_url);
      } catch {
        throw new TypeError('app_updates.feed_url must be a public HTTPS URL without credentials, query, or fragment');
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
        throw new TypeError('app_updates.feed_url must be a public HTTPS URL without credentials, query, or fragment');
    }
    if (
      'key_id' in updates &&
      updates.key_id !== null &&
      (typeof updates.key_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(updates.key_id))
    )
      throw new TypeError('app_updates.key_id must be a valid signing key ID or null');
    if ('public_key' in updates && updates.public_key !== null) {
      if (typeof updates.public_key !== 'string' || updates.public_key.length > 8192)
        throw new TypeError('app_updates.public_key must be an Ed25519 PEM key up to 8192 characters or null');
      try {
        if (!/^-----BEGIN PUBLIC KEY-----\r?\n[\s\S]+\r?\n-----END PUBLIC KEY-----$/.test(updates.public_key.trim()))
          throw new Error('expected public-key PEM');
        if (createPublicKey(updates.public_key).asymmetricKeyType !== 'ed25519') throw new Error('wrong key type');
      } catch {
        throw new TypeError('app_updates.public_key must be a valid Ed25519 PEM key or null');
      }
    }
  }
  if ('models' in value) {
    if (!isRecord(value.models) || Object.keys(value.models).length > 32)
      throw new TypeError('models must be an object with at most 32 profiles');
    const allowed = [
      'provider',
      'base_url',
      'model',
      'api_key_env',
      'api_key_secret',
      'context_length',
      'context_mode',
      'timeout_ms',
      'retry_attempts',
      'reasoning_effort',
      'prompt_cache_enabled',
      'prompt_cache_key',
      'prompt_cache_retention',
      'input_cost_per_million',
      'cached_input_cost_per_million',
      'output_cost_per_million',
      'pricing_updated_at',
      'pricing_source',
      'capabilities_updated_at',
      'capabilities_source',
      'local',
      'supports_tools',
      'supports_vision',
      'coding_strength',
      'tool_calling_quality',
      'speed_score',
      'priority',
    ];
    for (const [name, profile] of Object.entries(value.models)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) throw new TypeError(`models.${name} has an invalid profile name`);
      if (profile === null) continue;
      if (!isRecord(profile) || Object.keys(profile).some((key) => !allowed.includes(key)))
        throw new TypeError(`models.${name} contains an unsupported profile setting`);
      if ('provider' in profile && profile.provider !== 'openai-compatible')
        throw new TypeError(`models.${name}.provider must be openai-compatible`);
      for (const key of ['base_url', 'model', 'api_key_env', 'api_key_secret']) {
        const limit = key === 'base_url' ? 2048 : 200;
        if (
          key in profile &&
          profile[key] !== null &&
          (typeof profile[key] !== 'string' || !profile[key].trim() || profile[key].length > limit)
        )
          throw new TypeError(`models.${name}.${key} must be a non-empty bounded string or null`);
      }
      if ('base_url' in profile && profile.base_url !== null) {
        let endpoint;
        try {
          endpoint = new URL(profile.base_url);
        } catch {
          throw new TypeError(`models.${name}.base_url must be a valid HTTP(S) URL`);
        }
        if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash || endpoint.search)
          throw new TypeError(`models.${name}.base_url must be an HTTP(S) URL without credentials, query, or fragment`);
      }
      if ('api_key_env' in profile && profile.api_key_env !== null && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(profile.api_key_env))
        throw new TypeError(`models.${name}.api_key_env must be an environment variable name`);
      if (
        'api_key_secret' in profile &&
        profile.api_key_secret !== null &&
        !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(profile.api_key_secret)
      )
        throw new TypeError(`models.${name}.api_key_secret must be a vault key`);
      for (const key of ['context_length', 'timeout_ms'])
        if (
          key in profile &&
          profile[key] !== null &&
          (!Number.isSafeInteger(profile[key]) || profile[key] < 1 || profile[key] > 10_000_000)
        )
          throw new TypeError(`models.${name}.${key} must be a positive bounded integer`);
      if (profile.context_mode !== undefined && profile.context_mode !== null && !['auto', 'manual'].includes(profile.context_mode))
        throw new TypeError(`models.${name}.context_mode must be auto or manual`);
      if (
        'retry_attempts' in profile &&
        profile.retry_attempts !== null &&
        (!Number.isSafeInteger(profile.retry_attempts) || profile.retry_attempts < 0 || profile.retry_attempts > 2)
      )
        throw new TypeError(`models.${name}.retry_attempts must be an integer from 0 to 2`);
      if (
        'reasoning_effort' in profile &&
        profile.reasoning_effort !== null &&
        !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(profile.reasoning_effort)
      )
        throw new TypeError(`models.${name}.reasoning_effort must be none, minimal, low, medium, high, or xhigh`);
      if ('prompt_cache_enabled' in profile && profile.prompt_cache_enabled !== null && typeof profile.prompt_cache_enabled !== 'boolean')
        throw new TypeError(`models.${name}.prompt_cache_enabled must be boolean`);
      if (
        'prompt_cache_key' in profile &&
        profile.prompt_cache_key !== null &&
        (typeof profile.prompt_cache_key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(profile.prompt_cache_key))
      )
        throw new TypeError(`models.${name}.prompt_cache_key must be a non-sensitive identifier of at most 64 characters`);
      if ('prompt_cache_retention' in profile && profile.prompt_cache_retention !== null && profile.prompt_cache_retention !== '24h')
        throw new TypeError(`models.${name}.prompt_cache_retention must be 24h`);
      if (
        'priority' in profile &&
        profile.priority !== null &&
        (!Number.isSafeInteger(profile.priority) || profile.priority < 0 || profile.priority > 1000)
      )
        throw new TypeError(`models.${name}.priority must be an integer from 0 to 1000`);
      for (const key of ['coding_strength', 'tool_calling_quality', 'speed_score'])
        if (key in profile && profile[key] !== null && (!Number.isSafeInteger(profile[key]) || profile[key] < 1 || profile[key] > 10))
          throw new TypeError(`models.${name}.${key} must be an integer from 1 to 10`);
      for (const key of ['input_cost_per_million', 'cached_input_cost_per_million', 'output_cost_per_million'])
        if (
          key in profile &&
          profile[key] !== null &&
          (typeof profile[key] !== 'number' || !Number.isFinite(profile[key]) || profile[key] < 0)
        )
          throw new TypeError(`models.${name}.${key} must be a non-negative number`);
      if ('pricing_updated_at' in profile && profile.pricing_updated_at !== null && !isValidPricingDate(profile.pricing_updated_at))
        throw new TypeError(`models.${name}.pricing_updated_at must be a valid date no later than today (YYYY-MM-DD)`);
      if (
        'pricing_source' in profile &&
        profile.pricing_source !== null &&
        (typeof profile.pricing_source !== 'string' ||
          !profile.pricing_source.trim() ||
          profile.pricing_source.length > 256 ||
          /[\u0000-\u001f]/.test(profile.pricing_source))
      )
        throw new TypeError(`models.${name}.pricing_source must be a non-empty note of at most 256 characters`);
      if (
        'capabilities_updated_at' in profile &&
        profile.capabilities_updated_at !== null &&
        !isValidPricingDate(profile.capabilities_updated_at)
      )
        throw new TypeError(`models.${name}.capabilities_updated_at must be a valid date no later than today (YYYY-MM-DD)`);
      if (
        'capabilities_source' in profile &&
        profile.capabilities_source !== null &&
        (typeof profile.capabilities_source !== 'string' ||
          !profile.capabilities_source.trim() ||
          profile.capabilities_source.length > 256 ||
          /[\u0000-\u001f]/.test(profile.capabilities_source))
      )
        throw new TypeError(`models.${name}.capabilities_source must be a non-empty note of at most 256 characters`);
      for (const key of ['local', 'supports_tools', 'supports_vision'])
        if (key in profile && profile[key] !== null && typeof profile[key] !== 'boolean')
          throw new TypeError(`models.${name}.${key} must be boolean`);
    }
  }
  if (Object.keys(value).length === 0) throw new TypeError('At least one runtime setting is required');
  return structuredClone(value);
}

export async function loadRuntimeOverrides(filePath) {
  if (!filePath) return {};
  let info;
  try {
    info = await fs.lstat(filePath, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (await hasAtomicWriteBackup(filePath))
        throw Object.assign(new Error('Runtime settings have an interrupted replacement backup; update settings to recover it safely'), {
          code: 'SETTINGS_RECOVERY_REQUIRED',
        });
      return {};
    }
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1n || info.size > BigInt(MAX_OVERRIDE_BYTES))
    throw new Error('Runtime settings file must be a bounded regular file');
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  let bytes;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink > 1n || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size)
      throw new Error('Runtime settings file changed while it was being opened');
    if (opened.size > BigInt(MAX_OVERRIDE_BYTES)) throw new Error('Runtime settings file must be a bounded regular file');
    bytes = await readBoundedFileHandle(handle, MAX_OVERRIDE_BYTES);
    if (bytes === null) throw new Error('Runtime settings file must be a bounded regular file');
    const [after, current] = await Promise.all([handle.stat({ bigint: true }), fs.lstat(filePath, { bigint: true })]);
    if (!sameRuntimeSettingsVersion(opened, after) || !sameRuntimeSettingsVersion(opened, current))
      throw new Error('Runtime settings file changed while it was being read');
  } finally {
    await handle.close();
  }
  const parsed = JSON.parse(bytes.toString('utf8'));
  return validateRuntimeOverrides(parsed);
}

function sameRuntimeSettingsVersion(first, second) {
  return (
    second.isFile() &&
    !second.isSymbolicLink() &&
    second.nlink <= 1n &&
    second.dev === first.dev &&
    second.ino === first.ino &&
    second.size === first.size &&
    second.mtimeNs === first.mtimeNs &&
    second.ctimeNs === first.ctimeNs
  );
}

export async function updateRuntimeOverrides(filePath, patch, { lockWaitMs = 10_000 } = {}) {
  const validatedPatch = validateRuntimeOverrides(patch);
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + lockWaitMs;
  let lockHandle;
  while (!lockHandle && Date.now() <= deadline) {
    try {
      lockHandle = await fs.open(lockPath, 'wx', 0o600);
    } catch (error) {
      const competingLock =
        error.code === 'EEXIST' ||
        // Windows can report EPERM for a concurrent CREATE_NEW/open race on
        // an existing lock file. Treat it as contention and let the bounded
        // deadline distinguish a live lock from an unusable settings folder.
        (process.platform === 'win32' && error.code === 'EPERM');
      if (!competingLock) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!lockHandle)
    throw Object.assign(new Error('Timed out waiting for the runtime settings lock; inspect the adjacent .lock file before recovery'), {
      code: 'SETTINGS_LOCKED',
    });
  const lockRecord = JSON.stringify({ lock_id: randomUUID(), pid: process.pid, started_at: new Date().toISOString() });
  let lockIdentity;
  try {
    lockIdentity = await lockHandle.stat();
    await lockHandle.writeFile(lockRecord);
    await restoreAtomicWriteBackup(filePath, {
      maxBytes: MAX_OVERRIDE_BYTES,
      decode: (serialized) => validateRuntimeOverrides(JSON.parse(serialized)),
    });
    const merged = mergeSettings(await loadRuntimeOverrides(filePath), validatedPatch);
    validateRuntimeOverrides(merged);
    await writeRuntimeOverrides(filePath, merged);
    return merged;
  } finally {
    await lockHandle.close().catch(() => {});
    if (lockIdentity) {
      const current = await fs.lstat(lockPath).catch(() => null);
      const stableIdentity = Number.isFinite(lockIdentity.ino) && lockIdentity.ino !== 0;
      if (
        current?.isFile() &&
        !current.isSymbolicLink() &&
        (!stableIdentity || (current.dev === lockIdentity.dev && current.ino === lockIdentity.ino))
      ) {
        const currentRecord = await fs.readFile(lockPath, 'utf8').catch(() => null);
        if (currentRecord === lockRecord) await fs.rm(lockPath, { force: true }).catch(() => {});
      }
    }
  }
}

async function writeRuntimeOverrides(filePath, merged) {
  try {
    const info = await fs.lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Runtime settings path must be a regular file');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (Buffer.byteLength(JSON.stringify(merged)) > MAX_OVERRIDE_BYTES) throw new Error('Runtime settings exceed the size limit');
  await atomicWriteJson(filePath, merged, { mode: 0o600 });
}

function mergeSettings(current, patch) {
  const result = structuredClone(current || {});
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'ui') {
      const target = (result.ui ||= {});
      for (const [setting, entry] of Object.entries(value)) {
        if (setting === 'shortcuts') target.shortcuts = { ...(target.shortcuts || {}), ...entry };
        else target[setting] = entry;
      }
    } else if (key === 'sandbox') {
      const target = (result.sandbox ||= {});
      for (const [setting, entry] of Object.entries(value)) {
        if (setting === 'tools') {
          const tools = (target.tools ||= {});
          for (const [toolName, mode] of Object.entries(entry)) tools[toolName] = mode;
        } else target[setting] = entry;
      }
    } else if (key === 'budgets' || key === 'tools' || key === 'subagents' || key === 'app_updates' || key === 'web_search') {
      const target = (result[key] ||= {});
      for (const [setting, amount] of Object.entries(value)) target[setting] = amount;
    } else if (key === 'models') {
      const target = (result.models ||= {});
      for (const [profile, patch] of Object.entries(value)) {
        if (patch === null) {
          target[profile] = null;
          continue;
        }
        const current = isRecord(target[profile]) ? target[profile] : (target[profile] = {});
        for (const [setting, settingValue] of Object.entries(patch)) current[setting] = settingValue;
      }
    } else if (key === 'mcp') {
      const target = (result.mcp ||= {});
      const servers = (target.servers ||= {});
      for (const [name, server] of Object.entries(value.servers || {})) {
        if (server === null) {
          servers[name] = null;
          continue;
        }
        servers[name] = { ...(isRecord(servers[name]) ? servers[name] : {}), ...server };
      }
    } else result[key] = key === 'routing' ? { ...(result[key] || {}), ...value } : value;
  }
  return result;
}
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidPricingDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && value <= new Date().toISOString().slice(0, 10);
}
