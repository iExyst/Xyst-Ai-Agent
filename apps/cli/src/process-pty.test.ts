import assert from "node:assert/strict";
import { test } from "node:test";
import * as nodePty from "node-pty";

test("native PTY provides TTY input, output, and resizable dimensions", async () => {
  const source = `
    process.stdin.setRawMode(true);
    process.stdout.write("TTY_READY=" + Number(process.stdin.isTTY && process.stdout.isTTY) + ":" + process.stdout.columns + "x" + process.stdout.rows + "\\n");
    process.stdout.on("resize", () => process.stdout.write("RESIZED=" + process.stdout.columns + "x" + process.stdout.rows + "\\n"));
    process.stdin.on("data", (value) => {
      const key = value.toString();
      if (key === "x") process.stdout.write("INPUT_RECEIVED\\n");
      if (key === "r") process.stdout.write("SIZE=" + process.stdout.columns + "x" + process.stdout.rows + "\\n");
      if (key === "q") process.exit(0);
    });
  `;
  const terminal = nodePty.spawn(process.execPath, ["-e", source], {
    name: "xterm-256color", cols: 84, rows: 26, cwd: process.cwd(), env: process.env,
    ...(process.platform === "win32" ? { useConpty: true } : { encoding: "utf8" })
  });
  let output = "";
  let exited: { exitCode: number; signal?: number } | undefined;
  terminal.onData((chunk) => { output += chunk; });
  const exitPromise = new Promise<{ exitCode: number; signal?: number }>((resolveExit) => terminal.onExit((event) => { exited = event; resolveExit(event); }));
  const waitFor = async (pattern: RegExp, timeoutMs = 4000) => {
    const deadline = Date.now() + timeoutMs;
    while (!pattern.test(output) && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    assert.match(output, pattern);
  };
  try {
    await waitFor(/TTY_READY=1:84x26/);
    terminal.write("x"); await waitFor(/INPUT_RECEIVED/);
    terminal.resize(111, 37);
    if (process.platform !== "win32") await waitFor(/RESIZED=111x37/);
    terminal.write("r");
    if (process.platform === "win32") await waitFor(/\u001b\[8;37;111t/);
    else await waitFor(/SIZE=111x37/);
    terminal.write("q");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try { exited = await Promise.race([exitPromise, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`PTY child did not exit; output: ${JSON.stringify(output)}`)), 4000); })]); }
    finally { if (timeout) clearTimeout(timeout); }
    assert.equal(exited.exitCode, 0, output);
  } finally {
    if (!exited) terminal.kill();
    else if (process.platform === "win32") {
      const internal = terminal as unknown as { _agent?: { _conoutSocketWorker?: { dispose?: () => void } } };
      internal._agent?._conoutSocketWorker?.dispose?.();
    }
  }
});
