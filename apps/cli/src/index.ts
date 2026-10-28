#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { open, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { totalmem } from "node:os";
import { spawn } from "node:child_process";
import * as nodePty from "node-pty";
import { authenticateMcpOAuth, chooseEmbeddingModel, createMcpTools, createRuntime, createText, deletePath, getDataDirectory, getSessionCompactionModel, inspectDatabaseIntegrity, McpOAuthClientProvider, resolveLMStudioIntegrations, gitBranches, gitClone, gitCommit, gitCreateBranch, gitDiff, gitFetch, gitLog, gitPush, gitStage, gitStatus, indexMemories, inspectDesktopCapabilities, inspectLmsDaemon, listFiles, mcpServersSchema, movePath, patchText, readModelPerformance, readText, requestEmbeddings, runProcess, runShell, searchFiles, sendNativeNotification, subscribeRunNotifications, type ExternalActionApprovalRequest, type RemoteFallbackApprovalRequest } from "@xyst/runtime";
import { parseLoadOptions } from "./load-options.js";
import { agentOutcomeNotice } from "./agent-outcome.js";
import { parseChatOptions } from "./chat-options.js";
import { parseResponsesRequest } from "./responses-options.js";
import { installMissionService, missionServiceStatus, uninstallMissionService, type MissionServiceSpec } from "./mission-service.js";
import { getMissionTemplate, MISSION_TEMPLATES } from "./mission-templates.js";
import { MISSION_PLAN_USAGE, parseMissionPlanArguments } from "./mission-plan-options.js";
import { createAgentUserMessage } from "./attachments.js";
import { desktopModelSnapshot } from "./desktop-model-snapshot.js";
import { closeWebhookServer, parseGitHubWebhookOptions, startGitHubWebhookServer } from "./webhook-server.js";

const args = process.argv.slice(2);
const separatorIndex = args.indexOf("--");
const jsonIndex = args.findIndex((arg, index) => arg === "--json" && (separatorIndex < 0 || index < separatorIndex));
const json = jsonIndex >= 0;
const clean = args.filter((_arg, index) => index !== jsonIndex);
const rootHelpRequested = clean.length === 0 || clean[0] === "help" || clean[0] === "--help" || clean[0] === "-h";
let agentHelpRequested = false;
if (clean[0] === "agent" && ["run", "resume", "chat"].includes(clean[1] ?? "")) {
  let optionIndex = 2;
  if (clean[1] === "resume" && clean[optionIndex] && !clean[optionIndex]!.startsWith("-")) optionIndex++;
  for (; optionIndex < clean.length; optionIndex++) {
    const option = clean[optionIndex]!;
    if (option === "--help" || option === "-h") { agentHelpRequested = true; break; }
    if (optionIndex === 2 && clean[1] === "chat" && !option.startsWith("-")) continue;
    if (!option.startsWith("-")) break;
    if (["--model", "--max-turns", "--attach", "--session"].includes(option)) optionIndex++;
  }
}
if (rootHelpRequested || agentHelpRequested) {
  help();
  await new Promise<void>((flushed) => process.stdout.write("", () => flushed()));
  process.exit(0);
}
const controller = new AbortController();
let activeUserMessages: string[] | undefined;
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
process.on("message", (message) => {
  if (message && typeof message === "object" && (message as { type?: unknown }).type === "xyst:cancel") controller.abort();
  if (message && typeof message === "object" && (message as { type?: unknown }).type === "xyst:user-message") {
    const value = message as { requestId?: unknown; content?: unknown };
    const content = value.content;
    const accepted = Boolean(activeUserMessages && typeof content === "string" && content.trim() && Buffer.byteLength(content, "utf8") <= 64 * 1024 && activeUserMessages.length < 20);
    if (accepted) activeUserMessages!.push(content as string);
    if (process.send && typeof value.requestId === "string") process.send({ type: "xyst:user-message-result", requestId: value.requestId, accepted });
  }
});
if (clean[0] === "database" && clean[1] === "check") {
  const report = inspectDatabaseIntegrity(resolve(getDataDirectory(), "xyst.sqlite"));
  output(report);
  process.exitCode = report.status === "healthy" ? 0 : 1;
  await new Promise<void>((flushed) => process.stdout.write("", () => flushed()));
  process.exit();
}
const statusIntegrity = clean[0] === "status" || (clean[0] === "desktop" && clean[1] === "snapshot")
  ? inspectDatabaseIntegrity(resolve(getDataDirectory(), "xyst.sqlite"))
  : undefined;
if (statusIntegrity?.status === "corrupt") {
  const dataDir = getDataDirectory();
  const message = "Xyst couldn't open its local database. Run `xyst database check` for a read-only integrity report, then restore from a known-good backup if needed.";
  const status = {
    version: "0.1.0", runtime: "unavailable", dataDir, database: "corrupt",
    databaseIntegrity: statusIntegrity, error: message,
    errorDetails: statusIntegrity.error ?? statusIntegrity.details?.join("; ") ?? "SQLite reported corruption"
  };
  if (clean[0] === "desktop") output({ status, sessions: [], memories: [], missions: [], agents: [], jobs: [], models: [], downloads: [] });
  else output(status);
  process.exitCode = clean[0] === "status" ? 1 : 0;
  await new Promise<void>((flushed) => process.stdout.write("", () => flushed()));
  process.exit();
}
const runtime = createRuntime();
const lm = runtime.lmStudio;
if (process.env.XYST_DESKTOP_PARENT !== "1") subscribeRunNotifications(runtime.events, (event) => {
  const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
  const missionId = typeof payload.missionId === "string" ? payload.missionId : undefined;
  if (!missionId) return runtime.config.resolve<boolean>("notifications.enabled")?.value === true;
  const mission = runtime.missions.repository.get(missionId);
  const projectId = typeof mission?.definition.projectId === "string" ? mission.definition.projectId : undefined;
  return runtime.config.resolve<boolean>("notifications.enabled", { ...(projectId ? { project: projectId } : {}), mission: missionId })?.value === true;
}, sendNativeNotification);

function releaseWindowsPtyWorker(terminal: nodePty.IPty): void {
  if (process.platform !== "win32") return;
  // node-pty 1.x has no public dispose method; its ConPTY output worker otherwise
  // keeps detached process workers alive after the shell exits naturally.
  const internal = terminal as unknown as { _agent?: { _conoutSocketWorker?: { dispose?: () => void } } };
  internal._agent?._conoutSocketWorker?.dispose?.();
}

async function openAuthorizationUrl(url: URL): Promise<boolean> {
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const executable = process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const spawnArgs = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url.toString()] : [url.toString()];
  return new Promise((resolve) => {
    const child = spawn(executable, spawnArgs, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", () => resolve(false)); child.once("spawn", () => { child.unref(); resolve(true); });
  });
}

async function readSecret(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    process.stdin.setEncoding("utf8"); process.stdin.resume();
    return new Promise((resolve) => { let secret = ""; process.stdin.on("data", (chunk: string) => { secret += chunk; }); process.stdin.once("end", () => resolve(secret.replace(/[\r\n]+$/, ""))); });
  }
  process.stdout.write("Token (input hidden): "); process.stdin.setRawMode(true); process.stdin.setEncoding("utf8"); process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const restore = () => { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.removeListener("data", onData); process.stdout.write("\n"); };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\u0003") { restore(); reject(new Error("Cancelled")); return; }
        if (char === "\r" || char === "\n") { restore(); resolve(value); return; }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1); else value += char;
      }
    };
    process.stdin.on("data", onData);
  });
}

