import { app, BrowserWindow, dialog, ipcMain, Notification, shell, type OpenDialogOptions } from "electron";
import electronUpdater from "electron-updater";
import type { AppUpdater } from "electron-updater";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lmStudioIntegrationsSchema, mcpServersSchema } from "@xyst/runtime";
import { scopedSettingKeys, settingScopes } from "./setting-keys.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = process.env.XYST_ROOT ?? (app.isPackaged ? join(app.getPath("documents"), "Xyst") : resolve(here, "../../.."));
const packagedCliRoot = join(process.resourcesPath, "app.asar.unpacked");
const cliEntry = process.env.XYST_CLI_PATH ?? (app.isPackaged ? join(packagedCliRoot, "apps", "cli", "dist", "index.js") : resolve(projectRoot, "apps/cli/dist/index.js"));
const bundledNode = app.isPackaged
  ? join(packagedCliRoot, "apps", "desktop", "runtime", process.platform === "win32" ? "node.exe" : "node")
  : resolve(here, "..", "runtime", process.platform === "win32" ? "node.exe" : "node");
const nodeBinary = process.env.XYST_NODE_PATH ?? (app.isPackaged ? bundledNode : process.platform === "win32" ? "node.exe" : "node");
let windowRef: BrowserWindow | undefined;
const pickedAttachments = new Map<number, Set<string>>();
const activeAgentRuns = new Map<string, ChildProcess>();
const pendingAgentMessageResults = new WeakMap<ChildProcess, Map<string, (accepted: boolean) => void>>();
let selectedWorkspace = projectRoot;
type UpdateState = { status: "idle" | "checking" | "available" | "up-to-date" | "downloading" | "downloaded" | "error"; currentVersion: string; version?: string; percent?: number; transferred?: number; total?: number; error?: string };
let updateState: UpdateState = { status: "idle", currentVersion: app.getVersion() };
let configuredUpdateFeed = "";
let activeUpdater: AppUpdater | undefined;
let downloadedUpdater: AppUpdater | undefined;
const { AppImageUpdater, NsisUpdater } = electronUpdater;

function setUpdateState(patch: Partial<UpdateState>): void {
  updateState = { ...updateState, ...patch };
  if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send("xyst:updater-event", updateState);
}

function watchUpdater(updater: AppUpdater): void {
  updater.autoInstallOnAppQuit = false;
  updater.allowDowngrade = false;
  updater.on("checking-for-update", () => { if (activeUpdater === updater) setUpdateState({ status: "checking", error: undefined, percent: undefined }); });
  updater.on("update-available", (info) => { if (activeUpdater === updater) setUpdateState({ status: "available", version: info.version, error: undefined, percent: undefined }); });
  updater.on("update-not-available", () => { if (activeUpdater === updater) setUpdateState({ status: "up-to-date", currentVersion: app.getVersion(), version: undefined, error: undefined, percent: undefined }); });
  updater.on("download-progress", (progress) => { if (activeUpdater === updater) setUpdateState({ status: "downloading", percent: progress.percent, transferred: progress.transferred, total: progress.total }); });
  updater.on("update-downloaded", (info) => { if (activeUpdater === updater) { downloadedUpdater = updater; setUpdateState({ status: "downloaded", version: info.version, percent: 100, error: undefined }); } });
  updater.on("error", (error) => { if (activeUpdater === updater) setUpdateState({ status: "error", error: error.message.slice(0, 800), percent: undefined }); });
}

async function configuredValue(key: string): Promise<{ value?: unknown; configured?: boolean; source?: string }> {
  return await invokeCli(["config", "get", key]) as { value?: unknown; configured?: boolean; source?: string };
}

async function updateNetworkAllowed(): Promise<void> {
  const [network, profile] = await Promise.all([configuredValue("network.enabled"), configuredValue("access.profile")]);
  const access = profile.value && typeof profile.value === "object" ? profile.value as Record<string, unknown> : {};
  if (network.value === false || (access.mode === "restricted" && access.network !== true)) throw new Error("Updates require network access in both the global network setting and the active access profile.");
}

async function configureUpdater(): Promise<{ enabled: boolean; automaticDownload: boolean; feedUrl: string }> {
  const [enabled, automaticDownload, feed] = await Promise.all([configuredValue("updates.enabled"), configuredValue("updates.autoDownload"), configuredValue("updates.feedUrl")]);
  const config = { enabled: enabled.value === true, automaticDownload: automaticDownload.value === true, feedUrl: typeof feed.value === "string" ? feed.value : "" };
  if (!config.enabled || !config.feedUrl) {
    if (activeUpdater) activeUpdater.autoDownload = false;
    if (updateState.status === "available") setUpdateState({ status: "idle", version: undefined, error: undefined });
    return config;
  }
  if (!app.isPackaged) return config;
  if (!(["win32", "linux"] as string[]).includes(process.platform)) throw new Error(`Xyst updates are not configured for ${process.platform}.`);
  if (configuredUpdateFeed !== config.feedUrl || !activeUpdater) {
    if (updateState.status !== "downloaded") setUpdateState({ status: "idle", version: undefined, error: undefined, percent: undefined });
    const options = { provider: "generic" as const, url: config.feedUrl.endsWith("/") ? config.feedUrl : `${config.feedUrl}/` };
    activeUpdater = process.platform === "win32" ? new NsisUpdater(options) : new AppImageUpdater(options);
    configuredUpdateFeed = config.feedUrl;
    watchUpdater(activeUpdater);
  }
  activeUpdater.autoDownload = config.automaticDownload;
  activeUpdater.autoInstallOnAppQuit = false;
  return config;
}

async function checkForXystUpdate(): Promise<unknown> {
  if (updateState.status === "downloaded") throw new Error("A downloaded update is ready to install; install and restart before checking for another update.");
  const config = await configureUpdater();
  if (!config.enabled) throw new Error("Enable update checks in System Settings first.");
  if (!config.feedUrl) throw new Error("Set an HTTPS update feed URL in System Settings first.");
  if (!app.isPackaged) throw new Error("Update checks require a packaged Xyst application.");
  await updateNetworkAllowed();
  if (!activeUpdater) throw new Error("The Xyst update provider could not be initialized.");
  return activeUpdater.checkForUpdates();
}

