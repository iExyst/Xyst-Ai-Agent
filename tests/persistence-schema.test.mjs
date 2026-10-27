import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MemoryStore, MEMORY_SCHEMA_VERSION } from '../src/memory/store.mjs';
import { PERSISTENCE_SCHEMA_REGISTRY, VersionedSchemaRegistry } from '../src/persistence/schema-registry.mjs';
import { SESSION_ARCHIVE_SCHEMA_VERSION, SESSION_EXPORT_VERSION, SESSION_SCHEMA_VERSION } from '../src/session/store.mjs';
import { GOALS_EXPORT_VERSION, GOALS_SCHEMA_VERSION, GoalStore } from '../src/goals/store.mjs';
import { createTempDirectory } from './helpers.mjs';

const memorySections = (conventions = []) => ({
  conventions,
  architecture_decisions: [],
  user_preferences: [],
  lessons_learned: [],
  open_questions: [],
});

function versionOneMemory(item = null) {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    updated_at: now,
    sections: memorySections(
      item
        ? [
            {
              id: 'legacy-item',
              text: 'Preserve this record',
              source: 'user',
              created_at: now,
              ...(item.updated_at ? { updated_at: item.updated_at } : {}),
            },
          ]
        : [],
    ),
  };
}

test('persistence schemas share a central version registry', () => {
  assert.equal(SESSION_SCHEMA_VERSION, PERSISTENCE_SCHEMA_REGISTRY.currentVersion('session'));
  assert.equal(SESSION_EXPORT_VERSION, PERSISTENCE_SCHEMA_REGISTRY.currentVersion('session_export'));
  assert.equal(SESSION_ARCHIVE_SCHEMA_VERSION, PERSISTENCE_SCHEMA_REGISTRY.currentVersion('session_archive'));
  assert.equal(MEMORY_SCHEMA_VERSION, PERSISTENCE_SCHEMA_REGISTRY.currentVersion('memory'));
  assert.equal(GOALS_SCHEMA_VERSION, PERSISTENCE_SCHEMA_REGISTRY.currentVersion('goals'));
  assert.equal(GOALS_EXPORT_VERSION, PERSISTENCE_SCHEMA_REGISTRY.currentVersion('goals_export'));
});

test('schema registry migrates each contiguous version without mutating its input', () => {
  const registry = new VersionedSchemaRegistry([
    {
      name: 'sample',
      currentVersion: 3,
      migrations: {
        1: (record) => ({ ...record, schema_version: 2, middle: true }),
        2: (record) => ({ ...record, schema_version: 3, complete: true }),
      },
    },
  ]);
  const original = { schema_version: 1, value: 42 };
  const result = registry.migrate('sample', original);

  assert.deepEqual(result, {
    record: { schema_version: 3, value: 42, middle: true, complete: true },
    migrated: true,
    fromVersion: 1,
  });
  assert.deepEqual(original, { schema_version: 1, value: 42 });
  assert.deepEqual(registry.migrate('sample', result.record), {
    record: result.record,
    migrated: false,
    fromVersion: 3,
  });
  assert.throws(() => registry.migrate('sample', { schema_version: 4 }), {
    code: 'UNSUPPORTED_SAMPLE_SCHEMA_VERSION',
  });
  assert.throws(() => registry.migrate('sample', null), { code: 'INVALID_SAMPLE_SCHEMA_VERSION' });
});

test('schema registry rejects missing migration links and migrations with incorrect version steps', () => {
  assert.throws(
    () => new VersionedSchemaRegistry([{ name: 'gap', currentVersion: 3, migrations: { 1: (record) => record } }]),
    /no migration from version 2/,
  );
  const registry = new VersionedSchemaRegistry([
    { name: 'broken', currentVersion: 2, migrations: { 1: (record) => ({ ...record, schema_version: 9 }) } },
  ]);
  assert.throws(() => registry.migrate('broken', { schema_version: 1 }), { code: 'BROKEN_MIGRATION_FAILED' });
});

test('memory v1 migration adds actor provenance while preserving record data', () => {
  const now = new Date().toISOString();
  const original = versionOneMemory({ updated_at: now });
  const result = PERSISTENCE_SCHEMA_REGISTRY.migrate('memory', original);

  assert.equal(result.migrated, true);
  assert.equal(result.fromVersion, 1);
  assert.equal(result.record.schema_version, 2);
  assert.deepEqual(result.record.sections.conventions[0], {
    id: 'legacy-item',
    text: 'Preserve this record',
    source: 'user',
    created_at: original.sections.conventions[0].created_at,
    updated_at: now,
    created_by: 'user',
    updated_by: 'unknown',
  });
  assert.equal(original.schema_version, 1);
  assert.equal('created_by' in original.sections.conventions[0], false);
});

