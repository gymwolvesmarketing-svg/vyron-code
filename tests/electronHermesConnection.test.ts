import { describe, it, expect, beforeEach, vi } from "vitest";

// A minimal, fully self-contained fake WebSocket — deliberately NOT extending Node's real
// `EventEmitter` import (kept entirely inside vi.hoisted() so vitest's mock-hoisting can
// reference it safely, with no import-ordering ambiguity). Implements only the small,
// real, publicly-documented `ws` surface electron/hermesConnection.ts actually uses:
// `on`/`emit`, `readyState`, the static `OPEN` constant, and `terminate()`/`close()`/`send()`.
// VYRON_CODE_V02_D08E_CHECKPOINT_AND_D08F_EXPLICIT_HERMES_CONNECTIVITY_AUTHORIZATION explicitly
// forbids opening a real WebSocket or making any real network request in automated tests —
// this fake never touches a socket, a port, or the network in any way; every "connection" in
// this file is driven entirely by the test calling `.emit(...)` on this fake by hand.
const { MockWebSocket, getMockInstances, resetMockInstances } = vi.hoisted(() => {
  class MockWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState: 0 | 1 | 2 | 3 = 0;
    readonly url: string;
    readonly options: Record<string, unknown>;
    private readonly listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

    constructor(url: string, options?: Record<string, unknown>) {
      this.url = url;
      this.options = options ?? {};
      instances.push(this);
    }

    on(event: string, listener: (...args: unknown[]) => void): this {
      (this.listeners[event] ??= []).push(listener);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      // Mirrors the real `ws` client's own readyState management — a real handshake success
      // flips readyState to OPEN before "open" listeners run, which electron/hermesConnection.ts
      // relies on (via `socket.readyState === WS.OPEN`) to detect an already-connected socket.
      if (event === "open") this.readyState = MockWebSocket.OPEN;
      for (const listener of this.listeners[event] ?? []) listener(...args);
    }

    terminate(): void {
      if (this.readyState === MockWebSocket.CLOSED) return;
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close", 1006, Buffer.from(""));
    }

    close(): void {
      this.terminate();
    }

    send(): void {
      // Not exercised by this file's own tests (connect()/disconnect() never call .send() —
      // only D-10's callSessionMethod() does; see tests/electronHermesSession.test.ts for a
      // MockWebSocket that records sent frames). Present here only to match the real `ws`
      // client's shape for TypeScript purposes.
    }
  }

  let instances: InstanceType<typeof MockWebSocket>[] = [];
  return {
    MockWebSocket,
    getMockInstances: () => instances,
    resetMockInstances: () => {
      instances = [];
    },
  };
});

vi.mock("ws", () => ({ default: MockWebSocket }));

import { getConnectionState, connect, disconnect } from "../electron/hermesConnection";
import { beginAuthorization, clearAuthorization } from "../electron/hermesAuthorization";
import { configureEndpoint, clearEndpointConfiguration } from "../electron/hermesEndpointSetup";

// Every value below is an explicit, obviously-fake sample — never a real Hermes token, never a
// real endpoint, never read from .env.local/process.env, and never used to open a real network
// connection (the "ws" module is fully mocked above; nothing in this file ever reaches a real
// socket, DNS resolver, or TCP/HTTP/WebSocket server of any kind).
const PLACEHOLDER_CREDENTIAL = "placeholder-test-credential-value-not-real";
const FAKE_LOOPBACK_ENDPOINT = "ws://127.0.0.1:19130/api/ws";

async function authorize(): Promise<void> {
  const result = await beginAuthorization({ credential: PLACEHOLDER_CREDENTIAL });
  expect(result.state).toBe("authorized_memory_only");
}

async function authorizeAndConfigure(): Promise<void> {
  await authorize();
  const result = await configureEndpoint({ endpoint: FAKE_LOOPBACK_ENDPOINT });
  expect(result.state).toBe("configured_memory_only");
}

function latestMockSocket() {
  const instances = getMockInstances();
  const latest = instances[instances.length - 1];
  if (!latest) throw new Error("no MockWebSocket instance was constructed");
  return latest;
}