function notifyRuntimeEvent(value: Record<string, unknown>, includeAgentEvents = false): void {
  const type = value.type;
  const payload = value.payload && typeof value.payload === "object" ? value.payload as Record<string, unknown> : {};
  const notice = type === "mission.finished"
    ? { title: payload.status === "completed" ? "Xyst mission complete" : "Xyst mission stopped", body: `Mission run ${String(payload.status ?? "finished")}.` }
    : includeAgentEvents && type === "agent.finished"
      ? { title: payload.status === "completed" ? "Xyst task complete" : "Xyst task stopped", body: `Agent run ${String(payload.status ?? "finished")}.` }
      : includeAgentEvents && type === "agent.failed"
        ? { title: "Xyst task needs attention", body: "The agent run failed. Open Xyst to inspect its details." }
        : undefined;
  if (!notice || !Notification.isSupported()) return;
  void invokeCli(["config", "get", "notifications.enabled"]).then((setting) => {
    if ((setting as { value?: unknown } | undefined)?.value === true) new Notification(notice).show();
  }).catch(() => undefined);
}

function notifyMissionResult(value: Record<string, unknown>): void {
  notifyRuntimeEvent({ type: "mission.finished", payload: value });
}

function consumePickedAttachments(senderId: number, paths: unknown): string[] {
  if (paths === undefined) return [];
  if (!Array.isArray(paths) || paths.length > 10 || paths.some((path) => typeof path !== "string")) throw new Error("Choose up to 10 local attachment files");
  const selected = pickedAttachments.get(senderId) ?? new Set<string>();
  const resolved = paths.map((path) => resolve(path as string));
  if (resolved.some((path) => !selected.has(path))) throw new Error("Attachment paths must come from the Xyst file picker");
  pickedAttachments.delete(senderId);
  return resolved;
}

function invokeCli(args: string[], onLine?: (value: Record<string, unknown>) => void, agentRunId?: string, workingDirectory = projectRoot): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const stdio: ["pipe", "pipe", "pipe"] | ["pipe", "pipe", "pipe", "ipc"] = agentRunId
      ? ["pipe", "pipe", "pipe", "ipc"]
      : ["pipe", "pipe", "pipe"];
    const child = spawn(nodeBinary, ["--experimental-wasm-modules", cliEntry, "--json", ...args], {
      cwd: workingDirectory,
      windowsHide: true,
      stdio,
      env: { ...process.env, XYST_ROOT: workingDirectory, XYST_DESKTOP_PARENT: "1" }
    });
    const childStdin = child.stdin!; const childStdout = child.stdout!; const childStderr = child.stderr!;
    if (agentRunId) activeAgentRuns.set(agentRunId, child);
    if (agentRunId) {
      const pending = new Map<string, (accepted: boolean) => void>();
      pendingAgentMessageResults.set(child, pending);
      child.on("message", (message) => {
        if (!message || typeof message !== "object") return;
        const value = message as { type?: unknown; requestId?: unknown; accepted?: unknown };
        if (value.type !== "xyst:user-message-result" || typeof value.requestId !== "string") return;
        const resolve = pending.get(value.requestId);
        if (resolve) { pending.delete(value.requestId); resolve(value.accepted === true); }
      });
    }
    let stdout = ""; let stderr = ""; let finalValue: unknown;
    childStdout.setEncoding("utf8"); childStderr.setEncoding("utf8");
    childStdout.on("data", (chunk: string) => {
      stdout += chunk;
      let at: number;
      while ((at = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, at).trim(); stdout = stdout.slice(at + 1);
        if (!line) continue;
        try {
          const value = JSON.parse(line) as Record<string, unknown>;
          if (value.type === "remote_fallback_request") {
            const requestId = typeof value.requestId === "string" ? value.requestId : "";
            const options = { type: "warning" as const, title: "Approve remote model fallback", message: "Send this agent run's context to the configured remote LM Studio server?", detail: String(value.disclosure ?? "The full conversation and workspace context may be sent.").slice(0, 1600), buttons: ["Send once", "Deny"], defaultId: 1, cancelId: 1, noLink: true };
            const prompt = windowRef && !windowRef.isDestroyed() ? dialog.showMessageBox(windowRef, options) : dialog.showMessageBox(options);
            void prompt.then(({ response }) => { if (!childStdin.destroyed && child.exitCode === null && child.signalCode === null) childStdin.write(`${JSON.stringify({ type: "approval_response", requestId, approved: Boolean(requestId) && response === 0 })}\n`); }).catch(() => undefined);
          } else if (value.type === "approval_request") {
            const requestId = typeof value.requestId === "string" ? value.requestId : "";
            const toolName = typeof value.toolName === "string" ? value.toolName.slice(0, 160) : "external action";
            const missionId = typeof value.missionId === "string" ? `Mission: ${value.missionId.slice(0, 120)}\n` : "";
            const argumentsJson = typeof value.argumentsJson === "string" ? value.argumentsJson.slice(0, 3000) : "{}";
            const options = { type: "warning" as const, title: "Approve external action", message: `Allow Xyst to run ${toolName}?`, detail: `${missionId}Session: ${String(value.sessionId ?? "").slice(0, 120)}\nArguments (secrets redacted by Xyst):\n${argumentsJson}`, buttons: ["Approve once", "Deny"], defaultId: 1, cancelId: 1, noLink: true };
            const prompt = windowRef && !windowRef.isDestroyed() ? dialog.showMessageBox(windowRef, options) : dialog.showMessageBox(options);
            void prompt.then(({ response }) => { if (!childStdin.destroyed && child.exitCode === null && child.signalCode === null) childStdin.write(`${JSON.stringify({ type: "approval_response", requestId, approved: Boolean(requestId) && response === 0 })}\n`); }).catch(() => undefined);
          } else onLine?.(value);
          if (value.type === "result") finalValue = value.data;
        }
        catch { onLine?.({ type: "output", data: line }); }
      }
    });
    childStderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => { if (agentRunId && activeAgentRuns.get(agentRunId) === child) activeAgentRuns.delete(agentRunId); reject(error); });
    child.once("close", (code) => {
      if (agentRunId && activeAgentRuns.get(agentRunId) === child) activeAgentRuns.delete(agentRunId);
      const pending = pendingAgentMessageResults.get(child);
      if (pending) { for (const resolve of pending.values()) resolve(false); pending.clear(); }
      if (stdout.trim()) {
        try { const value = JSON.parse(stdout.trim()) as Record<string, unknown>; onLine?.(value); if (value.type === "result") finalValue = value.data; }
        catch { onLine?.({ type: "output", data: stdout.trim() }); }
      }
      if (agentRunId && (code === 130 || code === 3)) resolvePromise(finalValue);
      else if (code !== 0) reject(new Error(stderr.trim() || `Xyst CLI exited with code ${code}`));
      else resolvePromise(finalValue);
    });
  });
}

