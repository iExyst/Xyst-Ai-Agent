import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import uriTemplates from './vendor/uri-templates.cjs';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { resolveToolPath } from '../platform/paths.mjs';
import { safeProcessEnvironment, terminateProcessTree } from '../platform/process.mjs';
import { deepFreeze, resolveToolTimeoutMs, TOOL_SCHEMA_VERSION } from './schemas.mjs';
import { LegacySseMcpSession, StreamableHttpMcpSession } from './mcp-http.mjs';
import { getActiveInstalledMcpPackages } from '../extensions/package-registry.mjs';
import { buildBubblewrapArgs, bubblewrapLauncherEnvironment, findBubblewrap, validateBubblewrapWorkspace } from '../platform/sandbox.mjs';
import { waitForBubblewrapStart } from '../platform/bubblewrap-status.mjs';
import { redactSecrets } from '../platform/redaction.mjs';
import { isReadOnlySandbox, requiresProcessIsolation, resolveSandboxMode } from '../platform/sandbox-modes.mjs';
import { validateMcpInitializeResult, validateMcpJsonRpcResponse, validateMcpResultType } from './mcp-protocol.mjs';

const MODERN_VERSION = '2026-07-28';
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const CLIENT_INFO = { name: 'xyst-agent', version: '0.1.0' };
const MAX_LINE_BYTES = 1_048_576;
const MAX_TOOLS_PER_SERVER = 128;
const MAX_TOOLS_TOTAL = 256;
const MAX_PAGES = 32;
const MCP_NAME = /^[A-Za-z0-9_-]{1,48}$/;
const MCP_CAPABILITY_NAMES = new Set(['tools', 'resources', 'prompts', 'logging', 'completions']);

/** Explicitly configured MCP servers. Each advertised tool is mediated by AgentRuntime policy. */
export class StdioMcpManager {
  constructor({ config, workspaceRoot, secretStore, auditStore = null, installedPackages = null } = {}) {
    this.config = config || {};
    this.workspaceRoot = workspaceRoot;
    this.secretStore = secretStore;
    this.auditStore = auditStore;
    this.installedPackages = installedPackages;
    this.sessions = new Map();
    this.tools = new Map();
    this.serverErrors = new Map();
    this.initialization = null;
    this.closed = false;
  }

  initialize() {
    if (!this.initialization) this.initialization = this.#initialize();
    return this.initialization;
  }

  async reconfigure(config) {
    await this.close();
    this.config = config || {};
    this.sessions.clear();
    this.tools.clear();
    this.serverErrors.clear();
    this.initialization = null;
    this.closed = false;
    await this.initialize();
  }

