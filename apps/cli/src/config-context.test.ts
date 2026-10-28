import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ConfigStore, XystStore } from "@xyst/runtime";

const cliEntry = fileURLToPath(new URL("./index.ts", import.meta.url));
const workspaceRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

test("config get resolves inherited project, mission, agent, and session context", () => {
  const root = mkdtempSync(join(tmpdir(), "xyst-config-context-"));
  assert.equal(resolve(root).startsWith(resolve(tmpdir())), true);
  const dataHome = join(root, "data");
  const env = { ...process.env, ...(process.platform === "win32" ? { APPDATA: dataHome } : { XDG_DATA_HOME: dataHome }) };
  const store = new XystStore(join(dataHome, "xyst", "xyst.sqlite"));
  try {
    const config = new ConfigStore(store);
    config.set("global", "model.default", "global-model");
    config.set("project", "model.default", "project-model", "project-a");
    config.set("mission", "model.default", "mission-model", "mission-a");
    config.set("agent", "model.default", "agent-model", "agent-a");
    config.set("session", "model.default", "session-model", "session-a");
    const now = new Date().toISOString();
    store.db.prepare("INSERT INTO missions(id,definition_json,status,created_at,updated_at) VALUES(?,?,?,?,?)").run("mission-a", JSON.stringify({ projectId: "project-a", tasks: [{ id: "task-a", agentId: "agent-a" }] }), "paused", now, now);
    store.db.prepare("INSERT INTO sessions(id,title,status,created_at,updated_at) VALUES(?,?,?,?,?)").run("session-a", "Scoped config context", "active", now, now);
    store.db.prepare("INSERT INTO mission_runs(id,mission_id,state,trigger_type,started_at,heartbeat_at) VALUES(?,?,?,?,?,?)").run("run-a", "mission-a", "paused", "manual", now, now);
    store.db.prepare("INSERT INTO mission_tasks(run_id,mission_id,task_key,objective,dependencies_json,state,attempts,session_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run("run-a", "mission-a", "task-a", "Check config scopes", "[]", "paused", 1, "session-a", now);
    store.close();

    const run = (...args: string[]) => {
      const result = spawnSync(process.execPath, ["--import", "tsx", cliEntry, "--json", ...args], { cwd: workspaceRoot, env, encoding: "utf8", timeout: 15_000 });
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.status, 0, result.stderr);
      const event = JSON.parse(result.stdout.trim()) as { type?: string; data?: Record<string, unknown> } & Record<string, unknown>;
      return (event.type === "result" ? event.data : event) as { value?: unknown; source?: string; scopeId?: string };
    };
    const getSession = () => run("config", "get", "model.default", "session", "session-a");
    assert.deepEqual(getSession(), { value: "session-model", source: "session", scopeId: "session-a" });
    run("config", "reset", "model.default", "session", "session-a");
    assert.deepEqual(getSession(), { value: "agent-model", source: "agent", scopeId: "agent-a" });
    run("config", "reset", "model.default", "agent", "agent-a");
    assert.deepEqual(getSession(), { value: "mission-model", source: "mission", scopeId: "mission-a" });
    run("config", "reset", "model.default", "mission", "mission-a");
    assert.deepEqual(getSession(), { value: "project-model", source: "project", scopeId: "project-a" });
    run("config", "reset", "model.default", "project", "project-a");
    assert.deepEqual(getSession(), { value: "global-model", source: "global", scopeId: "" });
    assert.deepEqual(run("config", "get", "model.default", "agent", "agent-a"), { value: "global-model", source: "global", scopeId: "" });
    const missingParent = spawnSync(process.execPath, ["--import", "tsx", cliEntry, "--json", "config", "get", "model.default", "agent", "agent-a", "mission-missing"], { cwd: workspaceRoot, env, encoding: "utf8", timeout: 15_000 });
    assert.equal(missingParent.status, 1, missingParent.stderr);
    assert.match(missingParent.stderr, /Parent mission not found for agent setting context: mission-missing/);
  } finally {
    try { store.close(); } catch { /* closed before subprocess checks */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("config import obeys restricted read roots and rejects oversized files", () => {
  const root = mkdtempSync(join(tmpdir(), "xyst-config-import-policy-"));
  assert.equal(resolve(root).startsWith(resolve(tmpdir())), true);
  const dataHome = join(root, "data");
  const allowedRoot = join(root, "allowed"); const outsideRoot = join(root, "outside");
  mkdirSync(allowedRoot); mkdirSync(outsideRoot);
  const allowedFile = join(allowedRoot, "settings.json"); const deniedFile = join(outsideRoot, "settings.json");
  writeFileSync(allowedFile, JSON.stringify({ "global:": { "model.default": "allowed-model" } }));
  writeFileSync(deniedFile, JSON.stringify({ "global:": { "model.default": "denied-model" } }));
  const oversizedFile = join(allowedRoot, "oversized.json"); writeFileSync(oversizedFile, " ".repeat(1_048_577));
  const env = { ...process.env, ...(process.platform === "win32" ? { APPDATA: dataHome } : { XDG_DATA_HOME: dataHome }) };
  const store = new XystStore(join(dataHome, "xyst", "xyst.sqlite"));
  try {
    const config = new ConfigStore(store);
    config.set("global", "access.profile", { mode: "restricted", readRoots: [allowedRoot], writeRoots: [], allowedExecutables: [], network: false, integrations: false, backgroundJobs: false, externalActions: false });
  } finally { store.close(); }
  try {
    const run = (path: string) => spawnSync(process.execPath, ["--import", "tsx", cliEntry, "--json", "config", "import", path], { cwd: workspaceRoot, env, encoding: "utf8", timeout: 15_000 });
    const allowed = run(allowedFile); assert.equal(allowed.error, undefined, allowed.error?.message); assert.equal(allowed.status, 0, allowed.stderr);
    const denied = run(deniedFile); assert.equal(denied.error, undefined, denied.error?.message); assert.equal(denied.status, 1); assert.match(denied.stderr, /Restricted profile denies read access/);
    const oversized = run(oversizedFile); assert.equal(oversized.error, undefined, oversized.error?.message); assert.equal(oversized.status, 1); assert.match(oversized.stderr, /exceeds the 1 MiB limit/);
    const verify = new XystStore(join(dataHome, "xyst", "xyst.sqlite"));
    try { assert.equal(new ConfigStore(verify).resolve("model.default")?.value, "allowed-model"); }
    finally { verify.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
