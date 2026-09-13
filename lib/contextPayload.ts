/**
 * Revalidation + prompt-block assembly for the Explicit Attach-to-Chat gate
 * (VYRON_CODE_V01_GIT_AND_EXPLICIT_CONTEXT_IMPLEMENTATION_AUTHORIZATION, sections D & E).
 *
 * Pure/testable on purpose: no network call, no Hermes client, no database write — so its
 * assembly and fail-closed behavior can be unit-tested without ever invoking a real
 * provider-backed prompt. The attach route and the prompt route are the only two callers,
 * and both must run revalidateItems() immediately before using the result — a session's
 * `attached` flag on a row is never itself treated as proof the content is still valid.
 */
import { fingerprintOf, parseFileRange, parseHunkRef, type ContextSelectionRow } from "./contextSelections";
import { extractFileSnippet, extractGitHunk } from "./contextContent";

export type RevalidatedItem = { row: ContextSelectionRow; freshContent: string };
export type RevalidationFailure = { id: string; pathOrRef: string; reason: string };

/**
 * Re-reads every item's underlying content fresh (from disk or from `git diff`, never from
 * anything cached) and compares its SHA-256 fingerprint against the one recorded at
 * selection time. ANY failure (deny-listed/moved/deleted path, binary now, out-of-range
 * line, missing hunk, or a fingerprint mismatch) fails the WHOLE batch closed — per the
 * authorization's "no automatic re-send of new content" rule, a partially-stale attach set
 * is never silently narrowed and sent; the caller must surface exactly which item(s) changed
 * so the user can remove or refresh them.
 */
export function revalidateItems(items: ContextSelectionRow[]): { ok: true; items: RevalidatedItem[] } | { ok: false; failures: RevalidationFailure[] } {
  const results: RevalidatedItem[] = [];
  const failures: RevalidationFailure[] = [];

  for (const row of items) {
    if (row.kind === "file_snippet") {
      const range = parseFileRange(row.rangeOrHunk);
      if (!range) {
        failures.push({ id: row.id, pathOrRef: row.pathOrRef, reason: "invalid_stored_range" });
        continue;
      }
      const extraction = extractFileSnippet(row.projectId, row.pathOrRef, range.startLine, range.endLine);
      if (!extraction.ok) {
        failures.push({ id: row.id, pathOrRef: row.pathOrRef, reason: extraction.reason });
        continue;
      }
      if (fingerprintOf(extraction.content) !== row.contentFingerprint) {
        failures.push({ id: row.id, pathOrRef: row.pathOrRef, reason: "content_changed" });
        continue;
      }
      results.push({ row, freshContent: extraction.content });
    } else {
      const hunkRef = parseHunkRef(row.rangeOrHunk);
      if (!hunkRef) {
        failures.push({ id: row.id, pathOrRef: row.pathOrRef, reason: "invalid_stored_hunk_ref" });
        continue;
      }
      const extraction = extractGitHunk(row.projectId, row.pathOrRef, hunkRef.header, hunkRef.index);
      if (!extraction.ok) {
        failures.push({ id: row.id, pathOrRef: row.pathOrRef, reason: extraction.reason });
        continue;
      }
      if (fingerprintOf(extraction.content) !== row.contentFingerprint) {
        failures.push({ id: row.id, pathOrRef: row.pathOrRef, reason: "content_changed" });
        continue;
      }
      results.push({ row, freshContent: extraction.content });
    }
  }

  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, items: results };
}

function formatRangeLabel(row: ContextSelectionRow): string {
  if (row.kind === "file_snippet") {
    const range = parseFileRange(row.rangeOrHunk);
    return range ? `${range.startLine}-${range.endLine}` : "?";
  }
  const hunkRef = parseHunkRef(row.rangeOrHunk);
  return hunkRef ? `hunk ${hunkRef.header}` : "hunk";
}

const CONTEXT_BLOCK_OPEN = "[VYRON_CODE_SELECTED_CONTEXT]";
const CONTEXT_BLOCK_CLOSE = "[/VYRON_CODE_SELECTED_CONTEXT]";

const MAX_PREVIEW_CHARS = 500;

export type ItemPreview = { stale: boolean; preview: string | null; reason: string | null };

/** Per-item, non-batch-failing check used ONLY for the Context Inspector's display (a
 * bounded, deny-list-enforced preview snippet plus a stale badge) — unlike revalidateItems,
 * one stale item here never hides the others; the Inspector needs to show the whole list
 * with each item's own status so the user can decide what to remove or refresh. */
export function previewItem(row: ContextSelectionRow): ItemPreview {
  const extraction =
    row.kind === "file_snippet"
      ? (() => {
          const range = parseFileRange(row.rangeOrHunk);
          return range ? extractFileSnippet(row.projectId, row.pathOrRef, range.startLine, range.endLine) : ({ ok: false, reason: "invalid_stored_range" } as const);
        })()
      : (() => {
          const hunkRef = parseHunkRef(row.rangeOrHunk);
          return hunkRef ? extractGitHunk(row.projectId, row.pathOrRef, hunkRef.header, hunkRef.index) : ({ ok: false, reason: "invalid_stored_hunk_ref" } as const);
        })();

  if (!extraction.ok) return { stale: true, preview: null, reason: extraction.reason };
  const stale = fingerprintOf(extraction.content) !== row.contentFingerprint;
  return { stale, preview: extraction.content.slice(0, MAX_PREVIEW_CHARS), reason: stale ? "content_changed" : null };
}

/** Assembles the exact bounded, provenance-labelled block format the authorization
 * specifies, one per item, in the order given (callers pass items already ordered
 * deterministically — selection/insertion order), followed by the user's own prompt text
 * unchanged. Never called at all when no context is attached — the prompt route's existing
 * byte-for-byte-unchanged path never imports this function. */
export function assembleContextPrompt(items: RevalidatedItem[], projectDisplayName: string, userText: string): string {
  const blocks = items.map(
    ({ row, freshContent }) =>
      `${CONTEXT_BLOCK_OPEN}\nProject: ${projectDisplayName}\nSource: ${row.pathOrRef}\nLines: ${formatRangeLabel(row)}\nContent:\n${freshContent}\n${CONTEXT_BLOCK_CLOSE}`
  );
  return [...blocks, userText].join("\n\n");
}
