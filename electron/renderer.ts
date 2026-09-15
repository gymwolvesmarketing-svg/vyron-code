/**
 * Local renderer script — VYRON_CODE_V02_D02D_MINIMAL_LOCAL_RENDERER_AUTHORIZATION, extended
 * by VYRON_CODE_V02_D03_NATIVE_FOLDER_PICKER_AND_WORKSPACE_GRANT_AUTHORIZATION,
 * VYRON_CODE_V02_D03_PRELOAD_IPC_WIRING_FIX_AUTHORIZATION,
 * VYRON_CODE_V02_D03_NATIVE_FOLDER_PICKER_REAL_RUNTIME_DEFECT_ANALYSIS_AND_FIX,
 * VYRON_CODE_V02_D03_PRELOAD_BRIDGE_INJECTION_DIAGNOSTIC_AND_FIX_AUTHORIZATION, and
 * VYRON_CODE_V02_MILESTONE_A_RUNTIME_STABILITY_AND_READONLY_WORKSPACE_AUTHORIZATION.
 *
 * Reads the already-exposed, static `window.vyronDesktop` object (see electron/preload.ts)
 * and renders it via safe DOM construction (`createElement`/`textContent`, never
 * `innerHTML`). Every IPC call this file makes is one of the fixed
 * `window.vyronDesktop.workspace.*` methods, each triggered only by an explicit user action —
 * a button click, an Explorer row click, or a submitted Search query — never automatically,
 * and never with a user-typed absolute path (the Search box accepts only a query string, not
 * a path; the workspace root itself can only ever come from the native picker). No
 * `fetch`/network request (this page's own CSP forbids `connect-src` entirely), no direct
 * filesystem access, no write/save/terminal/Git-write control anywhere on this page.
 *
 * This file must have NO top-level `import`/`export` statement of any kind, not even
 * `import type` — see the D-03 preload/renderer module-format fix reports for why (TypeScript
 * emits a CommonJS wrapper for any file with an import/export declaration, which breaks this
 * file's load as a classic, non-module `<script src="…">`). All contract types are declared
 * locally below, mirroring `shared-ipc-contract.ts`'s real, canonical declarations — keep the
 * two in sync by hand if the contract changes.
 */
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

// VYRON_CODE_V02_D08B_MEMORY_ONLY_HERMES_AUTHORIZATION_BOUNDARY_AUTHORIZATION — mirrors
// shared-ipc-contract.ts's real, canonical declarations, per this file's own module-format
// constraint (see file-header comment). Carries no endpoint/host/port/session field anywhere.
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

// VYRON_CODE_V02_D08B_CHECKPOINT_AND_D08C_SAFE_HERMES_CONNECTIVITY_AUTHORIZATION (D-08C).
type HermesConnectionAmbientState =
  | "not_authorized"
  | "ready_to_connect"
  | "connecting"
  | "connected"
  | "disconnecting"
  | "disconnected"
  | "unavailable"
  | "safe_failure";

interface HermesConnectionState {
  readonly state: HermesConnectionAmbientState;
}

interface HermesConnectionResult {
  readonly state: HermesConnectionAmbientState;
}

// VYRON_CODE_V02_D08E_MEMORY_ONLY_HERMES_ENDPOINT_SETUP_AUTHORIZATION.
type HermesEndpointAmbientState = "not_configured" | "configured_memory_only";

interface HermesEndpointState {
  readonly state: HermesEndpointAmbientState;
}

interface HermesEndpointConfigurationRequest {
  readonly endpoint: string;
}

type HermesEndpointConfigurationOutcomeState =
  | "configured_memory_only"
  | "cleared"
  | "not_configured"
  | "policy_rejected"
  | "invalid_configuration"
  | "unavailable"
  | "safe_failure";

interface HermesEndpointConfigurationResult {
  readonly state: HermesEndpointConfigurationOutcomeState;
}

interface DesktopHermesApi {
  getAvailability(): Promise<HermesAvailability>;
  getAuthorizationState(): Promise<HermesAuthorizationState>;
  beginAuthorization(request: HermesAuthorizationRequest): Promise<HermesAuthorizationResult>;
  clearAuthorization(): Promise<HermesAuthorizationResult>;
  getConnectionState(): Promise<HermesConnectionState>;
  connect(): Promise<HermesConnectionResult>;
  disconnect(): Promise<HermesConnectionResult>;
  getEndpointConfigurationState(): Promise<HermesEndpointState>;
  configureEndpoint(request: HermesEndpointConfigurationRequest): Promise<HermesEndpointConfigurationResult>;
  clearEndpointConfiguration(): Promise<HermesEndpointConfigurationResult>;
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

interface Window {
  vyronDesktop?: DesktopApi;
}

const WORKSPACE_STATUS_TEXT: Record<WorkspaceGrantState["state"], string> = {
  no_workspace: "No workspace is selected.",
  granted: "", // rendered separately below (display name + read-only badge), never plain text
  denied: "That folder can't be used as a workspace.",
  cancelled: "No workspace is selected.",
  unavailable: "The folder picker is unavailable right now.",
};

type WorkspaceViewName = "explorer" | "search" | "git";

/**
 * One directory's own load state — distinguishable in the UI per
 * VYRON_CODE_V02_MILESTONE_A_READONLY_WORKSPACE_COMPLETION_AUTHORIZATION (Explorer must show
 * loading/empty/expanded/collapsed/inaccessible/unavailable states, not silently render every
 * failure as an empty folder).
 */
type ExplorerDirState =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly entries: readonly WorkspaceExplorerEntry[]; readonly truncated: boolean }
  | { readonly status: "empty" }
  | { readonly status: "inaccessible" }
  | { readonly status: "unavailable" };

// ---------------------------------------------------------------------------------------
// Explorer state — a lazily-populated cache of one-level directory listings, plus which
// directories are currently expanded. Reset on every new grant and on clear, so a prior
// workspace's data never bleeds into a newly selected one.
// ---------------------------------------------------------------------------------------
let explorerState = new Map<string, ExplorerDirState>();
let explorerExpanded = new Set<string>();
let selectedFileRelativePath: string | null = null;
let searchInFlight = false;

