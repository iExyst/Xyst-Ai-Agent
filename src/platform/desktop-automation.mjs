import fs from 'node:fs/promises';
import path from 'node:path';
import { runProcess, safeProcessEnvironment } from './process.mjs';

const MAX_OUTPUT = 96_000;
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const MAX_SCREENSHOT_OUTPUT = 12 * 1024 * 1024;
const KEY_NAMES = Object.freeze({
  ENTER: ['{ENTER}', 'Return'],
  ESC: ['{ESC}', 'Escape'],
  TAB: ['{TAB}', 'Tab'],
  SPACE: [' ', 'space'],
  BACKSPACE: ['{BACKSPACE}', 'BackSpace'],
  DELETE: ['{DELETE}', 'Delete'],
  INSERT: ['{INSERT}', 'Insert'],
  UP: ['{UP}', 'Up'],
  DOWN: ['{DOWN}', 'Down'],
  LEFT: ['{LEFT}', 'Left'],
  RIGHT: ['{RIGHT}', 'Right'],
  HOME: ['{HOME}', 'Home'],
  END: ['{END}', 'End'],
  PAGEUP: ['{PGUP}', 'Page_Up'],
  PAGEDOWN: ['{PGDN}', 'Page_Down'],
  CAPSLOCK: ['{CAPSLOCK}', 'Caps_Lock'],
  BREAK: ['{BREAK}', 'Break'],
  NUMLOCK: ['{NUMLOCK}', 'Num_Lock'],
  SCROLLLOCK: ['{SCROLLLOCK}', 'Scroll_Lock'],
  PRINTSCREEN: ['{PRTSC}', 'Print'],
  PAUSE: ['{BREAK}', 'Pause'],
  MENU: ['{APPS}', 'Menu'],
  NUMPAD0: ['', 'KP_0'],
  NUMPAD1: ['', 'KP_1'],
  NUMPAD2: ['', 'KP_2'],
  NUMPAD3: ['', 'KP_3'],
  NUMPAD4: ['', 'KP_4'],
  NUMPAD5: ['', 'KP_5'],
  NUMPAD6: ['', 'KP_6'],
  NUMPAD7: ['', 'KP_7'],
  NUMPAD8: ['', 'KP_8'],
  NUMPAD9: ['', 'KP_9'],
  NUMPADADD: ['', 'KP_Add'],
  NUMPADSUBTRACT: ['', 'KP_Subtract'],
  NUMPADMULTIPLY: ['', 'KP_Multiply'],
  NUMPADDIVIDE: ['', 'KP_Divide'],
  NUMPADDECIMAL: ['', 'KP_Decimal'],
  NUMPADENTER: ['', 'KP_Enter'],
  WIN: ['{WIN}', 'Super_L'],
});
const WINDOWS_VIRTUAL_KEYS = Object.freeze({
  ENTER: 0x0d,
  ESC: 0x1b,
  TAB: 0x09,
  SPACE: 0x20,
  BACKSPACE: 0x08,
  DELETE: 0x2e,
  INSERT: 0x2d,
  UP: 0x26,
  DOWN: 0x28,
  LEFT: 0x25,
  RIGHT: 0x27,
  HOME: 0x24,
  END: 0x23,
  PAGEUP: 0x21,
  PAGEDOWN: 0x22,
  CAPSLOCK: 0x14,
  BREAK: 0x03,
  NUMLOCK: 0x90,
  SCROLLLOCK: 0x91,
  PRINTSCREEN: 0x2c,
  PAUSE: 0x13,
  MENU: 0x5d,
  NUMPADADD: 0x6b,
  NUMPADSUBTRACT: 0x6d,
  NUMPADMULTIPLY: 0x6a,
  NUMPADDIVIDE: 0x6f,
  NUMPADDECIMAL: 0x6e,
  NUMPADENTER: 0x6c,
  WIN: 0x5b,
});

/** Inspect and operate accessible desktop controls in the current interactive user session. */
export async function controlDesktop(
  args,
  { signal, platform = process.platform, env = process.env, runner = runProcess, unrestricted = false, timeoutMs = 20_000 } = {},
) {
  validateRequest(args);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000) throw new TypeError('timeoutMs must be between 1 and 20000');
  if (platform === 'win32') return runWindows(args, { signal, env, runner, unrestricted, timeoutMs });
  if (platform === 'linux') return runLinux(args, { signal, env, runner, unrestricted, timeoutMs });
  throw Object.assign(new Error(`Desktop automation is not implemented for ${platform}`), { code: 'DESKTOP_UNSUPPORTED' });
}

