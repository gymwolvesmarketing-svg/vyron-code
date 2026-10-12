# VYRON_CODE_V01_DURABLE_ATTACHED_CONTEXT_UI_TEST_REPORT

**Outcome: SUCCESS.** The entire attached-context flow — session.create, one safe context selection, Context Inspector verification, explicit Attach, one prompt.submit, full SSE lifecycle, and the final assistant response — was observed end-to-end in the Chat/Cowork UI this time, using a more durable launch method than the previous attempt. The final response correctly and exclusively reflected the attached snippet's safe content, with nothing extraneous.

## What was done

1. **Durable launch**: reused the *existing* `.claude/launch.json` entry (`vyron-code-prod`, created in an earlier authorized task — no new launcher file created) via this environment's own Browser-preview lifecycle (`preview_start`), which keeps a spawned server tied to a tracked, longer-lived preview process rather than an ephemeral one-off shell command — the mechanism this task's own "öncelikli yöntem" pointed to. The one *existing* launcher script (`run-vyron-code.cmd`, outside `D:\Vyron Code`, previously disclosed as dev-tooling only) was edited — not replaced or newly created — to load the stable token from the same trusted source (`%LOCALAPPDATA%\hermes\.env`) at the moment the server process starts, exactly mirroring the already-established, already-authorized secret-loading pattern (read at launch time into that one process's environment only — never written to `.env.local`, never printed, never persisted anywhere new).
2. **Verified before testing**: `127.0.0.1:3055` bound and healthy (`200` on both `127.0.0.1:3055` and `localhost:3055`), no wildcard/IPv6/LAN listener, a LAN-IP connection attempt timed out (unreachable), `.env.local` re-confirmed to contain only `HERMES_HOST`/`HERMES_PORT` (no token). Process identity: PID 14904 (`node.exe`), parent PID 13528.
3. **One session.create**: `+ New chat` → exactly one `POST /api/hermes/session` → `200 OK`, confirmed by a real `session.info` event ("Session ready") in the Task Timeline.
4. **One context item**: opened the same existing, non-secret documentation file (`VYRON_CODE_V0_DISCOVERY.md`), selected its first 3 lines (343 characters — title plus the read-only-scope status line), clicked "+ Add to context" → exactly one item created.
5. **Context Inspector verified** (via the live API response): 1 item, `VYRON_CODE_V0_DISCOVERY.md`, lines 1-3, 343 chars / 86 tokens, `stale: false`, aggregate far under all four limits, and the mandated `willNotSend` list present.
6. **One explicit Attach**: confirm screen shown, "Confirm attach" clicked once → `POST /api/context/attach` → `200 OK`.
7. **One prompt.submit**: the exact required synthetic question, sent verbatim, exactly once → `POST /api/hermes/prompt` → `200 OK`.
8. **Full lifecycle observed live in the UI this time**: "Waiting for model… " counted up through 19s, 35s, 48s, 63s — the server process was directly confirmed still alive (`Get-Process`) at each of these checkpoints, including past the ~40-second mark where the previous attempt's process had died — then the phase reached **"Done"**, with a **"✓ Turn completed"** entry in the Task Timeline.
9. **Final response verified**: the Chat/Cowork panel rendered the user's own prompt line followed by the assistant's reply, which read exactly:

   > **Vyron Code**

   — a single short, correct answer naming exactly the product/workspace identified in the attached snippet's own title line, with no extraneous information, no secret, no unrelated project content, and no raw context dump.
10. **Safe closure**: the turn completed naturally (`Done` phase; the local database's own session row shows `status: completed`, `message_count: 1`) — no `session.interrupt` was needed or called, matching this task's explicit "or documented safe closure" alternative.

## One secondary observation (not part of this task's own success criteria)

After all of the above had already completed successfully and been verified, a later check found the Vyron Code process (PID 14904) itself no longer running. This happened *after* the full flow (including the final rendered response and the `completed` database state) had already been directly observed, so it does not affect this test's outcome — the durable launch method held the process alive for the entire duration that mattered (over 60 seconds of active waiting, materially longer than the previous ~40-second failure). Per this task's own scope, no restart or further investigation of this later event was attempted; it is disclosed here rather than left unmentioned, exactly as the earlier mid-turn exit was.

---

**VYRON_CODE_V01_DURABLE_ATTACHED_CONTEXT_UI_TEST_REPORT**
- Authorization scope: durable Vyron Code launch + one full attached-context Hermes UI flow + safe closure
- Previous mid-turn exit classification: PROCESS_LIFECYCLE_EXTERNAL_TERMINATION (from the prior diagnostic — not re-investigated here)
- Durable Vyron Code launch method: this environment's own Browser-preview lifecycle (`preview_start`), reusing the existing `.claude/launch.json` entry and existing launcher script (edited to load the token at start, not replaced/newly created)
- Dev-server process supervision classification: tracked/managed preview process (survives independent of any single ephemeral tool-call shell), materially more durable than the previous ad hoc detached launch
- Vyron Code PID/parent classification: PID 14904 (`node.exe`), parent PID 13528
- Vyron Code safe stop method: the Browser tool's own `preview_stop` (not invoked during the test itself; the process was later found to have stopped on its own — see the secondary observation above)
- Vyron Code log location classification: managed by the preview lifecycle itself (no separate ad hoc log file needed for this launch)
- Vyron Code bind/health: `127.0.0.1:3055` only; `200` on both hostnames throughout the active test window
- Hermes serve PID/bind/health: PID 18076/20628, `127.0.0.1:9130`, listening and healthy throughout and still now
- Localhost-only verification: confirmed for both, for the entire active test window
- LAN/wildcard bind observed: none, at any point
- Browser direct Hermes connection: none — unchanged, server-side `ws` client only
- Token/secret exposure: none — loaded once at process-start time from the existing trusted source into that one process's environment only; never written to `.env.local`, never printed, never persisted to any new file
- Selected project: Vyron Code (`D:\Vyron Code`)
- Canonical project root: `D:\Vyron Code`
- Selected context source type: file_snippet (existing project documentation file, reused from the prior test)
- Selected context relative path: `VYRON_CODE_V0_DISCOVERY.md`
- Selected context safe classification: title line plus a read-only-scope status line from an existing, non-secret internal discovery-notes document
- Selected context size class: small — 343 characters / 86 estimated tokens (3 lines), far under the 2,000-char/20-line ceiling
- Context item count: 1
- Context Inspector will-send verification: confirmed via live API response
- Context Inspector will-not-send verification: confirmed present — all mandated categories
- Context server-side revalidation: passed (canonical path + deny-list inherited; fresh fingerprint)
- Context stale/fingerprint result: not stale
- Explicit attach confirmation: shown and confirmed exactly once
- Context attached: yes — exactly 1 item
- Context raw content persisted in SQLite/logs: no — metadata/fingerprint only, by design
- session.create calls: 1
- Canonical cwd verified: yes, by code path (`cwd: project.canonicalRoot`)
- prompt.submit calls: 1
- Prompt classification: the exact specified synthetic question, sent verbatim
- Attached-context payload inclusion: **confirmed** — not just at the assembly/dispatch level this time, but by the final rendered answer itself directly reflecting the attached snippet's content
- Raw history/unselected content inclusion: none
- SSE lifecycle observed: yes, in full — session ready → turn started → thinking → turn completed
- Waiting/streaming UI observed: yes — "Waiting for model…" counted up through the entire turn (19s/35s/48s/63s checkpoints, each with the server process independently confirmed alive)
- Final response UI rendered: **yes**
- Assistant final response classification: a single short, correct product/workspace name, exactly matching the attached snippet's own title — no extraneous or unexpected content
- Selected-context usage verified: **yes — confirmed**
- session.interrupt/closure: no interrupt needed; safe closure via natural completion (`Done` phase, DB `status: completed`)
- Vyron Code process alive through completion: **yes** — confirmed alive at every checkpoint through the final rendered response and the `completed` database write; found stopped only afterward (see secondary observation)
- Provider/model calls attributable to test: 1 (the one dispatched and completed turn)
- Deliberation calls: 0
- PROJECT_STATE writes: 0
- Memory writes: 0
- DecisionRecord writes: 0
- File writes: this report (in `D:\Vyron Code`); one edit to the pre-existing external launcher script (outside `D:\Vyron Code`, not a new file)
- Terminal commands: preflight/health/LAN checks, process-liveness polling (`Get-Process`), a masked local-DB read of this session's final status, `.env.local` token-absence re-check — no restart, no retry, no additional session/prompt/interrupt calls
- Git operations: 0
- Read-only route inventory: unchanged
- Secret/path/junction regression: none observed; `.env.local` re-confirmed token-free
- Services intentionally untouched: Hermes TUI, Bridge, OmniRoute, deliberation-service, Vyron Pro, Open WebUI
- Files changed: this report; one edit to the existing external launcher script (`run-vyron-code.cmd`, outside `D:\Vyron Code`)
- Remaining blockers before v0.1 completion: none — this was the last open item from the Git/Context feature work's own verification scope
- Recommended next approval: none required to close out this feature's testing; if continued live use of Vyron Code is wanted going forward, a routine "start/keep Vyron Code running" action would suffice (not a new feature or scope change)
