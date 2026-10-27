import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildExampleMcpPackage } from '../scripts/build-example-mcp-package.mjs';
import { LocalControlServer } from '../src/api/server.mjs';
import { installSignedPackage } from '../src/extensions/signed-packages.mjs';
import { createTempDirectory } from './helpers.mjs';

const TOKEN = 'xyst-test-mcp-package-api-token-012345';

test('authenticated API lists and manages signed MCP package activation, rollback, and live connection state', async (t) => {
  const workspace = await createTempDirectory('xyst-api-signed-mcp-');
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const installRoot = path.join(workspace, 'extensions');
  const pair = generateKeyPairSync('ed25519');
  const privateKeyPath = path.join(workspace, 'publisher-private.pem');
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' });
  await fs.writeFile(privateKeyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });

  for (const version of ['1.0.0', '1.1.0']) {
    const source = path.join(workspace, `source-${version}`);
    await buildExampleMcpPackage({ keyId: 'test-publisher', privateKeyPath, outputDirectory: source, version });
    await installSignedPackage(source, { installRoot, trustedKeys: { 'test-publisher': publicKeyPem } });
  }

  const server = new LocalControlServer({
    config: {
      default_model: 'local',
      models: {
        local: {
          provider: 'openai-compatible',
          base_url: 'http://127.0.0.1:1234/v1',
          model: 'test',
          local: true,
          supports_tools: true,
          context_length: 16_000,
        },
      },
      budgets: { max_turns: 3, max_input_tokens: 10_000, max_output_tokens: 1_000, max_tool_output_bytes: 2_000 },
      tools: { shell_enabled: true },
      sandbox: { mode: 'disabled' },
      extensions: { install_directory: installRoot, trusted_keys: { 'test-publisher': publicKeyPem } },
      mcp: { enabled: true, servers: { example: { enabled: true, package_id: 'hello-world-mcp' } } },
      _source: { userPath: path.join(workspace, 'config.toml') },
    },
    workspaceRoot: workspace,
    token: TOKEN,
  });
  const { url } = await server.start();
  t.after(() => server.close());
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

  assert.equal((await fetch(`${url}/v1/mcp/packages`)).status, 401);
  const initial = await fetch(`${url}/v1/mcp/packages`, { headers });
  assert.equal(initial.status, 200);
  assert.deepEqual((await initial.json()).packages, [
    {
      package_id: 'hello-world-mcp',
      active_version: null,
      previous_versions: [],
      available_versions: ['1.1.0', '1.0.0'],
      configured_servers: ['example'],
      enabled_configured_servers: ['example'],
    },
  ]);

  const manage = (action, body = {}) =>
    fetch(`${url}/v1/mcp/packages/hello-world-mcp/${action}`, { method: 'POST', headers, body: JSON.stringify(body) });

  server.mcpMutationActive = true;
  assert.equal((await manage('activate', { version: '1.0.0' })).status, 409);
  server.mcpMutationActive = false;
  const firstActivation = await manage('activate', { version: '1.0.0' });
  assert.equal(firstActivation.status, 200);
  assert.equal((await firstActivation.json()).servers[0].server_info.version, '1.0.0');
  const secondActivation = await manage('activate', { version: '1.1.0' });
  assert.equal(secondActivation.status, 200);
  assert.equal((await secondActivation.json()).servers[0].server_info.version, '1.1.0');
  const rollback = await manage('rollback');
  assert.equal(rollback.status, 200);
  assert.equal((await rollback.json()).servers[0].server_info.version, '1.0.0');
  const disabled = await manage('disable');
  assert.equal(disabled.status, 200);
  const disabledResult = await disabled.json();
  assert.deepEqual(disabledResult.result, { changed: true, active_version: null });
  assert.equal(disabledResult.servers[0].connection_state, 'error');

  assert.equal((await manage('activate', { version: '9.9.9' })).status, 404);
  assert.equal((await manage('activate', { version: '1.0.0', extra: true })).status, 400);
  const finalState = await (await fetch(`${url}/v1/mcp/packages`, { headers })).json();
  assert.equal(finalState.packages[0].active_version, null);
  assert.deepEqual(finalState.packages[0].previous_versions, ['1.1.0']);
  assert.equal(server.mcpManager.serverCatalog[0].error_code, 'MCP_PACKAGE_NOT_ACTIVE');
});
