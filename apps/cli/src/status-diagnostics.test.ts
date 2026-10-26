import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRuntime } from "@xyst/runtime";

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

test("CLI help works without opening a corrupt profile or starting an agent", () => {
  const root = mkdtempSync(resolve(tmpdir(), "xyst-help-corrupt-"));
  const dataHome = resolve(root, "data");
  const workspace = resolve(root, "workspace");
  const databasePath = resolve(dataHome, "xyst", "xyst.sqlite");
  mkdirSync(dirname(databasePath), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(databasePath, Buffer.from("deliberately-invalid-sqlite-fixture"));
  const originalHash = createHash("sha256").update(readFileSync(databasePath)).digest("hex");

  try {
    const help = runCli(dataHome, workspace, "agent", "run", "--help");
    assert.equal(help.error, undefined, help.error?.message);
    assert.equal(help.status, 0);
    const result = JSON.parse(help.stdout).data;
    assert.match(result, /agent run \[--workspace path\]/);
    assert.doesNotMatch(help.stdout, /available tools include|sessionId|agent\.session/);
    assert.equal(createHash("sha256").update(readFileSync(databasePath)).digest("hex"), originalHash);
    assert.equal(existsSync(`${databasePath}-wal`), false);
    assert.equal(existsSync(`${databasePath}-shm`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("database backup preserves a healthy profile and refuses corrupt or existing destinations", () => {
  const root = mkdtempSync(resolve(tmpdir(), "xyst-database-backup-"));
  const dataHome = resolve(root, "data");
  const workspace = resolve(root, "workspace");
  const databasePath = resolve(dataHome, "xyst", "xyst.sqlite");
  const backupDataHome = resolve(root, "backup-data");
  const backupPath = resolve(backupDataHome, "xyst", "xyst.sqlite");
  const corruptDataHome = resolve(root, "corrupt-data");
  const corruptDatabasePath = resolve(corruptDataHome, "xyst", "xyst.sqlite");
  const rejectedBackupPath = resolve(root, "rejected-backup.sqlite");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(dirname(corruptDatabasePath), { recursive: true });
  let runtime: ReturnType<typeof createRuntime> | undefined;

  try {
    const initialized = runCli(dataHome, workspace, "status");
    assert.equal(initialized.error, undefined, initialized.error?.message);
    assert.equal(initialized.status, 0);
    runtime = createRuntime({ dataDir: resolve(dataHome, "xyst") });
    const sessionId = runtime.sessions.create("Backup fixture", workspace);
    const originalHash = createHash("sha256").update(readFileSync(databasePath)).digest("hex");

    const backup = runCli(dataHome, workspace, "database", "backup", backupPath);
    assert.equal(backup.error, undefined, backup.error?.message);
    assert.equal(backup.status, 0);
    assert.equal(JSON.parse(backup.stdout).data.status, "healthy");
    assert.equal(createHash("sha256").update(readFileSync(databasePath)).digest("hex"), originalHash);

    const backupStatus = runCli(backupDataHome, workspace, "status");
    assert.equal(backupStatus.error, undefined, backupStatus.error?.message);
    assert.equal(backupStatus.status, 0);
    assert.equal(JSON.parse(backupStatus.stdout).data.sessions, 1);
    const backupSession = runCli(backupDataHome, workspace, "session", "list");
    assert.equal(backupSession.error, undefined, backupSession.error?.message);
    assert.equal(backupSession.status, 0);
    assert.equal(JSON.parse(backupSession.stdout).data.some((session: { id: string }) => session.id === sessionId), true);

    const backupHash = createHash("sha256").update(readFileSync(backupPath)).digest("hex");
    const overwrite = runCli(dataHome, workspace, "database", "backup", backupPath);
    assert.equal(overwrite.status, 1);
    assert.match(JSON.parse(overwrite.stdout).data.error, /already exists/);
    assert.equal(createHash("sha256").update(readFileSync(backupPath)).digest("hex"), backupHash);

    const samePath = runCli(dataHome, workspace, "database", "backup", databasePath);
    assert.equal(samePath.status, 1);
    assert.match(JSON.parse(samePath.stdout).data.error, /must differ from the source/);
    assert.equal(createHash("sha256").update(readFileSync(databasePath)).digest("hex"), originalHash);

    writeFileSync(corruptDatabasePath, Buffer.from("deliberately-invalid-sqlite-fixture"));
    const corruptHash = createHash("sha256").update(readFileSync(corruptDatabasePath)).digest("hex");
    const rejected = runCli(corruptDataHome, workspace, "database", "backup", rejectedBackupPath);
    assert.equal(rejected.status, 1);
    assert.match(JSON.parse(rejected.stdout).data.error, /corrupt database/);
    assert.equal(existsSync(rejectedBackupPath), false);
    assert.equal(createHash("sha256").update(readFileSync(corruptDatabasePath)).digest("hex"), corruptHash);
    assert.equal(existsSync(backupPath), true);
  } finally {
    runtime?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("database recover snapshots the complete corrupt profile before quarantining SQLite files and initializing a healthy database", () => {
  const root = mkdtempSync(resolve(tmpdir(), "xyst-database-recover-"));
  const dataHome = resolve(root, "data");
  const workspace = resolve(root, "workspace");
  const dataDirectory = resolve(dataHome, "xyst");
  const databasePath = resolve(dataDirectory, "xyst.sqlite");
  const archiveDirectory = resolve(root, "recovery-archive");
  const existingArchive = resolve(root, "existing-archive");
  mkdirSync(dataDirectory, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(databasePath, Buffer.from("deliberately-invalid-sqlite-fixture"));
  writeFileSync(`${databasePath}-wal`, Buffer.from("committed-wal-sidecar-fixture"));
  writeFileSync(`${databasePath}-shm`, Buffer.from("shared-memory-sidecar-fixture"));
  writeFileSync(resolve(dataDirectory, "profile-note.txt"), "preserve other profile files\n");
  writeFileSync(existingArchive, "pre-existing destination\n");
  const names = ["xyst.sqlite", "xyst.sqlite-wal", "xyst.sqlite-shm", "profile-note.txt"];
  const hashes = new Map(names.map((name) => [name, createHash("sha256").update(readFileSync(resolve(dataDirectory, name))).digest("hex")]));
  const fixtureBytes = names.reduce((sum, name) => sum + readFileSync(resolve(dataDirectory, name)).byteLength, 0);

  try {
    const insideProfile = runCli(dataHome, workspace, "database", "recover", resolve(dataDirectory, "nested-archive"));
    assert.equal(insideProfile.status, 1);
    assert.match(JSON.parse(insideProfile.stdout).data.error, /outside and separate/);
    assert.equal(createHash("sha256").update(readFileSync(databasePath)).digest("hex"), hashes.get("xyst.sqlite"));

    const nestedParent = resolve(dataDirectory, "new-subdirectory");
    const nestedArchive = runCli(dataHome, workspace, "database", "recover", resolve(nestedParent, "recovery"));
    assert.equal(nestedArchive.status, 1);
    assert.match(JSON.parse(nestedArchive.stdout).data.error, /outside and separate/);
    assert.equal(existsSync(nestedParent), false, "refusing an in-profile target must not create parent directories");

    const existing = runCli(dataHome, workspace, "database", "recover", existingArchive);
    assert.equal(existing.status, 1);
    assert.match(JSON.parse(existing.stdout).data.error, /already exists/);
    assert.equal(readFileSync(existingArchive, "utf8"), "pre-existing destination\n");
    assert.equal(createHash("sha256").update(readFileSync(databasePath)).digest("hex"), hashes.get("xyst.sqlite"));

    const recovered = runCli(dataHome, workspace, "database", "recover", archiveDirectory);
    assert.equal(recovered.error, undefined, recovered.error?.message);
    assert.equal(recovered.status, 0);
    const result = JSON.parse(recovered.stdout).data;
    assert.equal(result.status, "healthy");
    assert.equal(result.database, databasePath);
    assert.equal(result.archiveDirectory, archiveDirectory);
    assert.equal(result.fullProfileSnapshot, resolve(archiveDirectory, "profile"));
    assert.ok(result.snapshot.files >= names.length);
    assert.ok(result.snapshot.bytes >= fixtureBytes);
    assert.equal(result.quarantinedFiles.length, 3);

    for (const name of names) {
      assert.equal(createHash("sha256").update(readFileSync(resolve(archiveDirectory, "profile", name))).digest("hex"), hashes.get(name));
    }
    for (const path of result.quarantinedFiles as string[]) {
      const originalName = path.slice(dataDirectory.length + 1).replace(/\.corrupt-.+$/, "");
      assert.equal(createHash("sha256").update(readFileSync(path)).digest("hex"), hashes.get(originalName));
    }
    assert.equal(existsSync(databasePath), true);

    const status = runCli(dataHome, workspace, "status");
    assert.equal(status.status, 0);
    const statusData = JSON.parse(status.stdout).data;
    assert.equal(statusData.runtime, "ready");
    assert.equal(statusData.databaseIntegrity.status, "healthy");
    assert.equal(statusData.sessions, 0);
    assert.equal(statusData.missions, 0);
    const freshDatabaseHash = createHash("sha256").update(readFileSync(databasePath)).digest("hex");

    const refuseHealthy = runCli(dataHome, workspace, "database", "recover", resolve(root, "should-not-exist"));
    assert.equal(refuseHealthy.status, 1);
    assert.match(JSON.parse(refuseHealthy.stdout).data.error, /requires a corrupt database/);
    assert.equal(existsSync(resolve(root, "should-not-exist")), false);
    assert.equal(createHash("sha256").update(readFileSync(databasePath)).digest("hex"), freshDatabaseHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
