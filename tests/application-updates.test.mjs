import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  APPLICATION_VERSION,
  checkApplicationUpdates,
  downloadApplicationUpdate,
  verifyApplicationUpdateFeed,
} from '../src/platform/application-updates.mjs';
import { canonicalJson } from '../src/extensions/signed-packages.mjs';
import { createTempDirectory } from './helpers.mjs';

const NOW = Date.parse('2026-10-21T18:00:00.000Z');
const execFile = promisify(execFileCallback);

function signedFeed({
  platform = 'win32',
  arch = 'x64',
  version = '0.2.0',
  channel = 'stable',
  sequence = 7,
  notes = 'Bug fixes and reliability improvements.',
  expiresAt = NOW + 60 * 60_000,
} = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const statement = {
    schema_version: 1,
    sequence,
    key_id: 'xyst-release-2026',
    channel,
    issued_at: new Date(NOW - 1000).toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
    releases: [
      {
        platform,
        arch,
        channel,
        version,
        published_at: new Date(NOW - 2000).toISOString(),
        download_url: 'https://releases.example.test/xyst-setup.exe',
        sha256: 'a'.repeat(64),
        size_bytes: 1024,
        notes,
      },
    ],
  };
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKey,
    feed: { ...statement, signature: sign(null, Buffer.from(canonicalJson(statement)), privateKey).toString('base64') },
  };
}

function settings(publicKey, overrides = {}) {
  return {
    mode: 'manual',
    channel: 'stable',
    feed_url: 'https://updates.example.test/releases.json',
    key_id: 'xyst-release-2026',
    public_key: publicKey,
    ...overrides,
  };
}

test('application update check selects a newer release for the current host and verifies its signed metadata', async () => {
  const { publicKey, feed } = signedFeed();
  const result = await checkApplicationUpdates({
    settings: settings(publicKey),
    currentVersion: '0.1.0',
    platform: 'win32',
    arch: 'x64',
    now: NOW,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://updates.example.test/releases.json');
      assert.equal(options.redirect, 'error');
      return Response.json(feed);
    },
  });
  assert.equal(result.update_available, true);
  assert.equal(result.current_version, '0.1.0');
  assert.equal(result.release.version, '0.2.0');
  assert.equal(result.release.sha256, 'a'.repeat(64));
  assert.equal(result.sequence, 7);
});

test('application update download rechecks the signed release and stages only matching bytes', async (t) => {
  const stagingDirectory = await createTempDirectory('xyst-app-update-staging-');
  t.after(() => fs.rm(stagingDirectory, { recursive: true, force: true }));
  const payload = Buffer.from('signed installer fixture');
  const { publicKey, privateKey, feed: originalFeed } = signedFeed();
  const statement = structuredClone(originalFeed);
  delete statement.signature;
  statement.releases[0].sha256 = createHash('sha256').update(payload).digest('hex');
  statement.releases[0].size_bytes = payload.byteLength;
  const feed = { ...statement, signature: sign(null, Buffer.from(canonicalJson(statement)), privateKey).toString('base64') };
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url) === 'https://updates.example.test/releases.json') return Response.json(feed);
    return new Response(payload, { headers: { 'content-length': String(payload.byteLength) } });
  };
  const handleProbe = await fs.open(stagingDirectory, 'r');
  const fileHandlePrototype = Object.getPrototypeOf(handleProbe);
  await handleProbe.close();
  const sync = fileHandlePrototype.sync;
  const write = fileHandlePrototype.write;
  let syncCalls = 0;
  let writeCalls = 0;
  fileHandlePrototype.sync = function (...args) {
    syncCalls += 1;
    return sync.apply(this, args);
  };
  fileHandlePrototype.write = function (buffer, offset, length) {
    writeCalls += 1;
    return write.call(this, buffer, offset, Math.min(length, 5));
  };
  let staged;
  try {
    staged = await downloadApplicationUpdate({
      settings: settings(publicKey),
      version: '0.2.0',
      sequence: 7,
      currentVersion: '0.1.0',
      platform: 'win32',
      arch: 'x64',
      fetchImpl,
      stagingDirectory,
      now: NOW,
    });
  } finally {
    fileHandlePrototype.sync = sync;
    fileHandlePrototype.write = write;
  }
  assert.equal(syncCalls, 1, 'verified staged artifact is flushed before returning');
  assert.ok(writeCalls > 1, 'staging handles partial writes until the entire chunk is persisted');
  assert.equal(staged.size_bytes, payload.byteLength);
  assert.equal(staged.sha256, createHash('sha256').update(payload).digest('hex'));
  assert.equal(await fs.readFile(staged.path, 'utf8'), payload.toString());
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, feed.releases[0].download_url);
  assert.equal(requests[1].options.redirect, 'error');
  assert.equal(staged.filename, 'xyst-setup.exe');
});

