/**
 * Vyron Code workspace renderer - VYRON_CODE_WORKSPACE_UI_UX_IMPLEMENTATION.
 *
 * Classic browser script (loaded after workspace-model.js), so it must have NO top-level `import` or
 * `export`. It renders the whole desktop workspace - sidebar, views, composer, menus and pickers -
 * from the pure model in workspace-model.ts and talks to the main process only through the six fixed
 * `window.vyronDesktop` methods (local AI state / retry / diagnostics copy, and the direct task
 * send / state / clear). All text is written with textContent; there is no innerHTML, no network
 * call and no timer-string API. Product metadata is persisted in localStorage through the model
 * (validated on load); a task's text and its answer are kept in memory only.
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

type HermesTaskSubmissionAmbientState = "idle" | "sending" | "completed" | "unavailable" | "unauthorized" | "safe_failure" | "cancelled";

interface HermesTaskSubmissionState {
  readonly state: HermesTaskSubmissionAmbientState;
  readonly text: string | null;
  readonly truncated: boolean;
}

interface HermesTaskRequest {
  readonly draft: string;
  readonly agent?: string;
  readonly project?: string;
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

interface DesktopApi {
  readonly localAi: DesktopLocalAiApi;
  readonly hermes: DesktopHermesApi;
  readonly app: DesktopAppApi;
}

interface Window {
  vyronDesktop?: DesktopApi;
}

// ---------------------------------------------------------------------------------------------
// Fixed Turkish copy
// ---------------------------------------------------------------------------------------------

const POLL_STARTING_MS = 600;
const POLL_STEADY_MS = 3000;
const MAX_ATTACHMENTS = 10;

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

const WORKING_TEXT = "Çalışıyor…";
const FAILURE_TEXT = "Yanıt alınamadı. Lütfen tekrar deneyin.";
const NOT_READY_TEXT = "Yerel AI şu anda hazır değil.";
const WAIT_FOR_AI_TEXT = "Yerel AI hazır olunca gönderebilirsin.";
const DRAFT_TOO_LONG_TEXT = "Metin çok uzun. En fazla 4000 karakter gönderilebilir.";
const DRAFT_INVALID_TEXT = "Metin desteklenmeyen karakterler içeriyor.";
const COPY_OK_TEXT = "Tanılama bilgileri kopyalandı.";
const COPY_FAIL_TEXT = "Tanılama bilgileri kopyalanamadı.";
const ATTACHMENT_NOTE = "Ekler bu sürümde göreve gönderilmez; yalnızca görev metni iletilir.";
const CLEARED_TEXT = "Yanıt temizlendi.";
const NO_ANSWER_TEXT = "Bu görev için bu oturumda kayıtlı yanıt yok. Aşağıdan devam edebilirsin.";

const PAGE_TITLES: Record<WsNavView, string> = {
  "new-task": "Yeni görev",
  skills: "Yetenekler",
  connectors: "Bağlayıcılar",
  sites: "Web sitesi yönetimi",
  settings: "Ayarlar",
  manager: "Managers",
};

const VIEW_IDS: Record<WsNavView, string> = {
  "new-task": "view-new-task",
  skills: "view-skills",
  connectors: "view-connectors",
  sites: "view-sites",
  settings: "view-settings",
  manager: "view-manager",
};

// ---------------------------------------------------------------------------------------------
// Icons: tiny local SVG spec ("p:" path, "c:" circle cx,cy,r, "r:" rect x,y,w,h,rx, "e:" ellipse)
// ---------------------------------------------------------------------------------------------

const ICONS: Record<string, string[]> = {
  logo: ["p:M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z", "p:M8.5 9.5L12 15l3.5-5.5"],
  "chevron-down": ["p:M6 9l6 6 6-6"],
  "chevron-right": ["p:M9 6l6 6-6 6"],
  panel: ["r:3,4,18,16,3", "p:M9 4v16"],
  search: ["c:11,11,7", "p:M20 20l-3.5-3.5"],
  plus: ["p:M12 5v14M5 12h14"],
  "plus-circle": ["c:12,12,9", "p:M12 8v8M8 12h8"],
  sparkles: ["p:M12 3l1.8 4.7 4.7 1.8-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3z", "p:M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z"],
  plug: ["p:M9 3v5M15 3v5M6 8h12v3a6 6 0 01-12 0V8z", "p:M12 17v4"],
  globe: ["c:12,12,9", "p:M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"],
  settings: ["p:M4 7h10M18 7h2M4 17h2M10 17h10", "c:16,7,2", "c:8,17,2"],
  folder: ["p:M3 7a2 2 0 012-2h4l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"],
  "folder-plus": ["p:M3 7a2 2 0 012-2h4l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z", "p:M12 11v5M9.5 13.5h5"],
  monitor: ["r:3,4,18,12,2", "p:M8 20h8M12 16v4"],
  "list-check": ["p:M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"],
  "arrow-up": ["p:M12 19V5M5 12l7-7 7 7"],
  paperclip: ["p:M20 11l-8.5 8.5a5 5 0 01-7-7L13 4a3.5 3.5 0 015 5l-8.5 8.5a2 2 0 01-3-3L14 7"],
  bot: ["r:5,8,14,11,3", "p:M12 4v4M9 13v1M15 13v1M3 13v2M21 13v2"],
  terminal: ["p:M4 6l6 6-6 6M12 19h8"],
  x: ["p:M6 6l12 12M18 6L6 18"],
  check: ["p:M5 12.5l4.5 4.5L19 7"],
  image: ["r:3,4,18,16,3", "c:9,10,1.6", "p:M4 18l5-5 4 4 3-3 4 4"],
  document: ["p:M6 3h8l5 5v13H6z", "p:M14 3v5h5M9 13h6M9 17h6"],
  message: ["p:M4 5h16v11H9l-5 4V5z"],
  code: ["p:M8 7l-5 5 5 5M16 7l5 5-5 5M14 5l-4 14"],
  palette: ["p:M12 3a9 9 0 100 18c1.5 0 2-1 1.5-2.2-.5-1.3.3-2.3 1.6-2.3H17a4 4 0 004-4c0-5-4-9.5-9-9.5z", "c:7.5,11,1", "c:10,7,1", "c:15,7.5,1"],
  presentation: ["p:M3 4h18M5 4v10h14V4M12 14v5M8 20l4-1 4 1"],
  chart: ["p:M4 20V10M10 20V4M16 20v-7M22 20H2"],
  research: ["c:11,11,7", "p:M20 20l-3.5-3.5M8.5 11h5M11 8.5v5"],
  video: ["r:3,6,13,12,2", "p:M16 10l5-3v10l-5-3"],
  github: ["c:6,6,2", "c:6,18,2", "c:18,8,2", "p:M6 8v8M18 10c0 4-6 3-12 6"],
  database: ["e:12,6,8,3", "p:M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"],
  triangle: ["p:M12 4l9 16H3L12 4z"],
  card: ["r:3,5,18,14,2", "p:M3 10h18M7 15h4"],
  hash: ["p:M5 9h15M4 15h15M10 4L8 20M16 4l-2 16"],
  mail: ["r:3,5,18,14,2", "p:M3 7l9 6 9-6"],
  note: ["p:M6 3h9l4 4v14H6z", "p:M9 12h7M9 16h7"],
  trash: ["p:M5 7h14M10 4h4M7 7l1 13h8l1-13"],
  link: ["p:M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"],
  spinner: ["p:M12 3a9 9 0 019 9"],
  refresh: ["p:M20 12a8 8 0 11-2.3-5.6", "p:M20 4v5h-5"],
};

const SVG_NS = "http://www.w3.org/2000/svg";

function makeIcon(name: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "ico");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const parts = ICONS[name] ?? ICONS.logo ?? [];
  for (const part of parts) {
    const kind = part.slice(0, 1);
    const data = part.slice(2);
    if (kind === "p") {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", data);
      svg.appendChild(path);
    } else if (kind === "c") {
      const [cx, cy, r] = data.split(",");
      const circle = document.createElementNS(SVG_NS, "circle");
      circle.setAttribute("cx", cx ?? "0");
      circle.setAttribute("cy", cy ?? "0");
      circle.setAttribute("r", r ?? "1");
      svg.appendChild(circle);
    } else if (kind === "r") {
      const [x, y, w, h, rx] = data.split(",");
      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("x", x ?? "0");
      rect.setAttribute("y", y ?? "0");
      rect.setAttribute("width", w ?? "1");
      rect.setAttribute("height", h ?? "1");
      rect.setAttribute("rx", rx ?? "0");
      svg.appendChild(rect);
    } else if (kind === "e") {
      const [cx, cy, rx, ry] = data.split(",");
      const ellipse = document.createElementNS(SVG_NS, "ellipse");
      ellipse.setAttribute("cx", cx ?? "0");
      ellipse.setAttribute("cy", cy ?? "0");
      ellipse.setAttribute("rx", rx ?? "1");
      ellipse.setAttribute("ry", ry ?? "1");
      svg.appendChild(ellipse);
    }
  }
  return svg;
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

type AiPhase = "starting" | "ready" | "unavailable";

interface Attachment {
  readonly id: string;
  readonly name: string;
  readonly size: number;
}

interface Turn {
  readonly id: string;
  readonly prompt: string;
  readonly composed: string;
  readonly labels: string[];
  readonly agent: string | null;
  readonly project: string | null;
  status: "running" | "done" | "error";
  text: string | null;
  truncated: boolean;
  errorText: string | null;
  cleared: boolean;
}

interface MenuInstance {
  readonly id: string;
  readonly el: HTMLElement;
  readonly trigger: HTMLElement;
  readonly level: number;
}

let ws: WsWorkspaceState = VyronModel.defaultState();
let aiPhase: AiPhase = "starting";
let aiFailure: SafeLocalAiFailureCategory = "unavailable";
let pollTimer: number | undefined;
let pollGeneration = 0;
let sendInFlight = false;
let attachments: Attachment[] = [];
let sidebarQuery = "";
let skillsQuery = "";
let connectorsQuery = "";
let resetConfirming = false;
let overlayDismissed = false;
const turnsByTask = new Map<string, Turn[]>();
let menus: MenuInstance[] = [];

// ---------------------------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------------------------

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function must<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id) as T | null;
  if (!node) throw new Error("missing element " + id);
  return node;
}

function setText(id: string, text: string): void {
  const node = el(id);
  if (node) node.textContent = text;
}

function clearNode(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function makeButton(className: string, label: string, onClick: () => void, iconName?: string): HTMLButtonElement {
  const button = make("button", className);
  button.type = "button";
  if (iconName) button.appendChild(makeIcon(iconName));
  if (label) button.appendChild(make("span", "btn-label", label));
  button.addEventListener("click", onClick);
  return button;
}

function hydrateIcons(root: ParentNode): void {
  const holders = root.querySelectorAll("[data-icon]");
  holders.forEach((holder) => {
    const name = holder.getAttribute("data-icon");
    if (name && holder.childElementCount === 0) holder.appendChild(makeIcon(name));
  });
}

function persist(): void {
  let storage: Storage | null = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  VyronModel.saveState(storage, ws);
}

function getStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function focusSoon(node: HTMLElement | null): void {
  if (node) node.focus();
}

// ---------------------------------------------------------------------------------------------
// Local AI lifecycle view (state comes from the main process; this page only shows it)
// ---------------------------------------------------------------------------------------------

function stopPolling(): void {
  pollGeneration += 1;
  if (pollTimer !== undefined) {
    window.clearTimeout(pollTimer);
    pollTimer = undefined;
  }
}

function schedulePoll(): void {
  const generation = pollGeneration;
  const delay = aiPhase === "ready" ? POLL_STEADY_MS : POLL_STARTING_MS;
  pollTimer = window.setTimeout(() => {
    pollTimer = undefined;
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

function applyAiState(next: LocalAiState): void {
  const previous = aiPhase;
  aiPhase = next.state;
  if (next.state === "unavailable") aiFailure = next.category;

  const pill = must("ai-status");
  pill.className = "ai-status ai-status-" + aiPhase;
  setText("ai-status-text", STATUS_TEXT[aiPhase]);

  const overlay = must("startup-overlay");
  if (next.state === "starting") {
    setText("startup-message", STAGE_MESSAGES[next.stage]);
    overlay.hidden = false;
  } else {
    overlay.hidden = true;
  }

  const banner = must("ai-banner");
  if (next.state === "unavailable") {
    setText("ai-banner-text", NOT_READY_TEXT + " " + CATEGORY_MESSAGES[next.category] + ".");
    banner.hidden = false;
  } else {
    banner.hidden = true;
    setText("ai-copy-status", "");
  }
  renderSettingsAi();
  updateComposer();

  if (previous === "starting" && next.state !== "starting" && !overlayDismissed) {
    overlayDismissed = true;
    if (ws.view === "new-task") focusSoon(el("task-input"));
  } else if (next.state === "starting" && previous !== "starting") {
    focusSoon(el("startup-card"));
  }
}

async function handleRetry(): Promise<void> {
  const api = window.vyronDesktop;
  if (!api) return;
  overlayDismissed = false;
  try {
    applyAiState(await api.localAi.retryLocalAiStartup());
  } catch {
    applyAiState({ state: "unavailable", category: "unavailable" });
  }
  startPolling();
}

async function handleCopyDiagnostics(): Promise<void> {
  const api = window.vyronDesktop;
  if (!api) return;
  let text = COPY_FAIL_TEXT;
  try {
    const result = await api.localAi.copyLocalAiDiagnostics();
    text = result.copied ? COPY_OK_TEXT : COPY_FAIL_TEXT;
  } catch {
    text = COPY_FAIL_TEXT;
  }
  setText("ai-copy-status", text);
  setText("settings-ai-status", settingsAiText() + " " + text);
}

function settingsAiText(): string {
  if (aiPhase === "ready") return "Yerel AI hazır. Görevler bu bilgisayarda çalışır.";
  if (aiPhase === "starting") return "Yerel AI başlatılıyor…";
  return NOT_READY_TEXT + " " + CATEGORY_MESSAGES[aiFailure] + ".";
}

function renderSettingsAi(): void {
  setText("settings-ai-status", settingsAiText());
  const retry = el<HTMLButtonElement>("settings-retry-btn");
  if (retry) retry.disabled = aiPhase !== "unavailable";
}

function bestEffortClearTask(): void {
  const api = window.vyronDesktop;
  if (!api) return;
  try {
    void api.hermes.clearTaskSubmission().catch(() => undefined);
  } catch {
    // The main-process state is cleared again on quit; a failed best-effort clear must never surface here.
  }
}

// ---------------------------------------------------------------------------------------------
// Menu and picker infrastructure
// ---------------------------------------------------------------------------------------------

interface ItemSpec {
  label: string;
  icon?: string;
  sub?: string;
  role?: "menuitem" | "menuitemradio" | "menuitemcheckbox";
  checked?: boolean;
  submenu?: (item: HTMLButtonElement) => void;
  onSelect?: () => void;
  disabled?: boolean;
}

function isMenuOpen(id: string): boolean {
  return menus.some((m) => m.id === id);
}

function menuItems(container: HTMLElement): HTMLButtonElement[] {
  const all = Array.from(container.querySelectorAll<HTMLButtonElement>(".menu-item, .picker-row, .panel-focusable"));
  return all.filter((item) => !item.disabled && item.getAttribute("aria-disabled") !== "true" && !item.hidden);
}

function closeMenusFrom(level: number, restoreFocus: boolean): void {
  const closing = menus.filter((m) => m.level >= level);
  if (closing.length === 0) return;
  menus = menus.filter((m) => m.level < level);
  for (const menu of closing.reverse()) {
    menu.trigger.setAttribute("aria-expanded", "false");
    menu.trigger.classList.remove("is-open");
    if (menu.el.parentNode) menu.el.parentNode.removeChild(menu.el);
  }
  if (restoreFocus) {
    const last = closing[closing.length - 1];
    if (last && last.trigger.isConnected) last.trigger.focus();
  }
}

function closeAllMenus(restoreFocus: boolean): void {
  closeMenusFrom(0, restoreFocus);
}

function placeMenu(node: HTMLElement, anchor: DOMRect, side: "below" | "right"): void {
  const margin = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = node.offsetWidth;
  const height = node.offsetHeight;
  let left: number;
  let top: number;
  if (side === "right") {
    left = anchor.right + 4;
    if (left + width > vw - margin) left = anchor.left - width - 4;
    top = anchor.top - 6;
  } else {
    left = anchor.left;
    top = anchor.bottom + 6;
    if (top + height > vh - margin) {
      const above = anchor.top - height - 6;
      top = above >= margin ? above : top;
    }
  }
  left = Math.max(margin, Math.min(left, Math.max(margin, vw - width - margin)));
  top = Math.max(margin, Math.min(top, Math.max(margin, vh - height - margin)));
  node.style.left = String(Math.round(left)) + "px";
  node.style.top = String(Math.round(top)) + "px";
}

function openFloating(id: string, trigger: HTMLElement, node: HTMLElement, level: number, side: "below" | "right"): MenuInstance {
  closeMenusFrom(level, false);
  const layer = must("menu-layer");
  node.dataset.menuId = id;
  layer.appendChild(node);
  placeMenu(node, trigger.getBoundingClientRect(), side);
  trigger.setAttribute("aria-expanded", "true");
  trigger.classList.add("is-open");
  const instance: MenuInstance = { id, el: node, trigger, level };
  menus.push(instance);
  node.addEventListener("keydown", (event) => onMenuKeydown(event, instance));
  return instance;
}

function makeMenuItem(spec: ItemSpec): HTMLButtonElement {
  const item = make("button", "menu-item");
  item.type = "button";
  const role = spec.role ?? "menuitem";
  item.setAttribute("role", role);
  if (role !== "menuitem") item.setAttribute("aria-checked", spec.checked ? "true" : "false");
  if (spec.disabled) item.setAttribute("aria-disabled", "true");
  if (role !== "menuitem") {
    const check = make("span", "menu-check");
    if (spec.checked) check.appendChild(makeIcon("check"));
    item.appendChild(check);
  } else if (spec.icon) {
    item.appendChild(makeIcon(spec.icon));
  }
  const label = make("span", "menu-label", spec.label);
  item.appendChild(label);
  if (spec.sub) item.appendChild(make("span", "menu-sub", spec.sub));
  if (spec.submenu) {
    item.setAttribute("aria-haspopup", "menu");
    item.setAttribute("aria-expanded", "false");
    const arrow = make("span", "menu-arrow");
    arrow.appendChild(makeIcon("chevron-right"));
    item.appendChild(arrow);
    const openSub = spec.submenu;
    item.addEventListener("click", () => openSub(item));
    item.addEventListener("mouseenter", () => {
      if (isMenuOpenForTrigger(item)) return;
      // Hover opens the submenu without stealing keyboard focus from the parent item.
      const previous = document.activeElement as HTMLElement | null;
      openSub(item);
      if (previous) previous.focus();
    });
  } else {
    item.addEventListener("mouseenter", () => {
      // Hovering a plain item closes any submenu that a sibling opened.
      const level = menuLevelOf(item);
      if (level >= 0) closeMenusFrom(level + 1, false);
    });
    item.addEventListener("click", () => {
      if (spec.disabled) return;
      if (spec.onSelect) spec.onSelect();
      closeAllMenus(true);
    });
  }
  return item;
}

function isMenuOpenForTrigger(trigger: HTMLElement): boolean {
  return menus.some((m) => m.trigger === trigger);
}

function menuLevelOf(item: HTMLElement): number {
  const owner = menus.find((m) => m.el.contains(item));
  return owner ? owner.level : -1;
}

function makeMenu(): HTMLDivElement {
  const menu = make("div", "menu");
  menu.setAttribute("role", "menu");
  return menu;
}

function makeSeparator(): HTMLElement {
  const sep = make("div", "menu-sep");
  sep.setAttribute("role", "separator");
  return sep;
}

function onMenuKeydown(event: KeyboardEvent, instance: MenuInstance): void {
  const items = menuItems(instance.el);
  const active = document.activeElement as HTMLElement | null;
  const index = active ? items.indexOf(active as HTMLButtonElement) : -1;
  const isPanel = instance.el.classList.contains("panel");
  const target = event.target as HTMLElement | null;
  const typing = target instanceof HTMLInputElement && target.type !== "checkbox";

  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeMenusFrom(instance.level, true);
    return;
  }
  if (event.key === "Tab") {
    closeAllMenus(false);
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    const next = items[index < 0 ? 0 : Math.min(items.length - 1, index + 1)];
    if (next) next.focus();
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    if (index <= 0) {
      const search = instance.el.querySelector<HTMLInputElement>(".panel-search input");
      if (isPanel && search) search.focus();
      else if (items[0]) items[0].focus();
      return;
    }
    const previous = items[index - 1];
    if (previous) previous.focus();
    return;
  }
  if (typing) return;
  if (event.key === "Home") {
    event.preventDefault();
    if (items[0]) items[0].focus();
  } else if (event.key === "End") {
    event.preventDefault();
    const last = items[items.length - 1];
    if (last) last.focus();
  } else if (event.key === "ArrowRight") {
    if (active && active.getAttribute("aria-haspopup") === "menu" && active.classList.contains("menu-item")) {
      event.preventDefault();
      active.click();
      const sub = menus.find((m) => m.trigger === active);
      const first = sub ? menuItems(sub.el)[0] : undefined;
      if (first) first.focus();
    }
  } else if (event.key === "ArrowLeft" && instance.level > 0) {
    event.preventDefault();
    closeMenusFrom(instance.level, true);
  }
}

/** A trigger button toggles its own menu; opening one root menu closes any other root menu. */
function toggleRootMenu(id: string, trigger: HTMLElement, open: () => void): void {
  if (isMenuOpen(id)) {
    closeAllMenus(true);
    return;
  }
  closeAllMenus(false);
  open();
}

