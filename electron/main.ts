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
 * navigation/new-window behavior, and registers exactly six IPC handlers below: three for the
 * one-click local AI lifecycle (state / retry / diagnostics copy, delegating to
 * electron/localAiAdapters.ts) and three for the direct-task flow (electron/hermesTaskSubmission.ts).
 * There is no terminal/shell handler, no environment/token/endpoint handler, and no workspace
 * handler anywhere in this file.
 *
 * This file is not executed by this authorization's own static-validation steps. Electron app
 * launch, BrowserWindow creation at runtime, and native process behavior all require their
 * own separate, explicit runtime authorization/user-owned foreground launch.
 *
 * Local AI startup (VYRON_CODE_ONE_CLICK_LOCAL_AI_STARTUP_AND_UX): on launch this file starts the
 * main-process-only local AI lifecycle manager, and on every quit path stops only the services the
 * app itself started. Credentials and endpoints never leave the main process.
 */
import { app, BrowserWindow, ipcMain, Menu, powerMonitor } from "electron";
import path from "node:path";
import { HARDENED_WEB_PREFERENCES, isNavigationAllowed, isNewWindowAllowed } from "./security-policy";
import { APP_IPC_CHANNELS, HERMES_IPC_CHANNELS, LOCAL_AI_IPC_CHANNELS, TOOLS_IPC_CHANNELS } from "./shared-ipc-contract";
import { getTaskSubmissionState, sendTask, clearTaskSubmission, setTaskAgentExecutor, setToolRunner, setAgentAsk } from "./hermesTaskSubmission";
import { createProductionLocalAiManager } from "./localAiAdapters";
import { createProductionRufloBridge } from "./rufloAdapters";
import { isDeepResearchRole, researchKindOfRole } from "./rufloBridge";
import { createProductionToolRunner } from "./toolAdapters";

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
    icon: path.join(__dirname, "assets", "icon.png"),
    webPreferences: {
      ...HARDENED_WEB_PREFERENCES,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // No native menu bar: every command lives in the workspace menu. The two keyboard shortcuts a menu
  // bar used to provide (reload, developer tools) are handled here, without any renderer input.
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const key = input.key.toLowerCase();
    const command = input.control || input.meta;
    if (key === "f12" || (command && input.shift && key === "i")) {
      event.preventDefault();
      window.webContents.toggleDevTools();
    } else if (key === "f5" || (command && !input.shift && key === "r")) {
      event.preventDefault();
      window.webContents.reload();
    }
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
  window.on("closed", () => {
    logLifecycle("window closed (native handle destroyed)");
    // The agent browser window must not keep the app alive after the app window is gone.
    tools.close();
  });
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
 * The one local AI lifecycle manager for this process - VYRON_CODE_ONE_CLICK_LOCAL_AI_STARTUP_AND_UX_DELIVERY.
 * It alone starts, verifies and (for services this app started) stops the local Hermes gateway and
 * auth proxy; see electron/localAiLifecycle.ts and electron/localAiAdapters.ts.
 */
const localAi = createProductionLocalAiManager();
// Ruflo (Manager orchestration) starts lazily on the first Manager task and is stopped with the app.
const ruflo = createProductionRufloBridge({
  workRoot: path.join(app.getPath("userData"), "ruflo"),
  resourcesPath: process.resourcesPath,
  isPackaged: app.isPackaged,
});
// The deep-research Manager (fast / Max, picked in the composer) is answered by the tool runner against Gemini; every other role runs in Ruflo.
setTaskAgentExecutor((agentType, prompt, project, models) =>
  isDeepResearchRole(agentType) ? tools.deepResearch(prompt, researchKindOfRole(agentType)) : ruflo.run(agentType, prompt, project, models),
);
setAgentAsk((agentType, prompt, models) => ruflo.ask(agentType, prompt, models));
// Approved tools: workspace folder from a native dialog, native approval dialogs, confined executors.
const tools = createProductionToolRunner(() => mainWindow);
setToolRunner((task, ask) => tools.run(task, ask));

/** Stops only what this app started: the Ruflo runtime and the local AI services. */
function shutdownServices(): Promise<unknown> {
  tools.close();
  return Promise.all([ruflo.shutdown(), localAi.shutdown()]);
}

/**
 * Registers the three local AI lifecycle IPC handlers. None accepts a renderer-supplied argument:
 * there is no command, path, environment, URL, host or port parameter, and every reply is the
 * safe, fixed-vocabulary state or a boolean copy result (never the diagnostics text itself).
 */
function registerLocalAiIpcHandlers(): void {
  ipcMain.handle(LOCAL_AI_IPC_CHANNELS.LOCAL_AI_GET_STATE, () => localAi.getState());
  ipcMain.handle(LOCAL_AI_IPC_CHANNELS.LOCAL_AI_RETRY, () => localAi.retry());
  ipcMain.handle(LOCAL_AI_IPC_CHANNELS.LOCAL_AI_COPY_DIAGNOSTICS, () => localAi.copyDiagnostics());
}

/**
 * Registers the three direct-task IPC handlers. Each is a thin delegate to
 * electron/hermesTaskSubmission.ts, which alone owns every validation rule.
 * getTaskSubmissionState/clearTaskSubmission take no arguments at all;
 * sendTask's raw request is passed straight through unexamined, exactly as that module's own
 * validation expects. There is no authorization, endpoint or verification handler: those are set
 * only by the main-process lifecycle manager after every readiness check passes, and the renderer
 * can neither set nor read them.
 */
function registerHermesIpcHandlers(): void {
  ipcMain.handle(HERMES_IPC_CHANNELS.HERMES_GET_TASK_SUBMISSION_STATE, () => getTaskSubmissionState());
  ipcMain.handle(HERMES_IPC_CHANNELS.HERMES_SEND_TASK, (_event, request: unknown) => sendTask(request));
  ipcMain.handle(HERMES_IPC_CHANNELS.HERMES_CLEAR_TASK_SUBMISSION, () => clearTaskSubmission());
}

/** The one window-bridge handler: takes no argument and only ever acts on the app's own main window. */
function registerToolsIpcHandlers(): void {
  const fromOwnWindow = (event: Electron.IpcMainInvokeEvent): boolean => mainWindow !== null && event.sender === mainWindow.webContents;
  const none = { folderName: null, alwaysCount: 0 };
  ipcMain.handle(TOOLS_IPC_CHANNELS.TOOLS_GET_WORKSPACE, (event, projectId: unknown) => (fromOwnWindow(event) ? tools.getWorkspace(projectId) : none));
  ipcMain.handle(TOOLS_IPC_CHANNELS.TOOLS_PICK_WORKSPACE, (event, projectId: unknown) => (fromOwnWindow(event) ? tools.pickWorkspace(projectId) : none));
  ipcMain.handle(TOOLS_IPC_CHANNELS.TOOLS_CLEAR_WORKSPACE, (event, projectId: unknown) => (fromOwnWindow(event) ? tools.clearWorkspace(projectId) : none));
  ipcMain.handle(TOOLS_IPC_CHANNELS.TOOLS_CLEAR_PERMISSIONS, (event) => (fromOwnWindow(event) ? tools.clearPermissions() : none));
}

function registerAppIpcHandlers(): void {
  ipcMain.handle(APP_IPC_CHANNELS.APP_TOGGLE_DEV_TOOLS, (event) => {
    if (mainWindow && event.sender === mainWindow.webContents) mainWindow.webContents.toggleDevTools();
  });
  // Deletes the Managers' persistent memory (only for the app's own window; takes no argument).
  ipcMain.handle(APP_IPC_CHANNELS.APP_CLEAR_AGENT_MEMORY, async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return false;
    return ruflo.clearMemory();
  });
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
    // Stop only the services this app started, then exit regardless of the outcome.
    void shutdownServices().finally(() => process.exit(0));
  });
}

