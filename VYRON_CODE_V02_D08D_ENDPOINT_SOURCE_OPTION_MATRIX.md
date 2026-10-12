# VYRON_CODE_V02_D08D_ENDPOINT_SOURCE_OPTION_MATRIX

Full comparison of all six required options. Each cell distinguishes **Confirmed** (direct repository evidence), **Reasoned** (a judgment call built on confirmed evidence, not itself directly evidenced), and **Unknown** (no evidence either way — not assumed).

## Shared, cross-option confirmed facts (apply to every option below)

- **Confirmed**: Hermes Agent's `tui_gateway` enforces a loopback-only peer and matching `Origin`/`Host` headers at the protocol level (`VYRON_CODE_V02_DESKTOP_MIGRATION_ARCHITECTURE_AUDIT.md`). A non-loopback endpoint would be rejected by Hermes itself.
- **Confirmed**: the protocol is plain `ws://` only — no TLS/WSS, no certificate, no server-identity mechanism exists (`lib/hermesClient.ts`, and no contradicting evidence found anywhere else in this repository).
- **Confirmed**: the real, product-default Hermes port is `9119`; this repository's own `.env.local` had been pointed at `9130` via an ad-hoc `--port` flag at an earlier manual setup, not a stable default (`HERMES_GATEWAY_START_REPORT.md`).
- **Confirmed**: this product's own scope statement explicitly excludes "any multi-user/remote-access mode" (`VYRON_CODE_V01_PRODUCT_BLUEPRINT.md`).
- **Confirmed**: the token authenticates the client to the server only; the server is never authenticated to the client by anything in the documented protocol.

---

## Option A — Compile-time immutable application-owned trusted endpoint

- **Evidence supporting**: lowest possible renderer-manipulation and SSRF-like risk of any option that adds real capability — the value never varies at runtime, so there is nothing for any process to manipulate.
- **Evidence against**: **Confirmed** — the port is demonstrated, by this repository's own operational history, to not be a stable default (`9119` real default vs. `9130` ad-hoc override, already once observed dead with nothing restarting it). Hardcoding it would hardcode a value already known to be wrong at least once.
- **Compatible with current Hermes deployment reality**: **Reasoned: no**, for the port dimension; **Reasoned: yes**, for the host dimension alone (loopback is architecturally forced by Hermes itself).
- **Renderer manipulation / renderer endpoint authority risk**: None — fixed at compile time.
- **Arbitrary endpoint / SSRF-like risk**: Lowest of any option with real capability.
- **Local malicious service impersonation risk**: Present regardless of option (inherent to a loopback-only, non-TLS protocol) — unaffected by this choice.
- **Remote endpoint spoofing risk**: None — never targets a remote host.
- **WebSocket server identity risk**: Unresolved (T-15), same as every option — see main decision record.
- **TLS/WSS requirements**: None exist in the protocol; not applicable.
- **Certificate trust/pinning implications**: None possible — no certificate exists.
- **Token leakage risk**: Unaffected by endpoint source choice.
- **Endpoint persistence implications**: None — baked into the binary, not "persisted" in the data sense.
- **Endpoint rotation/update implications**: **Confirmed problem** — rotation requires a new application build and release; cannot track a locally-changed port without shipping new source.
- **Local development ergonomics**: Poor — every local port change (already observed to happen) requires a source edit.
- **Packaged release ergonomics**: Simple, once a stable target is known — but none is known today.
- **Multi-environment / multi-user/tenant support**: Not applicable — one fixed value serves everyone identically, which is wrong the moment any user's local port differs (already the observed case in this repository's own history).
- **User consent clarity**: Implicit (the application simply is what it is) — no explicit consent point exists or is needed.
- **Revocation/removal behavior**: Not applicable — nothing to revoke.
- **Operational support burden**: **Reasoned: high** — every local Hermes port drift becomes a "the app doesn't work" support case with no user-facing fix.
- **Testability with fake values, no live network**: Trivial — a fixed value is the easiest of all options to test.
- **Required future authorization scope**: A specific, stable, packaged-build Hermes deployment target would need to be product-decided first — not decided by this document.

**Verdict: NOT RECOMMENDED.** The decisive, confirmed evidence (real default port ≠ configured port, already observed drift) directly contradicts the stability this option requires.

---

## Option B — Main-process-only explicit first-run endpoint setup

