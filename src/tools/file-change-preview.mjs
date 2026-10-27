import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { displayPath, resolveToolPath } from '../platform/paths.mjs';
import { isSensitiveResolvedPath } from '../platform/redaction.mjs';

const DEFAULT_PREVIEW_BYTES = 1_000_000;
const MAX_DIFF_BYTES = 100_000;
const MAX_LCS_CELLS = 1_500_000;
const MAX_REVIEW_HUNKS = 100;

/** Capture the exact file state and text diff shown for an approved write. */
export async function prepareFileChange(root, toolName, args, config = {}) {
  const target = await resolveToolPath(root, args.path, { machineScope: usesMachineScope(config) });
  if (!usesUnrestricted(config) && (await isSensitiveResolvedPath(root, target))) {
    return {
      snapshot: null,
      preview: {
        path: args.path,
        operation: 'update',
        old_bytes: null,
        new_bytes: null,
        diff: null,
        selection_available: false,
        hunks: [],
        unavailable_reason: 'This target is blocked by the secret-safety policy.',
      },
    };
  }
  const state = await readState(target, {
    includeText: true,
    maxBytes: usesUnrestricted(config) ? Number.MAX_SAFE_INTEGER : config.tools?.max_file_bytes || DEFAULT_PREVIEW_BYTES,
  });
  const snapshot = { target, exists: state.exists, sha256: state.sha256 };
  let preview;
  try {
    if (state.exists && !state.textAvailable) throw new Error(state.unavailableReason || 'Existing file cannot be previewed as text.');
    const before = state.text ?? '';
    let after;
    if (toolName === 'write_file') after = args.content;
    else {
      if (!state.exists) throw new Error('The target file does not exist.');
      if (!args.old_string) throw new Error('The requested old text is empty.');
      const first = before.indexOf(args.old_string);
      if (first < 0) throw new Error('The requested old text was not found.');
      if (before.indexOf(args.old_string, first + args.old_string.length) >= 0)
        throw new Error('The requested old text matches more than one location.');
      after = before.slice(0, first) + args.new_string + before.slice(first + args.old_string.length);
    }
    const maxWriteBytes = config.tools?.max_write_bytes || DEFAULT_PREVIEW_BYTES;
    if (!usesUnrestricted(config) && Buffer.byteLength(after) > maxWriteBytes)
      throw new Error(`Proposed content exceeds the configured write limit of ${maxWriteBytes} bytes.`);
    const relative = path.relative(await fs.realpath(root), target);
    const display =
      relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? target : displayPath(root, target);
    const changes = createUnifiedDiff(display, before, after);
    const totalDiffBytes = Buffer.byteLength(changes.diff) + changes.hunks.reduce((sum, hunk) => sum + Buffer.byteLength(hunk.diff), 0);
    const selectionAvailable = changes.hunks.length > 0 && changes.hunks.length <= MAX_REVIEW_HUNKS && totalDiffBytes <= MAX_DIFF_BYTES;
    preview = {
      path: display,
      operation: state.exists ? 'update' : 'create',
      old_bytes: state.size,
      new_bytes: Buffer.byteLength(after),
      diff: boundDiff(changes.diff),
      truncated: Buffer.byteLength(changes.diff) > MAX_DIFF_BYTES,
      selection_available: selectionAvailable,
      hunks: selectionAvailable
        ? changes.hunks.map(({ id, old_start, old_count, new_start, new_count, diff }) => ({
            id,
            old_start,
            old_count,
            new_start,
            new_count,
            diff,
          }))
        : [],
    };
    return { snapshot, preview, proposedText: after, operations: changes.operations, hunks: changes.hunks };
  } catch (error) {
    preview = {
      path: args.path,
      operation: state.exists ? 'update' : 'create',
      old_bytes: state.size,
      new_bytes: toolName === 'write_file' ? Buffer.byteLength(args.content) : null,
      diff: null,
      selection_available: false,
      hunks: [],
      unavailable_reason: error.message,
    };
  }
  return { snapshot, preview };
}