  async #initialize() {
    if (isReadOnlySandbox(this.config)) return;
    if (this.config.mcp?.enabled !== true) return;
    const entries = Object.entries(this.config.mcp?.servers || {}).filter(([, server]) => server.enabled === true);
    if (!entries.length) return;
    let activePackages = [];
    let packageLoadError = null;
    if (entries.some(([, settings]) => settings.package_id)) {
      try {
        activePackages = this.installedPackages ? await getActiveInstalledMcpPackages(this.installedPackages) : [];
      } catch (error) {
        packageLoadError = error;
      }
    }
    const packagesById = new Map(activePackages.map((extension) => [extension.package_id, extension]));
    for (const [name, originalSettings] of entries) {
      let session = null;
      try {
        let settings = originalSettings;
        let extension = null;
        if (settings.package_id) {
          if (packageLoadError) throw packageLoadError;
          const installed = packagesById.get(settings.package_id);
          if (!installed)
            throw mcpError(`Signed MCP package '${settings.package_id}' is not installed and activated`, 'MCP_PACKAGE_NOT_ACTIVE');
          const declared = installed.manifest.capabilities || [];
          const has = (capability) => declared.some((entry) => entry.name === capability && entry.scope === 'configured-server');
          if (
            Object.values(settings.env || {}).some((value) => value.startsWith('secret:')) &&
            !declared.some((entry) => entry.name === 'secrets.use' && entry.scope === 'configured-reference')
          ) {
            throw mcpError(
              `Signed MCP package '${settings.package_id}' uses secret references without declaring secrets.use`,
              'MCP_PACKAGE_CAPABILITY_MISSING',
            );
          }
          settings = {
            ...settings,
            command: process.execPath,
            args: [path.join(installed.path, ...installed.manifest.entry_point.split('/')), ...(settings.args || [])],
            cwd: installed.path,
          };
          extension = { ...installed, has };
        }
        if (requiresProcessIsolation(resolveSandboxMode(this.config)) && process.platform !== 'linux')
          throw mcpError(
            'MCP servers cannot run because persistent process isolation is not implemented for this platform',
            'MCP_SANDBOX_UNSUPPORTED',
          );
        if (requiresProcessIsolation(resolveSandboxMode(this.config)) && ['streamable_http', 'sse'].includes(settings.transport))
          throw mcpError(
            'HTTP-based MCP transports cannot run because network sandbox exceptions are not implemented',
            'MCP_SANDBOX_UNSUPPORTED',
          );
        if (
          (settings.transport || 'stdio') === 'stdio' &&
          this.config.tools?.autonomy !== 'unrestricted' &&
          this.config.tools?.shell_enabled !== true
        )
          throw mcpError('MCP stdio servers require tools.shell_enabled=true in user configuration', 'MCP_PROCESS_DISABLED');

        await this.#audit(name, 'started');
        session =
          settings.transport === 'sse'
            ? await LegacySseMcpSession.start({ name, settings, config: this.config, secretStore: this.secretStore })
            : settings.transport === 'streamable_http'
              ? await StreamableHttpMcpSession.start({ name, settings, config: this.config, secretStore: this.secretStore })
              : await McpStdioSession.start({
                  name,
                  settings,
                  config: this.config,
                  workspaceRoot: this.workspaceRoot,
                  secretStore: this.secretStore,
                  extension,
                });
        this.sessions.set(name, session);
        const advertised = await session.listTools();
        const resources = await session.listResources();
        const resourceTemplates = await session.listResourceTemplates();
        const prompts = await session.listPrompts();
        if (extension) {
          if (advertised.length && !extension.has('mcp.tools'))
            throw mcpError(
              `Signed MCP package '${extension.package_id}' advertised tools without declaring mcp.tools`,
              'MCP_PACKAGE_CAPABILITY_MISSING',
            );
          if ((resources.length || resourceTemplates.length) && !extension.has('mcp.resources'))
            throw mcpError(
              `Signed MCP package '${extension.package_id}' advertised resources or resource templates without declaring mcp.resources`,
              'MCP_PACKAGE_CAPABILITY_MISSING',
            );
          if (prompts.length && !extension.has('mcp.prompts'))
            throw mcpError(
              `Signed MCP package '${extension.package_id}' advertised prompts without declaring mcp.prompts`,
              'MCP_PACKAGE_CAPABILITY_MISSING',
            );
        }
        const definitions = [
          ...advertised,
          ...resources.map((resource) => normalizeMcpResource(name, resource)),
          ...resourceTemplates.map((resourceTemplate) => normalizeMcpResourceTemplate(name, resourceTemplate)),
          ...prompts.map((prompt) => normalizeMcpPrompt(name, prompt)),
        ];
        const names = new Set(this.tools.keys());
        for (const tool of definitions) {
          if (names.has(tool.name) || names.size >= MAX_TOOLS_TOTAL)
            throw mcpError('MCP server tool names collided or exceeded the aggregate limit', 'MCP_TOOL_LIMIT');
          names.add(tool.name);
        }
        for (const tool of definitions) this.tools.set(tool.name, { session, definition: tool });
        this.serverErrors.delete(name);
        await this.#audit(name, 'succeeded');
      } catch (error) {
        if (session) {
          this.sessions.delete(name);
          await session.close().catch(() => {});
        }
        for (const [toolName, entry] of this.tools) {
          if (entry.definition._mcp.server === name) this.tools.delete(toolName);
        }
        const errorCode = typeof error.code === 'string' ? error.code.slice(0, 100) : 'MCP_CONNECT_FAILED';
        this.serverErrors.set(name, errorCode);
        await this.#audit(name, 'failed', errorCode).catch(() => {});
      }
    }
  }

  get definitions() {
    return [...this.tools.values()].map(({ definition }) => definition);
  }

  get serverCatalog() {
    const globallyEnabled = this.config.mcp?.enabled === true;
    return Object.entries(this.config.mcp?.servers || {}).map(([name, settings]) => {
      const enabled = globallyEnabled && settings.enabled === true;
      const tools = this.definitions
        .filter((definition) => definition._mcp.server === name)
        .map((definition) => ({
          name: definition.name,
          kind: definition._mcp.operation || 'tool',
          description: definition.description.slice(0, 1000),
        }));
      return {
        name,
        enabled,
        can_enable: globallyEnabled,
        transport: settings.transport || 'stdio',
        package_id: settings.package_id || null,
        connection_state: !enabled
          ? 'disabled'
          : this.sessions.has(name)
            ? 'connected'
            : this.serverErrors.has(name)
              ? 'error'
              : 'disconnected',
        error_code: this.serverErrors.get(name) || null,
        protocol_version: this.sessions.get(name)?.protocolVersion || this.sessions.get(name)?.version || null,
        server_info: sanitizeMcpServerInfo(this.sessions.get(name)?.serverInfo),
        capabilities: Object.keys(this.sessions.get(name)?.capabilities || {})
          .filter((capability) => MCP_CAPABILITY_NAMES.has(capability))
          .sort(),
        tools,
      };
    });
  }
  has(name) {
    return this.tools.has(name);
  }

  async call(name, args, context = {}) {
    const entry = this.tools.get(name);
    if (!entry) throw mcpError('MCP tool is no longer available', 'MCP_TOOL_UNAVAILABLE');
    const metadata = entry.definition._mcp;
    if (metadata.operation === 'resources/read') return entry.session.readResource(metadata.resourceUri, context);
    if (metadata.operation === 'resources/templates/read')
      return entry.session.readResource(expandResourceTemplate(metadata, args), context);
    if (metadata.operation === 'prompts/get') return entry.session.getPrompt(metadata.promptName, args, context);
    return entry.session.callTool(metadata.originalName, args, {
      ...context,
      headerParameters: metadata.headerParameters || [],
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.tools.clear();
    await Promise.allSettled(sessions.map((session) => session.close()));
  }

  async #audit(name, outcome, errorCode = null) {
    if (!this.auditStore) return;
    await this.auditStore.record({
      sessionId: 'mcp-server-lifecycle',
      toolCallId: randomUUID(),
      tool: 'mcp_server',
      args: { server: name },
      decision: 'allow',
      policySource: this.config.tools?.autonomy === 'unrestricted' ? 'unrestricted_autonomy' : 'user_configuration',
      approvalResult: true,
      outcome,
      errorCode,
    });
  }
}

function sanitizeMcpServerInfo(info) {
  if (!info || typeof info !== 'object' || Array.isArray(info)) return null;
  const result = {};
  for (const key of ['name', 'version']) {
    if (typeof info[key] !== 'string') continue;
    const value = redactSecrets(info[key])
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 120);
    if (value) result[key] = value;
  }
  return Object.keys(result).length ? result : null;
}

