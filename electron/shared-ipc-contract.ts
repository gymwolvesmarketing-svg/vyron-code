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
 * Hermes authorization boundary types — VYRON_CODE_V02_D08B_MEMORY_ONLY_HERMES_AUTHORIZATION_BOUNDARY_AUTHORIZATION.
 * These types carry no Hermes endpoint, host, port, session, protocol, or transport
 * information of any kind — only authorization state and, in `HermesAuthorizationRequest`
 * alone, the single credential value the user explicitly submits. See
 * electron/hermesAuthorization.ts for the main-process-only service that owns the credential
 * itself (never exported by any type or function here).
 */

/** Static, build-time-only capability state — never the result of a network probe or a
 * credential-store/environment inspection. See getAvailability()'s own doc comment. */
export type HermesAvailabilityState = "available" | "unavailable" | "not_configured";

export interface HermesAvailability {
  readonly state: HermesAvailabilityState;
}

/** The current ambient authorization state — never includes the credential, its length, or
 * any derived value. */
export type HermesAuthorizationAmbientState = "not_authorized" | "authorized_memory_only";

export interface HermesAuthorizationState {
  readonly state: HermesAuthorizationAmbientState;
}

/**
 * The one and only shape `beginAuthorization` accepts — exactly one field, `credential`, a
 * string. electron/hermesAuthorization.ts's `validateAuthorizationRequest` rejects any request
 * with a different shape (extra fields, wrong type, empty/whitespace-only, or oversized) before
 * retaining anything. This type intentionally has no endpoint/host/port/session/path field —
 * none is ever accepted from the renderer for this or any future Hermes IPC method in this
 * phase (T-14).
 */
export interface HermesAuthorizationRequest {
  readonly credential: string;
}

/** The safe outcome of a `beginAuthorization` or `clearAuthorization` call — never the
 * credential, never a raw error, never a length/hash/fingerprint derived from the credential. */
export type HermesAuthorizationOutcomeState = "authorized_memory_only" | "revoked" | "not_authorized" | "safe_failure" | "unavailable";

export interface HermesAuthorizationResult {
  readonly state: HermesAuthorizationOutcomeState;
}

/**
 * D-08B's full Hermes authorization bridge — `beginAuthorization` is the sole one-way
 * credential-submission boundary; `getAvailability`/`getAuthorizationState` are parameter-free
 * reads; `clearAuthorization` is the sole revocation action. Reused unchanged for the D-10
 * remediation's `API_SERVER_KEY` credential (see electron/hermesAuthorization.ts's own header).
 */
/**
 * D-08E endpoint configuration state — VYRON_CODE_V02_D08E_MEMORY_ONLY_HERMES_ENDPOINT_SETUP_AUTHORIZATION,
 * re-scoped by VYRON_CODE_V02_D10_API_SERVER_REMEDIATION_AUTHORIZATION from the Hermes
 * dashboard's WebSocket surface onto the officially documented Hermes API Server. The
 * user-configured endpoint (Option B from the D-08D decision record) lives only in Electron
 * main-process memory, validated through the existing, unchanged (now HTTP-scoped)
 * `validateEndpointCandidate` policy engine. Never carries a resolved URL/host/port/protocol
 * value to the renderer — only this safe state enum.
 */
export type HermesEndpointAmbientState = "not_configured" | "configured_memory_only";

export interface HermesEndpointState {
  readonly state: HermesEndpointAmbientState;
}

/**
 * The one and only shape `configureEndpoint` accepts — exactly one field, `endpoint`, a
 * string. No credential, header, proxy, certificate, session, prompt, or workspace field is
 * ever accepted here, mirroring `HermesAuthorizationRequest`'s own single-field discipline
 * exactly.
 */
export interface HermesEndpointConfigurationRequest {
  readonly endpoint: string;
}

/** The safe outcome of a `configureEndpoint` or `clearEndpointConfiguration` call — never the
 * raw endpoint, never a URL component, never an input echo. */
export type HermesEndpointConfigurationOutcomeState =
  | "configured_memory_only"
  | "cleared"
  | "not_configured"
  | "policy_rejected"
  | "invalid_configuration"
  | "unavailable"
  | "safe_failure";

export interface HermesEndpointConfigurationResult {
  readonly state: HermesEndpointConfigurationOutcomeState;
}

/**
 * D-10 (remediated) Hermes API Server connection-verification state —
 * VYRON_CODE_V02_D10_API_SERVER_REMEDIATION_AUTHORIZATION. Never carries an endpoint, API key,
 * raw HTTP status/headers/body, or any protocol detail — only this safe state enum. See
 * electron/hermesApiServer.ts's own header for the full evidence trail behind exactly what
 * `verifyApiServerConnection()` sends (one `GET /health` request, no more) and why no
 * `Authorization` header is attached to it.
 */
export type HermesApiServerAmbientState =
  | "not_authorized"
  | "endpoint_not_configured"
  | "ready_to_verify"
  | "verifying"
  | "reachable"
  | "unavailable"
  | "safe_failure";

export interface HermesApiServerState {
  readonly state: HermesApiServerAmbientState;
}

export interface HermesApiServerResult {
  readonly state: HermesApiServerAmbientState;
}

/**
 * D-11 explicit reviewed task submission state — VYRON_CODE_COMPLETE_LOCAL_HERMES_D11_DELIVERY_AUTHORIZATION.
 * Never carries an endpoint, API key, raw HTTP status/headers/body, session id, or any
 * protocol detail — only this safe state enum plus the three bounded, already-safe fields
 * below. `text` is populated only in the `"completed"` state, and is always the already-
 * bounded, plain-text-only assistant response — never HTML, never a structured/tool-call
 * payload (see electron/hermesTaskSubmission.ts's own header for the full evidence trail).
 */