async function snapshot() {
  const value = await invokeCli(["desktop", "snapshot"]) as Record<string, unknown>;
  return { ...value, updateState };
}

function allowedAction(action: string): boolean {
  return ["mission:list", "mission:show", "mission:run", "mission:pause", "mission:resume", "mission:cancel", "mission:archive", "mission:rename", "mission:fork", "mission:export", "mission:delete", "mission:templates", "mission:template", "mission:plan", "mission:task-configure", "mission:task-pause", "mission:task-resume", "mission:task-retry", "jobs:list", "process:start", "process:show", "process:stop", "process:input", "process:end-input", "process:resize", "terminal:start", "config:scoped-inspect", "config:scoped-set", "config:scoped-reset", "updates:check", "updates:download", "updates:install", "setting:updates", "setting:ocr-languages", "setting:office-renderer", "setting:desktop-automation", "lm:models", "lm:load", "lm:estimate", "lm:unload", "hf:search", "hf:inspect", "hf:recommend", "hf:download", "hf:status", "hf:verify-download", "hf:downloads", "browser:install", "setting:browser-automation", "setting:browser-headless", "setting:browser-max-download", "setting:model-default", "setting:model-max-download", "setting:model-license-preferences", "setting:model-auto", "setting:model-loading", "setting:model-unloading", "setting:model-idle-unload", "setting:model-remote-fallback", "setting:model-remote-config", "setting:model-discovery", "setting:model-downloads", "setting:model-switching", "setting:local-metrics", "setting:resource-budget", "setting:concurrency", "setting:parallel-reads", "setting:mission-scheduling", "setting:automatic-retries", "setting:delegation", "setting:external-approval", "setting:network", "setting:notifications", "setting:memory-semantic", "setting:inference", "setting:github", "setting:mcp", "setting:native-chat-mcp", "setting:access-profile", "memory:index", "setting:reduced-motion", "setting:high-contrast", "setting:reset-global", "session:list", "session:show", "session:compact", "session:calls", "session:artifacts", "session:rename", "session:archive", "session:delete", "session:export", "memory:list", "memory:add", "memory:edit", "memory:delete", "github:status", "github:repos", "github:issues", "github:prs", "github:open", "git:changes", "git:pick-workspace", "git:current-workspace"].includes(action);
}