- **Evidence supporting**: **Confirmed** — this repository's own evidence shows the port genuinely varies by local setup; an explicit, main-process-owned entry point is the only option that correctly reflects that variability without granting the renderer any endpoint authority. The existing, already-implemented `validateEndpointCandidate` policy engine (committed in `98048c3`) is *already* the exact validation layer this option would call with a real candidate — no new security logic would need to be designed from scratch.
- **Evidence against**: needs its own UX design (explicit consent point, validation error states) not yet authorized.
- **Compatible with current Hermes deployment reality**: **Confirmed: yes** — directly matches the observed reality that the port varies while the host stays loopback-only.
- **Renderer manipulation / renderer endpoint authority risk**: Low — the renderer only ever *submits a candidate* through a narrow IPC method (mirroring D-08B's own `beginAuthorization` pattern); the main process still owns validation and the final decision, exactly as required by this task's own decision criteria.
- **Arbitrary endpoint / SSRF-like risk**: Low-medium — bounded entirely by the existing policy engine's loopback-only (or, if ever separately approved, explicit-approved-host) enforcement; a malicious or mistaken user entry still cannot reach a non-loopback host.
- **Local malicious service impersonation risk**: Medium — a user could, in principle, be tricked into approving a port a malicious local process is listening on. Not worse than Options A/C/D/F, since none of them defend against this either (inherent to the protocol, not to the source of the value).
- **Remote endpoint spoofing risk**: None — the policy engine's loopback-only enforcement is independent of what the user types.
- **WebSocket server identity risk**: Unresolved (T-15), same as every option.
- **TLS/WSS requirements**: None in the current protocol.
- **Certificate trust/pinning implications**: None possible.
- **Token leakage risk**: Unaffected — this option carries no token field at all (confirmed: `HermesEndpointCandidate` has no credential field).
- **Endpoint persistence implications**: **Needs its own explicit decision** — memory-only-per-launch (re-enter every launch, simplest, most consistent with the existing D-08B token model) vs. a saved, revocable setting (more convenient, needs its own persistence-safety review). Not decided by this document.
- **Endpoint rotation/update implications**: Clean — re-running the setup flow is the rotation mechanism.
- **Local development ergonomics**: Good — matches how the port is actually discovered and changed today (manually, by whoever is running Hermes).
- **Packaged release ergonomics**: Good once the UX exists — no packaging-time decision needed (unlike Option C).
- **Multi-environment / multi-user/tenant support**: Naturally supports "one user, one local setup, one entered value" — matches this product's own confirmed single-user scope; not designed for and not needed for a tenant model this product explicitly excludes.
- **User consent clarity**: **Confirmed strongest of any option** — an explicit setup screen is itself the consent point this task's decision criteria (items 4–5) require.
- **Revocation/removal behavior**: Clean — an explicit "clear"/"change endpoint" action, mirroring D-08B's `clearAuthorization` pattern exactly.
- **Operational support burden**: Low — the user who configured their own local Hermes port is also the one entering it here.
- **Testability with fake values, no live network**: Good — reuses the already-tested `validateEndpointCandidate` function directly; only the new IPC surface and UI need new tests.
- **Required future authorization scope**: UX design (exact screen/consent copy), persistence decision (memory-only vs. saved), and the new narrow IPC method(s) — all listed precisely in the future implementation plan document.

**Verdict: RECOMMENDED.**

---

## Option C — Main-process-only project-local non-secret configuration file

- **Evidence supporting**: same value-flexibility benefit as B (a real, varying port can be captured) without needing new UI; a file is trivially diff-able/inspectable by a technical user, which matches this project's own existing `.env.local.example`-style convention for non-secret config.
- **Evidence against**: **Confirmed unresolved question** — this repository has no existing convention for a *packaged-app-writable* config file (the existing `.env.local` convention is a *source-tree* file, not something a packaged/installed app is shown to read from or write to anywhere in the evidence gathered). Who creates the file, where it lives once installed, and how a non-technical user would ever discover they need to create it are all open packaging questions this document does not resolve.
- **Compatible with current Hermes deployment reality**: **Reasoned: yes**, for the same reason as B (captures the real, varying port) — but with a real packaging gap B does not have.
- **Renderer manipulation / renderer endpoint authority risk**: None — a file, not a renderer-reachable path at all.
- **Arbitrary endpoint / SSRF-like risk**: Low, same bounding as B (the existing policy engine still validates whatever the file contains).
- **Local malicious service impersonation risk**: Medium — same inherent protocol limitation as every option, plus the file itself could be tampered with by another local process/user with filesystem access, which is a *different* attack surface B does not have (B's value only ever exists in the current process's memory or a separately-decided persistence mechanism, never a plaintext file on disk by default).
- **Remote endpoint spoofing risk**: None, same reasoning as B.
- **WebSocket server identity risk**: Unresolved (T-15), same as every option.
- **TLS/WSS requirements**: None.
- **Certificate trust/pinning implications**: None.
- **Token leakage risk**: None if the file schema is endpoint-only (no token field) — must be an explicit constraint of any future implementation, not assumed safe by default.
- **Endpoint persistence implications**: **Confirmed** — the file itself *is* the persistence; unlike B, there is no "memory-only" variant of this option at all.
- **Endpoint rotation/update implications**: Edit the file — simple for a technical user, unclear for anyone else.
- **Local development ergonomics**: Good for a developer already comfortable editing `.env.local`-style files.
- **Packaged release ergonomics**: **Confirmed weakest point of this option** — needs a packaging decision this document does not make.
- **Multi-environment / multi-user/tenant support**: One file per install, matching this product's confirmed single-user scope; no tenant model needed or designed for.
- **User consent clarity**: Implicit (file presence) rather than an explicit screen — weaker than B's explicit consent point.
- **Revocation/removal behavior**: Delete or edit the file — simple, but not a guided/explicit in-app action the way B's "clear" button is.
- **Operational support burden**: Medium — "which file, where" is a real support question a first-run UI (B) would not generate.
- **Testability with fake values, no live network**: Good — same reuse of `validateEndpointCandidate` as B; file-reading logic itself is easily unit-tested with a fake path/fixture.
- **Required future authorization scope**: A packaging decision (file location inside/outside the installed app directory, creation responsibility) plus the file-schema/parsing implementation — larger unresolved scope than B's.

**Verdict: STRONGEST ALTERNATIVE, not the primary recommendation.**

---

## Option D — Main-process-only environment configuration

- **Evidence supporting**: none beyond "it is what the existing web app already does" — which this task's own predecessor authorization (D-08C) already explicitly forbade for exactly this reason, and which `VYRON_CODE_V02_DESKTOP_MIGRATION_ARCHITECTURE_AUDIT.md` already flagged, before this task, as broken for a packaged app with no launching terminal.
- **Evidence against**: **Confirmed, directly** — this task's own authorization forbids it outright ("Do not read... process environment values" as evidence source; the D-08C authorization forbade environment sourcing explicitly).
- **Compatible with current Hermes deployment reality**: Would technically capture the varying port correctly, but is not an available option regardless.
- **Every remaining criterion**: **not evaluated further — this option is foreclosed by explicit prior and current authorization, not by a risk/benefit judgment.**

**Verdict: NOT AVAILABLE — explicitly forbidden.**

---

## Option E — Operating-system managed configuration

- **Evidence supporting**: none found — no evidence anywhere in this repository of an enterprise/multi-user management need.
- **Evidence against**: **Confirmed** — `VYRON_CODE_V01_PRODUCT_BLUEPRINT.md` explicitly excludes "any multi-user/remote-access mode" from this product's own scope, which is the primary scenario where OS-managed configuration (e.g., registry policy, MDM-pushed settings) would provide a real benefit over a simple first-run UI.
- **Compatible with current Hermes deployment reality**: **Reasoned: yes, technically**, but disproportionate to the actual, confirmed, single-user deployment model.
- **Renderer manipulation / renderer endpoint authority risk**: None.
- **Arbitrary endpoint / SSRF-like risk**: Low, same bounding as B/C.
- **Local malicious service impersonation risk**: Same inherent protocol limitation as every option.
- **Remote endpoint spoofing risk**: None, same reasoning as B/C.
- **WebSocket server identity risk**: Unresolved (T-15), same as every option.
- **TLS/WSS / certificate implications**: None.
- **Token leakage risk**: None if endpoint-only, same constraint as C.
- **Endpoint persistence implications**: OS-managed, outside the application's own control.
- **Endpoint rotation/update implications**: Requires OS-level administrative action — heaviest of any option.
- **Local development ergonomics**: **Reasoned: poor** — platform-specific code paths (e.g. Windows registry) add real implementation and testing burden for a single-developer local workflow.
- **Packaged release ergonomics**: Medium — works once implemented, but implementing it is the highest-cost option of all six.
- **Multi-environment / multi-user/tenant support**: Its main advantage — but this product has no confirmed need for it.
- **User consent clarity**: Implicit (administrative configuration) — no in-app consent point.
- **Revocation/removal behavior**: OS-level, outside the app.
- **Operational support burden**: **Reasoned: highest** of any option — requires OS-specific support knowledge.
- **Testability with fake values, no live network**: Hardest of any option — OS-specific mocking required.
- **Required future authorization scope**: Full platform-integration design — largest scope of any option.

**Verdict: NOT RECOMMENDED — no evidence of the deployment scenario this option exists to solve.**

---

## Option F — No endpoint source yet; keep fail-closed availability state

- **Evidence supporting**: this is the option already implemented and committed (`98048c3`); every test, scan, and prior report confirms it is safe, fully validated, and imposes zero new risk of any kind.
- **Evidence against**: provides no real connectivity capability — a limitation, not a flaw, and the correct state whenever no other option is separately authorized.
- **Every risk category**: **None** — no endpoint exists to manipulate, spoof, impersonate, or leak.
- **User consent clarity**: Not applicable — there is nothing to consent to yet.
- **Testability**: Already fully tested (`tests/electronHermesEndpoint.test.ts`, 25 tests, all passing).
- **Required future authorization scope**: none to remain in this state — it is the default outcome of *not* implementing anything else.

**Verdict: CURRENT STATE, correctly retained until Option B (or an alternative) is separately authorized and implemented.**
