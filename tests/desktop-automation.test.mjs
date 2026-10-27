import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildWaylandInputCommands,
  buildWindowsCommandArgs,
  controlDesktop,
  LINUX_SCRIPT,
  validateRequest,
} from '../src/platform/desktop-automation.mjs';

const LINUX_HELPER_PYTHON = process.platform === 'linux' ? 'python3' : process.env.XYST_PYTHON;

test('embedded Linux desktop helper has valid Python syntax on Linux CI', (t) => {
  if (!LINUX_HELPER_PYTHON) return t.skip('Set XYST_PYTHON to also run Linux helper checks on another host');
  const result = spawnSync(LINUX_HELPER_PYTHON, ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], {
    input: LINUX_SCRIPT,
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || 'Python failed to parse the embedded Linux helper');
});

test('embedded Linux X11 helper emits coordinate clicks and both scroll axes', (t) => {
  if (!LINUX_HELPER_PYTHON) return t.skip('Set XYST_PYTHON to execute Linux helper fixtures on Windows');
  const prelude = [
    'import base64,json,subprocess,sys,types',
    'fake=types.ModuleType("pyatspi")',
    'fake.Registry=type("Registry",(),{"getDesktop":staticmethod(lambda index:type("Desktop",(),{"childCount":0})())})',
    'sys.modules["pyatspi"]=fake',
    'calls=[]',
    'def run(args,**kwargs):',
    ' calls.append(args)',
    ' return subprocess.CompletedProcess(args,0,"1920 1080\\n" if args[:2]==["xdotool","getdisplaygeometry"] else "","")',
    'subprocess.run=run',
    'script=base64.b64decode(sys.argv[1]).decode("utf-8")',
    'exec(compile(script,"linux-desktop-helper","exec"))',
    'print(json.dumps(calls))',
  ].join('\n');
  for (const [request, expectedTail] of [
    [
      { action: 'click_at', x: 420, y: 180, button: 'right', click_count: 2 },
      [
        ['xdotool', 'mousemove', '--sync', '420', '180'],
        ['xdotool', 'click', '--clearmodifiers', '3'],
        ['xdotool', 'click', '--clearmodifiers', '3'],
      ],
    ],
    [
      { action: 'scroll_at', x: 420, y: 180, delta_x: -240, delta_y: 360 },
      [
        ['xdotool', 'mousemove', '--sync', '420', '180'],
        ['xdotool', 'click', '4'],
        ['xdotool', 'click', '4'],
        ['xdotool', 'click', '4'],
        ['xdotool', 'click', '6'],
        ['xdotool', 'click', '6'],
      ],
    ],
  ]) {
    const result = spawnSync(LINUX_HELPER_PYTHON, ['-c', prelude, Buffer.from(LINUX_SCRIPT).toString('base64')], {
      input: JSON.stringify(request),
      encoding: 'utf8',
      env: { ...process.env, DISPLAY: ':1' },
      timeout: 10_000,
      windowsHide: true,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const lines = result.stdout.trim().split(/\r?\n/);
    assert.deepEqual(JSON.parse(lines.at(-1)).slice(1), expectedTail);
  }
});

test('desktop automation validates selectors and action-specific payloads', () => {
  assert.doesNotThrow(() => validateRequest({ action: 'inspect', max_elements: 250 }));
  assert.doesNotThrow(() => validateRequest({ action: 'click', element_path: '0.1.22', expected_name: 'Save' }));
  assert.doesNotThrow(() =>
    validateRequest({ action: 'click', element_path: Array(13).fill('0').join('.'), expected_name: 'Nested control' }),
  );
  assert.throws(
    () => validateRequest({ action: 'click', element_path: Array(14).fill('0').join('.'), expected_name: 'Too deep' }),
    /element_path/,
  );
  assert.doesNotThrow(() => validateRequest({ action: 'type_text', element_path: '2.0', expected_name: 'Search', text: 'hello' }));
  assert.doesNotThrow(() => validateRequest({ action: 'press_key', element_path: '1.0', expected_name: 'Editor', key: 'CTRL+S' }));
  assert.doesNotThrow(() => validateRequest({ action: 'press_key', element_path: '1.0', expected_name: 'Editor', key: 'CTRL+SHIFT+ESC' }));
  assert.doesNotThrow(() => validateRequest({ action: 'press_key', element_path: '1.0', expected_name: 'Editor', key: 'ALT+TAB' }));
  assert.doesNotThrow(() => validateRequest({ action: 'press_key', element_path: '1.0', expected_name: 'Desktop', key: 'WIN+R' }));
  assert.doesNotThrow(() => validateRequest({ action: 'press_key', element_path: '1.0', expected_name: 'Desktop', key: 'SUPER+R' }));
  assert.doesNotThrow(() => validateRequest({ action: 'press_key', element_path: '1.0', expected_name: 'Desktop', key: 'WIN' }));
  assert.doesNotThrow(() => validateRequest({ action: 'press_key', element_path: '1.0', expected_name: 'Desktop', key: 'SUPER' }));
  assert.doesNotThrow(() => validateRequest({ action: 'press_key', element_path: '1.0', expected_name: 'Editor', key: 'F16' }));
  for (const key of [
    'F17',
    'F24',
    'PRINTSCREEN',
    'PAUSE',
    'MENU',
    'NUMPAD0',
    'NUMPAD9',
    'NUMPADADD',
    'NUMPADSUBTRACT',
    'NUMPADMULTIPLY',
    'NUMPADDIVIDE',
    'NUMPADDECIMAL',
    'NUMPADENTER',
    'CTRL+NUMPADENTER',
  ])
    assert.doesNotThrow(() => validateRequest({ action: 'press_key', element_path: '1.0', expected_name: 'Editor', key }));
  assert.throws(() => validateRequest({ action: 'press_key', element_path: '1.0', expected_name: 'Editor', key: 'F25' }), /key must/);
  assert.doesNotThrow(() => validateRequest({ action: 'click_at', x: 1920, y: 1080, button: 'right', click_count: 2 }));
  assert.doesNotThrow(() => validateRequest({ action: 'drag_at', x: 10, y: 20, to_x: 30, to_y: 40, button: 'left' }));
  assert.doesNotThrow(() => validateRequest({ action: 'scroll_at', x: 0, y: 500, delta_y: -720 }));
  assert.doesNotThrow(() => validateRequest({ action: 'scroll_at', x: 0, y: 500, delta_x: 360 }));
  assert.doesNotThrow(() => validateRequest({ action: 'scroll_at', x: 0, y: 500, delta_x: -120, delta_y: 240 }));
  assert.throws(() => validateRequest({ action: 'inspect', max_elements: 251 }), /max_elements/);
  assert.throws(() => validateRequest({ action: 'click', element_path: '..', expected_name: 'Save' }), /element_path/);
  assert.throws(() => validateRequest({ action: 'click', element_path: '0', expected_name: '' }), /expected_name/);
  assert.throws(() => validateRequest({ action: 'type_text', element_path: '0', expected_name: 'Search' }), /text must/);
  assert.throws(() => validateRequest({ action: 'press_key', element_path: '0', expected_name: 'Editor', key: 'WIN+SUPER+R' }), /key must/);
  assert.throws(() => validateRequest({ action: 'press_key', element_path: '0', expected_name: 'Editor', key: 'CTRL+CTRL+A' }), /key must/);
  assert.throws(() => validateRequest({ action: 'click_at', x: Infinity, y: 2 }), /x must/);
  assert.throws(() => validateRequest({ action: 'click_at', x: 1, y: 2, button: 'launch' }), /button must/);
  assert.throws(() => validateRequest({ action: 'scroll_at', x: 1, y: 2, delta_y: 10_001 }), /delta_y must/);
  assert.throws(() => validateRequest({ action: 'scroll_at', x: 1, y: 2, delta_x: 10_001 }), /delta_x must/);
  assert.throws(() => validateRequest({ action: 'scroll_at', x: 1, y: 2 }), /non-zero/);
  assert.throws(() => validateRequest({ action: 'drag_at', x: 1, y: 2, to_x: 3, to_y: 100_001 }), /to_y must/);
  assert.throws(() => validateRequest({ action: 'drag_at', x: 1, y: 2, to_x: 3, to_y: 4, button: 'launch' }), /button must/);
});

test('Wayland input is translated into fixed ydotool and wtype argv', () => {
  assert.deepEqual(buildWaylandInputCommands({ action: 'drag_at', x: 10, y: 20, to_x: 30, to_y: 40, button: 'right' }), [
    ['ydotool', 'mousemove', '--absolute', '-x', '10', '-y', '20'],
    ['ydotool', 'click', '0x41'],
    ['ydotool', 'mousemove', '--absolute', '-x', '30', '-y', '40'],
    ['ydotool', 'click', '0x81'],
  ]);
  assert.deepEqual(buildWaylandInputCommands({ action: 'click_at', x: 420, y: 180, button: 'right', click_count: 2 }), [
    ['ydotool', 'mousemove', '--absolute', '-x', '420', '-y', '180'],
    ['ydotool', 'click', '--repeat', '2', '0xC1'],
  ]);
  assert.deepEqual(buildWaylandInputCommands({ action: 'scroll_at', x: 2, y: 3, delta_y: -720 }), [
    ['ydotool', 'mousemove', '--absolute', '-x', '2', '-y', '3'],
    ['ydotool', 'mousemove', '--wheel', '-x', '0', '-y', '-6'],
  ]);
  assert.deepEqual(buildWaylandInputCommands({ action: 'scroll_at', x: 2, y: 3, delta_x: 360, delta_y: -240 }), [
    ['ydotool', 'mousemove', '--absolute', '-x', '2', '-y', '3'],
    ['ydotool', 'mousemove', '--wheel', '-x', '3', '-y', '-2'],
  ]);
  assert.deepEqual(buildWaylandInputCommands({ action: 'press_key', key: 'CTRL+S', element_path: '0', expected_name: 'Editor' }), [
    ['wtype', '-M', 'ctrl', '-P', 's', '-p', 's', '-m', 'ctrl'],
  ]);
  assert.deepEqual(buildWaylandInputCommands({ action: 'press_key', key: 'CTRL+SHIFT+ESC', element_path: '0', expected_name: 'Editor' }), [
    ['wtype', '-M', 'ctrl', '-M', 'shift', '-P', 'Escape', '-p', 'Escape', '-m', 'shift', '-m', 'ctrl'],
  ]);
  assert.deepEqual(buildWaylandInputCommands({ action: 'press_key', key: 'SUPER+R', element_path: '0', expected_name: 'Desktop' }), [
    ['wtype', '-M', 'logo', '-P', 'r', '-p', 'r', '-m', 'logo'],
  ]);
  assert.deepEqual(buildWaylandInputCommands({ action: 'press_key', key: 'WIN', element_path: '0', expected_name: 'Desktop' }), [
    ['wtype', '-P', 'Super_L', '-p', 'Super_L'],
  ]);
  assert.deepEqual(buildWaylandInputCommands({ action: 'press_key', key: 'CTRL+F24', element_path: '0', expected_name: 'Editor' }), [
    ['wtype', '-M', 'ctrl', '-P', 'F24', '-p', 'F24', '-m', 'ctrl'],
  ]);
  assert.deepEqual(buildWaylandInputCommands({ action: 'press_key', key: 'NUMPADENTER', element_path: '0', expected_name: 'Editor' }), [
    ['wtype', '-P', 'KP_Enter', '-p', 'KP_Enter'],
  ]);
});

test('Windows key combinations are encoded as validated SendKeys data', () => {
  const args = { action: 'press_key', element_path: '0', expected_name: 'Window', key: 'CTRL+SHIFT+ESC' };
  const decoded = Buffer.from(buildWindowsCommandArgs(args).at(-1), 'base64').toString('utf16le');
  const payloadB64 = decoded.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)?.[1];
  assert.deepEqual(JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8')), { ...args, _windows_keys: '^+{ESC}' });
  assert.match(decoded, /SendWait\(\[string\]\$payload\._windows_keys\)/);
});

test('Windows system shortcuts use validated virtual keys and always release the Windows key', () => {
  const args = { action: 'press_key', element_path: '0', expected_name: 'Desktop', key: 'WIN+R' };
  const decoded = Buffer.from(buildWindowsCommandArgs(args).at(-1), 'base64').toString('utf16le');
  const payloadB64 = decoded.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)?.[1];
  assert.deepEqual(JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8')), {
    ...args,
    _windows_keys: '#r',
    _windows_input: { key: 0x52, modifiers: [0x5b] },
  });
  assert.match(decoded, /\[XystKeyboard\]::keybd_event/);
  assert.match(decoded, /finally \{/);
});

test('Windows key can be pressed by itself through validated native input', () => {
  const args = { action: 'press_key', element_path: '0', expected_name: 'Desktop', key: 'WIN' };
  const decoded = Buffer.from(buildWindowsCommandArgs(args).at(-1), 'base64').toString('utf16le');
  const payloadB64 = decoded.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)?.[1];
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
  assert.deepEqual(payload._windows_input, { key: 0x5b, modifiers: [] });
  assert.match(decoded, /\[XystKeyboard\]::keybd_event/);
});

