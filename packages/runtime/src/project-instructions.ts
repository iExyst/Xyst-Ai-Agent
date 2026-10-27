import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { AccessController } from "./access.js";

const skippedDirectories = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", "release"]);
const maxDepth = 8;
const maxFiles = 50;
const maxFileChars = 16_000;
const maxTotalChars = 50_000;

export async function loadProjectInstructions(access: AccessController, workspace: string): Promise<string> {
  const root = await access.assertPath(resolve(workspace), "read");
    const canonicalRoot = await realpath(root).catch(() => root);
  const found: Array<{ path: string; text: string; depth: number }> = [];
  let safetyLimitReached = false;
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > maxDepth || found.length >= maxFiles) return;
      const canonicalDirectory = await realpath(directory).catch(() => directory);
    const relDir = relative(canonicalRoot, canonicalDirectory);
    if (relDir === ".." || relDir.startsWith(`..${sep}`)) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const instruction = entries.find((entry) => entry.name.toLowerCase() === "agents.md" && entry.isFile());
    if (instruction && found.length < maxFiles) {
      const path = resolve(directory, instruction.name);
      const allowed = await access.assertPath(path, "read");
      const canonicalFile = await realpath(allowed).catch(() => allowed);
      const relFile = relative(canonicalRoot, canonicalFile);
      if (relFile !== ".." && !relFile.startsWith(`..${sep}`)) {
        if ((await stat(allowed)).size > maxFileChars * 4) safetyLimitReached = true;
        else {
          const bytes = await readFile(allowed);
          const text = bytes.toString("utf8");
          found.push({ path: relative(canonicalRoot, canonicalFile) || "AGENTS.md", text: text.slice(0, maxFileChars), depth });
        }
      }
    }
    if (depth === maxDepth) return;
    for (const entry of entries) {
      if (found.length >= maxFiles) break;
      if (!entry.isDirectory() || skippedDirectories.has(entry.name.toLowerCase())) continue;
      await walk(resolve(directory, entry.name), depth + 1);
    }
  }
  await walk(root, 0);
  found.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
  let remaining = maxTotalChars;
  const blocks: string[] = [];
  for (const item of found) {
    if (!remaining) break;
    const body = item.text.slice(0, remaining);
    blocks.push(`--- ${item.path} (depth ${item.depth}) ---\n${body}`);
    remaining -= body.length;
  }
  if (!blocks.length) return "";
  const clipped = safetyLimitReached || found.length >= maxFiles || found.some((item) => item.text.length >= maxFileChars) || remaining === 0;
  if (clipped) blocks.push("[Project instruction context was truncated at the configured safety limit.]");
  return blocks.join("\n\n");
}