test('application update download rejects and removes an artifact path swapped after writing', async (t) => {
  const stagingDirectory = await createTempDirectory('xyst-app-update-path-swap-');
  t.after(() => fs.rm(stagingDirectory, { recursive: true, force: true }));
  const payload = Buffer.from('signed installer fixture');
  const { publicKey, privateKey, feed: originalFeed } = signedFeed();
  const statement = structuredClone(originalFeed);
  delete statement.signature;
  statement.releases[0].sha256 = createHash('sha256').update(payload).digest('hex');
  statement.releases[0].size_bytes = payload.byteLength;
  const feed = { ...statement, signature: sign(null, Buffer.from(canonicalJson(statement)), privateKey).toString('base64') };
  const fetchImpl = async (url) =>
    String(url) === 'https://updates.example.test/releases.json'
      ? Response.json(feed)
      : new Response(payload, { headers: { 'content-length': String(payload.byteLength) } });
  const lstat = fs.lstat;
  let displacedPath;
  fs.lstat = async function (target, ...args) {
    if (typeof target === 'string' && target.endsWith('.download') && !displacedPath) {
      displacedPath = `${target}.displaced`;
      await fs.rename(target, displacedPath);
      await fs.writeFile(target, 'replacement', { flag: 'wx', mode: 0o600 });
    }
    return lstat.call(this, target, ...args);
  };
  try {
    await assert.rejects(
      downloadApplicationUpdate({
        settings: settings(publicKey),
        version: '0.2.0',
        sequence: 7,
        currentVersion: '0.1.0',
        platform: 'win32',
        arch: 'x64',
        fetchImpl,
        stagingDirectory,
        now: NOW,
      }),
      { code: 'APP_UPDATE_STAGING_INVALID' },
    );
  } finally {
    fs.lstat = lstat;
  }
  assert.ok(displacedPath, 'the staging path was swapped before identity verification');
  assert.deepEqual(await fs.readdir(stagingDirectory), [path.basename(displacedPath)]);
  assert.equal(await fs.readFile(displacedPath, 'utf8'), payload.toString());
});

test('application update cancellation removes an incomplete staged artifact', async (t) => {
  const stagingDirectory = await createTempDirectory('xyst-app-update-cancel-');
  t.after(() => fs.rm(stagingDirectory, { recursive: true, force: true }));
  const payload = Buffer.from('signed installer fixture');
  const { publicKey, privateKey, feed: originalFeed } = signedFeed();
  const statement = structuredClone(originalFeed);
  delete statement.signature;
  statement.releases[0].sha256 = createHash('sha256').update(payload).digest('hex');
  statement.releases[0].size_bytes = payload.byteLength;
  const feed = { ...statement, signature: sign(null, Buffer.from(canonicalJson(statement)), privateKey).toString('base64') };
  let signalFirstChunk;
  const firstChunk = new Promise((resolve) => {
    signalFirstChunk = resolve;
  });
  const fetchImpl = async (url, options) => {
    if (String(url) === 'https://updates.example.test/releases.json') return Response.json(feed);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(payload.subarray(0, 5));
          signalFirstChunk();
        },
        pull() {
          return new Promise((_, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
          });
        },
      }),
    );
  };
  const controller = new AbortController();
  const pending = downloadApplicationUpdate({
    settings: settings(publicKey),
    version: '0.2.0',
    sequence: 7,
    currentVersion: '0.1.0',
    platform: 'win32',
    arch: 'x64',
    fetchImpl,
    stagingDirectory,
    now: NOW,
    signal: controller.signal,
  });
  await firstChunk;
  controller.abort();
  await assert.rejects(pending, { code: 'APP_UPDATE_TIMEOUT' });
  assert.deepEqual(await fs.readdir(stagingDirectory), []);
});

