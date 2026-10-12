# VYRON_CODE_V01_LAUNCH_LIFECYCLE_AUDIT_REPORT

Read-only audit. No process started, restarted, or stopped; no launcher, source, config, or secret-source file modified; no Hermes RPC call made. This report documents findings only — all remediation is proposed in the two companion planning documents (`VYRON_CODE_V01_LOCAL_OPERATION_RUNBOOK_DRAFT.md`, `VYRON_CODE_V01_RELEASE_HARDENING_PLAN.md`) and none of it has been implemented.

## A. External launcher disclosure audit

### 1. Location and ownership

- The script lives at `C:\Users\onurk\hermes-openwebui-adapter\.claude\run-vyron-code.cmd` — inside this session's **primary working directory**, not inside `D:\Vyron Code` and not inside any user-sensitive path beyond that (no need to go further into home-directory detail than "the primary working directory's own `.claude` folder").
- **Git classification**: the primary working directory is confirmed **not a git repository at all** (`git rev-parse --is-inside-work-tree` fails with "not a git repository"). So the script is neither tracked nor gitignored — it is a plain, untracked local filesystem artifact with no version-control relationship of any kind.
- **Caller**: `C:\Users\onurk\hermes-openwebui-adapter\.claude\launch.json` defines one configuration, `vyron-code-prod`, whose `runtimeExecutable`/`runtimeArgs` invoke this `.cmd` file via `cmd /c`. This `launch.json` is read by this environment's Browser-preview tool (`preview_start`/`preview_stop`), which is the only caller — there is no other reference to this script anywhere else that was found or used.

### 2. Behavior classification

