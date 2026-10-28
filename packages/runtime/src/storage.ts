import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { supportedSettingScopes, validateSettingContext, validateSettingScope, validateSettingValue } from "./settings-schema.js";

const migrations = [
  `CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE TABLE tool_calls (id TEXT PRIMARY KEY, session_id TEXT, name TEXT NOT NULL, input_json TEXT NOT NULL, output_json TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT);
   CREATE TABLE missions (id TEXT PRIMARY KEY, definition_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE TABLE agents (id TEXT PRIMARY KEY, mission_id TEXT, definition_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE TABLE jobs (id TEXT PRIMARY KEY, session_id TEXT, mission_id TEXT, kind TEXT NOT NULL, state TEXT NOT NULL, details_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE TABLE artifacts (id TEXT PRIMARY KEY, session_id TEXT, job_id TEXT, name TEXT NOT NULL, path TEXT NOT NULL, mime_type TEXT, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE TABLE usage (id TEXT PRIMARY KEY, session_id TEXT, provider TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, duration_ms INTEGER, details_json TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE TABLE settings (scope TEXT NOT NULL, scope_id TEXT NOT NULL DEFAULT '', key TEXT NOT NULL, value_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(scope, scope_id, key));
   CREATE INDEX messages_session_created ON messages(session_id, created_at);
   CREATE INDEX tool_calls_session_created ON tool_calls(session_id, created_at);`,
  `CREATE TABLE model_decisions (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, objective TEXT NOT NULL, model TEXT NOT NULL, reason TEXT NOT NULL, considered_json TEXT NOT NULL, created_at TEXT NOT NULL);`,
  `CREATE TABLE webhook_events (delivery_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, repository TEXT NOT NULL, issue_number INTEGER, received_at TEXT NOT NULL, processed_at TEXT);`,
  `ALTER TABLE missions ADD COLUMN next_run_at TEXT;
   ALTER TABLE missions ADD COLUMN last_run_at TEXT;
   CREATE TABLE mission_runs (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), state TEXT NOT NULL, trigger_type TEXT NOT NULL, scheduled_for TEXT, started_at TEXT NOT NULL, finished_at TEXT, heartbeat_at TEXT NOT NULL, error TEXT);
   CREATE INDEX mission_runs_recent ON mission_runs(mission_id, started_at DESC);
   CREATE TABLE mission_tasks (run_id TEXT NOT NULL REFERENCES mission_runs(id) ON DELETE CASCADE, mission_id TEXT NOT NULL, task_key TEXT NOT NULL, objective TEXT NOT NULL, dependencies_json TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, session_id TEXT, result_json TEXT, error TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(run_id, task_key));
   CREATE TABLE runner_leases (mission_id TEXT PRIMARY KEY REFERENCES missions(id) ON DELETE CASCADE, owner_id TEXT NOT NULL, expires_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL);`,
  `CREATE TABLE model_downloads (id TEXT PRIMARY KEY, repository TEXT NOT NULL, revision TEXT NOT NULL, quantization TEXT, lm_job_id TEXT, state TEXT NOT NULL, total_size_bytes INTEGER, details_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
  `CREATE TABLE memories (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('preference','note','inferred')), content TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE INDEX memories_updated ON memories(updated_at DESC);`,
  `CREATE TABLE memory_embeddings (memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE, model TEXT NOT NULL, vector_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(memory_id, model));
   CREATE INDEX memory_embeddings_model ON memory_embeddings(model);`,
  `CREATE TABLE mission_workspaces (mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE, run_id TEXT NOT NULL, task_key TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('shared','worktree','shared_from')), base_workspace TEXT NOT NULL, path TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(run_id,task_key), FOREIGN KEY(run_id,task_key) REFERENCES mission_tasks(run_id,task_key) ON DELETE CASCADE);
   CREATE INDEX mission_workspaces_by_mission ON mission_workspaces(mission_id,created_at DESC);`,
  `ALTER TABLE tool_calls ADD COLUMN effect TEXT NOT NULL DEFAULT 'read';
   ALTER TABLE tool_calls ADD COLUMN execution_scope TEXT;
   ALTER TABLE tool_calls ADD COLUMN request_hash TEXT;
   UPDATE tool_calls SET effect='external' WHERE name IN ('file_create','file_patch','file_delete','file_move','office_create','office_edit','run_process','git_create_branch','github_issue_comment','github_create_pull_request','github_create_review_comment','github_workflow_dispatch','github_merge_pull_request') OR (name LIKE 'mcp_%' AND name NOT LIKE '%_resources' AND name NOT LIKE '%_read_resource' AND name NOT LIKE '%_prompts' AND name NOT LIKE '%_get_prompt');
   UPDATE tool_calls SET execution_scope=COALESCE((SELECT run_id||':'||task_key FROM mission_tasks WHERE mission_tasks.session_id=tool_calls.session_id LIMIT 1),session_id) WHERE effect='external' AND execution_scope IS NULL;
   UPDATE tool_calls SET status='uncertain',finished_at=COALESCE(finished_at,CURRENT_TIMESTAMP) WHERE status='running' AND effect='external';
   CREATE UNIQUE INDEX tool_calls_external_idempotency ON tool_calls(execution_scope,request_hash) WHERE effect='external' AND execution_scope IS NOT NULL AND request_hash IS NOT NULL;`,
  `CREATE TABLE process_job_specs (job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE, command TEXT NOT NULL, args_json TEXT NOT NULL, cwd TEXT NOT NULL);
   CREATE TABLE process_job_control (job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE, cancel_requested INTEGER NOT NULL DEFAULT 0);`,
  `ALTER TABLE process_job_specs ADD COLUMN interactive INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE process_job_inputs (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, input TEXT NOT NULL, close_stdin INTEGER NOT NULL DEFAULT 0);`,
  `ALTER TABLE process_job_control ADD COLUMN stdin_close_requested INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE process_job_specs ADD COLUMN pty INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE process_job_specs ADD COLUMN cols INTEGER NOT NULL DEFAULT 80;
   ALTER TABLE process_job_specs ADD COLUMN rows INTEGER NOT NULL DEFAULT 24;
   CREATE TABLE process_job_resizes (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, cols INTEGER NOT NULL, rows INTEGER NOT NULL);`,
  `UPDATE tool_calls SET effect='external' WHERE name IN ('git_clone','git_stage','git_commit','git_fetch','git_push');
   UPDATE tool_calls SET execution_scope=COALESCE((SELECT run_id||':'||task_key FROM mission_tasks WHERE mission_tasks.session_id=tool_calls.session_id LIMIT 1),session_id) WHERE effect='external' AND execution_scope IS NULL;
   UPDATE tool_calls SET status='uncertain',finished_at=COALESCE(finished_at,CURRENT_TIMESTAMP) WHERE status='running' AND effect='external';`,
  `CREATE TABLE session_compactions (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, through_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, summary_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(session_id,through_message_id));
    CREATE INDEX session_compactions_recent ON session_compactions(session_id,created_at DESC);`,
  `UPDATE tool_calls SET effect='external' WHERE name IN ('github_issue_labels_add','github_issue_labels_replace','github_issue_label_remove','github_update_pull_request');
   UPDATE tool_calls SET execution_scope=COALESCE((SELECT run_id||':'||task_key FROM mission_tasks WHERE mission_tasks.session_id=tool_calls.session_id LIMIT 1),session_id) WHERE effect='external' AND execution_scope IS NULL;
   UPDATE tool_calls SET status='uncertain',finished_at=COALESCE(finished_at,CURRENT_TIMESTAMP) WHERE status='running' AND effect='external';`
];

export type DatabaseIntegrityReport = { path: string; status: "healthy" | "corrupt" | "missing" | "unavailable"; details?: string[]; error?: string };

/** Check an existing database without applying migrations or changing its contents. */
export function inspectDatabaseIntegrity(path: string): DatabaseIntegrityReport {
  const absolute = resolve(path);
  if (!existsSync(absolute)) return { path: absolute, status: "missing" };
  let db: Database.Database | undefined;
  try {
    db = new Database(absolute, { readonly: true, fileMustExist: true });
    const rows = db.pragma("quick_check") as Array<{ quick_check: string }>;
    const details = rows.map((row) => row.quick_check);
    return details.length === 1 && details[0] === "ok"
      ? { path: absolute, status: "healthy", details }
      : { path: absolute, status: "corrupt", details };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: string })?.code;
    return code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB" || /database disk image is malformed|file is not a database/i.test(message)
      ? { path: absolute, status: "corrupt", error: message }
      : { path: absolute, status: "unavailable", error: message };
  } finally {
    db?.close();
  }
}

export class XystStore {
  readonly db: Database.Database;

  constructor(path: string) {
    const absolute = resolve(path);
    mkdirSync(dirname(absolute), { recursive: true });
    this.db = new Database(absolute);
    try {
      this.db.pragma("busy_timeout = 10000");
      this.setJournalModeWithRetry();
      this.db.pragma("foreign_keys = ON");
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private setJournalModeWithRetry(): void {
    let delayMs = 25;
    for (let attempt = 0; ; attempt++) {
      try {
        this.db.pragma("journal_mode = WAL");
        return;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if ((code !== "SQLITE_BUSY" && code !== "SQLITE_LOCKED") || attempt >= 9) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
        delayMs = Math.min(delayMs * 2, 500);
      }
    }
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (let index = 0; index < migrations.length; index++) {
      const version = index + 1;
      const applyMigration = this.db.transaction(() => {
        const current = (this.db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number }).version;
        if (current >= version) return;
        if (current !== version - 1) throw new Error(`Database migration sequence is inconsistent at version ${current}`);
        this.db.exec(migrations[index]!);
        this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(version, new Date().toISOString());
      });
      applyMigration.immediate();
    }
  }

  close(): void { this.db.close(); }
}

export type SettingScope = "global" | "project" | "mission" | "agent" | "session";
export interface EffectiveSetting<T = unknown> { value: T; source: SettingScope; scopeId: string }

const sensitiveSettingKey = /token|secret|password|credential|api.?key|authorization|cookie/i;

function containsSensitiveSettingField(value: unknown): boolean {
  const pending: unknown[] = [value];
  const visited = new Set<object>();
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (/\b(?:bearer|basic)\s+[-A-Za-z0-9._~+/]+=*/i.test(current) || /https?:\/\/[^/\s:@]+:[^/\s@]+@/i.test(current) || /[?&](?:access[_-]?token|api[_-]?key|password|secret)=/i.test(current)) return true;
      continue;
    }
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);
    if (Array.isArray(current)) {
      for (const child of current) pending.push(child);
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      if (sensitiveSettingKey.test(key)) return true;
      pending.push(child);
    }
  }
  return false;
}

export class ConfigStore {
  constructor(private readonly store: XystStore) {}

  set(scope: SettingScope, key: string, value: unknown, scopeId = ""): void {
    if (!key.trim() || key.length > 200) throw new Error("Setting key must contain 1–200 characters");
    validateSettingScope(scope, scopeId); validateSettingContext(key, scope); validateSettingValue(key, value);
    this.store.db.prepare(`INSERT INTO settings(scope, scope_id, key, value_json, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(scope, scope_id, key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
      .run(scope, scopeId, key, JSON.stringify(value), new Date().toISOString());
  }

  reset(scope: SettingScope, key: string, scopeId = ""): boolean {
    return this.store.db.prepare("DELETE FROM settings WHERE scope=? AND scope_id=? AND key=?").run(scope, scopeId, key).changes > 0;
  }

  resetScope(scope: SettingScope, scopeId = ""): number {
    return this.store.db.prepare("DELETE FROM settings WHERE scope=? AND scope_id=?").run(scope, scopeId).changes;
  }

  resolve<T>(key: string, scopes: Partial<Record<SettingScope, string>> = {}): EffectiveSetting<T> | undefined {
    const order: SettingScope[] = ["session", "agent", "mission", "project", "global"];
    for (const scope of order) {
      if (!supportedSettingScopes(key).includes(scope)) continue;
      const scopeId = scopes[scope] ?? "";
      const row = this.store.db.prepare("SELECT value_json FROM settings WHERE scope=? AND scope_id=? AND key=?").get(scope, scopeId, key) as { value_json: string } | undefined;
      if (row) { const value = JSON.parse(row.value_json) as T; validateSettingValue(key, value); return { value, source: scope, scopeId }; }
    }
    return undefined;
  }

  export(): Record<string, Record<string, unknown>> {
    const rows = this.store.db.prepare("SELECT scope, scope_id, key, value_json FROM settings ORDER BY scope, scope_id, key").all() as Array<{ scope: string; scope_id: string; key: string; value_json: string }>;
    const result: Record<string, Record<string, unknown>> = {};
    for (const row of rows) {
      if (!supportedSettingScopes(row.key).includes(row.scope as SettingScope)) continue;
      const value = JSON.parse(row.value_json) as unknown;
      if (sensitiveSettingKey.test(row.key) || containsSensitiveSettingField(value)) continue;
      const bucket = `${row.scope}:${row.scope_id}`;
      (result[bucket] ??= {})[row.key] = value;
    }
    return result;
  }

  import(values: Record<string, Record<string, unknown>>): void {
    const allowed = new Set<SettingScope>(["global", "project", "mission", "agent", "session"]);
    const tx = this.store.db.transaction(() => {
      for (const [bucket, entries] of Object.entries(values)) {
        const separator = bucket.indexOf(":");
        const scope = bucket.slice(0, separator) as SettingScope;
        if (separator < 0 || !allowed.has(scope)) throw new Error(`Invalid settings scope: ${bucket}`);
        const scopeId = bucket.slice(separator + 1);
        for (const [key, value] of Object.entries(entries)) {
          if (sensitiveSettingKey.test(key) || containsSensitiveSettingField(value)) continue;
          this.set(scope, key, value, scopeId);
        }
      }
    });
    tx();
  }
}