function output(value: unknown): void {
  if (json) process.stdout.write(`${JSON.stringify({ type: "result", at: new Date().toISOString(), data: value })}\n`);
  else if (typeof value === "string") process.stdout.write(`${value}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
async function approveExternalAction(request: ExternalActionApprovalRequest): Promise<boolean> {
  if (process.stdin.isTTY) {
    process.stderr.write(`\nXyst requests approval for ${request.toolName}${request.missionId ? ` in mission ${request.missionId}` : ""}.\n${request.argumentsJson}\n`);
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    try { return (await prompt.question("Approve this action once? [y/N] ", { signal: controller.signal })).trim().toLowerCase() === "y"; }
    finally { prompt.close(); }
  }
  if (!json || process.stdin.destroyed) return false;
  const requestId = randomUUID();
  process.stdout.write(`${JSON.stringify({ type: "approval_request", requestId, sessionId: request.sessionId, toolName: request.toolName, missionId: request.missionId, argumentsJson: request.argumentsJson })}\n`);
  process.stdin.setEncoding("utf8"); process.stdin.resume();
  return new Promise<boolean>((resolve) => {
    let buffered = ""; let settled = false;
    const finish = (approved: boolean) => {
      if (settled) return; settled = true;
      process.stdin.removeListener("data", onData); process.stdin.removeListener("end", onEnd); controller.signal.removeEventListener("abort", onAbort); process.stdin.pause(); resolve(approved);
    };
    const onEnd = () => finish(false);
    const onAbort = () => finish(false);
    const onData = (chunk: string) => {
      buffered += chunk;
      let at: number;
      while ((at = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, at).trim(); buffered = buffered.slice(at + 1);
        try {
          const response = JSON.parse(line) as { type?: string; requestId?: string; approved?: boolean };
          if (response.type === "approval_response" && response.requestId === requestId) { finish(response.approved === true); return; }
        } catch { /* Ignore unrelated input lines until the approval response arrives. */ }
      }
    };
    process.stdin.on("data", onData); process.stdin.once("end", onEnd); controller.signal.addEventListener("abort", onAbort, { once: true });
  });
}
async function approveRemoteFallback(request: RemoteFallbackApprovalRequest): Promise<boolean> {
  const disclosure = `Local inference failed (${request.reason}). Approve sending the full conversation, task objective, applicable project instructions, attached content, and tool results to remote LM Studio model ${request.model} at ${request.endpoint}?`;
  if (process.stdin.isTTY) {
    process.stderr.write(`\nREMOTE INFERENCE CONSENT REQUIRED\n${disclosure}\n`);
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    try { return (await prompt.question("Send this run's context to the remote provider once? [y/N] ", { signal: controller.signal })).trim().toLowerCase() === "y"; }
    finally { prompt.close(); }
  }
  if (!json || process.stdin.destroyed) return false;
  const requestId = randomUUID();
  process.stdout.write(`${JSON.stringify({ type: "remote_fallback_request", requestId, sessionId: request.sessionId, model: request.model, endpoint: request.endpoint, reason: request.reason, disclosure })}\n`);
  process.stdin.setEncoding("utf8"); process.stdin.resume();
  return new Promise<boolean>((resolve) => {
    let buffered = ""; let settled = false;
    const finish = (approved: boolean) => { if (settled) return; settled = true; process.stdin.removeListener("data", onData); process.stdin.removeListener("end", onEnd); controller.signal.removeEventListener("abort", onAbort); process.stdin.pause(); resolve(approved); };
    const onEnd = () => finish(false);
    const onAbort = () => finish(false);
    const onData = (chunk: string) => { buffered += chunk; let at: number; while ((at = buffered.indexOf("\n")) >= 0) { const line = buffered.slice(0, at).trim(); buffered = buffered.slice(at + 1); try { const value = JSON.parse(line) as { type?: string; requestId?: string; approved?: boolean }; if (value.type === "approval_response" && value.requestId === requestId) { finish(value.approved === true); return; } } catch { /* Ignore unrelated input lines. */ } } };
    process.stdin.on("data", onData); process.stdin.once("end", onEnd); controller.signal.addEventListener("abort", onAbort, { once: true });
  });
}
function fail(message: string): never { process.stderr.write(`${message}\n`); process.exitCode = 1; throw new Error(message); }
function help(): void {
  output(`Xyst ${process.env.npm_package_version ?? "0.1.0"} — shared runtime CLI

Usage: xyst [--json] <command>
  status                         Show runtime and storage status
  session list|new|show|summary|compact|calls|artifacts|rename|fork|export|archive|delete ... Manage saved sessions
  memory list|search|add|edit|delete ...  Inspect and manage saved memory
  memory semantic on [embedding-model]|off  Configure semantic memory search
  memory index [embedding-model]       Index saved memories with LM Studio
  config get <key> [project-id]  Resolve a global/project setting and show its source
  config get <key> <scope> <id> [mission-id]  Resolve effective scoped settings and show their source
  config set <key> <json> [scope] [scope-id]
  config reset <key> [scope] [scope-id]  Restore inherited or runtime default
  config reset-all [scope] [scope-id]    Clear settings overrides in one scope
  file read <path> [start] [end] Read a file or line range
  file list <path> [--recursive] List directory entries
  file search <path> <text>      Search text files
  file create <path> <text>      Create a file without overwriting
  file patch <path> <hash> <old> <new>  Apply a stale-read checked patch
  file move|delete ...           Move or delete a path
  run <executable> [args...]     Execute a program directly (no shell)
  shell <script>                 Execute explicitly through system shell
  lm diagnose|models             Check LM Studio and list local models
  lm daemon-status               Distinguish headless llmster from the desktop server
  lm stats [model-key]           Show local inference and verified task outcomes
  lm resources                   Measure host RAM and detected NVIDIA VRAM
  lm load <model> [options]      Load with context, TTL, eval batch, Flash Attention, expert, KV cache, GPU, or draft settings
  lm estimate <model> [options]  Estimate local load resources without loading the model
  lm unload <instance-id>        Unload a model instance
  lm ask|stream <model> [--temperature N] [--top-p N] [--top-k N] [--min-p N] [--repeat-penalty N] [--reasoning MODE] [--max-output-tokens N] [--context-length N] [--stateful] [--previous-response-id ID] [--integration-file integrations.json] <prompt>
  lm responses <request.json> [--stream]  Use LM Studio's OpenAI-compatible Responses API; MCP headers use credential_headers references
                                Reasoning can also be set in scoped inference settings for native chat
  lm count-tokens <model> <text> Count tokens using a loaded model
  lm tokenize <model> <text>     Return loaded-model token IDs (max 1 MB input)
  lm json <model> <schema.json> <prompt>  Request schema-constrained JSON output
  credential set|delete <service> <name>  Store or remove a credential in the OS vault
  profile show|set <json>       Inspect or set the explicit access profile
  model default <model-key>     Set the default local model
  model auto on|off             Toggle automatic local model selection
  telemetry on|off|status       Enable local-only inference performance measurements
  browser status|on|off|install  Control persistent Chromium browser automation
  desktop status                Inspect desktop-session and UI automation capabilities
  desktop snapshot              Read the complete desktop dashboard state in one runtime call
  desktop automation on|off|status  Enable optional native application automation
  database check                Read-only SQLite integrity check (also works when runtime startup fails)
  model loading|unloading|discovery|downloads|switching|remote-fallback on|off
  model idle-unload <seconds>       Set the automatic idle-unload TTL (60–604800 seconds)
  hf auth set|delete|status     Configure optional Hugging Face access
  hf search <query> | recommend <task-or-capability> | model|card|files <owner/name> | download <owner/name> [quantization]
  hf download-status <job-id>
  hf verify-download <job-id>  Load when safe and run a small inference check
  hf downloads                  List saved model download jobs
  jobs list [--limit 1-200]     Inspect mission-trigger, mission-run, and model-download jobs
  jobs show <job-id>            Show one saved job and its details
  process start [--interactive] [--pty] [--cols N --rows N] [--cwd PATH] -- <executable> [args...]  Start a process job
  process list [--limit 1-200]  List saved jobs (including processes)
  process show <job-id>         Show process output and state
  process input <job-id> <text> Send stdin text to an interactive process
  process end-input <job-id>    Close an interactive process stdin stream
  process resize <job-id> <columns> <rows> Resize a PTY process
  process stop <job-id>         Request process-tree cancellation
  agent run [--model key] [--max-turns 1-50] [--attach path]... <objective>
  agent resume <session-id> [--model key] [--max-turns 1-50] [--attach path]... <message>
  agent chat [--session id] [--model key] [--max-turns 1-50] [--attach path]...  Start an interactive saved chat; enter /compact or /exit
  agent list [mission-id]
  agent reconcile <session-id> <tool-call-id> completed|retry
  mission plan <objective> [--name NAME] [--workspace PATH] [--project ID] [--model KEY] [--max-concurrency 1-8]
  mission create <definition.json> | list | show <id> | rename <id> <name> | fork <id> [name] | export <id> [path] | delete <id> | workspaces [id]
  mission templates | template <template-id>  List or load an executable workflow definition
  mission task configure <mission-id> <task-id> [--model <key>|--inherit-model] [--max-turns <1-50>|--inherit-max-turns]
  mission task pause|resume|retry <mission-id> <task-id>
  mission worktree remove <id> <run-id> <task-id> [--force]
  mission reconcile <mission-id> <run-id> <task-id> <tool-call-id> completed|retry
  mission run|pause|cancel|resume|archive <id> | daemon [--webhook] [--webhook-host HOST] [--webhook-port PORT] [--webhook-path PATH]
  mission service install [--webhook] [--webhook-host HOST] [--webhook-port PORT] [--webhook-path PATH] | uninstall|status
  git status|diff|log|branches
  git branch <name> | add <path...> | commit -m <message> -- <path...>
  git clone <https-or-ssh-or-file-url> <destination> | fetch [remote] [branch] | push [remote] [branch]
  github enabled|writes on|off
  github auth set|delete|status
  github repos [search-query] | issues|prs <owner/repo> [state]
  github issue <owner/repo> <number> | checks <owner/repo> <ref>
  github labels <owner/repo> <issue> | label-add|label-replace <owner/repo> <issue> <comma-separated-labels|-> | label-remove <owner/repo> <issue> <label>
  github workflow-runs <owner/repo> [branch] | workflow-logs <owner/repo> <run-id>
  github releases|artifacts <owner/repo>
  github download-release <owner/repo> <asset-id> <new-path> | download-artifact <owner/repo> <artifact-id> <new-path>
  github pr-diff|review-comments <owner/repo> <number>
  github pr-create <owner/repo> <head> <base> <title> <body>
  github pr-update <owner/repo> <number> <title|body|base|state> <value>
  github review-comment <owner/repo> <number> <commit-sha> <path> <line> <body>
  github review-reply <owner/repo> <number> <comment-id> <body>
  mcp enable on|off             Enable or disable configured MCP servers for agent tasks
  mcp list                      List MCP server IDs and transports
  mcp set <servers.json>        Configure validated MCP server definitions
  mcp discover [server-id]      Connect and list advertised tools, resources, and prompts
  mcp auth login|status|logout <server-id>  Manage a server's OS-vault OAuth authorization
  help                           Show this help`);
}

try {
  const [command, subcommand, ...rest] = clean;
  if (!command || command === "help" || command === "--help" || command === "-h") { help(); }
  else if (command === "credential" && subcommand === "set") {
    const [service, name] = rest; if (!service || !name) fail("Usage: credential set <service> <name> (reads the secret from stdin or hidden terminal input)");
    await runtime.credentials.set(service, name, await readSecret()); output({ service, name, stored: true });
  } else if (command === "credential" && subcommand === "delete") {
    const [service, name] = rest; if (!service || !name) fail("Usage: credential delete <service> <name>"); output({ service, name, deleted: await runtime.credentials.delete(service, name) });
  } else if (command === "profile" && subcommand === "show") output(runtime.access.profile);
  else if (command === "profile" && subcommand === "set") {
    if (!rest[0]) fail("Usage: profile set <json>");
    const profile = JSON.parse(rest.join(" "));
    if (profile?.mode !== "full" && profile?.mode !== "restricted") fail('Access profile mode must be "full" or "restricted"');
    runtime.config.set("global", "access.profile", profile); output({ saved: profile, applies: "next CLI invocation" });
  } else if (command === "model" && subcommand === "default") {
    if (!rest[0]) fail("Usage: model default <model-key>"); runtime.access.assertCapability("network");
    const model = (await lm.models(controller.signal)).find((entry) => entry.key === rest[0]);
    if (!model || model.type !== "llm") fail(`LLM model not found in local LM Studio inventory: ${rest[0]}`);
    runtime.config.set("global", "model.default", rest[0]); output({ key: rest[0], default: true });
  } else if (command === "model" && subcommand === "auto") {
    if (rest[0] !== "on" && rest[0] !== "off") fail("Usage: model auto on|off");
    runtime.config.set("global", "model.autoSelect", rest[0] === "on"); output({ automaticSelection: rest[0] === "on" });
  } else if (command === "model" && subcommand === "idle-unload") {
    const seconds = Number(rest[0]);
    if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 604800) fail("Usage: model idle-unload <seconds> (60–604800)");
    runtime.config.set("global", "models.idleUnloadSeconds", seconds); output({ setting: "models.idleUnloadSeconds", seconds, applies: "next agent run" });
  } else if (command === "model" && ["loading", "unloading", "discovery", "downloads", "switching", "remote-fallback"].includes(subcommand ?? "")) {
    if (rest[0] !== "on" && rest[0] !== "off") fail(`Usage: model ${subcommand} on|off`);
    const key = ({ loading: "models.automaticLoading", unloading: "models.automaticUnloading", discovery: "models.onlineDiscovery", downloads: "models.automaticDownloads", switching: "models.automaticSwitching", "remote-fallback": "models.remoteFallback" } as Record<string, string>)[subcommand!]!;
    runtime.config.set("global", key, rest[0] === "on"); output({ setting: key, enabled: rest[0] === "on", applies: "immediately" });
  } else if (command === "hf" && subcommand === "auth") {
    runtime.access.assertCapability("network");
    if (rest[0] === "set") { await runtime.credentials.set("huggingface", "access-token", await readSecret()); output({ authenticated: "credential stored" }); }
    else if (rest[0] === "delete") output({ deleted: await runtime.credentials.delete("huggingface", "access-token") });
    else if (rest[0] === "status") output({ configured: Boolean(await runtime.credentials.get("huggingface", "access-token")) });
    else fail("Usage: hf auth set|delete|status");
  } else if (command === "hf") {
    if (subcommand !== "downloads" && subcommand !== "verify-download") runtime.access.assertCapability("network");
    if (subcommand === "download" || subcommand === "verify-download") runtime.access.assertCapability("externalActions");
    if (subcommand === "downloads") output(runtime.modelAcquisition.listDownloads());
    else if (subcommand === "search") {
      const query = rest.join(" "); if (!query) fail("Usage: hf search <query>"); output(await runtime.modelAcquisition.search(query, controller.signal));
    } else if (subcommand === "recommend") {
      const query = rest.join(" "); if (!query) fail("Usage: hf recommend <task-or-capability>"); output(await runtime.modelAcquisition.recommend(query, controller.signal));
    } else if (["model", "files", "card"].includes(subcommand ?? "")) {
      if (!rest[0]) fail(`Usage: hf ${subcommand} <owner/name>`);
      if (subcommand === "card") output(await runtime.modelAcquisition.card(rest[0], controller.signal));
      else { const details = await runtime.modelAcquisition.model(rest[0], controller.signal); output(subcommand === "files" ? details.files : details); }
    } else if (subcommand === "download") {
      if (!rest[0]) fail("Usage: hf download <owner/name> [quantization]"); output(await runtime.modelAcquisition.download(rest[0], rest[1], controller.signal));
    } else if (subcommand === "download-status") {
      if (!rest[0]) fail("Usage: hf download-status <job-id>"); output(await runtime.modelAcquisition.status(rest[0], controller.signal));
    } else if (subcommand === "verify-download") {
      if (!rest[0]) fail("Usage: hf verify-download <job-id>");
      runtime.access.assertCapability("externalActions");
      output(await runtime.modelAcquisition.verify(rest[0], controller.signal));
    } else fail("Invalid Hugging Face command. Run `xyst help` for syntax.");
  } else if (command === "agent" && subcommand === "list") {
    const missionId = rest[0];
    output(missionId
      ? runtime.store.db.prepare("SELECT id,mission_id,definition_json,status,created_at,updated_at FROM agents WHERE mission_id=? ORDER BY updated_at DESC").all(missionId)
      : runtime.store.db.prepare("SELECT id,mission_id,definition_json,status,created_at,updated_at FROM agents ORDER BY updated_at DESC LIMIT 200").all());
  } else if (command === "jobs" && subcommand === "list") {
    const limitIndex = rest.indexOf("--limit");
    const rawLimit = limitIndex >= 0 ? rest[limitIndex + 1] : undefined;
    if (limitIndex >= 0 && (!rawLimit || !/^\d+$/.test(rawLimit))) fail("Usage: jobs list [--limit 1-200]");
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (limit < 1 || limit > 200) fail("Job list limit must be from 1 to 200");
    output(runtime.jobs.list(limit));
  } else if (command === "jobs" && subcommand === "show") {
    if (!rest[0]) fail("Usage: jobs show <job-id>");
    const job = runtime.jobs.show(rest[0]);
    if (!job) fail(`No saved job found with ID ${rest[0]}`);
    output(job);
  } else if (command === "process" && subcommand === "start") {
    runtime.access.assertCapability("backgroundJobs"); runtime.access.assertCapability("externalActions");
    let cwd = process.cwd(); let interactive = false; let pty = false; let cols = 80; let rows = 24; let separator = rest.indexOf("--");
    for (let i = 0; i < (separator < 0 ? rest.length : separator); i++) {
      if (rest[i] === "--cwd") { const value = rest[++i]; if (!value) fail("--cwd requires a directory"); cwd = resolve(value); }
      else if (rest[i] === "--interactive") interactive = true;
      else if (rest[i] === "--pty") { pty = true; interactive = true; }
      else if (rest[i] === "--cols") { cols = Number(rest[++i]); if (!Number.isInteger(cols) || cols < 20 || cols > 500) fail("--cols must be an integer from 20 to 500"); }
      else if (rest[i] === "--rows") { rows = Number(rest[++i]); if (!Number.isInteger(rows) || rows < 5 || rows > 200) fail("--rows must be an integer from 5 to 200"); }
      else fail("Usage: process start [--interactive] [--pty] [--cols N --rows N] [--cwd PATH] -- <executable> [args...]");
    }
    separator = rest.indexOf("--");
    if (separator < 0 || !rest[separator + 1]) fail("Usage: process start [--cwd PATH] -- <executable> [args...]");
    const executable = rest[separator + 1]!; const processArgs = rest.slice(separator + 2);
    runtime.access.assertExecutable(executable); await runtime.access.assertPath(cwd, "read");
    const id = runtime.jobs.createProcess(executable, processArgs, cwd, interactive, pty, cols, rows);
    try {
      const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "--internal-process-worker", id], { cwd: process.cwd(), env: process.env, detached: true, windowsHide: true, stdio: "ignore" });
      await new Promise<void>((resolveSpawn, rejectSpawn) => { child.once("spawn", resolveSpawn); child.once("error", rejectSpawn); });
      child.unref(); output({ id, kind: "process", state: "queued" });
    } catch (error) {
      runtime.jobs.updateProcess(id, "failed", { error: runtime.lmStudio.redact(error instanceof Error ? error.message : String(error)) });
      throw error;
    }
  } else if (command === "process" && subcommand === "list") {
    const limitIndex = rest.indexOf("--limit"); const rawLimit = limitIndex >= 0 ? rest[limitIndex + 1] : undefined;
    if (limitIndex >= 0 && (!rawLimit || !/^\d+$/.test(rawLimit))) fail("Usage: process list [--limit 1-200]");
    const limit = rawLimit === undefined ? 50 : Number(rawLimit); if (limit < 1 || limit > 200) fail("Process list limit must be from 1 to 200");
    output(runtime.jobs.list(limit).filter((job) => job.kind === "process"));
  } else if (command === "process" && subcommand === "show") {
    if (!rest[0]) fail("Usage: process show <job-id>"); const job = runtime.jobs.show(rest[0]);
    if (!job || job.kind !== "process") fail(`No process job found with ID ${rest[0]}`); output(job);
  } else if (command === "process" && subcommand === "stop") {
    if (!rest[0]) fail("Usage: process stop <job-id>"); runtime.access.assertCapability("backgroundJobs");
    const requested = runtime.jobs.requestProcessCancel(rest[0]);
    if (!runtime.jobs.show(rest[0]) || runtime.jobs.show(rest[0])?.kind !== "process") fail(`No process job found with ID ${rest[0]}`);
    output({ id: rest[0], cancellationRequested: requested, state: runtime.jobs.show(rest[0])?.state });
  } else if (command === "process" && subcommand === "input") {
    if (!rest[0] || rest.length < 2) fail("Usage: process input <job-id> <text>"); runtime.access.assertCapability("backgroundJobs");
    runtime.jobs.sendProcessInput(rest[0], rest.slice(1).join(" ")); output({ id: rest[0], inputQueued: true });
  } else if (command === "process" && subcommand === "end-input") {
    if (!rest[0]) fail("Usage: process end-input <job-id>"); runtime.access.assertCapability("backgroundJobs");
    runtime.jobs.sendProcessInput(rest[0], "", true); output({ id: rest[0], stdinClosed: true });
  } else if (command === "process" && subcommand === "resize") {
    if (rest.length !== 3) fail("Usage: process resize <job-id> <columns> <rows>"); runtime.access.assertCapability("backgroundJobs");
    const cols = Number(rest[1]); const rows = Number(rest[2]);
    if (!Number.isInteger(cols) || cols < 20 || cols > 500 || !Number.isInteger(rows) || rows < 5 || rows > 200) fail("Terminal size must be 20–500 columns by 5–200 rows");
    runtime.jobs.resizeProcess(rest[0]!, cols, rows); output({ id: rest[0], cols, rows, resizeQueued: true });
  } else if (command === "--internal-process-worker") {
    const id = subcommand; if (!id) fail("Missing internal process job ID");
    const spec = runtime.jobs.processSpec(id); if (!spec) fail(`Process job specification missing: ${id}`);
    runtime.jobs.updateProcess(id, "running", { startedAt: new Date().toISOString() });
    const workerController = new AbortController(); let stdout = ""; let stderr = ""; let outputTruncated = false;
    const append = (key: "stdout" | "stderr", chunk: string) => {
      const cleanChunk = runtime.lmStudio.redact(chunk); const current = key === "stdout" ? stdout : stderr;
      const next = current + cleanChunk;
      if (next.length > 100_000) outputTruncated = true;
      const bounded = next.slice(-100_000);
      if (key === "stdout") stdout = bounded; else stderr = bounded;
      runtime.jobs.updateProcess(id, "running", { stdout, stderr, outputTruncated });
    };
    let writeStdin: ((value: string) => void) | undefined; let closeStdin: (() => void) | undefined;
    let terminalSession: nodePty.IPty | undefined;
    const poll = setInterval(() => {
      if (runtime.jobs.processCancelRequested(id)) { workerController.abort(); return; }
      const writer = writeStdin;
      if (spec.interactive && writer) for (const entry of runtime.jobs.takeProcessInputs(id)) { if (entry.input) writer(entry.input); if (entry.closeStdin) { const close = closeStdin; if (close) close(); writeStdin = undefined; closeStdin = undefined; } }
      if (spec.pty && terminalSession) { const size = runtime.jobs.takeProcessResize(id); if (size) terminalSession.resize(size.cols, size.rows); }
    }, 200);
    process.once("SIGTERM", () => workerController.abort()); process.once("SIGINT", () => workerController.abort());
    try {
      const startedAt = Date.now();
      let result: { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; durationMs: number };
      if (spec.pty) {
        terminalSession = nodePty.spawn(spec.command, spec.args, { name: "xterm-256color", cols: spec.cols, rows: spec.rows, cwd: spec.cwd, env: process.env, ...(process.platform === "win32" ? { useConpty: true } : { encoding: "utf8" }) });
        if (workerController.signal.aborted) terminalSession.kill(); else workerController.signal.addEventListener("abort", () => terminalSession?.kill(), { once: true });
        writeStdin = (value) => terminalSession?.write(value);
        closeStdin = () => terminalSession?.write("\u0004");
        terminalSession.onData((chunk) => append("stdout", chunk));
        const exit = await new Promise<{ exitCode: number; signal?: number }>((resolveExit) => terminalSession!.onExit(resolveExit));
        result = { code: exit.exitCode, signal: null, stdout, stderr, durationMs: Date.now() - startedAt };
        releaseWindowsPtyWorker(terminalSession);
        terminalSession = undefined;
      } else {
        const processResult = await runProcess(spec.command, spec.args, { cwd: spec.cwd, signal: workerController.signal, maxOutputChars: 100_000, stdin: spec.interactive, onStdinWriter: (write, close) => { writeStdin = write; closeStdin = close; }, onStdout: (chunk) => append("stdout", chunk), onStderr: (chunk) => append("stderr", chunk) });
        result = processResult;
      }
      runtime.jobs.updateProcess(id, workerController.signal.aborted ? "cancelled" : "completed", { stdout: runtime.lmStudio.redact(result.stdout), stderr: runtime.lmStudio.redact(result.stderr), outputTruncated, exitCode: result.code, signal: result.signal, durationMs: result.durationMs, finishedAt: new Date().toISOString() });
    } catch (error) {
      const cancelled = workerController.signal.aborted;
      runtime.jobs.updateProcess(id, cancelled ? "cancelled" : "failed", { stdout, stderr, outputTruncated, error: runtime.lmStudio.redact(error instanceof Error ? error.message : String(error)), finishedAt: new Date().toISOString() });
    } finally { clearInterval(poll); if (terminalSession) releaseWindowsPtyWorker(terminalSession); }
  } else if (command === "agent" && subcommand === "reconcile") {
    const [sessionId, toolCallId, resolution] = rest;
    if (!sessionId || !toolCallId || !["completed", "retry"].includes(resolution ?? "")) fail("Usage: agent reconcile <session-id> <tool-call-id> completed|retry");
    output(runtime.agent.reconcileExternalAction(sessionId, toolCallId, resolution as "completed" | "retry"));
  } else if (command === "agent" && subcommand === "chat") {
    if (!process.stdin.isTTY) fail("agent chat requires an interactive terminal");
    let sessionId: string | undefined;
    let model: string | undefined;
    let maxTurns = 20;
    const attachmentPaths: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!;
      if (arg === "--session") { sessionId = rest[++i]; if (!sessionId) fail("--session requires a session ID"); }
      else if (arg === "--model") { model = rest[++i]; if (!model) fail("--model requires a model key"); }
      else if (arg === "--max-turns") { maxTurns = Number(rest[++i]); if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 50) fail("--max-turns must be between 1 and 50"); }
      else if (arg === "--attach") { const path = rest[++i]; if (!path || path.startsWith("--")) fail("--attach requires a file path"); attachmentPaths.push(path); }
      else fail(`Unknown agent chat option: ${arg}`);
    }
    const readableAttachments = await Promise.all(attachmentPaths.map(async (path) => runtime.access.assertPath(resolve(path), "read")));
    let firstMessage = true;
    let lastStatus: string | undefined;
    const unsub = runtime.events.on("*", (event) => { if (json) process.stdout.write(`${JSON.stringify(event)}\n`); });
    try {
      if (!json) process.stdout.write(`Xyst chat${sessionId ? ` · session ${sessionId}` : ""}. Enter /compact to save a resumable summary or /exit to leave.\n`);
      while (!controller.signal.aborted) {
        const prompt = createInterface({ input: process.stdin, output: process.stdout, terminal: !json });
        let message: string;
        try { message = (await prompt.question(json ? "" : "you> ", { signal: controller.signal })).trimEnd(); }
        catch (error) { if (controller.signal.aborted) break; throw error; }
        finally { prompt.close(); }
        if (!message.trim()) continue;
        if (["/exit", "/quit"].includes(message.trim().toLowerCase())) break;
        if (/^\/compact(?:\s|$)/i.test(message.trim())) {
          if (!sessionId) { if (!json) process.stderr.write("Start a conversation before compacting it.\n"); else output({ type: "session.compaction.skipped", reason: "no-session" }); continue; }
          const preferred = message.trim().split(/\s+/).slice(1)[0] ?? model ?? runtime.config.resolve<string>("model.default", { session: sessionId })?.value;
          const selected = await getSessionCompactionModel(runtime.lmStudio, preferred);
          const result = await runtime.sessionCompactor.compact(sessionId, selected.model, controller.signal);
          const record = { ...result, model: selected.model, modelReason: selected.reason };
          if (json) output({ type: "session.compacted", ...record });
          else process.stdout.write(`Compacted ${String(result.compactedMessages)} completed messages with ${selected.model}; ${String(result.retainedMessages)} recent messages remain in the active context. Full history is preserved.\n`);
          continue;
        }
        if (!json) process.stdout.write("Xyst> ");
        const initialMessage = firstMessage && readableAttachments.length ? await createAgentUserMessage(message, readableAttachments, runtime.config.resolve<string[]>("documents.ocrLanguages", sessionId ? { session: sessionId } : {})?.value ?? ["eng"]) : undefined;
        const result = await runtime.agent.run(message, {
          ...(sessionId ? { sessionId } : {}), ...(model ? { model } : {}), ...(initialMessage ? { initialMessage } : {}), maxTurns,
          signal: controller.signal, onSession: (id) => { const isNewSession = sessionId !== id; sessionId = id; if (isNewSession) { if (json) process.stdout.write(`${JSON.stringify({ type: "agent.session", sessionId: id })}\n`); else process.stderr.write(`\nSession ${id}\n`); } },
          onText: (text) => { if (!json) process.stdout.write(text); }, approveExternalAction, approveRemoteFallback
        });
        firstMessage = false;
        lastStatus = result.status;
        if (!json) process.stdout.write("\n");
        else process.stdout.write(`${JSON.stringify({ type: "agent.turn.complete", sessionId: result.sessionId, model: result.model, turns: result.turns, status: result.status })}\n`);
        if (!json) {
          const notice = agentOutcomeNotice(result.status, result.sessionId);
          if (notice) process.stderr.write(`${notice}\n`);
        }
        if (result.status === "cancelled") { process.exitCode = 130; break; }
      }
      if (!controller.signal.aborted && lastStatus === "limit") process.exitCode = 2;
      else if (!controller.signal.aborted && lastStatus === "unverified") process.exitCode = 3;
    } finally { unsub(); }
  } else if (command === "agent" && (subcommand === "run" || subcommand === "resume")) {
    let sessionId: string | undefined;
    let model: string | undefined;
    let maxTurns = 20;
    const attachmentPaths: string[] = [];
    const taskParts: string[] = [];
    let i = 0;
    if (subcommand === "resume") { sessionId = rest[0]; i = 1; if (!sessionId) fail("Usage: agent resume <session-id> <message>"); }
    while (i < rest.length) {
      const arg = rest[i]!;
      if (arg === "--model") { model = rest[++i]; if (!model) fail("--model requires a model key"); }
      else if (arg === "--max-turns") { maxTurns = Number(rest[++i]); if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 50) fail("--max-turns must be between 1 and 50"); }
      else if (arg === "--attach") { const path = rest[++i]; if (!path || path.startsWith("--")) fail("--attach requires a file path"); attachmentPaths.push(path); }
      else taskParts.push(arg);
      i++;
    }
    const objective = taskParts.join(" "); if (subcommand === "run" && !objective) fail("Usage: agent run [--model key] <objective>");
    if (subcommand === "resume" && !objective) fail("Usage: agent resume <session-id> <message>");
    const readableAttachments = await Promise.all(attachmentPaths.map(async (path) => runtime.access.assertPath(resolve(path), "read")));
    const initialMessage = await createAgentUserMessage(objective, readableAttachments, runtime.config.resolve<string[]>("documents.ocrLanguages", sessionId ? { session: sessionId } : {})?.value ?? ["eng"]);
    activeUserMessages = [];
    const unsub = runtime.events.on("*", (event) => { if (json) process.stdout.write(`${JSON.stringify(event)}\n`); });
    try {
      const result = await runtime.agent.run(objective, { ...(sessionId ? { sessionId } : {}), ...(model ? { model } : {}), initialMessage, maxTurns, signal: controller.signal, drainUserMessages: () => { const messages = activeUserMessages ?? []; activeUserMessages = []; return messages; }, onRunClosing: () => { activeUserMessages = undefined; }, onText: (text) => { if (!json) process.stdout.write(text); }, approveExternalAction, approveRemoteFallback });
      if (!json) {
        process.stdout.write("\n");
        const notice = agentOutcomeNotice(result.status, result.sessionId);
        if (notice) process.stderr.write(`${notice}\n`);
      } else output({ sessionId: result.sessionId, model: result.model, turns: result.turns, status: result.status });
      if (result.status === "cancelled") process.exitCode = 130;
      else if (result.status === "limit") process.exitCode = 2;
      else if (result.status === "unverified") process.exitCode = 3;
    } finally { activeUserMessages = undefined; unsub(); }
  } else if (command === "telemetry") {
    if (subcommand === "status") output(runtime.config.resolve<boolean>("telemetry.localMetrics") ?? { key: "telemetry.localMetrics", configured: false, value: true, source: "runtime default" });
    else if (subcommand === "on" || subcommand === "off") { runtime.config.set("global", "telemetry.localMetrics", subcommand === "on"); output({ key: "telemetry.localMetrics", enabled: subcommand === "on", scope: "global", applies: "next inference call" }); }
    else fail("Usage: telemetry on|off|status");
  } else if (command === "browser") {
    if (subcommand === "status") {
      const [setting, browser] = await Promise.all([runtime.config.resolve<boolean>("browser.automation.enabled"), runtime.browser.status()]);
      const headlessSetting = runtime.config.resolve<boolean>("browser.headless");
      const downloadLimitSetting = runtime.config.resolve<number>("browser.maxDownloadBytes");
      output({ enabled: setting?.value ?? false, source: setting?.source ?? "runtime default", browser, headless: headlessSetting?.value ?? true, headlessSource: headlessSetting?.source ?? "runtime default", maxDownloadBytes: downloadLimitSetting?.value ?? 512 * 1024 ** 2, maxDownloadBytesSource: downloadLimitSetting?.source ?? "runtime default" });
    } else if (subcommand === "on" || subcommand === "off") {
      runtime.config.set("global", "browser.automation.enabled", subcommand === "on");
      output({ key: "browser.automation.enabled", enabled: subcommand === "on", scope: "global", applies: "next agent run" });
    } else if (subcommand === "install") {
      const result = await runtime.browser.install(controller.signal, (chunk, stream) => (stream === "stdout" ? process.stdout : process.stderr).write(chunk));
      const status = await runtime.browser.status();
      if (!status.installed) fail("Playwright reported installation complete, but its Chromium executable is missing");
      output({ installed: status.installed, browser: status.engine, executablePath: status.executablePath, durationMs: result.durationMs });
    } else fail("Usage: browser status|on|off|install");
  } else if (command === "desktop" && subcommand === "status") {
    const setting = runtime.config.resolve<boolean>("desktop.automation.enabled");
    output({ ...inspectDesktopCapabilities(), automation: { enabled: setting?.value === true, source: setting?.source ?? "runtime default" } });
  } else if (command === "desktop" && subcommand === "snapshot") {
    const settingKeys = [
      "model.default", "model.autoSelect", "models.automaticLoading", "models.automaticUnloading", "models.idleUnloadSeconds", "models.maxDownloadBytes", "models.allowedLicenses",
      "models.remoteFallback", "models.remoteFallbackUrl", "models.remoteFallbackModel", "models.onlineDiscovery",
      "models.automaticDownloads", "models.automaticSwitching", "telemetry.localMetrics", "memory.semantic.enabled",
      "memory.embeddingModel", "orchestration.maxConcurrency", "tools.maxParallelReads", "orchestration.memoryBudgetBytes",
      "orchestration.scheduling.enabled", "orchestration.retries.enabled", "orchestration.delegation.enabled",
      "autonomy.externalActionApproval", "network.enabled", "notifications.enabled", "access.profile",
      "integrations.github.enabled", "integrations.github.writeEnabled", "integrations.github.mergeEnabled",
      "integrations.github.apiBaseUrl", "integrations.mcp.enabled", "integrations.mcp.servers",
      "integrations.lmStudio.nativeChat.enabled", "integrations.lmStudio.nativeChat.integrations",
      "inference.temperature", "inference.maxTokens", "inference.requestTimeoutSeconds", "inference.topP", "inference.topK",
      "inference.repeatPenalty", "inference.presencePenalty", "inference.frequencyPenalty",
      "inference.stopSequences", "inference.reasoning", "browser.automation.enabled", "browser.headless",
      "browser.maxDownloadBytes", "desktop.automation.enabled", "updates.enabled", "updates.autoDownload",
      "updates.feedUrl", "documents.ocrLanguages", "documents.officeRendererExecutable"
    ] as const;
    const settings = Object.fromEntries(settingKeys.map((key) => [key, runtime.config.resolve(key) ?? { key, configured: false }]));
    const [modelsResult, browserResult, systemResourcesResult] = await Promise.all([
      lm.models(controller.signal).then((models) => ({ models: models.map(desktopModelSnapshot) })).catch((error) => ({ models: [] as Array<Record<string, unknown>>, modelsError: error instanceof Error ? error.message : String(error) })),
      Promise.all([runtime.browser.status(), Promise.resolve(settings["browser.automation.enabled"]), Promise.resolve(settings["browser.headless"]), Promise.resolve(settings["browser.maxDownloadBytes"])]).then(([browser, enabled, headless, maxDownloadBytes]) => ({ browser, enabled, headless, maxDownloadBytes })).catch(() => ({})),
      runtime.resourceStats().catch((error) => ({ error: error instanceof Error ? error.message : String(error) }))
    ]);
    const sessions = runtime.sessions.list();
    const missions = runtime.missions.repository.list();
    const agentRows = runtime.store.db.prepare("SELECT id,mission_id,definition_json,status,created_at,updated_at FROM agents ORDER BY updated_at DESC LIMIT 200").all() as Array<Record<string, unknown>>;
    const agents = agentRows.map((agent) => ({ ...agent, definition: typeof agent.definition_json === "string" ? JSON.parse(agent.definition_json) : agent.definition_json }));
    const browserSetting = browserResult as { browser?: unknown; enabled?: { value?: unknown; source?: string }; headless?: { value?: unknown; source?: string }; maxDownloadBytes?: { value?: unknown; source?: string } };
    const configured = (key: typeof settingKeys[number]) => settings[key] as { value?: unknown; configured?: boolean; source?: string };
    const settingValue = (key: typeof settingKeys[number], defaultValue = false) => { const item = configured(key); return { value: item.configured === false || item.value === undefined ? defaultValue : item.value === true, source: item.source ?? "runtime default" }; };
    const scalarSetting = (key: typeof settingKeys[number], defaultValue: unknown) => { const item = configured(key); return { value: item.configured === false || item.value === undefined ? defaultValue : item.value, source: item.source ?? "runtime default" }; };
    const embedding = configured("memory.embeddingModel");
    const modelPerformance = readModelPerformance(runtime.store);
    const models = modelsResult.models.map((model) => ({ ...model, performance: modelPerformance[model.key as string] }));
    const modelsError = "modelsError" in modelsResult ? modelsResult.modelsError : undefined;
    const browser = browserSetting.browser ?? { installed: false };
    const status = { version: "0.1.0", runtime: "ready", dataDir: runtime.dataDir, database: "ready", databaseIntegrity: statusIntegrity?.status === "healthy" ? statusIntegrity : inspectDatabaseIntegrity(resolve(runtime.dataDir, "xyst.sqlite")), sessions: sessions.length, missions: missions.length, profile: runtime.access.profile.mode };
    output({ status, systemResources: systemResourcesResult, browser, sessions, missions, agents, memories: runtime.memories.list(), models, downloads: runtime.modelAcquisition.listDownloads(), jobs: runtime.jobs.list(50), ...(modelsError ? { modelsError } : {}), settings: {
      accessProfile: scalarSetting("access.profile", { mode: "full", network: true, integrations: true, backgroundJobs: true, externalActions: true }),
      githubEnabled: settingValue("integrations.github.enabled"), githubWrites: settingValue("integrations.github.writeEnabled"), githubMerge: settingValue("integrations.github.mergeEnabled"), githubApiBaseUrl: scalarSetting("integrations.github.apiBaseUrl", ""),
      mcpEnabled: settingValue("integrations.mcp.enabled"), mcpServers: scalarSetting("integrations.mcp.servers", []), nativeChatMcpEnabled: settingValue("integrations.lmStudio.nativeChat.enabled"), nativeChatMcpIntegrations: scalarSetting("integrations.lmStudio.nativeChat.integrations", []),
      defaultModel: scalarSetting("model.default", ""), autoSelect: settingValue("model.autoSelect", true), automaticLoading: settingValue("models.automaticLoading", true), automaticUnloading: settingValue("models.automaticUnloading"), idleUnloadSeconds: scalarSetting("models.idleUnloadSeconds", 3600), modelMaxDownloadBytes: scalarSetting("models.maxDownloadBytes", 20 * 1024 ** 3), modelAllowedLicenses: scalarSetting("models.allowedLicenses", []), remoteFallback: settingValue("models.remoteFallback"), remoteFallbackUrl: scalarSetting("models.remoteFallbackUrl", ""), remoteFallbackModel: scalarSetting("models.remoteFallbackModel", ""), discovery: settingValue("models.onlineDiscovery"), downloads: settingValue("models.automaticDownloads"), switching: settingValue("models.automaticSwitching"), localMetrics: settingValue("telemetry.localMetrics", true),
      browserAutomation: { value: browserSetting.enabled?.value ?? false, source: browserSetting.enabled?.source ?? "runtime default" }, browserHeadless: { value: browserSetting.headless?.value ?? true, source: browserSetting.headless?.source ?? "runtime default" }, browserMaxDownloadBytes: { value: browserSetting.maxDownloadBytes?.value ?? 512 * 1024 ** 2, source: browserSetting.maxDownloadBytes?.source ?? "runtime default" },
      memorySemantic: settingValue("memory.semantic.enabled"), maxConcurrency: scalarSetting("orchestration.maxConcurrency", 8), maxParallelReads: scalarSetting("tools.maxParallelReads", 4), memoryBudgetBytes: scalarSetting("orchestration.memoryBudgetBytes", null), missionScheduling: settingValue("orchestration.scheduling.enabled", true), automaticRetries: settingValue("orchestration.retries.enabled", true), delegationEnabled: settingValue("orchestration.delegation.enabled", true), externalActionApproval: settingValue("autonomy.externalActionApproval"), networkEnabled: settingValue("network.enabled", true), notificationsEnabled: settingValue("notifications.enabled"), desktopAutomation: scalarSetting("desktop.automation.enabled", false),
      updatesEnabled: settingValue("updates.enabled"), updatesAutomaticDownload: settingValue("updates.autoDownload"), updatesFeedUrl: scalarSetting("updates.feedUrl", ""), ocrLanguages: scalarSetting("documents.ocrLanguages", ["eng"]), officeRendererExecutable: scalarSetting("documents.officeRendererExecutable", ""), maxMemoryBytes: totalmem(),
      embeddingModel: { value: embedding.configured === false ? "" : embedding.value ?? "", source: embedding.source ?? "not configured" },
      inference: { temperature: scalarSetting("inference.temperature", null), maxTokens: scalarSetting("inference.maxTokens", null), requestTimeoutSeconds: scalarSetting("inference.requestTimeoutSeconds", 600), topP: scalarSetting("inference.topP", null), topK: scalarSetting("inference.topK", null), repeatPenalty: scalarSetting("inference.repeatPenalty", null), presencePenalty: scalarSetting("inference.presencePenalty", null), frequencyPenalty: scalarSetting("inference.frequencyPenalty", null), stopSequences: scalarSetting("inference.stopSequences", null), reasoning: scalarSetting("inference.reasoning", null) }
    } });
  } else if (command === "desktop" && subcommand === "automation") {
    const action = rest[0];
    if (action === "status") {
      const setting = runtime.config.resolve<boolean>("desktop.automation.enabled");
      output({ enabled: setting?.value === true, source: setting?.source ?? "runtime default", capabilities: inspectDesktopCapabilities().nativeApplicationAutomation });
    } else if (action === "on" || action === "off") {
      runtime.config.set("global", "desktop.automation.enabled", action === "on");
      output({ key: "desktop.automation.enabled", enabled: action === "on", scope: "global", applies: "next agent run", capabilities: inspectDesktopCapabilities().nativeApplicationAutomation });
    } else fail("Usage: desktop automation on|off|status");
  } else if (command === "lm" && subcommand === "daemon-status") { output(await inspectLmsDaemon(runtime.access, controller.signal)); }
  else if (command === "lm" && subcommand === "diagnose") { runtime.access.assertCapability("network"); output(await lm.diagnose()); }
  else if (command === "lm" && subcommand === "stats") {
    const stats = readModelPerformance(runtime.store);
    output(rest[0] ? { model: rest[0], ...(stats[rest[0]] ?? { samples: 0, successes: 0, successRate: null, medianLatencyMs: null, tokensPerSecond: null, taskSamples: 0, taskSuccesses: 0, taskSuccessRate: null }) } : Object.entries(stats).map(([model, values]) => ({ model, ...values })));
  }
  else if (command === "lm" && subcommand === "resources") {
    output(await runtime.resourceStats());
  }
  else if (command === "lm" && subcommand === "models") {
    runtime.access.assertCapability("network");
    const models = await lm.models(controller.signal);
    output(models.map((model) => ({ key: model.key, name: model.display_name, type: model.type, sizeBytes: model.size_bytes, quantization: model.quantization?.name, maxContext: model.max_context_length, capabilities: model.capabilities, loaded: model.loaded_instances })));
  } else if (command === "lm" && subcommand === "load") {
    runtime.access.assertCapability("network");
    if (!rest[0]) fail("Usage: lm load <model> [--context-length N] [--eval-batch-size N] [--flash-attention|--no-flash-attention] [--num-experts N] [--offload-kv-cache-to-gpu|--no-offload-kv-cache-to-gpu]");
    const loadOptions = parseLoadOptions(rest.slice(1));
    const usesLmCli = loadOptions.gpu_offload !== undefined || loadOptions.ttl_seconds !== undefined || loadOptions.speculative_draft_mtp !== undefined || loadOptions.draft_model !== undefined ||
      loadOptions.speculative_draft_max_tokens !== undefined || loadOptions.speculative_draft_min_tokens !== undefined || loadOptions.speculative_draft_min_continue_probability !== undefined;
    if (usesLmCli) {
      const command = process.env.LM_STUDIO_CLI_PATH ?? (process.platform === "win32" ? "lms.exe" : "lms");
      runtime.access.assertCapability("externalActions");
      runtime.access.assertExecutable(command);
    }
    output(await lm.load(rest[0], loadOptions, controller.signal));
  } else if (command === "lm" && subcommand === "estimate") {
    runtime.access.assertCapability("network");
    if (!rest[0]) fail("Usage: lm estimate <model> [--context-length N] [--gpu auto|off|max|RATIO]");
    const options = parseLoadOptions(rest.slice(1));
    const extra = Object.keys(options).filter((key) => !["echo_load_config", "context_length", "gpu_offload"].includes(key));
    if (extra.length) fail("Resource estimates support only context length and GPU placement options");
    const cliCommand = process.env.LM_STUDIO_CLI_PATH ?? (process.platform === "win32" ? "lms.exe" : "lms");
    runtime.access.assertExecutable(cliCommand);
    output(await lm.estimateLoad(rest[0], { ...(options.context_length !== undefined ? { context_length: options.context_length } : {}), ...(options.gpu_offload !== undefined ? { gpu_offload: options.gpu_offload } : {}) }, controller.signal));
  } else if (command === "lm" && subcommand === "unload") {
    runtime.access.assertCapability("network");
    if (!rest[0]) fail("Usage: lm unload <instance-id>"); output(await lm.unload(rest[0], controller.signal));
  } else if (command === "lm" && (subcommand === "count-tokens" || subcommand === "tokenize")) {
    runtime.access.assertCapability("network");
    if (!rest[0] || rest.length < 2) fail(`Usage: lm ${subcommand} <model> <text>`);
    output(await lm.tokenize(rest[0], rest.slice(1).join(" "), { includeTokenIds: subcommand === "tokenize", signal: controller.signal }));
  } else if (command === "lm" && subcommand === "json") {
    runtime.access.assertCapability("network");
    if (!rest[0] || !rest[1] || rest[2] === undefined) fail("Usage: lm json <model> <schema.json> <prompt>");
    const schema = JSON.parse(await readFile(rest[1], "utf8")) as Record<string, unknown>;
    if (!schema || typeof schema !== "object" || schema.type !== "object") fail("Schema file must contain a JSON Schema object with type: object");
    output(await lm.structuredOutput({ model: rest[0], messages: [{ role: "user", content: rest.slice(2).join(" ") }], schema }, controller.signal));
  } else if (command === "lm" && subcommand === "responses") {
    runtime.access.assertCapability("network");
    const positional = rest.filter((arg) => !arg.startsWith("--"));
    const requestFile = positional[0];
    if (positional.length !== 1 || !requestFile || rest.filter((arg) => arg === "--stream").length > 1 || rest.some((arg) => arg.startsWith("--") && arg !== "--stream")) fail("Usage: lm responses <request.json> [--stream]");
    const requestPath = await runtime.access.assertPath(requestFile, "read");
    const requestStats = await stat(requestPath);
    if (!requestStats.isFile() || requestStats.size > 1_000_000) fail("Responses request file must be a regular file at most 1 MB");
    const responsesRequest = parseResponsesRequest(JSON.parse(await readFile(requestPath, "utf8")) as unknown);
    const requestTools = responsesRequest.tools ?? [];
    const mcpTools = requestTools.filter((tool) => tool.type === "mcp");
    let resolvedMcpTools: Array<Record<string, unknown>> = [];
    if (mcpTools.length) {
      runtime.access.assertCapability("integrations"); runtime.access.assertCapability("externalActions");
      if (runtime.config.resolve<boolean>("autonomy.externalActionApproval")?.value === true) fail("LM Studio MCP tools execute inside the LM Studio server and cannot use Xyst's per-tool approval flow. Disable external-action approval only if you authorize this direct integration request.");
      const integrationsToResolve = mcpTools.map((tool) => {
        if ("headers" in tool) fail("MCP headers must use credential_headers references, not raw values");
        const { type: _type, credential_headers, ...integration } = tool;
        return { type: "ephemeral_mcp", ...integration, ...(credential_headers === undefined ? {} : { credential_headers }) };
      });
      const resolved = await resolveLMStudioIntegrations(integrationsToResolve, runtime.credentials);
      lm.rememberSecretValues(resolved.secrets);
      resolvedMcpTools = resolved.integrations.map((integration) => {
        if (typeof integration === "string") fail("Responses API MCP tools require remote ephemeral server definitions");
        if (integration.type === "plugin") fail("Responses API MCP tools require remote ephemeral server definitions");
        const { type: _type, ...server } = integration;
        return { type: "mcp", ...server };
      });
    }
    let mcpIndex = 0;
    const normalizedTools = requestTools.map((tool) => tool.type === "mcp" ? resolvedMcpTools[mcpIndex++]! : tool);
    const { tools: _tools, ...requestFields } = responsesRequest;
    const request = { ...requestFields, ...(requestTools.length ? { tools: normalizedTools } : {}) };
    if (rest.includes("--stream")) {
      for await (const event of lm.streamResponses(request as Parameters<typeof lm.streamResponses>[0], controller.signal)) {
        if (json) process.stdout.write(`${JSON.stringify({ type: "lm_studio", at: new Date().toISOString(), data: event })}\n`);
        else if (event.type === "response.output_text.delta") process.stdout.write(String(event.delta ?? ""));
        if (event.type === "response.incomplete") { if (!json) process.stderr.write("LM Studio ended the response with incomplete status.\n"); process.exitCode = 2; }
      }
      if (!json) process.stdout.write("\n");
    } else {
      const result = await lm.responses(request as Parameters<typeof lm.responses>[0], controller.signal);
      output(result);
      if (result.status === "incomplete" || result.status === "failed") process.exitCode = 2;
    }
  } else if (command === "lm" && (subcommand === "ask" || subcommand === "stream")) {
    runtime.access.assertCapability("network");
    if (!rest[0]) fail(`Usage: lm ${subcommand} <model> [--stateful] [--previous-response-id ID] <prompt>`);
    const parsedChatOptions = parseChatOptions(rest.slice(1), rest[0]);
    const { integrationFile, ...chatOptions } = parsedChatOptions;
    let nativeIntegrations: Awaited<ReturnType<typeof resolveLMStudioIntegrations>> | undefined;
    if (integrationFile) {
      runtime.access.assertCapability("integrations"); runtime.access.assertCapability("network"); runtime.access.assertCapability("externalActions");
      if (runtime.config.resolve<boolean>("autonomy.externalActionApproval")?.value === true) fail("Native LM Studio MCP tools execute inside the LM Studio server and cannot use Xyst's per-tool approval flow. Disable external-action approval only if you authorize this direct integration request.");
      const integrationPath = await runtime.access.assertPath(integrationFile, "read");
      if ((await stat(integrationPath)).size > 64 * 1024) fail("LM Studio integration configuration must be at most 64 KiB");
      const rawIntegrations = JSON.parse(await readFile(integrationPath, "utf8")) as unknown;
      nativeIntegrations = await resolveLMStudioIntegrations(rawIntegrations, runtime.credentials);
      lm.rememberSecretValues(nativeIntegrations.secrets);
    } else if (runtime.config.resolve<boolean>("integrations.lmStudio.nativeChat.enabled")?.value === true) {
      runtime.access.assertCapability("integrations"); runtime.access.assertCapability("network"); runtime.access.assertCapability("externalActions");
      if (runtime.config.resolve<boolean>("autonomy.externalActionApproval")?.value === true) fail("Native LM Studio MCP tools execute inside the LM Studio server and cannot use Xyst's per-tool approval flow. Disable external-action approval only if you authorize this direct integration request.");
      const definitions = runtime.config.resolve<unknown>("integrations.lmStudio.nativeChat.integrations")?.value ?? [];
      nativeIntegrations = await resolveLMStudioIntegrations(definitions, runtime.credentials);
      lm.rememberSecretValues(nativeIntegrations.secrets);
    }
    const options = {
      ...(runtime.config.resolve<number>("inference.temperature")?.value !== undefined ? { temperature: runtime.config.resolve<number>("inference.temperature")!.value } : {}),
      ...(runtime.config.resolve<number>("inference.maxTokens")?.value !== undefined ? { max_output_tokens: runtime.config.resolve<number>("inference.maxTokens")!.value } : {}),
      ...(runtime.config.resolve<number>("inference.topP")?.value !== undefined ? { top_p: runtime.config.resolve<number>("inference.topP")!.value } : {}),
      ...(runtime.config.resolve<number>("inference.topK")?.value !== undefined ? { top_k: runtime.config.resolve<number>("inference.topK")!.value } : {}),
      ...(runtime.config.resolve<number>("inference.repeatPenalty")?.value !== undefined ? { repeat_penalty: runtime.config.resolve<number>("inference.repeatPenalty")!.value } : {}),
      ...(runtime.config.resolve<string>("inference.reasoning")?.value !== undefined ? { reasoning: runtime.config.resolve<"off" | "low" | "medium" | "high" | "on">("inference.reasoning")!.value } : {}),
      ...chatOptions,
      ...(nativeIntegrations ? { integrations: nativeIntegrations.integrations } : {})
    };
    if (subcommand === "ask") output(await lm.chat(options, controller.signal));
    else {
      for await (const event of lm.streamChat(options, controller.signal)) {
        if (json) process.stdout.write(`${JSON.stringify({ type: "lm_studio", at: new Date().toISOString(), data: event })}\n`);
        else if (event.type === "message.delta" || event.type === "reasoning.delta") process.stdout.write(String(event.content ?? ""));
        else if (event.type === "tool_call.start") process.stderr.write(`\n[LM Studio MCP] Calling ${String(event.tool ?? "tool")}\n`);
        else if (event.type === "tool_call.success") process.stderr.write(`[LM Studio MCP] Completed ${String(event.tool ?? "tool")}\n`);
        else if (event.type === "tool_call.failure") process.stderr.write(`[LM Studio MCP] Tool call failed: ${String(event.reason ?? "unknown error")}\n`);
      }
      if (!json) process.stdout.write("\n");
    }
  }
  else if (command === "status") {
    output({ version: "0.1.0", runtime: "ready", dataDir: runtime.dataDir, database: "ready", databaseIntegrity: statusIntegrity?.status === "healthy" ? statusIntegrity : inspectDatabaseIntegrity(resolve(runtime.dataDir, "xyst.sqlite")), sessions: runtime.sessions.list().length, missions: runtime.missions.repository.list().length, profile: runtime.access.profile.mode });
  }
  else if (command === "mission") {
    if (subcommand === "plan") {
      let planArgs: ReturnType<typeof parseMissionPlanArguments>;
      try { planArgs = parseMissionPlanArguments(rest); } catch (error) { fail(error instanceof Error ? error.message : MISSION_PLAN_USAGE); }
      const { objective, ...planOptions } = planArgs!;
      output(await runtime.missionPlanner.plan(objective, { ...planOptions, signal: controller.signal }));
    } else if (subcommand === "create") {
      if (!rest[0]) fail("Usage: mission create <definition.json>");
      output(runtime.missions.repository.create(JSON.parse(await readFile(rest[0], "utf8"))));
    } else if (subcommand === "rename") {
      const [id, ...name] = rest; if (!id || !name.length) fail("Usage: mission rename <id> <name>");
      const mission = runtime.missions.repository.rename(id, name.join(" ")); output({ id, name: mission.definition.name, renamed: true });
    } else if (subcommand === "fork") {
      if (!rest[0]) fail("Usage: mission fork <id> [name]");
      const mission = runtime.missions.repository.fork(rest[0], rest.slice(1).join(" ") || undefined); output({ id: mission.id, sourceId: rest[0], name: mission.definition.name, forked: true });
    } else if (subcommand === "export") {
      if (!rest[0]) fail("Usage: mission export <id> [path]");
      const definition = runtime.missions.repository.exportDefinition(rest[0]); const serialized = `${JSON.stringify(definition, null, 2)}\n`;
      if (rest[1]) { const destination = await runtime.access.assertPath(resolve(rest[1]), "write"); await writeFile(destination, serialized, { flag: "wx" }); output({ id: rest[0], path: destination, exported: true }); }
      else output(definition);
    } else if (subcommand === "delete") {
      if (!rest[0]) fail("Usage: mission delete <id>"); runtime.missions.repository.delete(rest[0]); output({ id: rest[0], deleted: true });
    } else if (subcommand === "templates") {
      output(MISSION_TEMPLATES.map(({ id, name, description }) => ({ id, name, description })));
    } else if (subcommand === "template") {
      if (!rest[0]) fail("Usage: mission template <template-id>");
      output(getMissionTemplate(rest[0]));
    } else if (subcommand === "task" && ["pause", "resume", "retry"].includes(rest[0] ?? "")) {
      const taskAction = rest[0]!; const missionId = rest[1]; const taskId = rest[2];
      if (!missionId || !taskId || rest.length !== 3) fail(`Usage: mission task ${taskAction} <mission-id> <task-id>`);
      if (taskAction === "pause") output(runtime.missions.pauseTask(missionId, taskId));
      else output(await (taskAction === "retry" ? runtime.missions.retryTask(missionId, taskId, approveExternalAction) : runtime.missions.resumeTask(missionId, taskId, approveExternalAction)));
    } else if (subcommand === "task" && rest[0] === "configure") {
      const missionId = rest[1]; const taskId = rest[2];
      if (!missionId || !taskId) fail("Usage: mission task configure <mission-id> <task-id> [--model <key>|--inherit-model] [--max-turns <1-50>|--inherit-max-turns]");
      const controls: { model?: string | null; maxTurns?: number | null } = {};
      for (let index = 3; index < rest.length; index++) {
        const flag = rest[index];
        if (flag === "--model" || flag === "--max-turns") {
          const value = rest[++index]; if (value === undefined) fail(`${flag} requires a value`);
          if (flag === "--model") controls.model = value;
          else controls.maxTurns = Number(value);
        } else if (flag === "--inherit-model") controls.model = null;
        else if (flag === "--inherit-max-turns") controls.maxTurns = null;
        else fail(`Unknown mission task option: ${flag}`);
      }
      if (controls.model === undefined && controls.maxTurns === undefined) fail("Set a model or turn limit, or select an inherit option");
      output(runtime.missions.repository.updateTaskControls(missionId, taskId, controls));
    } else if (subcommand === "list") output(runtime.missions.repository.list());
    else if (subcommand === "show") {
      if (!rest[0]) fail("Usage: mission show <id>");
      const mission = runtime.missions.repository.get(rest[0]); if (!mission) fail(`Mission not found: ${rest[0]}`);
      const runs = runtime.store.db.prepare("SELECT * FROM mission_runs WHERE mission_id=? ORDER BY started_at DESC LIMIT 20").all(rest[0]);
      const tasks = runtime.store.db.prepare("SELECT * FROM mission_tasks WHERE mission_id=? ORDER BY updated_at DESC LIMIT 100").all(rest[0]);
      const agents = runtime.store.db.prepare("SELECT * FROM agents WHERE mission_id=? ORDER BY updated_at DESC LIMIT 100").all(rest[0]);
      const externalActions = runtime.store.db.prepare(`SELECT r.id AS run_id,t.task_key,t.session_id,tc.id,tc.name,tc.input_json,tc.output_json,tc.status,tc.created_at
        FROM mission_tasks t JOIN mission_runs r ON r.id=t.run_id JOIN tool_calls tc ON tc.session_id=t.session_id
        WHERE t.mission_id=? AND tc.effect='external' ORDER BY tc.created_at DESC LIMIT 200`).all(rest[0]);
      output({ ...mission, runs, tasks, agents, externalActions, workspaces: runtime.missions.listWorkspaces(rest[0]) });
    } else if (subcommand === "workspaces") {
      output(runtime.missions.listWorkspaces(rest[0]));
    } else if (subcommand === "worktree" && rest[0] === "remove") {
      const [missionId, runId, taskId] = rest.slice(1);
      if (!missionId || !runId || !taskId) fail("Usage: mission worktree remove <mission-id> <run-id> <task-id> [--force]");
      output(await runtime.missions.removeWorktree(missionId, runId, taskId, rest.includes("--force")));
    } else if (subcommand === "reconcile") {
      const [missionId, runId, taskId, toolCallId, resolution] = rest;
      if (!missionId || !runId || !taskId || !toolCallId || !["completed", "retry"].includes(resolution ?? "")) fail("Usage: mission reconcile <mission-id> <run-id> <task-id> <tool-call-id> completed|retry");
      output(await runtime.missions.reconcileExternalAction(missionId, runId, taskId, toolCallId, resolution as "completed" | "retry"));
    } else if (subcommand === "run") {
      if (!rest[0]) fail("Usage: mission run <id>");
      output(await runtime.missions.run(rest[0], { signal: controller.signal, approveExternalAction }));
    } else if (["pause", "cancel", "resume", "archive"].includes(subcommand ?? "")) {
      if (!rest[0]) fail(`Usage: mission ${subcommand} <id>`);
      const id = rest[0]!;
      if (subcommand === "pause") { runtime.missions.pause(id); output({ missionId: id, status: "paused" }); }
      else if (subcommand === "cancel") { runtime.missions.cancel(id); output({ missionId: id, status: "cancelled" }); }
      else if (subcommand === "archive") { runtime.missions.archive(id); output({ missionId: id, status: "archived" }); }
      else output(await runtime.missions.resume(id, controller.signal, approveExternalAction));
    } else if (subcommand === "daemon") {
      let webhookServer: Server | undefined;
      const webhookOptions = parseGitHubWebhookOptions(rest);
      if (webhookOptions) {
        runtime.access.assertCapability("network");
        runtime.access.assertCapability("integrations");
        await runtime.missions.startScheduler();
        try { webhookServer = await startGitHubWebhookServer(runtime.githubWebhookHandler, webhookOptions); }
        catch (error) { await runtime.missions.shutdownScheduler(); throw error; }
        const listening = webhookServer.address();
        const endpoint = listening && typeof listening !== "string" ? `${listening.address}:${listening.port}` : "configured address";
        if (!json) process.stdout.write(`GitHub webhook receiver listening on ${endpoint}${webhookOptions.path}\n`);
      }
      if (!webhookServer) await runtime.missions.startScheduler();
      if (!json) process.stdout.write("Mission scheduler running. Press Ctrl+C to stop.\n");
      while (!controller.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 250));
      if (webhookServer) await closeWebhookServer(webhookServer);
      await runtime.missions.shutdownScheduler(); output({ scheduler: "stopped", drained: true });
    } else if (subcommand === "service") {
      const operation = rest[0];
      const spec: MissionServiceSpec = { executable: process.execPath, cliEntry: fileURLToPath(import.meta.url), workingDirectory: resolve(process.env.XYST_ROOT ?? process.cwd()) };
      if (operation === "install") {
        runtime.access.assertCapability("backgroundJobs");
        runtime.access.assertExecutable(process.platform === "win32" ? "powershell.exe" : "systemctl");
        const webhookOptions = parseGitHubWebhookOptions(rest.slice(1));
        if (webhookOptions) {
          runtime.access.assertCapability("network"); runtime.access.assertCapability("integrations");
          spec.daemonArguments = ["--webhook", "--webhook-host", webhookOptions.host, "--webhook-port", String(webhookOptions.port), "--webhook-path", webhookOptions.path];
        }
        output(await installMissionService(process.platform, spec));
      } else if (operation === "uninstall") {
        runtime.access.assertCapability("backgroundJobs");
        runtime.access.assertExecutable(process.platform === "win32" ? "powershell.exe" : "systemctl");
        output(await uninstallMissionService(process.platform));
      } else if (operation === "status") output(await missionServiceStatus(process.platform));
      else fail("Usage: mission service install|uninstall|status");
    } else fail("Invalid mission command. Run `xyst help` for syntax.");
  }
  else if (command === "git" && subcommand === "status") output(await gitStatus(runtime.access, process.cwd(), controller.signal));
  else if (command === "git" && subcommand === "clone") {
    if (!rest[0] || !rest[1]) fail("Usage: git clone <https-or-ssh-or-file-url> <destination>");
    const github = { enabled: runtime.config.resolve<boolean>("integrations.github.enabled")?.value === true, ...(runtime.github.enterpriseHost ? { ...(runtime.github.enterpriseHost ? { enterpriseHost: runtime.github.enterpriseHost } : {}) } : {}), token: (signal?: AbortSignal) => runtime.github.gitToken(signal) };
    output(await gitClone(runtime.access, rest[0], rest[1], process.cwd(), controller.signal, github));
  }
  else if (command === "git" && subcommand === "diff") output(await gitDiff(runtime.access, process.cwd(), rest.includes("--staged"), controller.signal));
  else if (command === "git" && subcommand === "log") output(await gitLog(runtime.access, process.cwd(), Number(rest[0] ?? 20), controller.signal));
  else if (command === "git" && subcommand === "branches") output(await gitBranches(runtime.access, process.cwd(), controller.signal));
  else if (command === "git" && subcommand === "branch") {
    if (!rest[0]) fail("Usage: git branch <name>"); output(await gitCreateBranch(runtime.access, rest[0], process.cwd(), controller.signal));
  } else if (command === "git" && subcommand === "add") {
    if (!rest.length) fail("Usage: git add <repository-relative-path...>"); output(await gitStage(runtime.access, rest, process.cwd(), controller.signal));
  } else if (command === "git" && subcommand === "commit") {
    const divider = rest.indexOf("--");
    if (rest[0] !== "-m" || divider < 2 || divider === rest.length - 1) fail("Usage: git commit -m <message> -- <repository-relative-path...>");
    output(await gitCommit(runtime.access, rest.slice(1, divider).join(" "), rest.slice(divider + 1), process.cwd(), controller.signal));
  } else if (command === "git" && subcommand === "fetch") {
    const github = { enabled: runtime.config.resolve<boolean>("integrations.github.enabled")?.value === true, ...(runtime.github.enterpriseHost ? { ...(runtime.github.enterpriseHost ? { enterpriseHost: runtime.github.enterpriseHost } : {}) } : {}), token: (signal?: AbortSignal) => runtime.github.gitToken(signal) };
    output(await gitFetch(runtime.access, rest[0] ?? "origin", rest[1], process.cwd(), controller.signal, github));
  } else if (command === "git" && subcommand === "push") {
    const github = { enabled: runtime.config.resolve<boolean>("integrations.github.enabled")?.value === true, writesEnabled: runtime.config.resolve<boolean>("integrations.github.writeEnabled")?.value === true, ...(runtime.github.enterpriseHost ? { enterpriseHost: runtime.github.enterpriseHost } : {}) };
    output(await gitPush(runtime.access, rest[0] ?? "origin", rest[1], process.cwd(), controller.signal, { ...github, token: (signal?: AbortSignal) => runtime.github.gitToken(signal) }));
  }
  else if (command === "github") {
    if (subcommand === "enabled" || subcommand === "writes") {
      if (rest[0] !== "on" && rest[0] !== "off") fail(`Usage: github ${subcommand} on|off`);
      runtime.config.set("global", subcommand === "enabled" ? "integrations.github.enabled" : "integrations.github.writeEnabled", rest[0] === "on");
      output({ [subcommand === "enabled" ? "githubEnabled" : "githubWritesEnabled"]: rest[0] === "on" });
    } else if (subcommand === "auth" && rest[0] === "set") {
      await runtime.credentials.set("github", "personal-token", await readSecret()); output({ authenticated: "credential stored" });
    } else if (subcommand === "auth" && rest[0] === "delete") {
      output({ deleted: await runtime.credentials.delete("github", "personal-token") });
    } else if (subcommand === "auth" && rest[0] === "status") output(await runtime.github.authenticate());
    else {
      runtime.access.assertCapability("network"); runtime.access.assertCapability("integrations");
      if (runtime.config.resolve<boolean>("integrations.github.enabled")?.value !== true) fail("Enable GitHub with `github enabled on` first");
      const [repository, numberOrRef, ...tail] = rest; const [owner, repo, extra] = (repository ?? "").split("/");
      if (subcommand === "repos") output(await runtime.github.repositories(rest.join(" ") || undefined));
      else if ((subcommand === "issues" || subcommand === "prs") && owner && repo && !extra) output(subcommand === "issues" ? await runtime.github.issues(owner, repo, (numberOrRef as "open" | "closed" | "all") ?? "open") : await runtime.github.pullRequests(owner, repo, (numberOrRef as "open" | "closed" | "all") ?? "open"));
      else if (subcommand === "issue" && owner && repo && numberOrRef) output(await runtime.github.issue(owner, repo, Number(numberOrRef)));
      else if (subcommand === "labels" && owner && repo && numberOrRef && !tail.length) {
        const issueId = Number(numberOrRef); if (!Number.isSafeInteger(issueId) || issueId < 1) fail("Issue number must be a positive integer");
        output(await runtime.github.issueLabels(owner, repo, issueId, controller.signal));
      }
      else if ((subcommand === "label-add" || subcommand === "label-replace") && owner && repo && numberOrRef && tail.length === 1) {
        if (runtime.config.resolve<boolean>("integrations.github.writeEnabled")?.value !== true) fail("Enable GitHub writes with `github writes on` first");
        runtime.access.assertCapability("externalActions");
        const issueId = Number(numberOrRef); if (!Number.isSafeInteger(issueId) || issueId < 1) fail("Issue number must be a positive integer");
        const labels = tail[0] === "-" ? [] : tail[0]!.split(",").map((label) => label.trim()).filter(Boolean);
        if (subcommand === "label-add" && !labels.length) fail("Provide at least one label to add");
        output(subcommand === "label-add" ? await runtime.github.addIssueLabels(owner, repo, issueId, labels, controller.signal) : await runtime.github.replaceIssueLabels(owner, repo, issueId, labels, controller.signal));
      }
      else if (subcommand === "label-remove" && owner && repo && numberOrRef && tail.length) {
        if (runtime.config.resolve<boolean>("integrations.github.writeEnabled")?.value !== true) fail("Enable GitHub writes with `github writes on` first");
        runtime.access.assertCapability("externalActions");
        const issueId = Number(numberOrRef); if (!Number.isSafeInteger(issueId) || issueId < 1) fail("Issue number must be a positive integer");
        output(await runtime.github.removeIssueLabel(owner, repo, issueId, tail.join(" "), controller.signal));
      }
      else if (subcommand === "pr-diff" && owner && repo && numberOrRef) output(await runtime.github.pullRequestDiff(owner, repo, Number(numberOrRef)));
      else if (subcommand === "review-comments" && owner && repo && numberOrRef && !tail.length) output(await runtime.github.pullRequestReviewComments(owner, repo, Number(numberOrRef)));
      else if (subcommand === "checks" && owner && repo && numberOrRef) output(await runtime.github.checks(owner, repo, numberOrRef));
      else if (subcommand === "workflow-runs" && owner && repo && !extra) output(await runtime.github.workflowRuns(owner, repo, numberOrRef));
      else if (subcommand === "workflow-logs" && owner && repo && numberOrRef && !tail.length) {
        if (!Number.isSafeInteger(Number(numberOrRef)) || Number(numberOrRef) < 1) fail("Workflow run ID must be a positive integer");
        output(await runtime.github.workflowRunLogs(owner, repo, Number(numberOrRef)));
      }
      else if (subcommand === "releases" && owner && repo && !extra && !numberOrRef) output(await runtime.github.releases(owner, repo));
      else if (subcommand === "artifacts" && owner && repo && !extra && !numberOrRef) output(await runtime.github.releaseArtifacts(owner, repo));
      else if ((subcommand === "download-release" || subcommand === "download-artifact") && owner && repo && numberOrRef && tail.length === 1) {
        const id = Number(numberOrRef); if (!Number.isSafeInteger(id) || id < 1) fail("GitHub asset or artifact ID must be a positive integer");
        const destination = await runtime.access.assertPath(tail[0]!, "write");
        const file = await open(destination, "wx");
        try {
          const bytes = subcommand === "download-release" ? await runtime.github.downloadReleaseAsset(owner, repo, id, controller.signal) : await runtime.github.downloadActionsArtifact(owner, repo, id, controller.signal);
          await file.writeFile(bytes); output({ path: destination, bytes: bytes.byteLength });
        } catch (error) { await file.close(); await unlink(destination).catch(() => undefined); throw error; }
        finally { await file.close().catch(() => undefined); }
      }
      else if (subcommand === "review-comment" && owner && repo && numberOrRef && tail.length >= 4) {
        if (runtime.config.resolve<boolean>("integrations.github.writeEnabled")?.value !== true) fail("Enable GitHub writes with `github writes on` first");
        runtime.access.assertCapability("externalActions");
        if (!Number.isSafeInteger(Number(numberOrRef)) || Number(numberOrRef) < 1 || !/^[0-9a-f]{40,64}$/i.test(tail[0]!) || !Number.isSafeInteger(Number(tail[2])) || Number(tail[2]) < 1) fail("Review comments require a positive PR number and diff line plus a 40-64 character commit SHA");
        output(await runtime.github.createReviewComment(owner, repo, Number(numberOrRef), { commitId: tail[0]!, path: tail[1]!, line: Number(tail[2]), body: tail.slice(3).join(" ") }));
      }
      else if (subcommand === "pr-update" && owner && repo && numberOrRef && tail.length >= 2) {
        if (runtime.config.resolve<boolean>("integrations.github.writeEnabled")?.value !== true) fail("Enable GitHub writes with `github writes on` first");
        runtime.access.assertCapability("externalActions");
        const field = tail[0]; const value = tail.slice(1).join(" ");
        if (!Number.isSafeInteger(Number(numberOrRef)) || Number(numberOrRef) < 1) fail("Pull request number must be a positive integer");
        if (field === "title") output(await runtime.github.updatePullRequest(owner, repo, Number(numberOrRef), { title: value }, controller.signal));
        else if (field === "body") output(await runtime.github.updatePullRequest(owner, repo, Number(numberOrRef), { body: value }, controller.signal));
        else if (field === "base") output(await runtime.github.updatePullRequest(owner, repo, Number(numberOrRef), { base: value }, controller.signal));
        else if (field === "state" && (value === "open" || value === "closed")) output(await runtime.github.updatePullRequest(owner, repo, Number(numberOrRef), { state: value }, controller.signal));
        else fail("PR update field must be title, body, base, or state (open|closed)");
      }
      else if (subcommand === "review-reply" && owner && repo && numberOrRef && tail.length >= 2) {
        if (runtime.config.resolve<boolean>("integrations.github.writeEnabled")?.value !== true) fail("Enable GitHub writes with `github writes on` first");
        runtime.access.assertCapability("externalActions");
        if (!Number.isSafeInteger(Number(numberOrRef)) || Number(numberOrRef) < 1 || !Number.isSafeInteger(Number(tail[0])) || Number(tail[0]) < 1) fail("Review replies require positive pull request and comment IDs");
        output(await runtime.github.replyReviewComment(owner, repo, Number(numberOrRef), Number(tail[0]), tail.slice(1).join(" ")));
      }
      else if (subcommand === "pr-create" && owner && repo && rest.length >= 5) {
        if (runtime.config.resolve<boolean>("integrations.github.writeEnabled")?.value !== true) fail("Enable GitHub writes with `github writes on` first");
        runtime.access.assertCapability("externalActions"); output(await runtime.github.createPullRequest(owner, repo, { head: rest[1]!, base: rest[2]!, title: rest[3]!, body: rest.slice(4).join(" ") }));
      } else if (subcommand === "issue-comment" && owner && repo && numberOrRef && tail.length) {
        if (runtime.config.resolve<boolean>("integrations.github.writeEnabled")?.value !== true) fail("Enable GitHub writes with `github writes on` first");
        runtime.access.assertCapability("externalActions"); output(await runtime.github.commentIssue(owner, repo, Number(numberOrRef), tail.join(" ")));
      } else fail("Invalid GitHub command. Run `xyst help` for syntax.");
    }
  }
  else if (command === "mcp" && subcommand === "enable") {
    if (rest[0] !== "on" && rest[0] !== "off") fail("Usage: mcp enable on|off");
    runtime.config.set("global", "integrations.mcp.enabled", rest[0] === "on"); output({ enabled: rest[0] === "on", applies: "next agent task" });
  } else if (command === "mcp" && subcommand === "list") {
    const configured = runtime.config.resolve<unknown>("integrations.mcp.servers")?.value ?? [];
    const servers = mcpServersSchema.parse(configured).map((server) => ({ id: server.id, transport: server.transport, enabled: server.enabled !== false, ...(server.transport !== "stdio" && server.oauth ? { oauth: true } : {}), allowed_tools: server.allowed_tools ?? [] }));
    output({ enabled: runtime.config.resolve<boolean>("integrations.mcp.enabled")?.value === true, servers });
  } else if (command === "mcp" && subcommand === "set") {
    if (!rest[0]) fail("Usage: mcp set <servers.json>");
    const path = await runtime.access.assertPath(rest[0], "read"); const servers = mcpServersSchema.parse(JSON.parse(await readFile(path, "utf8")));
    runtime.config.set("global", "integrations.mcp.servers", servers); output({ configured: servers.length, applies: "next agent task" });
  } else if (command === "mcp" && subcommand === "discover") {
    const configured = mcpServersSchema.parse(runtime.config.resolve<unknown>("integrations.mcp.servers")?.value ?? []);
    const selected = rest[0] ? configured.filter((server) => server.id === rest[0]) : configured;
    if (rest[0] && !selected.length) fail(`MCP server is not configured: ${rest[0]}`);
    const connection = await createMcpTools(runtime.access, selected, runtime.credentials, process.cwd(), controller.signal);
    try { output({ servers: connection.servers, tools: Object.keys(connection.tools) }); } finally { await connection.close(); }
  } else if (command === "mcp" && subcommand === "auth") {
    const [action, serverId] = rest;
    if (!serverId || !["login", "status", "logout"].includes(action ?? "")) fail("Usage: mcp auth login|status|logout <server-id>");
    const configured = mcpServersSchema.parse(runtime.config.resolve<unknown>("integrations.mcp.servers")?.value ?? []);
    const server = configured.find((candidate) => candidate.id === serverId);
    if (!server) fail(`MCP server is not configured: ${serverId}`);
    if (server.transport === "stdio" || server.oauth !== true) fail(`MCP server ${serverId} is not configured for HTTP OAuth`);
    const provider = new McpOAuthClientProvider(serverId, await runtime.credentials.get(`mcp-oauth-${serverId}`, "redirect_url") ?? "http://127.0.0.1:1/oauth/callback", runtime.credentials);
    if (action === "status") {
      const tokens = await provider.savedTokens();
      output({ server: serverId, authorized: Boolean(tokens?.access_token), ...(tokens?.issuer ? { issuer: tokens.issuer } : {}) });
    } else if (action === "logout") {
      await provider.logout();
      await runtime.credentials.delete?.(`mcp-oauth-${serverId}`, "redirect_url");
      output({ server: serverId, authorized: false });
    } else {
      runtime.access.assertCapability("integrations"); runtime.access.assertCapability("network");
      const result = await authenticateMcpOAuth(server, runtime.credentials, { signal: controller.signal, onAuthorizationUrl: async (url) => {
        process.stderr.write(`Authorize ${serverId} in your browser: ${url.toString()}\n`);
        if (!(await openAuthorizationUrl(url))) process.stderr.write("Open the authorization URL above in a browser to continue.\n");
      } });
      output({ server: serverId, ...result });
    }
  } else if (command === "memory") {
    if (subcommand === "list") output(runtime.memories.list());
    else if (subcommand === "search") {
      const query = rest.join(" "); if (!query) fail("Usage: memory search <text>");
      const enabled = runtime.config.resolve<boolean>("memory.semantic.enabled")?.value === true;
      let model = runtime.config.resolve<string>("memory.embeddingModel")?.value;
      if (enabled && !model && (runtime.config.resolve<boolean>("model.autoSelect")?.value ?? true)) {
        try { model = chooseEmbeddingModel(await lm.models(controller.signal)).model.key; } catch { /* Use lexical retrieval when no compatible embedder is installed. */ }
      }
      if (enabled && model) {
        try { const [vector] = await requestEmbeddings(lm, model, query, controller.signal); const results = vector ? runtime.memories.searchSemantic(vector, model) : []; output(results.length ? { mode: "semantic", model, results } : { mode: "lexical-fallback", results: runtime.memories.search(query) }); }
        catch (error) { output({ mode: "lexical-fallback", reason: error instanceof Error ? error.message : String(error), results: runtime.memories.search(query) }); }
      } else output({ mode: enabled ? "lexical-fallback" : "lexical", ...(enabled ? { reason: "No embedding model is configured or installed, or automatic model selection is disabled" } : {}), results: runtime.memories.search(query) });
    }
    else if (subcommand === "semantic") {
      if (rest[0] === "off") { runtime.config.set("global", "memory.semantic.enabled", false); output({ enabled: false }); }
      else if (rest[0] === "on" && rest.length <= 2) {
        const model = rest[1]?.trim();
        if (model) {
          const available = await lm.models(controller.signal);
          if (!available.some((candidate) => candidate.key === model && candidate.type === "embedding")) fail(`No downloaded embedding model found: ${model}`);
          runtime.config.set("global", "memory.embeddingModel", model);
        } else runtime.config.reset("global", "memory.embeddingModel");
        runtime.config.set("global", "memory.semantic.enabled", true);
        let automatic: { model: string; reason: string } | undefined;
        if (!model && (runtime.config.resolve<boolean>("model.autoSelect")?.value ?? true)) {
          try { const choice = chooseEmbeddingModel(await lm.models(controller.signal)); automatic = { model: choice.model.key, reason: choice.reason }; } catch { /* Semantic mode remains enabled with lexical fallback until an embedder is installed. */ }
        }
        output({ enabled: true, ...(model ? { model, selection: "manual" } : automatic ? { ...automatic, selection: "automatic" } : { selection: "automatic", fallback: "No installed embedding model is available" }), applies: "next memory search and index" });
      } else fail("Usage: memory semantic on [embedding-model]|off");
    }
    else if (subcommand === "index") {
      let model = rest[0]?.trim() || runtime.config.resolve<string>("memory.embeddingModel")?.value;
      let selectionReason: string | undefined;
      if (!model && (runtime.config.resolve<boolean>("model.autoSelect")?.value ?? true)) {
        const choice = chooseEmbeddingModel(await lm.models(controller.signal)); model = choice.model.key; selectionReason = choice.reason;
      }
      if (!model) fail("Choose an embedding model with `memory semantic on <embedding-model>` or enable automatic model selection and install an embedding model");
      const available = await lm.models(controller.signal);
      if (!available.some((candidate) => candidate.key === model && candidate.type === "embedding")) fail(`No downloaded embedding model found: ${model}`);
      output({ ...await indexMemories(runtime.memories, lm, model, controller.signal), ...(selectionReason ? { selection: "automatic", selectionReason } : {}) });
    }
    else if (subcommand === "add") {
      const [kind, ...content] = rest; if (!kind || !content.length) fail("Usage: memory add <preference|note|inferred> <text>");
      output(runtime.memories.add(kind as "preference" | "note" | "inferred", content.join(" "), "cli"));
    } else if (subcommand === "edit") {
      const [id, ...content] = rest; if (!id || !content.length) fail("Usage: memory edit <id> <text>"); output(runtime.memories.update(id, content.join(" ")));
    } else if (subcommand === "delete") {
      if (!rest[0]) fail("Usage: memory delete <id>"); runtime.memories.delete(rest[0]); output({ id: rest[0], deleted: true });
    } else fail("Usage: memory list|search <text>|add <kind> <text>|edit <id> <text>|delete <id>|semantic on <model>|off|index [model]");
  } else if (command === "session" && subcommand === "list") {
    output(runtime.sessions.list());
  } else if (command === "session" && subcommand === "new") {
    const id = runtime.sessions.create(rest.join(" ") || "New session"); output({ id, created: true });
  } else if (command === "session" && subcommand === "show") {
    if (!rest[0]) fail("Usage: session show <session-id>");
    const rows = runtime.sessions.messages(rest[0]) as Array<{ role: string; content: string }>;
    output(rows.map((row) => ({ role: row.role, content: row.content.startsWith("__xyst_api_message__:") ? JSON.parse(row.content.slice("__xyst_api_message__:".length)) : row.content })));
  } else if (command === "session" && subcommand === "summary") {
    if (!rest[0]) fail("Usage: session summary <session-id>");
    const latest = runtime.sessions.compactions(rest[0]).at(-1);
    if (!latest) fail(`Session has no saved compaction summary: ${rest[0]}`);
    output({ id: latest.id, throughMessageId: latest.through_message_id, createdAt: latest.created_at, summary: JSON.parse(latest.summary_json) });
  } else if (command === "session" && subcommand === "compact") {
    const sessionId = rest[0]; if (!sessionId) fail("Usage: session compact <session-id> [--model key]");
    let preferred = runtime.config.resolve<string>("model.default", { session: sessionId })?.value;
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === "--model") { preferred = rest[++i]; if (!preferred) fail("--model requires a model key"); }
      else fail(`Unknown session compact option: ${rest[i]}`);
    }
    const selected = await getSessionCompactionModel(runtime.lmStudio, preferred);
    const result = await runtime.sessionCompactor.compact(sessionId, selected.model, controller.signal);
    output({ ...result, model: selected.model, modelReason: selected.reason });
  } else if (command === "session" && subcommand === "calls") {
    if (!rest[0]) fail("Usage: session calls <session-id>");
    output(runtime.store.db.prepare("SELECT id,name,input_json,output_json,status,effect,created_at,finished_at FROM tool_calls WHERE session_id=? ORDER BY created_at").all(rest[0]));
  } else if (command === "session" && subcommand === "artifacts") {
    if (!rest[0]) fail("Usage: session artifacts <session-id>");
    output(runtime.store.db.prepare("SELECT id,name,path,mime_type,metadata_json,created_at FROM artifacts WHERE session_id=? ORDER BY created_at").all(rest[0]));
  } else if (command === "session" && subcommand === "rename") {
    const [id, ...title] = rest; if (!id || !title.length) fail("Usage: session rename <session-id> <title>");
    runtime.sessions.rename(id, title.join(" ")); output({ id, title: title.join(" "), renamed: true });
  } else if (command === "session" && subcommand === "fork") {
    if (!rest[0]) fail("Usage: session fork <session-id> [title]");
    const id = runtime.sessions.fork(rest[0], rest.slice(1).join(" ") || undefined); output({ id, sourceId: rest[0], forked: true });
  } else if (command === "session" && subcommand === "archive") {
    if (!rest[0]) fail("Usage: session archive <session-id>"); runtime.sessions.archive(rest[0]); output({ id: rest[0], archived: true });
  } else if (command === "session" && subcommand === "delete") {
    if (!rest[0]) fail("Usage: session delete <session-id>"); runtime.sessions.delete(rest[0]); output({ id: rest[0], deleted: true });
  } else if (command === "session" && subcommand === "export") {
    if (!rest[0]) fail("Usage: session export <session-id> [path]"); const serialized = `${JSON.stringify(runtime.sessions.export(rest[0]), null, 2)}\n`;
    if (rest[1]) { const destination = await runtime.access.assertPath(resolve(rest[1]), "write"); await writeFile(destination, serialized, { flag: "wx" }); output({ id: rest[0], path: destination, exported: true }); }
    else output(JSON.parse(serialized));
  } else if (command === "config" && subcommand === "set") {
    const [key, rawValue, scopeRaw = "global", scopeId = ""] = rest;
    if (!key || rawValue === undefined) fail("Usage: config set <key> <json> [scope] [scope-id]");
    if (!["global", "project", "mission", "agent", "session"].includes(scopeRaw)) fail(`Invalid scope: ${scopeRaw}`);
    const value: unknown = JSON.parse(rawValue);
    if (key === "browser.headless" && typeof value !== "boolean") fail("browser.headless must be true or false");
    if (key === "browser.maxDownloadBytes" && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1024 ** 2 || value > 10 * 1024 ** 3)) fail("browser.maxDownloadBytes must be an integer from 1 MiB through 10 GiB");
    runtime.config.set(scopeRaw as "global" | "project" | "mission" | "agent" | "session", key, value, scopeId);
    output({ key, scope: scopeRaw, scopeId, updated: true });
  } else if (command === "config" && subcommand === "reset") {
    const [key, scopeRaw = "global", scopeId = ""] = rest;
    if (!key) fail("Usage: config reset <key> [global|project|mission|agent|session] [scope-id]");
    if (!["global", "project", "mission", "agent", "session"].includes(scopeRaw)) fail(`Invalid scope: ${scopeRaw}`);
    output({ key, scope: scopeRaw, scopeId, reset: runtime.config.reset(scopeRaw as "global" | "project" | "mission" | "agent" | "session", key, scopeId) });
  } else if (command === "config" && subcommand === "reset-all") {
    const [scopeRaw = "global", scopeId = ""] = rest;
    if (!["global", "project", "mission", "agent", "session"].includes(scopeRaw)) fail(`Invalid scope: ${scopeRaw}`);
    output({ scope: scopeRaw, scopeId, resetCount: runtime.config.resetScope(scopeRaw as "global" | "project" | "mission" | "agent" | "session", scopeId) });
  } else if (command === "config" && subcommand === "get") {
    const [key, scopeOrProjectId, explicitScopeId, parentMissionId] = rest; if (!key) fail("Usage: config get <key> [project-id] | config get <key> <scope> <scope-id> [parent-mission-id]");
    const scopeNames = ["global", "project", "mission", "agent", "session"] as const;
    const scopes: Partial<Record<typeof scopeNames[number], string>> = {};
    let targetScope: typeof scopeNames[number] | undefined; let targetId = "";
    if (scopeOrProjectId && scopeNames.includes(scopeOrProjectId as typeof scopeNames[number])) { targetScope = scopeOrProjectId as typeof scopeNames[number]; targetId = explicitScopeId ?? ""; }
    else if (scopeOrProjectId) { targetScope = "project"; targetId = scopeOrProjectId; }
    if (targetScope === "project") scopes.project = targetId;
    else if (targetScope === "mission") {
      scopes.mission = targetId;
      const mission = runtime.store.db.prepare("SELECT definition_json FROM missions WHERE id=?").get(targetId) as { definition_json: string } | undefined;
      if (mission) { const definition = JSON.parse(mission.definition_json) as { projectId?: unknown }; if (typeof definition.projectId === "string") scopes.project = definition.projectId; }
    } else if (targetScope === "agent") {
      scopes.agent = targetId;
      let inferredMissionId = parentMissionId;
      if (!inferredMissionId) {
        const missions = runtime.store.db.prepare("SELECT id,definition_json FROM missions").all() as Array<{ id: string; definition_json: string }>;
        const matches = missions.filter((row) => {
          const definition = JSON.parse(row.definition_json) as { agents?: Array<{ id?: unknown }>; tasks?: Array<{ id?: unknown; agentId?: unknown }> };
          return definition.agents?.some((agent) => agent.id === targetId) || definition.tasks?.some((task) => task.agentId === targetId || (!task.agentId && task.id === targetId));
        }).map((row) => row.id);
        if (matches.length > 1) fail(`Agent setting context is ambiguous across missions. Supply a parent mission ID to config get: ${matches.join(", ")}`);
        inferredMissionId = matches[0];
      }
      if (inferredMissionId) {
        const mission = runtime.store.db.prepare("SELECT definition_json FROM missions WHERE id=?").get(inferredMissionId) as { definition_json: string } | undefined;
        if (!mission) fail(`Parent mission not found for agent setting context: ${inferredMissionId}`);
        scopes.mission = inferredMissionId;
        const definition = JSON.parse(mission.definition_json) as { projectId?: unknown };
        if (typeof definition.projectId === "string") scopes.project = definition.projectId;
      }
    } else if (targetScope === "session") {
      scopes.session = targetId;
      const task = runtime.store.db.prepare("SELECT mission_id,task_key FROM mission_tasks WHERE session_id=? ORDER BY updated_at DESC LIMIT 1").get(targetId) as { mission_id: string; task_key: string } | undefined;
      if (task?.mission_id) {
        scopes.mission = task.mission_id;
        const mission = runtime.store.db.prepare("SELECT definition_json FROM missions WHERE id=?").get(task.mission_id) as { definition_json: string } | undefined;
        if (mission) {
          const definition = JSON.parse(mission.definition_json) as { projectId?: unknown; tasks?: Array<{ id?: unknown; agentId?: unknown }> };
          if (typeof definition.projectId === "string") scopes.project = definition.projectId;
          const missionTask = definition.tasks?.find((candidate) => candidate.id === task.task_key);
          if (missionTask) scopes.agent = typeof missionTask.agentId === "string" ? missionTask.agentId : task.task_key;
        }
      }
    } else if (targetScope === "global") scopes.global = "";
    output(runtime.config.resolve(key, scopes) ?? { key, configured: false });
  } else if (command === "config" && subcommand === "export") {
    output(runtime.config.export());
  } else if (command === "config" && subcommand === "import") {
    if (!rest[0]) fail("Usage: config import <file>");
    const path = await runtime.access.assertPath(rest[0], "read");
    if ((await stat(path)).size > 1_048_576) fail("Configuration import file exceeds the 1 MiB limit");
    runtime.config.import(JSON.parse(await readFile(path, "utf8"))); output({ imported: true });
  } else if (command === "file" && subcommand === "read") {
    if (!rest[0]) fail("Usage: file read <path> [start-line] [end-line]");
    await runtime.access.assertPath(rest[0], "read");
    const range = rest[1] ? { startLine: Number(rest[1]), endLine: Number(rest[2] ?? rest[1]) } : undefined;
    output(await readText(rest[0], range));
  } else if (command === "file" && subcommand === "list") {
    if (!rest[0]) fail("Usage: file list <path> [--recursive]"); await runtime.access.assertPath(rest[0], "read"); output(await listFiles(rest[0], rest.includes("--recursive")));
  } else if (command === "file" && subcommand === "search") {
    if (!rest[0] || rest[1] === undefined) fail("Usage: file search <path> <text>"); await runtime.access.assertPath(rest[0], "read"); output(await searchFiles(rest[0], rest.slice(1).join(" ")));
  } else if (command === "file" && subcommand === "create") {
    if (!rest[0] || rest[1] === undefined) fail("Usage: file create <path> <text>"); await runtime.access.assertPath(rest[0], "write"); output({ path: await createText(rest[0], rest.slice(1).join(" ")) });
  } else if (command === "file" && subcommand === "patch") {
    if (rest.length < 4) fail("Usage: file patch <path> <sha256> <old-text> <new-text>"); await runtime.access.assertPath(rest[0]!, "write"); output(await patchText(rest[0]!, rest[1]!, rest[2]!, rest.slice(3).join(" ")));
  } else if (command === "file" && subcommand === "move") {
    if (!rest[0] || !rest[1]) fail("Usage: file move <from> <to>"); await runtime.access.assertPath(rest[0], "write"); await runtime.access.assertPath(rest[1], "write"); output({ path: await movePath(rest[0], rest[1]) });
  } else if (command === "file" && subcommand === "delete") {
    if (!rest[0]) fail("Usage: file delete <path>"); await runtime.access.assertPath(rest[0], "write"); await deletePath(rest[0]); output({ deleted: rest[0] });
  } else if (command === "run") {
    if (!subcommand) fail("Usage: run <executable> [args...]");
    runtime.access.assertCapability("externalActions"); runtime.access.assertExecutable(subcommand);
    const result = await runProcess(subcommand, rest, { signal: controller.signal, onStdout: (chunk) => process.stdout.write(chunk), onStderr: (chunk) => process.stderr.write(chunk) });
    if (result.code !== 0) process.exitCode = result.code ?? 1;
    if (json) output({ code: result.code, signal: result.signal, durationMs: result.durationMs });
  } else if (command === "shell") {
    if (!subcommand) fail("Usage: shell <script>");
    runtime.access.assertCapability("externalActions"); runtime.access.assertExecutable("shell");
    const result = await runShell([subcommand, ...rest].join(" "), { signal: controller.signal, onStdout: (chunk) => process.stdout.write(chunk), onStderr: (chunk) => process.stderr.write(chunk) });
    if (result.code !== 0) process.exitCode = result.code ?? 1;
    if (json) output({ code: result.code, signal: result.signal, durationMs: result.durationMs });
  } else fail(`Unknown command: ${command}`);
} catch (error) {
  if (process.exitCode !== 1) process.exitCode = 1;
  if (error instanceof Error && error.message !== "") process.stderr.write(`${error.message}\n`);
} finally {
  runtime.close();
}
