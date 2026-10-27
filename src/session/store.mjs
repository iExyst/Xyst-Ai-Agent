import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { atomicWriteJson } from '../platform/files.mjs';
import { MAX_SESSION_GRANTS } from '../tools/grants.mjs';
import { ToolAuditStore } from '../tools/audit.mjs';
import { redactSecrets, redactStructuredSecrets } from '../platform/redaction.mjs';
import { GoalStore, validateGoalsExport } from '../goals/store.mjs';
import { SESSION_STATUSES } from '../core/statuses.mjs';
import { PERSISTENCE_SCHEMA_REGISTRY } from '../persistence/schema-registry.mjs';

export const SESSION_SCHEMA_VERSION = PERSISTENCE_SCHEMA_REGISTRY.currentVersion('session');
export const SESSION_EXPORT_VERSION = PERSISTENCE_SCHEMA_REGISTRY.currentVersion('session_export');
export const SESSION_ARCHIVE_SCHEMA_VERSION = PERSISTENCE_SCHEMA_REGISTRY.currentVersion('session_archive');
export const MAX_SESSION_EXPORT_BYTES = 50 * 1024 * 1024;
export const MAX_SESSION_PLAN_CHARS = 96_000;
export const MAX_SESSION_FAILURE_MESSAGE_CHARS = 2_000;
const MAX_SESSION_EXPORT_ARCHIVES = 1_000;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class SessionStore {
  constructor(
    workspaceRoot,
    {
      lockWaitMs = 2_000,
      onPersistenceWarning = ({ session_id, code }) =>
        process.emitWarning(`Session ${session_id} was committed but its directory durability could not be confirmed`, { code }),
    } = {},
  ) {
    if (!Number.isInteger(lockWaitMs) || lockWaitMs < 0 || lockWaitMs > 30_000)
      throw new TypeError('lockWaitMs must be between 0 and 30000');
    if (typeof onPersistenceWarning !== 'function') throw new TypeError('onPersistenceWarning must be a function');
    this.workspaceRoot = workspaceRoot;
    this.directory = path.join(workspaceRoot, '.agent', 'sessions');
    this.lockDirectory = path.join(workspaceRoot, '.agent', 'session-locks');
    this.lockWaitMs = lockWaitMs;
    this.onPersistenceWarning = onPersistenceWarning;
    this.newSessionIds = new Set();
  }

  create({ model = null, routingDecision = null, messages = [] } = {}) {
    const now = new Date().toISOString();
    const session = {
      schema_version: SESSION_SCHEMA_VERSION,
      id: randomUUID(),
      revision: 0,
      created_at: now,
      updated_at: now,
      status: 'active',
      model,
      routing_decision: routingDecision,
      messages,
      usage: { input_tokens: 0, output_tokens: 0, estimated_cost: null },
      worktree_path: null,
      budget_state: {},
      permission_grants: [],
    };
    this.newSessionIds.add(session.id);
    return session;
  }

  async save(session) {
    validateSession(session);
    await ensureSafeDirectory(this.workspaceRoot, this.directory, {
      errorCode: 'SESSION_DIRECTORY_INVALID',
      label: 'Session store',
    });
    return this.#withSessionLock(session.id, async () => {
      const destination = path.join(this.directory, `${session.id}.json`);
      let existing = null;
      try {
        existing = await readSafeSessionRecord(this.workspaceRoot, this.directory, destination);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (existing) {
        assertSupportedSessionVersion(existing.schema_version);
        validateSession(existing);
        if (existing.id !== session.id) throw sessionConflict(session.id, 'contains a mismatched record');
      }
      const expectedRevision = session.revision ?? 0;
      if (existing && this.newSessionIds.has(session.id)) throw sessionConflict(session.id, 'already exists');
      if (existing && (existing.revision ?? 0) !== expectedRevision) throw sessionConflict(session.id, 'was changed by another writer');
      if (!existing && !this.newSessionIds.has(session.id)) throw sessionConflict(session.id, 'was deleted by another writer');

      const nextRevision = expectedRevision + 1;
      const nextUpdatedAt = new Date().toISOString();
      const persistedSession = redactStructuredSecrets(structuredClone(session));
      persistedSession.revision = nextRevision;
      persistedSession.updated_at = nextUpdatedAt;
      validateSession(persistedSession);
      try {
        await atomicWriteJson(destination, persistedSession, { mode: 0o600 });
      } catch (error) {
        if (!error.committed) throw error;
        session.revision = nextRevision;
        session.updated_at = nextUpdatedAt;
        this.newSessionIds.delete(session.id);
        try {
          this.onPersistenceWarning({ session_id: session.id, code: error.code || 'SESSION_DURABILITY_UNCERTAIN' });
        } catch {
          /* A warning handler must not turn a committed write into an apparent rollback. */
        }
        return session;
      }
      session.revision = nextRevision;
      session.updated_at = nextUpdatedAt;
      this.newSessionIds.delete(session.id);
      return session;
    });
  }

  async load(id) {
    assertId(id);
    await ensureSafeDirectory(this.workspaceRoot, this.directory, {
      create: false,
      errorCode: 'SESSION_DIRECTORY_INVALID',
      label: 'Session store',
    });
    const file = path.join(this.directory, `${id}.json`);
    try {
      return await this.#readSessionFile(file, id);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    return this.#withSessionLock(id, async () => {
      try {
        return await this.#readSessionFile(file, id);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }

      const backupPrefix = `${id}.json.`;
      const backupNames = (await fs.readdir(this.directory)).filter((name) => {
        if (!name.startsWith(backupPrefix) || !name.endsWith('.bak')) return false;
        return ID_PATTERN.test(name.slice(backupPrefix.length, -'.bak'.length));
      });
      if (backupNames.length === 0) throw sessionNotFoundError(id);
      if (backupNames.length !== 1) throw sessionBackupRecoveryError(id, 'multiple backups were found');

      const backup = path.join(this.directory, backupNames[0]);
      try {
        await this.#readSessionFile(backup, id);
      } catch (error) {
        throw sessionBackupRecoveryError(id, 'the backup failed session validation', error);
      }

      // The per-session lock prevents Xyst writers from racing this restore.
      // The backup is renamed atomically; it is never overwritten or deleted
      // when validation fails or more than one candidate exists.
      await fs.rename(backup, file);
      return this.#readSessionFile(file, id);
    });
  }

  async #readSessionFile(file, id) {
    const session = await readSafeSessionRecord(this.workspaceRoot, this.directory, file);
    if (session && typeof session === 'object' && !Array.isArray(session)) assertSupportedSessionVersion(session.schema_version);
    validateSession(session);
    if (session.id !== id) throw new Error('Session ID does not match its filename');
    return session;
  }

  async list() {
    try {
      await ensureSafeDirectory(this.workspaceRoot, this.directory, {
        create: false,
        errorCode: 'SESSION_DIRECTORY_INVALID',
        label: 'Session store',
      });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    let names;
    try {
      names = await fs.readdir(this.directory);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const sessions = [];
    for (const name of names.filter((entry) => entry.endsWith('.json'))) {
      try {
        const session = await this.load(name.slice(0, -5));
        const lastMessage = session.messages.at(-1);
        sessions.push({
          id: session.id,
          title: session.title || 'New conversation',
          created_at: session.created_at,
          updated_at: session.updated_at,
          status: session.status,
          model: session.model,
          mode: session.mode,
          has_worktree: typeof session.worktree_path === 'string',
          message_count: session.messages.length,
          last_message_role: lastMessage?.role || null,
          last_message_has_tool_calls:
            lastMessage?.role === 'assistant' && Array.isArray(lastMessage.tool_calls) && lastMessage.tool_calls.length > 0,
        });
      } catch {
        /* corrupt session files are excluded; explicit load reports the error */
      }
    }
    return sessions.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async inspectRecords() {
    try {
      await ensureSafeDirectory(this.workspaceRoot, this.directory, {
        create: false,
        errorCode: 'SESSION_DIRECTORY_INVALID',
        label: 'Session store',
      });
    } catch (error) {
      if (error.code === 'ENOENT') return { readable: 0, unreadable: [], unexpected: [] };
      throw error;
    }
    let names;
    try {
      names = await fs.readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return { readable: 0, unreadable: [], unexpected: [] };
      throw error;
    }
    const report = { readable: 0, unreadable: [], unexpected: [] };
    for (const entry of names) {
      const relative = path.join('.agent', 'sessions', entry.name);
      if (!entry.name.endsWith('.json')) continue;
      if (!ID_PATTERN.test(entry.name.slice(0, -5)) || !entry.isFile() || entry.isSymbolicLink()) {
        report.unexpected.push({ path: relative, reason: 'session entry is not a UUID-named regular file' });
        continue;
      }
      try {
        const file = path.join(this.directory, entry.name);
        const info = await fs.lstat(file);
        if (info.isSymbolicLink() || !info.isFile()) throw new Error('session entry is not a regular file');
        if (info.size > MAX_SESSION_EXPORT_BYTES)
          throw Object.assign(new Error('session record exceeds the size limit'), { code: 'SESSION_RECORD_TOO_LARGE' });
        const expectedDirectory = await fs.realpath(this.directory);
        if (path.dirname(await fs.realpath(file)) !== expectedDirectory) throw new Error('session record resolves outside its directory');
        await this.load(entry.name.slice(0, -5));
        report.readable += 1;
      } catch (error) {
        report.unreadable.push({
          path: relative,
          size_bytes: await fs
            .lstat(path.join(this.directory, entry.name))
            .then((info) => info.size)
            .catch(() => null),
          reason: sessionDiagnosticReason(error),
        });
      }
    }
    return report;
  }

  async inspectCompactionArchives({ now = Date.now(), orphanGraceMs = 60 * 60 * 1000 } = {}) {
    if (!Number.isFinite(now) || !Number.isFinite(orphanGraceMs) || orphanGraceMs < 0 || orphanGraceMs > 30 * 24 * 60 * 60 * 1000)
      throw new TypeError('Recovery inspection time or grace period is invalid');
    const report = { referenced: 0, orphaned: [], recent_orphans: [], invalid: [], unreadable_sessions: [] };
    let sessionNames = [];
    try {
      await ensureSafeDirectory(this.workspaceRoot, this.directory, {
        create: false,
        errorCode: 'SESSION_DIRECTORY_INVALID',
        label: 'Session store',
      });
      sessionNames = await fs.readdir(this.directory);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const referenced = new Set();
    const protectedIds = new Set();
    for (const name of sessionNames.filter((entry) => entry.endsWith('.json'))) {
      const id = name.slice(0, -5);
      if (!ID_PATTERN.test(id)) continue;
      let session;
      try {
        session = await this.load(id);
      } catch {
        protectedIds.add(id);
        report.unreadable_sessions.push(id);
        continue;
      }
      const refs = new Set([...(session.compaction_archives || []), ...(session.compaction_archive ? [session.compaction_archive] : [])]);
      for (const reference of refs) {
        try {
          await resolveCompactionArchive(this.workspaceRoot, id, reference);
          referenced.add(path.resolve(this.workspaceRoot, reference));
          report.referenced += 1;
        } catch (error) {
          protectedIds.add(id);
          report.invalid.push({ session_id: id, path: typeof reference === 'string' ? reference : '', reason: error.message });
        }
      }
    }

    const archiveRoot = path.join(this.workspaceRoot, '.agent', 'compactions');
    try {
      await ensureSafeDirectory(this.workspaceRoot, archiveRoot, { create: false });
    } catch (error) {
      if (error.code === 'ENOENT') return report;
      throw error;
    }
    for (const sessionEntry of await fs.readdir(archiveRoot, { withFileTypes: true })) {
      const sessionDirectory = path.join(archiveRoot, sessionEntry.name);
      if (!ID_PATTERN.test(sessionEntry.name) || !sessionEntry.isDirectory() || sessionEntry.isSymbolicLink()) {
        report.invalid.push({ path: path.relative(this.workspaceRoot, sessionDirectory), reason: 'unexpected archive directory' });
        continue;
      }
      for (const archiveEntry of await fs.readdir(sessionDirectory, { withFileTypes: true })) {
        const archivePath = path.join(sessionDirectory, archiveEntry.name);
        const relative = path.relative(this.workspaceRoot, archivePath);
        if (!/^[0-9a-f-]{36}\.json$/i.test(archiveEntry.name) || !archiveEntry.isFile() || archiveEntry.isSymbolicLink()) {
          report.invalid.push({ path: relative, reason: 'unexpected archive entry' });
          continue;
        }
        try {
          const info = await fs.lstat(archivePath);
          if (info.size > MAX_SESSION_EXPORT_BYTES) throw new Error('archive exceeds the size limit');
          const archive = JSON.parse(await fs.readFile(archivePath, 'utf8'));
          if (
            archive?.schema_version !== SESSION_ARCHIVE_SCHEMA_VERSION ||
            archive.session_id !== sessionEntry.name ||
            !isValidArchivedMessages(archive.messages) ||
            !Number.isFinite(Date.parse(archive.archived_at))
          )
            throw new Error('invalid archive record');
          if (referenced.has(path.resolve(archivePath))) continue;
          const entry = {
            session_id: sessionEntry.name,
            path: relative,
            archived_at: archive.archived_at,
            messages: archive.messages.length,
          };
          if (protectedIds.has(sessionEntry.name)) continue;
          (now - Date.parse(archive.archived_at) >= orphanGraceMs ? report.orphaned : report.recent_orphans).push(entry);
        } catch (error) {
          report.invalid.push({ path: relative, reason: error.message });
        }
      }
    }
    return report;
  }

  async exportSession(id, { includeGoals = true } = {}) {
    const session = await this.load(id);
    const references = [
      ...new Set([...(session.compaction_archives || []), ...(session.compaction_archive ? [session.compaction_archive] : [])]),
    ];
    if (references.length > MAX_SESSION_EXPORT_ARCHIVES)
      throw Object.assign(new Error('Session has too many compaction archives to export'), { code: 'SESSION_EXPORT_TOO_LARGE' });
    const archives = [];
    for (const reference of references) {
      const archivePath = await resolveCompactionArchive(this.workspaceRoot, id, reference);
      const archive = JSON.parse(await fs.readFile(archivePath, 'utf8'));
      if (
        archive?.schema_version !== SESSION_ARCHIVE_SCHEMA_VERSION ||
        archive.session_id !== id ||
        !isValidArchivedMessages(archive.messages) ||
        !Number.isFinite(Date.parse(archive.archived_at))
      ) {
        throw Object.assign(new Error(`Compaction archive '${reference}' is invalid`), { code: 'INVALID_SESSION_ARCHIVE' });
      }
      archives.push({
        schema_version: SESSION_ARCHIVE_SCHEMA_VERSION,
        archived_at: archive.archived_at,
        messages: redactStructuredSecrets(archive.messages),
      });
    }
    const portableSession = redactStructuredSecrets(structuredClone(session));
    portableSession.permission_grants = [];
    portableSession.worktree_path = null;
    portableSession.compaction_archive = null;
    portableSession.compaction_archives = [];
    const document = {
      format: 'xyst-session',
      format_version: SESSION_EXPORT_VERSION,
      exported_at: new Date().toISOString(),
      session: portableSession,
      archives,
    };
    if (includeGoals && session.persistent_goal_ids?.length) {
      const goalExport = await new GoalStore(this.workspaceRoot).exportGoals();
      const byId = new Map(goalExport.goals.map((goal) => [goal.id, goal]));
      const referenced = session.persistent_goal_ids.map((goalId) => byId.get(goalId));
      if (referenced.some((goal) => !goal))
        throw Object.assign(new Error('Session references a project goal that is no longer available'), {
          code: 'SESSION_GOAL_REFERENCE_MISSING',
        });
      document.goals = { ...goalExport, goals: referenced };
    }
    // CLI and browser downloads use two-space JSON, so measure that representation
    // to ensure every exported file remains importable under the same byte cap.
    if (Buffer.byteLength(`${JSON.stringify(document, null, 2)}\n`, 'utf8') > MAX_SESSION_EXPORT_BYTES)
      throw Object.assign(new Error(`Session export exceeds ${MAX_SESSION_EXPORT_BYTES} bytes`), { code: 'SESSION_EXPORT_TOO_LARGE' });
    return document;
  }

  async importSession(document) {
    if (
      !document ||
      typeof document !== 'object' ||
      Array.isArray(document) ||
      document.format !== 'xyst-session' ||
      document.format_version !== SESSION_EXPORT_VERSION ||
      !document.session ||
      typeof document.session !== 'object' ||
      Array.isArray(document.session) ||
      !Array.isArray(document.archives) ||
      document.archives.length > MAX_SESSION_EXPORT_ARCHIVES
    ) {
      throw Object.assign(new Error('Session export format is invalid or unsupported'), { code: 'INVALID_SESSION_EXPORT' });
    }
    if (Buffer.byteLength(JSON.stringify(document), 'utf8') > MAX_SESSION_EXPORT_BYTES)
      throw Object.assign(new Error(`Session export exceeds ${MAX_SESSION_EXPORT_BYTES} bytes`), { code: 'SESSION_EXPORT_TOO_LARGE' });
    const source = structuredClone(document.session);
    assertSupportedSessionVersion(source.schema_version, 'INVALID_SESSION_EXPORT');
    validateSession(source);
    let goalSnapshot = null;
    if (document.goals !== undefined) {
      validateGoalsExport(document.goals);
      const includedIds = new Set(document.goals.goals.map((goal) => goal.id));
      const referencedIds = new Set(source.persistent_goal_ids || []);
      if (
        includedIds.size !== referencedIds.size ||
        [...referencedIds].some((goalId) => !includedIds.has(goalId)) ||
        [...includedIds].some((goalId) => !referencedIds.has(goalId))
      )
        throw Object.assign(new Error('Session export goal snapshot must exactly match its referenced project goals'), {
          code: 'INVALID_SESSION_EXPORT',
        });
      goalSnapshot = document.goals;
    }
    for (const archive of document.archives) {
      if (
        !archive ||
        typeof archive !== 'object' ||
        Array.isArray(archive) ||
        archive.schema_version !== SESSION_ARCHIVE_SCHEMA_VERSION ||
        !Number.isFinite(Date.parse(archive.archived_at)) ||
        !isValidArchivedMessages(archive.messages)
      ) {
        throw Object.assign(new Error('Session export contains an invalid compaction archive'), { code: 'INVALID_SESSION_EXPORT' });
      }
    }

    const now = new Date().toISOString();
    const imported = redactStructuredSecrets(source);
    imported.id = randomUUID();
    imported.revision = 0;
    imported.created_at = now;
    imported.updated_at = now;
    // Preserve terminal failure state so imported sessions can show the cause.
    // Starting a new run clears this metadata and moves the session back to active.
    imported.status = source.status === 'failed' ? 'failed' : 'active';
    imported.permission_grants = [];
    imported.worktree_path = null;
    imported.budget_state = {};
    imported.compaction_archive = null;
    imported.compaction_archives = [];
    const archiveDirectory = path.join(await fs.realpath(this.workspaceRoot), '.agent', 'compactions', imported.id);
    const createdArchives = [];
    let saved = false;
    try {
      if (document.archives.length) await ensureSafeDirectory(this.workspaceRoot, archiveDirectory);
      for (const archive of document.archives) {
        const filename = `${randomUUID()}.json`;
        const destination = path.join(archiveDirectory, filename);
        const relative = path.relative(await fs.realpath(this.workspaceRoot), destination);
        await atomicWriteJson(
          destination,
          {
            schema_version: SESSION_ARCHIVE_SCHEMA_VERSION,
            session_id: imported.id,
            archived_at: archive.archived_at,
            messages: redactStructuredSecrets(archive.messages),
          },
          { mode: 0o600 },
        );
        createdArchives.push(destination);
        imported.compaction_archives.push(relative);
      }
      imported.compaction_archive = imported.compaction_archives.at(-1) || null;
      this.newSessionIds.add(imported.id);
      await this.save(imported);
      saved = true;
      if (goalSnapshot) await new GoalStore(this.workspaceRoot).importReferencedGoals(goalSnapshot);
      return imported;
    } catch (error) {
      this.newSessionIds.delete(imported.id);
      if (saved) await this.delete(imported.id).catch(() => {});
      await Promise.all(createdArchives.map((file) => fs.rm(file, { force: true }).catch(() => {})));
      if (createdArchives.length) await fs.rm(archiveDirectory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async fork(id) {
    const source = await this.load(id);
    const fork = structuredClone(source);
    fork.id = randomUUID();
    fork.created_at = new Date().toISOString();
    fork.updated_at = fork.created_at;
    fork.status = 'active';
    fork.revision = 0;
    fork.permission_grants = [];
    fork.compaction_archive = null;
    fork.compaction_archives = [];
    if (source.persistent_goal_ids) fork.persistent_goal_ids = [...source.persistent_goal_ids];
    try {
      return await new GoalStore(this.workspaceRoot, { lockWaitMs: this.lockWaitMs }).withExistingIds(
        source.persistent_goal_ids || [],
        async () => {
          this.newSessionIds.add(fork.id);
          return this.save(fork);
        },
      );
    } catch (error) {
      if (error.code === 'GOAL_NOT_FOUND')
        throw Object.assign(new Error(`Session references project goals that are no longer available: ${error.ids.join(', ')}`), {
          code: 'SESSION_GOAL_REFERENCE_MISSING',
        });
      throw error;
    }
  }

  async removeGoalReference(goalId) {
    if (typeof goalId !== 'string' || !goalId) throw new TypeError('Goal ID must be a non-empty string');
    const sessions = await this.list();
    let updated = 0;
    for (const { id } of sessions) {
      const session = await this.load(id);
      const references = session.persistent_goal_ids || [];
      if (!references.includes(goalId)) continue;
      session.persistent_goal_ids = references.filter((reference) => reference !== goalId);
      await this.save(session);
      updated += 1;
    }
    return updated;
  }

  async rename(id, title) {
    if (typeof title !== 'string' || !title.trim()) throw new TypeError('Session title must not be empty');
    const session = await this.load(id);
    session.title = redactSecrets(title.replace(/\s+/g, ' ').trim()).slice(0, 200);
    return this.save(session);
  }

  async updatePlan(id, plan) {
    if (plan !== null && (typeof plan !== 'string' || plan.length > MAX_SESSION_PLAN_CHARS))
      throw Object.assign(new TypeError(`Session plan must be null or at most ${MAX_SESSION_PLAN_CHARS} characters`), {
        code: 'INVALID_SESSION_PLAN',
      });
    const session = await this.load(id);
    if (plan === null) delete session.plan;
    else session.plan = redactSecrets(plan);
    return this.save(session);
  }

  async setPersistentGoals(id, goalIds) {
    assertId(id);
    if (
      !Array.isArray(goalIds) ||
      goalIds.length > 500 ||
      goalIds.some((goalId) => typeof goalId !== 'string' || !ID_PATTERN.test(goalId)) ||
      new Set(goalIds).size !== goalIds.length
    )
      throw Object.assign(new TypeError('Session goals must be a unique list of at most 500 valid goal IDs'), {
        code: 'INVALID_SESSION_GOALS',
      });
    return new GoalStore(this.workspaceRoot, { lockWaitMs: this.lockWaitMs }).withExistingIds(goalIds, async () => {
      const session = await this.load(id);
      session.persistent_goal_ids = [...goalIds];
      return this.save(session);
    });
  }

  async archive(id) {
    const session = await this.load(id);
    session.status = 'archived';
    return this.save(session);
  }

  async listPermissionGrants(id) {
    const session = await this.load(id);
    const now = Date.now();
    return (session.permission_grants || []).map((grant) => ({
      id: grant.id,
      tool: grant.tool,
      scope: grant.scope,
      created_at: grant.created_at,
      expires_at: grant.expires_at,
      status: Date.parse(grant.expires_at) > now ? 'active' : 'expired',
    }));
  }

  async revokePermissionGrant(id, grantId) {
    assertId(grantId);
    const session = await this.load(id);
    const grants = session.permission_grants || [];
    const remaining = grants.filter((grant) => grant.id !== grantId);
    if (remaining.length === grants.length) return false;
    const removed = grants.find((grant) => grant.id === grantId);
    const audit = new ToolAuditStore(this.workspaceRoot);
    const auditDetails = {
      sessionId: id,
      toolCallId: grantId,
      tool: 'permission_grant',
      args: { grant_id: grantId, granted_tool: removed.tool, scope: removed.scope },
      decision: 'revoke',
    };
    await audit.record({ ...auditDetails, approvalResult: 'user_requested', outcome: 'revocation_requested' });
    session.permission_grants = remaining;
    await this.save(session);
    await audit.record({ ...auditDetails, approvalResult: 'revoked', outcome: 'succeeded' });
    return true;
  }

  async delete(id) {
    assertId(id);
    await ensureSafeDirectory(this.workspaceRoot, this.directory, {
      create: false,
      errorCode: 'SESSION_DIRECTORY_INVALID',
      label: 'Session store',
    });
    const archiveDirectory = path.join(this.workspaceRoot, '.agent', 'compactions', id);
    try {
      await ensureSafeDirectory(this.workspaceRoot, archiveDirectory, { create: false });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await this.#withSessionLock(id, async () => {
      await ensureSafeDirectory(this.workspaceRoot, this.directory, {
        create: false,
        errorCode: 'SESSION_DIRECTORY_INVALID',
        label: 'Session store',
      });
      await fs.rm(path.join(this.directory, `${id}.json`));
      await fs.rm(archiveDirectory, { recursive: true, force: true });
    });
    this.newSessionIds.delete(id);
  }

  async #withSessionLock(id, operation) {
    await ensureSafeDirectory(this.workspaceRoot, this.lockDirectory, {
      errorCode: 'SESSION_LOCK_DIRECTORY_INVALID',
      label: 'Session lock store',
    });
    const lockPath = path.join(this.lockDirectory, `${id}.lock`);
    const deadline = Date.now() + this.lockWaitMs;
    let handle;
    while (!handle) {
      try {
        handle = await fs.open(lockPath, 'wx', 0o600);
      } catch (error) {
        const contention = error.code === 'EEXIST' || (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code));
        if (!contention) throw error;
        if (Date.now() >= deadline) {
          try {
            await fs.lstat(lockPath);
          } catch (inspectError) {
            if (inspectError.code === 'ENOENT') {
              if (error.code === 'EEXIST') continue;
              throw error;
            }
          }
          let owner = 'owner details unavailable';
          try {
            owner = (await fs.readFile(lockPath, 'utf8')).trim() || owner;
          } catch {
            /* lock may be releasing */
          }
          throw Object.assign(
            new Error(`Session ${id} is locked (${owner}). If its writer crashed, verify it is no longer running and remove ${lockPath}.`),
            { code: 'SESSION_LOCKED' },
          );
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(20, Math.max(1, deadline - Date.now()))));
      }
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, hostname: os.hostname(), started_at: new Date().toISOString() }));
      return await operation();
    } finally {
      await handle.close().catch(() => {});
      await fs.rm(lockPath, { force: true }).catch(() => {});
    }
  }
}

