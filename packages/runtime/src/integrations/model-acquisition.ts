import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { readFile, rename, stat, statfs } from "node:fs/promises";
import { freemem, totalmem } from "node:os";
import { Transform } from "node:stream";
import { AccessController } from "../access.js";
import { runProcess, type ProcessResult } from "../platform.js";
import { readHostResourceStats, type HostResourceStats } from "../system-resources.js";
import type { ConfigStore, SettingScope, XystStore } from "../storage.js";
import type { LMStudioProvider } from "../providers/lm-studio.js";
import type { HuggingFaceProvider } from "./huggingface.js";

type HubGgufFile = { rfilename: string; size?: number; lfs?: { size?: number; sha256?: string } };
type GgufArtifact = { filename: string; role: "model" | "model-shard" | "vision-projector"; sizeBytes: number; sha256?: string };
type GgufArtifactSet = { artifact: string; quantization: string; sizeBytes: number; files: GgufArtifact[] };
const unsupportedChatPipelines = new Set(["automatic-speech-recognition", "audio-classification", "audio-to-audio", "depth-estimation", "fill-mask", "image-classification", "image-to-text", "object-detection", "text-ranking", "text-to-audio", "text-to-speech", "token-classification", "zero-shot-classification"]);
const nonChatModelName = /(?:^|[-_.\/])(?:asr|embedding|embeddings|rerank(?:er|ing)?|retrieval|retriever|reward)(?:[-_.\/]|$)/i;

function normalizeModelRepositoryKey(value: string): string {
  const parts = value.trim().toLowerCase().split("/");
  const name = parts.pop() ?? "";
  parts.push(name.replace(/[-_.]gguf$/, ""));
  return parts.join("/");
}

function findDownloadedModel<T extends { key: string }>(models: T[], repository: string): { model?: T; status: "verified" | "not_found" | "ambiguous" } {
  const exact = models.find((model) => model.key.toLowerCase() === repository.toLowerCase());
  if (exact) return { model: exact, status: "verified" };
  const normalizedRepository = normalizeModelRepositoryKey(repository);
  const normalizedMatches = models.filter((model) => normalizeModelRepositoryKey(model.key) === normalizedRepository);
  if (normalizedMatches.length === 1) return { model: normalizedMatches[0]!, status: "verified" };
  if (normalizedMatches.length > 1) return { status: "ambiguous" };
  const basename = normalizedRepository.split("/").at(-1)!;
  const basenameMatches = models.filter((model) => normalizeModelRepositoryKey(model.key).split("/").at(-1) === basename);
  if (basenameMatches.length === 1) return { model: basenameMatches[0]!, status: "verified" };
  return { status: basenameMatches.length > 1 ? "ambiguous" : "not_found" };
}

