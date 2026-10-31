import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { AgentRuntime } from '../core/agent.mjs';
import { buildRoutingPrompt, requiresToolsForTask } from '../core/router.mjs';
import { MAX_SESSION_EXPORT_BYTES, MAX_SESSION_PLAN_CHARS, SessionStore, sessionFailureFromError } from '../session/store.mjs';
import { MAX_MEMORY_EXPORT_BYTES, MemoryStore, MEMORY_SECTIONS } from '../memory/store.mjs';
import { GlobalMemoryStore } from '../memory/store.mjs';
import { defaultUserDataDirectory } from '../memory/paths.mjs';
import { GoalStore } from '../goals/store.mjs';
import { MAX_SESSION_GRANT_MS, MAX_SESSION_GRANTS, MIN_SESSION_GRANT_MS } from '../tools/grants.mjs';
import { ApprovalRuleStore, MAX_APPROVAL_RULE_MS, MIN_APPROVAL_RULE_MS } from '../tools/approval-rule-store.mjs';
import { loadConfig, resolveModelApiKey, validateConfig } from '../config/load.mjs';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.mjs';
import { discoverLocalServers, loadLmStudioModel } from '../providers/discovery.mjs';
import { canonicalWorkspacePath, formatArgv } from '../tools/approval-rules.mjs';
import { acquireWorktreeLease, createWorktree, listWorktrees, removeWorktree } from '../platform/worktrees.mjs';
import { searchWorkspace } from '../retrieval/search.mjs';
import { createSemanticIndex } from '../retrieval/create-semantic-index.mjs';
import { BackgroundProcessManager } from '../platform/background-processes.mjs';
import { ToolAuditStore } from '../tools/audit.mjs';
import { prepareImageInputs } from '../providers/images.mjs';
import { validateControlApiRunRequest } from './run-request.mjs';
import { validateControlApiTerminalEvent } from './run-events.mjs';
import { recapSession } from '../session/compaction.mjs';
import { SubagentTaskStore } from '../subagents/task-store.mjs';
import { UsageBudgetStore } from '../session/usage-budget.mjs';
import { StdioMcpManager } from '../tools/mcp-stdio.mjs';
import { SkillLibrary } from '../tools/skills.mjs';
import { containsSensitiveMaterial } from '../platform/redaction.mjs';
import { updateRuntimeOverrides, validateRuntimeOverrides } from '../config/runtime-overrides.mjs';
import { resolveRunBudgetChange, RUN_BUDGET_FIELDS } from '../core/budgets.mjs';
import { inspectWorkspace, readWorkspaceFile } from '../platform/workspace-inspector.mjs';
import { createPlatformSecretStore } from '../platform/secrets.mjs';
import { findBubblewrap, findWindowsSandboxHelper } from '../platform/sandbox.mjs';
import { requiresProcessIsolation, resolveSandboxMode, SANDBOX_PROCESS_TOOLS } from '../platform/sandbox-modes.mjs';
import { ObservabilityEventStore } from '../observability/event-store.mjs';
import { ArchitectReviewService } from '../architect/review-service.mjs';
import {
  activateInstalledMcpPackage,
  activateInstalledSkill,
  disableInstalledMcpPackage,
  disableInstalledSkill,
  installedPackageTrustFromConfig,
  listInstalledPackageActivations,
  listInstalledMcpVersions,
  listInstalledSkillVersions,
  rollbackInstalledMcpPackage,
  rollbackInstalledSkill,
} from '../extensions/package-registry.mjs';
import {
  availablePackageUpdates,
  downloadAndInstallPackageUpdate,
  getCachedPackageUpdateFeed,
  getPackageUpdateCohortId,
  refreshPackageUpdateFeed,
} from '../extensions/update-feed.mjs';
import { getCachedRevocations, refreshRevocationFeed } from '../extensions/revocation-feed.mjs';
import { applicationUpdateKeyFingerprint, checkApplicationUpdates, downloadApplicationUpdate } from '../platform/application-updates.mjs';

const API_PREFIX = '/v1';
const GUI_ROOT = fileURLToPath(new URL('../../gui/', import.meta.url));
const MAX_BODY_BYTES = 1_000_000;
const MAX_RUN_BODY_BYTES = 24 * 1024 * 1024;
const MAX_EVENTS_PER_RUN = 500;
const MAX_RETAINED_RUNS = 100;
const MAX_APPROVAL_MS = 300_000;
const MAX_RUN_DIRECTION_BYTES = 10_000;
const MAX_PENDING_RUN_DIRECTIONS = 10;

export function createControlToken() {
  return randomBytes(32).toString('base64url');
}

/** Local authenticated control plane shared by desktop and IDE clients.
 * The server binds only to IPv4 loopback, requires a per-process bearer token,
 * rejects unapproved browser origins and DNS-rebinding Host headers, and
 * delegates all agent policy and approvals to AgentRuntime.
 */
export class LocalControlServer {
  constructor({
    config,
    workspaceRoot,
    token = createControlToken(),
    fetchImpl = fetch,
    secretStore,
    onEvent = () => {},
    appUpdateDownloadTtlMs = 15 * 60_000,
    userDataDirectory = null,
  } = {}) {
    if (!config || typeof config !== 'object') throw new TypeError('config is required');
    validateConfig(config);
    if (typeof workspaceRoot !== 'string' || !workspaceRoot) throw new TypeError('workspaceRoot is required');
    if (!Number.isInteger(appUpdateDownloadTtlMs) || appUpdateDownloadTtlMs < 1 || appUpdateDownloadTtlMs > 15 * 60_000)
      throw new TypeError('appUpdateDownloadTtlMs must be an integer from 1 to 900000');
    if (typeof token !== 'string' || token.length < 32 || !/^[A-Za-z0-9_-]+$/.test(token))
      throw new TypeError('Control token must be a base64url-style token of at least 32 characters');
    this.config = config;
    this.workspaceRoot = workspaceRoot;
    this.userDataDirectory = userDataDirectory || config.app_data?.directory || defaultUserDataDirectory();
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.secretStore = secretStore || createPlatformSecretStore();
    this.onEvent = onEvent;
    this.sessionStore = new SessionStore(workspaceRoot);
    this.observabilityStore = new ObservabilityEventStore(workspaceRoot, {
      enabled: config.observability?.enabled === true,
      consoleEnabled: config.observability?.console_enabled === true,
      maxFileBytes: config.observability?.max_file_bytes,
      otlp: config.observability?.otlp,
      secretStore: this.secretStore,
      fetchImpl: this.fetchImpl,
    });
    this.architectService = new ArchitectReviewService({ config, workspaceRoot });
    this.approvalRuleStore = new ApprovalRuleStore(workspaceRoot);
    this.memoryStore = new MemoryStore(workspaceRoot);
    this.globalMemoryStore = config.memory?.global_enabled === true ? new GlobalMemoryStore(this.userDataDirectory) : null;
    this.goalStore = new GoalStore(workspaceRoot);
    this.processManager = new BackgroundProcessManager(workspaceRoot, config);
    this.processAuditStore = new ToolAuditStore(workspaceRoot);
    const installedPackages = installedPackageTrustFromConfig(config);
    this.installedPackages = installedPackages;
    this.localPackageRevocations = {
      revokedKeyIds: [...(installedPackages?.revokedKeyIds || [])],
      revokedPackages: [...(installedPackages?.revokedPackages || [])],
    };
    this.mcpManager = new StdioMcpManager({
      config,
      workspaceRoot,
      secretStore,
      auditStore: this.processAuditStore,
      installedPackages,
    });
    this.skillLibrary = new SkillLibrary({ workspaceRoot, directories: config.skills?.directories || [], installedPackages });
    this.subagentTaskStore = new SubagentTaskStore(workspaceRoot, { maxConcurrent: config.subagents?.max_concurrent || 2 });
    this.usageBudgetStore = new UsageBudgetStore(workspaceRoot);
    this.semanticIndex = createSemanticIndex({
      workspaceRoot,
      config,
      fetchImpl,
      secretStore,
      usageBudgetStore: this.usageBudgetStore,
      watchWorkspace: true,
    });
    this.runs = new Map();
    this.runStartsInProgress = 0;
    this.mcpMutationActive = false;
    this.userDataDirectoryMutationActive = false;
    this.runtimePolicyMutationActive = false;
    this.globalMemoryRequestsActive = 0;
    this.extensionUpdateActive = false;
    this.extensionFeedCheckActive = false;
    this.activeSessions = new Set();
    this.activeWorktrees = new Set();
    this.stagedApplicationUpdates = new Map();
    this.applicationUpdateStagingDirectory = null;
    this.applicationUpdateDownloadActive = false;
    this.applicationUpdateDownloadController = null;
    this.appUpdateDownloadTtlMs = appUpdateDownloadTtlMs;
    this.server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    this.server.requestTimeout = 30_000;
    this.server.headersTimeout = 10_000;
    this.server.keepAliveTimeout = 5_000;
    this.server.maxHeadersCount = 64;
    this.started = false;
  }

