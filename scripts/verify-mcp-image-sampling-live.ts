import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createMcpSamplingHandler } from "../packages/runtime/src/integrations/mcp-sampling.js";
import { LMStudioProvider } from "../packages/runtime/src/providers/lm-studio.js";

const model = process.env.XYST_LIVE_MCP_IMAGE_MODEL ?? "qwen/qwen3.5-9b";
const fixtureUrl = new URL("../docs/evidence/mcp-image-sampling-ground-truth.png", import.meta.url);
const provider = new LMStudioProvider();
const inventory = await provider.models();
const resident = inventory.find((candidate) => candidate.key === model && candidate.type === "llm" && candidate.capabilities?.vision === true && candidate.loaded_instances.length > 0);
if (!resident) throw new Error(`Refusing to load a model: vision-capable ${model} is not already loaded in LM Studio`);

const image = await readFile(fixtureUrl);
const imageBase64 = image.toString("base64");
const sample = createMcpSamplingHandler(provider, model, model);
const maxTokens = 512;
const temperature = 0;
const color = (result: Awaited<ReturnType<typeof sample>>): string => {
  const content = result.content;
  return !Array.isArray(content) && content.type === "text" ? content.text.trim().toLowerCase() : "";
};

const userImageResult = await sample({
  messages: [{ role: "user", content: [
    { type: "text", text: "What color is the square? Reply with only its color." },
    { type: "image", data: imageBase64, mimeType: "image/png" }
  ] }],
  maxTokens,
  temperature
});
assert.equal(color(userImageResult), "red", "the model must identify the fixture's red square from user image content");

const toolResultImageResult = await sample({
  messages: [
    { role: "user", content: { type: "text", text: "Inspect the image returned by get_rendered_image. What color is the square? Reply with only its color." } },
    { role: "assistant", content: { type: "tool_use", id: "preview-call", name: "get_rendered_image", input: {} } },
    { role: "user", content: { type: "tool_result", toolUseId: "preview-call", content: [
      { type: "text", text: "Rendered page preview follows." },
      { type: "image", data: imageBase64, mimeType: "image/png" }
    ] } }
  ],
  tools: [{ name: "get_rendered_image", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
  maxTokens,
  temperature
});
assert.equal(color(toolResultImageResult), "red", "the model must identify the fixture's red square from an image returned by a tool");

process.stdout.write(`${JSON.stringify({
  verifiedAt: new Date().toISOString(),
  model,
  modelWasAlreadyLoaded: true,
  modelVisionCapability: resident.capabilities?.vision === true,
  contextLength: resident.loaded_instances[0]?.config.context_length ?? null,
  fixture: "docs/evidence/mcp-image-sampling-ground-truth.png",
  fixtureBytes: image.byteLength,
  fixtureSha256: createHash("sha256").update(image).digest("hex"),
  maxTokens,
  temperature,
  userImageAnswer: color(userImageResult),
  toolResultImageAnswer: color(toolResultImageResult),
  modelWasLoadedOrUnloaded: false
})}\n`);
