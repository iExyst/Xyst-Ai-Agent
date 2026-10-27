import type { XystStore } from "./storage.js";
import { classifyModelTaskObjective, type ModelTaskType } from "./model-task-type.js";

export interface ModelTaskOutcomeStats { taskSamples: number; taskSuccesses: number; taskSuccessRate: number }

export interface ModelPerformanceStats {
  samples: number;
  successes: number;
  successRate: number;
  medianLatencyMs: number;
  tokensPerSecond: number | null;
  taskSamples: number;
  taskSuccesses: number;
  taskSuccessRate: number | null;
  taskOutcomesByType?: Partial<Record<ModelTaskType, ModelTaskOutcomeStats>>;
}

/** Aggregate Xyst's local inference records; no content or remote telemetry is read. */
export function readModelPerformance(store: XystStore): Record<string, ModelPerformanceStats> {
  const rows = store.db.prepare("SELECT u.session_id,u.model,u.duration_ms,u.output_tokens,u.details_json,d.objective FROM usage u LEFT JOIN model_decisions d ON d.id=(SELECT first_decision.id FROM model_decisions AS first_decision WHERE first_decision.session_id=u.session_id ORDER BY first_decision.created_at ASC,first_decision.rowid ASC LIMIT 1) WHERE u.provider='lm-studio' AND u.model IS NOT NULL AND u.duration_ms IS NOT NULL").all() as Array<{ session_id: string | null; model: string; duration_ms: number; output_tokens: number | null; details_json: string; objective: string | null }>;
  const groups = new Map<string, Array<{ sessionId: string | null; duration: number; tokens: number; success: boolean; taskOutcome?: string; taskType?: ModelTaskType }>>();
  for (const row of rows) {
    if (!Number.isFinite(row.duration_ms) || row.duration_ms < 0) continue;
    let outcome: unknown;
    let taskOutcome: unknown;
    try { const details = JSON.parse(row.details_json) as Record<string, unknown>; outcome = details.outcome; taskOutcome = details.task_outcome; } catch { outcome = undefined; taskOutcome = undefined; }
    const values = groups.get(row.model) ?? [];
    values.push({ sessionId: row.session_id, duration: row.duration_ms, tokens: Number.isFinite(row.output_tokens) ? Math.max(0, row.output_tokens ?? 0) : 0, success: outcome !== "failure", ...(typeof taskOutcome === "string" ? { taskOutcome } : {}), ...(typeof row.objective === "string" ? { taskType: classifyModelTaskObjective(row.objective) } : {}) });
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
    const outcomesByType = new Map<ModelTaskType, Map<string, string>>();
    for (const value of values) {
      if (!value.sessionId || !value.taskOutcome || !value.taskType || !["verified_success", "unverified", "failed"].includes(value.taskOutcome) || value.taskOutcome === "not_final_model") continue;
      const bySession = outcomesByType.get(value.taskType) ?? new Map<string, string>();
      bySession.set(value.sessionId, value.taskOutcome); outcomesByType.set(value.taskType, bySession);
    }
    const taskOutcomesByType = Object.fromEntries([...outcomesByType].map(([type, sessions]) => {
      const outcomes = [...sessions.values()]; const successes = outcomes.filter((outcome) => outcome === "verified_success").length;
      return [type, { taskSamples: outcomes.length, taskSuccesses: successes, taskSuccessRate: successes / outcomes.length }];
    })) as Partial<Record<ModelTaskType, ModelTaskOutcomeStats>>;
    const elapsedWithTokens = values.filter((value) => value.success && value.tokens > 0 && value.duration > 0);
    const seconds = elapsedWithTokens.reduce((sum, value) => sum + value.duration / 1000, 0);
    const tokens = elapsedWithTokens.reduce((sum, value) => sum + value.tokens, 0);
    return [model, { samples: values.length, successes, successRate: successes / values.length, medianLatencyMs, tokensPerSecond: seconds > 0 ? Math.round(tokens / seconds * 10) / 10 : null, taskSamples: measuredTasks.length, taskSuccesses, taskSuccessRate: measuredTasks.length ? taskSuccesses / measuredTasks.length : null, ...(Object.keys(taskOutcomesByType).length ? { taskOutcomesByType } : {}) }] as const;
  }));
}
