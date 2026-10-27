import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_SEARCH_DEPTH = 12;
const MAX_SEARCH_DIRECTORIES = 10_000;

export function debianPackageName(productName) {
  if (typeof productName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(productName))
    throw new TypeError('A valid Debian product name is required');
  const name = productName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!name || name.length > 80) throw new TypeError('The product name does not map to a valid Debian package name');
  return name;
}

export async function findDebPackage(directory, { productName, version, architecture } = {}) {
  if (typeof productName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(productName))
    throw new TypeError('A valid Debian product name is required');
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version))
    throw new TypeError('A valid Debian package version is required');
  if (!['amd64', 'arm64'].includes(architecture)) throw new TypeError('A supported Debian package architecture is required');
  const expectedName = `${productName}_${version}_${architecture}.deb`;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const matches = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase() === expectedName.toLowerCase());
  if (matches.length !== 1) throw new Error(`Expected one Debian package named ${expectedName}; found ${matches.length}`);
  return path.join(directory, matches[0].name);
}

export async function findPackagedResources(root) {
  const rootPath = path.resolve(root);
  const pending = [{ directory: rootPath, depth: 0 }];
  let searchedDirectories = 0;

  while (pending.length) {
    const { directory, depth } = pending.pop();
    searchedDirectories += 1;
    if (searchedDirectories > MAX_SEARCH_DIRECTORIES)
      throw new Error(`The DEB payload search exceeded ${MAX_SEARCH_DIRECTORIES} directories`);

    const cli = path.join(directory, 'xyst', 'src', 'cli.mjs');
    const node = path.join(directory, 'xyst', 'runtime', 'node');
    if ((await isRegularFile(cli)) && (await isExecutable(node))) return { cli, node };
    if (depth >= MAX_SEARCH_DEPTH) continue;

    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push({ directory: path.join(directory, entry.name), depth: depth + 1 });
    }
  }

  throw new Error('The DEB payload is missing xyst/src/cli.mjs or executable xyst/runtime/node');
}

export async function findLauncher(root) {
  const rootPath = path.resolve(root);
  const binDirectory = path.join(rootPath, 'usr', 'bin');
  let binInfo;
  try {
    binInfo = await fs.lstat(binDirectory);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('The DEB payload is missing /usr/bin');
    throw error;
  }
  if (binInfo.isSymbolicLink() || !binInfo.isDirectory()) throw new Error('The DEB payload /usr/bin must be a real directory');

  const entries = await fs.readdir(binDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!/^xyst(?:-|$)/i.test(entry.name)) continue;
    const candidate = path.join(binDirectory, entry.name);
    let resolved;
    try {
      resolved = await fs.realpath(candidate);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }

    const relative = path.relative(rootPath, resolved);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error(`Package launcher escapes extracted payload: ${entry.name}`);
    if (await isExecutable(resolved)) return candidate;
  }

  throw new Error('The DEB payload is missing an executable Xyst AI Assistant launcher in /usr/bin');
}

export async function isRegularFile(filePath) {
  const stat = await fs.lstat(filePath).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  return Boolean(stat?.isFile() && !stat.isSymbolicLink());
}

async function isExecutable(filePath) {
  const stat = await fs.stat(filePath).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  return Boolean(stat?.isFile() && (stat.mode & 0o111) !== 0);
}
