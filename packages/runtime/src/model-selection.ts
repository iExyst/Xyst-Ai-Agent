import { freemem, totalmem } from "node:os";
import type { LMStudioModel } from "./providers/lm-studio.js";
import type { ModelPerformanceStats } from "./model-performance.js";
import type { ModelTaskType } from "./model-task-type.js";

export interface ModelChoice { model: LMStudioModel; reason: string; considered: number }
export const MODEL_CONTEXT_HEADROOM_TOKENS = 8192;
export function modelLoadContextLength(maxContextTokens: number | null | undefined, requiredContextTokens: number): number | undefined {
  if (!Number.isSafeInteger(requiredContextTokens) || requiredContextTokens < 1 || typeof maxContextTokens !== "number" || !Number.isSafeInteger(maxContextTokens) || maxContextTokens < requiredContextTokens) return undefined;
  return Math.min(maxContextTokens, requiredContextTokens + MODEL_CONTEXT_HEADROOM_TOKENS);
}

/** Estimate text/history tokens without treating image data URLs as text; reserve headroom for the system prompt, tool schemas, and generation overhead. */
export function estimateRequiredContextTokens(messages: Array<{ content?: unknown; tool_calls?: unknown }>, reserveTokens = 6144): number {
  let characters = 0;
  let images = 0;
  const countContent = (value: unknown) => {
    if (typeof value === "string") { characters += value.length; return; }
    if (!Array.isArray(value)) return;
    for (const part of value) {
      if (!part || typeof part !== "object") continue;
      const item = part as Record<string, unknown>;
      if (item.type === "image" || item.type === "image_url") { images++; continue; }
      if (typeof item.text === "string") characters += item.text.length;
      else if (typeof item.content === "string") characters += item.content.length;
    }
  };
  for (const message of messages) {
    countContent(message.content);
    if (Array.isArray(message.tool_calls)) for (const call of message.tool_calls) {
      const fn = call && typeof call === "object" ? (call as Record<string, unknown>).function : undefined;
      if (fn && typeof fn === "object") {
        const entry = fn as Record<string, unknown>;
        if (typeof entry.name === "string") characters += entry.name.length;
        if (typeof entry.arguments === "string") characters += entry.arguments.length;
      }
    }
  }
  return Math.max(1, Math.ceil(characters / 3.5) + images * 1024 + Math.max(0, Math.floor(reserveTokens)));
}

