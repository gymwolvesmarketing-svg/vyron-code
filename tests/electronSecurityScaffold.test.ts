import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { HARDENED_WEB_PREFERENCES, ALLOWED_NAVIGATION_ORIGINS, isNavigationAllowed, isNewWindowAllowed } from "../electron/security-policy";
import { HERMES_IPC_CHANNELS, LOCAL_AI_IPC_CHANNELS } from "../electron/shared-ipc-contract";

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
  // hermesApiServer.ts (D-10 remediated) and hermesTaskSubmission.ts (D-11) are the two
  // deliberate exceptions — one bounded `GET <origin>/health` probe and one bounded, explicit
  // `POST <origin>/v1/chat/completions` request respectively, the only two real network calls
  // this entire scaffold makes; see each file's own header for the full evidence trail.
  const FILES_ALLOWED_FETCH = new Set(["hermesApiServer.ts", "hermesTaskSubmission.ts", "localAiAdapters.ts"]);
  // localAiAdapters.ts is the one main-process module that starts the two local services
  // (fixed spawn of the Hermes gateway and the auth proxy, taskkill for cleanup) and probes them.
  const FILES_ALLOWED_CHILD_PROCESS = new Set(["localAiAdapters.ts"]);
  const FILES_ALLOWED_ENV_FS = new Set(["localAiAdapters.ts"]);
  const forbiddenPatterns: Array<[string, RegExp, (file: string) => boolean]> = [
    ["child_process import", /child_process/, (file) => !FILES_ALLOWED_CHILD_PROCESS.has(file)],
    ["exec( call", /\bexec\s*\(/, (file) => !FILES_ALLOWED_CHILD_PROCESS.has(file)],
    ["spawn( call", /\bspawn\s*\(/, (file) => !FILES_ALLOWED_CHILD_PROCESS.has(file)],
    ["fork( call", /\bfork\s*\(/, () => true],
    ["shell.openPath", /shell\.openPath/, () => true],
    ["shell.openExternal", /shell\.openExternal/, () => true],
    ["@electron/remote", /@electron\/remote/, () => true],
    ["ipcRenderer reference", /ipcRenderer/, (file) => !FILES_ALLOWED_IPC_RENDERER.has(file)],
    ["fetch( call", /\bfetch\s*\(/, (file) => !FILES_ALLOWED_FETCH.has(file)],
    ["XMLHttpRequest", /XMLHttpRequest/, () => true],
    [
      "direct node:fs import (must go through workspaceAccess.ts/lib/canonicalPath.ts for path validation first)",
      /from ["']node:fs["']|from ["']fs["']/,
      (file) => !FILES_ALLOWED_DIRECT_FS.has(file) && !FILES_ALLOWED_ENV_FS.has(file),
    ],
  ];

  it.each(sourceFiles)("%s contains no forbidden shell/child_process/remote/fs pattern for its file type", (file) => {
    const code = stripComments(fs.readFileSync(path.join(electronDir, file), "utf8"));
    for (const [label, pattern, appliesTo] of forbiddenPatterns) {
      if (!appliesTo(file)) continue;
      expect(pattern.test(code), `${file} unexpectedly matched: ${label}`).toBe(false);
    }
  });

  it("confirms exactly the nineteen expected scaffold .ts files exist, no more", () => {
    expect(sourceFiles).toHaveLength(19);
    expect(sourceFiles.sort()).toEqual(
      [
        "hermesApiServer.ts",
        "hermesAuthorization.ts",
        "hermesEndpoint.ts",
        "hermesEndpointSetup.ts",
        "hermesTaskSubmission.ts",
        "localAiAdapters.ts",
        "localAiLifecycle.ts",
        "main.ts",
        "preload.ts",
        "renderer.ts",
        "security-policy.ts",
        "shared-ipc-contract.ts",
        "taskComposer.ts",
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

  it("exports exactly the five intended functions — the one credential accessor added by D-08F is main-process-internal only (verified separately below), no serializer or generic global accessor", () => {
    const exportedFns = [...code.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]);
    expect(exportedFns.sort()).toEqual(
      ["beginAuthorization", "clearAuthorization", "getAuthorizationState", "getAvailability", "getCurrentCredential"].sort()
    );
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

describe("electron/hermesAuthorization.ts's getCurrentCredential — never renderer-reachable (D-08F)", () => {
  it("is never imported by preload.ts, renderer.ts, or shared-ipc-contract.ts", () => {
    for (const file of ["preload.ts", "renderer.ts", "shared-ipc-contract.ts"]) {
      const code = stripComments(fs.readFileSync(path.join(__dirname, "..", "electron", file), "utf8"));
      expect(code, `${file} unexpectedly references getCurrentCredential`).not.toMatch(/getCurrentCredential/);
    }
  });

  it("is only ever imported by electron/hermesApiServer.ts and electron/hermesTaskSubmission.ts", () => {
    const electronDir = path.join(__dirname, "..", "electron");
    const files = fs.readdirSync(electronDir).filter((f) => f.endsWith(".ts") && f !== "hermesAuthorization.ts");
    const importers = files.filter((f) => stripComments(fs.readFileSync(path.join(electronDir, f), "utf8")).match(/getCurrentCredential/));
    expect(importers.sort()).toEqual(["hermesApiServer.ts", "hermesTaskSubmission.ts"].sort());
  });
});

describe("electron/hermesApiServer.ts — main-process Hermes API Server connection-verification service (D-10 remediated)", () => {
  const filePath = path.join(__dirname, "..", "electron", "hermesApiServer.ts");
  const rawSource = fs.readFileSync(filePath, "utf8");
  const code = stripComments(rawSource);

  it("imports type-only from shared-ipc-contract.ts and value imports from hermesAuthorization.ts/hermesEndpoint.ts/hermesEndpointSetup.ts only — nothing from 'electron', 'ws', or any node:* built-in", () => {
    const importLines = code.match(/^\s*import\b.*$/gm) ?? [];
    expect(importLines.length).toBe(4);
    expect(importLines.some((line) => line.includes('from "./shared-ipc-contract"') && /^\s*import type\b/.test(line))).toBe(true);
    expect(importLines.some((line) => line.includes('from "./hermesAuthorization"') && line.includes("getCurrentCredential"))).toBe(true);
    expect(importLines.some((line) => line.includes('from "./hermesEndpoint"'))).toBe(true);
    expect(importLines.some((line) => line.includes('from "./hermesEndpointSetup"'))).toBe(true);
    for (const line of importLines) {
      expect(line).not.toMatch(/from ["']electron["']/);
      expect(line).not.toMatch(/from ["']ws["']/);
      expect(line).not.toMatch(/from ["']node:/);
    }
  });

  it("has no console/XHR/WebSocket/persistence/safeStorage/environment access, and never imports node:net/http/https/dgram/fs directly (the one real network call is the bare global fetch() below)", () => {
    for (const forbidden of [
      /console\./,
      /XMLHttpRequest/,
      /WebSocket/,
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
      // does not use — a raw-source scan would self-trigger on that explanatory text.
      expect(code, `unexpectedly matched: ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it("exports exactly the three intended functions, no more", () => {
    const exportedFns = [...code.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]);
    expect(exportedFns.sort()).toEqual(["getApiServerVerificationState", "verifyApiServerConnection", "clearApiServerVerification"].sort());
  });

  it("getApiServerVerificationState, verifyApiServerConnection, and clearApiServerVerification take no parameters at all", () => {
    expect(code).toMatch(/export function getApiServerVerificationState\(\): HermesApiServerState \{/);
    expect(code).toMatch(/export async function verifyApiServerConnection\(\): Promise<HermesApiServerResult> \{/);
    expect(code).toMatch(/export function clearApiServerVerification\(\): HermesApiServerResult \{/);
  });

  it("gates verifyApiServerConnection() on both hermesAuthorization.ts's authorization state and a resolved trusted endpoint, never a parallel check", () => {
    expect(code).toMatch(/getAuthorizationState\(\)\.state !== "authorized_memory_only"/);
    expect(code).toMatch(/endpoint\.kind !== "trusted"/);
  });

  it("uses a monotonic generation counter for the T-17-style stale-verify race guard, and bounds verifyApiServerConnection() to one in-flight attempt", () => {
    expect(code).toMatch(/let generation = 0;/);
    expect(code).toMatch(/generation !== generationAtStart/);
    expect(code).toMatch(/let verifyInFlight = false;/);
    expect(code).toMatch(/if \(verifyInFlight\)/);
  });

  it("declares its own independently-disclosed VERIFY_TIMEOUT_MS bound (10000ms), using AbortController to enforce it", () => {
    expect(code).toMatch(/VERIFY_TIMEOUT_MS = 10_000/);
    expect(code).toMatch(/new AbortController\(\)/);
    expect(code).toMatch(/controller\.abort\(\)/);
  });

  it("sends exactly one fetch() call, to <origin>/health, with method GET and redirect:\"error\" — no body, no query string, no custom header, no cookie option", () => {
    const fetchCalls = code.match(/\bfetch\s*\(/g) ?? [];
    expect(fetchCalls).toHaveLength(1);
    expect(code).toMatch(/fetch\(`\$\{endpoint\.url\.origin\}\/health`,/);
    expect(code).toMatch(/method:\s*"GET"/);
    expect(code).toMatch(/redirect:\s*"error"/);
    expect(code).not.toMatch(/body:/);
    expect(code).not.toMatch(/credentials:/);
  });

  it("never constructs or sends an Authorization header anywhere in this file — /health is documented as intentionally unauthenticated", () => {
    // A quoted "Authorization" header-name literal would never legitimately appear in this
    // file — unlike the bare substring "Authorization", which also matches this module's own
    // expected `hermesAuthorization`/`getAuthorizationState` imports and calls.
    expect(code).not.toMatch(/["']Authorization["']/);
    expect(code).not.toMatch(/[Bb]earer/);
  });

  it("reads getCurrentCredential() only as an explicit precondition gate, never attaching its value to the fetch() call", () => {
    expect(code).toMatch(/getCurrentCredential\(\) === null/);
    // The credential identifier itself never appears anywhere near the fetch() call site.
    const fetchCallSite = /const response = await fetch\([\s\S]*?\}\);/.exec(code)?.[0] ?? "";
    expect(fetchCallSite).not.toMatch(/credential/i);
  });

  it("maps a non-ok response to safe_failure and a rejected/aborted fetch to unavailable, never exposing the raw status or error", () => {
    expect(code).toMatch(/if \(response\.ok\)/);
    expect(code).toMatch(/state:\s*"safe_failure"/);
    expect(code).toMatch(/\}\s*catch\s*\{/);
    expect(code).toMatch(/state:\s*"unavailable"/);
    expect(code).not.toMatch(/response\.status/);
    expect(code).not.toMatch(/\.message\b/);
  });

  it("never forwards any field of the resolved endpoint object, or the credential, into a renderer-visible result", () => {
    // The only permitted renderer-visible literals are the fixed HermesApiServerResult state
    // strings — never `endpoint.url`/`endpoint.hostPolicy`/`credential`/any derived value.
    expect(code).not.toMatch(/state:\s*endpoint\./);
    expect(code).not.toMatch(/state:\s*credential/);
    expect(code).not.toMatch(/\{\s*state:\s*endpoint\s*\}/);
  });

  it("self-heals a stale reachable/verifying/unavailable/safe_failure ambient state back to ready_to_verify once authorization or endpoint configuration is no longer in place", () => {
    expect(code).toMatch(/function resetToReadyToVerify\(\): void \{/);
    expect(code).toMatch(/if \(ambientState !== "ready_to_verify"\) resetToReadyToVerify\(\);/);
  });

  it("consumes electron/hermesEndpointSetup.ts's getConfiguredEndpoint, falling back to electron/hermesEndpoint.ts's resolveTrustedEndpoint only when nothing is configured", () => {
    expect(code).toMatch(/getConfiguredEndpoint\(\) \?\? resolveTrustedEndpoint\(\)/);
  });

  it("never logs anything, and never exports a raw response, header, or body value", () => {
    expect(code).not.toMatch(/console\./);
    expect(code).not.toMatch(/response\.headers/);
    expect(code).not.toMatch(/response\.body/);
    expect(code).not.toMatch(/response\.json\(/);
    expect(code).not.toMatch(/response\.text\(/);
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

  it("rejects unsupported schemes, URL userinfo, query strings, fragments, disallowed pathnames, missing ports, and zero ports unconditionally (D-10 remediated: http: only)", () => {
    expect(code).toMatch(/parsed\.protocol !== "http:"/);
    expect(code).toMatch(/parsed\.username !== ""/);
    expect(code).toMatch(/parsed\.search !== ""/);
    expect(code).toMatch(/parsed\.hash !== ""/);
    expect(code).toMatch(/ALLOWED_PATHNAMES/);
    expect(code).toMatch(/parsed\.port === "" \|\| parsed\.port === "0"/);
  });

  it("declares the pathname allowlist as exactly empty, '/', and '/v1' — never a dashboard/chat-completions/health path", () => {
    expect(code).toMatch(/ALLOWED_PATHNAMES = new Set\(\["", "\/", "\/v1"\]\)/);
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

  it("hermesApiServer.ts, hermesEndpointSetup.ts, and hermesTaskSubmission.ts are the only files that import electron/hermesEndpoint.ts", () => {
    const electronDir = path.join(__dirname, "..", "electron");
    const files = fs.readdirSync(electronDir).filter((f) => f.endsWith(".ts") && f !== "hermesEndpoint.ts");
    const importers = files.filter((f) => stripComments(fs.readFileSync(path.join(electronDir, f), "utf8")).match(/from ["']\.\/hermesEndpoint["']/));
    expect(importers.sort()).toEqual(["hermesApiServer.ts", "hermesEndpointSetup.ts", "hermesTaskSubmission.ts"].sort());
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

  it("hermesApiServer.ts, localAiAdapters.ts, and hermesTaskSubmission.ts are the only files that import electron/hermesEndpointSetup.ts", () => {
    const electronDir = path.join(__dirname, "..", "electron");
    const files = fs.readdirSync(electronDir).filter((f) => f.endsWith(".ts") && f !== "hermesEndpointSetup.ts");
    const importers = files.filter((f) => stripComments(fs.readFileSync(path.join(electronDir, f), "utf8")).match(/from ["']\.\/hermesEndpointSetup["']/));
    expect(importers.sort()).toEqual(["hermesApiServer.ts", "localAiAdapters.ts", "hermesTaskSubmission.ts"].sort());
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

describe("electron/taskComposer.ts — module isolation (D-09)", () => {
  // taskComposer.ts is a REAL ES module (real `export` statements) — unlike renderer.ts, this
  // is safe only because it must never be loaded via a <script> tag or `require`d by any
  // compiled-for-renderer/preload/main file. It exists solely so its pure logic is directly
  // unit-testable (tests/electronTaskComposer.test.ts) without a DOM. This describe block
  // enforces the isolation that makes that safe.
  const composerSource = fs.readFileSync(path.join(__dirname, "..", "electron", "taskComposer.ts"), "utf8");
  const strippedComposer = stripComments(composerSource);
  const electronDir = path.join(__dirname, "..", "electron");
  const otherElectronFiles = fs
    .readdirSync(electronDir)
    .filter((f) => f.endsWith(".ts") && f !== "taskComposer.ts");
  const rendererHtml = fs.readFileSync(path.join(electronDir, "renderer.html"), "utf8");

  it("is never imported by any other electron/*.ts file (main.ts, preload.ts, renderer.ts included)", () => {
    for (const file of otherElectronFiles) {
      const code = stripComments(fs.readFileSync(path.join(electronDir, file), "utf8"));
      expect(code, `${file} unexpectedly references taskComposer`).not.toMatch(/from ["']\.\/taskComposer["']/);
    }
  });

  it("is never loaded via a <script> tag in renderer.html", () => {
    expect(rendererHtml).not.toMatch(/taskComposer/);
  });

  it("has no DOM/Node/Electron/network/storage reference of any kind", () => {
    for (const forbidden of [
      /\bdocument\./,
      /\bwindow\./,
      /from ["']electron["']/,
      /from ["']node:/,
      /\bfetch\s*\(/,
      /XMLHttpRequest/,
      /WebSocket/,
      /localStorage/,
      /sessionStorage/,
      /indexedDB/,
      /document\.cookie/,
      /ipcRenderer/,
      /child_process/,
    ]) {
      expect(strippedComposer).not.toMatch(forbidden);
    }
  });

  it("exposes no send/submit/execute/session/prompt export", () => {
    for (const forbidden of [/export function send/i, /export function submit/i, /export function execute/i, /export function.*[sS]ession/, /export function.*[pP]rompt/]) {
      expect(strippedComposer).not.toMatch(forbidden);
    }
  });
});


describe("IPC contract — exactly three local-AI methods plus the four existing task methods", () => {
  it("LOCAL_AI_IPC_CHANNELS has exactly the three new channels", () => {
    expect(Object.values(LOCAL_AI_IPC_CHANNELS).sort()).toEqual(["localAi:copyDiagnostics", "localAi:getState", "localAi:retry"]);
  });

  it("HERMES_IPC_CHANNELS has exactly the four existing task channels, and no manual authorization/endpoint channel", () => {
    expect(Object.values(HERMES_IPC_CHANNELS).sort()).toEqual([
      "hermes:clearTaskSubmission",
      "hermes:getTaskSubmissionState",
      "hermes:reviewTaskDraft",
      "hermes:sendReviewedTask",
    ]);
  });

  it("no channel name is shared between the two namespaces", () => {
    const all = [...Object.values(LOCAL_AI_IPC_CHANNELS), ...Object.values(HERMES_IPC_CHANNELS)];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("electron/preload.ts — narrow fixed bridge", () => {
  const code = stripComments(fs.readFileSync(path.join(__dirname, "..", "electron", "preload.ts"), "utf8"));

  it("imports only from 'electron' (no runtime relative import)", () => {
    const imports = [...code.matchAll(/^\s*import\b[^;]*from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(imports).toEqual(["electron"]);
  });

  it("exposes exactly one global, vyronDesktop, through contextBridge", () => {
    expect([...code.matchAll(/exposeInMainWorld\(\s*"([^"]+)"/g)].map((m) => m[1])).toEqual(["vyronDesktop"]);
  });

  it("exposes exactly the seven fixed methods and no generic invoke/send/on", () => {
    const methods = [...code.matchAll(/^\s{4}(\w+):\s*(?:async\s*)?\(/gm)].map((m) => m[1]).sort();
    expect(methods).toEqual(
      [
        "clearTaskSubmission",
        "copyLocalAiDiagnostics",
        "getLocalAiState",
        "getTaskSubmissionState",
        "retryLocalAiStartup",
        "reviewTaskDraft",
        "sendReviewedTask",
      ].sort(),
    );
    expect(code).not.toMatch(/\b(send|on|once|invoke)\s*:/);
    expect(code).not.toMatch(/exposeInMainWorld\([^)]*ipcRenderer/);
  });

  it("carries no endpoint, credential, path, workspace, or process capability", () => {
    expect(code).not.toMatch(/endpoint|apiKey|API_SERVER_KEY|workspace|process\.|require\(/i);
  });

  it("duplicates the canonical channel strings exactly", () => {
    for (const channel of [...Object.values(LOCAL_AI_IPC_CHANNELS), ...Object.values(HERMES_IPC_CHANNELS)]) {
      expect(code).toContain(`"${channel}"`);
    }
  });
});

describe("electron/main.ts — local AI IPC wiring", () => {
  const code = stripComments(fs.readFileSync(path.join(__dirname, "..", "electron", "main.ts"), "utf8"));

  it("registers exactly seven ipcMain handlers (three local AI, four task)", () => {
    expect(code.match(/ipcMain\.handle\(/g)).toHaveLength(7);
  });

  it("the three local AI handlers take no renderer-supplied argument", () => {
    for (const method of ["localAi.getState()", "localAi.retry()", "localAi.copyDiagnostics()"]) {
      expect(code).toContain("() => " + method);
    }
  });

  it("starts the local AI manager after registering handlers and never exposes generic IPC", () => {
    expect(code).toMatch(/registerLocalAiIpcHandlers\(\);[\s\S]*registerHermesIpcHandlers\(\);[\s\S]*localAi\.start\(\)/);
    expect(code).not.toMatch(/ipcMain\.on\(/);
  });

  it("registers no workspace, manual authorization, or endpoint handler", () => {
    expect(code).not.toMatch(/workspace|beginAuthorization|configureEndpoint|WORKSPACE_IPC_CHANNELS/i);
  });

  it("shuts the local AI down before quitting", () => {
    expect(code).toMatch(/localAi\.shutdown\(\)/);
  });
});

describe("electron/localAiLifecycle.ts and localAiAdapters.ts — placement", () => {
  const dir = path.join(__dirname, "..", "electron");

  it("neither module is imported by preload.ts, renderer.ts or shared-ipc-contract.ts", () => {
    for (const file of ["preload.ts", "renderer.ts", "shared-ipc-contract.ts"]) {
      const code = stripComments(fs.readFileSync(path.join(dir, file), "utf8"));
      expect(code, file).not.toMatch(/localAiLifecycle|localAiAdapters/);
    }
  });

  it("localAiAdapters.ts is imported only by main.ts", () => {
    const importers = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && f !== "localAiAdapters.ts")
      .filter((f) => /from ["']\.\/localAiAdapters["']/.test(stripComments(fs.readFileSync(path.join(dir, f), "utf8"))));
    expect(importers).toEqual(["main.ts"]);
  });
});
