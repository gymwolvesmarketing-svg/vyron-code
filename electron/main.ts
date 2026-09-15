/**
 * Electron main-process entry point — VYRON_CODE_V02_D02B_ELECTRON_HARDENED_SCAFFOLD_AUTHORIZATION,
 * extended by VYRON_CODE_V02_D02D_MINIMAL_LOCAL_RENDERER_AUTHORIZATION to load the local
 * renderer asset (electron/renderer.html) via the hardened BrowserWindow's own `loadFile` —
 * never a remote/localhost URL, never a `data:` URL — by
 * VYRON_CODE_V02_D03_NATIVE_FOLDER_PICKER_AND_WORKSPACE_GRANT_AUTHORIZATION to register the
 * workspace-grant IPC handlers, by
 * VYRON_CODE_V02_MILESTONE_A_RUNTIME_STABILITY_AND_READONLY_WORKSPACE_AUTHORIZATION to
 * register the Explorer/file-viewer/search/Git-summary handlers and add bounded, safe
 * lifecycle diagnostics for the still-unexplained ~3-minute self-exit defect, and by
 * VYRON_CODE_V02_A00_RUNTIME_EXIT_TRACE_COMPLETION_AND_STABILITY_FIX_AUTHORIZATION to extend
 * that diagnostic coverage to every remaining lifecycle event/exit signal a live run had not
 * yet observed (the first live test — five 30-second heartbeats then a silent exit near 150s,
 * with NONE of the already-instrumented events firing — ruled out every Electron-graceful-
 * shutdown path this file already logged, without yet proving what the real path is), and by
 * the VYRON_CODE_V02_A00 cleanup pass (post-acceptance) to gate every lifecycle diagnostic
 * added during that investigation behind an explicit, disabled-by-default opt-in — the
 * self-close root cause was confirmed to be `npx electron ...`'s own launcher-chain wrapper
 * (see VYRON_CODE_V02_A00_EXTERNAL_PROCESS_TERMINATION_TRACE_REPORT.md), not anything in this
 * file, so this diagnostic surface is no longer needed for normal runtime use, but is kept
 * (rather than deleted) as a real, load-bearing troubleshooting tool if a similar question
 * ever recurs — it just no longer prints by default.
 *
 * Defines app lifecycle wiring, applies the hardened BrowserWindow policy from
 * ./security-policy, loads only the local renderer asset, enforces deny-by-default
 * navigation/new-window behavior, and registers exactly the workspace IPC handlers below.
 * There is no terminal/shell handler, no environment/token handler, and no
 * Hermes/provider/deliberation handler anywhere in this file — each of those is its own,
 * separately authorized, future phase (see VYRON_CODE_V02_DESKTOP_ARCHITECTURE_DECISION.md).
 *
 * This file is not executed by this authorization's own static-validation steps. Electron app
 * launch, BrowserWindow creation at runtime, and native process behavior all require their
 * own separate, explicit runtime authorization/user-owned foreground launch.
 *
 * Extended by VYRON_CODE_V02_D08B_MEMORY_ONLY_HERMES_AUTHORIZATION_BOUNDARY_AUTHORIZATION to
 * register the four Hermes authorization IPC handlers, delegating entirely to
 * electron/hermesAuthorization.ts. This file still has no Hermes network/health/session/
 * prompt/event handler of any kind — this phase adds only an authorization *state* boundary,
 * nothing that connects to Hermes.
 */
import { app, BrowserWindow, ipcMain, powerMonitor } from "electron";
import path from "node:path";
import { HARDENED_WEB_PREFERENCES, isNavigationAllowed, isNewWindowAllowed } from "./security-policy";
import { HERMES_IPC_CHANNELS, WORKSPACE_IPC_CHANNELS } from "./shared-ipc-contract";
import { pickDirectory, getCurrent, clearCurrent } from "./workspace-grant";
import { listEntries } from "./workspaceExplorer";
import { readTextFile } from "./workspaceFileViewer";
import { searchText } from "./workspaceSearch";
import { getGitSummary } from "./workspaceGit";
import { getAvailability, getAuthorizationState, beginAuthorization, clearAuthorization as clearHermesAuthorization } from "./hermesAuthorization";
import { getConnectionState, connect as connectHermes, disconnect as disconnectHermes } from "./hermesConnection";

