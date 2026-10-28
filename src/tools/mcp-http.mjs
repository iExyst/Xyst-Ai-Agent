import { resolveToolTimeoutMs, TOOL_SCHEMA_VERSION, deepFreeze } from './schemas.mjs';
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
  constructor({ name, settings, headers, timeoutMs, fetchImpl = fetch }) {
    this.name = name;
    this.url = settings.url;
    this.headers = headers;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.version = null;
    this.capabilities = {};
    this.serverInfo = null;
    this.nextId = 0;
    this.sessionId = null;
    this.sessionRecovery = null;
    this.closed = false;
  }

  static async start({ name, settings, config, secretStore, fetchImpl = fetch }) {
    const { headers, timeoutMs } = await resolveHttpOptions({ name, settings, config, secretStore });
    const session = new StreamableHttpMcpSession({ name, settings, headers, timeoutMs, fetchImpl });
    try {
      await session.negotiate();
      return session;
    } catch (error) {
      await session.close();
      if (error.code === 'MCP_HTTP_STATUS' && [404, 405].includes(error.status)) {
        const legacySession = new LegacySseMcpSession({ name, settings, headers, timeoutMs, fetchImpl });
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
      if (discovered?.supportedVersions !== undefined) {
        const supportedVersions = discovered.supportedVersions;
        if (
          !Array.isArray(supportedVersions) ||
          supportedVersions.length > 32 ||
          supportedVersions.some((version) => typeof version !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(version))
        ) {
          throw mcpError('MCP server returned an invalid protocol version list', 'MCP_INVALID_RESPONSE');
        }
        if (supportedVersions.includes(VERSION)) {
          this.version = VERSION;
          this.capabilities = discovered.capabilities || {};
          this.serverInfo = discovered._meta?.['io.modelcontextprotocol/serverInfo'] || discovered.serverInfo || null;
          return;
        }
        throw mcpError('MCP server does not support a compatible protocol version', 'MCP_VERSION_UNSUPPORTED');
      }
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

  async callTool(name, args, { signal, headerParameters = [] } = {}) {
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
    return result;
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

  static async start({ name, settings, config, secretStore, fetchImpl = fetch }) {
    const options = await resolveHttpOptions({ name, settings, config, secretStore });
    const session = new LegacySseMcpSession({ name, settings, ...options, fetchImpl });
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
    if (!Object.hasOwn(message, 'id')) return;
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
  const headerParameters = findHeaderParameters(tool.inputSchema);
  return deepFreeze({
    schema_version: TOOL_SCHEMA_VERSION,
    execution: { timeout: timeoutPolicy(server), sandbox: 'unsupported' },
    name,
    description:
      `MCP server '${server}' tool '${tool.name}'.${typeof tool.description === 'string' ? ` Untrusted server description: ${tool.description.slice(0, 1200)}` : ''}`.slice(
        0,
        1600,
      ),
    parameters: normalizeSchema(tool.inputSchema),
    approval: 'ask',
    destructive: true,
    _mcp: { server, originalName: tool.name, headerParameters },
  });
}

function findHeaderParameters(schema) {
  const headers = [];
  const names = new Set();
  const visit = (node, path = [], inArray = false) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
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
      if (names.has(normalized)) throw mcpError('MCP tool repeats an x-mcp-header name', 'MCP_INVALID_SCHEMA');
      names.add(normalized);
      headers.push({ name: value, path });
    }
    if (node.type === 'object' && node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties))
      for (const [key, child] of Object.entries(node.properties)) visit(child, [...path, key], inArray);
    if (node.type === 'array' && node.items) visit(node.items, path, true);
  };
  visit(schema);
  return headers;
}

function encodeHeaderValue(value) {
  const plain = /^[\x20-\x7E\t]*$/.test(value) && value === value.trim() && !/^=\?base64\?.*\?=$/.test(value);
  return plain ? value : `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function normalizeSchema(schema, depth = 0) {
  if (typeof schema === 'boolean') return schema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 8)
    throw mcpError('MCP schema invalid or too deeply nested', 'MCP_INVALID_SCHEMA');
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
    'required',
    'additionalProperties',
    'items',
    'minimum',
    'maximum',
    'minLength',
    'maxLength',
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
  ]);
  if (Object.keys(schema).some((key) => !allowed.has(key)))
    throw mcpError('MCP schema uses unsupported JSON Schema keyword', 'MCP_INVALID_SCHEMA');
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
  for (const k of ['$schema', '$comment', 'format'])
    if (schema[k] !== undefined) {
      if (typeof schema[k] !== 'string') throw mcpError(`MCP schema ${k} invalid`, 'MCP_INVALID_SCHEMA');
      out[k] = schema[k];
    }
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
    out.allOf = schema.allOf.map((item) => normalizeSchema(item, depth + 1));
  }
  for (const k of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'])
    if (schema[k] !== undefined) {
      if (!types.some((item) => ['integer', 'number'].includes(item)) || !Number.isFinite(schema[k]))
        throw mcpError('MCP numeric bound invalid', 'MCP_INVALID_SCHEMA');
      out[k] = schema[k];
    }
  if (schema.multipleOf !== undefined) {
    if (!types.some((item) => ['integer', 'number'].includes(item)) || !Number.isFinite(schema.multipleOf) || schema.multipleOf <= 0)
      throw mcpError('MCP multipleOf invalid', 'MCP_INVALID_SCHEMA');
    out.multipleOf = schema.multipleOf;
  }
  for (const k of ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'])
    if (schema[k] !== undefined) {
      if (
        !Number.isInteger(schema[k]) ||
        schema[k] < 0 ||
        schema[k] > 1_000_000 ||
        (k.endsWith('Length') && !types.includes('string')) ||
        (k.endsWith('Items') && !types.includes('array')) ||
        (k.endsWith('Properties') && !types.includes('object'))
      )
        throw mcpError('MCP size bound invalid', 'MCP_INVALID_SCHEMA');
      out[k] = schema[k];
    }
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== 'boolean')
    throw mcpError('MCP uniqueItems invalid', 'MCP_INVALID_SCHEMA');
  if (schema.uniqueItems !== undefined && !types.includes('array'))
    throw mcpError('MCP uniqueItems on a non-array type', 'MCP_INVALID_SCHEMA');
  if (schema.uniqueItems !== undefined) out.uniqueItems = schema.uniqueItems;
  if (types.includes('object')) {
    const props = schema.properties || {};
    if (!props || typeof props !== 'object' || Array.isArray(props) || Object.keys(props).length > 64)
      throw mcpError('MCP object properties invalid', 'MCP_INVALID_SCHEMA');
    out.properties = Object.fromEntries(
      Object.entries(props).map(([key, value]) => {
        if (!key || key.length > 128) throw mcpError('MCP property name invalid', 'MCP_INVALID_SCHEMA');
        return [key, normalizeSchema(value, depth + 1)];
      }),
    );
    if (
      schema.required !== undefined &&
      (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== 'string' || !Object.hasOwn(out.properties, key)))
    )
      throw mcpError('MCP required properties invalid', 'MCP_INVALID_SCHEMA');
    if (schema.required) out.required = [...new Set(schema.required)];
    if (schema.additionalProperties !== undefined) {
      if (
        typeof schema.additionalProperties !== 'boolean' &&
        (!schema.additionalProperties || typeof schema.additionalProperties !== 'object')
      )
        throw mcpError('MCP additionalProperties invalid', 'MCP_INVALID_SCHEMA');
      out.additionalProperties = normalizeSchema(schema.additionalProperties, depth + 1);
    }
  } else if (['properties', 'required', 'additionalProperties'].some((k) => schema[k] !== undefined))
    throw mcpError('MCP schema contains object keywords for a scalar type', 'MCP_INVALID_SCHEMA');
  if (types.includes('array')) {
    if (schema.items === undefined) throw mcpError('MCP array items required', 'MCP_INVALID_SCHEMA');
    out.items = normalizeSchema(schema.items, depth + 1);
  } else if (schema.items !== undefined) throw mcpError('MCP scalar contains an items keyword', 'MCP_INVALID_SCHEMA');
  if (out.minimum > out.maximum || out.minLength > out.maxLength || out.minItems > out.maxItems)
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