function openMenuWith(id: string, trigger: HTMLElement, build: (menu: HTMLElement) => void, level = 0, side: "below" | "right" = "below"): MenuInstance {
  const menu = makeMenu();
  build(menu);
  const instance = openFloating(id, trigger, menu, level, side);
  const first = menuItems(menu)[0];
  if (first) first.focus();
  return instance;
}

// ---------------------------------------------------------------------------------------------
// Selectors used by the composer and sidebar
// ---------------------------------------------------------------------------------------------

function selectedManager(): WsManager | null {
  return ws.managers.find((m) => m.id === ws.selectedManagerId) ?? null;
}

/** The Ruflo role that runs the selected Manager's tasks (null = direct local AI task). */
function selectedAgent(): string | null {
  const manager = selectedManager();
  return manager ? manager.agent : null;
}

/** A Manager with a Ruflo role is expressed through that role, so no "Rol:" line is added to the text. */
function managerName(): string | null {
  const manager = selectedManager();
  return manager && manager.agent === null ? manager.name : null;
}

function agentLabel(agent: string | null): string {
  if (agent === null) return "Doğrudan yerel AI";
  const label = VyronModel.AGENT_ROLES.find((role) => role.id === agent)?.label ?? agent;
  return "Ruflo · " + label + (agent === "task-orchestrator" ? " (paralel ekip)" : "");
}

