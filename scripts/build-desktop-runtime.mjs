import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'gui', 'desktop', 'runtime-node.json');
const outputDirectory = path.join(root, 'dist', 'desktop-runtime');
const cacheDirectory = path.join(root, '.toolchains', 'desktop-runtime-cache');
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_RUNTIME_BYTES = 160 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;

export async function readRuntimeSpec(platform = process.platform, arch = process.arch) {
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (
    typeof manifest.version !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
    typeof manifest.release_url !== 'string' ||
    new URL(manifest.release_url).origin !== 'https://nodejs.org'
  ) {
    throw new Error('Desktop Node runtime manifest has an invalid version or release origin');
  }
  const artifact = manifest.artifacts?.[`${platform}-${arch}`];
  if (
    !artifact ||
    typeof artifact.archive !== 'string' ||
    typeof artifact.binary !== 'string' ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256 || '')
  ) {
    throw new Error(`Bundled Node ${manifest.version} is not available for ${platform}-${arch}`);
  }
  return { ...manifest, artifact };
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function downloadVerifiedArchive(spec, temporaryDirectory) {
  const url = new URL(spec.artifact.archive, spec.release_url);
  if (url.protocol !== 'https:' || url.hostname !== 'nodejs.org')
    throw new Error('Desktop runtime URL must use the official Node.js HTTPS origin');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Could not download Node.js runtime (${response.status})`);
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && (declaredLength < 1 || declaredLength > MAX_ARCHIVE_BYTES)) {
    throw new Error(`Node.js archive size is outside the ${MAX_ARCHIVE_BYTES}-byte limit`);
  }
  const chunks = [];
  let receivedBytes = 0;
  for await (const chunk of response.body) {
    receivedBytes += chunk.byteLength;
    if (receivedBytes > MAX_ARCHIVE_BYTES) throw new Error(`Node.js archive exceeds the ${MAX_ARCHIVE_BYTES}-byte limit`);
    chunks.push(Buffer.from(chunk));
  }
  const archive = Buffer.concat(chunks, receivedBytes);
  if (archive.length < 1 || archive.length > MAX_ARCHIVE_BYTES)
    throw new Error(`Node.js archive exceeds the ${MAX_ARCHIVE_BYTES}-byte limit`);
  const digest = sha256Hex(archive);
  if (digest !== spec.artifact.sha256)
    throw new Error(`Node.js archive checksum mismatch: expected ${spec.artifact.sha256}, received ${digest}`);
  const temporaryPath = path.join(temporaryDirectory, spec.artifact.archive);
  const archivePath = path.join(cacheDirectory, spec.artifact.archive);
  await fs.mkdir(cacheDirectory, { recursive: true });
  await fs.writeFile(temporaryPath, archive, { flag: 'wx' });
  try {
    await fs.rename(temporaryPath, archivePath);
  } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EEXIST') throw error;
    await fs.rm(archivePath, { force: true });
    await fs.rename(temporaryPath, archivePath);
  }
  return archivePath;
}

async function extractRuntime(spec, archivePath, destination) {
  if (process.platform === 'win32') {
    const prefix = `node-v${spec.version}-win-${process.arch}`;
    const archive = await fs.readFile(archivePath);
    const files = extractZipEntries(archive, new Set([`${prefix}/${spec.artifact.binary}`, `${prefix}/LICENSE`]));
    const node = path.join(destination, spec.artifact.binary);
    const license = path.join(destination, 'LICENSE');
    await fs.writeFile(node, files.get(`${prefix}/${spec.artifact.binary}`), { flag: 'wx' });
    await fs.writeFile(license, files.get(`${prefix}/LICENSE`), { flag: 'wx' });
    return { node, license };
  }
  const prefix = `node-v${spec.version}-linux-${process.arch}`;
  await execFile(
    'tar',
    ['-xJf', archivePath, '-C', destination, '--strip-components=1', `${prefix}/${spec.artifact.binary}`, `${prefix}/LICENSE`],
    { timeout: DOWNLOAD_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
  );
  return { node: path.join(destination, spec.artifact.binary), license: path.join(destination, 'LICENSE') };
}

export function extractZipEntries(archive, wantedEntries) {
  const files = new Map();
  let endOffset = -1;
  for (let index = archive.length - 22; index >= Math.max(0, archive.length - 65_557); index--) {
    if (archive.readUInt32LE(index) === 0x06054b50) {
      endOffset = index;
      break;
    }
  }
  if (endOffset < 0 || endOffset + 22 > archive.length) throw new Error('Node.js ZIP archive has no valid end record');
  const entryCount = archive.readUInt16LE(endOffset + 10);
  const centralSize = archive.readUInt32LE(endOffset + 12);
  let offset = archive.readUInt32LE(endOffset + 16);
  if (
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    offset === 0xffffffff ||
    offset + centralSize > endOffset ||
    entryCount > 100_000
  ) {
    throw new Error('Node.js ZIP archive uses unsupported or invalid directory metadata');
  }
  let entriesRead = 0;
  while (offset + 46 <= offset + centralSize && entriesRead < entryCount && archive.readUInt32LE(offset) === 0x02014b50) {
    entriesRead++;
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const expectedCrc = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const localOffset = archive.readUInt32LE(offset + 42);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const name = archive.toString('utf8', nameStart, nameStart + nameLength).replaceAll('\\', '/');
    if (wantedEntries.has(name)) {
      if (flags & 1) throw new Error(`Encrypted Node.js archive entry is not supported: ${name}`);
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) throw new Error(`ZIP64 entry is not supported: ${name}`);
      if (uncompressedSize > MAX_RUNTIME_BYTES || localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new Error(`Invalid Node.js ZIP entry: ${name}`);
      }
      const localNameLength = archive.readUInt16LE(localOffset + 26);
      const localExtraLength = archive.readUInt16LE(localOffset + 28);
      const contentStart = localOffset + 30 + localNameLength + localExtraLength;
      const contentEnd = contentStart + compressedSize;
      if (contentEnd > archive.length) throw new Error(`Truncated Node.js ZIP entry: ${name}`);
      const compressed = archive.subarray(contentStart, contentEnd);
      const content =
        method === 0 ? Buffer.from(compressed) : method === 8 ? inflateRawSync(compressed, { maxOutputLength: MAX_ARCHIVE_BYTES }) : null;
      if (!content || content.length !== uncompressedSize || crc32(content) !== expectedCrc) {
        throw new Error(`Unsupported or corrupt Node.js ZIP entry: ${name}`);
      }
      files.set(name, content);
    }
    offset = nameStart + nameLength + extraLength + commentLength;
  }
  if (entriesRead !== entryCount || offset !== archive.readUInt32LE(endOffset + 16) + centralSize) {
    throw new Error('Node.js ZIP archive has a truncated central directory');
  }
  for (const entry of wantedEntries) if (!files.has(entry)) throw new Error(`Node.js ZIP archive is missing ${entry}`);
  return files;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function replaceFile(source, destination) {
  const temporaryPath = `${destination}.${process.pid}.tmp`;
  await fs.copyFile(source, temporaryPath);
  await fs.rm(destination, { force: true });
  await fs.rename(temporaryPath, destination);
}

export async function prepareDesktopRuntime({ platform = process.platform, arch = process.arch } = {}) {
  if (platform !== process.platform || arch !== process.arch)
    throw new Error('Cross-compiling the desktop runtime is not supported; build on the target OS and architecture');
  const spec = await readRuntimeSpec(platform, arch);
  const executableName = platform === 'win32' ? 'node.exe' : 'node';
  const executablePath = path.join(outputDirectory, executableName);
  const licensePath = path.join(outputDirectory, 'LICENSE');
  const markerPath = path.join(outputDirectory, 'runtime-manifest.json');
  try {
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
    const executableHash = await sha256File(executablePath);
    const licenseHash = await sha256File(licensePath);
    if (
      marker.version === spec.version &&
      marker.platform === platform &&
      marker.arch === arch &&
      marker.archive_sha256 === spec.artifact.sha256 &&
      marker.node_sha256 === executableHash &&
      marker.license_sha256 === licenseHash &&
      (await runtimeReportsVersion(executablePath, spec.version))
    ) {
      return { path: executablePath, version: spec.version, reused: true };
    }
  } catch {
    /* Missing or stale staging is replaced from the pinned archive below. */
  }

  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'xyst-desktop-runtime-'));
  try {
    const extractedDirectory = path.join(temporaryDirectory, 'extracted');
    await fs.mkdir(extractedDirectory);
    await fs.mkdir(cacheDirectory, { recursive: true });
    let archivePath = path.join(cacheDirectory, spec.artifact.archive);
    if ((await sha256File(archivePath).catch(() => null)) !== spec.artifact.sha256) {
      archivePath = await downloadVerifiedArchive(spec, temporaryDirectory);
    }
    const extracted = await extractRuntime(spec, archivePath, extractedDirectory);
    for (const filename of [extracted.node, extracted.license]) {
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error('Pinned Node.js package did not contain a regular runtime or license file');
    }
    await fs.mkdir(outputDirectory, { recursive: true });
    await replaceFile(extracted.node, executablePath);
    await replaceFile(extracted.license, licensePath);
    if (platform === 'linux') await fs.chmod(executablePath, 0o755);
    if (!(await runtimeReportsVersion(executablePath, spec.version)))
      throw new Error(`Extracted runtime did not report Node.js v${spec.version}`);
    const marker = {
      version: spec.version,
      platform,
      arch,
      archive: spec.artifact.archive,
      archive_sha256: spec.artifact.sha256,
      node_sha256: await sha256File(executablePath),
      license_sha256: await sha256File(licensePath),
      source: 'https://nodejs.org/dist/',
    };
    const markerTemporary = `${markerPath}.${process.pid}.tmp`;
    await fs.writeFile(markerTemporary, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o644 });
    await fs.rm(markerPath, { force: true });
    await fs.rename(markerTemporary, markerPath);
    return { path: executablePath, version: spec.version, reused: false };
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const digest = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(digest.digest('hex')));
  });
}

async function runtimeReportsVersion(executablePath, version) {
  try {
    const { stdout } = await execFile(executablePath, ['--version'], { timeout: 10_000, windowsHide: true, maxBuffer: 4096 });
    return stdout.trim() === `v${version}`;
  } catch {
    return false;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await prepareDesktopRuntime();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`desktop runtime: ${error.message}\n`);
    process.exitCode = 1;
  }
}
