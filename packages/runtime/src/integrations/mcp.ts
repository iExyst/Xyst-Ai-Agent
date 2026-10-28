import { Client, SSEClientTransport, StreamableHTTPClientTransport, UnauthorizedError, type CreateMessageResult, type CreateMessageResultWithTools, type OAuthClientInformationContext, type OAuthClientMetadata, type OAuthClientProvider, type OAuthDiscoveryState, type StoredOAuthClientInformation, type StoredOAuthTokens } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/core";
import { createServer, type Server } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import type { AccessController } from "../access.js";

const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/);
const credentialRef = z.object({ service: z.string().min(1).max(100), name: z.string().min(1).max(100) }).strict();
function isLoopbackHost(hostname: string): boolean { return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname.toLowerCase()); }
const serverSchema = z.discriminatedUnion("transport", [
  z.object({ id: idSchema, enabled: z.boolean().optional(), transport: z.literal("stdio"), command: z.string().min(1).max(500), args: z.array(z.string().max(4000)).max(100).optional(), cwd: z.string().max(2000).optional(), env: z.record(z.string(), z.string().max(4000)).optional(), credential_env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), credentialRef).optional(), allowed_tools: z.array(z.string().min(1).max(200)).max(100).optional(), timeout_ms: z.number().int().min(1000).max(120000).optional() }).strict().superRefine((config, context) => {
    for (const key of Object.keys(config.env ?? {})) if (/(?:token|secret|password|credential|api.?key|authorization)/i.test(key)) context.addIssue({ code: "custom", path: ["env", key], message: "Secret environment variables must use credential_env references" });
  }),
  z.object({ id: idSchema, enabled: z.boolean().optional(), transport: z.enum(["streamable-http", "sse"]), url: z.string().url(), bearer_credential: credentialRef.optional(), oauth: z.boolean().optional(), allowed_tools: z.array(z.string().min(1).max(200)).max(100).optional(), timeout_ms: z.number().int().min(1000).max(120000).optional() }).strict().superRefine((config, context) => {
    if (config.oauth && config.bearer_credential) context.addIssue({ code: "custom", path: ["oauth"], message: "Choose OAuth or a static bearer credential, not both" });
  })
]);

