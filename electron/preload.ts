/**
 * Electron preload script - the sole main<->renderer bridge. Runs in an isolated preload context
 * with Node access itself, but the renderer it serves must never receive any of that access.
 * VYRON_CODE_V02_D02B_ELECTRON_HARDENED_SCAFFOLD_AUTHORIZATION, reduced to its final narrow shape by
 * VYRON_CODE_ONE_CLICK_LOCAL_AI_STARTUP_AND_UX_DELIVERY.
 *
 * Exposes exactly two namespaces on `window.vyronDesktop`, via `contextBridge` only:
 * - `localAi`: three parameter-free methods (state, explicit retry, sanitized diagnostics copy);
 * - `hermes`: the four reviewed-task methods (D-11); only `reviewTaskDraft` takes an argument, a
 *   single `{ draft }` object.
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
  readonly draftLength: number | null;
  readonly text: string | null;
  readonly truncated: boolean;
}

interface HermesTaskDraftReviewRequest {
  readonly draft: string;
}

interface DesktopLocalAiApi {
  getLocalAiState(): Promise<LocalAiState>;
  retryLocalAiStartup(): Promise<LocalAiState>;
  copyLocalAiDiagnostics(): Promise<SafeCopyResult>;
}

interface DesktopHermesApi {
  getTaskSubmissionState(): Promise<HermesTaskSubmissionState>;
  reviewTaskDraft(request: HermesTaskDraftReviewRequest): Promise<HermesTaskSubmissionState>;
  sendReviewedTask(): Promise<HermesTaskSubmissionState>;
  clearTaskSubmission(): Promise<HermesTaskSubmissionState>;
}

interface DesktopApi {
  readonly localAi: DesktopLocalAiApi;
  readonly hermes: DesktopHermesApi;
}

const LOCAL_AI_GET_STATE_CHANNEL = "localAi:getState";
const LOCAL_AI_RETRY_CHANNEL = "localAi:retry";
const LOCAL_AI_COPY_DIAGNOSTICS_CHANNEL = "localAi:copyDiagnostics";
const HERMES_GET_TASK_SUBMISSION_STATE_CHANNEL = "hermes:getTaskSubmissionState";
const HERMES_REVIEW_TASK_DRAFT_CHANNEL = "hermes:reviewTaskDraft";
const HERMES_SEND_REVIEWED_TASK_CHANNEL = "hermes:sendReviewedTask";
const HERMES_CLEAR_TASK_SUBMISSION_CHANNEL = "hermes:clearTaskSubmission";

const vyronDesktop: DesktopApi = {
  localAi: {
    getLocalAiState: () => ipcRenderer.invoke(LOCAL_AI_GET_STATE_CHANNEL),
    retryLocalAiStartup: () => ipcRenderer.invoke(LOCAL_AI_RETRY_CHANNEL),
    copyLocalAiDiagnostics: () => ipcRenderer.invoke(LOCAL_AI_COPY_DIAGNOSTICS_CHANNEL),
  },
  hermes: {
    getTaskSubmissionState: () => ipcRenderer.invoke(HERMES_GET_TASK_SUBMISSION_STATE_CHANNEL),
    reviewTaskDraft: (request) => ipcRenderer.invoke(HERMES_REVIEW_TASK_DRAFT_CHANNEL, request),
    sendReviewedTask: () => ipcRenderer.invoke(HERMES_SEND_REVIEWED_TASK_CHANNEL),
    clearTaskSubmission: () => ipcRenderer.invoke(HERMES_CLEAR_TASK_SUBMISSION_CHANNEL),
  },
};

contextBridge.exposeInMainWorld("vyronDesktop", vyronDesktop);
