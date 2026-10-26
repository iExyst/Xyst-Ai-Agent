import { homedir } from "node:os";
import { join, posix, resolve } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { runProcess, type ProcessResult } from "@xyst/runtime";

export const MISSION_SERVICE_NAME = "xyst-mission-daemon";
export const WINDOWS_TASK_NAME = "Xyst Mission Daemon";

export interface MissionServiceSpec { executable: string; cliEntry: string; workingDirectory: string; dataHome?: string; daemonArguments?: string[] }
export type ServiceCommand = (command: string, args: string[]) => Promise<ProcessResult>;
const defaultCommand: ServiceCommand = (command, args) => runProcess(command, args, { timeoutMs: 30_000, maxOutputChars: 4000 });

function unitQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("%", "%%")}"`;
}

function systemdEnvironment(name: string, value: string): string {
  return `"${name}=${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("%", "%%")}"`;
}

function powershellQuote(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

function windowsCommandLineQuote(value: string): string {
  let output = '"'; let slashes = 0;
  for (const character of value) {
    if (character === "\\") { slashes++; continue; }
    if (character === '"') { output += "\\".repeat(slashes * 2 + 1) + '"'; slashes = 0; continue; }
    output += "\\".repeat(slashes) + character; slashes = 0;
  }
  return output + "\\".repeat(slashes * 2) + '"';
}

function encodedPowerShell(script: string): string[] { return ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]; }

export function renderSystemdMissionUnit(spec: MissionServiceSpec): string {
  const workingDirectory = spec.workingDirectory.startsWith("/") ? spec.workingDirectory : resolve(spec.workingDirectory);
  const command = [spec.executable, spec.cliEntry, "mission", "daemon", ...(spec.daemonArguments ?? [])].map(unitQuote).join(" ");
  const dataHome = spec.dataHome ? posix.resolve(spec.dataHome) : undefined;
  const environment = [`Environment=${systemdEnvironment("XYST_ROOT", workingDirectory)}`, ...(dataHome ? [`Environment=${systemdEnvironment("XDG_DATA_HOME", dataHome)}`] : [])].join("\n");
  return `[Unit]\nDescription=Xyst persistent mission scheduler\nAfter=default.target\n\n[Service]\nType=simple\nWorkingDirectory=~\n${environment}\nExecStart=${command}\nRestart=on-failure\nRestartSec=10\nTimeoutStopSec=infinity\n\n[Install]\nWantedBy=default.target\n`;
}

export function renderWindowsMissionTaskScript(spec: MissionServiceSpec, operation: "install" | "uninstall" | "status"): string {
  const name = powershellQuote(WINDOWS_TASK_NAME);
  if (operation === "uninstall") return `$ErrorActionPreference = 'Stop'\n$task = Get-ScheduledTask -TaskName ${name} -ErrorAction SilentlyContinue\nif ($null -ne $task) { Stop-ScheduledTask -TaskName ${name} -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName ${name} -Confirm:$false }\n`;
  if (operation === "status") return `$ErrorActionPreference = 'Stop'\n$task = Get-ScheduledTask -TaskName ${name} -ErrorAction SilentlyContinue\nif ($null -eq $task) { @{ installed = $false } | ConvertTo-Json -Compress; exit 0 }\n$info = Get-ScheduledTaskInfo -TaskName ${name}\n@{ installed = $true; state = [string]$task.State; lastRunTime = $info.LastRunTime.ToString('o'); lastTaskResult = $info.LastTaskResult } | ConvertTo-Json -Compress\n`;
  const argumentsText = [spec.cliEntry, "mission", "daemon", ...(spec.daemonArguments ?? [])].map(windowsCommandLineQuote).join(" ");
  return `$ErrorActionPreference = 'Stop'\n$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name\n$action = New-ScheduledTaskAction -Execute ${powershellQuote(spec.executable)} -Argument ${powershellQuote(argumentsText)} -WorkingDirectory ${powershellQuote(resolve(spec.workingDirectory))}\n$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user\n$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited\n$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)\nRegister-ScheduledTask -TaskName ${name} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Xyst durable mission scheduler' -Force | Out-Null\nStart-ScheduledTask -TaskName ${name}\n`;
}

