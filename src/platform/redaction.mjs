import fs from 'node:fs/promises';
import path from 'node:path';
import { isSensitivePath } from '../core/redaction.mjs';

export {
  containsSensitiveMaterial,
  isSecretFieldName,
  isSensitivePath,
  redactSecrets,
  redactStructuredSecrets,
} from '../core/redaction.mjs';

/** Check a resolved target without treating a protected workspace parent as part of each child path. */
export async function isSensitiveResolvedPath(workspaceRoot, resolvedPath) {
  const root = await fs.realpath(workspaceRoot);
  const relative = path.relative(root, resolvedPath);
  const insideRoot = relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  return isSensitivePath(insideRoot ? relative : resolvedPath);
}