export const mcpServersSchema = z.array(serverSchema).max(20).superRefine((servers, context) => {
  const seen = new Set<string>();
  for (const [index, server] of servers.entries()) {
    if (seen.has(server.id)) context.addIssue({ code: "custom", path: [index, "id"], message: `Duplicate MCP server id: ${server.id}` });
    seen.add(server.id);
    if (server.transport !== "stdio") {
      const url = new URL(server.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") context.addIssue({ code: "custom", path: [index, "url"], message: "MCP HTTP servers must use HTTP or HTTPS" });
      if (url.username || url.password) context.addIssue({ code: "custom", path: [index, "url"], message: "MCP URLs cannot include embedded credentials; use bearer_credential" });
      if (server.oauth && url.protocol !== "https:" && !isLoopbackHost(url.hostname)) context.addIssue({ code: "custom", path: [index, "url"], message: "MCP OAuth requires HTTPS except for loopback development servers" });
      if (server.bearer_credential && url.protocol !== "https:" && !isLoopbackHost(url.hostname)) context.addIssue({ code: "custom", path: [index, "bearer_credential"], message: "MCP bearer credentials require HTTPS except for loopback development servers" });
    }
  }
});

export type McpCredentialStore = { get(service: string, name: string): Promise<string | undefined>; set?(service: string, name: string, secret: string): Promise<void>; delete?(service: string, name: string): Promise<boolean> };
type McpClient = {
  listTools(params?: unknown, options?: { signal?: AbortSignal; timeout?: number }): Promise<{ tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> }>;
  callTool(params: { name: string; arguments: Record<string, unknown> }, options?: { signal?: AbortSignal; timeout?: number }): Promise<unknown>;
  listResources?(params?: unknown, options?: { signal?: AbortSignal; timeout?: number }): Promise<unknown>;
  readResource?(params: { uri: string }, options?: { signal?: AbortSignal; timeout?: number }): Promise<unknown>;
  listPrompts?(params?: unknown, options?: { signal?: AbortSignal; timeout?: number }): Promise<unknown>;
  getPrompt?(params: { name: string; arguments?: Record<string, string> }, options?: { signal?: AbortSignal; timeout?: number }): Promise<unknown>;
  subscribeResource?(params: { uri: string }, options?: { signal?: AbortSignal; timeout?: number }): Promise<unknown>;
  unsubscribeResource?(params: { uri: string }, options?: { signal?: AbortSignal; timeout?: number }): Promise<unknown>;
  listen?(filter: { resourceSubscriptions?: string[] }, options?: { signal?: AbortSignal; timeout?: number }): Promise<{ honoredFilter: { resourceSubscriptions?: string[] }; close(): Promise<void> }>;
  getProtocolEra?(): "legacy" | "modern" | undefined;
  getServerCapabilities?(): { resources?: { subscribe?: boolean } } | undefined;
  setNotificationHandler?(method: "notifications/resources/updated", schemas: { params: typeof ResourceUpdatedNotificationSchema.shape.params }, handler: (params: { uri: string }) => void): void;
  getInstructions?(): string | undefined;
  setRequestHandler?(method: "sampling/createMessage", handler: (request: any) => Promise<unknown>): void;
  close(): Promise<void>;
};
type AgentTool = { definition: Record<string, unknown>; execute(args: unknown): Promise<unknown> };
type McpSubscriptionHandle = { honoredFilter: { resourceSubscriptions?: string[] }; close(): Promise<void> };
type McpSamplingResult = CreateMessageResult | CreateMessageResultWithTools;
type McpToolOptions = { connect?: (server: z.infer<typeof serverSchema>, signal?: AbortSignal) => Promise<McpClient>; sample?: (request: unknown) => Promise<McpSamplingResult> };

function newClient(mode: "auto" | "legacy" = "auto", sample?: (request: unknown) => Promise<McpSamplingResult>): Client {
  const client = new Client({ name: "xyst", version: "0.1.0" }, { versionNegotiation: { mode } });
  if (sample) {
    client.registerCapabilities({ sampling: { tools: {} } });
    client.setRequestHandler("sampling/createMessage", async (request) => sample(request.params ?? request));
  }
  return client;
}

const oauthRecordNames = ["latest_issuer", "verifier", "discovery", "resource_url", "authorization_server_url"] as const;
type OAuthRecordName = typeof oauthRecordNames[number];

export class McpOAuthClientProvider implements OAuthClientProvider {
  private stateValue = randomUUID();
  authorizationUrl?: URL;
  constructor(readonly serverId: string, readonly redirectUrl: string, private readonly credentials: McpCredentialStore, private readonly secretSink?: string[]) {}

  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "Xyst", redirect_uris: [this.redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", application_type: "native" };
  }
  state(): string { this.stateValue = randomUUID(); return this.stateValue; }
  private service(): string { return `mcp-oauth-${this.serverId}`; }
  private async recordName(kind: string, issuer?: string): Promise<string> {
    if (!issuer) return kind;
    const digest = createHash("sha256").update(issuer).digest("hex").slice(0, 32);
    return `${kind}:${digest}`;
  }
  private async getRecord(name: string): Promise<string | undefined> { return this.credentials.get(this.service(), name); }
  private async setRecord(name: string, value: string): Promise<void> {
    if (!this.credentials.set) throw new Error("MCP OAuth requires an operating-system credential vault that supports saving credentials");
    await this.credentials.set(this.service(), name, value);
  }
  private async deleteRecord(name: string): Promise<void> { await this.credentials.delete?.(this.service(), name); }
  private async currentIssuer(): Promise<string | undefined> { return this.getRecord("latest_issuer"); }
  private async readJson<T>(name: string): Promise<T | undefined> {
    const value = await this.getRecord(name); if (!value) return undefined;
    try { return JSON.parse(value) as T; } catch { throw new Error(`Saved MCP OAuth state for ${this.serverId} is invalid; remove the authorization and log in again`); }
  }
  async clientInformation(context?: OAuthClientInformationContext): Promise<StoredOAuthClientInformation | undefined> {
    const issuer = context?.issuer ?? await this.currentIssuer();
    if (!issuer) return undefined;
    return this.readJson<StoredOAuthClientInformation>(await this.recordName("client", issuer));
  }
  async saveClientInformation(value: StoredOAuthClientInformation, context?: OAuthClientInformationContext): Promise<void> {
    const issuer = context?.issuer ?? value.issuer;
    if (!issuer) throw new Error("MCP OAuth client registration returned no authorization-server issuer");
    await this.setRecord(await this.recordName("client", issuer), JSON.stringify(value));
    await this.setRecord("latest_issuer", issuer);
  }
  async tokens(context?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    const issuer = context?.issuer ?? await this.currentIssuer();
    if (!issuer) return undefined;
    const result = await this.readJson<StoredOAuthTokens>(await this.recordName("tokens", issuer));
    for (const secret of [result?.access_token, result?.refresh_token]) if (secret) this.secretSink?.push(secret);
    return result;
  }
  async saveTokens(value: StoredOAuthTokens, context?: OAuthClientInformationContext): Promise<void> {
    const issuer = context?.issuer ?? value.issuer ?? await this.currentIssuer();
    if (!issuer) throw new Error("MCP OAuth token response has no authorization-server issuer");
    await this.setRecord(await this.recordName("tokens", issuer), JSON.stringify(value));
    await this.setRecord("latest_issuer", issuer);
    for (const secret of [value.access_token, value.refresh_token]) if (secret) this.secretSink?.push(secret);
  }
  async redirectToAuthorization(url: URL): Promise<void> { this.authorizationUrl = url; }
  async saveCodeVerifier(value: string): Promise<void> { await this.setRecord("verifier", value); }
  async codeVerifier(): Promise<string> { const value = await this.getRecord("verifier"); if (!value) throw new Error("MCP OAuth code verifier is missing; restart the login flow"); return value; }
  async saveDiscoveryState(value: OAuthDiscoveryState): Promise<void> { await this.setRecord("discovery", JSON.stringify(value)); }
  async discoveryState(): Promise<OAuthDiscoveryState | undefined> { return this.readJson<OAuthDiscoveryState>("discovery"); }
  async saveAuthorizationServerUrl(value: string): Promise<void> { await this.setRecord("authorization_server_url", value); }
  async authorizationServerUrl(): Promise<string | undefined> { return this.getRecord("authorization_server_url"); }
  async saveResourceUrl(value: string): Promise<void> { await this.setRecord("resource_url", value); }
  async resourceUrl(): Promise<string | undefined> { return this.getRecord("resource_url"); }
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "all") {
      const issuer = await this.currentIssuer();
      const issuerRecords = issuer ? [await this.recordName("client", issuer), await this.recordName("tokens", issuer)] : [];
      for (const name of [...oauthRecordNames, ...issuerRecords]) await this.deleteRecord(name);
      return;
    }
    if (scope === "verifier") return this.deleteRecord("verifier");
    if (scope === "discovery") return this.deleteRecord("discovery");
    const issuer = await this.currentIssuer(); if (issuer) await this.deleteRecord(await this.recordName(scope, issuer));
  }
  async savedTokens(): Promise<StoredOAuthTokens | undefined> { return this.tokens(); }
  async secretValues(): Promise<string[]> {
    const [tokens, information] = await Promise.all([this.tokens(), this.clientInformation()]);
    return [tokens?.access_token, tokens?.refresh_token, information?.client_secret].filter((value): value is string => typeof value === "string" && value.length >= 4);
  }
  async logout(): Promise<void> { await this.invalidateCredentials("all"); }
}

