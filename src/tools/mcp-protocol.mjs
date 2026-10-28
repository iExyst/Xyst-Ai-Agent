import uriTemplates from './vendor/uri-templates.cjs';

const MODERN_PROTOCOL_VERSION = '2026-07-28';
const CACHEABLE_METHODS = new Set([
  'server/discover',
  'tools/list',
  'resources/list',
  'resources/templates/list',
  'resources/read',
  'prompts/list',
]);
const RESULT_TYPE_METHODS = new Set([
  'server/discover',
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/templates/list',
  'resources/read',
  'prompts/list',
  'prompts/get',
]);
const MAX_SUPPORTED_PROTOCOL_VERSIONS = 32;

/** Reject modern MCP control-flow results that Xyst does not yet implement. */
export function validateMcpResultType(result, { protocolVersion, serverName, method }) {
  const modern = protocolVersion === MODERN_PROTOCOL_VERSION;
  if (isRecord(result) && !(modern ? isOptionalResultMeta(result._meta) : isOptionalMeta(result._meta)))
    throw mcpError(`MCP server '${serverName}' returned invalid result metadata during ${method}`, 'MCP_INVALID_RESPONSE');
  if (
    protocolVersion === MODERN_PROTOCOL_VERSION &&
    isRecord(result) &&
    Object.hasOwn(result, 'resultType') &&
    result.resultType !== 'complete'
  )
    rejectUnsupportedResultType(result.resultType, { serverName, method });
  if (
    protocolVersion === MODERN_PROTOCOL_VERSION &&
    RESULT_TYPE_METHODS.has(method) &&
    (!isRecord(result) || typeof result.resultType !== 'string')
  )
    throw mcpError(`MCP server '${serverName}' omitted the required result type during ${method}`, 'MCP_INVALID_RESPONSE');
  if (
    protocolVersion === MODERN_PROTOCOL_VERSION &&
    CACHEABLE_METHODS.has(method) &&
    (!isRecord(result) || !['private', 'public'].includes(result.cacheScope) || !Number.isInteger(result.ttlMs) || result.ttlMs < 0)
  )
    throw mcpError(`MCP server '${serverName}' returned invalid cache metadata during ${method}`, 'MCP_INVALID_RESPONSE');
  if (
    protocolVersion === MODERN_PROTOCOL_VERSION &&
    method === 'server/discover' &&
    (!Array.isArray(result.supportedVersions) ||
      result.supportedVersions.length > MAX_SUPPORTED_PROTOCOL_VERSIONS ||
      !result.supportedVersions.every(isProtocolVersion) ||
      !isServerCapabilities(result.capabilities) ||
      !isOptionalString(result.instructions))
  )
    throw mcpError(`MCP server '${serverName}' returned invalid discovery metadata`, 'MCP_INVALID_RESPONSE');
  if (method === 'tools/call') validateToolCallResult(result, { protocolVersion, serverName });
  if (method === 'tools/list') validateToolsListResult(result, serverName, modern);
  if (method === 'resources/list') validateResourcesListResult(result, serverName, modern);
  if (method === 'resources/templates/list') validateResourceTemplatesListResult(result, serverName, modern);
  if (method === 'resources/read') validateResourceReadResult(result, serverName, modern);
  if (method === 'prompts/list') validatePromptsListResult(result, serverName, modern);
  if (method === 'prompts/get') validatePromptResult(result, serverName, modern);
  if (protocolVersion !== MODERN_PROTOCOL_VERSION || !result || typeof result !== 'object' || Array.isArray(result)) return result;
  if (!Object.hasOwn(result, 'resultType') || result.resultType === 'complete') return result;
  rejectUnsupportedResultType(result.resultType, { serverName, method });
}

/** Validate the required fields of the legacy MCP initialize response. */
export function validateMcpInitializeResult(result, { serverName }) {
  if (
    !isRecord(result) ||
    typeof result.protocolVersion !== 'string' ||
    !isServerCapabilities(result.capabilities) ||
    !isImplementation(result.serverInfo) ||
    !isOptionalString(result.instructions) ||
    !isOptionalMeta(result._meta)
  )
    throw mcpError(`MCP server '${serverName}' returned an invalid initialize response`, 'MCP_INVALID_RESPONSE');
  return result;
}

