import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlApiClient, ControlApiError } from '../src/api/client.mjs';

const TOKEN = 'xyst-test-control-token-0123456789';

test('control API client binds the default fetch receiver', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function (url, options) {
    assert.equal(this, globalThis);
    assert.equal(url, 'http://127.0.0.1:4321/v1/health');
    assert.equal(options.headers.authorization, `Bearer ${TOKEN}`);
    return Promise.resolve(Response.json({ status: 'ready', api_version: 1 }));
  };
  try {
    const client = new ControlApiClient({ url: 'http://127.0.0.1:4321', token: TOKEN });
    assert.deepEqual(await client.health(), { status: 'ready', api_version: 1 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('control API client sends bearer auth, rejects redirects, and uses versioned endpoints', async () => {
  const requests = [];
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return Response.json({ run_id: 'run-1', status: 'running', events_url: '/v1/runs/run-1/events' }, { status: 202 });
    },
  });
  const accepted = await client.startRun({ prompt: 'Inspect files.', mcp_servers: ['docs'] });
  assert.equal(accepted.run_id, 'run-1');
  assert.equal(requests[0].url, 'http://127.0.0.1:4321/v1/runs');
  assert.equal(requests[0].options.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(requests[0].options.redirect, 'error');
  assert.deepEqual(JSON.parse(requests[0].options.body), { prompt: 'Inspect files.', mcp_servers: ['docs'] });
});

test('control API client builds bounded workspace retrieval requests', async () => {
  let requestedUrl;
  let signal;
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      signal = options.signal;
      return Response.json({ matches: [] });
    },
  });
  const controller = new AbortController();
  assert.deepEqual(await client.searchWorkspace('a phrase', { pathGlob: 'src/**/*.mjs', maxResults: 20, signal: controller.signal }), {
    matches: [],
  });
  assert.equal(requestedUrl, 'http://127.0.0.1:4321/v1/retrieval/search?q=a+phrase&path_glob=src%2F**%2F*.mjs&max_results=20');
  assert.equal(signal, controller.signal);
  assert.throws(() => client.searchWorkspace(''), /query/);
  assert.throws(() => client.searchWorkspace('q', { maxResults: 101 }), /maxResults/);
});

test('control API client validates and sends MCP server lifecycle requests', async () => {
  const requests = [];
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return Response.json({ servers: [], persisted: true });
    },
  });
  await client.setMcpServerEnabled('docs-server', true);
  await client.setMcpServerEnabled('docs-server', false);
  await client.removeMcpServer('docs-server');
  assert.equal(requests[0].url, 'http://127.0.0.1:4321/v1/mcp/servers/docs-server');
  assert.equal(requests[0].options.method, 'PUT');
  assert.deepEqual(JSON.parse(requests[0].options.body), { enabled: true });
  assert.equal(requests[2].options.method, 'DELETE');
  assert.deepEqual(JSON.parse(requests[2].options.body), {});
  assert.throws(() => client.setMcpServerEnabled('Bad Name', true), /name is invalid/);
  assert.throws(() => client.setMcpServerEnabled('docs-server', 'yes'), /boolean/);
});

test('control API client adds, edits, inspects, and tests MCP server connections', async () => {
  const requests = [];
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return Response.json({ config: { command: 'node' }, result: { success: true }, servers: [] });
    },
  });
  await client.addMcpServer('docs', { command: 'node', args: ['server.js'] });
  await client.getMcpServerConfig('docs');
  await client.testMcpServer('docs');
  await client.updateMcpServer('docs', { timeout_ms: 3000 });
  assert.equal(requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].options.body), { name: 'docs', config: { command: 'node', args: ['server.js'] } });
  assert.equal(requests[1].url, 'http://127.0.0.1:4321/v1/mcp/servers/docs/config');
  assert.equal(requests[2].url, 'http://127.0.0.1:4321/v1/mcp/servers/docs/test');
  assert.equal(requests[3].options.method, 'PUT');
  assert.deepEqual(JSON.parse(requests[3].options.body), { timeout_ms: 3000 });
  assert.throws(() => client.addMcpServer('Invalid Name', {}), /name is invalid/);
});

test('control API client reads bounded MCP audit history', async () => {
  let requestedUrl;
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url) => {
      requestedUrl = url;
      return Response.json({ entries: [], truncated: false });
    },
  });
  assert.deepEqual(await client.listMcpAuditHistory({ limit: 25 }), { entries: [], truncated: false });
  assert.equal(requestedUrl, 'http://127.0.0.1:4321/v1/mcp/audit?limit=25');
  assert.throws(() => client.listMcpAuditHistory({ limit: 201 }), /1 to 200/);
});

test('control API client requires explicit consent before semantic retrieval', async () => {
  let requestedUrl;
  let requestBody;
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      requestBody = JSON.parse(options.body);
      return Response.json({ matches: [] });
    },
  });
  assert.throws(() => client.searchSemantic('meaning'), /explicit approval/);
  await client.searchSemantic('meaning', { pathGlob: 'src/**', maxResults: 8, approved: true });
  assert.equal(requestedUrl, 'http://127.0.0.1:4321/v1/retrieval/semantic');
  assert.deepEqual(requestBody, { query: 'meaning', path_glob: 'src/**', max_results: 8, approved: true });
  assert.throws(() => client.searchSemantic('q', { approved: true, maxResults: 51 }), /maxResults/);
});