class McpStdioSession {
  constructor({ name, child, protocolVersion, timeoutMs }) {
    this.name = name;
    this.child = child;
    this.protocolVersion = protocolVersion;
    this.capabilities = {};
    this.serverInfo = null;
    this.timeoutMs = timeoutMs;
    this.nextId = 0;
    this.pending = new Map();
    this.buffer = '';
    this.stderr = '';
    this.closed = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onStdout(chunk));
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-8192);
    });
    child.stdin.on('error', () => this.#failAll(`Unable to write to MCP server '${this.name}'`, 'MCP_TRANSPORT_ERROR'));
    child.once('error', () => this.#failAll('MCP server process failed to start', 'MCP_SPAWN_FAILED'));
    child.once('close', () => this.#failAll('MCP server process exited', 'MCP_SERVER_EXITED'));
  }

  static async start({ name, settings, config, workspaceRoot, secretStore, extension = null }) {
    const timeoutMs = resolveToolTimeoutMs({ name: 'mcp_server', execution: { timeout: mcpTimeoutPolicy(name) } }, config);
    const sandboxMode = resolveSandboxMode(config);
    const sandboxRequired = requiresProcessIsolation(sandboxMode);
    if (sandboxRequired && Object.keys(settings.env || {}).length)
      throw mcpError('MCP environment references cannot be passed into workspace sandbox modes', 'MCP_SANDBOX_ENV_UNSUPPORTED');
    const packageRoot = extension?.root || extension?.path || null;
    const cwd = packageRoot
      ? packageRoot
      : settings.cwd
        ? await resolveToolPath(workspaceRoot, settings.cwd, {
            mustExist: true,
            machineScope: config.tools?.autonomy === 'unrestricted' || config.tools?.filesystem_scope === 'machine',
          })
        : workspaceRoot;
    const env = config.tools?.autonomy === 'unrestricted' ? { ...process.env } : safeProcessEnvironment(process.env);
    for (const [target, reference] of Object.entries(settings.env || {})) {
      if (reference.startsWith('env:')) {
        const key = reference.slice(4);
        if (process.env[key] === undefined)
          throw mcpError(`Required environment reference for MCP server '${name}' is not set`, 'MCP_AUTH_REFERENCE_MISSING');
        env[target] = process.env[key];
      } else {
        const key = reference.slice(7);
        const value = await (secretStore || (await import('../platform/secrets.mjs')).createPlatformSecretStore()).get(key);
        if (value === null)
          throw mcpError(`Required OS-vault reference for MCP server '${name}' was not found`, 'MCP_AUTH_REFERENCE_MISSING');
        env[target] = value;
      }
    }
    let child;
    if (sandboxRequired) {
      const bwrap = await findBubblewrap();
      if (!bwrap) throw mcpError('Required MCP process isolation needs a trusted system Bubblewrap executable', 'MCP_SANDBOX_UNAVAILABLE');
      let sandboxWorkspace;
      try {
        sandboxWorkspace = await validateBubblewrapWorkspace(workspaceRoot, { includeIdentity: true });
      } catch (error) {
        throw mcpError(error.message, 'MCP_SANDBOX_WORKSPACE_UNSAFE');
      }
      const executable = await resolveLinuxExecutable(settings.command, cwd, env);
      const executableMount = '/xyst-runtime/mcp-executable';
      const mounts = [{ source: executable, target: executableMount }];
      let sandboxArgs = settings.args || [];
      let sandboxCwd = '/workspace';
      if (extension) {
        const entryPoint = extension.manifest.entry_point;
        mounts.push({ source: packageRoot, target: '/xyst-extension', directory: true });
        sandboxArgs = [`/xyst-extension/${entryPoint}`, ...(settings.args || [])];
        sandboxCwd = '/xyst-extension';
      } else {
        const relative = path.relative(sandboxWorkspace.path, cwd);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
          throw mcpError('MCP working directory is outside the sandbox workspace', 'MCP_SANDBOX_PATH_INVALID');
        if (relative) sandboxCwd = path.posix.join('/workspace', ...relative.split(path.sep));
      }
      const sandboxArgsWrapped = buildBubblewrapArgs({
        workspaceRoot: sandboxWorkspace.path,
        workspaceIdentity: sandboxWorkspace.identity,
        workspaceReadOnly: sandboxMode === 'workspace-read',
        workspaceIdentityFailureToken: randomUUID(),
        command: executableMount,
        args: sandboxArgs,
        cwd: sandboxCwd,
        readOnlyMounts: mounts,
        bwrap,
      });
      child = spawn(bwrap, sandboxArgsWrapped, {
        cwd: '/',
        env: bubblewrapLauncherEnvironment(),
        shell: false,
        windowsHide: true,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      const captureStderr = (chunk) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-8192);
      };
      child.stderr.on('data', captureStderr);
      if (!(await waitForBubblewrapStart(child))) {
        child.stderr.removeListener('data', captureStderr);
        terminateProcessTree(child, 'force');
        throw mcpError(
          `Bubblewrap failed before MCP server '${name}' started${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
          'MCP_SANDBOX_SETUP_FAILED',
        );
      }
      child.stderr.removeListener('data', captureStderr);
    } else {
      const args = extension
        ? [path.join(packageRoot, ...extension.manifest.entry_point.split('/')), ...(settings.args || [])]
        : settings.args || [];
      child = spawn(settings.command, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }
    const session = new McpStdioSession({ name, child, protocolVersion: null, timeoutMs });
    try {
      session.protocolVersion = await session.#negotiate();
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  async #negotiate() {
    let discovered = null;
    try {
      discovered = await this.#request('server/discover', { _meta: modernMeta() }, Math.min(this.timeoutMs, 1500), MODERN_VERSION);
    } catch (error) {
      if (error.code !== 'MCP_REMOTE_METHOD_MISSING') throw error;
      /* Only an explicit method-not-found response establishes legacy discovery fallback. */
    }
    if (discovered?.supportedVersions?.includes(MODERN_VERSION)) {
      this.capabilities = discovered.capabilities || {};
      this.serverInfo = discovered._meta?.['io.modelcontextprotocol/serverInfo'] || discovered.serverInfo || null;
      return MODERN_VERSION;
    }

    const initialized = validateMcpInitializeResult(
      await this.#request('initialize', {
        protocolVersion: LEGACY_VERSIONS[0],
        capabilities: {},
        clientInfo: CLIENT_INFO,
      }),
      { serverName: this.name },
    );
    const selected = initialized?.protocolVersion;
    if (!LEGACY_VERSIONS.includes(selected))
      throw mcpError('MCP server negotiated an unsupported protocol version', 'MCP_VERSION_UNSUPPORTED');
    this.capabilities = initialized.capabilities || {};
    this.serverInfo = initialized.serverInfo || null;
    this.#notify('notifications/initialized', {});
    return selected;
  }

  async listTools() {
    const tools = [];
    let cursor;
    const seenCursors = new Set();
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const params = { ...(cursor ? { cursor } : {}) };
      if (this.protocolVersion === MODERN_VERSION) params._meta = modernMeta();
      const result = await this.#request('tools/list', params);
      if (!Array.isArray(result?.tools))
        throw mcpError(`MCP server '${this.name}' returned an invalid tools/list result`, 'MCP_INVALID_RESPONSE');
      if (tools.length + result.tools.length > MAX_TOOLS_PER_SERVER)
        throw mcpError(`MCP server '${this.name}' exceeded the tool limit`, 'MCP_TOOL_LIMIT');
      for (const remote of result.tools) tools.push(normalizeMcpTool(this.name, remote));
      cursor = result.nextCursor;
      if (!cursor) return tools;
      if (typeof cursor !== 'string' || cursor.length > 1024 || seenCursors.has(cursor))
        throw mcpError(`MCP server '${this.name}' returned an invalid pagination cursor`, 'MCP_INVALID_RESPONSE');
      seenCursors.add(cursor);
    }
    throw mcpError(`MCP server '${this.name}' exceeded the pagination limit`, 'MCP_TOOL_LIMIT');
  }

  async listResources() {
    if (!this.capabilities.resources) return [];
    return this.#listCollection('resources/list', 'resources');
  }

  async listResourceTemplates() {
    if (!this.capabilities.resources) return [];
    try {
      return await this.#listCollection('resources/templates/list', 'resourceTemplates');
    } catch (error) {
      if (error.code === 'MCP_REMOTE_METHOD_MISSING') return [];
      throw error;
    }
  }

  async listPrompts() {
    if (!this.capabilities.prompts) return [];
    return this.#listCollection('prompts/list', 'prompts');
  }

  async #listCollection(method, field) {
    const values = [];
    let cursor;
    const seen = new Set();
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const params = { ...(cursor ? { cursor } : {}) };
      if (this.protocolVersion === MODERN_VERSION) params._meta = modernMeta();
      const result = await this.#request(method, params);
      if (!Array.isArray(result?.[field]) || values.length + result[field].length > MAX_TOOLS_PER_SERVER)
        throw mcpError(`MCP server '${this.name}' returned invalid or excessive ${field}`, 'MCP_INVALID_RESPONSE');
      values.push(...result[field]);
      cursor = result.nextCursor;
      if (!cursor) return values;
      if (typeof cursor !== 'string' || cursor.length > 1024 || seen.has(cursor))
        throw mcpError(`MCP server '${this.name}' returned an invalid ${field} cursor`, 'MCP_INVALID_RESPONSE');
      seen.add(cursor);
    }
    throw mcpError(`MCP server '${this.name}' exceeded the ${field} pagination limit`, 'MCP_TOOL_LIMIT');
  }

  async readResource(uri) {
    const params = { uri };
    if (this.protocolVersion === MODERN_VERSION) params._meta = modernMeta();
    const result = await this.#request('resources/read', params);
    if (!Array.isArray(result?.contents) || result.contents.length > MAX_TOOLS_PER_SERVER)
      throw mcpError(`MCP server '${this.name}' returned an invalid resource result`, 'MCP_INVALID_RESPONSE');
    return result;
  }

  async getPrompt(name, args) {
    const params = { name, ...(Object.keys(args || {}).length ? { arguments: args } : {}) };
    if (this.protocolVersion === MODERN_VERSION) params._meta = modernMeta();
    const result = await this.#request('prompts/get', params);
    if (!Array.isArray(result?.messages) || result.messages.length > MAX_TOOLS_PER_SERVER)
      throw mcpError(`MCP server '${this.name}' returned an invalid prompt result`, 'MCP_INVALID_RESPONSE');
    return result;
  }

  async callTool(originalName, args) {
    const params = { name: originalName, arguments: args };
    if (this.protocolVersion === MODERN_VERSION) params._meta = modernMeta();
    const result = await this.#request('tools/call', params);
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw mcpError(`MCP server '${this.name}' returned an invalid tool result`, 'MCP_INVALID_RESPONSE');
    return result;
  }

  #request(method, params, timeoutMs = this.timeoutMs, protocolVersion = this.protocolVersion) {
    if (this.closed || this.child.stdin.destroyed || this.child.stdin.writableEnded)
      return Promise.reject(mcpError(`MCP server '${this.name}' is unavailable`, 'MCP_SERVER_UNAVAILABLE'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(mcpError(`MCP server '${this.name}' timed out during ${method}`, 'MCP_TIMEOUT'));
      }, timeoutMs);
      this.pending.set(id, { id, resolve, reject, timer, method, protocolVersion });
      const message = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
      try {
        this.child.stdin.write(message, (error) => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.reject(mcpError(`Unable to write to MCP server '${this.name}'`, 'MCP_TRANSPORT_ERROR'));
        });
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(mcpError(`Unable to write to MCP server '${this.name}'`, 'MCP_TRANSPORT_ERROR'));
      }
    });
  }

  #notify(method, params) {
    if (this.closed || this.child.stdin.destroyed || this.child.stdin.writableEnded) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  #onStdout(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > MAX_LINE_BYTES && !this.buffer.includes('\n')) {
      this.#protocolFailure('MCP response frame exceeded the byte limit');
      return;
    }
    let boundary;
    while ((boundary = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, boundary).trim();
      this.buffer = this.buffer.slice(boundary + 1);
      if (!line) continue;
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) return this.#protocolFailure('MCP response frame exceeded the byte limit');
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return this.#protocolFailure('MCP server emitted invalid JSON-RPC data on stdout');
      }
      if (message?.jsonrpc !== '2.0') return this.#protocolFailure('MCP server emitted an invalid JSON-RPC envelope');
      if (Object.hasOwn(message, 'id') && typeof message.method === 'string') {
        if (message.method === 'ping') this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`);
        else
          this.child.stdin.write(
            `${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client method is unsupported' } })}\n`,
          );
        continue;
      }
      if (!Object.hasOwn(message, 'id')) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      try {
        validateMcpJsonRpcResponse(message, pending.id);
      } catch (error) {
        pending.reject(error);
        continue;
      }
      if (Object.hasOwn(message, 'error'))
        pending.reject(
          mcpError(
            `MCP server '${this.name}' returned JSON-RPC error ${message.error.code}`,
            message.error.code === -32601 ? 'MCP_REMOTE_METHOD_MISSING' : 'MCP_REMOTE_ERROR',
          ),
        );
      else if (!Object.hasOwn(message, 'result'))
        pending.reject(mcpError(`MCP server '${this.name}' returned no result`, 'MCP_INVALID_RESPONSE'));
      else {
        try {
          pending.resolve(
            validateMcpResultType(message.result, {
              protocolVersion: pending.protocolVersion,
              serverName: this.name,
              method: pending.method,
            }),
          );
        } catch (error) {
          pending.reject(error);
        }
      }
    }
  }

  #protocolFailure(reason) {
    this.#failAll(reason, 'MCP_PROTOCOL_ERROR');
    terminateProcessTree(this.child, 'force');
  }

  #failAll(message, code) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(mcpError(message, code));
    }
    this.pending.clear();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.#failAll(`MCP server '${this.name}' was closed`, 'MCP_SERVER_CLOSED');
    if (this.child.stdin && !this.child.stdin.destroyed) this.child.stdin.end();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    terminateProcessTree(this.child, 'graceful');
    const closed = once(this.child, 'close').catch(() => {});
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1200))]);
    if (this.child.exitCode === null && this.child.signalCode === null) terminateProcessTree(this.child, 'force');
  }
}

