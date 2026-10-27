import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteJson, restoreAtomicWriteBackup } from '../platform/files.mjs';
import { acquirePackageInstallLock, verifySignedPackage } from './signed-packages.mjs';
import { getCachedRevocations } from './revocation-feed.mjs';

const REGISTRY_NAME = 'registry.json';
const MAX_REGISTRY_BYTES = 256 * 1024;
const MAX_PACKAGES = 512;
const MAX_INSTALLED_PACKAGE_VERSIONS = 4_096;
const MAX_HISTORY = 10;
const MAX_ACTIVE_SKILLS = 128;
const MAX_ACTIVE_MCP_PACKAGES = 16;
const MAX_SKILL_SOURCE_BYTES = 50_000;
const PACKAGE_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SEMVER_IDENTIFIER = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const VERSION = new RegExp(
  `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${SEMVER_IDENTIFIER}(?:\\.${SEMVER_IDENTIFIER})*))?(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$`,
);

export function installedPackageTrustFromConfig(config) {
  const extensionConfig = config.extensions || {};
  if (!config._source?.userPath) return null;
  return {
    installRoot: extensionConfig.install_directory || path.join(path.dirname(config._source.userPath), 'extensions'),
    trustedKeys: extensionConfig.trusted_keys || {},
    revokedKeyIds: extensionConfig.revoked_key_ids || [],
    revokedPackages: extensionConfig.revoked_packages || [],
    revocationUrl: extensionConfig.revocation_url,
    revocationKeyId: extensionConfig.revocation_key_id,
    revocationMaxAgeHours: extensionConfig.revocation_max_age_hours || 72,
  };
}

export async function activateInstalledSkill({ installRoot, packageId, version, trustedKeys, revokedKeyIds = [], revokedPackages = [] }) {
  validateCoordinates('skill', packageId, version);
  return updateRegistry(installRoot, async (state, root) => {
    const verified = await verifyInstalled(root, 'skill', packageId, version, { trustedKeys, revokedKeyIds, revokedPackages });
    validateSkillPayload(verified);
    const key = `skill:${packageId}`;
    const current = state.packages[key] || { package_type: 'skill', package_id: packageId, active_version: null, previous_versions: [] };
    if (current.active_version === version) return { state, result: { changed: false, active_version: version } };
    if (!state.packages[key] && Object.keys(state.packages).length >= MAX_PACKAGES)
      throw registryError('Extension registry exceeds its package limit', 'PACKAGE_REGISTRY_LIMIT');
    const history = current.previous_versions.filter((item) => item !== version);
    if (current.active_version) history.unshift(current.active_version);
    state.packages[key] = { ...current, active_version: version, previous_versions: history.slice(0, MAX_HISTORY) };
    return { state, result: { changed: true, active_version: version, package_revision: verified.packageRevision } };
  });
}

export async function activateInstalledMcpPackage({
  installRoot,
  packageId,
  version,
  trustedKeys,
  revokedKeyIds = [],
  revokedPackages = [],
}) {
  validateCoordinates('mcp', packageId, version);
  return updateRegistry(installRoot, async (state, root) => {
    const verified = await verifyInstalled(root, 'mcp', packageId, version, { trustedKeys, revokedKeyIds, revokedPackages });
    validateMcpPayload(verified);
    const key = `mcp:${packageId}`;
    const current = state.packages[key] || { package_type: 'mcp', package_id: packageId, active_version: null, previous_versions: [] };
    if (current.active_version === version) return { state, result: { changed: false, active_version: version } };
    if (!state.packages[key] && Object.keys(state.packages).length >= MAX_PACKAGES)
      throw registryError('Extension registry exceeds its package limit', 'PACKAGE_REGISTRY_LIMIT');
    const history = current.previous_versions.filter((item) => item !== version);
    if (current.active_version) history.unshift(current.active_version);
    state.packages[key] = { ...current, active_version: version, previous_versions: history.slice(0, MAX_HISTORY) };
    return { state, result: { changed: true, active_version: version, package_revision: verified.packageRevision } };
  });
}

export async function disableInstalledSkill({ installRoot, packageId }) {
  validateCoordinates('skill', packageId, '0.0.0');
  return updateRegistry(installRoot, async (state) => {
    const key = `skill:${packageId}`;
    const current = state.packages[key];
    if (!current?.active_version) return { state, result: { changed: false, active_version: null } };
    state.packages[key] = {
      ...current,
      active_version: null,
      previous_versions: [current.active_version, ...current.previous_versions.filter((item) => item !== current.active_version)].slice(
        0,
        MAX_HISTORY,
      ),
    };
    return { state, result: { changed: true, active_version: null } };
  });
}

