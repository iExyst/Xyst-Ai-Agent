const { copyFileSync, mkdirSync, rmSync } = require("node:fs");
const { join } = require("node:path");

const fileName = process.platform === "win32" ? "node.exe" : "node";
const runtimeDirectory = join(__dirname, "..", "runtime");
mkdirSync(runtimeDirectory, { recursive: true });
rmSync(join(runtimeDirectory, fileName === "node" ? "node.exe" : "node"), { force: true });
copyFileSync(process.execPath, join(runtimeDirectory, fileName));
process.stdout.write(`Bundled ${process.version} runtime for ${process.platform}-${process.arch}.\n`);
