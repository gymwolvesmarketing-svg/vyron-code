import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  createLocalAiManager,
  DEFAULT_LOCAL_AI_TIMINGS,
  type ChildHandle,
  type LocalAiDeps,
  type ProbeKind,
  type ProbeResult,
} from "../electron/localAiLifecycle";

// A distinctive, obviously fake credential. It must never appear in any state, diagnostic or
// non-credential call recorded below.
const FAKE_KEY = "FAKE-TEST-KEY-abcdefghijklmnopqrstuvwxyz0123456789";

interface FakeChild extends ChildHandle {
  exit(): void;
  stopped: boolean;
}

function fakeChild(kind: "gateway" | "proxy"): FakeChild {
  let exited = false;
  const listeners: Array<() => void> = [];
  return {
    kind,
    stopped: false,
    hasExited: () => exited,
    onExit: (listener) => {
      listeners.push(listener);
    },
    exit() {
      exited = true;
      for (const listener of listeners) listener();
    },
  };
}

interface Model {
  gatewayHealthy: boolean;
  proxyHealthy: boolean;
  gatewayStartsOk: boolean;
  proxyStartsOk: boolean;
  gatewayHealthyAfterMs: number;
  proxyHealthyAfterMs: number;
  key: string | null;
  missingKeyProbe: ProbeResult;
  wrongKeyProbe: ProbeResult;
  toolsetsProbe: ProbeResult;
  applyOk: boolean;
  verifyOk: boolean;
  clipboardThrows: boolean;
}

function makeHarness(overrides: Partial<Model> = {}) {
  const model: Model = {
    gatewayHealthy: false,
    proxyHealthy: false,
    gatewayStartsOk: true,
    proxyStartsOk: true,
    gatewayHealthyAfterMs: 2_000,
    proxyHealthyAfterMs: 1_000,
    key: FAKE_KEY,
    missingKeyProbe: { ok: true },
    wrongKeyProbe: { ok: true },
    toolsetsProbe: { ok: true },
    applyOk: true,
    verifyOk: true,
    clipboardThrows: false,
    ...overrides,
  };
  let now = 1_000_000;
  let gatewayHealthyAt = model.gatewayHealthy ? 0 : Number.POSITIVE_INFINITY;
  let proxyHealthyAt = model.proxyHealthy ? 0 : Number.POSITIVE_INFINITY;
  const log = {
    startGateway: 0,
    startProxy: 0,
    keysGivenToProxy: [] as string[],
    keysGivenToAuthorization: [] as string[],
    probes: [] as Array<{ kind: ProbeKind; keyPresent: boolean }>,
    stopped: [] as string[],
    clears: 0,
    clipboard: [] as string[],
    verifyCalls: 0,
    order: [] as string[],
  };
  const children: FakeChild[] = [];
  const gates: Partial<Record<ProbeKind, Promise<void>>> = {};

  const deps: LocalAiDeps = {
    async probe(kind, apiKey) {
      log.probes.push({ kind, keyPresent: apiKey !== undefined });
      log.order.push(`probe:${kind}`);
      const gate = gates[kind];
      if (gate) await gate;
      switch (kind) {
        case "gatewayHealth":
          return { ok: now >= gatewayHealthyAt };
        case "proxyHealth":
          return { ok: now >= proxyHealthyAt };
        case "proxyRejectsMissingKey":
          return model.missingKeyProbe;
        case "proxyRejectsWrongKey":
          return model.wrongKeyProbe;
        case "gatewayToolsets":
          return model.toolsetsProbe;
      }
    },
    startGateway() {
      log.startGateway += 1;
      log.order.push("startGateway");
      if (!model.gatewayStartsOk) return null;
      const child = fakeChild("gateway");
      children.push(child);
      child.onExit(() => {
        gatewayHealthyAt = Number.POSITIVE_INFINITY;
      });
      gatewayHealthyAt = now + model.gatewayHealthyAfterMs;
      return child;
    },
    startProxy(apiKey) {
      log.startProxy += 1;
      log.order.push("startProxy");
      log.keysGivenToProxy.push(apiKey);
      if (!model.proxyStartsOk) return null;
      const child = fakeChild("proxy");
      children.push(child);
      child.onExit(() => {
        proxyHealthyAt = Number.POSITIVE_INFINITY;
      });
      proxyHealthyAt = now + model.proxyHealthyAfterMs;
      return child;
    },
    async stopChild(handle) {
      log.stopped.push(handle.kind);
      (handle as FakeChild).stopped = true;
      (handle as FakeChild).exit();
    },
    async readApiKey() {
      log.order.push("readApiKey");
      return model.key;
    },
    async applyAuthorization(apiKey) {
      log.order.push("applyAuthorization");
      log.keysGivenToAuthorization.push(apiKey);
      return model.applyOk;
    },
    clearAuthorization() {
      log.clears += 1;
    },
    async verifyConnection() {
      log.verifyCalls += 1;
      log.order.push("verifyConnection");
      return model.verifyOk;
    },
    writeClipboard(text) {
      if (model.clipboardThrows) throw new Error("clipboard unavailable");
      log.clipboard.push(text);
    },
    now: () => now,
    async sleep(ms) {
      now += ms;
      await Promise.resolve();
    },
  };

  const manager = createLocalAiManager(deps);
  return {
    manager,
    model,
    log,
    children,
    advance: (ms: number) => {
      now += ms;
    },
    clock: () => now,
    gate(kind: ProbeKind): () => void {
      let release!: () => void;
      gates[kind] = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        delete gates[kind];
        release();
      };
    },
    setGatewayHealthy(healthy: boolean) {
      gatewayHealthyAt = healthy ? 0 : Number.POSITIVE_INFINITY;
    },
  };
}

