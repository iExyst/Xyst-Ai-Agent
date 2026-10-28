import fs from 'node:fs/promises';
import { constants, watch as watchFs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { atomicWriteJson, hasAtomicWriteBackup, readBoundedFileHandle, restoreAtomicWriteBackup } from '../platform/files.mjs';
import { isPathInside } from '../platform/paths.mjs';
import { isSensitivePath, redactSecrets } from '../platform/redaction.mjs';
import { embeddingIdentity } from '../providers/embeddings.mjs';
import { searchWorkspaceDocuments } from './search.mjs';
import { assertGitignoreLineLimit, readWorkspaceRuleFile } from './rule-files.mjs';

const VERSION = 1;
const MAX_CHUNKS = 5_000;
const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_SCAN_DIRECTORIES = 50_000;
const MAX_SCAN_ENTRIES = 50_000;
const CACHE_FULL_REFRESH_MS = 30_000;
const CHUNK_CHARS = 1_800;
const OVERLAP_CHARS = 240;
const IGNORED = new Set(['.git', '.agent', 'node_modules', 'dist', 'coverage', '.next', 'target']);

/** Incremental vector index. It stores paths, hashes, line ranges, and vectors; source text is never persisted. */
export class SemanticWorkspaceIndex {
  constructor(
    workspaceRoot,
    {
      embed,
      model,
      usageBudgetStore,
      usageLimits = {},
      maxFiles = 3_000,
      maxFileBytes = 500_000,
      maxDirectories = MAX_SCAN_DIRECTORIES,
      maxEntries = MAX_SCAN_ENTRIES,
      scanFilesystem = fs,
      watchWorkspace = false,
      watchFilesystem = watchWorkspace && scanFilesystem === fs ? watchFs : null,
    } = {},
  ) {
    if (typeof embed !== 'function' || typeof model !== 'string' || !model)
      throw new TypeError('Semantic index needs an embedding callback and model name');
    if (!Number.isInteger(maxDirectories) || maxDirectories < 1 || maxDirectories > MAX_SCAN_DIRECTORIES)
      throw new TypeError(`maxDirectories must be between 1 and ${MAX_SCAN_DIRECTORIES}`);
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_SCAN_ENTRIES)
      throw new TypeError(`maxEntries must be between 1 and ${MAX_SCAN_ENTRIES}`);
    this.root = workspaceRoot;
    this.embed = embed;
    this.model = model;
    this.usageBudgetStore = usageBudgetStore;
    this.usageLimits = usageLimits;
    this.scanFilesystem = scanFilesystem;
    this.watchFilesystem = watchFilesystem;
    this.workspaceWatcher = null;
    this.watcherFailed = false;
    this.documentCache = new Map();
    this.lastFullContentRefresh = 0;
    this.workspaceChangeGeneration = 0;
    this.maxFiles = Math.min(10_000, maxFiles);
    this.maxFileBytes = Math.min(1_000_000, maxFileBytes);
    this.maxDirectories = maxDirectories;
    this.maxEntries = maxEntries;
    this.directory = path.join(workspaceRoot, '.agent', 'retrieval');
    this.file = path.join(this.directory, 'semantic-index.json');
    this.excludeFile = path.join(this.directory, 'excludes.json');
    this.lock = path.join(this.directory, 'index.lock');
  }

  close() {
    this.workspaceWatcher?.close();
    this.workspaceWatcher = null;
    this.documentCache.clear();
    this.lastFullContentRefresh = 0;
  }

  async search(
    query,
    {
      limit = 8,
      pathGlob,
      signal,
      timeoutMs,
      rebuild = false,
      maxNewChunks,
      scanMaxBytes = MAX_SCAN_BYTES,
      sessionId,
      usageLimits = this.usageLimits,
    } = {},
  ) {
    if (typeof query !== 'string' || !query.trim() || query.length > 2_000) throw new TypeError('query must contain 1 to 2000 characters');
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new TypeError('limit must be between 1 and 50');
    if (maxNewChunks !== undefined && (!Number.isInteger(maxNewChunks) || maxNewChunks < 1 || maxNewChunks > MAX_CHUNKS))
      throw new TypeError('maxNewChunks must be between 1 and 5000');
    if (!Number.isInteger(scanMaxBytes) || scanMaxBytes < 1 || scanMaxBytes > MAX_SCAN_BYTES)
      throw new TypeError('scanMaxBytes must be between 1 and 64 MiB');
    return this.#withLock(async () => {
      this.#ensureWorkspaceWatcher();
      const forceContentRefresh = rebuild || !this.workspaceWatcher || Date.now() - this.lastFullContentRefresh >= CACHE_FULL_REFRESH_MS;
      const scanOptions = {
        filesystem: this.scanFilesystem,
        maxFiles: this.maxFiles,
        maxFileBytes: this.maxFileBytes,
        maxDirectories: this.maxDirectories,
        maxEntries: this.maxEntries,
        maxBytes: scanMaxBytes,
        signal,
      };
      const startingGeneration = this.workspaceChangeGeneration;
      let scan = await readWorkspaceDocuments(this.root, {
        ...scanOptions,
        documentCache: forceContentRefresh ? null : this.documentCache,
      });
      if (startingGeneration !== this.workspaceChangeGeneration) {
        this.documentCache.clear();
        this.lastFullContentRefresh = 0;
        const retryGeneration = this.workspaceChangeGeneration;
        scan = await readWorkspaceDocuments(this.root, { ...scanOptions, documentCache: null });
        if (retryGeneration !== this.workspaceChangeGeneration) scan.truncated = true;
      }
      if (scan.truncated) {
        this.documentCache.clear();
        this.lastFullContentRefresh = 0;
      } else {
        this.documentCache = scan.documentCache;
        if (forceContentRefresh) this.lastFullContentRefresh = Date.now();
      }
      const documents = scan.documents;
      let state = await this.#read();
      const identity = embeddingIdentity(this.model, state.dimensions || 0);
      if (state.model !== this.model || (state.identity && state.identity !== identity)) state = emptyState(this.model);
      const current = new Map(documents.map((item) => [item.path, item]));
      const ignoreEntry = await readIgnoreRules(this.root);
      const kept = (rebuild ? [] : state.entries).filter(
        (entry) =>
          !ignoreEntry(entry.path, false) &&
          ((current.has(entry.path) && current.get(entry.path).sha256 === entry.sha256) || (scan.truncated && !current.has(entry.path))),
      );
      const indexed = new Set(kept.map((entry) => entry.path));
      const pending = documents.filter((item) => !indexed.has(item.path));
      const pendingChunks = [];
      for (const document of pending) {
        const remainingChunks = maxNewChunks === undefined ? MAX_CHUNKS : Math.max(0, maxNewChunks - pendingChunks.length);
        if (remainingChunks < 1) {
          scan.truncated = true;
          break;
        }
        const allChunks = makeChunks(document.content);
        const chunks = allChunks.slice(0, remainingChunks);
        if (chunks.length < allChunks.length) scan.truncated = true;
        if (!chunks.length) continue;
        if (kept.length + pendingChunks.length + chunks.length > MAX_CHUNKS)
          throw Object.assign(
            new Error(`Semantic index exceeds ${MAX_CHUNKS} chunks; narrow the indexed workspace or lower retrieval.max_files`),
            { code: 'INDEX_LIMIT' },
          );
        pendingChunks.push(...chunks.map((chunk) => ({ document, chunk })));
      }
      const newEntries = [];
      for (let offset = 0; offset < pendingChunks.length; offset += 32) {
        const batch = pendingChunks.slice(offset, offset + 32);
        const vectors = await this.embed(
          batch.map(({ chunk }) => chunk.text),
          { signal, timeoutMs, usageBudgetStore: this.usageBudgetStore, usageLimits, sessionId, model: this.model },
        );
        if (!Array.isArray(vectors) || vectors.length !== batch.length)
          throw Object.assign(new Error('Embedding provider returned the wrong number of vectors'), { code: 'INVALID_RESPONSE' });
        for (let index = 0; index < batch.length; index += 1) {
          const { document, chunk } = batch[index];
          const vector = validateVector(vectors[index], state.dimensions);
          state.dimensions ||= vector.length;
          newEntries.push({
            path: document.path,
            sha256: document.sha256,
            modified_at: document.modified_at,
            start_line: chunk.start_line,
            end_line: chunk.end_line,
            vector,
          });
        }
      }
      state = {
        version: VERSION,
        model: this.model,
        dimensions: state.dimensions || null,
        identity: state.dimensions ? embeddingIdentity(this.model, state.dimensions) : null,
        entries: [...kept, ...newEntries],
      };
      await this.#write(state);

      const lineSearch = searchWorkspaceDocuments(documents, query, {
        maxResults: Math.min(100, Math.max(25, limit * 4)),
        pathGlob,
      });
      const lineMatches = lineSearch.matches.filter((match) => !ignoreEntry(match.path, false));
      let queryVector = null;
      if (state.entries.length) {
        [queryVector] = await this.embed([redactSecrets(query)], {
          signal,
          timeoutMs,
          usageBudgetStore: this.usageBudgetStore,
          usageLimits,
          sessionId,
          model: this.model,
        });
        validateVector(queryVector, state.dimensions);
      }
      const docMap = new Map(documents.map((item) => [item.path, item]));
      const pathFilter = pathGlob ? globRegex(pathGlob) : null;
      const semanticCandidates = state.entries
        .filter((entry) => !pathFilter || pathFilter.test(entry.path))
        .map((entry) => ({
          path: entry.path,
          start_line: entry.start_line,
          end_line: entry.end_line,
          modified_at: entry.modified_at,
          semantic_score: cosineSimilarity(queryVector, entry.vector),
          text: excerptLines(docMap.get(entry.path)?.content || '', entry.start_line, entry.end_line),
        }))
        .filter((entry) => entry.text);
      const candidates = [...semanticCandidates];
      const lineCandidateFor = new Map();
      for (const match of lineMatches) {
        const overlapping = semanticCandidates.find(
          (entry) => entry.path === match.path && entry.start_line <= match.line && entry.end_line >= match.line,
        );
        const candidate = overlapping || {
          path: match.path,
          start_line: match.line,
          end_line: match.line,
          modified_at: match.modified_at,
          semantic_score: 0,
          text: match.text,
        };
        if (!overlapping) candidates.push(candidate);
        lineCandidateFor.set(`${match.path}\0${match.line}`, candidate);
      }

      // Reciprocal-rank fusion keeps lexical matches useful for exact symbols
      // while retaining semantic matches for paraphrases. Ranks are normalized
      // independently, so embedding score scales cannot swamp exact evidence.
      const terms = [
        ...new Set(
          redactSecrets(query)
            .toLocaleLowerCase()
            .split(/[^\p{L}\p{N}_]+/u)
            .filter((term) => term.length > 1),
        ),
      ];
      const semanticRanked = [...semanticCandidates].sort(
        (a, b) => b.semantic_score - a.semantic_score || a.path.localeCompare(b.path) || a.start_line - b.start_line,
      );
      const lexicalRanked = candidates
        .map((entry) => {
          const searchable = `${entry.path.replaceAll('/', ' ')}\n${entry.text}`.toLocaleLowerCase();
          const lexical_score = terms.reduce((score, term) => score + Math.min(4, searchable.split(term).length - 1), 0);
          return { ...entry, lexical_score };
        })
        .filter((entry) => entry.lexical_score > 0)
        .sort((a, b) => b.lexical_score - a.lexical_score || a.path.localeCompare(b.path) || a.start_line - b.start_line);
      const keyOf = (entry) => `${entry.path}\0${entry.start_line}\0${entry.end_line}`;
      const reciprocal = new Map();
      semanticRanked.forEach((entry, index) => {
        reciprocal.set(keyOf(entry), (reciprocal.get(keyOf(entry)) || 0) + 1 / (60 + index + 1));
      });
      lexicalRanked.forEach((entry, index) => {
        reciprocal.set(keyOf(entry), (reciprocal.get(keyOf(entry)) || 0) + 1 / (60 + index + 1));
      });
      lineMatches.forEach((match, index) => {
        const candidate = lineCandidateFor.get(`${match.path}\0${match.line}`);
        if (candidate) reciprocal.set(keyOf(candidate), (reciprocal.get(keyOf(candidate)) || 0) + 1 / (60 + index + 1));
      });
      const matches = candidates
        .map((entry) => ({ ...entry, source: 'hybrid_workspace', score: reciprocal.get(keyOf(entry)) || 0 }))
        .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.start_line - b.start_line)
        .slice(0, limit)
        .map(({ semantic_score, ...entry }) => entry);
      return {
        query,
        matches,
        files_indexed: documents.length,
        chunks_indexed: state.entries.length,
        truncated: scan.truncated || lineSearch.truncated,
        source: 'hybrid_workspace',
      };
    }, signal);
  }

  #ensureWorkspaceWatcher() {
    if (this.workspaceWatcher || this.watcherFailed || typeof this.watchFilesystem !== 'function') return;
    try {
      this.workspaceWatcher = this.watchFilesystem(this.root, { recursive: true }, (_event, filename) => {
        if (filename == null) {
          this.workspaceChangeGeneration += 1;
          this.documentCache.clear();
          return;
        }
        const relative = String(filename).replaceAll('\\', '/').replace(/^\.\//, '');
        if (!relative || relative.startsWith('/') || /^[A-Za-z]:\//.test(relative)) {
          this.workspaceChangeGeneration += 1;
          this.documentCache.clear();
          return;
        }
        const parts = relative.split('/');
        if (parts.some((part) => IGNORED.has(part)) || isSensitivePath(relative)) return;
        this.workspaceChangeGeneration += 1;
        for (const key of this.documentCache.keys()) if (key === relative || key.startsWith(`${relative}/`)) this.documentCache.delete(key);
      });
      this.workspaceWatcher.on('error', () => {
        this.workspaceWatcher?.close();
        this.workspaceWatcher = null;
        this.watcherFailed = true;
        this.workspaceChangeGeneration += 1;
        this.documentCache.clear();
        this.lastFullContentRefresh = 0;
      });
      this.workspaceWatcher.unref?.();
    } catch {
      this.workspaceWatcher?.close();
      this.workspaceWatcher = null;
      this.watcherFailed = true;
      this.workspaceChangeGeneration += 1;
      this.documentCache.clear();
      this.lastFullContentRefresh = 0;
    }
  }

  async status() {
    const state = await this.#read();
    return {
      model: state.model,
      dimensions: state.dimensions,
      chunks: state.entries.length,
      files: new Set(state.entries.map((entry) => entry.path)).size,
      exclusions: await this.listExclusions(),
    };
  }

  async rebuild({ signal, sessionId, usageLimits } = {}) {
    return this.search('workspace index refresh', { limit: 1, signal, rebuild: true, sessionId, usageLimits });
  }

  async listExclusions() {
    try {
      const text = await readWorkspaceRuleFile(this.root, this.excludeFile, { maxBytes: 32 * 1024 });
      if (text === null) {
        if (await hasAtomicWriteBackup(this.excludeFile))
          throw Object.assign(
            new Error('Retrieval exclusions have an interrupted replacement backup; update exclusions to recover them safely'),
            { code: 'RETRIEVAL_RULE_RECOVERY_REQUIRED' },
          );
        return [];
      }
      const data = JSON.parse(text);
      if (
        data.version !== 1 ||
        !Array.isArray(data.patterns) ||
        data.patterns.length > 100 ||
        data.patterns.some((item) => typeof item !== 'string')
      )
        throw new Error('Retrieval exclusions file is invalid');
      return data.patterns;
    } catch (error) {
      if (error.code === 'ENOENT') {
        if (await hasAtomicWriteBackup(this.excludeFile))
          throw Object.assign(
            new Error('Retrieval exclusions have an interrupted replacement backup; update exclusions to recover them safely'),
            {
              code: 'RETRIEVAL_RULE_RECOVERY_REQUIRED',
            },
          );
        return [];
      }
      throw error;
    }
  }

  async addExclusion(pattern) {
    validateExclusion(pattern);
    return this.#withLock(async () => {
      await this.#restoreExclusions();
      const patterns = await this.listExclusions();
      if (patterns.includes(pattern)) return { added: false, patterns };
      if (patterns.length >= 100) throw new Error('At most 100 retrieval exclusion patterns are supported');
      patterns.push(pattern);
      patterns.sort();
      await atomicWriteJson(this.excludeFile, { version: 1, patterns }, { mode: 0o600 });
      return { added: true, patterns };
    });
  }

  async removeExclusion(pattern) {
    validateExclusion(pattern);
    return this.#withLock(async () => {
      await this.#restoreExclusions();
      const patterns = await this.listExclusions();
      const next = patterns.filter((item) => item !== pattern);
      if (next.length !== patterns.length) await atomicWriteJson(this.excludeFile, { version: 1, patterns: next }, { mode: 0o600 });
      return { removed: next.length !== patterns.length, patterns: next };
    });
  }

  async clear() {
    return this.#withLock(async () => {
      await fs.rm(this.file, { force: true });
      return { cleared: true };
    });
  }

  async #read() {
    let handle;
    try {
      const metadata = await fs.lstat(this.file, { bigint: true });
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_INDEX_BYTES)
        throw Object.assign(new Error('Semantic index file is not a bounded regular file; inspect it before recovery'), {
          code: 'INDEX_FILE_INVALID',
        });
      handle = await fs.open(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || !sameFileSnapshot(metadata, opened))
        throw Object.assign(new Error('Semantic index file changed while opening; retry the retrieval operation'), {
          code: 'INDEX_FILE_CHANGED',
        });
      const bytes = await readBoundedFileHandle(handle, MAX_INDEX_BYTES);
      if (bytes === null)
        throw Object.assign(new Error('Semantic index file exceeds 32 MiB; inspect it before recovery'), { code: 'INDEX_FILE_LIMIT' });
      const afterRead = await handle.stat({ bigint: true });
      const currentPath = await fs.lstat(this.file, { bigint: true });
      if (
        !sameFileSnapshot(opened, afterRead) ||
        !sameFileSnapshot(opened, currentPath) ||
        !currentPath.isFile() ||
        currentPath.isSymbolicLink()
      )
        throw Object.assign(new Error('Semantic index file changed while reading; retry the retrieval operation'), {
          code: 'INDEX_FILE_CHANGED',
        });
      const state = JSON.parse(bytes.toString('utf8'));
      if (state.version !== VERSION || !Array.isArray(state.entries) || state.entries.length > MAX_CHUNKS)
        throw new Error('Semantic index is invalid; clear it before rebuilding');
      if (
        typeof state.model !== 'string' ||
        (state.dimensions !== null && (!Number.isInteger(state.dimensions) || state.dimensions < 1 || state.dimensions > 8192))
      )
        throw new Error('Semantic index metadata is invalid; clear it before rebuilding');
      for (const entry of state.entries) {
        const normalized = typeof entry?.path === 'string' ? entry.path.replaceAll('\\', '/') : '';
        if (
          !entry ||
          !normalized ||
          normalized.startsWith('/') ||
          normalized.split('/').some((part) => !part || part === '.' || part === '..') ||
          isSensitivePath(normalized) ||
          !/^[0-9a-f]{64}$/.test(entry.sha256 || '') ||
          !Number.isInteger(entry.start_line) ||
          !Number.isInteger(entry.end_line) ||
          entry.start_line < 1 ||
          entry.end_line < entry.start_line ||
          !Array.isArray(entry.vector) ||
          entry.vector.length > 8192 ||
          entry.vector.some((value) => !Number.isFinite(value))
        )
          throw new Error('Semantic index contains an invalid entry; clear it before rebuilding');
      }
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState(this.model);
      throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async #write(state) {
    const text = JSON.stringify(state);
    if (Buffer.byteLength(text) > MAX_INDEX_BYTES)
      throw Object.assign(new Error('Semantic index exceeds 32 MiB; reduce the indexed workspace'), { code: 'INDEX_LIMIT' });
    await atomicWriteJson(this.file, state, { mode: 0o600 });
  }

  async #restoreExclusions() {
    await restoreAtomicWriteBackup(this.excludeFile, {
      maxBytes: 32 * 1024,
      decode: (serialized) => {
        const data = JSON.parse(serialized);
        if (
          data?.version !== 1 ||
          !Array.isArray(data.patterns) ||
          data.patterns.length > 100 ||
          data.patterns.some((item) => typeof item !== 'string')
        )
          throw new Error('Retrieval exclusion backup is invalid');
        for (const pattern of data.patterns) validateExclusion(pattern);
        return data;
      },
    });
  }

  async #withLock(operation, signal) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 10_000;
    let handle;
    while (!handle && Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason || Object.assign(new Error('Semantic search cancelled'), { code: 'CANCELLED' });
      try {
        handle = await fs.open(this.lock, 'wx', 0o600);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await abortableDelay(40, signal);
      }
    }
    if (!handle)
      throw Object.assign(
        new Error('Timed out waiting for semantic index lock; inspect .agent/retrieval/index.lock before manual recovery'),
        { code: 'INDEX_LOCKED' },
      );
    const lockRecord = JSON.stringify({ lock_id: randomUUID(), pid: process.pid, created_at: new Date().toISOString() });
    let lockIdentity;
    try {
      lockIdentity = await handle.stat();
      await handle.writeFile(lockRecord);
      return await operation();
    } finally {
      await handle.close().catch(() => {});
      if (lockIdentity) {
        const current = await fs.lstat(this.lock).catch(() => null);
        const stableIdentity = Number.isFinite(lockIdentity.ino) && lockIdentity.ino !== 0;
        if (
          current?.isFile() &&
          !current.isSymbolicLink() &&
          (!stableIdentity || (current.dev === lockIdentity.dev && current.ino === lockIdentity.ino))
        ) {
          const currentRecord = await fs.readFile(this.lock, 'utf8').catch(() => null);
          if (currentRecord === lockRecord) await fs.rm(this.lock, { force: true }).catch(() => {});
        }
      }
    }
  }
}