test('control API client exposes audited index and relative-glob exclusion controls', async () => {
  const requests = [];
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return Response.json({ patterns: [] });
    },
  });
  await client.getSemanticIndex();
  await client.getRetrievalExclusions();
  assert.throws(() => client.manageSemanticIndex('reindex'), /explicit approval/);
  await client.manageSemanticIndex('reindex', { approved: true });
  await client.manageSemanticIndex('clear');
  await client.changeRetrievalExclusion('add', 'generated/**');
  await client.changeRetrievalExclusion('remove', 'generated/**');
  assert.equal(requests[0].url, 'http://127.0.0.1:4321/v1/retrieval/index');
  assert.equal(requests[1].url, 'http://127.0.0.1:4321/v1/retrieval/exclusions');
  assert.deepEqual(JSON.parse(requests[2].options.body), { action: 'reindex', approved: true });
  assert.deepEqual(JSON.parse(requests[3].options.body), { action: 'clear' });
  assert.deepEqual(JSON.parse(requests[4].options.body), { action: 'add', pattern: 'generated/**' });
  assert.deepEqual(JSON.parse(requests[5].options.body), { action: 'remove', pattern: 'generated/**' });
});

test('control API client reads the sanitized settings snapshot', async () => {
  let requestedUrl;
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url) => {
      requestedUrl = url;
      return Response.json({ settings: { default_model: 'local', models: {} } });
    },
  });
  assert.deepEqual(await client.getSettings(), { default_model: 'local', models: {} });
  assert.equal(requestedUrl, 'http://127.0.0.1:4321/v1/settings');
});

test('control API client sends explicit application update checks to the authenticated endpoint', async () => {
  let requested;
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url, options) => {
      requested = { url, options };
      return Response.json({ update_available: false });
    },
  });
  assert.deepEqual(await client.checkApplicationUpdates(), { update_available: false });
  assert.equal(requested.url, 'http://127.0.0.1:4321/v1/app-updates/check');
  assert.equal(requested.options.method, 'POST');
  assert.equal(requested.options.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(requested.options.body), {});
});

test('control API client prepares only the selected application update with authenticated API access', async () => {
  let requested;
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url, options) => {
      requested = { url, options };
      return Response.json({ download_path: '/v1/app-updates/downloads/token' });
    },
  });
  assert.deepEqual(await client.downloadApplicationUpdate('1.2.3', 8), {
    download_path: '/v1/app-updates/downloads/token',
  });
  assert.equal(requested.url, 'http://127.0.0.1:4321/v1/app-updates/download');
  assert.equal(requested.options.method, 'POST');
  assert.equal(requested.options.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(requested.options.body), { version: '1.2.3', sequence: 8 });
  assert.throws(() => client.downloadApplicationUpdate('not-a-version', 8), /version must be a release version/);
  assert.throws(() => client.downloadApplicationUpdate('1.2.3', 0), /sequence must be a positive safe integer/);
});

test('control API client discovers local model servers through the authenticated endpoint', async () => {
  let request;
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return Response.json({ servers: [], scanned: [] });
    },
  });
  assert.deepEqual(await client.discoverLocalModels(), { servers: [], scanned: [] });
  assert.equal(request.url, 'http://127.0.0.1:4321/v1/local-models');
  assert.equal(request.options.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(request.options.redirect, 'error');
});

test('control API client loads only the explicitly selected local model through its authenticated endpoint', async () => {
  let request;
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return Response.json({ model: 'qwen-test', loaded: true, already_loaded: false });
    },
  });
  assert.deepEqual(await client.loadLocalModel('qwen-test'), { model: 'qwen-test', loaded: true, already_loaded: false });
  assert.equal(request.url, 'http://127.0.0.1:4321/v1/local-models/load');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(request.options.body), { model: 'qwen-test' });
  assert.equal(request.options.redirect, 'error');
  assert.throws(() => client.loadLocalModel(''), /valid local model ID/);
});

test('control API client writes only to the authenticated settings endpoint', async () => {
  let request;
  const patch = {
    default_model: 'local',
    routing: { selection: 'quality', prefer_local: true },
    budgets: { max_daily_input_tokens: 5000 },
  };
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return Response.json({ updated: Object.keys(patch), persisted: true });
    },
  });
  assert.equal((await client.updateSettings(patch)).persisted, true);
  assert.equal(request.url, 'http://127.0.0.1:4321/v1/settings');
  assert.equal(request.options.method, 'PATCH');
  assert.deepEqual(JSON.parse(request.options.body), patch);
});

