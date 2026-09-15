/**
 * Electron preload script — the sole main↔renderer bridge. Runs in an isolated preload
 * context with Node access itself, but the renderer it serves must never receive any of
 * that access directly. VYRON_CODE_V02_D02B_ELECTRON_HARDENED_SCAFFOLD_AUTHORIZATION,
 * extended by VYRON_CODE_V02_D03_NATIVE_FOLDER_PICKER_AND_WORKSPACE_GRANT_AUTHORIZATION,
 * VYRON_CODE_V02_D03_PRELOAD_BRIDGE_INJECTION_DIAGNOSTIC_AND_FIX_AUTHORIZATION, and
 * VYRON_CODE_V02_MILESTONE_A_RUNTIME_STABILITY_AND_READONLY_WORKSPACE_AUTHORIZATION.
 *
 * Exposes only static capability/security metadata plus the `workspace.*` methods, all via
 * `contextBridge`. `ipcRenderer` itself is never exposed on `window` — only these fixed,
 * single-hardcoded-channel wrapper closures are; each forwards at most one caller-supplied
 * string argument (a relative path or a search query) and nothing else. No generic
 * invoke/send/on surface, no EventEmitter, no filesystem/terminal/Git-write/token capability
 * of any kind.
 *
 * This file imports only from Electron's own built-in module — never a relative local file
 * (see VYRON_CODE_V02_D03_PRELOAD_BRIDGE_INJECTION_FIX_REPORT.md for why: a sandboxed preload
 * script runs in a more restricted environment than a normal Node/Electron main-process
 * module, and a local relative `require()` was the one remaining structural anomaly found
 * when `window.vyronDesktop` was observed missing at renderer startup). The channel-name
 * strings and types below are duplicated locally rather than imported from
 * `shared-ipc-contract.ts` for that same reason — that file remains their canonical source,
 * still imported normally by `electron/main.ts` and the test suite; keep the two in sync by
 * hand if the contract changes (a regression test cross-checks the actual invoked channel
 * strings against that canonical source — see tests/electronSecurityScaffold.test.ts).
 */
import { contextBridge, ipcRenderer } from "electron";

type WorkspaceGrantResultState = "no_workspace" | "granted" | "denied" | "cancelled" | "unavailable";

interface WorkspaceGrantState {
  readonly state: WorkspaceGrantResultState;
  readonly workspaceId: string | null;
  readonly displayName: string | null;
  readonly readOnly: true;
}

type ListEntriesResultState = "ok" | "no_workspace" | "invalid_path" | "not_a_directory" | "denied";

interface WorkspaceExplorerEntry {
  readonly name: string;
  readonly relativePath: string;
  readonly type: "dir" | "file";
}

interface ListEntriesResult {
  readonly state: ListEntriesResultState;
  readonly relativePath: string | null;
  readonly entries: readonly WorkspaceExplorerEntry[];
  readonly truncated: boolean;
}

type ReadTextFileResultState = "ok" | "no_workspace" | "invalid_path" | "not_a_file" | "binary" | "too_large" | "unreadable" | "denied";

interface ReadTextFileResult {
  readonly state: ReadTextFileResultState;
  readonly relativePath: string | null;
  readonly content: string | null;
  readonly lineCount: number | null;
  readonly truncated: boolean;
}

interface WorkspaceSearchMatch {
  readonly relativePath: string;
  readonly line: number;
  readonly preview: string;
}

type SearchTextResultState = "ok" | "no_workspace" | "invalid_query";

interface SearchTextResult {
  readonly state: SearchTextResultState;
  readonly query: string | null;
  readonly matches: readonly WorkspaceSearchMatch[];
  readonly truncated: boolean;
}

type GitSummaryResultState = "ok" | "no_workspace" | "not_a_repository" | "unavailable";

interface GitSummaryResult {
  readonly state: GitSummaryResultState;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly trackedChangesAvailable: boolean;
  readonly modifiedCount: number | null;
  readonly deletedCount: number | null;
  readonly untrackedCount: number | null;
  readonly truncated: boolean;
}

interface DesktopWorkspaceApi {
  pickDirectory(): Promise<WorkspaceGrantState>;
  getCurrent(): Promise<WorkspaceGrantState>;
  clearCurrent(): Promise<WorkspaceGrantState>;
  listEntries(relativePath: string): Promise<ListEntriesResult>;
  readTextFile(relativePath: string): Promise<ReadTextFileResult>;
  searchText(query: string): Promise<SearchTextResult>;
  getGitSummary(): Promise<GitSummaryResult>;
}

// VYRON_CODE_V02_D08B_MEMORY_ONLY_HERMES_AUTHORIZATION_BOUNDARY_AUTHORIZATION — duplicated
// locally for the same reason every other type here is (see file-header comment). Carries no
// endpoint/host/port/session/protocol field anywhere; the credential itself is never part of
// any of these types' own shape except as the one write-only field of the request below.
type HermesAvailabilityState = "available" | "unavailable" | "not_configured";

