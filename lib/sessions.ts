import { getDb } from "./db";

/**
 * Persisted, coarse conversation status — distinct from ChatPanel's fine-grained client-side
 * state machine (idle/connecting/submitting/streaming/waiting_for_provider/…), which is
 * ephemeral UI state and never written here. Only these terminal-ish states are persisted,
 * per VYRON_CODE_V01_CORE_READONLY_UI_IMPLEMENTATION_AUTHORIZATION's metadata field list
 * ("interrupt/completed/error state").
 */
export type SessionStatus = "active" | "interrupted" | "completed" | "error";

export type SessionRow = {
  id: string;
  projectId: string;
  hermesSessionId: string;
  createdAt: number;
  title: string | null;
  status: SessionStatus;
  updatedAt: number | null;
  lastActivityAt: number | null;
  messageCount: number;
};

function rowToSession(row: any): SessionRow {
  return {
    id: row.id,
    projectId: row.project_id,
    hermesSessionId: row.hermes_session_id,
    createdAt: row.created_at,
    title: row.title,
    status: row.status as SessionStatus,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    messageCount: row.message_count,
  };
}

export function getSession(localSessionId: string): SessionRow | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(localSessionId) as any;
  return row ? rowToSession(row) : null;
}

/** Resolves a live Hermes session id back to its local row — used only by server-side
 * event-driven persistence (lib/hermesEvents.ts), never exposed to the browser directly. */
export function getSessionByHermesId(hermesSessionId: string): SessionRow | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM sessions WHERE hermes_session_id = ?`).get(hermesSessionId) as any;
  return row ? rowToSession(row) : null;
}

/** Conversation list for one project, newest activity first — server-side project_id scoping
 * is the only thing that keeps one project's conversations from appearing under another's. */
export function listSessionsForProject(projectId: string): SessionRow[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM sessions WHERE project_id = ? ORDER BY COALESCE(last_activity_at, created_at) DESC`)
    .all(projectId) as any[];
  return rows.map(rowToSession);
}

export function touchSessionActivity(localSessionId: string): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(`UPDATE sessions SET last_activity_at = ?, updated_at = ?, message_count = message_count + 1 WHERE id = ?`).run(
    now,
    now,
    localSessionId
  );
}

export function setSessionStatus(localSessionId: string, status: SessionStatus): void {
  const db = getDb();
  db.prepare(`UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?`).run(status, Date.now(), localSessionId);
}

export function renameSession(localSessionId: string, title: string): void {
  const db = getDb();
  db.prepare(`UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`).run(title.slice(0, 200), Date.now(), localSessionId);
}
