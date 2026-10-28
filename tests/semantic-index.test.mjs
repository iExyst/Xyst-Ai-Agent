import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SemanticWorkspaceIndex, cosineSimilarity } from '../src/retrieval/semantic-index.mjs';
import { createSemanticIndex } from '../src/retrieval/create-semantic-index.mjs';
import { UsageBudgetStore } from '../src/session/usage-budget.mjs';
import { createSymlinkOrSkip, createTempDirectory } from './helpers.mjs';

function fakeEmbed(texts) {
  return texts.map((text) => {
    const value = text.toLowerCase();
    if (/car|vehicle|automobile|transport/.test(value)) return [1, 0, 0];
    if (/flower|garden|petal/.test(value)) return [0, 1, 0];
    return [0, 0, 1];
  });
}

test('semantic index ranks by cosine similarity, refreshes changed files, and stores no source text', async (t) => {
  const root = await createTempDirectory('xyst-semantic-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'build'), { recursive: true });
  await fs.writeFile(path.join(root, '.gitignore'), 'build/\n*.secret\n');
  await fs.writeFile(path.join(root, 'src', 'transport.js'), 'A vehicle moves people along roads.\n');
  await fs.writeFile(path.join(root, 'src', 'garden.js'), 'A flower grows petals in a garden.\n');
  await fs.writeFile(path.join(root, 'build', 'generated.js'), 'automobile vehicle transport\n');
  await fs.writeFile(path.join(root, 'private.secret'), 'car vehicle transport\n');
  const calls = [];
  const index = new SemanticWorkspaceIndex(root, {
    model: 'mock-embed-v1',
    embed: async (texts) => {
      calls.push([...texts]);
      return fakeEmbed(texts);
    },
  });
  const initial = await index.search('automobile');
  assert.equal(initial.matches[0].path, 'src/transport.js');
  assert.equal(initial.files_indexed, 3); // includes the workspace's .gitignore file
  assert.equal(initial.chunks_indexed, 3); // includes the workspace's .gitignore file
  assert.ok(initial.matches[0].score > initial.matches.at(-1).score);
  const saved = await fs.readFile(path.join(root, '.agent', 'retrieval', 'semantic-index.json'), 'utf8');
  assert.doesNotMatch(saved, /vehicle moves|flower grows|automobile vehicle/);
  assert.doesNotMatch(saved, /private\.secret|generated\.js/);
  const beforeChangeCallCount = calls.length;
  await fs.writeFile(path.join(root, 'src', 'garden.js'), 'A flower blooms beside the garden petals.\n');
  const afterUpdate = await index.search('petal');
  assert.equal(afterUpdate.matches[0].path, 'src/garden.js');
  assert.equal(calls.length, beforeChangeCallCount + 2); // changed file plus query vector; unchanged file is reused
  assert.equal((await index.status()).files, 3);
  await fs.rm(path.join(root, 'src', 'garden.js'));
  const afterDelete = await index.search('petal');
  assert.equal(
    afterDelete.matches.some((match) => match.path === 'src/garden.js'),
    false,
  );
  assert.equal((await index.status()).files, 2);
  await index.clear();
  assert.equal((await index.status()).chunks, 0);
});

test('semantic index enforces vector dimensions, index scope, and result limits', async (t) => {
  const root = await createTempDirectory('xyst-semantic-invalid-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.txt'), 'vehicle data\n');
  const index = new SemanticWorkspaceIndex(root, {
    model: 'mock',
    embed: async (texts) => texts.map((text) => (text.includes('vehicle') ? [1, 0] : [1, 0, 0])),
  });
  await assert.rejects(index.search('car'), { code: 'INVALID_RESPONSE' });
  await assert.rejects(index.search('car', { limit: 51 }), /limit must be between/);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0.5, 0.5]) - Math.SQRT1_2) < 1e-12);
  assert.throws(() => cosineSimilarity([1], [1, 0]), /equal non-zero dimensions/);
});

