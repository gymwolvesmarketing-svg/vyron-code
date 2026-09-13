/**
 * Read-only Git wrapper. v0.1 has no mutating Git route at all — every function here
 * calls a fixed, non-interactive, read-only git subcommand with execFile (never a shell),
 * so there is no command-injection surface even though a path argument is user-influenced.
 *
 * Raw stderr from a failed git invocation is classified HERE and never returned to a caller
 * — git's own error text can contain the absolute cwd path it tried to use ("fatal: cannot
 * change to 'C:\Users\...': ...") or other locally-meaningful detail that must not reach an
 * API response (VYRON_CODE_V01_GIT_AND_EXPLICIT_CONTEXT_IMPLEMENTATION_AUTHORIZATION's "safe
 * error display" requirement). Callers only ever see a coarse, safe reason code.
 */
import { execFileSync } from "node:child_process";

export type GitRunResult = { ok: true; output: string } | { ok: false; reason: "not_a_repo" | "git_error" };

const NOT_A_REPO_PATTERN = /not a git repository/i;

function runGit(cwd: string, args: string[]): GitRunResult {
  try {
    const output = execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    return { ok: true, output };
  } catch (err: any) {
    const stderr = String(err?.stderr ?? err?.message ?? "");
    if (NOT_A_REPO_PATTERN.test(stderr)) return { ok: false, reason: "not_a_repo" };
    return { ok: false, reason: "git_error" };
  }
}

export function gitStatus(canonicalRoot: string): GitRunResult {
  return runGit(canonicalRoot, ["status", "--porcelain=v1", "-b"]);
}

const DEFAULT_LOG_LIMIT = 50;
const MAX_LOG_LIMIT = 200;

export function gitLog(canonicalRoot: string, limit = DEFAULT_LOG_LIMIT, skip = 0): GitRunResult {
  const safeLimit = Math.min(Math.max(1, Math.floor(limit) || DEFAULT_LOG_LIMIT), MAX_LOG_LIMIT);
  const safeSkip = Math.max(0, Math.floor(skip) || 0);
  return runGit(canonicalRoot, [
    "log",
    `-n`,
    String(safeLimit),
    `--skip=${safeSkip}`,
    "--pretty=format:%H%x1f%an%x1f%ad%x1f%s%x1e",
  ]);
}

// relativePath must already be a resolveCanonicalPath-verified relative path (or omitted
// for the whole-repo diff) — callers are responsible for guarding it before calling this.
export function gitDiff(canonicalRoot: string, relativePath?: string): GitRunResult {
  const args = ["diff", "--no-color"];
  if (relativePath) args.push("--", relativePath);
  return runGit(canonicalRoot, args);
}

/** Parses the first line of `git status --porcelain=v1 -b`'s output (e.g.
 * "## main...origin/main [ahead 1, behind 2]" or "## HEAD (no branch)") into safe,
 * structured fields for display — never re-exposes the raw line beyond what's already
 * repo-local branch/tracking info (no absolute path, no credential, no remote URL). */
export function parseStatusHeader(statusOutput: string): {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
} {
  const firstLine = statusOutput.split("\n")[0] ?? "";
  const result = { branch: null as string | null, upstream: null as string | null, ahead: 0, behind: 0, detached: false };
  if (!firstLine.startsWith("## ")) return result;
  const header = firstLine.slice(3);
  if (header.startsWith("HEAD (no branch)")) {
    result.detached = true;
    return result;
  }
  const aheadMatch = header.match(/\[ahead (\d+)(?:, behind (\d+))?\]/);
  const behindOnlyMatch = header.match(/\[behind (\d+)\]/);
  if (aheadMatch) {
    result.ahead = Number(aheadMatch[1]) || 0;
    result.behind = aheadMatch[2] ? Number(aheadMatch[2]) || 0 : 0;
  } else if (behindOnlyMatch) {
    result.behind = Number(behindOnlyMatch[1]) || 0;
  }
  const branchPart = header.split(/\.\.\.|\s\[/)[0] ?? header;
  result.branch = branchPart || null;
  const trackingMatch = header.match(/\.\.\.([^\s[]+)/);
  if (trackingMatch) result.upstream = trackingMatch[1] ?? null;
  return result;
}

export type ParsedStatusFile = { path: string; index: string; worktree: string };

/** Parses the changed-file lines of `git status --porcelain=v1 -b` (every line after the
 * first "## " header) into {path, index, worktree} — path is repo-relative only. */
export function parseStatusFiles(statusOutput: string): ParsedStatusFile[] {
  const lines = statusOutput.split("\n").filter((l) => l && !l.startsWith("## "));
  return lines.map((line) => {
    const index = line[0] ?? " ";
    const worktree = line[1] ?? " ";
    const rest = line.slice(3);
    // Renames appear as "old -> new"; only the new (current) path matters for a diff lookup.
    const arrowIdx = rest.indexOf(" -> ");
    const path = arrowIdx >= 0 ? rest.slice(arrowIdx + 4) : rest;
    return { path: path.trim(), index, worktree };
  });
}
