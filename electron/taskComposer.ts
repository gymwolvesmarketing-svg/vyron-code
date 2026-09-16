/**
 * Local-only task-first composer logic — VYRON_CODE_V02_D09_TASK_FIRST_COMPOSER_AND_CONTEXT_REVIEW_AUTHORIZATION.
 *
 * This module is deliberately renderer-safe and framework-free: no `import` of "electron",
 * "fs", "path", "os", "child_process", "ws", or any Node builtin; no `document`/`window`
 * reference; no network primitive (`fetch`, `XMLHttpRequest`, `WebSocket`); no browser storage
 * primitive (`localStorage`, `sessionStorage`, `indexedDB`, `document.cookie`). It holds only
 * pure types and pure functions operating on plain data the caller supplies and owns — this is
 * what makes it directly unit-testable without a DOM (see tests/electronTaskComposer.test.ts),
 * exactly mirroring why electron/hermesEndpointSetup.ts's `validateEndpointCandidate` is a pure,
 * directly-testable export. `electron/renderer.ts` is the ONLY caller: it holds the actual
 * mutable `let` state (draft text, selected profile, context items, review-open flag) in its
 * own module scope and calls the functions below to validate input, build context items from
 * data it already has on screen, and compute the review model — then renders the DOM itself.
 *
 * D-09's own scope boundary, restated in code terms: nothing exported here can create a
 * network request, an IPC call, a Hermes session/prompt, a file write, or a Git write. There is
 * no "send"/"submit"/"execute"/"startSession" export of any kind — only draft validation,
 * context-item construction/limiting/deduplication, and review-model assembly. No draft or
 * context value is ever written to a persistent store by this module; the caller (renderer.ts)
 * is likewise required to keep all of this in renderer memory only (see its own header note).
 *
 * Context items are intentionally built ONLY from data the caller already received through the
 * existing bounded, read-only workspace IPC calls (a rendered file preview, a rendered search
 * result row, a rendered Git summary, the granted workspace's display name) or from the
 * caller's own already-selected task profile — never by this module reaching out to read,
 * list, or search anything itself. Every builder function below re-clamps its input against
 * this module's own excerpt/path-length bounds (independent of, and in most cases far smaller
 * than, the underlying workspace IPC methods' own bounds — see electron/workspaceFileViewer.ts's
 * `MAX_CONTENT_CHARS`/electron/workspaceSearch.ts's `MAX_PREVIEW_CHARS`) and defensively rejects
 * any path shaped like an absolute or parent-traversal path, as a belt-and-suspenders local
 * check — the real security boundary for what counts as a safe relative path is, and remains,
 * enforced main-process-side in electron/workspaceExplorer.ts/workspaceFileViewer.ts/
 * workspaceSearch.ts, not here.
 */

// ---------------------------------------------------------------------------------------
// Task profiles — local intent/template metadata only. See this file's own header: selecting
// a profile never creates a session, connects to Hermes, sends a prompt, reads/lists/searches
// the workspace, selects a provider/model, or starts a subagent. Every label/placeholder/
// framing string below describes a DRAFT the user is composing, never an action that ran.
// ---------------------------------------------------------------------------------------
export type TaskProfile = "explain" | "review" | "plan" | "investigate" | "summarize_workspace" | "analyze_git_status";

export interface TaskProfileMeta {
  readonly id: TaskProfile;
  readonly label: string;
  readonly draftPlaceholder: string;
  readonly reviewFramingNote: string;
}

export const TASK_PROFILES: readonly TaskProfileMeta[] = [
  {
    id: "explain",
    label: "Explain",
    draftPlaceholder: "Describe what you would like explained…",
    reviewFramingNote: "This draft frames a local explanation request.",
  },
  {
    id: "review",
    label: "Review",
    draftPlaceholder: "Describe what you would like reviewed…",
    reviewFramingNote: "This draft frames a local review request.",
  },
  {
    id: "plan",
    label: "Plan",
    draftPlaceholder: "Describe what you would like planned…",
    reviewFramingNote: "This draft frames a local planning request.",
  },
  {
    id: "investigate",
    label: "Investigate",
    draftPlaceholder: "Describe what you would like investigated…",
    reviewFramingNote: "This draft frames a local investigation request.",
  },
  {
    id: "summarize_workspace",
    label: "Summarize workspace",
    draftPlaceholder: "Describe the kind of workspace summary you want…",
    reviewFramingNote: "This draft frames a local workspace-summary request.",
  },
  {
    id: "analyze_git_status",
    label: "Analyze Git status",
    draftPlaceholder: "Describe what you would like analyzed about Git status…",
    reviewFramingNote: "This draft frames a local Git-status analysis request.",
  },
];

export const DEFAULT_TASK_PROFILE: TaskProfile = "explain";

