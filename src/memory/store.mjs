import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { atomicWriteFile, atomicWriteJson } from '../platform/files.mjs';
import { redactSecrets } from '../platform/redaction.mjs';
import { MEMORY_PROVENANCE_ACTORS, PERSISTENCE_SCHEMA_REGISTRY } from '../persistence/schema-registry.mjs';

export const MEMORY_SECTIONS = Object.freeze([
  'conventions',
  'architecture_decisions',
  'user_preferences',
  'lessons_learned',
  'open_questions',
]);
export const MEMORY_SCHEMA_VERSION = 2;
export const MEMORY_EXPORT_VERSION = 2;
export const MAX_MEMORY_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_MEMORY_EXPORT_BYTES = MAX_MEMORY_FILE_BYTES + 64 * 1024;
export const MAX_MEMORY_ITEM_CHARS = 10_000;
const MAX_MEMORY_ITEMS = 1_000;

export class MemoryStore {
  constructor(workspaceRoot, { lockWaitMs = 2_000, writeJson = atomicWriteJson } = {}) {
    if (!Number.isInteger(lockWaitMs) || lockWaitMs < 0 || lockWaitMs > 30_000)
      throw new TypeError('lockWaitMs must be between 0 and 30000');
    if (typeof writeJson !== 'function') throw new TypeError('writeJson must be a function');
    this.filePath = path.join(workspaceRoot, '.agent', 'memory.json');
    this.lockPath = path.join(workspaceRoot, '.agent', 'memory.lock');
    this.memoryFilename = 'memory.json';
    this.lockFilename = 'memory.lock';
    this.scopeLabel = 'Project memory';
    this.rootLabel = 'workspace';
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.lockWaitMs = lockWaitMs;
    this.writeJson = writeJson;
  }

  async read() {
    const snapshot = await this.#readSnapshot();
    if (!snapshot) return createMemory();
    const migration = PERSISTENCE_SCHEMA_REGISTRY.migrate('memory', snapshot.memory);
    validateMemory(migration.record);
    if (!migration.migrated) return migration.record;
    return this.#withLock(() => this.#readUnlocked());
  }

  async exportMemory() {
    const memory = await this.read();
    const document = {
      format: 'xyst-memory',
      format_version: MEMORY_EXPORT_VERSION,
      exported_at: new Date().toISOString(),
      memory: {
        schema_version: MEMORY_SCHEMA_VERSION,
        updated_at: memory.updated_at,
        sections: Object.fromEntries(
          MEMORY_SECTIONS.map((section) => [
            section,
            memory.sections[section].map((item) => ({
              id: item.id,
              text: redactSecrets(item.text),
              source: redactSecrets(item.source || 'unknown'),
              created_by: item.created_by,
              created_at: item.created_at,
              ...(item.updated_by ? { updated_by: item.updated_by } : {}),
              ...(item.updated_at ? { updated_at: item.updated_at } : {}),
            })),
          ]),
        ),
      },
    };
    if (Buffer.byteLength(`${JSON.stringify(document, null, 2)}\n`, 'utf8') > MAX_MEMORY_EXPORT_BYTES)
      throw Object.assign(new Error(`Project memory export exceeds ${MAX_MEMORY_EXPORT_BYTES} bytes`), { code: 'MEMORY_EXPORT_TOO_LARGE' });
    return document;
  }

