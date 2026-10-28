import { resolveToolTimeoutMs, TOOL_SCHEMA_VERSION, deepFreeze, validateMcpToolOutput } from './schemas.mjs';
import { validateMcpInitializeResult, validateMcpJsonRpcResponse, validateMcpResultType } from './mcp-protocol.mjs';

const VERSION = '2026-07-28';
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const RESUMABLE_STREAMABLE = new Set(['2025-11-25', '2025-06-18', '2025-03-26']);
const SSE_VERSION = '2024-11-05';
const CLIENT = { name: 'xyst-agent', version: '0.1.0' };
const MAX_BODY = 1_048_576;
const MAX_SSE_RESUMPTIONS = 3;
const MAX_TOOLS = 128;
const MAX_PAGES = 32;
const NAME = /^[A-Za-z0-9_-]{1,48}$/;
const SSE_LAST_EVENT_ID = Symbol('sseLastEventId');

/** Request/response Streamable HTTP transport. Redirects are rejected to keep credentials endpoint-bound. */
export class StreamableHttpMcpSession {
  constructor({ name, settings, headers, timeoutMs, fetchImpl = fetch, onNotification }) {
    this.name = name;
    this.url = settings.url;
    this.headers = headers;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.onNotification = onNotification;
    this.version = null;
    this.capabilities = {};
    this.serverInfo = null;
    this.nextId = 0;
    this.sessionId = null;
    this.sessionRecovery = null;
    this.closed = false;
    this.subscriptionController = null;
    this.subscriptionPromise = null;
    this.subscriptionRetryTimer = null;
    this.subscriptionRetryDelayMs = 1_000;
  }

  static async start({ name, settings, config, secretStore, fetchImpl = fetch, onNotification }) {
    const { headers, timeoutMs } = await resolveHttpOptions({ name, settings, config, secretStore });
    const session = new StreamableHttpMcpSession({ name, settings, headers, timeoutMs, fetchImpl, onNotification });
    try {
      await session.negotiate();
      return session;
    } catch (error) {
      await session.close();
      if (error.code === 'MCP_HTTP_STATUS' && [404, 405].includes(error.status)) {
        const legacySession = new LegacySseMcpSession({ name, settings, headers, timeoutMs, fetchImpl, onNotification });
        try {
          await legacySession.negotiate();
          return legacySession;
        } catch (legacyError) {
          await legacySession.close();
          throw legacyError;
        }
      }
      throw error;
    }
  }

  async negotiate() {
    try {
      const discovered = await this.request(
        'server/discover',
        { _meta: modernMeta() },
        { timeoutMs: Math.min(this.timeoutMs, 1800), allowError: true, protocolVersion: VERSION },
      );
      if (discovered.supportedVersions.includes(VERSION)) {
        this.version = VERSION;
        this.capabilities = discovered.capabilities;
        this.serverInfo = discovered._meta?.['io.modelcontextprotocol/serverInfo'] || discovered.serverInfo || null;
        return;
      }
      if (!discovered.supportedVersions.some((version) => LEGACY.includes(version)))
        throw mcpError('MCP server does not support a compatible protocol version', 'MCP_VERSION_UNSUPPORTED');
    } catch (error) {
      if (error.code !== 'MCP_REMOTE_METHOD_MISSING' && !(error.code === 'MCP_HTTP_STATUS' && [404, 405].includes(error.status)))
        throw error;
    }
    await this.#initializeLegacy();
  }

