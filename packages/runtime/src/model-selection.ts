import { freemem, totalmem } from "node:os";
import type { LMStudioModel } from "./providers/lm-studio.js";
import type { ModelPerformanceStats } from "./model-performance.js";

export interface ModelChoice { model: LMStudioModel; reason: string; considered: number }

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

function effectiveContextLength(model: LMStudioModel): number | undefined {
  const loadedContexts = model.loaded_instances.map((instance) => instance.config.context_length).filter((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0);
  const value = loadedContexts.length ? Math.max(...loadedContexts) : model.max_context_length;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function chooseAgentModel(models: LMStudioModel[], requirements: { vision?: boolean; requiredContextTokens?: number; requireDeclaredContext?: boolean; performanceByModel?: Record<string, ModelPerformanceStats> } = {}): ModelChoice {
  const llms = models.filter((model) => model.type === "llm");
  const candidates = requirements.vision ? llms.filter((model) => model.capabilities?.vision === true) : llms;
  if (requirements.vision && !candidates.length) throw new Error("This task includes an image, but no installed LLM declares vision support; load or select a vision-capable model first");
  if (!candidates.length) throw new Error("LM Studio has no downloaded LLM models");
  const contextEligible = typeof requirements.requiredContextTokens === "number"
    ? candidates.filter((model) => { const context = effectiveContextLength(model); return context === undefined ? requirements.requireDeclaredContext !== true : context >= requirements.requiredContextTokens!; })
    : candidates;
  const contextSatisfied = contextEligible.length > 0;
  if (!contextSatisfied && requirements.requireDeclaredContext) throw new Error(`No installed model declares enough context for the estimated ${requirements.requiredContextTokens} token requirement`);
  const contextPool = contextSatisfied ? contextEligible : candidates;
  const toolCapable = contextPool.filter((model) => model.capabilities?.trained_for_tool_use === true);
  const suitable = toolCapable.length ? toolCapable : contextPool;
  const memoryBudget = Math.max(1_500_000_000, Math.min(freemem() * 0.4, totalmem() * 0.25, 8_000_000_000));
  const fitting = suitable.filter((model) => model.size_bytes <= memoryBudget);
  const pool = (fitting.length ? fitting : suitable).slice();
  const performance = requirements.performanceByModel ?? {};
  pool.sort((a, b) => {
    const aMeasured = performance[a.key]; const bMeasured = performance[b.key];
    if (aMeasured && bMeasured && aMeasured.samples >= 3 && bMeasured.samples >= 3) {
      if ((aMeasured.taskSamples ?? 0) >= 3 && (bMeasured.taskSamples ?? 0) >= 3 && aMeasured.taskSuccessRate !== null && bMeasured.taskSuccessRate !== null && aMeasured.taskSuccessRate !== bMeasured.taskSuccessRate) return bMeasured.taskSuccessRate - aMeasured.taskSuccessRate;
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
  const reasons = [
    ...(requirements.vision ? ["declares vision support for the attached image"] : []),
    ...(toolCapable.length ? ["declares tool-use support"] : ["no installed model declares tool-use support"]),
    model.loaded_instances.length ? "already loaded" : "available in the local inventory",
    model.size_bytes <= memoryBudget ? `model file size ${model.size_bytes} bytes is within the approximate ${memoryBudget} byte memory budget` : `smallest suitable model exceeds the approximate ${memoryBudget} byte memory budget`,
    ...(typeof requirements.requiredContextTokens === "number" ? [contextSatisfied ? `estimated task context ${requirements.requiredContextTokens} tokens; ${effectiveContextLength(model) === undefined ? "selected model context is undeclared" : `selected model supports ${effectiveContextLength(model)} tokens`}` : `no candidate declares enough context for the estimated ${requirements.requiredContextTokens} token requirement; selected the best available model (${effectiveContextLength(model) ?? "context unknown"} tokens)`] : [(model.max_context_length ?? 0) > 0 ? `declares up to ${model.max_context_length} context tokens` : "context length not declared"]),
    ...(performance[model.key] && performance[model.key]!.taskSamples >= 3 && performance[model.key]!.taskSuccessRate !== null ? [`verified locally over ${performance[model.key]!.taskSamples} tasks: ${Math.round((performance[model.key]!.taskSuccessRate ?? 0) * 100)}% completed successfully`] : []),
    ...(performance[model.key] && performance[model.key]!.samples >= 3 ? [`measured locally over ${performance[model.key]!.samples} inference calls: ${Math.round(performance[model.key]!.successRate * 100)}% response success, ${performance[model.key]!.medianLatencyMs} ms median latency${performance[model.key]!.tokensPerSecond === null ? "" : `, ${performance[model.key]!.tokensPerSecond} tokens/s`}`] : [])
  ];
  return { model, reason: reasons.join("; "), considered: candidates.length };
}