function sessionDiagnosticReason(error) {
  if (error.code === 'SESSION_FILE_INVALID') return 'session record is not a safe regular file';
  if (error.code === 'SESSION_RECORD_TOO_LARGE') return 'session record exceeds the size limit';
  if (error.code === 'UNSUPPORTED_SESSION_SCHEMA_VERSION') return 'session record uses an unsupported schema version';
  if (error instanceof SyntaxError) return 'session record contains invalid JSON';
  if (error instanceof TypeError) return 'session record failed validation';
  if (/does not match its filename/.test(error.message)) return 'session ID does not match its filename';
  return 'session record could not be safely read';
}

function sessionBackupRecoveryError(id, reason, cause) {
  return Object.assign(
    new Error(
      `Session ${id} is missing its primary record and cannot be recovered automatically: ${reason}. Preserve the session files for manual recovery.`,
      {
        cause,
      },
    ),
    { code: 'SESSION_BACKUP_RECOVERY_REQUIRED' },
  );
}

function sessionNotFoundError(id) {
  return Object.assign(new Error(`Session ${id} does not exist`), { code: 'ENOENT' });
}

async function readSafeSessionRecord(workspaceRoot, directory, file) {
  const expectedDirectory = await ensureSafeDirectory(workspaceRoot, directory, {
    create: false,
    errorCode: 'SESSION_DIRECTORY_INVALID',
    label: 'Session store',
  });
  const before = await fs.lstat(file);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink > 1)
    throw Object.assign(new Error('Session record must be a regular single-link file'), { code: 'SESSION_FILE_INVALID' });
  if (before.size > MAX_SESSION_EXPORT_BYTES)
    throw Object.assign(new Error('Session record exceeds the size limit'), { code: 'SESSION_RECORD_TOO_LARGE' });
  const realFile = await fs.realpath(file);
  if (path.dirname(realFile) !== (await fs.realpath(expectedDirectory)))
    throw Object.assign(new Error('Session record resolves outside its directory'), { code: 'SESSION_FILE_INVALID' });

  const noFollow = fsConstants.O_NOFOLLOW || 0;
  const handle = await fs.open(file, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink > 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > MAX_SESSION_EXPORT_BYTES
    )
      throw Object.assign(new Error('Session record changed while it was being opened'), { code: 'SESSION_FILE_INVALID' });
    return JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
}

