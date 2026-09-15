/**
 * Bounded, read-only directory listing for the granted workspace —
 * VYRON_CODE_V02_MILESTONE_A_RUNTIME_STABILITY_AND_READONLY_WORKSPACE_AUTHORIZATION.
 *
 * Lists exactly one directory level per call (the renderer expands nested directories with
 * further calls, never an eager recursive tree load — see electron/renderer.ts). Every
 * request, and every child entry within a listing, is revalidated through
 * `workspaceAccess.ts`'s `resolveWorkspacePath` (itself built on the same
 * `lib/canonicalPath.ts` logic used everywhere else in this codebase), so a denied name
 * (`.env`, `.git`, `node_modules`, key/cert files, …) or a symlink/junction escape can never
 * appear in a listing even though the parent directory itself passed. Never reads file
 * contents — only `fs.readdirSync`/`fs.statSync` metadata.
 */
import fs from "node:fs";
import { resolveWorkspacePath } from "./workspaceAccess";
import type { ListEntriesResult, WorkspaceExplorerEntry } from "./shared-ipc-contract";

// A directory with more entries than this is truncated — no listing this large is ever
// returned whole. Kept modest since this is an interactive expand-on-demand tree, not a bulk
// export.
const MAX_ENTRIES = 500;

function emptyResult(state: ListEntriesResult["state"], relativePath: string | null = null): ListEntriesResult {
  return { state, relativePath, entries: [], truncated: false };
}

export function listEntries(requestedRelativePath: string): ListEntriesResult {
  const access = resolveWorkspacePath(requestedRelativePath);
  if (!access.ok) {
    return emptyResult(access.reason === "no_workspace" ? "no_workspace" : "invalid_path");
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(access.absolutePath);
  } catch {
    return emptyResult("invalid_path", access.relativePath);
  }
  if (!stat.isDirectory()) {
    return emptyResult("not_a_directory", access.relativePath);
  }

  let dirEntries: fs.Dirent[];
  try {
    dirEntries = fs.readdirSync(access.absolutePath, { withFileTypes: true });
  } catch {
    return emptyResult("denied", access.relativePath);
  }

  const entries: WorkspaceExplorerEntry[] = [];
  let truncated = false;
  for (const dirent of dirEntries) {
    if (entries.length >= MAX_ENTRIES) {
      truncated = true;
      break;
    }
    const childRequested = access.relativePath === "." ? dirent.name : `${access.relativePath}/${dirent.name}`;
    // Re-run every child name through the same guard so a denied name never appears in a
    // listing even though the parent directory itself passed — matches app/api/fs/list's own
    // established pattern in this codebase.
    const childAccess = resolveWorkspacePath(childRequested);
    if (!childAccess.ok) continue;

    let type: "dir" | "file";
    if (dirent.isDirectory()) {
      type = "dir";
    } else if (dirent.isFile()) {
      type = "file";
    } else {
      // Skips symlinks-to-nowhere, sockets, devices, FIFOs, and anything else that is
      // neither a plain directory nor a plain file — safely, not a crash.
      continue;
    }
    entries.push({ name: dirent.name, relativePath: childAccess.relativePath, type });
  }

  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));

  return { state: "ok", relativePath: access.relativePath, entries, truncated };
}