function selectedSkills(): WsSkill[] {
  return VyronModel.SKILLS.filter((s) => ws.selectedSkillIds.indexOf(s.id) >= 0);
}

function selectedConnectors(): WsConnector[] {
  return ws.connectors.filter((c) => c.status === "connected" && ws.selectedConnectorIds.indexOf(c.id) >= 0);
}

function planLabel(): string {
  return VyronModel.PLAN_MODES.find((m) => m.id === ws.planMode)?.label ?? "Standart";
}

function workModeLabel(): string {
  return VyronModel.WORK_MODES.find((m) => m.id === ws.workMode)?.label ?? "Yerel";
}

function composedPrompt(draft: string): string {
  return VyronModel.composePrompt({
    draft,
    workMode: ws.workMode,
    planMode: ws.planMode,
    terminalMode: ws.terminalMode,
    managerName: managerName(),
    skillNames: selectedSkills().map((s) => s.name),
    connectorNames: selectedConnectors().map((c) => c.name),
  });
}

function selectionLabels(): string[] {
  const labels: string[] = [];
  const manager = selectedManager();
  if (manager) labels.push("SubAgent: " + manager.name);
  for (const skill of selectedSkills()) labels.push(skill.name);
  for (const connector of selectedConnectors()) labels.push(connector.name);
  if (ws.planMode !== "standard") labels.push("Plan: " + planLabel());
  if (ws.terminalMode === "suggest") labels.push("Terminal: komut önerisi");
  if (ws.workMode !== "local") labels.push(workModeLabel());
  return labels;
}

// ---------------------------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------------------------

function applySidebarState(): void {
  const app = must("app");
  app.dataset.sidebar = ws.sidebarCollapsed ? "collapsed" : "expanded";
  const toggle = must("sidebar-toggle-btn");
  toggle.setAttribute("aria-pressed", ws.sidebarCollapsed ? "true" : "false");
  const label = ws.sidebarCollapsed ? "Yan paneli genişlet" : "Yan paneli daralt";
  toggle.setAttribute("aria-label", label);
  toggle.setAttribute("title", label);
  const compact = el<HTMLInputElement>("settings-compact");
  if (compact) compact.checked = ws.sidebarCollapsed;
}

function renderSidebarTabs(): void {
  const projectsActive = ws.sidebarTab === "projects";
  const tabProjects = must("tab-projects");
  const tabManagers = must("tab-managers");
  tabProjects.setAttribute("aria-selected", projectsActive ? "true" : "false");
  tabManagers.setAttribute("aria-selected", projectsActive ? "false" : "true");
  tabProjects.tabIndex = projectsActive ? 0 : -1;
  tabManagers.tabIndex = projectsActive ? -1 : 0;
  must("panel-projects").hidden = !projectsActive;
  must("panel-managers").hidden = projectsActive;
}

function renderProjects(): void {
  const list = must("project-list");
  clearNode(list);
  const query = sidebarQuery;
  const searching = VyronModel.normalizeQuery(query).length > 0;
  let shown = 0;

  const groups: Array<{ project: WsProject | null; tasks: WsTask[] }> = ws.projects.map((project) => ({
    project,
    tasks: VyronModel.tasksOfProject(ws, project.id),
  }));
  const loose = VyronModel.tasksOfProject(ws, null);
  if (loose.length > 0) groups.push({ project: null, tasks: loose });

  for (const group of groups) {
    const project = group.project;
    const projectName = project ? project.name : "Projesiz görevler";
    const matchingTasks = group.tasks.filter((t) => VyronModel.matchesQuery(query, t.title));
    const projectMatches = VyronModel.matchesQuery(query, projectName);
    if (searching && !projectMatches && matchingTasks.length === 0) continue;
    shown += 1;

    const expanded = searching ? true : project ? project.expanded : true;
    const wrap = make("div", "project-group");
    wrap.dataset.expanded = expanded ? "true" : "false";
    wrap.dataset.projectId = project ? project.id : "";

    const row = make("div", "project-row");
    if (project && ws.activeProjectId === project.id) row.classList.add("is-active");
    const main = make("button", "project-main");
    main.type = "button";
    main.title = projectName;
    main.setAttribute("aria-expanded", expanded ? "true" : "false");
    const caret = make("span", "caret");
    caret.appendChild(makeIcon("chevron-down"));
    main.appendChild(caret);
    main.appendChild(makeIcon("folder"));
    main.appendChild(make("span", "project-name", projectName));
    main.addEventListener("click", () => {
      if (project) {
        project.expanded = !project.expanded;
        ws.activeProjectId = project.id;
        persist();
        renderAll();
      }
    });
    row.appendChild(main);
    if (project) {
      const add = make("button", "icon-btn small project-add");
      add.type = "button";
      add.setAttribute("aria-label", project.name + " projesinde yeni görev");
      add.title = "Yeni görev";
      add.appendChild(makeIcon("plus"));
      add.addEventListener("click", () => startTaskInProject(project.id));
      row.appendChild(add);
    }
    wrap.appendChild(row);

    if (expanded) {
      const taskList = make("div", "task-list");
      let visible: WsTask[];
      let hidden = 0;
      if (searching) {
        visible = matchingTasks;
      } else if (project) {
        const v = VyronModel.visibleTasks(ws, project);
        visible = v.visible;
        hidden = v.hidden;
      } else {
        visible = group.tasks;
      }
      if (group.tasks.length === 0) {
        taskList.appendChild(make("p", "task-empty", "Henüz görev yok"));
      }
      for (const task of visible) {
        const item = make("button", "task-item", task.title);
        item.type = "button";
        item.title = task.title;
        item.dataset.taskId = task.id;
        if (ws.activeTaskId === task.id) item.setAttribute("aria-current", "true");
        item.addEventListener("click", () => openTask(task.id));
        taskList.appendChild(item);
      }
      if (project && !searching && (hidden > 0 || (project.showAll && group.tasks.length > VyronModel.COLLAPSED_TASK_COUNT))) {
        const more = make("button", "task-more", project.showAll ? "Daha az göster" : "Daha Fazla");
        more.type = "button";
        more.setAttribute("aria-expanded", project.showAll ? "true" : "false");
        more.addEventListener("click", () => {
          project.showAll = !project.showAll;
          persist();
          renderProjects();
        });
        taskList.appendChild(more);
      }
      wrap.appendChild(taskList);
    }
    list.appendChild(wrap);
  }
  must("project-search-empty").hidden = !(searching && shown === 0);
}

function renderManagers(): void {
  const list = must("manager-list");
  clearNode(list);
  const searching = VyronModel.normalizeQuery(sidebarQuery).length > 0;
  let shown = 0;
  for (const manager of ws.managers) {
    if (searching && !VyronModel.matchesQuery(sidebarQuery, manager.name, manager.description)) continue;
    shown += 1;
    const row = make("div", "manager-row");
    const isSelected = ws.selectedManagerId === manager.id;
    if (isSelected || (ws.view === "manager" && managerViewId === manager.id)) row.classList.add("is-active");
    const main = make("button", "manager-main");
    main.type = "button";
    main.title = manager.description;
    main.dataset.managerId = manager.id;
    main.setAttribute("aria-pressed", isSelected ? "true" : "false");
    const avatar = make("span", "manager-avatar");
    avatar.appendChild(makeIcon("bot"));
    main.appendChild(avatar);
    main.appendChild(make("span", "manager-name", manager.name));
    main.appendChild(make("span", "manager-tag", isSelected ? "Seçili" : manager.tag));
    main.addEventListener("click", () => openManager(manager.id));
    row.appendChild(main);
    list.appendChild(row);
  }
  must("manager-search-empty").hidden = !(searching && shown === 0);
}

function renderSidebar(): void {
  applySidebarState();
  renderSidebarTabs();
  renderProjects();
  renderManagers();
  const nav = document.querySelectorAll<HTMLElement>(".nav-item[data-nav]");
  nav.forEach((node) => {
    const target = node.dataset.nav as WsNavView | undefined;
    const current = target === ws.view;
    if (current) node.setAttribute("aria-current", "page");
    else node.removeAttribute("aria-current");
  });
}

