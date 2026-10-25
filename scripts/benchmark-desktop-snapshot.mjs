import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const DEFAULT_SAMPLES = 8;

function parseArgs(argv) {
  const options = { samples: DEFAULT_SAMPLES };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    const value = argv[++index];
    if (!value) throw new Error(`Missing value for ${key}`);
    if (key === "--runtime") options.runtime = value;
    else if (key === "--cli") options.cli = value;
    else if (key === "--samples") options.samples = Number(value);
    else throw new Error(`Unknown option: ${key}`);
  }
  if (!options.runtime || !options.cli) throw new Error("Usage: node scripts/benchmark-desktop-snapshot.mjs --runtime <node-path> --cli <cli-entry> [--samples 2-100]");
  if (!Number.isSafeInteger(options.samples) || options.samples < 2 || options.samples > 100) throw new Error("--samples must be an integer from 2 through 100");
  if (process.platform !== "win32" && process.platform !== "linux") throw new Error("The benchmark supports Windows and Linux hosts only");
  options.runtime = resolve(options.runtime);
  options.cli = resolve(options.cli);
  return options;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function runSnapshot(runtime, cli, cwd, env) {
  return new Promise((resolveResult, rejectResult) => {
    const started = performance.now();
    const child = spawn(runtime, ["--experimental-wasm-modules", cli, "desktop", "snapshot"], {
      cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    let capturedBytes = 0;
    let overflow = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 30_000);
    const collect = (target) => (chunk) => {
      capturedBytes += chunk.length;
      if (capturedBytes > MAX_CAPTURE_BYTES) {
        overflow = true;
        child.kill();
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectResult(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) return rejectResult(new Error("desktop snapshot exceeded the 30 second benchmark timeout"));
      if (overflow) return rejectResult(new Error(`desktop snapshot exceeded the ${MAX_CAPTURE_BYTES} byte output limit`));
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) return rejectResult(new Error(`desktop snapshot exited ${code ?? signal}: ${err.slice(-1200)}`));
      try {
        const snapshot = JSON.parse(out);
        if (snapshot?.status?.runtime !== "ready") throw new Error("snapshot did not report a ready runtime");
        resolveResult({ elapsedMs: performance.now() - started, outputBytes: Buffer.byteLength(out), snapshot });
      } catch (error) {
        rejectResult(new Error(`desktop snapshot returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tempRoot = await realpath(tmpdir());
  const isolatedRoot = await mkdtemp(join(tempRoot, "xyst-dashboard-bench-"));
  try {
    await mkdir(join(isolatedRoot, "workspace"), { recursive: true });
    const env = { ...process.env, XYST_ROOT: join(isolatedRoot, "workspace"), LM_STUDIO_BASE_URL: "http://127.0.0.1:9" };
    if (process.platform === "win32") {
      env.APPDATA = join(isolatedRoot, "appdata");
      env.LOCALAPPDATA = join(isolatedRoot, "local-appdata");
    } else {
      env.HOME = join(isolatedRoot, "home");
      env.XDG_DATA_HOME = join(isolatedRoot, "data");
      env.XDG_CONFIG_HOME = join(isolatedRoot, "config");
      env.XDG_CACHE_HOME = join(isolatedRoot, "cache");
    }
    const results = [];
    for (let index = 0; index < options.samples; index++) {
      results.push(await runSnapshot(options.runtime, options.cli, isolatedRoot, env));
    }
    const timings = results.map(({ elapsedMs }) => Math.round(elapsedMs * 10) / 10);
    const warm = timings.slice(1);
    const resourceSnapshot = results[0].snapshot.systemResources ?? null;
    const report = {
      platform: process.platform,
      runtime: options.runtime,
      cli: options.cli,
      samples: timings.length,
      coldMs: timings[0],
      warmMedianMs: Math.round(median(warm) * 10) / 10,
      warmMinMs: Math.min(...warm),
      warmMaxMs: Math.max(...warm),
      snapshotOutputBytes: results[0].outputBytes,
      resourceSnapshot,
      modelServer: "http://127.0.0.1:9 (unreachable; no model query or inference)"
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    const resolvedRoot = await realpath(isolatedRoot);
    const childPath = relative(tempRoot, resolvedRoot);
    if (!childPath || childPath.startsWith(`..${sep}`) || isAbsolute(childPath) || dirname(resolvedRoot) !== tempRoot || !basename(resolvedRoot).startsWith("xyst-dashboard-bench-")) {
      throw new Error("Refusing to remove a benchmark directory outside the temporary root");
    }
    await rm(resolvedRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
