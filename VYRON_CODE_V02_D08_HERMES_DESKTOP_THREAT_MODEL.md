# VYRON_CODE_V02_D08_HERMES_DESKTOP_THREAT_MODEL

Threat-model document only — no runtime action was taken to produce it. This model extends `VYRON_CODE_V02_DESKTOP_ARCHITECTURE_DECISION.md` Section 22 (which is incorporated by reference and not repeated here) with the Hermes-specific assets and boundaries this authorization requires. Example values are placeholders.

## Assets

| Asset | Sensitivity | Where it may legitimately exist |
|---|---|---|
| Hermes token/credential | Critical | Main process memory only (Section 3 of the companion decision record) |
| Hermes session identifier | High | Main process; renderer may hold only an opaque, main-process-issued handle, never the real Hermes-side ID |
| Workspace canonical root | High | Main process only (already enforced, unchanged from Milestone A) |
| Safe relative workspace paths | Low | Renderer (already the accepted Milestone A model) |
| File preview content | Medium (depends on workspace content) | Renderer, bounded, already the accepted Milestone A model |
| Search result content | Medium | Renderer, bounded, already accepted |
| Git summary content | Low-Medium | Renderer, bounded, already accepted |
| User prompt text | Medium-High (may contain anything the user typed) | Renderer while composing; main process while in transit to Hermes; never persisted (no persistence layer exists) |
| Model/Hermes response text | Medium-High (same reasoning) | Renderer for display; never persisted |
| Context attachment metadata | Medium | Renderer, bounded — must follow the same "explicit preview before send" model as `app/api/context/attach` already establishes in the web app |
| Event/timeline metadata | Low-Medium | Renderer, bounded, sanitized (no raw protocol dump — see Threat T-6) |
| Local app configuration | Low today (none exists); would rise if any future config file is introduced | Not yet applicable — no config persistence exists in the current desktop app |
| Logs and reports | Low, but must never contain any of the above at higher sensitivity | Developer-visible only (`VYRON_LIFECYCLE_DEBUG=1`-gated), never shipped, never renderer-visible |

## Trust boundaries

