import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');
const RELEASE_ROOTS = [
  '.editorconfig',
  '.gitattributes',
  '.gitignore',
  'BUILD_PLAN.md',
  '.github',
  'biome.json',
  'CHANGELOG.md',
  'BUILD_ROADMAP.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'README.md',
  'config.example.toml',
  'package.json',
  'pnpm-lock.yaml',
  'docs',
  'eval',
  'examples',
  'gui',
  'licenses',
  'scripts',
  'src',
  'tests',
  'vscode',
];
const PLATFORM_GENERATED_SOURCE_FILES = new Set([
  'gui/desktop/src-tauri/gen/schemas/linux-schema.json',
  'gui/desktop/src-tauri/gen/schemas/windows-schema.json',
]);
const MAX_FILES = 20_000;
const MAX_SOURCE_BYTES = 512 * 1024 * 1024;

export async function buildReleaseArchive({ outputDirectory = path.join(ROOT, 'dist', 'release') } = {}) {
  const packageInfo = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(packageInfo.version || ''))
    throw new Error('package.json must contain a valid release version');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(packageInfo.name || '')) throw new Error('package.json must contain a safe package name');
  await assertProductVersionAlignment(packageInfo.version);
  const archiveName = `${packageInfo.name}-v${packageInfo.version}-source.tar.gz`;
  const packageDirectory = `${packageInfo.name}-v${packageInfo.version}`;
  const records = [];
  let totalBytes = 0;

  for (const rootEntry of RELEASE_ROOTS) {
    const absolute = path.join(ROOT, rootEntry);
    let stat;
    try {
      stat = await fs.lstat(absolute);
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Release source is missing: ${rootEntry}`);
      throw error;
    }
    await collect(absolute, rootEntry, stat, records);
  }
  if (records.length > MAX_FILES) throw new Error(`Release source has more than ${MAX_FILES} entries`);
  records.sort((a, b) => comparePaths(a.archivePath, b.archivePath));

  const contentEntries = [];
  const manifestFiles = [];
  for (const record of records) {
    if (record.type === 'directory') {
      contentEntries.push({ name: `${packageDirectory}/${record.archivePath}`, type: 'directory', data: Buffer.alloc(0) });
      continue;
    }
    const data = normalizeArchiveText(await fs.readFile(record.absolutePath));
    totalBytes += data.length;
    if (totalBytes > MAX_SOURCE_BYTES) throw new Error(`Release source exceeds ${MAX_SOURCE_BYTES} bytes`);
    manifestFiles.push({ path: record.archivePath, size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
    contentEntries.push({ name: `${packageDirectory}/${record.archivePath}`, type: 'file', data });
  }

  const manifest = {
    schema_version: 1,
    package: packageInfo.name,
    version: packageInfo.version,
    artifact: 'cross-platform-source',
    required_node: packageInfo.engines?.node || null,
    entry_points: ['node src/cli.mjs', 'node src/cli.mjs serve --port 0'],
    excluded_state: [
      '.git',
      '.agent',
      '.test-tmp',
      'node_modules',
      'target',
      'coverage',
      'root dist output',
      'platform-specific generated Tauri schemas',
      'platform-generated Tauri icon variants',
    ],
    files: manifestFiles,
  };
  contentEntries.push({
    name: `${packageDirectory}/release-manifest.json`,
    type: 'file',
    data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
  });
  contentEntries.sort((a, b) => comparePaths(a.name, b.name));

  const tar = Buffer.concat([...contentEntries.map((entry) => encodeTarEntry(entry)), Buffer.alloc(1024)]);
  const archive = gzipSync(tar, { level: 9, mtime: 0 });
  archive[9] = 0xff;
  await fs.mkdir(outputDirectory, { recursive: true });
  const destination = path.join(outputDirectory, archiveName);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  let ownsTemporary = false;
  try {
    const handle = await fs.open(temporary, 'wx');
    ownsTemporary = true;
    try {
      await handle.writeFile(archive);
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(temporary, destination);
    } catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      await replaceExisting(temporary, destination);
    }
  } catch (error) {
    if (ownsTemporary) await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return {
    path: destination,
    bytes: archive.length,
    files: manifestFiles.length,
    sha256: createHash('sha256').update(archive).digest('hex'),
  };
}

export async function assertProductVersionAlignment(productVersion, root = ROOT) {
  const [cargoManifest, tauriConfig, vscodeManifest] = await Promise.all([
    fs.readFile(path.join(root, 'gui', 'desktop', 'src-tauri', 'Cargo.toml'), 'utf8'),
    fs.readFile(path.join(root, 'gui', 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf8'),
    fs.readFile(path.join(root, 'vscode', 'package.json'), 'utf8'),
  ]);
  const cargoVersion = /^version\s*=\s*"([^"]+)"\s*$/m.exec(cargoManifest)?.[1];
  const tauriVersion = JSON.parse(tauriConfig).version;
  const vscodeVersion = JSON.parse(vscodeManifest).version;
  const versions = { package_json: productVersion, cargo_toml: cargoVersion, tauri_config: tauriVersion, vscode_package: vscodeVersion };
  const mismatch = Object.entries(versions).filter(([, version]) => version !== productVersion);
  if (mismatch.length)
    throw new Error(
      `Product version mismatch: ${Object.entries(versions)
        .map(([component, version]) => `${component}=${version ?? '<missing>'}`)
        .join(', ')}`,
    );
  return versions;
}

export function normalizeArchiveText(data) {
  if (!Buffer.isBuffer(data)) throw new TypeError('Archive file data must be a Buffer');
  if (data.includes(0)) return data;
  const text = data.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(data)) return data;
  const normalized = text.replace(/\r\n?/g, '\n');
  return normalized === text ? data : Buffer.from(normalized, 'utf8');
}

async function replaceExisting(temporary, destination) {
  const backup = `${destination}.${randomUUID()}.bak`;
  let hasDestination = false;
  try {
    await fs.rename(destination, backup);
    hasDestination = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    await fs.rename(temporary, destination);
  } catch (error) {
    if (hasDestination)
      await fs.rename(backup, destination).catch((restoreError) => {
        error.restoreError = restoreError;
      });
    throw error;
  }
  if (hasDestination) await fs.rm(backup, { force: true });
}

async function collect(absolutePath, relativePath, stat, records) {
  if (stat.isSymbolicLink()) throw new Error(`Release package does not include symbolic links: ${relativePath}`);
  const archivePath = relativePath.split(path.sep).join('/');
  if (stat.isDirectory()) {
    records.push({ absolutePath, archivePath: `${archivePath}/`, type: 'directory' });
    const children = await fs.readdir(absolutePath, { withFileTypes: true });
    children.sort((a, b) => comparePaths(a.name, b.name));
    for (const child of children) {
      if (['.git', '.agent', '.test-tmp', 'node_modules', 'target', 'coverage'].includes(child.name)) continue;
      const childPath = path.join(absolutePath, child.name);
      await collect(childPath, path.join(relativePath, child.name), await fs.lstat(childPath), records);
      if (records.length > MAX_FILES) throw new Error(`Release source has more than ${MAX_FILES} entries`);
    }
  } else if (stat.isFile() && !PLATFORM_GENERATED_SOURCE_FILES.has(archivePath) && !isGeneratedTauriIcon(archivePath)) {
    records.push({ absolutePath, archivePath, type: 'file' });
  } else if (!stat.isFile()) throw new Error(`Release package contains an unsupported filesystem entry: ${relativePath}`);
}

function isGeneratedTauriIcon(archivePath) {
  return (
    archivePath.startsWith('gui/desktop/src-tauri/icons/') && archivePath !== 'gui/desktop/src-tauri/icons/xyst-ai-assistant-source.png'
  );
}

function encodeTarEntry({ name, type, data }) {
  const normalized = name.replaceAll('\\', '/');
  const fields = splitUstarPath(normalized);
  const header = Buffer.alloc(512);
  writeString(header, 0, 100, fields.name);
  writeOctal(header, 100, 8, type === 'directory' ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, data.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = type === 'directory' ? 0x35 : 0x30;
  writeString(header, 257, 6, 'ustar\0');
  writeString(header, 263, 2, '00');
  if (fields.prefix) writeString(header, 345, 155, fields.prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumText = checksum.toString(8).padStart(6, '0');
  if (checksumText.length > 6) throw new Error('Tar checksum field overflow');
  writeString(header, 148, 8, `${checksumText}\0 `);
  const padding = (512 - (data.length % 512)) % 512;
  return Buffer.concat([header, data, Buffer.alloc(padding)]);
}

function splitUstarPath(value) {
  if (Buffer.byteLength(value) <= 100) return { name: value, prefix: '' };
  for (let index = value.lastIndexOf('/'); index > 0; index = value.lastIndexOf('/', index - 1)) {
    const prefix = value.slice(0, index);
    const name = value.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`Release path cannot be represented in the portable USTAR format: ${value}`);
}

function writeString(buffer, offset, length, value) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > length) throw new Error(`Tar header field exceeds ${length} bytes`);
  bytes.copy(buffer, offset);
}

function writeOctal(buffer, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, '0');
  if (text.length >= length) throw new Error('Tar numeric field overflow');
  writeString(buffer, offset, length, `${text}\0`);
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function main() {
  const args = process.argv.slice(2);
  let outputDirectory;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--output' || outputDirectory || !args[index + 1])
      throw new Error('Usage: node scripts/build-release.mjs [--output <directory>]');
    outputDirectory = path.resolve(args[++index]);
  }
  const result = await buildReleaseArchive({ outputDirectory });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`build-release: ${error.message}\n`);
    process.exitCode = 1;
  });
}