function resetWorkspaceViewState(): void {
  explorerState = new Map();
  explorerExpanded = new Set();
  selectedFileRelativePath = null;

  const tree = document.getElementById("explorer-tree");
  if (tree) tree.replaceChildren();

  renderFileViewerPlaceholder("Select a file to preview its contents.");

  searchInFlight = false;
  const searchInput = document.getElementById("search-input");
  if (searchInput instanceof HTMLInputElement) searchInput.value = "";
  const searchStatus = document.getElementById("search-status");
  if (searchStatus) searchStatus.textContent = "Enter a query and press Search.";
  const searchResults = document.getElementById("search-results");
  if (searchResults) searchResults.replaceChildren();
  const searchBtn = document.getElementById("search-btn");
  if (searchBtn instanceof HTMLButtonElement) searchBtn.disabled = false;

  const gitSummary = document.getElementById("git-summary");
  if (gitSummary) {
    gitSummary.replaceChildren();
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "Open this tab to load the Git summary.";
    gitSummary.append(p);
  }

  switchView("explorer");
}

function renderFileViewerPlaceholder(text: string): void {
  const viewer = document.getElementById("file-viewer");
  if (!viewer) return;
  viewer.replaceChildren();
  const p = document.createElement("p");
  p.className = "muted";
  p.textContent = text;
  viewer.append(p);
}

function renderWorkspaceState(result: WorkspaceGrantState): void {
  const statusEl = document.getElementById("workspace-status");
  const clearBtn = document.getElementById("clear-workspace-btn");
  const panel = document.getElementById("workspace-panel");
  if (!(statusEl instanceof HTMLElement) || !(clearBtn instanceof HTMLButtonElement)) return;

  statusEl.replaceChildren();
  if (result.state === "granted" && result.displayName) {
    const nameEl = document.createElement("strong");
    nameEl.textContent = result.displayName;
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "read-only";
    statusEl.append(nameEl, document.createTextNode(" "), badge);
    clearBtn.hidden = false;
    if (panel) panel.hidden = false;
    resetWorkspaceViewState();
    void loadDirectory(".");
  } else {
    statusEl.textContent = WORKSPACE_STATUS_TEXT[result.state];
    clearBtn.hidden = true;
    if (panel) panel.hidden = true;
    resetWorkspaceViewState();
  }
}

/**
 * Renders a plain, safe status sentence for a condition outside the IPC contract's own known
 * `WorkspaceGrantState["state"]` values — the preload bridge being missing, or a
 * `workspace.*` call rejecting instead of resolving with a safe state. Never shows a raw
 * error message, stack trace, or path; both call sites below pass a fixed, hand-written
 * string.
 */
function renderStatusMessage(text: string): void {
  const statusEl = document.getElementById("workspace-status");
  const clearBtn = document.getElementById("clear-workspace-btn");
  if (!(statusEl instanceof HTMLElement) || !(clearBtn instanceof HTMLButtonElement)) return;
  statusEl.replaceChildren();
  statusEl.textContent = text;
  clearBtn.hidden = true;
}

function setPickerPending(pending: boolean): void {
  const pickBtn = document.getElementById("pick-directory-btn");
  if (!(pickBtn instanceof HTMLButtonElement)) return;
  pickBtn.disabled = pending;
  pickBtn.textContent = pending ? "Opening folder picker…" : "Open folder…";
}

async function handlePickDirectory(): Promise<void> {
  const api = window.vyronDesktop;
  if (!api) {
    renderStatusMessage("Desktop bridge unavailable. Restart Vyron Code Desktop.");
    return;
  }
  setPickerPending(true);
  try {
    const result = await api.workspace.pickDirectory();
    renderWorkspaceState(result);
  } catch {
    renderStatusMessage("Something went wrong opening the folder picker. Try again.");
  } finally {
    setPickerPending(false);
  }
}

async function handleClearWorkspace(): Promise<void> {
  const api = window.vyronDesktop;
  if (!api) {
    renderStatusMessage("Desktop bridge unavailable. Restart Vyron Code Desktop.");
    return;
  }
  try {
    const result = await api.workspace.clearCurrent();
    renderWorkspaceState(result);
  } catch {
    renderStatusMessage("Something went wrong clearing the workspace. Try again.");
  }
}

// ---------------------------------------------------------------------------------------
// Workspace view switching (Explorer / Search / Git Summary)
// ---------------------------------------------------------------------------------------
function switchView(view: WorkspaceViewName): void {
  const views: Record<WorkspaceViewName, string> = { explorer: "view-explorer", search: "view-search", git: "view-git" };
  const buttons: Record<WorkspaceViewName, string> = { explorer: "nav-explorer-btn", search: "nav-search-btn", git: "nav-git-btn" };

  for (const name of Object.keys(views) as WorkspaceViewName[]) {
    const viewEl = document.getElementById(views[name]);
    if (viewEl) viewEl.hidden = name !== view;
    const btnEl = document.getElementById(buttons[name]);
    if (btnEl) btnEl.setAttribute("aria-pressed", String(name === view));
  }

  if (view === "git") void loadGitSummary();
}

// ---------------------------------------------------------------------------------------
// Explorer
// ---------------------------------------------------------------------------------------
const EXPLORER_INACCESSIBLE_STATES = new Set<ListEntriesResultState>(["denied", "not_a_directory", "invalid_path"]);

async function loadDirectory(relativePath: string): Promise<void> {
  const api = window.vyronDesktop;
  if (!api) {
    renderStatusMessage("Desktop bridge unavailable. Restart Vyron Code Desktop.");
    return;
  }
  explorerState.set(relativePath, { status: "loading" });
  renderExplorerTree();
  try {
    const result = await api.workspace.listEntries(relativePath);
    const key = relativePath === "." ? "." : (result.relativePath ?? relativePath);
    if (result.state === "ok") {
      explorerState.set(key, result.entries.length === 0 ? { status: "empty" } : { status: "loaded", entries: result.entries, truncated: result.truncated });
    } else if (result.state === "no_workspace") {
      explorerState.set(relativePath, { status: "unavailable" });
    } else if (EXPLORER_INACCESSIBLE_STATES.has(result.state)) {
      explorerState.set(relativePath, { status: "inaccessible" });
    } else {
      explorerState.set(relativePath, { status: "unavailable" });
    }
  } catch {
    explorerState.set(relativePath, { status: "unavailable" });
  }
  renderExplorerTree();
}

function renderExplorerTree(): void {
  const tree = document.getElementById("explorer-tree");
  if (!tree) return;
  tree.replaceChildren();
  const rootState = explorerState.get(".");
  if (!rootState) return;
  appendDirStateNode(tree, rootState);
}

