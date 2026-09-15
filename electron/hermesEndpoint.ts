/**
 * Main-process-only, fail-closed Hermes trusted-endpoint resolution boundary —
 * VYRON_CODE_V02_D08C_CHECKPOINT_AND_TRUSTED_HERMES_ENDPOINT_BOUNDARY_AUTHORIZATION.
 *
 * This module answers exactly one question — "is there a main-process-owned, policy-compliant
 * Hermes endpoint to connect to?" — and nothing else. It does NOT open a network connection,
 * does NOT perform DNS/TCP/HTTP/WebSocket activity, and does NOT read `process.env`, a real
 * `.env.local` value, an OS setting, browser storage, a keychain, or a real running Hermes
 * server. `resolveTrustedEndpoint()` — the one function electron/hermesConnection.ts actually
 * calls — has, in this build, no candidate source to consult at all, and therefore always
 * returns the safe `{kind:"unavailable", reason:"not_configured"}` result. This is the
 * disclosed, correct, fail-closed behavior this authorization requires, not a bug.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * WHY NO REAL ENDPOINT SOURCE IS WIRED UP YET (future source policy decision)
 * ════════════════════════════════════════════════════════════════════════════════════
 * This authorization required evaluating six candidate future endpoint sources rather than
 * assuming one. The full comparison lives in this task's own
 * VYRON_CODE_V02_D08C_TRUSTED_ENDPOINT_BOUNDARY_REPORT.md; the short version:
 *
 *   A. Compile-time immutable app-owned endpoint — lowest renderer-manipulation/SSRF risk of
 *      any option, but commits shipped source to one specific host/port with no user recourse
 *      if wrong, and this repository's own local-dev history shows the real Hermes port has
 *      already changed at least once — a real, not hypothetical, risk of silently targeting a
 *      stale or wrong service. RECOMMENDED as the next step once a specific, stable, packaged-
 *      build Hermes deployment target is chosen — but that choice is a product decision this
 *      task is not authorized to make unilaterally.
 *   B. First-run setup UI — needs its own separately authorized UX design (explicit user
 *      consent point, validation UI, error states) — out of this task's scope.
 *   C. Project-local non-secret config file — needs a packaging decision (where the file lives
 *      in a packaged app, who writes it) — out of this task's scope.
 *   D. Environment configuration — explicitly forbidden by this authorization for D-08C.
 *   E. OS-managed configuration — highest implementation/testing complexity, no clear benefit
 *      over B for a single-user desktop app — not recommended.
 *   F. No connection capability until a packaged trusted endpoint exists — this is exactly
 *      this module's own current behavior: `resolveTrustedEndpoint()` always reports
 *      `not_configured`, and its only caller (electron/hermesConnection.ts) already handles
 *      that as a normal, safe, fully tested outcome.
 *
 * `validateEndpointCandidate` below is the complete, fully tested policy-enforcement engine a
 * future Option A/B/C implementation would call with a REAL candidate — it exists and is
 * tested now (with fake/sample values only, per this authorization's own requirement) so that
 * wiring in a real source later is a small, low-risk change to `resolveTrustedEndpoint` alone,
 * not a new security review of validation logic written under time pressure then.
 *
 * Never imported by anything renderer-reachable (electron/preload.ts, electron/renderer.ts,
 * electron/shared-ipc-contract.ts) — this module and its `URL`-carrying `HermesTrustedEndpoint`
 * type exist only on the main-process side of electron/hermesConnection.ts, which itself never
 * forwards a `URL`/host/port value into any IPC response (see hermesConnection.ts).
 */

/**
 * The exact, narrow input shape a future trusted-endpoint source would need to produce.
 * Intentionally has no token/credential field — this boundary is endpoint-identity only, never
 * involved in the D-08B authorization credential in any way.
 */
export interface HermesEndpointCandidate {
  readonly endpointId: string;
  readonly url: string;
  readonly hostPolicy: "loopback-only" | "explicit-approved-host";
}

