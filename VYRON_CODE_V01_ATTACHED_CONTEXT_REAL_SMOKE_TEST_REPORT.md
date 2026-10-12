# VYRON_CODE_V01_ATTACHED_CONTEXT_REAL_SMOKE_TEST_REPORT

**Outcome: INCONCLUSIVE — interrupted by an unexpected Vyron Code process termination, not by any context/attach/prompt logic failure.** Every step through a real, successful `prompt.submit` dispatch completed exactly as specified (1 `session.create`, 1 context item added and attached, 1 `prompt.submit` returning `200 OK`). Before the streamed response could be observed and verified, Vyron Code's own server process terminated unexpectedly. Per this authorization's explicit prohibition on restarting Vyron Code, **it was not restarted, and no retry was attempted** — this report documents exactly what happened and stops there for your decision on how to proceed.

## What happened, in order

1. **Precheck**: port 3055 was empty; `.env.local` confirmed to contain only `HERMES_HOST`/`HERMES_PORT` (no token).
2. **Start**: launched `npm run start` (→ `next start -H 127.0.0.1 -p 3055`) with `HERMES_SESSION_TOKEN` loaded directly from the trusted source (`%LOCALAPPDATA%\hermes\.env`'s `HERMES_DASHBOARD_SESSION_TOKEN`) into a PowerShell variable and then that one child process's environment only — **never written to any file, never printed, cleared from the launching shell immediately after**. Verified: `127.0.0.1:3055` listening only (no wildcard/IPv6), `200` on both `http://127.0.0.1:3055/` and `http://localhost:3055/`, LAN-IP connection attempt timed out (unreachable).
3. **Context selection**: opened `D:\Vyron Code` (already-registered project) in the browser, selected an existing conversation... no — started **exactly one** new conversation (`+ New chat` → exactly one `POST /api/hermes/session` → `200 OK`), confirmed by the Task Timeline's real `session.info` event ("Session ready") that the WebSocket round-trip to Hermes genuinely succeeded (not merely a local 200).
4. Opened `VYRON_CODE_V0_DISCOVERY.md` (an existing, non-secret, read-only discovery-notes document already in the project — not a new file), selected its first 5 lines (title + read-only-scope status line + one section header — 401 characters, well under the 2,000-char/20-line ceiling), clicked "+ Add to context" → **exactly one** context item created.
5. **Context Inspector verification** (via the live API response, not assumed): `count: 1`, `path: VYRON_CODE_V0_DISCOVERY.md`, `range: lines 1-5`, `charCount: 401`, `tokenEstimate: 101`, `stale: false`, aggregate well under all four limits (1/8 items, 401/48,000 chars, 101/12,000 tokens), and the `willNotSend` list present exactly as mandated (raw chat history, unselected files, full repo, `.env*`/secrets, `.git`, node_modules/build/binary, global memory, USER.md/MEMORY.md, PROJECT_STATE, provider/Bridge/Hermes/deliberation tokens, terminal output).
6. **Explicit Attach**: opened the confirm/preview screen, clicked "Confirm attach" → `POST /api/context/attach` → `200 OK`, response confirmed exactly the one item now attached (server-side revalidation — canonical path, deny-list, fingerprint — passed; the item was not stale).
7. **Prompt**: typed the exact required synthetic prompt verbatim and clicked Send → **exactly one** `POST /api/hermes/prompt` → `200 OK`. Since context was attached, this route's own logic (implemented in the prior task) assembled the `[VYRON_CODE_SELECTED_CONTEXT]` block + the prompt server-side and dispatched it as the one `prompt.submit` call to Hermes. Because that call is fire-and-forget from Vyron Code's own route (`client.call(...).catch(()=>{})`, matching the existing, previously-authorized pattern), the `200 OK` response confirms the dispatch itself succeeded and was already in flight before anything went wrong next.
8. ChatPanel showed `Waiting for model…`, counting up normally (13s → 27s → 40s) — a real, in-progress provider turn.
9. **At this point, Vyron Code's own server process terminated unexpectedly.** The browser's SSE connection to `/api/hermes/events` failed (`ERR_CONNECTION_RESET`, then repeated `ERR_CONNECTION_REFUSED` on auto-reconnect attempts). Checking directly: port 3055 no longer had any listener; the Node process (PID 22996) and its launcher (`cmd.exe`, PID 3420) were both gone entirely.

## Incident investigation (read-only only, no restart, no retry)

- Both log files (`vyroncode-stdout.log`, `vyroncode-stderr.log`) were read in full: no crash, no stack trace, no uncaught-exception output — the stderr log's last line is the routine (and expected) `fatal: not a git repository` message from an earlier `git status` call on a project that genuinely isn't a git repo, unrelated to this incident. The process did not report why it stopped.
- Windows `Application` and `System` event logs (last 10 minutes) were checked for a node.exe crash/fault entry: **none found** — no "Application Error" (event ID 1000/1001) for node.exe. This argues against an internal Node exception/access-violation crash (which normally does generate such an entry) and is more consistent with the process tree having been terminated externally, cleanly, before it could flush any error output.
- For comparison: the `hermes serve` process started in the immediately prior task (also via a detached `Start-Process` launch from this same tool environment) is confirmed **still running and still listening on `127.0.0.1:9130`** at the time of writing — ruling out a blanket "everything this session started gets killed" explanation. The difference in survival is most likely related to how each was launched (`hermes serve` was launched as a raw `.exe`; Vyron Code was launched via a `.cmd` wrapper that itself invokes `npm`, which spawns `node` as a further child — a deeper process tree that may be more exposed to whatever process-tree cleanup mechanism this tool environment applies between tool calls).
- **Root cause: not conclusively determined.** The evidence is most consistent with an external termination of the process tree (not a code-level crash in the context/attach/prompt-assembly logic this task itself built and tested), but this is not proven with certainty.

## Why this was not restarted or retried

This authorization's explicit prohibited-actions list includes "Vyron Pro veya Vyron Code restart" without qualification, and separately forbids more than one `session.create`/`prompt.submit`/attach/interrupt. Restarting Vyron Code to continue observing this same in-flight turn, or starting a fresh session to retry the same prompt, would each violate one of those limits. Per this engagement's standing practice, an ambiguous or blocked situation is reported for an explicit decision rather than resolved by guessing at what's allowed.

**What is still true and unaffected by this incident**: the code paths this task was actually meant to validate (Context Selector → Inspector → Attach → context-aware `prompt.submit` assembly) all executed successfully and exactly once, confirmed via real API responses, not simulated. Only the final "did the model's answer actually reflect the attached context" observation was cut short.

---

**VYRON_CODE_V01_ATTACHED_CONTEXT_REAL_SMOKE_TEST_REPORT**
- Authorization scope: One real end-to-end attached-context smoke test — 1 session.create, 1 context item, 1 attach, 1 prompt.submit, ≤1 interrupt
- Hermes serve PID/bind/health: PID 18076 (launcher) / worker PID 20628; `127.0.0.1:9130` only; still listening and healthy at time of writing (unaffected by this incident)
- Vyron Code PID/bind/health: PID 22996 (Node) — **was** `127.0.0.1:3055` only, healthy (200 on `/`) through the start of the prompt turn; **process terminated unexpectedly ~40-45s into the "waiting for model" phase; not currently running**
- Localhost-only verification: confirmed for both Hermes serve and Vyron Code, for the entire period each was actually running
- LAN/wildcard bind observed: none, at any point, for either process
- Browser direct Hermes connection: none — unchanged, server-side `ws` client only
- Token/secret exposure: none — loaded once into a PowerShell variable from the trusted source, set only as that one child process's environment variable, never written to a file, never printed, cleared from the launching shell immediately after
- Selected project: Vyron Code (`D:\Vyron Code`)
- Canonical project root: `D:\Vyron Code`
- Selected context source type: file_snippet (existing project documentation file)
- Selected context relative path: `VYRON_CODE_V0_DISCOVERY.md`
- Selected context safe classification: a short excerpt (title + read-only-scope status line + one section header) from an existing, non-secret internal discovery-notes document — no credential, path, or private detail
- Selected context size class: small — 401 characters / 101 estimated tokens (5 lines), far under the 2,000-char/20-line ceiling
- Context item count: 1
- Context Inspector will-send verification: confirmed via the live API response — 1 item, correct path/range/char/token counts
- Context Inspector will-not-send verification: confirmed present — all mandated categories listed
- Context server-side revalidation: passed (canonical path + deny-list inherited via `guardProjectPath`; fingerprint fresh)
- Context stale/fingerprint result: not stale
- Context attach confirmation: shown and confirmed once
- Context attached: yes — confirmed via the attach response (1 item)
- Context content persisted in SQLite/logs: no — only metadata/fingerprint, by design (unaffected by the later incident)
- session.create calls: 1
- Canonical cwd verified: yes — by code path (`session.create` is always called with `cwd: project.canonicalRoot`, i.e. `D:\Vyron Code`); not independently re-derived from a live Hermes-side session dump (out of scope — would require an additional RPC call)
- prompt.submit calls: 1 (dispatch confirmed via the route's own `200 OK`; the RPC call itself is fire-and-forget by existing design, matching the prior authorized pattern)
- Prompt classification: exactly the specified short synthetic question, sent verbatim, unmodified
- Attached-context payload inclusion verified: yes, at the assembly/dispatch level (the route's existing, previously-unit-tested logic only assembles and sends the block when an item is attached, which it was) — **not independently confirmed by observing the model's actual final answer**, because the response stream was lost to the incident below
- Raw history/unselected content inclusion: none — the route's existing logic never includes anything beyond the attached item(s) plus the user's own prompt text
- SSE/streaming result: **interrupted** — connection reset then refused, consistent with the Vyron Code process itself terminating, not a Hermes-side failure
- Assistant final response classification: **not observed** (blocked by the incident)
- Selected-context usage verified: **not confirmed** — this is the one success criterion this test could not complete
- session.interrupt/closure: none called — the turn was still in progress ("waiting for model", ~40s) when the process terminated; no interrupt was reachable or attempted, and no retry was performed
- Provider/model calls attributable to test: 1 dispatch attempt (`prompt.submit`) confirmed sent to Hermes; whether the underlying provider call itself completed on Hermes's side is unknown (not queried, to avoid any additional RPC call beyond what was authorized)
- Deliberation calls: 0
- PROJECT_STATE writes: 0
- Memory writes: 0
- DecisionRecord writes: 0
- File writes: this report (in `D:\Vyron Code`) plus two Vyron Code log files in the session scratchpad (outside `D:\Vyron Code`, not Git-tracked) — no project source/config file was created, modified, or deleted
- Terminal commands: preflight checks (port/health/help), the one `Start-Process` launch, post-start verification (netstat/curl/TCP probe), browser-driven UI actions (click/type/select), network-request inspection, and — after the incident — read-only diagnostics only (log reads, `Get-Process`, `Get-WinEvent`, `netstat`) with no restart or retry
- Git operations: 0
- Read-only route inventory: unchanged — no file-write, terminal/shell, Git-write, multimodel-start, or PROJECT_STATE/memory-write route exists anywhere in the codebase (unaffected by this incident)
- Secret/path/junction regression: none observed; `.env.local` re-confirmed token-free
- Services intentionally untouched: Hermes TUI, Bridge, OmniRoute, deliberation-service, Vyron Pro, Open WebUI — none touched, none restarted
- Files changed: this report only (`VYRON_CODE_V01_ATTACHED_CONTEXT_REAL_SMOKE_TEST_REPORT.md`)
- Remaining blockers before v0.1 completion: the attached-context payload has never been confirmed, end-to-end, to actually change the model's answer — this specific test needs to be re-run successfully once Vyron Code's server stability for a full prompt-turn duration is understood/resolved
- Recommended next approval: (1) a short, separate authorization to investigate why Vyron Code's server process terminated unexpectedly during this test (read-only diagnosis, or a supervised restart with closer monitoring) — this is infrastructure/tooling stability, not a code defect in the Git/Context feature work itself; then (2) a repeat of this exact same smoke test once that's resolved