export class SessionStore {
  constructor(private readonly store: XystStore) {}
  create(title = "New session"): string {
    const name = title.trim(); if (!name || name.length > 160) throw new Error("Session title must contain 1–160 characters");
    const id = crypto.randomUUID(); const now = new Date().toISOString();
    this.store.db.prepare("INSERT INTO sessions(id,title,created_at,updated_at) VALUES(?,?,?,?)").run(id, name, now, now);
    return id;
  }
  list(): unknown[] { return this.store.db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC").all(); }
  rename(sessionId: string, title: string): void {
    const name = title.trim(); if (!name || name.length > 160) throw new Error("Session title must contain 1–160 characters");
    const result = this.store.db.prepare("UPDATE sessions SET title=?,updated_at=? WHERE id=?").run(name, new Date().toISOString(), sessionId);
    if (!result.changes) throw new Error(`Session not found: ${sessionId}`);
  }
  setStatus(sessionId: string, status: string): void { this.store.db.prepare("UPDATE sessions SET status=?, updated_at=? WHERE id=?").run(status, new Date().toISOString(), sessionId); }
  archive(sessionId: string): void {
    const result = this.store.db.prepare("UPDATE sessions SET status='archived',updated_at=? WHERE id=?").run(new Date().toISOString(), sessionId);
    if (!result.changes) throw new Error(`Session not found: ${sessionId}`);
  }
  fork(sessionId: string, title?: string): string {
    const source = this.store.db.prepare("SELECT title FROM sessions WHERE id=?").get(sessionId) as { title: string } | undefined;
    if (!source) throw new Error(`Session not found: ${sessionId}`);
    const forkTitle = title?.trim() || `${source.title} (fork)`;
    const id = this.create(forkTitle);
    const messages = this.store.db.prepare("SELECT role,content,created_at FROM messages WHERE session_id=? ORDER BY created_at,rowid").all(sessionId) as Array<{ role: string; content: string; created_at: string }>;
    const insert = this.store.db.prepare("INSERT INTO messages(id,session_id,role,content,created_at) VALUES(?,?,?,?,?)");
    const transaction = this.store.db.transaction(() => { for (const message of messages) insert.run(crypto.randomUUID(), id, message.role, message.content, message.created_at); });
    transaction();
    this.store.db.prepare("UPDATE sessions SET updated_at=? WHERE id=?").run(new Date().toISOString(), id);
    return id;
  }
  delete(sessionId: string): void {
    if (!this.store.db.prepare("SELECT 1 FROM sessions WHERE id=?").get(sessionId)) throw new Error(`Session not found: ${sessionId}`);
    if (this.store.db.prepare("SELECT 1 FROM mission_tasks WHERE session_id=? LIMIT 1").get(sessionId)) throw new Error("This session belongs to a mission task; archive it to preserve mission history");
    const transaction = this.store.db.transaction(() => {
      this.store.db.prepare("DELETE FROM tool_calls WHERE session_id=?").run(sessionId);
      this.store.db.prepare("DELETE FROM usage WHERE session_id=?").run(sessionId);
      this.store.db.prepare("DELETE FROM model_decisions WHERE session_id=?").run(sessionId);
      this.store.db.prepare("DELETE FROM jobs WHERE session_id=?").run(sessionId);
      this.store.db.prepare("DELETE FROM artifacts WHERE session_id=? OR job_id IN (SELECT id FROM jobs WHERE session_id=?)").run(sessionId, sessionId);
      this.store.db.prepare("DELETE FROM sessions WHERE id=?").run(sessionId);
    });
    transaction();
  }
  addMessage(sessionId: string, role: "user" | "assistant" | "system" | "tool", content: string): void {
    const now = new Date().toISOString();
    this.store.db.prepare("INSERT INTO messages(id,session_id,role,content,created_at) VALUES(?,?,?,?,?)").run(crypto.randomUUID(), sessionId, role, content, now);
    this.store.db.prepare("UPDATE sessions SET updated_at=? WHERE id=?").run(now, sessionId);
  }
  messages(sessionId: string): unknown[] { return this.store.db.prepare("SELECT * FROM messages WHERE session_id=? ORDER BY rowid").all(sessionId); }
  compactions(sessionId: string): Array<{ id: string; session_id: string; through_message_id: string; summary_json: string; created_at: string }> {
    return this.store.db.prepare("SELECT * FROM session_compactions WHERE session_id=? ORDER BY rowid").all(sessionId) as Array<{ id: string; session_id: string; through_message_id: string; summary_json: string; created_at: string }>;
  }
  addCompaction(sessionId: string, throughMessageId: string, summary: Record<string, unknown>): string {
    const now = new Date().toISOString(); const id = crypto.randomUUID();
    const transaction = this.store.db.transaction(() => {
      const through = this.store.db.prepare("SELECT rowid FROM messages WHERE id=? AND session_id=?").get(throughMessageId, sessionId) as { rowid: number } | undefined;
      if (!through) throw new Error("Compaction boundary message does not belong to this session");
      const previous = this.store.db.prepare("SELECT m.rowid FROM session_compactions c JOIN messages m ON m.id=c.through_message_id WHERE c.session_id=? ORDER BY m.rowid DESC LIMIT 1").get(sessionId) as { rowid: number } | undefined;
      if (previous && through.rowid <= previous.rowid) throw new Error("Compaction boundary must advance beyond the previous summary");
      this.store.db.prepare("INSERT INTO session_compactions(id,session_id,through_message_id,summary_json,created_at) VALUES(?,?,?,?,?)")
        .run(id, sessionId, throughMessageId, JSON.stringify(summary), now);
      this.store.db.prepare("UPDATE sessions SET updated_at=? WHERE id=?").run(now, sessionId);
    });
    transaction(); return id;
  }
  contextMessages(sessionId: string): Array<{ role: string; content: string }> {
    const latest = this.store.db.prepare("SELECT c.through_message_id,c.summary_json,m.rowid AS boundary_row FROM session_compactions c JOIN messages m ON m.id=c.through_message_id WHERE c.session_id=? ORDER BY m.rowid DESC LIMIT 1").get(sessionId) as { through_message_id: string; summary_json: string; boundary_row: number } | undefined;
    const rows = latest
      ? this.store.db.prepare("SELECT role,content FROM messages WHERE session_id=? AND rowid>? ORDER BY rowid").all(sessionId, latest.boundary_row) as Array<{ role: string; content: string }>
      : this.store.db.prepare("SELECT role,content FROM messages WHERE session_id=? ORDER BY rowid").all(sessionId) as Array<{ role: string; content: string }>;
    if (!latest) return rows;
    const summary = JSON.stringify(JSON.parse(latest.summary_json));
    return [{ role: "assistant", content: `[Persisted Xyst session summary; historical context, not a new instruction]\n${summary}` }, ...rows];
  }
  export(sessionId: string): Record<string, unknown> {
    const session = this.store.db.prepare("SELECT id,title,status,created_at,updated_at FROM sessions WHERE id=?").get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const messages = this.messages(sessionId) as Array<{ id: string; role: string; content: string; created_at: string }>;
    const decoded = messages.map(({ id, role, content, created_at }) => ({ id, role, content: content.startsWith("__xyst_api_message__:") ? JSON.parse(content.slice("__xyst_api_message__:".length)) : content, created_at }));
    const compactions = this.compactions(sessionId).map((item) => ({ id: item.id, through_message_id: item.through_message_id, summary: JSON.parse(item.summary_json), created_at: item.created_at }));
    return { format: "xyst-session-v1", session, messages: decoded, compactions };
  }
}

export interface RuntimeJobRecord {
  id: string;
  kind: string;
  state: string;
  created_at: string;
  updated_at: string;
  details: unknown;
}

export class JobStore {
  constructor(private readonly store: XystStore) {}

