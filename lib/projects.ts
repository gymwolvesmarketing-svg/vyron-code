/**
 * Project registry — the allowlist of canonical roots Vyron Code is permitted to touch.
 * Every fs/search/git route resolves its project via getProject(), never a raw client path.
 */
import { getDb, newId } from "./db";
import { resolveCanonicalRoot, checkRootPolicy } from "./canonicalPath";

export type Project = {
  id: string;
  canonicalRoot: string;
  displayName: string;
  openedAt: number;
  lastActiveAt: number;
};

function rowToProject(row: any): Project {
  return {
    id: row.id,
    canonicalRoot: row.canonical_root,
    displayName: row.display_name,
    openedAt: row.opened_at,
    lastActiveAt: row.last_active_at,
  };
}

export function addProject(rawPath: string, displayName?: string): { ok: true; project: Project } | { ok: false; reason: string } {
  const canonicalRoot = resolveCanonicalRoot(rawPath);
  if (!canonicalRoot) return { ok: false, reason: "root_not_resolvable" };

  // Root policy (VYRON_CODE_V01_LOCALHOST_AND_PROJECT_ROOT_HARDENING_AUTHORIZATION): reject
  // drive roots, the user's home directory, and common broad user folders — see
  // checkRootPolicy's own doc comment in lib/canonicalPath.ts for the exact rule set. This
  // runs on the already-canonicalized root only, so it cannot be bypassed by casing,
  // trailing separators, or a symlink/junction pointing at a rejected root.
  const policy = checkRootPolicy(canonicalRoot);
  if (!policy.allowed) return { ok: false, reason: policy.reason };

  const db = getDb();
  const existing = db.prepare(`SELECT * FROM projects WHERE canonical_root = ?`).get(canonicalRoot);
  if (existing) return { ok: true, project: rowToProject(existing) };

  const id = newId();
  const now = Date.now();
  const name = displayName || canonicalRoot.split(/[\\/]/).filter(Boolean).pop() || canonicalRoot;
  db.prepare(
    `INSERT INTO projects (id, canonical_root, display_name, opened_at, last_active_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, canonicalRoot, name, now, now);
  return { ok: true, project: { id, canonicalRoot, displayName: name, openedAt: now, lastActiveAt: now } };
}

export function getProject(projectId: string): Project | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId);
  return row ? rowToProject(row) : null;
}

export function listProjects(): Project[] {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM projects ORDER BY last_active_at DESC`).all();
  return rows.map(rowToProject);
}

export function touchProject(projectId: string): void {
  const db = getDb();
  db.prepare(`UPDATE projects SET last_active_at = ? WHERE id = ?`).run(Date.now(), projectId);
}
