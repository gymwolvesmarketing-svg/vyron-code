import { describe, it, expect, vi, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { HARDENED_WEB_PREFERENCES, ALLOWED_NAVIGATION_ORIGINS, isNavigationAllowed, isNewWindowAllowed } from "../electron/security-policy";
import { FUTURE_IPC_CHANNELS, WORKSPACE_IPC_CHANNELS, HERMES_IPC_CHANNELS } from "../electron/shared-ipc-contract";

// Strips block (/** ... */, /* ... */) and line (// ...) comments before pattern-matching
// source text, so structural checks below reflect actual code — not this codebase's own doc
// comments explaining, in prose, which patterns are deliberately absent (which would
// otherwise self-trigger a naive substring/regex check).
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("HARDENED_WEB_PREFERENCES — BrowserWindow security policy", () => {
  it("sets contextIsolation true", () => {
    expect(HARDENED_WEB_PREFERENCES.contextIsolation).toBe(true);
  });

  it("sets nodeIntegration false", () => {
    expect(HARDENED_WEB_PREFERENCES.nodeIntegration).toBe(false);
  });

  it("sets sandbox true", () => {
    expect(HARDENED_WEB_PREFERENCES.sandbox).toBe(true);
  });

  it("sets webSecurity true", () => {
    expect(HARDENED_WEB_PREFERENCES.webSecurity).toBe(true);
  });

  it("disables webviewTag", () => {
    expect(HARDENED_WEB_PREFERENCES.webviewTag).toBe(false);
  });

  it("disables allowRunningInsecureContent", () => {
    expect(HARDENED_WEB_PREFERENCES.allowRunningInsecureContent).toBe(false);
  });

  it("never declares enableRemoteModule as true", () => {
    // Absent, or explicitly false — never true. `in` covers both "not present" and "present: false".
    if ("enableRemoteModule" in HARDENED_WEB_PREFERENCES) {
      expect((HARDENED_WEB_PREFERENCES as Record<string, unknown>).enableRemoteModule).not.toBe(true);
    }
  });
});

describe("Navigation policy — deny-by-default", () => {
  it("starts with zero approved navigation origins", () => {
    expect(ALLOWED_NAVIGATION_ORIGINS).toHaveLength(0);
  });

  it("denies navigation to any arbitrary URL, including plausible-looking local ones", () => {
    for (const url of ["https://example.com", "http://127.0.0.1:3055/", "file:///C:/secrets.txt", ""]) {
      expect(isNavigationAllowed(url)).toBe(false);
    }
  });
});

describe("New-window policy — deny-by-default", () => {
  it("denies new-window creation for any URL", () => {
    for (const url of ["https://example.com", "about:blank", ""]) {
      expect(isNewWindowAllowed(url)).toBe(false);
    }
  });
});

describe("FUTURE_IPC_CHANNELS — declared but never wired", () => {
  it("is a plain, frozen-shape set of channel-name strings only (no function/handler values)", () => {
    for (const value of Object.values(FUTURE_IPC_CHANNELS)) {
      expect(typeof value).toBe("string");
    }
  });

  it("still reserves workspace:clearRecent as a distinct, future-only D-07 concept", () => {
    expect(FUTURE_IPC_CHANNELS.WORKSPACE_CLEAR_RECENT).toBe("workspace:clearRecent");
  });

  it("never conflates clearRecent with the D-03 clearCurrent channel", () => {
    expect(FUTURE_IPC_CHANNELS.WORKSPACE_CLEAR_RECENT).not.toBe(WORKSPACE_IPC_CHANNELS.WORKSPACE_CLEAR_CURRENT);
  });
});

describe("WORKSPACE_IPC_CHANNELS — implemented channels (D-03 + Milestone A)", () => {
  it("exposes exactly the seven implemented workspace channels, no more", () => {
    expect(Object.values(WORKSPACE_IPC_CHANNELS).sort()).toEqual(
      [
        "workspace:clearCurrent",
        "workspace:getCurrent",
        "workspace:gitSummary",
        "workspace:list",
        "workspace:pickDirectory",
        "workspace:readText",
        "workspace:search",
      ].sort()
    );
  });
});

describe("HERMES_IPC_CHANNELS — implemented channels (D-08B + D-08C + D-08E)", () => {
  it("exposes exactly the ten implemented Hermes channels, no more", () => {
    expect(Object.values(HERMES_IPC_CHANNELS).sort()).toEqual(
      [
        "hermes:beginAuthorization",
        "hermes:clearAuthorization",
        "hermes:getAuthorizationState",
        "hermes:getAvailability",
        "hermes:getConnectionState",
        "hermes:connect",
        "hermes:disconnect",
        "hermes:getEndpointConfigurationState",
        "hermes:configureEndpoint",
        "hermes:clearEndpointConfiguration",
      ].sort()
    );
  });

  it("shares no channel name with WORKSPACE_IPC_CHANNELS — a distinct, independent namespace", () => {
    const workspaceChannels = new Set(Object.values(WORKSPACE_IPC_CHANNELS));
    for (const channel of Object.values(HERMES_IPC_CHANNELS)) {
      expect(workspaceChannels.has(channel as never)).toBe(false);
    }
  });
});

// electron/preload.ts calls contextBridge.exposeInMainWorld at module load time — mocking
// "electron" (this codebase's established vi.mock convention, see tests/contextPayload.test.ts)
// lets the module load safely under plain Node/vitest without a real Electron runtime. The
// exposed API is captured into a plain closure variable (not read back from `.mock.calls`),
// since this project's vitest config clears mock call-history between tests — a plain
// variable survives that, a `vi.fn()`'s own call history does not.
let capturedName: string | undefined;
let capturedApi: Record<string, unknown> | undefined;
const exposeInMainWorld = vi.fn((name: string, api: Record<string, unknown>) => {
  capturedName = name;
  capturedApi = api;
});
const ipcRendererInvoke = vi.fn();
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke: ipcRendererInvoke },
}));