export type HermesTaskSubmissionAmbientState =
  | "idle"
  | "review_ready"
  | "sending"
  | "completed"
  | "unavailable"
  | "unauthorized"
  | "safe_failure"
  | "cancelled";

export interface HermesTaskSubmissionState {
  readonly state: HermesTaskSubmissionAmbientState;
  readonly draftLength: number | null;
  readonly text: string | null;
  readonly truncated: boolean;
}

/**
 * The one and only shape `reviewTaskDraft` accepts — exactly one field, `draft`, a string.
 * Mirrors `HermesAuthorizationRequest`/`HermesEndpointConfigurationRequest`'s own single-field
 * discipline exactly. This is the one narrow, schema-validated crossing point for the user's
 * own task text — never combined with workspace/file/search/Git/context data at this or any
 * later step.
 */
export interface HermesTaskDraftReviewRequest {
  readonly draft: string;
}

/**
 * D-08B + D-08E + D-10 (remediated) + D-11's full Hermes bridge — exactly fourteen methods.
 * `clearAuthorization`/`clearEndpointConfiguration`/`getApiServerVerificationState`/
 * `verifyApiServerConnection`/`clearApiServerVerification`/`getTaskSubmissionState`/
 * `sendReviewedTask`/`clearTaskSubmission` take no arguments at all; `configureEndpoint` takes
 * exactly one `endpoint` string field; `reviewTaskDraft` takes exactly one `draft` string field.
 * No endpoint/host/port/credential/prompt/session ID/workspace/context data or options object
 * of any kind is ever accepted from or returned to the renderer. No WebSocket/`ws://`/`wss://`/
 * `/api/ws`/query-string-token/JSON-RPC/session concept exists anywhere in this bridge.
 */
export interface DesktopHermesApi {
  getAvailability(): Promise<HermesAvailability>;
  getAuthorizationState(): Promise<HermesAuthorizationState>;
  beginAuthorization(request: HermesAuthorizationRequest): Promise<HermesAuthorizationResult>;
  clearAuthorization(): Promise<HermesAuthorizationResult>;
  getEndpointConfigurationState(): Promise<HermesEndpointState>;
  configureEndpoint(request: HermesEndpointConfigurationRequest): Promise<HermesEndpointConfigurationResult>;
  clearEndpointConfiguration(): Promise<HermesEndpointConfigurationResult>;
  getApiServerVerificationState(): Promise<HermesApiServerState>;
  verifyApiServerConnection(): Promise<HermesApiServerResult>;
  clearApiServerVerification(): Promise<HermesApiServerResult>;
  getTaskSubmissionState(): Promise<HermesTaskSubmissionState>;
  reviewTaskDraft(request: HermesTaskDraftReviewRequest): Promise<HermesTaskSubmissionState>;
  sendReviewedTask(): Promise<HermesTaskSubmissionState>;
  clearTaskSubmission(): Promise<HermesTaskSubmissionState>;
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
  readonly hermes: DesktopHermesApi;
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
 * Implemented Hermes authorization IPC channels — VYRON_CODE_V02_D08B_MEMORY_ONLY_HERMES_AUTHORIZATION_BOUNDARY_AUTHORIZATION.
 * Wired to real `ipcMain.handle` handlers in electron/main.ts, delegating to
 * electron/hermesAuthorization.ts, and exposed through the preload bridge as the `hermes.*`
 * methods above. A distinct channel-name family from `WORKSPACE_IPC_CHANNELS` — kept separate
 * because they own an entirely independent piece of process-memory state (see
 * electron/hermesAuthorization.ts's own "independent-lifetime policy" note).
 */
export const HERMES_IPC_CHANNELS = {
  HERMES_GET_AVAILABILITY: "hermes:getAvailability",
  HERMES_GET_AUTHORIZATION_STATE: "hermes:getAuthorizationState",
  HERMES_BEGIN_AUTHORIZATION: "hermes:beginAuthorization",
  HERMES_CLEAR_AUTHORIZATION: "hermes:clearAuthorization",
  HERMES_GET_ENDPOINT_CONFIGURATION_STATE: "hermes:getEndpointConfigurationState",
  HERMES_CONFIGURE_ENDPOINT: "hermes:configureEndpoint",
  HERMES_CLEAR_ENDPOINT_CONFIGURATION: "hermes:clearEndpointConfiguration",
  HERMES_GET_API_SERVER_VERIFICATION_STATE: "hermes:getApiServerVerificationState",
  HERMES_VERIFY_API_SERVER_CONNECTION: "hermes:verifyApiServerConnection",
  HERMES_CLEAR_API_SERVER_VERIFICATION: "hermes:clearApiServerVerification",
  HERMES_GET_TASK_SUBMISSION_STATE: "hermes:getTaskSubmissionState",
  HERMES_REVIEW_TASK_DRAFT: "hermes:reviewTaskDraft",
  HERMES_SEND_REVIEWED_TASK: "hermes:sendReviewedTask",
  HERMES_CLEAR_TASK_SUBMISSION: "hermes:clearTaskSubmission",
} as const;

export type HermesIpcChannel = (typeof HERMES_IPC_CHANNELS)[keyof typeof HERMES_IPC_CHANNELS];

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