test('memory store backs up and migrates v1 bytes exactly once', async (t) => {
  const root = await createTempDirectory('xyst-memory-schema-migrate-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new MemoryStore(root);
  await fs.mkdir(path.dirname(store.filePath), { recursive: true });
  const original = JSON.stringify(versionOneMemory());
  await fs.writeFile(store.filePath, original, 'utf8');

  const memory = await store.read();
  assert.equal(memory.schema_version, MEMORY_SCHEMA_VERSION);
  assert.equal(await fs.readFile(`${store.filePath}.schema-v1.bak`, 'utf8'), original);
  assert.equal(JSON.parse(await fs.readFile(store.filePath, 'utf8')).schema_version, MEMORY_SCHEMA_VERSION);
  assert.equal((await store.read()).schema_version, MEMORY_SCHEMA_VERSION);
  assert.equal(await fs.readFile(`${store.filePath}.schema-v1.bak`, 'utf8'), original);
});

test('failed memory migration restores the exact source and can be retried', async (t) => {
  const root = await createTempDirectory('xyst-memory-schema-rollback-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const normalStore = new MemoryStore(root);
  await fs.mkdir(path.dirname(normalStore.filePath), { recursive: true });
  const original = JSON.stringify(versionOneMemory());
  await fs.writeFile(normalStore.filePath, original, 'utf8');
  const failingStore = new MemoryStore(root, {
    writeJson: async (filePath) => {
      await fs.writeFile(filePath, '{"interrupted":', 'utf8');
      throw new Error('simulated interrupted migration write');
    },
  });

  await assert.rejects(failingStore.read(), /simulated interrupted migration write/);
  assert.equal(await fs.readFile(normalStore.filePath, 'utf8'), original);
  assert.equal(await fs.readFile(`${normalStore.filePath}.schema-v1.bak`, 'utf8'), original);
  assert.equal((await normalStore.read()).schema_version, MEMORY_SCHEMA_VERSION);
});

test('memory migration refuses a conflicting backup without altering the source', async (t) => {
  const root = await createTempDirectory('xyst-memory-schema-backup-conflict-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new MemoryStore(root);
  await fs.mkdir(path.dirname(store.filePath), { recursive: true });
  const original = JSON.stringify(versionOneMemory());
  await fs.writeFile(store.filePath, original, 'utf8');
  await fs.writeFile(`${store.filePath}.schema-v1.bak`, 'different backup', 'utf8');

  await assert.rejects(store.read(), { code: 'MEMORY_MIGRATION_BACKUP_CONFLICT' });
  assert.equal(await fs.readFile(store.filePath, 'utf8'), original);
  assert.equal(await fs.readFile(`${store.filePath}.schema-v1.bak`, 'utf8'), 'different backup');
});

test('memory future and malformed records fail before creating migration backups', async (t) => {
  const root = await createTempDirectory('xyst-memory-schema-invalid-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new MemoryStore(root);
  await fs.mkdir(path.dirname(store.filePath), { recursive: true });

  const future = JSON.stringify({ ...versionOneMemory(), schema_version: 99 });
  await fs.writeFile(store.filePath, future, 'utf8');
  await assert.rejects(store.read(), { code: 'UNSUPPORTED_MEMORY_SCHEMA_VERSION' });
  assert.equal(await fs.readFile(store.filePath, 'utf8'), future);
  await assert.rejects(fs.stat(`${store.filePath}.schema-v1.bak`), { code: 'ENOENT' });

  const malformed = JSON.stringify({ ...versionOneMemory(), sections: null });
  await fs.writeFile(store.filePath, malformed, 'utf8');
  await assert.rejects(store.read(), { code: 'MEMORY_MIGRATION_FAILED' });
  assert.equal(await fs.readFile(store.filePath, 'utf8'), malformed);
  await assert.rejects(fs.stat(`${store.filePath}.schema-v1.bak`), { code: 'ENOENT' });
});

test('memory import migrates v1 export and nested memory versions to current format', async (t) => {
  const root = await createTempDirectory('xyst-memory-export-v1-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new MemoryStore(root);
  const memory = versionOneMemory();
  memory.sections.conventions.push({
    id: 'exported-item',
    text: 'Portable memory',
    source: 'agent-proposal',
    created_at: new Date().toISOString(),
  });
  const result = await store.importMemory({
    format: 'xyst-memory',
    format_version: 1,
    exported_at: new Date().toISOString(),
    memory,
  });

  assert.equal(result.imported, 1);
  const [item] = (await store.read()).sections.conventions;
  assert.equal(item.text, 'Portable memory');
  assert.equal(item.source, 'import');
  assert.equal(item.created_by, 'import');
  const currentExport = await store.exportMemory();
  assert.equal(currentExport.format_version, 2);
  assert.equal(currentExport.memory.schema_version, MEMORY_SCHEMA_VERSION);
});

test('goal store rejects a future schema without rewriting it', async (t) => {
  const root = await createTempDirectory('xyst-goals-future-schema-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new GoalStore(root);
  await fs.mkdir(path.dirname(store.filePath), { recursive: true });
  const future = JSON.stringify({ schema_version: 99, goals: [{ id: 'future-record' }] });
  await fs.writeFile(store.filePath, future, 'utf8');

  await assert.rejects(store.list(), { code: 'UNSUPPORTED_GOALS_SCHEMA_VERSION' });
  assert.equal(await fs.readFile(store.filePath, 'utf8'), future);
});
