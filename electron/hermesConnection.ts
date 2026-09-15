/**
 * Main-process-only Hermes connectivity/health-state service —
 * VYRON_CODE_V02_D08B_CHECKPOINT_AND_D08C_SAFE_HERMES_CONNECTIVITY_AUTHORIZATION (Part B, D-08C).
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * TRUSTED-ENDPOINT-POLICY BLOCKER — READ BEFORE MODIFYING THIS FILE
 * ════════════════════════════════════════════════════════════════════════════════════
 * This authorization requires D-08C's Hermes endpoint/configuration to be either (a) a
 * main-process-owned, compile-time/project-local FIXED value, or (b), if no such value can be
 * safely defined, a static safe "unavailable" state with the blocker explicitly reported —
 * and explicitly forbids sourcing it from an environment variable in this stage.
 *
 * The ONLY existing source of Hermes's host/port anywhere in this repository is
 * `.env.local`'s `HERMES_HOST`/`HERMES_PORT`, read via `process.env` in `lib/hermesClient.ts`
 * and `app/api/hermes/health/route.ts` — an environment-variable source, not a compile-time
 * constant. This exact gap was already identified, before this authorization, as an "Open,
 * unresolved design gap ... blocking for D-08" in
 * VYRON_CODE_V02_DESKTOP_MIGRATION_ARCHITECTURE_AUDIT.md's own risk table (row 11), explicitly
 * deferred pending "its own separate, explicit product decision." This authorization's own
 * connection-policy section anticipates exactly this outcome: "if any of these conditions
 * cannot be safely met, do not implement live network connection. Instead implement only a
 * static safe unavailable state and report the blocker."
 *
 * Consequently: this module NEVER imports `node:net`/`node:http`/`node:https`/`ws`, NEVER
 * opens a socket, NEVER performs a TCP probe or WebSocket handshake, and NEVER reads
 * `process.env` for a host/port/token. `connect()` always resolves to the safe `"unavailable"`
 * state after one explicit yield point — so the renderer's own transient "connecting" UI state
 * is exercised honestly, not faked, without a real network attempt existing behind it. This is
 * the deliberate, disclosed behavior this authorization itself requires when its trusted-
 * endpoint precondition cannot be met — not a bug, and not something to "fix" by adding an
 * environment-variable read, a hardcoded IP/port, or a renderer-editable setting, all of which
 * this authorization explicitly forbids.
 *
 * Because no real connection is ever attempted, the "connection bounds" this authorization's
 * own policy section requires for a real implementation (explicit connect/handshake timeout,
 * maximum inbound protocol message size, maximum safe state-update frequency, process-exit
 * socket cleanup) have no applicable implementation here — there is no socket, no handshake,
 * and no inbound message stream to bound. They become relevant only once a separately
 * authorized trusted-endpoint policy exists and a real connection path is implemented on top
 * of it (see this task's own companion report for the exact blocker statement).
 *
 * Independent-lifetime note: this module depends on electron/hermesAuthorization.ts (one-way
 * — it reads `getAuthorizationState()` to gate `connect()`, per this authorization's own
 * explicit precondition that a connection may only be attempted once D-08B authorization is
 * current) but hermesAuthorization.ts has no dependency back on this module, and
 * electron/workspace-grant.ts is untouched and unrelated to either.
 *
 * Extended by VYRON_CODE_V02_D08C_CHECKPOINT_AND_TRUSTED_HERMES_ENDPOINT_BOUNDARY_AUTHORIZATION
 * to consume electron/hermesEndpoint.ts's `resolveTrustedEndpoint()` rather than hardcoding
 * `"unavailable"` as this module's own arbitrary literal — `connect()` now genuinely asks the
 * endpoint boundary whether a trusted endpoint exists before deciding what to do. The answer is
 * still always "no" in this build (see hermesEndpoint.ts's own header for the full future-
 * source-policy comparison), so the *observable* behavior is unchanged — but the reason is now
 * structural (a real fail-closed resolution step ran and returned `unavailable`) rather than a
 * connect()-local assumption. Even in the hypothetical branch where a trusted endpoint were
 * ever returned, this task still does not authorize opening a real socket — see the explicit
 * comment at that branch below.
 */
