const { createHash } = require("node:crypto");
const { createReadStream, readFileSync, statSync } = require("node:fs");
const { join, resolve } = require("node:path");

const [platform, outputArgument = "release"] = process.argv.slice(2);
if (platform !== "windows" && platform !== "linux") throw new Error("Usage: node scripts/verify-release-metadata.cjs <windows|linux> [output-directory]");

async function main() {
  const root = resolve(__dirname, "..");
  const outputDir = resolve(root, outputArgument);
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const artifact = platform === "windows" ? `Xyst Setup ${version}.exe` : `Xyst-${version}.AppImage`;
  const manifestName = platform === "windows" ? "latest.yml" : "latest-linux.yml";
  const artifactPath = join(outputDir, artifact);
  const manifest = readFileSync(join(outputDir, manifestName), "utf8");
  const info = statSync(artifactPath);
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(artifactPath)) hash.update(chunk);
  const sha512 = hash.digest("base64");

  for (const expected of [
    `version: "${version}"`,
    `- url: "${artifact}"`,
    `sha512: "${sha512}"`,
    `size: ${info.size}`
  ]) {
    if (!manifest.split(/\r?\n/).some((line) => line.trim() === expected)) {
      throw new Error(`${manifestName} does not match ${artifact}: missing ${expected}`);
    }
  }
  process.stdout.write(`${platform} release metadata verified: ${artifact} (${info.size} bytes, SHA-512 ${sha512})\n`);
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