describe("localAiLifecycle - service reuse and ownership", () => {
  it("reuses a healthy pre-existing gateway and proxy: never starts a duplicate of either", async () => {
    const h = makeHarness({ gatewayHealthy: true, proxyHealthy: true });
    const state = await h.manager.start();
    expect(state).toEqual({ state: "ready" });
    expect(h.log.startGateway).toBe(0);
    expect(h.log.startProxy).toBe(0);
  });

  it("never stops a healthy pre-existing service, at shutdown or otherwise", async () => {
    const h = makeHarness({ gatewayHealthy: true, proxyHealthy: true });
    await h.manager.start();
    await h.manager.shutdown();
    expect(h.log.stopped).toEqual([]);
  });

  it("starts only the missing gateway (fixed official command) when the proxy is already healthy", async () => {
    const h = makeHarness({ proxyHealthy: true });
    const state = await h.manager.start();
    expect(state).toEqual({ state: "ready" });
    expect(h.log.startGateway).toBe(1);
    expect(h.log.startProxy).toBe(0);
  });

  it("starts only the missing proxy (fixed checked-in script) when the gateway is already healthy", async () => {
    const h = makeHarness({ gatewayHealthy: true });
    const state = await h.manager.start();
    expect(state).toEqual({ state: "ready" });
    expect(h.log.startGateway).toBe(0);
    expect(h.log.startProxy).toBe(1);
  });

  it("starts both, in order gateway then proxy, when neither is running, and reaches ready", async () => {
    const h = makeHarness();
    expect(await h.manager.start()).toEqual({ state: "ready" });
    expect(h.log.startGateway).toBe(1);
    expect(h.log.startProxy).toBe(1);
    expect(h.log.order.indexOf("startGateway")).toBeLessThan(h.log.order.indexOf("startProxy"));
  });

  it("stops only app-owned services at shutdown, and stops both of them", async () => {
    const h = makeHarness();
    await h.manager.start();
    await h.manager.shutdown();
    expect([...h.log.stopped].sort()).toEqual(["gateway", "proxy"]);
  });

  it("stops only the app-owned service when the other one was pre-existing", async () => {
    const h = makeHarness({ proxyHealthy: true });
    await h.manager.start();
    await h.manager.shutdown();
    expect(h.log.stopped).toEqual(["gateway"]);
  });

  it("clears the in-memory authorization on shutdown", async () => {
    const h = makeHarness({ gatewayHealthy: true, proxyHealthy: true });
    await h.manager.start();
    const before = h.log.clears;
    await h.manager.shutdown();
    expect(h.log.clears).toBeGreaterThan(before);
  });
});

describe("localAiLifecycle - credential boundary", () => {
  it("hands the key only to the proxy start, the toolset probe and the authorization step", async () => {
    const h = makeHarness();
    await h.manager.start();
    expect(h.log.keysGivenToProxy).toEqual([FAKE_KEY]);
    expect(h.log.keysGivenToAuthorization).toEqual([FAKE_KEY]);
    const withKey = h.log.probes.filter((p) => p.keyPresent).map((p) => p.kind);
    expect(withKey).toEqual(["gatewayToolsets"]);
  });

  it("never places the key in the state, the diagnostics text, or any other recorded value", async () => {
    const h = makeHarness();
    await h.manager.start();
    h.manager.copyDiagnostics();
    expect(JSON.stringify(h.manager.getState())).not.toContain(FAKE_KEY);
    for (const text of h.log.clipboard) expect(text).not.toContain(FAKE_KEY);
    expect(JSON.stringify(h.log.order)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(h.log.probes)).not.toContain(FAKE_KEY);
  });

  it("does not read the key at all when both services are already healthy but auth still needs it (key read once per run)", async () => {
    const h = makeHarness({ gatewayHealthy: true, proxyHealthy: true });
    await h.manager.start();
    expect(h.log.order.filter((step) => step === "readApiKey")).toHaveLength(1);
  });

  it("maps a missing key to a safe category without starting the proxy or authorizing", async () => {
    const h = makeHarness({ gatewayHealthy: true, key: null });
    const state = await h.manager.start();
    expect(state).toEqual({ state: "unavailable", category: "secure_connection_unverified" });
    expect(h.log.startProxy).toBe(0);
    expect(h.log.keysGivenToAuthorization).toEqual([]);
  });
});

