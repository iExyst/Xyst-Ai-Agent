import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWindowsPowerShellPath, runProcess, terminateProcessTree } from '../src/platform/process.mjs';

const CONTROL_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'windows-desktop-window-control.ps1');
const TITLE = 'Xyst AI Assistant';
const DEFAULT_TIMEOUT_MS = 60_000;

export async function smokeWindowsDesktopWindow({
  executable,
  workspace,
  alternateWorkingDirectory,
  appConfigDirectory,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (process.platform !== 'win32') throw new Error('The native Windows desktop smoke must run on Windows');
  for (const [name, value] of Object.entries({ executable, workspace, alternateWorkingDirectory, appConfigDirectory })) {
    if (typeof value !== 'string' || !path.win32.isAbsolute(value)) throw new TypeError(`${name} must be an absolute Windows path`);
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new TypeError('The desktop smoke timeout must be between 1 and 120000 milliseconds');

  const executableStat = await fs.lstat(executable);
  if (!executableStat.isFile() || executableStat.isSymbolicLink())
    throw new Error('The installed desktop executable must be a regular file');
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(alternateWorkingDirectory, { recursive: true });
  await fs.mkdir(appConfigDirectory, { recursive: true });

  const powershell = resolveWindowsPowerShellPath();
  if (!powershell) throw new Error('Windows PowerShell could not be resolved for the native desktop smoke');
  const processEnvironment = {
    ...env,
    XYST_TEST_APP_DIRECTORIES_ROOT: appConfigDirectory,
    WEBVIEW2_USER_DATA_FOLDER: path.join(path.dirname(appConfigDirectory), 'XystWebView2Smoke'),
  };
  const children = [];
  const launch = async (args, cwd) => {
    const child = spawn(executable, args, { cwd, env: processEnvironment, stdio: 'ignore', windowsHide: false });
    children.push(child);
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        child.removeListener('spawn', onSpawn);
        child.removeListener('error', onError);
      };
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(new Error(`Could not launch the Xyst desktop executable: ${error.message}`, { cause: error }));
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
      if (child.pid !== undefined) onSpawn();
    });
    return child;
  };
  let first;
  try {
    first = await launch(['--workspace', workspace], workspace);
    const initialWindow = await invokeControl(powershell, 'wait', first.pid, { timeoutMs, env: processEnvironment });
    assert.equal(initialWindow.title, TITLE);
    assert.ok(initialWindow.width >= 900, `The Windows desktop window opened too narrow: ${initialWindow.width}px`);
    assert.ok(initialWindow.height >= 600, `The Windows desktop window opened too short: ${initialWindow.height}px`);
    assert.equal(initialWindow.hung, false, 'The new Windows desktop window must respond to the operating system');

    const resizedWindow = await invokeControl(powershell, 'resize', first.pid, {
      width: 760,
      height: 540,
      timeoutMs: Math.min(timeoutMs, 15_000),
      env: processEnvironment,
    });
    const statePath = path.join(appConfigDirectory, 'window-state.json');
    const workspacePath = path.join(appConfigDirectory, 'last-workspace.json');
    await waitForLastWorkspace(workspacePath, workspace, Math.min(timeoutMs, 10_000));
    await closeWindow(powershell, first, timeoutMs, processEnvironment);
    await waitForWindowState(statePath, resizedWindow, Math.min(timeoutMs, 10_000));

    const resumed = await launch([], alternateWorkingDirectory);
    const restoredWindow = await invokeControl(powershell, 'wait-size', resumed.pid, {
      width: resizedWindow.logical_width,
      height: resizedWindow.logical_height,
      timeoutMs,
      env: processEnvironment,
    });
    await waitForLastWorkspace(workspacePath, workspace, Math.min(timeoutMs, 10_000));
    assert.equal(restoredWindow.title, TITLE);
    assert.equal(restoredWindow.hung, false, 'The restored Windows desktop window must respond to the operating system');
    await closeWindow(powershell, resumed, timeoutMs, processEnvironment);

    return {
      title: TITLE,
      initialWindow,
      resizedWindow,
      restoredWindow,
      lastWorkspaceRestored: true,
    };
  } finally {
    for (const child of children) {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
      try {
        terminateProcessTree(child, 'force');
      } catch {
        // The process may exit between the state check and the cleanup request.
      }
      await waitForChildExit(child, 5_000).catch(() => {});
    }
  }
}

async function invokeControl(powershell, action, processId, { width, height, timeoutMs, env }) {
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    CONTROL_SCRIPT,
    '-Action',
    action,
    '-ProcessId',
    String(processId),
    '-TimeoutMs',
    String(timeoutMs),
  ];
  if (width !== undefined) args.push('-Width', String(width));
  if (height !== undefined) args.push('-Height', String(height));
  const result = await runProcess(powershell, args, {
    cwd: path.dirname(CONTROL_SCRIPT),
    env,
    timeoutMs: timeoutMs + 5_000,
    maxOutputBytes: 16_384,
  });
  if (result.exitCode !== 0) throw new Error(`Windows desktop ${action} operation failed: ${result.stderr.trim() || result.stdout.trim()}`);
  try {
    return JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error(`Windows desktop ${action} operation returned invalid JSON: ${result.stdout.trim()}`, { cause: error });
  }
}

async function waitForWindowState(statePath, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const scale = (expected.dpi || 96) / 96;
  const expectedWidth = Math.round(expected.width * scale);
  const expectedHeight = Math.round(expected.height * scale);
  let observed;
  while (Date.now() < deadline) {
    observed = await readJsonState(statePath);
    if (
      observed &&
      Math.abs(observed.width - expectedWidth) <= 4 &&
      Math.abs(observed.height - expectedHeight) <= 4 &&
      observed.maximized === false
    )
      return;
    await delay(100);
  }
  throw new Error(`The Windows desktop did not persist the resized window bounds: ${JSON.stringify(observed)}`);
}

async function waitForLastWorkspace(statePath, workspace, timeoutMs) {
  const expected = normalizeWindowsPath(await fs.realpath(workspace));
  const deadline = Date.now() + timeoutMs;
  let observed;
  while (Date.now() < deadline) {
    observed = await readJsonState(statePath);
    if (observed && typeof observed.path === 'string' && normalizeWindowsPath(observed.path) === expected) return;
    await delay(100);
  }
  throw new Error(`The Windows desktop did not persist its workspace: ${JSON.stringify(observed)}`);
}

async function readJsonState(filePath) {
  try {
    const info = await fs.lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error(`Invalid desktop smoke state file: ${filePath}`);
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function closeWindow(powershell, child, timeoutMs, env) {
  await invokeControl(powershell, 'close', child.pid, { timeoutMs: Math.min(timeoutMs, 15_000), env });
  await waitForChildExit(child, Math.min(timeoutMs, 15_000));
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      reject(new Error(`Xyst desktop process ${child.pid} did not exit within ${timeoutMs} ms`));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve();
    };
    child.once('exit', onExit);
    if (child.exitCode !== null || child.signalCode !== null) onExit();
  });
}

function normalizeWindowsPath(value) {
  return path.win32.resolve(String(value).replace(/^\\\\\?\\/, '')).toLocaleLowerCase('en-US');
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
