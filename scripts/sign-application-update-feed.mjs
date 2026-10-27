import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applicationUpdateKeyFingerprint, verifyApplicationUpdateFeed } from '../src/platform/application-updates.mjs';
import { canonicalJson } from '../src/extensions/signed-packages.mjs';

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_KEY_BYTES = 8 * 1024;

export async function signApplicationUpdateFeed(statementPath, privateKeyPath, outputPath) {
  const statement = await readBoundedJsonFile(statementPath, MAX_INPUT_BYTES, 'Release statement');
  if (Object.hasOwn(statement, 'signature')) throw new Error('Release statement must not already contain a signature');
  const privateKeyBytes = await readBoundedRegularFile(privateKeyPath, MAX_KEY_BYTES, 'Signing key');
  const privateKey = createPrivateKey(privateKeyBytes);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Application update signing requires an Ed25519 private key');
  const publicKey = createPublicKey(privateKey);
  const feed = {
    ...statement,
    signature: sign(null, Buffer.from(canonicalJson(statement)), privateKey).toString('base64'),
  };
  verifyApplicationUpdateFeed(feed, {
    keyId: statement.key_id,
    publicKey,
    channel: statement.channel,
    now: Date.now(),
  });
  const destination = path.resolve(outputPath);
  await fs.writeFile(destination, `${JSON.stringify(feed, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  return {
    output: destination,
    sequence: statement.sequence,
    release_count: statement.releases.length,
    key_fingerprint: applicationUpdateKeyFingerprint(publicKey.export({ type: 'spki', format: 'pem' }).toString()),
  };
}

async function readBoundedJsonFile(filePath, limit, label) {
  const bytes = await readBoundedRegularFile(filePath, limit, label);
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected an object');
    return parsed;
  } catch (error) {
    throw new Error(`${label} must be a UTF-8 JSON object`, { cause: error });
  }
}

async function readBoundedRegularFile(filePath, limit, label) {
  const info = await fs.lstat(filePath);
  if (info.isSymbolicLink() || !info.isFile() || info.size < 1 || info.size > limit)
    throw new Error(`${label} must be a regular file between 1 and ${limit} bytes`);
  const handle = await fs.open(filePath, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size)
      throw new Error(`${label} changed while being read`);
    const bytes = await handle.readFile();
    if (bytes.length !== opened.size || bytes.length > limit) throw new Error(`${label} changed or exceeded the size limit`);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function main() {
  const [statementPath, privateKeyPath, outputPath, ...extra] = process.argv.slice(2);
  if (!statementPath || !privateKeyPath || !outputPath || extra.length) {
    throw new Error('Usage: node scripts/sign-application-update-feed.mjs <statement.json> <offline-private-key.pem> <new-feed.json>');
  }
  const result = await signApplicationUpdateFeed(statementPath, privateKeyPath, outputPath);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`application update signing failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
