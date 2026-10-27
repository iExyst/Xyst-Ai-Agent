import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { loadRuntimeOverrides, updateRuntimeOverrides, validateRuntimeOverrides } from '../src/config/runtime-overrides.mjs';
import { loadConfig } from '../src/config/load.mjs';
import { createTempDirectory } from './helpers.mjs';

test('runtime settings schema rejects provider and credential fields and malformed caps', () => {
  assert.throws(() => validateRuntimeOverrides({ models: { local: { api_key: 'secret' } } }), /unsupported profile setting/);
  assert.deepEqual(validateRuntimeOverrides({ models: { local: { reasoning_effort: 'none' } } }), {
    models: { local: { reasoning_effort: 'none' } },
  });
  assert.throws(() => validateRuntimeOverrides({ models: { local: { reasoning_effort: 'extreme' } } }), /reasoning_effort/);
  assert.deepEqual(validateRuntimeOverrides({ sandbox: { mode: 'required' } }), { sandbox: { mode: 'workspace-write' } });
  assert.deepEqual(validateRuntimeOverrides({ sandbox: { mode: 'workspace-read', tools: { run_process: 'read-only' } } }), {
    sandbox: { mode: 'workspace-read', tools: { run_process: 'read-only' } },
  });
  assert.deepEqual(validateRuntimeOverrides({ sandbox: { tools: { run_process: null } } }), { sandbox: { tools: { run_process: null } } });
  assert.deepEqual(validateRuntimeOverrides({ review_model: 'reviewer', plan_model: null }), {
    review_model: 'reviewer',
    plan_model: null,
  });
  assert.throws(() => validateRuntimeOverrides({ review_model: '' }), /configured profile name or null/);
  assert.throws(() => validateRuntimeOverrides({ plan_model: 42 }), /configured profile name or null/);
  const capabilityReviewDate = new Date().toISOString().slice(0, 10);
  assert.deepEqual(
    validateRuntimeOverrides({
      models: { local: { capabilities_updated_at: capabilityReviewDate, capabilities_source: 'Provider model docs' } },
    }),
    { models: { local: { capabilities_updated_at: capabilityReviewDate, capabilities_source: 'Provider model docs' } } },
  );
  assert.throws(
    () => validateRuntimeOverrides({ models: { local: { capabilities_updated_at: '2026-02-30' } } }),
    /capabilities_updated_at/,
  );
  assert.throws(() => validateRuntimeOverrides({ models: { local: { capabilities_source: 'bad\nsource' } } }), /capabilities_source/);
  assert.deepEqual(
    validateRuntimeOverrides({ models: { local: { coding_strength: 8, tool_calling_quality: 7, speed_score: 9, priority: 0 } } }),
    { models: { local: { coding_strength: 8, tool_calling_quality: 7, speed_score: 9, priority: 0 } } },
  );
  assert.throws(() => validateRuntimeOverrides({ models: { local: { coding_strength: 0 } } }), /coding_strength.*1 to 10/);
  assert.throws(() => validateRuntimeOverrides({ models: { local: { speed_score: 2.5 } } }), /speed_score.*1 to 10/);
  assert.throws(() => validateRuntimeOverrides({ models: { local: { priority: 1001 } } }), /priority.*0 to 1000/);
  assert.deepEqual(
    validateRuntimeOverrides({
      models: { remote: { prompt_cache_enabled: true, prompt_cache_key: 'xyst-main', prompt_cache_retention: '24h' } },
    }),
    { models: { remote: { prompt_cache_enabled: true, prompt_cache_key: 'xyst-main', prompt_cache_retention: '24h' } } },
  );
  assert.deepEqual(validateRuntimeOverrides({ models: { remote: { prompt_cache_retention: '24h' } } }), {
    models: { remote: { prompt_cache_retention: '24h' } },
  });
  assert.throws(
    () => validateRuntimeOverrides({ models: { remote: { prompt_cache_enabled: true, prompt_cache_key: 'contains spaces' } } }),
    /non-sensitive identifier/,
  );
  assert.throws(() => validateRuntimeOverrides({ sandbox: { mode: 'pretend' } }), /sandbox.mode must be one of/);
  assert.deepEqual(validateRuntimeOverrides({ routing: { enabled: false, selection: 'quality' } }), {
    routing: { enabled: false, selection: 'quality' },
  });
  assert.throws(() => validateRuntimeOverrides({ routing: { enabled: 'false' } }), /routing.enabled/);
  assert.throws(
    () => validateRuntimeOverrides({ routing: { base_url: 'https://example.com' } }),
    /only enabled, selection, and prefer_local/,
  );
  assert.throws(() => validateRuntimeOverrides({ budgets: { max_daily_input_tokens: 1.5 } }), /positive integer/);
  assert.deepEqual(validateRuntimeOverrides({ budgets: { recovery_summary_input_tokens: 0 } }), {
    budgets: { recovery_summary_input_tokens: 0 },
  });
  assert.throws(() => validateRuntimeOverrides({ budgets: { recovery_summary_input_tokens: 1.5 } }), /positive integer/);
  assert.throws(() => validateRuntimeOverrides({ budgets: { max_daily_cost: -1 } }), /non-negative number/);
  assert.deepEqual(validateRuntimeOverrides({ budgets: { max_daily_cost: null } }), { budgets: { max_daily_cost: null } });
  assert.deepEqual(
    validateRuntimeOverrides({ budgets: { max_turns: 12, max_tool_output_bytes: 16_000, final_response_reserve_tokens: 100 } }),
    { budgets: { max_turns: 12, max_tool_output_bytes: 16_000, final_response_reserve_tokens: 100 } },
  );
  assert.throws(
    () => validateRuntimeOverrides({ budgets: { max_output_tokens: 400, final_response_reserve_tokens: 400 } }),
    /smaller than max_output_tokens/,
  );
  assert.deepEqual(validateRuntimeOverrides({ tools: { autonomy: 'unrestricted' } }), { tools: { autonomy: 'unrestricted' } });
  assert.throws(() => validateRuntimeOverrides({ tools: { shell_enabled: true } }), /only autonomy/);
  assert.throws(() => validateRuntimeOverrides({ tools: { autonomy: 'root' } }), /assisted or unrestricted/);
  assert.deepEqual(validateRuntimeOverrides({ subagents: { enabled: true, max_concurrent: 3 } }), {
    subagents: { enabled: true, max_concurrent: 3 },
  });
  assert.throws(() => validateRuntimeOverrides({ subagents: { enabled: 'yes' } }), /subagents.enabled must be boolean/);
  assert.throws(() => validateRuntimeOverrides({ subagents: { max_concurrent: 9 } }), /max_concurrent must be an integer from 1 to 8/);
  assert.throws(() => validateRuntimeOverrides({ subagents: { timeout_ms: 999 } }), /timeout_ms must be an integer from 1000/);
  assert.throws(() => validateRuntimeOverrides({ subagents: { command: 'node' } }), /unsupported setting/);
  assert.deepEqual(validateRuntimeOverrides({ ui: { sidebar_collapsed: true } }), { ui: { sidebar_collapsed: true } });
  assert.deepEqual(validateRuntimeOverrides({ ui: { shortcuts_enabled: false } }), { ui: { shortcuts_enabled: false } });
  assert.throws(() => validateRuntimeOverrides({ ui: { shortcuts_enabled: 'false' } }), /shortcuts_enabled must be boolean/);
  assert.deepEqual(validateRuntimeOverrides({ ui: { theme: 'light' } }), { ui: { theme: 'light' } });
  assert.deepEqual(validateRuntimeOverrides({ memory: { global_enabled: true } }), { memory: { global_enabled: true } });
  assert.deepEqual(validateRuntimeOverrides({ app_data: { directory: path.resolve('xyst-data') } }), {
    app_data: { directory: path.resolve('xyst-data') },
  });
  assert.throws(() => validateRuntimeOverrides({ app_data: { directory: 'relative-data' } }), /absolute path/);
  assert.throws(() => validateRuntimeOverrides({ app_data: { directory: 'x'.repeat(4097) } }), /absolute path/);
  assert.deepEqual(validateRuntimeOverrides({ mcp: { servers: { docs: { enabled: false }, legacy: null } } }), {
    mcp: { servers: { docs: { enabled: false }, legacy: null } },
  });
  assert.deepEqual(
    validateRuntimeOverrides({ mcp: { servers: { legacy: { transport: 'sse', url: 'https://mcp.example.test/events' } } } }),
    {
      mcp: { servers: { legacy: { transport: 'sse', url: 'https://mcp.example.test/events' } } },
    },
  );
  assert.throws(() => validateRuntimeOverrides({ mcp: { servers: { legacy: { transport: 'websocket' } } } }), /transport/);
  assert.deepEqual(
    validateRuntimeOverrides({ mcp: { servers: { docs: { command: 'node', args: ['server.js'], env: { TOKEN: 'secret:token' } } } } }),
    { mcp: { servers: { docs: { command: 'node', args: ['server.js'], env: { TOKEN: 'secret:token' } } } } },
  );
  assert.throws(() => validateRuntimeOverrides({ mcp: { servers: { docs: { env: { TOKEN: 'plaintext' } } } } }), /credential references/);
  assert.throws(() => validateRuntimeOverrides({ mcp: { servers: { docs: { command: 'x'.repeat(2049) } } } }), /2048 characters/);
  assert.throws(() => validateRuntimeOverrides({ memory: { global_enabled: 'yes' } }), /boolean global_enabled/);
  assert.throws(() => validateRuntimeOverrides({ memory: { path: 'C:\\outside' } }), /boolean global_enabled/);
  assert.throws(() => validateRuntimeOverrides({ ui: { theme: 'solarized' } }), /theme must be system, dark, or light/);
  assert.throws(() => validateRuntimeOverrides({ ui: { sidebar_collapsed: 'true' } }), /must be boolean/);
  assert.deepEqual(validateRuntimeOverrides({ models: { local: { base_url: 'http://127.0.0.1:1234/v1', model: 'local-coder' } } }), {
    models: { local: { base_url: 'http://127.0.0.1:1234/v1', model: 'local-coder' } },
  });
  assert.deepEqual(validateRuntimeOverrides({ models: { local: { retry_attempts: 2 } } }), { models: { local: { retry_attempts: 2 } } });
  assert.throws(() => validateRuntimeOverrides({ models: { local: { retry_attempts: 3 } } }), /retry_attempts/);
  assert.throws(() => validateRuntimeOverrides({ models: { local: { base_url: 'file:///etc/passwd' } } }), /HTTP\(S\) URL/);
  assert.throws(
    () => validateRuntimeOverrides({ models: { local: { base_url: 'https://provider.example/v1?api_key=secret' } } }),
    /without credentials, query, or fragment/,
  );
  assert.throws(() => validateRuntimeOverrides({ models: { local: { api_key: 'plaintext-secret' } } }), /unsupported profile setting/);
  assert.deepEqual(validateRuntimeOverrides({ models: { unused: null } }), { models: { unused: null } });
  assert.deepEqual(validateRuntimeOverrides({ models: { local: { cached_input_cost_per_million: 0.25 } } }), {
    models: { local: { cached_input_cost_per_million: 0.25 } },
  });
  assert.throws(
    () => validateRuntimeOverrides({ models: { local: { cached_input_cost_per_million: -1 } } }),
    /cached_input_cost_per_million must be a non-negative number/,
  );
  const today = new Date().toISOString().slice(0, 10);
  assert.deepEqual(
    validateRuntimeOverrides({ models: { local: { pricing_updated_at: today, pricing_source: 'Official pricing page' } } }),
    { models: { local: { pricing_updated_at: today, pricing_source: 'Official pricing page' } } },
  );
  assert.throws(() => validateRuntimeOverrides({ models: { local: { pricing_updated_at: '2026-02-30' } } }), /pricing_updated_at/);
  assert.throws(() => validateRuntimeOverrides({ models: { local: { pricing_source: 'bad\nsource' } } }), /pricing_source/);
});