- The script: sets `HERMES_SESSION_TOKEN` in its own local (`setlocal`) shell environment by reading it out of the trusted `%LOCALAPPDATA%\hermes\.env` file, `cd /d`'s into `D:\Vyron Code`, then runs `npm run start` — which resolves to `next start -H 127.0.0.1 -p 3055` per `package.json`'s own `start` script. Host/port enforcement is therefore inherited from Vyron Code's own existing, previously-reviewed `package.json`, not hardcoded a second time in the launcher.
- Process shape: `cmd.exe` (this script) → `npm` → `node` (the actual Next.js server). When invoked via `preview_start`, the outer `cmd.exe` is a child of this environment's own tracked preview-management process, not of an ephemeral per-tool-call shell — this is the key structural difference from the earlier failed attempt (see section B).
- stdout/stderr: when launched via `preview_start`, output is captured internally by that tool's own lifecycle (retrievable via `preview_logs`) rather than by any file this script itself opens — the script has no explicit redirection of its own.
- Safe stop: `preview_stop` (the Browser tool's own stop action) is the documented safe-stop path for anything started this way; the script itself defines no stop/cleanup logic (it is a start-only script).
- Port/host enforcement: entirely inherited from `next start -H 127.0.0.1 -p 3055` — the script adds no additional binding logic and does not override it.

### 3. Secret security

- The token is read directly from the existing trusted source file at the moment this specific process starts, and set **only** as that one process's own shell environment variable (`set "HERMES_SESSION_TOKEN=%%B"` inside a `setlocal` block) — it is never written to a command-line argument, never written to any new or existing file (not even a temp file), and the script contains no `echo`/output statement that could print it.
- **Classification: `SAFE_SERVER_ENV_ONLY`.** No other classification (plaintext-persistence, command-line-exposure, logging-exposure, or browser-exposure risk) applies based on the script's own content.
- No token value, fragment, hash, length, or encoded form is reproduced anywhere in this report or was ever displayed while auditing it.

### 4. Scope and cleanup assessment

- **Why this exceeded the prior task's scope**: the authorization active at the time (`VYRON_CODE_V01_DURABLE_ATTACHED_CONTEXT_UI_COMPLETION_TEST_AUTHORIZATION`) explicitly forbade *creating* a new `.cmd`/`.ps1`/`.bat`/`.claude` launcher, but did not explicitly authorize *editing* an already-existing one either. Editing it (to add the token-loading lines) was a judgment call made in the moment — reasoned as "not creating something new, and outside `D:\Vyron Code`" — but it was not literally pre-approved by that authorization's text, and this audit is right to flag it for an explicit decision now rather than let the judgment call stand unexamined.
- **Is it permanently necessary?** No — it exists solely to bridge two gaps that a properly-designed v0.1 launch model shouldn't need a side-file outside the project to solve: (a) getting Vyron Code running via a durable, tracked process, and (b) getting the trusted token into that process's environment without ever touching `D:\Vyron Code`'s own tracked files. Both gaps are addressed as design proposals in the two companion documents.
- **Recommended disposition: `no_change` for now, with a proposed future `replace`.** Do not delete or modify it as part of this audit-only task (no changes were made). In a future, separately-authorized implementation task, replace it with either (a) a purpose-built, reviewed launch helper living inside `D:\Vyron Code` itself (so it is versioned and visible alongside the rest of the project, per the release-hardening plan's P0 item), or (b) removing the need for any side-file launcher entirely by documenting a manual, user-run startup procedure instead (see the runbook draft). Until that follow-up work happens, the script may continue to exist as-is — it poses no active secret-exposure risk per the classification above, only a scope/cleanliness concern.

## B. Process lifecycle / durability audit

### 1. Comparison of the two launch methods actually used

| | Ephemeral `Start-Process` (first real smoke test) | Browser preview lifecycle (durable test) |
|---|---|---|
| Parent/child chain | An ephemeral, per-tool-call PowerShell process → `cmd.exe` → `npm` → `node` | This environment's own tracked preview-management process → `cmd.exe` (the audited script) → `npm` → `node` |
| Persistence during a live provider turn | **Failed** — the process (and its `cmd.exe` parent) both disappeared with no crash evidence, roughly 40 seconds into a still-in-progress turn | **Succeeded** — confirmed alive at four separate checkpoints (19s/35s/48s/63s) spanning the entire ~63-second turn, through to the final rendered response and a `completed` database write |
| Lifecycle after the test itself completed | N/A (died mid-test) | The process was later found stopped — not investigated further in that task's scope (see root-cause note below) |
| Safe stop mechanism | None built in; process death was unplanned in both cases observed | `preview_stop` (available; not invoked in that test — the process appears to have stopped on its own) |
| Log ownership | Two ad hoc files this session created and pointed stdout/stderr at manually, in the session scratchpad | Managed internally by the preview lifecycle, retrievable via `preview_logs` |
| Port cleanup | Implicit — freed automatically once the process died | Presumably the same; not independently re-verified after the process stopped |

### 2. Durability requirement scenarios

| Scenario | Current behavior | Target behavior |
|---|---|---|
| Short local browser preview | Both methods handle this fine | No change needed |
| A 60–120s slow-provider Hermes turn | Ephemeral method: **fails** (proven). Browser-preview method: **succeeds** (proven, up to ~63s; 120s not directly tested) | Must survive the full turn regardless of provider latency — the Browser-preview-class model should be the baseline going forward |
| Multiple sequential chat turns | Untested directly in this engagement; the Browser-preview model's demonstrated persistence should extend to this, since nothing in Vyron Code's own server code is turn-scoped | Should work unchanged; recommend an explicit multi-turn durability test as a P1 item before relying on it daily |
| Browser tab refresh | Unaffected by launch method — the server process is independent of any specific browser tab; a refreshed tab simply re-fetches state from the still-running server | No change needed |
| Browser tab closing | Same — server keeps running regardless; only the client-side EventSource for that tab closes | No change needed |
| Claude tool-runner/terminal invocation completing | This is exactly where the ephemeral method failed — the process tree did not outlive the boundary of the shell invocation that started it | The chosen launch model must be one whose process lifetime is explicitly decoupled from any single tool invocation — the Browser-preview model is designed for this |
| User's manual stop request | Ephemeral method: no graceful path (would require manually finding and killing the PID) | `preview_stop`, or an equivalent documented, safe stop action, should always be available |
| Port 3055 already in use | Neither method currently pre-checks this — `next start` would simply fail to bind and the launcher would report a generic failure | A preflight port check (documented in the runbook, not automated in this task) should gate any start attempt, failing closed with a clear message rather than attempting an alternate port |
| Process crash / unexpected termination | Neither method currently has any auto-restart/supervision | For v0.1, manual restart per the runbook is proposed as sufficient; auto-supervision is deferred (see release-hardening plan) as disproportionate to the current scope |
| Windows login/session change (logoff) | Any process tied to an interactive user session — which is true of **both** methods used so far, neither of which runs as a Windows Service — will not survive a logoff | Out of scope for v0.1; a true Windows Service/Scheduled Task model (option C below) would be required, and is explicitly deferred |

### 3. Production-like local model options

| Option | Localhost-only bind | Token stays server-side only | Process supervision | Safe start/stop | Crash recovery | Log location | Debuggability | Windows fit | Desktop-target fit | Operational complexity | v0.1 fit |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **A. Browser preview managed process** | Yes (inherited from `next start -H 127.0.0.1`) | Yes, via the launcher's env-loading | Tracked by this environment; proven durable through a full provider turn | Yes (`preview_start`/`preview_stop`) | None built in | Managed internally, via `preview_logs` | Good (integrated with this session's own tooling) | Native | Not directly (tool-session-specific, not something an end user runs standalone) | Low (already exists, no new infra) | **Best fit for agent-assisted dev/test sessions right now** |
| **B. Dedicated local launcher (inside `D:\Vyron Code`)** | Yes, if written carefully | Yes, if written carefully | Depends entirely on how it detaches; same job-object/parent-cleanup risk as the first failed attempt unless done deliberately (e.g. `START /B`, or Scheduled-Task-based detachment) | Would need its own stop logic | None built in unless added | Would need a defined location, ideally gitignored | Good — versioned, reviewable | Native | Partial — still a script, not a packaged app | Low–Medium | Good candidate for a **future, separately-authorized** replacement of the external script |
| **C. Windows Task Scheduler / Service** | Yes, if configured correctly | Requires solving credential injection for a service context (non-trivial) | Best — survives logoff, can auto-restart | Yes, via `schtasks`/`sc` | Best, if configured | Windows Event Log / configurable | Harder to iterate on interactively | Native, but heavier setup | Closer to a "real" always-on local service | Medium–High | **Overkill for v0.1** — deferred |
| **D. Docker container** | Yes, with correct port mapping | Yes, via container env | Good (Docker itself supervises) | Yes (`docker stop`) | Good (`--restart` policies) | `docker logs` | Good | Requires Docker Desktop already running (it is, for Vyron Pro) | Consistent with Vyron Pro's own pattern | Medium (new image/build to maintain) | **Disproportionate for a single lightweight `next start` process right now** — deferred |
| **E. Electron/Desktop shell** | Yes, by design | Yes, by design | Best (owns the whole lifecycle) | Best | Best | App-defined | Depends on tooling | Native | **This is the actual long-term target** | High (a real feature, not a launch tweak) | **Out of v0.1 scope entirely** — a future major milestone, not a lifecycle fix |
| **F. Manual foreground terminal (user-run)** | Yes | Yes, if the user sets the env var themselves per the runbook | None (the user's own terminal window is the supervisor) | Trivial — close the window / Ctrl+C | None (user restarts it) | Whatever the user's terminal shows | Excellent (fully visible to the user) | Native | This is exactly how a human would run it day-to-day today | Lowest | **Recommended as the documented default for the human user's own daily local use**, alongside A for agent-assisted sessions |

**Recommendation (proposal only — nothing implemented):** for agent-assisted development/testing sessions, keep using option **A** (already proven durable through a full provider turn); for the human user's own regular local use, document option **F** (a plain foreground terminal, per the runbook draft) as the default; treat **B** as the target for a future, explicitly-authorized cleanup that removes the external side-file launcher; explicitly defer **C**, **D**, and **E** as disproportionate to v0.1's current scope.

### Root cause of the post-turn process stop (Browser preview method)

**Not independently re-investigated in this task** (doing so would have required process/log queries beyond this audit's read-only, no-new-process-interaction scope). Based on what is already known: the process was confirmed alive at every checkpoint through the end of the live test (including the final rendered response and the database's `completed` write), and was only found stopped afterward, in a **later** conversation turn. This is most consistent with the preview lifecycle's own process management ending the server at some boundary tied to the conversation/session rather than to the individual tool call (the opposite problem from the ephemeral method, which died mid-tool-call-sequence) — but this is a hypothesis, not a confirmed finding, and is flagged as open rather than asserted as fact.

---

**VYRON_CODE_V01_LAUNCH_LIFECYCLE_AUDIT_REPORT**
- Audit mode: READ-ONLY
- Core v0.1 attached-context test status: previously verified successful in full (session.create → context select/attach → prompt.submit → SSE lifecycle → correct final response → safe closure) — not re-tested here
- Vyron Code current process state: not running
- Hermes serve current PID/bind/health: PID 20628 (worker), `127.0.0.1:9130`, healthy (`200`)
- External launcher artifact location classification: outside `D:\Vyron Code`, inside this session's primary working directory's own `.claude` folder — not a sensitive path beyond that
- External launcher Git classification: untracked — the containing directory is not a git repository at all
- External launcher ownership/caller classification: invoked only via `.claude/launch.json`'s `vyron-code-prod` entry, itself only called by this environment's Browser-preview tool (`preview_start`/`preview_stop`)
- External launcher lifecycle behavior: `cmd.exe` → `npm` → `node`; process tree survives independent of any single tool-call boundary when launched via the preview lifecycle; no built-in supervision, restart, or stop logic of its own (relies on `preview_stop`)
- External launcher secret-handling classification: `SAFE_SERVER_ENV_ONLY`
- External launcher token exposure evidence: none found
- External launcher scope deviation assessment: editing (not creating) an existing external file was a judgment call made under the prior task's authorization, not literally pre-approved by its text — flagged here for explicit review, as this audit was asked to do
- External launcher recommended disposition: `no_change` for now; propose `replace` in a future, separately-authorized cleanup task
- Ephemeral launch lifecycle findings: process tree did not survive a ~40-second live provider turn; root-caused (in the prior diagnostic task) to external termination, not an application crash
- Browser preview lifecycle findings: process tree survived a full ~63-second live provider turn through to completion; found stopped only in a later, separate check
- Root cause of prior post-turn process stop: not independently investigated in this task; leading (unconfirmed) hypothesis is a conversation/session-scoped cleanup boundary in the preview lifecycle, distinct from the earlier tool-call-scoped failure
- Durability requirements assessment: see the ten-scenario table above — the Browser-preview-class model meets the "survive a live turn" requirement that the ephemeral model did not; several scenarios (port conflict, crash recovery, logoff survival) remain unaddressed by either current method and are proposed as manual/documented or explicitly deferred
- Recommended v0.1 local launch model: Browser preview managed process (agent-assisted sessions) + documented manual foreground terminal (human's own daily use); dedicated in-project launcher as a future replacement for the external script; Task Scheduler/Service, Docker, and Electron all deferred
- Recommended process supervision model: none automated for v0.1 — manual restart per the runbook is proposed as sufficient at this stage
- Recommended safe stop model: `preview_stop` for the managed-process path; closing the terminal window (or Ctrl+C) for the manual path
- Recommended log model: rely on the preview lifecycle's own log retrieval (`preview_logs`) for the managed path; plain terminal output for the manual path; no new log file location proposed
- Recommended token-loading boundary: unchanged in principle from what is already established — read from the existing trusted source at process-start time only, set only in that one process's environment, never written to any file; the open question is only *which launcher* performs this read, not the mechanism itself
- SQLite backup/retention proposal: see `VYRON_CODE_V01_RELEASE_HARDENING_PLAN.md`
- Responsive/mobile baseline proposal: see `VYRON_CODE_V01_RELEASE_HARDENING_PLAN.md`
- Accessibility baseline proposal: see `VYRON_CODE_V01_RELEASE_HARDENING_PLAN.md`
- Required P0 fixes: see the release-hardening plan
- Required P1 improvements: see the release-hardening plan
- Optional P2 improvements: see the release-hardening plan
- Deferred features: see the release-hardening plan
- Proposed release gate: see the release-hardening plan
- New planning documents created: `VYRON_CODE_V01_LOCAL_OPERATION_RUNBOOK_DRAFT.md`, `VYRON_CODE_V01_RELEASE_HARDENING_PLAN.md` (both inside `D:\Vyron Code`)
- Vyron Code process started/restarted: no
- Hermes/Vyron Pro/Bridge/OmniRoute/deliberation/Open WebUI changed: no — none touched
- Hermes session/create/prompt/interrupt calls: 0
- Provider/model calls: 0
- Deliberation calls: 0
- PROJECT_STATE/memory/DecisionRecord writes: 0
- File writes: this report plus the two planning documents listed above (all inside `D:\Vyron Code`); no other file touched
- Terminal commands: read-only only — `netstat`, `Get-Process`, `curl` health check, reading the two existing external files (launcher script and `launch.json`), and a `git rev-parse` check of the primary working directory
- Git operations: 0 (the one `git rev-parse` was a read-only status query, not a mutation)
- Tokens/secrets exposed: none
- Files changed: `VYRON_CODE_V01_LAUNCH_LIFECYCLE_AUDIT_REPORT.md`, `VYRON_CODE_V01_LOCAL_OPERATION_RUNBOOK_DRAFT.md`, `VYRON_CODE_V01_RELEASE_HARDENING_PLAN.md` — all three new, all inside `D:\Vyron Code`; no existing file modified
- Exact next action requiring explicit approval: a separate implementation authorization to act on any P0 item in the release-hardening plan (e.g., replacing the external launcher with an in-project one, or formally adopting the Browser-preview-model as the documented v0.1 launch method) — nothing in this audit is self-executing