test('application update download rejects a stale release, redirects, wrong size, and wrong checksum', async (t) => {
  const stagingDirectory = await createTempDirectory('xyst-app-update-invalid-');
  t.after(() => fs.rm(stagingDirectory, { recursive: true, force: true }));
  const { publicKey, feed } = signedFeed();
  const fetchImpl = async () => Response.json(feed);
  await assert.rejects(
    downloadApplicationUpdate({
      settings: settings(publicKey),
      version: '0.2.0',
      sequence: 6,
      currentVersion: '0.1.0',
      platform: 'win32',
      arch: 'x64',
      fetchImpl,
      stagingDirectory,
      now: NOW,
    }),
    { code: 'APP_UPDATE_RELEASE_CHANGED' },
  );
  const validSettings = settings(publicKey);
  const payload = Buffer.from('wrong package bytes');
  const wrongPackageFetch = async (url) =>
    String(url) === validSettings.feed_url
      ? Response.json(feed)
      : new Response(payload, { headers: { 'content-length': String(payload.byteLength) } });
  await assert.rejects(
    downloadApplicationUpdate({
      settings: validSettings,
      version: '0.2.0',
      sequence: 7,
      currentVersion: '0.1.0',
      platform: 'win32',
      arch: 'x64',
      fetchImpl: wrongPackageFetch,
      stagingDirectory,
      now: NOW,
    }),
    { code: 'APP_UPDATE_ARTIFACT_SIZE_INVALID' },
  );
  assert.deepEqual(await fs.readdir(stagingDirectory), []);
  const wrongDigestPayload = Buffer.alloc(feed.releases[0].size_bytes, 0x78);
  await assert.rejects(
    downloadApplicationUpdate({
      settings: validSettings,
      version: '0.2.0',
      sequence: 7,
      currentVersion: '0.1.0',
      platform: 'win32',
      arch: 'x64',
      fetchImpl: async (url) => (String(url) === validSettings.feed_url ? Response.json(feed) : new Response(wrongDigestPayload)),
      stagingDirectory,
      now: NOW,
    }),
    { code: 'APP_UPDATE_ARTIFACT_DIGEST_INVALID' },
  );
  assert.deepEqual(await fs.readdir(stagingDirectory), []);
  await assert.rejects(
    downloadApplicationUpdate({
      settings: validSettings,
      version: '0.2.0',
      sequence: 7,
      currentVersion: '0.1.0',
      platform: 'win32',
      arch: 'x64',
      fetchImpl: async (url) =>
        String(url) === validSettings.feed_url ? Response.json(feed) : Response.redirect('https://attacker.example/package'),
      stagingDirectory,
      now: NOW,
    }),
    { code: 'APP_UPDATE_ARTIFACT_HTTP_ERROR' },
  );
  assert.deepEqual(await fs.readdir(stagingDirectory), []);
});

test('application update metadata cannot roll back or equivocate after a signed sequence is cached', async () => {
  const cacheDirectory = await createTempDirectory('xyst-app-update-cache-');
  const first = signedFeed({ sequence: 7 });
  const cacheOptions = {
    settings: settings(first.publicKey),
    currentVersion: '0.1.0',
    platform: 'win32',
    arch: 'x64',
    now: NOW,
    cacheDirectory,
  };
  const responseFor = (feed) => async () => Response.json(feed);
  await checkApplicationUpdates({ ...cacheOptions, fetchImpl: responseFor(first.feed) });
  await checkApplicationUpdates({ ...cacheOptions, fetchImpl: responseFor(first.feed) });
  const rollback = signedFeed({ sequence: 6 });
  await assert.rejects(
    checkApplicationUpdates({ ...cacheOptions, settings: settings(rollback.publicKey), fetchImpl: responseFor(rollback.feed) }),
    { code: 'APP_UPDATE_FEED_REPLAY' },
  );
  const equivocation = signedFeed({ sequence: 7, notes: 'Different signed statement at the same sequence.' });
  await assert.rejects(
    checkApplicationUpdates({ ...cacheOptions, settings: settings(equivocation.publicKey), fetchImpl: responseFor(equivocation.feed) }),
    { code: 'APP_UPDATE_FEED_REPLAY' },
  );
  assert.ok((await fs.stat(path.join(cacheDirectory, 'application-updates-stable.json'))).isFile());
});

