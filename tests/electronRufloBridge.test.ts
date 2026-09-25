import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  createRufloBridge,
  isRufloAgentType,
  RUFLO_AGENT_TYPES,
  ALLOWED_RUFLO_TOOLS,
  MAX_RUFLO_OUTPUT_CHARS,
  type RufloDeps,
  type RufloTransport,
} from "../electron/rufloBridge";

vi.mock("electron", () => ({ clipboard: { writeText: () => undefined } }));

const FAKE_KEY = "FAKE-RUFLO-KEY-0123456789-not-real";

interface FakeTransport extends RufloTransport {
  sent: Array<Record<string, unknown>>;
  emit(message: unknown): void;
  die(): void;
}

function makeTransport(handler: (message: Record<string, unknown>, t: FakeTransport) => void): FakeTransport {
  let exited = false;
  const lineListeners: Array<(line: string) => void> = [];
  const exitListeners: Array<() => void> = [];
  const t: FakeTransport = {
    sent: [],
    send(line) {
      if (exited) throw new Error("closed");
      const message = JSON.parse(line) as Record<string, unknown>;
      t.sent.push(message);
      handler(message, t);
    },
    onLine: (l) => void lineListeners.push(l),
    onExit: (l) => void exitListeners.push(l),
    hasExited: () => exited,
    emit(message) {
      for (const l of lineListeners) l(JSON.stringify(message));
    },
    die() {
      exited = true;
      for (const l of exitListeners) l();
    },
  };
  return t;
}

