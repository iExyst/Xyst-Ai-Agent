export type ParsedResponsesRequest = Record<string, unknown> & {
  model: string;
  input: string | Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
};

const responseFields = new Set([
  "model", "input", "instructions", "max_output_tokens", "metadata", "parallel_tool_calls", "text",
  "previous_response_id", "prompt", "reasoning", "store", "temperature", "top_p",
  "tool_choice", "tools", "truncation", "user"
]);

export function parseResponsesRequest(value: unknown): ParsedResponsesRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Responses request file must contain a JSON object");
  const request = value as Record<string, unknown>;
  const unknown = Object.keys(request).filter((key) => !responseFields.has(key));
  if (unknown.length) throw new Error(`Unsupported Responses request field: ${unknown.join(", ")}`);
  if (typeof request.model !== "string" || !request.model.trim() || request.model.length > 500) throw new Error("Responses request requires a non-empty model key (at most 500 characters)");
  if (typeof request.input !== "string" && !Array.isArray(request.input)) throw new Error("Responses request requires input text or an input-item array");
  if (Array.isArray(request.input) && request.input.some((item) => !item || typeof item !== "object" || Array.isArray(item))) throw new Error("Responses input items must be JSON objects");
  if (request.tools !== undefined && (!Array.isArray(request.tools) || request.tools.length > 64 || request.tools.some((item) => !item || typeof item !== "object" || Array.isArray(item)))) throw new Error("Responses tools must be an array of at most 64 objects");
  if (request.store !== undefined && typeof request.store !== "boolean") throw new Error("Responses store must be a boolean");
  if (request.previous_response_id !== undefined && (typeof request.previous_response_id !== "string" || !request.previous_response_id.trim())) throw new Error("previous_response_id must be a non-empty string");
  if (request.reasoning !== undefined && (!request.reasoning || typeof request.reasoning !== "object" || Array.isArray(request.reasoning))) throw new Error("Responses reasoning must be an object");
  return structuredClone(request) as ParsedResponsesRequest;
}

function collectMcpToolLists(value: unknown, result: Array<Record<string, unknown>>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectMcpToolLists(item, result);
    return;
  }
  if (!value || typeof value !== "object") return;
  const item = value as Record<string, unknown>;
  if (item.type === "mcp_list_tools") result.push(item);
  for (const key of ["output", "response", "item"]) collectMcpToolLists(item[key], result);
}

export function responsesMcpToolsError(requestTools: Array<Record<string, unknown>> | undefined, responseOrEvents: unknown): string | undefined {
  const requestedServers = (requestTools ?? []).filter((tool) => tool.type === "mcp");
  if (!requestedServers.length) return undefined;
  const toolLists: Array<Record<string, unknown>> = [];
  collectMcpToolLists(responseOrEvents, toolLists);

  for (const server of requestedServers) {
    const label = typeof server.server_label === "string" ? server.server_label : "(unnamed server)";
    const list = toolLists.find((item) => item.server_label === label);
    if (!list) return `LM Studio did not return an MCP tool list for server "${label}". Check its Remote MCP setting and server connection.`;
    if (list.error) return `LM Studio could not initialize MCP server "${label}". Check its Remote MCP setting and server connection.`;
    const available = Array.isArray(list.tools)
      ? list.tools.flatMap((tool) => tool && typeof tool === "object" && typeof (tool as Record<string, unknown>).name === "string" ? [(tool as Record<string, unknown>).name as string] : [])
      : [];
    const allowed = Array.isArray(server.allowed_tools) ? server.allowed_tools.filter((name): name is string => typeof name === "string") : [];
    const missing = allowed.filter((name) => !available.includes(name));
    if (missing.length) return `LM Studio did not expose requested MCP tool(s) ${missing.map((name) => JSON.stringify(name)).join(", ")} from server "${label}". Check its Remote MCP setting and server tool list.`;
    if (!allowed.length && !available.length) return `LM Studio returned no tools for MCP server "${label}". Check its Remote MCP setting and server tool list.`;
  }
  return undefined;
}