  async #initializeLegacy({ signal } = {}) {
    this.sessionId = null;
    const initialized = validateMcpInitializeResult(
      await this.request(
        'initialize',
        {
          protocolVersion: LEGACY[0],
          capabilities: {},
          clientInfo: CLIENT,
        },
        { protocolVersion: LEGACY[0], methodHeader: false, signal },
      ),
      { serverName: this.name },
    );
    if (!LEGACY.includes(initialized?.protocolVersion))
      throw mcpError('MCP server negotiated an unsupported protocol version', 'MCP_VERSION_UNSUPPORTED');
    this.version = initialized.protocolVersion;
    this.capabilities = initialized.capabilities || {};
    this.serverInfo = initialized.serverInfo || null;
    await this.request('notifications/initialized', {}, { notification: true, protocolVersion: this.version, methodHeader: false, signal });
  }

  async listTools() {
    const tools = [];
    let cursor;
    const seen = new Set();
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const params = { ...(cursor ? { cursor } : {}) };
      if (this.version === VERSION) params._meta = modernMeta();
      const result = await this.request('tools/list', params);
      if (!Array.isArray(result?.tools) || tools.length + result.tools.length > MAX_TOOLS)
        throw mcpError(`MCP server '${this.name}' returned invalid or excessive tools`, 'MCP_TOOL_LIMIT');
      tools.push(...result.tools.map((tool) => normalizeTool(this.name, tool)));
      cursor = result.nextCursor;
      if (!cursor) return tools;
      if (typeof cursor !== 'string' || cursor.length > 1024 || seen.has(cursor))
        throw mcpError('MCP server returned an invalid pagination cursor', 'MCP_INVALID_RESPONSE');
      seen.add(cursor);
    }
    throw mcpError('MCP server exceeded the pagination limit', 'MCP_TOOL_LIMIT');
  }

  async listResources() {
    if (!this.capabilities.resources) return [];
    return this.#listCollection('resources/list', 'resources');
  }

  async listResourceTemplates() {
    if (!this.capabilities.resources) return [];
    try {
      return await this.#listCollection('resources/templates/list', 'resourceTemplates', { allowMissing: true });
    } catch (error) {
      if (error.code === 'MCP_REMOTE_METHOD_MISSING') return [];
      throw error;
    }
  }

  async listPrompts() {
    if (!this.capabilities.prompts) return [];
    return this.#listCollection('prompts/list', 'prompts');
  }

  async #listCollection(method, field, { allowMissing = false } = {}) {
    const values = [];
    let cursor;
    const seen = new Set();
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const params = { ...(cursor ? { cursor } : {}) };
      if (this.version === VERSION) params._meta = modernMeta();
      const result = await this.request(method, params, { allowError: allowMissing });
      if (!Array.isArray(result?.[field]) || values.length + result[field].length > MAX_TOOLS)
        throw mcpError(`MCP server '${this.name}' returned invalid or excessive ${field}`, 'MCP_INVALID_RESPONSE');
      values.push(...result[field]);
      cursor = result.nextCursor;
      if (!cursor) return values;
      if (typeof cursor !== 'string' || cursor.length > 1024 || seen.has(cursor))
        throw mcpError(`MCP server returned an invalid ${field} cursor`, 'MCP_INVALID_RESPONSE');
      seen.add(cursor);
    }
    throw mcpError(`MCP server exceeded the ${field} pagination limit`, 'MCP_TOOL_LIMIT');
  }

  async readResource(uri, { signal } = {}) {
    const params = { uri };
    if (this.version === VERSION) params._meta = modernMeta();
    const extraHeaders = this.version === VERSION ? { 'Mcp-Name': encodeHeaderValue(uri) } : {};
    const result = await this.request('resources/read', params, { signal, extraHeaders });
    if (!Array.isArray(result?.contents) || result.contents.length > MAX_TOOLS)
      throw mcpError(`MCP server '${this.name}' returned an invalid resource result`, 'MCP_INVALID_RESPONSE');
    return result;
  }

  async getPrompt(name, args, { signal } = {}) {
    const params = { name, ...(Object.keys(args || {}).length ? { arguments: args } : {}) };
    if (this.version === VERSION) params._meta = modernMeta();
    const extraHeaders = this.version === VERSION ? { 'Mcp-Name': encodeHeaderValue(name) } : {};
    const result = await this.request('prompts/get', params, { signal, extraHeaders });
    if (!Array.isArray(result?.messages) || result.messages.length > MAX_TOOLS)
      throw mcpError(`MCP server '${this.name}' returned an invalid prompt result`, 'MCP_INVALID_RESPONSE');
    return result;
  }

  async callTool(name, args, { signal, headerParameters = [], outputSchema } = {}) {
    const params = { name, arguments: args };
    if (this.version === VERSION) params._meta = modernMeta();
    const extraHeaders = {};
    if (this.version === VERSION) {
      extraHeaders['Mcp-Name'] = encodeHeaderValue(name);
      for (const { name: headerName, path } of headerParameters) {
        let value = args;
        for (const key of path) value = value && typeof value === 'object' ? value[key] : undefined;
        if (value !== undefined) extraHeaders[`Mcp-Param-${headerName}`] = encodeHeaderValue(String(value));
      }
    }
    const result = await this.request('tools/call', params, { signal, extraHeaders });
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw mcpError('MCP server returned an invalid tool result', 'MCP_INVALID_RESPONSE');
    return validateMcpToolOutput(outputSchema, result);
  }

  async request(
    method,
    params,
    {
      timeoutMs = this.timeoutMs,
      signal,
      protocolVersion = this.version,
      methodHeader = true,
      notification = false,
      allowError = false,
      extraHeaders = {},
      recoveryAttempt = false,
    } = {},
  ) {
    if (this.closed) throw mcpError(`MCP server '${this.name}' is closed`, 'MCP_SERVER_CLOSED');
    const id = notification ? undefined : ++this.nextId;
    const sessionIdForRequest = protocolVersion === VERSION ? null : this.sessionId;
    const body = JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params });
    const headers = new Headers({ ...this.headers, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' });
    for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
    if (protocolVersion === VERSION) {
      headers.set('MCP-Protocol-Version', VERSION);
      if (methodHeader) headers.set('Mcp-Method', method);
    } else if (protocolVersion) headers.set('MCP-Protocol-Version', protocolVersion);
    if (sessionIdForRequest) headers.set('Mcp-Session-Id', sessionIdForRequest);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const response = await this.fetchImpl(this.url, { method: 'POST', headers, body, signal: controller.signal, redirect: 'error' });
      if (response.status === 404 && sessionIdForRequest && !recoveryAttempt && method !== 'initialize') {
        try {
          await response.body?.cancel();
        } catch {}
        if (this.sessionId === sessionIdForRequest) await this.#recoverLegacySession(signal);
        else if (this.sessionRecovery) await this.sessionRecovery;
        return this.request(method, params, {
          timeoutMs,
          signal,
          protocolVersion: this.version,
          methodHeader,
          notification,
          allowError,
          extraHeaders,
          recoveryAttempt: true,
        });
      }
      if (!response.ok) {
        if (allowError && response.status === 404) throw mcpError('MCP_REMOTE_METHOD_MISSING', 'MCP_REMOTE_METHOD_MISSING');
        throw mcpError(`MCP server '${this.name}' returned HTTP ${response.status}`, 'MCP_HTTP_STATUS', { status: response.status });
      }
      if (notification) {
        if (![200, 202, 204].includes(response.status))
          throw mcpError('MCP notification returned an invalid HTTP status', 'MCP_INVALID_RESPONSE');
        await readBounded(response, MAX_BODY);
        return null;
      }
      const contentType = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
      let message = null;
      if (contentType === 'application/json') message = await readJson(response);
      else if (contentType === 'text/event-stream') {
        try {
          message = (await readSse(response, MAX_BODY, id)).message;
        } catch (error) {
          const lastEventId = error[SSE_LAST_EVENT_ID];
          if (!RESUMABLE_STREAMABLE.has(protocolVersion) || !lastEventId) throw error;
          if (signal?.aborted) throw mcpError(`MCP call '${method}' was cancelled`, 'MCP_CANCELLED');
          if (controller.signal.aborted) throw mcpError(`MCP server '${this.name}' timed out during ${method}`, 'MCP_TIMEOUT');
          const resumeSessionId =
            method === 'initialize' && protocolVersion !== VERSION
              ? validateSessionId(response.headers.get('mcp-session-id'))
              : sessionIdForRequest;
          message = await this.#resumeStream(id, protocolVersion, resumeSessionId, lastEventId, controller.signal);
        }
      }
      validateMcpJsonRpcResponse(message, id);
      if (Object.hasOwn(message, 'error')) {
        const err = mcpError(
          `MCP server '${this.name}' returned JSON-RPC error ${Number.isInteger(message.error.code) ? message.error.code : 'unknown'}`,
          allowError && message.error.code === -32601 ? 'MCP_REMOTE_METHOD_MISSING' : 'MCP_REMOTE_ERROR',
        );
        if (allowError) throw err;
        throw err;
      }
      if (!Object.hasOwn(message, 'result')) throw mcpError('MCP server returned no result', 'MCP_INVALID_RESPONSE');
      if (method === 'initialize' && protocolVersion !== VERSION)
        this.sessionId = validateSessionId(response.headers.get('mcp-session-id'));
      return validateMcpResultType(message.result, { protocolVersion, serverName: this.name, method });
    } catch (error) {
      if (error.code) throw error;
      if (signal?.aborted) throw mcpError(`MCP call '${method}' was cancelled`, 'MCP_CANCELLED');
      if (controller.signal.aborted) throw mcpError(`MCP server '${this.name}' timed out during ${method}`, 'MCP_TIMEOUT');
      throw mcpError(`MCP transport failed during ${method}`, 'MCP_TRANSPORT_ERROR');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  async #resumeStream(expectedId, protocolVersion, sessionId, initialEventId, signal) {
    let lastEventId = initialEventId;
    for (let attempt = 0; attempt < MAX_SSE_RESUMPTIONS; attempt += 1) {
      const headers = new Headers({ ...this.headers, Accept: 'text/event-stream' });
      headers.set('MCP-Protocol-Version', protocolVersion);
      headers.set('Last-Event-ID', lastEventId);
      if (sessionId) headers.set('Mcp-Session-Id', sessionId);
      const response = await this.fetchImpl(this.url, { method: 'GET', headers, signal, redirect: 'error' });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {}
        throw mcpError(`MCP server '${this.name}' returned HTTP ${response.status} while resuming an event stream`, 'MCP_HTTP_STATUS', {
          status: response.status,
        });
      }
      const contentType = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
      if (contentType !== 'text/event-stream' || !response.body) {
        try {
          await response.body?.cancel();
        } catch {}
        throw mcpError('MCP server did not resume the event stream', 'MCP_INVALID_RESPONSE');
      }
      try {
        return (await readSse(response, MAX_BODY, expectedId)).message;
      } catch (error) {
        const nextEventId = error[SSE_LAST_EVENT_ID];
        if (!nextEventId || nextEventId === lastEventId || attempt === MAX_SSE_RESUMPTIONS - 1) throw error;
        lastEventId = nextEventId;
      }
    }
    throw mcpError('MCP event stream could not be resumed', 'MCP_TRANSPORT_ERROR');
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.subscriptionRetryTimer);
    this.subscriptionRetryTimer = null;
    this.subscriptionController?.abort();
    const sessionId = this.sessionId;
    this.sessionId = null;
    if (!sessionId || this.version === VERSION) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 5_000));
    try {
      const headers = new Headers(this.headers);
      headers.set('Mcp-Session-Id', sessionId);
      if (this.version) headers.set('MCP-Protocol-Version', this.version);
      const response = await this.fetchImpl(this.url, { method: 'DELETE', headers, redirect: 'error', signal: controller.signal });
      try {
        await response.body?.cancel();
      } catch {}
    } catch {
      // Session cleanup is best-effort; server shutdown must not be held by a remote endpoint.
    } finally {
      clearTimeout(timer);
    }
  }

  async listenForChanges() {
    if (this.closed || this.version !== VERSION || this.subscriptionController) return false;
    const notifications = {
      toolsListChanged: this.capabilities.tools?.listChanged === true,
      resourcesListChanged: this.capabilities.resources?.listChanged === true,
      promptsListChanged: this.capabilities.prompts?.listChanged === true,
    };
    if (!Object.values(notifications).some(Boolean)) return false;

    const id = ++this.nextId;
    const controller = new AbortController();
    this.subscriptionController = controller;
    const task = pumpHttpSubscription(this, { id, notifications, controller });
    this.subscriptionPromise = task;
    try {
      return await task;
    } catch (error) {
      controller.abort();
      if (this.subscriptionPromise === task) this.subscriptionPromise = null;
      if (this.subscriptionController === controller) this.subscriptionController = null;
      this.#scheduleSubscriptionRetry();
      throw error;
    }
  }

  #scheduleSubscriptionRetry() {
    if (this.closed || this.version !== VERSION || this.subscriptionRetryTimer) return;
    const delay = this.subscriptionRetryDelayMs;
    this.subscriptionRetryDelayMs = Math.min(this.subscriptionRetryDelayMs * 2, 30_000);
    this.subscriptionRetryTimer = setTimeout(() => {
      this.subscriptionRetryTimer = null;
      void this.listenForChanges().catch(() => {});
    }, delay);
  }

  subscriptionEnded(controller) {
    if (this.subscriptionController !== controller) return;
    this.subscriptionController = null;
    this.subscriptionPromise = null;
    if (!this.closed) this.#scheduleSubscriptionRetry();
  }

  async #recoverLegacySession(signal) {
    if (!this.sessionRecovery) {
      const recovery = this.#initializeLegacy({ signal });
      this.sessionRecovery = recovery;
    }
    const recovery = this.sessionRecovery;
    try {
      await recovery;
    } finally {
      if (this.sessionRecovery === recovery) this.sessionRecovery = null;
    }
  }
}

