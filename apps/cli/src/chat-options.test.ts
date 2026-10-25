import assert from "node:assert/strict";
import test from "node:test";
import { parseChatOptions } from "./chat-options.js";

test("native LM Studio chat options validate and preserve inference parameters", () => {
  assert.deepEqual(parseChatOptions([
    "--temperature", "0.4", "--top-p", "0.9", "--top-k", "40", "--min-p", "0.08",
    "--repeat-penalty", "1.1", "--reasoning", "high", "--max-output-tokens", "4096",
    "--context-length", "8192", "--stateful", "--previous-response-id", "resp_123", "--integration-file", "servers.json", "Describe this", "carefully"
  ], "test-model"), {
    model: "test-model", input: "Describe this carefully", temperature: 0.4, top_p: 0.9, top_k: 40, min_p: 0.08,
    repeat_penalty: 1.1, reasoning: "high", max_output_tokens: 4096, context_length: 8192,
    store: true, previous_response_id: "resp_123", integrationFile: "servers.json"
  });
});

test("native LM Studio chat options reject unsupported values and missing prompts", () => {
  for (const args of [["--min-p", "1.1", "prompt"], ["--top-k", "0", "prompt"], ["--repeat-penalty", "0", "prompt"], ["--reasoning", "extreme", "prompt"], ["--temperature"], ["--max-output-tokens", "abc", "prompt"], ["--top-k", "20", "--top-k", "40", "prompt"], ["--integration-file"], ["--integration-file", "servers.json", "--integration-file", "other.json", "prompt"], []]) {
    assert.throws(() => parseChatOptions(args, "test-model"));
  }
  assert.equal(parseChatOptions(["--", "--treat-this-as-prompt"], "test-model").input, "--treat-this-as-prompt");
});