export async function disableInstalledMcpPackage({ installRoot, packageId }) {
  validateCoordinates('mcp', packageId, '0.0.0');
  return updateRegistry(installRoot, async (state) => {
    const key = `mcp:${packageId}`;
    const current = state.packages[key];
    if (!current?.active_version) return { state, result: { changed: false, active_version: null } };
    state.packages[key] = { ...current, active_version: null };
    return { state, result: { changed: true, active_version: null } };
  });
}

export async function rollbackInstalledSkill({ installRoot, packageId, trustedKeys, revokedKeyIds = [], revokedPackages = [] }) {
  validateCoordinates('skill', packageId, '0.0.0');
  return updateRegistry(installRoot, async (state, root) => {
    const key = `skill:${packageId}`;
    const current = state.packages[key];
    if (!current?.active_version || !current.previous_versions.length)
      throw registryError(`No previous installed version is available for skill '${packageId}'`, 'PACKAGE_ROLLBACK_UNAVAILABLE');
    const version = current.previous_versions[0];
    const verified = await verifyInstalled(root, 'skill', packageId, version, { trustedKeys, revokedKeyIds, revokedPackages });
    const history = current.previous_versions.slice(1).filter((item) => item !== current.active_version);
    history.unshift(current.active_version);
    state.packages[key] = { ...current, active_version: version, previous_versions: history.slice(0, MAX_HISTORY) };
    return { state, result: { changed: true, active_version: version, package_revision: verified.packageRevision } };
  });
}

export async function rollbackInstalledMcpPackage({ installRoot, packageId, trustedKeys, revokedKeyIds = [], revokedPackages = [] }) {
  validateCoordinates('mcp', packageId, '0.0.0');
  return updateRegistry(installRoot, async (state, root) => {
    const key = `mcp:${packageId}`;
    const current = state.packages[key];
    if (!current?.active_version || !current.previous_versions.length)
      throw registryError(`No previous installed version is available for MCP package '${packageId}'`, 'PACKAGE_ROLLBACK_UNAVAILABLE');
    const version = current.previous_versions[0];
    const verified = await verifyInstalled(root, 'mcp', packageId, version, { trustedKeys, revokedKeyIds, revokedPackages });
    validateMcpPayload(verified);
    const history = current.previous_versions.slice(1).filter((item) => item !== current.active_version);
    history.unshift(current.active_version);
    state.packages[key] = { ...current, active_version: version, previous_versions: history.slice(0, MAX_HISTORY) };
    return { state, result: { changed: true, active_version: version, package_revision: verified.packageRevision } };
  });
}