function normalizeMcpTool(serverName, tool) {
  if (!tool || typeof tool.name !== 'string' || !MCP_NAME.test(tool.name))
    throw mcpError(`MCP server '${serverName}' advertised an invalid tool name`, 'MCP_INVALID_TOOL');
  if (tool.inputSchema?.type !== 'object')
    throw mcpError(`MCP server '${serverName}' tool input schema must have type object`, 'MCP_INVALID_SCHEMA');
  const exposedName = `mcp__${serverName}__${tool.name}`;
  if (exposedName.length > 64)
    throw mcpError(`MCP server '${serverName}' advertised a tool name that exceeds the provider limit`, 'MCP_INVALID_TOOL');
  const parameters = normalizeSchema(tool.inputSchema, 0);
  const note = typeof tool.description === 'string' ? ` Untrusted server description: ${tool.description.slice(0, 1200)}` : '';
  return deepFreeze({
    schema_version: TOOL_SCHEMA_VERSION,
    execution: {
      timeout: mcpTimeoutPolicy(serverName),
      sandbox: 'process',
    },
    name: exposedName,
    description: `MCP server '${serverName}' tool '${tool.name}'.${note}`.slice(0, 1600),
    parameters,
    approval: 'ask',
    destructive: true,
    _mcp: { server: serverName, originalName: tool.name },
  });
}