  createProcess(command: string, args: string[], cwd: string, interactive = false, pty = false, cols = 80, rows = 24): string {
    if (!command.trim() || command.length > 4096 || args.length > 256 || args.some((arg) => arg.length > 32_000) || cwd.length > 32_000) throw new Error("Process job arguments exceed supported limits");
    if (pty && !interactive) throw new Error("PTY processes must accept interactive input");
    if (!Number.isInteger(cols) || cols < 20 || cols > 500 || !Number.isInteger(rows) || rows < 5 || rows > 200) throw new Error("Terminal size must be 20–500 columns by 5–200 rows");
    const id = randomUUID(); const now = new Date().toISOString();
    const save = this.store.db.transaction(() => {
      const displayCommand = command.split(/[\\/]/).filter(Boolean).at(-1) ?? "process";
      this.store.db.prepare("INSERT INTO jobs(id,kind,state,details_json,created_at,updated_at) VALUES(?,'process','queued',?,?,?)").run(id, JSON.stringify({ command: displayCommand, cwd, interactive, pty, stdout: "", stderr: "", outputTruncated: false }), now, now);
      this.store.db.prepare("INSERT INTO process_job_specs(job_id,command,args_json,cwd,interactive,pty,cols,rows) VALUES(?,?,?,?,?,?,?,?)").run(id, command, JSON.stringify(args), cwd, interactive ? 1 : 0, pty ? 1 : 0, cols, rows);
      this.store.db.prepare("INSERT INTO process_job_control(job_id) VALUES(?)").run(id);
    });
    save.immediate(); return id;
  }

