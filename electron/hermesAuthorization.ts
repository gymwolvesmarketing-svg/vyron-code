/**
 * Main-process-only, in-memory Hermes authorization boundary —
 * VYRON_CODE_V02_D08B_MEMORY_ONLY_HERMES_AUTHORIZATION_BOUNDARY_AUTHORIZATION.
 *
 * Owns exactly one thing: a single, process-memory-only Hermes authorization credential,
 * accepted only through `beginAuthorization`'s single narrow request shape, and cleared only
 * through `clearAuthorization` or process exit. This module deliberately imports nothing —
 * not `electron`, not any `node:*` built-in — because it has no need for a dialog, a
 * filesystem, a network client, or any Node API: the entire capability is "hold one string in
 * a private module-scope variable, validate it strictly, and let it go." That absence of
 * imports is itself part of this phase's own security boundary (see
 * tests/electronSecurityScaffold.test.ts's dedicated scan of this file), not an oversight.
 *
 * This phase does NOT open a Hermes connection, a WebSocket, or any HTTP/network request; does
 * NOT probe a health endpoint or accept a renderer-supplied host/port/URL; does NOT persist the
 * credential anywhere (no `safeStorage`, no OS keychain/Credential Manager, no file, no
 * `localStorage`/`sessionStorage`/IndexedDB/SQLite — none of those APIs are imported or
 * reachable from this module at all); does NOT read the credential from an environment
 * variable, command-line argument, config file, or clipboard; and NEVER logs the credential,
 * a length/prefix/suffix/hash derived from it, or any request payload. Every exported function
 * returns only a fixed, safe state string — never the credential itself, never a raw error.
 *
 * Independent-lifetime policy (D-08B, per the pre-existing D-08A security decision's own
 * requirement to document this choice explicitly): this module has NO relationship to
 * electron/workspace-grant.ts's workspace grant. Clearing the workspace grant never touches
 * Hermes authorization state, and clearing Hermes authorization never touches the workspace
 * grant — they are deliberately independent, separately revocable pieces of process-memory
 * state, each owned by its own module.
 *
 * Extended by VYRON_CODE_V02_D08E_CHECKPOINT_AND_D08F_EXPLICIT_HERMES_CONNECTIVITY_AUTHORIZATION
 * with `getCurrentCredential()` — a main-process-INTERNAL accessor, mirroring
 * electron/workspace-grant.ts's `getCurrentCanonicalRoot()` and
 * electron/hermesEndpointSetup.ts's `getConfiguredEndpoint()` exactly. The one intended caller
 * is electron/hermesConnection.ts, which needs the real credential to build the one documented
 * `/api/ws?token=...` connection URL (see hermesConnection.ts's own header for the full
 * evidence trail). This accessor is NEVER imported by electron/preload.ts and NEVER part of
 * any IPC-returned value — every guarantee in this file's own header (never persisted, never
 * logged, never returned to renderer) is unchanged by its existence, exactly as adding the
 * analogous accessors to the workspace-grant and endpoint-setup modules changed none of their
 * own guarantees either.
 */
import type { HermesAuthorizationRequest, HermesAuthorizationResult, HermesAuthorizationState, HermesAvailability } from "./shared-ipc-contract";

/** A generous, protocol-agnostic upper bound on credential length — a defensive input-size
 * limit only, not derived from or asserting anything about the real Hermes token format
 * (which this module has no knowledge of and never inspects). */
const MAX_CREDENTIAL_LENGTH = 4096;

// Module-scope, process-memory-only — intentionally never written to disk, SQLite,
// localStorage, safeStorage, or any other persistence mechanism. `null` means "not
// authorized"; any other value is held only for this process's lifetime.
let authorizedCredential: string | null = null;

/**
 * Monotonic generation counter — VYRON_CODE_V02_D08B's T-17 (stale/revoked authorization
 * state) mitigation. `clearAuthorization` increments this synchronously; `beginAuthorization`
 * captures the generation before its own explicit yield point and re-checks it immediately
 * after, so a `beginAuthorization` call already in flight when the user revokes can never
 * retroactively re-authorize the app after that revoke — it observes the generation change and
 * safely discards its own result instead of committing a credential.
 */
let generation = 0;

/**
 * Strictly validates an unknown, renderer-supplied request value before any part of it is
 * retained. Accepts only a plain object with exactly one own key, `credential`, whose value is
 * a non-empty, non-whitespace-only string within the bound above. Rejects everything else —
 * wrong type, `null`, an array, extra keys (which would otherwise be exactly how a renderer
 * could try to smuggle an endpoint/host/port/session field past this boundary — T-14), a
 * missing/non-string credential, an empty or whitespace-only credential, or an oversized one.
 */
function validateAuthorizationRequest(request: unknown): HermesAuthorizationRequest | null {
  if (typeof request !== "object" || request === null || Array.isArray(request)) return null;
  const keys = Object.keys(request as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "credential") return null;

  const credential = (request as Record<string, unknown>).credential;
  if (typeof credential !== "string") return null;
  if (credential.length === 0) return null;
  if (credential.trim().length === 0) return null;
  if (credential.length > MAX_CREDENTIAL_LENGTH) return null;

  return { credential };
}

/**
 * Reports only static, build-time capability state — never probes a network endpoint,
 * environment variable, or credential store of any kind. `available` here means only "this
 * memory-only authorization capability exists in this build," never "Hermes is reachable" or
 * "a credential is currently held" (use `getAuthorizationState` for the latter).
 */
export function getAvailability(): HermesAvailability {
  return { state: "available" };
}

/** Returns only the current ambient authorization state — never the credential itself. */
export function getAuthorizationState(): HermesAuthorizationState {
  return { state: authorizedCredential !== null ? "authorized_memory_only" : "not_authorized" };
}

/**
 * The single narrow credential-submission boundary. Validates the request, then — after an
 * explicit yield point that creates the real (not merely theoretical) race window the T-17
 * generation check below defends against — commits the credential to process memory only if
 * no `clearAuthorization` call has happened in the meantime. Never sends, parses, hashes, logs,
 * or persists the credential; never echoes it back in the result.
 */
export async function beginAuthorization(request: unknown): Promise<HermesAuthorizationResult> {
  const validated = validateAuthorizationRequest(request);
  if (!validated) return { state: "safe_failure" };

  const generationAtStart = generation;
  // Explicit yield point — gives a concurrent clearAuthorization() call a real opportunity to
  // run before this function commits its own result, rather than relying on an assumption that
  // no such race can occur.
  await Promise.resolve();

  if (generation !== generationAtStart) {
    // Superseded by a revoke while this request was in flight — must not retroactively
    // re-authorize the app after the user explicitly cleared it.
    return { state: "revoked" };
  }

  authorizedCredential = validated.credential;
  return { state: "authorized_memory_only" };
}

/**
 * Clears the private in-memory reference and bumps the generation counter so any
 * `beginAuthorization` call already in flight is provably superseded. Always safe to call
 * again on an already-cleared state (idempotent) and never touches the workspace grant.
 */
export function clearAuthorization(): HermesAuthorizationResult {
  authorizedCredential = null;
  generation++;
  return { state: "revoked" };
}

/**
 * Main-process-INTERNAL accessor for the raw credential — never exported to preload/renderer,
 * never part of any `HermesAuthorizationState`/`HermesAuthorizationResult`. Returns `null`
 * whenever `getAuthorizationState()` would report `not_authorized`, so callers never need a
 * separate check.
 */
export function getCurrentCredential(): string | null {
  return authorizedCredential;
}
