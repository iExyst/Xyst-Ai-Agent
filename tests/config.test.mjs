import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { parseToml } from '../src/config/toml.mjs';
import { loadConfig, defaultConfigPath, validateConfig } from '../src/config/load.mjs';
import { createTempDirectory } from './helpers.mjs';

test('TOML subset parses nested tables, dotted keys, arrays, comments and strings', () => {
  const config = parseToml(`default_model = "local # 1" # trailing comment
servers.primary.port = 1234
enabled = true
items = ["a,b", 'literal',]
ports = [3, 4,]
hex = [0x0E, 0x0F]
[models.local]
provider = "openai-compatible"
`);
  assert.equal(config.default_model, 'local # 1');
  assert.equal(config.servers.primary.port, 1234);
  assert.deepEqual(config.items, ['a,b', 'literal']);
  assert.deepEqual(config.ports, [3, 4]);
  assert.deepEqual(config.hex, [14, 15]);
  assert.equal(config.models.local.provider, 'openai-compatible');
});

test('copyable configuration example does not configure a credential for the local model', async () => {
  const source = await fs.readFile(new URL('../config.example.toml', import.meta.url), 'utf8');
  const config = parseToml(source);
  assert.equal(config.models['local-default'].api_key_env, undefined);
  assert.equal(config.models['local-default'].api_key_secret, undefined);
  assert.equal(config.models['remote-example'].api_key_env, 'OPENAI_API_KEY');
});

test('model temperature is optional and validated within the OpenAI-compatible range', () => {
  const valid = {
    default_model: 'local',
    models: {
      local: {
        provider: 'openai-compatible',
        base_url: 'http://127.0.0.1:1234/v1',
        model: 'test-model',
        temperature: 0,
      },
    },
  };
  assert.doesNotThrow(() => validateConfig(valid));
  assert.doesNotThrow(() => validateConfig({ ...valid, models: { local: { ...valid.models.local, temperature: 2 } } }));
  for (const temperature of [-0.01, 2.01, Number.NaN, '0']) {
    assert.throws(
      () => validateConfig({ ...valid, models: { local: { ...valid.models.local, temperature } } }),
      /temperature must be a number from 0 to 2/,
    );
  }
});

test('prompt cache request controls require explicit support opt-in and bounded values', () => {
  const model = {
    provider: 'openai-compatible',
    base_url: 'https://api.openai.com/v1',
    model: 'example',
  };
  assert.doesNotThrow(() => validateConfig({ models: { remote: model } }));
  assert.doesNotThrow(() =>
    validateConfig({
      models: {
        remote: {
          ...model,
          prompt_cache_enabled: true,
          prompt_cache_key: 'xyst-main',
          prompt_cache_retention: '24h',
        },
      },
    }),
  );
  assert.doesNotThrow(() => validateConfig({ models: { remote: { ...model, prompt_cache_key: 'xyst-main' } } }));
  assert.throws(
    () => validateConfig({ models: { remote: { ...model, prompt_cache_enabled: 'yes' } } }),
    /prompt_cache_enabled must be boolean/,
  );
  assert.throws(
    () => validateConfig({ models: { remote: { ...model, prompt_cache_enabled: true, prompt_cache_key: 'private user id' } } }),
    /non-sensitive identifier/,
  );
  assert.throws(
    () => validateConfig({ models: { remote: { ...model, prompt_cache_retention: 'forever' } } }),
    /prompt_cache_retention must be '24h'/,
  );
});

test('TOML parser rejects duplicate/conflicting keys with line numbers', () => {
  assert.throws(() => parseToml('a = 1\na = 2'), /Duplicate key 'a' on line 2/);
  assert.throws(() => parseToml('a = 1\n[a.b]'), /conflicts with a value on line 2/);
  assert.equal(parseToml('value = 2026-10-20').value, '2026-10-20');
  assert.throws(() => parseToml('__proto__.polluted = true'), /Unsafe key '__proto__'/);
  assert.throws(() => parseToml('values = [1, true]'), /Mixed value types/);
  assert.throws(() => parseToml('date = 2026-02-30'), /Unsupported value/);
  assert.equal({}.polluted, undefined);
});

test('TOML parser supports inline tables, nested inline keys, and date/time values safely', () => {
  const config = parseToml(`server = { host = "127.0.0.1", tls.enabled = true, label = 'local, safe', ports = [80, 443] }
date = 1979-05-27
instant = 1979-05-27T07:32:00Z
time = 07:32:00
positive_infinity = +inf
nested = [[1, 2], [3, 4]]
`);
  assert.deepEqual(config.server, { host: '127.0.0.1', tls: { enabled: true }, label: 'local, safe', ports: [80, 443] });
  assert.equal(config.date, '1979-05-27');
  assert.equal(config.instant, '1979-05-27T07:32:00Z');
  assert.equal(config.time, '07:32:00');
  assert.equal(config.positive_infinity, Infinity);
  assert.deepEqual(config.nested, [
    [1, 2],
    [3, 4],
  ]);
  assert.throws(() => parseToml('value = { __proto__.polluted = true }'), /Unsafe key/);
  assert.throws(() => parseToml('value = { key = 1, }'), /Trailing comma in inline table/);
  assert.equal({}.polluted, undefined);
});

test('TOML parser rejects extending closed inline tables', () => {
  for (const source of [
    'settings = { enabled = true }\n[settings]',
    'settings = { nested = { enabled = true } }\n[settings.nested]',
    'settings = { enabled = true }\nsettings.extra = false',
    'settings = { nested = { enabled = true } }\nsettings.nested.extra = false',
    'settings = { nested = { enabled = true }, nested.extra = false }',
    'settings = { nested = {}, nested.extra = false }',
  ]) {
    assert.throws(() => parseToml(source), /Inline tables cannot be extended/);
  }
  assert.deepEqual(parseToml('settings = { nested.enabled = true, mode = "local" }'), {
    settings: { nested: { enabled: true }, mode: 'local' },
  });
  assert.deepEqual(parseToml('settings = { nested.enabled = true, nested.mode = "local" }'), {
    settings: { nested: { enabled: true, mode: 'local' } },
  });
});

