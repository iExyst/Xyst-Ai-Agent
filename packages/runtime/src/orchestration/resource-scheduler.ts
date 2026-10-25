import type { LMStudioModel } from "../providers/lm-studio.js";
import { chooseAgentModel } from "../model-selection.js";
import type { ModelPerformanceStats } from "../model-performance.js";

const MIB = 1024 ** 2;
const UNKNOWN_MODEL_LOAD = 1_500 * MIB;
const MIN_WORKER_MEMORY = 384 * MIB;

export interface ResourceTaskCandidate {
  id: string;
  requiredContextTokens?: number;
  /** A mission, agent, or task-level assignment. Never replaced automatically. */
  model?: string;
  /** True only when the assignment is automatic and may be reconsidered once. */
  automatic?: boolean;
  /** Models previously tried for this automatically assigned task. */
  previouslyAttemptedModels?: string[];
}

export interface ResourceTaskAssignment extends ResourceTaskCandidate {
  selectedModel?: string;
  selectionReason: string;
  estimatedAdditionalBytes: number;
  estimatedAdditionalGpuMemoryBytes?: number;
  admittedOverBudget: boolean;
}

export interface ResourceBatchPlan {
  assignments: ResourceTaskAssignment[];
  deferredTaskIds: string[];
  memoryBudgetBytes: number;
  estimatedAdditionalBytes: number;
  estimatedAdditionalGpuMemoryBytes?: number;
  availableGpuMemoryBytes?: number;
  requestedConcurrency: number;
}

/**
 * Admit ready work against RAM estimates and optional LM Studio GPU estimates.
 * Concurrent KV-cache costs remain heuristic; neither figure reserves hardware.
 */
