import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { redactSecrets, type CredentialStore } from "../credentials.js";
import type { XystStore } from "../storage.js";
import type { ConfigStore } from "../storage.js";
import JSZip from "jszip";

const API = "https://api.github.com";
const API_VERSION = "2026-03-10";
export class GitHubError extends Error {
  constructor(message: string, readonly status?: number, readonly acceptedPermissions?: string) { super(message); this.name = "GitHubError"; }
}
export interface GitHubRepository { full_name: string; html_url: string; default_branch: string; private: boolean; description: string | null; permissions?: Record<string, boolean> }
export interface GitHubIssue { number: number; title: string; state: string; body: string | null; html_url: string; pull_request?: unknown }
export interface GitHubPullRequest { number: number; title: string; state: string; html_url: string; head: { ref: string; sha: string }; base: { ref: string } }

function b64url(value: string | Buffer): string { return Buffer.from(value).toString("base64url"); }
function signAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000); const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })); const payload = b64url(JSON.stringify({ iat: now - 30, exp: now + 8 * 60, iss: appId }));
  const unsigned = `${header}.${payload}`; const signer = createSign("RSA-SHA256"); signer.update(unsigned); signer.end(); return `${unsigned}.${signer.sign(privateKey).toString("base64url")}`;
}
async function readBoundedBody(response: Response, limit: number, label: string): Promise<Uint8Array> {
  const reader = response.body?.getReader(); if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new GitHubError(`${label} exceeds the ${Math.floor(limit / (1024 * 1024))} MiB download limit`); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export class GitHubProvider {
  private appAccess: { token: string; expiresAt: number } | undefined;
  private authenticatedUser: { login: string; url: string; type: string; expiresAt: number } | undefined;
  constructor(private readonly credentials: CredentialStore, private readonly options: { apiBase?: string; config?: Pick<ConfigStore, "resolve">; store?: XystStore } = {}) {}
  private get apiBase(): string {
    return (this.options.apiBase ?? this.options.config?.resolve<string>("integrations.github.apiBaseUrl")?.value ?? API).replace(/\/+$/, "");
  }
  get enterpriseHost(): string | undefined {
    if (!this.options.config) return undefined;
    const base = this.options.config.resolve<string>("integrations.github.apiBaseUrl")?.value;
    if (!base) return undefined;
    return new URL(base).hostname.toLowerCase();
  }

  private async appToken(signal?: AbortSignal): Promise<string | undefined> {
    const [appId, installationId, privateKey] = await Promise.all([
      this.credentials.get("github-app", "app-id"), this.credentials.get("github-app", "installation-id"), this.credentials.get("github-app", "private-key")
    ]);
    if (!appId || !installationId || !privateKey) return undefined;
    if (this.appAccess && this.appAccess.expiresAt > Date.now() + 60_000) return this.appAccess.token;
    let jwt: string;
    try { jwt = signAppJwt(appId, privateKey); }
    catch { throw new GitHubError("GitHub App private key is invalid"); }
    let response: Response;
    try { response = await fetch(`${this.apiBase}/app/installations/${encodeURIComponent(installationId)}/access_tokens`, { method: "POST", headers: this.headers(jwt), body: "{}", ...(signal ? { signal } : {}) }); }
    catch (error) { if (signal?.aborted) throw error; throw new GitHubError(`GitHub connection failed while requesting an App installation token: ${error instanceof Error ? error.message : String(error)}`); }
    if (!response.ok) throw await this.error(response);
    let data: unknown;
    try { data = await response.json(); }
    catch { throw new GitHubError("GitHub App installation-token response was invalid"); }
    if (!data || typeof data !== "object") {
      throw new GitHubError("GitHub App installation-token response was invalid");
    }
    const token = (data as { token?: unknown }).token;
    if (typeof token !== "string" || !token.trim()) throw new GitHubError("GitHub App installation-token response was invalid");
    const expiresAt = Date.parse(String((data as { expires_at?: unknown }).expires_at ?? ""));
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new GitHubError("GitHub App installation-token response had an invalid expiry");
    this.appAccess = { token, expiresAt };
    return token;
  }

  private headers(token?: string): Headers {
    const headers = new Headers({ Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": API_VERSION, "User-Agent": "Xyst/0.1" });
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return headers;
  }
  private async token(signal?: AbortSignal): Promise<string | undefined> { return await this.credentials.get("github", "personal-token") ?? await this.appToken(signal); }
  async gitToken(signal?: AbortSignal): Promise<string | undefined> { return await this.token(signal); }
  private async error(response: Response): Promise<GitHubError> {
    const body = await response.text().catch(() => ""); let detail = body;
    try { const parsed = JSON.parse(body) as { message?: string }; detail = parsed.message ?? body; } catch { /* keep response text */ }
    const accepted = response.headers.get("X-Accepted-GitHub-Permissions") ?? undefined;
    const rate = response.status === 403 && response.headers.get("X-RateLimit-Remaining") === "0" ? " (GitHub API rate limit reached)" : "";
    return new GitHubError(redactSecrets(`GitHub API HTTP ${response.status}${rate}: ${detail.slice(0, 1000)}${accepted ? `; required permissions: ${accepted}` : ""}`), response.status, accepted);
  }
  async request<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
    const token = await this.token(signal);
    let response: Response;
    try { response = await fetch(`${this.apiBase}${path}`, { ...init, headers: this.headers(token), ...(signal ? { signal } : {}) }); }
    catch (error) { if (signal?.aborted) throw error; throw new GitHubError(`GitHub connection failed: ${error instanceof Error ? error.message : String(error)}`); }
    if (!response.ok) throw await this.error(response);
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }
  async paginate<T>(path: string, maxPages = 5, signal?: AbortSignal): Promise<T[]> {
    const output: T[] = []; const apiBase = new URL(this.apiBase); const apiPathPrefix = apiBase.pathname.replace(/\/+$/, "");
    let next: string | undefined = `${this.apiBase}${path}`; const token = await this.token(signal);
    for (let page = 0; page < Math.max(1, Math.min(maxPages, 10)) && next; page++) {
      let response: Response;
      try { response = await fetch(next, { headers: this.headers(token), redirect: "error", ...(signal ? { signal } : {}) }); } catch (error) { if (signal?.aborted) throw error; throw new GitHubError(`GitHub connection failed: ${error instanceof Error ? error.message : String(error)}`); }
      try { response = await fetch(next, { headers: this.headers(token), ...(signal ? { signal } : {}) }); } catch (error) { if (signal?.aborted) throw error; throw new GitHubError(`GitHub connection failed: ${error instanceof Error ? error.message : String(error)}`); }
      if (!response.ok) throw await this.error(response);
      const body = await response.json() as T[]; output.push(...body);
      const link = response.headers.get("link"); const candidate = link?.split(",").map((part) => part.trim()).find((part) => {
        const relations = part.match(/;\s*rel\s*=\s*"?([^";,]+)"?/i)?.[1]?.split(/\s+/) ?? [];
        return relations.includes("next");
      })?.match(/<([^>]+)>/)?.[1];
      if (!candidate) { next = undefined; continue; }
      let nextUrl: URL;
      try { nextUrl = new URL(candidate, apiBase); }
      catch { throw new GitHubError("GitHub pagination returned an invalid next-page URL"); }
      const pathIsInApi = !apiPathPrefix || nextUrl.pathname === apiPathPrefix || nextUrl.pathname.startsWith(`${apiPathPrefix}/`);
      if (nextUrl.origin !== apiBase.origin || !pathIsInApi || nextUrl.username || nextUrl.password) {
        throw new GitHubError("GitHub pagination next-page URL must remain on the configured API host and path");
      }
      next = nextUrl.href;
    }
    return output;
  }
  async authenticate(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const token = await this.token(signal); if (!token) return { authenticated: false, message: "Store a GitHub token with `credential set github personal-token`" };
    const personalToken = await this.credentials.get("github", "personal-token");
    const expectedType = personalToken ? "User" : "App";
    if (this.authenticatedUser && this.authenticatedUser.type !== expectedType) this.authenticatedUser = undefined;
    if (this.authenticatedUser && this.authenticatedUser.expiresAt > Date.now()) return { authenticated: true, login: this.authenticatedUser.login, url: this.authenticatedUser.url, identityType: this.authenticatedUser.type };
    if (personalToken) {
      const user = await this.request<{ login: string; html_url: string; type: string }>("/user", {}, signal);
      this.authenticatedUser = { login: user.login, url: user.html_url, type: user.type, expiresAt: Date.now() + 5 * 60_000 };
      return { authenticated: true, login: user.login, url: user.html_url, identityType: user.type };
    }
    const [appId, privateKey] = await Promise.all([this.credentials.get("github-app", "app-id"), this.credentials.get("github-app", "private-key")]);
    if (!appId || !privateKey) return { authenticated: false, message: "GitHub App credentials are incomplete" };
    let response: Response;
    try { response = await fetch(`${this.apiBase}/app`, { headers: this.headers(signAppJwt(appId, privateKey)), ...(signal ? { signal } : {}) }); }
    catch (error) { if (signal?.aborted) throw error; throw new GitHubError(`GitHub connection failed: ${error instanceof Error ? error.message : String(error)}`); }
    if (!response.ok) throw await this.error(response);
    const app = await response.json() as { slug: string; html_url: string };
    const login = `${app.slug}[bot]`; this.authenticatedUser = { login, url: app.html_url, type: "App", expiresAt: Date.now() + 5 * 60_000 };
    return { authenticated: true, login, url: app.html_url, identityType: "App" };
  }
  async repositories(query?: string, signal?: AbortSignal): Promise<GitHubRepository[]> {
    if (query) { const result = await this.request<{ items: GitHubRepository[] }>(`/search/repositories?q=${encodeURIComponent(query)}&per_page=30`, {}, signal); return result.items; }
    return this.paginate<GitHubRepository>("/user/repos?per_page=100&sort=updated", 3, signal);
  }
  async repository(owner: string, repo: string, signal?: AbortSignal): Promise<GitHubRepository> { return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {}, signal); }
  async issues(owner: string, repo: string, state: "open" | "closed" | "all" = "open", signal?: AbortSignal): Promise<GitHubIssue[]> {
    const items = await this.paginate<GitHubIssue>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=${state}&per_page=100`, 3, signal);
    return items.filter((item) => !item.pull_request);
  }
  async issue(owner: string, repo: string, number: number, signal?: AbortSignal): Promise<GitHubIssue> { return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`, {}, signal); }
  async issueLabels(owner: string, repo: string, number: number, signal?: AbortSignal): Promise<unknown[]> { return this.paginate(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/labels?per_page=100`, 3, signal); }
  async addIssueLabels(owner: string, repo: string, number: number, labels: string[], signal?: AbortSignal): Promise<unknown[]> { return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/labels`, { method: "POST", body: JSON.stringify({ labels }) }, signal); }
  async replaceIssueLabels(owner: string, repo: string, number: number, labels: string[], signal?: AbortSignal): Promise<unknown[]> { return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/labels`, { method: "PUT", body: JSON.stringify({ labels }) }, signal); }
  async removeIssueLabel(owner: string, repo: string, number: number, label: string, signal?: AbortSignal): Promise<void> { await this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/labels/${encodeURIComponent(label)}`, { method: "DELETE" }, signal); }
  async commentIssue(owner: string, repo: string, number: number, body: string, signal?: AbortSignal): Promise<unknown> { return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`, { method: "POST", body: JSON.stringify({ body }) }, signal); }
  async pullRequests(owner: string, repo: string, state: "open" | "closed" | "all" = "open", signal?: AbortSignal): Promise<GitHubPullRequest[]> { return this.paginate(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=${state}&per_page=100`, 3, signal); }
  async pullRequest(owner: string, repo: string, number: number, signal?: AbortSignal): Promise<GitHubPullRequest> { return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`, {}, signal); }
  async pullRequestReviewComments(owner: string, repo: string, number: number, signal?: AbortSignal): Promise<unknown[]> { return this.paginate(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/comments?per_page=100`, 3, signal); }
  async pullRequestDiff(owner: string, repo: string, number: number, signal?: AbortSignal): Promise<string> {
    const token = await this.token(signal); const headers = this.headers(token); headers.set("Accept", "application/vnd.github.diff");
    const response = await fetch(`${this.apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`, { headers, ...(signal ? { signal } : {}) });
    if (!response.ok) throw await this.error(response); return (await response.text()).slice(0, 100_000);
  }
  async createPullRequest(owner: string, repo: string, input: { title: string; head: string; base: string; body?: string; draft?: boolean }, signal?: AbortSignal): Promise<GitHubPullRequest> {
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, { method: "POST", body: JSON.stringify(input) }, signal);
  }
  async updatePullRequest(owner: string, repo: string, number: number, input: { title?: string; body?: string; state?: "open" | "closed"; base?: string }, signal?: AbortSignal): Promise<GitHubPullRequest> {
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`, { method: "PATCH", body: JSON.stringify(input) }, signal);
  }
  async checks(owner: string, repo: string, ref: string, signal?: AbortSignal): Promise<unknown> { return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}/check-runs`, {}, signal); }
  async workflowRuns(owner: string, repo: string, branch?: string, signal?: AbortSignal): Promise<unknown> { return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs${branch ? `?branch=${encodeURIComponent(branch)}` : ""}`, {}, signal); }
  async workflowRunLogs(owner: string, repo: string, runId: number, signal?: AbortSignal): Promise<{ runId: number; files: Array<{ name: string; text: string }> }> {
    const token = await this.token(signal);
    let response: Response;
    try { response = await fetch(`${this.apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}/logs`, { headers: this.headers(token), ...(signal ? { signal } : {}) }); }
    catch (error) { if (signal?.aborted) throw error; throw new GitHubError(`GitHub connection failed: ${error instanceof Error ? error.message : String(error)}`); }
    if (!response.ok) throw await this.error(response);
    const declaredSize = Number(response.headers.get("content-length") ?? 0);
    if (declaredSize > 25 * 1024 * 1024) throw new GitHubError("Workflow logs archive exceeds the 25 MiB download limit");
    const archive = Buffer.from(await readBoundedBody(response, 25 * 1024 * 1024, "Workflow logs archive"));
    let zip: JSZip;
    try { zip = await JSZip.loadAsync(archive); } catch { throw new GitHubError("GitHub returned an invalid workflow log archive"); }
    const files: Array<{ name: string; text: string }> = []; let total = 0;
    for (const [name, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      const declared = (entry as JSZip.JSZipObject & { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
      if (declared > 2 * 1024 * 1024 || total + declared > 10 * 1024 * 1024) continue;
      const bytes = await entry.async("nodebuffer"); total += bytes.length;
      files.push({ name: name.slice(0, 512), text: redactSecrets(bytes.toString("utf8").slice(0, 100_000), [token]) });
      if (files.length >= 50 || total >= 10 * 1024 * 1024) break;
    }
    return { runId, files };
  }
  async releases(owner: string, repo: string, signal?: AbortSignal): Promise<unknown[]> { return this.paginate(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=100`, 3, signal); }
  async releaseArtifacts(owner: string, repo: string, signal?: AbortSignal): Promise<unknown[]> {
    const output: unknown[] = []; const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/artifacts`;
    for (let page = 1; page <= 3; page++) {
      const result = await this.request<{ total_count?: number; artifacts?: unknown[] }>(`${path}?per_page=100&page=${page}`, {}, signal);
      const artifacts = result.artifacts ?? []; output.push(...artifacts);
      if (!artifacts.length || output.length >= (result.total_count ?? output.length)) break;
    }
    return output;
  }
  async downloadReleaseAsset(owner: string, repo: string, assetId: number, signal?: AbortSignal): Promise<Uint8Array> {
    return this.downloadArchive(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/assets/${assetId}`, signal);
  }
  async downloadActionsArtifact(owner: string, repo: string, artifactId: number, signal?: AbortSignal): Promise<Uint8Array> {
    return this.downloadArchive(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/artifacts/${artifactId}/zip`, signal);
  }
  private async downloadArchive(path: string, signal?: AbortSignal): Promise<Uint8Array> {
    const token = await this.token(signal); const headers = this.headers(token); headers.set("Accept", "application/octet-stream");
    let response: Response;
    try { response = await fetch(`${this.apiBase}${path}`, { headers, ...(signal ? { signal } : {}) }); }
    catch (error) { if (signal?.aborted) throw error; throw new GitHubError(`GitHub connection failed: ${error instanceof Error ? error.message : String(error)}`); }
    if (!response.ok) throw await this.error(response);
    const declaredSize = Number(response.headers.get("content-length") ?? 0);
    if (declaredSize > 100 * 1024 * 1024) throw new GitHubError("GitHub archive exceeds the 100 MiB download limit");
    const bytes = await readBoundedBody(response, 100 * 1024 * 1024, "GitHub archive");
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) throw new GitHubError("GitHub returned metadata instead of an archive");
    return bytes;
  }
  async dispatchWorkflow(owner: string, repo: string, workflow: string, ref: string, inputs: Record<string, string> = {}, signal?: AbortSignal): Promise<void> { await this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { method: "POST", body: JSON.stringify({ ref, inputs }) }, signal); }
  async mergePullRequest(owner: string, repo: string, number: number, method: "merge" | "squash" | "rebase" = "squash", signal?: AbortSignal): Promise<unknown> { return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/merge`, { method: "PUT", body: JSON.stringify({ merge_method: method }) }, signal); }
  async createReviewComment(owner: string, repo: string, number: number, input: { body: string; commitId: string; path: string; line: number; side?: "LEFT" | "RIGHT"; startLine?: number; startSide?: "LEFT" | "RIGHT" }, signal?: AbortSignal): Promise<unknown> {
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/comments`, { method: "POST", body: JSON.stringify({ body: input.body, commit_id: input.commitId, path: input.path, line: input.line, side: input.side ?? "RIGHT", ...(input.startLine === undefined ? {} : { start_line: input.startLine, start_side: input.startSide ?? input.side ?? "RIGHT" }) }) }, signal);
  }
  async replyReviewComment(owner: string, repo: string, number: number, commentId: number, body: string, signal?: AbortSignal): Promise<unknown> {
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/comments/${commentId}/replies`, { method: "POST", body: JSON.stringify({ body }) }, signal);
  }
  async dispatchIssue(owner: string, repo: string, issueNumber: number, eventType = "issues.opened"): Promise<void> {
    if (!this.options.store) throw new Error("Webhook deduplication storage is not configured");
    this.options.store.db.prepare("INSERT OR IGNORE INTO webhook_events(delivery_id,event_type,repository,issue_number,received_at) VALUES(?,?,?,?,?)").run(`issue:${owner}/${repo}#${issueNumber}:${eventType}`, eventType, `${owner}/${repo}`, issueNumber, new Date().toISOString());
  }
}

