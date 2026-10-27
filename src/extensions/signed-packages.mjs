import { createHash, createPublicKey, randomUUID, sign, verify } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const MANIFEST_NAME = 'manifest.json';
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_PACKAGE_FILES = 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;
const MAX_PACKAGE_CAPABILITIES = 32;
const PACKAGE_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SEMVER_IDENTIFIER = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const VERSION = new RegExp(
  `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${SEMVER_IDENTIFIER}(?:\\.${SEMVER_IDENTIFIER})*))?(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$`,
);
const SHA256 = /^[a-f0-9]{64}$/;
const CAPABILITY_SCOPES = new Map([
  ['filesystem.read', new Set(['workspace', 'machine'])],
  ['filesystem.write', new Set(['workspace', 'machine'])],
  ['process.execute', new Set(['configured'])],
  ['network.connect', null],
  ['desktop.control', new Set(['interactive-session'])],
  ['secrets.use', new Set(['configured-reference'])],
  ['mcp.tools', new Set(['configured-server'])],
  ['mcp.resources', new Set(['configured-server'])],
  ['mcp.prompts', new Set(['configured-server'])],
]);

/** Sign the canonical package statement with an Ed25519 private key. */
export function signPackageManifest({ packageId, packageType, version, files, keyId, privateKey, capabilities, entryPoint }) {
  const statement = validateStatement({
    schema_version: 1,
    package_id: packageId,
    package_type: packageType,
    version,
    files,
    key_id: keyId,
    ...(capabilities === undefined ? {} : { capability_schema: 1, capabilities }),
    ...(entryPoint === undefined ? {} : { entry_point: entryPoint }),
  });
  const signature = sign(null, Buffer.from(canonicalJson(statement)), privateKey).toString('base64');
  return { ...statement, signature };
}

/** Verify the complete package tree before returning any payload bytes to an installer. */
export async function verifySignedPackage(packageRoot, { trustedKeys, revokedKeyIds = [], revokedPackages = [], retainFiles = true } = {}) {
  const root = await resolvePackageRoot(packageRoot);
  const manifestBytes = await readRegularFile(path.join(root, MANIFEST_NAME), MAX_MANIFEST_BYTES);
  return verifyPackagePayload(
    manifestBytes,
    (entry) => readPackageEntry(root, entry.path, entry.size),
    async () => listPackageFiles(root),
    { trustedKeys, revokedKeyIds, revokedPackages, retainFiles, root },
  );
}

