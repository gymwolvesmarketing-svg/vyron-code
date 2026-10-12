# VYRON_CODE_V01_LOCAL_RUNTIME_SMOKE_REPORT

**Outcome: SUCCESS.** Vyron Code v0.1 was started via its own documented local launch command, a read-only browser smoke check confirmed a clean, safe, no-session UI shell with no write/terminal/Git-write/multimodel-start capability exposed, and the app has been left running for the user's own manual acceptance testing. This report is itself an operational artifact and is not part of any commit.

## A. Read-only runtime precheck

- Repository root: `D:/Vyron Code`. Branch: `master`. `git status`: clean of any tracked change — only the same, already-expected untracked reports/`.claude/` present.
- `git log -2 --oneline`: `6fd1d18 feat: add approval and clarification response UI`, `8baaa5a chore: initialize Vyron Code v0.1 read-only workspace baseline` — exact match to the expected baseline. Remotes: none.
- Documented local launch model, per `package.json` and `VYRON_CODE_V01_LOCAL_RUNTIME_RUNBOOK.md`'s own "Official v0.1 local launch model" section: `npm run start:local` (chains `scripts/preflight.mjs` then `next start -H 127.0.0.1 -p 3055`). This was used unambiguously — no command was guessed or substituted.
- The existing `.claude/launch.json` entry (`vyron-code-prod`) wraps an external script outside `D:\Vyron Code` that loads a secret from `%LOCALAPPDATA%\hermes\.env`; per this task's own scoping ("yalnız approved source/runbook/package scripts evidence'a dayan"), that external wrapper was deliberately **not** used — the in-repo documented command was run directly instead.
- Expected local URL (from the runbook): `http://127.0.0.1:3055/`.
- Stop method (from the runbook): close the terminal, or `Ctrl+C`.
- Required non-secret setup: Node.js + npm with dependencies already installed (`node_modules/` present from prior tasks); port `3055` free on loopback.
- Required secret/external setup for this task's own no-session scope: **none** — `scripts/preflight.mjs` only *warns* (does not hard-fail) on a missing `.env.local`/`HERMES_HOST`/`HERMES_PORT` or a missing `HERMES_SESSION_TOKEN`; only a port conflict is a hard failure. This task never needed a real Hermes chat call, so no secret was required or accessed.
- A pre-existing production build (`.next/`) was confirmed present and newer than the three AC#9 source files it would need to reflect, indicating it already represents the current committed code — no build step was run by this task.
- **Verdict: PASS** — proceeded to start the app.

## B. Local foreground start