type McpOAuthServer = Extract<z.infer<typeof serverSchema>, { transport: "streamable-http" | "sse" }>;
const callbackPath = "/oauth/callback";

function createHttpTransport(server: McpOAuthServer, provider: McpOAuthClientProvider): StreamableHTTPClientTransport | SSEClientTransport {
  const url = new URL(server.url);
  return server.transport === "sse"
    ? new SSEClientTransport(url, { authProvider: provider })
    : new StreamableHTTPClientTransport(url, { authProvider: provider });
}

export async function getMcpOAuthRedirectUrl(serverId: string, credentials: McpCredentialStore): Promise<string | undefined> {
  return credentials.get(`mcp-oauth-${serverId}`, "redirect_url");
}

export async function authenticateMcpOAuth(server: McpOAuthServer, credentials: McpCredentialStore, options: { signal?: AbortSignal; timeoutMs?: number; onAuthorizationUrl: (url: URL) => Promise<void> | void }): Promise<{ authorized: true; issuer?: string; expiresAt?: number }> {
  if (server.oauth !== true) throw new Error(`MCP server ${server.id} is not configured for OAuth`);
  if (!credentials.set) throw new Error("MCP OAuth requires an operating-system credential vault that supports saving credentials");
  const service = `mcp-oauth-${server.id}`; const timeoutMs = Math.min(300_000, Math.max(10_000, options.timeoutMs ?? 300_000));
  const savedRedirect = await credentials.get(service, "redirect_url");
  if (savedRedirect && (!/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/.test(savedRedirect))) throw new Error("Saved MCP OAuth callback address is invalid; run mcp auth logout and retry");
  let callbackResolve!: (params: URLSearchParams) => void; let callbackReject!: (error: Error) => void; let callbackReceived = false;
  const callback = new Promise<URLSearchParams>((resolve, reject) => { callbackResolve = resolve; callbackReject = reject; });
  const callbackServer: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== callbackPath || callbackReceived) { response.writeHead(404).end(); return; }
    callbackReceived = true;
    const params = url.searchParams;
    if (!params.has("code") && !params.has("error")) { response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("OAuth callback is missing an authorization response."); callbackReject(new Error("MCP OAuth callback did not include a code or error")); return; }
    response.writeHead(params.has("code") ? 200 : 400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(params.has("code") ? "<!doctype html><meta charset=utf-8><title>Xyst authorization received</title><p>Authorization received. Return to Xyst.</p>" : "<!doctype html><meta charset=utf-8><title>Xyst authorization failed</title><p>Authorization was not completed. Return to Xyst for details.</p>");
    callbackResolve(params);
  });
  const listen = (port: number) => new Promise<void>((resolve, reject) => { callbackServer.once("error", reject); callbackServer.listen(port, "127.0.0.1", () => { callbackServer.removeListener("error", reject); resolve(); }); });
  const serverClose = () => new Promise<void>((resolve) => { if (!callbackServer.listening) return resolve(); callbackServer.close(() => resolve()); });
  const redirectPort = savedRedirect ? Number(new URL(savedRedirect).port) : 0;
  let client: Client | undefined;
  let abortHandler: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await listen(redirectPort);
    const address = callbackServer.address();
    if (!address || typeof address === "string") throw new Error("Could not allocate a local MCP OAuth callback address");
    const redirectUrl = savedRedirect ?? `http://127.0.0.1:${address.port}${callbackPath}`;
    if (!savedRedirect) await credentials.set(service, "redirect_url", redirectUrl);
    const provider = new McpOAuthClientProvider(server.id, redirectUrl, credentials);
    const transport = createHttpTransport(server, provider);
    client = newClient(server.transport === "sse" ? "legacy" : "auto");
    try {
      await client.connect(transport, { ...(options.signal ? { signal: options.signal } : {}), timeout: server.timeout_ms ?? 30_000 });
      const tokens = await provider.savedTokens();
      return { authorized: true, ...(tokens?.issuer ? { issuer: tokens.issuer } : {}) };
    } catch (error) {
      if (!(error instanceof UnauthorizedError) || !provider.authorizationUrl) throw error;
    }
    await options.onAuthorizationUrl(provider.authorizationUrl!);
    if (options.signal?.aborted) throw new Error("MCP OAuth login cancelled");
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`MCP OAuth login timed out after ${Math.round(timeoutMs / 1000)} seconds`)), timeoutMs); });
    const aborted = new Promise<never>((_resolve, reject) => {
      if (!options.signal) return;
      abortHandler = () => reject(new Error("MCP OAuth login cancelled"));
      options.signal.addEventListener("abort", abortHandler, { once: true });
    });
    const callbackParams = await Promise.race([callback, timeout, aborted]);
    await transport.finishAuth(callbackParams);
    await client.close(); client = undefined;
    const verifiedClient = newClient(server.transport === "sse" ? "legacy" : "auto");
    try { await verifiedClient.connect(createHttpTransport(server, provider), { ...(options.signal ? { signal: options.signal } : {}), timeout: server.timeout_ms ?? 30_000 }); }
    finally { await verifiedClient.close().catch(() => undefined); }
    const tokens = await provider.savedTokens();
    return { authorized: true, ...(tokens?.issuer ? { issuer: tokens.issuer } : {}) };
  } finally {
    if (timer) clearTimeout(timer);
    if (abortHandler && options.signal) options.signal.removeEventListener("abort", abortHandler);
    await client?.close().catch(() => undefined);
    await serverClose();
  }
}

