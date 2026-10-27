import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { searchWorkspace } from '../src/retrieval/search.mjs';
import { createTempDirectory, createSymlinkOrSkip } from './helpers.mjs';

test('retrieval honors common gitignore patterns, path globs, and result caps', async (t) => {
  const root = await createTempDirectory('xyst-search-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'build'), { recursive: true });
  await fs.writeFile(path.join(root, '.gitignore'), 'build/\n*.secret\n!keep.secret\n');
  await fs.writeFile(path.join(root, 'src', 'a.js'), 'token = alpha\nsecond alpha\n');
  await fs.writeFile(path.join(root, 'build', 'generated.js'), 'alpha\n');
  await fs.writeFile(path.join(root, 'private.secret'), 'alpha\n');
  await fs.writeFile(path.join(root, 'keep.secret'), 'alpha\n');

  const all = await searchWorkspace(root, 'alpha');
  assert.deepEqual(
    all.matches.map((match) => match.path),
    ['keep.secret', 'src/a.js', 'src/a.js'],
  );
  assert.ok(
    all.matches.every((match) => match.source === 'workspace_file' && Number.isFinite(Date.parse(match.modified_at)) && match.line >= 1),
  );
  const js = await searchWorkspace(root, 'alpha', { pathGlob: '**/*.js', maxResults: 1 });
  assert.equal(js.matches[0].path, 'src/a.js');
  assert.equal(js.truncated, true);
  await assert.rejects(searchWorkspace(root, 'alpha', { maxResults: 101 }), /maxResults cannot exceed 100/);
  await assert.rejects(searchWorkspace(root, 'alpha', { maxFiles: 10_001 }), /maxFiles cannot exceed 10000/);
  await assert.rejects(searchWorkspace(root, 'alpha', { maxFileBytes: 1_000_001 }), /maxFileBytes cannot exceed 1000000/);
});

test('line-level search enforces an aggregate byte cap and marks partial scans', async (t) => {
  const root = await createTempDirectory('xyst-search-byte-cap-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.txt'), 'first file bytes\n');
  await fs.writeFile(path.join(root, 'b.txt'), 'second file bytes\n');

  const result = await searchWorkspace(root, 'absent-marker', { maxScanBytes: 20 });
  assert.equal(result.matches.length, 0);
  assert.equal(result.bytes_scanned, Buffer.byteLength('first file bytes\n'));
  assert.equal(result.truncated, true);
  await assert.rejects(searchWorkspace(root, 'absent-marker', { maxScanBytes: 64 * 1024 * 1024 + 1 }), /cannot exceed/);
});

test('line-level search bounds workspace ignore-rule reads', async (t) => {
  const root = await createTempDirectory('xyst-search-ignore-limit-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, '.gitignore'), Buffer.alloc(1024 * 1024 + 1, 0x61));
  await assert.rejects(searchWorkspace(root, 'marker'), { code: 'RETRIEVAL_RULE_FILE_LIMIT' });
  await fs.writeFile(path.join(root, '.gitignore'), `${'#\n'.repeat(10_000)}#`);
  await assert.rejects(searchWorkspace(root, 'marker'), { code: 'RETRIEVAL_RULE_COUNT_LIMIT' });
});

test('line-level search rejects a workspace ignore file replaced between metadata check and open', async (t) => {
  const root = await createTempDirectory('xyst-search-ignore-race-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ignorePath = path.join(root, '.gitignore');
  await fs.writeFile(ignorePath, '#\n');
  let replaced = false;
  const filesystem = new Proxy(fs, {
    get(target, property) {
      if (property === 'open')
        return async (filePath, ...args) => {
          if (!replaced && path.resolve(filePath) === path.resolve(ignorePath)) {
            replaced = true;
            await target.rename(ignorePath, `${ignorePath}.old`);
            await target.writeFile(ignorePath, 'x\n');
          }
          return target.open(filePath, ...args);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  await assert.rejects(searchWorkspace(root, 'marker', { filesystem }), { code: 'RETRIEVAL_RULE_FILE_CHANGED' });
  assert.equal(replaced, true);
});

test('line-level search stops at the configured file cap and reports remaining workspace files', async (t) => {
  const root = await createTempDirectory('xyst-search-file-cap-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.txt'), 'marker in first file\n');
  await fs.writeFile(path.join(root, 'b.txt'), 'marker in second file\n');
  await fs.writeFile(path.join(root, 'c.txt'), 'marker in third file\n');

  const result = await searchWorkspace(root, 'marker', { maxFiles: 1 });
  assert.equal(result.files_scanned, 1);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].path, 'a.txt');
  assert.equal(result.truncated, true);
});

test('line-level search rejects a workspace directory swapped to an outside reparse point', async (t) => {
  const root = await createTempDirectory('xyst-search-link-race-');
  const outside = `${root}-outside`;
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  const workspaceDirectory = path.join(root, 'src');
  const parkedDirectory = path.join(root, 'src-original');
  const replacementLink = path.join(root, 'outside-link');
  await fs.mkdir(workspaceDirectory);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(workspaceDirectory, 'inside.txt'), 'safe workspace text');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'OUTSIDE_SEARCH_CANARY');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  if (!(await createSymlinkOrSkip(t, outside, replacementLink, linkType))) return;

  let swapped = false;
  const filesystem = new Proxy(fs, {
    get(target, property) {
      if (property === 'readdir')
        return async (directory, options) => {
          const entries = await target.readdir(directory, options);
          if (!swapped && path.resolve(directory) === path.resolve(root)) {
            swapped = true;
            await target.rename(workspaceDirectory, parkedDirectory);
            await target.rename(replacementLink, workspaceDirectory);
          }
          return entries;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const result = await searchWorkspace(root, 'OUTSIDE_SEARCH_CANARY', { filesystem });
  assert.equal(swapped, true);
  assert.deepEqual(result.matches, []);
  assert.doesNotMatch(JSON.stringify(result.matches), /OUTSIDE_SEARCH_CANARY/);
});
