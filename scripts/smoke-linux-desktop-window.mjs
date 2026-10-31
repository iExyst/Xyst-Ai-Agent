import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { controlDesktop } from '../src/platform/desktop-automation.mjs';
import { safeProcessEnvironment } from '../src/platform/process.mjs';

const DEFAULT_TIMEOUT_MS = 45_000;
const REQUIRED_ACCESSIBLE_NAMES = [
  'Workspace and sessions',
  'Recent conversations',
  'Message composer',
  'Run mode',
  'Agent',
  'Plan',
  'Review',
  'Settings',
];

const ACCESSIBILITY_PROBE = String.raw`
import json
import re
import sys
import time

import pyatspi

required = json.loads(sys.argv[1])
deadline = time.monotonic() + float(sys.argv[2])
last_names = []
status_text = []
missing = required

def normalized(value):
    return re.sub(r"\s+", " ", value).strip().casefold()

while time.monotonic() < deadline:
    names = []
    status_text = []
    pending = [pyatspi.Registry.getDesktop(0)]
    visited = 0
    while pending and visited < 12000:
        node = pending.pop()
        visited += 1
        try:
            name = node.name
            if isinstance(name, str) and name.strip():
                names.append(re.sub(r"\s+", " ", name).strip())
        except Exception:
            pass
        try:
            role = node.getRoleName().casefold()
            if role in {"alert", "status bar", "statusbar"}:
                text = node.queryText().getText(0, -1)
                if isinstance(text, str) and text.strip():
                    status_text.append(re.sub(r"\s+", " ", text).strip()[:500])
        except Exception:
            pass
        try:
            child_count = min(node.childCount, 12000 - visited)
            for index in range(child_count):
                child = node.getChildAtIndex(index)
                if child is not None:
                    pending.append(child)
        except Exception:
            pass

    last_names = names
    normalized_names = {normalized(name) for name in names}
    missing = [name for name in required if normalized(name) not in normalized_names]
    if not missing:
        print(json.dumps({"accessibleNames": names, "requiredNames": required, "statusText": status_text[-10:]}))
        sys.exit(0)
    time.sleep(0.25)

print(json.dumps({"missingNames": missing, "observedNames": last_names[-100:], "statusText": status_text[-10:]}), file=sys.stderr)
sys.exit(1)
`;