/** Validate the JSON-RPC 2.0 response envelope before a transport handles its result or error. */
export function validateMcpJsonRpcResponse(message, expectedId) {
  if (!isRecord(message) || message.jsonrpc !== '2.0' || message.id !== expectedId)
    throw mcpError('MCP server returned an invalid JSON-RPC response', 'MCP_INVALID_RESPONSE');
  const hasResult = Object.hasOwn(message, 'result');
  const hasError = Object.hasOwn(message, 'error');
  if (hasResult === hasError) throw mcpError('MCP server response must contain exactly one result or error', 'MCP_INVALID_RESPONSE');
  if (hasError && (!isRecord(message.error) || !Number.isInteger(message.error.code) || typeof message.error.message !== 'string'))
    throw mcpError('MCP server returned an invalid JSON-RPC error object', 'MCP_INVALID_RESPONSE');
  return message;
}

/** Validate and correlate an MCP progress notification with an active request. */
export function validateMcpProgressNotification(message, expectedToken) {
  if (!isRecord(message) || message.jsonrpc !== '2.0' || message.method !== 'notifications/progress' || !isRecord(message.params))
    throw mcpError('MCP server emitted an invalid progress notification', 'MCP_INVALID_RESPONSE');
  const { progressToken, progress, total, message: detail, _meta } = message.params;
  const validToken = typeof progressToken === 'string' || Number.isSafeInteger(progressToken);
  if (
    !validToken ||
    !Object.is(progressToken, expectedToken) ||
    typeof progress !== 'number' ||
    !Number.isFinite(progress) ||
    (total !== undefined && (typeof total !== 'number' || !Number.isFinite(total))) ||
    (detail !== undefined && typeof detail !== 'string') ||
    !isOptionalMeta(_meta, true)
  )
    throw mcpError('MCP server emitted invalid or uncorrelated progress data', 'MCP_INVALID_RESPONSE');
  return { progress, ...(total === undefined ? {} : { total }), ...(detail === undefined ? {} : { message: detail }) };
}

function rejectUnsupportedResultType(resultType, { serverName, method }) {
  if (resultType === 'input_required')
    throw mcpError(
      `MCP server '${serverName}' requested interactive input during ${method}, which this client does not support`,
      'MCP_INTERACTIVE_INPUT_UNSUPPORTED',
    );
  if (resultType === 'task')
    throw mcpError(
      `MCP server '${serverName}' returned a task during ${method}, which this client does not support`,
      'MCP_TASK_UNSUPPORTED',
    );
  throw mcpError(`MCP server '${serverName}' returned an unsupported result type during ${method}`, 'MCP_INVALID_RESPONSE');
}

function validateToolCallResult(result, { protocolVersion, serverName }) {
  if (!isRecord(result)) throw mcpError(`MCP server '${serverName}' returned an invalid tool result`, 'MCP_INVALID_RESPONSE');
  if (!Array.isArray(result.content))
    throw mcpError(`MCP server '${serverName}' returned a tool result without a content array`, 'MCP_INVALID_RESPONSE');
  if (protocolVersion === MODERN_PROTOCOL_VERSION && typeof result.resultType !== 'string')
    throw mcpError(`MCP server '${serverName}' omitted the required tool result type`, 'MCP_INVALID_RESPONSE');
  if (result.isError !== undefined && typeof result.isError !== 'boolean')
    throw mcpError(`MCP server '${serverName}' returned an invalid tool error flag`, 'MCP_INVALID_RESPONSE');
  if (!result.content.every((content) => isContentBlock(content, protocolVersion === MODERN_PROTOCOL_VERSION)))
    throw mcpError(`MCP server '${serverName}' returned an invalid content block`, 'MCP_INVALID_RESPONSE');
}

function validateToolsListResult(result, serverName, modern) {
  if (
    !isRecord(result) ||
    !isOptionalString(result.nextCursor) ||
    !Array.isArray(result.tools) ||
    !result.tools.every((tool) => isToolDefinition(tool, modern))
  )
    throw mcpError(`MCP server '${serverName}' returned invalid tool definitions`, 'MCP_INVALID_RESPONSE');
}

function validateResourcesListResult(result, serverName, modern) {
  if (
    !isRecord(result) ||
    !isOptionalString(result.nextCursor) ||
    !Array.isArray(result.resources) ||
    !result.resources.every((resource) => isResourceDefinition(resource, modern))
  )
    throw mcpError(`MCP server '${serverName}' returned invalid resource definitions`, 'MCP_INVALID_RESPONSE');
}

function validateResourceTemplatesListResult(result, serverName, modern) {
  if (
    !isRecord(result) ||
    !isOptionalString(result.nextCursor) ||
    !Array.isArray(result.resourceTemplates) ||
    !result.resourceTemplates.every((template) => isResourceTemplate(template, modern))
  )
    throw mcpError(`MCP server '${serverName}' returned invalid resource templates`, 'MCP_INVALID_RESPONSE');
}

