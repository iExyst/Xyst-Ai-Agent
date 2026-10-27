import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildExampleMcpPackage } from '../scripts/build-example-mcp-package.mjs';
import { activateInstalledMcpPackage, getActiveInstalledMcpPackages } from '../src/extensions/package-registry.mjs';
import { installSignedPackage, verifySignedPackage } from '../src/extensions/signed-packages.mjs';
import { StdioMcpManager } from '../src/tools/mcp-stdio.mjs';
import { createTempDirectory } from './helpers.mjs';

test('example MCP package builds, verifies, stays inert until activation, and runs its declared tool', async (t) => {
  const root = await createTempDirectory('xyst-example-mcp-');
  const output = path.join(root, 'package');
  const installRoot = path.join(root, 'extensions');
  const pair = generateKeyPairSync('ed25519');
  const privateKeyPath = path.join(root, 'publisher-private.pem');
  const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' });
  await fs.writeFile(privateKeyPath, privateKeyPem, { mode: 0o600 });

  const buildResult = spawnSync(
    process.execPath,
    [
      path.resolve('scripts/build-example-mcp-package.mjs'),
      '--key-id',
      'example-publisher',
      '--private-key',
      privateKeyPath,
      '--output',
      output,
      '--version',
      '1.2.3',
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(buildResult.status, 0, buildResult.stderr);
  const built = JSON.parse(buildResult.stdout);
  assert.deepEqual(built, { output, package_id: 'hello-world-mcp', version: '1.2.3', files: 1 });
  assert.deepEqual((await fs.readdir(output)).sort(), ['manifest.json', 'server.mjs']);
  const trust = { installRoot, trustedKeys: { 'example-publisher': publicKeyPem } };
  const verified = await verifySignedPackage(output, { trustedKeys: trust.trustedKeys });
  assert.equal(verified.manifest.entry_point, 'server.mjs');
  assert.deepEqual([...verified.files.keys()], ['server.mjs']);
  assert.ok(verified.manifest.capabilities.some((item) => item.name === 'process.execute'));
  assert.ok(verified.manifest.capabilities.some((item) => item.name === 'mcp.tools'));

  await installSignedPackage(output, trust);
  assert.deepEqual(await getActiveInstalledMcpPackages(trust), []);
  await assert.rejects(
    buildExampleMcpPackage({ keyId: 'example-publisher', privateKeyPath, outputDirectory: output }),
    /Output already exists/,
  );
  await activateInstalledMcpPackage({ ...trust, packageId: 'hello-world-mcp', version: '1.2.3' });

  const manager = new StdioMcpManager({
    config: {
      tools: { shell_enabled: true },
      sandbox: { mode: 'disabled' },
      mcp: { enabled: true, servers: { example: { enabled: true, package_id: 'hello-world-mcp' } } },
    },
    workspaceRoot: root,
    installedPackages: trust,
  });
  t.after(async () => {
    await manager.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  await manager.initialize();
  assert.equal(manager.serverCatalog[0].connection_state, 'connected');
  assert.equal(manager.serverCatalog[0].server_info.version, '1.2.3');
  const callResult = await manager.call('mcp__example__echo', { text: 'signed and active' });
  assert.equal(callResult.resultType, 'complete');
  assert.deepEqual(callResult.content, [{ type: 'text', text: 'echo: signed and active' }]);
});

test('example MCP package builder rejects a non-Ed25519 key without creating output', async (t) => {
  const root = await createTempDirectory('xyst-example-mcp-key-');
  const output = path.join(root, 'package');
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPath = path.join(root, 'wrong-private.pem');
  await fs.writeFile(privateKeyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await assert.rejects(
    buildExampleMcpPackage({ keyId: 'example-publisher', privateKeyPath, outputDirectory: output }),
    /requires an Ed25519 private key/,
  );
  await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
});

test('example MCP server returns bounded JSON-RPC errors for malformed input', () => {
  const server = spawnSync(process.execPath, [path.resolve('examples/mcp/hello-world/server.mjs')], {
    encoding: 'utf8',
    input: 'not-json\n7\n{"jsonrpc":"2.0","id":1}\n',
    windowsHide: true,
  });
  assert.equal(server.status, 0, server.stderr);
  assert.deepEqual(
    server.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
    [
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } },
      { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Invalid request' } },
    ],
  );
});