function setSidebarTab(tab: WsSidebarTab): void {
  ws.sidebarTab = tab;
  persist();
  renderSidebarTabs();
  renderProjects();
  renderManagers();
}

function toggleSidebarSearch(force?: boolean): void {
  const box = must("sidebar-search");
  const open = force === undefined ? box.hidden : force;
  if (ws.sidebarCollapsed && open) {
    ws.sidebarCollapsed = false;
    persist();
    applySidebarState();
  }
  box.hidden = !open;
  must("sidebar-search-btn").setAttribute("aria-expanded", open ? "true" : "false");
  const input = must<HTMLInputElement>("sidebar-search-input");
  if (open) {
    input.focus();
  } else {
    input.value = "";
    sidebarQuery = "";
    renderProjects();
    renderManagers();
  }
}

// ---------------------------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------------------------

let managerViewId: string | null = null;

function showView(view: WsNavView): void {
  closeAllMenus(false);
  ws.view = view;
  for (const key of Object.keys(VIEW_IDS) as WsNavView[]) {
    must(VIEW_IDS[key]).hidden = key !== view;
  }
  let title = PAGE_TITLES[view];
  if (view === "manager") {
    const manager = ws.managers.find((m) => m.id === managerViewId);
    title = manager ? manager.name : PAGE_TITLES.manager;
  }
  setText("page-title", title);
  document.title = title === "Yeni görev" ? "Vyron Code" : title + " - Vyron Code";
  renderSidebar();
  if (view === "skills") renderSkillsPage();
  else if (view === "connectors") renderConnectorsPage();
  else if (view === "sites") renderSitesPage();
  else if (view === "manager") renderManagerDetail();
  else if (view === "settings") {
    renderSettingsAi();
    resetConfirming = false;
    memoryConfirming = false;
    renderResetControls();
    renderMemoryControls();
  } else renderTaskView();
}

function navigate(view: WsNavView, focusId?: string): void {
  showView(view);
  if (focusId) focusSoon(el(focusId));
}

function startTaskInProject(projectId: string | null): void {
  ws.activeProjectId = projectId;
  ws.activeTaskId = null;
  persist();
  showView("new-task");
  focusSoon(el("task-input"));
}

function openTask(taskId: string): void {
  const task = VyronModel.findTask(ws, taskId);
  if (!task) return;
  ws.activeTaskId = task.id;
  ws.activeProjectId = task.projectId;
  persist();
  showView("new-task");
  focusSoon(el("task-input"));
}

function openManager(managerId: string): void {
  managerViewId = managerId;
  showView("manager");
}

function selectProject(projectId: string | null): void {
  ws.activeProjectId = projectId;
  const active = VyronModel.findTask(ws, ws.activeTaskId);
  if (active && active.projectId !== projectId) ws.activeTaskId = null;
  persist();
  if (ws.view !== "new-task") showView("new-task");
  else {
    renderSidebar();
    renderTaskView();
  }
}

// ---------------------------------------------------------------------------------------------
// Task view: composer, chips, quick starts, conversation
// ---------------------------------------------------------------------------------------------

function renderQuickStarts(): void {
  const box = must("quick-starts");
  clearNode(box);
  for (const quick of VyronModel.QUICK_STARTS) {
    const button = make("button", "quick-btn");
    button.type = "button";
    button.dataset.quickId = quick.id;
    button.id = "quick-" + quick.id;
    button.appendChild(makeIcon(quick.icon));
    button.appendChild(make("span", "", quick.label));
    button.addEventListener("click", () => applyQuickStart(quick));
    box.appendChild(button);
  }
}

function applyQuickStart(quick: WsQuickStart): void {
  if (ws.view !== "new-task") showView("new-task");
  const input = must<HTMLTextAreaElement>("task-input");
  input.value = quick.draft;
  input.focus();
  const open = quick.draft.indexOf("[");
  const close = open >= 0 ? quick.draft.indexOf("]", open) : -1;
  if (open >= 0 && close > open) input.setSelectionRange(open, close + 1);
  else input.setSelectionRange(quick.draft.length, quick.draft.length);
  updateComposer();
}

function makeChip(iconName: string, text: string, sub: string | null, removeLabel: string, onRemove: () => void): HTMLElement {
  const chip = make("span", "chip");
  chip.appendChild(makeIcon(iconName));
  chip.appendChild(make("span", "chip-text", text));
  if (sub) chip.appendChild(make("span", "chip-sub", sub));
  const remove = make("button", "chip-remove");
  remove.type = "button";
  remove.setAttribute("aria-label", removeLabel);
  remove.title = removeLabel;
  remove.appendChild(makeIcon("x"));
  remove.addEventListener("click", onRemove);
  chip.appendChild(remove);
  return chip;
}

function renderChips(): void {
  const box = must("chips");
  clearNode(box);
  if (ws.workMode !== "local") {
    box.appendChild(
      makeChip("monitor", workModeLabel(), null, "Çalışma modunu kaldır", () => {
        ws.workMode = "local";
        persist();
        renderChips();
        updateComposer();
      }),
    );
  }
  const manager = ws.managers.find((m) => m.id === ws.selectedManagerId);
  if (manager) {
    box.appendChild(
      makeChip("bot", "SubAgent", manager.name, manager.name + " seçimini kaldır", () => {
        ws.selectedManagerId = null;
        persist();
        renderManagers();
        renderChips();
        updateComposer();
      }),
    );
  }
  for (const skill of selectedSkills()) {
    box.appendChild(
      makeChip("sparkles", skill.name, null, skill.name + " yeteneğini kaldır", () => {
        ws.selectedSkillIds = ws.selectedSkillIds.filter((id) => id !== skill.id);
        persist();
        renderChips();
        refreshSelectionViews();
      }),
    );
  }
  for (const connector of selectedConnectors()) {
    box.appendChild(
      makeChip("plug", connector.name, null, connector.name + " bağlayıcısını kaldır", () => {
        ws.selectedConnectorIds = ws.selectedConnectorIds.filter((id) => id !== connector.id);
        persist();
        renderChips();
        refreshSelectionViews();
      }),
    );
  }
  if (ws.planMode !== "standard") {
    box.appendChild(
      makeChip("list-check", "Plan", planLabel(), "Plan tercihini kaldır", () => {
        ws.planMode = "standard";
        persist();
        renderChips();
        updateComposer();
      }),
    );
  }
  if (ws.terminalMode === "suggest") {
    box.appendChild(
      makeChip("terminal", "Terminal", "komut önerisi", "Terminal tercihini kaldır", () => {
        ws.terminalMode = "off";
        persist();
        renderChips();
        updateComposer();
      }),
    );
  }
  for (const file of attachments) {
    box.appendChild(
      makeChip(file.name.match(/\.(png|jpe?g|gif|webp|bmp|svg)$/i) ? "image" : "paperclip", file.name, VyronModel.formatFileSize(file.size), file.name + " ekini kaldır", () => {
        attachments = attachments.filter((a) => a.id !== file.id);
        renderChips();
        updateComposer();
      }),
    );
  }
  if (attachments.length > 0) box.appendChild(make("span", "chip-note", ATTACHMENT_NOTE));
}

function refreshSelectionViews(): void {
  updateComposer();
  if (ws.view === "skills") renderSkillsPage();
  if (ws.view === "connectors") renderConnectorsPage();
}

function currentDraftProblem(): WsDraftProblem {
  const raw = must<HTMLTextAreaElement>("task-input").value;
  const base = VyronModel.draftProblem(raw);
  if (base !== "ok") return base;
  return VyronModel.draftProblem(composedPrompt(raw));
}

function updateComposer(): void {
  const input = must<HTMLTextAreaElement>("task-input");
  const problem = currentDraftProblem();
  const send = must<HTMLButtonElement>("send-btn");
  const composer = must("composer");
  const canSend = problem === "ok" && aiPhase === "ready" && !sendInFlight;

  send.disabled = !canSend;
  const state = sendInFlight ? "sending" : canSend ? "ready" : "disabled";
  composer.dataset.state = state;
  send.setAttribute("aria-label", sendInFlight ? "Gönderiliyor" : "Gönder");
  send.setAttribute("aria-busy", sendInFlight ? "true" : "false");

  let message = "";
  if (problem === "too_long") message = DRAFT_TOO_LONG_TEXT;
  else if (problem === "invalid") message = DRAFT_INVALID_TEXT;
  else if (problem === "ok" && aiPhase !== "ready") message = WAIT_FOR_AI_TEXT;
  const error = must("composer-error");
  error.textContent = message;
  error.hidden = message.length === 0;

  setText("mode-label", workModeLabel());
  const active = VyronModel.findProject(ws, ws.activeProjectId);
  setText("project-label", active ? active.name : "Proje seç veya oluştur");
  setText("plan-label", planLabel());

  must("skills-btn").classList.toggle("has-selection", ws.selectedSkillIds.length > 0);
  must("connectors-btn").classList.toggle("has-selection", selectedConnectors().length > 0);
  autosize(input);
}

function autosize(input: HTMLTextAreaElement): void {
  input.style.height = "auto";
  const height = Math.min(input.scrollHeight, 300);
  if (height > 0) input.style.height = String(height) + "px";
}

function currentTurns(): Turn[] {
  if (!ws.activeTaskId) return [];
  return turnsByTask.get(ws.activeTaskId) ?? [];
}

function renderTaskView(): void {
  const view = must("view-new-task");
  const task = VyronModel.findTask(ws, ws.activeTaskId);
  const inConversation = task !== null;
  view.dataset.mode = inConversation ? "conversation" : "empty";
  must("hero").hidden = inConversation;
  must("conversation").hidden = !inConversation;
  renderChips();
  updateComposer();
  if (!task) {
    clearNode(must("turns"));
    must("clear-response-btn").hidden = true;
    return;
  }

  const project = VyronModel.findProject(ws, task.projectId);
  setText("conversation-heading", "Yeni görev / " + (project ? project.name : "Projesiz") + " / " + task.title);
  const turnsBox = must("turns");
  clearNode(turnsBox);
  const turns = currentTurns();
  if (turns.length === 0) {
    turnsBox.appendChild(make("p", "turn-note", NO_ANSWER_TEXT));
  }
  for (const turn of turns) turnsBox.appendChild(renderTurn(turn));
  const last = turns[turns.length - 1];
  const canClear = last !== undefined && last.status === "done" && !last.cleared;
  must("clear-response-btn").hidden = !canClear;
  const scroller = must("task-scroll");
  scroller.scrollTop = scroller.scrollHeight;
}

