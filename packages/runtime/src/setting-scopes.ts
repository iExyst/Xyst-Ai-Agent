import type { SettingScope } from "./storage.js";

const globalOnlySettings = new Set([
  "access.profile", "integrations.github.apiBaseUrl", "integrations.lmStudio.nativeChat.enabled", "integrations.lmStudio.nativeChat.integrations",
  "orchestration.scheduling.enabled", "updates.enabled", "updates.autoDownload", "updates.feedUrl"
]);
const projectMissionSettings = new Set([
  "notifications.enabled", "orchestration.maxConcurrency", "orchestration.memoryBudgetBytes", "orchestration.retries.enabled", "orchestration.delegation.enabled"
]);

export function supportedSettingScopes(key: string): SettingScope[] {
  if (globalOnlySettings.has(key)) return ["global"];
  if (projectMissionSettings.has(key)) return ["global", "project", "mission"];
  return ["global", "project", "mission", "agent", "session"];
}

export function validateSettingContext(key: string, scope: SettingScope): void {
  const supported = supportedSettingScopes(key);
  if (!supported.includes(scope)) throw new Error(`${key} does not support the ${scope} scope; supported scopes: ${supported.join(", ")}`);
}
