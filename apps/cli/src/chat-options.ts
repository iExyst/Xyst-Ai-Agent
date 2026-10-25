import type { LMStudioChatOptions } from "@xyst/runtime";

export type ParsedChatOptions = LMStudioChatOptions & { integrationFile?: string };

export function parseChatOptions(tokens: string[], model: string): ParsedChatOptions {
  const options: ParsedChatOptions = { model, input: "" };
  const prompt: string[] = [];
  const seen = new Set<string>();
  const decimalOptions = new Map<string, { key: "temperature" | "top_p" | "min_p" | "repeat_penalty"; min: number; max: number }>([
    ["--temperature", { key: "temperature", min: 0, max: 2 }],
    ["--top-p", { key: "top_p", min: 0, max: 1 }],
    ["--min-p", { key: "min_p", min: 0, max: 1 }],
    ["--repeat-penalty", { key: "repeat_penalty", min: 0.1, max: 5 }]
  ]);
  for (let index = 0; index < tokens.length; index++) {
    const flag = tokens[index]!;
    if (flag === "--") { prompt.push(...tokens.slice(index + 1)); break; }
    if (flag.startsWith("--")) {
      if (seen.has(flag)) throw new Error(`${flag} can be supplied once`);
      seen.add(flag);
    }
    const decimal = decimalOptions.get(flag);
    if (decimal) {
      const raw = tokens[++index]; const value = raw === undefined ? Number.NaN : Number(raw);
      if (raw === undefined || !/^-?(?:\d+\.?\d*|\.\d+)$/.test(raw) || !Number.isFinite(value) || value < decimal.min || value > decimal.max) {
        throw new Error(`${flag} requires a number from ${decimal.min} to ${decimal.max}`);
      }
      options[decimal.key] = value;
    } else if (flag === "--top-k" || flag === "--max-output-tokens" || flag === "--context-length") {
      const raw = tokens[++index]; const value = raw === undefined ? Number.NaN : Number(raw);
      const max = flag === "--top-k" ? 1000 : 1_000_000;
      if (raw === undefined || !/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > max) {
        throw new Error(`${flag} requires a positive integer from 1 to ${max}`);
      }
      if (flag === "--top-k") options.top_k = value;
      else if (flag === "--max-output-tokens") options.max_output_tokens = value;
      else options.context_length = value;
    } else if (flag === "--reasoning") {
      const raw = tokens[++index];
      if (!["off", "low", "medium", "high", "on"].includes(raw ?? "")) throw new Error("--reasoning requires off, low, medium, high, or on");
      options.reasoning = raw as NonNullable<LMStudioChatOptions["reasoning"]>;
    } else if (flag === "--stateful") options.store = true;
    else if (flag === "--previous-response-id") {
      const value = tokens[++index];
      if (!value?.trim() || value.startsWith("--")) throw new Error("--previous-response-id requires a response ID");
      options.previous_response_id = value;
    } else if (flag === "--integration-file") {
      const value = tokens[++index];
      if (!value?.trim() || value.startsWith("--")) throw new Error("--integration-file requires a JSON file path");
      options.integrationFile = value;
    } else if (flag.startsWith("--")) throw new Error(`Unknown LM Studio chat option: ${flag}`);
    else prompt.push(flag);
  }
  options.input = prompt.join(" ");
  if (!options.input.trim()) throw new Error("A prompt is required after the LM Studio options");
  return options;
}