test('semantic scan reports bounded partial indexing rather than consuming an unbounded workspace', async (t) => {
  const root = await createTempDirectory('xyst-semantic-bounded-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.txt'), 'vehicle data\n');
  await fs.writeFile(path.join(root, 'b.txt'), 'flower data\n');
  const index = new SemanticWorkspaceIndex(root, { model: 'mock', maxFiles: 1, embed: async (texts) => texts.map(() => [1, 0]) });
  const result = await index.search('vehicle');
  assert.equal(result.files_indexed, 1);
  assert.equal(result.truncated, true);
});

test('semantic scan caps directory traversal and reports omitted workspace paths', async (t) => {
  const root = await createTempDirectory('xyst-semantic-directory-cap-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const realRoot = await fs.realpath(root);
  const rootStat = await fs.lstat(root, { bigint: true });
  const directoryNames = Array.from({ length: 110 }, (_, index) => `empty-${String(index).padStart(3, '0')}`);
  let directoriesRead = 0;
  const scanFilesystem = new Proxy(fs, {
    get(target, property) {
      if (property === 'lstat')
        return async (filePath, options) => (path.resolve(filePath) === path.resolve(root) ? target.lstat(filePath, options) : rootStat);
      if (property === 'realpath')
        return async (filePath) => (path.resolve(filePath) === path.resolve(root) ? realRoot : path.resolve(filePath));
      if (property === 'opendir')
        return async (directory) => {
          const entries =
            path.resolve(directory) === path.resolve(root)
              ? directoryNames.map((name) => ({ name, isDirectory: () => true, isFile: () => false }))
              : [];
          if (path.resolve(directory) !== path.resolve(root)) directoriesRead += 1;
          return {
            async *[Symbol.asyncIterator]() {
              yield* entries;
            },
            async close() {},
          };
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const index = new SemanticWorkspaceIndex(root, {
    model: 'mock',
    maxDirectories: 100,
    scanFilesystem,
    embed: async (texts) => texts.map(() => [1, 0]),
  });
  const result = await index.search('anything');
  assert.equal(result.truncated, true);
  assert.ok(directoriesRead < 110);
  assert.ok(directoriesRead >= 90);
});

test('semantic scan stops streaming directory entries at the configured workspace cap', async (t) => {
  const root = await createTempDirectory('xyst-semantic-entry-cap-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const rootStat = await fs.lstat(root, { bigint: true });
  let entriesYielded = 0;
  const scanFilesystem = new Proxy(fs, {
    get(target, property) {
      if (property === 'opendir')
        return async () => ({
          async *[Symbol.asyncIterator]() {
            for (let index = 0; index < 100; index += 1) {
              entriesYielded += 1;
              yield { name: `dir-${index}`, isDirectory: () => true, isFile: () => false };
            }
          },
          async close() {},
        });
      if (property === 'realpath') return async () => root;
      if (property === 'lstat') return async () => rootStat;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const index = new SemanticWorkspaceIndex(root, {
    model: 'mock',
    maxDirectories: 1,
    maxEntries: 20,
    scanFilesystem,
    embed: async (texts) => texts.map(() => [1, 0]),
  });
  const result = await index.search('anything');
  assert.equal(result.truncated, true);
  assert.equal(entriesYielded, 21, 'the scanner reads one entry past the cap to detect truncation');
});

test('semantic index reads stop at the size limit plus one byte when it grows during reading', async (t) => {
  const root = await createTempDirectory('xyst-semantic-index-bounded-read-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const index = new SemanticWorkspaceIndex(root, { model: 'mock', embed: async (texts) => texts.map(() => [1, 0]) });
  await fs.writeFile(path.join(root, 'source.txt'), 'vehicle data\n');
  await index.search('vehicle');
  const indexPath = path.join(root, '.agent', 'retrieval', 'semantic-index.json');
  const probe = await fs.open(indexPath, 'r');
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  const read = fileHandlePrototype.read;
  let bytesRead = 0;
  fileHandlePrototype.read = async (buffer, offset, length) => {
    buffer.fill(0, offset, offset + length);
    bytesRead += length;
    return { bytesRead: length, buffer };
  };
  try {
    await assert.rejects(index.status(), { code: 'INDEX_FILE_LIMIT' });
    assert.equal(bytesRead, 32 * 1024 * 1024 + 1);
  } finally {
    fileHandlePrototype.read = read;
  }
});

test('semantic index lock cleanup preserves a replacement lock from another writer', async (t) => {
  const root = await createTempDirectory('xyst-semantic-lock-replacement-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const index = new SemanticWorkspaceIndex(root, {
    model: 'mock',
    embed: async (texts) => {
      try {
        await fs.rm(index.lock);
        await fs.writeFile(index.lock, 'replacement writer lock');
      } catch (error) {
        if (process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code))
          throw Object.assign(new Error(`replacement unavailable: ${error.code}`), { code: 'TEST_REPLACEMENT_UNAVAILABLE' });
        throw error;
      }
      return texts.map(() => [1, 0]);
    },
  });
  await fs.writeFile(path.join(root, 'source.txt'), 'vehicle data\n');
  try {
    await index.search('vehicle');
  } catch (error) {
    if (error.code === 'TEST_REPLACEMENT_UNAVAILABLE') return t.skip(error.message);
    throw error;
  }
  assert.equal(await fs.readFile(index.lock, 'utf8'), 'replacement writer lock');
});

test('semantic retrieval bounds ignore and exclusion policy reads', async (t) => {
  const root = await createTempDirectory('xyst-semantic-rule-limits-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const index = new SemanticWorkspaceIndex(root, { model: 'mock', embed: async (texts) => texts.map(() => [1, 0]) });

  await fs.writeFile(path.join(root, '.gitignore'), Buffer.alloc(1024 * 1024 + 1, 0x61));
  await assert.rejects(index.search('marker'), { code: 'RETRIEVAL_RULE_FILE_LIMIT' });
  await fs.writeFile(path.join(root, '.gitignore'), `${'#\n'.repeat(10_000)}#`);
  await assert.rejects(index.search('marker'), { code: 'RETRIEVAL_RULE_COUNT_LIMIT' });
  await fs.rm(path.join(root, '.gitignore'));

  await fs.mkdir(path.join(root, '.agent', 'retrieval'), { recursive: true });
  await fs.writeFile(path.join(root, '.agent', 'retrieval', 'excludes.json'), Buffer.alloc(32 * 1024 + 1, 0x20));
  await assert.rejects(index.listExclusions(), { code: 'RETRIEVAL_RULE_FILE_LIMIT' });
});

test('semantic retrieval fuses exact lexical evidence with embedding rank for hybrid results', async (t) => {
  const root = await createTempDirectory('xyst-semantic-hybrid-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'z'), { recursive: true });
  await fs.mkdir(path.join(root, 'a'), { recursive: true });
  await fs.writeFile(path.join(root, 'z', 'identifier.txt'), 'The exact NeedleSymbol is declared here.\n');
  await fs.writeFile(path.join(root, 'a', 'general.txt'), 'This is a general implementation detail.\n');
  const index = new SemanticWorkspaceIndex(root, { model: 'flat-mock', embed: async (texts) => texts.map(() => [1, 0]) });
  const result = await index.search('NeedleSymbol');
  assert.equal(result.source, 'hybrid_workspace');
  assert.equal(result.matches[0].path, 'z/identifier.txt', 'exact identifier occurrence should outrank an embedding-only tie');
  assert.ok(result.matches[0].score > result.matches[1].score);
});

test('semantic retrieval fuses exact line matches outside the bounded vector chunks', async (t) => {
  const root = await createTempDirectory('xyst-semantic-line-fusion-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const exactLine = 'The exact phrase NeedleSymbol is only present after the first chunk.';
  await fs.writeFile(
    path.join(root, 'long-source.txt'),
    `${'General source information without the exact identifier.\n'.repeat(500)}${exactLine}\n`,
  );
  const index = new SemanticWorkspaceIndex(root, {
    model: 'flat-mock',
    embed: async (texts) => texts.map(() => [1, 0]),
  });

  const result = await index.search('NeedleSymbol', { maxNewChunks: 1 });
  assert.equal(result.chunks_indexed, 1, 'vector work remains bounded to the requested first chunk');
  assert.equal(result.matches[0].path, 'long-source.txt');
  assert.equal(result.matches[0].start_line, 501);
  assert.equal(result.matches[0].end_line, 501);
  assert.equal(result.matches[0].text, exactLine);
  assert.equal(result.matches[0].source, 'hybrid_workspace');
});

test('semantic index exclusion rules apply immediately, reject traversal, and explicit rebuild restores eligible files', async (t) => {
  const root = await createTempDirectory('xyst-semantic-exclusions-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'private'), { recursive: true });
  await fs.writeFile(path.join(root, 'public.txt'), 'public content\n');
  await fs.writeFile(path.join(root, 'private', 'notes.txt'), 'private content\n');
  const index = new SemanticWorkspaceIndex(root, { model: 'mock', embed: async (texts) => texts.map(() => [1, 0]) });
  await index.search('content');
  assert.equal((await index.status()).files, 2);
  const oldChunks = (await index.status()).chunks;
  const embed = index.embed;
  index.embed = async () => {
    throw new Error('simulated embedding outage');
  };
  await assert.rejects(index.rebuild(), /simulated embedding outage/);
  assert.equal((await index.status()).chunks, oldChunks, 'failed rebuild must leave the previous index intact');
  index.embed = embed;
  await assert.rejects(index.addExclusion('../outside'), /relative workspace glob/);
  const added = await index.addExclusion('private/**');
  assert.equal(added.added, true);
  const refreshed = await index.search('content');
  assert.equal(
    refreshed.matches.some((match) => match.path.startsWith('private/')),
    false,
  );
  assert.equal((await index.status()).files, 1);
  assert.deepEqual(await index.listExclusions(), ['private/**']);
  assert.equal((await index.removeExclusion('private/**')).removed, true);
  const rebuilt = await index.rebuild();
  assert.equal(rebuilt.files_indexed, 2);
  assert.equal((await index.status()).files, 2);
});

test('retrieval exclusion update restores an interrupted policy file before changing exclusions', async (t) => {
  const root = await createTempDirectory('xyst-semantic-exclusion-recovery-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const index = new SemanticWorkspaceIndex(root, { model: 'mock', embed: async (texts) => texts.map(() => [1, 0]) });
  await index.addExclusion('private/**');
  const backup = `${index.excludeFile}.00000000-0000-4000-8000-000000000001.bak`;
  await fs.rename(index.excludeFile, backup);
  await assert.rejects(index.listExclusions(), { code: 'RETRIEVAL_RULE_RECOVERY_REQUIRED' });
  await index.addExclusion('secrets/**');
  assert.deepEqual(await index.listExclusions(), ['private/**', 'secrets/**']);
  await assert.rejects(fs.stat(backup), { code: 'ENOENT' });
});

test('automatic-search index limits cap fresh embedding work and report truncation', async (t) => {
  const root = await createTempDirectory('xyst-semantic-auto-cap-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'large.md'), `${'architecture detail with enough text to create multiple chunks.\n'.repeat(700)}`);
  const batches = [];
  const index = new SemanticWorkspaceIndex(root, {
    model: 'mock',
    embed: async (texts) => {
      batches.push(texts.length);
      return texts.map(() => [1, 0]);
    },
  });
  const result = await index.search('architecture', { limit: 4, maxNewChunks: 3, scanMaxBytes: 100_000 });
  assert.equal(result.chunks_indexed, 3);
  assert.equal(result.truncated, true);
  assert.deepEqual(batches, [3, 1]); // bounded document chunks, then the query vector
});

test('semantic index batches chunks across file boundaries up to the provider batch limit', async (t) => {
  const root = await createTempDirectory('xyst-semantic-global-batch-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (let index = 0; index < 40; index += 1) await fs.writeFile(path.join(root, `doc-${index}.txt`), `document ${index}\n`);
  const batches = [];
  const index = new SemanticWorkspaceIndex(root, {
    model: 'mock',
    embed: async (texts) => {
      batches.push(texts.length);
      return texts.map(() => [1, 0]);
    },
  });
  const result = await index.search('document');
  assert.equal(result.chunks_indexed, 40);
  assert.deepEqual(batches, [32, 8, 1]);
});

test('semantic index reuses unchanged content and invalidates changed files from watcher events', async (t) => {
  const root = await createTempDirectory('xyst-semantic-watch-cache-');
  const sourcePath = path.join(root, 'source.txt');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(sourcePath, 'alpha source text\n');
  let sourceReads = 0;
  const scanFilesystem = new Proxy(fs, {
    get(target, property) {
      if (property === 'open')
        return async (filePath, ...args) => {
          if (path.resolve(filePath) === path.resolve(sourcePath)) sourceReads += 1;
          return target.open(filePath, ...args);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  let onChange;
  let onWatcherError;
  const watcher = {
    close() {},
    on(event, listener) {
      if (event === 'error') onWatcherError = listener;
      return this;
    },
    unref() {},
  };
  const index = new SemanticWorkspaceIndex(root, {
    model: 'flat-mock',
    scanFilesystem,
    watchWorkspace: true,
    watchFilesystem: (_root, _options, listener) => {
      onChange = listener;
      return watcher;
    },
    embed: async (texts) => texts.map(() => [1, 0]),
  });
  t.after(() => index.close());

  assert.equal((await index.search('alpha')).matches[0].path, 'source.txt');
  assert.equal(sourceReads, 1);
  assert.equal((await index.search('alpha')).matches[0].path, 'source.txt');
  assert.equal(sourceReads, 1, 'a warm search should reuse the verified in-memory content');
  index.lastFullContentRefresh = Date.now() - 30_001;
  await index.search('alpha');
  assert.equal(sourceReads, 2, 'the periodic full refresh should reread source content');

  await fs.writeFile(sourcePath, 'beta source text\n');
  onChange('change', 'source.txt');
  assert.equal((await index.search('beta')).matches[0].path, 'source.txt');
  assert.equal(sourceReads, 3, 'the watcher should invalidate the changed path');
  onChange('rename', null);
  await index.search('beta');
  assert.equal(sourceReads, 4, 'an unknown watcher filename should clear the cache');
  onWatcherError(new Error('simulated watcher failure'));
  await index.search('beta');
  assert.equal(sourceReads, 5, 'a watcher failure should disable the cache and force full reads');
});

test('recursive workspace watcher refreshes changed content during a multi-file save burst', async (t) => {
  const root = await createTempDirectory('xyst-semantic-watch-burst-');
  const sourceRoot = path.join(root, 'src', 'nested');
  await fs.mkdir(sourceRoot, { recursive: true });
  const count = 2_048;
  const embedded = [];
  for (let index = 0; index < count; index += 1)
    await fs.writeFile(
      path.join(sourceRoot, `doc-${String(index).padStart(2, '0')}.txt`),
      `old-content-${String(index).padStart(2, '0')}\n`,
    );
  const index = new SemanticWorkspaceIndex(root, {
    model: 'flat-mock',
    watchWorkspace: true,
    embed: async (texts) => {
      embedded.push(...texts);
      return texts.map(() => [1, 0]);
    },
  });
  t.after(async () => {
    index.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const initial = await index.search('old-content', { limit: 50 });
  assert.equal(initial.files_indexed, count);
  assert.equal(index.workspaceWatcher !== null, true, 'recursive watch mode must be active for supported Windows/Linux runtimes');
  assert.equal(index.documentCache.size, count);

  await Promise.all(
    Array.from({ length: count }, (_, item) =>
      fs.writeFile(path.join(sourceRoot, `doc-${String(item).padStart(2, '0')}.txt`), `new-content-${String(item).padStart(2, '0')}\n`),
    ),
  );
  // A large burst may coalesce or omit individual filesystem notifications.
  // Metadata snapshots must still reject stale cached text for every changed file.
  embedded.length = 0;
  const refreshed = await index.search('new-content', { limit: 50 });
  assert.equal(refreshed.files_indexed, count);
  assert.equal(refreshed.matches.length, 50, 'the result limit remains bounded during a large save burst');
  assert.ok(refreshed.matches.every((match) => match.text.includes('new-content')));
  assert.equal(
    embedded.filter((text) => text.includes('new-content')).length,
    count + 1,
    'all changed files and the query should be embedded',
  );
});

test('semantic scanner rejects a workspace directory swapped to an outside reparse point after enumeration', async (t) => {
  const root = await createTempDirectory('xyst-semantic-symlink-race-');
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
  await fs.writeFile(path.join(workspaceDirectory, 'inside.txt'), 'public project source');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'OUTSIDE_PRIVATE_CANARY');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  if (!(await createSymlinkOrSkip(t, outside, replacementLink, linkType))) return;

  let swapped = false;
  const scanFilesystem = new Proxy(fs, {
    get(target, property) {
      if (property === 'opendir')
        return async (directory) => {
          const opened = await target.opendir(directory);
          if (!swapped && path.resolve(directory) === path.resolve(root)) {
            swapped = true;
            await target.rename(workspaceDirectory, parkedDirectory);
            await target.rename(replacementLink, workspaceDirectory);
          }
          return opened;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const embedded = [];
  const index = new SemanticWorkspaceIndex(root, {
    model: 'mock',
    scanFilesystem,
    embed: async (texts) => {
      embedded.push(...texts);
      return texts.map(() => [1, 0]);
    },
  });
  const result = await index.search('private canary');
  assert.equal(swapped, true);
  assert.equal(result.files_indexed, 0);
  assert.deepEqual(embedded, [], 'outside file contents must never reach the embedding callback');
  assert.doesNotMatch(
    JSON.stringify(await fs.readFile(path.join(root, '.agent', 'retrieval', 'semantic-index.json'), 'utf8')),
    /OUTSIDE_PRIVATE_CANARY/,
  );
});

test('semantic embeddings settle shared usage with provider attribution and enforce token budgets before sending', async (t) => {
  const root = await createTempDirectory('xyst-semantic-usage-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'source.txt'), 'A short document about retrieval.\n');
  let requests = 0;
  const fetchImpl = async (_url, options) => {
    requests += 1;
    const body = JSON.parse(options.body);
    return Response.json({
      data: body.input.map((_, index) => ({ index, embedding: [1, 0] })),
      usage: { prompt_tokens: body.input.length * 7 },
    });
  };
  const usageBudgetStore = new UsageBudgetStore(root);
  const config = {
    budgets: { max_daily_input_tokens: 100, max_daily_cost: 1 },
    retrieval: {
      max_files: 20,
      max_file_bytes: 20_000,
      semantic: {
        enabled: true,
        model: 'embedding-model',
        base_url: 'http://127.0.0.1:1234/v1',
        timeout_ms: 1_000,
        input_cost_per_million: 1,
      },
    },
  };
  const index = createSemanticIndex({ workspaceRoot: root, config, fetchImpl, usageBudgetStore });
  const sessionId = '39b7efae-8558-4fc5-9f8d-4e283580a59c';
  await index.search('retrieval query', { sessionId });
  const snapshot = await usageBudgetStore.snapshot();
  assert.equal(snapshot.daily.input_tokens, 14);
  assert.equal(snapshot.daily.cost_usd, 0.000014);
  assert.equal(snapshot.attribution.daily.input_tokens_by_source.provider_reported, 14);
  assert.equal(snapshot.attribution.daily.by_model['embedding-model'].input_tokens, 14);
  assert.equal(snapshot.attribution.daily.by_session[sessionId].input_tokens, 14);

  const limitedRoot = await createTempDirectory('xyst-semantic-budget-');
  t.after(() => fs.rm(limitedRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(limitedRoot, 'source.txt'), 'A short document about retrieval.\n');
  const limited = createSemanticIndex({
    workspaceRoot: limitedRoot,
    config: {
      ...config,
      budgets: { max_daily_cost: 1 },
      retrieval: {
        ...config.retrieval,
        semantic: { ...config.retrieval.semantic, input_cost_per_million: undefined },
      },
    },
    fetchImpl,
    usageBudgetStore: new UsageBudgetStore(limitedRoot),
  });
  const before = requests;
  await assert.rejects(limited.search('retrieval query', { sessionId }), { code: 'BUDGET_EXCEEDED' });
  assert.equal(requests, before, 'the provider must not be called after reservation fails');
});
