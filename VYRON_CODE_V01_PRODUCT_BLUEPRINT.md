# Vyron Code v0.1 — Product & Implementation Blueprint

Independent new app. Does not fork or embed Hermes Agent. Does not modify Bridge, deliberation-service, Vyron Pro, or Open WebUI. Lives at `D:\Vyron Code\` (new, empty at discovery time — not inside any existing repository).

## PRODUCT DECISION — MULTI-MODEL DELIBERATION

Vyron Code will include controlled multi-model deliberation as a core product capability.

The feature will consume the existing hermes-deliberation-service API through a dedicated Vyron Code client identity and independently revocable server-side credential.

Multi-model deliberation is never automatic. It requires explicit, per-session user initiation through a context-preview and START_MULTIMODEL approval gate.

Only user-selected, bounded and provenance-labelled context may be sent. Raw chat history, full repositories, secrets, credentials, unrestricted filesystem content, global memory and unselected PROJECT_STATE fields are denied by default.

A completed multi-model result produces a reviewable Decision Package or draft. It does not automatically write files, accept a decision, create a PROJECT_STATE proposal, commit PROJECT_STATE, write memory, run terminal commands or perform Git operations.

Before live activation in Vyron Code, the deliberation service must support separate client identities/tokens rather than the current shared service-token model. This is a formal blocking prerequisite for v0.2's `START_MULTIMODEL`, tracked in the Roadmap section below — it requires a change to `hermes-deliberation-service` (an existing repository) and therefore needs its own separate, explicit authorization when the time comes; nothing in this document authorizes that change now.

## Roadmap (supersedes the earlier v0.0→v0.5 sketch)

| Phase | Scope | Touches existing repos? |
|---|---|---|
| v0.0 | Discovery (this doc set) | No — read-only |
| v0.1 | Read-only project-aware workspace: project registry, canonical-root security, read-only file tree/viewer, literal search, context selection, Hermes chat/cowork (real `tui_gateway` session), task/tool progress timeline, read-only PROJECT_STATE + scoped memory views, read-only Git status/diff, context inspector, visibly-disabled write/terminal/multimodel affordances | No |
| v0.2 | Real `START_MULTIMODEL` activated, after `hermes-deliberation-service` gets a per-client identity registry | Yes — deliberation-service auth model (separate authorization required) |
| v0.3 | Decision draft review UI; file write still separately gated (not auto-applied by multimodel results) | No |
| v0.4 | File write propose/apply; Git stage/commit/push propose/apply; terminal propose/run | No |
| v0.5 | Decision Archive (accept/reject/archive flow for Decision Packages) | Possibly — if archive ties into Bridge's decision-proposal route |

## Repo layout (proposed)

```
D:\Vyron Code\
  app\                    Next.js app router (backend routes + frontend), mirrors Vyron Pro's proven shape
    api\
      fs\                 workspace file read/list/write/diff routes (new, Vyron-Code-only, see API doc)
      git\                Git status/log/diff/stage/commit routes (new)
      terminal\           terminal spawn/exec/approve routes (new)
      hermes\             proxy routes to Hermes Agent tui_gateway (session.create/prompt.submit/etc.)
    (chat) \ (workspace) \ (project)   route groups for the 3 screens in the wireframe
  lib\
    hermesClient.ts        same JSON-RPC-over-WS shape as Vyron Pro's, new implementation (not copied/imported)
    canonicalPath.ts        the security-model algorithm from the Threat Model doc, single source of truth
    fsStore.ts              filesystem operations, all routed through canonicalPath.ts
    gitClient.ts             thin wrapper over `git` subprocess calls, propose/approve pattern
    terminalSession.ts       pty/subprocess wrapper, propose/approve pattern
  data\
    vyroncode.sqlite         local-only, see API/Data Model doc
  components\               UI components for the 3 screens
  .env.local                HERMES_HOST/PORT (reused, points at the same Hermes Agent tui_gateway Vyron Pro uses)
