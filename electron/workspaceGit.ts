/**
 * Bounded, read-only, filesystem-only Git summary for the granted workspace —
 * VYRON_CODE_V02_MILESTONE_A_RUNTIME_STABILITY_AND_READONLY_WORKSPACE_AUTHORIZATION, extended
 * by VYRON_CODE_V02_MILESTONE_A_READONLY_WORKSPACE_COMPLETION_AUTHORIZATION to add
 * modified/deleted counts.
 *
 * Deliberately never invokes the `git` CLI, a shell, or `child_process` (unlike this
 * codebase's own `lib/git.ts`, which the web app uses and which is NOT reusable here for
 * exactly that reason). Instead this reads two small, well-known files directly:
 * `.git/HEAD` (to determine the current branch) and `.git/index` (to determine which paths
 * are tracked, plus each one's recorded mtime+size, so modified/deleted/untracked counts can
 * all be derived from a single bounded working-tree walk plus a bounded pass over the index
 * itself).
 *
 * `modified` uses git's own standard fast-path heuristic — if a tracked file's *current*
 * mtime+size differs from what the index recorded at the last `git add`/commit, it is counted
 * as modified, without re-hashing file content. This is a real, disclosed, bounded-cost
 * tradeoff (matching git's own default behavior when `core.fsmonitor`/hashing isn't forced) —
 * it can rarely under-report a change whose mtime was reset to match without altering content,
 * but it never requires decompressing any git object.
 *
 * Deliberately still NOT computed: staged-but-uncommitted ("added") counts and rename
 * detection — both require decompressing and diffing git tree/blob objects against HEAD,
 * meaningfully more parsing surface than a read-only convenience summary needs.
 * `trackedChangesAvailable: false` is reserved for when even the cheap modified/deleted counts
 * cannot be derived safely at all (e.g. an unsupported index version) — the renderer must
 * never read a `false` here as "zero changes".
 *
 * `.git` itself is a denied path segment in `lib/canonicalPath.ts`'s `resolveCanonicalPath`
 * (by design, for every OTHER workspace service) — this module is the one deliberate,
 * narrowly-scoped exception, reading only the two specific files named above, directly by
 * path, still fully bounded by the granted canonical root via `getCurrentCanonicalRoot()`.
 */
import fs from "node:fs";
import path from "node:path";
import { getCurrentCanonicalRoot } from "./workspace-grant";
import { resolveWorkspacePath } from "./workspaceAccess";
import type { GitSummaryResult } from "./shared-ipc-contract";

const MAX_FILES_SCANNED = 5000;
const MAX_ELAPSED_MS = 3000;

const SAFE_REF_NAME = /^[A-Za-z0-9._/-]+$/;
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", ".next", "dist", "build", ".vercel"]);

interface IndexEntry {
  readonly mtimeSeconds: number;
  readonly mtimeNanoseconds: number;
  readonly size: number;
}

function parseHead(gitDir: string): { branch: string | null; detached: boolean } | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
  } catch {
    return null;
  }

  const refMatch = raw.match(/^ref:\s*refs\/heads\/(.+)$/);
  if (refMatch) {
    const branch = refMatch[1];
    if (!branch || !SAFE_REF_NAME.test(branch)) return null;
    return { branch, detached: false };
  }

  // A detached HEAD points directly at a commit SHA (40 hex chars for SHA-1, 64 for SHA-256
  // repos) — the raw SHA is never returned to the renderer, only the fact of detachment.
  if (/^[0-9a-f]{40}$/i.test(raw) || /^[0-9a-f]{64}$/i.test(raw)) {
    return { branch: null, detached: true };
  }

  return null;
}

/** Parses a git index (v2/v3) into a map of tracked relative paths (forward-slash, as git
 * itself stores them) to their recorded mtime+size. Returns null for any unsupported version
 * or malformed/unexpected content — callers treat that as "cannot compute safely", never a
 * guess. */
function parseIndexEntries(indexPath: string): Map<string, IndexEntry> | null {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(indexPath);
  } catch {
    return null;
  }
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "DIRC") return null;

  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) return null; // v4 (prefix-compressed) intentionally unsupported

  const entryCount = buf.readUInt32BE(8);
  const tracked = new Map<string, IndexEntry>();
  let offset = 12;
  const FIXED_ENTRY_BYTES = 62;

  for (let i = 0; i < entryCount; i++) {
    if (offset + FIXED_ENTRY_BYTES > buf.length) return null;

    const mtimeSeconds = buf.readUInt32BE(offset + 8);
    const mtimeNanoseconds = buf.readUInt32BE(offset + 12);
    const size = buf.readUInt32BE(offset + 36);
    const flags = buf.readUInt16BE(offset + 60);
    if ((flags & 0x4000) !== 0) return null; // extended-flag entries intentionally unsupported

    const nameStart = offset + FIXED_ENTRY_BYTES;
    const nulIndex = buf.indexOf(0, nameStart);
    if (nulIndex === -1) return null;

    const name = buf.toString("utf8", nameStart, nulIndex);
    tracked.set(name, { mtimeSeconds, mtimeNanoseconds, size });

    const entryLen = FIXED_ENTRY_BYTES + (nulIndex - nameStart) + 1;
    const paddedLen = Math.ceil(entryLen / 8) * 8;
    offset += paddedLen;
  }

  return tracked;
}