/** Renders one directory's own state (loading/empty/inaccessible/unavailable text, or its
 * loaded entries) into the given container — shared by the root render and by each expanded
 * nested directory. */
function appendDirStateNode(container: HTMLElement, state: ExplorerDirState): void {
  if (state.status === "loading") {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "Loading…";
    container.append(li);
    return;
  }
  if (state.status === "empty") {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "Empty folder.";
    container.append(li);
    return;
  }
  if (state.status === "inaccessible") {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "This folder can't be opened.";
    container.append(li);
    return;
  }
  if (state.status === "unavailable") {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "Unable to load this folder right now.";
    container.append(li);
    return;
  }
  for (const entry of state.entries) {
    container.append(buildExplorerNode(entry));
  }
  if (state.truncated) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "Some entries were omitted (bounded listing).";
    container.append(li);
  }
}

function buildExplorerNode(entry: WorkspaceExplorerEntry): HTMLLIElement {
  const li = document.createElement("li");
  const row = document.createElement("button");
  row.type = "button";
  row.className = "tree-row";
  row.setAttribute("aria-selected", String(entry.type === "file" && selectedFileRelativePath === entry.relativePath));

  const icon = document.createElement("span");
  icon.className = "tree-icon";
  icon.textContent = entry.type === "dir" ? (explorerExpanded.has(entry.relativePath) ? "▾" : "▸") : "";
  const label = document.createElement("span");
  label.textContent = entry.name;
  row.append(icon, label);

  row.addEventListener("click", () => {
    if (entry.type === "dir") {
      void toggleDirectory(entry.relativePath);
    } else {
      void openFile(entry.relativePath, "explorer");
    }
  });

  li.append(row);

  if (entry.type === "dir" && explorerExpanded.has(entry.relativePath)) {
    const childState = explorerState.get(entry.relativePath);
    if (childState) {
      const childList = document.createElement("ul");
      appendDirStateNode(childList, childState);
      li.append(childList);
    }
  }

  return li;
}

async function toggleDirectory(relativePath: string): Promise<void> {
  if (explorerExpanded.has(relativePath)) {
    explorerExpanded.delete(relativePath);
    renderExplorerTree();
    return;
  }
  explorerExpanded.add(relativePath);
  if (!explorerState.has(relativePath)) {
    await loadDirectory(relativePath);
  } else {
    renderExplorerTree();
  }
}

// ---------------------------------------------------------------------------------------
// File viewer — shared by Explorer row clicks and Search result clicks.
// ---------------------------------------------------------------------------------------
const FILE_VIEWER_STATUS_TEXT: Record<Exclude<ReadTextFileResultState, "ok">, string> = {
  no_workspace: "No workspace is selected.",
  invalid_path: "That file can't be opened.",
  not_a_file: "That isn't a file.",
  binary: "This file can't be previewed (binary content).",
  too_large: "This file is too large to preview.",
  unreadable: "This file couldn't be read.",
  denied: "That file can't be opened.",
};

async function openFile(relativePath: string, fromView: "explorer" | "search"): Promise<void> {
  const api = window.vyronDesktop;
  if (!api) {
    renderStatusMessage("Desktop bridge unavailable. Restart Vyron Code Desktop.");
    return;
  }
  selectedFileRelativePath = relativePath;
  if (fromView === "search") switchView("explorer");
  renderExplorerTree();
  renderFileViewerPlaceholder("Loading…");
  try {
    const result = await api.workspace.readTextFile(relativePath);
    renderFileViewerResult(result);
  } catch {
    renderFileViewerPlaceholder("Something went wrong opening this file. Try again.");
  }
}

function renderFileViewerResult(result: ReadTextFileResult): void {
  const viewer = document.getElementById("file-viewer");
  if (!viewer) return;
  viewer.replaceChildren();

  if (result.state !== "ok" || result.content === null) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = result.state === "ok" ? "This file has no content." : FILE_VIEWER_STATUS_TEXT[result.state];
    viewer.append(p);
    return;
  }

  const header = document.createElement("div");
  header.className = "file-viewer-header";
  const headerText = document.createElement("span");
  headerText.textContent = `${result.relativePath ?? ""} — ${result.lineCount ?? 0} line${result.lineCount === 1 ? "" : "s"}${result.truncated ? " (truncated)" : ""}`;
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "file-viewer-close";
  closeBtn.textContent = "Close preview";
  closeBtn.addEventListener("click", () => closeFilePreview());
  header.append(headerText, closeBtn);

  const pre = document.createElement("pre");
  pre.textContent = result.content;

  viewer.append(header, pre);
}

/** Clears the current file selection without changing the workspace grant or Explorer/Search
 * state — required so the user can dismiss a preview independently of picking another file. */
function closeFilePreview(): void {
  selectedFileRelativePath = null;
  renderExplorerTree();
  renderFileViewerPlaceholder("Select a file to preview its contents.");
}

// ---------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------
const SEARCH_STATUS_TEXT: Record<Exclude<SearchTextResultState, "ok">, string> = {
  no_workspace: "No workspace is selected.",
  invalid_query: "Enter a query between 1 and 200 characters.",
};

async function handleSearchSubmit(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  // Guards against rapid repeated submission (e.g. holding Enter) — only one search runs at
  // a time; the button is also disabled for the same duration as a visible cue.
  if (searchInFlight) return;

  const api = window.vyronDesktop;
  const input = document.getElementById("search-input");
  const statusEl = document.getElementById("search-status");
  const resultsEl = document.getElementById("search-results");
  const searchBtn = document.getElementById("search-btn");
  if (!api || !(input instanceof HTMLInputElement) || !statusEl || !resultsEl) return;

  const query = input.value;
  statusEl.textContent = "Searching…";
  resultsEl.replaceChildren();
  searchInFlight = true;
  if (searchBtn instanceof HTMLButtonElement) searchBtn.disabled = true;

  try {
    const result = await api.workspace.searchText(query);
    if (result.state !== "ok") {
      statusEl.textContent = SEARCH_STATUS_TEXT[result.state];
      return;
    }
    if (result.matches.length === 0) {
      statusEl.textContent = "No matches found.";
      return;
    }
    statusEl.textContent = `${result.matches.length} match${result.matches.length === 1 ? "" : "es"}${result.truncated ? " (truncated)" : ""}.`;
    for (const match of result.matches) {
      resultsEl.append(buildSearchResultRow(match));
    }
  } catch {
    statusEl.textContent = "Something went wrong searching this workspace. Try again.";
  } finally {
    searchInFlight = false;
    if (searchBtn instanceof HTMLButtonElement) searchBtn.disabled = false;
  }
}