function effectiveContextLength(model: LMStudioModel, allowLoading: boolean): number | undefined {
  const loadedContexts = model.loaded_instances.map((instance) => instance.config.context_length).filter((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0);
  const loadedMaximum = loadedContexts.length ? Math.max(...loadedContexts) : undefined;
  const value = allowLoading ? Math.max(loadedMaximum ?? 0, model.max_context_length ?? 0) : loadedMaximum ?? (model.loaded_instances.length ? model.max_context_length : undefined);
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function chooseAgentModel(models: LMStudioModel[], requirements: { vision?: boolean; requiredContextTokens?: number; requireDeclaredContext?: boolean; allowLoading?: boolean; taskType?: ModelTaskType; performanceByModel?: Record<string, ModelPerformanceStats> } = {}): ModelChoice {
  const llms = models.filter((model) => model.type === "llm");
  const available = requirements.allowLoading === false ? llms.filter((model) => model.loaded_instances.length > 0) : llms;
  const candidates = requirements.vision ? available.filter((model) => model.capabilities?.vision === true) : available;
  if (requirements.vision && !candidates.length) throw new Error("This task includes an image, but no installed LLM declares vision support; load or select a vision-capable model first");
  if (!candidates.length) throw new Error(requirements.allowLoading === false ? "No LLM is loaded in LM Studio and automatic model loading is off" : "LM Studio has no downloaded LLM models");
  const contextEligible = typeof requirements.requiredContextTokens === "number"
    ? candidates.filter((model) => { const context = effectiveContextLength(model, requirements.allowLoading !== false); return context === undefined ? requirements.requireDeclaredContext !== true : context >= requirements.requiredContextTokens!; })
    : candidates;
  const contextSatisfied = contextEligible.length > 0;
  if (!contextSatisfied && requirements.requireDeclaredContext) throw new Error(`No installed model declares enough context for the estimated ${requirements.requiredContextTokens} token requirement`);
  const contextPool = contextSatisfied ? contextEligible : candidates;
  const toolCapable = contextPool.filter((model) => model.capabilities?.trained_for_tool_use === true);
  // Treat LM Studio's tool-use flag as a ranking hint, not a hard filter. The
  // metadata is absent for some models that can still call tools, and local
  // task outcomes are stronger evidence than a missing capability declaration.
  const suitable = contextPool;
  const memoryBudget = Math.max(1_500_000_000, Math.min(freemem() * 0.4, totalmem() * 0.25, 8_000_000_000));
  const fitting = suitable.filter((model) => model.size_bytes <= memoryBudget);
  const pool = (fitting.length ? fitting : suitable).slice();
  const performance = requirements.performanceByModel ?? {};
  const hasTaskSpecificEvidence = Boolean(requirements.taskType && pool.some((candidate) => (performance[candidate.key]?.taskOutcomesByType?.[requirements.taskType!]?.taskSamples ?? 0) > 0));
  const taskReliability = (key: string) => {
    const stats = performance[key];
    return hasTaskSpecificEvidence ? stats?.taskOutcomesByType?.[requirements.taskType!]?.taskSuccessRate ?? null : stats?.taskSamples ? stats.taskSuccessRate : null;
  };
  pool.sort((a, b) => {
    const aMeasured = performance[a.key]; const bMeasured = performance[b.key];
    const aTaskRate = taskReliability(a.key);
    const bTaskRate = taskReliability(b.key);
    // A model with observed task failures should not keep winning solely because
    // it is smaller when an eligible model has no local task evidence yet. Keep
    // unknown reliability distinct from measured reliability; don't invent a
    // publisher score for candidates without samples.
    if (aTaskRate !== null && bTaskRate === null) return aTaskRate > 0 ? -1 : 1;
    if (bTaskRate !== null && aTaskRate === null) return bTaskRate > 0 ? 1 : -1;
    if (aTaskRate !== null && bTaskRate !== null && aTaskRate !== bTaskRate) return bTaskRate - aTaskRate;
    if ((a.capabilities?.trained_for_tool_use === true) !== (b.capabilities?.trained_for_tool_use === true)) return Number(b.capabilities?.trained_for_tool_use === true) - Number(a.capabilities?.trained_for_tool_use === true);
    if (aMeasured && bMeasured && aMeasured.samples >= 3 && bMeasured.samples >= 3) {
      if (aMeasured.successRate !== bMeasured.successRate) return bMeasured.successRate - aMeasured.successRate;
      if (aMeasured.tokensPerSecond !== null && bMeasured.tokensPerSecond !== null && aMeasured.tokensPerSecond !== bMeasured.tokensPerSecond) return bMeasured.tokensPerSecond - aMeasured.tokensPerSecond;
      if (aMeasured.medianLatencyMs !== bMeasured.medianLatencyMs) return aMeasured.medianLatencyMs - bMeasured.medianLatencyMs;
    }
    if (Boolean(a.loaded_instances.length) !== Boolean(b.loaded_instances.length)) return Number(Boolean(b.loaded_instances.length)) - Number(Boolean(a.loaded_instances.length));
    if (a.size_bytes !== b.size_bytes) return a.size_bytes - b.size_bytes;
    if ((a.max_context_length ?? 0) !== (b.max_context_length ?? 0)) return (b.max_context_length ?? 0) - (a.max_context_length ?? 0);
    return a.key.localeCompare(b.key);
  });
  const model = pool[0]!;
  const needsLargerInstance = requirements.allowLoading !== false && typeof requirements.requiredContextTokens === "number"
    && model.loaded_instances.length > 0
    && model.loaded_instances.every((instance) => {
      const context = instance.config.context_length;
      return (typeof context === "number" ? context : model.max_context_length ?? 0) < requirements.requiredContextTokens!;
    });
  const reasons = [
    ...(requirements.vision ? ["declares vision support for the attached image"] : []),
    ...(model.capabilities?.trained_for_tool_use === true ? ["declares tool-use support"] : [toolCapable.length ? "selected model lacks a tool-use declaration; metadata is treated as a ranking hint" : "no installed model declares tool-use support"]),
    needsLargerInstance ? "installed; a larger-context instance must be loaded" : model.loaded_instances.length ? "already loaded" : "available in the local inventory",
    model.size_bytes <= memoryBudget ? `model file size ${model.size_bytes} bytes is within the approximate ${memoryBudget} byte memory budget` : `smallest suitable model exceeds the approximate ${memoryBudget} byte memory budget`,
    ...(typeof requirements.requiredContextTokens === "number" ? [contextSatisfied ? `estimated task context ${requirements.requiredContextTokens} tokens; ${effectiveContextLength(model, requirements.allowLoading !== false) === undefined ? "selected model context is undeclared" : `selected model supports ${effectiveContextLength(model, requirements.allowLoading !== false)} tokens`}` : `no candidate declares enough context for the estimated ${requirements.requiredContextTokens} token requirement; selected the best available model (${effectiveContextLength(model, requirements.allowLoading !== false) ?? "context unknown"} tokens)`] : [(model.max_context_length ?? 0) > 0 ? `declares up to ${model.max_context_length} context tokens` : "context length not declared"]),
    ...(hasTaskSpecificEvidence && requirements.taskType ? performance[model.key]?.taskOutcomesByType?.[requirements.taskType] ? [`observed locally over ${performance[model.key]!.taskOutcomesByType![requirements.taskType]!.taskSamples} ${requirements.taskType} tasks: ${performance[model.key]!.taskOutcomesByType![requirements.taskType]!.taskSuccesses}/${performance[model.key]!.taskOutcomesByType![requirements.taskType]!.taskSamples} verified completions`] : [`${requirements.taskType} task completion reliability is unmeasured`] : performance[model.key] && performance[model.key]!.taskSamples >= 1 && performance[model.key]!.taskSuccessRate !== null ? [`observed locally over ${performance[model.key]!.taskSamples} tasks: ${performance[model.key]!.taskSuccesses}/${performance[model.key]!.taskSamples} verified completions`] : [`local task completion reliability is unmeasured`]),
    ...(performance[model.key] && performance[model.key]!.samples >= 3 ? [`measured locally over ${performance[model.key]!.samples} inference calls: ${Math.round(performance[model.key]!.successRate * 100)}% response success, ${performance[model.key]!.medianLatencyMs} ms median latency${performance[model.key]!.tokensPerSecond === null ? "" : `, ${performance[model.key]!.tokensPerSecond} tokens/s`}`] : [])
  ];
  return { model, reason: reasons.join("; "), considered: candidates.length };
}

/** Select an installed embedder by declared model type, reusing a loaded instance before considering disk size. */
export function chooseEmbeddingModel(models: LMStudioModel[]): ModelChoice {
  const candidates = models.filter((model) => model.type === "embedding");
  if (!candidates.length) throw new Error("LM Studio has no downloaded embedding models");
  candidates.sort((a, b) => Number(b.loaded_instances.length > 0) - Number(a.loaded_instances.length > 0)
    || a.size_bytes - b.size_bytes
    || (b.max_context_length ?? 0) - (a.max_context_length ?? 0)
    || a.key.localeCompare(b.key));
  const model = candidates[0]!;
  const reason = [
    model.loaded_instances.length ? "already loaded" : "available in the local inventory",
    `${model.size_bytes} byte model file`,
    typeof model.max_context_length === "number" ? `declares ${model.max_context_length} context tokens` : "context length not declared"
  ].join("; ");
  return { model, reason, considered: candidates.length };
}