interface StatusCounts {
  modifiedCount: number;
  deletedCount: number;
  untrackedCount: number;
  truncated: boolean;
}

/**
 * A single bounded pass: walks the working tree (for untracked detection) and separately
 * checks each tracked entry against disk (for modified/deleted detection). Both phases share
 * one elapsed-time/file-count budget so the combined operation stays within the same bounds
 * as every other workspace service.
 */
function computeStatusCounts(tracked: Map<string, IndexEntry>): StatusCounts {
  let filesScanned = 0;
  let truncated = false;
  const startedAt = Date.now();
  const seenTracked = new Set<string>();

  function exceeded(): boolean {
    return filesScanned >= MAX_FILES_SCANNED || Date.now() - startedAt > MAX_ELAPSED_MS;
  }

  let untrackedCount = 0;

  function walkForUntracked(relDir: string): void {
    if (exceeded()) {
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
      if (exceeded()) {
        truncated = true;
        return;
      }
      if (dirent.isDirectory() && SKIP_DIR_NAMES.has(dirent.name)) continue;

      const childRel = relDir === "." ? dirent.name : `${relDir}/${dirent.name}`;
      const childAccess = resolveWorkspacePath(childRel);
      if (!childAccess.ok) continue;

      if (dirent.isDirectory()) {
        walkForUntracked(childRel);
        continue;
      }
      if (!dirent.isFile()) continue;

      filesScanned++;
      if (tracked.has(childAccess.relativePath)) {
        seenTracked.add(childAccess.relativePath);
      } else {
        untrackedCount++;
      }
    }
  }

  walkForUntracked(".");

  // Deleted/modified: re-check every tracked entry directly by path rather than relying on
  // the untracked walk to have visited it (a tracked file could live outside the walk's
  // budget if the workspace is very large — checking it directly is a single stat, cheap
  // regardless of tree size, and bounded by the same shared budget).
  let modifiedCount = 0;
  let deletedCount = 0;
  for (const [relativePath, indexEntry] of tracked) {
    if (exceeded()) {
      truncated = true;
      break;
    }
    filesScanned++;
    const access = resolveWorkspacePath(relativePath);
    if (!access.ok) {
      deletedCount++;
      continue;
    }
    let stat: fs.BigIntStats;
    try {
      // `{ bigint: true }` gives true nanosecond-resolution mtime (matching what git's index
      // itself stores) — the ordinary millisecond-float `Stats.mtimeMs` would lose enough
      // precision to make almost every tracked file look "modified" even when untouched.
      stat = fs.statSync(access.absolutePath, { bigint: true });
    } catch {
      deletedCount++;
      continue;
    }
    const mtimeSeconds = Number(stat.mtimeNs / 1_000_000_000n);
    const mtimeNanoseconds = Number(stat.mtimeNs % 1_000_000_000n);
    const changed = Number(stat.size) !== indexEntry.size || mtimeSeconds !== indexEntry.mtimeSeconds || mtimeNanoseconds !== indexEntry.mtimeNanoseconds;
    if (changed) modifiedCount++;
  }

  return { modifiedCount, deletedCount, untrackedCount, truncated };
}

function unavailable(state: GitSummaryResult["state"]): GitSummaryResult {
  return {
    state,
    branch: null,
    detached: false,
    trackedChangesAvailable: false,
    modifiedCount: null,
    deletedCount: null,
    untrackedCount: null,
    truncated: false,
  };
}

export function getGitSummary(): GitSummaryResult {
  const canonicalRoot = getCurrentCanonicalRoot();
  if (!canonicalRoot) return unavailable("no_workspace");

  try {
    const gitDir = path.join(canonicalRoot, ".git");
    let gitDirStat: fs.Stats;
    try {
      gitDirStat = fs.statSync(gitDir);
    } catch {
      return unavailable("not_a_repository");
    }
    if (!gitDirStat.isDirectory()) return unavailable("not_a_repository"); // a `.git` file (worktree/submodule) is out of scope

    const head = parseHead(gitDir);
    if (!head) return unavailable("unavailable");

    const tracked = parseIndexEntries(path.join(gitDir, "index"));
    if (!tracked) return unavailable("unavailable");

    const { modifiedCount, deletedCount, untrackedCount, truncated } = computeStatusCounts(tracked);

    return {
      state: "ok",
      branch: head.branch,
      detached: head.detached,
      trackedChangesAvailable: true,
      modifiedCount,
      deletedCount,
      untrackedCount,
      truncated,
    };
  } catch {
    return unavailable("unavailable");
  }
}
