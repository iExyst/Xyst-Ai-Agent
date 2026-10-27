export const MEMORY_PROVENANCE_ACTORS = Object.freeze(['agent', 'import', 'unknown', 'user']);

export class VersionedSchemaRegistry {
  #schemas = new Map();

  constructor(definitions = []) {
    for (const definition of definitions) this.register(definition);
  }

  register({
    name,
    versionField = 'schema_version',
    currentVersion,
    migrations = {},
    invalidVersionCode,
    unsupportedVersionCode,
    migrationFailedCode,
  }) {
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(name)) throw new TypeError('Schema name is invalid');
    if (this.#schemas.has(name)) throw new TypeError(`Schema '${name}' is already registered`);
    if (typeof versionField !== 'string' || !/^[a-z][a-z0-9_]*$/.test(versionField))
      throw new TypeError(`Version field for '${name}' is invalid`);
    if (!Number.isSafeInteger(currentVersion) || currentVersion < 1) throw new TypeError(`Current version for '${name}' is invalid`);

    const entries =
      migrations instanceof Map ? [...migrations] : Object.entries(migrations).map(([version, migrate]) => [Number(version), migrate]);
    const migrationMap = new Map();
    for (const [fromVersion, migrate] of entries) {
      if (!Number.isSafeInteger(fromVersion) || fromVersion < 1 || fromVersion >= currentVersion || typeof migrate !== 'function')
        throw new TypeError(`Migration for '${name}' from version ${fromVersion} is invalid`);
      if (migrationMap.has(fromVersion)) throw new TypeError(`Migration for '${name}' from version ${fromVersion} is duplicated`);
      migrationMap.set(fromVersion, migrate);
    }
    for (let version = 1; version < currentVersion; version += 1)
      if (!migrationMap.has(version)) throw new TypeError(`Schema '${name}' has no migration from version ${version}`);

    this.#schemas.set(
      name,
      Object.freeze({
        name,
        versionField,
        currentVersion,
        migrations: migrationMap,
        invalidVersionCode: invalidVersionCode || `INVALID_${name.toUpperCase()}_SCHEMA_VERSION`,
        unsupportedVersionCode: unsupportedVersionCode || `UNSUPPORTED_${name.toUpperCase()}_SCHEMA_VERSION`,
        migrationFailedCode: migrationFailedCode || `${name.toUpperCase()}_MIGRATION_FAILED`,
      }),
    );
    return this;
  }

  currentVersion(name) {
    return this.#definition(name).currentVersion;
  }

  assertVersion(name, version) {
    const definition = this.#definition(name);
    if (!Number.isSafeInteger(version) || version < 1)
      throw Object.assign(new Error(`${definition.name} schema version is invalid`), { code: definition.invalidVersionCode });
    if (version > definition.currentVersion)
      throw Object.assign(
        new Error(
          `Unsupported newer ${definition.name.replaceAll('_', ' ')} schema version ${version}; this build supports version ${definition.currentVersion}`,
        ),
        { code: definition.unsupportedVersionCode },
      );
    return version;
  }

  migrate(name, input) {
    const definition = this.#definition(name);
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw Object.assign(new Error(`${definition.name.replaceAll('_', ' ')} record is invalid`), { code: definition.invalidVersionCode });
    const initialVersion = this.assertVersion(name, input[definition.versionField]);
    if (initialVersion === definition.currentVersion) return { record: input, migrated: false, fromVersion: initialVersion };

    let record = structuredClone(input);
    let version = initialVersion;
    while (version < definition.currentVersion) {
      let next;
      try {
        next = definition.migrations.get(version)(record);
      } catch (cause) {
        throw Object.assign(new Error(`Could not migrate ${definition.name.replaceAll('_', ' ')} schema from version ${version}`), {
          code: definition.migrationFailedCode,
          cause,
        });
      }
      if (!next || typeof next !== 'object' || Array.isArray(next) || next[definition.versionField] !== version + 1)
        throw Object.assign(
          new Error(`Migration for ${definition.name.replaceAll('_', ' ')} schema version ${version} returned an invalid record`),
          {
            code: definition.migrationFailedCode,
          },
        );
      record = next;
      version += 1;
    }
    return { record, migrated: true, fromVersion: initialVersion };
  }

  #definition(name) {
    const definition = this.#schemas.get(name);
    if (!definition) throw new TypeError(`Schema '${name}' is not registered`);
    return definition;
  }
}

