import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { assertProductVersionAlignment, buildReleaseArchive } from '../scripts/build-release.mjs';

test('release version alignment rejects mismatched product components', async (t) => {
  const scratchRoot = path.join(process.cwd(), '.test-tmp');
  await fs.mkdir(scratchRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratchRoot, 'xyst-release-versions-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tauri = path.join(root, 'gui', 'desktop', 'src-tauri');
  const vscode = path.join(root, 'vscode');
  await fs.mkdir(tauri, { recursive: true });
  await fs.mkdir(vscode, { recursive: true });
  await fs.writeFile(path.join(tauri, 'Cargo.toml'), '[package]\nversion = "0.1.0"\n');
  await fs.writeFile(path.join(tauri, 'tauri.conf.json'), JSON.stringify({ version: '0.1.1' }));
  await fs.writeFile(path.join(vscode, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  await assert.rejects(assertProductVersionAlignment('0.1.0', root), /tauri_config=0\.1\.1/);
});

test('release version alignment accepts matching product components', async (t) => {
  const scratchRoot = path.join(process.cwd(), '.test-tmp');
  await fs.mkdir(scratchRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratchRoot, 'xyst-release-versions-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tauri = path.join(root, 'gui', 'desktop', 'src-tauri');
  const vscode = path.join(root, 'vscode');
  await fs.mkdir(tauri, { recursive: true });
  await fs.mkdir(vscode, { recursive: true });
  await fs.writeFile(path.join(tauri, 'Cargo.toml'), '[package]\nversion = "0.1.0"\n');
  await fs.writeFile(path.join(tauri, 'tauri.conf.json'), JSON.stringify({ version: '0.1.0' }));
  await fs.writeFile(path.join(vscode, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  assert.deepEqual(await assertProductVersionAlignment('0.1.0', root), {
    package_json: '0.1.0',
    cargo_toml: '0.1.0',
    tauri_config: '0.1.0',
    vscode_package: '0.1.0',
  });
});

test('release archive is reproducible and contains verified source files without workspace state', async (t) => {
  const scratchRoot = path.join(process.cwd(), '.test-tmp');
  await fs.mkdir(scratchRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratchRoot, 'xyst-release-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const firstOutput = path.join(root, 'first');
  const secondOutput = path.join(root, 'second');
  const first = await buildReleaseArchive({ outputDirectory: firstOutput });
  const second = await buildReleaseArchive({ outputDirectory: secondOutput });
  const replaced = await buildReleaseArchive({ outputDirectory: firstOutput });
  const [firstBytes, secondBytes] = await Promise.all([fs.readFile(first.path), fs.readFile(second.path)]);
  assert.deepEqual(firstBytes, secondBytes);
  assert.equal(firstBytes[9], 0xff, 'gzip OS marker is normalized across platforms');
  assert.equal(first.sha256, createHash('sha256').update(firstBytes).digest('hex'));
  assert.equal(first.files, second.files);
  assert.equal(replaced.sha256, first.sha256, 'rebuilding the existing artifact changes its content');

  const entries = unpackTar(gunzipSync(firstBytes));
  const manifestEntry = [...entries.values()].find((entry) => entry.name.endsWith('/release-manifest.json'));
  assert.ok(manifestEntry);
  const manifest = JSON.parse(manifestEntry.data.toString('utf8'));
  assert.equal(manifest.artifact, 'cross-platform-source');
  assert.equal(manifest.required_node, '>=22.0.0');
  assert.ok(manifest.excluded_state.includes('platform-specific generated Tauri schemas'));
  assert.ok(manifest.excluded_state.includes('platform-generated Tauri icon variants'));
  assert.ok(manifest.files.some((file) => file.path === 'licenses/rust-policy.json'));
  assert.ok(manifest.files.some((file) => file.path === 'scripts/check-rust-licenses.mjs'));
  assert.ok(manifest.files.some((file) => file.path === 'gui/desktop/src-tauri/icons/xyst-ai-assistant-source.png'));
  assert.ok(
    !manifest.files.some((file) => /gui\/desktop\/src-tauri\/gen\/schemas\/(?:linux|windows)-schema\.json$/.test(file.path)),
    'release archives omit platform-specific generated Tauri schemas',
  );
  assert.ok(
    !manifest.files.some(
      (file) =>
        file.path.startsWith('gui/desktop/src-tauri/icons/') && file.path !== 'gui/desktop/src-tauri/icons/xyst-ai-assistant-source.png',
    ),
    'release archives keep canonical artwork and rebuild host-generated Tauri icon variants',
  );
  const prefix = manifestEntry.name.slice(0, -'release-manifest.json'.length);
  for (const file of manifest.files) {
    const entry = entries.get(`${prefix}${file.path}`);
    assert.ok(entry, `archive is missing ${file.path}`);
    assert.equal(entry.data.length, file.size, `${file.path} size mismatch`);
    assert.equal(createHash('sha256').update(entry.data).digest('hex'), file.sha256, `${file.path} hash mismatch`);
  }
  assert.ok(entries.has(`${prefix}src/cli.mjs`));
  assert.ok(entries.has(`${prefix}LICENSE`));
  assert.ok(entries.has(`${prefix}CHANGELOG.md`));
  assert.ok(entries.has(`${prefix}CONTRIBUTING.md`));
  assert.ok(entries.has(`${prefix}docs/RELEASE_POLICY.md`));
  assert.match(entries.get(`${prefix}LICENSE`).data.toString('utf8'), /Apache License[\s\S]*Version 2\.0/);
  assert.ok(entries.has(`${prefix}biome.json`));
  assert.ok(entries.has(`${prefix}pnpm-lock.yaml`));
  assert.ok(entries.has(`${prefix}vscode/dist/api-client.mjs`));
  assert.ok(entries.has(`${prefix}tests/release-package.test.mjs`));
  assert.ok(![...entries.keys()].some((name) => /(^|\/)(\.git|\.agent|\.test-tmp|node_modules|target)(\/|$)/.test(name)));
});

test('release archive generation preserves a temporary-path collision', async (t) => {
  const scratchRoot = path.join(process.cwd(), '.test-tmp');
  await fs.mkdir(scratchRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratchRoot, 'xyst-release-temp-collision-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outputDirectory = path.join(root, 'output');
  const open = fs.open;
  let collisionPath;
  fs.open = async (filePath, flags, ...args) => {
    if (filePath.includes('xyst-ai-assistant-v0.1.2-source.tar.gz.') && filePath.endsWith('.tmp') && flags === 'wx') {
      collisionPath = filePath;
      const collision = await open(filePath, 'wx', ...args);
      await collision.writeFile('pre-existing release temp');
      await collision.close();
      throw Object.assign(new Error('simulated exclusive-create collision'), { code: 'EEXIST' });
    }
    return open(filePath, flags, ...args);
  };
  try {
    await assert.rejects(buildReleaseArchive({ outputDirectory }), { code: 'EEXIST' });
    assert.equal(await fs.readFile(collisionPath, 'utf8'), 'pre-existing release temp');
  } finally {
    fs.open = open;
  }
});

function unpackTar(tar) {
  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= tar.length && tar.subarray(offset, offset + 512).some((byte) => byte !== 0)) {
    const header = tar.subarray(offset, offset + 512);
    const storedChecksum = Number.parseInt(header.subarray(148, 156).toString('ascii').replaceAll('\0', '').trim(), 8);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    assert.equal(
      checksumHeader.reduce((sum, byte) => sum + byte, 0),
      storedChecksum,
      'tar header checksum mismatch',
    );
    const name = readField(header, 0, 100);
    const prefix = readField(header, 345, 155);
    const archivePath = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(readField(header, 124, 12), 8);
    const type = header[156] === 0x35 ? 'directory' : 'file';
    offset += 512;
    const data = Buffer.from(tar.subarray(offset, offset + size));
    entries.set(archivePath, { name: archivePath, type, data });
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

function readField(buffer, offset, length) {
  return buffer
    .subarray(offset, offset + length)
    .toString('utf8')
    .replace(/\0.*$/s, '')
    .trim();
}
