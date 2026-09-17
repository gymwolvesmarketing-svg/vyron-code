import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { getApiServerVerificationState, verifyApiServerConnection, clearApiServerVerification } from "../electron/hermesApiServer";
import { beginAuthorization, clearAuthorization } from "../electron/hermesAuthorization";
import { configureEndpoint, clearEndpointConfiguration } from "../electron/hermesEndpointSetup";

// Every value below is an explicit, obviously-fake sample — never a real Hermes API key, never
// a real endpoint, never read from .env.local/process.env, and never used to open a real
// network connection. `global.fetch` is fully mocked below; nothing in this file ever reaches a
// real socket, DNS resolver, or TCP/HTTP server of any kind.
// VYRON_CODE_V02_D10_API_SERVER_REMEDIATION_AUTHORIZATION explicitly forbids a real HTTP
// request in automated tests — this file uses only a controlled fake `fetch` transport.
const PLACEHOLDER_CREDENTIAL = "placeholder-test-api-server-key-not-real";
const FAKE_LOOPBACK_ENDPOINT = "http://127.0.0.1:19130";

const fetchMock = vi.fn();

async function authorizeAndConfigure(): Promise<void> {
  await beginAuthorization({ credential: PLACEHOLDER_CREDENTIAL });
  await configureEndpoint({ endpoint: FAKE_LOOPBACK_ENDPOINT });
}

beforeEach(() => {
  clearAuthorization();
  clearEndpointConfiguration();
  clearApiServerVerification();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getApiServerVerificationState — safe ambient state, gated on authorization and endpoint configuration", () => {
  it("reports not_authorized before any authorization exists", () => {
    expect(getApiServerVerificationState()).toEqual({ state: "not_authorized" });
  });

  it("reports endpoint_not_configured once authorized but before any endpoint is configured", async () => {
    await beginAuthorization({ credential: PLACEHOLDER_CREDENTIAL });
    expect(getApiServerVerificationState()).toEqual({ state: "endpoint_not_configured" });
  });

  it("reports ready_to_verify once both authorized and a valid endpoint is configured", async () => {
    await authorizeAndConfigure();
    expect(getApiServerVerificationState()).toEqual({ state: "ready_to_verify" });
  });

  it("never includes an endpoint, API key, or any field beyond state", async () => {
    await authorizeAndConfigure();
    const result = getApiServerVerificationState();
    expect(Object.keys(result)).toEqual(["state"]);
  });
});

