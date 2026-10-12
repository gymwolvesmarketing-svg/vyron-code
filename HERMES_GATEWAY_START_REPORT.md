# HERMES_GATEWAY_START_REPORT

**Status: BLOCKED at Preflight — gateway NOT started.** The authorization's own mandatory preflight check (item 1.3: verify the target command is the correct, official one via source-level/installed CLI help before starting anything) caught a command-naming mismatch. Per the authorization's spirit ("stop and report" on a preflight problem, never guess), nothing was started.

## What preflight found

`hermes --help` lists a top-level `gateway` subcommand. Running `hermes gateway --help` (read-only, no side effects) shows:

```
usage: hermes gateway [-h] [--accept-hooks]
                      {run,start,stop,restart,status,install,uninstall,list,setup,migrate-legacy,enroll}
                      ...

Manage the messaging gateway (Telegram, Discord, WhatsApp, Weixin, and more)
```

**`hermes gateway run` is the messaging-platform gateway** (Telegram/Discord/WhatsApp/Weixin bot connectors) — this is exactly what the earlier reconciliation report's `gateway_state.json` evidence was actually showing (`"platforms":{"webhook":{...}}`), which in hindsight was a messaging-webhook state, not a `/api/ws` dashboard-backend state. It is **unrelated to port 9130 or to the JSON-RPC/WebSocket API Vyron Pro/Vyron Code connect to.**

Checking the other candidates:

```
hermes serve --help
  "Run the Hermes backend server — the JSON-RPC/WebSocket gateway the
   desktop app and remote clients connect to. Headless: it never opens
   a browser UI."
  --port PORT   Port (default 9119, 0 for auto-assign by OS)
  --host HOST   Host (default 127.0.0.1)

hermes dashboard --help
  "Launch the Hermes Agent web dashboard for managing config, API keys,
   and sessions" — same backend, PLUS opens a browser UI.
  --port PORT   Port (default 9119)
  --host HOST   Host (default 127.0.0.1)
```

**`hermes serve`** is the actual, official, headless command matching what Vyron Code/Vyron Pro need (its own `--help` text says so explicitly). Its *default* port is 9119, not 9130 — `config.yaml` was also checked and has no dashboard/serve port override (only an unrelated `codex_app_server_auto`/port 8655 entry for a different subsystem), so the 9130 Vyron Code/Vyron Pro already target was almost certainly set at an earlier point via an explicit `--port 9130` flag when that (now-dead) instance was originally started — not a config default.

Since the authorization names `hermes gateway run` specifically and explicitly states starting anything else is out of its scope, and since `hermes gateway run` would start an unrelated messaging-bot subsystem (with its own webhook/platform side effects I have no visibility into and no authorization to trigger), I stopped here rather than either (a) running the named-but-wrong command, or (b) running the right command (`hermes serve --host 127.0.0.1 --port 9130`) without it being explicitly named.

## Preflight results otherwise (all still performed, read-only)

- Port 9130: confirmed empty again (fresh `netstat` + raw TCP connect → `ECONNREFUSED`).
- No other user service holds port 9130.
- `HERMES_DASHBOARD_SESSION_TOKEN` confirmed **present** in the trusted override source (`%LOCALAPPDATA%\hermes\.env`) — checked as a strict boolean only, never a value, fragment, hash, or length.
- Vyron Pro container (`vyronpro-vyron-1`) confirmed running (read-only `docker ps`, no restart) — up 21h, unrelated to this task.
- No active Vyron Code server was running at check time (previously stopped during the prior task's verification).
- Hermes TUI process untouched, unqueried beyond the read-only checks already done in the prior reconciliation report.

---

**HERMES_GATEWAY_START_REPORT**
- Authorization scope: Start `hermes gateway run` only, localhost-bind + token-load + health/port verification — no chat/context-attach smoke test
- Preflight port 9130 state: empty (no listener, `ECONNREFUSED` on connect)
- Existing critical sessions: none blocking — Vyron Pro container running (unrelated), no active Vyron Code server, no active Hermes TUI task known
- Official gateway command verified: **NO — `hermes gateway run` is confirmed (via its own `--help`) to be the messaging-platform gateway (Telegram/Discord/WhatsApp/Weixin), not the `/api/ws` JSON-RPC/WebSocket server Vyron Code/Vyron Pro connect to. The correct official command is `hermes serve` (or `hermes dashboard` for the UI variant), per that command's own `--help` text.**
- Gateway host/port configuration verified: `hermes serve`/`hermes dashboard` default to `127.0.0.1:9119`; `config.yaml` has no override for this port; the previously-working `9130` target was almost certainly an explicit `--port 9130` flag at original setup time, not a config default
- Stable token source available: yes — `HERMES_DASHBOARD_SESSION_TOKEN` present (boolean check only) in `%LOCALAPPDATA%\hermes\.env`
- Token values/fragments/hashes exposed: none
- Gateway started: **NO**
- Gateway PID/start time: N/A (not started)
- Gateway bind address/port: N/A
- Wildcard/IPv6 LAN bind observed: N/A (nothing started)
- TCP reachability: still refused (unchanged, confirmed fresh)
- Health endpoint: still unreachable (unchanged)
- LAN access rejection: N/A
- `/api/ws` registration evidence: not re-checked this pass (blocked before this step)
- Gateway startup log safe status: N/A
- Gateway log secret exposure: N/A
- Vyron Code PID/bind unchanged: yes — not running, not modified
- Vyron Pro process/container unchanged: yes — confirmed running via read-only `docker ps`, not restarted
- Hermes TUI process unchanged: yes — not touched
- Bridge/OmniRoute/deliberation/Open WebUI unchanged: yes — not touched
- session.create calls: 0
- prompt.submit calls: 0
- session.interrupt calls: 0
- Provider/model calls: 0
- Deliberation calls: 0
- PROJECT_STATE/memory/DecisionRecord writes: 0
- File writes: this report only
- Terminal commands: `hermes --help`, `hermes gateway --help`, `hermes dashboard --help`, `hermes serve --help` (all read-only, print help text and exit — no process started), a boolean-only token-presence check, a redacted `config.yaml` grep, a fresh port/TCP check, and a read-only `docker ps`
- Git operations: 0
- Files changed: `HERMES_GATEWAY_START_REPORT.md` only
- Remaining blocker: need explicit confirmation of the correct command before any gateway/server process is started
- Next action requiring explicit approval: **run `hermes serve --host 127.0.0.1 --port 9130` (headless, no browser UI) instead of `hermes gateway run`** — or `hermes dashboard --host 127.0.0.1 --port 9130` if a browser-based dashboard UI is also wanted — under a corrected authorization naming the right command
