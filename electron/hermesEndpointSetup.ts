/**
 * Main-process-only, memory-only Hermes endpoint configuration service —
 * VYRON_CODE_V02_D08E_MEMORY_ONLY_HERMES_ENDPOINT_SETUP_AUTHORIZATION.
 *
 * Implements Option B from VYRON_CODE_V02_D08D_TRUSTED_ENDPOINT_SOURCE_DECISION.md: an
 * explicit, user-initiated, memory-only local Hermes endpoint. The user may submit exactly one
 * candidate endpoint string; it is validated entirely in this process, held only in a private
 * module-scope variable, and is cleared on explicit revoke or process exit. No persistence of
 * any kind — no `localStorage`/`sessionStorage`/IndexedDB/SQLite/JSON file/config file/
 * registry/preferences/`safeStorage`/keychain/Credential Manager/environment variable/command
 * line/clipboard is ever written to or read from by this module (none of those APIs are
 * imported or reachable — see the import list below, exactly two, both local).
 *
 * Reuses electron/hermesEndpoint.ts's `validateEndpointCandidate` UNCHANGED — no parallel or
 * weaker validation exists here. This module's own job is narrower: turn a renderer-submitted
 * raw request into the single `{endpointId, url, hostPolicy: "loopback-only"}` candidate shape
 * that validator already accepts, apply the two additional bounds this authorization's own
 * policy requires beyond that engine (a non-empty, non-zero port; a bounded path length), and
 * hold the result in memory. `hostPolicy` is always fixed to `"loopback-only"` here — Option B
 * never offers the user an `"explicit-approved-host"` choice, consistent with
 * VYRON_CODE_V02_D08D_ENDPOINT_SOURCE_OPTION_MATRIX.md's finding that no non-loopback Hermes
 * topology has any supporting evidence in this product's own documented scope.
 *
 * This module performs NO network activity of any kind — no DNS resolution, no TCP/HTTP/
 * WebSocket connection, no reachability probe. Validation is purely syntactic (URL parsing and
 * exact-string host-allowlist matching), which is also why encoded/trick IPv4 forms (hex,
 * octal, decimal, shorthand) are already handled safely without needing any of that: the
 * WHATWG `URL` parser itself normalizes them to a canonical dotted-decimal hostname *before*
 * this module's exact-match check ever runs (see electron/hermesEndpoint.ts's own tests for
 * confirmation this is not merely assumed) — a trick encoding of `127.0.0.1` still normalizes
 * to `127.0.0.1` and is correctly accepted as loopback; a trick encoding of anything else
 * normalizes to that other value and is correctly rejected for not matching the loopback set.
 *
 * Independent-lifetime policy: this module has no relationship to
 * electron/hermesAuthorization.ts's credential or electron/workspace-grant.ts's workspace
 * grant. Clearing the endpoint configuration never touches either; clearing the credential or
 * the workspace grant never touches this module. electron/hermesConnection.ts consumes this
 * module's `getConfiguredEndpoint()` directly (falling back to
 * electron/hermesEndpoint.ts's `resolveTrustedEndpoint()` when nothing is configured) — that
 * integration lives entirely in hermesConnection.ts, not here, so this module needs no
 * knowledge of authorization or connection state at all.
 */
import type { HermesEndpointConfigurationRequest, HermesEndpointConfigurationResult, HermesEndpointState } from "./shared-ipc-contract";
import { validateEndpointCandidate, type HermesTrustedEndpoint } from "./hermesEndpoint";

/** A generous but explicit bound on the raw submitted endpoint string, before it is ever
 * parsed as a URL — this authorization's own required "explicit bounded endpoint input
 * length" rule. */
const MAX_ENDPOINT_INPUT_LENGTH = 2048;

/** This authorization's own required "explicit bounded path length" rule, applied to the
 * parsed URL's pathname after validateEndpointCandidate already accepted it. Hostname length
 * needs no separate bound: hostPolicy is always "loopback-only" here, whose allowlist is a
 * fixed set of short literal strings — no hostname longer than that fixed set could ever match
 * it, so an explicit length check would be unreachable dead code, not a real protection. */
const MAX_PATH_LENGTH = 512;

/** A fixed, non-sensitive, app-assigned label — never derived from the submitted URL (which
 * would risk indirectly leaking host/port information through the label itself). */
const FIXED_ENDPOINT_ID = "desktop-configured-endpoint";

