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

/** Reject modern MCP control-flow results that Xyst does not yet implement. */
export function validateMcpResultType(result, { protocolVersion, serverName, method }) {
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
      !result.supportedVersions.every((version) => typeof version === 'string') ||
      !isRecord(result.capabilities))
  )
    throw mcpError(`MCP server '${serverName}' returned invalid discovery metadata`, 'MCP_INVALID_RESPONSE');
  if (method === 'tools/call') validateToolCallResult(result, { protocolVersion, serverName });
  if (method === 'resources/read') validateResourceReadResult(result, serverName);
  if (method === 'prompts/get') validatePromptResult(result, serverName);
  if (protocolVersion !== MODERN_PROTOCOL_VERSION || !result || typeof result !== 'object' || Array.isArray(result)) return result;
  if (!Object.hasOwn(result, 'resultType') || result.resultType === 'complete') return result;
  rejectUnsupportedResultType(result.resultType, { serverName, method });
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
  if (result.structuredContent !== undefined && !isRecord(result.structuredContent))
    throw mcpError(`MCP server '${serverName}' returned invalid structured tool content`, 'MCP_INVALID_RESPONSE');
  if (!result.content.every(isContentBlock))
    throw mcpError(`MCP server '${serverName}' returned an invalid content block`, 'MCP_INVALID_RESPONSE');
}

function validateResourceReadResult(result, serverName) {
  if (!isRecord(result) || !Array.isArray(result.contents) || !result.contents.every(isResourceContents))
    throw mcpError(`MCP server '${serverName}' returned invalid resource contents`, 'MCP_INVALID_RESPONSE');
}

function validatePromptResult(result, serverName) {
  if (
    !isRecord(result) ||
    !Array.isArray(result.messages) ||
    !result.messages.every(
      (message) => isRecord(message) && ['user', 'assistant'].includes(message.role) && isContentBlock(message.content),
    )
  )
    throw mcpError(`MCP server '${serverName}' returned invalid prompt messages`, 'MCP_INVALID_RESPONSE');
}

function isContentBlock(value) {
  if (!isRecord(value)) return false;
  if (value.type === 'text') return typeof value.text === 'string';
  if (value.type === 'image' || value.type === 'audio') return typeof value.data === 'string' && typeof value.mimeType === 'string';
  if (value.type === 'resource_link') return typeof value.uri === 'string' && typeof value.name === 'string';
  if (value.type === 'resource') {
    return isResourceContents(value.resource);
  }
  return false;
}

function isResourceContents(value) {
  return (
    isRecord(value) &&
    typeof value.uri === 'string' &&
    (typeof value.text === 'string' || typeof value.blob === 'string') &&
    (value.mimeType === undefined || typeof value.mimeType === 'string')
  );
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mcpError(message, code) {
  return Object.assign(new Error(message), { code });
}
