const MODERN_PROTOCOL_VERSION = '2026-07-28';

/** Reject modern MCP control-flow results that Xyst does not yet implement. */
export function validateMcpResultType(result, { protocolVersion, serverName, method }) {
  if (
    protocolVersion === MODERN_PROTOCOL_VERSION &&
    isRecord(result) &&
    Object.hasOwn(result, 'resultType') &&
    result.resultType !== 'complete'
  )
    rejectUnsupportedResultType(result.resultType, { serverName, method });
  if (method === 'tools/call') validateToolCallResult(result, { protocolVersion, serverName });
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

function isContentBlock(value) {
  if (!isRecord(value)) return false;
  if (value.type === 'text') return typeof value.text === 'string';
  if (value.type === 'image' || value.type === 'audio') return typeof value.data === 'string' && typeof value.mimeType === 'string';
  if (value.type === 'resource_link') return typeof value.uri === 'string' && typeof value.name === 'string';
  if (value.type === 'resource') {
    const resource = value.resource;
    return (
      isRecord(resource) &&
      typeof resource.uri === 'string' &&
      (typeof resource.text === 'string' || typeof resource.blob === 'string') &&
      (resource.mimeType === undefined || typeof resource.mimeType === 'string')
    );
  }
  return false;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mcpError(message, code) {
  return Object.assign(new Error(message), { code });
}
