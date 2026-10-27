import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { SemanticWorkspaceIndex } from '../src/retrieval/semantic-index.mjs';

const options = parseArguments(process.argv.slice(2));
const query = 'Architecture retrieval benchmark document';
const temporaryRoot = path.join(process.cwd(), '.test-tmp');
await fs.mkdir(temporaryRoot, { recursive: true });
const workspaceRoot = await fs.mkdtemp(path.join(temporaryRoot, 'xyst-retrieval-bench-'));
let index;

try {
  const generationStarted = performance.now();
  await generateWorkspace(workspaceRoot, options.files, options.fileBytes);
  const generationMs = elapsed(generationStarted);
  const baselineRss = process.memoryUsage().rss;
  const calls = [];
  index = new SemanticWorkspaceIndex(workspaceRoot, {
    model: 'benchmark-deterministic-v1',
    maxFiles: Math.min(10_000, options.files + 10),
    maxFileBytes: options.fileBytes + 1,
    watchWorkspace: true,
    embed: async (texts) => {
      calls.push({ count: texts.length, inputCharacters: texts.reduce((total, text) => total + text.length, 0) });
      return texts.map(() => [1, 0, 0, 0]);
    },
  });

  const initialStarted = performance.now();
  const first = await index.search(query, { limit: 5, scanMaxBytes: options.scanBytes });
  assert.equal(first.truncated, false, 'benchmark limits truncated the workspace; increase --scan-bytes or reduce the fixture size');
  assert.ok(
    first.matches.some((match) => match.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())),
    'the hybrid search benchmark must include its exact line-level fixture phrase',
  );
  const initialIndexMs = elapsed(initialStarted);
  const warmStarted = performance.now();
  const warm = await index.search(query, { limit: 5, scanMaxBytes: options.scanBytes });
  const warmSearchMs = elapsed(warmStarted);
  const state = await fs.stat(path.join(workspaceRoot, '.agent', 'retrieval', 'semantic-index.json'));
  const status = await index.status();

  process.stdout.write(
    `${JSON.stringify(
      {
        benchmark: 'semantic-index-v1',
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
        options,
        query,
        workspace_generation_ms: generationMs,
        initial_index_and_search_ms: initialIndexMs,
        warm_search_ms: warmSearchMs,
        files_discovered: first.files_indexed,
        files_indexed: status.files,
        chunks_indexed: status.chunks,
        initial_result_count: first.matches.length,
        warm_result_count: warm.matches.length,
        workspace_watcher_active: Boolean(index.workspaceWatcher),
        warm_cached_document_count: index.documentCache.size,
        embedding_requests: calls.length,
        chunk_embedding_requests: Math.max(0, calls.length - 2),
        query_embedding_requests: 2,
        embedded_inputs: calls.reduce((total, call) => total + call.count, 0),
        max_batch_size: Math.max(0, ...calls.map((call) => call.count)),
        index_file_bytes: state.size,
        indexing_rss_delta_mib: Number(((process.memoryUsage().rss - baselineRss) / (1024 * 1024)).toFixed(2)),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  index?.close();
  await fs.rm(workspaceRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function parseArguments(args) {
  const options = { files: 1_500, fileBytes: 2_048, scanBytes: 64 * 1024 * 1024 };
  const names = new Map([
    ['--files', 'files'],
    ['--file-bytes', 'fileBytes'],
    ['--scan-bytes', 'scanBytes'],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const key = names.get(args[index]);
    if (!key) throw new TypeError(`Unknown option: ${args[index]}`);
    const value = Number(args[index + 1]);
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${args[index]} must be a positive safe integer`);
    options[key] = value;
    index += 1;
  }
  if (Math.ceil(options.fileBytes / 1_500) * options.files > 4_900)
    throw new RangeError('The requested files and file size could exceed the semantic index 5000-chunk limit');
  if (options.fileBytes > 500_000) throw new RangeError('--file-bytes cannot exceed the index file-size limit of 500000 bytes');
  if (options.scanBytes > 64 * 1024 * 1024) throw new RangeError('--scan-bytes cannot exceed the 64 MiB workspace scan limit');
  return options;
}

async function generateWorkspace(root, count, targetBytes) {
  const documents = path.join(root, 'src');
  await fs.mkdir(documents);
  const seed = 'Architecture retrieval benchmark document with stable content and searchable implementation details.\n';
  const filler = 'Stable synthetic content for measuring retrieval indexing performance.\n';
  const padding = filler.repeat(Math.ceil(targetBytes / Buffer.byteLength(filler)));
  for (let index = 0; index < count; index += 1) {
    const header = `Document ${String(index).padStart(5, '0')} describes benchmark fixture ${index}.\n`;
    const body = `${header}${index === 0 ? seed : ''}${padding}`.slice(0, targetBytes);
    await fs.writeFile(path.join(documents, `doc-${String(index).padStart(5, '0')}.md`), body);
  }
}

function elapsed(start) {
  return Number((performance.now() - start).toFixed(2));
}
