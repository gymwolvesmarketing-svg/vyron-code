# Vyron Code v0.2 — Desktop Architecture Decision Record

## 1. Status and scope

**Status: DECIDED (documentation-only).** No source, test, configuration, or dependency has been changed to implement any decision recorded here — this document governs the *direction* of a future, separately-authorized implementation (see Section 25, D-02 onward). It supersedes nothing in `VYRON_CODE_V01_PRODUCT_BLUEPRINT.md`, `VYRON_CODE_V01_SECURITY_THREAT_MODEL.md`, or `VYRON_CODE_V01_ACCEPTANCE_CRITERIA.md` — v0.1's read-only web workspace remains exactly as those documents describe it. This record is the single source of truth for Vyron Code's v0.2 Windows desktop direction, produced from the read-only findings in `VYRON_CODE_V02_DESKTOP_MIGRATION_ARCHITECTURE_AUDIT.md`.

## 2. Problem statement

Vyron Code v0.1 is a localhost web application: the user runs `npm run start:local` in a terminal and opens a browser tab, and the one workspace-selection affordance is a free-text absolute-path input (`components/ProjectPicker.tsx`). This does not match the long-term product direction: Vyron Code should become a Windows desktop application with a native project-selection experience, without weakening v0.1's read-only guarantees or introducing any new write/execution capability in the process.

## 3. Product decision summary

1. Vyron Code will progress toward a Windows desktop application.
2. A native folder picker is the primary project-selection UX.
3. Manual absolute Windows-path typing is not the primary desktop UX.
4. The desktop renderer must never receive arbitrary native filesystem access.
5. Selected workspace absolute paths are main-process-private by default.
6. The renderer receives only: a safe workspace display name, an opaque workspace ID, allowed relative paths, and bounded read-only workspace results.
7. Desktop v0.2 remains read-only: no terminal, no file-write, no Git-write, no multimodel-start, no remote/push capability.
8. Electron-first is the chosen initial desktop shell strategy.
9. Tauri is not permanently rejected, but is not the first migration target (Section 6).
10. Hermes token handling is explicitly deferred to D-08 (Section 20).

## 4. Why browser-only path typing is insufficient

`components/ProjectPicker.tsx`'s free-text input is the one raw-absolute-path-typing surface in the entire application (confirmed in the desktop migration architecture audit). It has three problems a desktop product should not carry forward: (a) it requires the user to already know and correctly type a full Windows path, which is not how a native OS application typically works; (b) as a plain `<input>` + `fetch`, it is — in principle — a surface a compromised or malicious script running in the page could programmatically fill and submit, whereas an OS-native folder dialog cannot be scripted from page JavaScript; (c) it does not match user expectation for a "real" desktop app. A native folder picker resolves all three: it is the standard OS-native interaction, it cannot be triggered without a genuine user click reaching the main process, and it removes the need for the user to ever type a path for the common case.

## 5. Electron-first decision

**Decided: Electron is the first desktop shell target.** Rationale, from the architecture audit's Option A/B/C/D comparison: the current architecture's server-side logic (`lib/canonicalPath.ts`, `lib/fsGuard.ts`, `lib/git.ts`, `lib/db.ts`, `lib/hermesClient.ts`) is pure Node.js with zero browser dependency, and is therefore reusable **unchanged** inside an Electron main process. This makes "Electron hosts the existing Next runtime over loopback only" (Option A, hardened per Option C's per-launch port + shared secret) the lowest-risk, lowest-migration-cost path to a working desktop milestone — it reuses essentially the entire current codebase and adds only a native folder picker and its IPC wiring as genuinely new surface.

## 6. Explicit non-decision: Tauri future reassessment

**Tauri is not rejected permanently.** It is not selected as the first migration target because the current application has substantial server-side Next.js API-route logic (`node:sqlite`, `child_process` Git reads, a `ws`-based Hermes client, `fs`-based canonical-path enforcement) and static export is not viable as-is (confirmed in the migration audit, Section B.5). Tauri's own architecture favors a thin, mostly-static frontend with Rust-side backend logic — adopting it today would require first porting all of the above server-side logic to Rust (or keeping a sidecar Node process, which erodes much of Tauri's own value proposition). This is a **larger, riskier first step** than Electron's "reuse everything unchanged" path. Tauri may be reassessed after the Electron-first milestone (D-10/D-12) if its smaller binary size/resource footprint becomes a stated product priority — that reassessment would be its own separate, explicit decision record, not implied by anything in this document.

## 7. Current Next.js/server architecture compatibility