/**
 * Explicit, disabled-by-default opt-in for the lifecycle diagnostics below —
 * VYRON_CODE_V02_A00 cleanup pass. The self-close this diagnostic surface was built to
 * investigate is resolved (root cause: the `npx electron ...` launcher-chain wrapper, not
 * this file — see VYRON_CODE_V02_A00_EXTERNAL_PROCESS_TERMINATION_TRACE_REPORT.md), so normal
 * runtime use no longer prints anything. Set `VYRON_LIFECYCLE_DEBUG=1` in the environment
 * before launching to re-enable every `[lifecycle] ...` line below, if this class of question
 * ever needs investigating again.
 */
const LIFECYCLE_DIAGNOSTICS_ENABLED = process.env.VYRON_LIFECYCLE_DEBUG === "1";

/**
 * Safe lifecycle diagnostic logger — VYRON_CODE_V02_MILESTONE_A_RUNTIME_STABILITY_AND_READONLY_WORKSPACE_AUTHORIZATION,
 * gated per the constant above (VYRON_CODE_V02_A00 cleanup pass). Never logs a filesystem
 * path, token, environment value, IPC payload, or raw error message/stack — only a fixed
 * label and, optionally, a bounded/safe metadata string (an event-reason enum value, an
 * elapsed-time bucket, or an error's own constructor name). Also unconditionally silent in a
 * packaged build, matching the existing `electron/workspace-grant.ts` diagnostic-logging
 * convention.
 */
function logLifecycle(label: string, safeDetail?: string): void {
  if (app.isPackaged || !LIFECYCLE_DIAGNOSTICS_ENABLED) return;
  console.log(safeDetail ? `[lifecycle] ${label}: ${safeDetail}` : `[lifecycle] ${label}`);
}

/**
 * Kept as an explicit, top-level, module-scope reference — never only a local variable
 * inside a callback. Electron's own documentation notes that a `BrowserWindow` with no
 * remaining live JavaScript reference can be garbage-collected, which closes the window as a
 * side effect; holding this reference for the process's entire lifetime removes that as a
 * possible contributing factor to the observed self-exit defect (not proven to be the sole
 * cause by itself — see VYRON_CODE_V02_MILESTONE_A_RUNTIME_STABILITY_AND_READONLY_WORKSPACE_REPORT.md
 * for the full trace and what remains unproven without a live test).
 */
