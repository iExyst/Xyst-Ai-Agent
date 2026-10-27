import fs from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from './process.mjs';
import { isPathInside, resolveWorkspacePath } from './paths.mjs';

const MAX_ENTRIES = 500;
const MAX_PATH_BYTES = 2048;
const MAX_PREVIEW_BYTES = 256 * 1024;

/** Return a bounded, symlink-free directory listing and Git status for a workspace. */
export async function inspectWorkspace(workspaceRoot, { relativePath = '', signal } = {}) {
  validateRelativePath(relativePath);
  const workspace = await fs.realpath(workspaceRoot);
  const target = relativePath ? await resolveWorkspacePath(workspace, relativePath, { mustExist: true }) : workspace;
  if (!isPathInside(workspace, target) && target !== workspace)
    throw Object.assign(new Error('Path is outside the selected workspace'), { code: 'INVALID_WORKSPACE_PATH' });
  const stats = await fs.stat(target);
  if (!stats.isDirectory()) throw Object.assign(new TypeError('path must identify a directory'), { code: 'NOT_A_DIRECTORY' });
  const entries = [];
  let childCount = 0;
  const directory = await fs.opendir(target);
  for await (const entry of directory) {
    if (entry.isSymbolicLink() || entry.name === '.git') continue;
    childCount += 1;
    if (entries.length < MAX_ENTRIES)
      entries.push({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' });
  }
  entries.sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name));
  let git = { available: false, branch: null, entries: [] };
  let result;
  try {
    result = await runProcess(
      'git',
      [
        '-c',
        'core.fsmonitor=false',
        '-C',
        target,
        'status',
        '--porcelain=v1',
        '-z',
        '--branch',
        '--no-renames',
        '--untracked-files=normal',
      ],
      { cwd: target, signal, timeoutMs: 10_000, maxOutputBytes: 64_000 },
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (result?.exitCode === 0) {
    const records = result.stdout.split('\0').filter(Boolean);
    const header = records.shift() || '';
    const branch = header.match(/^## (.+?)(?:\.\.\..*)?$/)?.[1] || null;
    const changes = records.map((record) => ({ code: record.slice(0, 2), path: record.slice(3) })).filter((entry) => entry.path);
    git = { available: true, branch, entries: changes.slice(0, MAX_ENTRIES), truncated: result.truncated || changes.length > MAX_ENTRIES };
  }
  const relative = path.relative(workspace, target).split(path.sep).join('/');
  return {
    path: relative,
    parent: relative ? relative.split('/').slice(0, -1).join('/') : null,
    entries,
    truncated: childCount > MAX_ENTRIES,
    git,
  };
}

/** Read a bounded UTF-8 file without following a symbolic link. */
export async function readWorkspaceFile(workspaceRoot, relativePath) {
  validateRelativePath(relativePath);
  if (!relativePath) throw Object.assign(new TypeError('path must identify a workspace file'), { code: 'INVALID_WORKSPACE_PATH' });
  const workspace = await fs.realpath(workspaceRoot);
  const segments = relativePath.split(/[\\/]/).filter(Boolean);
  let cursor = workspace;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    const info = await fs.lstat(cursor);
    if (info.isSymbolicLink()) throw Object.assign(new Error('Symbolic links cannot be previewed'), { code: 'SYMLINK_NOT_ALLOWED' });
  }
  const target = await resolveWorkspacePath(workspace, relativePath, { mustExist: true });
  if (!isPathInside(workspace, target))
    throw Object.assign(new Error('Path is outside the selected workspace'), { code: 'INVALID_WORKSPACE_PATH' });
  const info = await fs.stat(target);
  if (!info.isFile()) throw Object.assign(new TypeError('path must identify a regular file'), { code: 'NOT_A_FILE' });
  if (info.size > MAX_PREVIEW_BYTES)
    throw Object.assign(new Error(`File is larger than the ${MAX_PREVIEW_BYTES}-byte preview limit`), { code: 'FILE_TOO_LARGE' });
  const handle = await fs.open(target, 'r');
  let bytes;
  try {
    const [opened, realTarget] = await Promise.all([handle.stat(), fs.realpath(target)]);
    if (!isPathInside(workspace, realTarget) || realTarget !== target || opened.dev !== info.dev || opened.ino !== info.ino) {
      throw Object.assign(new Error('File changed while opening its preview'), { code: 'WORKSPACE_FILE_CHANGED' });
    }
    const buffer = Buffer.alloc(MAX_PREVIEW_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    bytes = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  if (bytes.length > MAX_PREVIEW_BYTES)
    throw Object.assign(new Error(`File is larger than the ${MAX_PREVIEW_BYTES}-byte preview limit`), { code: 'FILE_TOO_LARGE' });
  if (bytes.includes(0)) throw Object.assign(new Error('Binary files cannot be previewed as text'), { code: 'BINARY_FILE' });
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw Object.assign(new Error('File is not valid UTF-8 text'), { code: 'BINARY_FILE' });
  }
  return { path: path.relative(workspace, target).split(path.sep).join('/'), text, bytes: bytes.length };
}

function validateRelativePath(relativePath) {
  if (
    typeof relativePath !== 'string' ||
    Buffer.byteLength(relativePath) > MAX_PATH_BYTES ||
    path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).some((part) => part === '..')
  ) {
    throw Object.assign(new TypeError('path must be a relative workspace path without traversal'), { code: 'INVALID_WORKSPACE_PATH' });
  }
}