function buildSearchResultRow(match: WorkspaceSearchMatch): HTMLLIElement {
  const li = document.createElement("li");
  const row = document.createElement("button");
  row.type = "button";
  row.className = "search-result-row";

  const pathEl = document.createElement("div");
  pathEl.className = "search-result-path";
  pathEl.textContent = `${match.relativePath}:${match.line}`;

  const lineEl = document.createElement("div");
  lineEl.className = "search-result-line";
  lineEl.textContent = match.preview;

  row.append(pathEl, lineEl);
  row.addEventListener("click", () => void openFile(match.relativePath, "search"));
  li.append(row);
  return li;
}

// ---------------------------------------------------------------------------------------
// Git summary
// ---------------------------------------------------------------------------------------
async function loadGitSummary(): Promise<void> {
  const api = window.vyronDesktop;
  const container = document.getElementById("git-summary");
  if (!api || !container) return;

  container.replaceChildren();
  const loading = document.createElement("p");
  loading.className = "muted";
  loading.textContent = "Loading…";
  container.append(loading);

  try {
    const result = await api.workspace.getGitSummary();
    renderGitSummary(result);
  } catch {
    container.replaceChildren();
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "Something went wrong loading the Git summary. Try again.";
    container.append(p);
  }
}

function renderGitSummary(result: GitSummaryResult): void {
  const container = document.getElementById("git-summary");
  if (!container) return;
  container.replaceChildren();

  if (result.state === "not_a_repository") {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "No Git repository detected in this workspace.";
    container.append(p);
    return;
  }
  if (result.state !== "ok") {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = result.state === "no_workspace" ? "No workspace is selected." : "Git summary is unavailable for this workspace.";
    container.append(p);
    return;
  }

  const dl = document.createElement("dl");
  const suffix = result.truncated ? "+ (bounded scan)" : "";

  const branchTerm = document.createElement("dt");
  branchTerm.textContent = "Branch";
  const branchValue = document.createElement("dd");
  branchValue.textContent = result.detached ? "detached HEAD" : (result.branch ?? "unknown");
  dl.append(branchTerm, branchValue);

  if (result.trackedChangesAvailable) {
    const modifiedTerm = document.createElement("dt");
    modifiedTerm.textContent = "Modified";
    const modifiedValue = document.createElement("dd");
    modifiedValue.textContent = `${result.modifiedCount ?? 0}${suffix}`;
    dl.append(modifiedTerm, modifiedValue);

    const deletedTerm = document.createElement("dt");
    deletedTerm.textContent = "Deleted";
    const deletedValue = document.createElement("dd");
    deletedValue.textContent = `${result.deletedCount ?? 0}${suffix}`;
    dl.append(deletedTerm, deletedValue);
  }

  const untrackedTerm = document.createElement("dt");
  untrackedTerm.textContent = "Untracked files";
  const untrackedValue = document.createElement("dd");
  untrackedValue.textContent = `${result.untrackedCount ?? 0}${suffix}`;
  dl.append(untrackedTerm, untrackedValue);

  container.append(dl);

  if (!result.trackedChangesAvailable) {
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = "Modified/deleted counts are unavailable for this repository; showing untracked files only.";
    container.append(note);
  } else {
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = "Staged-but-uncommitted and rename counts are not computed by this summary.";
    container.append(note);
  }
}

// ---------------------------------------------------------------------------------------
// Hermes authorization panel — VYRON_CODE_V02_D08B_MEMORY_ONLY_HERMES_AUTHORIZATION_BOUNDARY_AUTHORIZATION.
// Entirely independent of the workspace grant above: clearing one never touches the other
// (see electron/hermesAuthorization.ts's own "independent-lifetime policy" note). No Hermes
// network/health/session/prompt/event call exists anywhere in this file — only the four
// window.vyronDesktop.hermes.* authorization-state methods, each triggered only by an
// explicit user action (opening the panel, submitting the form, or clicking Clear).
// ---------------------------------------------------------------------------------------
type HermesViewState = "not_authorized" | "panel_open" | "submitting" | "authorized" | "revoking" | "unavailable" | "safe_failure";

/** Monotonic request generation — T-17 stale-authorization race protection, renderer side.
 * `handleClearHermesAuthorization` increments this immediately (before its own IPC call even
 * resolves), so a `beginAuthorization` call already awaiting a response detects the change
 * once it resolves and discards its own result instead of rendering a now-stale "authorized"
 * state after the user has already revoked. */
let hermesRequestGeneration = 0;

interface HermesPanelElements {
  readonly statusEl: HTMLElement;
  readonly explanationEl: HTMLElement;
  readonly authorizeBtn: HTMLButtonElement;
  readonly clearBtn: HTMLButtonElement;
  readonly form: HTMLFormElement;
  readonly credentialInput: HTMLInputElement;
  readonly submitBtn: HTMLButtonElement;
  readonly cancelBtn: HTMLButtonElement;
  readonly errorEl: HTMLElement;
}

function getHermesElements(): HermesPanelElements | null {
  const statusEl = document.getElementById("hermes-status");
  const explanationEl = document.getElementById("hermes-explanation");
  const authorizeBtn = document.getElementById("hermes-authorize-btn");
  const clearBtn = document.getElementById("hermes-clear-btn");
  const form = document.getElementById("hermes-authorization-form");
  const credentialInput = document.getElementById("hermes-credential-input");
  const submitBtn = document.getElementById("hermes-submit-btn");
  const cancelBtn = document.getElementById("hermes-cancel-btn");
  const errorEl = document.getElementById("hermes-error");
  if (
    !(statusEl instanceof HTMLElement) ||
    !(explanationEl instanceof HTMLElement) ||
    !(authorizeBtn instanceof HTMLButtonElement) ||
    !(clearBtn instanceof HTMLButtonElement) ||
    !(form instanceof HTMLFormElement) ||
    !(credentialInput instanceof HTMLInputElement) ||
    !(submitBtn instanceof HTMLButtonElement) ||
    !(cancelBtn instanceof HTMLButtonElement) ||
    !(errorEl instanceof HTMLElement)
  ) {
    return null;
  }
  return { statusEl, explanationEl, authorizeBtn, clearBtn, form, credentialInput, submitBtn, cancelBtn, errorEl };
}