test('web search runtime settings accept safe Brave configuration and merge with user configuration', async () => {
  assert.deepEqual(validateRuntimeOverrides({ web_search: { enabled: true, provider: 'wikipedia' } }), {
    web_search: { enabled: true, provider: 'wikipedia' },
  });
  assert.deepEqual(validateRuntimeOverrides({ web_search: { enabled: true, provider: 'automatic' } }), {
    web_search: { enabled: true, provider: 'automatic' },
  });
  assert.throws(() => validateRuntimeOverrides({ web_search: { enabled: true, api_key: 'secret' } }), /unsupported setting/);
  assert.throws(() => validateRuntimeOverrides({ web_search: { max_results: 11 } }), /between 1 and 10/);
  const directory = await createTempDirectory('xyst-web-search-');
  const userPath = path.join(directory, 'config.toml');
  const runtimePath = `${userPath}.runtime.json`;
  await fs.writeFile(userPath, '[web_search]\nenabled = false\nprovider = "brave"\n');
  await updateRuntimeOverrides(runtimePath, { web_search: { enabled: true, api_key_secret: 'brave.search' } });
  const config = await loadConfig({ configPath: userPath, env: {} });
  assert.equal(config.web_search.enabled, true);
  assert.equal(config.web_search.api_key_secret, 'brave.search');
});