  async importMemory(document) {
    if (!document || typeof document !== 'object' || Array.isArray(document) || document.format !== 'xyst-memory')
      throw Object.assign(new Error('Project memory export format is invalid'), { code: 'INVALID_MEMORY_EXPORT' });
    document = PERSISTENCE_SCHEMA_REGISTRY.migrate('memory_export', document).record;
    if (Buffer.byteLength(JSON.stringify(document), 'utf8') > MAX_MEMORY_EXPORT_BYTES)
      throw Object.assign(new Error(`Project memory export exceeds ${MAX_MEMORY_EXPORT_BYTES} bytes`), { code: 'MEMORY_EXPORT_TOO_LARGE' });
    if (!document.memory || typeof document.memory !== 'object' || Array.isArray(document.memory))
      throw Object.assign(new Error('Project memory export data is invalid'), { code: 'INVALID_MEMORY_EXPORT' });
    document = { ...document, memory: PERSISTENCE_SCHEMA_REGISTRY.migrate('memory', document.memory).record };
    if (Buffer.byteLength(JSON.stringify(document), 'utf8') > MAX_MEMORY_EXPORT_BYTES)
      throw Object.assign(new Error(`Project memory export exceeds ${MAX_MEMORY_EXPORT_BYTES} bytes`), { code: 'MEMORY_EXPORT_TOO_LARGE' });
    assertSupportedMemoryVersion(document.memory.schema_version);
    try {
      validateMemory(document.memory);
    } catch (error) {
      if (error.code === 'MEMORY_LIMIT') throw error;
      throw Object.assign(new Error('Project memory export contains invalid data'), { code: 'INVALID_MEMORY_EXPORT', cause: error });
    }
    if (
      document.exported_at !== undefined &&
      (typeof document.exported_at !== 'string' || !Number.isFinite(Date.parse(document.exported_at)))
    )
      throw Object.assign(new Error('Project memory export timestamp is invalid'), { code: 'INVALID_MEMORY_EXPORT' });

    return this.#withLock(async () => {
      const memory = await this.#readUnlocked();
      const known = new Set(MEMORY_SECTIONS.flatMap((section) => memory.sections[section].map((item) => `${section}\0${item.text}`)));
      const imported = [];
      let skippedDuplicates = 0;
      const now = new Date().toISOString();
      for (const section of MEMORY_SECTIONS) {
        for (const sourceItem of document.memory.sections[section]) {
          const text = redactSecrets(sourceItem.text.trim());
          const key = `${section}\0${text}`;
          if (known.has(key)) {
            skippedDuplicates += 1;
            continue;
          }
          known.add(key);
          imported.push({
            section,
            item: {
              id: randomUUID(),
              text,
              source: 'import',
              created_by: 'import',
              created_at: sourceItem.created_at,
              ...(sourceItem.updated_at ? { updated_by: 'import' } : {}),
              ...(sourceItem.updated_at ? { updated_at: sourceItem.updated_at } : {}),
            },
          });
        }
      }
      const currentCount = Object.values(memory.sections).reduce((count, items) => count + items.length, 0);
      if (currentCount + imported.length > MAX_MEMORY_ITEMS)
        throw Object.assign(new Error(`${this.scopeLabel} import would exceed ${MAX_MEMORY_ITEMS} items`), { code: 'MEMORY_LIMIT' });
      for (const { section, item } of imported) memory.sections[section].push(item);
      if (imported.length) memory.updated_at = now;
      await this.#save(memory);
      return { imported: imported.length, skipped_duplicates: skippedDuplicates, updated_at: memory.updated_at };
    });
  }

  async append(section, text, { source = 'agent-proposal' } = {}) {
    assertSection(section);
    if (typeof text !== 'string' || !text.trim() || text.trim().length > MAX_MEMORY_ITEM_CHARS)
      throw new TypeError(`Memory text must contain 1 to ${MAX_MEMORY_ITEM_CHARS} characters`);
    if (typeof source !== 'string' || source.length > 128) throw new TypeError('Memory source must be a string of at most 128 characters');
    const safeText = redactSecrets(text.trim());
    return this.#withLock(async () => {
      const memory = await this.#readUnlocked();
      if (Object.values(memory.sections).reduce((count, items) => count + items.length, 0) >= MAX_MEMORY_ITEMS)
        throw Object.assign(new Error(`${this.scopeLabel} cannot contain more than ${MAX_MEMORY_ITEMS} items`), { code: 'MEMORY_LIMIT' });
      const now = new Date().toISOString();
      const item = { id: randomUUID(), text: safeText, source, created_by: memoryActorFromSource(source), created_at: now };
      memory.sections[section].push(item);
      memory.updated_at = now;
      await this.#save(memory);
      return item;
    });
  }

  async update(section, id, text) {
    assertSection(section);
    const safeText = redactSecrets(String(text).trim());
    if (!safeText || safeText.length > MAX_MEMORY_ITEM_CHARS)
      throw new TypeError(`Memory text must contain 1 to ${MAX_MEMORY_ITEM_CHARS} characters`);
    return this.#withLock(async () => {
      const memory = await this.#readUnlocked();
      const item = memory.sections[section].find((entry) => entry.id === id);
      if (!item) throw Object.assign(new Error(`Memory item '${id}' was not found`), { code: 'NOT_FOUND' });
      item.text = safeText;
      item.updated_at = new Date().toISOString();
      item.updated_by = 'user';
      memory.updated_at = item.updated_at;
      await this.#save(memory);
      return item;
    });
  }

  async delete(section, id) {
    assertSection(section);
    return this.#withLock(async () => {
      const memory = await this.#readUnlocked();
      const before = memory.sections[section].length;
      memory.sections[section] = memory.sections[section].filter((entry) => entry.id !== id);
      if (memory.sections[section].length === before) return false;
      memory.updated_at = new Date().toISOString();
      await this.#save(memory);
      return true;
    });
  }

  /** Copy validated global-memory records into another user data directory
   * without removing the source. Repeated migrations are idempotent, while
   * conflicting record IDs fail closed instead of overwriting either copy.
   */
  async migrateTo(userDataDirectory) {
    if (this.memoryFilename !== 'global-memory.json') throw new TypeError('Only global memory can be migrated');
    const destination = new GlobalMemoryStore(userDataDirectory, { lockWaitMs: this.lockWaitMs });
    const sourcePaths = await this.#memoryPaths(false);
    if (!sourcePaths) return { copied: 0, already_present: 0 };
    try {
      const info = await fs.lstat(sourcePaths.filePath);
      if (info.isSymbolicLink() || !info.isFile())
        throw Object.assign(new Error('Global memory must be a regular non-symbolic-link file'), { code: 'MEMORY_PATH_UNSAFE' });
    } catch (error) {
      if (error.code === 'ENOENT') return { copied: 0, already_present: 0 };
      throw error;
    }

    const destinationPaths = await destination.#memoryPaths(false);
    const sourceFile = path.resolve(sourcePaths.filePath);
    const destinationFile = path.resolve(
      destinationPaths?.filePath || path.join(destination.workspaceRoot, '.agent', destination.memoryFilename),
    );
    if (sameMemoryPath(sourceFile, destinationFile)) return { copied: 0, already_present: 0 };

    const stores = [this, destination].sort((left, right) => memoryPathKey(left.lockPath).localeCompare(memoryPathKey(right.lockPath)));
    return stores[0].#withLock(() =>
      stores[1].#withLock(async () => {
        const source = await this.#readUnlocked();
        const target = await destination.#readUnlocked();
        let copied = 0;
        let alreadyPresent = 0;
        for (const section of MEMORY_SECTIONS) {
          const targetById = new Map(target.sections[section].map((item) => [item.id, item]));
          const sourceIds = new Set();
          for (const sourceItem of source.sections[section]) {
            if (sourceIds.has(sourceItem.id))
              throw Object.assign(new Error(`Global memory migration found duplicate source record '${sourceItem.id}' in '${section}'`), {
                code: 'GLOBAL_MEMORY_MIGRATION_CONFLICT',
              });
            sourceIds.add(sourceItem.id);
            const existing = targetById.get(sourceItem.id);
            if (existing) {
              if (!sameMemoryItem(existing, sourceItem))
                throw Object.assign(new Error(`Global memory migration found conflicting record '${sourceItem.id}' in '${section}'`), {
                  code: 'GLOBAL_MEMORY_MIGRATION_CONFLICT',
                });
              alreadyPresent += 1;
              continue;
            }
            const item = { ...sourceItem };
            target.sections[section].push(item);
            targetById.set(item.id, item);
            copied += 1;
          }
        }
        if (copied === 0) return { copied, already_present: alreadyPresent };
        const itemCount = Object.values(target.sections).reduce((count, items) => count + items.length, 0);
        if (itemCount > MAX_MEMORY_ITEMS)
          throw Object.assign(new Error(`Global memory migration would exceed ${MAX_MEMORY_ITEMS} items`), { code: 'MEMORY_LIMIT' });
        if (Date.parse(source.updated_at) > Date.parse(target.updated_at)) target.updated_at = source.updated_at;
        await destination.#save(target);
        return { copied, already_present: alreadyPresent };
      }),
    );
  }

  async #withLock(operation) {
    const paths = await this.#memoryPaths(true);
    const deadline = Date.now() + this.lockWaitMs;
    let handle;
    while (!handle) {
      try {
        handle = await fs.open(paths.lockPath, 'wx', 0o600);
      } catch (error) {
        const contention = error.code === 'EEXIST' || (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code));
        if (!contention) throw error;
        if (Date.now() >= deadline) {
          try {
            await fs.lstat(paths.lockPath);
          } catch (inspectError) {
            if (inspectError.code === 'ENOENT') {
              if (error.code === 'EEXIST') continue;
              throw error;
            }
          }
          throw Object.assign(
            new Error(
              `${this.scopeLabel} is locked at ${paths.lockPath}. If its writer crashed, verify it is no longer running before removing the lock.`,
            ),
            { code: 'MEMORY_LOCKED' },
          );
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(20, Math.max(1, deadline - Date.now()))));
      }
    }
    let lockIdentity;
    const lockRecord = JSON.stringify({
      lock_id: randomUUID(),
      pid: process.pid,
      hostname: os.hostname(),
      started_at: new Date().toISOString(),
    });
    try {
      lockIdentity = await handle.stat();
      await handle.writeFile(lockRecord);
      return await operation();
    } finally {
      await handle.close().catch(() => {});
      if (lockIdentity && Number.isFinite(lockIdentity.ino) && lockIdentity.ino !== 0) {
        const current = await fs.lstat(paths.lockPath).catch(() => null);
        if (current && current.dev === lockIdentity.dev && current.ino === lockIdentity.ino) {
          const currentRecord = await fs.readFile(paths.lockPath, 'utf8').catch(() => null);
          if (currentRecord === lockRecord) await fs.rm(paths.lockPath, { force: true }).catch(() => {});
        }
      }
    }
  }

  async #save(memory) {
    const paths = await this.#memoryPaths(true);
    if (Buffer.byteLength(`${JSON.stringify(memory, null, 2)}\n`, 'utf8') > MAX_MEMORY_FILE_BYTES)
      throw Object.assign(new Error(`${this.scopeLabel} exceeds the ${MAX_MEMORY_FILE_BYTES}-byte file limit`), { code: 'MEMORY_LIMIT' });
    await this.writeJson(paths.filePath, memory, { mode: 0o600 });
  }

  async #readSnapshot() {
    const paths = await this.#memoryPaths(false);
    if (!paths) return null;
    try {
      const serialized = await readBoundedMemoryFile(paths.filePath);
      return { paths, serialized, memory: JSON.parse(serialized) };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async #readUnlocked() {
    const snapshot = await this.#readSnapshot();
    if (!snapshot) return createMemory();
    const migration = PERSISTENCE_SCHEMA_REGISTRY.migrate('memory', snapshot.memory);
    validateMemory(migration.record);
    if (!migration.migrated) return migration.record;

    const backupPath = `${snapshot.paths.filePath}.schema-v${migration.fromVersion}.bak`;
    await createVerifiedMigrationBackup(backupPath, snapshot.serialized);
    try {
      await this.#save(migration.record);
    } catch (error) {
      const current = await readBoundedMemoryFile(snapshot.paths.filePath).catch((readError) => {
        if (readError.code !== 'ENOENT') throw readError;
        return null;
      });
      if (current !== snapshot.serialized) {
        try {
          await atomicWriteFile(snapshot.paths.filePath, snapshot.serialized, { mode: 0o600 });
        } catch (restoreError) {
          error.restoreError = restoreError;
        }
      }
      throw error;
    }
    return migration.record;
  }

  async #memoryPaths(create) {
    if (create && this.createRoot) await fs.mkdir(this.workspaceRoot, { recursive: true, mode: 0o700 });
    let root;
    try {
      root = await fs.realpath(this.workspaceRoot);
    } catch (error) {
      if (!create && error.code === 'ENOENT') return null;
      throw error;
    }
    const directory = path.join(root, '.agent');
    if (create)
      await fs.mkdir(directory, { mode: 0o700 }).catch((error) => {
        if (error.code !== 'EEXIST') throw error;
      });
    let info;
    try {
      info = await fs.lstat(directory);
    } catch (error) {
      if (!create && error.code === 'ENOENT') return null;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory())
      throw Object.assign(new Error(`${this.scopeLabel} directory must be a real directory inside the ${this.rootLabel}`), {
        code: 'MEMORY_PATH_UNSAFE',
      });
    const actual = await fs.realpath(directory);
    const samePath = process.platform === 'win32' ? actual.toLowerCase() === directory.toLowerCase() : actual === directory;
    if (!samePath)
      throw Object.assign(new Error(`${this.scopeLabel} directory resolves outside the ${this.rootLabel}`), { code: 'MEMORY_PATH_UNSAFE' });
    return { filePath: path.join(actual, this.memoryFilename), lockPath: path.join(actual, this.lockFilename) };
  }
}

