import { validateControlApiRunRequest } from './run-request.mjs';
import { validateControlApiTerminalEvent } from './run-events.mjs';
import { validateRunBudgetChange } from '../core/budgets.mjs';

export class ControlApiError extends Error {
  constructor(message, { status = null, code = 'CONTROL_API_ERROR' } = {}) {
    super(message);
    this.name = 'ControlApiError';
    this.status = status;
    this.code = code;
  }
}

const UPDATE_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function validateSkillPackageId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value))
    throw new TypeError('packageId must be a lowercase hyphenated skill ID');
  return value;
}

function validateMcpPackageId(value) {
  if (typeof value !== 'string' || value.length > 96 || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value))
    throw new TypeError('packageId must be a lowercase signed MCP package ID');
  return value;
}

/** Minimal bearer client. Tokens are only sent to loopback HTTP endpoints and
 * redirects are rejected to prevent credential forwarding to another origin.
 */
export class ControlApiClient {
  constructor({ url, token, fetchImpl = globalThis.fetch?.bind(globalThis) } = {}) {
    if (typeof url !== 'string') throw new TypeError('Control API URL is required');
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'http:' ||
      parsed.hostname !== '127.0.0.1' ||
      parsed.pathname !== '/' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new TypeError('Control API URL must be an http://127.0.0.1 origin without credentials, path, query, or fragment');
    }
    if (typeof token !== 'string' || token.length < 32 || !/^[A-Za-z0-9_-]+$/.test(token))
      throw new TypeError('Control API token must be a base64url-style token of at least 32 characters');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    this.baseUrl = parsed.toString().replace(/\/$/, '');
    this.token = token;
    this.fetch = fetchImpl;
  }

  health(options) {
    return this.#request('/health', options);
  }
  getSettings(options) {
    return this.#request('/settings', options).then((result) => result.settings);
  }
  getSandboxCapability(options) {
    return this.#request('/sandbox-capability', options);
  }
  updateSettings(settings, options) {
    return this.#request('/settings', { ...options, method: 'PATCH', body: settings });
  }
  checkApplicationUpdates(options) {
    return this.#request('/app-updates/check', { ...options, method: 'POST', body: {} });
  }
  downloadApplicationUpdate(version, sequence, options) {
    if (typeof version !== 'string' || !UPDATE_VERSION_PATTERN.test(version)) throw new TypeError('version must be a release version');
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new TypeError('sequence must be a positive safe integer');
    return this.#request('/app-updates/download', { ...options, method: 'POST', body: { version, sequence } });
  }
  getExtensionUpdates(options) {
    return this.#request('/extensions/updates', options);
  }
  checkExtensionUpdates(options) {
    return this.#request('/extensions/updates/check', { ...options, method: 'POST', body: {} });
  }
  installExtensionUpdate(packageType, packageId, options) {
    if (packageType === 'skill') validateSkillPackageId(packageId);
    else if (packageType === 'mcp') validateMcpPackageId(packageId);
    else throw new TypeError('packageType must be skill or mcp');
    return this.#request('/extensions/updates/install', {
      ...options,
      method: 'POST',
      body: { package_type: packageType, package_id: packageId },
    });
  }
  refreshExtensionRevocations(options) {
    return this.#request('/extensions/revocations/refresh', { ...options, method: 'POST', body: {} });
  }
  storeCredential(key, value, options) {
    if (typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(key)) throw new TypeError('credential key is invalid');
    if (typeof value !== 'string' || !value) throw new TypeError('credential value must be a non-empty string');
    return this.#request(`/secrets/${encodeURIComponent(key)}`, { ...options, method: 'PUT', body: { value } });
  }
  deleteCredential(key, options) {
    if (typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(key)) throw new TypeError('credential key is invalid');
    return this.#request(`/secrets/${encodeURIComponent(key)}`, { ...options, method: 'DELETE' });
  }
  listSkills(options) {
    return this.#request('/skills', options);
  }
  listMcpServers(options) {
    return this.#request('/mcp/servers', options).then((result) => result.servers);
  }
  getMcpServerCatalog(options) {
    return this.#request('/mcp/servers', options);
  }
  listMcpAuditHistory({ limit = 100, ...options } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new TypeError('limit must be an integer from 1 to 200');
    return this.#request(`/mcp/audit?limit=${limit}`, options);
  }
  addMcpServer(name, config, options) {
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(name)) throw new TypeError('MCP server name is invalid');
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('config must be an object');
    return this.#request('/mcp/servers', { ...options, method: 'POST', body: { name, config } });
  }
  updateMcpServer(name, config, options) {
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(name)) throw new TypeError('MCP server name is invalid');
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('config must be an object');
    return this.#request(`/mcp/servers/${encodeURIComponent(name)}`, { ...options, method: 'PUT', body: config });
  }
  getMcpServerConfig(name, options) {
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(name)) throw new TypeError('MCP server name is invalid');
    return this.#request(`/mcp/servers/${encodeURIComponent(name)}/config`, options).then((result) => result.config);
  }
  testMcpServer(name, options) {
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(name)) throw new TypeError('MCP server name is invalid');
    return this.#request(`/mcp/servers/${encodeURIComponent(name)}/test`, { ...options, method: 'POST', body: {} }).then(
      (result) => result.result,
    );
  }
  setMcpServerEnabled(name, enabled, options) {
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(name)) throw new TypeError('MCP server name is invalid');
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
    return this.#request(`/mcp/servers/${encodeURIComponent(name)}`, { ...options, method: 'PUT', body: { enabled } });
  }
  removeMcpServer(name, options) {
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(name)) throw new TypeError('MCP server name is invalid');
    return this.#request(`/mcp/servers/${encodeURIComponent(name)}`, { ...options, method: 'DELETE', body: {} });
  }
  getSkill(name, options) {
    if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
      throw new TypeError('name must be a lowercase hyphenated skill ID');
    return this.#request(`/skills/${encodeURIComponent(name)}`, options).then((result) => result.skill);
  }
  listSignedSkillPackages(options) {
    return this.#request('/skills/packages', options);
  }
  activateSignedSkillPackage(packageId, version, options) {
    if (typeof version !== 'string' || !UPDATE_VERSION_PATTERN.test(version))
      throw new TypeError('version must be a semantic package version');
    return this.#request(`/skills/packages/${encodeURIComponent(validateSkillPackageId(packageId))}/activate`, {
      ...options,
      method: 'POST',
      body: { version },
    });
  }
  disableSignedSkillPackage(packageId, options) {
    return this.#request(`/skills/packages/${encodeURIComponent(validateSkillPackageId(packageId))}/disable`, {
      ...options,
      method: 'POST',
      body: {},
    });
  }
  rollbackSignedSkillPackage(packageId, options) {
    return this.#request(`/skills/packages/${encodeURIComponent(validateSkillPackageId(packageId))}/rollback`, {
      ...options,
      method: 'POST',
      body: {},
    });
  }
  listSignedMcpPackages(options) {
    return this.#request('/mcp/packages', options);
  }
  activateSignedMcpPackage(packageId, version, options) {
    if (typeof version !== 'string' || !UPDATE_VERSION_PATTERN.test(version))
      throw new TypeError('version must be a semantic package version');
    return this.#request(`/mcp/packages/${encodeURIComponent(validateMcpPackageId(packageId))}/activate`, {
      ...options,
      method: 'POST',
      body: { version },
    });
  }
  disableSignedMcpPackage(packageId, options) {
    return this.#request(`/mcp/packages/${encodeURIComponent(validateMcpPackageId(packageId))}/disable`, {
      ...options,
      method: 'POST',
      body: {},
    });
  }
  rollbackSignedMcpPackage(packageId, options) {
    return this.#request(`/mcp/packages/${encodeURIComponent(validateMcpPackageId(packageId))}/rollback`, {
      ...options,
      method: 'POST',
      body: {},
    });
  }
  getUsage(options) {
    return this.#request('/usage', options);
  }
  listModels(options) {
    return this.#request('/models', options).then((result) => result.profiles);
  }
  discoverLocalModels(options) {
    return this.#request('/local-models', options);
  }
  loadLocalModel(model, options) {
    if (typeof model !== 'string' || !model.trim() || model.length > 256 || /[\u0000-\u001f\u007f]/.test(model))
      throw new TypeError('model must be a valid local model ID');
    return this.#request('/local-models/load', { ...options, method: 'POST', body: { model } });
  }
  listApprovalRules(options) {
    return this.#request('/approval-rules', options).then((result) => result.rules);
  }
  createApprovalRule(rule, options) {
    return this.#request('/approval-rules', { ...options, method: 'POST', body: rule });
  }
  revokeApprovalRule(id, options) {
    return this.#request(`/approval-rules/${encodeURIComponent(id)}`, { ...options, method: 'DELETE' });
  }
  listSessions(options) {
    return this.#request('/sessions', options).then((result) => result.sessions);
  }
  getSession(id, options) {
    return this.#request(`/sessions/${encodeURIComponent(id)}`, options);
  }
  exportSession(id, options) {
    return this.#request(`/sessions/${encodeURIComponent(id)}/export`, options);
  }
  recapSession(id, options) {
    return this.#request(`/sessions/${encodeURIComponent(id)}/recap`, options).then((result) => result.recap);
  }
  importSession(document, options) {
    return this.#request('/sessions/import', { ...options, method: 'POST', body: document }).then((result) => result.session);
  }
  renameSession(id, title, options) {
    return this.#request(`/sessions/${encodeURIComponent(id)}`, { ...options, method: 'PATCH', body: { title } });
  }
  updateSessionPlan(id, plan, options) {
    return this.#request(`/sessions/${encodeURIComponent(id)}/plan`, { ...options, method: 'PUT', body: { plan } });
  }
  setSessionGoals(id, goalIds, options) {
    return this.#request(`/sessions/${encodeURIComponent(id)}/goals`, { ...options, method: 'PUT', body: { goal_ids: goalIds } });
  }
  archiveSession(id, options) {
    return this.#request(`/sessions/${encodeURIComponent(id)}/archive`, { ...options, method: 'POST' });
  }
  forkSession(id, options) {
    return this.#request(`/sessions/${encodeURIComponent(id)}/fork`, { ...options, method: 'POST' });
  }
  deleteSession(id, options) {
    return this.#request(`/sessions/${encodeURIComponent(id)}`, { ...options, method: 'DELETE' });
  }
  listSessionGrants(id, options) {
    return this.#request(`/sessions/${encodeURIComponent(id)}/grants`, options).then((result) => result.grants);
  }
  revokeSessionGrant(id, grantId, options) {
    return this.#request(`/sessions/${encodeURIComponent(id)}/grants/${encodeURIComponent(grantId)}`, { ...options, method: 'DELETE' });
  }
  getRun(id, options) {
    return this.#request(`/runs/${encodeURIComponent(id)}`, options);
  }
  getMemory(options) {
    return this.#request('/memory', options);
  }
  exportMemory(options) {
    return this.#request('/memory/export', options);
  }
  importMemory(document, options) {
    return this.#request('/memory/import', { ...options, method: 'POST', body: document });
  }

  searchWorkspace(query, { pathGlob, maxResults, signal } = {}) {
    if (typeof query !== 'string' || !query.trim() || query.length > 512) throw new TypeError('query must contain 1 to 512 characters');
    if (pathGlob !== undefined && (typeof pathGlob !== 'string' || !pathGlob.trim() || pathGlob.length > 256))
      throw new TypeError('pathGlob must contain 1 to 256 characters');
    if (maxResults !== undefined && (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 100))
      throw new TypeError('maxResults must be an integer from 1 to 100');
    const params = new URLSearchParams({ q: query });
    if (pathGlob !== undefined) params.set('path_glob', pathGlob);
    if (maxResults !== undefined) params.set('max_results', String(maxResults));
    return this.#request(`/retrieval/search?${params}`, { signal });
  }

  searchSemantic(query, { pathGlob, maxResults, approved = false, signal } = {}) {
    if (typeof query !== 'string' || !query.trim() || query.length > 2_000) throw new TypeError('query must contain 1 to 2000 characters');
    if (pathGlob !== undefined && (typeof pathGlob !== 'string' || !pathGlob.trim() || pathGlob.length > 256))
      throw new TypeError('pathGlob must contain 1 to 256 characters');
    if (maxResults !== undefined && (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 50))
      throw new TypeError('maxResults must be an integer from 1 to 50');
    if (approved !== true) throw new TypeError('Semantic search requires explicit approval');
    return this.#request('/retrieval/semantic', {
      method: 'POST',
      body: { query, path_glob: pathGlob, max_results: maxResults, approved },
      signal,
    });
  }

  getSemanticIndex(options) {
    return this.#request('/retrieval/index', options);
  }

  manageSemanticIndex(action, { approved = false, signal } = {}) {
    if (!['reindex', 'clear'].includes(action)) throw new TypeError('Index action must be reindex or clear');
    if (action === 'reindex' && approved !== true) throw new TypeError('Reindex requires explicit approval');
    return this.#request('/retrieval/index', { method: 'POST', body: action === 'reindex' ? { action, approved } : { action }, signal });
  }

  getRetrievalExclusions(options) {
    return this.#request('/retrieval/exclusions', options);
  }

  changeRetrievalExclusion(action, pattern, options) {
    if (!['add', 'remove'].includes(action)) throw new TypeError('Exclusion action must be add or remove');
    if (typeof pattern !== 'string' || !pattern.trim() || pattern.length > 256)
      throw new TypeError('Exclusion pattern must contain 1 to 256 characters');
    return this.#request('/retrieval/exclusions', { ...options, method: 'POST', body: { action, pattern } });
  }

  listMemory(section, { offset = 0, limit = 50, signal } = {}) {
    const query = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    return this.#request(`/memory/${encodeURIComponent(section)}?${query}`, { signal });
  }

  getGlobalMemory(options) {
    return this.#request('/memory/global', options);
  }

  exportGlobalMemory(options) {
    return this.#request('/memory/global/export', options);
  }

  importGlobalMemory(document, options) {
    return this.#request('/memory/global/import', { ...options, method: 'POST', body: document });
  }

  listGlobalMemory(section, { offset = 0, limit = 50, signal } = {}) {
    const query = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    return this.#request(`/memory/global/${encodeURIComponent(section)}?${query}`, { signal });
  }

  searchGlobalMemory(query, { section, offset = 0, limit = 50, signal } = {}) {
    if (typeof query !== 'string' || !query.trim() || query.length > 512) throw new TypeError('query must contain 1 to 512 characters');
    const params = new URLSearchParams({ q: query, offset: String(offset), limit: String(limit) });
    if (section) params.set('section', section);
    return this.#request(`/memory/global/search?${params}`, { signal });
  }

  addGlobalMemory(section, text, options) {
    return this.#request('/memory/global', { ...options, method: 'POST', body: { section, text } });
  }

  updateGlobalMemory(section, id, text, options) {
    return this.#request(`/memory/global/${encodeURIComponent(section)}/${encodeURIComponent(id)}`, {
      ...options,
      method: 'PATCH',
      body: { text },
    });
  }

  deleteGlobalMemory(section, id, options) {
    return this.#request(`/memory/global/${encodeURIComponent(section)}/${encodeURIComponent(id)}`, { ...options, method: 'DELETE' });
  }

  searchMemory(query, { section, offset = 0, limit = 50, signal } = {}) {
    if (typeof query !== 'string' || !query.trim() || query.length > 512) throw new TypeError('query must contain 1 to 512 characters');
    if (section !== undefined && !/^(conventions|architecture_decisions|user_preferences|lessons_learned|open_questions)$/.test(section))
      throw new TypeError('section must be a known memory section');
    if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000 || !Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new TypeError('offset must be between 0 and 1000000 and limit between 1 and 200');
    const params = new URLSearchParams({ q: query, offset: String(offset), limit: String(limit) });
    if (section) params.set('section', section);
    return this.#request(`/memory/search?${params}`, { signal });
  }

  addMemory(section, text, options) {
    return this.#request('/memory', { ...options, method: 'POST', body: { section, text } });
  }

  updateMemory(section, id, text, options) {
    return this.#request(`/memory/${encodeURIComponent(section)}/${encodeURIComponent(id)}`, {
      ...options,
      method: 'PATCH',
      body: { text },
    });
  }

  deleteMemory(section, id, options) {
    return this.#request(`/memory/${encodeURIComponent(section)}/${encodeURIComponent(id)}`, { ...options, method: 'DELETE' });
  }

  listGoals({ includeCompleted = true, signal } = {}) {
    return this.#request(`/goals?include_completed=${includeCompleted}`, { signal }).then((result) => result.goals);
  }

  addGoal(title, details = '', options) {
    return this.#request('/goals', { ...options, method: 'POST', body: { title, details } });
  }

  setGoalStatus(id, status, options) {
    return this.#request(`/goals/${encodeURIComponent(id)}`, { ...options, method: 'PATCH', body: { status } });
  }

  addGoalProgress(id, text, reference = '', options) {
    return this.#request(`/goals/${encodeURIComponent(id)}/progress`, { ...options, method: 'POST', body: { text, reference } });
  }

  updateGoalProgress(id, progressId, text, reference, options) {
    return this.#request(`/goals/${encodeURIComponent(id)}/progress/${encodeURIComponent(progressId)}`, {
      ...options,
      method: 'PATCH',
      body: { text, reference },
    });
  }

  deleteGoalProgress(id, progressId, options) {
    return this.#request(`/goals/${encodeURIComponent(id)}/progress/${encodeURIComponent(progressId)}`, { ...options, method: 'DELETE' });
  }

  deleteGoal(id, options) {
    return this.#request(`/goals/${encodeURIComponent(id)}`, { ...options, method: 'DELETE' });
  }

  listWorktrees(options) {
    return this.#request('/worktrees', options).then((result) => result.worktrees);
  }

  inspectWorkspace({ path = '', worktreeId, signal } = {}) {
    if (
      typeof path !== 'string' ||
      path.length > 2048 ||
      path.startsWith('/') ||
      /^[A-Za-z]:/.test(path) ||
      path.startsWith('\\\\') ||
      path.split(/[\\/]/).some((part) => part === '..')
    )
      throw new TypeError('path must be a relative workspace path without traversal');
    if (worktreeId !== undefined && (typeof worktreeId !== 'string' || !/^[0-9a-f-]{36}$/i.test(worktreeId)))
      throw new TypeError('worktreeId must be a UUID');
    const query = new URLSearchParams();
    if (path) query.set('path', path);
    if (worktreeId) query.set('worktree_id', worktreeId);
    return this.#request(`/workspace${query.size ? `?${query}` : ''}`, { signal });
  }

  readWorkspaceFile({ path, worktreeId, signal } = {}) {
    if (
      typeof path !== 'string' ||
      !path ||
      path.length > 2048 ||
      path.startsWith('/') ||
      /^[A-Za-z]:/.test(path) ||
      path.startsWith('\\\\') ||
      path.split(/[\\/]/).some((part) => part === '..')
    )
      throw new TypeError('path must be a relative workspace file without traversal');
    if (worktreeId !== undefined && (typeof worktreeId !== 'string' || !/^[0-9a-f-]{36}$/i.test(worktreeId)))
      throw new TypeError('worktreeId must be a UUID');
    const query = new URLSearchParams({ path });
    if (worktreeId) query.set('worktree_id', worktreeId);
    return this.#request(`/workspace/file?${query}`, { signal });
  }

  listSubagentTasks({ limit = 100, signal } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new TypeError('limit must be an integer from 1 to 500');
    return this.#request(`/subagents?limit=${limit}`, { signal }).then((result) => result.tasks);
  }

  getSubagentTask(id, options) {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
      throw new TypeError('id must be a UUID');
    return this.#request(`/subagents/${encodeURIComponent(id)}`, options).then((result) => result.task);
  }

  cancelSubagentTask(id, options) {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
      throw new TypeError('id must be a UUID');
    return this.#request(`/subagents/${encodeURIComponent(id)}/cancel`, { ...options, method: 'POST', body: {} });
  }

  createWorktree(branch, options) {
    if (typeof branch !== 'string' || !branch) throw new TypeError('branch must be a non-empty string');
    return this.#request('/worktrees', { ...options, method: 'POST', body: { branch } }).then((result) => result.worktree);
  }

  removeWorktree(id, options) {
    return this.#request(`/worktrees/${encodeURIComponent(id)}`, { ...options, method: 'DELETE' });
  }

  listProcesses({ sessionId, limit = 100, ...options } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('limit must be an integer from 1 to 100');
    if (
      sessionId !== undefined &&
      (typeof sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId))
    )
      throw new TypeError('sessionId must be a UUID');
    const query = new URLSearchParams({ limit: String(limit) });
    if (sessionId) query.set('session_id', sessionId);
    return this.#request(`/processes?${query}`, options).then((result) => result.processes);
  }

  getProcess(id, options) {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
      throw new TypeError('id must be a UUID');
    return this.#request(`/processes/${encodeURIComponent(id)}`, options).then((result) => result.process);
  }

  stopProcess(id, options) {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
      throw new TypeError('id must be a UUID');
    return this.#request(`/processes/${encodeURIComponent(id)}/stop`, { ...options, method: 'POST', body: {} }).then(
      (result) => result.process,
    );
  }

  writeProcessInput(id, input, options) {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
      throw new TypeError('id must be a UUID');
    if (typeof input !== 'string' || new TextEncoder().encode(input).byteLength > 65_536)
      throw new TypeError('input must be a string of at most 65536 bytes');
    return this.#request(`/processes/${encodeURIComponent(id)}/input`, { ...options, method: 'POST', body: { input } }).then(
      (result) => result.result,
    );
  }

  removeProcess(id, options) {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
      throw new TypeError('id must be a UUID');
    return this.#request(`/processes/${encodeURIComponent(id)}`, { ...options, method: 'DELETE' });
  }

  startRun(request, options) {
    const validationError = validateControlApiRunRequest(request);
    if (validationError) throw new TypeError(validationError);
    return this.#request('/runs', { ...options, method: 'POST', body: request });
  }

  cancelRun(id, options) {
    return this.#request(`/runs/${encodeURIComponent(id)}/cancel`, { ...options, method: 'POST' });
  }

  pauseRun(id, options) {
    return this.#request(`/runs/${encodeURIComponent(id)}/pause`, { ...options, method: 'POST', body: {} });
  }

  resumeRun(id, options) {
    return this.#request(`/runs/${encodeURIComponent(id)}/resume`, { ...options, method: 'POST', body: {} });
  }

  addRunDirection(id, content, options) {
    if (typeof content !== 'string' || !content.trim() || new TextEncoder().encode(content).byteLength > 10_000)
      throw new TypeError('content must contain 1 to 10000 bytes of text');
    return this.#request(`/runs/${encodeURIComponent(id)}/directions`, { ...options, method: 'POST', body: { content } });
  }

  changeRunModel(id, model, options) {
    if (typeof model !== 'string' || !model.trim() || model.length > 128)
      throw new TypeError('model must be a configured profile name of at most 128 characters');
    return this.#request(`/runs/${encodeURIComponent(id)}/model`, { ...options, method: 'POST', body: { model } });
  }

  changeRunBudgets(id, budgets, options) {
    validateRunBudgetChange(budgets);
    return this.#request(`/runs/${encodeURIComponent(id)}/budgets`, { ...options, method: 'PATCH', body: { budgets } });
  }

  answerApproval(runId, approvalId, approved, { grantScope = 'once', grantDurationMs, acceptedHunks, ...options } = {}) {
    if (typeof approved !== 'boolean') throw new TypeError('approved must be boolean');
    if (!['once', 'session_exact_action', 'exact_path_1h', 'exact_command_1h'].includes(grantScope))
      throw new TypeError('grantScope is not supported');
    if (grantDurationMs !== undefined && grantScope !== 'session_exact_action')
      throw new TypeError('grantDurationMs requires session_exact_action scope');
    if (
      acceptedHunks !== undefined &&
      (!approved ||
        !Array.isArray(acceptedHunks) ||
        acceptedHunks.length < 1 ||
        acceptedHunks.length > 100 ||
        acceptedHunks.some((id) => typeof id !== 'string' || !/^hunk-[1-9][0-9]{0,2}$/.test(id)) ||
        new Set(acceptedHunks).size !== acceptedHunks.length)
    )
      throw new TypeError('acceptedHunks must contain 1 to 100 unique valid hunk IDs for an approved action');
    if (
      approved &&
      grantScope === 'session_exact_action' &&
      (!Number.isInteger(grantDurationMs) || grantDurationMs < 60_000 || grantDurationMs > 86_400_000)
    ) {
      throw new TypeError('grantDurationMs must be between 60000 and 86400000');
    }
    const body = { approved };
    if (approved && grantScope !== 'once') body.grant_scope = grantScope;
    if (approved && grantScope === 'session_exact_action') body.grant_duration_ms = grantDurationMs;
    if (acceptedHunks !== undefined) body.accepted_hunks = acceptedHunks;
    return this.#request(`/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`, {
      ...options,
      method: 'POST',
      body,
    });
  }

  async *events(runId, { after = 0, signal } = {}) {
    if (!Number.isSafeInteger(after) || after < 0) throw new TypeError('after must be a non-negative safe integer');
    const response = await this.#fetch(`/runs/${encodeURIComponent(runId)}/events${after ? `?after=${after}` : ''}`, {
      method: 'GET',
      signal,
      headers: { accept: 'text/event-stream' },
    });
    if (!response.ok) throw await responseError(response);
    if (!response.body)
      throw new ControlApiError('Control API returned an empty event stream', { status: response.status, code: 'INVALID_STREAM' });
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream'))
      throw new ControlApiError('Control API returned an unexpected event stream content type', {
        status: response.status,
        code: 'INVALID_STREAM',
      });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let dataLines = [];
    let eventType = 'message';
    let eventId = null;
    let streamComplete = false;
    const dispatch = () => {
      if (!dataLines.length) {
        eventType = 'message';
        eventId = null;
        return null;
      }
      const data = dataLines.join('\n');
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        throw new ControlApiError('Control API sent malformed event JSON', { code: 'INVALID_STREAM' });
      }
      const terminalEventError = validateControlApiTerminalEvent(eventType, payload);
      if (terminalEventError)
        throw new ControlApiError(`Control API sent an invalid terminal event: ${terminalEventError}`, { code: 'INVALID_STREAM' });
      const result = { id: eventId, type: eventType, data: payload };
      dataLines = [];
      eventType = 'message';
      eventId = null;
      return result;
    };
    const parseLine = (line) => {
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') return { dispatched: true, event: dispatch() };
      if (line.startsWith(':')) return { dispatched: false };
      const separator = line.indexOf(':');
      const field = separator < 0 ? line : line.slice(0, separator);
      const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
      if (field === 'data') dataLines.push(value);
      else if (field === 'event') eventType = value;
      else if (field === 'id' && !value.includes('\0')) eventId = value;
      return { dispatched: false };
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          streamComplete = true;
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const parsed = parseLine(line);
          if (parsed.event) yield parsed.event;
        }
      }
      buffer += decoder.decode();
      if (buffer) {
        const parsed = parseLine(buffer);
        if (parsed.event) yield parsed.event;
      }
      const final = dispatch();
      if (final) yield final;
    } finally {
      if (!streamComplete) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async *followRunEvents(runId, { after = 0, signal, retryDelayMs = 500, maxRetryDelayMs = 10_000 } = {}) {
    if (!Number.isSafeInteger(after) || after < 0) throw new TypeError('after must be a non-negative safe integer');
    if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 60_000)
      throw new TypeError('retryDelayMs must be an integer from 0 to 60000');
    if (!Number.isInteger(maxRetryDelayMs) || maxRetryDelayMs < retryDelayMs || maxRetryDelayMs > 60_000)
      throw new TypeError('maxRetryDelayMs must be between retryDelayMs and 60000');
    let cursor = after;
    let consecutiveDisconnects = 0;
    while (!signal?.aborted) {
      let receivedEvent = false;
      try {
        for await (const event of this.events(runId, { after: cursor, signal })) {
          const sequence = event.id !== null && /^\d+$/.test(event.id) ? Number(event.id) : null;
          if (sequence !== null && Number.isSafeInteger(sequence)) {
            if (sequence <= cursor) continue;
            cursor = sequence;
          }
          receivedEvent = true;
          consecutiveDisconnects = 0;
          yield event;
        }
      } catch (error) {
        if (signal?.aborted || error.name === 'AbortError') throw error;
        if (error instanceof ControlApiError && error.status === null) throw error;
        if (error instanceof ControlApiError && error.status < 500) throw error;
        consecutiveDisconnects += 1;
      }

      let run;
      try {
        run = await this.getRun(runId, { signal });
      } catch (error) {
        if (signal?.aborted || error.name === 'AbortError') throw error;
        if (error instanceof ControlApiError && error.status < 500) throw error;
        consecutiveDisconnects += 1;
        const delay = Math.min(maxRetryDelayMs, retryDelayMs * 2 ** Math.min(consecutiveDisconnects - 1, 16));
        await waitForRetry(delay, signal);
        continue;
      }
      if (!['running', 'paused'].includes(run.status)) return;
      consecutiveDisconnects = Math.max(1, consecutiveDisconnects + (receivedEvent ? 0 : 1));
      const delay = Math.min(maxRetryDelayMs, retryDelayMs * 2 ** Math.min(consecutiveDisconnects - 1, 16));
      await waitForRetry(delay, signal);
    }
    if (signal?.aborted) throw signal.reason || new DOMException('The operation was aborted', 'AbortError');
  }

  async #request(endpoint, { method = 'GET', body, signal } = {}) {
    const response = await this.#fetch(endpoint, {
      method,
      signal,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw await responseError(response);
    if (response.status === 204) return null;
    try {
      return await response.json();
    } catch {
      throw new ControlApiError('Control API returned invalid JSON', { status: response.status, code: 'INVALID_RESPONSE' });
    }
  }

  async #fetch(endpoint, options) {
    return this.fetch(`${this.baseUrl}/v1${endpoint}`, {
      ...options,
      redirect: 'error',
      headers: { ...options.headers, authorization: `Bearer ${this.token}` },
    });
  }
}

async function responseError(response) {
  let message = `Control API request failed with HTTP ${response.status}`;
  let code = 'CONTROL_API_ERROR';
  try {
    const body = await response.json();
    if (typeof body.error === 'string') message = body.error;
    if (typeof body.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(body.code)) code = body.code;
  } catch {
    /* retain generic status error */
  }
  return new ControlApiError(message, { status: response.status, code });
}

function waitForRetry(delayMs, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new DOMException('The operation was aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, delayMs);
    function done() {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal.reason || new DOMException('The operation was aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}
