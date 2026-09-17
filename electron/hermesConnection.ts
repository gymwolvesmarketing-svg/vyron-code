/**
 * Main-process-only Hermes connectivity/health-state service —
 * VYRON_CODE_V02_D08B_CHECKPOINT_AND_D08C_SAFE_HERMES_CONNECTIVITY_AUTHORIZATION (Part B, D-08C),
 * extended by VYRON_CODE_V02_D08C_CHECKPOINT_AND_TRUSTED_HERMES_ENDPOINT_BOUNDARY_AUTHORIZATION
 * and VYRON_CODE_V02_D08E_MEMORY_ONLY_HERMES_ENDPOINT_SETUP_AUTHORIZATION (see git history for
 * those phases' own trusted-endpoint-policy and endpoint-configuration evidence trails — no
 * longer repeated here since both blockers are now resolved: a real, user-configured, memory-
 * only endpoint can exist, and this module now genuinely connects to it).
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * D-08F — THE REAL CONNECTION, AND EXACTLY WHAT EVIDENCE AUTHORIZES IT
 * ════════════════════════════════════════════════════════════════════════════════════
 * VYRON_CODE_V02_D08E_CHECKPOINT_AND_D08F_EXPLICIT_HERMES_CONNECTIVITY_AUTHORIZATION requires
 * that no protocol behavior be invented — only what `lib/hermesClient.ts`'s own documented,
 * already-implemented, already-reviewed protocol facts establish. Those facts (read again in
 * full before writing this file):
 *
 *   Endpoint     ws://<host>:<port>/api/ws?token=<HERMES_SESSION_TOKEN>  (token as URL query)
 *   Origin       must equal http://<host>:<port>            (403 on mismatch)
 *   Host header  must equal <host>:<port>
 *   Peer         must be loopback                            (403 otherwise)
 *   Library      `ws` (not the WHATWG `WebSocket`) — the only one able to set Origin/Host
 *
 * There is no documented "health"/"ping"/"version"/"capability" JSON-RPC method anywhere in
 * this repository's own evidence — the only documented methods are session.create,
 * session.activate, prompt.submit, approval.respond, clarify.respond, session.interrupt, none
 * of which this task authorizes. Rather than invent a new one (explicitly forbidden), this
 * module treats the WebSocket handshake ITSELF as the full, minimal "health/capability"
 * signal: completing the upgrade (Origin/Host/loopback/token all validated server-side, per
 * the facts above) already proves reachability, protocol-endpoint identity, and token
 * acceptance — connect()/disconnect() themselves still never send or expect a JSON-RPC frame of
 * their own. (D-10, below, later adds the first real JSON-RPC sender, `callSessionMethod()` —
 * a distinct, narrowly-scoped function connect()/disconnect() never call themselves; see that
 * section for exactly what it sends and why.) The token is sent only because it is structurally
 * part of the one documented connection URL — there is no way to open this endpoint at all
 * without it; this is reuse of the existing, already-reviewed transport, not a new invention.
 *
 * The `CONNECT_TIMEOUT_MS` bound below is copied verbatim from `lib/hermesClient.ts`'s own
 * existing, already-accepted constant — not a newly invented number.
 *
 * Server-identity residual risk (T-15): unchanged and still accepted, per
 * VYRON_CODE_V02_D08D_TRUSTED_ENDPOINT_SOURCE_DECISION.md's own explicit decision — the
 * protocol has no TLS/certificate/server-identity mechanism this module could check. A
 * successful WebSocket open proves only that *something* accepted the Origin/Host/loopback/
 * token handshake at that address — not that it is genuinely the user's own trusted Hermes
 * instance. The renderer-facing UI (electron/renderer.html) already discloses this.
 *
 * Independent-lifetime notes carried forward unchanged: this module depends one-way on
 * electron/hermesAuthorization.ts (now also via the new `getCurrentCredential()` accessor) and
 * electron/hermesEndpointSetup.ts (via `getConfiguredEndpoint()`); neither has a dependency
 * back on this module. electron/workspace-grant.ts remains untouched and unrelated.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * D-10 — THE FIRST REAL RPC CALLS, AND EXACTLY WHAT EVIDENCE AUTHORIZES THEM
 * ════════════════════════════════════════════════════════════════════════════════════
 * VYRON_CODE_V02_D10_EXPLICIT_HERMES_SESSION_CREATION_AUTHORIZATION requires that no session
 * method/field be invented — reuse only what this repository's own protocol evidence already
 * establishes. `callSessionMethod()` below is a narrow, closed-vocabulary bridge (its `method`
 * parameter is a 3-member literal union, not an open string) added specifically so
 * electron/hermesSession.ts can send exactly the same three methods `app/api/hermes/session/route.ts`
 * and `app/api/hermes/interrupt/route.ts` already send today: `session.create`, `session.activate`
 * (both used verbatim, unchanged, in `route.ts`), and `session.close` (a real, source-verified
 * registered method — see `VYRON_CODE_V0_DISCOVERY.md`'s own `tui_gateway` method inventory —
 * called here with the identical `{session_id}`-only shape already proven by two independent,
 * real call sites in this exact codebase: `session.activate`'s and `session.interrupt`'s). This
 * is the first module in this codebase to send a real JSON-RPC frame over this connection; the
 * `"message"` handler below is extended, minimally, to parse ONLY a response envelope carrying a
 * numeric `id` matching a request this module itself sent — a bare JSON-RPC 2.0 notification
 * (the documented `{"jsonrpc":"2.0","method":"event",...}` shape) never carries an `id` field at
 * all, so it is still discarded exactly as before; no event-stream capability exists here. No
 * response body is ever logged; only `session_id`, when present, is read by the caller.
 */
