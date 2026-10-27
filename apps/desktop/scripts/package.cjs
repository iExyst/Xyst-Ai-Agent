const { spawnSync } = require("node:child_process");
const { resolve } = require("node:path");

const appRoot = resolve(__dirname, "..");
const repoRoot = resolve(appRoot, "../..");
const builderCli = resolve(repoRoot, "node_modules/electron-builder/cli.js");
const args = process.argv.slice(2);

const build = spawnSync(process.execPath, [builderCli, "--publish", "never", ...args], { cwd: appRoot, stdio: "inherit" });
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const metadata = spawnSync(process.execPath, [resolve(__dirname, "generate-update-metadata.cjs"), ...args], { cwd: appRoot, stdio: "inherit" });
if (metadata.error) throw metadata.error;
if (metadata.status !== 0) process.exit(metadata.status ?? 1);
