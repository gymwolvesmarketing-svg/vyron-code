import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { findForbiddenColumns, pruneOldBackups } from "../scripts/backup-db.mjs";

let tmpDir: string;

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("findForbiddenColumns", () => {
  it("returns empty for a schema shaped like the real one (metadata only, no content/prompt/token columns)", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vyroncode-backup-test-"));
    const dbPath = path.join(tmpDir, "clean.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE context_selections (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        path_or_ref TEXT NOT NULL,
        content_fingerprint TEXT,
        char_count INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.close();
    expect(findForbiddenColumns(dbPath)).toEqual([]);
  });

  it("flags a forbidden column (e.g. a hypothetical future 'content' column) by exact table.column name", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vyroncode-backup-test-"));
    const dbPath = path.join(tmpDir, "tainted.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE context_selections (id TEXT PRIMARY KEY, content TEXT);
    `);
    db.close();
    expect(findForbiddenColumns(dbPath)).toEqual(["context_selections.content"]);
  });

  it("is case-insensitive on the column name", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vyroncode-backup-test-"));
    const dbPath = path.join(tmpDir, "tainted2.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, "Hermes_Token" TEXT);`);
    db.close();
    expect(findForbiddenColumns(dbPath)).toEqual(["sessions.Hermes_Token"]);
  });
});

describe("pruneOldBackups", () => {
  it("keeps only the N most recent backup files, deleting the rest", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vyroncode-backup-prune-"));
    const names = ["vyroncode-a.sqlite", "vyroncode-b.sqlite", "vyroncode-c.sqlite", "vyroncode-d.sqlite"];
    names.forEach((name, i) => {
      fs.writeFileSync(path.join(tmpDir, name), "x");
      // Force distinct, increasing mtimes so ordering is deterministic.
      const t = new Date(Date.now() + i * 1000);
      fs.utimesSync(path.join(tmpDir, name), t, t);
    });

    const pruned = pruneOldBackups(tmpDir, 2);

    expect(pruned.sort()).toEqual(["vyroncode-a.sqlite", "vyroncode-b.sqlite"]);
    expect(fs.readdirSync(tmpDir).sort()).toEqual(["vyroncode-c.sqlite", "vyroncode-d.sqlite"]);
  });

  it("ignores files that don't match the vyroncode-*.sqlite naming pattern", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vyroncode-backup-prune-"));
    fs.writeFileSync(path.join(tmpDir, "unrelated.txt"), "x");
    fs.writeFileSync(path.join(tmpDir, "vyroncode-only.sqlite"), "x");

    const pruned = pruneOldBackups(tmpDir, 0);

    expect(pruned).toEqual(["vyroncode-only.sqlite"]);
    expect(fs.readdirSync(tmpDir)).toEqual(["unrelated.txt"]);
  });

  it("returns an empty array when the backup directory doesn't exist yet", () => {
    expect(pruneOldBackups(path.join(os.tmpdir(), "vyroncode-does-not-exist-" + Date.now()), 5)).toEqual([]);
  });
});
