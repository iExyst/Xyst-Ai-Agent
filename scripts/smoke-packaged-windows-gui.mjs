import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, relative, isAbsolute, basename } from "node:path";

if (process.platform !== "win32") throw new Error("The packaged Windows UI smoke only runs on Windows.");

const root = process.cwd();
const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
const packageDir = resolve(process.env.XYST_PACKAGE_DIR ?? join(root, "release"));
const installer = join(packageDir, `Xyst Setup ${version}.exe`);
const scratch = await mkdtemp(join(tmpdir(), "xyst-clean-install-"));
const scratchRoot = resolve(tmpdir());
const scratchPath = resolve(scratch);
const scratchRelative = relative(scratchRoot, scratchPath);
if (!scratchRelative || scratchRelative.startsWith("..") || isAbsolute(scratchRelative) || !basename(scratchPath).startsWith("xyst-clean-install-")) {
  throw new Error(`Refusing to use an unexpected clean-install scratch directory: ${scratchPath}`);
}
const installDir = join(scratch, "installed-app");
const installedExe = join(installDir, "Xyst.exe");
const packagedResources = join(installDir, "resources", "app.asar.unpacked");
const bundledNode = join(packagedResources, "apps", "desktop", "runtime", "node.exe");
const packagedCli = join(packagedResources, "apps", "cli", "dist", "index.js");
const dataDir = join(scratch, "data");
const workDir = join(scratch, "workspace");
const env = {
  ...process.env,
  LOCALAPPDATA: join(scratch, "localappdata"),
  APPDATA: join(scratch, "appdata"),
  XYST_ROOT: dataDir,
  LM_STUDIO_BASE_URL: "http://127.0.0.1:9"
};
let app;

async function waitForTarget(port, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
        if (page) return page;
      }
    } catch (error) { lastError = error; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 400));
  }
  throw new Error(`Packaged Xyst renderer did not expose its debug target in time: ${String(lastError ?? "no page target")}`);
}

async function cdpCommand(page, method, params, id) {
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  try {
    await new Promise((resolveOpen, rejectOpen) => {
      const timeout = setTimeout(() => rejectOpen(new Error("Timed out connecting to packaged renderer")), 10_000);
      socket.addEventListener("open", () => { clearTimeout(timeout); resolveOpen(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timeout); rejectOpen(new Error("Could not connect to packaged renderer")); }, { once: true });
    });
    const message = new Promise((resolveMessage, rejectMessage) => {
      const timeout = setTimeout(() => rejectMessage(new Error(`Timed out running ${method} in packaged renderer`)), 10_000);
      const onMessage = (event) => {
        const packet = JSON.parse(String(event.data));
        if (packet.id !== id) return;
        clearTimeout(timeout);
        socket.removeEventListener("message", onMessage);
        if (packet.error) rejectMessage(new Error(packet.error.message));
        else resolveMessage(packet.result);
      };
      socket.addEventListener("message", onMessage);
    });
    socket.send(JSON.stringify({ id, method, params }));
    return await message;
  } finally { socket.close(); }
}

async function evaluate(page, expression, id) {
  const result = await cdpCommand(page, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, id);
  if (result?.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "Renderer evaluation failed");
  return result?.result?.value ?? result?.result;
}

