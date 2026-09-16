/**
 * Pure-logic tests for electron/taskComposer.ts — VYRON_CODE_V02_D09_TASK_FIRST_COMPOSER_AND_CONTEXT_REVIEW_AUTHORIZATION.
 * No Electron launch, no native dialog, no server, no network/WebSocket/HTTP/DNS/TCP/UDP, no
 * real token/endpoint/.env/process.env/safeStorage/keychain/Credential Manager access, no real
 * workspace file access, no terminal/shell/child_process, no Hermes session/prompt/event, no
 * provider/model/multimodel call. Every input below is a hand-written, explicit fixture value.
 */
import { describe, it, expect } from "vitest";
import {
  TASK_PROFILES,
  DEFAULT_TASK_PROFILE,
  getTaskProfileMeta,
  MAX_DRAFT_LENGTH,
  validateDraftText,
  canOpenReview,
  computeDraftState,
  MAX_CONTEXT_ITEMS,
  MAX_SINGLE_EXCERPT_CHARS,
  MAX_TOTAL_CONTEXT_CHARS,
  MAX_RELATIVE_PATH_LENGTH,
  buildFilePreviewContextItem,
  buildSearchResultContextItem,
  buildGitSummaryContextItem,
  buildWorkspaceNameContextItem,
  buildTaskProfileContextItem,
  addContextItem,
  removeContextItem,
  clearContextItems,
  buildReviewModel,
  REVIEW_DESTINATION_NOTE,
  REVIEW_NETWORK_NOTE,
  REVIEW_DISCLOSURE_NOTE,
  REVIEW_EMPTY_CONTEXT_NOTE,
  COMPOSER_DISCLOSURE_NOTE,
  type TaskContextItem,
  type TaskProfile,
} from "../electron/taskComposer";

describe("task profiles", () => {
  it("exposes exactly the required initial profile set, in order", () => {
    expect(TASK_PROFILES.map((meta) => meta.id)).toEqual([
      "explain",
      "review",
      "plan",
      "investigate",
      "summarize_workspace",
      "analyze_git_status",
    ]);
  });

  it("uses deterministic, safe labels that never imply an action already ran", () => {
    const labels = TASK_PROFILES.map((meta) => meta.label);
    expect(labels).toEqual(["Explain", "Review", "Plan", "Investigate", "Summarize workspace", "Analyze Git status"]);
    for (const meta of TASK_PROFILES) {
      expect(meta.draftPlaceholder.toLowerCase()).not.toMatch(/\b(sent|started|running|executed|connected)\b/);
    }
  });

  it("getTaskProfileMeta returns the matching metadata for every real profile id", () => {
    for (const meta of TASK_PROFILES) {
      expect(getTaskProfileMeta(meta.id)).toBe(meta);
    }
  });

  it("falls back safely (never throws) for an arbitrary, non-catalog profile value", () => {
    const arbitrary = "arbitrary_free_form_profile" as unknown as TaskProfile;
    expect(() => getTaskProfileMeta(arbitrary)).not.toThrow();
    expect(getTaskProfileMeta(arbitrary)).toBe(TASK_PROFILES[0]);
  });

  it("has a default profile that is one of the real catalog entries", () => {
    expect(TASK_PROFILES.some((meta) => meta.id === DEFAULT_TASK_PROFILE)).toBe(true);
  });

  it("exposes no send/submit/execute/session function of any kind", () => {
    const moduleExportNames = Object.keys({
      TASK_PROFILES,
      getTaskProfileMeta,
      validateDraftText,
      canOpenReview,
      computeDraftState,
      buildFilePreviewContextItem,
      buildSearchResultContextItem,
      buildGitSummaryContextItem,
      buildWorkspaceNameContextItem,
      buildTaskProfileContextItem,
      addContextItem,
      removeContextItem,
      clearContextItems,
      buildReviewModel,
    });
    for (const name of moduleExportNames) {
      expect(name.toLowerCase()).not.toMatch(/send|submit|execute|startsession|createsession|prompt/);
    }
  });
});

