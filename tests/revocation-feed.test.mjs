import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createTempDirectory } from './helpers.mjs';
import { canonicalJson } from '../src/extensions/signed-packages.mjs';
import { getCachedRevocations, refreshRevocationFeed } from '../src/extensions/revocation-feed.mjs';

function setupFeed({ sequence = 1, revokedKeyIds = ['package-key'], revokedPackages = [], pair = generateKeyPairSync('ed25519') } = {}) {
  const trustedKeys = { 'feed-key': pair.publicKey.export({ type: 'spki', format: 'pem' }) };
  const now = Date.now();
  const statement = {
    schema_version: 1,
    sequence,
    issued_at: new Date(now - 1000).toISOString(),
    expires_at: new Date(now + 60_000).toISOString(),
    revoked_key_ids: revokedKeyIds,
    revoked_packages: revokedPackages,
    key_id: 'feed-key',
  };
  const feed = { ...statement, signature: sign(null, Buffer.from(canonicalJson(statement)), pair.privateKey).toString('base64') };
  return { trustedKeys, feed, pair };
}

function response(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('signed revocation feed refreshes cache and enforces revocations offline', async (t) => {
  const root = await createTempDirectory('xyst-revocations-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { trustedKeys, feed } = setupFeed();
  const options = { installRoot: root, url: 'https://example.test/revocations.json', keyId: 'feed-key', trustedKeys };
  let calls = 0;
  const refreshed = await refreshRevocationFeed({
    ...options,
    fetchImpl: async () => {
      calls++;
      return response(feed);
    },
  });
  assert.equal(refreshed.sequence, 1);
  assert.equal(calls, 1);
  assert.deepEqual(await getCachedRevocations(options), { revokedKeyIds: ['package-key'], revokedPackages: [] });
});

test('configured revocation feed fails closed when its verified cache is missing', async (t) => {
  const root = await createTempDirectory('xyst-revocation-missing-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { trustedKeys } = setupFeed();
  await assert.rejects(
    getCachedRevocations({ installRoot: root, url: 'https://example.test/revocations.json', keyId: 'feed-key', trustedKeys }),
    { code: 'REVOCATION_DATA_UNAVAILABLE' },
  );
});

test('revocation feed rejects sequence rollback and same-sequence equivocation', async (t) => {
  const root = await createTempDirectory('xyst-revocation-replay-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { trustedKeys, feed, pair } = setupFeed();
  const options = { installRoot: root, url: 'https://example.test/revocations.json', keyId: 'feed-key', trustedKeys };
  await refreshRevocationFeed({ ...options, fetchImpl: async () => response(feed) });
  const lower = setupFeed({ sequence: 0, pair });
  await assert.rejects(refreshRevocationFeed({ ...options, fetchImpl: async () => response(lower.feed) }), {
    code: 'REVOCATION_FEED_REPLAY',
  });
  const equivocation = setupFeed({ sequence: 1, revokedKeyIds: ['different-key'], pair });
  await assert.rejects(refreshRevocationFeed({ ...options, fetchImpl: async () => response(equivocation.feed) }), {
    code: 'REVOCATION_FEED_REPLAY',
  });
});

test('concurrent revocation refreshes cannot let a late response restore older revocation state', async (t) => {
  const root = await createTempDirectory('xyst-revocation-concurrent-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const older = setupFeed({ sequence: 1, revokedPackages: [] });
  const newer = setupFeed({ sequence: 2, revokedPackages: ['skill:release-check@1.0.0'], pair: older.pair });
  const options = { installRoot: root, url: 'https://example.test/revocations.json', keyId: 'feed-key', trustedKeys: older.trustedKeys };
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

  const olderRefresh = refreshRevocationFeed({ ...options, fetchImpl: olderFetch });
  const newerRefresh = refreshRevocationFeed({ ...options, fetchImpl: newerFetch });
  await bothStarted;
  resolveNewer(response(newer.feed));
  assert.equal((await newerRefresh).sequence, 2);
  resolveOlder(response(older.feed));
  await assert.rejects(olderRefresh, { code: 'REVOCATION_FEED_REPLAY' });
  assert.deepEqual(await getCachedRevocations(options), {
    revokedKeyIds: ['package-key'],
    revokedPackages: ['skill:release-check@1.0.0'],
  });
});

test('refresh refuses a cache whose replay sequence no longer matches its signed feed', async (t) => {
  const root = await createTempDirectory('xyst-revocation-cache-tamper-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { trustedKeys, feed } = setupFeed();
  const options = { installRoot: root, url: 'https://example.test/revocations.json', keyId: 'feed-key', trustedKeys };
  await refreshRevocationFeed({ ...options, fetchImpl: async () => response(feed) });
  const cachePath = path.join(root, 'revocations.json');
  const cache = JSON.parse(await fs.readFile(cachePath, 'utf8'));
  cache.sequence = 0;
  await fs.writeFile(cachePath, JSON.stringify(cache));
  const next = setupFeed({ sequence: 2 });
  await assert.rejects(refreshRevocationFeed({ ...options, fetchImpl: async () => response(next.feed) }), {
    code: 'REVOCATION_CACHE_INVALID',
  });
});

test('revocation feed cache rejects expired signed data, invalid signatures, and oversized bodies', async (t) => {
  const root = await createTempDirectory('xyst-revocation-invalid-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { trustedKeys, feed } = setupFeed();
  const options = { installRoot: root, url: 'https://example.test/revocations.json', keyId: 'feed-key', trustedKeys };
  const bad = { ...feed, signature: Buffer.alloc(64).toString('base64') };
  await assert.rejects(refreshRevocationFeed({ ...options, fetchImpl: async () => response(bad) }), {
    code: 'REVOCATION_FEED_SIGNATURE_INVALID',
  });
  const oversized = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(300 * 1024));
        controller.close();
      },
    }),
  );
  await assert.rejects(refreshRevocationFeed({ ...options, fetchImpl: async () => oversized }), { code: 'REVOCATION_FEED_TOO_LARGE' });
  await refreshRevocationFeed({ ...options, fetchImpl: async () => response(feed) });
  const cachePath = path.join(root, 'revocations.json');
  assert.ok((await fs.stat(cachePath)).isFile());
  await assert.rejects(getCachedRevocations({ ...options, maxAgeHours: 1, now: Date.now() + 120_000 }), {
    code: 'REVOCATION_FEED_EXPIRED',
  });
});