Confirmed compatible, reused unchanged under Electron: `lib/canonicalPath.ts`, `lib/fsGuard.ts`, `lib/git.ts`, `lib/db.ts` (`node:sqlite`), `lib/projects.ts`, `lib/search.ts`. Confirmed **not** compatible with a static-export-only migration: every one of the above depends on a real Node process (server or main-process) — `next export`/`output:"export"` cannot host any of them. `node:sqlite`'s experimental status (confirmed via the project's own build output warnings) requires empirical Electron-Node-ABI verification in a real implementation task (D-02/D-03), not assumed here.

## 8. Desktop process model

**Main process:**
- Owns native dialog access.
- Owns selected workspace grant state.
- Owns canonical-root enforcement.
- Owns read-only filesystem access.
- Owns bounded Git summary execution.
- Owns local app lifecycle.
- Owns future safe secret persistence, if separately authorized (Section 20).

**Renderer:**
- Displays the Vyron Code UI (the existing, redesigned workspace shell).
- Has no Node.js integration.
- Has no direct `fs`, `child_process`, shell, Git, or environment access.
- Has no generic IPC access.
- Treats all workspace results as untrusted display data.

**Preload:**
- Exposes only typed, allowlisted, task-specific methods.
- Never exposes raw `ipcRenderer`, Node modules, shell, `process`, `fs`, or a generic `invoke`/`send` interface.

## 9. Renderer security model

`contextIsolation: true` · `nodeIntegration: false` · `sandbox: true` unless a specific, documented Electron constraint requires review and an explicit exception · `webSecurity: true` · no remote content loaded in the privileged Vyron Code renderer · navigation/new-window creation denied by default unless separately authorized · every privileged IPC request requires sender validation · a restrictive local-content Content-Security-Policy is required · arbitrary shell execution is forbidden · a generic IPC bridge is forbidden.

## 10. Main-process responsibility

As listed in Section 8. In addition: the main process is the sole holder of any future Hermes credential (Section 20) and the sole executor of `git` subprocess calls (via `execFileSync` with an argument array, never a shell string — reusing `lib/git.ts` unchanged).

## 11. Preload/IPC bridge policy

The preload script exposes exactly the seven methods listed in Section 12/13's future interface (`workspace.pickDirectory`, `getCurrent`, `list`, `readText`, `search`, `gitSummary`, `clearRecent`) via `contextBridge.exposeInMainWorld`, each with a fixed, typed argument and return shape. No method accepts a free-form channel name, a raw IPC message, or a callback that would let the renderer register for arbitrary main-process events. No `require`, `process`, `ipcRenderer`, `fs`, or `child_process` reference of any kind reaches the renderer's global scope.

## 12. Native Windows folder-picker flow

- **Primary action**: "Open folder…"
- **Implementation owner**: Electron main process only.
- **Native API**: `dialog.showOpenDialog({ properties: ['openDirectory'] })`.
- **User consent**: a fresh, explicit user click is required for every invocation — never triggered by a data-driven or IPC-initiated code path.
- **Result**: the selected native directory path is received only by the main process.
- **Validation**: the selected root must pass the existing `resolveCanonicalRoot`/`checkRootPolicy` (or an explicitly reviewed desktop-specific equivalent that preserves the same guarantees) before any grant is accepted.
- **Renderer receives**: an opaque workspace ID, a display name, safe state metadata, and read-only relative tree entries.
- **Renderer does not receive**: arbitrary absolute paths, parent paths, sibling paths, arbitrary filesystem handles, or an unrestricted disk-enumeration capability.
- **Manual path**: not present in the primary desktop UX.
- **Manual path fallback**: deferred; if implemented later, it must pass exactly the same canonical-root, read-only-grant, and root-policy validation as a native picker selection — never a separate, weaker code path.

## 13. Workspace-grant model

The selected directory (and its canonically-resolved descendants only) is the entire accessible surface for a given workspace grant — identical in spirit to v0.1's existing `canonical_root` model. Reuse the existing `projects` SQLite table (relocated to Electron's per-user application-data directory for a packaged build — a concrete, scoped item for D-07) as the workspace-grant store. Permission revalidation is already effectively implemented today via `guardProjectPath`'s fresh `resolveCanonicalRoot` re-check on every operation (a moved/deleted root fails closed) — this mechanism carries over unchanged. `workspace.clearRecent()` addresses the currently-missing "forget this workspace" affordance (v0.1's web app has no equivalent today); clearing the recent list never force-closes an active grant.

## 14. Absolute-path visibility policy