import type { HermesConnectionResult, HermesConnectionState } from "./shared-ipc-contract";
import { getAuthorizationState, getCurrentCredential } from "./hermesAuthorization";
import { resolveTrustedEndpoint } from "./hermesEndpoint";
import { getConfiguredEndpoint } from "./hermesEndpointSetup";
import WSDefaultExport from "ws";

/**
 * The exact, narrow `ws` client surface this module actually uses — defined locally rather
 * than trusting an external/ambient declaration for the whole package (see `electron/ws.d.ts`'s
 * own header for why: an ambient `ws.ClientOptions`/`WebSocket` shape declared there was found
 * to collide with an unrelated declaration already present in this project's dependency tree
 * under the web app's own `tsconfig.json`). One explicit cast at this single import boundary
 * is the only place that trust is placed; everything below this line uses only these local
 * types, which exactly match the real `ws` library's own real, documented, versioned behavior.
 */
interface HermesWebSocketOptions {
  readonly origin?: string;
  readonly headers?: Record<string, string>;
  readonly handshakeTimeout?: number;
  readonly maxPayload?: number;
}

interface HermesWebSocketClient {
  readonly readyState: number;
  terminate(): void;
  send(data: string): void;
  on(event: "open" | "error" | "close" | "message" | "unexpected-response", listener: (...args: unknown[]) => void): this;
}

interface HermesWebSocketConstructor {
  new (address: string, options?: HermesWebSocketOptions): HermesWebSocketClient;
  readonly OPEN: number;
}

const WS = WSDefaultExport as HermesWebSocketConstructor;

/** Copied verbatim from `lib/hermesClient.ts`'s own existing `CONNECT_TIMEOUT_MS` — reuse of
 * an already-accepted bound, not a newly invented number. Covers both the TCP connect and the
 * WebSocket opening handshake as one bounded window, matching that file's own single-timeout
 * design exactly. */
const CONNECT_TIMEOUT_MS = 20_000;

/** A defensive upper bound on any single inbound WebSocket frame. */
const MAX_INBOUND_MESSAGE_BYTES = 65_536;

/** Copied verbatim from `lib/hermesClient.ts`'s own existing `RPC_TIMEOUT_MS` — reuse of an
 * already-accepted bound, not a newly invented number. Applies to each individual
 * `callSessionMethod()` call. */
const RPC_TIMEOUT_MS = 30_000;

/** The closed vocabulary of session-scoped RPC methods this module will ever send — see this
 * file's own D-10 header section for the exact evidence behind each one. Not an open string:
 * `callSessionMethod()`'s own signature makes sending anything outside this union a compile-time
 * error, not merely a documented convention. */
export type SessionRpcMethod = "session.create" | "session.activate" | "session.close";

export type SessionRpcOutcome = { readonly ok: true; readonly result: unknown } | { readonly ok: false };

type ConnectionAmbientState =
  | "ready_to_connect"
  | "connecting"
  | "connected"
  | "disconnected"
  | "unavailable"
  | "connection_timed_out"
  | "safe_failure";

// Module-scope, process-memory-only. `socket` is the one live client this module ever holds —
// never more than one at a time (see `connectInFlight`/the open-socket check in `connect()`).
let ambientState: ConnectionAmbientState = "ready_to_connect";
let socket: HermesWebSocketClient | null = null;

/** Bounds connect() to exactly one attempt in flight at a time — a second overlapping call
 * is rejected safely rather than allowed to race the first. */
let connectInFlight = false;

