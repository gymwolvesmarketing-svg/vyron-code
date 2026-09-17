/**
 * Main-process-only Hermes API Server connection-verification service —
 * VYRON_CODE_V02_D10_API_SERVER_REMEDIATION_AUTHORIZATION.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS MODULE REPLACES electron/hermesConnection.ts AND electron/hermesSession.ts
 * ════════════════════════════════════════════════════════════════════════════════════
 * The prior D-08F/D-10 implementation opened a WebSocket to the Hermes dashboard's own
 * internal `/api/ws` endpoint and sent `session.create`/`session.activate`/`session.close`
 * JSON-RPC frames over it. A dedicated remediation discovery (see
 * VYRON_CODE_V02_D10_API_SERVER_REMEDIATION_REPORT.md) established, from official Hermes Agent
 * documentation and source, that `/api/ws` is internal to the dashboard/TUI process — bound to
 * that process's own lifetime, authenticated by a browser session cookie or a first-party
 * single-use ticket, never a general external-client attachment surface — while a SEPARATE,
 * officially documented HTTP surface, the Hermes API Server, exists specifically for
 * third-party frontends. This module targets that surface instead.
 *
 * Official facts this module relies on (verified via the official docs at
 * hermes-agent.nousresearch.com/docs/user-guide/features/api-server and the real
 * `gateway/platforms/api_server.py` source, both re-checked, not merely carried forward):
 *
 *   Base URL      http://{host}:{port}         (OpenAI-compatible surface itself is at .../v1)
 *   Default host  127.0.0.1 (loopback by default)
 *   Default port  8642 — never assumed by this module; the user must configure their own
 *   Enablement    API_SERVER_ENABLED=true (server-side; this module has no ability to read or
 *                 change that — it only ever calls an already-running server)
 *   Credential    API_SERVER_KEY, sent as `Authorization: Bearer <API_SERVER_KEY>`
 *   Liveness      `GET /health` — documented and independently corroborated (including a real,
 *                 public bug report about it) as INTENTIONALLY UNAUTHENTICATED: "Only /health
 *                 and /v1/health are intentionally unauthenticated." No prompt, model, session,
 *                 workspace, or any other side effect is documented for this route.
 *
 * Because `GET /health` is documented as never requiring authorization, this module's one
 * request never attaches the `Authorization` header — sending a real credential to a route
 * that ignores it would add risk (a credential in flight) for zero verification benefit. The
 * credential boundary (electron/hermesAuthorization.ts, reused unchanged) is still required as
 * an explicit *precondition* to verifying — matching this app's established "explicit
 * authorize before any action" pattern — it is simply not part of THIS specific request. A
 * future, separately authorized capability that calls an authenticated route (e.g.
 * `/v1/chat/completions`) would attach it then.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * SCOPE — WHAT THIS MODULE DOES AND DOES NOT DO
 * ════════════════════════════════════════════════════════════════════════════════════
 * Exactly one capability: send one `GET` request to `<validated-endpoint-origin>/health` and
 * reduce the outcome to a small safe enum. No request body, no query string, no custom header
 * beyond what `fetch` itself sends, no redirect following (`redirect: "error"` — a redirect is
 * treated as a failure, never silently followed to an unvalidated location), no cookie jar, no
 * retry, no polling, no second endpoint, no session concept, no model/provider/prompt/context
 * of any kind. Depends one-way on electron/hermesAuthorization.ts (for the precondition check
 * only — the credential itself is read but never transmitted here),
 * electron/hermesEndpointSetup.ts, and electron/hermesEndpoint.ts; none of those import this
 * module. electron/main.ts is the sole orchestrator of cross-module cleanup (clearing
 * authorization/endpoint also clears verification state), mirroring every prior phase's own
 * established composition pattern.
 */
import type { HermesApiServerResult, HermesApiServerState } from "./shared-ipc-contract";
import { getAuthorizationState, getCurrentCredential } from "./hermesAuthorization";
import { resolveTrustedEndpoint } from "./hermesEndpoint";
import { getConfiguredEndpoint } from "./hermesEndpointSetup";

/** A new, independently disclosed and tested bound for this module's one request — not reused
 * from elsewhere, since no prior phase ever made a real HTTP request. Generous enough for a
 * local loopback liveness check to never spuriously time out. */
const VERIFY_TIMEOUT_MS = 10_000;

type ApiServerAmbientState = "ready_to_verify" | "verifying" | "reachable" | "unavailable" | "safe_failure";

// Module-scope, process-memory-only.
let ambientState: ApiServerAmbientState = "ready_to_verify";

