# Vyron Code v0.1 — Localhost & Project-Root Hardening Report

Task: VYRON_CODE_V01_LOCALHOST_AND_PROJECT_ROOT_HARDENING_AUTHORIZATION. Fixes the two blockers ([HIGH] wildcard bind, [MEDIUM] no project-root policy) found by `VYRON_CODE_V01_FOUNDATION_AUDIT.md`, plus the listed quality fixes. All changes are confined to `D:\Vyron Code\`.

## Bind hardening

- **Previous dev-server PID/bind**: PID 5428, `LocalAddress ::` (wildcard, all interfaces), port 3055 — process stopped (our own process only) before this work began.
- **New dev-server PID/bind**: PID 3668, `LocalAddress 127.0.0.1`, port 3055.
- **Bound only to localhost**: Yes — `next dev`/`next start` now pass `-H 127.0.0.1` ([package.json](package.json)).
- **LAN/wildcard bind observed**: No. `Get-NetTCPConnection -LocalPort 3055` shows a single `127.0.0.1` listen entry, no `::`/`0.0.0.0`. Directly attempted `curl` against all 4 of the machine's real LAN IPv4 addresses (`172.27.32.1`, `172.25.224.1`, `192.168.56.1`, `192.168.1.4`) on port 3055 — **all four refused/timed out** (`000`), confirming the service is not reachable from the network, not merely "probably."
- **Localhost HTTP health**: `http://localhost:3055/` → `200`.
- **127.0.0.1 HTTP health**: `http://127.0.0.1:3055/` → `200`.

## Project-root policy

Documented in [lib/canonicalPath.ts](lib/canonicalPath.ts)'s `checkRootPolicy()` (full policy rationale in its doc comment) and enforced in [lib/projects.ts](lib/projects.ts)'s `addProject()`, which is the single entry point `POST /api/projects` uses — so the API is authoritative by construction; there is no separate client-side copy of this logic to drift out of sync (the UI only ever displays whatever the API returns).

Rule set:
1. Any filesystem root (a drive root on Windows, `/` on POSIX) — generic check via `path.parse(root).root === root`.
2. The user's home/profile directory (`os.homedir()`), exact match.
3. A fixed list of common broad folders directly under home — Desktop, Documents, Downloads, Pictures, Music, Videos, OneDrive — exact match only (a narrow project folder *nested inside* one of these, e.g. `Documents\my-project`, is NOT rejected).

Rejection responses return only a category code (`drive_root` | `home_root` | `common_user_folder` | `root_not_resolvable`) — never the resolved canonical path or any other path content — so no secret/path information is disclosed beyond what the caller already supplied.

**Live verification (against the running hardened server, not just unit tests):**
- **Drive root rejection**: `POST /api/projects {"path":"D:\\"}` → `{"error":"drive_root"}`
- **User profile root rejection**: `POST /api/projects {"path":"C:\\Users\\onurk"}` → `{"error":"home_root"}`
- **Common user-folder rejection**: tested Documents, Desktop, Downloads, Pictures, OneDrive (all exist on this machine) → all five returned `{"error":"common_user_folder"}`
- **Valid narrow project-root acceptance**: `POST /api/projects {"path":"D:\\Vyron Code"}` → returns the real, already-registered project record

## Test suite additions

