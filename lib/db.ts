/**
 * Local SQLite store for Vyron Code's own state (projects, sessions, context selections,
 * audit log). Never shares a file or schema with Bridge's audit.jsonl, OmniRoute's
 * storage.sqlite, or any Hermes Agent/deliberation-service data. Uses Node's built-in
 * node:sqlite (DatabaseSync) — no native build step required.
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "vyroncode.sqlite");

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (_db) return _db;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      canonical_root TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      opened_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      hermes_session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      title TEXT
    );
    CREATE TABLE IF NOT EXISTS context_selections (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      kind TEXT NOT NULL CHECK (kind IN ('file_snippet','git_diff_hunk','project_state_field','memory_field')),
      path_or_ref TEXT NOT NULL,
      range_or_hunk TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      action_kind TEXT NOT NULL,
      target TEXT NOT NULL,
      status TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
  `);
  migrateSessionsTable(_db);
  migrateContextSelectionsTable(_db);
  return _db;
}

/**
 * Additive-only migration (VYRON_CODE_V01_CORE_READONLY_UI_IMPLEMENTATION_AUTHORIZATION):
 * adds conversation-list metadata columns to an existing `sessions` table without touching
 * any existing row. Safe to run on every startup — checks `PRAGMA table_info` first and
 * only ALTERs columns that are actually missing, so it never fails on a table that already
 * has them (unlike a bare `ALTER TABLE ... ADD COLUMN`, which errors if the column exists).
 * No column ever stores a token/credential — only local, safe conversation metadata
 * (status, timestamps, message_count). Rollback: drop these four columns; SQLite's
 * `ALTER TABLE ... DROP COLUMN` (3.35+) removes them without touching `id`/`project_id`/
 * `hermes_session_id`/`created_at`/`title` or any other table.
 */
function migrateSessionsTable(db: DatabaseSync): void {
  const columns = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
  const existing = new Set(columns.map((c) => c.name));
  const wanted: Array<[string, string]> = [
    ["status", "TEXT NOT NULL DEFAULT 'active'"],
    ["updated_at", "INTEGER"],
    ["last_activity_at", "INTEGER"],
    ["message_count", "INTEGER NOT NULL DEFAULT 0"],
  ];
  for (const [name, ddl] of wanted) {
    if (!existing.has(name)) db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${ddl}`);
  }
}

/**
 * Additive-only migration (VYRON_CODE_V01_GIT_AND_EXPLICIT_CONTEXT_IMPLEMENTATION_AUTHORIZATION):
 * adds Context Selector/Inspector/Attach metadata columns to the pre-existing
 * `context_selections` table without touching any existing row or the table's original
 * `kind` CHECK constraint (SQLite cannot ALTER a CHECK constraint in place, and this table
 * has never held any row from any shipped UI, so widening it is unnecessary — the new UI
 * only ever inserts 'file_snippet' (used for both a File Viewer selection AND a search-result
 * selection, since both are fundamentally "a path plus a line range in a text file") or
 * 'git_diff_hunk'; 'project_state_field'/'memory_field' remain in the constraint's allowed
 * set for backward compatibility but are never written by this or any other route).
 *
 * None of these columns ever hold raw file/diff content, a prompt, or a token — only safe,
 * local metadata: which project the selection belongs to (for cross-project rejection),
 * a SHA-256 fingerprint of the selected content at add-time (for stale/change detection —
 * re-computed fresh from disk/git at every attach and every prompt submission, never trusted
 * from the browser), its character/token-estimate size (for the hard context budget), and
 * whether it is currently part of the "attach" set for its session's next prompt submission.
 *
 * Rollback: drop these five columns (`ALTER TABLE ... DROP COLUMN`, SQLite 3.35+) without
 * touching `id`/`session_id`/`kind`/`path_or_ref`/`range_or_hunk`/`created_at` or any other
 * table.
 */
function migrateContextSelectionsTable(db: DatabaseSync): void {
  const columns = db.prepare(`PRAGMA table_info(context_selections)`).all() as Array<{ name: string }>;
  const existing = new Set(columns.map((c) => c.name));
  const wanted: Array<[string, string]> = [
    ["project_id", "TEXT"],
    ["content_fingerprint", "TEXT"],
    ["char_count", "INTEGER NOT NULL DEFAULT 0"],
    ["token_estimate", "INTEGER NOT NULL DEFAULT 0"],
    ["attached", "INTEGER NOT NULL DEFAULT 0"],
    ["attached_at", "INTEGER"],
  ];
  for (const [name, ddl] of wanted) {
    if (!existing.has(name)) db.exec(`ALTER TABLE context_selections ADD COLUMN ${name} ${ddl}`);
  }
}

export function newId(): string {
  return crypto.randomUUID();
}

export function recordAudit(projectId: string | null, actionKind: string, target: string, status: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO audit_log (id, project_id, action_kind, target, status, ts) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(newId(), projectId, actionKind, target, status, Date.now());
}
