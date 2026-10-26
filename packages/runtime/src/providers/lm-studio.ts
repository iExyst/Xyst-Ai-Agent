import type { RuntimeEvents } from "../events.js";
import { redactSecrets } from "../credentials.js";
import { runProcess, type ProcessOptions, type ProcessResult } from "../platform.js";
import { LMStudioClient } from "@lmstudio/sdk";

export interface LMStudioModel {
  type: "llm" | "embedding" | "decision";
  publisher: string;
  key: string;
  display_name: string;
  architecture?: string | null;
  quantization?: { name?: string | null; bits_per_weight?: number | null } | null;
  size_bytes: number;
  params_string?: string | null;
  loaded_instances: Array<{ id: string; config: Record<string, unknown> }>;
  max_context_length?: number | null;
  format?: string | null;
  capabilities?: { vision?: boolean; trained_for_tool_use?: boolean; [key: string]: unknown };
}
export interface LMStudioLoadOptions {
  gpu_offload?: "auto" | "off" | "max" | number;
  speculative_draft_mtp?: boolean;
  draft_model?: string;
  speculative_draft_max_tokens?: number;
  speculative_draft_min_tokens?: number;
  speculative_draft_min_continue_probability?: number;
  context_length?: number;
  eval_batch_size?: number;
  flash_attention?: boolean;
  num_experts?: number;
  offload_kv_cache_to_gpu?: boolean;
  ttl_seconds?: number;
  echo_load_config?: boolean;
}
export interface LMStudioChatOptions {
  model: string;
  input: string | Array<Record<string, unknown>>;
  system_prompt?: string;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  repeat_penalty?: number;
  max_output_tokens?: number;
  reasoning?: "off" | "low" | "medium" | "high" | "on";
  context_length?: number;
  store?: boolean;
  previous_response_id?: string;
  integrations?: unknown[];
}
export type LMStudioResponsesRequest = Record<string, unknown> & {
  model: string;
  input: string | Array<Record<string, unknown>>;
};
export interface LMStudioStructuredOutputOptions { model: string; messages: unknown[]; name?: string; schema: Record<string, unknown>; strict?: boolean; temperature?: number; max_tokens?: number; }
export interface LMStudioTokenization { model: string; count: number; tokenIds?: number[]; }
type TokenizeFn = (options: { model: string; text: string; baseUrl: string; token?: string; includeTokenIds: boolean; signal?: AbortSignal }) => Promise<LMStudioTokenization>;
type RequestDeadline = { signal: AbortSignal; timeoutMs: number; didTimeout(): boolean; dispose(): void };

export class LMStudioError extends Error {
  constructor(message: string, readonly status?: number, readonly details?: unknown) { super(message); this.name = "LMStudioError"; }
}

export class LMStudioProvider {
  private readonly baseUrl: () => string;
  private readonly commandRunner: (command: string, args: string[], options?: ProcessOptions) => Promise<ProcessResult>;
  private readonly tokenizeFn: TokenizeFn;
  private readonly requestTimeoutMsResolver: () => number;
  constructor(options: { baseUrl?: string | (() => string); token?: () => Promise<string | undefined> | string | undefined; events?: RuntimeEvents; commandRunner?: (command: string, args: string[], options?: ProcessOptions) => Promise<ProcessResult>; tokenizeFn?: TokenizeFn; requestTimeoutMs?: () => number } = {}) {
    this.baseUrl = () => {
      const configured = typeof options.baseUrl === "function" ? options.baseUrl() : options.baseUrl;
      return (configured ?? process.env.LM_STUDIO_BASE_URL ?? "http://127.0.0.1:1234").replace(/\/+$/, "");
    };
    this.tokenResolver = options.token ?? (() => process.env.LM_API_TOKEN);
    this.events = options.events;
    this.commandRunner = options.commandRunner ?? runProcess;
    this.tokenizeFn = options.tokenizeFn ?? tokenizeWithSdk;
    this.requestTimeoutMsResolver = options.requestTimeoutMs ?? (() => 600_000);
  }

