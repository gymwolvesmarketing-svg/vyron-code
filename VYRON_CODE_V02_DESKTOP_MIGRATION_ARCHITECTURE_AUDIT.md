# VYRON_CODE_V02_DESKTOP_MIGRATION_ARCHITECTURE_AUDIT

Read-only architecture audit. No source, config, test, or documentation file was modified. No app start/stop, no package install, no scaffold, no browser, no native dialog, no HTTP/network request, no Hermes/provider/deliberation call, and no Git mutation was performed while producing this report.

---

## A. Read-only repository and runtime context

- Repository root: `D:/Vyron Code`. Branch: `master`.
- Latest commits: `6fd1d18 feat: add approval and clarification response UI`, `8baaa5a chore: initialize Vyron Code v0.1 read-only workspace baseline`.
- Remotes: none. Existing staged files: 0.
- Current working-tree tracked drift: the same uncommitted P0 workspace-shell redesign change set from the two prior tasks (7 modified, 1 deleted) — unchanged, not touched by this audit.
- Dev server: **running** (confirmed via a read-only `netstat` check — `127.0.0.1:3055` `LISTENING`, PID unchanged from the prior visual-verification task) — left exactly as found; not stopped, not restarted, no HTTP request sent to it.
- Package manager: npm (`package-lock.json` present). No `engines` field in `package.json` (a pre-existing gap, already noted in `VYRON_CODE_V01_LOCAL_RELEASE_READINESS_AUDIT.md`, not re-litigated here).
- `package.json` scripts: `dev` (`next dev -H 127.0.0.1 -p 3055`), `build` (`next build`), `start`/`start:local` (`next start -H 127.0.0.1 -p 3055`, the latter preceded by `node scripts/preflight.mjs`), `preflight`, `backup-db`, `lint`, `test` (`vitest run`).
- Next.js configuration (`next.config.ts`): `reactStrictMode: true`; `serverExternalPackages: ["better-sqlite3"]` (a stale, functionally-inert reference — the actual database is `node:sqlite`, not `better-sqlite3` — already flagged in the release-readiness audit, unchanged here).
- Node version declarations: none beyond `@types/node@^22.9.0` (a type-only hint, not an enforced runtime minimum).

---

## B. Current architecture map

### B.1 Frontend boundaries

| Boundary | File(s) | Notes |
|---|---|---|
| Root shell | `app/page.tsx` | Orchestrates `mainView` state, project state, no routing (single page), no persistence of any UI state |
| Project selection UI | `components/ProjectPicker.tsx` | **The one raw-absolute-path-typing surface in the whole app** — a free-text `<input>` posted to `/api/projects`. This is exactly the input a native folder picker would replace as primary UX |
| Workspace shell | `components/TopBar.tsx`, `components/Sidebar.tsx`, `components/WelcomeHome.tsx` | Pure presentational/navigation, no filesystem access of their own |
| ChatPanel | `components/ChatPanel.tsx` | Talks only to Vyron Code's own `/api/hermes/*` routes, never directly to Hermes |
| Explorer | `components/FileTree.tsx` | Recursive per-directory `GET /api/fs/list` |
| Search | `components/SearchPanel.tsx` | `GET /api/search`, literal-only |
| File Viewer | `components/FileViewer.tsx` | Monaco, `GET /api/fs/read`, `readOnly: true` |
| Git panel | `components/GitPanel.tsx` | `GET /api/git/status\|log\|diff` |
| Context/activity | `components/ContextInspector.tsx`, `components/TaskTimeline.tsx` | Session-scoped context CRUD; client-side event-stream normalization, no persistence |

### B.2 Server/API boundaries

20 routes under `app/api/` (unchanged count since the last audit): `projects`, `fs/list`, `fs/read`, `search`, `git/status`, `git/log`, `git/diff`, `hermes/session`, `hermes/prompt`, `hermes/respond`, `hermes/interrupt`, `hermes/events`, `hermes/health`, `sessions`, `context`, `context/attach`, `context/detach`, `project-state`, `memory`, `multimodel/preview`.