**Decided: the renderer does not receive the selected workspace's absolute path by default.** The renderer receives only a safe display name (the folder's own base name, or an equivalent short, human-readable label) and an opaque workspace ID. This resolves the open question flagged in the migration audit in favor of the stricter reading of product decision #5/#6 above. Any future UI affordance that would reveal the full path (e.g., an explicit "reveal path" action) is a separate, later UX decision, not approved by this record.

## 15. Relative-path and canonical-root policy

Unchanged from v0.1: every filesystem operation accepts only a relative path, resolved and re-verified against the active grant's canonical root via `resolveCanonicalPath` before any disk access, on every request (not cached from grant time). Absolute-path and `..`-escaping inputs are rejected before resolution, exactly as `lib/canonicalPath.ts` already does today.

## 16. Symlink/reparse-point handling policy

Unchanged from v0.1: `fs.realpathSync.native`-based resolution, proven via a real NTFS junction created and blocked in `tests/canonicalPath.test.ts`. This module is plain Node and requires no rewrite to run inside an Electron main process — no new symlink-handling code is to be written; the existing module is reused as-is.

## 17. Read/list/search size and context budgets

Reuse v0.1's existing, already-enforced limits: `MAX_READ_BYTES` (5MB) per file read, a 200-match cap on literal search results, and the existing context-selection budget constants (`MAX_ITEMS=8`, `MAX_ITEM_CHARS=12000`, `MAX_AGGREGATE_CHARS=48000`, `MAX_AGGREGATE_TOKENS=12000`) where the Context Selector feature is reused. A **new** explicit max-entries-per-directory-listing cap (not present in today's web route) is recommended for the desktop `workspace.list` method, since a native picker makes it easy for a user to select a much larger folder tree than v0.1's typical web-hosted test projects — scoped as an implementation detail of D-04, not decided numerically here.

## 18. Git summary policy

Read-only status/log/diff only, via `execFileSync("git", [...argsArray])` — an argument array, never a shell string, reusing `lib/git.ts` unchanged. No stage, commit, push, checkout, or any other mutating Git subcommand is exposed by any method, IPC or otherwise, anywhere in the desktop v0.2 scope.

## 19. Read-only v0.2 capability boundary

Restated, unconditionally: no terminal capability, no file-write capability, no Git-write capability, no multimodel-start capability, no remote/push capability — in the desktop v0.2 milestone, in any phase D-02 through D-12 of Section 25. Introducing any of these would require its own, separate, explicit future authorization, exactly as every capability addition has required throughout this engagement.

## 20. Hermes integration/token-provisioning decision

Desktop alpha can run as a read-only workspace without Hermes credentials at all — Explorer, Search, Git summary, and the folder picker itself have no dependency on Hermes being configured or reachable.

No Hermes token is, at any point in D-01 through D-07: bundled, hardcoded, committed, printed, logged, sent to the renderer, copied automatically from a browser process, copied automatically from `.env`, or copied automatically from the existing terminal environment.

