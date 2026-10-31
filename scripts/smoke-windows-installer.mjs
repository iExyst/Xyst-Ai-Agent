import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWindowsPowerShellPath, runProcess, terminateProcessTree } from '../src/platform/process.mjs';
import { smokeBundledService } from './smoke-packaged-service.mjs';
import { smokeWindowsDesktopWindow } from './smoke-windows-desktop-window.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL_TIMEOUT_MS = 180_000;
const UNINSTALL_REGISTRY_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Xyst AI Assistant';

export async function smokeWindowsInstaller({ installerPath } = {}) {
  if (process.platform !== 'win32') throw new Error('The NSIS install smoke test must run on Windows');
  await assertNoRunningXystDesktop();
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const tauriConfig = JSON.parse(await fs.readFile(path.join(ROOT, 'gui', 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const productName = tauriConfig.productName;
  const installer = path.resolve(
    installerPath ||
      path.join(
        ROOT,
        'gui',
        'desktop',
        'src-tauri',
        'target',
        'release',
        'bundle',
        'nsis',
        `${productName}_${manifest.version}_x64-setup.exe`,
      ),
  );
  const installerStat = await fs.lstat(installer);
  if (!installerStat.isFile() || installerStat.isSymbolicLink()) throw new Error('The NSIS installer must be a regular file');
  if (typeof productName !== 'string' || !/^[A-Za-z0-9 ._-]{1,80}$/.test(productName))
    throw new Error('The Tauri product name cannot be used as a Windows shortcut filename');
  const shellShortcutPaths = await getShellShortcutPaths(productName);

  const smokeParent = path.join(ROOT, '.test-tmp');
  await fs.mkdir(smokeParent, { recursive: true });
  const smokeRoot = await fs.mkdtemp(path.join(smokeParent, 'xyst-nsis-smoke-'));
  const localAppData = path.join(smokeRoot, 'LocalAppData');
  const roamingAppData = path.join(smokeRoot, 'RoamingAppData');
  const installerEnvironment = { ...process.env, LOCALAPPDATA: localAppData, APPDATA: roamingAppData };
  const installDirectories = [path.join(smokeRoot, 'Xyst AI Assistant'), path.join(localAppData, 'Xyst AI Assistant')];
  const [installDirectory] = installDirectories;
  const executable = path.join(installDirectory, 'xyst-desktop.exe');
  const uninstaller = path.join(installDirectory, 'uninstall.exe');
  let installResult;
  let smokeResult;
  let installError;
  let uninstallError;
  let shortcutSnapshots = [];
  let uninstallRegistrySnapshot;
  try {
    uninstallRegistrySnapshot = await snapshotUninstallerRegistry(smokeRoot);
    shortcutSnapshots = await snapshotShortcuts(shellShortcutPaths, path.join(smokeRoot, 'shortcut-backups'));
    await fs.mkdir(localAppData, { recursive: true });
    await fs.mkdir(roamingAppData, { recursive: true });
    installResult = await runNsisInstaller(installer, `/D=${installDirectory}`, {
      cwd: smokeRoot,
      env: installerEnvironment,
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    assert.equal(installResult.exitCode, 0, `NSIS installer exited with ${installResult.exitCode}: ${installResult.stderr}`);
    await waitForFile(executable, 30_000);

    const resources = path.join(installDirectory, 'xyst');
    const cli = path.join(resources, 'src', 'cli.mjs');
    const thirdPartyNotice = path.join(resources, 'licenses', 'THIRD-PARTY-NOTICES.md');
    const runtimeDirectory = path.join(resources, 'runtime');
    const bundledNode = path.join(runtimeDirectory, 'node.exe');
    const sandboxHelper = path.join(runtimeDirectory, 'native', `windows-${process.arch}`, 'xyst-sandbox-helper.exe');
    await assertRegularFile(executable, 'The installed desktop executable is missing');
    await assertRegularFile(uninstaller, 'The installed uninstaller is missing');
    await assertRegularFile(cli, 'The installed Xyst AI Assistant runtime source is missing');
    await assertRegularFile(path.join(resources, 'LICENSE'), 'The installed Xyst AI Assistant project license is missing');
    await assertRegularFile(thirdPartyNotice, 'The installed third-party license notice is missing');
    for (const relativePath of [
      'gui/app.mjs',
      'gui/project-manager.mjs',
      'gui/session-status.mjs',
      'gui/timeline.mjs',
      'gui/web-search-settings.mjs',
      'src/cli/ink-prompt.mjs',
      'src/config/load.mjs',
      'src/core/agent.mjs',
      'src/core/contracts.d.ts',
      'src/core/final-response.mjs',
      'src/core/injection-signals.mjs',
      'src/core/router.mjs',
      'src/providers/openai-compatible.mjs',
      'src/providers/factory.mjs',
      'src/providers/discovery.mjs',
      'src/providers/web-search.mjs',
      'src/tools/mcp-http.mjs',
      'src/session/compaction.mjs',
      'src/api/server.mjs',
      'src/api/client.mjs',
    ]) {
      const installedSource = path.join(resources, relativePath);
      await assertRegularFile(installedSource, `The installed Xyst AI Assistant source is missing: ${relativePath}`);
      assert.deepEqual(
        await fs.readFile(installedSource),
        await fs.readFile(path.join(ROOT, relativePath)),
        `The installed Xyst AI Assistant source must match the packaged build input: ${relativePath}`,
      );
    }
    const notice = await fs.readFile(thirdPartyNotice, 'utf8');
    assert.match(notice, /^THIRD-PARTY LICENSE NOTICES/m);
    assert.match(notice, /SPDX: MPL-2\.0/);
    await assertRegularFile(bundledNode, 'The pinned Node.js runtime is missing from the installation');
    await assertRegularFile(sandboxHelper, 'The packaged Windows AppContainer helper is missing from the installation');

    const runtime = await runProcess(bundledNode, ['--version'], {
      cwd: installDirectory,
      env: process.env,
      timeoutMs: 30_000,
      maxOutputBytes: 1024,
    });
    assert.equal(runtime.exitCode, 0, `The installed Node.js runtime failed: ${runtime.stderr}`);
    const major = Number(/^v(\d+)\./.exec(runtime.stdout.trim())?.[1]);
    assert.ok(Number.isInteger(major) && major >= 22, `The installed runtime must be Node.js 22 or newer: ${runtime.stdout.trim()}`);
    const workspace = path.join(smokeRoot, 'Workspace');
    await fs.mkdir(workspace);
    const service = await smokeBundledService({ node: bundledNode, cli, workspace, env: installerEnvironment });
    const desktopWindow = await smokeWindowsDesktopWindow({
      executable,
      workspace: path.join(smokeRoot, 'DesktopWorkspace'),
      alternateWorkingDirectory: path.join(smokeRoot, 'AlternateWorkingDirectory'),
      appConfigDirectory: path.join(roamingAppData, tauriConfig.identifier),
      env: installerEnvironment,
    });

    const retainedConfig = path.join(roamingAppData, 'Xyst AI Assistant', 'config.toml');
    const retainedConfigContent = '# Xyst AI Assistant user settings retention smoke\n[tools]\nautonomy = "unrestricted"\n';
    await fs.mkdir(path.dirname(retainedConfig), { recursive: true });
    await fs.writeFile(retainedConfig, retainedConfigContent, { flag: 'wx' });

    const reinstallResult = await runNsisInstaller(installer, `/D=${installDirectory}`, {
      cwd: smokeRoot,
      env: installerEnvironment,
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    assert.equal(reinstallResult.exitCode, 0, `NSIS in-place reinstall exited with ${reinstallResult.exitCode}: ${reinstallResult.stderr}`);
    await assertRegularFile(executable, 'The desktop executable is missing after in-place reinstall');
    assert.equal(await fs.readFile(retainedConfig, 'utf8'), retainedConfigContent, 'In-place reinstall must retain user configuration');
    const reinstalledService = await smokeBundledService({
      node: bundledNode,
      cli,
      workspace,
      env: installerEnvironment,
      expectedAutonomy: 'unrestricted',
    });

    const uninstallResult = await runProcess(uninstaller, ['/S', '/UPDATE'], {
      cwd: installDirectory,
      env: installerEnvironment,
      timeoutMs: INSTALL_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024,
    });
    assert.equal(uninstallResult.exitCode, 0, `NSIS uninstaller exited with ${uninstallResult.exitCode}: ${uninstallResult.stderr}`);
    await waitForRemoval(executable, 30_000);
    await waitForRemoval(uninstaller, 30_000);
    assert.equal(await fs.readFile(retainedConfig, 'utf8'), retainedConfigContent, 'Uninstall must retain user configuration');
    smokeResult = {
      installer,
      installDirectory,
      runtime: runtime.stdout.trim(),
      windowsSandboxHelper: true,
      service,
      desktopWindow,
      inPlaceReinstall: reinstallResult.exitCode === 0,
      reinstalledService,
      configurationRetainedDuringReinstall: true,
      installedAndUninstalled: true,
      userConfigurationRetained: true,
      uninstallRegistryRestored: false,
      uninstallRegistryBeforeSmoke: uninstallRegistrySnapshot?.existed ? uninstallRegistrySnapshot.installLocation : null,
    };
  } catch (error) {
    installError = error;
  }
  try {
    for (const candidate of installDirectories) {
      const candidateUninstaller = path.join(candidate, 'uninstall.exe');
      if (await exists(candidateUninstaller)) {
        const cleanup = await runProcess(candidateUninstaller, ['/S'], {
          cwd: candidate,
          env: installerEnvironment,
          timeoutMs: INSTALL_TIMEOUT_MS,
          maxOutputBytes: 64 * 1024,
        });
        if (cleanup.exitCode !== 0) throw new Error(`Cleanup uninstaller exited with ${cleanup.exitCode}: ${cleanup.stderr}`);
        await waitForRemoval(path.join(candidate, 'xyst-desktop.exe'), 30_000);
      }
    }
  } catch (error) {
    uninstallError = error;
  }
  try {
    await restoreShortcuts(shortcutSnapshots);
  } catch (error) {
    uninstallError = uninstallError
      ? new AggregateError([uninstallError, error], 'Installer cleanup and shortcut restoration both failed')
      : error;
  }
  try {
    await restoreUninstallerRegistry(uninstallRegistrySnapshot, smokeRoot);
    await delay(500);
    await verifyUninstallerRegistry(uninstallRegistrySnapshot);
    await verifyShortcuts(shortcutSnapshots);
    if (smokeResult) smokeResult.uninstallRegistryRestored = true;
  } catch (error) {
    uninstallError = uninstallError
      ? new AggregateError([uninstallError, error], 'Installer cleanup and uninstall registration restoration both failed')
      : error;
  }
  // Preserve failed smoke state for diagnosis; successful runs remove all isolated test data.
  if (!installError && !uninstallError) await fs.rm(smokeRoot, { recursive: true, force: true });
  if (installError && uninstallError)
    throw new AggregateError(
      [installError, uninstallError],
      `Installer smoke failed and cleanup was incomplete. Install: ${describeError(installError)} Cleanup: ${describeError(uninstallError)}`,
    );
  if (installError) throw installError;
  if (uninstallError) throw uninstallError;
  return smokeResult;
}

async function assertNoRunningXystDesktop() {
  const powershell = resolveWindowsPowerShellPath();
  if (!powershell) throw new Error('Windows PowerShell could not be resolved to check for a running Xyst desktop');
  const result = await runProcess(
    powershell,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-Process | Where-Object { $_.ProcessName -eq 'xyst-desktop' } | Select-Object -ExpandProperty Id",
    ],
    { cwd: ROOT, env: process.env, timeoutMs: 30_000, maxOutputBytes: 2_048 },
  );
  if (result.exitCode !== 0) throw new Error(`Could not check for a running Xyst desktop process: ${result.stderr}`);
  const processIds = result.stdout.trim().split(/\s+/).filter(Boolean);
  if (processIds.length)
    throw new Error(
      `Close Xyst AI Assistant before running the Windows installer smoke; active desktop process IDs: ${processIds.join(', ')}`,
    );
}

function describeError(error) {
  if (error instanceof AggregateError) return `${error.message} (${[...error.errors].map(describeError).join('; ')})`;
  return error instanceof Error ? error.message : String(error);
}

async function snapshotUninstallerRegistry(smokeRoot) {
  const current = await readUninstallerRegistry();
  if (!current) return { existed: false, installLocation: null, backupPath: null };
  const backupPath = path.join(smokeRoot, 'xyst-uninstall-backup.reg');
  const result = await runRegistry(['export', UNINSTALL_REGISTRY_KEY, backupPath, '/y']);
  if (result.exitCode !== 0) throw new Error(`Could not back up the Xyst AI Assistant uninstall registration: ${result.stderr}`);
  return { existed: true, installLocation: current.installLocation, backupPath };
}

async function restoreUninstallerRegistry(snapshot, smokeRoot) {
  if (!snapshot) return;
  const current = await readUninstallerRegistry();
  if (current && snapshot.existed && sameWindowsPath(current.installLocation, snapshot.installLocation)) return;
  if (current && (!current.installLocation || !isPathInside(current.installLocation, smokeRoot)))
    throw new Error('Xyst AI Assistant uninstall registration changed outside the isolated installer smoke; it was left untouched.');

  if (current) {
    const removed = await runRegistry(['delete', UNINSTALL_REGISTRY_KEY, '/f']);
    if (removed.exitCode !== 0)
      throw new Error(`Could not remove the isolated Xyst AI Assistant uninstall registration: ${removed.stderr}`);
  }
  if (snapshot.existed) {
    const restored = await runRegistry(['import', snapshot.backupPath]);
    if (restored.exitCode !== 0) throw new Error(`Could not restore the Xyst AI Assistant uninstall registration: ${restored.stderr}`);
  }

  await verifyUninstallerRegistry(snapshot);
}

async function verifyUninstallerRegistry(snapshot) {
  const after = await readUninstallerRegistry();
  if (snapshot.existed && (!after || !sameWindowsPath(after.installLocation, snapshot.installLocation)))
    throw new Error('The original Xyst AI Assistant uninstall registration was not restored.');
  if (!snapshot.existed && after) throw new Error('The installer smoke left a Xyst AI Assistant uninstall registration behind.');
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readUninstallerRegistry() {
  const result = await runRegistry(['query', UNINSTALL_REGISTRY_KEY]);
  if (result.exitCode !== 0) {
    if (/unable to find|cannot find|specified registry key or value/i.test(`${result.stdout}\n${result.stderr}`)) return null;
    throw new Error(`Could not inspect the Xyst AI Assistant uninstall registration: ${result.stderr}`);
  }
  const installLocation = /^\s*InstallLocation\s+REG_SZ\s+(.+)$/im.exec(result.stdout)?.[1]?.trim();
  return { installLocation: trimRegistryQuotes(installLocation) };
}

async function runRegistry(args) {
  const powershell = resolveWindowsPowerShellPath();
  if (!powershell) throw new Error('The Windows system root could not be resolved for registry access.');
  const system32 = path.win32.dirname(path.win32.dirname(path.win32.dirname(powershell)));
  const executable = path.win32.join(system32, 'reg.exe');
  const stat = await fs.lstat(executable).catch((error) => {
    if (error.code === 'ENOENT') throw new Error('Windows reg.exe is not available for installer-state restoration.');
    throw error;
  });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Windows reg.exe must be a regular system file.');
  return runProcess(executable, args, { cwd: ROOT, env: process.env, timeoutMs: 30_000, maxOutputBytes: 8_192 });
}

function trimRegistryQuotes(value) {
  if (typeof value !== 'string') return null;
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

function sameWindowsPath(left, right) {
  return (
    typeof left === 'string' &&
    typeof right === 'string' &&
    path.win32.resolve(left).toLowerCase() === path.win32.resolve(right).toLowerCase()
  );
}

function isPathInside(candidate, root) {
  const relative = path.win32.relative(path.win32.resolve(root), path.win32.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.win32.sep}`) && !path.win32.isAbsolute(relative));
}

async function getShellShortcutPaths(productName) {
  const powershell = resolveWindowsPowerShellPath();
  if (!powershell) throw new Error('Windows PowerShell could not be resolved to locate shell shortcuts');
  const result = await runProcess(
    powershell,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "[Environment]::GetFolderPath('DesktopDirectory'); [Environment]::GetFolderPath('Programs')",
    ],
    { cwd: ROOT, env: process.env, timeoutMs: 30_000, maxOutputBytes: 4_096 },
  );
  if (result.exitCode !== 0) throw new Error(`Could not resolve Windows shortcut folders: ${result.stderr}`);
  const [desktopDirectory, programsDirectory] = result.stdout.trimEnd().split(/\r?\n/);
  if (!desktopDirectory || !programsDirectory) throw new Error('Windows returned incomplete shortcut folder paths');
  const shortcutName = `${productName}.lnk`;
  return [path.join(desktopDirectory, shortcutName), path.join(programsDirectory, shortcutName)];
}

async function snapshotShortcuts(shortcutPaths, backupDirectory) {
  await fs.mkdir(backupDirectory, { recursive: true });
  const snapshots = [];
  for (const [index, shortcutPath] of shortcutPaths.entries()) {
    const backupPath = path.join(backupDirectory, `shortcut-${index}.lnk`);
    try {
      const stat = await fs.lstat(shortcutPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing to replace a non-file shortcut: ${shortcutPath}`);
      await fs.copyFile(shortcutPath, backupPath);
      snapshots.push({ shortcutPath, backupPath, existed: true });
    } catch (error) {
      if (error.code === 'ENOENT') snapshots.push({ shortcutPath, backupPath, existed: false });
      else throw error;
    }
  }
  return snapshots;
}

async function restoreShortcuts(snapshots) {
  for (const { shortcutPath, backupPath, existed } of snapshots) {
    if (existed) {
      await fs.mkdir(path.dirname(shortcutPath), { recursive: true });
      await fs.copyFile(backupPath, shortcutPath);
    } else {
      await removeCreatedShortcut(shortcutPath);
    }
  }
}

async function verifyShortcuts(snapshots) {
  for (const { shortcutPath, backupPath, existed } of snapshots) {
    if (!existed) {
      if (await exists(shortcutPath)) throw new Error(`The installer smoke left a shortcut behind: ${shortcutPath}`);
      continue;
    }
    const [expected, actual] = await Promise.all([fs.readFile(backupPath), fs.readFile(shortcutPath)]);
    if (!expected.equals(actual)) throw new Error(`The installer smoke did not restore the original shortcut: ${shortcutPath}`);
  }
}

async function removeCreatedShortcut(shortcutPath) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(shortcutPath, { force: true });
      return;
    } catch (error) {
      if (error.code === 'ENOENT') return;
      if (!['EBUSY', 'EPERM'].includes(error.code) || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

async function assertRegularFile(filePath, message) {
  const stat = await fs.lstat(filePath).catch((error) => {
    if (error.code === 'ENOENT') throw new Error(message);
    throw error;
  });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(message);
}

async function exists(filePath) {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function runNsisInstaller(installer, installOverride, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(installer, ['/S', '/UPDATE', '/NS', installOverride], {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: 'ignore',
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      terminateProcessTree(child, 'force');
      finish(Object.assign(new Error(`NSIS installer timed out after ${timeoutMs} ms`), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    child.once('error', (error) => finish(error));
    child.once('close', (exitCode, signal) => finish(null, { exitCode, signal }));
  });
}

async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!(await exists(filePath))) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for installer output: ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForRemoval(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (await exists(filePath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for uninstaller to remove: ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  smokeWindowsInstaller({ installerPath: process.argv[2] })
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`Windows installer smoke test: ${error.message}\n`);
      process.exitCode = 1;
    });
}