  processSpec(id: string): { command: string; args: string[]; cwd: string; interactive: boolean; pty: boolean; cols: number; rows: number } | undefined {
    const row = this.store.db.prepare("SELECT command,args_json,cwd,interactive,pty,cols,rows FROM process_job_specs WHERE job_id=?").get(id) as { command: string; args_json: string; cwd: string; interactive: number; pty: number; cols: number; rows: number } | undefined;
    if (!row) return undefined;
    try { const args = JSON.parse(row.args_json) as unknown; if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) return undefined; return { command: row.command, args, cwd: row.cwd, interactive: row.interactive === 1, pty: row.pty === 1, cols: row.cols, rows: row.rows }; } catch { return undefined; }
  }

  resizeProcess(id: string, cols: number, rows: number): void {
    if (!Number.isInteger(cols) || cols < 20 || cols > 500 || !Number.isInteger(rows) || rows < 5 || rows > 200) throw new Error("Terminal size must be 20–500 columns by 5–200 rows");
    const spec = this.processSpec(id); const job = this.show(id);
    if (!spec?.pty || !job) throw new Error(`No PTY process found with ID ${id}`);
    if (["completed", "failed", "cancelled"].includes(job.state)) throw new Error(`Process job is already ${job.state}`);
    const save = this.store.db.transaction(() => {
      this.store.db.prepare("DELETE FROM process_job_resizes WHERE job_id=?").run(id);
      this.store.db.prepare("INSERT INTO process_job_resizes(job_id,cols,rows) VALUES(?,?,?)").run(id, cols, rows);
      this.store.db.prepare("UPDATE process_job_specs SET cols=?,rows=? WHERE job_id=?").run(cols, rows, id);
    });
    save.immediate();
  }