- **Auth/session assumptions**: none. Single-local-operator trust model (stated explicitly in `VYRON_CODE_V01_SECURITY_THREAT_MODEL.md`) — every route trusts any request reaching `127.0.0.1:3055` as the one local operator. This has a direct desktop implication: if the existing Next server is embedded as-is under Electron (Option A below), the same "any local process on loopback can reach it unauthenticated" property carries over — acceptable for a single-operator dev tool, worth hardening before any real end-user distribution (see Section E, item 12).
- **Filesystem path inputs**: `project_id` (opaque, server-resolved) + relative `path`, everywhere except `POST /api/projects`'s raw absolute-path string — the single field a native picker replaces.
- **Existing workspace boundary validation**: `lib/canonicalPath.ts` (`resolveCanonicalRoot`, `resolveCanonicalPath`, `checkRootPolicy`) + `lib/fsGuard.ts` (`guardProjectPath`, re-resolves the root fresh on every request — TOCTOU-safe). **This is pure Node.js (`fs`, `path`, `crypto`) with zero Next.js/browser dependency — directly reusable, unchanged, inside an Electron main process.** This is the single most favorable fact this audit found for a low-risk migration.
- **Existing read-only enforcement**: no write-capable route exists anywhere (repeatedly audited); deny-list blocks `.env*`, `.git`, `*.pem/.key/.pfx`, `id_rsa*`, `node_modules` per path segment, proven via a real NTFS-junction escape test.

### B.3 Local persistence/data

