# VYRON_CODE_V01_LOCAL_OPERATION_RUNBOOK_DRAFT

Planning document only — a draft procedure, not an implemented script or automated tool. Nothing in this document has been executed. Contains no secret, token, raw command line with a live value, or sensitive environment value; every step below is described generically, with the actual credential always sourced live from the existing trusted location, never reproduced here.

## 1. Preflight checklist

Before starting Vyron Code, confirm:

- **Hermes serve health**: `127.0.0.1:9130` is listening and a plain HTTP GET to it (e.g. `/`) returns a response (any response — even a `404` on a specific path confirms the server is up; see the earlier `HERMES_SERVE_9130_START_REPORT.md` for exactly this distinction). If nothing is listening, start `hermes serve --host 127.0.0.1 --port 9130` first (a separate, already-documented procedure — not part of Vyron Code's own startup).
- **Port 3055 availability**: confirm nothing is already bound to `127.0.0.1:3055` before attempting to start Vyron Code. If something is, do not attempt a different port — stop and resolve the conflict first (see Incident response, below).
- **Canonical root / deny-list regression**: confirmed most recently in `VYRON_CODE_V01_GIT_CONTEXT_IMPLEMENTATION_REPORT.md`'s test suite (`tests/canonicalPath.test.ts`, still passing as of that report) — re-run `npm run test` if any source under `lib/canonicalPath.ts`, `lib/fsGuard.ts`, or the context-selection layer has changed since.
- **Token secret source availability**: confirm the stable Hermes token override is present in its existing trusted location (checked as a boolean only — present/absent — never by value).
- **Bind policy**: confirm `package.json`'s `start`/`dev` scripts still read `next start -H 127.0.0.1 -p 3055` / `next dev -H 127.0.0.1 -p 3055` — i.e., the localhost-only bind is still hardcoded there, not something that needs re-verifying per launch.

## 2. Start procedure

- **Recommended model for an agent-assisted session**: a durably-managed local preview process (the "Browser preview managed process" option from the launch/lifecycle audit) — proven to survive a full, multi-second Hermes provider turn, unlike an ephemeral one-off process launch.
- **Recommended model for the human user's own day-to-day use**: a plain foreground terminal window running the start command directly, with the trusted token loaded into that terminal's own environment before running it. Closing the window stops the server; nothing to remember to clean up.
- **Required process/environment behavior, either way**:
  - The server process must bind to `127.0.0.1:3055` only — never `0.0.0.0`, `::`, or a LAN interface.
  - The stable Hermes token must be loaded into the server process's own environment at the moment it starts, from the existing trusted source, and never written to `.env.local`, never passed as a command-line argument, never echoed to any log.
  - `HERMES_HOST`/`HERMES_PORT` remain the only Hermes-related entries in `.env.local` — the token itself must never appear there.
- **Safe log path and redaction**: whichever launch model is used, its own stdout/stderr must never be piped through anything that could echo a full environment dump (`echo %HERMES_SESSION_TOKEN%`, a bare `set` with no filter, etc.). Logs should be treated as viewer-visible by default — assume they may be read later, and keep them free of anything secret by construction rather than by after-the-fact redaction.
- **Post-start verification**:
  - PID and start time recorded (for later liveness checks).
  - `127.0.0.1:3055` confirmed bound and returning `200` on a plain root request.
  - `netstat`/equivalent confirms no wildcard or IPv6-wildcard listener exists for the same port.
  - A connection attempt from any non-loopback interface is confirmed unreachable.

## 3. Runtime monitoring

- **Health**: a simple periodic (manual or scripted, not built into the app itself in v0.1) check of `127.0.0.1:3055`'s root response is sufficient — no dedicated `/health` route exists in this build, and none is proposed for v0.1 (out of scope; see the release-hardening plan).
- **Process liveness**: check the recorded PID is still present. For the managed-preview model, this is implicitly tracked by the tooling itself; for the manual-terminal model, the open terminal window is itself the liveness indicator.
- **Provider-wait status**: the existing Chat/Cowork UI already surfaces this (`Waiting for model… — Ns`) — no separate monitoring is needed beyond watching the UI during an active turn, as demonstrated in the durable-launch test.
- **Browser refresh/disconnect behavior**: refreshing or closing a browser tab has no effect on the server process in either launch model — only that tab's own `EventSource` connection is affected, and a fresh page load will re-fetch current state (project, session list, context) from the still-running server.
- **Known slow-provider latency**: turns observed so far in this engagement have completed in roughly 40–60 seconds; this is provider-dependent and not something Vyron Code itself controls or should attempt to shorten (no timeout/retry/fallback logic is in scope — see the "Kesinlikle yasak" list carried through every authorization in this engagement).
- **Session lifecycle verification**: a session's local database row moving from `active` to `completed` (or `interrupted`/`error`) is the authoritative signal that a turn has fully resolved, independent of whatever the browser UI currently shows.

## 4. Safe shutdown

- **User-controlled stop**: for the managed-preview model, the tool's own stop action; for the manual-terminal model, closing the window or `Ctrl+C`.
- **If a turn is active when stop is requested**: Vyron Code has no server-side notion of "wait for the active turn to finish before shutting down" in v0.1 — stopping the process mid-turn is equivalent to what was already observed and documented in the mid-turn exit diagnostic: the *Hermes-side* turn continues and can complete independently of Vyron Code's own process, but the *local* session row will be left at whatever status it last reached (often still `active`) and the UI won't show the final answer. This is an accepted, documented limitation for v0.1, not a bug to silently paper over.
- **Graceful shutdown / bounded wait**: not implemented in v0.1; proposed only as a P2/P3-level improvement (see the release-hardening plan) if daily use makes it worth the added complexity.
- **Forced-kill decision boundary**: if a graceful stop request (window close, stop action) doesn't end the process within a short, human-judged wait, only then consider a forced termination of that specific PID — never a broader "kill anything on this port" sweep that could affect an unrelated process.
- **Port cleanup**: automatic on process exit; no manual cleanup step is normally needed.
- **Session metadata consistency**: a session left at `active` after an ungraceful stop is not corrupted — it simply reflects "last known state before the server stopped watching it." No cleanup script is proposed for this in v0.1; it's a cosmetic loose end, not a data-integrity concern (no raw content is ever stored in that row regardless).

## 5. Incident response

- **Process unexpectedly exits**: check whether it was already mid-turn (see the mid-turn exit diagnostic pattern established in this engagement — check the local session's own `status`/`updated_at`, and Hermes's own `agent.log` for the masked session reference, before assuming anything was lost). Restart per the start procedure above. Do not assume a code defect without first checking for the "process lifecycle, not application crash" pattern already seen twice in this engagement.
- **Port conflict**: never pick an alternate port silently — that would break the `HERMES_HOST`/`HERMES_PORT`-style expectations client tooling has, and more importantly, `.env.local`'s already-configured target for Hermes itself works the same way (a previously-empirically-discovered fixed port, not a config default) — the same discipline applies to Vyron Code's own port. Identify and resolve whatever is already using `127.0.0.1:3055` before retrying.
- **Token exposure suspected**: treat exactly like the one real incident already documented in this engagement (`HERMES_SESSION_TOKEN_ROTATION_REPORT.md`) — stop, do not attempt to "clean up" by deleting/editing logs yourself in a way that could itself involve viewing the value, disclose prominently, and request a rotation authorization rather than improvising a fix.
- **Secret scanner finding**: verify first whether the flagged string is a real token or an inert reference to the *name* of an environment variable (as was carefully distinguished once already in this engagement, for Vyron Pro's own bundle) before treating it as a live incident.
- **Gateway (Hermes serve) unavailable**: check whether it's a genuinely different process from the Hermes TUI, per the runtime-reconciliation report already produced in this engagement — the two are easy to conflate and are not the same thing.
- **Provider timeout**: not something Vyron Code should attempt to detect or retry on its own in v0.1 — surface it as-is (the existing error phase/messaging already does this) rather than adding retry logic.
- **Stale local session metadata**: a session stuck at `active` from a prior ungraceful shutdown is safe to leave as-is or, if it becomes visually cluttered, removed the same way any other local-only row is removed — no special tooling is needed or proposed.

## 6. Non-goals (explicitly out of scope for this runbook and for v0.1 generally)

- No file write capability.
- No terminal/shell execution capability.
- No Git write capability.
- No RAG/embeddings/semantic search.
- No PROJECT_STATE/memory write capability.
- No multimodel/deliberation start capability.
- No desktop packaging (Electron or otherwise) yet — this runbook describes running Vyron Code as a local Next.js process, not a packaged application.