- Command run, from `D:\Vyron Code` only: `npm run start:local`, left running as a persistent foreground-equivalent process (not a service/scheduled task/startup registration) so the user can take over testing in their own browser.
- Preflight output (safe, presence-only signals — no token value ever read, logged, or displayed):
  - `OK   127.0.0.1:3055 is free.`
  - `OK   Hermes serve appears reachable at 127.0.0.1:9130.`
  - `WARN HERMES_SESSION_TOKEN is not set in this terminal — chat will fail closed until you set it yourself before starting.` (expected, non-blocking, irrelevant to this task's no-session scope)
- Startup output showed Next.js's own standard ready signal (`Ready in ~800ms`) and confirmed binding only to `127.0.0.1:3055` (both the "Local" and "Network" lines Next.js prints referenced `127.0.0.1`, not a wildcard/LAN address) — no port/host override was applied; documented defaults were used as-is.
- No unexpected process exit occurred. No source error was shown in the startup output.

## C. Local browser smoke verification

Opened `http://127.0.0.1:3055/` in the browser and observed, read-only, with no session, prompt, or write action attempted:

- **Initial render (no project selected)**: heading "Vyron Code v0.1 read-only", an "Add project" form, and one pre-existing registered project from earlier engagement testing. No console errors, no unhandled error boundary.
- **Read-only workspace shell (after opening that existing project — a plain navigation, not a new session)**: System Status showed "localhost-only dev mode", "Vyron Code: reachable", "Hermes: reachable" (a passive TCP health probe only — confirmed via the network log, no WebSocket/session call). The file Explorer tree rendered the full canonical-root listing; no `.env*` or `.git` entry was visible anywhere in it. The File Viewer showed its safe idle placeholder ("Select a file to view (read-only)."). The Git panel rendered real `git status`-derived output (branch `master`, a real changed-files list) with only a "Refresh"/"Show history" affordance — no stage/commit/push control anywhere.
- **No-session Chat/Cowork state**: phase shown as "No session", with the exact documented idle message ("No active conversation. Click + New chat to start one, or pick a previous conversation from the list."); the prompt input was disabled with placeholder "Start a chat first". A pre-existing conversation list from earlier engagement testing was visible but **was not opened or clicked** in this task, to avoid any chance of a Hermes-side call being attempted while no token is configured.
- **Context panel / Task timeline**: both showed their documented safe empty states ("Start or select a conversation to select context for it." / "No activity yet.").
- **Disabled-capability affordances**: Terminal panel showed "No execution capability exists in v0.1's backend..." with its "Run command" button disabled; the multimodel panel's `START_MULTIMODEL` button was present but disabled with the title "Requires v0.2 deliberation-service auth hardening"; its "Preview context" button was visible but **not clicked** in this task.
- **Network requests observed** (full list, all `GET`, all `200 OK`): the page document, its static JS/CSS chunks, `/api/projects`, `/api/hermes/health`, `/api/fs/list`, `/api/sessions`, `/api/git/status`. **No request to `/api/hermes/session`, `/api/hermes/prompt`, `/api/hermes/respond`, or `/api/multimodel/preview` occurred** — confirming that simply opening the app and viewing an existing project triggers zero Hermes session/prompt/respond/deliberation activity.
- No file-write, terminal, Git-write, or multimodel-start capability was exposed or reachable anywhere observed.

## D. Git and artifact hygiene check (post-start, read-only)

- `git status` / `git status --short`: unchanged from before the app was started — only the same, already-expected untracked reports/`.claude/`; no new tracked drift.
- `git check-ignore -v .next data/vyroncode.sqlite`: both confirmed matched by existing `.gitignore` rules (`.next/` on line 10, `data/*.sqlite` on line 18) — the local SQLite database that `lib/db.ts` lazily creates/opens on first use, and the `.next/` build output, both remain correctly untracked and invisible to Git.
- No `.gitignore` change was made. No generated artifact was deleted. No source/config/test/documentation drift was found, so nothing needed correcting.

## E. User manual test handoff

Vyron Code is currently **running and left running** at:

**http://127.0.0.1:3055/**

To confirm it's loaded: the page shows "Vyron Code v0.1 read-only" and an Add-project / project-list view.

Initial expected UI state: no project selected yet (or, after clicking an existing project, a workspace shell with an idle "No session" Chat/Cowork panel — this is normal and expected, not an error).

Safe starting point for your own manual testing: open an existing or new project, browse the Explorer/File Viewer/Search/Git panels, and observe the Terminal/multimodel panels' disabled state — none of this creates a Hermes session or sends a prompt.

To stop when you're finished: close the terminal window running it, or press `Ctrl+C` in it (per the runbook's documented safe-shutdown procedure).

**Do not yet attempt**: clicking "+ New chat" or opening an existing conversation (both can lead to a real Hermes call, and `HERMES_SESSION_TOKEN` is not currently set, so a chat attempt would fail closed rather than test anything meaningful), clicking "Preview context" under Multi-model deliberation, or any Terminal/file-write/Git-write action (none exist to click, by design).

Proposed starting manual tests (`MT-01` through `MT-05`, exactly as authorized):
- **MT-01**: Open the local application URL and verify the initial UI shell renders. *(Independently confirmed above.)*
- **MT-02**: Verify that no terminal, file-write, Git-write, or multimodel-start action is exposed in the UI. *(Independently confirmed above.)*
- **MT-03**: Verify that an unavailable/no-session state is visible, understandable, and does not crash the page. *(Independently confirmed above.)*
- **MT-04**: Navigate only through read-only UI surfaces that do not submit prompts, create sessions, or invoke external dependencies (Explorer, File Viewer, Search, Git panel).
- **MT-05**: Close and reopen the browser page; verify the UI reloads safely.