describe("verifyApiServerConnection — preconditions", () => {
  it("fails safely with not_authorized when authorization has not been granted", async () => {
    expect(await verifyApiServerConnection()).toEqual({ state: "not_authorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails safely with endpoint_not_configured when authorized but no endpoint is configured", async () => {
    await beginAuthorization({ credential: PLACEHOLDER_CREDENTIAL });
    expect(await verifyApiServerConnection()).toEqual({ state: "endpoint_not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-validates preconditions immediately before transport use, never trusting a prior read", async () => {
    await authorizeAndConfigure();
    clearAuthorization();
    expect(await verifyApiServerConnection()).toEqual({ state: "not_authorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("verifyApiServerConnection — request contract (fixed GET /health only)", () => {
  it("sends exactly one GET request to <origin>/health — no body, no query string, no Authorization header", async () => {
    await authorizeAndConfigure();
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    const result = await verifyApiServerConnection();
    expect(result).toEqual({ state: "reachable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:19130/health");
    expect(options.method).toBe("GET");
    expect(options).not.toHaveProperty("body");
    expect(options.redirect).toBe("error");
    const headers = options.headers as Record<string, string> | undefined;
    if (headers) {
      expect(Object.keys(headers).some((h) => h.toLowerCase() === "authorization")).toBe(false);
    }
  });

  it("always probes /health at the endpoint's own origin, discarding any configured /v1 path", async () => {
    clearEndpointConfiguration();
    await beginAuthorization({ credential: PLACEHOLDER_CREDENTIAL });
    await configureEndpoint({ endpoint: "http://127.0.0.1:19130/v1" });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    await verifyApiServerConnection();
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("http://127.0.0.1:19130/health");
  });

  it("maps a non-ok HTTP response to safe_failure, never exposing the raw status", async () => {
    await authorizeAndConfigure();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    expect(await verifyApiServerConnection()).toEqual({ state: "safe_failure" });
  });

  it("maps a rejected fetch (connection refused) to unavailable", async () => {
    await authorizeAndConfigure();
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await verifyApiServerConnection()).toEqual({ state: "unavailable" });
  });

  it("maps an abort (timeout) to unavailable", async () => {
    await authorizeAndConfigure();
    fetchMock.mockRejectedValueOnce(new DOMException("The operation was aborted.", "AbortError"));
    expect(await verifyApiServerConnection()).toEqual({ state: "unavailable" });
  });
});

describe("verifyApiServerConnection — lifecycle and bounds", () => {
  it("bounds to one verification in flight — a duplicate call while one is pending is reduced to verifying, not a second request", async () => {
    await authorizeAndConfigure();
    let resolveFirst: (value: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        })
    );
    const first = verifyApiServerConnection();
    const second = await verifyApiServerConnection();
    expect(second).toEqual({ state: "verifying" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFirst({ ok: true, status: 200 });
    expect(await first).toEqual({ state: "reachable" });
  });

  it("reaches reachable only on a real ok response", async () => {
    await authorizeAndConfigure();
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    expect(await verifyApiServerConnection()).toEqual({ state: "reachable" });
    expect(getApiServerVerificationState()).toEqual({ state: "reachable" });
  });
});

describe("clearApiServerVerification", () => {
  it("is idempotent — safe to call with no prior verification", () => {
    expect(() => clearApiServerVerification()).not.toThrow();
    expect(clearApiServerVerification()).toEqual({ state: "not_authorized" });
  });

  it("resets a reachable state back to ready_to_verify (while still authorized/configured)", async () => {
    await authorizeAndConfigure();
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    await verifyApiServerConnection();
    expect(getApiServerVerificationState()).toEqual({ state: "reachable" });
    clearApiServerVerification();
    expect(getApiServerVerificationState()).toEqual({ state: "ready_to_verify" });
  });

  it("sends no network request of its own", async () => {
    await authorizeAndConfigure();
    clearApiServerVerification();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("cross-module cleanup — verification state clears on every revoke path (T-17-style)", () => {
  it("clearApiServerVerification() (called from main.ts on disconnect-equivalent paths) resets a reachable state", async () => {
    await authorizeAndConfigure();
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    await verifyApiServerConnection();
    expect(getApiServerVerificationState()).toEqual({ state: "reachable" });
    clearApiServerVerification();
    expect(getApiServerVerificationState()).toEqual({ state: "ready_to_verify" });
  });

  it("clearing authorization makes a reachable state unreachable via getApiServerVerificationState (self-heal)", async () => {
    await authorizeAndConfigure();
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    await verifyApiServerConnection();
    clearAuthorization();
    expect(getApiServerVerificationState()).toEqual({ state: "not_authorized" });
  });

  it("clearing the endpoint configuration makes a reachable state unreachable via getApiServerVerificationState (self-heal)", async () => {
    await authorizeAndConfigure();
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    await verifyApiServerConnection();
    clearEndpointConfiguration();
    expect(getApiServerVerificationState()).toEqual({ state: "endpoint_not_configured" });
  });

  it("a stale verifyApiServerConnection() completion cannot restore reachable after an intervening clearApiServerVerification()", async () => {
    await authorizeAndConfigure();
    let resolveFetch: (value: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })
    );
    const pending = verifyApiServerConnection();
    clearApiServerVerification();
    resolveFetch({ ok: true, status: 200 });
    const result = await pending;
    expect(result).not.toEqual({ state: "reachable" });
    expect(getApiServerVerificationState().state).not.toBe("reachable");
  });
});

describe("security regressions", () => {
  it("getApiServerVerificationState/verifyApiServerConnection/clearApiServerVerification take no parameters at all", () => {
    expect(getApiServerVerificationState.length).toBe(0);
    expect(verifyApiServerConnection.length).toBe(0);
    expect(clearApiServerVerification.length).toBe(0);
  });

  it("no result object from any exported function ever carries a field beyond state", async () => {
    await authorizeAndConfigure();
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    const verified = await verifyApiServerConnection();
    expect(Object.keys(verified)).toEqual(["state"]);
    const cleared = clearApiServerVerification();
    expect(Object.keys(cleared)).toEqual(["state"]);
  });

  it("never sends the credential to fetch() in any form — not as a header value, not in the URL", async () => {
    await authorizeAndConfigure();
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    await verifyApiServerConnection();
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain(PLACEHOLDER_CREDENTIAL);
    expect(JSON.stringify(options)).not.toContain(PLACEHOLDER_CREDENTIAL);
  });
});
