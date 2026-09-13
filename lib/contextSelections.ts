/**
 * Context Selector data layer (VYRON_CODE_V01_GIT_AND_EXPLICIT_CONTEXT_IMPLEMENTATION_AUTHORIZATION).
 *
 * Stores ONLY metadata about a user's explicit context selections — never the selected
 * file/diff content itself, never a prompt, never a token. The actual bounded content is
 * re-read fresh from disk/git every time it's needed (add-time preview, Inspector preview,
 * attach-time revalidation, prompt-submit-time revalidation) via lib/contextContent.ts, and
 * compared against the `content_fingerprint` recorded here to detect staleness.
 *
 * All four hard budget numbers below are enforced ONLY here, server-side, against rows this
 * module itself counted from the database — a client-supplied count/size is never trusted
 * for any limit decision anywhere in this codebase.
 */
import crypto from "node:crypto";
import { getDb, newId } from "./db";

export const MAX_ITEMS = 8;
export const MAX_ITEM_CHARS = 12_000;
export const MAX_AGGREGATE_CHARS = 48_000;
export const MAX_AGGREGATE_TOKENS = 12_000;

export type ContextKind = "file_snippet" | "git_diff_hunk";

export type ContextSelectionRow = {
  id: string;
  sessionId: string;
  projectId: string;
  kind: ContextKind;
  pathOrRef: string;
  rangeOrHunk: string | null;
  contentFingerprint: string;
  charCount: number;
  tokenEstimate: number;
  attached: boolean;
  attachedAt: number | null;
  createdAt: number;
};

function rowToSelection(row: any): ContextSelectionRow {
  return {
    id: row.id,
    sessionId: row.session_id,
    projectId: row.project_id,
    kind: row.kind,
    pathOrRef: row.path_or_ref,
    rangeOrHunk: row.range_or_hunk,
    contentFingerprint: row.content_fingerprint,
    charCount: row.char_count,
    tokenEstimate: row.token_estimate,
    attached: !!row.attached,
    attachedAt: row.attached_at,
    createdAt: row.created_at,
  };
}

export function fingerprintOf(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/** Deliberately crude (chars/4, rounded up) — a conservative overestimate is safer than an
 * exact tokenizer here, since this number only ever gates a hard budget, never billing. */
export function estimateTokens(charCount: number): number {
  return Math.ceil(charCount / 4);
}

export function listContextSelections(sessionId: string): ContextSelectionRow[] {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM context_selections WHERE session_id = ? ORDER BY created_at ASC`).all(sessionId) as any[];
  return rows.map(rowToSelection);
}

export function getContextSelection(sessionId: string, id: string): ContextSelectionRow | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM context_selections WHERE session_id = ? AND id = ?`).get(sessionId, id) as any;
  return row ? rowToSelection(row) : null;
}

export function listAttachedContextSelections(sessionId: string): ContextSelectionRow[] {
  return listContextSelections(sessionId).filter((r) => r.attached);
}

export type AggregateStats = { count: number; totalChars: number; totalTokens: number };

export function aggregateStats(sessionId: string): AggregateStats {
  const items = listContextSelections(sessionId);
  return {
    count: items.length,
    totalChars: items.reduce((sum, i) => sum + i.charCount, 0),
    totalTokens: items.reduce((sum, i) => sum + i.tokenEstimate, 0),
  };
}

export type BudgetRejectionReason =
  | "item_limit_reached"
  | "content_too_large"
  | "aggregate_char_limit_exceeded"
  | "aggregate_token_limit_exceeded";

/** Checks whether one more item of the given size could be added to this session's context
 * without exceeding any of the four hard limits. Does not itself insert anything. */
export function checkBudget(sessionId: string, additionalChars: number): { ok: true } | { ok: false; reason: BudgetRejectionReason } {
  if (additionalChars > MAX_ITEM_CHARS) return { ok: false, reason: "content_too_large" };
  const current = aggregateStats(sessionId);
  if (current.count >= MAX_ITEMS) return { ok: false, reason: "item_limit_reached" };
  if (current.totalChars + additionalChars > MAX_AGGREGATE_CHARS) return { ok: false, reason: "aggregate_char_limit_exceeded" };
  const additionalTokens = estimateTokens(additionalChars);
  if (current.totalTokens + additionalTokens > MAX_AGGREGATE_TOKENS) return { ok: false, reason: "aggregate_token_limit_exceeded" };
  return { ok: true };
}

export function insertContextSelection(params: {
  sessionId: string;
  projectId: string;
  kind: ContextKind;
  pathOrRef: string;
  rangeOrHunk: string | null;
  content: string;
}): { ok: true; item: ContextSelectionRow } | { ok: false; reason: BudgetRejectionReason } {
  const charCount = params.content.length;
  const budget = checkBudget(params.sessionId, charCount);
  if (!budget.ok) return budget;

  const db = getDb();
  const id = newId();
  const now = Date.now();
  const tokenEstimate = estimateTokens(charCount);
  const fingerprint = fingerprintOf(params.content);
  db.prepare(
    `INSERT INTO context_selections
       (id, session_id, project_id, kind, path_or_ref, range_or_hunk, content_fingerprint, char_count, token_estimate, attached, attached_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`
  ).run(id, params.sessionId, params.projectId, params.kind, params.pathOrRef, params.rangeOrHunk, fingerprint, charCount, tokenEstimate, now);

  return {
    ok: true,
    item: {
      id,
      sessionId: params.sessionId,
      projectId: params.projectId,
      kind: params.kind,
      pathOrRef: params.pathOrRef,
      rangeOrHunk: params.rangeOrHunk,
      contentFingerprint: fingerprint,
      charCount,
      tokenEstimate,
      attached: false,
      attachedAt: null,
      createdAt: now,
    },
  };
}

/** Scoped to the given session — a caller can never remove another session's item even if
 * it somehow guessed the id. */
export function removeContextSelection(sessionId: string, id: string): boolean {
  const db = getDb();
  const result = db.prepare(`DELETE FROM context_selections WHERE session_id = ? AND id = ?`).run(sessionId, id);
  return result.changes > 0;
}

export function clearContextSelections(sessionId: string): number {
  const db = getDb();
  const result = db.prepare(`DELETE FROM context_selections WHERE session_id = ?`).run(sessionId);
  return Number(result.changes);
}

export function setAttached(sessionId: string, ids: string[], attached: boolean): void {
  const db = getDb();
  const now = Date.now();
  const stmt = db.prepare(`UPDATE context_selections SET attached = ?, attached_at = ? WHERE session_id = ? AND id = ?`);
  for (const id of ids) stmt.run(attached ? 1 : 0, attached ? now : null, sessionId, id);
}

export function detachAll(sessionId: string): void {
  const db = getDb();
  db.prepare(`UPDATE context_selections SET attached = 0, attached_at = NULL WHERE session_id = ?`).run(sessionId);
}

/** The exact JSON shapes stored in `range_or_hunk` — the single source of truth both the
 * add-selection route and the revalidation path parse against. */
export type FileRange = { startLine: number; endLine: number };
export type HunkRef = { header: string; index: number };

export function serializeFileRange(range: FileRange): string {
  return JSON.stringify(range);
}

export function serializeHunkRef(ref: HunkRef): string {
  return JSON.stringify(ref);
}

export function parseFileRange(raw: string | null): FileRange | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.startLine === "number" && typeof parsed?.endLine === "number") return parsed;
    return null;
  } catch {
    return null;
  }
}

export function parseHunkRef(raw: string | null): HunkRef | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.header === "string" && typeof parsed?.index === "number") return parsed;
    return null;
  } catch {
    return null;
  }
}
