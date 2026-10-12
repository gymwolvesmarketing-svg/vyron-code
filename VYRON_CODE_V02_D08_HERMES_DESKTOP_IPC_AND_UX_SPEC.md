# VYRON_CODE_V02_D08_HERMES_DESKTOP_IPC_AND_UX_SPEC

Design document only. **No IPC channel, preload method, or UI element described here was implemented in this task.** Every method/state below is a specification for a future, separately-authorized implementation task. Placeholder values only.

---

## Part 5 — Future desktop Hermes capability ladder

Eight stages, each independently testable and separately authorizable, extending the authorization's own required shape with full per-stage detail.

### D-08A — Architecture decision and threat model (this task)
- **Allowed operations**: reading existing source; producing documentation.
- **Forbidden operations**: everything runtime-related (see this authorization's own "does NOT authorize" list).
- **Main-process responsibilities**: none.
- **Preload bridge methods**: none added.
- **Renderer-visible state**: unchanged from Milestone A.
- **User consent point**: n/a.
- **Token exposure policy**: no token exists in any code path.
- **Workspace data exposure policy**: unchanged from Milestone A.
- **Network policy**: none.
- **Test requirements**: none (documentation only).
- **Acceptance criteria**: the five documents exist, are internally consistent, and are approved by the user as precise enough to implement D-08B against without further guessing.
- **Blocking prerequisites**: none — this is the first stage.

### D-08B — Opt-in token/session authorization UX and memory-only credential boundary
- **Allowed operations**: renderer presents a token-entry UI; main process receives the entered value over IPC exactly once per entry action, holds it in memory only, for the process's lifetime; an explicit clear action drops it.
- **Forbidden operations**: no network connection is attempted with the token yet (that is D-08C+); no persistence of any kind; no automatic re-use across launches.
- **Main-process responsibilities**: hold the token in a module-scope variable (mirroring `electron/workspace-grant.ts`'s own `currentGrant` pattern for a single, in-memory, revocable grant); never log it; never return it to the renderer once set.
- **Preload bridge methods**: `hermes.beginAuthorization(token: string): Promise<HermesAuthorizationState>`, `hermes.clearAuthorization(): Promise<HermesAuthorizationState>`, `hermes.getAuthorizationState(): Promise<HermesAuthorizationState>`.
- **Renderer-visible state**: an enum-like `HermesAuthorizationState` (`"not_configured" | "not_granted" | "granted"` — no boolean "isValid" that would require exposing anything about the token's actual content) — see Part 6 for the exact shape.
- **User consent point**: the user must type/paste the token into an explicit form and submit it; nothing is auto-filled or auto-submitted.
- **Token exposure policy**: the token travels renderer→preload→main exactly once, over one dedicated IPC call, as a plain string argument (unavoidable for entry — the user must type it somewhere); it is never sent main→renderer in any direction, at any time, including in `getAuthorizationState`'s response.
- **Workspace data exposure policy**: unchanged — this stage touches no workspace code.
- **Network policy**: none — no connection is attempted.
- **Test requirements**: a structural test asserting the exposed bridge object contains no method that returns the token; a behavioral test asserting `getAuthorizationState()` after `beginAuthorization("fake-token")` returns `"granted"` without the literal string `"fake-token"` appearing anywhere in the response; a test asserting `clearAuthorization()` returns to `"not_granted"` and a subsequent `getAuthorizationState()` confirms it.
- **Acceptance criteria**: all of the above tests pass; a user-owned manual test confirms the entered value never appears in the renderer's own DevTools-visible state (verified via the same non-invasive methods this engagement has used throughout — never by actually opening DevTools against a real token).
- **Blocking prerequisites**: D-08A accepted.

### D-08C — Hermes health/connectivity status through main-process-only typed IPC
- **Allowed operations**: main process attempts the passive reachability check only (mirroring the web app's own `GET /api/hermes/health` — a raw TCP connect-and-close, never a WebSocket upgrade, never carries the token).
- **Forbidden operations**: no session creation, no prompt sending, no workspace-context attachment, no WebSocket upgrade.
- **Main-process responsibilities**: perform the TCP probe against a **main-process-configured** host/port (never renderer-suppliable — closing T-14 from the threat model); classify the safe enum result.
- **Preload bridge methods**: `hermes.getConnectionState(): Promise<HermesConnectionState>` (`"unavailable" | "not_attempted" | "checking" | "reachable" | "unreachable"`).
- **Renderer-visible state**: the enum above only.
- **User consent point**: none required for a passive reachability check (mirroring the web app's own unauthenticated health route), but the check must not run silently in a background retry loop — it runs only when the user opens/refreshes the relevant UI panel.
- **Token exposure policy**: this stage's own check never uses the token at all (matching the web app's health route, which also never authenticates).
- **Workspace data exposure policy**: unchanged.
- **Network policy**: exactly one TCP connect-and-close per user-initiated check; no retry loop; no data sent.
- **Test requirements**: a test confirming the host/port cannot be supplied by the renderer (the IPC method takes no arguments at all); a test confirming the probe never sends the token.
- **Acceptance criteria**: the above tests pass; the T-15 "server-identity confirmation" gap from the threat model is explicitly re-examined and a decision (accept the residual risk, or add a mitigation) is documented in this stage's own authorization, not silently inherited.
- **Blocking prerequisites**: D-08B accepted (so `getConnectionState` can eventually be gated behind "is authorized" once D-08D needs the token, even though D-08C's own check does not need it).

### D-08D — Explicit user-approved session creation
- **Allowed operations**: `session.create` + `session.activate`, called only after an explicit user action, using the in-memory token from D-08B.
- **Forbidden operations**: no automatic session creation on app launch or on becoming reachable; no workspace files/content included by default.
- **Main-process responsibilities**: hold the real Hermes session ID; issue the renderer an opaque, main-process-generated handle (mirroring `workspace-grant.ts`'s `workspaceId` pattern) — never the real Hermes session ID itself (closing T-16).
- **Preload bridge methods**: `hermes.createSession(): Promise<HermesSessionState>`, `hermes.getSessionState(): Promise<HermesSessionState>`, `hermes.endSession(): Promise<HermesSessionState>`.
- **Renderer-visible state**: `HermesSessionState` — `{ state: "no_session" | "creating" | "active" | "ended" | "unavailable"; sessionHandle: string | null }` (an opaque UUID-shaped handle, never the real Hermes ID).
- **User consent point**: an explicit "Start Hermes session" action.
- **Token exposure policy**: unchanged from D-08B (still never renderer-visible); used internally by the main process only.
- **Workspace data exposure policy**: none attached at this stage.
- **Network policy**: one WebSocket connection established per session, using the D-08C-validated host/port and the D-08B token; no additional endpoints.
- **Test requirements**: a test proving the renderer-visible session handle is never equal to (or derivable from) any real Hermes-side session ID used in a mocked main-process call; a test proving `endSession` immediately invalidates the handle (mirroring the T-17 stale-state requirement).
- **Acceptance criteria**: above tests pass; a user-owned test confirms a session can be created and ended with no observable token/session-ID leak in any visible UI state.
- **Blocking prerequisites**: D-08B and D-08C accepted.

### D-08E — Explicit user-approved prompt submission
- **Allowed operations**: `prompt.submit` for a user-authored prompt string, sent only after an explicit, distinct user action (closing T-19).
- **Forbidden operations**: no hidden/automatic prompt injection of any kind; no workspace context attached by default (that is D-08F).
- **Main-process responsibilities**: forward exactly the renderer-supplied prompt text, unmodified, to `prompt.submit`, tied to the active session handle from D-08D.
- **Preload bridge methods**: `hermes.submitPrompt(text: string): Promise<HermesSubmitResult>`.
- **Renderer-visible state**: `HermesSubmitResult` — `{ state: "submitted" | "no_session" | "unavailable" }`.
- **User consent point**: an explicit "Send" action, visually distinct from anything else (closing T-19's requirement).
- **Token exposure policy**: unchanged.
- **Workspace data exposure policy**: none — this stage sends only the literal text the user typed.
- **Network policy**: reuses the D-08D session's existing connection; no new endpoint.
- **Test requirements**: a test proving `submitPrompt` cannot be triggered by any event handler other than the one explicit send action's own click/submit handler (a structural/source-level check, mirroring this engagement's own established test style); a test proving no prompt is sent before `createSession` has produced an active handle.
- **Acceptance criteria**: above tests pass; prompt text is confirmed previewable (i.e., the renderer already shows the user exactly what they typed before the send action — trivially true for a normal text input, called out explicitly so no future redesign silently loses this property).
- **Blocking prerequisites**: D-08D accepted.

### D-08F — Explicit context attachment preview
- **Allowed operations**: the user selects safe file snippets/relative paths/diff hunks/metadata from the *already-existing* bounded Explorer/Search/Git-summary surfaces (Milestone A, unchanged) to attach to a future prompt; before any send, an itemized preview is shown.
- **Forbidden operations**: no default attachment of anything; no attachment bypassing canonical-root containment (closing T-18); no full-repository or chat-history attachment (mirroring the web app's own `will_not_send` list in `app/api/multimodel/preview`).
- **Main-process responsibilities**: re-validate every selected item through the exact same `workspaceAccess.ts`/`resolveWorkspacePath` path every other workspace service already uses — never a parallel implementation (T-18).
- **Preload bridge methods**: `hermes.previewContext(selections: ContextSelectionRequest[]): Promise<ContextPreviewResult>`, `hermes.attachContext(selections: ContextSelectionRequest[]): Promise<ContextAttachResult>`.
- **Renderer-visible state**: the itemized preview — safe relative path, bounded snippet text, approximate size, and the destination session handle — mirroring exactly the "explicit reviewable preview" requirement in Part 7 below.
- **User consent point**: two distinct actions — "Preview" (safe, read-only, can be called freely) and "Attach" (the actual state-changing action, requires the preview to have been shown first).
- **Token exposure policy**: unchanged.
- **Workspace data exposure policy**: bounded, itemized, previewed before any attach — closing T-2/T-3/T-13.
- **Network policy**: none for `previewContext` (pure local computation, like `app/api/multimodel/preview` today); `attachContext` itself sends nothing to Hermes — it only marks items ready for the *next* `submitPrompt` call (mirroring the web app's `context_attach` route, which is itself local-only).
- **Test requirements**: a test proving `previewContext` never touches `resolveWorkspacePath`'s write-adjacent paths (it is read-only); a test proving a stale/changed file fails the *entire* attach closed (mirroring `revalidateItems`'s existing fail-closed behavior in the web app, conceptually reused).
- **Acceptance criteria**: above tests pass; a user-owned test confirms the preview accurately reflects what a mocked `submitPrompt` call would actually send.
- **Blocking prerequisites**: D-08E accepted.

### D-08G — Event/timeline rendering
- **Allowed operations**: rendering the Hermes event stream (message deltas, tool-call status, etc.) in the renderer, sourced via a main-process-owned subscription, forwarded over a bounded, typed IPC event channel.
- **Forbidden operations**: no raw token, secret, internal protocol dump, or absolute-path exposure in any rendered event (closing the general "no raw protocol messages" prohibition in Part 6).
- **Main-process responsibilities**: parse/sanitize each event before forwarding — the renderer never receives the raw JSON-RPC envelope, only a pre-shaped, typed event object (mirroring `lib/hermesClient.ts`'s own existing unwrap step, `{type, sessionId, payload}` → further narrowed for the renderer).
- **Preload bridge methods**: a bounded subscription method, e.g. `hermes.onEvent(callback): () => void` — **not** a generic `on(channel, callback)`; the method itself is hardcoded to the one Hermes-event channel and returns an unsubscribe function, mirroring Electron's own safe subscription patterns rather than exposing `ipcRenderer.on` directly.
- **Renderer-visible state**: a typed, sanitized event stream only.
- **User consent point**: none needed beyond the already-active session from D-08D (viewing events from a session you already explicitly started/joined is not a new consent point).
- **Token exposure policy**: unchanged — events never carry the token.
- **Workspace data exposure policy**: unchanged from D-08F.
- **Network policy**: reuses the existing D-08D connection.
- **Test requirements**: a test proving the sanitized event shape has an exact, closed field list (mirroring this codebase's own `Object.keys(...).sort()` exact-shape-check convention); a test proving a raw envelope containing an unexpected extra field cannot leak into the renderer-visible object.
- **Acceptance criteria**: above tests pass.
- **Blocking prerequisites**: D-08D and D-08E accepted (there is no meaningful event stream to render before a session/prompt exists).

### D-08H — Token persistence decision implementation
- **Allowed operations**: whatever a future, separate authorization specifies, contingent on the four conditions listed in the companion decision record's Section 3 ("Exact conditions before safeStorage/keychain support could be authorized").
- **Forbidden operations**: everything not explicitly specified by that future authorization.
- **Blocking prerequisites**: D-08B through D-08G (or whichever subset is live by then) already shipped and working correctly under memory-only credential handling; a demonstrated, specific need; its own dedicated threat-model update.
- All other fields: **not specified here** — this document explicitly declines to pre-design D-08H's implementation, per the companion decision record's own Section 3 conclusion that persistent storage is not being chosen now.

### D-09 or later — multimodel/provider/delegation capability
Explicitly out of this document's scope, per the authorization's own capability-ladder note. Blocked on its own separate service-side client-identity/token prerequisite (already noted as unimplemented in `app/api/multimodel/preview`'s own `start_blocked_reason`) and its own future explicit authorization.

---

## Part 6 — Future IPC contract design (conceptual only, not implemented)

```ts
window.vyronDesktop = {
  platform,
  capabilities,       // + hermesAvailable: boolean (whether ANY Hermes capability is compiled in) — everything else stays false until its own stage ships
  workspace: { /* unchanged from Milestone A */ },
  hermes: {
    getAvailability,       // D-08A/B — is the Hermes feature present in this build at all
    getConnectionState,    // D-08C
    getAuthorizationState, // D-08B
    beginAuthorization,    // D-08B
    clearAuthorization,    // D-08B
    getSessionState,       // D-08D
    createSession,         // D-08D
    endSession,            // D-08D
    submitPrompt,          // D-08E
    previewContext,        // D-08F
    attachContext,         // D-08F
    onEvent,               // D-08G
  }
}
```

| Method | Request schema | Response schema | Safe error classes | Can cause a network connection? | Can create/revoke session state? | Can access token memory? | Can access workspace data? | Sensitive value to renderer? | Requires explicit user confirmation? | Stage |
|---|---|---|---|---|---|---|---|---|---|---|
| `getAvailability` | none | `{ available: boolean }` | none (always succeeds) | No | No | No | No | No | No | D-08A/B |
| `getConnectionState` | none | `{ state: "unavailable"\|"not_attempted"\|"checking"\|"reachable"\|"unreachable" }` | none | Yes — one TCP probe | No | No | No | No | No (passive check) | D-08C |
| `getAuthorizationState` | none | `{ state: "not_configured"\|"not_granted"\|"granted" }` | none | No | No | Reads (never returns) the in-memory flag | No | No | No | D-08B |
| `beginAuthorization` | `{ token: string }` | `{ state: "granted" \| "rejected" }` | `invalid_token_format` (e.g. empty string) | No | No | Writes to main-process memory | No | No — the request *carries* the token (unavoidable for entry) but the *response* never echoes it | Yes — the entry action itself is the confirmation | D-08B |
| `clearAuthorization` | none | `{ state: "not_granted" }` | none | No | Revokes | Clears main-process memory | No | No | Yes — explicit "clear" action | D-08B |
| `createSession` | none | `HermesSessionState` (opaque handle) | `no_authorization`, `unavailable` | Yes — opens the WebSocket | Creates | Uses (never returns) | No | No | Yes | D-08D |
| `getSessionState` | none | `HermesSessionState` | none | No | No | No | No | No (handle is opaque) | No | D-08D |
| `endSession` | none | `HermesSessionState` (`"ended"`) | none | Closes the connection | Revokes | No | No | No | Yes — explicit "end session" action | D-08D |
| `submitPrompt` | `{ text: string }` | `{ state: "submitted"\|"no_session"\|"unavailable" }` | `no_session`, `unavailable` | Uses existing connection | No | Uses | No | No | Yes — explicit "Send" | D-08E |
| `previewContext` | `{ selections: ContextSelectionRequest[] }` | `ContextPreviewResult` (itemized, bounded) | `invalid_selection`, `stale_selection` | No | No | No | Yes — read-only, bounded, reuses `resolveWorkspacePath` | Only safe relative paths/bounded snippets, never absolute paths | No (preview is always safe to compute) | D-08F |
| `attachContext` | `{ selections: ContextSelectionRequest[] }` | `ContextAttachResult` | `invalid_selection`, `stale_selection` | No | No (marks state for the *next* submit, doesn't send) | No | Yes — same as above | Same as above | Yes — distinct from Preview | D-08F |
| `onEvent` | callback function (not IPC-serialized; a preload-local subscription) | sanitized `HermesEvent` objects over time | n/a (errors surface as a distinct sanitized event type, never a thrown exception across the bridge) | No (passive on an existing connection) | No | No | No (unless a future stage's event payload includes context echoes, which must themselves follow the same sanitization) | No | No (viewing is not a new consent point once a session is active) | D-08G |

### Explicitly prohibited (restated from the authorization, confirmed still prohibited by this design)

`window.vyronDesktop.hermes.invoke`, `.send`, `.on` (generic), `.rawSocket`, `.token`, `.getToken`, `.setToken`, `.getEnvironment`, `.connectArbitraryUrl`, `.startMultimodel`, `.executeTool` — none of these appear anywhere in the table above, and none should ever be added without its own dedicated future authorization that also updates the threat model.

### No renderer may ever receive (restated, confirmed by the table above)

Raw token, token-derived secret, WebSocket object, raw JSON-RPC transport, raw protocol messages, a generic event emitter, an arbitrary endpoint URL, an environment value, an OS credential handle, the canonical workspace root, or an absolute path. Every response schema in the table above was designed to satisfy this list by construction (opaque handles, enum states, bounded/relative-only content).

---

## Part 7 — Future UX specification (conceptual only, not implemented)

### Required distinguishable states

| State | Meaning | Corresponds to |
|---|---|---|
| Hermes not configured | The build has no Hermes capability compiled in at all | `getAvailability` → `false` |
| Feature intentionally unavailable in this build | Same as above, phrased for the user | same |
| Authorization not granted | No token has been entered this process lifetime | `getAuthorizationState` → `not_granted` |
| Authorization pending | The entry action is in flight | transient renderer-local state around `beginAuthorization`'s promise |
| Authorization granted for current process only | Token accepted, memory-only, will not survive restart | `getAuthorizationState` → `granted`, plus explicit copy saying "for this session only" |
| Connection not attempted | User hasn't checked/connected yet | `getConnectionState` → `not_attempted` |
| Connecting | A check or session-create is in flight | transient |
| Connected | `getConnectionState` → `reachable`, or `getSessionState` → `active` |
| Connection unavailable | `getConnectionState` → `unreachable` or `unavailable` |
| Session not created | `getSessionState` → `no_session` |
| Session active | `getSessionState` → `active` |
| Session expired/revoked | `getSessionState` → `ended`, or after `clearAuthorization` |
| Safe failure | Any of the above methods' defined error classes — always a short, safe, generic message; never a raw error |

### UX requirements (restated with source, confirmed as this document's own binding design constraints)

- No token displayed after entry; no token echoed in confirmation text (only a generic "Authorization granted" message, per the table above's `beginAuthorization` response shape).
- No token copied automatically; no token written to application logs (extends the existing, tested diagnostic-logging discipline).
- No token in DOM attributes, form values after submission (the entry field should be cleared immediately after successful submission — a renderer-local UX detail, not an IPC concern, but stated here so a future implementer doesn't overlook it), persistent state, browser storage, report files, or test snapshots (every future test must follow this document's own convention of never constructing a test with a real-looking token value beyond an obviously-fake placeholder like `"fake-token-for-test"`).
- The user explicitly approves any operation that starts a connection, creates a session, sends a prompt, sends workspace context, or initiates multimodel work — each such action in Part 6's table is marked "Requires explicit user confirmation: Yes," and no method not so marked may ever gain that capability without a corresponding UX/IPC redesign.
- Workspace context defaults to "nothing will be sent" — `previewContext`/`attachContext` (D-08F) are opt-in, itemized, and reviewable, mirroring the web app's own `app/api/multimodel/preview` `will_send`/`will_not_send` pattern exactly.
- Any future context send provides an explicit reviewable preview: file display name/relative path, selected lines or bounded snippet, approximate size, and destination/session identity — this is `ContextPreviewResult`'s own required shape (Part 6).
- Prompt and context are visibly separate user actions — `submitPrompt` (D-08E) and `attachContext` (D-08F) are two distinct preload methods, two distinct UI actions, never combined into one "send everything" button.
- No background connection/retry loop by default — `getConnectionState` only runs when the user opens/refreshes the relevant panel (D-08C's own stage definition); no automatic polling.
- No automatic session resume unless a future, separately-approved design permits it — under Option A (memory-only token), there is nothing to resume across a restart in any case; this requirement remains relevant only if D-08H (persistence) is ever authorized.

## Not authorized in this task

No token entry UI, no `safeStorage`/keychain use, no real IPC channel, no actual `window.vyronDesktop.hermes` object, and no network/Hermes/provider/deliberation activity of any kind was created, connected to, or exercised in producing this design document.
