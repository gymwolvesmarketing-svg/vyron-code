/**
 * Canonical-path resolution — the single enforcement point for every filesystem-touching
 * route in Vyron Code. See VYRON_CODE_V01_SECURITY_THREAT_MODEL.md for the algorithm this
 * implements. Every fs/search/git route MUST go through resolveCanonicalPath(); nothing
 * else in this codebase is allowed to touch fs.* with an untrusted path directly.
 *
 * Windows note: fs.realpathSync.native resolves both symlinks AND NTFS junctions/reparse
 * points (it goes through libuv's uv_fs_realpath, which on Windows calls
 * GetFinalPathNameByHandleW) — verified empirically in tests/canonicalPath.test.ts by
 * creating a real junction and confirming it resolves to its target, not its link path.
 * This is the property the whole security model depends on; do not swap in
 * fs.realpathSync (the JS fallback) without re-verifying the same guarantee holds.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export type CanonicalResolution =
  | { ok: true; absolutePath: string; relativePath: string }
  | { ok: false; reason: "absolute_path_rejected" | "path_outside_project_root" | "path_denied" | "not_found" | "root_not_resolvable" };

// Path-component deny patterns — evaluated against every segment of the REQUESTED relative
// path (before any disk access), independent of the containment check. Case-insensitive.
const DENIED_NAME_PATTERNS: RegExp[] = [
  /^\.env(\..*)?$/i,
  /^\.git$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.pfx$/i,
  /^id_rsa.*$/i,
  /^id_ed25519.*$/i,
  /^node_modules$/i,
];

function isDeniedSegment(segment: string): boolean {
  return DENIED_NAME_PATTERNS.some((re) => re.test(segment));
}

/** Resolve and cache a project's own canonical root once, at project-registration time. */
export function resolveCanonicalRoot(rawRoot: string): string | null {
  try {
    const absolute = path.resolve(rawRoot);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) return null;
    return fs.realpathSync.native(absolute);
  } catch {
    return null;
  }
}

/**
 * PROJECT ROOT POLICY (VYRON_CODE_V01_LOCALHOST_AND_PROJECT_ROOT_HARDENING_AUTHORIZATION).
 *
 * A canonical root is rejected as "too broad" — even though it exists and is a real
 * directory — when registering it as a project would put a whole drive, a user's entire
 * profile, or one of their major top-level folders (Desktop/Documents/Downloads/etc., the
 * kind of folder that routinely contains many unrelated other projects, personal
 * documents, and cloud-sync content) inside Vyron Code's read/search surface. This is a
 * SEPARATE check from canonical-path containment (lib/canonicalPath.ts's
 * resolveCanonicalPath) — containment still runs on every request regardless; this check
 * only decides whether a root is even eligible to be *registered* in the first place, once,
 * at POST /api/projects time.
 *
 * Checked, in order:
 *  1. Any filesystem root (a drive root on Windows — "C:\", "D:\" — or "/" on POSIX):
 *     `path.parse(root).root === root` is the platform-generic way to detect this — it is
 *     true exactly when there is nothing above `root` to walk up to.
 *  2. The current user's home/profile directory (`os.homedir()`), exactly.
 *  3. A small fixed list of well-known broad folders directly under the home directory
 *     (Desktop, Documents, Downloads, Pictures, Music, Videos, OneDrive) — registering one
 *     of THESE specific folders is rejected, but a narrow project folder nested inside one
 *     of them (e.g. "Documents\my-actual-project") is NOT rejected by this rule; only exact
 *     matches on the known-broad names are checked, not a prefix/ancestor rule.
 *
 * All comparisons are case-insensitive on Windows (NTFS default) and operate on already-
 * canonicalized paths only (never the raw client string), so this cannot be bypassed by
 * casing, trailing separators, or a symlink/junction — the caller must pass the value
 * already returned by resolveCanonicalRoot().
 */
