/**
 * Shared, main-process-only access-validation helper for the Milestone A workspace services
 * (Explorer, file viewer, search, Git summary) —
 * VYRON_CODE_V02_MILESTONE_A_RUNTIME_STABILITY_AND_READONLY_WORKSPACE_AUTHORIZATION.
 *
 * Mirrors `lib/fsGuard.ts`'s `guardProjectPath` shape (fresh canonical-root re-resolution,
 * then `resolveCanonicalPath` containment) but without any SQLite/audit/project-registry
 * dependency — this desktop scaffold has exactly one grant at a time, held by
 * `electron/workspace-grant.ts`, never persisted. Every list/read/search/Git request in this
 * codebase MUST go through this function (or `getCurrentCanonicalRoot()` directly, for the
 * Git summary service, which needs the raw root to read `.git/*` files that
 * `resolveCanonicalPath` would otherwise deny by name) — nothing else is allowed to touch
 * `fs.*` with a caller-supplied path directly.
 */
import { resolveCanonicalPath } from "../lib/canonicalPath";
import { getCurrentCanonicalRoot } from "./workspace-grant";

// An explicit upper bound on the REQUEST string's own length, checked before it is ever
// passed to fs/path APIs — VYRON_CODE_V02_MILESTONE_A_READONLY_WORKSPACE_COMPLETION_AUTHORIZATION.
// Windows' own MAX_PATH (~260 chars, or ~32,767 with long-path support) is already an
// effective ceiling once resolved against a real root, but this rejects an absurdly long
// request string immediately, before any path-join/realpath work, rather than relying on
// that downstream behavior alone.
const MAX_REQUEST_PATH_LENGTH = 4096;

export type WorkspaceAccessResult =
  | { ok: true; canonicalRoot: string; absolutePath: string; relativePath: string }
  | { ok: false; reason: "no_workspace" | "invalid_path" };

/**
 * Resolves `requestedRelativePath` against the currently granted workspace root. Returns
 * `no_workspace` if no grant exists (or it no longer resolves — see
 * `getCurrentCanonicalRoot`'s own TOCTOU re-resolution), or `invalid_path` for anything too
 * long, or anything `resolveCanonicalPath` itself rejects (absolute path, traversal, denied
 * segment name, symlink escape, not found, embedded null byte, drive/UNC/device path).
 */
export function resolveWorkspacePath(requestedRelativePath: string): WorkspaceAccessResult {
  const canonicalRoot = getCurrentCanonicalRoot();
  if (!canonicalRoot) return { ok: false, reason: "no_workspace" };

  if (typeof requestedRelativePath !== "string" || requestedRelativePath.length > MAX_REQUEST_PATH_LENGTH) {
    return { ok: false, reason: "invalid_path" };
  }

  const resolution = resolveCanonicalPath(canonicalRoot, requestedRelativePath);
  if (!resolution.ok) return { ok: false, reason: "invalid_path" };

  return { ok: true, canonicalRoot, absolutePath: resolution.absolutePath, relativePath: resolution.relativePath };
}