async function pumpHttpSubscription(session, { id, notifications, controller }) {
  const headers = new Headers({ ...session.headers, Accept: 'text/event-stream', 'Content-Type': 'application/json' });
  headers.set('MCP-Protocol-Version', VERSION);
  headers.set('Mcp-Method', 'subscriptions/listen');
  const body = JSON.stringify({ jsonrpc: '2.0', id, method: 'subscriptions/listen', params: { _meta: modernMeta(), notifications } });
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), session.timeoutMs);
  let acknowledged = false;
  let acceptedFilters = {};
  let resolveAck;
  let rejectAck;
  const ack = new Promise((resolve, reject) => {
    resolveAck = resolve;
    rejectAck = reject;
  });
  ack.catch(() => {});
  try {
    const response = await session.fetchImpl(session.url, { method: 'POST', headers, body, signal: controller.signal, redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw mcpError(`MCP subscription returned HTTP ${response.status}`, 'MCP_HTTP_STATUS', { status: response.status });
    }
    const contentType = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'text/event-stream' || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw mcpError('MCP subscription did not return an event stream', 'MCP_INVALID_RESPONSE');
    }
    const reader = response.body.getReader();
    void readHttpSubscription(reader, (message) => {
      if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string')
        throw mcpError('MCP subscription emitted an invalid JSON-RPC notification', 'MCP_INVALID_RESPONSE');
      const params = message.params && typeof message.params === 'object' && !Array.isArray(message.params) ? message.params : {};
      const subscriptionId = params._meta?.['io.modelcontextprotocol/subscriptionId'];
      if (!acknowledged) {
        if (message.method !== 'notifications/subscriptions/acknowledged' || subscriptionId !== id)
          throw mcpError('MCP subscription did not begin with a matching acknowledgment', 'MCP_INVALID_RESPONSE');
        const accepted = params.notifications;
        if (!accepted || typeof accepted !== 'object' || Array.isArray(accepted))
          throw mcpError('MCP subscription acknowledgment was invalid', 'MCP_INVALID_RESPONSE');
        for (const [key, value] of Object.entries(accepted))
          if (!Object.hasOwn(notifications, key) || typeof value !== 'boolean' || (value && !notifications[key]))
            throw mcpError('MCP subscription acknowledgment accepted an invalid notification filter', 'MCP_INVALID_RESPONSE');
        acknowledged = true;
        acceptedFilters = accepted;
        session.subscriptionRetryDelayMs = 1_000;
        clearTimeout(timeout);
        resolveAck(true);
        return;
      }
      if (subscriptionId !== id) return;
      const keys = {
        'notifications/tools/list_changed': 'toolsListChanged',
        'notifications/resources/list_changed': 'resourcesListChanged',
        'notifications/prompts/list_changed': 'promptsListChanged',
      };
      if (keys[message.method] && acceptedFilters[keys[message.method]] === true) session.onNotification?.(message.method);
    })
      .then(() => {
        if (!acknowledged) rejectAck(mcpError('MCP subscription ended before acknowledgment', 'MCP_INVALID_RESPONSE'));
        session.subscriptionEnded(controller);
      })
      .catch((error) => {
        if (!acknowledged) rejectAck(error);
        session.subscriptionEnded(controller);
      });
    return await ack;
  } catch (error) {
    if (error.code) throw error;
    if (controller.signal.aborted) throw mcpError(`MCP server '${session.name}' timed out opening its subscription`, 'MCP_TIMEOUT');
    throw mcpError(`MCP transport failed opening subscription for '${session.name}'`, 'MCP_TRANSPORT_ERROR');
  } finally {
    if (!acknowledged) clearTimeout(timeout);
  }
}

async function readHttpSubscription(reader, onMessage) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let line = '';
  let data = [];
  let eventBytes = 0;
  let pendingCR = false;
  const dispatch = () => {
    const current = line;
    line = '';
    if (current) {
      if (current.startsWith(':')) return;
      const separator = current.indexOf(':');
      if ((separator < 0 ? current : current.slice(0, separator)) === 'data')
        data.push(separator < 0 ? '' : current.slice(separator + 1).replace(/^ /, ''));
      return;
    }
    if (data.length) {
      let message;
      try {
        message = JSON.parse(data.join('\n'));
      } catch {
        throw mcpError('MCP subscription contained invalid JSON', 'MCP_INVALID_RESPONSE');
      }
      onMessage(message);
    }
    data = [];
    eventBytes = 0;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        try {
          decoder.decode();
        } catch {
          throw mcpError('MCP subscription contained invalid UTF-8', 'MCP_INVALID_RESPONSE');
        }
        return;
      }
      let chunk;
      try {
        chunk = decoder.decode(value, { stream: true });
      } catch {
        throw mcpError('MCP subscription contained invalid UTF-8', 'MCP_INVALID_RESPONSE');
      }
      for (const character of chunk) {
        eventBytes += Buffer.byteLength(character, 'utf8');
        if (eventBytes > MAX_BODY) throw mcpError('MCP subscription event exceeded the byte limit', 'MCP_RESPONSE_TOO_LARGE');
        if (pendingCR) {
          pendingCR = false;
          if (character === '\n') continue;
        }
        if (character === '\r') {
          dispatch();
          pendingCR = true;
        } else if (character === '\n') dispatch();
        else line += character;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}