function registerIpc(): void {
  ipcMain.handle("xyst:snapshot", async () => snapshot());
  ipcMain.handle("xyst:pick-attachments", async (event) => {
    const owner = windowRef ?? BrowserWindow.getFocusedWindow();
    const options: OpenDialogOptions = {
      title: "Attach files to Xyst",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Text, PDFs, and images", extensions: ["txt", "md", "markdown", "json", "csv", "tsv", "xml", "html", "css", "js", "jsx", "ts", "tsx", "py", "rs", "go", "java", "c", "h", "cpp", "hpp", "cs", "sh", "ps1", "yaml", "yml", "toml", "ini", "log", "pdf", "png", "jpg", "jpeg", "webp"] }, { name: "All files", extensions: ["*"] }]
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (result.canceled) return [];
    if (result.filePaths.length > 10) throw new Error("Choose no more than 10 attachments at a time");
    pickedAttachments.set(event.sender.id, new Set(result.filePaths.map((path) => resolve(path))));
    event.sender.once("destroyed", () => pickedAttachments.delete(event.sender.id));
    return result.filePaths;
  });
  ipcMain.handle("xyst:invoke", async (_event, action: string, payload?: any) => {
    if (!allowedAction(action)) throw new Error(`Unsupported desktop action: ${action}`);
    if (action.startsWith("config:scoped-")) {
      const key = String(payload?.key ?? ""); const scope = String(payload?.scope ?? ""); const scopeId = String(payload?.scopeId ?? "").trim();
      if (!(scopedSettingKeys as readonly string[]).includes(key)) throw new Error("Choose a documented Xyst setting key");
      if (!(settingScopes as readonly string[]).includes(scope)) throw new Error("Choose global, project, mission, agent, or session scope");
      if (scope.length > 0 && scope !== "global" && (!scopeId.trim() || scopeId.length > 500)) throw new Error("The selected scope requires an ID of 1–500 characters");
      if (scope === "global" && scopeId) throw new Error("Global scope does not accept a scope ID");
      const scopedArgs = scope === "global" ? ["global"] : [scope, scopeId];
      if (action === "config:scoped-inspect") {
        const inspectArgs = ["config", "get", key, ...scopedArgs];
        const contextMissionId = String(payload?.contextMissionId ?? "").trim();
        if (scope === "agent" && contextMissionId) inspectArgs.push(contextMissionId);
        return invokeCli(inspectArgs);
      }
      if (action === "config:scoped-reset") return invokeCli(["config", "reset", key, ...scopedArgs]);
      if (!Object.prototype.hasOwnProperty.call(payload ?? {}, "value")) throw new Error("Enter a JSON value before saving this override");
      const value = payload.value;
      if (key === "integrations.mcp.servers") mcpServersSchema.parse(value);
      if (key === "integrations.lmStudio.nativeChat.integrations") lmStudioIntegrationsSchema.parse(value);
      return invokeCli(["config", "set", key, JSON.stringify(value), ...scopedArgs]);
    }
    if (action === "mission:list") return invokeCli(["mission", "list"]);
    if (action === "session:list") return invokeCli(["session", "list"]);
    if (action === "jobs:list") return invokeCli(["jobs", "list", "--limit", "200"]);
    if (action === "process:show") {
      const id = String(payload?.id ?? ""); if (!id) throw new Error("Process inspection requires a job ID");
      return invokeCli(["process", "show", id]);
    }
    if (action === "terminal:start") {
      const cols = Number(payload?.cols ?? 80); const rows = Number(payload?.rows ?? 24);
      if (!Number.isInteger(cols) || cols < 20 || cols > 500 || !Number.isInteger(rows) || rows < 5 || rows > 200) throw new Error("Terminal size must be 20–500 columns by 5–200 rows");
      const shell = process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/bash";
      const shellArgs = process.platform === "win32" ? ["-NoLogo"] : ["-l"];
      const result = await invokeCli(["process", "start", "--interactive", "--pty", "--cols", String(cols), "--rows", String(rows), "--cwd", selectedWorkspace, "--", shell, ...shellArgs]) as Record<string, unknown>;
      return { ...result, cwd: selectedWorkspace };
    }
    if (action === "process:start") {
      if (typeof payload?.command !== "string" || !payload.command.trim() || payload.command.length > 4096 || !Array.isArray(payload.args) || payload.args.length > 256 || !payload.args.every((arg: unknown) => typeof arg === "string" && arg.length <= 32_000)) throw new Error("Process start requires an executable and a JSON array of string arguments");
      const cwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
      if (cwd.length > 32_000) throw new Error("Process working directory is too long");
      if (payload.pty !== undefined && typeof payload.pty !== "boolean") throw new Error("Process PTY selection must be boolean");
      const pty = payload.pty === true;
      const cols = Number(payload.cols ?? 80); const rows = Number(payload.rows ?? 24);
      return invokeCli(["process", "start", ...(payload.interactive === true || pty ? ["--interactive"] : []), ...(pty ? ["--pty", "--cols", String(cols), "--rows", String(rows)] : []), ...(cwd ? ["--cwd", cwd] : []), "--", payload.command, ...payload.args]);
    }
    if (action === "process:stop") {
      const id = String(payload?.id ?? ""); if (!id) throw new Error("Process stop requires a job ID");
      return invokeCli(["process", "stop", id]);
    }
    if (action === "process:input") {
      const id = String(payload?.id ?? ""); const input = String(payload?.input ?? "");
      if (!id || input.length > 32_000) throw new Error("Process input requires a job ID and no more than 32,000 characters");
      return invokeCli(["process", "input", id, input]);
    }
    if (action === "process:end-input") {
      const id = String(payload?.id ?? ""); if (!id) throw new Error("Closing process stdin requires a job ID");
      return invokeCli(["process", "end-input", id]);
    }
    if (action === "process:resize") {
      const id = String(payload?.id ?? ""); const cols = Number(payload?.cols); const rows = Number(payload?.rows);
      if (!id || !Number.isInteger(cols) || cols < 20 || cols > 500 || !Number.isInteger(rows) || rows < 5 || rows > 200) throw new Error("Terminal resize requires a job ID and dimensions from 20×5 to 500×200");
      return invokeCli(["process", "resize", id, String(cols), String(rows)]);
    }
    if (action === "setting:updates") {
      const key = String(payload?.key ?? ""); const value = payload?.value;
      if (!["updates.enabled", "updates.autoDownload", "updates.feedUrl"].includes(key)) throw new Error("Unsupported update setting");
      if (key !== "updates.feedUrl" && typeof value !== "boolean") throw new Error("Update toggles require a boolean value");
      if (key === "updates.feedUrl" && value !== null && typeof value !== "string") throw new Error("Update feed must be an HTTPS URL or null");
      const result = value === null ? await invokeCli(["config", "reset", key, "global"]) : await invokeCli(["config", "set", key, JSON.stringify(value), "global"]);
      await configureUpdater();
      return result;
    }
    if (action === "updates:check") return checkForXystUpdate();
    if (action === "updates:download") {
      const config = await configureUpdater();
      if (!config.enabled || !config.feedUrl) throw new Error("Enable update checks and configure a feed before downloading.");
      if (updateState.status !== "available") throw new Error("There is no available Xyst update to download.");
      await updateNetworkAllowed();
      if (!activeUpdater) throw new Error("The Xyst update provider is not configured.");
      return activeUpdater.downloadUpdate();
    }
    if (action === "updates:install") {
      if (updateState.status !== "downloaded") throw new Error("No downloaded Xyst update is ready to install.");
      const installer = downloadedUpdater ?? activeUpdater;
      if (!installer) throw new Error("The Xyst update provider is not configured.");
      installer.quitAndInstall(false, true);
      return { installing: true, version: updateState.version };
    }
    if (action === "setting:inference") {
      const key = String(payload?.key ?? "");
      if (!["inference.temperature", "inference.maxTokens", "inference.requestTimeoutSeconds", "inference.topP", "inference.topK", "inference.repeatPenalty", "inference.presencePenalty", "inference.frequencyPenalty", "inference.stopSequences", "inference.reasoning"].includes(key)) throw new Error("Unsupported inference setting");
      return payload?.value === null ? invokeCli(["config", "reset", key, "global"]) : invokeCli(["config", "set", key, JSON.stringify(payload?.value), "global"]);
    }
    if (action === "setting:github") {
      const key = String(payload?.key ?? "");
      if (key === "integrations.github.apiBaseUrl") {
        const value = typeof payload?.value === "string" ? payload.value.trim() : "";
        return value ? invokeCli(["config", "set", key, JSON.stringify(value), "global"]) : invokeCli(["config", "reset", key, "global"]);
      }
      if (!["integrations.github.enabled", "integrations.github.writeEnabled", "integrations.github.mergeEnabled"].includes(key)) throw new Error("Unsupported GitHub setting");
      if (typeof payload?.enabled !== "boolean") throw new Error("GitHub settings require a boolean value");
      return invokeCli(["config", "set", key, String(payload.enabled), "global"]);
    }
    if (action === "setting:mcp") {
      if (typeof payload?.enabled !== "boolean") throw new Error("MCP enablement must be boolean");
      const servers = mcpServersSchema.parse(payload?.servers);
      await invokeCli(["config", "set", "integrations.mcp.servers", JSON.stringify(servers), "global"]);
      return invokeCli(["mcp", "enable", payload.enabled ? "on" : "off"]);
    }
    if (action === "setting:native-chat-mcp") {
      if (typeof payload?.enabled !== "boolean") throw new Error("Native chat MCP enablement must be boolean");
      const integrations = lmStudioIntegrationsSchema.parse(payload?.integrations);
      await invokeCli(["config", "set", "integrations.lmStudio.nativeChat.integrations", JSON.stringify(integrations), "global"]);
      return invokeCli(["config", "set", "integrations.lmStudio.nativeChat.enabled", String(payload.enabled), "global"]);
    }
    if (action === "setting:access-profile") {
      const profile = payload?.profile;
      if (!profile || typeof profile !== "object" || !["full", "restricted"].includes(profile.mode)) throw new Error('Access profile mode must be "full" or "restricted"');
      return invokeCli(["profile", "set", JSON.stringify(profile)]);
    }
    if (action === "setting:mission-scheduling") {
      if (typeof payload?.enabled !== "boolean") throw new Error("Mission scheduling requires a boolean value");
      return invokeCli(["config", "set", "orchestration.scheduling.enabled", String(payload.enabled), "global"]);
    }
    if (action === "setting:automatic-retries") {
      if (typeof payload?.enabled !== "boolean") throw new Error("Automatic retries requires a boolean value");
      return invokeCli(["config", "set", "orchestration.retries.enabled", String(payload.enabled), "global"]);
    }
    if (action === "setting:delegation") {
      if (typeof payload?.enabled !== "boolean") throw new Error("Agent delegation requires a boolean value");
      return invokeCli(["config", "set", "orchestration.delegation.enabled", String(payload.enabled), "global"]);
    }
    if (action === "setting:network") {
      if (typeof payload?.enabled !== "boolean") throw new Error("Network access requires a boolean value");
      return invokeCli(["config", "set", "network.enabled", String(payload.enabled), "global"]);
    }
    if (action === "setting:desktop-automation") {
      if (typeof payload?.enabled !== "boolean") throw new Error("Desktop automation setting must be a boolean");
      return invokeCli(["config", "set", "desktop.automation.enabled", String(payload.enabled), "global"]);
    }
    if (action === "setting:notifications") {
      if (typeof payload?.enabled !== "boolean") throw new Error("Desktop notifications require a boolean value");
      return invokeCli(["config", "set", "notifications.enabled", String(payload.enabled), "global"]);
    }
    if (action === "setting:external-approval") {
      if (typeof payload?.enabled !== "boolean") throw new Error("External action approval requires a boolean value");
      return invokeCli(["config", "set", "autonomy.externalActionApproval", String(payload.enabled), "global"]);
    }
    if (action === "session:show") return invokeCli(["session", "show", String(payload?.id ?? "")]);
    if (action === "session:compact") return invokeCli(["session", "compact", String(payload?.id ?? "")]);
    if (action === "session:calls") return invokeCli(["session", "calls", String(payload?.id ?? "")]);
    if (action === "session:artifacts") return invokeCli(["session", "artifacts", String(payload?.id ?? "")]);
    if (action === "session:rename") return invokeCli(["session", "rename", String(payload?.id ?? ""), String(payload?.title ?? "")]);
    if (action === "session:fork") return invokeCli(["session", "fork", String(payload?.id ?? "")]);
    if (action === "session:archive") return invokeCli(["session", "archive", String(payload?.id ?? "")]);
    if (action === "session:delete") return invokeCli(["session", "delete", String(payload?.id ?? "")]);
    if (action === "session:export") {
      const id = String(payload?.id ?? "");
      const result = await dialog.showSaveDialog({ title: "Export Xyst session", defaultPath: "xyst-session.json", filters: [{ name: "Xyst session JSON", extensions: ["json"] }] });
      if (result.canceled || !result.filePath) return { cancelled: true };
      return invokeCli(["session", "export", id, result.filePath]);
    }
    if (action === "setting:reset-global") return invokeCli(["config", "reset-all", "global"]);
    if (action === "memory:list") return invokeCli(["memory", "list"]);
    if (action === "memory:add") return invokeCli(["memory", "add", String(payload?.kind ?? "note"), String(payload?.content ?? "")]);
    if (action === "memory:edit") return invokeCli(["memory", "edit", String(payload?.id ?? ""), String(payload?.content ?? "")]);
    if (action === "memory:delete") return invokeCli(["memory", "delete", String(payload?.id ?? "")]);
    if (action === "memory:index") return invokeCli(["memory", "index", String(payload?.model ?? "")]);
    if (action === "browser:install") return invokeCli(["browser", "install"]);
    if (action === "lm:models") return invokeCli(["lm", "models"]);
    if (action === "hf:downloads") return invokeCli(["hf", "downloads"]);
    if (action === "hf:search") return invokeCli(["hf", "search", String(payload?.query ?? "")]);
    if (action === "hf:recommend") return invokeCli(["hf", "recommend", String(payload?.query ?? "")]);
    if (action === "hf:inspect") return invokeCli(["hf", "model", String(payload?.repository ?? "")]);
    if (action === "hf:download") return invokeCli(["hf", "download", String(payload?.repository ?? ""), String(payload?.quantization ?? "")]);
    if (action === "hf:status") return invokeCli(["hf", "download-status", String(payload?.id ?? "")]);
    if (action === "hf:verify-download") return invokeCli(["hf", "verify-download", String(payload?.id ?? "")]);
    if (action === "git:pick-workspace") {
      const owner = windowRef && !windowRef.isDestroyed() ? windowRef : undefined;
      const options: OpenDialogOptions = { title: "Choose a repository to inspect", properties: ["openDirectory"], buttonLabel: "Inspect repository" };
      const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      if (result.canceled || !result.filePaths[0]) return { cancelled: true };
      selectedWorkspace = resolve(result.filePaths[0]);
      return { workspace: selectedWorkspace };
    }
    if (action === "git:current-workspace") return { workspace: selectedWorkspace };
    if (action === "git:changes") {
      const staged = payload?.staged === true;
      const cwd = selectedWorkspace;
      const [status, diff, history] = await Promise.all([invokeCli(["git", "status"], undefined, undefined, cwd), invokeCli(["git", "diff", ...(staged ? ["--staged"] : [])], undefined, undefined, cwd), invokeCli(["git", "log", "20"], undefined, undefined, cwd).catch(() => "No commit history yet.")]);
      return { status: String(status ?? ""), diff: String(diff ?? ""), history: String(history ?? ""), staged, workspace: cwd };
    }
    if (action === "github:status") return invokeCli(["github", "auth", "status"]);
    if (action === "github:repos") return invokeCli(["github", "repos", ...(String(payload?.query ?? "").trim() ? [String(payload.query).trim()] : [])]);
    if (action === "github:issues" || action === "github:prs") {
      const repository = String(payload?.repository ?? "");
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Repository must use owner/repository format");
      return invokeCli(["github", action === "github:issues" ? "issues" : "prs", repository, String(payload?.state ?? "open")]);
    }
    if (action === "github:open") {
      const url = new URL(String(payload?.url ?? ""));
      if (url.protocol !== "https:" || !["github.com", "www.github.com"].includes(url.hostname)) throw new Error("Only GitHub HTTPS links can be opened");
      await shell.openExternal(url.toString()); return { opened: true };
    }
    if (action.startsWith("setting:")) {
      if (action === "setting:office-renderer") {
        const executable = typeof payload?.executable === "string" ? payload.executable.trim() : "";
        if (executable.length > 1000 || executable.includes("\0")) throw new Error("Office renderer path must be at most 1,000 characters.");
        return executable ? invokeCli(["config", "set", "documents.officeRendererExecutable", JSON.stringify(executable), "global"]) : invokeCli(["config", "reset", "documents.officeRendererExecutable", "global"]);
      }
      if (action === "setting:ocr-languages") {
        const languages = payload?.languages;
        if (!Array.isArray(languages) || languages.length < 1 || languages.length > 4 || languages.some((language: unknown) => !["eng", "fra", "deu", "spa"].includes(String(language))) || new Set(languages).size !== languages.length) throw new Error("Choose 1–4 unique OCR languages: English, French, German, or Spanish.");
        return invokeCli(["config", "set", "documents.ocrLanguages", JSON.stringify(languages), "global"]);
      }
      if (action === "setting:browser-automation") return invokeCli(["browser", payload?.enabled ? "on" : "off"]);
      if (action === "setting:browser-headless") return invokeCli(["config", "set", "browser.headless", JSON.stringify(payload?.enabled === true), "global"]);
      if (action === "setting:model-max-download") {
        const bytes = Number(payload?.bytes);
        if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 20 * 1024 ** 3) throw new Error("Model download limit must be between 1 byte and 20 GiB");
        return invokeCli(["config", "set", "models.maxDownloadBytes", JSON.stringify(bytes), "global"]);
      }
      if (action === "setting:model-license-preferences") {
        const licenses = payload?.licenses;
        if (!Array.isArray(licenses) || licenses.length > 100 || licenses.some((license: unknown) => typeof license !== "string" || !/^[a-z0-9][a-z0-9.+-]{0,99}$/.test(license)) || new Set(licenses).size !== licenses.length) throw new Error("Enter up to 100 unique lowercase Hugging Face license tags");
        return invokeCli(["config", "set", "models.allowedLicenses", JSON.stringify(licenses), "global"]);
      }
      if (action === "setting:model-default") {
        const model = String(payload?.model ?? "").trim();
        if (!model) return invokeCli(["config", "reset", "model.default", "global"]);
        if (model.length > 300 || model.includes("\0")) throw new Error("Default model key must be at most 300 characters");
        return invokeCli(["model", "default", model]);
      }
      if (action === "setting:browser-max-download") {
        const bytes = Number(payload?.bytes);
        if (!Number.isSafeInteger(bytes) || bytes < 1024 ** 2 || bytes > 10 * 1024 ** 3) throw new Error("Browser download limit must be between 1 MiB and 10 GiB");
        return invokeCli(["config", "set", "browser.maxDownloadBytes", JSON.stringify(bytes), "global"]);
      }
      if (action === "setting:memory-semantic") return payload?.enabled ? invokeCli(["memory", "semantic", "on", String(payload?.model ?? "")]) : invokeCli(["memory", "semantic", "off"]);
      if (action === "setting:local-metrics") return invokeCli(["telemetry", payload?.enabled ? "on" : "off"]);
      if (action === "setting:resource-budget") return invokeCli(["config", "set", "orchestration.memoryBudgetBytes", JSON.stringify(payload?.bytes ?? null), "global"]);
      if (action === "setting:concurrency") return invokeCli(["config", "set", "orchestration.maxConcurrency", JSON.stringify(payload?.value), "global"]);
      if (action === "setting:parallel-reads") {
        const value = Number(payload?.value);
        if (!Number.isSafeInteger(value) || value < 1 || value > 8) throw new Error("Parallel read tool calls must be between 1 and 8");
        return invokeCli(["config", "set", "tools.maxParallelReads", JSON.stringify(value), "global"]);
      }
      if (action === "setting:model-idle-unload") {
        const seconds = Number(payload?.seconds);
        if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 604800) throw new Error("Model idle unload must be between 60 and 604800 seconds");
        return invokeCli(["config", "set", "models.idleUnloadSeconds", JSON.stringify(seconds), "global"]);
      }
      if (action === "setting:model-remote-config") {
        const endpoint = String(payload?.endpoint ?? "").trim(); const model = String(payload?.model ?? "").trim();
        const url = new URL(endpoint);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || endpoint.length > 500) throw new Error("Remote fallback endpoint must be an HTTP(S) base URL without credentials, query, or fragment");
        if (!model || model.length > 300) throw new Error("Remote fallback model key must contain 1–300 characters");
        await invokeCli(["config", "set", "models.remoteFallbackUrl", JSON.stringify(endpoint), "global"]);
        return invokeCli(["config", "set", "models.remoteFallbackModel", JSON.stringify(model), "global"]);
      }
      const key = ({ "setting:model-auto": "auto", "setting:model-loading": "loading", "setting:model-unloading": "unloading", "setting:model-remote-fallback": "remote-fallback", "setting:model-discovery": "discovery", "setting:model-downloads": "downloads", "setting:model-switching": "switching" } as Record<string, string>)[action];
      if (!key) return { saved: true };
      return invokeCli(["model", key, payload?.enabled ? "on" : "off"]);
    }
    if (action.startsWith("lm:")) {
      if (action === "lm:models") return invokeCli(["lm", "models"]);
      if (action === "lm:estimate") {
        const args = ["lm", "estimate", String(payload?.model ?? "")]; const options = payload?.options ?? {};
        if (options.context_length !== undefined) args.push("--context-length", String(options.context_length));
        if (options.gpu_offload !== undefined) args.push("--gpu", String(options.gpu_offload));
        return invokeCli(args);
      }
      if (action === "lm:load") {
        const options = payload?.options ?? {};
        const args = ["lm", "load", String(payload?.model ?? "")];
        for (const [key, flag] of [["context_length", "--context-length"], ["eval_batch_size", "--eval-batch-size"], ["num_experts", "--num-experts"]] as const) {
          if (options[key] !== undefined) args.push(flag, String(options[key]));
        }
        if (options.gpu_offload !== undefined) args.push("--gpu", String(options.gpu_offload));
        if (options.ttl_seconds !== undefined) args.push("--ttl", String(options.ttl_seconds));
        if (options.speculative_draft_mtp !== undefined) args.push(options.speculative_draft_mtp ? "--speculative-draft-mtp" : "--no-speculative-draft-mtp");
        if (options.draft_model !== undefined) args.push("--speculative-draft-model", String(options.draft_model));
        for (const [key, flag] of [["speculative_draft_max_tokens", "--speculative-draft-max-tokens"], ["speculative_draft_min_tokens", "--speculative-draft-min-tokens"], ["speculative_draft_min_continue_probability", "--speculative-draft-min-continue-probability"]] as const) {
          if (options[key] !== undefined) args.push(flag, String(options[key]));
        }
        for (const [key, yesFlag, noFlag] of [["flash_attention", "--flash-attention", "--no-flash-attention"], ["offload_kv_cache_to_gpu", "--offload-kv-cache-to-gpu", "--no-offload-kv-cache-to-gpu"]] as const) {
          if (typeof options[key] === "boolean") args.push(options[key] ? yesFlag : noFlag);
        }
        if (payload?.context && options.context_length === undefined) args.push("--context-length", String(payload.context));
        return invokeCli(args);
      }
      return invokeCli(["lm", "unload", String(payload?.instanceId ?? "")]);
    }
    if (action.startsWith("mission:")) {
      const command = action.slice("mission:".length); const id = String(payload?.id ?? "");
      if (command === "templates") return invokeCli(["mission", "templates"]);
      if (command === "show") return invokeCli(["mission", "show", id]);
      if (command === "rename") {
        const name = String(payload?.name ?? "").trim(); if (!name) throw new Error("Mission name is required");
        return invokeCli(["mission", "rename", id, name]);
      }
      if (command === "fork") return invokeCli(["mission", "fork", id, ...(typeof payload?.name === "string" ? [payload.name] : [])]);
      if (command === "export") {
        const options = { title: "Export mission definition", defaultPath: `${id}.xyst-mission.json`, filters: [{ name: "Xyst mission", extensions: ["json"] }] };
        const owner = windowRef ?? BrowserWindow.getFocusedWindow();
        const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
        if (result.canceled || !result.filePath) return { cancelled: true };
        return invokeCli(["mission", "export", id, result.filePath]);
      }
      if (command === "plan") {
        const objective = String(payload?.objective ?? "").trim(); if (!objective) throw new Error("Mission objective is required");
        const args = ["mission", "plan"];
        if (payload?.name) args.push("--name", String(payload.name));
        if (payload?.workspace) args.push("--workspace", String(payload.workspace));
        if (payload?.model) args.push("--model", String(payload.model));
        if (payload?.maxConcurrency !== undefined) args.push("--max-concurrency", String(payload.maxConcurrency));
        args.push(objective); return invokeCli(args);
      }
      if (command === "task-configure") {
        const taskId = String(payload?.taskId ?? ""); if (!taskId) throw new Error("Task id is required");
        const args = ["mission", "task", "configure", id, taskId];
        if (payload?.model === null) args.push("--inherit-model"); else if (payload?.model !== undefined) args.push("--model", String(payload.model));
        if (payload?.maxTurns === null) args.push("--inherit-max-turns"); else if (payload?.maxTurns !== undefined) args.push("--max-turns", String(payload.maxTurns));
        return invokeCli(args);
      }
      if (["task-pause", "task-resume", "task-retry"].includes(command)) {
        const taskId = String(payload?.taskId ?? ""); if (!taskId) throw new Error("Task id is required");
        const report = (event: Record<string, unknown>) => {
          if (event.type === "result" && event.data && typeof event.data === "object") notifyMissionResult(event.data as Record<string, unknown>);
          else notifyRuntimeEvent(event);
        };
        return invokeCli(["mission", "task", command.slice("task-".length), id, taskId], report);
      }
      if (command === "run" || command === "resume") return invokeCli(["mission", command, id], (event) => {
        if (event.type === "result" && event.data && typeof event.data === "object") notifyMissionResult(event.data as Record<string, unknown>);
        else notifyRuntimeEvent(event);
      });
      return invokeCli(["mission", command, id]);
    }
    return undefined;
  });
  ipcMain.handle("xyst:agent-run", async (event, objective: string, attachmentPaths?: unknown, runId?: unknown) => {
    const attachments = consumePickedAttachments(event.sender.id, attachmentPaths);
    if (typeof runId !== "string" || !/^[0-9a-f-]{36}$/i.test(runId)) throw new Error("Agent run is missing its cancellation identifier");
    await invokeCli(["agent", "run", "--max-turns", "20", ...attachments.flatMap((path) => ["--attach", path]), objective], (data) => { event.sender.send("xyst:agent-event", data); notifyRuntimeEvent(data, true); }, runId);
  });
  ipcMain.handle("xyst:agent-run-cancel", (_event, runId: unknown) => {
    if (typeof runId !== "string") return { cancelled: false };
    const child = activeAgentRuns.get(runId);
    if (!child || child.exitCode !== null || child.signalCode !== null || !child.connected) return { cancelled: false };
    try { child.send({ type: "xyst:cancel" }); return { cancelled: true }; }
    catch { return { cancelled: false }; }
  });
  ipcMain.handle("xyst:agent-message", (_event, runId: unknown, content: unknown) => {
    if (typeof runId !== "string" || !/^[0-9a-f-]{36}$/i.test(runId) || typeof content !== "string" || !content.trim() || Buffer.byteLength(content, "utf8") > 64 * 1024) throw new Error("Agent message must be non-empty and at most 64 KiB");
    const child = activeAgentRuns.get(runId);
    if (!child || child.exitCode !== null || child.signalCode !== null || !child.connected) return { accepted: false };
    const pending = pendingAgentMessageResults.get(child);
    if (!pending || pending.size >= 20) return { accepted: false };
    const requestId = randomUUID();
    return new Promise<{ accepted: boolean }>((resolvePromise) => {
      const timeout = setTimeout(() => { pending.delete(requestId); resolvePromise({ accepted: false }); }, 5000);
      pending.set(requestId, (accepted) => { clearTimeout(timeout); resolvePromise({ accepted }); });
      try { child.send({ type: "xyst:user-message", requestId, content }); }
      catch { pending.delete(requestId); clearTimeout(timeout); resolvePromise({ accepted: false }); }
    });
  });
  ipcMain.handle("xyst:open-session-artifact", async (_event, sessionId: unknown, artifactId: unknown) => {
    if (typeof sessionId !== "string" || !/^[0-9a-f-]{36}$/i.test(sessionId) || typeof artifactId !== "string" || !/^[0-9a-f-]{36}$/i.test(artifactId)) throw new Error("Invalid session or artifact identifier");
    const artifacts = await invokeCli(["session", "artifacts", sessionId]);
    if (!Array.isArray(artifacts)) throw new Error("Session artifacts could not be loaded");
    const artifact = artifacts.find((entry) => entry && typeof entry === "object" && (entry as { id?: unknown }).id === artifactId) as { path?: unknown } | undefined;
    if (!artifact || typeof artifact.path !== "string" || !artifact.path.trim()) throw new Error("That file is not a registered artifact for this session");
    const error = await shell.openPath(artifact.path);
    if (error) throw new Error(`Could not open artifact: ${error}`);
    return { opened: true };
  });
  ipcMain.handle("xyst:session-resume", async (event, sessionId: string, message: string, attachmentPaths?: unknown, runId?: unknown) => {
    const attachments = consumePickedAttachments(event.sender.id, attachmentPaths);
    if (typeof runId !== "string" || !/^[0-9a-f-]{36}$/i.test(runId)) throw new Error("Agent run is missing its cancellation identifier");
    await invokeCli(["agent", "resume", sessionId, ...attachments.flatMap((path) => ["--attach", path]), message], (data) => { event.sender.send("xyst:agent-event", data); notifyRuntimeEvent(data, true); }, runId);
  });
  ipcMain.handle("xyst:mission-create", async (_event, definition: unknown) => {
    const file = join(app.getPath("temp"), `xyst-mission-${randomUUID()}.json`);
    await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(definition), "utf8");
    try { return await invokeCli(["mission", "create", file]); } finally { await rm(file, { force: true }); }
  });
  ipcMain.handle("xyst:open-external", async (_event, url: string) => {
    const parsed = new URL(url); if (parsed.protocol !== "https:") throw new Error("Only HTTPS links can be opened"); await shell.openExternal(url);
  });
}