function toolText(payload: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/** A well-behaved Ruflo: answers initialize, agent_spawn, agent_execute and agent_terminate. */
function goodHandler(output = "ANSWER") {
  return (message: Record<string, unknown>, t: FakeTransport) => {
    if (message.id === undefined) return;
    const params = (message.params ?? {}) as Record<string, unknown>;
    if (message.method === "initialize") return t.emit({ jsonrpc: "2.0", id: message.id, result: { serverInfo: { name: "ruflo" } } });
    if (message.method === "tools/call") {
      const name = params.name as string;
      if (name === "agent_spawn") return t.emit({ jsonrpc: "2.0", id: message.id, result: toolText({ success: true }) });
      if (name === "agent_execute") return t.emit({ jsonrpc: "2.0", id: message.id, result: toolText({ success: true, output }) });
      if (name === "agent_terminate") return t.emit({ jsonrpc: "2.0", id: message.id, result: toolText({ success: true }) });
    }
    t.emit({ jsonrpc: "2.0", id: message.id, error: { message: "unknown" } });
  };
}

function makeDeps(handler: Parameters<typeof makeTransport>[0], key: string | null = FAKE_KEY) {
  const started: FakeTransport[] = [];
  const stopped: FakeTransport[] = [];
  const startKeys: string[] = [];
  const deps: RufloDeps = {
    readApiKey: async () => key,
    start: (apiKey) => {
      startKeys.push(apiKey);
      const t = makeTransport(handler);
      started.push(t);
      return t;
    },
    stop: async (t) => {
      stopped.push(t as FakeTransport);
    },
  };
  return { deps, started, stopped, startKeys };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("agent roles", () => {
  it("has the fixed role list and validates strictly", () => {
    expect([...RUFLO_AGENT_TYPES]).toEqual(["coder", "reviewer", "tester", "planner", "researcher", "system-architect", "security-auditor", "task-orchestrator"]);
    for (const good of RUFLO_AGENT_TYPES) expect(isRufloAgentType(good)).toBe(true);
    for (const bad of ["", "CODER", "coder ", "swarm_init", "../coder", 5, null, undefined, {}]) expect(isRufloAgentType(bad)).toBe(false);
  });

  it("the renderer model's role list is identical to the bridge's", () => {
    const model = fs.readFileSync(path.join(__dirname, "..", "electron", "workspace-model.ts"), "utf8");
    const ids = [...model.matchAll(/\{ id: "([a-z-]+)", label: "[^"]+" \}/g)].map((m) => m[1]);
    const roles = ids.filter((id) => (RUFLO_AGENT_TYPES as readonly string[]).includes(id ?? ""));
    expect(roles).toEqual([...RUFLO_AGENT_TYPES]);
  });

  it("only three Ruflo tools are ever callable", () => {
    expect([...ALLOWED_RUFLO_TOOLS]).toEqual(["agent_spawn", "agent_execute", "agent_terminate"]);
  });
});

describe("running an agent through the bridge", () => {
  it("starts lazily, performs the MCP handshake, spawns, executes and returns the plain-text output", async () => {
    const { deps, started, startKeys } = makeDeps(goodHandler("Merhaba"));
    const bridge = createRufloBridge(deps);
    expect(bridge.getState()).toBe("idle");
    expect(started).toHaveLength(0);
    const result = await bridge.run("planner", "Plan yap");
    expect(result).toEqual({ ok: true, text: "Merhaba" });
    expect(bridge.getState()).toBe("ready");
    expect(startKeys).toEqual([FAKE_KEY]);
    const methods = started[0]!.sent.map((m) => m.method);
    expect(methods.slice(0, 3)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    const calls = started[0]!.sent.filter((m) => m.method === "tools/call").map((m) => (m.params as { name: string }).name);
    expect(calls).toEqual(["agent_spawn", "agent_execute", "agent_terminate"]);
  });

  it("sends the role and the exact prompt, with a bounded token budget and no other argument", async () => {
    const { deps, started } = makeDeps(goodHandler());
    const bridge = createRufloBridge(deps);
    await bridge.run("reviewer", "İncele: x");
    const toolCalls = started[0]!.sent.filter((m) => m.method === "tools/call").map((m) => m.params as { name: string; arguments: Record<string, unknown> });
    const spawn = toolCalls.find((c) => c.name === "agent_spawn")!;
    expect(spawn.arguments.agentType).toBe("reviewer");
    expect(Object.keys(spawn.arguments).sort()).toEqual(["agentId", "agentType"]);
    const execute = toolCalls.find((c) => c.name === "agent_execute")!;
    expect(execute.arguments.prompt).toBe("İncele: x");
    expect(execute.arguments.agentId).toBe(spawn.arguments.agentId);
    expect(execute.arguments.maxTokens).toBe(2048);
    expect(Object.keys(execute.arguments).sort()).toEqual(["agentId", "maxTokens", "prompt"]);
  });

  it("reuses the running child for later runs", async () => {
    const { deps, started } = makeDeps(goodHandler());
    const bridge = createRufloBridge(deps);
    await bridge.run("coder", "bir");
    await bridge.run("tester", "iki");
    expect(started).toHaveLength(1);
  });

  it("rejects an unknown role, an empty or over-long prompt and non-string input without starting anything", async () => {
    const { deps, started } = makeDeps(goodHandler());
    const bridge = createRufloBridge(deps);
    expect((await bridge.run("hacker", "x")).ok).toBe(false);
    expect((await bridge.run("coder", "")).ok).toBe(false);
    expect((await bridge.run("coder", "   ")).ok).toBe(false);
    expect((await bridge.run("coder", "x".repeat(4001))).ok).toBe(false);
    expect((await bridge.run("coder", 5)).ok).toBe(false);
    expect((await bridge.run(undefined, "x")).ok).toBe(false);
    expect(started).toHaveLength(0);
  });

  it("bounds the output length", async () => {
    const { deps } = makeDeps(goodHandler("x".repeat(MAX_RUFLO_OUTPUT_CHARS + 500)));
    const result = await createRufloBridge(deps).run("coder", "x");
    expect(result.ok && result.text.length).toBe(MAX_RUFLO_OUTPUT_CHARS);
  });

  it("never allows a second concurrent run", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { deps } = makeDeps((message, t) => {
      if (message.method === "tools/call" && (message.params as { name: string }).name === "agent_execute") {
        void gate.then(() => t.emit({ jsonrpc: "2.0", id: message.id, result: toolText({ success: true, output: "late" }) }));
        return;
      }
      goodHandler()(message, t);
    });
    const bridge = createRufloBridge(deps);
    const first = bridge.run("coder", "bir");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await bridge.run("coder", "iki")).ok).toBe(false);
    release();
    expect((await first).ok).toBe(true);
  });
});

describe("failure handling", () => {
  it("reports unavailable (no throw) when the key is missing or the runtime cannot start", async () => {
    const noKey = createRufloBridge(makeDeps(goodHandler(), null).deps);
    expect(await noKey.run("coder", "x")).toEqual({ ok: false, reason: "unavailable" });
    expect(noKey.getState()).toBe("failed");
    const noStart = createRufloBridge({ readApiKey: async () => FAKE_KEY, start: () => null, stop: async () => undefined });
    expect(await noStart.run("coder", "x")).toEqual({ ok: false, reason: "unavailable" });
  });

  it("times out a handshake that never answers, stops the child and reports unavailable", async () => {
    vi.useFakeTimers();
    const { deps, stopped } = makeDeps(() => undefined);
    const bridge = createRufloBridge(deps, { handshakeMs: 1000, callMs: 1000, executeMs: 1000 });
    const promise = bridge.run("coder", "x");
    await vi.advanceTimersByTimeAsync(5000);
    expect(await promise).toEqual({ ok: false, reason: "unavailable" });
    expect(stopped.length).toBeGreaterThanOrEqual(1);
  });

  it("maps a failed spawn or a failed execute to a safe failure", async () => {
    const spawnFails = createRufloBridge(
      makeDeps((m, t) => {
        if (m.method === "tools/call" && (m.params as { name: string }).name === "agent_spawn") return t.emit({ jsonrpc: "2.0", id: m.id, result: toolText({ success: false, error: "no" }) });
        goodHandler()(m, t);
      }).deps,
    );
    expect(await spawnFails.run("coder", "x")).toEqual({ ok: false, reason: "failed" });
    const executeFails = createRufloBridge(
      makeDeps((m, t) => {
        if (m.method === "tools/call" && (m.params as { name: string }).name === "agent_execute") return t.emit({ jsonrpc: "2.0", id: m.id, result: toolText({ success: false, error: "provider secret detail" }) });
        goodHandler()(m, t);
      }).deps,
    );
    const result = await executeFails.run("coder", "x");
    expect(result).toEqual({ ok: false, reason: "failed" });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("treats malformed replies and non-text output as failures", async () => {
    const bad = createRufloBridge(
      makeDeps((m, t) => {
        if (m.method === "tools/call" && (m.params as { name: string }).name === "agent_execute") return t.emit({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "not json" }] } });
        goodHandler()(m, t);
      }).deps,
    );
    expect((await bad.run("coder", "x")).ok).toBe(false);
    const notString = createRufloBridge(
      makeDeps((m, t) => {
        if (m.method === "tools/call" && (m.params as { name: string }).name === "agent_execute") return t.emit({ jsonrpc: "2.0", id: m.id, result: toolText({ success: true, output: { a: 1 } }) });
        goodHandler()(m, t);
      }).deps,
    );
    expect((await notString.run("coder", "x")).ok).toBe(false);
  });

  it("restarts the child once when it died, and does not loop forever", async () => {
    let starts = 0;
    const deps: RufloDeps = {
      readApiKey: async () => FAKE_KEY,
      start: () => {
        starts += 1;
        const t = makeTransport((m, tt) => {
          if (starts === 1 && m.method === "tools/call") return tt.die();
          goodHandler("again")(m, tt);
        });
        return t;
      },
      stop: async () => undefined,
    };
    const bridge = createRufloBridge(deps);
    expect(await bridge.run("coder", "x")).toEqual({ ok: true, text: "again" });
    expect(starts).toBe(2);

    let alwaysDies = 0;
    const dying = createRufloBridge({
      readApiKey: async () => FAKE_KEY,
      start: () => {
        alwaysDies += 1;
        return makeTransport((m, tt) => {
          if (m.method === "initialize") return tt.die();
        });
      },
      stop: async () => undefined,
    });
    expect((await dying.run("coder", "x")).ok).toBe(false);
    expect(alwaysDies).toBeLessThanOrEqual(2);
  });

  it("shutdown stops the child, refuses new runs and is idempotent", async () => {
    const { deps, stopped } = makeDeps(goodHandler());
    const bridge = createRufloBridge(deps);
    await bridge.run("coder", "x");
    await bridge.shutdown();
    await bridge.shutdown();
    expect(stopped).toHaveLength(1);
    expect(bridge.getState()).toBe("idle");
    expect(await bridge.run("coder", "y")).toEqual({ ok: false, reason: "unavailable" });
  });

  it("the credential never appears in a result, error or state value", async () => {
    const { deps } = makeDeps((m, t) => {
      if (m.method === "tools/call" && (m.params as { name: string }).name === "agent_execute") return t.emit({ jsonrpc: "2.0", id: m.id, result: toolText({ success: false, error: FAKE_KEY }) });
      goodHandler()(m, t);
    });
    const bridge = createRufloBridge(deps);
    const result = await bridge.run("coder", "x");
    expect(JSON.stringify([result, bridge.getState()])).not.toContain(FAKE_KEY);
  });
});

describe("static properties", () => {
  const dir = path.join(__dirname, "..", "electron");
  const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  const bridge = strip(fs.readFileSync(path.join(dir, "rufloBridge.ts"), "utf8"));
  const adapters = strip(fs.readFileSync(path.join(dir, "rufloAdapters.ts"), "utf8"));

  it("the bridge is pure: no electron, node, network or process access", () => {
    expect(bridge).not.toMatch(/from ["'](electron|node:[^"']+)["']|process\.|fetch\(|require\(/);
  });

  it("the adapter spawns exactly once, without a shell, with fixed arguments and an allowlisted environment", () => {
    expect((adapters.match(/\bspawn\(/g) ?? []).length).toBe(1);
    expect(adapters).toContain("shell: false");
    expect(adapters).toContain('[cli, "mcp", "start"]');
    expect(adapters).not.toMatch(/env:\s*process\.env|\.\.\.process\.env|shell:\s*true|execSync|\bexec\(/);
  });

  it("nothing from the renderer reaches the child: the only spawn inputs are fixed paths and the credential", () => {
    expect(adapters).not.toMatch(/ipcMain|ipcRenderer|webContents|event\.sender/);
  });
});

import { resolveRuntimeDir, buildRufloEnvironment } from "../electron/rufloAdapters";

describe("adapter pure helpers", () => {
  const res = path.join("C:", "Apps", "Vyron", "resources");
  const compiled = path.join("D:", "Vyron Code", "dist-electron", "electron");
  const expectedDev = path.resolve(compiled, "..", "..", "build", "ruflo-runtime");

  it("resolves the runtime folder for packaged and development runs", () => {
    expect(resolveRuntimeDir(res, true, compiled)).toBe(path.join(res, "ruflo-runtime"));
    expect(resolveRuntimeDir(undefined, true, compiled)).toBe(expectedDev);
    expect(resolveRuntimeDir(res, false, compiled)).toBe(expectedDev);
  });

  it("builds an allowlisted environment that keeps Ruflo away from the real user profile", () => {
    const work = path.join("C:", "Data", "ruflo");
    const win = path.join("C:", "Windows");
    const env = buildRufloEnvironment(FAKE_KEY, work, win);
    expect(Object.keys(env).sort()).toEqual(
      ["APPDATA", "HOME", "LOCALAPPDATA", "OPENROUTER_API_KEY", "OPENROUTER_BASE_URL", "OPENROUTER_DEFAULT_MODEL", "PATH", "RUFLO_PROVIDER", "SystemRoot", "TEMP", "TMP", "USERPROFILE"].sort(),
    );
    expect(env.OPENROUTER_BASE_URL).toBe("http://127.0.0.1:8643");
    expect(env.RUFLO_PROVIDER).toBe("openrouter");
    expect(env.OPENROUTER_API_KEY).toBe(FAKE_KEY);
    for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) expect(String(env[key]).startsWith(work)).toBe(true);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(buildRufloEnvironment("k", work, undefined).SystemRoot).toMatch(/^C:.Windows$/);
  });
});