/**
 * The only two outcomes any caller of this module may ever see. `kind: "trusted"` is the sole
 * shape allowed to reach electron/hermesConnection.ts as a real, usable endpoint — and even
 * then, this task does not authorize actually connecting to it (see hermesConnection.ts's own
 * header for why `connect()` still cannot reach `"connected"`).
 */
export type HermesTrustedEndpoint =
  | {
      readonly kind: "trusted";
      readonly transport: "wss" | "ws";
      readonly hostPolicy: "loopback-only" | "explicit-approved-host";
      readonly endpointId: string;
      readonly url: URL;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: "not_configured" | "policy_rejected" | "invalid_configuration";
    };

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function unavailable(reason: "not_configured" | "policy_rejected" | "invalid_configuration"): HermesTrustedEndpoint {
  return { kind: "unavailable", reason };
}

function isValidShape(candidate: unknown): candidate is HermesEndpointCandidate {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return false;
  const c = candidate as Record<string, unknown>;
  if (typeof c.endpointId !== "string" || c.endpointId.length === 0) return false;
  if (typeof c.url !== "string" || c.url.length === 0) return false;
  if (c.hostPolicy !== "loopback-only" && c.hostPolicy !== "explicit-approved-host") return false;
  return true;
}

/**
 * The complete, reusable policy-enforcement core — pure and synchronous, performs no I/O of
 * any kind (no DNS, no TCP, no HTTP, no WebSocket, no file/environment read). `approvedHosts`
 * exists only so this function's `"explicit-approved-host"` branch is independently testable
 * with fake values; production code (`resolveTrustedEndpoint` below) never supplies a
 * non-empty list, since no host is approved in this build — that branch therefore always
 * rejects in real use today, by design (fail closed).
 *
 * Rejects, in order: an absent candidate (`not_configured`); a wrong-shaped candidate or an
 * unparseable/empty-host URL (`invalid_configuration`); and every remaining policy violation —
 * unsupported scheme, URL userinfo, a query string, a fragment, or a host the declared policy
 * does not trust (`policy_rejected`). A query string is rejected unconditionally, regardless
 * of policy, since it is exactly where a token could otherwise be smuggled into a "trusted"
 * endpoint definition.
 */
export function validateEndpointCandidate(candidate: unknown, approvedHosts: readonly string[] = []): HermesTrustedEndpoint {
  if (candidate === undefined || candidate === null) return unavailable("not_configured");
  if (!isValidShape(candidate)) return unavailable("invalid_configuration");

  let parsed: URL;
  try {
    parsed = new URL(candidate.url);
  } catch {
    return unavailable("invalid_configuration");
  }

  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return unavailable("policy_rejected");
  // WHATWG URL parsing rejects an empty host for the `ws:`/`wss:` special schemes at
  // construction time (the `try`/`catch` above already turns that into
  // `invalid_configuration`); this check remains as explicit, defensive belt-and-suspenders
  // documentation of the same fail-closed requirement, not because it is reachable today.
  if (parsed.hostname === "") return unavailable("invalid_configuration");
  if (parsed.username !== "" || parsed.password !== "") return unavailable("policy_rejected");
  if (parsed.search !== "") return unavailable("policy_rejected");
  if (parsed.hash !== "") return unavailable("policy_rejected");

  if (candidate.hostPolicy === "loopback-only") {
    if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) return unavailable("policy_rejected");
  } else {
    if (!approvedHosts.includes(parsed.hostname)) return unavailable("policy_rejected");
  }

  return {
    kind: "trusted",
    transport: parsed.protocol === "wss:" ? "wss" : "ws",
    hostPolicy: candidate.hostPolicy,
    endpointId: candidate.endpointId,
    url: parsed,
  };
}

/**
 * The one function electron/hermesConnection.ts actually calls. No candidate source exists in
 * this build (see module header) — never reads `process.env`, a file, or anything else — so
 * this always resolves through the same `not_configured` path `validateEndpointCandidate`
 * already handles for an absent candidate. One code path for "no configuration," not two
 * divergent implementations.
 */
export function resolveTrustedEndpoint(): HermesTrustedEndpoint {
  return validateEndpointCandidate(undefined);
}
