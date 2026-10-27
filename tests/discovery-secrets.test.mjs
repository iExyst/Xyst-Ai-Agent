import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { discoverLocalServers, getLoadedLmStudioModelIds } from '../src/providers/discovery.mjs';
import {
  EnvironmentSecretStore,
  InMemorySecretStore,
  LinuxSecretServiceStore,
  WindowsCredentialStore,
  createPlatformSecretStore,
} from '../src/platform/secrets.mjs';
import { resolveModelApiKey, validateConfig } from '../src/config/load.mjs';

const requireSecretServiceIntegration = process.env.XYST_REQUIRE_SECRET_SERVICE_TEST === 'true';
const secretServiceIntegrationSkip =
  process.platform !== 'linux'
    ? 'Linux Secret Service integration is Linux-only'
    : requireSecretServiceIntegration
      ? false
      : 'Set XYST_REQUIRE_SECRET_SERVICE_TEST=true inside an unlocked Secret Service session';

test('local discovery checks configured endpoints first and de-duplicates default probes', async () => {
  const calls = [];
  const result = await discoverLocalServers({
    config: { local_servers: { studio: { base_url: 'http://127.0.0.1:1234/v1' } } },
    timeoutMs: 100,
    fetchImpl: async (url) => {
      calls.push(url);
      return url.includes(':1234/') ? Response.json({ data: [{ id: 'local-model' }] }) : new Response('', { status: 503 });
    },
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'studio');
  assert.equal(result[0].configured, true);
  assert.deepEqual(result[0].models, ['local-model']);
  assert.equal(calls.filter((url) => url === 'http://127.0.0.1:1234/v1/models').length, 1);
});

test('LM Studio discovery reports conservative context for loaded models only', async () => {
  const calls = [];
  const [server] = await discoverLocalServers({
    config: {
      discovery: { enabled: false },
      local_servers: { studio: { base_url: 'http://127.0.0.1:1234/v1' } },
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === 'http://127.0.0.1:1234/v1/models')
        return Response.json({ data: [{ id: 'loaded-model' }, { id: 'unloaded-model' }, { id: 'unsupported-type' }] });
      return Response.json({
        models: [
          {
            key: 'loaded-model',
            max_context_length: 131_072,
            capabilities: { trained_for_tool_use: true, vision: false },
            loaded_instances: [],
          },
          {
            key: 'loaded-model',
            max_context_length: 131_072,
            capabilities: { trained_for_tool_use: true, vision: false },
            loaded_instances: [
              { config: { context_length: 16_384 } },
              { config: { context_length: 8_192 } },
              { config: { context_length: 0 } },
              { config: { context_length: 10_000_001 } },
            ],
          },
          {
            key: 'loaded-model',
            max_context_length: 131_072,
            capabilities: { trained_for_tool_use: true, vision: false },
            loaded_instances: [],
          },
          {
            key: 'unloaded-model',
            max_context_length: 32_768,
            capabilities: { trained_for_tool_use: false, vision: true },
            loaded_instances: [],
          },
          { key: 'unsupported-type', loaded_instances: [{ config: { context_length: '8192' } }] },
          { key: 'unlisted-model', loaded_instances: [{ config: { context_length: 4096 } }] },
        ],
      });
    },
  });

  assert.deepEqual(server.models, ['loaded-model', 'unloaded-model', 'unsupported-type']);
  assert.deepEqual(server.model_context_lengths, { 'loaded-model': 8_192 });
  assert.deepEqual(server.model_capabilities, {
    'loaded-model': { supports_tools: true, supports_vision: false },
    'unloaded-model': { supports_tools: false, supports_vision: true },
  });
  assert.deepEqual(
    calls.map((call) => call.url),
    ['http://127.0.0.1:1234/v1/models', 'http://127.0.0.1:1234/api/v1/models'],
  );
  assert.equal(calls[1].options.redirect, 'error');
});

