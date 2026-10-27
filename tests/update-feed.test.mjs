import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createTempDirectory } from './helpers.mjs';
import { canonicalJson, createSignedPackageBundle, signPackageManifest, verifySignedPackage } from '../src/extensions/signed-packages.mjs';
import {
  availablePackageUpdates,
  downloadAndInstallPackageUpdate,
  getCachedPackageUpdateFeed,
  getPackageUpdateCohortId,
  refreshPackageUpdateFeed,
} from '../src/extensions/update-feed.mjs';
import { getActiveInstalledPackages } from '../src/extensions/package-registry.mjs';

function signedFeed(pair, packages, sequence = 1) {
  const now = Date.now();
  const statement = {
    schema_version: 1,
    sequence,
    issued_at: new Date(now - 1000).toISOString(),
    expires_at: new Date(now + 60_000).toISOString(),
    key_id: 'updates-key',
    packages,
  };
  return { ...statement, signature: sign(null, Buffer.from(canonicalJson(statement)), pair.privateKey).toString('base64') };
}

function response(feed) {
  return new Response(JSON.stringify(feed), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('signed update metadata reports newer installed versions and authenticates the exact candidate manifest', async (t) => {
  const root = await createTempDirectory('xyst-updates-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pair = generateKeyPairSync('ed25519');
  const trustedKeys = { 'updates-key': pair.publicKey.export({ type: 'spki', format: 'pem' }) };
  const source = path.join(root, 'candidate');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: release-check\ndescription: Check releases\n---\nUpdated instructions.\n');
  const payload = await fs.readFile(path.join(source, 'SKILL.md'));
  const manifest = signPackageManifest({
    packageId: 'release-check',
    packageType: 'skill',
    version: '2.0.0',
    keyId: 'updates-key',
    privateKey: pair.privateKey,
    files: [{ path: 'SKILL.md', size: payload.length, sha256: createHash('sha256').update(payload).digest('hex') }],
  });
  const manifestText = JSON.stringify(manifest);
  await fs.writeFile(path.join(source, 'manifest.json'), manifestText);
  const verifiedPackage = await verifySignedPackage(source, { trustedKeys });
  const feed = signedFeed(pair, [
    {
      package_type: 'skill',
      package_id: 'release-check',
      version: '2.0.0',
      manifest_sha256: verifiedPackage.manifestSha256,
      package_url: 'https://packages.example.test/release-check-2.0.0',
    },
  ]);
  const options = {
    installRoot: path.join(root, 'installed'),
    url: 'https://updates.example.test/feed.json',
    keyId: 'updates-key',
    trustedKeys,
  };
  const updated = await refreshPackageUpdateFeed({ ...options, fetchImpl: async () => response(feed) });
  assert.equal(updated.sequence, 1);
  assert.deepEqual(availablePackageUpdates([{ package_type: 'skill', package_id: 'release-check', active_version: '1.9.0' }], updated), [
    { ...updated.packages[0], current_version: '1.9.0' },
  ]);
  assert.deepEqual(availablePackageUpdates([{ package_type: 'skill', package_id: 'release-check', active_version: '2.0.0' }], updated), []);
  assert.deepEqual(await getCachedPackageUpdateFeed(options), updated);
  assert.equal(verifiedPackage.manifestSha256, feed.packages[0].manifest_sha256);
});

test('signed staged rollouts assign stable cohorts and never offer unreleased packages early', async (t) => {
  const root = await createTempDirectory('xyst-update-rollout-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cohortId = await getPackageUpdateCohortId(root);
  assert.equal(await getPackageUpdateCohortId(root), cohortId);
  assert.match(cohortId, /^[0-9a-f-]{36}$/i);
  const corruptedRoot = await createTempDirectory('xyst-update-rollout-corrupt-');
  t.after(() => fs.rm(corruptedRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(corruptedRoot, 'update-cohort.json'), '{"schema_version":99,"id":"invalid"}\n');
  await assert.rejects(getPackageUpdateCohortId(corruptedRoot), { code: 'UPDATE_COHORT_INVALID' });

  const installed = [{ package_type: 'skill', package_id: 'release-check', active_version: '1.0.0' }];
  const staged = {
    packages: [
      {
        package_type: 'skill',
        package_id: 'release-check',
        version: '1.1.0',
        rollout_percentage: 0,
        rollout_salt: '2026-10-candidate-1',
      },
    ],
  };
  assert.deepEqual(availablePackageUpdates(installed, staged, { cohortId }), []);
  assert.throws(() => availablePackageUpdates(installed, staged), { code: 'UPDATE_COHORT_REQUIRED' });

  const rollout = { ...staged.packages[0], rollout_percentage: 40 };
  const updateFeed = { packages: [rollout] };
  assert.deepEqual(
    availablePackageUpdates(installed, updateFeed, { cohortId }),
    availablePackageUpdates(installed, updateFeed, { cohortId }),
  );
  let included = 0;
  for (let index = 0; index < 1000; index += 1) {
    if (availablePackageUpdates(installed, updateFeed, { cohortId: `cohort-${index}` }).length) included += 1;
  }
  assert.ok(included > 350 && included < 450, `Expected about 40% of cohorts in rollout, received ${included}/1000`);
  assert.equal(availablePackageUpdates(installed, { packages: [{ ...rollout, rollout_percentage: 100 }] }, { cohortId }).length, 1);
});

test('update metadata rejects untrusted signatures, expired feeds, and replayed sequence numbers', async (t) => {
  const root = await createTempDirectory('xyst-update-replay-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pair = generateKeyPairSync('ed25519');
  const trustedKeys = { 'updates-key': pair.publicKey.export({ type: 'spki', format: 'pem' }) };
  const options = { installRoot: root, url: 'https://updates.example.test/feed.json', keyId: 'updates-key', trustedKeys };
  const entry = {
    package_type: 'skill',
    package_id: 'release-check',
    version: '1.0.0',
    manifest_sha256: 'a'.repeat(64),
    package_url: 'https://packages.example.test/release-check',
  };
  const first = signedFeed(pair, [entry], 4);
  await assert.rejects(
    refreshPackageUpdateFeed({ ...options, fetchImpl: async () => response({ ...first, signature: Buffer.alloc(64).toString('base64') }) }),
    { code: 'UPDATE_FEED_SIGNATURE_INVALID' },
  );
  await assert.rejects(refreshPackageUpdateFeed({ ...options, revokedKeyIds: ['updates-key'], fetchImpl: async () => response(first) }), {
    code: 'UPDATE_FEED_KEY_REVOKED',
  });
  await refreshPackageUpdateFeed({ ...options, fetchImpl: async () => response(first) });
  const replay = signedFeed(pair, [entry], 3);
  await assert.rejects(refreshPackageUpdateFeed({ ...options, fetchImpl: async () => response(replay) }), { code: 'UPDATE_FEED_REPLAY' });
  await assert.rejects(getCachedPackageUpdateFeed({ ...options, now: Date.now() + 120_000 }), { code: 'UPDATE_FEED_EXPIRED' });
});

test('concurrent update-feed refreshes cannot let a late response roll the cache backwards', async (t) => {
  const root = await createTempDirectory('xyst-update-concurrent-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pair = generateKeyPairSync('ed25519');
  const trustedKeys = { 'updates-key': pair.publicKey.export({ type: 'spki', format: 'pem' }) };
  const options = { installRoot: root, url: 'https://updates.example.test/feed.json', keyId: 'updates-key', trustedKeys };
  const older = signedFeed(pair, [], 1);
  const newer = signedFeed(pair, [], 2);
  let resolveOlder;
  let resolveNewer;
  let started = 0;
  let releaseStarted;
  const bothStarted = new Promise((resolve) => (releaseStarted = resolve));
  const markStarted = () => {
    started += 1;
    if (started === 2) releaseStarted();
  };
  const olderFetch = () =>
    new Promise((resolve) => {
      resolveOlder = resolve;
      markStarted();
    });
  const newerFetch = () =>
    new Promise((resolve) => {
      resolveNewer = resolve;
      markStarted();
    });

  const olderRefresh = refreshPackageUpdateFeed({ ...options, fetchImpl: olderFetch });
  const newerRefresh = refreshPackageUpdateFeed({ ...options, fetchImpl: newerFetch });
  await bothStarted;
  resolveNewer(response(newer));
  assert.equal((await newerRefresh).sequence, 2);
  resolveOlder(response(older));
  await assert.rejects(olderRefresh, { code: 'UPDATE_FEED_REPLAY' });
  assert.equal((await getCachedPackageUpdateFeed(options)).sequence, 2);
});

test('signed update feed rejects malformed staged rollout metadata', async (t) => {
  const root = await createTempDirectory('xyst-update-rollout-invalid-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pair = generateKeyPairSync('ed25519');
  const trustedKeys = { 'updates-key': pair.publicKey.export({ type: 'spki', format: 'pem' }) };
  const options = { installRoot: root, url: 'https://updates.example.test/feed.json', keyId: 'updates-key', trustedKeys };
  const entry = {
    package_type: 'skill',
    package_id: 'release-check',
    version: '1.1.0',
    manifest_sha256: 'a'.repeat(64),
    package_url: 'https://packages.example.test/release-check',
    rollout_percentage: 101,
    rollout_salt: 'release-1',
  };
  await assert.rejects(refreshPackageUpdateFeed({ ...options, fetchImpl: async () => response(signedFeed(pair, [entry])) }), {
    code: 'UPDATE_FEED_INVALID',
  });
  const missingSalt = { ...entry, rollout_percentage: 50 };
  delete missingSalt.rollout_salt;
  await assert.rejects(refreshPackageUpdateFeed({ ...options, fetchImpl: async () => response(signedFeed(pair, [missingSalt])) }), {
    code: 'UPDATE_FEED_INVALID',
  });
});

test('update download verifies the package in memory before staging it inactive', async (t) => {
  const root = await createTempDirectory('xyst-update-download-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'source');
  await fs.mkdir(packageRoot);
  const payload = Buffer.from('---\nname: release-check\ndescription: Check releases\n---\nDownloaded, verified, inactive.\n');
  await fs.writeFile(path.join(packageRoot, 'SKILL.md'), payload);
  const metadata = Buffer.from('verified release metadata\n');
  await fs.writeFile(path.join(packageRoot, 'metadata.txt'), metadata);
  const pair = generateKeyPairSync('ed25519');
  const trustedKeys = { publisher: pair.publicKey.export({ type: 'spki', format: 'pem' }) };
  const manifest = signPackageManifest({
    packageId: 'release-check',
    packageType: 'skill',
    version: '3.0.0',
    keyId: 'publisher',
    privateKey: pair.privateKey,
    files: [
      { path: 'SKILL.md', size: payload.byteLength, sha256: createHash('sha256').update(payload).digest('hex') },
      { path: 'metadata.txt', size: metadata.byteLength, sha256: createHash('sha256').update(metadata).digest('hex') },
    ],
  });
  await fs.writeFile(path.join(packageRoot, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  const bundle = await createSignedPackageBundle(packageRoot, { trustedKeys });
  const manifestSha256 = createHash('sha256')
    .update(`${JSON.stringify(manifest)}\n`)
    .digest('hex');
  const release = {
    package_type: 'skill',
    package_id: 'release-check',
    version: '3.0.0',
    manifest_sha256: manifestSha256,
    package_url: 'https://packages.example.test/release-check-3.0.0',
  };
  const installRoot = path.join(root, 'installed');
  let fetchOptions;
  const fetchImpl = async (_url, options) => {
    fetchOptions = options;
    return new Response(bundle, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const tampered = JSON.parse(bundle.toString('utf8'));
  const tamperedSkill = tampered.files.find((file) => file.path === 'SKILL.md');
  tamperedSkill.content_base64 = Buffer.alloc(payload.byteLength, 0x78).toString('base64');
  await assert.rejects(
    downloadAndInstallPackageUpdate({
      release,
      installRoot,
      trustedKeys,
      feedExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      fetchImpl: async () => new Response(JSON.stringify(tampered)),
    }),
    { code: 'PACKAGE_FILE_DIGEST_INVALID' },
  );
  await assert.rejects(
    downloadAndInstallPackageUpdate({
      release: { ...release, manifest_sha256: '0'.repeat(64) },
      installRoot,
      trustedKeys,
      feedExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      fetchImpl,
    }),
    { code: 'PACKAGE_UPDATE_DIGEST_MISMATCH' },
  );
  const installed = await downloadAndInstallPackageUpdate({
    release,
    installRoot,
    trustedKeys,
    feedExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    fetchImpl,
  });
  assert.equal(fetchOptions.redirect, 'error');
  assert.equal(installed.enabled, false);
  assert.equal(installed.activated, false);
  assert.equal(await fs.readFile(path.join(installed.path, 'SKILL.md'), 'utf8'), payload.toString());
  assert.equal(await fs.readFile(path.join(installed.path, 'metadata.txt'), 'utf8'), metadata.toString());
  assert.deepEqual(await getActiveInstalledPackages({ installRoot, trustedKeys }), []);
});
