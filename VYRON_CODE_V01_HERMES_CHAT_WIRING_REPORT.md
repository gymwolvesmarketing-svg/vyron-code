# Vyron Code v0.1 — Hermes Chat Wiring Report

Task: VYRON_CODE_V01_HERMES_CHAT_WIRING_AUTHORIZATION. Result: **wiring completed and correctness-verified against Vyron Pro's own documented protocol; the live handshake itself fails, for a specific, empirically-confirmed reason — see "Central finding" below. No session was created, no prompt was submitted, and no secret was ever exposed.**

## Central finding

Vyron Pro's own `lib/hermesClient.ts` documents Hermes Agent's tui_gateway protocol as requiring, at WebSocket handshake time: endpoint `ws://<host>:<port>/api/ws?token=<HERMES_SESSION_TOKEN>`, an `Origin` header equal to `http://<host>:<port>`, and a `Host` header equal to `<host>:<port>` — with a documented `403 on mismatch`. Node's built-in, WHATWG-standard `WebSocket` global (used in Vyron Code to avoid adding a new dependency) has no mechanism to set custom handshake headers — verified empirically, not assumed: a local raw HTTP upgrade listener was stood up and a native `WebSocket` connection opened against it; the captured request headers contained no `Origin` at all, and passing an options object as the constructor's second argument was silently accepted and ignored (the WHATWG constructor's second parameter is `protocols`, not an options bag).

This was then confirmed against the real service: a real `session.create` attempt through Vyron Code's own `/api/hermes/session` route failed at the WebSocket connection stage with `hermes gateway connection failed: ws://127.0.0.1:9130/api/ws` (HTTP 502 from Vyron Code's own API, itself a clean, secret-free error). This is the predicted failure mode, now empirically observed against the live Hermes Agent, not a guess.

**Fix required**: swap the native `WebSocket` for a Node-specific client capable of setting custom handshake headers — the `ws` npm package, which Vyron Pro itself already depends on for exactly this reason. Per this task's explicit scope ("Yeni dependency ekleme ancak mevcut stack ile teknik olarak imkânsızsa ve önce gerekçeyi raporlayıp dur"), **`ws` was NOT installed**. This report is that stop-and-report.

## Vyron Code server-side Hermes connection wiring — what was actually done

