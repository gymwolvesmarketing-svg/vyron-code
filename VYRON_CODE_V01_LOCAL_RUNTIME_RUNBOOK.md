# VYRON_CODE_V01_LOCAL_RUNTIME_RUNBOOK

Final operating runbook — supersedes `VYRON_CODE_V01_LOCAL_OPERATION_RUNBOOK_DRAFT.md` now that the manual foreground launch model it proposed has actually been implemented (`scripts/preflight.mjs`, `npm run start:local`, `scripts/backup-db.mjs`, the System Status indicator). Contains no secret, token, raw command-line value, or sensitive absolute path.

## Official v0.1 local launch model

**Manual foreground terminal, run by the user, is the recommended model for normal day-to-day local use.** The principle:

> The user keeps a terminal open → Vyron Code runs only under that terminal → the process is directly visible and controlled by the user → closing the terminal stops it → nothing runs in the background, and no service/scheduled task is created.

The Browser-preview-managed-process model (used during this engagement's own agent-assisted testing) remains available for that purpose only — it is **not** the recommended model for a human's own regular use, since its process lifecycle is tied to the tooling session rather than to something the user directly controls. This is stated explicitly per this task's own requirement, not left implicit.

The external launcher (`run-vyron-code.cmd`, outside `D:\Vyron Code`) remains at its previously-assessed disposition: **`NO_CHANGE_NOW`** — safe (`SAFE_SERVER_ENV_ONLY`), but a candidate for replacement in a future task. It was not touched by this implementation.

## 1. Preflight

Run:
```bash
npm run preflight
```
This checks, and reports only presence/reachability booleans (never a secret value):
- Whether `127.0.0.1:3055` is already in use (**hard failure** if so — no alternate port is ever chosen automatically).
- Whether Hermes serve is reachable at the `HERMES_HOST`/`HERMES_PORT` configured in `.env.local` (a warning, not a hard failure — read-only features work without it).
- Whether `HERMES_SESSION_TOKEN` is present in the current terminal's own environment (a warning, not a hard failure — the chat route itself already fails closed if it's absent).

## 2. Start procedure

In your own terminal, before starting Vyron Code, set the stable Hermes token as an environment variable **in that terminal only** (sourced from wherever you already keep it — never written into any project file). Then run:

```bash
npm run start:local
```

This runs `scripts/preflight.mjs` first (failing closed on a port conflict) and only then starts `next start -H 127.0.0.1 -p 3055` — i.e. bound to loopback only, exactly as `package.json`'s existing `start` script already enforced. Closing this terminal (or `Ctrl+C`) stops Vyron Code; nothing else needs to be done.

Post-start, confirm:
- `http://127.0.0.1:3055/` and `http://localhost:3055/` both return `200`.
- No listener exists on `0.0.0.0`, `::`, or `[::1]` for port 3055 (a plain `netstat`/equivalent check is sufficient).
- A connection attempt from any non-loopback address on this machine is refused/unreachable.

## 3. Runtime monitoring

- The in-app **System Status** bar (top of the page, in both the desktop and narrow-viewport layouts) shows, passively: whether Vyron Code itself responded to a request, and whether Hermes serve is currently reachable — refreshed automatically every 30 seconds, or on demand via its "Refresh" button. That button only re-checks health; it never creates a session, sends a prompt, or restarts anything.
- Provider-wait state during an active turn is already visible in the Chat/Cowork panel ("Waiting for model… — Ns").
- A session's local database row moving to `completed`/`interrupted`/`error` is the authoritative signal a turn has fully resolved.

## 4. Safe shutdown

- Close the terminal window, or `Ctrl+C` — this is the only safe-stop action for the manual foreground model.
- If a turn is actively in progress: as already documented and directly observed twice in this engagement, the Hermes-side turn can continue and complete independently of Vyron Code's own process; the local session row will simply be left at whatever status it last reached. This is an accepted v0.1 limitation, not a bug.
- No graceful "wait for the active turn" shutdown exists in v0.1 — this is proposed only as a possible future (P2/P3) improvement if daily use shows it's worth the complexity.

## 5. Incident response

- **Port conflict**: `npm run preflight` (and therefore `npm run start:local`) already fails closed with a clear message — identify and stop whatever else is using `127.0.0.1:3055` before retrying. No alternate port is ever chosen automatically.
- **Hermes unavailable**: read-only features (Explorer, Search, Git) continue to work; chat fails closed with a safe error. Start Hermes serve separately (its own documented procedure) and use the System Status "Refresh" to confirm before retrying chat.
- **Token unavailable**: the chat route already fails closed with a safe message (`HERMES_SESSION_TOKEN not configured…`) — never silently degrades or guesses. Set the token in your terminal's environment and restart.
- **Provider delay**: expected; turns observed in this engagement have taken roughly 40–65 seconds. Not something to work around — just wait, per the visible "Waiting for model… — Ns" indicator.
- **Vyron Code unexpectedly exits**: check whether it was mid-turn before assuming a defect — this exact pattern (Hermes-side completion continuing independently of a stopped Vyron Code process) has already been documented twice in this engagement. For the manual-foreground model specifically, an unexpected exit means the terminal itself closed or crashed — restart per section 2.
- **SQLite backup/retention**: see section 6.
- **Secret exposure incident**: follow the same pattern already established and executed once in this engagement (`HERMES_SESSION_TOKEN_ROTATION_REPORT.md`) — stop, disclose, request a rotation authorization; never attempt a "quiet fix" that itself requires viewing the value.

## 6. SQLite backup and retention

Run, on demand (never scheduled automatically):
```bash
npm run backup-db
```
This copies `data/vyroncode.sqlite` to `data/backups/vyroncode-<timestamp>.sqlite`, verifies the copy's own schema contains none of a fixed list of forbidden column names (`content`, `raw_prompt`, `token`, etc. — see `scripts/backup-db.mjs`'s own doc comment for the full list) before keeping it, and prunes anything beyond the 10 most recent backups. `data/backups/` is `.gitignore`d, matching `data/*.sqlite` itself. No restore capability exists or was implemented — restoring is a manual file-copy operation the user performs themselves if ever needed, and since the database never holds raw content/prompts/tokens by construction, restoring an old snapshot only ever restores local metadata (which conversations/context-selections existed, when), never anything sensitive.

## 7. Read-only capability limits (unchanged, re-stated)

No file write, no terminal/shell execution, no Git write, no RAG/semantic search, no PROJECT_STATE/memory write, no real multimodel/deliberation start — anywhere in this codebase, verified again as part of this task (see the companion hardening report's route inventory).

## 8. Known limitations

- No auto-restart/process supervision — a crashed or closed Vyron Code process must be restarted manually.
- No graceful "finish the active turn before shutting down" behavior.
- Mobile browsers are an explicit non-goal; the narrow-viewport tabbed layout is a graceful desktop-browser-at-reduced-width fallback, not a mobile-optimized experience.
- Multi-sequential-turn durability (more than one full turn in a row) has not yet been separately stress-tested — only a single full turn has been directly verified end-to-end.
