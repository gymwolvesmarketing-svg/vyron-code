import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { getTaskSubmissionState, reviewTaskDraft, sendReviewedTask, clearTaskSubmission } from "../electron/hermesTaskSubmission";
import { beginAuthorization, clearAuthorization } from "../electron/hermesAuthorization";
import { configureEndpoint, clearEndpointConfiguration } from "../electron/hermesEndpointSetup";

// Every value below is an explicit, obviously-fake sample — never a real Hermes API key, never
// real task/response content, and never read from .env.local/process.env. `global.fetch` is
// fully mocked below; nothing in this file ever reaches a real socket, DNS resolver, or TCP/
// HTTP server of any kind. VYRON_CODE_COMPLETE_LOCAL_HERMES_D11_DELIVERY_AUTHORIZATION
// explicitly requires a controlled fake transport for automated tests — real local runtime
// acceptance is recorded separately, in VYRON_CODE_D11_COMPLETE_DELIVERY_REPORT.md.
const PLACEHOLDER_CREDENTIAL = "placeholder-test-api-server-key-not-real";
const FAKE_LOOPBACK_ENDPOINT = "http://127.0.0.1:19130";
const VALID_DRAFT = "placeholder test task draft — reply with a short acknowledgement";

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

describe("getTaskSubmissionState — safe ambient state, gated on authorization and endpoint configuration", () => {
  it("reports unauthorized before any authorization exists", () => {
    expect(getTaskSubmissionState()).toEqual({ state: "unauthorized", draftLength: null, text: null, truncated: false });
  });

  it("reports unavailable once authorized but before any endpoint is configured", async () => {
    await beginAuthorization({ credential: PLACEHOLDER_CREDENTIAL });
    expect(getTaskSubmissionState()).toEqual({ state: "unavailable", draftLength: null, text: null, truncated: false });
  });

  it("reports idle once both authorized and a valid endpoint is configured, with nothing reviewed yet", async () => {
    await authorizeAndConfigure();
    expect(getTaskSubmissionState()).toEqual({ state: "idle", draftLength: null, text: null, truncated: false });
  });

  it("never includes an endpoint, API key, or any field beyond the four safe ones", async () => {
    await authorizeAndConfigure();
    const result = getTaskSubmissionState();
    expect(Object.keys(result).sort()).toEqual(["draftLength", "state", "text", "truncated"].sort());
  });
});

