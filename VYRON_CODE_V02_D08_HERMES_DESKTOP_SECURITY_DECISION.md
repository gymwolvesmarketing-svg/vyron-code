# VYRON_CODE_V02_D08_HERMES_DESKTOP_SECURITY_DECISION

Architecture and security decision record only. **No Hermes connection, session, prompt, token read, keychain access, or network request of any kind was performed to produce this document.** Every fact below is either (a) confirmed repository evidence, explicitly labeled, or (b) a recommendation/assumption, explicitly labeled as such. All example values (tokens, URLs, IDs) are placeholders.

---

## Part B — Read-only Hermes discovery in the existing v0.1 web app

### B.1 — What Hermes operations currently exist (confirmed evidence)

Source: `lib/hermesClient.ts`, `app/api/hermes/*/route.ts`, `lib/hermesEvents.ts`, `lib/pendingRequest.ts`.

| Operation | Route | RPC method(s) | Classification |
|---|---|---|---|
| Reachability check | `GET /api/hermes/health` | none — a raw TCP `net.connect` probe, immediately closed | Read-only, no session/token use at all |
| Session creation | `POST /api/hermes/session` | `session.create`, `session.activate` | Session lifecycle, state-changing (creates a Hermes-side session) |
| Prompt submission | `POST /api/hermes/prompt` | `prompt.submit` (fire-and-forget; response arrives via events) | Prompt/response, state-changing |
| Approval/clarify response | `POST /api/hermes/respond` | `approval.respond` / `clarify.respond` | Prompt/response continuation, state-changing |
| Session interrupt | `POST /api/hermes/interrupt` | `session.interrupt` | State-changing (interrupts an in-flight turn) |
| Event streaming | `GET /api/hermes/events` (Server-Sent Events) | none — subscribes to the shared client's push-frame events, scoped by local session ID | Event streaming, read-only from the caller's perspective |
| Context attach (Vyron-side only) | `POST /api/context/attach` | none — no Hermes call; only re-validates and marks local SQLite rows as "attached" | Context attachment, local-only, never itself talks to Hermes |
| Multimodel preview | `POST /api/multimodel/preview` | none — returns a "what would be sent" preview only; **there is deliberately no `/api/multimodel/start` route anywhere in this codebase** | Blocked/deferred by the web app's own design, not merely by convention |

No filesystem-mutating or shell/CLI-exec Hermes method is ever called — confirmed by `lib/hermesClient.ts`'s own header comment and cross-checked against the six method names actually invoked above.

### B.2 — Server-side modules that talk to Hermes (confirmed evidence)