test('LM Studio management metadata is not probed on remote or nonstandard endpoints', async () => {
  const calls = [];
  const servers = await discoverLocalServers({
    config: {
      discovery: { enabled: false },
      local_servers: {
        remote: { base_url: 'https://127.0.0.1:1234/v1' },
        other: { base_url: 'http://127.0.0.1:1235/v1' },
      },
    },
    fetchImpl: async (url) => {
      calls.push(url);
      return Response.json({ data: [{ id: 'model' }] });
    },
  });

  assert.equal(servers.length, 2);
  assert.deepEqual(calls, ['https://127.0.0.1:1234/v1/models', 'http://127.0.0.1:1235/v1/models']);
  assert.ok(servers.every((server) => server.model_context_lengths === undefined));
});

test('LM Studio loaded-model status is bounded to its local management endpoint', async () => {
  const calls = [];
  const loaded = await getLoadedLmStudioModelIds('http://127.0.0.1:1234/v1/', {
    timeoutMs: 100,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json({
        models: [
          { key: 'loaded-model', type: 'llm', loaded_instances: [{ config: {} }] },
          { key: 'unloaded-model', type: 'llm', loaded_instances: [] },
          { key: 'loaded-model', type: 'llm', loaded_instances: [] },
          { key: 'unrelated', type: 'embedding', loaded_instances: [{ config: {} }] },
        ],
      });
    },
  });
  assert.deepEqual([...loaded], ['loaded-model']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:1234/api/v1/models');
  assert.deepEqual(calls[0].options.headers, { accept: 'application/json' });
  assert.equal(calls[0].options.redirect, 'error');
});

test('LM Studio loaded-model status returns unavailable for other endpoints without probing them', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return Response.json({ models: [] });
  };
  assert.equal(await getLoadedLmStudioModelIds('https://127.0.0.1:1234/v1', { fetchImpl }), null);
  assert.equal(await getLoadedLmStudioModelIds('http://127.0.0.1:1235/v1', { fetchImpl }), null);
  assert.equal(await getLoadedLmStudioModelIds('http://example.test:1234/v1', { fetchImpl }), null);
  assert.equal(calls, 0);
});

test('local discovery refuses redirects and caps the model-list response body', async () => {
  let requestOptions;
  const redirected = await discoverLocalServers({
    config: {
      discovery: { enabled: false },
      local_servers: { studio: { base_url: 'http://127.0.0.1:1234/v1', api_key_env: 'XYST_TEST_DISCOVERY_KEY' } },
    },
    fetchImpl: async (_url, options) => {
      requestOptions = options;
      return new Response('', { status: 302, headers: { location: 'https://attacker.invalid/models' } });
    },
  });
  assert.deepEqual(redirected, []);
  assert.equal(requestOptions.redirect, 'error');

  const oversized = await discoverLocalServers({
    config: { discovery: { enabled: false }, local_servers: { studio: { base_url: 'http://127.0.0.1:1235/v1' } } },
    fetchImpl: async () => new Response(' '.repeat(1_048_577), { headers: { 'content-type': 'application/json' } }),
  });
  assert.deepEqual(oversized, []);
});

test('local discovery limits advertised model IDs and validates endpoint aliases', async () => {
  const data = Array.from({ length: 505 }, (_, index) => ({ id: `model-${index}` }));
  data.push({ id: 'x'.repeat(257) }, null, { name: 'missing-id' });
  const [server] = await discoverLocalServers({
    config: { discovery: { enabled: false }, local_servers: { studio: { base_url: 'http://127.0.0.1:1236/v1' } } },
    fetchImpl: async () => Response.json({ data }),
  });
  assert.equal(server.models.length, 500);
  assert.equal(server.models_truncated, true);
  assert.equal(server.models.at(-1), 'model-499');

  const [filtered] = await discoverLocalServers({
    config: { discovery: { enabled: false }, local_servers: { studio: { base_url: 'http://127.0.0.1:1237/v1' } } },
    fetchImpl: async () => Response.json({ data: [{ id: 'valid' }, { id: 'x'.repeat(257) }, null] }),
  });
  assert.deepEqual(filtered.models, ['valid']);
  assert.equal(filtered.models_truncated, true);
});