Future Hermes connection is **D-08 only**, and **D-08 must have its own separate, explicit authorization** before any implementation. D-08 may choose between: session-memory-only token provisioning (the token lives only in the running main process's memory, entered fresh each launch, never written to disk), or main-process-only opt-in encrypted local storage using Electron's `safeStorage` API on Windows (which is backed by Windows DPAPI, tied to the OS user account). **No token persistence implementation of any kind is approved by this document.** The specific choice between these two options, or any other, is D-08's own decision to make under its own authorization.

## 21. Local runtime/loopback server policy

If Option A's embedded-Next-server approach is implemented (Section 5), it binds to `127.0.0.1` only, on a **per-launch random port** (never a fixed, predictable port for a distributed build), and every request from the preload's own fetch calls carries a per-launch shared secret the main process generates and never exposes to the renderer as a readable value beyond "requests are already authenticated for you" — the renderer never sees or handles the secret itself; only the preload's internal fetch wrapper does, which is main-process-adjacent trusted code, not renderer-reachable. This resolves the "any local process could reach an unauthenticated loopback server" gap the migration audit flagged as blocking before any real end-user distribution (non-blocking for an internal/dev-only first milestone).

## 22. Desktop threat-model delta

Carried forward from `VYRON_CODE_V02_DESKTOP_MIGRATION_ARCHITECTURE_AUDIT.md` Section E without change — 14 risks assessed (renderer compromise, arbitrary IPC exposure, path traversal, symlink/reparse-point escape, recent-workspace persistence, native dialog consent, secret file exposure, read-size/context-budget exhaustion, Git command injection, shell execution, environment-variable exposure, local service binding, Hermes token boundary, update/distribution boundary). This record does not repeat that table; it is incorporated by reference and remains the authoritative threat-model delta until superseded by a later, explicit revision.

## 23. Deferred decisions

- **Absolute-path visibility for advanced/debug use** (e.g., a copy-path action) — not approved here (Section 14 is the default-closed policy; any future opt-in surface is a separate decision).
- **Hermes token provisioning mechanism** — deferred to D-08 (Section 20).
- **Manual-path fallback UI** — deferred; not part of the primary desktop UX (Section 12).
- **Whether the web-app (browser/localhost) target is kept in parallel with the desktop app, or eventually retired** — not decided here; affects D-05's scope (whether `lib/apiClient.ts` needs a dual web/desktop adapter or a clean replacement) and should be resolved no later than the start of D-05.
- **Tauri reassessment** — deferred per Section 6.
- **Auto-update/distribution mechanism** — deferred past D-12; explicitly requires its own future authorization (Section 24 lists it as currently rejected/unimplemented, not merely unscheduled).

## 24. Explicitly rejected approaches

- Browser renderer direct Node.js filesystem access.
- `nodeIntegration` enabled.
- `contextIsolation` disabled.
- Renderer receiving a generic `ipcRenderer`.
- Renderer receiving arbitrary `fs` or `child_process` access.
- Browser/native picker result exposed to the renderer as an unrestricted absolute path.
- A terminal-execution API.
- A file write/delete/rename API.
- A Git-mutation API.
- A remote/push API.
- A multimodel-start API.
- A static-export-only migration that does not first resolve the current Next server/API dependency (Section 7).
- Packaging a real Hermes token with the application.
- Plaintext token persistence, of any kind, at any phase.

## 25. D-01 through D-12 phased migration plan

Carried forward from `VYRON_CODE_V02_DESKTOP_MIGRATION_ARCHITECTURE_AUDIT.md` Section F without change (full per-phase Goal/file-areas/dependency/security-review/test-strategy/authorization/commit table is incorporated by reference, not repeated here). Summary of the 12 phases: **D-01** this decision record (documentation-only, current task) → **D-02** Electron scaffold + hardened process model → **D-03** native directory picker + workspace-grant service → **D-04** read-only IPC bridge (list/readText/search) → **D-05** migrate Explorer/File Viewer/Search to the desktop adapter → **D-06** Git summary read-only desktop adapter → **D-07** local persistence/recent-workspace relocation and policy → **D-08** Hermes integration/token-provisioning implementation (its own required sub-authorization, per Section 20) → **D-09** desktop security test suite → **D-10** Windows packaged-app smoke test → **D-11** user acceptance test with the real folder picker → **D-12** packaging/release decision. Every phase from D-02 onward requires its own separate, explicit authorization and produces its own separate Git commit (D-11 is a no-code user-test phase and produces no commit of its own unless follow-up fixes are separately authorized).

## 26. Required future verification gates

Before any phase D-02 through D-10 can be considered complete, it must satisfy: (a) the Section 9 renderer-security-model constraints, verified by the D-09 automated test suite once it exists; (b) reuse (not reimplementation) of `lib/canonicalPath.ts`/`lib/fsGuard.ts`/`lib/git.ts` for every filesystem/Git-adjacent IPC handler; (c) the exact IPC-method allowlist in Section 11/12, with no additional method introduced without its own authorization; (d) a clean `npm run lint` / `tsc --noEmit` / `npm run build` / full test-suite pass, exactly as every prior implementation task in this engagement has required; (e) a changed-file secret scan; (f) for D-08 specifically, explicit confirmation that no token value is ever logged, printed, or renderer-visible, using this engagement's established safe-verification techniques (structural/shape checks, never raw display).

## 27. Release criteria for desktop alpha

A desktop alpha (the output of D-10's packaged-app smoke test) is ready for D-11's user acceptance test only when: it opens to the same product shell verified in `VYRON_CODE_V01_P0_WORKSPACE_SHELL_VISUAL_RUNTIME_REPORT.md`; the native folder picker is the primary, working project-selection path; Explorer/Search/File-Viewer/Git-summary all function read-only against a picker-selected workspace; zero terminal, file-write, Git-write, multimodel-start, or remote/push affordance exists anywhere in the packaged app; zero Hermes token is bundled, hardcoded, or persisted (consistent with Section 20, since D-08 is not assumed complete at this stage); and the D-09 desktop security test suite passes in full. A desktop alpha is **not** release-ready for distribution beyond this engagement's own testing until D-12's packaging/release decision is separately made — this record does not itself authorize distribution.