[tests/canonicalPath.test.ts](tests/canonicalPath.test.ts) gained a new `describe("checkRootPolicy", ...)` block (6 new tests): valid narrow root, drive root (Windows-concrete + platform-generic), home root, common broad user folder (skips gracefully if a candidate folder doesn't exist on the test machine), and an explicit negative test proving a project nested *inside* a broad folder is still accepted (the rule is exact-match, not prefix-based). Combined with the pre-existing canonical-path-containment and junction-escape tests: **16/16 passing**.

## Read-only guarantee — unchanged

No file-write, terminal/shell, Git-mutating, or multimodel-start route was added. No Hermes config/token wiring was touched. The existing deny-list (`.env*`, `.git`, `*.pem`/`*.key`/`*.pfx`, `id_rsa*`/`id_ed25519*`, `node_modules`) is untouched and re-verified live (see below) — the new root-policy check is additive (decides whether a root may be *registered*) and does not weaken or replace the per-request canonical-path containment check, which still runs on every `fs`/`search`/`git` request regardless of which root was registered.

## Regression checks (live, against the hardened server)

- **Secret deny-list regression**: `GET /api/fs/read?path=.env.local` → `{"error":"path_denied"}`
- **Path escape regression**: `GET /api/fs/read?path=../Vyron Pro/package.json` (a real file that exists outside the root) → `{"error":"path_outside_project_root"}`; `GET /api/fs/read?path=C:/Windows/win.ini` (absolute) → `{"error":"absolute_path_rejected"}`

## Quality fixes

- **Extension detection** ([app/api/fs/read/route.ts](app/api/fs/read/route.ts)): replaced the manual `absolutePath.slice(lastIndexOf("."))` (misfired on extensionless files and dotted directory names, per the audit) with `path.extname(absolutePath)`.
- **`.gitignore`**: added `*.tsbuildinfo`.
- **Lint**: added [eslint.config.js](eslint.config.js) — a minimal flat config re-exporting the already-declared `eslint-config-next`'s own flat-config array (no new dependency). Running it surfaced two real, pre-existing issues, both fixed: an unescaped apostrophe in `DisabledCapabilities.tsx`, and a `react-hooks/set-state-in-effect` violation in `FileViewer.tsx` (refactored to a `key={path}`-remounted child component instead of manually resetting state inside the effect — also closes a latent stale-response race by adding a `cancelled` guard).
- **Build**: the new `checkRootPolicy()` code triggered a Turbopack "dynamic filesystem access" tracing warning (`path.join(home, name)` with a runtime-resolved `home`) — silenced correctly with a `turbopackIgnore` hint rather than suppressed or ignored.
- No new dependency was added anywhere in this task.

## Verification results

- **TypeScript**: `npx tsc --noEmit` → clean, exit 0.
- **Lint**: `npx eslint .` → clean, exit 0 (0 errors, after fixing the 2 pre-existing issues above).
- **Production build**: `npm run build` → clean, no errors, no warnings.
- **Test suite**: `npx vitest run` → **16/16 passing**.
- **Hermes calls made**: 0 — `sessions` table in `data/vyroncode.sqlite` still has 0 rows (checked before and after this task); no `.call(...)` was invoked anywhere in this session.
- **Provider calls made**: 0.
- **Deliberation calls made**: 0.
- **Services intentionally untouched**: Hermes Agent, Bridge, OmniRoute, deliberation-service, Vyron Pro, Open WebUI — no source/config/process change, no restart. Port 3010's unrelated pre-existing process was re-checked and confirmed unchanged (same owning PID as in the foundation audit).
- **Tokens/secrets exposed**: none — no credential was read, written, displayed, or transmitted; `.env.local`'s `HERMES_HOST`/`HERMES_PORT` remain empty, untouched.

## Files changed (all under `D:\Vyron Code\`)

`package.json`, `lib/canonicalPath.ts`, `lib/projects.ts`, `app/api/fs/read/route.ts`, `.gitignore`, `components/DisabledCapabilities.tsx`, `components/FileViewer.tsx`, `tests/canonicalPath.test.ts` — plus two new files: `eslint.config.js` and this report, `VYRON_CODE_V01_HARDENING_REPORT.md`.

## Git operations

None. No `git init`, `add`, `commit`, or `push` was run.

## Remaining blockers before real Hermes chat wiring

Unchanged from the foundation audit, not in scope for this task:
1. `.env.local`'s `HERMES_HOST`/`HERMES_PORT` are still empty — must be filled from Vyron Pro's own config before any real session can be created.
2. The `vyron_code` Bridge client identity still does not exist (separate authorization required, per the Acceptance Criteria doc) — `PROJECT_STATE`/memory routes remain `501` stubs.
3. UI surfaces for search, context selector, context inspector, PROJECT_STATE/memory views, session list, and Git log/diff are still missing (backend routes exist for all but context-selector persistence) — see the foundation audit's §1 for the full list.
