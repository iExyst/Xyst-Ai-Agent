import type { LMStudioLoadOptions } from "@xyst/runtime";

export function parseLoadOptions(tokens: string[]): LMStudioLoadOptions {
  const options: LMStudioLoadOptions = { echo_load_config: true };
  if (tokens.length === 1 && /^\d+$/.test(tokens[0]!)) {
    options.context_length = parsePositiveInteger(tokens[0]!, "Context length");
    return options;
  }
  const numericFlags = new Map<string, keyof Pick<LMStudioLoadOptions, "context_length" | "eval_batch_size" | "num_experts">>([
    ["--context-length", "context_length"], ["--eval-batch-size", "eval_batch_size"], ["--num-experts", "num_experts"]
  ]);
  for (let index = 0; index < tokens.length; index++) {
    const flag = tokens[index]!;
    const property = numericFlags.get(flag);
    if (property) {
      const raw = tokens[++index];
      if (raw === undefined) throw new Error(`${flag} requires a positive integer`);
      options[property] = parsePositiveInteger(raw, flag);
    } else if (flag === "--flash-attention") options.flash_attention = true;
    else if (flag === "--no-flash-attention") options.flash_attention = false;
    else if (flag === "--offload-kv-cache-to-gpu") options.offload_kv_cache_to_gpu = true;
    else if (flag === "--no-offload-kv-cache-to-gpu") options.offload_kv_cache_to_gpu = false;
    else if (flag === "--gpu") {
      const raw = tokens[++index];
      if (raw === undefined) throw new Error("--gpu requires auto, off, max, or a ratio from 0 to 1");
      if (["auto", "off", "max"].includes(raw)) options.gpu_offload = raw as "auto" | "off" | "max";
      else {
        const ratio = Number(raw);
        if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(raw) || !Number.isFinite(ratio)) throw new Error("--gpu requires auto, off, max, or a ratio from 0 to 1");
        options.gpu_offload = ratio;
      }
    } else if (flag === "--speculative-draft-mtp") options.speculative_draft_mtp = true;
    else if (flag === "--no-speculative-draft-mtp") options.speculative_draft_mtp = false;
    else if (flag === "--speculative-draft-model") {
      const model = tokens[++index];
      if (!model?.trim()) throw new Error("--speculative-draft-model requires an installed model key");
      options.draft_model = model;
    } else if (flag === "--speculative-draft-max-tokens" || flag === "--speculative-draft-min-tokens") {
      const raw = tokens[++index];
      if (raw === undefined) throw new Error(flag + " requires a positive integer");
      const value = parsePositiveInteger(raw, flag);
      if (flag === "--speculative-draft-max-tokens") options.speculative_draft_max_tokens = value;
      else options.speculative_draft_min_tokens = value;
    } else if (flag === "--speculative-draft-min-continue-probability") {
      const raw = tokens[++index]; const probability = Number(raw);
      if (raw === undefined || !/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(raw) || probability < 0 || probability > 1) throw new Error(flag + " requires a probability from 0 to 1");
      options.speculative_draft_min_continue_probability = probability;
    }
    else if (flag === "--ttl") {
      const raw = tokens[++index];
      if (raw === undefined) throw new Error("--ttl requires a positive number of seconds");
      options.ttl_seconds = parsePositiveInteger(raw, "--ttl");
    } else if (flag === "--echo-load-config") options.echo_load_config = true;
    else throw new Error(`Unknown LM Studio load option: ${flag}`);
  }
  if (options.draft_model && options.speculative_draft_mtp) throw new Error("Choose either a speculative draft model or Draft MTP");
  if ((options.speculative_draft_max_tokens !== undefined || options.speculative_draft_min_tokens !== undefined || options.speculative_draft_min_continue_probability !== undefined) && !options.draft_model && options.speculative_draft_mtp !== true) {
    throw new Error("Choose a speculative draft model or Draft MTP before setting draft limits");
  }
  if (options.speculative_draft_min_tokens !== undefined && options.speculative_draft_max_tokens !== undefined && options.speculative_draft_min_tokens > options.speculative_draft_max_tokens) throw new Error("Minimum draft tokens cannot exceed maximum draft tokens");
  return options;
}

function parsePositiveInteger(raw: string, name: string): number {
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