interface HermesAvailability {
  readonly state: HermesAvailabilityState;
}

type HermesAuthorizationAmbientState = "not_authorized" | "authorized_memory_only";

interface HermesAuthorizationState {
  readonly state: HermesAuthorizationAmbientState;
}

interface HermesAuthorizationRequest {
  readonly credential: string;
}

type HermesAuthorizationOutcomeState = "authorized_memory_only" | "revoked" | "not_authorized" | "safe_failure" | "unavailable";

interface HermesAuthorizationResult {
  readonly state: HermesAuthorizationOutcomeState;
}

interface DesktopHermesApi {
  getAvailability(): Promise<HermesAvailability>;
  getAuthorizationState(): Promise<HermesAuthorizationState>;
  beginAuthorization(request: HermesAuthorizationRequest): Promise<HermesAuthorizationResult>;
  clearAuthorization(): Promise<HermesAuthorizationResult>;
}

interface DesktopApi {
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
  readonly security: {
    readonly contextIsolation: true;
    readonly nodeIntegration: false;
    readonly sandbox: true;
  };
  readonly workspace: DesktopWorkspaceApi;
  readonly hermes: DesktopHermesApi;
}

// Duplicated from shared-ipc-contract.ts's WORKSPACE_IPC_CHANNELS — see the file-header note
// above for why this file never imports that module at runtime.
const WORKSPACE_PICK_DIRECTORY_CHANNEL = "workspace:pickDirectory";
const WORKSPACE_GET_CURRENT_CHANNEL = "workspace:getCurrent";
const WORKSPACE_CLEAR_CURRENT_CHANNEL = "workspace:clearCurrent";
const WORKSPACE_LIST_CHANNEL = "workspace:list";
const WORKSPACE_READ_TEXT_CHANNEL = "workspace:readText";
const WORKSPACE_SEARCH_CHANNEL = "workspace:search";
const WORKSPACE_GIT_SUMMARY_CHANNEL = "workspace:gitSummary";

// Duplicated from shared-ipc-contract.ts's HERMES_IPC_CHANNELS — same reason as above.
const HERMES_GET_AVAILABILITY_CHANNEL = "hermes:getAvailability";
const HERMES_GET_AUTHORIZATION_STATE_CHANNEL = "hermes:getAuthorizationState";
const HERMES_BEGIN_AUTHORIZATION_CHANNEL = "hermes:beginAuthorization";
const HERMES_CLEAR_AUTHORIZATION_CHANNEL = "hermes:clearAuthorization";

const vyronDesktop: DesktopApi = {
  platform: "desktop",
  capabilities: {
    workspacePicker: true,
    workspaceRead: true,
    workspaceSearch: true,
    gitSummary: true,
    terminal: false,
    fileWrite: false,
    gitWrite: false,
    multimodelStart: false,
    hermesTokenStorage: false,
  },
  security: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  },
  workspace: {
    pickDirectory: () => ipcRenderer.invoke(WORKSPACE_PICK_DIRECTORY_CHANNEL),
    getCurrent: () => ipcRenderer.invoke(WORKSPACE_GET_CURRENT_CHANNEL),
    clearCurrent: () => ipcRenderer.invoke(WORKSPACE_CLEAR_CURRENT_CHANNEL),
    listEntries: (relativePath: string) => ipcRenderer.invoke(WORKSPACE_LIST_CHANNEL, relativePath),
    readTextFile: (relativePath: string) => ipcRenderer.invoke(WORKSPACE_READ_TEXT_CHANNEL, relativePath),
    searchText: (query: string) => ipcRenderer.invoke(WORKSPACE_SEARCH_CHANNEL, query),
    getGitSummary: () => ipcRenderer.invoke(WORKSPACE_GIT_SUMMARY_CHANNEL),
  },
  // Each method forwards at most one caller-supplied plain object (the credential-submission
  // request) and nothing else — same one-argument-only discipline as the workspace methods
  // above. `beginAuthorization`'s request is forwarded verbatim, unexamined; this file never
  // reads, logs, or otherwise touches the credential value itself.
  hermes: {
    getAvailability: () => ipcRenderer.invoke(HERMES_GET_AVAILABILITY_CHANNEL),
    getAuthorizationState: () => ipcRenderer.invoke(HERMES_GET_AUTHORIZATION_STATE_CHANNEL),
    beginAuthorization: (request: HermesAuthorizationRequest) => ipcRenderer.invoke(HERMES_BEGIN_AUTHORIZATION_CHANNEL, request),
    clearAuthorization: () => ipcRenderer.invoke(HERMES_CLEAR_AUTHORIZATION_CHANNEL),
  },
};

contextBridge.exposeInMainWorld("vyronDesktop", vyronDesktop);