test('local endpoint discovery runs at most four probes concurrently', async () => {
  let active = 0;
  let maximum = 0;
  const local_servers = Object.fromEntries(
    Array.from({ length: 9 }, (_, index) => [`server-${index}`, { base_url: `http://127.0.0.1:${15000 + index}/v1` }]),
  );
  const servers = await discoverLocalServers({
    config: { discovery: { enabled: false }, local_servers },
    fetchImpl: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return Response.json({ data: [{ id: 'model' }] });
    },
  });
  assert.equal(servers.length, 9);
  assert.equal(maximum, 4);
});

test('local endpoint discovery rejects an oversized direct configuration before probing', async () => {
  const local_servers = Object.fromEntries(
    Array.from({ length: 17 }, (_, index) => [`server-${index}`, { base_url: `http://127.0.0.1:${16000 + index}/v1` }]),
  );
  let probed = false;
  await assert.rejects(
    discoverLocalServers({
      config: { local_servers },
      fetchImpl: async () => {
        probed = true;
      },
    }),
    /at most 16/,
  );
  assert.equal(probed, false);
});

test('secret stores return values only by key and list names without values', async () => {
  const store = new InMemorySecretStore();
  await store.set('provider.api_key', 'sensitive-value');
  assert.equal(await store.get('provider.api_key'), 'sensitive-value');
  assert.deepEqual(await store.listKeys(), ['provider.api_key']);
  assert.equal(JSON.stringify(await store.listKeys()).includes('sensitive-value'), false);
  assert.equal(await store.delete('provider.api_key'), true);
  const envStore = new EnvironmentSecretStore({ XYST_TOKEN: 'env-secret' }, 'XYST_');
  assert.equal(await envStore.get('TOKEN'), 'env-secret');
  assert.deepEqual(await envStore.listKeys(), ['TOKEN']);
  await assert.rejects(envStore.set('TOKEN', 'new'), /read-only/);
});

test('Linux Secret Service adapter sends credentials only on stdin and fails closed', async () => {
  const calls = [];
  const store = new LinuxSecretServiceStore({
    run: async (...args) => {
      calls.push(args);
      return { stdout: '', exitCode: args[1][0] === 'lookup' ? 2 : 0, truncated: false };
    },
  });
  await store.set('provider.key', 'canary-secret');
  assert.deepEqual(calls[0], [
    'secret-tool',
    ['store', '--label=Xyst AI Assistant credential', 'service', 'xyst-agent', 'key', 'provider.key'],
    'canary-secret',
  ]);
  assert.equal(JSON.stringify(calls[0][1]).includes('canary-secret'), false);
  await assert.rejects(store.get('provider.key'), /unavailable/);
  const unavailable = new LinuxSecretServiceStore({
    run: async () => {
      throw new Error('service diagnostics contain canary-secret');
    },
  });
  await assert.rejects(unavailable.get('x'), (error) => !error.message.includes('canary-secret'));
});

test('Linux Secret Service reads only credentials stored under the Xyst service name', async () => {
  const calls = [];
  const store = new LinuxSecretServiceStore({
    run: async (_command, args) => {
      calls.push(args);
      return { stdout: '', exitCode: 1, truncated: false };
    },
  });
  assert.equal(await store.get('provider.key'), null);
  assert.deepEqual(
    calls.map((args) => args.slice(0, 4)),
    [['lookup', 'service', 'xyst-agent', 'key']],
  );
});

test('Linux Secret Service deletes only the Xyst credential entry', async () => {
  const calls = [];
  const store = new LinuxSecretServiceStore({
    run: async (_command, args) => {
      calls.push(args);
      return { stdout: '', exitCode: args[0] === 'clear' && args[2] === 'xyst-agent' ? 0 : 1, truncated: false };
    },
  });
  assert.equal(await store.delete('provider.key'), true);
  assert.deepEqual(
    calls.map((args) => args.slice(0, 4)),
    [['clear', 'service', 'xyst-agent', 'key']],
  );
});