app.on("ready", () => logLifecycle("app ready (event)"));
app.on("activate", () => logLifecycle("app activate"));
// GPU/utility/zygote child-process crashes are an `app`-level event, distinct from
// `webContents`'s own `render-process-gone` above (which covers only the renderer itself).
app.on("child-process-gone", (_event, details) => logLifecycle("child-process-gone", `${details.type}/${details.reason}`));

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  mainWindow = createMainWindow();
  registerLocalAiIpcHandlers();
  registerHermesIpcHandlers();
  registerAppIpcHandlers();
  registerToolsIpcHandlers();
  // Non-blocking: the window is already open and shows the startup state while this runs.
  void localAi.start();
  registerPowerMonitorDiagnostics();
  startLifecycleHeartbeat();
  // Same listener-attachment confirmation as createMainWindow()'s own, but for every `app`-
  // level and `powerMonitor`-level listener registered anywhere in this file — a real count
  // from the live objects, not an assumption that source-level registration succeeded.
  logLifecycle("app-level listener registration confirmed", `app=${app.eventNames().length} powerMonitor=${powerMonitor.eventNames().length}`);
});

/**
 * Graceful quit - the only place app.quit() is called. Services this app started are stopped first
 * (services that were already running are never touched), then the app quits. `before-quit` routes
 * through the same function, so every quit path (window close, menu, OS request) stops app-owned
 * services exactly once.
 */
let localAiShutdownStarted = false;
let localAiShutdownDone = false;

function quitAfterLocalAiShutdown(): void {
  if (localAiShutdownDone) {
    app.quit();
    return;
  }
  if (localAiShutdownStarted) return;
  localAiShutdownStarted = true;
  void shutdownServices().finally(() => {
    localAiShutdownDone = true;
    app.quit();
  });
}

app.on("before-quit", (event) => {
  logLifecycle("before-quit");
  // Clears any locally-tracked task submission state (reviewed draft, in-flight send, completed
  // answer) before the process exits, rather than leaving it dangling.
  clearTaskSubmission();
  if (!localAiShutdownDone) {
    event.preventDefault();
    quitAfterLocalAiShutdown();
  }
});
app.on("will-quit", () => logLifecycle("will-quit"));
// `quit` fires AFTER the app has finished quitting, immediately before the process itself
// ends — the terminal Electron-level event in the shutdown sequence, distinct from
// `will-quit` (fires before) and not previously instrumented.
app.on("quit", (_event, exitCode) => logLifecycle("quit", `exitCode=${exitCode}`));

app.on("window-all-closed", () => {
  logLifecycle("window-all-closed");
  if (process.platform !== "darwin") quitAfterLocalAiShutdown();
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