/** Legacy MCP HTTP+SSE transport; credentials stay bound to the configured origin. */
export class LegacySseMcpSession extends StreamableHttpMcpSession {
  constructor(options) {
    super(options);
    this.endpointUrl = null;
    this.connectionController = null;
    this.reader = null;
    this.endpointReady = null;
    this.resolveEndpoint = null;
    this.rejectEndpoint = null;
    this.lastEventId = '';
    this.resumeAttempts = 0;
    this.pending = new Map();
    this.activeRequests = new Set();
    this.streamError = null;
    this.pumpPromise = null;
  }

  static async start({ name, settings, config, secretStore, fetchImpl = fetch, onNotification }) {
    const options = await resolveHttpOptions({ name, settings, config, secretStore });
    const session = new LegacySseMcpSession({ name, settings, ...options, fetchImpl, onNotification });
    try {
      await session.negotiate();
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  async negotiate() {
    await this.#connect();
    const initialized = await this.request(
      'initialize',
      { protocolVersion: SSE_VERSION, capabilities: {}, clientInfo: CLIENT },
      { protocolVersion: SSE_VERSION, methodHeader: false },
    );
    if (!LEGACY.includes(initialized?.protocolVersion))
      throw mcpError('MCP server negotiated an unsupported protocol version', 'MCP_VERSION_UNSUPPORTED');
    this.version = initialized.protocolVersion;
    this.capabilities = initialized.capabilities || {};
    this.serverInfo = initialized.serverInfo || null;
    await this.request('notifications/initialized', {}, { notification: true, protocolVersion: this.version, methodHeader: false });
  }

  async #connect() {
    this.connectionController = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      this.connectionController.abort(new Error('timeout'));
      this.rejectEndpoint?.(mcpError(`MCP server '${this.name}' timed out while opening its event stream`, 'MCP_TIMEOUT'));
    }, this.timeoutMs);
    try {
      const headers = new Headers({ ...this.headers, Accept: 'text/event-stream' });
      const response = await this.fetchImpl(this.url, {
        method: 'GET',
        headers,
        signal: this.connectionController.signal,
        redirect: 'error',
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw mcpError(`MCP SSE endpoint returned HTTP ${response.status}`, 'MCP_HTTP_STATUS', { status: response.status });
      }
      const contentType = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
      if (contentType !== 'text/event-stream' || !response.body) {
        void response.body?.cancel().catch(() => {});
        throw mcpError('MCP SSE endpoint did not return an event stream', 'MCP_INVALID_RESPONSE');
      }

      this.reader = response.body.getReader();
      this.endpointReady = new Promise((resolve, reject) => {
        this.resolveEndpoint = resolve;
        this.rejectEndpoint = reject;
      });
      const endpointReady = this.endpointReady;
      endpointReady.catch(() => {});
      this.pumpPromise = this.#pump().catch((error) => this.#failStream(error));
      await endpointReady;
    } catch (error) {
      if (timedOut) throw mcpError(`MCP server '${this.name}' timed out while opening its event stream`, 'MCP_TIMEOUT');
      if (typeof error?.code === 'string' && error.code.startsWith('MCP_')) throw error;
      throw mcpError(`MCP transport failed while opening the event stream for '${this.name}'`, 'MCP_TRANSPORT_ERROR');
    } finally {
      clearTimeout(timeout);
    }
  }