/** Apply only selected review hunks, retaining all rejected source ranges. */
export function applyFileChangeHunks(fileChange, acceptedHunks) {
  if (!fileChange?.preview?.selection_available || !Array.isArray(fileChange.hunks))
    throw new Error('This file change does not support hunk selection.');
  if (!Array.isArray(acceptedHunks) || acceptedHunks.length === 0 || new Set(acceptedHunks).size !== acceptedHunks.length)
    throw new Error('Select at least one unique file-change hunk.');
  const known = new Set(fileChange.hunks.map((hunk) => hunk.id));
  if (acceptedHunks.some((id) => typeof id !== 'string' || !known.has(id)))
    throw new Error('The selected file-change hunks do not match this proposal.');
  const selected = new Set(acceptedHunks);
  const output = [];
  let hunkIndex = 0;
  for (let index = 0; index < fileChange.operations.length; index += 1) {
    while (hunkIndex < fileChange.hunks.length && index > fileChange.hunks[hunkIndex].end) hunkIndex += 1;
    const hunk = fileChange.hunks[hunkIndex];
    const inHunk = hunk && index >= hunk.start && index <= hunk.end;
    const useProposed = !inHunk || selected.has(hunk.id);
    const operation = fileChange.operations[index];
    if ((useProposed && operation.type !== '-') || (!useProposed && operation.type !== '+')) output.push(operation.value);
  }
  return output.map(({ text, ending }) => text + ending).join('');
}

/** Reject an approved write if the target changed while its preview was open. */
export async function assertFileChangeUnchanged(root, args, config, snapshot) {
  if (!snapshot) return;
  const target = await resolveToolPath(root, args.path, { machineScope: usesMachineScope(config) });
  if (!samePath(target, snapshot.target)) throw staleFileError();
  const current = await readState(target);
  if (current.exists !== snapshot.exists || current.sha256 !== snapshot.sha256) throw staleFileError();
}

async function readState(target, { includeText = false, maxBytes = 0 } = {}) {
  let handle;
  try {
    handle = await fs.open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, sha256: null, size: 0, text: '', textAvailable: true };
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('The file-change target is not a regular file.');
    const [resolvedPath, currentStat] = await Promise.all([fs.realpath(target), fs.stat(target)]);
    if (!samePath(resolvedPath, target) || stat.dev !== currentStat.dev || stat.ino !== currentStat.ino)
      throw new Error('The file-change target changed while it was being opened.');

    const digest = createHash('sha256');
    let size = 0;
    let captureText = includeText && stat.size <= maxBytes;
    let chunks = [];
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.byteLength;
      digest.update(chunk);
      if (captureText && size <= maxBytes) chunks.push(chunk);
      else if (captureText) {
        captureText = false;
        chunks = [];
      }
    }
    const sha256 = digest.digest('hex');
    if (!includeText) return { exists: true, sha256, size };
    if (!captureText)
      return {
        exists: true,
        sha256,
        size,
        textAvailable: false,
        unavailableReason: 'Existing file is too large to preview safely.',
      };
    const bytes = Buffer.concat(chunks);
    if (bytes.includes(0))
      return {
        exists: true,
        sha256,
        size,
        textAvailable: false,
        unavailableReason: 'Existing file contains binary data and cannot be previewed as text.',
      };
    try {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      return { exists: true, sha256, size, text, textAvailable: true };
    } catch {
      return {
        exists: true,
        sha256,
        size,
        textAvailable: false,
        unavailableReason: 'Existing file is not valid UTF-8 text and cannot be previewed.',
      };
    }
  } finally {
    await handle.close();
  }
}

function createUnifiedDiff(filePath, before, after) {
  if (before === after) return { diff: `--- a/${filePath}\n+++ b/${filePath}\n(no content changes)`, operations: [], hunks: [] };
  const left = splitLines(before);
  const right = splitLines(after);
  const cells = (left.length + 1) * (right.length + 1);
  let operations;
  if (cells <= MAX_LCS_CELLS) operations = lcsOperations(left, right);
  else operations = prefixSuffixOperations(left, right);
  const hunks = makeHunks(filePath, operations);
  const oldStart = left.length ? 1 : 0;
  const newStart = right.length ? 1 : 0;
  const allRows = renderOperations(operations);
  return {
    diff: `--- a/${filePath}\n+++ b/${filePath}\n@@ -${oldStart},${left.length} +${newStart},${right.length} @@\n${allRows.join('\n')}`,
    operations,
    hunks,
  };
}