const BROAD_HOME_SUBFOLDER_NAMES = ["Desktop", "Documents", "Downloads", "Pictures", "Music", "Videos", "OneDrive"];

export type RootPolicyResult = { allowed: true } | { allowed: false; reason: "drive_root" | "home_root" | "common_user_folder" };

export function checkRootPolicy(canonicalRoot: string): RootPolicyResult {
  const isWindows = process.platform === "win32";
  const norm = (p: string) => (isWindows ? p.toLowerCase() : p);

  if (path.parse(canonicalRoot).root === canonicalRoot) {
    return { allowed: false, reason: "drive_root" };
  }

  let home: string | null = null;
  try {
    home = fs.realpathSync.native(os.homedir());
  } catch {
    home = os.homedir();
  }

  if (norm(canonicalRoot) === norm(home)) {
    return { allowed: false, reason: "home_root" };
  }

  for (const name of BROAD_HOME_SUBFOLDER_NAMES) {
    // turbopackIgnore: home is resolved at request time via os.homedir(), not a static
    // literal — without this hint, Turbopack's build tracer conservatively assumes the
    // whole project must be bundled for a standalone/serverless output (irrelevant to
    // v0.1's dev-only usage, but harmless and cheap to silence correctly).
    const candidate = path.join(/*turbopackIgnore: true*/ home, name);
    let canonicalCandidate: string;
    try {
      canonicalCandidate = fs.realpathSync.native(candidate);
    } catch {
      continue; // folder doesn't exist on this system — nothing to compare against
    }
    if (norm(canonicalRoot) === norm(canonicalCandidate)) {
      return { allowed: false, reason: "common_user_folder" };
    }
  }

  return { allowed: true };
}

/**
 * Resolve a client-supplied path against an already-canonicalized project root.
 * requestedRelativePath must be a RELATIVE path (forward or back slashes accepted) —
 * an absolute path from the client is rejected outright, never resolved against the root,
 * so a client can never "escape" by supplying its own absolute path.
 */
export function resolveCanonicalPath(canonicalRoot: string, requestedRelativePath: string): CanonicalResolution {
  const normalizedInput = requestedRelativePath.replace(/\\/g, "/");
  if (path.isAbsolute(normalizedInput) || /^[a-zA-Z]:/.test(normalizedInput)) {
    return { ok: false, reason: "absolute_path_rejected" };
  }

  const segments = normalizedInput.split("/").filter((s) => s.length > 0 && s !== ".");
  for (const segment of segments) {
    if (isDeniedSegment(segment)) return { ok: false, reason: "path_denied" };
  }

  // path.resolve collapses ".." textually; the realpath step below then resolves any
  // symlink/junction actually present on disk, which is the check that matters.
  const textuallyResolved = path.resolve(canonicalRoot, ...segments);

  let canonicalCandidate: string;
  try {
    if (!fs.existsSync(textuallyResolved)) return { ok: false, reason: "not_found" };
    canonicalCandidate = fs.realpathSync.native(textuallyResolved);
  } catch {
    return { ok: false, reason: "not_found" };
  }

  const rootWithSep = canonicalRoot.endsWith(path.sep) ? canonicalRoot : canonicalRoot + path.sep;
  const isWindows = process.platform === "win32";
  const rootCmp = isWindows ? rootWithSep.toLowerCase() : rootWithSep;
  const candidateCmp = isWindows ? canonicalCandidate.toLowerCase() : canonicalCandidate;

  const isRootItself = (isWindows ? canonicalCandidate.toLowerCase() : canonicalCandidate) === (isWindows ? canonicalRoot.toLowerCase() : canonicalRoot);
  if (!isRootItself && !candidateCmp.startsWith(rootCmp)) {
    return { ok: false, reason: "path_outside_project_root" };
  }

  const relativePath = path.relative(canonicalRoot, canonicalCandidate).replace(/\\/g, "/");
  return { ok: true, absolutePath: canonicalCandidate, relativePath: relativePath || "." };
}
