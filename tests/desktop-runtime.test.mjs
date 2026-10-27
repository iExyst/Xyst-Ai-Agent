import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRuntimeSpec, sha256Hex, extractZipEntries } from '../scripts/build-desktop-runtime.mjs';

test('desktop Node runtime manifest pins the current LTS artifacts to official archive hashes', async () => {
  const winX64 = await readRuntimeSpec('win32', 'x64');
  const winArm64 = await readRuntimeSpec('win32', 'arm64');
  const linuxX64 = await readRuntimeSpec('linux', 'x64');
  const linuxArm64 = await readRuntimeSpec('linux', 'arm64');
  assert.equal(winX64.version, '24.22.0');
  assert.equal(winX64.artifact.archive, 'node-v24.22.0-win-x64.zip');
  assert.equal(winX64.artifact.sha256, 'f9683a19877e12a9b167305c8db71040d812876359de21f0d2e97c3f321f80c3');
  assert.equal(winArm64.artifact.archive, 'node-v24.22.0-win-arm64.zip');
  assert.equal(linuxX64.artifact.archive, 'node-v24.22.0-linux-x64.tar.xz');
  assert.equal(linuxArm64.artifact.archive, 'node-v24.22.0-linux-arm64.tar.xz');
  for (const spec of [winX64, winArm64, linuxX64, linuxArm64]) {
    assert.match(spec.artifact.sha256, /^[a-f0-9]{64}$/);
    assert.equal(new URL(spec.artifact.archive, spec.release_url).origin, 'https://nodejs.org');
  }
});

test('desktop Node runtime manifest refuses unsupported operating systems and architectures', async () => {
  await assert.rejects(readRuntimeSpec('darwin', 'arm64'), /not available/);
  await assert.rejects(readRuntimeSpec('linux', 'riscv64'), /not available/);
});

test('desktop runtime SHA-256 uses the expected hexadecimal digest', () => {
  assert.equal(
    sha256Hex(Buffer.from('Xyst AI Assistant runtime integrity')),
    'd189045c4de77093ebdff3fc46a7caf6e11b51cb557218ac907603abfcaddbdb',
  );
});

test('desktop Windows ZIP extraction returns only verified requested entries', async () => {
  const archive = Buffer.from(
    'UEsDBBQACAAIAAAAAACGphA2BwAAAAUAAAAHAAAAcGF5bG9hZMtIzcnJBwBQSwMEFAAIAAgAAAAAABn0aFcJAAAABwAAAAcAAABsaWNlbnNly8lMTs0rTgUAUEsBAhQAFAAIAAgAAAAAAIamEDYHAAAABQAAAAcAAAAAAAAAAAAAAAAAAAAAAHBheWxvYWRQSwECFAAUAAgACAAAAAAAGfRoVwkAAAAHAAAABwAAAAAAAAAAAAAAAAAsAAAAbGljZW5zZVBLBQYAAAAAAgACAGoAAABaAAAAAAA=',
    'base64',
  );
  const files = extractZipEntries(archive, new Set(['payload', 'license']));
  assert.equal(files.get('payload').toString(), 'hello');
  assert.equal(files.get('license').toString(), 'license');
  assert.equal(files.size, 2);
  assert.throws(() => extractZipEntries(archive, new Set(['missing'])), /missing missing/);
});

test('desktop content security policy permits its same-origin API and blocks other connections', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const config = JSON.parse(await fs.readFile(path.join(root, 'gui/desktop/src-tauri/tauri.conf.json'), 'utf8'));
  const csp = config.app.security.csp;
  assert.match(csp, /connect-src 'self'/);
  assert.doesNotMatch(csp, /connect-src[^;]*(?:https?:|\*)/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
});