- [lib/hermesClient.ts](lib/hermesClient.ts) rewritten: correct endpoint path (`/api/ws?token=`), correct event-frame unwrapping (`{type, sessionId, payload}` matching Vyron Pro's own documented `params.type`/`params.session_id`/`params.data`), and fail-closed behavior identical to Vyron Pro's own client if `HERMES_SESSION_TOKEN` is absent from the process environment. The class-level doc comment states the header limitation explicitly, in the code, for the next person (or the follow-up task) who touches this file.
- [lib/hermesEvents.ts](lib/hermesEvents.ts) and [components/ChatPanel.tsx](components/ChatPanel.tsx) updated to match: `ChatPanel` now handles `message.delta` (streaming, accumulated in place), `message.complete` (finalizes the reply), and `turn.error` (shown as a distinct error item) in addition to the pre-existing `tool.started`/`tool.completed` timeline — previously the panel only ever rendered tool-progress lines and would never have shown an actual Hermes reply even if the connection had succeeded. This was a real, necessary fix within the "server-side Hermes connection wiring" scope, independent of the `ws` blocker.
- `HERMES_HOST=127.0.0.1` / `HERMES_PORT=9130` — read via `grep` from Vyron Pro's own already-running, already-verified `.env.local` (never guessed), confirmed matching the port this task itself stated (`:9130`), and written into Vyron Code's own `.env.local`. Non-secret values only.
- `HERMES_SESSION_TOKEN` — confirmed present and non-empty in Vyron Pro's `.env.local` via a presence-only `grep` (`HERMES_SESSION_TOKEN: present and non-empty` — the value itself was never read into any visible output). Supplied to the Vyron Code dev server **only** as a live process-environment variable at launch time (`HERMES_SESSION_TOKEN="$(cat <scratchpad file>)" npm run dev`), via the same session-scoped scratchpad-file pattern used throughout this whole engagement; the scratchpad file was deleted immediately after the server process started. **Never written into `.env.local` or any other persistent file.**
- Vyron Pro's own `.env.local` was read, never modified.

## Vyron Code dev server lifecycle

One controlled restart of Vyron Code's own dev server only (to pick up the new `.env.local` values and the process-env token):
- Stopped: PID 3668 (127.0.0.1:3055, from the prior hardening task).
- Started: PID 30112, `next dev -H 127.0.0.1 -p 3055`.
- Bind re-verified: `Get-NetTCPConnection -LocalPort 3055` → `127.0.0.1` only. Re-tested all 4 of the machine's real LAN IPv4 addresses on port 3055 — all refused (`000`).
- `http://127.0.0.1:3055/` → `200`; `http://localhost:3055/` → `200`.
- Hermes Agent (:9130), Bridge (:8646), OmniRoute (:20128), deliberation-service (:8647), Vyron Pro, Open WebUI, and the unrelated :3010 process (PID 29004, re-confirmed unchanged) — none touched, none restarted.

## Hermes session smoke test — outcome

1. **Health/reachability**: `Test-NetConnection 127.0.0.1:9130` → `TcpTestSucceeded: True` (safe TCP check only, no protocol-level call).
2. **`session.create` attempt**: `POST /api/hermes/session {project_id: <Vyron Code's own canonical root>}` → **failed** with the WebSocket handshake error above (HTTP 502 from Vyron Code's own API). No `session_id` was ever returned by Hermes Agent. Vyron Code's local `sessions` table has **0 rows** (confirmed by direct query) — the failure occurred before any local session record would have been created, exactly as designed (the DB insert only happens after a successful `session.create` + `session.activate` round-trip).
3. **Consequently not attempted** (correctly, per the task's own "prompt.submit yalnız bir kez çağrılmalıdır" and general no-session-no-prompt logic): `prompt.submit`, SSE/event-stream observation, and session cleanup/interrupt — there was no session to submit a prompt to, observe events from, or clean up.

## Secret handling — verified, not assumed

- Grepped the full dev-server log for `token` (case-insensitive) after the failed attempt: **no match**.
- Grepped the dev-server's structured request log line for the failed call: `POST /api/hermes/session 502 in 606ms` — path only, no query string, no token (the token lives only inside the server-side `ws://...` URL string constructed and used internally by `lib/hermesClient.ts`, which is never logged, never returned in any response, and never reaches this request's own URL/path).
- Fetched the actual browser-served HTML (`curl http://127.0.0.1:3055/`) and grepped for `HERMES_SESSION_TOKEN`/`token=`: **no match**.
- `.env.local` grepped for `HERMES_SESSION_TOKEN`: **0 occurrences** — confirmed never persisted.
- No `NEXT_PUBLIC_`-prefixed variable was introduced anywhere.
- The browser never opens a WebSocket directly to Hermes Agent — `ChatPanel.tsx` only ever calls Vyron Code's own `/api/hermes/*` routes and subscribes to Vyron Code's own `/api/hermes/events` SSE endpoint.

## Read-only guarantee — re-verified live, after all changes

- `.env.local` deny-list: `GET /api/fs/read?path=.env.local` → `path_denied`.
- Path escape (real file outside root): `GET /api/fs/read?path=../Vyron Pro/package.json` → `path_outside_project_root`.
- Absolute path: `GET /api/fs/read?path=C:/Windows/win.ini` → `absolute_path_rejected`.
- Source-level scan: no `writeFileSync`/`execSync`/`spawn(` anywhere under `lib/`/`app/` (only `git.ts`'s pre-existing `execFileSync("git", [...fixed flags...])`, unchanged). Route directory listing confirms no `file write`, `terminal`, `git write`, or `multimodel/start` route exists — same 15 route directories as before this task, none added or removed.
- `PROJECT_STATE`/memory routes remain `GET`-only `501` stubs — untouched.

## Verification results

- **TypeScript**: `npx tsc --noEmit` → clean.
- **Lint**: `npx eslint .` → clean.
- **Production build**: `npm run build` → clean, no errors, no warnings.
- **Test suite**: `npx vitest run` → **16/16 passing** (unchanged from the hardening task — this task added no new tests, since the blocked connection had nothing new and safe to assert beyond what was already covered; a real Hermes client integration test is meaningful only once the `ws` swap makes a real connection possible).

## Files changed (all under `D:\Vyron Code\`)

`.env.local` (HERMES_HOST/HERMES_PORT populated), `.env.local.backup.20260911-195701` (new, gitignored, created before the edit, content never displayed), `.gitignore` (added `.env.local.backup.*`), `lib/hermesClient.ts` (rewritten), `lib/hermesEvents.ts` (updated), `components/ChatPanel.tsx` (rewritten) — plus this report, `VYRON_CODE_V01_HERMES_CHAT_WIRING_REPORT.md`.

## Git operations

None.

## Remaining blockers before v0.1 completion

1. **Blocking, new**: add the `ws` npm package (small, zero-native-build, already trusted by Vyron Pro for this exact purpose) so `lib/hermesClient.ts` can set the `Origin`/`Host` handshake headers Hermes Agent requires — needs its own explicit approval before installing, per this task's own dependency-approval clause.
2. Once (1) lands: re-run this exact smoke test (`session.create` with the canonical project cwd → the one synthetic `prompt.submit` → observe the SSE stream → interrupt/close) for real.
3. Unchanged from prior reports: `vyron_code` Bridge client identity still not created (separate authorization); `hermes-deliberation-service` per-client token registry still not designed/implemented (separate authorization, v0.2 prerequisite); UI surfaces for search, context selector/inspector, PROJECT_STATE/memory panels, session list, and Git log/diff are still missing.