test('Linux Secret Service lists Xyst AI Assistant key metadata without requesting credential values', async () => {
  const calls = [];
  const collections = ['/org/freedesktop/secrets/collection/login', '/org/freedesktop/secrets/collection/work'];
  const itemPaths = {
    '/org/freedesktop/secrets/collection/login/1': "(<{'key': 'zeta.key', 'service': 'xyst-agent'}>,)",
    '/org/freedesktop/secrets/collection/login/2': "(<{'key': 'alpha.key', 'service': 'xyst-agent'}>,)",
    '/org/freedesktop/secrets/collection/work/1': "(<{'key': 'ignored.key', 'service': 'another-service'}>,)",
    '/org/freedesktop/secrets/collection/work/2': "(<{'key': 'alpha.key', 'service': 'xyst-agent'}>,)",
    '/org/freedesktop/secrets/collection/login/3': "(<{'key': 'ignored.key', 'service': 'another-service'}>,)",
  };
  const run = async (command, args, input) => {
    calls.push({ command, args, input });
    if (command !== 'gdbus') return { stdout: '', exitCode: 1, truncated: false };
    const objectPath = args[args.indexOf('--object-path') + 1];
    const method = args[args.indexOf('--method') + 1];
    if (method === 'org.freedesktop.DBus.Properties.Get' && args.at(-1) === 'Collections')
      return {
        stdout: `(<[${collections.map((item, index) => `${index === 0 ? 'objectpath ' : ''}'${item}'`).join(', ')}]>,)`,
        exitCode: 0,
        truncated: false,
      };
    if (method === 'org.freedesktop.Secret.Collection.SearchItems') {
      const service = /'service': '([^']+)'/.exec(args.at(-1))?.[1];
      const items = Object.entries(itemPaths)
        .filter(([item, attributes]) => item.startsWith(`${objectPath}/`) && attributes.includes(`'service': '${service}'`))
        .map(([item]) => item);
      return {
        stdout: `([${items.map((item, index) => `${index === 0 ? 'objectpath ' : ''}'${item}'`).join(', ')}],)`,
        exitCode: 0,
        truncated: false,
      };
    }
    if (method === 'org.freedesktop.DBus.Properties.Get' && args.at(-1) === 'Attributes')
      return { stdout: itemPaths[objectPath] || '(<{}>,)', exitCode: 0, truncated: false };
    return { stdout: '', exitCode: 1, truncated: false };
  };
  const store = new LinuxSecretServiceStore({ run });

  assert.deepEqual(await store.listKeys(), ['alpha.key', 'zeta.key']);
  assert.ok(calls.every((call) => call.command === 'gdbus' && call.input === ''));
  assert.ok(calls.every((call) => !call.args.includes('org.freedesktop.Secret.Item.GetSecret')));
  assert.ok(calls.some((call) => call.args.includes("{'service': 'xyst-agent'}")));
  assert.equal(calls.filter((call) => call.args.includes("{'service': 'xyst-agent'}")).length, collections.length);
});

test('Linux Secret Service bounds item metadata calls even when entries have duplicate keys', async () => {
  const collection = '/org/freedesktop/secrets/collection/login';
  const items = Array.from({ length: 513 }, (_, index) => `${collection}/${index + 1}`);
  const calls = [];
  const store = new LinuxSecretServiceStore({
    run: async (command, args, input) => {
      calls.push({ command, args, input });
      if (command !== 'gdbus') return { stdout: '', exitCode: 1, truncated: false };
      const method = args[args.indexOf('--method') + 1];
      if (method === 'org.freedesktop.DBus.Properties.Get')
        return { stdout: `(<[objectpath '${collection}']>,)`, exitCode: 0, truncated: false };
      if (method === 'org.freedesktop.Secret.Collection.SearchItems') {
        const paths = items.map((item, index) => `${index === 0 ? 'objectpath ' : ''}'${item}'`);
        return { stdout: `([${paths.join(', ')}],)`, exitCode: 0, truncated: false };
      }
      return { stdout: '', exitCode: 1, truncated: false };
    },
  });

  await assert.rejects(store.listKeys(), /too many Xyst AI Assistant credentials/);
  assert.equal(calls.length, 2, 'The adapter must stop before reading item attributes after the cap');
});