let mainWindow: BrowserWindow | null = null;

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      ...HARDENED_WEB_PREFERENCES,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // Deny-by-default navigation policy — no origin is currently approved (see
  // security-policy.ts's ALLOWED_NAVIGATION_ORIGINS, empty by design in this phase).
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isNavigationAllowed(targetUrl)) event.preventDefault();
  });

  // Deny-by-default new-window policy — no popup/child-window capability is approved by
  // any phase of the desktop migration plan.
  window.webContents.setWindowOpenHandler(({ url }) => (isNewWindowAllowed(url) ? { action: "allow" } : { action: "deny" }));

  // Bounded, safe lifecycle diagnostics only — no path/content/payload is ever logged. These
  // exist to classify the observed ~3-minute self-exit defect on the next user-owned run;
  // they do not change, delay, prevent, or suppress any lifecycle event's default behavior.
  window.on("close", () => logLifecycle("window close (user or programmatic close() called)"));
  window.on("closed", () => logLifecycle("window closed (native handle destroyed)"));
  // Windows-specific OS session-lifecycle events — VYRON_CODE_V02_A00_RUNTIME_EXIT_TRACE_COMPLETION_AND_STABILITY_FIX_AUTHORIZATION,
  // second pass. Fired when Windows itself is restarting, the machine is losing power, the
  // user is logging off, or the machine is shutting down — a class of OS-level session
  // termination distinct from every app/BrowserWindow event this file already logged, and one
  // this file had not instrumented at all before this pass.
  window.on("query-session-end", () => logLifecycle("window query-session-end (Windows session ending)"));
  window.on("session-end", () => logLifecycle("window session-end (Windows session ended)"));
  window.webContents.on("render-process-gone", (_event, details) => logLifecycle("render-process-gone", details.reason));
  window.webContents.on("destroyed", () => logLifecycle("webContents destroyed"));
  window.webContents.on("unresponsive", () => logLifecycle("renderer unresponsive"));
  window.webContents.on("responsive", () => logLifecycle("renderer responsive again"));
  window.webContents.on("did-finish-load", () => logLifecycle("did-finish-load"));
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription) =>
    logLifecycle("did-fail-load", `code=${errorCode} desc=${errorDescription}`)
  );

  // Local-only content, loaded via Electron's own safe local-file API — never a remote URL,
  // never localhost, never a `data:` URL. `loadFile` resolves and encodes the path itself,
  // avoiding manual `file://` URL construction edge cases.
  void window.loadFile(path.join(__dirname, "renderer.html"));

  // Confirms, with a real number rather than an assumption, that the listeners just registered
  // above are actually attached to this live BrowserWindow/webContents pair — addresses this
  // pass's explicit requirement to verify listeners are attached to the EXECUTING object, not
  // merely present in source. `eventNames()` returns every event name with at least one
  // listener currently attached.
  logLifecycle(
    "listener registration confirmed",
    `window=${window.eventNames().length} webContents=${window.webContents.eventNames().length}`
  );

  return window;
}

/**
 * Registers every implemented workspace IPC handler. Each is a thin delegate to its own
 * electron/workspace*.ts service module — no filesystem/Git/terminal/token logic lives here
 * or anywhere else in this file. `listEntries`/`readTextFile`/`searchText` accept exactly one
 * caller-supplied string argument (a relative path or a search query); any non-string value
 * received over IPC is rejected here, before it ever reaches a service module, since the main
 * process must never trust a renderer-supplied argument's type.
 */
function registerWorkspaceIpcHandlers(window: BrowserWindow): void {
  ipcMain.handle(WORKSPACE_IPC_CHANNELS.WORKSPACE_PICK_DIRECTORY, () => pickDirectory(window));
  ipcMain.handle(WORKSPACE_IPC_CHANNELS.WORKSPACE_GET_CURRENT, () => getCurrent());
  ipcMain.handle(WORKSPACE_IPC_CHANNELS.WORKSPACE_CLEAR_CURRENT, () => clearCurrent());
  ipcMain.handle(WORKSPACE_IPC_CHANNELS.WORKSPACE_LIST, (_event, relativePath: unknown) =>
    listEntries(typeof relativePath === "string" ? relativePath : "")
  );
  ipcMain.handle(WORKSPACE_IPC_CHANNELS.WORKSPACE_READ_TEXT, (_event, relativePath: unknown) =>
    readTextFile(typeof relativePath === "string" ? relativePath : "")
  );
  ipcMain.handle(WORKSPACE_IPC_CHANNELS.WORKSPACE_SEARCH, (_event, query: unknown) => searchText(typeof query === "string" ? query : ""));
  ipcMain.handle(WORKSPACE_IPC_CHANNELS.WORKSPACE_GIT_SUMMARY, () => getGitSummary());
}

/**
 * Registers the four Hermes authorization IPC handlers — VYRON_CODE_V02_D08B_MEMORY_ONLY_HERMES_AUTHORIZATION_BOUNDARY_AUTHORIZATION.
 * Each is a thin delegate to electron/hermesAuthorization.ts, which owns the credential and
 * every validation rule; this file never inspects, logs, or forwards the request payload
 * itself — `beginAuthorization`'s raw `unknown` argument is passed straight through
 * unexamined, exactly as `hermesAuthorization.ts`'s own `validateAuthorizationRequest`
 * expects, so no second, weaker, or divergent validation exists here. No Hermes network,
 * health-check, session, prompt, or event handler is registered anywhere in this file.
 */