export class ModelAcquisitionService {
  constructor(private readonly deps: { store: XystStore; config: ConfigStore; huggingFace: HuggingFaceProvider; lmStudio: LMStudioProvider; access?: AccessController; commandRunner?: (command: string, args: string[], options?: { cwd?: string; signal?: AbortSignal; timeoutMs?: number; maxOutputChars?: number }) => Promise<ProcessResult>; hostResourceStats?: () => Promise<HostResourceStats>; modelDirectory?: () => Promise<string>; diskAvailableBytes?: (path: string) => Promise<number> }) {}
  private async modelDirectory(): Promise<string> {
    if (this.deps.modelDirectory) return resolve(await this.deps.modelDirectory());
    const override = process.env.LM_STUDIO_MODEL_DIR?.trim();
    if (override) return resolve(override);
    try {
      const settings = JSON.parse(await readFile(resolve(homedir(), ".lmstudio", "settings.json"), "utf8")) as { downloadsFolder?: unknown };
      if (typeof settings.downloadsFolder === "string" && settings.downloadsFolder.trim()) return resolve(settings.downloadsFolder);
    } catch { /* Use LM Studio's documented default when settings are unavailable. */ }
    return resolve(homedir(), ".lmstudio", "models");
  }
  private async diskSpace(path: string): Promise<number> {
    if (this.deps.diskAvailableBytes) return this.deps.diskAvailableBytes(path);
    let candidate = resolve(path);
    for (;;) {
      try { const stats = await statfs(candidate, { bigint: true }); return Number(stats.bavail * stats.bsize); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const parent = dirname(candidate);
        if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === candidate) throw new Error(`Cannot inspect free space for the LM Studio model directory: ${error instanceof Error ? error.message : String(error)}`);
        candidate = parent;
      }
    }
  }
  listDownloads() {
    return this.deps.store.db.prepare("SELECT id,repository,revision,quantization,lm_job_id,state,total_size_bytes,details_json,created_at,updated_at FROM model_downloads ORDER BY created_at DESC LIMIT 50").all();
  }
  async search(query: string, signal?: AbortSignal) {
    if (this.deps.config.resolve<boolean>("models.onlineDiscovery")?.value !== true) throw new Error("Online model discovery is off; enable it with `model discovery on`");
    const models = await this.deps.huggingFace.search(query, { limit: 20, ...(signal ? { signal } : {}) });
    return models.map((model) => ({ id: model.id, author: model.author, pipeline: model.pipeline_tag, downloads: model.downloads, likes: model.likes, updatedAt: model.lastModified, private: model.private, gated: model.gated, license: model.tags?.find((tag) => tag.startsWith("license:"))?.slice("license:".length) }));
  }
  async recommend(query: string, signal?: AbortSignal, scopes: Partial<Record<SettingScope, string>> = {}, requirements: { minimumContextTokens?: number; visionRequired?: boolean } = {}) {
    if (!query.trim()) throw new Error("A model task or capability query is required");
    if (this.deps.config.resolve<boolean>("models.onlineDiscovery", scopes)?.value !== true) throw new Error("Online model discovery is off; enable it with `model discovery on`");
    const maxDownloadBytes = this.deps.config.resolve<number>("models.maxDownloadBytes", scopes)?.value ?? 20 * 1024 ** 3;
    const access = this.deps.access ?? new AccessController();
    const runner = this.deps.commandRunner;
    const resources = await (this.deps.hostResourceStats?.() ?? readHostResourceStats(access, runner ? (command, args, options) => runner(command, args, options) : undefined)).catch(() => undefined);
    const availableRamBytes = resources?.systemMemory.availableBytes ?? freemem();
    const totalRamBytes = resources?.systemMemory.totalBytes ?? totalmem();
    const configuredMemoryBudget = this.deps.config.resolve<number | null>("orchestration.memoryBudgetBytes", scopes)?.value;
    const memoryBudgetBytes = Math.floor(Math.min(availableRamBytes * 0.6, totalRamBytes * 0.5, 16 * 1024 ** 3, configuredMemoryBudget ?? Number.MAX_SAFE_INTEGER));
    const concurrencyLimit = this.deps.config.resolve<number>("orchestration.maxConcurrency", scopes)?.value ?? 8;
    const gpuFreeBytes = resources?.nvidiaGpuMemory.status === "available" ? Math.max(...resources.nvidiaGpuMemory.devices.map((device) => device.freeBytes)) : undefined;
    const modelDirectory = await this.modelDirectory();
    const allowedLicenses = this.deps.config.resolve<string[]>("models.allowedLicenses", scopes)?.value ?? [];
    const [diskAvailableBytes, tempDiskAvailableBytes] = await Promise.all([this.diskSpace(modelDirectory), this.diskSpace(tmpdir())]);
    const found = await this.deps.huggingFace.search(query, { limit: 8, ...(signal ? { signal } : {}) });
    const recommendations: Array<Record<string, unknown>> = [];
    for (const result of found) {
      if (result.private || result.gated) continue;
      const metadata = await this.deps.huggingFace.model(result.id, signal);
      if (metadata.private || metadata.gated) continue;
      if (typeof metadata.pipeline_tag === "string" && unsupportedChatPipelines.has(metadata.pipeline_tag)) continue;
      if (nonChatModelName.test(metadata.id)) continue;
      const license = typeof metadata.cardData?.license === "string" ? metadata.cardData.license : metadata.tags?.find((tag) => tag.startsWith("license:"))?.slice("license:".length);
      const files = await this.deps.huggingFace.files(result.id, metadata.sha ?? "main", signal);
      const pinnedRevision = /^[a-f0-9]{40,64}$/i.test(metadata.sha ?? "") ? metadata.sha! : undefined;
      const modelConfig = pinnedRevision ? await this.deps.huggingFace.modelConfig(metadata.id, pinnedRevision, signal).catch((error) => { if (signal?.aborted) throw error; return undefined; }) : undefined;
      const configRecords = modelConfig ? [modelConfig, ...[modelConfig.text_config, modelConfig.llm_config].filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))] : [];
      const contextValue = configRecords.flatMap((config) => ["max_position_embeddings", "max_sequence_length", "max_seq_len", "seq_length", "n_positions", "model_max_length"].map((key) => config[key])).find((value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0);
      const declaredContextTokens = typeof contextValue === "number" ? contextValue : undefined;
      if (requirements.minimumContextTokens !== undefined && (declaredContextTokens === undefined || declaredContextTokens < requirements.minimumContextTokens)) continue;
      const assumedContextTokens = requirements.minimumContextTokens ?? Math.min(declaredContextTokens ?? 4096, 4096);
      const candidates = buildGgufArtifactSets(files, requirements.visionRequired === true).flatMap((set) => {
        const { quantization, sizeBytes } = set;
        if (sizeBytes > maxDownloadBytes || requirements.minimumContextTokens !== undefined && (!pinnedRevision || set.files.some((file) => !/^[a-f0-9]{64}$/i.test(file.sha256 ?? "")))) return [];
        const estimatedWeightMemoryBytes = Math.ceil(sizeBytes * 1.25);
        const architectureValue = (keys: string[]) => configRecords.flatMap((config) => keys.map((key) => config[key])).find((value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0) as number | undefined;
        const layers = architectureValue(["num_hidden_layers", "n_layer", "num_layers", "n_layers"]);
        const attentionHeads = architectureValue(["num_attention_heads", "n_head"]);
        const kvHeads = architectureValue(["num_key_value_heads", "num_kv_heads", "n_head_kv"]) ?? attentionHeads;
        const hiddenSize = architectureValue(["hidden_size", "n_embd", "d_model"]);
        const headDimension = architectureValue(["head_dim", "attention_head_size"]) ?? (hiddenSize !== undefined && attentionHeads !== undefined && hiddenSize % attentionHeads === 0 ? hiddenSize / attentionHeads : undefined);
        const estimatedKvCacheBytes = layers !== undefined && kvHeads !== undefined && headDimension !== undefined
          ? assumedContextTokens * 2 * layers * kvHeads * headDimension * 2
          : undefined;
        const memoryEstimateReliable = estimatedKvCacheBytes !== undefined && Number.isSafeInteger(estimatedKvCacheBytes) && estimatedKvCacheBytes >= 0 && estimatedKvCacheBytes <= Number.MAX_SAFE_INTEGER;
        const perAgentMemoryBytes = estimatedWeightMemoryBytes + (memoryEstimateReliable ? estimatedKvCacheBytes! : 0);
        const estimatedMemoryBytes = perAgentMemoryBytes;
        if (estimatedMemoryBytes > memoryBudgetBytes) return [];
        return [{ ...set, estimatedWeightMemoryBytes, estimatedKvCacheBytes: memoryEstimateReliable ? estimatedKvCacheBytes : undefined, estimatedMemoryBytes, estimatedConcurrentMemoryBytes: estimatedMemoryBytes * concurrencyLimit, memoryEstimateCoverage: memoryEstimateReliable ? "weights-and-kv-cache" as const : "weights-only-kv-cache-unknown" as const }];
      });
      candidates.sort((a, b) => {
        const aConcurrentFit = a.estimatedConcurrentMemoryBytes <= memoryBudgetBytes ? 1 : 0;
        const bConcurrentFit = b.estimatedConcurrentMemoryBytes <= memoryBudgetBytes ? 1 : 0;
        const aGpuFit = gpuFreeBytes !== undefined && a.estimatedMemoryBytes <= gpuFreeBytes ? 1 : 0;
        const bGpuFit = gpuFreeBytes !== undefined && b.estimatedMemoryBytes <= gpuFreeBytes ? 1 : 0;
        const aDiskFit = diskAvailableBytes >= Math.ceil(a.sizeBytes * 1.05) && tempDiskAvailableBytes >= Math.ceil(a.sizeBytes * 1.05) ? 1 : 0;
        const bDiskFit = diskAvailableBytes >= Math.ceil(b.sizeBytes * 1.05) && tempDiskAvailableBytes >= Math.ceil(b.sizeBytes * 1.05) ? 1 : 0;
        return bConcurrentFit - aConcurrentFit || bGpuFit - aGpuFit || bDiskFit - aDiskFit || quantizationRank(b.quantization) - quantizationRank(a.quantization) || a.sizeBytes - b.sizeBytes;
      });
      const selected = candidates[0];
      if (!selected) continue;
      if (nonChatModelName.test(selected.artifact)) continue;
      const publishedEvaluationEvidence = summarizePublishedEvaluations(metadata.cardData);
      recommendations.push({
        repository: metadata.id, revision: metadata.sha ?? "main", artifact: selected.artifact,
        ...(metadata.pipeline_tag ? { pipeline: metadata.pipeline_tag } : {}),
        sha256: selected.files.find((file) => file.filename === selected.artifact)?.sha256,
        artifacts: selected.files,
        ...(requirements.visionRequired ? { visionRequired: true, companionFiles: selected.files.filter((file) => file.role === "vision-projector").map((file) => file.filename) } : {}),
        quantization: selected.quantization, sizeBytes: selected.sizeBytes, estimatedMemoryBytes: selected.estimatedMemoryBytes,
        estimatedWeightMemoryBytes: selected.estimatedWeightMemoryBytes,
        ...(selected.estimatedKvCacheBytes !== undefined ? { estimatedKvCacheBytes: selected.estimatedKvCacheBytes } : {}),
        assumedContextTokens, concurrencyLimit, estimatedConcurrentMemoryBytes: selected.estimatedConcurrentMemoryBytes,
        memoryEstimateCoverage: selected.memoryEstimateCoverage,
        memoryBudgetBytes, availableRamBytes,
        estimatedFullOffloadGpuMemoryBytes: selected.estimatedMemoryBytes,
        ...(gpuFreeBytes !== undefined ? { maxSingleGpuFreeBytes: gpuFreeBytes, estimatedFullOffloadFitsCurrentGpuMemory: selected.estimatedMemoryBytes <= gpuFreeBytes } : { gpuMemoryStatus: resources?.nvidiaGpuMemory.status ?? "unavailable" }),
        concurrentMemoryFitsBudget: selected.estimatedConcurrentMemoryBytes <= memoryBudgetBytes,
        ...(declaredContextTokens !== undefined ? { declaredContextTokens } : {}),
        diskAvailableBytes, diskRequiredBytes: Math.ceil(selected.sizeBytes * 1.05),
        tempDiskAvailableBytes, tempDiskRequiredBytes: Math.ceil(selected.sizeBytes * 1.05),
        diskSufficient: diskAvailableBytes >= Math.ceil(selected.sizeBytes * 1.05) && tempDiskAvailableBytes >= Math.ceil(selected.sizeBytes * 1.05),
        downloads: metadata.downloads ?? result.downloads ?? 0, license: license ?? null,
        licenseAllowed: typeof license === "string" && allowedLicenses.includes(license.trim().toLowerCase()),
        publishedEvaluationEvidence,
        resourceEstimateAssumptions: {
          weightMemoryMultiplier: 1.25,
          kvCachePrecision: "FP16",
          kvCacheFormula: "2 (K and V) * layers * KV heads * head dimension * 2 bytes * assumed context tokens",
          concurrency: "full per-agent model and KV memory multiplied by the saved maximum concurrency; assumes separate model loads",
          gpu: "full model and KV estimate compared with free VRAM on the largest single NVIDIA device; assumes full offload"
        },
        reason: `${publishedEvaluationEvidence.length ? `Hub metadata lists ${publishedEvaluationEvidence.length} evaluation result(s); these are claims to review, not independent or directly comparable quality scores. ` : "No structured evaluation results were found in Hub metadata. "}Resource-aware shortlist with a ${selected.quantization} GGUF. Estimated single-agent RAM is ${selected.estimatedMemoryBytes} bytes (${selected.memoryEstimateCoverage}; ${assumedContextTokens}-token context) against a ${memoryBudgetBytes}-byte effective budget; ${concurrencyLimit}-agent estimated memory is ${selected.estimatedConcurrentMemoryBytes} bytes${selected.estimatedConcurrentMemoryBytes > memoryBudgetBytes ? " and exceeds that budget" : " and fits that budget"}. Estimated full-offload GPU memory is ${selected.estimatedMemoryBytes} bytes${gpuFreeBytes === undefined ? "; current NVIDIA free VRAM is unavailable" : ` against ${gpuFreeBytes} bytes free on the largest single GPU`}; the loaded-model LM Studio estimate is still required to verify actual placement. The artifact fits the ${maxDownloadBytes}-byte download cap. Disk preflight needs ${Math.ceil(selected.sizeBytes * 1.05)} bytes on both the LM Studio model-directory volume and temporary volume. Weight memory uses artifact size × 1.25; when config dimensions are available, KV cache assumes FP16. Concurrency multiplies the full per-agent estimate by the saved maximum concurrency. GPU fit assumes full offload on one GPU. These are conservative estimates, not measured model usage.`
      });
    }
    recommendations.sort((a, b) => {
      const aEvaluations = Array.isArray(a.publishedEvaluationEvidence) ? a.publishedEvaluationEvidence.length : 0;
      const bEvaluations = Array.isArray(b.publishedEvaluationEvidence) ? b.publishedEvaluationEvidence.length : 0;
      const aGpuFit = a.estimatedFullOffloadFitsCurrentGpuMemory === true ? 1 : 0;
      const bGpuFit = b.estimatedFullOffloadFitsCurrentGpuMemory === true ? 1 : 0;
      const aConcurrentFit = a.concurrentMemoryFitsBudget === true ? 1 : 0;
      const bConcurrentFit = b.concurrentMemoryFitsBudget === true ? 1 : 0;
      const aDiskFit = a.diskSufficient === true ? 1 : 0;
      const bDiskFit = b.diskSufficient === true ? 1 : 0;
      return bConcurrentFit - aConcurrentFit || bGpuFit - aGpuFit || bDiskFit - aDiskFit || bEvaluations - aEvaluations || Number(b.downloads ?? 0) - Number(a.downloads ?? 0);
    });
    return recommendations.slice(0, 5);
  }
  async model(repository: string, signal?: AbortSignal) {
    if (this.deps.config.resolve<boolean>("models.onlineDiscovery")?.value !== true) throw new Error("Online model discovery is off; enable it with `model discovery on`");
    const [metadata, files] = await Promise.all([this.deps.huggingFace.model(repository, signal), this.deps.huggingFace.files(repository, "main", signal)]);
    return {
      id: metadata.id, author: metadata.author, revision: metadata.sha, pipeline: metadata.pipeline_tag,
      downloads: metadata.downloads, likes: metadata.likes, updatedAt: metadata.lastModified,
      private: metadata.private, gated: metadata.gated,
      license: typeof metadata.cardData?.license === "string" ? metadata.cardData.license : metadata.tags?.find((tag) => tag.startsWith("license:"))?.slice("license:".length),
      files: files.map((file) => ({ name: file.rfilename, sizeBytes: file.lfs?.size ?? file.size, sha256: file.lfs?.sha256 }))
    };
  }
  async card(repository: string, signal?: AbortSignal) {
    if (this.deps.config.resolve<boolean>("models.onlineDiscovery")?.value !== true) throw new Error("Online model discovery is off; enable it with `model discovery on`");
    return this.deps.huggingFace.card(repository, "main", signal);
  }
  async acquireRecommended(recommendation: Record<string, unknown>, signal?: AbortSignal, scopes: Partial<Record<SettingScope, string>> = {}) {
    if (this.deps.config.resolve<boolean>("models.onlineDiscovery", scopes)?.value !== true) throw new Error("Online model discovery is off; enable it with `model discovery on`");
    if (this.deps.config.resolve<boolean>("models.automaticDownloads", scopes)?.value !== true) throw new Error("Model downloads are off; enable them with `model downloads on`");
    const license = typeof recommendation.license === "string" ? recommendation.license.trim().toLowerCase() : "";
    const allowedLicenses = this.deps.config.resolve<string[]>("models.allowedLicenses", scopes)?.value ?? [];
    if (!license || !allowedLicenses.includes(license)) throw new Error(`Automatic model acquisition is blocked: license ${license || "(missing from Hub metadata)"} is not in the saved models.allowedLicenses preference`);
    const access = this.deps.access ?? new AccessController();
    access.assertCapability("network"); access.assertCapability("externalActions"); access.assertExecutable("lms");
    const repository = String(recommendation.repository ?? "");
    const revision = String(recommendation.revision ?? "");
    const artifact = String(recommendation.artifact ?? "");
    const quantization = String(recommendation.quantization ?? "");
    const expectedBytes = Number(recommendation.sizeBytes);
    const sha256 = String(recommendation.sha256 ?? "").toLowerCase();
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.split("/").some((part) => part === "." || part === "..")) throw new Error("Recommendation has an invalid Hub repository");
    if (!/^[a-f0-9]{40,64}$/i.test(revision)) throw new Error("Recommendation does not pin an immutable Hub commit");
    const rawArtifacts = Array.isArray(recommendation.artifacts) ? recommendation.artifacts : [{ filename: artifact, role: "model", sizeBytes: expectedBytes, sha256 }];
    const artifacts = rawArtifacts.map((item) => {
      if (!item || typeof item !== "object") throw new Error("Recommendation contains an invalid artifact entry");
      const file = item as Record<string, unknown>;
      const filename = String(file.filename ?? "");
      const role = String(file.role ?? "");
      const sizeBytes = Number(file.sizeBytes);
      const fileSha = String(file.sha256 ?? "").toLowerCase();
      const filenameParts = filename.split("/");
      if (!filename || filename.startsWith("/") || filename.includes("\\") || filename.includes(":") || filenameParts.some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) || !filename.toLowerCase().endsWith(".gguf")) throw new Error("Recommendation contains an unsafe or unsupported GGUF filename");
      if (!/[a-f0-9]{64}/.test(fileSha) || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) throw new Error(`Recommendation artifact ${filename} is missing a valid size or SHA-256`);
      if (!["model", "model-shard", "vision-projector"].includes(role)) throw new Error(`Recommendation artifact ${filename} has an unsupported role`);
      return { filename, role: role as GgufArtifact["role"], sizeBytes, sha256: fileSha };
    });
    if (!artifact || !quantization || !Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || !artifacts.length) throw new Error("Recommendation does not identify a supported, sized GGUF artifact set");
    if (!artifacts.some((file) => file.filename === artifact && file.sha256 === sha256) || artifacts.reduce((total, file) => total + file.sizeBytes, 0) !== expectedBytes) throw new Error("Recommendation artifact set does not match its declared primary artifact, hash, and total size");
    if (new Set(artifacts.map((file) => file.filename.toLowerCase())).size !== artifacts.length) throw new Error("Recommendation contains duplicate artifact filenames");
    const isBundle = artifacts.length > 1 || artifacts.some((file) => file.role !== "model");
    if (!isBundle && (!isStandaloneGguf(artifact) || artifacts[0]!.role !== "model" || artifacts[0]!.sha256 !== sha256)) throw new Error("Recommendation does not identify a supported, verifiable standalone GGUF artifact");
    if (!artifacts.some((file) => file.role === "model") || artifacts.filter((file) => file.role === "vision-projector").length > 1) throw new Error("Recommendation artifact set has no model or has ambiguous vision projectors");
    const limit = this.deps.config.resolve<number>("models.maxDownloadBytes", scopes)?.value ?? 20 * 1024 ** 3;
    if (expectedBytes > limit) throw new Error(`Selected artifact is ${expectedBytes} bytes, over the configured ${limit} byte model download limit`);
    const directory = await this.modelDirectory();
    const [available, tempAvailable] = await Promise.all([this.diskSpace(directory), this.diskSpace(tmpdir())]);
    const needed = Math.ceil(expectedBytes * 1.05);
    if (available < needed || tempAvailable < needed) throw new Error(`Insufficient disk space for verified model staging (need ${needed} bytes in both the LM Studio model directory and temporary directory)`);
    const safeName = artifact.split("/").at(-1)!;
    const stagingDir = await access.assertPath(join(tmpdir(), "xyst-model-downloads"), "write");
    await mkdir(stagingDir, { recursive: true });
    const partial = await access.assertPath(join(stagingDir, `${randomUUID()}.partial`), "write");
    const staged = partial.slice(0, -".partial".length) + ".gguf";
    const artifactSetIdentity = createHash("sha256").update(JSON.stringify(artifacts.map(({ filename, role, sizeBytes, sha256: fileSha }) => ({ filename, role, sizeBytes, sha256: fileSha })))).digest("hex");
    const previous = this.deps.store.db.prepare("SELECT id,state,details_json,updated_at FROM model_downloads WHERE repository=? AND revision=? AND quantization=? ORDER BY updated_at DESC LIMIT 1").get(repository, revision, quantization) as { id: string; state: string; details_json: string; updated_at: string } | undefined;
    const previousDetails = previous ? (() => { try { return JSON.parse(previous.details_json) as Record<string, unknown>; } catch { return {}; } })() : {};
    const reusableState = previous && ["downloading", "failed"].includes(previous.state) && previousDetails.artifactSetIdentity === artifactSetIdentity && Array.isArray(previousDetails.stagingFiles);
    const previousFiles = reusableState ? previousDetails.stagingFiles as Array<Record<string, unknown>> : [];
    const stagingFiles = artifacts.map((file, index) => {
      const old = previousFiles[index];
      const oldPath = typeof old?.stagingFile === "string" ? resolve(old.stagingFile) : "";
      const safePrefix = `${resolve(stagingDir)}${sep}`;
      const canReuse = old?.filename === file.filename && old?.sha256 === file.sha256 && old?.sizeBytes === file.sizeBytes && oldPath.startsWith(safePrefix) && oldPath.endsWith(".partial");
      return { ...file, stagingFile: canReuse ? oldPath : join(stagingDir, `${randomUUID()}-${index}.partial`) };
    });
    const id = reusableState ? previous!.id : randomUUID(); const now = new Date().toISOString();
    const details: Record<string, unknown> = { artifact, sha256, artifactSetIdentity, stagingFiles, expectedBytes, state: "downloading", resumedFromDownloadId: reusableState ? id : undefined };
    if (reusableState) this.deps.store.db.prepare("UPDATE model_downloads SET state='downloading',details_json=?,updated_at=? WHERE id=?").run(JSON.stringify(details), now, id);
    else this.deps.store.db.prepare("INSERT INTO model_downloads(id,repository,revision,quantization,state,total_size_bytes,details_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id, repository, revision, quantization, "downloading", expectedBytes, JSON.stringify(details), now, now);
    let importStarted = false;
    let bundleInstalled = false;
    let acquisitionCompleted = false;
    const installedPaths: string[] = [];
    try {
      const verifiedFiles: Array<{ filename: string; role: string; stagingFile: string; sha256: string; sizeBytes: number }> = [];
      for (const file of stagingFiles) {
        let verifiedSha: string | undefined;
        let lastError: unknown;
        for (let attempt = 1; attempt <= 3 && !verifiedSha; attempt++) {
          try {
            let currentBytes = await stat(file.stagingFile).then((result) => result.size).catch(() => 0);
            if (currentBytes > file.sizeBytes) { await rm(file.stagingFile, { force: true }); currentBytes = 0; }
            if (currentBytes === file.sizeBytes) {
              const completeHash = await hashFile(file.stagingFile);
              if (completeHash === file.sha256) { verifiedSha = completeHash; break; }
              await rm(file.stagingFile, { force: true }); currentBytes = 0;
            }
            const requestedOffset = currentBytes > 0 ? currentBytes : undefined;
            const response = await this.deps.huggingFace.downloadArtifact(repository, revision, file.filename, signal, requestedOffset);
            if (response.status === 416) {
              await response.body?.cancel().catch(() => undefined);
              await rm(file.stagingFile, { force: true });
              throw new Error(`Hub rejected the resume offset for ${file.filename}; restarting from byte zero`);
            }
            let append = requestedOffset !== undefined && response.status === 206;
            if (append) {
              const contentRange = response.headers.get("content-range") ?? "";
              const match = contentRange.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/i);
              if (!match || Number(match[1]) !== requestedOffset || (match[3] !== "*" && Number(match[3]) !== file.sizeBytes)) {
                await response.body?.cancel().catch(() => undefined);
                await rm(file.stagingFile, { force: true });
                throw new Error(`Hub returned an invalid Content-Range while resuming ${file.filename}`);
              }
            } else if (response.status !== 200) throw new Error(`Hub returned HTTP ${response.status} for ${file.filename}`);
            const prefixBytes = append ? requestedOffset! : 0;
            const hash = createHash("sha256");
            if (append) for await (const chunk of createReadStream(file.stagingFile)) hash.update(chunk as Buffer);
            if (!response.body) throw new Error(`Hub returned no artifact body for ${file.filename}`);
            let received = prefixBytes;
            const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
              received += chunk.length;
              if (received > file.sizeBytes || received > limit) { callback(new Error(`Downloaded artifact ${file.filename} exceeded its declared size or configured limit`)); return; }
              hash.update(chunk); callback(null, chunk);
            } });
            const exists = currentBytes > 0;
            await pipeline(response.body as unknown as NodeJS.ReadableStream, meter, createWriteStream(file.stagingFile, { flags: append ? "a" : exists ? "w" : "wx" }), { signal });
            if (received !== file.sizeBytes) throw new Error(`Downloaded artifact size mismatch for ${file.filename}: expected ${file.sizeBytes} bytes, received ${received}`);
            const actualHash = hash.digest("hex");
            if (actualHash !== file.sha256) { await rm(file.stagingFile, { force: true }); throw new Error(`Downloaded artifact SHA-256 does not match pinned Hub metadata for ${file.filename}`); }
            verifiedSha = actualHash;
          } catch (error) {
            lastError = error;
            const progress = await Promise.all(stagingFiles.map((entry) => stat(entry.stagingFile).then((result) => ({ filename: entry.filename, receivedBytes: result.size })).catch(() => ({ filename: entry.filename, receivedBytes: 0 }))));
            this.deps.store.db.prepare("UPDATE model_downloads SET details_json=?,updated_at=? WHERE id=?").run(JSON.stringify({ ...details, state: "downloading", progress, retryAttempt: attempt, lastError: error instanceof Error ? error.message : String(error) }), new Date().toISOString(), id);
            if (signal?.aborted || attempt === 3) throw error;
            await new Promise((resolveRetry) => setTimeout(resolveRetry, 200 * attempt));
          }
        }
        if (!verifiedSha) throw lastError instanceof Error ? lastError : new Error(`Could not verify downloaded artifact ${file.filename}`);
        verifiedFiles.push({ ...file, sha256: verifiedSha });
      }
      details.state = "importing";
      this.deps.store.db.prepare("UPDATE model_downloads SET state='importing',details_json=?,updated_at=? WHERE id=?").run(JSON.stringify({ ...details, verifiedFiles }), new Date().toISOString(), id);
      importStarted = true;
      let imported: ProcessResult | undefined;
      if (!isBundle) {
        const single = verifiedFiles[0]!;
        const singleStaged = await access.assertPath(staged, "write");
        await rename(single.stagingFile, singleStaged);
        imported = await (this.deps.commandRunner ?? runProcess)("lms", ["import", singleStaged, "--user-repo", repository, "--copy", "--yes"], { ...(signal ? { signal } : {}), timeoutMs: 30 * 60_000, maxOutputChars: 12_000 });
        if (imported.code !== 0) throw new Error(`LM Studio import failed (${imported.code}): ${imported.stderr.slice(-2000) || imported.stdout.slice(-2000)}`);
      } else {
        const targetRoot = await access.assertPath(join(directory, ...repository.split("/")), "write");
        for (const file of verifiedFiles) {
          const target = await access.assertPath(join(targetRoot, file.filename), "write");
          await mkdir(dirname(target), { recursive: true });
          await copyFile(file.stagingFile, target, constants.COPYFILE_EXCL);
          installedPaths.push(target);
        }
        bundleInstalled = true;
      }
      const models = await this.deps.lmStudio.models(signal);
      let match = models.find((candidate) => candidate.key.toLowerCase() === repository.toLowerCase());
      if (!match) {
        const basename = repository.split("/").at(-1)!.toLowerCase(); const matches = models.filter((candidate) => candidate.key.toLowerCase().split("/").at(-1) === basename);
        if (matches.length === 1) match = matches[0];
        else throw new Error(matches.length ? `Import completed but inventory match is ambiguous for ${repository}` : `Import completed but ${repository} is not yet visible in LM Studio inventory`);
      }
      if (!match) throw new Error(`Import completed but ${repository} is not visible in LM Studio inventory`);
      const primaryVerification = verifiedFiles.find((file) => file.filename === artifact);
      const completedDetails = { ...details, state: "completed", importedModelKey: match.key, verifiedFiles, ...(primaryVerification ? { verifiedSha256: primaryVerification.sha256 } : {}), ...(imported ? { importer: { stdout: imported.stdout.slice(-4000), durationMs: imported.durationMs } } : { installedPaths }) };
      this.deps.store.db.prepare("UPDATE model_downloads SET state='completed',details_json=?,updated_at=? WHERE id=?").run(JSON.stringify(completedDetails), new Date().toISOString(), id);
      acquisitionCompleted = true;
      return { id, repository, revision, artifact: safeName, quantization, modelKey: match.key, state: "completed", sha256, artifacts: verifiedFiles.map((file) => file.filename) };
    } catch (error) {
      if (isBundle && !bundleInstalled) for (const path of installedPaths) await rm(path, { force: true }).catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      const state = importStarted ? "uncertain" : "failed";
      this.deps.store.db.prepare("UPDATE model_downloads SET state=?,details_json=?,updated_at=? WHERE id=?").run(state, JSON.stringify({ ...details, state, error: message }), new Date().toISOString(), id);
      throw error;
    } finally {
      await rm(partial, { force: true }).catch(() => undefined);
      if (acquisitionCompleted) {
        await rm(staged, { force: true }).catch(() => undefined);
        for (const file of stagingFiles) await rm(file.stagingFile, { force: true }).catch(() => undefined);
      }
    }
  }
  async download(repository: string, quantization?: string, signal?: AbortSignal) {
    if (this.deps.config.resolve<boolean>("models.onlineDiscovery")?.value !== true) throw new Error("Online model discovery is off; enable it with `model discovery on`");
    if (this.deps.config.resolve<boolean>("models.automaticDownloads")?.value !== true) throw new Error("Model downloads are off; enable them with `model downloads on`");
    const metadata = await this.deps.huggingFace.model(repository, signal);
    if (metadata.private) throw new Error("Private Hub repositories cannot be downloaded by LM Studio through this integration");
    if (metadata.gated) throw new Error("This model is gated. Accept its license and configure Hub access in LM Studio before downloading");
    const files = await this.deps.huggingFace.files(repository, "main", signal);
    const candidates = files.filter((file) => isStandaloneGguf(file.rfilename));
    const selected = quantization ? candidates.filter((file) => file.rfilename.toLowerCase().includes(quantization.toLowerCase())) : candidates;
    if (selected.length !== 1) throw new Error(selected.length ? `Quantization is ambiguous (${selected.map((file) => file.rfilename).join(", ")}); specify an exact quantization` : "No single compatible GGUF artifact could be identified in this repository");
    const selectedSize = selected[0]!.lfs?.size ?? selected[0]!.size;
    if (!selectedSize || !Number.isSafeInteger(selectedSize)) throw new Error("Hub metadata does not report a reliable artifact size; download was not started");
    const maxBytes = this.deps.config.resolve<number>("models.maxDownloadBytes")?.value ?? 20 * 1024 ** 3;
    if (selectedSize > maxBytes) throw new Error(`Selected artifact is ${selectedSize} bytes, over the configured ${maxBytes} byte model download limit`);
    const modelDirectory = await this.modelDirectory();
    const [diskAvailableBytes, tempDiskAvailableBytes] = await Promise.all([this.diskSpace(modelDirectory), this.diskSpace(tmpdir())]);
    const diskRequiredBytes = Math.ceil(selectedSize * 1.05);
    if (diskAvailableBytes < diskRequiredBytes) throw new Error(`Insufficient free space at the LM Studio model directory (${modelDirectory}): need about ${diskRequiredBytes} bytes including a 5% partial-download margin, have ${diskAvailableBytes} bytes`);
    if (tempDiskAvailableBytes < diskRequiredBytes) throw new Error(`Insufficient free space in the system temporary directory (${tmpdir()}): need about ${diskRequiredBytes} bytes to allow for download staging, have ${tempDiskAvailableBytes} bytes`);
    const preflight = { modelDirectory, diskAvailableBytes, diskRequiredBytes, tempDirectory: tmpdir(), tempDiskAvailableBytes, checkedAt: new Date().toISOString(), status: "sufficient" };
    const id = randomUUID(); const now = new Date().toISOString();
    this.deps.store.db.prepare("INSERT INTO model_downloads(id,repository,revision,quantization,state,total_size_bytes,details_json,created_at,updated_at) VALUES(?,?, 'main', ?, 'starting', ?, ?, ?, ?)").run(id, repository, quantization ?? null, selectedSize, JSON.stringify({ preflight }), now, now);
    try {
      const started = await this.deps.lmStudio.download(`https://huggingface.co/${repository}`, quantization, signal);
      const status = String(started.status ?? "unknown"); const lmJobId = typeof started.job_id === "string" ? started.job_id : null;
      this.deps.store.db.prepare("UPDATE model_downloads SET lm_job_id=?,state=?,details_json=?,updated_at=? WHERE id=?").run(lmJobId, status, JSON.stringify({ preflight, ...started }), new Date().toISOString(), id);
      return { id, repository, revision: "main", quantization, artifact: selected[0]!.rfilename, estimatedBytes: selectedSize, preflight, ...started };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.store.db.prepare("UPDATE model_downloads SET state='failed',details_json=?,updated_at=? WHERE id=?").run(JSON.stringify({ preflight, error: message }), new Date().toISOString(), id);
      throw error;
    }
  }
  async status(id: string, signal?: AbortSignal) {
    const row = this.deps.store.db.prepare("SELECT * FROM model_downloads WHERE id=? OR lm_job_id=?").get(id, id) as { id: string; repository: string; revision: string; quantization: string | null; lm_job_id: string | null; state: string; total_size_bytes: number | null; details_json: string } | undefined;
    if (!row) throw new Error(`Model download not found: ${id}`);
    const terminal = ["completed", "already_downloaded", "failed"].includes(row.state);
    let state = row.state;
    let details = JSON.parse(row.details_json) as Record<string, unknown>;
    if (row.lm_job_id && !terminal) {
      const current = await this.deps.lmStudio.downloadStatus(row.lm_job_id, signal);
      state = String(current.status ?? row.state);
      details = { ...details, ...current };
    }
    if (["completed", "already_downloaded"].includes(state) && !details.inventoryVerification) {
      try {
        const models = await this.deps.lmStudio.models(signal);
        const match = findDownloadedModel(models, row.repository);
        details.inventoryVerification = { status: match.status, modelKey: match.model?.key ?? null, checkedAt: new Date().toISOString() };
      } catch (error) {
        details.inventoryVerification = { status: "unavailable", error: error instanceof Error ? error.message : String(error), checkedAt: new Date().toISOString() };
      }
    }
    this.deps.store.db.prepare("UPDATE model_downloads SET state=?,details_json=?,updated_at=? WHERE id=?").run(state, JSON.stringify(details), new Date().toISOString(), row.id);
    const inventoryVerification = details.inventoryVerification as { status?: string } | undefined;
    return { ...row, state, details, ...(inventoryVerification ? { inventoryVerified: inventoryVerification.status === "verified" } : {}) };
  }
  async verify(id: string, signal?: AbortSignal, requirements: { visionRequired?: boolean } = {}) {
    const row = this.deps.store.db.prepare("SELECT * FROM model_downloads WHERE id=? OR lm_job_id=?").get(id, id) as { id: string; repository: string; revision: string; quantization: string | null; state: string; total_size_bytes: number | null; details_json: string } | undefined;
    if (!row) throw new Error(`Model download not found: ${id}`);
    if (!["completed", "already_downloaded"].includes(row.state)) throw new Error(`Model download is not complete (state: ${row.state})`);
    const details = JSON.parse(row.details_json) as Record<string, any>;
    const models = await this.deps.lmStudio.models(signal);
    const match = findDownloadedModel(models, row.repository);
    const model = match.model;
    if (!model) throw new Error(match.status === "ambiguous" ? `Model inventory match is ambiguous for ${row.repository}; select the exact LM Studio model and verify it manually` : `Downloaded model ${row.repository} was not found in LM Studio inventory`);
    if (requirements.visionRequired && model.capabilities?.vision !== true) throw new Error(`Downloaded model ${model.key} does not declare vision support in LM Studio inventory`);
    details.inventoryVerification = { status: "verified", modelKey: model.key, checkedAt: new Date().toISOString() };
    if (model.type !== "llm" && model.type !== "decision") throw new Error(`Downloaded model ${model.key} is ${model.type}; a generation probe is not supported`);

    const originalInstances = new Set(model.loaded_instances.map((instance) => instance.id));
    const otherLoaded = models.flatMap((entry) => entry.loaded_instances.map((instance) => ({ key: entry.key, id: instance.id }))).filter((instance) => !originalInstances.has(instance.id));
    if (originalInstances.size === 0 && otherLoaded.length > 0) throw new Error("Capability verification would require loading a second model while another model is active. Unload or pause active work, then retry to avoid disrupting it.");

    let loadedByVerification = false;
    const createdInstanceIds = new Set<string>();
    let probe: Record<string, unknown> | undefined;
    let failure: string | undefined;
    try {
      if (originalInstances.size === 0) {
        const loaded = await this.deps.lmStudio.load(model.key, { context_length: Math.min(model.max_context_length ?? 2048, 2048), echo_load_config: true }, signal);
        loadedByVerification = true;
        const returnedId = loaded.instance_id ?? loaded.id;
        if (typeof returnedId === "string") createdInstanceIds.add(returnedId);
        const afterLoad = await this.deps.lmStudio.models(signal);
        for (const instance of afterLoad.find((entry) => entry.key === model!.key)?.loaded_instances ?? []) if (!originalInstances.has(instance.id)) createdInstanceIds.add(instance.id);
      }
      const input = requirements.visionRequired
        ? [{ role: "user", content: [{ type: "text", text: "Describe this test image in one word." }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pWQAAAAASUVORK5CYII=" } }] }]
        : "Reply with exactly: XYST_MODEL_READY";
      const response = await this.deps.lmStudio.chat({ model: model.key, input, max_output_tokens: 24, temperature: 0, store: false }, signal);
      const output = extractResponseText(response);
      if (!output.trim()) throw new Error("LM Studio returned no generated text");
      probe = { status: "passed", modelKey: model.key, output: output.slice(0, 500), checkedAt: new Date().toISOString(), loadedByVerification };
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      probe = { status: "failed", modelKey: model.key, error: failure, checkedAt: new Date().toISOString(), loadedByVerification };
    } finally {
      if (loadedByVerification) {
        try {
          const after = await this.deps.lmStudio.models();
          const currentIds = new Set(after.find((entry) => entry.key === model!.key)?.loaded_instances.map((instance) => instance.id) ?? []);
          for (const instanceId of createdInstanceIds) if (currentIds.has(instanceId)) await this.deps.lmStudio.unload(instanceId);
        } catch (error) {
          const cleanupError = error instanceof Error ? error.message : String(error);
          failure = `Inference probe completed, but the verification instance could not be unloaded: ${cleanupError}`;
          probe = { ...probe, status: "cleanup_failed", cleanupError };
        }
      }
    }
    details.capabilityCheck = probe;
    this.deps.store.db.prepare("UPDATE model_downloads SET details_json=?,updated_at=? WHERE id=?").run(JSON.stringify(details), new Date().toISOString(), row.id);
    if (failure) throw new Error(`Model was discovered, but its capability check failed: ${failure}`);
    return { id: row.id, repository: row.repository, revision: row.revision, state: row.state, inventoryVerification: details.inventoryVerification ?? { status: "verified", modelKey: model.key }, capabilityCheck: probe };
  }
}

function summarizePublishedEvaluations(cardData: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  const entries = Array.isArray(cardData?.eval_results) ? cardData.eval_results : [];
  return entries.slice(0, 6).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    const dataset = item.dataset && typeof item.dataset === "object" && !Array.isArray(item.dataset) ? item.dataset as Record<string, unknown> : {};
    const metric = item.metric && typeof item.metric === "object" && !Array.isArray(item.metric) ? item.metric as Record<string, unknown> : {};
    const source = item.source && typeof item.source === "object" && !Array.isArray(item.source) ? item.source as Record<string, unknown> : {};
    const clean = (value: unknown, max = 160) => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
    const sourceUrl = clean(source.url, 2048);
    const safeSourceUrl = sourceUrl && /^https:\/\//i.test(sourceUrl) ? sourceUrl : undefined;
    const summary = {
      ...(clean(dataset.name ?? dataset.id) ? { dataset: clean(dataset.name ?? dataset.id) } : {}),
      ...(clean(metric.name ?? metric.type) ? { metric: clean(metric.name ?? metric.type) } : {}),
      ...(typeof item.value === "number" && Number.isFinite(item.value) ? { value: item.value } : {}),
      ...(clean(item.date, 40) ? { date: clean(item.date, 40) } : {}),
      ...(clean(source.name, 100) ? { source: clean(source.name, 100) } : {}),
      ...(safeSourceUrl ? { sourceUrl: safeSourceUrl } : {})
    };
    return Object.keys(summary).length ? [summary] : [];
  });
}

