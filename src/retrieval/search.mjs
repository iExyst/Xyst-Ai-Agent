import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { isSensitivePath, redactSecrets } from '../platform/redaction.mjs';
import { isPathInside } from '../platform/paths.mjs';
import { assertGitignoreLineLimit, readWorkspaceRuleFile } from './rule-files.mjs';

const DEFAULT_IGNORES = new Set(['.git', '.agent', 'node_modules', 'dist', 'coverage', '.next', 'target']);
const MAX_SCAN_BYTES = 64 * 1024 * 1024;

export async function searchWorkspace(
  root,
  query,
  {
    maxResults = 25,
    maxFiles = 3000,
    maxFileBytes = 500_000,
    pathGlob,
    includeSensitive = false,
    redactOutput = true,
    includeIgnored = false,
    absolutePaths = false,
    maxScanBytes = MAX_SCAN_BYTES,
    filesystem = fs,
  } = {},
) {
  if (typeof query !== 'string' || !query.trim()) throw new TypeError('query must not be empty');
  for (const [name, value] of Object.entries({ maxResults, maxFiles, maxFileBytes, maxScanBytes }))
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  if (maxResults > 100) throw new TypeError('maxResults cannot exceed 100');
  if (maxFiles > 10_000) throw new TypeError('maxFiles cannot exceed 10000');
  if (maxFileBytes > 1_000_000) throw new TypeError('maxFileBytes cannot exceed 1000000');
  if (maxScanBytes > MAX_SCAN_BYTES) throw new TypeError(`maxScanBytes cannot exceed ${MAX_SCAN_BYTES}`);
  const matches = [];
  const realRoot = await filesystem.realpath(root);
  const queue = [realRoot];
  const expression = pathGlob ? globToRegExp(pathGlob) : null;
  const needle = query.toLocaleLowerCase();
  let filesScanned = 0;
  let bytesScanned = 0;
  let truncated = false;
  const ignoreRules = [];
  {
    const gitignore = await readWorkspaceRuleFile(root, path.join(root, '.gitignore'), { filesystem, maxBytes: 1024 * 1024 });
    if (gitignore !== null) {
      assertGitignoreLineLimit(gitignore);
      for (const original of gitignore.split(/\r?\n/)) {
        let line = original.trim();
        if (!line || line.startsWith('#')) continue;
        const negated = line.startsWith('!');
        if (negated) line = line.slice(1);
        if (!line) continue;
        const directoryOnly = line.endsWith('/');
        line = line.replace(/^\//, '').replace(/\/$/, '');
        const hasSlash = line.includes('/');
        const expression = globToRegExp(line, { basename: !hasSlash, directoryOnly });
        ignoreRules.push({ negated, expression });
      }
    }
  }

  while (queue.length && filesScanned < maxFiles && matches.length < maxResults) {
    const directory = queue.shift();
    let entries;
    try {
      const before = await filesystem.lstat(directory, { bigint: true });
      const realBefore = await filesystem.realpath(directory);
      if (!before.isDirectory() || before.isSymbolicLink() || !isPathInside(realRoot, realBefore)) continue;
      entries = await filesystem.readdir(directory, { withFileTypes: true });
      const after = await filesystem.lstat(directory, { bigint: true });
      const realAfter = await filesystem.realpath(directory);
      if (!sameFileSnapshot(before, after) || !after.isDirectory() || after.isSymbolicLink() || !isPathInside(realRoot, realAfter))
        continue;
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
      if (filesScanned >= maxFiles) {
        truncated = entryIndex < entries.length || queue.length > 0;
        break;
      }
      const entry = entries[entryIndex];
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(realRoot, absolute).replaceAll('\\', '/');
      const isDirectory = entry.isDirectory();
      if (!includeSensitive && (isSensitivePath(relative) || isSensitivePath(absolute))) continue;
      if (!includeIgnored && (isDefaultIgnored(relative) || matchesIgnoreRules(relative, isDirectory, ignoreRules))) continue;
      if (isDirectory) {
        try {
          const directoryStat = await filesystem.lstat(absolute, { bigint: true });
          const realDirectory = await filesystem.realpath(absolute);
          if (directoryStat.isDirectory() && !directoryStat.isSymbolicLink() && isPathInside(realRoot, realDirectory)) queue.push(absolute);
        } catch {
          continue;
        }
        continue;
      }
      if (!entry.isFile() || (expression && !expression.test(relative))) continue;
      filesScanned += 1;
      let content;
      let modifiedAt;
      let handle;
      try {
        const stat = await filesystem.lstat(absolute, { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BigInt(maxFileBytes)) continue;
        const realFile = await filesystem.realpath(absolute);
        if (!isPathInside(realRoot, realFile)) continue;
        if (stat.size > BigInt(maxScanBytes - bytesScanned)) {
          truncated = true;
          break;
        }
        handle = await filesystem.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const opened = await handle.stat({ bigint: true });
        if (!sameFileSnapshot(stat, opened) || !opened.isFile()) continue;
        const bytes = await readBoundedFile(handle, Math.min(maxFileBytes, maxScanBytes - bytesScanned));
        if (bytes === null) {
          truncated = true;
          break;
        }
        bytesScanned += bytes.length;
        const afterRead = await handle.stat({ bigint: true });
        const pathAfterRead = await filesystem.lstat(absolute, { bigint: true });
        const currentRealFile = await filesystem.realpath(absolute);
        if (
          !sameFileSnapshot(opened, afterRead) ||
          !sameFileSnapshot(opened, pathAfterRead) ||
          !pathAfterRead.isFile() ||
          pathAfterRead.isSymbolicLink() ||
          !isPathInside(realRoot, currentRealFile)
        )
          continue;
        content = bytes.toString('utf8');
        modifiedAt = stat.mtime.toISOString();
      } catch {
        continue;
      } finally {
        await handle?.close().catch(() => {});
      }
      if (content.includes('\u0000')) continue;
      matches.push(
        ...findDocumentMatches({ path: relative, content, modified_at: modifiedAt }, needle, {
          maxResults: maxResults - matches.length,
          redactOutput,
          outputPath: absolutePaths ? absolute : relative,
        }),
      );
      if (matches.length >= maxResults) break;
      if (filesScanned >= maxFiles) {
        truncated = entryIndex < entries.length - 1 || queue.length > 0;
        break;
      }
    }
  }
  return {
    query,
    matches,
    files_scanned: filesScanned,
    bytes_scanned: bytesScanned,
    truncated: truncated || queue.length > 0 || matches.length >= maxResults,
  };
}

function sameFileSnapshot(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

/** Search already-scanned, policy-filtered documents without reopening files. */
export function searchWorkspaceDocuments(documents, query, { maxResults = 25, pathGlob, redactOutput = true } = {}) {
  if (!Array.isArray(documents)) throw new TypeError('documents must be an array');
  if (typeof query !== 'string' || !query.trim()) throw new TypeError('query must not be empty');
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 100) throw new TypeError('maxResults must be between 1 and 100');
  if (documents.some((document) => !document || typeof document.path !== 'string' || typeof document.content !== 'string'))
    throw new TypeError('documents must contain workspace paths and text content');
  const expression = pathGlob ? globToRegExp(pathGlob) : null;
  const needle = query.toLocaleLowerCase();
  const matches = [];
  let truncated = false;
  for (const document of documents) {
    if (expression && !expression.test(document.path)) continue;
    matches.push(
      ...findDocumentMatches(document, needle, {
        maxResults: maxResults - matches.length,
        redactOutput,
        outputPath: document.path,
      }),
    );
    if (matches.length >= maxResults) {
      truncated = true;
      break;
    }
  }
  return { matches, truncated };
}

function findDocumentMatches(document, needle, { maxResults, redactOutput, outputPath }) {
  const matches = [];
  const lines = document.content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].toLocaleLowerCase().includes(needle)) continue;
    matches.push({
      path: outputPath,
      line: index + 1,
      source: 'workspace_file',
      modified_at: document.modified_at,
      text: redactOutput ? redactSecrets(lines[index].slice(0, 1000)) : lines[index].slice(0, 1000),
    });
    if (matches.length >= maxResults) break;
  }
  return matches;
}