function registerHermesIpcHandlers(): void {
  ipcMain.handle(HERMES_IPC_CHANNELS.HERMES_GET_AVAILABILITY, () => getAvailability());
  ipcMain.handle(HERMES_IPC_CHANNELS.HERMES_GET_AUTHORIZATION_STATE, () => getAuthorizationState());
  ipcMain.handle(HERMES_IPC_CHANNELS.HERMES_BEGIN_AUTHORIZATION, (_event, request: unknown) => beginAuthorization(request));
  ipcMain.handle(HERMES_IPC_CHANNELS.HERMES_CLEAR_AUTHORIZATION, () => clearHermesAuthorization());
  // D-08C — connect/disconnect take no arguments at all; see electron/hermesConnection.ts's
  // own header for why connect() can never reach "connected" in this build (a disclosed,
  // reported trusted-endpoint-policy blocker, not an oversight).
  ipcMain.handle(HERMES_IPC_CHANNELS.HERMES_GET_CONNECTION_STATE, () => getConnectionState());
  ipcMain.handle(HERMES_IPC_CHANNELS.HERMES_CONNECT, () => connectHermes());
  ipcMain.handle(HERMES_IPC_CHANNELS.HERMES_DISCONNECT, () => disconnectHermes());
}

/**
 * `powerMonitor` events — VYRON_CODE_V02_A00_RUNTIME_EXIT_TRACE_COMPLETION_AND_STABILITY_FIX_AUTHORIZATION,
 * second pass. None of these had been instrumented before this pass. The observed exit timing
 * varied between live runs (~150s, then ~210s+) rather than landing on one fixed duration,
 * which the authorization itself notes rules out a fixed programmatic timeout — an OS power
 * event (display/system sleep, a lock screen, or a shutdown/logoff) is exactly the kind of
 * external condition whose timing would vary between runs depending on the machine's own power
 * plan and the user's exact interaction pattern, so it is instrumented here even though no
 * evidence yet implicates it specifically. Registered only after `app.whenReady()` resolves,
 * since `powerMonitor` is not guaranteed usable before then.
 */
function registerPowerMonitorDiagnostics(): void {
  powerMonitor.on("suspend", () => logLifecycle("powerMonitor suspend"));
  powerMonitor.on("resume", () => logLifecycle("powerMonitor resume"));
  powerMonitor.on("lock-screen", () => logLifecycle("powerMonitor lock-screen"));
  powerMonitor.on("unlock-screen", () => logLifecycle("powerMonitor unlock-screen"));
  powerMonitor.on("shutdown", () => logLifecycle("powerMonitor shutdown"));
}

/**
 * Bounded diagnostic heartbeat — logs an elapsed-time bucket every 30 seconds, purely to help
 * classify the observed ~3-minute self-exit defect against real elapsed time on the next
 * user-owned run. This is NOT a keep-alive mechanism: it does not call any Electron API, does
 * not prevent or delay shutdown in any way, and does nothing but log a fixed, safe string. It
 * self-clears after 20 minutes so a long-running dev session does not log indefinitely.
 */
function startLifecycleHeartbeat(): void {
  const startedAt = Date.now();
  const HEARTBEAT_MS = 30_000;
  const MAX_HEARTBEATS = 40; // 20 minutes
  let count = 0;
  const interval = setInterval(() => {
    count++;
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logLifecycle("heartbeat", `${elapsedSeconds}s`);
    if (count >= MAX_HEARTBEATS) clearInterval(interval);
  }, HEARTBEAT_MS);
}