Exactly two: `lib/hermesClient.ts` (the JSON-RPC-over-WebSocket client itself) and `lib/hermesEvents.ts` (fans out the shared client's push events to per-session SSE subscribers). Both are marked "SERVER-SIDE ONLY" in their own header comments, imported only from `app/api/hermes/*.ts` route handlers, and — per `VYRON_CODE_V01_HERMES_WS_SMOKE_TEST_REPORT.md` (referenced, not re-verified this task) — confirmed absent from the browser-served JS bundle by scanning for both the `ws` module marker and the token string itself.

### B.3 — Protocol facts relevant to desktop trust-boundary design (confirmed evidence, from `lib/hermesClient.ts`)

- Endpoint: `ws://<host>:<port>/api/ws?token=<HERMES_SESSION_TOKEN>` — **the token is carried as a URL query parameter**, not a header. This is a real, disclosed protocol characteristic of the existing Hermes gateway, not something Vyron Code chose; any desktop implementation inherits it and must treat the assembled connection URL itself as sensitive (never logged, never included in a crash report, never passed through any generic URL-logging path).
- The server enforces `Origin` = `http://<host>:<port>` exactly, a matching `Host` header, and a loopback-only peer — all three checked server-side by Hermes itself, not by this client.
- The client library used is `ws` (not the WHATWG `WebSocket`) specifically because it is the one capable of setting the `Origin`/`Host` handshake headers Hermes requires.
- The token today is sourced **only** from `process.env.HERMES_SESSION_TOKEN` — a live server-process environment variable, explicitly never written to `.env.local`, never logged, never returned to any caller, and the client fails closed (throws) if it is absent.
- v0.1 calls only the "read/chat-safe subset": `session.create`, `session.activate`, `prompt.submit`, `approval.respond`, `clarify.respond`, `session.interrupt`.

### B.4 — Which current interfaces are conceptually reusable in Electron, and which are not

**Not reusable as-is** — `lib/hermesClient.ts` itself. It is a Node.js server-process module (`import WS from "ws"`) that assumes it runs inside a trusted Next.js server process with its own environment-variable access. In Electron, the *conceptual* equivalent (a WebSocket client holding the token, calling the same six methods) would need to live in the **main process only** — never the renderer, never the sandboxed preload — for exactly the same trust reasons the web app's own server/browser split already enforces. This is a re-hosting of the same design, not a reusable browser-side artifact.

**Reusable conceptually, not literally**:
- The **method allowlist** itself (`session.create`/`session.activate`/`prompt.submit`/`approval.respond`/`clarify.respond`/`session.interrupt`) is a safe, already-vetted starting scope for whatever the desktop main process is eventually authorized to call — reusing this list (rather than inventing a new one) is the recommended default for any future D-08B/C/D/E authorization.
- `lib/pendingRequest.ts`'s pure event-parsing logic (`parsePendingRequestEvent`, `buildRespondPayload`, `canSubmitPendingResponse`) is environment-agnostic pure functions with no Node/browser-specific dependency — genuinely reusable, verbatim, in a future desktop renderer once event data reaches it through a safe IPC channel.
- `lib/hermesEvents.ts`'s per-session fan-out pattern is a reasonable conceptual model for a future main-process-side event router, though its current implementation is tied to `lib/sessions.ts`'s SQLite-backed session store, which the desktop model does not want to reuse (see B.5).

**Cannot be reused because the trust boundary differs**:
- `app/api/hermes/*` route handlers assume an HTTP request/response and a browser `fetch` caller across a network boundary (even if that network is `localhost`). Electron's IPC is a different, in-process trust model (`ipcMain.handle`/`contextBridge`), not an HTTP route — the *shape* of validation (never trust a renderer-supplied argument) carries over, but the transport-level code does not.
- `lib/sessions.ts`'s SQLite persistence of session metadata (`getSession`, `touchSessionActivity`, `setSessionStatus`, `renameSession`) is the web app's own local database, entirely separate from — and not to be reused by — the Electron desktop app, which currently has **zero** persistence of any kind (Milestone A's own accepted, unmodified constraint). Reusing this module would silently reintroduce persistence the desktop track has not authorized.
- `lib/contextPayload.ts`/`lib/contextSelections.ts`'s context-attachment model assumes a *project*, registered once via `lib/canonicalPath.ts`'s web-app-specific project registry (`lib/projects.ts`, itself SQLite-backed) — the desktop app's workspace grant (`electron/workspace-grant.ts`) is a different, in-memory-only, single-grant model. The *validation shape* (fresh re-validation immediately before every send, fail-closed on any staleness) is exactly the right pattern to carry forward conceptually into a future desktop context-attachment stage (D-08F), but the concrete module is not importable as-is.

### B.5 — Assumptions incompatible with Electron sandboxing/token confinement (confirmed evidence + analysis)

1. `getHermesClient()`'s reliance on `process.env.HERMES_SESSION_TOKEN` being present in the **same process** that also serves the UI is safe in the web app (one Node.js server process, no renderer-side JS ever runs there) but would be **unsafe if copied unchanged into Electron's main process without further containment**, because the main process also owns `BrowserWindow`/`ipcMain` wiring; a bug that accidentally exposed "the current environment" to a preload/renderer bridge method would leak the token. This is exactly why Section 6 of this record (below) explicitly forbids any `getEnvironment` IPC method.
2. The web app's `/api/hermes/events` SSE route trusts `req.url`'s `session_id` query parameter after checking it against the **local** SQLite session store (`getSession`) — safe there because the local session store is itself server-only. A desktop equivalent must not let the renderer supply an arbitrary Hermes-side session identifier at all; the main process must be the only party that ever holds a real Hermes session ID, exposing only an opaque, main-process-issued handle to the renderer (mirroring the existing `workspaceId` pattern already used by `electron/workspace-grant.ts`).
3. Nothing in the current web app exposes a raw WebSocket, a generic RPC `call()` method, or the token itself to the browser — this is already the correct posture and is the one to preserve, not weaken, in Electron.

### B.6 — What data currently reaches browser-facing code in v0.1 (confirmed evidence)

From `lib/apiClient.ts` (the browser-side fetch wrapper) and the route handlers it calls: project display names and IDs (never the canonical/absolute root — confirmed by its own header comment: "no secret or Hermes/Bridge URL is ever referenced from client code"), context-item metadata (kind, relative path/ref, char/token counts, attached flag, staleness, a bounded preview string), conversation summaries (title, status, timestamps, message count), and Hermes event payloads relayed verbatim over SSE (message deltas, tool-call status, reasoning text) — **not** the raw JSON-RPC envelope, not the token, not the canonical workspace root.

### B.7 — What must never reach Electron renderer code (recommendation, building on confirmed v0.1 posture)

The Hermes token itself, the WebSocket/`ws` client object, the raw JSON-RPC transport or envelope, any Hermes-side session ID in a form the renderer could reuse to construct its own request, `HERMES_HOST`/`HERMES_PORT`/any environment variable, the canonical workspace root (already enforced, unrelated to Hermes), and any raw error/stack trace from the Hermes client. This list is the desktop-specific tightening of the already-safe v0.1 posture described in B.6, made explicit because the renderer/preload boundary is a harder, code-enforced trust boundary than "just don't put it in this API response."

### B.8 — Minimum safe initial desktop Hermes scope (recommendation)

**D-08A only** (this document and its siblings) — architecture, threat model, and decision record, with zero runtime capability. The **first runtime-capable** stage should be **D-08C** (health/connectivity status only, main-process-only, no session/token exposure to the renderer beyond a boolean/enum) — see Section 5 of the companion IPC/UX spec document for why D-08B (authorization UX) is sequenced before any status check reaches the renderer, and why prompt/context/session capabilities (D-08D onward) are deferred further still.

### B.9 — Features that must remain deferred (recommendation)

Everything from session creation (D-08D) onward, all multimodel/deliberation capability (already blocked in the web app itself — B.1), any token persistence (Section 3 below), and any workspace-context attachment to a Hermes prompt (D-08F) — each requires its own future, separately-scoped authorization, exactly as this document's own capability ladder (companion document) lays out.

---

## Part 3 — Token and session decision record

### Options considered

| Option | Description |
|---|---|
| **A** | Memory-only token, supplied fresh for the current application process's lifetime only (never written to disk). |
| **B** | Electron `safeStorage`-backed encrypted token persistence (Windows DPAPI-backed). |
| **C** | Operating-system credential/keychain integration (Windows Credential Manager). |
| **D** | Environment-variable or configuration-file token source. |
| **E** | No token support in the current Electron milestone. |

### Evaluation

| Criterion | A (memory-only) | B (safeStorage) | C (OS keychain) | D (env/config file) | E (none) |
|---|---|---|---|---|---|
| Renderer exposure risk | None (main-process-only, never bridged) | None (same) | None (same) | None if main-process-only; **high** if ever read via a config file the renderer could reach | None (feature absent) |
| Main-process exposure risk | Low — token exists in process memory only while the app runs | Low — encrypted at rest, decrypted into memory only on use | Low — similar to B, plus an extra OS-call surface | Medium — a config file on disk is a persistent artifact that could be copied/backed up | None |
| Persistence risk | **None by design** — gone on process exit | Present — that is the point, mitigated by OS-level encryption tied to the user account | Present — mitigated by OS keychain ACLs | Present, **unencrypted** unless the user manually protects the file | None |
| Malware/local-user threat model | Best — nothing to steal once the process exits | A local-admin/same-user malware process can typically request `safeStorage` decryption too (DPAPI is tied to the *user account*, not to this specific app) — real but bounded risk | Similar bound to B, via Credential Manager ACLs | Worst — a plain file is trivially copyable by any process running as the same user | Best — no token exists anywhere |
| Process-memory risk | Present while running (same as every option below) | Present while running | Present while running | Present while running | N/A |
| Debug/log leakage risk | Low if disciplined (this record requires it) | Same discipline required, plus must never log the decrypted value | Same | **Higher** — a config file's own path/content is more likely to be accidentally included in a support bundle or screenshot | None |
| Crash/report leakage risk | Bounded to one process lifetime; a crash dump taken *during* a live session could still contain it in memory — an inherent risk of any in-memory secret, not specific to this option | Same in-memory risk while decrypted for use; the *at-rest* artifact itself is encrypted | Same | Same in-memory risk, **plus** the at-rest file itself could appear in a backup/crash-adjacent file collection | None |
| Backup/sync leakage risk | None — nothing written to disk | Low — the encrypted blob is meaningless without the same Windows user account/machine, but a naive OneDrive/backup tool could still sync the encrypted file (harmless without the DPAPI key, but still an artifact) | Low — OS keychain stores are not typically included in naive file-level backups, a genuine advantage over B | **High** if the config file sits in a synced folder (e.g. a project directory under OneDrive) | None |
| Windows portability | Full — no OS-specific API | Full — `safeStorage` is available on Windows (DPAPI-backed), and Electron documents this cross-platform API | Full — Electron's `safeStorage` already brokers this on Windows | Full but fragile (user-managed file location) | Full (feature absent) |
| User recovery/revoke/clear behavior | Trivial — clear = close app, or an explicit in-app "forget for this session" action that just drops the in-memory value | Requires an explicit "clear stored credential" action that deletes the encrypted file/keychain entry — more UI/logic surface | Same as B | Requires the user to manually edit/delete a file — worst UX for revoke | Trivial — nothing to revoke, ever |
| UX clarity | Very clear: "you'll re-enter this every time you launch the app" | Requires clearly communicating persistence + where/how to revoke | Same, plus explaining what "the Windows Credential Manager" even is to a non-technical user | Poor — asking a user to hand-edit a config file is a worse first-run experience than any of the above | Simplest possible UX: the feature does not exist yet |
| Implementation complexity | **Lowest** — a single in-memory variable in the main process, an IPC method to set it, one to clear it | Medium — `safeStorage.encryptString`/`decryptString`, a file read/write, an explicit clear path, and its own test strategy for "encryption available" vs. not | Medium-high — an OS keychain wrapper library or native binding, plus the same test-strategy burden | Low to implement, but pushes complexity onto the user (file format, location, permissions) | None |
| Testability without real secrets | Excellent — a fake in-memory string is trivially mockable | Good — `safeStorage`'s own API is mockable, but "is encryption available on this machine" is itself an environment-dependent condition that complicates CI | Similar to B, often worse (OS keychain access in CI is harder to mock realistically) | Easy to test the file I/O, but the "user must protect this file" requirement is not something a test can verify | Trivial (nothing to test) |
| Compatibility with sandboxed preload | Full — the token never needs to reach the preload/renderer boundary at all under this option | Full — same reasoning; persistence happens entirely in the main process | Full — same | Full if main-process-only; **breaks** if the renderer is ever given a path to read | Full (trivially) |
| Compatibility with current local-only/read-only desktop model | **Best fit** — Milestone A's entire design principle is "nothing survives process exit"; this option is the direct extension of that principle to credentials | Introduces the *first* persistence mechanism in the entire desktop app — a real, deliberate departure from Milestone A's accepted model, not to be taken lightly | Same departure as B, via a different mechanism | Same departure, with weaker protection than B/C | No departure — extends the existing "nothing persists" model by simply not adding the feature yet |
| Future multi-account/session support | Requires re-entry per launch regardless of account count — scales fine, just repetitive | Naturally extends to multiple named encrypted entries later | Naturally extends via multiple keychain entries later | Naturally extends via multiple config sections, with the same weak-protection caveat | N/A until some option is chosen |
| Auditability | High — "was a token ever written to disk" is trivially true/false (no) | Requires verifying the encryption call sites and that decrypted values never leak into logs — more surface to audit | Same, plus an external OS API to trust | Requires verifying file permissions and that the file is never picked up by search/backup tooling | Trivial — no code path to audit |

### Decision

**Recommended option for the first Hermes desktop capability: Option A — memory-only, process-lifetime-only token, or Option E (defer entirely) for any stage that does not yet need a real connection.**

This is not a close call given the evidence: this authorization's own Section 3 default preference states plainly that persistent storage must not be chosen "merely for convenience," and its own forbidden-actions list (Section "Mission") explicitly excludes `safeStorage`, keychain/Credential Manager use, and environment-variable token loading from *this task's own scope* — meaning even discovery-level use of those mechanisms is out of bounds here, let alone recommending their immediate adoption. Separately, and independently, the D-01 architecture decision record (`VYRON_CODE_V02_DESKTOP_ARCHITECTURE_DECISION.md`, Section 20, already accepted and on the books before this task) already narrowed the field to exactly Option A or Option B for D-08, and explicitly left the choice to this document. Given the evaluation table above — Option A is strictly lower-risk, lower-complexity, and better-aligned with Milestone A's own accepted "nothing survives process exit" model, with no persistence-specific threat surface to defend at all — Option A is the correct choice for the *first* capability that needs a token in memory at all (D-08B, per the capability ladder).

**Options B and C are not rejected outright** — they remain plausible for a *future*, separately-authorized stage once a real, demonstrated user need for cross-launch persistence exists (e.g., a user who launches the desktop app many times per day and finds re-entry genuinely burdensome) and once that stage's own dedicated authorization can specify the exact encryption/clear/revoke/audit requirements this record's evaluation table surfaces. They are not chosen now because no such demonstrated need exists yet, and choosing persistence "because it's more convenient" is explicitly the failure mode this authorization tells this record to avoid.

**Option D is rejected, not merely deferred** — every criterion above shows it strictly dominated by Option A (equal or worse on every axis, with meaningfully worse backup/sync and revoke properties) with no offsetting advantage. There is no future scenario in which Option D would be preferable to B or C if persistence is ever wanted.

**Option E remains valid and is explicitly the right choice for every stage before D-08B itself** — D-08A (this document) needs no token at all; D-08C (health/connectivity check) is designed below to need no token either.

### Explicit answers required by Section 3

- **Recommended option for the first Hermes desktop capability**: Option A (memory-only, process-lifetime), first exercised at D-08B.
- **Why other options are rejected/deferred**: B and C deferred pending demonstrated need and their own future authorization (see above); D rejected outright (strictly dominated); E remains correct for every capability that needs no token (D-08A, D-08C).
- **Is token persistence allowed at all in v0.2, right now**: **No.** Consistent with both this record's own default preference and the D-01 decision record's explicit statement that "No token persistence implementation of any kind is approved by this document" — that remains true of this document too.
- **Must the user re-enter/re-authorize after app restart**: **Yes**, under Option A — by design, since nothing survives process exit. This is a deliberate UX tradeoff accepted in exchange for zero persistence-related attack surface.
- **How token clear/revoke must work**: an explicit, user-initiated "clear authorization" action (see the IPC/UX spec's `clearAuthorization` method) drops the in-memory value immediately and returns the app to the "authorization not granted" state — no confirmation dialog needed beyond the action itself, since there is nothing persisted to warn about losing.
- **May the token ever appear in renderer state, DOM, logs, errors, IPC, test snapshots, crash reports, clipboard, or generated files?** **No, under any option, at any stage.** This is unconditional and does not depend on which option is chosen — it is a property of the IPC contract design (Section 6 of the companion document), not of the storage mechanism.
- **Exact conditions before safeStorage/keychain support could be authorized in a later task**: (1) a demonstrated, specific user-facing need for cross-launch persistence, not a hypothetical one; (2) D-08B through D-08E (or whichever stages are live by then) already shipped and working correctly under Option A; (3) a dedicated future authorization that specifies, at minimum: the exact encryption API calls, the exact clear/revoke UX, a test strategy for "encryption unavailable on this machine," and an explicit statement of what changes (if anything) about the threat model in Section 4 of the companion document; (4) no regression to any Milestone A security invariant.

---

## Not authorized in this task

Everything the authorization's own "does NOT authorize" list names: a real Hermes connection, a WebSocket connection, a token entry UI, token storage, `safeStorage` use, keychain/Credential Manager use, environment-variable token loading, token/keychain discovery or reading, secret scanning outside source candidates, a provider/model request, Hermes session creation, prompt submission, response handling, or interrupt, multimodel/delegation start, any browser/network request, file write, Git write, or terminal/shell capability. Nothing in this document's production performed any of these — every fact above was obtained by reading existing, already-committed source files, plus the read-only `git` commands listed in the sibling hygiene document.