test('control API client reads sandbox capability from the authenticated local endpoint', async () => {
  let requestedUrl;
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url) => {
      requestedUrl = url;
      return Response.json({ available: false, reason: 'unsupported_platform', mode: 'disabled' });
    },
  });
  assert.deepEqual(await client.getSandboxCapability(), { available: false, reason: 'unsupported_platform', mode: 'disabled' });
  assert.equal(requestedUrl, 'http://127.0.0.1:4321/v1/sandbox-capability');
});

test('control API client stores credentials in the authenticated vault endpoint without accepting invalid keys', async () => {
  const requests = [];
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return Response.json({ stored: true });
    },
  });
  const secret = 'never-log-this-value';
  assert.deepEqual(await client.storeCredential('xyst.model.local', secret), { stored: true });
  assert.equal(requests[0].url, 'http://127.0.0.1:4321/v1/secrets/xyst.model.local');
  assert.equal(JSON.parse(requests[0].options.body).value, secret);
  assert.throws(() => client.storeCredential('../escape', secret), /credential key is invalid/);
  assert.throws(() => client.storeCredential('safe.key', ''), /non-empty string/);
});

test('control API client lists and loads configured skills by validated ID', async () => {
  const requests = [];
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url) => {
      requests.push(url);
      return url.endsWith('/skills')
        ? Response.json({ enabled: true, skills: [{ name: 'release-check', description: 'Prepare release', trust: 'untrusted' }] })
        : Response.json({ skill: { name: 'release-check', content: 'Untrusted text', trust: 'untrusted' } });
    },
  });
  assert.equal((await client.listSkills()).skills[0].name, 'release-check');
  assert.equal((await client.getSkill('release-check')).trust, 'untrusted');
  assert.deepEqual(requests, ['http://127.0.0.1:4321/v1/skills', 'http://127.0.0.1:4321/v1/skills/release-check']);
  assert.throws(() => client.getSkill('../outside'), /lowercase hyphenated/);
});

test('control API client manages signed skill activations with validated coordinates', async () => {
  const requests = [];
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return Response.json({ result: { changed: true } });
    },
  });
  await client.activateSignedSkillPackage('release-check', '1.2.3');
  await client.disableSignedSkillPackage('release-check');
  await client.rollbackSignedSkillPackage('release-check');
  await client.listSignedSkillPackages();
  assert.deepEqual(
    requests.map(({ url, options }) => [new URL(url).pathname, options.method || 'GET', options.body || null]),
    [
      ['/v1/skills/packages/release-check/activate', 'POST', JSON.stringify({ version: '1.2.3' })],
      ['/v1/skills/packages/release-check/disable', 'POST', '{}'],
      ['/v1/skills/packages/release-check/rollback', 'POST', '{}'],
      ['/v1/skills/packages', 'GET', null],
    ],
  );
  assert.throws(() => client.disableSignedSkillPackage('../outside'), /lowercase hyphenated/);
});

test('control API client manages signed MCP packages with validated IDs and versions', async () => {
  const requests = [];
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return Response.json({ result: { changed: true }, packages: [] });
    },
  });
  await client.listSignedMcpPackages();
  await client.activateSignedMcpPackage('publisher.server-v2', '1.2.3');
  await client.disableSignedMcpPackage('publisher.server-v2');
  await client.rollbackSignedMcpPackage('publisher.server-v2');
  assert.deepEqual(
    requests.map(({ url, options }) => [new URL(url).pathname, options.method || 'GET', options.body || null]),
    [
      ['/v1/mcp/packages', 'GET', null],
      ['/v1/mcp/packages/publisher.server-v2/activate', 'POST', JSON.stringify({ version: '1.2.3' })],
      ['/v1/mcp/packages/publisher.server-v2/disable', 'POST', '{}'],
      ['/v1/mcp/packages/publisher.server-v2/rollback', 'POST', '{}'],
    ],
  );
  assert.throws(() => client.disableSignedMcpPackage('../outside'), /lowercase signed MCP/);
  assert.throws(() => client.activateSignedMcpPackage('server', 'v1'), /semantic package version/);
});

test('control API client exposes explicit signed extension update and revocation actions', async () => {
  const requests = [];
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return Response.json({ status: 'ready' });
    },
  });
  await client.getExtensionUpdates();
  await client.checkExtensionUpdates();
  await client.installExtensionUpdate('skill', 'release-check');
  await client.installExtensionUpdate('mcp', 'publisher.server-v2');
  await client.refreshExtensionRevocations();
  assert.deepEqual(
    requests.map(({ url, options }) => [new URL(url).pathname, options.method || 'GET', options.body || null]),
    [
      ['/v1/extensions/updates', 'GET', null],
      ['/v1/extensions/updates/check', 'POST', '{}'],
      ['/v1/extensions/updates/install', 'POST', JSON.stringify({ package_type: 'skill', package_id: 'release-check' })],
      ['/v1/extensions/updates/install', 'POST', JSON.stringify({ package_type: 'mcp', package_id: 'publisher.server-v2' })],
      ['/v1/extensions/revocations/refresh', 'POST', '{}'],
    ],
  );
  assert.throws(() => client.installExtensionUpdate('skill', '../outside'), /lowercase hyphenated/);
  assert.throws(() => client.installExtensionUpdate('other', 'release-check'), /skill or mcp/);
});

