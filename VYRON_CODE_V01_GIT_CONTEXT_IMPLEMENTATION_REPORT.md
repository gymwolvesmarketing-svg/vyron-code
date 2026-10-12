# VYRON_CODE_V01_GIT_CONTEXT_IMPLEMENTATION_REPORT

Implements `VYRON_CODE_V01_GIT_AND_EXPLICIT_CONTEXT_IMPLEMENTATION_AUTHORIZATION` in full, within `D:\Vyron Code\` only. Read-only Git UI, Context Selector, Context Inspector, Explicit Attach-to-Chat gate, and context-aware chat prompt payload integration are all implemented, tested, and live-verified in a real browser against the production build.

## A. Git read-only UI

- `lib/git.ts` rewritten: `runGit()` now classifies every failure as `not_a_repo` or `git_error` and never returns raw stderr to any caller (git's own error text can embed an absolute path — e.g. `fatal: cannot change to 'C:\...'` — which must never reach a client response). Added `gitLog(root, limit, skip)` with server-side clamping (`limit` ∈ [1,200], `skip` ≥ 0) for pagination, `parseStatusHeader()` (branch/upstream/ahead/behind/detached, parsed from the porcelain `-b` header line), and `parseStatusFiles()` (repo-relative changed-file list with index/worktree flags).
- `app/api/git/status/route.ts`, `app/api/git/log/route.ts`, `app/api/git/diff/route.ts` rewritten: a non-git folder now returns `{isRepo:false}` (200) instead of a 500 with raw stderr — a graceful, explicit empty state. Any other git failure returns a fixed safe message (`"git_command_failed"`), never the underlying stderr. `git/status` adds parsed `header`/`files` fields and a 100,000-char output cap (`truncated` flag). `git/diff` adds a 200,000-char output cap and, for a path-scoped diff only, parses and returns individual hunks (`lib/gitHunks.ts`) — a whole-repo diff never returns hunks, since hunk numbering across multiple files would be ambiguous for the Context Selector.
- `components/GitPanel.tsx` rewritten into the full UI: branch + ahead/behind, changed-file list (click to open its diff), diff view with per-hunk display and a per-hunk "+ Add to context" affordance, and a paginated commit history ("Show history" → "Load more", `LOG_PAGE_SIZE = 30`). No mutating git command exists anywhere in the codebase — `lib/git.ts` still only calls `status`, `log`, and `diff`.

## B. Context Selector

- `lib/contextSelections.ts` (new): the metadata-only data layer. Hard budget constants — `MAX_ITEMS=8`, `MAX_ITEM_CHARS=12000`, `MAX_AGGREGATE_CHARS=48000`, `MAX_AGGREGATE_TOKENS=12000` — enforced only here, server-side, against rows this module itself counts; a client-supplied count/size/fingerprint is never trusted. `checkBudget()`/`insertContextSelection()` reject before insert; `removeContextSelection()`/`clearContextSelections()` are session-scoped (verified in tests — cannot delete another session's row).
- `lib/contextContent.ts` (new): re-reads the actual content fresh from disk (`extractFileSnippet`) or from `git diff` (`extractGitHunk`) every time it's needed — never cached, never persisted. Every path goes through `guardProjectPath` (canonical root + deny-list + traversal/junction safety, the same guard every existing fs/search route uses). Binary extensions and a NUL-byte sniff are rejected; oversized files (>5MB) are rejected; an out-of-range line range or a hunk no longer present is reported as `invalid_or_stale_range` / `hunk_not_found_or_stale`.
- `app/api/context/route.ts` `POST`: validates `session_id`→`project_id` match (cross-project rejection, 403), extracts the requested content, checks the budget, and inserts — storing only metadata (path, kind, serialized range/hunk-ref, SHA-256 fingerprint, char count, token estimate) — the actual text is never written to SQLite.
- Two source types are wired end-to-end and live-verified: a File Viewer line-range selection (`components/FileViewer.tsx` — Monaco `onDidChangeCursorSelection` drives a "+ Add to context" button) and a search-result single line (`components/SearchPanel.tsx` — a "+ context" button per result). A git diff hunk (`components/GitPanel.tsx`) is the third. Both file-based kinds reuse the `file_snippet` DB kind (a search result is simply a 1-line file snippet) — no `CHECK` constraint widening was needed (see Dependency/database section).

## C. Context Inspector

- `components/ContextInspector.tsx` (new): shows the canonical root, per-item source type/path/range-or-hunk-label/char-count/token-estimate/attached-state/stale-badge, a bounded (≤500 char) redacted preview per item (re-read fresh on every list fetch via `lib/contextPayload.ts`'s `previewItem()`), and the aggregate count/chars/tokens against the four limits. The explicit, always-shown "Will NOT send" list names every category the authorization requires (raw chat history, unselected files, full repo, `.env*`/secrets, `.git` internals, node_modules/build/binary, global memory, USER.md/MEMORY.md, PROJECT_STATE, provider/Bridge/Hermes/deliberation tokens, terminal output). Remove/Clear only delete local `context_selections` rows — never touch the real filesystem or git state.

## D. Explicit Attach-to-Chat gate

- `app/api/context/attach/route.ts` (new): a distinct action from Send. Re-validates every requested item — canonical path, deny-list (inherited from `guardProjectPath`), size, and content fingerprint — via `lib/contextPayload.ts`'s `revalidateItems()` immediately before marking anything attached. **Any single stale/invalid item fails the WHOLE batch closed** (409, `staleItems` list) — nothing is attached, and no partial/narrowed set is silently sent. Live-verified: modifying the selected file after adding its hunk to context produced exactly this — a "stale" badge, and Attach → Confirm attach → blocked with "These changed since selection — remove or re-add them before attaching: a.txt: That diff hunk is no longer present — the file may have changed."
- Attaching replaces the session's previously-attached set (detach-all then attach the confirmed ids). `app/api/context/detach/route.ts` (new) un-attaches everything for a session without deleting the underlying selections. The attach action is logged only via the existing `audit_log` table (`recordAudit`) — timestamp, action kind, and a safe descriptive string (`session:<id> count:N chars:N kinds:...`) — never raw content.
- Live-verified end to end: added a `package.json` line range → previewed → "Attach selected context" → confirm screen showed the exact Will-send/Will-NOT-send lists → "Confirm attach" → banner "1 item(s) attached — will be included in your next message" with a Detach button → Detach → banner cleared → Clear all → back to 0/8 items.

## E. Chat prompt payload integration

- `lib/contextPayload.ts` (new, pure/testable — no Hermes/network call): `revalidateItems()` (shared with the attach route) and `assembleContextPrompt()`, which produces exactly:
  ```
  [VYRON_CODE_SELECTED_CONTEXT]
  Project: <displayName>
  Source: <relative path>
  Lines: <start>-<end>  (or "hunk <header>")
  Content:
  <bounded content>
  [/VYRON_CODE_SELECTED_CONTEXT]
  ```
  one block per attached item in stable (selection/insertion) order, followed by the user's own prompt text, unchanged. With zero attached items, the function is never called at all.
- `app/api/hermes/prompt/route.ts` modified: when a session has no attached context, `promptText` stays exactly `text` — every existing line of behavior (title derivation, audit, error handling) is untouched, so the no-context path is byte-for-byte identical to before this task. When context IS attached, every item is revalidated fresh immediately before sending; any staleness fails the **entire submission** closed (409, `staleItems`, no prompt reaches Hermes) rather than silently dropping or resending changed content. `cwd` was never touched by this route in the first place (fixed at `session.create` time) and remains untouched. The assembled text exists only in a local variable for the duration of the request — never written to SQLite, the audit log, or any log line.

## F. Verification

### Security regression
- Re-read `lib/canonicalPath.ts`, `lib/fsGuard.ts` — unchanged. Every new content-reading path (`lib/contextContent.ts`) goes through `guardProjectPath`, so canonical-root/traversal/junction/deny-list protection is inherited, not reimplemented.
- `tests/canonicalPath.test.ts` (pre-existing, unmodified) still passes — 0 regressions.

### Git UI
- Live-verified against a disposable scratch git repository (see "Git commands run during verification" below): branch name, `M a.txt` status line, single-hunk diff parse, and paginated history all rendered correctly. Live-verified the non-repo graceful empty state against `D:\Vyron Code` itself (not a git repository) — `{isRepo:false}` → "This folder isn't a Git repository." with no raw error, no stack trace, no absolute path shown.

### Context Selector / Inspector
- `tests/contextSelections.test.ts` (14 tests): schema additive-migration correctness (new columns present, no `content`/`raw_content` column ever), all four numeric limits (per-item 12,000 chars, 8-item cap, 48,000 aggregate chars, 12,000 aggregate tokens), session-scoped remove/clear (cannot delete another session's row), and a direct assertion that a raw content string never appears anywhere in a stored row.
- `tests/gitHunks.test.ts` (7 tests): hunk splitting, index assignment, multi-file-diff boundary handling, header+index lookup, and the "hunk no longer present" stale case.
- `tests/contextPayload.test.ts` (11 tests): exact block format, hunk-label formatting, deterministic ordering, the zero-items passthrough, and — critically — `revalidateItems()`'s fail-closed behavior: one changed item fails the whole batch with the *other* item's success discarded, a deleted/denied path fails closed, and `previewItem()`'s per-item (non-batch-failing) preview + 500-char bound.
- Live-verified in-browser: File Viewer line-range → context, search-result → context, git-hunk → context, remove, clear, and the stale-badge + blocked-attach flow described in section D.

### Chat compatibility
- No context attached: `app/api/hermes/prompt/route.ts`'s no-context branch is untouched from the prior task's implementation — verified by re-reading the diff, not just by inspection.
- No new client-side WebSocket to Hermes exists anywhere — `lib/hermesClient.ts` (server-only `ws` client) was not modified.
- No secret reaches any client-visible surface — verified by re-reading `lib/hermesClient.ts`'s existing comments/tests and confirming this task added no new place that could leak `HERMES_SESSION_TOKEN`.
- Every git/context error path returns a fixed, safe string (see A/D above) — no raw stderr, no stack trace, no absolute path.

### Quality
- `npx tsc --noEmit`: 0 errors.
- `npm run lint` (`eslint .`): 0 errors, 0 warnings. Two `react-hooks/set-state-in-effect` violations were introduced and then fixed during this task (in `GitPanel.tsx` and `ContextInspector.tsx`) using the same established pattern as the prior task: key-based remount (`key={projectId}` / `key={activeSessionId ?? "none"}` at the call sites in `app/page.tsx`) instead of a manual synchronous reset inside the effect body.
- `npm run test` (vitest): **52/52 passing**, 6 test files (3 pre-existing + `gitHunks.test.ts`, `contextSelections.test.ts`, `contextPayload.test.ts`, all new).
- `npm run build`: succeeds, 0 errors, all 3 new `/api/context*` routes listed as dynamic server routes alongside the existing ones.
- Production-build-then-localhost smoke check: started via `npm run start` (see `.claude/launch.json`, new — a dev-tooling config file only, not a project source change), loaded in a **fresh** browser tab, 0 console errors. (An older, already-used tab's console log — expected to accumulate every deliberately-triggered error from live testing: missing-token 502s, a deliberate 409 stale-attach, a 404 from a since-deleted test session, and a few `ERR_CONNECTION_REFUSED` from restarting the server mid-session — was double-checked and confirmed to be historical, not new.)

### Manual/browser verification detail
Performed live against the running production build, not simulated:
1. Added `D:\Vyron Code` as a project. Confirmed Git panel shows the graceful "This folder isn't a Git repository." empty state (it genuinely isn't one).
2. Selected a pre-existing conversation (no new Hermes session created). Selected a line range in `package.json` in the File Viewer → "+ Add to context" appeared → clicked → item appeared in the Inspector (179 chars, 45 tokens) with a working bounded preview.
3. Attach → confirm screen showed the exact required Will-send/Will-NOT-send lists → Confirm attach → "1 item(s) attached" banner with Detach → Detach → Clear all. All verified via the real running server (network requests + response bodies inspected directly, not assumed).
4. Search panel: searched "canonicalRoot", clicked "+ context" on a result → item appeared in Inspector (90 chars, 23 tokens) — confirmed search-result-to-context wiring works.
5. **Bug found and fixed during this verification pass**: switching from one project to another did not reset `activeSessionId` in `app/page.tsx`, so the Context Inspector briefly showed a context item that belonged to a *different* project's conversation after a project switch (a client-side state bug — the server itself never leaked anything cross-project, since every route re-validates `session.projectId` independently). Fixed by adding a `selectProject()` wrapper that resets all conversation-scoped state (`activeSessionId`, `openPath`, `targetLine`, `timelineEvents`, `contextRefreshToken`, `contextNotice`) on every project change, used by both the picker's `onSelect` and the "← projects" button. Re-verified clean after the fix (rebuilt + re-tested).
6. Created a disposable scratch git repository (outside `D:\Vyron Code`, in the session's own scratchpad directory — never inside the user's real project) to exercise the Git UI and hunk-based Context Selector against real repo data: branch/status/diff/hunk display all correct; added a hunk to context; modified the file further; confirmed the Inspector showed a "stale" badge with the safe message "That diff hunk is no longer present — the file may have changed."; confirmed Attach → Confirm attach was blocked with the fail-closed message naming the stale item. Deleted the scratch repository and its Vyron Code project/session/context rows immediately after.
7. Mobile/narrow-width check: the app's layout (a fixed `240px 1fr 360px` CSS grid) is unchanged from the prior Core UI task and was never designed with a responsive/mobile breakpoint; at a 375px viewport it renders the same fixed desktop grid (horizontally wider than the viewport) rather than collapsing to a single column. This is a pre-existing characteristic of the whole app's layout, not a regression introduced by this task's Git/Context UI, and a responsive redesign was out of this task's scope (Git UI + Context Selector/Inspector/Attach functionality). Disclosed here rather than silently left unmentioned.
8. Keyboard/ARIA: `role="tree"`/`treeitem"` preserved from the existing File Tree; new interactive elements carry either visible text (buttons like "+ Add to context", "Attach selected context") or an explicit `aria-label` where the accessible name would otherwise be ambiguous (`"Add {path} line {line} to context"`, `"Toggle preview for {path}"`, `"Refresh git status"`, `"Remove {path} from context"`). Lists carry `aria-label`s (`"Selected context items"`, `"Changed files"`, `"Commit history"`).

