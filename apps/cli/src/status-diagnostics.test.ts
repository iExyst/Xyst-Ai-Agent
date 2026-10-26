import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cliEntry = fileURLToPath(new URL("./index.ts", import.meta.url));
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function runCli(dataHome: string, workspace: string, ...args: string[]) {
  const env = {
    ...process.env,
    XYST_ROOT: workspace,
    ...(process.platform === "win32"
      ? { APPDATA: dataHome, LOCALAPPDATA: resolve(dataHome, "local") }
      : { XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: resolve(dataHome, "config") })
  };
  return spawnSync(process.execPath, ["--experimental-wasm-modules", "--import", "tsx", cliEntry, "--json", ...args], {
    cwd: projectRoot,
    env,
    encoding: "utf8",
    timeout: 20_000
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
