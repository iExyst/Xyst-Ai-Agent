import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveWorkspacePath, isPathInside } from '../platform/paths.mjs';
import { redactSecrets } from '../platform/redaction.mjs';

const MAX_INSTRUCTION_FILES = 32;
const MAX_INSTRUCTION_FILE_BYTES = 8 * 1024;
const MAX_TOTAL_INSTRUCTION_BYTES = 32 * 1024;

/** Load root and path-scoped AGENTS.md files as bounded, untrusted project guidance. */
export async function loadProjectInstructions(workspaceRoot, targets = []) {
  const root = await fs.realpath(workspaceRoot);
  const directories = new Set(['']);
  for (const target of targets) {
    if (typeof target !== 'string' || !target) continue;
    const resolved = await resolveWorkspacePath(root, target);
    let relative = path.relative(root, resolved);
    let isDirectory = false;
    try {
      isDirectory = (await fs.stat(resolved)).isDirectory();
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    if (!isDirectory) relative = path.dirname(relative);
    while (relative && relative !== '.') {
      directories.add(relative.split(path.sep).join('/'));
      relative = path.posix.dirname(relative.split(path.sep).join('/'));
    }
  }

  const result = [];
  let totalBytes = 0;
  for (const directory of [...directories].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))) {
    const relativePath = [directory, 'AGENTS.md'].filter(Boolean).join('/');
    if (directory.split('/').some((part) => ['.agent', '.git', 'node_modules'].includes(part))) continue;
    const fullPath = path.join(root, ...relativePath.split('/'));
    let info;
    try {
      info = await fs.lstat(fullPath);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) continue;
    if (
      info.size > MAX_INSTRUCTION_FILE_BYTES ||
      totalBytes + info.size > MAX_TOTAL_INSTRUCTION_BYTES ||
      result.length >= MAX_INSTRUCTION_FILES
    )
      continue;
    const realPath = await fs.realpath(fullPath);
    if (!isPathInside(root, realPath)) continue;
    const content = redactSecrets((await fs.readFile(realPath, 'utf8')).replace(/^\uFEFF/, ''));
    totalBytes += Buffer.byteLength(content, 'utf8');
    result.push({ path: relativePath, content });
  }
  return result;
}

function depth(value) {
  return value ? value.split('/').length : 0;
}