test('control API client lists the authenticated MCP server catalog', async () => {
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url) => {
      assert.equal(new URL(url).pathname, '/v1/mcp/servers');
      return Response.json({ servers: [{ name: 'docs', connection_state: 'disabled', tools: [] }] });
    },
  });
  assert.deepEqual(await client.listMcpServers(), [{ name: 'docs', connection_state: 'disabled', tools: [] }]);
});

test('control API client reads aggregate usage from the authenticated endpoint', async () => {
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (requestUrl) => {
      assert.equal(new URL(requestUrl).pathname, '/v1/usage');
      return Response.json({
        daily: { input_tokens: 12, output_tokens: 3, cost_usd: 0.01 },
        monthly: { input_tokens: 12, output_tokens: 3, cost_usd: 0.01 },
        active_reservations: 0,
      });
    },
  });
  assert.equal((await client.getUsage()).daily.input_tokens, 12);
});

test('control API client lists configured provider models', async () => {
  let requestedUrl;
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url) => {
      requestedUrl = url;
      return Response.json({ profiles: [{ profile: 'local', models: ['tiny'] }] });
    },
  });
  assert.deepEqual(await client.listModels(), [{ profile: 'local', models: ['tiny'] }]);
  assert.equal(requestedUrl, 'http://127.0.0.1:4321/v1/models');
});

test('control API client never accepts a remote URL or unsafe token', () => {
  assert.throws(() => new ControlApiClient({ url: 'https://127.0.0.1', token: TOKEN }), /127\.0\.0\.1 origin/);
  assert.throws(() => new ControlApiClient({ url: 'http://agent.example', token: TOKEN }), /127\.0\.0\.1 origin/);
  assert.throws(() => new ControlApiClient({ url: 'http://127.0.0.1/api', token: TOKEN }), /origin/);
  assert.throws(() => new ControlApiClient({ url: 'http://127.0.0.1', token: `${TOKEN}\r\nX-Evil: true` }), /token/);
});

test('control API client exports a session through the authenticated endpoint', async () => {
  let requestedUrl;
  const payload = { format: 'xyst-session', format_version: 1 };
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url) => {
      requestedUrl = url;
      return Response.json(payload);
    },
  });
  assert.deepEqual(await client.exportSession('8c2d8c80-840a-41ce-b121-78a5b8694af3'), payload);
  assert.equal(requestedUrl, 'http://127.0.0.1:4321/v1/sessions/8c2d8c80-840a-41ce-b121-78a5b8694af3/export');
});

test('control API client imports a portable session through the authenticated endpoint', async () => {
  let requestedUrl;
  let requestOptions;
  const imported = { id: '7da35e9f-221c-43d1-9e56-780d119b3320', messages: [] };
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      requestOptions = options;
      return Response.json({ session: imported }, { status: 201 });
    },
  });
  const envelope = { format: 'xyst-session', format_version: 1, session: {}, archives: [] };
  assert.deepEqual(await client.importSession(envelope), imported);
  assert.equal(requestedUrl, 'http://127.0.0.1:4321/v1/sessions/import');
  assert.equal(requestOptions.method, 'POST');
  assert.equal(requestOptions.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(requestOptions.body), envelope);
});

test('control API client updates a session plan through the dedicated endpoint', async () => {
  let requestedUrl;
  let requestOptions;
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      requestOptions = options;
      return Response.json({ id: '8c2d8c80-840a-41ce-b121-78a5b8694af3', plan: '1. Inspect' });
    },
  });
  const updated = await client.updateSessionPlan('8c2d8c80-840a-41ce-b121-78a5b8694af3', '1. Inspect');
  assert.equal(updated.plan, '1. Inspect');
  assert.equal(requestedUrl, 'http://127.0.0.1:4321/v1/sessions/8c2d8c80-840a-41ce-b121-78a5b8694af3/plan');
  assert.equal(requestOptions.method, 'PUT');
  assert.deepEqual(JSON.parse(requestOptions.body), { plan: '1. Inspect' });
});

test('control API client replaces the validated goal references for a session', async () => {
  let requestedUrl;
  let requestOptions;
  const goalIds = ['8c2d8c80-840a-41ce-b121-78a5b8694af3'];
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      requestOptions = options;
      return Response.json({ id: '1e5cf5f7-feb4-4eed-a32c-14b287197f06', persistent_goal_ids: goalIds });
    },
  });
  const updated = await client.setSessionGoals('1e5cf5f7-feb4-4eed-a32c-14b287197f06', goalIds);
  assert.deepEqual(updated.persistent_goal_ids, goalIds);
  assert.equal(requestedUrl, 'http://127.0.0.1:4321/v1/sessions/1e5cf5f7-feb4-4eed-a32c-14b287197f06/goals');
  assert.equal(requestOptions.method, 'PUT');
  assert.deepEqual(JSON.parse(requestOptions.body), { goal_ids: goalIds });
});