export function validateRequest(args) {
  if (!args || !['inspect', 'screenshot', 'click', 'click_at', 'drag_at', 'scroll_at', 'type_text', 'press_key'].includes(args.action))
    throw new TypeError('action must be inspect, screenshot, click, click_at, drag_at, scroll_at, type_text, or press_key');
  if (args.action === 'inspect') {
    if (args.max_elements !== undefined && (!Number.isInteger(args.max_elements) || args.max_elements < 1 || args.max_elements > 250))
      throw new TypeError('max_elements must be between 1 and 250');
    return;
  }
  if (args.action === 'screenshot') return;
  if (args.action === 'click_at' || args.action === 'drag_at' || args.action === 'scroll_at') {
    const coordinateFields = args.action === 'drag_at' ? ['x', 'y', 'to_x', 'to_y'] : ['x', 'y'];
    for (const field of coordinateFields)
      if (!Number.isInteger(args[field]) || Math.abs(args[field]) > 100_000)
        throw new TypeError(`${field} must be an integer between -100000 and 100000`);
    if (args.action === 'click_at') {
      if (args.button !== undefined && !['left', 'middle', 'right'].includes(args.button))
        throw new TypeError('button must be left, middle, or right');
      if (args.click_count !== undefined && (!Number.isInteger(args.click_count) || args.click_count < 1 || args.click_count > 3))
        throw new TypeError('click_count must be between 1 and 3');
    } else if (args.action === 'drag_at') {
      if (args.button !== undefined && !['left', 'middle', 'right'].includes(args.button))
        throw new TypeError('button must be left, middle, or right');
    } else {
      for (const field of ['delta_x', 'delta_y'])
        if (args[field] !== undefined && (!Number.isInteger(args[field]) || Math.abs(args[field]) > 10_000))
          throw new TypeError(`${field} must be an integer between -10000 and 10000`);
      if ((args.delta_x ?? 0) === 0 && (args.delta_y ?? 0) === 0) throw new TypeError('scroll_at requires a non-zero delta_x or delta_y');
    }
    return;
  }
  if (typeof args.element_path !== 'string' || !/^(?:\d{1,4})(?:\.\d{1,4}){0,12}$/.test(args.element_path))
    throw new TypeError('element_path must come from the latest desktop inspection');
  if (typeof args.expected_name !== 'string' || !args.expected_name.trim() || args.expected_name.length > 256)
    throw new TypeError('expected_name is required to verify the target control');
  if (args.action === 'type_text' && (typeof args.text !== 'string' || Buffer.byteLength(args.text) > 4096))
    throw new TypeError('text must be a string of at most 4096 UTF-8 bytes');
  if (args.action === 'press_key') parseDesktopKey(args.key);
}

function parseDesktopKey(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64)
    throw new TypeError('key must be a supported key or key combination of at most 64 characters');
  const parts = value.toUpperCase().split('+');
  const rawKey = parts.pop();
  const key = rawKey === 'SUPER' ? 'WIN' : rawKey;
  const modifierAliases = { SUPER: 'WIN' };
  const modifiers = parts.map((modifier) => modifierAliases[modifier] || modifier);
  if (
    modifiers.some((modifier) => !['CTRL', 'ALT', 'SHIFT', 'WIN'].includes(modifier)) ||
    new Set(modifiers).size !== modifiers.length ||
    (key === 'WIN' && modifiers.includes('WIN')) ||
    !key ||
    (!Object.hasOwn(KEY_NAMES, key) && !/^[A-Z0-9]$/.test(key) && !/^F(?:[1-9]|1\d|2[0-4])$/.test(key))
  )
    throw new TypeError('key must be WIN/SUPER or a supported key, optionally combined with CTRL, ALT, SHIFT, or WIN/SUPER');

  const [windowsName, xdotoolName] = KEY_NAMES[key] || [null, null];
  const windowsKey = windowsName || (/^F\d+$/.test(key) ? `{${key}}` : key.toLowerCase());
  const xdotoolKey = xdotoolName || (/^F\d+$/.test(key) ? key : key.toLowerCase());
  const wtypeKey = xdotoolName || (/^F\d+$/.test(key) ? key : key.toLowerCase());
  const windowsModifier = { CTRL: '^', ALT: '%', SHIFT: '+', WIN: '#' };
  const xModifiers = { CTRL: 'ctrl', ALT: 'alt', SHIFT: 'shift', WIN: 'super' };
  const wtypeModifiers = { CTRL: 'ctrl', ALT: 'alt', SHIFT: 'shift', WIN: 'logo' };
  const virtualKey =
    WINDOWS_VIRTUAL_KEYS[key] ??
    (/^F\d+$/.test(key)
      ? 0x70 + Number(key.slice(1)) - 1
      : /^NUMPAD\d$/.test(key)
        ? 0x60 + Number(key.slice(-1))
        : /^[A-Z0-9]$/.test(key)
          ? key.charCodeAt(0)
          : null);
  return {
    key,
    modifiers: modifiers.map((modifier) => xModifiers[modifier]),
    windows: `${modifiers.map((modifier) => windowsModifier[modifier]).join('')}${windowsKey}`,
    xdotool: [...modifiers.map((modifier) => xModifiers[modifier]), xdotoolKey].join('+'),
    wtypeKey,
    wtypeModifiers: modifiers.map((modifier) => wtypeModifiers[modifier]),
    virtualKey,
    requiresNative: /^F(?:1[7-9]|2\d)$/.test(key) || key === 'PRINTSCREEN' || key === 'PAUSE' || key === 'MENU' || key.startsWith('NUMPAD'),
    windowsModifiers: modifiers.map((modifier) => ({ CTRL: 0x11, ALT: 0x12, SHIFT: 0x10, WIN: 0x5b })[modifier]),
  };
}

