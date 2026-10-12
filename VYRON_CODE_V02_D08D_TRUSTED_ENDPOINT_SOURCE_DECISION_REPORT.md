# VYRON_CODE_V02_D08D_TRUSTED_ENDPOINT_SOURCE_DECISION_REPORT

**Outcome: SUCCESS.** A single, evidence-based product and security decision was reached for the future source of the trusted Hermes endpoint: **Option B (main-process-only explicit setup)** is recommended, with **Option C (project-local config file)** as the strongest alternative. No source, test, package, lockfile, build, or configuration file was created, modified, or even read for secret content. No network, Hermes, or process action of any kind was performed. Four Markdown-only documents were produced, all untracked, unstaged, uncommitted.

## Summary of the decisive evidence

This repository's own pre-existing reports (`HERMES_GATEWAY_START_REPORT.md`, `HERMES_TUI_GATEWAY_RUNTIME_RECONCILIATION_REPORT.md`) directly contradict the assumption Option A (compile-time fixed endpoint) requires: Hermes's real default port is `9119`, not the `9130` this project's own `.env.local` had been pointed at via an ad-hoc `--port` flag at an earlier manual setup — and that gateway instance was later found to have silently stopped running, with nothing auto-restarting it. This is confirmed, not assumed, evidence that the port genuinely varies and cannot be safely hardcoded. Separately, `VYRON_CODE_V02_DESKTOP_MIGRATION_ARCHITECTURE_AUDIT.md` confirms Hermes Agent's own server enforces a loopback-only peer at the protocol level — so the *host* dimension, unlike the port, is architecturally safe to fix to `loopback-only`, which the already-implemented `electron/hermesEndpoint.ts` already does. `VYRON_CODE_V01_PRODUCT_BLUEPRINT.md` confirms this product's own scope explicitly excludes "any multi-user/remote-access mode," ruling out Option E and reinforcing that a simple, single-user mechanism (B or C) is correctly scoped. The T-15 (WebSocket server-identity confirmation) threat-model gap was given an explicit decision — accepted as a disclosed, unresolved residual risk of the underlying plain-`ws://` protocol, not solvable from inside Vyron Code Desktop alone — rather than left silent.

## Documents produced

All four required documents were created, each Markdown-only, free of real endpoint values/credentials/user paths/raw environment values/raw protocol traces:

- [VYRON_CODE_V02_D08D_TRUSTED_ENDPOINT_SOURCE_DECISION.md](VYRON_CODE_V02_D08D_TRUSTED_ENDPOINT_SOURCE_DECISION.md) — the decision itself and its evidence chain.
- [VYRON_CODE_V02_D08D_ENDPOINT_SOURCE_OPTION_MATRIX.md](VYRON_CODE_V02_D08D_ENDPOINT_SOURCE_OPTION_MATRIX.md) — the full six-option (A–F) comparison across all 21 required evaluation criteria.
- [VYRON_CODE_V02_D08D_FUTURE_IMPLEMENTATION_PLAN.md](VYRON_CODE_V02_D08D_FUTURE_IMPLEMENTATION_PLAN.md) — the detailed future plan for Option B and Option C.
- This report.

---