test('control API client parses event streams across split UTF-8 chunks and reconnect IDs', async () => {
  const text =
    'retry: 3000\n\nid: 7\r\nevent: assistant_delta\r\ndata: {"type":"assistant_delta","text":"hello"}\r\n\r\n: ping\n\nid: 8\nevent: api_run_finished\ndata: {"status":"complete","session_id":null}';
  const encoded = new TextEncoder().encode(text);
  const chunks = [encoded.slice(0, 19), encoded.slice(19, 47), encoded.slice(47, 83), encoded.slice(83)];
  let index = 0;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        if (index === chunks.length) controller.close();
        else controller.enqueue(chunks[index++]);
      },
    }),
    { headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
  );
  let requestedUrl;
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url) => {
      requestedUrl = url;
      return response;
    },
  });
  const events = [];
  for await (const event of client.events('run-1', { after: 6 })) events.push(event);
  assert.equal(requestedUrl, 'http://127.0.0.1:4321/v1/runs/run-1/events?after=6');
  assert.deepEqual(events, [
    { id: '7', type: 'assistant_delta', data: { type: 'assistant_delta', text: 'hello' } },
    { id: '8', type: 'api_run_finished', data: { status: 'complete', session_id: null } },
  ]);
});

test('control API client rejects malformed terminal event payloads', async () => {
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async () =>
      new Response('id: 1\nevent: api_run_finished\ndata: {"status":"complete"}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
  });
  await assert.rejects(
    async () => {
      for await (const _event of client.events('run-1')) {
        /* Consume the stream so dispatch validation runs. */
      }
    },
    (error) => error.code === 'INVALID_STREAM',
  );
});