  async start({ port = 0 } = {}) {
    if (this.started) throw new Error('Control server is already started');
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('port must be an integer from 0 to 65535');
    await this.processManager.initialize();
    await this.mcpManager.initialize();
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          this.server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          this.server.off('error', onError);
          resolve();
        };
        this.server.once('error', onError);
        this.server.once('listening', onListening);
        this.server.listen({ host: '127.0.0.1', port, exclusive: true });
      });
    } catch (error) {
      await this.mcpManager.close();
      throw error;
    }
    this.started = true;
    await this.architectService.start();
    return { url: `http://127.0.0.1:${this.server.address().port}`, token: this.token, api_version: 1 };
  }

  async close() {
    this.semanticIndex?.close();
    await this.architectService.stop();
    if (this.started) {
      this.started = false;
      this.applicationUpdateDownloadController?.abort(Object.assign(new Error('Control server is shutting down'), { code: 'CANCELLED' }));
      const serverClosed = new Promise((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())));
      const stopRun = (run) => {
        if (['running', 'paused'].includes(run.status)) run.controller.abort();
        run.resumeWaiter?.();
        for (const subscriber of run.subscribers) {
          clearInterval(subscriber.heartbeat);
          subscriber.response.end();
        }
        run.subscribers.clear();
        for (const pending of run.pendingApprovals.values()) pending.resolve(false);
        run.pendingApprovals.clear();
      };
      for (const run of this.runs.values()) stopRun(run);
      this.server.closeAllConnections?.();
      await serverClosed;
      const executions = [...this.runs.values()].map((run) => {
        stopRun(run);
        return run.execution;
      });
      await Promise.allSettled(executions.filter(Boolean));
    }
    for (const entry of this.stagedApplicationUpdates.values()) {
      clearTimeout(entry.expiryTimer);
      await fs.rm(entry.path, { force: true }).catch(() => {});
    }
    this.stagedApplicationUpdates.clear();
    if (this.applicationUpdateStagingDirectory) {
      await fs.rm(this.applicationUpdateStagingDirectory, { recursive: true, force: true }).catch(() => {});
      this.applicationUpdateStagingDirectory = null;
    }
    await this.observabilityStore.close().catch(() => {});
    await this.mcpManager.close();
  }

  async #handle(request, response) {
    setResponseHeaders(response);
    try {
      if (!isLoopbackAddress(request.socket.remoteAddress) || !isLocalHostHeader(request.headers.host)) {
        return sendJson(response, 403, { error: 'Local clients only' });
      }
      const url = new URL(request.url, 'http://127.0.0.1');
      const isGuiRoute =
        url.pathname === '/app' ||
        url.pathname === '/app/' ||
        url.pathname.startsWith('/app/') ||
        url.pathname === '/src/core/model-pricing.mjs' ||
        url.pathname === '/src/core/keybindings.mjs' ||
        url.pathname === '/src/core/model-metadata.mjs' ||
        url.pathname === '/src/core/redaction.mjs' ||
        url.pathname === '/src/core/model-fallback.mjs' ||
        url.pathname === '/core/budgets.mjs' ||
        url.pathname === '/core/statuses.mjs' ||
        url.pathname === '/core/limits.mjs';
      const origin = request.headers.origin;
      const requestOrigin = new URL(`http://${request.headers.host}`).origin;
      const sameOrigin = origin === requestOrigin;
      if (isGuiRoute && ((origin && !sameOrigin) || request.headers['sec-fetch-site'] === 'cross-site'))
        return sendJson(response, 403, { error: 'The local app cannot be loaded cross-site' });
      if (origin && !sameOrigin && !this.#allowOrigin(origin)) return sendJson(response, 403, { error: 'Origin is not allowed' });
      if (origin) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Last-Event-ID');
        response.setHeader('Access-Control-Max-Age', '300');
        response.setHeader('Vary', 'Origin');
      }
      if (request.method === 'OPTIONS') return response.writeHead(204).end();
      const updateDownloadMatch = url.pathname.match(/^\/v1\/app-updates\/downloads\/([A-Za-z0-9_-]{43})$/);
      if (updateDownloadMatch) {
        if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed' }, { Allow: 'GET' });
        if (url.search || (origin && !sameOrigin) || request.headers['sec-fetch-site'] === 'cross-site')
          return sendJson(response, 403, { error: 'Update download link must be used from the local application' });
        return await this.#serveApplicationUpdateDownload(response, updateDownloadMatch[1]);
      }
      if (isGuiRoute && ['GET', 'HEAD'].includes(request.method))
        return await this.#serveGui(response, url.pathname, request.method === 'HEAD');
      if (!this.#authorized(request.headers.authorization))
        return sendJson(response, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });

      if (url.pathname === `${API_PREFIX}/health` && request.method === 'GET') {
        return sendJson(response, 200, { status: 'ready', api_version: 1 });
      }
      if (url.pathname === `${API_PREFIX}/sandbox-capability` && request.method === 'GET') {
        const backendAvailable =
          process.platform === 'linux'
            ? Boolean(await findBubblewrap())
            : process.platform === 'win32'
              ? Boolean(await findWindowsSandboxHelper({ workspaceRoot: this.workspaceRoot }))
              : false;
        const available = backendAvailable;
        return sendJson(response, 200, {
          available,
          mode: this.config.sandbox?.mode || 'none',
          reason: available
            ? null
            : process.platform === 'linux'
              ? 'trusted_bubblewrap_unavailable'
              : process.platform === 'win32'
                ? 'windows_appcontainer_helper_unavailable'
                : 'unsupported_platform',
        });
      }
      if (url.pathname === `${API_PREFIX}/settings` && request.method === 'GET') {
        return sendJson(response, 200, { settings: publicSettings(this.config) });
      }
      if (url.pathname === `${API_PREFIX}/settings` && request.method === 'PATCH')
        return await this.#updateRuntimeSettings(request, response);
      if (url.pathname === `${API_PREFIX}/mcp/servers` && request.method === 'GET')
        return sendJson(response, 200, { enabled: this.config.mcp?.enabled === true, servers: this.mcpManager.serverCatalog });
      if (url.pathname === `${API_PREFIX}/mcp/audit` && request.method === 'GET') return await this.#listMcpAudit(response, url);
      if (url.pathname === `${API_PREFIX}/mcp/packages` && request.method === 'GET') return await this.#listSignedMcpPackages(response);
      if (url.pathname === `${API_PREFIX}/extensions/updates` && request.method === 'GET')
        return await this.#listExtensionUpdates(response);
      if (url.pathname === `${API_PREFIX}/extensions/updates/check` && request.method === 'POST')
        return await this.#checkExtensionUpdates(request, response);
      if (url.pathname === `${API_PREFIX}/extensions/updates/install` && request.method === 'POST')
        return await this.#installExtensionUpdate(request, response);
      if (url.pathname === `${API_PREFIX}/extensions/revocations/refresh` && request.method === 'POST')
        return await this.#refreshExtensionRevocations(request, response);
      const signedMcpAction = url.pathname.match(/^\/v1\/mcp\/packages\/([a-z0-9]+(?:[.-][a-z0-9]+)*)\/(activate|disable|rollback)$/);
      if (signedMcpAction && request.method === 'POST')
        return await this.#manageSignedMcpPackage(request, response, signedMcpAction[1], signedMcpAction[2]);
      if (url.pathname === `${API_PREFIX}/mcp/servers` && request.method === 'POST') return await this.#addMcpServer(request, response);
      const mcpTestMatch = url.pathname.match(/^\/v1\/mcp\/servers\/([a-z][a-z0-9_-]{0,31})\/test$/);
      if (mcpTestMatch && request.method === 'POST') return await this.#testMcpServer(request, response, mcpTestMatch[1]);
      const mcpConfigMatch = url.pathname.match(/^\/v1\/mcp\/servers\/([a-z][a-z0-9_-]{0,31})\/config$/);
      if (mcpConfigMatch && request.method === 'GET') return this.#getMcpServerConfig(response, mcpConfigMatch[1]);
      const mcpServerMatch = url.pathname.match(/^\/v1\/mcp\/servers\/([a-z][a-z0-9_-]{0,31})$/);
      if (mcpServerMatch && ['PUT', 'DELETE'].includes(request.method))
        return await this.#manageMcpServer(request, response, mcpServerMatch[1]);
      if (url.pathname === `${API_PREFIX}/app-updates/check` && request.method === 'POST')
        return await this.#checkApplicationUpdates(request, response);
      if (url.pathname === `${API_PREFIX}/app-updates/download` && request.method === 'POST')
        return await this.#prepareApplicationUpdateDownload(request, response);
      if (url.pathname === `${API_PREFIX}/local-models` && request.method === 'GET') return await this.#discoverLocalModels(response);
      if (url.pathname === `${API_PREFIX}/local-models/load` && request.method === 'POST')
        return await this.#loadLocalModel(request, response);
      const secretMatch = url.pathname.match(/^\/v1\/secrets\/([A-Za-z0-9_.%-]+)$/);
      if (secretMatch && ['PUT', 'DELETE'].includes(request.method)) return await this.#updateSecret(request, response, secretMatch[1]);
      if (url.pathname === `${API_PREFIX}/skills` && request.method === 'GET') {
        const skills =
          this.config.skills?.enabled === true
            ? (await this.skillLibrary.list()).map(({ name, description }) => ({ name, description, trust: 'untrusted' }))
            : [];
        return sendJson(response, 200, { enabled: this.config.skills?.enabled === true, skills });
      }
      if (url.pathname === `${API_PREFIX}/skills/packages` && request.method === 'GET')
        return await this.#listSignedSkillPackages(response);
      const signedSkillAction = url.pathname.match(/^\/v1\/skills\/packages\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(activate|disable|rollback)$/);
      if (signedSkillAction && request.method === 'POST')
        return await this.#manageSignedSkillPackage(request, response, signedSkillAction[1], signedSkillAction[2]);
      const skillMatch = url.pathname.match(/^\/v1\/skills\/([a-z0-9]+(?:-[a-z0-9]+)*)$/);
      if (skillMatch && request.method === 'GET') {
        if (this.config.skills?.enabled !== true) return sendJson(response, 404, { error: 'Configured skills are disabled' });
        try {
          return sendJson(response, 200, { skill: await this.skillLibrary.load(skillMatch[1]) });
        } catch (error) {
          if (/was not found/.test(error.message)) return sendJson(response, 404, { error: 'Configured skill was not found' });
          throw error;
        }
      }
      if (url.pathname === `${API_PREFIX}/usage` && request.method === 'GET') {
        return sendJson(response, 200, { limits: publicSettings(this.config).budgets, ...(await this.usageBudgetStore.snapshot()) });
      }
      if (url.pathname === `${API_PREFIX}/models` && request.method === 'GET') return await this.#listModels(request, response);
      if (url.pathname === `${API_PREFIX}/retrieval/index` && request.method === 'GET') {
        if (!this.semanticIndex) return sendJson(response, 409, { error: 'Semantic retrieval is disabled in configuration' });
        return sendJson(response, 200, await this.semanticIndex.status());
      }
      if (url.pathname === `${API_PREFIX}/retrieval/index` && request.method === 'POST')
        return await this.#manageRetrievalIndex(request, response);
      if (url.pathname === `${API_PREFIX}/retrieval/exclusions` && request.method === 'GET') {
        if (!this.semanticIndex) return sendJson(response, 409, { error: 'Semantic retrieval is disabled in configuration' });
        return sendJson(response, 200, { patterns: await this.semanticIndex.listExclusions() });
      }
      if (url.pathname === `${API_PREFIX}/retrieval/exclusions` && request.method === 'POST')
        return await this.#manageRetrievalExclusions(request, response);
      if (url.pathname === `${API_PREFIX}/retrieval/semantic` && request.method === 'POST')
        return await this.#semanticSearch(request, response);
      if (url.pathname === `${API_PREFIX}/subagents` && request.method === 'GET') {
        const allowed = new Set(['limit']);
        if ([...url.searchParams.keys()].some((key) => !allowed.has(key)) || url.searchParams.getAll('limit').length > 1)
          return sendJson(response, 400, { error: 'Subagent listing accepts one optional limit' });
        const rawLimit = url.searchParams.get('limit');
        if (rawLimit !== null && !/^[1-9]\d*$/.test(rawLimit))
          return sendJson(response, 400, { error: 'limit must be an integer from 1 to 500' });
        const limit = rawLimit === null ? 100 : Number(rawLimit);
        if (limit > 500) return sendJson(response, 400, { error: 'limit must be an integer from 1 to 500' });
        return sendJson(response, 200, { tasks: await this.subagentTaskStore.list({ limit }) });
      }
      if (url.pathname === `${API_PREFIX}/subagents/recovery` && request.method === 'GET') {
        try {
          return sendJson(response, 200, {
            interrupted_tasks: await this.subagentTaskStore.inspectInterrupted(),
            orphaned_worktrees: await this.subagentTaskStore.inspectOrphanedWorktrees({ workspaceRoot: this.workspaceRoot }),
          });
        } catch (error) {
          if (error.code === 'WORKTREE_UNAVAILABLE')
            return sendJson(response, 409, { error: 'Subagent worktree inspection requires a Git workspace' });
          throw error;
        }
      }
      const subagentCancelMatch = url.pathname.match(/^\/v1\/subagents\/([^/]+)\/cancel$/i);
      if (subagentCancelMatch && request.method === 'POST') {
        const taskId = subagentCancelMatch[1];
        if (!isUuid(taskId)) return sendJson(response, 400, { error: 'Subagent task ID must be a UUID' });
        const body = await readJson(request);
        if (!isExactObject(body, [])) return sendJson(response, 400, { error: 'Subagent cancellation body must be an empty object' });
        const result = await this.subagentTaskStore.requestCancellation(taskId);
        if (result.reason === 'not_found') return sendJson(response, 404, { error: 'Subagent task not found' });
        if (result.reason === 'not_running') return sendJson(response, 409, { error: 'Subagent task is already finished' });
        if (result.reason === 'not_active_here')
          return sendJson(response, 409, { error: 'Subagent task is not active in this API process', code: 'SUBAGENT_NOT_ACTIVE' });
        return sendJson(response, 202, {
          task_id: taskId,
          status: 'cancellation_requested',
          already_requested: result.already_requested,
        });
      }
      const subagentMatch = url.pathname.match(/^\/v1\/subagents\/([0-9a-f-]+)$/i);
      if (subagentMatch && request.method === 'GET') {
        const task = await this.subagentTaskStore.read(subagentMatch[1]);
        return task ? sendJson(response, 200, { task }) : sendJson(response, 404, { error: 'Subagent task not found' });
      }
      if (url.pathname === `${API_PREFIX}/processes` && request.method === 'GET') {
        const allowed = new Set(['session_id', 'limit']);
        if (
          [...url.searchParams.keys()].some((key) => !allowed.has(key)) ||
          [...allowed].some((key) => url.searchParams.getAll(key).length > 1)
        )
          return sendJson(response, 400, { error: 'Processes accepts one optional session_id and limit' });
        const sessionId = url.searchParams.get('session_id');
        if (sessionId !== null && !isUuid(sessionId)) return sendJson(response, 400, { error: 'session_id must be a valid UUID' });
        const limitValue = url.searchParams.get('limit');
        if (limitValue !== null && !/^[1-9]\d*$/.test(limitValue))
          return sendJson(response, 400, { error: 'limit must be an integer from 1 to 100' });
        const limit = limitValue === null ? 100 : Number(limitValue);
        if (limit > 100) return sendJson(response, 400, { error: 'limit must be an integer from 1 to 100' });
        return sendJson(response, 200, { processes: await this.processManager.list({ session_id: sessionId, limit }) });
      }
      const processMatch = url.pathname.match(/^\/v1\/processes\/([0-9a-f-]+)(?:\/(stop|input))?$/i);
      if (processMatch && !processMatch[2] && request.method === 'GET')
        return sendJson(response, 200, { process: await this.processManager.read(processMatch[1]) });
      if (processMatch && processMatch[2] === 'stop' && request.method === 'POST') {
        const body = await readJson(request);
        if (!isExactObject(body, [])) return sendJson(response, 400, { error: 'Stop request body must be an empty object' });
        const current = await this.processManager.read(processMatch[1]);
        if (['orphaned', 'unmanaged', 'identity_mismatch'].includes(current.status))
          return sendJson(response, 409, {
            error:
              'Process state cannot be safely controlled by this manager; use the owning service or verify it through the operating system',
          });
        const toolCallId = randomUUID();
        const audit = {
          sessionId: current.session_id || 'api-process-management',
          toolCallId,
          tool: 'stop_background_process',
          args: { process_id: current.id },
          decision: 'allow',
          policySource: 'authenticated_user_api',
          approvalResult: true,
        };
        await this.processAuditStore.record({ ...audit, outcome: 'started' });
        const result = await this.processManager.stop(processMatch[1]);
        try {
          await this.processAuditStore.record({ ...audit, outcome: result.stopped ? 'succeeded' : 'no_op' });
        } catch {
          return sendJson(response, 500, { error: 'The stop outcome could not be audited; inspect process status before retrying' });
        }
        return sendJson(response, 200, { process: result });
      }
      if (processMatch && processMatch[2] === 'input' && request.method === 'POST') {
        const body = await readJson(request, 400_000);
        if (!isExactObject(body, ['input']) || typeof body.input !== 'string' || Buffer.byteLength(body.input) > 65_536)
          return sendJson(response, 400, { error: 'Input request must contain one string of at most 65536 bytes' });
        const current = await this.processManager.read(processMatch[1]);
        const audit = {
          sessionId: current.session_id || 'api-process-management',
          toolCallId: randomUUID(),
          tool: 'send_background_input',
          args: { process_id: current.id, input: body.input },
          decision: 'allow',
          policySource: 'authenticated_user_api',
          approvalResult: true,
        };
        await this.processAuditStore.record({ ...audit, outcome: 'started' });
        let result;
        try {
          result = await this.processManager.writeInput(processMatch[1], body.input);
        } catch (error) {
          await this.processAuditStore
            .record({ ...audit, outcome: 'failed', errorCode: error.code || 'PROCESS_INPUT_FAILED' })
            .catch(() => {});
          throw error;
        }
        try {
          await this.processAuditStore.record({ ...audit, outcome: 'succeeded' });
        } catch {
          return sendJson(response, 500, {
            error: 'Input was written, but its audit outcome could not be saved; inspect process output before retrying',
          });
        }
        return sendJson(response, 200, { result });
      }
      if (processMatch && !processMatch[2] && request.method === 'DELETE') {
        const current = await this.processManager.read(processMatch[1]);
        if (['starting', 'running', 'stopping', 'recoverable', 'orphaned', 'unmanaged'].includes(current.status))
          return sendJson(response, 409, { error: 'Active, recoverable, orphaned, or unmanaged process records cannot be removed' });
        const audit = {
          sessionId: current.session_id || 'api-process-management',
          toolCallId: randomUUID(),
          tool: 'process_record',
          args: { process_id: current.id },
          decision: 'allow',
          policySource: 'authenticated_user_api',
          approvalResult: true,
        };
        await this.processAuditStore.record({ ...audit, outcome: 'removal_started' });
        const result = await this.processManager.remove(processMatch[1]);
        await this.processAuditStore.record({ ...audit, outcome: 'removed' });
        return sendJson(response, 200, result);
      }
      if (url.pathname === `${API_PREFIX}/retrieval/search` && request.method === 'GET') {
        const allowed = new Set(['q', 'path_glob', 'max_results']);
        if (
          [...url.searchParams.keys()].some((key) => !allowed.has(key)) ||
          [...allowed].some((key) => url.searchParams.getAll(key).length > 1)
        ) {
          return sendJson(response, 400, { error: 'Search accepts one q, optional path_glob, and optional max_results parameter' });
        }
        const query = url.searchParams.get('q');
        if (query === null || !query.trim() || query.length > 512) {
          return sendJson(response, 400, { error: 'q must contain 1 to 512 characters' });
        }
        const pathGlob = url.searchParams.get('path_glob') ?? undefined;
        if (pathGlob !== undefined && (!pathGlob.trim() || pathGlob.length > 256)) {
          return sendJson(response, 400, { error: 'path_glob must contain 1 to 256 characters' });
        }
        let maxResults = Math.min(100, this.config.retrieval?.max_results ?? 25);
        if (url.searchParams.has('max_results')) {
          const value = url.searchParams.get('max_results');
          if (!/^[1-9]\d*$/.test(value)) return sendJson(response, 400, { error: 'max_results must be an integer from 1 to 100' });
          maxResults = Number(value);
          if (maxResults > 100) return sendJson(response, 400, { error: 'max_results must be an integer from 1 to 100' });
        }
        return sendJson(
          response,
          200,
          await searchWorkspace(this.workspaceRoot, query, { ...this.config.retrieval, pathGlob, maxResults }),
        );
      }
      if (url.pathname === `${API_PREFIX}/approval-rules` && request.method === 'GET')
        return sendJson(response, 200, { rules: await this.approvalRuleStore.list() });
      if (url.pathname === `${API_PREFIX}/approval-rules` && request.method === 'POST')
        return await this.#createApprovalRule(request, response);
      const approvalRuleMatch = url.pathname.match(/^\/v1\/approval-rules\/([0-9a-f-]+)$/i);
      if (approvalRuleMatch && request.method === 'DELETE') return await this.#revokeApprovalRule(response, approvalRuleMatch[1]);
      if (url.pathname === `${API_PREFIX}/sessions` && request.method === 'GET') {
        const sessions = await this.sessionStore.list();
        return sendJson(response, 200, {
          sessions: sessions.slice(0, 500).map((session) => {
            const activeRun = this.#activeRunForSession(session.id);
            return { ...session, run_active: this.activeSessions.has(session.id), run_id: activeRun?.id || null };
          }),
          truncated: sessions.length > 500,
        });
      }
      if (url.pathname === `${API_PREFIX}/sessions/diagnostics` && request.method === 'GET')
        return sendJson(response, 200, await this.sessionStore.inspectRecords());
      if (url.pathname === `${API_PREFIX}/sessions/import` && request.method === 'POST') {
        const document = await readJson(request, MAX_SESSION_EXPORT_BYTES);
        const session = await this.sessionStore.importSession(document);
        return sendJson(response, 201, { session: { id: session.id, title: session.title || 'New conversation', status: session.status } });
      }
      const sessionExportMatch = url.pathname.match(/^\/v1\/sessions\/([0-9a-f-]+)\/export$/i);
      if (sessionExportMatch && request.method === 'GET')
        return sendJson(response, 200, await this.sessionStore.exportSession(sessionExportMatch[1]));
      const sessionRecapMatch = url.pathname.match(/^\/v1\/sessions\/([0-9a-f-]+)\/recap$/i);
      if (sessionRecapMatch && request.method === 'GET') {
        const session = await this.sessionStore.load(sessionRecapMatch[1]);
        return sendJson(response, 200, { recap: recapSession(session) });
      }
      const sessionGoalsMatch = url.pathname.match(/^\/v1\/sessions\/([0-9a-f-]+)\/goals$/i);
      if (sessionGoalsMatch && request.method === 'PUT') return await this.#updateSessionGoals(request, response, sessionGoalsMatch[1]);
      const sessionMatch = url.pathname.match(/^\/v1\/sessions\/([0-9a-f-]+)$/i);
      const sessionPlanMatch = url.pathname.match(/^\/v1\/sessions\/([0-9a-f-]+)\/plan$/i);
      if (sessionPlanMatch && request.method === 'PUT') return await this.#updateSessionPlan(request, response, sessionPlanMatch[1]);
      if (sessionMatch && request.method === 'GET') {
        const session = await this.sessionStore.load(sessionMatch[1]);
        const lastMessage = session.messages.at(-1);
        const activeRun = this.#activeRunForSession(session.id);
        return sendJson(response, 200, {
          ...session,
          run_active: this.activeSessions.has(session.id),
          run_id: activeRun?.id || null,
          last_message_role: lastMessage?.role || null,
          last_message_has_tool_calls:
            lastMessage?.role === 'assistant' && Array.isArray(lastMessage.tool_calls) && lastMessage.tool_calls.length > 0,
        });
      }
      if (sessionMatch && request.method === 'PATCH') return await this.#renameSession(request, response, sessionMatch[1]);
      if (sessionMatch && request.method === 'DELETE') return await this.#deleteSession(response, sessionMatch[1]);
      const sessionActionMatch = url.pathname.match(/^\/v1\/sessions\/([0-9a-f-]+)\/(archive|fork)$/i);
      if (sessionActionMatch && request.method === 'POST') {
        if (sessionActionMatch[2] === 'archive') return await this.#archiveSession(response, sessionActionMatch[1]);
        if (await this.#activeSession(response, sessionActionMatch[1])) return;
        return sendJson(response, 201, await this.sessionStore.fork(sessionActionMatch[1]));
      }
      const sessionGrantMatch = url.pathname.match(/^\/v1\/sessions\/([0-9a-f-]+)\/grants(?:\/([0-9a-f-]+))?$/i);
      if (sessionGrantMatch && !sessionGrantMatch[2] && request.method === 'GET') {
        return sendJson(response, 200, { grants: await this.sessionStore.listPermissionGrants(sessionGrantMatch[1]) });
      }
      if (sessionGrantMatch?.[2] && request.method === 'DELETE')
        return await this.#revokeSessionGrant(response, sessionGrantMatch[1], sessionGrantMatch[2]);
      if (url.pathname === `${API_PREFIX}/memory` && request.method === 'GET') return await this.#memorySummary(response);
      if (url.pathname === `${API_PREFIX}/memory/global` && request.method === 'GET')
        return await this.#withGlobalMemoryAccess(response, () => this.#memorySummary(response, this.globalMemoryStore, 'global'));
      if (url.pathname === `${API_PREFIX}/memory/global` && request.method === 'POST')
        return await this.#withGlobalMemoryAccess(response, () => this.#addMemory(request, response, this.globalMemoryStore));
      if (url.pathname === `${API_PREFIX}/memory/global/export` && request.method === 'GET') {
        return await this.#withGlobalMemoryAccess(response, async () => {
          if (!this.globalMemoryStore)
            return sendJson(response, 409, { error: 'Global memory is disabled in user settings', code: 'GLOBAL_MEMORY_DISABLED' });
          return sendJson(response, 200, await this.globalMemoryStore.exportMemory());
        });
      }
      if (url.pathname === `${API_PREFIX}/memory/global/import` && request.method === 'POST') {
        return await this.#withGlobalMemoryAccess(response, async () => {
          if (!this.globalMemoryStore)
            return sendJson(response, 409, { error: 'Global memory is disabled in user settings', code: 'GLOBAL_MEMORY_DISABLED' });
          const document = await readJson(request, MAX_MEMORY_EXPORT_BYTES);
          return sendJson(response, 200, await this.globalMemoryStore.importMemory(document));
        });
      }
      if (url.pathname === `${API_PREFIX}/memory/global/search` && request.method === 'GET')
        return await this.#withGlobalMemoryAccess(response, () => this.#searchMemory(response, url, this.globalMemoryStore));
      const globalMemorySectionMatch = url.pathname.match(/^\/v1\/memory\/global\/([a-z_]+)$/);
      if (globalMemorySectionMatch && request.method === 'GET')
        return await this.#withGlobalMemoryAccess(response, () =>
          this.#listMemory(response, globalMemorySectionMatch[1], url, this.globalMemoryStore),
        );
      const globalMemoryItemMatch = url.pathname.match(/^\/v1\/memory\/global\/([a-z_]+)\/([0-9a-f-]+)$/i);
      if (globalMemoryItemMatch && request.method === 'PATCH')
        return await this.#withGlobalMemoryAccess(response, () =>
          this.#updateMemory(request, response, globalMemoryItemMatch[1], globalMemoryItemMatch[2], this.globalMemoryStore),
        );
      if (globalMemoryItemMatch && request.method === 'DELETE')
        return await this.#withGlobalMemoryAccess(response, () =>
          this.#deleteMemory(response, globalMemoryItemMatch[1], globalMemoryItemMatch[2], this.globalMemoryStore),
        );
      if (url.pathname === `${API_PREFIX}/memory` && request.method === 'POST') return await this.#addMemory(request, response);
      if (url.pathname === `${API_PREFIX}/memory/export` && request.method === 'GET')
        return sendJson(response, 200, await this.memoryStore.exportMemory());
      if (url.pathname === `${API_PREFIX}/memory/import` && request.method === 'POST') {
        const document = await readJson(request, MAX_MEMORY_EXPORT_BYTES);
        return sendJson(response, 200, await this.memoryStore.importMemory(document));
      }
      if (url.pathname === `${API_PREFIX}/memory/search` && request.method === 'GET') return await this.#searchMemory(response, url);
      const memorySectionMatch = url.pathname.match(/^\/v1\/memory\/([a-z_]+)$/);
      if (memorySectionMatch && request.method === 'GET') return await this.#listMemory(response, memorySectionMatch[1], url);
      const memoryItemMatch = url.pathname.match(/^\/v1\/memory\/([a-z_]+)\/([0-9a-f-]+)$/i);
      if (memoryItemMatch && request.method === 'PATCH')
        return await this.#updateMemory(request, response, memoryItemMatch[1], memoryItemMatch[2]);
      if (memoryItemMatch && request.method === 'DELETE') return await this.#deleteMemory(response, memoryItemMatch[1], memoryItemMatch[2]);
      if (url.pathname === `${API_PREFIX}/goals` && request.method === 'GET') return await this.#listGoals(response, url);
      if (url.pathname === `${API_PREFIX}/goals` && request.method === 'POST') return await this.#addGoal(request, response);
      const goalProgressMatch = url.pathname.match(/^\/v1\/goals\/([0-9a-f-]+)\/progress(?:\/([0-9a-f-]+))?$/i);
      if (goalProgressMatch && !goalProgressMatch[2] && request.method === 'POST')
        return await this.#addGoalProgress(request, response, goalProgressMatch[1]);
      if (goalProgressMatch?.[2] && request.method === 'PATCH')
        return await this.#updateGoalProgress(request, response, goalProgressMatch[1], goalProgressMatch[2]);
      if (goalProgressMatch?.[2] && request.method === 'DELETE')
        return await this.#deleteGoalProgress(response, goalProgressMatch[1], goalProgressMatch[2]);
      const goalMatch = url.pathname.match(/^\/v1\/goals\/([0-9a-f-]+)$/i);
      if (goalMatch && request.method === 'PATCH') return await this.#setGoalStatus(request, response, goalMatch[1]);
      if (goalMatch && request.method === 'DELETE') return await this.#deleteGoal(response, goalMatch[1]);
      if (url.pathname === `${API_PREFIX}/worktrees` && request.method === 'GET') {
        return sendJson(response, 200, { worktrees: await listWorktrees(this.workspaceRoot) });
      }
      if (url.pathname === `${API_PREFIX}/workspace` && request.method === 'GET') {
        const relativePath = url.searchParams.get('path') || '';
        const worktreeId = url.searchParams.get('worktree_id');
        let root = this.workspaceRoot;
        if (worktreeId) {
          const worktrees = await listWorktrees(this.workspaceRoot);
          const selected = worktrees.find((entry) => entry.id === worktreeId);
          if (!selected) return sendJson(response, 404, { error: 'Worktree is not available in this workspace' });
          root = selected.path;
        }
        return sendJson(response, 200, await inspectWorkspace(root, { relativePath }));
      }
      if (url.pathname === `${API_PREFIX}/workspace/file` && request.method === 'GET') {
        const relativePath = url.searchParams.get('path') || '';
        const worktreeId = url.searchParams.get('worktree_id');
        let root = this.workspaceRoot;
        if (worktreeId) {
          const worktrees = await listWorktrees(this.workspaceRoot);
          const selected = worktrees.find((entry) => entry.id === worktreeId);
          if (!selected) return sendJson(response, 404, { error: 'Worktree is not available in this workspace' });
          root = selected.path;
        }
        return sendJson(response, 200, await readWorkspaceFile(root, relativePath));
      }
      if (url.pathname === `${API_PREFIX}/worktrees` && request.method === 'POST') return await this.#createWorktree(request, response);
      const worktreeMatch = url.pathname.match(/^\/v1\/worktrees\/([0-9a-f-]+)$/i);
      if (worktreeMatch && request.method === 'DELETE') {
        if (this.activeWorktrees.has(worktreeMatch[1])) return sendJson(response, 409, { error: 'Worktree has an active run' });
        return sendJson(response, 200, await removeWorktree(this.workspaceRoot, worktreeMatch[1]));
      }
      if (url.pathname === `${API_PREFIX}/runs` && request.method === 'POST') {
        if (this.userDataDirectoryMutationActive)
          return sendJson(response, 409, {
            error: 'The global memory data directory is changing; retry the run shortly.',
            code: 'USER_DATA_DIRECTORY_BUSY',
          });
        if (this.runtimePolicyMutationActive)
          return sendJson(response, 409, {
            error: 'Runtime policy settings are changing; retry the run shortly.',
            code: 'RUNTIME_POLICY_BUSY',
          });
        if (this.mcpMutationActive) return sendJson(response, 409, { error: 'MCP server settings are changing; retry the run shortly.' });
        this.runStartsInProgress += 1;
        try {
          return await this.#createRun(request, response);
        } finally {
          this.runStartsInProgress -= 1;
        }
      }

      const eventsMatch = url.pathname.match(/^\/v1\/runs\/([0-9a-f-]+)\/events$/i);
      if (eventsMatch && request.method === 'GET') return this.#streamEvents(request, response, eventsMatch[1], url);
      const cancelMatch = url.pathname.match(/^\/v1\/runs\/([0-9a-f-]+)\/cancel$/i);
      if (cancelMatch && request.method === 'POST') return this.#cancelRun(response, cancelMatch[1]);
      const pauseMatch = url.pathname.match(/^\/v1\/runs\/([0-9a-f-]+)\/pause$/i);
      if (pauseMatch && request.method === 'POST') return await this.#pauseRun(request, response, pauseMatch[1]);
      const resumeMatch = url.pathname.match(/^\/v1\/runs\/([0-9a-f-]+)\/resume$/i);
      if (resumeMatch && request.method === 'POST') return await this.#resumeRun(request, response, resumeMatch[1]);
      const directionMatch = url.pathname.match(/^\/v1\/runs\/([0-9a-f-]+)\/directions$/i);
      if (directionMatch && request.method === 'POST') return await this.#addRunDirection(request, response, directionMatch[1]);
      const modelChangeMatch = url.pathname.match(/^\/v1\/runs\/([0-9a-f-]+)\/model$/i);
      if (modelChangeMatch && request.method === 'POST') return await this.#changeRunModel(request, response, modelChangeMatch[1]);
      const budgetChangeMatch = url.pathname.match(/^\/v1\/runs\/([0-9a-f-]+)\/budgets$/i);
      if (budgetChangeMatch && request.method === 'PATCH') return await this.#changeRunBudgets(request, response, budgetChangeMatch[1]);
      const approvalMatch = url.pathname.match(/^\/v1\/runs\/([0-9a-f-]+)\/approvals\/([0-9a-f-]+)$/i);
      if (approvalMatch && request.method === 'POST')
        return await this.#answerApproval(request, response, approvalMatch[1], approvalMatch[2]);
      const runMatch = url.pathname.match(/^\/v1\/runs\/([0-9a-f-]+)$/i);
      if (runMatch && request.method === 'GET') return this.#getRun(response, runMatch[1]);
      return sendJson(response, 404, { error: 'Route not found' });
    } catch (error) {
      const status = errorStatus(error);
      return sendJson(response, status, { error: status === 500 ? 'Internal server error' : error.message });
    }
  }

  #authorized(header) {
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    const provided = Buffer.from(header.slice(7));
    const expected = Buffer.from(this.token);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }

  #allowOrigin(origin) {
    return Array.isArray(this.config.api?.allowed_origins) && this.config.api.allowed_origins.includes(origin);
  }

  async #listModels(_request, response) {
    const controller = new AbortController();
    const onClose = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.once('close', onClose);
    try {
      const allProfiles = Object.entries(this.config.models || {});
      const profiles = allProfiles.slice(0, 32);
      const results = [];
      for (let offset = 0; offset < profiles.length; offset += 4) {
        const batch = await Promise.all(
          profiles.slice(offset, offset + 4).map(async ([profile, model]) => {
            try {
              const apiKey = await resolveModelApiKey(model, { secretStore: this.secretStore });
              const provider = new OpenAICompatibleProvider({
                baseUrl: model.base_url,
                model: model.model,
                apiKey,
                timeoutMs: Math.min(model.timeout_ms || 10_000, 10_000),
                fetchImpl: this.fetchImpl,
              });
              const { models: available, truncated: providerTruncated } = await provider.listModelsDetailed({ signal: controller.signal });
              const allIds = [...new Set(available.filter((item) => typeof item.id === 'string').map((item) => item.id.slice(0, 200)))];
              return {
                profile,
                models: allIds.slice(0, 100),
                truncated:
                  providerTruncated || allIds.length > 100 || available.some((item) => typeof item.id === 'string' && item.id.length > 200),
              };
            } catch (error) {
              return { profile, models: [], error: safeModelListError(error) };
            }
          }),
        );
        results.push(...batch);
        if (controller.signal.aborted) return;
      }
      if (response.destroyed) return;
      return sendJson(response, 200, { profiles: results, truncated: allProfiles.length > profiles.length });
    } finally {
      response.off('close', onClose);
    }
  }

  async #discoverLocalModels(response) {
    const servers = await discoverLocalServers({
      config: { local_servers: this.config.local_servers, discovery: { enabled: true } },
      fetchImpl: this.fetchImpl,
    });
    return sendJson(response, 200, {
      servers: servers.map(({ name, base_url, models, models_truncated, model_context_lengths, model_states, model_capabilities }) => ({
        name,
        base_url,
        models,
        models_truncated,
        ...(model_context_lengths ? { model_context_lengths } : {}),
        ...(model_states ? { model_states } : {}),
        ...(model_capabilities ? { model_capabilities } : {}),
      })),
      scanned: ['http://127.0.0.1:11434/v1', 'http://127.0.0.1:1234/v1', 'http://127.0.0.1:8080/v1'],
    });
  }

  async #loadLocalModel(request, response) {
    const body = await readJson(request);
    if (!isExactObject(body, ['model']) || typeof body.model !== 'string')
      return sendJson(response, 400, { error: 'Model load requires exactly one model ID' });
    try {
      const result = await loadLmStudioModel(body.model, { fetchImpl: this.fetchImpl });
      return sendJson(response, 200, result);
    } catch (error) {
      if (Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599)
        return sendJson(response, error.statusCode, { error: error.message, code: error.code });
      throw error;
    }
  }

  async #listSignedSkillPackages(response) {
    if (!this.installedPackages || Object.keys(this.installedPackages.trustedKeys || {}).length === 0)
      return sendJson(response, 200, { configured: false, packages: [] });
    let activations;
    try {
      activations = await listInstalledPackageActivations(this.installedPackages);
    } catch (error) {
      if (error.code === 'ENOENT') activations = [];
      else throw error;
    }
    const activationById = new Map(
      activations
        .filter((item) => item.package_type === 'skill')
        .map(({ package_id, active_version, previous_versions }) => [package_id, { active_version, previous_versions }]),
    );
    const installedVersions = await listInstalledSkillVersions(this.installedPackages);
    const packageIds = new Set([...activationById.keys(), ...installedVersions.map((item) => item.package_id)]);
    const availableVersionsById = new Map(installedVersions.map((item) => [item.package_id, item.available_versions]));
    const packages = [...packageIds].sort().map((package_id) => ({
      package_id,
      active_version: activationById.get(package_id)?.active_version || null,
      previous_versions: activationById.get(package_id)?.previous_versions || [],
      available_versions: availableVersionsById.get(package_id) || [],
    }));
    return sendJson(response, 200, { configured: true, packages });
  }

  async #listExtensionUpdates(response) {
    const extensions = this.config.extensions || {};
    const configured = Boolean(this.installedPackages && Object.keys(this.installedPackages.trustedKeys || {}).length);
    if (!configured)
      return sendJson(response, 200, {
        configured: false,
        update_feed_configured: Boolean(extensions.update_feed_url),
        revocation_feed_configured: Boolean(extensions.revocation_url),
        status: 'package_trust_not_configured',
        updates: [],
      });
    if (!extensions.update_feed_url || !extensions.update_key_id)
      return sendJson(response, 200, {
        configured: true,
        update_feed_configured: false,
        revocation_feed_configured: Boolean(extensions.revocation_url),
        status: 'update_feed_not_configured',
        updates: [],
      });
    try {
      const state = await this.#readExtensionUpdateState();
      return sendJson(response, 200, {
        configured: true,
        update_feed_configured: true,
        revocation_feed_configured: Boolean(extensions.revocation_url),
        status: 'ready',
        sequence: state.feed.sequence,
        issued_at: state.feed.issued_at,
        expires_at: state.feed.expires_at,
        updates: state.updates,
      });
    } catch (error) {
      if (['REVOCATION_DATA_UNAVAILABLE', 'REVOCATION_FEED_EXPIRED'].includes(error.code))
        return sendJson(response, 200, {
          configured: true,
          update_feed_configured: true,
          revocation_feed_configured: true,
          status: 'revocation_refresh_required',
          updates: [],
        });
      if (['UPDATE_DATA_UNAVAILABLE', 'UPDATE_FEED_EXPIRED'].includes(error.code))
        return sendJson(response, 200, {
          configured: true,
          update_feed_configured: true,
          revocation_feed_configured: Boolean(extensions.revocation_url),
          status: 'update_check_required',
          updates: [],
        });
      throw error;
    }
  }

  async #checkExtensionUpdates(request, response) {
    const body = await readJson(request, 1024);
    if (!isExactObject(body, [])) return sendJson(response, 400, { error: 'Package update check accepts an empty JSON object' });
    const config = this.#extensionFeedConfig();
    if (!config) return sendJson(response, 409, { error: 'Package update trust and feed settings are not configured' });
    if (this.mcpMutationActive || this.extensionFeedCheckActive)
      return sendJson(response, 409, { error: 'Signed extension trust is changing; retry the package update check shortly.' });
    this.extensionFeedCheckActive = true;
    const audit = {
      sessionId: 'api-extension-updates',
      toolCallId: randomUUID(),
      tool: 'check_package_updates',
      args: { feed_key_id: config.keyId },
      decision: 'allow',
      policySource: 'authenticated_user_api',
      approvalResult: 'user_initiated_check',
    };
    const controller = new AbortController();
    const onClose = () => {
      if (!response.writableEnded)
        controller.abort(Object.assign(new Error('Package update check client disconnected'), { code: 'CANCELLED' }));
    };
    response.once('close', onClose);
    try {
      await this.processAuditStore.record({ ...audit, outcome: 'started' });
      const revocations = await this.#readExtensionRevocations(config.trust);
      const feed = await refreshPackageUpdateFeed({
        ...config,
        revokedKeyIds: revocations.revokedKeyIds,
        fetchImpl: this.fetchImpl,
        signal: controller.signal,
      });
      const state = await this.#extensionUpdateInventory(feed, config.trust);
      await this.processAuditStore.record({ ...audit, outcome: 'succeeded' });
      return sendJson(response, 200, {
        status: 'ready',
        sequence: feed.sequence,
        issued_at: feed.issued_at,
        expires_at: feed.expires_at,
        updates: state,
      });
    } catch (error) {
      await this.processAuditStore
        .record({ ...audit, outcome: 'failed', errorCode: error.code || error.name || 'PACKAGE_UPDATE_CHECK_FAILED' })
        .catch(() => {});
      throw error;
    } finally {
      response.off('close', onClose);
      this.extensionFeedCheckActive = false;
    }
  }

  async #installExtensionUpdate(request, response) {
    const body = await readJson(request, 1024);
    if (
      !isExactObject(body, ['package_type', 'package_id']) ||
      !['skill', 'mcp'].includes(body.package_type) ||
      typeof body.package_id !== 'string' ||
      !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(body.package_id)
    )
      return sendJson(response, 400, { error: 'Package update install requires a valid package_type and package_id' });
    const config = this.#extensionFeedConfig();
    if (!config) return sendJson(response, 409, { error: 'Package update trust and feed settings are not configured' });
    if (this.mcpMutationActive)
      return sendJson(response, 409, { error: 'Signed extension trust is changing; retry the package update shortly.' });
    if (this.extensionUpdateActive) return sendJson(response, 409, { error: 'Another package update download is already being staged' });
    this.extensionUpdateActive = true;
    const audit = {
      sessionId: 'api-extension-updates',
      toolCallId: randomUUID(),
      tool: 'stage_package_update',
      args: { package_type: body.package_type, package_id: body.package_id },
      decision: 'allow',
      policySource: 'authenticated_user_api',
      approvalResult: 'user_selected_update',
    };
    const controller = new AbortController();
    const onClose = () => {
      if (!response.writableEnded) controller.abort(Object.assign(new Error('Package update client disconnected'), { code: 'CANCELLED' }));
    };
    response.once('close', onClose);
    try {
      await this.processAuditStore.record({ ...audit, outcome: 'started' });
      const revocations = await this.#readExtensionRevocations(config.trust);
      const feed = await getCachedPackageUpdateFeed({
        ...config,
        revokedKeyIds: revocations.revokedKeyIds,
      });
      const updates = await this.#extensionUpdateInventory(feed, config.trust);
      const selected = updates.find((item) => item.package_type === body.package_type && item.package_id === body.package_id);
      if (!selected)
        throw Object.assign(new Error('No currently eligible signed update exists for this package'), {
          code: 'UPDATE_SELECTION_UNAVAILABLE',
        });
      if (selected.staged)
        throw Object.assign(new Error('This signed update is already staged; activate it from its Skills or MCP panel'), {
          code: 'UPDATE_ALREADY_STAGED',
        });
      const release = availablePackageUpdates(await this.#extensionActivations(), feed, {
        cohortId: await getPackageUpdateCohortId(config.installRoot),
      }).find((item) => item.package_type === body.package_type && item.package_id === body.package_id);
      if (!release)
        throw Object.assign(new Error('No currently eligible signed update exists for this package'), {
          code: 'UPDATE_SELECTION_UNAVAILABLE',
        });
      const staged = await downloadAndInstallPackageUpdate({
        release,
        installRoot: config.installRoot,
        trustedKeys: config.trustedKeys,
        revokedKeyIds: revocations.revokedKeyIds,
        revokedPackages: revocations.revokedPackages,
        feedExpiresAt: feed.expires_at,
        fetchImpl: this.fetchImpl,
        signal: controller.signal,
      });
      if (controller.signal.aborted || response.destroyed)
        throw Object.assign(new Error('Package update client disconnected'), { code: 'CANCELLED' });
      await this.processAuditStore.record({ ...audit, outcome: 'succeeded' });
      return sendJson(response, 200, {
        package_type: selected.package_type,
        package_id: selected.package_id,
        version: staged.version,
        staged: true,
        activated: false,
      });
    } catch (error) {
      await this.processAuditStore
        .record({ ...audit, outcome: 'failed', errorCode: error.code || error.name || 'PACKAGE_UPDATE_INSTALL_FAILED' })
        .catch(() => {});
      throw error;
    } finally {
      response.off('close', onClose);
      this.extensionUpdateActive = false;
    }
  }

  async #refreshExtensionRevocations(request, response) {
    const body = await readJson(request, 1024);
    if (!isExactObject(body, [])) return sendJson(response, 400, { error: 'Revocation refresh accepts an empty JSON object' });
    const config = this.installedPackages;
    if (!config?.revocationUrl || !config.revocationKeyId)
      return sendJson(response, 409, { error: 'A signed revocation feed is not configured in user settings' });
    if (
      this.mcpMutationActive ||
      this.extensionUpdateActive ||
      this.extensionFeedCheckActive ||
      this.runStartsInProgress > 0 ||
      [...this.runs.values()].some((run) => ['running', 'paused'].includes(run.status))
    )
      return sendJson(response, 409, { error: 'Stop active runs before refreshing signed revocations so their MCP tools remain stable.' });
    this.mcpMutationActive = true;
    const audit = {
      sessionId: 'api-extension-revocations',
      toolCallId: randomUUID(),
      tool: 'refresh_package_revocations',
      args: { feed_key_id: config.revocationKeyId },
      decision: 'allow',
      policySource: 'authenticated_user_api',
      approvalResult: 'user_confirmed_refresh',
    };
    const controller = new AbortController();
    const onClose = () => {
      if (!response.writableEnded)
        controller.abort(Object.assign(new Error('Revocation refresh client disconnected'), { code: 'CANCELLED' }));
    };
    response.once('close', onClose);
    try {
      await this.processAuditStore.record({ ...audit, outcome: 'started' });
      let previous = null;
      try {
        previous = await getCachedRevocations({
          installRoot: config.installRoot,
          url: config.revocationUrl,
          keyId: config.revocationKeyId,
          trustedKeys: config.trustedKeys,
          maxAgeHours: config.revocationMaxAgeHours,
        });
      } catch {}
      const statement = await refreshRevocationFeed({
        installRoot: config.installRoot,
        url: config.revocationUrl,
        keyId: config.revocationKeyId,
        trustedKeys: config.trustedKeys,
        maxAgeHours: config.revocationMaxAgeHours,
        fetchImpl: this.fetchImpl,
        signal: controller.signal,
      });
      const current = await getCachedRevocations({
        installRoot: config.installRoot,
        url: config.revocationUrl,
        keyId: config.revocationKeyId,
        trustedKeys: config.trustedKeys,
        maxAgeHours: config.revocationMaxAgeHours,
      });
      this.installedPackages.revokedKeyIds = [...new Set([...this.localPackageRevocations.revokedKeyIds, ...current.revokedKeyIds])];
      this.installedPackages.revokedPackages = [...new Set([...this.localPackageRevocations.revokedPackages, ...current.revokedPackages])];
      const changed =
        !previous ||
        !sameStrings(previous.revokedKeyIds, current.revokedKeyIds) ||
        !sameStrings(previous.revokedPackages, current.revokedPackages);
      if (changed) await this.mcpManager.reconfigure(this.config);
      await this.processAuditStore.record({ ...audit, outcome: 'succeeded' });
      return sendJson(response, 200, {
        sequence: statement.sequence,
        expires_at: statement.expires_at,
        revoked_key_count: current.revokedKeyIds.length,
        revoked_package_count: current.revokedPackages.length,
        mcp_reconfigured: changed,
      });
    } catch (error) {
      await this.processAuditStore
        .record({ ...audit, outcome: 'failed', errorCode: error.code || error.name || 'REVOCATION_REFRESH_FAILED' })
        .catch(() => {});
      throw error;
    } finally {
      response.off('close', onClose);
      this.mcpMutationActive = false;
    }
  }

  #extensionFeedConfig() {
    const trust = this.installedPackages;
    const extension = this.config.extensions || {};
    if (!trust || !Object.keys(trust.trustedKeys || {}).length || !extension.update_feed_url || !extension.update_key_id) return null;
    return {
      installRoot: trust.installRoot,
      url: extension.update_feed_url,
      keyId: extension.update_key_id,
      trustedKeys: trust.trustedKeys,
      maxAgeHours: extension.update_max_age_hours || 72,
      trust,
    };
  }

  async #readExtensionRevocations(trust) {
    const cached = await getCachedRevocations({
      installRoot: trust.installRoot,
      url: trust.revocationUrl,
      keyId: trust.revocationKeyId,
      trustedKeys: trust.trustedKeys,
      maxAgeHours: trust.revocationMaxAgeHours,
    });
    return {
      revokedKeyIds: [...new Set([...this.localPackageRevocations.revokedKeyIds, ...cached.revokedKeyIds])],
      revokedPackages: [...new Set([...this.localPackageRevocations.revokedPackages, ...cached.revokedPackages])],
    };
  }

  async #extensionActivations() {
    try {
      return await listInstalledPackageActivations(this.installedPackages);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async #extensionUpdateInventory(feed, trust) {
    const [activations, skillVersions, mcpVersions] = await Promise.all([
      this.#extensionActivations(),
      listInstalledSkillVersions(trust),
      listInstalledMcpVersions(trust),
    ]);
    const versionsByPackage = new Map();
    for (const item of [
      ...skillVersions.map((entry) => ({ ...entry, package_type: 'skill' })),
      ...mcpVersions.map((entry) => ({ ...entry, package_type: 'mcp' })),
    ])
      versionsByPackage.set(`${item.package_type}:${item.package_id}`, new Set(item.available_versions));
    return availablePackageUpdates(activations, feed, { cohortId: await getPackageUpdateCohortId(trust.installRoot) })
      .map(({ package_type, package_id, version, current_version }) => ({
        package_type,
        package_id,
        version,
        current_version,
        staged: versionsByPackage.get(`${package_type}:${package_id}`)?.has(version) === true,
      }))
      .sort((a, b) => a.package_type.localeCompare(b.package_type) || a.package_id.localeCompare(b.package_id));
  }

  async #readExtensionUpdateState() {
    const config = this.#extensionFeedConfig();
    if (!config) throw Object.assign(new Error('Package update feed is not configured'), { code: 'UPDATE_FEED_NOT_CONFIGURED' });
    const revocations = await this.#readExtensionRevocations(config.trust);
    const feed = await getCachedPackageUpdateFeed({ ...config, revokedKeyIds: revocations.revokedKeyIds });
    return { feed, updates: await this.#extensionUpdateInventory(feed, config.trust) };
  }

  async #manageSignedSkillPackage(request, response, packageId, action) {
    if (!this.installedPackages || Object.keys(this.installedPackages.trustedKeys || {}).length === 0)
      return sendJson(response, 409, {
        error: 'Signed package trust is not configured in user settings',
        code: 'PACKAGE_TRUST_NOT_CONFIGURED',
      });
    const body = await readJson(request);
    if (action === 'activate') {
      if (!isExactObject(body, ['version']) || typeof body.version !== 'string')
        return sendJson(response, 400, { error: 'Activation requires exactly one version string' });
    } else if (!isExactObject(body, [])) {
      return sendJson(response, 400, { error: `${action} request body must be an empty object` });
    }
    const audit = {
      sessionId: 'api-signed-skill-management',
      toolCallId: randomUUID(),
      tool: `${action}_signed_skill`,
      args: { package_id: packageId, ...(action === 'activate' ? { version: body.version } : {}) },
      decision: 'allow',
      policySource: 'authenticated_user_api',
      approvalResult: true,
    };
    try {
      await this.processAuditStore.record({ ...audit, outcome: 'started' });
      const result =
        action === 'activate'
          ? await activateInstalledSkill({ ...this.installedPackages, packageId, version: body.version })
          : action === 'disable'
            ? await disableInstalledSkill({ ...this.installedPackages, packageId })
            : await rollbackInstalledSkill({ ...this.installedPackages, packageId });
      await this.processAuditStore.record({ ...audit, outcome: result.changed ? 'succeeded' : 'no_op' });
      return sendJson(response, 200, { result });
    } catch (error) {
      await this.processAuditStore
        .record({
          ...audit,
          outcome: 'failed',
          errorCode: error.code || error.name || 'SKILL_MANAGEMENT_FAILED',
        })
        .catch(() => {});
      throw error;
    }
  }

  async #listSignedMcpPackages(response) {
    if (!this.installedPackages || Object.keys(this.installedPackages.trustedKeys || {}).length === 0)
      return sendJson(response, 200, { configured: false, packages: [] });
    let activations;
    try {
      activations = await listInstalledPackageActivations(this.installedPackages);
    } catch (error) {
      if (error.code === 'ENOENT') activations = [];
      else throw error;
    }
    const activationById = new Map(
      activations
        .filter((item) => item.package_type === 'mcp')
        .map(({ package_id, active_version, previous_versions }) => [package_id, { active_version, previous_versions }]),
    );
    const installedVersions = await listInstalledMcpVersions(this.installedPackages);
    const packageIds = new Set([...activationById.keys(), ...installedVersions.map((item) => item.package_id)]);
    const availableVersionsById = new Map(installedVersions.map((item) => [item.package_id, item.available_versions]));
    const configuredServers = new Map();
    const enabledConfiguredServers = new Map();
    for (const [name, settings] of Object.entries(this.config.mcp?.servers || {})) {
      if (!settings.package_id) continue;
      const names = configuredServers.get(settings.package_id) || [];
      names.push(name);
      configuredServers.set(settings.package_id, names);
      if (this.config.mcp?.enabled === true && settings.enabled === true) {
        const enabledNames = enabledConfiguredServers.get(settings.package_id) || [];
        enabledNames.push(name);
        enabledConfiguredServers.set(settings.package_id, enabledNames);
      }
    }
    const packages = [...packageIds].sort().map((package_id) => ({
      package_id,
      active_version: activationById.get(package_id)?.active_version || null,
      previous_versions: activationById.get(package_id)?.previous_versions || [],
      available_versions: availableVersionsById.get(package_id) || [],
      configured_servers: configuredServers.get(package_id) || [],
      enabled_configured_servers: enabledConfiguredServers.get(package_id) || [],
    }));
    return sendJson(response, 200, { configured: true, packages });
  }

  async #manageSignedMcpPackage(request, response, packageId, action) {
    if (!this.installedPackages || Object.keys(this.installedPackages.trustedKeys || {}).length === 0)
      return sendJson(response, 409, {
        error: 'Signed package trust is not configured in user settings',
        code: 'PACKAGE_TRUST_NOT_CONFIGURED',
      });
    const body = await readJson(request);
    if (action === 'activate') {
      if (!isExactObject(body, ['version']) || typeof body.version !== 'string')
        return sendJson(response, 400, { error: 'Activation requires exactly one version string' });
    } else if (!isExactObject(body, [])) {
      return sendJson(response, 400, { error: `${action} request body must be an empty object` });
    }
    if (
      this.mcpMutationActive ||
      this.runStartsInProgress > 0 ||
      [...this.runs.values()].some((run) => ['running', 'paused'].includes(run.status))
    )
      return sendJson(response, 409, {
        error: 'Stop active runs before changing signed MCP packages so their tools and connections remain stable.',
        code: 'MCP_RUN_ACTIVE',
      });
    this.mcpMutationActive = true;
    const audit = {
      sessionId: 'api-signed-mcp-management',
      toolCallId: randomUUID(),
      tool: `${action}_signed_mcp_package`,
      args: { package_id: packageId, ...(action === 'activate' ? { version: body.version } : {}) },
      decision: 'allow',
      policySource: 'authenticated_user_api',
      approvalResult: true,
    };
    try {
      await this.processAuditStore.record({ ...audit, outcome: 'started' });
      const result =
        action === 'activate'
          ? await activateInstalledMcpPackage({ ...this.installedPackages, packageId, version: body.version })
          : action === 'disable'
            ? await disableInstalledMcpPackage({ ...this.installedPackages, packageId })
            : await rollbackInstalledMcpPackage({ ...this.installedPackages, packageId });
      if (result.changed) await this.mcpManager.reconfigure(this.config);
      await this.processAuditStore.record({ ...audit, outcome: result.changed ? 'succeeded' : 'no_op' });
      return sendJson(response, 200, { result, servers: this.mcpManager.serverCatalog });
    } catch (error) {
      await this.processAuditStore
        .record({ ...audit, outcome: 'failed', errorCode: error.code || error.name || 'MCP_PACKAGE_MANAGEMENT_FAILED' })
        .catch(() => {});
      throw error;
    } finally {
      this.mcpMutationActive = false;
    }
  }

  async #withGlobalMemoryAccess(response, operation) {
    if (this.userDataDirectoryMutationActive)
      return sendJson(response, 409, {
        error: 'The global memory data directory is changing; retry this request shortly.',
        code: 'USER_DATA_DIRECTORY_BUSY',
      });
    this.globalMemoryRequestsActive += 1;
    try {
      return await operation();
    } finally {
      this.globalMemoryRequestsActive -= 1;
    }
  }

  async #updateRuntimeSettings(request, response) {
    const body = await readJson(request);
    const patch = validateRuntimeOverrides(body);
    if (patch.mcp) return sendJson(response, 400, { error: 'Use the MCP server management endpoint to change configured servers' });
    const targetPath = this.config._source?.runtimeOverridePath;
    if (typeof targetPath !== 'string' || !targetPath)
      return sendJson(response, 409, { error: 'This service was started without a writable user configuration path' });
    const nextUserDataDirectory = patch.app_data?.directory || defaultUserDataDirectory();
    const userDataDirectoryChanged = Boolean(patch.app_data) && !sameRuntimePath(this.userDataDirectory, nextUserDataDirectory);
    const patchedDefaultExists = patch.default_model
      ? Object.hasOwn(patch.models || {}, patch.default_model)
        ? patch.models[patch.default_model] !== null
        : Boolean(this.config.models?.[patch.default_model])
      : true;
    if (!patchedDefaultExists) return sendJson(response, 400, { error: `default_model '${patch.default_model}' is not configured` });
    const sandboxAvailable =
      process.platform === 'linux'
        ? Boolean(await findBubblewrap())
        : process.platform === 'win32'
          ? Boolean(await findWindowsSandboxHelper({ workspaceRoot: this.workspaceRoot }))
          : false;
    const sandboxCandidate = structuredClone(this.config);
    if (patch.sandbox) {
      sandboxCandidate.sandbox = { ...sandboxCandidate.sandbox, ...patch.sandbox };
      if (patch.sandbox.tools) sandboxCandidate.sandbox.tools = { ...this.config.sandbox?.tools, ...patch.sandbox.tools };
      for (const [toolName, mode] of Object.entries(patch.sandbox.tools || {}))
        if (mode === null) delete sandboxCandidate.sandbox.tools[toolName];
    }
    try {
      validateConfig(sandboxCandidate);
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
    const processIsolationRequested = [null, ...SANDBOX_PROCESS_TOOLS].some((toolName) =>
      requiresProcessIsolation(resolveSandboxMode(sandboxCandidate, toolName)),
    );
    if (patch.sandbox && processIsolationRequested && !sandboxAvailable) {
      return sendJson(response, 409, {
        error: 'Workspace process isolation is unavailable on this host; the sandbox setting was not saved.',
      });
    }
    const runtimePolicyChanged = Boolean(patch.sandbox || patch.tools?.autonomy);
    const activeRuns = [...this.runs.values()].filter((run) => ['running', 'paused'].includes(run.status));
    if (runtimePolicyChanged && (this.runtimePolicyMutationActive || this.mcpMutationActive || this.runStartsInProgress > 0))
      return sendJson(response, 409, {
        error: 'Wait for run startup or another runtime policy update to finish.',
        code: 'RUNTIME_POLICY_BUSY',
      });
    if (runtimePolicyChanged && activeRuns.some((run) => run.status !== 'paused'))
      return sendJson(response, 409, {
        error: 'Pause every active run before changing autonomy or sandbox settings.',
        code: 'RUNTIME_POLICY_REQUIRES_PAUSED_RUNS',
      });
    if (userDataDirectoryChanged) {
      if (this.userDataDirectoryMutationActive)
        return sendJson(response, 409, { error: 'A data directory update is already in progress.', code: 'USER_DATA_DIRECTORY_BUSY' });
      if (
        this.runStartsInProgress > 0 ||
        [...this.runs.values()].some((run) => ['running', 'paused'].includes(run.status)) ||
        this.globalMemoryRequestsActive > 0
      )
        return sendJson(response, 409, {
          error: 'Stop active runs and finish global memory requests before changing the data directory.',
          code: 'USER_DATA_DIRECTORY_BUSY',
        });
      this.userDataDirectoryMutationActive = true;
    }
    if (runtimePolicyChanged) this.runtimePolicyMutationActive = true;
    const audit = {
      sessionId: 'api-runtime-settings',
      toolCallId: randomUUID(),
      tool: 'update_runtime_settings',
      args: patch,
      decision: 'allow',
      policySource: 'authenticated_user_api',
      approvalResult: true,
    };
    try {
      await this.processAuditStore.record({ ...audit, outcome: 'started' });
      const candidate = structuredClone(this.config);
      applyRuntimeOverrides(candidate, patch);
      validateConfig(candidate);
      const dataMigration = userDataDirectoryChanged
        ? await new GlobalMemoryStore(this.userDataDirectory).migrateTo(nextUserDataDirectory)
        : null;
      await updateRuntimeOverrides(targetPath, patch);
      const nextConfig = await loadConfig({
        configPath: this.config._source.userPath,
        projectPath: this.config._source.projectPath || undefined,
      });
      this.config = nextConfig;
      this.userDataDirectory = nextConfig.app_data?.directory || defaultUserDataDirectory();
      this.globalMemoryStore = nextConfig.memory?.global_enabled === true ? new GlobalMemoryStore(this.userDataDirectory) : null;
      this.processManager.config = nextConfig;
      if (patch.sandbox) await this.mcpManager.reconfigure(nextConfig);
      if (runtimePolicyChanged) {
        const updatedAt = new Date().toISOString();
        const runtimePolicy = {
          tools: { autonomy: nextConfig.tools?.autonomy === 'unrestricted' ? 'unrestricted' : 'assisted' },
          sandbox: structuredClone(nextConfig.sandbox || {}),
        };
        for (const run of activeRuns) {
          run.pendingRuntimePolicyChange = runtimePolicy;
          this.#publish(run, {
            type: 'run_runtime_policy_queued',
            run_id: run.id,
            autonomy: runtimePolicy.tools.autonomy,
            updated_at: updatedAt,
          });
        }
      }
      await this.processAuditStore.record({ ...audit, outcome: 'succeeded' });
      return sendJson(response, 200, {
        settings: publicSettings(this.config),
        updated: Object.keys(patch),
        persisted: true,
        ...(dataMigration ? { data_migration: { global_memory: dataMigration } } : {}),
      });
    } catch (error) {
      await this.processAuditStore
        .record({ ...audit, outcome: 'failed', errorCode: error.code || error.name || 'SETTINGS_UPDATE_FAILED' })
        .catch(() => {});
      throw error;
    } finally {
      if (userDataDirectoryChanged) this.userDataDirectoryMutationActive = false;
      if (runtimePolicyChanged) this.runtimePolicyMutationActive = false;
    }
  }

  async #manageMcpServer(request, response, name) {
    const current = this.config.mcp?.servers?.[name];
    if (!current) return sendJson(response, 404, { error: `MCP server '${name}' is not configured`, code: 'MCP_SERVER_NOT_FOUND' });
    let serverOverride;
    if (request.method === 'DELETE') {
      const body = await readJson(request, 1024);
      if (!isExactObject(body, [])) return sendJson(response, 400, { error: 'MCP server removal accepts an empty JSON object' });
      serverOverride = null;
    } else {
      const body = await readJson(request, 1024);
      const allowed = ['enabled', 'transport', 'command', 'package_id', 'args', 'cwd', 'timeout_ms', 'env', 'url', 'headers'];
      if (!isExactObject(body, allowed) || !Object.keys(body).length)
        return sendJson(response, 400, { error: 'MCP server update must contain only supported connection settings' });
      if (body.enabled === true && this.config.mcp?.enabled !== true)
        return sendJson(response, 409, { error: 'MCP is disabled globally in user configuration', code: 'MCP_DISABLED' });
      serverOverride = body;
    }
    return this.#persistMcpServer(response, name, serverOverride, request.method === 'DELETE' ? 'remove' : 'update');
  }

  async #addMcpServer(request, response) {
    const body = await readJson(request, 32 * 1024);
    if (
      !isExactObject(body, ['name', 'config']) ||
      !/^[a-z][a-z0-9_-]{0,31}$/.test(body.name) ||
      !isExactObject(body.config, ['enabled', 'transport', 'command', 'package_id', 'args', 'cwd', 'timeout_ms', 'env', 'url', 'headers'])
    )
      return sendJson(response, 400, { error: 'MCP server creation requires a valid name and supported config object' });
    if (this.config.mcp?.enabled !== true)
      return sendJson(response, 409, { error: 'MCP is disabled globally in user configuration', code: 'MCP_DISABLED' });
    if (this.config.mcp?.servers?.[body.name])
      return sendJson(response, 409, { error: `MCP server '${body.name}' already exists`, code: 'MCP_SERVER_EXISTS' });
    const server = { enabled: true, ...body.config };
    return this.#persistMcpServer(response, body.name, server, 'add');
  }

  #getMcpServerConfig(response, name) {
    const config = this.config.mcp?.servers?.[name];
    if (!config) return sendJson(response, 404, { error: `MCP server '${name}' is not configured`, code: 'MCP_SERVER_NOT_FOUND' });
    return sendJson(response, 200, { name, config: structuredClone(config) });
  }

  async #persistMcpServer(response, name, serverOverride, action) {
    const patch = validateRuntimeOverrides({ mcp: { servers: { [name]: serverOverride } } });
    const targetPath = this.config._source?.runtimeOverridePath;
    if (typeof targetPath !== 'string' || !targetPath)
      return sendJson(response, 409, { error: 'This service was started without a writable user configuration path' });
    if (
      this.mcpMutationActive ||
      this.runStartsInProgress > 0 ||
      [...this.runs.values()].some((run) => ['running', 'paused'].includes(run.status))
    )
      return sendJson(response, 409, {
        error: 'Stop active runs before changing MCP servers so their tools and connections remain stable.',
        code: 'MCP_RUN_ACTIVE',
      });
    this.mcpMutationActive = true;
    const audit = {
      sessionId: 'api-mcp-server-management',
      toolCallId: randomUUID(),
      tool: 'manage_mcp_server',
      args: { server: name, action },
      decision: 'allow',
      policySource: 'authenticated_user_api',
      approvalResult: true,
    };
    try {
      await this.processAuditStore.record({ ...audit, outcome: 'started' });
      const candidate = structuredClone(this.config);
      applyRuntimeOverrides(candidate, patch);
      validateConfig(candidate);
      await updateRuntimeOverrides(targetPath, patch);
      const nextConfig = await loadConfig({
        configPath: this.config._source.userPath,
        projectPath: this.config._source.projectPath || undefined,
      });
      this.config = nextConfig;
      this.processManager.config = nextConfig;
      await this.mcpManager.reconfigure(nextConfig);
      await this.processAuditStore.record({ ...audit, outcome: 'succeeded' });
      return sendJson(response, 200, { servers: this.mcpManager.serverCatalog, persisted: true });
    } catch (error) {
      await this.processAuditStore
        .record({ ...audit, outcome: 'failed', errorCode: error.code || error.name || 'MCP_SERVER_UPDATE_FAILED' })
        .catch(() => {});
      throw error;
    } finally {
      this.mcpMutationActive = false;
    }
  }

  async #testMcpServer(request, response, name) {
    const body = await readJson(request, 1024);
    if (!isExactObject(body, [])) return sendJson(response, 400, { error: 'MCP connection test accepts an empty JSON object' });
    const settings = this.config.mcp?.servers?.[name];
    if (!settings) return sendJson(response, 404, { error: `MCP server '${name}' is not configured`, code: 'MCP_SERVER_NOT_FOUND' });
    if (this.config.mcp?.enabled !== true)
      return sendJson(response, 409, { error: 'MCP is disabled globally in user configuration', code: 'MCP_DISABLED' });
    if (
      this.mcpMutationActive ||
      this.runStartsInProgress > 0 ||
      [...this.runs.values()].some((run) => ['running', 'paused'].includes(run.status))
    )
      return sendJson(response, 409, { error: 'Stop active runs before testing MCP servers.', code: 'MCP_RUN_ACTIVE' });
    const testConfig = structuredClone(this.config);
    testConfig.mcp.servers = { [name]: { ...settings, enabled: true } };
    try {
      validateConfig(testConfig);
    } catch (error) {
      return sendJson(response, 400, { error: error.message, code: 'MCP_CONFIGURATION_INVALID' });
    }
    this.mcpMutationActive = true;
    const audit = {
      sessionId: 'api-mcp-server-management',
      toolCallId: randomUUID(),
      tool: 'test_mcp_server',
      args: { server: name },
      decision: 'allow',
      policySource: 'authenticated_user_api',
      approvalResult: 'user_initiated_connection_test',
    };
    const manager = new StdioMcpManager({
      config: testConfig,
      workspaceRoot: this.workspaceRoot,
      secretStore: this.secretStore,
      installedPackages: this.installedPackages,
    });
    try {
      await this.processAuditStore.record({ ...audit, outcome: 'started' });
      await manager.initialize();
      const serverState = manager.serverCatalog[0] || null;
      const result = {
        success: serverState?.connection_state === 'connected',
        connection_state: serverState?.connection_state || 'disconnected',
        error_code: serverState?.error_code || null,
        tools: serverState?.tools || [],
      };
      await this.processAuditStore.record({
        ...audit,
        outcome: result.success ? 'succeeded' : 'failed',
        errorCode: result.error_code,
      });
      await manager.close();
      this.mcpMutationActive = false;
      return sendJson(response, 200, { result });
    } catch (error) {
      await this.processAuditStore
        .record({ ...audit, outcome: 'failed', errorCode: error.code || error.name || 'MCP_TEST_FAILED' })
        .catch(() => {});
      throw error;
    } finally {
      await manager.close();
      this.mcpMutationActive = false;
    }
  }

  async #listMcpAudit(response, url) {
    const keys = [...url.searchParams.keys()];
    if (keys.some((key) => key !== 'limit') || url.searchParams.getAll('limit').length > 1)
      return sendJson(response, 400, { error: 'MCP audit history accepts only one limit parameter' });
    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit === null ? 100 : /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      return sendJson(response, 400, { error: 'limit must be an integer from 1 to 200' });
    const history = await this.processAuditStore.listMcpHistory({ limit });
    return sendJson(response, 200, history);
  }

  async #checkApplicationUpdates(request, response) {
    const body = await readJson(request, 1024);
    if (!isExactObject(body, [])) return sendJson(response, 400, { error: 'Application update check accepts an empty JSON object' });
    const settings = this.config.app_updates || {};
    const audit = {
      sessionId: 'api-application-updates',
      toolCallId: randomUUID(),
      tool: 'check_application_updates',
      args: { mode: settings.mode || 'disabled', channel: settings.channel || 'stable' },
      decision: 'allow',
      policySource: 'authenticated_user_api',
      approvalResult: 'user_initiated_check',
    };
    await this.processAuditStore.record({ ...audit, outcome: 'started' });
    const controller = new AbortController();
    const onClose = () => {
      if (!response.writableEnded) controller.abort(Object.assign(new Error('Update check client disconnected'), { code: 'CANCELLED' }));
    };
    response.once('close', onClose);
    try {
      const result = await checkApplicationUpdates({
        settings,
        fetchImpl: this.fetchImpl,
        signal: controller.signal,
        sessionId: audit.toolCallId,
        cacheDirectory: this.config._source?.runtimeOverridePath ? path.dirname(this.config._source.runtimeOverridePath) : undefined,
      });
      await this.processAuditStore.record({ ...audit, outcome: 'succeeded' });
      return sendJson(response, 200, result);
    } catch (error) {
      await this.processAuditStore
        .record({ ...audit, outcome: 'failed', errorCode: error.code || error.name || 'APP_UPDATE_CHECK_FAILED' })
        .catch(() => {});
      throw error;
    } finally {
      response.off('close', onClose);
    }
  }

  async #prepareApplicationUpdateDownload(request, response) {
    const body = await readJson(request, 1024);
    if (!isExactObject(body, ['version', 'sequence']) || Object.keys(body).length !== 2)
      return sendJson(response, 400, { error: 'Application update download requires one version and sequence' });
    if (this.applicationUpdateDownloadActive)
      return sendJson(response, 409, { error: 'Another application update download is already being prepared' });
    this.applicationUpdateDownloadActive = true;
    const settings = this.config.app_updates || {};
    const audit = {
      sessionId: 'api-application-updates',
      toolCallId: randomUUID(),
      tool: 'download_application_update',
      args: { version: body.version, sequence: body.sequence },
      decision: 'allow',
      policySource: 'authenticated_user_api',
      approvalResult: 'user_initiated_download',
    };
    const controller = new AbortController();
    const onClose = () => {
      if (!response.writableEnded) controller.abort(Object.assign(new Error('Update download client disconnected'), { code: 'CANCELLED' }));
    };
    response.once('close', onClose);
    this.applicationUpdateDownloadController = controller;
    let staged;
    try {
      await this.processAuditStore.record({ ...audit, outcome: 'started' });
      for (const [token, entry] of this.stagedApplicationUpdates) {
        this.stagedApplicationUpdates.delete(token);
        clearTimeout(entry.expiryTimer);
        await fs.rm(entry.path, { force: true }).catch(() => {});
      }
      const stagingDirectory = await this.#getApplicationUpdateStagingDirectory();
      staged = await downloadApplicationUpdate({
        settings,
        version: body.version,
        sequence: body.sequence,
        fetchImpl: this.fetchImpl,
        cacheDirectory: this.config._source?.runtimeOverridePath ? path.dirname(this.config._source.runtimeOverridePath) : undefined,
        stagingDirectory,
        signal: controller.signal,
      });
      if (controller.signal.aborted || response.destroyed)
        throw Object.assign(new Error('Update download client disconnected'), { code: 'CANCELLED' });
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + this.appUpdateDownloadTtlMs).toISOString();
      const entry = { ...staged, expiresAt, expiryTimer: null };
      entry.expiryTimer = setTimeout(() => {
        if (this.stagedApplicationUpdates.get(token) !== entry) return;
        this.stagedApplicationUpdates.delete(token);
        void fs.rm(entry.path, { force: true }).catch(() => {});
      }, this.appUpdateDownloadTtlMs);
      entry.expiryTimer.unref?.();
      this.stagedApplicationUpdates.set(token, entry);
      await this.processAuditStore.record({ ...audit, outcome: 'succeeded' });
      return sendJson(response, 200, {
        download_path: `/v1/app-updates/downloads/${token}`,
        filename: staged.filename,
        size_bytes: staged.size_bytes,
        sha256: staged.sha256,
        expires_at: expiresAt,
      });
    } catch (error) {
      if (staged) await fs.rm(staged.path, { force: true }).catch(() => {});
      await this.processAuditStore
        .record({ ...audit, outcome: 'failed', errorCode: error.code || error.name || 'APP_UPDATE_DOWNLOAD_FAILED' })
        .catch(() => {});
      throw error;
    } finally {
      response.off('close', onClose);
      if (this.applicationUpdateDownloadController === controller) this.applicationUpdateDownloadController = null;
      this.applicationUpdateDownloadActive = false;
    }
  }

  async #getApplicationUpdateStagingDirectory() {
    if (!this.applicationUpdateStagingDirectory)
      this.applicationUpdateStagingDirectory = await fs.mkdtemp(path.join(tmpdir(), 'xyst-app-update-'));
    return this.applicationUpdateStagingDirectory;
  }

  async #serveApplicationUpdateDownload(response, token) {
    const entry = this.stagedApplicationUpdates.get(token);
    if (!entry) return sendJson(response, 404, { error: 'Update download link is unavailable or has already been used' });
    this.stagedApplicationUpdates.delete(token);
    clearTimeout(entry.expiryTimer);
    const audit = {
      sessionId: 'api-application-updates',
      toolCallId: randomUUID(),
      tool: 'serve_verified_application_update',
      args: { filename: entry.filename, size_bytes: entry.size_bytes, sha256: entry.sha256 },
      decision: 'allow',
      policySource: 'single_use_local_download_link',
      approvalResult: true,
    };
    let handle;
    let outcome = 'failed';
    try {
      if (Date.parse(entry.expiresAt) <= Date.now())
        return sendJson(response, 404, { error: 'Update download link has expired; prepare the download again' });
      await this.processAuditStore.record({ ...audit, outcome: 'started' });
      const beforeOpen = await fs.lstat(entry.path);
      if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile() || beforeOpen.nlink !== 1 || beforeOpen.size !== entry.size_bytes)
        throw Object.assign(new Error('Verified update artifact is no longer available'), { code: 'APP_UPDATE_STAGING_INVALID' });
      handle = await fs.open(entry.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        opened.size !== entry.size_bytes ||
        opened.dev !== entry.dev ||
        opened.ino !== entry.ino
      )
        throw Object.assign(new Error('Verified update artifact changed before download'), { code: 'APP_UPDATE_STAGING_INVALID' });
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(entry.size_bytes),
        'Content-Disposition': `attachment; filename="${entry.filename}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      await pipeline(handle.createReadStream({ autoClose: false }), response);
      outcome = 'succeeded';
      return response;
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return response;
      }
      throw error;
    } finally {
      await handle?.close().catch(() => {});
      await fs.rm(entry.path, { force: true }).catch(() => {});
      await this.processAuditStore.record({ ...audit, outcome }).catch(() => {});
    }
  }

  async #updateSecret(request, response, encodedKey) {
    let key;
    try {
      key = decodeURIComponent(encodedKey);
    } catch {
      return sendJson(response, 400, { error: 'Credential key is invalid' });
    }
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(key)) return sendJson(response, 400, { error: 'Credential key is invalid' });
    let body;
    if (request.method === 'PUT') {
      try {
        body = await readJson(request, 70_000);
      } catch (error) {
        return sendJson(response, error.statusCode === 413 ? 413 : error.statusCode === 415 ? 415 : 400, {
          error: 'Credential request body is invalid',
        });
      }
      if (!body || Object.keys(body).length !== 1 || typeof body.value !== 'string' || !body.value)
        return sendJson(response, 400, { error: 'Credential value must be a non-empty string' });
    }
    const audit = {
      sessionId: 'api-secret-vault',
      toolCallId: randomUUID(),
      tool: request.method === 'PUT' ? 'store_credential' : 'delete_credential',
      args: { key },
      decision: 'allow',
      policySource: 'authenticated_user_api',
      approvalResult: true,
    };
    await this.processAuditStore.record({ ...audit, outcome: 'started' });
    try {
      if (request.method === 'PUT') {
        await this.secretStore.set(key, body.value);
        await this.processAuditStore.record({ ...audit, outcome: 'succeeded' });
        return sendJson(response, 200, { stored: true });
      }
      const deleted = await this.secretStore.delete(key);
      await this.processAuditStore.record({ ...audit, outcome: 'succeeded' });
      return sendJson(response, 200, { deleted });
    } catch (error) {
      await this.processAuditStore
        .record({ ...audit, outcome: 'failed', errorCode: error.code || error.name || 'CREDENTIAL_OPERATION_FAILED' })
        .catch(() => {});
      return sendJson(response, 503, { error: 'Credential vault operation failed; verify OS credential-vault availability.' });
    }
  }

  async #serveGui(response, pathname, headOnly) {
    const assets = new Map([
      ['/app/app.mjs', [path.join(GUI_ROOT, 'app.mjs'), 'text/javascript; charset=utf-8']],
      ['/app/timeline.mjs', [path.join(GUI_ROOT, 'timeline.mjs'), 'text/javascript; charset=utf-8']],
      ['/app/run-inspector.mjs', [path.join(GUI_ROOT, 'run-inspector.mjs'), 'text/javascript; charset=utf-8']],
      ['/app/review-plan.mjs', [path.join(GUI_ROOT, 'review-plan.mjs'), 'text/javascript; charset=utf-8']],
      ['/app/workspace-panel.mjs', [path.join(GUI_ROOT, 'workspace-panel.mjs'), 'text/javascript; charset=utf-8']],
      ['/app/project-manager.mjs', [path.join(GUI_ROOT, 'project-manager.mjs'), 'text/javascript; charset=utf-8']],
      ['/app/onboarding.mjs', [path.join(GUI_ROOT, 'onboarding.mjs'), 'text/javascript; charset=utf-8']],
      ['/app/session-status.mjs', [path.join(GUI_ROOT, 'session-status.mjs'), 'text/javascript; charset=utf-8']],
      ['/app/web-search-settings.mjs', [path.join(GUI_ROOT, 'web-search-settings.mjs'), 'text/javascript; charset=utf-8']],
      ['/app/model-pricing.mjs', [path.join(GUI_ROOT, 'model-pricing.mjs'), 'text/javascript; charset=utf-8']],
      ['/app/startup.mjs', [path.join(GUI_ROOT, 'startup.mjs'), 'text/javascript; charset=utf-8']],
      ['/app/chat-scroll.mjs', [path.join(GUI_ROOT, 'chat-scroll.mjs'), 'text/javascript; charset=utf-8']],
      ['/app/chat-view.mjs', [path.join(GUI_ROOT, 'chat-view.mjs'), 'text/javascript; charset=utf-8']],
      ['/app/startup-watchdog.mjs', [path.join(GUI_ROOT, 'startup-watchdog.mjs'), 'text/javascript; charset=utf-8']],
      ['/app/run-request.mjs', [path.join(GUI_ROOT, '..', 'src', 'api', 'run-request.mjs'), 'text/javascript; charset=utf-8']],
      ['/app/run-events.mjs', [path.join(GUI_ROOT, '..', 'src', 'api', 'run-events.mjs'), 'text/javascript; charset=utf-8']],
      ['/src/core/model-pricing.mjs', [path.join(GUI_ROOT, '..', 'src', 'core', 'model-pricing.mjs'), 'text/javascript; charset=utf-8']],
      ['/src/core/keybindings.mjs', [path.join(GUI_ROOT, '..', 'src', 'core', 'keybindings.mjs'), 'text/javascript; charset=utf-8']],
      ['/src/core/model-metadata.mjs', [path.join(GUI_ROOT, '..', 'src', 'core', 'model-metadata.mjs'), 'text/javascript; charset=utf-8']],
      ['/src/core/redaction.mjs', [path.join(GUI_ROOT, '..', 'src', 'core', 'redaction.mjs'), 'text/javascript; charset=utf-8']],
      ['/src/core/model-fallback.mjs', [path.join(GUI_ROOT, '..', 'src', 'core', 'model-fallback.mjs'), 'text/javascript; charset=utf-8']],
      ['/core/statuses.mjs', [path.join(GUI_ROOT, '..', 'src', 'core', 'statuses.mjs'), 'text/javascript; charset=utf-8']],
      ['/core/budgets.mjs', [path.join(GUI_ROOT, '..', 'src', 'core', 'budgets.mjs'), 'text/javascript; charset=utf-8']],
      ['/core/limits.mjs', [path.join(GUI_ROOT, '..', 'src', 'core', 'limits.mjs'), 'text/javascript; charset=utf-8']],
      ['/app/api-client.mjs', [path.join(GUI_ROOT, '..', 'src', 'api', 'client.mjs'), 'text/javascript; charset=utf-8']],
      ['/app/brand-icon.png', [path.join(GUI_ROOT, 'assets', 'brand-icon.png'), 'image/png']],
      ['/app/styles.css', [path.join(GUI_ROOT, 'styles.css'), 'text/css; charset=utf-8']],
    ]);
    const isIndex = pathname === '/app' || pathname === '/app/';
    const asset = assets.get(pathname);
    if (!isIndex && !asset) return sendJson(response, 404, { error: 'App resource not found' });
    let body = await fs.readFile(isIndex ? path.join(GUI_ROOT, 'index.html') : asset[0]);
    if (isIndex) body = Buffer.from(body.toString('utf8').replace('__XYST_TOKEN__', escapeHtml(this.token)));
    const contentType = isIndex ? 'text/html; charset=utf-8' : asset[1];
    const headers = {
      'Content-Type': contentType,
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
      'X-Frame-Options': 'DENY',
    };
    response.writeHead(200, headers);
    return response.end(headOnly ? undefined : body);
  }

  async #memorySummary(response, store = this.memoryStore, scope = 'project') {
    if (!store) return sendJson(response, 409, { error: 'Global memory is disabled in user settings', code: 'GLOBAL_MEMORY_DISABLED' });
    const memory = await store.read();
    const counts = Object.fromEntries(MEMORY_SECTIONS.map((section) => [section, memory.sections[section].length]));
    return sendJson(response, 200, { scope, schema_version: memory.schema_version, updated_at: memory.updated_at, counts });
  }

  async #searchMemory(response, url, store = this.memoryStore) {
    if (!store) return sendJson(response, 409, { error: 'Global memory is disabled in user settings', code: 'GLOBAL_MEMORY_DISABLED' });
    const query = url.searchParams.get('q');
    const requestedSection = url.searchParams.get('section');
    if (typeof query !== 'string' || !query.trim() || query.length > 512) throw new TypeError('q must contain 1 to 512 characters');
    if (requestedSection && !MEMORY_SECTIONS.includes(requestedSection)) throw new TypeError('section must be a known memory section');
    const { offset, limit } = parsePage(url.searchParams);
    const needle = query.trim().toLocaleLowerCase();
    const memory = await store.read();
    const matches = [];
    for (const section of requestedSection ? [requestedSection] : MEMORY_SECTIONS) {
      for (const item of memory.sections[section]) {
        if (item.text.toLocaleLowerCase().includes(needle)) matches.push({ ...item, section });
      }
    }
    matches.sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
    return sendJson(response, 200, {
      query: query.trim(),
      offset,
      limit,
      total: matches.length,
      items: matches.slice(offset, offset + limit),
    });
  }

  async #createApprovalRule(request, response) {
    const body = await readJson(request);
    const allowed = ['tool', 'scope', 'pattern', 'decision', 'duration_ms'];
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key))) {
      return sendJson(response, 400, { error: 'Rule body contains unsupported fields' });
    }
    const needsPattern = body.scope !== 'tool';
    if (
      typeof body.tool !== 'string' ||
      typeof body.scope !== 'string' ||
      !['tool', 'path_glob', 'command_glob'].includes(body.scope) ||
      typeof body.decision !== 'string' ||
      !['allow', 'deny'].includes(body.decision) ||
      !Number.isInteger(body.duration_ms) ||
      body.duration_ms < MIN_APPROVAL_RULE_MS ||
      body.duration_ms > MAX_APPROVAL_RULE_MS ||
      (needsPattern ? typeof body.pattern !== 'string' : body.pattern !== undefined)
    ) {
      return sendJson(response, 400, {
        error: `Rule requires a supported tool, scope, allow/deny decision, duration_ms between ${MIN_APPROVAL_RULE_MS} and ${MAX_APPROVAL_RULE_MS}, and a pattern for path/command scopes`,
      });
    }
    const rule = await this.approvalRuleStore.add({
      tool: body.tool,
      scope: body.scope,
      pattern: body.pattern,
      decision: body.decision,
      durationMs: body.duration_ms,
    });
    this.#publishApprovalRuleChange('added', rule);
    return sendJson(response, 201, { rule });
  }

  async #revokeApprovalRule(response, id) {
    const existing = (await this.approvalRuleStore.list()).find((rule) => rule.id === id);
    const revoked = await this.approvalRuleStore.revoke(id);
    if (revoked && existing) this.#publishApprovalRuleChange('revoked', existing);
    return revoked
      ? sendJson(response, 200, { revoked: true, rule_id: id })
      : sendJson(response, 404, { error: 'Approval rule not found' });
  }

  #publishApprovalRuleChange(action, rule) {
    for (const run of this.runs.values()) {
      if (!['running', 'paused'].includes(run.status)) continue;
      this.#publish(run, {
        type: 'run_policy_changed',
        policy: 'approval_rules',
        action,
        rule_id: rule.id,
        tool: rule.tool,
        scope: rule.scope,
        decision: rule.decision,
        expires_at: rule.expires_at,
      });
    }
  }

  async #activeSession(response, id) {
    if (this.activeSessions.has(id)) {
      sendJson(response, 409, { error: 'Session has an active run' });
      return true;
    }
    return false;
  }

  async #renameSession(request, response, id) {
    const body = await readJson(request);
    if (!isExactObject(body, ['title']) || typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200) {
      return sendJson(response, 400, { error: 'Body must contain a title of 1 to 200 characters' });
    }
    if (await this.#activeSession(response, id)) return;
    return sendJson(response, 200, await this.sessionStore.rename(id, body.title));
  }

  async #updateSessionPlan(request, response, id) {
    const body = await readJson(request);
    if (!isExactObject(body, ['plan']) || !(body.plan === null || typeof body.plan === 'string'))
      return sendJson(response, 400, { error: 'Body must contain a plan string or null' });
    if (typeof body.plan === 'string' && body.plan.length > MAX_SESSION_PLAN_CHARS)
      return sendJson(response, 400, { error: `Plan cannot exceed ${MAX_SESSION_PLAN_CHARS} characters` });
    if (await this.#activeSession(response, id)) return;
    return sendJson(response, 200, await this.sessionStore.updatePlan(id, body.plan));
  }

  async #updateSessionGoals(request, response, id) {
    const body = await readJson(request);
    if (
      !isExactObject(body, ['goal_ids']) ||
      !Array.isArray(body.goal_ids) ||
      body.goal_ids.length > 500 ||
      body.goal_ids.some(
        (goalId) =>
          typeof goalId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(goalId),
      ) ||
      new Set(body.goal_ids).size !== body.goal_ids.length
    ) {
      return sendJson(response, 400, { error: 'Body must contain up to 500 unique valid goal IDs' });
    }
    if (await this.#activeSession(response, id)) return;
    return sendJson(response, 200, await this.sessionStore.setPersistentGoals(id, body.goal_ids));
  }

  async #archiveSession(response, id) {
    if (await this.#activeSession(response, id)) return;
    return sendJson(response, 200, await this.sessionStore.archive(id));
  }

  async #deleteSession(response, id) {
    if (await this.#activeSession(response, id)) return;
    await this.sessionStore.delete(id);
    return sendJson(response, 200, { deleted: true, id });
  }

  async #revokeSessionGrant(response, sessionId, grantId) {
    if (await this.#activeSession(response, sessionId)) return;
    const grants = await this.sessionStore.listPermissionGrants(sessionId);
    const grant = grants.find((item) => item.id === grantId);
    if (!grant) return sendJson(response, 404, { error: 'Permission grant not found' });
    const revoked = await this.sessionStore.revokePermissionGrant(sessionId, grantId);
    if (!revoked) return sendJson(response, 404, { error: 'Permission grant not found' });
    return sendJson(response, 200, { revoked: true, grant_id: grantId });
  }

  async #listMemory(response, section, url, store = this.memoryStore) {
    if (!store) return sendJson(response, 409, { error: 'Global memory is disabled in user settings', code: 'GLOBAL_MEMORY_DISABLED' });
    if (!MEMORY_SECTIONS.includes(section)) return sendJson(response, 404, { error: 'Memory section not found' });
    const { offset, limit } = parsePage(url.searchParams);
    const memory = await store.read();
    const items = memory.sections[section];
    return sendJson(response, 200, {
      section,
      items: items.slice(offset, offset + limit),
      offset,
      limit,
      total: items.length,
      updated_at: memory.updated_at,
    });
  }

  async #addMemory(request, response, store = this.memoryStore) {
    if (!store) return sendJson(response, 409, { error: 'Global memory is disabled in user settings', code: 'GLOBAL_MEMORY_DISABLED' });
    const body = await readJson(request);
    if (
      !isExactObject(body, ['section', 'text']) ||
      !MEMORY_SECTIONS.includes(body.section) ||
      typeof body.text !== 'string' ||
      !body.text.trim() ||
      body.text.length > 10_000
    ) {
      return sendJson(response, 400, { error: 'Body must contain a known section and text of 1 to 10000 characters' });
    }
    return sendJson(response, 201, { item: await store.append(body.section, body.text, { source: 'user' }) });
  }

  async #updateMemory(request, response, section, id, store = this.memoryStore) {
    if (!store) return sendJson(response, 409, { error: 'Global memory is disabled in user settings', code: 'GLOBAL_MEMORY_DISABLED' });
    const body = await readJson(request);
    if (!isExactObject(body, ['text']) || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 10_000) {
      return sendJson(response, 400, { error: 'Body must contain text of 1 to 10000 characters' });
    }
    return sendJson(response, 200, { item: await store.update(section, id, body.text) });
  }

  async #deleteMemory(response, section, id, store = this.memoryStore) {
    if (!store) return sendJson(response, 409, { error: 'Global memory is disabled in user settings', code: 'GLOBAL_MEMORY_DISABLED' });
    if (!MEMORY_SECTIONS.includes(section)) return sendJson(response, 404, { error: 'Memory section not found' });
    const deleted = await store.delete(section, id);
    return deleted ? sendJson(response, 200, { deleted: true, id }) : sendJson(response, 404, { error: 'Memory item not found' });
  }

  async #listGoals(response, url) {
    const rawCompleted = url.searchParams.get('include_completed');
    if (rawCompleted !== null && rawCompleted !== 'true' && rawCompleted !== 'false')
      return sendJson(response, 400, { error: 'include_completed must be true or false' });
    const goals = await this.goalStore.list({ includeCompleted: rawCompleted !== 'false' });
    return sendJson(response, 200, { goals: goals.slice(0, 500), truncated: goals.length > 500 });
  }

  async #addGoal(request, response) {
    const body = await readJson(request);
    if (
      !isExactObject(body, ['title', 'details']) ||
      typeof body.title !== 'string' ||
      !body.title.trim() ||
      body.title.length > 500 ||
      (body.details !== undefined && (typeof body.details !== 'string' || body.details.length > 10_000))
    ) {
      return sendJson(response, 400, {
        error: 'Body must contain a title of 1 to 500 characters and optional details up to 10000 characters',
      });
    }
    return sendJson(response, 201, { goal: await this.goalStore.add(body.title, body.details || '') });
  }

  async #setGoalStatus(request, response, id) {
    const body = await readJson(request);
    if (!isExactObject(body, ['status']) || !['active', 'completed'].includes(body.status))
      return sendJson(response, 400, { error: 'Body status must be active or completed' });
    return sendJson(response, 200, { goal: await this.goalStore.setStatus(id, body.status) });
  }

  async #addGoalProgress(request, response, id) {
    const body = await readJson(request);
    if (
      !isExactObject(body, ['text', 'reference']) ||
      typeof body.text !== 'string' ||
      !body.text.trim() ||
      body.text.length > 2_000 ||
      (body.reference !== undefined && (typeof body.reference !== 'string' || body.reference.length > 1_000))
    ) {
      return sendJson(response, 400, {
        error: 'Body must contain progress text of 1 to 2000 characters and an optional reference up to 1000 characters',
      });
    }
    return sendJson(response, 201, { goal: await this.goalStore.addProgress(id, body.text, body.reference || '') });
  }

  async #updateGoalProgress(request, response, id, progressId) {
    const body = await readJson(request);
    if (
      !isExactObject(body, ['text', 'reference']) ||
      typeof body.text !== 'string' ||
      !body.text.trim() ||
      body.text.length > 2_000 ||
      (body.reference !== undefined && (typeof body.reference !== 'string' || body.reference.length > 1_000))
    ) {
      return sendJson(response, 400, {
        error: 'Body must contain progress text of 1 to 2000 characters and an optional reference up to 1000 characters',
      });
    }
    return sendJson(response, 200, {
      goal: await this.goalStore.updateProgress(id, progressId, body.text, body.reference),
    });
  }

  async #deleteGoalProgress(response, id, progressId) {
    const deleted = await this.goalStore.deleteProgress(id, progressId);
    return deleted
      ? sendJson(response, 200, { deleted: true, goal_id: id, progress_id: progressId })
      : sendJson(response, 404, { error: 'Goal progress entry not found' });
  }

  async #deleteGoal(response, id) {
    const deleted = await this.goalStore.delete(id);
    return deleted ? sendJson(response, 200, { deleted: true, id }) : sendJson(response, 404, { error: 'Goal not found' });
  }

  async #createWorktree(request, response) {
    const body = await readJson(request);
    if (!isExactObject(body, ['branch']) || typeof body.branch !== 'string')
      return sendJson(response, 400, { error: 'Body must contain only a branch string' });
    return sendJson(response, 201, { worktree: await createWorktree(this.workspaceRoot, body.branch) });
  }

  async #semanticSearch(request, response) {
    if (!this.semanticIndex) return sendJson(response, 409, { error: 'Semantic retrieval is disabled in configuration' });
    const body = await readJson(request);
    if (
      !isExactObject(body, ['query', 'path_glob', 'max_results', 'approved']) ||
      typeof body.query !== 'string' ||
      !body.query.trim() ||
      body.query.length > 2_000 ||
      (body.path_glob !== undefined && (typeof body.path_glob !== 'string' || !body.path_glob.trim() || body.path_glob.length > 256)) ||
      (body.max_results !== undefined && (!Number.isInteger(body.max_results) || body.max_results < 1 || body.max_results > 50)) ||
      typeof body.approved !== 'boolean'
    ) {
      return sendJson(response, 400, {
        error: 'Body must contain a 1-2000 character query, optional path_glob and max_results, and an approved boolean',
      });
    }
    if (!body.approved)
      return sendJson(response, 403, {
        error:
          'Semantic search requires explicit approval to send redacted workspace text and the query to the configured embedding service',
      });
    const audit = {
      sessionId: 'api-semantic-search',
      toolCallId: randomUUID(),
      tool: 'semantic_search',
      args: { query: body.query, path_glob: body.path_glob, max_results: body.max_results },
      decision: 'allow',
      policySource: 'authenticated_user_api',
      approvalResult: 'explicit_confirmation',
    };
    await this.processAuditStore.record({ ...audit, outcome: 'started' });
    const controller = new AbortController();
    const onClose = () => {
      if (!response.writableEnded) controller.abort(Object.assign(new Error('Semantic search client disconnected'), { code: 'CANCELLED' }));
    };
    response.once('close', onClose);
    try {
      const result = await this.semanticIndex.search(body.query, {
        limit: body.max_results || Math.min(50, this.config.retrieval?.max_results || 8),
        pathGlob: body.path_glob,
        signal: controller.signal,
      });
      await this.processAuditStore.record({ ...audit, outcome: 'succeeded' });
      return sendJson(response, 200, result);
    } catch (error) {
      await this.processAuditStore
        .record({ ...audit, outcome: 'failed', errorCode: error.code || error.name || 'SEMANTIC_SEARCH_FAILED' })
        .catch(() => {});
      throw error;
    } finally {
      response.off('close', onClose);
    }
  }

  async #manageRetrievalIndex(request, response) {
    if (!this.semanticIndex) return sendJson(response, 409, { error: 'Semantic retrieval is disabled in configuration' });
    const body = await readJson(request);
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      !['reindex', 'clear'].includes(body.action) ||
      Object.keys(body).some((key) => !['action', 'approved'].includes(key)) ||
      (body.action === 'reindex' && typeof body.approved !== 'boolean') ||
      (body.action === 'clear' && body.approved !== undefined)
    ) {
      return sendJson(response, 400, { error: 'Body must contain action=reindex with an approved boolean, or action=clear' });
    }
    if (body.action === 'reindex' && !body.approved)
      return sendJson(response, 403, {
        error: 'Reindex requires explicit approval to send redacted workspace chunks to the configured embedding service',
      });
    const tool = body.action === 'reindex' ? 'reindex_semantic_index' : 'clear_semantic_index';
    const audit = {
      sessionId: 'api-retrieval-management',
      toolCallId: randomUUID(),
      tool,
      args: {},
      decision: 'allow',
      policySource: 'authenticated_user_api',
      approvalResult: body.action === 'reindex' ? 'explicit_confirmation' : true,
    };
    await this.processAuditStore.record({ ...audit, outcome: 'started' });
    const controller = new AbortController();
    const onClose = () => {
      if (!response.writableEnded) controller.abort(Object.assign(new Error('Index operation client disconnected'), { code: 'CANCELLED' }));
    };
    response.once('close', onClose);
    try {
      const result =
        body.action === 'reindex'
          ? await this.semanticIndex.rebuild({ signal: controller.signal, sessionId: audit.toolCallId })
          : await this.semanticIndex.clear();
      await this.processAuditStore.record({ ...audit, outcome: 'succeeded' });
      return sendJson(response, 200, result);
    } catch (error) {
      await this.processAuditStore
        .record({ ...audit, outcome: 'failed', errorCode: error.code || error.name || 'INDEX_OPERATION_FAILED' })
        .catch(() => {});
      throw error;
    } finally {
      response.off('close', onClose);
    }
  }

  async #manageRetrievalExclusions(request, response) {
    if (!this.semanticIndex) return sendJson(response, 409, { error: 'Semantic retrieval is disabled in configuration' });
    const body = await readJson(request);
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      !['add', 'remove'].includes(body.action) ||
      typeof body.pattern !== 'string' ||
      Object.keys(body).some((key) => !['action', 'pattern'].includes(key))
    ) {
      return sendJson(response, 400, { error: 'Body must contain action=add|remove and a relative glob pattern' });
    }
    if (
      !body.pattern.trim() ||
      body.pattern.length > 256 ||
      body.pattern !== body.pattern.trim() ||
      body.pattern.startsWith('!') ||
      body.pattern.startsWith('/') ||
      body.pattern.includes('\\') ||
      body.pattern.split('/').some((part) => part === '.' || part === '..')
    )
      return sendJson(response, 400, { error: 'pattern must be a relative workspace glob without traversal or negation' });
    const tool = body.action === 'add' ? 'add_retrieval_exclusion' : 'remove_retrieval_exclusion';
    const audit = {
      sessionId: 'api-retrieval-management',
      toolCallId: randomUUID(),
      tool,
      args: { pattern: body.pattern },
      decision: 'allow',
      policySource: 'authenticated_user_api',
      approvalResult: true,
    };
    await this.processAuditStore.record({ ...audit, outcome: 'started' });
    try {
      const result =
        body.action === 'add'
          ? await this.semanticIndex.addExclusion(body.pattern)
          : await this.semanticIndex.removeExclusion(body.pattern);
      await this.processAuditStore.record({ ...audit, outcome: 'succeeded' });
      return sendJson(response, 200, result);
    } catch (error) {
      await this.processAuditStore
        .record({ ...audit, outcome: 'failed', errorCode: error.code || error.name || 'INDEX_EXCLUSION_FAILED' })
        .catch(() => {});
      throw error;
    }
  }

  async #createRun(request, response) {
    const body = await readJson(request, MAX_RUN_BODY_BYTES);
    const requestError = validateControlApiRunRequest(body);
    if (requestError) return sendJson(response, 400, { error: requestError });
    if (Array.isArray(body.mcp_servers) && body.mcp_servers.some((name) => !Object.hasOwn(this.config.mcp?.servers || {}, name)))
      return sendJson(response, 400, { error: 'mcp_servers contains a server that is not configured' });
    body.images = await prepareImageInputs(body.images);
    const concurrentLimit = this.config.api?.max_concurrent_runs || 2;
    if ([...this.runs.values()].filter((run) => ['running', 'paused'].includes(run.status)).length >= concurrentLimit)
      return sendJson(response, 429, { error: 'Concurrent run limit reached' });

    let session = body.session_id ? await this.sessionStore.load(body.session_id) : null;
    if (session && this.activeSessions.has(session.id)) return sendJson(response, 409, { error: 'Session already has an active run' });
    const worktrees = body.worktree_id || session?.worktree_path ? await listWorktrees(this.workspaceRoot) : [];
    const selectedWorktree = body.worktree_id
      ? worktrees.find((entry) => entry.id === body.worktree_id)
      : session?.worktree_path
        ? worktrees.find((entry) => entry.path === session.worktree_path)
        : null;
    if ((body.worktree_id || session?.worktree_path) && !selectedWorktree)
      return sendJson(response, 404, { error: 'Worktree is not available in this workspace' });
    if (selectedWorktree && session?.worktree_path && session.worktree_path !== selectedWorktree.path)
      return sendJson(response, 409, { error: 'Session is associated with a different worktree' });
    let worktreeLease = null;
    if (selectedWorktree) {
      worktreeLease = await acquireWorktreeLease(this.workspaceRoot, selectedWorktree.id);
      session ||= this.sessionStore.create();
      session.worktree_path = selectedWorktree.path;
      try {
        await this.sessionStore.save(session);
      } catch (error) {
        await worktreeLease();
        throw error;
      }
    }
    if (session) this.activeSessions.add(session.id);

    const runtimeConfig = {
      ...this.config,
      budgets: { ...(this.config.budgets || {}) },
      tools: { ...(this.config.tools || {}) },
      sandbox: structuredClone(this.config.sandbox || {}),
    };
    const initialBudgets = { ...runtimeConfig.budgets };
    const runMode = body.mode || 'agent';
    const routingPrompt = buildRoutingPrompt(session?.messages, body.prompt);
    const run = {
      id: randomUUID(),
      correlationId: randomUUID(),
      status: 'running',
      pauseRequested: false,
      resumeWaiter: null,
      directions: [],
      pendingModelChange: null,
      pendingBudgetChange: null,
      pendingRuntimePolicyChange: null,
      initialBudgets,
      currentBudgets: { ...initialBudgets },
      budgetAdjustmentsEnabled: runtimeConfig.tools?.autonomy !== 'unrestricted',
      model: null,
      mode: runMode,
      requiresTools: requiresToolsForTask(runMode, routingPrompt),
      hasImages: body.images.length > 0,
      runtimeConfig,
      created_at: new Date().toISOString(),
      events: [],
      nextEventId: 1,
      subscribers: new Set(),
      pendingApprovals: new Map(),
      controller: new AbortController(),
      sessionId: session?.id || null,
      worktreeId: selectedWorktree?.id || null,
      worktreeLease,
      workspaceRoot: selectedWorktree?.path || this.workspaceRoot,
      result: null,
      error: null,
    };
    this.runs.set(run.id, run);
    if (run.worktreeId) this.activeWorktrees.add(run.worktreeId);
    this.#publish(run, { type: 'api_run_started', run_id: run.id, correlation_id: run.correlationId });
    this.#trimRuns();
    run.execution = this.#executeRun(run, body, session);
    void run.execution;
    return sendJson(response, 202, { run_id: run.id, status: run.status, events_url: `${API_PREFIX}/runs/${run.id}/events` });
  }

  async #executeRun(run, body, session) {
    let runtime;
    try {
      runtime = new AgentRuntime({
        config: run.runtimeConfig,
        workspaceRoot: run.workspaceRoot,
        stateRoot: this.workspaceRoot,
        userDataDirectory: this.userDataDirectory,
        sessionStore: this.sessionStore,
        correlationId: run.correlationId,
        fetchImpl: this.fetchImpl,
        secretStore: this.secretStore,
        processManager: this.processManager,
        mcpManager: this.mcpManager,
        subagentTaskStore: this.subagentTaskStore,
        onEvent: (event) => {
          if (event.type === 'run_started') {
            run.sessionId = event.session_id;
            run.model = event.model;
            this.activeSessions.add(run.sessionId);
          }
          if (event.type === 'run_model_changed') {
            run.model = event.to_model;
            run.pendingModelChange = null;
          }
          if (event.type === 'run_model_change_failed') run.pendingModelChange = null;
          if (event.type === 'run_budgets_changed') {
            run.currentBudgets = { ...event.budgets };
            run.pendingBudgetChange = null;
          }
          if (event.type === 'run_budget_change_failed') run.pendingBudgetChange = null;
          if (event.type === 'run_runtime_policy_changed') {
            run.runtimeConfig.tools = { ...run.runtimeConfig.tools, autonomy: event.autonomy };
            run.runtimeConfig.sandbox = structuredClone(event.sandbox || {});
            run.budgetAdjustmentsEnabled = event.autonomy !== 'unrestricted';
            run.pendingRuntimePolicyChange = null;
          }
          if (event.type === 'run_runtime_policy_change_failed') run.pendingRuntimePolicyChange = null;
          this.#publish(run, { ...event, run_id: run.id, correlation_id: run.correlationId });
          try {
            this.onEvent({ run_id: run.id, ...event });
          } catch {
            /* observer callbacks do not affect a run */
          }
        },
      });
      const result = await runtime.run({
        prompt: body.prompt,
        images: body.images,
        session,
        requestedModel: body.model,
        mode: body.mode || 'agent',
        mcpServers: body.mcp_servers,
        streaming: true,
        signal: run.controller.signal,
        checkpoint: () => this.#checkpointRun(run),
        consumeModelChange: () => {
          const profileName = run.pendingModelChange;
          run.pendingModelChange = null;
          return profileName;
        },
        consumeBudgetChange: () => {
          const budgets = run.pendingBudgetChange;
          run.pendingBudgetChange = null;
          return budgets;
        },
        consumeRuntimePolicyChange: () => {
          const policy = run.pendingRuntimePolicyChange;
          run.pendingRuntimePolicyChange = null;
          return policy;
        },
        approveTool: (proposal) => this.#requestApproval(run, proposal),
      });
      if (
        !result ||
        typeof result.content !== 'string' ||
        !result.session ||
        typeof result.session.id !== 'string' ||
        result.session.id !== run.sessionId
      )
        throw Object.assign(new TypeError('Agent runtime returned an invalid completed run result'), {
          code: 'INVALID_RUNTIME_RESULT',
        });
      const finishedEventError = validateControlApiTerminalEvent('api_run_finished', {
        status: result?.status,
        session_id: result.session.id,
      });
      if (finishedEventError) throw Object.assign(new TypeError(finishedEventError), { code: 'INVALID_RUNTIME_RESULT' });
      run.status = result.status;
      run.result = { status: result.status, content: result.content, session_id: result.session.id };
      this.#publish(run, { type: 'api_run_finished', run_id: run.id, status: run.status, session_id: result.session.id });
    } catch (error) {
      run.status = run.controller.signal.aborted ? 'cancelled' : 'failed';
      const failure = sessionFailureFromError(error);
      run.error = { code: failure.code, message: failure.message };
      if (run.status === 'failed' && run.sessionId) {
        try {
          const session = await this.sessionStore.load(run.sessionId);
          session.status = 'failed';
          session.failure = failure;
          await this.sessionStore.save(session);
        } catch {
          /* preserve the original run error if its session cannot be updated */
        }
      }
      this.#publish(run, { type: 'api_run_failed', run_id: run.id, status: run.status, error: run.error });
    } finally {
      await runtime?.close();
      run.pendingModelChange = null;
      run.pendingBudgetChange = null;
      if (run.sessionId) this.activeSessions.delete(run.sessionId);
      if (run.worktreeId) this.activeWorktrees.delete(run.worktreeId);
      await run.worktreeLease?.();
      for (const approval of run.pendingApprovals.values()) approval.resolve(false);
      run.pendingApprovals.clear();
      this.#endSubscribers(run);
    }
  }

  #requestApproval(run, proposal) {
    if (run.controller.signal.aborted) return Promise.resolve(false);
    const approvalId = randomUUID();
    const timeoutMs = Math.min(this.config.api?.approval_timeout_ms || MAX_APPROVAL_MS, MAX_APPROVAL_MS);
    const approvalStartedAt = performance.now();
    return new Promise((resolve) => {
      const settle = (approval, rejectedStatus = 'denied') => {
        const pending = run.pendingApprovals.get(approvalId);
        if (!pending) return;
        clearTimeout(pending.timer);
        run.controller.signal.removeEventListener('abort', pending.onAbort);
        run.pendingApprovals.delete(approvalId);
        this.#publish(run, {
          type: 'approval_resolved',
          run_id: run.id,
          approval_id: approvalId,
          session_id: proposal.sessionId || run.sessionId,
          tool: proposal.tool.name,
          status: approval === true || approval?.approved === true ? 'approved' : rejectedStatus,
          duration_ms: Math.max(0, Math.round(performance.now() - approvalStartedAt)),
        });
        resolve(approval);
      };
      const onAbort = () => settle(false, 'cancelled');
      const timer = setTimeout(() => settle(false, 'expired'), timeoutMs);
      const event = {
        type: 'approval_required',
        run_id: run.id,
        approval_id: approvalId,
        session_id: proposal.sessionId || run.sessionId,
        tool: proposal.tool.name,
        arguments: proposal.args,
        ...(proposal.fileChange ? { file_change: proposal.fileChange } : {}),
        summary: proposal.permission.summary,
        expires_in_ms: timeoutMs,
        grant_options: {
          scopes: [
            'once',
            'session_exact_action',
            ...(['write_file', 'edit_file'].includes(proposal.tool.name) ? ['exact_path_1h'] : []),
            ...(proposal.tool.name === 'run_process' && !/[?*]/.test(formatArgv([proposal.args.command, ...(proposal.args.args || [])]))
              ? ['exact_command_1h']
              : []),
          ],
          max_duration_ms: MAX_SESSION_GRANT_MS,
          min_duration_ms: MIN_SESSION_GRANT_MS,
          max_active_grants: MAX_SESSION_GRANTS,
          exact_rule_duration_ms: 60 * 60 * 1000,
        },
      };
      run.pendingApprovals.set(approvalId, { resolve: settle, timer, onAbort, proposal, event });
      run.controller.signal.addEventListener('abort', onAbort, { once: true });
      this.#publish(run, {
        type: 'approval_required',
        ...event,
      });
    });
  }

  async #answerApproval(request, response, runId, approvalId) {
    const run = this.runs.get(runId);
    const pending = run?.pendingApprovals.get(approvalId);
    if (!run || !pending || run.status !== 'running') return sendJson(response, 404, { error: 'Pending approval not found' });
    const body = await readJson(request);
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => !['approved', 'grant_scope', 'grant_duration_ms', 'accepted_hunks'].includes(key)) ||
      typeof body.approved !== 'boolean'
    ) {
      return sendJson(response, 400, {
        error: 'Body must contain approved and optional grant_scope, grant_duration_ms, and accepted_hunks fields',
      });
    }
    if (body.approved === false && Object.keys(body).length !== 1)
      return sendJson(response, 400, { error: 'Denied approvals cannot include grants or accepted hunks' });
    const supportedScopes = ['once', 'session_exact_action', 'exact_path_1h', 'exact_command_1h'];
    if (body.approved && body.grant_scope !== undefined && !supportedScopes.includes(body.grant_scope))
      return sendJson(response, 400, { error: 'grant_scope is not supported' });
    if (
      body.approved &&
      body.grant_scope === 'session_exact_action' &&
      (!Number.isInteger(body.grant_duration_ms) ||
        body.grant_duration_ms < MIN_SESSION_GRANT_MS ||
        body.grant_duration_ms > MAX_SESSION_GRANT_MS)
    ) {
      return sendJson(response, 400, { error: `grant_duration_ms must be between ${MIN_SESSION_GRANT_MS} and ${MAX_SESSION_GRANT_MS}` });
    }
    if (body.grant_duration_ms !== undefined && body.grant_scope !== 'session_exact_action')
      return sendJson(response, 400, { error: 'grant_duration_ms requires grant_scope session_exact_action' });
    let acceptedHunks = null;
    if (body.accepted_hunks !== undefined) {
      const preview = pending.proposal.fileChange;
      if (
        !body.approved ||
        !preview?.selection_available ||
        !Array.isArray(body.accepted_hunks) ||
        body.accepted_hunks.length < 1 ||
        body.accepted_hunks.length > 100 ||
        body.accepted_hunks.some((id) => typeof id !== 'string' || !/^hunk-[1-9][0-9]{0,2}$/.test(id)) ||
        new Set(body.accepted_hunks).size !== body.accepted_hunks.length
      ) {
        return sendJson(response, 400, { error: 'accepted_hunks must select one or more unique hunks from the pending text-file diff' });
      }
      const knownHunks = new Set(preview.hunks.map((hunk) => hunk.id));
      if (body.accepted_hunks.some((id) => !knownHunks.has(id)))
        return sendJson(response, 400, { error: 'accepted_hunks contains an unknown hunk for this proposal' });
      acceptedHunks = body.accepted_hunks;
      const isPartial = acceptedHunks.length < preview.hunks.length;
      if (isPartial && body.grant_scope && body.grant_scope !== 'once')
        return sendJson(response, 400, { error: 'Partial hunk approval cannot create a lasting permission grant' });
    }
    if (body.approved && body.grant_scope === 'exact_path_1h' && !['write_file', 'edit_file'].includes(pending.proposal.tool.name))
      return sendJson(response, 400, { error: 'exact_path_1h is only available for workspace file writes' });
    if (
      body.approved &&
      body.grant_scope === 'exact_command_1h' &&
      (pending.proposal.tool.name !== 'run_process' ||
        /[?*]/.test(formatArgv([pending.proposal.args.command, ...(pending.proposal.args.args || [])])))
    ) {
      return sendJson(response, 400, { error: 'exact_command_1h is not available for this process call' });
    }
    if (body.approved && ['exact_path_1h', 'exact_command_1h'].includes(body.grant_scope)) {
      const { tool, args } = pending.proposal;
      let rule;
      try {
        rule =
          body.grant_scope === 'exact_path_1h'
            ? {
                tool: tool.name,
                scope: 'path_glob',
                pattern: await canonicalWorkspacePath(this.workspaceRoot, args.path),
                decision: 'allow',
                durationMs: 60 * 60 * 1000,
              }
            : {
                tool: tool.name,
                scope: 'command_glob',
                pattern: formatArgv([args.command, ...(args.args || [])]),
                decision: 'allow',
                durationMs: 60 * 60 * 1000,
              };
      } catch {
        return sendJson(response, 400, { error: 'Could not resolve the exact workspace scope; the action remains pending' });
      }
      try {
        await this.approvalRuleStore.add(rule);
      } catch {
        return sendJson(response, 500, { error: 'Could not persist the exact-scope workspace rule; the action remains pending' });
      }
    }
    if (!body.approved) pending.resolve(false);
    else if (acceptedHunks || body.grant_scope)
      pending.resolve({
        approved: true,
        ...(acceptedHunks ? { accepted_hunks: acceptedHunks } : {}),
        ...(body.grant_scope === 'session_exact_action' ? { grant_scope: 'session', grant_duration_ms: body.grant_duration_ms } : {}),
      });
    else pending.resolve(true);
    return sendJson(response, 200, { approval_id: approvalId, resolved: true, grant_scope: body.grant_scope || 'once' });
  }

  #cancelRun(response, id) {
    const run = this.runs.get(id);
    if (!run) return sendJson(response, 404, { error: 'Run not found' });
    if (!['running', 'paused'].includes(run.status)) return sendJson(response, 409, { error: 'Run is already finished' });
    run.controller.abort();
    run.resumeWaiter?.();
    return sendJson(response, 202, { run_id: run.id, status: 'cancelling' });
  }

  async #pauseRun(request, response, id) {
    const run = this.runs.get(id);
    if (!run) return sendJson(response, 404, { error: 'Run not found' });
    const body = await readJson(request);
    if (!isExactObject(body, [])) return sendJson(response, 400, { error: 'Pause request body must be an empty object' });
    if (run.status !== 'running' || run.pauseRequested)
      return sendJson(response, 409, { error: 'Run is already paused, pausing, or finished' });
    run.pauseRequested = true;
    this.#publish(run, { type: 'run_pause_requested', run_id: run.id });
    return sendJson(response, 202, { run_id: run.id, status: 'pause_requested' });
  }

  async #resumeRun(request, response, id) {
    const run = this.runs.get(id);
    if (!run) return sendJson(response, 404, { error: 'Run not found' });
    const body = await readJson(request);
    if (!isExactObject(body, [])) return sendJson(response, 400, { error: 'Resume request body must be an empty object' });
    if (this.runtimePolicyMutationActive)
      return sendJson(response, 409, { error: 'Runtime policy settings are changing; retry resume shortly.', code: 'RUNTIME_POLICY_BUSY' });
    if (run.status !== 'paused' && !run.pauseRequested) return sendJson(response, 409, { error: 'Run is not paused or pausing' });
    run.pauseRequested = false;
    run.resumeWaiter?.();
    if (run.status !== 'paused') this.#publish(run, { type: 'run_pause_cancelled', run_id: run.id });
    return sendJson(response, 202, { run_id: run.id, status: run.status === 'paused' ? 'resuming' : 'running' });
  }

  async #addRunDirection(request, response, id) {
    const run = this.runs.get(id);
    if (!run) return sendJson(response, 404, { error: 'Run not found' });
    const body = await readJson(request);
    if (
      !isExactObject(body, ['content']) ||
      typeof body.content !== 'string' ||
      !body.content.trim() ||
      Buffer.byteLength(body.content) > MAX_RUN_DIRECTION_BYTES
    ) {
      return sendJson(response, 400, { error: `Direction must contain 1 to ${MAX_RUN_DIRECTION_BYTES} bytes of text` });
    }
    if (this.config.tools?.autonomy !== 'unrestricted' && containsSensitiveMaterial(body.content)) {
      return sendJson(response, 400, { error: 'Direction appears to contain credential-like material; remove it before sending' });
    }
    if (!['running', 'paused'].includes(run.status)) return sendJson(response, 409, { error: 'Run is already finished' });
    if (run.directions.length >= MAX_PENDING_RUN_DIRECTIONS)
      return sendJson(response, 429, { error: 'Too many pending directions for this run' });
    run.directions.push(body.content.trim());
    this.#publish(run, { type: 'run_direction_queued', run_id: run.id, pending: run.directions.length });
    return sendJson(response, 202, { run_id: run.id, status: 'direction_queued', pending: run.directions.length });
  }

  async #changeRunModel(request, response, id) {
    const run = this.runs.get(id);
    if (!run) return sendJson(response, 404, { error: 'Run not found' });
    const body = await readJson(request, 2_048);
    if (!isExactObject(body, ['model']) || typeof body.model !== 'string' || !body.model.trim() || body.model.length > 128)
      return sendJson(response, 400, { error: 'Model change requires a configured profile name of at most 128 characters' });
    if (run.status !== 'paused') return sendJson(response, 409, { error: 'Pause the run before changing its model' });
    if (run.pendingModelChange) return sendJson(response, 409, { error: 'A model change is already queued for this run' });
    const modelProfiles = run.runtimeConfig.models || {};
    if (!Object.hasOwn(modelProfiles, body.model))
      return sendJson(response, 400, { error: 'Requested model profile was not configured when this run started' });
    const profile = modelProfiles[body.model];
    if (body.model === run.model) return sendJson(response, 409, { error: 'The requested model profile is already active' });
    if (run.requiresTools && profile.supports_tools === false)
      return sendJson(response, 400, { error: 'The selected model profile does not support tool use required by this run' });
    if (run.hasImages && profile.supports_vision !== true)
      return sendJson(response, 400, { error: 'The selected model profile is not configured for this run’s image inputs' });
    run.pendingModelChange = body.model;
    return sendJson(response, 202, { run_id: run.id, status: 'model_change_queued', model: body.model });
  }

  async #changeRunBudgets(request, response, id) {
    const run = this.runs.get(id);
    if (!run) return sendJson(response, 404, { error: 'Run not found' });
    const body = await readJson(request, 4_096);
    if (!isExactObject(body, ['budgets']) || !body.budgets || typeof body.budgets !== 'object' || Array.isArray(body.budgets))
      return sendJson(response, 400, { error: 'Budget change requires an object of supported budget settings' });
    if (run.status !== 'paused') return sendJson(response, 409, { error: 'Pause the run before changing its budgets' });
    if (!run.budgetAdjustmentsEnabled)
      return sendJson(response, 409, { error: 'Run budget changes are unavailable in Unrestricted autonomy' });
    if (run.pendingBudgetChange) return sendJson(response, 409, { error: 'A budget change is already queued for this run' });
    let effectiveBudgets;
    try {
      effectiveBudgets = resolveRunBudgetChange(run.initialBudgets, run.currentBudgets, body.budgets);
    } catch (error) {
      return sendJson(response, 400, { error: error.message || 'Budget change is invalid' });
    }
    run.pendingBudgetChange = { ...body.budgets };
    return sendJson(response, 202, {
      run_id: run.id,
      status: 'budget_change_queued',
      budgets: effectiveBudgets,
    });
  }

  async #checkpointRun(run) {
    const signal = run.controller.signal;
    if (signal.aborted) return [];
    if (run.pauseRequested) {
      run.status = 'paused';
      this.#publish(run, { type: 'run_paused', run_id: run.id, session_id: run.sessionId });
      const resumed = await new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          if (run.resumeWaiter === finish) run.resumeWaiter = null;
          resolve(value);
        };
        const onAbort = () => finish(false);
        run.resumeWaiter = () => finish(true);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) finish(false);
      });
      if (!resumed || signal.aborted) return [];
      run.status = 'running';
      run.pauseRequested = false;
      this.#publish(run, { type: 'run_resumed', run_id: run.id, session_id: run.sessionId });
    }
    return run.directions.splice(0);
  }

  #activeRunForSession(sessionId) {
    for (const run of this.runs.values()) {
      if (run.sessionId === sessionId && ['running', 'paused'].includes(run.status)) return run;
    }
    return null;
  }

  #getRun(response, id) {
    const run = this.runs.get(id);
    if (!run) return sendJson(response, 404, { error: 'Run not found' });
    return sendJson(response, 200, {
      run_id: run.id,
      status: run.status,
      model: run.model,
      pending_model_change: run.pendingModelChange,
      budgets: run.currentBudgets,
      initial_budgets: run.initialBudgets,
      pending_budget_change: run.pendingBudgetChange,
      pending_runtime_policy_change: run.pendingRuntimePolicyChange ? { autonomy: run.pendingRuntimePolicyChange.tools.autonomy } : null,
      budget_adjustments_enabled: run.budgetAdjustmentsEnabled,
      pause_requested: run.pauseRequested,
      pending_directions: run.directions.length,
      created_at: run.created_at,
      session_id: run.sessionId,
      last_event_sequence: run.nextEventId - 1,
      pending_approvals: [...run.pendingApprovals.keys()],
      approval_requests: [...run.pendingApprovals.values()].map((pending) => pending.event),
      result: run.result,
      error: run.error,
    });
  }

  #streamEvents(request, response, id, url) {
    const run = this.runs.get(id);
    if (!run) return sendJson(response, 404, { error: 'Run not found' });
    const headerLastId = request.headers['last-event-id'];
    const queryLastId = url.searchParams.get('after');
    const rawLastId = headerLastId ?? queryLastId ?? '0';
    const parsedLastId = /^\d+$/.test(rawLastId) ? Number(rawLastId) : 0;
    const lastId = Number.isSafeInteger(parsedLastId) ? parsedLastId : 0;
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.write('retry: 3000\n\n');
    const earliest = run.events[0]?.sequence ?? run.nextEventId;
    if (lastId > 0 && lastId < earliest - 1) {
      this.#writeEvent(response, {
        sequence: earliest - 1,
        timestamp: new Date().toISOString(),
        type: 'api_event_history_truncated',
        run_id: run.id,
        correlation_id: run.correlationId,
        earliest_available_sequence: earliest,
      });
    }
    for (const event of run.events) if (event.sequence > lastId) this.#writeEvent(response, event);
    if (!['running', 'paused'].includes(run.status)) return response.end();
    const subscriber = { response, heartbeat: null };
    subscriber.heartbeat = setInterval(() => {
      if (!response.write(': keepalive\n\n')) this.#removeSubscriber(run, subscriber);
    }, 20_000);
    subscriber.heartbeat.unref?.();
    run.subscribers.add(subscriber);
    response.once('close', () => this.#removeSubscriber(run, subscriber));
  }

  #publish(run, event) {
    const terminalEventError = validateControlApiTerminalEvent(event.type, event);
    if (terminalEventError) throw new TypeError(terminalEventError);
    const stored = {
      ...event,
      sequence: run.nextEventId++,
      timestamp: new Date().toISOString(),
      run_id: run.id,
      correlation_id: run.correlationId,
    };
    void this.observabilityStore
      .record({ correlationId: run.correlationId, runId: run.id, sessionId: event.session_id || run.sessionId, event: stored })
      .catch(() => {
        this.observabilityStore.writeFailures += 1;
      });
    run.events.push(stored);
    if (run.events.length > MAX_EVENTS_PER_RUN) run.events.splice(0, run.events.length - MAX_EVENTS_PER_RUN);
    for (const subscriber of run.subscribers) {
      if (!this.#writeEvent(subscriber.response, stored)) this.#removeSubscriber(run, subscriber);
    }
  }

  #writeEvent(response, event) {
    return response.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  #removeSubscriber(run, subscriber) {
    if (!run.subscribers.delete(subscriber)) return;
    clearInterval(subscriber.heartbeat);
    subscriber.response.end();
  }

  #endSubscribers(run) {
    for (const subscriber of run.subscribers) {
      clearInterval(subscriber.heartbeat);
      subscriber.response.end();
    }
    run.subscribers.clear();
  }

  #trimRuns() {
    if (this.runs.size <= MAX_RETAINED_RUNS) return;
    for (const [id, run] of this.runs) {
      if (!['running', 'paused'].includes(run.status)) this.runs.delete(id);
      if (this.runs.size <= MAX_RETAINED_RUNS) break;
    }
  }
}

async function readJson(request, maxBytes = MAX_BODY_BYTES) {
  const contentType = request.headers['content-type'] || '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    request.resume();
    const error = new TypeError('Content-Type must be application/json');
    error.statusCode = 415;
    throw error;
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      request.resume();
      const error = new TypeError(`Request body exceeds ${maxBytes} bytes`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new SyntaxError('Request body must be valid JSON');
  }
}

function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;
  if (address.startsWith('::ffff:')) address = address.slice(7);
  return isIP(address) === 4 && address.startsWith('127.');
}

function isLocalHostHeader(value) {
  if (typeof value !== 'string' || value.length > 255) return false;
  try {
    const hostname = new URL(`http://${value}`).hostname.toLowerCase();
    return hostname === '127.0.0.1' || hostname === 'localhost';
  } catch {
    return false;
  }
}