test('application update sequence cache reads stop at its byte limit during concurrent growth', async (t) => {
  const cacheDirectory = await createTempDirectory('xyst-app-update-bounded-cache-');
  t.after(() => fs.rm(cacheDirectory, { recursive: true, force: true }));
  const first = signedFeed({ sequence: 7 });
  const options = {
    settings: settings(first.publicKey),
    currentVersion: '0.1.0',
    platform: 'win32',
    arch: 'x64',
    now: NOW,
    cacheDirectory,
    fetchImpl: async () => Response.json(first.feed),
  };
  await checkApplicationUpdates(options);

  const filePath = path.join(cacheDirectory, 'application-updates-stable.json');
  const probe = await fs.open(filePath, 'r');
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  const read = fileHandlePrototype.read;
  const requests = [];
  fileHandlePrototype.read = async (buffer, offset, length, _position) => {
    requests.push(length);
    buffer.fill(0, offset, offset + length);
    return { bytesRead: length, buffer };
  };
  try {
    await assert.rejects(checkApplicationUpdates(options), { code: 'APP_UPDATE_CACHE_INVALID' });
    assert.deepEqual(requests, [4097]);
  } finally {
    fileHandlePrototype.read = read;
  }
  assert.ok((await fs.stat(filePath)).isFile());
});

test('application update refresh restores an interrupted cache before checking replay sequence', async (t) => {
  const cacheDirectory = await createTempDirectory('xyst-app-update-recovery-');
  t.after(() => fs.rm(cacheDirectory, { recursive: true, force: true }));
  const first = signedFeed({ sequence: 7 });
  const options = {
    settings: settings(first.publicKey),
    currentVersion: '0.1.0',
    platform: 'win32',
    arch: 'x64',
    now: NOW,
    cacheDirectory,
  };
  await checkApplicationUpdates({ ...options, fetchImpl: async () => Response.json(first.feed) });
  const cachePath = path.join(cacheDirectory, 'application-updates-stable.json');
  const backupPath = `${cachePath}.00000000-0000-4000-8000-000000000001.bak`;
  await fs.rename(cachePath, backupPath);
  const replay = signedFeed({ sequence: 6 });
  await assert.rejects(
    checkApplicationUpdates({ ...options, settings: settings(replay.publicKey), fetchImpl: async () => Response.json(replay.feed) }),
    { code: 'APP_UPDATE_FEED_REPLAY' },
  );
  assert.ok((await fs.stat(cachePath)).isFile());
  await assert.rejects(fs.stat(backupPath), { code: 'ENOENT' });
});

test('application update check ignores other platforms, architectures, channels, and versions already installed', async () => {
  const { publicKey, feed } = signedFeed({ platform: 'linux', arch: 'arm64', version: '0.1.0' });
  const fetchImpl = async () => Response.json(feed);
  const platformMismatch = await checkApplicationUpdates({
    settings: settings(publicKey),
    currentVersion: '0.1.0',
    platform: 'win32',
    arch: 'x64',
    now: NOW,
    fetchImpl,
  });
  const versionMatch = await checkApplicationUpdates({
    settings: settings(publicKey),
    currentVersion: '0.1.0',
    platform: 'linux',
    arch: 'arm64',
    now: NOW,
    fetchImpl,
  });
  assert.equal(platformMismatch.update_available, false);
  assert.equal(versionMatch.update_available, false);
});

test('application update comparison preserves SemVer ordering for arbitrarily large numeric identifiers', async () => {
  const { publicKey, feed } = signedFeed({ version: '9007199254740993.0.0' });
  const result = await checkApplicationUpdates({
    settings: settings(publicKey),
    currentVersion: '9007199254740992.0.0',
    platform: 'win32',
    arch: 'x64',
    now: NOW,
    fetchImpl: async () => Response.json(feed),
  });
  assert.equal(result.update_available, true);
});