export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || left.length === 0)
    throw new TypeError('Vectors must have equal non-zero dimensions');
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm);
}

async function readWorkspaceDocuments(
  root,
  { filesystem = fs, maxFiles, maxFileBytes, maxDirectories, maxEntries, maxBytes = MAX_SCAN_BYTES, signal, documentCache = null },
) {
  const ignored = await readIgnoreRules(root);
  const realRoot = await filesystem.realpath(root);
  const pending = [root];
  const result = [];
  const nextCache = new Map();
  let scanned = 0;
  let directoriesScanned = 0;
  let scannedEntries = 0;
  let bytesRead = 0;
  let truncated = false;
  let stopScan = false;
  while (pending.length && scanned < maxFiles && directoriesScanned < maxDirectories && !stopScan) {
    if (signal?.aborted) throw signal.reason || Object.assign(new Error('Semantic search cancelled'), { code: 'CANCELLED' });
    const directory = pending.shift();
    directoriesScanned += 1;
    let entries;
    try {
      const directoryBefore = await filesystem.lstat(directory, { bigint: true });
      const realDirectory = await filesystem.realpath(directory);
      if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink() || !isPathInside(realRoot, realDirectory)) continue;
      const openedDirectory = await filesystem.opendir(directory);
      entries = [];
      try {
        for await (const entry of openedDirectory) {
          if (scannedEntries >= maxEntries) {
            truncated = true;
            stopScan = true;
            break;
          }
          scannedEntries += 1;
          entries.push(entry);
        }
      } finally {
        await openedDirectory.close().catch(() => {});
      }
      const directoryAfter = await filesystem.lstat(directory, { bigint: true });
      const realDirectoryAfterRead = await filesystem.realpath(directory);
      if (
        !sameFileSnapshot(directoryBefore, directoryAfter) ||
        !directoryAfter.isDirectory() ||
        directoryAfter.isSymbolicLink() ||
        !isPathInside(realRoot, realDirectoryAfterRead)
      )
        continue;
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
      const entry = entries[entryIndex];
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replaceAll('\\', '/');
      if (isSensitivePath(relative) || isIgnoredPath(relative)) continue;
      if (ignored(relative, entry.isDirectory())) continue;
      if (entry.isDirectory()) {
        if (directoriesScanned + pending.length >= maxDirectories) {
          truncated = true;
          continue;
        }
        pending.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      scanned += 1;
      let stat;
      let content;
      let sha256;
      let handle;
      try {
        stat = await filesystem.lstat(absolute, { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BigInt(maxFileBytes)) continue;
        const realFile = await filesystem.realpath(absolute);
        if (!isPathInside(realRoot, realFile)) continue;
        if (bytesRead + Number(stat.size) > maxBytes) {
          truncated = true;
          stopScan = true;
          break;
        }
        const cached = documentCache?.get(relative);
        if (cached && sameFileSnapshot(stat, cached.snapshot)) {
          content = cached.content;
          sha256 = cached.sha256;
        } else {
          handle = await filesystem.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
          const opened = await handle.stat({ bigint: true });
          if (!sameFileSnapshot(stat, opened) || !opened.isFile()) continue;
          content = await readBoundedWorkspaceFile(handle, maxFileBytes);
          if (content === null) continue;
          const afterRead = await handle.stat({ bigint: true });
          const currentPath = await filesystem.lstat(absolute, { bigint: true });
          const currentRealFile = await filesystem.realpath(absolute);
          if (
            !sameFileSnapshot(opened, afterRead) ||
            !sameFileSnapshot(opened, currentPath) ||
            !currentPath.isFile() ||
            currentPath.isSymbolicLink() ||
            !isPathInside(realRoot, currentRealFile)
          )
            continue;
          sha256 = createHash('sha256').update(content).digest('hex');
        }
      } catch {
        continue;
      } finally {
        await handle?.close().catch(() => {});
      }
      if (content.includes('\u0000')) continue;
      bytesRead += Number(stat.size);
      result.push({ path: relative, content, sha256, modified_at: stat.mtime.toISOString() });
      nextCache.set(relative, {
        snapshot: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs },
        content,
        sha256,
      });
      if (scanned >= maxFiles) {
        truncated = entryIndex < entries.length - 1 || pending.length > 0;
        break;
      }
    }
    if (stopScan) break;
  }
  if (pending.length) truncated = true;
  return { documents: result, truncated, documentCache: nextCache };
}