test('runtime data directory persists through config reload and rejects relative paths', async (t) => {
  const directory = await createTempDirectory('xyst-data-dir-setting-');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.toml');
  const runtimePath = `${configPath}.runtime.json`;
  const selectedDirectory = path.join(directory, 'custom-data');
  await updateRuntimeOverrides(runtimePath, { app_data: { directory: selectedDirectory } });
  const config = await loadConfig({ configPath });
  assert.equal(config.app_data.directory, selectedDirectory);
  await assert.rejects(() => updateRuntimeOverrides(runtimePath, { app_data: { directory: 'relative-data' } }), /absolute path/);
  assert.equal((await loadRuntimeOverrides(runtimePath)).app_data.directory, selectedDirectory);
  await updateRuntimeOverrides(runtimePath, { app_data: { directory: null } });
  assert.equal((await loadConfig({ configPath })).app_data?.directory, undefined);
  assert.deepEqual((await loadRuntimeOverrides(runtimePath)).app_data, { directory: null });
});

test('application update preferences accept a trusted Ed25519 key and reject untrusted endpoints or fields', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const trustedPem = publicKey.export({ type: 'spki', format: 'pem' });
  assert.deepEqual(
    validateRuntimeOverrides({
      app_updates: {
        mode: 'notify',
        channel: 'preview',
        feed_url: 'https://updates.example.test/releases.json',
        key_id: 'release-key',
        public_key: trustedPem,
      },
    }).app_updates,
    {
      mode: 'notify',
      channel: 'preview',
      feed_url: 'https://updates.example.test/releases.json',
      key_id: 'release-key',
      public_key: trustedPem,
    },
  );
  assert.throws(() => validateRuntimeOverrides({ app_updates: { feed_url: 'http://updates.example.test/feed' } }), /HTTPS URL/);
  assert.throws(() => validateRuntimeOverrides({ app_updates: { feed_url: 'https://[::1]/feed' } }), /HTTPS URL/);
  assert.throws(() => validateRuntimeOverrides({ app_updates: { public_key: 'not a key' } }), /valid Ed25519 PEM/);
  assert.throws(
    () => validateRuntimeOverrides({ app_updates: { public_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) } }),
    /valid Ed25519 PEM/,
  );
  assert.throws(() => validateRuntimeOverrides({ app_updates: { auto_install: true } }), /unsupported setting/);
});