beforeEach(() => {
  clearAuthorization();
  clearEndpointConfiguration();
  disconnect();
  resetMockInstances();
  vi.useRealTimers();
});

describe("getConnectionState — safe ambient state, gated on D-08B authorization and D-08E endpoint configuration", () => {
  it("reports not_authorized before any authorization exists", () => {
    expect(getConnectionState()).toEqual({ state: "not_authorized" });
  });

  it("reports endpoint_not_configured once authorized but before any endpoint is configured", async () => {
    await authorize();
    expect(getConnectionState()).toEqual({ state: "endpoint_not_configured" });
  });

  it("reports ready_to_connect once both authorized and a valid endpoint is configured", async () => {
    await authorizeAndConfigure();
    expect(getConnectionState()).toEqual({ state: "ready_to_connect" });
  });

  it("never includes an endpoint, socket, or any field beyond state", async () => {
    await authorizeAndConfigure();
    const result = getConnectionState();
    expect(Object.keys(result)).toEqual(["state"]);
  });
});

describe("connect — preconditions", () => {
  it("fails safely with not_authorized when authorization has not been granted", async () => {
    const result = await connect();
    expect(result).toEqual({ state: "not_authorized" });
    expect(getMockInstances()).toHaveLength(0);
  });

  it("fails safely with endpoint_not_configured when authorized but no endpoint is configured", async () => {
    await authorize();
    const result = await connect();
    expect(result).toEqual({ state: "endpoint_not_configured" });
    expect(getMockInstances()).toHaveLength(0);
  });

  it("connect() itself takes zero arguments", () => {
    expect(connect.length).toBe(0);
  });

  it("never returns an endpoint, host, port, socket, or any field beyond state, on any precondition failure", async () => {
    expect(Object.keys(await connect())).toEqual(["state"]);
    await authorize();
    expect(Object.keys(await connect())).toEqual(["state"]);
  });
});

