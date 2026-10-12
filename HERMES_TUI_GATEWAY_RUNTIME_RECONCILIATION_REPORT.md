# HERMES_TUI_GATEWAY_RUNTIME_RECONCILIATION_REPORT

Read-only diagnostic. No Hermes RPC call (`session.create`, `prompt.submit`, `session.interrupt`, or any other), no WebSocket upgrade, no process start/stop/restart, no file/config change, no token value ever read or displayed. Every finding below comes from: TCP/port state (`Get-NetTCPConnection`, `netstat`, a raw TCP connect attempt), a plain HTTP GET to `/health` (no auth, no upgrade), on-disk log files under `%LOCALAPPDATA%\hermes\logs\` and `gateway_state.json`/`gateway-starts.log` (all with any 24+ character token-like run automatically redacted before being read), the installed package's `entry_points.txt`, and Windows process metadata (PID/name/start-time only — no command line, no environment dump).

## Finding chain (most conclusive facts first)

1. **Port 9130 has no listener of any kind, on any interface, right now.** Checked three independent ways, all agreeing: `Get-NetTCPConnection -LocalPort 9130 -State Listen` → empty; `netstat -ano | grep 9130` → empty (checked IPv4 `127.0.0.1:9130`, IPv6 `[::1]:9130`/`[::]:9130`, and wildcard `0.0.0.0:9130`/`:::9130` explicitly — none present); a raw TCP connect attempt from Node to `127.0.0.1:9130` → `ECONNREFUSED` (an active refusal, not a timeout — meaning nothing is bound there, not a firewall silently dropping packets).
2. **A plain HTTP GET to `http://127.0.0.1:9130/health`** (via curl, no auth header, no WebSocket upgrade) → `HTTP_STATUS:000`, connect time `0.000000` — could not connect at all, consistent with finding 1.
3. **`hermes` and `python` processes ARE running** (confirmed via `Get-Process`): two `hermes.exe`+`python.exe` pairs, started today at `2026-09-13 20:28:13` and `2026-09-13 20:29:03` — these are the TUI session(s) the user just started (matches the shared screenshot).
4. **`%LOCALAPPDATA%\hermes\gateway_state.json`** records `"gateway_state":"running"`, `"pid":7532`, started via `argv: ["...\\hermes-agent\\venv\\Scripts\\hermes", "gateway", "run"]` at `2026-09-08T17:29:21Z`. **PID 7532 is not currently running** (`Get-Process -Id 7532` → not found). This state file is stale/out of date with respect to current reality.
5. **`%LOCALAPPDATA%\hermes\logs\gateway-exit-diag.log`** (5 entries total, redacted before reading) shows every prior `hermes gateway run` invocation being immediately preceded by a `gateway.previous_unclean_exit` detection for the PID before it — i.e. this gateway process has a history of dying without a clean shutdown, and only gets noticed/logged the next time someone runs `hermes gateway run` again. **The most recent entry in this log is the `gateway.start` for PID 7532 on 2026-09-08T17:29:21Z — there is no later entry.** No `hermes gateway run` invocation has happened since, and today's TUI processes (finding 3) do not appear in this log at all.
6. **`hermes_agent-0.21.0.dist-info/entry_points.txt`**: `hermes = hermes_cli.main:main` — a single CLI entry point that dispatches subcommands. Combined with finding 5's explicit `argv` (`hermes gateway run` as a distinct, separately-invoked subcommand), this confirms the bare `hermes` command (TUI/chat mode — what the user's screenshot shows) and `hermes gateway run` (the `/api/ws` WebSocket gateway on port 9130) are two different modes of the same dispatcher — starting one does not start the other.

## Conclusion

The user's screenshot and the earlier "no listener on 9130" finding are **not actually in conflict** — they are two true facts about two different things. The TUI the user started (bare `hermes`) is running correctly and is not the same process as the `tui_gateway` WebSocket server (`hermes gateway run`) that Vyron Code (and Vyron Pro) connect to. The gateway's last known instance (PID 7532, started 2026-09-08) is no longer running, and nothing has restarted it since — independent of and unrelated to any Vyron Code work in this or the prior task.

---