**VYRON_CODE_V02_D08D_TRUSTED_ENDPOINT_SOURCE_DECISION_REPORT**
- Authorization scope: one evidence-based decision-record and threat-model-refinement task for the future Hermes endpoint source — no implementation
- Repository root: `D:/Vyron Code`
- Branch: `master`
- HEAD: `98048c3`
- Latest commits: `98048c3 feat(desktop): add trusted Hermes endpoint boundary`, `4bb50bc feat(desktop): add safe Hermes connectivity states`, `70e326b feat(desktop): add memory-only Hermes authorization`, `534530d build(desktop): add Electron runtime dependency`, `d85307e feat(desktop): complete read-only workspace milestone`, `6fd1d18 feat: add approval and clarification response UI`
- Remotes: 0
- Electron process state: not running throughout, confirmed at task start; never launched/killed by me
- Source files modified: none
- Tests modified: none
- Package files modified: none
- Build/launch files modified: none
- Git staging performed: no
- Git commit performed: no
- Git remote changed: no
- Network/WebSocket/HTTP/DNS/TCP activity: none
- Hermes session/prompt/context/provider/multimodel activity: none
- Actual token/environment/config values inspected: none — only channel/variable *names* (`HERMES_HOST`, `HERMES_PORT`) as already documented in pre-existing, non-secret repository reports; no `.env`/`.env.local` file was opened in this task
- Repository evidence inspected: `app/api/hermes/health/route.ts`, `app/api/hermes/session/route.ts`, `lib/hermesClient.ts` (previously read, referenced), `package.json`, `VYRON_CODE_V02_DESKTOP_ARCHITECTURE_DECISION.md`, `VYRON_CODE_V02_DESKTOP_MIGRATION_ARCHITECTURE_AUDIT.md`, `VYRON_CODE_V02_D08_HERMES_DESKTOP_THREAT_MODEL.md`, `VYRON_CODE_V01_PRODUCT_BLUEPRINT.md`, `HERMES_GATEWAY_START_REPORT.md`, `HERMES_SERVE_9130_START_REPORT.md`, `HERMES_TUI_GATEWAY_RUNTIME_RECONCILIATION_REPORT.md`
- Confirmed Hermes deployment evidence: loopback-only, same-machine, single-user, developer-run companion process — explicitly not multi-user/remote-access per the product's own scope statement
- Confirmed endpoint/topology evidence: real default port `9119`; this repository's own configured `9130` was an ad-hoc override, not a stable default, and was separately observed to have stopped running with no auto-restart
- Confirmed server-identity evidence: plain `ws://` protocol only — no TLS/WSS, no certificate, no server-identity/version-negotiation mechanism found anywhere
- Confirmed token-authentication evidence: the token authenticates the client to the server (URL query parameter checked server-side) only; the server is never authenticated to the client by anything in the documented protocol
- Unknowns: exact future UX copy/flow for endpoint setup; whether a non-loopback topology will ever be product-approved (no evidence either way; not designed for); whether Hermes Agent's own maintainers would ever add a server-identity mechanism
- Option A verdict: NOT RECOMMENDED — port confirmed unstable, contradicting the assumption this option requires
- Option B verdict: RECOMMENDED
- Option C verdict: STRONGEST ALTERNATIVE
- Option D verdict: NOT AVAILABLE — explicitly forbidden by prior and current authorization
- Option E verdict: NOT RECOMMENDED — no evidence of the multi-user/enterprise scenario this option exists to solve; explicitly out of this product's own scope
- Option F verdict: CURRENT STATE, correctly retained until a later authorization implements B (or an alternative)
- Recommended single endpoint-source model: Option B — main-process-only explicit setup, reusing the already-implemented `validateEndpointCandidate` policy engine unchanged
- Recommendation confidence: high for "not A, not D, not E"; medium-high for "B over C" (C remains a legitimate alternative pending a packaging-model decision)
- Evidence supporting recommendation: confirmed port variability, confirmed loopback enforcement, confirmed single-user product scope — all repository-internal, not assumed
- Risks accepted: T-15 (WebSocket server-identity confirmation) accepted as an unresolved residual risk of the underlying protocol, explicitly disclosed rather than silently inherited; local malicious-service impersonation risk (inherent to any loopback, non-TLS protocol, unaffected by endpoint-source choice)
- Risks unresolved: T-15, as above; exact persistence model for a user-entered endpoint (memory-only vs. saved) deferred to the future implementation authorization
- Renderer endpoint authority: none, under any recommended or alternative option
- Renderer endpoint visibility: none, unless a future separate product decision explicitly approves a safe, non-sensitive label
- Endpoint persistence recommendation: not decided here — flagged as an open question for the future implementation authorization (memory-only-per-launch vs. saved-and-revocable)
- Token persistence impact: none — no option evaluated adds a token field to the endpoint candidate
- Explicit user consent requirement: yes, for Option B (a dedicated setup screen); weaker/implicit for Option C unless a future design adds one
- Connection startup behavior: no automatic connection at any point, under any option — matches the existing, unchanged `connect()` requiring explicit user action
- Endpoint fallback/guess/scan policy: none, under any option — no localhost/LAN/remote fallback, no port scanning, no DNS scanning, in any evaluated option
- TLS/WSS recommendation: accept as unsupported by the current protocol; the existing validator already accepts `wss:` for forward compatibility without claiming Hermes supports it today
- Server identity recommendation: accept the residual risk (T-15); no in-repository mitigation is possible
- Future internal endpoint model: unchanged `HermesEndpointCandidate` shape, fed by a new main-process-only source module instead of the current always-`undefined` call
- Future renderer-safe state model: a new `HermesEndpointSetupState` enum, structurally identical in spirit to the existing `HermesAuthorizationState`/`HermesConnectionState` pattern
- Future IPC policy: unchanged constraints — no generic IPC, no raw `ipcRenderer`, zero-argument reads, a single narrow submit method carrying only the candidate fields (never a token)
- Required future tests: setup-flow state-transition tests, a T-17-style stale-in-flight-connect-vs-clear race test, a renderer-reachability structural test — detailed in the future implementation plan
- Required future scans: the full existing D-08C/D-08D scan suite, unchanged in kind (secret, credential-leak/persistence, environment-access, endpoint supply/exposure, network absence, generic-IPC absence, `git diff --check`)
- Required future user acceptance: not required by this task (no source changed); would be required once a future implementation stage adds real UI/IPC surface
- Required future explicit authorization: a separate authorization to implement Option B's setup flow (UX, persistence decision, IPC surface, tests) and, later still and separately, an authorization to open a real network connection using a configured endpoint — neither is authorized by this document
- Documents created: `VYRON_CODE_V02_D08D_TRUSTED_ENDPOINT_SOURCE_DECISION.md`, `VYRON_CODE_V02_D08D_ENDPOINT_SOURCE_OPTION_MATRIX.md`, `VYRON_CODE_V02_D08D_FUTURE_IMPLEMENTATION_PLAN.md`, `VYRON_CODE_V02_D08D_TRUSTED_ENDPOINT_SOURCE_DECISION_REPORT.md` — all four, all untracked, none staged
- Untracked documents preserved: yes — confirmed via `git status --short` before and after
- Existing worktree changes preserved: yes — `git diff --stat -- electron/ tests/ package.json package-lock.json` empty throughout; every pre-existing unrelated modification/deletion/untracked file untouched
- Tokens/secrets exposed: none — no secret-bearing file was opened; only non-secret variable *names* already present in this repository's own pre-existing, non-secret reports were referenced
- Exact next action requiring explicit approval: a separate authorization to implement Option B's first-run/on-demand endpoint setup flow (per the future implementation plan), and — later, separately — an authorization to open a real Hermes network connection once a trusted endpoint is configured