function normalizeMcpResource(serverName, resource) {
  if (
    !resource ||
    typeof resource.uri !== 'string' ||
    !resource.uri ||
    resource.uri.length > 4096 ||
    typeof resource.name !== 'string' ||
    !resource.name
  )
    throw mcpError(`MCP server '${serverName}' advertised an invalid resource`, 'MCP_INVALID_RESOURCE');
  const name = `mcp__${serverName}__resource_${createHash('sha256').update(resource.uri).digest('hex').slice(0, 12)}`;
  const note = typeof resource.description === 'string' ? ` Untrusted resource description: ${resource.description.slice(0, 1000)}` : '';
  return deepFreeze({
    schema_version: TOOL_SCHEMA_VERSION,
    execution: { timeout: mcpTimeoutPolicy(serverName), sandbox: 'unsupported' },
    name,
    description: `Read the configured MCP resource '${resource.name}'.${note}`.slice(0, 1600),
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    approval: 'ask',
    destructive: true,
    _mcp: { server: serverName, operation: 'resources/read', resourceUri: resource.uri },
  });
}

function normalizeMcpResourceTemplate(serverName, resourceTemplate) {
  if (
    !resourceTemplate ||
    typeof resourceTemplate.uriTemplate !== 'string' ||
    !resourceTemplate.uriTemplate ||
    resourceTemplate.uriTemplate.length > 4096 ||
    typeof resourceTemplate.name !== 'string' ||
    !resourceTemplate.name ||
    resourceTemplate.name.length > 256
  )
    throw mcpError(`MCP server '${serverName}' advertised an invalid resource template`, 'MCP_INVALID_RESOURCE_TEMPLATE');

  const variableNames = extractUriTemplateVariables(resourceTemplate.uriTemplate, serverName);

  const properties = Object.fromEntries(variableNames.map((name) => [name, { type: 'string', maxLength: 2048 }]));
  const uriTemplate = resourceTemplate.uriTemplate;
  const name = `mcp__resource_template_${createHash('sha256').update(`${serverName}\0${uriTemplate}`).digest('hex').slice(0, 32)}`;
  const note =
    typeof resourceTemplate.description === 'string' ? ` Untrusted server description: ${resourceTemplate.description.slice(0, 1000)}` : '';
  return deepFreeze({
    schema_version: TOOL_SCHEMA_VERSION,
    execution: { timeout: mcpTimeoutPolicy(serverName), sandbox: 'unsupported' },
    name,
    description: `Read a resource matching the configured MCP template '${resourceTemplate.name}'.${note}`.slice(0, 1600),
    parameters: { type: 'object', properties, additionalProperties: false },
    approval: 'ask',
    destructive: true,
    _mcp: { server: serverName, operation: 'resources/templates/read', uriTemplate, variableNames },
  });
}