function renderTurn(turn: Turn): HTMLElement {
  const wrap = make("div", "turn");
  wrap.dataset.turnId = turn.id;

  const user = make("div", "user-block");
  user.appendChild(make("div", "block-label", "Görev"));
  user.appendChild(make("div", "user-text", turn.prompt));
  if (turn.labels.length > 0) {
    const chips = make("div", "turn-chips");
    for (const label of turn.labels) chips.appendChild(make("span", "turn-chip", label));
    user.appendChild(chips);
  }
  wrap.appendChild(user);

  if (turn.status === "running") {
    const working = make("div", "working");
    working.setAttribute("role", "status");
    working.appendChild(makeIcon("spinner"));
    working.appendChild(make("span", "", WORKING_TEXT));
    wrap.appendChild(working);
  } else if (turn.status === "error") {
    const box = make("div", "turn-error");
    box.setAttribute("role", "alert");
    box.appendChild(make("span", "", turn.errorText ?? FAILURE_TEXT));
    box.appendChild(makeButton("btn small", "Tekrar dene", () => void retryTurn(turn)));
    wrap.appendChild(box);
  } else if (turn.cleared) {
    wrap.appendChild(make("p", "turn-note", CLEARED_TEXT));
  } else if (turn.text !== null) {
    const block = make("section", "assistant-block");
    block.setAttribute("aria-label", "Yanıt");
    block.appendChild(make("div", "block-label", "Yanıt"));
    appendResponse(block, turn.text);
    if (turn.truncated) block.appendChild(make("p", "truncated-note", "Yanıt kısaltıldı."));
    wrap.appendChild(block);
  }
  return wrap;
}

function appendResponse(container: HTMLElement, text: string): void {
  for (const block of VyronModel.parseResponse(text)) {
    if (block.kind === "paragraph") {
      container.appendChild(make("p", "", block.text));
    } else if (block.kind === "code") {
      const pre = make("pre");
      pre.appendChild(make("code", "", block.text));
      container.appendChild(pre);
    } else {
      const list = make(block.ordered ? "ol" : "ul");
      for (const item of block.items) list.appendChild(make("li", "", item));
      container.appendChild(list);
    }
  }
}

function newTurnId(): string {
  return VyronModel.newId("turn");
}

async function sendCurrent(): Promise<void> {
  if (sendInFlight) return;
  const input = must<HTMLTextAreaElement>("task-input");
  const raw = input.value;
  if (currentDraftProblem() !== "ok" || aiPhase !== "ready") {
    updateComposer();
    return;
  }
  const composed = composedPrompt(raw);
  let task = VyronModel.findTask(ws, ws.activeTaskId);
  if (!task) {
    task = VyronModel.createTask(ws, ws.activeProjectId, raw);
    ws.activeTaskId = task.id;
    const project = VyronModel.findProject(ws, task.projectId);
    if (project) project.expanded = true;
  }
  const turn: Turn = {
    id: newTurnId(),
    prompt: raw,
    composed,
    labels: selectionLabels(),
    agent: selectedAgent(),
    project: ws.activeProjectId,
    status: "running",
    text: null,
    truncated: false,
    errorText: null,
    cleared: false,
  };
  const turns = turnsByTask.get(task.id) ?? [];
  turns.push(turn);
  turnsByTask.set(task.id, turns);
  input.value = "";
  attachments = [];
  persist();
  sendInFlight = true;
  renderSidebar();
  renderTaskView();
  await runTurn(task.id, turn);
}

async function runTurn(taskId: string, turn: Turn): Promise<void> {
  sendInFlight = true;
  turn.status = "running";
  turn.errorText = null;
  refreshIfActive(taskId);
  const api = window.vyronDesktop;
  let result: HermesTaskSubmissionState | null = null;
  if (api) {
    try {
      result = await api.hermes.sendTask(taskRequest(turn));
    } catch {
      result = null;
    }
  }
  sendInFlight = false;
  if (result && result.state === "completed" && typeof result.text === "string") {
    turn.status = "done";
    turn.text = result.text;
    turn.truncated = result.truncated === true;
  } else {
    turn.status = "error";
    const notReady = result !== null && (result.state === "unauthorized" || result.state === "unavailable");
    turn.errorText = notReady ? NOT_READY_TEXT : FAILURE_TEXT;
    if (notReady || result === null) startPolling();
  }
  refreshIfActive(taskId);
}

/** The direct request, or (for a Manager with a Ruflo role) the request that also carries its role and project. */
function taskRequest(turn: Turn): HermesTaskRequest {
  if (!turn.agent) return { draft: turn.composed };
  const project = turn.project;
  if (project !== null && /^[a-z0-9][a-z0-9-]{0,79}$/.test(project)) return { draft: turn.composed, agent: turn.agent, project };
  return { draft: turn.composed, agent: turn.agent };
}

function refreshIfActive(taskId: string): void {
  if (ws.view === "new-task" && ws.activeTaskId === taskId) renderTaskView();
  else updateComposer();
}

async function retryTurn(turn: Turn): Promise<void> {
  if (sendInFlight || !ws.activeTaskId) return;
  await runTurn(ws.activeTaskId, turn);
}

function handleNewTask(): void {
  bestEffortClearTask();
  ws.activeTaskId = null;
  persist();
  showView("new-task");
  focusSoon(el("task-input"));
}

function handleClearResponse(): void {
  const turns = currentTurns();
  const last = turns[turns.length - 1];
  if (!last || last.status !== "done" || sendInFlight) return;
  last.cleared = true;
  last.text = null;
  last.truncated = false;
  bestEffortClearTask();
  renderTaskView();
  focusSoon(el("task-input"));
}

function onTaskInputKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void sendCurrent();
  }
}

// ---------------------------------------------------------------------------------------------
// Composer menus: work mode, project, +, SubAgent, Plan, Terminal
// ---------------------------------------------------------------------------------------------

function openModeMenu(trigger: HTMLElement): void {
  openMenuWith("mode", trigger, (menu) => {
    menu.setAttribute("aria-label", "Çalışma modu");
    for (const mode of VyronModel.WORK_MODES) {
      menu.appendChild(
        makeMenuItem({
          label: mode.label,
          sub: mode.description,
          role: "menuitemradio",
          checked: ws.workMode === mode.id,
          onSelect: () => {
            ws.workMode = mode.id;
            persist();
            renderChips();
            updateComposer();
          },
        }),
      );
    }
  });
}

function openNameForm(id: string, trigger: HTMLElement, options: { title: string; placeholder: string; submit: string; withDescription?: boolean; withRole?: boolean; onSubmit: (name: string, description: string, role: string) => boolean }): void {
  closeAllMenus(false);
  const panel = make("div", "menu panel-form");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", options.title);
  const form = make("form", "menu-form");
  form.appendChild(make("div", "menu-heading", options.title));
  const name = make("input", "text-input");
  name.type = "text";
  name.maxLength = 40;
  name.autocomplete = "off";
  name.placeholder = options.placeholder;
  name.setAttribute("aria-label", options.placeholder);
  form.appendChild(name);
  let description: HTMLInputElement | null = null;
  if (options.withDescription) {
    description = make("input", "text-input");
    description.type = "text";
    description.maxLength = 140;
    description.autocomplete = "off";
    description.placeholder = "Kısa açıklama (isteğe bağlı)";
    description.setAttribute("aria-label", "Kısa açıklama");
    form.appendChild(description);
  }
  let role: HTMLSelectElement | null = null;
  if (options.withRole) {
    role = make("select", "text-input");
    role.setAttribute("aria-label", "Çalışma rolü (Ruflo)");
    for (const entry of VyronModel.AGENT_ROLES) {
      const option = make("option", "", "Ruflo · " + entry.label);
      option.value = entry.id;
      role.appendChild(option);
    }
    form.appendChild(role);
  }
  const error = make("p", "form-error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  form.appendChild(error);
  const actions = make("div", "menu-form-actions");
  actions.appendChild(makeButton("btn ghost small", "Vazgeç", () => closeAllMenus(true)));
  const submit = make("button", "btn primary small", options.submit);
  submit.type = "submit";
  actions.appendChild(submit);
  form.appendChild(actions);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const ok = options.onSubmit(name.value, description ? description.value : "", role ? role.value : "");
    if (ok) {
      closeAllMenus(true);
    } else {
      error.textContent = "Geçerli bir ad yaz.";
      error.hidden = false;
      name.focus();
    }
  });
  panel.appendChild(form);
  openFloating(id, trigger, panel, 0, "below");
  name.focus();
}

function openProjectCreate(trigger: HTMLElement): void {
  openNameForm("project-create", trigger, {
    title: "Yeni proje",
    placeholder: "Proje adı",
    submit: "Oluştur",
    onSubmit: (rawName) => {
      const project = VyronModel.createProject(ws, rawName);
      if (!project) return false;
      ws.activeProjectId = project.id;
      ws.activeTaskId = null;
      ws.sidebarTab = "projects";
      persist();
      if (ws.view !== "new-task") showView("new-task");
      else renderAll();
      return true;
    },
  });
}

function openProjectMenu(trigger: HTMLElement): void {
  openMenuWith("project", trigger, (menu) => {
    menu.setAttribute("aria-label", "Proje seç");
    menu.appendChild(
      makeMenuItem({
        label: "Projesiz",
        role: "menuitemradio",
        checked: ws.activeProjectId === null,
        onSelect: () => selectProject(null),
      }),
    );
    for (const project of ws.projects) {
      menu.appendChild(
        makeMenuItem({
          label: project.name,
          icon: "folder",
          role: "menuitemradio",
          checked: ws.activeProjectId === project.id,
          onSelect: () => selectProject(project.id),
        }),
      );
    }
    menu.appendChild(makeSeparator());
    menu.appendChild(
      makeMenuItem({
        label: "Yeni proje oluştur",
        icon: "folder-plus",
        onSelect: () => {
          // Reopen as an inline form once this menu has closed; the trigger stays the project selector.
          window.setTimeout(() => openProjectCreate(must("project-btn")), 0);
        },
      }),
    );
  });
}

function openPlanSubmenu(item: HTMLButtonElement): void {
  openMenuWith(
    "plan-sub",
    item,
    (menu) => {
      menu.setAttribute("aria-label", "Plan");
      for (const mode of VyronModel.PLAN_MODES) {
        menu.appendChild(
          makeMenuItem({
            label: mode.label,
            sub: mode.description,
            role: "menuitemradio",
            checked: ws.planMode === mode.id,
            onSelect: () => setPlanMode(mode.id),
          }),
        );
      }
    },
    1,
    "right",
  );
}

