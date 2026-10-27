export type ModelTaskType = "coding" | "review" | "research" | "planning" | "writing" | "general";

/** Classify a task from its objective so private, local outcomes can inform a matching role. */
export function classifyModelTaskObjective(objective: string): ModelTaskType {
  const text = objective.toLowerCase();
  const hasCodeReviewTarget = /\b(code|pull request|pr|commit|diff|repository|repo|change)\b.{0,50}\b(review|audit)\b|\b(review|audit)\b.{0,50}\b(code|pull request|pr|commit|diff|repository|repo|change)\b/i.test(text);
  const changesCode = /\b(implement|fix|patch|refactor|modify|edit|change|write|create)\b/i.test(text);
  if (hasCodeReviewTarget && !changesCode) return "review";
  if (/\b(code|coding|programming|software|implement|implementation|debug|bug|patch|refactor|compile|repository|repo|source code|source file|test suite|unit tests?)\b|\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|cs)\b/i.test(text)) return "coding";
  if (/\b(research|look up|latest|current|source|cite|citation|web search|compare sources|fact check)\b/i.test(text)) return "research";
  if (/\b(plan|planning|roadmap|decompose|architecture)\b/i.test(text)) return "planning";
  if (/\b(draft|write|report|document|spreadsheet|presentation|slides)\b/i.test(text)) return "writing";
  return "general";
}