export function buildWindowsCommandArgs(args) {
  validateRequest(args);
  const parsedKey = args.action === 'press_key' ? parseDesktopKey(args.key) : null;
  const payload =
    args.action === 'press_key'
      ? {
          ...args,
          _windows_keys: parsedKey.windows,
          ...(parsedKey.modifiers.includes('super') || parsedKey.key === 'WIN' || parsedKey.requiresNative
            ? { _windows_input: { key: parsedKey.virtualKey, modifiers: parsedKey.windowsModifiers } }
            : {}),
        }
      : args;
  const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const body =
    args.action === 'screenshot'
      ? WINDOWS_SCREENSHOT_BODY
      : WINDOWS_SCRIPT_BODY.replace(/# SCREENSHOT_BEGIN[\s\S]*?# SCREENSHOT_END\r?\n/, '');
  const command = `${WINDOWS_SCRIPT_PREFIX}${data}${body}`;
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')];
}

/** Build fixed-argv input commands for Linux Wayland without interpolating model text into a shell. */
export function buildWaylandInputCommands(args) {
  validateRequest(args);
  if (args.action === 'drag_at') {
    const button = { left: 0, right: 1, middle: 2 }[args.button || 'left'];
    return [
      ['ydotool', 'mousemove', '--absolute', '-x', String(args.x), '-y', String(args.y)],
      ['ydotool', 'click', `0x${(0x40 + button).toString(16)}`],
      ['ydotool', 'mousemove', '--absolute', '-x', String(args.to_x), '-y', String(args.to_y)],
      ['ydotool', 'click', `0x${(0x80 + button).toString(16)}`],
    ];
  }
  if (args.action === 'click_at') {
    const buttons = { left: '0xC0', right: '0xC1', middle: '0xC2' };
    const count = args.click_count || 1;
    return [
      ['ydotool', 'mousemove', '--absolute', '-x', String(args.x), '-y', String(args.y)],
      ['ydotool', 'click', ...(count > 1 ? ['--repeat', String(count)] : []), buttons[args.button || 'left']],
    ];
  }
  if (args.action === 'scroll_at') {
    const stepsX = args.delta_x ? Math.min(100, Math.max(1, Math.floor(Math.abs(args.delta_x) / 120))) : 0;
    const stepsY = args.delta_y ? Math.min(100, Math.max(1, Math.floor(Math.abs(args.delta_y) / 120))) : 0;
    return [
      ['ydotool', 'mousemove', '--absolute', '-x', String(args.x), '-y', String(args.y)],
      [
        'ydotool',
        'mousemove',
        '--wheel',
        '-x',
        String(Math.sign(args.delta_x || 0) * stepsX),
        '-y',
        String(Math.sign(args.delta_y || 0) * stepsY),
      ],
    ];
  }
  if (args.action === 'press_key') {
    const { wtypeModifiers, wtypeKey } = parseDesktopKey(args.key);
    const command = ['wtype'];
    for (const modifier of wtypeModifiers) command.push('-M', modifier);
    command.push('-P', wtypeKey, '-p', wtypeKey);
    for (const modifier of wtypeModifiers.toReversed()) command.push('-m', modifier);
    return [command];
  }
  return [];
}

async function runWindows(args, { signal, env, runner, unrestricted, timeoutMs }) {
  if (args.action === 'screenshot' && typeof env.XYST_NATIVE_HOST === 'string' && env.XYST_NATIVE_HOST) {
    const result = await runner(env.XYST_NATIVE_HOST, ['--capture-screen'], {
      signal,
      env: unrestricted ? env : safeProcessEnvironment(env),
      timeoutMs,
      maxOutputBytes: MAX_SCREENSHOT_OUTPUT,
    });
    return parseBackendResult(result, 'Native Windows screen capture', true);
  }
  const root = env.SystemRoot || env.WINDIR || 'C:\\Windows';
  const executable = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await fs.access(executable).catch(() => {
    throw Object.assign(new Error('Windows PowerShell 5.1 is required for Windows UI Automation'), { code: 'DESKTOP_BACKEND_UNAVAILABLE' });
  });
  const result = await runner(executable, buildWindowsCommandArgs(args), {
    signal,
    env: unrestricted ? env : safeProcessEnvironment(env),
    timeoutMs,
    maxOutputBytes: args.action === 'screenshot' ? MAX_SCREENSHOT_OUTPUT : MAX_OUTPUT,
  });
  return parseBackendResult(result, 'Windows UI Automation', args.action === 'screenshot');
}

async function runLinux(args, { signal, env, runner, unrestricted, timeoutMs }) {
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY)
    throw Object.assign(new Error('No interactive Linux display session is available to this process'), {
      code: 'DESKTOP_SESSION_UNAVAILABLE',
    });
  const childEnv = { ...(unrestricted ? env : safeProcessEnvironment(env)) };
  for (const name of ['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY', 'YDOTOOL_SOCKET']) {
    if (typeof env[name] === 'string') childEnv[name] = env[name];
  }
  const result = await runner('python3', ['-c', LINUX_SCRIPT], {
    signal,
    env: childEnv,
    input: JSON.stringify({
      ...args,
      ...(env.WAYLAND_DISPLAY && ['click_at', 'drag_at', 'scroll_at', 'press_key'].includes(args.action)
        ? { _wayland_commands: buildWaylandInputCommands(args) }
        : {}),
      ...(args.action === 'press_key' ? { _xdotool_key: parseDesktopKey(args.key).xdotool } : {}),
    }),
    timeoutMs,
    maxOutputBytes: args.action === 'screenshot' ? MAX_SCREENSHOT_OUTPUT : MAX_OUTPUT,
  });
  return parseBackendResult(result, 'Linux AT-SPI', args.action === 'screenshot');
}

