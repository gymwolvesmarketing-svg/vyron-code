#!/usr/bin/env node
/**
 * Local SQLite metadata backup + retention (VYRON_CODE_V01_LOCAL_RUNTIME_HARDENING_IMPLEMENTATION_AUTHORIZATION).
 * Manual, on-demand only — no scheduled task/service is created or implied. Copies the
 * existing database file to a gitignored `data/backups/` folder (never outside `data/`,
 * never Git-tracked — see .gitignore) and prunes to the most recent MAX_BACKUPS copies.
 *
 * Never touches the live database beyond a plain file copy (no migration, no row deletion,
 * no restore capability — restore is explicitly out of this script's scope). Before a backup
 * is kept, its schema is checked against a fixed deny-list of column names that would
 * indicate raw content/prompt/token storage — this is a structural, zero-false-positive
 * check (unlike a byte-level regex scan, which would misfire on the schema's own legitimate
 * SHA-256 content fingerprints and UUIDs). If a forbidden column is ever found, the backup
 * copy is deleted immediately and the run fails closed; nothing is ever printed about *what*
 * was found beyond the column name itself (never a row value).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "vyroncode.sqlite");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const MAX_BACKUPS = 10;

// Any column with one of these names would mean raw content/prompt/token storage crept
// into the schema — this must never happen (see lib/contextSelections.ts's own doc comment
// and tests/contextSelections.test.ts's regression test for the same guarantee).
const FORBIDDEN_COLUMN_NAMES = new Set([
  "content",
  "raw_content",
  "raw_prompt",
  "prompt",
  "prompt_text",
  "response",
  "raw_response",
  "provider_output",
  "token",
  "session_token",
  "hermes_token",
  "authorization",
]);

export function findForbiddenColumns(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all();
    const offenders = [];
    for (const { name: table } of tables) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all();
      for (const col of columns) {
        if (FORBIDDEN_COLUMN_NAMES.has(col.name.toLowerCase())) {
          offenders.push(`${table}.${col.name}`);
        }
      }
    }
    return offenders;
  } finally {
    db.close();
  }
}

export function pruneOldBackups(backupDir, keep) {
  if (!fs.existsSync(backupDir)) return [];
  const entries = fs
    .readdirSync(backupDir)
    .filter((f) => f.startsWith("vyroncode-") && f.endsWith(".sqlite"))
    .map((f) => ({ f, mtime: fs.statSync(path.join(backupDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const pruned = [];
  for (const { f } of entries.slice(keep)) {
    fs.unlinkSync(path.join(backupDir, f));
    pruned.push(f);
  }
  return pruned;
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.log("No database found at", DB_PATH, "— nothing to back up.");
    return;
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(BACKUP_DIR, `vyroncode-${stamp}.sqlite`);
  fs.copyFileSync(DB_PATH, backupPath);

  const offenders = findForbiddenColumns(backupPath);
  if (offenders.length > 0) {
    fs.unlinkSync(backupPath);
    console.error("FAIL: backup schema contained a forbidden column and was discarded (not kept):", offenders.join(", "));
    console.error("This indicates the database schema changed to store raw content/prompt/token data — investigate before backing up again.");
    process.exitCode = 1;
    return;
  }

  console.log("Backup created:", backupPath);

  const pruned = pruneOldBackups(BACKUP_DIR, MAX_BACKUPS);
  for (const f of pruned) console.log("Pruned old backup:", f);
  console.log(`Retention: keeping the most recent ${MAX_BACKUPS} backups.`);
}

const isMain = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMain) {
  main();
}