function extractResponseText(response: Record<string, any>): string {
  if (typeof response.output_text === "string") return response.output_text;
  const read = (value: any): string => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(read).join("");
    if (!value || typeof value !== "object") return "";
    if (typeof value.text === "string") return value.text;
    return read(value.content ?? value.output_text ?? value.output ?? value.message);
  };
  return read(response.output ?? response.content ?? response.choices?.[0]?.message?.content);
}

function quantizationRank(value: string): number {
  const rank: Record<string, number> = { Q4_K_M: 100, Q5_K_M: 95, Q4_K_S: 90, Q5_K_S: 85, IQ4_XS: 80, Q4_0: 75, Q3_K_M: 60, Q3_K_S: 50, Q2_K: 35 };
  return rank[value] ?? (/^Q[4-6]_/.test(value) ? 70 : /^Q[3-6]/.test(value) ? 45 : 10);
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function buildGgufArtifactSets(files: HubGgufFile[], visionRequired: boolean): GgufArtifactSet[] {
  const splitGroups = new Map<string, { expected: number; parts: Map<number, HubGgufFile>; duplicate: boolean }>();
  const singles: HubGgufFile[] = [];
  for (const file of files) {
    const name = file.rfilename;
    if (!name.toLowerCase().endsWith(".gguf")) continue;
    if (/mmproj|adapter|tokenizer|vocab|mtp|draft/i.test(basename(name))) continue;
    const split = name.match(/^(.*)-(\d{5})-of-(\d{5})\.gguf$/i);
    if (!split) { singles.push(file); continue; }
    const index = Number(split[2]); const expected = Number(split[3]);
    if (!expected || index < 1 || index > expected) continue;
    const key = `${split[1]!.toLowerCase()}-${expected}`;
    const group = splitGroups.get(key) ?? { expected, parts: new Map<number, HubGgufFile>(), duplicate: false };
    if (group.parts.has(index)) group.duplicate = true;
    group.parts.set(index, file); splitGroups.set(key, group);
  }
  const coreSets: Array<{ files: HubGgufFile[]; quantization: string; artifact: string }> = [];
  const addCore = (core: HubGgufFile[]) => {
    const quantization = core[0]?.rfilename.match(/(IQ\d+_[A-Z0-9_]+|Q\d+_[A-Z0-9_]+)/i)?.[1]?.toUpperCase();
    if (!quantization || !core.length || core.some((file) => !validHubFileSize(file))) return;
    if (new Set(core.map((file) => basename(file.rfilename).toLowerCase())).size !== core.length) return;
    const ordered = [...core].sort((a, b) => splitIndex(a.rfilename) - splitIndex(b.rfilename));
    coreSets.push({ files: ordered, quantization, artifact: ordered[0]!.rfilename });
  };
  for (const file of singles) addCore([file]);
  for (const group of splitGroups.values()) {
    if (group.duplicate || group.parts.size !== group.expected) continue;
    const parts = Array.from({ length: group.expected }, (_, index) => group.parts.get(index + 1));
    if (parts.some((part) => !part)) continue;
    addCore(parts as HubGgufFile[]);
  }
  const projectors = files.filter((file) => /mmproj/i.test(basename(file.rfilename)) && basename(file.rfilename).toLowerCase().endsWith(".gguf") && validHubFileSize(file));
  return coreSets.flatMap((core) => {
    let selectedProjector: HubGgufFile | undefined;
    if (visionRequired) {
      selectedProjector = chooseProjector(core.files[0]!.rfilename, projectors);
      if (!selectedProjector) return [];
    }
    const selectedFiles = [
      ...core.files.map((file, index): GgufArtifact => ({ filename: file.rfilename, role: core.files.length > 1 && index > 0 ? "model-shard" : "model", sizeBytes: (file.lfs?.size ?? file.size)!, ...(file.lfs?.sha256 ? { sha256: file.lfs.sha256 } : {}) })),
      ...(selectedProjector ? [{ filename: selectedProjector.rfilename, role: "vision-projector" as const, sizeBytes: (selectedProjector.lfs?.size ?? selectedProjector.size)!, ...(selectedProjector.lfs?.sha256 ? { sha256: selectedProjector.lfs.sha256 } : {}) }] : [])
    ];
    const sizeBytes = selectedFiles.reduce((total, file) => total + file.sizeBytes, 0);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) return [];
    return [{ artifact: core.artifact, quantization: core.quantization, sizeBytes, files: selectedFiles }];
  });
}