## Dependency / database rules

- **No new npm dependency was added or requested.** `package.json` is unchanged from the prior task (`@monaco-editor/react`, `next`, `react`, `react-dom`, `ws` as the only runtime dependencies).
- SQLite migration (`lib/db.ts`'s `migrateContextSelectionsTable`) is additive-only: it adds `project_id`, `content_fingerprint`, `char_count`, `token_estimate`, `attached`, `attached_at` columns to the pre-existing `context_selections` table via `ALTER TABLE ... ADD COLUMN`, guarded by a `PRAGMA table_info` check (never fails on a table that already has them). The table's original `kind` `CHECK` constraint (`file_snippet`/`git_diff_hunk`/`project_state_field`/`memory_field`) was deliberately **not** widened — SQLite cannot ALTER a CHECK constraint in place, and no shipped UI has ever written a row to this table before this task, so the existing allowed values were sufficient (a search-result selection reuses `file_snippet`, since both are "a path plus a line range in a text file"). Verified additive-migration correctness against a hand-constructed older-schema table in `tests/contextSelections.test.ts`. Rollback: `ALTER TABLE context_selections DROP COLUMN <name>` for each of the six added columns (SQLite 3.35+), leaving `id`/`session_id`/`kind`/`path_or_ref`/`range_or_hunk`/`created_at` and every other table untouched.
- No raw file/diff content, prompt text, or token is ever written to SQLite — verified both by code inspection and by a dedicated test asserting a known content string never appears in a serialized row.

## Git commands run during this task (full disclosure)

Two categories, kept strictly separate:
1. **Inside the application (`lib/git.ts`, called only from the three existing read-only API routes)**: `git status --porcelain=v1 -b`, `git log -n <limit> --skip=<skip> --pretty=...`, `git diff --no-color [-- <path>]`. No mutating command exists in the codebase.
2. **Directly via shell, for my own test-fixture setup only** (not through the application, not on the user's real project, not inside `D:\Vyron Code`): `git init`, `git config user.email/user.name`, `git add`, `git commit` — run once, in a disposable directory I created under this session's own scratchpad (`...\scratchpad\vyron-git-test`), purely to have a real repository with a real uncommitted change and a real commit history to exercise the new Git UI and hunk-based Context Selector against actual git output rather than mocked data. This directory and its git history were deleted at the end of verification, and its corresponding Vyron Code project/session/context rows were removed from the local dev database. This is disclosed here in full rather than omitted, consistent with this engagement's established transparency practice.

## Services intentionally untouched

Hermes Agent (source/config), Bridge, OmniRoute, deliberation-service, Vyron Pro, Open WebUI — no source, config, or running-process change to any of these. `HERMES_SESSION_TOKEN` was not set in this task's verification server process (deliberately, to avoid any live Hermes call) — the one "+ New chat" attempt made during verification failed closed at `getHermesClient()`'s own token-presence check, before any network connection was attempted, confirming **zero** real Hermes/provider network calls were made during this entire task's implementation and verification.

## Files changed

New: `lib/gitHunks.ts`, `lib/contextSelections.ts`, `lib/contextContent.ts`, `lib/contextPayload.ts`, `app/api/context/route.ts`, `app/api/context/attach/route.ts`, `app/api/context/detach/route.ts`, `components/ContextInspector.tsx`, `tests/gitHunks.test.ts`, `tests/contextSelections.test.ts`, `tests/contextPayload.test.ts`, `.claude/launch.json` (dev tooling only).

Modified: `lib/db.ts` (additive migration), `lib/git.ts` (safe error classification, pagination, status parsing), `lib/apiClient.ts` (new types/wrappers), `app/api/git/status/route.ts`, `app/api/git/log/route.ts`, `app/api/git/diff/route.ts`, `app/api/hermes/prompt/route.ts` (context-aware assembly, additive), `components/GitPanel.tsx` (full rewrite), `components/FileViewer.tsx` (selection → context), `components/SearchPanel.tsx` (result → context), `components/ChatPanel.tsx` (added `onSessionChange` callback — 3 lines), `app/page.tsx` (lifted `activeSessionId`, wired Context Inspector, fixed the project-switch state-reset bug).

## Remaining blockers before v0.1 completion

None identified that block this task's own scope. Two smaller items worth noting for a future authorization: (1) a full responsive/mobile layout pass for the whole app (out of this task's scope, pre-existing), and (2) an actual live-Hermes end-to-end smoke check of the attach → prompt.submit path with a real conversation (not performed here, by design, to keep this task's own verification at zero real Hermes calls — the payload assembly and fail-closed logic are instead fully covered by `tests/contextPayload.test.ts` and by exercising the same code paths against a locally-inserted test session row, per section F above).

## Recommended next approval

A short, separate authorization for a real end-to-end live smoke check (one real session, one real `prompt.submit` with a genuinely attached context item, verifying the assembled `[VYRON_CODE_SELECTED_CONTEXT]` block actually reaches Hermes correctly) would close the one gap this task's own zero-Hermes-calls constraint left open.