function openTerminalSubmenu(item: HTMLButtonElement): void {
  openMenuWith(
    "terminal-sub",
    item,
    (menu) => {
      menu.setAttribute("aria-label", "Terminal");
      for (const mode of VyronModel.TERMINAL_MODES) {
        menu.appendChild(
          makeMenuItem({
            label: mode.label,
            sub: mode.description,
            role: "menuitemradio",
            checked: ws.terminalMode === mode.id,
            onSelect: () => {
              ws.terminalMode = mode.id;
              persist();
              renderChips();
              updateComposer();
            },
          }),
        );
      }
    },
    1,
    "right",
  );
}

function openSubAgentSubmenu(item: HTMLButtonElement): void {
  openMenuWith(
    "subagent-sub",
    item,
    (menu) => {
      menu.setAttribute("aria-label", "SubAgent");
      menu.appendChild(
        makeMenuItem({
          label: "SubAgent kullanma",
          role: "menuitemradio",
          checked: ws.selectedManagerId === null,
          onSelect: () => setManager(null),
        }),
      );
      for (const manager of ws.managers) {
        menu.appendChild(
          makeMenuItem({
            label: manager.name,
            sub: manager.tag,
            role: "menuitemradio",
            checked: ws.selectedManagerId === manager.id,
            onSelect: () => setManager(manager.id),
          }),
        );
      }
    },
    1,
    "right",
  );
}

function setManager(id: string | null): void {
  ws.selectedManagerId = id;
  persist();
  renderManagers();
  renderChips();
  updateComposer();
  if (ws.view === "manager") renderManagerDetail();
}

function setPlanMode(mode: WsPlanMode): void {
  ws.planMode = mode;
  persist();
  renderChips();
  updateComposer();
}

function openPlusMenu(trigger: HTMLElement): void {
  openMenuWith("plus", trigger, (menu) => {
    menu.setAttribute("aria-label", "Ekle");
    menu.appendChild(
      makeMenuItem({
        label: "Resim veya dosya ekle",
        icon: "paperclip",
        onSelect: () => must<HTMLInputElement>("file-input").click(),
      }),
    );
    menu.appendChild(makeMenuItem({ label: "SubAgent", icon: "bot", submenu: openSubAgentSubmenu }));
    menu.appendChild(makeMenuItem({ label: "Plan", icon: "list-check", submenu: openPlanSubmenu }));
    menu.appendChild(makeMenuItem({ label: "Terminal", icon: "terminal", submenu: openTerminalSubmenu }));
  });
}

function openPlanMenu(trigger: HTMLElement): void {
  openMenuWith("plan", trigger, (menu) => {
    menu.setAttribute("aria-label", "Çalışma tercihi");
    for (const mode of VyronModel.PLAN_MODES) {
      menu.appendChild(
        makeMenuItem({
          label: mode.label,
          sub: mode.description,
          role: "menuitemradio",
          checked: ws.planMode === mode.id,
          onSelect: () => setPlanMode(mode.id),
        }),
      );
    }
  });
}

function handleFilesChosen(): void {
  const input = must<HTMLInputElement>("file-input");
  const files = input.files ? Array.from(input.files) : [];
  for (const file of files) {
    if (attachments.length >= MAX_ATTACHMENTS) break;
    if (attachments.some((a) => a.name === file.name && a.size === file.size)) continue;
    attachments.push({ id: VyronModel.newId("file"), name: file.name.slice(0, 120), size: file.size });
  }
  input.value = "";
  renderChips();
  updateComposer();
}

// ---------------------------------------------------------------------------------------------
// Skills picker + page
// ---------------------------------------------------------------------------------------------

/** Remembers which list entry (by data attribute) holds focus so a re-render can give it back. */
function focusedDataId(container: HTMLElement, key: string): string | null {
  const active = document.activeElement as HTMLElement | null;
  if (!active || !container.contains(active)) return null;
  let node: HTMLElement | null = active;
  while (node && node !== container) {
    const value = node.dataset[key];
    if (value) return value;
    node = node.parentElement;
  }
  return null;
}

function restoreFocus(container: HTMLElement, key: string, id: string | null): void {
  if (id === null) return;
  const all = Array.from(container.querySelectorAll<HTMLElement>("[data-" + key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()) + "]"));
  const holder = all.find((node) => node.dataset[key] === id);
  if (!holder) return;
  const target = holder.matches("button") ? holder : holder.querySelector<HTMLElement>("button");
  if (target) target.focus();
}

function skillRow(skill: WsSkill, onToggle: () => void): HTMLButtonElement {
  const selected = ws.selectedSkillIds.indexOf(skill.id) >= 0;
  const row = make("button", "picker-row");
  row.type = "button";
  row.setAttribute("aria-pressed", selected ? "true" : "false");
  row.dataset.skillId = skill.id;
  const icon = make("span", "row-icon");
  icon.appendChild(makeIcon(skill.icon));
  row.appendChild(icon);
  row.appendChild(make("span", "picker-name", skill.name));
  row.appendChild(make("span", "tag", skill.tag));
  const check = make("span", "picker-check");
  if (selected) check.appendChild(makeIcon("check"));
  row.appendChild(check);
  row.addEventListener("click", onToggle);
  return row;
}

function toggleSkill(id: string): void {
  ws.selectedSkillIds = VyronModel.toggleId(ws.selectedSkillIds, id);
  persist();
  renderChips();
  refreshSelectionViews();
}

function makePanel(label: string, placeholder: string, onQuery: (query: string) => void): { panel: HTMLElement; list: HTMLElement; search: HTMLInputElement; foot: HTMLElement } {
  const panel = make("div", "panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", label);
  const searchWrap = make("div", "panel-search");
  searchWrap.appendChild(makeIcon("search"));
  const search = make("input");
  search.type = "search";
  search.autocomplete = "off";
  search.placeholder = placeholder;
  search.setAttribute("aria-label", placeholder);
  search.addEventListener("input", () => onQuery(search.value));
  searchWrap.appendChild(search);
  panel.appendChild(searchWrap);
  const list = make("div", "panel-list");
  panel.appendChild(list);
  const foot = make("div", "panel-foot");
  panel.appendChild(foot);
  return { panel, list, search, foot };
}

function openSkillsPicker(trigger: HTMLElement): void {
  let query = "";
  const parts = makePanel("Yetenekler", "Beceri ara", (value) => {
    query = value;
    fill();
  });
  const fill = () => {
    const focusedId = focusedDataId(parts.list, "skillId");
    clearNode(parts.list);
    const matches = VyronModel.SKILLS.filter((s) => VyronModel.matchesQuery(query, s.name, s.tag, s.description, s.category));
    if (matches.length === 0) {
      parts.list.appendChild(make("p", "panel-empty", "Sonuç bulunamadı."));
      return;
    }
    const categories: string[] = [];
    for (const skill of matches) if (categories.indexOf(skill.category) < 0) categories.push(skill.category);
    for (const category of categories) {
      parts.list.appendChild(make("div", "menu-heading", category));
      for (const skill of matches.filter((s) => s.category === category)) {
        parts.list.appendChild(
          skillRow(skill, () => {
            toggleSkill(skill.id);
            fill();
          }),
        );
      }
    }
    restoreFocus(parts.list, "skillId", focusedId);
  };
  fill();
  const findMore = make("button", "menu-item panel-focusable", "");
  findMore.type = "button";
  findMore.appendChild(makeIcon("plus"));
  findMore.appendChild(make("span", "menu-label", "Yetenek Ara"));
  findMore.addEventListener("click", () => {
    closeAllMenus(false);
    navigate("skills", "skills-search");
  });
  parts.foot.appendChild(findMore);
  openFloating("skills", trigger, parts.panel, 0, "below");
  parts.search.focus();
}

function renderSkillsPage(): void {
  const list = must("skills-page-list");
  clearNode(list);
  const matches = VyronModel.SKILLS.filter((s) => VyronModel.matchesQuery(skillsQuery, s.name, s.tag, s.description, s.category));
  for (const skill of matches) {
    const selected = ws.selectedSkillIds.indexOf(skill.id) >= 0;
    const row = make("div", "row");
    row.dataset.skillId = skill.id;
    const icon = make("span", "row-icon");
    icon.appendChild(makeIcon(skill.icon));
    row.appendChild(icon);
    const body = make("div", "row-body");
    const title = make("div", "row-title");
    title.appendChild(make("span", "", skill.name));
    title.appendChild(make("span", "tag", skill.tag));
    body.appendChild(title);
    body.appendChild(make("div", "row-desc", skill.description));
    row.appendChild(body);
    const actions = make("div", "row-actions");
    const toggle = makeButton(selected ? "btn primary small" : "btn small", selected ? "Kullanılıyor" : "Kullan", () => toggleSkill(skill.id));
    toggle.setAttribute("aria-pressed", selected ? "true" : "false");
    toggle.setAttribute("aria-label", skill.name + (selected ? " kullanılıyor, kaldırmak için seç" : " yeteneğini kullan"));
    actions.appendChild(toggle);
    row.appendChild(actions);
    list.appendChild(row);
  }
  must("skills-page-empty").hidden = matches.length > 0;
  setText("skills-count", ws.selectedSkillIds.length === 0 ? "Seçili yetenek yok" : String(ws.selectedSkillIds.length) + " yetenek seçili");
}

// ---------------------------------------------------------------------------------------------
// Connectors picker + page
// ---------------------------------------------------------------------------------------------

function connectorStatusText(status: WsConnectorStatus): string {
  if (status === "connected") return "Bağlı";
  if (status === "pending") return "Yetkilendirme bekliyor";
  return "Bağlı değil";
}

function beginConnect(id: string): void {
  VyronModel.setConnectorStatus(ws, id, "pending");
  persist();
  refreshConnectorViews();
}

function confirmConnect(id: string): void {
  VyronModel.setConnectorStatus(ws, id, "connected");
  persist();
  refreshConnectorViews();
}

function cancelConnect(id: string): void {
  VyronModel.setConnectorStatus(ws, id, "disconnected");
  persist();
  refreshConnectorViews();
}

function toggleConnectorUse(id: string): void {
  ws.selectedConnectorIds = VyronModel.toggleId(ws.selectedConnectorIds, id);
  persist();
  renderChips();
  refreshConnectorViews();
}