describe("localAiLifecycle - bounded waits and safe failure categories", () => {
  it("gives up on a gateway that never becomes healthy after exactly the bounded timeout", async () => {
    const h = makeHarness({ gatewayHealthyAfterMs: Number.POSITIVE_INFINITY });
    const startedAt = h.clock();
    const state = await h.manager.start();
    expect(state).toEqual({ state: "unavailable", category: "hermes_start_failed" });
    const elapsed = h.clock() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(DEFAULT_LOCAL_AI_TIMINGS.gatewayReadyTimeoutMs);
    expect(elapsed).toBeLessThanOrEqual(DEFAULT_LOCAL_AI_TIMINGS.gatewayReadyTimeoutMs + DEFAULT_LOCAL_AI_TIMINGS.pollIntervalMs * 2);
  });

  it("maps a gateway that cannot be started at all to hermes_start_failed", async () => {
    const h = makeHarness({ gatewayStartsOk: false });
    expect(await h.manager.start()).toEqual({ state: "unavailable", category: "hermes_start_failed" });
    expect(h.log.startProxy).toBe(0);
  });

  it("maps a proxy that cannot be started to secure_connection_unverified", async () => {
    const h = makeHarness({ gatewayHealthy: true, proxyStartsOk: false });
    expect(await h.manager.start()).toEqual({ state: "unavailable", category: "secure_connection_unverified" });
  });

  it("gives up on a proxy that never becomes healthy after the bounded proxy timeout", async () => {
    const h = makeHarness({ gatewayHealthy: true, proxyHealthyAfterMs: Number.POSITIVE_INFINITY });
    const startedAt = h.clock();
    const state = await h.manager.start();
    expect(state).toEqual({ state: "unavailable", category: "secure_connection_unverified" });
    expect(h.clock() - startedAt).toBeLessThanOrEqual(DEFAULT_LOCAL_AI_TIMINGS.proxyReadyTimeoutMs + DEFAULT_LOCAL_AI_TIMINGS.pollIntervalMs * 2);
  });

  it("maps a health-check timeout during verification to model_unresponsive", async () => {
    const h = makeHarness({ gatewayHealthy: true, proxyHealthy: true, toolsetsProbe: { ok: false, timedOut: true } });
    const state = await h.manager.start();
    expect(state).toEqual({ state: "unavailable", category: "model_unresponsive" });
  });

  it("maps a failing final health verification to model_unresponsive", async () => {
    const h = makeHarness({ gatewayHealthy: true, proxyHealthy: true, verifyOk: false });
    expect(await h.manager.start()).toEqual({ state: "unavailable", category: "model_unresponsive" });
  });

  it("maps a failed authorization step to secure_connection_unverified", async () => {
    const h = makeHarness({ gatewayHealthy: true, proxyHealthy: true, applyOk: false });
    expect(await h.manager.start()).toEqual({ state: "unavailable", category: "secure_connection_unverified" });
  });

  it("never reports ready unless every check passed, and clears authorization on every failure", async () => {
    const h = makeHarness({ gatewayHealthy: true, proxyHealthy: true, verifyOk: false });
    await h.manager.start();
    expect(h.manager.getState().state).toBe("unavailable");
    expect(h.log.clears).toBeGreaterThan(0);
  });
});