export function getTaskProfileMeta(profile: TaskProfile): TaskProfileMeta {
  // TASK_PROFILES is a non-empty compile-time literal, so this fallback is always defined —
  // the assertion exists only to satisfy `noUncheckedIndexedAccess`, not to bypass a real check.
  return TASK_PROFILES.find((meta) => meta.id === profile) ?? TASK_PROFILES[0]!;
}

// ---------------------------------------------------------------------------------------
// Draft composer — renderer-memory-only. See this file's own header for the persistence and
// transport prohibitions. `MAX_DRAFT_LENGTH` is a new, independent, disclosed bound for this
// draft box specifically — deliberately far smaller than electron/workspaceFileViewer.ts's own
// 200,000-char raw file-preview bound, since this text is a short task description, not a file.
// ---------------------------------------------------------------------------------------
export const MAX_DRAFT_LENGTH = 4_000;

/** C0 control characters and DEL, excluding tab/newline/carriage-return (legitimate in a
 * multi-line draft). Any occurrence anywhere in the draft — not only a control-character-only
 * draft — is rejected; this is stricter than, and a superset of, the required "control-
 * character-only draft must fail safely" case. */
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export type DraftInvalidReason = "empty" | "too_long" | "control_characters" | "whitespace_only";

export interface DraftValidation {
  readonly valid: boolean;
  readonly reason: DraftInvalidReason | null;
}

export function validateDraftText(raw: string): DraftValidation {
  if (raw.length === 0) return { valid: false, reason: "empty" };
  if (raw.length > MAX_DRAFT_LENGTH) return { valid: false, reason: "too_long" };
  if (CONTROL_CHARACTER_PATTERN.test(raw)) return { valid: false, reason: "control_characters" };
  if (raw.trim().length === 0) return { valid: false, reason: "whitespace_only" };
  return { valid: true, reason: null };
}

/** The sole gate for opening the review surface — a draft may enter `review_open` only when
 * this returns `true`. Intentionally identical to `validateDraftText(text).valid`; kept as its
 * own named export so call sites read as an explicit precondition check rather than a reused
 * validation detail. */
export function canOpenReview(draftText: string): boolean {
  return validateDraftText(draftText).valid;
}

export type DraftState =
  | "draft_empty"
  | "draft_editing"
  | "draft_invalid"
  | "draft_ready_for_review"
  | "review_open"
  | "draft_cleared"
  | "safe_failure";

export interface DraftStateInput {
  /** The current draft text, exactly as held in the caller's own renderer-memory state. */
  readonly text: string;
  /** Whether the draft's own input control currently has keyboard focus. Used only to choose
   * between the two live-typing/ready-to-review status labels — never to gate anything (the
   * Review action is gated by `canOpenReview` alone, independent of focus, since clicking the
   * Review button itself moves focus away from the draft field). */
  readonly hasFocus: boolean;
  /** Whether the review surface is currently open. Takes priority over every other input. */
  readonly reviewOpen: boolean;
  /** A one-shot flag the caller sets immediately after an explicit "Clear draft" action and
   * clears again the moment the user types anything new. */
  readonly justCleared: boolean;
}

/** Computes the current draft lifecycle state. Wrapped in try/catch so this always returns a
 * defined member of `DraftState` rather than throwing — `"safe_failure"` is the deliberate,
 * explicit fallback for any unexpected input shape, never a raw error surfaced to the UI. */
export function computeDraftState(input: DraftStateInput): DraftState {
  try {
    if (input.reviewOpen) return "review_open";
    if (input.justCleared && input.text.length === 0) return "draft_cleared";
    if (input.text.length === 0) return "draft_empty";
    const validation = validateDraftText(input.text);
    if (!validation.valid) return "draft_invalid";
    return input.hasFocus ? "draft_editing" : "draft_ready_for_review";
  } catch {
    return "safe_failure";
  }
}

export const COMPOSER_DISCLOSURE_NOTE =
  "Nothing is sent automatically.\n\nReview your task and selected context before any future send action becomes available.";

// ---------------------------------------------------------------------------------------
// Context selection — local renderer state only. Every limit below is enforced here, in pure
// functions, independent of any DOM rendering, so it is directly testable. See this file's own
// header for exactly which candidate classes are permitted and why no automatic collection
// exists: every builder below takes data the caller already has on screen; none of them read,
// list, or search anything.
// ---------------------------------------------------------------------------------------
export const MAX_CONTEXT_ITEMS = 12;
/** Bounds any single context item's own excerpt/detail text — independent of, and far smaller
 * than, the underlying file-preview (200,000 chars) or search-result-preview (300 chars,
 * already smaller than this bound) limits those features use for their own on-screen display. */
export const MAX_SINGLE_EXCERPT_CHARS = 4_000;
/** Bounds the sum of every selected item's `charCount` at once. */
export const MAX_TOTAL_CONTEXT_CHARS = 20_000;
/** Defensive display-only clamp on a relative path's length; the real path-safety boundary is
 * enforced main-process-side, not here (see this file's own header). */