- `lib/db.ts`: `node:sqlite` `DatabaseSync`, file at `data/vyroncode.sqlite`, resolved relative to `process.cwd()`. Tables: `projects`, `sessions`, `context_selections`, `audit_log`. Pure Node built-in — runs identically inside an Electron main process.
- Project persistence (`projects` table) is already, functionally, a "recent workspace" list — directly reusable as the desktop workspace-grant store.
- No prompt/response content is ever persisted (an explicit, tested invariant via `scripts/backup-db.mjs`'s forbidden-column check).
- **No browser storage (`localStorage`/`sessionStorage`) is used anywhere** — all UI-level state (selected project, open view, open file) is plain React state, reset on reload (confirmed live in the prior visual-verification task). Nothing to migrate here beyond intent.
- Generated artifacts: `.next/`, `data/backups/`, `tsconfig.tsbuildinfo` — all `.gitignore`d.
- **Data-location assumption is a real migration item**: `data/` is resolved relative to `process.cwd()`, which assumes launch from the repo root. A packaged desktop app has no such directory — this needs redirecting to a proper per-user app-data location (Electron's `app.getPath('userData')`) before packaging (scoped to phase D-07 below).

### B.4 Hermes integration

- Health route: `app/api/hermes/health/route.ts` — plain TCP connect-and-close, never a WS upgrade, never carries the token.
- Session/prompt/respond boundaries: `lib/hermesClient.ts` (server-only singleton, JSON-RPC-over-WS to `ws://<host>:<port>/api/ws?token=<HERMES_SESSION_TOKEN>`), consumed by `hermes/session` (session.create), `hermes/prompt` (prompt.submit), `hermes/respond` (approval.respond/clarify.respond), `hermes/interrupt` (session.interrupt), `hermes/events` (SSE fan-out via `lib/hermesEvents.ts`).
- Required environment-variable **names** only: `HERMES_HOST`, `HERMES_PORT` (from `.env.local`), `HERMES_SESSION_TOKEN` (terminal-process-environment only, never written to any file — no value read, shown, or handled by this audit).
- Localhost assumption: Hermes Agent's own `tui_gateway` enforces `Origin`/`Host` headers matching `http://<host>:<port>` and requires a loopback peer (403 otherwise) — Hermes itself already assumes same-machine operation, which maps naturally onto "the Electron main process (or an embedded server it controls) is the sole `HermesClient` holder," mirroring today's Next-API-route boundary exactly.
- Error-handling/fail-closed: `getHermesClient()` throws closed on missing host/port/token; every route wraps calls in try/catch with safe generic messages (previously verified: `ws`'s own error messages never leak the URL or token).

### B.5 Build/runtime model

- Next.js 16.3.4 (Turbopack), React 19.2.0, App Router: 20 dynamic (`ƒ`) API routes + 1 static (`○`) page, per the last observed build output.
- SSR/API-route dependency is **heavy** — virtually every real capability (canonical-path checks, SQLite, Git subprocess calls, the Hermes WS client) lives server-side. The client is a thin `fetch`-based layer (`lib/apiClient.ts`). This separation is favorable for migration: the "server" logic is already cleanly isolated from "renderer" logic.
- **Static-export blockers**: `next export`/`output: "export"` is **not viable as-is** — `node:sqlite`, `child_process` (Git), `ws` (Hermes), and `fs` (canonical-path checks) all require a real Node server process; none can run in a static-exported, serverless bundle. This directly rules out treating the current app as a pure static frontend without first porting that logic elsewhere (Option B/C, below).
- Current start command: `next start -H 127.0.0.1 -p 3055` (production) / `next dev` (development) — both bind a real HTTP server process.
- Packaging blockers: `node:sqlite` is an **experimental** Node API (confirmed via the build's own `ExperimentalWarning` output) — its availability inside an Electron main process depends on which Electron version (and thus Node/V8 ABI) is chosen; this needs empirical verification in an actual implementation task, not resolvable by this read-only audit. `@monaco-editor/react` loads Monaco from a CDN by default — would need local-bundling configuration for a fully offline-capable desktop app (a minor, known packaging item).

---

## C. Electron-first feasibility

### C.1 Options evaluated

| | **A. Electron hosts the existing Next server (loopback-only)** | **B. Convert incrementally to static renderer + main-process IPC** | **C. A, hardened (desktop renderer + local read-only service, port-pinned + shared-secret)** | **D. Blocked pending a web-app refactor** |
|---|---|---|---|---|
| Reuse level | Very high — every API route, `lib/`, and component reused unchanged | Low initially — every route's logic must be re-expressed as an IPC handler | High — same as A, plus a thin auth layer | N/A |
| Security model | Unauthenticated loopback HTTP, same as today's web app | Strongest — no HTTP surface at all, individually allowlisted IPC methods | Strong — loopback HTTP but bound to a per-launch random port + shared secret | N/A |
| Migration cost | Low | High | Low–Medium (A + a small auth shim) | N/A |
| Runtime complexity | Two processes (Electron shell + embedded Next server) | One process, more main-process code | Two processes, slightly more main-process code than A | N/A |
| Compatibility with current API routes | Full, no change | None — all rewritten | Full, no change | N/A |
| Compatibility with Hermes integration | Full, no change | Requires porting `lib/hermesClient.ts`'s consumers to IPC | Full, no change | N/A |
| Compatibility with existing SQLite/project state | Full (once the data-location fix in B.5/D-07 lands) | Full (same underlying `lib/db.ts`, called from IPC instead of routes) | Full | N/A |
| Risk level | **Low** | Medium–High (larger surface rewritten at once) | Low–Medium | N/A |

### C.2 Recommendation

**Nothing in the current architecture blocks a desktop migration — Option D does not apply.** The recommendation is a **two-stage path**: start with **Option A** for the first working desktop milestone (matches the user's own "minimal and phased" goal — it reuses literally everything audited in Section B unchanged, and the only genuinely new surface is the native folder picker + its IPC wiring), but **design Option A's embedded server from day one with Option C's hardening** (a per-launch random port and a per-launch shared secret injected only into the preload's own fetch calls) rather than treating that hardening as a later retrofit — retrofitting auth onto an already-shipped unauthenticated local server is strictly harder than building it in from the start, and the cost of doing so up front is small (one shared-secret header check in front of the existing route handlers). Option B (fully IPC-native, no embedded HTTP server at all) remains the sound **long-term** end state and is scoped as later phases (D-04/D-05) once Option A/C is proven — it is not recommended as the *first* milestone because it requires rewriting all 20 routes' logic at once, which is a larger, riskier single step than this audit's own "minimum-risk ordered plan" goal allows.

---

## D. Native directory picker design

### D.1 Flow

- **Primary sidebar action**: "Open folder…" (replacing `ProjectPicker`'s free-text input as the default/primary affordance).
- **Native result**: Windows folder picker (`dialog.showOpenDialog({ properties: ['openDirectory'] })`, main-process only — not invoked by this audit).
- **User consent**: only ever triggered by a genuine renderer click handler calling the preload-exposed `workspace.pickDirectory()` method — never reachable from a data-driven or IPC-triggered code path.
- **Workspace display**: an open product question (see D.2) — recommend showing the folder's own display name prominently always, and the full canonical path only on a deliberate secondary action (e.g., hover tooltip or an explicit "reveal path"), rather than either always showing it (today's behavior) or never showing it (a literal reading of the "never expose arbitrary paths in renderer" instruction) — flagged as a recommendation, not a decision made by this audit.
- **Path handling**: the absolute canonical path stays main-process-private for any USE beyond identifying the active workspace; every existing route/IPC contract already only ever needs the `project_id` + relative paths — the current architecture already mostly satisfies this (only the picker-display question in D.2 is genuinely open).
- **Read-only grant**: only the selected directory (and its resolved-canonical descendants) is accessible — identical to today's `canonical_root` model, unchanged.
- **Child paths**: allowed only after `resolveCanonicalPath`'s existing containment re-check — unchanged, reused verbatim.
- **Parent/sibling traversal**: denied — unchanged (`checkRootPolicy` + the containment check together already enforce this).
- **Symlink/reparse-point escape**: denied — unchanged, already proven via a real NTFS junction test in `tests/canonicalPath.test.ts`, which is plain Node and runs identically under Electron's main process.
- **Persistence**: recommend reusing the existing `projects` SQLite table (relocated per B.5) as the workspace-grant store; "permission revalidation" is already effectively implemented today via `guardProjectPath`'s fresh `resolveCanonicalRoot` re-check on every operation (returns a stale-root error if the folder was moved/deleted) — this exact mechanism carries over unchanged.
- **Manual path**: retained only as a clearly-secondary "advanced" disclosure, never the primary control — and it is **already** validated through the exact same `resolveCanonicalRoot`/`checkRootPolicy` path a picker selection would use (today's `ProjectPicker` → `addProject` → `resolveCanonicalRoot` is that same function) — this requirement is structurally already satisfied and just needs to stay true as the picker becomes primary.

### D.2 Open product question (not decided by this audit)

Whether the active workspace's **full canonical path** should ever be visible in the renderer at all (today's web app shows it throughout: Explorer header, `ContextInspector`, `ProjectPicker`'s list) conflicts with the authorization's literal "never show or expose arbitrary paths in renderer" instruction. Since the user themselves just picked that exact folder via a native dialog, hiding it entirely has limited security value and a real usability cost (no way to confirm "which folder am I in" at a glance). This needs an explicit product decision in **D-01**, not an assumption made here.

### D.3 Candidate IPC methods

| Method | Renderer input | Main-process validation | Path/root policy | Result limits | Error shape | Sensitive-data rules | Write/terminal/Git mutation possible |
|---|---|---|---|---|---|---|---|
| `workspace.pickDirectory()` | none (optional `{title?}`) | `dialog.showOpenDialog` → `resolveCanonicalRoot` → `checkRootPolicy` (reused unchanged) | rejects drive root/home/common-broad-folders, exactly as today | one directory per call | `{ok:false, reason: "root_not_resolvable"\|"drive_root"\|"home_root"\|"common_user_folder"\|"cancelled"}` | never persists/returns dialog-cancel details beyond a boolean | **no** |
| `workspace.getCurrent()` | none | reads the active grant record only | n/a | one record | `{ok:true, workspace:{id,displayName,...}} \| {ok:false, reason:"no_active_workspace"}` | full path withheld per D.2's pending decision | **no** |
| `workspace.list({relativePath})` | relative path only | `resolveCanonicalPath` + deny-list (reused unchanged) | must resolve under the active grant's canonical root | recommend a NEW explicit max-entries cap (e.g. 2000) — not present in today's web route, a desktop-motivated hardening addition | `{ok:false, reason:"path_outside_project_root"\|"path_denied"\|"not_found"\|...}` (reuses today's exact reason-code vocabulary) | deny-list unchanged | **no** |
| `workspace.readText({relativePath})` | relative path only | canonical-path + deny-list + binary-extension check (reused unchanged) | same | existing `MAX_READ_BYTES` (5MB) retained | same reason-code family as `/api/fs/read` | deny-list unchanged | **no** |
| `workspace.search({query})` | literal query string | canonical-path + deny-list per matched path (reused unchanged) | same | existing 200-match cap retained; literal-only, no regex/semantic (unchanged v0.1 scope) | `{ok:false, reason:"..."}` | deny-list unchanged | **no** |
| `workspace.gitSummary({...})` | none / optional path for diff | `execFileSync("git", [...])` only, never a shell (reused unchanged from `lib/git.ts`) | scoped to the active workspace root | same truncation behavior as today's `git/status\|log\|diff` | `{ok:false, reason:"not_a_repo"\|"git_error"}` | no `.git` internals exposed beyond today's already-safe status/log/diff output | **no** — covers the read-only subset only; no stage/commit/push method exists or is proposed |
| `workspace.clearRecent()` | none | pure local SQLite delete, no filesystem access | n/a | n/a | `{ok:true}` | never force-closes an active grant, only clears the quick-reopen list | **no** |

---

## E. Security threat-model delta

| # | Risk | Current web-app status | Desktop migration impact | Required mitigation | Verification method | Release-blocking |
|---|---|---|---|---|---|---|
| 1 | Renderer compromise | Browser tab already untrusted; no Node/filesystem access exists today | Enabling `nodeIntegration`/disabling `contextIsolation` would upgrade a renderer compromise to full Node/filesystem access | `contextIsolation:true`, `nodeIntegration:false`, `sandbox:true`, minimal typed preload | D-09: assert `window.require`/`window.process`/generic `invoke` are all `undefined` | **Blocking** |
| 2 | Arbitrary IPC exposure | N/A (no IPC in a web app) | A generic `invoke(channel, ...)` bridge would let a compromised renderer call any main-process handler | Only named, typed methods via `contextBridge.exposeInMainWorld`, no free-string channel | D-09: enumerate the exposed bridge, assert it matches the allowlist exactly | **Blocking** |
| 3 | Path traversal | Fully mitigated (`lib/canonicalPath.ts`), proven via tests | None, if reused unchanged; risk only if a handler bypasses the shared guard | Every IPC handler must call `resolveCanonicalPath`/`guardProjectPath`, never touch `fs.*` directly | `tests/canonicalPath.test.ts` (unchanged, runs in Node) + a grep/lint rule confirming every handler imports the guard | **Blocking** |
| 4 | Symlink/reparse-point escape | Mitigated, proven via a real NTFS junction test | None, if reused unchanged | Same as #3 — reuse, never reimplement | Same existing test, re-run in the desktop build's test step | **Blocking** (already met by design) |
| 5 | Recent workspace persistence | `projects` table persists indefinitely; **no revocation UI exists in v0.1 today** | A desktop "recent workspaces" list is more visible/expected than a web picker, raising the stakes of correctly clearing a grant | Implement `workspace.clearRecent`; never auto-reopen the last workspace without an explicit user action | Manual UX test (D-11) + a unit test on the clear operation | Non-blocking for D-03/D-04, **blocking for D-07** |
| 6 | Native dialog consent | N/A | `dialog.showOpenDialog` is OS-native, cannot be scripted by renderer JS — a genuine security **improvement** over today's free-text input | Keep the native dialog as the only primary path-acquisition method | Code review: dialog only reachable from a real click handler | **Blocking** (for picker-as-primary-UX) |
| 7 | Secret file exposure | Deny-list blocks `.env*`/keys/`.git`, proven via tests | Desktop users may pick much broader folders than typical test projects — same deny-list, larger exercised surface | Keep the deny-list and `checkRootPolicy`'s broad-folder rejection unrelaxed | Existing tests unchanged + a manual desktop test picking a deliberately broad folder (D-11) | **Blocking** |
| 8 | Read-size/context-budget exhaustion | `MAX_READ_BYTES` (5MB), 200-match search cap, context budget constants all enforced server-side | Larger real-world folder trees raise the likelihood of hitting these more often | Reuse existing caps; add the new listing max-entries cap (D.3) | New unit test for the listing cap | Non-blocking (defense-in-depth) |
| 9 | Git command injection | `execFileSync` with an argument array only, no shell string ever built — no injection surface today | None, if reused unchanged | Never introduce a shell-invoking (`exec`/`shell:true`) variant | Code review + grep for `shell:\s*true\|exec\(` on new git-adjacent code | **Blocking** |
| 10 | Shell execution | No terminal capability exists anywhere in v0.1 | Electron makes ad hoc `child_process.exec` trivially easy to add in the main process — a real temptation risk even though excluded by product decision | No `workspace.exec`/terminal IPC method exists or is proposed; any future one needs its own separate authorization | D-09's IPC-allowlist test doubles as enforcement | **Blocking** (must not exist) |
| 11 | Environment-variable exposure | `HERMES_HOST`/`HERMES_PORT` server-side only; `HERMES_SESSION_TOKEN` process-env only, never in a file, never sent to the browser | **Open, unresolved design gap**: a packaged desktop app has no "terminal the user launches it from" to set `HERMES_SESSION_TOKEN` in — today's whole token-provisioning model assumes one | Requires its own separate, explicit product decision before D-08 (options include OS credential-store integration, a first-run setup dialog, or continuing to require an externally-set env var for a power-user-only release — none chosen here) | N/A until decided | **Blocking for D-08 only**, not for D-01–D-07 |
| 12 | Local service binding | `next start -H 127.0.0.1` loopback-only, unauthenticated — accepted today for a single-operator dev tool | If Option A's embedded server is shipped to end users unauthenticated, any local process could reach it | Per-launch random port + per-launch shared secret (the "Option C hardening") | New test: a request lacking the shared-secret header is rejected | Non-blocking for an internal/dev-only D-02/D-03 milestone, **blocking before any real end-user distribution** |
| 13 | Hermes token boundary | Server-side-only, verified via grep; error messages proven not to leak it | Unchanged if the main process (or embedded server) remains the sole holder, mirroring today's API-route boundary | No `workspace.*` IPC method ever touches Hermes or a token — structurally impossible by the method list in D.3 | Same grep-based check extended to new main-process code (D-08) | **Blocking** |
| 14 | Update/distribution boundary | N/A — no distribution mechanism exists | An auto-updater would be a high-value new attack surface (compromised update channel = arbitrary code with full Node access) | **Not proposed here** — explicitly deferred; this phased plan stops at D-12's packaging *decision*, not at shipping an updater | N/A | Not applicable to this plan's scope; **must not be silently added later without its own dedicated authorization** |

### Required desktop security constraints (restated, all apply from D-02 onward)

`contextIsolation` enabled · `nodeIntegration` disabled · no generic IPC bridge · no shell-execution API · no terminal API · no file write/delete/rename API · no Git mutation API · no arbitrary absolute-path read API · no raw secret/environment display · explicit selected-root capability boundary only · bounded listing/read/search behavior · no remote/push capability.

---

## F. Phased implementation plan

| Phase | Goal | Expected file areas | New dependency | Source/config/doc impact | Security review | Runtime/process impact | Test strategy | Separate authorization | Separate Git commit |
|---|---|---|---|---|---|---|---|---|---|
| **D-01** | Desktop architecture decision record — formalize Option A(+C-hardening)-first, and resolve the D.2/Item-11 open product questions | New decision-record doc (or a Product Blueprint amendment) | none | Documentation-only | Light (review of the written decision) | None | None | Yes (low risk) | Yes, standalone |
| **D-02** | Electron scaffold + hardened process model (`contextIsolation`/`nodeIntegration`/`sandbox`) | New `electron/` dir (`main.ts`, `preload.ts`), `package.json`/lockfile | `electron` (devDependency) | package.json/lockfile change | **Required, blocking** | New second process model (Electron main+renderer) alongside the Next server | Smoke test: window loads, no `require`/`process` in `window` | Yes, mandatory | Yes |
| **D-03** | Native directory picker + workspace-grant service | `electron/ipc/workspace.ts` (new), `electron/preload.ts`; reuses `lib/canonicalPath.ts`/`lib/projects.ts`/`lib/db.ts` unchanged | none beyond D-02 | New main-process files only; no `lib/`/`app/api/` change | **Required, blocking** | None beyond D-02 | Reuse `tests/canonicalPath.test.ts` unchanged + new thin IPC-wiring tests | Yes | Yes |
| **D-04** | Read-only IPC bridge: `list`/`readText`/`search`, plus the new listing cap | `electron/ipc/workspace.ts` extended; possibly a small additive change to `lib/fsGuard.ts` for the shared cap | none | Small, additive, shared-layer change (benefits web app too) | Required | None new | New listing-cap unit test; opportunity to also add the still-missing `search.test.ts`/`fsGuard.test.ts` (a pre-existing gap, non-blocking bonus) | Yes | Yes |
| **D-05** | Migrate Explorer/File Viewer/Search to the desktop workspace adapter | `lib/apiClient.ts` (adapter) or new `lib/desktopAdapter.ts`; `FileTree.tsx`/`FileViewer.tsx`/`SearchPanel.tsx` call-site changes only | none | Moderate — shared UI components, must not regress the web-app path if kept in parallel (a D-01 decision) | Required (confirm no validation bypass) | None new | Manual verification, consistent with this repo's existing no-component-test convention | Yes | Yes |
| **D-06** | Git summary read-only desktop adapter | `electron/ipc/workspace.ts`, `components/GitPanel.tsx` | none | Minor | Required (confirm no shell/exec path introduced) | None new | Recommend finally adding a `git.test.ts` (pre-existing gap) | Yes | Yes |
| **D-07** | Local persistence/recent-workspace policy: relocate `data/` to `app.getPath('userData')`, implement `clearRecent`, document grant revocation | `lib/db.ts` (environment-aware path resolution), `electron/ipc/workspace.ts` | none (Electron's `app.getPath` is built-in) | Real, additive change to `lib/db.ts`; must stay backward-compatible with the web-app path | Required (data-location change) | First Electron run creates a **new, separate** database — no auto-migration from the web app's `data/vyroncode.sqlite`, must be documented not silently handled | Extend `tests/backupDb.test.ts`-style coverage to the new path logic | Yes | Yes |
| **D-08** | Hermes integration compatibility — resolve token-provisioning (Item 11) and wire `hermes/*` consistently with the chosen A/B/C shape | Depends entirely on the token decision — not precisely scopable yet | Possibly a Windows credential-store library (not decided) | Significant — `lib/hermesClient.ts`'s env-reading logic, possibly a first-run setup UI | **Required, blocking** — highest-sensitivity item in the whole plan | Possibly a new first-run flow | Cannot be defined until the design is chosen | Yes, likely preceded by its own decision-record task | Yes |
| **D-09** | Desktop security test suite — codify every Section E "Verification method" as an automated test | New `tests/desktop/*` | Likely yes — a headless-Electron test runner | Test-only | This phase **is** the formal security review | First real process-launching test execution in this repo (today's suite starts no process) | Itself the deliverable | Yes | Yes |
| **D-10** | Windows packaged-app smoke test | Packaging config (`electron-builder`/equivalent), build scripts | `electron-builder` or equivalent | New build tooling, no app-logic change | Confirm code-signing/entitlements posture (user-facing, not security-critical) | A real packaged `.exe` built and run once | Manual, mirroring the two prior runtime-smoke-test authorizations this engagement already used | Yes | Yes |
| **D-11** | User acceptance test with the real folder picker | None (no code change) | none | None directly (findings may spawn follow-ups) | Consumes D-09's suite | Packaged app running on the user's own machine | Manual, user-executed, `UX-01`..`UX-N` format (mirrors the web redesign's own handoff) | Yes | No (unless follow-up fixes are needed) |
| **D-12** | Packaging/release decision (distribution, signing, update policy) — explicitly **not** authorizing any follow-on capability itself | None (decision record) | none directly | Documentation | Final holistic review before any real-world distribution | None | None | Yes | Yes (decision record) |

---

**VYRON_CODE_V02_DESKTOP_MIGRATION_ARCHITECTURE_AUDIT**
- Authorization scope: read-only architecture audit of the current Next.js/local-web implementation and a phased Electron-first desktop-migration plan — no source/config/test/doc change, no package install, no scaffold, no app restart, no browser test, no native dialog, no Git mutation, no Hermes/provider/deliberation call
- Repository root: `D:/Vyron Code`
- Branch: `master`
- Latest commits: `6fd1d18 feat: add approval and clarification response UI`, `8baaa5a chore: initialize Vyron Code v0.1 read-only workspace baseline`
- Remotes: 0
- Existing staged files: 0
- Dev server running: yes — confirmed via a read-only `netstat` check, left untouched (not stopped, not restarted, no request sent to it)
- Source/config/test/docs changed: 0
- Package/dependency changes: 0
- Current frontend architecture: Next.js App Router, single client page (`app/page.tsx`) orchestrating a persistent sidebar + single-`mainView` main surface; thin `fetch`-based API client (`lib/apiClient.ts`); no browser storage, no client-side routing
- Current API-route architecture: 20 server-side routes, no auth beyond loopback trust, canonical-path-validated filesystem access, `execFileSync`-only read-only Git, server-only Hermes WS client
- Current filesystem/workspace boundary: `lib/canonicalPath.ts` + `lib/fsGuard.ts` — pure Node, proven via a real NTFS-junction test, directly reusable unchanged in an Electron main process
- Current project persistence model: `node:sqlite` `projects` table, `canonical_root` + `display_name`, no expiry/revocation UI today
- Current local data model: `data/vyroncode.sqlite` at `process.cwd()`-relative path — a real migration item for packaging (needs `app.getPath('userData')`)
- Current Hermes integration boundary: `lib/hermesClient.ts`, server-side-only token/WS client, loopback-only protocol assumptions on Hermes's own side
- Current Next runtime/static-export assessment: static export is **not viable** — heavy server-side dependency on `node:sqlite`, `child_process`, `ws`, and `fs`
- Electron-first feasibility: **high** — Option A (embed the existing Next server, loopback-only) reuses essentially the entire current architecture unchanged; recommended as the first milestone, hardened per Option C from day one (per-launch port + shared secret)
- Tauri feasibility: not evaluated — this audit was scoped to Electron-first per the authorization; a Tauri path would require re-doing the equivalent of Section C/D/E for Rust-side IPC and was out of scope
- Recommended desktop architecture: Option A, hardened per Option C (embedded loopback server, per-launch random port + shared secret), with a later, non-first-milestone migration toward Option B's fully IPC-native model (phases D-04/D-05 begin that shift without requiring it to happen all at once)
- Recommended renderer security model: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, no Node/filesystem/process access of any kind in the renderer
- Recommended main-process responsibility: owns the native directory picker, the workspace grant/persistence store, all privileged filesystem/Git reads (via the existing `lib/canonicalPath.ts`/`lib/fsGuard.ts`/`lib/git.ts`, reused unchanged), and app lifecycle; optionally hosts the embedded Next server
- Recommended preload/IPC bridge: a minimal, typed, allowlisted `contextBridge.exposeInMainWorld` surface exposing only the seven named `workspace.*` methods in Section D.3 — no generic `invoke`/`send` passthrough
- Native folder picker design: `dialog.showOpenDialog({properties:['openDirectory']})`, main-process-only, validated through the existing `resolveCanonicalRoot`/`checkRootPolicy` before any grant is accepted — detailed in Section D.1
- Manual-path fallback decision: retained only as a secondary "advanced" disclosure, never primary; already structurally validated through the same canonical-root/policy function a picker selection uses — no new, weaker code path
- Workspace grant/persistence design: reuse the existing `projects` SQLite table (relocated to Electron's per-user app-data directory), with the existing per-request fresh-root-resolution already serving as permission revalidation; a new `workspace.clearRecent` method addresses the currently-missing revocation UX
- Proposed read-only IPC methods: `workspace.pickDirectory`, `getCurrent`, `list`, `readText`, `search`, `gitSummary`, `clearRecent` — full input/validation/limits/error/sensitivity/mutation-possibility table in Section D.3 (mutation possibility: **no**, for every method)
- Absolute-path exposure policy: an open product question (Section D.2) — recommend showing only the folder's display name by default, full path on deliberate secondary action; not decided by this audit
- Symlink/reparse-point policy: denied, via unchanged reuse of the already-tested `lib/canonicalPath.ts` logic — no new code needed
- Secret-file exposure policy: unchanged deny-list reuse (`.env*`, keys, `.git`); recommend keeping `checkRootPolicy`'s broad-folder rejection unrelaxed given how easy a native picker makes selecting an overly broad folder
- Read/list/search budget policy: reuse existing caps (5MB read, 200-match search); recommend adding a new explicit max-entries-per-listing cap not present in today's web route
- Git summary policy: read-only status/log/diff only, `execFileSync` with an argument array (never a shell); no stage/commit/push method exists or is proposed anywhere in this plan
- Desktop threat-model delta: 14 risks assessed in Section E — 10 blocking, 2 non-blocking (defense-in-depth), 1 blocking-only-for-its-own-later-phase (Hermes token provisioning, D-08), 1 explicitly out of this plan's scope (auto-update/distribution, deferred to its own future authorization)
- Required desktop security constraints: contextIsolation enabled, nodeIntegration disabled, no generic IPC bridge, no shell-execution/terminal API, no file-write/delete/rename API, no Git-mutation API, no arbitrary absolute-path read API, no raw secret/environment display, explicit selected-root capability boundary only, bounded listing/read/search behavior, no remote/push capability
- Required package/dependency changes: none in this audit itself; `electron` (D-02), likely an Electron test runner (D-09), and a packaging tool such as `electron-builder` (D-10) are anticipated in later, separately-authorized phases
- Desktop migration blockers: none structural — the one **open, unresolved design gap** is Hermes token provisioning for a packaged app with no user-launched terminal (Section E, item 11), which blocks only D-08, not D-01–D-07
- Desktop migration risks: summarized across Section E's 14-item table; the two categorically new risks this migration introduces beyond today's web-app posture are (a) a renderer with a potential path to Node/filesystem access if Electron's security baseline is ever weakened, and (b) a more consequential "recent workspaces" persistence surface than today's ephemeral web picker
- Phased implementation plan: 12 ordered phases (D-01 through D-12), full detail in Section F — each requires its own separate authorization and its own separate Git commit (except D-11, which is a no-code user-test phase)
- First minimal implementation task: **D-01 — a documentation-only desktop architecture decision record**, resolving the two open product questions (path-visibility in D.2, and flagging item 11's token-provisioning question for later, dedicated resolution before D-08) before any code or dependency is touched
- App/services started/stopped: none — the existing dev server was left running exactly as found
- Browser/network/native-dialog calls: 0
- Hermes/provider/deliberation calls: 0
- Git staging/commit/remote changes: none
- Tokens/secrets exposed: none
- File writes: 1 — this report only (`VYRON_CODE_V02_DESKTOP_MIGRATION_ARCHITECTURE_AUDIT.md`), untracked, not staged, not committed
- Exact next action requiring explicit approval: a separate, explicit authorization for **D-01** (the documentation-only decision record) — no code, dependency, or scaffold change should follow from this audit alone