// Logs a safe error-class-name breadcrumb, then preserves Node's own default fatal behavior
// (print-and-exit) by calling process.exit(1) explicitly — registering this handler at all
// replaces Node's built-in default handler, so exiting must be done manually here to avoid
// silently keeping the process alive after a genuine unexpected error (Section A.3 forbids
// "hiding a crash by swallowing all exceptions" — this logs, then still exits, never masks).
process.on("uncaughtException", (err) => {
  logLifecycle("uncaughtException", err instanceof Error ? err.constructor.name : typeof err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  logLifecycle("unhandledRejection", reason instanceof Error ? reason.constructor.name : typeof reason);
  process.exit(1);
});

/**
 * VYRON_CODE_V02_A00_RUNTIME_EXIT_TRACE_COMPLETION_AND_STABILITY_FIX_AUTHORIZATION.
 * `beforeExit` fires only when Node's own event loop has naturally gone idle with nothing
 * left to keep it alive — distinct from every event above, and from `exit`. `exit` is Node's
 * true last-chance, synchronous-only handler: it fires for virtually every voluntary shutdown
 * path (normal event-loop drain, any `process.exit()` call — including the ones above —
 * uncaught-exception termination, etc.), but does NOT fire if the OS forcibly terminates the
 * process (e.g. TerminateProcess on Windows, as an antivirus/security-policy kill of an
 * unsigned `npx`-launched binary would do). If a future run's terminal output shows heartbeats
 * stopping with NEITHER of these two lines ever appearing, that is strong evidence the process
 * was killed from outside Node/Electron entirely — not fixable by any change in this
 * repository's own source. `console.log` here is safe: Node's stdout is synchronous when
 * attached to a real Windows console (exactly this app's launch model, `npx electron ...` in
 * a visible PowerShell window), so the write reliably completes before the process ends.
 */
process.on("beforeExit", (code) => logLifecycle("process beforeExit", `code=${code}`));
process.on("exit", (code) => logLifecycle("process exit", `code=${code}`));

// Node's signal support is limited and platform-dependent on Windows (only SIGINT/SIGBREAK are
// reliably delivered there; SIGTERM/SIGHUP are registered defensively and are harmless if never
// fired on this platform). Registering a handler replaces Node's own default signal behavior,
// so each one logs, then calls process.exit(0) itself to preserve the default "signal received
// → exit" outcome rather than silently keeping the process alive.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
  process.on(signal, () => {
    logLifecycle("process signal", signal);
    process.exit(0);
  });
}

app.on("ready", () => logLifecycle("app ready (event)"));
app.on("activate", () => logLifecycle("app activate"));
// GPU/utility/zygote child-process crashes are an `app`-level event, distinct from
// `webContents`'s own `render-process-gone` above (which covers only the renderer itself).
app.on("child-process-gone", (_event, details) => logLifecycle("child-process-gone", `${details.type}/${details.reason}`));

app.whenReady().then(() => {
  mainWindow = createMainWindow();
  registerWorkspaceIpcHandlers(mainWindow);
  registerHermesIpcHandlers();
  registerPowerMonitorDiagnostics();
  startLifecycleHeartbeat();
  // Same listener-attachment confirmation as createMainWindow()'s own, but for every `app`-
  // level and `powerMonitor`-level listener registered anywhere in this file — a real count
  // from the live objects, not an assumption that source-level registration succeeded.
  logLifecycle("app-level listener registration confirmed", `app=${app.eventNames().length} powerMonitor=${powerMonitor.eventNames().length}`);
});

app.on("before-quit", () => logLifecycle("before-quit"));
app.on("will-quit", () => logLifecycle("will-quit"));
// `quit` fires AFTER the app has finished quitting, immediately before the process itself
// ends — the terminal Electron-level event in the shutdown sequence, distinct from
// `will-quit` (fires before) and not previously instrumented.
app.on("quit", (_event, exitCode) => logLifecycle("quit", `exitCode=${exitCode}`));

app.on("window-all-closed", () => {
  logLifecycle("window-all-closed");
  if (process.platform !== "darwin") app.quit();
});

/**
 * Confirms, with real values rather than an assumption, whether this process has a parent-
 * established IPC channel (the mechanism Node's own `child_process.fork()` uses for a parent
 * to monitor/signal a child) — addresses this pass's explicit requirement to determine whether
 * execution runs under an external bounded parent/job/process environment. `npx electron ...`
 * launched directly in an interactive PowerShell session is not expected to set one up, so
 * both values are expected to be `false`/`undefined`; logging them turns that expectation into
 * a directly observed fact for the next run instead of an assumption.
 */
logLifecycle("process parent-channel check", `connected=${process.connected} hasSend=${typeof process.send === "function"}`);
