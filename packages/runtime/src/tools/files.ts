import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { lock as acquireFileLock } from "proper-lockfile";
import { normalizeUserPath } from "../platform.js";

const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

const pathLocks = new Map<string, Promise<void>>();
async function withPathLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const key = process.platform === "win32" ? path.toLowerCase() : path;
  const previous = pathLocks.get(key);
  let release!: () => void;
  const current = new Promise<void>((resolveLock) => { release = resolveLock; });
  pathLocks.set(key, current);
  await previous;
  try { return await operation(); }
  finally {
    release();
    if (pathLocks.get(key) === current) pathLocks.delete(key);
  }
}

interface DecodedText { text: string; encoding: "utf-8" | "utf-16le" | "utf-16be"; encode(text: string): Buffer }
function decodeText(buffer: Buffer): DecodedText {
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]); const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(3));
    return { text, encoding: "utf-8", encode: (updated) => Buffer.concat([bom, Buffer.from(updated, "utf8")]) };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    const bom = Buffer.from([0xff, 0xfe]); const text = buffer.subarray(2).toString("utf16le");
    return { text, encoding: "utf-16le", encode: (updated) => Buffer.concat([bom, Buffer.from(updated, "utf16le")]) };
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    if ((buffer.length - 2) % 2 !== 0) throw new Error("Invalid UTF-16BE file length");
    const body = Buffer.from(buffer.subarray(2)); for (let i = 0; i < body.length; i += 2) [body[i], body[i + 1]] = [body[i + 1]!, body[i]!];
    const bom = Buffer.from([0xfe, 0xff]); const text = body.toString("utf16le");
    return { text, encoding: "utf-16be", encode: (updated) => { const le = Buffer.from(updated, "utf16le"); for (let i = 0; i < le.length; i += 2) [le[i], le[i + 1]] = [le[i + 1]!, le[i]!]; return Buffer.concat([bom, le]); } };
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  return { text, encoding: "utf-8", encode: (updated) => Buffer.from(updated, "utf8") };
}

function normalizeLineEndings(raw: string): { text: string; rawOffsets: number[] } {
  let text = ""; const rawOffsets = [0];
  for (let index = 0; index < raw.length;) {
    if (raw[index] === "\r") {
      text += "\n"; index += raw[index + 1] === "\n" ? 2 : 1; rawOffsets.push(index);
    } else { text += raw[index]!; index++; rawOffsets.push(index); }
  }
  return { text, rawOffsets };
}

export async function readText(path: string, range?: { startLine: number; endLine: number }): Promise<{ path: string; text: string; sha256: string; totalLines: number }> {
  const absolute = normalizeUserPath(path); const buffer = await readFile(absolute); const decoded = decodeText(buffer); const text = decoded.text.replace(/\r\n?/g, "\n"); const lines = text.split("\n");
  const selected = range ? lines.slice(Math.max(0, range.startLine - 1), Math.max(0, range.endLine)) : lines;
  return { path: absolute, text: selected.join("\n"), sha256: hash(buffer), totalLines: lines.length };
}

export async function listFiles(path: string, recursive = false): Promise<Array<{ path: string; type: "file" | "directory" | "symlink" }>> {
  const root = normalizeUserPath(path); const output: Array<{ path: string; type: "file" | "directory" | "symlink" }> = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (output.length >= 5000) return;
      if (recursive && [".git", "node_modules", "dist", "build", "coverage", ".next"].includes(entry.name)) continue;
      const full = resolve(dir, entry.name); const type = entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "file";
      output.push({ path: full, type });
      if (recursive && type === "directory") await walk(full);
    }
  }
  await walk(root); return output;
}

export async function searchFiles(rootPath: string, query: string, options: { maxFiles?: number; maxMatches?: number; caseSensitive?: boolean } = {}): Promise<Array<{ path: string; line: number; text: string }>> {
  const root = normalizeUserPath(rootPath); const maxFiles = options.maxFiles ?? 2000; const maxMatches = options.maxMatches ?? 200;
  const entries = await listFiles(root, true); const files = entries.filter((entry) => entry.type === "file").slice(0, maxFiles); const matches: Array<{ path: string; line: number; text: string }> = [];
  for (const file of files) {
    if (matches.length >= maxMatches) break;
    try {
      const content = await readFile(file.path, "utf8"); if (content.includes("\0")) continue;
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
        const line = lines[i]!; const haystack = options.caseSensitive ? line : line.toLowerCase(); const needle = options.caseSensitive ? query : query.toLowerCase();
        if (haystack.includes(needle)) matches.push({ path: file.path, line: i + 1, text: line.slice(0, 500) });
      }
    } catch { /* unreadable files are skipped */ }
  }
  return matches;
}

export async function createText(path: string, content: string, overwrite = false): Promise<string> {
  const absolute = normalizeUserPath(path); await mkdir(dirname(absolute), { recursive: true });
  if (!overwrite) { const exists = await lstat(absolute).then(() => true, () => false); if (exists) throw new Error(`File already exists: ${absolute}`); }
  const temp = `${absolute}.${randomUUID()}.tmp`; await writeFile(temp, content, { flag: "wx" });
  try { if (overwrite) await rename(temp, absolute); else { await link(temp, absolute); await unlink(temp); } }
  catch (error) { await rm(temp, { force: true }); throw error; }
  return absolute;
}

export async function patchText(path: string, expectedSha256: string, oldText: string, newText: string): Promise<{ path: string; sha256: string }> {
  const absolute = normalizeUserPath(path);
  return withPathLock(absolute, async () => {
    const release = await acquireFileLock(absolute, {
      stale: 15_000,
      update: 5_000,
      retries: { retries: 50, factor: 1.2, minTimeout: 50, maxTimeout: 500, randomize: true }
    });
    try {
      const original = await readFile(absolute); if (hash(original) !== expectedSha256) throw new Error("File changed since it was read; reload it before patching");
      const decoded = decodeText(original); const normalized = normalizeLineEndings(decoded.text); const source = normalizeLineEndings(oldText).text;
      const first = normalized.text.indexOf(source);
      if (first < 0) throw new Error("Patch source text was not found");
      if (normalized.text.indexOf(source, first + source.length) >= 0) throw new Error("Patch source text is ambiguous; include more context");
      const rawStart = normalized.rawOffsets[first]!; const rawEnd = normalized.rawOffsets[first + source.length]!;
      const neighborhood = decoded.text.slice(Math.max(0, rawStart - 256), Math.min(decoded.text.length, rawEnd + 256));
      const newline = neighborhood.includes("\r\n") ? "\r\n" : neighborhood.includes("\n") ? "\n" : "\n";
      const replacement = normalizeLineEndings(newText).text.replace(/\n/g, newline);
      const updatedText = decoded.text.slice(0, rawStart) + replacement + decoded.text.slice(rawEnd); const updated = decoded.encode(updatedText); const temp = `${absolute}.${randomUUID()}.tmp`;
      try { await writeFile(temp, updated, { flag: "wx" }); await rename(temp, absolute); }
      catch (error) { await rm(temp, { force: true }); throw error; }
      return { path: absolute, sha256: hash(updated) };
    } finally { await release(); }
  });
}

export async function movePath(from: string, to: string): Promise<string> { const source = normalizeUserPath(from); const target = normalizeUserPath(to); await mkdir(dirname(target), { recursive: true }); await rename(source, target); return target; }
export async function deletePath(path: string): Promise<void> { await rm(normalizeUserPath(path), { recursive: true, force: false }); }
export function relativePath(root: string, path: string): string { return relative(resolve(root), resolve(path)); }
