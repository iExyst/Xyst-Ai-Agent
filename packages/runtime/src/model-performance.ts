import type { XystStore } from "./storage.js";
import type { ModelTaskCategory } from "./model-selection.js";

export interface TaskCategoryPerformance {
  taskSamples: number;
  taskSuccesses: number;
  taskSuccessRate: number | null;
}

export interface ModelPerformanceStats {
  samples: number;
  successes: number;
  successRate: number;
  medianLatencyMs: number;
  tokensPerSecond: number | null;
  taskSamples: number;
  taskSuccesses: number;
  taskSuccessRate: number | null;
  taskCategories?: Partial<Record<ModelTaskCategory, TaskCategoryPerformance>>;
}

/** Aggregate Xyst's local inference records; no content or remote telemetry is read. */
export function readModelPerformance(store: XystStore): Record<string, ModelPerformanceStats> {
  const rows = store.db.prepare("SELECT session_id,model,duration_ms,output_tokens,details_json FROM usage WHERE provider='lm-studio' AND model IS NOT NULL AND duration_ms IS NOT NULL").all() as Array<{ session_id: string | null; model: string; duration_ms: number; output_tokens: number | null; details_json: string }>;
  const groups = new Map<string, Array<{ sessionId: string | null; duration: number; tokens: number; success: boolean; taskOutcome?: string; taskCategory?: ModelTaskCategory }>>();
  for (const row of rows) {
    if (!Number.isFinite(row.duration_ms) || row.duration_ms < 0) continue;
    let outcome: unknown;
    let taskOutcome: unknown;
    let taskCategory: unknown;
    try { const details = JSON.parse(row.details_json) as Record<string, unknown>; outcome = details.outcome; taskOutcome = details.task_outcome; taskCategory = details.task_category; } catch { outcome = undefined; taskOutcome = undefined; taskCategory = undefined; }
    const values = groups.get(row.model) ?? [];
    const validCategory = ["coding", "research", "document", "spreadsheet", "vision", "workflow", "general"].includes(String(taskCategory)) ? taskCategory as ModelTaskCategory : undefined;
    values.push({ sessionId: row.session_id, duration: row.duration_ms, tokens: Number.isFinite(row.output_tokens) ? Math.max(0, row.output_tokens ?? 0) : 0, success: outcome !== "failure", ...(typeof taskOutcome === "string" ? { taskOutcome } : {}), ...(validCategory ? { taskCategory: validCategory } : {}) });
    groups.set(row.model, values);
  }
  return Object.fromEntries([...groups].map(([model, values]) => {
    const durations = values.map((value) => value.duration).sort((left, right) => left - right);
    const middle = Math.floor(durations.length / 2);
    const medianLatencyMs = durations.length % 2 ? durations[middle]! : Math.round((durations[middle - 1]! + durations[middle]!) / 2);
    const successes = values.filter((value) => value.success).length;
    const taskOutcomes = new Map<string, string>();
    for (const value of values) if (value.sessionId && value.taskOutcome && value.taskOutcome !== "not_final_model" && value.taskOutcome !== "cancelled") taskOutcomes.set(value.sessionId, value.taskOutcome);
    const measuredTasks = [...taskOutcomes.values()].filter((value) => ["verified_success", "unverified", "failed"].includes(value));
    const taskSuccesses = measuredTasks.filter((value) => value === "verified_success").length;
    const outcomesByCategory = new Map<ModelTaskCategory, Map<string, string>>();
    for (const value of values) {
      if (!value.sessionId || !value.taskCategory || !value.taskOutcome || !["verified_success", "unverified", "failed"].includes(value.taskOutcome)) continue;
      const categoryOutcomes = outcomesByCategory.get(value.taskCategory) ?? new Map<string, string>();
      categoryOutcomes.set(value.sessionId, value.taskOutcome);
      outcomesByCategory.set(value.taskCategory, categoryOutcomes);
    }
    const taskCategories = Object.fromEntries([...outcomesByCategory].map(([category, outcomes]) => {
      const outcomesList = [...outcomes.values()];
      const successesForCategory = outcomesList.filter((value) => value === "verified_success").length;
      return [category, { taskSamples: outcomesList.length, taskSuccesses: successesForCategory, taskSuccessRate: outcomesList.length ? successesForCategory / outcomesList.length : null }];
    })) as Partial<Record<ModelTaskCategory, TaskCategoryPerformance>>;
    const elapsedWithTokens = values.filter((value) => value.success && value.tokens > 0 && value.duration > 0);
    const seconds = elapsedWithTokens.reduce((sum, value) => sum + value.duration / 1000, 0);
    const tokens = elapsedWithTokens.reduce((sum, value) => sum + value.tokens, 0);
    return [model, { samples: values.length, successes, successRate: successes / values.length, medianLatencyMs, tokensPerSecond: seconds > 0 ? Math.round(tokens / seconds * 10) / 10 : null, taskSamples: measuredTasks.length, taskSuccesses, taskSuccessRate: measuredTasks.length ? taskSuccesses / measuredTasks.length : null, ...(Object.keys(taskCategories).length ? { taskCategories } : {}) }] as const;
  }));
}