describe("preload.ts — exposed window.vyronDesktop API", () => {
  let callCountAtImport = 0;
  beforeAll(async () => {
    await import("../electron/preload");
    // Read immediately, before this suite's first `it` triggers a mock-history clear.
    callCountAtImport = exposeInMainWorld.mock.calls.length;
  });

  function exposedApi(): Record<string, unknown> {
    if (!capturedApi) throw new Error("electron/preload.ts did not call contextBridge.exposeInMainWorld");
    return capturedApi;
  }

  it("exposes exactly one global, named 'vyronDesktop', via contextBridge only", () => {
    expect(callCountAtImport).toBe(1);
    expect(capturedName).toBe("vyronDesktop");
    expect(capturedApi).toEqual(expect.any(Object));
  });

  it("has no generic invoke/send/on method and no raw ipcRenderer reference at the top level", () => {
    const api = exposedApi();
    for (const forbiddenKey of ["invoke", "send", "on", "ipcRenderer", "sendSync", "postMessage"]) {
      expect(api).not.toHaveProperty(forbiddenKey);
    }
  });

  it("declares workspacePicker, workspaceRead, workspaceSearch and gitSummary available (Milestone A)", () => {
    const capabilities = exposedApi().capabilities as Record<string, unknown>;
    expect(capabilities.workspacePicker).toBe(true);
    expect(capabilities.workspaceRead).toBe(true);
    expect(capabilities.workspaceSearch).toBe(true);
    expect(capabilities.gitSummary).toBe(true);
  });

  it("exposes exactly the seven Milestone A workspace methods, no more", () => {
    const workspace = exposedApi().workspace as Record<string, unknown>;
    expect(Object.keys(workspace).sort()).toEqual(
      ["clearCurrent", "getCurrent", "getGitSummary", "listEntries", "pickDirectory", "readTextFile", "searchText"]
    );
    for (const method of Object.values(workspace)) {
      expect(typeof method).toBe("function");
    }
  });

  it("the four parameter-free grant/summary methods invoke exactly one fixed channel, with no arguments forwarded", () => {
    const workspace = exposedApi().workspace as Record<string, (...args: unknown[]) => unknown>;
    ipcRendererInvoke.mockClear();
    workspace.pickDirectory?.();
    workspace.getCurrent?.();
    workspace.clearCurrent?.();
    workspace.getGitSummary?.();
    expect(ipcRendererInvoke).toHaveBeenCalledTimes(4);
    const calledChannels = ipcRendererInvoke.mock.calls.map((call) => call[0]).sort();
    expect(calledChannels).toEqual(
      ["workspace:clearCurrent", "workspace:getCurrent", "workspace:gitSummary", "workspace:pickDirectory"].sort()
    );
    // Every call was made with exactly one argument (the channel) — no second/third argument
    // (e.g. a path) was ever forwarded from the renderer.
    for (const call of ipcRendererInvoke.mock.calls) {
      expect(call).toHaveLength(1);
    }
  });

  it("the three path/query-taking methods forward exactly the channel plus the caller's own single argument, verbatim", () => {
    const workspace = exposedApi().workspace as Record<string, (...args: unknown[]) => unknown>;
    ipcRendererInvoke.mockClear();
    workspace.listEntries?.("src/sub");
    workspace.readTextFile?.("src/sub/file.ts");
    workspace.searchText?.("needle");
    expect(ipcRendererInvoke).toHaveBeenCalledTimes(3);
    expect(ipcRendererInvoke).toHaveBeenNthCalledWith(1, "workspace:list", "src/sub");
    expect(ipcRendererInvoke).toHaveBeenNthCalledWith(2, "workspace:readText", "src/sub/file.ts");
    expect(ipcRendererInvoke).toHaveBeenNthCalledWith(3, "workspace:search", "needle");
    // Never a third argument — the renderer cannot smuggle any additional payload through.
    for (const call of ipcRendererInvoke.mock.calls) {
      expect(call).toHaveLength(2);
    }
  });

  it("exposes no absolute-path field, filesystem handle, or native-dialog object anywhere", () => {
    const api = exposedApi();
    const serialized = JSON.stringify(api, (_key, value) => (typeof value === "function" ? "[function]" : value));
    for (const forbiddenSubstring of ["C:\\", "C:/", "\\\\", "dialog", "BrowserWindow", "filePaths"]) {
      expect(serialized).not.toContain(forbiddenSubstring);
    }
  });

  it("declares no terminal capability", () => {
    expect((exposedApi().capabilities as Record<string, unknown>).terminal).toBe(false);
  });

  it("declares no file-write capability", () => {
    expect((exposedApi().capabilities as Record<string, unknown>).fileWrite).toBe(false);
  });

  it("declares no Git-write capability (distinct from the now-true, read-only gitSummary capability)", () => {
    const capabilities = exposedApi().capabilities as Record<string, unknown>;
    expect(capabilities.gitWrite).toBe(false);
    expect(capabilities.gitSummary).toBe(true);
  });

  it("declares no multimodel-start capability", () => {
    expect((exposedApi().capabilities as Record<string, unknown>).multimodelStart).toBe(false);
  });

  it("declares no token/environment exposure of any kind", () => {
    const api = exposedApi();
    expect((api.capabilities as Record<string, unknown>).hermesTokenStorage).toBe(false);
    for (const forbiddenKey of ["token", "env", "environment", "process", "credentials"]) {
      expect(api).not.toHaveProperty(forbiddenKey);
    }
  });

  it("exposes exactly the ten Hermes methods, no more (D-08B + D-08C + D-08E)", () => {
    const hermes = exposedApi().hermes as Record<string, unknown>;
    expect(Object.keys(hermes).sort()).toEqual(
      [
        "beginAuthorization",
        "clearAuthorization",
        "getAuthorizationState",
        "getAvailability",
        "getConnectionState",
        "connect",
        "disconnect",
        "getEndpointConfigurationState",
        "configureEndpoint",
        "clearEndpointConfiguration",
      ].sort()
    );
    for (const method of Object.values(hermes)) {
      expect(typeof method).toBe("function");
    }
  });

  it("connect and disconnect take no arguments at all — no endpoint/host/port/options object can be forwarded (D-08C, T-14)", () => {
    const hermes = exposedApi().hermes as Record<string, (...args: unknown[]) => unknown>;
    ipcRendererInvoke.mockClear();
    hermes.connect?.();
    hermes.disconnect?.();
    expect(ipcRendererInvoke).toHaveBeenCalledTimes(2);
    for (const call of ipcRendererInvoke.mock.calls) {
      expect(call).toHaveLength(1);
    }
    expect(ipcRendererInvoke).toHaveBeenNthCalledWith(1, "hermes:connect");
    expect(ipcRendererInvoke).toHaveBeenNthCalledWith(2, "hermes:disconnect");
  });

  it("getConnectionState invokes exactly its own fixed channel, with no arguments", () => {
    const hermes = exposedApi().hermes as Record<string, (...args: unknown[]) => unknown>;
    ipcRendererInvoke.mockClear();
    hermes.getConnectionState?.();
    expect(ipcRendererInvoke).toHaveBeenCalledTimes(1);
    expect(ipcRendererInvoke).toHaveBeenNthCalledWith(1, "hermes:getConnectionState");
  });

  it("getEndpointConfigurationState and clearEndpointConfiguration take no arguments at all (D-08E, T-14)", () => {
    const hermes = exposedApi().hermes as Record<string, (...args: unknown[]) => unknown>;
    ipcRendererInvoke.mockClear();
    hermes.getEndpointConfigurationState?.();
    hermes.clearEndpointConfiguration?.();
    expect(ipcRendererInvoke).toHaveBeenCalledTimes(2);
    for (const call of ipcRendererInvoke.mock.calls) {
      expect(call).toHaveLength(1);
    }
    expect(ipcRendererInvoke).toHaveBeenNthCalledWith(1, "hermes:getEndpointConfigurationState");
    expect(ipcRendererInvoke).toHaveBeenNthCalledWith(2, "hermes:clearEndpointConfiguration");
  });

  it("configureEndpoint forwards exactly the channel plus the caller's own single-field request object, verbatim, and nothing else", () => {
    const hermes = exposedApi().hermes as Record<string, (...args: unknown[]) => unknown>;
    ipcRendererInvoke.mockClear();
    const request = { endpoint: "ws://127.0.0.1:19130/api/ws" };
    hermes.configureEndpoint?.(request);
    expect(ipcRendererInvoke).toHaveBeenCalledTimes(1);
    expect(ipcRendererInvoke).toHaveBeenNthCalledWith(1, "hermes:configureEndpoint", request);
    expect(ipcRendererInvoke.mock.calls[0]).toHaveLength(2);
  });

  it("has no generic invoke/send/on method and no raw ipcRenderer reference on the hermes namespace either", () => {
    const hermes = exposedApi().hermes as Record<string, unknown>;
    for (const forbiddenKey of ["invoke", "send", "on", "ipcRenderer", "sendSync", "postMessage"]) {
      expect(hermes).not.toHaveProperty(forbiddenKey);
    }
  });

  it("the three parameter-free Hermes methods invoke exactly their own fixed channel, with no arguments forwarded", () => {
    const hermes = exposedApi().hermes as Record<string, (...args: unknown[]) => unknown>;
    ipcRendererInvoke.mockClear();
    hermes.getAvailability?.();
    hermes.getAuthorizationState?.();
    hermes.clearAuthorization?.();
    expect(ipcRendererInvoke).toHaveBeenCalledTimes(3);
    const calledChannels = ipcRendererInvoke.mock.calls.map((call) => call[0]).sort();
    expect(calledChannels).toEqual(["hermes:clearAuthorization", "hermes:getAuthorizationState", "hermes:getAvailability"].sort());
    for (const call of ipcRendererInvoke.mock.calls) {
      expect(call).toHaveLength(1);
    }
  });

  it("beginAuthorization forwards exactly the channel plus the caller's own request object, verbatim, and nothing else", () => {
    const hermes = exposedApi().hermes as Record<string, (...args: unknown[]) => unknown>;
    ipcRendererInvoke.mockClear();
    const request = { credential: "placeholder-test-credential-value" };
    hermes.beginAuthorization?.(request);
    expect(ipcRendererInvoke).toHaveBeenCalledTimes(1);
    expect(ipcRendererInvoke).toHaveBeenNthCalledWith(1, "hermes:beginAuthorization", request);
    expect(ipcRendererInvoke.mock.calls[0]).toHaveLength(2);
  });

  it("its local Hermes channel-name duplicates match shared-ipc-contract.ts's canonical HERMES_IPC_CHANNELS exactly", () => {
    const hermes = exposedApi().hermes as Record<string, (...args: unknown[]) => unknown>;
    ipcRendererInvoke.mockClear();
    hermes.getAvailability?.();
    expect(ipcRendererInvoke).toHaveBeenNthCalledWith(1, HERMES_IPC_CHANNELS.HERMES_GET_AVAILABILITY);
  });
});

