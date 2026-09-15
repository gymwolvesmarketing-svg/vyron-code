import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Source-text structural checks, matching this codebase's established convention for
// electron/*.ts files that cannot be meaningfully unit-tested by execution without a real
// Electron runtime (see tests/electronSecurityScaffold.test.ts's own stripComments-based
// tests). VYRON_CODE_V02_A00_RUNTIME_EXIT_TRACE_COMPLETION_AND_STABILITY_FIX_AUTHORIZATION.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const source = fs.readFileSync(path.join(__dirname, "..", "electron", "main.ts"), "utf8");
const stripped = stripComments(source);

describe("electron/main.ts — BrowserWindow lifetime/reference policy", () => {
  it("declares mainWindow as an explicit, top-level, module-scope variable (not only a local inside a callback)", () => {
    expect(stripped).toMatch(/^let mainWindow: BrowserWindow \| null = null;/m);
  });

  it("assigns the created window to that top-level variable inside app.whenReady().then(...)", () => {
    const readyBlock = /app\.whenReady\(\)\.then\(\(\) => \{[\s\S]*?\}\);/.exec(stripped)?.[0] ?? "";
    expect(readyBlock).toMatch(/mainWindow = createMainWindow\(\);/);
  });
});

describe("electron/main.ts — exactly one intentional quit path, no finite-lifetime/auto-quit condition", () => {
  it("calls app.quit() exactly once, from window-all-closed only", () => {
    const quitCalls = stripped.match(/app\.quit\(\)/g) ?? [];
    expect(quitCalls).toHaveLength(1);
    const windowAllClosedBlock = /app\.on\("window-all-closed", \(\) => \{[\s\S]*?\}\);/.exec(stripped)?.[0] ?? "";
    expect(windowAllClosedBlock).toMatch(/app\.quit\(\)/);
  });

  it("the diagnostic heartbeat never calls app.quit/app.exit/process.exit/window close or destroy", () => {
    const heartbeatBody = /function startLifecycleHeartbeat\(\): void \{[\s\S]*?\n\}/.exec(stripped)?.[0] ?? "";
    expect(heartbeatBody.length).toBeGreaterThan(0); // sanity: the function was actually found
    for (const forbidden of [/app\.quit/, /app\.exit/, /process\.exit/, /\.close\(/, /\.destroy\(/]) {
      expect(heartbeatBody).not.toMatch(forbidden);
    }
  });

  it("the heartbeat is bounded (self-clears) rather than running forever", () => {
    expect(stripped).toMatch(/MAX_HEARTBEATS/);
    expect(stripped).toMatch(/clearInterval\(interval\)/);
  });

  it("contains no other setInterval/setTimeout besides the one bounded heartbeat interval", () => {
    const intervalCalls = stripped.match(/setInterval\(/g) ?? [];
    const timeoutCalls = stripped.match(/setTimeout\(/g) ?? [];
    expect(intervalCalls).toHaveLength(1);
    expect(timeoutCalls).toHaveLength(0);
  });

  it("uncaughtException/unhandledRejection/signal handlers preserve default fatal behavior (still call process.exit) rather than silently swallowing the condition", () => {
    const exceptionBlock = /process\.on\("uncaughtException", \(err\) => \{[\s\S]*?\}\);/.exec(stripped)?.[0] ?? "";
    const rejectionBlock = /process\.on\("unhandledRejection", \(reason\) => \{[\s\S]*?\}\);/.exec(stripped)?.[0] ?? "";
    expect(exceptionBlock).toMatch(/process\.exit\(1\)/);
    expect(rejectionBlock).toMatch(/process\.exit\(1\)/);
    // Signal handlers loop — the file declares the SIGINT/SIGTERM/SIGHUP/SIGBREAK loop
    // immediately before its own process.on(signal, ...) registration, which itself must
    // call process.exit(0) rather than leaving the process silently alive after a signal.
    expect(stripped).toMatch(/\["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"\][\s\S]{0,200}process\.exit\(0\)/);
  });
});

describe("electron/main.ts — lifecycle diagnostics are bounded and safe", () => {
  it("registers a diagnostic listener for every lifecycle event this task's authorization required", () => {
    const requiredEvents = [
      'app.on("ready"',
      'app.on("activate"',
      'app.on("before-quit"',
      'app.on("will-quit"',
      'app.on("quit"',
      'app.on("window-all-closed"',
      'app.on("child-process-gone"',
      'window.on("close"',
      'window.on("closed"',
      'window.on("query-session-end"',
      'window.on("session-end"',
      'webContents.on("render-process-gone"',
      'webContents.on("destroyed"',
      'webContents.on("unresponsive"',
      'webContents.on("responsive"',
      'webContents.on("did-fail-load"',
      'webContents.on("did-finish-load"',
      'powerMonitor.on("suspend"',
      'powerMonitor.on("resume"',
      'powerMonitor.on("lock-screen"',
      'powerMonitor.on("unlock-screen"',
      'powerMonitor.on("shutdown"',
      'process.on("beforeExit"',
      'process.on("exit"',
      'process.on("uncaughtException"',
      'process.on("unhandledRejection"',
    ];
    for (const needle of requiredEvents) {
      expect(stripped, `missing diagnostic for: ${needle}`).toContain(needle);
    }
  });

  it("registers signal handlers for SIGINT, SIGTERM, SIGHUP and SIGBREAK", () => {
    expect(stripped).toMatch(/\["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"\]/);
  });

  it("confirms real listener-attachment counts from the live window/webContents/app/powerMonitor objects, not just source-level registration", () => {
    expect(stripped).toMatch(/window\.eventNames\(\)\.length/);
    expect(stripped).toMatch(/webContents\.eventNames\(\)\.length/);
    expect(stripped).toMatch(/app\.eventNames\(\)\.length/);
    expect(stripped).toMatch(/powerMonitor\.eventNames\(\)\.length/);
  });

  it("logs whether this process has a parent-established IPC channel (child_process.fork-style monitoring)", () => {
    expect(stripped).toMatch(/process\.connected/);
    expect(stripped).toMatch(/typeof process\.send === "function"/);
  });

  it("registers powerMonitor diagnostics only after app.whenReady() resolves, not before", () => {
    const readyBlock = /app\.whenReady\(\)\.then\(\(\) => \{[\s\S]*?\}\);/.exec(stripped)?.[0] ?? "";
    expect(readyBlock).toMatch(/registerPowerMonitorDiagnostics\(\);/);
    // The powerMonitor.on(...) calls themselves live inside registerPowerMonitorDiagnostics's
    // own function body, never at bare top-level module-load time.
    const fnBody = /function registerPowerMonitorDiagnostics\(\): void \{[\s\S]*?\n\}/.exec(stripped)?.[0] ?? "";
    expect(fnBody).toMatch(/powerMonitor\.on\("suspend"/);
  });

  it("no logLifecycle call site ever passes a path/query/content-shaped variable", () => {
    // Grabs a fixed window of text after each `logLifecycle(` occurrence rather than trying to
    // precisely match balanced parens — several call sites legitimately contain their own
    // nested `()` (e.g. `.eventNames().length`), which a naive `[^)]*` capture would truncate
    // at the first nested `)` instead of the call's own closing paren.
    // Only flags the dangerous shape — a template-literal interpolation or a bare comma-
    // separated identifier argument referencing one of these variable names — never a mention
    // of the word inside a fixed, quoted label string (e.g. "window query-session-end (...)"
    // legitimately contains the substring "query" without passing any search-query data).
    const callSites = [...stripped.matchAll(/logLifecycle\(/g)].map((m) => stripped.slice(m.index, m.index + 250));
    expect(callSites.length).toBeGreaterThan(10);
    const dangerousNames = ["relativePath", "absolutePath", "canonicalRoot", "query", "content"];
    for (const name of dangerousNames) {
      const interpolated = new RegExp(`\\$\\{[^}]*\\b${name}\\b[^}]*\\}`);
      const bareArgument = new RegExp(`,\\s*${name}\\s*\\)`);
      for (const call of callSites) {
        expect(call).not.toMatch(interpolated);
        expect(call).not.toMatch(bareArgument);
      }
    }
  });

  it("logLifecycle is silent in a packaged build and disabled by default otherwise (VYRON_CODE_V02_A00 cleanup pass)", () => {
    const fnBody = /function logLifecycle\(label: string, safeDetail\?: string\): void \{[\s\S]*?\n\}/.exec(stripped)?.[0] ?? "";
    expect(fnBody).toMatch(/if \(app\.isPackaged \|\| !LIFECYCLE_DIAGNOSTICS_ENABLED\) return;/);
  });

  it("the diagnostics opt-in is derived from an explicit environment variable, disabled unless exactly \"1\"", () => {
    expect(stripped).toMatch(/const LIFECYCLE_DIAGNOSTICS_ENABLED = process\.env\.VYRON_LIFECYCLE_DEBUG === "1";/);
  });

  it("every logLifecycle call site is unreachable unless LIFECYCLE_DIAGNOSTICS_ENABLED is true — no second, ungated logging path exists", () => {
    // There is exactly one function that ever calls console.log for lifecycle purposes
    // (logLifecycle itself); every one of its ~30 call sites funnels through its single
    // `if (app.isPackaged || !LIFECYCLE_DIAGNOSTICS_ENABLED) return;` guard. This asserts no
    // OTHER bare `console.log` exists in the file that could bypass that gate.
    const consoleLogCalls = stripped.match(/console\.log\(/g) ?? [];
    expect(consoleLogCalls).toHaveLength(1); // the one inside logLifecycle's own body
  });
});