Explicitly deferred (not performed in this task, and not to be attempted yet): `MT-10` (live approval/clarify event verification) and any Hermes session/prompt/interrupt/respond action, any provider/model or deliberation call, and any write/terminal/Git-write/multimodel-start capability test — all of these remain `REQUIRES_SEPARATE_RUNTIME_AUTHORIZATION` per the release-readiness audit.

---

**VYRON_CODE_V01_LOCAL_RUNTIME_SMOKE_REPORT**
- Authorization scope: local manual foreground runtime smoke verification and safe browser-based handoff for the user's own manual acceptance testing — no Hermes interaction, no prompt submission, no provider/deliberation call, no remote, no Git mutation, no write-capability test
- Repository root: `D:/Vyron Code`
- Branch: `master`
- Latest commits: `6fd1d18 feat: add approval and clarification response UI`, `8baaa5a chore: initialize Vyron Code v0.1 read-only workspace baseline`
- Remotes configured: 0
- Git identity/config changed: no
- Existing staged files: 0
- Runtime start command source: `package.json` scripts + `VYRON_CODE_V01_LOCAL_RUNTIME_RUNBOOK.md`'s "Official v0.1 local launch model" section
- Runtime start command: `npm run start:local` (`node scripts/preflight.mjs && next start -H 127.0.0.1 -p 3055`)
- Expected local URL: `http://127.0.0.1:3055/`
- Required non-secret setup: Node.js/npm with dependencies already installed; port 3055 free on loopback
- Required secret/external setup: none required for this task's no-session scope (missing token/Hermes config only warn, never hard-fail preflight)
- Runtime precheck verdict: PASS
- App start attempted: yes
- App start result: success — `next start` reported ready in under 1 second, bound only to `127.0.0.1:3055`
- Safe startup signal: yes (Next.js's own standard "Ready" line; no error, no unexpected exit)
- Local browser smoke attempted: yes
- Local browser smoke result: PASS
- Initial UI render: clean, no console errors, project-picker/workspace shell rendered as documented
- No-session/initial-state behavior: graceful — explicit "No session" phase with clear, safe guidance text; no crash
- Read-only UI visibility: confirmed — Explorer, File Viewer (idle placeholder), Search entry point, Git panel (real read-only status), Context panel, Task timeline all rendered correctly with no session created
- Terminal capability exposed: no (disabled placeholder only, as documented)
- File-write capability exposed: no
- Git-write capability exposed: no (status/history only, no stage/commit/push control)
- Multimodel-start capability exposed: no (disabled `START_MULTIMODEL`; "Preview context" visible but not invoked in this task)
- Hermes session/create/prompt/interrupt calls: 0 (confirmed via the observed network log — only `GET /api/hermes/health` occurred)
- `/api/hermes/respond` calls: 0
- Provider/model calls: 0
- Deliberation calls: 0
- External network calls: 0 (all requests were to `127.0.0.1:3055` itself)
- Generated runtime artifacts: `.next/` (pre-existing, confirmed current), `data/vyroncode.sqlite` (lazily opened by the running app)
- Git-ignore artifact status: both confirmed matched by existing `.gitignore` rules — untracked, correctly hidden
- Tracked source/config/test/doc drift: none
- Git staging performed: no
- Git commit performed: no
- Git remote changed: no
- App intentionally left running: yes — foreground-equivalent process left active at `http://127.0.0.1:3055/` for the user's own manual testing; not stopped by this task
- User manual test handoff: provided (URL, load-confirmation method, initial expected state, safe navigation starting point, stop method, and an explicit do-not-attempt-yet list)
- Tests explicitly deferred: MT-10 (live approval/clarify event verification), any Hermes session/prompt/interrupt/respond action, any provider/model or deliberation call, any write/terminal/Git-write/multimodel-start capability test
- Tokens/secrets exposed: none
- Exact next action requiring explicit approval: a separate runtime authorization for any actual Hermes session/prompt/approval-clarify/multimodel-preview interaction (including the deferred MT-06 through MT-13 from the release-readiness audit) — this task's own scope ends at the safe, no-session smoke state described above
