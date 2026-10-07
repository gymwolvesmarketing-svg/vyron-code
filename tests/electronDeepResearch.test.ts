import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  DEEP_RESEARCH_AGENTS,
  KEY_SETUP_HELP,
  POLL_INTERVAL_MS,
  RESEARCH_BUDGET_MS,
  createDeepResearch,
  extractReport,
  type DeepResearchDeps,
  type HttpReply,
} from "../electron/deepResearch";
import { isAllowedPath, parseGeminiKey } from "../electron/deepResearchAdapter";
import { approvalRequest, describeCall, needsApproval, parseToolCall, parseToolCalls, TOOL_PROTOCOL } from "../electron/toolPolicy";

const KEY = "AIzaSyFAKEFAKEFAKEFAKEFAKEFAKEFAKE12345";
const REPORT = "# Rapor\n\nTürkiye performans giyim pazarı ... [1] https://kaynak.example";

interface Call {
  method: string;
  path: string;
  body: unknown;
  apiKey: string;
}

function makeDeps(replies: HttpReply[], options: { key?: string | null } = {}) {
  const calls: Call[] = [];
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const queue = replies.slice();
  const deps: DeepResearchDeps = {
    key: () => (options.key === undefined ? KEY : options.key),
    async request(method, requestPath, body, apiKey) {
      calls.push({ method, path: requestPath, body, apiKey });
      return queue.shift() ?? "failed";
    },
    async sleep(ms) {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  };
  return { deps, calls, sleeps };
}

const done = (text: string): HttpReply => ({ status: 200, body: { id: "int-1", status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text }] }] } });
const running: HttpReply = { status: 200, body: { id: "int-1", status: "in_progress" } };
const started: HttpReply = { status: 200, body: { id: "int-1", status: "in_progress" } };