/** Monotonic generation counter — the same T-17-style guard hermesAuthorization.ts's
 * beginAuthorization()/clearAuthorization() use. A connect() call already in flight when
 * disconnect() runs (or when a later connect() call starts) safely discards its own result
 * and terminates the socket it was opening, instead of committing a now-stale state. */
let generation = 0;

/** Monotonic id assigned to each `callSessionMethod()` request, matched against the `id` field
 * of an inbound response envelope. Reset (implicitly, by simply discarding the map) whenever
 * the socket changes — a stale id from a torn-down connection can never match a new one, since
 * `pendingRpc` itself is cleared on every disconnect/close. */
let nextRpcId = 1;
let pendingRpc = new Map<number, { resolve: (outcome: SessionRpcOutcome) => void; timer: ReturnType<typeof setTimeout> }>();

/** Resolves (as `{ ok: false }`) and clears every in-flight `callSessionMethod()` call — used
 * whenever the underlying socket is known to be gone (explicit disconnect, or the socket's own
 * "close" event), so a caller waiting on a reply is never left hanging past the connection's own
 * lifetime. */
function clearPendingRpc(): void {
  for (const [, pending] of pendingRpc) {
    clearTimeout(pending.timer);
    pending.resolve({ ok: false });
  }
  pendingRpc = new Map();
}

/** Returns `not_authorized`/`endpoint_not_configured` if either precondition is currently
 * unmet, or `null` if both are satisfied and the caller should consult `ambientState`. Never
 * caches its own result — always re-derived fresh from the two owning modules. */
function currentPreconditionState(): "not_authorized" | "endpoint_not_configured" | null {
  if (getAuthorizationState().state !== "authorized_memory_only") return "not_authorized";
  const endpoint = getConfiguredEndpoint() ?? resolveTrustedEndpoint();
  if (endpoint.kind !== "trusted") return "endpoint_not_configured";
  return null;
}

/** Returns only the current safe ambient connectivity state — never an endpoint, socket, or
 * raw detail. Always reports the unmet precondition first, regardless of any connection
 * attempt's own leftover `ambientState`. */
export function getConnectionState(): HermesConnectionState {
  const precondition = currentPreconditionState();
  if (precondition) return { state: precondition };
  return { state: ambientState };
}

/**
 * The single explicit, user-initiated connection attempt. Never automatic, never retried in a
 * loop. Requires current D-08B authorization AND a current D-08E configured endpoint; rejects
 * a second concurrent call while one is already in flight; safely returns the current state
 * (never re-opens a second socket) if already connected. Opens exactly one main-process-owned
 * `ws` client against the one documented Hermes endpoint URL, sends nothing beyond the
 * WebSocket upgrade itself, and discards every inbound frame unparsed. See this module's own
 * header for the full evidence trail behind this scope.
 */