test('desktop executable targets match the installer and Windows helper packaging names', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const manifest = await fs.readFile(path.join(root, 'gui/desktop/src-tauri/Cargo.toml'), 'utf8');
  const helperPackager = await fs.readFile(path.join(root, 'scripts/package-sandbox-helper.mjs'), 'utf8');
  const installerSmoke = await fs.readFile(path.join(root, 'scripts/smoke-windows-installer.mjs'), 'utf8');
  const desktopWindowSmoke = await fs.readFile(path.join(root, 'scripts/smoke-windows-desktop-window.mjs'), 'utf8');
  const desktopWindowControl = await fs.readFile(path.join(root, 'scripts/windows-desktop-window-control.ps1'), 'utf8');
  assert.match(manifest, /autobins\s*=\s*false/);
  assert.match(manifest, /\[\[bin\]\]\s*name\s*=\s*"xyst-desktop"\s*path\s*=\s*"src\/main\.rs"/);
  assert.match(manifest, /\[\[bin\]\]\s*name\s*=\s*"xyst-sandbox-helper"[\s\S]*?required-features\s*=\s*\["sandbox-helper"\]/);
  assert.match(helperPackager, /'--bin',[\s\S]*?'xyst-sandbox-helper'/);
  assert.match(helperPackager, /const HELPER_NAME = 'xyst-sandbox-helper\.exe'/);
  assert.match(helperPackager, /process\.env\.CARGO_TARGET_DIR/);
  assert.match(helperPackager, /path\.resolve\(ROOT, process\.env\.CARGO_TARGET_DIR\)/);
  assert.match(installerSmoke, /'xyst-desktop\.exe'/);
  assert.match(installerSmoke, /`\$\{productName\}_\$\{manifest\.version\}_x64-setup\.exe`/);
  assert.match(installerSmoke, /import \{ smokeWindowsDesktopWindow \} from '\.\/smoke-windows-desktop-window\.mjs'/);
  assert.match(installerSmoke, /const desktopWindow = await smokeWindowsDesktopWindow\(/);
  assert.match(desktopWindowSmoke, /'wait-size'/);
  assert.match(desktopWindowSmoke, /XYST_TEST_APP_DIRECTORIES_ROOT: appConfigDirectory/);
  assert.match(desktopWindowSmoke, /terminateProcessTree\(child, 'force'\)/);
  assert.doesNotMatch(desktopWindowSmoke, /terminateProcessTree\(child\.pid/);
  assert.match(desktopWindowSmoke, /width: resizedWindow\.logical_width/);
  assert.match(desktopWindowSmoke, /height: resizedWindow\.logical_height/);
  assert.match(desktopWindowControl, /EntryPoint = "GetDpiForWindow"/);
  assert.match(desktopWindowControl, /IsNullOrWhiteSpace\(\$window\.title\)/);
  assert.match(desktopWindowSmoke, /lastWorkspaceRestored: true/);
});

test('native startup screen uses the branded icon and theme through its self-hosted CSP assets', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const uiRoot = path.join(root, 'gui/desktop/ui');
  const html = await fs.readFile(path.join(uiRoot, 'index.html'), 'utf8');
  const css = await fs.readFile(path.join(uiRoot, 'styles.css'), 'utf8');
  const [brandIcon, splashIcon] = await Promise.all([
    fs.readFile(path.join(root, 'gui/assets/brand-icon.png')),
    fs.readFile(path.join(uiRoot, 'brand-icon.png')),
  ]);
  assert.match(html, /<title>Starting Xyst AI Assistant<\/title>/);
  assert.match(html, /<link rel="stylesheet" href="styles\.css">/);
  assert.match(html, /<img class="brand-mark" src="brand-icon\.png" alt="">/);
  assert.doesNotMatch(html, /<style\b|\sstyle=/i);
  for (const color of ['#070b1b', '#0b1230', '#58eaff', '#a1fff1', '#c5ff48', '#b78aff'])
    assert.ok(css.includes(color), `splash theme is missing ${color}`);
  assert.ok(brandIcon.equals(splashIcon), 'startup icon must match the app brand icon');
});

test('desktop bundle includes every allowlisted GUI module served by the packaged runtime', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const config = JSON.parse(await fs.readFile(path.join(root, 'gui/desktop/src-tauri/tauri.conf.json'), 'utf8'));
  const resources = config.bundle.resources;
  const guiModules = (await fs.readdir(path.join(root, 'gui'), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
    .map((entry) => entry.name)
    .sort();
  assert.ok(guiModules.includes('app.mjs'), 'The GUI entry point must be included in the module inventory');
  const required = [
    ...guiModules.map((name) => [`../../../gui/${name}`, `xyst/gui/${name}`]),
    ['../../../gui/index.html', 'xyst/gui/index.html'],
    ['../../../gui/assets/brand-icon.png', 'xyst/gui/assets/brand-icon.png'],
    ['../../../gui/styles.css', 'xyst/gui/styles.css'],
    ['../../../LICENSE', 'xyst/LICENSE'],
    ['../../../package.json', 'xyst/package.json'],
    ['../../../licenses/THIRD-PARTY-NOTICES.md', 'xyst/licenses/THIRD-PARTY-NOTICES.md'],
  ];
  for (const [source, destination] of required) {
    assert.equal(resources[source], destination, `Desktop bundle is missing ${source}`);
    const stat = await fs.lstat(path.join(root, 'gui/desktop/src-tauri', source));
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), `Packaged GUI asset is not a regular file: ${source}`);
  }
  const notice = await fs.readFile(path.join(root, 'licenses/THIRD-PARTY-NOTICES.md'), 'utf8');
  assert.match(notice, /^THIRD-PARTY LICENSE NOTICES/m);
  assert.match(notice, /SPDX: MPL-2\.0/);
  assert.match(notice, /https:\/\/crates\.io\/crates\//);
});
