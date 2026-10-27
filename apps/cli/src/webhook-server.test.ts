import assert from "node:assert/strict";
import { test } from "node:test";
import { closeWebhookServer, parseGitHubWebhookOptions, startGitHubWebhookServer } from "./webhook-server.js";

test("GitHub webhook CLI options require explicit opt-in and validate listener settings", () => {
  assert.equal(parseGitHubWebhookOptions([]), undefined);
  assert.deepEqual(parseGitHubWebhookOptions(["--webhook"]), { host: "127.0.0.1", port: 8787, path: "/github/webhook" });
  assert.deepEqual(parseGitHubWebhookOptions(["--webhook", "--webhook-host", "127.0.0.1", "--webhook-port", "9001", "--webhook-path", "/hooks/xyst"]), { host: "127.0.0.1", port: 9001, path: "/hooks/xyst" });
  assert.throws(() => parseGitHubWebhookOptions(["--webhook-port", "9001"]), /require --webhook/);
  assert.throws(() => parseGitHubWebhookOptions(["--webhook", "--webhook-host"]), /requires a value/);
  assert.throws(() => parseGitHubWebhookOptions(["--webhook", "--unknown"]), /Unknown mission daemon option/);
});

test("GitHub webhook receiver routes only its configured path and closes cleanly", async () => {
  let handled = 0;
  const server = await startGitHubWebhookServer(async (_request, response) => {
    handled++;
    response.writeHead(202, { "Content-Type": "application/json" });
    response.end('{"accepted":true}');
  }, { host: "127.0.0.1", port: 0, path: "/hooks/github" });
  let listeningPort = 0;
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    listeningPort = address.port;
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${base}/wrong`)).status, 404);
    const accepted = await fetch(`${base}/hooks/github`, { method: "POST", body: "{}" });
    assert.equal(accepted.status, 202);
    assert.deepEqual(await accepted.json(), { accepted: true });
    assert.equal(handled, 1);
  } finally {
    await closeWebhookServer(server);
  }
  await assert.rejects(fetch(`http://127.0.0.1:${listeningPort}/hooks/github`));
});

test("GitHub webhook receiver rejects invalid listener settings", async () => {
  const handler = async () => undefined;
  assert.throws(() => startGitHubWebhookServer(handler, { host: "", port: 1, path: "/hook" }), /host/);
  assert.throws(() => startGitHubWebhookServer(handler, { host: "127.0.0.1", port: 65536, path: "/hook" }), /port/);
  assert.throws(() => startGitHubWebhookServer(handler, { host: "127.0.0.1", port: 1, path: "hook" }), /path/);
});
