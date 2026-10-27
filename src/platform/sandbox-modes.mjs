export const SANDBOX_MODES = Object.freeze(['none', 'workspace-write', 'workspace-read', 'read-only']);
export const SANDBOX_PROCESS_TOOLS = Object.freeze(['run_process', 'run_shell_script', 'start_background_process']);
export const READ_ONLY_TOOL_NAMES = Object.freeze(['read_file', 'list_dir', 'search_files', 'list_skills', 'load_skill']);

const MODE_ALIASES = Object.freeze({
  disabled: 'none',
  full: 'none',
  'workspace-only': 'workspace-write',
  required: 'workspace-write',
});

const MODE_RANK = Object.freeze({
  none: 0,
  'workspace-write': 1,
  'workspace-read': 2,
  'read-only': 3,
});

export function normalizeSandboxMode(mode) {
  if (typeof mode !== 'string') return null;
  const normalized = MODE_ALIASES[mode] || mode;
  return Object.hasOwn(MODE_RANK, normalized) ? normalized : null;
}

export function sandboxModeRank(mode) {
  const normalized = normalizeSandboxMode(mode);
  return normalized === null ? -1 : MODE_RANK[normalized];
}

export function resolveSandboxMode(config, toolName) {
  const globalMode = normalizeSandboxMode(config?.sandbox?.mode || 'none') || 'none';
  if (globalMode === 'read-only') return globalMode;
  const toolMode = toolName ? normalizeSandboxMode(config?.sandbox?.tools?.[toolName]) : null;
  if (toolMode === 'read-only') return toolMode;
  if (toolMode === null || sandboxModeRank(toolMode) < sandboxModeRank(globalMode)) return globalMode;
  return toolMode;
}

export function requiresProcessIsolation(mode) {
  const normalized = normalizeSandboxMode(mode);
  return normalized === 'workspace-write' || normalized === 'workspace-read';
}

export function isReadOnlySandbox(config, toolName) {
  return resolveSandboxMode(config, toolName) === 'read-only';
}

export function isReadOnlyTool(toolName) {
  return READ_ONLY_TOOL_NAMES.includes(toolName);
}