/** Bounds verifyApiServerConnection() to exactly one attempt in flight at a time. */
let verifyInFlight = false;

/** Monotonic generation counter — the same T-17-style guard used throughout this codebase's
 * other Hermes services. A verify already in flight when clearApiServerVerification() runs (or
 * a later verify starts) safely discards its own result instead of committing a now-stale
 * "reachable" state. */
let generation = 0;

/** Returns `not_authorized`/`endpoint_not_configured` if either precondition is currently
 * unmet, or `null` if both are satisfied. Never caches its own result — always re-derived fresh
 * from the two owning modules. */
function currentPreconditionState(): "not_authorized" | "endpoint_not_configured" | null {
  if (getAuthorizationState().state !== "authorized_memory_only") return "not_authorized";
  const endpoint = getConfiguredEndpoint() ?? resolveTrustedEndpoint();
  if (endpoint.kind !== "trusted") return "endpoint_not_configured";
  return null;
}

/** Forces the tracked ambient state back to `ready_to_verify` and supersedes any in-flight
 * verify — used both by the self-healing precondition check below and by the explicit
 * `clearApiServerVerification()` export. */
function resetToReadyToVerify(): void {
  generation++;
  verifyInFlight = false;
  ambientState = "ready_to_verify";
}

/**
 * The only safe, renderer-facing verification state — never an endpoint, credential, or raw
 * HTTP detail. If authorization or endpoint configuration is no longer in place while this
 * module was tracking `verifying`/`reachable`/`unavailable`/`safe_failure`, this call
 * self-heals that stale tracking back to `ready_to_verify` before reporting the unmet
 * precondition — a "reachable" result from a now-revoked authorization/endpoint can no longer
 * be trusted.
 */
export function getApiServerVerificationState(): HermesApiServerState {
  const precondition = currentPreconditionState();
  if (precondition) {
    if (ambientState !== "ready_to_verify") resetToReadyToVerify();
    return { state: precondition };
  }
  return { state: ambientState };
}

/**
 * The single explicit, user-initiated verification attempt. Never automatic, never retried in a
 * loop, never polled. Re-validates every precondition immediately before any network use (not
 * merely trusting a prior read); a duplicate call while one is already in flight is safely
 * reduced to the current `verifying` state rather than starting a second request. Sends exactly
 * one `GET <origin>/health` — no body, no query string, no `Authorization` header (see this
 * file's own header for why), no redirect following, no cookies.
 */
export async function verifyApiServerConnection(): Promise<HermesApiServerResult> {
  const precondition = currentPreconditionState();
  if (precondition) return { state: precondition };

  if (verifyInFlight) {
    return { state: "verifying" };
  }

  const endpoint = getConfiguredEndpoint() ?? resolveTrustedEndpoint();
  if (endpoint.kind !== "trusted") {
    // Re-checked defensively — currentPreconditionState() above already covers this, but a
    // real network request is never sent on the strength of a single check alone.
    return { state: "endpoint_not_configured" };
  }
  // Re-checked for the same defensive reason; the credential itself is never attached to this
  // specific request (see module header), only required as an explicit precondition.
  if (getCurrentCredential() === null) {
    return { state: "not_authorized" };
  }

  verifyInFlight = true;
  const generationAtStart = ++generation;
  ambientState = "verifying";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

  try {
    const response = await fetch(`${endpoint.url.origin}/health`, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
    });
    clearTimeout(timer);
    verifyInFlight = false;
    if (generation !== generationAtStart) {
      // Superseded by clearApiServerVerification()/a later verify while this attempt was in
      // flight — never commit a now-stale result.
      return getApiServerVerificationState();
    }
    if (response.ok) {
      ambientState = "reachable";
      return { state: "reachable" };
    }
    ambientState = "safe_failure";
    return { state: "safe_failure" };
  } catch {
    clearTimeout(timer);
    verifyInFlight = false;
    if (generation !== generationAtStart) {
      return getApiServerVerificationState();
    }
    ambientState = "unavailable";
    return { state: "unavailable" };
  }
}

/**
 * Explicit, immediate, idempotent cross-module cleanup hook — called from
 * electron/main.ts on clear-authorization, clear-endpoint-configuration, and app before-quit,
 * mirroring every prior phase's own established composition pattern. Safe to call whether or
 * not a verification is currently in flight or has ever run.
 */
export function clearApiServerVerification(): HermesApiServerResult {
  resetToReadyToVerify();
  const precondition = currentPreconditionState();
  if (precondition) return { state: precondition };
  return { state: "ready_to_verify" };
}
