const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const sdkPackagePath = join(__dirname, "..", "node_modules", "@lmstudio", "sdk", "package.json");
const sdkPackage = JSON.parse(readFileSync(sdkPackagePath, "utf8"));
if (sdkPackage.version !== "2.1.0") throw new Error(`Expected @lmstudio/sdk 2.1.0 before applying the Zod v4 compatibility patch; found ${sdkPackage.version}`);

const sdkBundlePath = join(__dirname, "..", "node_modules", "@lmstudio", "sdk", "dist", "index.mjs");
let source = readFileSync(sdkBundlePath, "utf8");
function replaceSdkCall(oldValues, newValue, label) {
  if (source.includes(newValue)) return;
  const oldValue = oldValues.find((value) => source.includes(value));
  if (!oldValue) throw new Error(`Unexpected @lmstudio/sdk 2.1.0 ${label} compatibility surface`);
  source = source.replace(oldValue, newValue);
}

replaceSdkCall([
  "const decisionLoadModelConfigSchema = llmLoadModelConfigSchema\n    .innerType()\n    .pick({",
  "const decisionLoadModelConfigSchema = llmLoadModelConfigSchema\n    .unwrap()\n    .pick({",
], "const decisionLoadModelConfigSchema = z.object(llmLoadModelConfigSchema.shape)\n    .pick({", "load-config extraction");
replaceSdkCall([
  "return decisionLoadModelConfigSchema.innerType().parse({",
  "return decisionLoadModelConfigSchema.unwrap().parse({",
], "return decisionLoadModelConfigSchema.parse({", "load-config parsing");
replaceSdkCall([
  "const allowableEnvVarsSchema = z.record(allowableEnvVarKeysSchema, z.string());",
], "const allowableEnvVarsSchema = z.partialRecord(allowableEnvVarKeysSchema, z.string());", "optional environment variables");
writeFileSync(sdkBundlePath, source);
process.stdout.write("Applied the pinned LM Studio SDK Zod v4 compatibility patches.\n");
