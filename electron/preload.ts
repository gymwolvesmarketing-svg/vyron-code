/**
 * Electron preload script - the sole main<->renderer bridge. Runs in an isolated preload context
 * with Node access itself, but the renderer it serves must never receive any of that access.
 * VYRON_CODE_V02_D02B_ELECTRON_HARDENED_SCAFFOLD_AUTHORIZATION, reduced to its final narrow shape by
 * VYRON_CODE_ONE_CLICK_LOCAL_AI_STARTUP_AND_UX_DELIVERY.
 *
 * Exposes exactly two namespaces on `window.vyronDesktop`, via `contextBridge` only:
 * - `localAi`: three parameter-free methods (state, explicit retry, sanitized diagnostics copy);
 * - `hermes`: the three direct-task methods; only `sendTask` takes an argument, a single
 *   `{ draft }` object, and it sends immediately (no review step).
 * `ipcRenderer` itself is never exposed on `window` - only these fixed, single-hardcoded-channel
 * wrapper closures are. There is no generic invoke/send/on surface, no EventEmitter, and no
 * command, path, environment, URL, host, port, credential or endpoint parameter anywhere.
 *
 * This file imports only from Electron's own built-in module - never a relative local file (a
 * sandboxed preload runs in a more restricted environment; see
 * VYRON_CODE_V02_D03_PRELOAD_BRIDGE_INJECTION_FIX_REPORT.md). The channel-name strings and types
 * below are duplicated locally for that reason; `shared-ipc-contract.ts` remains their canonical
 * source, and a regression test cross-checks the two.
 */
import { contextBridge, ipcRenderer } from "electron";

type LocalAiStage = "checking" | "gateway" | "proxy" | "verifying";
type SafeLocalAiFailureCategory = "hermes_start_failed" | "secure_connection_unverified" | "model_unresponsive" | "unavailable";
type LocalAiState =
  | { readonly state: "starting"; readonly stage: LocalAiStage }
  | { readonly state: "ready" }
  | { readonly state: "unavailable"; readonly category: SafeLocalAiFailureCategory };

interface SafeCopyResult {
  readonly copied: boolean;
}

type HermesTaskSubmissionAmbientState =
  | "idle"
  | "review_ready"
  | "sending"
  | "completed"
  | "unavailable"
  | "unauthorized"
  | "safe_failure"
  | "cancelled";

interface HermesTaskSubmissionState {
  readonly state: HermesTaskSubmissionAmbientState;
  readonly text: string | null;
  readonly truncated: boolean;
}

interface HermesTaskRequest {
  readonly draft: string;
  readonly agent?: string;
  readonly project?: string;
  readonly tools?: boolean;
  readonly models?: { readonly assistant?: string; readonly code?: string; readonly research?: string };
}

interface DesktopLocalAiApi {
  getLocalAiState(): Promise<LocalAiState>;
  retryLocalAiStartup(): Promise<LocalAiState>;
  copyLocalAiDiagnostics(): Promise<SafeCopyResult>;
}

interface DesktopHermesApi {
  getTaskSubmissionState(): Promise<HermesTaskSubmissionState>;
  sendTask(request: HermesTaskRequest): Promise<HermesTaskSubmissionState>;
  clearTaskSubmission(): Promise<HermesTaskSubmissionState>;
}

interface DesktopAppApi {
  toggleDevTools(): Promise<void>;
  clearAgentMemory(): Promise<boolean>;
}

interface ToolWorkspaceInfo {
  readonly folderName: string | null;
  readonly alwaysCount: number;
}

interface DesktopToolsApi {
  getWorkspace(projectId?: string): Promise<ToolWorkspaceInfo>;
  pickWorkspace(projectId?: string): Promise<ToolWorkspaceInfo>;
  clearWorkspace(projectId?: string): Promise<ToolWorkspaceInfo>;
  clearPermissions(): Promise<ToolWorkspaceInfo>;
}

interface DesktopApi {
  readonly localAi: DesktopLocalAiApi;
  readonly hermes: DesktopHermesApi;
  readonly app: DesktopAppApi;
  readonly tools: DesktopToolsApi;
}

const LOCAL_AI_GET_STATE_CHANNEL = "localAi:getState";
const LOCAL_AI_RETRY_CHANNEL = "localAi:retry";
const LOCAL_AI_COPY_DIAGNOSTICS_CHANNEL = "localAi:copyDiagnostics";
const HERMES_GET_TASK_SUBMISSION_STATE_CHANNEL = "hermes:getTaskSubmissionState";
const HERMES_SEND_TASK_CHANNEL = "hermes:sendTask";
const HERMES_CLEAR_TASK_SUBMISSION_CHANNEL = "hermes:clearTaskSubmission";
const APP_TOGGLE_DEV_TOOLS_CHANNEL = "app:toggleDevTools";
const APP_CLEAR_AGENT_MEMORY_CHANNEL = "app:clearAgentMemory";
const TOOLS_GET_WORKSPACE_CHANNEL = "tools:getWorkspace";
const TOOLS_PICK_WORKSPACE_CHANNEL = "tools:pickWorkspace";
const TOOLS_CLEAR_WORKSPACE_CHANNEL = "tools:clearWorkspace";
const TOOLS_CLEAR_PERMISSIONS_CHANNEL = "tools:clearPermissions";

const vyronDesktop: DesktopApi = {
  localAi: {
    getLocalAiState: () => ipcRenderer.invoke(LOCAL_AI_GET_STATE_CHANNEL),
    retryLocalAiStartup: () => ipcRenderer.invoke(LOCAL_AI_RETRY_CHANNEL),
    copyLocalAiDiagnostics: () => ipcRenderer.invoke(LOCAL_AI_COPY_DIAGNOSTICS_CHANNEL),
  },
  hermes: {
    getTaskSubmissionState: () => ipcRenderer.invoke(HERMES_GET_TASK_SUBMISSION_STATE_CHANNEL),
    sendTask: (request) => ipcRenderer.invoke(HERMES_SEND_TASK_CHANNEL, request),
    clearTaskSubmission: () => ipcRenderer.invoke(HERMES_CLEAR_TASK_SUBMISSION_CHANNEL),
  },
  app: {
    toggleDevTools: () => ipcRenderer.invoke(APP_TOGGLE_DEV_TOOLS_CHANNEL),
    clearAgentMemory: () => ipcRenderer.invoke(APP_CLEAR_AGENT_MEMORY_CHANNEL),
  },
  tools: {
    getWorkspace: (projectId) => ipcRenderer.invoke(TOOLS_GET_WORKSPACE_CHANNEL, typeof projectId === "string" ? projectId : undefined),
    pickWorkspace: (projectId) => ipcRenderer.invoke(TOOLS_PICK_WORKSPACE_CHANNEL, typeof projectId === "string" ? projectId : undefined),
    clearWorkspace: (projectId) => ipcRenderer.invoke(TOOLS_CLEAR_WORKSPACE_CHANNEL, typeof projectId === "string" ? projectId : undefined),
    clearPermissions: () => ipcRenderer.invoke(TOOLS_CLEAR_PERMISSIONS_CHANNEL),
  },
};

contextBridge.exposeInMainWorld("vyronDesktop", vyronDesktop);
