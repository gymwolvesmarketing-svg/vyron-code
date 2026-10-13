import { modelForRole, parseModelChoice, withToolsRouting } from "../electron/modelRouting";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { getTaskSubmissionState, sendTask, clearTaskSubmission, setTaskAgentExecutor, setToolRunner, setAgentAsk } from "../electron/hermesTaskSubmission";
import { beginAuthorization, clearAuthorization } from "../electron/hermesAuthorization";
import { configureEndpoint, clearEndpointConfiguration } from "../electron/hermesEndpointSetup";

// Every value below is an explicit, obviously-fake sample - never a real Hermes API key, never real
// task/response content, and never read from .env or process.env. `global.fetch` is fully mocked;
// nothing in this file reaches a real socket. Real local runtime acceptance is recorded separately.
const PLACEHOLDER_CREDENTIAL = "placeholder-test-api-server-key-not-real";
const FAKE_LOOPBACK_ENDPOINT = "http://127.0.0.1:19130";
const VALID_DRAFT = "placeholder test task draft - reply with a short acknowledgement";
const SAFE_KEYS = ["state", "text", "truncated"].sort();

const fetchMock = vi.fn();

async function authorizeAndConfigure(): Promise<void> {
  await beginAuthorization({ credential: PLACEHOLDER_CREDENTIAL });
  await configureEndpoint({ endpoint: FAKE_LOOPBACK_ENDPOINT });
}

