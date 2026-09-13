/**
 * Literal substring search scoped to a project's canonical root. Every directory/file
 * visited is re-checked through resolveCanonicalPath so the deny-list (and any symlink/
 * junction escape) is enforced exactly like a direct fs/list or fs/read call — search
 * must never see anything those routes wouldn't also show.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveCanonicalPath } from "./canonicalPath";

export type SearchMatch = { path: string; line: number; text: string };

const MAX_MATCHES = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", ".next", "dist", "build", ".vercel"]);

function isLikelyBinary(buffer: Buffer): boolean {
  const sampleLen = Math.min(buffer.length, 8000);
  for (let i = 0; i < sampleLen; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

export function searchProject(canonicalRoot: string, query: string): SearchMatch[] {
  const matches: SearchMatch[] = [];
  if (!query) return matches;
  const needle = query.toLowerCase();

  function walk(relDir: string) {
    if (matches.length >= MAX_MATCHES) return;
    const resolution = resolveCanonicalPath(canonicalRoot, relDir);
    if (!resolution.ok) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(resolution.absolutePath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (matches.length >= MAX_MATCHES) return;
      if (entry.isDirectory() && SKIP_DIR_NAMES.has(entry.name)) continue;

      const childRel = relDir === "." ? entry.name : `${relDir}/${entry.name}`;
      const childResolution = resolveCanonicalPath(canonicalRoot, childRel);
      if (!childResolution.ok) continue; // deny-listed or escapes root — skip silently

      if (entry.isDirectory()) {
        walk(childRel);
        continue;
      }
      if (!entry.isFile()) continue;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(childResolution.absolutePath);
      } catch {
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) continue;

      let buffer: Buffer;
      try {
        buffer = fs.readFileSync(childResolution.absolutePath);
      } catch {
        continue;
      }
      if (isLikelyBinary(buffer)) continue;

      const text = buffer.toString("utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= MAX_MATCHES) break;
        const line = lines[i] ?? "";
        if (line.toLowerCase().includes(needle)) {
          matches.push({ path: childResolution.relativePath, line: i + 1, text: line.slice(0, 300) });
        }
      }
    }
  }

  walk(".");
  return matches;
}
