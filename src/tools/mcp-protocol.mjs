const MODERN_PROTOCOL_VERSION = '2026-07-28';

/** Reject modern MCP control-flow results that Xyst does not yet implement. */
export function validateMcpResultType(result, { protocolVersion, serverName, method }) {
  if (protocolVersion !== MODERN_PROTOCOL_VERSION || !result || typeof result !== 'object' || Array.isArray(result)) return result;
  if (!Object.hasOwn(result, 'resultType') || result.resultType === 'complete') return result;
  if (result.resultType === 'input_required')
    throw mcpError(
      `MCP server '${serverName}' requested interactive input during ${method}, which this client does not support`,
      'MCP_INTERACTIVE_INPUT_UNSUPPORTED',
    );
  if (result.resultType === 'task')
    throw mcpError(
      `MCP server '${serverName}' returned a task during ${method}, which this client does not support`,
      'MCP_TASK_UNSUPPORTED',
    );
  throw mcpError(`MCP server '${serverName}' returned an unsupported result type during ${method}`, 'MCP_INVALID_RESPONSE');
}

function mcpError(message, code) {
  return Object.assign(new Error(message), { code });
}
