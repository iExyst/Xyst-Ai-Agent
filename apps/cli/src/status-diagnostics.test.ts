import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cliEntry = fileURLToPath(new URL("./index.ts", import.meta.url));
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function runCli(dataHome: string, workspace: string, ...args: string[]) {
  return runCliWithEnv(dataHome, workspace, {}, ...args);
}

function runCliWithEnv(dataHome: string, workspace: string, extraEnv: NodeJS.ProcessEnv, ...args: string[]) {
  const env = {
    ...process.env,
    XYST_ROOT: workspace,
    ...(process.platform === "win32"
      ? { APPDATA: dataHome, LOCALAPPDATA: resolve(dataHome, "local") }
      : { XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: resolve(dataHome, "config") }),
    ...extraEnv
  };
  return spawnSync(process.execPath, ["--experimental-wasm-modules", "--import", "tsx", cliEntry, "--json", ...args], {
    cwd: projectRoot,
    env,
    encoding: "utf8",
    timeout: 20_000
  });
}

function runCliAsync(dataHome: string, workspace: string, extraEnv: NodeJS.ProcessEnv, ...args: string[]) {
  const env = {
    ...process.env,
    XYST_ROOT: workspace,
    ...(process.platform === "win32"
      ? { APPDATA: dataHome, LOCALAPPDATA: resolve(dataHome, "local") }
      : { XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: resolve(dataHome, "config") }),
    ...extraEnv
  };
  return new Promise<{ stdout: string; stderr: string; status: number | null; error?: Error }>((resolveResult) => {
    const child = spawn(process.execPath, ["--experimental-wasm-modules", "--import", "tsx", cliEntry, "--json", ...args], {
      cwd: projectRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: { stdout: string; stderr: string; status: number | null; error?: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveResult(result);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish({ stdout, stderr, status: null, error: new Error("CLI process timed out after 60 seconds") });
    }, 60_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => finish({ stdout, stderr, status: null, error }));
    child.once("close", (status) => finish({ stdout, stderr, status }));
  });
}

test("status and desktop snapshot report corrupt SQLite without changing it or starting the runtime", () => {
  const root = mkdtempSync(resolve(tmpdir(), "xyst-status-corrupt-"));
  const dataHome = resolve(root, "data");
  const workspace = resolve(root, "workspace");
  const appDataName = process.platform === "win32" ? "xyst" : "xyst";
  const databasePath = resolve(dataHome, appDataName, "xyst.sqlite");
  mkdirSync(dirname(databasePath), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(databasePath, Buffer.from("deliberately-invalid-sqlite-fixture"));
  const originalHash = createHash("sha256").update(readFileSync(databasePath)).digest("hex");

  try {
    const status = runCli(dataHome, workspace, "status");
    assert.equal(status.error, undefined, status.error?.message);
    assert.equal(status.status, 1);
    const statusData = JSON.parse(status.stdout).data;
    assert.equal(statusData.runtime, "unavailable");
    assert.equal(statusData.database, "corrupt");
    assert.equal(statusData.databaseIntegrity.status, "corrupt");
    assert.match(statusData.error, /read-only integrity report/);

    const snapshot = runCli(dataHome, workspace, "desktop", "snapshot");
    assert.equal(snapshot.error, undefined, snapshot.error?.message);
    assert.equal(snapshot.status, 0);
    const snapshotData = JSON.parse(snapshot.stdout).data;
    assert.equal(snapshotData.status.runtime, "unavailable");
    assert.equal(snapshotData.status.database, "corrupt");
    assert.deepEqual(snapshotData.sessions, []);
    assert.deepEqual(snapshotData.missions, []);

    assert.equal(createHash("sha256").update(readFileSync(databasePath)).digest("hex"), originalHash);
    assert.equal(existsSync(`${databasePath}-wal`), false);
    assert.equal(existsSync(`${databasePath}-shm`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("desktop snapshot preserves LM Studio loaded instances for the renderer model dock", async () => {
  const server = createServer((request, response) => {
    if (request.url !== "/api/v1/models") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ models: [{
      type: "llm", publisher: "qwen", key: "qwen/qwen3.5-9b", display_name: "Qwen3.5 9B",
      size_bytes: 1_000_000, loaded_instances: [{ id: "qwen/qwen3.5-9b:2", config: { context_length: 16_384 } }],
      max_context_length: 262_144, capabilities: { trained_for_tool_use: true }
    }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const root = mkdtempSync(resolve(tmpdir(), "xyst-snapshot-loaded-model-"));
  const dataHome = resolve(root, "data");
  const workspace = resolve(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  try {
    const localUrl = `http://127.0.0.1:${address.port}`;
    const result = await runCliAsync(dataHome, workspace, {
      LM_STUDIO_BASE_URL: localUrl,
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost"
    }, "desktop", "snapshot");
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    const snapshot = JSON.parse(result.stdout).data;
    assert.equal(snapshot.models.length, 1, `Expected the mock LM Studio model in the snapshot: ${JSON.stringify(snapshot)}`);
    assert.deepEqual(snapshot.models[0].loaded_instances, [{ id: "qwen/qwen3.5-9b:2", config: { context_length: 16_384 } }]);
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent help exits before initializing the runtime or creating a session", () => {
  const root = mkdtempSync(resolve(tmpdir(), "xyst-agent-help-"));
  const dataHome = resolve(root, "data");
  const workspace = resolve(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const databasePath = resolve(dataHome, "xyst", "xyst.sqlite");

  try {
    const result = runCli(dataHome, workspace, "agent", "run", "--help");
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: xyst/);
    assert.equal(existsSync(databasePath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