function validatePromptsListResult(result, serverName, modern) {
  if (
    !isRecord(result) ||
    !isOptionalString(result.nextCursor) ||
    !Array.isArray(result.prompts) ||
    !result.prompts.every((prompt) => isPromptDefinition(prompt, modern))
  )
    throw mcpError(`MCP server '${serverName}' returned invalid prompt definitions`, 'MCP_INVALID_RESPONSE');
}

function validateResourceReadResult(result, serverName, modern) {
  if (!isRecord(result) || !Array.isArray(result.contents) || !result.contents.every((content) => isResourceContents(content, modern)))
    throw mcpError(`MCP server '${serverName}' returned invalid resource contents`, 'MCP_INVALID_RESPONSE');
}

function validatePromptResult(result, serverName, modern) {
  if (
    !isRecord(result) ||
    !isOptionalString(result.description) ||
    !Array.isArray(result.messages) ||
    !result.messages.every(
      (message) => isRecord(message) && ['user', 'assistant'].includes(message.role) && isContentBlock(message.content, modern),
    )
  )
    throw mcpError(`MCP server '${serverName}' returned invalid prompt messages`, 'MCP_INVALID_RESPONSE');
}

function isContentBlock(value, modern) {
  if (!isRecord(value) || !isOptionalMeta(value._meta, modern)) return false;
  if (value.type === 'text') return typeof value.text === 'string' && isOptionalAnnotations(value.annotations);
  if (value.type === 'image' || value.type === 'audio')
    return isBase64String(value.data) && typeof value.mimeType === 'string' && isOptionalAnnotations(value.annotations);
  if (value.type === 'resource_link') return isResourceLink(value, modern);
  if (value.type === 'resource') return isResourceContents(value.resource, modern) && isOptionalAnnotations(value.annotations);
  return false;
}

function isResourceContents(value, modern) {
  if (
    !isRecord(value) ||
    !isOptionalMeta(value._meta, modern) ||
    !isUri(value.uri) ||
    (value.mimeType !== undefined && typeof value.mimeType !== 'string')
  )
    return false;
  return (
    (typeof value.text === 'string') !== (typeof value.blob === 'string') &&
    isOptionalString(value.text) &&
    (value.blob === undefined || isBase64String(value.blob))
  );
}

