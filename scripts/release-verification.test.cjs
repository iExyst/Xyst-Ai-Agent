const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdtemp, mkdir, rm, writeFile } = require("node:fs/promises");
const { spawnSync } = require("node:child_process");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const test = require("node:test");

const root = resolve(__dirname, "..");
const packageVersion = JSON.parse(require("node:fs").readFileSync(join(root, "package.json"), "utf8")).version;
const run = (script, args, env = process.env) => spawnSync(process.execPath, [join(root, "scripts", script), ...args], { cwd: root, env, encoding: "utf8" });

test("composite typechecks use metadata separate from package builds", () => {
  for (const packagePath of [join(root, "packages", "runtime", "package.json"), join(root, "apps", "cli", "package.json")]) {
    const scripts = JSON.parse(require("node:fs").readFileSync(packagePath, "utf8")).scripts;
    assert.match(scripts.typecheck, /--tsBuildInfoFile\s+tsconfig\.typecheck\.tsbuildinfo/);
  }
});

test("release metadata verifier checks both platform artifact hashes and sizes", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "xyst-release-metadata-"));
  try {
    for (const platform of ["windows", "linux"]) {
      const output = join(scratch, platform);
      await mkdir(output);
      const artifact = platform === "windows" ? `Xyst Setup ${packageVersion}.exe` : `Xyst-${packageVersion}.AppImage`;
      const manifestName = platform === "windows" ? "latest.yml" : "latest-linux.yml";
      const bytes = Buffer.from(`xyst ${platform} release test artifact`);
      const sha512 = createHash("sha512").update(bytes).digest("base64");
      await writeFile(join(output, artifact), bytes);
      await writeFile(join(output, manifestName), [
        `version: "${packageVersion}"`,
        "files:",
        `  - url: "${artifact}"`,
        `    sha512: "${sha512}"`,
        `    size: ${bytes.length}`,
        ""
      ].join("\n"));

      const result = run("verify-release-metadata.cjs", [platform, output]);
      assert.equal(result.status, 0, `${platform}: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`${platform} release metadata verified`));
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("release metadata verifier rejects altered hashes and sizes", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "xyst-release-metadata-invalid-"));
  try {
    const platform = "linux";
    const artifact = `Xyst-${packageVersion}.AppImage`;
    const bytes = Buffer.from("unchanged artifact bytes");
    const output = join(scratch, "linux");
    await mkdir(output);
    await writeFile(join(output, artifact), bytes);
    const correctHash = createHash("sha512").update(bytes).digest("base64");
    const manifest = (hash, size) => [
      `version: "${packageVersion}"`,
      "files:",
      `  - url: "${artifact}"`,
      `    sha512: "${hash}"`,
      `    size: ${size}`,
      ""
    ].join("\n");
    const manifestPath = join(output, "latest-linux.yml");

    await writeFile(manifestPath, manifest("invalid-hash", bytes.length));
    assert.notEqual(run("verify-release-metadata.cjs", [platform, output]).status, 0);
    await writeFile(manifestPath, manifest(correctHash, bytes.length + 1));
    assert.notEqual(run("verify-release-metadata.cjs", [platform, output]).status, 0);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("desktop package metadata generator honors electron-builder output override", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "xyst-release-output-"));
  try {
    const artifact = `Xyst Setup ${packageVersion}.exe`;
    await writeFile(join(scratch, artifact), Buffer.from("isolated package artifact"));
    const configPath = join(scratch, "electron-builder.json");
    await writeFile(configPath, JSON.stringify({ directories: { output: scratch } }));
    const result = spawnSync(process.execPath, [
      join(root, "apps", "desktop", "scripts", "generate-update-metadata.cjs"),
      "--win",
      "-c",
      configPath
    ], { cwd: join(root, "apps", "desktop"), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Generated latest\.yml/);
    assert.equal(require("node:fs").existsSync(join(scratch, "latest.yml")), true);
    const verified = run("verify-release-metadata.cjs", ["windows", scratch]);
    assert.equal(verified.status, 0, verified.stderr);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("release tag verifier requires an exact package-version tag", async () => {
  const matching = run("verify-release-tag.cjs", [], { ...process.env, GITHUB_REF_NAME: `v${packageVersion}` });
  assert.equal(matching.status, 0, matching.stderr);

  const mismatched = run("verify-release-tag.cjs", [], { ...process.env, GITHUB_REF_NAME: "v9.9.9" });
  assert.notEqual(mismatched.status, 0);
  assert.match(mismatched.stderr, /must match package version/);

  const missingEnvironment = { ...process.env };
  delete missingEnvironment.GITHUB_REF_NAME;
  const missing = run("verify-release-tag.cjs", [], missingEnvironment);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /GITHUB_REF_NAME is required/);
});
