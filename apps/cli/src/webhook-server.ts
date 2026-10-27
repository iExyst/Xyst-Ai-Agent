import { createServer, type Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface GitHubWebhookServerOptions { host: string; port: number; path: string }

function validateOptions(options: GitHubWebhookServerOptions): void {
  const { host, port, path } = options;
  if (!host.trim() || host.length > 253 || /[\s/\\]/.test(host)) throw new Error("Webhook host must be a hostname or IP address");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Webhook port must be an integer from 0 through 65535");
  if (!path.startsWith("/") || path.length > 200 || /[?#\r\n]/.test(path)) throw new Error("Webhook path must be an absolute path without query or fragment");
}

export function parseGitHubWebhookOptions(args: string[]): GitHubWebhookServerOptions | undefined {
  if (!args.length) return undefined;
  let enabled = false;
  let host = "127.0.0.1";
  let port = 8787;
  let path = "/github/webhook";
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--webhook") { if (enabled) throw new Error("--webhook may only be specified once"); enabled = true; continue; }
    const option = arg === "--webhook-host" ? "host" : arg === "--webhook-port" ? "port" : arg === "--webhook-path" ? "path" : undefined;
    if (!option) throw new Error(`Unknown mission daemon option: ${arg}`);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (option === "host") host = value;
    else if (option === "port") port = Number(value);
    else path = value;
  }
  if (!enabled) throw new Error("Webhook listener options require --webhook");
  const options = { host, port, path };
  validateOptions(options);
  return options;
}

export function startGitHubWebhookServer(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  options: GitHubWebhookServerOptions,
): Promise<Server> {
  const { host, port, path } = options;
  validateOptions(options);
  const server = createServer((request, response) => {
    if (request.url?.split("?", 1)[0] !== path) {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    void handler(request, response);
  });
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { server.removeListener("listening", onListening); reject(error); };
    const onListening = () => { server.removeListener("error", onError); resolve(server); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export function closeWebhookServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
