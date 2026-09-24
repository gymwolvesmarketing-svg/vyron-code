/**
 * Local renderer script - VYRON_CODE_ONE_CLICK_LOCAL_AI_STARTUP_AND_UX_DELIVERY.
 *
 * Shows the safe local AI state (starting / ready / unavailable) that the main process reports, and
 * the reviewed-task flow: write a draft, review the exact immutable text, explicitly send it, read a
 * bounded plain-text answer, clear it. The main process starts and verifies the local services on its
 * own; nothing here starts, configures or addresses anything.
 *
 * Every IPC call is one of the fixed `window.vyronDesktop.localAi.*` / `window.vyronDesktop.hermes.*`
 * methods (electron/preload.ts). No fetch/network request (this page's CSP forbids connect-src), no
 * storage of any kind (a draft or answer exists only in this page's memory and the main process's
 * memory, and is cleared on reload), no innerHTML (all text is set through textContent).
 *
 * This file must have NO top-level `import`/`export` statement of any kind - TypeScript would emit a
 * CommonJS wrapper that breaks its load as a classic, non-module `<script src="...">`. Contract
 * types are declared locally, mirroring `shared-ipc-contract.ts` - keep the two in sync by hand.
 */
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

interface Window {
  vyronDesktop?: DesktopApi;
}

const MAX_DRAFT_LENGTH = 4000;
const POLL_STARTING_MS = 600;
const POLL_STEADY_MS = 3000;

const STAGE_MESSAGES: Record<LocalAiStage, string> = {
  checking: "Yerel AI bağlantısı kontrol ediliyor…",
  gateway: "Yerel AI motoru başlatılıyor…",
  proxy: "Güvenli bağlantı hazırlanıyor…",
  verifying: "Güvenli bağlantı doğrulanıyor…",
};

const CATEGORY_MESSAGES: Record<SafeLocalAiFailureCategory, string> = {
  hermes_start_failed: "Hermes başlatılamadı",
  secure_connection_unverified: "Güvenli bağlantı doğrulanamadı",
  model_unresponsive: "Yerel model yanıt vermiyor",
  unavailable: "Yerel AI kullanılamıyor",
};

const STATUS_TEXT = {
  starting: "Yerel AI başlatılıyor",
  ready: "Yerel AI hazır",
  unavailable: "Yerel AI kullanılamıyor",
} as const;

const SENDING_TEXT = "Yanıt hazırlanıyor…";
const FAILURE_TEXT = "Yanıt alınamadı. Lütfen tekrar deneyin.";
const NOT_READY_TEXT = "Yerel AI şu anda hazır değil.";
const REVIEW_FAILURE_TEXT = "Taslak incelemeye alınamadı. Lütfen tekrar deneyin.";
const DRAFT_TOO_LONG_TEXT = "Metin çok uzun. En fazla 4000 karakter yazabilirsin.";
const DRAFT_INVALID_TEXT = "Metin desteklenmeyen karakterler içeriyor.";
const COPY_OK_TEXT = "Tanılama bilgileri kopyalandı.";
const COPY_FAIL_TEXT = "Tanılama bilgileri kopyalanamadı.";

type ViewName = "startup" | "ready" | "review" | "unavailable";
type AiPhase = "starting" | "ready" | "unavailable";

let aiPhase: AiPhase = "starting";
let pollTimer: number | undefined;
let pollGeneration = 0;
let taskRequestGeneration = 0;
let reviewedDraft: string | null = null;
let sendInFlight = false;
let reviewInFlight = false;

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function setText(id: string, text: string): void {
  const node = el(id);
  if (node) node.textContent = text;
}

function setHidden(id: string, hidden: boolean): void {
  const node = el(id);
  if (node) node.hidden = hidden;
}

function setDisabled(id: string, disabled: boolean): void {
  const node = el<HTMLButtonElement>(id);
  if (node) node.disabled = disabled;
}

function focusElement(id: string): void {
  const node = el(id);
  if (node) node.focus();
}

function showView(view: ViewName, focusId: string): void {
  const views: ViewName[] = ["startup", "ready", "review", "unavailable"];
  for (const name of views) setHidden(`view-${name}`, name !== view);
  focusElement(focusId);
}

function currentView(): ViewName {
  const views: ViewName[] = ["startup", "ready", "review", "unavailable"];
  for (const name of views) {
    const node = el(`view-${name}`);
    if (node && !node.hidden) return name;
  }
  return "startup";
}

