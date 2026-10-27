import fs from 'node:fs/promises';
import path from 'node:path';

export function isPathInside(root, candidate, flavor = process.platform === 'win32' ? 'win32' : 'posix') {
  const api = flavor === 'win32' ? path.win32 : path.posix;
  const normalizedRoot = flavor === 'win32' ? normalizeExtendedWindowsPath(root) : root;
  const normalizedCandidate = flavor === 'win32' ? normalizeExtendedWindowsPath(candidate) : candidate;
  const relative = api.relative(api.resolve(normalizedRoot), api.resolve(normalizedCandidate));
  if (relative === '') return true;
  if (api.isAbsolute(relative)) return false;
  const first = relative.split(/[\\/]/, 1)[0];
  if (first === '..') return false;
  return flavor === 'win32' || !relative.startsWith('../');
}

function normalizeExtendedWindowsPath(value) {
  if (/^\\\\\?\\UNC\\/i.test(value)) return `\\\\${value.slice(8)}`;
  if (/^\\\\\?\\[A-Za-z]:\\/.test(value)) return value.slice(4);
  return value;
}

/** Resolve a user path inside a workspace and reject symlink escapes.
 * Existing files use their final realpath; new files validate their nearest
 * existing ancestor so a symlinked parent cannot escape the workspace.
 */
export async function resolveWorkspacePath(workspaceRoot, requestedPath, { mustExist = false } = {}) {
  const root = await fs.realpath(workspaceRoot);
  const candidate = path.isAbsolute(requestedPath) ? path.resolve(requestedPath) : path.resolve(root, requestedPath);
  if (!isPathInside(root, candidate)) throw new Error(`Path escapes workspace: ${requestedPath}`);

  let existing = candidate;
  const suffix = [];
  while (true) {
    try {
      const realExisting = await fs.realpath(existing);
      const finalPath = path.join(realExisting, ...suffix);
      if (!isPathInside(root, realExisting) || !isPathInside(root, finalPath))
        throw new Error(`Path escapes workspace through a symbolic link: ${requestedPath}`);
      if (mustExist && suffix.length) throw Object.assign(new Error(`Path does not exist: ${requestedPath}`), { code: 'ENOENT' });
      return finalPath;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      if (mustExist && error.code === 'ENOENT' && error.message.startsWith('Path does not exist:')) throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      suffix.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/** Resolve a file-tool target. Machine scope accepts absolute paths anywhere
 * on the machine and follows symlinks to their final target; relative paths
 * remain anchored to the selected workspace.
 */
export async function resolveToolPath(workspaceRoot, requestedPath, { mustExist = false, machineScope = false } = {}) {
  if (!machineScope && (requestedPath === '/workspace' || requestedPath.startsWith('/workspace/'))) {
    const workspaceRelativePath = requestedPath.slice('/workspace'.length).replace(/^\/+/, '') || '.';
    return resolveWorkspacePath(workspaceRoot, workspaceRelativePath, { mustExist });
  }
  if (!machineScope || !path.isAbsolute(requestedPath)) return resolveWorkspacePath(workspaceRoot, requestedPath, { mustExist });
  const candidate = path.resolve(requestedPath);
  return resolveUnrestricted(candidate, requestedPath, { mustExist });
}

async function resolveUnrestricted(candidate, requestedPath, { mustExist = false } = {}) {
  let existing = candidate;
  const suffix = [];
  while (true) {
    try {
      const realExisting = await fs.realpath(existing);
      const finalPath = path.join(realExisting, ...suffix);
      if (mustExist && suffix.length) throw Object.assign(new Error(`Path does not exist: ${requestedPath}`), { code: 'ENOENT' });
      return finalPath;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      if (mustExist && error.code === 'ENOENT' && error.message.startsWith('Path does not exist:')) throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      suffix.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

export function displayPath(workspaceRoot, filePath, flavor = process.platform === 'win32' ? 'win32' : 'posix') {
  const api = flavor === 'win32' ? path.win32 : path.posix;
  const root = flavor === 'win32' ? normalizeExtendedWindowsPath(workspaceRoot) : workspaceRoot;
  const target = flavor === 'win32' ? normalizeExtendedWindowsPath(filePath) : filePath;
  const relative = api.relative(root, target);
  return relative || '.';
}
