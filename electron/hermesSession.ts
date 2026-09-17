/**
 * Main-process-only Hermes session lifecycle service —
 * VYRON_CODE_V02_D10_EXPLICIT_HERMES_SESSION_CREATION_AUTHORIZATION.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * PROTOCOL DISCOVERY — EXACTLY WHAT EVIDENCE AUTHORIZES THIS, AND WHY NO WORKSPACE DATA CROSSES
 * ════════════════════════════════════════════════════════════════════════════════════
 * This task's own authorization requires that no session method/field/payload be invented, and
 * that real session creation not be implemented at all unless a minimal, workspace-data-free
 * invocation can be proven from existing repository evidence. That evidence was found:
 *
 *   `app/api/hermes/session/route.ts` (the only existing session.create call site) always
 *   sends `{ cwd: project.canonicalRoot }` — but that is THIS PROJECT'S OWN CHOICE, not a
 *   protocol requirement. `VYRON_CODE_V0_DISCOVERY.md`'s own source-verified finding (against
 *   Hermes Agent's real `methods_session.py` `session.create` handler) states: `cwd` is read via
 *   `params.get("cwd")` — Python's dict.get with no default, i.e. `None` when the key is simply
 *   absent — and is "only treated as an 'explicit workspace' if `os.path.isdir(...)` on that
 *   resolved path succeeds — otherwise the session falls back to 'No workspace' (launch-dir
 *   fallback)." An entirely empty `session.create` params object is therefore a genuine,
 *   protocol-supported, already-documented minimal invocation — not an invented one — and it
 *   carries no workspace canonical root, no absolute path, and no other client data at all.
 *
 *   `session.activate` (called in `route.ts` as `{ session_id: created.session_id }`) and
 *   `session.interrupt` (called in `app/api/hermes/interrupt/route.ts` as
 *   `{ session_id: session.hermesSessionId }`) independently prove the exact same convention:
 *   every session-scoped method beyond `session.create` itself takes only the server-issued
 *   opaque `session_id` — never a client-chosen value, never workspace/path/task/context data.
 *   `session.close` reuses that identical, twice-proven shape; its method NAME is itself
 *   source-verified as a real, registered `tui_gateway` method in `VYRON_CODE_V0_DISCOVERY.md`'s
 *   own method inventory, even though no existing call site exercises it — the shape is not
 *   guessed, only the specific choice to call it at all for a clean explicit close.
 *
 *   No model/provider is ever selected by this module — whatever `session.create` returns for
 *   `info.model` (per `VYRON_CODE_V01_API_AND_DATA_MODEL.md`'s documented response shape) is the
 *   server's own default for a workspace-less session, never read, chosen, or forwarded here.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS MODULE OWNS, AND WHAT NEVER CROSSES INTO IT
 * ════════════════════════════════════════════════════════════════════════════════════
 * Private module-scope state only: the safe ambient lifecycle state, and the opaque
 * server-issued `session_id` (needed only to send `session.activate`/`session.close` — never
 * exported, logged, or returned to the renderer by any function here). No task draft, task
 * profile, context item, file/search/Git data, workspace path, credential, endpoint, or raw
 * transport/protocol object is ever read by this module — it has no import capable of reaching
 * any of them (see the import list below: only the three existing, already-reviewed Hermes
 * services this module needs to re-validate its own preconditions and forward exactly two
 * closed-vocabulary RPC calls).
 *
 * Depends one-way on electron/hermesAuthorization.ts, electron/hermesEndpointSetup.ts,
 * electron/hermesEndpoint.ts (all for precondition re-validation only), and
 * electron/hermesConnection.ts (for `getConnectionState()`/`callSessionMethod()`). None of
 * those four modules import this one — electron/main.ts is the sole orchestrator of any
 * cross-module cleanup composition (mirroring the existing "clearing auth/endpoint also
 * disconnects" pattern, extended one step further to "...also clears the session").
 *
 * `getSessionState()` is also a self-healing precondition check: if authorization, endpoint
 * configuration, or the connection itself is no longer in place, any locally-tracked session
 * can no longer be genuinely active server-side (the underlying connection through which
 * session.close could even be attempted is already gone) — this function corrects its own
 * internal state back to `no_session` as a side effect of noticing that, rather than reporting
 * a stale `active`. `clearSession()` (called explicitly from main.ts on disconnect/clear-auth/
 * clear-endpoint/before-quit) provides the same guarantee immediately and explicitly, matching
 * this codebase's established preference for grep-verifiable, explicit compositions over
 * relying on lazy self-healing alone.
 */
import type { HermesSessionResult, HermesSessionState } from "./shared-ipc-contract";
import { getAuthorizationState } from "./hermesAuthorization";
import { resolveTrustedEndpoint } from "./hermesEndpoint";
import { getConfiguredEndpoint } from "./hermesEndpointSetup";
import { getConnectionState, callSessionMethod } from "./hermesConnection";

type SessionAmbientState = "no_session" | "creating" | "active" | "closing" | "closed" | "safe_failure";

// Module-scope, process-memory-only. `activeHermesSessionId` is the one opaque, server-issued
// identifier this module ever holds — never exported, logged, or included in any IPC-returned
// value; needed only to address the one `session.activate` and, later, one `session.close` call
// this session's own lifecycle requires.
let ambientState: SessionAmbientState = "no_session";
let activeHermesSessionId: string | null = null;

