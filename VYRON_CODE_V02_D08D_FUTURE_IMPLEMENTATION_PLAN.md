# VYRON_CODE_V02_D08D_FUTURE_IMPLEMENTATION_PLAN

Planning document only. Nothing in this document is implemented by this task. Every future authorization referenced here is a distinct, separate, not-yet-requested authorization. No hostname, port, URL, environment key, certificate, or token value is fabricated anywhere below — every example is explicitly a placeholder.

## Plan for the recommended model — Option B (main-process-only explicit setup)

### Main-process ownership model

A new main-process-only module (name illustrative only, e.g. `electron/hermesEndpointSetup.ts`) would own a single, revocable, in-memory (pending the persistence decision below) "configured candidate" — mirroring `electron/hermesAuthorization.ts`'s own `authorizedCredential` module-scope-variable pattern exactly. It would call the *already-implemented, already-tested* `validateEndpointCandidate` from `electron/hermesEndpoint.ts` unchanged — no new validation logic, only a new *source* of the candidate that function already accepts.

### Proposed internal endpoint configuration data shape

Reuses the existing, already-implemented `HermesEndpointCandidate` shape unchanged:

```ts
interface HermesEndpointCandidate {
  readonly endpointId: string;      // a user- or app-assigned label, never derived from the URL
  readonly url: string;             // e.g. "ws://127.0.0.1:<user-entered-port>/api/ws" — illustrative only
  readonly hostPolicy: "loopback-only" | "explicit-approved-host";
}
```

No new field is proposed. In particular, no token/credential field is added here — the D-08B credential boundary remains entirely separate.

### Proposed renderer-visible safe state shape

A new enum, distinct from `HermesConnectionAmbientState`, e.g.:

```ts
type HermesEndpointSetupState =
  | "not_configured"
  | "setup_open"
  | "validating"
  | "configured"
  | "invalid"
  | "cleared";
```

The renderer would never receive `url`, `host`, `port`, or `hostPolicy` — only this state enum, exactly matching the pattern `HermesAuthorizationState`/`HermesConnectionState` already establish. A safe, non-sensitive `endpointId` label *may* be shown to the renderer only if a future, separate product decision explicitly approves it (per this task's own decision criteria, item 2) — not decided here.

### Proposed explicit user consent point

A dedicated "Configure Hermes endpoint" action, entered only after explicit user intent (never automatic, never triggered by opening the app) — mirroring D-08B's "Authorize Hermes for this session" button pattern. The form would collect only what the user can actually know: at minimum a port number (the host stays fixed to loopback in the UI itself, not just in the validator, so the user is never even shown a host field to edit under normal operation).

### Proposed endpoint lifecycle

```
absent          → no candidate has ever been submitted (matches today's "not_configured")
configured      → a candidate was submitted and passed validateEndpointCandidate → kind:"trusted"
approved        → (only if a future stage adds a distinct approval step beyond submission itself)
revoked         → user explicitly cleared it
invalid         → a submitted candidate failed validateEndpointCandidate
unavailable     → no candidate exists / validation not attempted yet
connection-ready → configured AND D-08B authorization is also valid (mirrors the existing
                   `ready_to_connect` gate in electron/hermesConnection.ts)
```

`electron/hermesConnection.ts`'s `connect()` would then call this new module's own "get the current configured candidate, if any" accessor instead of always calling `resolveTrustedEndpoint()` with no candidate — the very last line of that function (`return validateEndpointCandidate(undefined);`) is precisely the one-line change this future stage would touch, changing `undefined` to "whatever the setup module currently holds, or `undefined` if nothing was ever configured." No other part of the already-committed boundary changes.

### Endpoint validation rules / URL scheme / userinfo / query / fragment rules / host policy / port policy

**Unchanged — already fully implemented and tested** in `electron/hermesEndpoint.ts`'s `validateEndpointCandidate`: `ws`/`wss` scheme only; no userinfo; no query string; no fragment; `loopback-only` hostname allowlist (`127.0.0.1`, `localhost`, `::1`, `[::1]`); `explicit-approved-host` policy available but only meaningful once a future, separate decision defines a non-empty approved-hosts list (not proposed here — no such list has evidence to justify it, per the option matrix). Port itself carries no *additional* validation beyond what a syntactically valid URL already requires — no new port-range/allowlist rule is proposed unless a future review finds a specific need.

### TLS/WSS requirements

None can be added by Vyron Code Desktop alone — the protocol itself is plain `ws://` only, confirmed by evidence (see the decision record). This future stage would accept `wss://` in the schema (already accepted by the existing validator) purely for forward compatibility, without claiming Hermes itself supports it today.

### Server identity requirements

**Explicitly accepted residual risk (T-15)** — see the decision record's own dedicated section. No server-identity check is proposed for this future stage; none is possible without a Hermes Agent protocol change outside this repository's control.

### Connection timeout requirements

Not applicable to *this* future stage (endpoint configuration, not connection) — remains the responsibility of whichever future, separately authorized stage first opens a real socket. Not decided or estimated here.

### Disconnect/revoke rules

An explicit "Clear Hermes endpoint" action, immediate and idempotent — mirroring `hermesAuthorization.ts`'s `clearAuthorization()` exactly. Clearing the endpoint configuration should also supersede any in-flight `connect()` attempt, exactly like the existing `disconnect()`/`clearAuthorization()` interaction already implemented for the credential boundary.

### Error classification rules

Reuses the existing `HermesTrustedEndpoint`'s three `unavailable` reasons (`not_configured`, `invalid_configuration`, `policy_rejected`) unchanged — the renderer would map each to a fixed, safe, generic message exactly as `renderHermesPanel`'s `safe_failure` case already does for authorization failures. No new reason category is proposed unless implementation reveals a real need.

### Logging/redaction policy

Unchanged from every existing Hermes-related module in this codebase: no `console.*` call anywhere touching the candidate URL/host/port; only fixed, safe literal strings ever reach a log or the renderer. A dedicated structural test (mirroring the existing `hermesEndpoint.ts`/`hermesAuthorization.ts` module-boundary scans) would assert this directly, not merely by convention.

### Test fixture design

Fake candidate objects only, exactly matching this task's own predecessor pattern (`tests/electronHermesEndpoint.test.ts`'s `FAKE_LOOPBACK_CANDIDATE`) — never a real port, never a real running service, never a real network call. New tests would cover: setup-flow state transitions, the "clear also invalidates in-flight connect" race (T-17-style, reusing the existing generation-counter pattern), and renderer-reachability (the new setup module must never be importable from `preload.ts`/`renderer.ts`/`shared-ipc-contract.ts` directly — only its safe state type would be).

