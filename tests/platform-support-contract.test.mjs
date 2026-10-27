import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

test('platform support policy matches the CI and bundled runtime contract', async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const desktopRuntime = JSON.parse(await fs.readFile(path.join(root, 'gui', 'desktop', 'runtime-node.json'), 'utf8'));
  const tauriConfig = JSON.parse(await fs.readFile(path.join(root, 'gui', 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const workflow = await fs.readFile(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  const platformSupport = await fs.readFile(path.join(root, 'docs', 'PLATFORM_SUPPORT.md'), 'utf8');
  const supportAdr = await fs.readFile(path.join(root, 'docs', 'adr', '0011-support-matrix.md'), 'utf8');
  const roadmap = await fs.readFile(path.join(root, 'BUILD_ROADMAP.md'), 'utf8');
  assert.equal(packageJson.engines.node, '>=22.0.0');
  assert.equal(desktopRuntime.version, '24.22.0');
  assert.deepEqual(Object.keys(desktopRuntime.artifacts).sort(), ['linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64']);
  assert.match(workflow, /os:\s*\[windows-2022,\s*ubuntu-24\.04\]/);
  assert.match(workflow, /node-version:\s*\[22,\s*24\]/);
  assert.match(workflow, /Build Windows NSIS installer/);
  assert.match(workflow, /Build Linux Debian and AppImage packages/);
  assert.match(workflow, /Smoke test Linux AppImage under Xvfb/);
  assert.match(workflow, /Upload Linux AppImage/);
  assert.match(packageJson.scripts['build:desktop:linux'], /--bundles deb,appimage/);
  assert.match(packageJson.scripts['smoke:desktop:linux-appimage'], /smoke-linux-appimage\.mjs/);
  assert.deepEqual(tauriConfig.bundle.targets, ['nsis', 'deb', 'appimage']);
  assert.match(platformSupport, /Windows 11 x64 \(25H2 or newer\)/);
  assert.match(platformSupport, /Ubuntu Desktop 24\.04 LTS x86-64/);
  assert.match(platformSupport, /ARM64 remains experimental/);
  assert.match(platformSupport, /validates Node\.js 22\.x and 24\.x/);
  assert.match(platformSupport, /Linux 5\.3 or newer/);
  assert.match(platformSupport, /Bubblewrap/);
  assert.match(supportAdr, /Status: Accepted as the initial release target/);
  assert.match(roadmap, /ADR 0011/);
});