/** Verify an in-memory JSON bundle without extracting or writing untrusted content. */
export async function verifySignedPackageBundle(
  bundleBytes,
  { trustedKeys, revokedKeyIds = [], revokedPackages = [], retainFiles = true } = {},
) {
  if (!Buffer.isBuffer(bundleBytes) || bundleBytes.byteLength > MAX_PACKAGE_BYTES * 2)
    throw packageError('Package bundle exceeds the encoded size limit', 'PACKAGE_TOO_LARGE');
  let bundle;
  try {
    bundle = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bundleBytes));
  } catch {
    throw packageError('Package bundle is not valid UTF-8 JSON', 'PACKAGE_BUNDLE_INVALID');
  }
  if (!isRecord(bundle) || Object.keys(bundle).sort().join(',') !== 'files,manifest,schema_version' || bundle.schema_version !== 1)
    throw packageError('Package bundle has an unsupported schema', 'PACKAGE_BUNDLE_INVALID');
  const manifestBytes = decodeBase64(bundle.manifest, MAX_MANIFEST_BYTES, 'manifest');
  if (!Array.isArray(bundle.files) || bundle.files.length < 1 || bundle.files.length > MAX_PACKAGE_FILES)
    throw packageError('Package bundle file list is invalid', 'PACKAGE_BUNDLE_INVALID');
  const payload = new Map();
  let encodedTotal = manifestBytes.byteLength;
  for (const record of bundle.files) {
    if (!isRecord(record) || Object.keys(record).sort().join(',') !== 'content_base64,path')
      throw packageError('Package bundle contains an invalid file record', 'PACKAGE_BUNDLE_INVALID');
    if (typeof record.path !== 'string' || !isSafePackagePath(record.path) || record.path.toLowerCase() === MANIFEST_NAME)
      throw packageError('Package bundle contains an invalid path', 'PACKAGE_PATH_INVALID');
    if (payload.has(record.path)) throw packageError(`Duplicate package path: ${record.path}`, 'PACKAGE_PATH_INVALID');
    const bytes = decodeBase64(record.content_base64, MAX_FILE_BYTES, record.path);
    encodedTotal += bytes.byteLength;
    if (encodedTotal > MAX_PACKAGE_BYTES) throw packageError('Package exceeds the total size limit', 'PACKAGE_TOO_LARGE');
    payload.set(record.path, bytes);
  }
  return verifyPackagePayload(
    manifestBytes,
    async (entry) => {
      const bytes = payload.get(entry.path);
      if (!bytes) throw packageError(`Package is missing a declared file: ${entry.path}`, 'PACKAGE_FILE_SET_INVALID');
      if (bytes.byteLength !== entry.size) throw packageError(`Package file size mismatch: ${entry.path}`, 'PACKAGE_FILE_SIZE_INVALID');
      return bytes;
    },
    async () => new Set([MANIFEST_NAME, ...payload.keys()]),
    { trustedKeys, revokedKeyIds, revokedPackages, retainFiles, root: null },
  );
}

/** Encode a verified directory package in the non-executable in-memory download format. */
export async function createSignedPackageBundle(packageRoot, options = {}) {
  const verified = await verifySignedPackage(packageRoot, { ...options, retainFiles: true });
  const bundle = {
    schema_version: 1,
    manifest: verified.manifestBytes.toString('base64'),
    files: [...verified.files].map(([filePath, bytes]) => ({ path: filePath, content_base64: bytes.toString('base64') })),
  };
  const bytes = Buffer.from(JSON.stringify(bundle));
  if (bytes.byteLength > MAX_PACKAGE_BYTES * 2)
    throw packageError('Encoded package bundle exceeds the download size limit', 'PACKAGE_TOO_LARGE');
  return bytes;
}

async function verifyPackagePayload(
  manifestBytes,
  readEntry,
  listActualPaths,
  { trustedKeys, revokedKeyIds, revokedPackages, retainFiles, root },
) {
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  } catch {
    throw packageError('Package manifest is not valid UTF-8 JSON', 'PACKAGE_MANIFEST_INVALID');
  }
  const { statement, signature } = validateManifest(manifest);
  const keyId = statement.key_id;
  if (!trustedKeys || typeof trustedKeys[keyId] !== 'string')
    throw packageError(`Package signing key '${keyId}' is not trusted`, 'PACKAGE_KEY_UNTRUSTED');
  if (revokedKeyIds.includes(keyId)) throw packageError(`Package signing key '${keyId}' is revoked`, 'PACKAGE_KEY_REVOKED');
  const packageRevision = `${statement.package_type}:${statement.package_id}@${statement.version}`;
  if (revokedPackages.includes(packageRevision)) throw packageError(`Package '${packageRevision}' is revoked`, 'PACKAGE_REVOKED');

  let publicKey;
  try {
    publicKey = parseEd25519PublicKey(trustedKeys[keyId]);
  } catch {
    throw packageError(`Trusted key '${keyId}' is not a valid Ed25519 public key`, 'PACKAGE_TRUST_KEY_INVALID');
  }
  const signatureBytes = decodeSignature(signature);
  if (!verify(null, Buffer.from(canonicalJson(statement)), publicKey, signatureBytes))
    throw packageError('Package signature verification failed', 'PACKAGE_SIGNATURE_INVALID');

  const files = new Map();
  let totalBytes = 0;
  for (const entry of statement.files) {
    const bytes = await readEntry(entry);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== entry.sha256) throw packageError(`Package file digest mismatch: ${entry.path}`, 'PACKAGE_FILE_DIGEST_INVALID');
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_PACKAGE_BYTES) throw packageError('Package exceeds the total size limit', 'PACKAGE_TOO_LARGE');
    if (retainFiles || entry.path === 'SKILL.md' || entry.path === statement.entry_point) files.set(entry.path, bytes);
  }
  const actualPaths = await listActualPaths();
  const expectedPaths = new Set([MANIFEST_NAME, ...statement.files.map((file) => file.path)]);
  if (actualPaths.size !== expectedPaths.size || [...actualPaths].some((file) => !expectedPaths.has(file)))
    throw packageError('Package contains undeclared or missing files', 'PACKAGE_FILE_SET_INVALID');
  return {
    manifest: { ...statement, signature },
    root,
    files,
    totalBytes,
    packageRevision,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    ...(retainFiles ? { manifestBytes } : {}),
  };
}

