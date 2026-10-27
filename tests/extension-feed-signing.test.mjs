import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { refreshRevocationFeed } from '../src/extensions/revocation-feed.mjs';
import { refreshPackageUpdateFeed } from '../src/extensions/update-feed.mjs';
import { createTempDirectory } from './helpers.mjs';
import { signExtensionFeed } from '../scripts/sign-extension-feed.mjs';

const execFile = promisify(execFileCallback);
const SIGNING_SCRIPT = fileURLToPath(new URL('../scripts/sign-extension-feed.mjs', import.meta.url));

function currentFeedTimes() {
  const now = Date.now();
  return {
    issued_at: new Date(now - 1_000).toISOString(),
    expires_at: new Date(now + 60 * 60_000).toISOString(),
  };
}

test('extension feed signer validates and signs update and revocation statements consumable by the runtime', async (t) => {
  const directory = await createTempDirectory('xyst-extension-feed-signing-');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const pair = generateKeyPairSync('ed25519');
  const privateKeyPath = path.join(directory, 'offline-private.pem');
  const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const trustedKeys = { 'publisher-key': publicKeyPem };
  await fs.writeFile(privateKeyPath, privateKeyPem, { mode: 0o600 });

  const updateStatementPath = path.join(directory, 'updates-statement.json');
  await fs.writeFile(
    updateStatementPath,
    JSON.stringify({
      schema_version: 1,
      sequence: 4,
      key_id: 'publisher-key',
      ...currentFeedTimes(),
      packages: [
        {
          package_type: 'skill',
          package_id: 'release-check',
          version: '1.2.0',
          manifest_sha256: 'a'.repeat(64),
          package_url: 'https://packages.example.test/release-check-1.2.0',
        },
      ],
    }),
  );
  const updatesPath = path.join(directory, 'updates.json');
  const updateResult = await signExtensionFeed('updates', updateStatementPath, privateKeyPath, updatesPath);
  assert.deepEqual(
    {
      feed_kind: updateResult.feed_kind,
      key_id: updateResult.key_id,
      sequence: updateResult.sequence,
      entry_count: updateResult.entry_count,
    },
    { feed_kind: 'updates', key_id: 'publisher-key', sequence: 4, entry_count: 1 },
  );
  const signedUpdates = JSON.parse(await fs.readFile(updatesPath, 'utf8'));
  assert.equal(typeof signedUpdates.signature, 'string');
  assert.equal(JSON.stringify(signedUpdates).includes('BEGIN PRIVATE KEY'), false);
  assert.equal(
    (await fs.readdir(directory)).some((name) => name.startsWith('.updates.json.') && name.endsWith('.tmp')),
    false,
  );
  await assert.rejects(signExtensionFeed('updates', updateStatementPath, privateKeyPath, updatesPath), { code: 'EEXIST' });
  assert.equal(
    (await fs.readdir(directory)).some((name) => name.startsWith('.updates.json.') && name.endsWith('.tmp')),
    false,
  );
  const cachedUpdates = await refreshPackageUpdateFeed({
    installRoot: path.join(directory, 'update-cache'),
    url: 'https://updates.example.test/packages.json',
    keyId: 'publisher-key',
    trustedKeys,
    fetchImpl: async () => Response.json(signedUpdates),
  });
  assert.equal(cachedUpdates.sequence, 4);
  assert.equal(cachedUpdates.packages[0].version, '1.2.0');

  const revocationStatementPath = path.join(directory, 'revocations-statement.json');
  await fs.writeFile(
    revocationStatementPath,
    JSON.stringify({
      schema_version: 1,
      sequence: 9,
      key_id: 'publisher-key',
      ...currentFeedTimes(),
      revoked_key_ids: ['retired-key'],
      revoked_packages: ['mcp:legacy-server@1.0.0'],
    }),
  );
  const revocationsPath = path.join(directory, 'revocations.json');
  const cli = await execFile(process.execPath, [SIGNING_SCRIPT, 'revocations', revocationStatementPath, privateKeyPath, revocationsPath]);
  assert.deepEqual(JSON.parse(cli.stdout), {
    feed_kind: 'revocations',
    output: revocationsPath,
    key_id: 'publisher-key',
    sequence: 9,
    entry_count: 2,
  });
  const signedRevocations = JSON.parse(await fs.readFile(revocationsPath, 'utf8'));
  const cachedRevocations = await refreshRevocationFeed({
    installRoot: path.join(directory, 'revocation-cache'),
    url: 'https://updates.example.test/revocations.json',
    keyId: 'publisher-key',
    trustedKeys,
    fetchImpl: async () => Response.json(signedRevocations),
  });
  assert.deepEqual(cachedRevocations.revoked_key_ids, ['retired-key']);
  assert.deepEqual(cachedRevocations.revoked_packages, ['mcp:legacy-server@1.0.0']);
});

test('extension feed signer rejects malformed statements, wrong key types, and signed input without creating output', async (t) => {
  const directory = await createTempDirectory('xyst-extension-feed-signing-invalid-');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const ed25519 = generateKeyPairSync('ed25519');
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const edKeyPath = path.join(directory, 'ed25519.pem');
  const rsaKeyPath = path.join(directory, 'rsa.pem');
  await fs.writeFile(edKeyPath, ed25519.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  await fs.writeFile(rsaKeyPath, rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const malformedPath = path.join(directory, 'malformed.json');
  await fs.writeFile(malformedPath, JSON.stringify({ schema_version: 1, key_id: 'publisher-key', packages: [] }));
  const output = path.join(directory, 'must-not-exist.json');
  await assert.rejects(signExtensionFeed('updates', malformedPath, edKeyPath, output));
  await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
  await assert.rejects(signExtensionFeed('invalid', malformedPath, edKeyPath, output), /updates or revocations/);
  await assert.rejects(signExtensionFeed('updates', malformedPath, rsaKeyPath, output), /Ed25519 private key/);
  const alreadySigned = path.join(directory, 'already-signed.json');
  await fs.writeFile(alreadySigned, JSON.stringify({ schema_version: 1, signature: 'not-used' }));
  await assert.rejects(signExtensionFeed('updates', alreadySigned, edKeyPath, output), /must not already contain a signature/);
  await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
});