async function defaultConnect(server: z.infer<typeof serverSchema>, credentials: McpCredentialStore, access: AccessController, workspace: string, signal: AbortSignal | undefined, secrets: string[], sample?: (request: unknown) => Promise<McpSamplingResult>): Promise<McpClient> {
  const timeout = server.timeout_ms ?? 30_000;
  const credentialValue = async (ref: { service: string; name: string }): Promise<string> => {
    const value = await credentials.get(ref.service, ref.name);
    if (!value) throw new Error(`MCP credential is missing: ${ref.service}/${ref.name}`);
    return value;
  };
  if (server.transport === "stdio") {
    access.assertCapability("externalActions"); access.assertExecutable(server.command);
    const cwd = resolve(workspace, server.cwd ?? "."); await access.assertPath(cwd, "read");
    const env: Record<string, string> = { ...getDefaultEnvironment(), ...(server.env ?? {}) };
    for (const [name, ref] of Object.entries(server.credential_env ?? {})) { env[name] = await credentialValue(ref); secrets.push(env[name]!); }
    const client = newClient(sample ? "legacy" : "auto", sample); const transport = new StdioClientTransport({ command: server.command, args: server.args ?? [], cwd, env, stderr: "ignore" });
    try { await client.connect(transport, { ...(signal ? { signal } : {}), timeout }); return client as unknown as McpClient; }
    catch (error) { await client.close().catch(() => undefined); throw error; }
  }
  access.assertCapability("integrations"); access.assertCapability("network");
  if (server.oauth) {
    const redirectUrl = await getMcpOAuthRedirectUrl(server.id, credentials);
    if (!redirectUrl) throw new Error(`MCP OAuth for ${server.id} is not configured; run xyst mcp auth login ${server.id}`);
    const provider = new McpOAuthClientProvider(server.id, redirectUrl, credentials, secrets);
    if (!(await provider.savedTokens())?.access_token) throw new Error(`MCP OAuth for ${server.id} is not authorized; run xyst mcp auth login ${server.id}`);
    secrets.push(...await provider.secretValues());
    const client = newClient(server.transport === "sse" || sample ? "legacy" : "auto", sample); const transport = createHttpTransport(server, provider);
    try { await client.connect(transport, { ...(signal ? { signal } : {}), timeout }); return client as unknown as McpClient; }
    catch (error) {
      await client.close().catch(() => undefined);
      if (error instanceof UnauthorizedError) throw new Error(`MCP OAuth for ${server.id} was rejected or expired; run xyst mcp auth login ${server.id}`);
      throw error;
    }
  }
  const url = new URL(server.url); const headers: Record<string, string> = {};
  if (server.bearer_credential) { const token = await credentialValue(server.bearer_credential); secrets.push(token); headers.Authorization = `Bearer ${token}`; }
  const requestInit: RequestInit = { headers };
  const authFetch: typeof fetch = async (input, init = {}) => { const requestHeaders = new Headers(init.headers); if (headers.Authorization) requestHeaders.set("Authorization", headers.Authorization); return fetch(input, { ...init, headers: requestHeaders }); };
  if (server.transport === "sse") {
    const client = newClient("legacy", sample); const transport = new SSEClientTransport(url, { requestInit, eventSourceInit: { fetch: authFetch } });
    try { await client.connect(transport, { ...(signal ? { signal } : {}), timeout }); return client as unknown as McpClient; }
    catch (error) { await client.close().catch(() => undefined); throw error; }
  }
  const streamableClient = newClient(sample ? "legacy" : "auto", sample);
  try { await streamableClient.connect(new StreamableHTTPClientTransport(url, { requestInit }), { ...(signal ? { signal } : {}), timeout }); return streamableClient as unknown as McpClient; }
  catch (streamableError) {
    await streamableClient.close().catch(() => undefined);
    if (signal?.aborted) throw streamableError;
    const legacyClient = newClient("legacy", sample); const legacy = new SSEClientTransport(url, { requestInit, eventSourceInit: { fetch: authFetch } });
    try { await legacyClient.connect(legacy, { ...(signal ? { signal } : {}), timeout }); return legacyClient as unknown as McpClient; }
    catch (legacyError) { await legacyClient.close().catch(() => undefined); throw new Error(`MCP Streamable HTTP and legacy SSE connections failed: ${legacyError instanceof Error ? legacyError.message : String(legacyError)}`, { cause: streamableError }); }
  }
}