test('global memory opt-in can be changed through the user runtime settings sidecar', async (t) => {
  const root = await createTempDirectory('xyst-global-memory-setting-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'config.toml');
  const sidecar = `${config}.runtime.json`;
  await fs.writeFile(config, '[memory]\nglobal_enabled = false\n');
  assert.equal((await loadConfig({ configPath: config, env: {} })).memory.global_enabled, false);
  await updateRuntimeOverrides(sidecar, validateRuntimeOverrides({ memory: { global_enabled: true } }));
  assert.equal((await loadConfig({ configPath: config, env: {} })).memory.global_enabled, true);
  await updateRuntimeOverrides(sidecar, validateRuntimeOverrides({ memory: { global_enabled: false } }));
  assert.equal((await loadConfig({ configPath: config, env: {} })).memory.global_enabled, false);
});

test('subagent availability can be enabled in settings and concurrency can be changed without losing other values', async (t) => {
  const root = await createTempDirectory('xyst-subagent-runtime-setting-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'config.toml');
  const sidecar = `${config}.runtime.json`;
  await fs.writeFile(config, '[subagents]\nenabled = false\nmax_concurrent = 2\n');

  await updateRuntimeOverrides(sidecar, { subagents: { enabled: true, max_concurrent: 4 } });
  let loaded = await loadConfig({ configPath: config, env: {} });
  assert.equal(loaded.subagents.enabled, true);
  assert.equal(loaded.subagents.max_concurrent, 4);

  await updateRuntimeOverrides(sidecar, { subagents: { enabled: false } });
  loaded = await loadConfig({ configPath: config, env: {} });
  assert.equal(loaded.subagents.enabled, false);
  assert.equal(loaded.subagents.max_concurrent, 4);
});

test('process sandbox overrides merge independently and null restores the global policy', async (t) => {
  const root = await createTempDirectory('xyst-runtime-sandbox-tools-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'config.toml');
  const sidecar = `${config}.runtime.json`;
  await fs.writeFile(config, '[tools]\nautonomy="assisted"\nfilesystem_scope="workspace"\n');
  await updateRuntimeOverrides(sidecar, { sandbox: { mode: 'none', tools: { run_process: 'workspace-read' } } });
  assert.equal((await loadConfig({ configPath: config, env: {} })).sandbox.tools.run_process, 'workspace-read');
  await updateRuntimeOverrides(sidecar, { sandbox: { tools: { run_process: null, run_shell_script: 'read-only' } } });
  const loaded = await loadConfig({ configPath: config, env: {} });
  assert.equal(loaded.sandbox.tools.run_process, undefined);
  assert.equal(loaded.sandbox.tools.run_shell_script, 'read-only');
});

test('concurrent runtime settings updates serialize and preserve unrelated settings', async (t) => {
  const root = await createTempDirectory('xyst-runtime-overrides-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'config.toml.runtime.json');
  const pricingUpdatedAt = new Date().toISOString().slice(0, 10);
  await Promise.all([
    updateRuntimeOverrides(file, { routing: { selection: 'quality' } }),
    updateRuntimeOverrides(file, { budgets: { max_daily_input_tokens: 5000 } }),
    updateRuntimeOverrides(file, { tools: { autonomy: 'unrestricted' } }),
    updateRuntimeOverrides(file, { ui: { sidebar_collapsed: true } }),
    updateRuntimeOverrides(file, { ui: { theme: 'dark' } }),
    updateRuntimeOverrides(file, { ui: { shortcuts_enabled: false } }),
    updateRuntimeOverrides(file, {
      models: {
        local: {
          base_url: 'http://127.0.0.1:4321/v1',
          api_key_env: null,
          api_key_secret: 'xyst.model.local',
          cached_input_cost_per_million: 0.25,
          pricing_updated_at: pricingUpdatedAt,
          pricing_source: 'Official pricing page',
        },
      },
    }),
  ]);
  assert.deepEqual(await loadRuntimeOverrides(file), {
    routing: { selection: 'quality' },
    budgets: { max_daily_input_tokens: 5000 },
    tools: { autonomy: 'unrestricted' },
    ui: { sidebar_collapsed: true, theme: 'dark', shortcuts_enabled: false },
    models: {
      local: {
        base_url: 'http://127.0.0.1:4321/v1',
        api_key_env: null,
        api_key_secret: 'xyst.model.local',
        cached_input_cost_per_million: 0.25,
        pricing_updated_at: pricingUpdatedAt,
        pricing_source: 'Official pricing page',
      },
    },
  });
  assert.equal(await fs.stat(`${file}.lock`).catch(() => null), null);
});

test('runtime settings update recovers an interrupted replacement without hiding it as empty defaults', async (t) => {
  const root = await createTempDirectory('xyst-runtime-recovery-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'config.toml.runtime.json');
  await updateRuntimeOverrides(file, { ui: { theme: 'dark' } });
  const backup = `${file}.00000000-0000-4000-8000-000000000001.bak`;
  await fs.rename(file, backup);
  await assert.rejects(loadRuntimeOverrides(file), { code: 'SETTINGS_RECOVERY_REQUIRED' });
  await updateRuntimeOverrides(file, { routing: { selection: 'quality' } });
  assert.deepEqual(await loadRuntimeOverrides(file), { ui: { theme: 'dark' }, routing: { selection: 'quality' } });
  await assert.rejects(fs.stat(backup), { code: 'ENOENT' });
});

test('runtime shortcut updates merge per action and restore defaults on null', async (t) => {
  const root = await createTempDirectory('xyst-runtime-shortcuts-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'config.toml.runtime.json');

  await updateRuntimeOverrides(file, { ui: { shortcuts: { toggle_sidebar: 'Alt+B' } } });
  await updateRuntimeOverrides(file, { ui: { shortcuts: { new_session: 'Alt+N' } } });
  assert.deepEqual((await loadRuntimeOverrides(file)).ui.shortcuts, { toggle_sidebar: 'Alt+B', new_session: 'Alt+N' });
  await updateRuntimeOverrides(file, { ui: { shortcuts: { toggle_sidebar: null } } });
  assert.deepEqual((await loadRuntimeOverrides(file)).ui.shortcuts, { toggle_sidebar: null, new_session: 'Alt+N' });
});