export async function smokeLinuxDesktopWindow({ executable, workspace, configHome, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (process.platform !== 'linux') throw new Error('The native Linux desktop smoke must run on Linux');
  if (!process.env.DISPLAY) throw new Error('The native Linux desktop smoke requires an X11 display');
  if (typeof executable !== 'string' || !path.isAbsolute(executable))
    throw new TypeError('The installed Xyst AI Assistant desktop executable path must be absolute');
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace))
    throw new TypeError('The desktop smoke workspace path must be absolute');
  if (typeof configHome !== 'string' || !path.isAbsolute(configHome))
    throw new TypeError('The desktop smoke configuration path must be absolute');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new TypeError('The desktop smoke timeout must be between 1 and 120000 milliseconds');

  const executableStat = await fs.stat(executable);
  if (!executableStat.isFile() || (executableStat.mode & 0o111) === 0)
    throw new Error('The installed Xyst AI Assistant desktop launcher must be an executable file');
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(configHome, { recursive: true });

  const env = {
    ...safeProcessEnvironment(process.env),
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: path.join(configHome, 'data'),
    XDG_STATE_HOME: path.join(configHome, 'state'),
    XDG_CACHE_HOME: path.join(configHome, 'cache'),
    GDK_BACKEND: 'x11',
    WAYLAND_DISPLAY: '',
    NO_AT_BRIDGE: '0',
  };
  const launch = () => {
    const child = spawn(executable, ['--workspace', workspace], {
      cwd: workspace,
      env,
      detached: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let startupError;
    child.on('error', (error) => {
      startupError = error;
    });
    const processOutput = collectProcessOutput(child, 100_000);
    return { child, processOutput, getStartupError: () => startupError };
  };
  let launched = launch();
  let windowId;
  let accessibility;
  try {
    windowId = await waitForWindow(launched.child, timeoutMs, launched.processOutput, launched.getStartupError);
    const geometry = readWindowGeometry(windowId);
    assert.ok(geometry.width >= 900, `The desktop window is narrower than 900 pixels: ${geometry.width}`);
    assert.ok(geometry.height >= 600, `The desktop window is shorter than 600 pixels: ${geometry.height}`);
    try {
      accessibility = readAccessibilityTree(env, Math.max(1, timeoutMs - 5_000));
    } catch (error) {
      throw new Error(`${error.message}\nDesktop process output: ${launched.processOutput()}`, { cause: error });
    }
    let desktopAutomation;
    try {
      desktopAutomation = await verifyDesktopAutomation(env, Math.min(timeoutMs, 15_000));
    } catch (error) {
      const failedResource = await inspectFailedStartupResource(error.statusMessages || accessibility.statusText);
      throw new Error(
        `${error.message}\nFailed resource response: ${failedResource}\nDesktop process output: ${launched.processOutput()}`,
        { cause: error },
      );
    }
    const resizedWindow = await resizeWindow(windowId, 760, 540, Math.min(timeoutMs, 10_000));
    const statePath = path.join(configHome, 'dev.xyst.ai-assistant', 'window-state.json');
    await waitForPersistedBounds(statePath, resizedWindow, Math.min(timeoutMs, 10_000));
    await stopDesktop(launched.child, windowId);
    launched = launch();
    windowId = await waitForWindow(launched.child, timeoutMs, launched.processOutput, launched.getStartupError);
    const restoredWindow = await waitForGeometry(windowId, resizedWindow, Math.min(timeoutMs, 10_000));
    return {
      title: 'Xyst AI Assistant',
      window: geometry,
      resizedWindow,
      restoredWindow,
      accessibleControls: accessibility.requiredNames,
      accessibleNameCount: accessibility.accessibleNames.length,
      desktopAutomation,
    };
  } finally {
    await stopDesktop(launched.child, windowId);
  }
}

async function resizeWindow(windowId, width, height, timeoutMs) {
  const result = spawnSync('xdotool', ['windowsize', windowId, String(width), String(height)], {
    encoding: 'utf8',
    timeout: 2_000,
    maxBuffer: 16_384,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Could not resize the Xyst AI Assistant window: ${result.stderr.trim()}`);
  const deadline = Date.now() + timeoutMs;
  let geometry;
  while (Date.now() < deadline) {
    geometry = readWindowGeometry(windowId);
    if (geometry.width >= width && geometry.height >= height && geometry.width <= width + 4 && geometry.height <= height + 4)
      return geometry;
    await delay(100);
  }
  throw new Error(`Xyst AI Assistant window did not resize to ${width}x${height}; observed ${geometry?.width}x${geometry?.height}`);
}

async function waitForGeometry(windowId, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let geometry;
  while (Date.now() < deadline) {
    geometry = readWindowGeometry(windowId);
    if (Math.abs(geometry.width - expected.width) <= 4 && Math.abs(geometry.height - expected.height) <= 4) return geometry;
    await delay(100);
  }
  throw new Error(
    `Xyst AI Assistant did not restore its saved size ${expected.width}x${expected.height}; observed ${geometry?.width}x${geometry?.height}`,
  );
}

async function waitForPersistedBounds(statePath, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let observed;
  while (Date.now() < deadline) {
    try {
      observed = JSON.parse(await fs.readFile(statePath, 'utf8'));
      if (Math.abs(observed.width - expected.width) <= 4 && Math.abs(observed.height - expected.height) <= 4) return;
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    await delay(100);
  }
  throw new Error(`Xyst AI Assistant did not persist resized bounds to ${statePath}: ${JSON.stringify(observed)}`);
}

function collectProcessOutput(child, maxBytes) {
  const chunks = [];
  let byteCount = 0;
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      const remaining = Math.max(0, maxBytes - byteCount);
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      byteCount += Math.min(chunk.length, remaining);
    });
  }
  return () => Buffer.concat(chunks).toString('utf8').slice(-maxBytes);
}

async function waitForWindow(child, timeoutMs, processOutput, getStartupError) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const startupError = getStartupError();
    if (startupError) throw new Error(`Could not launch the installed Xyst AI Assistant desktop: ${startupError.message}`);
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Xyst AI Assistant desktop exited before creating a window: ${processOutput()}`);
    const result = spawnSync('xdotool', ['search', '--onlyvisible', '--name', '^Xyst AI Assistant$'], {
      encoding: 'utf8',
      timeout: 1_000,
      maxBuffer: 16_384,
      shell: false,
    });
    if (result.error && result.error.code !== 'ETIMEDOUT') throw result.error;
    const windowId = result.status === 0 ? result.stdout.trim().split(/\s+/)[0] : '';
    if (/^\d+$/.test(windowId)) return windowId;
    await delay(250);
  }
  throw new Error(`Xyst AI Assistant desktop did not create a visible window within ${timeoutMs} ms: ${processOutput()}`);
}

function readWindowGeometry(windowId) {
  const result = spawnSync('xdotool', ['getwindowgeometry', '--shell', windowId], {
    encoding: 'utf8',
    timeout: 2_000,
    maxBuffer: 16_384,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Could not inspect the Xyst AI Assistant desktop window: ${result.stderr.trim()}`);
  const values = Object.fromEntries(
    result.stdout
      .split(/\r?\n/)
      .map((line) => line.match(/^(X|Y|WIDTH|HEIGHT)=(-?\d+)$/))
      .filter(Boolean)
      .map((match) => [match[1], Number(match[2])]),
  );
  assert.ok(Number.isInteger(values.WIDTH) && Number.isInteger(values.HEIGHT), 'X11 did not report the Xyst AI Assistant window size');
  return { x: values.X, y: values.Y, width: values.WIDTH, height: values.HEIGHT };
}

function readAccessibilityTree(env, timeoutMs) {
  const result = spawnSync(
    '/usr/bin/python3',
    ['-c', ACCESSIBILITY_PROBE, JSON.stringify(REQUIRED_ACCESSIBLE_NAMES), String(timeoutMs / 1000)],
    {
      encoding: 'utf8',
      env,
      timeout: timeoutMs + 3_000,
      maxBuffer: 1_000_000,
      shell: false,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Xyst AI Assistant accessibility smoke failed: ${(result.stderr || result.stdout).trim()}`);
  return JSON.parse(result.stdout);
}

async function verifyDesktopAutomation(env, timeoutMs) {
  const options = { platform: 'linux', env, timeoutMs };
  let statusMessages = [];
  const inspect = async () => {
    const result = await controlDesktop({ action: 'inspect', max_elements: 250 }, options);
    assert.equal(result.platform, 'linux', 'Desktop automation did not use the Linux backend');
    statusMessages = result.status_messages || [];
    return flattenNodes(result.windows);
  };
  const find = (nodes, name) => nodes.find((node) => node.name === name);
  const waitFor = async (predicate, description) => {
    const deadline = Date.now() + timeoutMs;
    let nodes = [];
    while (Date.now() < deadline) {
      nodes = await inspect();
      if (predicate(nodes)) return nodes;
      await delay(150);
    }
    const observed = nodes
      .filter((node) => node.name)
      .map((node) => `${node.name} (${node.role})`)
      .slice(0, 80)
      .join(' · ');
    const error = new Error(
      `Linux desktop automation did not observe ${description}. Status messages: ${JSON.stringify(statusMessages)}. Observed controls: ${observed}`,
    );
    error.statusMessages = statusMessages;
    throw error;
  };

  let nodes = await inspect();
  for (const name of ['Agent', 'Plan', 'Review']) {
    const modeTab = nodes.find((node) => node.name === name && node.role.toLowerCase().includes('tab'));
    assert.ok(modeTab, `Linux AT-SPI inspection did not find the ${name} mode tab`);
  }
  const settingsButton = nodes.find((node) => node.name === 'Settings' && node.role.toLowerCase().includes('push button'));
  assert.ok(
    settingsButton,
    `Linux AT-SPI inspection did not find the Settings button. Observed controls: ${nodes
      .filter((node) => node.name)
      .map((node) => `${node.name} (${node.role})`)
      .slice(0, 50)
      .join(' · ')}`,
  );
  const settingsBounds = settingsButton.bounds;
  assert.ok(
    settingsBounds &&
      Number.isFinite(settingsBounds.x) &&
      Number.isFinite(settingsBounds.y) &&
      settingsBounds.width > 0 &&
      settingsBounds.height > 0,
    'Linux AT-SPI did not provide usable bounds for the Settings button',
  );
  assert.equal(find(nodes, 'Close settings'), undefined, 'The settings dialog should start closed in the isolated profile');
  const settingsPageClick = await controlDesktop(
    {
      action: 'click_at',
      x: Math.floor(settingsBounds.x + settingsBounds.width / 2),
      y: Math.floor(settingsBounds.y + settingsBounds.height / 2),
    },
    options,
  );
  assert.equal(settingsPageClick.status, 'completed');

  try {
    nodes = await waitFor(
      (items) => items.some((node) => node.name === 'Choose an AI' && node.role.toLowerCase().includes('heading')),
      'the Choose an AI settings page',
    );
  } catch (error) {
    const wrapped = new Error(
      `${error.message}\nSettings button bounds: ${JSON.stringify(settingsBounds)}; click: ${JSON.stringify(settingsPageClick)}`,
      { cause: error },
    );
    wrapped.statusMessages = error.statusMessages;
    throw wrapped;
  }
  const safetyButton = nodes.find((node) => node.name.includes('Permissions') && node.role.toLowerCase().includes('push button'));
  assert.ok(safetyButton, 'Linux AT-SPI did not find the Permissions settings category');
  const accessibilityClick = await controlDesktop(
    { action: 'click', element_path: safetyButton.path, expected_name: safetyButton.name },
    options,
  );
  assert.equal(accessibilityClick.status, 'completed');
  nodes = await waitFor(
    (items) => items.some((node) => node.name === 'Permissions and safety' && node.role.toLowerCase().includes('heading')),
    'the Permissions and safety settings category',
  );

  const updatesButton = nodes.find((node) => node.name.includes('Updates') && node.role.toLowerCase().includes('push button'));
  assert.ok(updatesButton, 'Linux AT-SPI did not find the Updates settings category');
  const bounds = updatesButton.bounds;
  assert.ok(
    bounds && Number.isFinite(bounds.x) && Number.isFinite(bounds.y) && bounds.width > 0 && bounds.height > 0,
    'Linux AT-SPI did not provide usable bounds for the Updates settings category',
  );
  const coordinateClick = await controlDesktop(
    {
      action: 'click_at',
      x: Math.floor(bounds.x + bounds.width / 2),
      y: Math.floor(bounds.y + bounds.height / 2),
    },
    options,
  );
  assert.equal(coordinateClick.status, 'completed');
  await waitFor(
    (items) => items.some((node) => node.name === 'Updates' && node.role.toLowerCase().includes('heading')),
    'the Updates settings category',
  );

  return { inspect: true, settingsPage: 'completed', accessibilityClick: 'completed', coordinateClick: 'completed' };
}

async function inspectFailedStartupResource(statusMessages) {
  const match = (statusMessages || []).join(' ').match(/https?:\/\/127\.0\.0\.1:\d+\/app\/[A-Za-z0-9_./-]+/);
  if (!match) return 'none identified';
  try {
    const response = await fetch(match[0], { redirect: 'error', signal: AbortSignal.timeout(2_000) });
    return JSON.stringify({ url: match[0], status: response.status, contentType: response.headers.get('content-type') });
  } catch (error) {
    return JSON.stringify({ url: match[0], error: error.message.slice(0, 200) });
  }
}

function flattenNodes(nodes) {
  return (nodes || []).flatMap((node) => [node, ...flattenNodes(node.children)]);
}

async function stopDesktop(child, windowId) {
  if (windowId && child.exitCode === null && child.signalCode === null) {
    spawnSync('xdotool', ['windowclose', windowId], { stdio: 'ignore', timeout: 2_000, shell: false });
    if (await waitForExit(child, 8_000)) return;
  }

  if (!child.pid) return;
  signalProcessGroup(child.pid, 'SIGTERM');
  await delay(1_000);
  if (isProcessGroupAlive(child.pid)) signalProcessGroup(child.pid, 'SIGKILL');
  await waitForExit(child, 1_000);
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function isProcessGroupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (!['--executable', '--workspace', '--config-home'].includes(option) || !value || value.startsWith('--'))
      throw new Error('Usage: node smoke-linux-desktop-window.mjs --executable PATH --workspace DIR --config-home DIR');
    if (values.has(option)) throw new Error(`Duplicate option: ${option}`);
    values.set(option, value);
    index += 1;
  }
  const options = {
    executable: values.get('--executable'),
    workspace: values.get('--workspace'),
    configHome: values.get('--config-home'),
  };
  if (Object.values(options).some((value) => !value))
    throw new Error('Usage: node smoke-linux-desktop-window.mjs --executable PATH --workspace DIR --config-home DIR');
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await smokeLinuxDesktopWindow(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  }
}