function assertId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new TypeError('Invalid session ID');
}

async function resolveCompactionArchive(workspaceRoot, sessionId, reference) {
  if (typeof reference !== 'string' || !reference || path.isAbsolute(reference) || path.win32.isAbsolute(reference)) {
    throw Object.assign(new Error('Session compaction archive path is invalid'), { code: 'INVALID_SESSION_ARCHIVE' });
  }
  const root = await fs.realpath(workspaceRoot);
  const expectedDirectory = path.resolve(root, '.agent', 'compactions', sessionId);
  const archivePath = path.resolve(root, reference);
  if (path.dirname(archivePath) !== expectedDirectory || !/^[0-9a-f-]{36}\.json$/i.test(path.basename(archivePath))) {
    throw Object.assign(new Error('Session compaction archive path escapes its session archive directory'), {
      code: 'INVALID_SESSION_ARCHIVE',
    });
  }
  await ensureSafeDirectory(root, expectedDirectory, { create: false });
  const info = await fs.lstat(archivePath);
  if (info.isSymbolicLink() || !info.isFile())
    throw Object.assign(new Error('Session compaction archive must be a regular non-symlink file'), { code: 'INVALID_SESSION_ARCHIVE' });
  const realArchive = await fs.realpath(archivePath);
  if (path.dirname(realArchive) !== expectedDirectory)
    throw Object.assign(new Error('Session compaction archive resolves outside its expected directory'), {
      code: 'INVALID_SESSION_ARCHIVE',
    });
  return realArchive;
}

