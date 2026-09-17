import { describe, it, expect, beforeEach, vi } from "vitest";

// A minimal, fully self-contained fake WebSocket — same shape/conventions as
// tests/electronHermesConnection.test.ts's own MockWebSocket, extended here with a REAL
// `send()` that records every sent frame (so this file's own tests can inspect exactly what
// electron/hermesConnection.ts's callSessionMethod() sends) and a helper to simulate an inbound
// response frame. VYRON_CODE_V02_D10_EXPLICIT_HERMES_SESSION_CREATION_AUTHORIZATION explicitly
// forbids opening a real WebSocket, a real HTTP/WebSocket server, or any real network request in
// automated tests — this fake never touches a socket, a port, or the network in any way; every
// "connection" and every "response" in this file is driven entirely by the test itself.
const { MockWebSocket, getMockInstances, resetMockInstances } = vi.hoisted(() => {
  class MockWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState: 0 | 1 | 2 | 3 = 0;
    readonly url: string;
    readonly options: Record<string, unknown>;
    readonly sent: string[] = [];
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

    send(data: string): void {
      this.sent.push(data);
    }

    /** Test-only helper: simulates the server replying to the most recently sent request with
     * `result`, matching the real request's own `id` automatically. */
    respondToLast(result: unknown): void {
      const last = JSON.parse(this.sent[this.sent.length - 1] ?? "{}") as { id?: number };
      this.emit("message", JSON.stringify({ jsonrpc: "2.0", id: last.id, result }));
    }

    /** Test-only helper: simulates a JSON-RPC error response to the most recently sent request. */
    errorToLast(): void {
      const last = JSON.parse(this.sent[this.sent.length - 1] ?? "{}") as { id?: number };
      this.emit("message", JSON.stringify({ jsonrpc: "2.0", id: last.id, error: { code: -1, message: "boom" } }));
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

import { connect, disconnect } from "../electron/hermesConnection";
import { beginAuthorization, clearAuthorization } from "../electron/hermesAuthorization";
import { configureEndpoint, clearEndpointConfiguration } from "../electron/hermesEndpointSetup";
import { getSessionState, createSession, closeSession, clearSession } from "../electron/hermesSession";

// Every value below is an explicit, obviously-fake sample — never a real Hermes token, never a
// real endpoint, never read from .env.local/process.env, and never used to open a real network
// connection (the "ws" module is fully mocked above; nothing in this file ever reaches a real
// socket, DNS resolver, or TCP/HTTP/WebSocket server of any kind). No real Hermes session is
// ever created; every "session_id" below is a hand-written placeholder string.
const PLACEHOLDER_CREDENTIAL = "placeholder-test-credential-value-not-real";
const FAKE_LOOPBACK_ENDPOINT = "ws://127.0.0.1:19130/api/ws";
const FAKE_SESSION_ID = "fake-session-id-not-real";

function latestMockSocket() {
  const instances = getMockInstances();
  const latest = instances[instances.length - 1];
  if (!latest) throw new Error("no MockWebSocket instance was constructed");
  return latest;
}

/** Flushes several microtask ticks — a JSON-RPC response resolving through
 * pendingRpc → the executor's own `new Promise` → callSessionMethod's `await` → createSession's
 * own `await` chain takes more than one microtask hop to fully settle; a single
 * `await Promise.resolve()` is not always enough. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

async function authorizeConfigureAndConnect(): Promise<void> {
  await beginAuthorization({ credential: PLACEHOLDER_CREDENTIAL });
  await configureEndpoint({ endpoint: FAKE_LOOPBACK_ENDPOINT });
  const pending = connect();
  latestMockSocket().emit("open");
  await pending;
}

/** Drives createSession() through a full successful fake session.create + session.activate
 * round trip, resolving once createSession()'s own promise resolves. */
async function createSessionSuccessfully(): Promise<{ state: string }> {
  const pending = createSession();
  // Allow the create() call's own microtask (assigning the id / registering pendingRpc) to run
  // before the mock socket's `sent` array is inspected.
  await flush();
  latestMockSocket().respondToLast({ session_id: FAKE_SESSION_ID, info: { model: "default", cwd: null, project: null } });
  await flush();
  latestMockSocket().respondToLast({});
  return pending;
}

beforeEach(() => {
  clearAuthorization();
  clearEndpointConfiguration();
  disconnect();
  clearSession();
  resetMockInstances();
  vi.useRealTimers();
});

describe("getSessionState — safe ambient state, gated on authorization + endpoint + connection", () => {
  it("reports unavailable before any authorization exists", () => {
    expect(getSessionState()).toEqual({ state: "unavailable" });
  });

  it("reports unavailable once authorized and endpoint-configured but not yet connected", async () => {
    await beginAuthorization({ credential: PLACEHOLDER_CREDENTIAL });
    await configureEndpoint({ endpoint: FAKE_LOOPBACK_ENDPOINT });
    expect(getSessionState()).toEqual({ state: "unavailable" });
  });

  it("reports no_session once authorized, endpoint-configured, and connected", async () => {
    await authorizeConfigureAndConnect();
    expect(getSessionState()).toEqual({ state: "no_session" });
  });

  it("never includes a session id or any field beyond state", async () => {
    await authorizeConfigureAndConnect();
    const result = getSessionState();
    expect(Object.keys(result)).toEqual(["state"]);
  });
});

describe("createSession — preconditions", () => {
  it("fails safely with unavailable when not authorized", async () => {
    expect(await createSession()).toEqual({ state: "unavailable" });
  });

  it("fails safely with unavailable when authorized but endpoint not configured", async () => {
    await beginAuthorization({ credential: PLACEHOLDER_CREDENTIAL });
    expect(await createSession()).toEqual({ state: "unavailable" });
  });

  it("fails safely with unavailable when authorized and endpoint-configured but not connected", async () => {
    await beginAuthorization({ credential: PLACEHOLDER_CREDENTIAL });
    await configureEndpoint({ endpoint: FAKE_LOOPBACK_ENDPOINT });
    expect(await createSession()).toEqual({ state: "unavailable" });
  });

  it("re-validates preconditions immediately before transport use, never trusting a prior read", async () => {
    await authorizeConfigureAndConnect();
    clearAuthorization();
    expect(await createSession()).toEqual({ state: "unavailable" });
    expect(getMockInstances()[0]?.sent).toHaveLength(0);
  });
});

describe("createSession — protocol contract (A: only proven, minimal fields)", () => {
  it("sends session.create with a completely empty params object — no workspace/cwd/path/title/model/provider/prompt/context field", async () => {
    await authorizeConfigureAndConnect();
    const pending = createSession();
    await flush();
    const socket = latestMockSocket();
    expect(socket.sent).toHaveLength(1);
    const sentRequest = JSON.parse(socket.sent[0] ?? "{}");
    expect(sentRequest.method).toBe("session.create");
    expect(sentRequest.params).toEqual({});
    socket.respondToLast({ session_id: FAKE_SESSION_ID });
    await flush();
    socket.respondToLast({});
    await pending;
  });

  it("sends session.activate with exactly {session_id}, matching the server-issued id — no other field", async () => {
    await authorizeConfigureAndConnect();
    const pending = createSession();
    await flush();
    const socket = latestMockSocket();
    socket.respondToLast({ session_id: FAKE_SESSION_ID });
    await flush();
    expect(socket.sent).toHaveLength(2);
    const activateRequest = JSON.parse(socket.sent[1] ?? "{}");
    expect(activateRequest.method).toBe("session.activate");
    expect(activateRequest.params).toEqual({ session_id: FAKE_SESSION_ID });
    socket.respondToLast({});
    await pending;
  });

  it("never sends a forbidden method — prompt.submit, approval.respond, clarify.respond, or session.interrupt", async () => {
    await authorizeConfigureAndConnect();
    await createSessionSuccessfully();
    const socket = latestMockSocket();
    const methods = socket.sent.map((s) => JSON.parse(s).method);
    for (const forbidden of ["prompt.submit", "approval.respond", "clarify.respond", "session.interrupt"]) {
      expect(methods).not.toContain(forbidden);
    }
  });

  it("reaches active only after both session.create and session.activate succeed", async () => {
    await authorizeConfigureAndConnect();
    const result = await createSessionSuccessfully();
    expect(result).toEqual({ state: "active" });
    expect(getSessionState()).toEqual({ state: "active" });
  });

  it("resolves safe_failure if session.create returns no session_id", async () => {
    await authorizeConfigureAndConnect();
    const pending = createSession();
    await flush();
    latestMockSocket().respondToLast({});
    expect(await pending).toEqual({ state: "safe_failure" });
  });

  it("resolves safe_failure if session.create returns a JSON-RPC error", async () => {
    await authorizeConfigureAndConnect();
    const pending = createSession();
    await flush();
    latestMockSocket().errorToLast();
    expect(await pending).toEqual({ state: "safe_failure" });
  });

  it("resolves safe_failure if session.activate returns a JSON-RPC error", async () => {
    await authorizeConfigureAndConnect();
    const pending = createSession();
    await flush();
    latestMockSocket().respondToLast({ session_id: FAKE_SESSION_ID });
    await flush();
    latestMockSocket().errorToLast();
    expect(await pending).toEqual({ state: "safe_failure" });
  });
});

describe("createSession — lifecycle and bounds", () => {
  it("bounds to one creation in flight — a duplicate call while one is pending is rejected safely", async () => {
    await authorizeConfigureAndConnect();
    const first = createSession();
    const second = await createSession();
    expect(second).toEqual({ state: "safe_failure" });
    await flush();
    const socket = latestMockSocket();
    socket.respondToLast({ session_id: FAKE_SESSION_ID });
    await flush();
    socket.respondToLast({});
    await first;
  });

  it("returns active immediately, without a new transport call, when a session is already active", async () => {
    await authorizeConfigureAndConnect();
    await createSessionSuccessfully();
    const socket = latestMockSocket();
    const sentCountBefore = socket.sent.length;
    const result = await createSession();
    expect(result).toEqual({ state: "active" });
    expect(socket.sent).toHaveLength(sentCountBefore);
  });
});

describe("closeSession", () => {
  it("is idempotent — closing with no active session safely returns no_session and sends nothing", async () => {
    await authorizeConfigureAndConnect();
    const result = await closeSession();
    expect(result).toEqual({ state: "no_session" });
    expect(latestMockSocket().sent).toHaveLength(0);
  });

  it("sends session.close with exactly {session_id}, then clears local state regardless of the response", async () => {
    await authorizeConfigureAndConnect();
    await createSessionSuccessfully();
    const socket = latestMockSocket();
    const pending = closeSession();
    await flush();
    const closeRequest = JSON.parse(socket.sent[socket.sent.length - 1] ?? "{}");
    expect(closeRequest.method).toBe("session.close");
    expect(closeRequest.params).toEqual({ session_id: FAKE_SESSION_ID });
    socket.errorToLast();
    const result = await pending;
    expect(result).toEqual({ state: "closed" });
    expect(getSessionState()).toEqual({ state: "closed" });
  });
});

describe("cross-module cleanup — session state clears on every revoke path (T-17-style)", () => {
  it("clearSession() (called from main.ts on disconnect) resets an active session to no_session", async () => {
    await authorizeConfigureAndConnect();
    await createSessionSuccessfully();
    expect(getSessionState()).toEqual({ state: "active" });
    clearSession();
    // Still connected — preconditions remain satisfied, so the real (now-reset) ambient state
    // is reported as-is: no_session, not unavailable.
    expect(getSessionState()).toEqual({ state: "no_session" });
  });

  it("disconnecting the underlying connection makes an active session unreachable via getSessionState (self-heal)", async () => {
    await authorizeConfigureAndConnect();
    await createSessionSuccessfully();
    disconnect();
    expect(getSessionState()).toEqual({ state: "unavailable" });
  });

  it("clearing the Hermes authorization makes an active session unreachable via getSessionState (self-heal)", async () => {
    await authorizeConfigureAndConnect();
    await createSessionSuccessfully();
    clearAuthorization();
    expect(getSessionState()).toEqual({ state: "unavailable" });
  });

  it("clearing the endpoint configuration makes an active session unreachable via getSessionState (self-heal)", async () => {
    await authorizeConfigureAndConnect();
    await createSessionSuccessfully();
    clearEndpointConfiguration();
    expect(getSessionState()).toEqual({ state: "unavailable" });
  });

  it("a stale createSession() completion cannot restore active state after an intervening clearSession()", async () => {
    await authorizeConfigureAndConnect();
    const pending = createSession();
    await flush();
    const socket = latestMockSocket();
    socket.respondToLast({ session_id: FAKE_SESSION_ID });
    // Superseded mid-flight, right after session.create resolves but before session.activate.
    clearSession();
    await flush();
    socket.respondToLast({});
    const result = await pending;
    // The stale attempt must not report itself as having succeeded, and must not leave the
    // module believing a session is active.
    expect(result).not.toEqual({ state: "active" });
    expect(getSessionState().state).not.toBe("active");
  });

  it("a transport close while a session is active clears it on the next getSessionState() read", async () => {
    await authorizeConfigureAndConnect();
    await createSessionSuccessfully();
    latestMockSocket().terminate();
    expect(getSessionState()).toEqual({ state: "unavailable" });
  });
});

describe("security regressions", () => {
  it("createSession/closeSession/getSessionState take no parameters at all", () => {
    expect(createSession.length).toBe(0);
    expect(closeSession.length).toBe(0);
    expect(getSessionState.length).toBe(0);
  });

  it("no result object from any exported function ever carries a field beyond state", async () => {
    await authorizeConfigureAndConnect();
    const created = await createSessionSuccessfully();
    expect(Object.keys(created)).toEqual(["state"]);
    const socket = latestMockSocket();
    const closePending = closeSession();
    await flush();
    socket.respondToLast({});
    const closed = await closePending;
    expect(Object.keys(closed)).toEqual(["state"]);
  });
});