/** Same validated/locked format as project memory, stored under the user data root. */
export class GlobalMemoryStore extends MemoryStore {
  constructor(userDataDirectory, options = {}) {
    super(userDataDirectory, options);
    this.memoryFilename = 'global-memory.json';
    this.lockFilename = 'global-memory.lock';
    this.createRoot = true;
    this.filePath = path.join(userDataDirectory, '.agent', this.memoryFilename);
    this.lockPath = path.join(userDataDirectory, '.agent', this.lockFilename);
    this.scopeLabel = 'Global memory';
    this.rootLabel = 'user data directory';
  }
}

function sameMemoryPath(left, right) {
  return memoryPathKey(left) === memoryPathKey(right);
}

function memoryPathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sameMemoryItem(left, right) {
  return (
    left.id === right.id &&
    left.text === right.text &&
    left.source === right.source &&
    left.created_by === right.created_by &&
    left.created_at === right.created_at &&
    left.updated_by === right.updated_by &&
    left.updated_at === right.updated_at
  );
}

async function createVerifiedMigrationBackup(backupPath, originalContent) {
  let handle;
  let identity;
  let created = false;
  try {
    handle = await fs.open(backupPath, 'wx', 0o600);
    created = true;
    identity = await handle.stat();
    await handle.writeFile(originalContent, 'utf8');
    await handle.sync();
  } catch (error) {
    if (error.code !== 'EEXIST') {
      await handle?.close().catch(() => {});
      if (created && identity) {
        const current = await fs.lstat(backupPath).catch(() => null);
        if (current && current.dev === identity.dev && current.ino === identity.ino)
          await fs.rm(backupPath, { force: true }).catch(() => {});
      }
      throw error;
    }
    const existing = await readBoundedMemoryFile(backupPath);
    if (existing !== originalContent)
      throw Object.assign(new Error('Existing memory schema backup does not match the source record'), {
        code: 'MEMORY_MIGRATION_BACKUP_CONFLICT',
      });
  } finally {
    await handle?.close().catch(() => {});
  }
  const backup = await readBoundedMemoryFile(backupPath);
  if (backup !== originalContent)
    throw Object.assign(new Error('Memory schema backup verification failed'), { code: 'MEMORY_MIGRATION_BACKUP_INVALID' });
}

