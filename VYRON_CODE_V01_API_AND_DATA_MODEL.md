# Vyron Code v0.1 — API & Data Model Detail

Companion to the Product Blueprint's API map. Request/response shapes below are a proposed starting contract, not yet implemented or verified against real code (this whole document is new-design, not discovery-of-existing-fact, since none of this exists yet).

## Hermes Agent proxy routes (thin wrappers over the real, verified `tui_gateway` protocol)

`POST /api/hermes/session`
```json
// request
{ "cwd": "<canonical project root>", "title": "optional" }
// response (mirrors session.create's real shape, verified in Discovery doc)
{ "session_id": "...", "info": { "model": "...", "cwd": "...", "project": {...} } }
```

`POST /api/hermes/prompt`
```json
{ "session_id": "...", "text": "..." }
```
Streams back whatever `tui_gateway` pushes as `method:"event"` frames (tool.started/tool.completed/etc., per the real event vocabulary found in `run_turn_runner.py`) — Vyron Code's chat panel re-renders these, same rendering responsibility Vyron Pro's `DeliberationPanel.tsx`/chat components already carry as a pattern (not shared code).

`POST /api/hermes/respond`
```json
{ "session_id": "...", "kind": "approval" | "clarify", "request_id": "...", "choice_or_answers": ... }
```

## Filesystem routes (v0.1 — read-only only; no write route exists in v0.1's backend)

`GET /api/fs/list?project_id=&path=`
```json
// response
{ "path": "<canonical, relative-to-root>", "entries": [{ "name": "...", "type": "file"|"dir" }] }
```
Every `path` is canonicalized and re-contained per the Threat Model's algorithm before any disk access; a request that resolves outside the root returns `403 { "error": "path_outside_project_root" }`, logged to `audit_log`.

`GET /api/fs/read?project_id=&path=` → `{ "path": "...", "content": "...", "encoding": "utf8"|"base64" }` (deny-listed patterns from the Threat Model return `403 { "error": "path_denied" }` before any read attempt).

`GET /api/search?project_id=&q=` → `{ "matches": [{ "path": "...", "line": 0, "text": "..." }] }`, literal substring match only (no regex/semantic in v0.1), same canonical-root + deny-list enforcement as `fs/read`.

## Git routes (v0.1 — read-only only)

`GET /api/git/status|log|diff?project_id=` — read-only, direct pass-through of `git` output, no approval gate, no mutating Git route exists in v0.1.

## Read-only PROJECT_STATE / memory routes (v0.1 — blocked pending Bridge identity authorization, see Acceptance Criteria)

`GET /api/project-state?project_id=` → proxies Bridge's `GET /v1/context/project-state` using the `vyron_code` client identity's `GROUP_PROJECT_STATE_READ` scope.

`GET /api/memory?project_id=` → proxies a scoped Bridge memory read using the `vyron_code` client identity's read scope.

Both routes are implemented against a documented mock/stub response shape until the `vyron_code` Bridge identity is separately authorized and created; once real, no code change to these route signatures should be needed — only the backing call target.

## Multimodel routes (v0.1 — preview only, no start)

`POST /api/multimodel/preview`
```json
{ "project_id": "...", "topic": "...", "selected_context_ids": ["<context_selections.id>", ...] }
// response
{ "will_send": [{ "kind": "...", "summary": "...", "size_estimate": "..." }], "will_not_send": ["full_repo", "chat_history", "secrets", "global_memory", "unselected_project_state"] }
```
No `POST /api/multimodel/start` route exists in v0.1 — `START_MULTIMODEL` has no backend implementation until v0.2's deliberation-service per-client auth prerequisite is met.

## Deferred to v0.4 — write routes (design sketch only, NOT implemented in v0.1)

```
POST /api/fs/propose-write    { project_id, path, new_content } → { proposal_id, diff, status: "pending", expires_at }
POST /api/fs/apply-write      { proposal_id } → { status: "applied" } | 409 if stale/expired
POST /api/git/propose         { project_id, action: "stage"|"commit"|"push", paths, message } → { proposal_id, preview }
POST /api/git/apply           { proposal_id } → { status: "applied", output } | 409
POST /api/terminal/propose    { project_id, command, cwd } → { proposal_id, command_preview }
POST /api/terminal/run        { proposal_id } → streamed stdout/stderr, exit code
```
The propose/apply split is deliberate and structural (not just a UI convention) — `apply-*` routes must re-validate that the proposal id is still pending and still passes the canonical-path/command-allowlist check at apply time, not just at propose time (defends against a stale proposal being replayed after project state changed). This section exists so the `pending_actions` schema (dropped from v0.1's active tables, see below) has a documented target to be reintroduced against in v0.4.

## SQLite schema (DDL sketch, `data/vyroncode.sqlite`)

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  canonical_root TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  hermes_session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  title TEXT
);

CREATE TABLE context_selections (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  kind TEXT NOT NULL CHECK (kind IN ('file_snippet','git_diff_hunk','project_state_field','memory_field')),
  path_or_ref TEXT NOT NULL,
  range_or_hunk TEXT,
  created_at INTEGER NOT NULL
);

-- pending_actions (fs_write | git | terminal, propose/apply status machine) is a v0.4 table,
-- not created in v0.1 — no code path exists yet that would populate it. Sketch kept in the
-- Deferred-to-v0.4 API section above so the shape is documented ahead of need.

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  action_kind TEXT NOT NULL,
  target TEXT NOT NULL,          -- path or command, non-secret
  status TEXT NOT NULL,
  ts INTEGER NOT NULL
);
```

Deliberately no `content` or `output` columns on `audit_log` (mirrors Bridge's/OmniRoute's existing safe-metadata-only audit pattern from this engagement — log what happened and to what target, never the payload).

## Bridge scope (draft, for if/when Vyron Code needs Bridge access post-v0.1 — NOT required by v0.1's own scope)

Proposed new `CLIENT_TOKEN_REGISTRY` entry (additive only, not to be created without separate explicit authorization — recorded here as a design artifact, not an instruction to act):
```python
"vyron_code": {
    "groups": frozenset({GROUP_CHAT}),  # start minimal; widen only when a real v0.2+ feature needs it
}
```

## Deliberation-service auth prerequisite (blocking only for future work that calls deliberation, not for v0.1)

v0.1 does not call deliberation-service at all, so the shared-single-token limitation documented in the Discovery doc is not a v0.1 blocker. Recorded here so it is not forgotten: before any future Vyron Code feature triggers a deliberation session, `hermes-deliberation-service/api.py`'s `_verify_service_token` needs a per-client registry (mirroring Bridge's own `CLIENT_TOKEN_REGISTRY` pattern) so Vyron Code's traffic is distinguishable from Vyron Pro's/Open WebUI's in `call_logs`/audit data, and so a Vyron Code compromise doesn't equal a Vyron Pro/Open WebUI compromise.