test('TOML parser supports nested arrays of tables and rejects duplicate table declarations', () => {
  const config = parseToml(`[[products]]
name = "Hammer"
[[products.variants]]
color = "gray"
[[products]]
name = "Nail"
[[products.variants]]
color = "black"
`);
  assert.deepEqual(config.products, [
    { name: 'Hammer', variants: [{ color: 'gray' }] },
    { name: 'Nail', variants: [{ color: 'black' }] },
  ]);
  assert.throws(() => parseToml('[service]\nport = 1\n[service]'), /Duplicate table/);
  assert.throws(() => parseToml('[[products]]\nname = "Hammer"\n[products]'), /Table conflicts/);
  assert.equal(parseToml('"" = 1')[''], 1);
});

test('TOML parser handles basic/literal multiline strings, comments, escapes, and line continuation', () => {
  const config = parseToml(`basic = """
Roses are red
# this hash belongs to the string
""" # actual TOML comment
literal = '''first line
second line'''
continued = """hello \\
  there"""
`);
  assert.equal(config.basic, 'Roses are red\n# this hash belongs to the string\n');
  assert.equal(config.literal, 'first line\nsecond line');
  assert.equal(config.continued, 'hello there');
  assert.throws(() => parseToml('value = """\nunfinished'), /Unclosed multiline string on line 1/);
  assert.throws(() => parseToml('value = """\\q"""'), /Invalid escape in multiline string/);
});

test('TOML parser supports quoted keys and multiline arrays/inline tables', () => {
  const config = parseToml(`"provider.name" = "OpenAI compatible"
'display name'.value = [
  1,
  # comments are allowed between array values
  2,
]
options = {
  "timeout.ms" = 30,
  nested = { 'quoted.key' = true }
}
["table.with.dot"]
enabled = true
`);
  assert.equal(config['provider.name'], 'OpenAI compatible');
  assert.deepEqual(config['display name'], { value: [1, 2] });
  assert.deepEqual(config.options, { 'timeout.ms': 30, nested: { 'quoted.key': true } });
  assert.deepEqual(config['table.with.dot'], { enabled: true });
});