function memoryActorFromSource(source) {
  if (source === 'user') return 'user';
  if (source === 'import') return 'import';
  if (source === 'agent-proposal') return 'agent';
  return 'unknown';
}

async function readBoundedMemoryFile(filePath) {
  const initial = await fs.lstat(filePath);
  if (initial.isSymbolicLink() || !initial.isFile()) throw new Error('Memory must be a regular non-symbolic-link file');
  if (initial.size > MAX_MEMORY_FILE_BYTES)
    throw Object.assign(new Error(`Memory exceeds the ${MAX_MEMORY_FILE_BYTES}-byte file limit`), { code: 'MEMORY_LIMIT' });

  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const handle = await fs.open(filePath, flags);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Memory must be a regular file');
    if (info.dev !== initial.dev || info.ino !== initial.ino || info.size !== initial.size)
      throw Object.assign(new Error('Memory changed while it was being opened'), { code: 'MEMORY_PATH_UNSAFE' });
    if (info.size > MAX_MEMORY_FILE_BYTES)
      throw Object.assign(new Error(`Memory exceeds the ${MAX_MEMORY_FILE_BYTES}-byte file limit`), { code: 'MEMORY_LIMIT' });

    const buffer = Buffer.allocUnsafe(initial.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== initial.size) throw Object.assign(new Error('Memory changed while it was being read'), { code: 'MEMORY_CHANGED' });
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
  } finally {
    await handle.close();
  }
}