function sameFileSnapshot(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

async function readBoundedWorkspaceFile(handle, maxBytes) {
  const chunks = [];
  let bytesRead = 0;
  while (bytesRead <= maxBytes) {
    const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - bytesRead));
    const { bytesRead: count } = await handle.read(buffer, 0, buffer.length, bytesRead);
    if (!count) break;
    bytesRead += count;
    if (bytesRead > maxBytes) return null;
    chunks.push(buffer.subarray(0, count));
  }
  return Buffer.concat(chunks, bytesRead).toString('utf8');
}

async function readIgnoreRules(root) {
  const rules = [];
  for (const sourcePath of [path.join(root, '.gitignore'), path.join(root, '.agent', 'retrieval', 'excludes.json')]) {
    try {
      if (sourcePath.endsWith('excludes.json')) {
        const metadata = await fs.lstat(sourcePath);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 32 * 1024)
          throw new Error('Retrieval exclusions are not a bounded regular file');
      }
      let source = await readWorkspaceRuleFile(root, sourcePath, {
        maxBytes: sourcePath.endsWith('excludes.json') ? 32 * 1024 : 1024 * 1024,
      });
      if (source === null) continue;
      if (sourcePath.endsWith('excludes.json')) {
        const data = JSON.parse(source);
        if (
          data.version !== 1 ||
          !Array.isArray(data.patterns) ||
          data.patterns.length > 100 ||
          data.patterns.some((pattern) => {
            try {
              validateExclusion(pattern);
              return false;
            } catch {
              return true;
            }
          })
        )
          throw new Error('Retrieval exclusions file is invalid');
        source = data.patterns.join('\n');
      } else assertGitignoreLineLimit(source);
      for (let line of source.split(/\r?\n/)) {
        line = line.trim();
        if (!line || line.startsWith('#')) continue;
        const negated = line.startsWith('!');
        if (negated) line = line.slice(1);
        const directoryOnly = line.endsWith('/');
        line = line.replace(/^\//, '').replace(/\/$/, '');
        rules.push({ negated, regex: globRegex(line, { basename: !line.includes('/'), directoryOnly }) });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return (relative, isDirectory) => {
    let result = false;
    for (const rule of rules) if (rule.regex.test(relative) || (isDirectory && rule.regex.test(`${relative}/`))) result = !rule.negated;
    return result;
  };
}

function validateExclusion(pattern) {
  if (
    typeof pattern !== 'string' ||
    !pattern.trim() ||
    pattern.length > 256 ||
    pattern !== pattern.trim() ||
    pattern.startsWith('!') ||
    pattern.startsWith('/') ||
    pattern.includes('\\') ||
    pattern.split('/').some((part) => part === '..' || part === '.')
  )
    throw new TypeError('Exclusion must be a relative workspace glob of 1 to 256 characters without traversal or negation');
  return pattern;
}

function makeChunks(content) {
  const lines = content.split(/\r?\n/);
  const chunks = [];
  let text = '';
  let startLine = 1;
  let lineIndex = 0;
  for (const line of lines) {
    const safe = redactSecrets(line);
    const addition = `${safe}\n`;
    if (text && text.length + addition.length > CHUNK_CHARS) {
      chunks.push({ text: text.trim(), start_line: startLine, end_line: lineIndex });
      const carry = text.slice(-OVERLAP_CHARS);
      const carryLines = (carry.match(/\n/g) || []).length;
      text = carry;
      startLine = Math.max(1, lineIndex - carryLines + 1);
    }
    text += addition;
    lineIndex += 1;
  }
  if (text.trim()) chunks.push({ text: text.trim(), start_line: startLine, end_line: Math.max(startLine, lineIndex) });
  return chunks.filter((chunk) => chunk.text);
}

function excerptLines(content, start, end) {
  return redactSecrets(
    content
      .split(/\r?\n/)
      .slice(start - 1, end)
      .join('\n'),
  ).slice(0, 3_000);
}
function validateVector(vector, dimensions) {
  if (
    !Array.isArray(vector) ||
    vector.length < 1 ||
    vector.length > 8192 ||
    (dimensions && vector.length !== dimensions) ||
    vector.some((value) => !Number.isFinite(value))
  )
    throw Object.assign(new Error('Embedding vector has invalid dimensions or values'), { code: 'INVALID_RESPONSE' });
  return vector;
}
function emptyState(model) {
  return { version: VERSION, model, dimensions: null, identity: null, entries: [] };
}
function isIgnoredPath(relative) {
  return relative.split('/').some((part) => IGNORED.has(part));
}
function globRegex(glob, { basename = false, directoryOnly = false } = {}) {
  let expression = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') {
      index += 1;
      if (glob[index + 1] === '/') {
        index += 1;
        expression += '(?:.*/)?';
      } else expression += '.*';
    } else if (char === '*') expression += '[^/]*';
    else if (char === '?') expression += '[^/]';
    else expression += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`${basename ? '(?:^|.*/)' : '^'}${expression}${directoryOnly ? '(?:/.*)?$' : '$'}`, 'i');
}
function abortableDelay(ms, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(signal.reason || new Error('Operation cancelled'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(resolve), ms);
    const onAbort = () => finish(reject, signal.reason || new Error('Operation cancelled'));
    const finish = (callback, value) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