  private readonly tokenResolver: () => Promise<string | undefined> | string | undefined;
  private readonly events: RuntimeEvents | undefined;
  private readonly knownSecrets = new Set<string>();
  private requestDeadline(parentSignal?: AbortSignal, timeoutMs = this.requestTimeoutMsResolver()): RequestDeadline {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new LMStudioError("LM Studio request timeout must be a positive integer number of milliseconds");
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    return {
      signal: parentSignal ? AbortSignal.any([parentSignal, timeoutController.signal]) : timeoutController.signal,
      timeoutMs,
      didTimeout: () => timeoutController.signal.aborted && !parentSignal?.aborted,
      dispose: () => clearTimeout(timer)
    };
  }
  private deadlineError(deadline: RequestDeadline, parentSignal: AbortSignal | undefined, endpoint: string, error: unknown): LMStudioError {
    if (parentSignal?.aborted) return new LMStudioError("LM Studio request cancelled");
    if (deadline.didTimeout()) return new LMStudioError(`LM Studio request to ${endpoint} timed out after ${Math.ceil(deadline.timeoutMs / 1000)} seconds`);
    if (error instanceof SyntaxError) return new LMStudioError(`LM Studio returned invalid JSON for ${endpoint}: ${error.message}`);
    return new LMStudioError(`Cannot connect to LM Studio at ${this.baseUrl()}: ${error instanceof Error ? error.message : String(error)}`);
  }
  redact(value: string): string { return redactSecrets(value, [...this.knownSecrets]); }
  rememberSecretValues(values: Iterable<string>): void { for (const value of values) if (value.length >= 4) this.knownSecrets.add(value); }
  isLocalServer(): boolean {
    const hostname = new URL(this.baseUrl()).hostname;
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
  }
  supportsLocalCliModelLifecycle(): boolean {
    const address = new URL(this.baseUrl());
    return this.isLocalServer() && address.port === "1234" && (address.pathname === "" || address.pathname === "/");
  }