let connectorPanelRefresh: (() => void) | null = null;

function refreshConnectorViews(): void {
  renderChips();
  updateComposer();
  if (ws.view === "connectors") renderConnectorsPage();
  if (connectorPanelRefresh && isMenuOpen("connectors")) connectorPanelRefresh();
}

function openConnectorsPicker(trigger: HTMLElement): void {
  let query = "";
  const parts = makePanel("Bağlayıcılar", "Bağlayıcıları ara", (value) => {
    query = value;
    fill();
  });
  const fill = () => {
    const focusedId = focusedDataId(parts.list, "connectorId");
    clearNode(parts.list);
    const matches = ws.connectors.filter((c) => VyronModel.matchesQuery(query, c.name, c.description));
    if (matches.length === 0) {
      parts.list.appendChild(make("p", "panel-empty", "Sonuç bulunamadı."));
      return;
    }
    for (const connector of matches) {
      const wrap = make("div", "picker-row-wrap");
      wrap.dataset.connectorId = connector.id;
      const selected = ws.selectedConnectorIds.indexOf(connector.id) >= 0;
      const main = make("button", "picker-row");
      main.type = "button";
      const icon = make("span", "row-icon");
      icon.appendChild(makeIcon(connector.icon));
      main.appendChild(icon);
      main.appendChild(make("span", "picker-name", connector.name));
      if (connector.status === "connected") {
        main.setAttribute("aria-pressed", selected ? "true" : "false");
        main.appendChild(make("span", "tag", "Bağlı"));
        const check = make("span", "picker-check");
        if (selected) check.appendChild(makeIcon("check"));
        main.appendChild(check);
        main.addEventListener("click", () => toggleConnectorUse(connector.id));
        wrap.appendChild(main);
      } else {
        main.disabled = false;
        main.addEventListener("click", () => (connector.status === "pending" ? confirmConnect(connector.id) : beginConnect(connector.id)));
        wrap.appendChild(main);
        const action = makeButton("btn small picker-action", connector.status === "pending" ? "Onayla" : "Bağlan", () =>
          connector.status === "pending" ? confirmConnect(connector.id) : beginConnect(connector.id),
        );
        action.setAttribute("aria-label", connector.name + (connector.status === "pending" ? " bağlantısını onayla" : " hizmetine bağlan"));
        action.classList.add("panel-focusable");
        wrap.appendChild(action);
      }
      parts.list.appendChild(wrap);
    }
    restoreFocus(parts.list, "connectorId", focusedId);
  };
  fill();
  connectorPanelRefresh = fill;
  const addRow = make("button", "menu-item panel-focusable");
  addRow.type = "button";
  addRow.appendChild(makeIcon("plus"));
  addRow.appendChild(make("span", "menu-label", "Bağlayıcı Ekle"));
  const arrow = make("span", "menu-arrow");
  arrow.appendChild(makeIcon("chevron-right"));
  addRow.appendChild(arrow);
  addRow.addEventListener("click", () => {
    closeAllMenus(false);
    navigate("connectors");
    openConnectorAddForm(true);
  });
  const manageRow = make("button", "menu-item panel-focusable");
  manageRow.type = "button";
  manageRow.appendChild(makeIcon("settings"));
  manageRow.appendChild(make("span", "menu-label", "Bağlayıcıları Yönet"));
  manageRow.addEventListener("click", () => {
    closeAllMenus(false);
    navigate("connectors", "connectors-search");
  });
  parts.foot.appendChild(addRow);
  parts.foot.appendChild(manageRow);
  openFloating("connectors", trigger, parts.panel, 0, "below");
  parts.search.focus();
}

function openConnectorAddForm(open: boolean): void {
  const form = must("connector-add-form");
  form.hidden = !open;
  must("connector-add-toggle").setAttribute("aria-expanded", open ? "true" : "false");
  if (open) focusSoon(el("connector-add-name"));
}

function renderConnectorsPage(): void {
  const list = must("connectors-page-list");
  clearNode(list);
  const matches = ws.connectors.filter((c) => VyronModel.matchesQuery(connectorsQuery, c.name, c.description));
  for (const connector of matches) {
    const row = make("div", "row wrap");
    row.dataset.connectorId = connector.id;
    const icon = make("span", "row-icon");
    icon.appendChild(makeIcon(connector.icon));
    row.appendChild(icon);
    const body = make("div", "row-body");
    const title = make("div", "row-title");
    title.appendChild(make("span", "", connector.name));
    if (connector.status !== "disconnected") title.appendChild(make("span", "badge " + connector.status, connectorStatusText(connector.status)));
    body.appendChild(title);
    body.appendChild(make("div", "row-desc", connector.description));
    row.appendChild(body);
    const actions = make("div", "row-actions");
    if (connector.status === "disconnected") {
      actions.appendChild(makeButton("btn small primary", "Bağlan", () => beginConnect(connector.id)));
    } else if (connector.status === "pending") {
      actions.appendChild(makeButton("btn small primary", "Bağlantıyı onayla", () => confirmConnect(connector.id)));
      actions.appendChild(makeButton("btn small ghost", "Vazgeç", () => cancelConnect(connector.id)));
    } else {
      const used = ws.selectedConnectorIds.indexOf(connector.id) >= 0;
      const use = makeButton(used ? "btn small primary" : "btn small", used ? "Görevlerde kullanılıyor" : "Görevlerde kullan", () => toggleConnectorUse(connector.id));
      use.setAttribute("aria-pressed", used ? "true" : "false");
      actions.appendChild(use);
      actions.appendChild(makeButton("btn small ghost", "Bağlantıyı kes", () => cancelConnect(connector.id)));
    }
    if (connector.custom) {
      const remove = makeButton("btn small ghost", "Kaldır", () => {
        VyronModel.removeConnector(ws, connector.id);
        persist();
        refreshConnectorViews();
      });
      remove.setAttribute("aria-label", connector.name + " bağlayıcısını kaldır");
      actions.appendChild(remove);
    }
    row.appendChild(actions);
    if (connector.status === "pending") {
      row.appendChild(make("p", "pending-note", "Bu hizmet hesap yetkilendirmesi gerektirir. Yetkilendirmeyi hizmetin kendi sayfasında tamamladıktan sonra bağlantıyı onayla; bu sürüm yalnızca yerel bağlantı kaydını tutar."));
    }
    list.appendChild(row);
  }
  must("connectors-page-empty").hidden = matches.length > 0;
}

// ---------------------------------------------------------------------------------------------
// Web sites, managers, settings
// ---------------------------------------------------------------------------------------------

function renderSitesPage(): void {
  const list = must("sites-list");
  clearNode(list);
  for (const site of ws.sites) {
    const row = make("div", "row");
    row.dataset.siteId = site.id;
    const icon = make("span", "row-icon");
    icon.appendChild(makeIcon("globe"));
    row.appendChild(icon);
    const body = make("div", "row-body");
    body.appendChild(make("div", "row-title", site.name));
    body.appendChild(make("div", "row-desc", site.address));
    row.appendChild(body);
    const actions = make("div", "row-actions");
    actions.appendChild(
      makeButton("btn small primary", "Görev başlat", () => {
        ws.activeTaskId = null;
        persist();
        showView("new-task");
        const input = must<HTMLTextAreaElement>("task-input");
        input.value = site.name + " (" + site.address + ") sitesi için: ";
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        updateComposer();
      }),
    );
    const remove = makeButton("btn small ghost", "Kaldır", () => {
      VyronModel.removeSite(ws, site.id);
      persist();
      renderSitesPage();
    });
    remove.setAttribute("aria-label", site.name + " sitesini kaldır");
    actions.appendChild(remove);
    row.appendChild(actions);
    list.appendChild(row);
  }
  must("sites-empty").hidden = ws.sites.length > 0;
}

function renderManagerDetail(): void {
  const box = must("manager-detail");
  clearNode(box);
  const manager = ws.managers.find((m) => m.id === managerViewId);
  if (!manager) {
    box.appendChild(make("p", "empty-note", "Manager seçilmedi."));
    return;
  }
  const selected = ws.selectedManagerId === manager.id;
  const head = make("div", "detail-head");
  const avatar = make("span", "row-icon");
  avatar.appendChild(makeIcon("bot"));
  head.appendChild(avatar);
  head.appendChild(make("h2", "detail-title", manager.name));
  box.appendChild(head);
  box.appendChild(make("p", "detail-desc", manager.description));
  const meta = make("div", "detail-meta");
  meta.appendChild(make("span", "tag", manager.tag));
  meta.appendChild(make("span", "tag", agentLabel(manager.agent)));
  meta.appendChild(make("span", "badge connected", "Hazır"));
  if (selected) meta.appendChild(make("span", "tag", "Görevlerde seçili"));
  box.appendChild(meta);
  const actions = make("div", "detail-actions");
  actions.appendChild(
    makeButton("btn primary", "Bu manager ile görev başlat", () => {
      setManager(manager.id);
      startTaskInProject(ws.activeProjectId);
    }),
  );
  actions.appendChild(makeButton("btn", selected ? "Seçimi kaldır" : "Görevlerde varsayılan yap", () => setManager(selected ? null : manager.id)));
  if (manager.custom) {
    actions.appendChild(
      makeButton("btn ghost", "Sil", () => {
        VyronModel.removeManager(ws, manager.id);
        persist();
        managerViewId = null;
        renderChips();
        showView("new-task");
      }),
    );
  }
  box.appendChild(actions);
}

function renderResetControls(): void {
  must("settings-reset-btn").hidden = resetConfirming;
  must("settings-reset-confirm").hidden = !resetConfirming;
  must("settings-reset-cancel").hidden = !resetConfirming;
}

let memoryConfirming = false;

function renderMemoryControls(): void {
  must("settings-memory-clear").hidden = memoryConfirming;
  must("settings-memory-confirm").hidden = !memoryConfirming;
  must("settings-memory-cancel").hidden = !memoryConfirming;
}

async function clearAgentMemory(): Promise<void> {
  memoryConfirming = false;
  renderMemoryControls();
  const api = window.vyronDesktop;
  let cleared = false;
  if (api) {
    try {
      cleared = (await api.app.clearAgentMemory()) === true;
    } catch {
      cleared = false;
    }
  }
  setText("settings-memory-status", cleared ? "Manager hafızası temizlendi." : "Manager hafızası temizlenemedi. Bir görev çalışıyorsa bitmesini bekleyip tekrar dene.");
  focusSoon(el("settings-memory-clear"));
}

