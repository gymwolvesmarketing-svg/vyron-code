/**
 * Shared guard used by every fs/search/git API route: resolves the project, re-resolves
 * its canonical root fresh (not just trusting the stored value — the directory could have
 * been deleted/moved since registration), and runs the requested relative path through
 * resolveCanonicalPath. Every route MUST go through this instead of touching fs.* or the
 * project registry directly.
 */
import { getProject } from "./projects";
import { resolveCanonicalRoot, resolveCanonicalPath, type CanonicalResolution } from "./canonicalPath";
import { recordAudit } from "./db";

export type GuardResult =
  | { ok: true; projectId: string; canonicalRoot: string; absolutePath: string; relativePath: string }
  | { ok: false; status: number; error: string };

export function guardProjectPath(
  projectId: string | null,
  requestedPath: string,
  actionKind: string,
  options: { audit?: boolean } = {}
): GuardResult {
  const audit = options.audit !== false;
  if (!projectId) return { ok: false, status: 400, error: "project_id required" };

  const project = getProject(projectId);
  if (!project) {
    if (audit) recordAudit(projectId, actionKind, requestedPath, "denied:unknown_project");
    return { ok: false, status: 404, error: "unknown project_id" };
  }

  // Re-resolve fresh every request — a stale registry entry must not grant access to a
  // path that no longer exists or that now points somewhere else (TOCTOU defense).
  const freshRoot = resolveCanonicalRoot(project.canonicalRoot);
  if (!freshRoot || freshRoot !== project.canonicalRoot) {
    if (audit) recordAudit(projectId, actionKind, requestedPath, "denied:root_not_resolvable");
    return { ok: false, status: 409, error: "project root is no longer resolvable; re-add the project" };
  }

  const resolution: CanonicalResolution = resolveCanonicalPath(freshRoot, requestedPath || ".");
  if (!resolution.ok) {
    if (audit) recordAudit(projectId, actionKind, requestedPath, `denied:${resolution.reason}`);
    return { ok: false, status: 403, error: resolution.reason };
  }

  if (audit) recordAudit(projectId, actionKind, resolution.relativePath, "ok");
  return {
    ok: true,
    projectId,
    canonicalRoot: freshRoot,
    absolutePath: resolution.absolutePath,
    relativePath: resolution.relativePath,
  };
}
