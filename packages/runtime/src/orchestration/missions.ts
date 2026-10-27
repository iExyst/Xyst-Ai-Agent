import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { Cron } from "croner";
import { z } from "zod";
import type { RuntimeEvents } from "../events.js";
import type { AgentRunner, ExternalActionApprovalRequest } from "../agent.js";
import { redactSecrets } from "../credentials.js";
import type { GitHubProvider } from "../integrations/github.js";
import type { ConfigStore, XystStore } from "../storage.js";
import { AccessController, type AccessProfile } from "../access.js";
import { runProcess } from "../platform.js";
import { freemem, totalmem } from "node:os";
import type { LMStudioProvider } from "../providers/lm-studio.js";
import { planResourceAwareBatch, type ResourceTaskAssignment, type ResourceTaskCandidate } from "./resource-scheduler.js";
import { readModelPerformance } from "../model-performance.js";
import { classifyModelTaskObjective } from "../model-task-type.js";
import { chooseAgentModel, estimateRequiredContextTokens, modelLoadContextLength } from "../model-selection.js";
import { parseLmStudioResourceEstimate, readHostResourceStats } from "../system-resources.js";

const profileSchema = z.object({ mode: z.enum(["full", "restricted"]), readRoots: z.array(z.string()).optional(), writeRoots: z.array(z.string()).optional(), allowedExecutables: z.array(z.string()).optional(), network: z.boolean().optional(), integrations: z.boolean().optional(), backgroundJobs: z.boolean().optional(), externalActions: z.boolean().optional() }).strict();
const agentSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/), name: z.string().min(1).max(100), model: z.string().optional(), maxTurns: z.number().int().min(1).max(50).optional(), access: profileSchema.optional() }).strict();
const requiredToolEvidenceSchema = z.object({ tool: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), exitCode: z.number().int().optional(), stdoutEquals: z.string().max(30000).optional(), stdoutIncludes: z.string().max(30000).optional(), path: z.string().max(500).optional(), textEquals: z.string().max(30000).optional(), textIncludes: z.string().max(30000).optional(), normalizeNewlines: z.boolean().optional() }).strict().refine((value) => {
  const hasProcessAssertion = value.exitCode !== undefined || value.stdoutEquals !== undefined || value.stdoutIncludes !== undefined;
  const hasFileAssertion = value.tool === "file_read" && value.path !== undefined && (value.textEquals !== undefined || value.textIncludes !== undefined);
  return hasProcessAssertion || hasFileAssertion;
}, "Tool evidence must include a process result assertion or a file_read path and content assertion");
const taskSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(), name: z.string().min(1).max(100).optional(), objective: z.string().min(1), dependsOn: z.array(z.string()).default([]), agentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(), expectedOutputs: z.array(z.string().min(1).max(500)).max(20).optional(), completionCriteria: z.string().max(4000).optional(), requiredToolEvidence: z.array(requiredToolEvidenceSchema).max(10).optional(), maxTurns: z.number().int().min(1).max(50).optional(), model: z.string().optional(), workspace: z.string().optional(), workspaceMode: z.enum(["shared", "worktree"]).default("shared"), workspaceFrom: z.string().optional(), maxRetries: z.number().int().min(0).max(5).optional() }).strict();
const scheduleSchema = z.object({ cron: z.string().min(1), timezone: z.string().default("UTC"), enabled: z.boolean().default(true), missedRun: z.enum(["skip", "run_once"]).default("skip") }).strict();
const definitionSchema = z.object({ id: z.string().optional(), name: z.string().min(1).max(100), objective: z.string().min(1), workspace: z.string().optional(), worktreeRoot: z.string().optional(), projectId: z.string().optional(), model: z.string().optional(), agents: z.array(agentSchema).max(8).optional(), tasks: z.array(taskSchema).min(1).max(100).optional(), maxRetries: z.number().int().min(0).max(5).default(1), maxConcurrency: z.number().int().min(1).max(8).default(1), schedule: scheduleSchema.optional(), github: z.object({ enabled: z.boolean().optional(), writeEnabled: z.boolean().optional(), mergeAuthorized: z.boolean().optional() }).optional(), githubTrigger: z.object({ events: z.array(z.enum(["issues", "issue_comment", "pull_request", "pull_request_review"])).default(["issues"]), repositories: z.array(z.string()).optional() }).optional() }).strict();

function declaredFileOutputPaths(outputs: string[] | undefined, workspace: string): string[] {
  return (outputs ?? []).filter((output) => isAbsolute(output) || /[\\/]/.test(output) || /\.[^./\\]{1,16}$/.test(output)).map((output) => resolve(workspace, output));
}

export interface MissionAgentDefinition { id: string; name: string; model?: string; maxTurns?: number; access?: AccessProfile }
export interface MissionTaskDefinition { id?: string; name?: string; objective: string; dependsOn: string[]; agentId?: string; expectedOutputs?: string[]; completionCriteria?: string; requiredToolEvidence?: Array<{ tool: string; exitCode?: number; stdoutEquals?: string; stdoutIncludes?: string; path?: string; textEquals?: string; textIncludes?: string; normalizeNewlines?: boolean }>; maxTurns?: number; model?: string; workspace?: string; workspaceMode: "shared" | "worktree"; workspaceFrom?: string; maxRetries?: number }
type MissionTaskExecutionOutcome = { taskId: string; status: "completed" | "paused" | "cancelled" } | { taskId: string; status: "retry" | "failed" | "reconciliation_required"; error: string };
export interface MissionDefinition { id?: string; name: string; objective: string; workspace?: string; worktreeRoot?: string; projectId?: string; model?: string; agents?: MissionAgentDefinition[]; tasks?: MissionTaskDefinition[]; maxRetries: number; maxConcurrency: number; schedule?: { cron: string; timezone: string; enabled: boolean; missedRun: "skip" | "run_once" }; github?: { enabled?: boolean; writeEnabled?: boolean; mergeAuthorized?: boolean }; githubTrigger?: { events: Array<"issues" | "issue_comment" | "pull_request" | "pull_request_review">; repositories?: string[] } }
export interface StoredMission { id: string; definition: MissionDefinition; status: string; created_at: string; updated_at: string; next_run_at: string | null; last_run_at: string | null }

function normalizeDefinition(input: unknown): MissionDefinition & { id: string } {
  const parsed = definitionSchema.parse(input) as MissionDefinition;
  const definition: MissionDefinition & { id: string } = { ...parsed, id: parsed.id ?? randomUUID(), tasks: parsed.tasks ?? [{ id: "main", objective: parsed.objective, dependsOn: [], workspaceMode: "shared" }] };
  const tasks = definition.tasks!; const ids = new Set<string>();
  const agentIds = new Set<string>();
  for (const agent of definition.agents ?? []) { if (agentIds.has(agent.id)) throw new Error(`Duplicate mission agent id: ${agent.id}`); agentIds.add(agent.id); }
  for (const [index, task] of tasks.entries()) {
    const id = task.id ?? `task-${index + 1}`; task.id = id;
    if (ids.has(id)) throw new Error(`Duplicate mission task id: ${id}`); ids.add(id);
  }
  for (const task of tasks) for (const dependency of task.dependsOn) if (!ids.has(dependency)) throw new Error(`Unknown dependency "${dependency}" in task "${task.id}"`);
  for (const task of tasks) if (task.agentId && !agentIds.has(task.agentId)) throw new Error(`Unknown agent "${task.agentId}" in task "${task.id}"`);
  for (const task of tasks) if (task.workspaceFrom && (!ids.has(task.workspaceFrom) || !task.dependsOn.includes(task.workspaceFrom) || task.workspaceFrom === task.id)) throw new Error(`Task "${task.id}" workspaceFrom must name one of its direct dependencies`);
  const byId = new Map(tasks.map((task) => [task.id!, task])); const visited = new Set<string>(); const visiting = new Set<string>();
  const visit = (id: string) => { if (visiting.has(id)) throw new Error(`Mission task dependency cycle includes ${id}`); if (visited.has(id)) return; visiting.add(id); for (const dependency of byId.get(id)!.dependsOn) visit(dependency); visiting.delete(id); visited.add(id); };
  for (const task of tasks) visit(task.id!);
  if (definition.schedule) {
    new Intl.DateTimeFormat("en-US", { timeZone: definition.schedule.timezone });
    const cron = new Cron(definition.schedule.cron, { timezone: definition.schedule.timezone, paused: true }); cron.stop();
  }
  if (definition.workspace) definition.workspace = resolve(definition.workspace);
  if (definition.worktreeRoot) definition.worktreeRoot = resolve(definition.worktreeRoot);
  for (const task of tasks) if (task.workspace) task.workspace = resolve(task.workspace);
  return definition as MissionDefinition & { id: string };
}

export function validateMissionDefinition(input: unknown): MissionDefinition {
  const { id: _id, ...definition } = normalizeDefinition(input);
  return definition;
}