describe("reviewTaskDraft — validation and precondition gating", () => {
  it("fails safely with unauthorized when authorization has not been granted", async () => {
    expect(await reviewTaskDraft({ draft: VALID_DRAFT })).toEqual({ state: "unauthorized", draftLength: null, text: null, truncated: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails safely with unavailable when authorized but no endpoint is configured", async () => {
    await beginAuthorization({ credential: PLACEHOLDER_CREDENTIAL });
    expect(await reviewTaskDraft({ draft: VALID_DRAFT })).toEqual({ state: "unavailable", draftLength: null, text: null, truncated: false });
  });

  it("accepts a valid non-empty draft and reports review_ready with the correct draft length", async () => {
    await authorizeAndConfigure();
    const result = await reviewTaskDraft({ draft: VALID_DRAFT });
    expect(result.state).toBe("review_ready");
    expect(result.draftLength).toBe(VALID_DRAFT.length);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an empty draft — stays idle, no snapshot created", async () => {
    await authorizeAndConfigure();
    const result = await reviewTaskDraft({ draft: "" });
    expect(result.state).toBe("idle");
  });

  it("rejects a whitespace-only draft", async () => {
    await authorizeAndConfigure();
    const result = await reviewTaskDraft({ draft: "   \n\t  " });
    expect(result.state).toBe("idle");
  });

  it("rejects a draft exceeding the maximum length", async () => {
    await authorizeAndConfigure();
    const result = await reviewTaskDraft({ draft: "a".repeat(4_001) });
    expect(result.state).toBe("idle");
  });

  it("accepts a draft at exactly the maximum length", async () => {
    await authorizeAndConfigure();
    const result = await reviewTaskDraft({ draft: "a".repeat(4_000) });
    expect(result.state).toBe("review_ready");
  });

  it("rejects a draft containing a NUL or other C0 control character", async () => {
    await authorizeAndConfigure();
    const result = await reviewTaskDraft({ draft: `task text\u0000with NUL` });
    expect(result.state).toBe("idle");
  });

  it("accepts a draft containing newlines and tabs (legitimate multi-line text)", async () => {
    await authorizeAndConfigure();
    const result = await reviewTaskDraft({ draft: "line one\nline two\tindented" });
    expect(result.state).toBe("review_ready");
  });

  it("rejects a malformed request shape (extra field, wrong type, missing field)", async () => {
    await authorizeAndConfigure();
    expect((await reviewTaskDraft({ draft: VALID_DRAFT, extra: "x" })).state).toBe("idle");
    expect((await reviewTaskDraft({ draft: 123 })).state).toBe("idle");
    expect((await reviewTaskDraft({})).state).toBe("idle");
    expect((await reviewTaskDraft("not-an-object")).state).toBe("idle");
    expect((await reviewTaskDraft(null)).state).toBe("idle");
  });

  it("re-validates preconditions immediately before committing a snapshot, never trusting a prior read", async () => {
    await authorizeAndConfigure();
    clearAuthorization();
    expect((await reviewTaskDraft({ draft: VALID_DRAFT })).state).toBe("unauthorized");
  });

  it("a fresh review supersedes and discards any previously reviewed snapshot", async () => {
    await authorizeAndConfigure();
    await reviewTaskDraft({ draft: "first draft" });
    const second = await reviewTaskDraft({ draft: "second draft, different length!!" });
    expect(second.state).toBe("review_ready");
    expect(second.draftLength).toBe("second draft, different length!!".length);
  });
});

describe("sendReviewedTask — request contract (fixed POST /v1/chat/completions only)", () => {
  it("sends exactly one POST to <origin>/v1/chat/completions with the exact minimal contract", async () => {
    await authorizeAndConfigure();
    await reviewTaskDraft({ draft: VALID_DRAFT });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => chatCompletionBody("ack") });
    const result = await sendReviewedTask();
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
    clearEndpointConfiguration();
    await beginAuthorization({ credential: PLACEHOLDER_CREDENTIAL });
    await configureEndpoint({ endpoint: "http://127.0.0.1:19130/v1" });
    await reviewTaskDraft({ draft: VALID_DRAFT });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => chatCompletionBody("ack") });
    await sendReviewedTask();
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("http://127.0.0.1:19130/v1/chat/completions");
  });

  it("fails safely with idle/unauthorized/unavailable — never sends — when no draft has been reviewed", async () => {
    await authorizeAndConfigure();
    expect(await sendReviewedTask()).toEqual({ state: "idle", draftLength: null, text: null, truncated: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("extracts choices[0].message.content as the safe response text", async () => {
    await authorizeAndConfigure();
    await reviewTaskDraft({ draft: VALID_DRAFT });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => chatCompletionBody("VYRON_D11_TEXT_ONLY_OK") });
    const result = await sendReviewedTask();
    expect(result).toEqual({ state: "completed", draftLength: null, text: "VYRON_D11_TEXT_ONLY_OK", truncated: false });
  });

  it("truncates a response exceeding the bounded maximum and flags truncated: true", async () => {
    await authorizeAndConfigure();
    await reviewTaskDraft({ draft: VALID_DRAFT });
    const longText = "x".repeat(5_000);
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => chatCompletionBody(longText) });
    const result = await sendReviewedTask();
    expect(result.state).toBe("completed");
    expect(result.truncated).toBe(true);
    expect(result.text).toHaveLength(4_000);
    expect(result.text).toBe(longText.slice(0, 4_000));
  });

  it("maps a non-ok HTTP response to safe_failure, never exposing the raw status", async () => {
    await authorizeAndConfigure();
    await reviewTaskDraft({ draft: VALID_DRAFT });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    expect(await sendReviewedTask()).toEqual({ state: "safe_failure", draftLength: null, text: null, truncated: false });
  });

  it("maps a rejected fetch (connection refused) to safe_failure", async () => {
    await authorizeAndConfigure();
    await reviewTaskDraft({ draft: VALID_DRAFT });
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect((await sendReviewedTask()).state).toBe("safe_failure");
  });

  it("maps an abort (timeout) to safe_failure", async () => {
    await authorizeAndConfigure();
    await reviewTaskDraft({ draft: VALID_DRAFT });
    fetchMock.mockRejectedValueOnce(new DOMException("The operation was aborted.", "AbortError"));
    expect((await sendReviewedTask()).state).toBe("safe_failure");
  });

  it("maps a tool-call-shaped or non-text response to safe_failure — never renders/executes structured content", async () => {
    await authorizeAndConfigure();
    await reviewTaskDraft({ draft: VALID_DRAFT });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "1", function: { name: "terminal", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
      }),
    });
    expect((await sendReviewedTask()).state).toBe("safe_failure");
  });

  it("maps a missing/malformed choices array to safe_failure", async () => {
    await authorizeAndConfigure();
    await reviewTaskDraft({ draft: VALID_DRAFT });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
    expect((await sendReviewedTask()).state).toBe("safe_failure");
  });
});

