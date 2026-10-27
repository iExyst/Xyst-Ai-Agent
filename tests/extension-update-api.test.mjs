import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LocalControlServer } from '../src/api/server.mjs';
import { activateInstalledSkill } from '../src/extensions/package-registry.mjs';
import { canonicalJson, createSignedPackageBundle, installSignedPackage, signPackageManifest } from '../src/extensions/signed-packages.mjs';
import { createTempDirectory } from './helpers.mjs';

const TOKEN = 'xyst-test-extension-update-api-token-01';
const UPDATE_URL = 'https://updates.example.test/packages.json';
const PACKAGE_URL = 'https://packages.example.test/release-check-1.1.0';

function signedStatement(pair, statement) {
  return {
    ...statement,
    signature: sign(null, Buffer.from(canonicalJson(statement)), pair.privateKey).toString('base64'),
  };
}

async function createSkillPackage(root, version, privateKey) {
  await fs.mkdir(root, { recursive: true });
  const content = `---\nname: release-check\ndescription: Verify signed updates\n---\nInstructions for ${version}.\n`;
  await fs.writeFile(path.join(root, 'SKILL.md'), content);
  const manifest = signPackageManifest({
    packageId: 'release-check',
    packageType: 'skill',
    version,
    keyId: 'publisher-key',
    privateKey,
    files: [{ path: 'SKILL.md', size: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') }],
  });
  await fs.writeFile(path.join(root, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  return { manifest, bytes: await fs.readFile(path.join(root, 'manifest.json')) };
}

function serverConfig(workspace, installRoot, trustedKeys, extensions) {
  return {
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
    extensions: { install_directory: installRoot, trusted_keys: trustedKeys, ...extensions },
    skills: { enabled: false, directories: [] },
    mcp: { enabled: false, servers: {} },
    _source: { userPath: path.join(workspace, 'config.toml') },
  };
}

test('authenticated package update check exposes safe metadata and stages the verified version inactive', async (t) => {
  const workspace = await createTempDirectory('xyst-extension-update-api-');
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const installRoot = path.join(workspace, 'extensions');
  const pair = generateKeyPairSync('ed25519');
  const trustedKeys = { 'publisher-key': pair.publicKey.export({ type: 'spki', format: 'pem' }) };
  const baseTrust = { installRoot, trustedKeys };
  const oldPackage = path.join(workspace, 'old-package');
  await createSkillPackage(oldPackage, '1.0.0', pair.privateKey);
  await installSignedPackage(oldPackage, baseTrust);
  await activateInstalledSkill({ ...baseTrust, packageId: 'release-check', version: '1.0.0' });

  const candidateRoot = path.join(workspace, 'candidate-package');
  const candidate = await createSkillPackage(candidateRoot, '1.1.0', pair.privateKey);
  const candidateManifestDigest = createHash('sha256').update(candidate.bytes).digest('hex');
  const bundle = await createSignedPackageBundle(candidateRoot, { trustedKeys });
  const updateFeed = signedStatement(pair, {
    schema_version: 1,
    sequence: 1,
    issued_at: new Date(Date.now() - 1_000).toISOString(),
    expires_at: new Date(Date.now() + 120_000).toISOString(),
    key_id: 'publisher-key',
    packages: [
      {
        package_type: 'skill',
        package_id: 'release-check',
        version: '1.1.0',
        manifest_sha256: candidateManifestDigest,
        package_url: PACKAGE_URL,
      },
    ],
  });
  const requested = [];
  const server = new LocalControlServer({
    config: serverConfig(workspace, installRoot, trustedKeys, {
      update_feed_url: UPDATE_URL,
      update_key_id: 'publisher-key',
    }),
    workspaceRoot: workspace,
    token: TOKEN,
    fetchImpl: async (url, options) => {
      requested.push({ url: String(url), options });
      if (url === UPDATE_URL) return Response.json(updateFeed);
      if (url === PACKAGE_URL) return new Response(bundle, { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error(`Unexpected update request: ${url}`);
    },
  });
  const { url } = await server.start();
  t.after(() => server.close());
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

  const initial = await fetch(`${url}/v1/extensions/updates`, { headers });
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).status, 'update_check_required');
  assert.equal((await fetch(`${url}/v1/extensions/updates/check`, { method: 'POST', headers, body: '{}' })).status, 200);

  const available = await (await fetch(`${url}/v1/extensions/updates`, { headers })).json();
  assert.equal(available.status, 'ready');
  assert.deepEqual(available.updates, [
    { package_type: 'skill', package_id: 'release-check', version: '1.1.0', current_version: '1.0.0', staged: false },
  ]);
  assert.equal(JSON.stringify(available).includes(PACKAGE_URL), false);
  assert.equal(JSON.stringify(available).includes(candidateManifestDigest), false);
  assert.equal(requested[0].options.redirect, 'error');

  const stagedResponse = await fetch(`${url}/v1/extensions/updates/install`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ package_type: 'skill', package_id: 'release-check' }),
  });
  assert.equal(stagedResponse.status, 200);
  assert.deepEqual(await stagedResponse.json(), {
    package_type: 'skill',
    package_id: 'release-check',
    version: '1.1.0',
    staged: true,
    activated: false,
  });
  const afterStage = await (await fetch(`${url}/v1/extensions/updates`, { headers })).json();
  assert.equal(afterStage.updates[0].staged, true);
  const packageState = await (await fetch(`${url}/v1/skills/packages`, { headers })).json();
  assert.equal(packageState.packages[0].active_version, '1.0.0');
  assert.deepEqual(packageState.packages[0].available_versions, ['1.1.0', '1.0.0']);
  assert.equal(
    (
      await fetch(`${url}/v1/extensions/updates/install`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ package_type: 'skill', package_id: 'release-check' }),
      })
    ).status,
    409,
  );
  const updateAudit = (await fs.readFile(path.join(workspace, '.agent', 'audit', 'tool-events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(updateAudit.filter((entry) => entry.tool === 'check_package_updates' && entry.outcome === 'succeeded').length, 1);
  assert.equal(
    updateAudit.some((entry) => entry.tool === 'stage_package_update' && entry.outcome === 'succeeded'),
    true,
  );
  assert.equal(
    updateAudit.every((entry) => entry.policy_source === 'authenticated_user_api'),
    true,
  );
  assert.equal(JSON.stringify(updateAudit).includes(PACKAGE_URL), false);
  assert.equal(JSON.stringify(updateAudit).includes(candidateManifestDigest), false);
});

test('signed revocation refresh is explicit, audited, and reconfigures packages only when revocations change', async (t) => {
  const workspace = await createTempDirectory('xyst-extension-revocation-api-');
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const installRoot = path.join(workspace, 'extensions');
  const pair = generateKeyPairSync('ed25519');
  const trustedKeys = { 'publisher-key': pair.publicKey.export({ type: 'spki', format: 'pem' }) };
  const revocationFeed = signedStatement(pair, {
    schema_version: 1,
    sequence: 1,
    issued_at: new Date(Date.now() - 1_000).toISOString(),
    expires_at: new Date(Date.now() + 120_000).toISOString(),
    key_id: 'publisher-key',
    revoked_key_ids: ['retired-publisher'],
    revoked_packages: ['mcp:legacy-server@1.0.0'],
  });
  let fetches = 0;
  const server = new LocalControlServer({
    config: serverConfig(workspace, installRoot, trustedKeys, {
      revocation_url: 'https://updates.example.test/revocations.json',
      revocation_key_id: 'publisher-key',
    }),
    workspaceRoot: workspace,
    token: TOKEN,
    fetchImpl: async () => {
      fetches += 1;
      return Response.json(revocationFeed);
    },
  });
  const { url } = await server.start();
  t.after(() => server.close());
  let reconfigurations = 0;
  server.mcpManager.reconfigure = async () => {
    reconfigurations += 1;
  };
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

  server.mcpMutationActive = true;
  assert.equal(
    (
      await fetch(`${url}/v1/extensions/revocations/refresh`, {
        method: 'POST',
        headers,
        body: '{}',
      })
    ).status,
    409,
  );
  server.mcpMutationActive = false;
  assert.equal(fetches, 0);

  const first = await fetch(`${url}/v1/extensions/revocations/refresh`, { method: 'POST', headers, body: '{}' });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), {
    sequence: 1,
    expires_at: revocationFeed.expires_at,
    revoked_key_count: 1,
    revoked_package_count: 1,
    mcp_reconfigured: true,
  });
  assert.equal(reconfigurations, 1);
  assert.deepEqual(server.installedPackages.revokedKeyIds, ['retired-publisher']);

  const second = await fetch(`${url}/v1/extensions/revocations/refresh`, { method: 'POST', headers, body: '{}' });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).mcp_reconfigured, false);
  assert.equal(reconfigurations, 1);
  assert.equal(fetches, 2);
  const audit = (await fs.readFile(path.join(workspace, '.agent', 'audit', 'tool-events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(audit.filter((entry) => entry.tool === 'refresh_package_revocations' && entry.outcome === 'succeeded').length, 2);
  assert.equal(
    audit.every((entry) => entry.policy_source === 'authenticated_user_api'),
    true,
  );
});