async function readBoundedFile(handle, maxBytes) {
  const chunks = [];
  let bytesRead = 0;
  while (bytesRead <= maxBytes) {
    const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - bytesRead));
    const { bytesRead: count } = await handle.read(buffer, 0, buffer.length, bytesRead);
    if (!count) break;
    bytesRead += count;
    if (bytesRead > maxBytes) return null;
    chunks.push(buffer.subarray(0, count));
  }
  return Buffer.concat(chunks, bytesRead);
}

function isDefaultIgnored(relative) {
  return relative.split('/').some((part) => DEFAULT_IGNORES.has(part));
}

function matchesIgnoreRules(relative, isDirectory, rules) {
  let ignored = false;
  for (const rule of rules) {
    if (rule.expression.test(relative) || (isDirectory && rule.expression.test(`${relative}/`))) ignored = !rule.negated;
  }
  return ignored;
}

function globToRegExp(glob, { basename = false, directoryOnly = false } = {}) {
  let expression = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') {
      index += 1;
      if (glob[index + 1] === '/') {
        index += 1;
        expression += '(?:.*/)?';
      } else expression += '.*';
    } else if (char === '*') expression += '[^/]*';
    else if (char === '?') expression += '[^/]';
    else expression += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
  }
  const prefix = basename ? '(?:^|.*/)' : '^';
  const suffix = directoryOnly ? '(?:/.*)?$' : '$';
  return new RegExp(`${prefix}${expression}${suffix}`, 'i');
}