function draftProblem(draft: string): "empty" | "too_long" | "invalid" | null {
  if (draft.trim().length === 0) return "empty";
  if (draft.length > MAX_DRAFT_LENGTH) return "too_long";
  for (let i = 0; i < draft.length; i += 1) {
    const code = draft.charCodeAt(i);
    if (code === 127 || (code < 32 && code !== 9 && code !== 10 && code !== 13)) return "invalid";
  }
  return null;
}

function draftValue(): string {
  const input = el<HTMLTextAreaElement>("task-draft-input");
  return input ? input.value : "";
}

function updateDraftControls(): void {
  const problem = draftProblem(draftValue());
  setDisabled("task-review-btn", problem !== null || aiPhase !== "ready" || reviewInFlight);
  const message = problem === "too_long" ? DRAFT_TOO_LONG_TEXT : problem === "invalid" ? DRAFT_INVALID_TEXT : "";
  setText("task-draft-error", message);
  setHidden("task-draft-error", message === "");
}

function resetResponseArea(): void {
  setText("task-response-text", "");
  setHidden("task-response-truncated-note", true);
  setHidden("task-response-section", true);
  setText("task-send-status", "");
  setHidden("task-send-status", true);
}

function bestEffortClearTask(): void {
  const api = window.vyronDesktop;
  if (!api) return;
  void api.hermes.clearTaskSubmission().catch(() => undefined);
}

function resetTaskFlow(): void {
  taskRequestGeneration += 1;
  reviewedDraft = null;
  sendInFlight = false;
  reviewInFlight = false;
  setText("task-review-text", "");
  resetResponseArea();
  setDisabled("task-send-btn", false);
  setDisabled("task-review-back-btn", false);
  bestEffortClearTask();
}

function applyAiState(next: LocalAiState): void {
  const previous = aiPhase;
  aiPhase = next.state;
  const pill = el("ai-status");
  if (pill) pill.className = `ai-status ai-status-${next.state}`;
  setText("ai-status-text", STATUS_TEXT[next.state]);

  if (next.state === "starting") {
    setText("startup-message", STAGE_MESSAGES[next.stage] ?? STAGE_MESSAGES.checking);
    if (previous !== "starting") {
      resetTaskFlow();
      showView("startup", "startup-title");
    }
    return;
  }

  if (next.state === "ready") {
    if (previous !== "ready") {
      showView("ready", "task-draft-input");
      updateDraftControls();
    }
    return;
  }

  setText("unavailable-category", CATEGORY_MESSAGES[next.category] ?? CATEGORY_MESSAGES.unavailable);
  if (previous !== "unavailable") {
    resetTaskFlow();
    setText("ai-copy-status", "");
    showView("unavailable", "unavailable-title");
  }
}

function stopPolling(): void {
  pollGeneration += 1;
  if (pollTimer !== undefined) {
    window.clearTimeout(pollTimer);
    pollTimer = undefined;
  }
}

function schedulePoll(): void {
  const generation = pollGeneration;
  const delay = aiPhase === "starting" ? POLL_STARTING_MS : POLL_STEADY_MS;
  pollTimer = window.setTimeout(() => {
    if (generation !== pollGeneration) return;
    void pollOnce(generation);
  }, delay);
}

async function pollOnce(generation: number): Promise<void> {
  const api = window.vyronDesktop;
  let next: LocalAiState;
  if (!api) {
    next = { state: "unavailable", category: "unavailable" };
  } else {
    try {
      next = await api.localAi.getLocalAiState();
    } catch {
      next = { state: "unavailable", category: "unavailable" };
    }
  }
  if (generation !== pollGeneration) return;
  applyAiState(next);
  schedulePoll();
}

function startPolling(): void {
  stopPolling();
  void pollOnce(pollGeneration);
}

async function handleRetry(): Promise<void> {
  const api = window.vyronDesktop;
  if (!api) return;
  setDisabled("ai-retry-btn", true);
  try {
    const next = await api.localAi.retryLocalAiStartup();
    applyAiState(next);
  } catch {
    applyAiState({ state: "unavailable", category: "unavailable" });
  } finally {
    setDisabled("ai-retry-btn", false);
  }
  startPolling();
}

async function handleCopyDiagnostics(): Promise<void> {
  const api = window.vyronDesktop;
  if (!api) return;
  try {
    const result = await api.localAi.copyLocalAiDiagnostics();
    setText("ai-copy-status", result.copied ? COPY_OK_TEXT : COPY_FAIL_TEXT);
  } catch {
    setText("ai-copy-status", COPY_FAIL_TEXT);
  }
}

