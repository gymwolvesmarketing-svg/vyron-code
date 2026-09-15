/**
 * Typed shared IPC contract — the single source of truth for the shape of
 * `window.vyronDesktop`, imported by electron/main.ts and the test suite.
 * VYRON_CODE_V02_D02B_ELECTRON_HARDENED_SCAFFOLD_AUTHORIZATION, extended by
 * VYRON_CODE_V02_D03_NATIVE_FOLDER_PICKER_AND_WORKSPACE_GRANT_AUTHORIZATION and
 * VYRON_CODE_V02_MILESTONE_A_RUNTIME_STABILITY_AND_READONLY_WORKSPACE_AUTHORIZATION.
 *
 * This file defines TYPES AND NAME CONSTANTS ONLY — no `ipcMain` handler implementation, no
 * generic invoke/send/on surface. `electron/preload.ts` and `electron/renderer.ts` each
 * declare their own local copies of the types/constants they need rather than importing this
 * file at runtime — see their own file-header comments (VYRON_CODE_V02_D03_PRELOAD_IPC_WIRING_FIX_AUTHORIZATION
 * and VYRON_CODE_V02_D03_PRELOAD_BRIDGE_INJECTION_DIAGNOSTIC_AND_FIX_AUTHORIZATION) for why.
 * `electron/main.ts` imports this file normally — it runs unrestricted in the main process,
 * not the sandboxed preload/renderer context that motivated those two fixes.
 */

/** Static, boolean-only security metadata — never a filesystem path, token, or live handle. */
export interface DesktopSecurityState {
  readonly contextIsolation: true;
  readonly nodeIntegration: false;
  readonly sandbox: true;
}

/** What the renderer is allowed to believe is currently available. Milestone A implements
 * `workspacePicker` (D-03), `workspaceRead`, `workspaceSearch`, and `gitSummary` — every other
 * flag remains `false` until its own future, separately authorized phase wires a real
 * main-process handler for it. */
export interface DesktopRuntimeState {
  readonly platform: "desktop";
  readonly capabilities: {
    readonly workspacePicker: true;
    readonly workspaceRead: true;
    readonly workspaceSearch: true;
    readonly gitSummary: true;
    readonly terminal: false;
    readonly fileWrite: false;
    readonly gitWrite: false;
    readonly multimodelStart: false;
    readonly hermesTokenStorage: false;
  };
}

/**
 * Safe, renderer-facing workspace-grant result — VYRON_CODE_V02_D03_NATIVE_FOLDER_PICKER_AND_WORKSPACE_GRANT_AUTHORIZATION.
 * Never carries an absolute/canonical/parent/sibling path, a raw filesystem or native-dialog
 * error, or any environment/token/credential value — only an opaque ID, a display name, and
 * the (always-true, for as long as this scaffold exists) read-only flag.
 */
export type WorkspaceGrantResultState = "no_workspace" | "granted" | "denied" | "cancelled" | "unavailable";

export interface WorkspaceGrantState {
  readonly state: WorkspaceGrantResultState;
  readonly workspaceId: string | null;
  readonly displayName: string | null;
  readonly readOnly: true;
}

/**
 * A single Explorer entry — a bounded directory listing's own row. `relativePath` is always
 * relative to the granted workspace root (forward-slash separated), never absolute.
 * VYRON_CODE_V02_MILESTONE_A_RUNTIME_STABILITY_AND_READONLY_WORKSPACE_AUTHORIZATION.
 */
export interface WorkspaceExplorerEntry {
  readonly name: string;
  readonly relativePath: string;
  readonly type: "dir" | "file";
}

export type ListEntriesResultState = "ok" | "no_workspace" | "invalid_path" | "not_a_directory" | "denied";

export interface ListEntriesResult {
  readonly state: ListEntriesResultState;
  readonly relativePath: string | null;
  readonly entries: readonly WorkspaceExplorerEntry[];
  readonly truncated: boolean;
}

export type ReadTextFileResultState = "ok" | "no_workspace" | "invalid_path" | "not_a_file" | "binary" | "too_large" | "unreadable" | "denied";

export interface ReadTextFileResult {
  readonly state: ReadTextFileResultState;
  readonly relativePath: string | null;
  readonly content: string | null;
  readonly lineCount: number | null;
  readonly truncated: boolean;
}

export interface WorkspaceSearchMatch {
  readonly relativePath: string;
  readonly line: number;
  readonly preview: string;
}

export type SearchTextResultState = "ok" | "no_workspace" | "invalid_query";

export interface SearchTextResult {
  readonly state: SearchTextResultState;
  readonly query: string | null;
  readonly matches: readonly WorkspaceSearchMatch[];
  readonly truncated: boolean;
}