function makeHunks(filePath, operations) {
  if (!operations.some((operation) => operation.type !== ' ')) return [];
  const changed = [];
  for (let index = 0; index < operations.length; index += 1) if (operations[index].type !== ' ') changed.push(index);
  const ranges = [];
  for (const index of changed) {
    const start = Math.max(0, index - 3);
    const end = Math.min(operations.length - 1, index + 3);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end + 1) previous.end = end;
    else ranges.push({ start, end });
  }
  return ranges.map(({ start, end }, index) => {
    const chunk = operations.slice(start, end + 1);
    const oldCount = chunk.filter((operation) => operation.type !== '+').length;
    const newCount = chunk.filter((operation) => operation.type !== '-').length;
    const oldBefore = operations.slice(0, start).filter((operation) => operation.type !== '+').length;
    const newBefore = operations.slice(0, start).filter((operation) => operation.type !== '-').length;
    const oldStart = oldCount ? oldBefore + 1 : oldBefore;
    const newStart = newCount ? newBefore + 1 : newBefore;
    const rows = renderOperations(chunk);
    const id = `hunk-${index + 1}`;
    const range = { id, start, end, old_start: oldStart, old_count: oldCount, new_start: newStart, new_count: newCount };
    range.diff = `--- a/${filePath}\n+++ b/${filePath}\n@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${rows.join('\n')}`;
    return range;
  });
}

function renderOperations(operations) {
  const rows = [];
  for (const { type, value } of operations) {
    rows.push(`${type}${value.text}`);
    if (!value.terminated) rows.push('\\ No newline at end of file');
  }
  return rows;
}

function lcsOperations(left, right) {
  const width = right.length + 1;
  const table = new Uint32Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      const index = i * width + j;
      table[index] = sameLine(left[i], right[j])
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const operations = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (sameLine(left[i], right[j])) {
      operations.push({ type: ' ', value: left[i] });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      operations.push({ type: '-', value: left[i++] });
    } else operations.push({ type: '+', value: right[j++] });
  }
  while (i < left.length) operations.push({ type: '-', value: left[i++] });
  while (j < right.length) operations.push({ type: '+', value: right[j++] });
  return operations;
}

function prefixSuffixOperations(left, right) {
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && sameLine(left[prefix], right[prefix])) prefix += 1;
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    sameLine(left[left.length - 1 - suffix], right[right.length - 1 - suffix])
  )
    suffix += 1;
  return [
    ...left.slice(0, prefix).map((value) => ({ type: ' ', value })),
    ...left.slice(prefix, left.length - suffix).map((value) => ({ type: '-', value })),
    ...right.slice(prefix, right.length - suffix).map((value) => ({ type: '+', value })),
    ...left.slice(left.length - suffix).map((value) => ({ type: ' ', value })),
  ];
}

function splitLines(text) {
  const lines = [];
  const newline = /\r\n|\n|\r/g;
  let start = 0;
  let match;
  while ((match = newline.exec(text))) {
    lines.push({ text: text.slice(start, match.index), ending: match[0], terminated: true });
    start = newline.lastIndex;
  }
  if (start < text.length) lines.push({ text: text.slice(start), ending: '', terminated: false });
  return lines;
}

function sameLine(left, right) {
  return left.text === right.text && left.ending === right.ending;
}

function boundDiff(diff) {
  if (Buffer.byteLength(diff) <= MAX_DIFF_BYTES) return diff;
  const marker = '\n… diff truncated …';
  const contentLimit = MAX_DIFF_BYTES - Buffer.byteLength(marker);
  let output = '';
  let bytes = 0;
  for (const character of diff) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > contentLimit) break;
    output += character;
    bytes += characterBytes;
  }
  return output + marker;
}

function usesMachineScope(config) {
  return config.tools?.autonomy === 'unrestricted' || config.tools?.filesystem_scope === 'machine';
}
function usesUnrestricted(config) {
  return config.tools?.autonomy === 'unrestricted';
}
function samePath(left, right) {
  return process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}
function staleFileError() {
  return Object.assign(
    new Error('File changed after its proposed diff was prepared; no changes were applied. Re-read the file and prepare a fresh edit.'),
    { code: 'STALE_FILE' },
  );
}