async function invoke(command: string, args: string[], run: ServiceCommand): Promise<ProcessResult> {
  const result = await run(command, args);
  if (result.code !== 0) throw new Error(`${command} ${args.slice(0, 2).join(" ")} failed (${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 1500)}`);
  return result;
}

export function systemdMissionUnitPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user", `${MISSION_SERVICE_NAME}.service`);
}

export async function installMissionService(platform: NodeJS.Platform, spec: MissionServiceSpec, run: ServiceCommand = defaultCommand, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  if (platform === "linux") {
    const path = systemdMissionUnitPath(env); await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, renderSystemdMissionUnit(spec), { encoding: "utf8", mode: 0o644 });
    await invoke("systemctl", ["--user", "daemon-reload"], run);
    await invoke("systemctl", ["--user", "enable", "--now", MISSION_SERVICE_NAME], run);
    return { installed: true, platform, manager: "systemd-user", path, enabled: true, active: true };
  }
  if (platform === "win32") {
    await invoke("powershell.exe", encodedPowerShell(renderWindowsMissionTaskScript(spec, "install")), run);
    return { installed: true, platform, manager: "task-scheduler", taskName: WINDOWS_TASK_NAME, trigger: "at-logon", started: true };
  }
  throw new Error(`Mission service installation is unsupported on ${platform}`);
}

export async function uninstallMissionService(platform: NodeJS.Platform, run: ServiceCommand = defaultCommand, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  if (platform === "linux") {
    const path = systemdMissionUnitPath(env);
    try { await invoke("systemctl", ["--user", "disable", "--now", MISSION_SERVICE_NAME], run); } catch { /* The user manager may be stopped; still remove the unit file. */ }
    await rm(path, { force: true }); await invoke("systemctl", ["--user", "daemon-reload"], run);
    return { installed: false, platform, manager: "systemd-user", path };
  }
  if (platform === "win32") {
    await invoke("powershell.exe", encodedPowerShell(renderWindowsMissionTaskScript({ executable: "", cliEntry: "", workingDirectory: process.cwd() }, "uninstall")), run);
    return { installed: false, platform, manager: "task-scheduler", taskName: WINDOWS_TASK_NAME };
  }
  throw new Error(`Mission service removal is unsupported on ${platform}`);
}

export async function missionServiceStatus(platform: NodeJS.Platform, run: ServiceCommand = defaultCommand, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  if (platform === "linux") {
    const path = systemdMissionUnitPath(env);
    const result = await run("systemctl", ["--user", "show", MISSION_SERVICE_NAME, "--property=LoadState", "--property=ActiveState", "--property=SubState"]);
    const values = Object.fromEntries(result.stdout.split(/\r?\n/).filter(Boolean).map((line) => { const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)]; }));
    return { installed: values.LoadState === "loaded", platform, manager: "systemd-user", path, loadState: values.LoadState ?? "unknown", activeState: values.ActiveState ?? "unknown", subState: values.SubState ?? "unknown", ...(result.code === 0 ? {} : { error: result.stderr.trim() || result.stdout.trim() }) };
  }
  if (platform === "win32") {
    const result = await run("powershell.exe", encodedPowerShell(renderWindowsMissionTaskScript({ executable: "", cliEntry: "", workingDirectory: process.cwd() }, "status")));
    if (result.code !== 0) throw new Error(`Could not query Task Scheduler: ${result.stderr.trim().slice(0, 1200)}`);
    try { return { ...JSON.parse(result.stdout.trim()), platform, manager: "task-scheduler", taskName: WINDOWS_TASK_NAME }; }
    catch { throw new Error("Task Scheduler returned an invalid status response"); }
  }
  throw new Error(`Mission service status is unsupported on ${platform}`);
}