export class MissionRepository {
  constructor(private readonly store: XystStore) {}
  create(input: unknown): StoredMission {
    const definition = normalizeDefinition(input); const now = new Date().toISOString();
    this.store.db.prepare("INSERT INTO missions(id,definition_json,status,created_at,updated_at) VALUES(?,?,?,?,?)").run(definition.id, JSON.stringify(definition), "active", now, now);
    return this.get(definition.id)!;
  }
  get(id: string): StoredMission | undefined {
    const row = this.store.db.prepare("SELECT id,definition_json,status,created_at,updated_at,next_run_at,last_run_at FROM missions WHERE id=?").get(id) as { id: string; definition_json: string; status: string; created_at: string; updated_at: string; next_run_at: string | null; last_run_at: string | null } | undefined;
    return row ? { id: row.id, definition: normalizeDefinition(JSON.parse(row.definition_json)), status: row.status, created_at: row.created_at, updated_at: row.updated_at, next_run_at: row.next_run_at, last_run_at: row.last_run_at } : undefined;
  }
  list(): StoredMission[] {
    const rows = this.store.db.prepare("SELECT id FROM missions ORDER BY updated_at DESC").all() as Array<{ id: string }>;
    return rows.map(({ id }) => this.get(id)!).filter(Boolean);
  }
  rename(id: string, name: string): StoredMission {
    const mission = this.get(id);
    if (!mission) throw new Error(`Mission not found: ${id}`);
    const nextName = name.trim();
    if (!nextName || nextName.length > 100 || /[\r\n\0]/.test(nextName)) throw new Error("Mission name must be a single line containing 1–100 characters");
    if (mission.status === "running") throw new Error("Cannot rename a mission while its runner is active");
    const lease = this.store.db.prepare("SELECT expires_at FROM runner_leases WHERE mission_id=?").get(id) as { expires_at: string } | undefined;
    if (lease && Date.parse(lease.expires_at) > Date.now()) throw new Error("Cannot rename a mission while its runner lease is active");
    const definition = normalizeDefinition({ ...mission.definition, name: nextName });
    this.store.db.prepare("UPDATE missions SET definition_json=?,updated_at=? WHERE id=?").run(JSON.stringify(definition), new Date().toISOString(), id);
    return this.get(id)!;
  }
  fork(id: string, name?: string): StoredMission {
    const mission = this.get(id);
    if (!mission) throw new Error(`Mission not found: ${id}`);
    const { id: _sourceId, ...sourceDefinition } = mission.definition;
    const requestedName = name?.trim();
    if (name !== undefined && (!requestedName || requestedName.length > 100 || /[\r\n\0]/.test(requestedName))) throw new Error("Mission name must be a single line containing 1–100 characters");
    const forkName = requestedName ?? `${mission.definition.name} (fork)`.slice(0, 100).trim();
    const { githubTrigger: _githubTrigger, ...forkBase } = sourceDefinition;
    const definition = {
      ...forkBase,
      name: forkName,
      ...(sourceDefinition.schedule ? { schedule: { ...sourceDefinition.schedule, enabled: false } } : {}),
    };
    return this.create(definition);
  }
  exportDefinition(id: string): Omit<MissionDefinition, "id"> {
    const mission = this.get(id);
    if (!mission) throw new Error(`Mission not found: ${id}`);
    const { id: _missionId, ...definition } = mission.definition;
    return JSON.parse(JSON.stringify(definition)) as Omit<MissionDefinition, "id">;
  }
  delete(id: string): void {
    const mission = this.get(id);
    if (!mission) throw new Error(`Mission not found: ${id}`);
    if (mission.status === "running") throw new Error("Cannot delete a running mission; pause or stop its runner first");
    if (mission.status === "reconciliation_required" || this.store.db.prepare("SELECT 1 FROM mission_tasks WHERE mission_id=? AND state='reconciliation_required' LIMIT 1").get(id)) {
      throw new Error("Mission has an uncertain external action; reconcile it before deleting the mission");
    }
    const lease = this.store.db.prepare("SELECT expires_at FROM runner_leases WHERE mission_id=?").get(id) as { expires_at: string } | undefined;
    if (lease && Date.parse(lease.expires_at) > Date.now()) throw new Error("Cannot delete a mission while its runner lease is active");
    const runningJob = this.store.db.prepare("SELECT id FROM jobs WHERE mission_id=? AND state='running' LIMIT 1").get(id);
    if (runningJob) throw new Error("Cannot delete a mission while one of its background jobs is running");
    const worktree = this.store.db.prepare("SELECT path FROM mission_workspaces WHERE mission_id=? AND mode='worktree' AND status<>'removed' LIMIT 1").get(id) as { path: string } | undefined;
    if (worktree) throw new Error(`Remove or preserve the mission worktree before deleting this mission: ${worktree.path}`);
    const transaction = this.store.db.transaction(() => {
      this.store.db.prepare("UPDATE jobs SET state='cancelled',updated_at=? WHERE mission_id=? AND state='queued'").run(new Date().toISOString(), id);
      this.store.db.prepare("UPDATE jobs SET mission_id=NULL,updated_at=? WHERE mission_id=?").run(new Date().toISOString(), id);
      this.store.db.prepare("DELETE FROM settings WHERE scope='agent' AND scope_id IN (SELECT id FROM agents WHERE mission_id=?)").run(id);
      this.store.db.prepare("DELETE FROM settings WHERE scope='mission' AND scope_id=?").run(id);
      this.store.db.prepare("DELETE FROM runner_leases WHERE mission_id=?").run(id);
      this.store.db.prepare("DELETE FROM mission_runs WHERE mission_id=?").run(id);
      this.store.db.prepare("DELETE FROM mission_workspaces WHERE mission_id=?").run(id);
      this.store.db.prepare("DELETE FROM agents WHERE mission_id=?").run(id);
      this.store.db.prepare("DELETE FROM missions WHERE id=?").run(id);
    });
    transaction();
  }
  setStatus(id: string, status: string): void { this.store.db.prepare("UPDATE missions SET status=?, updated_at=? WHERE id=?").run(status, new Date().toISOString(), id); }
  updateTaskControls(missionId: string, taskId: string, controls: { model?: string | null; maxTurns?: number | null }): StoredMission {
    const mission = this.get(missionId);
    if (!mission) throw new Error(`Mission not found: ${missionId}`);
    if (mission.status === "archived") throw new Error("Agent controls cannot be changed for an archived mission");
    if (mission.status === "running") throw new Error("Agent controls cannot be changed while the mission is running");
    const lease = this.store.db.prepare("SELECT expires_at FROM runner_leases WHERE mission_id=?").get(missionId) as { expires_at: string } | undefined;
    if (lease && Date.parse(lease.expires_at) > Date.now()) throw new Error("Agent controls cannot be changed while a mission runner lease is active");
    const task = mission.definition.tasks?.find((entry) => entry.id === taskId);
    if (!task) throw new Error(`Mission task not found: ${taskId}`);
    if (controls.model !== undefined) {
      if (controls.model === null || controls.model.trim() === "") delete task.model;
      else {
        const model = controls.model.trim();
        if (model.length > 200 || /[\r\n\0]/.test(model)) throw new Error("Model override must be a single-line identifier up to 200 characters");
        task.model = model;
      }
    }
    if (controls.maxTurns !== undefined) {
      if (controls.maxTurns === null) delete task.maxTurns;
      else {
        if (!Number.isInteger(controls.maxTurns) || controls.maxTurns < 1 || controls.maxTurns > 50) throw new Error("Turn limit must be an integer from 1 to 50");
        task.maxTurns = controls.maxTurns;
      }
    }
    const definition = normalizeDefinition(mission.definition);
    this.store.db.prepare("UPDATE missions SET definition_json=?,updated_at=? WHERE id=?").run(JSON.stringify(definition), new Date().toISOString(), missionId);
    return this.get(missionId)!;
  }
  setScheduleState(id: string, nextRunAt: string | null, lastRunAt?: string): void {
    this.store.db.prepare("UPDATE missions SET next_run_at=?, last_run_at=COALESCE(?, last_run_at), updated_at=? WHERE id=?").run(nextRunAt, lastRunAt ?? null, new Date().toISOString(), id);
  }
  archive(id: string): void { this.setStatus(id, "archived"); this.setScheduleState(id, null); }
}

export class PersistentMissionRunner {
  readonly repository: MissionRepository;
  readonly ownerId = randomUUID();
  private readonly active = new Map<string, AbortController>();
  private readonly activeRuns = new Map<string, string>();
  private readonly activeTasks = new Map<string, AbortController>();
  private readonly schedules = new Map<string, Cron>();
  private readonly scheduleSignatures = new Map<string, string>();
  private queueTimer: NodeJS.Timeout | undefined;
  private queueWorking = false;
  private recoveryWorking = false;

  constructor(private readonly deps: { store: XystStore; config: ConfigStore; events: RuntimeEvents; agent: AgentRunner; modelProvider?: LMStudioProvider; access?: AccessController; worktreeRoot?: string; resourceStatsReader?: typeof readHostResourceStats }) { this.repository = new MissionRepository(deps.store); }

  listWorkspaces(missionId?: string): Array<Record<string, unknown>> {
    const sql = `SELECT w.*,r.state AS run_state,t.state AS task_state FROM mission_workspaces w JOIN mission_runs r ON r.id=w.run_id JOIN mission_tasks t ON t.run_id=w.run_id AND t.task_key=w.task_key ${missionId ? "WHERE w.mission_id=?" : ""} ORDER BY w.created_at DESC,w.task_key`;
    return (missionId ? this.deps.store.db.prepare(sql).all(missionId) : this.deps.store.db.prepare(sql).all()) as Array<Record<string, unknown>>;
  }

  async removeWorktree(missionId: string, runId: string, taskId: string, force = false): Promise<{ removed: boolean; path: string }> {
    const row = this.deps.store.db.prepare("SELECT path,base_workspace,mode,status FROM mission_workspaces WHERE mission_id=? AND run_id=? AND task_key=?").get(missionId, runId, taskId) as { path: string; base_workspace: string; mode: string; status: string } | undefined;
    if (!row || row.mode !== "worktree") throw new Error("Mission task does not own a Git worktree");
    const run = this.deps.store.db.prepare("SELECT state FROM mission_runs WHERE id=? AND mission_id=?").get(runId, missionId) as { state: string } | undefined;
    if (run?.state === "running") throw new Error("Cannot remove a worktree while its mission run is active");
    const references = this.deps.store.db.prepare("SELECT COUNT(*) AS count FROM mission_workspaces WHERE run_id=? AND path=? AND task_key<>? AND mode='worktree' AND status<>'removed'").get(runId, row.path, taskId) as { count: number };
    if (references.count > 0) throw new Error("Another mission task owns this worktree");
    const access = this.deps.access ?? new AccessController(); access.assertCapability("externalActions"); access.assertExecutable("git"); await access.assertPath(row.path, "write");
    const args = ["worktree", "remove", ...(force ? ["--force"] : []), row.path];
    const result = await runProcess("git", args, { cwd: row.base_workspace, timeoutMs: 120_000, maxOutputChars: 4000 });
    if (result.code !== 0) throw new Error(`Could not remove Git worktree${force ? "" : "; inspect or preserve its changes, or pass --force to discard them"}: ${(result.stderr || result.stdout).trim().slice(0, 2000)}`);
    this.deps.store.db.prepare("UPDATE mission_workspaces SET status='removed',updated_at=? WHERE run_id=? AND path=?").run(new Date().toISOString(), runId, row.path);
    return { removed: true, path: row.path };
  }

