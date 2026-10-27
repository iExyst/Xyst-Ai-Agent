import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { runProcess, type ProcessResult } from "../platform.js";
import type { AccessController } from "../access.js";

type Runner = (command: string, args: string[], options?: { timeoutMs?: number; maxOutputChars?: number; signal?: AbortSignal }) => Promise<ProcessResult>;
type RuntimeEnvironment = { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; pathExists?: (path: string) => boolean };
type Capability = { available: boolean; backend: string | null; limitation: string };

function executablePath(name: string, environment: RuntimeEnvironment): string | undefined {
  const env = environment.env ?? process.env;
  const pathExists = environment.pathExists ?? existsSync;
  const extensions = environment.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, name.toLowerCase().endsWith(extension.toLowerCase()) ? name : name + extension);
      if (pathExists(candidate)) return candidate;
    }
  }
  return undefined;
}

export function inspectNativeAutomation(environment: RuntimeEnvironment = {}): Capability {
  const platform = environment.platform ?? process.platform;
  const env = environment.env ?? process.env;
  if (platform === "win32") return { available: true, backend: "Microsoft UI Automation", limitation: "Control availability depends on the target application's exposed UI Automation tree and the current interactive desktop session." };
  if (platform === "linux") {
    const session = (env.XDG_SESSION_TYPE ?? (env.WAYLAND_DISPLAY ? "wayland" : env.DISPLAY ? "x11" : "unknown")).toLowerCase();
    const xdotool = executablePath("xdotool", environment);
    if (env.DISPLAY && xdotool) return {
      available: true, backend: "X11 input via xdotool",
      limitation: session === "wayland" ? "Controls X11/Xwayland windows only. Native Wayland surfaces are unavailable through this backend." : "Controls X11 windows through coordinates and keyboard input; it does not expose an accessibility control tree."
    };
    if (session === "wayland" || env.WAYLAND_DISPLAY) return { available: false, backend: null, limitation: "Native Wayland UI automation is unavailable. Use an X11/Xwayland session with xdotool, or an application API." };
    if (!env.DISPLAY) return { available: false, backend: null, limitation: "No X11 display is available. Start Xyst in a graphical X11 session or use an application API." };
    return { available: false, backend: null, limitation: "Install xdotool in the Xyst user's PATH to control X11 windows." };
  }
  return { available: false, backend: null, limitation: `Native application automation is not supported on ${platform}.` };
}

const uiAutomationScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PAYLOAD__')) | ConvertFrom-Json
$root = [System.Windows.Automation.AutomationElement]::RootElement
function Find-Window($title) {
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  $matches = @()
  foreach ($element in $all) { if ($element.Current.Name -ceq $title -and -not $element.Current.IsOffscreen) { $matches += $element } }
  if ($matches.Count -ne 1) { throw "Expected one visible window with the exact title '$title'; found $($matches.Count)." }
  return $matches[0]
}
function Describe($element) {
  $current = $element.Current
  return [pscustomobject]@{ name=$current.Name; automationId=$current.AutomationId; controlType=$current.ControlType.ProgrammaticName; processId=$current.ProcessId; enabled=$current.IsEnabled; offscreen=$current.IsOffscreen; className=$current.ClassName }
}
function Get-Controls($window, $limit) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue([pscustomobject]@{ element=$window; depth=0 })
  $items = New-Object System.Collections.ArrayList
  while ($queue.Count -gt 0 -and $items.Count -lt $limit) {
    $entry = $queue.Dequeue()
    if ($entry.depth -ge 10) { continue }
    $child = $walker.GetFirstChild($entry.element)
    while ($null -ne $child -and $items.Count -lt $limit) {
      try { [void]$items.Add((Describe $child)); $queue.Enqueue([pscustomobject]@{ element=$child; depth=$entry.depth + 1 }) } catch { }
      $child = $walker.GetNextSibling($child)
    }
  }
  return @($items)
}
function Write-Json($value) {
  $json = ConvertTo-Json -InputObject $value -Depth 6 -Compress
  [Console]::Out.WriteLine($json)
}
if ($request.operation -eq 'windows') {
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  $items = New-Object System.Collections.ArrayList
  foreach ($element in $all) {
    try { if (-not $element.Current.IsOffscreen -and $element.Current.Name) { [void]$items.Add((Describe $element)) } } catch { }
    if ($items.Count -ge 100) { break }
  }
  Write-Json @($items)
} elseif ($request.operation -eq 'inspect') {
  $window = Find-Window $request.window_title
  Write-Json @{ window=(Describe $window); controls=@(Get-Controls $window ([int]$request.limit)) }
} else {
  $window = Find-Window $request.window_title
  if ($request.action -eq 'focus_window') { $window.SetFocus(); Write-Json @{ focused=$true; window=$request.window_title }; exit 0 }
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  $windows = @($all | Where-Object { $_.Current.Name -ceq $request.window_title -and -not $_.Current.IsOffscreen })
  $window = $windows[0]
  $condition = if ($request.automation_id) { [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, [string]$request.automation_id) } else { [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, [string]$request.control_name) }
  $found = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
  if ($found.Count -ne 1) { throw "Expected one matching control; found $($found.Count). Use an exact AutomationId or control name." }
  $element = $found[0]
  switch ($request.action) {
    'focus' { $element.SetFocus(); $result = @{ focused=$true; target=(Describe $element) } }
    'invoke' { $pattern = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $pattern.Invoke(); $result = @{ invoked=$true; target=(Describe $element) } }
    'set_value' { $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); if ($pattern.Current.IsReadOnly) { throw 'The target value control is read-only.' }; $pattern.SetValue([string]$request.value); $result = @{ updated=$true; target=(Describe $element) } }
    'toggle' { $pattern = $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern); $pattern.Toggle(); $result = @{ toggled=$true; target=(Describe $element) } }
    'select' { $pattern = $element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern); $pattern.Select(); $result = @{ selected=$true; target=(Describe $element) } }
    default { throw "Unsupported UI Automation action '$($request.action)'." }
  }
  Write-Json $result
}`;

async function run(access: AccessController, runner: Runner, command: string, args: string[], signal?: AbortSignal, timeoutMs = 10_000): Promise<ProcessResult> {
  access.assertExecutable(command);
  const result = await runner(command, args, { timeoutMs, maxOutputChars: 30_000, ...(signal ? { signal } : {}) });
  if (result.code !== 0 || result.signal) throw new Error((result.stderr || result.stdout || `Desktop automation exited with code ${result.code}`).slice(0, 2000));
  return result;
}

function powershellPayload(request: Record<string, unknown>): string[] {
  const payload = Buffer.from(JSON.stringify(request), "utf8").toString("base64");
  const script = uiAutomationScript.replace("__PAYLOAD__", payload);
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

function parseJson<T>(value: string): T {
  try { return JSON.parse(value) as T; } catch { throw new Error(`Desktop automation returned invalid JSON: ${value.slice(0, 1000)}`); }
}

export function createDesktopAutomationTools(access: AccessController, enabled: boolean, options: RuntimeEnvironment & { runner?: Runner } = {}) {
  if (!enabled) return {};
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const runner = options.runner ?? runProcess;
  const environment: RuntimeEnvironment = { platform, env, ...(options.pathExists ? { pathExists: options.pathExists } : {}) };
  const capability = inspectNativeAutomation(environment);
  if (!capability.available) return {};
  if (platform === "win32") {
    const command = "powershell.exe";
    return {
      desktop_windows: {
        definition: { type: "function", function: { name: "desktop_windows", description: "List visible top-level Windows desktop windows and their process IDs. This reads the current interactive desktop session.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
        execute: async (_input: unknown, signal?: AbortSignal) => parseJson(await run(access, runner, command, powershellPayload({ operation: "windows" }), signal).then((result) => result.stdout.trim()))
      },
      desktop_inspect: {
        definition: { type: "function", function: { name: "desktop_inspect", description: "Inspect a bounded UI Automation control tree for one visible window. Match the exact window title; use AutomationId where available when acting on a control.", parameters: { type: "object", properties: { window_title: { type: "string", minLength: 1, maxLength: 500 }, limit: { type: "integer", minimum: 1, maximum: 250 } }, required: ["window_title"], additionalProperties: false } } },
        execute: async (input: unknown, signal?: AbortSignal) => {
          const args = input as { window_title: string; limit?: number };
          if (typeof args?.window_title !== "string" || !args.window_title.trim() || args.window_title.length > 500 || args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 250)) throw new Error("Window title is required; control limit must be 1–250");
          return parseJson(await run(access, runner, command, powershellPayload({ operation: "inspect", window_title: args.window_title, limit: args.limit ?? 100 }), signal).then((result) => result.stdout.trim()));
        }
      },
      desktop_action: {
        definition: { type: "function", function: { name: "desktop_action", description: "Perform one UI Automation action on a visible Windows application control. Use exact window titles and a unique AutomationId or exact control name. Supported actions: focus_window, focus, invoke, set_value, toggle, select. The action changes the visible application and is subject to external-action approval.", parameters: { type: "object", properties: { action: { type: "string", enum: ["focus_window", "focus", "invoke", "set_value", "toggle", "select"] }, window_title: { type: "string", minLength: 1, maxLength: 500 }, automation_id: { type: "string", maxLength: 500 }, control_name: { type: "string", maxLength: 500 }, value: { type: "string", maxLength: 5000 } }, required: ["action", "window_title"], additionalProperties: false } } },
        execute: async (input: unknown, signal?: AbortSignal) => {
          access.assertCapability("externalActions");
          const args = input as Record<string, unknown>;
          const allowed = ["focus_window", "focus", "invoke", "set_value", "toggle", "select"];
          if (typeof args?.action !== "string" || !allowed.includes(args.action) || typeof args.window_title !== "string" || !args.window_title.trim() || args.window_title.length > 500) throw new Error("Provide a supported action and exact window title");
          if (args.action !== "focus_window" && !((typeof args.automation_id === "string" && args.automation_id.length > 0 && args.automation_id.length <= 500) || (typeof args.control_name === "string" && args.control_name.length > 0 && args.control_name.length <= 500))) throw new Error("Control actions require an AutomationId or exact control name");
          if (args.action === "set_value" && (typeof args.value !== "string" || args.value.length > 5000)) throw new Error("set_value requires text of at most 5,000 characters");
          const request = { operation: "action", action: args.action, window_title: args.window_title, ...(typeof args.automation_id === "string" ? { automation_id: args.automation_id } : {}), ...(typeof args.control_name === "string" ? { control_name: args.control_name } : {}), ...(typeof args.value === "string" ? { value: args.value } : {}) };
          return parseJson(await run(access, runner, command, powershellPayload(request), signal).then((result) => result.stdout.trim()));
        }
      }
    };
  }
  const command = executablePath("xdotool", environment);
  if (!command) return {};
  const windows = async (signal?: AbortSignal) => {
    const result = await run(access, runner, command, ["search", "--onlyvisible", "--name", "."], signal);
    const ids = [...new Set(result.stdout.split(/\r?\n/).map((item) => item.trim()).filter((item) => /^\d+$/.test(item)))].slice(0, 100);
    const found = [];
    for (const id of ids) {
      const title = (await run(access, runner, command, ["getwindowname", id], signal).then((value) => value.stdout.trim()).catch(() => ""));
      found.push({ id, title });
    }
    return found;
  };
  return {
    desktop_windows: {
      definition: { type: "function", function: { name: "desktop_windows", description: "List up to 100 visible X11/Xwayland windows using xdotool. Native Wayland windows are not included.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
      execute: async (_input: unknown, signal?: AbortSignal) => windows(signal)
    },
    desktop_inspect: {
      definition: { type: "function", function: { name: "desktop_inspect", description: "Inspect the geometry and title of an X11/Xwayland window by its window ID. This backend does not expose native accessibility controls.", parameters: { type: "object", properties: { window_id: { type: "string", pattern: "^[0-9]+$" } }, required: ["window_id"], additionalProperties: false } } },
      execute: async (input: unknown, signal?: AbortSignal) => {
        const id = (input as { window_id?: unknown })?.window_id;
        if (typeof id !== "string" || !/^\d+$/.test(id)) throw new Error("An X11 window ID is required");
        const title = await run(access, runner, command, ["getwindowname", id], signal).then((result) => result.stdout.trim());
        const geometry = await run(access, runner, command, ["getwindowgeometry", "--shell", id], signal).then((result) => Object.fromEntries(result.stdout.split(/\r?\n/).map((line) => { const index = line.indexOf("="); return index > 0 ? [line.slice(0, index), line.slice(index + 1)] : ["", ""]; }).filter(([key]) => key)));
        return { id, title, geometry, capability: "x11-input-only" };
      }
    },
    desktop_action: {
      definition: { type: "function", function: { name: "desktop_action", description: "Perform one action on an X11/Xwayland window. Supported actions are activate_window, click, type_text, press_key. Native Wayland surfaces cannot be controlled. Actions change the visible desktop and are subject to external-action approval.", parameters: { type: "object", properties: { action: { type: "string", enum: ["activate_window", "click", "type_text", "press_key"] }, window_id: { type: "string", pattern: "^[0-9]+$" }, x: { type: "integer", minimum: 0, maximum: 100000 }, y: { type: "integer", minimum: 0, maximum: 100000 }, button: { type: "integer", minimum: 1, maximum: 5 }, text: { type: "string", maxLength: 5000 }, key: { type: "string", pattern: "^[A-Za-z0-9_+.-]{1,80}$" } }, required: ["action"], additionalProperties: false } } },
      execute: async (input: unknown, signal?: AbortSignal) => {
        access.assertCapability("externalActions");
        const args = input as Record<string, unknown>;
        const id = args?.window_id;
        const allowed = ["activate_window", "click", "type_text", "press_key"];
        if (typeof args?.action !== "string" || !allowed.includes(args.action)) throw new Error("Provide a supported X11 desktop action");
        const windowId = typeof id === "string" && /^\d+$/.test(id) ? id : undefined;
        if (!windowId) throw new Error("An X11 window ID is required");
        let argv: string[];
        if (args.action === "activate_window") argv = ["windowactivate", "--sync", windowId];
        else if (args.action === "click") {
          if (!Number.isInteger(args.x) || Number(args.x) < 0 || Number(args.x) > 100000 || !Number.isInteger(args.y) || Number(args.y) < 0 || Number(args.y) > 100000) throw new Error("Click coordinates must be integers from 0 to 100,000");
          const geometry = await run(access, runner, command, ["getwindowgeometry", "--shell", windowId], signal).then((result) => Object.fromEntries(result.stdout.split(/\r?\n/).map((line) => { const index = line.indexOf("="); return index > 0 ? [line.slice(0, index), Number(line.slice(index + 1))] : ["", 0]; }).filter(([key]) => key)) as Record<string, number>);
          const windowWidth = geometry.WIDTH ?? 0; const windowHeight = geometry.HEIGHT ?? 0; const windowX = geometry.X ?? 0; const windowY = geometry.Y ?? 0;
          if (Number(args.x) >= windowWidth || Number(args.y) >= windowHeight) throw new Error("Click coordinates fall outside the selected window bounds");
          argv = ["mousemove", "--sync", String(windowX + Number(args.x)), String(windowY + Number(args.y)), "click", String(Number.isInteger(args.button) && Number(args.button) >= 1 && Number(args.button) <= 5 ? args.button : 1)];
        } else if (args.action === "type_text") {
          if (typeof args.text !== "string" || !args.text.length || args.text.length > 5000 || /[\u0000]/.test(args.text)) throw new Error("type_text requires 1–5,000 characters without NUL");
          argv = ["windowactivate", "--sync", windowId]; await run(access, runner, command, argv, signal);
          argv = ["type", "--clearmodifiers", "--delay", "1", "--", args.text];
        } else {
          if (typeof args.key !== "string" || !/^[A-Za-z0-9_+.-]{1,80}$/.test(args.key)) throw new Error("press_key requires a key or key chord using letters, numbers, underscores, +, . or -");
          argv = ["windowactivate", "--sync", windowId]; await run(access, runner, command, argv, signal);
          argv = ["key", "--clearmodifiers", args.key];
        }
        const result = await run(access, runner, command, argv, signal);
        return { action: args.action, window_id: windowId, completed: true, stdout: result.stdout.slice(0, 1000) };
      }
    }
  };
}
