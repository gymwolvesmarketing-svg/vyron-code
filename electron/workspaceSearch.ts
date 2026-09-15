/**
 * Bounded, read-only literal-substring search within the granted workspace —
 * VYRON_CODE_V02_MILESTONE_A_RUNTIME_STABILITY_AND_READONLY_WORKSPACE_AUTHORIZATION.
 *
 * Adapted from this codebase's own `lib/search.ts` (the web app's project search), with
 * tighter, explicit bounds appropriate to an interactive desktop scaffold: a query-length
 * cap, a scanned-file-count cap, and a wall-clock elapsed-time cap, in addition to the
 * existing match-count/file-size caps. Every directory/file visited is re-validated through
 * `workspaceAccess.ts`'s `resolveWorkspacePath` — the deny-list (`.env`, `.git`,
 * `node_modules`, key/cert files, …) and any symlink/junction escape are enforced exactly
 * like a direct Explorer listing or file-viewer read; search must never see anything those
 * would not also show. Never shells out — no `git`/ripgrep/any external process is invoked.
 */
import fs from "node:fs";
import { resolveWorkspacePath } from "./workspaceAccess";
import type { SearchTextResult, WorkspaceSearchMatch } from "./shared-ipc-contract";

const MAX_QUERY_LENGTH = 200;
const MAX_MATCHES = 150;
const MAX_FILES_SCANNED = 2000;
const MAX_FILE_BYTES = 1 * 1024 * 1024;
const MAX_ELAPSED_MS = 3000;
const MAX_PREVIEW_CHARS = 300;
// Skipped purely to avoid wasted work descending into these — `resolveWorkspacePath` already
// denies `.git`/`node_modules` by name regardless, so this is a performance bound, not a
// security boundary on its own.
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", ".next", "dist", "build", ".vercel"]);

function isLikelyBinary(buffer: Buffer): boolean {
  const sampleLen = Math.min(buffer.length, 8000);
  for (let i = 0; i < sampleLen; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

// Rejects C0 control characters (including the null byte) — a search query is conceptually
// a single line of text; control characters here are never meaningful and this keeps the
// query safe to embed unmodified in a returned match preview.
const HAS_CONTROL_CHARACTER = /[\x00-\x1f]/;

export function searchText(rawQuery: string): SearchTextResult {
  if (
    typeof rawQuery !== "string" ||
    rawQuery.length === 0 ||
    rawQuery.length > MAX_QUERY_LENGTH ||
    rawQuery.trim().length === 0 ||
    HAS_CONTROL_CHARACTER.test(rawQuery)
  ) {
    return { state: "invalid_query", query: null, matches: [], truncated: false };
  }

  // getCurrentCanonicalRoot's own no-workspace/TOCTOU handling is reused via
  // resolveWorkspacePath(".") — the root itself, always a safe, trivial resolution when a
  // grant exists.
  const rootAccess = resolveWorkspacePath(".");
  if (!rootAccess.ok) {
    return { state: "no_workspace", query: null, matches: [], truncated: false };
  }

  const needle = rawQuery.toLowerCase();
  const matches: WorkspaceSearchMatch[] = [];
  const startedAt = Date.now();
  let filesScanned = 0;
  let truncated = false;

  function timeOrCountExceeded(): boolean {
    return matches.length >= MAX_MATCHES || filesScanned >= MAX_FILES_SCANNED || Date.now() - startedAt > MAX_ELAPSED_MS;
  }

  function walk(relDir: string): void {
    if (timeOrCountExceeded()) {
      truncated = true;
      return;
    }
    const dirAccess = resolveWorkspacePath(relDir);
    if (!dirAccess.ok) return;

    let dirEntries: fs.Dirent[];
    try {
      dirEntries = fs.readdirSync(dirAccess.absolutePath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const dirent of dirEntries) {
      if (timeOrCountExceeded()) {
        truncated = true;
        return;
      }
      if (dirent.isDirectory() && SKIP_DIR_NAMES.has(dirent.name)) continue;

      const childRel = relDir === "." ? dirent.name : `${relDir}/${dirent.name}`;
      const childAccess = resolveWorkspacePath(childRel);
      if (!childAccess.ok) continue; // deny-listed or escapes root — skip silently

      if (dirent.isDirectory()) {
        walk(childRel);
        continue;
      }
      if (!dirent.isFile()) continue;

      filesScanned++;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(childAccess.absolutePath);
      } catch {
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) continue;

      let buffer: Buffer;
      try {
        buffer = fs.readFileSync(childAccess.absolutePath);
      } catch {
        continue;
      }
      if (isLikelyBinary(buffer)) continue;

      const text = buffer.toString("utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (timeOrCountExceeded()) {
          truncated = true;
          return;
        }
        const line = lines[i] ?? "";
        if (line.toLowerCase().includes(needle)) {
          matches.push({ relativePath: childAccess.relativePath, line: i + 1, preview: line.slice(0, MAX_PREVIEW_CHARS) });
        }
      }
    }
  }

  walk(".");

  return { state: "ok", query: rawQuery, matches, truncated };
}