| Boundary | Current state | Hermes-specific note |
|---|---|---|
| Electron renderer | Untrusted relative to main; sandboxed, no Node integration (unchanged Milestone A invariant) | Must never hold the token, a real session ID, or a raw transport object |
| Sandboxed preload | Semi-trusted bridge; no local relative imports (Milestone A's own hard-won invariant, preserved) | Must expose only narrow, typed, purpose-specific methods — never a generic passthrough to a future Hermes client |
| Electron main process | Fully trusted, sole holder of privileged state (workspace canonical root today; the token, if D-08B is ever authorized) | Becomes the sole holder of the Hermes token and the real Hermes session ID, mirroring how it already is the sole holder of the workspace canonical root |
| Native dialog | Trusted OS surface, already used only for the folder picker | No Hermes-specific use is proposed |
| Local workspace filesystem | Bounded by canonical-root containment (unchanged) | If a future stage (D-08F) ever attaches workspace content to a Hermes prompt, that attachment must reuse the exact same containment/staleness-revalidation discipline `app/api/context/attach` already uses in the web app |
| Local persistence layer, if ever authorized | **Does not exist today** | Not authorized by this document; see the companion decision record, Section 3 |
| Hermes WebSocket/client boundary | Does not exist in the desktop app yet | Would live entirely in the main process if ever implemented (D-08C onward) — never in the renderer, mirroring the web app's own server-only client |
| Existing v0.1 server-side modules (`lib/hermesClient.ts`, `lib/hermesEvents.ts`, `lib/sessions.ts`, `lib/contextPayload.ts`) | Trusted within the *web app's* own server process | **Not directly reusable** in the desktop main process without rehosting — see the companion decision record, Section B.4 |
| OS credential/security facilities | Not used today | Considered and deferred in the companion decision record (Options B/C) |
| User-owned PowerShell / launch layer | Already the accepted Milestone A launch model (`scripts/start-desktop.ps1`) | No Hermes-specific change proposed; the token (if D-08B is authorized) would be entered through an in-app UI, not a launch-time argument, to avoid it ever appearing in shell history or a process-argument list a local user/tool could inspect |

## Threats

Format: description / impact / likelihood / existing mitigation / required future mitigation / residual risk / blocks first milestone?

**T-1. Renderer XSS or compromised renderer code**
Impact: if the renderer could be made to run attacker-controlled JS (e.g., via unsanitized file-preview or Hermes-response rendering), it could attempt to call any preload-exposed method repeatedly, exfiltrate whatever the renderer *does* legitimately hold, or attempt UI-spoofing to trick the user into approving something.
Likelihood: Low today (renderer only renders text via `textContent`, already Milestone A's own established, tested pattern — never `innerHTML`). Likelihood would need active re-assessment once Hermes response text is rendered, since that text is attacker-*influenceable* (the model's own output, potentially reflecting injected instructions).
Existing mitigation: `sandbox: true`, `contextIsolation: true`, no `innerHTML` usage anywhere in `electron/renderer.ts` (verified), CSP `default-src 'none'` on `renderer.html`.
Required future mitigation: continue the `textContent`-only rendering discipline for any future Hermes response/event display; never render model output as HTML.
Residual risk: Low, contingent on that discipline being maintained.
Blocks first milestone: No — D-08A/B/C introduce no new renderable untrusted content.

**T-2. Malicious workspace file names/content**
Impact: a crafted file name or file content in a user-selected workspace could attempt path-confusion or be used as a prompt-injection vector if ever attached to a Hermes prompt (T-3).
Likelihood: Low for path-confusion (already defended — canonical-root containment, denied segment names, symlink-escape protection, all Milestone A, all unchanged and re-tested extensively). Medium for prompt-injection risk *once context attachment exists* (D-08F) — a file could contain text designed to look like an instruction to the model.
Existing mitigation: canonical-root containment (Milestone A, unchanged).
Required future mitigation: D-08F's explicit context-attachment preview (Section 7 of the companion IPC/UX spec) must show the user exactly what text will be sent *before* it is sent, so injected-looking content is visible and reviewable, not silently forwarded.
Residual risk: Medium, deferred to D-08F's own design and acceptance criteria — not resolved by this document alone.
Blocks first milestone: No — no context attachment exists before D-08F.

**T-3. Prompt injection via file content**
Impact: if workspace file content is ever included in a prompt sent to Hermes/a model, that content could contain text attempting to override the user's actual intent (a well-known LLM-application risk class).
Likelihood: Not applicable until D-08F exists.
Existing mitigation: none needed yet — no context-attachment capability exists.
Required future mitigation: the D-08F preview requirement above; additionally, the eventual prompt-construction code should keep user-authored prompt text and attached-file content in clearly distinguishable regions (mirroring `lib/contextPayload.ts`'s `assembleContextPrompt` pattern in the web app, which already keeps them structurally separate) so a reviewing user — and, to whatever extent Hermes/the model itself does this — can distinguish instruction from quoted content.
Residual risk: Medium-High in general for any LLM application; this is a known, industry-wide, not-fully-solved risk class, disclosed honestly rather than claimed solved.
Blocks first milestone: No — deferred entirely to D-08F.

**T-4. Token leak through IPC**
Impact: Critical — token compromise.
Likelihood: Low, contingent on the IPC contract in the companion document being followed exactly (no method ever returns the token; no method ever accepts a caller-supplied "give me the token" request).
Existing mitigation: n/a yet (no token-handling code exists).
Required future mitigation: the explicit prohibited-method list in the companion IPC/UX spec (`getToken`, `setToken` as renderer-callable, etc.) and a dedicated regression test (mirroring this engagement's own established pattern of structural/shape tests rather than any test that ever holds a real token) asserting the exposed bridge object contains no token-shaped field.
Residual risk: Low if the test exists and passes; **this is a hard blocking requirement before D-08B may be considered complete**.
Blocks first milestone: **Yes, for D-08B specifically** — D-08B may not ship without this test.

**T-5. Token leak through renderer memory/DOM**
Impact: Critical.
Likelihood: Very low under Option A (the token is never sent to the renderer at all, so it cannot appear in renderer memory or the DOM by construction).
Existing mitigation: n/a yet.
Required future mitigation: the IPC contract must never pass the token as an IPC argument or return value in either direction.
Residual risk: Very low, by design, not by discipline alone.
Blocks first milestone: Yes, same as T-4 — enforced by the same design choice.

**T-6. Token leak through logs/errors/stack traces**
Impact: Critical.
Likelihood: Low if the existing engagement-wide discipline (log only an error's `constructor.name`, never `.message`, established in `electron/workspace-grant.ts` and `electron/main.ts`'s own diagnostic logging) is extended to any future Hermes client code.
Existing mitigation: the pattern already exists and is tested elsewhere in this codebase.
Required future mitigation: apply the identical pattern to any future Hermes-client error handling in the main process; never log a raw error object from a WebSocket/RPC failure (the existing web-app client's own header comment already documents verifying `ws`'s error messages are safe to surface — that verification should be re-confirmed, not assumed, if the desktop client ever reuses `ws`).
Residual risk: Low, contingent on the pattern being followed.
Blocks first milestone: No direct code exists yet to violate this in D-08A; becomes relevant starting D-08C.

**T-7. Token leak through crash reporting**
Impact: Critical.
Likelihood: Low — this codebase has no `crashReporter` configuration anywhere (confirmed in the prior external-process-termination investigation) and this document does not propose adding one.
Existing mitigation: absence of any crash-reporter configuration.
Required future mitigation: if a crash reporter is ever configured for any reason, it must be explicitly verified not to capture main-process memory contents (Electron's `crashReporter` by default captures minidumps, which *can* contain process memory — this would need its own dedicated review before ever being enabled on a build that also holds a token in memory).
Residual risk: Low today (feature absent); would require dedicated re-review if ever introduced.
Blocks first milestone: No — no crash reporter is proposed for D-08A/B/C.

**T-8. Token leak through clipboard**
Impact: Critical.
Likelihood: Very low if no code path ever calls `clipboard.writeText` with the token — trivially avoidable by never writing such code.
Existing mitigation: n/a yet.
Required future mitigation: the token-entry UX (D-08B) must never programmatically copy the token anywhere, and should discourage (though cannot fully prevent) the user pasting it in a way that leaves it in their own OS clipboard history — this is a user-side risk, not a desktop-app one, and this document does not claim to solve it.
Residual risk: Low (app-side), acknowledged-but-unsolved (OS/user-side).
Blocks first milestone: No.

**T-9. Token leak through persisted UI state**
Impact: Critical.
Likelihood: None under Option A — there is no persisted UI state at all in the current desktop app (no `localStorage` use anywhere in `electron/renderer.ts`, confirmed by the existing Milestone A test suite's own workspace-persistence-absence scan).
Existing mitigation: the absence itself, already tested.
Required future mitigation: extend the same absence-scan test class to cover any future Hermes-related renderer state.
Residual risk: None under Option A.
Blocks first milestone: No.

**T-10. Generic IPC escalation**
Impact: High — a generic `invoke`/`send`/`on` surface would let a compromised renderer call arbitrary main-process functionality.
Likelihood: Low — Milestone A's own preload never exposes `ipcRenderer` itself, only fixed closures over hardcoded channels (already tested).
Existing mitigation: the existing, tested preload pattern.
Required future mitigation: every future Hermes IPC method must follow the identical pattern — a fixed closure, one hardcoded channel, explicit typed parameters, never a passthrough.
Residual risk: Low, contingent on the pattern being followed (see the companion IPC/UX spec's explicit prohibited-method list, which encodes this requirement directly).
Blocks first milestone: Yes if violated — this is a hard design constraint, not a "nice to have."

**T-11. Preload API overexposure**
Impact: Medium-High — even without a generic passthrough, exposing *too many* narrow methods (or methods with too-broad parameters) widens the attack surface.
Likelihood: Medium if not actively minimized at each stage.
Existing mitigation: Milestone A's own workspace bridge is already narrow (7 methods, each single-purpose).
Required future mitigation: the capability-ladder design (companion document) deliberately introduces Hermes methods in the smallest possible increments per stage, rather than exposing the full eventual surface up front.
Residual risk: Medium, actively managed by the ladder structure rather than eliminated outright.
Blocks first milestone: No, if the ladder is followed.

**T-12. Privilege escalation from renderer to main process**
Impact: Critical (equivalent to full compromise).
Likelihood: Very low given `contextIsolation`/`sandbox`/no-Node-integration (unchanged Milestone A invariants).
Existing mitigation: the existing, tested Electron hardening.
Required future mitigation: none beyond maintaining the existing invariants; no Hermes-specific change is needed or proposed to this boundary.
Residual risk: Low, inherited from the existing, already-defended boundary.
Blocks first milestone: No.

**T-13. Unsafe workspace-context exfiltration**
Impact: High — sending more of the workspace to Hermes than the user intended or realized.
Likelihood: Medium if the "explicit preview before send" requirement (Section 7 of the companion document) is not implemented faithfully.
Existing mitigation: none yet (no context-attachment capability exists in the desktop app).
Required future mitigation: D-08F must default to "nothing will be sent" and require an explicit, itemized, reviewable preview before any workspace content is attached — directly mirroring the web app's own `app/api/multimodel/preview` design principle (`will_send`/`will_not_send` returned before any action is possible).
Residual risk: Medium until D-08F ships with this exact design; not a concern before then.
Blocks first milestone: No — not applicable before D-08F.

**T-14. Unauthorized network endpoint use**
Impact: High — a compromised or buggy renderer directing the app to connect to an attacker-controlled endpoint instead of the real Hermes gateway.
Likelihood: Low if the endpoint is never renderer-suppliable (the companion IPC/UX spec explicitly forbids a `connectArbitraryUrl` method).
Existing mitigation: n/a yet; the web app's own `HERMES_HOST`/`HERMES_PORT` are environment-sourced, never client-suppliable, and the desktop model should inherit that same posture (main-process-configured, never renderer-suppliable).
Required future mitigation: whatever configures `host`/`port` for the desktop main process's future Hermes client must not accept these values from the renderer.
Residual risk: Low if the prohibition holds.
Blocks first milestone: Yes for D-08C onward — any endpoint-configuring code must satisfy this before shipping.

**T-15. WebSocket endpoint spoofing or downgrade**
Impact: High — a local, malicious process on the same machine could attempt to bind the expected loopback port before the real Hermes gateway does, intercepting the connection.
Likelihood: Low-Medium — this is a real local-attacker threat class already partially addressed by the existing protocol's own `Origin`/`Host` checks (enforced server-side by Hermes, not by the desktop client), but the desktop client itself does not currently add any *additional* authentication of "is this really the Hermes gateway I expect."
Existing mitigation: Hermes's own server-side `Origin`/`Host`/loopback-peer checks (B.3 of the companion decision record) — these protect the *server* from unexpected clients, but do not protect the *client* from an unexpected server.
Required future mitigation: this is a genuine, currently-unresolved gap inherited from the existing protocol design, not something D-08A can fix — flagged here explicitly as a known limitation that any future D-08C implementation should re-examine (e.g., whether Hermes exposes any server-identity confirmation the client could check).
Residual risk: Medium, disclosed, not resolved by this document.
Blocks first milestone: **Yes, for any stage that establishes a real connection (D-08C onward)** — D-08C's own acceptance criteria (companion document) should require an explicit decision on this gap, not silent inheritance of the risk.

**T-16. Session hijack/reuse**
Impact: High — reusing or guessing another session's identifier to read/interact with someone else's Hermes session.
Likelihood: Low if the renderer never receives a real, reusable Hermes session ID (T-2 of the companion decision record's B.5 already establishes this design requirement) — the renderer should hold only an opaque, main-process-issued handle.
Existing mitigation: n/a yet.
Required future mitigation: enforce the opaque-handle pattern starting at whichever stage first creates a session (D-08D).
Residual risk: Low if enforced.
Blocks first milestone: Not applicable before D-08D.

**T-17. Stale session state after clear/revoke**
Impact: Medium — a UI that still shows "connected"/"session active" after the user explicitly cleared authorization would be misleading and could lead to an unintended send.
Likelihood: Medium if not explicitly tested.
Existing mitigation: Milestone A's own `clearCurrent`/`resetWorkspaceViewState` pattern (immediate revocation, full renderer state reset, and future requests fail safely) is the exact right precedent to reuse conceptually.
Required future mitigation: `clearAuthorization` (companion IPC spec) must behave identically — immediate, and every subsequent Hermes-related IPC call must fail safely (a defined "unavailable"/"not authorized" state, never stale success) until re-authorized.
Residual risk: Low if the existing pattern is faithfully extended.
Blocks first milestone: Yes for D-08B — `clearAuthorization`'s test coverage should explicitly prove this.

**T-18. Confused-deputy access to workspace content**
Impact: Medium-High — Hermes (or a compromised main-process code path) being tricked into accessing workspace content the user did not intend to expose, using the desktop app's own already-granted filesystem access as an unwitting proxy.
Likelihood: Low today (no code path connects Hermes to the workspace-access services at all) — becomes relevant only at D-08F.
Existing mitigation: no such code path exists yet.
Required future mitigation: D-08F's context-attachment code must call the exact same `workspaceAccess.ts`/`resolveWorkspacePath` validation every other workspace service already uses — never a parallel, weaker path — mirroring this engagement's own repeatedly-enforced "reuse, don't reimplement" principle.
Residual risk: Low if that reuse discipline holds.
Blocks first milestone: Not applicable before D-08F.

**T-19. Prompt submission without explicit user intent**
Impact: Medium-High — an automatic or accidental prompt send (e.g., triggered by a stray keystroke, a programmatic retry, or a misfired event handler) could leak workspace context or consume the user's Hermes quota/attention without their intent.
Likelihood: Low if the UX requirement (Section 7 of the companion document: "prompt and context must be visibly separate user actions," "no background connection/retry loop by default") is implemented faithfully.
Existing mitigation: n/a yet.
Required future mitigation: D-08E's own acceptance criteria must include an explicit test that no prompt can be sent without a distinct, visible user action (e.g., a submit button click or an equivalent explicit keyboard action tied to that specific control, never a side effect of navigation or an automatic timer).
Residual risk: Low if tested.
Blocks first milestone: Not applicable before D-08E.

**T-20. Multimodel start without explicit consent**
Impact: High — the web app itself already treats this as blocked (`start_available: false` in `app/api/multimodel/preview`), and the desktop app inherits that same posture by simply not implementing it.
Likelihood: N/A — no code path exists.
Existing mitigation: the web app's own design already blocks this; the desktop app has even less exposure (no multimodel code at all).
Required future mitigation: none for D-08A through D-08H; any future multimodel capability is explicitly out of D-08's scope per this authorization's own capability-ladder note ("D-09 or later").
Residual risk: None currently.
Blocks first milestone: Not applicable.

**T-21. Token persistence surviving user intent to revoke**
Impact: Critical, if it ever happened.
Likelihood: None under Option A (nothing is ever persisted to survive anything).
Existing mitigation: the Option-A decision itself (companion document, Section 3).
Required future mitigation: not applicable unless/until Option B/C is separately authorized, at which point this threat becomes directly relevant and must be re-evaluated in that future authorization's own threat-model update.
Residual risk: None today.
Blocks first milestone: No.

**T-22. Third-party code / dependency supply-chain risk**
Impact: High — a future Hermes desktop client would likely depend on `ws` (already a dependency, used by the web app) or an equivalent library; a compromised version could exfiltrate the token directly from main-process memory.
Likelihood: Low-Medium, the same general supply-chain risk every dependency carries — not unique to Hermes, but sharpened by the presence of a genuine secret in memory once D-08B ships.
Existing mitigation: `ws` is already a reviewed, existing dependency of this codebase (used by the web app); no new dependency is proposed by this document.
Required future mitigation: if any *new* dependency is ever proposed for the desktop Hermes client, it should receive the same kind of due-diligence review this engagement already performed for Electron itself (`VYRON_CODE_V02_D02A_ELECTRON_DEPENDENCY_DUE_DILIGENCE_REPORT.md`) before being added.
Residual risk: Medium, inherent to any dependency holding proximity to a secret; not eliminable, only manageable via review discipline.
Blocks first milestone: No for D-08A (no dependency change proposed); relevant to re-check at whichever stage first adds main-process Hermes-client code.

**T-23. Diagnostic mode leaking sensitive data**
Impact: Critical, if it happened.
Likelihood: Low, given the existing `VYRON_LIFECYCLE_DEBUG=1`-gated diagnostic pattern already established and tested (never logs a path/token/content-bearing variable — enforced by an existing regression test in `tests/electronMainLifecycle.test.ts`).
Existing mitigation: the existing pattern and its existing test.
Required future mitigation: any future Hermes-related diagnostic logging must be added to that same test's coverage, asserting no token-shaped value is ever passed to the logger.
Residual risk: Low, contingent on extending the existing test.
Blocks first milestone: Yes for whichever stage first adds any Hermes-related diagnostic logging — the test extension should ship in the same change.

## Threats that block the first desktop Hermes milestone (summary)

T-4, T-5 (token-in-IPC/renderer — resolved by design, not merely by discipline, and must be proven by a dedicated test before D-08B ships), T-10 (generic IPC — a hard design constraint), T-14 (renderer-suppliable endpoint — must be prohibited before D-08C), T-15 (server-identity confirmation gap — D-08C must make an explicit decision, not inherit silently), T-17 (stale state after revoke — D-08B must test this explicitly), T-23 (diagnostic leakage — must extend the existing test when relevant code is added).

No threat in this model blocks **D-08A itself** (this document), since D-08A introduces no runtime code.

## Not authorized in this task

This document is analysis only. No threat listed above was exercised, reproduced, or tested against a real system in the production of this document — every mitigation marked "existing" was verified by reading already-committed, already-tested source; every "required future mitigation" is a requirement for a later, separately-authorized task, not something implemented here.
