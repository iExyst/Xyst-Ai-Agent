import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

if (process.platform !== "linux") throw new Error("The packaged Linux UI smoke only runs on Linux.");

const root = process.cwd();
const packageDir = resolve(process.env.XYST_PACKAGE_DIR ?? join(root, "release"));
const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
const appImage = join(packageDir, `Xyst-${version}.AppImage`);
const scratch = await mkdtemp(join(tmpdir(), "xyst-linux-clean-install-"));
const port = Number(process.env.XYST_SMOKE_PORT ?? 19370);
const env = {
  ...process.env,
  HOME: join(scratch, "home"),
  XDG_CONFIG_HOME: join(scratch, "config"),
  XDG_DATA_HOME: join(scratch, "data"),
  XDG_CACHE_HOME: join(scratch, "cache"),
  XYST_ROOT: join(scratch, "xyst-data"),
  LM_STUDIO_BASE_URL: "http://127.0.0.1:9"
};
let app;

async function waitForTarget(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (app.exitCode !== null) throw new Error(`Packaged Xyst exited with code ${app.exitCode}`);
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
  throw new Error(`Packaged Xyst renderer did not expose its debug target: ${String(lastError ?? "no page target")}`);
}

async function evaluate(page, expression, id) {
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  try {
    await new Promise((resolveOpen, rejectOpen) => {
      const timeout = setTimeout(() => rejectOpen(new Error("Timed out connecting to packaged renderer")), 10_000);
      socket.addEventListener("open", () => { clearTimeout(timeout); resolveOpen(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timeout); rejectOpen(new Error("Could not connect to packaged renderer")); }, { once: true });
    });
    const response = new Promise((resolveMessage, rejectMessage) => {
      const timeout = setTimeout(() => rejectMessage(new Error("Timed out evaluating packaged renderer")), 10_000);
      const onMessage = (event) => {
        const packet = JSON.parse(String(event.data));
        if (packet.id !== id) return;
        clearTimeout(timeout); socket.removeEventListener("message", onMessage);
        if (packet.error) rejectMessage(new Error(packet.error.message));
        else resolveMessage(packet.result);
      };
      socket.addEventListener("message", onMessage);
    });
    socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    const result = await response;
    if (result?.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.text ?? "Renderer evaluation failed");
    return result?.result?.value;
  } finally { socket.close(); }
}

try {
  await access(appImage);
  app = spawn(appImage, ["--appimage-extract-and-run", "--no-sandbox", `--remote-debugging-port=${port}`, "--remote-allow-origins=*"], {
    cwd: scratch,
    env,
    detached: true,
    stdio: "ignore"
  });
  const appError = new Promise((_, reject) => app.once("error", reject));
  const page = await Promise.race([waitForTarget(), appError]);
  const deadline = Date.now() + 45_000;
  let snapshot;
  while (Date.now() < deadline) {
    try {
      snapshot = JSON.parse(await evaluate(page, "JSON.stringify({title:document.title,buttons:document.querySelectorAll('button').length,width:innerWidth,height:innerHeight,body:document.body.innerText.slice(0,4000)})", 1));
      if (snapshot.title === "Xyst Control Room" && snapshot.buttons >= 10 && snapshot.body.includes("RUNTIME READY")) break;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 400));
  }
  assert.equal(snapshot?.title, "Xyst Control Room");
  assert.ok(snapshot.buttons >= 10, `Expected the control room UI; got ${JSON.stringify(snapshot)}`);
  assert.ok(snapshot.body.includes("RUNTIME READY"), `Packaged runtime did not become ready: ${snapshot.body}`);
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  try {
    await new Promise((resolveOpen, rejectOpen) => { socket.addEventListener("open", resolveOpen, { once: true }); socket.addEventListener("error", rejectOpen, { once: true }); });
    const result = new Promise((resolveMessage, rejectMessage) => {
      const onMessage = (event) => { const packet = JSON.parse(String(event.data)); if (packet.id !== 3) return; socket.removeEventListener("message", onMessage); packet.error ? rejectMessage(new Error(packet.error.message)) : resolveMessage(packet.result?.data); };
      socket.addEventListener("message", onMessage);
    });
    socket.send(JSON.stringify({ id: 3, method: "Page.captureScreenshot", params: { format: "png", fromSurface: true } }));
    const image = await result;
    assert.ok(image, "Packaged renderer did not return a screenshot");
    await writeFile(join(packageDir, "linux-gui-smoke.png"), Buffer.from(image, "base64"));
  } finally { socket.close(); }
  process.stdout.write(`Linux AppImage renderer smoke passed: ${JSON.stringify({ title: snapshot.title, buttons: snapshot.buttons, width: snapshot.width, height: snapshot.height, screenshot: join(packageDir, "linux-gui-smoke.png") })}\n`);
} finally {
  if (app?.pid) {
    try { process.kill(-app.pid, "SIGTERM"); } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 750));
    if (app.exitCode === null) { try { process.kill(-app.pid, "SIGKILL"); } catch {} }
  }
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
