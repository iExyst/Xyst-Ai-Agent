import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { isPathInside } from '../platform/paths.mjs';

const MAX_GITIGNORE_LINES = 10_000;

/** Read a small workspace policy file without following file links or trusting a size check across races. */
export async function readWorkspaceRuleFile(root, filePath, { filesystem = fs, maxBytes } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive safe integer');
  const realRoot = await filesystem.realpath(root);
  let initial;
  try {
    initial = await filesystem.lstat(filePath, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!initial.isFile() || initial.isSymbolicLink())
    throw Object.assign(new Error('Retrieval rule file must be a regular file'), { code: 'INVALID_RETRIEVAL_RULE_FILE' });
  if (initial.size > BigInt(maxBytes))
    throw Object.assign(new Error(`Retrieval rule file exceeds ${maxBytes} bytes`), { code: 'RETRIEVAL_RULE_FILE_LIMIT' });
  if (!isPathInside(realRoot, await filesystem.realpath(filePath)))
    throw Object.assign(new Error('Retrieval rule file is outside the workspace'), { code: 'INVALID_RETRIEVAL_RULE_FILE' });

  let handle;
  try {
    handle = await filesystem.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await handle.stat({ bigint: true });
    if (!sameFileSnapshot(initial, opened) || !opened.isFile())
      throw Object.assign(new Error('Retrieval rule file changed while opening'), { code: 'RETRIEVAL_RULE_FILE_CHANGED' });
    const chunks = [];
    let length = 0;
    while (length <= maxBytes) {
      const buffer = Buffer.alloc(Math.min(16 * 1024, maxBytes + 1 - length));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, length);
      if (!bytesRead) break;
      length += bytesRead;
      if (length > maxBytes)
        throw Object.assign(new Error(`Retrieval rule file exceeds ${maxBytes} bytes`), { code: 'RETRIEVAL_RULE_FILE_LIMIT' });
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const afterRead = await handle.stat({ bigint: true });
    const currentPath = await filesystem.lstat(filePath, { bigint: true });
    const currentRealPath = await filesystem.realpath(filePath);
    if (
      !sameFileSnapshot(opened, afterRead) ||
      !sameFileSnapshot(opened, currentPath) ||
      !currentPath.isFile() ||
      currentPath.isSymbolicLink() ||
      !isPathInside(realRoot, currentRealPath)
    )
      throw Object.assign(new Error('Retrieval rule file changed while reading'), { code: 'RETRIEVAL_RULE_FILE_CHANGED' });
    return Buffer.concat(chunks, length).toString('utf8');
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function assertGitignoreLineLimit(source) {
  let lines = 1;
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) !== 10) continue;
    lines += 1;
    if (lines > MAX_GITIGNORE_LINES)
      throw Object.assign(new Error(`Workspace ignore file exceeds ${MAX_GITIGNORE_LINES} lines`), { code: 'RETRIEVAL_RULE_COUNT_LIMIT' });
  }
}

function sameFileSnapshot(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs;
}