function createMemory() {
  return {
    schema_version: MEMORY_SCHEMA_VERSION,
    updated_at: new Date().toISOString(),
    sections: Object.fromEntries(MEMORY_SECTIONS.map((name) => [name, []])),
  };
}
function assertSection(section) {
  if (!MEMORY_SECTIONS.includes(section)) throw new TypeError(`Unknown memory section '${section}'`);
}
function validateMemory(memory) {
  PERSISTENCE_SCHEMA_REGISTRY.assertVersion('memory', memory?.schema_version);
  if (memory.schema_version !== MEMORY_SCHEMA_VERSION || !memory.sections || typeof memory.sections !== 'object')
    throw new Error('Memory file has an unsupported schema');
  if (memory.updated_at !== undefined && (typeof memory.updated_at !== 'string' || !Number.isFinite(Date.parse(memory.updated_at))))
    throw new Error('Memory updated_at timestamp is invalid');
  let itemCount = 0;
  for (const section of MEMORY_SECTIONS) {
    if (!Array.isArray(memory.sections[section])) throw new Error(`Memory section '${section}' is invalid`);
    itemCount += memory.sections[section].length;
    if (itemCount > MAX_MEMORY_ITEMS)
      throw Object.assign(new Error(`Project memory exceeds ${MAX_MEMORY_ITEMS} items`), { code: 'MEMORY_LIMIT' });
    for (const item of memory.sections[section]) {
      if (
        !item ||
        typeof item.id !== 'string' ||
        !item.id.trim() ||
        item.id.length > 128 ||
        typeof item.text !== 'string' ||
        !item.text.trim() ||
        item.text.length > MAX_MEMORY_ITEM_CHARS ||
        typeof item.created_at !== 'string' ||
        !Number.isFinite(Date.parse(item.created_at)) ||
        !MEMORY_PROVENANCE_ACTORS.includes(item.created_by) ||
        (item.updated_by !== undefined && !MEMORY_PROVENANCE_ACTORS.includes(item.updated_by)) ||
        (item.updated_at !== undefined && (typeof item.updated_at !== 'string' || !Number.isFinite(Date.parse(item.updated_at)))) ||
        (item.source !== undefined && (typeof item.source !== 'string' || item.source.length > 128))
      )
        throw new Error(`Memory item in '${section}' is invalid`);
    }
  }
}

function assertSupportedMemoryVersion(version) {
  if (!Number.isInteger(version) || version < 1)
    throw Object.assign(new Error('Project memory schema version is invalid'), { code: 'INVALID_MEMORY_EXPORT' });
  return PERSISTENCE_SCHEMA_REGISTRY.assertVersion('memory', version);
}