test('control API client resumes a dropped run stream from the last event without duplicates', async () => {
  const requests = [];
  let runReads = 0;
  const stream = (events) =>
    new Response(events.map(({ id, type, data }) => `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    });
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url) => {
      requests.push(url);
      if (url.includes('/events')) {
        if (!url.includes('?after=')) return stream([{ id: 1, type: 'assistant_delta', data: { text: 'A' } }]);
        return stream([
          { id: 1, type: 'assistant_delta', data: { text: 'A' } },
          { id: 2, type: 'api_run_finished', data: { status: 'complete', session_id: null } },
        ]);
      }
      runReads += 1;
      return Response.json({ status: runReads === 1 ? 'running' : 'complete' });
    },
  });
  const received = [];
  for await (const event of client.followRunEvents('run-1', { retryDelayMs: 0 })) received.push(event);
  assert.deepEqual(
    received.map(({ id, type }) => ({ id, type })),
    [
      { id: '1', type: 'assistant_delta' },
      { id: '2', type: 'api_run_finished' },
    ],
  );
  assert.ok(requests.includes('http://127.0.0.1:4321/v1/runs/run-1/events?after=1'));
  assert.equal(runReads, 2);
});

test('control API client closes an event stream when its consumer stops early', async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('id: 1\nevent: sample\ndata: {"ok":true}\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
  const client = new ControlApiClient({ url: 'http://127.0.0.1', token: TOKEN, fetchImpl: async () => response });
  for await (const _event of client.events('run')) break;
  assert.equal(cancelled, true);
});

test('control API client returns structured errors without hiding HTTP status', async () => {
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async () => Response.json({ error: 'Run not found' }, { status: 404 }),
  });
  await assert.rejects(
    client.getRun('missing'),
    (error) =>
      error instanceof ControlApiError && error.status === 404 && error.code === 'CONTROL_API_ERROR' && error.message === 'Run not found',
  );
});

test('control API client validates run request shape before sending it', () => {
  let called = false;
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async () => {
      called = true;
      return Response.json({ run_id: 'r1', status: 'running', events_url: '/v1/runs/r1/events' }, { status: 202 });
    },
  });

  assert.throws(() => client.startRun({ prompt: 'Run', unexpected: true }), /unsupported property/);
  assert.throws(() => client.startRun({ prompt: '  ' }), /prompt must contain/);
  assert.throws(() => client.startRun({ prompt: 'Run', worktree_id: 'bad' }), /worktree UUID/);
  assert.equal(called, false);
});

test('control API client preserves valid error codes and falls back for malformed codes', async () => {
  const makeClient = (body) =>
    new ControlApiClient({
      url: 'http://127.0.0.1:4321',
      token: TOKEN,
      fetchImpl: async () => Response.json(body, { status: 404 }),
    });

  await assert.rejects(
    makeClient({ error: 'MCP server not found', code: 'MCP_SERVER_NOT_FOUND' }).listMcpServers(),
    (error) => error instanceof ControlApiError && error.code === 'MCP_SERVER_NOT_FOUND',
  );
  await assert.rejects(
    makeClient({ error: 'Malformed error', code: 'invalid code' }).listMcpServers(),
    (error) => error instanceof ControlApiError && error.code === 'CONTROL_API_ERROR',
  );
  await assert.rejects(
    makeClient({ error: 'Malformed error', code: { value: 'MCP_SERVER_NOT_FOUND' } }).listMcpServers(),
    (error) => error instanceof ControlApiError && error.code === 'CONTROL_API_ERROR',
  );
  await assert.rejects(
    makeClient({ error: 'Malformed error', code: `A${'B'.repeat(64)}` }).listMcpServers(),
    (error) => error instanceof ControlApiError && error.code === 'CONTROL_API_ERROR',
  );
});

test('control API client exposes paginated memory and goal mutations', async () => {
  const calls = [];
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/goals?include_completed=false')) return Response.json({ goals: [] });
      if (url.endsWith('/goals')) return Response.json({ goal: { id: 'g1' } }, { status: 201 });
      if (url.endsWith('/goals/g1/progress')) return Response.json({ goal: { id: 'g1', progress: [] } }, { status: 201 });
      if (url.endsWith('/goals/g1/progress/p1')) return Response.json({ goal: { id: 'g1', progress: [] } });
      if (url.endsWith('/memory')) return Response.json({ item: { id: 'm1' } }, { status: 201 });
      if (url.includes('/memory/conventions?')) return Response.json({ items: [] });
      return Response.json({ deleted: true });
    },
  });
  const addedMemory = await client.addMemory('conventions', 'Prefer clarity.');
  assert.equal(addedMemory.item.id, 'm1');
  await client.listMemory('conventions', { offset: 25, limit: 10 });
  await client.updateMemory('conventions', 'm1', 'Prefer clear names.');
  await client.deleteMemory('conventions', 'm1');
  await client.addGoal('Ship API');
  await client.addGoalProgress('g1', 'Tests pass.', 'tests/api.test.mjs');
  await client.updateGoalProgress('g1', 'p1', 'Updated result.', 'tests/api.test.mjs');
  await client.deleteGoalProgress('g1', 'p1');
  assert.deepEqual(await client.listGoals({ includeCompleted: false }), []);
  await client.setGoalStatus('g1', 'completed');
  await client.deleteGoal('g1');
  assert.equal(calls.length, 11);
  assert.ok(calls.some(({ url }) => url.endsWith('/memory/conventions?offset=25&limit=10')));
  assert.ok(calls.some(({ options }) => options.method === 'PATCH'));
  assert.ok(calls.some(({ options }) => options.method === 'DELETE'));
  assert.ok(calls.some(({ url }) => url.endsWith('/goals/g1/progress')));
  assert.ok(calls.some(({ url, options }) => url.endsWith('/goals/g1/progress/p1') && options.method === 'PATCH'));
  assert.ok(calls.some(({ url, options }) => url.endsWith('/goals/g1/progress/p1') && options.method === 'DELETE'));
});

test('control API client exposes separate global memory CRUD and portable operations', async () => {
  const calls = [];
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: 'a'.repeat(43),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return Response.json({ item: { id: 'global-1' } });
    },
  });
  const document = { format: 'xyst-memory', format_version: 1 };
  await client.getGlobalMemory();
  await client.listGlobalMemory('user_preferences', { offset: 5, limit: 10 });
  await client.searchGlobalMemory('concise', { section: 'user_preferences', limit: 20 });
  await client.addGlobalMemory('user_preferences', 'Prefer concise answers.');
  await client.updateGlobalMemory('user_preferences', 'global-1', 'Prefer short answers.');
  await client.deleteGlobalMemory('user_preferences', 'global-1');
  await client.exportGlobalMemory();
  await client.importGlobalMemory(document);
  assert.deepEqual(
    calls.map(({ url }) => new URL(url).pathname),
    [
      '/v1/memory/global',
      '/v1/memory/global/user_preferences',
      '/v1/memory/global/search',
      '/v1/memory/global',
      '/v1/memory/global/user_preferences/global-1',
      '/v1/memory/global/user_preferences/global-1',
      '/v1/memory/global/export',
      '/v1/memory/global/import',
    ],
  );
  assert.equal(calls[7].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[7].options.body), document);
});

test('control API client exports and imports versioned project memory', async () => {
  const calls = [];
  const memory = { format: 'xyst-memory', format_version: 1 };
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return Response.json(url.endsWith('/memory/export') ? memory : { imported: 2, skipped_duplicates: 1 });
    },
  });
  assert.deepEqual(await client.exportMemory(), memory);
  assert.deepEqual(await client.importMemory(memory), { imported: 2, skipped_duplicates: 1 });
  assert.equal(calls[0].url, 'http://127.0.0.1:4321/v1/memory/export');
  assert.equal(calls[1].url, 'http://127.0.0.1:4321/v1/memory/import');
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].options.body), memory);
});

test('control API client searches project memory with bounded pagination and optional scope', async () => {
  const calls = [];
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url) => {
      calls.push(url);
      return Response.json({ total: 1, items: [{ section: 'lessons_learned', text: 'Keep it simple' }] });
    },
  });
  assert.equal((await client.searchMemory('simple', { section: 'lessons_learned', limit: 20 })).items[0].section, 'lessons_learned');
  assert.match(calls[0], /\/v1\/memory\/search\?q=simple&offset=0&limit=20&section=lessons_learned/);
  assert.throws(() => client.searchMemory(' '), /query/);
  assert.throws(() => client.searchMemory('ok', { section: 'private' }), /section/);
  assert.throws(() => client.searchMemory('ok', { limit: 201 }), /limit/);
});

test('control API client manages worktrees and can select one for a run', async () => {
  const calls = [];
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/worktrees'))
        return options.method === 'POST'
          ? Response.json(
              { worktree: { id: '123e4567-e89b-42d3-a456-426614174000', path: 'C:/project/.agent/worktrees/wt-1' } },
              { status: 201 },
            )
          : Response.json({ worktrees: [{ id: '123e4567-e89b-42d3-a456-426614174000' }] });
      return Response.json({ removed: true });
    },
  });
  assert.deepEqual(await client.listWorktrees(), [{ id: '123e4567-e89b-42d3-a456-426614174000' }]);
  const worktree = await client.createWorktree('feature/example');
  assert.equal(worktree.id, '123e4567-e89b-42d3-a456-426614174000');
  await client.startRun({ prompt: 'Continue here', worktree_id: worktree.id });
  await client.removeWorktree(worktree.id);
  assert.deepEqual(JSON.parse(calls[1].options.body), { branch: 'feature/example' });
  assert.deepEqual(JSON.parse(calls[2].options.body), { prompt: 'Continue here', worktree_id: '123e4567-e89b-42d3-a456-426614174000' });
  assert.equal(calls[3].options.method, 'DELETE');
});

test('control API client validates workspace inspection paths and encodes worktree selection', async () => {
  const calls = [];
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url) => {
      calls.push(url);
      return Response.json({ path: 'src', entries: [], git: { available: false } });
    },
  });
  const view = await client.inspectWorkspace({ path: 'src', worktreeId: '38f73b12-90b9-4e3e-a268-2b239d2f6b2a' });
  assert.equal(view.path, 'src');
  assert.match(calls[0], /\/v1\/workspace\?path=src&worktree_id=/);
  assert.throws(() => client.inspectWorkspace({ path: '../outside' }), /traversal/);
  assert.throws(() => client.inspectWorkspace({ path: 'C:\\\\outside' }), /traversal/);
});

test('control API client validates and requests a workspace text preview', async () => {
  let requested;
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url) => {
      requested = url;
      return Response.json({ path: 'src/index.mjs', text: 'export {};', bytes: 10 });
    },
  });
  const result = await client.readWorkspaceFile({ path: 'src/index.mjs' });
  assert.equal(result.text, 'export {};');
  assert.match(requested, /\/v1\/workspace\/file\?path=src%2Findex\.mjs/);
  assert.throws(() => client.readWorkspaceFile({ path: '../private' }), /traversal/);
});

test('control API client lists bounded subagent tasks and validates task IDs', async () => {
  const calls = [];
  const id = '38f73b12-90b9-4e3e-a268-2b239d2f6b2a';
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/cancel')) return Response.json({ task_id: id, status: 'cancellation_requested', already_requested: false });
      return url.includes(id)
        ? Response.json({ task: { id, status: 'complete' } })
        : Response.json({ tasks: [{ id, status: 'complete' }] });
    },
  });
  assert.equal((await client.listSubagentTasks({ limit: 20 }))[0].id, id);
  assert.equal((await client.getSubagentTask(id)).status, 'complete');
  assert.deepEqual(await client.cancelSubagentTask(id), {
    task_id: id,
    status: 'cancellation_requested',
    already_requested: false,
  });
  assert.equal(calls[0].url, 'http://127.0.0.1:4321/v1/subagents?limit=20');
  assert.throws(() => client.listSubagentTasks({ limit: 501 }), /limit/);
  assert.throws(() => client.getSubagentTask('../outside'), /UUID/);
  assert.throws(() => client.cancelSubagentTask('../outside'), /UUID/);
  assert.equal(calls[2].url, `http://127.0.0.1:4321/v1/subagents/${id}/cancel`);
  assert.equal(calls[2].options.method, 'POST');
  assert.equal(calls[2].options.body, '{}');
});

test('control API client bounds process listings and uses authenticated lifecycle routes', async () => {
  const calls = [];
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json(
        options.method === 'DELETE'
          ? { removed: true }
          : url.endsWith('/stop')
            ? { process: { id: '8c2d8c80-840a-41ce-b121-78a5b8694af3', status: 'exited' } }
            : url.endsWith('/input')
              ? { result: { id: '8c2d8c80-840a-41ce-b121-78a5b8694af3', bytes_written: 5 } }
              : url.includes('?')
                ? { processes: [] }
                : { process: { id: '8c2d8c80-840a-41ce-b121-78a5b8694af3' } },
      );
    },
  });
  const id = '8c2d8c80-840a-41ce-b121-78a5b8694af3';
  assert.deepEqual(await client.listProcesses({ sessionId: id, limit: 20 }), []);
  assert.equal((await client.getProcess(id)).id, id);
  assert.equal((await client.stopProcess(id)).status, 'exited');
  assert.equal((await client.writeProcessInput(id, 'next\n')).bytes_written, 5);
  assert.deepEqual(await client.removeProcess(id), { removed: true });
  assert.equal(calls[0].url, `http://127.0.0.1:4321/v1/processes?limit=20&session_id=${id}`);
  assert.equal(calls[2].options.method, 'POST');
  assert.equal(calls[3].options.method, 'POST');
  assert.equal(calls[3].url, `http://127.0.0.1:4321/v1/processes/${id}/input`);
  assert.equal(calls[4].options.method, 'DELETE');
  assert.throws(() => client.listProcesses({ limit: 101 }), /limit/);
  assert.throws(() => client.getProcess('../outside'), /UUID/);
});