function outputForAgent(result: unknown, secrets: string[]): string {
  let serialized = JSON.stringify(result ?? null);
  for (const secret of secrets) if (secret.length >= 4) serialized = serialized.replaceAll(secret, "[REDACTED]");
  return serialized.slice(0, 30_000);
}

export async function createMcpTools(access: AccessController, rawServers: unknown, credentials: McpCredentialStore, workspace: string, signal?: AbortSignal, options: McpToolOptions = {}): Promise<{ tools: Record<string, AgentTool>; close(): Promise<void>; servers: Array<{ id: string; toolCount: number; instructions?: string }> }> {
  const servers = mcpServersSchema.parse(rawServers);
  if (!servers.some((server) => server.enabled !== false)) return { tools: {}, close: async () => undefined, servers: [] };
  access.assertCapability("integrations");
  const connected: Array<{ id: string; client: McpClient; secrets: string[]; timeout: number; subscriptions: Set<string>; modernSubscription: McpSubscriptionHandle | undefined; subscriptionQueue: Promise<void> }> = [];
  const tools: Record<string, AgentTool> = {}; const summary: Array<{ id: string; toolCount: number }> = [];
  const close = async () => {
    await Promise.allSettled(connected.map(async (connection) => {
      await connection.subscriptionQueue;
      const { client, subscriptions } = connection;
      if (connection.modernSubscription) await connection.modernSubscription.close().catch(() => undefined);
      else if (client.unsubscribeResource) await Promise.allSettled([...subscriptions].map((uri) => client.unsubscribeResource!({ uri }, { timeout: 3000 })));
      connection.modernSubscription = undefined; subscriptions.clear(); await client.close();
    }));
  };
  let activeServerId = "unknown";
  try {
    for (const server of servers) {
      activeServerId = server.id;
      if (signal?.aborted) throw new Error("MCP connection cancelled");
      if (server.enabled === false) continue;
      const secrets: string[] = [];
      const client = await (options.connect ? options.connect(server, signal) : defaultConnect(server, credentials, access, workspace, signal, secrets, options.sample));
      if (options.sample && options.connect) {
        if (!client.setRequestHandler) throw new Error(`MCP client for ${server.id} cannot register server-initiated sampling requests`);
        client.setRequestHandler("sampling/createMessage", async (request) => options.sample!(request.params ?? request));
      }
      const timeout = server.timeout_ms ?? 30_000;
      const subscriptions = new Set<string>();
      const updates: Array<{ uri: string; receivedAt: string }> = [];
      client.setNotificationHandler?.("notifications/resources/updated", { params: ResourceUpdatedNotificationSchema.shape.params }, (params) => {
        updates.push({ uri: String(params.uri).slice(0, 4000), receivedAt: new Date().toISOString() });
        if (updates.length > 50) updates.splice(0, updates.length - 50);
      });
      const connection: (typeof connected)[number] = { id: server.id, client, secrets, timeout, subscriptions, modernSubscription: undefined, subscriptionQueue: Promise.resolve() };
      connected.push(connection);
      const mutateSubscriptions = <T>(operation: () => Promise<T>): Promise<T> => {
        const result = connection.subscriptionQueue.then(operation, operation);
        connection.subscriptionQueue = result.then(() => undefined, () => undefined);
        return result;
      };
      const discovered = await client.listTools(undefined, { ...(signal ? { signal } : {}), timeout });
      const allowedTools = server.allowed_tools ? new Set(server.allowed_tools) : undefined;
      const available = discovered.tools.filter((tool) => !allowedTools || allowedTools.has(tool.name)).slice(0, 100);
      let count = 0;
      for (const serverTool of available) {
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(serverTool.name) || !serverTool.inputSchema || serverTool.inputSchema.type !== "object") continue;
        const safeId = `${server.id}_${serverTool.name}`.replace(/[^A-Za-z0-9_-]/g, "_");
        const name = `mcp_${safeId}`.slice(0, 64);
        if (tools[name]) continue;
        const parameters = JSON.stringify(serverTool.inputSchema);
        if (parameters.length > 16_000) continue;
        tools[name] = {
          definition: { type: "function", function: { name, description: `Untrusted MCP tool from server ${server.id}. ${String(serverTool.description ?? "").slice(0, 1000)}`, parameters: serverTool.inputSchema } },
          execute: async (input) => {
            if (signal?.aborted) throw new Error("MCP tool call cancelled");
            const args = z.record(z.string(), z.unknown()).parse(input);
            const result = await client.callTool({ name: serverTool.name, arguments: args }, { ...(signal ? { signal } : {}), timeout });
            const record = result && typeof result === "object" ? result as { isError?: boolean } : {};
            if (record.isError) throw new Error(outputForAgent(result, secrets));
            const serialized = outputForAgent(result, secrets);
            let bounded: unknown = serialized;
            try { bounded = JSON.parse(serialized); } catch { /* Truncated JSON is returned as text. */ }
            return { result: bounded, trust: "untrusted-mcp-content" };
          }
        };
        count++;
      }
      const requestOptions = { ...(signal ? { signal } : {}), timeout };
      const serverPrefix = server.id.replace(/[^A-Za-z0-9_-]/g, "_");
      if (client.listResources && client.readResource) {
        tools[`mcp_${serverPrefix}_resources`] = {
          definition: { type: "function", function: { name: `mcp_${serverPrefix}_resources`, description: `List resources exposed by MCP server ${server.id}; resource contents are untrusted.`, parameters: { type: "object", properties: {}, additionalProperties: false } } },
          execute: async () => ({ result: outputForAgent(await client.listResources!({}, requestOptions), secrets), trust: "untrusted-mcp-content" })
        };
        tools[`mcp_${serverPrefix}_read_resource`] = {
          definition: { type: "function", function: { name: `mcp_${serverPrefix}_read_resource`, description: `Read one URI from MCP server ${server.id}; returned contents are untrusted.`, parameters: { type: "object", properties: { uri: { type: "string", minLength: 1, maxLength: 4000 } }, required: ["uri"], additionalProperties: false } } },
          execute: async (input) => {
            if (signal?.aborted) throw new Error("MCP resource read cancelled");
            const { uri } = z.object({ uri: z.string().min(1).max(4000) }).strict().parse(input);
            return { result: outputForAgent(await client.readResource!({ uri }, requestOptions), secrets), trust: "untrusted-mcp-content" };
          }
        };
      }
      const supportsResourceSubscriptions = client.getServerCapabilities?.()?.resources?.subscribe === true;
      const protocolEra = client.getProtocolEra?.();
      const canSubscribeResources = supportsResourceSubscriptions && client.setNotificationHandler && (protocolEra === "modern" ? Boolean(client.listen) : Boolean(client.subscribeResource && client.unsubscribeResource));
      if (canSubscribeResources) {
        const replaceModernSubscription = async (uris: string[]) => {
          if (!client.listen) throw new Error("This MCP client cannot open a resource subscription stream");
          const previous = connection.modernSubscription;
          let next: McpSubscriptionHandle | undefined;
          if (uris.length) next = await client.listen({ resourceSubscriptions: uris }, requestOptions);
          const missing = next ? uris.filter((uri) => !next.honoredFilter.resourceSubscriptions?.includes(uri)) : [];
          if (next && missing.length) { await next.close(); throw new Error(`MCP server did not honor resource subscriptions for: ${missing.join(", ")}`); }
          connection.modernSubscription = next;
          if (previous) await previous.close().catch(() => undefined);
        };
        tools[`mcp_${serverPrefix}_subscribe_resource`] = {
          definition: { type: "function", function: { name: `mcp_${serverPrefix}_subscribe_resource`, description: `Subscribe to change notices for one resource from MCP server ${server.id}. Notifications identify a URI only; reread it with mcp_${serverPrefix}_read_resource. Subscriptions last for this agent run and are untrusted.`, parameters: { type: "object", properties: { uri: { type: "string", minLength: 1, maxLength: 4000 } }, required: ["uri"], additionalProperties: false } } },
          execute: async (input) => {
            if (signal?.aborted) throw new Error("MCP resource subscription cancelled");
            const { uri } = z.object({ uri: z.string().min(1).max(4000).refine((value) => !/[\u0000\r\n]/.test(value), "Resource URI contains a control character") }).strict().parse(input);
            return mutateSubscriptions(async () => {
              if (!subscriptions.has(uri) && subscriptions.size >= 50) throw new Error("An MCP server is limited to 50 active resource subscriptions per agent run");
              if (subscriptions.has(uri)) return { subscribed: true, uri, scope: "agent-run", trust: "untrusted-mcp-content" };
              if (protocolEra === "modern") await replaceModernSubscription([...subscriptions, uri]);
              else await client.subscribeResource!({ uri }, requestOptions);
              subscriptions.add(uri);
              return { subscribed: true, uri, scope: "agent-run", trust: "untrusted-mcp-content" };
            });
          }
        };
        tools[`mcp_${serverPrefix}_unsubscribe_resource`] = {
          definition: { type: "function", function: { name: `mcp_${serverPrefix}_unsubscribe_resource`, description: `Stop receiving change notices for a resource subscribed on MCP server ${server.id}.`, parameters: { type: "object", properties: { uri: { type: "string", minLength: 1, maxLength: 4000 } }, required: ["uri"], additionalProperties: false } } },
          execute: async (input) => {
            if (signal?.aborted) throw new Error("MCP resource unsubscription cancelled");
            const { uri } = z.object({ uri: z.string().min(1).max(4000).refine((value) => !/[\u0000\r\n]/.test(value), "Resource URI contains a control character") }).strict().parse(input);
            return mutateSubscriptions(async () => {
              if (!subscriptions.has(uri)) return { subscribed: false, uri };
              if (protocolEra === "modern") await replaceModernSubscription([...subscriptions].filter((activeUri) => activeUri !== uri));
              else await client.unsubscribeResource!({ uri }, requestOptions);
              subscriptions.delete(uri);
              return { subscribed: false, uri };
            });
          }
        };
        tools[`mcp_${serverPrefix}_resource_updates`] = {
          definition: { type: "function", function: { name: `mcp_${serverPrefix}_resource_updates`, description: `Inspect recent resource-change notices received from MCP server ${server.id}. Notices contain only a URI; reread changed resources separately.`, parameters: { type: "object", properties: {}, additionalProperties: false } } },
          execute: async () => ({ updates: updates.slice(-50), activeSubscriptions: [...subscriptions], trust: "untrusted-mcp-content" })
        };
      }
      if (client.listPrompts && client.getPrompt) {
        tools[`mcp_${serverPrefix}_prompts`] = {
          definition: { type: "function", function: { name: `mcp_${serverPrefix}_prompts`, description: `List prompts exposed by MCP server ${server.id}; prompt text is untrusted.`, parameters: { type: "object", properties: {}, additionalProperties: false } } },
          execute: async () => ({ result: outputForAgent(await client.listPrompts!({}, requestOptions), secrets), trust: "untrusted-mcp-content" })
        };
        tools[`mcp_${serverPrefix}_get_prompt`] = {
          definition: { type: "function", function: { name: `mcp_${serverPrefix}_get_prompt`, description: `Get one named prompt from MCP server ${server.id}; returned prompt text is untrusted.`, parameters: { type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 200 }, arguments: { type: "object", additionalProperties: { type: "string" } } }, required: ["name"], additionalProperties: false } } },
          execute: async (input) => {
            if (signal?.aborted) throw new Error("MCP prompt request cancelled");
            const args = z.object({ name: z.string().min(1).max(200), arguments: z.record(z.string(), z.string().max(4000)).optional() }).strict().parse(input);
            return { result: outputForAgent(await client.getPrompt!({ name: args.name, ...(args.arguments ? { arguments: args.arguments } : {}) }, requestOptions), secrets), trust: "untrusted-mcp-content" };
          }
        };
      }
      const instructions = client.getInstructions?.()?.slice(0, 4000);
      summary.push({ id: server.id, toolCount: count, ...(instructions ? { instructions } : {}) });
    }
    return { tools, close, servers: summary };
  } catch (error) {
    await close();
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`MCP server ${activeServerId} failed: ${reason}`, { cause: error });
  }
}