**HERMES_TUI_GATEWAY_RUNTIME_RECONCILIATION_REPORT**
- Diagnostic mode: READ-ONLY
- Current timestamp: 2026-09-13T17:49Z (host local time 2026-09-13 20:49 UTC+3)
- Hermes Agent runtime detected: yes — TUI-mode processes running (2 hermes.exe + 4 python.exe, started 20:28:13 and 20:29:03 today)
- Hermes Agent PID/start-time continuity: not continuous with the last known gateway instance — gateway PID 7532 (started 2026-09-08T17:29:21Z) is not among currently running processes; today's PIDs are a new, separate (TUI) invocation never logged as a gateway start
- Port 9130 IPv4 listener: not listening
- Port 9130 IPv6 listener: not listening
- Port 9130 wildcard listener: not listening
- Port 9130 owning process classification: not detected (no listener exists)
- Port 9130 TCP reachability: refused (ECONNREFUSED on a raw connect attempt) — not a timeout, not a hang
- Hermes health endpoint: unreachable (HTTP status 000, connect failed) — consistent with no listener
- `/api/ws` route registration source finding: not independently re-derived from source this pass (package source module not located under the venv's site-packages in the time available); inferred instead from `entry_points.txt` + `gateway-exit-diag.log`'s explicit `hermes gateway run` argv, which is sufficient to establish TUI ≠ gateway
- TUI ↔ tui_gateway relationship: separate subcommands of the same `hermes_cli.main` dispatcher — confirmed via `entry_points.txt` + exit-diag log argv; starting the TUI does not start the gateway
- Dashboard/gateway startup condition: requires an explicit `hermes gateway run` invocation — not started automatically by the bare `hermes` TUI command
- Current runtime startup-mode classification: TUI-only (chat mode); gateway mode not currently running
- Token/config values exposed: none — only variable/key NAMES were ever checked (e.g. `HERMES_DASHBOARD_SESSION_TOKEN` present as a key in the override file), never a value; `code_sha` field in `gateway_state.json` was redacted before display
- Token/config values changed: none
- Previous successful smoke-test evidence: acknowledged as provided (prior task's real session.create/prompt.submit/session.interrupt chain) — not re-verified in this task (would require a live gateway connection, out of scope for a read-only diagnostic)
- Current-vs-previous runtime difference: the gateway process that made the previous smoke test possible (or a later instance of it) is no longer running; its last recorded instance (PID 7532) started 2026-09-08 and is confirmed dead now, with no successor logged
- Vyron Code server-side target compatibility: `.env.local` still targets `HERMES_HOST=127.0.0.1` / `HERMES_PORT=9130` — matches where the gateway is expected to listen when running; no mismatch in configuration, only in current runtime state
- Vyron Code 127.0.0.1:3055 bind: unchanged (`next dev`/`next start -H 127.0.0.1 -p 3055` in `package.json`, not modified by this or the prior task)
- Browser direct Hermes WebSocket: none — `lib/hermesClient.ts` (server-only `ws` client) unmodified
- Hermes session.create calls: 0
- Hermes prompt.submit calls: 0
- Hermes session.interrupt calls: 0
- Provider/model calls: 0
- Deliberation calls: 0
- PROJECT_STATE/memory/DecisionRecord writes: 0
- File writes: this report only, inside `D:\Vyron Code\`
- Terminal commands: read-only only — `Get-NetTCPConnection`, `netstat`, a raw Node TCP-connect probe (no data sent, immediately closed), `curl` to `/health` only, `Get-Process` (PID/name/start-time only), `ls`/`cat`/`node -e` reads of already-existing log/state files with automatic redaction of any long token-like string before display, `pip show`/`python -c import` (both failed harmlessly — package not importable by that name in this shell's Python), a directory listing of the venv's `site-packages`, and a grep of `entry_points.txt`/`RECORD` (paths only)
- Git operations: 0
- Other services changed/restarted: 0 — Bridge, OmniRoute, deliberation-service, Vyron Pro, Open WebUI, and the unrelated `:3010` container were not touched or queried
- Runtime decision: **C. RUNTIME_DEGRADED__RESTART_OR_CONFIG_REVIEW_REQUIRED**
- Root-cause confidence: CONFIRMED (multiple independent, mutually consistent evidence sources: live network state, live process state, and on-disk startup/exit logs all agree)
- Safe minimum next action: run `hermes gateway run` (a separate command from the TUI the user already started) to bring the `/api/ws` listener back up on port 9130
- Does next action require explicit approval: yes — starting any Hermes Agent process (including the gateway) was explicitly out of scope for this read-only diagnostic and was not performed
- Files changed: `HERMES_TUI_GATEWAY_RUNTIME_RECONCILIATION_REPORT.md` (this file) only
- Tokens/secrets exposed: none