function parseBackendResult(result, backend, screenshot = false) {
  if (result.timedOut) throw Object.assign(new Error(`${backend} operation timed out`), { code: 'DESKTOP_TIMEOUT' });
  if (result.truncated) throw Object.assign(new Error(`${backend} returned more than the output limit`), { code: 'DESKTOP_OUTPUT_LIMIT' });
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    payload = null;
  }
  if (result.exitCode !== 0) {
    const detail = (payload?.error || result.stderr.trim()).slice(0, 1200);
    throw Object.assign(new Error(detail || `${backend} exited with status ${result.exitCode}`), { code: 'DESKTOP_ACTION_FAILED' });
  }
  if (!payload) throw Object.assign(new Error(`${backend} returned malformed JSON`), { code: 'DESKTOP_INVALID_RESPONSE' });
  if (payload.error) throw Object.assign(new Error(String(payload.error).slice(0, 1200)), { code: 'DESKTOP_ACTION_FAILED' });
  if (payload.platform === 'windows' || payload.platform === 'linux') normalizeInspectionTree(payload);
  if (screenshot) {
    const imageData = payload.screenshot?.data;
    if (typeof imageData !== 'string' || imageData.length === 0 || imageData.length > Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4)
      throw Object.assign(new Error(`${backend} returned a screenshot that exceeds the image limit or is malformed`), {
        code: 'DESKTOP_IMAGE_LIMIT',
      });
    const imageBytes = Buffer.from(imageData, 'base64');
    if (imageBytes.byteLength > MAX_SCREENSHOT_BYTES || imageBytes.toString('base64') !== imageData)
      throw Object.assign(new Error(`${backend} returned a screenshot that exceeds the image limit or is malformed`), {
        code: 'DESKTOP_IMAGE_LIMIT',
      });
  }
  return payload;
}

function normalizeInspectionTree(payload) {
  const asArray = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);
  const normalizeNodes = (value) =>
    asArray(value)
      .filter((node) => node && typeof node === 'object' && !Array.isArray(node))
      .map((node) => ({ ...node, children: normalizeNodes(node.children) }));
  if (asArray(payload.windows).some((node) => !node || typeof node !== 'object' || Array.isArray(node)))
    throw Object.assign(new Error('Desktop backend returned an invalid inspection tree'), { code: 'DESKTOP_INVALID_RESPONSE' });
  payload.windows = normalizeNodes(payload.windows);
}