/** Install verified bytes into a version-addressed immutable directory. Does not enable or execute a package. */
export async function installSignedPackage(packageRoot, options = {}) {
  const verified = await verifySignedPackage(packageRoot, { ...options, retainFiles: true });
  return installVerifiedPackage(verified, options);
}

export async function installSignedPackageBundle(bundleBytes, options = {}) {
  const verified = await verifySignedPackageBundle(bundleBytes, { ...options, retainFiles: true });
  if (options.expectedManifestSha256 && verified.manifestSha256 !== options.expectedManifestSha256)
    throw packageError('Package manifest digest does not match authenticated update metadata', 'PACKAGE_UPDATE_DIGEST_MISMATCH');
  for (const field of ['package_type', 'package_id', 'version']) {
    if (options.expectedPackage?.[field] !== undefined && verified.manifest[field] !== options.expectedPackage[field])
      throw packageError(`Package ${field} does not match authenticated update metadata`, 'PACKAGE_UPDATE_IDENTITY_MISMATCH');
  }
  return installVerifiedPackage(verified, options);
}

async function installVerifiedPackage(verified, options) {
  const installRoot = await resolveInstallRoot(options.installRoot);
  const packageDirectory = path.join(installRoot, verified.manifest.package_type, verified.manifest.package_id);
  const destination = path.join(packageDirectory, verified.manifest.version);
  const staging = path.join(installRoot, `.staging-${randomUUID()}`);
  const release = await acquirePackageInstallLock(installRoot);
  try {
    await ensureSafeDirectory(installRoot, verified.manifest.package_type, verified.manifest.package_id);
    try {
      await fs.lstat(destination);
      throw packageError(`Package version is already installed at ${destination}`, 'PACKAGE_VERSION_EXISTS');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await fs.mkdir(staging, { recursive: false, mode: 0o700 });
    for (const [relativePath, bytes] of verified.files) {
      const target = path.join(staging, ...relativePath.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    }
    const manifestBytes = verified.manifestBytes || Buffer.from(`${JSON.stringify(verified.manifest, null, 2)}\n`);
    await fs.writeFile(path.join(staging, MANIFEST_NAME), manifestBytes, {
      flag: 'wx',
      mode: 0o600,
    });
    await renameStagedPackage(staging, destination);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await release();
  }
  return {
    package_id: verified.manifest.package_id,
    package_type: verified.manifest.package_type,
    version: verified.manifest.version,
    key_id: verified.manifest.key_id,
    capability_schema: verified.manifest.capability_schema ?? null,
    declared_capabilities: verified.manifest.capabilities || [],
    entry_point: verified.manifest.entry_point ?? null,
    path: destination,
    enabled: false,
  };
}

async function renameStagedPackage(staging, destination) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fs.rename(staging, destination);
      return;
    } catch (error) {
      if (error.code === 'EEXIST' || error.code === 'ENOTEMPTY')
        throw packageError(`Package version is already installed at ${destination}`, 'PACKAGE_VERSION_EXISTS');
      if (error.code !== 'EPERM' || process.platform !== 'win32') throw error;
      // Windows can transiently deny a directory rename; report a collision only when the destination exists.
      try {
        await fs.lstat(destination);
        throw packageError(`Package version is already installed at ${destination}`, 'PACKAGE_VERSION_EXISTS');
      } catch (destinationError) {
        if (destinationError.code !== 'ENOENT') throw destinationError;
      }
      if (attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

export function packageKeyFingerprint(publicKey) {
  const key = parseEd25519PublicKey(publicKey);
  return createHash('sha256')
    .update(key.export({ type: 'spki', format: 'der' }))
    .digest('hex');
}

function parseEd25519PublicKey(value) {
  if (typeof value !== 'string' || !/^-----BEGIN PUBLIC KEY-----\s/.test(value.trim()))
    throw new TypeError('Trusted key must be an Ed25519 public-key PEM');
  const key = createPublicKey(value);
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('Public key must be Ed25519');
  return key;
}

function validateManifest(manifest) {
  if (!isRecord(manifest) || typeof manifest.signature !== 'string')
    throw packageError('Package manifest is missing required fields', 'PACKAGE_MANIFEST_INVALID');
  const { signature, ...statement } = manifest;
  return { statement: validateStatement(statement), signature };
}

function validateStatement(statement) {
  if (!isRecord(statement)) throw packageError('Package statement must be an object', 'PACKAGE_MANIFEST_INVALID');
  const required = ['files', 'key_id', 'package_id', 'package_type', 'schema_version', 'version'];
  const actualKeys = Object.keys(statement).sort();
  const legacyKeys = required;
  const capabilityKeys = [...required, 'capabilities', 'capability_schema'].sort();
  const entryPointKeys = [...capabilityKeys, 'entry_point'].sort();
  const hasCapabilities = Object.hasOwn(statement, 'capabilities') || Object.hasOwn(statement, 'capability_schema');
  const hasEntryPoint = Object.hasOwn(statement, 'entry_point');
  if (
    (hasEntryPoint && actualKeys.join('\0') !== entryPointKeys.join('\0')) ||
    (!hasEntryPoint && hasCapabilities && actualKeys.join('\0') !== capabilityKeys.join('\0')) ||
    (!hasEntryPoint && !hasCapabilities && actualKeys.join('\0') !== legacyKeys.join('\0'))
  )
    throw packageError('Package statement has missing or unsupported fields', 'PACKAGE_MANIFEST_INVALID');
  if (statement.schema_version !== 1) throw packageError('Unsupported package manifest version', 'PACKAGE_MANIFEST_VERSION_UNSUPPORTED');
  if (hasCapabilities) validateCapabilities(statement);
  if (typeof statement.package_id !== 'string' || !PACKAGE_ID.test(statement.package_id) || statement.package_id.length > 96)
    throw packageError('Invalid package_id', 'PACKAGE_MANIFEST_INVALID');
  if (!['skill', 'mcp'].includes(statement.package_type)) throw packageError('Invalid package_type', 'PACKAGE_MANIFEST_INVALID');
  if (statement.package_type === 'skill' && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(statement.package_id))
    throw packageError('Skill package_id must match the lowercase hyphenated skill name format', 'PACKAGE_MANIFEST_INVALID');
  if (typeof statement.version !== 'string' || !VERSION.test(statement.version) || statement.version.length > 128)
    throw packageError('Package version must be semantic x.y.z', 'PACKAGE_MANIFEST_INVALID');
  if (typeof statement.key_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(statement.key_id))
    throw packageError('Invalid key_id', 'PACKAGE_MANIFEST_INVALID');
  if (!Array.isArray(statement.files) || statement.files.length < 1 || statement.files.length > MAX_PACKAGE_FILES)
    throw packageError(`Package must declare between 1 and ${MAX_PACKAGE_FILES} files`, 'PACKAGE_MANIFEST_INVALID');
  const names = new Set();
  const portableNames = new Set();
  let declaredBytes = 0;
  for (const file of statement.files) {
    if (!isRecord(file) || Object.keys(file).sort().join('\0') !== ['path', 'sha256', 'size'].join('\0'))
      throw packageError('Invalid package file record', 'PACKAGE_MANIFEST_INVALID');
    if (typeof file.path !== 'string' || !isSafePackagePath(file.path) || file.path.toLowerCase() === MANIFEST_NAME)
      throw packageError('Package paths must be normalized relative paths without traversal', 'PACKAGE_PATH_INVALID');
    if (names.has(file.path)) throw packageError(`Duplicate package path: ${file.path}`, 'PACKAGE_PATH_INVALID');
    const portableName = file.path.toLowerCase();
    const prefixes = file.path.split('/').map((_part, index, parts) =>
      parts
        .slice(0, index + 1)
        .join('/')
        .toLowerCase(),
    );
    if (
      prefixes.some((prefix) => portableNames.has(prefix)) ||
      [...portableNames].some((existing) => existing.startsWith(`${portableName}/`))
    )
      throw packageError(`Package paths collide on a supported platform: ${file.path}`, 'PACKAGE_PATH_INVALID');
    names.add(file.path);
    portableNames.add(portableName);
    if (typeof file.sha256 !== 'string' || !SHA256.test(file.sha256))
      throw packageError(`Invalid digest for ${file.path}`, 'PACKAGE_MANIFEST_INVALID');
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES)
      throw packageError(`Invalid or oversized file length for ${file.path}`, 'PACKAGE_TOO_LARGE');
    declaredBytes += file.size;
    if (declaredBytes > MAX_PACKAGE_BYTES) throw packageError('Package exceeds the total size limit', 'PACKAGE_TOO_LARGE');
  }
  statement.files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  if (hasEntryPoint) {
    if (
      statement.package_type !== 'mcp' ||
      typeof statement.entry_point !== 'string' ||
      !isSafePackagePath(statement.entry_point) ||
      !statement.entry_point.endsWith('.mjs') ||
      !names.has(statement.entry_point)
    )
      throw packageError('MCP entry_point must name an included .mjs payload file', 'PACKAGE_ENTRY_POINT_INVALID');
    if (
      !hasCapabilities ||
      !statement.capabilities.some((capability) => capability.name === 'process.execute' && capability.scope === 'configured')
    )
      throw packageError('MCP entry_point requires a signed process.execute capability declaration', 'PACKAGE_CAPABILITY_INVALID');
  }
  if (hasCapabilities) {
    statement.capabilities.sort((left, right) => left.name.localeCompare(right.name, 'en') || left.scope.localeCompare(right.scope, 'en'));
  }
  return statement;
}

function validateCapabilities(statement) {
  if (statement.capability_schema !== 1)
    throw packageError('Unsupported package capability schema', 'PACKAGE_CAPABILITY_SCHEMA_UNSUPPORTED');
  if (
    !Array.isArray(statement.capabilities) ||
    statement.capabilities.length > MAX_PACKAGE_CAPABILITIES ||
    statement.capabilities.some((capability) => !isRecord(capability))
  )
    throw packageError(`Package capabilities must contain at most ${MAX_PACKAGE_CAPABILITIES} entries`, 'PACKAGE_CAPABILITY_INVALID');
  if (statement.package_type === 'skill' && statement.capabilities.length > 0)
    throw packageError('Instruction-only skill packages cannot request executable capabilities', 'PACKAGE_CAPABILITY_INVALID');

  const seen = new Set();
  for (const capability of statement.capabilities) {
    if (Object.keys(capability).sort().join('\0') !== ['name', 'reason', 'scope'].join('\0'))
      throw packageError('Package capability must contain exactly name, reason, and scope', 'PACKAGE_CAPABILITY_INVALID');
    const { name, reason, scope } = capability;
    const allowedScopes = CAPABILITY_SCOPES.get(name);
    if (typeof name !== 'string' || (!allowedScopes && name !== 'network.connect'))
      throw packageError(`Unsupported package capability: ${String(name)}`, 'PACKAGE_CAPABILITY_INVALID');
    if (typeof reason !== 'string' || !reason.trim() || reason !== reason.trim() || reason.length > 240 || /[\p{Cc}\p{Cf}]/u.test(reason))
      throw packageError('Package capability reason must contain 1-240 printable characters', 'PACKAGE_CAPABILITY_INVALID');
    if (typeof scope !== 'string' || !scope || scope.includes('*') || scope.length > 512)
      throw packageError('Package capability scope is invalid or too broad', 'PACKAGE_CAPABILITY_SCOPE_INVALID');
    if (name === 'network.connect' ? !isAllowedNetworkOrigin(scope) : !allowedScopes.has(scope))
      throw packageError(`Invalid scope for package capability '${name}'`, 'PACKAGE_CAPABILITY_SCOPE_INVALID');
    const identity = `${name}\0${scope}`;
    if (seen.has(identity)) throw packageError(`Duplicate package capability '${name}' for scope '${scope}'`, 'PACKAGE_CAPABILITY_INVALID');
    seen.add(identity);
  }
}

function isAllowedNetworkOrigin(value) {
  try {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password || url.search || url.hash || url.pathname !== '/') return false;
    if (url.protocol === 'https:') return true;
    if (url.protocol !== 'http:') return false;
    const hostname = url.hostname.toLowerCase();
    return hostname === 'localhost' || (net.isIP(hostname) === 4 && hostname.split('.')[0] === '127') || hostname === '[::1]';
  } catch {
    return false;
  }
}

function isSafePackagePath(value) {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    value.split('/').every((part) => {
      const stem = part.split('.')[0].toUpperCase();
      return (
        /^[A-Za-z0-9._-]+$/.test(part) &&
        part !== '.' &&
        part !== '..' &&
        !part.endsWith('.') &&
        !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)
      );
    })
  );
}

