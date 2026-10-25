import { spawn, type ChildProcess } from "node:child_process";
import { delimiter, isAbsolute, normalize, resolve } from "node:path";
import { platform } from "node:os";

export function normalizeUserPath(path: string, cwd = process.cwd()): string {
  if (!path.trim()) throw new Error("Path cannot be empty");
  if (process.platform === "win32" && /^\\\\\?\\/.test(path)) return normalize(path);
  return normalize(isAbsolute(path) ? path : resolve(cwd, path));
}

export function getDataDirectory(app = "xyst"): string {
  if (process.platform === "win32") return resolve(process.env.APPDATA ?? resolve(process.env.USERPROFILE ?? process.cwd(), "AppData", "Roaming"), app);
  return resolve(process.env.XDG_DATA_HOME ?? resolve(process.env.HOME ?? process.cwd(), ".local", "share"), app);
}

export interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputChars?: number;
  stdin?: boolean;
  onStdinWriter?: (write: (value: string) => void, close: () => void) => void;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}
export interface ProcessResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; durationMs: number }

async function killTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolveDone) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.once("close", () => resolveDone()); killer.once("error", () => resolveDone());
    });
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  }
}

export async function runProcess(command: string, args: string[], options: ProcessOptions = {}): Promise<ProcessResult> {
  const started = Date.now();
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"] });
  if (options.stdin && child.stdin) options.onStdinWriter?.((value) => { if (child.stdin && !child.stdin.destroyed) child.stdin.write(value); }, () => child.stdin?.end());
  let stdout = ""; let stderr = ""; let timedOut = false;
  const maxOutputChars = options.maxOutputChars ?? 200_000;
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { if (stdout.length < maxOutputChars) stdout += chunk.slice(0, maxOutputChars - stdout.length); options.onStdout?.(chunk); });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { if (stderr.length < maxOutputChars) stderr += chunk.slice(0, maxOutputChars - stderr.length); options.onStderr?.(chunk); });
  let timer: NodeJS.Timeout | undefined;
  const cancel = () => { void killTree(child); };
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.timeoutMs && options.timeoutMs > 0) timer = setTimeout(() => { timedOut = true; cancel(); }, options.timeoutMs);
  try {
    const result = await new Promise<ProcessResult>((resolveDone, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolveDone({ code, signal, stdout, stderr, durationMs: Date.now() - started }));
    });
    if (timedOut) throw new Error(`Process timed out after ${options.timeoutMs} ms`);
    if (options.signal?.aborted) throw new Error("Process cancelled");
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}

export async function runShell(script: string, options: ProcessOptions = {}): Promise<ProcessResult> {
  if (process.platform === "win32") return runProcess("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], options);
  return runProcess("/bin/sh", ["-lc", script], options);
}

export function platformInfo() { return { os: platform(), pathDelimiter: delimiter, node: process.version }; }