function expandResourceTemplate(metadata, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw mcpError('MCP resource template arguments must be an object', 'MCP_INVALID_ARGUMENTS');
  const allowed = new Set(metadata.variableNames);
  if (Object.keys(args).some((key) => !allowed.has(key)))
    throw mcpError('MCP resource template arguments do not match its URI variables', 'MCP_INVALID_ARGUMENTS');
  for (const key of Object.keys(args)) {
    if (typeof args[key] !== 'string' || args[key].length > 2048)
      throw mcpError('MCP resource template values must be strings of at most 2048 characters', 'MCP_INVALID_ARGUMENTS');
  }

  const uri = uriTemplates(metadata.uriTemplate).fill(args);
  if (uri.length > 4096) throw mcpError('Expanded MCP resource URI exceeds 4096 characters', 'MCP_INVALID_ARGUMENTS');
  return uri;
}

function extractUriTemplateVariables(template, serverName) {
  const invalid = () => mcpError(`MCP server '${serverName}' advertised an invalid resource URI template`, 'MCP_INVALID_RESOURCE_TEMPLATE');
  const variableNames = [];
  const remainder = template.replace(/\{([^{}]+)\}/g, (_expression, expression) => {
    const parts = expression.replace(/^[+#./;?&]/, '').split(',');
    for (const part of parts) {
      const name = part.replace(/(?:\*|:\d{1,4})$/, '');
      if (name.length > 64 || !/^(?:[A-Za-z0-9_.~-]|%[\da-fA-F]{2})+$/.test(name) || name.endsWith('.')) throw invalid();
      if (!variableNames.includes(name)) variableNames.push(name);
    }
    return '';
  });
  if (/[{}]/.test(remainder) || variableNames.length > 64) throw invalid();
  try {
    uriTemplates(template);
  } catch {
    throw invalid();
  }
  return variableNames;
}

function normalizeMcpPrompt(serverName, prompt) {
  if (!prompt || typeof prompt.name !== 'string' || !prompt.name || prompt.name.length > 256 || !Array.isArray(prompt.arguments || []))
    throw mcpError(`MCP server '${serverName}' advertised an invalid prompt`, 'MCP_INVALID_PROMPT');
  const argumentsList = prompt.arguments || [];
  if (argumentsList.length > 64) throw mcpError(`MCP server '${serverName}' prompt has too many arguments`, 'MCP_INVALID_PROMPT');
  const properties = {};
  const required = [];
  for (const argument of argumentsList) {
    if (
      !argument ||
      typeof argument.name !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(argument.name) ||
      Object.hasOwn(properties, argument.name)
    )
      throw mcpError(`MCP server '${serverName}' prompt has an invalid argument`, 'MCP_INVALID_PROMPT');
    properties[argument.name] = {
      type: 'string',
      ...(typeof argument.description === 'string'
        ? { description: `Untrusted prompt argument note: ${argument.description.slice(0, 1000)}` }
        : {}),
    };
    if (argument.required === true) required.push(argument.name);
    else if (argument.required !== undefined && typeof argument.required !== 'boolean')
      throw mcpError(`MCP server '${serverName}' prompt argument has invalid required flag`, 'MCP_INVALID_PROMPT');
  }
  const name = `mcp__${serverName}__prompt_${createHash('sha256').update(prompt.name).digest('hex').slice(0, 12)}`;
  const note = typeof prompt.description === 'string' ? ` Untrusted prompt description: ${prompt.description.slice(0, 1000)}` : '';
  return deepFreeze({
    schema_version: TOOL_SCHEMA_VERSION,
    execution: { timeout: mcpTimeoutPolicy(serverName), sandbox: 'unsupported' },
    name,
    description: `Get configured MCP prompt '${prompt.name}'.${note}`.slice(0, 1600),
    parameters: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false },
    approval: 'ask',
    destructive: true,
    _mcp: { server: serverName, operation: 'prompts/get', promptName: prompt.name },
  });
}

function mcpTimeoutPolicy(serverName) {
  return {
    kind: 'config_ms',
    config_path: `mcp.servers.${serverName}.timeout_ms`,
    fallback_path: 'mcp.timeout_ms',
    default_ms: 15_000,
    min_ms: 1_000,
    max_ms: 120_000,
  };
}

function normalizeSchema(schema, depth, budget = { remaining: 512 }) {
  if (--budget.remaining < 0) throw mcpError('MCP tool input schema exceeds its validation budget', 'MCP_INVALID_SCHEMA');
  if (typeof schema === 'boolean') return schema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 8)
    throw mcpError('MCP tool input schema is invalid or too deeply nested', 'MCP_INVALID_SCHEMA');
  const allowed = new Set([
    '$schema',
    '$comment',
    'type',
    'title',
    'description',
    'format',
    'default',
    'examples',
    'deprecated',
    'readOnly',
    'writeOnly',
    'properties',
    'patternProperties',
    'propertyNames',
    'required',
    'dependentRequired',
    'dependentSchemas',
    'additionalProperties',
    'items',
    'minimum',
    'maximum',
    'minLength',
    'maxLength',
    'pattern',
    'minItems',
    'maxItems',
    'minProperties',
    'maxProperties',
    'uniqueItems',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'enum',
    'const',
    'allOf',
    'anyOf',
    'oneOf',
    'not',
    'if',
    'then',
    'else',
  ]);
  if (Object.keys(schema).some((key) => !allowed.has(key)))
    throw mcpError('MCP tool uses an unsupported JSON Schema keyword', 'MCP_INVALID_SCHEMA');
  const type = schema.type;
  const hasType = Object.hasOwn(schema, 'type');
  if (!hasType && depth === 0) throw mcpError('MCP tool input schema must declare a root type', 'MCP_INVALID_SCHEMA');
  const types = Array.isArray(type) ? type : [type];
  if (
    (hasType && types.length === 0) ||
    new Set(types).size !== types.length ||
    (hasType && types.some((item) => !['object', 'string', 'integer', 'number', 'boolean', 'array', 'null'].includes(item)))
  )
    throw mcpError('MCP tool input schema uses an unsupported type', 'MCP_INVALID_SCHEMA');
  const result = hasType ? { type } : {};
  for (const key of ['$schema', '$comment', 'format'])
    if (schema[key] !== undefined) {
      if (typeof schema[key] !== 'string') throw mcpError(`MCP tool input schema has invalid ${key}`, 'MCP_INVALID_SCHEMA');
      result[key] = schema[key];
    }
  if (schema.examples !== undefined && !Array.isArray(schema.examples))
    throw mcpError('MCP tool input schema has invalid examples', 'MCP_INVALID_SCHEMA');
  for (const key of ['deprecated', 'readOnly', 'writeOnly'])
    if (schema[key] !== undefined) {
      if (typeof schema[key] !== 'boolean') throw mcpError(`MCP tool input schema has invalid ${key}`, 'MCP_INVALID_SCHEMA');
      result[key] = schema[key];
    }
  for (const key of ['default', 'examples']) if (Object.hasOwn(schema, key)) result[key] = schema[key];
  for (const key of ['title', 'description'])
    if (schema[key] !== undefined) {
      if (typeof schema[key] !== 'string' || schema[key].length > 2000)
        throw mcpError('MCP tool input schema contains invalid documentation text', 'MCP_INVALID_SCHEMA');
      result[key] = key === 'description' && depth > 0 ? `Untrusted server-provided schema note: ${schema[key]}` : schema[key];
    }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length > 100)
      throw mcpError('MCP tool input schema has an invalid enum', 'MCP_INVALID_SCHEMA');
    result.enum = schema.enum;
  }
  if (Object.hasOwn(schema, 'const')) result.const = schema.const;
  if (schema.allOf !== undefined) {
    if (!Array.isArray(schema.allOf) || schema.allOf.length === 0 || schema.allOf.length > 8)
      throw mcpError('MCP tool input schema has invalid allOf', 'MCP_INVALID_SCHEMA');
    result.allOf = schema.allOf.map((item) => normalizeSchema(item, depth + 1, budget));
  }
  for (const key of ['anyOf', 'oneOf'])
    if (schema[key] !== undefined) {
      if (!Array.isArray(schema[key]) || schema[key].length === 0 || schema[key].length > 8)
        throw mcpError(`MCP tool input schema has invalid ${key}`, 'MCP_INVALID_SCHEMA');
      result[key] = schema[key].map((item) => normalizeSchema(item, depth + 1, budget));
    }
  if (schema.not !== undefined) result.not = normalizeSchema(schema.not, depth + 1, budget);
  for (const key of ['if', 'then', 'else']) if (schema[key] !== undefined) result[key] = normalizeSchema(schema[key], depth + 1, budget);
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'])
    if (schema[key] !== undefined) {
      if (!Number.isFinite(schema[key])) throw mcpError('MCP tool input schema has invalid numeric bounds', 'MCP_INVALID_SCHEMA');
      result[key] = schema[key];
    }
  if (schema.multipleOf !== undefined) {
    if (!Number.isFinite(schema.multipleOf) || schema.multipleOf <= 0)
      throw mcpError('MCP tool input schema has invalid multipleOf', 'MCP_INVALID_SCHEMA');
    result.multipleOf = schema.multipleOf;
  }
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'])
    if (schema[key] !== undefined) {
      if (!Number.isInteger(schema[key]) || schema[key] < 0 || schema[key] > 1_000_000)
        throw mcpError('MCP tool input schema has invalid size bounds', 'MCP_INVALID_SCHEMA');
      result[key] = schema[key];
    }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== 'string' || schema.pattern.length > 256)
      throw mcpError('MCP tool input schema has invalid pattern', 'MCP_INVALID_SCHEMA');
    try {
      new RegExp(schema.pattern);
    } catch {
      throw mcpError('MCP tool input schema has invalid pattern', 'MCP_INVALID_SCHEMA');
    }
    result.pattern = schema.pattern;
  }
  if (result.minimum !== undefined && result.maximum !== undefined && result.minimum > result.maximum)
    throw mcpError('MCP tool input schema has inconsistent numeric bounds', 'MCP_INVALID_SCHEMA');
  if (result.minLength !== undefined && result.maxLength !== undefined && result.minLength > result.maxLength)
    throw mcpError('MCP tool input schema has inconsistent string bounds', 'MCP_INVALID_SCHEMA');
  if (result.minItems !== undefined && result.maxItems !== undefined && result.minItems > result.maxItems)
    throw mcpError('MCP tool input schema has inconsistent array bounds', 'MCP_INVALID_SCHEMA');
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== 'boolean')
    throw mcpError('MCP tool input schema has invalid uniqueItems', 'MCP_INVALID_SCHEMA');
  if (schema.uniqueItems !== undefined) result.uniqueItems = schema.uniqueItems;
  const objectKeywords = [
    'properties',
    'required',
    'dependentRequired',
    'dependentSchemas',
    'additionalProperties',
    'patternProperties',
    'propertyNames',
  ];
  const hasObjectKeywords = objectKeywords.some((key) => schema[key] !== undefined);
  if (types.includes('object') || hasObjectKeywords) {
    if (
      schema.properties !== undefined &&
      (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties))
    )
      throw mcpError('MCP tool input schema has invalid properties', 'MCP_INVALID_SCHEMA');
    const properties = schema.properties || {};
    if (Object.keys(properties).length > 64) throw mcpError('MCP object schema exceeds the property limit', 'MCP_INVALID_SCHEMA');
    result.properties = Object.fromEntries(
      Object.entries(properties).map(([key, value]) => {
        if (key.length > 128) throw mcpError('MCP tool input schema has an invalid property name', 'MCP_INVALID_SCHEMA');
        return [key, normalizeSchema(value, depth + 1, budget)];
      }),
    );
    if (
      schema.required !== undefined &&
      (!Array.isArray(schema.required) ||
        new Set(schema.required).size !== schema.required.length ||
        schema.required.some((key) => typeof key !== 'string'))
    )
      throw mcpError('MCP tool input schema has invalid required properties', 'MCP_INVALID_SCHEMA');
    if (schema.required) result.required = [...new Set(schema.required)];
    if (schema.dependentRequired !== undefined) {
      if (!schema.dependentRequired || typeof schema.dependentRequired !== 'object' || Array.isArray(schema.dependentRequired))
        throw mcpError('MCP object schema has invalid dependentRequired', 'MCP_INVALID_SCHEMA');
      const dependencies = Object.entries(schema.dependentRequired);
      if (dependencies.length > 64) throw mcpError('MCP dependentRequired exceeds its entry limit', 'MCP_INVALID_SCHEMA');
      result.dependentRequired = Object.fromEntries(
        dependencies.map(([key, names]) => {
          if (
            key.length > 128 ||
            !Array.isArray(names) ||
            names.length > 64 ||
            new Set(names).size !== names.length ||
            names.some((name) => typeof name !== 'string' || name.length > 128)
          )
            throw mcpError('MCP object schema has invalid dependentRequired entries', 'MCP_INVALID_SCHEMA');
          return [key, names];
        }),
      );
    }
    if (schema.dependentSchemas !== undefined) {
      if (!schema.dependentSchemas || typeof schema.dependentSchemas !== 'object' || Array.isArray(schema.dependentSchemas))
        throw mcpError('MCP object schema has invalid dependentSchemas', 'MCP_INVALID_SCHEMA');
      const dependencies = Object.entries(schema.dependentSchemas);
      if (dependencies.length > 64) throw mcpError('MCP dependentSchemas exceeds its entry limit', 'MCP_INVALID_SCHEMA');
      result.dependentSchemas = Object.fromEntries(
        dependencies.map(([key, child]) => {
          if (key.length > 128) throw mcpError('MCP dependentSchemas key is too long', 'MCP_INVALID_SCHEMA');
          return [key, normalizeSchema(child, depth + 1, budget)];
        }),
      );
    }
    if (schema.patternProperties !== undefined) {
      if (!schema.patternProperties || typeof schema.patternProperties !== 'object' || Array.isArray(schema.patternProperties))
        throw mcpError('MCP object schema has invalid patternProperties', 'MCP_INVALID_SCHEMA');
      const entries = Object.entries(schema.patternProperties);
      if (entries.length > 16) throw mcpError('MCP object schema exceeds the patternProperties limit', 'MCP_INVALID_SCHEMA');
      result.patternProperties = Object.fromEntries(
        entries.map(([pattern, child]) => {
          if (pattern.length > 256) throw mcpError('MCP patternProperties key is too long', 'MCP_INVALID_SCHEMA');
          try {
            new RegExp(pattern);
          } catch {
            throw mcpError('MCP patternProperties key is invalid', 'MCP_INVALID_SCHEMA');
          }
          return [pattern, normalizeSchema(child, depth + 1, budget)];
        }),
      );
    }
    if (schema.propertyNames !== undefined) result.propertyNames = normalizeSchema(schema.propertyNames, depth + 1, budget);
    if (schema.additionalProperties !== undefined) {
      if (
        typeof schema.additionalProperties !== 'boolean' &&
        (!schema.additionalProperties || typeof schema.additionalProperties !== 'object')
      )
        throw mcpError('MCP object schema has invalid additionalProperties', 'MCP_INVALID_SCHEMA');
      result.additionalProperties = normalizeSchema(schema.additionalProperties, depth + 1, budget);
    }
  }
  if (
    types.includes('array') ||
    schema.items !== undefined ||
    (!hasType && ['minItems', 'maxItems', 'uniqueItems'].some((key) => schema[key] !== undefined))
  ) {
    if (schema.items !== undefined) result.items = normalizeSchema(schema.items, depth + 1, budget);
  }
  return result;
}

function modernMeta() {
  return {
    'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
    'io.modelcontextprotocol/clientInfo': CLIENT_INFO,
    'io.modelcontextprotocol/clientCapabilities': {},
  };
}

function mcpError(message, code) {
  return Object.assign(new Error(message), { code });
}

async function resolveLinuxExecutable(command, cwd, environment) {
  const hasDirectory = path.isAbsolute(command) || command.includes(path.sep);
  const candidates = hasDirectory
    ? [path.isAbsolute(command) ? command : path.resolve(cwd, command)]
    : String(environment.PATH || '/usr/bin:/bin')
        .split(path.delimiter)
        .filter(Boolean)
        .map((directory) => path.join(directory, command));
  for (const candidate of candidates) {
    try {
      const resolved = await fs.realpath(candidate);
      const stat = await fs.stat(resolved);
      await fs.access(resolved, fsConstants.X_OK);
      if (stat.isFile()) return resolved;
    } catch {
      /* keep searching the configured PATH */
    }
  }
  throw mcpError(`Could not resolve an executable for sandboxed MCP server: ${command}`, 'MCP_EXECUTABLE_NOT_FOUND');
}
