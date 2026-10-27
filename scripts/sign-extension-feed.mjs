import { constants as fsConstants } from 'node:fs';
import { createPrivateKey, createPublicKey, randomUUID, sign } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../src/extensions/signed-packages.mjs';
import { validateRevocationFeed } from '../src/extensions/revocation-feed.mjs';
import { validatePackageUpdateFeed } from '../src/extensions/update-feed.mjs';

const MAX_STATEMENT_BYTES = 256 * 1024;
const MAX_PRIVATE_KEY_BYTES = 8 * 1024;
const MAX_FEED_AGE_HOURS = 72;

/** Sign and locally validate an extension feed using an offline Ed25519 key. */
export async function signExtensionFeed(kind, statementPath, privateKeyPath, outputPath) {
  if (!['updates', 'revocations'].includes(kind)) throw new TypeError('Feed kind must be updates or revocations');
  const statement = await readJsonObject(statementPath, MAX_STATEMENT_BYTES, 'Unsigned feed statement');
  if (Object.hasOwn(statement, 'signature')) throw new Error('Unsigned feed statement must not already contain a signature');

  const privateKey = createPrivateKey(await readBoundedRegularFile(privateKeyPath, MAX_PRIVATE_KEY_BYTES, 'Ed25519 private key'));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Extension feed signing requires an Ed25519 private key');
  const publicKey = createPublicKey(privateKey);
  const keyId = statement.key_id;
  const trustedKeys = { [keyId]: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  const feed = { ...statement, signature: sign(null, Buffer.from(canonicalJson(statement)), privateKey).toString('base64') };

  const validStatement =
    kind === 'updates'
      ? validatePackageUpdateFeed(feed, { keyId, trustedKeys, maxAgeHours: MAX_FEED_AGE_HOURS })
      : validateRevocationFeed(feed, { keyId, trustedKeys, maxAgeHours: MAX_FEED_AGE_HOURS });
  const entries =
    kind === 'updates' ? validStatement.packages.length : validStatement.revoked_key_ids.length + validStatement.revoked_packages.length;
  const destination = path.resolve(outputPath);
  const temporaryPath = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(feed, null, 2)}\n`);
  let published = false;
  let failure;
  try {
    const handle = await fs.open(temporaryPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o644);
    try {
      await handle.writeFile(`${JSON.stringify(feed, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // A same-directory hard link publishes only the complete, synced file and
    // fails if the destination already exists. Some restricted filesystems
    // deny hard links, so retain exclusive-create behavior as a safe fallback.
    try {
      await fs.link(temporaryPath, destination);
    } catch (error) {
      if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) throw error;
      await writeExclusiveFile(destination, bytes);
    }
    published = true;
  } finally {
    try {
      await fs.unlink(temporaryPath);
    } catch (error) {
      if (error.code !== 'ENOENT') failure = error;
    }
  }
  if (failure)
    throw new Error(
      `Feed was ${published ? 'published but temporary-file cleanup failed' : 'not published and temporary-file cleanup failed'}`,
      { cause: failure },
    );
  return { feed_kind: kind, output: destination, key_id: keyId, sequence: validStatement.sequence, entry_count: entries };
}

async function writeExclusiveFile(destination, bytes) {
  let handle;
  let created = false;
  let failure;
  try {
    handle = await fs.open(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o644);
    created = true;
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    failure = error;
  }
  try {
    await handle?.close();
  } catch (error) {
    failure ??= error;
  }
  if (!failure) return;
  if (created)
    await fs.unlink(destination).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  throw failure;
}

async function readJsonObject(filePath, limit, label) {
  const bytes = await readBoundedRegularFile(filePath, limit, label);
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an object');
    return value;
  } catch (error) {
    throw new Error(`${label} must be a UTF-8 JSON object`, { cause: error });
  }
}

async function readBoundedRegularFile(filePath, limit, label) {
  const before = await fs.lstat(filePath);
  if (before.isSymbolicLink() || !before.isFile() || before.size < 1 || before.size > limit)
    throw new Error(`${label} must be a regular file between 1 and ${limit} bytes`);
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
      throw new Error(`${label} changed while being read`);
    const bytes = await handle.readFile();
    if (bytes.byteLength !== opened.size || bytes.byteLength > limit) throw new Error(`${label} changed or exceeded the size limit`);
    return bytes;
  } finally {
    await handle.close();
  }
}

function usage() {
  return [
    'Usage: node scripts/sign-extension-feed.mjs <updates|revocations> <statement.json> <offline-private-key.pem> <new-feed.json>',
    'Input must be an unsigned version-1 statement with current issued_at/expires_at values.',
    'The tool verifies the resulting signature and schema before creating a new output file.',
  ].join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (args.length !== 4) throw new Error(usage());
  const [kind, statementPath, privateKeyPath, outputPath] = args;
  process.stdout.write(`${JSON.stringify(await signExtensionFeed(kind, statementPath, privateKeyPath, outputPath))}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`extension feed signing failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
