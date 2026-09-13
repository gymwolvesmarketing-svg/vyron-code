/**
 * Splits a single-file unified diff (as returned by lib/git.ts's gitDiff for one
 * path-scoped call) into its individual hunks, so the Git UI can offer "add this hunk to
 * context" per hunk instead of only the whole diff. Pure text parsing only — never touches
 * the filesystem or runs git itself.
 */

export type DiffHunk = { index: number; header: string; body: string };

const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@.*$/;

export function parseDiffHunks(diffText: string): DiffHunk[] {
  const lines = diffText.split("\n");
  const hunks: DiffHunk[] = [];
  let current: { header: string; lines: string[] } | null = null;

  function flush() {
    if (current) {
      hunks.push({ index: hunks.length, header: current.header, body: [current.header, ...current.lines].join("\n") });
      current = null;
    }
  }

  for (const line of lines) {
    if (HUNK_HEADER_RE.test(line)) {
      flush();
      current = { header: line, lines: [] };
      continue;
    }
    if (line.startsWith("diff --git ")) {
      // A path-scoped diff should only ever contain one file, but stop cleanly if a second
      // file section somehow appears rather than merging its hunks into the first file's.
      flush();
      continue;
    }
    if (current) current.lines.push(line);
  }
  flush();
  return hunks;
}

/** Finds a specific hunk by its recorded header + index (index disambiguates the rare case
 * of two hunks sharing an identical header text). Returns null if the diff no longer
 * contains a matching hunk at that position — the caller treats that as "stale". */
export function findHunk(diffText: string, header: string, index: number): DiffHunk | null {
  const hunks = parseDiffHunks(diffText);
  const candidate = hunks[index];
  if (candidate && candidate.header === header) return candidate;
  // Fall back to a header-only match in case upstream lines shifted the hunk's index.
  return hunks.find((h) => h.header === header) ?? null;
}