/** Bounds createSession() to exactly one attempt in flight at a time. */
let createInFlight = false;

/** Monotonic generation counter — the same T-17-style guard used throughout this codebase's
 * other Hermes services. A createSession() call already in flight when closeSession()/
 * clearSession() runs (or a later createSession() call starts) safely discards its own result
 * instead of committing a now-stale "active" state. */
let generation = 0;

/** Re-validates all three D-10 preconditions fresh, every time — never cached. Returns `true`
 * only when authorization, endpoint configuration, AND the connection itself are all currently
 * in place. */
function preconditionsSatisfied(): boolean {
  if (getAuthorizationState().state !== "authorized_memory_only") return false;
  const endpoint = getConfiguredEndpoint() ?? resolveTrustedEndpoint();
  if (endpoint.kind !== "trusted") return false;
  if (getConnectionState().state !== "connected") return false;
  return true;
}

/** Forces the tracked state back to `no_session` — used both by the self-healing precondition
 * check below and by the explicit `clearSession()` export. */
function resetToNoSession(): void {
  generation++;
  activeHermesSessionId = null;
  createInFlight = false;
  ambientState = "no_session";
}

/**
 * The only safe, renderer-facing session state — never a session id or raw response. If any of
 * the three upstream preconditions (authorization, endpoint, connection) is no longer satisfied
 * while a session was locally tracked as creating/active/closing, this call self-heals that
 * stale tracking back to `no_session` before reporting `unavailable` — the actual server-side
 * session (if any) is unreachable through a connection that no longer exists, so it can never
 * genuinely still be "active" from this app's own perspective.
 */
export function getSessionState(): HermesSessionState {
  if (!preconditionsSatisfied()) {
    if (ambientState !== "no_session" && ambientState !== "closed") {
      resetToNoSession();
    }
    return { state: "unavailable" };
  }
  return { state: ambientState };
}

/**
 * The single explicit, user-initiated session-create attempt. Never automatic. Re-validates
 * every precondition immediately before any transport use (not merely trusting a prior read),
 * rejects a second concurrent call while one is already in flight, and safely returns the
 * current state (never starts a second session) if one is already active. Sends exactly
 * `session.create` with an empty params object, then — only if that succeeds and returns a
 * `session_id` — exactly one `session.activate` addressed at that same id. See this file's own
 * header for the full evidence trail behind both calls' exact shape.
 */
export async function createSession(): Promise<HermesSessionResult> {
  if (!preconditionsSatisfied()) {
    if (ambientState !== "no_session" && ambientState !== "closed") resetToNoSession();
    return { state: "unavailable" };
  }
  if (ambientState === "active") {
    return { state: "active" };
  }
  if (createInFlight) {
    return { state: "safe_failure" };
  }

  createInFlight = true;
  const generationAtStart = ++generation;
  ambientState = "creating";

  const createOutcome = await callSessionMethod("session.create", {});
  if (generation !== generationAtStart) {
    // Superseded by closeSession()/clearSession()/a later createSession() while this attempt
    // was in flight — never commit a now-stale result.
    createInFlight = false;
    return getSessionState();
  }
  if (!createOutcome.ok || typeof createOutcome.result !== "object" || createOutcome.result === null) {
    createInFlight = false;
    ambientState = "safe_failure";
    return { state: "safe_failure" };
  }
  const sessionId = (createOutcome.result as { session_id?: unknown }).session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    createInFlight = false;
    ambientState = "safe_failure";
    return { state: "safe_failure" };
  }

  const activateOutcome = await callSessionMethod("session.activate", { session_id: sessionId });
  if (generation !== generationAtStart) {
    createInFlight = false;
    return getSessionState();
  }
  if (!activateOutcome.ok) {
    createInFlight = false;
    ambientState = "safe_failure";
    return { state: "safe_failure" };
  }

  activeHermesSessionId = sessionId;
  ambientState = "active";
  createInFlight = false;
  return { state: "active" };
}

/**
 * Explicit, idempotent close — safe to call whether or not a session is currently active. Sends
 * a best-effort `session.close` addressed at the tracked id (its outcome is not surfaced; the
 * local state clear below is authoritative regardless, mirroring hermesConnection.ts's own
 * disconnect() tolerance for an already-gone remote peer), then always clears local state.
 */
export async function closeSession(): Promise<HermesSessionResult> {
  if (ambientState !== "active" || activeHermesSessionId === null) {
    if (ambientState !== "no_session" && ambientState !== "closed") resetToNoSession();
    return { state: "no_session" };
  }

  const sessionId = activeHermesSessionId;
  generation++;
  ambientState = "closing";
  await callSessionMethod("session.close", { session_id: sessionId });
  activeHermesSessionId = null;
  ambientState = "closed";
  return { state: "closed" };
}

/**
 * Immediate, synchronous, idempotent cross-module cleanup hook — called only from
 * electron/main.ts, never from within this module's own createSession()/closeSession() (those
 * already clear their own state on every path). Mirrors hermesConnection.ts's disconnect()
 * pattern exactly: bumps the generation counter so any in-flight createSession() is provably
 * superseded, and resets to `no_session` regardless of the current state.
 */
export function clearSession(): HermesSessionResult {
  resetToNoSession();
  return { state: "no_session" };
}