describe("draft composer validation", () => {
  it("rejects an empty draft", () => {
    expect(validateDraftText("")).toEqual({ valid: false, reason: "empty" });
  });

  it("accepts a normal, valid draft", () => {
    expect(validateDraftText("Explain this module's design.")).toEqual({ valid: true, reason: null });
  });

  it("rejects a whitespace-only draft", () => {
    expect(validateDraftText("   \n\t   ")).toEqual({ valid: false, reason: "whitespace_only" });
  });

  it("rejects a control-character-only draft", () => {
    expect(validateDraftText("\u0000\u0001\u0002")).toEqual({ valid: false, reason: "control_characters" });
  });

  it("rejects a draft containing an embedded control character amid real text", () => {
    expect(validateDraftText("hello\u0007world")).toEqual({ valid: false, reason: "control_characters" });
  });

  it("permits legitimate whitespace (tab/newline/carriage-return) inside an otherwise valid draft", () => {
    expect(validateDraftText("line one\nline two\ttabbed\r\n")).toEqual({ valid: true, reason: null });
  });

  it("rejects a draft longer than MAX_DRAFT_LENGTH", () => {
    const tooLong = "a".repeat(MAX_DRAFT_LENGTH + 1);
    expect(validateDraftText(tooLong)).toEqual({ valid: false, reason: "too_long" });
  });

  it("accepts a draft exactly at MAX_DRAFT_LENGTH", () => {
    const atLimit = "a".repeat(MAX_DRAFT_LENGTH);
    expect(validateDraftText(atLimit).valid).toBe(true);
  });

  it("canOpenReview mirrors validateDraftText exactly", () => {
    expect(canOpenReview("")).toBe(false);
    expect(canOpenReview("   ")).toBe(false);
    expect(canOpenReview("\u0000")).toBe(false);
    expect(canOpenReview("a".repeat(MAX_DRAFT_LENGTH + 1))).toBe(false);
    expect(canOpenReview("a real task draft")).toBe(true);
  });
});

describe("draft lifecycle state", () => {
  it("reports draft_empty for empty, non-cleared text", () => {
    expect(computeDraftState({ text: "", hasFocus: false, reviewOpen: false, justCleared: false })).toBe("draft_empty");
  });

  it("reports draft_cleared immediately after an explicit clear", () => {
    expect(computeDraftState({ text: "", hasFocus: false, reviewOpen: false, justCleared: true })).toBe("draft_cleared");
  });

  it("reports draft_invalid for invalid non-empty text", () => {
    expect(computeDraftState({ text: "   ", hasFocus: false, reviewOpen: false, justCleared: false })).toBe("draft_invalid");
  });

  it("reports draft_editing for valid text while focused, draft_ready_for_review once blurred", () => {
    expect(computeDraftState({ text: "hello", hasFocus: true, reviewOpen: false, justCleared: false })).toBe("draft_editing");
    expect(computeDraftState({ text: "hello", hasFocus: false, reviewOpen: false, justCleared: false })).toBe(
      "draft_ready_for_review",
    );
  });

  it("reports review_open whenever review is open, regardless of text", () => {
    expect(computeDraftState({ text: "", hasFocus: false, reviewOpen: true, justCleared: false })).toBe("review_open");
    expect(computeDraftState({ text: "hello", hasFocus: true, reviewOpen: true, justCleared: false })).toBe("review_open");
  });

  it("never throws — always returns a defined DraftState", () => {
    expect(() => computeDraftState({ text: "x", hasFocus: false, reviewOpen: false, justCleared: false })).not.toThrow();
  });
});