### Security scans

The full existing scan suite from D-08C/D-08D's own checkpoints, unchanged in kind: secret scan, credential-leak scan, credential-persistence absence scan, environment-access absence scan, endpoint-renderer-supply/exposure scans, network/WebSocket absence scan (still zero real network activity — this stage still does not open a connection), generic-IPC absence scan, `git diff --check`.

### Acceptance criteria

All new tests pass; all existing tests (421 as of this task) remain green; the endpoint value never appears in any renderer-reachable file, log, or report; `connect()` still cannot reach `"connected"` in this stage (that remains the *next* future stage's own, separately authorized scope).

### Exact scope of the later real-network authorization

A **distinct, later, separately authorized stage** would be required to: actually construct a `WebSocket`/`ws` client in `electron/hermesConnection.ts`, define connect/handshake timeouts and maximum inbound message size, define reconnect-prohibition enforcement (already implied but not yet code-enforced against a real socket), and re-examine T-15 once more with a real connection attempt possible. **This plan does not authorize that stage.**

---

## Plan for the strongest alternative — Option C (project-local non-secret config file)

Everything above under "Endpoint validation rules" through "Security scans" applies identically to Option C — it is the same `validateEndpointCandidate` engine, only fed by a different source. The differences are narrow:

### Main-process ownership model

A file-reading module (e.g. `electron/hermesEndpointConfig.ts`) would read a fixed, well-known, non-secret file path and parse it into a `HermesEndpointCandidate` before passing it to the unchanged validator. **The exact file path/location within a packaged Electron app (inside vs. outside the app's own install directory, "userData" path vs. project-relative) is an open packaging question this plan does not resolve** — it is exactly the gap the option matrix identifies as Option C's weakest point relative to B.

### Proposed explicit user consent point

Weaker than B by default — file presence alone would be treated as consent unless a future design explicitly adds a one-time "detected endpoint config — use it?" confirmation UI, which would itself start to resemble Option B's own consent screen.

### Proposed endpoint lifecycle

Identical to B's, with one addition: a `file_not_found` sub-case of `absent`, and a `file_unreadable`/`file_malformed` sub-case of `invalid`, both still mapping to the same existing `HermesTrustedEndpoint` reasons.

### What remains forbidden in the immediate next implementation stage (applies to both B and C)

```text
- Opening a real WebSocket/TCP/HTTP/DNS connection of any kind.
- A Hermes health check, session, prompt, context transfer, event stream,
  provider/model call, or multimodel operation.
- Any token/credential field on the endpoint candidate itself.
- Any environment-variable-sourced fallback.
- Any renderer-supplied endpoint value bypassing validateEndpointCandidate.
- Any non-empty explicit-approved-host allowlist without its own separate,
  evidence-based justification.
- Weakening contextIsolation/nodeIntegration/sandbox/webSecurity/webviewTag.
- Generic IPC, raw ipcRenderer, or EventEmitter exposure.
- Any change to the existing D-08B credential boundary's own guarantees.
```