test('extended function and numeric keypad keys use native Windows virtual keys', () => {
  for (const [key, virtualKey] of [
    ['F17', 0x80],
    ['F24', 0x87],
    ['NUMPAD0', 0x60],
    ['NUMPAD9', 0x69],
    ['NUMPADENTER', 0x6c],
    ['PRINTSCREEN', 0x2c],
  ]) {
    const args = { action: 'press_key', element_path: '0', expected_name: 'Editor', key };
    const decoded = Buffer.from(buildWindowsCommandArgs(args).at(-1), 'base64').toString('utf16le');
    const payloadB64 = decoded.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)?.[1];
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
    assert.deepEqual(payload._windows_input, { key: virtualKey, modifiers: [] }, key);
  }
});

test('Windows desktop commands encode arguments as data and never interpolate them into PowerShell source', () => {
  const marker = "'; Remove-Item -Recurse C:\\; #";
  const args = { action: 'type_text', element_path: '0.2', expected_name: 'Search', text: marker };
  const commandArgs = buildWindowsCommandArgs(args);
  assert.deepEqual(commandArgs.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA']);
  const decoded = Buffer.from(commandArgs.at(-1), 'base64').toString('utf16le');
  assert.match(decoded, /FromBase64String\('/);
  assert.doesNotMatch(decoded, /Remove-Item/);
  const payloadB64 = decoded.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)?.[1];
  assert.deepEqual(JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8')), args);
});

test('Windows desktop inspection defaults its element limit without mutating the converted JSON object', () => {
  const decoded = Buffer.from(buildWindowsCommandArgs({ action: 'inspect' }).at(-1), 'base64').toString('utf16le');
  assert.match(decoded, /\$maxElements = if \(\$null -eq \$payload\.max_elements\) \{ 150 \}/);
  assert.match(decoded, /\$counter\.Value -lt \$maxElements/);
  assert.doesNotMatch(decoded, /\$payload\.max_elements\s*=/);
});

test('desktop inspection reaches nested WebView controls while keeping the node count bounded', () => {
  const decoded = Buffer.from(buildWindowsCommandArgs({ action: 'inspect', max_elements: 250 }).at(-1), 'base64').toString('utf16le');
  assert.match(decoded, /if \(\$depth -lt 12\)/);
  assert.match(decoded, /ConvertTo-Json -Depth 20 -Compress/);
  assert.match(LINUX_SCRIPT, /if depth < 12:/);
  assert.match(LINUX_SCRIPT, /budget = \[request\.get\("max_elements", 150\)\]/);
  assert.match(LINUX_SCRIPT, /actions\.getName\(i\)/);
  assert.doesNotMatch(LINUX_SCRIPT, /actions\.getActionName/);
});

test('Windows inspection normalizes PowerShell singleton children into arrays', async (t) => {
  const systemRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xyst-powershell-fixture-'));
  t.after(() => fs.rm(systemRoot, { recursive: true, force: true }));
  const executable = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(executable, '');
  const result = await controlDesktop(
    { action: 'inspect', max_elements: 10 },
    {
      platform: 'win32',
      env: { SystemRoot: systemRoot },
      runner: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          platform: 'windows',
          backend: 'Microsoft UI Automation',
          windows: {
            name: 'private-window-title',
            children: [{ name: 'private-control-label', children: null }, null, 'invalid-child-shape'],
          },
        }),
        stderr: '',
        timedOut: false,
        truncated: false,
      }),
    },
  );
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].children.length, 1);
  assert.deepEqual(result.windows[0].children[0].children, []);
});