  takeProcessResize(id: string): { cols: number; rows: number } | undefined {
    const take = this.store.db.transaction(() => {
      const size = this.store.db.prepare("SELECT cols,rows FROM process_job_resizes WHERE job_id=? ORDER BY id DESC LIMIT 1").get(id) as { cols: number; rows: number } | undefined;
      this.store.db.prepare("DELETE FROM process_job_resizes WHERE job_id=?").run(id);
      return size;
    });
    return take.immediate();
  }

  sendProcessInput(id: string, input: string, closeStdin = false): void {
    if (input.length > 32_000) throw new Error("Process input cannot exceed 32,000 characters per write");
    const row = this.store.db.prepare("SELECT state FROM jobs WHERE id=? AND kind='process'").get(id) as { state: string } | undefined;
    const spec = this.processSpec(id);
    if (!row || !spec) throw new Error(`Process job not found: ${id}`);
    if (!spec.interactive) throw new Error(`Process job is not interactive: ${id}`);
    if (["completed", "failed", "cancelled"].includes(row.state)) throw new Error(`Process job is already ${row.state}`);
    const queue = this.store.db.transaction(() => {
      const control = this.store.db.prepare("SELECT stdin_close_requested FROM process_job_control WHERE job_id=?").get(id) as { stdin_close_requested: number } | undefined;
      if (!control) throw new Error(`Process job control missing: ${id}`);
      if (control.stdin_close_requested) throw new Error("Process stdin has already been closed or queued for closing");
      const queued = this.store.db.prepare("SELECT COALESCE(SUM(length(input)),0) AS size FROM process_job_inputs WHERE job_id=?").get(id) as { size: number };
      if (queued.size + input.length > 512_000) throw new Error("Process input queue is full; wait for the running process to read input");
      this.store.db.prepare("INSERT INTO process_job_inputs(job_id,input,close_stdin) VALUES(?,?,?)").run(id, input, closeStdin ? 1 : 0);
      if (closeStdin) this.store.db.prepare("UPDATE process_job_control SET stdin_close_requested=1 WHERE job_id=?").run(id);
    });
    queue.immediate();
  }