import type { HermesConnectionResult, HermesConnectionState } from "./shared-ipc-contract";
import { getAuthorizationState } from "./hermesAuthorization";
import { resolveTrustedEndpoint } from "./hermesEndpoint";

// Module-scope, process-memory-only. Starts "ready_to_connect" the instant authorization
// becomes valid (getConnectionState always re-derives the "not_authorized" case fresh from
// hermesAuthorization.ts rather than trusting this alone) and becomes "unavailable" only
// after an explicit connect() attempt — see this module's own header for why it can never
// become "connected" in this build.
let ambientState: "ready_to_connect" | "unavailable" = "ready_to_connect";

/** Bounds connect() to exactly one attempt in flight at a time — a second overlapping call
 * is rejected safely rather than allowed to race the first. */
let connectInFlight = false;

/** Monotonic generation counter — the same T-17-style guard hermesAuthorization.ts's
 * beginAuthorization()/clearAuthorization() use. A connect() call already in flight when
 * disconnect() runs (or when a later connect() call starts) safely discards its own result
 * instead of committing a now-stale state. */
let generation = 0;

/** Returns only the current safe ambient connectivity state — never an endpoint, socket, or
 * raw detail. Always reports `not_authorized` if D-08B authorization is not currently valid,
 * regardless of any prior connection attempt's own leftover state. */
export function getConnectionState(): HermesConnectionState {
  if (getAuthorizationState().state !== "authorized_memory_only") {
    return { state: "not_authorized" };
  }
  return { state: ambientState };
}

/**
 * The single explicit, user-initiated connection attempt this authorization allows. Never
 * automatic, never retried in a loop. Requires current D-08B authorization; rejects a second
 * concurrent call while one is already in flight. See this module's header for why it always
 * resolves to `"unavailable"` rather than ever opening a real connection.
 */
export async function connect(): Promise<HermesConnectionResult> {
  if (getAuthorizationState().state !== "authorized_memory_only") {
    return { state: "not_authorized" };
  }
  if (connectInFlight) {
    return { state: "safe_failure" };
  }

  connectInFlight = true;
  const generationAtStart = ++generation;
  try {
    // Explicit yield point — see module header. Gives a concurrent disconnect() (or another
    // connect() call) a real opportunity to supersede this one before it commits any state.
    await Promise.resolve();
    if (generation !== generationAtStart) {
      return { state: "disconnected" };
    }

    const endpoint = resolveTrustedEndpoint();
    if (endpoint.kind !== "trusted") {
      // Always true in this build — see this module's header and hermesEndpoint.ts's own
      // header for why. No endpoint/host/port/reason detail from `endpoint` is ever forwarded
      // into the renderer-visible result below; only the fixed, safe `"unavailable"` literal.
      ambientState = "unavailable";
      return { state: "unavailable" };
    }

    // A real trusted endpoint would be used here to open an actual connection — NOT
    // implemented by this task (VYRON_CODE_V02_D08C_CHECKPOINT_AND_TRUSTED_HERMES_ENDPOINT_BOUNDARY_AUTHORIZATION
    // explicitly forbids WebSocket/net/http construction). Until a future, separately
    // authorized task adds that, this branch is unreachable in practice but is written this
    // way — rather than deleted — so the endpoint boundary is genuinely consulted, not merely
    // decorative.
    ambientState = "unavailable";
    return { state: "unavailable" };
  } finally {
    connectInFlight = false;
  }
}

/**
 * Explicit, immediate, idempotent — safe to call whether or not a connect() attempt is
 * currently in flight or has ever run. Bumps the generation counter so any in-flight
 * connect() is provably superseded, mirroring hermesAuthorization.ts's clearAuthorization().
 */
export function disconnect(): HermesConnectionResult {
  generation++;
  ambientState = "ready_to_connect";
  if (getAuthorizationState().state !== "authorized_memory_only") {
    return { state: "not_authorized" };
  }
  return { state: "disconnected" };
}
