# Vyron Code v0.1 — Foundation Audit

Task: VYRON_CODE_V01_FOUNDATION_AUDIT. Strictly read-only — no source file was modified to produce this report. Verification performed via source review, `tsc --noEmit`, `vitest run`, `next build`, live `curl` calls against the already-running dev server, and Windows process/port inspection (`Get-NetTCPConnection`, `Get-Process`). No existing service was restarted; no git command was run; no Hermes/Bridge/deliberation call was made.

## 1. Blueprint compliance

Against `VYRON_CODE_V01_PRODUCT_BLUEPRINT.md`'s v0.1 component map:

| Component | Status | Notes |
|---|---|---|
| Project Navigator | **Done** | [components/FileTree.tsx](components/FileTree.tsx), read-only, canonical-root scoped |
| Chat/Cowork panel | **Partial** | [components/ChatPanel.tsx](components/ChatPanel.tsx) — real `session.create`→`session.activate`→`prompt.submit` + SSE-driven task/tool timeline is implemented and works. **Chat/session list is NOT implemented** — v0.1 only supports one ad-hoc session per page load, no history/resume UI, despite the Blueprint listing "a chat/session list" as in-scope |
| File viewer | **Done** | [components/FileViewer.tsx](components/FileViewer.tsx), Monaco, read-only |
| Search | **Partial** | Backend route [app/api/search/route.ts](app/api/search/route.ts) works (verified: 46 real matches on a live query) — **no search UI component exists at all**. Not reachable from the running app today |
| Context selector | **Not implemented** | No component. `context_selections` SQLite table exists in the schema but nothing in the codebase ever writes a row to it |
| Context inspector | **Not implemented** | No component |
| PROJECT_STATE / scoped memory read view | **Not implemented (by design, documented)** | Backend routes exist and correctly return `501 not_yet_authorized` (blocked on the separately-authorized `vyron_code` Bridge identity, per Acceptance Criteria) — but there is also no UI panel that would even call them once unblocked |
| Git panel | **Partial** | [components/GitPanel.tsx](components/GitPanel.tsx) only surfaces `git status`. `git log` and `git diff` routes exist and were verified via direct API calls but have **no UI surface** |
| Terminal panel (disabled placeholder) | **Done** | [components/DisabledCapabilities.tsx](components/DisabledCapabilities.tsx) — visibly present, no backend capability, matches spec exactly |
| Multi-model action slot | **Done** | Context preview works end-to-end (verified live); `START_MULTIMODEL` correctly disabled with the exact blocked-reason message from the spec; no `/api/multimodel/start` route exists anywhere in the codebase |

**Summary**: the read/write security boundary and the Hermes chat integration (the two highest-priority pieces per the Acceptance Criteria) are solidly implemented and verified. Five UI surfaces the Blueprint describes for v0.1 (search UI, context selector, context inspector, PROJECT_STATE/memory view, session list, git log/diff view) are either missing entirely or backend-only. None of this is a security defect — it's incomplete UI coverage of an otherwise-sound backend.

## 2. Read-only enforcement matrix