describe("localAiLifecycle - D-11 security readiness checks", () => {
  it("fails closed, without waiting, when the proxy does not reject a missing key", async () => {
    const h = makeHarness({ gatewayHealthy: true, proxyHealthy: true, missingKeyProbe: { ok: false, definitive: true } });
    const startedAt = h.clock();
    expect(await h.manager.start()).toEqual({ state: "unavailable", category: "secure_connection_unverified" });
    expect(h.clock() - startedAt).toBeLessThan(DEFAULT_LOCAL_AI_TIMINGS.pollIntervalMs);
    expect(h.log.keysGivenToAuthorization).toEqual([]);
  });

  it("fails closed when the proxy does not reject a wrong key", async () => {
    const h = makeHarness({ gatewayHealthy: true, proxyHealthy: true, wrongKeyProbe: { ok: false, definitive: true } });
    expect(await h.manager.start()).toEqual({ state: "unavailable", category: "secure_connection_unverified" });
    expect(h.log.keysGivenToAuthorization).toEqual([]);
  });

  it("fails closed when the API Server profile has any enabled toolset", async () => {
    const h = makeHarness({ gatewayHealthy: true, proxyHealthy: true, toolsetsProbe: { ok: false, definitive: true } });
    expect(await h.manager.start()).toEqual({ state: "unavailable", category: "secure_connection_unverified" });
    expect(h.log.keysGivenToAuthorization).toEqual([]);
  });

  it("runs the auth, toolset and health checks before authorizing, and authorizes before the final health check", async () => {
    const h = makeHarness({ gatewayHealthy: true, proxyHealthy: true });
    await h.manager.start();
    const order = h.log.order;
    const idx = (step: string) => order.indexOf(step);
    expect(idx("probe:proxyRejectsMissingKey")).toBeLessThan(idx("applyAuthorization"));
    expect(idx("probe:proxyRejectsWrongKey")).toBeLessThan(idx("applyAuthorization"));
    expect(idx("probe:gatewayToolsets")).toBeLessThan(idx("applyAuthorization"));
    expect(idx("applyAuthorization")).toBeLessThan(idx("verifyConnection"));
  });

  it("uses only fixed probe kinds and never a task send during startup", async () => {
    const h = makeHarness();
    await h.manager.start();
    const allowed = new Set<ProbeKind>(["gatewayHealth", "proxyHealth", "proxyRejectsMissingKey", "proxyRejectsWrongKey", "gatewayToolsets"]);
    for (const probe of h.log.probes) expect(allowed.has(probe.kind)).toBe(true);
    expect(h.log.verifyCalls).toBe(1);
  });

  it("the dependency interface accepts no host, port, path, URL, command or environment parameter", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "electron", "localAiLifecycle.ts"), "utf8");
    const block = source.match(/export interface LocalAiDeps \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(block.length).toBeGreaterThan(0);
    const code = block.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const forbidden of [/\burl\b/i, /\bhost\b/i, /\bport\b/i, /\bpath\b/i, /\bcommand\b/i, /\benv\b/i, /\bargs?\b/i, /\bexecutable\b/i]) {
      expect(code).not.toMatch(forbidden);
    }
  });
});

