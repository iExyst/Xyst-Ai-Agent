import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { parseResponsesRequest } from "./responses-options.js";

test("Responses request validation preserves supported request fields and tools", () => {
  const request = { model: "publisher/model", input: [{ role: "user", content: "Continue" }], previous_response_id: "resp_123", reasoning: { effort: "high" }, tools: [{ type: "function", name: "lookup" }] };
  assert.deepEqual(parseResponsesRequest(request), request);
});

test("Responses request validation rejects missing required values and unsupported fields", () => {
  for (const request of [
    {},
    { model: "model" },
    { model: "model", input: 1 },
    { model: "model", input: "hello", stream: true },
    { model: "model", input: "hello", store: "yes" },
    { model: "model", input: "hello", tools: Array.from({ length: 65 }, () => ({ type: "function" })) }
  ]) assert.throws(() => parseResponsesRequest(request));
});

test("lm responses CLI sends regular and streaming requests and emits JSON events", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "xyst-responses-cli-"));
  const work = join(scratch, "work"); const appData = join(scratch, "appdata");
  await mkdir(work); await mkdir(appData);
  await writeFile(join(work, "request.json"), JSON.stringify({ model: "mock-model", input: "fixture prompt", max_output_tokens: 24 }));
  await writeFile(join(work, "request-incomplete.json"), JSON.stringify({ model: "mock-model", input: "fixture incomplete", max_output_tokens: 24 }));
  const received: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8"); request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      received.push(JSON.parse(body) as Record<string, unknown>);
      if (received.at(-1)?.stream !== true) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "resp_fixture", status: received.at(-1)?.input === "fixture incomplete" ? "incomplete" : "completed", output_text: "fixture answer" }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_stream_fixture","status":"in_progress"}}\n\n');
      response.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"fixture stream"}\n\n');
      response.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_stream_fixture","status":"completed"}}\n\n');
    });
  });
  const closeServer = () => new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  try {
    await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const cliEntry = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
    const env = { ...process.env, APPDATA: appData, XYST_ROOT: work, LM_STUDIO_BASE_URL: `http://127.0.0.1:${address.port}` };
    const invoke = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun, reject) => {
      const packagedEntry = process.env.XYST_RESPONSES_CLI_ENTRY;
      const executable = process.env.XYST_RESPONSES_NODE ?? process.execPath;
      const entryArgs = packagedEntry ? [packagedEntry] : ["--import", import.meta.resolve("tsx"), cliEntry];
      const child = spawn(executable, ["--experimental-wasm-modules", ...entryArgs, "--json", ...args], { cwd: work, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = ""; let stderr = "";
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; }); child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      const timeout = setTimeout(() => child.kill(), 20_000);
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("close", (code) => { clearTimeout(timeout); resolveRun({ code, stdout, stderr }); });
    });

    const regular = await invoke(["lm", "responses", "request.json"]);
    assert.equal(regular.code, 0, regular.stderr);
    const regularEvents = regular.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line) as { data: Record<string, unknown> });
    assert.equal(regularEvents.length, 1);
    assert.equal(regularEvents[0]?.data.output_text, "fixture answer");
    assert.equal(received[0]?.stream, false);
    assert.equal(received[0]?.model, "mock-model");

    const streamed = await invoke(["lm", "responses", "request.json", "--stream"]);
    assert.equal(streamed.code, 0, streamed.stderr);
    const streamEvents = streamed.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line) as { data: Record<string, unknown> });
    assert.equal(streamEvents.length, 3);
    assert.equal(streamEvents[1]?.data.delta, "fixture stream");
    assert.equal(streamEvents[2]?.data.type, "response.completed");
    assert.equal(received[1]?.stream, true);
    assert.equal(received[1]?.input, "fixture prompt");

    const incomplete = await invoke(["lm", "responses", "request-incomplete.json"]);
    assert.equal(incomplete.code, 2, incomplete.stderr);
    const incompleteEvent = JSON.parse(incomplete.stdout.trim()) as { data: Record<string, unknown> };
    assert.equal(incompleteEvent.data.status, "incomplete");
  } finally {
    if (server.listening) await closeServer();
    await rm(scratch, { recursive: true, force: true });
  }
});