/**
 * Renders one of the required D-08B UI states using only fixed, safe, hand-written string
 * literals — never a value derived from the credential, an IPC response's raw content, or an
 * error message/stack. `credentialInput.value` is reset to `""` on every render that is not
 * mid-submission, so the credential never lingers in the DOM/renderer state longer than the
 * one in-flight IPC call that needs it.
 */
function renderHermesPanel(view: HermesViewState): void {
  const els = getHermesElements();
  if (!els) return;
  const { statusEl, explanationEl, authorizeBtn, clearBtn, form, credentialInput, submitBtn, errorEl } = els;

  errorEl.hidden = true;
  errorEl.textContent = "";
  clearBtn.textContent = "Clear Hermes authorization";
  submitBtn.textContent = "Authorize";

  if (view === "not_authorized" || view === "unavailable") {
    statusEl.textContent = "Hermes: Not authorized";
    explanationEl.textContent =
      view === "unavailable"
        ? "Authorization is unavailable in this build."
        : "Hermes is disabled until you explicitly authorize it for this app session.";
    authorizeBtn.hidden = view === "unavailable";
    authorizeBtn.disabled = false;
    clearBtn.hidden = true;
    form.hidden = true;
    credentialInput.value = "";
    credentialInput.disabled = false;
    submitBtn.disabled = false;
    return;
  }

  if (view === "panel_open" || view === "submitting" || view === "safe_failure") {
    statusEl.textContent = "Hermes: Not authorized";
    explanationEl.textContent = "Hermes is disabled until you explicitly authorize it for this app session.";
    authorizeBtn.hidden = true;
    clearBtn.hidden = true;
    form.hidden = false;
    const submitting = view === "submitting";
    credentialInput.disabled = submitting;
    submitBtn.disabled = submitting;
    submitBtn.textContent = submitting ? "Authorizing…" : "Authorize";
    if (view === "safe_failure") {
      credentialInput.value = "";
      errorEl.hidden = false;
      errorEl.textContent = "Authorization could not be stored for this app session. Please try again.";
    }
    return;
  }

  // view === "authorized" || view === "revoking"
  statusEl.textContent = "Hermes: Authorized for this app session only";
  explanationEl.textContent = "Your credential is held only in this running desktop app and is not saved.";
  authorizeBtn.hidden = true;
  clearBtn.hidden = false;
  form.hidden = true;
  credentialInput.value = "";
  const revoking = view === "revoking";
  clearBtn.disabled = revoking;
  clearBtn.textContent = revoking ? "Revoking…" : "Clear Hermes authorization";

  // D-08C connection sub-panel is only ever visible while authorized — hidden again on
  // "revoking" (about to leave). Its own CONTENT is deliberately never set here: each caller
  // of renderHermesPanel("authorized") (a fresh beginAuthorization success, or initHermesState
  // restoring real state on startup) decides what the connection section should show next,
  // rather than this function assuming "ready_to_connect" and possibly stomping a real value.
  const connectionSection = document.getElementById("hermes-connection-section");
  if (connectionSection) connectionSection.hidden = revoking;
}

function handleOpenHermesPanel(): void {
  renderHermesPanel("panel_open");
}

function handleCancelHermesAuthorization(): void {
  renderHermesPanel("not_authorized");
}

async function handleBeginHermesAuthorization(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const api = window.vyronDesktop;
  const els = getHermesElements();
  if (!els) return;
  if (!api) {
    renderHermesPanel("unavailable");
    return;
  }

  const credential = els.credentialInput.value;
  const requestId = ++hermesRequestGeneration;
  renderHermesPanel("submitting");
  try {
    const result = await api.hermes.beginAuthorization({ credential });
    // Superseded by a later clear or another submit while this call was in flight — never
    // render a result that is no longer current.
    if (requestId !== hermesRequestGeneration) return;
    if (result.state === "authorized_memory_only") {
      renderHermesPanel("authorized");
      // A freshly successful authorization is always connection-ready — D-08C's own ambient
      // state starts "ready_to_connect" the moment authorization becomes valid.
      renderHermesConnection("ready_to_connect");
    } else if (result.state === "revoked" || result.state === "not_authorized") {
      renderHermesPanel("not_authorized");
    } else if (result.state === "unavailable") {
      renderHermesPanel("unavailable");
    } else {
      renderHermesPanel("safe_failure");
    }
  } catch {
    if (requestId !== hermesRequestGeneration) return;
    renderHermesPanel("safe_failure");
  } finally {
    els.credentialInput.value = "";
  }
}

async function handleClearHermesAuthorization(): Promise<void> {
  const api = window.vyronDesktop;
  if (!api) {
    renderHermesPanel("unavailable");
    return;
  }
  // Increment first, synchronously, before the IPC call even starts — supersedes any
  // beginAuthorization call already in flight immediately, not only after this call resolves.
  hermesRequestGeneration++;
  // Also supersedes any in-flight connect() and resets the main process's own connection
  // state — clearing authorization must always leave connectivity inactive too (D-08C's
  // getConnectionState() would already report "not_authorized" once cleared regardless, but
  // this keeps electron/hermesConnection.ts's own internal state hygienic rather than stale).
  hermesConnectionRequestGeneration++;
  renderHermesPanel("revoking");
  try {
    await api.hermes.clearAuthorization();
  } catch {
    // Clear must always leave the UI in a safe, non-authorized state, even if the IPC call
    // itself rejected — never leave the user looking at a stale "authorized" panel.
  }
  try {
    await api.hermes.disconnect();
  } catch {
    // Best-effort only — clearAuthorization() above already makes getConnectionState()
    // report "not_authorized" regardless of whether this call itself succeeds.
  }
  renderHermesPanel("not_authorized");
}

// ---------------------------------------------------------------------------------------
// D-08E endpoint setup panel — VYRON_CODE_V02_D08E_MEMORY_ONLY_HERMES_ENDPOINT_SETUP_AUTHORIZATION.
// Entirely independent of D-08B authorization: a user may configure an endpoint before,
// after, or without ever authorizing, and vice versa (see electron/hermesEndpointSetup.ts's
// own "independent-lifetime policy" note). configureEndpoint()/clearEndpointConfiguration()
// never take an endpoint's individual host/port/protocol as separate fields — only the one
// raw URL string the user typed, forwarded verbatim to the main process, which alone decides
// whether it is safe. This panel never renders that string, or any part of it, back — only
// the fixed, safe state enum.
// ---------------------------------------------------------------------------------------
type HermesEndpointViewState =
  | "not_configured"
  | "setup_open"
  | "configuring"
  | "configured"
  | "clearing"
  | "policy_rejected"
  | "invalid_configuration"
  | "unavailable"
  | "safe_failure";

