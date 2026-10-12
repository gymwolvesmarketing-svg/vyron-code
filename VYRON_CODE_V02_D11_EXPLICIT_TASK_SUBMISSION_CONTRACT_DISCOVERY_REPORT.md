VYRON_CODE_V02_D11_EXPLICIT_TASK_SUBMISSION_CONTRACT_DISCOVERY_REPORT

- Authorization scope: VYRON_CODE_V02_D11_EXPLICIT_TASK_SUBMISSION_CONTRACT_DISCOVERY — read-only, evidence-driven discovery of the real Hermes API Server's task/chat request contract, to determine whether a minimal D-11 (explicit reviewed task submission) can be safely specified. No implementation, no Git changes, no POST/task/chat/run request to Hermes.
- Repository root: D:\Vyron Code
- Branch: master
- HEAD: 090f062 "fix(desktop): unblock Hermes authorization and endpoint configuration"
- Remotes: none
- Local Hermes version: 0.21.0 (VERIFIED_LOCAL_SOURCE — `pyproject.toml`/`PKG-INFO`; also independently echoed by the live `/health` response body in the prior task)
- Local Hermes source inspected: `gateway/platforms/api_server.py`, `gateway/platforms/api_server_openai_routes.py`, `gateway/platforms/api_server_runs.py`, `hermes_cli/tools_config.py`, `hermes_cli/config_defaults.py`, `toolsets.py`, all under `%LOCALAPPDATA%\hermes\hermes-agent`
- Official sources inspected: none newly fetched this task (prior discovery phases already established the API Server's general existence and purpose from hermes-agent.nousresearch.com docs; this task deliberately prioritized real installed source per its own instruction, since the official docs do not resolve tool-safety/auth-per-route questions at this level of detail)
- Local runtime/config/secrets inspected: `%LOCALAPPDATA%\hermes\config.yaml`'s `platform_toolsets` section (key names/structure only, no secrets); presence-only check that `api_server` has no explicit entry there
- Local read-only runtime requests made: `GET http://127.0.0.1:<redacted-port>/v1/models` (no Authorization header sent) → `HTTP 401`, body `{"error":{"message":"Invalid gateway API key (API_SERVER_KEY)",...}}`. No other live request was made (`/health`/`/v1/health` were not re-tested this task; already confirmed in the prior task).
- POST/chat/task/run/session requests made: none
- Applications/browser/Electron launched: none
- Source/tests/config/docs modified: none
- Git state modified: none
- D-10 API Server health verification preserved: yes — untouched by this discovery

## A. Correct D-11 endpoint

Three POST endpoints exist on the installed server: `POST /v1/chat/completions`, `POST /v1/responses`, `POST /v1/runs` (VERIFIED_LOCAL_SOURCE — `api_server.py`'s `_http_route_table()`).

- `/v1/chat/completions` — OpenAI Chat Completions format. Smallest, most standard, most stable shape of the three. (VERIFIED_LOCAL_SOURCE)
- `/v1/responses` — OpenAI Responses format; adds `previous_response_id`/`conversation` chaining and server-side response storage (`store: true` by default) — strictly more stateful/complex than chat/completions for no D-11 benefit. (VERIFIED_LOCAL_SOURCE)
- `/v1/runs` — its own module's docstring: "Durable `/v1/runs` admission, status, events, and control handlers" — explicitly a durable/background/long-running execution surface, the opposite of a single bounded request. (VERIFIED_LOCAL_SOURCE)

**If D-11 were to proceed, `POST /v1/chat/completions` would be the smallest and most appropriate** of the three — but see Section I: this conclusion is moot because the endpoint fails the tool-safety gate regardless of which of the three is chosen (all three run the same full-tool agent).

Endpoint contract for `/v1/chat/completions` (VERIFIED_LOCAL_SOURCE, `api_server_openai_routes.py:409-574`):
- Method: `POST`. Path: `/v1/chat/completions`.
- Required request header: `Content-Type: application/json` (implicit; body is parsed as JSON).
- Authorization: **not enforced by this handler** — see Section B; this is a significant, directly-verified finding, not an assumption.
- Required JSON field: `messages` (non-empty array; the last `user`/`assistant`-role message becomes the outbound turn, `system`-role messages become an ephemeral system prompt).
- Optional JSON fields observed in source: `stream` (bool, default `false`), `model` (string; falls back to the server's own configured default if omitted).
- Fields read into a cache "fingerprint" but never enforced or forwarded to control agent behavior: `tools`, `tool_choice`, `provider`, `model_options` (VERIFIED_LOCAL_SOURCE, line ~536) — sending them has no effect on what the agent is allowed to do.
- Fields that must never be sent by Vyron Code: `X-Hermes-Session-Id` header (continues a real, persisted server-side session by id — requires its own API-key gate, and is exactly the kind of session-lifecycle capability D-11 must not reintroduce) and `X-Hermes-Session-Key` header (scopes long-term memory).
- No documented maximum task-text length was found in this handler (only a whole-request byte cap, `MAX_REQUEST_BYTES`, enforced by `body_limit_middleware`, VERIFIED_LOCAL_SOURCE).
- Model field required: no — `model_name = body.get("model", self._model_name)` (VERIFIED_LOCAL_SOURCE, line 487) confirms a safe server-configured default exists and omitting `model` is fully supported.

## B. Authentication

- `GET /v1/models` requires `Authorization: Bearer <API_SERVER_KEY>` — VERIFIED_LOCAL_RUNTIME_READONLY (a bare `GET` with no header returned `HTTP 401`/`gateway_auth_failed` just now) and VERIFIED_LOCAL_SOURCE (`@_require_auth` decorator immediately precedes `_handle_models` at `api_server.py:2209`).
- **`POST /v1/chat/completions` and `POST /v1/responses` have no `@_require_auth` decorator, no inline `_check_auth()` call, and no other auth-enforcing decorator anywhere in `api_server_openai_routes.py`** (VERIFIED_LOCAL_SOURCE — confirmed by three independent checks: (1) the two lines immediately preceding each `async def` contain no decorator; (2) a full-file grep for `_check_auth`/`_require_auth`/`Authorization` finds only 2 hits, both belonging to the unrelated `_handle_get_response`/`_handle_delete_response` handlers; (3) the three registered `aiohttp` middlewares — `cors_middleware`, `body_limit_middleware`, `security_headers_middleware` — do only what their names say and perform no authentication of any kind). This was **not** independently empirically confirmed by a live POST, since this task explicitly forbids sending one; it is a source-level finding only, and should be treated as a serious, separately-flaggable finding about the installed Hermes Agent itself, independent of D-11.
- The API key mechanism, where enforced, is a single flat Bearer token compared with `hmac.compare_digest` — no scopes, no per-endpoint permission model (VERIFIED_LOCAL_SOURCE, `_check_auth`, `api_server.py:1354-1376`).
- No cookie, query-string token, WebSocket token, or dashboard-ticket mechanism is involved in this surface; `Authorization: Bearer` is the only credential transport used anywhere it is enforced (VERIFIED_LOCAL_SOURCE).
- The same `API_SERVER_KEY` already configured for `/health`'s (non-)requirement is the one relevant key; Vyron Code's existing D-08B/D-10 credential boundary already holds this value main-process-memory-only and would need no new capability to attach it as a header if this endpoint enforced it.

## C. Non-streaming request/response model

- `stream: false` is supported and is the default when the field is omitted (`_coerce_request_bool(body.get("stream"), default=False)`, VERIFIED_LOCAL_SOURCE). D-11 can simply omit `stream` or set it explicitly to `false`.
- Non-streaming response shape (VERIFIED_LOCAL_SOURCE, lines 561-566):
  `{"id", "object": "chat.completion", "created", "model", "choices": [{"index": 0, "message": {"role": "assistant", "content": <string>}, "finish_reason"}], "usage": {...}}`, with an optional `hermes` extras object only on partial/failed completions.
- No `tool_calls` array, reasoning block, citation, image, or file-path field appears in this specific response dict — the assistant's final natural-language text is returned as a plain string in `choices[0].message.content`. This field **can** be safely reduced to a bounded text-only value for a renderer.
- **Task submission itself can change files, Git state, Hermes memory, sessions, and more** — see Section I; the agent that produces `final_response` is the same full-capability agent used everywhere else in Hermes, not a sandboxed completion-only model.
- Tool execution does not require a separate request — it happens synchronously, inside the single POST, before the response is returned (VERIFIED_LOCAL_SOURCE — the streaming branch's `tool_start_callback`/`tool_complete_callback` wiring proves tool calls occur mid-request; the non-streaming branch runs the identical agent via `self._run_agent(**run_kwargs)`, just without surfacing per-tool progress events).

## D. Model handling

Evidence: `model_name = body.get("model", self._model_name)` (VERIFIED_LOCAL_SOURCE) — the server always has a configured default model and using it requires nothing from the client.

| Strategy | API compat | UX | Renderer attack surface | New IPC/model-list request | Fit for D-11 |
|---|---|---|---|---|---|
| A. Omit `model`, use server default | Full | Simplest — no picker | None | None | Best fit |
| B. Explicit user-visible model picker | Full | Adds a decision the user doesn't need | New provider/model surface (forbidden scope) | Yes | Out of scope |
| C. Fixed local constant model name | Full, if the name matches a real model/alias | Same as A but brittle across installs | None | None | Worse than A (guesses a name that may not exist on every install) |
| D. `GET /v1/models` + let user choose | Full, but requires Authorization (Section B) | Adds a picker for no proven benefit at D-11's scope | New model-list capability | Yes | Unnecessary |

**Recommended strategy: A — omit `model` entirely and let the server's own configured default apply.** This needs no new IPC capability, no provider/model UI (which is explicitly forbidden scope), and is the only strategy consistent with "no model/provider exposure unless strictly required by proven API contract" — nothing in the proven contract requires it.

## E. D-11 input boundary

(Transport/size/rendering boundary only, per the mission's own instruction — not content filtering.)

- Minimum non-whitespace length: > 0 after `.trim()`, mirroring the existing `hermesAuthorization.ts`/`hermesEndpointSetup.ts` convention already used elsewhere in this codebase.
- Maximum character count: no server-documented limit was found for `messages[].content` specifically; only the whole-request `MAX_REQUEST_BYTES` body cap exists server-side (VERIFIED_LOCAL_SOURCE). A client-side bound (e.g. matching this codebase's existing `MAX_DRAFT_LENGTH` used by `taskComposer.ts`) is a reasonable, already-established local convention, not a server requirement.
- Maximum UTF-8 byte count: bounded transitively by `MAX_REQUEST_BYTES` once the draft is wrapped in the JSON envelope; no separate per-field byte limit found.
- Newline handling: `messages[].content` is a plain string; newlines are valid content, no special handling required.
- Control character / NUL handling: not explicitly validated by this endpoint in source; this codebase's own established pattern (`taskComposer.ts`'s `control_characters` draft-validation reason, already used for the local-only task draft today) should be reused rather than trusting the server to reject them.
- HTML/Markdown/URL handling: the field is opaque text to the server; safety here is entirely a *rendering* concern for D-11's own response display (see Section G), not a request-construction concern.
- Prompt-injection text handling: explicitly out of scope per the mission's own instruction — the user's own task text must not be content-filtered by Vyron Code.
- Unicode normalization: not required by anything found in source; the field is passed through as an opaque string.

## F. Explicit review and consent

Implementation-free safe flow (matches the mission's own template exactly, refined with evidence-based detail):

```
Draft local only (existing taskComposer.ts draft state, unchanged)
→ User clicks "Review task draft" (existing D-09 review surface, unchanged)
→ UI displays the exact outbound text verbatim, plus declared metadata:
   "This will be sent to your local Hermes API Server. No model, provider, or
    tool selection is included — model omitted (server default: [safe fixed
    label]). No file, workspace, search, or Git data is attached."
→ User explicitly clicks "Send reviewed task" (a new, distinct action from
   today's read-only review — must not be conflated with "Review task draft")
→ Main process independently re-validates: authorization still active,
   endpoint still configured+trusted, draft still within bounds, and no other
   send already in flight (one-in-flight, mirroring hermesApiServer.ts's own
   verifyInFlight pattern)
→ One non-streaming POST /v1/chat/completions is sent, stream:false, no
   model field, messages: [{role:"user", content: <draft>}] only
→ Safe pending/completed/failure state appears
```

**Recommended confirmation level: one explicit button ("Send reviewed task"), no second dialog, no typed phrase, no checkbox beyond what already exists.** This is proportionate for a local, user-owned, loopback-only, single-user application where the user has already explicitly authorized Hermes and explicitly configured the endpoint — two prior explicit gates already exist before this one. A second confirmation would not meaningfully change the safety picture given the review screen already shows the exact outbound text, and this codebase's own established D-08E precedent (one explicit checkbox + one submit, no double-confirmation) supports proportionality over ceremony. This recommendation is **conditioned on Section I's finding being resolved first** — see the D-11 safety conclusion below.

## G. Response boundary

- Safe response text field: `choices[0].message.content` (VERIFIED_LOCAL_SOURCE, Section C) — a single plain string, nothing else.
- Absent/non-text/multiple-block handling: the observed shape only ever has exactly one `choices` entry with a string `content`; a defensive D-11 implementation should still treat a missing/non-string `content` as `safe_failure` rather than assume the shape can never change.
- Reasonable maximum renderer response size: a fixed client-side truncation bound (e.g. a few thousand characters), independent of the server's own `usage`/token accounting, consistent with this codebase's existing bounded-excerpt conventions (`MAX_SINGLE_EXCERPT_CHARS` in `taskComposer.ts`).
- Markdown: render as plain text only for D-11 (no Markdown rendering) — nothing in the proven contract requires rich rendering, and it minimizes rendering-layer attack surface.
- HTML: must be escaped/treated as plain text — the field is untrusted model output.
- Tool calls: none appear in this response shape to reject (Section C) — but the `hermes` extras object (present only on partial/failed completions) must be discarded, not displayed, since it is diagnostic metadata, not assistant content.
- Provider/model/usage metadata: must be discarded — `model`, `usage`, `id`, `created`, `object` all carry no value for a "did my task complete" UI and should never reach the renderer.
- Links: render as inert plain text (no anchor/navigation capability exists anywhere in this app; consistent with the existing CSP).
- Source/workspace paths: none are contributed by Vyron Code's own request (no file/workspace data is ever attached), but the assistant's own free-text response could still mention a path from Hermes's own execution — such text must still be treated as opaque display text, never interpreted or executed.

## H. Error, timeout and cancellation

- Safe timeout policy: a fixed client-side bound analogous to `hermesApiServer.ts`'s existing `VERIFY_TIMEOUT_MS` pattern, but longer — a real agent turn (with tool execution) can legitimately take much longer than a `/health` probe; no server-documented timeout was found, so this remains a Vyron-Code-owned, independently-disclosed constant.
- `AbortController` is available and already used identically in this exact codebase's main process (`hermesApiServer.ts`) — directly reusable.
- Server-side cancellation: no explicit cancellation endpoint was found for `/v1/chat/completions` itself (unlike `/v1/runs`, which the "control" handlers in `api_server_runs.py` suggest supports this) — client-side abort (closing the connection) is the only available mechanism, and source shows the server does react to client disconnect during *streaming* (`_write_sse_chat_completion`'s `ConnectionResetError` handling interrupts the agent) but this was not confirmed for the *non-streaming* path.
- A cancel button is reasonable to offer given `AbortController` is available, but its effectiveness against a non-streaming request is unproven from source alone (UNKNOWN — would need a scoped runtime test in an implementation phase, not this discovery).
- Stale-response prevention: the existing T-17-style monotonic-generation-counter pattern (already used identically for authorization/endpoint/verification in this codebase) directly covers authorization-clear, endpoint-clear, app-quit, a newer send, and a local cancel — no new pattern is needed, only a new counter instance scoped to "send."
- Safe HTTP/network failure mapping: connection-refused/timeout/abort → `unavailable`; non-2xx response → `safe_failure`; explicit user cancel → `cancelled`. No raw status, header, endpoint, error text, key, or body may reach the renderer — identical discipline to the existing `verifyApiServerConnection()`.

## I. Side effects and tool safety — the decisive finding

- **A normal, non-streaming `/v1/chat/completions` (or `/v1/responses`) request runs the full Hermes agent, which can autonomously execute tools within that single request, before returning its response** (VERIFIED_LOCAL_SOURCE — `tool_start_callback`/`tool_complete_callback` wiring proves this for the streaming branch; the non-streaming branch calls the identical `_run_agent(**run_kwargs)`).
- **Which tools are available is controlled entirely by server-side configuration for the `api_server` platform — never by anything in the client's own request.** `enabled_toolsets = sorted(_get_platform_tools(user_config, "api_server"))` (VERIFIED_LOCAL_SOURCE, `api_server.py:2135`). The request body's own `tools`/`tool_choice` fields are read only into a cache-fingerprint key and are never used to gate or filter what the agent can actually do (VERIFIED_LOCAL_SOURCE — confirmed by a full-file grep finding no other use of either field in either source file).
- **On this exact local installation, `api_server` has no explicit entry in `config.yaml`'s `platform_toolsets`**, so it falls back to the platform's own default composite toolset, `"hermes-api-server"` (VERIFIED_LOCAL_SOURCE, `tools_config.py:174-176`, `hermes_cli/platforms.py`).
- **That default composite's own official description, verbatim from the installed source:** *"OpenAI-compatible API server — full agent tools accessible via HTTP (no interactive UI tools like clarify or send_message)"* — resolving to `_core_without("text_to_speech", "clarify", "computer_use", kanban=False)`, i.e. essentially the full core toolset (VERIFIED_LOCAL_SOURCE, `toolsets.py:188-191`). This core toolset, per this same installation's own `config.yaml` `platform_toolsets.cli` list (used elsewhere in the same file as a concrete enumeration of what "core" tools look like on this install) plainly includes `terminal`, `file`, `code_execution`, `delegation`, `memory`, `browser`, `web`, and more.
- **Therefore: yes, filesystem/terminal/Git-adjacent/code-execution/memory-write/external-message-capable tool access is possible by default on this exact installation, through the exact endpoint D-11 would use, and there is no request-level mechanism — no field, no header, no flag — that Vyron Code could send to disable it.** Disabling this is only possible via the Hermes *administrator's own* server-side `config.yaml` change (an explicit, empty `platform_toolsets.api_server: []` entry — itself confirmed honored by source, `tools_config.py:584`: *"An explicit EMPTY list means none"*) — never via anything the D-11 *client* controls per request.
- Memory/session side effects independent of tools: even a stateless client (no `X-Hermes-Session-Id` sent) still gets an automatically-derived, stable `session_id` from a conversation fingerprint (VERIFIED_LOCAL_SOURCE, `_derive_chat_session_id`), and `/v1/responses` defaults `store: true` (server-side response persistence) unless the client explicitly overrides it. Neither of these is "session lifecycle" in the WebSocket/`/api/ws` sense D-10 retired, but both are real, non-obvious server-side state writes triggered by an ordinary request.

**This satisfies the mission's own explicit blocking condition exactly:** *"If the selected API endpoint can invoke tools, agent actions, filesystem access, terminal actions, Git actions, MCP, memory writes or external messaging by default—and there is no exact source-backed request mechanism to disable all of those—then: Do not recommend D-11 implementation. Mark D-11 as BLOCKED."*

## Required D-11 proposal

Per the mission's own instruction, since Section I's condition is met, **no full implementation-ready proposal is produced.** The items below record what evidence supports, for use only by a future, separately-scoped capability-isolation discovery — not as an implementation authorization.

1. Exact selected API endpoint and request method: **not recommended for implementation as-is** — `POST /v1/chat/completions` would be the smallest of the three if the blocking issue were resolved.
2. Exact minimum request JSON shape: `{"messages": [{"role": "user", "content": "<draft>"}], "stream": false}` (no `model` field) — contract-accurate, but sending it today would run with full agent tool access.
3. Exact required headers: none are enforced by the server for this endpoint today (Section B) — Vyron Code should still send `Authorization: Bearer <credential>` defensively/forward-compatibly if this were ever implemented, even though it is not currently checked.
4. Whether Authorization is required: **no, not by this endpoint on this installed version** — a genuinely surprising, separately-notable finding.
5. Whether `stream` is explicitly false: yes, by omission or explicit `false` — both work identically per source.
6. Selected model strategy: **A — omit `model`, use the server's own configured default** (Section D).
7. Exact draft size/bounds policy: reuse this codebase's own existing `MAX_DRAFT_LENGTH`/control-character-rejection convention from `taskComposer.ts` (Section E) — no server-documented limit exists to defer to instead.
8. Exact user review wording: as drafted in Section F.
9. Exact explicit send confirmation UX: one button, no second dialog (Section F) — **conditioned on the blocking issue being resolved first.**
10. Safe state model: `idle | reviewing | sending | completed | unavailable | safe_failure | cancelled` (Section G/H).
11. Exact zero-argument IPC methods: not specified — no implementation is being authorized.
12. Exact main-process owner responsibilities: would mirror `hermesApiServer.ts`'s existing pattern (one bounded request, one generation counter, one in-flight guard) if ever implemented.
13. Exact renderer-visible safe response shape: `{ state, text? }` where `text` is the bounded, escaped, truncated `choices[0].message.content` only (Section G).
14. Exact response truncation/escaping policy: fixed character cap, HTML-escaped, Markdown rendered as plain text (Section G).
15. Exact error/timeout/cancellation policy: as drafted in Section H.
16. Race/revocation behavior: reuse the existing T-17 generation-counter pattern (Section H).
17. Required fake-transport test matrix: not specified — no implementation is being authorized.
18. Required static security scans: not specified — no implementation is being authorized.
19. Code modules likely to change: `electron/hermesApiServer.ts` (or a new sibling module), `electron/renderer.ts`/`renderer.html` (new send action on the existing D-09 review surface), `electron/shared-ipc-contract.ts`, `electron/preload.ts`, `electron/main.ts` — **all deferred pending the blocking issue.**
20. Existing D-10 constraints that must remain unchanged: all of them — loopback-only, non-zero port, closed pathname allowlist, main-process-only credential/endpoint, no WebSocket/session capability, unchanged Electron hardening.

## D-11 safety conclusion

**BLOCKED.** The exact unsafe side-effect mechanism: `POST /v1/chat/completions` (and `/v1/responses`) on this installed Hermes Agent version runs the full agent with server-configured tool access (currently the broad `hermes-api-server` default composite — terminal, file, code execution, memory, delegation, browser, web, and more) with **no client-request-level mechanism to disable it**, and — as a further, independently serious finding — **no authentication enforcement at all** on this exact endpoint pair, unlike `/v1/models` and the response-management endpoints which do enforce it.

**Recommended next step:** a separate, narrowly-scoped capability-isolation discovery, addressed to whoever administers this local Hermes installation, to determine whether either (a) `platform_toolsets.api_server: []` can be set server-side to genuinely disable tool access for this platform with no loss of the plain-text-completion behavior D-11 needs, or (b) some other, currently-undiscovered server-side mechanism exists to run a tool-free completion through this same endpoint family. Independently, the apparent absence of any `API_SERVER_KEY` enforcement on `/v1/chat/completions`/`/v1/responses` on this version is worth flagging to the Hermes Agent maintainers or re-verifying against a newer release, since it contradicts the module's own header comment describing `API_SERVER_KEY`-gated access.

---

- Recommended D-11 API endpoint: POST /v1/chat/completions (smallest of three, but blocked — see above)
- Recommended HTTP method: POST
- Endpoint evidence classification: VERIFIED_LOCAL_SOURCE
- Authorization required: No (not enforced by this handler on this installed version) — VERIFIED_LOCAL_SOURCE
- Authentication transport: Authorization: Bearer <token>, where enforced elsewhere on this surface (e.g. /v1/models) — VERIFIED_LOCAL_SOURCE / VERIFIED_LOCAL_RUNTIME_READONLY
- URL/query credential transport: none found anywhere on this surface
- Required request headers: none enforced by /v1/chat/completions itself
- Required request JSON fields: messages (non-empty array)
- Optional request JSON fields: stream, model
- Fields prohibited from request: X-Hermes-Session-Id, X-Hermes-Session-Key headers (session/memory-scoping capability D-11 must not use)
- Non-streaming support: Yes, default
- Selected stream behavior: stream: false (explicit or by omission)
- Selected model strategy: A — omit model, use server default
- Model field required: No
- Model metadata request required: No
- Default-model evidence: VERIFIED_LOCAL_SOURCE (`body.get("model", self._model_name)`)
- Model/provider UI required: No
- Exact proposed request shape: {"messages":[{"role":"user","content":"<draft>"}],"stream":false} — contract-accurate, not authorized for use given Section I
- Proposed task draft input type: plain text only, local-only until send
- Proposed input length limits: reuse existing taskComposer.ts MAX_DRAFT_LENGTH convention
- Proposed control-byte/NUL policy: reuse existing taskComposer.ts control-character rejection
- Proposed review screen behavior: verbatim outbound text + declared no-model/no-tool/no-context metadata (Section F)
- Proposed explicit send consent: one button, no second dialog — conditioned on Section I being resolved
- Proposed request state model: idle | reviewing | sending | completed | unavailable | safe_failure | cancelled
- Proposed response text field: choices[0].message.content only
- Proposed response rendering mode: plain text, HTML-escaped, no Markdown rendering
- Proposed response size/truncation: fixed character cap, truncation flagged
- Tool call possibility: Yes — confirmed, VERIFIED_LOCAL_SOURCE
- Tool execution possibility: Yes — confirmed, VERIFIED_LOCAL_SOURCE
- Filesystem/terminal/Git/MCP possibility: Yes, via the default "hermes-api-server" toolset's inherited core tools — VERIFIED_LOCAL_SOURCE
- Agent/memory/external-action possibility: Yes — memory tool present in core toolset; implicit session/memory writes occur even without any tool call, via automatic session-id derivation — VERIFIED_LOCAL_SOURCE
- Proven tool/agent-disable mechanism: None at the client-request level. A server-admin-side config.yaml change (platform_toolsets.api_server: []) is proven capable of it, but that is not something D-11 (the client) can control.
- D-11 safety conclusion: BLOCKED
- D-11 blocked: Yes
- Blocker, if any: /v1/chat/completions and /v1/responses run the full-tool Hermes agent with no client-side mechanism to disable tool execution, and (separately) enforce no Authorization at all on this installed version.
- Proposed zero-argument IPC methods: not specified — no implementation authorized
- Renderer arguments: not specified — no implementation authorized
- Main-process transport owner: would mirror hermesApiServer.ts if ever implemented
- Credential boundary: unchanged from D-08B/D-10 if ever implemented (main-process-memory-only)
- Endpoint boundary: unchanged from D-10 if ever implemented (loopback-only, non-zero port, closed pathname allowlist)
- Draft persistence: none proposed (local-only, matches existing D-09 task composer)
- Response persistence: none proposed
- Raw HTTP renderer exposure: none proposed
- Proposed timeout: a new, independently-disclosed constant longer than the existing 10s health-check timeout
- Proposed cancellation: AbortController-based client abort; server-side cancellation for the non-streaming path is unproven (UNKNOWN)
- Revocation/stale-operation handling: reuse the existing T-17 monotonic-generation-counter pattern
- Workspace/task/context/file/search/Git transfer: None proposed by Vyron Code's own request construction
- WebSocket/session/event-stream capability: None proposed; note the server itself still derives an implicit session id per request regardless of client behavior (VERIFIED_LOCAL_SOURCE)
- Provider/model/multimodel capability: None proposed
- Terminal/shell/child_process capability: None proposed by Vyron Code; but reachable server-side via the agent's own default toolset if this endpoint were called (Section I)
- File/Git write capability: None proposed by Vyron Code; but reachable server-side via the agent's own default toolset if this endpoint were called (Section I)
- Generic IPC/raw ipcRenderer/EventEmitter: None proposed
- Electron security settings changed: None proposed
- Required fake-transport tests: not specified — no implementation authorized
- Required static security scans: not specified — no implementation authorized
- Likely files to change: not authorized for change at this stage; would be electron/hermesApiServer.ts (or a sibling), electron/renderer.ts/renderer.html, electron/shared-ipc-contract.ts, electron/preload.ts, electron/main.ts, if a future authorization proceeds after the blocker is resolved
- Reports created: VYRON_CODE_V02_D11_EXPLICIT_TASK_SUBMISSION_CONTRACT_DISCOVERY_REPORT.md
- Reports staged/committed: No
- Tokens/secrets exposed: None
- Exact next action requiring explicit approval: A separate, narrowly-scoped capability-isolation discovery (server-admin-side toolset disablement, and independent re-verification of the apparent Authorization gap on /v1/chat/completions and /v1/responses) before any D-11 implementation authorization is written.