async function resolvePackageRoot(packageRoot) {
  if (typeof packageRoot !== 'string' || !path.isAbsolute(packageRoot))
    throw new TypeError('packageRoot must be an absolute directory path');
  const before = await fs.lstat(packageRoot);
  if (before.isSymbolicLink() || !before.isDirectory())
    throw packageError('Package root must be a regular directory', 'PACKAGE_ROOT_INVALID');
  const root = await fs.realpath(packageRoot);
  return root;
}

async function resolveInstallRoot(installRoot) {
  if (typeof installRoot !== 'string' || !path.isAbsolute(installRoot))
    throw new TypeError('installRoot must be an absolute directory path');
  await fs.mkdir(installRoot, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(installRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw packageError('Install root must be a regular directory', 'PACKAGE_INSTALL_ROOT_INVALID');
  return fs.realpath(installRoot);
}

async function ensureSafeDirectory(root, ...segments) {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      await fs.mkdir(current, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw packageError('Package installation path contains a symbolic link or non-directory', 'PACKAGE_INSTALL_PATH_INVALID');
    const real = await fs.realpath(current);
    const relative = path.relative(root, real);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw packageError('Package installation path escapes its install root', 'PACKAGE_INSTALL_PATH_INVALID');
    current = real;
  }
  return current;
}

export async function acquirePackageInstallLock(installRoot) {
  const lockPath = path.join(installRoot, '.install.lock');
  let handle;
  try {
    handle = await fs.open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST')
      throw packageError('Another extension package install is active; inspect .install.lock before retrying', 'PACKAGE_INSTALL_BUSY');
    throw error;
  }
  const identity = await handle.stat();
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  } catch (error) {
    await handle.close().catch(() => {});
    try {
      const current = await fs.lstat(lockPath);
      if (current.dev === identity.dev && current.ino === identity.ino) await fs.unlink(lockPath);
    } catch {
      /* Preserve the original lock-write failure. */
    }
    throw error;
  }
  return async () => {
    await handle.close().catch(() => {});
    try {
      const current = await fs.lstat(lockPath);
      if (current.dev === identity.dev && current.ino === identity.ino) await fs.unlink(lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  };
}

async function readPackageEntry(root, relativePath, expectedSize) {
  let current = root;
  const parts = relativePath.split('/');
  for (const segment of parts.slice(0, -1)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw packageError(`Package path is not a regular directory: ${relativePath}`, 'PACKAGE_PATH_INVALID');
  }
  return readRegularFile(path.join(current, parts.at(-1)), Math.min(MAX_FILE_BYTES, expectedSize), expectedSize);
}

async function readRegularFile(filePath, maxBytes, exactBytes = undefined) {
  const before = await fs.lstat(filePath);
  if (before.isSymbolicLink() || !before.isFile()) throw packageError('Package entries must be regular files', 'PACKAGE_PATH_INVALID');
  if (before.size > maxBytes || (exactBytes !== undefined && before.size !== exactBytes))
    throw packageError('Package file size does not match its manifest or exceeds the limit', 'PACKAGE_FILE_SIZE_INVALID');
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
      throw packageError('Package file changed while being verified', 'PACKAGE_CHANGED_DURING_VERIFY');
    const chunks = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw packageError('Package file grew beyond its size limit while being read', 'PACKAGE_TOO_LARGE');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    if (total !== before.size || (exactBytes !== undefined && total !== exactBytes))
      throw packageError('Package file changed while being verified', 'PACKAGE_CHANGED_DURING_VERIFY');
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

async function listPackageFiles(root) {
  const found = new Set();
  let visitedEntries = 0;
  const visit = async (directory, prefix = '') => {
    if (prefix.split('/').length > 32) throw packageError('Package directory nesting exceeds the limit', 'PACKAGE_TOO_LARGE');
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      visitedEntries += 1;
      if (visitedEntries > (MAX_PACKAGE_FILES + 1) * 2)
        throw packageError('Package contains too many filesystem entries', 'PACKAGE_TOO_LARGE');
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (relative.length > 512) throw packageError('Package path exceeds the length limit', 'PACKAGE_PATH_INVALID');
      if (entry.isSymbolicLink()) throw packageError(`Package contains a symbolic link: ${relative}`, 'PACKAGE_PATH_INVALID');
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative);
      else if (entry.isFile()) found.add(relative);
      else throw packageError(`Package contains an unsupported filesystem entry: ${relative}`, 'PACKAGE_PATH_INVALID');
      if (found.size > MAX_PACKAGE_FILES + 1) throw packageError('Package contains too many files', 'PACKAGE_TOO_LARGE');
    }
  };
  await visit(root);
  return found;
}

function decodeSignature(value) {
  if (typeof value !== 'string' || value.length > 256 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw packageError('Invalid package signature encoding', 'PACKAGE_SIGNATURE_INVALID');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== value)
    throw packageError('Invalid package signature encoding', 'PACKAGE_SIGNATURE_INVALID');
  return bytes;
}

function decodeBase64(value, maxBytes, label) {
  if (
    typeof value !== 'string' ||
    value.length > Math.ceil(maxBytes / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    throw packageError(`Invalid base64 package bundle data: ${label}`, 'PACKAGE_BUNDLE_INVALID');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.byteLength > maxBytes || bytes.toString('base64') !== value)
    throw packageError(`Invalid base64 package bundle data: ${label}`, 'PACKAGE_BUNDLE_INVALID');
  return bytes;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function packageError(message, code) {
  return Object.assign(new Error(message), { code });
}
