import type { XystStore } from "./storage.js";

export interface ModelPerformanceStats {
  samples: number;
  successes: number;
  successRate: number;
  medianLatencyMs: number;
  tokensPerSecond: number | null;
  taskSamples: number;
  taskSuccesses: number;
  taskSuccessRate: number | null;
}

/** Aggregate Xyst's local inference records; no content or remote telemetry is read. */
export function readModelPerformance(store: XystStore): Record<string, ModelPerformanceStats> {
  const rows = store.db.prepare("SELECT session_id,model,duration_ms,output_tokens,details_json FROM usage WHERE provider='lm-studio' AND model IS NOT NULL AND duration_ms IS NOT NULL").all() as Array<{ session_id: string | null; model: string; duration_ms: number; output_tokens: number | null; details_json: string }>;
  const groups = new Map<string, Array<{ sessionId: string | null; duration: number; tokens: number; success: boolean; taskOutcome?: string }>>();
  for (const row of rows) {
    if (!Number.isFinite(row.duration_ms) || row.duration_ms < 0) continue;
    let outcome: unknown;
    let taskOutcome: unknown;
    try { const details = JSON.parse(row.details_json) as Record<string, unknown>; outcome = details.outcome; taskOutcome = details.task_outcome; } catch { outcome = undefined; taskOutcome = undefined; }
    const values = groups.get(row.model) ?? [];
    values.push({ sessionId: row.session_id, duration: row.duration_ms, tokens: Number.isFinite(row.output_tokens) ? Math.max(0, row.output_tokens ?? 0) : 0, success: outcome !== "failure", ...(typeof taskOutcome === "string" ? { taskOutcome } : {}) });
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
    const elapsedWithTokens = values.filter((value) => value.success && value.tokens > 0 && value.duration > 0);
    const seconds = elapsedWithTokens.reduce((sum, value) => sum + value.duration / 1000, 0);
    const tokens = elapsedWithTokens.reduce((sum, value) => sum + value.tokens, 0);
    return [model, { samples: values.length, successes, successRate: successes / values.length, medianLatencyMs, tokensPerSecond: seconds > 0 ? Math.round(tokens / seconds * 10) / 10 : null, taskSamples: measuredTasks.length, taskSuccesses, taskSuccessRate: measuredTasks.length ? taskSuccesses / measuredTasks.length : null }] as const;
  }));
}