export function verifyGitHubWebhook(secret: string, body: Buffer | string, signature: string | undefined): boolean {
  if (!signature || !/^sha256=[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const suppliedBuffer = Buffer.from(signature); const expectedBuffer = Buffer.from(expected);
  return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
}

export async function recordWebhookDelivery(store: XystStore, deliveryId: string, eventType: string, repository: string, issueNumber?: number): Promise<boolean> {
  const result = store.db.prepare("INSERT OR IGNORE INTO webhook_events(delivery_id,event_type,repository,issue_number,received_at) VALUES(?,?,?,?,?)").run(deliveryId, eventType, repository, issueNumber ?? null, new Date().toISOString());
  return result.changes === 1;
}

export function createGitHubWebhookHandler(options: {
  store: XystStore;
  secret: () => Promise<string | undefined> | string | undefined;
  shouldIgnoreDelivery?: (event: string, payload: unknown) => Promise<boolean> | boolean;
  onDelivery: (event: string, repository: string, issueNumber: number | undefined, deliveryId: string, payload: unknown) => Promise<void>;
}) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const send = (status: number, body: Record<string, unknown>) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(body)); };
    if (request.method !== "POST") { send(405, { error: "method_not_allowed" }); return; }
    const secret = await options.secret(); if (!secret) { send(503, { error: "webhook_secret_not_configured" }); return; }
    const chunks: Buffer[] = []; let bytes = 0;
    try {
      for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += buffer.length; if (bytes > 1_048_576) { send(413, { error: "payload_too_large" }); return; } chunks.push(buffer); }
      const raw = Buffer.concat(chunks); const signature = request.headers["x-hub-signature-256"];
      if (!verifyGitHubWebhook(secret, raw, Array.isArray(signature) ? signature[0] : signature)) { send(401, { error: "invalid_signature" }); return; }
      const deliveryHeader = request.headers["x-github-delivery"]; const deliveryId = Array.isArray(deliveryHeader) ? deliveryHeader[0] : deliveryHeader;
      const eventHeader = request.headers["x-github-event"]; const event = Array.isArray(eventHeader) ? eventHeader[0] : eventHeader;
      if (!deliveryId || !event) { send(400, { error: "missing_delivery_headers" }); return; }
      const payload = JSON.parse(raw.toString("utf8")) as Record<string, any>;
      const repository = String(payload.repository?.full_name ?? ""); const issueNumber = Number.isInteger(payload.issue?.number) ? payload.issue.number as number : undefined;
      if (!repository) { send(400, { error: "repository_missing" }); return; }
      const fresh = await recordWebhookDelivery(options.store, deliveryId, event, repository, issueNumber);
      const row = options.store.db.prepare("SELECT processed_at FROM webhook_events WHERE delivery_id=?").get(deliveryId) as { processed_at: string | null } | undefined;
      let ignored = false;
      if (fresh || !row?.processed_at) {
        ignored = await options.shouldIgnoreDelivery?.(event, payload) ?? false;
        if (!ignored) await options.onDelivery(event, repository, issueNumber, deliveryId, payload);
        options.store.db.prepare("UPDATE webhook_events SET processed_at=? WHERE delivery_id=?").run(new Date().toISOString(), deliveryId);
      }
      send(202, { accepted: true, duplicate: !fresh, ignored, deliveryId });
    } catch (error) {
      if (!response.headersSent) send(500, { error: "webhook_processing_failed", message: redactSecrets(error instanceof Error ? error.message : String(error)) });
      else response.end();
    }
  };
}
