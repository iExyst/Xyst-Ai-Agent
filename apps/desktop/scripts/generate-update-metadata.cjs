const { createHash } = require("node:crypto");
const { readFileSync, readdirSync, statSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const appRoot = resolve(__dirname, "..");
const repoRoot = resolve(appRoot, "../..");
const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
const args = process.argv.slice(2);
const outputArgument = args.find((arg) => arg.startsWith("-c.directories.output=") || arg.startsWith("--config.directories.output="));
const configIndex = args.findIndex((arg) => arg === "-c" || arg === "--config");
const configArgument = configIndex >= 0 ? args[configIndex + 1] : args.find((arg) => arg.startsWith("--config="))?.slice("--config=".length);
const configOutput = configArgument ? JSON.parse(readFileSync(resolve(appRoot, configArgument), "utf8")).directories?.output : undefined;
const configuredOutput = outputArgument ? outputArgument.slice(outputArgument.indexOf("=") + 1) : configOutput;
const outputPath = typeof configuredOutput === "string" ? configuredOutput : "../../release";
const outputDir = resolve(appRoot, outputPath);
const targets = args.includes("--win") || args.includes("--windows") ? ["win"] : args.includes("--linux") ? ["linux"] : [process.platform === "win32" ? "win" : "linux"];

function manifestFor(fileName) {
  const fullPath = join(outputDir, fileName);
  const info = statSync(fullPath);
  const sha512 = createHash("sha512").update(readFileSync(fullPath)).digest("base64");
  const date = new Date(info.mtimeMs).toISOString();
  return [
    `version: ${JSON.stringify(version)}`,
    "files:",
    `  - url: ${JSON.stringify(fileName)}`,
    `    sha512: ${JSON.stringify(sha512)}`,
    `    size: ${info.size}`,
    `path: ${JSON.stringify(fileName)}`,
    `sha512: ${JSON.stringify(sha512)}`,
    `releaseDate: ${JSON.stringify(date)}`,
    ""
  ].join("\n");
}

for (const target of targets) {
  const files = readdirSync(outputDir);
  const pattern = target === "win" ? new RegExp(`^Xyst Setup ${version.replaceAll(".", "\\.")}\\.exe$`, "i") : new RegExp(`^Xyst-${version.replaceAll(".", "\\.")}\\.AppImage$`, "i");
  const artifact = files.find((file) => pattern.test(file));
  if (!artifact) throw new Error(`Cannot generate ${target} update metadata: expected platform artifact was not found in ${outputDir}`);
  const metadataName = target === "win" ? "latest.yml" : "latest-linux.yml";
  writeFileSync(join(outputDir, metadataName), manifestFor(artifact), "utf8");
  process.stdout.write(`Generated ${metadataName} for ${artifact}\n`);
}