function isBase64String(value) {
  if (
    typeof value !== 'string' ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    return false;
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function isProtocolVersion(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1];
}

function isToolDefinition(value, modern) {
  return (
    isRecord(value) &&
    isOptionalMeta(value._meta, modern) &&
    typeof value.name === 'string' &&
    isInputSchema(value.inputSchema) &&
    (value.outputSchema === undefined || isOutputSchema(value.outputSchema)) &&
    isOptionalString(value.description) &&
    isOptionalString(value.title) &&
    isOptionalToolAnnotations(value.annotations) &&
    isOptionalIcons(value.icons)
  );
}

function isServerCapabilities(value) {
  if (!isRecord(value)) return false;
  if (value.completions !== undefined && !isRecord(value.completions)) return false;
  if (value.logging !== undefined && !isRecord(value.logging)) return false;
  const booleanFlags = {
    tools: ['listChanged'],
    resources: ['listChanged', 'subscribe'],
    prompts: ['listChanged'],
  };
  for (const [name, flags] of Object.entries(booleanFlags)) {
    const capability = value[name];
    if (
      capability !== undefined &&
      (!isRecord(capability) || flags.some((flag) => capability[flag] !== undefined && typeof capability[flag] !== 'boolean'))
    )
      return false;
  }
  const experimental = value.experimental;
  if (experimental !== undefined && (!isRecord(experimental) || Object.values(experimental).some((settings) => !isRecord(settings))))
    return false;
  const extensions = value.extensions;
  if (
    extensions !== undefined &&
    (!isRecord(extensions) ||
      Object.entries(extensions).some(([key, settings]) => !key.includes('/') || !isValidMetaKey(key) || !isRecord(settings)))
  )
    return false;
  return true;
}

function isResourceDefinition(value, modern) {
  return (
    isRecord(value) &&
    isOptionalMeta(value._meta, modern) &&
    typeof value.name === 'string' &&
    isUri(value.uri) &&
    isOptionalString(value.title) &&
    isOptionalString(value.description) &&
    isOptionalString(value.mimeType) &&
    isOptionalAnnotations(value.annotations) &&
    isOptionalIcons(value.icons) &&
    (value.size === undefined || (Number.isInteger(value.size) && value.size >= 0))
  );
}

function isResourceTemplate(value, modern) {
  return (
    isRecord(value) &&
    isOptionalMeta(value._meta, modern) &&
    typeof value.name === 'string' &&
    isUriTemplate(value.uriTemplate) &&
    isOptionalString(value.title) &&
    isOptionalString(value.description) &&
    isOptionalString(value.mimeType) &&
    isOptionalAnnotations(value.annotations) &&
    isOptionalIcons(value.icons)
  );
}

function isUriTemplate(value) {
  if (typeof value !== 'string') return false;
  let openExpressions = 0;
  for (const character of value) {
    if (character === '{') openExpressions += 1;
    if (character === '}' && --openExpressions < 0) return false;
  }
  if (openExpressions !== 0) return false;
  try {
    uriTemplates(value);
    return true;
  } catch {
    return false;
  }
}

function isPromptDefinition(value, modern) {
  return (
    isRecord(value) &&
    isOptionalMeta(value._meta, modern) &&
    typeof value.name === 'string' &&
    isOptionalString(value.title) &&
    isOptionalString(value.description) &&
    isOptionalIcons(value.icons) &&
    (value.arguments === undefined ||
      (Array.isArray(value.arguments) &&
        value.arguments.every(
          (argument) =>
            isRecord(argument) &&
            typeof argument.name === 'string' &&
            isOptionalString(argument.title) &&
            isOptionalString(argument.description) &&
            (argument.required === undefined || typeof argument.required === 'boolean'),
        )))
  );
}

function isResourceLink(value, modern) {
  return (
    isOptionalMeta(value._meta, modern) &&
    isUri(value.uri) &&
    typeof value.name === 'string' &&
    isOptionalString(value.title) &&
    isOptionalString(value.description) &&
    isOptionalString(value.mimeType) &&
    isOptionalAnnotations(value.annotations) &&
    isOptionalIcons(value.icons) &&
    (value.size === undefined || (Number.isInteger(value.size) && value.size >= 0))
  );
}

function isOptionalString(value) {
  return value === undefined || typeof value === 'string';
}

function isOptionalMeta(value, modern = false) {
  return value === undefined || (isRecord(value) && (!modern || Object.keys(value).every(isValidMetaKey)));
}

function isValidMetaKey(key) {
  const slash = key.indexOf('/');
  if (slash === -1) return isValidMetaName(key);
  if (slash !== key.lastIndexOf('/')) return false;
  const prefix = key.slice(0, slash);
  const name = key.slice(slash + 1);
  return prefix.split('.').every((label) => /^[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)) && isValidMetaName(name);
}

function isValidMetaName(name) {
  return name === '' || /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(name);
}

function isOptionalResultMeta(value) {
  return (
    value === undefined ||
    (isOptionalMeta(value, true) &&
      (value['io.modelcontextprotocol/serverInfo'] === undefined || isImplementation(value['io.modelcontextprotocol/serverInfo'])))
  );
}

function isImplementation(value) {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.version === 'string' &&
    isOptionalString(value.title) &&
    isOptionalString(value.description) &&
    (value.websiteUrl === undefined || isUri(value.websiteUrl)) &&
    isOptionalIcons(value.icons)
  );
}

function isInputSchema(value) {
  return isRecord(value) && value.type === 'object' && isOptionalString(value.$schema);
}

function isOutputSchema(value) {
  return isRecord(value) && isOptionalString(value.$schema);
}

function isUri(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    /[^\x21-\x7e]|[<>"{}|\\^`]/.test(value) ||
    /%(?![\da-f]{2})/i.test(value)
  )
    return false;
  try {
    return Boolean(new URL(value).protocol);
  } catch {
    return false;
  }
}

function isOptionalIcons(value) {
  return value === undefined || (Array.isArray(value) && value.every(isIcon));
}

function isIcon(value) {
  return (
    isRecord(value) &&
    isUri(value.src) &&
    isOptionalString(value.mimeType) &&
    (value.sizes === undefined || (Array.isArray(value.sizes) && value.sizes.every((size) => typeof size === 'string'))) &&
    (value.theme === undefined || value.theme === 'light' || value.theme === 'dark')
  );
}

function isOptionalAnnotations(value) {
  return (
    value === undefined ||
    (isRecord(value) &&
      (value.priority === undefined || (typeof value.priority === 'number' && value.priority >= 0 && value.priority <= 1)) &&
      (value.lastModified === undefined || typeof value.lastModified === 'string') &&
      (value.audience === undefined ||
        (Array.isArray(value.audience) && value.audience.every((role) => role === 'user' || role === 'assistant'))))
  );
}

function isOptionalToolAnnotations(value) {
  return (
    isOptionalAnnotations(value) &&
    (value === undefined ||
      (isOptionalString(value.title) &&
        ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'].every(
          (hint) => value[hint] === undefined || typeof value[hint] === 'boolean',
        )))
  );
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mcpError(message, code) {
  return Object.assign(new Error(message), { code });
}