function sameRuntimePath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32' ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase() : normalizedLeft === normalizedRight;
}

function isExactObject(value, allowedKeys) {
  return (
    value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => allowedKeys.includes(key))
  );
}

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function applyRuntimeOverrides(config, overrides) {
  if (overrides.default_model !== undefined) config.default_model = overrides.default_model;
  for (const field of ['review_model', 'plan_model']) {
    if (overrides[field] === null) delete config[field];
    else if (overrides[field] !== undefined) config[field] = overrides[field];
  }
  if (overrides.routing) config.routing = { ...config.routing, ...overrides.routing };
  if (overrides.budgets) {
    config.budgets ||= {};
    for (const [key, value] of Object.entries(overrides.budgets)) {
      if (value === null) delete config.budgets[key];
      else config.budgets[key] = value;
    }
  }
  if (overrides.tools) config.tools = { ...config.tools, ...overrides.tools };
  if (overrides.subagents) config.subagents = { ...config.subagents, ...overrides.subagents };
  if (overrides.ui) {
    const currentShortcuts = config.ui?.shortcuts;
    config.ui = { ...config.ui, ...overrides.ui };
    if (overrides.ui.shortcuts) config.ui.shortcuts = { ...currentShortcuts, ...overrides.ui.shortcuts };
  }
  if (overrides.memory) config.memory = { ...config.memory, ...overrides.memory };
  if (overrides.app_data) {
    config.app_data = { ...config.app_data, ...overrides.app_data };
    if (overrides.app_data.directory === null) delete config.app_data.directory;
  }
  if (overrides.sandbox) {
    config.sandbox = { ...config.sandbox, ...overrides.sandbox };
    if (overrides.sandbox.tools) {
      config.sandbox.tools = { ...config.sandbox.tools, ...overrides.sandbox.tools };
      for (const [toolName, mode] of Object.entries(overrides.sandbox.tools)) if (mode === null) delete config.sandbox.tools[toolName];
    }
  }
  if (overrides.app_updates) {
    config.app_updates = { ...config.app_updates, ...overrides.app_updates };
    for (const key of ['feed_url', 'key_id', 'public_key']) if (overrides.app_updates[key] === null) delete config.app_updates[key];
  }
  if (overrides.web_search) {
    config.web_search = { ...config.web_search, ...overrides.web_search };
    for (const key of ['api_key_env', 'api_key_secret']) if (overrides.web_search[key] === null) delete config.web_search[key];
  }
  if (overrides.models) {
    config.models ||= {};
    for (const [name, patch] of Object.entries(overrides.models)) {
      if (patch === null) {
        delete config.models[name];
        continue;
      }
      const profile = (config.models[name] ||= {});
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete profile[key];
        else profile[key] = value;
      }
    }
  }
  if (overrides.mcp?.servers) {
    config.mcp ||= { enabled: true, servers: {} };
    config.mcp.servers ||= {};
    for (const [name, patch] of Object.entries(overrides.mcp.servers)) {
      if (patch === null) delete config.mcp.servers[name];
      else {
        const target = (config.mcp.servers[name] ||= {});
        for (const [setting, value] of Object.entries(patch)) {
          if (value === null) delete target[setting];
          else target[setting] = value;
        }
      }
    }
  }
}