async function ensureSafeDirectory(
  workspaceRoot,
  targetDirectory,
  { create = true, errorCode = 'INVALID_SESSION_ARCHIVE', label = 'Session archive' } = {},
) {
  const root = await fs.realpath(workspaceRoot);
  const target = path.resolve(targetDirectory);
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw Object.assign(new Error(`${label} directory must remain inside the workspace state root`), {
      code: errorCode,
    });
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const info = await fs.lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw Object.assign(new Error(`${label} path contains a non-directory or symlink`), { code: errorCode });
    } catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      await fs.mkdir(current, { mode: 0o700 }).catch(async (mkdirError) => {
        if (mkdirError.code !== 'EEXIST') throw mkdirError;
        const raced = await fs.lstat(current);
        if (raced.isSymbolicLink() || !raced.isDirectory())
          throw Object.assign(new Error(`${label} path contains a non-directory or symlink`), {
            code: errorCode,
          });
      });
    }
  }
  return target;
}

export function sessionFailureFromError(error, failedAt = new Date().toISOString()) {
  const rawCode = typeof error?.code === 'string' ? error.code.trim() : '';
  const code = /^[A-Za-z0-9_.:-]{1,128}$/.test(rawCode) ? rawCode : 'RUN_FAILED';
  const rawMessage = typeof error?.message === 'string' && error.message.trim() ? error.message : 'Run failed';
  return {
    code,
    message: redactSecrets(rawMessage).slice(0, MAX_SESSION_FAILURE_MESSAGE_CHARS),
    failed_at: failedAt,
  };
}