async function createWindow() {
  windowRef = new BrowserWindow({
    width: 1440, height: 940, minWidth: 1080, minHeight: 720,
    backgroundColor: "#0a1012", title: "Xyst Control Room",
    icon: join(here, "..", "resources", process.platform === "win32" ? "xyst-icon.ico" : "xyst-icon.png"),
    webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  windowRef.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: "deny" }; });
  if (!app.isPackaged) await windowRef.loadURL(process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:5173");
  else await windowRef.loadFile(join(here, "renderer", "index.html"));
  windowRef.on("closed", () => { windowRef = undefined; });
}

async function checkUpdatesOnStartup(): Promise<void> {
  if (!app.isPackaged || !(["win32", "linux"] as string[]).includes(process.platform)) return;
  const enabled = await configuredValue("updates.enabled").catch(() => undefined);
  const feed = await configuredValue("updates.feedUrl").catch(() => undefined);
  if (enabled?.value !== true || typeof feed?.value !== "string" || !feed.value) return;
  const timer = setTimeout(() => { void checkForXystUpdate().catch((error) => setUpdateState({ status: "error", error: error instanceof Error ? error.message.slice(0, 800) : String(error).slice(0, 800) })); }, 3000);
  timer.unref();
}

app.whenReady().then(async () => { await mkdir(projectRoot, { recursive: true }); registerIpc(); await createWindow(); void checkUpdatesOnStartup(); app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); }); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