describe("electron/preload.ts — no runtime relative local import (D-03 bridge-injection fix)", () => {
  // VYRON_CODE_V02_D03_PRELOAD_BRIDGE_INJECTION_DIAGNOSTIC_AND_FIX_AUTHORIZATION regression
  // test. preload.ts runs in a sandboxed preload context with more limited APIs than a
  // normal Node/Electron main-process module (per Electron's own bundled type declarations).
  // It previously imported `WORKSPACE_IPC_CHANNELS`/`DesktopApi` from
  // "./shared-ipc-contract", compiling to a runtime `require("./shared-ipc-contract")` — the
  // one remaining structural difference between this file and every other electron/*.ts file
  // known to load correctly. This test asserts the source-level invariant that removes that
  // difference: preload.ts must import only from Electron's own built-in module, never a
  // relative local file.
  const source = fs.readFileSync(path.join(__dirname, "..", "electron", "preload.ts"), "utf8");
  const stripped = stripComments(source);

  it("imports only from the 'electron' built-in module — no relative local import of any kind", () => {
    const importLines = stripped.match(/^\s*import\b.*$/gm) ?? [];
    expect(importLines.length).toBeGreaterThan(0);
    for (const line of importLines) {
      expect(line).not.toMatch(/from ["']\.\//);
    }
  });

  it("still declares the DesktopApi/WorkspaceGrantState shapes it needs, locally", () => {
    expect(stripped).toMatch(/interface DesktopApi/);
    expect(stripped).toMatch(/interface WorkspaceGrantState/);
  });

  it("duplicates the exact D-03 channel-name string literals, not a re-derived or computed value", () => {
    expect(stripped).toContain('"workspace:pickDirectory"');
    expect(stripped).toContain('"workspace:getCurrent"');
    expect(stripped).toContain('"workspace:clearCurrent"');
  });

  it("its local channel-name duplicates match shared-ipc-contract.ts's canonical WORKSPACE_IPC_CHANNELS exactly", () => {
    // Cross-checks against the real, canonical source of truth. This test file itself is not
    // constrained by the sandboxed-preload runtime, so importing it here (only to compare
    // string values, never re-exported or re-used at preload runtime) is safe.
    expect(WORKSPACE_IPC_CHANNELS.WORKSPACE_PICK_DIRECTORY).toBe("workspace:pickDirectory");
    expect(WORKSPACE_IPC_CHANNELS.WORKSPACE_GET_CURRENT).toBe("workspace:getCurrent");
    expect(WORKSPACE_IPC_CHANNELS.WORKSPACE_CLEAR_CURRENT).toBe("workspace:clearCurrent");
  });
});

describe("Electron scaffold source — no shell/child_process execution capability", () => {
  const electronDir = path.join(__dirname, "..", "electron");
  const sourceFiles = fs.readdirSync(electronDir).filter((f) => f.endsWith(".ts"));
  // `ipcRenderer` is legitimate, expected, and the ONLY place it should ever appear:
  // electron/preload.ts, wrapped in the three fixed workspace.* closures (see the dedicated
  // "workspace methods are parameter-free" test above). Every other file must never reference
  // it — that would mean a second, uncontrolled IPC surface exists.
  const FILES_ALLOWED_IPC_RENDERER = new Set(["preload.ts"]);
  // These four workspace-service modules legitimately need direct `fs` access for their own
  // bounded, read-only operations (directory listing, bounded text reads, `.git/HEAD`/
  // `.git/index` reads) — but only AFTER every path has already been validated through
  // `workspaceAccess.ts`'s `resolveWorkspacePath` (built on `lib/canonicalPath.ts`'s
  // `resolveCanonicalPath`), never as a parallel/weaker path-safety check of their own. This
  // matches the same pattern `lib/search.ts` already uses for the web app.
  const FILES_ALLOWED_DIRECT_FS = new Set(["workspaceExplorer.ts", "workspaceFileViewer.ts", "workspaceSearch.ts", "workspaceGit.ts"]);
  const forbiddenPatterns: Array<[string, RegExp, (file: string) => boolean]> = [
    ["child_process import", /child_process/, () => true],
    ["exec( call", /\bexec\s*\(/, () => true],
    ["spawn( call", /\bspawn\s*\(/, () => true],
    ["fork( call", /\bfork\s*\(/, () => true],
    ["shell.openPath", /shell\.openPath/, () => true],
    ["shell.openExternal", /shell\.openExternal/, () => true],
    ["@electron/remote", /@electron\/remote/, () => true],
    ["ipcRenderer reference", /ipcRenderer/, (file) => !FILES_ALLOWED_IPC_RENDERER.has(file)],
    ["fetch( call", /\bfetch\s*\(/, () => true],
    ["XMLHttpRequest", /XMLHttpRequest/, () => true],
    [
      "direct node:fs import (must go through workspaceAccess.ts/lib/canonicalPath.ts for path validation first)",
      /from ["']node:fs["']|from ["']fs["']/,
      (file) => !FILES_ALLOWED_DIRECT_FS.has(file),
    ],
  ];

  it.each(sourceFiles)("%s contains no forbidden shell/child_process/remote/fs pattern for its file type", (file) => {
    const code = stripComments(fs.readFileSync(path.join(electronDir, file), "utf8"));
    for (const [label, pattern, appliesTo] of forbiddenPatterns) {
      if (!appliesTo(file)) continue;
      expect(pattern.test(code), `${file} unexpectedly matched: ${label}`).toBe(false);
    }
  });

  it("confirms exactly the fifteen expected scaffold .ts files exist, no more", () => {
    expect(sourceFiles.sort()).toEqual(
      [
        "hermesAuthorization.ts",
        "hermesConnection.ts",
        "hermesEndpoint.ts",
        "hermesEndpointSetup.ts",
        "main.ts",
        "preload.ts",
        "renderer.ts",
        "security-policy.ts",
        "shared-ipc-contract.ts",
        "workspace-grant.ts",
        "workspaceAccess.ts",
        "workspaceExplorer.ts",
        "workspaceFileViewer.ts",
        "workspaceGit.ts",
        "workspaceSearch.ts",
      ].sort()
    );
  });

  it("workspace-grant.ts imports only the existing shared canonical-path validation, never a parallel implementation", () => {
    const code = stripComments(fs.readFileSync(path.join(electronDir, "workspace-grant.ts"), "utf8"));
    expect(code).toMatch(/from ["']\.\.\/lib\/canonicalPath["']/);
    expect(code).toMatch(/resolveCanonicalRoot/);
    expect(code).toMatch(/checkRootPolicy/);
  });

  it.each(["workspaceExplorer.ts", "workspaceFileViewer.ts", "workspaceSearch.ts"])(
    "%s validates every path through workspaceAccess.ts's resolveWorkspacePath before touching fs",
    (file) => {
      const code = stripComments(fs.readFileSync(path.join(electronDir, file), "utf8"));
      expect(code).toMatch(/from ["']\.\/workspaceAccess["']/);
      expect(code).toMatch(/resolveWorkspacePath/);
    }
  );

  it("workspaceGit.ts validates every working-tree path through resolveWorkspacePath, and only reads .git/HEAD and .git/index directly by name", () => {
    const code = stripComments(fs.readFileSync(path.join(electronDir, "workspaceGit.ts"), "utf8"));
    expect(code).toMatch(/from ["']\.\/workspaceAccess["']/);
    expect(code).toMatch(/resolveWorkspacePath/);
    expect(code).toMatch(/getCurrentCanonicalRoot/);
    expect(code).toContain('"HEAD"');
    expect(code).toContain('"index"');
  });

  it("workspaceAccess.ts is the sole place getCurrentCanonicalRoot is imported outside workspace-grant.ts itself and electron/main.ts", () => {
    // main.ts never imports getCurrentCanonicalRoot at all (it has no fs-touching handler of
    // its own); workspaceGit.ts is the one deliberate, narrowly-scoped exception that also
    // imports it directly (to read .git/HEAD and .git/index, which resolveWorkspacePath's own
    // canonicalPath validation would otherwise deny by name — see workspaceGit.ts's own
    // header comment).
    const mainCode = stripComments(fs.readFileSync(path.join(electronDir, "main.ts"), "utf8"));
    expect(mainCode).not.toMatch(/getCurrentCanonicalRoot/);
  });
});

describe("electron/hermesAuthorization.ts — no persistence/network/logging/import capability (D-08B)", () => {
  const filePath = path.join(__dirname, "..", "electron", "hermesAuthorization.ts");
  const rawSource = fs.readFileSync(filePath, "utf8");
  const code = stripComments(rawSource);

  it("imports nothing from 'electron' or any node:* built-in — types-only import from shared-ipc-contract.ts is the sole import", () => {
    const importLines = code.match(/^\s*import\b.*$/gm) ?? [];
    expect(importLines.length).toBe(1);
    expect(importLines[0]).toMatch(/from ["']\.\/shared-ipc-contract["']/);
    expect(importLines[0]).toMatch(/^\s*import type\b/);
  });

  it("has no console/network/persistence/safeStorage/environment/filesystem access of any kind", () => {
    for (const forbidden of [
      /console\./,
      /WebSocket/,
      /\bfetch\s*\(/,
      /XMLHttpRequest/,
      /safeStorage/i,
      /keytar/i,
      /[Cc]redential[- ]?[Mm]anager/,
      /keychain/i,
      /process\.env/,
      /require\(/,
      /localStorage/,
      /sessionStorage/,
      /indexedDB/i,
      /from ["']node:fs["']|from ["']fs["']/,
      /from ["']node:http["']|from ["']node:https["']|from ["']node:net["']|from ["']node:dgram["']/,
    ]) {
      // Comment-stripped: this module's own header prose explains, by name, every persistence/
      // network mechanism it deliberately does NOT use — a naive raw-source scan would
      // self-trigger on that explanatory sentence (same rationale as stripComments() itself).
      expect(code, `unexpectedly matched: ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it("exports exactly the four intended functions — no credential getter, serializer, or global accessor", () => {
    const exportedFns = [...code.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]);
    expect(exportedFns.sort()).toEqual(["beginAuthorization", "clearAuthorization", "getAuthorizationState", "getAvailability"].sort());
  });

  it("enforces an explicit bounded maximum credential length before retaining any value", () => {
    expect(code).toMatch(/MAX_CREDENTIAL_LENGTH/);
    expect(code).toMatch(/credential\.length > MAX_CREDENTIAL_LENGTH/);
  });

  it("rejects empty and whitespace-only credentials before retaining any value", () => {
    expect(code).toMatch(/credential\.length === 0/);
    expect(code).toMatch(/credential\.trim\(\)\.length === 0/);
  });

  it("uses a monotonic generation counter for the T-17 stale-authorization race guard", () => {
    expect(code).toMatch(/let generation = 0;/);
    expect(code).toMatch(/generation\+\+/);
    expect(code).toMatch(/generation !== generationAtStart/);
  });
});

describe("electron/hermesConnection.ts — no real network/persistence/logging capability, trusted-endpoint blocker documented (D-08C)", () => {
  const filePath = path.join(__dirname, "..", "electron", "hermesConnection.ts");
  const rawSource = fs.readFileSync(filePath, "utf8");
  const code = stripComments(rawSource);

  it("imports only type-only from shared-ipc-contract.ts and value imports from hermesAuthorization.ts/hermesEndpoint.ts/hermesEndpointSetup.ts — nothing from 'electron', 'ws', or any node:* built-in", () => {
    const importLines = code.match(/^\s*import\b.*$/gm) ?? [];
    expect(importLines.length).toBe(4);
    expect(importLines.some((line) => line.includes('from "./shared-ipc-contract"') && /^\s*import type\b/.test(line))).toBe(true);
    expect(importLines.some((line) => line.includes('from "./hermesAuthorization"'))).toBe(true);
    expect(importLines.some((line) => line.includes('from "./hermesEndpoint"'))).toBe(true);
    expect(importLines.some((line) => line.includes('from "./hermesEndpointSetup"'))).toBe(true);
    for (const line of importLines) {
      expect(line).not.toMatch(/from ["']electron["']/);
      expect(line).not.toMatch(/from ["']ws["']/);
      expect(line).not.toMatch(/from ["']node:/);
    }
  });

  it("has no console/WebSocket/HTTP/TCP/persistence/safeStorage/environment access of any kind", () => {
    for (const forbidden of [
      /console\./,
      /WebSocket/,
      /\bfetch\s*\(/,
      /XMLHttpRequest/,
      /safeStorage/i,
      /keytar/i,
      /process\.env/,
      /require\(/,
      /localStorage/,
      /sessionStorage/,
      /from ["']node:fs["']|from ["']fs["']/,
      /from ["']node:net["']|from ["']node:http["']|from ["']node:https["']|from ["']node:dgram["']/,
    ]) {
      // Comment-stripped: this module's own header prose names every mechanism it deliberately
      // does not use, and explains the trusted-endpoint-policy blocker in detail — a raw-source
      // scan would self-trigger on that explanatory text (same rationale as stripComments()).
      expect(code, `unexpectedly matched: ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it("exports exactly the three intended functions, no more", () => {
    const exportedFns = [...code.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]);
    expect(exportedFns.sort()).toEqual(["connect", "disconnect", "getConnectionState"].sort());
  });

  it("gates connect() and getConnectionState() on hermesAuthorization.ts's own getAuthorizationState, never a parallel authorization check", () => {
    expect(code).toMatch(/getAuthorizationState\(\)\.state !== "authorized_memory_only"/);
  });

  it("connect() and disconnect() take no parameters at all", () => {
    expect(code).toMatch(/export async function connect\(\): Promise<HermesConnectionResult> \{/);
    expect(code).toMatch(/export function disconnect\(\): HermesConnectionResult \{/);
  });

  it("uses a monotonic generation counter for the T-17-style stale-connect race guard, and bounds connect() to one in-flight attempt", () => {
    expect(code).toMatch(/let generation = 0;/);
    expect(code).toMatch(/generation !== generationAtStart/);
    expect(code).toMatch(/let connectInFlight = false;/);
    expect(code).toMatch(/if \(connectInFlight\)/);
  });

  it("never claims to reach the connected state — connect() only ever sets ambientState to unavailable", () => {
    expect(code).not.toMatch(/ambientState = "connected"/);
    expect(code).toMatch(/ambientState = "unavailable"/);
  });

  it("consumes electron/hermesEndpoint.ts's resolveTrustedEndpoint rather than hardcoding its own unavailable literal", () => {
    expect(code).toMatch(/from ["']\.\/hermesEndpoint["']/);
    expect(code).toMatch(/resolveTrustedEndpoint\(\)/);
    expect(code).toMatch(/endpoint\.kind !== "trusted"/);
  });

  it("never forwards any field of the resolved endpoint object into a renderer-visible result", () => {
    // The only permitted renderer-visible literal from this branch is the fixed string
    // "unavailable" — never `endpoint.reason`, `endpoint.url`, `endpoint.hostPolicy`, etc.
    expect(code).not.toMatch(/state:\s*endpoint\./);
    expect(code).not.toMatch(/\{\s*state:\s*endpoint\s*\}/);
  });
});

describe("electron/hermesEndpoint.ts — fail-closed trusted-endpoint boundary, no I/O of any kind (D-08C Part B)", () => {
  const filePath = path.join(__dirname, "..", "electron", "hermesEndpoint.ts");
  const rawSource = fs.readFileSync(filePath, "utf8");
  const code = stripComments(rawSource);

  it("has no import statement at all — a pure, dependency-free module", () => {
    const importLines = code.match(/^\s*import\b.*$/gm) ?? [];
    expect(importLines).toHaveLength(0);
  });

  it("has no console/network/DNS/persistence/safeStorage/environment access of any kind", () => {
    for (const forbidden of [
      /console\./,
      /WebSocket/,
      /\bfetch\s*\(/,
      /XMLHttpRequest/,
      /safeStorage/i,
      /keytar/i,
      /process\.env/,
      /require\(/,
      /localStorage/,
      /sessionStorage/,
      /\bdns\./,
      /from ["']node:/,
    ]) {
      // Comment-stripped: this module's own header prose names every mechanism it deliberately
      // does not use, and compares six future endpoint-source options by name — a raw-source
      // scan would self-trigger on that explanatory/comparison text.
      expect(code, `unexpectedly matched: ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it("exports exactly resolveTrustedEndpoint and validateEndpointCandidate, no more", () => {
    const exportedFns = [...code.matchAll(/export\s+function\s+(\w+)/g)].map((m) => m[1]);
    expect(exportedFns.sort()).toEqual(["resolveTrustedEndpoint", "validateEndpointCandidate"].sort());
  });

  it("resolveTrustedEndpoint takes no arguments and delegates to validateEndpointCandidate with no real candidate", () => {
    expect(code).toMatch(/export function resolveTrustedEndpoint\(\): HermesTrustedEndpoint \{/);
    expect(code).toMatch(/return validateEndpointCandidate\(undefined\);/);
  });

  it("rejects unsupported schemes, URL userinfo, query strings, and fragments unconditionally", () => {
    expect(code).toMatch(/parsed\.protocol !== "ws:" && parsed\.protocol !== "wss:"/);
    expect(code).toMatch(/parsed\.username !== ""/);
    expect(code).toMatch(/parsed\.search !== ""/);
    expect(code).toMatch(/parsed\.hash !== ""/);
  });

  it("the production entry point never supplies a non-empty approved-hosts list — explicit-approved-host is fail-closed today", () => {
    expect(code).toMatch(/approvedHosts: readonly string\[\] = \[\]/);
  });
});

describe("electron/hermesEndpoint.ts and its HermesTrustedEndpoint type — never renderer-reachable", () => {
  it("is never imported by preload.ts, renderer.ts, or shared-ipc-contract.ts", () => {
    for (const file of ["preload.ts", "renderer.ts", "shared-ipc-contract.ts"]) {
      const code = stripComments(fs.readFileSync(path.join(__dirname, "..", "electron", file), "utf8"));
      // Exact import-specifier match — NOT a bare substring check — since
      // "electron/hermesEndpointSetup.ts" (a distinct, legitimately-mentioned D-08E module) is
      // itself a superstring of "hermesEndpoint" and would otherwise self-trigger here.
      expect(code, `${file} unexpectedly imports hermesEndpoint.ts`).not.toMatch(/from ["']\.\/hermesEndpoint["']/);
      expect(code, `${file} unexpectedly references HermesTrustedEndpoint`).not.toMatch(/HermesTrustedEndpoint/);
    }
  });

  it("hermesConnection.ts and hermesEndpointSetup.ts are the only files that import electron/hermesEndpoint.ts", () => {
    const electronDir = path.join(__dirname, "..", "electron");
    const files = fs.readdirSync(electronDir).filter((f) => f.endsWith(".ts") && f !== "hermesEndpoint.ts");
    const importers = files.filter((f) => stripComments(fs.readFileSync(path.join(electronDir, f), "utf8")).match(/from ["']\.\/hermesEndpoint["']/));
    expect(importers.sort()).toEqual(["hermesConnection.ts", "hermesEndpointSetup.ts"].sort());
  });
});

describe("electron/hermesEndpointSetup.ts and its getConfiguredEndpoint accessor — never renderer-reachable", () => {
  it("is never imported by preload.ts, renderer.ts, or shared-ipc-contract.ts", () => {
    for (const file of ["preload.ts", "renderer.ts", "shared-ipc-contract.ts"]) {
      const code = stripComments(fs.readFileSync(path.join(__dirname, "..", "electron", file), "utf8"));
      expect(code, `${file} unexpectedly imports hermesEndpointSetup.ts`).not.toMatch(/from ["']\.\/hermesEndpointSetup["']/);
      expect(code, `${file} unexpectedly references getConfiguredEndpoint`).not.toMatch(/getConfiguredEndpoint/);
    }
  });

  it("hermesConnection.ts and main.ts are the only files that import electron/hermesEndpointSetup.ts", () => {
    const electronDir = path.join(__dirname, "..", "electron");
    const files = fs.readdirSync(electronDir).filter((f) => f.endsWith(".ts") && f !== "hermesEndpointSetup.ts");
    const importers = files.filter((f) => stripComments(fs.readFileSync(path.join(electronDir, f), "utf8")).match(/from ["']\.\/hermesEndpointSetup["']/));
    expect(importers.sort()).toEqual(["hermesConnection.ts", "main.ts"].sort());
  });
});

describe("electron/main.ts — local-only content load", () => {
  // Comment-stripped: main.ts's own doc comments explain, in prose, that it "never" loads a
  // remote/localhost/data: URL — a naive substring check would self-trigger on that sentence.
  const source = stripComments(fs.readFileSync(path.join(__dirname, "..", "electron", "main.ts"), "utf8"));

  it("loads the local renderer asset via loadFile", () => {
    expect(source).toMatch(/\.loadFile\(/);
    expect(source).toContain("renderer.html");
  });

  it("never calls loadURL, and never references a remote, localhost, or data: URL", () => {
    expect(source).not.toMatch(/\.loadURL\(/);
    expect(source).not.toMatch(/https?:\/\//);
    expect(source).not.toContain("localhost");
    expect(source).not.toContain("127.0.0.1");
    expect(source).not.toMatch(/data:/);
  });
});

describe("electron/main.ts — Hermes authorization + connectivity + endpoint-setup IPC handler registration (D-08B + D-08C + D-08E)", () => {
  const source = stripComments(fs.readFileSync(path.join(__dirname, "..", "electron", "main.ts"), "utf8"));

  it("registers exactly the ten Hermes IPC handlers, delegating to electron/hermesAuthorization.ts, electron/hermesConnection.ts, and electron/hermesEndpointSetup.ts", () => {
    expect(source).toMatch(/from ["']\.\/hermesAuthorization["']/);
    expect(source).toMatch(/from ["']\.\/hermesConnection["']/);
    expect(source).toMatch(/from ["']\.\/hermesEndpointSetup["']/);
    for (const channel of [
      "HERMES_IPC_CHANNELS.HERMES_GET_AVAILABILITY",
      "HERMES_IPC_CHANNELS.HERMES_GET_AUTHORIZATION_STATE",
      "HERMES_IPC_CHANNELS.HERMES_BEGIN_AUTHORIZATION",
      "HERMES_IPC_CHANNELS.HERMES_CLEAR_AUTHORIZATION",
      "HERMES_IPC_CHANNELS.HERMES_GET_CONNECTION_STATE",
      "HERMES_IPC_CHANNELS.HERMES_CONNECT",
      "HERMES_IPC_CHANNELS.HERMES_DISCONNECT",
      "HERMES_IPC_CHANNELS.HERMES_GET_ENDPOINT_CONFIGURATION_STATE",
      "HERMES_IPC_CHANNELS.HERMES_CONFIGURE_ENDPOINT",
      "HERMES_IPC_CHANNELS.HERMES_CLEAR_ENDPOINT_CONFIGURATION",
    ]) {
      expect(source).toContain(channel);
    }
  });

  it("the connect and disconnect IPC handlers take no renderer-supplied argument at all (T-14)", () => {
    expect(source).toMatch(/ipcMain\.handle\(HERMES_IPC_CHANNELS\.HERMES_CONNECT,\s*\(\)\s*=>/);
    expect(source).toMatch(/ipcMain\.handle\(HERMES_IPC_CHANNELS\.HERMES_DISCONNECT,\s*\(\)\s*=>/);
  });

  it("the clearEndpointConfiguration and getEndpointConfigurationState IPC handlers take no renderer-supplied argument at all", () => {
    expect(source).toMatch(/ipcMain\.handle\(HERMES_IPC_CHANNELS\.HERMES_CLEAR_ENDPOINT_CONFIGURATION,\s*\(\)\s*=>/);
    expect(source).toMatch(/ipcMain\.handle\(HERMES_IPC_CHANNELS\.HERMES_GET_ENDPOINT_CONFIGURATION_STATE,\s*\(\)\s*=>/);
  });

  it("passes configureEndpoint's raw request straight through, unexamined — no second/weaker validation here", () => {
    expect(source).toMatch(/configureEndpoint\(request\)/);
  });

  it("never logs a Hermes endpoint configuration request payload via logLifecycle or console", () => {
    expect(source).not.toMatch(/logLifecycle\([^)]*endpoint/i);
    expect(source).not.toMatch(/console\.[a-z]+\([^)]*endpoint/i);
  });

  it("passes beginAuthorization's raw request straight through, unexamined — no second/weaker validation here", () => {
    expect(source).toMatch(/beginAuthorization\(request\)/);
  });

  it("never logs a Hermes authorization request payload via logLifecycle or console", () => {
    expect(source).not.toMatch(/logLifecycle\([^)]*credential/i);
    expect(source).not.toMatch(/console\.[a-z]+\([^)]*credential/i);
  });

  it("registers no Hermes network/health/session/prompt/event IPC channel of any kind", () => {
    for (const forbidden of [/hermes:health/i, /hermes:session/i, /hermes:prompt/i, /hermes:respond/i, /hermes:interrupt/i, /hermes:event/i]) {
      expect(source).not.toMatch(forbidden);
    }
  });
});

describe("electron/renderer.ts — classic-script compatibility (no CommonJS module wrapper)", () => {
  // VYRON_CODE_V02_D03_PRELOAD_IPC_WIRING_FIX_AUTHORIZATION regression test. renderer.html
  // loads this file as a plain, classic `<script src="…">` (not `type="module"`) inside a
  // sandboxed, nodeIntegration:false renderer, where `exports`/`require`/`module` are not
  // defined globals. TypeScript emits a CommonJS `Object.defineProperty(exports, ...)`
  // wrapper for ANY file with a top-level import/export statement — even a type-only one —
  // which throws `ReferenceError: exports is not defined` before any of the file's own code
  // (including its button-click wiring) can run. This is the exact defect the fix addresses:
  // clicking "Open folder…" did nothing, and the footer stayed at "Platform: —". This test
  // asserts the source-level invariant that prevents a regression of that defect class.
  const source = fs.readFileSync(path.join(__dirname, "..", "electron", "renderer.ts"), "utf8");
  const stripped = stripComments(source);

  it("contains no top-level import statement", () => {
    expect(stripped).not.toMatch(/^\s*import\b/m);
  });

  it("contains no top-level export statement", () => {
    expect(stripped).not.toMatch(/^\s*export\b/m);
  });

  it("still declares the DesktopApi/WorkspaceGrantState shapes it needs, locally", () => {
    expect(stripped).toMatch(/interface DesktopApi/);
    expect(stripped).toMatch(/interface WorkspaceGrantState/);
  });
});

describe("electron/renderer.ts — safe unavailable/error-state handling (D-03 real-runtime fix)", () => {
  // VYRON_CODE_V02_D03_NATIVE_FOLDER_PICKER_REAL_RUNTIME_DEFECT_ANALYSIS_AND_FIX regression
  // test. Two silent-failure gaps could independently explain "clicking Open folder… does
  // nothing, with no visible error": (1) `window.vyronDesktop` being unexpectedly missing was
  // handled with a bare `if (!api) return;` — no UI feedback at all; (2) a rejected
  // `workspace.pickDirectory()`/`clearCurrent()` call (as opposed to one resolving with a safe
  // "denied"/"unavailable"/"cancelled" state) had no `catch` — an unhandled rejection, again
  // with no UI feedback. Both paths now render a fixed, safe status sentence instead.
  const source = fs.readFileSync(path.join(__dirname, "..", "electron", "renderer.ts"), "utf8");
  const stripped = stripComments(source);

  it("catches a rejected workspace.pickDirectory()/clearCurrent() call instead of leaving it unhandled", () => {
    const catchCount = (stripped.match(/\}\s*catch\s*\{/g) ?? []).length;
    expect(catchCount).toBeGreaterThanOrEqual(2);
  });

  it("never silently no-ops when the desktop bridge is unavailable (no bare 'if (!api) return;')", () => {
    expect(stripped).not.toMatch(/if\s*\(!api\)\s*return;/);
  });

  it("renders a safe, fixed string-literal status message for every bridge-unavailable/failure path", () => {
    // Matches only call sites passing a quoted string literal — naturally excludes the
    // function's own declaration (`function renderStatusMessage(text: string): void`), which
    // has no quote in its parameter list.
    const calls = [...stripped.matchAll(/renderStatusMessage\("([^"]*)"\)/g)];
    expect(calls.length).toBeGreaterThanOrEqual(5);
  });

  it("never surfaces a raw error message, stack trace, or string-coerced error object to the renderer UI", () => {
    for (const forbidden of [/\.message\b/, /\.stack\b/, /String\(\s*(err|error)\s*\)/, /\$\{\s*(err|error)\s*\}/]) {
      expect(stripped).not.toMatch(forbidden);
    }
  });
});

describe("electron/renderer.ts — Milestone A workspace bridge wiring", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "electron", "renderer.ts"), "utf8");
  const stripped = stripComments(source);

  it("calls every Milestone A bridge method — listEntries, readTextFile, searchText, getGitSummary", () => {
    for (const method of ["listEntries", "readTextFile", "searchText", "getGitSummary"]) {
      expect(stripped).toMatch(new RegExp(`api\\.workspace\\.${method}\\(`));
    }
  });

  it("never references an absolute-path-shaped variable name or a raw canonical/absolute root", () => {
    for (const forbidden of [/canonicalRoot/, /absolutePath/i]) {
      expect(stripped).not.toMatch(forbidden);
    }
  });

  it("the Search form's submit handler calls preventDefault before invoking searchText", () => {
    expect(stripped).toMatch(/handleSearchSubmit[\s\S]{0,300}preventDefault/);
  });

  it("has exactly one call site to api.workspace.readTextFile — Explorer and Search share the same bounded viewer, no alternate read path", () => {
    const calls = stripped.match(/api\.workspace\.readTextFile\(/g) ?? [];
    expect(calls).toHaveLength(1);
    // And both Explorer row clicks and Search result clicks route through the one function
    // that makes that call (openFile), not a second, parallel implementation.
    const openFileCalls = stripped.match(/void openFile\(/g) ?? [];
    expect(openFileCalls.length).toBeGreaterThanOrEqual(2); // at least one from Explorer, one from Search
  });

  it("the search submit button is disabled while a search is in flight, and re-enabled on completion or clear", () => {
    expect(stripped).toMatch(/searchInFlight/);
    expect(stripped).toMatch(/searchBtn\.disabled = true/);
    expect(stripped).toMatch(/searchBtn\.disabled = false/);
  });

  it("provides an explicit close-preview control that clears the file selection without touching the workspace grant", () => {
    expect(stripped).toMatch(/function closeFilePreview\(\): void \{/);
    expect(stripped).toMatch(/"Close preview"/);
  });

  it("resetWorkspaceViewState clears every view's cached state, including the search in-flight flag", () => {
    const fnBody = /function resetWorkspaceViewState\(\): void \{[\s\S]*?\n\}/.exec(stripped)?.[0] ?? "";
    expect(fnBody).toMatch(/searchInFlight = false;/);
  });
});

describe("electron/renderer.ts — Hermes authorization panel wiring (D-08B)", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "electron", "renderer.ts"), "utf8");
  const stripped = stripComments(source);
  const hermesSourceStart = stripped.indexOf("HermesViewState");
  const hermesSource = hermesSourceStart >= 0 ? stripped.slice(hermesSourceStart) : "";

  it("declares the Hermes authorization types/interfaces locally, mirroring shared-ipc-contract.ts", () => {
    expect(stripped).toMatch(/interface DesktopHermesApi/);
    expect(stripped).toMatch(/interface HermesAuthorizationResult/);
  });

  it("calls every Hermes bridge method — getAvailability, getAuthorizationState, beginAuthorization, clearAuthorization", () => {
    for (const method of ["getAvailability", "getAuthorizationState", "beginAuthorization", "clearAuthorization"]) {
      expect(stripped).toMatch(new RegExp(`api\\.hermes\\.${method}\\(`));
    }
  });

  it("the authorization form's submit handler calls preventDefault before invoking beginAuthorization", () => {
    expect(stripped).toMatch(/handleBeginHermesAuthorization[\s\S]{0,300}preventDefault/);
  });

  it("clears the credential input in a finally block after every beginAuthorization attempt, success or failure", () => {
    expect(stripped).toMatch(/finally\s*\{\s*els\.credentialInput\.value = "";\s*\}/);
  });

  it("uses a monotonic request generation to discard a stale beginAuthorization response after a later clear/submit (T-17)", () => {
    expect(hermesSource).toMatch(/let hermesRequestGeneration = 0;/);
    expect(hermesSource).toMatch(/requestId !== hermesRequestGeneration/);
    const clearFnBody = /async function handleClearHermesAuthorization\(\): Promise<void> \{[\s\S]*?\n\}/.exec(hermesSource)?.[0] ?? "";
    expect(clearFnBody).toMatch(/hermesRequestGeneration\+\+/);
  });

  it("never logs anything from the Hermes authorization flow", () => {
    expect(hermesSourceStart).toBeGreaterThan(-1);
    expect(hermesSource).not.toMatch(/console\./);
  });

  it("never renders a credential value, length, or derived fingerprint in the Hermes panel", () => {
    for (const forbidden of [/credential\.length/, /credentialInput\.value\)/, /\.slice\(0,\s*\d/]) {
      expect(hermesSource).not.toMatch(forbidden);
    }
  });

  it("only ever sets safe, fixed literal status text in the Hermes panel — never a value derived from an IPC response's own content", () => {
    expect(hermesSource).toMatch(/"Hermes: Not authorized"/);
    expect(hermesSource).toMatch(/"Hermes: Authorized for this app session only"/);
    expect(hermesSource).not.toMatch(/statusEl\.textContent = result\./);
    expect(hermesSource).not.toMatch(/statusEl\.textContent = \$\{/);
  });

  it("resets the credential input value on every non-submitting render path", () => {
    const occurrences = hermesSource.match(/credentialInput\.value = "";/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(3);
  });
});

describe("electron/renderer.ts — D-08C connection sub-panel wiring", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "electron", "renderer.ts"), "utf8");
  const stripped = stripComments(source);
  const connectionSourceStart = stripped.indexOf("HermesConnectionViewState");
  const connectionSource = connectionSourceStart >= 0 ? stripped.slice(connectionSourceStart) : "";

  it("declares the connection panel type/interfaces locally", () => {
    expect(stripped).toMatch(/type HermesConnectionViewState =/);
    expect(stripped).toMatch(/interface HermesConnectionElements/);
  });

  it("calls exactly the three D-08C bridge methods — getConnectionState, connect, disconnect", () => {
    for (const method of ["getConnectionState", "connect", "disconnect"]) {
      expect(stripped).toMatch(new RegExp(`api\\.hermes\\.${method}\\(`));
    }
  });

  it("connect/disconnect are called with no arguments at all", () => {
    expect(stripped).toMatch(/api\.hermes\.connect\(\)/);
    expect(stripped).toMatch(/api\.hermes\.disconnect\(\)/);
  });

  it("uses its own independent monotonic request generation, separate from the authorization panel's", () => {
    expect(connectionSourceStart).toBeGreaterThan(-1);
    expect(connectionSource).toMatch(/let hermesConnectionRequestGeneration = 0;/);
    expect(connectionSource).toMatch(/requestId !== hermesConnectionRequestGeneration/);
  });

  it("clearing authorization also invalidates any in-flight connect and calls disconnect", () => {
    const clearFnBody = /async function handleClearHermesAuthorization\(\): Promise<void> \{[\s\S]*?\n\}/.exec(stripped)?.[0] ?? "";
    expect(clearFnBody).toMatch(/hermesConnectionRequestGeneration\+\+/);
    expect(clearFnBody).toMatch(/api\.hermes\.disconnect\(\)/);
  });

  it("never renders an endpoint, host, port, or socket detail in the connection panel", () => {
    for (const forbidden of [/statusEl\.textContent = result\./, /statusEl\.textContent = \$\{/, /\bhost\b/i, /\bport\b/i, /\bsocket\b/i]) {
      expect(connectionSource).not.toMatch(forbidden);
    }
  });

  it("never logs anything from the connection flow", () => {
    expect(connectionSource).not.toMatch(/console\./);
  });
});

describe("electron/renderer.ts — D-08E endpoint setup panel wiring", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "electron", "renderer.ts"), "utf8");
  const stripped = stripComments(source);
  const endpointSourceStart = stripped.indexOf("HermesEndpointViewState");
  const endpointSourceEnd = stripped.indexOf("HermesConnectionViewState");
  const endpointSource = endpointSourceStart >= 0 && endpointSourceEnd > endpointSourceStart ? stripped.slice(endpointSourceStart, endpointSourceEnd) : "";

  it("declares the endpoint setup panel type/interfaces locally", () => {
    expect(stripped).toMatch(/type HermesEndpointViewState =/);
    expect(stripped).toMatch(/interface HermesEndpointElements/);
  });

  it("calls exactly the three D-08E bridge methods — getEndpointConfigurationState, configureEndpoint, clearEndpointConfiguration", () => {
    for (const method of ["getEndpointConfigurationState", "configureEndpoint", "clearEndpointConfiguration"]) {
      expect(stripped).toMatch(new RegExp(`api\\.hermes\\.${method}\\(`));
    }
  });

  it("configureEndpoint is called with exactly one object argument built from a single 'endpoint' field — no extra field", () => {
    expect(stripped).toMatch(/api\.hermes\.configureEndpoint\(\{\s*endpoint\s*\}\)/);
  });

  it("clearEndpointConfiguration and getEndpointConfigurationState are called with no arguments", () => {
    expect(stripped).toMatch(/api\.hermes\.clearEndpointConfiguration\(\)/);
    expect(stripped).toMatch(/api\.hermes\.getEndpointConfigurationState\(\)/);
  });

  it("the setup form's submit handler calls preventDefault before invoking configureEndpoint", () => {
    expect(stripped).toMatch(/handleConfigureHermesEndpoint[\s\S]{0,300}preventDefault/);
  });

  it("requires a superficial format check AND the risk-acknowledgement checkbox before enabling submit", () => {
    expect(endpointSourceStart).toBeGreaterThan(-1);
    expect(endpointSource).toMatch(/looksLikeSuperficiallyValidEndpoint/);
    expect(endpointSource).toMatch(/riskCheckbox\.checked/);
    expect(endpointSource).toMatch(/submitBtn\.disabled = !\(/);
  });

  it("clears the endpoint input in a finally block after every configureEndpoint attempt, success or failure", () => {
    expect(stripped).toMatch(/finally\s*\{\s*els\.endpointInput\.value = "";\s*\}/);
  });

  it("uses its own independent monotonic request generation, separate from the authorization and connection panels'", () => {
    expect(endpointSource).toMatch(/let hermesEndpointRequestGeneration = 0;/);
    expect(endpointSource).toMatch(/requestId !== hermesEndpointRequestGeneration/);
    const clearFnBody = /async function handleClearHermesEndpointConfiguration\(\): Promise<void> \{[\s\S]*?\n\}/.exec(stripped)?.[0] ?? "";
    expect(clearFnBody).toMatch(/hermesEndpointRequestGeneration\+\+/);
  });

  it("clearing the endpoint configuration also calls disconnect() for D-08C hygiene", () => {
    const clearFnBody = /async function handleClearHermesEndpointConfiguration\(\): Promise<void> \{[\s\S]*?\n\}/.exec(stripped)?.[0] ?? "";
    expect(clearFnBody).toMatch(/api\.hermes\.disconnect\(\)/);
  });

  it("never renders the submitted endpoint value, or any host/port/socket/URL detail, in the setup panel", () => {
    for (const forbidden of [
      /statusEl\.textContent = result\./,
      /statusEl\.textContent = \$\{/,
      /statusEl\.textContent = endpoint/,
      /errorEl\.textContent = endpoint/,
      /\bhost\b/i,
      /\bport\b/i,
      /\bsocket\b/i,
    ]) {
      expect(endpointSource).not.toMatch(forbidden);
    }
  });

  it("never logs anything from the endpoint setup flow", () => {
    expect(endpointSource).not.toMatch(/console\./);
  });

  it("resets the endpoint input and risk checkbox on every non-configuring render path", () => {
    const inputResets = endpointSource.match(/endpointInput\.value = "";/g) ?? [];
    const checkboxResets = endpointSource.match(/riskCheckbox\.checked = false;/g) ?? [];
    expect(inputResets.length).toBeGreaterThanOrEqual(3);
    expect(checkboxResets.length).toBeGreaterThanOrEqual(3);
  });
});

describe("electron/renderer.html — static, non-interactive local content", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "electron", "renderer.html"), "utf8");
  const lowerHtml = html.toLowerCase();

  it("declares a restrictive CSP with connect-src 'none' (no network capability from the renderer)", () => {
    expect(html).toMatch(/Content-Security-Policy/);
    expect(html).toMatch(/default-src 'none'/);
    expect(html).toMatch(/connect-src 'none'/);
  });

  it("contains no textarea or select, and exactly four <input> elements — the Search query box, the Hermes credential box, the Hermes endpoint box, and the risk-acknowledgement checkbox, never a path input", () => {
    for (const tag of ["<textarea", "<select"]) {
      expect(lowerHtml).not.toContain(tag);
    }
    const inputs = [...html.matchAll(/<input\b[^>]*>/g)];
    expect(inputs).toHaveLength(4);
    const inputTags = inputs.map((m) => m[0]);
    const searchInputTag = inputTags.find((tag) => tag.includes('id="search-input"')) ?? "";
    expect(searchInputTag).toContain('type="text"');
    const credentialInputTag = inputTags.find((tag) => tag.includes('id="hermes-credential-input"')) ?? "";
    expect(credentialInputTag).toContain('type="password"');
    const endpointInputTag = inputTags.find((tag) => tag.includes('id="hermes-endpoint-input"')) ?? "";
    expect(endpointInputTag).toContain('type="text"');
    const riskCheckboxTag = inputTags.find((tag) => tag.includes('id="hermes-endpoint-risk-checkbox"')) ?? "";
    expect(riskCheckboxTag).toContain('type="checkbox"');
    // Never a filesystem-picker input type, and never named/labelled as a path field — the
    // workspace root can only ever come from the native "Open folder…" picker, and neither the
    // Hermes credential input nor the Hermes endpoint input is ever a path field.
    for (const inputTag of inputTags) {
      expect(inputTag.toLowerCase()).not.toMatch(/type="(file|directory)"/);
      expect(inputTag.toLowerCase()).not.toContain('name="path"');
      expect(inputTag.toLowerCase()).not.toContain('id="path"');
    }
  });

  it("contains exactly the five Milestone A workspace-panel buttons, the two D-03 workspace-grant buttons, the four D-08B Hermes buttons, the two D-08C connection buttons, and the four D-08E endpoint-setup buttons, no more", () => {
    const buttonIds = [...html.matchAll(/<button id="([^"]+)"/g)].map((m) => m[1]);
    expect(buttonIds.sort()).toEqual(
      [
        "clear-workspace-btn",
        "nav-explorer-btn",
        "nav-git-btn",
        "nav-search-btn",
        "pick-directory-btn",
        "search-btn",
        "hermes-authorize-btn",
        "hermes-clear-btn",
        "hermes-submit-btn",
        "hermes-cancel-btn",
        "hermes-connect-btn",
        "hermes-disconnect-btn",
        "hermes-endpoint-setup-btn",
        "hermes-endpoint-clear-btn",
        "hermes-endpoint-submit-btn",
        "hermes-endpoint-cancel-btn",
      ].sort()
    );
  });

  it("the clear-workspace button starts hidden (only shown after a grant exists)", () => {
    expect(html).toMatch(/<button id="clear-workspace-btn"[^>]*\bhidden\b/);
  });

  it("the pick-directory button is not hidden and reads 'Open folder…'", () => {
    expect(html).toMatch(/<button id="pick-directory-btn"[^>]*>Open folder…<\/button>/);
    expect(html).not.toMatch(/<button id="pick-directory-btn"[^>]*\bhidden\b/);
  });

  it("states plainly that no workspace is selected", () => {
    expect(html).toMatch(/No workspace is selected/i);
  });

  it("explains that opening a folder only grants a read-only reference and never shows the full path", () => {
    expect(lowerHtml).toMatch(/read-only reference/);
    expect(lowerHtml).toMatch(/full path stays[\s\S]{0,20}private/);
  });

  it("no longer claims the folder picker is deferred (D-03 implements it)", () => {
    expect(lowerHtml).not.toMatch(/native windows folder picker[\s\S]{0,120}deferred/);
  });

  it("contains the Milestone A workspace-panel structure — nav tabs and the three view containers", () => {
    expect(html).toContain('id="workspace-panel"');
    expect(html).toContain('id="nav-explorer-btn"');
    expect(html).toContain('id="nav-search-btn"');
    expect(html).toContain('id="nav-git-btn"');
    expect(html).toContain('id="view-explorer"');
    expect(html).toContain('id="view-search"');
    expect(html).toContain('id="view-git"');
    expect(html).toContain('id="explorer-tree"');
    expect(html).toContain('id="file-viewer"');
    expect(html).toContain('id="search-results"');
    expect(html).toContain('id="git-summary"');
  });

  it("the workspace panel starts hidden (only shown after a grant exists)", () => {
    expect(html).toMatch(/<section id="workspace-panel"[^>]*\bhidden\b/);
  });

  it("explains the read-only capability boundary — no file-write, terminal, Git-write, or multimodel capability", () => {
    expect(lowerHtml).toMatch(/file-write/);
    expect(lowerHtml).toMatch(/terminal/);
    expect(lowerHtml).toMatch(/git-write/);
    expect(lowerHtml).toMatch(/multi-model|multimodel/);
  });

  it("states plainly that Hermes token/session integration is not configured", () => {
    expect(lowerHtml).toMatch(/hermes token\/session integration is not configured/);
  });

  it("never references the local web dev server's port or origin", () => {
    expect(html).not.toContain("3055");
    expect(html).not.toContain("127.0.0.1");
  });

  it("loads its script and style as local file references, not inline or remote", () => {
    expect(html).toMatch(/<link rel="stylesheet" href="renderer\.css"/);
    expect(html).toMatch(/<script src="renderer\.js"><\/script>/);
    expect(html).not.toMatch(/<script>[\s\S]*?<\/script>/); // no inline <script> block
    expect(html).not.toMatch(/href="https?:\/\//);
    expect(html).not.toMatch(/src="https?:\/\//);
  });
});

describe("electron/renderer.html — Hermes authorization panel (D-08B)", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "electron", "renderer.html"), "utf8");
  const lowerHtml = html.toLowerCase();

  it("contains the full Hermes panel structure", () => {
    for (const id of [
      "hermes-panel",
      "hermes-status",
      "hermes-explanation",
      "hermes-authorize-btn",
      "hermes-clear-btn",
      "hermes-authorization-form",
      "hermes-credential-input",
      "hermes-submit-btn",
      "hermes-cancel-btn",
      "hermes-error",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it("the credential input is type=password, not prefilled, and autocomplete is off", () => {
    const match = html.match(/<input id="hermes-credential-input"[^>]*>/);
    expect(match).not.toBeNull();
    const tag = match?.[0] ?? "";
    expect(tag).toContain('type="password"');
    expect(tag).toContain('autocomplete="off"');
    expect(tag).not.toMatch(/\bvalue="/);
  });

  it("the Hermes clear button and authorization form both start hidden", () => {
    expect(html).toMatch(/<button id="hermes-clear-btn"[^>]*\bhidden\b/);
    expect(html).toMatch(/<form id="hermes-authorization-form"[^>]*\bhidden\b/);
  });

  it("the Hermes authorize button is not hidden by default", () => {
    expect(html).not.toMatch(/<button id="hermes-authorize-btn"[^>]*\bhidden\b/);
  });

  it("states plainly that Hermes is not authorized by default, and that the credential is never saved", () => {
    expect(lowerHtml).toMatch(/hermes: not authorized/);
    expect(lowerHtml).toMatch(/is held only in this running desktop app and is not saved/);
  });

  it("never renders a token/credential length, prefix, suffix, fingerprint, or reveal/copy control anywhere in the static markup", () => {
    for (const forbidden of [/token length/i, /credential length/i, /fingerprint/i, /token prefix/i, /token suffix/i, /reveal/i, /show password/i, /copy token/i]) {
      expect(html).not.toMatch(forbidden);
    }
  });

  it("the Hermes error message paragraph starts hidden and empty", () => {
    expect(html).toMatch(/<p id="hermes-error" class="muted" hidden>\s*<\/p>/);
  });
});

describe("electron/renderer.html — D-08E endpoint setup panel", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "electron", "renderer.html"), "utf8");
  const lowerHtml = html.toLowerCase();

  it("contains the full endpoint setup panel structure", () => {
    for (const id of [
      "hermes-endpoint-section",
      "hermes-endpoint-status",
      "hermes-endpoint-explanation",
      "hermes-endpoint-risk-notice",
      "hermes-endpoint-setup-btn",
      "hermes-endpoint-clear-btn",
      "hermes-endpoint-form",
      "hermes-endpoint-input",
      "hermes-endpoint-risk-checkbox",
      "hermes-endpoint-submit-btn",
      "hermes-endpoint-cancel-btn",
      "hermes-endpoint-error",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it("the endpoint input is a plain text field, never masked, never prefilled, with autocomplete off", () => {
    const match = html.match(/<input id="hermes-endpoint-input"[^>]*>/);
    expect(match).not.toBeNull();
    const tag = match?.[0] ?? "";
    expect(tag).toContain('type="text"');
    expect(tag).toContain('autocomplete="off"');
    expect(tag).not.toMatch(/\bvalue="/);
  });

  it("the risk-acknowledgement checkbox is not pre-checked", () => {
    const match = html.match(/<input id="hermes-endpoint-risk-checkbox"[^>]*>/);
    expect(match).not.toBeNull();
    const tag = match?.[0] ?? "";
    expect(tag).toContain('type="checkbox"');
    expect(tag).not.toMatch(/\bchecked\b/);
  });

  it("the setup form starts hidden, and the submit button starts disabled", () => {
    expect(html).toMatch(/<form id="hermes-endpoint-form"[^>]*\bhidden\b/);
    expect(html).toMatch(/<button id="hermes-endpoint-submit-btn"[^>]*\bdisabled\b/);
  });

  it("the clear button starts hidden; the setup button is not hidden by default", () => {
    expect(html).toMatch(/<button id="hermes-endpoint-clear-btn"[^>]*\bhidden\b/);
    expect(html).not.toMatch(/<button id="hermes-endpoint-setup-btn"[^>]*\bhidden\b/);
  });

  it("states plainly that no endpoint is configured by default, that it is not saved, and discloses the server-identity limitation", () => {
    expect(lowerHtml).toMatch(/no local companion endpoint configured/);
    expect(lowerHtml).toMatch(/the endpoint is used only for this running desktop app and is not saved/);
    expect(lowerHtml).toMatch(/does not provide desktop-side server identity verification/);
  });

  it("contains no host/port-split field, protocol selector, header field, proxy field, certificate control, TLS-disable control, endpoint-history UI, save-endpoint checkbox, auto-connect/auto-reconnect checkbox, test-connection button, or service-discovery/port-scan button", () => {
    for (const forbidden of [
      /id="hermes-endpoint-host/i,
      /id="hermes-endpoint-port/i,
      /protocol.{0,20}select/i,
      /id="hermes-endpoint-header/i,
      /id="hermes-endpoint-proxy/i,
      /certificate/i,
      /ignore.{0,10}tls/i,
      /disable.{0,10}tls/i,
      /endpoint.history/i,
      /recently.used/i,
      /save.endpoint/i,
      /auto.connect/i,
      /auto.reconnect/i,
      /test.connection/i,
      /discover.{0,10}(local )?service/i,
      /scan.{0,10}ports?/i,
    ]) {
      expect(html).not.toMatch(forbidden);
    }
  });

  it("contains no token input field within the endpoint setup form", () => {
    const sectionMatch = html.match(/<div id="hermes-endpoint-section">[\s\S]*?<p id="hermes-endpoint-error"[^>]*><\/p>\s*<\/div>/);
    expect(sectionMatch).not.toBeNull();
    const sectionHtml = sectionMatch?.[0] ?? "";
    expect(sectionHtml).not.toMatch(/type="password"/);
    expect(sectionHtml).not.toMatch(/id="hermes-endpoint-token/i);
  });
});

describe("electron/renderer.html — D-08C connection sub-panel", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "electron", "renderer.html"), "utf8");
  const lowerHtml = html.toLowerCase();

  it("contains the full connection sub-panel structure", () => {
    for (const id of ["hermes-connection-section", "hermes-connection-status", "hermes-connect-btn", "hermes-disconnect-btn", "hermes-connection-error"]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it("the connection section and disconnect button both start hidden", () => {
    expect(html).toMatch(/<div id="hermes-connection-section"[^>]*\bhidden\b/);
    expect(html).toMatch(/<button id="hermes-disconnect-btn"[^>]*\bhidden\b/);
  });

  it("the connect button is not hidden by default within its own markup", () => {
    expect(html).not.toMatch(/<button id="hermes-connect-btn"[^>]*\bhidden\b/);
  });

  it("states plainly that no connection has been attempted by default", () => {
    expect(lowerHtml).toMatch(/connection has not been attempted/);
  });

  it("the connection sub-panel itself (not the page as a whole) contains no endpoint/host/port/URL editing control, and no session/chat/prompt/context/provider/model UI", () => {
    // Scoped to exactly the <div id="hermes-connection-section">...</div> markup — D-08E
    // legitimately adds its own, separate "id=hermes-endpoint-*" section elsewhere on this
    // page (the only place an endpoint can ever be entered); this test's job is confirming the
    // *connection* sub-panel specifically never grew its own, second endpoint-entry surface.
    const sectionMatch = html.match(/<div id="hermes-connection-section"[\s\S]*?<p id="hermes-connection-error"[^>]*><\/p>\s*<\/div>/);
    expect(sectionMatch).not.toBeNull();
    const sectionHtml = sectionMatch?.[0] ?? "";
    for (const forbidden of [
      /id="hermes-host/i,
      /id="hermes-port/i,
      /id="hermes-url/i,
      /id="hermes-session/i,
      /id="hermes-prompt/i,
      /id="hermes-chat/i,
      /id="hermes-context/i,
      /id="hermes-provider/i,
      /id="hermes-model/i,
      /<input\b/i,
      /<form\b/i,
    ]) {
      expect(sectionHtml).not.toMatch(forbidden);
    }
  });

  it("the endpoint-setup section is a distinct, separate section from the connection sub-panel, not nested inside it", () => {
    const endpointIndex = html.indexOf('<div id="hermes-endpoint-section"');
    const connectionIndex = html.indexOf('<div id="hermes-connection-section"');
    expect(endpointIndex).toBeGreaterThan(-1);
    expect(connectionIndex).toBeGreaterThan(-1);
    expect(endpointIndex).toBeLessThan(connectionIndex);
  });
});
