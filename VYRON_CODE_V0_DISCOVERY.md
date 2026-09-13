# Vyron Code — v0.0 Discovery Findings

Status: READ-ONLY discovery output. No source in any existing repo was modified to produce this document. All findings below are either freshly re-verified against current code (marked "verified") or carried forward from first-hand knowledge of systems built earlier in this engagement (marked "known").

## 1. Hermes Agent WebSocket protocol surface (verified)

Vyron Pro does **not** talk to a generic `gateway/` dispatcher. Its actual RPC transport is `hermes-agent/tui_gateway/` — a JSON-RPC 2.0-over-WebSocket surface (`{"jsonrpc":"2.0","id":..,"method":..,"params":..}`), confirmed by cross-referencing `Vyron Pro/lib/hermesClient.ts`'s literal `.call("...")` sites against `@method("...")` registrations in `tui_gateway/*.py`.

Methods Vyron Pro actually calls today: `session.create`, `session.activate`, `prompt.submit`, `approval.respond`, `clarify.respond`, `session.interrupt`, `image.attach_bytes`.

Full registered method inventory in `tui_gateway/` (verified via source grep, ~85 methods), grouped by relevance to Vyron Code:

- **Session lifecycle**: `session.create`, `session.activate`, `session.close`, `session.delete`, `session.list`, `session.active_list`, `session.most_recent`, `session.resume`, `session.compress`, `session.interrupt`, `session.set_hidden`, `session.title`, `session.workspace.move`, `session.events.since`, `session.events.stats`, `session.control`, `session.control.read`, `session.foreign.import/list/preview`.
- **Prompting**: `prompt.submit`, `prompt.background`, `prompt.btw`.
- **Approvals/clarify**: `approval.respond`, `approval.pending`, `approval.received`, `clarify.respond`.
- **Attachments (upload INTO session, one-directional)**: `file.attach`, `image.attach`, `image.attach_bytes`, `image.detach`, `pdf.attach`.
- **Execution**: `cli.exec` (runs `python -m hermes_cli.main <argv>` — the bundled Hermes CLI only, not an arbitrary shell), `shell.exec` (arbitrary shell command, gated by `detect_hardline_command`/`detect_dangerous_command` heuristics in `tools.approval_detection` before execution).
- **Path completion**: `complete.path` (autocomplete candidates for a partial path/`@`-reference under the session's `cwd`; returns names only, not file content), `complete.slash`.
- **Config/model**: `config.get`, `config.set`, `model.options`, `model.save_key`, `model.disconnect`.
- **Misc**: `ping`, `gateway.capabilities`, `groups.capabilities`, `system.battery`, `voice.*`, `wake.*`, `project.facts`, `diagnostics.share_nous`, `handoff.*`, `delegation.*`, `subagent.*`, `billing.step_up`, `bot_relay.*`, `browser.manage`, `command.dispatch`, `slash.exec`, `preview.restart`, `setup.*`, `spawn_tree.*`, `subscription.preview`, `paste.collapse`, `clipboard.paste`, `input.detect_drop`, `llm.oneshot`, `profiles.create`, `verification.status`, `pet.cancel`.

**Direct answer to "does a generic workspace file API exist" — no assumptions**: There is **no** `fs.read` / `fs.write` / `fs.list` / `fs.stat`-style generic file API in this registry. The closest things are:
1. `complete.path` — filename/path autocomplete only, no content.
2. `file.attach` / `image.attach*` / `pdf.attach` — one-directional staging of a file INTO the session's context (for the LLM to read), not a browse-or-edit-arbitrary-path capability.
3. `shell.exec` / `cli.exec` — process execution that could incidentally read/write files via shell commands, but this is a command-execution primitive with its own approval/blocking layer, not a file API, and is explicitly the highest-risk item in the registry.

Conclusion for Vyron Code: any workspace file browsing/read/write/diff capability needed by Vyron Code **must be built new** — either as a new Hermes Agent `tui_gateway` method (touches an existing repo — out of scope for v0.1 per the user's decision to keep Hermes Agent untouched) or, per the user's own architecture, as **Vyron Code's own local filesystem layer**, independent of Hermes Agent's WS protocol, operating only within Vyron Code's own canonical-root sandbox. This confirms the user's existing design instinct (filesystem access is Vyron Code's own subsystem, not something to request from Hermes Agent) was correct given the actual protocol surface.

`cwd` handling (verified, `methods_session.py` `session.create` handler): `params.get("cwd")` is accepted, resolved via `os.path.abspath(os.path.expanduser(raw_cwd))`, and only treated as an "explicit workspace" if `os.path.isdir(...)` on that resolved path succeeds — otherwise the session falls back to "No workspace" (launch-dir fallback). This is a best-effort existence check only, **not** a canonical-path security boundary (no symlink/junction resolution, no allow/deny-list, no re-containment check) — consistent with Hermes Agent being a trusted single-operator TUI/desktop tool, not a multi-project sandboxed workspace. Vyron Code must not reuse this pattern as-is for its own security model; see the Security Threat Model doc.

## 2. Bridge client identity/scope model (verified against current `hermes-core-bridge/config.py`)

Scope groups (unchanged from prior knowledge, re-verified): `GROUP_CHAT`, `GROUP_PROJECT_STATE_READ`, `GROUP_PROJECT_STATE_PROPOSE`, `GROUP_PROJECT_STATE_COMMIT`, `GROUP_MEMORY_READ`, `GROUP_MEMORY_WRITE`, `GROUP_AUDIT_READ`, `GROUP_PROJECT_STATE_DECISION_PROPOSE`.

`CLIENT_TOKEN_REGISTRY` current members (verified):
- `openwebui_adapter` → `{GROUP_CHAT}`
- `vyron_pro` → `{GROUP_PROJECT_STATE_READ, GROUP_MEMORY_WRITE, GROUP_PROJECT_STATE_COMMIT}`
- `openwebui_multimodel_commit` → `{GROUP_PROJECT_STATE_COMMIT}`
- `deliberation_service` → `{GROUP_CHAT, GROUP_PROJECT_STATE_DECISION_PROPOSE}` (explicitly NOT `GROUP_PROJECT_STATE_PROPOSE`, NOT `GROUP_PROJECT_STATE_COMMIT`, NOT `GROUP_PROJECT_STATE_READ`)
- `operator` → all groups

No client currently holds `GROUP_MEMORY_READ` alone. This is a real, structural per-client scoping mechanism — good news for Vyron Code: the pattern to add a new `hermes_workspace` (or `vyron_code`) identity is already proven and low-risk (additive config change, no code-path change), see the API/Data Model doc for the proposed scope set.

## 3. Deliberation-service auth model (verified against current `hermes-deliberation-service/api.py`)

`_verify_service_token()` checks exactly **one** shared secret: `os.environ.get(config.API_TOKEN_ENV)` (`HERMES_DELIBERATION_API_TOKEN`), compared via `hmac.compare_digest` against the value the caller supplies in its HTTP Authorization header. Authorization header values are server-side only and are never stored in documentation. There is no per-client identity, no registry, no scoping — any caller holding that single token can create sessions, submit decisions, and (per `RECIPROCAL_CHALLENGE`/`STANDARD` flows) drive real paid-provider calls through the Bridge.

Layered underneath: a per-session `session_token` (32 random bytes, minted at `create_session`), required on every subsequent call for that session (`_get_authorized_session`, `hmac.compare_digest(x_session_token, record.session_token)`) — this part is already fine-grained (session-level capability), it's the outer service-level token that is flat/shared.

Today only two real holders of the service token exist in practice: Vyron Pro's backend and Open WebUI's multimodel filter (both configured via `.env`/`.env.local`, never exposed to a browser). Adding Vyron Code as a third caller today would mean handing it the exact same shared secret as those two — acceptable for a quick manual test, **not acceptable as a standing v0.1 architecture**, because it would be indistinguishable in every audit log from Vyron Pro's or Open WebUI's own traffic, and a leak/bug in Vyron Code would have blast radius equal to a leak in either existing surface. This is the "v0.2 prerequisite" the user's plan already anticipated; this document treats it as a formal **blocking prerequisite for any Vyron Code path that touches deliberation**, not merely a nice-to-have (v0.1's scope already excludes deliberation-triggering entirely, which sidesteps this for now — see Acceptance Criteria doc).

## 4. Vyron Pro reusable patterns (known + spot-checked)

Not copied as source (Vyron Pro stays untouched and is not forked); referenced only as validated patterns for a fresh implementation:
- `lib/hermesClient.ts`'s JSON-RPC-over-WS client shape (id-correlated request/response map, a `_handleFrame` that special-cases `method:"event"` push frames vs. real RPC responses, a `RPC_TIMEOUT_MS` ceiling per call) — directly reusable shape for Vyron Code's own Hermes Agent client, since Vyron Code will speak the *same* `tui_gateway` protocol for session/prompt/approval/clarify, just with its own new file/workspace layer bolted on top.
- `lib/hermes-core-client.ts` / `lib/deliberation-client.ts` — REST+bearer-token client patterns against Bridge/deliberation-service; directly reusable shape (not code) for whatever subset of Bridge/deliberation-service calls Vyron Code ends up needing (v0.1 excludes deliberation entirely, so only the Bridge `chat_completions`-style pattern is immediately relevant, if at all).
- `app/api/*/route.ts` — Next.js route-handler-as-backend-proxy pattern (secrets stay server-side, browser never sees a Bridge/deliberation token) — this pattern is a hard requirement to preserve in Vyron Code's own backend, not just a nice pattern.
- `docker-compose.yml`'s `host.docker.internal` + Compose `environment:` override approach (Turn H, this engagement) — directly reusable if/when Vyron Code is later containerized (not in v0.1 scope).

## 5. Open WebUI disposition (known, per user's final decision)

Frozen as fallback/reference per the user's explicit direction: `multimodel_deliberation_filter.py` (installed live in Open WebUI's `function` table, id `multimodel_deliberation`) stays as-is and is not to be modified going forward. Its value for Vyron Code is purely as a *reference implementation* of "how a UI-side client triggers a real deliberation session and renders its stages" — useful later (post-v0.1) if/when Vyron Code adds its own deliberation trigger, not relevant to v0.1's scope.

## 6. Workspace security model — see `VYRON_CODE_V01_SECURITY_THREAT_MODEL.md` for the full design; summary below.

Given finding #1 (no reusable file API from Hermes Agent, no reusable canonical-path enforcement from `session.create`'s `cwd` handling), Vyron Code's filesystem layer is **entirely new code**, with no existing-system security debt to inherit — a clean-slate implementation of the canonical-root model already specified in the user's own plan (normalize → resolve symlink/junction/canonical path → re-verify under canonical project root → deny if outside).

## 7. Product/implementation blueprint — see `VYRON_CODE_V01_PRODUCT_BLUEPRINT.md`.
