import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  installSignedPackage,
  packageKeyFingerprint,
  signPackageManifest,
  verifySignedPackage,
  canonicalJson,
} from '../src/extensions/signed-packages.mjs';
import { refreshRevocationFeed } from '../src/extensions/revocation-feed.mjs';
import {
  activateInstalledMcpPackage,
  activateInstalledSkill,
  disableInstalledMcpPackage,
  disableInstalledSkill,
  getActiveInstalledPackages,
  getActiveInstalledMcpPackages,
  listInstalledPackageActivations,
  listInstalledSkillVersions,
  rollbackInstalledMcpPackage,
  rollbackInstalledSkill,
} from '../src/extensions/package-registry.mjs';
import { SkillLibrary } from '../src/tools/skills.mjs';
import { AgentRuntime } from '../src/core/agent.mjs';
import { createTempDirectory } from './helpers.mjs';

async function signedFixture(
  t,
  { packageType = 'skill', version = '1.2.3', files = { 'SKILL.md': '# Release check\n' }, keyPair = null, capabilities, entryPoint } = {},
) {
  const root = await createTempDirectory('xyst-signed-package-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const bytesByPath = new Map(Object.entries(files).map(([name, content]) => [name, Buffer.from(content)]));
  await fs.mkdir(source);
  for (const [name, bytes] of bytesByPath) {
    const target = path.join(source, ...name.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }
  const { publicKey, privateKey } = keyPair || generateKeyPairSync('ed25519');
  const keyId = 'test-key';
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const manifest = signPackageManifest({
    packageId: 'release-check',
    packageType,
    version,
    keyId,
    privateKey,
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(entryPoint === undefined ? {} : { entryPoint }),
    files: [...bytesByPath].map(([filePath, bytes]) => ({
      path: filePath,
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })),
  });
  await fs.writeFile(path.join(source, 'manifest.json'), JSON.stringify(manifest));
  return { root, source, publicKeyPem, manifest, bytesByPath };
}

test('signed package verifies Ed25519 trust, canonical metadata, and every declared file', async (t) => {
  const fixture = await signedFixture(t);
  const verified = await verifySignedPackage(fixture.source, { trustedKeys: { 'test-key': fixture.publicKeyPem } });
  assert.equal(verified.packageRevision, 'skill:release-check@1.2.3');
  assert.equal(verified.totalBytes, Buffer.byteLength('# Release check\n'));
  assert.deepEqual(verified.files.get('SKILL.md'), Buffer.from('# Release check\n'));
  assert.equal(packageKeyFingerprint(fixture.publicKeyPem).length, 64);
  assert.equal(Object.hasOwn(fixture.manifest, 'capabilities'), false, 'legacy v1 packages remain valid without capability metadata');
});

test('signed package authenticates normalized capability declarations without treating them as grants', async (t) => {
  const fixture = await signedFixture(t, {
    packageType: 'mcp',
    files: { 'server/package.json': '{"name":"fixture"}\n' },
    capabilities: [
      { name: 'desktop.control', scope: 'interactive-session', reason: 'Access the active desktop when requested' },
      { name: 'filesystem.write', scope: 'machine', reason: 'Create configured release reports' },
      { name: 'mcp.prompts', scope: 'configured-server', reason: 'Read prompts from the configured server' },
      { name: 'mcp.resources', scope: 'configured-server', reason: 'Read resources from the configured server' },
      { name: 'mcp.tools', scope: 'configured-server', reason: 'Call tools from the configured server' },
      { name: 'network.connect', scope: 'https://releases.example.invalid', reason: 'Check release metadata' },
      { name: 'filesystem.read', scope: 'workspace', reason: 'Read local release metadata' },
      { name: 'process.execute', scope: 'configured', reason: 'Run the configured server process' },
      { name: 'secrets.use', scope: 'configured-reference', reason: 'Use configured authentication references' },
    ],
  });
  const verified = await verifySignedPackage(fixture.source, { trustedKeys: { 'test-key': fixture.publicKeyPem } });
  assert.equal(verified.manifest.capability_schema, 1);
  assert.deepEqual(verified.manifest.capabilities, [
    { name: 'desktop.control', scope: 'interactive-session', reason: 'Access the active desktop when requested' },
    { name: 'filesystem.read', scope: 'workspace', reason: 'Read local release metadata' },
    { name: 'filesystem.write', scope: 'machine', reason: 'Create configured release reports' },
    { name: 'mcp.prompts', scope: 'configured-server', reason: 'Read prompts from the configured server' },
    { name: 'mcp.resources', scope: 'configured-server', reason: 'Read resources from the configured server' },
    { name: 'mcp.tools', scope: 'configured-server', reason: 'Call tools from the configured server' },
    { name: 'network.connect', scope: 'https://releases.example.invalid', reason: 'Check release metadata' },
    { name: 'process.execute', scope: 'configured', reason: 'Run the configured server process' },
    { name: 'secrets.use', scope: 'configured-reference', reason: 'Use configured authentication references' },
  ]);

  const tampered = {
    ...fixture.manifest,
    capabilities: fixture.manifest.capabilities.map((capability) =>
      capability.name === 'network.connect' ? { ...capability, scope: 'https://attacker.example.invalid' } : capability,
    ),
  };
  await fs.writeFile(path.join(fixture.source, 'manifest.json'), JSON.stringify(tampered));
  await assert.rejects(verifySignedPackage(fixture.source, { trustedKeys: { 'test-key': fixture.publicKeyPem } }), {
    code: 'PACKAGE_SIGNATURE_INVALID',
  });
});

test('signed package capability declarations reject unknown, duplicate, broad, malformed, and type-incompatible entries', () => {
  const keyPair = generateKeyPairSync('ed25519');
  const common = {
    packageId: 'fixture-server',
    packageType: 'mcp',
    version: '1.0.0',
    keyId: 'test-key',
    privateKey: keyPair.privateKey,
    files: [{ path: 'server.js', size: 1, sha256: 'a'.repeat(64) }],
  };
  const capability = (name, scope) => ({ name, scope, reason: 'Required for the declared integration' });
  assert.throws(() => signPackageManifest({ ...common, capabilities: [capability('unknown.capability', 'workspace')] }), {
    code: 'PACKAGE_CAPABILITY_INVALID',
  });
  assert.throws(() => signPackageManifest({ ...common, capabilities: [capability('filesystem.read', '*')] }), {
    code: 'PACKAGE_CAPABILITY_SCOPE_INVALID',
  });
  assert.throws(
    () =>
      signPackageManifest({
        ...common,
        capabilities: [{ ...capability('filesystem.read', 'workspace'), reason: 'Read\u202e workspace' }],
      }),
    { code: 'PACKAGE_CAPABILITY_INVALID' },
  );
  assert.throws(() => signPackageManifest({ ...common, capabilities: [capability('network.connect', 'https://example.invalid/path')] }), {
    code: 'PACKAGE_CAPABILITY_SCOPE_INVALID',
  });
  assert.throws(
    () =>
      signPackageManifest({
        ...common,
        capabilities: [capability('filesystem.read', 'workspace'), capability('filesystem.read', 'workspace')],
      }),
    { code: 'PACKAGE_CAPABILITY_INVALID' },
  );
  assert.throws(() => signPackageManifest({ ...common, capabilities: [capability('network.connect', 'http://192.0.2.1')] }), {
    code: 'PACKAGE_CAPABILITY_SCOPE_INVALID',
  });
  assert.throws(
    () =>
      signPackageManifest({
        ...common,
        packageType: 'skill',
        packageId: 'fixture-skill',
        capabilities: [capability('process.execute', 'configured')],
      }),
    { code: 'PACKAGE_CAPABILITY_INVALID' },
  );
  assert.throws(
    () => signPackageManifest({ ...common, capabilities: Array.from({ length: 33 }, () => capability('filesystem.read', 'workspace')) }),
    { code: 'PACKAGE_CAPABILITY_INVALID' },
  );
  assert.doesNotThrow(
    () => signPackageManifest({ ...common, capabilities: [capability('network.connect', 'http://127.0.0.1:1234')] }),
    'Loopback HTTP is valid for local integrations',
  );
});

test('signed MCP entry point is authenticated, included in the payload, and requires process execution declaration', async (t) => {
  const capabilities = [{ name: 'process.execute', scope: 'configured', reason: 'Run this configured MCP server' }];
  const fixture = await signedFixture(t, {
    packageType: 'mcp',
    files: { 'server/index.mjs': 'export {}\n', 'server/alternate.mjs': 'export const alternate = true\n' },
    capabilities,
    entryPoint: 'server/index.mjs',
  });
  const verified = await verifySignedPackage(fixture.source, { trustedKeys: { 'test-key': fixture.publicKeyPem } });
  assert.equal(verified.manifest.entry_point, 'server/index.mjs');
  assert.equal(verified.files.get('server/index.mjs').toString(), 'export {}\n');

  const tampered = { ...fixture.manifest, entry_point: 'server/alternate.mjs' };
  await fs.writeFile(path.join(fixture.source, 'manifest.json'), JSON.stringify(tampered));
  await assert.rejects(verifySignedPackage(fixture.source, { trustedKeys: { 'test-key': fixture.publicKeyPem } }), {
    code: 'PACKAGE_SIGNATURE_INVALID',
  });

  const keyPair = generateKeyPairSync('ed25519');
  const common = {
    packageId: 'fixture-server',
    packageType: 'mcp',
    version: '1.0.0',
    keyId: 'test-key',
    privateKey: keyPair.privateKey,
    files: [{ path: 'server.mjs', size: 1, sha256: 'a'.repeat(64) }],
    entryPoint: 'server.mjs',
  };
  assert.throws(() => signPackageManifest(common), { code: 'PACKAGE_MANIFEST_INVALID' });
  assert.throws(() => signPackageManifest({ ...common, capabilities: [] }), { code: 'PACKAGE_CAPABILITY_INVALID' });
  assert.throws(
    () =>
      signPackageManifest({
        ...common,
        entryPoint: '../server.mjs',
        capabilities,
      }),
    { code: 'PACKAGE_ENTRY_POINT_INVALID' },
  );
});

test('signed package rejects partial or unsupported capability schema declarations', async (t) => {
  const fixture = await signedFixture(t, {
    packageType: 'mcp',
    files: { 'server.js': 'module.exports = {};\n' },
    capabilities: [],
  });
  const partial = { ...fixture.manifest };
  delete partial.capability_schema;
  await fs.writeFile(path.join(fixture.source, 'manifest.json'), JSON.stringify(partial));
  await assert.rejects(verifySignedPackage(fixture.source, { trustedKeys: { 'test-key': fixture.publicKeyPem } }), {
    code: 'PACKAGE_MANIFEST_INVALID',
  });

  const unsupported = { ...fixture.manifest, capability_schema: 2 };
  await fs.writeFile(path.join(fixture.source, 'manifest.json'), JSON.stringify(unsupported));
  await assert.rejects(verifySignedPackage(fixture.source, { trustedKeys: { 'test-key': fixture.publicKeyPem } }), {
    code: 'PACKAGE_CAPABILITY_SCHEMA_UNSUPPORTED',
  });
});

test('signed package rejects untrusted or revoked signers and package revisions', async (t) => {
  const fixture = await signedFixture(t);
  await assert.rejects(verifySignedPackage(fixture.source, { trustedKeys: {} }), { code: 'PACKAGE_KEY_UNTRUSTED' });
  const privatePair = generateKeyPairSync('ed25519');
  await assert.rejects(
    verifySignedPackage(fixture.source, {
      trustedKeys: { 'test-key': privatePair.privateKey.export({ type: 'pkcs8', format: 'pem' }) },
    }),
    { code: 'PACKAGE_TRUST_KEY_INVALID' },
  );
  await assert.rejects(
    verifySignedPackage(fixture.source, { trustedKeys: { 'test-key': fixture.publicKeyPem }, revokedKeyIds: ['test-key'] }),
    { code: 'PACKAGE_KEY_REVOKED' },
  );
  await assert.rejects(
    verifySignedPackage(fixture.source, {
      trustedKeys: { 'test-key': fixture.publicKeyPem },
      revokedPackages: ['skill:release-check@1.2.3'],
    }),
    { code: 'PACKAGE_REVOKED' },
  );
});

test('signed package rejects tampered, undeclared, and malformed package entries', async (t) => {
  const fixture = await signedFixture(t);
  await fs.writeFile(path.join(fixture.source, 'SKILL.md'), 'tampered');
  await assert.rejects(verifySignedPackage(fixture.source, { trustedKeys: { 'test-key': fixture.publicKeyPem } }), {
    code: 'PACKAGE_FILE_SIZE_INVALID',
  });

  const extra = await signedFixture(t);
  await fs.writeFile(path.join(extra.source, 'extra.txt'), 'not signed');
  await assert.rejects(verifySignedPackage(extra.source, { trustedKeys: { 'test-key': extra.publicKeyPem } }), {
    code: 'PACKAGE_FILE_SET_INVALID',
  });

  const metadata = await signedFixture(t);
  const changedManifest = { ...metadata.manifest, version: '1.2.4' };
  await fs.writeFile(path.join(metadata.source, 'manifest.json'), JSON.stringify(changedManifest));
  await assert.rejects(verifySignedPackage(metadata.source, { trustedKeys: { 'test-key': metadata.publicKeyPem } }), {
    code: 'PACKAGE_SIGNATURE_INVALID',
  });

  assert.throws(
    () =>
      signPackageManifest({
        packageId: 'release-check',
        packageType: 'skill',
        version: '1.2.3',
        keyId: 'test-key',
        privateKey: generateKeyPairSync('ed25519').privateKey,
        files: [{ path: '../escape', size: 0, sha256: '0'.repeat(64) }],
      }),
    { code: 'PACKAGE_PATH_INVALID' },
  );
  assert.throws(
    () =>
      signPackageManifest({
        packageId: 'release-check',
        packageType: 'skill',
        version: '1.2.3',
        keyId: 'test-key',
        privateKey: generateKeyPairSync('ed25519').privateKey,
        files: [
          { path: 'Readme.md', size: 0, sha256: '0'.repeat(64) },
          { path: 'README.md', size: 0, sha256: '0'.repeat(64) },
        ],
      }),
    { code: 'PACKAGE_PATH_INVALID' },
  );
  assert.throws(
    () =>
      signPackageManifest({
        packageId: 'release-check',
        packageType: 'skill',
        version: '1.2.3',
        keyId: 'test-key',
        privateKey: generateKeyPairSync('ed25519').privateKey,
        files: [{ path: 'CON.txt', size: 0, sha256: '0'.repeat(64) }],
      }),
    { code: 'PACKAGE_PATH_INVALID' },
  );
  assert.throws(
    () =>
      signPackageManifest({
        packageId: 'release-check',
        packageType: 'skill',
        version: '1.2.3-..',
        keyId: 'test-key',
        privateKey: generateKeyPairSync('ed25519').privateKey,
        files: [{ path: 'SKILL.md', size: 0, sha256: '0'.repeat(64) }],
      }),
    { code: 'PACKAGE_MANIFEST_INVALID' },
  );
});

test('installer stages verified bytes into a version-pinned path without enabling the package', async (t) => {
  const fixture = await signedFixture(t, { packageType: 'mcp', files: { 'server/package.json': '{"name":"fixture"}\n' } });
  const installRoot = path.join(fixture.root, 'installed');
  const options = { installRoot, trustedKeys: { 'test-key': fixture.publicKeyPem }, retainFiles: false };
  const installed = await installSignedPackage(fixture.source, options);
  assert.equal(installed.package_id, 'release-check');
  assert.equal(installed.package_type, 'mcp');
  assert.equal(installed.version, '1.2.3');
  assert.equal(installed.enabled, false);
  assert.equal(await fs.readFile(path.join(installed.path, 'server/package.json'), 'utf8'), '{"name":"fixture"}\n');
  assert.deepEqual((await fs.readdir(installRoot)).sort(), ['mcp']);
  await assert.rejects(installSignedPackage(fixture.source, options), { code: 'PACKAGE_VERSION_EXISTS' });
});

test('signed MCP package requires explicit activation and is reverified until disabled', async (t) => {
  const capability = { name: 'process.execute', scope: 'configured', reason: 'Run the configured signed server' };
  const keyPair = generateKeyPairSync('ed25519');
  const fixture = await signedFixture(t, {
    packageType: 'mcp',
    files: { 'server.mjs': 'export {};\n' },
    keyPair,
    capabilities: [capability],
    entryPoint: 'server.mjs',
  });
  const installRoot = path.join(fixture.root, 'installed');
  const trust = { installRoot, trustedKeys: { 'test-key': fixture.publicKeyPem } };
  await installSignedPackage(fixture.source, trust);
  assert.deepEqual(await getActiveInstalledMcpPackages(trust), []);
  const activation = await activateInstalledMcpPackage({ ...trust, packageId: 'release-check', version: '1.2.3' });
  assert.equal(activation.active_version, '1.2.3');
  const nextVersion = await signedFixture(t, {
    packageType: 'mcp',
    version: '1.2.4',
    files: { 'server.mjs': 'export const next = true;\n' },
    keyPair,
    capabilities: [capability],
    entryPoint: 'server.mjs',
  });
  await installSignedPackage(nextVersion.source, trust);
  await activateInstalledMcpPackage({ ...trust, packageId: 'release-check', version: '1.2.4' });
  assert.equal((await rollbackInstalledMcpPackage({ ...trust, packageId: 'release-check' })).active_version, '1.2.3');
  const active = await getActiveInstalledMcpPackages(trust);
  assert.equal(active.length, 1);
  assert.equal(active[0].manifest.entry_point, 'server.mjs');
  assert.equal(active[0].files.get('server.mjs').toString(), 'export {};\n');
  await assert.rejects(getActiveInstalledMcpPackages({ ...trust, revokedKeyIds: ['test-key'] }), { code: 'PACKAGE_KEY_REVOKED' });
  await assert.rejects(getActiveInstalledMcpPackages({ ...trust, revokedPackages: ['mcp:release-check@1.2.3'] }), {
    code: 'PACKAGE_REVOKED',
  });
  await fs.writeFile(path.join(active[0].path, 'server.mjs'), 'export const changed = true;\n');
  await assert.rejects(getActiveInstalledMcpPackages(trust), { code: 'PACKAGE_FILE_SIZE_INVALID' });
  await fs.writeFile(path.join(active[0].path, 'server.mjs'), 'export {};\n');
  assert.equal((await disableInstalledMcpPackage({ installRoot, packageId: 'release-check' })).active_version, null);
  assert.deepEqual(await getActiveInstalledMcpPackages(trust), []);
});

test('signed skills activate by exact version, roll back, disable, and load through the untrusted skill boundary', async (t) => {
  const contentV1 = '---\nname: release-check\ndescription: Check a release\n---\nUse the first verified procedure.\n';
  const contentV2 = '---\nname: release-check\ndescription: Check a release\n---\nUse the second verified procedure.\n';
  const pair = generateKeyPairSync('ed25519');
  const first = await signedFixture(t, { files: { 'SKILL.md': contentV1 }, keyPair: pair });
  const second = await signedFixture(t, { version: '1.2.4', files: { 'SKILL.md': contentV2 }, keyPair: pair });
  const installRoot = path.join(first.root, 'installed');
  const trustedKeys = { 'test-key': first.publicKeyPem };
  await installSignedPackage(first.source, { installRoot, trustedKeys });
  await installSignedPackage(second.source, { installRoot, trustedKeys });
  assert.deepEqual(await listInstalledSkillVersions({ installRoot }), [
    { package_id: 'release-check', available_versions: ['1.2.4', '1.2.3'] },
  ]);
  const coordinates = { installRoot, packageId: 'release-check', trustedKeys };
  assert.deepEqual(await activateInstalledSkill({ ...coordinates, version: '1.2.3' }), {
    changed: true,
    active_version: '1.2.3',
    package_revision: 'skill:release-check@1.2.3',
  });
  const library = new SkillLibrary({ workspaceRoot: first.root, installedPackages: { installRoot, trustedKeys } });
  assert.equal((await library.load('release-check')).content, 'Use the first verified procedure.');
  assert.equal((await library.load('release-check')).source, 'release-check');
  const runtime = new AgentRuntime({
    config: {
      _source: { userPath: path.join(first.root, 'config.toml') },
      extensions: { install_directory: installRoot, trusted_keys: trustedKeys },
    },
    workspaceRoot: first.root,
    stateRoot: first.root,
  });
  try {
    await runtime.processManagerReady;
    assert.equal((await runtime.skillLibrary.load('release-check')).content, 'Use the first verified procedure.');
  } finally {
    await runtime.close();
  }
  await activateInstalledSkill({ ...coordinates, version: '1.2.4' });
  assert.equal((await library.load('release-check')).content, 'Use the second verified procedure.');
  assert.deepEqual(await listInstalledPackageActivations({ installRoot }), [
    {
      package_type: 'skill',
      package_id: 'release-check',
      active_version: '1.2.4',
      previous_versions: ['1.2.3'],
    },
  ]);
  const rolledBack = await rollbackInstalledSkill(coordinates);
  assert.equal(rolledBack.active_version, '1.2.3');
  assert.equal((await library.load('release-check')).content, 'Use the first verified procedure.');
  const feedStatement = {
    schema_version: 1,
    sequence: 1,
    issued_at: new Date(Date.now() - 1000).toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    revoked_key_ids: ['test-key'],
    revoked_packages: [],
    key_id: 'test-key',
  };
  const feed = {
    ...feedStatement,
    signature: sign(null, Buffer.from(canonicalJson(feedStatement)), pair.privateKey).toString('base64'),
  };
  await refreshRevocationFeed({
    installRoot,
    url: 'https://example.test/revocations.json',
    keyId: 'test-key',
    trustedKeys,
    fetchImpl: async () => new Response(JSON.stringify(feed)),
  });
  await assert.rejects(
    getActiveInstalledPackages({
      installRoot,
      trustedKeys,
      revocationUrl: 'https://example.test/revocations.json',
      revocationKeyId: 'test-key',
    }),
    { code: 'PACKAGE_KEY_REVOKED' },
  );
  await assert.rejects(getActiveInstalledPackages({ installRoot, trustedKeys, revokedPackages: ['skill:release-check@1.2.3'] }), {
    code: 'PACKAGE_REVOKED',
  });
  assert.deepEqual(await disableInstalledSkill(coordinates), { changed: true, active_version: null });
  assert.deepEqual(await getActiveInstalledPackages({ installRoot, trustedKeys }), []);
  assert.deepEqual(await listInstalledPackageActivations({ installRoot }), [
    { package_type: 'skill', package_id: 'release-check', active_version: null, previous_versions: ['1.2.3', '1.2.4'] },
  ]);
  await activateInstalledSkill({ ...coordinates, version: '1.2.3' });
  assert.equal((await library.load('release-check')).content, 'Use the first verified procedure.');
});

test('runtime installed skill discovery treats an absent package store as empty', async (t) => {
  const root = await createTempDirectory('xyst-empty-package-store-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.deepEqual(await getActiveInstalledPackages({ installRoot: path.join(root, 'extensions'), trustedKeys: {} }), []);
});

test('package registry mutation restores an interrupted registry before applying the next change', async (t) => {
  const fixture = await signedFixture(t);
  const installRoot = path.join(fixture.root, 'installed');
  const trustedKeys = { 'test-key': fixture.publicKeyPem };
  await installSignedPackage(fixture.source, { installRoot, trustedKeys });
  const coordinates = { installRoot, packageId: 'release-check', version: '1.2.3', trustedKeys };
  await activateInstalledSkill(coordinates);
  const registryPath = path.join(installRoot, 'registry.json');
  const backupPath = `${registryPath}.00000000-0000-4000-8000-000000000001.bak`;
  await fs.rename(registryPath, backupPath);
  await assert.rejects(listInstalledPackageActivations({ installRoot }), { code: 'PACKAGE_REGISTRY_RECOVERY_REQUIRED' });
  assert.deepEqual(await disableInstalledSkill({ installRoot, packageId: 'release-check' }), { changed: true, active_version: null });
  assert.deepEqual(await listInstalledPackageActivations({ installRoot }), [
    { package_type: 'skill', package_id: 'release-check', active_version: null, previous_versions: ['1.2.3'] },
  ]);
  await assert.rejects(fs.stat(backupPath), { code: 'ENOENT' });
});