function runInstalledCli(args) {
  const result = spawnSync(bundledNode, ["--experimental-wasm-modules", packagedCli, "--json", ...args], {
    cwd: workDir,
    env,
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Installed CLI ${args[0]} ${args[1]} failed (${result.status}): ${(result.stderr || result.stdout).slice(-4000)}`);
  try {
    const response = JSON.parse(result.stdout.trim());
    return response?.type === "result" && Object.hasOwn(response, "data") ? response.data : response;
  }
  catch (error) { throw new Error(`Installed CLI returned invalid JSON for ${args[0]} ${args[1]}: ${result.stdout.slice(-4000)}`, { cause: error }); }
}

async function waitForUi(page, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let snapshot;
  while (Date.now() < deadline) {
    try {
      snapshot = JSON.parse(await evaluate(page, "JSON.stringify({ title: document.title, buttons: document.querySelectorAll('button').length, width: window.innerWidth, height: window.innerHeight, body: document.body.innerText.slice(0, 4000) })", 1));
      if (snapshot.title === "Xyst Control Room" && snapshot.buttons >= 10 && snapshot.body.includes("RUNTIME READY")) return { title: snapshot.title, buttons: snapshot.buttons, width: snapshot.width, height: snapshot.height };
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`Packaged renderer did not reach the expected control room UI: ${JSON.stringify(snapshot ?? {})}`);
}

function stopInstalledCopies(executable) {
  const escaped = executable.replace(/'/g, "''");
  const command = `$target = '${escaped}'; Get-CimInstance Win32_Process -Filter "Name='Xyst.exe'" | Where-Object { $_.ExecutablePath -eq $target } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
  return spawnSync("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], { stdio: "ignore", windowsHide: true });
}

try {
  await access(installer);
  await mkdir(workDir, { recursive: true });
  await mkdir(env.APPDATA, { recursive: true });
  const setup = spawnSync(installer, ["/S", `/D=${installDir}`], { cwd: root, env, stdio: "inherit", timeout: 180_000, windowsHide: true });
  if (setup.error) throw setup.error;
  if (setup.status !== 0) throw new Error(`Silent clean installation failed with exit code ${setup.status}`);

  // NSIS can launch the app after installation. Stop that copy before seeding
  // the isolated profile through the bundled CLI, then verify the installed
  // renderer reads the same persisted session.
  stopInstalledCopies(installedExe);
  await new Promise((resolveWait) => setTimeout(resolveWait, 800));

  const sessionTitle = `Clean install profile sharing ${Date.now()}`;
  const createdSession = runInstalledCli(["session", "new", sessionTitle]);
  assert.equal(createdSession.created, true, "Bundled CLI did not create a session in the isolated install profile");
  assert.equal(typeof createdSession.id, "string", "Bundled CLI did not return the new session ID");

  // Start the installed executable with the isolated profile and DevTools enabled.
  let executable;
  try { await access(installedExe); executable = installedExe; } catch {}
  assert.ok(executable, `Installed Xyst.exe was not found under ${process.env.LOCALAPPDATA}`);

  const port = 9222;
  app = spawn(executable, [`--remote-debugging-port=${port}`, "--remote-allow-origins=*", "--disable-gpu"], {
    cwd: workDir,
    env,
    windowsHide: true,
    stdio: "ignore"
  });
  const appError = new Promise((_, reject) => app.once("error", reject));
  const page = await Promise.race([waitForTarget(port), appError]);
  const snapshot = await waitForUi(page);
  const visibleSessionIds = JSON.parse(await evaluate(page, "(() => window.xyst.snapshot().then(value => JSON.stringify(value.sessions.map(session => session.id))))()", 3));
  assert.ok(visibleSessionIds.includes(createdSession.id), "Clean-installed desktop did not read the session created by its bundled CLI from the isolated persisted profile");
  const screenshot = await cdpCommand(page, "Page.captureScreenshot", { format: "png", fromSurface: true }, 2);
  assert.ok(screenshot?.data, "Packaged renderer did not return a screenshot");
  await writeFile(join(packageDir, "windows-gui-smoke.png"), Buffer.from(screenshot.data, "base64"));
  process.stdout.write(`Clean Windows install and CLI/desktop profile-sharing smoke passed: ${JSON.stringify({ ...snapshot, sharedSessionId: createdSession.id })}\n`);
} finally {
  if (app?.pid) spawnSync("taskkill.exe", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  if (app?.pid) stopInstalledCopies(installedExe);
  const finalScratchPath = resolve(scratch);
  const finalScratchRelative = relative(scratchRoot, finalScratchPath);
  if (finalScratchPath !== scratchPath || !finalScratchRelative || finalScratchRelative.startsWith("..") || isAbsolute(finalScratchRelative) || !basename(finalScratchPath).startsWith("xyst-clean-install-")) {
    throw new Error(`Refusing to remove an unexpected clean-install scratch directory: ${finalScratchPath}`);
  }
  await rm(finalScratchPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
