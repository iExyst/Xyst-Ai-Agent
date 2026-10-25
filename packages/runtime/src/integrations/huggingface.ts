import type { CredentialStore } from "../credentials.js";

export interface HuggingFaceModel {
  id: string;
  author?: string;
  pipeline_tag?: string;
  downloads?: number;
  likes?: number;
  lastModified?: string;
  private?: boolean;
  gated?: boolean | string;
  tags?: string[];
  [key: string]: unknown;
}
export interface HuggingFaceFile { rfilename: string; size?: number; lfs?: { size?: number; sha256?: string; pointerSize?: number; oid?: string }; [key: string]: unknown }
export interface HuggingFaceRepository extends HuggingFaceModel { siblings?: HuggingFaceFile[]; cardData?: Record<string, unknown>; sha?: string }

export class HuggingFaceProvider {
  constructor(private readonly credentials: Pick<CredentialStore, "get">, private readonly baseUrl = "https://huggingface.co") {}
  private async request<T>(path: string, signal?: AbortSignal): Promise<T> {
    const token = await this.credentials.get("huggingface", "access-token");
    const headers = new Headers({ Accept: "application/json", "User-Agent": "Xyst/0.1" });
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(`${this.baseUrl}${path}`, { headers, ...(signal ? { signal } : {}) });
    if (!response.ok) {
      const details = await response.text().catch(() => "");
      throw new Error(`Hugging Face returned HTTP ${response.status}${details ? `: ${details.slice(0, 600)}` : ""}`);
    }
    return await response.json() as T;
  }
  async search(query: string, options: { limit?: number; task?: string; signal?: AbortSignal } = {}): Promise<HuggingFaceModel[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    const params = new URLSearchParams({ search: query, limit: String(limit), sort: "downloads", direction: "-1" });
    if (options.task) params.set("pipeline_tag", options.task);
    return this.request<HuggingFaceModel[]>(`/api/models?${params}`, options.signal);
  }
  async model(repository: string, signal?: AbortSignal): Promise<HuggingFaceRepository> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Model repository must use owner/name format");
    return this.request<HuggingFaceRepository>(`/api/models/${repository.split("/").map(encodeURIComponent).join("/")}?blobs=true`, signal);
  }
  async files(repository: string, revision = "main", signal?: AbortSignal): Promise<HuggingFaceFile[]> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Model repository must use owner/name format");
    const repo = repository.split("/").map(encodeURIComponent).join("/");
    const entries = await this.request<Array<HuggingFaceFile & { path?: string }>>(`/api/models/${repo}/tree/${encodeURIComponent(revision)}?recursive=true&expand=true`, signal);
    return entries.map((entry) => ({ ...entry, rfilename: entry.rfilename ?? entry.path ?? "" }));
  }
  async downloadArtifact(repository: string, revision: string, filename: string, signal?: AbortSignal, rangeStart?: number): Promise<Response> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Model repository must use owner/name format");
    if (!/^[a-f0-9]{40,64}$/i.test(revision)) throw new Error("Artifact downloads require a pinned Hugging Face commit revision");
    const segments = filename.split("/");
    if (!filename || filename.length > 1024 || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\"))) throw new Error("Artifact filename contains an invalid path segment");
    const token = await this.credentials.get("huggingface", "access-token");
    const headers = new Headers({ Accept: "application/octet-stream", "User-Agent": "Xyst/0.1", "Accept-Encoding": "identity" });
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (rangeStart !== undefined) {
      if (!Number.isSafeInteger(rangeStart) || rangeStart < 0) throw new Error("Artifact resume offset must be a non-negative safe integer");
      headers.set("Range", `bytes=${rangeStart}-`);
    }
    const repo = repository.split("/").map(encodeURIComponent).join("/");
    const path = segments.map(encodeURIComponent).join("/");
    const response = await fetch(`${this.baseUrl}/${repo}/resolve/${encodeURIComponent(revision)}/${path}`, { headers, ...(signal ? { signal } : {}) });
    if (!response.ok && !(response.status === 416 && rangeStart !== undefined)) {
      const details = await response.text().catch(() => "");
      throw new Error(`Hugging Face artifact download returned HTTP ${response.status}${details ? `: ${details.slice(0, 600)}` : ""}`);
    }
    return response;
  }
  async modelConfig(repository: string, revision: string, signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Model repository must use owner/name format");
    if (!/^[a-f0-9]{40,64}$/i.test(revision)) throw new Error("Model config lookup requires a pinned Hugging Face commit revision");
    const token = await this.credentials.get("huggingface", "access-token");
    const headers = new Headers({ Accept: "application/json", "User-Agent": "Xyst/0.1" }); if (token) headers.set("Authorization", `Bearer ${token}`);
    const repo = repository.split("/").map(encodeURIComponent).join("/");
    const response = await fetch(`${this.baseUrl}/${repo}/resolve/${encodeURIComponent(revision)}/config.json`, { headers, ...(signal ? { signal } : {}) });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Hugging Face model config returned HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > 1_000_000) { await response.body?.cancel(); throw new Error("Hugging Face model config exceeds the 1 MB inspection limit"); }
    if (!response.body) throw new Error("Hugging Face returned an empty model config");
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        length += value.byteLength;
        if (length > 1_000_000) { await reader.cancel(); throw new Error("Hugging Face model config exceeds the 1 MB inspection limit"); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Hugging Face model config is not a JSON object");
    return parsed as Record<string, unknown>;
  }
  async card(repository: string, revision = "main", signal?: AbortSignal): Promise<string> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Model repository must use owner/name format");
    const token = await this.credentials.get("huggingface", "access-token");
    const headers = new Headers({ Accept: "text/plain", "User-Agent": "Xyst/0.1" }); if (token) headers.set("Authorization", `Bearer ${token}`);
    const repo = repository.split("/").map(encodeURIComponent).join("/");
    const response = await fetch(`${this.baseUrl}/${repo}/raw/${encodeURIComponent(revision)}/README.md`, { headers, ...(signal ? { signal } : {}) });
    if (!response.ok) throw new Error(`Hugging Face returned HTTP ${response.status} while reading the model card`);
    return (await response.text()).slice(0, 50_000);
  }
}
