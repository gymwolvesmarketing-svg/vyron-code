import { describe, it, expect, beforeEach } from "vitest";
import { getConnectionState, connect, disconnect } from "../electron/hermesConnection";
import { beginAuthorization, clearAuthorization } from "../electron/hermesAuthorization";
import { configureEndpoint, clearEndpointConfiguration } from "../electron/hermesEndpointSetup";

// A controlled, obviously-fake placeholder — never a real Hermes token. This file never
// opens a real network connection, real WebSocket, or real TCP probe; every "connection" here
// is electron/hermesConnection.ts's own disclosed, always-safe "unavailable" outcome (see its
// module header for the trusted-endpoint-policy blocker this reflects).
const PLACEHOLDER_CREDENTIAL = "placeholder-test-credential-value-not-real";

// A controlled, obviously-fake sample endpoint — never a real Hermes deployment target, never
// read from .env.local/process.env. VYRON_CODE_V02_D08E_MEMORY_ONLY_HERMES_ENDPOINT_SETUP_AUTHORIZATION
// explicitly forbids any real network/DNS/TCP/WebSocket activity; none occurs here.
const FAKE_LOOPBACK_ENDPOINT = "ws://127.0.0.1:19130/api/ws";

async function authorize(): Promise<void> {
  const result = await beginAuthorization({ credential: PLACEHOLDER_CREDENTIAL });
  expect(result.state).toBe("authorized_memory_only");
}

beforeEach(() => {
  clearAuthorization();
  clearEndpointConfiguration();
});

describe("getConnectionState — safe ambient state, gated on D-08B authorization", () => {
  it("reports not_authorized before any authorization exists", () => {
    expect(getConnectionState()).toEqual({ state: "not_authorized" });
  });

  it("reports ready_to_connect immediately once authorization becomes valid", async () => {
    await authorize();
    expect(getConnectionState()).toEqual({ state: "ready_to_connect" });
  });

  it("reports not_authorized again immediately after authorization is cleared, regardless of prior connection attempts", async () => {
    await authorize();
    await connect();
    expect(getConnectionState().state).toBe("unavailable");
    clearAuthorization();
    expect(getConnectionState()).toEqual({ state: "not_authorized" });
  });

  it("never includes an endpoint, socket, or any field beyond state", async () => {
    await authorize();
    const result = getConnectionState();
    expect(Object.keys(result)).toEqual(["state"]);
  });
});

describe("connect — the single explicit, user-initiated attempt (trusted-endpoint-policy blocker)", () => {
  it("fails safely with not_authorized when authorization has not been granted", async () => {
    const result = await connect();
    expect(result).toEqual({ state: "not_authorized" });
  });

  it("resolves to the safe unavailable state once authorized — no trusted endpoint config exists in this build", async () => {
    await authorize();
    const result = await connect();
    expect(result).toEqual({ state: "unavailable" });
    expect(getConnectionState()).toEqual({ state: "unavailable" });
  });

  it("never returns an endpoint, host, port, socket, or any field beyond state", async () => {
    await authorize();
    const result = await connect();
    expect(Object.keys(result)).toEqual(["state"]);
  });

  it("a second, overlapping connect() call while one is already in flight is rejected safely, not raced", async () => {
    await authorize();
    const first = connect();
    const second = await connect();
    expect(second).toEqual({ state: "safe_failure" });
    const firstResult = await first;
    expect(firstResult).toEqual({ state: "unavailable" });
  });

  it("a later connect() call after a prior one completed is a fresh, independent attempt", async () => {
    await authorize();
    await connect();
    const again = await connect();
    expect(again).toEqual({ state: "unavailable" });
  });
});

describe("disconnect — explicit, immediate, idempotent", () => {
  it("is safe to call even when never connected", () => {
    expect(() => disconnect()).not.toThrow();
  });

  it("resets ambient state to ready_to_connect after a connect attempt, while authorized", async () => {
    await authorize();
    await connect();
    expect(getConnectionState().state).toBe("unavailable");
    const result = disconnect();
    expect(result).toEqual({ state: "disconnected" });
    expect(getConnectionState()).toEqual({ state: "ready_to_connect" });
  });

  it("reports not_authorized if called while not authorized", () => {
    const result = disconnect();
    expect(result).toEqual({ state: "not_authorized" });
  });

  it("is idempotent — calling it twice in a row is safe and non-throwing", async () => {
    await authorize();
    await connect();
    expect(() => disconnect()).not.toThrow();
    expect(() => disconnect()).not.toThrow();
    expect(getConnectionState()).toEqual({ state: "ready_to_connect" });
  });

  it("never returns an endpoint, socket, or any field beyond state", async () => {
    await authorize();
    const result = disconnect();
    expect(Object.keys(result)).toEqual(["state"]);
  });
});

describe("T-17-style — stale in-flight connect cannot restore a connected/unavailable state after disconnect", () => {
  it("a connect() call already in flight when disconnect() runs resolves as disconnected, not unavailable", async () => {
    await authorize();
    // Deliberately does not await connect() before calling disconnect() — exercises the
    // exact race window connect()'s own explicit yield point creates.
    const inFlight = connect();
    disconnect();
    const result = await inFlight;
    expect(result).toEqual({ state: "disconnected" });
    expect(getConnectionState()).toEqual({ state: "ready_to_connect" });
  });

  it("a connect() call that completes with no intervening disconnect still resolves normally", async () => {
    await authorize();
    const inFlight = connect();
    const result = await inFlight;
    expect(result).toEqual({ state: "unavailable" });
  });
});

describe("Fresh module lifecycle begins not_authorized (app-restart equivalence)", () => {
  it("a freshly cleared authorization state means connection state is also not_authorized", () => {
    clearAuthorization();
    expect(getConnectionState()).toEqual({ state: "not_authorized" });
  });
});

describe("D-08E integration — connect() still cannot reach connected even with a configured endpoint", () => {
  it("connect() still resolves to unavailable when authorized AND a fake endpoint is configured — no real socket is ever opened", async () => {
    await authorize();
    const configureResult = await configureEndpoint({ endpoint: FAKE_LOOPBACK_ENDPOINT });
    expect(configureResult).toEqual({ state: "configured_memory_only" });

    const result = await connect();
    expect(result).toEqual({ state: "unavailable" });
    expect(getConnectionState()).toEqual({ state: "unavailable" });
  });

  it("connect() never returns an endpoint/host/port/socket field even with a configured endpoint", async () => {
    await authorize();
    await configureEndpoint({ endpoint: FAKE_LOOPBACK_ENDPOINT });
    const result = await connect();
    expect(Object.keys(result)).toEqual(["state"]);
  });

  it("clearing the endpoint configuration after connect() still leaves connection state safe (unavailable/ready_to_connect)", async () => {
    await authorize();
    await configureEndpoint({ endpoint: FAKE_LOOPBACK_ENDPOINT });
    await connect();
    expect(getConnectionState().state).toBe("unavailable");
    clearEndpointConfiguration();
    // getConnectionState() re-derives from the authorization module only; hermesConnection's
    // own ambientState is a separate concern reset via disconnect() — confirms no stale
    // "connected"-looking state leaks through clearing the endpoint alone.
    expect(["unavailable", "ready_to_connect"]).toContain(getConnectionState().state);
  });

  it("without any configured endpoint, connect() behaves exactly as before D-08E (unchanged fallback)", async () => {
    await authorize();
    const result = await connect();
    expect(result).toEqual({ state: "unavailable" });
  });
});