function migrateMemoryV1ToV2(memory) {
  if (!memory.sections || typeof memory.sections !== 'object' || Array.isArray(memory.sections))
    throw new TypeError('Memory sections are invalid');
  const upgraded = structuredClone(memory);
  for (const items of Object.values(upgraded.sections)) {
    if (!Array.isArray(items)) throw new TypeError('Memory section is invalid');
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('Memory item is invalid');
      const actor = memoryActorFromSource(item.source);
      if (item.created_by === undefined) item.created_by = actor;
      if (item.updated_at && item.updated_by === undefined) item.updated_by = 'unknown';
    }
  }
  upgraded.schema_version = 2;
  return upgraded;
}

function migrateMemoryExportV1ToV2(document) {
  if (!document.memory || typeof document.memory !== 'object' || Array.isArray(document.memory))
    throw new TypeError('Memory export data is invalid');
  const upgraded = structuredClone(document);
  upgraded.memory = migrateMemoryV1ToV2(upgraded.memory);
  upgraded.format_version = 2;
  return upgraded;
}

function memoryActorFromSource(source) {
  if (source === 'user') return 'user';
  if (source === 'import') return 'import';
  if (source === 'agent-proposal') return 'agent';
  return 'unknown';
}

export const PERSISTENCE_SCHEMA_REGISTRY = new VersionedSchemaRegistry([
  {
    name: 'session',
    currentVersion: 1,
    invalidVersionCode: 'INVALID_SESSION_SCHEMA_VERSION',
    unsupportedVersionCode: 'UNSUPPORTED_SESSION_SCHEMA_VERSION',
  },
  {
    name: 'session_export',
    versionField: 'format_version',
    currentVersion: 1,
    invalidVersionCode: 'INVALID_SESSION_EXPORT',
    unsupportedVersionCode: 'UNSUPPORTED_SESSION_EXPORT_VERSION',
  },
  {
    name: 'session_archive',
    currentVersion: 1,
    invalidVersionCode: 'INVALID_SESSION_ARCHIVE_SCHEMA_VERSION',
    unsupportedVersionCode: 'UNSUPPORTED_SESSION_ARCHIVE_SCHEMA_VERSION',
  },
  {
    name: 'memory',
    currentVersion: 2,
    invalidVersionCode: 'INVALID_MEMORY_SCHEMA_VERSION',
    unsupportedVersionCode: 'UNSUPPORTED_MEMORY_SCHEMA_VERSION',
    migrationFailedCode: 'MEMORY_MIGRATION_FAILED',
    migrations: { 1: migrateMemoryV1ToV2 },
  },
  {
    name: 'memory_export',
    versionField: 'format_version',
    currentVersion: 2,
    invalidVersionCode: 'INVALID_MEMORY_EXPORT',
    unsupportedVersionCode: 'UNSUPPORTED_MEMORY_EXPORT_VERSION',
    migrationFailedCode: 'MEMORY_EXPORT_MIGRATION_FAILED',
    migrations: { 1: migrateMemoryExportV1ToV2 },
  },
  {
    name: 'goals',
    currentVersion: 1,
    invalidVersionCode: 'INVALID_GOALS_SCHEMA_VERSION',
    unsupportedVersionCode: 'UNSUPPORTED_GOALS_SCHEMA_VERSION',
  },
  {
    name: 'goals_export',
    versionField: 'format_version',
    currentVersion: 1,
    invalidVersionCode: 'INVALID_GOALS_EXPORT',
    unsupportedVersionCode: 'UNSUPPORTED_GOALS_EXPORT_VERSION',
  },
]);