describe("localAiLifecycle - unexpected exits, retry and staleness", () => {
  it("moves to unavailable and clears authorization when an app-owned child exits after ready", async () => {
    const h = makeHarness();
    await h.manager.start();
    expect(h.manager.getState()).toEqual({ state: "ready" });
    const clearsBefore = h.log.clears;
    h.children.find((c) => c.kind === "gateway")!.exit();
    expect(h.manager.getState()).toEqual({ state: "unavailable", category: "unavailable" });
    expect(h.log.clears).toBeGreaterThan(clearsBefore);
  });

  it("maps a gateway child that exits while starting to hermes_start_failed, without waiting out the timeout", async () => {
    const h = makeHarness({ gatewayHealthyAfterMs: Number.POSITIVE_INFINITY });
    const release = h.gate("gatewayHealth");
    const pending = h.manager.start();
    release();
    await Promise.resolve();
    // Let the run begin its bounded wait, then make the child die.
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.children.find((c) => c.kind === "gateway")?.exit();
    const startedAt = h.clock();
    const state = await pending;
    expect(state).toEqual({ state: "unavailable", category: "hermes_start_failed" });
    expect(h.clock() - startedAt).toBeLessThan(DEFAULT_LOCAL_AI_TIMINGS.gatewayReadyTimeoutMs);
  });

  it("does not restart anything automatically after a failure, however much time passes", async () => {
    const h = makeHarness({ gatewayStartsOk: false });
    await h.manager.start();
    h.advance(10 * 60 * 1000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.log.startGateway).toBe(1);
    expect(h.manager.getState().state).toBe("unavailable");
  });

  it("allows one explicit retry from unavailable, which can then succeed", async () => {
    const h = makeHarness({ gatewayStartsOk: false });
    await h.manager.start();
    expect(h.manager.getState().state).toBe("unavailable");
    h.model.gatewayStartsOk = true;
    const immediate = h.manager.retry();
    expect(immediate).toEqual({ state: "starting", stage: "checking" });
    const final = await h.manager.start();
    expect(final).toEqual({ state: "ready" });
    expect(h.log.startGateway).toBe(2);
  });

  it("ignores retry unless the state is unavailable", async () => {
    const h = makeHarness({ gatewayHealthy: true, proxyHealthy: true });
    await h.manager.start();
    expect(h.manager.retry()).toEqual({ state: "ready" });
    expect(h.log.startGateway).toBe(0);
  });

  it("a retry reuses a still-healthy app-owned service rather than starting a second copy", async () => {
    const h = makeHarness({ toolsetsProbe: { ok: false, definitive: true } });
    await h.manager.start();
    expect(h.manager.getState().state).toBe("unavailable");
    h.model.toolsetsProbe = { ok: true };
    h.manager.retry();
    await h.manager.start();
    expect(h.manager.getState()).toEqual({ state: "ready" });
    expect(h.log.startGateway).toBe(1);
    expect(h.log.startProxy).toBe(1);
  });

  it("a retry replaces a dead app-owned child instead of mistaking its old exit for a new failure", async () => {
    const h = makeHarness();
    await h.manager.start();
    h.children.find((c) => c.kind === "proxy")!.exit();
    h.setGatewayHealthy(true);
    expect(h.manager.getState().state).toBe("unavailable");
    h.manager.retry();
    expect(await h.manager.start()).toEqual({ state: "ready" });
    expect(h.log.startProxy).toBe(2);
  });

  it("a stale startup completion cannot overwrite the state or continue after shutdown", async () => {
    const h = makeHarness();
    const release = h.gate("gatewayHealth");
    const pending = h.manager.start();
    await Promise.resolve();
    await h.manager.shutdown();
    release();
    await pending;
    expect(h.manager.getState().state).not.toBe("ready");
    expect(h.log.startGateway).toBe(0);
    expect(h.log.startProxy).toBe(0);
  });

  it("start() after shutdown does nothing", async () => {
    const h = makeHarness();
    await h.manager.shutdown();
    await h.manager.start();
    expect(h.log.startGateway).toBe(0);
    expect(h.log.probes).toEqual([]);
  });

  it("reports the current stage while starting, using only the fixed stage vocabulary", async () => {
    const h = makeHarness({ gatewayHealthy: true, proxyHealthy: true });
    const release = h.gate("proxyRejectsMissingKey");
    const pending = h.manager.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.manager.getState()).toEqual({ state: "starting", stage: "verifying" });
    release();
    await pending;
  });
});

describe("localAiLifecycle - sanitized, bounded diagnostics", () => {
  it("copies only generic stage names, outcomes, offsets and a category - nothing else", async () => {
    const h = makeHarness({ gatewayStartsOk: false });
    await h.manager.start();
    expect(h.manager.copyDiagnostics()).toEqual({ copied: true });
    const text = h.log.clipboard[0] ?? "";
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(2_000);
    expect(text).toMatch(/^[A-Za-z0-9_ :+\n-]*$/);
    expect(text).toContain("Kategori: hermes_start_failed");
    for (const forbidden of [/https?:/i, /127\.0\.0\.1/, /localhost/i, /\\/, /[A-Za-z]:\//, /8642|8643/, /bearer/i, /api[_-]?key/i, /\.env/i]) {
      expect(text).not.toMatch(forbidden);
    }
  });

  it("returns copied:false instead of throwing when the clipboard fails, and never returns the text", async () => {
    const h = makeHarness({ clipboardThrows: true });
    await h.manager.start();
    const result = h.manager.copyDiagnostics();
    expect(result).toEqual({ copied: false });
    expect(Object.keys(result)).toEqual(["copied"]);
  });

  it("keeps the diagnostic timeline bounded", async () => {
    const h = makeHarness();
    await h.manager.start();
    h.manager.copyDiagnostics();
    const lines = (h.log.clipboard[0] ?? "").split("\n").filter((line) => line.startsWith("+"));
    expect(lines.length).toBeLessThanOrEqual(40);
  });
});

describe("electron/localAiLifecycle.ts - module isolation", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "electron", "localAiLifecycle.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("imports only types from the shared contract - nothing from Electron, Node, or the network", () => {
    const imports = code.match(/^import .*$/gm) ?? [];
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatch(/^import type \{[^}]*\} from "\.\/shared-ipc-contract";$/);
  });

  it("performs no I/O of its own: no process/env/fs/fetch/console/timer references", () => {
    for (const forbidden of [/process\./, /require\(/, /\bfetch\(/, /console\./, /setTimeout|setInterval/, /child_process/, /\bexec\(|\bspawn\(/]) {
      expect(code).not.toMatch(forbidden);
    }
  });
});