describe("context candidate builders", () => {
  it("builds a file_preview item from an already-rendered file preview", () => {
    const item = buildFilePreviewContextItem({
      relativePath: "src/index.ts",
      content: "export const x = 1;",
      lineCount: 1,
      truncated: false,
    });
    expect(item?.kind).toBe("file_preview");
    expect(item?.relativePath).toBe("src/index.ts");
    expect(item?.lineRange).toBe("1-1");
    expect(item?.truncated).toBe(false);
  });

  it("truncates an oversized file preview excerpt to MAX_SINGLE_EXCERPT_CHARS", () => {
    const bigContent = "x".repeat(MAX_SINGLE_EXCERPT_CHARS + 500);
    const item = buildFilePreviewContextItem({ relativePath: "big.txt", content: bigContent, lineCount: 1, truncated: false });
    expect(item?.charCount).toBe(MAX_SINGLE_EXCERPT_CHARS);
    expect(item?.truncated).toBe(true);
  });

  it("rejects an absolute path for a file_preview candidate", () => {
    expect(buildFilePreviewContextItem({ relativePath: "/etc/passwd", content: "x", lineCount: 1, truncated: false })).toBeNull();
    expect(
      buildFilePreviewContextItem({ relativePath: "C:\\Windows\\win.ini", content: "x", lineCount: 1, truncated: false }),
    ).toBeNull();
  });

  it("rejects a parent-traversal path for a file_preview candidate", () => {
    expect(buildFilePreviewContextItem({ relativePath: "../secret.txt", content: "x", lineCount: 1, truncated: false })).toBeNull();
    expect(
      buildFilePreviewContextItem({ relativePath: "a/../../secret.txt", content: "x", lineCount: 1, truncated: false }),
    ).toBeNull();
  });

  it("builds a search_result item and rejects a non-positive line number", () => {
    const item = buildSearchResultContextItem({ relativePath: "src/a.ts", line: 12, preview: "const y = 2;" });
    expect(item?.kind).toBe("search_result");
    expect(item?.lineRange).toBe("line 12");
    expect(buildSearchResultContextItem({ relativePath: "src/a.ts", line: 0, preview: "x" })).toBeNull();
    expect(buildSearchResultContextItem({ relativePath: "src/a.ts", line: -3, preview: "x" })).toBeNull();
  });

  it("builds a git_summary item summarizing only safe aggregate counts", () => {
    const item = buildGitSummaryContextItem({
      branch: "master",
      detached: false,
      trackedChangesAvailable: true,
      modifiedCount: 3,
      deletedCount: 1,
      untrackedCount: 5,
    });
    expect(item.kind).toBe("git_summary");
    expect(item.relativePath).toBeNull();
    expect(item.detail).toContain("branch master");
    expect(item.detail).toContain("3 modified");
  });

  it("builds a workspace_name item, and rejects an empty/whitespace name", () => {
    expect(buildWorkspaceNameContextItem("my-project")?.detail).toBe("my-project");
    expect(buildWorkspaceNameContextItem("   ")).toBeNull();
    expect(buildWorkspaceNameContextItem("")).toBeNull();
  });

  it("builds a task_profile item as a singleton id regardless of which profile", () => {
    const explain = buildTaskProfileContextItem("explain");
    const plan = buildTaskProfileContextItem("plan");
    expect(explain.id).toBe("task_profile");
    expect(plan.id).toBe("task_profile");
    expect(explain.detail).toContain("Explain");
    expect(plan.detail).toContain("Plan");
  });

  it("never produces a relativePath field on the three non-path candidate classes", () => {
    const git = buildGitSummaryContextItem({
      branch: null,
      detached: true,
      trackedChangesAvailable: false,
      modifiedCount: null,
      deletedCount: null,
      untrackedCount: 0,
    });
    const ws = buildWorkspaceNameContextItem("name");
    const profile = buildTaskProfileContextItem("explain");
    expect(git.relativePath).toBeNull();
    expect(ws?.relativePath).toBeNull();
    expect(profile.relativePath).toBeNull();
  });
});

