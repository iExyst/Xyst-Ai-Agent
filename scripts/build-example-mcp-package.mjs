import { createHash, createPrivateKey } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signPackageManifest } from '../src/extensions/signed-packages.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../examples/mcp/hello-world');
const PACKAGE_ID = 'hello-world-mcp';
const DEFAULT_VERSION = '1.0.0';
const MAX_PRIVATE_KEY_BYTES = 8 * 1024;
const ENTRY_POINT = 'server.mjs';

export async function buildExampleMcpPackage({ keyId, privateKeyPath, outputDirectory, version = DEFAULT_VERSION }) {
  if (typeof keyId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(keyId)) {
    throw new Error('Publisher key ID must contain 1 to 64 lowercase letters, digits, dots, underscores, or hyphens');
  }
  if (typeof version !== 'string') throw new Error('Package version must be a semantic version string');
  if (typeof privateKeyPath !== 'string' || !privateKeyPath.trim()) throw new Error('Private key path is required');
  if (typeof outputDirectory !== 'string' || !outputDirectory.trim()) throw new Error('Output directory is required');

  const destination = path.resolve(outputDirectory);
  const sourceRelative = path.relative(SOURCE_DIRECTORY, destination);
  if (
    sourceRelative === '' ||
    (!sourceRelative.startsWith(`..${path.sep}`) && sourceRelative !== '..' && !path.isAbsolute(sourceRelative))
  ) {
    throw new Error('Output directory must be outside the example source directory');
  }

  const keyBytes = await readBoundedRegularFile(privateKeyPath, MAX_PRIVATE_KEY_BYTES, 'Ed25519 private key');
  const privateKey = createPrivateKey(keyBytes);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Package signing requires an Ed25519 private key');

  const sourcePath = path.join(SOURCE_DIRECTORY, ENTRY_POINT);
  const templateBytes = await readBoundedRegularFile(sourcePath, 2 * 1024 * 1024, 'Example MCP server');
  const template = new TextDecoder('utf-8', { fatal: true }).decode(templateBytes);
  const versionMarker = "const SERVER_VERSION = '__PACKAGE_VERSION__';";
  if (template.indexOf(versionMarker) !== template.lastIndexOf(versionMarker) || !template.includes(versionMarker)) {
    throw new Error('Example MCP server must contain exactly one package version marker');
  }
  const sourceBytes = Buffer.from(template.replace(versionMarker, `const SERVER_VERSION = ${JSON.stringify(version)};`));
  const manifest = signPackageManifest({
    packageId: PACKAGE_ID,
    packageType: 'mcp',
    version,
    keyId,
    privateKey,
    entryPoint: ENTRY_POINT,
    capabilities: [
      { name: 'mcp.tools', scope: 'configured-server', reason: 'Expose the example echo tool to a configured MCP server' },
      { name: 'process.execute', scope: 'configured', reason: 'Launch the signed MCP server after explicit activation and configuration' },
    ],
    files: [
      {
        path: ENTRY_POINT,
        size: sourceBytes.byteLength,
        sha256: createHash('sha256').update(sourceBytes).digest('hex'),
      },
    ],
  });

  const parent = path.dirname(destination);
  await fs.mkdir(parent, { recursive: true });
  await ensureAbsent(destination);
  const staging = await fs.mkdtemp(path.join(parent, '.xyst-example-mcp-'));
  try {
    await fs.writeFile(path.join(staging, ENTRY_POINT), sourceBytes, { flag: 'wx', mode: 0o644 });
    await fs.writeFile(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o644,
    });
    await ensureAbsent(destination);
    await fs.rename(staging, destination);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  return { output: destination, package_id: PACKAGE_ID, version, files: 1 };
}

async function readBoundedRegularFile(filePath, limit, label) {
  const info = await fs.lstat(filePath);
  if (info.isSymbolicLink() || !info.isFile() || info.size < 1 || info.size > limit) {
    throw new Error(`${label} must be a regular file between 1 and ${limit} bytes`);
  }
  const handle = await fs.open(filePath, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) {
      throw new Error(`${label} changed while being read`);
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength !== opened.size || bytes.byteLength > limit) throw new Error(`${label} changed or exceeded the size limit`);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function ensureAbsent(destination) {
  try {
    await fs.lstat(destination);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Output already exists: ${destination}`);
}

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === '--help' || name === '-h') return null;
    if (!['--key-id', '--private-key', '--output', '--version'].includes(name)) throw new Error(`Unknown option: ${name}`);
    if (values.has(name)) throw new Error(`Option repeated: ${name}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Option requires a value: ${name}`);
    values.set(name, value);
    index += 1;
  }
  for (const required of ['--key-id', '--private-key', '--output']) {
    if (!values.has(required)) throw new Error(`Required option is missing: ${required}`);
  }
  return {
    keyId: values.get('--key-id'),
    privateKeyPath: values.get('--private-key'),
    outputDirectory: values.get('--output'),
    version: values.get('--version') || DEFAULT_VERSION,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options) {
    process.stdout.write(
      'Usage: node scripts/build-example-mcp-package.mjs --key-id <publisher-key-id> --private-key <offline-ed25519-private-key.pem> --output <new-package-directory> [--version <semver>]\n',
    );
    return;
  }
  process.stdout.write(`${JSON.stringify(await buildExampleMcpPackage(options))}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`example MCP package build failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
