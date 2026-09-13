import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// lib/db.ts resolves its data directory from process.cwd() — point the whole test at an
// isolated temp "cwd" so this never touches the real dev database (data/vyroncode.sqlite),
// which may already hold real conversation rows from manual testing.
let tmpRoot: string;
let originalCwd: string;

beforeEach(() => {
  vi.resetModules();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vyroncode-db-test-"));
  originalCwd = process.cwd();
  process.chdir(tmpRoot);
});

afterEach(async () => {
  // The DB file must be closed before its containing temp directory can be removed on
  // Windows (an open SQLite handle blocks rmSync with EPERM) — re-import the same cached
  // module instance (vi.resetModules() + dynamic import means each test's imports already
  // share one module registry) and close it explicitly rather than leaving it to GC.
  try {
    const { getDb } = await import("../lib/db");
    getDb().close();
  } catch {
    /* module never imported in this test, or already closed — fine either way */
  }
  process.chdir(originalCwd);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("sessions metadata (additive migration + helpers)", () => {
  it("creates a sessions table with the new metadata columns on a fresh database", async () => {
    const { getDb } = await import("../lib/db");
    const db = getDb();
    const columns = (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toEqual(
      expect.arrayContaining(["id", "project_id", "hermes_session_id", "created_at", "title", "status", "updated_at", "last_activity_at", "message_count"])
    );
  });

  it("migration is additive: re-opening an existing older-schema database does not fail and does not drop existing rows", async () => {
    const dbPath = path.join(tmpRoot, "data", "vyroncode.sqlite");
    fs.mkdirSync(path.join(tmpRoot, "data"), { recursive: true });
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, canonical_root TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, opened_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, hermes_session_id TEXT NOT NULL, created_at INTEGER NOT NULL, title TEXT);
    `);
    raw.prepare(`INSERT INTO projects VALUES (?, ?, ?, ?, ?)`).run("p1", "C:\\proj", "proj", 1, 1);
    raw.prepare(`INSERT INTO sessions (id, project_id, hermes_session_id, created_at, title) VALUES (?, ?, ?, ?, ?)`).run(
      "s1",
      "p1",
      "hs1",
      123,
      "pre-existing title"
    );
    raw.close();

    const { getDb } = await import("../lib/db");
    const db = getDb();
    const row = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get("s1") as any;
    expect(row.title).toBe("pre-existing title"); // untouched
    expect(row.status).toBe("active"); // new column, default applied
    expect(row.message_count).toBe(0);
  });

  it("listSessionsForProject scopes strictly to the given project and orders by most recent activity", async () => {
    const { getDb, newId } = await import("../lib/db");
    const { listSessionsForProject } = await import("../lib/sessions");
    const db = getDb();
    const now = Date.now();
    db.prepare(`INSERT INTO projects (id, canonical_root, display_name, opened_at, last_active_at) VALUES (?, ?, ?, ?, ?)`).run(
      "projA",
      "C:\\a",
      "A",
      now,
      now
    );
    db.prepare(`INSERT INTO projects (id, canonical_root, display_name, opened_at, last_active_at) VALUES (?, ?, ?, ?, ?)`).run(
      "projB",
      "C:\\b",
      "B",
      now,
      now
    );
    db.prepare(
      `INSERT INTO sessions (id, project_id, hermes_session_id, created_at, title, status, updated_at, last_activity_at, message_count) VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(newId(), "projA", "h1", now - 2000, "older in A", "active", now - 2000, now - 2000, 1);
    db.prepare(
      `INSERT INTO sessions (id, project_id, hermes_session_id, created_at, title, status, updated_at, last_activity_at, message_count) VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(newId(), "projA", "h2", now - 1000, "newer in A", "active", now - 500, now - 500, 2);
    db.prepare(
      `INSERT INTO sessions (id, project_id, hermes_session_id, created_at, title, status, updated_at, last_activity_at, message_count) VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(newId(), "projB", "h3", now, "in B", "active", now, now, 1);

    const resultsA = listSessionsForProject("projA");
    expect(resultsA).toHaveLength(2);
    expect(resultsA[0]?.title).toBe("newer in A"); // most-recent-activity first
    expect(resultsA.every((s) => s.projectId === "projA")).toBe(true);
    expect(resultsA.some((s) => s.title === "in B")).toBe(false); // no cross-project leakage
  });

  it("setSessionStatus and touchSessionActivity update only the targeted row", async () => {
    const { getDb, newId } = await import("../lib/db");
    const { setSessionStatus, touchSessionActivity, getSession } = await import("../lib/sessions");
    const db = getDb();
    const now = Date.now();
    db.prepare(`INSERT INTO projects (id, canonical_root, display_name, opened_at, last_active_at) VALUES (?, ?, ?, ?, ?)`).run(
      "proj1",
      "C:\\p",
      "P",
      now,
      now
    );
    db.prepare(
      `INSERT INTO sessions (id, project_id, hermes_session_id, created_at, status, message_count) VALUES (?,?,?,?,?,?)`
    ).run("sess1", "proj1", "h1", now, "active", 0);

    touchSessionActivity("sess1");
    setSessionStatus("sess1", "interrupted");

    const row = getSession("sess1")!;
    expect(row.status).toBe("interrupted");
    expect(row.messageCount).toBe(1);
  });
});