  takeProcessInputs(id: string): Array<{ input: string; closeStdin: boolean }> {
    const take = this.store.db.transaction(() => {
      const rows = this.store.db.prepare("SELECT id,input,close_stdin FROM process_job_inputs WHERE job_id=? ORDER BY id").all(id) as Array<{ id: number; input: string; close_stdin: number }>;
      if (rows.length) this.store.db.prepare(`DELETE FROM process_job_inputs WHERE id IN (${rows.map(() => "?").join(",")})`).run(...rows.map((row) => row.id));
      return rows.map((row) => ({ input: row.input, closeStdin: row.close_stdin === 1 }));
    });
    return take.immediate();
  }

  updateProcess(id: string, state: string, patch: Record<string, unknown>): void {
    const row = this.store.db.prepare("SELECT details_json FROM jobs WHERE id=? AND kind='process'").get(id) as { details_json: string } | undefined;
    if (!row) throw new Error(`Process job not found: ${id}`);
    let current: Record<string, unknown> = {}; try { const value = JSON.parse(row.details_json) as unknown; if (value && typeof value === "object" && !Array.isArray(value)) current = value as Record<string, unknown>; } catch { /* Replace malformed prior details safely. */ }
    this.store.db.prepare("UPDATE jobs SET state=?,details_json=?,updated_at=? WHERE id=?").run(state, JSON.stringify({ ...current, ...patch }), new Date().toISOString(), id);
  }

  requestProcessCancel(id: string): boolean {
    const row = this.store.db.prepare("SELECT state FROM jobs WHERE id=? AND kind='process'").get(id) as { state: string } | undefined;
    if (!row) return false;
    if (["completed", "failed", "cancelled"].includes(row.state)) return false;
    this.store.db.prepare("UPDATE process_job_control SET cancel_requested=1 WHERE job_id=?").run(id);
    this.updateProcess(id, "cancelling", { cancellationRequested: true }); return true;
  }

  processCancelRequested(id: string): boolean {
    return Boolean((this.store.db.prepare("SELECT cancel_requested FROM process_job_control WHERE job_id=?").get(id) as { cancel_requested: number } | undefined)?.cancel_requested);
  }