```

Stack: Next.js (same major version family as Vyron Pro, for consistency of team knowledge — not a hard requirement), TypeScript, React. No Three.js/orb visuals needed (this is a workspace tool, not a voice/presence surface — explicitly excluded per the user's scope decision).

## v0.1 component map

v0.1 is strictly **read-only** end to end — no filesystem write, no Git write, no terminal, no multimodel start. Every mutating capability is visibly present but disabled, not hidden, so the UI already communicates the full product shape.

- **Project Navigator** — file tree scoped to the canonical project root; read-only browse + open-file; no create/delete/rename/write in v0.1.
- **Chat/Cowork panel** — talks to Hermes Agent's `tui_gateway` exactly as Vyron Pro does (`session.create` → `session.activate` → `prompt.submit`, rendering `approval.respond`/`clarify.respond` prompts, `session.interrupt` to stop a long-running turn) — the one piece that IS a close pattern-reuse of Vyron Pro's existing client, since the protocol is unchanged. Includes a chat/session list and a task/tool progress timeline rendered from `tool.started`/`tool.completed` event frames.
- **File viewer** — read-only via `lib/fsStore.ts`, Monaco-based rendering; no edit-and-save in v0.1 (deferred to v0.4 per the Roadmap).
- **Search** — literal/grep-style search scoped to the canonical root, same deny-list as the file viewer.
- **Context selector** — lets the user pick specific file snippets / Git diff hunks to attach to a chat prompt or (in v0.2+) a multimodel run; always shows an explicit "will be sent" / "will not be sent" preview, never an implicit whole-repo attach.
- **Context inspector** — a standing panel showing exactly what context is currently selected/attached, with provenance (file, line range, or diff hunk) for each item — the UI-level enforcement of the context-sharing rules below.
- **PROJECT_STATE read view / scoped memory read view** — read-only rendering of Bridge's `GET /v1/context/project-state` and a scoped memory read, via a new `vyron_code` Bridge client identity (see API/Data Model doc) holding only read scopes; no propose/commit affordance in v0.1.
- **Git panel** — `git status`/`log`/`diff` read-only; no stage/commit/push UI in v0.1 (shown disabled with a "coming in v0.4" affordance, not hidden).
- **Terminal panel** — present in the UI shell as a disabled placeholder only; no execution capability exists in v0.1's backend at all (not just gated — not implemented).
- **Multi-model action slot** — the "MULTİ-MODEL DEĞERLENDİR" entry point and its context-preview UI exist in v0.1 so the product shape is visible, but `START_MULTIMODEL` is disabled with an explicit "requires v0.2 deliberation-service auth hardening" message — no call to deliberation-service exists in v0.1's backend.

Explicitly NOT in v0.1 (per the user's own scope narrowing, recorded here for traceability): RAG, multi-project simultaneous sessions, any real deliberation call, file/Git/terminal write of any kind, containerization, any multi-user/remote-access mode, voice/orb presence UI.

## API map (backend routes, all server-side, no secret ever reaches the browser)

See `VYRON_CODE_V01_API_AND_DATA_MODEL.md` for full request/response shapes. v0.1 has **no write-capable route at all** — every route below is read-only or a Hermes chat proxy; the propose/apply split (for file write, Git write, terminal) is a v0.4 design, documented in the API doc for forward-reference but not implemented in v0.1.

- `POST /api/hermes/session` → proxies `session.create`+`session.activate`
- `POST /api/hermes/prompt` → proxies `prompt.submit`
- `POST /api/hermes/respond` → proxies `approval.respond` / `clarify.respond`
- `POST /api/hermes/interrupt` → proxies `session.interrupt`
- `GET  /api/fs/list?path=` → canonical-path-checked directory listing
- `GET  /api/fs/read?path=` → canonical-path-checked file read
- `GET  /api/search?q=` → literal search scoped to the canonical root, deny-list applied
- `GET  /api/git/status` / `/log` / `/diff` → read-only, no approval needed
- `GET  /api/project-state` / `/api/memory` → read-only proxy to Bridge, via the new `vyron_code` client identity's read scopes
- `POST /api/multimodel/preview` → builds the "will send / will not send" context preview only; **no route exists that starts a real deliberation session in v0.1** — `START_MULTIMODEL` is a disabled UI affordance with no corresponding backend capability yet

## SQLite data model (`data/vyroncode.sqlite`, local-only, no PROJECT_STATE/MEMORY interaction)

v0.1 tables only (the `pending_actions` table from the original draft is deferred to v0.4, when a write-capable action first exists to stage):

- `projects(id, canonical_root, display_name, opened_at, last_active_at)`
- `sessions(id, project_id, hermes_session_id, created_at, title)` — links a Vyron Code session to its Hermes Agent `session_id`
- `context_selections(id, session_id, kind ['file_snippet'|'git_diff_hunk'|'project_state_field'|'memory_field'], path_or_ref, range_or_hunk, created_at)` — what the Context Inspector renders; purely descriptive, not itself a capability
- `audit_log(id, project_id, action_kind, target, status, ts)` — local-only audit trail (reads only in v0.1: `fs_read`, `fs_list`, `search`, `hermes_prompt`, `project_state_read`, `memory_read`), same spirit as Bridge's `audit.jsonl` but scoped to Vyron Code's own actions, never mixed with Bridge's own audit store

No RAG/vector table in v0.1 (dropped per the user's own scope decision).

## Screen/IA (from the user's own wireframe, confirmed unchanged)

Three-pane layout: Project Navigator (left) — Chat/Cowork + File viewer (center, tabbed) — Terminal/Git (bottom or right, collapsible). Matches the user's specified wireframe; no deviation proposed.

## Test strategy

- Unit tests for `canonicalPath.ts` are the single highest-priority test surface (symlink/junction escape attempts, `..` sequences, deny-listed patterns, cross-project escape attempts) — this function is the entire security model's enforcement point.
- Integration tests for the propose/apply split (stale-proposal replay after project change, expired proposals, re-validation at apply time).
- Manual verification against the real `tui_gateway` protocol (session.create/prompt.submit/approval.respond round-trip) before any wider testing, mirroring how Vyron Pro's own integration was verified earlier in this engagement.

## Rollback strategy

Vyron Code is fully additive and isolated (new directory, new port, no shared state with any existing service beyond read-only use of Hermes Agent's existing `tui_gateway` protocol). Rollback is simply: stop the Vyron Code process/container. No existing service, container, config, or data is touched by its presence or absence — Open WebUI remains the fallback throughout, exactly as decided.

## Open questions (not blocking v0.1 start, flagged for the user)

1. Exact Windows junction/reparse-point resolution API to use from Node/TypeScript (needs a small research spike — `fs.realpathSync.native` behavior on junctions should be verified empirically before relying on it).
2. Whether Vyron Code should mint a NEW Bridge client identity now (low-risk, additive) even though v0.1's scope doesn't call Bridge directly yet, purely so the registry entry exists ahead of need — recommend yes, deferred to the user's call.
3. Terminal implementation choice (node-pty vs. plain child_process with captured output) — affects interactive-command support; plain captured-output is likely sufficient and lower-risk for v0.1's scope.