test('control API client pauses, resumes, and directs an active run with bounded text', async () => {
  const calls = [];
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json({ status: 'accepted' }, { status: 202 });
    },
  });
  const id = '8c2d8c80-840a-41ce-b121-78a5b8694af3';
  await client.getRun(id);
  await client.pauseRun(id);
  await client.resumeRun(id);
  await client.addRunDirection(id, 'Focus on cancellation and cleanup.');
  await client.changeRunModel(id, 'fast');
  await client.changeRunBudgets(id, { max_output_tokens: 12_000, max_session_cost: 2.5 });
  assert.deepEqual(
    calls.map(({ url }) => new URL(url).pathname),
    [
      `/v1/runs/${id}`,
      `/v1/runs/${id}/pause`,
      `/v1/runs/${id}/resume`,
      `/v1/runs/${id}/directions`,
      `/v1/runs/${id}/model`,
      `/v1/runs/${id}/budgets`,
    ],
  );
  assert.deepEqual(JSON.parse(calls[3].options.body), { content: 'Focus on cancellation and cleanup.' });
  assert.deepEqual(JSON.parse(calls[4].options.body), { model: 'fast' });
  assert.deepEqual(JSON.parse(calls[5].options.body), { budgets: { max_output_tokens: 12_000, max_session_cost: 2.5 } });
  assert.equal(calls[1].options.method, 'POST');
  assert.throws(() => client.addRunDirection(id, '\u{1F4A1}'.repeat(3000)), /10000 bytes/);
  assert.throws(() => client.changeRunModel(id, '  '), /configured profile name/);
  assert.throws(() => client.changeRunModel(id, 'x'.repeat(129)), /128 characters/);
  assert.throws(() => client.changeRunBudgets(id, {}), /at least one supported setting/);
  assert.throws(() => client.changeRunBudgets(id, { max_tool_output_bytes: 0 }), /positive integer/);
});

