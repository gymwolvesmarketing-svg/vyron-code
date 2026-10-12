VYRON_CODE_V02_D11_AUTH_AND_EPHEMERAL_HISTORY_DISCOVERY_REPORT

- Authorization scope: VYRON_CODE_V02_D11_AUTH_AND_EPHEMERAL_HISTORY_DISCOVERY — narrow, read-only, source-backed discovery of two remaining D-11 blockers (task-endpoint authentication, ephemeral/non-persistent history). No implementation, no configuration change, no restart, no task/tool request.
- Repository root: D:\Vyron Code
- Branch: master
- HEAD: 090f062 "fix(desktop): unblock Hermes authorization and endpoint configuration"
- Remotes: none
- Local Hermes version: 0.21.0
- Local Hermes source inspected: `gateway/platforms/api_server.py`, `gateway/platforms/api_server_openai_routes.py`, `gateway/platforms/api_server_runs.py`, `agent/agent_init.py`, `agent/agent_runtime_helpers.py`, `agent/turn_finalizer.py`, `agent/turn_facade_lease.py`, `agent/prompt_cache_scope.py`, `agent/session_persistence.py`, `agent/usage_anchor.py`, `agent/background_review.py`, `run_agent.py`, `hermes_cli/config_defaults.py` (all under `%LOCALAPPDATA%\hermes\hermes-agent`)
- Local Hermes config/schema inspected: presence/structure only (no global auth-toggle key found anywhere in `api_server.py`/`config_defaults.py`)
- Official sources inspected: NousResearch/hermes-agent GitHub repository (`main` branch, live-fetched: `gateway/platforms/api_server_openai_routes.py`), the official docs site (`hermes-agent.nousresearch.com/docs/user-guide/features/api-server`), general web search for release/changelog evidence
- Local runtime/config/secrets inspected: none printed; no new runtime request made this task (relying on the prior task's already-recorded `GET /v1/models` → `HTTP 401` result)
- Local read-only runtime requests made: none new this task
- POST/chat/task/run/session/tool requests made: none
- Applications/browser/Electron launched: none
- Hermes configuration modified: none
- Hermes process restarted: none
- Vyron Code source/tests/config modified: none
- Git state modified: none
- D-10 health verification preserved: yes — untouched
- API Server task routes inspected: `/v1/chat/completions`, `/v1/responses`, `/v1/runs`, `/v1/models`

## GET /v1/models authentication

Enforced. `@_require_auth` decorator immediately precedes `_handle_models` (`api_server.py:2209-2210`); empirically confirmed in the prior task (`HTTP 401`, `gateway_auth_failed`, no header sent). VERIFIED_LOCAL_SOURCE / VERIFIED_LOCAL_RUNTIME_READONLY.

## POST /v1/chat/completions authentication

**Not enforced.** No `@_require_auth` decorator, no inline `_check_auth()` call, anywhere in the function body (`api_server_openai_routes.py:409` onward). Re-confirmed this task against the live NousResearch/hermes-agent `main` branch on GitHub (fetched directly): the current, latest upstream source shows the exact same absence — the function opens with concurrency-limiting and JSON parsing, no auth check, unlike `_handle_get_response`/`_handle_delete_response` which do call `self._check_auth(request)`. VERIFIED_LOCAL_SOURCE + VERIFIED_OFFICIAL_SOURCE (main branch).

## POST /v1/responses authentication

**Not enforced.** Same finding, same method (`api_server_openai_routes.py:730` onward), same upstream `main`-branch re-confirmation. VERIFIED_LOCAL_SOURCE + VERIFIED_OFFICIAL_SOURCE.

## POST /v1/runs authentication

Enforced. `_check_auth`/`_check_run_auth` calls found in `gateway/platforms/api_server_runs.py` at lines 204, 637, 663. VERIFIED_LOCAL_SOURCE.

## API Server global authentication middleware

None exists. The three registered `aiohttp` middlewares (`cors_middleware`, `body_limit_middleware`, `security_headers_middleware`, all in `api_server.py`) perform only CORS, body-size limiting, and security-header injection — none perform authentication. Route registration (`_http_route_table`, then a plain loop calling `self._app.router.add_route(...)`) applies no wrapper of any kind. VERIFIED_LOCAL_SOURCE.

## Task authentication enforcement point

N/A for chat/completions and responses — there is no enforcement point in the installed or current-upstream source. For `/v1/models` and `/v1/runs`, enforcement happens at the very top of the handler (or via decorator), before any side effect.

## Authentication before session allocation / before agent-tool execution

N/A for chat/completions and responses (no authentication exists to be "before" anything). For the routes that do enforce it (`/v1/models`, `/v1/runs`), the check runs before any further processing in the handler.

## Task authentication configuration option

None found. No environment variable, `config.yaml` key, CLI flag, or middleware-registration option was found anywhere in `api_server.py` or `config_defaults.py` that would add authentication enforcement to `/v1/chat/completions` or `/v1/responses` specifically, or to the API Server as a whole. VERIFIED_LOCAL_SOURCE (absence, within the files inspected — not an exhaustive whole-repository claim).

## Task authentication official upgrade evidence

None found. The live `main` branch of the official GitHub repository (checked directly this task, not inferred from docs) shows the identical lack of enforcement on these two handlers as the locally installed 0.21.0. No release note, changelog entry, or GitHub issue was found (via web search) announcing authentication being added to `/v1/chat/completions`/`/v1/responses`. VERIFIED_OFFICIAL_SOURCE for the main-branch comparison; UNKNOWN (not found, not proven absent) for whether any historical release ever added and then removed such a check.

## Task authentication conclusion

**D11_TASK_AUTH_REQUIRES_UNSUPPORTED_PATCH_OR_PROXY** — the only two ways found to add authentication to these two routes are (1) a source patch adding a `@_require_auth`/`_check_auth()` call to each handler (an unsupported modification to installed/upstream code), or (2) an external reverse proxy in front of the loopback port performing its own authentication before forwarding. Neither is a documented, officially-supported Hermes configuration.

## Session/history allocation point

`gateway/platforms/api_server_openai_routes.py`'s `_handle_chat_completions`/`_handle_responses` always derive or resolve a `session_id` (via `_derive_chat_session_id` when no `X-Hermes-Session-Id` header is sent, or from the header/`previous_response_id` chain otherwise) and pass it, along with a `session_db` handle from `self._ensure_session_db()`, into `_create_agent`/`AIAgent`. The actual durable row is created lazily on first use by `run_agent.py`'s `_ensure_db_session()` (line 317-320). This allocation/creation happens **after** whatever authentication exists for that route (irrelevant for chat/completions and responses, since none exists) and **before** any tool-related filtering (`_create_agent`'s `enabled_toolsets` resolution happens in the same function, but the `session_db`/`session_id` values are already computed and passed in before that call proceeds). VERIFIED_LOCAL_SOURCE.

## Session/history persistence backend

SQLite-backed (`hermes_state_registry`/`SessionDB`, referenced via `acquire()` in `_get_session_db_for_recall` and the broader `hermes_state*.py` module family), matching the officially documented behavior ("SQLite-backed response persistence across restarts") found via web search of the official docs/GitHub. VERIFIED_LOCAL_SOURCE + VERIFIED_OFFICIAL_DOCUMENTATION.

## User prompt / assistant response / session metadata durable persistence

All three are written durably by default: `_ensure_db_session()` creates the session row (including `_session_row_model_config()`, profile name, etc.) on first turn, and the conversation loop's own turn-finalization path (`agent/turn_finalizer.py`, gated by the same `_persist_disabled` flag — see below) writes messages. None of these writes are skipped for the `api_server` platform today, since `_persist_disabled` is never set for agents created by `_create_agent`. VERIFIED_LOCAL_SOURCE.

## Tool/action durable persistence

Tool-call records are persisted the same way (gated by the same `_persist_disabled` flag family, e.g. `agent/turn_facade_lease.py`) — if a tool call were ever made (Section C of the prior report already establishes none can be, with a correctly-configured empty/`no_mcp` toolset), it would otherwise also be durably recorded. VERIFIED_LOCAL_SOURCE.

## Memory durable persistence

Gated on the `memory` toolset being enabled in the first place (`agent_init.py:1247-1258`, already established in the prior report) — with memory excluded from `enabled_toolsets`, no memory write occurs, independent of the session/history persistence discussed above (these are two structurally separate persistence surfaces). VERIFIED_LOCAL_SOURCE.

## Unconditional persistence writes

Session-row creation (`_ensure_db_session`) and message/turn finalization are unconditional **unless** `agent._persist_disabled` is `True` — and `_create_agent` in `api_server.py` never sets this. VERIFIED_LOCAL_SOURCE.

## API Server-specific ephemeral/no-history setting

None found — no `config.yaml`/`.env` key, CLI flag, or `api_server`-scoped option exists to request ephemeral/no-history behavior. VERIFIED_LOCAL_SOURCE (absence, within files inspected).

## API request ephemeral/no-history field

Only one real, source-confirmed field exists: `/v1/responses`'s `store` (OpenAI-standard, `_coerce_request_bool(body.get("store"), default=True)`). `/v1/chat/completions` has no equivalent field at all. VERIFIED_LOCAL_SOURCE.

## Field enforcement evidence

`store: false` is real and enforced, but **narrowly** — it only skips `self._response_store.put(...)` (the response-chaining cache used for `previous_response_id`/`conversation` lookups). It does **not** skip `_ensure_db_session()`/the underlying Hermes session-history database write, which is a structurally separate persistence layer the `store` field never touches. This was traced directly in source (`_handle_responses`'s `if store: self._response_store.put(...)` block is the *only* place `store` is read). VERIFIED_LOCAL_SOURCE. **`store: false` does not achieve ephemeral behavior for D-11's purposes.**

## In-memory/null session backend

Not exposed as a configuration option, but a real, production, extensively-tested mechanism to suppress all durable writes for a given agent instance **does exist in the underlying framework**: `agent._persist_disabled = True`, used today by `background_review.py`'s forked review agents (`review_agent._persist_disabled = True`) and covered by numerous dedicated tests (e.g. `tests/test_background_review_session_isolation.py`, `tests/agent/test_turn_facade_lease.py`). It gates, by direct source confirmation, `_ensure_db_session`, `_get_session_db_for_recall`, `agent/turn_finalizer.py`, `agent/turn_facade_lease.py`, `agent/prompt_cache_scope.py`, and `agent/usage_anchor.py` — i.e. every durable-write path checked this task. **It is not exposed as a parameter of `AIAgent.__init__`'s public constructor signature** (confirmed by reading the full parameter list), so `api_server.py`'s `_create_agent` — which only ever calls `AIAgent(**agent_kwargs)` — has no supported way to set it; doing so would require either a source patch to `_create_agent` (adding a post-construction `agent._persist_disabled = True` line, exactly mirroring `background_review.py`'s own pattern) or an upstream code change. VERIFIED_LOCAL_SOURCE.

## Stateless/plain completion endpoint

None found. `/v1/chat/completions`, `/v1/responses`, and `/v1/runs` are the only three POST task-shaped routes, and all three construct the same `AIAgent` with the same persistence defaults. VERIFIED_LOCAL_SOURCE.

## API Server-specific persistence isolation

Not proven achievable via any documented, officially-supported configuration. The one proven mechanism (`_persist_disabled`) requires a source patch, not a config change.

## Memory-tool disable vs. memory persistence

Confirmed as two genuinely separate things: excluding `memory` from `enabled_toolsets` prevents the model from ever calling the memory tool (Section B of the prior report), but does **not** by itself stop the underlying session/history database from recording the turn's own prompt/response text — that recording is controlled entirely by `_persist_disabled`, unrelated to which toolsets are enabled. VERIFIED_LOCAL_SOURCE.

## Purge/retention available

Not investigated in depth this task (out of the two narrowly-scoped questions) — a retention/expiry mechanism may exist elsewhere in `hermes_state*.py`, but was not traced.

## Purge/retention acceptable as no-write

No — per the mission's own explicit critical decision rule, a delete-after-the-fact or retention-expiry mechanism is never equivalent to not writing durable data in the first place, and this discovery does not treat it as such regardless of what exists.

## Ephemeral-history official upgrade evidence

None found. Official documentation (found via web search) explicitly describes SQLite-backed response persistence "across restarts" as an intentional, by-design feature of the API Server, present since at least a documented v0.5.0 hardening pass — i.e., persistence is not a defect being incrementally removed, it is the documented design. No evidence of a newer official version adding an ephemeral/stateless mode was found. VERIFIED_OFFICIAL_DOCUMENTATION for the "persistence is by design" finding; UNKNOWN for whether any version ever added a true ephemeral mode (not found, not proven absent).

## Ephemeral-history conclusion

**D11_EPHEMERAL_HISTORY_REQUIRES_UNSUPPORTED_PATCH** — a real, proven, well-tested internal mechanism (`_persist_disabled`) exists and would work, but reaching it for the `api_server` platform requires a source-code change to `_create_agent` (setting `agent._persist_disabled = True` after construction, mirroring the exact pattern `background_review.py` already uses elsewhere in the same codebase) — not any documented config key or request-body field.

## Tool isolation configuration already proven (carried forward from the prior report, unchanged this task)

`platform_toolsets.api_server: ["no_mcp"]` — a genuinely enforced, two-layer (schema-exposure + dispatch-time-validated) mechanism. Default MCP suppression requires the `no_mcp` sentinel specifically; a bare `[]` is insufficient. Remaining terminal/filesystem/Git/browser/web/MCP/delegation/memory risks: all resolved by this configuration, per the prior report's findings — not re-verified this task (out of this task's narrow two-question scope).

## Newer Hermes version evidence

Checked directly against the official `main` branch of `NousResearch/hermes-agent` on GitHub (live fetch, not just docs): the authentication gap on `/v1/chat/completions`/`/v1/responses` is identical to the locally installed 0.21.0. No evidence of any newer official released version resolving either the authentication or the persistence gap was found via targeted web search of release notes/changelogs. VERIFIED_OFFICIAL_SOURCE for the main-branch comparison specifically; UNKNOWN beyond that (an exhaustive per-release audit was not performed).

## Combined D-11 status

**D11_BLOCKED_ON_INSTALLED_VERSION** — and, per direct confirmation against the current official `main` branch, this is not specific to the installed 0.21.0; the same two gaps exist upstream today. Neither a documented server-side configuration phase nor an official upgrade is evidenced to resolve either remaining blocker.

- D-11 implementation currently allowed: No
- Exact blocker: (1) `POST /v1/chat/completions`/`POST /v1/responses` enforce no authentication, with no documented configuration or official upgrade path to add it short of a source patch or an external reverse proxy; (2) every request durably persists session/history/prompt/response data to SQLite regardless of tool configuration, with no documented configuration to make this ephemeral short of a source patch mirroring the existing internal `_persist_disabled` mechanism.
- Single recommended next step: **C — keep D-11 blocked.** Neither a server-configuration authorization (A) nor an upgrade discovery (B) is supported by the evidence found this task (no config exists for either gap; the current official upstream `main` branch has the identical gaps). A different backend (D) is not yet justified either — the specific, narrow blockers are now precisely identified and are properties of Hermes Agent's api_server platform design itself, not something a different local backend would automatically avoid without its own separate discovery. This recommendation is scoped to keeping D-11 blocked *on the currently available, officially-supported configuration surface* — it does not rule out a future, separately-authorized decision to accept an unsupported source patch or an external reverse-proxy layer, which is a product/risk decision for the user, not a conclusion this discovery can reach on its own.
- Proposed server configuration scope, if applicable: not applicable — no configuration phase is supported by the evidence.
- Proposed upgrade discovery scope, if applicable: not applicable — no upgrade is evidenced to help; the official `main` branch already shows the same behavior.
- Tokens/secrets/endpoints exposed: None
- Reports created: VYRON_CODE_V02_D11_AUTH_AND_EPHEMERAL_HISTORY_DISCOVERY_REPORT.md
- Reports staged/committed: No
- Exact next action requiring explicit approval: A separate, explicit decision from the user on whether an unsupported source patch to the installed Hermes Agent (adding both an authentication check and a `_persist_disabled = True` assignment to the api_server platform's task handlers) or an external reverse-proxy layer is an acceptable risk to accept for a future D-11 — this discovery deliberately stops short of recommending either, since both fall outside "officially supported configuration."