export const MAX_RELATIVE_PATH_LENGTH = 400;

export type TaskContextItemKind = "file_preview" | "search_result" | "git_summary" | "workspace_name" | "task_profile";

/** A single selected context item's safe, renderer-facing shape. Never carries an absolute or
 * parent path, a token, an endpoint, a connection-state internal, an environment variable, or
 * any value outside what the five builder functions below explicitly construct. */
export interface TaskContextItem {
  readonly id: string;
  readonly kind: TaskContextItemKind;
  readonly label: string;
  readonly detail: string;
  readonly relativePath: string | null;
  readonly lineRange: string | null;
  readonly charCount: number;
  readonly truncated: boolean;
}

function isSafeRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath.length === 0) return false;
  if (relativePath.startsWith("/") || relativePath.startsWith("\\")) return false;
  if (/^[a-zA-Z]:[\\/]/.test(relativePath)) return false;
  if (relativePath.split(/[\\/]/).some((segment) => segment === "..")) return false;
  return true;
}

function clampText(value: string, maxLength: number): { readonly text: string; readonly truncated: boolean } {
  if (value.length <= maxLength) return { text: value, truncated: false };
  return { text: value.slice(0, maxLength), truncated: true };
}

export interface FilePreviewCandidateInput {
  readonly relativePath: string;
  readonly content: string;
  readonly lineCount: number;
  readonly truncated: boolean;
}

/** Builds a context item from a file preview already successfully rendered in the file viewer.
 * Returns `null` (never throws) if the supplied relative path is not shaped like a safe,
 * workspace-relative path — this builder does not itself read the file again. */
export function buildFilePreviewContextItem(input: FilePreviewCandidateInput): TaskContextItem | null {
  if (!isSafeRelativePath(input.relativePath)) return null;
  const path = clampText(input.relativePath, MAX_RELATIVE_PATH_LENGTH).text;
  const excerpt = clampText(input.content, MAX_SINGLE_EXCERPT_CHARS);
  return {
    id: `file:${path}`,
    kind: "file_preview",
    label: path,
    detail: excerpt.text,
    relativePath: path,
    lineRange: input.lineCount > 0 ? `1-${input.lineCount}` : null,
    charCount: excerpt.text.length,
    truncated: input.truncated || excerpt.truncated,
  };
}

export interface SearchResultCandidateInput {
  readonly relativePath: string;
  readonly line: number;
  readonly preview: string;
}

/** Builds a context item from one search result row already rendered on screen. Returns `null`
 * for an unsafe path or non-positive line number — this builder does not itself run a search. */
export function buildSearchResultContextItem(input: SearchResultCandidateInput): TaskContextItem | null {
  if (!isSafeRelativePath(input.relativePath) || !Number.isInteger(input.line) || input.line <= 0) return null;
  const path = clampText(input.relativePath, MAX_RELATIVE_PATH_LENGTH).text;
  const excerpt = clampText(input.preview, MAX_SINGLE_EXCERPT_CHARS);
  return {
    id: `search:${path}:${input.line}`,
    kind: "search_result",
    label: `${path}:${input.line}`,
    detail: excerpt.text,
    relativePath: path,
    lineRange: `line ${input.line}`,
    charCount: excerpt.text.length,
    truncated: excerpt.truncated,
  };
}

export interface GitSummaryCandidateInput {
  readonly branch: string | null;
  readonly detached: boolean;
  readonly trackedChangesAvailable: boolean;
  readonly modifiedCount: number | null;
  readonly deletedCount: number | null;
  readonly untrackedCount: number | null;
}

/** Builds a single, always-singleton (`id: "git_summary"`) context item from the Git summary
 * aggregate already rendered on screen. Never touches `.git` or any filesystem path itself. */
export function buildGitSummaryContextItem(input: GitSummaryCandidateInput): TaskContextItem {
  const branchLabel = input.detached ? "detached HEAD" : input.branch ?? "unknown";
  const parts = [`branch ${branchLabel}`];
  if (input.trackedChangesAvailable) {
    parts.push(`${input.modifiedCount ?? 0} modified`, `${input.deletedCount ?? 0} deleted`);
  }
  parts.push(`${input.untrackedCount ?? 0} untracked`);
  const excerpt = clampText(parts.join(", "), MAX_SINGLE_EXCERPT_CHARS);
  return {
    id: "git_summary",
    kind: "git_summary",
    label: "Git summary",
    detail: excerpt.text,
    relativePath: null,
    lineRange: null,
    charCount: excerpt.text.length,
    truncated: excerpt.truncated,
  };
}

/** Builds a single, always-singleton (`id: "workspace_name"`) context item from the currently
 * granted workspace's own safe display name. Returns `null` for an empty/whitespace name. */
