/**
 * SERVER-SIDE ONLY. JSON-RPC 2.0-over-WebSocket client for Hermes Agent's tui_gateway.
 * Imported only from app/api/hermes/*.ts route handlers and lib/hermesEvents.ts (itself
 * server-only) — never from a "use client" component, and never bundled into the browser
 * (verified in VYRON_CODE_V01_HERMES_WS_SMOKE_TEST_REPORT.md by scanning the served HTML/JS
 * for both the literal string "ws" module marker and the token itself).
 *
 * Protocol facts (per Vyron Pro's own verified lib/hermesClient.ts, itself checked against
 * Hermes 0.20.6 — taken as authoritative since Vyron Pro is the existing, already-working
 * client against this exact Hermes Agent instance; not re-derived independently, only
 * matched exactly):
 *
 *   - Endpoint     ws://<host>:<port>/api/ws?token=<HERMES_SESSION_TOKEN>
 *   - Subprotocol  none (token-based auth selects no subprotocol)
 *   - Origin       must equal http://<host>:<port>            (403 on mismatch)
 *   - Host header  must equal <host>:<port>
 *   - Peer         must be loopback                            (403 otherwise)
 *
 * `ws` (not the WHATWG-standard global `WebSocket`) is used specifically because it is the
 * only one of the two capable of setting the Origin/Host handshake headers above — verified
 * empirically in the prior wiring attempt (VYRON_CODE_V01_HERMES_CHAT_WIRING_REPORT.md) that
 * the native client sends no Origin header at all and accepts no headers option, which is
 * exactly why that attempt's session.create failed at the handshake.
 *
 * v0.1 only calls the read/chat-safe subset: session.create, session.activate,
 * prompt.submit, approval.respond, clarify.respond, session.interrupt. No filesystem-
 * mutating or shell/cli-exec method is ever called from this client — v0.1's filesystem
 * layer is entirely Vyron Code's own (see lib/canonicalPath.ts, lib/fsGuard.ts), never
 * routed through Hermes Agent.
 *
 * Server events arrive wrapped exactly like Vyron Pro's own client documents:
 *   {"jsonrpc":"2.0","method":"event","params":{"type":"message.delta","session_id":"...","data":{...}}}
 * — unwrapped once here into {type, sessionId, payload}; nothing downstream should look at
 * the raw method:"event"/params shape.
 */
import WS from "ws";

const RPC_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 20_000;

type RpcEnvelope = { jsonrpc: "2.0"; id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } };

export type HermesEvent = { type: string; sessionId: string; payload: Record<string, unknown> };

export class HermesClient {
  private ws: WS | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private eventListeners = new Set<(evt: HermesEvent) => void>();
  private connectPromise: Promise<void> | null = null;

  constructor(
    private readonly host: string,
    private readonly port: string,
    private readonly token: string
  ) {}

  onEvent(listener: (evt: HermesEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WS.OPEN) return;
    if (this.connectPromise) return this.connectPromise;

    // Origin/Host are derived ONLY from the same host/port this client was already
    // configured with (itself sourced from Vyron Pro's own verified .env.local) — never
    // guessed, never widened to a wildcard, never independently overridable.
    const origin = `http://${this.host}:${this.port}`;
    const url = `ws://${this.host}:${this.port}/api/ws?token=${encodeURIComponent(this.token)}`;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = new WS(url, {
        origin,
        headers: { Host: `${this.host}:${this.port}` },
        handshakeTimeout: CONNECT_TIMEOUT_MS,
      });

      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error("hermes gateway connect timeout"));
      }, CONNECT_TIMEOUT_MS);

      socket.on("open", () => {
        clearTimeout(timer);
        this.ws = socket;
        resolve();
      });

      socket.on("message", (data) => this.handleFrame(data));

      socket.on("error", (err) => {
        clearTimeout(timer);
        // Safe to surface err.message: verified against ws's own source
        // (node_modules/ws/lib/websocket.js) that its handshake-failure error messages are
        // always generic ("Unexpected server response: <status code>", "WebSocket is not
        // open: readyState ...", or the underlying Node network error's own message like
        // ECONNREFUSED) — never the request URL or query string, so the token cannot appear
        // here. Still never interpolate the raw `err` object itself (only its .message).
        reject(new Error(`hermes gateway connection failed: ${err.message}`));
      });

      socket.on("close", () => {
        this.ws = null;
        for (const [, waiter] of this.pending) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error("hermes gateway connection closed"));
        }
        this.pending.clear();
      });
    }).finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  private handleFrame(data: unknown) {
    let envelope: RpcEnvelope;
    try {
      envelope = JSON.parse(String(data));
    } catch {
      return;
    }
    if (envelope.method === "event") {
      const params = envelope.params ?? {};
      const evt: HermesEvent = {
        type: String(params.type || ""),
        sessionId: String(params.session_id || ""),
        payload: (params.data || params.payload || {}) as Record<string, unknown>,
      };
      for (const listener of this.eventListeners) listener(evt);
      return;
    }
    if (typeof envelope.id === "number" && this.pending.has(envelope.id)) {
      const waiter = this.pending.get(envelope.id)!;
      clearTimeout(waiter.timer);
      this.pending.delete(envelope.id);
      if (envelope.error) waiter.reject(new Error(envelope.error.message));
      else waiter.resolve(envelope.result);
    }
  }

  async call(method: string, params: Record<string, unknown> = {}, timeoutMs = RPC_TIMEOUT_MS): Promise<unknown> {
    await this.connect();
    if (!this.ws) throw new Error("hermes gateway not connected");

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`hermes gateway call timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}

let _shared: HermesClient | null = null;

export function getHermesClient(): HermesClient {
  if (_shared) return _shared;
  // HERMES_HOST/HERMES_PORT are not guessed — copied from Vyron Pro's own verified
  // .env.local into Vyron Code's own .env.local (same Hermes Agent instance, same
  // protocol). HERMES_SESSION_TOKEN is deliberately NOT persisted in any file here — per
  // this task's authorization it may only be supplied as a live server-side process
  // environment variable, never written to .env.local, never logged, never returned to a
  // caller. Fails closed, exactly like Vyron Pro's own client, if it is absent.
  const host = process.env.HERMES_HOST;
  const port = process.env.HERMES_PORT;
  const token = process.env.HERMES_SESSION_TOKEN;
  if (!host || !port) {
    throw new Error("HERMES_HOST and HERMES_PORT must be set in .env.local (copied from Vyron Pro's own config)");
  }
  if (!token) {
    throw new Error("HERMES_SESSION_TOKEN not configured in the server process environment (fail-closed, not persisted to any file)");
  }
  _shared = new HermesClient(host, port, token);
  return _shared;
}
