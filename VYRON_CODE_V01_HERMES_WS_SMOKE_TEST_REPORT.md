# Vyron Code v0.1 — `ws` Dependency & Hermes Smoke Test Report

Task: VYRON_CODE_V01_HERMES_WS_DEPENDENCY_AND_SMOKE_TEST_AUTHORIZATION.

## ⚠ Security incident disclosure — read first

While diagnosing why `session.create` still failed after switching to `ws` with correct Origin/Host headers, I ran `od -An -tx1` (hex dump) over the `HERMES_SESSION_TOKEN` line extracted from Vyron Pro's `.env.local`, intending to check only for a trailing CRLF byte. I piped it through `tail` to limit the output, but the resulting tool output **still contained roughly the last 12–13 characters of the real `HERMES_SESSION_TOKEN` value, hex-encoded** (trivially decodable back to ASCII) in this session's visible transcript. The first ~19–20 characters of the token were not shown, and the value was never shown in plain ASCII form, but a real fragment of a live secret credential was exposed where it should never have appeared. This happened once, was not repeated, and I stopped that line of investigation immediately upon recognizing it.

**This is a genuine mistake, not a designed part of this task**, and it means the current `HERMES_SESSION_TOKEN` in `D:\Vyron Pro\.env.local` should be treated as potentially compromised. I have not rotated, regenerated, or modified it myself — that is explicitly outside what I'm authorized to do, and rotation is a decision for you to make (and, per this engagement's standing rules, to perform yourself or explicitly direct). **Recommendation: rotate `HERMES_SESSION_TOKEN` at your convenience.** Everywhere else in this task, the same value was handled correctly (scratchpad-file + process-env pattern, deleted immediately after use, never written to any persistent file, never appearing in server logs, served HTML, or API responses — all separately verified below).

## Technical outcome

`ws` is correctly integrated and its handshake headers are correctly set (verified against `ws`'s own source, not just assumed) — the connection now reaches Hermes Agent's HTTP layer and receives a definitive, fast (500ms-class) **HTTP 403** response, rather than the connection-level failure from the previous (native `WebSocket`) attempt. This is real, measurable progress: the Origin/Host header gap is closed. However, `session.create` still did not succeed — Hermes Agent rejected the handshake with 403 even with correct headers and the token read directly from Vyron Pro's own live config. The specific reason Hermes Agent itself returns 403 in this case could not be further diagnosed without either (a) inspecting Hermes Agent's own logs/source, which is explicitly out of this task's scope, or (b) further inspecting the token value, which I am no longer willing to do given the incident above. **No session was created; no prompt was submitted.**

## `ws` dependency

- **`ws` dependency added**: Yes, `D:\Vyron Code\package.json` only.
- **`ws` version/lockfile updated**: `8.21.3`, exact-pinned (`npm install --save-exact`), `package-lock.json` updated accordingly.
- **Additional dependencies added**: None from the npm registry. A local ambient type declaration, [types/ws.d.ts](types/ws.d.ts), was hand-written instead of installing `@types/ws` (which does not exist as a runtime dependency, only a compile-time type-checking aid) — this keeps the added-dependency count at exactly one, per this task's explicit constraint. `ws` itself introduces zero new npm-audit findings (confirmed via `npm audit`).
- **`ws` server-side-only verified**: Yes. `grep`'d the whole codebase for `from "ws"` / `require("ws")`: exactly one real import site, [lib/hermesClient.ts](lib/hermesClient.ts). Confirmed no `"use client"` component imports it, directly or transitively (`ChatPanel.tsx` only references `hermesClient.ts` in a comment, never imports it — it talks to Vyron Code's own `/api/hermes/*` routes). Confirmed by scanning the actual built client-side static output (`.next/static`) after `npm run build`: no match for `"hermes gateway"`, `"HERMES_SESSION_TOKEN"`, or `"api/ws"` anywhere in it.

## Server-side Hermes client

- Origin/Host headers set exactly per Vyron Pro's documented contract: `origin: http://<host>:<port>`, `headers: { Host: "<host>:<port>" }`, both derived only from the same `HERMES_HOST`/`HERMES_PORT` already used for the endpoint URL — never guessed, never widened.
- No TLS bypass, no `rejectUnauthorized` flag, no wildcard origin — connection is plain `ws://` over loopback, matching Vyron Pro's own documented scheme.
- Verified the `ws` constructor's 2-argument `(url, options)` call form is correctly interpreted as "options", not misread as "protocols" (read `node_modules/ws/lib/websocket.js`'s constructor logic directly — confirmed it reassigns a non-array, non-null second argument to `options`).

## Vyron Code lifecycle

- **Previous PID/bind**: 30112, `127.0.0.1:3055` (from the prior wiring-attempt task).
- **New PID/bind**: 23632, `127.0.0.1:3055` — exactly **one** controlled restart (to load the `ws` package and pick up the process-env token). A subsequent one-line diagnostic tweak to the error-message construction (see below) was picked up by Next.js dev mode's own hot reload, with no second restart.
- Bind re-verified: `Get-NetTCPConnection -LocalPort 3055` → `127.0.0.1` only. All 4 of the machine's real LAN IPv4 addresses refused on port 3055.
- `http://127.0.0.1:3055/` → `200`; `http://localhost:3055/` → `200`.
- Hermes Agent (:9130 — TCP-reachability-checked plus the one real handshake attempt described below, no restart/stop), Bridge (:8646), OmniRoute (:20128), deliberation-service (:8647), Vyron Pro, Open WebUI, and the unrelated :3010 process — none touched, none restarted, none modified.