/** Monotonic request generation — the same T-17-style guard the authorization and connection
 * panels above use, applied independently to the endpoint setup panel. */
let hermesEndpointRequestGeneration = 0;

interface HermesEndpointElements {
  readonly statusEl: HTMLElement;
  readonly setupBtn: HTMLButtonElement;
  readonly clearBtn: HTMLButtonElement;
  readonly form: HTMLFormElement;
  readonly endpointInput: HTMLInputElement;
  readonly riskCheckbox: HTMLInputElement;
  readonly submitBtn: HTMLButtonElement;
  readonly cancelBtn: HTMLButtonElement;
  readonly errorEl: HTMLElement;
}

function getHermesEndpointElements(): HermesEndpointElements | null {
  const statusEl = document.getElementById("hermes-endpoint-status");
  const setupBtn = document.getElementById("hermes-endpoint-setup-btn");
  const clearBtn = document.getElementById("hermes-endpoint-clear-btn");
  const form = document.getElementById("hermes-endpoint-form");
  const endpointInput = document.getElementById("hermes-endpoint-input");
  const riskCheckbox = document.getElementById("hermes-endpoint-risk-checkbox");
  const submitBtn = document.getElementById("hermes-endpoint-submit-btn");
  const cancelBtn = document.getElementById("hermes-endpoint-cancel-btn");
  const errorEl = document.getElementById("hermes-endpoint-error");
  if (
    !(statusEl instanceof HTMLElement) ||
    !(setupBtn instanceof HTMLButtonElement) ||
    !(clearBtn instanceof HTMLButtonElement) ||
    !(form instanceof HTMLFormElement) ||
    !(endpointInput instanceof HTMLInputElement) ||
    !(riskCheckbox instanceof HTMLInputElement) ||
    !(submitBtn instanceof HTMLButtonElement) ||
    !(cancelBtn instanceof HTMLButtonElement) ||
    !(errorEl instanceof HTMLElement)
  ) {
    return null;
  }
  return { statusEl, setupBtn, clearBtn, form, endpointInput, riskCheckbox, submitBtn, cancelBtn, errorEl };
}

/** Superficial, non-sensitive, client-side-only format gate — never the real validation
 * (that happens exclusively in the main process via the unchanged `validateEndpointCandidate`
 * policy engine). Exists only to keep the submit action disabled for an obviously-incomplete
 * entry; passing this check guarantees nothing about whether the main process will accept it. */
function looksLikeSuperficiallyValidEndpoint(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && /^wss?:\/\//i.test(trimmed);
}

function updateHermesEndpointSubmitEnabled(): void {
  const els = getHermesEndpointElements();
  if (!els) return;
  els.submitBtn.disabled = !(looksLikeSuperficiallyValidEndpoint(els.endpointInput.value) && els.riskCheckbox.checked);
}

/**
 * Renders one of the required D-08E endpoint-setup states using only fixed, safe,
 * hand-written string literals — never the submitted URL or any component of it.
 */
function renderHermesEndpointPanel(view: HermesEndpointViewState): void {
  const els = getHermesEndpointElements();
  if (!els) return;
  const { statusEl, setupBtn, clearBtn, form, endpointInput, riskCheckbox, submitBtn, errorEl } = els;

  errorEl.hidden = true;
  errorEl.textContent = "";
  clearBtn.textContent = "Clear local Hermes connection setup";

  if (view === "not_configured" || view === "unavailable") {
    statusEl.textContent = "No local companion endpoint configured";
    setupBtn.hidden = view === "unavailable";
    setupBtn.disabled = false;
    clearBtn.hidden = true;
    form.hidden = true;
    endpointInput.value = "";
    riskCheckbox.checked = false;
    return;
  }

  if (view === "setup_open" || view === "configuring" || view === "policy_rejected" || view === "invalid_configuration" || view === "safe_failure") {
    statusEl.textContent = "No local companion endpoint configured";
    setupBtn.hidden = true;
    clearBtn.hidden = true;
    form.hidden = false;
    const configuring = view === "configuring";
    endpointInput.disabled = configuring;
    riskCheckbox.disabled = configuring;
    submitBtn.textContent = configuring ? "Configuring…" : "Configure";
    if (configuring) {
      submitBtn.disabled = true;
    } else {
      updateHermesEndpointSubmitEnabled();
    }
    if (view === "policy_rejected" || view === "invalid_configuration" || view === "safe_failure") {
      endpointInput.value = "";
      riskCheckbox.checked = false;
      errorEl.hidden = false;
      errorEl.textContent =
        view === "safe_failure"
          ? "Endpoint could not be configured for this app session. Please try again."
          : "That endpoint can't be used. Configure only a local Hermes companion service you trust.";
    }
    return;
  }

  // view === "configured" || view === "clearing"
  statusEl.textContent = "Local companion endpoint configured for this app session only";
  setupBtn.hidden = true;
  clearBtn.hidden = false;
  form.hidden = true;
  endpointInput.value = "";
  riskCheckbox.checked = false;
  const clearing = view === "clearing";
  clearBtn.disabled = clearing;
  clearBtn.textContent = clearing ? "Clearing…" : "Clear local Hermes connection setup";
}

function handleOpenHermesEndpointSetup(): void {
  renderHermesEndpointPanel("setup_open");
}

function handleCancelHermesEndpointSetup(): void {
  renderHermesEndpointPanel("not_configured");
}

