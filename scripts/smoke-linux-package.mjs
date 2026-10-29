import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeProcessEnvironment } from '../src/platform/process.mjs';
import { debianPackageName, findDebPackage, findLauncher, findPackagedResources } from './linux-package-inspection.mjs';
import { smokeBundledService } from './smoke-packaged-service.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function smokeLinuxPackage({ packagePath } = {}) {
  if (process.platform !== 'linux') throw new Error('The Debian package smoke test must run on Linux');
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const tauriConfig = JSON.parse(await fs.readFile(path.join(ROOT, 'gui', 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const productName = tauriConfig.productName;
  const architecture = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : null;
  if (!architecture) throw new Error(`Unsupported Debian package architecture for Node platform ${process.arch}`);
  const debPath = path.resolve(
    packagePath ||
      (await findDebPackage(path.join(ROOT, 'gui', 'desktop', 'src-tauri', 'target', 'release', 'bundle', 'deb'), {
        productName,
        version: manifest.version,
        architecture,
      })),
  );
  const debStat = await fs.lstat(debPath);
  if (!debStat.isFile() || debStat.isSymbolicLink()) throw new Error('The Debian package must be a regular file');

  const smokeParent = path.join(ROOT, '.test-tmp');
  await fs.mkdir(smokeParent, { recursive: true });
  const smokeRoot = await fs.mkdtemp(path.join(smokeParent, 'xyst-deb-smoke-'));
  try {
    const packageName = (await runChecked('dpkg-deb', ['--field', debPath, 'Package'])).stdout.trim();
    const version = (await runChecked('dpkg-deb', ['--field', debPath, 'Version'])).stdout.trim();
    const architecture = (await runChecked('dpkg-deb', ['--field', debPath, 'Architecture'])).stdout.trim();
    const depends = (await runChecked('dpkg-deb', ['--field', debPath, 'Depends'])).stdout.trim();
    const dependencyNames = depends.split(',').map((dependency) => dependency.trim().split(/\s+/, 1)[0]);
    assert.equal(packageName, debianPackageName(productName));
    assert.equal(version, manifest.version);
    assert.ok(['amd64', 'arm64'].includes(architecture), `Unsupported DEB architecture: ${architecture}`);
    assert.ok(dependencyNames.includes('libglib2.0-bin'), 'The DEB must install gdbus for metadata-only Secret Service key listing');
    assert.ok(dependencyNames.includes('libsecret-tools'), 'The DEB must install secret-tool for Secret Service credentials');

    const extractRoot = path.join(smokeRoot, 'root');
    await fs.mkdir(extractRoot);
    await runChecked('dpkg-deb', ['--extract', debPath, extractRoot], { timeoutMs: 180_000 });
    const resources = await findPackagedResources(extractRoot);
    const resourceRoot = path.dirname(path.dirname(resources.cli));
    await assertPackagedSourcesMatch(resourceRoot);
    await assertRegularFile(path.join(resourceRoot, 'LICENSE'), 'The DEB is missing Xyst AI Assistant license text');
    const thirdPartyNotice = await fs.readFile(path.join(resourceRoot, 'licenses', 'THIRD-PARTY-NOTICES.md'), 'utf8');
    assert.match(thirdPartyNotice, /^THIRD-PARTY LICENSE NOTICES/m);
    assert.match(thirdPartyNotice, /SPDX: MPL-2\.0/);
    const launcher = await findLauncher(extractRoot);
    const nodeVersion = await runChecked(resources.node, ['--version']);
    assert.match(nodeVersion.stdout.trim(), /^v\d+\.\d+\.\d+$/);
    assert.ok(Number(nodeVersion.stdout.trim().slice(1).split('.')[0]) >= 22, 'Bundled Node.js must be version 22 or newer');

    const workspace = path.join(smokeRoot, 'workspace');
    await fs.mkdir(workspace);
    const configHome = path.join(smokeRoot, 'config');
    const service = await smokeBundledService({
      node: resources.node,
      cli: resources.cli,
      workspace,
      env: { ...safeProcessEnvironment(process.env), XDG_CONFIG_HOME: configHome },
    });
    const installedPackage =
      process.env.XYST_LINUX_INSTALL_SMOKE === 'true'
        ? await smokeInstalledPackage({ packageName, debPath, version, smokeRoot, configHome })
        : null;
    return {
      package: { name: packageName, version, architecture, depends: dependencyNames },
      launcher: path.relative(extractRoot, launcher),
      runtime: nodeVersion.stdout.trim(),
      service,
      ...(installedPackage ? { installedPackage } : {}),
    };
  } finally {
    await fs.rm(smokeRoot, { recursive: true, force: true });
  }
}

async function smokeInstalledPackage({ packageName, debPath, version, smokeRoot, configHome }) {
  let installed = false;
  try {
    await runChecked('sudo', ['apt-get', 'install', '--yes', debPath], { timeoutMs: 300_000 });
    installed = true;
    const listedFiles = await runChecked('dpkg-query', ['--listfiles', packageName]);
    const cli = listedFiles.stdout.split(/\r?\n/).find((entry) => entry.endsWith('/xyst/src/cli.mjs'));
    assert.ok(cli, 'Installed package is missing xyst/src/cli.mjs');
    const resourceRoot = cli.slice(0, -'/src/cli.mjs'.length);
    await assertPackagedSourcesMatch(resourceRoot);
    const node = path.join(resourceRoot, 'runtime', 'node');
    await assertRegularFile(path.join(resourceRoot, 'LICENSE'), 'Installed DEB is missing Xyst AI Assistant license text');
    const notice = await fs.readFile(path.join(resourceRoot, 'licenses', 'THIRD-PARTY-NOTICES.md'), 'utf8');
    assert.match(notice, /^THIRD-PARTY LICENSE NOTICES/m);
    assert.match(notice, /SPDX: MPL-2\.0/);
    const nodeVersion = await runChecked(node, ['--version']);
    assert.match(nodeVersion.stdout.trim(), /^v\d+\.\d+\.\d+$/);

    const workspace = path.join(smokeRoot, 'installed-workspace');
    await fs.mkdir(workspace);
    const retainedConfig = path.join(configHome, 'xyst-ai-assistant', 'config.toml');
    const retainedConfigContent = '# Xyst AI Assistant user settings retention smoke\n';
    await fs.mkdir(path.dirname(retainedConfig), { recursive: true });
    await fs.writeFile(retainedConfig, retainedConfigContent, { flag: 'wx' });
    const service = await smokeBundledService({
      node,
      cli,
      workspace,
      env: { ...safeProcessEnvironment(process.env), XDG_CONFIG_HOME: configHome },
    });
    const upgradeRollback =
      process.env.XYST_LINUX_UPGRADE_SMOKE === 'true'
        ? await smokeInstalledUpgradeRollback({
            packageName,
            debPath,
            version,
            node,
            cli,
            smokeRoot,
            configHome,
            retainedConfig,
            retainedConfigContent,
          })
        : null;
    const desktopWindow = await smokeInstalledDesktopWindow({ packageName, smokeRoot });

    await runChecked('sudo', ['apt-get', 'purge', '--yes', packageName], { timeoutMs: 300_000 });
    installed = false;
    assert.equal(await fs.readFile(retainedConfig, 'utf8'), retainedConfigContent, 'Package removal must retain user configuration');
    assertPackagePurged(packageName);
    return {
      installedAndPurged: true,
      userConfigurationRetained: true,
      service,
      ...(upgradeRollback ? { upgradeRollback } : {}),
      desktopWindow,
    };
  } finally {
    if (installed) await runChecked('sudo', ['apt-get', 'purge', '--yes', packageName], { timeoutMs: 300_000 });
  }
}

async function assertPackagedSourcesMatch(resourceRoot) {
  for (const relativePath of [
    'gui/app.mjs',
    'gui/timeline.mjs',
    'gui/web-search-settings.mjs',
    'src/config/load.mjs',
    'src/core/agent.mjs',
    'src/core/contracts.d.ts',
    'src/core/final-response.mjs',
    'src/core/injection-signals.mjs',
    'src/core/router.mjs',
    'src/providers/openai-compatible.mjs',
    'src/providers/factory.mjs',
    'src/providers/discovery.mjs',
    'src/tools/mcp-http.mjs',
    'src/session/compaction.mjs',
    'src/api/server.mjs',
    'src/api/client.mjs',
  ]) {
    const packagedSource = path.join(resourceRoot, relativePath);
    await assertRegularFile(packagedSource, `The DEB is missing packaged Xyst source: ${relativePath}`);
    assert.deepEqual(
      await fs.readFile(packagedSource),
      await fs.readFile(path.join(ROOT, relativePath)),
      `The DEB source must match the workspace build input: ${relativePath}`,
    );
  }
}

async function smokeInstalledUpgradeRollback({
  packageName,
  debPath,
  version,
  node,
  cli,
  smokeRoot,
  configHome,
  retainedConfig,
  retainedConfigContent,
}) {
  const upgradeVersion = nextPatchVersion(version);
  const packageRoot = path.join(smokeRoot, 'upgrade-package-root');
  await fs.mkdir(packageRoot);
  await runChecked('dpkg-deb', ['--raw-extract', debPath, packageRoot], { timeoutMs: 180_000 });

  const controlPath = path.join(packageRoot, 'DEBIAN', 'control');
  const controlLines = (await fs.readFile(controlPath, 'utf8')).split(/\r?\n/);
  const versionLineIndexes = controlLines.flatMap((line, index) => (line.startsWith('Version: ') ? [index] : []));
  assert.equal(versionLineIndexes.length, 1, 'The DEB control file must contain one Version field');
  assert.equal(controlLines[versionLineIndexes[0]], `Version: ${version}`, 'The DEB control version must match package.json');
  controlLines[versionLineIndexes[0]] = `Version: ${upgradeVersion}`;

  const upgradePackage = path.join(smokeRoot, `xyst-upgrade-${upgradeVersion}.deb`);
  await fs.writeFile(controlPath, controlLines.join('\n'));
  await runChecked('dpkg-deb', ['--build', '--root-owner-group', packageRoot, upgradePackage], { timeoutMs: 180_000 });

  await runChecked('sudo', ['apt-get', 'install', '--yes', '--allow-downgrades', upgradePackage], { timeoutMs: 300_000 });
  assert.equal(await installedPackageVersion(packageName), upgradeVersion, 'The package manager must install the newer DEB version');
  assert.equal(await fs.readFile(retainedConfig, 'utf8'), retainedConfigContent, 'An upgrade must retain user configuration');
  const upgradeWorkspace = path.join(smokeRoot, 'upgrade-workspace');
  await fs.mkdir(upgradeWorkspace);
  const upgradeService = await smokeBundledService({
    node,
    cli,
    workspace: upgradeWorkspace,
    env: { ...safeProcessEnvironment(process.env), XDG_CONFIG_HOME: configHome },
  });

  await runChecked('sudo', ['apt-get', 'install', '--yes', '--allow-downgrades', debPath], { timeoutMs: 300_000 });
  assert.equal(await installedPackageVersion(packageName), version, 'Rollback must restore the original DEB version');
  assert.equal(await fs.readFile(retainedConfig, 'utf8'), retainedConfigContent, 'Rollback must retain user configuration');
  const rollbackWorkspace = path.join(smokeRoot, 'rollback-workspace');
  await fs.mkdir(rollbackWorkspace);
  const rollbackService = await smokeBundledService({
    node,
    cli,
    workspace: rollbackWorkspace,
    env: { ...safeProcessEnvironment(process.env), XDG_CONFIG_HOME: configHome },
  });

  return { upgradedTo: upgradeVersion, rolledBackTo: version, userConfigurationRetained: true, upgradeService, rollbackService };
}

function nextPatchVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/.exec(version);
  assert.ok(match, `Cannot derive an upgrade version from package version ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

async function installedPackageVersion(packageName) {
  const versionField = '--showformat=$' + '{Version}';
  return (await runChecked('dpkg-query', ['--show', versionField, packageName])).stdout.trim();
}

function assertPackagePurged(packageName) {
  const result = spawnSync('dpkg-query', ['--show', packageName], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    shell: false,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 1, `Package ${packageName} must be absent after purge`);
  assert.equal(result.stdout, '', `Package ${packageName} must not remain in the package database`);
}

async function smokeInstalledDesktopWindow({ packageName, smokeRoot }) {
  const listedFiles = await runChecked('dpkg-query', ['--listfiles', packageName]);
  const executable = listedFiles.stdout.split(/\r?\n/).find((entry) => entry.endsWith('/xyst-desktop'));
  assert.ok(executable, 'Installed package is missing /usr/bin/xyst-desktop');
  const desktopRoot = path.join(smokeRoot, 'desktop-window');
  const workspace = path.join(desktopRoot, 'workspace');
  const configHome = path.join(desktopRoot, 'config');
  const runtimeDirectory = path.join(desktopRoot, 'runtime');
  const homeDirectory = path.join(desktopRoot, 'home');
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(configHome, { recursive: true });
  await fs.mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  await fs.mkdir(homeDirectory, { recursive: true });
  await fs.chmod(runtimeDirectory, 0o700);

  const desktopUser = resolveUnprivilegedDesktopUser();
  if (desktopUser) {
    await fs.chmod(smokeRoot, 0o755);
    for (const directory of [desktopRoot, workspace, configHome, runtimeDirectory, homeDirectory])
      await fs.chown(directory, desktopUser.uid, desktopUser.gid);
  }

  const smokeScript = path.join(ROOT, 'scripts', 'smoke-linux-desktop-window.mjs');
  const desktopCommand = desktopUser ? 'runuser' : 'xvfb-run';
  const desktopArgs = desktopUser
    ? [
        '-u',
        desktopUser.name,
        '--',
        'env',
        '-u',
        'DBUS_SESSION_BUS_ADDRESS',
        `HOME=${homeDirectory}`,
        `XDG_CONFIG_HOME=${configHome}`,
        `XDG_DATA_HOME=${path.join(configHome, 'data')}`,
        `XDG_STATE_HOME=${path.join(configHome, 'state')}`,
        `XDG_CACHE_HOME=${path.join(configHome, 'cache')}`,
        `XDG_RUNTIME_DIR=${runtimeDirectory}`,
        'xvfb-run',
        '-a',
        '-s',
        '-screen 0 1800x1200x24',
        'dbus-run-session',
        '--',
      ]
    : ['-a', '-s', '-screen 0 1800x1200x24', 'dbus-run-session', '--'];
  desktopArgs.push(process.execPath, smokeScript, '--executable', executable, '--workspace', workspace, '--config-home', configHome);
  const result = await runChecked(desktopCommand, desktopArgs, { timeoutMs: 120_000 });
  const smoke = parseSmokeJson(result.stdout);
  assert.equal(smoke.resizedWindow?.width, 760, 'Installed Linux desktop must resize to its supported minimum width');
  assert.equal(smoke.resizedWindow?.height, 540, 'Installed Linux desktop must resize to its supported minimum height');
  assert.equal(smoke.restoredWindow?.width, 760, 'Installed Linux desktop must restore its saved width after restart');
  assert.equal(smoke.restoredWindow?.height, 540, 'Installed Linux desktop must restore its saved height after restart');
  assert.equal(smoke.desktopAutomation?.inspect, true, 'Installed Linux desktop smoke must inspect the live accessibility tree');
  assert.equal(
    smoke.desktopAutomation?.accessibilityClick,
    'completed',
    'Installed Linux desktop smoke must activate a control through AT-SPI',
  );
  assert.equal(
    smoke.desktopAutomation?.coordinateClick,
    'completed',
    'Installed Linux desktop smoke must click a control through X11 input',
  );
  return smoke;
}

function resolveUnprivilegedDesktopUser() {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return null;
  const result = spawnSync('getent', ['passwd', '1000'], {
    encoding: 'utf8',
    maxBuffer: 16_384,
    shell: false,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'Running the Linux desktop smoke as root requires an unprivileged UID 1000 desktop user');
  const [name, , uidText, gidText] = result.stdout.trim().split(':');
  const uid = Number(uidText);
  const gid = Number(gidText);
  assert.match(name || '', /^[a-z_][a-z0-9_-]*[$]?$/i, 'UID 1000 must resolve to a valid desktop user');
  assert.ok(Number.isSafeInteger(uid) && uid > 0, 'UID 1000 must not resolve to root');
  assert.ok(Number.isSafeInteger(gid) && gid >= 0, "The desktop user's primary group must be valid");
  return { name, uid, gid };
}

export function parseSmokeJson(output) {
  if (typeof output !== 'string') throw new TypeError('Linux desktop smoke output must be a string');
  const jsonLines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .reverse();
  if (!jsonLines.length) throw new Error('Linux desktop smoke returned no JSON result');
  let lastError;
  for (const line of jsonLines) {
    try {
      const result = JSON.parse(line);
      if (result && typeof result === 'object' && !Array.isArray(result)) return result;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error('Linux desktop smoke returned no valid JSON result', { cause: lastError });
}

async function assertRegularFile(filePath, message) {
  const stat = await fs.lstat(filePath).catch((error) => {
    if (error.code === 'ENOENT') throw new Error(message);
    throw error;
  });
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), message);
}

function runChecked(command, args, { timeoutMs = 30_000, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = [result.stderr, result.stdout].filter((value) => value?.trim()).map((value) => value.trim()).join('\n');
    throw new Error(`${command} exited with ${result.status}${output ? `:\n${output.slice(-12_000)}` : ''}`);
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  smokeLinuxPackage({ packagePath: process.argv[2] })
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.stack || error}\n`);
      process.exitCode = 1;
    });
}