function validateSession(session) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) throw new TypeError('Session must be an object');
  assertSupportedSessionVersion(session.schema_version);
  assertId(session.id);
  if (!SESSION_STATUSES.includes(session.status)) throw new TypeError('Session status is invalid');
  if (session.failure !== undefined) {
    const failure = session.failure;
    const failureKeys = new Set(['code', 'message', 'failed_at']);
    if (
      !failure ||
      typeof failure !== 'object' ||
      Array.isArray(failure) ||
      Object.keys(failure).some((key) => !failureKeys.has(key)) ||
      typeof failure.code !== 'string' ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(failure.code) ||
      typeof failure.message !== 'string' ||
      !failure.message.trim() ||
      failure.message.length > MAX_SESSION_FAILURE_MESSAGE_CHARS ||
      typeof failure.failed_at !== 'string' ||
      failure.failed_at.length > 40 ||
      !Number.isFinite(Date.parse(failure.failed_at)) ||
      new Date(failure.failed_at).toISOString() !== failure.failed_at
    )
      throw new TypeError('Session failure is invalid');
  }
  if (session.revision !== undefined && (!Number.isInteger(session.revision) || session.revision < 0))
    throw new TypeError('Session revision is invalid');
  if (
    session.worktree_path !== undefined &&
    session.worktree_path !== null &&
    (typeof session.worktree_path !== 'string' || session.worktree_path.length > 32_000)
  )
    throw new TypeError('Session worktree_path is invalid');
  if (
    session.permission_grants !== undefined &&
    (!Array.isArray(session.permission_grants) ||
      session.permission_grants.length > MAX_SESSION_GRANTS ||
      session.permission_grants.some((grant) => !isValidPermissionGrant(grant)))
  )
    throw new TypeError('Session permission_grants are invalid');
  if (
    session.persistent_goal_ids !== undefined &&
    (!Array.isArray(session.persistent_goal_ids) ||
      session.persistent_goal_ids.length > 500 ||
      session.persistent_goal_ids.some((goalId) => typeof goalId !== 'string' || !ID_PATTERN.test(goalId)) ||
      new Set(session.persistent_goal_ids).size !== session.persistent_goal_ids.length)
  )
    throw new TypeError('Session persistent_goal_ids are invalid');
  if (
    session.mcp_servers !== undefined &&
    session.mcp_servers !== null &&
    (!Array.isArray(session.mcp_servers) ||
      session.mcp_servers.length > 16 ||
      session.mcp_servers.some((name) => typeof name !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(name)) ||
      new Set(session.mcp_servers).size !== session.mcp_servers.length)
  )
    throw new TypeError('Session mcp_servers must be null or contain at most 16 unique valid names');
  if (
    session.plan !== undefined &&
    session.plan !== null &&
    (typeof session.plan !== 'string' || session.plan.length > MAX_SESSION_PLAN_CHARS)
  )
    throw new TypeError('Session plan is invalid or exceeds its character limit');
  if (!Array.isArray(session.messages)) throw new TypeError('Session messages must be an array');
  if (typeof session.created_at !== 'string' || typeof session.updated_at !== 'string')
    throw new TypeError('Session timestamps are required');
  if (
    !session.usage ||
    !Number.isFinite(session.usage.input_tokens) ||
    session.usage.input_tokens < 0 ||
    !Number.isFinite(session.usage.output_tokens) ||
    session.usage.output_tokens < 0
  )
    throw new TypeError('Session usage is invalid');
  if (session.usage.estimated_cost !== null && (!Number.isFinite(session.usage.estimated_cost) || session.usage.estimated_cost < 0))
    throw new TypeError('Session estimated_cost is invalid');
}

