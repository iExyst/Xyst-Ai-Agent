export * from "./storage.js";
export * from "./settings-schema.js";
export * from "./events.js";
export * from "./notifications.js";
export * from "./platform.js";
export * from "./desktop-capabilities.js";
export * from "./tools/desktop-automation.js";
export * from "./tools/files.js";
export * from "./tools/web.js";
export * from "./tools/browser.js";
export * from "./tools/office.js";
export * from "./tools/memory.js";
export * from "./tools/skills.js";
export * from "./project-instructions.js";
export * from "./tools/git.js";
export * from "./providers/lm-studio.js";
export * from "./providers/lm-studio-integrations.js";
export * from "./lm-studio-daemon.js";
export * from "./credentials.js";
export * from "./access.js";
export * from "./agent.js";
export * from "./model-selection.js";
export * from "./model-performance.js";
export * from "./integrations/github.js";
export * from "./integrations/huggingface.js";
export * from "./integrations/model-acquisition.js";
export * from "./integrations/mcp.js";
export * from "./tools/github.js";
export * from "./orchestration/missions.js";
export * from "./orchestration/planner.js";
export * from "./orchestration/resource-scheduler.js";
export * from "./system-resources.js";
export * from "./session-compaction.js";

import { resolve } from "node:path";
import { XystStore, ConfigStore, SessionStore, MemoryStore, JobStore } from "./storage.js";
import { RuntimeEvents } from "./events.js";
import { getDataDirectory } from "./platform.js";
import { AccessController, type AccessProfile } from "./access.js";
import { CredentialStore } from "./credentials.js";
import { GitHubProvider, createGitHubWebhookHandler } from "./integrations/github.js";
import { LMStudioProvider } from "./providers/lm-studio.js";
import { AgentRunner } from "./agent.js";
import { PersistentMissionRunner } from "./orchestration/missions.js";
import { MissionPlanner } from "./orchestration/planner.js";
import { HuggingFaceProvider } from "./integrations/huggingface.js";
import { ModelAcquisitionService } from "./integrations/model-acquisition.js";
import { browserRuntimeStatus, installBrowserRuntime } from "./tools/browser.js";
import { readHostResourceStats } from "./system-resources.js";
import { SessionCompactor } from "./session-compaction.js";

export function createRuntime(options: { dataDir?: string; accessProfile?: AccessProfile } = {}) {
  const dataDir = resolve(options.dataDir ?? getDataDirectory());
  const store = new XystStore(resolve(dataDir, "xyst.sqlite"));
  const config = new ConfigStore(store);
  const memories = new MemoryStore(store);
  const jobs = new JobStore(store);
  const storedProfile = config.resolve<AccessProfile>("access.profile")?.value;
  const profile = options.accessProfile ?? (storedProfile && (storedProfile.mode === "full" || storedProfile.mode === "restricted") ? storedProfile : undefined);
  const globalNetworkEnabled = config.resolve<boolean>("network.enabled")?.value !== false;
  const profileAccess = new AccessController(profile);
  const access = globalNetworkEnabled ? profileAccess : profileAccess.restrictCapabilities({ network: true });
  const credentials = new CredentialStore();
  const events = new RuntimeEvents(); const sessions = new SessionStore(store); const github = new GitHubProvider(credentials, { config, store });
  const lmStudio = new LMStudioProvider({ baseUrl: () => config.resolve<string>("integrations.lmStudio.baseUrl")?.value ?? process.env.LM_STUDIO_BASE_URL ?? "http://127.0.0.1:1234", events, token: async () => process.env.LM_API_TOKEN || await credentials.get("lmstudio", "api-token"), requestTimeoutMs: () => (config.resolve<number>("inference.requestTimeoutSeconds")?.value ?? 600) * 1000 });
  const sessionCompactor = new SessionCompactor(store, sessions, lmStudio);
  const huggingFace = new HuggingFaceProvider(credentials);
  const modelAcquisition = new ModelAcquisitionService({ store, config, huggingFace, lmStudio, access: profileAccess });
  const agent = new AgentRunner({ store, config, sessions, events, access: profileAccess, provider: lmStudio, github, modelAcquisition, dataDir, credentials, memories });
  const missions = new PersistentMissionRunner({ store, config, events, agent, modelProvider: lmStudio, access: profileAccess, worktreeRoot: resolve(dataDir, "worktrees") });
  const missionPlanner = new MissionPlanner({ provider: lmStudio, config, access: profileAccess, events });
  const githubWebhookHandler = createGitHubWebhookHandler({
    store,
    secret: () => credentials.get("github", "webhook-secret"),
    shouldIgnoreDelivery: async (_event, payload) => {
      if (!payload || typeof payload !== "object" || !("sender" in payload)) return false;
      const sender = (payload as { sender?: { login?: unknown } }).sender;
      if (!sender || typeof sender.login !== "string") return false;
      const identity = await github.authenticate();
      if (identity.authenticated !== true || typeof identity.login !== "string") throw new Error("Cannot safely route this GitHub webhook without identifying Xyst's authenticated GitHub actor");
      return sender.login.toLowerCase() === identity.login.toLowerCase();
    },
    onDelivery: async (event, repository, issueNumber, deliveryId, payload) => { await missions.enqueueGitHubTrigger(event, repository, issueNumber, deliveryId, payload); }
  });
  return { dataDir, store, config, sessions, sessionCompactor, memories, jobs, events, credentials, github, githubWebhookHandler, huggingFace, modelAcquisition, lmStudio, agent, missions, missionPlanner, access, browser: { status: () => browserRuntimeStatus(dataDir), install: (signal?: AbortSignal, onOutput?: (chunk: string, stream: "stdout" | "stderr") => void) => installBrowserRuntime(access, dataDir, signal, onOutput) }, resourceStats: () => readHostResourceStats(access), close: () => { missions.stopScheduler(); store.close(); } };
}