## Secret handling

- `HERMES_SESSION_TOKEN` supplied only as a live process-environment variable at `npm run dev` launch time (`HERMES_SESSION_TOKEN="$(cat <scratchpad file>)" npm run dev`); the scratchpad file was deleted immediately after the process started.
- **Never** written to `.env.local`, any backup file, source code, or any other persistent file — confirmed via `grep -c HERMES_SESSION_TOKEN .env.local` → `0`.
- **Never** appeared in the dev server's stdout/stderr log (`grep -i token` on the full log → no match, checked after both the connection failure and the diagnostic error-message change).
- **Never** appeared in any API response body, served HTML, or built client-side JS.
- The one exception is the incident disclosed above: a partial fragment appeared in this session's own tool-output transcript during my own diagnostic investigation — not in any file, log, browser surface, or artifact belonging to the running application itself.

## Real Hermes smoke test — outcome

1. **Health/reachability**: `Test-NetConnection 127.0.0.1:9130` → `TcpTestSucceeded: True`.
2. **`session.create` attempt** (`POST /api/hermes/session` with Vyron Code's own canonical, already-registered project root as `cwd`): failed with `hermes gateway connection failed: Unexpected server response: 403` (HTTP 502 from Vyron Code's own API — this message string comes directly from `ws`'s own source, confirmed generic/status-code-only, contains no URL or token).
3. **`prompt.submit`**: **not attempted** — correctly, since no session existed to submit a prompt to (matches the task's own "prompt.submit yalnız bir kez... session varsa" logic).
4. Consequently: no response, no SSE/event stream, no tool/task events, no session interrupt/cleanup (nothing to clean up) — all N/A for the same reason.

## Verification results

- **TypeScript**: `npx tsc --noEmit` → clean.
- **Lint**: `npx eslint .` → clean.
- **Production build**: `npm run build` → clean, no errors, no warnings (including no Turbopack tracing warning about `ws`'s optional native bindings — it bundled cleanly with no config change needed).
- **Test suite**: `npx vitest run` → **16/16 passing** (unchanged — no new test was meaningful to add for a connection that still fails, beyond what the source-level `ws`-constructor-argument check above already establishes).
- **Read-only route regressions**: re-verified live after all changes — `.env.local` → `path_denied`; real outside file (`../Vyron Pro/package.json`) → `path_outside_project_root`; absolute path → `absolute_path_rejected`.
- **Route inventory**: unchanged — still no file-write, terminal, Git-write, or `multimodel/start` route anywhere in the codebase.
- **Provider/model calls attributable to this test**: 0. **Deliberation calls**: 0. **PROJECT_STATE writes**: 0. **Memory writes**: 0. **DecisionRecord writes**: 0. **File writes**: 0. **Terminal commands**: 0. **Git write operations**: 0. Local `sessions` table: **0 rows** (confirmed by direct query — the failed handshake never reached the point where a local session record would be created).

## Files changed (all under `D:\Vyron Code\`)

`package.json` / `package-lock.json` (added `ws@8.21.3`), `lib/hermesClient.ts` (rewritten to use `ws`), `types/ws.d.ts` (new, hand-written ambient declaration) — plus this report, `VYRON_CODE_V01_HERMES_WS_SMOKE_TEST_REPORT.md`. No file outside `D:\Vyron Code\` was modified; Vyron Pro's `.env.local` was read only.

## Git operations

None.

## Remaining blockers before v0.1 completion

1. **New, and now the primary blocker**: Hermes Agent returns 403 even with a header-capable client sending correct Origin/Host and the token read directly from Vyron Pro's own live config. Diagnosing the exact cause requires either Hermes Agent-side log inspection (a read-only diagnostic task, out of this task's scope, but a natural next authorization — this engagement has an established three-source diagnostic methodology for exactly this kind of question) or confirming the token itself is still the one Hermes Agent currently accepts.
2. **Recommended, not yet done by anyone**: rotate `HERMES_SESSION_TOKEN` given the partial exposure disclosed above, then retry.
3. Unchanged from prior reports: `vyron_code` Bridge client identity, `hermes-deliberation-service` per-client token registry (v0.2 prerequisite), and the missing UI surfaces (search, context selector/inspector, PROJECT_STATE/memory panels, session list, Git log/diff).

## Tokens/secrets exposed

**Yes — see the disclosure at the top of this report.** A partial fragment (roughly the last 12–13 characters, hex-encoded) of the real `HERMES_SESSION_TOKEN` appeared in this session's own tool-output transcript during my own diagnostic investigation. It was not written to any file, log, browser-reachable surface, or artifact of the running application — all of those were separately and successfully verified clean. Recommend rotating the token.