  list(limit = 50): RuntimeJobRecord[] {
    const bounded = Math.max(1, Math.min(200, Math.floor(limit)));
    const records: RuntimeJobRecord[] = [];
    const decode = (json: string): unknown => { try { return JSON.parse(json); } catch { return { malformed: true }; } };
    const decodeObject = (json: string): Record<string, unknown> => { const value = decode(json); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : { value }; };
    const queue = this.store.db.prepare("SELECT id,kind,state,created_at,updated_at,details_json FROM jobs ORDER BY updated_at DESC LIMIT ?").all(bounded) as Array<{ id: string; kind: string; state: string; created_at: string; updated_at: string; details_json: string }>;
    records.push(...queue.map((row) => ({ id: row.id, kind: row.kind, state: row.state, created_at: row.created_at, updated_at: row.updated_at, details: decode(row.details_json) })));
    const downloads = this.store.db.prepare("SELECT id,state,created_at,updated_at,details_json,repository,revision,quantization,lm_job_id,total_size_bytes FROM model_downloads ORDER BY updated_at DESC LIMIT ?").all(bounded) as Array<{ id: string; state: string; created_at: string; updated_at: string; details_json: string; repository: string; revision: string; quantization: string | null; lm_job_id: string | null; total_size_bytes: number | null }>;
    records.push(...downloads.map((row) => ({ id: row.id, kind: "model-download", state: row.state, created_at: row.created_at, updated_at: row.updated_at, details: { ...decodeObject(row.details_json), repository: row.repository, revision: row.revision, quantization: row.quantization, lmJobId: row.lm_job_id, totalSizeBytes: row.total_size_bytes } })));
    const runs = this.store.db.prepare("SELECT id,mission_id,state,trigger_type,scheduled_for,started_at,finished_at,heartbeat_at,error FROM mission_runs ORDER BY COALESCE(finished_at,heartbeat_at,started_at) DESC LIMIT ?").all(bounded) as Array<{ id: string; mission_id: string; state: string; trigger_type: string; scheduled_for: string | null; started_at: string; finished_at: string | null; heartbeat_at: string; error: string | null }>;
    records.push(...runs.map((row) => ({ id: row.id, kind: "mission-run", state: row.state, created_at: row.started_at, updated_at: row.finished_at ?? row.heartbeat_at, details: { missionId: row.mission_id, trigger: row.trigger_type, scheduledFor: row.scheduled_for, heartbeatAt: row.heartbeat_at, error: row.error } })));
    return records.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, bounded);
  }

  show(id: string): RuntimeJobRecord | undefined {
    const fromQueue = this.store.db.prepare("SELECT id,kind,state,created_at,updated_at,details_json FROM jobs WHERE id=?").get(id) as { id: string; kind: string; state: string; created_at: string; updated_at: string; details_json: string } | undefined;
    if (fromQueue) { try { return { id: fromQueue.id, kind: fromQueue.kind, state: fromQueue.state, created_at: fromQueue.created_at, updated_at: fromQueue.updated_at, details: JSON.parse(fromQueue.details_json) as unknown }; } catch { return { id: fromQueue.id, kind: fromQueue.kind, state: fromQueue.state, created_at: fromQueue.created_at, updated_at: fromQueue.updated_at, details: { malformed: true } }; } }
    const download = this.store.db.prepare("SELECT id,state,created_at,updated_at,details_json,repository,revision,quantization,lm_job_id,total_size_bytes FROM model_downloads WHERE id=? OR lm_job_id=? ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1").get(id, id, id) as { id: string; state: string; created_at: string; updated_at: string; details_json: string; repository: string; revision: string; quantization: string | null; lm_job_id: string | null; total_size_bytes: number | null } | undefined;
    if (download) {
      let details: Record<string, unknown>;
      try { const value = JSON.parse(download.details_json) as unknown; details = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : { value }; } catch { details = { malformed: true }; }
      return { id: download.id, kind: "model-download", state: download.state, created_at: download.created_at, updated_at: download.updated_at, details: { ...details, repository: download.repository, revision: download.revision, quantization: download.quantization, lmJobId: download.lm_job_id, totalSizeBytes: download.total_size_bytes } };
    }
    const run = this.store.db.prepare("SELECT id,mission_id,state,trigger_type,scheduled_for,started_at,finished_at,heartbeat_at,error FROM mission_runs WHERE id=?").get(id) as { id: string; mission_id: string; state: string; trigger_type: string; scheduled_for: string | null; started_at: string; finished_at: string | null; heartbeat_at: string; error: string | null } | undefined;
    if (!run) return undefined;
    return { id: run.id, kind: "mission-run", state: run.state, created_at: run.started_at, updated_at: run.finished_at ?? run.heartbeat_at, details: { missionId: run.mission_id, trigger: run.trigger_type, scheduledFor: run.scheduled_for, heartbeatAt: run.heartbeat_at, error: run.error } };
  }
}

export type MemoryKind = "preference" | "note" | "inferred";
export interface MemoryRecord { id: string; kind: MemoryKind; content: string; source: string; created_at: string; updated_at: string }

export class MemoryStore {
  constructor(private readonly store: XystStore) {}

