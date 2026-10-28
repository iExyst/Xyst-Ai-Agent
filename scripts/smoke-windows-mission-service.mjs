import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") throw new Error("Windows mission-service smoke must run on Windows");

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = join(repositoryRoot, "apps", "cli", "dist", "index.js");
const temporaryRoot = await mkdtemp(join(tmpdir(), "xyst-windows-mission-service-"));
const workspace = join(temporaryRoot, "workspace");
const env = { ...process.env, XYST_ROOT: workspace };
await mkdir(workspace, { recursive: true });

function runCli(args) {
  const result = spawnSync(process.execPath, [cliEntry, ...args, "--json"], {
    cwd: workspace,
    env,
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`xyst ${args.join(" ")} failed (${result.status}): ${(result.stderr || result.stdout).trim().slice(0, 2000)}`);
  }
  const lines = result.stdout.trim().split(/\r?\n/);
  let parsed;
  try { parsed = JSON.parse(lines.at(-1)); }
  catch { throw new Error(`xyst ${args.join(" ")} returned invalid JSON: ${result.stdout.slice(0, 2000)}`); }
  if (parsed?.type !== "result" || parsed.data == null) {
    throw new Error(`xyst ${args.join(" ")} returned an unexpected response: ${result.stdout.slice(0, 2000)}`);
  }
  return parsed.data;
}

let taskMayExist = false;
let failure;
try {
  const initial = runCli(["mission", "service", "status"]);
  assert.equal(initial.installed, false, "refusing to replace a preexisting Xyst Mission Daemon task");

  taskMayExist = true;
  const installed = runCli(["mission", "service", "install"]);
  assert.deepEqual([installed.installed, installed.manager, installed.started], [true, "task-scheduler", true]);

  const deadline = Date.now() + 30_000;
  let status;
  do {
    status = runCli(["mission", "service", "status"]);
    if (status.state === "Running") break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } while (Date.now() < deadline);
  assert.equal(status?.state, "Running", `expected scheduled daemon to be Running, got ${JSON.stringify(status)}`);

  const removed = runCli(["mission", "service", "uninstall"]);
  assert.deepEqual([removed.installed, removed.manager], [false, "task-scheduler"]);
  taskMayExist = false;
  assert.equal(runCli(["mission", "service", "status"]).installed, false, "Task Scheduler task must be absent after uninstall");
  console.log("Windows Task Scheduler installed, ran, reported Running, and uninstalled the Xyst mission daemon.");
} catch (error) {
  failure = error;
} finally {
  if (taskMayExist) {
    try { runCli(["mission", "service", "uninstall"]); }
    catch (error) { failure = failure ? new AggregateError([failure, error], "Mission service smoke and cleanup both failed") : error; }
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}

if (failure) throw failure;