function sameStrings(left, right) {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function errorStatus(error) {
  if (['PACKAGE_KEY_REVOKED', 'PACKAGE_KEY_UNTRUSTED', 'PACKAGE_REVOKED'].includes(error.code)) return 403;
  if (['UPDATE_FEED_KEY_REVOKED', 'UPDATE_FEED_KEY_UNTRUSTED', 'REVOCATION_FEED_KEY_UNTRUSTED'].includes(error.code)) return 403;
  if (['PACKAGE_REGISTRY_BUSY', 'PACKAGE_INSTALL_BUSY'].includes(error.code)) return 423;
  if (['PACKAGE_MCP_LIMIT', 'PACKAGE_REGISTRY_LIMIT', 'PACKAGE_ROLLBACK_UNAVAILABLE', 'PACKAGE_VERSION_EXISTS'].includes(error.code))
    return 409;
  if (
    [
      'PACKAGE_BUNDLE_INVALID',
      'PACKAGE_CAPABILITY_INVALID',
      'PACKAGE_CAPABILITY_SCOPE_INVALID',
      'PACKAGE_FILE_DIGEST_INVALID',
      'PACKAGE_FILE_SET_INVALID',
      'PACKAGE_FILE_SIZE_INVALID',
      'PACKAGE_INSTALL_IDENTITY_MISMATCH',
      'PACKAGE_INSTALL_PATH_INVALID',
      'PACKAGE_MANIFEST_INVALID',
      'PACKAGE_PATH_INVALID',
      'PACKAGE_SIGNATURE_INVALID',
      'PACKAGE_SKILL_INVALID',
      'PACKAGE_TOO_LARGE',
      'PACKAGE_TRUST_KEY_INVALID',
      'PACKAGE_VERSION_INVALID',
    ].includes(error.code)
  )
    return 400;
  if (error.code === 'APP_UPDATE_FEED_TOO_LARGE') return 413;
  if (['UPDATE_FEED_TOO_LARGE', 'REVOCATION_FEED_TOO_LARGE', 'UPDATE_PACKAGE_TOO_LARGE'].includes(error.code)) return 413;
  if (error.code === 'APP_UPDATE_STAGING_INVALID') return 500;
  if (error.code === 'APP_UPDATE_SELECTION_INVALID') return 400;
  if (error.code === 'APP_UPDATE_RELEASE_CHANGED') return 409;
  if (
    [
      'APP_UPDATE_ARTIFACT_HTTP_ERROR',
      'APP_UPDATE_ARTIFACT_FETCH_FAILED',
      'APP_UPDATE_ARTIFACT_INVALID',
      'APP_UPDATE_ARTIFACT_SIZE_INVALID',
      'APP_UPDATE_ARTIFACT_DIGEST_INVALID',
    ].includes(error.code)
  )
    return 502;
  if (['APP_UPDATE_NOT_CONFIGURED', 'APP_UPDATES_DISABLED'].includes(error.code)) return 409;
  if (error.code === 'APP_UPDATE_FEED_EXPIRED') return 410;
  if (['UPDATE_FEED_EXPIRED', 'REVOCATION_FEED_EXPIRED'].includes(error.code)) return 410;
  if (
    [
      'UPDATE_FEED_NOT_CONFIGURED',
      'UPDATE_DATA_UNAVAILABLE',
      'UPDATE_CACHE_INVALID',
      'UPDATE_FEED_REPLAY',
      'UPDATE_SELECTION_UNAVAILABLE',
      'UPDATE_ALREADY_STAGED',
      'REVOCATION_FEED_NOT_CONFIGURED',
      'REVOCATION_DATA_UNAVAILABLE',
      'REVOCATION_CACHE_INVALID',
      'REVOCATION_FEED_REPLAY',
    ].includes(error.code)
  )
    return 409;
  if (['UPDATE_FEED_HTTP_ERROR', 'UPDATE_PACKAGE_HTTP_ERROR', 'REVOCATION_FEED_HTTP_ERROR'].includes(error.code)) return 502;
  if (/^(UPDATE_(FEED|PACKAGE|CACHE|COHORT)_|REVOCATION_(FEED|CACHE)_)/.test(error.code || '')) return 400;
  if (['APP_UPDATE_FEED_REPLAY', 'APP_UPDATE_CACHE_INVALID'].includes(error.code)) return 409;
  if (['APP_UPDATE_HTTP_ERROR', 'APP_UPDATE_CHECK_FAILED', 'APP_UPDATE_FETCH_UNAVAILABLE'].includes(error.code)) return 502;
  if (error.code === 'APP_UPDATE_TIMEOUT') return 504;
  if (error.code === 'FEED_CACHE_LOCKED') return 423;
  if (error.code?.startsWith('APP_UPDATE_')) return 400;
  if (['INVALID_MEMORY_EXPORT', 'UNSUPPORTED_MEMORY_EXPORT_VERSION', 'UNSUPPORTED_MEMORY_SCHEMA_VERSION'].includes(error.code)) return 400;
  if (['MEMORY_LIMIT', 'MEMORY_EXPORT_TOO_LARGE'].includes(error.code)) return 413;
  if (
    [
      'INVALID_IMAGE',
      'INVALID_IMAGE_TYPE',
      'INVALID_IMAGE_FILE',
      'SENSITIVE_IMAGE_PATH',
      'IMAGE_TOO_MANY_PIXELS',
      'IMAGE_PROCESSING_FAILED',
      'IMAGES_TOO_LARGE',
    ].includes(error.code)
  )
    return 400;
  if (error.code === 'IMAGE_TOO_LARGE') return 413;
  if (error.code === 'FILE_TOO_LARGE') return 413;
  if (error.code === 'SYMLINK_NOT_ALLOWED') return 403;
  if (error.code === 'BINARY_FILE') return 415;
  if (error.code === 'WORKSPACE_FILE_CHANGED') return 409;
  if (['ENOENT', 'NOT_FOUND', 'GOAL_NOT_FOUND', 'PROCESS_NOT_FOUND'].includes(error.code)) return 404;
  if (
    [
      'SESSION_CONFLICT',
      'SESSION_GOAL_REFERENCE_MISSING',
      'RULE_LIMIT',
      'WORKTREE_DIRTY',
      'WORKTREE_UNAVAILABLE',
      'WORKTREE_IN_USE',
      'PROCESS_ACTIVE',
      'PROCESS_SCOPE_DENIED',
      'PROCESS_STOP_TIMEOUT',
      'PROCESS_STATE_UNKNOWN',
      'PROCESS_OWNER_UNAVAILABLE',
      'PROCESS_INPUT_DISABLED',
      'PROCESS_NOT_RUNNING',
      'PROCESS_INPUT_CLOSED',
    ].includes(error.code)
  )
    return 409;
  if (['SESSION_LOCKED', 'GOAL_LOCKED', 'MEMORY_LOCKED', 'RULES_LOCKED', 'SETTINGS_LOCKED'].includes(error.code)) return 423;
  if (error.statusCode) return error.statusCode;
  if (error instanceof SyntaxError || error instanceof TypeError) return 400;
  return 500;
}

function parsePage(searchParams) {
  const rawOffset = searchParams.get('offset') ?? '0';
  const rawLimit = searchParams.get('limit') ?? '50';
  if (!/^\d+$/.test(rawOffset) || !/^\d+$/.test(rawLimit)) throw new TypeError('offset and limit must be non-negative integers');
  const offset = Number(rawOffset);
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(offset) || offset > 1_000_000 || !Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new TypeError('offset must be at most 1000000 and limit must be between 1 and 200');
  }
  return { offset, limit };
}

function setResponseHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
}

function sendJson(response, status, body, headers = {}) {
  if (response.headersSent) return response.end();
  const serialized = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(serialized),
    ...headers,
  });
  response.end(serialized);
}

function publicSettings(config) {
  const pick = (source, fields) =>
    Object.fromEntries(fields.filter((field) => source?.[field] !== undefined).map((field) => [field, source[field]]));
  const models = Object.fromEntries(
    Object.entries(config.models || {}).map(([name, model]) => [
      name,
      {
        ...pick(model, [
          'provider',
          'base_url',
          'model',
          'context_length',
          'context_mode',
          'timeout_ms',
          'retry_attempts',
          'reasoning_effort',
          'prompt_cache_enabled',
          'prompt_cache_key',
          'prompt_cache_retention',
          'input_cost_per_million',
          'cached_input_cost_per_million',
          'output_cost_per_million',
          'pricing_updated_at',
          'pricing_source',
          'capabilities_updated_at',
          'capabilities_source',
          'local',
          'supports_tools',
          'supports_vision',
          'coding_strength',
          'tool_calling_quality',
          'speed_score',
          'priority',
        ]),
        credential_configured: Boolean(model.api_key_env || model.api_key_secret),
      },
    ]),
  );
  const settings = {
    app_data: { directory: config.app_data?.directory || defaultUserDataDirectory() },
    default_model: config.default_model ?? null,
    review_model: config.review_model ?? null,
    plan_model: config.plan_model ?? null,
    models,
    budgets: pick(config.budgets, RUN_BUDGET_FIELDS),
    compaction: pick(config.compaction, ['enabled', 'trigger_ratio', 'budget_trigger_ratio', 'keep_recent_turns']),
    routing: pick(config.routing, ['enabled', 'prefer_local', 'minimum_context_tokens', 'selection']),
    memory: pick(config.memory, ['global_enabled', 'max_context_chars']),
    sandbox: pick(config.sandbox, ['mode', 'tools']),
    retrieval: {
      ...pick(config.retrieval, [
        'max_files',
        'max_file_bytes',
        'max_results',
        'auto_context',
        'auto_context_max_results',
        'auto_context_max_chars',
      ]),
      semantic: config.retrieval?.semantic
        ? {
            enabled: config.retrieval.semantic.enabled === true,
            model: config.retrieval.semantic.model ?? null,
            allow_remote: config.retrieval.semantic.allow_remote === true,
            credential_configured: Boolean(config.retrieval.semantic.api_key_env || config.retrieval.semantic.api_key_secret),
          }
        : null,
    },
    tools: pick(config.tools, [
      'shell_enabled',
      'filesystem_scope',
      'autonomy',
      'recursive_listing',
      'max_file_bytes',
      'max_write_bytes',
      'max_list_entries',
    ]),
    ui: pick(config.ui, ['sidebar_collapsed', 'theme', 'shortcuts_enabled', 'shortcuts']),
    app_updates: {
      mode: config.app_updates?.mode || 'disabled',
      channel: config.app_updates?.channel || 'stable',
      feed_url: config.app_updates?.feed_url || null,
      key_id: config.app_updates?.key_id || null,
      feed_configured: Boolean(config.app_updates?.feed_url && config.app_updates?.key_id && config.app_updates?.public_key),
      key_fingerprint: config.app_updates?.public_key ? applicationUpdateKeyFingerprint(config.app_updates.public_key) : null,
    },
    web_search: config.web_search
      ? {
          enabled: config.web_search.enabled === true,
          provider: config.web_search.provider ?? null,
          max_results: config.web_search.max_results ?? 10,
          credential_configured: Boolean(config.web_search.api_key_env || config.web_search.api_key_secret),
        }
      : null,
    subagents: config.subagents ? pick(config.subagents, ['enabled', 'max_concurrent', 'max_turns', 'timeout_ms']) : null,
    skills: { enabled: config.skills?.enabled === true, configured_roots: config.skills?.directories?.length || 0 },
    observability: {
      enabled: config.observability?.enabled === true,
      max_file_bytes: config.observability?.max_file_bytes ?? 10 * 1024 * 1024,
    },
    api: pick(config.api, ['max_concurrent_runs', 'approval_timeout_ms', 'allowed_origins']),
  };
  return settings;
}

function safeModelListError(error) {
  const safeCodes = new Set([
    'AUTHENTICATION_FAILED',
    'RATE_LIMITED',
    'CONNECTION_FAILED',
    'REQUEST_TIMEOUT',
    'INVALID_RESPONSE',
    'PROVIDER_ERROR',
  ]);
  return safeCodes.has(error?.code) ? error.code : 'MODEL_LIST_FAILED';
}
