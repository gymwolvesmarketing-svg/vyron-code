# VYRON_CODE_V01_LOCAL_RUNTIME_HARDENING_REPORT

Implements `VYRON_CODE_V01_LOCAL_RUNTIME_HARDENING_IMPLEMENTATION_AUTHORIZATION` in full, entirely within `D:\Vyron Code\`. No Hermes/Vyron Pro/Bridge/OmniRoute/deliberation-service/Open WebUI process was started, stopped, or changed; the external `run-vyron-code.cmd` was not touched (confirmed unchanged, same modification time as before this task); no Hermes RPC call of any kind was made.

## A. Official local foreground launch model

- `scripts/preflight.mjs` (new): checks (1) whether `127.0.0.1:3055` is already in use — **hard failure**, no alternate port ever chosen; (2) whether Hermes serve is reachable at the configured `HERMES_HOST`/`HERMES_PORT` — warning only; (3) whether `HERMES_SESSION_TOKEN` is present in the current terminal's environment — warning only, as a boolean, never a value. All three checks are plain TCP-connect/env-presence checks; nothing here ever prints a secret.
- `package.json` gained two new scripts: `"preflight"` (runs the script directly) and `"start:local"` (`node scripts/preflight.mjs && next start -H 127.0.0.1 -p 3055` — fails closed before ever attempting to bind if the port is busy). `"start"`/`"dev"` themselves are unchanged.
- No new `.cmd`/`.bat`/`.ps1` file was created, and the external `run-vyron-code.cmd` was neither modified, moved, nor replaced.
- The documented model (in the new runbook) is explicit: the user's own terminal is the process supervisor — closing it stops Vyron Code, no background/detached/scheduled process is created.

## B. Token loading boundary

- Re-verified, not re-implemented: `lib/hermesClient.ts`'s `getHermesClient()` still reads `process.env.HERMES_SESSION_TOKEN` only, throws (fails closed) if absent, and is never called from client code. `.env.local` re-confirmed to contain only `HERMES_HOST`/`HERMES_PORT`.
- The new preflight script's own token check is presence-only (`if (process.env.HERMES_SESSION_TOKEN)`) — it never reads, logs, or forwards the value anywhere.
- No new token, API key, or credential was generated, rotated, or revoked; no existing secret-source file was modified.

## C. Local health/liveness UX

- `app/api/hermes/health/route.ts` (new): a plain, read-only TCP-connect probe to `HERMES_HOST:HERMES_PORT` (immediately closed) — never a WebSocket upgrade, never carries the token, never calls any Hermes RPC method. Returns `{configured, reachable}` only.
- `components/SystemStatus.tsx` (new): a passive status bar (Vyron Code reachable/unreachable, Hermes reachable/unreachable/not-configured, a static "localhost-only dev mode" badge) that polls the health route every 30 seconds and offers a "Refresh" button. Confirmed live in the browser: the Refresh click triggers **only** a `GET /api/hermes/health` call — no session/prompt/interrupt call, no process-control action of any kind exists on this component.
- No restart button (Vyron Code or Hermes), no terminal control, no provider retry/fallback control, no multimodel start, and no file/Git write action was added anywhere in this UI.

## D. SQLite metadata backup and retention

- `scripts/backup-db.mjs` (new): copies `data/vyroncode.sqlite` to `data/backups/vyroncode-<timestamp>.sqlite`, then checks the **copy's own schema** against a fixed deny-list of column names (`content`, `raw_prompt`, `token`, `authorization`, etc.) — a structural, zero-false-positive check (a byte-level regex scan was considered and rejected, since it would misfire on the schema's own legitimate 64-character SHA-256 content fingerprints and UUIDs, which are safe by design). If any forbidden column is ever found, the backup copy is deleted immediately and the run fails closed. Retention: keeps only the 10 most recent backups, pruning older ones.
- `package.json` gained `"backup-db"`. `.gitignore` gained `data/backups/` (alongside the existing `data/*.sqlite*` entries).
- Manual/on-demand only — no scheduled task, service, or automated job was created, per the authorization's explicit constraint.
- No restore capability was implemented (explicitly out of this task's scope) and no real user metadata was deleted, migrated, or altered — verified live: ran the script against the actual development database, got a real backup file, confirmed via the schema check passing (no forbidden columns present), confirmed retention pruning logic separately via unit tests (not against real data).
- Unit-tested: `tests/backupDb.test.ts` (schema-check true/false/case-insensitive cases against temp SQLite files; retention pruning against temp directories — never the real database).

## E. Responsive and accessibility baseline

- `app/page.tsx`: added a `useIsNarrow()` hook (a `window.innerWidth < 900` media check) that switches the layout, below that breakpoint, from the fixed 3-column desktop grid to a single-panel tabbed layout (`role="tablist"`/`role="tab"`, explicit `aria-selected`) covering all five panels — Explorer, Search, Editor, Chat, Context (bundled with Task Timeline and the disabled-capabilities panel, matching the desktop stacking order), and Git. Verified live at 700px and at the true mobile preset (375×812): no horizontal page-level scroll at either width, every panel reachable via the tab bar, the System Status bar itself wraps gracefully rather than overflowing.
- The desktop layout (≥900px) is **unchanged in structure and panel order** from before this task — only wrapped with the new System Status bar above it.
- `components/ContextInspector.tsx`: added an `Escape`-key handler on the attach-confirm panel that does exactly what the existing "Cancel" button does (never confirms an attach), plus `role="dialog"`/`aria-label="Attach confirmation"` on that panel for clearer screen-reader context.
- No new UI capability of any kind (file write, terminal, Git write, provider management, process control) was introduced by any of these changes.

## F. Runbook and release checklist

- `VYRON_CODE_V01_LOCAL_RUNTIME_RUNBOOK.md` (new, final — supersedes the earlier draft): consolidated start/stop/preflight/monitoring/incident-response/backup procedures around the now-implemented tooling; explicitly states the Browser-preview model is for agent-assisted testing only, the manual foreground terminal is the recommended model for daily use, and the external launcher's `NO_CHANGE_NOW` status.
- `VYRON_CODE_V01_RELEASE_CHECKLIST.md` (new): a checked-off required list, a recommended-but-non-blocking list, a deferred-by-design list, and a requires-separate-authorization list.
- Neither document contains a real secret/token/config value, a raw command line with a live value, or a sensitive absolute path.

## Verification performed

- `npm run lint`: 0 errors (one `react-hooks/set-state-in-effect` violation was introduced by the new `SystemStatus` component and fixed using the same established pattern as every prior instance of this rule in this engagement — an async IIFE inside the effect body instead of a direct call to the state-updating function).
- `npx tsc --noEmit`: 0 errors (two `.d.mts` ambient declaration files were added, mirroring the project's existing `types/ws.d.ts` pattern, so the two new `.mjs` scripts can be imported by name from their `.test.ts` files without enabling `allowJs` project-wide).
- `npm run test`: **62/62 passing**, 8 test files (6 pre-existing + `tests/preflight.test.ts` and `tests/backupDb.test.ts`, both new).
- `npm run build`: succeeds; the new `/api/hermes/health` route is listed alongside the existing dynamic routes.
- Live verification (production build, via this environment's Browser-preview lifecycle, reused unchanged — no launcher file touched):
  - `npm run preflight` run directly: correctly reported the port free, Hermes serve reachable, and the token absent from that terminal (all as expected, none as a hard failure since only the port check is fail-closed).
  - `npm run backup-db` run directly against the real development database: produced a real backup file, passed its own schema check, reported retention correctly.
  - System Status bar confirmed rendering correctly and showing "Vyron Code: reachable" / "Hermes: reachable" against the live, running instances; "Refresh" confirmed (via network-request inspection) to call only `/api/hermes/health`.
  - Desktop (1400×900): unchanged 3-column layout, System Status bar on top, correct panel order preserved.
  - Medium/narrow (700×900) and true mobile (375×812): single-panel tabbed layout, all six tabs reachable, zero horizontal page-level scroll at either width, confirmed via direct screenshots.
  - Fresh browser tab, zero console errors.
- **No Hermes RPC call of any kind was made during this task** — no `session.create`, no `prompt.submit`, no `session.interrupt`, no WebSocket handshake. All verification was either a plain HTTP request to Vyron Code's own routes, a plain TCP-connect health probe, or UI interaction that never reached a chat action.

---

**VYRON_CODE_V01_LOCAL_RUNTIME_HARDENING_REPORT**
- Authorization scope: official local foreground launch model, token-loading boundary documentation, health/liveness UX, SQLite backup/retention, responsive/accessibility baseline, runbook/checklist finalization
- v0.1 local launch model implemented: manual foreground terminal (`npm run start:local`, preflight-gated) as the documented default for daily use; the Browser-preview model remains available for agent-assisted testing only
- Manual foreground launch procedure: `npm run preflight` (or automatically via `start:local`) → fails closed on port conflict, warns on missing Hermes/token → `next start -H 127.0.0.1 -p 3055`; stop via closing the terminal / `Ctrl+C`
- Browser preview disposition: agent-testing-only, explicitly documented as such; not the recommended daily-use model
- External launcher disposition: `NO_CHANGE_NOW` (unchanged from the prior audit's recommendation)
- External launcher changed: **no** — confirmed unchanged (same file, same modification time as before this task)
- Vyron Code startup behavior: `127.0.0.1:3055` only; preflight fails closed on port conflict; no alternate port ever chosen
- Vyron Code safe stop behavior: close the terminal / `Ctrl+C` (manual model); `preview_stop` (agent-testing model, unchanged)
- Port 3055 conflict behavior: hard failure with a clear, non-sensitive message; never an automatic alternate port
- Localhost-only bind: confirmed for Vyron Code throughout
- LAN/wildcard bind: none observed at any point
- Hermes serve prerequisite/health: confirmed reachable and healthy (`127.0.0.1:9130`, read-only check only) throughout this task; not restarted or modified
- Server-side token-loading boundary: unchanged mechanism, re-verified; preflight adds a presence-only check, nothing more
- Token values/fragments/hashes exposed: none
- Token persisted in Vyron Code files: no — `.env.local` re-confirmed to hold only `HERMES_HOST`/`HERMES_PORT`
- Browser token exposure: none — the health check never touches the token at all
- Health/liveness UI: implemented (`SystemStatus` component + `/api/hermes/health` route), passive, refresh-only
- UI-triggered process control: none — no restart/reconnect/retry control that creates a session, sends a prompt, or restarts any process exists anywhere in this UI
- SQLite metadata scope: unchanged (projects, sessions, context-selection metadata, audit log) — no schema change
- SQLite backup location classification: `D:\Vyron Code\data\backups\`, gitignored
- SQLite Git-ignore verification: confirmed (`data/backups/` added to `.gitignore`; no git repository exists for this project yet, so this is a forward-looking guarantee, verified by inspection of the ignore file itself)
- Backup retention policy: most recent 10 backups kept, manual/on-demand only, no scheduled task or service created
- Raw context/prompt/token/provider-output persistence: none — verified both by the pre-existing test suite and by this task's new schema-based backup check (structural, not a value scan)
- Backup/restore behavior: backup only; restore was not implemented, per this task's explicit scope
- Responsive desktop behavior: unchanged 3-column layout (≥900px), now with a System Status bar on top
- Narrow/mobile graceful behavior: single-panel tabbed layout below 900px, verified at 700px and true mobile (375×812) with zero horizontal page-level scroll
- Accessibility/focus/aria baseline: `role="tablist"`/`role="tab"`/`aria-selected` on the new narrow-mode tab switcher; `Escape`-to-cancel and `role="dialog"`/`aria-label` added to the attach-confirm panel; existing labels/roles elsewhere unchanged
- Updated runbook/checklist documents: `VYRON_CODE_V01_LOCAL_RUNTIME_RUNBOOK.md` (new, final), `VYRON_CODE_V01_RELEASE_CHECKLIST.md` (new)
- Read-only route inventory: unchanged — no file-write, terminal/shell, Git-write, multimodel-start, or PROJECT_STATE/memory-write route exists anywhere
- Canonical path/root-policy/junction regression: unchanged, `tests/canonicalPath.test.ts` still passing
- Context/Git read-only regression: unchanged, all relevant existing tests still passing
- Lint: 0 errors
- TypeScript: 0 errors
- Production build: succeeds
- Test suite: 62/62 passing (8 files)
- Browser/manual verification: performed live — see "Verification performed" above
- Hermes session/create/prompt/interrupt calls: 0
- Provider/model calls: 0
- Deliberation calls: 0
- PROJECT_STATE/memory/DecisionRecord writes: 0
- File writes outside `D:\Vyron Code`: 0 (the external launcher was read for the earlier audit but not modified in this task)
- Terminal commands outside build/test/start verification: 0 — every command run was a lint/typecheck/test/build/preflight/backup invocation, a read-only network/process check, or a browser interaction
- Git operations: 0
- Services intentionally untouched: Hermes serve, Hermes TUI, Vyron Pro, Bridge, OmniRoute, deliberation-service, Open WebUI
- Files changed: new — `scripts/preflight.mjs`, `scripts/preflight.d.mts`, `scripts/backup-db.mjs`, `scripts/backup-db.d.mts`, `app/api/hermes/health/route.ts`, `components/SystemStatus.tsx`, `tests/preflight.test.ts`, `tests/backupDb.test.ts`, `VYRON_CODE_V01_LOCAL_RUNTIME_RUNBOOK.md`, `VYRON_CODE_V01_RELEASE_CHECKLIST.md`, this report; modified — `package.json` (3 new scripts), `.gitignore` (1 new entry), `app/page.tsx` (System Status + responsive layout), `components/ContextInspector.tsx` (Escape handler + dialog role)
- Remaining blockers before v0.1 release candidate: none identified as blocking within this task's own scope — see the release checklist's "recommended but non-blocking" and "deferred by design" sections for everything else
- Exact next action requiring explicit approval: none required to close out this specific hardening scope; any future change to the external launcher, any new dependency/schema/scheduled job, or any further live Hermes smoke test would each need its own separate authorization