export async function connect(): Promise<HermesConnectionResult> {
  const precondition = currentPreconditionState();
  if (precondition) return { state: precondition };

  if (socket && socket.readyState === WS.OPEN) {
    return { state: "connected" };
  }
  if (connectInFlight) {
    return { state: "safe_failure" };
  }

  const endpoint = getConfiguredEndpoint() ?? resolveTrustedEndpoint();
  if (endpoint.kind !== "trusted") {
    // Re-checked defensively — currentPreconditionState() above already covers this, but a
    // real network connection is never opened on the strength of a single check alone.
    return { state: "endpoint_not_configured" };
  }
  const credential = getCurrentCredential();
  if (credential === null) {
    return { state: "not_authorized" };
  }

  connectInFlight = true;
  const generationAtStart = ++generation;
  ambientState = "connecting";

  // The one documented connection URL — a query-parameter token is structurally required by
  // the protocol itself (see module header); `endpoint.url` is already guaranteed to carry no
  // pre-existing query string (rejected at configuration time), so this is always a clean add.
  const connectUrl = new URL(endpoint.url.toString());
  connectUrl.searchParams.set("token", credential);
  const originScheme = endpoint.transport === "wss" ? "https" : "http";
  const origin = `${originScheme}://${endpoint.url.hostname}:${endpoint.url.port}`;
  const hostHeader = `${endpoint.url.hostname}:${endpoint.url.port}`;

  return new Promise<HermesConnectionResult>((resolve) => {
    let settled = false;
    const client = new WS(connectUrl.toString(), {
      origin,
      headers: { Host: hostHeader },
      handshakeTimeout: CONNECT_TIMEOUT_MS,
      maxPayload: MAX_INBOUND_MESSAGE_BYTES,
    });

    function settle(result: HermesConnectionResult, nextAmbient: ConnectionAmbientState): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      connectInFlight = false;
      if (generation !== generationAtStart) {
        // Superseded by disconnect() (or a later connect()) while this attempt was in flight —
        // never commit a result that is no longer current, and never leave the socket this
        // call opened dangling.
        try {
          client.terminate();
        } catch {
          // already closing
        }
        resolve({ state: "disconnected" });
        return;
      }
      ambientState = nextAmbient;
      resolve(result);
    }

    const timeoutTimer = setTimeout(() => {
      settle({ state: "connection_timed_out" }, "unavailable");
      try {
        client.terminate();
      } catch {
        // already closing
      }
    }, CONNECT_TIMEOUT_MS);

    client.on("open", () => {
      socket = client;
      settle({ state: "connected" }, "connected");
    });

    // Every failure path — a refused/errored socket, or a non-101 upgrade response (e.g. the
    // documented 403 on Origin/Host/loopback mismatch, or an invalid token) — resolves to the
    // same fixed, safe category. The real error/status is never inspected or forwarded.
    client.on("error", () => {
      settle({ state: "safe_failure" }, "unavailable");
    });
    client.on("unexpected-response", () => {
      settle({ state: "safe_failure" }, "unavailable");
    });

    client.on("close", () => {
      if (socket === client) {
        socket = null;
        clearPendingRpc();
      }
      if (!settled) {
        settle({ state: "connection_timed_out" }, "unavailable");
        return;
      }
      // A later close of an already-"connected" socket (server-initiated, or a network drop)
      // — reflect it without resolving the already-settled promise again, and without
      // clobbering a different ambient state (e.g. one this same close already set via
      // disconnect()'s own generation bump).
      if (generation === generationAtStart && ambientState === "connected") {
        ambientState = "disconnected";
      }
    });

    // D-10: parses ONLY a response envelope carrying a numeric `id` matching a request this
    // module itself sent via callSessionMethod() — see this file's own D-10 header section.
    // Anything else (malformed JSON, a notification frame with no `id`, an `id` this module
    // never issued or already resolved) is discarded exactly as before; never logged, never
    // forwarded further.
    client.on("message", (data: unknown) => {
      let envelope: { id?: unknown; result?: unknown; error?: unknown } | null = null;
      try {
        envelope = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!envelope || typeof envelope.id !== "number") return;
      const pending = pendingRpc.get(envelope.id);
      if (!pending) return;
      pendingRpc.delete(envelope.id);
      clearTimeout(pending.timer);
      if (envelope.error) {
        pending.resolve({ ok: false });
      } else {
        pending.resolve({ ok: true, result: envelope.result });
      }
    });
  });
}

/**
 * Explicit, immediate, idempotent — safe to call whether or not a connect() attempt is
 * currently in flight or has ever run. Bumps the generation counter so any in-flight connect()
 * is provably superseded, and forcibly terminates any live socket. Mirrors
 * hermesAuthorization.ts's clearAuthorization() exactly.
 */
export function disconnect(): HermesConnectionResult {
  generation++;
  const current = socket;
  socket = null;
  clearPendingRpc();
  if (current) {
    try {
      current.terminate();
    } catch {
      // already closed/closing
    }
  }
  ambientState = "ready_to_connect";
  const precondition = currentPreconditionState();
  if (precondition) return { state: precondition };
  return { state: "disconnected" };
}

/**
 * D-10 — sends exactly one of the three closed-vocabulary session methods over the current
 * connection and resolves with its result once the response envelope carrying a matching `id`
 * arrives, or `{ ok: false }` on any failure (not connected, send error, malformed response, a
 * JSON-RPC `error` field, or timeout) — never a distinguished error detail, matching this
 * module's existing `connect()`/`disconnect()` safe-category discipline. The only caller is
 * electron/hermesSession.ts; this module has no session concept of its own beyond forwarding
 * exactly the method/params its caller supplies (never widened, never inspected beyond that).
 */
export async function callSessionMethod(method: SessionRpcMethod, params: Record<string, unknown>): Promise<SessionRpcOutcome> {
  if (!socket || socket.readyState !== WS.OPEN) return { ok: false };

  const id = nextRpcId++;
  return new Promise<SessionRpcOutcome>((resolve) => {
    const timer = setTimeout(() => {
      pendingRpc.delete(id);
      resolve({ ok: false });
    }, RPC_TIMEOUT_MS);
    pendingRpc.set(id, { resolve, timer });
    try {
      socket!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    } catch {
      pendingRpc.delete(id);
      clearTimeout(timer);
      resolve({ ok: false });
    }
  });
}