describe("deep research driver", () => {
  it("starts a background interaction on the chosen agent, polls, and returns the labelled report", async () => {
    const { deps, calls, sleeps } = makeDeps([started, running, running, done(REPORT)]);
    const result = await createDeepResearch(deps).run("  Türkiye spor giyim pazarı  ", "fast");
    expect(result.ok).toBe(true);
    expect(result.text).toContain(REPORT);
    expect(result.text).toContain("web kaynaklarından derlendi");
    expect(calls[0]).toEqual({ method: "POST", path: "/v1beta/interactions", body: { input: "Türkiye spor giyim pazarı", agent: DEEP_RESEARCH_AGENTS.fast, background: true }, apiKey: KEY });
    expect(calls.slice(1).map((c) => c.method + " " + c.path)).toEqual(Array(3).fill("GET /v1beta/interactions/int-1"));
    expect(sleeps).toEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS, POLL_INTERVAL_MS]);
  });

  it("the Max depth uses the max agent", async () => {
    const { deps, calls } = makeDeps([started, done(REPORT)]);
    const result = await createDeepResearch(deps).run("soru", "max");
    expect(result.ok).toBe(true);
    expect((calls[0]?.body as { agent: string }).agent).toBe("deep-research-max-preview-04-2026");
    expect(result.text).toContain("Max");
  });

  it("without a key it explains where to put one and makes no request", async () => {
    const { deps, calls } = makeDeps([], { key: null });
    const result = await createDeepResearch(deps).run("soru", "fast");
    expect(result).toEqual({ ok: false, text: KEY_SETUP_HELP });
    expect(KEY_SETUP_HELP).toContain("VYRON_GEMINI_API_KEY");
    expect(calls).toHaveLength(0);
  });

  it("refuses an empty or oversized question without a request", async () => {
    const { deps, calls } = makeDeps([]);
    expect((await createDeepResearch(deps).run("   ", "fast")).ok).toBe(false);
    expect((await createDeepResearch(deps).run("x".repeat(4001), "fast")).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("maps start errors to short Turkish reasons and never echoes the key or the raw body", async () => {
    for (const [status, expected] of [[401, "reddedildi"], [403, "reddedildi"], [429, "kota"], [404, "bulunamadı"], [500, "HTTP 500"]] as const) {
      const { deps } = makeDeps([{ status, body: { error: { message: "secret " + KEY } } }]);
      const result = await createDeepResearch(deps).run("soru", "fast");
      expect(result.ok).toBe(false);
      expect(result.text).toContain(expected);
      expect(result.text).not.toContain(KEY);
      expect(result.text).not.toContain("secret");
    }
    // Google answers an invalid key with HTTP 400 and the error wrapped in an array.
    const wrongKey = makeDeps([{ status: 400, body: [{ error: { code: 400, message: "API key not valid. Please pass a valid API key.", details: [{ reason: "API_KEY_INVALID" }] } }] }]);
    const wrong = await createDeepResearch(wrongKey.deps).run("soru", "fast");
    expect(wrong.text).toContain("anahtarı reddedildi");
    expect(wrong.text).not.toContain("geçersiz bulundu");
    const bad = makeDeps([{ status: 400, body: { error: { message: "Invalid\n  agent   name" } } }]);
    expect((await createDeepResearch(bad.deps).run("soru", "fast")).text).toContain("Invalid agent name");
    expect((await createDeepResearch(makeDeps(["timeout"]).deps).run("soru", "fast")).text).toContain("zaman aşımı");
    expect((await createDeepResearch(makeDeps(["failed"]).deps).run("soru", "fast")).ok).toBe(false);
  });

  it("refuses a start reply with no safe interaction id", async () => {
    for (const body of [{}, { id: "../x" }, { id: "a/b" }, { id: 5 }, null]) {
      const { deps, calls } = makeDeps([{ status: 200, body }]);
      expect((await createDeepResearch(deps).run("soru", "fast")).ok).toBe(false);
      expect(calls).toHaveLength(1);
    }
  });

  it("reports a failed or cancelled research, with the id when the answer cannot be read", async () => {
    const failed = makeDeps([started, { status: 200, body: { status: "failed", error: { message: "quota  exhausted" } } }]);
    expect((await createDeepResearch(failed.deps).run("soru", "fast")).text).toContain("quota exhausted");
    const cancelled = makeDeps([started, { status: 200, body: { status: "cancelled" } }]);
    expect((await createDeepResearch(cancelled.deps).run("soru", "fast")).text).toContain("iptal");
    const empty = makeDeps([started, { status: 200, body: { status: "completed", steps: [] } }]);
    const result = await createDeepResearch(empty.deps).run("soru", "fast");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("int-1");
  });

  it("tolerates a few poll failures, then gives up with the id", async () => {
    const flaky = makeDeps([started, "failed", { status: 503, body: null }, "timeout", done(REPORT)]);
    expect((await createDeepResearch(flaky.deps).run("soru", "fast")).ok).toBe(true);
    const dead = makeDeps([started, "failed", "failed", "failed", "failed", "failed"]);
    const result = await createDeepResearch(dead.deps).run("soru", "fast");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("int-1");
  });

  it("stops polling on a hard poll error (key revoked mid-run)", async () => {
    const { deps, calls } = makeDeps([started, { status: 403, body: null }]);
    const result = await createDeepResearch(deps).run("soru", "fast");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("reddedildi");
    expect(calls).toHaveLength(2);
  });

  it("gives up at the wall-clock budget and says so", async () => {
    const polls = Math.ceil(RESEARCH_BUDGET_MS.fast / POLL_INTERVAL_MS) + 5;
    const { deps, calls } = makeDeps([started, ...Array<HttpReply>(polls).fill(running)]);
    const result = await createDeepResearch(deps).run("soru", "fast");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("20 dk");
    expect(result.text).toContain("int-1");
    expect(calls.length).toBeLessThanOrEqual(polls);
  });

  it("extracts the report from the last model_output step, and from the older flat fields", () => {
    expect(
      extractReport({ steps: [{ type: "model_output", content: [{ text: "ilk" }] }, { type: "thought", content: [{ text: "düşünce" }] }, { type: "model_output", content: [{ text: "A" }, { text: "B" }] }] }),
    ).toBe("A\n\nB");
    expect(extractReport({ output_text: "düz" })).toBe("düz");
    expect(extractReport({ outputs: [{ text: "x" }, { text: "y" }] })).toBe("x\n\ny");
    expect(extractReport({ steps: [] })).toBeNull();
    expect(extractReport(null)).toBeNull();
  });
});

describe("deep_research tool policy", () => {
  it("parses a request, defaulting to the fast agent and refusing bad fields", () => {
    expect(parseToolCall('{"tool":"deep_research","query":"  pazar analizi  "}')).toEqual({ kind: "call", call: { tool: "deep_research", query: "pazar analizi", depth: "fast" } });
    expect(parseToolCall('{"tool":"deep_research","query":"x","depth":"max"}')).toEqual({ kind: "call", call: { tool: "deep_research", query: "x", depth: "max" } });
    for (const raw of [
      '{"tool":"deep_research"}',
      '{"tool":"deep_research","query":""}',
      '{"tool":"deep_research","query":5}',
      '{"tool":"deep_research","query":"' + "x".repeat(4001) + '"}',
      '{"tool":"deep_research","query":"x","depth":"ultra"}',
    ]) {
      expect(parseToolCall(raw).kind).toBe("invalid");
    }
    expect(parseToolCalls('{"tool":"deep_research","query":"a"}\n{"tool":"read_file","path":"a.txt"}')).toHaveLength(2);
  });

  it("always needs the user's approval, and the dialog names the question, the kind, the cost and the wait", () => {
    const call = { tool: "deep_research", query: "Türkiye spor giyim pazarı 2026", depth: "max" } as const;
    expect(needsApproval(call)).toBe(true);
    const request = approvalRequest(call, "ws1", "Gymwolves", null)!;
    expect(request.title).toContain("derin araştırma");
    expect(request.message).toContain("Gymwolves");
    expect(request.detail).toContain("Türkiye spor giyim pazarı 2026");
    expect(request.detail).toContain("Max");
    expect(request.detail).toContain("ücretli");
    expect(request.detail).toContain("45");
    expect(request.key).toBe("deep-research|ws1|max");
    expect(approvalRequest({ ...call, depth: "fast" }, "ws1", "Gymwolves", null)!.key).toBe("deep-research|ws1|fast");
  });

  it("is described in the log and taught in the protocol", () => {
    expect(describeCall({ tool: "deep_research", query: "pazar", depth: "fast" })).toBe("derin araştırma (hızlı) pazar");
    expect(describeCall({ tool: "deep_research", query: "pazar", depth: "max" })).toBe("derin araştırma (max) pazar");
    expect(TOOL_PROTOCOL).toContain('"tool":"deep_research"');
  });
});

describe("deep research adapter", () => {
  it("reads only the VYRON_GEMINI_API_KEY line, accepting quotes and rejecting unusable values", () => {
    expect(parseGeminiKey("OTHER=1\nVYRON_GEMINI_API_KEY=" + KEY + "\n")).toBe(KEY);
    expect(parseGeminiKey('VYRON_GEMINI_API_KEY="' + KEY + '"')).toBe(KEY);
    expect(parseGeminiKey("VYRON_GEMINI_API_KEY='" + KEY + "'\r\n")).toBe(KEY);
    expect(parseGeminiKey("GEMINI_API_KEY=" + KEY)).toBeNull();
    expect(parseGeminiKey("VYRON_GEMINI_API_KEY=kisa")).toBeNull();
    expect(parseGeminiKey("VYRON_GEMINI_API_KEY=" + "a".repeat(600))).toBeNull();
    expect(parseGeminiKey("VYRON_GEMINI_API_KEY=abc def ghi jkl mno pqr")).toBeNull();
    expect(parseGeminiKey("")).toBeNull();
  });

  it("only ever requests the two fixed interaction paths", () => {
    expect(isAllowedPath("/v1beta/interactions")).toBe(true);
    expect(isAllowedPath("/v1beta/interactions/abc_DEF-123")).toBe(true);
    for (const bad of ["/v1beta/interactions/", "/v1beta/interactions/a/b", "/v1beta/interactions/../models", "/v1beta/models", "//evil.example/x", "/v1beta/interactions?key=1", ""]) {
      expect(isAllowedPath(bad)).toBe(false);
    }
  });
});

describe("deep research sources keep the key and the network contained", () => {
  const dir = path.join(__dirname, "..", "electron");
  const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("the driver imports nothing but the pure policy helper, and logs nothing", () => {
    const code = strip(fs.readFileSync(path.join(dir, "deepResearch.ts"), "utf8"));
    const imports = Array.from(code.matchAll(/from ["']([^"']+)["']/g)).map((m) => m[1]);
    expect(imports).toEqual(["./toolPolicy"]);
    expect(code).not.toMatch(/console\.|fetch\s*\(|process\.|require\(/);
  });

  it("the adapter sends the key only as the x-goog-api-key header to the one fixed origin, with no redirects, and never logs", () => {
    const raw = fs.readFileSync(path.join(dir, "deepResearchAdapter.ts"), "utf8");
    const code = strip(raw);
    expect(raw).toContain('"https://generativelanguage.googleapis.com"');
    expect(raw.match(/https?:\/\/[a-z]/g)).toHaveLength(1);
    expect(code).toContain('"x-goog-api-key": apiKey');
    expect(code).toContain('redirect: "error"');
    expect(code).not.toMatch(/console\.|localStorage|safeStorage|ipcMain|preload/);
    expect(code).not.toMatch(/[&?]key=/);
  });

  it("the key reaches neither the preload bridge nor the shared IPC contract nor the renderer", () => {
    for (const file of ["preload.ts", "shared-ipc-contract.ts", "renderer.ts"]) {
      expect(fs.readFileSync(path.join(dir, file), "utf8")).not.toMatch(/GEMINI|deepResearch/i);
    }
  });
});
