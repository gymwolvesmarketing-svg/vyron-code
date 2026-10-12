# VYRON_CODE_V02_D08D_TRUSTED_ENDPOINT_SOURCE_DECISION

Decision-record and threat-model refinement only. No source, test, package, lockfile, build, or configuration file was created, modified, or inspected for secret content in the production of this document. No network, Hermes, or process action of any kind was performed.

## The question this document answers

> What single trusted endpoint-source model, if any, should Vyron Code Desktop use before a later task is allowed to make real Hermes connectivity reachable?

## Decision

**Recommended: Option B — main-process-only, explicit first-run (or on-demand) endpoint setup, entered by the user and validated through the existing `validateEndpointCandidate` policy engine (already implemented and committed in `98048c3`).**

**Strongest alternative: Option C — a main-process-only, project-local, non-secret configuration file**, evaluated and rejected only because it defers rather than resolves the "who writes this file in a packaged app" packaging question that Option B's explicit UI sidesteps entirely.

**This task implements neither.** The immediate, unchanged state remains **Option F**: `electron/hermesEndpoint.ts`'s `resolveTrustedEndpoint()` continues to return `{kind:"unavailable", reason:"not_configured"}` unconditionally, exactly as committed in `98048c3`. No source file was touched to produce this decision.

## Why Option A (compile-time immutable endpoint) is not recommended — the decisive evidence

Option A was the front-runner in the prior task's own report (`VYRON_CODE_V02_D08C_TRUSTED_ENDPOINT_BOUNDARY_REPORT.md`), recommended "once a specific, stable, packaged-build Hermes deployment target is chosen." This task's own read-only evidence gathering found the opposite of what "stable" would require:

- **`HERMES_GATEWAY_START_REPORT.md`** (this repository's own, pre-existing report) states directly: *"`hermes serve`/`hermes dashboard` default to `127.0.0.1:9119`; `config.yaml` has no override for this port; the previously-working `9130` target was almost certainly an explicit `--port 9130` flag at original setup time, not a config default."*
- **`HERMES_TUI_GATEWAY_RUNTIME_RECONCILIATION_REPORT.md`** independently confirms the gateway process that was supposed to be listening on port 9130 had silently stopped running, with nothing automatically restarting it — evidence that even the *currently configured* value is not a reliably-running constant, let alone a safe one to hardcode into shipped source.
- `.env.local.example` (this repository's own committed template) ships with `HERMES_HOST=`/`HERMES_PORT=` **empty** — confirming no default value has ever been considered stable enough to check into this repository's own non-secret template, by this project's own prior authors.

Hardcoding a specific port into Electron main-process source would therefore be hardcoding a value already demonstrated, by this repository's own operational history, to be an ad-hoc local override rather than a product constant — exactly the failure mode Section 6's "Do not fabricate a hostname, port, URL..." instruction warns against, and exactly what the prior task's own report flagged as a real, not hypothetical, risk ("the Hermes port has already changed at least once").

## Why the host, specifically, is a different and much stronger case than the port

Unlike the port, the **host** portion of a Hermes endpoint has direct, repository-internal, protocol-level evidence supporting a fixed policy: `VYRON_CODE_V02_DESKTOP_MIGRATION_ARCHITECTURE_AUDIT.md` states, based on reading Hermes Agent's own protocol behavior (not assumed): *"Hermes Agent's own `tui_gateway` enforces `Origin`/`Host` headers matching `http://<host>:<port>` and requires a loopback peer (403 otherwise) — Hermes itself already assumes same-machine operation."* This is a **server-enforced** constraint, not a client convention Vyron Code Desktop chose — a non-loopback endpoint would be rejected by Hermes itself regardless of what Vyron Code Desktop attempted. The existing `electron/hermesEndpoint.ts`'s `"loopback-only"` host policy is therefore already the architecturally correct, evidence-supported choice for the host dimension of this decision, and this document does not propose changing it.

The **product's own explicit scope statement** reinforces this: `VYRON_CODE_V01_PRODUCT_BLUEPRINT.md` states plainly that "any multi-user/remote-access mode" is explicitly **NOT** in scope for this product. There is no confirmed evidence anywhere in this repository of a LAN-hosted, remote-hosted, or multi-tenant deployment intent for Hermes — every piece of evidence found points to a single-user, single-machine, developer-run companion-process model.

## Why Option B, specifically, over C, D, E, F (as a long-term direction)

- **D (environment configuration)** is explicitly forbidden by this task's own predecessor authorization for D-08C, and is furthermore *exactly* the model the pre-existing `VYRON_CODE_V02_DESKTOP_MIGRATION_ARCHITECTURE_AUDIT.md` already flagged as broken for a packaged app ("a packaged desktop app has no 'terminal the user launches it from' to set [a value] in").
- **E (OS-managed configuration)** has no supporting evidence of a multi-user/enterprise deployment need in this product, and carries the highest implementation/testing complexity of any option for no discernible benefit here.
- **C (config file)** is a real, viable alternative — see the full comparison in `VYRON_CODE_V02_D08D_ENDPOINT_SOURCE_OPTION_MATRIX.md` — but leaves "who writes the file, and how does the user discover that they need to" as an open packaging question that a first-run UI (B) answers directly and visibly, with an explicit consent point this task's own required decision criteria (Section 4, items 4–5) demand.
- **F (defer)** is not a rejection of B — it is simply *this task's own unchanged current state*, since no source implementation is authorized here.

Because the port genuinely varies by local setup (confirmed above) while the host is architecturally fixed to loopback (also confirmed above), **Option B is the model that correctly reflects reality**: it asks the user for the one value (the port, and optionally a non-default host override for a future non-loopback Hermes topology if one is ever product-approved) that is genuinely environment-specific, while the existing, already-implemented `validateEndpointCandidate` policy engine continues to enforce the loopback-only (or, if ever separately approved, explicit-approved-host) constraint regardless of what the user enters — so a wrong or malicious user-entered value still can never grant LAN/remote reach.

## T-15 (WebSocket server-identity confirmation) — explicit decision, not silent inheritance

The pre-existing threat model (`VYRON_CODE_V02_D08_HERMES_DESKTOP_THREAT_MODEL.md`) required D-08C (and, by extension, this endpoint-source decision) to make an *explicit* decision on T-15 rather than silently inherit it. The evidence found in this task:

- The Hermes protocol, as documented in `lib/hermesClient.ts`'s own header and confirmed by every prior report read in this task, is **plain `ws://` only** — no TLS/WSS, no certificate, no server-presented identity, no version/capability handshake exists anywhere in the documented protocol.
- The token in the existing protocol authenticates the **client to the server** (a URL query parameter the server checks) — it does **not** let the client authenticate the server. A different local process bound to the same loopback port before the real Hermes gateway starts could, in principle, impersonate it at the transport level.

**Decision: accept this as a disclosed, unresolved residual risk of the existing Hermes protocol, not something an endpoint-*source* decision inside Vyron Code Desktop can resolve.** No mitigation is available within Vyron Code Desktop's own control today, since it would require Hermes Agent's own protocol to add a server-identity mechanism — outside this repository's authority to change. This decision explicitly does **not** claim T-15 is resolved; it is accepted and documented so a future authorization inherits a stated position rather than silence. (`VYRON_CODE_V02_DESKTOP_ARCHITECTURE_DECISION.md`'s own Section 21 documents an analogous "loopback + per-launch shared secret" pattern already accepted for Vyron Code's *own* embedded server — a directionally similar idea that could someday be *proposed* to Hermes Agent's maintainers as a protocol enhancement, but that is outside this document's authority and is not proposed as a Vyron Code Desktop implementation item here.)

## What remains an unknown, not assumed

- Whether a future packaged release will ever need a non-loopback Hermes topology at all — no evidence found either way; the current product scope statement excludes it, so this document does not design for it.
- The exact UX copy/flow for a first-run endpoint-setup screen — a product/UX decision for the future implementation authorization, not decided here.
- Whether Hermes Agent's own maintainers would ever add a server-identity mechanism — outside this repository's control and not assumed.

See `VYRON_CODE_V02_D08D_ENDPOINT_SOURCE_OPTION_MATRIX.md` for the full six-option comparison and `VYRON_CODE_V02_D08D_FUTURE_IMPLEMENTATION_PLAN.md` for the detailed future plan for Options B and C.
