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
 * Direct task submission state (D-11 transport) — VYRON_CODE_COMPLETE_LOCAL_HERMES_D11_DELIVERY_AUTHORIZATION.
 * Never carries an endpoint, API key, raw HTTP status/headers/body, session id, or any
 * protocol detail — only this safe state enum plus the three bounded, already-safe fields
 * below. `text` is populated only in the `"completed"` state, and is always the already-
 * bounded, plain-text-only assistant response — never HTML, never a structured/tool-call
 * payload (see electron/hermesTaskSubmission.ts's own header for the full evidence trail).
 */
export type HermesTaskSubmissionAmbientState =
  | "idle"
  | "sending"
  | "completed"
  | "unavailable"
  | "unauthorized"
  | "safe_failure"
  | "cancelled";

export interface HermesTaskSubmissionState {
  readonly state: HermesTaskSubmissionAmbientState;
  readonly text: string | null;
  readonly truncated: boolean;
}

/**
 * The one and only shape `sendTask` accepts — exactly one field, `draft`, a string.
 * Mirrors `HermesAuthorizationRequest`/`HermesEndpointConfigurationRequest`'s own single-field
 * discipline exactly. This is the one narrow, schema-validated crossing point for the user's
 * own task text — never combined with workspace/file/search/Git/context data at this or any
 * later step.
 */
export interface HermesTaskRequest {
  readonly draft: string;
  /** Optional fixed Manager role (validated by the main process); absent = direct local AI task. */
  readonly agent?: string;
}

/**
 * One-click local AI lifecycle state - VYRON_CODE_ONE_CLICK_LOCAL_AI_STARTUP_AND_UX_DELIVERY.
 * The main process alone owns starting, verifying and stopping the local Hermes gateway and the
 * local auth proxy (see electron/localAiLifecycle.ts). The renderer only ever receives this safe,
 * fixed-vocabulary state: no endpoint, port, path, command line, credential, process id, raw log,
 * health payload, toolset body, HTTP status or provider error ever crosses this boundary.
 */
export type LocalAiStage = "checking" | "gateway" | "proxy" | "verifying";

export type SafeLocalAiFailureCategory =
  | "hermes_start_failed"
  | "secure_connection_unverified"
  | "model_unresponsive"
  | "unavailable";

export type LocalAiState =
  | { readonly state: "starting"; readonly stage: LocalAiStage }
  | { readonly state: "ready" }
  | { readonly state: "unavailable"; readonly category: SafeLocalAiFailureCategory };

/** Result of the sanitized-diagnostics copy action. The text itself never reaches the renderer. */
export interface SafeCopyResult {
  readonly copied: boolean;
}

/**
 * The full local-AI bridge - exactly three methods, none of which accepts any argument. There is
 * no command, path, environment, URL, host or port parameter anywhere in this bridge.
 */
export interface DesktopLocalAiApi {
  getLocalAiState(): Promise<LocalAiState>;
  retryLocalAiStartup(): Promise<LocalAiState>;
  copyLocalAiDiagnostics(): Promise<SafeCopyResult>;
}

/**
 * The direct-task bridge - exactly three methods. `getTaskSubmissionState` and
 * `clearTaskSubmission` take no arguments at all; `sendTask` takes exactly one `draft` string field
 * and sends it immediately (there is no review or approval step). Authorization and endpoint are set only by the main-process
 * lifecycle manager after every readiness check passes; the renderer can neither set nor read
 * either of them.
 */
export interface DesktopHermesApi {
  getTaskSubmissionState(): Promise<HermesTaskSubmissionState>;
  sendTask(request: HermesTaskRequest): Promise<HermesTaskSubmissionState>;
  clearTaskSubmission(): Promise<HermesTaskSubmissionState>;
}

/**
 * The window bridge - exactly one method, no arguments: toggles the developer tools of the app's own
 * window (the "Geliştirici Araçları" entry of the workspace menu). Reload is done by the page itself.
 */
export interface DesktopAppApi {
  toggleDevTools(): Promise<void>;
}

/** The full shape of `window.vyronDesktop`, as exposed by electron/preload.ts. */
export interface DesktopApi {
  readonly localAi: DesktopLocalAiApi;
  readonly hermes: DesktopHermesApi;
  readonly app: DesktopAppApi;
}

/** Local AI lifecycle IPC channels - wired to real `ipcMain.handle` handlers in electron/main.ts. */
export const LOCAL_AI_IPC_CHANNELS = {
  LOCAL_AI_GET_STATE: "localAi:getState",
  LOCAL_AI_RETRY: "localAi:retry",
  LOCAL_AI_COPY_DIAGNOSTICS: "localAi:copyDiagnostics",
} as const;

export type LocalAiIpcChannel = (typeof LOCAL_AI_IPC_CHANNELS)[keyof typeof LOCAL_AI_IPC_CHANNELS];

/**
 * Direct-task IPC channels. A distinct channel-name family from the local AI lifecycle
 * channels above; both are the only `ipcMain.handle`/`ipcRenderer.invoke` channels in this codebase.
 */
export const HERMES_IPC_CHANNELS = {
  HERMES_GET_TASK_SUBMISSION_STATE: "hermes:getTaskSubmissionState",
  HERMES_SEND_TASK: "hermes:sendTask",
  HERMES_CLEAR_TASK_SUBMISSION: "hermes:clearTaskSubmission",
} as const;

/** The single window-bridge channel (no arguments, no return value). */
export const APP_IPC_CHANNELS = {
  APP_TOGGLE_DEV_TOOLS: "app:toggleDevTools",
} as const;

export type HermesIpcChannel = (typeof HERMES_IPC_CHANNELS)[keyof typeof HERMES_IPC_CHANNELS];
