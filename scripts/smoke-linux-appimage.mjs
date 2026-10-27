import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess, safeProcessEnvironment } from '../src/platform/process.mjs';
import { smokeLinuxDesktopWindow } from './smoke-linux-desktop-window.mjs';
import { smokeBundledService } from './smoke-packaged-service.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTRACT_TIMEOUT_MS = 180_000;

export async function smokeLinuxAppImage({ packagePath } = {}) {
  if (process.platform !== 'linux') throw new Error('The AppImage smoke test must run on Linux');
  if (!process.env.DISPLAY) throw new Error('The AppImage smoke test requires an X11 display, such as xvfb-run');

  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const tauriConfig = JSON.parse(await fs.readFile(path.join(ROOT, 'gui', 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const productName = tauriConfig.productName;
  const architecture = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : null;
  if (!architecture) throw new Error(`Unsupported AppImage architecture for Node platform ${process.arch}`);
  const expectedName = `${productName}_${manifest.version}_${architecture}.AppImage`;
  const appImage = path.resolve(
    packagePath || path.join(ROOT, 'gui', 'desktop', 'src-tauri', 'target', 'release', 'bundle', 'appimage', expectedName),
  );
  const appImageInfo = await fs.lstat(appImage);
  if (!appImageInfo.isFile() || appImageInfo.isSymbolicLink() || (appImageInfo.mode & 0o111) === 0)
    throw new Error('The AppImage must be a regular executable file');
  if (appImageInfo.size < 10 * 1024 * 1024 || appImageInfo.size > 2 * 1024 * 1024 * 1024)
    throw new Error(`The AppImage size is outside the supported smoke-test bounds: ${appImageInfo.size}`);

  const smokeParent = path.join(ROOT, '.test-tmp');
  await fs.mkdir(smokeParent, { recursive: true });
  const smokeRoot = await fs.mkdtemp(path.join(smokeParent, 'xyst-appimage-smoke-'));
  try {
    const extraction = await runProcess(appImage, ['--appimage-extract'], {
      cwd: smokeRoot,
      env: safeProcessEnvironment(process.env),
      timeoutMs: EXTRACT_TIMEOUT_MS,
      maxOutputBytes: 32 * 1024,
    });
    assert.equal(extraction.exitCode, 0, `AppImage extraction failed: ${extraction.stderr.trim() || extraction.stdout.trim()}`);

    const appDir = path.join(smokeRoot, 'squashfs-root');
    await assertRealDirectory(appDir, 'The AppImage did not extract its SquashFS payload');
    const appRun = path.join(appDir, 'AppRun');
    const desktopExecutable = path.join(appDir, 'usr', 'bin', 'xyst-desktop');
    const resourceRoot = path.join(appDir, 'usr', 'lib', productName, 'xyst');
    const cli = path.join(resourceRoot, 'src', 'cli.mjs');
    const node = path.join(resourceRoot, 'runtime', 'node');
    await assertExecutable(appRun, 'The AppImage is missing its executable AppRun launcher');
    await assertExecutable(desktopExecutable, 'The AppImage is missing the Xyst desktop binary');
    await assertExecutable(node, 'The AppImage is missing its bundled Node runtime');
    await assertRegularFile(cli, 'The AppImage is missing the packaged Xyst CLI');

    for (const relativePath of [
      'gui/app.mjs',
      'gui/session-status.mjs',
      'gui/web-search-settings.mjs',
      'src/api/server.mjs',
      'src/config/load.mjs',
      'src/core/agent.mjs',
      'src/providers/web-search.mjs',
      'src/session/store.mjs',
      'src/tools/approval-rule-store.mjs',
    ]) {
      assert.deepEqual(
        await fs.readFile(path.join(resourceRoot, relativePath)),
        await fs.readFile(path.join(ROOT, relativePath)),
        `The AppImage contains stale packaged source: ${relativePath}`,
      );
    }
    await assertRegularFile(path.join(resourceRoot, 'LICENSE'), 'The AppImage is missing the project license');
    const thirdPartyNotice = path.join(resourceRoot, 'licenses', 'THIRD-PARTY-NOTICES.md');
    await assertRegularFile(thirdPartyNotice, 'The AppImage is missing third-party license notices');
    const notice = await fs.readFile(thirdPartyNotice, 'utf8');
    assert.match(notice, /^THIRD-PARTY LICENSE NOTICES/m);
    assert.match(notice, /SPDX: MPL-2\.0/);

    const nodeVersion = await runProcess(node, ['--version'], {
      cwd: smokeRoot,
      env: safeProcessEnvironment(process.env),
      timeoutMs: 10_000,
      maxOutputBytes: 1024,
    });
    assert.equal(nodeVersion.exitCode, 0, `The AppImage Node runtime failed: ${nodeVersion.stderr.trim()}`);
    const major = Number(/^v(\d+)\./.exec(nodeVersion.stdout.trim())?.[1]);
    assert.ok(Number.isInteger(major) && major >= 22, `The AppImage runtime must be Node.js 22 or newer: ${nodeVersion.stdout.trim()}`);

    const workspace = path.join(smokeRoot, 'workspace');
    const configHome = path.join(smokeRoot, 'config');
    await fs.mkdir(workspace);
    const service = await smokeBundledService({
      node,
      cli,
      workspace,
      env: { ...safeProcessEnvironment(process.env), XDG_CONFIG_HOME: configHome },
    });
    const desktopWindow = await smokeLinuxDesktopWindow({
      executable: appRun,
      workspace: path.join(smokeRoot, 'desktop-workspace'),
      configHome: path.join(smokeRoot, 'desktop-config'),
    });

    return {
      package: path.basename(appImage),
      sizeBytes: appImageInfo.size,
      architecture,
      runtime: nodeVersion.stdout.trim(),
      packagedSourceIntegrity: true,
      service,
      desktopWindow,
    };
  } finally {
    await removeSmokeRoot(smokeRoot);
  }
}

async function removeSmokeRoot(smokeRoot) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fs.rm(smokeRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error.code) || attempt === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

async function assertRegularFile(filePath, message) {
  const info = await fs.lstat(filePath).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error(message);
}

async function assertExecutable(filePath, message) {
  await assertRegularFile(filePath, message);
  const info = await fs.stat(filePath);
  if ((info.mode & 0o111) === 0) throw new Error(message);
}

async function assertRealDirectory(directory, message) {
  const info = await fs.lstat(directory).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(message);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  smokeLinuxAppImage()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`Linux AppImage smoke test: ${error.message}\n`);
      process.exitCode = 1;
    });
}
