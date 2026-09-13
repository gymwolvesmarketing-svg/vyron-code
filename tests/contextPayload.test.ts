import { describe, it, expect, vi } from "vitest";

vi.mock("../lib/contextContent", () => ({
  extractFileSnippet: vi.fn(),
  extractGitHunk: vi.fn(),
}));

import { extractFileSnippet, extractGitHunk } from "../lib/contextContent";
import { assembleContextPrompt, revalidateItems, previewItem } from "../lib/contextPayload";
import { fingerprintOf, serializeFileRange, serializeHunkRef, type ContextSelectionRow } from "../lib/contextSelections";

function makeRow(overrides: Partial<ContextSelectionRow>): ContextSelectionRow {
  return {
    id: "id1",
    sessionId: "sess1",
    projectId: "proj1",
    kind: "file_snippet",
    pathOrRef: "src/foo.ts",
    rangeOrHunk: serializeFileRange({ startLine: 10, endLine: 12 }),
    contentFingerprint: fingerprintOf("line10\nline11\nline12"),
    charCount: 21,
    tokenEstimate: 6,
    attached: false,
    attachedAt: null,
    createdAt: 1,
    ...overrides,
  };
}

describe("assembleContextPrompt", () => {
  it("wraps each item in the exact [VYRON_CODE_SELECTED_CONTEXT] block format, then the user's prompt", () => {
    const row = makeRow({});
    const output = assembleContextPrompt([{ row, freshContent: "line10\nline11\nline12" }], "MyProject", "What does this do?");
    expect(output).toBe(
      [
        "[VYRON_CODE_SELECTED_CONTEXT]",
        "Project: MyProject",
        "Source: src/foo.ts",
        "Lines: 10-12",
        "Content:",
        "line10\nline11\nline12",
        "[/VYRON_CODE_SELECTED_CONTEXT]",
        "",
        "What does this do?",
      ].join("\n")
    );
  });

  it("labels a git_diff_hunk item with its hunk header instead of a line range", () => {
    const row = makeRow({ kind: "git_diff_hunk", rangeOrHunk: serializeHunkRef({ header: "@@ -1,2 +1,3 @@", index: 0 }), contentFingerprint: fingerprintOf("@@ -1,2 +1,3 @@\n+new") });
    const output = assembleContextPrompt([{ row, freshContent: "@@ -1,2 +1,3 @@\n+new" }], "MyProject", "review this");
    expect(output).toContain("Lines: hunk @@ -1,2 +1,3 @@");
  });

  it("preserves deterministic (given) order across multiple items and never reorders them", () => {
    const rowA = makeRow({ id: "a", pathOrRef: "a.ts" });
    const rowB = makeRow({ id: "b", pathOrRef: "b.ts" });
    const output = assembleContextPrompt(
      [
        { row: rowA, freshContent: "line10\nline11\nline12" },
        { row: rowB, freshContent: "line10\nline11\nline12" },
      ],
      "P",
      "go"
    );
    expect(output.indexOf("a.ts")).toBeLessThan(output.indexOf("b.ts"));
  });

  it("with zero items, is just the user's own text (no context wrapper at all)", () => {
    expect(assembleContextPrompt([], "P", "hello")).toBe("hello");
  });
});

describe("revalidateItems — fail-closed staleness", () => {
  it("returns ok:true with fresh content when the fingerprint still matches", () => {
    vi.mocked(extractFileSnippet).mockReturnValue({ ok: true, content: "line10\nline11\nline12", relativePath: "src/foo.ts" });
    const row = makeRow({});
    const result = revalidateItems([row]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items[0]?.freshContent).toBe("line10\nline11\nline12");
  });

  it("fails the WHOLE batch closed when one item's content changed since selection (no partial silent resend)", () => {
    vi.mocked(extractFileSnippet)
      .mockReturnValueOnce({ ok: true, content: "line10\nline11\nline12", relativePath: "src/foo.ts" }) // unchanged
      .mockReturnValueOnce({ ok: true, content: "CHANGED CONTENT", relativePath: "src/bar.ts" }); // changed
    const unchanged = makeRow({ id: "u" });
    const changed = makeRow({ id: "c", pathOrRef: "src/bar.ts" });
    const result = revalidateItems([unchanged, changed]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toEqual({ id: "c", pathOrRef: "src/bar.ts", reason: "content_changed" });
    }
  });

  it("fails closed when the underlying file/path is no longer readable (deleted, moved, or now denied)", () => {
    vi.mocked(extractFileSnippet).mockReturnValue({ ok: false, reason: "not_found" });
    const result = revalidateItems([makeRow({})]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures[0]?.reason).toBe("not_found");
  });

  it("routes git_diff_hunk items through extractGitHunk, not extractFileSnippet", () => {
    vi.mocked(extractGitHunk).mockReturnValue({ ok: true, content: "@@ -1,2 +1,3 @@\n+new", relativePath: "src/foo.ts" });
    const row = makeRow({ kind: "git_diff_hunk", rangeOrHunk: serializeHunkRef({ header: "@@ -1,2 +1,3 @@", index: 0 }), contentFingerprint: fingerprintOf("@@ -1,2 +1,3 @@\n+new") });
    const result = revalidateItems([row]);
    expect(result.ok).toBe(true);
    expect(extractGitHunk).toHaveBeenCalledWith("proj1", "src/foo.ts", "@@ -1,2 +1,3 @@", 0);
  });
});

describe("previewItem — per-item, non-batch-failing", () => {
  it("one stale item does not prevent computing a preview for it — it's just marked stale", () => {
    vi.mocked(extractFileSnippet).mockReturnValue({ ok: true, content: "DIFFERENT NOW", relativePath: "src/foo.ts" });
    const preview = previewItem(makeRow({}));
    expect(preview.stale).toBe(true);
    expect(preview.preview).toBe("DIFFERENT NOW");
  });

  it("bounds the preview to at most 500 characters", () => {
    const longContent = "x".repeat(10_000);
    vi.mocked(extractFileSnippet).mockReturnValue({ ok: true, content: longContent, relativePath: "src/foo.ts" });
    const row = makeRow({ contentFingerprint: fingerprintOf(longContent) });
    const preview = previewItem(row);
    expect(preview.stale).toBe(false);
    expect(preview.preview?.length).toBe(500);
  });
});
