import type { SettingScope } from "./storage.js";
import { lmStudioIntegrationsSchema } from "./providers/lm-studio-integrations.js";

const ocrLanguages = new Set(["eng", "fra", "deu", "spa"]);

const booleans = new Set([
  "model.autoSelect", "models.automaticLoading", "models.automaticUnloading", "models.remoteFallback", "models.onlineDiscovery", "models.automaticDownloads", "models.automaticSwitching",
  "telemetry.localMetrics", "browser.automation.enabled", "browser.headless", "desktop.automation.enabled",
  "integrations.github.enabled", "integrations.github.writeEnabled", "integrations.github.mergeEnabled",
  "integrations.mcp.enabled", "integrations.lmStudio.nativeChat.enabled", "memory.semantic.enabled", "orchestration.scheduling.enabled", "orchestration.retries.enabled", "orchestration.delegation.enabled", "autonomy.externalActionApproval", "network.enabled", "notifications.enabled", "updates.enabled", "updates.autoDownload"
]);

export function validateSettingValue(key: string, value: unknown): void {
  if (booleans.has(key) && typeof value !== "boolean") throw new Error(`${key} must be true or false`);
  if (key === "documents.officeRendererExecutable" && value !== null && (typeof value !== "string" || !value.trim() || value.length > 1000 || value.includes("\0"))) throw new Error("documents.officeRendererExecutable must be a non-empty executable name or path of at most 1,000 characters, or null");
  if (key === "models.allowedLicenses" && (!Array.isArray(value) || value.length > 100 || value.some((license) => typeof license !== "string" || !/^[a-z0-9][a-z0-9.+-]{0,99}$/.test(license)) || new Set((value as string[]).map((license) => license.toLowerCase())).size !== value.length)) throw new Error("models.allowedLicenses must be an array of up to 100 unique lowercase Hugging Face license tags");
  if (key === "integrations.lmStudio.nativeChat.integrations") lmStudioIntegrationsSchema.parse(value);
  if (key === "documents.ocrLanguages" && (!Array.isArray(value) || value.length < 1 || value.length > ocrLanguages.size || value.some((language) => typeof language !== "string" || !ocrLanguages.has(language)) || new Set(value).size !== value.length)) {
    throw new Error("documents.ocrLanguages must be a unique array of 1–4 supported language codes: eng, fra, deu, spa");
  }
  if (key === "model.default" || key === "memory.embeddingModel" || key === "models.remoteFallbackModel") {
    if (value !== null && (typeof value !== "string" || value.trim().length === 0 || value.length > 300)) throw new Error(`${key} must be a non-empty string or null`);
  }
  if (key === "models.remoteFallbackUrl") {
    if (value !== null && (typeof value !== "string" || value.length > 500)) throw new Error("models.remoteFallbackUrl must be an HTTP(S) URL or null");
    if (typeof value === "string") {
      let url: URL;
      try { url = new URL(value); } catch { throw new Error("models.remoteFallbackUrl must be an HTTP(S) URL or null"); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("models.remoteFallbackUrl must be an HTTP(S) base URL without credentials, query, or fragment");
    }
  }
  if (key === "updates.feedUrl") {
    if (value !== null && (typeof value !== "string" || value.length > 1000)) throw new Error("updates.feedUrl must be an HTTPS base URL or null");
    if (typeof value === "string") {
      let url: URL;
      try { url = new URL(value); } catch { throw new Error("updates.feedUrl must be an HTTPS base URL or null"); }
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("updates.feedUrl must be an HTTPS base URL without credentials, query, or fragment");
    }
  }
  if (key === "integrations.github.apiBaseUrl") {
    if (value !== null && (typeof value !== "string" || value.length > 500)) throw new Error("integrations.github.apiBaseUrl must be an HTTPS API base URL or null");
    if (typeof value === "string") {
      let url: URL;
      try { url = new URL(value); } catch { throw new Error("integrations.github.apiBaseUrl must be an HTTPS API base URL or null"); }
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.hostname === "api.github.com") throw new Error("integrations.github.apiBaseUrl must be an HTTPS GitHub Enterprise API base URL without credentials, query, or fragment");
    }
  }
  if (key === "integrations.lmStudio.baseUrl") {
    if (value !== null && (typeof value !== "string" || value.length > 500)) throw new Error("integrations.lmStudio.baseUrl must be an HTTP(S) base URL or null");
    if (typeof value === "string") {
      let url: URL;
      try { url = new URL(value); } catch { throw new Error("integrations.lmStudio.baseUrl must be an HTTP(S) base URL or null"); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("integrations.lmStudio.baseUrl must be a credential-free HTTP(S) base URL; remote servers require HTTPS");
    }
  }
  const numericRanges: Record<string, [number, number, boolean]> = {
    "inference.temperature": [0, 2, false], "inference.maxTokens": [1, 1_000_000, true], "inference.requestTimeoutSeconds": [5, 3600, true], "inference.topP": [0, 1, false], "inference.topK": [1, 1000, true], "inference.repeatPenalty": [0.1, 5, false],
    "inference.presencePenalty": [-2, 2, false], "inference.frequencyPenalty": [-2, 2, false],
    "models.idleUnloadSeconds": [60, 604_800, true], "models.maxDownloadBytes": [1, 20 * 1024 ** 3, true], "browser.maxDownloadBytes": [1_048_576, 10 * 1024 ** 3, true],
    "orchestration.maxConcurrency": [1, 8, true], "tools.maxParallelReads": [1, 8, true], "orchestration.memoryBudgetBytes": [268_435_456, Number.MAX_SAFE_INTEGER, true]
  };
  const range = numericRanges[key];
  if (range) {
    if (key === "orchestration.memoryBudgetBytes" && value === null) return;
    const [min, max, integer] = range;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) {
      throw new Error(`${key} must be ${integer ? "an integer" : "a number"} from ${min} through ${max}${key === "inference.temperature" || key === "inference.topP" ? " (inclusive)" : ""}`);
    }
  }
  if (key === "inference.stopSequences" && value !== null && !(typeof value === "string" && value.length <= 1000) && !(Array.isArray(value) && value.length <= 8 && value.every((entry) => typeof entry === "string" && entry.length <= 1000))) {
    throw new Error("inference.stopSequences must be a string, an array of up to 8 strings, or null");
  }
  if (key === "inference.reasoning" && value !== null && !["off", "low", "medium", "high", "on"].includes(String(value))) {
    throw new Error('inference.reasoning must be off, low, medium, high, on, or null');
  }
  if (key === "access.profile") {
    if (!value || typeof value !== "object" || !["full", "restricted"].includes(String((value as Record<string, unknown>).mode))) throw new Error('access.profile must be an object with mode "full" or "restricted"');
    const profile = value as Record<string, unknown>;
    const fields = new Set(["mode", "readRoots", "writeRoots", "allowedExecutables", "network", "integrations", "backgroundJobs", "externalActions"]);
    if (Object.keys(profile).some((field) => !fields.has(field))) throw new Error("access.profile contains an unsupported field");
    for (const field of ["readRoots", "writeRoots", "allowedExecutables"] as const) if (profile[field] !== undefined && (!Array.isArray(profile[field]) || (profile[field] as unknown[]).length > 100 || !(profile[field] as unknown[]).every((entry) => typeof entry === "string" && entry.trim().length > 0 && entry.length <= 1000))) throw new Error(`access.profile.${field} must be an array of up to 100 non-empty strings of at most 1,000 characters`);
    for (const field of ["network", "integrations", "backgroundJobs", "externalActions"] as const) if (profile[field] !== undefined && typeof profile[field] !== "boolean") throw new Error(`access.profile.${field} must be true or false`);
  }
}

export function validateSettingScope(scope: SettingScope, scopeId: string): void {
  if (scope === "global" && scopeId) throw new Error("The global settings scope cannot have a scope ID");
  if (scope !== "global" && !scopeId.trim()) throw new Error(`The ${scope} scope requires a scope ID`);
  if (scopeId.length > 500) throw new Error("Setting scope ID is too long");
}
