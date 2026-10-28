import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile as readFileAsync, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { Cron } from "croner";
import { ConfigStore, inspectDatabaseIntegrity, XystStore, SessionStore, MemoryStore, JobStore } from "./storage.js";
import { createText, patchText, readText, searchFiles } from "./tools/files.js";
import { normalizeUserPath, runProcess } from "./platform.js";
import { AccessController } from "./access.js";
import { credentialStoreError, redactSecrets } from "./credentials.js";
import { chooseAgentModel, chooseEmbeddingModel, estimateRequiredContextTokens, MODEL_CONTEXT_HEADROOM_TOKENS, modelLoadContextLength } from "./model-selection.js";
import { readModelPerformance } from "./model-performance.js";
import { classifyModelTaskObjective } from "./model-task-type.js";
import { createHash, createHmac, generateKeyPairSync, randomUUID, verify as verifySignature } from "node:crypto";
import { createGitHubWebhookHandler, GitHubError, GitHubProvider, recordWebhookDelivery, verifyGitHubWebhook } from "./integrations/github.js";
import { createGitHubTools } from "./tools/github.js";
import { PersistentMissionRunner, MissionRepository } from "./orchestration/missions.js";
import { MissionPlanner } from "./orchestration/planner.js";
import { planResourceAwareBatch } from "./orchestration/resource-scheduler.js";
import { runBoundedOrdered } from "./orchestration/tool-batches.js";
import { RuntimeEvents } from "./events.js";
import { runNotification, subscribeRunNotifications, type RunNotification } from "./notifications.js";
import { ModelAcquisitionService } from "./integrations/model-acquisition.js";
import { HuggingFaceProvider } from "./integrations/huggingface.js";
import { createWebTools } from "./tools/web.js";
import { AgentRunner, ExternalActionApprovalError, assertRequiredToolEvidence } from "./agent.js";
import { createServer } from "node:http";
import { LMStudioProvider } from "./providers/lm-studio.js";
import { SessionCompactor } from "./session-compaction.js";
import { parseLmsDaemonStatus } from "./lm-studio-daemon.js";
import { createOfficeTools, extractPdfAttachmentText } from "./tools/office.js";
import { createDesktopAutomationTools, inspectNativeAutomation } from "./tools/desktop-automation.js";
import { createMemoryTools, indexMemories } from "./tools/memory.js";
import { createRuntime } from "./index.js";
import { loadProjectInstructions } from "./project-instructions.js";
import { createSkillTools } from "./tools/skills.js";
import JSZip from "jszip";
import { authenticateMcpOAuth, createMcpTools, McpOAuthClientProvider, mcpServersSchema } from "./integrations/mcp.js";
import { createMcpSamplingHandler } from "./integrations/mcp-sampling.js";
import { resolveLMStudioIntegrations } from "./providers/lm-studio-integrations.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import { browserRuntimeStatus, createBrowserTools } from "./tools/browser.js";
import { inspectDesktopCapabilities } from "./desktop-capabilities.js";
import { parseLmStudioResourceEstimate, readHostResourceStats } from "./system-resources.js";
import { getDataDirectory } from "./platform.js";
import { git, gitClone, gitCommit, gitCreateBranch, gitFetch, gitNetworkEnvironment, gitPush, gitStage, gitStatus } from "./tools/git.js";
import { validateSettingValue } from "./settings-schema.js";
import { PDFDocument } from "pdf-lib";
import { createCanvas } from "@napi-rs/canvas";
import { readFile } from "node:fs/promises";

async function withTemp<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "xyst-test-"));
  try { return await run(root); } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

test("database integrity inspection is read-only and distinguishes healthy, corrupt, and missing files", async () => withTemp(async (root) => {
  const healthyPath = join(root, "healthy.sqlite"); const store = new XystStore(healthyPath); store.close();
  assert.deepEqual(inspectDatabaseIntegrity(healthyPath), { path: healthyPath, status: "healthy", details: ["ok"] });
  const missingPath = join(root, "missing.sqlite");
  assert.deepEqual(inspectDatabaseIntegrity(missingPath), { path: missingPath, status: "missing" });
  const corruptPath = join(root, "corrupt.sqlite"); const corruptBytes = Buffer.from("not a SQLite database"); await writeFile(corruptPath, corruptBytes);
  assert.equal(inspectDatabaseIntegrity(corruptPath).status, "corrupt");
  assert.deepEqual(await readFileAsync(corruptPath), corruptBytes);
}));

test("run notifications are opt-in, omit objective content, and unsubscribe cleanly", () => {
  const events = new RuntimeEvents(); const delivered: RunNotification[] = []; let enabled = false;
  const unsubscribe = subscribeRunNotifications(events, () => enabled, (notification) => delivered.push(notification));
  events.emit("mission.finished", { status: "completed", objective: "private task content" });
  assert.equal(delivered.length, 0);
  enabled = true;
  events.emit("agent.started", { objective: "private task content" });
  events.emit("agent.finished", { status: "completed", objective: "private task content" });
  events.emit("mission.finished", { status: "failed", objective: "private task content" });
  assert.equal(delivered.length, 2);
  assert.match(delivered[0]!.title, /task complete/); assert.match(delivered[1]!.message, /needs attention|inspect/);
  assert.doesNotMatch(JSON.stringify(delivered), /private task content/);
  assert.equal(runNotification({ id: "1", type: "tool.completed", at: new Date().toISOString(), payload: {} }), undefined);
  unsubscribe(); events.emit("mission.finished", { status: "completed" }); assert.equal(delivered.length, 2);
  let errors = 0;
  subscribeRunNotifications(events, () => { throw new Error("settings unavailable"); }, () => assert.fail("must not notify"), () => { errors++; throw new Error("logging unavailable"); });
  assert.doesNotThrow(() => events.emit("mission.finished", { status: "completed" })); assert.equal(errors, 1);
});

test("mission planner returns a validated review draft and applies concurrency limits", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "planner.sqlite")); const config = new ConfigStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model"); config.set("global", "orchestration.maxConcurrency", 4);
  const provider = {
    models: async () => [{ type: "llm", key: "test-model", size_bytes: 3_000_000_000, loaded_instances: [], max_context_length: 8192 }],
    structuredOutput: async () => ({ choices: [{ message: { content: JSON.stringify({ name: "Review objective", agents: [], tasks: [{ id: "main", name: "Complete objective", objective: "Do it", dependsOn: [], expectedOutputs: ["result"], completionCriteria: "Result is produced", workspaceMode: "shared" }] }) } }] })
  };
  try {
    const result = await new MissionPlanner({ provider: provider as never, config, access: new AccessController(), events }).plan("A single atomic objective");
    assert.equal(result.definition.objective, "A single atomic objective"); assert.equal(result.definition.tasks?.length, 1);
    assert.equal(result.definition.maxConcurrency, result.resources.effectiveConcurrency);
    assert.ok(result.resources.effectiveConcurrency >= 1 && result.resources.effectiveConcurrency <= 4);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM missions").get() && (store.db.prepare("SELECT COUNT(*) AS count FROM missions").get() as { count: number }).count, 0, "planning must not save the draft");
  } finally { store.close(); }
}));

test("mission planner rejects unavailable models and invalid dependency graphs", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "planner-invalid.sqlite")); const config = new ConfigStore(store); const events = new RuntimeEvents();
  const inventory = [{ type: "llm", key: "test-model", size_bytes: 1, loaded_instances: [] }];
  const provider = { models: async () => inventory, structuredOutput: async () => ({ choices: [{ message: { content: JSON.stringify({ name: "Cycle", agents: [], tasks: [
    { id: "a", name: "A", objective: "A", dependsOn: ["b"], expectedOutputs: [], completionCriteria: "done", workspaceMode: "shared" },
    { id: "b", name: "B", objective: "B", dependsOn: ["a"], expectedOutputs: [], completionCriteria: "done", workspaceMode: "shared" }
  ] }) } }] }) };
  try {
    config.set("global", "model.default", "missing-model");
    await assert.rejects(new MissionPlanner({ provider: provider as never, config, access: new AccessController(), events }).plan("Objective"), /not an installed LLM/);
    config.set("global", "model.default", "test-model");
    await assert.rejects(new MissionPlanner({ provider: provider as never, config, access: new AccessController(), events }).plan("Objective"), /dependency cycle/);
  } finally { store.close(); }
}));

test("mission planner limits plans to one task while agent delegation is disabled", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "planner-no-delegation.sqlite")); const config = new ConfigStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model"); config.set("global", "orchestration.maxConcurrency", 4); config.set("global", "orchestration.delegation.enabled", false);
  let draft: Record<string, unknown> = { name: "Atomic plan", agents: [], tasks: [{ id: "main", name: "Complete objective", objective: "Do it", dependsOn: [], expectedOutputs: ["result"], completionCriteria: "Result is produced", workspaceMode: "shared" }] };
  let systemPrompt = ""; let requestedConcurrency = 0;
  const provider = {
    models: async () => [{ type: "llm", key: "test-model", size_bytes: 1_000_000_000, loaded_instances: [] }],
    structuredOutput: async (request: { messages: Array<{ role: string; content: string }>; }) => {
      systemPrompt = request.messages.find((message) => message.role === "system")?.content ?? "";
      requestedConcurrency = Number(JSON.parse(request.messages.find((message) => message.role === "user")?.content ?? "{}").resourceLimit.maxConcurrency);
      return { choices: [{ message: { content: JSON.stringify(draft) } }] };
    }
  };
  try {
    const planner = new MissionPlanner({ provider: provider as never, config, access: new AccessController(), events });
    const result = await planner.plan("One atomic objective");
    assert.equal(result.definition.tasks?.length, 1); assert.equal(result.definition.agents?.length, 0);
    assert.equal(result.definition.maxConcurrency, 1); assert.equal(result.resources.effectiveConcurrency, 1);
    assert.equal(requestedConcurrency, 1); assert.match(systemPrompt, /Delegation is disabled/);
    draft = { name: "Delegated plan", agents: [], tasks: [
      { id: "a", name: "A", objective: "A", dependsOn: [], expectedOutputs: ["a"], completionCriteria: "done", workspaceMode: "shared" },
      { id: "b", name: "B", objective: "B", dependsOn: ["a"], expectedOutputs: ["b"], completionCriteria: "done", workspaceMode: "shared" }
    ] };
    await assert.rejects(planner.plan("A multi-step objective"), /Mission delegation is disabled/);
  } finally { store.close(); }
}));

test("mission resource scheduler defers oversized models and fits workers to the memory budget", () => {
  const models = [
    { type: "llm" as const, publisher: "Test", key: "small", display_name: "Small", size_bytes: 2_000_000_000, loaded_instances: [{ id: "loaded-small", config: {} }], max_context_length: 8192, capabilities: { trained_for_tool_use: true } },
    { type: "llm" as const, publisher: "Test", key: "large", display_name: "Large", size_bytes: 8_000_000_000, loaded_instances: [], max_context_length: 8192, capabilities: { trained_for_tool_use: true } }
  ];
  const plan = planResourceAwareBatch([
    { id: "heavy", model: "large" },
    { id: "first", automatic: true },
    { id: "second", automatic: true },
    { id: "third", automatic: true }
  ], models, { memoryBudgetBytes: 800 * 1024 ** 2, maxConcurrency: 4 });
  assert.deepEqual(plan.assignments.map((assignment) => assignment.id), ["first", "second"]);
  assert.deepEqual(plan.deferredTaskIds, ["heavy", "third"]);
  assert.equal(plan.assignments[0]?.selectedModel, "small");
  assert.ok(plan.estimatedAdditionalBytes <= plan.memoryBudgetBytes);

  const reassigned = planResourceAwareBatch([{ id: "retry", automatic: true, previouslyAttemptedModels: ["small"] }], models, { memoryBudgetBytes: 16 * 1024 ** 3, maxConcurrency: 1 });
  assert.equal(reassigned.assignments[0]?.selectedModel, "large");
  assert.match(reassigned.assignments[0]?.selectionReason ?? "", /avoiding previously failed automatic assignment/);
  const exhausted = planResourceAwareBatch([{ id: "retry", automatic: true, previouslyAttemptedModels: ["small", "large"] }], models, { memoryBudgetBytes: 4 * 1024 ** 3, maxConcurrency: 1 });
  assert.equal(exhausted.assignments[0]?.selectedModel, "small");
  assert.match(exhausted.assignments[0]?.selectionReason ?? "", /all eligible models were already tried/);

  const pinned = planResourceAwareBatch([{ id: "pinned", model: "large" }], models, { memoryBudgetBytes: 256 * 1024 ** 2, maxConcurrency: 4 });
  assert.equal(pinned.assignments.length, 1);
  assert.equal(pinned.assignments[0]?.admittedOverBudget, true);
});

test("mission resource scheduler considers live free VRAM and LM Studio GPU estimates", () => {
  const models = [
    { type: "llm" as const, publisher: "test", key: "gpu-heavy", display_name: "GPU heavy", size_bytes: 4 * 1024 ** 3, loaded_instances: [], max_context_length: 8192, capabilities: { trained_for_tool_use: true } },
    { type: "llm" as const, publisher: "test", key: "gpu-fit", display_name: "GPU fit", size_bytes: 2 * 1024 ** 3, loaded_instances: [], max_context_length: 8192, capabilities: { trained_for_tool_use: true } }
  ];
  const plan = planResourceAwareBatch([{ id: "task", automatic: true }], models, { memoryBudgetBytes: 16 * 1024 ** 3, maxConcurrency: 2, availableGpuMemoryBytes: 4 * 1024 ** 3, estimatedGpuMemoryBytesByModel: { "gpu-heavy": 8 * 1024 ** 3, "gpu-fit": 3 * 1024 ** 3 } });
  assert.equal(plan.assignments[0]?.selectedModel, "gpu-fit");
  assert.equal(plan.assignments[0]?.estimatedAdditionalGpuMemoryBytes, 3 * 1024 ** 3);
  assert.equal(plan.availableGpuMemoryBytes, 4 * 1024 ** 3);
  const fallback = planResourceAwareBatch([{ id: "oversized", automatic: true }], models, { memoryBudgetBytes: 16 * 1024 ** 3, maxConcurrency: 2, availableGpuMemoryBytes: 2 * 1024 ** 3, estimatedGpuMemoryBytesByModel: { "gpu-heavy": 8 * 1024 ** 3, "gpu-fit": 3 * 1024 ** 3 } });
  assert.equal(fallback.assignments.length, 1, "single-model fallback preserves progress when every estimate exceeds free VRAM");
  assert.equal(fallback.assignments[0]?.selectedModel, "gpu-fit");
  assert.equal(fallback.assignments[0]?.admittedOverBudget, true);
  const unknown = planResourceAwareBatch([{ id: "unknown-a", automatic: true }, { id: "unknown-b", automatic: true }], models, { memoryBudgetBytes: 16 * 1024 ** 3, maxConcurrency: 2, availableGpuMemoryBytes: 4 * 1024 ** 3 });
  assert.equal(unknown.assignments.length, 1, "unknown GPU estimates serialize fallback work rather than assuming unlimited VRAM");
  assert.match(unknown.assignments[0]?.selectionReason ?? "", /GPU estimate.*unknown/);
});

test("mission resource scheduler budgets each concurrent cold model start and shares only resident instances", () => {
  const coldModel = { type: "llm" as const, publisher: "test", key: "cold", display_name: "Cold model", size_bytes: 2 * 1024 ** 3, loaded_instances: [], max_context_length: 8192, capabilities: { trained_for_tool_use: true } };
  const coldPlan = planResourceAwareBatch([{ id: "one", model: "cold" }, { id: "two", model: "cold" }], [coldModel], {
    memoryBudgetBytes: 16 * 1024 ** 3,
    maxConcurrency: 2,
    availableGpuMemoryBytes: 16 * 1024 ** 3,
    estimatedGpuMemoryBytesByModel: { cold: 3 * 1024 ** 3 }
  });
  assert.deepEqual(coldPlan.assignments.map(task => task.id), ["one"]);
  assert.deepEqual(coldPlan.deferredTaskIds, ["two"], "same-model cold starts are serialized so LM Studio can reuse the first resident instance");
  assert.equal(coldPlan.estimatedAdditionalGpuMemoryBytes, 3 * 1024 ** 3);

  const distinctColdPlan = planResourceAwareBatch([{ id: "one", model: "cold" }, { id: "two", model: "cold-2" }], [coldModel, { ...coldModel, key: "cold-2" }], {
    memoryBudgetBytes: 16 * 1024 ** 3,
    maxConcurrency: 2,
    availableGpuMemoryBytes: 5 * 1024 ** 3,
    estimatedGpuMemoryBytesByModel: { cold: 3 * 1024 ** 3, "cold-2": 3 * 1024 ** 3 }
  });
  assert.deepEqual(distinctColdPlan.assignments.map(task => task.id), ["one"]);
  assert.deepEqual(distinctColdPlan.deferredTaskIds, ["two"], "different cold models each consume their full estimated GPU memory");

  const residentModel = { ...coldModel, loaded_instances: [{ id: "resident-cold", config: { context_length: 8192 } }] };
  const residentPlan = planResourceAwareBatch([{ id: "one", model: "cold" }, { id: "two", model: "cold" }], [residentModel], {
    memoryBudgetBytes: 16 * 1024 ** 3,
    maxConcurrency: 2,
    availableGpuMemoryBytes: 2 * 1024 ** 3,
    estimatedGpuMemoryBytesByModel: { cold: 3 * 1024 ** 3 }
  });
  assert.deepEqual(residentPlan.assignments.map(task => task.id), ["one", "two"]);
  assert.equal(residentPlan.estimatedAdditionalGpuMemoryBytes, 384 * 1024 ** 2 * 2, "resident model worker costs remain incremental");
});

test("mission scheduler explores an unmeasured RAM-fitting model after every GPU-fit model has zero verified task outcomes", () => {
  const models = [
    { type: "llm" as const, publisher: "test", key: "known-failure", display_name: "Known failure", size_bytes: 1_000_000_000, loaded_instances: [], max_context_length: 8192, capabilities: { trained_for_tool_use: true } },
    { type: "llm" as const, publisher: "test", key: "unknown-fit", display_name: "Unknown GPU fit", size_bytes: 1_200_000_000, loaded_instances: [], max_context_length: 8192, capabilities: { trained_for_tool_use: true } }
  ];
  const plan = planResourceAwareBatch([{ id: "task", automatic: true }], models, {
    memoryBudgetBytes: 8 * 1024 ** 3,
    maxConcurrency: 1,
    availableGpuMemoryBytes: 8 * 1024 ** 3,
    estimatedGpuMemoryBytesByModel: { "known-failure": 2 * 1024 ** 3 },
    performanceByModel: {
      "known-failure": { samples: 5, successes: 5, successRate: 1, medianLatencyMs: 1000, tokensPerSecond: 20, taskSamples: 3, taskSuccesses: 0, taskSuccessRate: 0 }
    }
  });
  assert.equal(plan.assignments[0]?.selectedModel, "unknown-fit");
  assert.equal(plan.assignments[0]?.admittedOverBudget, true, "unknown GPU use is disclosed and admitted as a one-task fallback when no other assignment can proceed");
  assert.match(plan.assignments[0]?.selectionReason ?? "", /trying the best RAM-eligible model with unknown GPU fit/);
  assert.match(plan.assignments[0]?.selectionReason ?? "", /VRAM fit is unknown/);
  const overBudgetKnownGpu = planResourceAwareBatch([{ id: "task", automatic: true }], models, {
    memoryBudgetBytes: 8 * 1024 ** 3, maxConcurrency: 1, availableGpuMemoryBytes: 8 * 1024 ** 3,
    estimatedGpuMemoryBytesByModel: { "known-failure": 2 * 1024 ** 3, "unknown-fit": 12 * 1024 ** 3 },
    performanceByModel: { "known-failure": { samples: 5, successes: 5, successRate: 1, medianLatencyMs: 1000, tokensPerSecond: 20, taskSamples: 3, taskSuccesses: 0, taskSuccessRate: 0 } }
  });
  assert.equal(overBudgetKnownGpu.assignments[0]?.selectedModel, "known-failure", "a known estimate over free VRAM is not treated as unknown");
});

test("bounded tool batches preserve result order while honoring their concurrency ceiling", async () => {
  let active = 0; let peak = 0;
  const tasks = [0, 1, 2, 3, 4].map((value) => async () => {
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active--;
    return value;
  });
  assert.deepEqual(await runBoundedOrdered(tasks, 2), [0, 1, 2, 3, 4]);
  assert.equal(peak, 2);
  await assert.rejects(runBoundedOrdered(tasks, 9), /integer from 1 through 8/);
});

test("local model performance aggregates and informs automatic selection without publisher scoring", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "performance.sqlite"));
  const insert = store.db.prepare("INSERT INTO usage(id,session_id,provider,model,input_tokens,output_tokens,duration_ms,details_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)");
  const decision = store.db.prepare("INSERT INTO model_decisions(id,session_id,objective,model,reason,considered_json,created_at) VALUES(?,?,?,?,?,?,?)");
  for (const [model, duration, tokens, outcome, taskOutcome] of [["reliable", 1000, 100, "success", "verified_success"], ["reliable", 2000, 100, "success", "verified_success"], ["reliable", 3000, 0, "failure", "verified_success"], ["fast", 150, 150, "success", "failed"], ["fast", 170, 160, "success", "unverified"], ["fast", 130, 140, "success", "failed"]] as const) {
    const sessionId = `${model}-${duration}`; insert.run(randomUUID(), sessionId, "lm-studio", model, 100, tokens, duration, JSON.stringify({ outcome, task_outcome: taskOutcome }), new Date().toISOString());
    decision.run(randomUUID(), sessionId, model === "reliable" ? "Implement a source code fix and run tests" : "Research current sources and summarize facts", model, "test", "{}", new Date().toISOString());
    if (sessionId === "reliable-1000") decision.run(randomUUID(), sessionId, "Continue the previous task", model, "resume", "{}", new Date().toISOString());
  }
  try {
    const performance = readModelPerformance(store);
    assert.deepEqual(performance.reliable, { samples: 3, successes: 2, successRate: 2 / 3, medianLatencyMs: 2000, tokensPerSecond: 66.7, taskSamples: 3, taskSuccesses: 3, taskSuccessRate: 1, taskOutcomesByType: { coding: { taskSamples: 3, taskSuccesses: 3, taskSuccessRate: 1 } } });
    assert.equal(performance.fast?.successRate, 1);
    assert.equal(performance.fast?.taskSuccessRate, 0);
    assert.deepEqual(performance.reliable?.taskOutcomesByType?.coding, { taskSamples: 3, taskSuccesses: 3, taskSuccessRate: 1 });
    assert.deepEqual(performance.fast?.taskOutcomesByType?.research, { taskSamples: 3, taskSuccesses: 0, taskSuccessRate: 0 });
    const models = ["fast", "reliable"].map((key) => ({ type: "llm" as const, publisher: "unknown", key, display_name: key, size_bytes: 4_000_000_000, loaded_instances: [], max_context_length: 8192, capabilities: { trained_for_tool_use: true } }));
    const choice = chooseAgentModel(models, { performanceByModel: performance });
    assert.equal(choice.model.key, "reliable", "verified task outcomes outrank inference-response success and speed"); assert.match(choice.reason, /observed locally over 3 tasks: 3\/3 verified completions/);
  } finally { store.close(); }
}));

test("automatic selection ranks task-matched verified outcomes ahead of pooled history", () => {
  assert.equal(classifyModelTaskObjective("Patch the source code and run the test suite"), "coding");
  assert.equal(classifyModelTaskObjective("Review the pull request diff and report findings"), "review");
  assert.equal(classifyModelTaskObjective("Research current sources and cite the latest API behavior"), "research");
  const models = ["fast-generalist", "proven-coder"].map((key, index) => ({ type: "llm" as const, publisher: "test", key, display_name: key, size_bytes: index ? 2_000_000_000 : 500_000_000, loaded_instances: [], max_context_length: 16384, capabilities: { trained_for_tool_use: true } }));
  const performance = {
    "fast-generalist": { samples: 8, successes: 8, successRate: 1, medianLatencyMs: 200, tokensPerSecond: 100, taskSamples: 5, taskSuccesses: 4, taskSuccessRate: 0.8, taskOutcomesByType: { coding: { taskSamples: 2, taskSuccesses: 0, taskSuccessRate: 0 } } },
    "proven-coder": { samples: 3, successes: 2, successRate: 2 / 3, medianLatencyMs: 1000, tokensPerSecond: 20, taskSamples: 2, taskSuccesses: 1, taskSuccessRate: 0.5, taskOutcomesByType: { coding: { taskSamples: 2, taskSuccesses: 2, taskSuccessRate: 1 } } }
  };
  const codingChoice = chooseAgentModel(models, { taskType: "coding", performanceByModel: performance });
  assert.equal(codingChoice.model.key, "proven-coder");
  assert.match(codingChoice.reason, /observed locally over 2 coding tasks: 2\/2 verified completions/);
  const reviewPerformance = {
    "fast-generalist": { ...performance["fast-generalist"]!, taskOutcomesByType: { ...performance["fast-generalist"]!.taskOutcomesByType, review: { taskSamples: 2, taskSuccesses: 2, taskSuccessRate: 1 } } },
    "proven-coder": { ...performance["proven-coder"]!, taskOutcomesByType: { ...performance["proven-coder"]!.taskOutcomesByType, review: { taskSamples: 2, taskSuccesses: 0, taskSuccessRate: 0 } } }
  };
  const reviewChoice = chooseAgentModel(models, { taskType: "review", performanceByModel: reviewPerformance });
  assert.equal(reviewChoice.model.key, "fast-generalist", "review outcomes are measured separately from coding outcomes");
  assert.match(reviewChoice.reason, /observed locally over 2 review tasks: 2\/2 verified completions/);
  assert.equal(chooseAgentModel(models, { performanceByModel: performance }).model.key, "fast-generalist", "general selection retains pooled outcomes when no task role is requested");
});

test("resuming a task on a different model preserves the earlier model's terminal outcome", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "resumed-model-outcomes.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  const originalFetch = globalThis.fetch;
  const url = "https://8.8.8.8/api/branch";
  let smallTurns = 0;
  const models = ["small", "large"].map((key) => ({ type: "llm" as const, publisher: "test", key, display_name: key, size_bytes: 1, loaded_instances: [{ id: key, config: { context_length: 8192 } }], max_context_length: 8192, capabilities: { trained_for_tool_use: true } }));
  const provider = {
    redact: (value: string) => value,
    models: async () => models,
    streamChatWithTools: async (request: { model: string }) => {
      if (request.model === "small") {
        smallTurns++;
        if (smallTurns === 1) return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "small-fetch", type: "function", function: { name: "web_fetch", arguments: JSON.stringify({ url }) } }] } }] };
        return { choices: [{ message: { role: "assistant", content: "The default branch is main." } }] };
      }
      return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "large-complete", type: "function", function: { name: "task_complete", arguments: JSON.stringify({ evidence_tool_call_indexes: [1] }) } }] } }] };
    }
  };
  globalThis.fetch = async () => new Response(JSON.stringify({ default_branch: "main" }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const agent = new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never });
    const initial = await agent.run(`Use web_fetch to retrieve exactly ${url}, then report the default branch.`, { workspace: root, model: "small", maxTurns: 3 });
    assert.equal(initial.status, "unverified");
    const resumed = await agent.run("Continue and verify the saved API result.", { workspace: root, sessionId: initial.sessionId, model: "large", maxTurns: 3 });
    assert.equal(resumed.status, "completed");
    const performance = readModelPerformance(store);
    assert.equal(performance.small?.taskSamples, 1);
    assert.equal(performance.small?.taskSuccessRate, 0, "the earlier model's terminal unverified attempt remains measurable after another model resumes");
    assert.equal(performance.large?.taskSamples, 1);
    assert.equal(performance.large?.taskSuccessRate, 1);
  } finally { globalThis.fetch = originalFetch; store.close(); }
}));

test("automatic embedding selection reuses a loaded embedder and reports an installed-only choice", () => {
  const models = [
    { type: "embedding" as const, publisher: "test", key: "small-unloaded", display_name: "Small", size_bytes: 20, loaded_instances: [], max_context_length: 8192 },
    { type: "embedding" as const, publisher: "test", key: "loaded-embedder", display_name: "Loaded", size_bytes: 200, loaded_instances: [{ id: "loaded-embedder", config: { context_length: 4096 } }], max_context_length: 8192 },
    { type: "llm" as const, publisher: "test", key: "chat-model", display_name: "Chat", size_bytes: 1, loaded_instances: [], max_context_length: 8192 }
  ];
  const choice = chooseEmbeddingModel(models);
  assert.equal(choice.model.key, "loaded-embedder");
  assert.equal(choice.considered, 2);
  assert.match(choice.reason, /already loaded/);
  assert.throws(() => chooseEmbeddingModel(models.slice(2)), /no downloaded embedding models/);
});

test("agent automatically selects an installed embedding model for semantic memory", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "automatic-embedding.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents(); const memories = new MemoryStore(store);
  config.set("global", "memory.semantic.enabled", true);
  const preference = memories.add("preference", "Keep answers concise", "user request");
  memories.setEmbedding(preference.id, "loaded-embedder", [1, 0], preference.content);
  const models = [
    { type: "llm" as const, publisher: "test", key: "loaded-chat", display_name: "Chat", size_bytes: 20, loaded_instances: [{ id: "loaded-chat", config: { context_length: 8192 } }], max_context_length: 8192, capabilities: { trained_for_tool_use: true } },
    { type: "embedding" as const, publisher: "test", key: "unloaded-embedder", display_name: "Unloaded", size_bytes: 10, loaded_instances: [], max_context_length: 8192 },
    { type: "embedding" as const, publisher: "test", key: "loaded-embedder", display_name: "Loaded", size_bytes: 200, loaded_instances: [{ id: "loaded-embedder", config: { context_length: 4096 } }], max_context_length: 8192 }
  ];
  const embeddingModels: string[] = []; const selections: Array<Record<string, unknown>> = [];
  events.on("model.role-selected", (event) => selections.push(event.payload as Record<string, unknown>));
  let turns = 0;
  const provider = {
    redact: (value: string) => value,
    models: async () => models,
    embeddings: async (model: string) => { embeddingModels.push(model); return { data: [{ index: 0, embedding: [1, 0] }] }; },
    streamChatWithTools: async () => {
      turns++;
      if (turns === 1) return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "memory-search", type: "function", function: { name: "memory_search", arguments: JSON.stringify({ query: "answer style" }) } }] } }] };
      return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "complete-memory-search", type: "function", function: { name: "task_complete", arguments: JSON.stringify({ evidence_tool_call_indexes: [1] }) } }] } }] };
    }
  };
  const agent = new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never, memories });
  try {
    const result = await agent.run("Use memory_search to retrieve my saved answer style preference.", { workspace: root, model: "loaded-chat", maxTurns: 3 });
    assert.equal(result.status, "completed");
    assert.deepEqual(embeddingModels, ["loaded-embedder"]);
    assert.equal(selections[0]?.role, "embeddings");
    assert.equal(selections[0]?.model, "loaded-embedder");
    assert.match(String(selections[0]?.reason), /already loaded/);
  } finally { store.close(); }
}));

test("automatic selection deprioritizes a model with observed zero task completions when an eligible model is unmeasured", () => {
  const models = [
    { type: "llm" as const, publisher: "test", key: "observed-failures", display_name: "Observed Failures", size_bytes: 500_000_000, loaded_instances: [], max_context_length: 8192, capabilities: { trained_for_tool_use: true } },
    { type: "llm" as const, publisher: "test", key: "unmeasured", display_name: "Unmeasured", size_bytes: 1_200_000_000, loaded_instances: [], max_context_length: 8192, capabilities: {} }
  ];
  const performance = {
    "observed-failures": { samples: 5, successes: 5, successRate: 1, medianLatencyMs: 2000, tokensPerSecond: 20, taskSamples: 2, taskSuccesses: 0, taskSuccessRate: 0 }
  };
  const choice = chooseAgentModel(models, { performanceByModel: performance });
  assert.equal(choice.model.key, "unmeasured");
  assert.match(choice.reason, /local task completion reliability is unmeasured/);
});

test("automatic selection distinguishes a loaded instance's context from a model that can be loaded larger", () => {
  const inventory = [
    { type: "llm" as const, publisher: "test", display_name: "Installed long", key: "installed-long", size_bytes: 1_000_000_000, max_context_length: 32768, loaded_instances: [{ id: "short-instance", config: { context_length: 4096 } }] },
    { type: "llm" as const, publisher: "test", display_name: "Installed short", key: "installed-short", size_bytes: 500_000_000, max_context_length: 4096, loaded_instances: [] }
  ];
  const loadable = chooseAgentModel(inventory, { requiredContextTokens: 12000, requireDeclaredContext: true, allowLoading: true });
  assert.equal(loadable.model.key, "installed-long");
  assert.match(loadable.reason, /supports 32768 tokens/);
  assert.throws(() => chooseAgentModel(inventory, { requiredContextTokens: 12000, requireDeclaredContext: true, allowLoading: false }), /No installed model declares enough context/);
});

test("automatic selection prioritizes a verified task success over an unmeasured tool-use declaration", () => {
  const models = [
    { type: "llm" as const, publisher: "test", key: "unmeasured-tool-tag", display_name: "Tagged but unmeasured", size_bytes: 500_000_000, loaded_instances: [], max_context_length: 8192, capabilities: { trained_for_tool_use: true } },
    { type: "llm" as const, publisher: "test", key: "verified-tools", display_name: "Verified tools", size_bytes: 1_200_000_000, loaded_instances: [], max_context_length: 8192, capabilities: {} }
  ];
  const performance = {
    "verified-tools": { samples: 2, successes: 2, successRate: 1, medianLatencyMs: 3000, tokensPerSecond: 15, taskSamples: 1, taskSuccesses: 1, taskSuccessRate: 1 }
  };
  const choice = chooseAgentModel(models, { performanceByModel: performance });
  assert.equal(choice.model.key, "verified-tools");
  assert.match(choice.reason, /selected model lacks a tool-use declaration/);
  assert.match(choice.reason, /observed locally over 1 tasks: 1\/1 verified completions/);
});

test("automatic local model selection prefers LM Studio GPU estimates that fit current free VRAM", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "gpu-selection.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.autoSelect", true);
  const insert = store.db.prepare("INSERT INTO usage(id,session_id,provider,model,input_tokens,output_tokens,duration_ms,details_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)");
  for (let index = 0; index < 3; index++) {
    insert.run(randomUUID(), `preferred-${index}`, "lm-studio", "preferred", 10, 10, 1000, JSON.stringify({ outcome: "success", task_outcome: "verified_success" }), new Date().toISOString());
    insert.run(randomUUID(), `fits-gpu-${index}`, "lm-studio", "fits-gpu", 10, 10, 2000, JSON.stringify({ outcome: "success", task_outcome: "failed" }), new Date().toISOString());
  }
  let loaded = "";
  const inventory = () => [
    { type: "llm" as const, publisher: "test", key: "preferred", display_name: "Preferred", size_bytes: 5 * 1024 ** 3, loaded_instances: loaded === "preferred" ? [{ id: "preferred", config: { context_length: 8192 } }] : [], max_context_length: 8192, capabilities: { trained_for_tool_use: true } },
    { type: "llm" as const, publisher: "test", key: "fits-gpu", display_name: "Fits GPU", size_bytes: 4 * 1024 ** 3, loaded_instances: loaded === "fits-gpu" ? [{ id: "fits-gpu", config: { context_length: 8192 } }] : [], max_context_length: 8192, capabilities: { trained_for_tool_use: true } }
  ];
  const provider = {
    isLocalServer: () => true,
    supportsLocalCliModelLifecycle: () => true,
    models: async () => inventory(),
    estimateLoad: async (model: string) => ({ output: `Estimated GPU Memory: ${model === "preferred" ? 8 : 3} GiB\nEstimated Total Memory: ${model === "preferred" ? 8 : 3} GiB` }),
    load: async (model: string) => { loaded = model; return { status: "loaded" }; },
    redact: (text: string) => text,
    streamChatWithTools: async () => ({ choices: [{ message: { role: "assistant", content: "done" } }], usage: { prompt_tokens: 10, completion_tokens: 1 } })
  };
  const agent = new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never, resourceStatsReader: async () => ({ source: "Xyst host", checkedAt: new Date().toISOString(), systemMemory: { totalBytes: 16 * 1024 ** 3, usedBytes: 8 * 1024 ** 3, availableBytes: 8 * 1024 ** 3, usedPercent: 50 }, nvidiaGpuMemory: { status: "available", source: "nvidia-smi", devices: [{ name: "GPU", totalBytes: 16 * 1024 ** 3, usedBytes: 12 * 1024 ** 3, freeBytes: 4 * 1024 ** 3 }] } }) });
  try {
    const result = await agent.run("Do a small task", { workspace: root });
    assert.equal(result.model, "fits-gpu", "the higher task-success model's LM Studio estimate exceeds live free VRAM");
    assert.match(result.selectionReason, /estimates 3 GiB GPU memory.*4 GiB NVIDIA VRAM is currently free/);
    assert.equal(loaded, "fits-gpu");
  } finally { store.close(); }
}));

test("automatic model selection filters declared context limits using a bounded task estimate", () => {
  assert.equal(modelLoadContextLength(32_768, 6144), 14_336, "local model loads reserve bounded room for additional tool results");
  assert.equal(modelLoadContextLength(8192, 6144), 8192, "headroom is capped at the model's declared maximum");
  assert.equal(modelLoadContextLength(4096, 6144), undefined, "models below the minimum requirement are not loaded with a false context promise");
  const required = estimateRequiredContextTokens([{ content: "x".repeat(35_000) }]);
  assert.equal(required, 16_144);
  assert.equal(estimateRequiredContextTokens([{ content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(100_000)}` } }] }]), 7_168, "image data URLs must not be counted as prompt text");
  assert.equal(estimateRequiredContextTokens([{ content: "short task" }]), 6_147, "short tasks reserve enough room for system prompts, tool schemas, and generation overhead");
  const models = [
    { type: "llm" as const, publisher: "a", key: "loaded-short", display_name: "Loaded short", size_bytes: 2_000_000_000, loaded_instances: [{ id: "short", config: { context_length: 8192 } }], max_context_length: 65536, capabilities: { trained_for_tool_use: true } },
    { type: "llm" as const, publisher: "b", key: "large-context", display_name: "Large context", size_bytes: 3_000_000_000, loaded_instances: [], max_context_length: 32768, capabilities: { trained_for_tool_use: true } }
  ];
  const choice = chooseAgentModel(models, { requiredContextTokens: required });
  assert.equal(choice.model.key, "loaded-short", "the installed model can load a second instance at its declared 65536-token maximum");
  assert.match(choice.reason, /estimated task context 16144 tokens/);
  assert.match(choice.reason, /supports 65536 tokens/);
  assert.match(chooseAgentModel(models, { requiredContextTokens: required, allowLoading: false }).reason, /no candidate declares enough context/);
  assert.throws(() => chooseAgentModel(models, { requiredContextTokens: required, requireDeclaredContext: true, allowLoading: false }), /No installed model declares enough context/);
});

test("Hugging Face context metadata is read from a pinned and bounded config file", async () => {
  let requestedPath = ""; let requestedRange = "";
  const server = createServer((request, response) => {
    requestedPath = request.url ?? "";
    if (requestedPath.includes("/owner/model/tree/")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify([{ type: "file", path: "weights.gguf", size: 6, lfs: { oid: "sha256:" + "a".repeat(64), size: 6, pointerSize: 133 } }]));
      return;
    }
    if (requestedPath.includes("/owner/model/resolve/") && requestedPath.endsWith("/weights.gguf")) {
      requestedRange = request.headers.range ?? "";
      if (requestedRange === "bytes=6-") { response.writeHead(416); response.end(); return; }
      response.writeHead(requestedRange ? 206 : 200, requestedRange ? { "content-range": "bytes 3-5/6" } : undefined); response.end("abc"); return;
    }
    if (requestedPath.includes("/owner/large/resolve/")) { response.writeHead(200, { "content-length": "1000001" }); response.end(); return; }
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ max_position_embeddings: 32768 }));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const provider = new HuggingFaceProvider({ get: async () => undefined } as never, `http://127.0.0.1:${address.port}`);
  try {
    assert.deepEqual(await provider.modelConfig("owner/model", "a".repeat(40)), { max_position_embeddings: 32768 });
    assert.match(requestedPath, /\/owner\/model\/resolve\/a{40}\/config\.json/);
    const files = await provider.files("owner/model", "a".repeat(40));
    assert.equal(files[0]?.rfilename, "weights.gguf");
    assert.equal(files[0]?.lfs?.sha256, "a".repeat(64), "Hub tree responses expose SHA-256 as lfs.oid and sha256-prefixed OIDs are normalized");
    await assert.rejects(() => provider.modelConfig("owner/large", "a".repeat(40)), /1 MB inspection limit/);
    await assert.rejects(() => provider.modelConfig("owner/model", "main"), /pinned Hugging Face commit revision/);
    const ranged = await provider.downloadArtifact("owner/model", "a".repeat(40), "weights.gguf", undefined, 3);
    assert.equal(ranged.status, 206); assert.equal(requestedRange, "bytes=3-");
    const completeRange = await provider.downloadArtifact("owner/model", "a".repeat(40), "weights.gguf", undefined, 6);
    assert.equal(completeRange.status, 416); assert.equal(requestedRange, "bytes=6-");
  } finally { await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose())); }
});

test("SQLite migrations persist sessions and resolve config from most specific source", async () => withTemp(async (root) => {
  const path = join(root, "state.sqlite");
  let store = new XystStore(path); const config = new ConfigStore(store); let sessions = new SessionStore(store);
  const scopes = { project: "repo-1", mission: "mission-1", agent: "agent-1", session: "session-1" };
  config.set("global", "inference.temperature", 0.3);
  config.set("project", "inference.temperature", 0.4, scopes.project);
  config.set("mission", "inference.temperature", 0.5, scopes.mission);
  config.set("agent", "inference.temperature", 0.6, scopes.agent);
  config.set("session", "inference.temperature", 0.7, scopes.session);
  const portableConfig = config.export();
  for (const [source, scopeId, expected] of [
    ["session", scopes.session, 0.7],
    ["agent", scopes.agent, 0.6],
    ["mission", scopes.mission, 0.5],
    ["project", scopes.project, 0.4],
    ["global", "", 0.3]
  ] as const) {
    assert.deepEqual(config.resolve("inference.temperature", scopes), { value: expected, source, scopeId });
    if (source !== "global") assert.equal(config.reset(source, "inference.temperature", scopeId), true);
  }
  assert.deepEqual(Object.keys(portableConfig).sort(), ["agent:agent-1", "global:", "mission:mission-1", "project:repo-1", "session:session-1"]);
  assert.equal(portableConfig["session:session-1"]?.["inference.temperature"], 0.7);
  for (const [scope, scopeId] of [["global", ""], ["project", scopes.project], ["mission", scopes.mission], ["agent", scopes.agent], ["session", scopes.session]] as const) {
    config.resetScope(scope, scopeId);
  }
  config.import(portableConfig);
  assert.deepEqual(config.resolve("inference.temperature", scopes), { value: 0.7, source: "session", scopeId: scopes.session });
  assert.equal(config.reset("session", "inference.temperature", scopes.session), true);
  assert.deepEqual(config.resolve("inference.temperature", scopes), { value: 0.6, source: "agent", scopeId: scopes.agent });
  assert.equal(config.resetScope("global"), 1); assert.equal(config.resolve("inference.temperature"), undefined);
  const id = sessions.create("persistence"); sessions.addMessage(id, "user", "hello");
  const version = store.db.prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get() as { version: number };
  assert.equal(version.version, 15);
  const legacyCallId = randomUUID(); const legacyCloneCallId = randomUUID();
  const legacyTool = store.db.prepare("INSERT INTO tool_calls(id,name,input_json,status,created_at,effect) VALUES(?, ?, '{}', 'completed', ?, 'read')");
  legacyTool.run(legacyCallId, "git_push", new Date().toISOString()); legacyTool.run(legacyCloneCallId, "git_clone", new Date().toISOString());
  store.db.exec("DROP TABLE session_compactions; DELETE FROM schema_migrations WHERE version>=14"); store.close();
  store = new XystStore(path); sessions = new SessionStore(store);
  assert.equal((sessions.messages(id) as Array<{ content: string }>)[0]?.content, "hello"); store.close();
  const reopened = new XystStore(path);
  assert.equal((reopened.db.prepare("SELECT effect FROM tool_calls WHERE id=?").get(legacyCallId) as { effect: string }).effect, "external");
  assert.equal((reopened.db.prepare("SELECT effect FROM tool_calls WHERE id=?").get(legacyCloneCallId) as { effect: string }).effect, "external");
  reopened.close();
}));

test("job inspection aggregates persisted trigger, mission-run, and model-download records", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "jobs.sqlite")); const jobs = new JobStore(store); const now = new Date().toISOString();
  const missionId = randomUUID(); const runId = randomUUID(); const triggerId = randomUUID(); const downloadId = randomUUID(); const lmJobId = "lm-job-17";
  try {
    store.db.prepare("INSERT INTO missions(id,definition_json,status,created_at,updated_at) VALUES(?,?,'active',?,?)").run(missionId, JSON.stringify({ name: "Persisted job inspection" }), now, now);
    store.db.prepare("INSERT INTO mission_runs(id,mission_id,state,trigger_type,started_at,heartbeat_at) VALUES(?,?, 'running','manual',?,?)").run(runId, missionId, now, now);
    store.db.prepare("INSERT INTO jobs(id,kind,state,details_json,created_at,updated_at) VALUES(?,'github-trigger','queued',?,?,?)").run(triggerId, JSON.stringify({ repository: "owner/repo", issueNumber: 9 }), now, now);
    store.db.prepare("INSERT INTO model_downloads(id,repository,revision,quantization,lm_job_id,state,total_size_bytes,details_json,created_at,updated_at) VALUES(?,?,?,'Q4_K_M',?,'downloading',1024,?,?,?)").run(downloadId, "owner/model", "a".repeat(40), lmJobId, JSON.stringify({ artifact: "model-Q4_K_M.gguf" }), now, now);
    const rows = jobs.list(10);
    assert.deepEqual(new Set(rows.map((row) => row.kind)), new Set(["github-trigger", "mission-run", "model-download"]));
    assert.equal((jobs.show(triggerId)?.details as { repository: string }).repository, "owner/repo");
    assert.equal(jobs.show(runId)?.kind, "mission-run");
    assert.equal((jobs.show(lmJobId)?.details as { repository: string }).repository, "owner/model");
    assert.equal(jobs.list(1).length, 1);
    assert.equal(jobs.show("missing"), undefined);
    const processId = jobs.createProcess("node", ["-e", "console.log('private args')"], root, true);
    assert.deepEqual(jobs.processSpec(processId), { command: "node", args: ["-e", "console.log('private args')"], cwd: root, interactive: true, pty: false, cols: 80, rows: 24 });
    assert.equal((jobs.show(processId)?.details as Record<string, unknown>).args, undefined);
    jobs.sendProcessInput(processId, "hello\n"); jobs.sendProcessInput(processId, "", true);
    assert.deepEqual(jobs.takeProcessInputs(processId), [{ input: "hello\n", closeStdin: false }, { input: "", closeStdin: true }]);
    assert.deepEqual(jobs.takeProcessInputs(processId), []);
    assert.throws(() => jobs.sendProcessInput(processId, "after EOF"), /already been closed/);
    assert.equal(jobs.requestProcessCancel(processId), true);
    assert.equal(jobs.processCancelRequested(processId), true);
    jobs.updateProcess(processId, "cancelled", { exitCode: null });
    assert.equal(jobs.requestProcessCancel(processId), false);
    assert.equal(jobs.show(processId)?.state, "cancelled");
    assert.equal(jobs.list(10).some((job) => job.id === processId), true);
    const terminalId = jobs.createProcess("bash", ["-l"], root, true, true, 100, 30);
    assert.deepEqual(jobs.processSpec(terminalId), { command: "bash", args: ["-l"], cwd: root, interactive: true, pty: true, cols: 100, rows: 30 });
    jobs.resizeProcess(terminalId, 120, 40);
    assert.deepEqual(jobs.takeProcessResize(terminalId), { cols: 120, rows: 40 });
    assert.equal(jobs.takeProcessResize(terminalId), undefined);
    assert.throws(() => jobs.resizeProcess(terminalId, 5, 300), /20–500 columns by 5–200 rows/);
    assert.throws(() => jobs.createProcess("bash", [], root, false, true), /must accept interactive input/);
  } finally { store.close(); }
}));

test("interactive process schema migrations upgrade existing process-job databases", async () => withTemp(async (root) => {
  const path = join(root, "process-upgrade.sqlite"); const oldStore = new XystStore(path); const oldJobs = new JobStore(oldStore);
  const existingId = oldJobs.createProcess("node", [], root);
  oldStore.db.exec("DROP TABLE session_compactions; DROP TABLE process_job_inputs; DROP TABLE process_job_resizes; ALTER TABLE process_job_specs DROP COLUMN pty; ALTER TABLE process_job_specs DROP COLUMN cols; ALTER TABLE process_job_specs DROP COLUMN rows; ALTER TABLE process_job_specs DROP COLUMN interactive; ALTER TABLE process_job_control DROP COLUMN stdin_close_requested; DELETE FROM schema_migrations WHERE version>=11");
  oldStore.close();
  const store = new XystStore(path); const jobs = new JobStore(store);
  try {
    assert.equal((store.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version, 15);
    assert.deepEqual(jobs.processSpec(existingId), { command: "node", args: [], cwd: root, interactive: false, pty: false, cols: 80, rows: 24 });
    const interactiveId = jobs.createProcess("node", [], root, true);
    jobs.sendProcessInput(interactiveId, "upgrade ok");
    assert.deepEqual(jobs.takeProcessInputs(interactiveId), [{ input: "upgrade ok", closeStdin: false }]);
  } finally { store.close(); }
}));

test("saved sessions rename, fork structured history, export, archive, and delete without breaking mission history", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "session-lifecycle.sqlite")); const sessions = new SessionStore(store);
  try {
    const source = sessions.create("Original"); sessions.addMessage(source, "user", "task");
    sessions.addMessage(source, "assistant", `__xyst_api_message__:${JSON.stringify({ role: "assistant", content: "answer" })}`);
    const originalMessages = sessions.messages(source) as Array<{ id: string }>; sessions.addCompaction(source, originalMessages[1]!.id, { primary_goal: "task" });
    sessions.rename(source, "Renamed");
    const fork = sessions.fork(source); assert.notEqual(fork, source);
    assert.deepEqual((sessions.messages(fork) as Array<{ role: string }>).map((message) => message.role), ["user", "assistant"]);
    const exported = sessions.export(fork) as { format: string; session: { title: string }; messages: Array<{ content: unknown }> };
    assert.equal(exported.format, "xyst-session-v1"); assert.equal(exported.session.title, "Renamed (fork)"); assert.deepEqual(exported.messages[1]!.content, { role: "assistant", content: "answer" });
    const now = new Date().toISOString();
    store.db.prepare("INSERT INTO missions(id,definition_json,status,created_at,updated_at) VALUES('m','{}','active',?,?)").run(now, now);
    store.db.prepare("INSERT INTO mission_runs(id,mission_id,state,trigger_type,started_at,heartbeat_at) VALUES('r','m','completed','manual',?,?)").run(now, now);
    store.db.prepare("INSERT INTO mission_tasks(run_id,mission_id,task_key,objective,dependencies_json,state,attempts,session_id,updated_at) VALUES('r','m','t','task','[]','completed',1,?,?)").run(fork, now);
    await assert.rejects(async () => sessions.delete(fork), /belongs to a mission task/);
    sessions.archive(fork); assert.equal((sessions.list() as Array<{ id: string; status: string }>).find((item) => item.id === fork)?.status, "archived");
    sessions.delete(source); assert.equal((sessions.list() as Array<{ id: string }>).some((item) => item.id === source), false);
    assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM session_compactions WHERE session_id=?").get(source) as { count: number }).count, 0);
  } finally { store.close(); }
}));

test("session compaction persists a resumable summary and preserves raw history and paired tool evidence", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "session-compaction.sqlite")); const sessions = new SessionStore(store); const sessionId = sessions.create("Long work");
  const callId = "tool-pair-1"; const now = new Date().toISOString(); let capturedPayload: Record<string, unknown> | undefined;
  const append = (role: "user" | "assistant" | "tool", value: Record<string, unknown>) => sessions.addMessage(sessionId, role, `__xyst_api_message__:${JSON.stringify(value)}`);
  const response = { choices: [{ message: { content: JSON.stringify({ decisions: ["Use persistent summaries"], dependencies: [], completed_work: ["Reviewed the prior turns"], outstanding_actions: ["failed task_complete [tool call failed-read-action]"], durable_facts: ["Original transcript remains available"] }) } }] };
  const provider = {
    isLocalServer: () => true,
    models: async () => [{ type: "llm", key: "local-test", size_bytes: 1_000_000, loaded_instances: [], max_context_length: 8192 }],
    structuredOutput: async (options: { messages: Array<{ role: string; content: string }> }) => { capturedPayload = JSON.parse(options.messages[1]!.content) as Record<string, unknown>; return response; },
    redact: (value: string) => value
  };
  try {
    append("user", { role: "user", content: "Please finish the Xyst build and retain this primary goal." });
    append("assistant", { role: "assistant", content: null, tool_calls: [{ id: callId, type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "README.md" }) } }] });
    append("tool", { role: "tool", tool_call_id: callId, content: "README contents inspected" });
    append("assistant", { role: "assistant", content: "The read completed." });
    append("user", { role: "user", content: "Decision: keep original session messages for export." }); append("assistant", { role: "assistant", content: "Recorded." });
    append("user", { role: "user", content: "Task B depends on Task A." }); append("assistant", { role: "assistant", content: "Dependency recorded." });
    append("user", { role: "user", content: "Recent turn one." }); append("assistant", { role: "assistant", content: "Acknowledged." });
    append("user", { role: "user", content: "Recent turn two." }); append("assistant", { role: "assistant", content: "Still available in the tail." });
    store.db.prepare("INSERT INTO tool_calls(id,session_id,name,input_json,output_json,status,created_at,effect) VALUES(?,?,?,?,?,'completed',?,'read')").run(callId, sessionId, "file_read", JSON.stringify({ path: "README.md" }), "README contents inspected", now);
    store.db.prepare("INSERT INTO tool_calls(id,session_id,name,input_json,output_json,status,created_at,effect) VALUES('failed-read-action',?,'task_complete','{}','{\"error\":\"evidence incomplete\"}','failed',?,'read')").run(sessionId, now);
    store.db.prepare("INSERT INTO tool_calls(id,session_id,name,input_json,status,created_at,effect) VALUES('uncertain-action',?,'github_create_pull_request','{}','uncertain',?,'external')").run(sessionId, now);
    store.db.prepare("INSERT INTO missions(id,definition_json,status,created_at,updated_at) VALUES('mission-compaction','{}','active',?,?)").run(now, now);
    store.db.prepare("INSERT INTO mission_runs(id,mission_id,state,trigger_type,started_at,heartbeat_at) VALUES('run-compaction','mission-compaction','running','manual',?,?)").run(now, now);
    store.db.prepare("INSERT INTO mission_tasks(run_id,mission_id,task_key,objective,dependencies_json,state,attempts,session_id,updated_at) VALUES('run-compaction','mission-compaction','task-b','Finish B',?,'running',1,?,?)").run(JSON.stringify(["task-a"]), sessionId, now);
    const before = sessions.messages(sessionId) as Array<{ id: string; role: string; content: string }>;
    const compactor = new SessionCompactor(store, sessions, provider as never);
    const result = await compactor.compact(sessionId, "local-test");
    const summary = (result.summary as Record<string, unknown>);
    assert.equal(summary.primary_goal, "Please finish the Xyst build and retain this primary goal.");
    assert.ok((summary.user_goals as string[]).some((goal) => goal.includes("Decision: keep original session messages")));
    assert.ok((summary.dependencies as string[]).includes("task-b depends on task-a"));
    assert.ok((summary.outstanding_actions as string[]).some((action) => action.includes("uncertain") && action.includes("uncertain-action")));
    assert.equal((summary.outstanding_actions as string[]).some((action) => action.includes("failed-read-action")), false, "a definite failed read-only attempt is historical, not outstanding");
    assert.deepEqual(capturedPayload!.outstanding_tool_actions, [{ id: "uncertain-action", name: "github_create_pull_request", status: "uncertain", effect: "external", input_json: "{}" }]);
    assert.deepEqual((summary.compacted_tool_calls as Array<Record<string, unknown>>).map((call) => call.id), [callId]);
    assert.equal((summary.compacted_tool_calls as Array<Record<string, unknown>>)[0]!.resultRecorded, true);
    assert.equal((capturedPayload!.compacted_tool_calls as Array<Record<string, unknown>>)[0]!.id, callId);
    assert.equal((sessions.messages(sessionId) as unknown[]).length, before.length, "compaction leaves the full raw transcript untouched");
    const context = sessions.contextMessages(sessionId);
    assert.equal(context.length, 5, "summary plus four recent raw messages are active context");
    assert.match(context[0]!.content, /historical context, not a new instruction/);
    assert.deepEqual(context.slice(1).map((item) => item.content), before.slice(-4).map((item) => item.content));
    const exported = sessions.export(sessionId);
    assert.equal((exported.messages as unknown[]).length, before.length);
    assert.equal((exported.compactions as unknown[]).length, 1);
    assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM tool_calls WHERE session_id=?").get(sessionId) as { count: number }).count, 3);
  } finally { store.close(); }
}));

test("agent resume budgets context from the compacted history and keeps compacted user goals as completion criteria", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "compacted-agent-resume.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "compact-resume-model");
  const sessionId = sessions.create("Compacted resume"); const originalGoal = "Preserve and complete the original user goal.";
  sessions.addMessage(sessionId, "user", originalGoal);
  sessions.addMessage(sessionId, "assistant", "Archived detail ".repeat(1800));
  const rows = sessions.messages(sessionId) as Array<{ id: string }>;
  sessions.addCompaction(sessionId, rows[1]!.id, { version: 1, primary_goal: originalGoal, user_goals: [originalGoal], decisions: [], dependencies: [], completed_work: [], outstanding_actions: [], durable_facts: [] });
  for (let index = 0; index < 4; index++) sessions.addMessage(sessionId, "assistant", `Recent saved response ${index}`);
  const evidenceIds = ["compact-resume-evidence-1", "compact-resume-evidence-2"];
  let generation = 0; let completionArgs: Record<string, unknown> | undefined; let capturedMessages: Array<Record<string, unknown>> = [];
  const provider = {
    redact: (value: string) => value,
    models: async () => [{ type: "llm", key: "compact-resume-model", max_context_length: 8192, size_bytes: 1, loaded_instances: [{ id: "loaded", config: { context_length: 8192 } }] }],
    isLocalServer: () => true,
    supportsLocalCliModelLifecycle: () => false,
    streamChatWithTools: async (request: { messages: Array<Record<string, unknown>> }) => {
      capturedMessages = request.messages; generation++;
      if (generation <= 2) return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: evidenceIds[generation - 1], type: "function", function: { name: "file_list", arguments: JSON.stringify({ path: root }) } }] } }] };
      if (generation === 3) {
        completionArgs = { evidence_tool_call_indexes: [1, 2] };
        return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "compact-resume-complete", type: "function", function: { name: "task_complete", arguments: JSON.stringify(completionArgs) } }] } }] };
      }
      return { choices: [{ message: { role: "assistant", content: "The compacted session resumed successfully." } }] };
    }
  };
  const agent = new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never });
  try {
    const result = await agent.run("Continue the work after compaction.", { sessionId, model: "compact-resume-model", workspace: root, maxTurns: 5 });
    assert.equal(result.status, "completed");
    assert.equal(generation, 3);
    assert.deepEqual(completionArgs?.evidence_tool_call_indexes, [1, 2]);
    assert.ok(capturedMessages.some((message) => JSON.stringify(message).includes("Required completion criteria (runtime-defined")));
    assert.equal(JSON.stringify(capturedMessages).includes("Archived detail"), false, "inference uses summary plus post-boundary messages, not the archived raw transcript");
    assert.ok(capturedMessages.some((message) => JSON.stringify(message).includes(originalGoal)), "the saved summary remains in resume context");
    assert.equal((sessions.messages(sessionId) as unknown[]).length, 14, "resume preserves every original message while appending new turns");
  } finally { store.close(); }
}));

test("session compaction refuses prefixes containing images or unpaired tool calls", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "session-compaction-unsafe.sqlite")); const sessions = new SessionStore(store);
  const provider = { isLocalServer: () => true, models: async () => [{ type: "llm", key: "local-test", size_bytes: 1, loaded_instances: [], max_context_length: 8192 }], structuredOutput: async () => assert.fail("unsafe history must not be summarized"), redact: (value: string) => value };
  try {
    const imageSession = sessions.create("Image history");
    sessions.addMessage(imageSession, "user", `__xyst_api_message__:${JSON.stringify({ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] })}`);
    for (let i = 0; i < 5; i++) { sessions.addMessage(imageSession, "assistant", `__xyst_api_message__:${JSON.stringify({ role: "assistant", content: `turn ${i}` })}`); sessions.addMessage(imageSession, "user", `turn ${i}`); }
    const incompleteSession = sessions.create("Incomplete tool history");
    sessions.addMessage(incompleteSession, "user", "objective");
    sessions.addMessage(incompleteSession, "assistant", `__xyst_api_message__:${JSON.stringify({ role: "assistant", content: null, tool_calls: [{ id: "missing-result", type: "function", function: { name: "file_read", arguments: "{}" } }] })}`);
    for (let i = 0; i < 5; i++) { sessions.addMessage(incompleteSession, "assistant", `__xyst_api_message__:${JSON.stringify({ role: "assistant", content: `turn ${i}` })}`); sessions.addMessage(incompleteSession, "user", `turn ${i}`); }
    const compactor = new SessionCompactor(store, sessions, provider as never);
    const remoteCompactor = new SessionCompactor(store, sessions, { ...provider, isLocalServer: () => false } as never);
    await assert.rejects(remoteCompactor.compact(imageSession, "local-test"), /disabled for remote LM Studio endpoints/);
    await assert.rejects(compactor.compact(imageSession, "local-test"), /No safe completed-turn prefix/);
    await assert.rejects(compactor.compact(incompleteSession, "local-test"), /No safe completed-turn prefix/);
    assert.equal(sessions.compactions(imageSession).length, 0); assert.equal(sessions.compactions(incompleteSession).length, 0);
  } finally { store.close(); }
}));

test("concurrent first-run processes serialize SQLite migrations", async () => withTemp(async (root) => {
  const path = join(root, "shared.sqlite");
  const storageUrl = new URL("./storage.ts", import.meta.url).href;
  const source = `import { XystStore } from ${JSON.stringify(storageUrl)}; const store = new XystStore(process.argv[1]); store.close();`;
  const openStore = () => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", source, path], { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject); child.once("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `SQLite initializer exited with code ${code}`)));
  });
  const outcomes = await Promise.allSettled(Array.from({ length: 8 }, openStore));
  const failures = outcomes.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.equal(failures.length, 0, failures.map((failure) => String(failure.reason)).join("\n"));
  const store = new XystStore(path);
  assert.equal((store.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version, 15);
  store.close();
}));

test("config export excludes secret-like keys", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "settings.sqlite")); const config = new ConfigStore(store);
  config.set("global", "service.endpoint", "http://localhost"); config.set("global", "LM_API_TOKEN", "do-not-export");
  const exported = config.export(); assert.deepEqual(exported["global:"], { "service.endpoint": "http://localhost" }); store.close();
}));

test("config import and export exclude settings with nested credential fields", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "nested-secret-settings.sqlite")); const config = new ConfigStore(store);
  try {
    config.set("global", "service.endpoint", "https://service.example.test");
    config.set("global", "service.options", { retries: 2, auth: { Authorization: "Bearer do-not-export" } });
    config.set("global", "service.proxy", "https://user:password@proxy.example.test");
    assert.deepEqual(config.export()["global:"], { "service.endpoint": "https://service.example.test" });

    config.import({ "project:project-a": {
      "service.timeout": 30,
      "service.headers": { Accept: "application/json", "X-Api-Key": "do-not-import" }
    } });
    assert.equal(config.resolve("service.timeout", { project: "project-a" })?.value, 30);
    assert.equal(config.resolve("service.headers", { project: "project-a" }), undefined);
  } finally { store.close(); }
}));

test("update settings require explicit opt-in and a credential-free HTTPS feed", () => {
  assert.doesNotThrow(() => validateSettingValue("integrations.lmStudio.nativeChat.enabled", false));
  assert.throws(() => validateSettingValue("integrations.lmStudio.nativeChat.enabled", "true"), /must be true or false/);
  assert.doesNotThrow(() => validateSettingValue("integrations.lmStudio.nativeChat.integrations", []));
  assert.throws(() => validateSettingValue("integrations.lmStudio.nativeChat.integrations", [{ type: "ephemeral_mcp", server_label: "inline-secret", server_url: "https://mcp.example.test/mcp", headers: { Authorization: "raw-token" } }]));
  assert.doesNotThrow(() => validateSettingValue("updates.enabled", false));
  assert.doesNotThrow(() => validateSettingValue("updates.autoDownload", true));
  assert.doesNotThrow(() => validateSettingValue("updates.feedUrl", "https://updates.example.com/xyst"));
  assert.doesNotThrow(() => validateSettingValue("updates.feedUrl", null));
  assert.doesNotThrow(() => validateSettingValue("documents.ocrLanguages", ["eng", "fra", "deu", "spa"]));
  assert.throws(() => validateSettingValue("documents.ocrLanguages", ["eng", "xx"]), /supported language codes/);
  assert.throws(() => validateSettingValue("documents.ocrLanguages", ["eng", "eng"]), /supported language codes/);
  assert.doesNotThrow(() => validateSettingValue("documents.officeRendererExecutable", "soffice"));
  assert.doesNotThrow(() => validateSettingValue("documents.officeRendererExecutable", null));
  assert.doesNotThrow(() => validateSettingValue("models.allowedLicenses", ["mit", "apache-2.0"]));
  assert.throws(() => validateSettingValue("models.allowedLicenses", ["MIT"]), /unique lowercase Hugging Face license tags/);
  assert.throws(() => validateSettingValue("models.allowedLicenses", ["mit", "mit"]), /unique lowercase Hugging Face license tags/);
  assert.throws(() => validateSettingValue("documents.officeRendererExecutable", ""), /non-empty executable name or path/);
  assert.throws(() => validateSettingValue("updates.enabled", "true"), /must be true or false/);
  assert.throws(() => validateSettingValue("updates.autoDownload", 1), /must be true or false/);
  for (const value of ["http://updates.example.com", "https://user:pass@updates.example.com", "https://updates.example.com?token=secret", "not a url"]) {
    assert.throws(() => validateSettingValue("updates.feedUrl", value), /HTTPS base URL/);
  }
});

test("known settings reject invalid values and imports roll back atomically", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "validated-settings.sqlite")); const config = new ConfigStore(store);
  try {
    config.set("global", "inference.temperature", 0.5);
    config.set("global", "access.profile", { mode: "restricted", readRoots: [], writeRoots: [], allowedExecutables: [], network: false, integrations: false, backgroundJobs: false, externalActions: false });
    assert.throws(() => config.set("global", "access.profile", { mode: "restricted", network: true, allowAnything: true }), /access.profile contains an unsupported field/);
    assert.throws(() => config.set("global", "access.profile", { mode: "restricted", readRoots: [""] }), /access.profile.readRoots/);
    assert.throws(() => config.set("global", "inference.temperature", 2.1), /inference.temperature must be a number/);
    assert.throws(() => config.set("global", "inference.topK", 0), /inference.topK must be an integer/);
    assert.throws(() => config.set("global", "inference.repeatPenalty", 0), /inference.repeatPenalty must be a number/);
    config.set("global", "inference.reasoning", "high");
    assert.deepEqual(config.resolve("inference.reasoning"), { value: "high", source: "global", scopeId: "" });
    assert.throws(() => config.set("global", "inference.reasoning", "extreme"), /inference.reasoning must be off, low, medium, high, on, or null/);
    assert.throws(() => config.set("global", "inference.maxTokens", 1.5), /inference.maxTokens must be an integer/);
    assert.throws(() => config.set("global", "inference.requestTimeoutSeconds", 4), /inference.requestTimeoutSeconds must be an integer from 5 through 3600/);
    config.set("global", "inference.requestTimeoutSeconds", 45);
    assert.equal(config.resolve<number>("inference.requestTimeoutSeconds")?.value, 45);
    assert.throws(() => config.set("global", "tools.maxParallelReads", 0), /tools.maxParallelReads must be an integer from 1 through 8/);
    config.set("global", "tools.maxParallelReads", 5);
    assert.equal(config.resolve<number>("tools.maxParallelReads")?.value, 5);
    assert.throws(() => config.set("global", "orchestration.delegation.enabled", "no"), /orchestration.delegation.enabled must be true or false/);
    assert.throws(() => config.set("global", "autonomy.externalActionApproval", "no"), /autonomy.externalActionApproval must be true or false/);
    assert.throws(() => config.set("global", "network.enabled", "no"), /network.enabled must be true or false/);
    assert.throws(() => config.set("global", "notifications.enabled", "no"), /notifications.enabled must be true or false/);
    assert.throws(() => config.import({ "global:": { "inference.topP": 0.8, "orchestration.maxConcurrency": 0 } }), /orchestration.maxConcurrency must be an integer/);
    assert.deepEqual(config.resolve("inference.temperature"), { value: 0.5, source: "global", scopeId: "" });
    assert.equal(config.resolve("inference.topP"), undefined);
  } finally { store.close(); }
}));

test("external action approval blocks side effects when denied and permits one approved action", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "external-approval.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model"); config.set("global", "autonomy.externalActionApproval", true);
  let round = 0;
  const provider = {
    redact: (value: string) => value,
    streamChatWithTools: async (request: { messages: Array<Record<string, unknown>> }) => {
      const systemMessage = request.messages.find((message) => message.role === "system");
      assert.match(String(systemMessage?.content ?? ""), /execute those actions with the relevant tools instead of returning suggested commands/);
      round++;
      return round === 1
        ? { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: `create-${round}-${randomUUID()}`, type: "function", function: { name: "file_create", arguments: JSON.stringify({ path: "approved.txt", content: "created" }) } }] } }] }
        : { choices: [{ message: { role: "assistant", content: "Done" } }] };
    }
  };
  const agent = new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never });
  try {
    let promptCount = 0;
    await assert.rejects(() => agent.run("Create the file", { workspace: root, approveExternalAction: async (request) => { promptCount++; assert.equal(request.toolName, "file_create"); assert.match(request.argumentsJson, /approved.txt/); return false; } }), /EXTERNAL_ACTION_DENIED/);
    assert.equal(promptCount, 1); assert.equal(existsSync(join(root, "approved.txt")), false);
    assert.equal((store.db.prepare("SELECT status FROM tool_calls WHERE name='file_create'").get() as { status: string }).status, "failed");
    round = 0;
    await agent.run("Create the file", { workspace: root, approveExternalAction: async () => true });
    assert.equal((await readFileAsync(join(root, "approved.txt"), "utf8")), "created");
    assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM tool_calls WHERE name='file_create' AND status='completed'").get() as { count: number }).count, 1);
    const artifact = store.db.prepare("SELECT name,path,mime_type,metadata_json FROM artifacts WHERE session_id=(SELECT session_id FROM tool_calls WHERE name='file_create' AND status='completed' ORDER BY created_at DESC LIMIT 1)").get() as { name: string; path: string; mime_type: string; metadata_json: string };
    assert.deepEqual({ name: artifact.name, path: artifact.path, mime_type: artifact.mime_type }, { name: "approved.txt", path: join(root, "approved.txt"), mime_type: "text/plain" });
    assert.equal(JSON.parse(artifact.metadata_json).tool, "file_create");
  } finally { store.close(); }
}));

test("agent completion requires successful persisted tool evidence", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "completion-evidence.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model");
  let round = 0; let evidenceId = ""; let invalidEvidence = true; let completionDefinition: unknown; let completionSystemWithEvidence = "";
  const provider = {
    redact: (value: string) => value,
    streamChatWithTools: async (request: { tools: Array<Record<string, unknown>>; messages: Array<Record<string, unknown>> }) => {
      completionDefinition ??= request.tools.find((tool) => (tool.function as Record<string, unknown>)?.name === "task_complete");
      round++;
      if (round % 3 === 2) completionSystemWithEvidence = String(request.messages.find((message) => message.role === "system")?.content ?? "");
      if (round % 3 === 1) {
        evidenceId = `evidence-${randomUUID()}`;
        return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: evidenceId, type: "function", function: { name: "file_list", arguments: JSON.stringify({ path: root }) } }] } }] };
      }
      if (round % 3 === 2) {
        return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: `completion-${randomUUID()}`, type: "function", function: { name: "task_complete", arguments: JSON.stringify({ evidence_tool_call_indexes: [invalidEvidence ? 99 : 1] }) } }] } }] };
      }
      return { choices: [{ message: { role: "assistant", content: "The workspace inventory is ready." } }] };
    }
  };
  const agent = new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never });
  try {
    const rejected = await agent.run("List files in the workspace", { workspace: root, maxTurns: 4 });
    assert.equal(rejected.status, "unverified");
    assert.equal((store.db.prepare("SELECT status FROM tool_calls WHERE session_id=? AND name='task_complete'").get(rejected.sessionId) as { status: string }).status, "failed");
    assert.equal(JSON.parse((store.db.prepare("SELECT details_json FROM usage WHERE session_id=? ORDER BY rowid DESC LIMIT 1").get(rejected.sessionId) as { details_json: string }).details_json).task_outcome, "unverified");
    invalidEvidence = false; round = 0;
    const verified = await agent.run("List files in the workspace", { workspace: root, maxTurns: 4 });
    assert.equal(verified.status, "completed");
    assert.doesNotMatch(JSON.stringify(completionDefinition), /"criteria"/, "the model cannot replace or paraphrase runtime-defined criteria");
    assert.ok(completionSystemWithEvidence.includes("Available persisted evidence call indexes"));
    assert.ok(completionSystemWithEvidence.includes("retrieve live information from an available web source or integration"));
    assert.ok(completionSystemWithEvidence.includes('1: "file_list"'), "one-based indexes and safe tool names are shown to the model");
    assert.equal(round, 2, "successful verification ends the run without another inference turn");
    assert.equal(JSON.parse((store.db.prepare("SELECT details_json FROM usage WHERE session_id=? ORDER BY rowid DESC LIMIT 1").get(verified.sessionId) as { details_json: string }).details_json).task_outcome, "verified_success");
    const checked = store.db.prepare("SELECT output_json FROM tool_calls WHERE session_id=? AND name='task_complete' AND status='completed'").get(verified.sessionId) as { output_json: string };
    assert.equal(JSON.parse(checked.output_json).verified, true);
  } finally { store.close(); }
}));

test("office preview result sends the rendered PNG pixels to the next model request", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "office-preview-vision.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model");
  const pdf = await PDFDocument.create(); const page = pdf.addPage([180, 80]); page.drawText("VISION TEST", { x: 20, y: 35 });
  await writeFile(join(root, "vision.pdf"), await pdf.save());
  let round = 0;
  const provider = {
    redact: (value: string) => value,
    streamChatWithTools: async (request: { messages: Array<{ role: string; content?: unknown }>; tools: Array<Record<string, unknown>> }) => {
      round++;
      if (round === 1) return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "preview-page", type: "function", function: { name: "office_preview", arguments: JSON.stringify({ path: "vision.pdf", page: 1, output_path: "vision.png" }) } }] } }] };
      const offeredTools = request.tools.map((tool) => String((tool.function as Record<string, unknown>)?.name));
      assert.deepEqual(offeredTools, ["office_read", "office_preview", "task_complete"]);
      const previewResult = request.messages.find((message) => message.role === "tool" && Array.isArray(message.content) && message.content.some((part) => Boolean(part && typeof part === "object" && (part as Record<string, unknown>).type === "image_url")));
      assert.ok(previewResult, "office_preview's next-turn tool message should include multimodal image content");
      const parts = previewResult!.content as Array<Record<string, any>>;
      const imageUrl = parts.find((part) => part.type === "image_url")?.image_url?.url;
      const previewBytes = await readFileAsync(join(root, "vision.png"));
      assert.equal(imageUrl, `data:image/png;base64,${previewBytes.toString("base64")}`);
      assert.match(String(parts.find((part) => part.type === "text")?.text), /vision\.png/);
      if (round === 2) return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "forbidden-delete", type: "function", function: { name: "file_delete", arguments: JSON.stringify({ path: "vision.pdf" }) } }] } }] };
      assert.match(String(request.messages.at(-1)?.content), /not allowed for this task/);
      return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "preview-complete", type: "function", function: { name: "task_complete", arguments: JSON.stringify({ evidence_tool_call_indexes: [1] }) } }] } }] };
    }
  };
  try {
    const result = await new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never })
      .run("Inspect the rendered preview", { workspace: root, model: "test-model", maxTurns: 4, allowedTools: ["office_read", "office_preview"], completionCriteria: ["Inspect the rendered preview"], requiredToolEvidence: [{ tool: "office_preview" }] });
    assert.equal(result.status, "completed"); assert.equal(round, 3);
  } finally { store.close(); }
}));

test("office preview does not stale the source PDF readback evidence", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "office-preview-read-evidence.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model");
  const expectedPath = join(root, "vision.pdf"); const pdf = await PDFDocument.create(); pdf.addPage([180, 80]).drawText("VISION SOURCE READBACK", { x: 20, y: 35 }); await writeFile(expectedPath, await pdf.save());
  let round = 0;
  const provider = {
    redact: (value: string) => value,
    streamChatWithTools: async (request: { messages: Array<{ role: string; content?: unknown }> }) => {
      round++;
      if (round === 1) return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "read-source-pdf", type: "function", function: { name: "office_read", arguments: JSON.stringify({ format: "pdf", path: "vision.pdf" }) } }] } }] };
      if (round === 2) return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "preview-source-pdf", type: "function", function: { name: "office_preview", arguments: JSON.stringify({ path: "vision.pdf", page: 1, output_path: "vision.png" }) } }] } }] };
      const previewMessage = request.messages.find((message) => message.role === "tool" && Array.isArray(message.content) && message.content.some((part) => Boolean(part && typeof part === "object" && (part as Record<string, unknown>).type === "image_url")));
      assert.ok(previewMessage, "preview pixels must still reach the model after PDF readback");
      return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "complete-source-preview", type: "function", function: { name: "task_complete", arguments: JSON.stringify({ evidence_tool_call_indexes: [2, 1] }) } }] } }] };
    }
  };
  try {
    const result = await new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never })
      .run("Review the declared PDF and its rendered preview.", { workspace: root, model: "test-model", maxTurns: 4, completionCriteria: [expectedPath], expectedOutputPaths: [expectedPath], requiredToolEvidence: [{ tool: "office_preview" }] });
    assert.equal(result.status, "completed"); assert.equal(round, 3);
    const completion = store.db.prepare("SELECT output_json FROM tool_calls WHERE session_id=? AND name='task_complete' AND status='completed'").get(result.sessionId) as { output_json: string };
    assert.equal(JSON.parse(completion.output_json).verified, true);
  } finally { store.close(); }
}));

test("agent completion for a requested command requires successful process evidence", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "command-completion-evidence.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model");
  let turn = 0;
  const provider = {
    redact: (value: string) => value,
    streamChatWithTools: async () => {
      turn++;
      if (turn === 1) return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "command-evidence-list", type: "function", function: { name: "file_list", arguments: JSON.stringify({ path: root }) } }] } }] };
      if (turn === 2) return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "command-evidence-incomplete", type: "function", function: { name: "task_complete", arguments: JSON.stringify({ evidence_tool_call_indexes: [1] }) } }] } }] };
      if (turn === 3) return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "command-evidence-process", type: "function", function: { name: "run_process", arguments: JSON.stringify({ executable: process.execPath, args: ["-e", "process.stdout.write('COMMAND_OK')"], cwd: root }) } }] } }] };
      return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "command-evidence-complete", type: "function", function: { name: "task_complete", arguments: JSON.stringify({ evidence_tool_call_indexes: [2, 1] }) } }] } }] };
    }
  };
  try {
    const result = await new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never }).run("Run a Node command that prints COMMAND_OK.", { workspace: root, maxTurns: 4 });
    assert.equal(result.status, "completed");
    const failedCompletion = store.db.prepare("SELECT output_json FROM tool_calls WHERE session_id=? AND name='task_complete' AND status='failed'").get(result.sessionId) as { output_json: string };
    assert.match(failedCompletion.output_json, /run_process must come from run_process/);
    const completed = store.db.prepare("SELECT output_json FROM tool_calls WHERE session_id=? AND name='task_complete' AND status='completed'").get(result.sessionId) as { output_json: string };
    const checks = JSON.parse(completed.output_json).checks as Array<{ tool: string }>;
    assert.equal(checks[0]?.tool, "file_list", "general objective evidence remains first");
    assert.equal(checks[1]?.tool, "run_process", "the requested command needs its own successful process result");
  } finally { store.close(); }
}));

test("agent resume retains requested command evidence requirements from the original user goal", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "resumed-command-completion.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model");
  let turn = 0;
  const response = (id: string, name: string, args: Record<string, unknown>) => ({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
  const provider = {
    redact: (value: string) => value,
    streamChatWithTools: async () => {
      turn++;
      if (turn === 1) return response("resume-command-process", "run_process", { executable: process.execPath, args: ["-e", "process.stdout.write('RESUMED_COMMAND_OK')"], cwd: root });
      if (turn === 2) return response("resume-command-list", "file_list", { path: root });
      if (turn === 3) return response("resume-command-incomplete", "task_complete", { evidence_tool_call_indexes: [1] });
      return response("resume-command-complete", "task_complete", { evidence_tool_call_indexes: [1, 2] });
    }
  };
  const runner = new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never });
  try {
    const first = await runner.run("Run a Node command that prints RESUMED_COMMAND_OK.", { workspace: root, maxTurns: 1 });
    assert.equal(first.status, "limit");
    const resumed = await runner.run("Inspect the workspace and finish the requested work.", { workspace: root, sessionId: first.sessionId, maxTurns: 4 });
    assert.equal(resumed.status, "completed");
    const failedCompletion = store.db.prepare("SELECT output_json FROM tool_calls WHERE session_id=? AND name='task_complete' AND status='failed'").get(first.sessionId) as { output_json: string };
    assert.match(failedCompletion.output_json, /run_process must come from run_process/);
    const completed = store.db.prepare("SELECT output_json FROM tool_calls WHERE session_id=? AND name='task_complete' AND status='completed'").get(first.sessionId) as { output_json: string };
    const checks = JSON.parse(completed.output_json).checks as Array<{ tool: string }>;
    assert.equal(checks[1]?.tool, "run_process", "resumed completion must cite the command result required by the original user goal");
  } finally { store.close(); }
}));

test("agent completion maps a compact evidence set to exact live-fetch and file-read requirements", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "compact-completion-evidence.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model");
  const originalFetch = globalThis.fetch;
  const url = "https://8.8.8.8/api/branch";
  const objective = `Use web_fetch to retrieve exactly ${url}. Create live-branch.txt containing the branch, then use file_read to verify it.`;
  let providerTurns = 0;
  const provider = {
    redact: (value: string) => value,
    models: async () => [{ type: "llm", publisher: "test", key: "test-model", display_name: "Test model", size_bytes: 1, loaded_instances: [{ id: "test-model", config: { context_length: 8192 } }], max_context_length: 8192, capabilities: { trained_for_tool_use: true } }],
    streamChatWithTools: async (request: { tools: Array<Record<string, unknown>> }) => {
      const turn = providerTurns++;
      if (turn === 0) return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "compact-web-fetch", type: "function", function: { name: "web_fetch", arguments: JSON.stringify({ url }) } }] } }] };
      if (turn === 1) return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "compact-file-create", type: "function", function: { name: "file_create", arguments: JSON.stringify({ path: "live-branch.txt", content: "main" }) } }] } }] };
      if (turn === 2) return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "compact-file-read", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "live-branch.txt" }) } }] } }] };
      const completion = request.tools.find((tool) => (tool.function as Record<string, unknown>)?.name === "task_complete");
      assert.ok(completion);
      return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "compact-task-complete", type: "function", function: { name: "task_complete", arguments: JSON.stringify({ evidence_tool_call_indexes: [1, 3] }) } }] } }] };
    }
  };
  globalThis.fetch = async () => new Response(JSON.stringify({ default_branch: "main", status: "current" }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const result = await new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never }).run(objective, {
      workspace: root, maxTurns: 6,
      completionCriteria: [objective, "Also report the live response status and retrieval timestamp."],
    });
    assert.equal(result.status, "completed");
    const completion = store.db.prepare("SELECT input_json,output_json FROM tool_calls WHERE session_id=? AND name='task_complete' AND status='completed'").get(result.sessionId) as { input_json: string; output_json: string };
    assert.deepEqual(JSON.parse(completion.input_json).evidence_tool_call_indexes, [1, 3], "a compact set can identify the file read and live fetch without duplicating indexes for every overlapping criterion");
    const checked = JSON.parse(completion.output_json).checks as Array<{ tool: string; verified: boolean }>;
    assert.equal(checked.length, 6);
    assert.ok(checked.every((item) => item.verified));
    assert.equal(checked.filter((item) => item.tool === "web_fetch").length, 2);
    assert.equal(checked.filter((item) => item.tool === "file_read").length, 4);
    assert.equal((await readFileAsync(join(root, "live-branch.txt"), "utf8")), "main");
  } finally { globalThis.fetch = originalFetch; store.close(); }
}));

test("agent blocks an identical web fetch after a successful truncated response and allows a larger request", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "truncated-web-fetch.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model");
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0; let inferenceRound = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return new Response("x".repeat(4000), { status: 200, headers: { "content-type": "application/json" } });
  };
  const provider = {
    redact: (value: string) => value,
    streamChatWithTools: async () => {
      inferenceRound++;
      if (inferenceRound === 4) return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "complete-fetch", type: "function", function: { name: "task_complete", arguments: JSON.stringify({ evidence_tool_call_indexes: [1] }) } }] } }] };
      const maxChars = inferenceRound <= 2 ? 1000 : 5000;
      return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: `fetch-${inferenceRound}`, type: "function", function: { name: "web_fetch", arguments: JSON.stringify({ url: "https://8.8.8.8/api/data", max_chars: maxChars }) } }] } }] };
    }
  };
  try {
    const result = await new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never }).run("Fetch the live API response", { workspace: root, maxTurns: 4 });
    assert.equal(result.status, "completed");
    assert.equal(inferenceRound, 4);
    assert.equal(fetchCalls, 2, "the exact repeated truncated request is rejected before a duplicate network call");
    const calls = store.db.prepare("SELECT input_json,status,output_json FROM tool_calls WHERE session_id=? AND name='web_fetch' ORDER BY rowid").all(result.sessionId) as Array<{ input_json: string; status: string; output_json: string | null }>;
    assert.deepEqual(calls.map((call) => call.status), ["completed", "completed"]);
    assert.equal(JSON.parse(calls[0]!.output_json!).truncated, true);
    assert.match(JSON.stringify(sessions.messages(result.sessionId)), /Increase max_chars/);
    assert.equal(JSON.parse(calls[1]!.input_json).max_chars, 5000);
    assert.equal(JSON.parse(calls[1]!.output_json!).truncated, false);
  } finally { globalThis.fetch = originalFetch; store.close(); }
}));

test("same-response file writes and readbacks explain stale completion indexes and verify on a fresh turn", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "same-response-file-evidence.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model"); let turn = 0; let refreshedSystem = "";
  const provider = {
    redact: (value: string) => value,
    streamChatWithTools: async (request: { messages: Array<{ role: string; content?: unknown }> }) => {
      turn++;
      if (turn === 1) return { choices: [{ message: { role: "assistant", content: null, tool_calls: [
        { id: "same-response-create", type: "function", function: { name: "file_create", arguments: JSON.stringify({ path: "marker.txt", content: "READY" }) } },
        { id: "same-response-read", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "marker.txt" }) } },
        { id: "same-response-complete", type: "function", function: { name: "task_complete", arguments: JSON.stringify({ evidence_tool_call_indexes: [1] }) } }
      ] } }] };
      refreshedSystem = String([...request.messages].reverse().find((message) => message.role === "system")?.content ?? "");
      return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "fresh-evidence-complete", type: "function", function: { name: "task_complete", arguments: JSON.stringify({ evidence_tool_call_indexes: [1, 2] }) } }] } }] };
    }
  };
  try {
    const result = await new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never })
      .run("Use file_create to create marker.txt with exactly READY, then use file_read to verify it and call task_complete.", { workspace: root, maxTurns: 2, expectedOutputPaths: ["marker.txt"] });
    assert.equal(result.status, "completed");
    assert.equal(await readFileAsync(join(root, "marker.txt"), "utf8"), "READY");
    assert.match(refreshedSystem, /1: "file_read" path=.*marker\.txt"/);
    assert.match(refreshedSystem, /2: "file_create" path=.*marker\.txt"/);
    const calls = store.db.prepare("SELECT name,status,output_json FROM tool_calls WHERE session_id=? ORDER BY rowid").all(result.sessionId) as Array<{ name: string; status: string; output_json: string | null }>;
    assert.deepEqual(calls.map(({ name, status }) => [name, status]), [["file_create", "completed"], ["file_read", "completed"], ["task_complete", "failed"], ["task_complete", "completed"]]);
    assert.match(calls[2]!.output_json!, /stale for this task_complete call/);
    assert.match(calls[2]!.output_json!, /next turn, use the refreshed one-based evidence indexes/);
    assert.equal(JSON.parse(calls[3]!.output_json!).verified, true);
  } finally { store.close(); }
}));

test("completion rejects a file read made stale by a later patch and accepts a fresh read", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "stale-read-after-patch.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model"); let turn = 0;
  const provider = {
    redact: (value: string) => value,
    streamChatWithTools: async () => {
      turn++;
      if (turn === 1) return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "stale-read-create", type: "function", function: { name: "file_create", arguments: JSON.stringify({ path: "result.txt", content: "before" }) } }] } }] };
      if (turn === 2) return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "stale-read-first", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "result.txt" }) } }] } }] };
      if (turn === 3) return { choices: [{ message: { role: "assistant", content: null, tool_calls: [
        { id: "stale-read-patch", type: "function", function: { name: "file_patch", arguments: JSON.stringify({ path: "result.txt", expected_sha256: createHash("sha256").update("before").digest("hex"), old_text: "before", new_text: "after" }) } },
        { id: "stale-read-complete", type: "function", function: { name: "task_complete", arguments: JSON.stringify({ evidence_tool_call_indexes: [1] }) } }
      ] } }] };
      if (turn === 4) return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "stale-read-final", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "result.txt" }) } }] } }] };
      return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "stale-read-fresh-complete", type: "function", function: { name: "task_complete", arguments: JSON.stringify({ evidence_tool_call_indexes: [1] }) } }] } }] };
    }
  };
  try {
    const result = await new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never })
      .run("Create result.txt, update it to say after, then read the final file and verify it.", { workspace: root, model: "test-model", maxTurns: 5, expectedOutputPaths: ["result.txt"] });
    assert.equal(result.status, "completed"); assert.equal(turn, 5);
    assert.equal(await readFileAsync(join(root, "result.txt"), "utf8"), "after");
    const calls = store.db.prepare("SELECT name,status,output_json FROM tool_calls WHERE session_id=? ORDER BY rowid").all(result.sessionId) as Array<{ name: string; status: string; output_json: string | null }>;
    assert.deepEqual(calls.map(({ name, status }) => [name, status]), [["file_create", "completed"], ["file_read", "completed"], ["file_patch", "completed"], ["task_complete", "failed"], ["file_read", "completed"], ["task_complete", "completed"]]);
    assert.match(calls[3]!.output_json!, /is stale: file_patch ran after the evidence/);
    assert.equal(JSON.parse(calls[5]!.output_json!).verified, true);
  } finally { store.close(); }
}));

test("agent nudges a narrated pseudo-tool call without executing it and recovers through real tool calls", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "narrated-tool-call.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model"); let turn = 0; let correctionPrompt = "";
  const provider = {
    redact: (value: string) => value,
    streamChatWithTools: async (request: { messages: Array<{ role: string; content?: unknown }> }) => {
      turn++;
      if (turn === 1) {
        assert.match(String(request.messages.find((message) => message.role === "system")?.content), /Only an API tool_calls entry executes a tool/);
        return { choices: [{ message: { role: "assistant", content: '```json\n{"name":"file_create","arguments":{"path":"marker.txt","content":"FAKE"}}\n```' } }] };
      }
      if (turn === 2) {
        assert.equal(existsSync(join(root, "marker.txt")), false, "narrated JSON must not execute file creation");
        correctionPrompt = String([...request.messages].reverse().find((message) => message.role === "user")?.content ?? "");
        assert.match(correctionPrompt, /No tool was executed/);
        return { choices: [{ message: { role: "assistant", content: '```tool_call\n{"tool":"file_create","params":{"path":"marker.txt","content":"FAKE"}}\n```' } }] };
      }
      if (turn === 3) {
        assert.equal(existsSync(join(root, "marker.txt")), false, "tool/params narration must not execute file creation");
        correctionPrompt = String([...request.messages].reverse().find((message) => message.role === "user")?.content ?? "");
        assert.match(correctionPrompt, /No tool was executed/);
        return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "real-marker-create", type: "function", function: { name: "file_create", arguments: JSON.stringify({ path: "marker.txt", content: "READY" }) } }] } }] };
      }
      if (turn === 4) return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "real-marker-read", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "marker.txt" }) } }] } }] };
      return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "real-marker-complete", type: "function", function: { name: "task_complete", arguments: JSON.stringify({ evidence_tool_call_indexes: [1, 2] }) } }] } }] };
    }
  };
  try {
    const result = await new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never })
      .run("Call file_create to create marker.txt with exactly READY, then call file_read to verify it.", { workspace: root, model: "test-model", maxTurns: 5, expectedOutputPaths: ["marker.txt"] });
    assert.equal(result.status, "completed"); assert.equal(turn, 5); assert.match(correctionPrompt, /file_create/);
    assert.equal(await readFileAsync(join(root, "marker.txt"), "utf8"), "READY");
    const calls = store.db.prepare("SELECT name,status FROM tool_calls WHERE session_id=? ORDER BY rowid").all(result.sessionId) as Array<{ name: string; status: string }>;
    assert.deepEqual(calls, [{ name: "file_create", status: "completed" }, { name: "file_read", status: "completed" }, { name: "task_complete", status: "completed" }]);
  } finally { store.close(); }
}));

test("completion feedback identifies the exact successful read index omitted from the selected evidence", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "completion-read-index.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model"); let turn = 0; let correction = "";
  const provider = {
    redact: (value: string) => value,
    streamChatWithTools: async (request: { messages: Array<{ role: string; content?: unknown }> }) => {
      turn++;
      if (turn === 1) return { choices: [{ message: { role: "assistant", content: null, tool_calls: [
        { id: `index-create-${randomUUID()}`, type: "function", function: { name: "file_create", arguments: JSON.stringify({ path: "marker.txt", content: "READY" }) } },
        { id: `index-list-${randomUUID()}`, type: "function", function: { name: "file_list", arguments: JSON.stringify({ path: "." }) } },
        { id: `index-read-${randomUUID()}`, type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "marker.txt" }) } }
      ] } }] };
      if (turn === 2) return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: `wrong-index-complete-${randomUUID()}`, type: "function", function: { name: "task_complete", arguments: JSON.stringify({ evidence_tool_call_indexes: [2, 3] }) } }] } }] };
      correction = String([...request.messages].reverse().find((message) => message.role === "tool")?.content ?? "");
      assert.match(JSON.stringify(request.messages), /Matching successful file_read evidence indexes: 1/);
      return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: `correct-index-complete-${randomUUID()}`, type: "function", function: { name: "task_complete", arguments: JSON.stringify({ evidence_tool_call_indexes: [2, 3, 1] }) } }] } }] };
    }
  };
  try {
    const result = await new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never })
      .run("Create marker.txt with exactly READY and verify it by reading it back.", { workspace: root, model: "test-model", maxTurns: 4, completionCriteria: ["Create marker.txt with exactly READY.", "The requested command verification was completed."], expectedOutputPaths: ["marker.txt"] });
    assert.equal(result.status, "completed", JSON.stringify(store.db.prepare("SELECT name,status,input_json,output_json FROM tool_calls WHERE session_id=? ORDER BY rowid").all(result.sessionId))); assert.equal(correction.includes("Matching successful file_read evidence indexes: 1"), true);
    const completions = store.db.prepare("SELECT status,output_json FROM tool_calls WHERE session_id=? AND name='task_complete' ORDER BY rowid").all(result.sessionId) as Array<{ status: string; output_json: string | null }>;
    assert.equal(completions[0]?.status, "failed"); assert.match(completions[0]!.output_json!, /Matching successful file_read evidence indexes: 1/);
    assert.equal(completions[1]?.status, "completed"); assert.equal(JSON.parse(completions[1]!.output_json!).verified, true);
  } finally { store.close(); }
}));

test("command wording after an output filename does not become an exact file-content requirement", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "command-wording-content-inference.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model"); let turn = 0;
  const source = "export function isWithinRange(value, min, max) { return Number.isFinite(value) && Number.isFinite(min) && Number.isFinite(max) && min <= max && value >= min && value <= max; }\n";
  const testSource = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { isWithinRange } from './isWithinRange.mjs';\ntest('inclusive finite range', () => { assert.equal(isWithinRange(5, 1, 10), true); assert.equal(isWithinRange(1, 1, 10), true); assert.equal(isWithinRange(10, 1, 10), true); assert.equal(isWithinRange(NaN, 1, 10), false); });\n";
  const response = (id: string, name: string, args: Record<string, unknown>) => ({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
  const provider = {
    redact: (value: string) => value,
    streamChatWithTools: async () => {
      turn++;
      if (turn === 1) return response("range-source-create", "file_create", { path: "isWithinRange.mjs", content: source });
      if (turn === 2) return response("range-test-create", "file_create", { path: "isWithinRange.test.mjs", content: testSource });
      if (turn === 3) return response("range-test-run", "run_process", { executable: process.execPath, args: ["-e", "process.stdout.write('COMMAND_OK')"], cwd: root });
      if (turn === 4) return response("range-source-read", "file_read", { path: "isWithinRange.mjs" });
      if (turn === 5) return response("range-test-read", "file_read", { path: "isWithinRange.test.mjs" });
      return response("range-evidence-complete", "task_complete", { evidence_tool_call_indexes: [5, 3, 2, 1] });
    }
  };
  try {
    const objective = "Implement JavaScript ESM function isWithinRange(value, min, max) in isWithinRange.mjs. Add node:test cases in isWithinRange.test.mjs. Save both files at the current directory root. Run exactly node --test isWithinRange.test.mjs, then read both final files.";
    const result = await new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never }).run(objective, { workspace: root, maxTurns: 6, expectedOutputPaths: ["isWithinRange.mjs", "isWithinRange.test.mjs"] });
    assert.equal(result.status, "completed", JSON.stringify(store.db.prepare("SELECT name,status,input_json,output_json FROM tool_calls WHERE session_id=? ORDER BY rowid").all(result.sessionId)));
    assert.equal(turn, 6);
    const runs = store.db.prepare("SELECT output_json FROM tool_calls WHERE session_id=? AND name='run_process' AND status='completed'").all(result.sessionId) as Array<{ output_json: string }>;
    assert.equal(JSON.parse(runs[0]!.output_json).code, 0);
    const completion = store.db.prepare("SELECT output_json FROM tool_calls WHERE session_id=? AND name='task_complete' AND status='completed'").get(result.sessionId) as { output_json: string };
    assert.equal(JSON.parse(completion.output_json).verified, true);
  } finally { store.close(); }
}));

test("explicit live API requests require evidence from the exact requested URL", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "requested-live-api-evidence.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model");
  const requestedUrl = "https://api.open-meteo.com/v1/forecast?latitude=40&longitude=-74&current=temperature_2m";
  const wrongUrl = "https://api.open-meteo.com/v1/forecast?latitude=41&longitude=-73&current=temperature_2m";
  const originalFetch = globalThis.fetch; let turn = 0;
  globalThis.fetch = async (input) => new Response(JSON.stringify({ url: String(input), temperature_2m: 18 }), { status: 200, headers: { "content-type": "application/json" } });
  const provider = {
    redact: (value: string) => value,
    streamChatWithTools: async () => {
      turn++;
      if (turn === 1) return { choices: [{ message: { role: "assistant", tool_calls: [{ id: "wrong-live-fetch", type: "function", function: { name: "web_fetch", arguments: JSON.stringify({ url: wrongUrl }) } }] } }] };
      if (turn === 2) return { choices: [{ message: { role: "assistant", tool_calls: [{ id: "wrong-live-fetch-complete", type: "function", function: { name: "task_complete", arguments: JSON.stringify({ evidence_tool_call_indexes: [1] }) } }] } }] };
      return { choices: [{ message: { role: "assistant", content: "The requested API URL was not fetched." } }] };
    }
  };
  try {
    const result = await new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never }).run(`Use web_fetch to retrieve ${requestedUrl}`, { workspace: root, maxTurns: 3 });
    assert.equal(result.status, "unverified");
    const failed = store.db.prepare("SELECT output_json FROM tool_calls WHERE session_id=? AND name='task_complete' AND status='failed'").get(result.sessionId) as { output_json: string };
    assert.match(failed.output_json, /successful web_fetch of the requested URL/);
    assert.ok(failed.output_json.includes(requestedUrl));
  } finally { globalThis.fetch = originalFetch; store.close(); }
}));

test("verified live-data answers include the successful source URL and retrieval time", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "live-source-attribution.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model");
  const url = "https://8.8.8.8/api/status"; const originalFetch = globalThis.fetch; let turn = 0;
  globalThis.fetch = async () => new Response('{"status":"operational"}', { status: 200, headers: { "content-type": "application/json" } });
  const provider = {
    redact: (value: string) => value,
    streamChatWithTools: async () => {
      turn++;
      if (turn === 1) return { choices: [{ message: { role: "assistant", content: "The service is operational.", tool_calls: [{ id: "live-source-fetch", type: "function", function: { name: "web_fetch", arguments: JSON.stringify({ url }) } }] } }] };
      return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "live-source-complete", type: "function", function: { name: "task_complete", arguments: JSON.stringify({ evidence_tool_call_indexes: [1] }) } }] } }] };
    }
  };
  try {
    const result = await new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never }).run(`Use web_fetch to retrieve ${url} and report its status.`, { workspace: root, maxTurns: 3 });
    assert.equal(result.status, "completed");
    assert.match(result.response, /The service is operational\./);
    assert.match(result.response, /Live sources \(retrieved UTC\):/);
    assert.ok(result.response.includes(`<${url}>`));
    const output = store.db.prepare("SELECT output_json FROM tool_calls WHERE session_id=? AND name='web_fetch' AND status='completed'").get(result.sessionId) as { output_json: string };
    assert.ok(result.response.includes(JSON.parse(output.output_json).retrieved_at));
    assert.ok((sessions.messages(result.sessionId) as Array<{ content: string }>).some((message) => message.content.includes("Live sources (retrieved UTC):")));
  } finally { globalThis.fetch = originalFetch; store.close(); }
}));

test("task completion rejects truncated web fetch evidence and accepts a successful full refetch", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "truncated-fetch-evidence.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model");
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0; let inferenceRound = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return new Response("x".repeat(4000), { status: 200, headers: { "content-type": "application/json" } });
  };
  const provider = {
    redact: (value: string) => value,
    streamChatWithTools: async () => {
      inferenceRound++;
      if (inferenceRound === 1 || inferenceRound === 3) {
        const maxChars = inferenceRound === 1 ? 1000 : 5000;
        return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: `fetch-${inferenceRound}`, type: "function", function: { name: "web_fetch", arguments: JSON.stringify({ url: "https://8.8.8.8/api/data", max_chars: maxChars }) } }] } }] };
      }
      const id = inferenceRound === 2 ? "complete-truncated" : "complete-full";
      return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "task_complete", arguments: JSON.stringify({ evidence_tool_call_indexes: [1] }) } }] } }] };
    }
  };
  try {
    const result = await new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never }).run("Fetch the complete live API response", { workspace: root, maxTurns: 4 });
    assert.equal(result.status, "completed");
    assert.equal(fetchCalls, 2);
    const calls = store.db.prepare("SELECT name,status,input_json,output_json FROM tool_calls WHERE session_id=? ORDER BY rowid").all(result.sessionId) as Array<{ name: string; status: string; input_json: string; output_json: string | null }>;
    assert.deepEqual(calls.map((call) => [call.name, call.status]), [["web_fetch", "completed"], ["task_complete", "failed"], ["web_fetch", "completed"], ["task_complete", "completed"]]);
    assert.match(calls[1]!.output_json!, /is truncated/);
    assert.equal(JSON.parse(calls[0]!.output_json!).truncated, true);
    assert.equal(JSON.parse(calls[2]!.output_json!).truncated, false);
    assert.equal(JSON.parse(calls[3]!.output_json!).verified, true);
  } finally { globalThis.fetch = originalFetch; store.close(); }
}));

test("malformed external tool arguments fail before durable intent and do not quarantine the mission", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "malformed-external-tool.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model");
  let turn = 0;
  const provider = {
    redact: (value: string) => value,
    streamChatWithTools: async () => {
      turn++;
      return turn === 1
        ? { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "malformed-run", type: "function", function: { name: "run_process", arguments: "{\"executable\":\"python\",\"args\":[" } }] } }] }
        : { choices: [{ message: { role: "assistant", content: "The malformed call was rejected." } }] };
    }
  };
  const agent = new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never });
  try {
    const result = await agent.run("Run the declared local command", { workspace: root, maxTurns: 2 });
    assert.equal(result.status, "unverified");
    const call = store.db.prepare("SELECT status,effect,execution_scope,output_json FROM tool_calls WHERE id='malformed-run'").get() as { status: string; effect: string; execution_scope: string | null; output_json: string } | undefined;
    assert.equal(call, undefined, "invalid JSON is rejected before any durable external-action intent is inserted");
    assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM tool_calls WHERE status='uncertain'").get() as { count: number }).count, 0);
    assert.equal(turn, 2, "the agent receives the parse error and continues its normal loop");
  } finally { store.close(); }
}));

test("mission completion enforces required tool name, exit code, and output assertions", () => {
  const requirement = { tool: "run_process", exitCode: 0, stdoutEquals: "EXPECTED\n" };
  assert.doesNotThrow(() => assertRequiredToolEvidence("run_process", { code: 0, signal: null, stdout: "EXPECTED\n" }, requirement));
  assert.doesNotThrow(() => assertRequiredToolEvidence("run_process", { code: 0, signal: null, stdout: "EXPECTED\r\n" }, { ...requirement, normalizeNewlines: true }));
  assert.throws(() => assertRequiredToolEvidence("file_read", { code: 0, stdout: "EXPECTED\n" }, requirement), /must come from run_process/);
  assert.throws(() => assertRequiredToolEvidence("run_process", { code: 1, stdout: "EXPECTED\n" }, requirement), /required 0/);
  assert.throws(() => assertRequiredToolEvidence("run_process", { code: 0, stdout: "OTHER\n" }, requirement), /stdout did not exactly match/);
});

test("mission completion evidence must reference each declared file output path", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "expected-output-path.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model");
  const expectedPath = join(root, "expected.txt"); let turn = 0;
  const provider = {
    redact: (value: string) => value,
    streamChatWithTools: async () => {
      turn++;
      if (turn === 1) return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "wrong-output", type: "function", function: { name: "file_create", arguments: JSON.stringify({ path: "wrong.txt", content: "wrong" }) } }] } }] };
      if (turn === 2) return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "wrong-output-complete", type: "function", function: { name: "task_complete", arguments: JSON.stringify({ evidence_tool_call_indexes: [1] }) } }] } }] };
      return { choices: [{ message: { role: "assistant", content: "The declared output is not present." } }] };
    }
  };
  const agent = new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never });
  try {
    const result = await agent.run("Create the declared output", { workspace: root, maxTurns: 3, expectedOutputPaths: [expectedPath], completionCriteria: [expectedPath, "The expected output contains the required content."] });
    assert.equal(result.status, "unverified");
    assert.equal(existsSync(expectedPath), false);
    assert.equal(await readFileAsync(join(root, "wrong.txt"), "utf8"), "wrong");
    const failedCompletion = store.db.prepare("SELECT output_json FROM tool_calls WHERE session_id=? AND name='task_complete' AND status='failed'").get(result.sessionId) as { output_json: string };
    assert.match(failedCompletion.output_json, /successful readback of that exact path/);
  } finally { store.close(); }
}));

test("declared PDF outputs accept exact-path office_read verification", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "expected-pdf-output.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model");
  const expectedPath = join(root, "brief.pdf"); const pdf = await PDFDocument.create(); pdf.addPage([180, 80]).drawText("Accessible UX Workshop", { x: 20, y: 35 }); await writeFile(expectedPath, await pdf.save());
  let turn = 0;
  const provider = {
    redact: (value: string) => value,
    streamChatWithTools: async () => {
      turn++;
      if (turn === 1) return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "read-pdf-output", type: "function", function: { name: "office_read", arguments: JSON.stringify({ format: "pdf", path: "brief.pdf" }) } }] } }] };
      return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "verify-pdf-output", type: "function", function: { name: "task_complete", arguments: JSON.stringify({ evidence_tool_call_indexes: [1] }) } }] } }] };
    }
  };
  try {
    const result = await new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never })
      .run("Verify the declared PDF output", { workspace: root, model: "test-model", maxTurns: 3, expectedOutputPaths: [expectedPath], completionCriteria: [expectedPath] });
    assert.equal(result.status, "completed"); assert.equal(turn, 2);
    const evidence = store.db.prepare("SELECT name,status,output_json FROM tool_calls WHERE session_id=? AND name='office_read'").get(result.sessionId) as { name: string; status: string; output_json: string };
    assert.deepEqual([evidence.name, evidence.status, JSON.parse(evidence.output_json).path], ["office_read", "completed", expectedPath]);
  } finally { store.close(); }
}));

test("inferred exact file criteria reject incorrect content and accept an exact-path readback", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "required-file-evidence.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model"); let turn = 0;
  const expectedText = "recovery marker: once";
  const provider = {
    redact: (value: string) => value,
    streamChatWithTools: async () => {
      turn++;
      if (turn === 1) return { choices: [{ message: { role: "assistant", tool_calls: [{ id: "create-wrong-marker", type: "function", function: { name: "file_create", arguments: JSON.stringify({ path: "marker.txt", content: "once" }) } }] } }] };
      if (turn === 2) return { choices: [{ message: { role: "assistant", tool_calls: [{ id: "read-wrong-marker", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "marker.txt" }) } }] } }] };
      if (turn === 3) return { choices: [{ message: { role: "assistant", tool_calls: [{ id: "reject-wrong-marker", type: "function", function: { name: "task_complete", arguments: JSON.stringify({ evidence_tool_call_indexes: [1] }) } }] } }] };
      if (turn === 4) return { choices: [{ message: { role: "assistant", tool_calls: [{ id: "patch-correct-marker", type: "function", function: { name: "file_patch", arguments: JSON.stringify({ path: "marker.txt", expected_sha256: createHash("sha256").update("once").digest("hex"), old_text: "once", new_text: expectedText }) } }] } }] };
      if (turn === 5) return { choices: [{ message: { role: "assistant", tool_calls: [{ id: "read-correct-marker", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "marker.txt" }) } }] } }] };
      return { choices: [{ message: { role: "assistant", tool_calls: [{ id: `accept-correct-marker-${randomUUID()}`, type: "function", function: { name: "task_complete", arguments: JSON.stringify({ evidence_tool_call_indexes: [1, 1, 1] }) } }] } }] };
    }
  };
  try {
    const result = await new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never })
      .run("Create marker.txt with exactly recovery marker: once, then use file_read to verify it.", {
        workspace: root,
        maxTurns: 7,
        expectedOutputPaths: ["marker.txt"]
      });
    assert.equal(result.status, "completed", JSON.stringify(store.db.prepare("SELECT name,status,input_json,output_json FROM tool_calls WHERE session_id=? ORDER BY rowid").all(result.sessionId))); assert.equal(turn, 6);
    assert.equal(await readFileAsync(join(root, "marker.txt"), "utf8"), expectedText);
    const completions = store.db.prepare("SELECT status,output_json FROM tool_calls WHERE session_id=? AND name='task_complete' ORDER BY rowid").all(result.sessionId) as Array<{ status: string; output_json: string | null }>;
    assert.equal(completions[0]?.status, "failed"); assert.match(completions[0]!.output_json!, /File read content did not exactly match/);
    assert.equal(completions[1]?.status, "completed"); assert.equal(JSON.parse(completions[1]!.output_json!).verified, true);
  } finally { store.close(); }
}));

test("explicit file-read evidence does not become a false inferred file-content criterion", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "explicit-file-evidence.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model"); let turn = 0;
  const expectedPath = join(root, "mission-proof.txt"); const expectedText = "XYST-MISSION-VERIFIED-041";
  const provider = {
    redact: (value: string) => value,
    streamChatWithTools: async () => {
      turn++;
      if (turn === 1) return { choices: [{ message: { role: "assistant", tool_calls: [{ id: "create-proof-marker", type: "function", function: { name: "file_create", arguments: JSON.stringify({ path: "mission-proof.txt", content: expectedText }) } }] } }] };
      if (turn === 2) return { choices: [{ message: { role: "assistant", tool_calls: [{ id: "read-proof-marker", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "mission-proof.txt" }) } }] } }] };
      return { choices: [{ message: { role: "assistant", tool_calls: [{ id: "complete-proof-marker", type: "function", function: { name: "task_complete", arguments: JSON.stringify({ evidence_tool_call_indexes: [1, 1, 1] }) } }] } }] };
    }
  };
  try {
    const result = await new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never })
      .run("Create mission-proof.txt with marker XYST-MISSION-VERIFIED-041, then read it back.", {
        workspace: root,
        maxTurns: 4,
        requiredToolEvidence: [{ tool: "file_read", path: expectedPath, textEquals: expectedText, normalizeNewlines: true }]
      });
    assert.equal(result.status, "completed", JSON.stringify(store.db.prepare("SELECT name,status,input_json,output_json FROM tool_calls WHERE session_id=? ORDER BY rowid").all(result.sessionId)));
    assert.equal(turn, 3);
    assert.equal(await readFileAsync(expectedPath, "utf8"), expectedText);
    const completions = store.db.prepare("SELECT status,output_json FROM tool_calls WHERE session_id=? AND name='task_complete'").all(result.sessionId) as Array<{ status: string; output_json: string | null }>;
    assert.equal(completions.length, 1);
    assert.equal(completions[0]?.status, "completed");
    assert.equal(JSON.parse(completions[0]!.output_json!).verified, true);
  } finally { store.close(); }
}));

test("declared outputs require exact readback and the refreshed evidence list identifies its path", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "expected-output-readback.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model");
  const expectedPath = join(root, "expected.txt"); let turn = 0; const prompts: string[] = [];
  const provider = {
    redact: (value: string) => value,
    streamChatWithTools: async (request: { messages: Array<Record<string, unknown>> }) => {
      turn++;
      if (turn === 1) return { choices: [{ message: { role: "assistant", tool_calls: [{ id: "write-expected", type: "function", function: { name: "file_create", arguments: JSON.stringify({ path: "expected.txt", content: "VERIFIED" }) } }] } }] };
      prompts.push(String(request.messages.find((message) => message.role === "system")?.content ?? ""));
      if (turn === 2) return { choices: [{ message: { role: "assistant", tool_calls: [
        { id: "read-expected", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "expected.txt" }) } },
        { id: "premature-complete", type: "function", function: { name: "task_complete", arguments: JSON.stringify({ evidence_tool_call_indexes: [1] }) } }
      ] } }] };
      return { choices: [{ message: { role: "assistant", tool_calls: [{ id: "verified-complete", type: "function", function: { name: "task_complete", arguments: JSON.stringify({ evidence_tool_call_indexes: [1] }) } }] } }] };
    }
  };
  const agent = new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never });
  try {
    const result = await agent.run("Create and verify the declared output", { workspace: root, maxTurns: 4, expectedOutputPaths: [expectedPath], completionCriteria: [expectedPath] });
    assert.equal(result.status, "completed");
    assert.equal(await readFileAsync(expectedPath, "utf8"), "VERIFIED");
    const completionCalls = store.db.prepare("SELECT status,input_json,output_json FROM tool_calls WHERE session_id=? AND name='task_complete' ORDER BY rowid").all(result.sessionId) as Array<{ status: string; input_json: string; output_json: string }>;
    assert.equal(completionCalls[0]?.status, "failed", "a file_create result cannot verify a declared file output");
    assert.match(completionCalls[0]!.output_json, /readback completed after the displayed evidence list was sent/);
    assert.equal(completionCalls[1]?.status, "completed");
    assert.match(prompts[0]!, /Available persisted evidence call indexes \(newest-first/);
    assert.match(prompts[1]!, /1: "file_read" path=/);
    assert.match(prompts[1]!, /2: "file_create" path=/);
  } finally { store.close(); }
}));

test("agent prompts once for evidence verification when actions succeeded but the model only returned prose", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "completion-nudge.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model");
  const objective = "Create output.txt with exactly VERIFIED_CONTENT and confirm its contents";
  const secondCriterion = "output.txt exists and contains exactly VERIFIED_CONTENT";
  let turn = 0; const createId = "nudge-create-output"; const readId = "nudge-read-output";
  const provider = {
    redact: (value: string) => value,
    streamChatWithTools: async (request: { messages: Array<Record<string, unknown>> }) => {
      turn++;
      if (turn === 1) return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: createId, type: "function", function: { name: "file_create", arguments: JSON.stringify({ path: "output.txt", content: "VERIFIED_CONTENT" }) } }] } }] };
      if (turn === 2) return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: readId, type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "output.txt" }) } }] } }] };
      if (turn === 3) return { choices: [{ message: { role: "assistant", content: "The file was created and checked." } }] };
      if (turn === 4) {
        const reminder = request.messages.filter((message) => message.role === "user").at(-1)?.content;
        assert.match(String(reminder), /call task_complete now/i); assert.match(String(reminder), /1: "file_read"/);
        return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "nudge-task-complete", type: "function", function: { name: "task_complete", arguments: JSON.stringify({ evidence_tool_call_indexes: [1] }) } }] } }] };
      }
      return { choices: [{ message: { role: "assistant", content: "Verified." } }] };
    }
  };
  const agent = new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never });
  try {
    const result = await agent.run(objective, { workspace: root, completionCriteria: [objective, secondCriterion], maxTurns: 8 });
    assert.equal(result.status, "completed", JSON.stringify(sessions.messages(result.sessionId))); assert.equal(turn, 4);
    assert.equal(await readFileAsync(join(root, "output.txt"), "utf8"), "VERIFIED_CONTENT");
  } finally { store.close(); }
}));

test("agent resumes incomplete user or tool turns with a valid assistant boundary", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "resume-turn-boundary.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model");
  const captured: Array<Array<Record<string, unknown>>> = [];
  const provider = {
    redact: (value: string) => value,
    models: async () => [{ type: "llm", key: "test-model", size_bytes: 1, loaded_instances: [{ id: "loaded", config: {} }] }],
    isLocalServer: () => true,
    supportsLocalCliModelLifecycle: () => false,
    streamChatWithTools: async (request: { messages: Array<Record<string, unknown>> }) => { captured.push(request.messages); return { choices: [{ message: { role: "assistant", content: "Continued" } }] }; }
  };
  const agent = new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never });
  try {
    for (const ending of ["tool", "user"] as const) {
      const sessionId = sessions.create(`resume ${ending}`);
      sessions.addMessage(sessionId, "user", "The original request");
      if (ending === "tool") {
        const callId = `interrupted-${randomUUID()}`;
        sessions.addMessage(sessionId, "assistant", `__xyst_api_message__:${JSON.stringify({ role: "assistant", content: null, tool_calls: [{ id: callId, type: "function", function: { name: "file_list", arguments: "{}" } }] })}`);
        sessions.addMessage(sessionId, "tool", `__xyst_api_message__:${JSON.stringify({ role: "tool", tool_call_id: callId, content: "Saved tool result" })}`);
      }
      const result = await agent.run("Continue with this update", { sessionId, model: "test-model", workspace: root, maxTurns: 1 });
      assert.equal(result.status, "unverified");
      const messages = captured.at(-1)!;
      const expectedTail = ending === "tool" ? ["tool", "assistant", "user"] : ["user", "assistant", "user"];
      assert.deepEqual(messages.slice(-3).map((message) => message.role), expectedTail);
      assert.match(String(messages.at(-2)?.content), /resuming after an interrupted turn/);
    }
  } finally { store.close(); }
}));

test("agent persists messages received during inference and continues with the updated request", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "mid-run-message.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model");
  let pending: string[] = [];
  const captured: Array<Array<Record<string, unknown>>> = [];
  const provider = {
    redact: (value: string) => value,
    streamChatWithTools: async (request: { messages: Array<Record<string, unknown>> }) => {
      captured.push(request.messages);
      if (captured.length === 1) pending.push("Please focus on the README instead.");
      return { choices: [{ message: { role: "assistant", content: captured.length === 1 ? "I will revise my approach." : "README updated." } }] };
    }
  };
  const agent = new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never });
  try {
    const result = await agent.run("Inspect the project", { workspace: root, maxTurns: 3, drainUserMessages: () => { const messages = pending; pending = []; return messages; } });
    assert.equal(result.status, "unverified");
    assert.equal(captured.length, 2);
    assert.deepEqual(captured[1]!.slice(-2).map((message) => message.role), ["assistant", "user"]);
    assert.equal(captured[1]!.at(-1)?.content, "Please focus on the README instead.");
    const saved = sessions.messages(result.sessionId) as Array<{ role: string; content: string }>;
    assert.equal(saved.some((message) => message.role === "user" && message.content.includes("Please focus on the README instead.")), true);
  } finally { store.close(); }
}));

test("agent appends queued guidance after pending tool results are saved", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "mid-run-tool-message.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model");
  let pending: string[] = [];
  const captured: Array<Array<Record<string, unknown>>> = [];
  const provider = {
    redact: (value: string) => value,
    streamChatWithTools: async (request: { messages: Array<Record<string, unknown>> }) => {
      captured.push(request.messages);
      if (captured.length === 1) {
        pending.push("Skip the generated inventory and inspect the source file.");
        return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "list-before-guidance", type: "function", function: { name: "file_list", arguments: JSON.stringify({ path: root }) } }] } }] };
      }
      return { choices: [{ message: { role: "assistant", content: "I inspected the source file." } }] };
    }
  };
  const agent = new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never });
  try {
    const result = await agent.run("List project files", { workspace: root, maxTurns: 3, drainUserMessages: () => { const messages = pending; pending = []; return messages; } });
    assert.equal(result.status, "unverified");
    assert.deepEqual(captured[1]!.slice(-3).map((message) => message.role), ["assistant", "tool", "user"]);
    assert.equal(captured[1]!.at(-1)?.content, "Skip the generated inventory and inspect the source file.");
  } finally { store.close(); }
}));

test("agent rechecks context as queued messages grow the saved conversation", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "growing-context.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "short-context-model");
  let pending: string[] = [];
  let generations = 0;
  const provider = {
    redact: (value: string) => value,
    models: async () => [{ type: "llm", key: "short-context-model", max_context_length: 6200, loaded_instances: [{ id: "loaded", config: { context_length: 6200 } }] }],
    isLocalServer: () => true,
    supportsLocalCliModelLifecycle: () => false,
    streamChatWithTools: async () => { generations++; pending.push("additional guidance ".repeat(120)); return { choices: [{ message: { role: "assistant", content: "Ready for the update." } }] }; }
  };
  const agent = new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never });
  let sessionId = "";
  try {
    await assert.rejects(() => agent.run("Keep this short", { workspace: root, maxTurns: 3, onSession: (id) => { sessionId = id; }, drainUserMessages: () => { const messages = pending; pending = []; return messages; } }), /conversation now needs an estimated .* selected model short-context-model provides 6200/);
    assert.equal(generations, 1);
    assert.equal((sessions.list() as Array<{ id: string; status: string }>).find((session) => session.id === sessionId)?.status, "failed");
    assert.equal((sessions.messages(sessionId) as Array<{ role: string; content: string }>).some((message) => message.role === "user" && message.content.includes("additional guidance")), true);
  } finally { store.close(); }
}));

test("agent loads a larger-context LM Studio instance without replacing an existing instance", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "context-instance.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  const model = { type: "llm" as const, key: "context-model", max_context_length: 32768, size_bytes: 1_000_000_000, loaded_instances: [{ id: "context-model", config: { context_length: 8192 } }] };
  const generationModels: string[] = []; let loadedContext: number | undefined;
  const provider = {
    redact: (value: string) => value,
    isLocalServer: () => true,
    models: async () => [model],
    load: async (_key: string, options: { context_length?: number }) => {
      loadedContext = options.context_length;
      model.loaded_instances.push({ id: "context-model:2", config: { context_length: options.context_length ?? 0 } });
      return { instance_id: "context-model:2" };
    },
    streamChatWithTools: async (request: { model: string }) => { generationModels.push(request.model); return { choices: [{ message: { role: "assistant", content: "Ready." } }] }; }
  };
  const agent = new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never });
  try {
    const result = await agent.run("Reply with a short status. ".repeat(1200), { workspace: root, maxTurns: 1 });
    assert.equal(result.model, "context-model");
    assert.equal(generationModels.length, 1);
    assert.equal(generationModels[0], "context-model:2");
    assert.ok((loadedContext ?? 0) > 8192);
    assert.deepEqual(model.loaded_instances.map((instance) => instance.id), ["context-model", "context-model:2"]);
    const decision = store.db.prepare("SELECT model FROM model_decisions WHERE session_id=?").get(result.sessionId) as { model: string };
    assert.equal(decision.model, "context-model");
  } finally { store.close(); }
}));

test("aborting an in-flight inference ends the session as cancelled instead of failed", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "cancel-agent.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model");
  const provider = {
    redact: (value: string) => value,
    streamChatWithTools: async (_request: unknown, _onText: unknown, signal?: AbortSignal) => new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("Inference cancelled")), { once: true }))
  };
  const emitted: Array<{ type?: string; payload?: unknown }> = [];
  events.on("*", (event) => emitted.push(event));
  const runner = new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never });
  const controller = new AbortController();
  try {
    const task = runner.run("Wait for cancellation", { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 10)); controller.abort();
    const result = await task;
    assert.equal(result.status, "cancelled");
    assert.equal((sessions.list()[0] as { status: string }).status, "cancelled");
    assert.equal(emitted.some((event) => event.type === "agent.finished" && (event.payload as Record<string, unknown> | undefined)?.status === "cancelled"), true);
    assert.equal(emitted.some((event) => event.type === "agent.failed"), false);
  } finally { store.close(); }
}));

test("global network setting clamps full access without widening restricted profiles", async () => withTemp(async (root) => {
  const dataDir = join(root, "runtime");
  const runtimes: ReturnType<typeof createRuntime>[] = [];
  const open = () => { const runtime = createRuntime({ dataDir }); runtimes.push(runtime); return runtime; };
  try {
    const initial = open(); initial.config.set("global", "network.enabled", false); initial.close();
    const disabled = open(); assert.throws(() => disabled.access.assertCapability("network"), /Xyst settings deny network access/);
    disabled.config.set("global", "network.enabled", true); disabled.close();
    const enabled = open(); assert.doesNotThrow(() => enabled.access.assertCapability("network"));
    enabled.config.set("global", "access.profile", { mode: "restricted", readRoots: [], writeRoots: [], allowedExecutables: [], network: false, integrations: false, backgroundJobs: false, externalActions: false }); enabled.close();
    const restricted = open(); assert.throws(() => restricted.access.assertCapability("network"), /denies network/);
  } finally { for (const runtime of runtimes) { try { runtime.close(); } catch { /* already closed */ } } }
}));

test("agent network policy honors project scope but cannot widen the access profile", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "network-scopes.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model");
  const runFetch = async (projectId: string, access: AccessController) => {
    let round = 0; let toolResult = "";
    const provider = { redact: (value: string) => value, streamChatWithTools: async (request: Record<string, any>) => {
      round++;
      if (round === 1) return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: `fetch-${randomUUID()}`, type: "function", function: { name: "web_fetch", arguments: JSON.stringify({ url: "http://127.0.0.1/" }) } }] } }] };
      toolResult = String(request.messages.find((message: Record<string, any>) => message.role === "tool")?.content ?? "");
      return { choices: [{ message: { role: "assistant", content: "Done" } }] };
    } };
    await new AgentRunner({ store, config, sessions, events, access, provider: provider as never, github: {} as never }).run("Fetch the local address", { projectId, workspace: root });
    return toolResult;
  };
  try {
    config.set("project", "network.enabled", false, "offline-project");
    assert.match(await runFetch("offline-project", new AccessController()), /Xyst settings deny network access/);
    config.set("global", "network.enabled", false);
    config.set("project", "network.enabled", true, "explicit-network-project");
    const scopedResult = await runFetch("explicit-network-project", new AccessController());
    assert.doesNotMatch(scopedResult, /Xyst settings deny network access/);
    assert.match(scopedResult, /loopback|localhost|public|private|reserved/i);
    const restricted = new AccessController({ mode: "restricted", readRoots: [root], writeRoots: [root], allowedExecutables: [], network: false, integrations: true, backgroundJobs: true, externalActions: true });
    assert.match(await runFetch("explicit-network-project", restricted), /denies network/);
  } finally { store.close(); }
}));

test("agent applies scoped inference parameters to streamed LM Studio requests", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "inference-options.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model"); config.set("global", "inference.temperature", 0.4);
  config.set("global", "inference.maxTokens", 512); config.set("global", "inference.requestTimeoutSeconds", 180); config.set("global", "inference.topP", 0.9); config.set("global", "inference.topK", 40); config.set("global", "inference.repeatPenalty", 1.1); config.set("global", "inference.presencePenalty", 0.2);
  config.set("global", "inference.frequencyPenalty", -0.3); config.set("global", "inference.stopSequences", ["END", "STOP"]); config.set("global", "inference.reasoning", "off"); config.set("mission", "inference.temperature", 0.7, "mission-1"); config.set("mission", "inference.requestTimeoutSeconds", 75, "mission-1"); config.set("mission", "inference.reasoning", "high", "mission-1");
  let captured: Record<string, unknown> = {};
  let capturedTimeout: number | undefined;
  const provider = { redact: (value: string) => value, streamChatWithTools: async (request: Record<string, unknown>, _onText?: unknown, _signal?: unknown, timeoutMs?: number) => { captured = request; capturedTimeout = timeoutMs; return { choices: [{ message: { role: "assistant", content: "Done" } }] }; } };
  const agent = new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never });
  try {
    await agent.run("Run with configured inference", { missionId: "mission-1" });
    assert.equal(capturedTimeout, 75_000);
    assert.equal(captured.temperature, 0.7); assert.equal(captured.max_tokens, 512); assert.equal(captured.top_p, 0.9); assert.equal(captured.top_k, 40); assert.equal(captured.repeat_penalty, 1.1);
    assert.equal(captured.presence_penalty, 0.2); assert.equal(captured.frequency_penalty, -0.3); assert.deepEqual(captured.stop, ["END", "STOP"]);
    assert.equal(captured.reasoning_effort, "high");
    await agent.run("Run with global inference", {});
    assert.equal(captured.reasoning_effort, "none");
  } finally { store.close(); }
}));

test("agent batches independent file reads with scoped bounded concurrency and preserves call order", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "parallel-read-tools.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  await writeFile(join(root, "one.txt"), "first read result", "utf8"); await writeFile(join(root, "two.txt"), "second read result", "utf8");
  config.set("global", "model.default", "test-model"); config.set("global", "tools.maxParallelReads", 4); config.set("mission", "tools.maxParallelReads", 2, "parallel-mission");
  const batches: Array<Record<string, unknown>> = [];
  events.on("agent.tools.batch_started", (event) => batches.push(event.payload as Record<string, unknown>));
  const provider = { redact: (value: string) => value, streamChatWithTools: async () => ({ choices: [{ message: { role: "assistant", content: null, tool_calls: [
    { id: "read-one", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "one.txt" }) } },
    { id: "read-two", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "two.txt" }) } }
  ] } }] }) };
  try {
    const result = await new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never }).run("Read both independent files", { workspace: root, missionId: "parallel-mission", maxTurns: 1 });
    assert.equal(result.status, "limit");
    assert.deepEqual(batches, [{ kind: "parallel_read", calls: 2, concurrency: 2 }]);
    const calls = store.db.prepare("SELECT id,status,output_json FROM tool_calls WHERE session_id=? ORDER BY rowid").all(result.sessionId) as Array<{ id: string; status: string; output_json: string }>;
    assert.deepEqual(calls.map(({ id, status }) => [id, status]), [["read-one", "completed"], ["read-two", "completed"]]);
    assert.match(calls[0]!.output_json, /first read result/); assert.match(calls[1]!.output_json, /second read result/);
    const toolMessages = (sessions.messages(result.sessionId) as Array<{ role: string; content: string }>).filter((message) => message.role === "tool").map((message) => JSON.parse(message.content.slice("__xyst_api_message__:".length)) as Record<string, unknown>);
    assert.deepEqual(toolMessages.map((message) => message.tool_call_id), ["read-one", "read-two"]);
  } finally { store.close(); }
}));

test("agent model loading and idle-unload policies control local loads and request TTL", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "model-lifecycle.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model"); config.set("global", "models.automaticUnloading", true); config.set("global", "models.idleUnloadSeconds", 900);
  let loaded = false; let loads = 0; let loadContext = 0; let generations = 0; let captured: Record<string, unknown> = {};
  const provider = {
    redact: (value: string) => value, isLocalServer: () => true,
    models: async () => [{ type: "llm", key: "test-model", size_bytes: 1, max_context_length: 8192, loaded_instances: loaded ? [{ id: "xyst-load", config: {} }] : [] }],
    load: async (_key: string, options: Record<string, unknown>) => { loads++; loaded = true; loadContext = Number(options.context_length); assert.equal(options.ttl_seconds, 900); assert.ok(loadContext > 4096 && loadContext <= 8192); return {}; },
    streamChatWithTools: async (request: Record<string, unknown>) => { generations++; captured = request; return { choices: [{ message: { role: "assistant", content: "Done" } }] }; }
  };
  const runner = new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never });
  try {
    const result = await runner.run("Use the model", { workspace: root });
    assert.equal(result.status, "unverified"); assert.equal(loads, 1); assert.equal(loadContext, Math.min(8192, estimateRequiredContextTokens([{ content: "Use the model" }]) + MODEL_CONTEXT_HEADROOM_TOKENS)); assert.equal(generations, 1); assert.equal(captured.ttl, 900);
    loaded = false; config.set("global", "models.automaticLoading", false);
    await assert.rejects(() => runner.run("Do not load", { workspace: root }), /automatic model loading is off/);
    assert.equal(loads, 1); assert.equal(generations, 1);
    assert.throws(() => config.set("global", "models.idleUnloadSeconds", 30), /models.idleUnloadSeconds must be an integer/);
  } finally { store.close(); }
}));

test("remote LM Studio fallback stays opt-in and requires per-run consent before sending context", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "remote-fallback.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "local-model"); config.set("global", "models.remoteFallback", true); config.set("global", "models.remoteFallbackModel", "remote-model");
  let localAttempts = 0; let remoteRequests = 0; let remoteLoadRequests = 0; let remoteBody = ""; let remoteLoaded = false;
  const server = createServer((request, response) => {
    if (request.url === "/api/v1/models") { remoteRequests++; response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ models: [{ type: "llm", key: "remote-model", publisher: "test", display_name: "Remote", size_bytes: 1, loaded_instances: remoteLoaded ? [{ id: "remote-instance", config: {} }] : [] }] })); return; }
    if (request.url === "/api/v1/models/load") { remoteLoadRequests++; remoteLoaded = true; response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ status: "loaded", load_config: { context_length: 8192 } })); return; }
    if (request.url === "/v1/chat/completions") {
      remoteRequests++; request.setEncoding("utf8"); request.on("data", (chunk: string) => { remoteBody += chunk; }); request.on("end", () => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "Remote answer" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`); }); return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  config.set("global", "models.remoteFallbackUrl", `http://127.0.0.1:${address.port}`);
  const provider = { redact: (value: string) => value, isLocalServer: () => true, models: async () => [{ type: "llm", key: "local-model", size_bytes: 1, loaded_instances: [{ id: "user-loaded", config: {} }] }], streamChatWithTools: async () => { localAttempts++; throw new Error("local inference unavailable"); } };
  const runner = new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never });
  try {
    await assert.rejects(() => runner.run("PRIVATE task context", { workspace: root, approveRemoteFallback: async () => false }), /fallback was denied/);
    assert.equal(remoteRequests, 0); assert.equal(remoteBody, "");
    const result = await runner.run("PRIVATE task context", { workspace: root, approveRemoteFallback: async (request) => { assert.equal(request.model, "remote-model"); assert.match(request.endpoint, /127\.0\.0\.1/); return true; } });
    assert.equal(result.model, "remote-model"); assert.equal(result.response, "Remote answer"); assert.ok(localAttempts >= 6);
    assert.match(remoteBody, /PRIVATE task context/); assert.match(remoteBody, /"tools"/);
    assert.equal(remoteLoadRequests, 0, "custom loopback API ports must stay on the HTTP/JIT path rather than calling the default lms CLI server");
    assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM usage WHERE provider='lm-studio'").get() as { count: number }).count, 2, "local failure samples are retained but remote inference is not added to local-only telemetry");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); }
}));

test("file patch rejects stale edits and preserves UTF-8 BOM and CRLF", async () => withTemp(async (root) => {
  const path = join(root, "source.txt"); const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("alpha\r\nbeta\r\n", "utf8")]); await writeFile(path, original);
  const read = await readText(path); assert.equal(read.text, "alpha\nbeta\n");
  const patched = await patchText(path, read.sha256, "alpha\nbeta", "alpha\ngamma");
  const content = await readFileAsync(path); assert.ok(content.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))); assert.equal(content.subarray(3).toString("utf8"), "alpha\r\ngamma\r\n");
  await assert.rejects(() => patchText(path, read.sha256, "gamma", "delta"), /changed since it was read/);
  await createText(join(root, "new.txt"), "safe"); await assert.rejects(() => createText(join(root, "new.txt"), "overwrite"), /already exists/);
  assert.equal(patched.path, path);
}));

test("text search ignores dependency and build output directories", async () => withTemp(async (root) => {
  await createText(join(root, "src.ts"), "needle in source"); await mkdir(join(root, "node_modules", "pkg"), { recursive: true }); await writeFile(join(root, "node_modules", "pkg", "generated.js"), "needle in dependency");
  const matches = await searchFiles(root, "needle"); assert.equal(matches.length, 1); assert.equal(matches[0]?.path, join(root, "src.ts"));
}));

test("direct process execution preserves argv without shell interpretation", async () => {
  const literal = "two words; echo not-a-command";
  const result = await runProcess(process.execPath, ["-e", "process.stdout.write(process.argv[1])", literal]);
  assert.equal(result.code, 0); assert.equal(result.stdout, literal);
});

test("a process that cannot start lets the agent correct the command without reconciliation", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "process-start.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model"); let round = 0;
  const marker = join(root, "executed.txt");
  const provider = {
    redact: (value: string) => value,
    streamChatWithTools: async () => {
      round++;
      const input = round === 1
        ? { executable: join(root, "missing-executable"), args: [] }
        : round === 2
          ? { executable: process.execPath, args: ["\u0000"] }
          : { executable: process.execPath, args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'executed')", marker] };
      return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: `start-${round}`, type: "function", function: { name: "run_process", arguments: JSON.stringify(input) } }] } }] };
    }
  };
  try {
    const result = await new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never })
      .run("Execute the requested program.", { workspace: root, maxTurns: 3 });
    assert.equal(result.status, "limit");
    const failed = store.db.prepare("SELECT status,output_json FROM tool_calls WHERE id='start-1'").get() as { status: string; output_json: string };
    assert.equal(failed.status, "failed");
    assert.match(failed.output_json, /Process did not start:.*ENOENT/);
    assert.equal((store.db.prepare("SELECT status FROM tool_calls WHERE id='start-2'").get() as { status: string }).status, "failed");
    assert.equal((store.db.prepare("SELECT status FROM tool_calls WHERE id='start-3'").get() as { status: string }).status, "completed");
    assert.equal(await readFileAsync(marker, "utf8"), "executed");
    assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM tool_calls WHERE status='uncertain'").get() as { count: number }).count, 0);
    assert.equal(round, 3);
  } finally { store.close(); }
}));

test("a process timeout after writing a file still requires external-action reconciliation", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "process-timeout.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model");
  const marker = join(root, "partial-effect.txt");
  const provider = {
    redact: (value: string) => value,
    streamChatWithTools: async () => ({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "started-then-timeout", type: "function", function: { name: "run_process", arguments: JSON.stringify({ executable: process.execPath, args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'partial'); setInterval(() => {}, 1000)", marker], timeout_ms: 1200 }) } }] } }] })
  };
  try {
    await assert.rejects(() => new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never })
      .run("Execute the requested program.", { workspace: root, maxTurns: 2 }), /EXTERNAL_ACTION_UNCERTAIN/);
    assert.equal(await readFileAsync(marker, "utf8"), "partial");
    const action = store.db.prepare("SELECT status,output_json FROM tool_calls WHERE id='started-then-timeout'").get() as { status: string; output_json: string };
    assert.equal(action.status, "uncertain");
    assert.match(action.output_json, /timed out/);
  } finally { store.close(); }
}));

test("aborting a process execution terminates it and returns a cancellation error", async () => {
  const controller = new AbortController();
  const running = runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { signal: controller.signal });
  setTimeout(() => controller.abort(), 75);
  await assert.rejects(running, /Process cancelled/);
});

test("restricted profiles block paths and executables outside explicit allowlists", async () => withTemp(async (root) => {
  const allowed = join(root, "allowed"); const denied = join(root, "denied"); await mkdir(allowed); await mkdir(denied);
  const access = new AccessController({ mode: "restricted", readRoots: [allowed], writeRoots: [allowed], allowedExecutables: ["node"] });
  assert.equal(await access.assertPath(join(allowed, "file"), "write"), await realpath(allowed).then((path) => join(path, "file")));
  await assert.rejects(() => access.assertPath(join(denied, "file"), "read"), /denies read access/); assert.throws(() => access.assertExecutable("powershell.exe"), /denies execution/);
  const delegatedFull = new AccessController({ mode: "full" }, access);
  await assert.rejects(() => delegatedFull.assertPath(join(denied, "file"), "read"), /denies read access/);
  assert.throws(() => delegatedFull.assertCapability("network"), /denies network/);
}));

test("restricted path checks return the canonical symlink target and block out-of-root links", async (t) => withTemp(async (root) => {
  const allowed = join(root, "allowed"); const denied = join(root, "denied");
  await mkdir(allowed); await mkdir(denied);
  const insideFile = join(allowed, "inside.txt"); const outsideFile = join(denied, "secret.txt");
  await writeFile(insideFile, "inside"); await writeFile(outsideFile, "outside");
  const insideLink = join(allowed, "inside-link.txt"); const outsideLink = join(allowed, "outside-link.txt");
  try { await symlink(insideFile, insideLink); await symlink(outsideFile, outsideLink); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("Windows symlink privilege is unavailable in this environment"); return; } throw error; }
  const access = new AccessController({ mode: "restricted", readRoots: [allowed], writeRoots: [allowed] });
  assert.equal(await access.assertPath(insideLink, "read"), await realpath(insideFile));
  const nestedAccess = new AccessController({ mode: "restricted", readRoots: [root], writeRoots: [root] }, access);
  assert.equal(await nestedAccess.assertPath(insideLink, "read"), await realpath(insideFile));
  await assert.rejects(() => access.assertPath(outsideLink, "read"), /denies read access/);
  await assert.rejects(() => access.assertPath(outsideLink, "write"), /denies write access/);
}));

test("Windows restricted path checks resolve junctions before allowing file operations", { skip: process.platform !== "win32" }, async () => withTemp(async (root) => {
  const allowed = join(root, "allowed"); const denied = join(root, "denied"); const target = join(allowed, "target");
  await mkdir(target, { recursive: true }); await mkdir(denied);
  const insideFile = join(target, "inside.txt"); const outsideFile = join(denied, "secret.txt");
  await writeFile(insideFile, "inside"); await writeFile(outsideFile, "outside");
  const insideJunction = join(allowed, "inside-junction"); const outsideJunction = join(allowed, "outside-junction");
  await symlink(target, insideJunction, "junction"); await symlink(denied, outsideJunction, "junction");
  const access = new AccessController({ mode: "restricted", readRoots: [allowed], writeRoots: [allowed] });
  assert.equal(await access.assertPath(join(insideJunction, "inside.txt"), "read"), await realpath(insideFile));
  const nestedAccess = new AccessController({ mode: "restricted", readRoots: [root], writeRoots: [root] }, access);
  assert.equal(await nestedAccess.assertPath(join(insideJunction, "inside.txt"), "read"), await realpath(insideFile));
  assert.equal(await access.assertPath(join(insideJunction, "new.txt"), "write"), join(await realpath(target), "new.txt"));
  await assert.rejects(() => access.assertPath(join(outsideJunction, "secret.txt"), "read"), /denies read access/);
  await assert.rejects(() => access.assertPath(join(outsideJunction, "new.txt"), "write"), /denies write access/);
}));

test("Windows long paths support atomic create, read, and patch", { skip: process.platform !== "win32" }, async () => withTemp(async (root) => {
  let directory = root;
  for (let index = 0; index < 14; index++) { directory = join(directory, index === 7 ? `segment-${index}-段-雪-🤖-${"x".repeat(14)}` : `segment-${index}-${"x".repeat(14)}`); await mkdir(directory); }
  const path = join(directory, "long-path.txt"); assert.ok(path.length > 260);
  const access = new AccessController({ mode: "restricted", readRoots: [root], writeRoots: [root] });
  const writePath = await access.assertPath(path, "write");
  const created = await createText(writePath, "first\r\nline — café — 🤖"); assert.equal(created, writePath);
  const readPath = await access.assertPath(path, "read"); const original = await readText(readPath); assert.equal(original.text, "first\nline — café — 🤖");
  const patchPath = await access.assertPath(path, "write");
  await patchText(patchPath, original.sha256, "first", "second");
  assert.equal((await readText(await access.assertPath(path, "read"))).text, "second\nline — café — 🤖");
}));

test("Windows path normalization preserves drive, UNC, and extended UNC roots", { skip: process.platform !== "win32" }, () => {
  assert.equal(normalizeUserPath("C:\\workspace\\folder\\..\\file.txt"), "C:\\workspace\\file.txt");
  assert.equal(normalizeUserPath("\\\\server\\share\\folder\\..\\file.txt"), "\\\\server\\share\\file.txt");
  assert.equal(normalizeUserPath("\\\\?\\C:\\workspace\\folder\\..\\file.txt"), "\\\\?\\C:\\workspace\\file.txt");
  assert.equal(normalizeUserPath("\\\\?\\UNC\\server\\share\\folder\\..\\file.txt"), "\\\\?\\UNC\\server\\share\\file.txt");
});

test("secrets are redacted and automatic selection prefers a tool capable model", () => {
  assert.equal(redactSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz"), "Authorization: [REDACTED]");
  assert.equal(redactSecrets("remote https://user:private-pass@example.com/team/repo.git"), "remote https://[REDACTED]@example.com/team/repo.git");
  const choice = chooseAgentModel([
    { type: "llm", publisher: "lmstudio-community", key: "small", display_name: "Small", size_bytes: 1_000_000_000, loaded_instances: [], max_context_length: 8192, capabilities: { trained_for_tool_use: false } },
    { type: "llm", publisher: "mistralai", key: "mistralai/ministral-3-3b", display_name: "Ministral 3B", size_bytes: 1_400_000_000, loaded_instances: [], max_context_length: 128000, capabilities: { trained_for_tool_use: true } }
  ]);
  assert.equal(choice.model.key, "mistralai/ministral-3-3b"); assert.match(choice.reason, /tool-use support/);
});

test("Linux credential errors explain the missing Secret Service without losing their cause", () => {
  const cause = new Error("The name org.freedesktop.secrets was not provided by any .service files");
  const error = credentialStoreError(cause, "linux");
  assert.match(error.message, /running Secret Service/);
  assert.equal(error.cause, cause);
  assert.match(credentialStoreError(new Error("vault locked"), "win32").message, /vault locked/);
});

test("LM Studio daemon diagnostics distinguish llmster from the desktop app", () => {
  assert.deepEqual(parseLmsDaemonStatus('{"status":"running","pid":46236,"isDaemon":true}'), {
    available: true, status: "running", service: "llmster", pid: 46236,
    explanation: "The headless LM Studio daemon is running."
  });
  assert.equal(parseLmsDaemonStatus('{"status":"running","isDaemon":false}').service, "desktop-app");
  assert.equal(parseLmsDaemonStatus('{"status":"not-running"}').status, "not-running");
  assert.equal(parseLmsDaemonStatus("not-json").status, "unknown");
});

test("GitHub API tools pass agent cancellation through to HTTP requests", async () => {
  const toolController = new AbortController(); let forwardedSignal: AbortSignal | undefined;
  const tool = createGitHubTools(new AccessController(), { repository: async (_owner: string, _repo: string, signal?: AbortSignal) => { forwardedSignal = signal; return {}; } } as never, { writesEnabled: true, mergeAuthorized: false }).github_repository!;
  await tool.execute({ owner: "example", repo: "repo" }, toolController.signal);
  assert.equal(forwardedSignal, toolController.signal);

  const server = createServer(() => undefined);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const controller = new AbortController();
  const provider = new GitHubProvider({ get: async () => undefined } as never, { apiBase: `http://127.0.0.1:${address.port}` });
  const request = provider.repository("example", "repo", controller.signal);
  setTimeout(() => controller.abort(), 50);
  try { await assert.rejects(request, /GitHub connection failed/); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("GitHub pull request review comments use guarded tools and current diff coordinates", async () => {
  const originalFetch = globalThis.fetch; const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input); const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    requests.push({ url, method, ...(body ? { body } : {}) });
    return method === "GET" ? Response.json([{ id: 42, path: "src/main.ts", line: 18, body: "Could this handle errors?" }]) : Response.json({ id: 43, path: "src/main.ts", line: 18, body: body?.body });
  };
  const provider = new GitHubProvider({ get: async () => undefined } as never, { apiBase: "https://api.github.test" });
  const tools = createGitHubTools(new AccessController(), provider, { writesEnabled: true, mergeAuthorized: false });
  try {
    const comments = await tools.github_pull_request_review_comments!.execute({ owner: "example", repo: "project", number: 7 });
    assert.deepEqual(comments, [{ id: 42, path: "src/main.ts", line: 18, body: "Could this handle errors?" }]);
    const posted = await tools.github_create_review_comment!.execute({ owner: "example", repo: "project", number: 7, body: "Please handle this case.", commitId: "a".repeat(40), path: "src/main.ts", line: 18, side: "RIGHT" });
    assert.deepEqual(posted, { id: 43, path: "src/main.ts", line: 18, body: "Please handle this case." });
    assert.equal(requests[0]?.url, "https://api.github.test/repos/example/project/pulls/7/comments?per_page=100");
    assert.equal(requests[1]?.method, "POST");
    assert.deepEqual(requests[1]?.body, { body: "Please handle this case.", commit_id: "a".repeat(40), path: "src/main.ts", line: 18, side: "RIGHT" });
    await tools.github_create_review_comment!.execute({ owner: "example", repo: "project", number: 7, body: "This range shares the same issue.", commitId: "b".repeat(40), path: "src/main.ts", startLine: 16, startSide: "RIGHT", line: 18, side: "RIGHT" });
    assert.deepEqual(requests[2]?.body, { body: "This range shares the same issue.", commit_id: "b".repeat(40), path: "src/main.ts", line: 18, side: "RIGHT", start_line: 16, start_side: "RIGHT" });
    await tools.github_create_review_comment!.execute({ owner: "example", repo: "project", number: 7, body: "Thanks, fixed.", replyTo: 42 });
    assert.equal(requests[3]?.url, "https://api.github.test/repos/example/project/pulls/7/comments/42/replies");
    assert.deepEqual(requests[3]?.body, { body: "Thanks, fixed." });
    const blocked = createGitHubTools(new AccessController({ mode: "restricted", network: true, integrations: true, externalActions: false }), provider, { writesEnabled: true, mergeAuthorized: false }).github_create_review_comment!;
    await assert.rejects(blocked.execute({ owner: "example", repo: "project", number: 7, body: "comment", commitId: "a".repeat(40), path: "src/main.ts", line: 18 }), /denies externalActions/);
    await assert.rejects(tools.github_create_review_comment!.execute({ owner: "example", repo: "project", number: 7, body: "comment", commitId: "bad", path: "src/main.ts", line: 18 }), /commitId/);
    assert.equal(requests.length, 4, "policy and schema errors must not make API requests");
  } finally { globalThis.fetch = originalFetch; }
});

test("GitHub workflow logs, releases, and artifacts are bounded read-only tools", async () => {
  const originalFetch = globalThis.fetch; const zip = new JSZip(); zip.file("build/1_job.txt", "compile started\ncompile passed\n"); zip.file("build/secrets.txt", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789\n");
  const archive = await zip.generateAsync({ type: "nodebuffer" }); const urls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input); urls.push(url);
    if (url.endsWith("/actions/runs/17/logs")) return new Response(new Uint8Array(archive), { status: 200 });
    if (url.endsWith("/releases?per_page=100")) return Response.json([{ id: 8, tag_name: "v1", assets: [{ name: "xyst.zip" }] }]);
    if (url.endsWith("/actions/artifacts?per_page=100&page=1")) return Response.json({ total_count: 1, artifacts: [{ id: 9, name: "build", size_in_bytes: 12 }] });
    throw new Error(`Unexpected GitHub URL ${url}`);
  };
  const provider = new GitHubProvider({ get: async () => undefined } as never, { apiBase: "https://api.github.test" });
  const tools = createGitHubTools(new AccessController(), provider, { writesEnabled: false, mergeAuthorized: false });
  try {
    assert.deepEqual(await tools.github_workflow_run_logs!.execute({ owner: "example", repo: "project", runId: 17 }), { runId: 17, files: [{ name: "build/1_job.txt", text: "compile started\ncompile passed\n" }, { name: "build/secrets.txt", text: "Authorization: [REDACTED]\n" }] });
    assert.deepEqual(await tools.github_releases!.execute({ owner: "example", repo: "project" }), [{ id: 8, tag_name: "v1", assets: [{ name: "xyst.zip" }] }]);
    assert.deepEqual(await tools.github_actions_artifacts!.execute({ owner: "example", repo: "project" }), [{ id: 9, name: "build", size_in_bytes: 12 }]);
    assert.deepEqual(urls, ["https://api.github.test/repos/example/project/actions/runs/17/logs", "https://api.github.test/repos/example/project/releases?per_page=100", "https://api.github.test/repos/example/project/actions/artifacts?per_page=100&page=1"]);
    const restricted = createGitHubTools(new AccessController({ mode: "restricted", network: true, integrations: false }), provider, { writesEnabled: false, mergeAuthorized: false }).github_releases!;
    await assert.rejects(restricted.execute({ owner: "example", repo: "project" }), /denies integrations/);
  } finally { globalThis.fetch = originalFetch; }
});

test("GitHub release and Actions artifact downloads stay within profile paths and never overwrite", async () => withTemp(async (root) => {
  const originalFetch = globalThis.fetch; const archive = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); const urls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input); urls.push(url);
    if (url.endsWith("/releases/assets/24") || url.endsWith("/actions/artifacts/25/zip")) return new Response(archive, { status: 200, headers: { "content-type": "application/zip" } });
    throw new Error(`Unexpected GitHub URL ${url}`);
  };
  const provider = new GitHubProvider({ get: async () => undefined } as never, { apiBase: "https://api.github.test" });
  const access = new AccessController({ mode: "restricted", network: true, integrations: true, readRoots: [root], writeRoots: [root] });
  const tools = createGitHubTools(access, provider, { writesEnabled: false, mergeAuthorized: false });
  const assetPath = join(root, "release.zip"); const artifactPath = join(root, "artifact.zip");
  try {
    const releaseResult = await tools.github_download_release_asset!.execute({ owner: "example", repo: "project", assetId: 24, destination: assetPath }) as { path: string; bytes: number };
    const artifactResult = await tools.github_download_actions_artifact!.execute({ owner: "example", repo: "project", artifactId: 25, destination: artifactPath }) as { path: string; bytes: number };
    assert.equal(releaseResult.bytes, archive.byteLength); assert.equal(artifactResult.bytes, archive.byteLength);
    assert.equal(await realpath(releaseResult.path), await realpath(assetPath)); assert.equal(await realpath(artifactResult.path), await realpath(artifactPath));
    assert.deepEqual(await readFileAsync(assetPath), Buffer.from(archive)); assert.deepEqual(await readFileAsync(artifactPath), Buffer.from(archive));
    await assert.rejects(tools.github_download_release_asset!.execute({ owner: "example", repo: "project", assetId: 24, destination: assetPath }), /already exists|EEXIST/);
    const denied = createGitHubTools(new AccessController({ mode: "restricted", network: true, integrations: true, readRoots: [root], writeRoots: [] }), provider, { writesEnabled: false, mergeAuthorized: false }).github_download_release_asset!;
    await assert.rejects(denied.execute({ owner: "example", repo: "project", assetId: 24, destination: join(root, "denied.zip") }), /denies write access/);
    assert.deepEqual(urls, ["https://api.github.test/repos/example/project/releases/assets/24", "https://api.github.test/repos/example/project/actions/artifacts/25/zip"]);
  } finally { globalThis.fetch = originalFetch; }
}));

test("authorized GitHub workflow dispatch uses the requested workflow ref and inputs", async () => {
  const originalFetch = globalThis.fetch; const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input); const method = init?.method ?? "GET"; const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ url, method, ...(body === undefined ? {} : { body }) });
    return new Response(null, { status: 204 });
  };
  const provider = new GitHubProvider({ get: async () => undefined } as never, { apiBase: "https://api.github.test" });
  try {
    const enabled = createGitHubTools(new AccessController(), provider, { writesEnabled: true, mergeAuthorized: false });
    assert.deepEqual(await enabled.github_workflow_dispatch!.execute({ owner: "example", repo: "project", workflow: "workflows/verify.yml", ref: "feature/dispatch", inputs: { suite: "runtime", dry_run: "true" } }), { dispatched: true });
    assert.deepEqual(requests, [{
      url: "https://api.github.test/repos/example/project/actions/workflows/workflows%2Fverify.yml/dispatches",
      method: "POST",
      body: { ref: "feature/dispatch", inputs: { suite: "runtime", dry_run: "true" } }
    }]);
    const writesDisabled = createGitHubTools(new AccessController(), provider, { writesEnabled: false, mergeAuthorized: false });
    await assert.rejects(writesDisabled.github_workflow_dispatch!.execute({ owner: "example", repo: "project", workflow: "workflows/verify.yml", ref: "main" }), /write actions are disabled/);
    const restricted = createGitHubTools(new AccessController({ mode: "restricted", network: true, integrations: true, externalActions: false }), provider, { writesEnabled: true, mergeAuthorized: false });
    await assert.rejects(restricted.github_workflow_dispatch!.execute({ owner: "example", repo: "project", workflow: "workflows/verify.yml", ref: "main" }), /denies externalActions/);
    assert.equal(requests.length, 1, "disabled or restricted dispatch must not reach GitHub");
  } finally { globalThis.fetch = originalFetch; }
});

test("GitHub issue labels and pull request updates require enabled external writes", async () => {
  const originalFetch = globalThis.fetch; const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input); const method = init?.method ?? "GET"; const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ url, method, ...(body === undefined ? {} : { body }) });
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (url.includes("/pulls/")) return Response.json({ number: 7, title: body?.title ?? "Existing", state: body?.state ?? "open", html_url: "https://github.test/pr/7", head: { ref: "topic", sha: "a".repeat(40) }, base: { ref: body?.base ?? "main" } });
    return Response.json([{ name: "bug" }]);
  };
  const provider = new GitHubProvider({ get: async () => undefined } as never, { apiBase: "https://api.github.test" });
  const tools = createGitHubTools(new AccessController(), provider, { writesEnabled: true, mergeAuthorized: false });
  try {
    assert.deepEqual(await tools.github_issue_labels!.execute({ owner: "example", repo: "project", number: 7 }), [{ name: "bug" }]);
    assert.deepEqual(await tools.github_issue_labels_add!.execute({ owner: "example", repo: "project", number: 7, labels: ["bug", "triage"] }), [{ name: "bug" }]);
    assert.deepEqual(await tools.github_issue_labels_replace!.execute({ owner: "example", repo: "project", number: 7, labels: [] }), [{ name: "bug" }]);
    assert.deepEqual(await tools.github_issue_label_remove!.execute({ owner: "example", repo: "project", number: 7, label: "needs review" }), { removed: true });
    const updated = await tools.github_update_pull_request!.execute({ owner: "example", repo: "project", number: 7, title: "Clarified", state: "closed" });
    assert.equal((updated as { title: string }).title, "Clarified");
    assert.deepEqual(requests.map(({ url, method, body }) => ({ url, method, body })), [
      { url: "https://api.github.test/repos/example/project/issues/7/labels?per_page=100", method: "GET", body: undefined },
      { url: "https://api.github.test/repos/example/project/issues/7/labels", method: "POST", body: { labels: ["bug", "triage"] } },
      { url: "https://api.github.test/repos/example/project/issues/7/labels", method: "PUT", body: { labels: [] } },
      { url: "https://api.github.test/repos/example/project/issues/7/labels/needs%20review", method: "DELETE", body: undefined },
      { url: "https://api.github.test/repos/example/project/pulls/7", method: "PATCH", body: { title: "Clarified", state: "closed" } }
    ]);
    const blocked = createGitHubTools(new AccessController({ mode: "restricted", network: true, integrations: true, externalActions: false }), provider, { writesEnabled: true, mergeAuthorized: false });
    await assert.rejects(blocked.github_issue_labels_add!.execute({ owner: "example", repo: "project", number: 7, labels: ["bug"] }), /denies externalActions/);
    await assert.rejects(tools.github_update_pull_request!.execute({ owner: "example", repo: "project", number: 7 }), /At least one pull request field/);
    assert.equal(requests.length, 5, "policy and schema errors must not make API requests");
  } finally { globalThis.fetch = originalFetch; }
});

test("GitHub Enterprise settings select a validated API base and host-scoped Git credentials", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "github-enterprise.sqlite"));
  const config = new ConfigStore(store);
  const apiBaseUrl = "https://github.example.com/api/v3";
  config.set("global", "integrations.github.apiBaseUrl", apiBaseUrl);
  assert.throws(() => config.set("global", "integrations.github.apiBaseUrl", "http://github.example.com/api/v3"), /HTTPS/);
  assert.throws(() => config.set("global", "integrations.github.apiBaseUrl", "https://user:secret@github.example.com/api/v3"), /without credentials/);
  const provider = new GitHubProvider({ get: async () => undefined } as never, { config });
  assert.equal(provider.enterpriseHost, "github.example.com");
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (input) => { requestedUrl = String(input); return Response.json({ full_name: "team/project", html_url: "https://github.example.com/team/project", default_branch: "main", private: true, description: null }); };
  try {
    const repo = await provider.repository("team", "project");
    assert.equal(repo.full_name, "team/project");
    assert.equal(requestedUrl, `${apiBaseUrl}/repos/team/project`);
  } finally { globalThis.fetch = originalFetch; store.close(); }
}));

test("Git workflow stages and commits selected paths, fetches, and pushes without bypassing access policy", async () => withTemp(async (root) => {
  const repo = join(root, "repo"); const bare = join(root, "remote.git"); await mkdir(repo);
  await git(["init", "--quiet"], { cwd: repo });
  await git(["config", "user.name", "Xyst Test"], { cwd: repo }); await git(["config", "user.email", "xyst-test@example.invalid"], { cwd: repo });
  await git(["branch", "-M", "main"], { cwd: repo }); await writeFile(join(repo, "README.md"), "base\n");
  await git(["add", "--", "README.md"], { cwd: repo }); await git(["commit", "--quiet", "-m", "base"], { cwd: repo });
  await git(["init", "--bare", "--quiet", bare]); await git(["remote", "add", "origin", bare], { cwd: repo });
  const access = new AccessController(); await gitCreateBranch(access, "feature/git-tools", repo);
  const token = "github-test-token"; const authEnv = gitNetworkEnvironment(token, { PATH: process.env.PATH });
  const header = await runProcess("git", ["config", "--get-urlmatch", "http.extraheader", "https://github.com/example/repo.git"], { cwd: repo, env: authEnv });
  assert.equal(header.stdout.trim(), `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`);
  assert.equal(authEnv.GIT_TERMINAL_PROMPT, "0"); assert.equal(authEnv.GIT_CONFIG_VALUE_0?.includes(token), false);
  const enterpriseEnv = gitNetworkEnvironment(token, { PATH: process.env.PATH }, "github.example.com");
  const enterpriseHeader = await runProcess("git", ["config", "--get-urlmatch", "http.extraheader", "https://github.example.com/team/project.git"], { cwd: repo, env: enterpriseEnv });
  const unrelatedHeader = await runProcess("git", ["config", "--get-urlmatch", "http.extraheader", "https://other.example.com/team/project.git"], { cwd: repo, env: enterpriseEnv });
  assert.equal(enterpriseHeader.stdout.trim(), `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`);
  assert.equal(unrelatedHeader.code, 1, "enterprise credentials must not match other HTTPS hosts");
  const enterpriseRepo = join(root, "enterprise-repo"); await mkdir(enterpriseRepo); await git(["init", "--quiet"], { cwd: enterpriseRepo }); await git(["remote", "add", "origin", "https://github.example.com/team/project.git"], { cwd: enterpriseRepo });
  await assert.rejects(gitFetch(access, "origin", undefined, enterpriseRepo, undefined, { enabled: false, enterpriseHost: "github.example.com" }), /GitHub fetch requires integrations.github.enabled/);
  await assert.rejects(gitPush(access, "origin", "main", enterpriseRepo, undefined, { enabled: false, writesEnabled: false, enterpriseHost: "github.example.com" }), /GitHub push requires integrations.github.enabled/);
  await writeFile(join(repo, "README.md"), "feature change\n"); await writeFile(join(repo, "unrelated.txt"), "leave staged\n");
  await gitStage(access, ["README.md"], repo); await git(["add", "--", "unrelated.txt"], { cwd: repo });
  const committed = await gitCommit(access, "Implement scoped Git operations", ["README.md"], repo);
  assert.match(committed.commit, /^[a-f0-9]{40,64}$/); assert.deepEqual(committed.paths, ["README.md"]);
  assert.equal(await git(["diff", "--cached", "--name-only"], { cwd: repo }), "unrelated.txt", "unrelated staged changes must remain outside the commit");
  await gitPush(access, "origin", undefined, repo);
  await gitFetch(access, "origin", "feature/git-tools", repo);
  assert.match(await git(["show-ref", "--verify", "refs/remotes/origin/feature/git-tools"], { cwd: repo }), /refs\/remotes\/origin\/feature\/git-tools$/);
  await git(["symbolic-ref", "HEAD", "refs/heads/feature/git-tools"], { cwd: bare });
  const clonePath = join(root, "clone");
  assert.equal((await gitClone(access, pathToFileURL(bare).href, "clone", root)).path, clonePath);
  assert.match(await gitStatus(access, clonePath), /## feature\/git-tools/);
  const localOnly = new AccessController({ mode: "restricted", readRoots: [root], writeRoots: [root], allowedExecutables: ["git"], network: false, integrations: false, externalActions: true });
  await gitClone(localOnly, pathToFileURL(bare).href, "clone-restricted", root);
  const githubUrl = "https://github.com/example/repo.git"; await git(["remote", "set-url", "origin", githubUrl], { cwd: repo });
  await assert.rejects(gitFetch(access, "origin", undefined, repo, undefined, { enabled: false }), /requires integrations\.github\.enabled/);
  await assert.rejects(gitPush(access, "origin", undefined, repo, undefined, { enabled: true, writesEnabled: false }), /requires integrations\.github\.enabled and integrations\.github\.writeEnabled/);
  const noGit = new AccessController({ mode: "restricted", readRoots: [repo], writeRoots: [repo], allowedExecutables: [], network: true, externalActions: true });
  await assert.rejects(gitStatus(noGit, repo), /denies execution of git/);
  const noActions = new AccessController({ mode: "restricted", readRoots: [repo], writeRoots: [repo], allowedExecutables: ["git"], network: true, externalActions: false });
  await assert.rejects(gitStage(noActions, ["README.md"], repo), /denies externalActions/);
  await assert.rejects(gitStage(access, ["../outside.txt"], repo), /Invalid repository-relative path/);
}));

test("GitHub webhook signatures are verified and delivery IDs are deduplicated", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "webhooks.sqlite")); const body = Buffer.from('{"repository":{"full_name":"owner/repo"},"issue":{"number":7}}');
  const signature = `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`;
  assert.equal(verifyGitHubWebhook("test-secret", body, signature), true); assert.equal(verifyGitHubWebhook("wrong-secret", body, signature), false);
  assert.equal(await recordWebhookDelivery(store, "delivery-1", "issues", "owner/repo", 7), true);
  assert.equal(await recordWebhookDelivery(store, "delivery-1", "issues", "owner/repo", 7), false); store.close();
}));

test("GitHub webhook handler marks Xyst-authored events processed without re-enqueueing them", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "webhook-self-loop.sqlite")); let queued = 0;
  const handler = createGitHubWebhookHandler({
    store, secret: () => "test-secret",
    shouldIgnoreDelivery: (_event, payload) => (payload as { sender?: { login?: string } }).sender?.login?.toLowerCase() === "xyst-agent[bot]",
    onDelivery: async () => { queued++; }
  });
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const send = async (deliveryId: string, sender: string) => {
    const body = JSON.stringify({ repository: { full_name: "owner/repo" }, issue: { number: 9 }, sender: { login: sender } });
    const signature = `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`;
    const response = await fetch(`http://127.0.0.1:${address.port}`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature, "x-github-delivery": deliveryId, "x-github-event": "issue_comment" }, body });
    return { status: response.status, body: await response.json() as { ignored?: boolean; duplicate?: boolean } };
  };
  try {
    const ignored = await send("self-delivery", "Xyst-Agent[bot]");
    assert.equal(ignored.status, 202); assert.equal(ignored.body.ignored, true); assert.equal(queued, 0);
    const processed = store.db.prepare("SELECT processed_at FROM webhook_events WHERE delivery_id='self-delivery'").get() as { processed_at: string | null };
    assert.ok(processed.processed_at, "self-authored event should be durably marked as handled");
    const external = await send("external-delivery", "another-maintainer");
    assert.equal(external.body.ignored, false); assert.equal(queued, 1);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); }
}));

test("GitHub App authentication resolves its webhook actor from the app slug", async () => {
  const originalFetch = globalThis.fetch; const keys = generateKeyPairSync("rsa", { modulusLength: 2048 }); const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(); const requests: string[] = []; let installationTokenRequests = 0;
  const credentials = { get: async (service: string, key: string) => service === "github-app" ? ({ "app-id": "123", "installation-id": "456", "private-key": privateKey } as Record<string, string>)[key] : undefined };
  globalThis.fetch = async (input, init) => {
    const url = String(input); requests.push(url);
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    if (url.endsWith("/app/installations/456/access_tokens")) {
      installationTokenRequests++;
      assert.match(authorization, /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      const jwt = authorization.slice("Bearer ".length); const [header, payload, signature] = jwt.split(".");
      assert.deepEqual(JSON.parse(Buffer.from(header!, "base64url").toString("utf8")), { alg: "RS256", typ: "JWT" });
      const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as { iss: string; iat: number; exp: number };
      assert.equal(claims.iss, "123"); assert.ok(claims.exp > claims.iat); assert.ok(claims.exp - claims.iat <= 10 * 60);
      assert.equal(verifySignature("RSA-SHA256", Buffer.from(`${header}.${payload}`), keys.publicKey, Buffer.from(signature!, "base64url")), true);
      return Response.json({ token: "installation-token", expires_at: new Date(Date.now() + 60 * 60_000).toISOString() });
    }
    if (url.endsWith("/app")) return Response.json({ slug: "xyst-agent", html_url: "https://github.com/apps/xyst-agent" });
    if (url.endsWith("/repos/owner/repo")) {
      assert.equal(authorization, "Bearer installation-token");
      return Response.json({ full_name: "owner/repo", html_url: "https://github.com/owner/repo", default_branch: "main", private: true, description: null });
    }
    throw new Error(`Unexpected GitHub URL ${url}`);
  };
  try {
    const provider = new GitHubProvider(credentials as never, { apiBase: "https://api.github.test" });
    assert.deepEqual(await provider.authenticate(), { authenticated: true, login: "xyst-agent[bot]", url: "https://github.com/apps/xyst-agent", identityType: "App" });
    assert.deepEqual(await provider.authenticate(), { authenticated: true, login: "xyst-agent[bot]", url: "https://github.com/apps/xyst-agent", identityType: "App" });
    assert.equal((await provider.repository("owner", "repo")).full_name, "owner/repo");
    assert.equal(await provider.gitToken(), "installation-token");
    assert.equal(installationTokenRequests, 1, "valid installation token should be reused while it is fresh");
    assert.deepEqual(requests, ["https://api.github.test/app/installations/456/access_tokens", "https://api.github.test/app", "https://api.github.test/repos/owner/repo"]);
  } finally { globalThis.fetch = originalFetch; }
});

test("GitHub App token exchange rejects malformed responses and wraps network errors", async () => {
  const originalFetch = globalThis.fetch; const keys = generateKeyPairSync("rsa", { modulusLength: 2048 }); const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const credentials = { get: async (service: string, key: string) => service === "github-app" ? ({ "app-id": "123", "installation-id": "456", "private-key": privateKey } as Record<string, string>)[key] : undefined };
  try {
    globalThis.fetch = async () => Response.json({ token: "installation-token", expires_at: "not-a-date" });
    await assert.rejects(new GitHubProvider(credentials as never, { apiBase: "https://api.github.test" }).gitToken(), (error: unknown) => error instanceof GitHubError && /invalid expiry/.test(error.message));
    globalThis.fetch = async () => { throw new TypeError("socket unavailable"); };
    await assert.rejects(new GitHubProvider(credentials as never, { apiBase: "https://api.github.test" }).gitToken(), (error: unknown) => error instanceof GitHubError && /GitHub connection failed while requesting an App installation token: socket unavailable/.test(error.message));
    const controller = new AbortController(); controller.abort();
    globalThis.fetch = async () => { throw new DOMException("The operation was aborted", "AbortError"); };
    await assert.rejects(new GitHubProvider(credentials as never, { apiBase: "https://api.github.test" }).gitToken(controller.signal), (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  } finally { globalThis.fetch = originalFetch; }
});

test("missions validate dependency graphs and persist task checkpoints", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "missions.sqlite")); const config = new ConfigStore(store); const events = new RuntimeEvents();
  const repository = new MissionRepository(store);
  assert.throws(() => repository.create({ name: "cycle", objective: "x", tasks: [
    { id: "a", objective: "a", dependsOn: ["b"] }, { id: "b", objective: "b", dependsOn: ["a"] }
  ] }), /dependency cycle/);
  assert.throws(() => repository.create({ name: "bad workspace source", objective: "x", tasks: [
    { id: "source", objective: "source", dependsOn: [] }, { id: "reuse", objective: "reuse", workspaceFrom: "source", dependsOn: [] }
  ] }), /direct dependencies/);
  assert.throws(() => repository.create({ name: "unknown agent", objective: "x", agents: [{ id: "known", name: "Known" }], tasks: [
    { id: "task", objective: "task", dependsOn: [], agentId: "missing" }
  ] }), /Unknown agent/);
  assert.throws(() => repository.create({ name: "empty tool evidence", objective: "x", tasks: [
    { id: "task", objective: "task", dependsOn: [], requiredToolEvidence: [{ tool: "run_process" }] }
  ] }), /Tool evidence must include a process result assertion or a file_read path and content assertion/);
  assert.throws(() => repository.create({ name: "unscoped file content evidence", objective: "x", tasks: [
    { id: "task", objective: "task", dependsOn: [], requiredToolEvidence: [{ tool: "file_read", textEquals: "expected" }] }
  ] }), /Tool evidence must include a process result assertion or a file_read path and content assertion/);
  const fileEvidenceMission = repository.create({ name: "file content evidence", objective: "x", tasks: [
    { id: "task", objective: "x", dependsOn: [], requiredToolEvidence: [{ tool: "file_read", path: "proof.txt", textEquals: "expected" }] }
  ] });
  assert.deepEqual(fileEvidenceMission.definition.tasks?.[0]?.requiredToolEvidence, [{ tool: "file_read", path: "proof.txt", textEquals: "expected" }]);
  const mission = repository.create({ name: "ordered", objective: "Build it", agents: [{ id: "researcher", name: "Researcher", model: "small-model", maxTurns: 5, access: { mode: "restricted", readRoots: [root], writeRoots: [root], network: false, integrations: false, backgroundJobs: false, externalActions: false } }], tasks: [
    { id: "first", objective: "Use web_fetch for https://api.github.com/repos/owner/repo, then run_process to verify the result.", dependsOn: [], agentId: "researcher", expectedOutputs: ["analysis.md", "Created file path workshop-brief.pdf", "One-page workshop brief structure"], completionCriteria: "The analysis is saved.", requiredToolEvidence: [{ tool: "run_process", exitCode: 0, stdoutIncludes: "verified" }] }, { id: "second", objective: "Second step", dependsOn: ["first"] }
  ] });
  const objectives: string[] = []; const assignments: Array<Record<string, unknown>> = [];
  const fakeAgent = { run: async (objective: string, options: { onSession?: (id: string) => void; [key: string]: unknown }) => {
    objectives.push(objective); options.onSession?.(`session-${objectives.length}`);
    assignments.push(options);
    return { sessionId: `session-${objectives.length}`, model: "fake", selectionReason: "test", turns: 1, status: "completed" as const, response: `result-${objectives.length}` };
  } };
  const runner = new PersistentMissionRunner({ store, config, events, agent: fakeAgent as never });
  const result = await runner.run(mission.id);
  assert.equal(result.status, "completed"); assert.equal(objectives.length, 2);
  assert.match(objectives[1]!, /result-1/);
  assert.match(objectives[0]!, /analysis\.md/); assert.match(objectives[0]!, /The analysis is saved/);
  assert.equal(assignments[0]?.agentId, "researcher"); assert.equal(assignments[0]?.model, "small-model"); assert.equal(assignments[0]?.maxTurns, 5);
  assert.deepEqual(assignments[0]?.completionCriteria, ["Use web_fetch for https://api.github.com/repos/owner/repo, then run_process to verify the result.", "analysis.md", "Created file path workshop-brief.pdf", "One-page workshop brief structure", "The analysis is saved."]);
  const outputPaths = assignments[0]?.expectedOutputPaths as string[];
  assert.equal(outputPaths.length, 2, "only actual file paths should become declared file outputs");
  assert.ok(outputPaths[0]!.endsWith("analysis.md")); assert.ok(outputPaths[1]!.endsWith("workshop-brief.pdf"));
  assert.deepEqual(assignments[0]?.requiredToolEvidence, [{ tool: "run_process", exitCode: 0, stdoutIncludes: "verified" }]);
  assert.deepEqual(assignments[0]?.accessProfile, { mode: "restricted", readRoots: [root], writeRoots: [root], network: false, integrations: false, backgroundJobs: false, externalActions: false });
  const tasks = store.db.prepare("SELECT task_key,state,attempts FROM mission_tasks WHERE run_id=? ORDER BY task_key").all(result.runId) as Array<{ task_key: string; state: string; attempts: number }>;
  assert.deepEqual(tasks.map((task) => [task.task_key, task.state, task.attempts]), [["first", "completed", 1], ["second", "completed", 1]]);
  assert.equal((store.db.prepare("SELECT status FROM agents WHERE id=?").get(`${result.runId}:first`) as { status: string }).status, "completed");
  store.close();
}));

test("global mission scheduling setting stops and resumes cron registration", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "schedule-setting.sqlite")); const config = new ConfigStore(store); const events = new RuntimeEvents();
  const runner = new PersistentMissionRunner({ store, config, events, agent: { run: async () => ({ sessionId: "unused", model: "fake", turns: 1, status: "completed", response: "unused" }) } as never });
  const mission = runner.repository.create({ name: "scheduled workflow", objective: "Run on its schedule", schedule: { cron: "*/5 * * * *", timezone: "UTC", enabled: true, missedRun: "skip" } });
  try {
    config.set("global", "orchestration.scheduling.enabled", false);
    await runner.startScheduler();
    assert.equal((runner as unknown as { schedules: Map<string, unknown> }).schedules.size, 0);
    assert.equal(runner.repository.get(mission.id)?.next_run_at, null);
    config.set("global", "orchestration.scheduling.enabled", true);
    await runner.startScheduler();
    assert.equal((runner as unknown as { schedules: Map<string, unknown> }).schedules.size, 1);
    assert.ok(runner.repository.get(mission.id)?.next_run_at);
  } finally { await runner.shutdownScheduler(); store.close(); }
}));

test("mission cron scheduling resolves daylight-saving gaps and repeated hours explicitly", () => {
  const springForward = new Cron("30 2 * * *", { timezone: "America/New_York", paused: true });
  const fallBack = new Cron("30 1 * * *", { timezone: "America/New_York", paused: true });
  try {
    assert.deepEqual(springForward.nextRuns(2, new Date("2026-03-08T05:00:00.000Z")).map((date) => date.toISOString()), [
      "2026-03-08T07:30:00.000Z",
      "2026-03-09T06:30:00.000Z"
    ]);
    assert.deepEqual(fallBack.nextRuns(2, new Date("2026-11-01T04:00:00.000Z")).map((date) => date.toISOString()), [
      "2026-11-01T05:30:00.000Z",
      "2026-11-02T06:30:00.000Z"
    ]);
  } finally {
    springForward.stop();
    fallBack.stop();
  }
});

test("disabled agent delegation permits one task and rejects delegated mission graphs", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "mission-no-delegation.sqlite")); const config = new ConfigStore(store); const events = new RuntimeEvents();
  config.set("global", "orchestration.delegation.enabled", false);
  let calls = 0;
  const runner = new PersistentMissionRunner({ store, config, events, agent: { run: async () => {
    calls++;
    return { sessionId: "single-task", model: "fake", selectionReason: "test", turns: 1, status: "completed" as const, response: "complete" };
  } } as never });
  try {
    const single = runner.repository.create({ name: "Single task", objective: "Run one task", tasks: [{ id: "main", objective: "Run", dependsOn: [] }] });
    assert.equal((await runner.run(single.id)).status, "completed"); assert.equal(calls, 1);
    const graph = runner.repository.create({ name: "Multi task", objective: "Run delegated tasks", tasks: [
      { id: "first", objective: "First", dependsOn: [] }, { id: "second", objective: "Second", dependsOn: ["first"] }
    ] });
    await assert.rejects(runner.run(graph.id), /Mission delegation is disabled/);
    config.set("mission", "orchestration.delegation.enabled", true, graph.id);
    assert.equal((await runner.run(graph.id)).status, "completed"); assert.equal(calls, 3);
    const role = runner.repository.create({ name: "Named agent", objective: "Use role", agents: [{ id: "reviewer", name: "Reviewer" }], tasks: [{ id: "review", objective: "Review", dependsOn: [], agentId: "reviewer" }] });
    await assert.rejects(runner.run(role.id), /Mission delegation is disabled/); assert.equal(calls, 3);
  } finally { store.close(); }
}));

test("mission task controls persist model and turn overrides and reject live or invalid edits", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "mission-task-controls.sqlite"));
  try {
    const repository = new MissionRepository(store);
    const mission = repository.create({ name: "Task controls", objective: "Configure one task", model: "mission-model", tasks: [{ id: "review", objective: "Review the change", dependsOn: [] }] });
    const configured = repository.updateTaskControls(mission.id, "review", { model: "fast-model", maxTurns: 12 });
    assert.deepEqual([configured.definition.tasks?.[0]?.model, configured.definition.tasks?.[0]?.maxTurns], ["fast-model", 12]);
    const inherited = repository.updateTaskControls(mission.id, "review", { model: null, maxTurns: null });
    assert.deepEqual([inherited.definition.tasks?.[0]?.model, inherited.definition.tasks?.[0]?.maxTurns], [undefined, undefined]);
    assert.throws(() => repository.updateTaskControls(mission.id, "review", { maxTurns: 51 }), /integer from 1 to 50/);
    assert.throws(() => repository.updateTaskControls(mission.id, "missing", { model: "fast-model" }), /task not found/);
    repository.setStatus(mission.id, "running");
    assert.throws(() => repository.updateTaskControls(mission.id, "review", { model: "fast-model" }), /while the mission is running/);
  } finally { store.close(); }
}));

test("mission tasks can pause independently and resume their saved execution", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "mission-task-pause.sqlite")); const config = new ConfigStore(store); const events = new RuntimeEvents();
  try {
    let starts = 0; let announceStart!: () => void;
    const started = new Promise<void>((resolve) => { announceStart = resolve; });
    const runner = new PersistentMissionRunner({ store, config, events, agent: { run: async (_objective: string, options: { signal?: AbortSignal; onSession?: (id: string) => void }) => {
      starts++; options.onSession?.("task-pause-session");
      if (starts === 1) {
        announceStart();
        await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
        return { sessionId: "task-pause-session", model: "fake", selectionReason: "test", turns: 1, status: "cancelled" as const, response: "paused" };
      }
      return { sessionId: "task-pause-session", model: "fake", selectionReason: "test", turns: 1, status: "completed" as const, response: "resumed" };
    } } as never });
    const mission = runner.repository.create({ name: "Independent task pause", objective: "Pause one assignment", tasks: [{ id: "worker", objective: "Wait and resume", dependsOn: [] }] });
    const running = runner.run(mission.id); await started;
    assert.deepEqual(runner.pauseTask(mission.id, "worker"), { missionId: mission.id, taskId: "worker", status: "paused" });
    const paused = await running; assert.equal(paused.status, "paused");
    const resumed = await runner.resumeTask(mission.id, "worker"); assert.equal(resumed.status, "completed");
    assert.equal(starts, 2);
    assert.equal((store.db.prepare("SELECT state FROM mission_tasks WHERE run_id=? AND task_key='worker'").get(resumed.runId) as { state: string }).state, "completed");
  } finally { store.close(); }
}));

test("mission task retry explicitly reruns a failed assignment", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "mission-task-retry.sqlite")); const config = new ConfigStore(store); const events = new RuntimeEvents();
  try {
    let attempts = 0;
    const runner = new PersistentMissionRunner({ store, config, events, agent: { run: async () => {
      attempts++;
      if (attempts === 1) throw new Error("temporary local failure");
      return { sessionId: "task-retry-session", model: "fake", selectionReason: "test", turns: 1, status: "completed" as const, response: "recovered" };
    } } as never });
    const mission = runner.repository.create({ name: "Retry one assignment", objective: "Recover", maxRetries: 0, tasks: [{ id: "worker", objective: "Retry me", dependsOn: [] }] });
    const failed = await runner.run(mission.id); assert.equal(failed.status, "failed");
    const retried = await runner.retryTask(mission.id, "worker"); assert.equal(retried.status, "completed"); assert.equal(attempts, 2);
    assert.equal((store.db.prepare("SELECT attempts FROM mission_tasks WHERE run_id=? AND task_key='worker'").get(retried.runId) as { attempts: number }).attempts, 2);
  } finally { store.close(); }
}));

test("missions do not automatically retry an agent response without completion evidence", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "mission-unverified.sqlite")); const config = new ConfigStore(store); const events = new RuntimeEvents();
  const mission = new MissionRepository(store).create({ name: "evidence required", objective: "Complete the task", maxRetries: 4, tasks: [{ id: "deliver", objective: "Create the requested deliverable", dependsOn: [] }] });
  let calls = 0;
  const agent = { run: async () => { calls++; return { sessionId: "unverified-session", model: "test", selectionReason: "test", turns: 1, status: "unverified" as const, response: "I did it." }; } };
  const runner = new PersistentMissionRunner({ store, config, events, agent: agent as never });
  try {
    const result = await runner.run(mission.id);
    assert.equal(result.status, "failed"); assert.equal(calls, 1);
    const task = store.db.prepare("SELECT state,error,attempts FROM mission_tasks WHERE mission_id=? AND task_key='deliver'").get(mission.id) as { state: string; error: string; attempts: number };
    assert.equal(task.state, "failed"); assert.equal(task.attempts, 1); assert.match(task.error, /COMPLETION_UNVERIFIED/);
  } finally { store.close(); }
}));

test("automatic mission retry avoids the failed model and persists attempted assignments", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "mission-model-reassignment.sqlite")); const config = new ConfigStore(store); const events = new RuntimeEvents();
  try {
    config.set("global", "orchestration.memoryBudgetBytes", 2 * 1024 ** 3);
    const attempted: string[] = [];
    const models = ["model-a", "model-b"].map((key) => ({ type: "llm" as const, publisher: "Test", key, display_name: key, size_bytes: 500_000_000, loaded_instances: [{ id: key, config: {} }], max_context_length: 8192, capabilities: { trained_for_tool_use: true } }));
    const runner = new PersistentMissionRunner({ store, config, events, modelProvider: { models: async () => models } as never, agent: { run: async (_objective: string, options: { model?: string }) => {
      attempted.push(options.model!);
      if (attempted.length === 1) throw new Error("model failed");
      const assignment = JSON.parse((store.db.prepare("SELECT definition_json FROM agents WHERE id LIKE '%:worker' AND mission_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1").get() as { definition_json: string }).definition_json) as { modelSelectionReason: string };
      return { sessionId: "reassigned-session", model: options.model!, selectionReason: assignment.modelSelectionReason, turns: 1, status: "completed" as const, response: "recovered" };
    } } as never });
    const mission = runner.repository.create({ name: "Reassign failed model", objective: "Recover", maxRetries: 1, tasks: [{ id: "worker", objective: "Try another model", dependsOn: [] }] });
    const result = await runner.run(mission.id);
    const taskState = store.db.prepare("SELECT state,error FROM mission_tasks WHERE mission_id=? AND task_key='worker'").get(mission.id) as { state: string; error: string | null };
    assert.equal(result.status, "completed", `worker ended ${taskState.state}: ${taskState.error ?? "no error recorded"}`);
    assert.deepEqual(attempted, ["model-a", "model-b"]);
    const agent = store.db.prepare("SELECT definition_json FROM agents WHERE id=?").get(`${result.runId}:worker`) as { definition_json: string };
    const definition = JSON.parse(agent.definition_json) as { model: string; attemptedModels: string[]; modelSelectionReason: string };
    assert.equal(definition.model, "model-b");
    assert.deepEqual(definition.attemptedModels, ["model-a", "model-b"]);
    assert.match(definition.modelSelectionReason, /avoiding previously failed automatic assignment/);
  } finally { store.close(); }
}));

test("automatic mission retries can be disabled without disabling explicit retries", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "mission-automatic-retries.sqlite")); const config = new ConfigStore(store); const events = new RuntimeEvents();
  try {
    config.set("global", "orchestration.retries.enabled", false);
    let attempts = 0;
    const runner = new PersistentMissionRunner({ store, config, events, agent: { run: async () => {
      attempts++;
      if (attempts === 1) throw new Error("temporary local failure");
      return { sessionId: "manual-retry-session", model: "fake", selectionReason: "test", turns: 1, status: "completed" as const, response: "recovered" };
    } } as never });
    const mission = runner.repository.create({ name: "Disable automatic retries", objective: "Fail once", maxRetries: 2, tasks: [{ id: "worker", objective: "Try once", dependsOn: [] }] });
    const failed = await runner.run(mission.id); assert.equal(failed.status, "failed"); assert.equal(attempts, 1);
    const retried = await runner.retryTask(mission.id, "worker"); assert.equal(retried.status, "completed"); assert.equal(attempts, 2);
  } finally { store.close(); }
}));

test("mission approval denial stops without consuming automatic retries", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "mission-approval-denial.sqlite")); const config = new ConfigStore(store); const events = new RuntimeEvents();
  try {
    let attempts = 0;
    const runner = new PersistentMissionRunner({ store, config, events, agent: { run: async () => {
      attempts++;
      throw new ExternalActionApprovalError("EXTERNAL_ACTION_DENIED", "The user denied github_issue_comment");
    } } as never });
    const mission = runner.repository.create({ name: "Approval required", objective: "Publish only after approval", maxRetries: 3, tasks: [{ id: "publish", objective: "Post the requested comment", dependsOn: [] }] });
    const result = await runner.run(mission.id, { approveExternalAction: async () => false });
    assert.equal(result.status, "failed"); assert.equal(attempts, 1);
    const task = store.db.prepare("SELECT state,error,attempts FROM mission_tasks WHERE run_id=? AND task_key='publish'").get(result.runId) as { state: string; error: string; attempts: number };
    assert.equal(task.state, "failed"); assert.match(task.error, /EXTERNAL_ACTION_DENIED/); assert.equal(task.attempts, 1);
  } finally { store.close(); }
}));

test("mission recovery quarantines uncertain external actions until each is explicitly reconciled", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "mission-action-recovery.sqlite")); const config = new ConfigStore(store); const events = new RuntimeEvents();
  try {
    const runner = new PersistentMissionRunner({ store, config, events, agent: { run: async (_objective: string, options: { onSession?: (id: string) => void }) => {
      options.onSession?.("resumed-after-reconcile"); return { sessionId: "resumed-after-reconcile", model: "fake", selectionReason: "test", turns: 1, status: "completed" as const, response: "continued" };
    } } as never });
    const mission = runner.repository.create({ name: "reconcile external call", objective: "Finish safely", tasks: [{ id: "task", objective: "Publish the requested result", dependsOn: [] }] });
    const runId = "expired-run"; const callId = "uncertain-github-call"; const retryCallId = "uncertain-dispatch-call"; const now = new Date().toISOString();
    const sessions = new SessionStore(store); const sessionId = sessions.create("uncertain action");
    store.db.prepare("INSERT INTO mission_runs(id,mission_id,state,trigger_type,started_at,heartbeat_at) VALUES(?,?,'running','manual',?,?)").run(runId, mission.id, now, now);
    store.db.prepare("INSERT INTO mission_tasks(run_id,mission_id,task_key,objective,dependencies_json,state,attempts,session_id,updated_at) VALUES(?,?,?,'Publish', '[]','running',1,?,?)").run(runId, mission.id, "task", sessionId, now);
    store.db.prepare("INSERT INTO tool_calls(id,session_id,name,input_json,status,created_at,effect,execution_scope,request_hash) VALUES(?,?,?,'{}','running',?,'external',?,'request-hash')").run(callId, sessionId, "github_create_pull_request", now, `${runId}:task`);
    store.db.prepare("INSERT INTO tool_calls(id,session_id,name,input_json,status,created_at,effect,execution_scope,request_hash) VALUES(?,?,?,'{}','running',?,'external',?,'retry-hash')").run(retryCallId, sessionId, "github_workflow_dispatch", now, `${runId}:task`);
    store.db.prepare("INSERT INTO runner_leases(mission_id,owner_id,expires_at,heartbeat_at) VALUES(?,?,?,?)").run(mission.id, "dead-owner", new Date(Date.now() - 60_000).toISOString(), now);
    assert.equal(await runner.recover(), 1);
    assert.equal((store.db.prepare("SELECT status FROM tool_calls WHERE id=?").get(callId) as { status: string }).status, "uncertain");
    assert.equal((store.db.prepare("SELECT state FROM mission_tasks WHERE run_id=? AND task_key='task'").get(runId) as { state: string }).state, "reconciliation_required");
    await assert.rejects(() => runner.resume(mission.id), /reconcile them before resuming/);
    await assert.rejects(() => runner.run(mission.id, { resume: true }), /reconcile them before running/);
    await assert.rejects(() => runner.retryTask(mission.id, "task"), /reconcile them before restarting a task/);
    assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM mission_runs WHERE mission_id=?").get(mission.id) as { count: number }).count, 1);
    assert.equal((store.db.prepare("SELECT state FROM mission_tasks WHERE run_id=? AND task_key='task'").get(runId) as { state: string }).state, "reconciliation_required");
    const details = await runner.reconcileExternalAction(mission.id, runId, "task", callId, "completed"); assert.equal(details.remainingUncertain, 1);
    assert.equal((store.db.prepare("SELECT status FROM tool_calls WHERE id=?").get(callId) as { status: string }).status, "reconciled");
    const retried = await runner.reconcileExternalAction(mission.id, runId, "task", retryCallId, "retry"); assert.equal(retried.remainingUncertain, 0);
    assert.equal((store.db.prepare("SELECT status FROM tool_calls WHERE id=?").get(retryCallId) as { status: string }).status, "retry_allowed");
    const resumed = await runner.resume(mission.id); assert.equal(resumed.status, "completed");
    assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM mission_runs WHERE mission_id=?").get(mission.id) as { count: number }).count, 1);
  } finally { store.close(); }
}));

test("mission daemon resumes checkpointed work after an expired runner lease", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "mission-daemon-restart.sqlite")); const config = new ConfigStore(store); const events = new RuntimeEvents();
  try {
    const completedObjectives: string[] = [];
    const runner = new PersistentMissionRunner({ store, config, events, agent: { run: async (objective: string, options: { onSession?: (id: string) => void }) => {
      completedObjectives.push(objective); options.onSession?.("recovered-session");
      return { sessionId: "recovered-session", model: "fake", selectionReason: "test", turns: 1, status: "completed" as const, response: "recovered" };
    } } as never });
    const mission = runner.repository.create({ name: "restart recovery", objective: "Finish all steps", tasks: [
      { id: "done", objective: "Already completed work", dependsOn: [] },
      { id: "continue", objective: "Resume from the saved checkpoint", dependsOn: ["done"] }
    ] });
    const runId = "interrupted-run"; const now = new Date().toISOString();
    store.db.prepare("INSERT INTO mission_runs(id,mission_id,state,trigger_type,started_at,heartbeat_at) VALUES(?,?,'running','manual',?,?)").run(runId, mission.id, now, now);
    store.db.prepare("INSERT INTO mission_tasks(run_id,mission_id,task_key,objective,dependencies_json,state,attempts,result_json,updated_at) VALUES(?,?,?,'Already completed work','[]','completed',1,?,?)").run(runId, mission.id, "done", JSON.stringify({ response: "saved" }), now);
    store.db.prepare("INSERT INTO mission_tasks(run_id,mission_id,task_key,objective,dependencies_json,state,attempts,updated_at) VALUES(?,?,?,'Resume from the saved checkpoint','[\"done\"]','running',1,?)").run(runId, mission.id, "continue", now);
    store.db.prepare("UPDATE missions SET status='running' WHERE id=?").run(mission.id);
    store.db.prepare("INSERT INTO runner_leases(mission_id,owner_id,expires_at,heartbeat_at) VALUES(?,?,?,?)").run(mission.id, "dead-owner", new Date(Date.now() - 60_000).toISOString(), now);
    let resolveFinished!: (status: string) => void;
    const finished = new Promise<string>((resolve) => { resolveFinished = resolve; });
    const unsubscribe = events.on<{ status: string }>("mission.recovery.finished", (event) => resolveFinished(event.payload.status));
    try {
      await runner.startScheduler();
      assert.equal(await Promise.race([finished, new Promise<string>((_, reject) => setTimeout(() => reject(new Error("daemon recovery did not finish")), 5_000))]), "completed");
    } finally { unsubscribe(); await runner.shutdownScheduler(); }
    assert.equal(completedObjectives.length, 1); assert.match(completedObjectives[0]!, /Resume from the saved checkpoint/);
    assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM mission_runs WHERE mission_id=?").get(mission.id) as { count: number }).count, 1);
  } finally { store.close(); }
}));

test("agent persists and rehydrates structured attachment messages in resumable sessions", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "attached-session.sqlite"));
  const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model");
  let sentMessages: unknown[] = [];
  const provider = {
    redact: (value: string) => value,
    models: async () => [{ type: "llm", publisher: "test", key: "test-model", display_name: "Test model", size_bytes: 3_000_000_000, loaded_instances: [], max_context_length: 8192, capabilities: { vision: true } }],
    streamChatWithTools: async (request: { messages: unknown[] }) => {
      sentMessages = request.messages;
      return { choices: [{ message: { role: "assistant", content: "I can inspect the attached image." } }] };
    }
  };
  const agent = new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never });
  try {
    const imagePart = { type: "image_url", image_url: { url: "data:image/png;base64,cGl4ZWw=" } };
    const result = await agent.run("Describe the attached picture", { initialMessage: { role: "user", content: [{ type: "text", text: "[Attached image: sample.png]" }, imagePart] } });
    const stored = sessions.messages(result.sessionId) as Array<{ role: string; content: string }>;
    assert.equal(stored[0]?.role, "user");
    assert.match(stored[0]!.content, /^__xyst_api_message__:/);
    assert.deepEqual(JSON.parse(stored[0]!.content.slice("__xyst_api_message__:".length)), { role: "user", content: [{ type: "text", text: "[Attached image: sample.png]" }, imagePart] });
    const sentUser = (sentMessages as Array<{ role: string; content: unknown }>).find((message) => message.role === "user");
    assert.deepEqual(sentUser?.content, [{ type: "text", text: "[Attached image: sample.png]" }, imagePart]);
  } finally { store.close(); }
}));

test("image tasks select a model that declares vision and reject an incompatible manual default", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "vision-selection.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  const models = [
    { type: "llm" as const, publisher: "local", key: "text-model", display_name: "Text model", size_bytes: 3_000_000_000, loaded_instances: [], max_context_length: 8192, capabilities: { vision: false, trained_for_tool_use: true } },
    { type: "llm" as const, publisher: "qwen", key: "vision-model", display_name: "Vision model", size_bytes: 3_000_000_000, loaded_instances: [], max_context_length: 8192, capabilities: { vision: true, trained_for_tool_use: true } }
  ];
  let usedModel = "";
  const provider = {
    redact: (value: string) => value,
    models: async () => models,
    streamChatWithTools: async (request: { model: string }) => { usedModel = request.model; return { choices: [{ message: { role: "assistant", content: "Image reviewed." } }] }; }
  };
  const agent = new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never });
  const initialMessage = { role: "user", content: [{ type: "text", text: "Describe this image" }, { type: "text", text: "[Attached image: sample.png]" }, { type: "image_url", image_url: { url: "data:image/png;base64,cGl4ZWw=" } }] };
  try {
    const automatic = await agent.run("Describe this image", { initialMessage });
    assert.equal(automatic.model, "vision-model"); assert.equal(usedModel, "vision-model"); assert.match(automatic.selectionReason, /declares vision support/);
    assert.equal(automatic.status, "completed", "a direct read-only image answer has no tool result to cite");
    const imageEditRequest = await agent.run("Change this image to a cat", { initialMessage });
    assert.equal(imageEditRequest.status, "unverified", "image input alone cannot verify an edit request");
    const combinedRequest = await agent.run("What is in this image? Also save a copy to output.png.", { initialMessage });
    assert.equal(combinedRequest.status, "unverified", "a visual question with a requested file action still needs tool evidence");
    const resumedSession = sessions.create("Resume image context");
    sessions.addMessage(resumedSession, "user", `__xyst_api_message__:${JSON.stringify({ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,cGl4ZWw=" } }] })}`);
    sessions.addMessage(resumedSession, "assistant", `__xyst_api_message__:${JSON.stringify({ role: "assistant", content: "The image shows a pixel." })}`);
    const resumed = await agent.run("Continue analyzing the saved image.", { sessionId: resumedSession });
    assert.equal(resumed.model, "vision-model", "resume must select vision support for images still in the active context");
    const retriedMissionTask = await agent.run("Continue the saved image inspection.", { sessionId: resumedSession, model: "text-model", automaticModelAssignment: true });
    assert.equal(retriedMissionTask.model, "vision-model", "an automatic mission retry must replace a provisional text-only assignment when saved context contains images");
    config.set("global", "model.default", "text-model");
    await assert.rejects(() => agent.run("Describe this image", { initialMessage }), /does not declare vision support/);
  } finally { store.close(); }
}));

test("mission execution scopes replay completed external actions instead of repeating them", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "external-action-idempotency.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model"); config.set("global", "integrations.github.enabled", true); config.set("global", "integrations.github.writeEnabled", true);
  let completions = 0; let nextCall = 0; let evidenceId = ""; let commentCount = 0;
  const provider = {
    redact: (value: string) => value,
    streamChatWithTools: async () => {
      completions++;
      if (completions % 3 === 1) { const callId = `call-${++nextCall}`; if (!evidenceId) evidenceId = callId; return { choices: [{ message: { role: "assistant", tool_calls: [{ id: callId, type: "function", function: { name: "github_issue_comment", arguments: '{"repo":"xyst","owner":"openai","number":7,"body":"done"}' } }] } }] }; }
      if (completions % 3 === 2) return { choices: [{ message: { role: "assistant", tool_calls: [{ id: `verify-${randomUUID()}`, type: "function", function: { name: "task_complete", arguments: JSON.stringify({ evidence_tool_call_indexes: [1] }) } }] } }] };
      return { choices: [{ message: { role: "assistant", content: "Finished" } }] };
    }
  };
  const github = { commentIssue: async () => { commentCount++; return { id: 123, html_url: "https://github.test/comment/123" }; } };
  const agent = new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: github as never });
  try {
    await agent.run("Post the comment", { executionScope: "mission-run:task" });
    await agent.run("Continue the task after recovery", { executionScope: "mission-run:task" });
    assert.equal(commentCount, 1);
    const calls = store.db.prepare("SELECT status,effect,execution_scope,request_hash FROM tool_calls WHERE name='github_issue_comment'").all() as Array<{ status: string; effect: string; execution_scope: string; request_hash: string }>;
    assert.deepEqual(calls.map(({ status, effect, execution_scope }) => [status, effect, execution_scope]), [["completed", "external", "mission-run:task"]]);
    assert.match(calls[0]!.request_hash, /^[a-f0-9]{64}$/);
  } finally { store.close(); }
}));

test("run_process reruns after Xyst workspace edits and replays the unchanged result after resume", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "process-workspace-revision.sqlite"));
  const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "process-revision-model");
  const sourcePath = join(root, "target.cjs");
  const initialSource = "module.exports = { run: () => false };";
  await writeFile(sourcePath, initialSource);
  const expectedHash = createHash("sha256").update(initialSource).digest("hex");
  const command = "require('node:fs').appendFileSync('process-runs.log', 'run\\n'); if (!require('./target.cjs').run()) process.exitCode = 1";
  const processArgs = { args: ["-e", command], cwd: root, executable: process.execPath };
  const legacyRequestHash = createHash("sha256").update("run_process:" + JSON.stringify(processArgs)).digest("hex");
  const oldRunAt = new Date().toISOString();
  store.db.prepare("INSERT INTO tool_calls(id,session_id,name,input_json,status,output_json,created_at,finished_at,effect,execution_scope,request_hash) VALUES(?,NULL,'run_process',?,'completed',?,?,?,'external',?,?)")
    .run("legacy-process-result", JSON.stringify(processArgs), JSON.stringify({ code: 1, signal: null, stdout: "old failed run", stderr: "", durationMs: 1 }), oldRunAt, oldRunAt, "process-revision-task", legacyRequestHash);
  let turn = 0;
  const provider = {
    redact: (value: string) => value,
    models: async () => [{ type: "llm", key: "process-revision-model", max_context_length: 8192, loaded_instances: [{ id: "loaded", config: { context_length: 8192 } }] }],
    isLocalServer: () => true,
    supportsLocalCliModelLifecycle: () => false,
    streamChatWithTools: async () => {
      turn++;
      const call = (id: string, name: string, args: unknown) => ({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
      if (turn === 1 || turn === 3 || turn === 5) return call("process-" + turn, "run_process", processArgs);
      if (turn === 2) return call("patch-source", "file_patch", { path: "target.cjs", expected_sha256: expectedHash, old_text: "run: () => false", new_text: "run: () => true" });
      return { choices: [{ message: { role: "assistant", content: "The command result is current." } }] };
    }
  };
  const agent = new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: { enterpriseHost: null, gitToken: async () => undefined } as never });
  try {
    await agent.run("Run the check, correct the source, and run the same check again.", { workspace: root, executionScope: "process-revision-task" });
    const firstRuns = store.db.prepare("SELECT output_json FROM tool_calls WHERE name='run_process' AND execution_scope=? ORDER BY rowid").all("process-revision-task") as Array<{ output_json: string }>;
    assert.deepEqual(firstRuns.map(({ output_json }) => JSON.parse(output_json).code), [1, 0]);
    assert.equal((await readFileAsync(join(root, "process-runs.log"), "utf8")), "run\n", "only the rerun after the workspace edit should execute");

    await agent.run("Resume and inspect the existing process evidence.", { workspace: root, executionScope: "process-revision-task" });
    const resumedCount = (store.db.prepare("SELECT COUNT(*) AS count FROM tool_calls WHERE name='run_process' AND execution_scope=?").get("process-revision-task") as { count: number }).count;
    assert.equal(resumedCount, 2, "an unchanged completed process is replayed during resume instead of executing its side effect twice");
    assert.equal((await readFileAsync(join(root, "process-runs.log"), "utf8")), "run\n");
  } finally { store.close(); }
}));

test("a workspace mutation retry runs after a different mutation and then replays unchanged", async () => withTemp(async (root) => {
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const target = join(workspace, "recreate.txt"); await writeFile(target, "old contents");
  const store = new XystStore(join(root, "workspace-mutation-retry.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "workspace-mutation-retry-model");
  let turn = 0;
  const provider = {
    redact: (value: string) => value,
    models: async () => [{ type: "llm", key: "workspace-mutation-retry-model", max_context_length: 8192, loaded_instances: [{ id: "loaded", config: { context_length: 8192 } }] }],
    isLocalServer: () => true,
    supportsLocalCliModelLifecycle: () => false,
    streamChatWithTools: async () => {
      turn++;
      const call = (id: string, name: string, args: unknown) => ({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
      const createArgs = { path: "recreate.txt", content: "new contents" };
      if (turn === 1 || turn === 3 || turn === 4) return call(`create-${turn}`, "file_create", createArgs);
      if (turn === 2) return call("delete-blocker", "file_delete", { path: "recreate.txt" });
      return { choices: [{ message: { role: "assistant", content: "The file was recreated." } }] };
    }
  };
  const agent = new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never });
  try {
    await agent.run("Replace the existing file, then repeat the create to confirm replay.", { workspace, executionScope: "workspace-mutation-retry" });
    assert.equal(await readFileAsync(target, "utf8"), "new contents");
    const calls = store.db.prepare("SELECT status,request_hash FROM tool_calls WHERE name='file_create' AND execution_scope=? ORDER BY rowid").all("workspace-mutation-retry") as Array<{ status: string; request_hash: string }>;
    assert.deepEqual(calls.map(({ status }) => status), ["failed", "completed"]);
    assert.notEqual(calls[0]!.request_hash, calls[1]!.request_hash, "a later workspace mutation should permit a fresh create attempt");
    assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM tool_calls WHERE name='file_delete' AND execution_scope=? AND status='completed'").get("workspace-mutation-retry") as { count: number }).count, 1);
  } finally { store.close(); }
}));

test("a restarted mission resumes after a completed GitHub action without posting it twice", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "mission-resume-action.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.default", "test-model"); config.set("global", "integrations.github.enabled", true); config.set("global", "integrations.github.writeEnabled", true);
  let completions = 0; let nextCall = 0; let evidenceId = ""; let commentCount = 0;
  const provider = {
    redact: (value: string) => value,
    streamChatWithTools: async () => {
      completions++;
      if (completions === 1) { const callId = `mission-call-${++nextCall}`; evidenceId = callId; return { choices: [{ message: { role: "assistant", tool_calls: [{ id: callId, type: "function", function: { name: "github_issue_comment", arguments: '{"owner":"openai","repo":"xyst","number":7,"body":"completed before restart"}' } }] } }] }; }
      if (completions === 2 || completions === 3) return { choices: [{ message: { role: "assistant", tool_calls: [{ id: `mission-verify-${randomUUID()}`, type: "function", function: { name: "task_complete", arguments: JSON.stringify({ evidence_tool_call_indexes: [1] }) } }] } }] };
      return { choices: [{ message: { role: "assistant", content: "Finished" } }] };
    }
  };
  const github = { commentIssue: async () => { commentCount++; return { id: 456, html_url: "https://github.test/comment/456" }; } };
  const agent = new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: github as never });
  const runner = new PersistentMissionRunner({ store, config, events, agent });
  try {
    const mission = runner.repository.create({ name: "restart after comment", objective: "Publish once", tasks: [{ id: "comment", objective: "Post the authorized comment", dependsOn: [] }] });
    const runId = "resumed-comment-run"; const created = new Date().toISOString(); let sessionId = "";
    store.db.prepare("INSERT INTO mission_runs(id,mission_id,state,trigger_type,started_at,heartbeat_at) VALUES(?,?,'running','manual',?,?)").run(runId, mission.id, created, created);
    store.db.prepare("INSERT INTO mission_tasks(run_id,mission_id,task_key,objective,dependencies_json,state,attempts,updated_at) VALUES(?,?,?,'Post comment','[]','running',1,?)").run(runId, mission.id, "comment", created);
    const first = await agent.run("Post the authorized comment", { missionId: mission.id, executionScope: `${runId}:comment`, onSession: (id) => { sessionId = id; store.db.prepare("UPDATE mission_tasks SET session_id=? WHERE run_id=? AND task_key='comment'").run(id, runId); } });
    assert.equal(first.status, "completed"); assert.equal(commentCount, 1);
    store.db.prepare("UPDATE mission_tasks SET state='running' WHERE run_id=? AND task_key='comment'").run(runId);
    store.db.prepare("UPDATE mission_runs SET state='running',finished_at=NULL WHERE id=?").run(runId);
    store.db.prepare("INSERT INTO runner_leases(mission_id,owner_id,expires_at,heartbeat_at) VALUES(?,?,?,?)").run(mission.id, "crashed-owner", new Date(Date.now() - 60_000).toISOString(), created);
    assert.equal(await runner.recover(), 1);
    const resumed = await runner.resume(mission.id); assert.equal(resumed.status, "completed");
    assert.equal(commentCount, 1);
    const task = store.db.prepare("SELECT state,attempts,session_id FROM mission_tasks WHERE run_id=? AND task_key='comment'").get(runId) as { state: string; attempts: number; session_id: string };
    assert.deepEqual([task.state, task.attempts, task.session_id], ["completed", 2, sessionId]);
    assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM tool_calls WHERE effect='external' AND execution_scope=? AND status='completed'").get(`${runId}:comment`) as { count: number }).count, 1);
  } finally { store.close(); }
}));

test("a process crash in a multi-step mission replays its real file side effect once", async () => withTemp(async (root) => {
  const databasePath = join(root, "process-crash.sqlite"); const workspace = join(root, "workspace"); const markerPath = join(workspace, "marker.txt");
  const metadataPath = join(root, "mission-id.txt"); const workerPath = join(root, "mission-worker.mjs"); await mkdir(workspace);
  const source = (relativePath: string) => new URL(relativePath, import.meta.url).href;
  const workerSource = `
import { readFile, writeFile } from "node:fs/promises";
import { XystStore, ConfigStore, SessionStore } from ${JSON.stringify(source("storage.ts"))};
import { RuntimeEvents } from ${JSON.stringify(source("events.ts"))};
import { AccessController } from ${JSON.stringify(source("access.ts"))};
import { AgentRunner } from ${JSON.stringify(source("agent.ts"))};
import { PersistentMissionRunner } from ${JSON.stringify(source("orchestration/missions.ts"))};
const [phase, databasePath, workspace, metadataPath] = process.argv.slice(2);
const store = new XystStore(databasePath); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
config.set("global", "model.default", "restart-test-model"); config.set("global", "autonomy.externalActionApproval", false);
let activeMissionId = ""; const taskGenerations = new Map();
const provider = {
  redact: value => value,
  models: async () => [{ type: "llm", key: "restart-test-model", max_context_length: 8192, loaded_instances: [{ id: "loaded", config: { context_length: 8192 } }] }],
  isLocalServer: () => true,
  supportsLocalCliModelLifecycle: () => false,
  streamChatWithTools: async () => {
    const task = store.db.prepare("SELECT run_id,task_key,session_id FROM mission_tasks WHERE mission_id=? AND state='running' ORDER BY updated_at DESC LIMIT 1").get(activeMissionId);
    const key = task.task_key; const generation = (taskGenerations.get(key) ?? 0) + 1; taskGenerations.set(key, generation);
    if (key === "write" && generation === 1) return { choices: [{ message: { role: "assistant", tool_calls: [{ id: "create-marker", type: "function", function: { name: "file_create", arguments: JSON.stringify({ path: "marker.txt", content: "restart-safe" }) } }] } }] };
    if (key === "verify" && generation === 1) return { choices: [{ message: { role: "assistant", tool_calls: [{ id: "read-marker", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "marker.txt" }) } }] } }] };
    if (generation === 2) {
      const toolName = key === "write" ? "file_create" : "file_read";
      const evidence = store.db.prepare("SELECT id FROM tool_calls WHERE session_id=? AND name=? AND status='completed' ORDER BY created_at DESC LIMIT 1").get(task.session_id, toolName);
      return { choices: [{ message: { role: "assistant", tool_calls: [{ id: "verify-" + key, type: "function", function: { name: "task_complete", arguments: JSON.stringify({ evidence_tool_call_indexes: [1] }) } }] } }] };
    }
    return { choices: [{ message: { role: "assistant", content: "Finished" } }] };
  }
};
const agent = new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider, github: {} });
const runner = new PersistentMissionRunner({ store, config, events, agent });
if (phase === "start") {
  const mission = runner.repository.create({ name: "process crash recovery", objective: "Write once, verify, and resume", workspace, maxConcurrency: 1, tasks: [{ id: "write", objective: "Create the marker", expectedOutputs: ["The marker file contains restart-safe."], dependsOn: [], workspace }, { id: "verify", objective: "Read the marker created by the prior task", expectedOutputs: ["The marker reads restart-safe."], dependsOn: ["write"], workspace }] });
  activeMissionId = mission.id;
  await writeFile(metadataPath, mission.id, "utf8");
  events.on("tool.completed", event => { if (event.payload.name === "file_create") process.kill(process.pid, "SIGKILL"); });
  await runner.run(mission.id);
  process.exit(91);
}
const missionId = (await readFile(metadataPath, "utf8")).trim();
activeMissionId = missionId;
store.db.prepare("UPDATE runner_leases SET expires_at=? WHERE mission_id=?").run(new Date(Date.now() - 60_000).toISOString(), missionId);
const recovered = await runner.recover();
const resumed = await runner.resume(missionId);
const writes = store.db.prepare("SELECT COUNT(*) AS count FROM tool_calls WHERE name='file_create' AND status IN ('completed','reconciled')").get().count;
const task = store.db.prepare("SELECT state,error,session_id FROM mission_tasks WHERE mission_id=?").get(missionId);
const calls = store.db.prepare("SELECT name,status,input_json,output_json FROM tool_calls WHERE session_id=?").all(task.session_id);
const tasks = store.db.prepare("SELECT task_key,state FROM mission_tasks WHERE mission_id=? ORDER BY task_key").all(missionId);
console.log(JSON.stringify({ recovered, resumed, writes, marker: await readFile(${JSON.stringify(markerPath)}, "utf8"), tasks, task, calls }));
store.close();
`;
  await writeFile(workerPath, workerSource, "utf8");
  const runWorker = (phase: string) => new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", workerPath, phase, databasePath, workspace, metadataPath], { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; child.stdout.setEncoding("utf8").on("data", (chunk) => stdout += chunk); child.stderr.setEncoding("utf8").on("data", (chunk) => stderr += chunk);
    child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  const crashed = await runWorker("start");
  assert.ok(crashed.signal === "SIGKILL" || (crashed.code !== null && crashed.code !== 0), `worker should terminate at the crash point: ${crashed.stderr}`);
  assert.equal(await readFileAsync(markerPath, "utf8"), "restart-safe");
  const store = new XystStore(databasePath);
  try {
    const call = store.db.prepare("SELECT status FROM tool_calls WHERE name='file_create'").get() as { status: string };
    assert.equal(call.status, "completed", "the side effect result must be committed before the crash point");
  } finally { store.close(); }
  const resumed = await runWorker("resume");
  assert.equal(resumed.code, 0, resumed.stderr);
  const result = JSON.parse(resumed.stdout.trim()) as { recovered: number; resumed: { status: string }; writes: number; marker: string; tasks: Array<{ task_key: string; state: string }>; task: unknown; calls: unknown };
  assert.equal(result.recovered, 1); assert.equal(result.resumed.status, "completed", JSON.stringify(result)); assert.equal(result.writes, 1); assert.equal(result.marker, "restart-safe");
  assert.deepEqual(result.tasks, [{ task_key: "verify", state: "completed" }, { task_key: "write", state: "completed" }]);
}));

test("mission concurrency runs independent tasks in distinct workspaces and serializes shared workspaces", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "mission-concurrency.sqlite")); const config = new ConfigStore(store); const events = new RuntimeEvents();
  const firstWorkspace = join(root, "task-one"); const secondWorkspace = join(root, "task-two"); await mkdir(firstWorkspace); await mkdir(secondWorkspace);
  let active = 0; let peak = 0; let sessionNumber = 0;
  const fakeAgent = { run: async (_objective: string, options: { onSession?: (id: string) => void }) => {
    const current = ++active; peak = Math.max(peak, current); const sessionId = `concurrent-${++sessionNumber}`; options.onSession?.(sessionId);
    await new Promise((resolve) => setTimeout(resolve, 35)); active--;
    return { sessionId, model: "fake", selectionReason: "test", turns: 1, status: "completed" as const, response: "ok" };
  } };
  const runner = new PersistentMissionRunner({ store, config, events, agent: fakeAgent as never });
  const isolated = runner.repository.create({ name: "isolated tasks", objective: "Run safely", maxConcurrency: 2, tasks: [
    { id: "one", objective: "Workspace one", workspace: firstWorkspace, dependsOn: [] },
    { id: "two", objective: "Workspace two", workspace: secondWorkspace, dependsOn: [] }
  ] });
  const result = await runner.run(isolated.id); assert.equal(result.status, "completed"); assert.equal(peak, 2);
  peak = 0; active = 0;
  const shared = runner.repository.create({ name: "shared workspace", objective: "Run safely", workspace: root, maxConcurrency: 2, tasks: [
    { id: "one", objective: "First write", dependsOn: [] }, { id: "two", objective: "Second write", dependsOn: [] }
  ] });
  const serialResult = await runner.run(shared.id); assert.equal(serialResult.status, "completed"); assert.equal(peak, 1);
  store.close();
}));

test("mission resource admission backfills a slot as soon as a ready task completes", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "mission-backfill.sqlite")); const config = new ConfigStore(store); const events = new RuntimeEvents();
  const workspaces = await Promise.all(["fast", "slow", "backfill"].map(async (name) => { const path = join(root, name); await mkdir(path); return path; }));
  config.set("global", "orchestration.memoryBudgetBytes", 2 * 1024 ** 3);
  let releaseSlow!: () => void; const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
  let markBackfillStarted!: () => void; const backfillStarted = new Promise<void>((resolve) => { markBackfillStarted = resolve; });
  let slowFinished = false; let backfillStartedBeforeSlowFinished = false; let active = 0; let peak = 0;
  const agent = { run: async (objective: string) => {
    active++; peak = Math.max(peak, active);
    try {
      if (objective.includes("Task: slow")) await slowGate;
      if (objective.includes("Task: backfill")) { backfillStartedBeforeSlowFinished = !slowFinished; markBackfillStarted(); }
      if (objective.includes("Task: fast")) await new Promise((resolve) => setTimeout(resolve, 25));
      if (objective.includes("Task: slow")) slowFinished = true;
      return { sessionId: "backfill-session", model: "loaded-small", selectionReason: "test", turns: 1, status: "completed" as const, response: "done" };
    } finally { active--; }
  } };
  const modelProvider = { models: async () => [{ type: "llm" as const, publisher: "Test", key: "loaded-small", display_name: "Loaded small", size_bytes: 2_000_000_000, loaded_instances: [{ id: "loaded", config: {} }], max_context_length: 8192, capabilities: { trained_for_tool_use: true } }] };
  const runner = new PersistentMissionRunner({ store, config, events, agent: agent as never, modelProvider: modelProvider as never });
  try {
    const mission = runner.repository.create({ name: "Backfill ready capacity", objective: "Complete the queued work", maxConcurrency: 2, tasks: [
      { id: "fast", objective: "Finish first", workspace: workspaces[0], dependsOn: [] },
      { id: "slow", objective: "Hold one slot", workspace: workspaces[1], dependsOn: [] },
      { id: "backfill", objective: "Use the released slot", workspace: workspaces[2], dependsOn: [] }
    ] });
    const running = runner.run(mission.id);
    const startedPromptly = await Promise.race([backfillStarted.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500))]);
    releaseSlow();
    const result = await running;
    assert.equal(result.status, "completed");
    assert.equal(startedPromptly, true, "a waiting ready task starts without waiting for the slow task in the same batch");
    assert.equal(backfillStartedBeforeSlowFinished, true);
    assert.equal(peak, 2, "backfill respects the mission concurrency ceiling");
  } finally { releaseSlow(); store.close(); }
}));

test("mission backfill admits newly unlocked dependencies using their completed result context", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "mission-dependency-backfill.sqlite")); const config = new ConfigStore(store); const events = new RuntimeEvents();
  const workspaces = await Promise.all(["source", "slow", "consumer"].map(async (name) => { const path = join(root, name); await mkdir(path); return path; }));
  config.set("global", "orchestration.memoryBudgetBytes", 2 * 1024 ** 3);
  let releaseSlow!: () => void; const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
  let markConsumerStarted!: (objective: string) => void; const consumerStarted = new Promise<string>((resolve) => { markConsumerStarted = resolve; });
  let slowFinished = false; let consumerStartedBeforeSlowFinished = false;
  const actualContextByTask = new Map<string, number>(); const estimatedContexts: number[] = [];
  const agent = { run: async (objective: string) => {
    const task = objective.match(/\n\nTask: ([^\n]+)/)?.[1] ?? "unknown";
    actualContextByTask.set(task, estimateRequiredContextTokens([{ content: objective }]));
    if (task === "slow") await slowGate;
    if (task === "consumer") { consumerStartedBeforeSlowFinished = !slowFinished; markConsumerStarted(objective); }
    if (task === "slow") slowFinished = true;
    return { sessionId: `dependency-${task}`, model: "loaded-small", selectionReason: "test", turns: 1, status: "completed" as const, response: task === "source" ? "dependency-output-".repeat(1500) : "done" };
  } };
  const model = { type: "llm" as const, publisher: "Test", key: "loaded-small", display_name: "Loaded small", size_bytes: 2_000_000_000, loaded_instances: [{ id: "loaded", config: {} }], max_context_length: 32768, capabilities: { trained_for_tool_use: true } };
  const modelProvider = { supportsLocalCliModelLifecycle: () => true, models: async () => [model], estimateLoad: async (_key: string, options: { context_length?: number }) => { estimatedContexts.push(options.context_length ?? 0); return { output: "Estimated GPU Memory: 2 GiB" }; } };
  const resourceStatsReader = async () => ({ source: "Xyst host" as const, checkedAt: new Date().toISOString(), systemMemory: { totalBytes: 16 * 1024 ** 3, usedBytes: 4 * 1024 ** 3, availableBytes: 12 * 1024 ** 3, usedPercent: 25 }, nvidiaGpuMemory: { status: "available" as const, source: "nvidia-smi" as const, devices: [{ name: "GPU", totalBytes: 16 * 1024 ** 3, usedBytes: 8 * 1024 ** 3, freeBytes: 8 * 1024 ** 3 }] } });
  const runner = new PersistentMissionRunner({ store, config, events, agent: agent as never, modelProvider: modelProvider as never, resourceStatsReader });
  try {
    const mission = runner.repository.create({ name: "Dependency backfill", objective: "Complete the dependency graph", maxConcurrency: 2, tasks: [
      { id: "source", objective: "Produce a result", workspace: workspaces[0], dependsOn: [] },
      { id: "slow", objective: "Hold one slot", workspace: workspaces[1], dependsOn: [] },
      { id: "consumer", objective: "Use the completed source output", workspace: workspaces[2], dependsOn: ["source"] }
    ] });
    const running = runner.run(mission.id);
    const consumerObjective = await Promise.race([consumerStarted, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 750))]);
    releaseSlow();
    const result = await running;
    assert.equal(result.status, "completed");
    assert.notEqual(consumerObjective, "timeout", "a dependency unlocked during execution backfills a free slot");
    assert.equal(consumerStartedBeforeSlowFinished, true);
    assert.match(String(consumerObjective), /dependency-output-/);
    const consumerContext = actualContextByTask.get("consumer");
    assert.ok(consumerContext && consumerContext > (actualContextByTask.get("source") ?? 0));
    assert.ok(estimatedContexts.includes(consumerContext + MODEL_CONTEXT_HEADROOM_TOKENS), "the refreshed LM Studio GPU estimate uses the dependency-expanded context plus load headroom");
  } finally { releaseSlow(); store.close(); }
}));

test("mission execution defers ready work when model memory estimates exceed the configured budget", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "resource-mission.sqlite")); const config = new ConfigStore(store); const events = new RuntimeEvents();
  const workspaceA = join(root, "resource-a"); const workspaceB = join(root, "resource-b"); await mkdir(workspaceA); await mkdir(workspaceB);
  config.set("global", "orchestration.memoryBudgetBytes", 500 * 1024 ** 2);
  let active = 0; let peak = 0; const assignments: Array<Record<string, unknown>> = [];
  const agent = { run: async (_objective: string, options: Record<string, any>) => {
    assignments.push(options); active++; peak = Math.max(peak, active); options.onSession?.(`resource-${assignments.length}`);
    await new Promise((resolve) => setTimeout(resolve, 20)); active--;
    return { sessionId: `resource-${assignments.length}`, model: String(options.model), selectionReason: "automatic resource-aware mission assignment", turns: 1, status: "completed" as const, response: "ok" };
  } };
  const modelProvider = { models: async () => [{ type: "llm" as const, publisher: "Test", key: "loaded-small", display_name: "Loaded small", size_bytes: 2_000_000_000, loaded_instances: [{ id: "loaded", config: {} }], max_context_length: 8192, capabilities: { trained_for_tool_use: true } }] };
  const runner = new PersistentMissionRunner({ store, config, events, agent: agent as never, modelProvider: modelProvider as never });
  try {
    const mission = runner.repository.create({ name: "bounded resources", objective: "Run both tasks", maxConcurrency: 2, workspace: root, tasks: [
      { id: "a", objective: "Task A", workspace: workspaceA, dependsOn: [] }, { id: "b", objective: "Task B", workspace: workspaceB, dependsOn: [] }
    ] });
    const result = await runner.run(mission.id);
    assert.equal(result.status, "completed"); assert.equal(peak, 1); assert.equal(assignments.length, 2);
    assert.ok(assignments.every((assignment) => assignment.model === "loaded-small" && assignment.automaticModelAssignment === true));
    const agents = store.db.prepare("SELECT definition_json FROM agents WHERE mission_id=? ORDER BY id").all(mission.id) as Array<{ definition_json: string }>;
    assert.ok(agents.every((entry) => JSON.parse(entry.definition_json).model === "loaded-small"));
  } finally { store.close(); }
}));

test("mission admission samples LM Studio GPU estimates before assigning automatic models", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "gpu-mission.sqlite")); const config = new ConfigStore(store); const events = new RuntimeEvents();
  config.set("global", "orchestration.memoryBudgetBytes", 2 * 1024 ** 3);
  const models = [
    { type: "llm" as const, publisher: "Test", key: "small-file-high-vram", display_name: "Small file high VRAM", size_bytes: 512 * 1024 ** 2, loaded_instances: [], max_context_length: 8192, capabilities: { trained_for_tool_use: true } },
    { type: "llm" as const, publisher: "Test", key: "larger-file-low-vram", display_name: "Larger file low VRAM", size_bytes: 1024 ** 3, loaded_instances: [], max_context_length: 8192, capabilities: { trained_for_tool_use: true } }
  ];
  const assigned: Array<Record<string, unknown>> = [];
  const runner = new PersistentMissionRunner({ store, config, events, modelProvider: { supportsLocalCliModelLifecycle: () => true, models: async () => models, estimateLoad: async (model: string) => ({ output: `Estimated GPU Memory: ${model === "small-file-high-vram" ? 8 : 2.5} GiB\nEstimated Total Memory: 1.5 GiB` }) } as never, resourceStatsReader: async () => ({ source: "Xyst host", checkedAt: new Date().toISOString(), systemMemory: { totalBytes: 16 * 1024 ** 3, usedBytes: 4 * 1024 ** 3, availableBytes: 12 * 1024 ** 3, usedPercent: 25 }, nvidiaGpuMemory: { status: "available", source: "nvidia-smi", devices: [{ name: "GPU", totalBytes: 16 * 1024 ** 3, usedBytes: 13 * 1024 ** 3, freeBytes: 3 * 1024 ** 3 }] } }), agent: { run: async (_objective: string, options: Record<string, unknown>) => { assigned.push(options); const currentAgent = JSON.parse((store.db.prepare("SELECT definition_json FROM agents WHERE mission_id=? AND status='running'").get(options.missionId) as { definition_json: string }).definition_json) as { modelSelectionReason: string }; return { sessionId: "gpu-mission-session", model: options.model, selectionReason: currentAgent.modelSelectionReason, turns: 1, status: "completed" as const, response: "done" }; } } as never });
  try {
    const mission = runner.repository.create({ name: "GPU-aware assignment", objective: "Complete one task", tasks: [{ id: "worker", objective: "Use the available GPU", dependsOn: [] }] });
    const result = await runner.run(mission.id);
    assert.equal(result.status, "completed", String((store.db.prepare("SELECT error FROM mission_runs WHERE id=?").get(result.runId) as { error: string | null } | undefined)?.error ?? "Mission run did not complete"));
    assert.equal(assigned[0]?.model, "larger-file-low-vram");
    const agentState = JSON.parse((store.db.prepare("SELECT definition_json FROM agents WHERE id=?").get(`${result.runId}:worker`) as { definition_json: string }).definition_json) as { modelSelectionReason: string };
    assert.match(agentState.modelSelectionReason, /LM Studio estimates 2.5 GiB total GPU memory.*3 GiB currently free/);
  } finally { store.close(); }
}));

test("mission resource estimates include trigger data and completed dependency results", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "mission-context-estimate.sqlite")); const config = new ConfigStore(store); const events = new RuntimeEvents();
  config.set("global", "orchestration.memoryBudgetBytes", 2 * 1024 ** 3);
  const models = [{ type: "llm" as const, publisher: "Test", key: "context-aware", display_name: "Context aware", size_bytes: 512 * 1024 ** 2, loaded_instances: [], max_context_length: 32768, capabilities: { trained_for_tool_use: true } }];
  const estimatedContexts: number[] = []; const actualContexts: number[] = [];
  const runner = new PersistentMissionRunner({
    store, config, events,
    modelProvider: { supportsLocalCliModelLifecycle: () => true, models: async () => models, estimateLoad: async (_model: string, options: { context_length?: number }) => { estimatedContexts.push(options.context_length ?? 0); return { output: "Estimated GPU Memory: 2 GiB" }; } } as never,
    resourceStatsReader: async () => ({ source: "Xyst host", checkedAt: new Date().toISOString(), systemMemory: { totalBytes: 16 * 1024 ** 3, usedBytes: 4 * 1024 ** 3, availableBytes: 12 * 1024 ** 3, usedPercent: 25 }, nvidiaGpuMemory: { status: "available", source: "nvidia-smi", devices: [{ name: "GPU", totalBytes: 16 * 1024 ** 3, usedBytes: 8 * 1024 ** 3, freeBytes: 8 * 1024 ** 3 }] } }),
    agent: { run: async (objective: string) => { actualContexts.push(estimateRequiredContextTokens([{ content: objective }])); return { sessionId: `context-session-${actualContexts.length}`, model: "context-aware", selectionReason: "test", turns: 1, status: "completed" as const, response: actualContexts.length === 1 ? "D".repeat(20000) : "done" }; } } as never
  });
  try {
    const mission = runner.repository.create({ name: "Context-aware admission", objective: "Use the inputs", tasks: [
      { id: "source", objective: "Read the event", dependsOn: [] },
      { id: "consumer", objective: "Use the source result", dependsOn: ["source"] }
    ] });
    const result = await runner.run(mission.id, { trigger: "github", triggerPayload: { event: "E".repeat(20000) } });
    assert.equal(result.status, "completed", String((store.db.prepare("SELECT error FROM mission_runs WHERE id=?").get(result.runId) as { error: string | null } | undefined)?.error ?? "Mission run did not complete"));
    assert.equal(actualContexts.length, 2);
    assert.ok(actualContexts[1]! > actualContexts[0]!, "the dependency result increases the second task's actual prompt estimate");
    assert.deepEqual(estimatedContexts, actualContexts.map((context) => context + MODEL_CONTEXT_HEADROOM_TOKENS), "LM Studio estimates use the actual task prompt context plus the planned load headroom");
  } finally { store.close(); }
}));

test("missions create durable task worktrees, reuse them for dependent tasks, and guard cleanup", async () => withTemp(async (root) => {
  const repositoryPath = join(root, "repo"); await mkdir(repositoryPath);
  assert.equal((await runProcess("git", ["init", repositoryPath], { cwd: repositoryPath })).code, 0);
  assert.equal((await runProcess("git", ["-c", "user.name=Xyst Test", "-c", "user.email=xyst@example.test", "-C", repositoryPath, "commit", "--allow-empty", "-m", "base"])).code, 0);
  const store = new XystStore(join(root, "mission-worktree.sqlite")); const config = new ConfigStore(store); const events = new RuntimeEvents();
  try {
  const workspaces: string[] = [];
  const fakeAgent = { run: async (_objective: string, options: { workspace?: string; onSession?: (id: string) => void }) => {
    workspaces.push(options.workspace!); options.onSession?.(`worktree-session-${workspaces.length}`);
    if (workspaces.length === 1) await writeFile(join(options.workspace!, "task-output.txt"), "preserved worktree change");
    return { sessionId: `worktree-session-${workspaces.length}`, model: "fake", selectionReason: "test", turns: 1, status: "completed" as const, response: "done" };
  } };
  const runner = new PersistentMissionRunner({ store, config, events, agent: fakeAgent as never, worktreeRoot: join(root, "worktrees") });
  const mission = runner.repository.create({ name: "isolated change", objective: "Build and review", workspace: repositoryPath, tasks: [
    { id: "build", objective: "Make a change", dependsOn: [], workspaceMode: "worktree" },
    { id: "review", objective: "Review the change", dependsOn: ["build"], workspaceFrom: "build" }
  ] });
  const result = await runner.run(mission.id);
  assert.equal(result.status, "completed", JSON.stringify(store.db.prepare("SELECT state,error FROM mission_runs WHERE id=?").get(result.runId))); assert.equal(workspaces.length, 2); assert.equal(workspaces[0], workspaces[1]);
  assert.notEqual(workspaces[0], repositoryPath); assert.equal(await readFileAsync(join(workspaces[0]!, "task-output.txt"), "utf8"), "preserved worktree change");
  const recorded = runner.listWorkspaces(mission.id) as Array<{ task_key: string; mode: string; path: string; status: string }>;
  assert.deepEqual(recorded.map((entry) => [entry.task_key, entry.mode, entry.path, entry.status]).sort(), [["build", "worktree", workspaces[0], "active"], ["review", "shared_from", workspaces[0], "active"]]);
  await assert.rejects(() => runner.removeWorktree(mission.id, result.runId, "build"), /pass --force/);
  assert.deepEqual(await runner.removeWorktree(mission.id, result.runId, "build", true), { removed: true, path: workspaces[0] });
  assert.equal(existsSync(workspaces[0]!), false);
  assert.equal(runner.listWorkspaces(mission.id).every((entry) => entry.status === "removed"), true);
  const restrictedRunner = new PersistentMissionRunner({ store, config, events, agent: fakeAgent as never, access: new AccessController({ mode: "restricted", readRoots: [repositoryPath], writeRoots: [repositoryPath], allowedExecutables: ["git"], externalActions: false }), worktreeRoot: join(root, "worktrees") });
  const restrictedMission = restrictedRunner.repository.create({ name: "restricted worktree", objective: "No side effects", workspace: repositoryPath, tasks: [{ id: "task", objective: "Should be blocked", dependsOn: [], workspaceMode: "worktree" }] });
  const restrictedResult = await restrictedRunner.run(restrictedMission.id);
  assert.equal(restrictedResult.status, "failed");
  assert.match(String((store.db.prepare("SELECT error FROM mission_runs WHERE id=?").get(restrictedResult.runId) as { error: string }).error), /denies externalActions/);
  let agentStarted!: () => void; const started = new Promise<void>((resolveStarted) => { agentStarted = resolveStarted; }); const interruptedPaths: string[] = [];
  const interruptedAgent = { run: async (_objective: string, options: { workspace?: string; signal?: AbortSignal; onSession?: (id: string) => void }) => {
    const workspace = options.workspace!; interruptedPaths.push(workspace); options.onSession?.("paused-session"); await writeFile(join(workspace, "checkpoint.txt"), "survive runner restart"); agentStarted();
    await new Promise<void>((resolveAbort) => options.signal?.addEventListener("abort", () => resolveAbort(), { once: true }));
    return { sessionId: "paused-session", model: "fake", selectionReason: "test", turns: 1, status: "cancelled" as const, response: "paused" };
  } };
  const pausingRunner = new PersistentMissionRunner({ store, config, events, agent: interruptedAgent as never, worktreeRoot: join(root, "worktrees") });
  const resumable = pausingRunner.repository.create({ name: "resume worktree", objective: "Keep the checkout", workspace: repositoryPath, tasks: [{ id: "task", objective: "Wait then resume", dependsOn: [], workspaceMode: "worktree" }] });
  const firstRun = pausingRunner.run(resumable.id); await started; pausingRunner.pause(resumable.id); assert.equal((await firstRun).status, "paused");
  const resumedAgent = { run: async (_objective: string, options: { workspace?: string; onSession?: (id: string) => void }) => {
    interruptedPaths.push(options.workspace!); options.onSession?.("resumed-session");
    assert.equal(await readFileAsync(join(options.workspace!, "checkpoint.txt"), "utf8"), "survive runner restart");
    return { sessionId: "resumed-session", model: "fake", selectionReason: "test", turns: 1, status: "completed" as const, response: "resumed" };
  } };
  const restartedRunner = new PersistentMissionRunner({ store, config, events, agent: resumedAgent as never, worktreeRoot: join(root, "worktrees") });
  const resumedResult = await restartedRunner.resume(resumable.id); assert.equal(resumedResult.status, "completed", JSON.stringify(store.db.prepare("SELECT state,error FROM mission_runs WHERE id=?").get(resumedResult.runId))); assert.equal(interruptedPaths[0], interruptedPaths[1]);
  await restartedRunner.removeWorktree(resumable.id, resumedResult.runId, "task", true);
  } finally { store.close(); }
}));

test("model acquisition requires opt-in, enforces artifact limits, and tracks LM Studio jobs", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "models.sqlite")); const config = new ConfigStore(store);
  try {
  const hostResources = { source: "Xyst host" as const, checkedAt: new Date(0).toISOString(), systemMemory: { totalBytes: 16 * 1024 ** 3, usedBytes: 8 * 1024 ** 3, availableBytes: 8 * 1024 ** 3, usedPercent: 50 }, nvidiaGpuMemory: { status: "available" as const, source: "nvidia-smi" as const, devices: [{ name: "Test GPU", totalBytes: 2 * 1024 ** 3, usedBytes: 1024 ** 3, freeBytes: 1024 ** 3 }] } };
  let hfModelConfig: Record<string, unknown> = { max_position_embeddings: 32768 };
  let hfSearchResults = [{ id: "owner/model", downloads: 10 }];
  const hf = {
    search: async () => hfSearchResults,
    model: async (id: string) => ({ id, gated: false, sha: "a".repeat(40), downloads: id === "owner/popular" ? 10000 : 10, tags: ["license:mit"], ...(id === "owner/evaluated" ? { cardData: { license: "mit", eval_results: [{ dataset: { name: "Code benchmark" }, metric: { name: "pass@1" }, value: 42, source: { name: "Publisher report", url: "https://example.test/eval" } }] } } : {}) }),
    modelConfig: async () => hfModelConfig,
    files: async () => [
      { rfilename: "model-Q5_K_M-00001-of-00002.gguf", size: 1500, lfs: { size: 1500, sha256: "1".repeat(64) } },
      { rfilename: "model-Q5_K_M-00002-of-00002.gguf", size: 1500, lfs: { size: 1500, sha256: "2".repeat(64) } },
      { rfilename: "mmproj-model-Q5_K_M.gguf", size: 512, lfs: { size: 512, sha256: "3".repeat(64) } },
      { rfilename: "model-Q5_K_M.gguf", size: 600 * 1024 ** 2, lfs: { size: 600 * 1024 ** 2, sha256: "4".repeat(64) } },
      { rfilename: "model-Q4_K_M.gguf", size: 1024, lfs: { size: 1024, sha256: "5".repeat(64) } },
      { rfilename: "mmproj-model-Q4_K_M.gguf", size: 512, lfs: { size: 512, sha256: "6".repeat(64) } }
    ]
  };
  const modelInventory = [{ key: "owner/model", type: "llm", max_context_length: 8192, loaded_instances: [] as Array<{ id: string; config: Record<string, unknown> }> }];
  const unloaded: string[] = []; let loadCount = 0;
  let downloadCalls = 0;
  const lm = {
    download: async () => { downloadCalls++; return { job_id: "lm-job-1", status: "downloading" }; }, downloadStatus: async () => ({ job_id: "lm-job-1", status: "completed" }),
    models: async () => modelInventory,
    load: async (key: string) => { loadCount++; modelInventory[0]!.loaded_instances.push({ id: "verification-instance", config: {} }); return { model: key }; },
    chat: async () => ({ output: [{ type: "message", content: [{ type: "text", text: "XYST_MODEL_READY" }] }] }),
    unload: async (id: string) => { unloaded.push(id); modelInventory[0]!.loaded_instances = modelInventory[0]!.loaded_instances.filter((instance) => instance.id !== id); return {}; }
  };
  const service = new ModelAcquisitionService({ store, config, huggingFace: hf as never, lmStudio: lm as never, hostResourceStats: async () => hostResources, modelDirectory: async () => root, diskAvailableBytes: async () => 4096 });
  await assert.rejects(() => service.search("model"), /discovery is off/);
  await assert.rejects(() => service.recommend("coding"), /discovery is off/);
  config.set("global", "models.onlineDiscovery", true); config.set("global", "models.automaticDownloads", true); config.set("global", "models.maxDownloadBytes", 512);
  await assert.rejects(() => service.download("owner/model", "Q4_K_M"), /over the configured/);
  config.set("global", "models.maxDownloadBytes", 2048);
  const recommendations = await service.recommend("coding"); assert.equal(recommendations[0]?.repository, "owner/model"); assert.equal(recommendations[0]?.artifact, "model-Q4_K_M.gguf");
  assert.equal(recommendations[0]?.license, "mit"); assert.equal(recommendations[0]?.licenseAllowed, false);
  config.set("global", "models.allowedLicenses", ["mit"]);
  const licenseAllowedRecommendations = await service.recommend("coding"); assert.equal(licenseAllowedRecommendations[0]?.licenseAllowed, true);
  config.set("global", "models.allowedLicenses", []);
  const visionRecommendations = await service.recommend("image understanding", undefined, {}, { minimumContextTokens: 4096, visionRequired: true });
  const visionRecommendation = visionRecommendations[0]; assert.ok(visionRecommendation, JSON.stringify(visionRecommendations));
  assert.equal(visionRecommendation.artifact, "model-Q4_K_M.gguf"); assert.deepEqual(visionRecommendation.companionFiles, ["mmproj-model-Q4_K_M.gguf"]);
  assert.equal((visionRecommendation.artifacts as Array<{ role: string }>).some((file) => file.role === "vision-projector"), true);
  assert.equal(recommendations[0]?.quantization, "Q4_K_M"); assert.equal(recommendations[0]?.estimatedMemoryBytes, 1280);
  assert.equal(recommendations[0]?.diskAvailableBytes, 4096); assert.equal(recommendations[0]?.diskRequiredBytes, 2100);
  assert.equal(recommendations[0]?.tempDiskAvailableBytes, 4096); assert.equal(recommendations[0]?.tempDiskRequiredBytes, 1076); assert.equal(recommendations[0]?.diskSufficient, true);
  assert.equal(recommendations[0]?.sharedStagingVolume, true);
  assert.deepEqual(recommendations[0]?.publishedEvaluationEvidence, []);
  assert.equal((recommendations[0]?.resourceEstimateAssumptions as Record<string, unknown>).weightMemoryMultiplier, 1.25);
  assert.match(String(recommendations[0]?.reason), /No structured evaluation/);
  hfSearchResults = [{ id: "owner/popular", downloads: 10000 }, { id: "owner/evaluated", downloads: 10 }];
  const evidenceRanked = await service.recommend("coding");
  assert.equal(evidenceRanked[0]?.repository, "owner/evaluated", "publisher evaluation metadata is preferred over popularity without comparing reported scores");
  assert.deepEqual(evidenceRanked[0]?.publishedEvaluationEvidence, [{ dataset: "Code benchmark", metric: "pass@1", value: 42, source: "Publisher report", sourceUrl: "https://example.test/eval" }]);
  const contextRecommendations = await service.recommend("coding", undefined, {}, { minimumContextTokens: 16000 });
  assert.equal(contextRecommendations[0]?.declaredContextTokens, 32768);
  assert.equal((await service.recommend("coding", undefined, {}, { minimumContextTokens: 65536 })).length, 0);
  hfModelConfig = { max_position_embeddings: 32768, num_hidden_layers: 32, hidden_size: 4096, num_attention_heads: 32, num_key_value_heads: 8 };
  config.set("global", "orchestration.maxConcurrency", 2);
  config.set("global", "models.maxDownloadBytes", 1024 ** 3);
  const resourceRecommendation = (await service.recommend("coding", undefined, {}, { minimumContextTokens: 4096 }))[0]!;
  assert.equal(resourceRecommendation.artifact, "model-Q4_K_M.gguf", "recommendations prefer a lower quantization when the higher quantization exceeds free single-GPU memory");
  assert.equal(resourceRecommendation.assumedContextTokens, 4096);
  assert.equal(resourceRecommendation.estimatedWeightMemoryBytes, 1280);
  assert.equal(resourceRecommendation.estimatedKvCacheBytes, 512 * 1024 ** 2, "KV cache uses declared transformer architecture and an explicit FP16 K/V estimate");
  assert.equal(resourceRecommendation.estimatedMemoryBytes, 512 * 1024 ** 2 + 1280);
  assert.equal(resourceRecommendation.estimatedConcurrentMemoryBytes, (512 * 1024 ** 2 + 1280) * 2);
  assert.equal(resourceRecommendation.concurrentMemoryFitsBudget, true);
  assert.equal(resourceRecommendation.maxSingleGpuFreeBytes, 1024 ** 3);
  assert.equal(resourceRecommendation.estimatedFullOffloadFitsCurrentGpuMemory, true);
  const largerGpuResources = { ...hostResources, nvidiaGpuMemory: { status: "available" as const, source: "nvidia-smi" as const, devices: [{ name: "Large Test GPU", totalBytes: 3 * 1024 ** 3, usedBytes: 1024 ** 3, freeBytes: 2 * 1024 ** 3 }] } };
  const diskAware = new ModelAcquisitionService({ store, config, huggingFace: hf as never, lmStudio: lm as never, hostResourceStats: async () => largerGpuResources, modelDirectory: async () => root, diskAvailableBytes: async () => 4096 });
  const diskAwareRecommendation = (await diskAware.recommend("coding", undefined, {}, { minimumContextTokens: 4096 }))[0]!;
  assert.equal(diskAwareRecommendation.artifact, "model-Q4_K_M.gguf", "a smaller compatible artifact that fits both volumes outranks a higher quantization that cannot be staged");
  assert.equal(diskAwareRecommendation.diskSufficient, true);
  config.set("global", "orchestration.memoryBudgetBytes", 512 * 1024 ** 2);
  assert.equal((await service.recommend("coding", undefined, {}, { minimumContextTokens: 4096 })).length, 0, "recommendations exceeding the saved memory budget are excluded");
  config.set("global", "orchestration.memoryBudgetBytes", null);
  assert.equal(recommendations.some((pick) => String(pick.artifact).includes("00001-of")), false, "incomplete shard sets are never recommended");
  const noSpace = new ModelAcquisitionService({ store, config, huggingFace: hf as never, lmStudio: lm as never, hostResourceStats: async () => hostResources, modelDirectory: async () => root, diskAvailableBytes: async () => 1000 });
  assert.equal((await noSpace.recommend("coding"))[0]?.diskSufficient, false);
  await assert.rejects(() => noSpace.download("owner/model", "Q4_K_M"), /Insufficient free space at the LM Studio model directory/); assert.equal(downloadCalls, 0);
  const stagingPeakShortfall = new ModelAcquisitionService({ store, config, huggingFace: hf as never, lmStudio: lm as never, hostResourceStats: async () => hostResources, modelDirectory: async () => root, diskAvailableBytes: async () => 1500 });
  assert.equal((await stagingPeakShortfall.recommend("coding"))[0]?.diskSufficient, false, "one shared volume cannot hold both a staged artifact and imported copy with only 1500 bytes free");
  config.set("global", "models.allowedLicenses", ["mit"]);
  await assert.rejects(() => stagingPeakShortfall.acquireRecommended(recommendations[0] as never), /Insufficient disk space for verified model staging/);
  config.set("global", "models.allowedLicenses", []);
  const noTempSpace = new ModelAcquisitionService({ store, config, huggingFace: hf as never, lmStudio: lm as never, hostResourceStats: async () => hostResources, modelDirectory: async () => root, diskAvailableBytes: async (path) => path === root ? 4096 : 1000 });
  const temporarySpaceRecommendation = (await noTempSpace.recommend("coding"))[0]!;
  assert.equal(temporarySpaceRecommendation.diskAvailableBytes, 4096); assert.equal(temporarySpaceRecommendation.tempDiskAvailableBytes, 1000); assert.equal(temporarySpaceRecommendation.diskSufficient, false, "temporary staging space participates in the recommendation preflight");
  await assert.rejects(() => noTempSpace.download("owner/model", "Q4_K_M"), /Insufficient free space in the system temporary directory/); assert.equal(downloadCalls, 0);
  const started = await service.download("owner/model", "Q4_K_M"); assert.equal((started as Record<string, unknown>).job_id, "lm-job-1");
  const preflight = (started as Record<string, any>).preflight; assert.equal(preflight.modelDirectory, root); assert.equal(preflight.diskAvailableBytes, 4096); assert.equal(preflight.diskRequiredBytes, 1076); assert.equal(preflight.tempDirectory, tmpdir()); assert.equal(preflight.tempDiskAvailableBytes, 4096); assert.equal(preflight.status, "sufficient"); assert.ok(Date.parse(preflight.checkedAt));
  const status = await service.status(String(started.id)) as Record<string, unknown>; assert.equal(status.state, "completed"); assert.equal(status.inventoryVerified, true);
  const verified = await service.verify(String(started.id)) as unknown as { capabilityCheck: { status: string; output: string; loadedByVerification: boolean } };
  assert.equal(verified.capabilityCheck.status, "passed"); assert.equal(verified.capabilityCheck.output, "XYST_MODEL_READY"); assert.equal(verified.capabilityCheck.loadedByVerification, true);
  assert.deepEqual(unloaded, ["verification-instance"]); assert.equal(modelInventory[0]!.loaded_instances.length, 0);
  const saved = service.listDownloads()[0] as { details_json: string }; assert.equal(JSON.parse(saved.details_json).preflight.status, "sufficient"); assert.equal(JSON.parse(saved.details_json).inventoryVerification.status, "verified");
  assert.equal(JSON.parse(saved.details_json).capabilityCheck.status, "passed");
  modelInventory.push({ key: "another/model", type: "llm", max_context_length: 4096, loaded_instances: [{ id: "active-work", config: {} }] });
  await assert.rejects(() => service.verify(String(started.id)), /while another model is active/); assert.equal(loadCount, 1);
  } finally { store.close(); }
}));

test("automatic model discovery broadens Hub searches and reads pinned base-model context", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "automatic-model-recommendation.sqlite")); const config = new ConfigStore(store);
  const artifactRevision = "a".repeat(40); const baseRevision = "b".repeat(40); const artifactHash = "c".repeat(64);
  const artifactRepository = "Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF"; const baseRepository = "Qwen/Qwen2.5-Coder-0.5B-Instruct";
  const searches: string[] = [];
  const hf = {
    search: async (query: string) => { searches.push(query); return query === "GGUF code" ? [{ id: artifactRepository, downloads: 100 }] : []; },
    model: async (repository: string) => repository === artifactRepository
      ? { id: repository, sha: artifactRevision, private: false, gated: false, tags: ["license:apache-2.0", `base_model:${baseRepository}`], cardData: { license: "apache-2.0", base_model: baseRepository } }
      : { id: repository, sha: baseRevision, private: false, gated: false },
    files: async () => [{ rfilename: "qwen2.5-coder-0.5b-instruct-q4_k_m.gguf", size: 100 * 1024 ** 2, lfs: { size: 100 * 1024 ** 2, sha256: artifactHash } }],
    card: async () => "This model supports tool-calling and agent capabilities.",
    modelConfig: async (repository: string) => repository === artifactRepository ? undefined : {
      max_position_embeddings: 32768, num_hidden_layers: 24, hidden_size: 896, num_attention_heads: 14, num_key_value_heads: 2
    }
  };
  const hostResources = { source: "Xyst host" as const, checkedAt: new Date(0).toISOString(), systemMemory: { totalBytes: 16 * 1024 ** 3, usedBytes: 4 * 1024 ** 3, availableBytes: 12 * 1024 ** 3, usedPercent: 25 }, nvidiaGpuMemory: { status: "unavailable" as const, source: "nvidia-smi" as const, devices: [] } };
  try {
    config.set("global", "models.onlineDiscovery", true); config.set("global", "models.automaticDownloads", true);
    config.set("global", "models.allowedLicenses", ["apache-2.0"]); config.set("global", "models.maxDownloadBytes", 512 * 1024 ** 2);
    const service = new ModelAcquisitionService({ store, config, huggingFace: hf as never, lmStudio: {} as never, hostResourceStats: async () => hostResources, modelDirectory: async () => root, diskAvailableBytes: async () => 2 * 1024 ** 3 });
    const recommendations = await service.recommend("GGUF coding assistant tool calling instruction following", undefined, {}, { minimumContextTokens: 6196, toolCallingRequired: true });
    assert.deepEqual(searches, ["GGUF coding assistant tool calling instruction following", "GGUF tool", "GGUF function", "GGUF agent", "GGUF code", "GGUF code 3.5B", "GGUF instruct"]);
    assert.equal(recommendations[0]?.repository, artifactRepository);
    assert.equal(recommendations[0]?.revision, artifactRevision);
    assert.equal(recommendations[0]?.sha256, artifactHash);
    assert.equal(recommendations[0]?.declaredContextTokens, 32768);
    assert.deepEqual(recommendations[0]?.contextMetadata, { source: "base-model-config", repository: baseRepository, revision: baseRevision });
    assert.equal(recommendations[0]?.toolUseEvidence, "explicit-model-card-claim");
  } finally { store.close(); }
}));

test("tool-calling acquisition scans bounded Hub fallbacks and ranks explicit model-card claims first", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "tool-model-recommendation.sqlite")); const config = new ConfigStore(store);
  const toolRepository = "owner/MiniCPM5-1B-Agentic-Tooluse-GGUF"; const plainRepository = "owner/Qwen2.5-Coder-0.5B-GGUF";
  const revisions = new Map([[toolRepository, "a".repeat(40)], [plainRepository, "b".repeat(40)]]);
  const searches: string[] = [];
  const hf = {
    search: async (query: string) => { searches.push(query); return query === "GGUF tool" ? [{ id: toolRepository, downloads: 10 }] : query === "GGUF code" ? [{ id: plainRepository, downloads: 50000 }] : []; },
    model: async (id: string) => ({ id, sha: revisions.get(id), private: false, gated: false, tags: ["license:apache-2.0"], cardData: { license: "apache-2.0" } }),
    files: async (id: string) => [{ rfilename: `${id.split("/")[1]}-Q4_K_M.gguf`, size: 100 * 1024 ** 2, lfs: { size: 100 * 1024 ** 2, sha256: (id === toolRepository ? "c" : "d").repeat(64) } }],
    modelConfig: async () => ({ max_position_embeddings: 32768 }),
    card: async (id: string) => id === toolRepository ? "Supports tool-calling and function-calling for agent capabilities." : "A small coding assistant model."
  };
  const hostResources = { source: "Xyst host" as const, checkedAt: new Date(0).toISOString(), systemMemory: { totalBytes: 8 * 1024 ** 3, usedBytes: 2 * 1024 ** 3, availableBytes: 6 * 1024 ** 3, usedPercent: 25 }, nvidiaGpuMemory: { status: "unavailable" as const, source: "nvidia-smi" as const, devices: [] } };
  try {
    config.set("global", "models.onlineDiscovery", true); config.set("global", "models.allowedLicenses", ["apache-2.0"]); config.set("global", "models.maxDownloadBytes", 512 * 1024 ** 2);
    const service = new ModelAcquisitionService({ store, config, huggingFace: hf as never, lmStudio: {} as never, hostResourceStats: async () => hostResources, modelDirectory: async () => root, diskAvailableBytes: async () => 2 * 1024 ** 3 });
    const recommendations = await service.recommend("GGUF coding assistant tool calling instruction following", undefined, {}, { minimumContextTokens: 6196, toolCallingRequired: true });
    assert.equal(searches.includes("GGUF tool"), true);
    assert.equal(recommendations[0]?.repository, toolRepository, "explicit tool-use evidence outranks a more popular generic code model");
    assert.equal(recommendations[0]?.toolUseEvidence, "explicit-model-card-claim");
    assert.equal(recommendations[1]?.toolUseEvidence, "none");
    assert.match(String(recommendations[0]?.reason), /unverified until a live tool-call probe passes/);
    const now = new Date().toISOString();
    store.db.prepare("INSERT INTO model_downloads(id,repository,revision,quantization,state,total_size_bytes,details_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(
      "previous-tool-failure", toolRepository, revisions.get(toolRepository), "Q4_K_M", "completed", 100 * 1024 ** 2,
      JSON.stringify({ toolCallingRequired: true, capabilityCheck: { status: "failed", error: "no real tool call" } }), now, now
    );
    const retryRecommendations = await service.recommend("GGUF coding assistant tool calling instruction following", undefined, {}, { minimumContextTokens: 6196, toolCallingRequired: true });
    assert.equal(retryRecommendations.some((item) => item.repository === toolRepository), false, "a pinned model revision that failed a live tool-call probe is not recommended again");
    assert.equal(retryRecommendations.some((item) => item.repository === plainRepository), true);
  } finally { store.close(); }
}));

test("automatic agent acquisition retries a bounded alternate after a model fails its live tool-call probe", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "tool-model-retry.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  const models: Array<Record<string, any>> = []; const attempted: string[] = [];
  const provider = { redact: (value: string) => value, models: async () => models, load: async (key: string, options: { context_length?: number }) => { models.find((item) => item.key === key)?.loaded_instances.push({ id: key, config: { context_length: options.context_length ?? 8192 } }); return { instance_id: key }; },
    streamChatWithTools: async () => ({ choices: [{ message: { role: "assistant", content: "Task is ready for review." } }] }) };
  const acquisition = {
    recommend: async () => ["first", "second"].map((name) => ({ repository: `owner/${name}`, artifact: `${name}-Q4_K_M.gguf`, quantization: "Q4_K_M", sizeBytes: 1024, estimatedMemoryBytes: 1280, diskSufficient: true, sha256: "a".repeat(64), license: "mit", toolCallingRequired: true, toolUseEvidence: "explicit-model-card-claim" })),
    acquireRecommended: async (recommendation: { repository: string }) => { const name = recommendation.repository.split("/")[1]!; attempted.push(name); models.push({ type: "llm", key: recommendation.repository, display_name: name, size_bytes: 1024, loaded_instances: [], max_context_length: 8192, capabilities: { trained_for_tool_use: false } }); return { id: name, repository: recommendation.repository, revision: "b".repeat(40), modelKey: recommendation.repository }; },
    verify: async (id: string) => { if (id === "first") throw new Error("Model was discovered, but its capability check failed: The model did not return the required probe_tool call with status=ready"); return { capabilityCheck: { status: "passed", toolCalling: { status: "passed" } } }; }
  };
  const agent = new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never, modelAcquisition: acquisition as never });
  try {
    config.set("global", "models.onlineDiscovery", true); config.set("global", "models.automaticDownloads", true); config.set("global", "models.allowedLicenses", ["mit"]);
    const result = await agent.run("Use a tool to complete the required file operation", { maxTurns: 1 });
    assert.deepEqual(attempted, ["first", "second"]);
    assert.equal(result.model, "owner/second");
    assert.match(result.selectionReason, /owner\/second/);
  } finally { store.close(); }
}));

test("LM Studio model discovery matches a Hugging Face GGUF repository and prefers the same publisher", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "gguf-inventory.sqlite")); const config = new ConfigStore(store);
  try {
    config.set("global", "models.onlineDiscovery", true); config.set("global", "models.automaticDownloads", true);
    const inventory = [
      { key: "bartowski/smollm2-360m-instruct", type: "llm", max_context_length: 4096, loaded_instances: [] as Array<{ id: string; config: Record<string, unknown> }> },
      { key: "lmstudio-community/smollm2-360m-instruct", type: "llm", max_context_length: 4096, loaded_instances: [] as Array<{ id: string; config: Record<string, unknown> }> }
    ];
    const hf = {
      model: async (id: string) => ({ id, private: false, gated: false }),
      files: async () => [{ rfilename: "SmolLM2-360M-Instruct-Q4_K_M.gguf", size: 1024 }]
    };
    const lm = {
      download: async () => ({ job_id: "smollm-download", status: "downloading" }),
      downloadStatus: async () => ({ status: "completed" }),
      models: async () => inventory,
      load: async (key: string) => { const model = inventory.find((entry) => entry.key === key)!; model.loaded_instances.push({ id: "smollm-verification", config: {} }); return { instance_id: "smollm-verification" }; },
      chat: async () => ({ output: [{ type: "message", content: [{ type: "text", text: "XYST_MODEL_READY" }] }] }),
      unload: async (id: string) => { for (const model of inventory) model.loaded_instances = model.loaded_instances.filter((instance) => instance.id !== id); return {}; }
    };
    const service = new ModelAcquisitionService({ store, config, huggingFace: hf as never, lmStudio: lm as never, modelDirectory: async () => root, diskAvailableBytes: async () => 4096 });
    const started = await service.download("bartowski/SmolLM2-360M-Instruct-GGUF", "Q4_K_M");
    const status = await service.status(String(started.id));
    assert.equal(status.inventoryVerified, true);
    assert.equal((status.details as Record<string, any>).inventoryVerification.modelKey, "bartowski/smollm2-360m-instruct");
    const verified = await service.verify(String(started.id)) as unknown as { capabilityCheck: { status: string; modelKey: string; loadedByVerification: boolean } };
    assert.equal(verified.capabilityCheck.status, "passed");
    assert.equal(verified.capabilityCheck.modelKey, "bartowski/smollm2-360m-instruct");
    assert.equal(verified.capabilityCheck.loadedByVerification, true);
    assert.equal(inventory.every((model) => model.loaded_instances.length === 0), true);
  } finally { store.close(); }
}));

test("recommended model acquisition pins and hashes the artifact before importing it", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "verified-model.sqlite")); const config = new ConfigStore(store);
  const artifact = Buffer.from("verified gguf fixture"); const sha256 = createHash("sha256").update(artifact).digest("hex");
  const modelInventory = [{ key: "owner/model", type: "llm", max_context_length: 8192, size_bytes: 20, capabilities: { trained_for_tool_use: true }, loaded_instances: [] as Array<{ id: string; config: Record<string, unknown> }> }];
  const commands: Array<{ command: string; args: string[] }> = []; let imported = false; let inventoryReads = 0; let emitsToolCall = false;
  const hf = { downloadArtifact: async (repository: string, revision: string, filename: string) => {
    assert.equal(repository, "owner/model"); assert.equal(revision, "a".repeat(40)); assert.equal(filename, "model-Q4_K_M.gguf"); return new Response(artifact);
  } };
  const lm = { models: async () => { inventoryReads++; return inventoryReads === 1 ? [] : modelInventory; }, load: async (key: string) => { modelInventory[0]!.loaded_instances.push({ id: "probe", config: {} }); return { model: key }; },
    chat: async () => ({ output: [{ type: "message", content: [{ type: "text", text: "XYST_MODEL_READY" }] }] }),
    chatWithTools: async () => emitsToolCall
      ? ({ choices: [{ message: { tool_calls: [{ id: "probe-call", type: "function", function: { name: "probe_tool", arguments: JSON.stringify({ status: "ready" }) } }] } }] })
      : ({ choices: [{ message: { content: "{\"name\":\"probe_tool\",\"arguments\":{\"status\":\"ready\"}}" } }] }),
    unload: async (id: string) => { modelInventory[0]!.loaded_instances = modelInventory[0]!.loaded_instances.filter((item) => item.id !== id); return {}; } };
  const service = new ModelAcquisitionService({ store, config, huggingFace: hf as never, lmStudio: lm as never, modelDirectory: async () => root, diskAvailableBytes: async () => 4096,
    commandRunner: async (command, args) => { commands.push({ command, args }); imported = true; return { code: 0, signal: null, stdout: "imported", stderr: "", durationMs: 1 }; } });
  try {
    config.set("global", "models.onlineDiscovery", true); config.set("global", "models.automaticDownloads", true);
    const recommendation = { repository: "owner/model", revision: "a".repeat(40), artifact: "model-Q4_K_M.gguf", quantization: "Q4_K_M", sizeBytes: artifact.length, sha256, license: "mit", toolCallingRequired: true, toolUseEvidence: "explicit-model-card-claim" };
    await assert.rejects(() => service.acquireRecommended(recommendation), /license mit is not in the saved models.allowedLicenses preference/);
    config.set("global", "models.allowedLicenses", ["mit"]);
    const result = await service.acquireRecommended(recommendation);
    assert.equal(result.state, "completed"); assert.equal(result.sha256, sha256); assert.equal(imported, true);
    assert.equal(inventoryReads, 2, "the importer can finish before LM Studio refreshes its model inventory");
    assert.equal(commands[0]!.command, "lms"); assert.equal(commands[0]!.args[0], "import");
    assert.equal(commands[0]!.args[2], "--user-repo"); assert.equal(commands[0]!.args[3], "owner/model"); assert.match(commands[0]!.args[1]!, /\.gguf$/);
    const verification = await service.verify(result.id) as unknown as { capabilityCheck: { status: string } }; assert.equal(verification.capabilityCheck.status, "passed");
    await assert.rejects(() => service.verify(result.id, undefined, { toolCallingRequired: true }), /did not return the required probe_tool call/);
    emitsToolCall = true;
    const toolVerification = await service.verify(result.id, undefined, { toolCallingRequired: true }) as unknown as { capabilityCheck: { status: string; toolCalling: { status: string; toolName: string; arguments: { status: string } } } };
    assert.deepEqual(toolVerification.capabilityCheck.toolCalling, { status: "passed", toolName: "probe_tool", arguments: { status: "ready" } });
    assert.deepEqual(await service.verifyForAgent("owner/model"), { modelKey: "owner/model", status: "passed", cached: true });
    const records = service.listDownloads() as Array<{ state: string; details_json: string }>;
    assert.equal(records[0]!.state, "completed"); assert.equal(JSON.parse(records[0]!.details_json).verifiedSha256, sha256);
    assert.equal(JSON.parse(records[0]!.details_json).inventoryVerification.waitMs, 250);
    const commandCount = commands.length;
    await assert.rejects(() => service.acquireRecommended({ ...recommendation, sha256: "0".repeat(64) }), /SHA-256 does not match/);
    const mismatch = store.db.prepare("SELECT state FROM model_downloads ORDER BY created_at DESC,id DESC LIMIT 1").get() as { state: string };
    assert.equal(mismatch.state, "failed"); assert.equal(commands.length, commandCount);

    const denied = new ModelAcquisitionService({ store, config, huggingFace: hf as never, lmStudio: lm as never, access: new AccessController({ mode: "restricted", network: true, externalActions: false }), modelDirectory: async () => root, diskAvailableBytes: async () => 4096 });
    await assert.rejects(() => denied.acquireRecommended(recommendation), /denies externalActions/);
  } finally { store.close(); }
}));

test("uncertain successful model imports reconcile only after a matching inventory size appears", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "uncertain-import.sqlite")); const config = new ConfigStore(store);
  const now = new Date().toISOString(); const sha256 = "a".repeat(64);
  const recoveredId = "recovered-import"; const mismatchId = "mismatched-import";
  const insert = store.db.prepare("INSERT INTO model_downloads(id,repository,revision,quantization,state,total_size_bytes,details_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)");
  for (const [id, repository, size] of [[recoveredId, "owner/recovered", 20], [mismatchId, "owner/mismatch", 21]] as const) {
    insert.run(id, repository, "b".repeat(40), "Q4_K_M", "uncertain", 20, JSON.stringify({ sha256, ...(id === recoveredId ? { toolCallingRequired: true } : {}), error: `Import completed but ${repository} is not yet visible in LM Studio inventory` }), now, now);
  }
  let probeLoaded = false;
  const lm = { models: async () => [
    { key: "owner/recovered", size_bytes: 20, type: "llm", loaded_instances: probeLoaded ? [{ id: "recovery-probe", config: {} }] : [] },
    { key: "owner/mismatch", size_bytes: 19, type: "llm", loaded_instances: [] }
  ], load: async () => { probeLoaded = true; return { instance_id: "recovery-probe" }; }, chatWithTools: async () => ({ choices: [{ message: { tool_calls: [{ type: "function", function: { name: "probe_tool", arguments: JSON.stringify({ status: "ready" }) } }] } }] }), unload: async () => { probeLoaded = false; return {}; } };
  const service = new ModelAcquisitionService({ store, config, huggingFace: {} as never, lmStudio: lm as never });
  try {
    const recovered = await service.status(recoveredId);
    assert.equal(recovered.state, "completed"); assert.equal(recovered.inventoryVerified, true);
    assert.equal((recovered.details as Record<string, any>).inventoryVerification.recoveredAfterImportVisibilityDelay, true);
    const agentVerification = await service.verifyForAgent("owner/recovered") as { status: string; cached: boolean };
    assert.deepEqual(agentVerification, { modelKey: "owner/recovered", status: "passed", cached: false }, "a recovered auto-acquisition must pass its deferred live tool-call probe before agent use");
    const afterVerification = store.db.prepare("SELECT details_json FROM model_downloads WHERE id=?").get(recoveredId) as { details_json: string };
    assert.equal(JSON.parse(afterVerification.details_json).capabilityCheck.toolCalling.status, "passed");
    const mismatch = await service.status(mismatchId);
    assert.equal(mismatch.state, "uncertain"); assert.equal(mismatch.inventoryVerified, false);
  } finally { store.close(); }
}));

test("recommended multi-file GGUF acquisition verifies every file and installs a bundle without single-file import", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "bundle-model.sqlite")); const config = new ConfigStore(store);
  const payloads = new Map([
    ["model-Q4_K_M-00001-of-00002.gguf", Buffer.from("shard one")],
    ["model-Q4_K_M-00002-of-00002.gguf", Buffer.from("shard two")],
    ["mmproj-model-Q4_K_M.gguf", Buffer.from("projector")]
  ]);
  const artifacts = [...payloads].map(([filename, bytes], index) => ({ filename, role: ["model", "model-shard", "vision-projector"][index], sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }));
  const totalBytes = artifacts.reduce((sum, file) => sum + file.sizeBytes, 0);
  const modelInventory = [{ key: "owner/model", type: "llm", max_context_length: 8192, capabilities: { vision: true }, loaded_instances: [] as Array<{ id: string; config: Record<string, unknown> }> }];
  const commands: string[] = []; let visionProbeInput: unknown;
  const hf = { downloadArtifact: async (_repository: string, _revision: string, filename: string) => new Response(payloads.get(filename)!) };
  const lm = { models: async () => modelInventory, load: async () => { modelInventory[0]!.loaded_instances.push({ id: "bundle-probe", config: {} }); return { instance_id: "bundle-probe" }; },
    chat: async (request: { input: unknown }) => { visionProbeInput = request.input; return { output: [{ type: "message", content: [{ type: "text", text: "pixel" }] }] }; },
    unload: async () => { modelInventory[0]!.loaded_instances = []; return {}; } };
  const service = new ModelAcquisitionService({ store, config, huggingFace: hf as never, lmStudio: lm as never,
    modelDirectory: async () => root, diskAvailableBytes: async () => 4096,
    commandRunner: async (command) => { commands.push(command); return { code: 0, signal: null, stdout: "", stderr: "", durationMs: 0 }; } });
  try {
    config.set("global", "models.onlineDiscovery", true); config.set("global", "models.automaticDownloads", true); config.set("global", "models.allowedLicenses", ["mit"]);
    const result = await service.acquireRecommended({ repository: "owner/model", revision: "a".repeat(40), artifact: artifacts[0]!.filename, artifacts, quantization: "Q4_K_M", sizeBytes: totalBytes, sha256: artifacts[0]!.sha256, license: "mit" });
    assert.equal(result.state, "completed"); assert.deepEqual(result.artifacts, artifacts.map((file) => file.filename));
    for (const file of artifacts) assert.equal((await readFileAsync(join(root, "owner", "model", file.filename))).length, file.sizeBytes);
    assert.deepEqual(commands, [], "LM Studio's single-file importer is not used for a split/projector bundle");
    const verification = await service.verify(result.id, undefined, { visionRequired: true }) as unknown as { capabilityCheck: { status: string } };
    assert.equal(verification.capabilityCheck.status, "passed");
    assert.match(JSON.stringify(visionProbeInput), /image_url/);
  } finally { store.close(); }
}));

test("recommended acquisition retries byte ranges and resumes a saved partial after failure", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "resumable-model.sqlite")); const config = new ConfigStore(store);
  const bytes = Buffer.from("abcdefghi"); const sha256 = createHash("sha256").update(bytes).digest("hex");
  const inventory = [{ key: "owner/resumable", type: "llm", max_context_length: 4096, loaded_instances: [] }];
  const offsets: number[] = []; let requestCount = 0; let importCount = 0;
  const hf = { downloadArtifact: async (_repository: string, _revision: string, filename: string, _signal?: AbortSignal, rangeStart?: number) => {
    assert.equal(filename, "model-Q4_K_M.gguf"); const start = rangeStart ?? 0; offsets.push(start); requestCount++;
    if (requestCount <= 3) {
      return new Response(bytes.subarray(start, start + 2), {
        status: rangeStart === undefined ? 200 : 206,
        ...(rangeStart === undefined ? {} : { headers: { "Content-Range": `bytes ${start}-${bytes.length - 1}/${bytes.length}` } })
      });
    }
    return new Response(bytes.subarray(start), { status: rangeStart === undefined ? 200 : 206, ...(rangeStart === undefined ? {} : { headers: { "Content-Range": `bytes ${start}-${bytes.length - 1}/${bytes.length}` } }) });
  } };
  const service = new ModelAcquisitionService({ store, config, huggingFace: hf as never, lmStudio: { models: async () => inventory } as never,
    modelDirectory: async () => root, diskAvailableBytes: async () => 4096,
    commandRunner: async () => { importCount++; return { code: 0, signal: null, stdout: "imported", stderr: "", durationMs: 1 }; } });
  const recommendation = { repository: "owner/resumable", revision: "c".repeat(40), artifact: "model-Q4_K_M.gguf", quantization: "Q4_K_M", sizeBytes: bytes.length, sha256, license: "mit" };
  try {
    config.set("global", "models.onlineDiscovery", true); config.set("global", "models.automaticDownloads", true); config.set("global", "models.allowedLicenses", ["mit"]);
    await assert.rejects(() => service.acquireRecommended(recommendation), /size mismatch/);
    const failed = store.db.prepare("SELECT id,state,details_json FROM model_downloads").get() as { id: string; state: string; details_json: string };
    assert.equal(failed.state, "failed"); assert.ok(JSON.parse(failed.details_json).stagingFiles[0].stagingFile);
    const resumed = await service.acquireRecommended(recommendation);
    assert.equal(resumed.id, failed.id); assert.equal(resumed.state, "completed");
    assert.deepEqual(offsets, [0, 2, 4, 6]); assert.equal(importCount, 1);
    assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM model_downloads").get() as { count: number }).count, 1);
  } finally { store.close(); }
}));

test("agent model acquisition follows discovery and download controls without sending task text", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "automatic-model.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  const models: Array<Record<string, unknown>> = []; const discoveryQueries: string[] = []; let acquired = 0; let generatedModel = ""; let lastDiscoveryQuery = ""; let visionVerified = false;
  const provider = { redact: (value: string) => value, models: async () => models, load: async (key: string, options: { context_length?: number }) => { const model = models.find((item) => item.key === key); model?.loaded_instances && (model.loaded_instances as Array<{ id: string; config: Record<string, unknown> }>).push({ id: key, config: { context_length: options.context_length ?? 8192 } }); return { instance_id: key }; },
    streamChatWithTools: async (request: { model: string }) => { generatedModel = request.model; return { choices: [{ message: { role: "assistant", content: "Completed locally." } }] }; } };
  const acquisition = {
    recommend: async (query: string) => { discoveryQueries.push(query); lastDiscoveryQuery = query; return [{ repository: "owner/model", artifact: "model-Q4_K_M.gguf", quantization: "Q4_K_M", sizeBytes: 1024, estimatedMemoryBytes: 1280, diskSufficient: true, sha256: "a".repeat(64), license: "mit" }]; },
    acquireRecommended: async () => { acquired++; models.length = 0; models.push({ type: "llm", publisher: "test", key: "owner/model", display_name: "Model", size_bytes: 1024, loaded_instances: [], max_context_length: 8192, capabilities: { vision: lastDiscoveryQuery.includes("vision"), trained_for_tool_use: true } }); return { id: "download-1", repository: "owner/model", revision: "b".repeat(40), modelKey: "owner/model" }; },
    verify: async (_id: string, _signal: AbortSignal | undefined, requirements: { visionRequired?: boolean; toolCallingRequired?: boolean }) => { visionVerified = requirements.visionRequired === true; assert.equal(requirements.toolCallingRequired, true); return { capabilityCheck: { status: "passed", toolCalling: { status: "passed" } } }; }
  };
  const agent = new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never, modelAcquisition: acquisition as never });
  try {
    config.set("global", "models.onlineDiscovery", true);
    await assert.rejects(() => agent.run("PRIVATE objective: use local repository details"), /Recommended owner\/model model-Q4_K_M.gguf/);
    assert.equal(acquired, 0); assert.deepEqual(discoveryQueries, ["GGUF coding assistant tool calling instruction following"]);
    config.set("global", "models.automaticDownloads", true);
    await assert.rejects(() => agent.run("PRIVATE objective: use local repository details"), /none matches the saved license preference/);
    assert.equal(acquired, 0);
    config.set("global", "models.allowedLicenses", ["mit"]);
    const result = await agent.run("PRIVATE objective: use local repository details");
    assert.equal(result.model, "owner/model"); assert.equal(generatedModel, "owner/model"); assert.match(result.selectionReason, /integrity checked, and capability verified/); assert.equal(acquired, 1);
    assert.equal(JSON.stringify(discoveryQueries).includes("PRIVATE objective"), false);
    models.length = 0;
    const visionResult = await agent.run("PRIVATE image objective", { initialMessage: { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,cGl4ZWw=" } }] } });
    assert.equal(visionResult.model, "owner/model"); assert.equal(visionVerified, true);
    assert.match(lastDiscoveryQuery, /vision/); assert.equal(JSON.stringify(discoveryQueries).includes("PRIVATE image objective"), false);
  } finally { store.close(); }
}));

test("automatic acquisition recommends and downloads only a model with declared adequate context", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "context-acquisition.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  const models: Array<Record<string, unknown>> = [{ type: "llm", publisher: "local", key: "short-model", display_name: "Short model", size_bytes: 1024, loaded_instances: [], max_context_length: 4096, capabilities: { trained_for_tool_use: true } }];
  const discoveryRequirements: number[] = []; let acquisitions = 0; let generatedModel = "";
  const provider = { redact: (value: string) => value, models: async () => models, streamChatWithTools: async (request: { model: string }) => { generatedModel = request.model; return { choices: [{ message: { role: "assistant", content: "Completed with enough context." } }] }; } };
  const acquisition = {
    recommend: async (_query: string, _signal?: AbortSignal, _scopes?: unknown, requirements?: { minimumContextTokens?: number }) => {
      const required = requirements?.minimumContextTokens ?? 0; discoveryRequirements.push(required);
      return [{ repository: "owner/long-context", artifact: "model-Q4_K_M.gguf", quantization: "Q4_K_M", sizeBytes: 1024, estimatedMemoryBytes: 1280, declaredContextTokens: 32768, diskSufficient: true, sha256: "a".repeat(64), license: "mit" }];
    },
    acquireRecommended: async () => { acquisitions++; models.push({ type: "llm", publisher: "owner", key: "owner/long-context", display_name: "Long context", size_bytes: 1024, loaded_instances: [], max_context_length: 32768, capabilities: { trained_for_tool_use: true } }); return { id: "long-context-download", repository: "owner/long-context", revision: "b".repeat(40), modelKey: "owner/long-context" }; },
    verify: async () => ({ capabilityCheck: { status: "passed", toolCalling: { status: "passed" } } })
  };
  const agent = new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never, modelAcquisition: acquisition as never });
  const objective = "Process the provided context carefully. ".repeat(800);
  try {
    config.set("global", "models.onlineDiscovery", true);
    await assert.rejects(() => agent.run(objective), /Recommended owner\/long-context model-Q4_K_M.gguf/);
    assert.equal(acquisitions, 0); assert.ok((discoveryRequirements[0] ?? 0) > 4096);
    config.set("global", "models.automaticDownloads", true);
    await assert.rejects(() => agent.run(objective), /none matches the saved license preference/);
    assert.equal(acquisitions, 0);
    config.set("global", "models.allowedLicenses", ["mit"]);
    const result = await agent.run(objective);
    assert.equal(result.model, "owner/long-context"); assert.equal(generatedModel, "owner/long-context"); assert.equal(acquisitions, 1);
    assert.match(result.selectionReason, /supports 32768 tokens/);
    // Mission resource scheduling passes its selected model into AgentRunner.
    // The assignment must remain provisional when the complete prompt needs
    // more context than that model declares, otherwise auto-acquisition is
    // unreachable for the most common mission execution path.
    models.splice(1);
    const missionResult = await agent.run(objective, { model: "short-model", automaticModelAssignment: true });
    assert.equal(missionResult.model, "owner/long-context"); assert.equal(generatedModel, "owner/long-context"); assert.equal(acquisitions, 2);
    assert.match(missionResult.selectionReason, /integrity checked, and capability verified/);
  } finally { store.close(); }
}));

test("web retrieval requires network access and blocks loopback targets", async () => {
  const tools = createWebTools(new AccessController({ mode: "restricted", network: true }));
  await assert.rejects(() => tools.web_fetch!.execute({ url: "http://127.0.0.1:1234/api/v1/models" }), /private or reserved/);
  const denied = createWebTools(new AccessController({ mode: "restricted", network: false }));
  await assert.rejects(() => denied.web_fetch!.execute({ url: "https://example.com" }), /denies network/);
});

test("web retrieval returns bounded JSON API responses as untrusted data", async () => {
  const startedAt = Date.now();
  let accept = "";
  const tools = createWebTools(new AccessController({ mode: "restricted", network: true }), {
    fetcher: async (_input, init) => {
      accept = new Headers(init?.headers).get("Accept") ?? "";
      return new Response('{"updated_at":"2026-10-25T12:00:00Z","items":[1,2]}', { status: 200, headers: { "content-type": "application/vnd.example+json; charset=utf-8" } });
    }
  });
  const result = await tools.web_fetch!.execute({ url: "https://8.8.8.8/api/status" }) as { contentType: string; status: number; retrieved_at: string; text: string; truncated: boolean; trust: string };
  assert.ok(accept.includes("application/*+json"));
  assert.equal(result.contentType, "application/vnd.example+json");
  assert.equal(result.status, 200);
  assert.ok(Date.parse(result.retrieved_at) >= startedAt && Date.parse(result.retrieved_at) <= Date.now());
  assert.equal(result.text, '{"updated_at":"2026-10-25T12:00:00Z","items":[1,2]}');
  assert.equal(result.truncated, false);
  assert.equal(result.trust, "untrusted-web-content");
});

test("desktop capability diagnostics distinguish Linux display sessions from native app automation", () => {
  const wayland = inspectDesktopCapabilities({ XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "GNOME", WAYLAND_DISPLAY: "wayland-0" }, "linux");
  assert.equal(wayland.session.type, "wayland");
  assert.equal(wayland.session.desktop, "GNOME");
  assert.equal(wayland.browser.headed, "display-detected");
  assert.equal(wayland.nativeApplicationAutomation.available, false);

  const x11 = inspectDesktopCapabilities({ DISPLAY: ":0" }, "linux");
  assert.equal(x11.session.type, "x11");
  assert.equal(x11.browser.headed, "display-detected");

  const headless = inspectDesktopCapabilities({}, "linux");
  assert.equal(headless.session.type, "unknown");
  assert.equal(headless.browser.headed, "no-display-detected");
  assert.match(headless.browser.note, /headless browser mode/);

  const windows = inspectDesktopCapabilities({}, "win32");
  assert.equal(windows.session.type, "not-applicable");
  assert.equal(windows.browser.headed, "platform-managed");
});

test("desktop automation exposes Windows UIA and Linux X11 tools with action policy checks", async () => {
  const windowsRunner = async (_command: string, args: string[]) => {
    const encoded = args[args.indexOf("-EncodedCommand") + 1];
    assert.ok(encoded);
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    const payload = script.match(/FromBase64String\('([^']+)'\)/)?.[1];
    const request = JSON.parse(Buffer.from(payload!, "base64").toString("utf8"));
    return { code: 0, signal: null, stdout: JSON.stringify(request.operation === "inspect" ? { window: { name: request.window_title }, controls: [] } : []), stderr: "", durationMs: 0 };
  };
  const windows = createDesktopAutomationTools(new AccessController(), true, { platform: "win32", env: { PATH: "C:\\Windows\\System32" }, pathExists: () => true, runner: windowsRunner });
  assert.ok(windows.desktop_windows);
  assert.deepEqual(await windows.desktop_inspect!.execute({ window_title: "Example" }), { window: { name: "Example" }, controls: [] });
  assert.equal(inspectNativeAutomation({ platform: "win32", env: {} }).available, true);
  assert.deepEqual(createDesktopAutomationTools(new AccessController(), false, { platform: "win32" }), {});
  const denied = createDesktopAutomationTools(new AccessController({ mode: "restricted", externalActions: false }), true, { platform: "win32", env: { PATH: "C:\\Windows\\System32" }, pathExists: () => true, runner: windowsRunner });
  await assert.rejects(() => denied.desktop_action!.execute({ action: "focus_window", window_title: "Example" }), /denies externalActions/);

  const calls: string[][] = [];
  const linuxRunner = async (_command: string, args: string[]) => {
    calls.push(args);
    const stdout = args[0] === "search" ? "42\n" : args[0] === "getwindowname" ? "Example\n" : "WINDOW=42\nX=10\nY=20\nWIDTH=300\nHEIGHT=200\nSCREEN=0\n";
    return { code: 0, signal: null, stdout, stderr: "", durationMs: 0 };
  };
  const linux = createDesktopAutomationTools(new AccessController(), true, { platform: "linux", env: { PATH: "/usr/bin", DISPLAY: ":0", XDG_SESSION_TYPE: "wayland" }, pathExists: () => true, runner: linuxRunner });
  assert.equal(inspectNativeAutomation({ platform: "linux", env: { PATH: "/usr/bin", DISPLAY: ":0", XDG_SESSION_TYPE: "wayland" }, pathExists: () => true }).available, true);
  assert.deepEqual(await linux.desktop_windows!.execute({}), [{ id: "42", title: "Example" }]);
  await linux.desktop_action!.execute({ action: "type_text", window_id: "42", text: "Xyst test" });
  assert.deepEqual(calls.at(-1), ["type", "--clearmodifiers", "--delay", "1", "--", "Xyst test"]);
  await assert.rejects(() => linux.desktop_action!.execute({ action: "click", window_id: "42", x: 300, y: 2 }), /outside the selected window bounds/);
});

test("persistent browser navigates, interacts, transfers bounded files, and enforces restricted access", async (t) => withTemp(async (workspace) => {
  const dataDir = getDataDirectory();
  const status = await browserRuntimeStatus(dataDir);
  if (!status.installed) { t.skip("Playwright Chromium is not installed"); return; }
  let uploadedBody = "";
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/upload") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => { uploadedBody = Buffer.concat(chunks).toString("utf8"); response.end("Upload received"); });
      return;
    }
    if (request.url === "/download") {
      response.writeHead(200, { "content-type": "text/plain", "content-disposition": "attachment; filename=sample.txt", "content-length": "16" });
      response.end("download-content"); return;
    }
    if (request.url === "/large-download") {
      response.writeHead(200, { "content-type": "text/plain", "content-disposition": "attachment; filename=large.txt" });
      response.end("this-file-is-over-limit"); return;
    }
    if (request.url === "/persist") {
      response.end('<!doctype html><title>Saved state</title><script>localStorage.setItem("xyst-browser-test", "persisted");document.cookie="xyst_browser_test=persisted; path=/; SameSite=Lax"</script><body>State saved</body>'); return;
    }
    if (request.url === "/check") {
      response.end('<!doctype html><title>Check state</title><body><script>document.body.innerText=localStorage.getItem("xyst-browser-test")+" "+document.cookie</script></body>'); return;
    }
    if (request.url === "/upload") { response.end("Upload received"); return; }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end('<!doctype html><title>Xyst local browser test</title><h1>Local page loaded</h1><input id="query"><button id="show" onclick="document.querySelector(\'#result\').innerText=document.querySelector(\'#query\').value">Show</button><p id="result"></p><a id="popup" href="/check" target="_blank">Open popup</a><a id="download" href="/download">Download</a><a id="large-download" href="/large-download">Large download</a><form action="/upload" method="post" enctype="multipart/form-data"><input id="file" type="file" name="file"><button id="upload">Upload</button></form>');
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const sessionId = `browser-test-${randomUUID()}`;
  const profilePath = join(dataDir, "browser", "profiles", createHash("sha256").update(sessionId).digest("hex").slice(0, 32));
  const browser = createBrowserTools({ access: new AccessController(), dataDir, sessionId, workspace, headless: true, maxDownloadBytes: 20 });
  const call = async (name: string, args: unknown = {}) => browser.tools[name]!.execute(args);
  try {
    const opened = await call("browser_open", { url: origin }) as { tab_id: string; title: string; trust: string };
    assert.equal(opened.title, "Xyst local browser test"); assert.equal(opened.trust, "untrusted-browser-content");
    await call("browser_fill", { selector: "#query", value: "browser interaction passed" });
    await call("browser_click", { selector: "#show" });
    const snapshot = await call("browser_snapshot") as { text: string; trust: string };
    assert.match(snapshot.text, /browser interaction passed/); assert.equal(snapshot.trust, "untrusted-browser-content");
    const saved = await call("browser_download", { selector: "#download", path: "sample.txt" }) as { bytes: number };
    assert.equal(saved.bytes, 16); assert.equal(await readFileAsync(join(workspace, "sample.txt"), "utf8"), "download-content");
    await assert.rejects(() => call("browser_download", { selector: "#large-download", path: "too-large.txt" }), /above the 20 byte browser download limit/);
    assert.equal(existsSync(join(workspace, "too-large.txt")), false);
    await writeFile(join(workspace, "upload.txt"), "upload-content");
    await call("browser_upload", { selector: "#file", path: "upload.txt" });
    await call("browser_click", { selector: "#upload" });
    assert.match(uploadedBody, /filename="upload\.txt"/); assert.match(uploadedBody, /upload-content/);
    const second = await call("browser_new_tab", { url: `${origin}/check` }) as { tab_id: string };
    assert.notEqual(second.tab_id, opened.tab_id);
    const activeTabs = await call("browser_tabs") as Array<{ tab_id: string; selected: boolean }>;
    assert.equal(activeTabs.find((tab) => tab.tab_id === second.tab_id)?.selected, true);
    await call("browser_select_tab", { tab_id: opened.tab_id });
    assert.equal((await call("browser_tabs") as Array<{ tab_id: string; selected: boolean }>).find((tab) => tab.tab_id === opened.tab_id)?.selected, true);
    await call("browser_close_tab", { tab_id: second.tab_id });
    await assert.rejects(() => call("browser_select_tab", { tab_id: second.tab_id }), /no longer open/);
    await call("browser_open", { url: origin });
    await call("browser_click", { selector: "#popup" });
    let popup: { tab_id: string; url: string } | undefined;
    for (let attempt = 0; attempt < 10 && !popup; attempt++) {
      const popupTabs = await call("browser_tabs") as Array<{ tab_id: string; url: string }>;
      popup = popupTabs.find((tab) => tab.tab_id !== opened.tab_id);
      if (!popup) await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    assert.ok(popup, "the page opened a second tab");
    await call("browser_select_tab", { tab_id: popup.tab_id });
    assert.equal((await call("browser_snapshot") as { url: string }).url, `${origin}/check`);
    await call("browser_close_tab", { tab_id: popup.tab_id });
    await call("browser_open", { url: `${origin}/persist` });
    await browser.close();
    const resumed = createBrowserTools({ access: new AccessController(), dataDir, sessionId, workspace, headless: true, maxDownloadBytes: 20 });
    try {
      await resumed.tools.browser_open!.execute({ url: `${origin}/check` });
      const persisted = await resumed.tools.browser_snapshot!.execute({}) as { text: string };
      assert.match(persisted.text, /persisted/);
      const tabs = await resumed.tools.browser_tabs!.execute({}) as Array<{ url: string }>;
      assert.ok(tabs.some((tab) => tab.url.endsWith("/check")));
    } finally { await resumed.close(); }
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(profilePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  const restricted = createBrowserTools({ access: new AccessController({ mode: "restricted", network: true, externalActions: false }), dataDir, sessionId: `${sessionId}-restricted`, workspace, headless: true, maxDownloadBytes: 20 });
  try {
    await assert.rejects(() => restricted.tools.browser_open!.execute({ url: origin }), /Private and local network hosts are not allowed|private or reserved/);
    await assert.rejects(() => restricted.tools.browser_click!.execute({ selector: "#show" }), /denies externalActions/);
  } finally { await restricted.close(); }
}));

test("host resource measurements parse NVIDIA memory and respect restricted executable access", async () => {
  let invoked = false;
  const measured = await readHostResourceStats(new AccessController(), async (command, args) => {
    invoked = true;
    assert.equal(command, process.platform === "win32" ? "nvidia-smi.exe" : "nvidia-smi");
    assert.deepEqual(args, ["--query-gpu=name,memory.total,memory.used,memory.free", "--format=csv,noheader,nounits"]);
    return { code: 0, signal: null, stdout: "NVIDIA Example GPU, 8192, 2048, 6144\n", stderr: "", durationMs: 1 };
  });
  assert.equal(invoked, true);
  assert.equal(measured.source, "Xyst host");
  assert.ok(measured.systemMemory.totalBytes > 0);
  assert.ok(measured.systemMemory.availableBytes >= 0);
  assert.equal(measured.nvidiaGpuMemory.status, "available");
  assert.deepEqual(measured.nvidiaGpuMemory.devices, [{ name: "NVIDIA Example GPU", totalBytes: 8192 * 1024 ** 2, usedBytes: 2048 * 1024 ** 2, freeBytes: 6144 * 1024 ** 2 }]);

  invoked = false;
  const blocked = await readHostResourceStats(new AccessController({ mode: "restricted", allowedExecutables: [] }), async () => {
    invoked = true; return { code: 0, signal: null, stdout: "", stderr: "", durationMs: 1 };
  });
  assert.equal(invoked, false);
  assert.equal(blocked.nvidiaGpuMemory.status, "blocked");
  assert.match(blocked.nvidiaGpuMemory.reason ?? "", /denies execution/);
});

test("LM Studio resource estimates parse documented GPU and total memory units", () => {
  assert.deepEqual(parseLmStudioResourceEstimate("Model: example\nEstimated GPU Memory: 1.05 GiB\nEstimated Total Memory: 2.5 GB"), { gpuBytes: Math.ceil(1.05 * 1024 ** 3), totalBytes: Math.ceil(2.5 * 1000 ** 3) });
  assert.deepEqual(parseLmStudioResourceEstimate("Estimate unavailable"), {});
  assert.deepEqual(parseLmStudioResourceEstimate("Estimated GPU Memory: NaN GB\nEstimated Total Memory: 9 EB"), {});
});

test("web search uses the configured Brave token and returns bounded untrusted sources", async () => {
  const startedAt = Date.now();
  let requestedUrl = ""; let authorization = "";
  const tools = createWebTools(new AccessController({ mode: "restricted", network: true }), {
    searchToken: async () => "test-search-token",
    fetcher: async (input, init) => {
      requestedUrl = String(input); authorization = new Headers(init?.headers).get("X-Subscription-Token") ?? "";
      return new Response(JSON.stringify({ web: { results: [
        { title: "Result", url: "https://example.com/page", description: "Snippet" },
        { title: "Bad scheme", url: "javascript:alert(1)", description: "ignored" },
        { title: "No URL", description: "ignored" }
      ] } }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  const result = await tools.web_search!.execute({ query: "local agent tools", count: 3 }) as { retrieved_at: string; results: Array<{ title: string; url: string; snippet: string }>; trust: string };
  assert.equal(new URL(requestedUrl).searchParams.get("q"), "local agent tools");
  assert.equal(new URL(requestedUrl).searchParams.get("count"), "3");
  assert.equal(authorization, "test-search-token");
  assert.ok(Date.parse(result.retrieved_at) >= startedAt && Date.parse(result.retrieved_at) <= Date.now());
  assert.deepEqual(result.results, [{ title: "Result", url: "https://example.com/page", snippet: "Snippet" }]);
  assert.equal(result.trust, "untrusted-search-results");
});

test("web search requires network permission and a configured token", async () => {
  let tokenRead = false;
  const tools = createWebTools(new AccessController({ mode: "restricted", network: false }), { searchToken: async () => { tokenRead = true; return undefined; } });
  await assert.rejects(() => tools.web_search!.execute({ query: "test" }), /denies network/);
  assert.equal(tokenRead, false);
  const unconfigured = createWebTools(new AccessController({ mode: "restricted", network: true }));
  await assert.rejects(() => unconfigured.web_search!.execute({ query: "test" }), /credential set brave search-api-key/);
});

test("project instructions load hierarchically with bounds and skip dependency folders", async () => withTemp(async (root) => {
  await mkdir(join(root, "src", "feature"), { recursive: true }); await mkdir(join(root, "node_modules", "ignored"), { recursive: true });
  await writeFile(join(root, "AGENTS.md"), "Root instructions");
  await writeFile(join(root, "src", "AGENTS.md"), "Source instructions");
  await writeFile(join(root, "src", "feature", "AGENTS.md"), "Specific instructions");
  await writeFile(join(root, "node_modules", "ignored", "AGENTS.md"), "Must not load");
  const contents = await loadProjectInstructions(new AccessController({ mode: "restricted", readRoots: [root] }), root);
  assert.ok(contents.indexOf("Root instructions") < contents.indexOf("Source instructions"));
  assert.ok(contents.indexOf("Source instructions") < contents.indexOf("Specific instructions"));
  assert.doesNotMatch(contents, /Must not load/);
}));

test("local skills are discoverable and readable only by validated name", async () => withTemp(async (root) => {
  const skillPath = join(root, ".xyst", "skills", "release-notes", "SKILL.md"); await mkdir(join(root, ".xyst", "skills", "release-notes"), { recursive: true });
  await writeFile(skillPath, "# Release notes\n\nSummarize user-facing changes by category.");
  const tools = createSkillTools(new AccessController({ mode: "restricted", readRoots: [root] }), root);
  const listed = await tools.skill_list!.execute({}) as { skills: Array<{ name: string; summary: string }> };
  assert.deepEqual(listed.skills, [{ name: "release-notes", path: ".xyst/skills/release-notes/SKILL.md", summary: "Summarize user-facing changes by category." }]);
  const read = await tools.skill_read!.execute({ name: "release-notes" }) as { content: string; trust: string };
  assert.match(read.content, /user-facing changes/); assert.equal(read.trust, "untrusted-skill-instructions");
  await assert.rejects(() => tools.skill_read!.execute({ name: "../secret" }), /Invalid|pattern/);
}));

test("MCP server tools are discovered, policy-gated, logged-compatible, and marked untrusted", async () => withTemp(async (root) => {
  let called = ""; let closed = false; let notification: ((value: { uri: string }) => void) | undefined; const subscriptions = new Set<string>();
  const connected = await createMcpTools(new AccessController({ mode: "restricted", integrations: true, network: true }), [{ id: "docs", transport: "streamable-http", url: "https://mcp.example.test/mcp", allowed_tools: ["lookup"] }], { get: async () => undefined }, root, undefined, {
    connect: async () => ({
      listTools: async () => ({ tools: [
        { name: "lookup", description: "Search docs", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
        { name: "ignore", inputSchema: { type: "object", properties: {} } }
      ] }),
      callTool: async ({ name, arguments: args }) => { called = name; return { content: [{ type: "text", text: `Found ${String(args.query)}` }] }; },
      listResources: async () => ({ resources: [{ uri: "docs://guide", name: "Guide" }] }),
      readResource: async ({ uri }) => ({ contents: [{ uri, text: "Untrusted guide text" }] }),
      getServerCapabilities: () => ({ resources: { subscribe: true } }),
      setNotificationHandler: (_method, _schema, handler) => { notification = handler; },
      subscribeResource: async ({ uri }) => { subscriptions.add(uri); return {}; },
      unsubscribeResource: async ({ uri }) => { subscriptions.delete(uri); return {}; },
      listPrompts: async () => ({ prompts: [{ name: "summarize" }] }),
      getPrompt: async ({ name }) => ({ messages: [{ role: "user", content: { type: "text", text: `Prompt ${name}` } }] }),
      close: async () => { closed = true; }
    })
  });
  assert.deepEqual(connected.servers, [{ id: "docs", toolCount: 1 }]);
  const result = await connected.tools.mcp_docs_lookup!.execute({ query: "cancellation" }) as { trust: string; result: { content: Array<{ text: string }> } };
  assert.equal(called, "lookup"); assert.equal(result.result.content[0]?.text, "Found cancellation"); assert.equal(result.trust, "untrusted-mcp-content");
  const resource = await connected.tools.mcp_docs_read_resource!.execute({ uri: "docs://guide" }) as { trust: string; result: string };
  assert.equal(resource.trust, "untrusted-mcp-content"); assert.match(resource.result, /Untrusted guide text/);
  const subscribed = await connected.tools.mcp_docs_subscribe_resource!.execute({ uri: "docs://guide" }) as { subscribed: boolean; scope: string };
  assert.equal(subscribed.subscribed, true); assert.equal(subscribed.scope, "agent-run"); assert.equal(subscriptions.has("docs://guide"), true);
  notification?.({ uri: "docs://guide" });
  const updates = await connected.tools.mcp_docs_resource_updates!.execute({}) as { updates: Array<{ uri: string }>; trust: string };
  assert.equal(updates.updates[0]?.uri, "docs://guide"); assert.equal(updates.trust, "untrusted-mcp-content");
  await connected.tools.mcp_docs_unsubscribe_resource!.execute({ uri: "docs://guide" }); assert.equal(subscriptions.has("docs://guide"), false);
  await connected.tools.mcp_docs_subscribe_resource!.execute({ uri: "docs://cleanup" });
  const prompt = await connected.tools.mcp_docs_get_prompt!.execute({ name: "summarize" }) as { trust: string; result: string };
  assert.equal(prompt.trust, "untrusted-mcp-content"); assert.match(prompt.result, /Prompt summarize/);
  await connected.close(); assert.equal(closed, true); assert.equal(subscriptions.size, 0, "active MCP subscriptions are released when the agent run closes");
  const denied = createMcpTools(new AccessController({ mode: "restricted", integrations: false }), [{ id: "docs", transport: "streamable-http", url: "https://mcp.example.test/mcp" }], { get: async () => undefined }, root, undefined, { connect: async () => { throw new Error("should not connect"); } });
  await assert.rejects(() => denied, /denies integrations/);
}));

test("MCP server sampling requests use the configured client handler", async () => withTemp(async (root) => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "xyst-sampling-test", version: "0.1.0" });
  client.registerCapabilities({ sampling: { tools: {} } });
  const server = new Server({ name: "sampling-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", async () => ({ tools: [] }));
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  let received: unknown;
  const connection = await createMcpTools(new AccessController(), [{ id: "sampling", transport: "streamable-http", url: "https://mcp.example.test/mcp" }], { get: async () => undefined }, root, undefined, {
    connect: async () => client as never,
    sample: async (request) => {
      received = request;
      const messages = request && typeof request === "object" && "messages" in request && Array.isArray(request.messages) ? request.messages : [];
      if (request && typeof request === "object" && "tools" in request && !messages.some((message) => message && typeof message === "object" && "content" in message && message.content && typeof message.content === "object" && "type" in message.content && message.content.type === "tool_result")) return { model: "selected-local-model", role: "assistant", content: { type: "tool_use", id: "sample-call", name: "lookup", input: { query: "x" } }, stopReason: "toolUse" };
      return { model: "selected-local-model", role: "assistant", content: { type: "text", text: "sampled answer" }, stopReason: "endTurn" };
    }
  });
  try {
    const response = await server.createMessage({ messages: [{ role: "user", content: { type: "text", text: "Summarize this result" } }], maxTokens: 32 });
    assert.deepEqual(received, { messages: [{ role: "user", content: { type: "text", text: "Summarize this result" } }], maxTokens: 32 });
    assert.equal(response.model, "selected-local-model");
    assert.equal(response.content.type, "text");
    if (response.content.type !== "text") throw new Error("Expected text sampling result");
    assert.equal(response.content.text, "sampled answer");

    const toolUse = await server.createMessage({ messages: [{ role: "user", content: { type: "text", text: "Look this up" } }], maxTokens: 32, tools: [{ name: "lookup", inputSchema: { type: "object", properties: { query: { type: "string" } } } }], toolChoice: { mode: "required" } });
    assert.deepEqual(toolUse.content, { type: "tool_use", id: "sample-call", name: "lookup", input: { query: "x" } });
    const followup = await server.createMessage({ messages: [
      { role: "user", content: { type: "text", text: "Look this up" } },
      { role: "assistant", content: toolUse.content },
      { role: "user", content: { type: "tool_result", toolUseId: "sample-call", content: [{ type: "text", text: "Lookup result" }] } }
    ], maxTokens: 32, tools: [{ name: "lookup", inputSchema: { type: "object", properties: { query: { type: "string" } } } }] });
    assert.deepEqual(followup.content, { type: "text", text: "sampled answer" });
  } finally {
    await connection.close();
    await server.close();
  }
}));

test("MCP sampling with tools returns a server-directed tool use and accepts its follow-up result", async () => {
  const requests: Array<{ model: string; messages: unknown[]; tools: unknown[]; tool_choice?: string; parallel_tool_calls?: boolean }> = [];
  const provider = {
    chat: async () => { throw new Error("tool-assisted sampling must use the compatibility tool endpoint"); },
    chatWithTools: async (request: typeof requests[number]) => {
      requests.push(request);
      if (requests.length === 1) return { choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "xyst_mcp_tool_0", arguments: "{\"query\":\"React\"}" } }] } }] };
      return { choices: [{ finish_reason: "stop", message: { content: "Found three React articles", tool_calls: [] } }] };
    }
  };
  const sample = createMcpSamplingHandler(provider, "qwen/local", "qwen/local:2");
  const tools = [{ name: "wiki.lookup", description: "Find documentation", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }];
  const toolUse = await sample({ messages: [{ role: "user", content: { type: "text", text: "Find React documentation" } }], maxTokens: 64, tools, toolChoice: { mode: "required" } });
  assert.deepEqual(toolUse, { model: "qwen/local", role: "assistant", content: { type: "tool_use", id: "call-1", name: "wiki.lookup", input: { query: "React" } }, stopReason: "toolUse" });
  assert.deepEqual(requests[0]?.tools, [{ type: "function", function: { name: "xyst_mcp_tool_0", description: "Find documentation\nOriginal MCP tool name: wiki.lookup", parameters: tools[0]!.inputSchema } }]);
  assert.equal(requests[0]?.tool_choice, "required");
  assert.equal(requests[0]?.parallel_tool_calls, false);

  const final = await sample({ messages: [
    { role: "user", content: { type: "text", text: "Find React documentation" } },
    { role: "assistant", content: { type: "tool_use", id: "call-1", name: "wiki.lookup", input: { query: "React" } } },
    { role: "user", content: { type: "tool_result", toolUseId: "call-1", content: [{ type: "text", text: "Found three articles" }] } }
  ], maxTokens: 64, tools, toolChoice: { mode: "auto" } });
  assert.deepEqual(final, { model: "qwen/local", role: "assistant", content: { type: "text", text: "Found three React articles" }, stopReason: "endTurn" });
  assert.deepEqual(requests[1]?.messages, [
    { role: "user", content: "Find React documentation" },
    { role: "assistant", tool_calls: [{ id: "call-1", type: "function", function: { name: "xyst_mcp_tool_0", arguments: "{\"query\":\"React\"}" } }] },
    { role: "tool", tool_call_id: "call-1", content: "Found three articles" }
  ]);
});

test("MCP sampling rejects undeclared calls, mismatched results, and unsupported image content", async () => {
  const sample = createMcpSamplingHandler({ chat: async () => ({ choices: [{ message: { content: "ok" } }] }) }, "qwen/local", "qwen/local:2");
  await assert.rejects(() => sample({ messages: [{ role: "assistant", content: { type: "tool_use", id: "call-x", name: "unknown", input: {} } }], maxTokens: 16, tools: [{ name: "known", inputSchema: { type: "object" } }] }), /unknown or duplicate tool call/);
  await assert.rejects(() => sample({ messages: [{ role: "user", content: { type: "tool_result", toolUseId: "missing", content: [{ type: "text", text: "x" }] } }], maxTokens: 16, tools: [{ name: "known", inputSchema: { type: "object" } }] }), /no matching prior tool call/);
  await assert.rejects(() => sample({ messages: [{ role: "user", content: { type: "image", data: "AA==", mimeType: "image/png" } }], maxTokens: 16 }), /image and audio sampling are unsupported/);
});

test("LM Studio native integrations validate plugin and ephemeral MCP configuration and resolve vault headers", async () => {
  const secret = "native-mcp-secret-value";
  const resolved = await resolveLMStudioIntegrations([
    { type: "plugin", id: "mcp/playwright", allowed_tools: ["browser_navigate"] },
    { type: "ephemeral_mcp", server_label: "private-search", server_url: "https://mcp.example.test/mcp", allowed_tools: ["lookup"], credential_headers: { Authorization: { service: "mcp-test", name: "token" } } }
  ], { get: async (service, name) => service === "mcp-test" && name === "token" ? secret : undefined });
  assert.deepEqual(resolved.integrations, [
    { type: "plugin", id: "mcp/playwright", allowed_tools: ["browser_navigate"] },
    { type: "ephemeral_mcp", server_label: "private-search", server_url: "https://mcp.example.test/mcp", allowed_tools: ["lookup"], headers: { Authorization: secret } }
  ]);
  assert.deepEqual(resolved.secrets, [secret]);
  await assert.rejects(() => resolveLMStudioIntegrations([{ type: "ephemeral_mcp", server_label: "bad", server_url: "https://mcp.example.test/mcp", headers: { Authorization: secret } }], { get: async () => undefined }), /Unrecognized key/);
  await assert.rejects(() => resolveLMStudioIntegrations([{ type: "ephemeral_mcp", server_label: "insecure", server_url: "http://mcp.example.test/mcp" }], { get: async () => undefined }));
  await assert.rejects(() => resolveLMStudioIntegrations([{ type: "ephemeral_mcp", server_label: "duplicate-header", server_url: "https://mcp.example.test/mcp", credential_headers: { Authorization: { service: "mcp-test", name: "one" }, authorization: { service: "mcp-test", name: "two" } } }], { get: async () => secret }));
  await assert.rejects(() => resolveLMStudioIntegrations([{ type: "ephemeral_mcp", server_label: "missing", server_url: "https://mcp.example.test/mcp", credential_headers: { Authorization: { service: "mcp-test", name: "missing" } } }], { get: async () => undefined }), /credential is missing/);
});

test("MCP resource subscriptions receive SDK notifications and clean up on close", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const subscribedUris = new Set<string>();
  const server = new Server({ name: "subscription-fixture", version: "1.0.0" }, { capabilities: { tools: {}, resources: { subscribe: true } } });
  server.setRequestHandler("tools/list", async () => ({ tools: [] }));
  server.setRequestHandler("resources/list", async () => ({ resources: [{ uri: "fixture://resource", name: "Fixture" }] }));
  server.setRequestHandler("resources/read", async ({ params }) => ({ contents: [{ uri: params.uri, text: "fresh fixture contents" }] }));
  server.setRequestHandler("resources/subscribe", async ({ params }) => { subscribedUris.add(params.uri); return {}; });
  server.setRequestHandler("resources/unsubscribe", async ({ params }) => { subscribedUris.delete(params.uri); return {}; });
  const client = new Client({ name: "xyst-test", version: "0.1.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const connection = await createMcpTools(new AccessController(), [{ id: "fixture", transport: "streamable-http", url: "https://mcp.example.test/mcp" }], { get: async () => undefined }, process.cwd(), undefined, { connect: async () => client as never });
  try {
    await connection.tools.mcp_fixture_subscribe_resource!.execute({ uri: "fixture://resource" });
    assert.equal(subscribedUris.has("fixture://resource"), true);
    await server.notification({ method: "notifications/resources/updated", params: { uri: "fixture://resource" } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const notices = await connection.tools.mcp_fixture_resource_updates!.execute({}) as { updates: Array<{ uri: string }> };
    assert.equal(notices.updates.at(-1)?.uri, "fixture://resource");
    const fresh = await connection.tools.mcp_fixture_read_resource!.execute({ uri: "fixture://resource" }) as { result: string };
    assert.match(fresh.result, /fresh fixture contents/);
  } finally {
    await connection.close(); await server.close();
  }
  assert.equal(subscribedUris.size, 0, "closing the client run must unsubscribe tracked resources");
});

test("MCP modern resource listen replaces filters and closes its stream", async () => withTemp(async (root) => {
  let notification: ((value: { uri: string }) => void) | undefined;
  const opened: string[][] = []; const closed: string[][] = [];
  const connected = await createMcpTools(new AccessController(), [{ id: "modern", transport: "streamable-http", url: "https://mcp.example.test/mcp" }], { get: async () => undefined }, root, undefined, {
    connect: async () => ({
      listTools: async () => ({ tools: [] }), callTool: async () => ({}),
      getServerCapabilities: () => ({ resources: { subscribe: true } }), getProtocolEra: () => "modern",
      setNotificationHandler: (_method, _schema, handler) => { notification = handler; },
      listen: async ({ resourceSubscriptions }: { resourceSubscriptions?: string[] }) => {
        const filter = [...(resourceSubscriptions ?? [])]; opened.push(filter);
        return { honoredFilter: { resourceSubscriptions: filter }, close: async () => { closed.push(filter); } };
      }, close: async () => undefined
    })
  });
  await Promise.all([
    connected.tools.mcp_modern_subscribe_resource!.execute({ uri: "docs://one" }),
    connected.tools.mcp_modern_subscribe_resource!.execute({ uri: "docs://two" })
  ]);
  assert.deepEqual(opened, [["docs://one"], ["docs://one", "docs://two"]]);
  assert.deepEqual(closed, [["docs://one"]], "replacing a modern stream closes the previous filter after the next is ready");
  notification?.({ uri: "docs://two" });
  const updates = await connected.tools.mcp_modern_resource_updates!.execute({}) as { updates: Array<{ uri: string }> };
  assert.equal(updates.updates.at(-1)?.uri, "docs://two");
  await Promise.all([
    connected.tools.mcp_modern_unsubscribe_resource!.execute({ uri: "docs://one" }),
    connected.tools.mcp_modern_unsubscribe_resource!.execute({ uri: "docs://two" })
  ]);
  assert.deepEqual(opened.at(-1), ["docs://two"]);
  await connected.tools.mcp_modern_subscribe_resource!.execute({ uri: "docs://cleanup" });
  await connected.close();
  assert.deepEqual(closed.at(-1), ["docs://cleanup"], "closing the run closes its active modern listen stream");
}));

test("MCP modern protocol negotiates and receives resource updates over Streamable HTTP", async () => withTemp(async (root) => {
  const eras: string[] = [];
  const handler = createMcpHandler(({ era }) => {
    eras.push(era);
    const server = new Server({ name: "modern-http-fixture", version: "1.0.0" }, { capabilities: { tools: {}, resources: { subscribe: true } } });
    server.setRequestHandler("tools/list", async () => ({ tools: [] }));
    server.setRequestHandler("resources/list", async () => ({ resources: [{ uri: "fixture://modern", name: "Modern fixture" }] }));
    server.setRequestHandler("resources/read", async ({ params }) => ({ contents: [{ uri: params.uri, text: "modern content" }] }));
    assert.equal(era, "modern");
    return server;
  }, { legacy: "reject", keepAliveMs: 100 });
  const httpServer = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const response = await handler.fetch(new Request(`http://127.0.0.1${incoming.url ?? "/mcp"}`, {
        method: incoming.method ?? "GET",
        headers: incoming.headers as HeadersInit,
        ...(body.length ? { body } : {})
      }));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      if (response.body) for await (const chunk of response.body) outgoing.write(Buffer.from(chunk));
      outgoing.end();
    } catch (error) {
      outgoing.writeHead(500); outgoing.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise<void>((resolve, reject) => { httpServer.once("error", reject); httpServer.listen(0, "127.0.0.1", resolve); });
  const address = httpServer.address(); assert.ok(address && typeof address === "object");
  const connection = await createMcpTools(new AccessController(), [{ id: "modern-http", transport: "streamable-http", url: `http://127.0.0.1:${address.port}/mcp` }], { get: async () => undefined }, root);
  try {
    const subscribeTool = connection.tools["mcp_modern-http_subscribe_resource"];
    assert.ok(subscribeTool, `tools=${Object.keys(connection.tools).join(",")} eras=${eras.join(",")}`);
    const subscription = await subscribeTool.execute({ uri: "fixture://modern" });
    assert.equal((subscription as { subscribed: boolean }).subscribed, true);
    handler.notify.resourceUpdated("fixture://modern");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const notices = await connection.tools["mcp_modern-http_resource_updates"]!.execute({}) as { updates: Array<{ uri: string }> };
    assert.equal(notices.updates.at(-1)?.uri, "fixture://modern");
    const resource = await connection.tools["mcp_modern-http_read_resource"]!.execute({ uri: "fixture://modern" }) as { result: string };
    assert.match(resource.result, /modern content/);
  } finally {
    await connection.close(); await handler.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
}));

test("MCP configuration rejects inline secret environment variables and duplicate IDs", () => {
  assert.throws(() => mcpServersSchema.parse([{ id: "local", transport: "stdio", command: "node", env: { API_TOKEN: "secret" } }]), /credential_env references/);
  assert.throws(() => mcpServersSchema.parse([{ id: "same", transport: "stdio", command: "node" }, { id: "same", transport: "stdio", command: "node" }]), /Duplicate MCP server id/);
  assert.throws(() => mcpServersSchema.parse([{ id: "remote", transport: "streamable-http", url: "http://example.com/mcp", oauth: true }]), /requires HTTPS/);
  assert.throws(() => mcpServersSchema.parse([{ id: "remote", transport: "streamable-http", url: "https://example.com/mcp", oauth: true, bearer_credential: { service: "test", name: "token" } }]), /Choose OAuth or a static bearer credential/);
  const token = { service: "test", name: "token" };
  assert.throws(() => mcpServersSchema.parse([{ id: "remote", transport: "streamable-http", url: "http://mcp.example.com/mcp", bearer_credential: token }]), /bearer credentials require HTTPS/);
  assert.doesNotThrow(() => mcpServersSchema.parse([{ id: "remote", transport: "streamable-http", url: "https://mcp.example.com/mcp", bearer_credential: token }]));
  assert.doesNotThrow(() => mcpServersSchema.parse([{ id: "local", transport: "sse", url: "http://127.0.0.1:8080/sse", bearer_credential: token }]));
  assert.doesNotThrow(() => mcpServersSchema.parse([{ id: "local-v6", transport: "streamable-http", url: "http://[::1]:8080/mcp", bearer_credential: token }]));
});

test("MCP OAuth provider persists issuer-scoped tokens and clears authorization on logout", async () => {
  const records = new Map<string, string>();
  const credentials = {
    async get(service: string, name: string) { return records.get(`${service}/${name}`); },
    async set(service: string, name: string, value: string) { records.set(`${service}/${name}`, value); },
    async delete(service: string, name: string) { return records.delete(`${service}/${name}`); }
  };
  const secrets: string[] = [];
  const provider = new McpOAuthClientProvider("remote", "http://127.0.0.1:1234/oauth/callback", credentials, secrets);
  await provider.saveTokens({ access_token: "access-token-secret", token_type: "Bearer", issuer: "https://auth.example" });
  assert.equal((await provider.savedTokens())?.access_token, "access-token-secret");
  assert.ok(secrets.includes("access-token-secret"));
  assert.equal(provider.clientMetadata.redirect_uris[0], "http://127.0.0.1:1234/oauth/callback");
  await provider.logout();
  assert.equal(await provider.savedTokens(), undefined);
});

test("MCP OAuth completes metadata discovery, dynamic registration, PKCE, callback, and authenticated initialization", async () => {
  const handler = createMcpHandler(() => new Server({ name: "oauth-fixture", version: "1.0.0" }, { capabilities: { tools: {} } }), { legacy: "reject" });
  const records = new Map<string, string>();
  const credentialStore = {
    async get(service: string, name: string) { return records.get(`${service}/${name}`); },
    async set(service: string, name: string, value: string) { records.set(`${service}/${name}`, value); },
    async delete(service: string, name: string) { return records.delete(`${service}/${name}`); }
  };
  let callbackUrl = ""; let state = ""; let challenge = ""; let pkceVerified = false; let registeredRedirect = ""; let authorizedInitialize = false;
  const httpServer = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    const host = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
    const pathname = new URL(incoming.url ?? "/", host).pathname;
    const sendJson = (status: number, value: unknown) => { outgoing.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" }); outgoing.end(JSON.stringify(value)); };
    if (pathname === "/.well-known/oauth-protected-resource/mcp") { sendJson(200, { resource: `${host}/mcp`, authorization_servers: [host], scopes_supported: ["mcp"] }); return; }
    if (pathname === "/.well-known/oauth-authorization-server") { sendJson(200, { issuer: host, authorization_endpoint: `${host}/authorize`, token_endpoint: `${host}/token`, registration_endpoint: `${host}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] }); return; }
    if (pathname === "/register" && incoming.method === "POST") { const metadata = JSON.parse(body) as { redirect_uris: string[]; grant_types: string[]; response_types: string[]; token_endpoint_auth_method: string }; registeredRedirect = metadata.redirect_uris[0] ?? ""; sendJson(201, { client_id: "xyst-test-client", redirect_uris: metadata.redirect_uris, grant_types: metadata.grant_types, response_types: metadata.response_types, token_endpoint_auth_method: metadata.token_endpoint_auth_method }); return; }
    if (pathname === "/authorize") {
      const query = new URL(incoming.url ?? "/", host).searchParams;
      callbackUrl = query.get("redirect_uri") ?? ""; state = query.get("state") ?? ""; challenge = query.get("code_challenge") ?? "";
      const redirect = new URL(callbackUrl); redirect.searchParams.set("code", "test-auth-code"); redirect.searchParams.set("state", state);
      outgoing.writeHead(302, { location: redirect.toString(), "cache-control": "no-store" }); outgoing.end(); return;
    }
    if (pathname === "/token" && incoming.method === "POST") {
      const form = new URLSearchParams(body); const verifier = form.get("code_verifier") ?? "";
      pkceVerified = form.get("grant_type") === "authorization_code" && form.get("code") === "test-auth-code" && createHash("sha256").update(verifier).digest("base64url") === challenge;
      sendJson(pkceVerified ? 200 : 400, pkceVerified ? { access_token: "mcp-test-access-token", token_type: "Bearer", expires_in: 3600, scope: "mcp" } : { error: "invalid_grant" }); return;
    }
    if (pathname === "/mcp") {
      if (incoming.headers.authorization !== "Bearer mcp-test-access-token") { outgoing.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${host}/.well-known/oauth-protected-resource/mcp", scope="mcp"` }); outgoing.end(); return; }
      authorizedInitialize = true;
      try {
        const response = await handler.fetch(new Request(`${host}/mcp`, { method: incoming.method ?? "POST", headers: incoming.headers as HeadersInit, ...(body ? { body } : {}) }));
        outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        if (response.body) for await (const chunk of response.body) outgoing.write(Buffer.from(chunk));
        outgoing.end();
      } catch (error) { outgoing.writeHead(500); outgoing.end(error instanceof Error ? error.message : String(error)); }
      return;
    }
    outgoing.writeHead(404); outgoing.end();
  });
  await new Promise<void>((resolve, reject) => { httpServer.once("error", reject); httpServer.listen(0, "127.0.0.1", resolve); });
  try {
    const address = httpServer.address(); assert.ok(address && typeof address === "object");
    const result = await authenticateMcpOAuth({ id: "oauth-fixture", transport: "streamable-http", url: `http://127.0.0.1:${address.port}/mcp`, oauth: true }, credentialStore, { timeoutMs: 10_000, onAuthorizationUrl: async (url) => { const response = await fetch(url); assert.equal(response.status, 200); } });
    assert.equal(result.authorized, true); assert.equal(registeredRedirect, callbackUrl); assert.ok(state.length > 10); assert.ok(challenge.length > 20); assert.equal(pkceVerified, true); assert.equal(authorizedInitialize, true);
    const provider = new McpOAuthClientProvider("oauth-fixture", callbackUrl, credentialStore);
    assert.equal((await provider.savedTokens())?.access_token, "mcp-test-access-token");
  } finally { await new Promise<void>((resolve) => httpServer.close(() => resolve())); }
});

test("MCP stdio transport starts a local server, discovers tools, calls them, and closes", async () => withTemp(async (root) => {
  const serverPath = join(root, "server.mjs");
  await writeFile(serverPath, [
    `import { McpServer } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js"))};`,
    `import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};`,
    `import { z } from ${JSON.stringify(import.meta.resolve("zod"))};`,
    'const server = new McpServer({ name: "xyst-test", version: "1.0.0" });',
    'server.tool("echo", "Echo one message", { message: z.string() }, async ({ message }) => ({ content: [{ type: "text", text: message }] }));',
    'server.resource("guide", "docs://guide", async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: "Guide text" }] }));',
    'server.prompt("summarize", "Summarize a topic", { topic: z.string() }, async ({ topic }) => ({ messages: [{ role: "user", content: { type: "text", text: "Summarize " + topic } }] }));',
    'await server.connect(new StdioServerTransport());'
  ].join("\n"));
  const connection = await createMcpTools(new AccessController(), [{ id: "local", transport: "stdio", command: process.execPath, args: [serverPath], cwd: root }], { get: async () => undefined }, root);
  try {
    assert.deepEqual(connection.servers, [{ id: "local", toolCount: 1 }]);
    const result = await connection.tools.mcp_local_echo!.execute({ message: "stdio ready" }) as { result: { content: Array<{ text: string }> } };
    assert.equal(result.result.content[0]?.text, "stdio ready");
    const resources = await connection.tools.mcp_local_resources!.execute({}) as { result: string };
    assert.match(resources.result, /docs:\/\/guide/);
    const guide = await connection.tools.mcp_local_read_resource!.execute({ uri: "docs://guide" }) as { result: string; trust: string };
    assert.match(guide.result, /Guide text/); assert.equal(guide.trust, "untrusted-mcp-content");
    const prompts = await connection.tools.mcp_local_prompts!.execute({}) as { result: string };
    assert.match(prompts.result, /summarize/);
    const prompt = await connection.tools.mcp_local_get_prompt!.execute({ name: "summarize", arguments: { topic: "Xyst" } }) as { result: string; trust: string };
    assert.match(prompt.result, /Summarize Xyst/); assert.equal(prompt.trust, "untrusted-mcp-content");
  } finally { await connection.close(); }
}));

test("independent stdio MCP server negotiates sampling tools and completes a tool-result round trip", async () => withTemp(async (root) => {
  const serverPath = join(root, "sampling-server.mjs"); const resultPath = join(root, "sampling-result.json");
  await writeFile(serverPath, [
    `import { McpServer } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js"))};`,
    `import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};`,
    'const server = new McpServer({ name: "independent-sampling-fixture", version: "1.0.0" });',
    'server.tool("exercise_sampling", "Exercise client sampling with a server-owned lookup tool", {}, async () => {',
    '  const tools = [{ name: "wiki.lookup", description: "Find documentation", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }];',
    '  const messages = [{ role: "user", content: { type: "text", text: "Find React documentation" } }];',
    '  const first = await server.server.createMessage({ messages, maxTokens: 64, tools, toolChoice: { mode: "required" } });',
    '  if (first.content?.type !== "tool_use") throw new Error("Client did not return a sampling tool use");',
    '  const second = await server.server.createMessage({ messages: [...messages, { role: "assistant", content: first.content }, { role: "user", content: { type: "tool_result", toolUseId: first.content.id, content: [{ type: "text", text: "Server lookup found three React articles" }] } }], maxTokens: 64, tools, toolChoice: { mode: "auto" } });',
    '  return { content: [{ type: "text", text: JSON.stringify({ capabilities: server.server.getClientCapabilities(), first, second }) }] };',
    '});',
    'await server.connect(new StdioServerTransport());'
  ].join("\n"));

  const modelRequests: Array<{ messages: unknown[]; tools: unknown[]; tool_choice?: string }> = [];
  const sample = createMcpSamplingHandler({
    chat: async () => { throw new Error("sampling with tools must use chatWithTools"); },
    chatWithTools: async (request: typeof modelRequests[number]) => {
      modelRequests.push(request);
      if (modelRequests.length === 1) return { choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "stdio-call-1", type: "function", function: { name: "xyst_mcp_tool_0", arguments: "{\"query\":\"React\"}" } }] } }] };
      return { choices: [{ finish_reason: "stop", message: { content: "Found three React articles", tool_calls: [] } }] };
    }
  }, "qwen/local", "qwen/local:2");
  const connection = await createMcpTools(new AccessController(), [{ id: "sampling", transport: "stdio", command: process.execPath, args: [serverPath], cwd: root }], { get: async () => undefined }, root, undefined, { sample });
  try {
    const call = connection.tools.mcp_sampling_exercise_sampling;
    assert.ok(call, "independent sampling server tool should be exposed");
    const response = await call.execute({}) as { result: { content: Array<{ text: string }> } };
    const report = JSON.parse(response.result.content[0]!.text) as { capabilities: { sampling?: { tools?: unknown } }; first: { content: { type: string; name?: string; input?: unknown } }; second: { content: { type: string; text?: string } } };
    assert.ok(report.capabilities.sampling?.tools, "client must advertise request-scoped sampling tools");
    assert.equal(report.first.content.type, "tool_use");
    assert.equal(report.first.content.name, "wiki.lookup");
    assert.deepEqual(report.first.content.input, { query: "React" });
    assert.equal(report.second.content.type, "text");
    assert.equal(report.second.content.text, "Found three React articles");
    assert.deepEqual(modelRequests[1]?.messages.at(-1), { role: "tool", tool_call_id: "stdio-call-1", content: "Server lookup found three React articles" });
  } finally { await connection.close(); }
}));

test("independent HTTP MCP server negotiates sampling tools and completes a tool-result round trip", async () => withTemp(async (root) => {
  const serverPath = join(root, "http-sampling-server.mjs"); const readyPath = join(root, "http-sampling-ready.json");
  await writeFile(serverPath, [
    `import { createServer } from "node:http";`,
    `import { writeFile } from "node:fs/promises";`,
    `import { McpServer } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js"))};`,
    `import { StreamableHTTPServerTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/streamableHttp.js"))};`,
    'const server = new McpServer({ name: "independent-http-sampling-fixture", version: "1.0.0" });',
    'server.tool("exercise_sampling", "Exercise client sampling with a server-owned lookup tool", {}, async () => {',
    '  const tools = [{ name: "wiki.lookup", description: "Find documentation", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }];',
    '  const messages = [{ role: "user", content: { type: "text", text: "Find React documentation" } }];',
    '  const first = await server.server.createMessage({ messages, maxTokens: 64, tools, toolChoice: { mode: "required" } });',
    '  if (first.content?.type !== "tool_use") throw new Error("Client did not return a sampling tool use");',
    '  const second = await server.server.createMessage({ messages: [...messages, { role: "assistant", content: first.content }, { role: "user", content: { type: "tool_result", toolUseId: first.content.id, content: [{ type: "text", text: "Server lookup found three React articles" }] } }], maxTokens: 64, tools, toolChoice: { mode: "auto" } });',
    '  return { content: [{ type: "text", text: JSON.stringify({ capabilities: server.server.getClientCapabilities(), first, second }) }] };',
    '});',
    'const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });',
    'await server.connect(transport);',
    'const http = createServer(async (req, res) => {',
    '  let body = ""; for await (const chunk of req) body += chunk;',
    '  let parsed; try { parsed = body ? JSON.parse(body) : undefined; } catch { res.writeHead(400).end("invalid JSON"); return; }',
    '  try { await transport.handleRequest(req, res, parsed); } catch (error) { if (!res.headersSent) res.writeHead(500).end(String(error)); }',
    '});',
    'http.listen(0, "127.0.0.1", async () => { await writeFile(process.argv[2], JSON.stringify({ port: http.address().port })); });',
    'process.on("SIGTERM", () => { void transport.close().finally(() => http.close(() => process.exit(0))); });'
  ].join("\n"));

  const child = spawn(process.execPath, [serverPath, readyPath], { cwd: root, stdio: "ignore" });
  let connection: Awaited<ReturnType<typeof createMcpTools>> | undefined;
  try {
    let port: number | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`HTTP MCP fixture exited early with ${child.exitCode}`);
      try { port = (JSON.parse(await readFileAsync(readyPath, "utf8")) as { port: number }).port; break; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    assert.ok(port, "independent HTTP MCP fixture should announce its loopback port");
    const modelRequests: Array<{ messages: unknown[]; tools: unknown[]; tool_choice?: string }> = [];
    const sample = createMcpSamplingHandler({
      chat: async () => { throw new Error("sampling with tools must use chatWithTools"); },
      chatWithTools: async (request: typeof modelRequests[number]) => {
        modelRequests.push(request);
        if (modelRequests.length === 1) return { choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "http-call-1", type: "function", function: { name: "xyst_mcp_tool_0", arguments: JSON.stringify({ query: "React" }) } }] } }] };
        return { choices: [{ finish_reason: "stop", message: { content: "Found three React articles", tool_calls: [] } }] };
      }
    }, "qwen/local", "qwen/local:2");
    connection = await createMcpTools(new AccessController(), [{ id: "sampling", transport: "streamable-http", url: `http://127.0.0.1:${port}/mcp` }], { get: async () => undefined }, root, undefined, { sample });
    const call = connection.tools.mcp_sampling_exercise_sampling;
    assert.ok(call, "independent HTTP sampling server tool should be exposed");
    const response = await call.execute({}) as { result: { content: Array<{ text: string }> } };
    const report = JSON.parse(response.result.content[0]!.text) as { capabilities: { sampling?: { tools?: unknown } }; first: { content: { type: string; name?: string; input?: unknown } }; second: { content: { type: string; text?: string } } };
    assert.ok(report.capabilities.sampling?.tools, "client must advertise request-scoped sampling tools over HTTP");
    assert.equal(report.first.content.type, "tool_use"); assert.equal(report.first.content.name, "wiki.lookup");
    assert.deepEqual(report.first.content.input, { query: "React" });
    assert.equal(report.second.content.type, "text"); assert.equal(report.second.content.text, "Found three React articles");
    assert.deepEqual(modelRequests[1]?.messages.at(-1), { role: "tool", tool_call_id: "http-call-1", content: "Server lookup found three React articles" });
  } finally {
    await connection?.close();
    if (child.exitCode === null) { child.kill(); await new Promise<void>((resolve) => { child.once("exit", () => resolve()); setTimeout(resolve, 1000).unref(); }); }
  }
}));

test("automatic model switching retries once on another installed local model", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "switch.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "model.autoSelect", true); config.set("global", "models.automaticSwitching", true);
  const attempts: string[] = [];
  const provider = {
    redact: (text: string) => text,
    models: async () => [
      { key: "unavailable-model", type: "llm", publisher: "test", size_bytes: 4_000_000_000, loaded_instances: [], max_context_length: 8192, capabilities: { trained_for_tool_use: true } },
      { key: "fallback-model", type: "llm", publisher: "test", size_bytes: 4_000_000_000, loaded_instances: [], max_context_length: 8192, capabilities: { trained_for_tool_use: true } }
    ],
    streamChatWithTools: async ({ model }: { model: string }) => { attempts.push(model); if (model === "unavailable-model") throw new Error("model unavailable"); return { choices: [{ message: { role: "assistant", content: "completed with fallback" } }] }; }
  };
  const runner = new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never });
  const result = await runner.run("Do a small task", { workspace: root, model: "unavailable-model", automaticModelAssignment: true });
  assert.deepEqual(attempts, ["unavailable-model", "unavailable-model", "unavailable-model", "fallback-model"]);
  assert.equal(result.model, "fallback-model"); assert.equal(result.response, "completed with fallback");
  const decision = store.db.prepare("SELECT model,reason FROM model_decisions ORDER BY created_at DESC LIMIT 1").get() as { model: string; reason: string };
  assert.equal(decision.model, "fallback-model"); assert.match(decision.reason, /switched after local inference failed/);
  const selection = store.db.prepare("SELECT considered_json FROM model_decisions ORDER BY created_at DESC LIMIT 1").get() as { considered_json: string };
  assert.equal(JSON.parse(selection.considered_json).selectionSource, "automatic_resource_aware");
  const observations = store.db.prepare("SELECT model,duration_ms,details_json FROM usage ORDER BY rowid").all() as Array<{ model: string; duration_ms: number; details_json: string }>;
  assert.equal(observations.length, 2); assert.ok(observations.every((entry) => entry.duration_ms > 0));
  assert.deepEqual(observations.map((entry) => [entry.model, JSON.parse(entry.details_json).outcome]), [["unavailable-model", "failure"], ["fallback-model", "success"]]);
  assert.deepEqual(JSON.parse(observations[1]!.details_json), { outcome: "success", task_outcome: "unverified" }, "success metrics store no response or provider payload details");
  store.close();
}));

test("local inference telemetry can be disabled without recording performance rows", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "telemetry-disabled.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "telemetry.localMetrics", false);
  const provider = { redact: (text: string) => text, streamChatWithTools: async () => ({ choices: [{ message: { role: "assistant", content: "done" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }) };
  try {
    const runner = new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never });
    await runner.run("Do a task", { model: "explicit-model", workspace: root });
    assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM usage").get() as { count: number }).count, 0);
  } finally { store.close(); }
}));

test("remote LM Studio inference is excluded from local performance metrics", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "telemetry-remote.sqlite")); const config = new ConfigStore(store); const sessions = new SessionStore(store); const events = new RuntimeEvents();
  config.set("global", "telemetry.localMetrics", true);
  const provider = { isLocalServer: () => false, redact: (text: string) => text, streamChatWithTools: async () => ({ choices: [{ message: { role: "assistant", content: "done" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }) };
  try {
    const runner = new AgentRunner({ store, config, sessions, events, access: new AccessController(), provider: provider as never, github: {} as never });
    await runner.run("Do a task", { model: "remote-model", workspace: root });
    assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM usage").get() as { count: number }).count, 0);
  } finally { store.close(); }
}));

test("structured output uses LM Studio's JSON Schema response format", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const server = createServer((request, response) => {
    let body = ""; request.setEncoding("utf8"); request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => { requestBody = JSON.parse(body) as Record<string, unknown>; response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ choices: [{ message: { content: "{\\\"ok\\\":true}" } }] })); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const provider = new LMStudioProvider({ baseUrl: `http://127.0.0.1:${address.port}` });
    await provider.structuredOutput({ model: "test", messages: [{ role: "user", content: "Return JSON" }], schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } });
    assert.deepEqual(requestBody?.response_format, { type: "json_schema", json_schema: { name: "xyst_response", strict: true, schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } } });
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("LM Studio response redaction preserves JSON when generated text contains token-like wording", async () => {
  const responseBody = { model_instance_id: "test-instance", output: [{ type: "message", content: "Token: LM_LIVE_OK" }], stats: { input_tokens: 5, total_output_tokens: 3 } };
  const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(responseBody)); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const provider = new LMStudioProvider({ baseUrl: `http://127.0.0.1:${address.port}` });
    const result = await provider.chat({ model: "test-model", input: "Return the token" });
    assert.deepEqual(result.output, [{ type: "message", content: "Token: [REDACTED]" }]);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("LM Studio JSON request deadline aborts a stalled response body", async () => {
  let serverResponse: import("node:http").ServerResponse | undefined;
  const server = createServer((request, response) => { serverResponse = response; const status = request.url === "/v1/embeddings" ? 503 : 200; response.writeHead(status, { "content-type": "application/json" }); response.write(status === 503 ? "busy" : "{"); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const provider = new LMStudioProvider({ baseUrl: `http://127.0.0.1:${address.port}`, requestTimeoutMs: () => 30 });
    await assert.rejects(provider.models(), /timed out after 1 seconds/);
    await assert.rejects(provider.embeddings("test-model", "hello"), /timed out after 1 seconds/);
  } finally {
    serverResponse?.end(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("LM Studio tool stream deadline aborts a stalled SSE response", async () => {
  let serverResponse: import("node:http").ServerResponse | undefined;
  const server = createServer((_request, response) => { serverResponse = response; response.writeHead(200, { "content-type": "text/event-stream" }); response.write(": waiting\n\n"); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const provider = new LMStudioProvider({ baseUrl: `http://127.0.0.1:${address.port}` });
    await assert.rejects(provider.streamChatWithTools({ model: "test-model", messages: [], tools: [] }, undefined, undefined, 30), /timed out after 1 seconds/);
  } finally {
    serverResponse?.end(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("LM Studio tool streams parse tool calls and fail on server errors or empty completions", async () => {
  let mode: "tool" | "error" | "empty" = "tool";
  let requestBody: Record<string, unknown> | undefined;
  const server = createServer((request, response) => {
    let body = ""; request.setEncoding("utf8"); request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      requestBody = JSON.parse(body) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (mode === "error") response.end(`event: error\ndata: ${JSON.stringify({ type: "error", error: { message: "Invalid request: tool schema" } })}\n\n`);
      else if (mode === "empty") response.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      else response.end([
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "dummy_echo", arguments: '{"text":' } }] }, finish_reason: null }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ok"}' } }] }, finish_reason: "tool_calls" }] })}`,
        "data: [DONE]", ""
      ].join("\n\n"));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const provider = new LMStudioProvider({ baseUrl: `http://127.0.0.1:${address.port}` });
    const result = await provider.streamChatWithTools({ model: "test-model", messages: [{ role: "user", content: "Call dummy_echo" }], tools: [], reasoning_effort: "none" });
    assert.equal(requestBody?.reasoning_effort, "none");
    assert.deepEqual((result.choices as Array<{ message: { tool_calls: Array<{ function: { name: string; arguments: string } }> } }>)[0]?.message.tool_calls, [{ id: "call-1", type: "function", function: { name: "dummy_echo", arguments: '{"text":"ok"}' } }]);
    mode = "error";
    await assert.rejects(provider.streamChatWithTools({ model: "test-model", messages: [], tools: [] }), /Invalid request: tool schema/);
    mode = "empty";
    await assert.rejects(provider.streamChatWithTools({ model: "test-model", messages: [], tools: [] }), /empty completion without text or tool calls/);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("LM Studio chat forwards stateful response IDs without hiding the new response ID", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const echoedSecret = "native-mcp-credential-value";
  const server = createServer((request, response) => {
    let body = ""; request.setEncoding("utf8"); request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => { requestBody = JSON.parse(body) as Record<string, unknown>; response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ response_id: "resp_next", output: [{ type: "message", content: echoedSecret }] })); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const provider = new LMStudioProvider({ baseUrl: `http://127.0.0.1:${address.port}` });
    provider.rememberSecretValues([echoedSecret]);
    const integration = { type: "ephemeral_mcp", server_label: "search", server_url: "https://mcp.example.test/mcp", allowed_tools: ["lookup"] };
    const result = await provider.chat({ model: "test-model", input: "Continue", previous_response_id: "resp_previous", min_p: 0.08, reasoning: "high", top_k: 40, repeat_penalty: 1.1, integrations: [integration] });
    assert.equal(requestBody?.previous_response_id, "resp_previous");
    assert.equal(requestBody?.store, true);
    assert.equal(requestBody?.min_p, 0.08);
    assert.equal(requestBody?.reasoning, "high");
    assert.equal(requestBody?.top_k, 40);
    assert.equal(requestBody?.repeat_penalty, 1.1);
    assert.deepEqual(requestBody?.integrations, [integration]);
    assert.equal(result.response_id, "resp_next");
    assert.equal(((result.output as Array<{ content: string }>)[0])?.content, "[REDACTED]");
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("LM Studio Responses API preserves response state fields and redacts response content", async () => {
  let requestBody: Record<string, unknown> | undefined; let authorization = ""; let failWithEchoedSecret = false;
  const secret = "responses-fixture-secret-value";
  const server = createServer((request, response) => {
    let body = ""; authorization = String(request.headers.authorization ?? ""); request.setEncoding("utf8"); request.on("data", (chunk: string) => body += chunk);
    request.on("end", () => { requestBody = JSON.parse(body) as Record<string, unknown>; if (failWithEchoedSecret) { response.writeHead(500, { "content-type": "text/plain" }); response.end(`Upstream echoed ${secret}`); return; } response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ id: "resp_next", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: secret }] }] })); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const provider = new LMStudioProvider({ baseUrl: `http://127.0.0.1:${address.port}`, token: () => "fixture-api-token" });
    provider.rememberSecretValues([secret]);
    const tools = [{ type: "function", name: "lookup", parameters: { type: "object", properties: {}, additionalProperties: false } }];
    const result = await provider.responses({ model: "test-model", input: "Continue", previous_response_id: "resp_previous", reasoning: { effort: "high" }, tools });
    assert.equal(requestBody?.model, "test-model"); assert.equal(requestBody?.input, "Continue");
    assert.equal(requestBody?.previous_response_id, "resp_previous"); assert.deepEqual(requestBody?.reasoning, { effort: "high" });
    assert.deepEqual(requestBody?.tools, tools); assert.equal(requestBody?.stream, false); assert.equal(authorization, "Bearer fixture-api-token");
    assert.equal(result.id, "resp_next");
    assert.deepEqual(((result.output as Array<{ content: Array<{ text: string }> }>)[0]!.content)[0]!.text, "[REDACTED]");
    await assert.rejects(provider.responses({ model: " ", input: "bad" }), /model key is required/);
    failWithEchoedSecret = true;
    await assert.rejects(provider.responses({ model: "test-model", input: "Fail safely" }), (error: unknown) => { assert.match(String(error), /\[REDACTED\]/); assert.equal(String(error).includes(secret), false); return true; });
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("LM Studio Responses API streaming emits named events and ends on response completion", async () => {
  let requestBody: Record<string, unknown> | undefined; let truncate = false;
  const server = createServer((request, response) => {
    let body = ""; request.setEncoding("utf8"); request.on("data", (chunk: string) => body += chunk);
    request.on("end", () => {
      requestBody = JSON.parse(body) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (truncate) { response.end(`event: response.created\r\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_stream" } })}\r\n\r\n`); return; }
      response.end([
        `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_stream" } })}`,
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
        `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_stream", status: "completed" } })}`,
        ""
      ].join("\r\n\r\n"));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const provider = new LMStudioProvider({ baseUrl: `http://127.0.0.1:${address.port}` });
    const events = [];
    for await (const event of provider.streamResponses({ model: "test-model", input: "Hello" })) events.push(event);
    assert.equal(requestBody?.stream, true); assert.equal(requestBody?.model, "test-model");
    assert.deepEqual(events.map((event) => event.type), ["response.created", "response.output_text.delta", "response.completed"]);
    assert.equal(events[1]?.delta, "Hello");
    truncate = true;
    await assert.rejects(async () => { for await (const _event of provider.streamResponses({ model: "test-model", input: "Hello" })) { /* drain to the terminal check */ } }, /ended before response.completed or response.incomplete/);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("LM Studio native streaming chat forwards MCP integrations and tool-call events", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const server = createServer((request, response) => {
    let body = ""; request.setEncoding("utf8"); request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      requestBody = JSON.parse(body) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "text/event-stream" });
      const events = [
        { type: "chat.start" },
        { type: "tool_call.start", tool: "lookup", provider_info: { type: "ephemeral_mcp", server_label: "search" } },
        { type: "tool_call.success", tool: "lookup", output: "found one result", provider_info: { type: "ephemeral_mcp", server_label: "search" } },
        { type: "message.delta", content: "Found it." },
        { type: "chat.end", result: { output: [{ type: "message", content: "Found it." }] } }
      ];
      response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const provider = new LMStudioProvider({ baseUrl: `http://127.0.0.1:${address.port}` });
    const integration = { type: "ephemeral_mcp", server_label: "search", server_url: "https://mcp.example.test/mcp", allowed_tools: ["lookup"] };
    const events = [];
    for await (const event of provider.streamChat({ model: "test-model", input: "Search now", integrations: [integration] })) events.push(event);
    assert.deepEqual(requestBody?.integrations, [integration]);
    assert.deepEqual(events.map((event) => event.type), ["chat.start", "tool_call.start", "tool_call.success", "message.delta", "chat.end"]);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("LM Studio tokenization uses the authenticated SDK handle and returns bounded results", async () => {
  const calls: unknown[] = [];
  const provider = new LMStudioProvider({
    baseUrl: "https://lm.example.test:1234/",
    token: () => "test-token",
    tokenizeFn: async (options) => {
      const { signal: _signal, ...request } = options; calls.push(request);
      return { model: options.model, count: 3, ...(options.includeTokenIds ? { tokenIds: [11, 22, 33] } : {}) };
    }
  });
  assert.deepEqual(await provider.tokenize("publisher/model", "hello world"), { model: "publisher/model", count: 3 });
  assert.deepEqual(await provider.tokenize("publisher/model", "hello world", { includeTokenIds: true }), { model: "publisher/model", count: 3, tokenIds: [11, 22, 33] });
  assert.deepEqual(calls, [
    { model: "publisher/model", text: "hello world", baseUrl: "https://lm.example.test:1234", token: "test-token", includeTokenIds: false },
    { model: "publisher/model", text: "hello world", baseUrl: "https://lm.example.test:1234", token: "test-token", includeTokenIds: true }
  ]);
  await assert.rejects(provider.tokenize("publisher/model", "x".repeat(1_000_001)), /limited to 1 MB/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(provider.tokenize("publisher/model", "hello", { signal: controller.signal }), /cancelled/);
});

test("LM Studio REST loads request and return the applied model configuration", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const server = createServer((request, response) => {
    let body = ""; request.setEncoding("utf8"); request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => { requestBody = JSON.parse(body) as Record<string, unknown>; response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ status: "loaded", load_config: { context_length: 8192, flash_attention: true } })); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const provider = new LMStudioProvider({ baseUrl: `http://127.0.0.1:${address.port}` });
    const result = await provider.load("publisher/model", { context_length: 8192, flash_attention: true });
    assert.equal(requestBody?.echo_load_config, true);
    assert.equal(requestBody?.context_length, 8192);
    assert.deepEqual(result.load_config, { context_length: 8192, flash_attention: true });
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("LM Studio GPU layer offload uses its documented CLI and rejects mixed load settings", async () => {
  let captured: { command: string; args: string[] } | undefined;
  let streams = { stdout: "Model loaded", stderr: "" };
  const commandRunner = async (command: string, args: string[]) => {
    captured = { command, args }; return { code: 0, signal: null, ...streams, durationMs: 2 };
  };
  const provider = new LMStudioProvider({ baseUrl: "http://127.0.0.1:1234", commandRunner });
  const result = await provider.load("publisher/model", { gpu_offload: 0.5, context_length: 8192 });
  assert.deepEqual(captured?.args, ["load", "publisher/model", "--gpu=0.5", "--context-length=8192"]);
  assert.equal(result.source, "lms CLI");
  const speculative = await provider.load("publisher/model", { draft_model: "publisher/draft", speculative_draft_max_tokens: 8, speculative_draft_min_tokens: 2, speculative_draft_min_continue_probability: 0.4 });
  assert.deepEqual(captured?.args, ["load", "publisher/model", "--speculative-draft-simple", "--speculative-draft-model", "publisher/draft", "--speculative-draft-max-tokens", "8", "--speculative-draft-min-tokens", "2", "--speculative-draft-min-continue-probability", "0.4"]);
  assert.equal(speculative.draft_model, "publisher/draft");
  await provider.load("publisher/model", { speculative_draft_mtp: true });
  assert.deepEqual(captured?.args, ["load", "publisher/model", "--speculative-draft-mtp"]);
  await provider.load("publisher/model", { ttl_seconds: 900, context_length: 4096 });
  assert.deepEqual(captured?.args, ["load", "publisher/model", "--context-length=4096", "--ttl", "900"]);
  streams = { stdout: "", stderr: "Estimated GPU Memory: 1024 MiB" };
  const estimate = await provider.estimateLoad("publisher/model", { context_length: 8192, gpu_offload: "max" });
  assert.deepEqual(captured?.args, ["load", "publisher/model", "--estimate-only", "--yes", "--context-length", "8192", "--gpu", "max"]);
  assert.deepEqual(estimate, { model: "publisher/model", estimated: true, source: "lms CLI --estimate-only", output: "Estimated GPU Memory: 1024 MiB" });
  await assert.rejects(() => provider.load("publisher/model", { gpu_offload: "max", flash_attention: true }), /separately from REST-only settings/);
  await assert.rejects(() => provider.load("publisher/model", { ttl_seconds: 0 }), /positive integer/);
  await assert.rejects(() => provider.load("publisher/model", { draft_model: "publisher/draft", speculative_draft_mtp: true }), /Choose either/);
  const remote = new LMStudioProvider({ baseUrl: "http://192.168.1.20:1234", commandRunner });
  await assert.rejects(() => remote.load("publisher/model", { gpu_offload: "max" }), /default local LM Studio server on port 1234/);
  await assert.rejects(() => remote.estimateLoad("publisher/model"), /only for the default local LM Studio server/);
  const customPort = new LMStudioProvider({ baseUrl: "http://127.0.0.1:4321", commandRunner });
  assert.equal(customPort.isLocalServer(), true); assert.equal(customPort.supportsLocalCliModelLifecycle(), false);
  await assert.rejects(() => customPort.load("publisher/model", { ttl_seconds: 900 }), /default local LM Studio server on port 1234/);
  await assert.rejects(() => customPort.estimateLoad("publisher/model"), /default local LM Studio server on port 1234/);
});

test("office tools create valid DOCX, XLSX, CSV, PDF, and PPTX files without overwriting", async () => withTemp(async (root) => {
  const office = createOfficeTools(new AccessController(), root); const call = (args: Record<string, unknown>) => office.office_create!.execute(args);
  const doc = await call({ format: "docx", path: "report.docx", title: "Report", content: "First paragraph\nSecond paragraph" }) as { sizeBytes: number };
  const docZip = await JSZip.loadAsync(await readFile(join(root, "report.docx"))); assert.ok(doc.sizeBytes > 500); assert.ok(docZip.file("word/document.xml"));
  let documentXml = await docZip.file("word/document.xml")!.async("string");
  documentXml = documentXml.replace("First paragraph", "First</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t xml:space=\"preserve\"> paragraph");
  assert.ok(documentXml.includes("First</w:t></w:r><w:r><w:rPr><w:i/"), "test document splits the target phrase across runs");
  docZip.file("word/document.xml", documentXml); await writeFile(join(root, "report.docx"), await docZip.generateAsync({ type: "nodebuffer" }));
  const docxRead = await office.office_read!.execute({ format: "docx", path: "report.docx" }) as { sha256: string; text: string; trust: string };
  assert.match(docxRead.text, /First paragraph/); assert.equal(docxRead.trust, "untrusted-file-content");
  const docxEdit = await office.office_edit!.execute({ format: "docx", path: "report.docx", expected_sha256: docxRead.sha256, find_text: "First paragraph", replace_text: "Updated paragraph" }) as { sha256: string; replacements: number };
  assert.equal(docxEdit.replacements, 1); const editedDocx = await JSZip.loadAsync(await readFile(join(root, "report.docx")));
  const editedXml = await editedDocx.file("word/document.xml")!.async("string"); assert.match(editedXml, /Updated paragraph/); assert.match(editedXml, /<w:i\/>/);
  await assert.rejects(() => office.office_edit!.execute({ format: "docx", path: "report.docx", expected_sha256: docxRead.sha256, find_text: "Updated paragraph", replace_text: "Stale edit" }), /changed since it was read/);
  await call({ format: "docx", path: "duplicate.docx", title: "Duplicate", content: "repeat phrase\nrepeat phrase" });
  const duplicate = await office.office_read!.execute({ format: "docx", path: "duplicate.docx" }) as { sha256: string };
  await assert.rejects(() => office.office_edit!.execute({ format: "docx", path: "duplicate.docx", expected_sha256: duplicate.sha256, find_text: "repeat phrase", replace_text: "unique phrase" }), /more than once/);
  const calculated = await call({ format: "xlsx", path: "calculated.xlsx", title: "Calc", rows: [["Input", "Double", "Total"], [2, "=A2*2", "=SUM(A2:B2)"]] }) as { recalculation: { status: string; formulas: number; errors: number } };
  assert.equal(calculated.recalculation.status, "success"); assert.equal(calculated.recalculation.formulas, 2); assert.equal(calculated.recalculation.errors, 0);
  const calculatedRead = await office.office_read!.execute({ format: "xlsx", path: "calculated.xlsx" }) as { sha256: string; rows: Array<{ cells: Array<{ cell: string; value: string; cached_value?: string }> }> };
  assert.ok(calculatedRead.rows.some((row) => row.cells.some((cell) => cell.cell === "B2" && cell.value === "=A2*2" && cell.cached_value === "4")));
  assert.ok(calculatedRead.rows.some((row) => row.cells.some((cell) => cell.cell === "C2" && cell.value === "=SUM(A2:B2)" && cell.cached_value === "6")));
  const formulaEdit = await office.office_edit!.execute({ format: "xlsx", path: "calculated.xlsx", expected_sha256: calculatedRead.sha256, operation: "set_formula", cell: "B2", formula: "=A2*3" }) as { recalculation: { status: string } };
  assert.equal(formulaEdit.recalculation.status, "success");
  const editedCalculated = await office.office_read!.execute({ format: "xlsx", path: "calculated.xlsx" }) as { rows: Array<{ cells: Array<{ cell: string; value: string; cached_value?: string }> }> };
  assert.ok(editedCalculated.rows.some((row) => row.cells.some((cell) => cell.cell === "B2" && cell.value === "=A2*3" && cell.cached_value === "6")));
  assert.ok(editedCalculated.rows.some((row) => row.cells.some((cell) => cell.cell === "C2" && cell.value === "=SUM(A2:B2)" && cell.cached_value === "8")));
  const unsupported = await call({ format: "xlsx", path: "unsupported.xlsx", title: "Unsupported", rows: [["Value", "Result"], [1, "=XYST_NOPE(1)"]] }) as { recalculation: { status: string; unknownFunctions: Array<{ name: string; cells: number }> } };
  assert.equal(unsupported.recalculation.status, "errors_found"); assert.ok(unsupported.recalculation.unknownFunctions.some((entry) => entry.name === "XYST_NOPE" && entry.cells === 1));
  const sheet = await call({ format: "xlsx", path: "data.xlsx", title: "Data & notes", rows: [["Name", "Value"], ["Example", "A&B"]] }) as { sizeBytes: number };
  const xlsx = await JSZip.loadAsync(await readFile(join(root, "data.xlsx"))); assert.ok(sheet.sizeBytes > 500);
  const workbookXml = await xlsx.file("xl/workbook.xml")!.async("string"); const sheetXml = await xlsx.file("xl/worksheets/sheet1.xml")!.async("string");
  assert.match(workbookXml, /Data &amp; notes/); assert.match(sheetXml, /A&amp;B/); assert.match(sheetXml, /state="frozen"/);
  const stylesBefore = await xlsx.file("xl/styles.xml")!.async("string");
  const sharedStringsSheet = sheetXml.replace('<c r="B2" t="inlineStr"><is><t xml:space="preserve">A&amp;B</t></is></c>', '<c r="B2" t="s"><v>0</v></c>');
  assert.notEqual(sharedStringsSheet, sheetXml, "test workbook stores a cell in the shared string table");
  xlsx.file("xl/worksheets/sheet1.xml", sharedStringsSheet);
  xlsx.file("xl/sharedStrings.xml", '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><t>A&amp;B</t></si></sst>');
  const workbookRels = await xlsx.file("xl/_rels/workbook.xml.rels")!.async("string");
  xlsx.file("xl/_rels/workbook.xml.rels", workbookRels.replace("</Relationships>", '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>'));
  const contentTypes = await xlsx.file("[Content_Types].xml")!.async("string");
  xlsx.file("[Content_Types].xml", contentTypes.replace("</Types>", '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>'));
  await writeFile(join(root, "data.xlsx"), await xlsx.generateAsync({ type: "nodebuffer" }));
  const xlsxRead = await office.office_read!.execute({ format: "xlsx", path: "data.xlsx" }) as { sha256: string; sheet: string; rows: Array<{ row: number; cells: Array<{ cell: string; value: string; cached_value?: string }> }> };
  assert.equal(xlsxRead.sheet, "Data & notes"); assert.ok(xlsxRead.rows[1]?.cells.some((cell) => cell.cell === "B2" && cell.value === "A&B"));
  const appended = await office.office_edit!.execute({ format: "xlsx", path: "data.xlsx", expected_sha256: xlsxRead.sha256, operation: "append_rows", rows: [["Added", "10"]] }) as { affected: string[] };
  assert.deepEqual(appended.affected, ["A3:B3"]);
  const appendedRead = await office.office_read!.execute({ format: "xlsx", path: "data.xlsx" }) as { sha256: string; rows: Array<{ row: number; cells: Array<{ cell: string; value: string }> }> };
  assert.ok(appendedRead.rows.some((row) => row.row === 3 && row.cells.some((cell) => cell.cell === "A3" && cell.value === "Added")));
  await office.office_edit!.execute({ format: "xlsx", path: "data.xlsx", expected_sha256: appendedRead.sha256, operation: "set_cell", cell: "B3", value: "11" });
  let editedBook = await JSZip.loadAsync(await readFile(join(root, "data.xlsx"))); let editedSheet = await editedBook.file("xl/worksheets/sheet1.xml")!.async("string");
  assert.match(editedSheet, /<c r="B3" t="inlineStr"><is><t xml:space="preserve">11<\/t>/);
  assert.equal(await editedBook.file("xl/styles.xml")!.async("string"), stylesBefore, "editing a sheet preserves other workbook parts");
  editedSheet = editedSheet.replace("</sheetData>", "<row r=\"4\"><c r=\"C4\"><f>1+1</f><v>2</v></c></row></sheetData>").replace("</worksheet>", "<mergeCells count=\"1\"><mergeCell ref=\"A3:B3\"/></mergeCells></worksheet>");
  editedBook.file("xl/worksheets/sheet1.xml", editedSheet); await writeFile(join(root, "data.xlsx"), await editedBook.generateAsync({ type: "nodebuffer" }));
  const formulaRead = await office.office_read!.execute({ format: "xlsx", path: "data.xlsx" }) as { sha256: string; rows: Array<{ cells: Array<{ cell: string; value: string; formula?: string; cached_value?: string }> }> };
  assert.ok(formulaRead.rows.some((row) => row.cells.some((cell) => cell.cell === "C4" && cell.value === "=1+1" && cell.formula === "=1+1" && cell.cached_value === "2")));
  await assert.rejects(() => office.office_edit!.execute({ format: "xlsx", path: "data.xlsx", expected_sha256: formulaRead.sha256, operation: "set_cell", cell: "C4", value: "replace formula" }), /contains a formula/);
  await assert.rejects(() => office.office_edit!.execute({ format: "xlsx", path: "data.xlsx", expected_sha256: formulaRead.sha256, operation: "set_cell", cell: "B3", value: "edit merged follower" }), /belongs to merged range/);
  await office.office_edit!.execute({ format: "xlsx", path: "data.xlsx", expected_sha256: formulaRead.sha256, operation: "set_cell", cell: "A3", value: "merged anchor edit" });
  await assert.rejects(() => office.office_edit!.execute({ format: "xlsx", path: "data.xlsx", expected_sha256: xlsxRead.sha256, operation: "set_cell", cell: "B3", value: "stale" }), /changed since it was read/);
  await call({ format: "csv", path: "data.csv", title: "CSV", rows: [["Value"], ["comma, and \"quote\""]] });
  assert.match(await readFile(join(root, "data.csv"), "utf8"), /"comma, and ""quote"""/);
  await writeFile(join(root, "complex.csv"), '\uFEFFName,Note\r\nAda,"comma, and ""quote"""\r\nGrace,"two\nlines"\r\n');
  const csvRead = await office.office_read!.execute({ format: "csv", path: "complex.csv" }) as { sha256: string; rows: Array<{ row: number; cells: Array<{ cell: string; value: string }> }>; trust: string };
  assert.equal(csvRead.trust, "untrusted-file-content"); assert.equal(csvRead.rows[1]?.cells[1]?.value, 'comma, and "quote"'); assert.equal(csvRead.rows[2]?.cells[1]?.value, "two\nlines");
  await writeFile(join(root, "bad.csv"), 'ok,"unterminated');
  await assert.rejects(() => office.office_read!.execute({ format: "csv", path: "bad.csv" }), /unterminated quoted field/);
  await call({ format: "pdf", path: "report.pdf", title: "Report", content: "PDF body" });
  const pdf = await PDFDocument.load(await readFile(join(root, "report.pdf"))); assert.equal(pdf.getPageCount(), 1);
  const pdfRead = await office.office_read!.execute({ format: "pdf", path: "report.pdf" }) as { sha256: string; pages: Array<{ page: number; text: string }> };
  assert.equal(pdfRead.pages[0]?.page, 1); assert.match(pdfRead.pages[0]?.text ?? "", /Report[\s\S]*PDF body/);
  const preview = await office.office_preview!.execute({ path: "report.pdf", page: 1, output_path: "previews/report-page-1.png" }) as { path: string; sha256: string; width: number; height: number; page_count: number; mime_type: string };
  const previewBytes = await readFile(join(root, "previews/report-page-1.png"));
  assert.equal(preview.path, join(root, "previews/report-page-1.png")); assert.match(preview.sha256, /^[a-f0-9]{64}$/); assert.equal(preview.page_count, 1); assert.ok(preview.width > 0 && preview.height > 0); assert.equal(preview.mime_type, "image/png");
  assert.deepEqual([...previewBytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "PDF page preview is a valid PNG");
  await assert.rejects(() => office.office_preview!.execute({ path: "report.pdf", page: 1, output_path: "previews/report-page-1.png" }));
  await assert.rejects(() => office.office_preview!.execute({ path: "report.pdf", page: 2, output_path: "previews/missing-page.png" }), /does not exist/);
  await office.office_edit!.execute({ format: "pdf", path: "report.pdf", expected_sha256: pdfRead.sha256, operation: "append_text", page: 1, text: "Reviewed" });
  const editedPdfRead = await office.office_read!.execute({ format: "pdf", path: "report.pdf" }) as { sha256: string; pages: Array<{ text: string }> };
  assert.match(editedPdfRead.pages[0]?.text ?? "", /Reviewed/);
  await assert.rejects(() => office.office_edit!.execute({ format: "pdf", path: "report.pdf", expected_sha256: pdfRead.sha256, operation: "append_text", page: 1, text: "Stale" }), /changed since it was read/);
  const scanCanvas = createCanvas(1800, 480); const scanContext = scanCanvas.getContext("2d"); scanContext.fillStyle = "white"; scanContext.fillRect(0, 0, 1800, 480); scanContext.fillStyle = "black"; scanContext.font = "bold 88px sans-serif"; scanContext.fillText("SCANNED XYST OCR CHECK", 80, 270);
  const scannedPdf = await PDFDocument.create(); const scannedPage = scannedPdf.addPage([612, 163]); const scannedImage = await scannedPdf.embedPng(scanCanvas.toBuffer("image/png")); scannedPage.drawImage(scannedImage, { x: 0, y: 0, width: 612, height: 163 });
  const scannedBytes = await scannedPdf.save(); await writeFile(join(root, "scanned.pdf"), scannedBytes);
  const scannedRead = await office.office_read!.execute({ format: "pdf", path: "scanned.pdf" }) as { pages: Array<{ text: string; method: string }>; ocrPages: number };
  assert.equal(scannedRead.pages[0]?.method, "ocr"); assert.ok(scannedRead.ocrPages > 0); assert.match(scannedRead.pages[0]?.text ?? "", /SCANNED XYST OCR CHECK/i);
  const scannedAttachment = await extractPdfAttachmentText(scannedBytes);
  assert.match(scannedAttachment.text, /SCANNED XYST OCR CHECK/i); assert.equal(scannedAttachment.ocrPages, 1);
  const multilingualAttachment = await extractPdfAttachmentText(scannedBytes, 30_000, ["eng", "fra"]);
  assert.match(multilingualAttachment.text, /SCANNED XYST OCR CHECK/i); assert.deepEqual(multilingualAttachment.ocrLanguages, ["eng", "fra"]);
  const frenchCanvas = createCanvas(1800, 480); const frenchContext = frenchCanvas.getContext("2d"); frenchContext.fillStyle = "white"; frenchContext.fillRect(0, 0, 1800, 480); frenchContext.fillStyle = "black"; frenchContext.font = "bold 88px sans-serif"; frenchContext.fillText("ÉLÈVE ÉTUDIE EN ÉTÉ", 80, 270);
  const frenchPdf = await PDFDocument.create(); const frenchPage = frenchPdf.addPage([612, 163]); const frenchImage = await frenchPdf.embedPng(frenchCanvas.toBuffer("image/png")); frenchPage.drawImage(frenchImage, { x: 0, y: 0, width: 612, height: 163 });
  const frenchAttachment = await extractPdfAttachmentText(await frenchPdf.save(), 30_000, ["fra"]);
  assert.match(frenchAttachment.text, /ÉLÈVE ÉTUDIE EN ÉTÉ/); assert.deepEqual(frenchAttachment.ocrLanguages, ["fra"]);
  await call({ format: "pptx", path: "slides.pptx", title: "Deck", slides: [{ title: "First", body: "Slide body" }] });
  const deck = await JSZip.loadAsync(await readFile(join(root, "slides.pptx"))); assert.ok(deck.file("ppt/slides/slide1.xml"));
  const presentationBefore = await deck.file("ppt/presentation.xml")!.async("string");
  const deckRead = await office.office_read!.execute({ format: "pptx", path: "slides.pptx" }) as { sha256: string; slides: Array<{ slide: number; text: string }> };
  assert.equal(deckRead.slides[0]?.slide, 1); assert.match(deckRead.slides[0]?.text ?? "", /First[\s\S]*Slide body/);
  const deckEdit = await office.office_edit!.execute({ format: "pptx", path: "slides.pptx", expected_sha256: deckRead.sha256, find_text: "Slide body", replace_text: "Updated body" }) as { replacements: number; slide: number };
  assert.equal(deckEdit.replacements, 1); assert.equal(deckEdit.slide, 1);
  const editedDeck = await JSZip.loadAsync(await readFile(join(root, "slides.pptx")));
  assert.equal(await editedDeck.file("ppt/presentation.xml")!.async("string"), presentationBefore, "PPTX edit preserves other package parts");
  const editedDeckRead = await office.office_read!.execute({ format: "pptx", path: "slides.pptx" }) as { sha256: string; slides: Array<{ text: string }> };
  assert.match(editedDeckRead.slides[0]?.text ?? "", /Updated body/);
  await assert.rejects(() => office.office_edit!.execute({ format: "pptx", path: "slides.pptx", expected_sha256: deckRead.sha256, find_text: "Updated body", replace_text: "Stale" }), /changed since it was read/);
  await assert.rejects(() => call({ format: "csv", path: "report.docx", title: "Mismatch", rows: [["x"]] }), /must end in/);
  await assert.rejects(() => call({ format: "csv", path: "data.csv", title: "Overwrite", rows: [["x"]] }));
}));

test("office DOCX and PDF creation removes a matching leading title by default and can preserve an explicit repeat", async () => withTemp(async (root) => {
  const office = createOfficeTools(new AccessController(), root);
  for (const format of ["docx", "pdf"] as const) {
    const path = `brief.${format}`;
    await office.office_create!.execute({ format, path, title: "Workshop Brief", content: "\nWorkshop Brief\n\nDate: October 28, 2026\nChecklist" });
    const normal = await office.office_read!.execute({ format, path }) as { text: string };
    assert.equal(normal.text.split("Workshop Brief").length - 1, 1, `${format} should render the title once`);
    assert.match(normal.text, /Date: October 28, 2026/);

    const repeatPath = `repeat.${format}`;
    await office.office_create!.execute({ format, path: repeatPath, title: "Workshop Brief", repeat_title: true, content: "Workshop Brief\n\nDate: October 28, 2026" });
    const repeated = await office.office_read!.execute({ format, path: repeatPath }) as { text: string };
    assert.equal(repeated.text.split("Workshop Brief").length - 1, 2, `${format} should keep an explicitly requested repeated title`);
  }
}));

test("office preview renders DOCX, XLSX, and PPTX through installed LibreOffice", async (context) => {
  const probe = await runProcess("soffice", ["--headless", "--version"], { timeoutMs: 15_000, maxOutputChars: 1000 }).catch(() => null);
  if (!probe || probe.code !== 0) { context.skip("LibreOffice soffice is not installed on this host"); return; }
  await withTemp(async (root) => {
    const office = createOfficeTools(new AccessController(), root, ["eng"], "soffice");
    await office.office_create!.execute({ format: "docx", path: "report.docx", title: "Layout preview", content: "A Word document with a visible heading and body." });
    await office.office_create!.execute({ format: "xlsx", path: "report.xlsx", title: "Workbook preview", rows: [["Item", "Count"], ["Pages", 3]] });
    await office.office_create!.execute({ format: "pptx", path: "report.pptx", title: "Presentation preview", slides: [{ title: "Rendered slide", body: "Slide body text" }] });
    for (const format of ["docx", "xlsx", "pptx"] as const) {
      const preview = await office.office_preview!.execute({ path: `report.${format}`, page: 1, output_path: `preview-${format}.png` }) as { source_format: string; page_count: number; mime_type: string };
      const bytes = await readFileAsync(join(root, `preview-${format}.png`));
      assert.equal(preview.source_format, format); assert.ok(preview.page_count >= 1); assert.equal(preview.mime_type, "image/png");
      assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    }
  });
});

test("memory is searchable, editable, deletable, and keeps inferred notes separate", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "memory.sqlite")); const memories = new MemoryStore(store); const tools = createMemoryTools(memories);
  const preference = memories.add("preference", "Use concise status summaries", "user request");
  const inferred = memories.add("inferred", "Usually works in TypeScript", "agent inference");
  assert.equal(memories.list().length, 2); assert.equal(memories.search("concise")[0]?.kind, "preference");
  assert.equal((await tools.memory_search!.execute({ query: "TypeScript" }) as Array<{ id: string }>)[0]?.id, inferred.id);
  await assert.rejects(() => tools.memory_add!.execute({ kind: "note", content: "api_key=secretvalue" }), /credential-like/);
  memories.setEmbedding(preference.id, "test-embed", [1, 0]); memories.setEmbedding(inferred.id, "test-embed", [0, 1]);
  assert.equal(memories.searchSemantic([0.9, 0.1], "test-embed")[0]?.id, preference.id);
  const embeddingProvider = { embeddings: async (_model: string, input: string | string[]) => ({ data: (Array.isArray(input) ? input : [input]).map((text, index) => ({ embedding: text.includes("TypeScript") ? [0, 1] : [1, 0], index })) }) };
  assert.deepEqual(await indexMemories(memories, embeddingProvider as never, "test-embed"), { indexed: 2, model: "test-embed" });
  assert.equal(memories.embeddings("test-embed").length, 2);
  const updated = memories.update(preference.id, "Keep concise progress updates"); assert.match(updated.content, /progress updates/);
  assert.equal(memories.embeddings("test-embed").length, 1);
  memories.delete(inferred.id); assert.equal(memories.list().length, 1); assert.throws(() => memories.delete(inferred.id), /not found/);
  assert.equal((store.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version, 15);
  store.close();
}));

test("mission lifecycle supports rename, safe fork, portable export, and guarded deletion", async () => withTemp(async (root) => {
  const store = new XystStore(join(root, "mission-lifecycle.sqlite"));
  try {
  const missions = new MissionRepository(store); const sessions = new SessionStore(store);
  const mission = missions.create({
    name: "Scheduled review", objective: "Review a repository change", workspace: root,
    agents: [{ id: "reviewer", name: "Reviewer" }],
    tasks: [{ id: "review", objective: "Review the change", dependsOn: [], agentId: "reviewer" }],
    schedule: { cron: "0 9 * * *", timezone: "UTC", enabled: true, missedRun: "skip" },
    github: { enabled: true, writeEnabled: true, mergeAuthorized: false },
    githubTrigger: { events: ["issues"], repositories: ["example/project"] },
  });
  assert.equal(missions.rename(mission.id, "Evening review").definition.name, "Evening review");
  const exported = missions.exportDefinition(mission.id);
  assert.equal("id" in exported, false);
  assert.equal(exported.name, "Evening review");
  assert.equal(exported.schedule?.enabled, true);
  const fork = missions.fork(mission.id, "Manual review copy");
  assert.notEqual(fork.id, mission.id);
  assert.equal(fork.definition.name, "Manual review copy");
  assert.equal(fork.definition.schedule?.enabled, false);
  assert.equal(fork.definition.githubTrigger, undefined);
  assert.deepEqual(fork.definition.github, mission.definition.github);

  const sessionId = sessions.create("Mission task history"); sessions.addMessage(sessionId, "assistant", "Review completed.");
  const runId = randomUUID(); const now = new Date().toISOString();
  store.db.prepare("INSERT INTO mission_runs(id,mission_id,state,trigger_type,started_at,heartbeat_at) VALUES(?,?,?,?,?,?)").run(runId, mission.id, "completed", "manual", now, now);
  store.db.prepare("INSERT INTO mission_tasks(run_id,mission_id,task_key,objective,dependencies_json,state,attempts,session_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(runId, mission.id, "review", "Review the change", "[]", "completed", 1, sessionId, now);
  store.db.prepare("INSERT INTO agents(id,mission_id,definition_json,status,created_at,updated_at) VALUES(?,?,?,'completed',?,?)").run("reviewer", mission.id, JSON.stringify({ id: "reviewer", name: "Reviewer" }), now, now);
  store.db.prepare("INSERT INTO settings(scope,scope_id,key,value_json,updated_at) VALUES('mission',?,'orchestration.maxConcurrency','2',?)").run(mission.id, now);
  store.db.prepare("INSERT INTO settings(scope,scope_id,key,value_json,updated_at) VALUES('agent','reviewer','model.default','\"local/test\"',?)").run(now);
  const jobId = randomUUID(); store.db.prepare("INSERT INTO jobs(id,session_id,mission_id,kind,state,details_json,created_at,updated_at) VALUES(?,?,?,'mission-run','completed','{}',?,?)").run(jobId, sessionId, mission.id, now, now);
  const queuedJobId = randomUUID(); store.db.prepare("INSERT INTO jobs(id,session_id,mission_id,kind,state,details_json,created_at,updated_at) VALUES(?,?,?,'github-trigger','queued','{}',?,?)").run(queuedJobId, null, mission.id, now, now);

  missions.delete(mission.id);
  assert.equal(missions.get(mission.id), undefined);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM mission_runs WHERE mission_id=?").get(mission.id) as { count: number }).count, 0);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM agents WHERE mission_id=?").get(mission.id) as { count: number }).count, 0);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM settings WHERE scope='mission' AND scope_id=?").get(mission.id) as { count: number }).count, 0);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM settings WHERE scope='agent' AND scope_id='reviewer'").get() as { count: number }).count, 0);
  assert.equal((store.db.prepare("SELECT mission_id FROM jobs WHERE id=?").get(jobId) as { mission_id: string | null }).mission_id, null);
  assert.deepEqual(store.db.prepare("SELECT mission_id,state FROM jobs WHERE id=?").get(queuedJobId), { mission_id: null, state: "cancelled" });
  assert.ok((sessions.list() as Array<{ id: string }>).some((item) => item.id === sessionId));
  assert.equal(sessions.messages(sessionId).length, 1);

  const running = missions.create({ name: "Running", objective: "Keep working" }); missions.setStatus(running.id, "running");
  assert.throws(() => missions.delete(running.id), /running mission/);
  const uncertain = missions.create({ name: "Needs reconciliation", objective: "Resolve external result" }); missions.setStatus(uncertain.id, "reconciliation_required");
  assert.throws(() => missions.delete(uncertain.id), /uncertain external action/);
  const runningJobMission = missions.create({ name: "Running job", objective: "Wait for trigger work" });
  const runningJobId = randomUUID(); store.db.prepare("INSERT INTO jobs(id,mission_id,kind,state,details_json,created_at,updated_at) VALUES(?,?,'github-trigger','running','{}',?,?)").run(runningJobId, runningJobMission.id, now, now);
  assert.throws(() => missions.delete(runningJobMission.id), /background jobs is running/);

  const worktree = missions.create({ name: "Retained worktree", objective: "Preserve workspace", workspace: root, tasks: [{ id: "work", objective: "Work", dependsOn: [], workspaceMode: "worktree" }] });
  const worktreeRunId = randomUUID();
  store.db.prepare("INSERT INTO mission_runs(id,mission_id,state,trigger_type,started_at,heartbeat_at) VALUES(?,?,?,?,?,?)").run(worktreeRunId, worktree.id, "completed", "manual", now, now);
  store.db.prepare("INSERT INTO mission_tasks(run_id,mission_id,task_key,objective,dependencies_json,state,attempts,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(worktreeRunId, worktree.id, "work", "Work", "[]", "completed", 1, now);
  store.db.prepare("INSERT INTO mission_workspaces(mission_id,run_id,task_key,mode,base_workspace,path,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(worktree.id, worktreeRunId, "work", "worktree", root, join(root, "retained-worktree"), "active", now, now);
  assert.throws(() => missions.delete(worktree.id), /worktree/);
  assert.ok(missions.get(worktree.id));
  } finally { store.close(); }
}));