async function handleConfigureHermesEndpoint(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const api = window.vyronDesktop;
  const els = getHermesEndpointElements();
  if (!els) return;
  if (!api) {
    renderHermesEndpointPanel("unavailable");
    return;
  }
  if (!looksLikeSuperficiallyValidEndpoint(els.endpointInput.value) || !els.riskCheckbox.checked) return;

  const endpoint = els.endpointInput.value;
  const requestId = ++hermesEndpointRequestGeneration;
  renderHermesEndpointPanel("configuring");
  try {
    const result = await api.hermes.configureEndpoint({ endpoint });
    if (requestId !== hermesEndpointRequestGeneration) return;
    if (result.state === "configured_memory_only") {
      renderHermesEndpointPanel("configured");
    } else if (result.state === "policy_rejected") {
      renderHermesEndpointPanel("policy_rejected");
    } else if (result.state === "invalid_configuration") {
      renderHermesEndpointPanel("invalid_configuration");
    } else if (result.state === "cleared" || result.state === "not_configured") {
      renderHermesEndpointPanel("not_configured");
    } else if (result.state === "unavailable") {
      renderHermesEndpointPanel("unavailable");
    } else {
      renderHermesEndpointPanel("safe_failure");
    }
  } catch {
    if (requestId !== hermesEndpointRequestGeneration) return;
    renderHermesEndpointPanel("safe_failure");
  } finally {
    els.endpointInput.value = "";
  }
}

async function handleClearHermesEndpointConfiguration(): Promise<void> {
  const api = window.vyronDesktop;
  if (!api) {
    renderHermesEndpointPanel("unavailable");
    return;
  }
  // Supersedes any in-flight configureEndpoint() immediately, before the IPC call even starts.
  hermesEndpointRequestGeneration++;
  renderHermesEndpointPanel("clearing");
  try {
    await api.hermes.clearEndpointConfiguration();
  } catch {
    // Clear must always leave the UI in a safe, not-configured-looking state, even if the IPC
    // call itself rejected.
  }
  // Also resets D-08C connection state hygiene, mirroring handleClearHermesAuthorization's own
  // best-effort disconnect() call — getConnectionState() would already report correctly
  // without this once the endpoint is gone, but this keeps hermesConnection.ts's own internal
  // state tidy rather than stale.
  try {
    await api.hermes.disconnect();
  } catch {
    // Best-effort only.
  }
  renderHermesEndpointPanel("not_configured");
}

async function initHermesEndpointState(api: DesktopApi): Promise<void> {
  try {
    const state = await api.hermes.getEndpointConfigurationState();
    renderHermesEndpointPanel(state.state === "configured_memory_only" ? "configured" : "not_configured");
  } catch {
    renderHermesEndpointPanel("unavailable");
  }
}

function wireHermesEndpointControls(): void {
  document.getElementById("hermes-endpoint-setup-btn")?.addEventListener("click", handleOpenHermesEndpointSetup);
  document.getElementById("hermes-endpoint-cancel-btn")?.addEventListener("click", handleCancelHermesEndpointSetup);
  document.getElementById("hermes-endpoint-clear-btn")?.addEventListener("click", () => void handleClearHermesEndpointConfiguration());
  document.getElementById("hermes-endpoint-input")?.addEventListener("input", updateHermesEndpointSubmitEnabled);
  document.getElementById("hermes-endpoint-risk-checkbox")?.addEventListener("change", updateHermesEndpointSubmitEnabled);
  const form = document.getElementById("hermes-endpoint-form");
  if (form instanceof HTMLFormElement) {
    form.addEventListener("submit", (event) => void handleConfigureHermesEndpoint(event));
  }
}

// ---------------------------------------------------------------------------------------
// D-08C connection sub-panel — VYRON_CODE_V02_D08B_CHECKPOINT_AND_D08C_SAFE_HERMES_CONNECTIVITY_AUTHORIZATION.
// Visible only while the outer Hermes panel is in its "authorized" view (see
// renderHermesPanel above). connect()/disconnect() never take an endpoint/host/port/socket
// argument of any kind — see electron/hermesConnection.ts's own header for why connect()
// always safely resolves to "unavailable" in this build (a disclosed trusted-endpoint-policy
// blocker, not a bug).
// ---------------------------------------------------------------------------------------
type HermesConnectionViewState = "ready_to_connect" | "connecting" | "connected" | "disconnecting" | "disconnected" | "unavailable" | "safe_failure";

/** Monotonic request generation — the same T-17-style guard the authorization panel above
 * uses, applied independently to the connection sub-panel. */
let hermesConnectionRequestGeneration = 0;

interface HermesConnectionElements {
  readonly statusEl: HTMLElement;
  readonly connectBtn: HTMLButtonElement;
  readonly disconnectBtn: HTMLButtonElement;
  readonly errorEl: HTMLElement;
}

function getHermesConnectionElements(): HermesConnectionElements | null {
  const statusEl = document.getElementById("hermes-connection-status");
  const connectBtn = document.getElementById("hermes-connect-btn");
  const disconnectBtn = document.getElementById("hermes-disconnect-btn");
  const errorEl = document.getElementById("hermes-connection-error");
  if (
    !(statusEl instanceof HTMLElement) ||
    !(connectBtn instanceof HTMLButtonElement) ||
    !(disconnectBtn instanceof HTMLButtonElement) ||
    !(errorEl instanceof HTMLElement)
  ) {
    return null;
  }
  return { statusEl, connectBtn, disconnectBtn, errorEl };
}

/**
 * Renders one of the required D-08C connection states using only fixed, safe, hand-written
 * string literals — never an endpoint, host, port, socket detail, or raw error. No state here
 * ever mentions a network address, protocol, or session identifier.
 */
function renderHermesConnection(view: HermesConnectionViewState): void {
  const els = getHermesConnectionElements();
  if (!els) return;
  const { statusEl, connectBtn, disconnectBtn, errorEl } = els;

  errorEl.hidden = true;
  errorEl.textContent = "";
  connectBtn.disabled = false;
  disconnectBtn.disabled = false;
  disconnectBtn.textContent = "Disconnect";

  switch (view) {
    case "ready_to_connect":
      statusEl.textContent = "Hermes connection has not been attempted.";
      connectBtn.hidden = false;
      disconnectBtn.hidden = true;
      break;
    case "connecting":
      statusEl.textContent = "Connecting…";
      connectBtn.hidden = true;
      disconnectBtn.hidden = false;
      break;
    case "connected":
      statusEl.textContent = "Connected.";
      connectBtn.hidden = true;
      disconnectBtn.hidden = false;
      break;
    case "disconnecting":
      statusEl.textContent = "Disconnecting…";
      connectBtn.hidden = true;
      disconnectBtn.hidden = false;
      disconnectBtn.disabled = true;
      disconnectBtn.textContent = "Disconnecting…";
      break;
    case "disconnected":
      statusEl.textContent = "Disconnected.";
      connectBtn.hidden = false;
      disconnectBtn.hidden = true;
      break;
    case "unavailable":
      statusEl.textContent = "Hermes connectivity is unavailable in this build.";
      connectBtn.hidden = false;
      disconnectBtn.hidden = true;
      break;
    case "safe_failure":
      statusEl.textContent = "Hermes connection has not been attempted.";
      connectBtn.hidden = false;
      disconnectBtn.hidden = true;
      errorEl.hidden = false;
      errorEl.textContent = "Connection could not be completed. Please try again.";
      break;
  }
}