  private async workspaceForTask(mission: StoredMission, runId: string, task: MissionTaskDefinition): Promise<string> {
    const taskId = task.id!; const base = resolve(task.workspace ?? mission.definition.workspace ?? process.cwd());
    if (task.workspaceFrom) {
      const parent = this.deps.store.db.prepare("SELECT path,status FROM mission_workspaces WHERE run_id=? AND task_key=?").get(runId, task.workspaceFrom) as { path: string; status: string } | undefined;
      if (!parent || parent.status !== "active") throw new Error(`Workspace source task is not available: ${task.workspaceFrom}`);
      this.recordWorkspace(mission.id, runId, taskId, "shared_from", base, parent.path, "active");
      return parent.path;
    }
    if (task.workspaceMode !== "worktree") { this.recordWorkspace(mission.id, runId, taskId, "shared", base, base, "active"); return base; }
    const access = this.deps.access ?? new AccessController(); access.assertCapability("externalActions"); access.assertExecutable("git");
    await access.assertPath(base, "read");
    const signal = this.active.get(mission.id)?.signal;
    const rootResult = await runProcess("git", ["rev-parse", "--show-toplevel"], { cwd: base, ...(signal ? { signal } : {}), timeoutMs: 15_000, maxOutputChars: 2000 });
    if (rootResult.code !== 0) throw new Error(`Worktree task ${taskId} requires a Git repository: ${(rootResult.stderr || rootResult.stdout).trim().slice(0, 1000)}`);
    const repository = resolve(rootResult.stdout.trim()); await access.assertPath(repository, "write");
    const worktreeRoot = resolve(mission.definition.worktreeRoot ?? this.deps.worktreeRoot ?? resolve(repository, "..", ".xyst-worktrees"));
    await access.assertPath(worktreeRoot, "write");
    const segment = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "task";
    const path = resolve(worktreeRoot, segment(mission.id), segment(runId), segment(taskId));
    const existing = this.deps.store.db.prepare("SELECT path,status FROM mission_workspaces WHERE run_id=? AND task_key=?").get(runId, taskId) as { path: string; status: string } | undefined;
    const worktreePath = existing?.path ?? path;
    this.recordWorkspace(mission.id, runId, taskId, "worktree", repository, worktreePath, "creating");
    const list = await runProcess("git", ["worktree", "list", "--porcelain"], { cwd: repository, ...(signal ? { signal } : {}), timeoutMs: 15_000, maxOutputChars: 100_000 });
    if (list.code !== 0) throw new Error(`Could not inspect Git worktrees: ${(list.stderr || list.stdout).trim().slice(0, 1000)}`);
    const registered = list.stdout.split(/\r?\n/).filter((line) => line.startsWith("worktree ")).map((line) => resolve(line.slice(9)));
    const samePath = (left: string, right: string) => {
      if (process.platform === "win32" && existsSync(left) && existsSync(right)) {
        try { const a = statSync(left); const b = statSync(right); return a.dev === b.dev && a.ino === b.ino; } catch { /* Fall through to normalized path comparison. */ }
      }
      return process.platform === "win32" ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
    };
    if (registered.some((entry) => samePath(entry, worktreePath)) && existsSync(worktreePath)) {
      this.recordWorkspace(mission.id, runId, taskId, "worktree", repository, worktreePath, "active");
    } else {
      if (existsSync(worktreePath)) throw new Error(`Worktree path already exists and is not registered to Git: ${worktreePath}`);
      await mkdir(resolve(worktreePath, ".."), { recursive: true });
      const added = await runProcess("git", ["worktree", "add", "--detach", worktreePath, "HEAD"], { cwd: repository, ...(signal ? { signal } : {}), timeoutMs: 120_000, maxOutputChars: 4000 });
      if (added.code !== 0) throw new Error(`Could not create task worktree: ${(added.stderr || added.stdout).trim().slice(0, 2000)}`);
      this.recordWorkspace(mission.id, runId, taskId, "worktree", repository, worktreePath, "active");
    }
    const prefixResult = await runProcess("git", ["rev-parse", "--show-prefix"], { cwd: base, ...(signal ? { signal } : {}), timeoutMs: 15_000, maxOutputChars: 2000 });
    if (prefixResult.code !== 0) throw new Error(`Could not resolve the task's subdirectory in its Git repository: ${(prefixResult.stderr || prefixResult.stdout).trim().slice(0, 1000)}`);
    const subdirectory = prefixResult.stdout.trim().split(/[\\/]/).filter(Boolean);
    return resolve(worktreePath, ...subdirectory);
  }

  private recordWorkspace(missionId: string, runId: string, taskId: string, mode: "shared" | "worktree" | "shared_from", base: string, path: string, status: string): void {
    const now = new Date().toISOString();
    this.deps.store.db.prepare(`INSERT INTO mission_workspaces(mission_id,run_id,task_key,mode,base_workspace,path,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(run_id,task_key) DO UPDATE SET mode=excluded.mode,base_workspace=excluded.base_workspace,path=excluded.path,status=excluded.status,updated_at=excluded.updated_at`).run(missionId, runId, taskId, mode, base, path, status, now, now);
  }

  private setAgentStatus(id: string, status: string): void {
    this.deps.store.db.prepare("UPDATE agents SET status=?,updated_at=? WHERE id=?").run(status, new Date().toISOString(), id);
  }

