import { z } from "zod";
import { createText, deletePath, listFiles, patchText, readText, searchFiles, movePath } from "./files.js";
import { createWebTools, type WebToolDependencies } from "./web.js";
import { createOfficeTools, type PdfOcrLanguage } from "./office.js";
import { createSkillTools } from "./skills.js";
import { createDesktopAutomationTools } from "./desktop-automation.js";
import { runProcess } from "../platform.js";
import type { AccessController } from "../access.js";
import { resolve } from "node:path";

type Tool = { definition: Record<string, unknown>; execute(args: unknown, signal?: AbortSignal): Promise<unknown> };

export function createAgentTools(access: AccessController, workspace = process.cwd(), webDependencies: WebToolDependencies = {}, ocrLanguages: PdfOcrLanguage[] = ["eng"], officeRendererExecutable: string | null = null, desktopAutomationEnabled = false): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  const add = (name: string, description: string, parameters: Record<string, unknown>, schema: z.ZodType, execute: (args: any, signal?: AbortSignal) => Promise<unknown>) => {
    tools[name] = {
      definition: { type: "function", function: { name, description, parameters } },
      execute: async (input, signal) => execute(schema.parse(input), signal)
    };
  };
  add("file_read", "Read a UTF-8 text FILE. Use the file path, not a directory. Line numbers are 1-based; use 1 for the first line or omit both range fields to read all lines.", { type: "object", properties: { path: { type: "string" }, start_line: { type: "integer", minimum: 0 }, end_line: { type: "integer", minimum: 1 } }, required: ["path"], additionalProperties: false }, z.object({ path: z.string().min(1), start_line: z.number().int().min(0).optional().transform((value) => value === 0 ? 1 : value), end_line: z.number().int().positive().optional() }).strict(), async (args) => {
    const path = await access.assertPath(resolve(workspace, args.path), "read"); return readText(path, args.start_line ? { startLine: args.start_line, endLine: args.end_line ?? args.start_line } : undefined);
  });
  add("file_list", "List files and directories in a folder.", { type: "object", properties: { path: { type: "string" }, recursive: { type: "boolean" } }, required: ["path"], additionalProperties: false }, z.object({ path: z.string().min(1), recursive: z.boolean().optional() }).strict(), async (args) => {
    const path = await access.assertPath(resolve(workspace, args.path), "read"); return listFiles(path, args.recursive ?? false);
  });
  add("file_search", "Search source files under a folder for a string. Build output, .git, node_modules, and coverage directories are skipped.", { type: "object", properties: { path: { type: "string" }, query: { type: "string" }, max_matches: { type: "integer", minimum: 1, maximum: 200 } }, required: ["path", "query"], additionalProperties: false }, z.object({ path: z.string().min(1), query: z.string().min(1), max_matches: z.number().int().min(1).max(200).optional() }).strict(), async (args) => {
    const path = await access.assertPath(resolve(workspace, args.path), "read"); return searchFiles(path, args.query, { maxMatches: args.max_matches ?? 100 });
  });
  add("file_create", "Create a new UTF-8 text file. This fails if the path already exists.", { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false }, z.object({ path: z.string().min(1), content: z.string() }).strict(), async (args) => {
    const path = await access.assertPath(resolve(workspace, args.path), "write"); return { path: await createText(path, args.content) };
  });
  add("file_patch", "Replace one unique exact text block after verifying the file's SHA-256 hash. First read the file and copy its sha256.", { type: "object", properties: { path: { type: "string" }, expected_sha256: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "expected_sha256", "old_text", "new_text"], additionalProperties: false }, z.object({ path: z.string().min(1), expected_sha256: z.string().regex(/^[a-f0-9]{64}$/i), old_text: z.string().min(1), new_text: z.string() }).strict(), async (args) => {
    const path = await access.assertPath(resolve(workspace, args.path), "write"); return patchText(path, args.expected_sha256, args.old_text, args.new_text);
  });
  add("file_delete", "Delete a file or directory. Use only when the task explicitly requires deletion.", { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }, z.object({ path: z.string().min(1) }).strict(), async (args) => {
    const path = await access.assertPath(resolve(workspace, args.path), "write"); await deletePath(path); return { deleted: path };
  });
  add("file_move", "Move or rename a file or directory. The destination must not already exist.", { type: "object", properties: { source: { type: "string" }, destination: { type: "string" } }, required: ["source", "destination"], additionalProperties: false }, z.object({ source: z.string().min(1), destination: z.string().min(1) }).strict(), async (args) => {
    const source = resolve(workspace, args.source); const destination = resolve(workspace, args.destination);
    const allowedSource = await access.assertPath(source, "write"); const allowedDestination = await access.assertPath(destination, "write");
    return { moved: await movePath(allowedSource, allowedDestination) };
  });
  add("run_process", "Run an executable with an explicit argv array. No shell parsing occurs. Use the executable and arguments separately.", { type: "object", properties: { executable: { type: "string" }, args: { type: "array", items: { type: "string" } }, cwd: { type: "string" }, timeout_ms: { type: "integer", minimum: 100, maximum: 120000 } }, required: ["executable", "args"], additionalProperties: false }, z.object({ executable: z.string().min(1), args: z.array(z.string()).max(100), cwd: z.string().optional(), timeout_ms: z.number().int().min(100).max(120000).optional() }).strict(), async (args, signal) => {
    access.assertCapability("externalActions"); access.assertExecutable(args.executable);
    const cwd = await access.assertPath(resolve(workspace, args.cwd ?? "."), "read");
    const result = await runProcess(args.executable, args.args, { cwd, timeoutMs: args.timeout_ms ?? 30000, maxOutputChars: 30000, ...(signal ? { signal } : {}) });
    return { code: result.code, signal: result.signal, stdout: result.stdout, stderr: result.stderr, durationMs: result.durationMs };
  });
  return { ...tools, ...createWebTools(access, webDependencies), ...createOfficeTools(access, workspace, ocrLanguages, officeRendererExecutable), ...createDesktopAutomationTools(access, desktopAutomationEnabled), ...createSkillTools(access, workspace) };
}