function chatCompletionBody(content: string): unknown {
  return {
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: 0,
    model: "hermes-agent",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function okResponse(content: string) {
  return { ok: true, status: 200, json: async () => chatCompletionBody(content) };
}

beforeEach(() => {
  clearAuthorization();
  clearEndpointConfiguration();
  clearTaskSubmission();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getTaskSubmissionState - safe ambient state, gated on authorization and endpoint configuration", () => {
  it("reports unauthorized before any authorization exists", () => {
    expect(getTaskSubmissionState()).toEqual({ state: "unauthorized", text: null, truncated: false });
  });

  it("reports unavailable once authorized but before any endpoint is configured", async () => {
    await beginAuthorization({ credential: PLACEHOLDER_CREDENTIAL });
    expect(getTaskSubmissionState()).toEqual({ state: "unavailable", text: null, truncated: false });
  });

  it("reports idle once both authorized and a valid endpoint is configured", async () => {
    await authorizeAndConfigure();
    expect(getTaskSubmissionState()).toEqual({ state: "idle", text: null, truncated: false });
  });

  it("never includes an endpoint, API key, or any field beyond the three safe ones", async () => {
    await authorizeAndConfigure();
    expect(Object.keys(getTaskSubmissionState()).sort()).toEqual(SAFE_KEYS);
  });
});

describe("sendTask - validation and precondition gating (there is no review step)", () => {
  it("fails safely with unauthorized when authorization has not been granted, and never sends", async () => {
    expect(await sendTask({ draft: VALID_DRAFT })).toEqual({ state: "unauthorized", text: null, truncated: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails safely with unavailable when authorized but no endpoint is configured", async () => {
    await beginAuthorization({ credential: PLACEHOLDER_CREDENTIAL });
    expect((await sendTask({ draft: VALID_DRAFT })).state).toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends a valid draft directly, in one call, with no prior review", async () => {
    await authorizeAndConfigure();
    fetchMock.mockResolvedValueOnce(okResponse("ack"));
    const result = await sendTask({ draft: VALID_DRAFT });
    expect(result).toEqual({ state: "completed", text: "ack", truncated: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", "  \n\t "],
    ["over the maximum length", "x".repeat(100_001)],
    ["containing a NUL control character", "hello" + String.fromCharCode(0) + "world"],
    ["containing a bell control character", "hello" + String.fromCharCode(7)],
  ])("rejects a draft that is %s without sending", async (_label, draft) => {
    await authorizeAndConfigure();
    expect((await sendTask({ draft })).state).toBe("safe_failure");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a draft of exactly the maximum length, and multi-line text with tabs", async () => {
    await authorizeAndConfigure();
    fetchMock.mockResolvedValue(okResponse("ok"));
    expect((await sendTask({ draft: "x".repeat(100_000) })).state).toBe("completed");
    expect((await sendTask({ draft: "line one\n\tline two\r\nline three" })).state).toBe("completed");
  });

  it.each([
    ["a non-object", "hello"],
    ["null", null],
    ["an array", ["hello"]],
    ["an extra field", { draft: VALID_DRAFT, model: "other" }],
    ["a wrong field name", { text: VALID_DRAFT }],
    ["a non-string draft", { draft: 5 }],
  ])("rejects a malformed request (%s) without sending", async (_label, request) => {
    await authorizeAndConfigure();
    expect((await sendTask(request)).state).toBe("safe_failure");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("sendTask - request contract (fixed POST /v1/chat/completions only)", () => {
  it("sends exactly one POST to <origin>/v1/chat/completions with the exact minimal contract", async () => {
    await authorizeAndConfigure();
    fetchMock.mockResolvedValueOnce(okResponse("ack"));
    const result = await sendTask({ draft: VALID_DRAFT });
    expect(result.state).toBe("completed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:19130/v1/chat/completions");
    expect(options.method).toBe("POST");
    expect(options.redirect).toBe("error");
    const headers = options.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${PLACEHOLDER_CREDENTIAL}`);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(Object.keys(headers).sort()).toEqual(["Authorization", "Content-Type"].sort());
    const body = JSON.parse(options.body as string);
    expect(body).toEqual({ messages: [{ role: "user", content: VALID_DRAFT }], stream: false });
    expect(body.model).toBeUndefined();
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.provider).toBeUndefined();
  });

  it("always sends to the endpoint's own origin, discarding any configured /v1 path", async () => {
    await beginAuthorization({ credential: PLACEHOLDER_CREDENTIAL });
    await configureEndpoint({ endpoint: "http://127.0.0.1:19130/v1" });
    fetchMock.mockResolvedValueOnce(okResponse("ack"));
    await sendTask({ draft: VALID_DRAFT });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("http://127.0.0.1:19130/v1/chat/completions");
  });

  it("extracts choices[0].message.content as the safe response text", async () => {
    await authorizeAndConfigure();
    fetchMock.mockResolvedValueOnce(okResponse("VYRON_D11_TEXT_ONLY_OK"));
    expect(await sendTask({ draft: VALID_DRAFT })).toEqual({ state: "completed", text: "VYRON_D11_TEXT_ONLY_OK", truncated: false });
  });

  it("truncates a response exceeding the bounded maximum and flags truncated: true", async () => {
    await authorizeAndConfigure();
    const longText = "x".repeat(250_000);
    fetchMock.mockResolvedValueOnce(okResponse(longText));
    const result = await sendTask({ draft: VALID_DRAFT });
    expect(result.state).toBe("completed");
    expect(result.truncated).toBe(true);
    expect(result.text).toBe(longText.slice(0, 200_000));
  });

  it("maps a non-ok HTTP response to safe_failure, never exposing the raw status", async () => {
    await authorizeAndConfigure();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    expect(await sendTask({ draft: VALID_DRAFT })).toEqual({ state: "safe_failure", text: null, truncated: false });
  });

  it("maps a rejected fetch (connection refused) and an abort (timeout) to safe_failure", async () => {
    await authorizeAndConfigure();
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect((await sendTask({ draft: VALID_DRAFT })).state).toBe("safe_failure");
    fetchMock.mockRejectedValueOnce(new DOMException("The operation was aborted.", "AbortError"));
    expect((await sendTask({ draft: VALID_DRAFT })).state).toBe("safe_failure");
  });

  it("maps a tool-call-shaped or non-text response to safe_failure - never renders or executes structured content", async () => {
    await authorizeAndConfigure();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "1", function: { name: "terminal", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
      }),
    });
    expect((await sendTask({ draft: VALID_DRAFT })).state).toBe("safe_failure");
  });

  it("maps a provider error that came back as the message text to safe_failure, not to an answer", async () => {
    await authorizeAndConfigure();
    for (const errorText of ["[Error: Perplexity error: INVALID_MODEL_SELECTION]", "  [error: upstream failed]"]) {
      fetchMock.mockResolvedValueOnce(okResponse(errorText));
      expect(await sendTask({ draft: VALID_DRAFT })).toEqual({ state: "safe_failure", text: null, truncated: false });
    }
    fetchMock.mockResolvedValueOnce(okResponse("Hata [Error: x] hakkında bir açıklama"));
    expect((await sendTask({ draft: VALID_DRAFT })).state).toBe("completed");
  });

  it("maps a missing or malformed choices array to safe_failure", async () => {
    await authorizeAndConfigure();
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
    expect((await sendTask({ draft: VALID_DRAFT })).state).toBe("safe_failure");
  });

  it("allows another task to be sent after a failure (the next send is a fresh attempt)", async () => {
    await authorizeAndConfigure();
    fetchMock.mockRejectedValueOnce(new Error("boom"));
    expect((await sendTask({ draft: VALID_DRAFT })).state).toBe("safe_failure");
    fetchMock.mockResolvedValueOnce(okResponse("second"));
    expect(await sendTask({ draft: VALID_DRAFT })).toEqual({ state: "completed", text: "second", truncated: false });
  });
});

describe("sendTask - lifecycle and bounds", () => {
  it("bounds to one send in flight - a duplicate call while one is pending is reduced to sending, not a second request", async () => {
    await authorizeAndConfigure();
    let resolveFirst: (value: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const first = sendTask({ draft: VALID_DRAFT });
    const second = await sendTask({ draft: VALID_DRAFT });
    expect(second.state).toBe("sending");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFirst(okResponse("ack"));
    expect((await first).state).toBe("completed");
  });

  it("reports sending through getTaskSubmissionState while a request is pending", async () => {
    await authorizeAndConfigure();
    let resolveFirst: (value: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const pending = sendTask({ draft: VALID_DRAFT });
    expect(getTaskSubmissionState().state).toBe("sending");
    resolveFirst(okResponse("ack"));
    await pending;
    expect(getTaskSubmissionState().state).toBe("completed");
  });
});

describe("clearTaskSubmission", () => {
  it("is idempotent - safe to call with nothing sent", () => {
    expect(() => clearTaskSubmission()).not.toThrow();
    expect(clearTaskSubmission()).toEqual({ state: "unauthorized", text: null, truncated: false });
  });

  it("resets a completed state back to idle, discarding the completed response text", async () => {
    await authorizeAndConfigure();
    fetchMock.mockResolvedValueOnce(okResponse("ack"));
    await sendTask({ draft: VALID_DRAFT });
    expect(getTaskSubmissionState().state).toBe("completed");
    clearTaskSubmission();
    expect(getTaskSubmissionState()).toEqual({ state: "idle", text: null, truncated: false });
  });

  it("sends no network request of its own", async () => {
    await authorizeAndConfigure();
    clearTaskSubmission();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("cross-module cleanup - task submission state clears on every revoke path (T-17-style)", () => {
  it("clearing authorization makes a completed state unreachable (self-heal)", async () => {
    await authorizeAndConfigure();
    fetchMock.mockResolvedValueOnce(okResponse("ack"));
    await sendTask({ draft: VALID_DRAFT });
    clearAuthorization();
    expect(getTaskSubmissionState()).toEqual({ state: "unauthorized", text: null, truncated: false });
  });

  it("clearing the endpoint configuration makes a completed state unreachable (self-heal)", async () => {
    await authorizeAndConfigure();
    fetchMock.mockResolvedValueOnce(okResponse("ack"));
    await sendTask({ draft: VALID_DRAFT });
    clearEndpointConfiguration();
    expect(getTaskSubmissionState()).toEqual({ state: "unavailable", text: null, truncated: false });
  });

  it("a stale send completion cannot restore completed after an intervening clearTaskSubmission()", async () => {
    await authorizeAndConfigure();
    let resolveFetch: (value: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const pending = sendTask({ draft: VALID_DRAFT });
    clearTaskSubmission();
    resolveFetch(okResponse("ack"));
    const result = await pending;
    expect(result.state).not.toBe("completed");
    expect(getTaskSubmissionState().state).not.toBe("completed");
  });

  it("a stale send completion cannot restore completed after an intervening clearAuthorization()", async () => {
    await authorizeAndConfigure();
    let resolveFetch: (value: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const pending = sendTask({ draft: VALID_DRAFT });
    clearAuthorization();
    resolveFetch(okResponse("ack"));
    expect((await pending).state).not.toBe("completed");
  });

  it("a clear during a pending send does not block the next send from starting", async () => {
    await authorizeAndConfigure();
    let resolveFetch: (value: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const stale = sendTask({ draft: VALID_DRAFT });
    clearTaskSubmission();
    fetchMock.mockResolvedValueOnce(okResponse("fresh"));
    const fresh = await sendTask({ draft: VALID_DRAFT });
    expect(fresh).toEqual({ state: "completed", text: "fresh", truncated: false });
    resolveFetch(okResponse("late"));
    await stale;
    expect(getTaskSubmissionState()).toEqual({ state: "completed", text: "fresh", truncated: false });
  });
});

describe("security regressions", () => {
  it("getTaskSubmissionState/clearTaskSubmission take no parameters; sendTask takes exactly one", () => {
    expect(getTaskSubmissionState.length).toBe(0);
    expect(clearTaskSubmission.length).toBe(0);
    expect(sendTask.length).toBe(1);
  });

  it("no result object from any exported function ever carries a field beyond the three safe ones", async () => {
    await authorizeAndConfigure();
    fetchMock.mockResolvedValueOnce(okResponse("ack"));
    expect(Object.keys(await sendTask({ draft: VALID_DRAFT })).sort()).toEqual(SAFE_KEYS);
    expect(Object.keys(clearTaskSubmission()).sort()).toEqual(SAFE_KEYS);
    expect(Object.keys(await sendTask({ draft: "" })).sort()).toEqual(SAFE_KEYS);
  });

  it("never sends the credential in the URL, body, or anywhere but the Authorization header", async () => {
    await authorizeAndConfigure();
    fetchMock.mockResolvedValueOnce(okResponse("ack"));
    await sendTask({ draft: VALID_DRAFT });
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain(PLACEHOLDER_CREDENTIAL);
    expect(options.body as string).not.toContain(PLACEHOLDER_CREDENTIAL);
    expect((options.headers as Record<string, string>)["Authorization"]).toContain(PLACEHOLDER_CREDENTIAL);
  });

  it("never sends a query string, cookie, or redirect-follow option", async () => {
    await authorizeAndConfigure();
    fetchMock.mockResolvedValueOnce(okResponse("ack"));
    await sendTask({ draft: VALID_DRAFT });
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain("?");
    expect(options).not.toHaveProperty("credentials");
    expect(options.redirect).toBe("error");
  });

  it("never echoes the task text back through a failure result", async () => {
    await authorizeAndConfigure();
    fetchMock.mockRejectedValueOnce(new Error("boom " + VALID_DRAFT));
    const result = await sendTask({ draft: VALID_DRAFT });
    expect(JSON.stringify(result)).not.toContain(VALID_DRAFT);
  });
});

describe("sendTask - Manager (agent) tasks run through the injected executor", () => {
  afterEach(() => setTaskAgentExecutor(null));

  it("runs the task through the executor with the role and the exact draft, and never calls Hermes directly", async () => {
    await authorizeAndConfigure();
    const executor = vi.fn(async () => ({ ok: true as const, text: "from ruflo" }));
    setTaskAgentExecutor(executor);
    const result = await sendTask({ draft: VALID_DRAFT, agent: "planner" });
    expect(result).toEqual({ state: "completed", text: "from ruflo", truncated: false });
    expect(executor).toHaveBeenCalledWith("planner", VALID_DRAFT, undefined, undefined);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds and truncates an executor answer exactly like a direct one", async () => {
    await authorizeAndConfigure();
    setTaskAgentExecutor(async () => ({ ok: true as const, text: "y".repeat(250000) }));
    const result = await sendTask({ draft: VALID_DRAFT, agent: "coder" });
    expect(result.truncated).toBe(true);
    expect(result.text).toHaveLength(200000);
  });

  it("maps an executor failure or throw to safe_failure and lets the next task run", async () => {
    await authorizeAndConfigure();
    setTaskAgentExecutor(async () => ({ ok: false as const }));
    expect((await sendTask({ draft: VALID_DRAFT, agent: "coder" })).state).toBe("safe_failure");
    setTaskAgentExecutor(async () => {
      throw new Error("boom");
    });
    expect((await sendTask({ draft: VALID_DRAFT, agent: "coder" })).state).toBe("safe_failure");
    fetchMock.mockResolvedValueOnce(okResponse("direct"));
    expect(await sendTask({ draft: VALID_DRAFT })).toEqual({ state: "completed", text: "direct", truncated: false });
  });

  it.each([
    ["an unknown role", { draft: VALID_DRAFT, agent: "hacker" }],
    ["a non-string role", { draft: VALID_DRAFT, agent: 7 }],
    ["a role with extra fields", { draft: VALID_DRAFT, agent: "coder", model: "x" }],
    ["a role without a draft", { agent: "coder" }],
  ])("rejects %s without running anything", async (_label, request) => {
    await authorizeAndConfigure();
    const executor = vi.fn(async () => ({ ok: true as const, text: "no" }));
    setTaskAgentExecutor(executor);
    expect((await sendTask(request)).state).toBe("safe_failure");
    expect(executor).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes a valid project slug to the executor, and rejects unsafe or misplaced project values", async () => {
    await authorizeAndConfigure();
    const executor = vi.fn(async () => ({ ok: true as const, text: "ok" }));
    setTaskAgentExecutor(executor);
    expect((await sendTask({ draft: VALID_DRAFT, agent: "planner", project: "aetheris" })).state).toBe("completed");
    expect(executor).toHaveBeenLastCalledWith("planner", VALID_DRAFT, "aetheris", undefined);
    expect((await sendTask({ draft: VALID_DRAFT, agent: "planner" })).state).toBe("completed");
    expect(executor).toHaveBeenLastCalledWith("planner", VALID_DRAFT, undefined, undefined);
    executor.mockClear();
    for (const project of ["../x", "A", "", "a b", 5, null, "x".repeat(81)]) {
      expect((await sendTask({ draft: VALID_DRAFT, agent: "planner", project })).state, String(project)).toBe("safe_failure");
    }
    expect((await sendTask({ draft: VALID_DRAFT, project: "aetheris" })).state).toBe("safe_failure");
    expect(executor).not.toHaveBeenCalled();
  });

  it("rejects an agent task when no executor is installed", async () => {
    await authorizeAndConfigure();
    setTaskAgentExecutor(null);
    expect((await sendTask({ draft: VALID_DRAFT, agent: "coder" })).state).toBe("safe_failure");
  });

  it("keeps the one-in-flight guard and the auth preconditions for agent tasks", async () => {
    expect((await sendTask({ draft: VALID_DRAFT, agent: "coder" })).state).toBe("unauthorized");
    await authorizeAndConfigure();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    setTaskAgentExecutor(async () => {
      await gate;
      return { ok: true as const, text: "done" };
    });
    const first = sendTask({ draft: VALID_DRAFT, agent: "coder" });
    expect((await sendTask({ draft: VALID_DRAFT, agent: "coder" })).state).toBe("sending");
    release();
    expect((await first).state).toBe("completed");
  });

  it("a stale executor result cannot restore completed after clearTaskSubmission()", async () => {
    await authorizeAndConfigure();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    setTaskAgentExecutor(async () => {
      await gate;
      return { ok: true as const, text: "late" };
    });
    const pending = sendTask({ draft: VALID_DRAFT, agent: "coder" });
    clearTaskSubmission();
    release();
    expect((await pending).state).not.toBe("completed");
  });
});

describe("sendTask - approved tools (tools: true)", () => {
  afterEach(() => {
    setToolRunner(null);
    setAgentAsk(null);
    setTaskAgentExecutor(null);
  });

  it("runs the tool loop with an ask function that posts the whole transcript directly to Hermes", async () => {
    await authorizeAndConfigure();
    let captured: ((messages: Array<{ role: "system" | "user" | "assistant"; content: string }>) => Promise<string | null>) | null = null;
    setToolRunner(async (task, ask) => {
      captured = ask as never;
      const first = await ask([{ role: "system", content: "KURAL" }, { role: "user", content: task }]);
      return { ok: true as const, text: "runner:" + String(first) };
    });
    fetchMock.mockResolvedValueOnce(okResponse("model yanıtı"));
    const result = await sendTask({ draft: VALID_DRAFT, tools: true });
    expect(result).toEqual({ state: "completed", text: "runner:model yanıtı", truncated: false });
    expect(captured).not.toBeNull();
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:19130/v1/chat/completions");
    expect(JSON.parse(options.body as string)).toEqual({
      messages: [
        { role: "system", content: "KURAL" },
        { role: "user", content: VALID_DRAFT },
      ],
      stream: false,
      // A tool step asks for short thinking (Kimi K3 at "medium" spent its whole output budget thinking and answered empty).
      model_options: { reasoning_effort: "low" },
    });
    expect((options.headers as Record<string, string>).Authorization).toBe("Bearer " + PLACEHOLDER_CREDENTIAL);
  });

  it("shows the steps a running tool task has finished (bounded lines) only while sending, and not afterwards", async () => {
    await authorizeAndConfigure();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    setToolRunner(async (_task, _ask, onProgress) => {
      onProgress?.("✓ okuma a.txt");
      onProgress?.("x".repeat(500));
      await gate;
      return { ok: true as const, text: "bitti" };
    });
    const pending = sendTask({ draft: VALID_DRAFT, tools: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const during = getTaskSubmissionState();
    expect(during.state).toBe("sending");
    expect(during.progress?.[0]).toBe("✓ okuma a.txt");
    expect(during.progress?.[1]?.length).toBeLessThanOrEqual(200);
    release();
    const done = await pending;
    expect(done).toEqual({ state: "completed", text: "bitti", truncated: false });
    expect(getTaskSubmissionState()).toEqual({ state: "completed", text: "bitti", truncated: false });
  });

  it("clearing a running tool task aborts the model request of the current step and ends the loop at once (the 'Durdur' button)", async () => {
    await authorizeAndConfigure();
    let aborted = false;
    fetchMock.mockImplementationOnce(
      (_url: string, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    );
    const seen: Array<string | null> = [];
    setToolRunner(async (task, ask) => {
      seen.push(await ask([{ role: "user", content: task }]));
      // A second step after the stop gets "no answer" without any new request.
      seen.push(await ask([{ role: "user", content: "devam" }]));
      return { ok: false as const };
    });
    const pending = sendTask({ draft: VALID_DRAFT, tools: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getTaskSubmissionState().state).toBe("sending");
    clearTaskSubmission();
    const result = await pending;
    expect(aborted).toBe(true);
    expect(seen).toEqual([null, null]);
    expect(result.state).toBe("idle");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a failed model step is reported to the loop as null, never as an exception", async () => {
    await authorizeAndConfigure();
    setToolRunner(async (_task, ask) => {
      const first = await ask([{ role: "user", content: "x" }]);
      return first === null ? { ok: false as const } : { ok: true as const, text: "?" };
    });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    expect((await sendTask({ draft: VALID_DRAFT, tools: true })).state).toBe("safe_failure");
    fetchMock.mockRejectedValueOnce(new Error("boom"));
    expect((await sendTask({ draft: VALID_DRAFT, tools: true })).state).toBe("safe_failure");
  });

  it("with a Manager, the transcript goes through the raw agent turn (flattened) instead of Hermes directly", async () => {
    await authorizeAndConfigure();
    const agentAskMock = vi.fn(async () => "agent yanıtı");
    setAgentAsk(agentAskMock);
    setTaskAgentExecutor(async () => ({ ok: true as const, text: "unused" }));
    setToolRunner(async (task, ask) => ({ ok: true as const, text: String(await ask([{ role: "system", content: "K" }, { role: "user", content: task }])) }));
    const result = await sendTask({ draft: VALID_DRAFT, agent: "coder", project: "aetheris", tools: true });
    expect(result.text).toBe("agent yanıtı");
    expect(agentAskMock).toHaveBeenCalledTimes(1);
    const [role, prompt] = agentAskMock.mock.calls[0] as unknown as [string, string];
    expect(role).toBe("coder");
    expect(prompt).toContain("[Kurallar]\nK");
    expect(prompt).toContain(VALID_DRAFT);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows a longer answer for tool runs (the log footer must not be cut off) and still truncates beyond it", async () => {
    await authorizeAndConfigure();
    setToolRunner(async () => ({ ok: true as const, text: "z".repeat(150000) }));
    expect((await sendTask({ draft: VALID_DRAFT, tools: true })).truncated).toBe(false);
    setToolRunner(async () => ({ ok: true as const, text: "z".repeat(250000) }));
    const long = await sendTask({ draft: VALID_DRAFT, tools: true });
    expect(long.truncated).toBe(true);
    expect(long.text).toHaveLength(200000);
  });

  it.each([
    ["tools: false", { draft: VALID_DRAFT, tools: false }],
    ["tools: 1", { draft: VALID_DRAFT, tools: 1 }],
    ['tools: "true"', { draft: VALID_DRAFT, tools: "true" }],
    ["an extra field", { draft: VALID_DRAFT, tools: true, cwd: "C:\\" }],
  ])("rejects %s without running anything", async (_label, request) => {
    await authorizeAndConfigure();
    const runner = vi.fn(async () => ({ ok: true as const, text: "no" }));
    setToolRunner(runner);
    expect((await sendTask(request)).state).toBe("safe_failure");
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects a tool task when no runner is installed, or a Manager tool task without a raw agent turn", async () => {
    await authorizeAndConfigure();
    expect((await sendTask({ draft: VALID_DRAFT, tools: true })).state).toBe("safe_failure");
    setToolRunner(async () => ({ ok: true as const, text: "x" }));
    setTaskAgentExecutor(async () => ({ ok: true as const, text: "x" }));
    setAgentAsk(null);
    expect((await sendTask({ draft: VALID_DRAFT, agent: "coder", tools: true })).state).toBe("safe_failure");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the auth preconditions and the one-in-flight guard for tool tasks", async () => {
    setToolRunner(async () => ({ ok: true as const, text: "x" }));
    expect((await sendTask({ draft: VALID_DRAFT, tools: true })).state).toBe("unauthorized");
    await authorizeAndConfigure();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    setToolRunner(async () => {
      await gate;
      return { ok: true as const, text: "bitti" };
    });
    const first = sendTask({ draft: VALID_DRAFT, tools: true });
    expect((await sendTask({ draft: VALID_DRAFT, tools: true })).state).toBe("sending");
    release();
    expect((await first).state).toBe("completed");
  });

  it("a stale tool run cannot restore completed after clearTaskSubmission()", async () => {
    await authorizeAndConfigure();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    setToolRunner(async () => {
      await gate;
      return { ok: true as const, text: "geç" };
    });
    const pending = sendTask({ draft: VALID_DRAFT, tools: true });
    clearTaskSubmission();
    release();
    expect((await pending).state).not.toBe("completed");
  });
});

describe("sendTask - per-role model choice", () => {
  afterEach(() => {
    setTaskAgentExecutor(null);
    setAgentAsk(null);
  });

  const MODELS = { assistant: "vyron-assistant", code: "vyron-code", research: "vyron-research" };

  it("sends the assistant combo as `model` on a direct task, and no model when none was chosen", async () => {
    await authorizeAndConfigure();
    fetchMock.mockResolvedValueOnce(okResponse("tamam"));
    await sendTask({ draft: VALID_DRAFT, models: MODELS });
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body).model).toBe("vyron-assistant");
    fetchMock.mockResolvedValueOnce(okResponse("tamam"));
    await sendTask({ draft: VALID_DRAFT });
    expect("model" in JSON.parse((fetchMock.mock.calls[1]![1] as { body: string }).body)).toBe(false);
  });

  it("rejects free-form or malformed model choices without calling anything", async () => {
    await authorizeAndConfigure();
    for (const models of [{ assistant: "gpt-4o" }, { extra: "vyron-code" }, "vyron-code", ["vyron-code"], null, { code: 5 }]) {
      expect(await sendTask({ draft: VALID_DRAFT, models })).toEqual({ state: "safe_failure", text: null, truncated: false });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes the whole choice on to the Manager executor (Ruflo picks the combo per role)", async () => {
    await authorizeAndConfigure();
    const executor = vi.fn(async () => ({ ok: true as const, text: "x" }));
    setTaskAgentExecutor(executor);
    await sendTask({ draft: VALID_DRAFT, agent: "coder", models: MODELS });
    expect(executor).toHaveBeenCalledWith("coder", VALID_DRAFT, undefined, MODELS);
  });
});

describe("tasks with tools use the tools model for every role", () => {
  const CHOICE = { assistant: "vyron-assistant", code: "vyron-code", research: "vyron-research", tools: "vyron-code" };

  it("withToolsRouting: without tools nothing changes; with tools every role gets the tools model", () => {
    expect(withToolsRouting(null, true)).toBeUndefined();
    expect(withToolsRouting(CHOICE as never, false)).toEqual(CHOICE);
    const routed = withToolsRouting(CHOICE as never, true)!;
    for (const role of ["task-orchestrator", "planner", "researcher", "coder", "reviewer", null]) expect(modelForRole(routed, role)).toBe("vyron-code");
    // No tools slot chosen: the per-role choice stays.
    const noTools = { assistant: "vyron-assistant", code: "vyron-code" } as never;
    expect(withToolsRouting(noTools, true)).toEqual(noTools);
  });

  it("parseModelChoice accepts the tools slot and still refuses anything else", () => {
    expect(parseModelChoice({ tools: "vyron-code" })).toEqual({ tools: "vyron-code" });
    expect(parseModelChoice({ tools: "gpt-4o" })).toBeNull();
    expect(parseModelChoice({ tool: "vyron-code" })).toBeNull();
  });

  it("a direct task with tools is asked with the tools model, a plain one with the assistant model", async () => {
    await authorizeAndConfigure();
    setToolRunner(async (_task, ask) => {
      await ask([{ role: "user", content: "x" }]);
      return { ok: true as const, text: "bitti" };
    });
    fetchMock.mockResolvedValueOnce(okResponse("yanıt"));
    await sendTask({ draft: VALID_DRAFT, tools: true, models: CHOICE });
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body).model).toBe("vyron-code");
    fetchMock.mockResolvedValueOnce(okResponse("yanıt"));
    await sendTask({ draft: VALID_DRAFT, models: CHOICE });
    expect(JSON.parse((fetchMock.mock.calls[1]![1] as { body: string }).body).model).toBe("vyron-assistant");
    setToolRunner(null);
  });

  it("a Manager task with tools passes the tools model for its role (Multi-Model Planner would otherwise use the assistant model)", async () => {
    await authorizeAndConfigure();
    const asked = vi.fn(async () => "yanıt");
    setAgentAsk(asked);
    setTaskAgentExecutor(async () => ({ ok: false as const }));
    setToolRunner(async (_task, ask) => {
      await ask([{ role: "user", content: "x" }]);
      return { ok: true as const, text: "bitti" };
    });
    await sendTask({ draft: VALID_DRAFT, agent: "task-orchestrator", tools: true, models: CHOICE });
    expect(asked).toHaveBeenCalledTimes(1);
    const passed = (asked.mock.calls[0] as unknown as [string, string, Record<string, string>])[2];
    expect(passed).toEqual({ assistant: "vyron-code", code: "vyron-code", research: "vyron-code", tools: "vyron-code" });
    setAgentAsk(null);
    setTaskAgentExecutor(null);
    setToolRunner(null);
  });
});

describe("request time limit", () => {
  it("lets a slow model step finish: the limit is at least 5 minutes (Kimi K3 measured 65 s per tool step and ~4.5 min per Konsey round)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(path.join(__dirname, "..", "electron", "hermesTaskSubmission.ts"), "utf8");
    const found = source.match(/const SEND_TIMEOUT_MS = ([\d_]+);/);
    expect(found).not.toBeNull();
    expect(Number((found![1] ?? "0").replace(/_/g, ""))).toBeGreaterThanOrEqual(300_000);
  });
});