/** Return active packages only after revalidating signatures, revocations, and every installed file. */
export async function getActiveInstalledPackages({
  installRoot,
  trustedKeys,
  revokedKeyIds = [],
  revokedPackages = [],
  revocationUrl,
  revocationKeyId,
  revocationMaxAgeHours,
} = {}) {
  let root;
  try {
    root = await resolveInstallRoot(installRoot);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const state = await readRegistry(root);
  ({ revokedKeyIds, revokedPackages } = await mergeCachedRevocations({
    state,
    root,
    trustedKeys,
    revokedKeyIds,
    revokedPackages,
    revocationUrl,
    revocationKeyId,
    revocationMaxAgeHours,
  }));
  const active = [];
  for (const record of Object.values(state.packages)) {
    if (!record.active_version) continue;
    if (record.package_type !== 'skill') continue;
    if (active.length >= MAX_ACTIVE_SKILLS) throw registryError('Active installed skills exceed the runtime limit', 'PACKAGE_SKILL_LIMIT');
    const verified = await verifyInstalled(root, 'skill', record.package_id, record.active_version, {
      trustedKeys,
      revokedKeyIds,
      revokedPackages,
      retainFiles: false,
    });
    validateSkillPayload(verified);
    active.push({ ...verified, package_id: record.package_id, version: record.active_version });
  }
  return active;
}

/** Return active MCP packages only after current signature, revocation, and payload checks. */
export async function getActiveInstalledMcpPackages(options = {}) {
  let {
    installRoot,
    trustedKeys,
    revokedKeyIds = [],
    revokedPackages = [],
    revocationUrl,
    revocationKeyId,
    revocationMaxAgeHours,
  } = options;
  let root;
  try {
    root = await resolveInstallRoot(installRoot);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const state = await readRegistry(root);
  ({ revokedKeyIds, revokedPackages } = await mergeCachedRevocations({
    state,
    root,
    trustedKeys,
    revokedKeyIds,
    revokedPackages,
    revocationUrl,
    revocationKeyId,
    revocationMaxAgeHours,
  }));
  const active = [];
  for (const record of Object.values(state.packages)) {
    if (!record.active_version || record.package_type !== 'mcp') continue;
    if (active.length >= MAX_ACTIVE_MCP_PACKAGES) throw registryError('Active MCP packages exceed the runtime limit', 'PACKAGE_MCP_LIMIT');
    const verified = await verifyInstalled(root, 'mcp', record.package_id, record.active_version, {
      trustedKeys,
      revokedKeyIds,
      revokedPackages,
      retainFiles: false,
    });
    validateMcpPayload(verified);
    active.push({ ...verified, package_id: record.package_id, version: record.active_version });
  }
  return active;
}

export async function listInstalledPackageActivations({ installRoot } = {}) {
  const root = await resolveInstallRoot(installRoot);
  const state = await readRegistry(root);
  return Object.values(state.packages)
    .map((record) => ({ ...record }))
    .sort((a, b) => a.package_type.localeCompare(b.package_type) || a.package_id.localeCompare(b.package_id));
}

/** List filesystem coordinates only; activation revalidates every package signature and payload. */
export async function listInstalledSkillVersions({ installRoot } = {}) {
  return listInstalledPackageVersions({
    installRoot,
    packageType: 'skill',
    packageIdPattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    label: 'skill',
  });
}

/** List installed signed MCP package version coordinates without reading package contents. */
export async function listInstalledMcpVersions({ installRoot } = {}) {
  return listInstalledPackageVersions({ installRoot, packageType: 'mcp', packageIdPattern: PACKAGE_ID, label: 'MCP' });
}

async function listInstalledPackageVersions({ installRoot, packageType, packageIdPattern, label }) {
  let root;
  try {
    root = await resolveInstallRoot(installRoot);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const packageRoot = path.join(root, packageType);
  let packageRootInfo;
  try {
    packageRootInfo = await fs.lstat(packageRoot);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (packageRootInfo.isSymbolicLink() || !packageRootInfo.isDirectory())
    throw registryError(`Installed ${label} directory must be a regular directory`, 'PACKAGE_INSTALL_ROOT_INVALID');
  const packageEntries = await fs.readdir(packageRoot, { withFileTypes: true });
  if (packageEntries.length > MAX_PACKAGES)
    throw registryError(`Installed ${label} packages exceed the inventory limit`, 'PACKAGE_REGISTRY_LIMIT');
  const installed = [];
  let versionCount = 0;
  for (const entry of packageEntries) {
    if (!packageIdPattern.test(entry.name) || entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const packagePath = path.join(packageRoot, entry.name);
    const packageInfo = await fs.lstat(packagePath);
    if (packageInfo.isSymbolicLink() || !packageInfo.isDirectory()) continue;
    const versionEntries = await fs.readdir(packagePath, { withFileTypes: true });
    const versions = [];
    for (const versionEntry of versionEntries) {
      if (!VERSION.test(versionEntry.name) || versionEntry.isSymbolicLink() || !versionEntry.isDirectory()) continue;
      const versionPath = path.join(packagePath, versionEntry.name);
      const versionInfo = await fs.lstat(versionPath);
      if (versionInfo.isSymbolicLink() || !versionInfo.isDirectory()) continue;
      versions.push(versionEntry.name);
      versionCount += 1;
      if (versionCount > MAX_INSTALLED_PACKAGE_VERSIONS)
        throw registryError(`Installed ${label} versions exceed the inventory limit`, 'PACKAGE_REGISTRY_LIMIT');
    }
    if (versions.length)
      installed.push({
        package_id: entry.name,
        available_versions: versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true })),
      });
  }
  return installed.sort((a, b) => a.package_id.localeCompare(b.package_id));
}

export async function uninstallInstalledPackage({ installRoot, packageType, packageId }) {
  validateCoordinates(packageType, packageId, '0.0.0');
  const root = await resolveInstallRoot(installRoot);
  const releaseInstall = await acquirePackageInstallLock(root);
  try {
    return await updateRegistry(root, async (state, resolvedRoot) => {
      const key = `${packageType}:${packageId}`;
      const activation = state.packages[key];
      if (activation?.active_version) throw registryError('Disable the package before uninstalling it', 'PACKAGE_ACTIVE_UNINSTALL');
      const typePath = path.join(resolvedRoot, packageType);
      let typeInfo;
      try {
        typeInfo = await fs.lstat(typePath);
      } catch (error) {
        if (error.code === 'ENOENT') typeInfo = null;
        else throw error;
      }
      if (typeInfo?.isSymbolicLink() || (typeInfo && !typeInfo.isDirectory()))
        throw registryError('Installed package type directory must be a regular directory', 'PACKAGE_INSTALL_ROOT_INVALID');
      const packagePath = path.join(typePath, packageId);
      let packageInfo;
      try {
        packageInfo = await fs.lstat(packagePath);
      } catch (error) {
        if (error.code === 'ENOENT') packageInfo = null;
        else throw error;
      }
      if (packageInfo?.isSymbolicLink() || (packageInfo && !packageInfo.isDirectory()))
        throw registryError('Installed package directory must be a regular directory', 'PACKAGE_INSTALL_PATH_INVALID');
      if (packageInfo) {
        const realPackagePath = await fs.realpath(packagePath);
        if (realPackagePath !== packagePath)
          throw registryError('Installed package directory does not resolve to its package path', 'PACKAGE_INSTALL_PATH_INVALID');
        await fs.rm(packagePath, { recursive: true, force: false });
      }
      if (activation) delete state.packages[key];
      return {
        state,
        result: {
          changed: Boolean(packageInfo || activation),
          package_type: packageType,
          package_id: packageId,
        },
      };
    });
  } finally {
    await releaseInstall();
  }
}

async function updateRegistry(installRoot, mutate) {
  const root = await resolveInstallRoot(installRoot);
  const release = await acquireRegistryLock(root);
  try {
    await restoreAtomicWriteBackup(path.join(root, REGISTRY_NAME), {
      maxBytes: MAX_REGISTRY_BYTES,
      decode: (serialized) => {
        const state = JSON.parse(serialized);
        validateRegistry(state);
        return state;
      },
    });
    const state = await readRegistry(root);
    const { state: updated, result } = await mutate(state, root);
    if (result.changed) await atomicWriteJson(path.join(root, REGISTRY_NAME), updated, { mode: 0o600 });
    return result;
  } finally {
    await release();
  }
}

async function readRegistry(root) {
  const file = path.join(root, REGISTRY_NAME);
  let info;
  try {
    info = await fs.lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return { schema_version: 1, packages: {} };
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_REGISTRY_BYTES)
    throw registryError('Extension registry must be a bounded regular file', 'PACKAGE_REGISTRY_INVALID');
  let state;
  try {
    state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readRegistryBytes(file, info)));
  } catch {
    throw registryError('Extension registry is unreadable JSON', 'PACKAGE_REGISTRY_INVALID');
  }
  validateRegistry(state);
  return state;
}