test('config layers merge user, project and environment values with validation', async (t) => {
  const root = await createTempDirectory('xyst-config-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const userConfig = path.join(root, 'user.toml');
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  await fs.writeFile(
    userConfig,
    '[models.local]\nprovider="openai-compatible"\nbase_url="http://localhost:1234/v1"\nmodel="test"\nlocal=true\n[budgets]\nmax_turns=3\n',
  );
  await fs.writeFile(path.join(project, '.xyst.toml'), 'default_model="local"\n[budgets]\nmax_turns=5\n');
  const config = await loadConfig({ configPath: userConfig, projectPath: project, env: { XYST__BUDGETS__MAX_TURNS: '7' } });
  assert.equal(config.default_model, 'local');
  assert.equal(config.budgets.max_turns, 7);
  assert.equal(config.models.local.model, 'test');
  assert.deepEqual(config.tools, {
    autonomy: 'unrestricted',
    filesystem_scope: 'machine',
    shell_enabled: true,
    recursive_listing: true,
  });
  assert.throws(() => validateConfig({ default_model: 'missing', models: {} }), /not defined/);
  assert.doesNotThrow(() =>
    validateConfig({ ui: { shortcuts: { toggle_sidebar: 'Alt+K', new_session: 'Ctrl+Shift+N', focus_search: '/' } } }),
  );
  assert.throws(
    () => validateConfig({ ui: { shortcuts: { toggle_sidebar: 'Alt+K', new_session: 'Alt+K' } } }),
    /conflicts with ui\.shortcuts\.toggle_sidebar/,
  );
  assert.throws(() => validateConfig({ api: { allowed_origins: ['*'] } }), /explicit origins/);
  assert.throws(() => validateConfig({ api: { max_concurrent_runs: 0 } }), /max_concurrent_runs/);
  assert.doesNotThrow(() => validateConfig({ observability: { enabled: true } }));
  assert.doesNotThrow(() => validateConfig({ observability: { enabled: true, console_enabled: true } }));
  assert.throws(() => validateConfig({ observability: { console_enabled: 'true' } }), /observability.console_enabled/);
  assert.doesNotThrow(() => validateConfig({ observability: { enabled: true, max_file_bytes: 1_000 } }));
  assert.throws(() => validateConfig({ observability: { enabled: 'true' } }), /observability.enabled/);
  assert.throws(() => validateConfig({ observability: { max_file_bytes: 999 } }), /observability.max_file_bytes/);
  assert.throws(() => validateConfig({ routing: { selection: 'cheapest-ish' } }), /routing.selection/);
  assert.doesNotThrow(() => validateConfig({ routing: { enabled: false } }));
  assert.throws(() => validateConfig({ routing: { enabled: 'false' } }), /routing.enabled/);
  assert.doesNotThrow(() => validateConfig({ routing: { classifier: { enabled: true } } }));
  assert.throws(() => validateConfig({ routing: { classifier: { enabled: 'yes' } } }), /classifier.enabled/);
  assert.throws(
    () => validateConfig({ routing: { classifier: { enabled: true, mode: 'remote' } } }),
    /classifier may contain only enabled/,
  );
  assert.throws(() => validateConfig({ routing: { health_check_timeout_ms: 99 } }), /health_check_timeout_ms/);
  assert.throws(() => validateConfig({ retrieval: { semantic: { input_cost_per_million: -0.01 } } }), /input_cost_per_million/);
  assert.doesNotThrow(() =>
    validateConfig({
      mcp: {
        enabled: true,
        servers: {
          remote: {
            enabled: true,
            transport: 'streamable_http',
            url: 'https://mcp.example.test/rpc',
            headers: { Authorization: 'secret:service.token' },
          },
        },
      },
    }),
  );
  assert.doesNotThrow(() =>
    validateConfig({ mcp: { servers: { local: { enabled: true, transport: 'streamable_http', url: 'http://localhost:8000/mcp' } } } }),
  );
  assert.doesNotThrow(() =>
    validateConfig({
      mcp: {
        enabled: true,
        servers: {
          legacy: {
            enabled: true,
            transport: 'sse',
            url: 'https://mcp.example.test/events',
            headers: { Authorization: 'secret:service.token' },
          },
        },
      },
    }),
  );
  assert.throws(
    () =>
      validateConfig({
        mcp: { servers: { legacy: { enabled: true, transport: 'sse', url: 'https://mcp.example.test/events', command: 'node' } } },
      }),
    /unsupported sse setting/,
  );
  assert.throws(
    () =>
      validateConfig({ mcp: { servers: { remote: { enabled: true, transport: 'streamable_http', url: 'http://mcp.example.test/rpc' } } } }),
    /HTTPS or a loopback/,
  );
  assert.throws(
    () =>
      validateConfig({
        mcp: {
          servers: {
            remote: {
              enabled: true,
              transport: 'streamable_http',
              url: 'https://mcp.example.test/rpc',
              headers: { 'MCP-Protocol-Version': 'env:MCP_VERSION' },
            },
          },
        },
      }),
    /safe header names/,
  );
  assert.doesNotThrow(() =>
    validateConfig({
      default_model: 'local',
      models: {
        local: { provider: 'openai-compatible', base_url: 'http://127.0.0.1/v1', model: 'x' },
        remote: { provider: 'openai-compatible', base_url: 'https://example.test/v1', model: 'x' },
      },
      routing: { fallback_chain: ['remote'] },
    }),
  );
  assert.throws(
    () =>
      validateConfig({
        models: { local: { provider: 'openai-compatible', base_url: 'http://127.0.0.1/v1', model: 'x' } },
        routing: { fallback_chain: ['missing'] },
      }),
    /fallback_chain model 'missing' is not defined/,
  );
  assert.throws(
    () =>
      validateConfig({
        models: { local: { provider: 'openai-compatible', base_url: 'http://127.0.0.1/v1', model: 'x' } },
        routing: { fallback_chain: ['local', 'local'] },
      }),
    /cannot contain duplicate/,
  );
  assert.throws(
    () =>
      validateConfig({
        models: { local: { provider: 'openai-compatible', base_url: 'http://127.0.0.1/v1', model: 'x', coding_strength: 11 } },
      }),
    /coding_strength/,
  );
  assert.throws(
    () =>
      validateConfig({
        models: { local: { provider: 'openai-compatible', base_url: 'http://127.0.0.1/v1', model: 'x', max_output_tokens: 0 } },
      }),
    /max_output_tokens/,
  );
  assert.doesNotThrow(() => validateConfig({ tools: { autonomy: 'unrestricted' } }));
  assert.throws(() => validateConfig({ tools: { autonomy: 'unrestricted' }, sandbox: { mode: 'required' } }), /Machine-wide file access/);
  assert.doesNotThrow(() => validateConfig({ tools: { filesystem_scope: 'machine', shell_enabled: true }, sandbox: { mode: 'disabled' } }));
  assert.throws(() => validateConfig({ tools: { filesystem_scope: 'unrestricted' } }), /filesystem_scope/);
  assert.throws(() => validateConfig({ tools: { filesystem_scope: 'machine' }, sandbox: { mode: 'required' } }), /cannot be combined/);
  assert.throws(
    () =>
      validateConfig({ models: { local: { provider: 'openai-compatible', base_url: 'http://127.0.0.1/v1', model: 'x', speed_score: 0 } } }),
    /speed_score/,
  );
  assert.throws(
    () =>
      validateConfig({
        models: { local: { provider: 'openai-compatible', base_url: 'http://127.0.0.1/v1', model: 'x', retry_attempts: 3 } },
      }),
    /retry_attempts/,
  );
  assert.throws(
    () =>
      validateConfig({
        models: { local: { provider: 'openai-compatible', base_url: 'http://127.0.0.1/v1', model: 'x', reasoning_effort: 'extreme' } },
      }),
    /reasoning_effort/,
  );
  assert.throws(
    () =>
      validateConfig({
        models: { local: { provider: 'openai-compatible', base_url: 'http://127.0.0.1/v1', model: 'x', supports_vision: 'true' } },
      }),
    /supports_vision/,
  );
  assert.throws(
    () =>
      validateConfig({
        models: {
          local: { provider: 'openai-compatible', base_url: 'http://127.0.0.1/v1', model: 'x', cached_input_cost_per_million: -1 },
        },
      }),
    /cached_input_cost_per_million/,
  );
  const today = new Date().toISOString().slice(0, 10);
  assert.doesNotThrow(() =>
    validateConfig({
      models: {
        local: {
          provider: 'openai-compatible',
          base_url: 'http://127.0.0.1/v1',
          model: 'x',
          pricing_updated_at: today,
          pricing_source: 'Official pricing page, checked manually',
          capabilities_updated_at: today,
          capabilities_source: 'Provider model documentation',
        },
      },
    }),
  );
  assert.throws(
    () =>
      validateConfig({
        models: { local: { provider: 'openai-compatible', base_url: 'http://127.0.0.1/v1', model: 'x', pricing_updated_at: '2026-02-30' } },
      }),
    /pricing_updated_at/,
  );
  assert.throws(
    () =>
      validateConfig({
        models: { local: { provider: 'openai-compatible', base_url: 'http://127.0.0.1/v1', model: 'x', pricing_source: 'bad\nsource' } },
      }),
    /pricing_source/,
  );
  assert.throws(
    () =>
      validateConfig({
        models: {
          local: { provider: 'openai-compatible', base_url: 'http://127.0.0.1/v1', model: 'x', capabilities_updated_at: '2026-02-30' },
        },
      }),
    /capabilities_updated_at/,
  );
  assert.throws(
    () =>
      validateConfig({
        models: {
          local: { provider: 'openai-compatible', base_url: 'http://127.0.0.1/v1', model: 'x', capabilities_source: 'bad\nsource' },
        },
      }),
    /capabilities_source/,
  );
  assert.doesNotThrow(() =>
    validateConfig({
      approvals: {
        auto_approve_write_paths: ['generated/**'],
        deny_process_commands: ['npm test *'],
        deny_tools: [
          'run_process',
          'run_shell_script',
          'computer_control',
          'start_background_process',
          'send_background_input',
          'stop_background_process',
        ],
      },
    }),
  );
  assert.throws(() => validateConfig({ approvals: { auto_approve_write_paths: ['../**'] } }), /relative workspace glob patterns/);
  assert.throws(() => validateConfig({ approvals: { auto_approve_tools: ['unknown_tool'] } }), /known tool names/);
  assert.doesNotThrow(() =>
    validateConfig({
      web_search: { enabled: true, provider: 'brave', api_key_secret: 'brave.search', max_results: 5, timeout_ms: 10000 },
      approvals: { deny_tools: ['web_search'] },
    }),
  );
  assert.throws(() => validateConfig({ web_search: { enabled: true, provider: 'other', api_key_env: 'KEY' } }), /provider/);
  assert.doesNotThrow(() => validateConfig({ web_search: { enabled: true, provider: 'brave' } }));
  assert.doesNotThrow(() => validateConfig({ web_search: { enabled: true, provider: 'automatic' } }));
  assert.doesNotThrow(() => validateConfig({ web_search: { enabled: true, provider: 'wikipedia' } }));
  assert.throws(() => validateConfig({ web_search: { enabled: false, max_results: 11 } }), /max_results/);
  assert.doesNotThrow(() =>
    validateConfig({
      subagents: { enabled: true, max_concurrent: 2, max_turns: 4, timeout_ms: 300000 },
      approvals: { deny_tools: ['delegate_task'] },
    }),
  );
  assert.throws(() => validateConfig({ subagents: { enabled: true, max_concurrent: 0 } }), /max_concurrent/);
  assert.doesNotThrow(() =>
    validateConfig({
      mcp: {
        enabled: true,
        timeout_ms: 15000,
        servers: { local_docs: { enabled: true, command: 'node', args: ['server.mjs'], env: { DOCS_TOKEN: 'secret:docs.token' } } },
      },
      tools: { shell_enabled: true },
    }),
  );
  assert.throws(
    () =>
      validateConfig({
        mcp: { enabled: true, servers: { local_docs: { enabled: true, command: 'node', env: { TOKEN: 'plaintext-secret' } } } },
      }),
    /env:VARIABLE or secret:vault.key/,
  );
  assert.throws(
    () => validateConfig({ mcp: { enabled: true, servers: { 'Bad Name': { enabled: true, command: 'node' } } } }),
    /lowercase name/,
  );
  assert.doesNotThrow(() =>
    validateConfig({ retrieval: { semantic: { enabled: true, base_url: 'http://127.0.0.1:1234/v1', model: 'embed' } } }),
  );
  assert.doesNotThrow(() =>
    validateConfig({
      retrieval: {
        auto_context: true,
        auto_context_max_results: 4,
        auto_context_max_chars: 8000,
        semantic: { enabled: true, base_url: 'http://127.0.0.1:1234/v1', model: 'embed' },
      },
    }),
  );
  assert.throws(() => validateConfig({ retrieval: { auto_context: true } }), /requires retrieval.semantic.enabled/);
  assert.throws(() => validateConfig({ retrieval: { max_files: 10_001 } }), /retrieval.max_files/);
  assert.throws(() => validateConfig({ retrieval: { max_file_bytes: 1_000_001 } }), /retrieval.max_file_bytes/);
  assert.throws(() => validateConfig({ retrieval: { max_results: 101 } }), /retrieval.max_results/);
  assert.throws(() => validateConfig({ retrieval: { auto_context_max_results: 11 } }), /from 1 to 10/);
  assert.throws(() => validateConfig({ retrieval: { auto_context_max_chars: 100 } }), /512 to 20000/);
  assert.doesNotThrow(() =>
    validateConfig({ budgets: { max_session_input_tokens: 100_000, max_session_output_tokens: 20_000, max_session_cost: 2.5 } }),
  );
  assert.doesNotThrow(() => validateConfig({ budgets: { max_output_tokens: 1000, final_response_reserve_tokens: 512 } }));
  assert.doesNotThrow(() => validateConfig({ budgets: { recovery_summary_input_tokens: 0 } }));
  assert.throws(() => validateConfig({ budgets: { recovery_summary_input_tokens: -1 } }), /non-negative integer/);
  assert.throws(
    () => validateConfig({ budgets: { max_output_tokens: 1000, final_response_reserve_tokens: 1000 } }),
    /smaller than max_output_tokens/,
  );
  assert.doesNotThrow(() =>
    validateConfig({ compaction: { enabled: true, trigger_ratio: 0.75, budget_trigger_ratio: 0.8, keep_recent_turns: 3 } }),
  );
  assert.throws(() => validateConfig({ compaction: { enabled: 'true' } }), /compaction.enabled/);
  assert.throws(() => validateConfig({ compaction: { trigger_ratio: 0.2 } }), /trigger_ratio/);
  assert.throws(() => validateConfig({ compaction: { budget_trigger_ratio: 0.99 } }), /budget_trigger_ratio/);
  assert.throws(() => validateConfig({ budgets: { max_session_input_tokens: 0 } }), /positive integer/);
  assert.throws(() => validateConfig({ budgets: { max_session_cost: -0.01 } }), /non-negative USD/);
  assert.throws(
    () => validateConfig({ retrieval: { semantic: { enabled: true, base_url: 'https://embed.example/v1', model: 'embed' } } }),
    /allow_remote = true/,
  );
  assert.throws(
    () =>
      validateConfig({
        retrieval: { semantic: { enabled: true, allow_remote: true, base_url: 'http://embed.example/v1', model: 'embed' } },
      }),
    /must use HTTPS/,
  );
  assert.throws(
    () => validateConfig({ retrieval: { semantic: { enabled: true, base_url: 'http://user:pass@127.0.0.1/v1', model: 'embed' } } }),
    /embedded credentials/,
  );
  assert.throws(
    () => validateConfig({ models: { bad: { provider: 'openai-compatible', base_url: 'https://user:pass@example.com/v1', model: 'x' } } }),
    /embedded credentials/,
  );
  await assert.rejects(loadConfig({ configPath: userConfig, env: { XYST__CONSTRUCTOR__X: '1' } }), /Unsafe configuration override/);
});

test('configuration precedence is defaults, user, project, runtime sidecar, then environment', async (t) => {
  const root = await createTempDirectory('xyst-config-precedence-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const userConfig = path.join(root, 'user.toml');
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  await fs.writeFile(
    userConfig,
    'default_model="user"\n[models.user]\nprovider="openai-compatible"\nbase_url="http://127.0.0.1:1234/v1"\nmodel="user-model"\n[models.project]\nprovider="openai-compatible"\nbase_url="http://127.0.0.1:1234/v1"\nmodel="project-model"\n[models.runtime]\nprovider="openai-compatible"\nbase_url="http://127.0.0.1:1234/v1"\nmodel="runtime-model"\n[models.environment]\nprovider="openai-compatible"\nbase_url="http://127.0.0.1:1234/v1"\nmodel="environment-model"\n[routing]\nselection="balanced"\nprefer_local=true\n[budgets]\nmax_input_tokens=3000\n',
  );
  await fs.writeFile(
    path.join(project, '.xyst.toml'),
    'default_model="project"\n[models.user]\nmodel="project-model"\n[routing]\nselection="quality"\nprefer_local=false\n[budgets]\nmax_input_tokens=5000\n',
  );
  await fs.writeFile(
    `${userConfig}.runtime.json`,
    JSON.stringify({
      default_model: 'runtime',
      models: { user: { model: 'runtime-model' } },
      routing: { selection: 'cost', prefer_local: true },
      budgets: { max_input_tokens: 7000 },
    }),
  );

  const config = await loadConfig({
    configPath: userConfig,
    projectPath: project,
    env: {
      XYST__DEFAULT_MODEL: 'environment',
      XYST__MODELS__USER__MODEL: 'environment-model',
      XYST__ROUTING__SELECTION: 'speed',
      XYST__ROUTING__PREFER_LOCAL: 'false',
      XYST__BUDGETS__MAX_INPUT_TOKENS: '9000',
    },
  });

  assert.equal(config.default_model, 'environment');
  assert.equal(config.models.user.model, 'environment-model');
  assert.equal(config.routing.selection, 'speed');
  assert.equal(config.routing.prefer_local, false);
  assert.equal(config.budgets.max_input_tokens, 9000);
  assert.equal(config.tools.autonomy, 'unrestricted');
  assert.deepEqual(config._source, {
    userPath: userConfig,
    projectPath: project,
    runtimeOverridePath: `${userConfig}.runtime.json`,
  });
});

test('user runtime profile overrides can replace env credentials with an OS-vault reference', async (t) => {
  const root = await createTempDirectory('xyst-model-profile-config-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const userConfig = path.join(root, 'user.toml');
  await fs.writeFile(
    userConfig,
    '[models.local]\nprovider="openai-compatible"\nbase_url="http://127.0.0.1:1234/v1"\nmodel="test"\napi_key_env="LOCAL_MODEL_KEY"\n',
  );
  await fs.writeFile(
    `${userConfig}.runtime.json`,
    JSON.stringify({ models: { local: { api_key_env: null, api_key_secret: 'xyst.model.local', model: 'updated-model' } } }),
  );
  const loaded = await loadConfig({ configPath: userConfig, env: {} });
  assert.equal(loaded.models.local.api_key_env, undefined);
  assert.equal(loaded.models.local.api_key_secret, 'xyst.model.local');
  assert.equal(loaded.models.local.model, 'updated-model');
});

test('user runtime profile tombstones remove inherited model profiles', async (t) => {
  const root = await createTempDirectory('xyst-model-profile-delete-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const userConfig = path.join(root, 'user.toml');
  await fs.writeFile(
    userConfig,
    'default_model="local"\n[models.local]\nprovider="openai-compatible"\nbase_url="http://127.0.0.1:1234/v1"\nmodel="test"\n[models.unused]\nprovider="openai-compatible"\nbase_url="https://provider.example/v1"\nmodel="unused"\n',
  );
  await fs.writeFile(`${userConfig}.runtime.json`, JSON.stringify({ models: { unused: null } }));
  const loaded = await loadConfig({ configPath: userConfig, env: {} });
  assert.equal(loaded.models.local.model, 'test');
  assert.equal(loaded.models.unused, undefined);
});

test('runtime sandbox preference cannot be weakened by project configuration', async (t) => {
  const root = await createTempDirectory('xyst-runtime-sandbox-project-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const userConfig = path.join(root, 'user.toml');
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  await fs.writeFile(
    userConfig,
    '[models.local]\nprovider="openai-compatible"\nbase_url="http://127.0.0.1:1234/v1"\nmodel="test"\n[sandbox]\nmode="disabled"\n',
  );
  await fs.writeFile(path.join(project, '.xyst.toml'), '[sandbox]\nmode="disabled"\n');
  await fs.writeFile(`${userConfig}.runtime.json`, JSON.stringify({ sandbox: { mode: 'required' } }));
  await assert.rejects(
    loadConfig({ configPath: userConfig, projectPath: project, env: {} }),
    /Project config may not enable Architect.*weaken the user-configured sandbox/,
  );
});

test('project sandbox overrides cannot weaken a process-specific user sandbox', async (t) => {
  const root = await createTempDirectory('xyst-process-sandbox-project-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const userConfig = path.join(root, 'user.toml');
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  await fs.writeFile(
    userConfig,
    '[models.local]\nprovider="openai-compatible"\nbase_url="http://127.0.0.1:1234/v1"\nmodel="test"\n[tools]\nautonomy="assisted"\nfilesystem_scope="workspace"\n',
  );
  await fs.writeFile(`${userConfig}.runtime.json`, JSON.stringify({ sandbox: { tools: { run_process: 'workspace-read' } } }));
  await fs.writeFile(path.join(project, '.xyst.toml'), '[sandbox.tools]\nrun_process="workspace-write"\n');
  await assert.rejects(loadConfig({ configPath: userConfig, projectPath: project, env: {} }), /weaken the user-configured sandbox/);
  await fs.writeFile(path.join(project, '.xyst.toml'), '[sandbox.tools]\nrun_process="read-only"\n');
  assert.equal((await loadConfig({ configPath: userConfig, projectPath: project, env: {} })).sandbox.tools.run_process, 'workspace-read');
});

test('project config cannot silently elevate user tool permissions', async (t) => {
  const root = await createTempDirectory('xyst-config-project-elevation-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const userConfig = path.join(root, 'user.toml');
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  await fs.writeFile(userConfig, '[tools]\nautonomy="assisted"\n');
  await fs.writeFile(path.join(project, '.xyst.toml'), '[tools]\nautonomy="unrestricted"\n');
  await assert.rejects(loadConfig({ configPath: userConfig, projectPath: project, env: {} }), /Project config may not enable Architect/);
  await fs.writeFile(userConfig, '[tools]\nautonomy="unrestricted"\n');
  assert.equal((await loadConfig({ configPath: userConfig, projectPath: project, env: {} })).tools.autonomy, 'unrestricted');
  await fs.writeFile(userConfig, '');
  await fs.writeFile(`${userConfig}.runtime.json`, JSON.stringify({ tools: { autonomy: 'unrestricted' } }));
  assert.equal((await loadConfig({ configPath: userConfig, projectPath: project, env: {} })).tools.autonomy, 'unrestricted');
  await fs.rm(`${userConfig}.runtime.json`);
  await fs.writeFile(userConfig, '');
  await fs.writeFile(path.join(project, '.xyst.toml'), '[mcp]\nenabled=true\n[mcp.servers.external]\nenabled=true\ncommand="node"\n');
  await assert.rejects(
    loadConfig({ configPath: userConfig, projectPath: project, env: {} }),
    /Project config may not enable Architect, elevate tool access, define MCP servers/,
  );
  await fs.writeFile(path.join(project, '.xyst.toml'), '[skills]\nenabled=true\n');
  await assert.rejects(
    loadConfig({ configPath: userConfig, projectPath: project, env: {} }),
    /Project config may not enable Architect, elevate tool access, define MCP servers, skills, or application update trust roots/,
  );
  await fs.writeFile(path.join(project, '.xyst.toml'), '[hooks.pre_tool]\ncommand="node"\n');
  await assert.rejects(loadConfig({ configPath: userConfig, projectPath: project, env: {} }), /Project config may not enable Architect/);
  await fs.writeFile(path.join(project, '.xyst.toml'), '[extensions.trusted_keys]\npublisher="untrusted"\n');
  await assert.rejects(loadConfig({ configPath: userConfig, projectPath: project, env: {} }), /Project config may not enable Architect/);
  await fs.writeFile(path.join(project, '.xyst.toml'), '[app_updates]\nmode="disabled"\n');
  await assert.rejects(loadConfig({ configPath: userConfig, projectPath: project, env: {} }), /application update trust roots/);
});

test('project config cannot remove user-configured tool, path, or command denials', async (t) => {
  const root = await createTempDirectory('xyst-config-project-deny-rules-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const userConfig = path.join(root, 'user.toml');
  const project = path.join(root, 'project');
  const projectConfig = path.join(project, '.xyst.toml');
  await fs.mkdir(project);
  await fs.writeFile(
    userConfig,
    '[tools]\nautonomy="assisted"\n[approvals]\ndeny_tools=["run_shell_script"]\ndeny_write_paths=["secrets/**"]\ndeny_process_commands=["rm *"]\n',
  );

  for (const [key, empty] of [
    ['deny_tools', 'deny_tools=[]'],
    ['deny_write_paths', 'deny_write_paths=[]'],
    ['deny_process_commands', 'deny_process_commands=[]'],
  ]) {
    await fs.writeFile(projectConfig, `[approvals]\n${empty}\n`);
    await assert.rejects(
      loadConfig({ configPath: userConfig, projectPath: project, env: {} }),
      /Project config may not enable Architect, elevate tool access/,
      `project config must not clear ${key}`,
    );
  }

  await fs.writeFile(
    projectConfig,
    '[approvals]\ndeny_tools=["run_shell_script", "write_file"]\ndeny_write_paths=["secrets/**", "private/**"]\ndeny_process_commands=["rm *", "format-disk *"]\n',
  );
  const config = await loadConfig({ configPath: userConfig, projectPath: project, env: {} });
  assert.deepEqual(config.approvals.deny_tools, ['run_shell_script', 'write_file']);
  assert.deepEqual(config.approvals.deny_write_paths, ['secrets/**', 'private/**']);
  assert.deepEqual(config.approvals.deny_process_commands, ['rm *', 'format-disk *']);
});

test('global memory is disabled by default and cannot be enabled by project configuration', async (t) => {
  const root = await createTempDirectory('xyst-global-memory-config-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const userConfig = path.join(root, 'user.toml');
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  await fs.writeFile(userConfig, '');
  assert.equal((await loadConfig({ configPath: userConfig, projectPath: project, env: {} })).memory.global_enabled, false);
  await fs.writeFile(path.join(project, '.xyst.toml'), '[memory]\nglobal_enabled=true\n');
  await assert.rejects(loadConfig({ configPath: userConfig, projectPath: project, env: {} }), /Project config may not enable Architect/);
  await fs.writeFile(path.join(project, '.xyst.toml'), '');
  await fs.writeFile(userConfig, '[memory]\nglobal_enabled=true\n');
  assert.equal((await loadConfig({ configPath: userConfig, projectPath: project, env: {} })).memory.global_enabled, true);
});

test('OTLP trace export requires an explicit secure endpoint and reference-only headers', () => {
  assert.doesNotThrow(() =>
    validateConfig({
      observability: {
        enabled: true,
        otlp: {
          enabled: true,
          traces_endpoint: 'https://collector.example.test/v1/traces',
          headers: { Authorization: 'secret:telemetry.collector' },
          timeout_ms: 5_000,
          max_batch_spans: 64,
        },
      },
    }),
  );
  assert.doesNotThrow(() =>
    validateConfig({ observability: { enabled: true, otlp: { enabled: true, traces_endpoint: 'http://127.0.0.1:4318/v1/traces' } } }),
  );
  assert.throws(
    () => validateConfig({ observability: { otlp: { enabled: true, traces_endpoint: 'https://collector.example.test/v1/traces' } } }),
    /requires observability.enabled = true/,
  );
  assert.throws(
    () =>
      validateConfig({
        observability: { enabled: true, otlp: { enabled: true, traces_endpoint: 'http://collector.example.test/v1/traces' } },
      }),
    /must use HTTPS or loopback HTTP/,
  );
  assert.throws(
    () =>
      validateConfig({
        observability: {
          enabled: true,
          otlp: { enabled: true, traces_endpoint: 'https://user:pass@collector.example.test/v1/traces' },
        },
      }),
    /must use HTTPS or loopback HTTP/,
  );
  assert.throws(
    () =>
      validateConfig({
        observability: {
          enabled: true,
          otlp: { enabled: true, traces_endpoint: 'https://collector.example.test/v1/traces', headers: { Authorization: 'token-value' } },
        },
      }),
    /env:VARIABLE or secret:vault.key/,
  );
  assert.throws(
    () =>
      validateConfig({
        observability: {
          enabled: true,
          otlp: {
            enabled: true,
            traces_endpoint: 'https://collector.example.test/v1/traces',
            headers: { 'Content-Type': 'env:OTEL_TYPE' },
          },
        },
      }),
    /safe header names/,
  );
  assert.throws(
    () =>
      validateConfig({
        observability: {
          enabled: true,
          otlp: { enabled: true, traces_endpoint: 'https://collector.example.test/v1/traces', max_batch_spans: 257 },
        },
      }),
    /max_batch_spans/,
  );
});

test('workspace configuration cannot enable observability exporters', async (t) => {
  const root = await createTempDirectory('xyst-project-observability-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const userConfig = path.join(root, 'user.toml');
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  await fs.writeFile(userConfig, '');
  await fs.writeFile(
    path.join(project, '.xyst.toml'),
    '[observability]\nenabled=true\n[observability.otlp]\nenabled=true\ntraces_endpoint="https://collector.example.test/v1/traces"\n',
  );
  await assert.rejects(loadConfig({ configPath: userConfig, projectPath: project, env: {} }), /configure observability exporters/);
});

test('default user config path follows platform conventions', () => {
  assert.equal(
    defaultConfigPath({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32'),
    'C:\\Users\\me\\AppData\\Roaming\\Xyst AI Assistant\\config.toml',
  );
  assert.equal(defaultConfigPath({ XDG_CONFIG_HOME: '/home/me/.config' }, 'linux'), '/home/me/.config/xyst-ai-assistant/config.toml');
});

test('default config loads Xyst settings and applies current environment and project layers', async (t) => {
  const root = await createTempDirectory('xyst-config-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const newPath = defaultConfigPath({ APPDATA: root, XDG_CONFIG_HOME: root });
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  await fs.mkdir(path.dirname(newPath), { recursive: true });
  await fs.writeFile(newPath, 'default_model = "configured-profile"\n');
  await fs.writeFile(`${newPath}.runtime.json`, JSON.stringify({ ui: { theme: 'dark' } }));
  await fs.writeFile(path.join(project, '.xyst.toml'), '[budgets]\nmax_turns = 7\n');

  const config = await loadConfig({
    configPath: newPath,
    projectPath: project,
    env: {
      APPDATA: root,
      XDG_CONFIG_HOME: root,
      XYST__DEFAULT_MODEL: 'current-environment',
    },
  });

  assert.equal(config.default_model, 'current-environment');
  assert.equal(config.budgets.max_turns, 7);
  assert.equal(config.ui.theme, 'dark');
  assert.deepEqual(config.web_search, { enabled: true, provider: 'automatic', max_results: 5 });
  assert.equal(config._source.userPath, newPath);
  assert.equal(await fs.readFile(newPath, 'utf8'), 'default_model = "configured-profile"\n');
  assert.equal(await fs.readFile(`${newPath}.runtime.json`, 'utf8'), JSON.stringify({ ui: { theme: 'dark' } }));

  await fs.writeFile(path.join(project, '.xyst.toml'), '[budgets]\nmax_turns = 9\n');
  const currentProjectConfig = await loadConfig({ configPath: newPath, projectPath: project, env: {} });
  assert.equal(currentProjectConfig.budgets.max_turns, 9);
});

test('application update configuration requires user-trusted signed HTTPS metadata', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const trusted = publicKey.export({ type: 'spki', format: 'pem' });
  assert.doesNotThrow(() =>
    validateConfig({
      app_updates: {
        mode: 'manual',
        channel: 'stable',
        feed_url: 'https://updates.example.test/releases.json',
        key_id: 'release-key',
        public_key: trusted,
      },
    }),
  );
  assert.throws(() => validateConfig({ app_updates: { mode: 'notify' } }), /requires a feed URL, signing key ID, and trusted public key/);
  assert.throws(() => validateConfig({ app_updates: { mode: 'manual', feed_url: 'http://updates.example.test/feed' } }), /must be HTTPS/);
  assert.throws(
    () => validateConfig({ app_updates: { mode: 'disabled', public_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) } }),
    /valid Ed25519 PEM key/,
  );
  assert.throws(() => validateConfig({ app_updates: { mode: 'disabled', feed_url: 'https://[::1]/feed' } }), /must be HTTPS/);
  assert.throws(() => validateConfig({ app_updates: { unexpected: true } }), /unsupported setting/);
});

test('skills configuration requires absolute user-selected roots and a root when enabled', () => {
  assert.throws(() => validateConfig({ skills: { enabled: true } }), /requires at least one user-configured directory/);
  assert.throws(() => validateConfig({ skills: { directories: ['relative/skills'] } }), /absolute paths configured by the user/);
  assert.throws(
    () => validateConfig({ skills: { directories: Array.from({ length: 17 }, (_, index) => path.resolve(`skills-${index}`)) } }),
    /at most 16 paths/,
  );
  assert.doesNotThrow(() => validateConfig({ skills: { enabled: false, directories: [] } }));
});

test('extension trust configuration accepts only named Ed25519 roots and bounded revocations', () => {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
  assert.doesNotThrow(() =>
    validateConfig({
      extensions: {
        trusted_keys: { publisher: publicKey },
        revoked_key_ids: ['old-key'],
        revoked_packages: ['skill:release-check@1.0.0'],
        install_directory: path.resolve('packages'),
        revocation_url: 'https://updates.example.com/revocations.json',
        revocation_key_id: 'publisher',
        revocation_max_age_hours: 72,
        update_feed_url: 'https://updates.example.com/xyst/packages.json',
        update_key_id: 'publisher',
        update_max_age_hours: 96,
      },
    }),
  );
  assert.throws(() => validateConfig({ extensions: { trusted_keys: { publisher: 'not a public key' } } }), /PEM public key/);
  assert.throws(
    () => validateConfig({ extensions: { trusted_keys: { publisher: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) } } }),
    /PEM public key/,
  );
  assert.throws(() => validateConfig({ extensions: { install_directory: 'relative' } }), /absolute user-selected path/);
  assert.throws(() => validateConfig({ extensions: { revoked_packages: ['release-check@1.0.0'] } }), /type:package-id@version/);
  assert.throws(
    () =>
      validateConfig({
        extensions: {
          trusted_keys: { publisher: publicKey },
          revocation_url: 'http://updates.example.com/feed',
          revocation_key_id: 'publisher',
        },
      }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      validateConfig({
        extensions: {
          trusted_keys: { publisher: publicKey },
          revocation_url: 'https://updates.example.com/feed',
          revocation_key_id: 'missing',
        },
      }),
    /configured trusted key/,
  );
  assert.throws(
    () =>
      validateConfig({
        extensions: {
          trusted_keys: { publisher: publicKey },
          update_feed_url: 'http://updates.example.com/feed',
          update_key_id: 'publisher',
        },
      }),
    /HTTPS/,
  );
  assert.throws(() => validateConfig({ extensions: { update_max_age_hours: 0 } }), /between 1 and 720/);
});

test('MCP package server config can reference an activated signed package without overriding its entry point', () => {
  assert.doesNotThrow(() =>
    validateConfig({
      mcp: { enabled: true, servers: { release_server: { enabled: true, package_id: 'release-server', args: ['--stdio'] } } },
    }),
  );
  assert.throws(
    () => validateConfig({ mcp: { enabled: true, servers: { release_server: { enabled: true, package_id: '../escape' } } } }),
    /lowercase signed MCP package ID/,
  );
  assert.throws(
    () =>
      validateConfig({
        mcp: { enabled: true, servers: { release_server: { enabled: true, package_id: 'release-server', command: 'node' } } },
      }),
    /must not override command or cwd/,
  );
});