  list(limit = 200): MemoryRecord[] {
    return this.store.db.prepare("SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?").all(Math.max(1, Math.min(limit, 500))) as MemoryRecord[];
  }
  search(query: string, limit = 30): MemoryRecord[] {
    const term = query.trim(); if (!term) return [];
    return this.store.db.prepare("SELECT * FROM memories WHERE instr(lower(content), lower(?)) > 0 ORDER BY updated_at DESC LIMIT ?").all(term, Math.max(1, Math.min(limit, 100))) as MemoryRecord[];
  }
  embeddings(model: string): Array<{ id: string; vector: number[] }> {
    const rows = this.store.db.prepare("SELECT memory_id,vector_json FROM memory_embeddings WHERE model=?").all(model) as Array<{ memory_id: string; vector_json: string }>;
    return rows.flatMap((row) => { try { const vector = JSON.parse(row.vector_json) as unknown; return Array.isArray(vector) && vector.every((value) => typeof value === "number" && Number.isFinite(value)) ? [{ id: row.memory_id, vector }] : []; } catch { return []; } });
  }
  setEmbedding(memoryId: string, model: string, vector: number[], expectedContent?: string): boolean {
    if (!vector.length || vector.length > 65_536 || vector.some((value) => !Number.isFinite(value))) throw new Error("Embedding vector must contain finite numbers within the supported size");
    const save = this.store.db.transaction(() => {
      const current = this.store.db.prepare("SELECT content FROM memories WHERE id=?").get(memoryId) as { content: string } | undefined;
      if (!current || (expectedContent !== undefined && current.content !== expectedContent)) return false;
      const now = new Date().toISOString();
      this.store.db.prepare(`INSERT INTO memory_embeddings(memory_id,model,vector_json,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(memory_id,model) DO UPDATE SET vector_json=excluded.vector_json,updated_at=excluded.updated_at`).run(memoryId, model, JSON.stringify(vector), now);
      return true;
    });
    return save.immediate();
  }
  searchSemantic(queryVector: number[], model: string, limit = 30): Array<MemoryRecord & { similarity: number }> {
    if (!queryVector.length || queryVector.some((value) => !Number.isFinite(value))) return [];
    const queryNorm = Math.sqrt(queryVector.reduce((sum, value) => sum + value * value, 0)); if (!queryNorm) return [];
    const rows = this.store.db.prepare(`SELECT m.*,e.vector_json FROM memory_embeddings e JOIN memories m ON m.id=e.memory_id WHERE e.model=?`).all(model) as Array<MemoryRecord & { vector_json: string }>;
    return rows.flatMap((row) => {
      let vector: unknown; try { vector = JSON.parse(row.vector_json); } catch { return []; }
      if (!Array.isArray(vector) || vector.length !== queryVector.length || !vector.every((value) => typeof value === "number" && Number.isFinite(value))) return [];
      const candidate = vector as number[]; const norm = Math.sqrt(candidate.reduce((sum, value) => sum + value * value, 0)); if (!norm) return [];
      const similarity = candidate.reduce((sum, value, index) => sum + value * queryVector[index]!, 0) / (norm * queryNorm);
      const { vector_json: _ignored, ...record } = row; return [{ ...record, similarity }];
    }).sort((left, right) => right.similarity - left.similarity).slice(0, Math.max(1, Math.min(limit, 100)));
  }
  add(kind: MemoryKind, content: string, source = "user"): MemoryRecord {
    if (!["preference", "note", "inferred"].includes(kind)) throw new Error("Memory kind must be preference, note, or inferred");
    const text = content.trim(); if (!text || text.length > 20_000) throw new Error("Memory content must be between 1 and 20,000 characters");
    if (/\b(?:api[_ -]?key|token|password|secret)\s*[:=]/i.test(text)) throw new Error("Memory entries cannot contain credential-like values");
    const now = new Date().toISOString(); const record = { id: randomUUID(), kind, content: text, source: source.slice(0, 80), created_at: now, updated_at: now };
    this.store.db.prepare("INSERT INTO memories(id,kind,content,source,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(record.id, record.kind, record.content, record.source, now, now);
    return record;
  }
  update(id: string, content: string): MemoryRecord {
    const text = content.trim(); if (!text || text.length > 20_000) throw new Error("Memory content must be between 1 and 20,000 characters");
    if (/\b(?:api[_ -]?key|token|password|secret)\s*[:=]/i.test(text)) throw new Error("Memory entries cannot contain credential-like values");
    return this.store.db.transaction(() => {
      const now = new Date().toISOString(); const result = this.store.db.prepare("UPDATE memories SET content=?,updated_at=? WHERE id=?").run(text, now, id);
      if (!result.changes) throw new Error(`Memory not found: ${id}`);
      this.store.db.prepare("DELETE FROM memory_embeddings WHERE memory_id=?").run(id);
      return this.store.db.prepare("SELECT * FROM memories WHERE id=?").get(id) as MemoryRecord;
    }).immediate();
  }
  delete(id: string): void {
    const result = this.store.db.prepare("DELETE FROM memories WHERE id=?").run(id);
    if (!result.changes) throw new Error(`Memory not found: ${id}`);
  }
}