  private remember(token: string | undefined): void { if (token) this.knownSecrets.add(token); }
  private scrub<T>(value: T): T {
    const redactValue = (item: unknown): unknown => {
      if (typeof item === "string") return this.redact(item);
      if (Array.isArray(item)) return item.map(redactValue);
      if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, nested]) => [this.redact(key), redactValue(nested)]));
      return item;
    };
    return redactValue(value) as T;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.tokenResolver();
    this.remember(token);
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body) headers.set("Content-Type", "application/json");
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const parentSignal = init.signal instanceof AbortSignal ? init.signal : undefined;
    const deadline = this.requestDeadline(parentSignal);
    try {
      const response = await fetch(`${this.baseUrl()}${path}`, { ...init, headers, signal: deadline.signal });
      if (!response.ok) {
        let message = "";
        try { message = await response.text(); } catch (error) { throw this.deadlineError(deadline, parentSignal, path, error); }
        const safeMessage = this.redact(message);
        throw new LMStudioError(`LM Studio returned HTTP ${response.status} for ${path}${safeMessage ? `: ${safeMessage.slice(0, 1000)}` : ""}`, response.status, safeMessage);
      }
      return await response.json() as T;
    } catch (error) {
      if (error instanceof LMStudioError && error.status !== undefined) throw error;
      throw this.deadlineError(deadline, parentSignal, path, error);
    } finally { deadline.dispose(); }
  }

  async diagnose(): Promise<{ ok: true; baseUrl: string; models: number }> {
    const result = await this.models();
    return { ok: true, baseUrl: this.baseUrl(), models: result.length };
  }
  async tokenize(model: string, text: string, options: { includeTokenIds?: boolean; signal?: AbortSignal } = {}): Promise<LMStudioTokenization> {
    if (!model.trim()) throw new LMStudioError("A model key is required for tokenization");
    if (typeof text !== "string" || !text.length) throw new LMStudioError("Text is required for tokenization");
    if (Buffer.byteLength(text, "utf8") > 1_000_000) throw new LMStudioError("Tokenization input is limited to 1 MB");
    if (options.signal?.aborted) throw new LMStudioError("Tokenization was cancelled");
    const deadline = this.requestDeadline(options.signal);
    try {
      const token = await this.tokenResolver(); this.remember(token);
      const result = await this.tokenizeFn({ model, text, baseUrl: this.baseUrl(), ...(token ? { token } : {}), includeTokenIds: options.includeTokenIds ?? false, signal: deadline.signal });
      if (options.signal?.aborted) throw new LMStudioError("Tokenization was cancelled");
      return options.includeTokenIds ? result : { model: result.model, count: result.count };
    } catch (error) {
      if (error instanceof LMStudioError) throw error;
      if (options.signal?.aborted) throw new LMStudioError("Tokenization was cancelled");
      if (deadline.didTimeout()) throw new LMStudioError(`LM Studio tokenization timed out after ${Math.ceil(deadline.timeoutMs / 1000)} seconds`);
      throw new LMStudioError(this.redact(`LM Studio tokenization failed: ${error instanceof Error ? error.message : String(error)}`));
    } finally { deadline.dispose(); }
  }
  async models(signal?: AbortSignal): Promise<LMStudioModel[]> {
    const response = await this.request<{ models: LMStudioModel[] }>("/api/v1/models", signal ? { signal } : {});
    return response.models;
  }
  async load(model: string, options: LMStudioLoadOptions = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const usesCliLoad = options.gpu_offload !== undefined || options.ttl_seconds !== undefined || options.speculative_draft_mtp !== undefined || options.draft_model !== undefined ||
      options.speculative_draft_max_tokens !== undefined || options.speculative_draft_min_tokens !== undefined || options.speculative_draft_min_continue_probability !== undefined;
    if (usesCliLoad) {
      if (!this.supportsLocalCliModelLifecycle()) throw new LMStudioError("GPU layer offload, idle TTL, and speculative decoding load controls require the default local LM Studio server on port 1234 and its lms CLI");
      const restOnlyOptions = ["eval_batch_size", "flash_attention", "num_experts", "offload_kv_cache_to_gpu"] as const;
      const incompatible = restOnlyOptions.filter((key) => options[key] !== undefined);
      if (incompatible.length) throw new LMStudioError("GPU layer offload and speculative decoding must be loaded separately from REST-only settings (" + incompatible.join(", ") + "); choose one load operation so LM Studio applies every requested setting");
      const gpu = options.gpu_offload;
      if (typeof gpu === "number" && (!Number.isFinite(gpu) || gpu < 0 || gpu > 1)) throw new LMStudioError("GPU offload ratio must be between 0 and 1");
      if (options.ttl_seconds !== undefined && (!Number.isSafeInteger(options.ttl_seconds) || options.ttl_seconds < 1)) throw new LMStudioError("Model idle TTL must be a positive integer number of seconds");
      if (options.draft_model && options.speculative_draft_mtp) throw new LMStudioError("Choose either an explicit speculative draft model or Draft MTP for a load");
      if (options.draft_model !== undefined && !options.draft_model.trim()) throw new LMStudioError("A non-empty speculative draft model key is required");
      const draftTunings = [options.speculative_draft_max_tokens, options.speculative_draft_min_tokens, options.speculative_draft_min_continue_probability];
      if (draftTunings.some((value) => value !== undefined) && !options.draft_model && !options.speculative_draft_mtp) throw new LMStudioError("Select a speculative draft model or Draft MTP before setting draft limits");
      for (const [name, value] of [["maximum draft tokens", options.speculative_draft_max_tokens], ["minimum draft tokens", options.speculative_draft_min_tokens]] as const) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new LMStudioError(name + " must be a positive integer");
      }
      if (options.speculative_draft_min_tokens !== undefined && options.speculative_draft_max_tokens !== undefined && options.speculative_draft_min_tokens > options.speculative_draft_max_tokens) throw new LMStudioError("Minimum draft tokens cannot exceed maximum draft tokens");
      const probability = options.speculative_draft_min_continue_probability;
      if (probability !== undefined && (!Number.isFinite(probability) || probability < 0 || probability > 1)) throw new LMStudioError("Minimum draft continuation probability must be between 0 and 1");
      const args = ["load", model];
      if (gpu !== undefined) args.push("--gpu=" + gpu);
      if (options.context_length) args.push("--context-length=" + options.context_length);
      if (options.ttl_seconds !== undefined) args.push("--ttl", String(options.ttl_seconds));
      if (options.speculative_draft_mtp !== undefined) args.push(options.speculative_draft_mtp ? "--speculative-draft-mtp" : "--no-speculative-draft-mtp");
      if (options.draft_model) args.push("--speculative-draft-simple", "--speculative-draft-model", options.draft_model);
      if (options.speculative_draft_max_tokens !== undefined) args.push("--speculative-draft-max-tokens", String(options.speculative_draft_max_tokens));
      if (options.speculative_draft_min_tokens !== undefined) args.push("--speculative-draft-min-tokens", String(options.speculative_draft_min_tokens));
      if (probability !== undefined) args.push("--speculative-draft-min-continue-probability", String(probability));
      const command = process.env.LM_STUDIO_CLI_PATH ?? (process.platform === "win32" ? "lms.exe" : "lms");
      let result;
      try { result = await this.commandRunner(command, args, { ...(signal ? { signal } : {}), timeoutMs: 180_000, maxOutputChars: 20_000 }); }
      catch (error) { throw new LMStudioError("Could not run LM Studio CLI (" + command + ") for GPU offload: " + (error instanceof Error ? error.message : String(error)) + ". Install the LM Studio CLI or set LM_STUDIO_CLI_PATH."); }
      if (result.code !== 0) throw new LMStudioError("LM Studio CLI load failed with exit code " + result.code + ": " + (result.stderr || result.stdout).slice(0, 1000));
      return { status: "loaded", model, ...(gpu === undefined ? {} : { gpu_offload: gpu }), ...(options.ttl_seconds === undefined ? {} : { ttl_seconds: options.ttl_seconds }), ...(options.draft_model ? { draft_model: options.draft_model } : {}), ...(options.speculative_draft_mtp === undefined ? {} : { speculative_draft_mtp: options.speculative_draft_mtp }), source: "lms CLI", stdout: result.stdout.trim() };
    }
    return this.request("/api/v1/models/load", { method: "POST", body: JSON.stringify({ model, ...options, echo_load_config: options.echo_load_config ?? true }), ...(signal ? { signal } : {}) });
  }
  async estimateLoad(model: string, options: Pick<LMStudioLoadOptions, "gpu_offload" | "context_length"> = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!model.trim()) throw new LMStudioError("A model key is required for a resource estimate");
    if (options.context_length !== undefined && (!Number.isSafeInteger(options.context_length) || options.context_length < 1)) throw new LMStudioError("Context length must be a positive integer");
    const gpu = options.gpu_offload;
    if (typeof gpu === "number" && (!Number.isFinite(gpu) || gpu < 0 || gpu > 1)) throw new LMStudioError("GPU offload ratio must be between 0 and 1");
    if (!this.supportsLocalCliModelLifecycle()) throw new LMStudioError("Resource estimates are available only for the default local LM Studio server on port 1234 through its CLI");
    const args = ["load", model, "--estimate-only", "--yes"];
    if (options.context_length !== undefined) args.push("--context-length", String(options.context_length));
    if (gpu !== undefined) args.push("--gpu", String(gpu));
    const command = process.env.LM_STUDIO_CLI_PATH ?? (process.platform === "win32" ? "lms.exe" : "lms");
    let result: ProcessResult;
    try { result = await this.commandRunner(command, args, { ...(signal ? { signal } : {}), timeoutMs: 120_000, maxOutputChars: 20_000 }); }
    catch (error) { throw new LMStudioError("Could not run LM Studio CLI (" + command + ") for a resource estimate: " + (error instanceof Error ? error.message : String(error)) + ". Install the LM Studio CLI or set LM_STUDIO_CLI_PATH."); }
    if (result.code !== 0) throw new LMStudioError("LM Studio resource estimate failed with exit code " + result.code + ": " + (result.stderr || result.stdout).slice(0, 1000));
    return { model, estimated: true, source: "lms CLI --estimate-only", output: [result.stdout, result.stderr].filter(Boolean).join("\n").trim() };
  }
  async unload(instanceId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request("/api/v1/models/unload", { method: "POST", body: JSON.stringify({ instance_id: instanceId }), ...(signal ? { signal } : {}) });
  }
  async download(model: string, quantization?: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request("/api/v1/models/download", { method: "POST", body: JSON.stringify({ model, ...(quantization ? { quantization } : {}) }), ...(signal ? { signal } : {}) });
  }
  async downloadStatus(jobId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request(`/api/v1/models/download/status/${encodeURIComponent(jobId)}`, signal ? { signal } : {});
  }
  async chat(options: LMStudioChatOptions, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const result = await this.request<Record<string, unknown>>("/api/v1/chat", { method: "POST", body: JSON.stringify({ store: options.store ?? Boolean(options.previous_response_id), ...options, stream: false }), ...(signal ? { signal } : {}) });
    this.events?.emit("provider.lmstudio.complete", this.scrub(result));
    return this.scrub(result);
  }

  async responses(request: LMStudioResponsesRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!request.model.trim()) throw new LMStudioError("A model key is required for the Responses API");
    if (typeof request.input !== "string" && !Array.isArray(request.input)) throw new LMStudioError("The Responses API input must be text or an input-item array");
    const body = { ...request, stream: false };
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > 1_000_000) throw new LMStudioError("Responses API request is limited to 1 MB");
    const result = await this.request<Record<string, unknown>>("/v1/responses", { method: "POST", body: JSON.stringify(body), ...(signal ? { signal } : {}) });
    const safe = this.scrub(result);
    this.events?.emit("provider.lmstudio.response.completed", safe);
    return safe;
  }

  async *streamResponses(request: LMStudioResponsesRequest, signal?: AbortSignal, timeoutMs?: number): AsyncGenerator<Record<string, unknown>> {
    if (!request.model.trim()) throw new LMStudioError("A model key is required for the Responses API");
    if (typeof request.input !== "string" && !Array.isArray(request.input)) throw new LMStudioError("The Responses API input must be text or an input-item array");
    const body = { ...request, stream: true };
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > 1_000_000) throw new LMStudioError("Responses API request is limited to 1 MB");
    const deadline = this.requestDeadline(signal, timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const endpoint = "/v1/responses";
    try {
      const token = await this.tokenResolver(); this.remember(token);
      const headers = new Headers({ Accept: "text/event-stream", "Content-Type": "application/json" });
      if (token) headers.set("Authorization", `Bearer ${token}`);
      const response = await fetch(`${this.baseUrl()}${endpoint}`, { method: "POST", headers, body: JSON.stringify(body), signal: deadline.signal });
      if (!response.ok) {
        let message = "";
        try { message = await response.text(); } catch (error) { throw this.deadlineError(deadline, signal, endpoint, error); }
        const safeMessage = this.redact(message);
        throw new LMStudioError(`LM Studio returned HTTP ${response.status} for ${endpoint}${safeMessage ? `: ${safeMessage.slice(0, 1000)}` : ""}`, response.status, safeMessage);
      }
      if (!response.body) throw new LMStudioError("LM Studio returned an empty Responses API stream");
      reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      const consume = (frame: string): { payload?: Record<string, unknown>; terminal: boolean; done: boolean } => {
        const eventName = frame.match(/^event:\s*(.+)$/m)?.[1]?.trim();
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
        if (!data) return { terminal: false, done: false };
        if (data === "[DONE]") return { terminal: false, done: true };
        let payload: Record<string, unknown>;
        try { payload = JSON.parse(data) as Record<string, unknown>; }
        catch (error) { throw new LMStudioError(`LM Studio returned invalid SSE JSON for ${endpoint}: ${error instanceof Error ? error.message : String(error)}`); }
        const type = String(payload.type ?? eventName ?? "unknown");
        if (eventName === "error" || type === "error" || type === "response.failed") {
          const detail = typeof payload.error === "string" ? payload.error : JSON.stringify(payload.error ?? payload.response ?? payload);
          throw new LMStudioError(`LM Studio Responses API stream error: ${this.redact(detail).slice(0, 1000)}`);
        }
        return { payload: this.scrub({ ...payload, ...(payload.type === undefined && eventName ? { type: eventName } : {}) }), terminal: ["response.completed", "response.incomplete"].includes(type), done: false };
      };
      let sawTerminal = false; let sawDoneMarker = false;
      responseStream: while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        while (true) {
          const delimiter = /\r?\n\r?\n/.exec(buffer);
          if (!delimiter || delimiter.index === undefined) break;
          const frame = buffer.slice(0, delimiter.index); buffer = buffer.slice(delimiter.index + delimiter[0].length);
          const item = consume(frame);
          if (item.payload) {
            this.events?.emit(`provider.lmstudio.${String(item.payload.type ?? "responses.event")}`, item.payload);
            yield item.payload;
          }
          if (item.terminal) { sawTerminal = true; break responseStream; }
          if (item.done) { sawDoneMarker = true; break responseStream; }
        }
      }
      if (buffer.trim()) {
        const item = consume(buffer);
        if (item.payload) { this.events?.emit(`provider.lmstudio.${String(item.payload.type ?? "responses.event")}`, item.payload); yield item.payload; }
        if (item.terminal) sawTerminal = true;
        if (item.done) sawDoneMarker = true;
      }
      if (!sawTerminal) throw new LMStudioError(`LM Studio Responses API stream ended${sawDoneMarker ? " at [DONE]" : ""} before response.completed or response.incomplete`);
    } catch (error) {
      if (error instanceof LMStudioError) throw error;
      throw this.deadlineError(deadline, signal, endpoint, error);
    } finally { await reader?.cancel().catch(() => undefined); deadline.dispose(); }
  }

  async *streamChat(options: LMStudioChatOptions, signal?: AbortSignal, timeoutMs?: number): AsyncGenerator<Record<string, unknown>> {
    const deadline = this.requestDeadline(signal, timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const token = await this.tokenResolver(); this.remember(token); const headers = new Headers({ Accept: "text/event-stream", "Content-Type": "application/json" });
      if (token) headers.set("Authorization", `Bearer ${token}`);
      const response = await fetch(`${this.baseUrl()}/api/v1/chat`, { method: "POST", headers, body: JSON.stringify({ store: options.store ?? Boolean(options.previous_response_id), ...options, stream: true }), signal: deadline.signal });
      if (!response.ok) {
        let message = "";
        try { message = await response.text(); } catch (error) { throw this.deadlineError(deadline, signal, "/api/v1/chat", error); }
        throw new LMStudioError(`LM Studio returned HTTP ${response.status} for /api/v1/chat: ${this.redact(message).slice(0, 1000)}`, response.status);
      }
      if (!response.body) throw new LMStudioError("LM Studio returned an empty stream");
      reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split: number;
        while ((split = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, split); buffer = buffer.slice(split + 2);
          const eventName = frame.match(/^event:\s*(.+)$/m)?.[1]?.trim(); const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
          if (!data) continue;
          let payload: Record<string, unknown>;
          try { payload = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
          const type = String(payload.type ?? eventName ?? "unknown"); const safePayload = this.scrub(payload); this.events?.emit(`provider.lmstudio.${type}`, safePayload);
          yield safePayload;
          if (type === "error") throw new LMStudioError(`LM Studio stream error: ${JSON.stringify(payload.error ?? payload)}`);
          if (type === "chat.end") return;
        }
      }
      if (buffer.trim()) {
        const data = buffer.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
        if (data) { const payload = JSON.parse(data) as Record<string, unknown>; const safePayload = this.scrub(payload); this.events?.emit(`provider.lmstudio.${String(payload.type ?? "unknown")}`, safePayload); yield safePayload; }
      }
    } catch (error) {
      if (error instanceof LMStudioError) throw error;
      throw this.deadlineError(deadline, signal, "/api/v1/chat", error);
    } finally { await reader?.cancel().catch(() => undefined); deadline.dispose(); }
  }

  async chatWithTools(request: { model: string; messages: unknown[]; tools: unknown[]; temperature?: number; max_tokens?: number; top_p?: number; presence_penalty?: number; frequency_penalty?: number; stop?: string | string[]; reasoning_effort?: "none" | "low" | "medium" | "high" }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request("/v1/chat/completions", { method: "POST", body: JSON.stringify(request), ...(signal ? { signal } : {}) });
  }
  async structuredOutput(request: LMStudioStructuredOutputOptions, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const { name = "xyst_response", strict = true, schema, ...completion } = request;
    return this.request("/v1/chat/completions", { method: "POST", body: JSON.stringify({ ...completion, response_format: { type: "json_schema", json_schema: { name, strict, schema } } }), ...(signal ? { signal } : {}) });
  }
  async streamChatWithTools(request: { model: string; messages: unknown[]; tools: unknown[]; temperature?: number; max_tokens?: number; top_p?: number; presence_penalty?: number; frequency_penalty?: number; stop?: string | string[]; reasoning_effort?: "none" | "low" | "medium" | "high"; ttl?: number }, onText?: (text: string) => void, signal?: AbortSignal, timeoutMs?: number): Promise<Record<string, unknown>> {
    if (request.ttl !== undefined && (!Number.isSafeInteger(request.ttl) || request.ttl < 1)) throw new LMStudioError("Inference idle TTL must be a positive integer number of seconds");
    const deadline = this.requestDeadline(signal, timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let content = ""; let finishReason: unknown = null; let usage: unknown;
    const calls = new Map<number, { id?: string; type?: string; function: { name: string; arguments: string } }>();
    try {
      const token = await this.tokenResolver(); this.remember(token); const headers = new Headers({ Accept: "text/event-stream", "Content-Type": "application/json" });
      if (token) headers.set("Authorization", `Bearer ${token}`);
      const response = await fetch(`${this.baseUrl()}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify({ ...request, stream: true }), signal: deadline.signal });
      if (!response.ok) {
        let message = "";
        try { message = await response.text(); } catch (error) { throw this.deadlineError(deadline, signal, "/v1/chat/completions", error); }
        throw new LMStudioError(`LM Studio returned HTTP ${response.status} for /v1/chat/completions: ${this.redact(message).slice(0, 1000)}`, response.status);
      }
      if (!response.body) throw new LMStudioError("LM Studio returned an empty tool stream");
      reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
    const consume = (frame: string) => {
      const eventName = frame.match(/^event:\s*(.+)$/m)?.[1]?.trim();
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (!data || data === "[DONE]") return;
      const chunk = JSON.parse(data) as Record<string, any>; if (chunk.usage) usage = chunk.usage;
      if (eventName === "error" || chunk.type === "error" || chunk.error) {
        const detail = typeof chunk.error === "string" ? chunk.error : chunk.error?.message ?? JSON.stringify(chunk.error ?? chunk);
        throw new LMStudioError(`LM Studio tool stream error: ${redactSecrets(String(detail)).slice(0, 1000)}`);
      }
      for (const choice of Array.isArray(chunk.choices) ? chunk.choices : []) {
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta ?? {};
        if (typeof delta.content === "string" && delta.content) { content += delta.content; onText?.(this.redact(delta.content)); this.events?.emit("provider.lmstudio.content.delta", { content: this.redact(delta.content), model: request.model }); }
        for (const partial of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
          const index = Number(partial.index ?? 0); const call = calls.get(index) ?? { function: { name: "", arguments: "" } };
          if (partial.id) call.id = partial.id; if (partial.type) call.type = partial.type;
          if (partial.function?.name) call.function.name += partial.function.name;
          if (partial.function?.arguments) call.function.arguments += partial.function.arguments;
          calls.set(index, call);
          this.events?.emit("provider.lmstudio.tool_arguments.delta", { index, name: partial.function?.name, arguments: this.redact(String(partial.function?.arguments ?? "")), model: request.model });
        }
      }
    };
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split: number;
        while ((split = buffer.indexOf("\n\n")) >= 0) { const frame = buffer.slice(0, split); buffer = buffer.slice(split + 2); consume(frame); }
      }
      if (buffer.trim()) consume(buffer);
    } catch (error) {
      if (error instanceof LMStudioError) throw error;
      throw this.deadlineError(deadline, signal, "/v1/chat/completions", error);
    } finally { await reader?.cancel().catch(() => undefined); deadline.dispose(); }
    const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([index, call]) => ({ id: call.id ?? `xyst-${index}`, type: call.type ?? "function", function: call.function }));
    if (!content && !toolCalls.length) throw new LMStudioError(`LM Studio returned an empty completion without text or tool calls${finishReason ? ` (finish reason: ${String(finishReason)})` : ""}`);
    const message: Record<string, unknown> = { role: "assistant", content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
    this.events?.emit("provider.lmstudio.complete", { model: request.model, finish_reason: finishReason, message, usage });
    return { choices: [{ index: 0, message, finish_reason: finishReason }], ...(usage ? { usage } : {}) };
  }
  async embeddings(model: string, input: string | string[], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request("/v1/embeddings", { method: "POST", body: JSON.stringify({ model, input }), ...(signal ? { signal } : {}) });
  }
}

async function tokenizeWithSdk(options: { model: string; text: string; baseUrl: string; token?: string; includeTokenIds: boolean; signal?: AbortSignal }): Promise<LMStudioTokenization> {
  const url = new URL(options.baseUrl);
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  const client = new LMStudioClient({ baseUrl: url.toString().replace(/\/$/, ""), ...(options.token ? { apiToken: options.token } : {}) });
  let disposal: Promise<void> | undefined;
  const dispose = () => disposal ??= client[Symbol.asyncDispose]();
  let rejectCancellation: ((reason: Error) => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
  const onAbort = () => { rejectCancellation?.(new Error("Tokenization was cancelled")); void dispose().catch(() => undefined); };
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const model = client.llm.createDynamicHandle(options.model);
    const tokenize = async () => {
      if (options.includeTokenIds) {
        const tokenIds = await model.tokenize(options.text);
        return { model: options.model, count: tokenIds.length, tokenIds };
      }
      return { model: options.model, count: await model.countTokens(options.text) };
    };
    return await Promise.race([tokenize(), cancelled]);
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    await dispose();
  }
}