// Module-scope, process-memory-only. `null` means "not configured"; the one non-null value
// this module ever holds is always the `kind:"trusted"` variant already produced by
// validateEndpointCandidate — never the raw, unvalidated input string.
let configuredEndpoint: HermesTrustedEndpoint | null = null;

/** Monotonic generation counter — the same T-17-style guard hermesAuthorization.ts and
 * hermesConnection.ts already use. A configureEndpoint() call already in flight when
 * clearEndpointConfiguration() runs (or another configureEndpoint() call starts) safely
 * discards its own result instead of committing a now-superseded configuration. */
let generation = 0;

function isValidRequestShape(request: unknown): request is HermesEndpointConfigurationRequest {
  if (typeof request !== "object" || request === null || Array.isArray(request)) return false;
  const keys = Object.keys(request as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "endpoint") return false;
  const endpoint = (request as Record<string, unknown>).endpoint;
  if (typeof endpoint !== "string") return false;
  if (endpoint.length === 0 || endpoint.length > MAX_ENDPOINT_INPUT_LENGTH) return false;
  if (endpoint.trim().length === 0) return false;
  // Control characters — the same class of defensive check hermesAuthorization.ts's own
  // credential validation performs for its own input.
  if (/[\x00-\x1f\x7f]/.test(endpoint)) return false;
  return true;
}

/** Returns only the current safe ambient configuration state — never the endpoint itself. */
export function getEndpointConfigurationState(): HermesEndpointState {
  return { state: configuredEndpoint !== null ? "configured_memory_only" : "not_configured" };
}

/**
 * The single narrow endpoint-submission boundary. Validates the request shape, then the
 * candidate itself (via the unchanged, shared policy engine), then this authorization's own
 * two additional bounds (non-empty/non-zero port, bounded path length) — and commits only if
 * no clearEndpointConfiguration()/configureEndpoint() call has happened in the meantime. Never
 * echoes the submitted URL, or any component of it, back in the result.
 */
export async function configureEndpoint(request: unknown): Promise<HermesEndpointConfigurationResult> {
  try {
    if (!isValidRequestShape(request)) return { state: "invalid_configuration" };

    const result = validateEndpointCandidate({
      endpointId: FIXED_ENDPOINT_ID,
      url: request.endpoint,
      hostPolicy: "loopback-only",
    });

    if (result.kind !== "trusted") {
      return { state: result.reason === "policy_rejected" ? "policy_rejected" : "invalid_configuration" };
    }
    if (result.url.port === "" || result.url.port === "0") {
      return { state: "invalid_configuration" };
    }
    if (result.url.pathname.length > MAX_PATH_LENGTH) {
      return { state: "invalid_configuration" };
    }

    const generationAtStart = ++generation;
    // Explicit yield point — mirrors hermesAuthorization.ts's beginAuthorization() exactly,
    // giving a concurrent clearEndpointConfiguration() call a real opportunity to run before
    // this function commits its own result.
    await Promise.resolve();
    if (generation !== generationAtStart) {
      return { state: "cleared" };
    }

    configuredEndpoint = result;
    return { state: "configured_memory_only" };
  } catch {
    // Defensive only — validateEndpointCandidate never throws by its own contract, but this
    // still never leaks a raw error/stack, matching this codebase's established convention.
    return { state: "safe_failure" };
  }
}

/**
 * Clears the private in-memory reference and bumps the generation counter so any
 * configureEndpoint() call already in flight is provably superseded. Always safe to call
 * again on an already-cleared state (idempotent).
 */
export function clearEndpointConfiguration(): HermesEndpointConfigurationResult {
  generation++;
  configuredEndpoint = null;
  return { state: "cleared" };
}

/**
 * Main-process-INTERNAL accessor for the configured endpoint — mirroring
 * electron/workspace-grant.ts's `getCurrentCanonicalRoot()` pattern. NEVER imported by
 * electron/preload.ts and NEVER part of any IPC-returned value; the only intended caller is
 * electron/hermesConnection.ts. Returns the already-validated `HermesTrustedEndpoint` object
 * directly — no re-validation is needed, since nothing external (unlike a filesystem path)
 * could have changed underneath a plain in-memory string between configure-time and now.
 */
export function getConfiguredEndpoint(): HermesTrustedEndpoint | null {
  return configuredEndpoint;
}