  async run(missionId: string, options: { trigger?: "manual" | "schedule" | "github"; resume?: boolean; scheduledFor?: string; triggerPayload?: unknown; signal?: AbortSignal; approveExternalAction?: (request: ExternalActionApprovalRequest) => Promise<boolean> } = {}): Promise<{ runId: string; missionId: string; status: string }> {
    const mission = this.repository.get(missionId); if (!mission) throw new Error(`Mission not found: ${missionId}`);
    if (mission.status === "archived") throw new Error("Archived missions cannot run");
    if (mission.status === "paused") throw new Error("Mission is paused; resume it before running");
    if (mission.status === "cancelled") throw new Error("Mission is cancelled; resume it before running");
    if (mission.status === "reconciliation_required") throw new Error("Mission has uncertain external actions; inspect `mission show` and reconcile them before running");
    const delegationEnabled = this.deps.config.resolve<boolean>("orchestration.delegation.enabled", { ...(mission.definition.projectId ? { project: mission.definition.projectId } : {}), mission: missionId })?.value !== false;
    const missionScopes = { ...(mission.definition.projectId ? { project: mission.definition.projectId } : {}), mission: missionId };
    const missionAccess = this.deps.access ?? new AccessController();
    const effectiveMissionAccess = this.deps.config.resolve<boolean>("network.enabled", missionScopes)?.value === false
      ? missionAccess.restrictCapabilities({ network: true }) : missionAccess;
    if (!delegationEnabled) {
      const tasks = mission.definition.tasks ?? [];
      if (tasks.length !== 1 || (mission.definition.agents?.length ?? 0) > 0 || tasks.some((task) => task.agentId !== undefined)) {
        throw new Error("Mission delegation is disabled; only a single task without named agent profiles can run");
      }
    }
    if (mission.definition.github?.enabled !== undefined) this.deps.config.set("mission", "integrations.github.enabled", mission.definition.github.enabled, missionId);
    else if (mission.definition.githubTrigger) this.deps.config.set("mission", "integrations.github.enabled", true, missionId);
    if (mission.definition.github?.writeEnabled !== undefined) this.deps.config.set("mission", "integrations.github.writeEnabled", mission.definition.github.writeEnabled, missionId);
    if (mission.definition.github?.mergeAuthorized !== undefined) this.deps.config.set("mission", "integrations.github.mergeEnabled", mission.definition.github.mergeAuthorized, missionId);
    const trigger = options.trigger ?? "manual"; const now = new Date(); const runId = randomUUID(); const leaseMs = 30_000;
    const acquired = this.deps.store.db.transaction(() => {
      const lease = this.deps.store.db.prepare("SELECT owner_id,expires_at FROM runner_leases WHERE mission_id=?").get(missionId) as { owner_id: string; expires_at: string } | undefined;
      if (lease && Date.parse(lease.expires_at) > now.getTime()) throw new Error(`Mission already has a live runner lease until ${lease.expires_at}`);
      if (lease) {
        this.deps.store.db.prepare("UPDATE mission_runs SET state='interrupted',finished_at=?,error='Runner lease expired' WHERE mission_id=? AND state='running'").run(now.toISOString(), missionId);
        this.recoverRunningTasks(missionId, now.toISOString());
        this.deps.store.db.prepare("DELETE FROM runner_leases WHERE mission_id=?").run(missionId);
        if (this.currentStatus(missionId) !== "paused") this.repository.setStatus(missionId, "interrupted");
      }
      const resumable = options.resume ? this.deps.store.db.prepare("SELECT id FROM mission_runs WHERE mission_id=? AND state IN ('paused','interrupted') ORDER BY started_at DESC LIMIT 1").get(missionId) as { id: string } | undefined : undefined;
        const selectedRun = resumable?.id ?? runId;
      this.deps.store.db.prepare("INSERT INTO runner_leases(mission_id,owner_id,expires_at,heartbeat_at) VALUES(?,?,?,?) ON CONFLICT(mission_id) DO UPDATE SET owner_id=excluded.owner_id,expires_at=excluded.expires_at,heartbeat_at=excluded.heartbeat_at").run(missionId, this.ownerId, new Date(now.getTime() + leaseMs).toISOString(), now.toISOString());
      if (resumable) this.deps.store.db.prepare("UPDATE mission_runs SET state='running',finished_at=NULL,heartbeat_at=?,error=NULL WHERE id=?").run(now.toISOString(), selectedRun);
      else this.deps.store.db.prepare("INSERT INTO mission_runs(id,mission_id,state,trigger_type,scheduled_for,started_at,heartbeat_at) VALUES(?,?,?,?,?,?,?)").run(selectedRun, missionId, "running", trigger, options.scheduledFor ?? null, now.toISOString(), now.toISOString());
      for (const task of mission.definition.tasks ?? []) {
        const taskKey = task.id!;
        this.deps.store.db.prepare("INSERT OR IGNORE INTO mission_tasks(run_id,mission_id,task_key,objective,dependencies_json,state,updated_at) VALUES(?,?,?,?,?,'pending',?)").run(selectedRun, missionId, taskKey, task.objective, JSON.stringify(task.dependsOn), now.toISOString());
      }
      this.repository.setStatus(missionId, "running"); return selectedRun;
    })();
    const activeRunId = acquired;
    const controller = new AbortController(); this.active.set(missionId, controller);
    this.activeRuns.set(missionId, activeRunId);
    const externalAbort = () => controller.abort(); options.signal?.addEventListener("abort", externalAbort, { once: true });
    this.deps.events.emit("mission.started", { missionId, runId: activeRunId, trigger }, missionId);
    const heartbeat = setInterval(() => {
      const at = new Date(); this.deps.store.db.prepare("UPDATE runner_leases SET expires_at=?,heartbeat_at=? WHERE mission_id=? AND owner_id=?").run(new Date(at.getTime() + leaseMs).toISOString(), at.toISOString(), missionId, this.ownerId);
      this.deps.store.db.prepare("UPDATE mission_runs SET heartbeat_at=? WHERE id=?").run(at.toISOString(), activeRunId);
      const status = (this.deps.store.db.prepare("SELECT status FROM missions WHERE id=?").get(missionId) as { status: string } | undefined)?.status;
      if (status === "paused" || status === "cancelled" || status === "archived") controller.abort();
    }, 1_000);
    let state = "completed"; let errorMessage: string | undefined;
    try {
      const taskRows = () => this.deps.store.db.prepare("SELECT task_key,state,attempts,session_id,result_json,error FROM mission_tasks WHERE run_id=?").all(activeRunId) as Array<{ task_key: string; state: string; attempts: number; session_id: string | null; result_json: string | null; error: string | null }>;
      let whileRunning = true;
      while (whileRunning) {
        if (controller.signal.aborted) { state = this.currentStatus(missionId) === "paused" ? "paused" : "cancelled"; break; }
        const rows = taskRows(); const states = new Map(rows.map((row) => [row.task_key, row]));
        const unresolvedAction = rows.find((row) => row.state === "reconciliation_required");
        if (unresolvedAction) { state = "reconciliation_required"; errorMessage = unresolvedAction.error ?? `Task ${unresolvedAction.task_key} has an unresolved external action`; break; }
        if (rows.every((row) => row.state === "completed")) { state = "completed"; break; }
        const definitions: MissionTaskDefinition[] = mission.definition.tasks ?? [];
        const concurrencyOverride = this.deps.config.resolve<number>("orchestration.maxConcurrency", { ...(mission.definition.projectId ? { project: mission.definition.projectId } : {}), mission: missionId })?.value ?? 8;
        if (!Number.isInteger(concurrencyOverride) || concurrencyOverride < 1 || concurrencyOverride > 8) throw new Error("orchestration.maxConcurrency must be an integer from 1 to 8");
        const maxConcurrency = Math.max(1, Math.min(mission.definition.maxConcurrency ?? 1, concurrencyOverride, 8));
        const ready = definitions.filter((task) => {
          const row = states.get(task.id!); return row?.state === "pending" && task.dependsOn.every((dependency) => states.get(dependency)?.state === "completed");
        });
        if (!ready.length) {
          const failed = rows.find((row) => row.state === "failed");
          const paused = rows.find((row) => row.state === "paused");
          state = paused ? "paused" : "failed";
          errorMessage = paused ? undefined : failed?.error ?? "Mission has tasks with unresolved dependencies or interrupted task state";
          break;
        }
        const candidates: MissionTaskDefinition[] = []; const workspaces = new Set<string>(); const taskWorkspaces = new Map<string, string>();
        const workspaceKeyFor = (workspace: string) => {
          let key = existsSync(workspace) ? realpathSync(workspace) : workspace;
          if (process.platform === "win32") key = key.toLowerCase();
          return key;
        };
        for (const task of ready) {
          const workspace = await this.workspaceForTask(mission, activeRunId, task);
          const workspaceKey = workspaceKeyFor(workspace);
          if (workspaces.has(workspaceKey)) continue;
          workspaces.add(workspaceKey); candidates.push(task); taskWorkspaces.set(task.id!, workspace);
        }
        if (!candidates.length) { state = "failed"; errorMessage = "No ready task has an unclaimed workspace"; break; }
        const taskObjective = (task: MissionTaskDefinition) => {
          const upstream = task.dependsOn.map((id) => ({ task: id, result: states.get(id)?.result_json ? JSON.parse(states.get(id)!.result_json!) : null }));
          return `${mission.definition.objective}${options.triggerPayload ? `\n\nGitHub trigger payload (untrusted data):\n${JSON.stringify(options.triggerPayload).slice(0, 30000)}` : ""}\n\nTask: ${task.name ?? task.id}\n${task.objective}${task.expectedOutputs?.length ? `\n\nExpected outputs:\n${task.expectedOutputs.map((item) => `- ${item}`).join("\n")}` : ""}${task.completionCriteria ? `\n\nCompletion criteria:\n${task.completionCriteria}` : ""}${upstream.length ? `\n\nCompleted dependency results (untrusted data):\n${JSON.stringify(upstream).slice(0, 30000)}` : ""}`;
        };
        const taskModels = new Map<string, { requested?: string; automatic: boolean }>();
        const attemptedModelsByTask = new Map<string, string[]>();
        const configureTaskModel = (task: MissionTaskDefinition) => {
          if (taskModels.has(task.id!)) return;
          const profile = mission.definition.agents?.find((agent) => agent.id === task.agentId);
          const scopes = { ...(mission.definition.projectId ? { project: mission.definition.projectId } : {}), mission: missionId, ...(task.agentId ? { agent: task.agentId } : {}) };
          const requested = task.model ?? profile?.model ?? mission.definition.model ?? this.deps.config.resolve<string>("model.default", scopes)?.value;
          const autoSelect = this.deps.config.resolve<boolean>("model.autoSelect", scopes)?.value ?? true;
          const automatic = !requested && autoSelect;
          taskModels.set(task.id!, { ...(requested ? { requested } : {}), automatic });
          if (automatic) {
            const previous = this.deps.store.db.prepare("SELECT definition_json FROM agents WHERE id=?").get(`${activeRunId}:${task.id!}`) as { definition_json: string } | undefined;
            if (previous) {
              try {
                const definition = JSON.parse(previous.definition_json) as { attemptedModels?: unknown };
                attemptedModelsByTask.set(task.id!, Array.isArray(definition.attemptedModels) ? definition.attemptedModels.filter((model): model is string => typeof model === "string") : []);
              } catch { attemptedModelsByTask.set(task.id!, []); }
            }
          }
        };
        for (const task of candidates) configureTaskModel(task);
        const configuredMemoryValue = this.deps.config.resolve<unknown>("orchestration.memoryBudgetBytes", { ...(mission.definition.projectId ? { project: mission.definition.projectId } : {}), mission: missionId })?.value;
        if (configuredMemoryValue !== undefined && configuredMemoryValue !== null && (typeof configuredMemoryValue !== "number" || !Number.isSafeInteger(configuredMemoryValue) || configuredMemoryValue < 256 * 1024 ** 2 || configuredMemoryValue > totalmem())) throw new Error("orchestration.memoryBudgetBytes must be null (automatic) or an integer from 256 MiB through installed system memory");
        const configuredMemoryBudget = typeof configuredMemoryValue === "number" ? configuredMemoryValue : undefined;
        const memoryBudgetBytes = configuredMemoryBudget ?? Math.floor(Math.min(freemem() * 0.5, totalmem() * 0.25, 8 * 1024 ** 3));
        let installedModels: Awaited<ReturnType<LMStudioProvider["models"]>> = [];
        if (this.deps.modelProvider) {
          effectiveMissionAccess.assertCapability("network");
          installedModels = await this.deps.modelProvider.models(controller.signal);
        }
        const resourceCandidateFor = (task: MissionTaskDefinition): ResourceTaskCandidate => {
            const priorAttempts = attemptedModelsByTask.get(task.id!);
            const modelAssignment = taskModels.get(task.id!);
            const objective = taskObjective(task);
            return { id: task.id!, requiredContextTokens: estimateRequiredContextTokens([{ content: objective }]), taskType: classifyModelTaskObjective(objective), ...(modelAssignment?.requested ? { model: modelAssignment.requested } : {}), ...(modelAssignment?.automatic ? { automatic: true } : {}), ...(priorAttempts ? { previouslyAttemptedModels: priorAttempts } : {}) };
        };
        const resourceCandidates: ResourceTaskCandidate[] = candidates.map(resourceCandidateFor);
        const performanceByModel = this.deps.config.resolve<boolean>("telemetry.localMetrics", { ...(mission.definition.projectId ? { project: mission.definition.projectId } : {}), mission: missionId })?.value === false ? {} : readModelPerformance(this.deps.store);
        let availableGpuMemoryBytes: number | undefined;
        const estimatedGpuMemoryBytesByModel: Record<string, number> = {};
        let gpuEstimateContextTokens = 0;
        if (this.deps.modelProvider && this.deps.modelProvider.supportsLocalCliModelLifecycle?.() && typeof this.deps.modelProvider.estimateLoad === "function") {
          try {
            const cliCommand = process.env.LM_STUDIO_CLI_PATH ?? (process.platform === "win32" ? "lms.exe" : "lms");
            effectiveMissionAccess.assertExecutable(cliCommand);
            const hostResources = await (this.deps.resourceStatsReader ?? readHostResourceStats)(effectiveMissionAccess);
            if (hostResources.nvidiaGpuMemory.status === "available") {
              availableGpuMemoryBytes = hostResources.nvidiaGpuMemory.devices.reduce((sum, device) => sum + device.freeBytes, 0);
              const requiredContextTokens = Math.max(...resourceCandidates.map((task) => task.requiredContextTokens ?? 4096));
              gpuEstimateContextTokens = requiredContextTokens;
              const pinnedKeys = resourceCandidates.flatMap((task) => task.model ? [task.model] : []);
              const toolModels = installedModels.some((candidate) => candidate.type === "llm" && candidate.capabilities?.trained_for_tool_use === true);
              const eligible = installedModels.filter((candidate) => candidate.type === "llm" && (!toolModels || candidate.capabilities?.trained_for_tool_use === true)
                && (typeof candidate.max_context_length !== "number" || candidate.max_context_length >= requiredContextTokens));
              const best = eligible.length ? chooseAgentModel(eligible, { requiredContextTokens, performanceByModel }).model : undefined;
              const shortlist = [...new Set([...pinnedKeys, ...(best ? [best.key] : []), ...[...eligible].sort((left, right) => left.size_bytes - right.size_bytes).map((candidate) => candidate.key)])].slice(0, Math.max(3, Math.min(8, maxConcurrency)));
              for (const modelKey of shortlist) {
                if (controller.signal.aborted) throw new Error("Mission cancelled");
                try {
                  const candidate = installedModels.find((item) => item.key === modelKey);
                  const estimateContext = modelLoadContextLength(candidate?.max_context_length, requiredContextTokens) ?? requiredContextTokens;
                  const estimate = await this.deps.modelProvider.estimateLoad(modelKey, { context_length: estimateContext }, controller.signal);
                  const gpuBytes = parseLmStudioResourceEstimate(String(estimate.output ?? "")).gpuBytes;
                  if (gpuBytes !== undefined) estimatedGpuMemoryBytesByModel[modelKey] = gpuBytes;
                } catch (error) { if (controller.signal.aborted) throw error; }
              }
            }
          } catch (error) { if (controller.signal.aborted) throw error; }
        }
        const batch = this.deps.modelProvider
          ? planResourceAwareBatch(resourceCandidates, installedModels, { maxConcurrency, memoryBudgetBytes, performanceByModel, ...(availableGpuMemoryBytes === undefined ? {} : { availableGpuMemoryBytes }), ...(Object.keys(estimatedGpuMemoryBytesByModel).length ? { estimatedGpuMemoryBytesByModel } : {}) })
          : undefined;
        const selected = batch ? batch.assignments.map((assignment) => candidates.find((task) => task.id === assignment.id)!) : candidates.slice(0, maxConcurrency);
        const selectedAssignments = new Map(batch?.assignments.map((assignment) => [assignment.id, assignment]) ?? []);
        if (batch) this.deps.events.emit("mission.resources.planned", { missionId, runId: activeRunId, memoryBudgetBytes, estimatedAdditionalBytes: batch.estimatedAdditionalBytes, ...(batch.availableGpuMemoryBytes === undefined ? {} : { availableGpuMemoryBytes: batch.availableGpuMemoryBytes, estimatedAdditionalGpuMemoryBytes: batch.estimatedAdditionalGpuMemoryBytes ?? 0 }), concurrencyLimit: maxConcurrency, selected: batch.assignments.map(({ id, selectedModel, selectionReason, estimatedAdditionalBytes, estimatedAdditionalGpuMemoryBytes, admittedOverBudget }) => ({ taskId: id, model: selectedModel, reason: selectionReason, estimatedAdditionalBytes, ...(estimatedAdditionalGpuMemoryBytes === undefined ? {} : { estimatedAdditionalGpuMemoryBytes }), admittedOverBudget })), deferredTaskIds: batch.deferredTaskIds }, missionId);
        const executeTask = async (task: MissionTaskDefinition): Promise<MissionTaskExecutionOutcome> => {
          const row = states.get(task.id!)!; const attempt = row.attempts + 1;
          const profile = mission.definition.agents?.find((agent) => agent.id === task.agentId);
          const resourceAssignment = selectedAssignments.get(task.id!);
          const agentRunId = `${activeRunId}:${task.id!}`;
          const taskController = new AbortController();
          const abortTask = () => taskController.abort();
          controller.signal.addEventListener("abort", abortTask, { once: true });
          this.activeTasks.set(`${missionId}:${task.id!}`, taskController);
          const now = new Date().toISOString();
          this.deps.store.db.prepare("UPDATE mission_tasks SET state='running',attempts=?,updated_at=? WHERE run_id=? AND task_key=?").run(attempt, now, activeRunId, task.id!);
          const attemptedModels = attemptedModelsByTask.get(task.id!) ?? [];
          if (resourceAssignment?.automatic && resourceAssignment.selectedModel && !attemptedModels.includes(resourceAssignment.selectedModel)) attemptedModels.push(resourceAssignment.selectedModel);
          attemptedModelsByTask.set(task.id!, attemptedModels);
          const agentDefinition = { id: task.agentId ?? task.id!, name: profile?.name ?? task.name ?? task.id!, profile: profile ?? null, taskId: task.id, workspace: taskWorkspaces.get(task.id!), expectedOutputs: task.expectedOutputs ?? [], completionCriteria: task.completionCriteria ?? null, model: resourceAssignment?.selectedModel ?? taskModels.get(task.id!)?.requested ?? null, modelSelectionReason: resourceAssignment?.selectionReason ?? "resource scheduling unavailable; using agent defaults", estimatedAdditionalMemoryBytes: resourceAssignment?.estimatedAdditionalBytes ?? null, estimatedAdditionalGpuMemoryBytes: resourceAssignment?.estimatedAdditionalGpuMemoryBytes ?? null, ...(taskModels.get(task.id!)?.automatic ? { attemptedModels } : {}) };
          this.deps.store.db.prepare(`INSERT INTO agents(id,mission_id,definition_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET definition_json=excluded.definition_json,status=excluded.status,updated_at=excluded.updated_at`).run(agentRunId, missionId, JSON.stringify(agentDefinition), "running", now, now);
          this.deps.events.emit("mission.task.started", { missionId, runId: activeRunId, taskId: task.id, agentId: task.agentId ?? task.id, attempt, workspace: taskWorkspaces.get(task.id!) }, missionId);
          this.deps.events.emit("agent.started", { missionId, runId: activeRunId, agentRunId, agentId: task.agentId ?? task.id, taskId: task.id, attempt }, missionId);
          const maxTurns = task.maxTurns ?? profile?.maxTurns;
          const objective = taskObjective(task);
          try {
            const taskResult = await this.deps.agent.run(objective, {
              missionId, ...(mission.definition.projectId ? { projectId: mission.definition.projectId } : {}), workspace: taskWorkspaces.get(task.id!)!,
              completionCriteria: [
                task.objective,
                ...(task.expectedOutputs ?? []),
                ...(task.completionCriteria ? [task.completionCriteria] : [])
              ],
              expectedOutputPaths: declaredFileOutputPaths(task.expectedOutputs, taskWorkspaces.get(task.id!)!),
              ...(task.requiredToolEvidence?.length ? { requiredToolEvidence: task.requiredToolEvidence } : {}),
              agentId: task.agentId ?? task.id!, ...(resourceAssignment?.selectedModel ?? taskModels.get(task.id!)?.requested ? { model: resourceAssignment?.selectedModel ?? taskModels.get(task.id!)!.requested } : {}), ...(resourceAssignment?.automatic ? { automaticModelAssignment: true } : {}),
              ...(maxTurns !== undefined ? { maxTurns } : {}), ...(profile?.access ? { accessProfile: profile.access } : {}),
              ...(options.approveExternalAction ? { approveExternalAction: options.approveExternalAction } : {}),
              executionScope: `${activeRunId}:${task.id!}`,
              ...(row.session_id ? { sessionId: row.session_id } : {}), signal: taskController.signal,
              onSession: (sessionId) => this.deps.store.db.prepare("UPDATE mission_tasks SET session_id=?,updated_at=? WHERE run_id=? AND task_key=?").run(sessionId, new Date().toISOString(), activeRunId, task.id!)
            });
            const persistedAgent = this.deps.store.db.prepare("SELECT definition_json FROM agents WHERE id=?").get(agentRunId) as { definition_json: string } | undefined;
            if (persistedAgent) {
              const definition = JSON.parse(persistedAgent.definition_json) as Record<string, unknown>;
              definition.model = taskResult.model;
              definition.modelSelectionReason = resourceAssignment && taskResult.selectionReason !== resourceAssignment.selectionReason
                ? `${resourceAssignment.selectionReason}; agent execution: ${taskResult.selectionReason}`
                : resourceAssignment?.selectionReason ?? taskResult.selectionReason;
              this.deps.store.db.prepare("UPDATE agents SET definition_json=?,updated_at=? WHERE id=?").run(JSON.stringify(definition), new Date().toISOString(), agentRunId);
            }
            if (taskResult.status === "cancelled") {
              if (!controller.signal.aborted && taskController.signal.aborted) {
                this.deps.store.db.prepare("UPDATE mission_tasks SET state='paused',updated_at=? WHERE run_id=? AND task_key=?").run(new Date().toISOString(), activeRunId, task.id!);
                this.setAgentStatus(agentRunId, "paused");
                this.deps.events.emit("mission.task.paused", { missionId, runId: activeRunId, taskId: task.id }, missionId);
                return { taskId: task.id!, status: "paused" as const };
              }
              this.deps.store.db.prepare("UPDATE mission_tasks SET state='pending',updated_at=? WHERE run_id=? AND task_key=?").run(new Date().toISOString(), activeRunId, task.id!);
              this.setAgentStatus(agentRunId, "cancelled");
              return { taskId: task.id!, status: "cancelled" as const };
            }
            if (taskResult.status === "limit") throw new Error(`Agent turn limit reached for mission task ${task.id}`);
            if (taskResult.status === "unverified") throw new Error(`COMPLETION_UNVERIFIED: mission task ${task.id} returned without passing its deliverables to the runtime evidence check; review its saved session and retry with verifiable outputs.`);
            this.deps.store.db.prepare("UPDATE mission_tasks SET state='completed',result_json=?,error=NULL,updated_at=? WHERE run_id=? AND task_key=?").run(JSON.stringify({ response: taskResult.response, sessionId: taskResult.sessionId, model: taskResult.model }), new Date().toISOString(), activeRunId, task.id!);
            this.setAgentStatus(agentRunId, "completed");
            this.deps.events.emit("mission.task.completed", { missionId, runId: activeRunId, taskId: task.id, attempts: attempt }, missionId);
            this.deps.events.emit("agent.completed", { missionId, runId: activeRunId, agentRunId, taskId: task.id, attempts: attempt }, missionId);
            return { taskId: task.id!, status: "completed" as const };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.startsWith("EXTERNAL_ACTION_UNCERTAIN:")) {
              this.deps.store.db.prepare("UPDATE mission_tasks SET state='reconciliation_required',error=?,updated_at=? WHERE run_id=? AND task_key=?").run(message.slice(0, 2000), new Date().toISOString(), activeRunId, task.id!);
              this.setAgentStatus(agentRunId, "reconciliation_required");
              this.deps.events.emit("mission.task.reconciliation_required", { missionId, runId: activeRunId, taskId: task.id, error: message.slice(0, 500) }, missionId);
              return { taskId: task.id!, status: "reconciliation_required" as const, error: message };
            }
            if (controller.signal.aborted) {
              this.deps.store.db.prepare("UPDATE mission_tasks SET state='pending',updated_at=? WHERE run_id=? AND task_key=?").run(new Date().toISOString(), activeRunId, task.id!);
              this.setAgentStatus(agentRunId, "cancelled");
              return { taskId: task.id!, status: "cancelled" as const };
            }
            if (taskController.signal.aborted) {
              this.deps.store.db.prepare("UPDATE mission_tasks SET state='paused',updated_at=? WHERE run_id=? AND task_key=?").run(new Date().toISOString(), activeRunId, task.id!);
              this.setAgentStatus(agentRunId, "paused");
              this.deps.events.emit("mission.task.paused", { missionId, runId: activeRunId, taskId: task.id }, missionId);
              return { taskId: task.id!, status: "paused" as const };
            }
            const retriesEnabled = this.deps.config.resolve<boolean>("orchestration.retries.enabled", { ...(mission.definition.projectId ? { project: mission.definition.projectId } : {}), mission: missionId })?.value !== false;
            const approvalHalted = message.startsWith("EXTERNAL_ACTION_APPROVAL_REQUIRED:") || message.startsWith("EXTERNAL_ACTION_DENIED:") || message.startsWith("COMPLETION_UNVERIFIED:");
            const retries = task.maxRetries ?? mission.definition.maxRetries; const retry = retriesEnabled && !approvalHalted && attempt <= retries;
            this.deps.store.db.prepare("UPDATE mission_tasks SET state=?,error=?,updated_at=? WHERE run_id=? AND task_key=?").run(retry ? "pending" : "failed", message.slice(0, 2000), new Date().toISOString(), activeRunId, task.id!);
            this.setAgentStatus(agentRunId, retry ? "retrying" : "failed");
            this.deps.events.emit("mission.task.failed", { missionId, runId: activeRunId, taskId: task.id, attempt, retry, error: message.slice(0, 500) }, missionId);
            return { taskId: task.id!, status: retry ? "retry" as const : "failed" as const, error: message };
          } finally {
            controller.signal.removeEventListener("abort", abortTask);
            if (this.activeTasks.get(`${missionId}:${task.id!}`) === taskController) this.activeTasks.delete(`${missionId}:${task.id!}`);
          }
        };
        const activeTaskRuns = new Map<string, Promise<MissionTaskExecutionOutcome>>();
        const launchTask = (task: MissionTaskDefinition) => {
          const execution = executeTask(task).catch((error): MissionTaskExecutionOutcome => ({ taskId: task.id!, status: "failed", error: error instanceof Error ? error.message : String(error) }));
          activeTaskRuns.set(task.id!, execution);
        };
        for (const task of selected) launchTask(task);
        const startedTaskIds = new Set(selected.map((task) => task.id!));
        const backfillCandidates = candidates.filter((task) => !startedTaskIds.has(task.id!));
        let allowBackfill = true;
        let backfillPreparationError: unknown;
        const outcomes: MissionTaskExecutionOutcome[] = [];
        while (activeTaskRuns.size) {
          const completed = await Promise.race([...activeTaskRuns].map(async ([taskId, promise]) => ({ taskId, outcome: await promise })));
          activeTaskRuns.delete(completed.taskId);
          outcomes.push(completed.outcome);
          if (["cancelled", "failed", "reconciliation_required"].includes(completed.outcome.status) || controller.signal.aborted) allowBackfill = false;
          if (!allowBackfill) continue;

          const latestRows = taskRows();
          states.clear();
          for (const latestRow of latestRows) states.set(latestRow.task_key, latestRow);
          const queuedIds = new Set([...startedTaskIds, ...backfillCandidates.map((task) => task.id!)]);
          const reservedWorkspaceKeys = new Set<string>();
          for (const runningTaskId of activeTaskRuns.keys()) {
            const workspace = taskWorkspaces.get(runningTaskId);
            if (workspace) reservedWorkspaceKeys.add(workspaceKeyFor(workspace));
          }
          for (const queuedTask of backfillCandidates) {
            if (!startedTaskIds.has(queuedTask.id!)) {
              const workspace = taskWorkspaces.get(queuedTask.id!);
              if (workspace) reservedWorkspaceKeys.add(workspaceKeyFor(workspace));
            }
          }
          try {
            for (const task of definitions) {
              if (queuedIds.has(task.id!)) continue;
              const row = states.get(task.id!);
              if (row?.state !== "pending" || !task.dependsOn.every((dependency) => states.get(dependency)?.state === "completed")) continue;
              const workspace = await this.workspaceForTask(mission, activeRunId, task);
              const workspaceKey = workspaceKeyFor(workspace);
              if (reservedWorkspaceKeys.has(workspaceKey)) continue;
              reservedWorkspaceKeys.add(workspaceKey);
              taskWorkspaces.set(task.id!, workspace);
              candidates.push(task);
              backfillCandidates.push(task);
              queuedIds.add(task.id!);
              configureTaskModel(task);
              resourceCandidates.push(resourceCandidateFor(task));
            }
          } catch (error) {
            backfillPreparationError = error;
            allowBackfill = false;
            continue;
          }
          if (!backfillCandidates.length || activeTaskRuns.size >= maxConcurrency) continue;

          const slots = maxConcurrency - activeTaskRuns.size;
          const pending = backfillCandidates.filter((task) => !startedTaskIds.has(task.id!) && states.get(task.id!)?.state === "pending");
          if (!pending.length) continue;
          let nextAssignments: ResourceTaskAssignment[] = [];
          if (this.deps.modelProvider) {
            let currentModels = installedModels;
            try { currentModels = await this.deps.modelProvider.models(controller.signal); }
            catch (error) { if (controller.signal.aborted) throw error; }
            let currentGpuBytes = availableGpuMemoryBytes;
            if (availableGpuMemoryBytes !== undefined) {
              try {
                const latestResources = await (this.deps.resourceStatsReader ?? readHostResourceStats)(effectiveMissionAccess);
                if (latestResources.nvidiaGpuMemory.status === "available") currentGpuBytes = latestResources.nvidiaGpuMemory.devices.reduce((sum, device) => sum + device.freeBytes, 0);
              } catch { /* Keep the last conservative live VRAM sample if refresh fails. */ }
            }
            if (controller.signal.aborted) { allowBackfill = false; continue; }
            const requiredContextTokens = Math.max(...resourceCandidates.map((candidate) => candidate.requiredContextTokens ?? 4096));
            if (currentGpuBytes !== undefined && this.deps.modelProvider.supportsLocalCliModelLifecycle?.() && typeof this.deps.modelProvider.estimateLoad === "function" && requiredContextTokens > gpuEstimateContextTokens) {
              for (const modelKey of Object.keys(estimatedGpuMemoryBytesByModel)) delete estimatedGpuMemoryBytesByModel[modelKey];
              try {
                const cliCommand = process.env.LM_STUDIO_CLI_PATH ?? (process.platform === "win32" ? "lms.exe" : "lms");
                effectiveMissionAccess.assertExecutable(cliCommand);
                const toolModels = currentModels.some((candidate) => candidate.type === "llm" && candidate.capabilities?.trained_for_tool_use === true);
                const eligible = currentModels.filter((candidate) => candidate.type === "llm" && (!toolModels || candidate.capabilities?.trained_for_tool_use === true)
                  && (typeof candidate.max_context_length !== "number" || candidate.max_context_length >= requiredContextTokens));
                const best = eligible.length ? chooseAgentModel(eligible, { requiredContextTokens, performanceByModel }).model : undefined;
                const pinnedKeys = resourceCandidates.flatMap((candidate) => candidate.model ? [candidate.model] : []);
                const shortlist = [...new Set([...pinnedKeys, ...(best ? [best.key] : []), ...[...eligible].sort((left, right) => left.size_bytes - right.size_bytes).map((candidate) => candidate.key)])].slice(0, 8);
                for (const modelKey of shortlist) {
                  if (controller.signal.aborted) throw new Error("Mission cancelled");
                  try {
                    const candidate = currentModels.find((item) => item.key === modelKey);
                    const estimateContext = modelLoadContextLength(candidate?.max_context_length, requiredContextTokens) ?? requiredContextTokens;
                    const estimate = await this.deps.modelProvider.estimateLoad(modelKey, { context_length: estimateContext }, controller.signal);
                    const gpuBytes = parseLmStudioResourceEstimate(String(estimate.output ?? "")).gpuBytes;
                    if (gpuBytes === undefined) delete estimatedGpuMemoryBytesByModel[modelKey];
                    else estimatedGpuMemoryBytesByModel[modelKey] = gpuBytes;
                  } catch (error) {
                    delete estimatedGpuMemoryBytesByModel[modelKey];
                    if (controller.signal.aborted) throw error;
                  }
                }
                gpuEstimateContextTokens = requiredContextTokens;
              } catch (error) { if (controller.signal.aborted) { allowBackfill = false; continue; } }
            }
            const dynamicBudget = Math.max(0, Math.min(memoryBudgetBytes, freemem()));
            try {
              const dynamicPlan = planResourceAwareBatch(
                pending.map((task) => resourceCandidates.find((candidate) => candidate.id === task.id)!).filter(Boolean),
                currentModels,
                { maxConcurrency: slots, memoryBudgetBytes: dynamicBudget, performanceByModel, ...(currentGpuBytes === undefined ? {} : { availableGpuMemoryBytes: currentGpuBytes }), ...(Object.keys(estimatedGpuMemoryBytesByModel).length ? { estimatedGpuMemoryBytesByModel } : {}) }
              );
              nextAssignments = activeTaskRuns.size ? dynamicPlan.assignments.filter((assignment) => !assignment.admittedOverBudget) : dynamicPlan.assignments;
              const selectedIds = new Set(nextAssignments.map((assignment) => assignment.id));
              this.deps.events.emit("mission.resources.planned", { missionId, runId: activeRunId, memoryBudgetBytes: dynamicBudget, estimatedAdditionalBytes: nextAssignments.reduce((sum, assignment) => sum + assignment.estimatedAdditionalBytes, 0), ...(dynamicPlan.availableGpuMemoryBytes === undefined ? {} : { availableGpuMemoryBytes: dynamicPlan.availableGpuMemoryBytes, estimatedAdditionalGpuMemoryBytes: nextAssignments.reduce((sum, assignment) => sum + (assignment.estimatedAdditionalGpuMemoryBytes ?? 0), 0) }), concurrencyLimit: maxConcurrency, backfill: true, selected: nextAssignments.map(({ id, selectedModel, selectionReason, estimatedAdditionalBytes, estimatedAdditionalGpuMemoryBytes, admittedOverBudget }) => ({ taskId: id, model: selectedModel, reason: selectionReason, estimatedAdditionalBytes, ...(estimatedAdditionalGpuMemoryBytes === undefined ? {} : { estimatedAdditionalGpuMemoryBytes }), admittedOverBudget })), deferredTaskIds: [...new Set([...dynamicPlan.deferredTaskIds, ...dynamicPlan.assignments.filter((assignment) => !selectedIds.has(assignment.id)).map((assignment) => assignment.id)])] }, missionId);
            } catch {
              if (controller.signal.aborted) allowBackfill = false;
              nextAssignments = [];
            }
          } else nextAssignments = pending.slice(0, slots).map((task) => ({ ...resourceCandidates.find((candidate) => candidate.id === task.id!)!, selectionReason: "ready-work backfill; using agent defaults", estimatedAdditionalBytes: 0, admittedOverBudget: false }));

          for (const assignment of nextAssignments) {
            if (controller.signal.aborted) { allowBackfill = false; break; }
            const task = pending.find((candidate) => candidate.id === assignment.id);
            if (!task || startedTaskIds.has(task.id!)) continue;
            const original = batch?.assignments.find((candidate) => candidate.id === task.id!);
            selectedAssignments.set(task.id!, { ...(original ?? resourceCandidates.find((candidate) => candidate.id === task.id!)!), ...assignment, selectionReason: assignment.selectionReason || original?.selectionReason || "resource scheduling unavailable; using agent defaults", estimatedAdditionalBytes: assignment.estimatedAdditionalBytes, admittedOverBudget: assignment.admittedOverBudget });
            startedTaskIds.add(task.id!);
            launchTask(task);
          }
        }
        if (backfillPreparationError) throw backfillPreparationError;
        if (outcomes.some((outcome) => outcome.status === "cancelled")) {
          state = this.currentStatus(missionId) === "paused" ? "paused" : "cancelled"; break;
        }
        const reconciliation = outcomes.find((outcome) => outcome.status === "reconciliation_required");
        if (reconciliation?.status === "reconciliation_required") { state = "reconciliation_required"; errorMessage = reconciliation.error; break; }
        const failed = outcomes.find((outcome) => outcome.status === "failed");
        if (failed?.status === "failed") { state = "failed"; errorMessage = failed.error; break; }
      }
    } catch (error) {
      state = controller.signal.aborted && this.currentStatus(missionId) === "paused" ? "paused" : "failed";
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      clearInterval(heartbeat); options.signal?.removeEventListener("abort", externalAbort); this.active.delete(missionId);
      this.activeRuns.delete(missionId);
      const done = new Date().toISOString();
      this.deps.store.db.prepare("UPDATE mission_runs SET state=?,finished_at=?,heartbeat_at=?,error=? WHERE id=?").run(state, done, done, errorMessage ?? null, activeRunId);
      this.deps.store.db.prepare("DELETE FROM runner_leases WHERE mission_id=? AND owner_id=?").run(missionId, this.ownerId);
      this.repository.setStatus(missionId, state === "paused" ? "paused" : state === "cancelled" ? "cancelled" : state);
      if (trigger === "schedule") this.repository.setScheduleState(missionId, this.nextSchedule(missionId), done);
      this.deps.events.emit("mission.finished", { missionId, runId: activeRunId, status: state, ...(errorMessage ? { error: errorMessage } : {}) }, missionId);
    }
    return { missionId, runId: activeRunId, status: state };
  }

  pause(missionId: string): void { this.repository.setStatus(missionId, "paused"); this.active.get(missionId)?.abort(); this.stopSchedule(missionId); this.deps.events.emit("mission.paused", { missionId }, missionId); }
  cancel(missionId: string): void { this.repository.setStatus(missionId, "cancelled"); this.active.get(missionId)?.abort(); this.stopSchedule(missionId); this.deps.events.emit("mission.cancelled", { missionId }, missionId); }
  pauseTask(missionId: string, taskId: string): { missionId: string; taskId: string; status: "paused" } {
    const runId = this.activeRuns.get(missionId);
    if (!runId) throw new Error("Mission has no active runner");
    if (!this.repository.get(missionId)?.definition.tasks?.some((task) => task.id === taskId)) throw new Error(`Mission task not found: ${taskId}`);
    const row = this.deps.store.db.prepare("SELECT state FROM mission_tasks WHERE run_id=? AND task_key=?").get(runId, taskId) as { state: string } | undefined;
    if (row?.state === "pending") this.deps.store.db.prepare("UPDATE mission_tasks SET state='paused',updated_at=? WHERE run_id=? AND task_key=? AND state='pending'").run(new Date().toISOString(), runId, taskId);
    else if (row?.state === "running") {
      const taskController = this.activeTasks.get(`${missionId}:${taskId}`);
      if (!taskController) throw new Error(`Mission task is stopping: ${taskId}`);
      taskController.abort();
    } else throw new Error(`Mission task cannot be paused from state ${row?.state ?? "missing"}`);
    this.deps.events.emit("mission.task.pause_requested", { missionId, runId, taskId }, missionId);
    return { missionId, taskId, status: "paused" };
  }
  async resumeTask(missionId: string, taskId: string, approveExternalAction?: (request: ExternalActionApprovalRequest) => Promise<boolean>) {
    const runId = this.activeRuns.get(missionId);
    if (runId) {
      const row = this.deps.store.db.prepare("SELECT state FROM mission_tasks WHERE run_id=? AND task_key=?").get(runId, taskId) as { state: string } | undefined;
      if (row?.state !== "paused") throw new Error(`Mission task ${taskId} is ${row?.state ?? "missing"}, expected paused`);
      this.deps.store.db.prepare("UPDATE mission_tasks SET state='pending',error=NULL,updated_at=? WHERE run_id=? AND task_key=? AND state='paused'").run(new Date().toISOString(), runId, taskId);
      this.setAgentStatus(`${runId}:${taskId}`, "queued");
      this.deps.events.emit("mission.task.resume_requested", { missionId, runId, taskId }, missionId);
      return { missionId, runId, taskId, status: "queued" };
    }
    return this.restartTask(missionId, taskId, "paused", approveExternalAction);
  }
  async retryTask(missionId: string, taskId: string, approveExternalAction?: (request: ExternalActionApprovalRequest) => Promise<boolean>) { return this.restartTask(missionId, taskId, "failed", approveExternalAction); }
  private async restartTask(missionId: string, taskId: string, expectedState: "paused" | "failed", approveExternalAction?: (request: ExternalActionApprovalRequest) => Promise<boolean>) {
    const mission = this.repository.get(missionId);
    if (!mission) throw new Error(`Mission not found: ${missionId}`);
    if (mission.status === "archived") throw new Error("Archived missions cannot run");
    if (this.active.has(missionId)) throw new Error("Cannot resume or retry a task while its mission runner is active");
    if (!mission.definition.tasks?.some((task) => task.id === taskId)) throw new Error(`Mission task not found: ${taskId}`);
    const lease = this.deps.store.db.prepare("SELECT expires_at FROM runner_leases WHERE mission_id=?").get(missionId) as { expires_at: string } | undefined;
    if (lease && Date.parse(lease.expires_at) > Date.now()) throw new Error("Mission runner is still stopping; retry after its lease expires");
    const run = this.deps.store.db.prepare("SELECT id,state FROM mission_runs WHERE mission_id=? ORDER BY started_at DESC LIMIT 1").get(missionId) as { id: string; state: string } | undefined;
    if (!run) throw new Error(`Mission has no saved run to ${expectedState === "failed" ? "retry" : "resume"}`);
    const task = this.deps.store.db.prepare("SELECT state,session_id FROM mission_tasks WHERE run_id=? AND task_key=?").get(run.id, taskId) as { state: string; session_id: string | null } | undefined;
    if (task?.state !== expectedState) throw new Error(`Mission task ${taskId} is ${task?.state ?? "missing"}, expected ${expectedState}`);
    if (expectedState === "failed" && task.session_id) {
      const uncertain = this.deps.store.db.prepare("SELECT 1 FROM tool_calls WHERE session_id=? AND effect='external' AND status='uncertain' LIMIT 1").get(task.session_id);
      if (uncertain) throw new Error("Task has an uncertain external action; reconcile it before retrying");
    }
    const now = new Date().toISOString();
    this.deps.store.db.prepare("UPDATE mission_tasks SET state='pending',error=NULL,updated_at=? WHERE run_id=? AND task_key=? AND state=?").run(now, run.id, taskId, expectedState);
    this.deps.store.db.prepare("UPDATE mission_runs SET state='paused',finished_at=?,error=NULL WHERE id=?").run(now, run.id);
    this.repository.setStatus(missionId, "active");
    this.deps.events.emit(expectedState === "failed" ? "mission.task.retry_requested" : "mission.task.resume_requested", { missionId, runId: run.id, taskId }, missionId);
    return this.run(missionId, { resume: true, ...(approveExternalAction ? { approveExternalAction } : {}) });
  }
  async resume(missionId: string, signal?: AbortSignal, approveExternalAction?: (request: ExternalActionApprovalRequest) => Promise<boolean>) {
    const current = this.repository.get(missionId); if (!current) throw new Error(`Mission not found: ${missionId}`);
    if (current.status === "archived") throw new Error("Archived missions cannot be resumed");
    const lease = this.deps.store.db.prepare("SELECT expires_at FROM runner_leases WHERE mission_id=?").get(missionId) as { expires_at: string } | undefined;
    if (lease && Date.parse(lease.expires_at) > Date.now()) throw new Error(`Mission runner is still stopping; retry after ${lease.expires_at}`);
    this.repository.setStatus(missionId, "active");
    this.deps.store.db.prepare("UPDATE jobs SET state='queued',updated_at=? WHERE mission_id=? AND kind='github-trigger' AND state='paused'").run(new Date().toISOString(), missionId);
    if (this.queueTimer) void this.startScheduler();
    return this.run(missionId, { resume: true, trigger: "manual", ...(signal ? { signal } : {}), ...(approveExternalAction ? { approveExternalAction } : {}) });
  }
  archive(missionId: string): void { this.repository.archive(missionId); this.active.get(missionId)?.abort(); this.stopSchedule(missionId); this.deps.events.emit("mission.archived", { missionId }, missionId); }

  async recover(options: { requeueTriggerJobs?: boolean } = {}): Promise<number> {
    const now = new Date().toISOString();
    const stale = this.deps.store.db.prepare("SELECT mission_id,owner_id FROM runner_leases WHERE expires_at<=?").all(now) as Array<{ mission_id: string; owner_id: string }>;
    const tx = this.deps.store.db.transaction(() => {
      for (const lease of stale) {
        this.deps.store.db.prepare("UPDATE mission_runs SET state='interrupted',finished_at=?,error='Runner lease expired' WHERE mission_id=? AND state='running'").run(now, lease.mission_id);
        this.recoverRunningTasks(lease.mission_id, now);
        this.deps.store.db.prepare("DELETE FROM runner_leases WHERE mission_id=? AND owner_id=?").run(lease.mission_id, lease.owner_id);
        if (this.currentStatus(lease.mission_id) !== "paused") this.repository.setStatus(lease.mission_id, "interrupted");
      }
      if (options.requeueTriggerJobs !== false) this.deps.store.db.prepare("UPDATE jobs SET state='queued',updated_at=? WHERE kind='github-trigger' AND state='running'").run(now);
    });
    tx();
    for (const lease of stale) this.deps.events.emit("mission.recovered", { missionId: lease.mission_id, reason: "expired_lease" }, lease.mission_id);
    return stale.length;
  }

  private recoverRunningTasks(missionId: string, now: string): void {
    this.deps.store.db.prepare(`UPDATE agents SET status='interrupted',updated_at=? WHERE status='running' AND id IN
      (SELECT t.run_id || ':' || t.task_key FROM mission_tasks t WHERE t.mission_id=? AND t.state='running')`).run(now, missionId);
    this.deps.store.db.prepare(`UPDATE tool_calls SET status='uncertain',finished_at=COALESCE(finished_at,?)
      WHERE status='running' AND effect='external' AND session_id IN
        (SELECT session_id FROM mission_tasks WHERE mission_id=? AND state='running' AND session_id IS NOT NULL)`).run(now, missionId);
    this.deps.store.db.prepare(`UPDATE mission_tasks SET state=CASE WHEN EXISTS (
        SELECT 1 FROM tool_calls c WHERE c.session_id=mission_tasks.session_id AND c.effect='external' AND c.status='uncertain'
      ) THEN 'reconciliation_required' ELSE 'pending' END,
      error=CASE WHEN EXISTS (
        SELECT 1 FROM tool_calls c WHERE c.session_id=mission_tasks.session_id AND c.effect='external' AND c.status='uncertain'
      ) THEN 'External action outcome is uncertain; inspect mission show and reconcile the action before resuming' ELSE NULL END,
      updated_at=? WHERE mission_id=? AND state='running'`).run(now, missionId);
  }

  async reconcileExternalAction(missionId: string, runId: string, taskId: string, toolCallId: string, resolution: "completed" | "retry"): Promise<{ missionId: string; runId: string; taskId: string; toolCallId: string; resolution: string; remainingUncertain: number }> {
    const access = this.deps.access ?? new AccessController(); access.assertCapability("externalActions");
    await this.recover();
    const live = this.deps.store.db.prepare("SELECT expires_at FROM runner_leases WHERE mission_id=?").get(missionId) as { expires_at: string } | undefined;
    if (live && Date.parse(live.expires_at) > Date.now()) throw new Error(`Cannot reconcile actions while the mission runner lease is live until ${live.expires_at}`);
    const task = this.deps.store.db.prepare("SELECT session_id,state FROM mission_tasks WHERE mission_id=? AND run_id=? AND task_key=?").get(missionId, runId, taskId) as { session_id: string | null; state: string } | undefined;
    if (!task?.session_id || task.state !== "reconciliation_required") throw new Error("Mission task is not waiting for external-action reconciliation");
    const action = this.deps.store.db.prepare("SELECT id FROM tool_calls WHERE id=? AND session_id=? AND effect='external' AND status='uncertain'").get(toolCallId, task.session_id) as { id: string } | undefined;
    if (!action) throw new Error("Tool call is not an uncertain external action for this mission task; inspect `mission show`");
    const now = new Date().toISOString();
    if (resolution === "completed") {
      const confirmation = JSON.stringify({ reconciled: "User confirmed this external action completed; reuse its recorded result and do not repeat it." });
      this.deps.store.db.prepare("UPDATE tool_calls SET status='reconciled',output_json=?,finished_at=? WHERE id=?").run(confirmation, now, toolCallId);
    } else {
      this.deps.store.db.prepare("UPDATE tool_calls SET status='retry_allowed',output_json=NULL,finished_at=NULL WHERE id=?").run(toolCallId);
    }
    const remaining = this.deps.store.db.prepare("SELECT COUNT(*) AS count FROM tool_calls WHERE session_id=? AND effect='external' AND status='uncertain'").get(task.session_id) as { count: number };
    if (remaining.count === 0) {
      this.deps.store.db.prepare("UPDATE mission_tasks SET state='pending',session_id=NULL,error=NULL,updated_at=? WHERE mission_id=? AND run_id=? AND task_key=?").run(now, missionId, runId, taskId);
      this.deps.store.db.prepare("UPDATE mission_runs SET state='interrupted',finished_at=?,error='External action was explicitly reconciled' WHERE id=? AND mission_id=?").run(now, runId, missionId);
      this.repository.setStatus(missionId, "interrupted");
    }
    this.deps.events.emit("mission.action.reconciled", { missionId, runId, taskId, toolCallId, resolution, remainingUncertain: remaining.count }, missionId);
    return { missionId, runId, taskId, toolCallId, resolution, remainingUncertain: remaining.count };
  }

  async startScheduler(): Promise<void> {
    await this.recover();
    if (!this.queueTimer) {
      this.queueTimer = setInterval(() => { this.refreshScheduler(); void this.processQueuedTriggers(); void this.resumeInterruptedMissions(); }, 1_000);
      void this.processQueuedTriggers();
      void this.resumeInterruptedMissions();
    }
    this.refreshScheduler();
  }

  private async resumeInterruptedMissions(): Promise<void> {
    if (this.recoveryWorking) return;
    this.recoveryWorking = true;
    try {
      await this.recover({ requeueTriggerJobs: false });
      for (const mission of this.repository.list()) {
        if (mission.status !== "interrupted") continue;
        const lease = this.deps.store.db.prepare("SELECT expires_at FROM runner_leases WHERE mission_id=?").get(mission.id) as { expires_at: string } | undefined;
        if (lease && Date.parse(lease.expires_at) > Date.now()) continue;
        try {
          const result = await this.run(mission.id, { resume: true, trigger: "manual" });
          this.deps.events.emit("mission.recovery.finished", { missionId: mission.id, runId: result.runId, status: result.status }, mission.id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("live runner lease") || this.currentStatus(mission.id) === "reconciliation_required") continue;
          this.deps.events.emit("mission.recovery.failed", { missionId: mission.id, error: message.slice(0, 500) }, mission.id);
        }
      }
    } finally { this.recoveryWorking = false; }
  }

  private refreshScheduler(): void {
    const desired = new Map<string, { mission: StoredMission; signature: string }>();
    const schedulingEnabled = this.deps.config.resolve<boolean>("orchestration.scheduling.enabled")?.value !== false;
    for (const mission of this.repository.list()) {
      const schedule = mission.definition.schedule;
      if (!schedule?.enabled || ["paused", "cancelled", "archived"].includes(mission.status)) continue;
      if (!schedulingEnabled) continue;
      desired.set(mission.id, { mission, signature: JSON.stringify(schedule) });
    }
    for (const id of this.schedules.keys()) {
      if (!desired.has(id) || this.scheduleSignatures.get(id) !== desired.get(id)?.signature) this.stopSchedule(id);
    }
    for (const [id, { mission, signature }] of desired) {
      const schedule = mission.definition.schedule!;
      if (this.schedules.has(id)) continue;
      const cron = new Cron(schedule.cron, { timezone: schedule.timezone, protect: true, name: `xyst-mission-${mission.id}` }, async () => {
        if (["paused", "cancelled", "archived"].includes(this.currentStatus(mission.id))) return;
        const scheduledFor = this.repository.get(mission.id)?.next_run_at ?? new Date().toISOString();
        this.deps.events.emit("mission.schedule.triggered", { missionId: mission.id, scheduledFor }, mission.id);
        try { await this.run(mission.id, { trigger: "schedule", scheduledFor }); }
        catch (error) { this.deps.events.emit("mission.schedule.failed", { missionId: mission.id, error: error instanceof Error ? error.message : String(error) }, mission.id); }
      });
      this.schedules.set(mission.id, cron);
      this.scheduleSignatures.set(id, signature);
      const next = cron.nextRun()?.toISOString() ?? null;
      const previousNext = mission.next_run_at;
      if (previousNext && Date.parse(previousNext) < Date.now() && mission.status !== "interrupted") {
        if (schedule.missedRun === "run_once") void this.run(mission.id, { trigger: "schedule", scheduledFor: previousNext }).catch((error) => this.deps.events.emit("mission.schedule.failed", { missionId: mission.id, error: String(error) }, mission.id));
        else this.deps.events.emit("mission.schedule.missed", { missionId: mission.id, scheduledFor: previousNext, policy: "skip" }, mission.id);
      }
      this.repository.setScheduleState(mission.id, next);
    }
  }

  async enqueueGitHubTrigger(event: string, repository: string, issueNumber: number | undefined, deliveryId: string, payload: unknown): Promise<number> {
    const matched = this.repository.list().filter((mission) => {
      const trigger = mission.definition.githubTrigger;
      return !["archived", "paused", "cancelled"].includes(mission.status) && Boolean(trigger?.events.includes(event as "issues" | "issue_comment" | "pull_request" | "pull_request_review"))
        && (!trigger?.repositories?.length || trigger.repositories.includes(repository));
    });
    const safePayload = JSON.parse(redactSecrets(JSON.stringify(payload))) as unknown;
    const now = new Date().toISOString();
    for (const mission of matched) {
      const id = createHash("sha256").update(`${deliveryId}:${mission.id}`).digest("hex");
      this.deps.store.db.prepare("INSERT OR IGNORE INTO jobs(id,mission_id,kind,state,details_json,created_at,updated_at) VALUES(?,?,'github-trigger','queued',?,?,?)")
        .run(id, mission.id, JSON.stringify({ event, repository, issueNumber, deliveryId, payload: safePayload }), now, now);
    }
    if (matched.length) this.deps.events.emit("mission.github.enqueued", { deliveryId, repository, event, missions: matched.map((mission) => mission.id) });
    return matched.length;
  }

  async processQueuedTriggers(): Promise<void> {
    if (this.queueWorking) return; this.queueWorking = true;
    try {
      const rows = this.deps.store.db.prepare("SELECT id,mission_id,details_json FROM jobs WHERE kind='github-trigger' AND state='queued' ORDER BY created_at LIMIT 20").all() as Array<{ id: string; mission_id: string; details_json: string }>;
      for (const row of rows) {
        const claimed = this.deps.store.db.prepare("UPDATE jobs SET state='running',updated_at=? WHERE id=? AND state='queued'").run(new Date().toISOString(), row.id);
        if (claimed.changes !== 1) continue;
        const details = JSON.parse(row.details_json) as { deliveryId: string; payload: unknown };
        try {
          const result = await this.run(row.mission_id, { trigger: "github", resume: true, triggerPayload: details.payload });
          this.deps.store.db.prepare("UPDATE jobs SET state=?,updated_at=? WHERE id=?").run(result.status === "paused" ? "paused" : result.status, new Date().toISOString(), row.id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("live runner lease")) {
            this.deps.store.db.prepare("UPDATE jobs SET state='queued',updated_at=? WHERE id=?").run(new Date().toISOString(), row.id);
            continue;
          }
          if (["paused", "cancelled", "archived"].includes(this.currentStatus(row.mission_id))) {
            this.deps.store.db.prepare("UPDATE jobs SET state=?,updated_at=? WHERE id=?").run(this.currentStatus(row.mission_id) === "paused" ? "paused" : "failed", new Date().toISOString(), row.id);
            continue;
          }
          this.deps.store.db.prepare("UPDATE jobs SET state='failed',details_json=?,updated_at=? WHERE id=?").run(JSON.stringify({ ...details, error: message }), new Date().toISOString(), row.id);
          this.deps.events.emit("mission.github.failed", { missionId: row.mission_id, deliveryId: details.deliveryId, error: message }, row.mission_id);
        }
      }
    } finally { this.queueWorking = false; }
  }

  stopScheduler(): void { if (this.queueTimer) clearInterval(this.queueTimer); this.queueTimer = undefined; for (const id of this.schedules.keys()) this.stopSchedule(id); }
  async shutdownScheduler(): Promise<void> {
    this.stopScheduler();
    while (this.active.size > 0 || this.queueWorking || this.recoveryWorking) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  private stopSchedule(id: string): void { this.schedules.get(id)?.stop(); this.schedules.delete(id); this.scheduleSignatures.delete(id); }
  private nextSchedule(id: string): string | null { const schedule = this.repository.get(id)?.definition.schedule; if (!schedule?.enabled) return null; const cron = new Cron(schedule.cron, { timezone: schedule.timezone, paused: true }); const next = cron.nextRun()?.toISOString() ?? null; cron.stop(); return next; }
  private currentStatus(id: string): string { return (this.deps.store.db.prepare("SELECT status FROM missions WHERE id=?").get(id) as { status: string } | undefined)?.status ?? "missing"; }
}