test('control API client manages session grants and submits bounded grant scopes', async () => {
  const calls = [];
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/sessions/s1/grants')) return Response.json({ grants: [{ id: 'grant1' }] });
      return Response.json({ resolved: true });
    },
  });
  assert.deepEqual(await client.listSessionGrants('s1'), [{ id: 'grant1' }]);
  await client.revokeSessionGrant('s1', 'grant1');
  await client.answerApproval('r1', 'a1', true, { grantScope: 'session_exact_action', grantDurationMs: 60_000 });
  assert.equal(JSON.parse(calls[2].options.body).grant_scope, 'session_exact_action');
  await client.answerApproval('r1', 'a2', true, { grantScope: 'exact_path_1h' });
  assert.equal(JSON.parse(calls[3].options.body).grant_scope, 'exact_path_1h');
  assert.equal(JSON.parse(calls[2].options.body).grant_duration_ms, 60_000);
  await client.answerApproval('r1', 'a3', true, { acceptedHunks: ['hunk-1', 'hunk-3'] });
  assert.deepEqual(JSON.parse(calls[4].options.body), { approved: true, accepted_hunks: ['hunk-1', 'hunk-3'] });
  assert.throws(
    () => client.answerApproval('r1', 'a1', true, { grantScope: 'session_exact_action', grantDurationMs: 30_000 }),
    /grantDurationMs/,
  );
  assert.throws(() => client.answerApproval('r1', 'a1', true, { acceptedHunks: ['hunk-1', 'hunk-1'] }), /unique valid hunk IDs/);
});

test('control API client manages expiring approval rules', async () => {
  const calls = [];
  const client = new ControlApiClient({
    url: 'http://127.0.0.1:4321',
    token: TOKEN,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (options.method === 'POST') return Response.json({ rule: { id: 'rule1', status: 'active' } }, { status: 201 });
      if (url.endsWith('/approval-rules')) return Response.json({ rules: [{ id: 'rule1' }] });
      return Response.json({ revoked: true });
    },
  });
  const created = await client.createApprovalRule({
    tool: 'write_file',
    scope: 'path_glob',
    pattern: 'generated/**',
    decision: 'allow',
    duration_ms: 60_000,
  });
  assert.equal(created.rule.id, 'rule1');
  assert.deepEqual(await client.listApprovalRules(), [{ id: 'rule1' }]);
  await client.revokeApprovalRule('rule1');
  assert.equal(JSON.parse(calls[0].options.body).duration_ms, 60_000);
  assert.equal(calls[2].options.method, 'DELETE');
});