test('application update feeds reject signature changes, expiry, redirects, and untrusted endpoints', async () => {
  const { publicKey, feed } = signedFeed();
  const changed = structuredClone(feed);
  changed.releases[0].version = '9.9.9';
  assert.throws(
    () =>
      verifyApplicationUpdateFeed(changed, {
        keyId: 'xyst-release-2026',
        publicKey,
        channel: 'stable',
        now: NOW,
      }),
    { code: 'APP_UPDATE_SIGNATURE_INVALID' },
  );

  const expired = signedFeed({ expiresAt: NOW - 1 });
  await assert.rejects(
    checkApplicationUpdates({ settings: settings(expired.publicKey), now: NOW, fetchImpl: async () => Response.json(expired.feed) }),
    { code: 'APP_UPDATE_FEED_EXPIRED' },
  );
  await assert.rejects(
    checkApplicationUpdates({
      settings: settings(publicKey),
      now: NOW,
      fetchImpl: async () => Response.redirect('https://attacker.example/feed'),
    }),
    { code: 'APP_UPDATE_HTTP_ERROR' },
  );
  await assert.rejects(
    checkApplicationUpdates({
      settings: settings(publicKey, { feed_url: 'https://127.0.0.1/feed' }),
      now: NOW,
      fetchImpl: async () => assert.fail('must not fetch'),
    }),
    { code: 'APP_UPDATE_CONFIG_INVALID' },
  );
});

test('application update checks require an explicit enabled mode and trusted Ed25519 key', async () => {
  await assert.rejects(checkApplicationUpdates({ settings: { mode: 'disabled' }, fetchImpl: async () => assert.fail('must not fetch') }), {
    code: 'APP_UPDATES_DISABLED',
  });
  await assert.rejects(
    checkApplicationUpdates({ settings: { mode: 'manual', channel: 'stable' }, fetchImpl: async () => assert.fail('must not fetch') }),
    { code: 'APP_UPDATE_NOT_CONFIGURED' },
  );
});

test('release signing command validates its statement, emits a verifiable feed, and never overwrites output', async () => {
  const root = await createTempDirectory('xyst-app-update-sign-');
  const { publicKey, privateKey, feed } = signedFeed({ expiresAt: Date.now() + 60 * 60_000 });
  const statementPath = path.join(root, 'statement.json');
  const keyPath = path.join(root, 'offline-key.pem');
  const outputPath = path.join(root, 'releases.json');
  const statement = structuredClone(feed);
  delete statement.signature;
  await fs.writeFile(statementPath, JSON.stringify(statement));
  await fs.writeFile(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const scriptPath = path.resolve('scripts/sign-application-update-feed.mjs');
  const result = await execFile(process.execPath, [scriptPath, statementPath, keyPath, outputPath]);
  const signed = JSON.parse(await fs.readFile(outputPath, 'utf8'));
  verifyApplicationUpdateFeed(signed, {
    keyId: 'xyst-release-2026',
    publicKey,
    channel: 'stable',
    now: Date.now(),
  });
  assert.match(result.stdout, /"key_fingerprint":"SHA256:/);
  await assert.rejects(execFile(process.execPath, [scriptPath, statementPath, keyPath, outputPath]));
});

test('application update version follows the shared package, Tauri, and Cargo release version', async () => {
  const packageMetadata = JSON.parse(await fs.readFile('package.json', 'utf8'));
  const tauri = JSON.parse(await fs.readFile('gui/desktop/src-tauri/tauri.conf.json', 'utf8'));
  const cargo = await fs.readFile('gui/desktop/src-tauri/Cargo.toml', 'utf8');
  const cargoVersion = cargo.match(/^version = "([^"]+)"/m)?.[1];
  assert.equal(APPLICATION_VERSION, packageMetadata.version);
  assert.equal(tauri.version, packageMetadata.version);
  assert.equal(cargoVersion, packageMetadata.version);
});
