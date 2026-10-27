import { redactSecrets } from "./credentials.js";
import type { AccessController } from "./access.js";
import { runProcess } from "./platform.js";

export interface LmsDaemonStatus {
  available: boolean;
  status: "running" | "not-running" | "unknown";
  service: "llmster" | "desktop-app" | "unknown";
  pid?: number;
  explanation: string;
}

export function parseLmsDaemonStatus(output: string): LmsDaemonStatus {
  let value: Record<string, unknown>;
  try { value = JSON.parse(output) as Record<string, unknown>; }
  catch { return { available: true, status: "unknown", service: "unknown", explanation: "The lms daemon status command returned invalid JSON." }; }
  if (value.status === "not-running") return { available: true, status: "not-running", service: "unknown", explanation: "llmster is not running. A separate LM Studio desktop server may still be available." };
  if (value.status !== "running") return { available: true, status: "unknown", service: "unknown", explanation: "The installed lms CLI returned an unrecognized daemon status." };
  const service = value.isDaemon === true ? "llmster" : value.isDaemon === false ? "desktop-app" : "unknown";
  return {
    available: true,
    status: "running",
    service,
    ...(Number.isInteger(value.pid) && Number(value.pid) > 0 ? { pid: Number(value.pid) } : {}),
    explanation: service === "llmster" ? "The headless LM Studio daemon is running." : service === "desktop-app" ? "LM Studio reports a running server owned by its desktop app, not the headless daemon." : "A daemon is running, but this lms version did not identify its service type."
  };
}

export async function inspectLmsDaemon(access: AccessController, signal?: AbortSignal): Promise<LmsDaemonStatus> {
  const command = process.env.LM_STUDIO_CLI_PATH ?? (process.platform === "win32" ? "lms.exe" : "lms");
  access.assertExecutable(command);
  try {
    const result = await runProcess(command, ["daemon", "status", "--json"], { timeoutMs: 5000, maxOutputChars: 4096, ...(signal ? { signal } : {}) });
    if (result.code !== 0) return { available: true, status: "unknown", service: "unknown", explanation: redactSecrets(result.stderr.trim() || "The lms daemon status command failed.") };
    return parseLmsDaemonStatus(result.stdout);
  } catch (error) {
    if (signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return { available: false, status: "unknown", service: "unknown", explanation: redactSecrets(`Cannot inspect the LM Studio daemon: ${message}`) };
  }
}
