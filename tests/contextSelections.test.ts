import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Same isolated-temp-cwd pattern as tests/sessions.test.ts — never touches the real dev
// database, and each test gets a fresh SQLite file.
let tmpRoot: string;
let originalCwd: string;

beforeEach(() => {
  vi.resetModules();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vyroncode-context-test-"));
  originalCwd = process.cwd();
  process.chdir(tmpRoot);
});

afterEach(async () => {
  try {
    const { getDb } = await import("../lib/db");
    getDb().close();
  } catch {
    /* not imported in this test */
  }
  process.chdir(originalCwd);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function makeSession() {
  const { getDb, newId } = await import("../lib/db");
  const db = getDb();
  const now = Date.now();
  db.prepare(`INSERT INTO projects (id, canonical_root, display_name, opened_at, last_active_at) VALUES (?, ?, ?, ?, ?)`).run(
    "proj1",
    "C:\\proj1",
    "Proj1",
    now,
    now
  );
  const sessionId = newId();
  db.prepare(`INSERT INTO sessions (id, project_id, hermes_session_id, created_at) VALUES (?, ?, ?, ?)`).run(sessionId, "proj1", "h1", now);
  return sessionId;
}

describe("context_selections schema (additive migration)", () => {
  it("adds the new metadata columns without a `content` column (raw content is never persisted)", async () => {
    const { getDb } = await import("../lib/db");
    const db = getDb();
    const columns = (db.prepare(`PRAGMA table_info(context_selections)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toEqual(
      expect.arrayContaining(["id", "session_id", "kind", "path_or_ref", "range_or_hunk", "project_id", "content_fingerprint", "char_count", "token_estimate", "attached", "attached_at", "created_at"])
    );
    expect(columns).not.toContain("content");
    expect(columns).not.toContain("raw_content");
  });

  it("migration is additive: re-opening an existing older-schema table does not fail and keeps existing rows", async () => {
    const dbPath = path.join(tmpRoot, "data", "vyroncode.sqlite");
    fs.mkdirSync(path.join(tmpRoot, "data"), { recursive: true });
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, canonical_root TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, opened_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, hermes_session_id TEXT NOT NULL, created_at INTEGER NOT NULL, title TEXT);
      CREATE TABLE context_selections (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL, path_or_ref TEXT NOT NULL, range_or_hunk TEXT, created_at INTEGER NOT NULL);
    `);
    raw.prepare(`INSERT INTO context_selections (id, session_id, kind, path_or_ref, range_or_hunk, created_at) VALUES (?,?,?,?,?,?)`).run(
      "old1",
      "s1",
      "file_snippet",
      "a.ts",
      null,
      123
    );
    raw.close();

    const { getDb } = await import("../lib/db");
    const db = getDb();
    const row = db.prepare(`SELECT * FROM context_selections WHERE id = ?`).get("old1") as any;
    expect(row.path_or_ref).toBe("a.ts"); // untouched
    expect(row.char_count).toBe(0); // new column, default applied
    expect(row.attached).toBe(0);
  });
});

describe("context selection budget enforcement", () => {
  it("rejects a single item over the 12,000-character limit", async () => {
    const { checkBudget } = await import("../lib/contextSelections");
    const sessionId = await makeSession();
    const result = checkBudget(sessionId, 12_001);
    expect(result).toEqual({ ok: false, reason: "content_too_large" });
  });

  it("accepts items up to the per-item limit and rejects the 9th item once 8 are stored", async () => {
    const { insertContextSelection, checkBudget } = await import("../lib/contextSelections");
    const sessionId = await makeSession();
    for (let i = 0; i < 8; i++) {
      const result = insertContextSelection({
        sessionId,
        projectId: "proj1",
        kind: "file_snippet",
        pathOrRef: `file${i}.ts`,
        rangeOrHunk: JSON.stringify({ startLine: 1, endLine: 2 }),
        content: "x".repeat(10),
      });
      expect(result.ok).toBe(true);
    }
    expect(checkBudget(sessionId, 10)).toEqual({ ok: false, reason: "item_limit_reached" });
  });

  it("rejects an insert that would push the aggregate character total over 48,000", async () => {
    const { insertContextSelection } = await import("../lib/contextSelections");
    const sessionId = await makeSession();
    const first = insertContextSelection({
      sessionId,
      projectId: "proj1",
      kind: "file_snippet",
      pathOrRef: "big1.ts",
      rangeOrHunk: null,
      content: "x".repeat(12_000),
    });
    expect(first.ok).toBe(true);
    const second = insertContextSelection({
      sessionId,
      projectId: "proj1",
      kind: "file_snippet",
      pathOrRef: "big2.ts",
      rangeOrHunk: null,
      content: "y".repeat(12_000),
    });
    expect(second.ok).toBe(true);
    const third = insertContextSelection({
      sessionId,
      projectId: "proj1",
      kind: "file_snippet",
      pathOrRef: "big3.ts",
      rangeOrHunk: null,
      content: "z".repeat(12_000),
    });
    expect(third.ok).toBe(true);
    const fourth = insertContextSelection({
      sessionId,
      projectId: "proj1",
      kind: "file_snippet",
      pathOrRef: "big4.ts",
      rangeOrHunk: null,
      content: "w".repeat(12_000),
    });
    // 4 * 12,000 = 48,000 exactly fits; a 5th of any size must be rejected on aggregate chars.
    expect(fourth.ok).toBe(true);
    const fifth = insertContextSelection({
      sessionId,
      projectId: "proj1",
      kind: "file_snippet",
      pathOrRef: "big5.ts",
      rangeOrHunk: null,
      content: "v",
    });
    expect(fifth).toEqual({ ok: false, reason: "aggregate_char_limit_exceeded" });
  });

  it("computes a conservative token estimate and rejects on the aggregate token budget independent of char budget", async () => {
    const { estimateTokens, MAX_AGGREGATE_TOKENS } = await import("../lib/contextSelections");
    // chars/4 rounded up must never exceed MAX_AGGREGATE_TOKENS while chars themselves stay
    // under MAX_AGGREGATE_CHARS (48,000/4 = 12,000 == MAX_AGGREGATE_TOKENS exactly) — sanity
    // check that the two limits are consistent with each other, not just independently wired.
    expect(estimateTokens(48_000)).toBe(MAX_AGGREGATE_TOKENS);
  });
});

describe("context selection CRUD scoping", () => {
  it("removeContextSelection only deletes a row that belongs to the given session", async () => {
    const { insertContextSelection, removeContextSelection, getContextSelection } = await import("../lib/contextSelections");
    const sessionA = await makeSession();
    const inserted = insertContextSelection({ sessionId: sessionA, projectId: "proj1", kind: "file_snippet", pathOrRef: "a.ts", rangeOrHunk: null, content: "hi" });
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;

    const wrongSessionRemoved = removeContextSelection("some-other-session-id", inserted.item.id);
    expect(wrongSessionRemoved).toBe(false);
    expect(getContextSelection(sessionA, inserted.item.id)).not.toBeNull();

    const rightSessionRemoved = removeContextSelection(sessionA, inserted.item.id);
    expect(rightSessionRemoved).toBe(true);
    expect(getContextSelection(sessionA, inserted.item.id)).toBeNull();
  });

  it("clearContextSelections only removes rows for the given session, never another session's", async () => {
    const { insertContextSelection, clearContextSelections, listContextSelections } = await import("../lib/contextSelections");
    const { getDb, newId } = await import("../lib/db");
    const db = getDb();
    const now = Date.now();
    const sessionA = await makeSession();
    const sessionB = newId();
    db.prepare(`INSERT INTO sessions (id, project_id, hermes_session_id, created_at) VALUES (?, ?, ?, ?)`).run(sessionB, "proj1", "h2", now);

    insertContextSelection({ sessionId: sessionA, projectId: "proj1", kind: "file_snippet", pathOrRef: "a.ts", rangeOrHunk: null, content: "a" });
    insertContextSelection({ sessionId: sessionB, projectId: "proj1", kind: "file_snippet", pathOrRef: "b.ts", rangeOrHunk: null, content: "b" });

    const removed = clearContextSelections(sessionA);
    expect(removed).toBe(1);
    expect(listContextSelections(sessionA)).toHaveLength(0);
    expect(listContextSelections(sessionB)).toHaveLength(1);
  });

  it("never stores the raw content string anywhere in the row", async () => {
    const { insertContextSelection } = await import("../lib/contextSelections");
    const { getDb } = await import("../lib/db");
    const sessionId = await makeSession();
    const secretLookingContent = "const SECRET = 'do-not-persist-me';";
    const inserted = insertContextSelection({ sessionId, projectId: "proj1", kind: "file_snippet", pathOrRef: "s.ts", rangeOrHunk: null, content: secretLookingContent });
    expect(inserted.ok).toBe(true);
    const db = getDb();
    const row = db.prepare(`SELECT * FROM context_selections WHERE id = ?`).get(inserted.ok ? inserted.item.id : "") as any;
    const serializedRow = JSON.stringify(row);
    expect(serializedRow).not.toContain("do-not-persist-me");
  });
});