function resetWorkspace(): void {
  ws = VyronModel.resetState(getStorage());
  turnsByTask.clear();
  attachments = [];
  managerViewId = null;
  sidebarQuery = "";
  skillsQuery = "";
  connectorsQuery = "";
  must<HTMLInputElement>("sidebar-search-input").value = "";
  must<HTMLInputElement>("skills-search").value = "";
  must<HTMLInputElement>("connectors-search").value = "";
  must<HTMLTextAreaElement>("task-input").value = "";
  resetConfirming = false;
  bestEffortClearTask();
  persist();
  renderAll();
  showView("new-task");
  focusSoon(el("task-input"));
}

// ---------------------------------------------------------------------------------------------
// Sidebar-level menus
// ---------------------------------------------------------------------------------------------

function openAppMenu(trigger: HTMLElement): void {
  openMenuWith("app", trigger, (menu) => {
    menu.setAttribute("aria-label", "Çalışma alanı menüsü");
    menu.appendChild(makeMenuItem({ label: "Yeni görev", icon: "plus-circle", onSelect: () => startTaskInProject(ws.activeProjectId) }));
    menu.appendChild(
      makeMenuItem({
        label: "Yeni proje oluştur",
        icon: "folder-plus",
        onSelect: () => window.setTimeout(() => openProjectCreate(must("add-project-btn")), 0),
      }),
    );
    menu.appendChild(makeMenuItem({ label: "Ayarlar", icon: "settings", onSelect: () => navigate("settings") }));
    menu.appendChild(makeSeparator());
    menu.appendChild(
      makeMenuItem({
        label: "Tüm projeleri daralt",
        icon: "chevron-down",
        onSelect: () => {
          for (const project of ws.projects) project.expanded = false;
          persist();
          renderProjects();
        },
      }),
    );
    menu.appendChild(
      makeMenuItem({
        label: "Tüm projeleri genişlet",
        icon: "chevron-right",
        onSelect: () => {
          for (const project of ws.projects) project.expanded = true;
          persist();
          renderProjects();
        },
      }),
    );
    menu.appendChild(makeSeparator());
    menu.appendChild(make("div", "menu-heading", "Görünüm"));
    menu.appendChild(makeMenuItem({ label: "Yeniden Yükle", icon: "refresh", onSelect: () => window.location.reload() }));
    menu.appendChild(makeMenuItem({ label: "Geliştirici Araçları", icon: "code", onSelect: () => toggleDevTools() }));
  });
}

function toggleDevTools(): void {
  const api = window.vyronDesktop;
  if (!api) return;
  try {
    void api.app.toggleDevTools().catch(() => undefined);
  } catch {
    // Developer tools are a convenience; a failure must never affect the workspace.
  }
}

function openAccountMenu(trigger: HTMLElement): void {
  openMenuWith("account", trigger, (menu) => {
    menu.setAttribute("aria-label", "Hesap menüsü");
    menu.appendChild(make("div", "menu-heading", "Yerel kullanıcı"));
    menu.appendChild(makeMenuItem({ label: "Ayarlar", icon: "settings", onSelect: () => navigate("settings") }));
    menu.appendChild(makeMenuItem({ label: "Yerel AI durumu", icon: "monitor", sub: STATUS_TEXT[aiPhase], onSelect: () => navigate("settings") }));
    menu.appendChild(makeSeparator());
    menu.appendChild(
      makeMenuItem({
        label: "Çalışma alanını sıfırla",
        icon: "trash",
        onSelect: () => {
          navigate("settings");
          resetConfirming = true;
          renderResetControls();
          focusSoon(el("settings-reset-confirm"));
        },
      }),
    );
  });
}

function openAddManager(trigger: HTMLElement): void {
  openNameForm("manager-create", trigger, {
    title: "Yeni manager",
    placeholder: "Manager adı",
    submit: "Oluştur",
    withDescription: true,
    withRole: true,
    onSubmit: (name, description, role) => {
      const manager = VyronModel.createManager(ws, name, description, role);
      if (!manager) return false;
      persist();
      openManager(manager.id);
      return true;
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------------

function renderAll(): void {
  renderSidebar();
  renderChips();
  renderTaskView();
  if (ws.view === "skills") renderSkillsPage();
  if (ws.view === "connectors") renderConnectorsPage();
  if (ws.view === "sites") renderSitesPage();
}

function on(id: string, type: string, listener: (event: Event) => void): void {
  const node = el(id);
  if (node) node.addEventListener(type, listener);
}

function wireRootTrigger(id: string, menuId: string, open: (trigger: HTMLElement) => void): void {
  const trigger = must(id);
  trigger.addEventListener("click", () => toggleRootMenu(menuId, trigger, () => open(trigger)));
}

function onDocumentPointerDown(event: Event): void {
  if (menus.length === 0) return;
  const target = event.target as Node | null;
  if (!target) return;
  const inside = menus.some((m) => m.el.contains(target) || m.trigger.contains(target));
  if (!inside) closeAllMenus(false);
}

function onDocumentKeydown(event: KeyboardEvent): void {
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === "k") {
    event.preventDefault();
    toggleSidebarSearch(true);
    return;
  }
  if (event.key === "Escape") {
    if (menus.length > 0) {
      closeAllMenus(true);
      return;
    }
    const search = el<HTMLInputElement>("sidebar-search-input");
    if (search && document.activeElement === search) toggleSidebarSearch(false);
  }
}

function wire(): void {
  wireRootTrigger("mode-btn", "mode", openModeMenu);
  wireRootTrigger("project-btn", "project", openProjectMenu);
  wireRootTrigger("plus-btn", "plus", openPlusMenu);
  wireRootTrigger("skills-btn", "skills", openSkillsPicker);
  wireRootTrigger("connectors-btn", "connectors", openConnectorsPicker);
  wireRootTrigger("plan-btn", "plan", openPlanMenu);
  wireRootTrigger("app-menu-btn", "app", openAppMenu);
  wireRootTrigger("account-btn", "account", openAccountMenu);
  wireRootTrigger("add-project-btn", "project-create", openProjectCreate);
  wireRootTrigger("add-manager-btn", "manager-create", openAddManager);

  on("task-input", "input", () => updateComposer());
  on("task-input", "keydown", (event) => onTaskInputKeydown(event as KeyboardEvent));
  on("send-btn", "click", () => void sendCurrent());
  on("file-input", "change", handleFilesChosen);
  on("new-task-btn", "click", handleNewTask);
  on("clear-response-btn", "click", handleClearResponse);

  on("tab-projects", "click", () => setSidebarTab("projects"));
  on("tab-managers", "click", () => setSidebarTab("managers"));
  on("sidebar-toggle-btn", "click", () => {
    ws.sidebarCollapsed = !ws.sidebarCollapsed;
    persist();
    applySidebarState();
  });
  on("sidebar-search-btn", "click", () => toggleSidebarSearch());
  on("sidebar-search-input", "input", () => {
    sidebarQuery = must<HTMLInputElement>("sidebar-search-input").value;
    renderProjects();
    renderManagers();
  });
  document.querySelectorAll<HTMLElement>(".nav-item[data-nav]").forEach((node) => {
    node.addEventListener("click", () => {
      const target = node.dataset.nav as WsNavView | undefined;
      if (!target) return;
      if (target === "new-task") startTaskInProject(ws.activeProjectId);
      else navigate(target);
    });
  });
  on("settings-btn", "click", () => navigate("settings"));

  on("skills-search", "input", () => {
    skillsQuery = must<HTMLInputElement>("skills-search").value;
    renderSkillsPage();
  });
  on("connectors-search", "input", () => {
    connectorsQuery = must<HTMLInputElement>("connectors-search").value;
    renderConnectorsPage();
  });
  on("connector-add-toggle", "click", () => openConnectorAddForm(must("connector-add-form").hidden));
  on("connector-add-form", "submit", (event) => {
    event.preventDefault();
    const name = must<HTMLInputElement>("connector-add-name");
    const desc = must<HTMLInputElement>("connector-add-desc");
    const created = VyronModel.createConnector(ws, name.value, desc.value);
    if (!created) {
      name.focus();
      return;
    }
    name.value = "";
    desc.value = "";
    persist();
    openConnectorAddForm(false);
    refreshConnectorViews();
  });
  on("site-add-form", "submit", (event) => {
    event.preventDefault();
    const name = must<HTMLInputElement>("site-add-name");
    const address = must<HTMLInputElement>("site-add-address");
    const created = VyronModel.createSite(ws, name.value, address.value);
    const error = must("site-add-error");
    if (!created) {
      error.textContent = "Geçerli bir web adresi yaz (örn. ornek.com).";
      error.hidden = false;
      address.focus();
      return;
    }
    error.hidden = true;
    name.value = "";
    address.value = "";
    persist();
    renderSitesPage();
  });

  on("ai-retry-btn", "click", () => void handleRetry());
  on("ai-copy-diagnostics-btn", "click", () => void handleCopyDiagnostics());
  on("settings-retry-btn", "click", () => void handleRetry());
  on("settings-copy-btn", "click", () => void handleCopyDiagnostics());
  on("settings-compact", "change", () => {
    ws.sidebarCollapsed = must<HTMLInputElement>("settings-compact").checked;
    persist();
    applySidebarState();
  });
  on("settings-reset-btn", "click", () => {
    resetConfirming = true;
    renderResetControls();
    focusSoon(el("settings-reset-confirm"));
  });
  on("settings-reset-cancel", "click", () => {
    resetConfirming = false;
    renderResetControls();
    focusSoon(el("settings-reset-btn"));
  });
  on("settings-reset-confirm", "click", resetWorkspace);
  on("settings-memory-clear", "click", () => {
    memoryConfirming = true;
    setText("settings-memory-status", "");
    renderMemoryControls();
    focusSoon(el("settings-memory-confirm"));
  });
  on("settings-memory-cancel", "click", () => {
    memoryConfirming = false;
    renderMemoryControls();
    focusSoon(el("settings-memory-clear"));
  });
  on("settings-memory-confirm", "click", () => void clearAgentMemory());

  document.addEventListener("mousedown", onDocumentPointerDown, true);
  document.addEventListener("keydown", onDocumentKeydown);
  window.addEventListener("resize", () => closeAllMenus(false));
}

function main(): void {
  hydrateIcons(document);
  ws = VyronModel.loadState(getStorage());
  renderQuickStarts();
  wire();
  showView("new-task");
  bestEffortClearTask();
  startPolling();
}

main();