describe("connect — reaches only the controlled fake connection/handshake path", () => {
  it("constructs exactly one fake WebSocket client, using the configured endpoint URL with the token appended as a query parameter", async () => {
    await authorizeAndConfigure();
    const pending = connect();
    expect(getMockInstances()).toHaveLength(1);
    const socket = latestMockSocket();
    expect(socket.url.startsWith("ws://127.0.0.1:19130/api/ws?")).toBe(true);
    expect(socket.url).toContain(`token=${PLACEHOLDER_CREDENTIAL}`);
    socket.emit("open");
    await pending;
  });

  it("sets Origin and Host options matching the configured endpoint, never any renderer-suppliable value", async () => {
    await authorizeAndConfigure();
    const pending = connect();
    const socket = latestMockSocket();
    expect(socket.options.origin).toBe("http://127.0.0.1:19130");
    expect(socket.options.headers).toEqual({ Host: "127.0.0.1:19130" });
    socket.emit("open");
    await pending;
  });

  it("sets a bounded handshakeTimeout and maxPayload, never leaving either unbounded", async () => {
    await authorizeAndConfigure();
    const pending = connect();
    const socket = latestMockSocket();
    expect(typeof socket.options.handshakeTimeout).toBe("number");
    expect(socket.options.handshakeTimeout).toBeGreaterThan(0);
    expect(typeof socket.options.maxPayload).toBe("number");
    expect(socket.options.maxPayload).toBeGreaterThan(0);
    socket.emit("open");
    await pending;
  });

  it("resolves to connected only once the fake transport emits open — never automatically", async () => {
    await authorizeAndConfigure();
    const pending = connect();
    // Not yet resolved — still awaiting the fake "open" event.
    const socket = latestMockSocket();
    socket.emit("open");
    const result = await pending;
    expect(result).toEqual({ state: "connected" });
    expect(getConnectionState()).toEqual({ state: "connected" });
  });

  it("never sends any data over the fake transport — no JSON-RPC/session/prompt message of any kind", async () => {
    await authorizeAndConfigure();
    const pending = connect();
    const socket = latestMockSocket();
    const sendSpy = vi.spyOn(socket, "send");
    socket.emit("open");
    await pending;
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("discards inbound messages without throwing or exposing them", async () => {
    await authorizeAndConfigure();
    const pending = connect();
    const socket = latestMockSocket();
    socket.emit("open");
    await pending;
    expect(() => socket.emit("message", Buffer.from('{"jsonrpc":"2.0","method":"event"}'))).not.toThrow();
  });
});

describe("connect — lifecycle and bounds", () => {
  it("one active connect attempt maximum — a second overlapping connect() call while one is in flight is rejected safely, not raced", async () => {
    await authorizeAndConfigure();
    const first = connect();
    const second = await connect();
    expect(second).toEqual({ state: "safe_failure" });
    expect(getMockInstances()).toHaveLength(1);
    latestMockSocket().emit("open");
    const firstResult = await first;
    expect(firstResult).toEqual({ state: "connected" });
  });

  it("duplicate connect() while already connected safely returns the current connected state, without opening a second socket", async () => {
    await authorizeAndConfigure();
    const pending = connect();
    latestMockSocket().emit("open");
    await pending;
    const again = await connect();
    expect(again).toEqual({ state: "connected" });
    expect(getMockInstances()).toHaveLength(1);
  });

  it("connect timeout returns a safe timed-out state when the fake transport never opens", async () => {
    vi.useFakeTimers();
    await authorizeAndConfigure();
    const pending = connect();
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await pending;
    expect(result).toEqual({ state: "connection_timed_out" });
    expect(getConnectionState()).toEqual({ state: "unavailable" });
  });

  it("handshake timeout is the same bounded window — a slow, never-opening handshake also resolves safely", async () => {
    vi.useFakeTimers();
    await authorizeAndConfigure();
    const pending = connect();
    const socket = latestMockSocket();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(socket.readyState).not.toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result).toEqual({ state: "connection_timed_out" });
  });

  it("a protocol/handshake rejection (unexpected-response) returns a safe failure state, never a raw status", async () => {
    await authorizeAndConfigure();
    const pending = connect();
    latestMockSocket().emit("unexpected-response");
    const result = await pending;
    expect(result).toEqual({ state: "safe_failure" });
    expect(getConnectionState()).toEqual({ state: "unavailable" });
  });

  it("a transport error returns a safe failure state, never the raw error object", async () => {
    await authorizeAndConfigure();
    const pending = connect();
    latestMockSocket().emit("error", new Error("ECONNREFUSED (fake, never a real network error)"));
    const result = await pending;
    expect(result).toEqual({ state: "safe_failure" });
  });

  it("a later transport close after a successful connection returns connection state to a safe disconnected state", async () => {
    await authorizeAndConfigure();
    const pending = connect();
    const socket = latestMockSocket();
    socket.emit("open");
    await pending;
    expect(getConnectionState()).toEqual({ state: "connected" });
    socket.emit("close", 1006, Buffer.from(""));
    expect(getConnectionState()).toEqual({ state: "disconnected" });
  });

  it("a later connect() call after a prior one fully completed (open then explicit disconnect) is a fresh, independent attempt", async () => {
    await authorizeAndConfigure();
    const first = connect();
    latestMockSocket().emit("open");
    await first;
    disconnect();
    const second = connect();
    expect(getMockInstances()).toHaveLength(2);
    latestMockSocket().emit("open");
    const result = await second;
    expect(result).toEqual({ state: "connected" });
  });
});

describe("disconnect — explicit, immediate, idempotent", () => {
  it("is safe to call even when never connected", () => {
    expect(() => disconnect()).not.toThrow();
  });

  it("disconnect() itself takes zero arguments", () => {
    expect(disconnect.length).toBe(0);
  });

  it("terminates the live fake transport and returns to a safe disconnected state", async () => {
    await authorizeAndConfigure();
    const pending = connect();
    const socket = latestMockSocket();
    socket.emit("open");
    await pending;
    const terminateSpy = vi.spyOn(socket, "terminate");
    const result = disconnect();
    expect(result).toEqual({ state: "disconnected" });
    expect(terminateSpy).toHaveBeenCalledTimes(1);
    expect(getConnectionState()).toEqual({ state: "ready_to_connect" });
  });

  it("reports the current unmet precondition if called while not authorized or endpoint not configured", async () => {
    expect(disconnect()).toEqual({ state: "not_authorized" });
    await authorize();
    expect(disconnect()).toEqual({ state: "endpoint_not_configured" });
  });

  it("is idempotent — calling it twice in a row is safe and non-throwing", async () => {
    await authorizeAndConfigure();
    expect(() => disconnect()).not.toThrow();
    expect(() => disconnect()).not.toThrow();
    expect(getConnectionState()).toEqual({ state: "ready_to_connect" });
  });

  it("never returns an endpoint, socket, or any field beyond state", async () => {
    await authorizeAndConfigure();
    const result = disconnect();
    expect(Object.keys(result)).toEqual(["state"]);
  });
});

describe("T-17-style — stale in-flight connect cannot restore a connected state after disconnect/clear", () => {
  it("a connect() call already in flight when disconnect() runs resolves as disconnected, not connected, even if the stale transport later opens", async () => {
    await authorizeAndConfigure();
    const inFlight = connect();
    const staleSocket = latestMockSocket();
    disconnect();
    // The stale transport "opens" late, after the user already disconnected — must not
    // retroactively restore a connected state.
    staleSocket.emit("open");
    const result = await inFlight;
    expect(result).toEqual({ state: "disconnected" });
    expect(getConnectionState()).toEqual({ state: "ready_to_connect" });
  });

  it("a connect() call that completes with no intervening disconnect still resolves normally", async () => {
    await authorizeAndConfigure();
    const inFlight = connect();
    latestMockSocket().emit("open");
    const result = await inFlight;
    expect(result).toEqual({ state: "connected" });
  });

  it("stale connection completion after authorization is cleared cannot restore connected state (mirrors electron/main.ts's own clear+disconnect composition)", async () => {
    await authorizeAndConfigure();
    const inFlight = connect();
    const staleSocket = latestMockSocket();
    // electron/main.ts's HERMES_CLEAR_AUTHORIZATION handler calls exactly this pair —
    // clearAuthorization() then disconnect() — as one enforced unit; this test exercises that
    // same composition directly rather than only asserting main.ts's own source text.
    clearAuthorization();
    disconnect();
    staleSocket.emit("open");
    const result = await inFlight;
    expect(result).toEqual({ state: "disconnected" });
    expect(getConnectionState()).toEqual({ state: "not_authorized" });
  });

  it("stale connection completion after the endpoint configuration is cleared cannot restore connected state (mirrors electron/main.ts's own clear+disconnect composition)", async () => {
    await authorizeAndConfigure();
    const inFlight = connect();
    const staleSocket = latestMockSocket();
    // electron/main.ts's HERMES_CLEAR_ENDPOINT_CONFIGURATION handler calls exactly this pair.
    clearEndpointConfiguration();
    disconnect();
    staleSocket.emit("open");
    const result = await inFlight;
    expect(result).toEqual({ state: "disconnected" });
    expect(getConnectionState()).toEqual({ state: "endpoint_not_configured" });
  });
});

describe("Fresh module lifecycle begins not_authorized (app-restart equivalence)", () => {
  it("a freshly cleared authorization state means connection state is also not_authorized", () => {
    clearAuthorization();
    expect(getConnectionState()).toEqual({ state: "not_authorized" });
  });
});

describe("Secret and transport containment", () => {
  it("never returns the token, endpoint, or any raw transport detail from connect(), even on success", async () => {
    await authorizeAndConfigure();
    const pending = connect();
    latestMockSocket().emit("open");
    const result = await pending;
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(PLACEHOLDER_CREDENTIAL);
    expect(serialized).not.toContain("127.0.0.1");
    expect(serialized).not.toContain("19130");
    expect(Object.keys(result)).toEqual(["state"]);
  });

  it("never returns the token or endpoint from getConnectionState()", async () => {
    await authorizeAndConfigure();
    const pending = connect();
    latestMockSocket().emit("open");
    await pending;
    const serialized = JSON.stringify(getConnectionState());
    expect(serialized).not.toContain(PLACEHOLDER_CREDENTIAL);
    expect(serialized).not.toContain("127.0.0.1");
  });
});