  async #pump() {
    while (!this.closed) {
      const reader = this.reader;
      if (!reader) return;
      let failure = null;
      try {
        await this.#readStream(reader);
        if (!this.closed) failure = mcpError('MCP SSE stream ended unexpectedly', 'MCP_SSE_DISCONNECTED');
      } catch (error) {
        failure = error;
      } finally {
        try {
          reader.releaseLock();
        } catch {}
      }
      if (this.closed) return;
      if (!failure || !isRecoverableSseFailure(failure)) throw failure;
      await this.#resumeStream(failure);
    }
  }

  async #readStream(reader) {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let line = '';
    let eventName = '';
    let dataLines = [];
    let eventIdBuffer = this.lastEventId;
    let eventBytes = 0;
    let pendingCR = false;
    const dispatchLine = () => {
      const current = line;
      line = '';
      if (!current) {
        this.lastEventId = eventIdBuffer;
        if (dataLines.length) this.#dispatchEvent(eventName || 'message', dataLines.join('\n'));
        eventName = '';
        dataLines = [];
        eventIdBuffer = this.lastEventId;
        eventBytes = 0;
        return;
      }
      if (current.startsWith(':')) return;
      const separator = current.indexOf(':');
      const field = separator < 0 ? current : current.slice(0, separator);
      const value = separator < 0 ? '' : current.slice(separator + 1).replace(/^ /, '');
      if (field === 'event') eventName = value;
      else if (field === 'data') dataLines.push(value);
      else if (field === 'id' && !value.includes('\0')) {
        if (value.length > 2_048 || !/^[\x20-\x7e]*$/.test(value) || value.trim() !== value)
          throw mcpError('MCP SSE event used an invalid or oversized event ID', 'MCP_INVALID_RESPONSE');
        eventIdBuffer = value;
      }
    };
    while (!this.closed) {
      const result = await reader.read();
      if (result.done) throw mcpError('MCP SSE stream ended unexpectedly', 'MCP_SSE_DISCONNECTED');
      let chunk;
      try {
        chunk = decoder.decode(result.value, { stream: true });
      } catch {
        throw mcpError('MCP SSE stream contained invalid UTF-8', 'MCP_INVALID_RESPONSE');
      }
      for (const character of chunk) {
        eventBytes += Buffer.byteLength(character, 'utf8');
        if (eventBytes > MAX_BODY) throw mcpError('MCP SSE event exceeded the byte limit', 'MCP_RESPONSE_TOO_LARGE');
        if (pendingCR) {
          pendingCR = false;
          if (character === '\n') continue;
        }
        if (character === '\r') {
          dispatchLine();
          pendingCR = true;
        } else if (character === '\n') dispatchLine();
        else line += character;
      }
    }
  }

  #dispatchEvent(eventName, data) {
    if (eventName === 'endpoint') {
      const endpointUrl = validateSseEndpoint(this.url, data);
      if (this.endpointUrl && this.endpointUrl !== endpointUrl)
        throw mcpError('MCP SSE server changed its message endpoint during reconnection', 'MCP_INVALID_RESPONSE');
      if (!this.endpointUrl) {
        this.endpointUrl = endpointUrl;
        this.resolveEndpoint?.();
        this.resolveEndpoint = null;
        this.rejectEndpoint = null;
        this.endpointReady = null;
      }
      return;
    }
    if (eventName !== 'message') return;
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      throw mcpError('MCP SSE message contained invalid JSON', 'MCP_INVALID_RESPONSE');
    }
    if (message?.jsonrpc !== '2.0') throw mcpError('MCP SSE message was not valid JSON-RPC', 'MCP_INVALID_RESPONSE');
    this.resumeAttempts = 0;
    if (!Object.hasOwn(message, 'id')) {
      const listMethods = {
        'notifications/tools/list_changed': 'tools',
        'notifications/resources/list_changed': 'resources',
        'notifications/prompts/list_changed': 'prompts',
      };
      const capability = listMethods[message.method];
      if (capability && this.capabilities[capability]?.listChanged === true) this.onNotification?.(message.method);
      return;
    }
    if (!(typeof message.id === 'string' || Number.isSafeInteger(message.id)))
      throw mcpError('MCP SSE message used an invalid JSON-RPC ID', 'MCP_INVALID_RESPONSE');
    this.pending.get(String(message.id))?.resolve(message);
  }

  async #resumeStream(disconnectError) {
    if (!this.lastEventId) throw mcpError('MCP SSE stream disconnected without a resumable event ID', 'MCP_TRANSPORT_ERROR');
    let lastError = disconnectError;
    while (!this.closed && this.resumeAttempts < MAX_SSE_RESUMPTIONS) {
      this.resumeAttempts += 1;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error('timeout')), this.timeoutMs);
      try {
        const headers = new Headers({ ...this.headers, Accept: 'text/event-stream' });
        headers.set('Last-Event-ID', this.lastEventId);
        const response = await this.fetchImpl(this.url, {
          method: 'GET',
          headers,
          signal: controller.signal,
          redirect: 'error',
        });
        if (controller.signal.aborted) {
          try {
            await response.body?.cancel();
          } catch {}
          throw controller.signal.reason || new Error('timeout');
        }
        if (!response.ok) {
          try {
            await response.body?.cancel();
          } catch {}
          const error = mcpError(`MCP SSE resume returned HTTP ${response.status}`, 'MCP_HTTP_STATUS', { status: response.status });
          if (response.status !== 429 && response.status < 500) throw error;
          lastError = error;
        } else {
          const contentType = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
          if (contentType !== 'text/event-stream' || !response.body) {
            try {
              await response.body?.cancel();
            } catch {}
            throw mcpError('MCP SSE resume did not return an event stream', 'MCP_INVALID_RESPONSE');
          }
          if (this.closed) {
            try {
              await response.body.cancel();
            } catch {}
            return;
          }
          this.connectionController = controller;
          this.reader = response.body.getReader();
          return;
        }
      } catch (error) {
        if (this.closed) return;
        if (typeof error?.code === 'string' && error.code.startsWith('MCP_')) throw error;
        lastError = error;
      } finally {
        clearTimeout(timeout);
      }
      if (this.resumeAttempts < MAX_SSE_RESUMPTIONS) await new Promise((resolve) => setTimeout(resolve, this.resumeAttempts * 50));
    }
    if (this.closed) return;
    throw mcpError(`MCP SSE stream could not be resumed after ${MAX_SSE_RESUMPTIONS} attempts`, 'MCP_TRANSPORT_ERROR', {
      cause: lastError,
    });
  }

  #failStream(error) {
    if (this.closed) return;
    const failure =
      typeof error?.code === 'string' && error.code.startsWith('MCP_') ? error : mcpError('MCP SSE stream failed', 'MCP_TRANSPORT_ERROR');
    this.streamError = failure;
    this.connectionController?.abort(failure);
    this.rejectEndpoint?.(failure);
    this.rejectEndpoint = null;
    this.resolveEndpoint = null;
    this.endpointReady = null;
    for (const controller of this.activeRequests) controller.abort(failure);
    for (const pending of this.pending.values()) pending.reject(failure);
    this.pending.clear();
  }

  async request(
    method,
    params,
    {
      timeoutMs = this.timeoutMs,
      signal,
      protocolVersion = this.version || SSE_VERSION,
      notification = false,
      allowError = false,
      extraHeaders = {},
    } = {},
  ) {
    if (this.closed) throw mcpError(`MCP server '${this.name}' is closed`, 'MCP_SERVER_CLOSED');
    if (!this.endpointUrl) throw this.streamError || mcpError('MCP SSE endpoint is not ready', 'MCP_SERVER_CLOSED');
    if (this.streamError) throw this.streamError;

    const id = notification ? undefined : ++this.nextId;
    const body = JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params });
    const headers = new Headers({ ...this.headers, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' });
    for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
    if (protocolVersion) headers.set('MCP-Protocol-Version', protocolVersion);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    this.activeRequests.add(controller);
    let resolveMessage;
    let rejectMessage;
    const messagePromise =
      id === undefined
        ? null
        : new Promise((resolve, reject) => {
            resolveMessage = resolve;
            rejectMessage = reject;
          });
    messagePromise?.catch(() => {});
    if (id !== undefined) this.pending.set(String(id), { resolve: resolveMessage, reject: rejectMessage });
    try {
      if (signal?.aborted) abort();
      if (controller.signal.aborted) throw controller.signal.reason;
      const response = await this.fetchImpl(this.endpointUrl, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        if (allowError && response.status === 404)
          throw mcpError('MCP_REMOTE_METHOD_MISSING', 'MCP_REMOTE_METHOD_MISSING', { status: response.status });
        throw mcpError(`MCP server '${this.name}' returned HTTP ${response.status}`, 'MCP_HTTP_STATUS', { status: response.status });
      }
      void response.body?.cancel().catch(() => {});
      if (notification) return null;
      const message = await waitForAbort(messagePromise, controller.signal);
      validateMcpJsonRpcResponse(message, id);
      if (Object.hasOwn(message, 'error')) {
        throw mcpError(
          `MCP server '${this.name}' returned JSON-RPC error ${Number.isInteger(message.error.code) ? message.error.code : 'unknown'}`,
          allowError && message.error.code === -32601 ? 'MCP_REMOTE_METHOD_MISSING' : 'MCP_REMOTE_ERROR',
        );
      }
      if (!Object.hasOwn(message, 'result')) throw mcpError('MCP server returned no result', 'MCP_INVALID_RESPONSE');
      return message.result;
    } catch (error) {
      if (typeof error?.code === 'string' && error.code.startsWith('MCP_')) throw error;
      if (signal?.aborted) throw mcpError(`MCP call '${method}' was cancelled`, 'MCP_CANCELLED');
      if (this.closed) throw mcpError(`MCP server '${this.name}' is closed`, 'MCP_SERVER_CLOSED');
      if (controller.signal.aborted) throw mcpError(`MCP server '${this.name}' timed out during ${method}`, 'MCP_TIMEOUT');
      throw mcpError(`MCP transport failed during ${method}`, 'MCP_TRANSPORT_ERROR');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      this.activeRequests.delete(controller);
      if (id !== undefined) this.pending.delete(String(id));
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.connectionController?.abort(new Error('closed'));
    for (const controller of this.activeRequests) controller.abort(new Error('closed'));
    const failure = mcpError(`MCP server '${this.name}' is closed`, 'MCP_SERVER_CLOSED');
    this.rejectEndpoint?.(failure);
    this.rejectEndpoint = null;
    this.resolveEndpoint = null;
    this.endpointReady = null;
    for (const pending of this.pending.values()) pending.reject(failure);
    this.pending.clear();
    try {
      await this.reader?.cancel();
    } catch {}
    this.reader = null;
  }
}

async function resolveHttpOptions({ name, settings, config, secretStore }) {
  const headers = {};
  for (const [header, ref] of Object.entries(settings.headers || {})) {
    let value;
    if (ref.startsWith('env:')) value = process.env[ref.slice(4)] ?? null;
    else value = await (secretStore || (await import('../platform/secrets.mjs')).createPlatformSecretStore()).get(ref.slice(7));
    if (value === null || value === '')
      throw mcpError(`Required MCP header reference for '${name}' is not set`, 'MCP_AUTH_REFERENCE_MISSING');
    if (/\r|\n/.test(value)) throw mcpError('MCP header reference contains an invalid value', 'MCP_AUTH_REFERENCE_INVALID');
    headers[header] = value;
  }
  const timeoutMs = resolveToolTimeoutMs({ name: 'mcp_server', execution: { timeout: timeoutPolicy(name) } }, config);
  return { headers, timeoutMs };
}

function validateSseEndpoint(connectionUrl, value) {
  if (typeof value !== 'string' || !value || value.length > 2_048 || value !== value.trim() || /[\r\n]/.test(value))
    throw mcpError('MCP SSE server returned an invalid message endpoint', 'MCP_INVALID_RESPONSE');
  let connection;
  let endpoint;
  try {
    connection = new URL(connectionUrl);
    endpoint = new URL(value, connection);
  } catch {
    throw mcpError('MCP SSE server returned an invalid message endpoint', 'MCP_INVALID_RESPONSE');
  }
  if (
    endpoint.origin !== connection.origin ||
    endpoint.protocol !== connection.protocol ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash
  )
    throw mcpError('MCP SSE message endpoint must stay on the configured origin', 'MCP_INVALID_RESPONSE');
  return endpoint.href;
}

function isRecoverableSseFailure(error) {
  return error?.code === 'MCP_SSE_DISCONNECTED' || typeof error?.code !== 'string' || !error.code.startsWith('MCP_');
}

function waitForAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason || new Error('aborted'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('aborted'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function validateSessionId(value) {
  if (value === null) return null;
  if (value.length > 1_024 || !/^[\x21-\x7E]+$/.test(value))
    throw mcpError('MCP server returned an invalid session identifier', 'MCP_INVALID_RESPONSE');
  return value;
}

async function readJson(response) {
  const text = await readBounded(response, MAX_BODY);
  try {
    return JSON.parse(text);
  } catch {
    throw mcpError('MCP server returned invalid JSON', 'MCP_INVALID_RESPONSE');
  }
}

async function readBounded(response, max) {
  const contentLength = response.headers.get('content-length');
  const declaredLength = contentLength && /^\d+$/.test(contentLength) ? Number(contentLength) : null;
  if (declaredLength !== null && (!Number.isSafeInteger(declaredLength) || declaredLength > max)) {
    try {
      await response.body?.cancel();
    } catch {}
    throw mcpError('MCP response exceeded the byte limit', 'MCP_RESPONSE_TOO_LARGE');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw mcpError('MCP response exceeded the byte limit', 'MCP_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(all);
  } catch {
    throw mcpError('MCP response contained invalid UTF-8', 'MCP_INVALID_RESPONSE');
  }
}

async function readSse(response, max, expectedId) {
  if (!response.body) throw mcpError('MCP event stream has no body', 'MCP_INVALID_RESPONSE');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let line = '';
  let dataLines = [];
  let eventIdBuffer;
  let lastEventId = null;
  let pendingCR = false;
  const finishLine = () => {
    if (line === '') {
      if (eventIdBuffer !== undefined) {
        lastEventId = safeSseEventId(eventIdBuffer) ? eventIdBuffer : null;
        eventIdBuffer = undefined;
      }
      if (!dataLines.length) return null;
      const data = dataLines.join('\n');
      dataLines = [];
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        throw mcpError('MCP event stream contained invalid JSON', 'MCP_INVALID_RESPONSE');
      }
      return message?.jsonrpc === '2.0' && message.id === expectedId ? { message, lastEventId } : null;
    }
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
    if (field === 'data') dataLines.push(value);
    else if (field === 'id' && !value.includes('\0')) eventIdBuffer = value;
    line = '';
    return null;
  };
  try {
    while (true) {
      let result;
      try {
        result = await reader.read();
      } catch (error) {
        if (!lastEventId) throw error;
        throw sseInterruption(lastEventId);
      }
      const { done, value } = result;
      if (done) break;
      bytes += value.byteLength;
      if (bytes > max) throw mcpError('MCP response exceeded the byte limit', 'MCP_RESPONSE_TOO_LARGE');
      const chunk = decoder.decode(value, { stream: true });
      for (const char of chunk) {
        if (pendingCR) {
          pendingCR = false;
          const message = finishLine();
          if (message) {
            await reader.cancel();
            return message;
          }
          if (char === '\n') continue;
        }
        if (char === '\r') pendingCR = true;
        else if (char === '\n') {
          const message = finishLine();
          if (message) {
            await reader.cancel();
            return message;
          }
        } else line += char;
      }
    }
    const tail = decoder.decode();
    if (tail) line += tail;
    if (pendingCR) finishLine();
    const error = mcpError('MCP event stream ended without a response', 'MCP_INVALID_RESPONSE');
    if (lastEventId) error[SSE_LAST_EVENT_ID] = lastEventId;
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function safeSseEventId(value) {
  return value.length > 0 && value.length <= 1_024 && value === value.trim() && /^[\x20-\x7E]+$/.test(value);
}

function sseInterruption(lastEventId) {
  const error = mcpError('MCP event stream was interrupted before the response arrived', 'MCP_INVALID_RESPONSE');
  error[SSE_LAST_EVENT_ID] = lastEventId;
  return error;
}

function normalizeTool(server, tool) {
  if (!tool || typeof tool.name !== 'string' || !NAME.test(tool.name) || tool.inputSchema?.type !== 'object')
    throw mcpError(`MCP server '${server}' advertised an invalid tool`, 'MCP_INVALID_TOOL');
  const name = `mcp__${server}__${tool.name}`;
  if (name.length > 64) throw mcpError('MCP tool name exceeds provider limit', 'MCP_INVALID_TOOL');
  const parameters = normalizeSchema(tool.inputSchema);
  const headerParameters = findHeaderParameters(tool.inputSchema);
  if (tool.outputSchema !== undefined && (!tool.outputSchema || typeof tool.outputSchema !== 'object' || Array.isArray(tool.outputSchema)))
    throw mcpError(`MCP server '${server}' tool output schema must be a JSON Schema object`, 'MCP_INVALID_SCHEMA');
  const outputSchema = tool.outputSchema === undefined ? undefined : normalizeSchema(tool.outputSchema);
  return deepFreeze({
    schema_version: TOOL_SCHEMA_VERSION,
    execution: { timeout: timeoutPolicy(server), sandbox: 'unsupported' },
    name,
    description:
      `MCP server '${server}' tool '${tool.name}'.${typeof tool.description === 'string' ? ` Untrusted server description: ${tool.description.slice(0, 1200)}` : ''}`.slice(
        0,
        1600,
      ),
    parameters,
    approval: 'ask',
    destructive: true,
    _mcp: { server, originalName: tool.name, headerParameters, ...(outputSchema ? { outputSchema } : {}) },
  });
}

function findHeaderParameters(schema) {
  const headers = [];
  const rootSchema = schema;
  const visit = (node, path = [], inArray = false, refStack = new Set()) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    if (typeof node.$ref === 'string') {
      if (refStack.has(node.$ref)) return;
      const nextRefStack = new Set(refStack);
      nextRefStack.add(node.$ref);
      visit(resolveLocalSchemaReference(rootSchema, node.$ref), path, inArray, nextRefStack);
    }
    if (Object.hasOwn(node, 'x-mcp-header')) {
      const value = node['x-mcp-header'];
      if (
        inArray ||
        !['string', 'integer', 'boolean'].includes(node.type) ||
        typeof value !== 'string' ||
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(value)
      )
        throw mcpError('MCP tool has an invalid x-mcp-header annotation', 'MCP_INVALID_SCHEMA');
      const normalized = value.toLowerCase();
      const prior = headers.find((header) => header.name.toLowerCase() === normalized);
      if (prior) {
        if (prior.path.length === path.length && prior.path.every((part, index) => part === path[index])) return;
        throw mcpError('MCP tool repeats an x-mcp-header name', 'MCP_INVALID_SCHEMA');
      }
      headers.push({ name: value, path });
    }
    if (node.type === 'object' && node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties))
      for (const [key, child] of Object.entries(node.properties)) visit(child, [...path, key], inArray, refStack);
    if (node.type === 'array') {
      if (node.items) visit(node.items, path, true, refStack);
      for (const item of node.prefixItems || []) visit(item, path, true, refStack);
    }
    for (const key of ['allOf', 'anyOf', 'oneOf']) for (const branch of node[key] || []) visit(branch, path, inArray, refStack);
    for (const key of ['not', 'if', 'then', 'else']) if (node[key]) visit(node[key], path, inArray, refStack);
  };
  visit(schema);
  return headers;
}

function encodeHeaderValue(value) {
  const plain = /^[\x20-\x7E\t]*$/.test(value) && value === value.trim() && !/^=\?base64\?.*\?=$/.test(value);
  return plain ? value : `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function resolveLocalSchemaReference(rootSchema, reference) {
  if (reference === '#') return rootSchema;
  if (!reference.startsWith('#/')) throw mcpError('Only local JSON Schema references are supported', 'MCP_INVALID_SCHEMA');
  let pointer;
  try {
    pointer = decodeURIComponent(reference.slice(1));
  } catch {
    throw mcpError('MCP schema $ref pointer invalid', 'MCP_INVALID_SCHEMA');
  }
  let current = rootSchema;
  for (const encoded of pointer.slice(1).split('/')) {
    if (/~(?![01])/.test(encoded)) throw mcpError('MCP schema $ref pointer invalid', 'MCP_INVALID_SCHEMA');
    const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, key))
      throw mcpError('MCP schema $ref target was not found', 'MCP_INVALID_SCHEMA');
    current = current[key];
  }
  return current;
}

function normalizeSchema(schema, depth = 0, budget = { remaining: 512 }, rootSchema = schema, refStack = new Set()) {
  if (--budget.remaining < 0) throw mcpError('MCP schema exceeds its validation budget', 'MCP_INVALID_SCHEMA');
  if (typeof schema === 'boolean') return schema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 32)
    throw mcpError('MCP schema invalid or too deeply nested', 'MCP_INVALID_SCHEMA');
  const allowed = new Set([
    '$schema',
    '$comment',
    '$defs',
    '$ref',
    'type',
    'title',
    'description',
    'format',
    'contentEncoding',
    'contentMediaType',
    'contentSchema',
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
    'prefixItems',
    'contains',
    'minContains',
    'maxContains',
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
    'x-mcp-header',
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
    throw mcpError('MCP schema uses unsupported JSON Schema keyword', 'MCP_INVALID_SCHEMA');
  if (
    schema.$defs !== undefined &&
    (!schema.$defs || typeof schema.$defs !== 'object' || Array.isArray(schema.$defs) || Object.keys(schema.$defs).length > 64)
  )
    throw mcpError('MCP schema $defs invalid', 'MCP_INVALID_SCHEMA');
  if (schema.$ref !== undefined) {
    if (typeof schema.$ref !== 'string' || refStack.has(schema.$ref))
      throw mcpError('MCP schema has an invalid or recursive $ref', 'MCP_INVALID_SCHEMA');
    const target = resolveLocalSchemaReference(rootSchema, schema.$ref);
    const nextRefStack = new Set(refStack);
    nextRefStack.add(schema.$ref);
    const normalizedTarget = normalizeSchema(target, depth + 1, budget, rootSchema, nextRefStack);
    const sibling = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== '$ref' && key !== '$defs'));
    if (Object.keys(sibling).length === 0) return normalizedTarget;
    return {
      allOf: [normalizedTarget, normalizeSchema(sibling, depth + 1, budget, rootSchema, refStack)],
    };
  }
  const type = schema.type;
  const hasType = Object.hasOwn(schema, 'type');
  if (!hasType && depth === 0) throw mcpError('MCP schema must declare a root type', 'MCP_INVALID_SCHEMA');
  const types = Array.isArray(type) ? type : [type];
  if (
    (hasType && types.length === 0) ||
    new Set(types).size !== types.length ||
    (hasType && types.some((item) => !['object', 'string', 'integer', 'number', 'boolean', 'array', 'null'].includes(item)))
  )
    throw mcpError('MCP schema uses unsupported type', 'MCP_INVALID_SCHEMA');
  const out = hasType ? { type } : {};
  for (const k of ['$schema', '$comment', 'format', 'contentEncoding', 'contentMediaType'])
    if (schema[k] !== undefined) {
      if (typeof schema[k] !== 'string') throw mcpError(`MCP schema ${k} invalid`, 'MCP_INVALID_SCHEMA');
      out[k] = schema[k];
    }
  if (schema.contentSchema !== undefined)
    out.contentSchema = normalizeSchema(schema.contentSchema, depth + 1, budget, rootSchema, refStack);
  if (schema.examples !== undefined && !Array.isArray(schema.examples)) throw mcpError('MCP examples invalid', 'MCP_INVALID_SCHEMA');
  for (const k of ['deprecated', 'readOnly', 'writeOnly'])
    if (schema[k] !== undefined) {
      if (typeof schema[k] !== 'boolean') throw mcpError(`MCP schema ${k} invalid`, 'MCP_INVALID_SCHEMA');
      out[k] = schema[k];
    }
  for (const k of ['default', 'examples']) if (Object.hasOwn(schema, k)) out[k] = schema[k];
  for (const k of ['title', 'description'])
    if (schema[k] !== undefined) {
      if (typeof schema[k] !== 'string' || schema[k].length > 2000)
        throw mcpError('MCP schema documentation invalid', 'MCP_INVALID_SCHEMA');
      out[k] = k === 'description' && depth ? `Untrusted server-provided schema note: ${schema[k]}` : schema[k];
    }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length > 100) throw mcpError('MCP enum invalid', 'MCP_INVALID_SCHEMA');
    out.enum = schema.enum;
  }
  if (Object.hasOwn(schema, 'const')) out.const = schema.const;
  if (schema.allOf !== undefined) {
    if (!Array.isArray(schema.allOf) || schema.allOf.length === 0 || schema.allOf.length > 8)
      throw mcpError('MCP allOf invalid', 'MCP_INVALID_SCHEMA');
    out.allOf = schema.allOf.map((item) => normalizeSchema(item, depth + 1, budget, rootSchema, refStack));
  }
  for (const k of ['anyOf', 'oneOf'])
    if (schema[k] !== undefined) {
      if (!Array.isArray(schema[k]) || schema[k].length === 0 || schema[k].length > 8)
        throw mcpError(`MCP ${k} invalid`, 'MCP_INVALID_SCHEMA');
      out[k] = schema[k].map((item) => normalizeSchema(item, depth + 1, budget, rootSchema, refStack));
    }
  if (schema.not !== undefined) out.not = normalizeSchema(schema.not, depth + 1, budget, rootSchema, refStack);
  for (const k of ['if', 'then', 'else'])
    if (schema[k] !== undefined) out[k] = normalizeSchema(schema[k], depth + 1, budget, rootSchema, refStack);
  for (const k of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'])
    if (schema[k] !== undefined) {
      if (!Number.isFinite(schema[k])) throw mcpError('MCP numeric bound invalid', 'MCP_INVALID_SCHEMA');
      out[k] = schema[k];
    }
  if (schema.multipleOf !== undefined) {
    if (!Number.isFinite(schema.multipleOf) || schema.multipleOf <= 0) throw mcpError('MCP multipleOf invalid', 'MCP_INVALID_SCHEMA');
    out.multipleOf = schema.multipleOf;
  }
  for (const k of ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties', 'minContains', 'maxContains'])
    if (schema[k] !== undefined) {
      if (!Number.isInteger(schema[k]) || schema[k] < 0 || schema[k] > 1_000_000)
        throw mcpError('MCP size bound invalid', 'MCP_INVALID_SCHEMA');
      out[k] = schema[k];
    }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== 'string' || schema.pattern.length > 256) throw mcpError('MCP pattern invalid', 'MCP_INVALID_SCHEMA');
    try {
      new RegExp(schema.pattern);
    } catch {
      throw mcpError('MCP pattern invalid', 'MCP_INVALID_SCHEMA');
    }
    out.pattern = schema.pattern;
  }
  if (schema.contains !== undefined) out.contains = normalizeSchema(schema.contains, depth + 1, budget, rootSchema, refStack);
  if (schema.prefixItems !== undefined) {
    if (!Array.isArray(schema.prefixItems) || schema.prefixItems.length > 64)
      throw mcpError('MCP prefixItems invalid', 'MCP_INVALID_SCHEMA');
    out.prefixItems = schema.prefixItems.map((item) => normalizeSchema(item, depth + 1, budget, rootSchema, refStack));
  }
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== 'boolean')
    throw mcpError('MCP uniqueItems invalid', 'MCP_INVALID_SCHEMA');
  if (schema.uniqueItems !== undefined) out.uniqueItems = schema.uniqueItems;
  const objectKeywords = [
    'properties',
    'required',
    'dependentRequired',
    'dependentSchemas',
    'additionalProperties',
    'patternProperties',
    'propertyNames',
  ];
  const hasObjectKeywords = objectKeywords.some((k) => schema[k] !== undefined);
  if (types.includes('object') || hasObjectKeywords) {
    const props = schema.properties || {};
    if (!props || typeof props !== 'object' || Array.isArray(props) || Object.keys(props).length > 64)
      throw mcpError('MCP object properties invalid', 'MCP_INVALID_SCHEMA');
    out.properties = Object.fromEntries(
      Object.entries(props).map(([key, value]) => {
        if (key.length > 128) throw mcpError('MCP property name invalid', 'MCP_INVALID_SCHEMA');
        return [key, normalizeSchema(value, depth + 1, budget, rootSchema, refStack)];
      }),
    );
    if (
      schema.required !== undefined &&
      (!Array.isArray(schema.required) ||
        new Set(schema.required).size !== schema.required.length ||
        schema.required.some((key) => typeof key !== 'string'))
    )
      throw mcpError('MCP required properties invalid', 'MCP_INVALID_SCHEMA');
    if (schema.required) out.required = [...new Set(schema.required)];
    if (schema.dependentRequired !== undefined) {
      if (!schema.dependentRequired || typeof schema.dependentRequired !== 'object' || Array.isArray(schema.dependentRequired))
        throw mcpError('MCP dependentRequired invalid', 'MCP_INVALID_SCHEMA');
      const dependencies = Object.entries(schema.dependentRequired);
      if (dependencies.length > 64) throw mcpError('MCP dependentRequired limit exceeded', 'MCP_INVALID_SCHEMA');
      out.dependentRequired = Object.fromEntries(
        dependencies.map(([key, names]) => {
          if (
            key.length > 128 ||
            !Array.isArray(names) ||
            names.length > 64 ||
            new Set(names).size !== names.length ||
            names.some((name) => typeof name !== 'string' || name.length > 128)
          )
            throw mcpError('MCP dependentRequired entries invalid', 'MCP_INVALID_SCHEMA');
          return [key, names];
        }),
      );
    }
    if (schema.dependentSchemas !== undefined) {
      if (!schema.dependentSchemas || typeof schema.dependentSchemas !== 'object' || Array.isArray(schema.dependentSchemas))
        throw mcpError('MCP dependentSchemas invalid', 'MCP_INVALID_SCHEMA');
      const dependencies = Object.entries(schema.dependentSchemas);
      if (dependencies.length > 64) throw mcpError('MCP dependentSchemas limit exceeded', 'MCP_INVALID_SCHEMA');
      out.dependentSchemas = Object.fromEntries(
        dependencies.map(([key, child]) => {
          if (key.length > 128) throw mcpError('MCP dependentSchemas key too long', 'MCP_INVALID_SCHEMA');
          return [key, normalizeSchema(child, depth + 1, budget, rootSchema, refStack)];
        }),
      );
    }
    if (schema.patternProperties !== undefined) {
      if (!schema.patternProperties || typeof schema.patternProperties !== 'object' || Array.isArray(schema.patternProperties))
        throw mcpError('MCP patternProperties invalid', 'MCP_INVALID_SCHEMA');
      const entries = Object.entries(schema.patternProperties);
      if (entries.length > 16) throw mcpError('MCP patternProperties limit exceeded', 'MCP_INVALID_SCHEMA');
      out.patternProperties = Object.fromEntries(
        entries.map(([pattern, child]) => {
          if (pattern.length > 256) throw mcpError('MCP patternProperties key too long', 'MCP_INVALID_SCHEMA');
          try {
            new RegExp(pattern);
          } catch {
            throw mcpError('MCP patternProperties key invalid', 'MCP_INVALID_SCHEMA');
          }
          return [pattern, normalizeSchema(child, depth + 1, budget, rootSchema, refStack)];
        }),
      );
    }
    if (schema.propertyNames !== undefined)
      out.propertyNames = normalizeSchema(schema.propertyNames, depth + 1, budget, rootSchema, refStack);
    if (schema.additionalProperties !== undefined) {
      if (
        typeof schema.additionalProperties !== 'boolean' &&
        (!schema.additionalProperties || typeof schema.additionalProperties !== 'object')
      )
        throw mcpError('MCP additionalProperties invalid', 'MCP_INVALID_SCHEMA');
      out.additionalProperties = normalizeSchema(schema.additionalProperties, depth + 1, budget, rootSchema, refStack);
    }
  }
  if (
    types.includes('array') ||
    schema.items !== undefined ||
    (!hasType && ['minItems', 'maxItems', 'uniqueItems', 'contains'].some((k) => schema[k] !== undefined))
  ) {
    if (schema.items !== undefined) out.items = normalizeSchema(schema.items, depth + 1, budget, rootSchema, refStack);
  }
  if (out.minimum > out.maximum || out.minLength > out.maxLength || out.minItems > out.maxItems || out.minContains > out.maxContains)
    throw mcpError('MCP schema bounds are inconsistent', 'MCP_INVALID_SCHEMA');
  return out;
}

function modernMeta() {
  return {
    'io.modelcontextprotocol/protocolVersion': VERSION,
    'io.modelcontextprotocol/clientInfo': CLIENT,
    'io.modelcontextprotocol/clientCapabilities': {},
  };
}
function timeoutPolicy(server) {
  return {
    kind: 'config_ms',
    config_path: `mcp.servers.${server}.timeout_ms`,
    fallback_path: 'mcp.timeout_ms',
    default_ms: 15_000,
    min_ms: 1_000,
    max_ms: 120_000,
  };
}
function mcpError(message, code, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}