/**
 * Bounded, filesystem-only Git summary — never invokes the `git` CLI, a shell, or
 * `child_process` (see electron/workspaceGit.ts). Computed safely and cheaply from
 * `.git/HEAD` and `.git/index` alone: the current branch, and modified/deleted/untracked
 * counts. `modified` uses git's own standard fast-path heuristic (index-recorded mtime+size
 * vs. the file's current mtime+size) rather than re-hashing file content — a real, disclosed,
 * bounded-cost tradeoff, not a full `git status`. Staged-but-uncommitted ("added") and
 * rename-detected counts are NOT computed (would require decompressing git tree/blob objects,
 * meaningfully more parsing surface for a read-only convenience count) —
 * `trackedChangesAvailable` is `false` only when even the cheap modified/deleted counts
 * could not be derived safely (e.g. an unsupported index version), making that specific
 * limitation explicit to the renderer rather than silently implying "zero changes".
 */
export type GitSummaryResultState = "ok" | "no_workspace" | "not_a_repository" | "unavailable";

export interface GitSummaryResult {
  readonly state: GitSummaryResultState;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly trackedChangesAvailable: boolean;
  readonly modifiedCount: number | null;
  readonly deletedCount: number | null;
  readonly untrackedCount: number | null;
  readonly truncated: boolean;
}

/**
 * Milestone A's full workspace bridge. Each method is explicit and purpose-specific — no
 * generic channel-invoking capability. `listEntries`/`readTextFile` take a caller-supplied
 * relative path; `searchText` takes a caller-supplied query string; every one of these is
 * revalidated against the granted canonical root on every call in the main process (see
 * electron/workspaceExplorer.ts, electron/workspaceFileViewer.ts, electron/workspaceSearch.ts,
 * electron/workspaceGit.ts) — the preload/renderer layer never decides what is or isn't
 * accessible, it only forwards the caller's own relative-path/query string.
 */
export interface DesktopWorkspaceApi {
  pickDirectory(): Promise<WorkspaceGrantState>;
  getCurrent(): Promise<WorkspaceGrantState>;
  clearCurrent(): Promise<WorkspaceGrantState>;
  listEntries(relativePath: string): Promise<ListEntriesResult>;
  readTextFile(relativePath: string): Promise<ReadTextFileResult>;
  searchText(query: string): Promise<SearchTextResult>;
  getGitSummary(): Promise<GitSummaryResult>;
}

/** The full shape of `window.vyronDesktop`, as exposed by electron/preload.ts. */
export interface DesktopApi {
  readonly platform: DesktopRuntimeState["platform"];
  readonly capabilities: DesktopRuntimeState["capabilities"];
  readonly security: DesktopSecurityState;
  readonly workspace: DesktopWorkspaceApi;
}

/**
 * Implemented IPC channels — wired to real `ipcMain.handle` handlers in electron/main.ts
 * (delegating to electron/workspace-grant.ts, electron/workspaceExplorer.ts,
 * electron/workspaceFileViewer.ts, electron/workspaceSearch.ts, electron/workspaceGit.ts) and
 * exposed through the preload bridge as the `workspace.*` methods above. Nothing else in this
 * codebase calls `ipcMain.handle`/`ipcRenderer.invoke` for any other channel.
 */
export const WORKSPACE_IPC_CHANNELS = {
  WORKSPACE_PICK_DIRECTORY: "workspace:pickDirectory",
  WORKSPACE_GET_CURRENT: "workspace:getCurrent",
  WORKSPACE_CLEAR_CURRENT: "workspace:clearCurrent",
  WORKSPACE_LIST: "workspace:list",
  WORKSPACE_READ_TEXT: "workspace:readText",
  WORKSPACE_SEARCH: "workspace:search",
  WORKSPACE_GIT_SUMMARY: "workspace:gitSummary",
} as const;

export type WorkspaceIpcChannel = (typeof WORKSPACE_IPC_CHANNELS)[keyof typeof WORKSPACE_IPC_CHANNELS];

/**
 * Future, still-unimplemented IPC channel name placeholder — declared so a later phase
 * references this one shared name rather than an ad hoc string. No `ipcMain.handle`/
 * `ipcRenderer.invoke` call exists anywhere in this codebase for it yet.
 * `WORKSPACE_CLEAR_RECENT` is reserved for a future D-07 "recent workspaces" persistence
 * feature — it is a DIFFERENT concept from `WORKSPACE_CLEAR_CURRENT` above (implemented,
 * process-memory-only) and must never be conflated with or substituted for it.
 */
export const FUTURE_IPC_CHANNELS = {
  WORKSPACE_CLEAR_RECENT: "workspace:clearRecent",
} as const;

export type FutureIpcChannel = (typeof FUTURE_IPC_CHANNELS)[keyof typeof FUTURE_IPC_CHANNELS];
