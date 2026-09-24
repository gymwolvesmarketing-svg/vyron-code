import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("electron", () => ({ clipboard: { writeText: vi.fn() } }));

import {
  GATEWAY_ORIGIN,
  PROXY_ORIGIN,
  GATEWAY_COMMAND_ARGS,
  PROXY_UPSTREAM_PORT,
  PROXY_LISTEN_PORT,
  buildGatewayEnvironment,
  buildProxyEnvironment,
  parseApiKey,
  probe,
  createProductionLocalAiManager,
} from "../electron/localAiAdapters";

const FAKE_KEY = "FAKE-TEST-KEY-abcdefghijklmnopqrstuvwxyz0123456789";

// Removes block comments and whole-line // comments only, so a string literal such as
// "http://127.0.0.1:8642" is left intact (a naive "//.*$" pattern would cut it off).
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

const adaptersSource = fs.readFileSync(path.join(__dirname, "..", "electron", "localAiAdapters.ts"), "utf8");
const adaptersCode = stripComments(adaptersSource);

describe("localAiAdapters - fixed endpoints and command", () => {
  it("uses only the two fixed loopback origins, with the fixed ports", () => {
    expect(GATEWAY_ORIGIN).toBe("http://127.0.0.1:8642");
    expect(PROXY_ORIGIN).toBe("http://127.0.0.1:8643");
    expect(PROXY_UPSTREAM_PORT).toBe("8642");
    expect(PROXY_LISTEN_PORT).toBe("8643");
  });

  it("runs the fixed official gateway command with exactly the arguments 'gateway run'", () => {
    expect([...GATEWAY_COMMAND_ARGS]).toEqual(["gateway", "run"]);
  });

  it("contains no other http(s) origin, and no port other than the two fixed ones", () => {
    const origins = adaptersCode.match(/https?:\/\/[^\s"'`)]+/g) ?? [];
    expect(new Set(origins)).toEqual(new Set(["http://127.0.0.1:8642", "http://127.0.0.1:8643"]));
  });
});

describe("localAiAdapters - proxy child environment boundary", () => {
  it("passes exactly the key, the two fixed ports, Node-mode and SystemRoot - nothing else", () => {
    const env = buildProxyEnvironment(FAKE_KEY, "C:\\Windows");
    expect(Object.keys(env).sort()).toEqual(
      ["ELECTRON_RUN_AS_NODE", "HERMES_API_SERVER_KEY", "HERMES_PROXY_PORT", "HERMES_UPSTREAM_PORT", "SystemRoot"].sort(),
    );
    expect(env.HERMES_API_SERVER_KEY).toBe(FAKE_KEY);
    expect(env.HERMES_UPSTREAM_PORT).toBe("8642");
    expect(env.HERMES_PROXY_PORT).toBe("8643");
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("omits SystemRoot when it is not defined, and never inherits any ambient variable", () => {
    const env = buildProxyEnvironment(FAKE_KEY, undefined);
    expect(Object.keys(env).sort()).toEqual(["ELECTRON_RUN_AS_NODE", "HERMES_API_SERVER_KEY", "HERMES_PROXY_PORT", "HERMES_UPSTREAM_PORT"].sort());
  });
});

describe("localAiAdapters - gateway child environment boundary", () => {
  it("keeps only allow-listed variables and drops every credential-like or Node/Electron control variable", () => {
    const source: Record<string, string | undefined> = {
      PATH: "C:\\bin",
      LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local",
      SystemRoot: "C:\\Windows",
      HERMES_API_SERVER_KEY: FAKE_KEY,
      OPENAI_API_KEY: "should-not-pass",
      ANTHROPIC_API_KEY: "should-not-pass",
      NODE_OPTIONS: "--require evil.js",
      ELECTRON_RUN_AS_NODE: "1",
      VYRON_LIFECYCLE_DEBUG: "1",
    };
    const env = buildGatewayEnvironment(source);
    expect(env.PATH).toBe("C:\\bin");
    expect(env.LOCALAPPDATA).toBe("C:\\Users\\x\\AppData\\Local");
    expect(env.PYTHONUTF8).toBe("1");
    for (const dropped of ["HERMES_API_SERVER_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "VYRON_LIFECYCLE_DEBUG"]) {
      expect(env[dropped]).toBeUndefined();
    }
    expect(JSON.stringify(env)).not.toContain(FAKE_KEY);
  });
});

describe("localAiAdapters - API key parsing (main-process only)", () => {
  const key = "abcdef0123456789abcdef0123456789";

  it("reads API_SERVER_KEY from a .env text, tolerating CRLF, spaces and quotes", () => {
    expect(parseApiKey(`FOO=1\r\nAPI_SERVER_KEY=${key}\r\nBAR=2\r\n`)).toBe(key);
    expect(parseApiKey(`  API_SERVER_KEY = "${key}"  `)).toBe(key);
    expect(parseApiKey(`API_SERVER_KEY='${key}'`)).toBe(key);
  });

  it("uses the last definition, like a standard dotenv loader", () => {
    expect(parseApiKey(`API_SERVER_KEY=first-first-first-first\nAPI_SERVER_KEY=${key}\n`)).toBe(key);
  });

  it("returns null for a missing, too short, oversized or malformed key", () => {
    expect(parseApiKey("OTHER=1\n")).toBeNull();
    expect(parseApiKey("API_SERVER_KEY=\n")).toBeNull();
    expect(parseApiKey("API_SERVER_KEY=short\n")).toBeNull();
    expect(parseApiKey(`API_SERVER_KEY=${"a".repeat(513)}\n`)).toBeNull();
    expect(parseApiKey("API_SERVER_KEY=has spaces inside the value here\n")).toBeNull();
    expect(parseApiKey("API_SERVER_KEY=<redacted-value-with-brackets>\n")).toBeNull();
  });

  it("does not treat a similarly named variable as the key", () => {
    expect(parseApiKey(`NOT_API_SERVER_KEY=${key}\nAPI_SERVER_KEY_OLD=${key}\n`)).toBeNull();
  });
});

describe("localAiAdapters - probe request contract (fetch mocked)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function respond(status: number, body: unknown): void {
    fetchMock.mockResolvedValueOnce({ status, text: async () => JSON.stringify(body) });
  }

  it("gatewayHealth: one GET to the fixed gateway /health, no credential, redirects refused", async () => {
    respond(200, { status: "ok" });
    expect(await probe("gatewayHealth")).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8642/health");
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect(init.headers).toBeUndefined();
  });

  it("proxyHealth: one GET to the fixed proxy /health", async () => {
    respond(200, { status: "ok" });
    expect(await probe("proxyHealth")).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0]![0]).toBe("http://127.0.0.1:8643/health");
  });

  it("health probes require both HTTP 200 and status 'ok'", async () => {
    respond(200, { status: "starting" });
    expect((await probe("gatewayHealth")).ok).toBe(false);
    respond(503, { status: "ok" });
    expect((await probe("gatewayHealth")).ok).toBe(false);
  });

  it("proxyRejectsMissingKey: POST to the proxy chat route with no Authorization header and an empty, non-task body", async () => {
    respond(401, { error: "unauthorized" });
    expect(await probe("proxyRejectsMissingKey")).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8643/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(Object.keys(init.headers as Record<string, string>)).toEqual(["Content-Type"]);
    expect(JSON.parse(init.body as string)).toEqual({ messages: [], stream: false });
  });

  it("proxyRejectsWrongKey: sends only a fixed invalid sentinel bearer, never the real key, and still an empty body", async () => {
    respond(401, {});
    expect(await probe("proxyRejectsWrongKey", FAKE_KEY)).toEqual({ ok: true });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${"0".repeat(64)}`);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(FAKE_KEY);
    expect(JSON.parse(init.body as string)).toEqual({ messages: [], stream: false });
  });

  it("a proxy that does not answer 401 is a definitive failure (auth not enforced), not something to wait out", async () => {
    respond(200, { choices: [] });
    expect(await probe("proxyRejectsMissingKey")).toEqual({ ok: false, definitive: true });
  });

  it("gatewayToolsets: GET with exactly one Authorization header; ok only when every toolset is disabled", async () => {
    respond(200, { data: [{ name: "web", enabled: false }, { name: "terminal", enabled: false }] });
    expect(await probe("gatewayToolsets", FAKE_KEY)).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8642/v1/toolsets?platform=api_server");
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({ Authorization: `Bearer ${FAKE_KEY}` });
  });

  it("gatewayToolsets: any enabled toolset is a definitive failure; a rejected key is definitive; an empty list is not ready yet", async () => {
    respond(200, { data: [{ name: "web", enabled: false }, { name: "terminal", enabled: true }] });
    expect(await probe("gatewayToolsets", FAKE_KEY)).toEqual({ ok: false, definitive: true });
    respond(401, { error: "bad key" });
    expect(await probe("gatewayToolsets", FAKE_KEY)).toEqual({ ok: false, definitive: true });
    respond(200, { data: [] });
    expect(await probe("gatewayToolsets", FAKE_KEY)).toEqual({ ok: false });
  });

  it("gatewayToolsets without a key makes no request at all", async () => {
    expect(await probe("gatewayToolsets")).toEqual({ ok: false, definitive: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a network error is an ordinary not-ready result, never an exception", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await probe("gatewayHealth")).toEqual({ ok: false });
  });

  it("a request that never answers is aborted and reported as timedOut", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const pending = probe("gatewayHealth");
    await vi.advanceTimersByTimeAsync(5_100);
    expect(await pending).toEqual({ ok: false, timedOut: true });
  });
});

describe("localAiAdapters - process and file boundary (static)", () => {
  it("spawns children directly, with the shell disabled and no window, in both places", () => {
    const spawnCalls = adaptersCode.match(/spawn\(/g) ?? [];
    expect(spawnCalls).toHaveLength(2);
    expect((adaptersCode.match(/shell: false/g) ?? []).length).toBe(2);
    expect((adaptersCode.match(/windowsHide: true/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(adaptersCode).not.toMatch(/shell: true/);
  });

  it("never uses exec(), shell strings, or hands the whole process environment to a child", () => {
    const childProcessImport = adaptersCode.match(/import \{([^}]*)\} from "node:child_process"/)?.[1] ?? "";
    const names = childProcessImport.split(",").map((name) => name.trim()).filter((name) => name.length > 0);
    expect(names.sort()).toEqual(["execFile", "spawn", "type ChildProcess"].sort());
    expect(adaptersCode).not.toMatch(/env: process\.env/);
    expect(adaptersCode).not.toMatch(/\.\.\.process\.env/);
  });

  it("uses execFile only for the fixed system taskkill executable, with numeric-pid arguments", () => {
    const uses = adaptersCode.match(/execFile\(/g) ?? [];
    expect(uses).toHaveLength(1);
    expect(adaptersCode).toMatch(/System32", "taskkill\.exe"/);
    expect(adaptersCode).toMatch(/Number\.isInteger\(pid\)/);
  });

  it("starts the proxy from the fixed checked-in script path, resolved relative to the compiled file", () => {
    expect(adaptersCode).toMatch(/path\.resolve\(__dirname, "\.\.", "\.\.", "scripts", "hermes-auth-proxy\.mjs"\)/);
  });

  it("reads the API key only from the fixed Hermes .env path, and never logs anything", () => {
    expect(adaptersCode).toMatch(/path\.join\(home, "\.env"\)/);
    expect(adaptersCode).not.toMatch(/console\./);
    expect(adaptersCode).not.toMatch(/logger|logLifecycle/);
  });

  it("attaches the child error listener before anything else can fail (no unhandled 'error' crash)", () => {
    const wrap = adaptersCode.match(/function wrapChild[\s\S]*?\n\}/)?.[0] ?? "";
    expect(wrap.indexOf('child.once("error"')).toBeGreaterThan(-1);
    expect(wrap.indexOf('child.once("error"')).toBeLessThan(wrap.indexOf("child.pid"));
  });

  it("has no ipcMain/ipcRenderer, storage, or renderer-controlled input of any kind", () => {
    for (const forbidden of [/ipcMain|ipcRenderer/, /localStorage|sessionStorage|indexedDB/, /safeStorage/, /writeFile|appendFile|createWriteStream/]) {
      expect(adaptersCode).not.toMatch(forbidden);
    }
  });
});

describe("localAiAdapters - production manager wiring", () => {
  it("creates a manager exposing exactly start/getState/retry/copyDiagnostics/shutdown", () => {
    const manager = createProductionLocalAiManager();
    expect(Object.keys(manager).sort()).toEqual(["copyDiagnostics", "getState", "retry", "shutdown", "start"]);
    expect(manager.getState()).toEqual({ state: "starting", stage: "checking" });
  });
});