test('Linux Secret Service stores and retrieves a credential through the real session keyring', {
  skip: secretServiceIntegrationSkip,
}, async () => {
  assert.ok(process.env.DBUS_SESSION_BUS_ADDRESS, 'A D-Bus session address is required for the real Secret Service test');
  const store = new LinuxSecretServiceStore();
  const key = `integration-${randomUUID()}`;
  const secret = `xyst-integration-${randomUUID()}`;
  try {
    assert.equal(await store.get(key), null, 'A new integration key must not already exist');
    await store.set(key, secret);
    assert.equal(await store.get(key), secret);
    const keys = await store.listKeys();
    assert.ok(keys.includes(key));
    assert.doesNotMatch(JSON.stringify(keys), new RegExp(secret));
    assert.equal(await store.delete(key), true);
    assert.equal(await store.get(key), null);
    assert.equal((await store.listKeys()).includes(key), false);
  } finally {
    await store.delete(key);
  }
});

test('Windows Credential Manager adapter keeps values off argv and decodes only the response payload', async () => {
  let request;
  const store = new WindowsCredentialStore({
    powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    run: async (command, args, input) => {
      request = { command, args, input };
      return {
        stdout: Buffer.from(JSON.stringify({ found: true, value: 'vault-canary' })).toString('base64'),
        exitCode: 0,
        truncated: false,
      };
    },
  });
  assert.equal(await store.get('provider'), 'vault-canary');
  assert.equal(request.command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(request.args[request.args.length - 1].length > 100, true);
  assert.equal(request.args.join(' ').includes('vault-canary'), false);
  assert.equal(Buffer.from(request.input, 'base64').toString('utf8'), JSON.stringify({ op: 'get', key: 'provider' }));
  const helperScript = Buffer.from(request.args.at(-1), 'base64').toString('utf16le');
  assert.match(helperScript, /\$prefix = 'XystAgent:'/);
  assert.doesNotMatch(helperScript, /legacy/i);
  assert.throws(() => createPlatformSecretStore({ platform: 'darwin' }), /No supported OS credential vault/);
});

test('model API key references resolve from the OS vault and reject ambiguous references', async () => {
  const store = new InMemorySecretStore();
  await store.set('provider', 'provider-secret');
  assert.equal(await resolveModelApiKey({ api_key_secret: 'provider' }, { secretStore: store }), 'provider-secret');
  assert.equal(await resolveModelApiKey({ api_key_env: 'TOKEN' }, { env: { TOKEN: 'env-secret' }, secretStore: store }), 'env-secret');
  await assert.rejects(resolveModelApiKey({ api_key_secret: 'missing' }, { secretStore: store }), /not found/);
  assert.throws(
    () =>
      validateConfig({
        models: {
          x: {
            provider: 'openai-compatible',
            base_url: 'https://example.test/v1',
            model: 'm',
            api_key_env: 'TOKEN',
            api_key_secret: 'vault',
          },
        },
      }),
    /only one/,
  );
});

test('local discovery configuration has bounded, stable endpoint names', () => {
  assert.throws(() => validateConfig({ local_servers: { 'Bad Name': { base_url: 'http://127.0.0.1:1234/v1' } } }), /lowercase name/);
  const local_servers = Object.fromEntries(
    Array.from({ length: 17 }, (_, index) => [`server-${index}`, { base_url: `http://127.0.0.1:${1234 + index}/v1` }]),
  );
  assert.throws(() => validateConfig({ local_servers }), /at most 16 endpoints/);
});