test('Windows coordinate input uses the fixed native mouse backend with validated data', () => {
  const args = { action: 'click_at', x: 510, y: 440, button: 'right', click_count: 2 };
  const decoded = Buffer.from(buildWindowsCommandArgs(args).at(-1), 'base64').toString('utf16le');
  assert.doesNotMatch(decoded, /AutomationElement\]::FromPoint/);
  assert.match(decoded, /SetCursorPos\(\[int\]\$payload\.x, \[int\]\$payload\.y\)/);
  assert.match(decoded, /'right' \{ @\(0x0008, 0x0010\) \}/);
  assert.match(decoded, /try \{[\s\S]*?finally \{ \[XystMouse\]::mouse_event/);
  assert.match(decoded, /outside the virtual desktop bounds/);
  assert.match(decoded, /outside the virtual desktop bounds/);
  assert.ok(
    decoded.indexOf("if ($payload.action -in @('click_at', 'scroll_at'))") < decoded.indexOf('$element = Get-Element'),
    'coordinate mouse actions must not require an accessibility selector',
  );
  assert.doesNotMatch(decoded, /FromBase64String\('[^']*Remove-Item/);
  const payloadB64 = decoded.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)?.[1];
  assert.deepEqual(JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8')), args);
});

test('Windows coordinate scrolling sends vertical and horizontal wheel events', () => {
  const args = { action: 'scroll_at', x: 120, y: 240, delta_x: -240, delta_y: 360 };
  const decoded = Buffer.from(buildWindowsCommandArgs(args).at(-1), 'base64').toString('utf16le');
  assert.match(decoded, /mouse_event\(\[uint32\]0x0800/);
  assert.match(decoded, /mouse_event\(\[uint32\]0x01000/);
  assert.match(decoded, /\[BitConverter\]::ToUInt32\(\[BitConverter\]::GetBytes\(\[int\]\$payload\.delta_x\), 0\)/);
});

test('Windows drag encodes validated coordinates and always releases its mouse button', () => {
  const args = { action: 'drag_at', x: 10, y: 20, to_x: 30, to_y: 40, button: 'middle' };
  const decoded = Buffer.from(buildWindowsCommandArgs(args).at(-1), 'base64').toString('utf16le');
  const payloadB64 = decoded.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)?.[1];
  assert.deepEqual(JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8')), args);
  assert.match(decoded, /mouse_event\(\[uint32\]\$mouseFlags\[0\]/);
  assert.match(decoded, /finally \{ \[XystMouse\]::mouse_event\(\[uint32\]\$mouseFlags\[1\]/);
  assert.match(decoded, /drag destination is outside the virtual desktop bounds/);
});

test('generated Windows desktop automation scripts parse with Windows PowerShell 5.1', (t) => {
  if (process.platform !== 'win32') return t.skip('Windows PowerShell parser validation runs on Windows CI');
  const encoded = buildWindowsCommandArgs({ action: 'drag_at', x: 10, y: 20, to_x: 30, to_y: 40 }).at(-1);
  const script = Buffer.from(encoded, 'base64').toString('utf16le');
  const parser =
    '$tokens = $null; $errors = $null; [System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }';
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', parser], {
    input: script,
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || 'Windows PowerShell rejected the generated desktop script');
});

test('Windows desktop host screenshots use the native helper instead of PowerShell', async () => {
  let launch;
  const value = await controlDesktop(
    { action: 'screenshot' },
    {
      platform: 'win32',
      env: { XYST_NATIVE_HOST: 'C:\\Program Files\\Xyst AI Assistant\\xyst-desktop.exe', API_TOKEN: 'not-forwarded' },
      timeoutMs: 12_000,
      runner: async (command, args, options) => {
        launch = { command, args, options };
        return {
          exitCode: 0,
          stdout: JSON.stringify({ screenshot: { mime_type: 'image/png', data: 'aGVsbG8=' } }),
          stderr: '',
          timedOut: false,
          truncated: false,
        };
      },
    },
  );
  assert.equal(value.screenshot.mime_type, 'image/png');
  assert.equal(launch.command, 'C:\\Program Files\\Xyst AI Assistant\\xyst-desktop.exe');
  assert.deepEqual(launch.args, ['--capture-screen']);
  assert.equal(launch.options.timeoutMs, 12_000);
  assert.equal('API_TOKEN' in launch.options.env, false);
  assert.ok(launch.options.maxOutputBytes > 8 * 1024 * 1024);
});

test('desktop screenshot response rejects image data above the decoded byte limit', async () => {
  const oversizedBase64 = 'A'.repeat(4 * Math.ceil((8 * 1024 * 1024 + 1) / 3));
  await assert.rejects(
    controlDesktop(
      { action: 'screenshot' },
      {
        platform: 'win32',
        env: { XYST_NATIVE_HOST: 'xyst-desktop.exe' },
        runner: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({ screenshot: { mime_type: 'image/png', data: oversizedBase64 } }),
          stderr: '',
          timedOut: false,
          truncated: false,
        }),
      },
    ),
    { code: 'DESKTOP_IMAGE_LIMIT' },
  );
});

test('Linux adapter carries only display-session variables and returns accessible tree data', async () => {
  let launch;
  const value = await controlDesktop(
    { action: 'inspect', max_elements: 20 },
    {
      platform: 'linux',
      env: {
        DISPLAY: ':0',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/bus',
        YDOTOOL_SOCKET: '/run/user/1000/.ydotool_socket',
        API_TOKEN: 'never-pass',
        PATH: '/usr/bin',
      },
      runner: async (command, argv, options) => {
        launch = { command, argv, options };
        return {
          exitCode: 0,
          stdout: JSON.stringify({ platform: 'linux', backend: 'AT-SPI', windows: [], status_messages: [] }),
          stderr: '',
          timedOut: false,
          truncated: false,
        };
      },
    },
  );
  assert.equal(value.backend, 'AT-SPI');
  assert.ok(Array.isArray(value.status_messages));
  assert.equal(launch.command, 'python3');
  assert.equal(launch.options.env.DISPLAY, ':0');
  assert.equal(launch.options.env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/tmp/bus');
  assert.equal(launch.options.env.YDOTOOL_SOCKET, '/run/user/1000/.ydotool_socket');
  assert.equal('API_TOKEN' in launch.options.env, false);
  assert.match(launch.argv[1], /pyatspi/);
  assert.equal(JSON.parse(launch.options.input).max_elements, 20);
});

test('unrestricted Linux adapter receives the full current-user environment when requested', async () => {
  let childEnvironment;
  await controlDesktop(
    { action: 'inspect' },
    {
      platform: 'linux',
      unrestricted: true,
      env: { DISPLAY: ':0', API_TOKEN: 'preserved-only-in-unrestricted-mode' },
      runner: async (_command, _argv, options) => {
        childEnvironment = options.env;
        return {
          exitCode: 0,
          stdout: JSON.stringify({ platform: 'linux', backend: 'AT-SPI', windows: [] }),
          stderr: '',
          timedOut: false,
          truncated: false,
        };
      },
    },
  );
  assert.equal(childEnvironment.API_TOKEN, 'preserved-only-in-unrestricted-mode');
});

test('Linux Wayland actions receive only locally generated input argv', async () => {
  let request;
  await controlDesktop(
    { action: 'click_at', x: 40, y: 25, button: 'left' },
    {
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: '/run/user/1000' },
      runner: async (_command, _argv, options) => {
        request = JSON.parse(options.input);
        return {
          exitCode: 0,
          stdout: JSON.stringify({ status: 'completed', action: 'click_at', x: 40, y: 25 }),
          stderr: '',
          timedOut: false,
          truncated: false,
        };
      },
    },
  );
  assert.deepEqual(request._wayland_commands, [
    ['ydotool', 'mousemove', '--absolute', '-x', '40', '-y', '25'],
    ['ydotool', 'click', '0xC0'],
  ]);
});

test('Linux Wayland drag actions release the pressed button even when pointer movement fails', async () => {
  let launch;
  await controlDesktop(
    { action: 'drag_at', x: 10, y: 20, to_x: 30, to_y: 40, button: 'left' },
    {
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: '/run/user/1000' },
      runner: async (_command, argv, options) => {
        launch = { argv, request: JSON.parse(options.input) };
        return {
          exitCode: 0,
          stdout: JSON.stringify({ status: 'completed', action: 'drag_at', x: 10, y: 20, to_x: 30, to_y: 40 }),
          stderr: '',
          timedOut: false,
          truncated: false,
        };
      },
    },
  );
  assert.deepEqual(launch.request._wayland_commands, [
    ['ydotool', 'mousemove', '--absolute', '-x', '10', '-y', '20'],
    ['ydotool', 'click', '0x40'],
    ['ydotool', 'mousemove', '--absolute', '-x', '30', '-y', '40'],
    ['ydotool', 'click', '0x80'],
  ]);
  assert.match(launch.argv[1], /def run_drag_with_release\(press, move, release\):/);
  assert.match(launch.argv[1], /except Exception as drag_error:/);
  assert.match(launch.argv[1], /except Exception as release_error:/);
  assert.match(launch.argv[1], /mouse-button release also failed/);
});

test('Linux Wayland and X11 drags preserve movement errors and report failed release attempts', (t) => {
  if (!LINUX_HELPER_PYTHON) return t.skip('Set XYST_PYTHON to also run Linux helper checks on another host');
  const waylandRequest = {
    action: 'drag_at',
    x: 10,
    y: 20,
    to_x: 30,
    to_y: 40,
    _wayland_commands: [
      ['ydotool', 'mousemove', '--absolute', '-x', '10', '-y', '20'],
      ['ydotool', 'click', '0x40'],
      ['ydotool', 'mousemove', '--absolute', '-x', '30', '-y', '40'],
      ['ydotool', 'click', '0x80'],
    ],
  };
  const x11Request = { action: 'drag_at', x: 10, y: 20, to_x: 30, to_y: 40, button: 'left' };
  const cases = [
    {
      request: waylandRequest,
      fail: [
        { command: waylandRequest._wayland_commands[2], status: 7 },
        { command: waylandRequest._wayland_commands[3], status: 9 },
      ],
      calls: waylandRequest._wayland_commands,
    },
    {
      request: x11Request,
      fail: [
        { command: ['xdotool', 'mousemove', '--sync', '30', '40'], status: 7 },
        { command: ['xdotool', 'mouseup', '1'], status: 9 },
      ],
      calls: [
        ['xdotool', 'getdisplaygeometry'],
        ['xdotool', 'mousemove', '--sync', '10', '20'],
        ['xdotool', 'mousedown', '1'],
        ['xdotool', 'mousemove', '--sync', '30', '40'],
        ['xdotool', 'mouseup', '1'],
      ],
    },
  ];
  for (const { request, fail, calls } of cases) {
    const execution = runLinuxHelperWithFailures(request, fail);
    assert.deepEqual(execution.calls, calls);
    const helperError = JSON.parse(execution.helper_output);
    assert.match(helperError.error, /exit status 7/);
    assert.match(helperError.error, /mouse-button release also failed/);
    assert.match(helperError.error, /exit status 9/);
  }
});

test('Linux X11 key combinations are encoded as fixed xdotool keysyms', async () => {
  let request;
  await controlDesktop(
    { action: 'press_key', element_path: '0.2', expected_name: 'Editor', key: 'ALT+TAB' },
    {
      platform: 'linux',
      env: { DISPLAY: ':0' },
      runner: async (_command, _args, options) => {
        request = JSON.parse(options.input);
        return {
          exitCode: 0,
          stdout: JSON.stringify({ status: 'completed', action: 'press_key', target: 'Editor' }),
          stderr: '',
          timedOut: false,
          truncated: false,
        };
      },
    },
  );
  assert.equal(request._xdotool_key, 'alt+Tab');
});

test('Linux coordinate mouse actions use fixed xdotool argv and return bounded status data', async () => {
  let launch;
  const result = await controlDesktop(
    { action: 'scroll_at', x: 450, y: 300, delta_y: 360 },
    {
      platform: 'linux',
      env: { DISPLAY: ':1' },
      runner: async (command, argv, options) => {
        launch = { command, argv, options };
        return {
          exitCode: 0,
          stdout: JSON.stringify({ status: 'completed', action: 'scroll_at', x: 450, y: 300 }),
          stderr: '',
          timedOut: false,
          truncated: false,
        };
      },
    },
  );
  assert.deepEqual(result, { status: 'completed', action: 'scroll_at', x: 450, y: 300 });
  assert.equal(launch.command, 'python3');
  assert.match(launch.argv[1], /xdotool/);
  assert.match(launch.argv[1], /getdisplaygeometry/);
  assert.match(launch.argv[1], /run_drag_with_release\(/);
  assert.match(launch.argv[1], /\["xdotool", "mouseup", button\]/);
  assert.ok(
    launch.argv[1].indexOf('request["action"] in ("click_at", "scroll_at")') < launch.argv[1].indexOf('node = get_target'),
    'coordinate mouse actions must not require an accessibility selector',
  );
  assert.deepEqual(JSON.parse(launch.options.input), { action: 'scroll_at', x: 450, y: 300, delta_y: 360 });
});

test('desktop adapter reports unavailable sessions and structured backend failures', async () => {
  await assert.rejects(controlDesktop({ action: 'inspect' }, { platform: 'darwin' }), { code: 'DESKTOP_UNSUPPORTED' });
  await assert.rejects(
    controlDesktop(
      { action: 'inspect' },
      {
        platform: 'linux',
        env: {},
        runner: async () => {
          throw new Error('must not launch without a display');
        },
      },
    ),
    { code: 'DESKTOP_SESSION_UNAVAILABLE' },
  );
  await assert.rejects(
    controlDesktop(
      { action: 'inspect' },
      {
        platform: 'linux',
        env: { DISPLAY: ':0' },
        runner: async () => ({
          exitCode: 4,
          stdout: JSON.stringify({ error: 'pyatspi missing' }),
          stderr: '',
          timedOut: false,
          truncated: false,
        }),
      },
    ),
    { code: 'DESKTOP_ACTION_FAILED', message: /pyatspi missing/ },
  );
  await assert.rejects(
    controlDesktop(
      { action: 'inspect' },
      {
        platform: 'linux',
        env: { DISPLAY: ':0' },
        runner: async () => ({ exitCode: 0, stdout: 'not-json', stderr: '', timedOut: false, truncated: false }),
      },
    ),
    { code: 'DESKTOP_INVALID_RESPONSE' },
  );
});

function runLinuxHelperWithFailures(request, failures) {
  const source = Buffer.from(LINUX_SCRIPT, 'utf8').toString('base64');
  const harness = `
import base64, contextlib, io, json, os, subprocess, sys, types
request = ${JSON.stringify(request)}
failures = ${JSON.stringify(failures)}
calls = []
def fake_run(command, **kwargs):
    calls.append(command)
    if command == ['xdotool', 'getdisplaygeometry']: return types.SimpleNamespace(stdout='1920 1080', stderr='')
    for failure in failures:
        if command == failure['command']: raise subprocess.CalledProcessError(failure['status'], command)
    return types.SimpleNamespace(stdout='', stderr='')
subprocess.run = fake_run
sys.modules['pyatspi'] = types.SimpleNamespace(Registry=types.SimpleNamespace(getDesktop=lambda index: object()))
os.environ.pop('WAYLAND_DISPLAY', None)
sys.stdin = io.StringIO(json.dumps(request))
captured = io.StringIO()
with contextlib.redirect_stdout(captured):
    try: exec(compile(base64.b64decode('${source}'), '<xyst-linux-helper>', 'exec'), {})
    except SystemExit: pass
print(json.dumps({'calls': calls, 'helper_output': captured.getvalue()}))
`;
  const result = spawnSync(LINUX_HELPER_PYTHON, ['-c', harness], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || 'The mocked Linux helper did not complete');
  return JSON.parse(result.stdout);
}