export function buildWorkspaceNameContextItem(displayName: string): TaskContextItem | null {
  const trimmed = displayName.trim();
  if (trimmed.length === 0) return null;
  const excerpt = clampText(trimmed, MAX_SINGLE_EXCERPT_CHARS);
  return {
    id: "workspace_name",
    kind: "workspace_name",
    label: "Workspace name",
    detail: excerpt.text,
    relativePath: null,
    lineRange: null,
    charCount: excerpt.text.length,
    truncated: excerpt.truncated,
  };
}

/** Builds a single, always-singleton (`id: "task_profile"`) context item snapshotting the
 * currently selected task profile. Re-adding after switching profiles replaces the prior
 * snapshot rather than accumulating one entry per profile ever selected. */
export function buildTaskProfileContextItem(profile: TaskProfile): TaskContextItem {
  const meta = getTaskProfileMeta(profile);
  const detail = `Task profile: ${meta.label}`;
  return {
    id: "task_profile",
    kind: "task_profile",
    label: "Task profile",
    detail,
    relativePath: null,
    lineRange: null,
    charCount: detail.length,
    truncated: false,
  };
}

export type ContextAddOutcome = "added" | "merged_duplicate" | "rejected_item_limit" | "rejected_total_char_limit";

export interface ContextAddResult {
  readonly items: readonly TaskContextItem[];
  readonly outcome: ContextAddOutcome;
}

/** The sole way a context item enters the selection — always an explicit, local, in-memory
 * operation over the caller-supplied `existing` array; never invokes IPC, a file read, a
 * search, or a network call. Deduplicates by `id` (deterministic merge — a re-add of the same
 * logical item replaces its predecessor in place rather than appending a second entry) and
 * enforces both the item-count and aggregate-character-count limits declared above. */
export function addContextItem(existing: readonly TaskContextItem[], candidate: TaskContextItem): ContextAddResult {
  const withoutDuplicate = existing.filter((item) => item.id !== candidate.id);
  const isMerge = withoutDuplicate.length !== existing.length;
  if (!isMerge && existing.length >= MAX_CONTEXT_ITEMS) {
    return { items: existing, outcome: "rejected_item_limit" };
  }
  const projectedTotal = withoutDuplicate.reduce((sum, item) => sum + item.charCount, 0) + candidate.charCount;
  if (projectedTotal > MAX_TOTAL_CONTEXT_CHARS) {
    return { items: existing, outcome: "rejected_total_char_limit" };
  }
  return { items: [...withoutDuplicate, candidate], outcome: isMerge ? "merged_duplicate" : "added" };
}

/** Removes exactly one item by id — a local, in-memory array filter, nothing else. */
export function removeContextItem(existing: readonly TaskContextItem[], id: string): readonly TaskContextItem[] {
  return existing.filter((item) => item.id !== id);
}

/** Returns the empty selection — used both for the explicit "Clear all context" action and for
 * the mandatory clear-on-workspace-revoke path in electron/renderer.ts. */
export function clearContextItems(): readonly TaskContextItem[] {
  return [];
}

// ---------------------------------------------------------------------------------------
// Review-before-send surface — a pure projection of the caller's own current state. Building
// this model never sends anything anywhere; see this file's own header.
// ---------------------------------------------------------------------------------------
export const REVIEW_DESTINATION_NOTE = "Not configured for sending.";
export const REVIEW_NETWORK_NOTE = "No request will be sent in this build.";
export const REVIEW_DISCLOSURE_NOTE = "This is a local preview. Nothing is being sent.";
export const REVIEW_EMPTY_CONTEXT_NOTE = "No workspace context selected.";

export interface ReviewModel {
  readonly profileLabel: string;
  readonly draftText: string;
  readonly contextItems: readonly TaskContextItem[];
  readonly destinationNote: string;
  readonly networkNote: string;
  readonly disclosureNote: string;
  readonly emptyContextNote: string;
}

/** Assembles the review model shown in the review surface. Contains only the profile's safe
 * label, the bounded local draft text, and the already-built, already-bounded context items —
 * never a token, endpoint, host/port, session id, provider/model, raw protocol detail, or
 * absolute/parent path (none of those fields exist anywhere in this module's own types, so
 * none can appear here even by omission-of-a-check). */
export function buildReviewModel(profile: TaskProfile, draftText: string, contextItems: readonly TaskContextItem[]): ReviewModel {
  return {
    profileLabel: getTaskProfileMeta(profile).label,
    draftText,
    contextItems,
    destinationNote: REVIEW_DESTINATION_NOTE,
    networkNote: REVIEW_NETWORK_NOTE,
    disclosureNote: REVIEW_DISCLOSURE_NOTE,
    emptyContextNote: REVIEW_EMPTY_CONTEXT_NOTE,
  };
}