function validHubFileSize(file: HubGgufFile): boolean {
  const size = file.lfs?.size ?? file.size;
  return typeof size === "number" && Number.isSafeInteger(size) && size > 0;
}

function splitIndex(filename: string): number {
  const match = filename.match(/-(\d{5})-of-\d{5}\.gguf$/i);
  return match ? Number(match[1]) : 0;
}

function chooseProjector(modelFile: string, projectors: HubGgufFile[]): HubGgufFile | undefined {
  const modelTokens = modelFamilyTokens(modelFile);
  const scored = projectors.map((file) => {
    const projectorTokens = modelFamilyTokens(file.rfilename);
    const overlap = projectorTokens.filter((token) => modelTokens.includes(token)).length;
    return { file, score: overlap / Math.max(1, Math.min(projectorTokens.length, modelTokens.length)) };
  }).filter((item) => item.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.length && (scored.length === 1 || scored[0]!.score > scored[1]!.score) && scored[0]!.score >= 0.5 ? scored[0]!.file : undefined;
}

function modelFamilyTokens(filename: string): string[] {
  const stem = basename(filename).toLowerCase().replace(/\.gguf$/, "").replace(/^mmproj[-_]?/, "").replace(/-(?:f16|bf16|f32|f64)$/i, "").replace(/-\d{5}-of-\d{5}$/i, "");
  return stem.split(/[^a-z0-9]+/).filter(Boolean);
}

function isStandaloneGguf(filename: string): boolean {
  return filename.toLowerCase().endsWith(".gguf") && !/mmproj|adapter|tokenizer|split|-\d{5}-of-\d{5}/i.test(filename);
}
