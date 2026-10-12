# HERMES_SERVE_9130_START_REPORT

Started the official `hermes serve` JSON-RPC/WebSocket backend, bound explicitly to `127.0.0.1:9130`, and verified it non-mutatingly. No WebSocket handshake, `session.create`, `prompt.submit`, or any other Hermes RPC call was attempted — only plain HTTP GETs (no `Upgrade`/`Connection`/`Sec-WebSocket-Key` headers) and TCP/process/log inspection.

## What was done

1. **Preflight** (all read-only, re-confirmed fresh): port 9130 empty (`ECONNREFUSED` on a raw TCP connect); `hermes serve --help` re-verified as "Run the Hermes backend server — the JSON-RPC/WebSocket gateway the desktop app and remote clients connect to. Headless…" with `--host`/`--port` options; `hermes serve --status` (itself read-only) reported "No hermes dashboard or serve processes running" beforehand; `HERMES_DASHBOARD_SESSION_TOKEN` confirmed present as a strict boolean (never a value/length/hash); Vyron Pro container running (unrelated, untouched), no active Vyron Code server, no active Hermes TUI task known.
2. **Startup**: launched exactly `hermes serve --host 127.0.0.1 --port 9130` via `Start-Process` (detached, `-WindowStyle Hidden`, stdout/stderr redirected to two log files in this session's own scratchpad directory — never inside `D:\Vyron Code`, never a Git-tracked location). **The stable token was never touched, read, or injected by me at all** — Hermes's own process environment already carries the persistent `HERMES_HOME` variable, and its own `env_loader` mechanism (the same one documented in the prior rotation task) picked up `HERMES_DASHBOARD_SESSION_TOKEN` from `%LOCALAPPDATA%\hermes\.env` automatically, exactly as it does for every other Hermes invocation — no token value ever passed through any command I ran, no new file written, no `.env`/`.env.local` touched.
3. **Post-start verification** (all non-mutating):
   - `netstat` shows exactly one listener for port 9130: `127.0.0.1:9130` (state `LISTENING`) — no `0.0.0.0:9130`, no `[::]:9130`/`[::1]:9130`, no wildcard, on repeated checks.
   - A raw TCP connect to `127.0.0.1:9130` succeeded (no data sent, connection closed immediately).
   - A connection attempt to the same port via this machine's LAN IP (`172.25.224.1`) timed out — the server is not reachable from the LAN interface, consistent with a loopback-only bind.
   - Plain HTTP GET (no upgrade headers) to `/` → `200`; to `/health` → `404` (this build doesn't expose that exact path — not an error, just the wrong path name); to `/api/ws` → **`401`** — compared against a deliberately made-up path (`/definitely-not-a-real-route-xyz123` → `404`), this confirms `/api/ws` **is a registered route with its own authentication gate**, distinct from an unmapped path, without ever sending an `Upgrade` header or a token.
   - The two startup log files (read directly, in full — both under 50 bytes, no redaction even needed) contain only:
     - stdout: `HERMES_BACKEND_READY port=9130`
     - stderr: `Hermes backend listening on 127.0.0.1:9130`
     
     No token, no secret, no error, no stack trace.
   - Process tree: `hermes.exe` (PID 18076, the process I started) → `python.exe` (PID 28308) → `python.exe` (PID 20628, the actual listener on 9130) — a normal launcher→interpreter→worker chain, all descending from the process I started.
   - Vyron Code: confirmed not running (no listener on 3055) — unchanged.
   - Vyron Pro (`vyronpro-vyron-1`) and the unrelated `hangikargoo_*`/`open-webui`/`owui_clean`/`aetheris_postgres` containers: all unchanged, none restarted, none queried beyond a read-only `docker ps`.
   - Hermes TUI process: untouched.

---

**HERMES_SERVE_9130_START_REPORT**
- Authorization scope: Start `hermes serve --host 127.0.0.1 --port 9130` only; no chat/context-attach/session.create/prompt.submit/provider/deliberation/write-capable action
- Previous port 9130 state: empty (`ECONNREFUSED`, re-confirmed fresh immediately before starting)
- Existing critical sessions: none blocking — Vyron Pro/hangikargoo/open-webui containers running but unrelated and untouched; no active Vyron Code server; no known active Hermes TUI task
- Wrong `hermes gateway run` command executed: NO
- Official `hermes serve` command verified: YES — re-confirmed via its own `--help` text immediately before starting
- `hermes serve` WebSocket/API role confirmed: YES — "the JSON-RPC/WebSocket gateway the desktop app and remote clients connect to. Headless: it never opens a browser UI."
- Host/port option verification: YES — `--host`/`--port` flags present and used explicitly (`127.0.0.1`, `9130`)
- Stable token source available: yes — `HERMES_DASHBOARD_SESSION_TOKEN` present (boolean check only); loaded automatically by Hermes's own existing env-loading mechanism, never touched or injected by me
- Token values/fragments/hashes exposed: none
- Hermes serve started: YES
- Hermes serve PID/start time: launcher PID 18076 (`hermes.exe`) / 2026-09-13 20:57:26; actual listening worker PID 20628 (`python.exe`, child of 28308, child of 18076 — confirmed via process-tree lookup)
- Hermes serve bind address/port: `127.0.0.1:9130` only — confirmed by both `netstat` and the startup log's own "Hermes backend listening on 127.0.0.1:9130" line
- IPv6/wildcard/LAN bind observed: NO — no `[::]`/`[::1]`/`0.0.0.0`/`:::9130` listener at any point; a LAN-IP connection attempt timed out (unreachable)
- 127.0.0.1 TCP reachability: PASS
- Health endpoint: `/health` → 404 (not this build's path name — not an error); `/` → 200; `/api/ws` (plain GET, no upgrade) → 401, distinctly different from a made-up path's 404 — server is definitively up and correctly routing
- LAN access rejection: confirmed (timeout on LAN IP)
- `/api/ws` registration evidence: CONFIRMED via the 401-vs-404 HTTP status differential described above — no handshake, no upgrade header, no token ever sent
- Startup log safe status: clean — two short lines, explicit success confirmation, no error
- Startup log secret exposure: none — both log files read in full, contain no token/secret
- Hermes TUI process unchanged: yes
- Vyron Code PID/bind unchanged: yes — still not running, config untouched
- Vyron Pro container/process unchanged: yes — read-only `docker ps` only, no restart
- Bridge/OmniRoute/deliberation/Open WebUI unchanged: yes — none touched or queried beyond an incidental, unrelated `docker ps` listing
- WebSocket handshake calls: 0
- session.create calls: 0
- prompt.submit calls: 0
- session.interrupt calls: 0
- Provider/model calls: 0
- Deliberation calls: 0
- PROJECT_STATE/memory/DecisionRecord writes: 0
- File writes: this report (inside `D:\Vyron Code`) plus two log files in this session's own scratchpad directory (outside `D:\Vyron Code`, not Git-tracked)
- Terminal commands: `--help`/`--status` checks (read-only), the single `Start-Process` launch, `netstat`, a raw TCP-connect probe, plain (non-upgrade) `curl` GETs to `/`, `/health`, `/api/ws`, and one made-up path, `Get-CimInstance` process-tree lookups, and direct reads of the two log files — no other terminal activity
- Git operations: 0
- Files changed: `HERMES_SERVE_9130_START_REPORT.md` (new, in `D:\Vyron Code`); two new log files outside `D:\Vyron Code` (scratchpad only)
- Remaining blocker: none for this task's own scope
- Next action requiring explicit approval: a real end-to-end Vyron Code smoke test (one `session.create` + one `prompt.submit` with a genuinely attached context item) against this now-running gateway — not authorized or attempted here
