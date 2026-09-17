/**
 * Main-process-only, fail-closed Hermes API Server trusted-endpoint resolution boundary —
 * originally VYRON_CODE_V02_D08C_CHECKPOINT_AND_TRUSTED_HERMES_ENDPOINT_BOUNDARY_AUTHORIZATION,
 * re-scoped by VYRON_CODE_V02_D10_API_SERVER_REMEDIATION_AUTHORIZATION away from the Hermes
 * dashboard-internal WebSocket surface (`/api/ws`) onto the officially documented Hermes API
 * Server (an OpenAI-compatible HTTP surface — see `electron/hermesApiServer.ts`'s own header
 * for the full evidence trail: official Hermes Agent docs and source establish that `/api/ws`
 * is internal to the dashboard/TUI process and is not a supported external-client integration
 * point, while the separate API Server is explicitly documented for third-party frontends).
 *
 * This module still answers exactly one question — "is there a main-process-owned,
 * policy-compliant Hermes API Server endpoint to verify against?" — and nothing else. It does
 * NOT open a network connection, does NOT perform DNS/TCP/HTTP activity, and does NOT read
 * `process.env`, a real `.env.local` value, an OS setting, browser storage, a keychain, or a
 * real running Hermes server. `resolveTrustedEndpoint()` — the one function
 * electron/hermesApiServer.ts actually calls — has, in this build, no candidate source to
 * consult at all, and therefore always returns the safe `{kind:"unavailable",
 * reason:"not_configured"}` result, exactly as before this re-scoping.
 *
 * Never imported by anything renderer-reachable (electron/preload.ts, electron/renderer.ts,
 * electron/shared-ipc-contract.ts) — this module and its `URL`-carrying `HermesTrustedEndpoint`
 * type exist only on the main-process side of electron/hermesApiServer.ts, which itself never
 * forwards a `URL`/host/port value into any IPC response (see hermesApiServer.ts).
 */

/**
 * The exact, narrow input shape a future trusted-endpoint source would need to produce.
 * Intentionally has no token/credential/API-key field — this boundary is endpoint-identity
 * only, never involved in the D-08B authorization credential (reused as the API_SERVER_KEY
 * holder — see electron/hermesAuthorization.ts) in any way.
 */
export interface HermesEndpointCandidate {
  readonly endpointId: string;
  readonly url: string;
  readonly hostPolicy: "loopback-only" | "explicit-approved-host";
}

/**
 * The only two outcomes any caller of this module may ever see. `kind: "trusted"` is the sole
 * shape allowed to reach electron/hermesApiServer.ts as a real, usable endpoint.
 */
export type HermesTrustedEndpoint =
  | {
      readonly kind: "trusted";
      readonly transport: "http";
      readonly hostPolicy: "loopback-only" | "explicit-approved-host";
      readonly endpointId: string;
      readonly url: URL;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: "not_configured" | "policy_rejected" | "invalid_configuration";
    };

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * D-10 remediation: the official Hermes API Server base is documented as `http://<host>:<port>`
 * (optionally with a trailing `/v1` for the OpenAI-compatible surface itself) — never a deeper
 * or unrelated path. `electron/hermesApiServer.ts`'s own liveness probe always targets the
 * fixed `/health` path at the endpoint's origin regardless of which of these the user enters,
 * so only these three shapes are accepted as a well-formed API Server base.
 */
const ALLOWED_PATHNAMES = new Set(["", "/", "/v1"]);

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
 * any kind (no DNS, no TCP, no HTTP). `approvedHosts` exists only so this function's
 * `"explicit-approved-host"` branch is independently testable with fake values; production code
 * (`resolveTrustedEndpoint` below) never supplies a non-empty list, since no host is approved in
 * this build — that branch therefore always rejects in real use today, by design (fail closed).
 *
 * Rejects, in order: an absent candidate (`not_configured`); a wrong-shaped candidate or an
 * unparseable/empty-host URL (`invalid_configuration`); and every remaining policy violation —
 * unsupported scheme (only `http:` is accepted — the officially documented API Server scheme;
 * see this module's own header), URL userinfo, a query string, a fragment, a disallowed
 * pathname (must be empty, `/`, or `/v1` — see `ALLOWED_PATHNAMES` above), a missing/zero port,
 * or a host the declared policy does not trust (`policy_rejected`). A query string is rejected
 * unconditionally, regardless of policy, since it is exactly where a credential could otherwise
 * be smuggled into a "trusted" endpoint definition.
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

  if (parsed.protocol !== "http:") return unavailable("policy_rejected");
  // WHATWG URL parsing rejects an empty host for the `http:` special scheme at construction
  // time (the `try`/`catch` above already turns that into `invalid_configuration`); this check
  // remains as explicit, defensive belt-and-suspenders documentation of the same fail-closed
  // requirement, not because it is reachable today.
  if (parsed.hostname === "") return unavailable("invalid_configuration");
  if (parsed.username !== "" || parsed.password !== "") return unavailable("policy_rejected");
  if (parsed.search !== "") return unavailable("policy_rejected");
  if (parsed.hash !== "") return unavailable("policy_rejected");
  if (parsed.port === "" || parsed.port === "0") return unavailable("invalid_configuration");
  if (!ALLOWED_PATHNAMES.has(parsed.pathname)) return unavailable("policy_rejected");

  if (candidate.hostPolicy === "loopback-only") {
    if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) return unavailable("policy_rejected");
  } else {
    if (!approvedHosts.includes(parsed.hostname)) return unavailable("policy_rejected");
  }

  return {
    kind: "trusted",
    transport: "http",
    hostPolicy: candidate.hostPolicy,
    endpointId: candidate.endpointId,
    url: parsed,
  };
}

/**
 * The one function electron/hermesApiServer.ts actually calls. No candidate source exists in
 * this build (see module header) — never reads `process.env`, a file, or anything else — so
 * this always resolves through the same `not_configured` path `validateEndpointCandidate`
 * already handles for an absent candidate. One code path for "no configuration," not two
 * divergent implementations.
 */
export function resolveTrustedEndpoint(): HermesTrustedEndpoint {
  return validateEndpointCandidate(undefined);
}