async function handleReview(): Promise<void> {
  const api = window.vyronDesktop;
  const draft = draftValue();
  if (!api || aiPhase !== "ready" || reviewInFlight || draftProblem(draft) !== null) return;
  reviewInFlight = true;
  updateDraftControls();
  const generation = (taskRequestGeneration += 1);
  let result: HermesTaskSubmissionState | null = null;
  try {
    result = await api.hermes.reviewTaskDraft({ draft });
  } catch {
    result = null;
  }
  if (generation !== taskRequestGeneration) return;
  reviewInFlight = false;
  if (result && result.state === "review_ready" && result.draftLength === draft.length) {
    reviewedDraft = draft;
    setText("task-review-text", draft);
    resetResponseArea();
    setDisabled("task-send-btn", false);
    setDisabled("task-review-back-btn", false);
    showView("review", "review-title");
    return;
  }
  reviewedDraft = null;
  updateDraftControls();
  setText("task-draft-error", result && (result.state === "unauthorized" || result.state === "unavailable") ? NOT_READY_TEXT : REVIEW_FAILURE_TEXT);
  setHidden("task-draft-error", false);
}

async function handleSend(): Promise<void> {
  const api = window.vyronDesktop;
  if (!api || reviewedDraft === null || sendInFlight || aiPhase !== "ready") return;
  sendInFlight = true;
  setDisabled("task-send-btn", true);
  setDisabled("task-review-back-btn", true);
  setText("task-send-status", SENDING_TEXT);
  setHidden("task-send-status", false);
  const generation = taskRequestGeneration;
  let result: HermesTaskSubmissionState | null = null;
  try {
    result = await api.hermes.sendReviewedTask();
  } catch {
    result = null;
  }
  if (generation !== taskRequestGeneration) return;
  sendInFlight = false;
  if (result && result.state === "completed" && typeof result.text === "string") {
    setText("task-send-status", "");
    setHidden("task-send-status", true);
    setText("task-response-text", result.text);
    setHidden("task-response-truncated-note", !result.truncated);
    setHidden("task-response-section", false);
    setDisabled("task-review-back-btn", true);
    focusElement("task-response-title");
    return;
  }
  const notReady = result !== null && (result.state === "unauthorized" || result.state === "unavailable");
  setText("task-send-status", notReady ? NOT_READY_TEXT : FAILURE_TEXT);
  setHidden("task-send-status", false);
  setDisabled("task-review-back-btn", false);
  if (notReady) startPolling();
}

function handleBack(): void {
  if (sendInFlight) return;
  taskRequestGeneration += 1;
  reviewedDraft = null;
  setText("task-review-text", "");
  resetResponseArea();
  bestEffortClearTask();
  showView("ready", "task-draft-input");
  updateDraftControls();
}

function handleClearResponse(): void {
  if (sendInFlight) return;
  taskRequestGeneration += 1;
  reviewedDraft = null;
  const input = el<HTMLTextAreaElement>("task-draft-input");
  if (input) input.value = "";
  setText("task-review-text", "");
  resetResponseArea();
  bestEffortClearTask();
  showView("ready", "task-draft-input");
  updateDraftControls();
}

function onDraftInput(): void {
  updateDraftControls();
}

function onDraftKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void handleReview();
  }
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && currentView() === "review" && !sendInFlight) {
    event.preventDefault();
    handleBack();
  }
}

function on(id: string, type: string, listener: (event: Event) => void): void {
  const node = el(id);
  if (node) node.addEventListener(type, listener);
}

function main(): void {
  on("task-draft-input", "input", onDraftInput);
  on("task-draft-input", "keydown", (event) => onDraftKeydown(event as KeyboardEvent));
  on("task-review-btn", "click", () => void handleReview());
  on("task-review-back-btn", "click", () => handleBack());
  on("task-send-btn", "click", () => void handleSend());
  on("task-clear-response-btn", "click", () => handleClearResponse());
  on("ai-retry-btn", "click", () => void handleRetry());
  on("ai-copy-diagnostics-btn", "click", () => void handleCopyDiagnostics());
  document.addEventListener("keydown", (event) => onDocumentKeydown(event as KeyboardEvent));

  // A page load always starts with nothing: clear any task state a previous page load left in the
  // main process, so a draft, reviewed snapshot or answer never survives a reload.
  bestEffortClearTask();
  updateDraftControls();
  startPolling();
}

main();