function assertSupportedSessionVersion(version, errorCode = 'UNSUPPORTED_SESSION_SCHEMA_VERSION') {
  if (!Number.isInteger(version) || version < 1) throw new TypeError('Session schema_version is invalid');
  if (version < SESSION_SCHEMA_VERSION)
    throw Object.assign(
      new Error(`Unsupported older session schema version ${version}; this build supports version ${SESSION_SCHEMA_VERSION}`),
      { code: errorCode },
    );
  try {
    PERSISTENCE_SCHEMA_REGISTRY.assertVersion('session', version);
  } catch (error) {
    if (error.code === 'UNSUPPORTED_SESSION_SCHEMA_VERSION' && errorCode !== error.code) error.code = errorCode;
    throw error;
  }
}

function isValidArchivedMessages(messages) {
  return (
    Array.isArray(messages) &&
    messages.every(
      (message) =>
        message &&
        typeof message === 'object' &&
        !Array.isArray(message) &&
        ['system', 'user', 'assistant', 'tool'].includes(message.role) &&
        (typeof message.content === 'string' || message.content === null || Array.isArray(message.content)),
    )
  );
}

function isValidPermissionGrant(grant) {
  return (
    grant &&
    typeof grant === 'object' &&
    !Array.isArray(grant) &&
    ID_PATTERN.test(grant.id) &&
    typeof grant.tool === 'string' &&
    grant.tool.length > 0 &&
    grant.tool.length <= 100 &&
    grant.scope === 'exact_action' &&
    typeof grant.arguments_hash === 'string' &&
    /^[0-9a-f]{64}$/.test(grant.arguments_hash) &&
    Number.isFinite(Date.parse(grant.created_at)) &&
    Number.isFinite(Date.parse(grant.expires_at)) &&
    Date.parse(grant.expires_at) > Date.parse(grant.created_at)
  );
}

function sessionConflict(id, reason) {
  return Object.assign(new Error(`Session ${id} ${reason}; reload it before saving`), { code: 'SESSION_CONFLICT' });
}
