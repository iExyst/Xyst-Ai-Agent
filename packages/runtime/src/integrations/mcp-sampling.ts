import { CreateMessageRequestParamsSchema } from "@modelcontextprotocol/core";
import type { CreateMessageResult, CreateMessageResultWithTools } from "@modelcontextprotocol/client";
import type { LMStudioChatOptions } from "../providers/lm-studio.js";

type SamplingProvider = {
  chat(options: LMStudioChatOptions, signal?: AbortSignal): Promise<Record<string, unknown>>;
  chatWithTools?: (request: {
    model: string;
    messages: unknown[];
    tools: unknown[];
    tool_choice?: "auto" | "required" | "none";
    parallel_tool_calls?: boolean;
    max_tokens?: number;
    temperature?: number;
  }, signal?: AbortSignal) => Promise<Record<string, unknown>>;
};

type JsonObject = Record<string, unknown>;
type ToolMapEntry = { mcpName: string; openAiName: string };
const samplingImageLimitBytes = 5 * 1024 * 1024;
const samplingImagesTotalLimitBytes = 10 * 1024 * 1024;

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function readText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(readText).join("");
  const item = asObject(value);
  if (!item) return "";
  if (typeof item.text === "string") return item.text;
  return readText(item.content ?? item.output_text ?? item.output ?? item.message);
}

function parseArguments(value: unknown): JsonObject {
  let parsed: unknown = value;
  if (typeof value === "string") {
    if (value.length > 20_000) throw new Error("An MCP sampling tool call exceeds the 20,000 character limit");
    try { parsed = JSON.parse(value); } catch { throw new Error("LM Studio returned invalid JSON for an MCP sampling tool call"); }
  }
  const object = asObject(parsed);
  if (!object) throw new Error("LM Studio returned non-object arguments for an MCP sampling tool call");
  if (JSON.stringify(object).length > 20_000) throw new Error("An MCP sampling tool call exceeds the 20,000 character limit");
  return object;
}