describe("context selection limits and mutation", () => {
  function makeUniqueFileItem(index: number): TaskContextItem {
    const built = buildFilePreviewContextItem({ relativePath: `file${index}.ts`, content: "x", lineCount: 1, truncated: false });
    if (!built) throw new Error("expected a built item in this test fixture");
    return built;
  }

  it("adds an item through addContextItem only, one at a time", () => {
    const result = addContextItem([], makeUniqueFileItem(1));
    expect(result.outcome).toBe("added");
    expect(result.items).toHaveLength(1);
  });

  it("enforces MAX_CONTEXT_ITEMS — the (N+1)th distinct item is rejected", () => {
    let items: readonly TaskContextItem[] = [];
    for (let i = 0; i < MAX_CONTEXT_ITEMS; i++) {
      items = addContextItem(items, makeUniqueFileItem(i)).items;
    }
    expect(items).toHaveLength(MAX_CONTEXT_ITEMS);
    const overflow = addContextItem(items, makeUniqueFileItem(MAX_CONTEXT_ITEMS));
    expect(overflow.outcome).toBe("rejected_item_limit");
    expect(overflow.items).toHaveLength(MAX_CONTEXT_ITEMS);
  });

  it("enforces MAX_TOTAL_CONTEXT_CHARS across the whole selection", () => {
    const itemsNeededToFillBudget = Math.floor(MAX_TOTAL_CONTEXT_CHARS / MAX_SINGLE_EXCERPT_CHARS);
    let items: readonly TaskContextItem[] = [];
    for (let i = 0; i < itemsNeededToFillBudget; i++) {
      const maxSized = buildFilePreviewContextItem({
        relativePath: `huge-${i}.ts`,
        content: "x".repeat(MAX_SINGLE_EXCERPT_CHARS),
        lineCount: 1,
        truncated: false,
      });
      if (!maxSized) throw new Error("expected a built item in this test fixture");
      items = addContextItem(items, maxSized).items;
    }
    const totalSoFar = items.reduce((sum, item) => sum + item.charCount, 0);
    expect(totalSoFar).toBeLessThanOrEqual(MAX_TOTAL_CONTEXT_CHARS);

    // One more max-sized, distinct item must now overflow the aggregate cap.
    const overflowCandidate = buildFilePreviewContextItem({
      relativePath: "one-too-many.ts",
      content: "x".repeat(MAX_SINGLE_EXCERPT_CHARS),
      lineCount: 1,
      truncated: false,
    });
    if (!overflowCandidate) throw new Error("expected a built item in this test fixture");
    const overflow = addContextItem(items, overflowCandidate);
    expect(overflow.outcome).toBe("rejected_total_char_limit");
    expect(overflow.items).toHaveLength(items.length);
  });

  it("deterministically merges a duplicate add (same id) instead of appending a second entry", () => {
    const first = addContextItem([], makeUniqueFileItem(1));
    const second = addContextItem(first.items, makeUniqueFileItem(1));
    expect(second.outcome).toBe("merged_duplicate");
    expect(second.items).toHaveLength(1);
  });

  it("removes exactly one item by id", () => {
    const withTwo = addContextItem(addContextItem([], makeUniqueFileItem(1)).items, makeUniqueFileItem(2)).items;
    const afterRemove = removeContextItem(withTwo, "file:file1.ts");
    expect(afterRemove).toHaveLength(1);
    expect(afterRemove[0]?.id).toBe("file:file2.ts");
  });

  it("clears the whole selection", () => {
    expect(clearContextItems()).toEqual([]);
  });

  it("relative paths are clamped to MAX_RELATIVE_PATH_LENGTH", () => {
    const longPath = `src/${"a".repeat(MAX_RELATIVE_PATH_LENGTH + 50)}.ts`;
    const item = buildFilePreviewContextItem({ relativePath: longPath, content: "x", lineCount: 1, truncated: false });
    expect(item?.relativePath?.length).toBeLessThanOrEqual(MAX_RELATIVE_PATH_LENGTH);
  });
});

describe("review model", () => {
  it("assembles profile label, draft text, and itemized context", () => {
    const item = buildWorkspaceNameContextItem("demo-workspace");
    if (!item) throw new Error("expected built item");
    const model = buildReviewModel("plan", "Plan the next milestone.", [item]);
    expect(model.profileLabel).toBe("Plan");
    expect(model.draftText).toBe("Plan the next milestone.");
    expect(model.contextItems).toEqual([item]);
  });

  it("carries the required local-only / no-send disclosure text", () => {
    const model = buildReviewModel("explain", "x", []);
    expect(model.destinationNote).toBe(REVIEW_DESTINATION_NOTE);
    expect(model.networkNote).toBe(REVIEW_NETWORK_NOTE);
    expect(model.disclosureNote).toBe(REVIEW_DISCLOSURE_NOTE);
    expect(model.destinationNote.toLowerCase()).toContain("not configured");
    expect(model.networkNote.toLowerCase()).toContain("no request");
  });

  it("represents an empty selection safely rather than omitting the field", () => {
    const model = buildReviewModel("explain", "x", []);
    expect(model.contextItems).toEqual([]);
    expect(model.emptyContextNote).toBe(REVIEW_EMPTY_CONTEXT_NOTE);
  });

  it("never includes a token/endpoint/session/protocol field on the model shape", () => {
    const model = buildReviewModel("explain", "x", []);
    const keys = Object.keys(model);
    for (const forbidden of ["token", "endpoint", "session", "protocol", "host", "port", "socket"]) {
      expect(keys.map((k) => k.toLowerCase())).not.toContain(forbidden);
    }
  });

  it("COMPOSER_DISCLOSURE_NOTE matches the required exact copy", () => {
    expect(COMPOSER_DISCLOSURE_NOTE).toContain("Nothing is sent automatically.");
    expect(COMPOSER_DISCLOSURE_NOTE).toContain(
      "Review your task and selected context before any future send action becomes available.",
    );
  });
});