async function readRegistryBytes(file, before) {
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(file, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
      throw registryError('Extension registry changed while being read', 'PACKAGE_REGISTRY_INVALID');
    const chunks = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(32 * 1024, MAX_REGISTRY_BYTES + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > MAX_REGISTRY_BYTES) throw registryError('Extension registry exceeds its size limit', 'PACKAGE_REGISTRY_INVALID');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    if (total !== before.size) throw registryError('Extension registry changed while being read', 'PACKAGE_REGISTRY_INVALID');
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

function validateRegistry(state) {
  if (
    !isRecord(state) ||
    Object.keys(state).sort().join(',') !== 'packages,schema_version' ||
    state.schema_version !== 1 ||
    !isRecord(state.packages)
  )
    throw registryError('Extension registry has an unsupported schema', 'PACKAGE_REGISTRY_INVALID');
  const entries = Object.entries(state.packages);
  if (entries.length > MAX_PACKAGES) throw registryError('Extension registry exceeds its package limit', 'PACKAGE_REGISTRY_INVALID');
  for (const [key, record] of entries) {
    if (!isRecord(record) || Object.keys(record).sort().join(',') !== 'active_version,package_id,package_type,previous_versions')
      throw registryError('Extension registry contains an invalid package record', 'PACKAGE_REGISTRY_INVALID');
    validateCoordinates(record.package_type, record.package_id, record.active_version || '0.0.0');
    if (key !== `${record.package_type}:${record.package_id}` || !['skill', 'mcp'].includes(record.package_type))
      throw registryError('Extension registry package key does not match its record', 'PACKAGE_REGISTRY_INVALID');
    if (record.active_version !== null && (typeof record.active_version !== 'string' || !VERSION.test(record.active_version)))
      throw registryError('Extension registry active version is invalid', 'PACKAGE_REGISTRY_INVALID');
    if (
      !Array.isArray(record.previous_versions) ||
      record.previous_versions.length > MAX_HISTORY ||
      record.previous_versions.some((version) => typeof version !== 'string' || !VERSION.test(version)) ||
      new Set(record.previous_versions).size !== record.previous_versions.length ||
      (record.active_version && record.previous_versions.includes(record.active_version))
    )
      throw registryError('Extension registry version history is invalid', 'PACKAGE_REGISTRY_INVALID');
  }
}

async function verifyInstalled(root, packageType, packageId, version, trust) {
  const destination = path.join(root, packageType, packageId, version);
  const verified = await verifySignedPackage(destination, trust);
  if (verified.manifest.package_type !== packageType || verified.manifest.package_id !== packageId || verified.manifest.version !== version)
    throw registryError('Installed package path does not match its signed manifest', 'PACKAGE_INSTALL_IDENTITY_MISMATCH');
  return { ...verified, path: verified.root };
}

function validateSkillPayload(verified) {
  const content = verified.files.get('SKILL.md');
  if (!content || content.byteLength > MAX_SKILL_SOURCE_BYTES)
    throw registryError('Signed skill must include a bounded SKILL.md file', 'PACKAGE_SKILL_INVALID');
}

function validateMcpPayload(verified) {
  const entryPoint = verified.manifest.entry_point;
  if (
    typeof entryPoint !== 'string' ||
    !verified.files.has(entryPoint) ||
    !verified.manifest.capabilities?.some((capability) => capability.name === 'process.execute' && capability.scope === 'configured')
  )
    throw registryError('Signed MCP package requires a verified entry point and process.execute declaration', 'PACKAGE_MCP_INVALID');
}

async function mergeCachedRevocations({
  state,
  root,
  trustedKeys,
  revokedKeyIds,
  revokedPackages,
  revocationUrl,
  revocationKeyId,
  revocationMaxAgeHours,
}) {
  if (!Object.values(state.packages).some((record) => record.active_version)) return { revokedKeyIds, revokedPackages };
  const remote = await getCachedRevocations({
    installRoot: root,
    url: revocationUrl,
    keyId: revocationKeyId,
    trustedKeys,
    maxAgeHours: revocationMaxAgeHours,
  });
  return {
    revokedKeyIds: [...new Set([...revokedKeyIds, ...remote.revokedKeyIds])],
    revokedPackages: [...new Set([...revokedPackages, ...remote.revokedPackages])],
  };
}

function validateCoordinates(packageType, packageId, version) {
  if (!['skill', 'mcp'].includes(packageType) || typeof packageId !== 'string' || !PACKAGE_ID.test(packageId) || packageId.length > 96)
    throw new TypeError('Invalid extension package coordinates');
  if (packageType === 'skill' && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(packageId))
    throw new TypeError('Skill package IDs must match skill names');
  if (typeof version !== 'string' || !VERSION.test(version) || version.length > 128)
    throw new TypeError('Package version must be semantic x.y.z');
}

async function resolveInstallRoot(installRoot) {
  if (typeof installRoot !== 'string' || !path.isAbsolute(installRoot)) throw new TypeError('installRoot must be an absolute path');
  const stat = await fs.lstat(installRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw registryError('Install root must be a regular directory', 'PACKAGE_INSTALL_ROOT_INVALID');
  return fs.realpath(installRoot);
}

async function acquireRegistryLock(root) {
  const lockPath = path.join(root, '.registry.lock');
  let handle;
  try {
    handle = await fs.open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST')
      throw registryError('Another package activation update is active; inspect .registry.lock before retrying', 'PACKAGE_REGISTRY_BUSY');
    throw error;
  }
  const identity = await handle.stat();
  const token = randomUUID();
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
  } catch (error) {
    await handle.close().catch(() => {});
    await removeMatchingLock(lockPath, identity, token).catch(() => {});
    throw error;
  }
  return async () => {
    await handle.close().catch(() => {});
    await removeMatchingLock(lockPath, identity, token);
  };
}

async function removeMatchingLock(lockPath, identity, token) {
  try {
    const current = await fs.lstat(lockPath);
    if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) return;
    const data = await fs.readFile(lockPath, 'utf8');
    if (JSON.parse(data).token === token) await fs.unlink(lockPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function registryError(message, code) {
  return Object.assign(new Error(message), { code });
}