const WINDOWS_SCRIPT_PREFIX = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('`;
const WINDOWS_SCREENSHOT_BODY = `')) | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ($bounds.Width -lt 1 -or $bounds.Height -lt 1 -or ($bounds.Width * [long]$bounds.Height) -gt 24000000) { throw 'The virtual desktop image dimensions exceed the supported screenshot limit.' }
$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$stream = New-Object System.IO.MemoryStream
try {
  $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size)
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
  $encoderParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]75)
  $bitmap.Save($stream, $codec, $encoderParams)
  if ($stream.Length -gt 8388608) { throw 'The compressed screenshot exceeds the supported image size.' }
  @{ screenshot = @{ mime_type = 'image/jpeg'; data = [Convert]::ToBase64String($stream.ToArray()) } } | ConvertTo-Json -Depth 4 -Compress
} finally { $stream.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
`;
const WINDOWS_SCRIPT_BODY = `')) | ConvertFrom-Json
$maxElements = if ($null -eq $payload.max_elements) { 150 } else { [int]$payload.max_elements }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
$root = [System.Windows.Automation.AutomationElement]::RootElement
$trueCondition = [System.Windows.Automation.Condition]::TrueCondition
function Children($element) { return ,$element.FindAll([System.Windows.Automation.TreeScope]::Children, $trueCondition) }
function Coordinate($value) {
  $number = [double]$value
  if ([double]::IsNaN($number) -or [double]::IsInfinity($number)) { return 0 }
  return [int][Math]::Max(-1000000, [Math]::Min(1000000, [Math]::Truncate($number)))
}
function Get-Element($indices) {
  $element = $root
  foreach ($index in $indices) { $children = Children $element; if ($index -ge $children.Count) { throw 'The inspected desktop control is no longer present; inspect again.' }; $element = $children.Item($index) }
  return $element
}
function Get-Node($element, $address, $depth, $counter, $limit) {
  if ($counter.Value -ge $limit) { return $null }
  $counter.Value++
  $current = $element.Current
  $rect = $current.BoundingRectangle
  $item = [ordered]@{ path = $address; name = $current.Name; role = $current.ControlType.ProgrammaticName.Replace('ControlType.', ''); automation_id = $current.AutomationId; enabled = $current.IsEnabled; offscreen = $current.IsOffscreen; bounds = @{ x = (Coordinate $rect.X); y = (Coordinate $rect.Y); width = (Coordinate $rect.Width); height = (Coordinate $rect.Height) }; children = @() }
  if ($depth -lt 12) {
    $children = Children $element
    for ($i = 0; $i -lt $children.Count -and $counter.Value -lt $limit; $i++) {
      $child = Get-Node $children.Item($i) "$address.$i" ($depth + 1) $counter $limit
      if ($null -ne $child) { $item.children += $child }
    }
  }
  return ,$item
}
$windows = Children $root
if ($payload.action -eq 'inspect') {
  $counter = @{ Value = 0 }; $items = @()
  for ($i = 0; $i -lt $windows.Count -and $counter.Value -lt $maxElements; $i++) {
    $items += Get-Node $windows.Item($i) "$i" 0 $counter $maxElements
  }
  @{ platform = 'windows'; backend = 'Microsoft UI Automation'; windows = $items; truncated = ($counter.Value -ge $maxElements) } | ConvertTo-Json -Depth 20 -Compress
  exit 0
}
# SCREENSHOT_BEGIN
if ($payload.action -eq 'screenshot') {
  Add-Type -AssemblyName System.Drawing
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  if ($bounds.Width -lt 1 -or $bounds.Height -lt 1 -or ($bounds.Width * [long]$bounds.Height) -gt 24000000) { throw 'The virtual desktop image dimensions exceed the supported screenshot limit.' }
  $bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $stream = New-Object System.IO.MemoryStream
  try {
    $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size)
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
    $encoderParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]75)
    $bitmap.Save($stream, $codec, $encoderParams)
    if ($stream.Length -gt 8388608) { throw 'The compressed screenshot exceeds the supported image size.' }
    @{ screenshot = @{ mime_type = 'image/jpeg'; data = [Convert]::ToBase64String($stream.ToArray()) } } | ConvertTo-Json -Depth 4 -Compress
  } finally { $stream.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
  exit 0
}
# SCREENSHOT_END
if ($payload.action -in @('click_at', 'drag_at', 'scroll_at')) {
  $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
  if ($payload.x -lt $screen.Left -or $payload.y -lt $screen.Top -or $payload.x -ge ($screen.Left + $screen.Width) -or $payload.y -ge ($screen.Top + $screen.Height)) { throw 'The requested screen coordinate is outside the virtual desktop bounds.' }
  Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class XystMouse { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, System.UIntPtr extraInfo); }'
  if ($payload.action -eq 'click_at') {
    $mouseFlags = switch ($payload.button) { 'right' { @(0x0008, 0x0010) } 'middle' { @(0x0020, 0x0040) } default { @(0x0002, 0x0004) } }
    if (-not [XystMouse]::SetCursorPos([int]$payload.x, [int]$payload.y)) { throw 'Could not move the pointer to the requested screen coordinate.' }
    for ($click = 0; $click -lt [Math]::Max(1, [int]$payload.click_count); $click++) {
      try {
        [XystMouse]::mouse_event([uint32]$mouseFlags[0], 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 35
      }
      finally { [XystMouse]::mouse_event([uint32]$mouseFlags[1], 0, 0, 0, [UIntPtr]::Zero) }
      if ($click + 1 -lt [Math]::Max(1, [int]$payload.click_count)) { Start-Sleep -Milliseconds 45 }
    }
  } elseif ($payload.action -eq 'drag_at') {
    $endX = [int]$payload.to_x; $endY = [int]$payload.to_y
    if ($endX -lt $screen.Left -or $endY -lt $screen.Top -or $endX -ge ($screen.Left + $screen.Width) -or $endY -ge ($screen.Top + $screen.Height)) { throw 'The drag destination is outside the virtual desktop bounds.' }
    $mouseFlags = switch ($payload.button) { 'right' { @(0x0008, 0x0010) } 'middle' { @(0x0020, 0x0040) } default { @(0x0002, 0x0004) } }
    if (-not [XystMouse]::SetCursorPos([int]$payload.x, [int]$payload.y)) { throw 'Could not move the pointer to the drag start.' }
    [XystMouse]::mouse_event([uint32]$mouseFlags[0], 0, 0, 0, [UIntPtr]::Zero)
    try {
      $steps = 12
      for ($i = 1; $i -le $steps; $i++) {
        $nextX = [int][Math]::Round($payload.x + (($endX - $payload.x) * $i / $steps))
        $nextY = [int][Math]::Round($payload.y + (($endY - $payload.y) * $i / $steps))
        if (-not [XystMouse]::SetCursorPos($nextX, $nextY)) { throw 'Could not move the pointer during the drag.' }
        Start-Sleep -Milliseconds 15
      }
    } finally { [XystMouse]::mouse_event([uint32]$mouseFlags[1], 0, 0, 0, [UIntPtr]::Zero) }
  } else {
    if (-not [XystMouse]::SetCursorPos([int]$payload.x, [int]$payload.y)) { throw 'Could not move the pointer to the requested screen coordinate.' }
    if ($payload.delta_y) {
      $vertical = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$payload.delta_y), 0)
      [XystMouse]::mouse_event([uint32]0x0800, 0, 0, $vertical, [UIntPtr]::Zero)
    }
    if ($payload.delta_x) {
      $horizontal = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$payload.delta_x), 0)
      [XystMouse]::mouse_event([uint32]0x01000, 0, 0, $horizontal, [UIntPtr]::Zero)
    }
  }
  @{ status = 'completed'; action = $payload.action; x = $payload.x; y = $payload.y } | ConvertTo-Json -Compress
  exit 0
}
$element = $null
$element = Get-Element @($payload.element_path.Split('.') | ForEach-Object { [int]$_ })
if ($element.Current.Name -cne $payload.expected_name) { throw 'The selected control name changed; inspect the desktop again before acting.' }
switch ($payload.action) {
  'click' {
    $pattern = $null
    foreach ($patternType in @([System.Windows.Automation.InvokePattern]::Pattern, [System.Windows.Automation.SelectionItemPattern]::Pattern, [System.Windows.Automation.TogglePattern]::Pattern)) {
      $pattern = $null
      if ($element.TryGetCurrentPattern($patternType, [ref]$pattern)) { break }
    }
    if ($null -eq $pattern) { throw 'The selected control does not expose an Invoke, SelectionItem, or Toggle action.' }
    if ($pattern -is [System.Windows.Automation.InvokePattern]) { $pattern.Invoke() }
    elseif ($pattern -is [System.Windows.Automation.SelectionItemPattern]) { $pattern.Select() }
    else { $pattern.Toggle() }
  }
  'type_text' {
    $pattern = $null
    if (-not $element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { throw 'The selected control does not accept text through the accessibility interface.' }
    if ($pattern.Current.IsReadOnly) { throw 'The selected control is read-only.' }
    $pattern.SetValue([string]$payload.text)
  }
  'press_key' {
    $element.SetFocus()
    if ($payload._windows_input) {
      Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class XystKeyboard { [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra); }'
      $pressed = @()
      try {
        foreach ($modifier in $payload._windows_input.modifiers) {
          [XystKeyboard]::keybd_event([byte]$modifier, 0, 0, [UIntPtr]::Zero)
          $pressed += [int]$modifier
        }
        [XystKeyboard]::keybd_event([byte]$payload._windows_input.key, 0, 0, [UIntPtr]::Zero)
        [XystKeyboard]::keybd_event([byte]$payload._windows_input.key, 0, 2, [UIntPtr]::Zero)
      } finally {
        for ($index = $pressed.Count - 1; $index -ge 0; $index--) {
          [XystKeyboard]::keybd_event([byte]$pressed[$index], 0, 2, [UIntPtr]::Zero)
        }
      }
    } else {
      [System.Windows.Forms.SendKeys]::SendWait([string]$payload._windows_keys)
    }
  }
}
@{ status = 'completed'; action = $payload.action; target = $payload.expected_name } | ConvertTo-Json -Compress
`;

export const LINUX_SCRIPT = `
import json, os, shutil, subprocess, sys
try:
    import pyatspi
except Exception as exc:
    print(json.dumps({"error": "Linux desktop inspection requires the system AT-SPI Python bindings (pyatspi): " + str(exc)}))
    sys.exit(4)
request = json.load(sys.stdin)
desktop = pyatspi.Registry.getDesktop(0)
status_messages = []
def child(node, index): return node.getChildAtIndex(index)
def node_data(node, address, depth, budget):
    if budget[0] <= 0: return None
    budget[0] -= 1
    try: name = node.name or ""
    except Exception: name = ""
    try: role = node.getRoleName()
    except Exception: role = "unknown"
    if role.casefold() in ("alert", "status bar", "statusbar"):
        try:
            message = node.queryText().getText(0, -1)
            if isinstance(message, str) and message.strip(): status_messages.append(" ".join(message.split())[:500])
        except Exception: pass
    try: states = [pyatspi.stateToString(s) for s in node.getState().getStates()]
    except Exception: states = []
    bounds = None
    try:
        rect = node.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
        bounds = {"x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height}
    except Exception: pass
    result = {"path": address, "name": name, "role": role, "states": states, "bounds": bounds, "children": []}
    if depth < 12:
        try: count = node.getChildCount()
        except Exception: count = 0
        for i in range(count):
            if budget[0] <= 0: break
            try: item = node_data(child(node, i), address + "." + str(i), depth + 1, budget)
            except Exception: continue
            if item is not None: result["children"].append(item)
    return result
def get_target(address):
    node = desktop
    for part in address.split("."): node = child(node, int(part))
    return node
def run_drag_with_release(press, move, release):
    try:
        press()
        move()
    except Exception as drag_error:
        try: release()
        except Exception as release_error:
            raise RuntimeError("{}; mouse-button release also failed: {}".format(drag_error, release_error)) from drag_error
        raise
    else:
        release()
try:
    if request["action"] == "inspect":
        budget = [request.get("max_elements", 150)]
        windows = []
        for i in range(desktop.childCount):
            if budget[0] <= 0: break
            try: item = node_data(child(desktop, i), str(i), 0, budget)
            except Exception: continue
            if item is not None: windows.append(item)
        print(json.dumps({"platform": "linux", "backend": "AT-SPI", "windows": windows, "status_messages": status_messages[-20:], "truncated": budget[0] <= 0}))
    elif request["action"] == "screenshot":
        import base64, shutil, subprocess
        if os.environ.get("WAYLAND_DISPLAY") and shutil.which("grim"):
            capture = subprocess.run(["grim", "-"], check=True, capture_output=True, timeout=10).stdout
            mime_type = "image/png"
        elif os.environ.get("DISPLAY") and shutil.which("import"):
            capture = subprocess.run(["import", "-window", "root", "jpeg:-"], check=True, capture_output=True, timeout=10).stdout
            mime_type = "image/jpeg"
        else:
            raise RuntimeError("Screenshot capture needs grim on Wayland or ImageMagick import on X11.")
        if not capture or len(capture) > 8 * 1024 * 1024:
            raise RuntimeError("The screenshot is empty or exceeds the supported image size.")
        print(json.dumps({"screenshot":{"mime_type":mime_type,"data":base64.b64encode(capture).decode("ascii")}}))
    elif request["action"] in ("click_at", "drag_at", "scroll_at"):
        import subprocess
        if request.get("_wayland_commands"):
            commands = request["_wayland_commands"]
            if request["action"] == "drag_at":
                subprocess.run(commands[0], check=True, capture_output=True, text=True, timeout=5)
                run_drag_with_release(
                    lambda: subprocess.run(commands[1], check=True, capture_output=True, text=True, timeout=5),
                    lambda: subprocess.run(commands[2], check=True, capture_output=True, text=True, timeout=10),
                    lambda: subprocess.run(commands[3], check=True, capture_output=True, text=True, timeout=5),
                )
            else:
                for command in commands: subprocess.run(command, check=True, capture_output=True, text=True, timeout=5)
            result = {"status":"completed", "action":request["action"], "x":request["x"], "y":request["y"]}
            if request["action"] == "drag_at": result.update({"to_x":request["to_x"], "to_y":request["to_y"]})
            print(json.dumps(result))
            sys.exit(0)
        geometry = subprocess.run(["xdotool", "getdisplaygeometry"], check=True, capture_output=True, text=True, timeout=5).stdout.split()
        valid_coordinates = len(geometry) == 2 and (0 <= request["x"] < int(geometry[0]) and 0 <= request["y"] < int(geometry[1]))
        if request["action"] == "drag_at":
            valid_coordinates = valid_coordinates and (0 <= request["to_x"] < int(geometry[0]) and 0 <= request["to_y"] < int(geometry[1]))
        if not valid_coordinates:
            raise RuntimeError("The requested screen coordinate is outside the display bounds.")
        subprocess.run(["xdotool", "mousemove", "--sync", str(request["x"]), str(request["y"])], check=True, timeout=5)
        if request["action"] == "click_at":
            button = {"left": "1", "middle": "2", "right": "3"}.get(request.get("button", "left"))
            for _ in range(request.get("click_count", 1)):
                subprocess.run(["xdotool", "click", "--clearmodifiers", button], check=True, timeout=5)
        elif request["action"] == "drag_at":
            button = {"left": "1", "middle": "2", "right": "3"}.get(request.get("button", "left"))
            run_drag_with_release(
                lambda: subprocess.run(["xdotool", "mousedown", button], check=True, timeout=5),
                lambda: subprocess.run(["xdotool", "mousemove", "--sync", str(request["to_x"]), str(request["to_y"])], check=True, timeout=10),
                lambda: subprocess.run(["xdotool", "mouseup", button], check=True, timeout=5),
            )
        else:
            for delta, positive_button, negative_button in ((request.get("delta_y", 0), "4", "5"), (request.get("delta_x", 0), "7", "6")):
                if not delta: continue
                button = positive_button if delta > 0 else negative_button
                for _ in range(min(100, abs(delta) // 120 or 1)):
                    subprocess.run(["xdotool", "click", button], check=True, timeout=5)
        result = {"status":"completed", "action":request["action"], "x":request["x"], "y":request["y"]}
        if request["action"] == "drag_at": result.update({"to_x":request["to_x"], "to_y":request["to_y"]})
        print(json.dumps(result))
    else:
        node = get_target(request["element_path"])
        if (node.name or "") != request["expected_name"]: raise RuntimeError("The selected control name changed; inspect the desktop again before acting.")
        if request["action"] == "click":
            actions = node.queryAction()
            choices = {actions.getName(i).lower(): i for i in range(actions.nActions)}
            action = next((choices[name] for name in ("click", "press", "activate", "select") if name in choices), None)
            if action is None or not actions.doAction(action): raise RuntimeError("The selected control does not expose an accessibility click action.")
        elif request["action"] == "type_text":
            try:
                changed = node.queryEditableText().setTextContents(request["text"])
                if changed is False:
                    raise RuntimeError("The accessible control rejected the text.")
            except Exception:
                if not os.environ.get("WAYLAND_DISPLAY") or not shutil.which("wtype"):
                    raise
                node.queryComponent().grabFocus()
                subprocess.run(["wtype", "-"], input=request["text"], check=True, text=True, timeout=10)
        elif request["action"] == "press_key":
            node.queryComponent().grabFocus()
            if request.get("_wayland_commands"):
                for command in request["_wayland_commands"]:
                    subprocess.run(command, check=True, capture_output=True, text=True, timeout=5)
                print(json.dumps({"status":"completed", "action":request["action"], "target":request["expected_name"]}))
                sys.exit(0)
            subprocess.run(["xdotool", "key", "--clearmodifiers", request["_xdotool_key"]], check=True, timeout=5)
        print(json.dumps({"status":"completed", "action":request["action"], "target":request["expected_name"]}))
except Exception as exc:
    print(json.dumps({"error": str(exc)}))
    sys.exit(2)
`;