async function handleConnectHermes(): Promise<void> {
  const api = window.vyronDesktop;
  if (!api) {
    renderHermesConnection("unavailable");
    return;
  }
  const requestId = ++hermesConnectionRequestGeneration;
  renderHermesConnection("connecting");
  try {
    const result = await api.hermes.connect();
    // Superseded by a later connect/disconnect while this call was in flight — never render
    // a result that is no longer current.
    if (requestId !== hermesConnectionRequestGeneration) return;
    if (result.state === "connected") {
      renderHermesConnection("connected");
    } else if (result.state === "unavailable") {
      renderHermesConnection("unavailable");
    } else if (result.state === "disconnected") {
      renderHermesConnection("disconnected");
    } else if (result.state === "not_authorized") {
      // Authorization must have been cleared elsewhere while this call was in flight.
      renderHermesPanel("not_authorized");
    } else {
      renderHermesConnection("safe_failure");
    }
  } catch {
    if (requestId !== hermesConnectionRequestGeneration) return;
    renderHermesConnection("safe_failure");
  }
}

async function handleDisconnectHermes(): Promise<void> {
  const api = window.vyronDesktop;
  if (!api) {
    renderHermesConnection("unavailable");
    return;
  }
  // Supersedes any in-flight connect() immediately, before the IPC call even starts.
  hermesConnectionRequestGeneration++;
  renderHermesConnection("disconnecting");
  try {
    await api.hermes.disconnect();
  } catch {
    // Disconnect must always leave the UI in a safe, disconnected-looking state, even if the
    // IPC call itself rejected.
  }
  renderHermesConnection("disconnected");
}

async function initHermesState(api: DesktopApi): Promise<void> {
  try {
    const availability = await api.hermes.getAvailability();
    if (availability.state !== "available") {
      renderHermesPanel("unavailable");
      return;
    }
    const state = await api.hermes.getAuthorizationState();
    if (state.state === "authorized_memory_only") {
      renderHermesPanel("authorized");
      // Restore the real connection state rather than assuming "ready_to_connect" — an app
      // restart always begins with a fresh, never-connected state in this build (D-08C has
      // no cross-restart persistence of any kind), but this still asks rather than assumes.
      try {
        const connectionState = await api.hermes.getConnectionState();
        renderHermesConnection(connectionState.state === "not_authorized" ? "ready_to_connect" : connectionState.state);
      } catch {
        renderHermesConnection("ready_to_connect");
      }
    } else {
      renderHermesPanel("not_authorized");
    }
  } catch {
    renderHermesPanel("unavailable");
  }
}

function wireHermesControls(): void {
  document.getElementById("hermes-authorize-btn")?.addEventListener("click", handleOpenHermesPanel);
  document.getElementById("hermes-cancel-btn")?.addEventListener("click", handleCancelHermesAuthorization);
  document.getElementById("hermes-clear-btn")?.addEventListener("click", () => void handleClearHermesAuthorization());
  const form = document.getElementById("hermes-authorization-form");
  if (form instanceof HTMLFormElement) {
    form.addEventListener("submit", (event) => void handleBeginHermesAuthorization(event));
  }
  document.getElementById("hermes-connect-btn")?.addEventListener("click", () => void handleConnectHermes());
  document.getElementById("hermes-disconnect-btn")?.addEventListener("click", () => void handleDisconnectHermes());
}

// ---------------------------------------------------------------------------------------
// Wiring and static content
// ---------------------------------------------------------------------------------------
function wireWorkspaceControls(): void {
  document.getElementById("pick-directory-btn")?.addEventListener("click", () => void handlePickDirectory());
  document.getElementById("clear-workspace-btn")?.addEventListener("click", () => void handleClearWorkspace());
  document.getElementById("nav-explorer-btn")?.addEventListener("click", () => switchView("explorer"));
  document.getElementById("nav-search-btn")?.addEventListener("click", () => switchView("search"));
  document.getElementById("nav-git-btn")?.addEventListener("click", () => switchView("git"));
  const searchForm = document.getElementById("search-form");
  if (searchForm instanceof HTMLFormElement) {
    searchForm.addEventListener("submit", (event) => void handleSearchSubmit(event));
  }
}

async function initWorkspaceState(api: DesktopApi): Promise<void> {
  const result = await api.workspace.getCurrent();
  renderWorkspaceState(result);
}

function renderCapabilities(api: DesktopApi): void {
  const list = document.getElementById("capabilities");
  if (!list) return;
  for (const [name, available] of Object.entries(api.capabilities)) {
    const item = document.createElement("li");

    const nameEl = document.createElement("span");
    nameEl.className = "cap-name";
    nameEl.textContent = name;

    const valueEl = document.createElement("span");
    valueEl.className = "cap-value";
    valueEl.textContent = available ? "available" : "not available";

    item.append(nameEl, valueEl);
    list.append(item);
  }
}

function renderPlatform(api: DesktopApi): void {
  const platformEl = document.getElementById("platform-value");
  if (platformEl) platformEl.textContent = api.platform;
}

function main(): void {
  wireWorkspaceControls();
  wireHermesControls();
  wireHermesEndpointControls();
  const api = window.vyronDesktop;
  if (!api) {
    // Preload bridge unavailable. Electron guarantees preload finishes before this script
    // runs, so this should not happen in normal operation — but if it ever does, say so
    // visibly instead of silently leaving the default "No workspace is selected." text, which
    // would misleadingly imply the bridge works and nothing has been picked yet.
    renderStatusMessage("Desktop bridge unavailable. Restart Vyron Code Desktop.");
    renderHermesPanel("unavailable");
    renderHermesEndpointPanel("unavailable");
    return;
  }
  renderCapabilities(api);
  renderPlatform(api);
  void initWorkspaceState(api);
  void initHermesState(api);
  void initHermesEndpointState(api);
}

main();