export function planResourceAwareBatch(
  tasks: ResourceTaskCandidate[],
  models: LMStudioModel[],
  options: { memoryBudgetBytes: number; maxConcurrency: number; performanceByModel?: Record<string, ModelPerformanceStats>; availableGpuMemoryBytes?: number; estimatedGpuMemoryBytesByModel?: Record<string, number> }
): ResourceBatchPlan {
  const memoryBudgetBytes = Math.max(0, Math.floor(options.memoryBudgetBytes));
  const requestedConcurrency = Math.max(1, Math.min(8, Math.floor(options.maxConcurrency)));
  const llms = models.filter((model) => model.type === "llm");
  const assignments: ResourceTaskAssignment[] = [];
  const deferredTaskIds: string[] = [];
  const loadedInBatch = new Set<string>();
  let estimatedAdditionalBytes = 0;
  let estimatedAdditionalGpuMemoryBytes = 0;
  let oversizedFallback: ResourceTaskAssignment | undefined;

  for (const task of tasks) {
    if (assignments.length >= requestedConcurrency) { deferredTaskIds.push(task.id); continue; }
    let model: LMStudioModel | undefined;
    let selectionReason = task.model ? "explicit mission or agent model assignment" : "no automatic model assignment requested";
    if (task.model) model = llms.find((candidate) => candidate.key === task.model);
    else if (task.automatic) {
      const remainingBytes = Math.max(0, memoryBudgetBytes - estimatedAdditionalBytes);
      const modelCost = (candidate: LMStudioModel) => {
        const size = Number.isFinite(candidate.size_bytes) && candidate.size_bytes > 0 ? candidate.size_bytes : UNKNOWN_MODEL_LOAD;
        const load = candidate.loaded_instances.length > 0 || loadedInBatch.has(candidate.key) ? 0 : Math.ceil(size * 1.5);
        return load + Math.max(MIN_WORKER_MEMORY, Math.ceil(size * 0.12));
      };
      const availableGpuBytes = options.availableGpuMemoryBytes;
      const gpuCost = (candidate: LMStudioModel) => {
        const estimate = options.estimatedGpuMemoryBytesByModel?.[candidate.key];
        if (estimate === undefined || !Number.isFinite(estimate) || estimate < 0) return availableGpuBytes === undefined ? 0 : Number.MAX_SAFE_INTEGER;
        const alreadyResident = candidate.loaded_instances.length > 0 || loadedInBatch.has(candidate.key);
        return alreadyResident ? Math.max(MIN_WORKER_MEMORY, Math.ceil(estimate * 0.12)) : estimate;
      };
      const remainingGpuBytes = availableGpuBytes === undefined ? undefined : Math.max(0, availableGpuBytes - estimatedAdditionalGpuMemoryBytes);
      const fitsRam = llms.filter((candidate) => modelCost(candidate) <= remainingBytes);
      const fitting = fitsRam.filter((candidate) => remainingGpuBytes === undefined || gpuCost(candidate) <= remainingGpuBytes);
      let resourcePool = fitting.length ? fitting : [...(fitsRam.length ? fitsRam : llms)].sort((left, right) => {
        if (remainingGpuBytes !== undefined) {
          const gpuDifference = gpuCost(left) - gpuCost(right);
          if (gpuDifference) return gpuDifference;
        }
        return modelCost(left) - modelCost(right);
      }).slice(0, 1);
      let reliabilityExploration = false;
      const allGpuFittingModelsFailed = fitting.length > 0 && fitting.every((candidate) => {
        const measured = options.performanceByModel?.[candidate.key];
        return measured?.taskSamples && measured.taskSuccessRate === 0;
      });
      if (allGpuFittingModelsFailed && fitsRam.length > 0) {
        const bestRamCandidate = chooseAgentModel(fitsRam, {
          ...(task.requiredContextTokens === undefined ? {} : { requiredContextTokens: task.requiredContextTokens }),
          ...(options.performanceByModel ? { performanceByModel: options.performanceByModel } : {})
        }).model;
        const bestMetrics = options.performanceByModel?.[bestRamCandidate.key];
        const hasUnknownReliability = !bestMetrics?.taskSamples;
        const bestGpuEstimate = options.estimatedGpuMemoryBytesByModel?.[bestRamCandidate.key];
        const hasUnknownGpuFit = remainingGpuBytes !== undefined && (bestGpuEstimate === undefined || !Number.isFinite(bestGpuEstimate) || bestGpuEstimate < 0);
        if (hasUnknownReliability && hasUnknownGpuFit && !fitting.some((candidate) => candidate.key === bestRamCandidate.key)) {
          // GPU estimates are advisory and may be unavailable for a model.
          // When every measured-fit candidate has zero verified task outcomes,
          // let the best RAM-eligible unknown model make one bounded attempt.
          resourcePool = [bestRamCandidate];
          reliabilityExploration = true;
        }
      }
      const attempted = new Set(task.previouslyAttemptedModels ?? []);
      const untried = resourcePool.filter((candidate) => !attempted.has(candidate.key));
      const pool = untried.length ? untried : resourcePool;
      const choice = chooseAgentModel(pool, {
        ...(task.requiredContextTokens === undefined ? {} : { requiredContextTokens: task.requiredContextTokens }),
        ...(options.performanceByModel ? { performanceByModel: options.performanceByModel } : {})
      });
      model = choice.model;
      selectionReason = `${reliabilityExploration ? "all GPU-estimated candidates have zero verified task outcomes; trying the best RAM-eligible model with unknown GPU fit" : fitting.length ? "resource-fit automatic local selection" : remainingGpuBytes !== undefined && fitsRam.length ? "no sampled GPU estimate fits current free VRAM; selected the lowest-footprint eligible model" : "no model fits the remaining estimate; selected the smallest-footprint local model"}${untried.length && attempted.size ? "; avoiding previously failed automatic assignment" : attempted.size ? "; all eligible models were already tried, reusing the best available model" : ""}; ${choice.reason}`;
    }

    const modelKey = model?.key ?? task.model ?? "unresolved";
    const modelBytes = model && Number.isFinite(model.size_bytes) && model.size_bytes > 0 ? model.size_bytes : UNKNOWN_MODEL_LOAD;
    const loadingBytes = model && model.loaded_instances.length > 0 ? 0 : loadedInBatch.has(modelKey) ? 0 : Math.ceil(modelBytes * 1.5);
    const workerBytes = Math.max(MIN_WORKER_MEMORY, Math.ceil(modelBytes * 0.12));
    const incrementalBytes = loadingBytes + workerBytes;
    const gpuEstimate = model ? options.estimatedGpuMemoryBytesByModel?.[model.key] : undefined;
    const modelAlreadyResident = Boolean(model && (model.loaded_instances.length > 0 || loadedInBatch.has(modelKey)));
    const incrementalGpuBytes = gpuEstimate === undefined ? undefined : modelAlreadyResident ? Math.max(MIN_WORKER_MEMORY, Math.ceil(gpuEstimate * 0.12)) : gpuEstimate;
    if (options.availableGpuMemoryBytes !== undefined) {
      selectionReason += gpuEstimate === undefined
        ? "; no LM Studio GPU estimate for this model, so VRAM fit is unknown"
        : `; LM Studio estimates ${Math.round(gpuEstimate / 1024 ** 3 * 100) / 100} GiB total GPU memory (${Math.round((incrementalGpuBytes ?? 0) / 1024 ** 3 * 100) / 100} GiB additional estimate) with ${Math.round(options.availableGpuMemoryBytes / 1024 ** 3 * 100) / 100} GiB currently free`;
    }
    const assignment: ResourceTaskAssignment = {
      ...task,
      ...(model ? { selectedModel: model.key } : {}),
      selectionReason,
      estimatedAdditionalBytes: incrementalBytes,
      ...(incrementalGpuBytes === undefined ? {} : { estimatedAdditionalGpuMemoryBytes: incrementalGpuBytes }),
      admittedOverBudget: false
    };
    const overRam = estimatedAdditionalBytes + incrementalBytes > memoryBudgetBytes;
    const overGpu = options.availableGpuMemoryBytes !== undefined && (incrementalGpuBytes === undefined || estimatedAdditionalGpuMemoryBytes + incrementalGpuBytes > options.availableGpuMemoryBytes);
    if (overRam || overGpu) {
      deferredTaskIds.push(task.id);
      if (!oversizedFallback || assignment.estimatedAdditionalBytes + (assignment.estimatedAdditionalGpuMemoryBytes ?? 0) < oversizedFallback.estimatedAdditionalBytes + (oversizedFallback.estimatedAdditionalGpuMemoryBytes ?? 0)) oversizedFallback = assignment;
      continue;
    }
    assignments.push(assignment);
    estimatedAdditionalBytes += incrementalBytes;
    if (incrementalGpuBytes !== undefined) estimatedAdditionalGpuMemoryBytes += incrementalGpuBytes;
    loadedInBatch.add(modelKey);
  }

  // A manually pinned model can exceed the soft estimate by itself. Preserve
  // forward progress, but run only that one task and report the over-budget fit.
  if (assignments.length === 0 && oversizedFallback) {
    assignments.push({ ...oversizedFallback, admittedOverBudget: true, selectionReason: `${oversizedFallback.selectionReason}; admitted one task over the available resource estimate to preserve forward progress` });
    deferredTaskIds.splice(deferredTaskIds.indexOf(oversizedFallback.id), 1);
    estimatedAdditionalBytes = oversizedFallback.estimatedAdditionalBytes;
    estimatedAdditionalGpuMemoryBytes = oversizedFallback.estimatedAdditionalGpuMemoryBytes ?? 0;
  }

  return { assignments, deferredTaskIds, memoryBudgetBytes, estimatedAdditionalBytes, ...(options.availableGpuMemoryBytes === undefined ? {} : { availableGpuMemoryBytes: options.availableGpuMemoryBytes }), ...(estimatedAdditionalGpuMemoryBytes ? { estimatedAdditionalGpuMemoryBytes } : {}), requestedConcurrency };
}
