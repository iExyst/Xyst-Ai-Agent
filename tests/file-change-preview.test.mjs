import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyFileChangeHunks, prepareFileChange, assertFileChangeUnchanged } from '../src/tools/file-change-preview.mjs';
import { createSymlinkOrSkip } from './helpers.mjs';

async function tempDirectory() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'xyst-file-preview-'));
}

test('file change preview renders an exact line diff for an edit', async (t) => {
  const root = await tempDirectory();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'notes.txt'), 'keep\nold value\nfinish\n');

  const change = await prepareFileChange(root, 'edit_file', {
    path: 'notes.txt',
    old_string: 'old value',
    new_string: 'new value',
  });

  assert.equal(change.preview.path, 'notes.txt');
  assert.equal(change.preview.operation, 'update');
  assert.match(change.preview.diff, /^--- a\/notes\.txt\n\+\+\+ b\/notes\.txt/m);
  assert.match(change.preview.diff, /-old value/);
  assert.match(change.preview.diff, /\+new value/);
  assert.doesNotMatch(change.preview.diff, /\+old value/);
  await assertFileChangeUnchanged(root, { path: 'notes.txt' }, {}, change.snapshot);
});

test('file change guard detects contents changing after review', async (t) => {
  const root = await tempDirectory();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'notes.txt');
  await fs.writeFile(target, 'reviewed version\n');
  const change = await prepareFileChange(root, 'write_file', { path: 'notes.txt', content: 'replacement\n' });
  await fs.writeFile(target, 'changed by another process\n');

  await assert.rejects(
    assertFileChangeUnchanged(root, { path: 'notes.txt' }, {}, change.snapshot),
    (error) => error.code === 'STALE_FILE' && /no changes were applied/.test(error.message),
  );

  await fs.rm(target);
  const missing = await prepareFileChange(root, 'write_file', { path: 'notes.txt', content: 'proposed creation' });
  await fs.writeFile(target, 'created while review was open');
  await assert.rejects(assertFileChangeUnchanged(root, { path: 'notes.txt' }, {}, missing.snapshot), { code: 'STALE_FILE' });
});

test('file preview refuses a parent-directory swap to an outside link before reading contents', async (t) => {
  const root = await tempDirectory();
  const outside = await tempDirectory();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const parent = path.join(root, 'source');
  const movedParent = path.join(root, 'source-original');
  const outsideLink = path.join(root, 'source-outside-link');
  const target = path.join(parent, 'notes.txt');
  await fs.mkdir(parent);
  await fs.writeFile(target, 'workspace text');
  await fs.writeFile(path.join(outside, 'notes.txt'), 'outside secret marker');
  if (!(await createSymlinkOrSkip(t, outside, outsideLink))) return;

  const open = fs.open;
  let swapped = false;
  fs.open = async (requestedPath, ...options) => {
    if (!swapped && path.resolve(requestedPath) === target) {
      swapped = true;
      await fs.rename(parent, movedParent);
      await fs.rename(outsideLink, parent);
    }
    return open(requestedPath, ...options);
  };
  t.after(() => {
    fs.open = open;
  });

  await assert.rejects(
    prepareFileChange(root, 'write_file', { path: 'source/notes.txt', content: 'replacement' }),
    /changed while it was being opened/,
  );
  assert.equal(swapped, true);
  assert.equal(await fs.readFile(path.join(outside, 'notes.txt'), 'utf8'), 'outside secret marker');
});

test('file diff marks changes to a final newline instead of hiding them', async (t) => {
  const root = await tempDirectory();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'line.txt'), 'last line');

  const change = await prepareFileChange(root, 'write_file', { path: 'line.txt', content: 'last line\n' });

  assert.match(change.preview.diff, /-last line\n\\ No newline at end of file/);
  assert.match(change.preview.diff, /\+last line/);
});

test('file hunk selection applies accepted ranges and preserves every rejected source range', async (t) => {
  const root = await tempDirectory();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const original = `${Array.from({ length: 16 }, (_, index) => `line-${index + 1}`).join('\n')}\n`;
  const proposedLines = original.trimEnd().split('\n');
  proposedLines[1] = 'updated line 2';
  proposedLines[13] = 'updated line 14';
  const proposed = `${proposedLines.join('\n')}\n`;
  await fs.writeFile(path.join(root, 'ranges.txt'), original);

  const change = await prepareFileChange(root, 'write_file', { path: 'ranges.txt', content: proposed });

  assert.equal(change.preview.selection_available, true);
  assert.equal(change.preview.hunks.length, 2);
  assert.equal(
    applyFileChangeHunks(
      change,
      change.hunks.map((hunk) => hunk.id),
    ),
    proposed,
  );
  const partial = applyFileChangeHunks(change, [change.hunks[0].id]);
  const expected = original.replace('line-2', 'updated line 2');
  assert.equal(partial, expected);
  assert.throws(() => applyFileChangeHunks(change, ['hunk-999']), /do not match this proposal/);
});

test('file change preview represents a new file and reports non-text content clearly', async (t) => {
  const root = await tempDirectory();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const created = await prepareFileChange(root, 'write_file', { path: 'new.txt', content: 'created\n' });
  assert.equal(created.preview.operation, 'create');
  assert.match(created.preview.diff, /\+created/);
  await assertFileChangeUnchanged(root, { path: 'new.txt' }, {}, created.snapshot);

  await fs.writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 0xff, 0x00]));
  const binary = await prepareFileChange(root, 'write_file', { path: 'binary.bin', content: 'replacement' });
  assert.equal(binary.preview.diff, null);
  assert.match(binary.preview.unavailable_reason, /binary data|valid UTF-8/);
});

test('unrestricted file previews follow unrestricted file limits while keeping the diff bounded', async (t) => {
  const root = await tempDirectory();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'large.txt'), 'before\n');
  const proposed = `${'expanded content\n'.repeat(80_000)}tail\n`;

  const change = await prepareFileChange(
    root,
    'write_file',
    { path: 'large.txt', content: proposed },
    { tools: { autonomy: 'unrestricted', max_file_bytes: 2, max_write_bytes: 2 } },
  );

  assert.equal(change.proposedText, proposed);
  assert.equal(change.preview.new_bytes, Buffer.byteLength(proposed));
  assert.equal(change.preview.unavailable_reason, undefined);
  assert.equal(change.preview.truncated, true);
  assert.ok(Buffer.byteLength(change.preview.diff) <= 100_000);
});
