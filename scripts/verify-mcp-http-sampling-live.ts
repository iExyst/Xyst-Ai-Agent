import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AccessController } from "../packages/runtime/src/access.js";
import { createMcpTools } from "../packages/runtime/src/integrations/mcp.js";
import { createMcpSamplingHandler } from "../packages/runtime/src/integrations/mcp-sampling.js";
import { LMStudioProvider } from "../packages/runtime/src/providers/lm-studio.js";

const model = process.env.XYST_LIVE_MCP_HTTP_MODEL ?? "qwen/qwen3.5-9b";
const provider = new LMStudioProvider();
const inventory = await provider.models();
const resident = inventory.find((candidate) => candidate.key === model && candidate.type === "llm" && candidate.loaded_instances.length > 0);
if (!resident) throw new Error(`Refusing to load a model: ${model} is not already loaded in LM Studio`);

const root = await mkdtemp(join(tmpdir(), "xyst-live-http-sampling-"));
const serverPath = join(root, "independent-http-server.mjs");
const readyPath = join(root, "ready.json");

await writeFile(serverPath, [
  `import { createServer } from "node:http";`,
  `import { writeFile } from "node:fs/promises";`,
  `import { randomUUID } from "node:crypto";`,
  `import { McpServer } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js"))};`,
  `import { StreamableHTTPServerTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/streamableHttp.js"))};`,
  'const server = new McpServer({ name: "xyst-live-http-sampling-proof", version: "1.0.0" });',
  'server.tool("exercise_sampling", "Use the required documentation lookup tool, then answer from its result", {}, async () => {',
  '  const tools = [{ name: "wiki.lookup", description: "Return the React migration key", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }];',
  '  const messages = [{ role: "user", content: { type: "text", text: "Look up the React migration key and report it exactly." } }];',
  '  const first = await server.server.createMessage({ messages, maxTokens: 128, tools, toolChoice: { mode: "required" } });',
  '  if (first.content?.type !== "tool_use" || first.content.name !== "wiki.lookup") throw new Error("The model did not call the independent server tool");',
  '  if (first.content.input?.query !== "React migration key") throw new Error("The model supplied an unexpected lookup query");',
  '  const lookup = "Migration key: XYST-RIVER-27";',
  '  const second = await server.server.createMessage({ messages: [...messages, { role: "assistant", content: first.content }, { role: "user", content: { type: "tool_result", toolUseId: first.content.id, content: [{ type: "text", text: lookup }] } }], maxTokens: 128, tools, toolChoice: { mode: "auto" } });',
  '  return { content: [{ type: "text", text: JSON.stringify({ capabilities: server.server.getClientCapabilities(), first, lookup, second }) }] };',
  '});',
  'const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });',
  'await server.connect(transport);',
  'const http = createServer(async (req, res) => { let body = ""; for await (const chunk of req) body += chunk; let parsed; try { parsed = body ? JSON.parse(body) : undefined; } catch { res.writeHead(400).end("invalid JSON"); return; } try { await transport.handleRequest(req, res, parsed); } catch (error) { if (!res.headersSent) res.writeHead(500).end(String(error)); } });',
  'http.listen(0, "127.0.0.1", async () => { await writeFile(process.argv[2], JSON.stringify({ port: http.address().port })); });',
  'process.on("SIGTERM", () => { void transport.close().finally(() => http.close(() => process.exit(0))); });'
].join("\n"));

let connection: Awaited<ReturnType<typeof createMcpTools>> | undefined;
try {
  const server = spawn(process.execPath, [serverPath, readyPath], { stdio: "ignore" });
  try {
    let port: number | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.exitCode !== null) throw new Error(`Independent MCP server exited early with ${server.exitCode}`);
      try { port = (JSON.parse(await readFile(readyPath, "utf8")) as { port: number }).port; break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    if (!port) throw new Error("Independent MCP server did not announce its HTTP port");
    const sample = createMcpSamplingHandler({
      chat: (options, signal) => provider.chat(options, signal),
      chatWithTools: (request, signal) => provider.chatWithTools(request, signal)
    }, model, model);
    connection = await createMcpTools(new AccessController(), [{ id: "live-http", transport: "streamable-http", url: `http://127.0.0.1:${port}/mcp` }], { get: async () => undefined }, root, undefined, { sample });
    const tool = connection.tools["mcp_live-http_exercise_sampling"];
    if (!tool) throw new Error(`The independent HTTP server sampling tool was not exposed to Xyst; discovered tools: ${Object.keys(connection.tools).join(", ")}`);
    const response = await tool.execute({}) as { result: { content: Array<{ text: string }> } };
    const report = JSON.parse(response.result.content[0]!.text) as {
      capabilities: { sampling?: { tools?: unknown } };
      first: { content: { type: string; name?: string; input?: { query?: string } } };
      lookup: string;
      second: { content: { type: string; text?: string } };
    };
    if (!report.capabilities.sampling?.tools) throw new Error("The MCP client did not advertise sampling.tools");
    if (report.first.content.type !== "tool_use" || report.first.content.name !== "wiki.lookup") throw new Error("The live model did not select the independent server's tool");
    if (report.lookup !== "Migration key: XYST-RIVER-27") throw new Error("The independent server fixture returned an unexpected lookup result");
    if (report.second.content.type !== "text" || !report.second.content.text?.includes("XYST-RIVER-27")) throw new Error("The live model did not use the server's tool result in its final answer");
    process.stdout.write(`${JSON.stringify({ model, contextLength: resident.loaded_instances[0]?.config.context_length ?? null, modelWasAlreadyLoaded: true, serverTransport: "streamable-http", endpointHost: "127.0.0.1", samplingToolsCapabilityAdvertised: true, serverToolName: report.first.content.name, serverToolInput: report.first.content.input, serverExecutedTool: true, serverToolResult: report.lookup, modelFinalAnswer: report.second.content.text })}\n`);
  } finally {
    await connection?.close();
    if (server.exitCode === null) { server.kill(); await new Promise<void>((resolve) => { server.once("exit", () => resolve()); setTimeout(resolve, 1000).unref(); }); }
  }
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