/** Bridges legacy MCP server-initiated sampling to LM Studio without executing server tools locally. */
export function createMcpSamplingHandler(provider: SamplingProvider, selectedModel: string, inferenceModel: string, signal?: AbortSignal) {
  return async (rawRequest: unknown): Promise<CreateMessageResult | CreateMessageResultWithTools> => {
    const parsed = CreateMessageRequestParamsSchema.safeParse(rawRequest);
    if (!parsed.success) throw new Error(`Invalid MCP sampling request: ${parsed.error.issues.map((issue) => issue.message).join("; ").slice(0, 1000)}`);
    const request = parsed.data;
    if (request.messages.length < 1 || request.messages.length > 32) throw new Error("MCP sampling accepts between 1 and 32 messages");
    const tools = request.tools ?? [];
    if (tools.length > 32) throw new Error("MCP sampling accepts at most 32 tools");
    const toolMap: ToolMapEntry[] = [];
    const toolNames = new Set<string>();
    const reservedOpenAiNames = new Set(tools.map((tool) => tool.name).filter((name) => /^[A-Za-z0-9_-]{1,64}$/.test(name)));
    let totalSchemaBytes = 0;
    for (const [index, tool] of tools.entries()) {
      if (toolNames.has(tool.name)) throw new Error(`MCP sampling request contains duplicate tool name: ${tool.name}`);
      toolNames.add(tool.name);
      const validOpenAiName = /^[A-Za-z0-9_-]{1,64}$/.test(tool.name);
      let openAiName = tool.name;
      if (!validOpenAiName) {
        let suffix = 0;
        do { openAiName = `xyst_mcp_tool_${index}${suffix ? `_${suffix}` : ""}`; suffix++; } while (reservedOpenAiNames.has(openAiName));
      }
      reservedOpenAiNames.add(openAiName);
      totalSchemaBytes += JSON.stringify(tool.inputSchema).length;
      if (totalSchemaBytes > 100_000) throw new Error("MCP sampling tool schemas exceed the 100,000 character limit");
      if ((tool.description?.length ?? 0) > 20_000) throw new Error(`MCP sampling tool description is too large: ${tool.name}`);
      toolMap.push({ mcpName: tool.name, openAiName });
    }
    const openAiNameForMcp = new Map(toolMap.map((entry) => [entry.mcpName, entry.openAiName]));
    const mcpNameForOpenAi = new Map(toolMap.map((entry) => [entry.openAiName, entry.mcpName]));
    const inputMessages: unknown[] = [];
    const outstandingCalls = new Map<string, string>();
    const completedCalls = new Set<string>();
    let imageBytes = 0;
    let hasImages = false;
    const toOpenAiContent = (block: JsonObject): unknown => {
      if (block.type === "text" && typeof block.text === "string") {
        if (block.text.length > 20_000) throw new Error("An MCP sampling message exceeds the 20,000 character limit");
        return { type: "text", text: block.text };
      }
      if (block.type !== "image" || typeof block.data !== "string" || typeof block.mimeType !== "string") throw new Error("MCP sampling supports text and image content; audio sampling is unsupported");
      const mimeType = block.mimeType.toLowerCase();
      if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mimeType)) throw new Error(`MCP sampling does not support image MIME type: ${block.mimeType}`);
      const data = block.data;
      if (data.length > Math.ceil(samplingImageLimitBytes / 3) * 4) throw new Error("An MCP sampling image exceeds the 5 MiB limit");
      if (!data || data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error("MCP sampling image data must be valid base64");
      const bytes = Buffer.from(data, "base64").byteLength;
      if (bytes > samplingImageLimitBytes) throw new Error("An MCP sampling image exceeds the 5 MiB limit");
      imageBytes += bytes;
      if (imageBytes > samplingImagesTotalLimitBytes) throw new Error("MCP sampling images exceed the 10 MiB request limit");
      hasImages = true;
      return { type: "image_url", image_url: { url: `data:${mimeType};base64,${data}` } };
    };

    for (const message of request.messages) {
      const content = message.content as JsonObject;
      if (Array.isArray(message.content)) {
        const parts = message.content.map((part) => {
          const block = asObject(part);
          if (!block) throw new Error("MCP sampling content blocks must be objects");
          return toOpenAiContent(block);
        });
        inputMessages.push({ role: message.role, content: parts });
        continue;
      }
      if (content.type === "text" && typeof content.text === "string") {
        if (content.text.length > 20_000) throw new Error("An MCP sampling message exceeds the 20,000 character limit");
        inputMessages.push({ role: message.role, content: content.text });
        continue;
      }
      if (content.type === "image") {
        inputMessages.push({ role: message.role, content: [toOpenAiContent(content)] });
        continue;
      }
      if (content.type === "tool_use") {
        if (message.role !== "assistant" || tools.length === 0) throw new Error("MCP sampling tool-use history requires assistant role and request-scoped tools");
        const id = String(content.id ?? "");
        const name = String(content.name ?? "");
        const openAiName = openAiNameForMcp.get(name);
        if (!id || !openAiName || outstandingCalls.has(id) || completedCalls.has(id)) throw new Error("MCP sampling history contains an unknown or duplicate tool call");
        const args = asObject(content.input);
        if (!args) throw new Error("MCP sampling tool-use input must be a JSON object");
        if (JSON.stringify(args).length > 20_000) throw new Error("An MCP sampling tool-use input exceeds the 20,000 character limit");
        outstandingCalls.set(id, name);
        inputMessages.push({ role: "assistant", tool_calls: [{ id, type: "function", function: { name: openAiName, arguments: JSON.stringify(args) } }] });
        continue;
      }
      if (content.type === "tool_result") {
        if (message.role !== "user" || tools.length === 0) throw new Error("MCP sampling tool results require user role and request-scoped tools");
        const id = String(content.toolUseId ?? "");
        if (!id || !outstandingCalls.has(id) || completedCalls.has(id)) throw new Error("MCP sampling history contains a tool result with no matching prior tool call");
        const resultContent = Array.isArray(content.content) ? content.content : [];
        const mappedParts = resultContent.map((part) => {
          const block = asObject(part);
          if (!block) throw new Error("MCP sampling tool results must contain content block objects");
          return toOpenAiContent(block) as JsonObject;
        });
        const textParts = mappedParts.filter((part) => part.type === "text").map((part) => String(part.text ?? ""));
        if (textParts.join("\n").length > 20_000) throw new Error("An MCP sampling tool result exceeds the 20,000 character limit");
        const result = mappedParts.some((part) => part.type === "image_url") ? mappedParts : textParts.join("\n");
        inputMessages.push({ role: "tool", tool_call_id: id, content: result });
        outstandingCalls.delete(id);
        completedCalls.add(id);
        continue;
      }
      throw new Error("MCP sampling currently accepts text and image messages plus tool-use/result blocks; audio sampling is unsupported");
    }
    if (outstandingCalls.size > 0) throw new Error("MCP sampling history is missing results for prior tool calls");

    const systemPrompt = typeof request.systemPrompt === "string" ? request.systemPrompt.slice(0, 20_000) : undefined;
    if (request.toolChoice?.mode === "required" && tools.length === 0) throw new Error("MCP sampling requires a tool but the request declares no tools");
    const requestedTokens = Number.isFinite(request.maxTokens) ? Math.floor(request.maxTokens) : 512;
    const maxTokens = Math.max(1, Math.min(2048, requestedTokens));
    const temperature = typeof request.temperature === "number" ? Math.max(0, Math.min(1, request.temperature)) : undefined;
    let response: Record<string, unknown>;
    if (tools.length > 0 || hasImages) {
      if (!provider.chatWithTools) throw new Error("The active inference provider does not support multimodal MCP sampling");
      response = await provider.chatWithTools({
        model: inferenceModel,
        messages: [...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []), ...inputMessages],
        tools: tools.map((tool, index) => ({ type: "function", function: {
          name: toolMap[index]!.openAiName,
          description: `${tool.description ?? `MCP tool ${tool.name}`}${tool.name === toolMap[index]!.openAiName ? "" : `\nOriginal MCP tool name: ${tool.name}`}`.slice(0, 4000),
          parameters: tool.inputSchema
        } })),
        ...(tools.length ? { tool_choice: request.toolChoice?.mode ?? "auto", parallel_tool_calls: false } : {}),
        max_tokens: maxTokens,
        ...(temperature === undefined ? {} : { temperature })
      }, signal);
    } else {
      response = await provider.chat({ model: inferenceModel, input: inputMessages as Array<Record<string, unknown>>, ...(systemPrompt ? { system_prompt: systemPrompt } : {}), max_output_tokens: maxTokens, ...(temperature === undefined ? {} : { temperature }) }, signal);
    }

    const choices = Array.isArray(response.choices) ? response.choices : [];
    const firstChoice = asObject(choices[0]);
    const choiceMessage = asObject(firstChoice?.message);
    const toolCalls = Array.isArray(choiceMessage?.tool_calls) ? choiceMessage.tool_calls : [];
    if (tools.length > 0 && toolCalls.length > 0) {
      if (toolCalls.length !== 1) throw new Error("MCP sampling can return one tool call per response");
      if (typeof choiceMessage?.content === "string" && choiceMessage.content.trim()) throw new Error("LM Studio returned both text and a tool call for MCP sampling; refusing to discard either result");
      const call = asObject(toolCalls[0]);
      const functionCall = asObject(call?.function);
      const returnedName = typeof functionCall?.name === "string" ? functionCall.name : "";
      const mcpName = mcpNameForOpenAi.get(returnedName);
      const id = typeof call?.id === "string" && call.id.length > 0 ? call.id : "";
      if (!mcpName || !id) throw new Error("LM Studio returned an MCP sampling tool call that was not declared in the request");
      if (request.toolChoice?.mode === "none") throw new Error("LM Studio returned a tool call when the MCP request prohibited tool use");
      return { model: selectedModel, role: "assistant", content: { type: "tool_use", id, name: mcpName, input: parseArguments(functionCall?.arguments) }, stopReason: "toolUse" };
    }
    if (tools.length > 0 && request.toolChoice?.mode === "required") throw new Error("LM Studio did not return a tool call required by the MCP sampling request");
    const text = readText(response.output_text ?? response.output ?? response.content ?? choiceMessage?.content);
    if (!text.trim()) throw new Error("LM Studio returned no text for the MCP sampling request");
    const stopReason = firstChoice?.finish_reason === "length" ? "maxTokens" : "endTurn";
    return { model: selectedModel, role: "assistant", content: { type: "text", text }, stopReason };
  };
}
