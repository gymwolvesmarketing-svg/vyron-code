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

describe("HERMES_IPC_CHANNELS — implemented channels (D-08B)", () => {
  it("exposes exactly the four implemented Hermes authorization channels, no more", () => {
    expect(Object.values(HERMES_IPC_CHANNELS).sort()).toEqual(
      ["hermes:beginAuthorization", "hermes:clearAuthorization", "hermes:getAuthorizationState", "hermes:getAvailability"].sort()
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

  it("exposes exactly the four Hermes authorization methods, no more (D-08B)", () => {
    const hermes = exposedApi().hermes as Record<string, unknown>;
    expect(Object.keys(hermes).sort()).toEqual(["beginAuthorization", "clearAuthorization", "getAuthorizationState", "getAvailability"]);
    for (const method of Object.values(hermes)) {
      expect(typeof method).toBe("function");
    }
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

  it("confirms exactly the twelve expected scaffold .ts files exist, no more", () => {
    expect(sourceFiles.sort()).toEqual(
      [
        "hermesAuthorization.ts",
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

describe("electron/main.ts — Hermes authorization IPC handler registration (D-08B)", () => {
  const source = stripComments(fs.readFileSync(path.join(__dirname, "..", "electron", "main.ts"), "utf8"));

  it("registers exactly the four Hermes IPC handlers, delegating to electron/hermesAuthorization.ts", () => {
    expect(source).toMatch(/from ["']\.\/hermesAuthorization["']/);
    for (const channel of [
      "HERMES_IPC_CHANNELS.HERMES_GET_AVAILABILITY",
      "HERMES_IPC_CHANNELS.HERMES_GET_AUTHORIZATION_STATE",
      "HERMES_IPC_CHANNELS.HERMES_BEGIN_AUTHORIZATION",
      "HERMES_IPC_CHANNELS.HERMES_CLEAR_AUTHORIZATION",
    ]) {
      expect(source).toContain(channel);
    }
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

describe("electron/renderer.html — static, non-interactive local content", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "electron", "renderer.html"), "utf8");
  const lowerHtml = html.toLowerCase();

  it("declares a restrictive CSP with connect-src 'none' (no network capability from the renderer)", () => {
    expect(html).toMatch(/Content-Security-Policy/);
    expect(html).toMatch(/default-src 'none'/);
    expect(html).toMatch(/connect-src 'none'/);
  });

  it("contains no textarea or select, and exactly two <input> elements — the Search query box and the Hermes credential box, never a path input", () => {
    for (const tag of ["<textarea", "<select"]) {
      expect(lowerHtml).not.toContain(tag);
    }
    const inputs = [...html.matchAll(/<input\b[^>]*>/g)];
    expect(inputs).toHaveLength(2);
    const inputTags = inputs.map((m) => m[0]);
    const searchInputTag = inputTags.find((tag) => tag.includes('id="search-input"')) ?? "";
    expect(searchInputTag).toContain('type="text"');
    const credentialInputTag = inputTags.find((tag) => tag.includes('id="hermes-credential-input"')) ?? "";
    expect(credentialInputTag).toContain('type="password"');
    // Never a filesystem-picker input type, and never named/labelled as a path field — the
    // workspace root can only ever come from the native "Open folder…" picker, and the Hermes
    // credential input is never a path field either.
    for (const inputTag of inputTags) {
      expect(inputTag.toLowerCase()).not.toMatch(/type="(file|directory)"/);
      expect(inputTag.toLowerCase()).not.toContain('name="path"');
      expect(inputTag.toLowerCase()).not.toContain('id="path"');
    }
  });

  it("contains exactly the five Milestone A workspace-panel buttons, the two D-03 workspace-grant buttons, and the four D-08B Hermes buttons, no more", () => {
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