| Forbidden capability (Acceptance Criteria #12) | Implementation check | Result |
|---|---|---|
| File write | Grepped for `writeFileSync`/`fs.write` outside `tests/` and `lib/db.ts`'s data-dir bootstrap (non-project-scoped) — none found in any route or lib file | **PASS — not implemented** |
| File create/delete/rename | No route, no handler | **PASS — not implemented** |
| Terminal execution | Only process-execution point in the whole app is [lib/git.ts](lib/git.ts)'s `execFileSync("git", args, ...)` — fixed binary name, fixed flag sets, no shell, no user-supplied command string ever reaches it | **PASS — not implemented** |
| Git stage/commit/push | `lib/git.ts` exposes only `gitStatus`, `gitLog`, `gitDiff` — no `add`/`commit`/`push`/`checkout` function exists | **PASS — not implemented** |
| RAG / embeddings | No vector/embedding dependency in `package.json`, no such code | **PASS — not implemented** |
| Deliberation / multimodel session start | Grepped for any `/start` route or a deliberation-service HTTP call — none exist; `/api/multimodel/preview` only ever reads local `context_selections` rows and returns a static will/will-not-send shape | **PASS — not implemented** |
| PROJECT_STATE / memory write | Both routes are read-only `GET` handlers returning a stub; no `POST`/proposal/commit route exists | **PASS — not implemented** |
| Hermes methods beyond the whitelisted 6 | Grepped every `.call("...")` site in the codebase: exactly `session.create`, `session.activate`, `prompt.submit`, `approval.respond`, `clarify.respond`, `session.interrupt` — nothing else | **PASS** |

## 3. Route inventory (17 routes)

| Route | Method | Purpose | Guard |
|---|---|---|---|
| `/api/projects` | GET/POST | List / register a canonical project root | `resolveCanonicalRoot` on POST; **no denylist against overly-broad roots** — see §7 finding 2 |
| `/api/fs/list` | GET | Directory listing | `guardProjectPath` (parent) + per-entry re-guard |
| `/api/fs/read` | GET | File content | `guardProjectPath`, size cap 5MB |
| `/api/search` | GET | Literal search | `resolveCanonicalRoot` + per-node `resolveCanonicalPath` inside `lib/search.ts` |
| `/api/git/status` | GET | `git status --porcelain=v1 -b` | project→root resolution only (no path param) |
| `/api/git/log` | GET | `git log` (last 50) | same |
| `/api/git/diff` | GET | `git diff` (whole repo or one path) | `guardProjectPath` when `path` is supplied |
| `/api/hermes/session` | POST | `session.create` + `session.activate` | project must exist; local session row created |
| `/api/hermes/prompt` | POST | `prompt.submit` | local `session_id` resolved via DB, never a raw Hermes id from the client |
| `/api/hermes/respond` | POST | `approval.respond` / `clarify.respond` | same |
| `/api/hermes/interrupt` | POST | `session.interrupt` | same |
| `/api/hermes/events` | GET (SSE) | Streams push-frame events for one session | local `session_id` resolved via DB before subscribing |
| `/api/project-state` | GET | Stub, `501` | n/a — no real Bridge call made |
| `/api/memory` | GET | Stub, `501` | n/a |
| `/api/multimodel/preview` | POST | Context "will send" preview | reads only locally-stored `context_selections`; no external call |

No route accepts or executes a client-supplied shell command, file-write payload, or Git-mutating action. No route calls a Hermes method outside the whitelisted 6. No route calls Bridge or deliberation-service for real (the two stub routes return `501` without dispatching a request).

## 4. Secret/path exclusion matrix

| Threat Model requirement | Implementation | Verified |
|---|---|---|
| `.env`, `.env.*` | `DENIED_NAME_PATTERNS` in `lib/canonicalPath.ts`: `/^\.env(\..*)?$/i` | Live curl: `fs/read?path=.env.local` → `path_denied`. Live UI: `.env.local` and `.env.local.example` both absent from the file tree |
| `*.pem`, `*.key`, `*.pfx` | Present in `DENIED_NAME_PATTERNS` | Unit-tested indirectly via the same mechanism as `.env`/`.git` (not separately curl-tested this round, logic identical) |
| `id_rsa*`, `id_ed25519*` | Present | Same |
| `.git/` internals | `/^\.git$/i` denies the whole segment, stricter than the Threat Model's "`.git/config` only" | Live curl: `fs/read?path=.git/config` (via unit test) → `path_denied` |
| `node_modules/` | Present in deny list | Live UI: not listed in the file tree |
| Symlink/junction escape | `fs.realpathSync.native` + containment check in `resolveCanonicalPath` | Real junction created via `mklink /J` in `tests/canonicalPath.test.ts`, confirmed blocked (`path_outside_project_root`) |
| `..` / absolute-path escape | Explicit rejection of absolute input; `..` collapses via `path.resolve` then must still pass containment | Live curl against a **real existing file** (`../Vyron Pro/package.json`) → `path_outside_project_root`; absolute path (`C:/Windows/win.ini`) → `absolute_path_rejected` |
| Anything under `%LOCALAPPDATA%\hermes\` | Not directly listed, but unreachable unless a project root is registered there or a path escapes containment into it — both already blocked | Not separately tested (no project root points there); containment logic covers it structurally |

No gap found between the Threat Model's required deny set and the implemented `DENIED_NAME_PATTERNS` — implementation matches or exceeds spec on every listed item.

## 5. Junction/symlink test and cleanup result

Re-ran `npx vitest run`: **10/10 tests passed**, including `blocks a junction created inside the project root that points outside it` (creates a real NTFS junction via `mklink /J`, asserts the API layer's `resolveCanonicalPath` returns `path_outside_project_root`).

Cleanup verification:
- `Get-ChildItem $env:TEMP -Filter 'vyroncode-test-*'` → **no matches** (the test's `afterAll` `fs.rmSync(sandboxRoot, { recursive: true, force: true })` is working)
- `Get-ChildItem -Recurse -Attributes ReparsePoint` under both `$env:TEMP` and `D:\Vyron Code` → **no matches** — no leftover junction/reparse point anywhere

## 6. SQLite / local data handling

`data/vyroncode.sqlite` (via `node:sqlite`, no native build step) inspected directly:
- `projects`: 1 row (`D:\Vyron Code` itself, registered during the prior session's live UI walkthrough)
- `sessions`: 0 rows (no real Hermes session was ever created — `.env.local`'s `HERMES_HOST`/`HERMES_PORT` are still empty, confirmed below)
- `audit_log`: 16 rows, all metadata-only (`action_kind`, `target` = a relative path or query string, `status`, `ts`) — **no file content, no secret value, no request/response body** in any row, consistent with the Threat Model's audit design
- `context_selections`: 0 rows — table exists but nothing in the current UI ever inserts into it (see §1)

`.gitignore` covers `data/*.sqlite`, `data/*.sqlite-journal`, `data/*.sqlite-wal`, `.env.local`, `node_modules/`, `.next/`, `*.log`. **Gap**: does not cover `tsconfig.tsbuildinfo` (a ~119KB TypeScript incremental-build cache, non-secret but a pure build artifact that would otherwise get committed).

## 7. Dev server PID / port / bind

- Process: PID **5428** (`node.exe`, `C:\Program Files\node --version\node.exe`), started 2026-09-11 13:35:54, still running
- Port: **3055** (moved off 3010 during the prior session after discovering 3010 was already owned by an unrelated pre-existing process, PID 29004 — confirmed **still untouched, still owned by 29004**, not restarted)
- Health: `GET http://localhost:3055/` → `200`
- **Bind — finding**: `Get-NetTCPConnection -LocalPort 3055` shows `LocalAddress :: ... State Listen` — the wildcard/all-interfaces address, not loopback-only (`127.0.0.1`/`::1`). This is corroborated by the dev server's own startup log, which printed `- Network: http://172.25.224.1:3055` (a LAN-reachable address) alongside `- Local: http://localhost:3055`. `package.json`'s `dev`/`start` scripts pass only `-p 3055`, no `-H`/`--hostname`, so Next.js defaults to binding all interfaces.

## 8. Existing implementation defects

Ranked by severity; none of these are path-escape bypasses — the core containment guarantee held in every test performed, including live attempts against real files outside the root.

1. **[HIGH] Dev server reachable from the local network, with zero authentication on any route.** Because of the wildcard bind (§7) and because no route in the inventory (§3) checks any credential/session/origin, any device on the same network segment that can reach this machine's LAN IP on port 3055 can browse, read, and search every file under every registered project root, and can start/drive a real Hermes chat session as this user — with no login, token, or prompt. This directly contradicts the Threat Model's stated non-goal posture ("still a localhost-only tool, same posture as every other service in this engagement") — the code does not currently enforce that claim.
2. **[MEDIUM] `POST /api/projects` has no confirmation gate or denylist against overly-broad roots.** Any existing directory the caller names becomes a registered project root immediately, with no approval step and no check against suspiciously broad choices (a drive root, the user's home directory, `%LOCALAPPDATA%`, `%APPDATA%`). Once registered, every file under it that isn't individually denylisted becomes readable/searchable. Not a containment bypass — a scope-expansion risk if this route is ever reachable by something other than the intended human operator (see finding 1).
3. **[LOW-MEDIUM] `fs/read`'s binary/text classification is fragile.** `guard.absolutePath.slice(guard.absolutePath.lastIndexOf("."))` operates on the full absolute path rather than `path.extname()` on the basename — an extensionless file, or a file under a dotted directory name, is misclassified and always falls through to the `utf8` branch. No security impact (worst case: a binary file with no recognized extension is decoded as UTF-8 with replacement characters instead of being returned as base64), but it is inconsistent with `lib/search.ts`'s own null-byte-sniffing binary detector, which does this correctly.
4. **[LOW] `npm run lint` is broken.** `eslint-config-next` is a declared devDependency but no `eslint.config.js` (flat config, required by ESLint 9) exists in the repo — running the script fails immediately with "ESLint couldn't find an eslint.config.js file." Not caught by `tsc`/`vitest`/`next build`, all of which pass cleanly.
5. **[LOW] `.gitignore` gap**: `tsconfig.tsbuildinfo` is not excluded (§6).
6. **[INFO, non-blocking]** `fs/list`'s per-entry deny-list re-check re-resolves the project and re-runs `fs.realpathSync.native` on the root once per child entry (via a second `guardProjectPath` call per entry). Correct, but O(n) redundant syscalls per directory listing — a forward-looking performance note for larger repos, not a defect at v0.1's expected scale.

## 9. Required fixes before real Hermes chat wiring

1. Fix finding **8.1** (bind to loopback only) before ever putting a real `HERMES_DELIBERATION_API_TOKEN`-adjacent credential or a live Hermes session behind this server — right now, wiring real Hermes connectivity would make a real, unauthenticated, network-reachable chat surface into this user's Hermes Agent.
2. Populate `.env.local`'s `HERMES_HOST`/`HERMES_PORT` (still empty — confirmed via `sessions` table being empty and the UI's own graceful "must be set" error, not attempted by this audit).
3. No code change is required in `lib/hermesClient.ts`/the four `/api/hermes/*` routes themselves — the whitelisted-method enforcement (§2) and local-session-id-only trust model (§3) are already correct for a single-user localhost tool; they only become insufficient once finding 8.1 is fixed to be reachable beyond localhost, which is why 8.1 is the actual blocker, not the Hermes wiring code.

## 10. Required fixes before v0.1 acceptance (per `VYRON_CODE_V01_ACCEPTANCE_CRITERIA.md`)

1. Fix **8.1** (loopback-only bind) — acceptance criterion #14 ("no secret ... ever sent to the browser") is satisfied, but the broader implicit posture ("localhost-only tool") from the Threat Model is not yet enforced in code.
2. Build the missing UI surfaces identified in §1: search box, context selector, context inspector, PROJECT_STATE/memory read panels (can render the documented `501` stub gracefully until the Bridge identity is authorized), a minimal session list, and Git log/diff views. None of these require new backend routes — the backend already exists for all but context selector/inspector persistence.
3. Wire the Context Inspector's UI to actually write rows into `context_selections` when a user selects a file snippet or diff hunk — currently nothing populates this table, so `/api/multimodel/preview`'s `selected_context_ids` parameter is untestable end-to-end from the UI.
4. Fix **8.3** (extension detection in `fs/read`) — low priority but cheap to fix and removes an inconsistency before more file-type-dependent UI is built on top of it.
5. Add `eslint.config.js` (finding 8.4) so `npm run lint` is actually usable.
6. Add `*.tsbuildinfo` to `.gitignore` (finding 8.5) before the first `git init`/commit.
7. Consider (not blocking, but worth a decision): a confirmation step or denylist on `POST /api/projects` (finding 8.2) before this tool is used by anyone other than the developer testing it directly.

## 11. Files changed

**None.** This audit performed only: source reads, `tsc --noEmit`, `vitest run`, `next build`, read-only `curl` calls against the already-running dev server (GET requests only, against routes that were already live from the prior session), and Windows-native read-only process/port/filesystem inspection (`Get-NetTCPConnection`, `Get-Process`, `Get-ChildItem`). The dev server (PID 5428, port 3055) was left running exactly as found. Port 3010's unrelated pre-existing process (PID 29004) was not touched. No git command was run. This report itself (`VYRON_CODE_V01_FOUNDATION_AUDIT.md`) is the only new file, per the task's explicit allowance to produce a new audit report.