describe("sendReviewedTask — lifecycle and bounds", () => {
  it("bounds to one send in flight — a duplicate call while one is pending is reduced to sending, not a second request", async () => {
    await authorizeAndConfigure();
    await reviewTaskDraft({ draft: VALID_DRAFT });
    let resolveFirst: (value: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const first = sendReviewedTask();
    const second = await sendReviewedTask();
    expect(second.state).toBe("sending");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFirst({ ok: true, status: 200, json: async () => chatCompletionBody("ack") });
    expect((await first).state).toBe("completed");
  });
});

describe("clearTaskSubmission", () => {
  it("is idempotent — safe to call with no prior review or send", () => {
    expect(() => clearTaskSubmission()).not.toThrow();
    expect(clearTaskSubmission()).toEqual({ state: "unauthorized", draftLength: null, text: null, truncated: false });
  });

  it("resets a review_ready state back to idle (while still authorized/configured)", async () => {
    await authorizeAndConfigure();
    await reviewTaskDraft({ draft: VALID_DRAFT });
    expect(getTaskSubmissionState().state).toBe("review_ready");
    clearTaskSubmission();
    expect(getTaskSubmissionState()).toEqual({ state: "idle", draftLength: null, text: null, truncated: false });
  });

  it("resets a completed state back to idle, discarding the completed response text", async () => {
    await authorizeAndConfigure();
    await reviewTaskDraft({ draft: VALID_DRAFT });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => chatCompletionBody("ack") });
    await sendReviewedTask();
    expect(getTaskSubmissionState().state).toBe("completed");
    clearTaskSubmission();
    expect(getTaskSubmissionState()).toEqual({ state: "idle", draftLength: null, text: null, truncated: false });
  });

  it("sends no network request of its own", async () => {
    await authorizeAndConfigure();
    await reviewTaskDraft({ draft: VALID_DRAFT });
    clearTaskSubmission();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("cross-module cleanup — task submission state clears on every revoke path (T-17-style)", () => {
  it("clearing authorization makes a review_ready/completed state unreachable via getTaskSubmissionState (self-heal)", async () => {
    await authorizeAndConfigure();
    await reviewTaskDraft({ draft: VALID_DRAFT });
    clearAuthorization();
    expect(getTaskSubmissionState()).toEqual({ state: "unauthorized", draftLength: null, text: null, truncated: false });
  });

  it("clearing the endpoint configuration makes a review_ready state unreachable via getTaskSubmissionState (self-heal)", async () => {
    await authorizeAndConfigure();
    await reviewTaskDraft({ draft: VALID_DRAFT });
    clearEndpointConfiguration();
    expect(getTaskSubmissionState()).toEqual({ state: "unavailable", draftLength: null, text: null, truncated: false });
  });

  it("a stale sendReviewedTask() completion cannot restore completed after an intervening clearTaskSubmission()", async () => {
    await authorizeAndConfigure();
    await reviewTaskDraft({ draft: VALID_DRAFT });
    let resolveFetch: (value: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const pending = sendReviewedTask();
    clearTaskSubmission();
    resolveFetch({ ok: true, status: 200, json: async () => chatCompletionBody("ack") });
    const result = await pending;
    expect(result.state).not.toBe("completed");
    expect(getTaskSubmissionState().state).not.toBe("completed");
  });

  it("a stale sendReviewedTask() completion cannot restore completed after an intervening clearAuthorization()", async () => {
    await authorizeAndConfigure();
    await reviewTaskDraft({ draft: VALID_DRAFT });
    let resolveFetch: (value: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const pending = sendReviewedTask();
    clearAuthorization();
    resolveFetch({ ok: true, status: 200, json: async () => chatCompletionBody("ack") });
    const result = await pending;
    expect(result.state).not.toBe("completed");
  });
});

describe("security regressions", () => {
  it("getTaskSubmissionState/sendReviewedTask/clearTaskSubmission take no parameters; reviewTaskDraft takes exactly one", () => {
    expect(getTaskSubmissionState.length).toBe(0);
    expect(sendReviewedTask.length).toBe(0);
    expect(clearTaskSubmission.length).toBe(0);
    expect(reviewTaskDraft.length).toBe(1);
  });

  it("no result object from any exported function ever carries a field beyond the four safe ones", async () => {
    await authorizeAndConfigure();
    const reviewed = await reviewTaskDraft({ draft: VALID_DRAFT });
    expect(Object.keys(reviewed).sort()).toEqual(["draftLength", "state", "text", "truncated"].sort());
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => chatCompletionBody("ack") });
    const sent = await sendReviewedTask();
    expect(Object.keys(sent).sort()).toEqual(["draftLength", "state", "text", "truncated"].sort());
    const cleared = clearTaskSubmission();
    expect(Object.keys(cleared).sort()).toEqual(["draftLength", "state", "text", "truncated"].sort());
  });

  it("never sends the credential in the URL, body, or anywhere but the Authorization header", async () => {
    await authorizeAndConfigure();
    await reviewTaskDraft({ draft: VALID_DRAFT });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => chatCompletionBody("ack") });
    await sendReviewedTask();
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain(PLACEHOLDER_CREDENTIAL);
    expect(options.body as string).not.toContain(PLACEHOLDER_CREDENTIAL);
    const headers = options.headers as Record<string, string>;
    expect(headers["Authorization"]).toContain(PLACEHOLDER_CREDENTIAL);
  });

  it("never sends a query string, cookie, or redirect-follow option", async () => {
    await authorizeAndConfigure();
    await reviewTaskDraft({ draft: VALID_DRAFT });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => chatCompletionBody("ack") });
    await sendReviewedTask();
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain("?");
    expect(options).not.toHaveProperty("credentials");
    expect(options.redirect).toBe("error");
  });

  it("never echoes the draft text back in any result beyond draftLength (a number, never the text itself pre-send)", async () => {
    await authorizeAndConfigure();
    const result = await reviewTaskDraft({ draft: VALID_DRAFT });
    expect(result.text).toBeNull();
    expect(JSON.stringify(result)).not.toContain(VALID_DRAFT);
  });
});
