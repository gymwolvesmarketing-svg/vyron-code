# VYRON_CODE_V01_RELEASE_HARDENING_PLAN

Planning document only. Every item below is a proposal for a future, separately-authorized implementation task — nothing here has been built, and this document itself makes no code, config, or infrastructure change.

## 1. Required fixes before normal local daily use

- **Launcher/lifecycle remediation**: replace the external, out-of-project launcher script (`run-vyron-code.cmd`, currently outside `D:\Vyron Code`) with either an in-project, reviewed launch helper, or — more simply — a documented manual procedure (per the runbook draft) that needs no side-file at all.
- **External launcher artifact disposition**: per the audit report, `no_change` now, `replace` in a future task — tracked here as the concrete follow-up item.
- **Dev/server process supervision**: adopt the Browser-preview-managed-process model as the documented standard for agent-assisted sessions (already proven durable through a full provider turn); do not rely on ad hoc ephemeral process launches for anything expected to outlive a single tool call.
- **Token-loading boundary**: keep the existing principle (read live from the trusted source at process-start time, into that process's environment only, never persisted) — just consolidate *where* that read happens once the launcher question above is resolved, so there is exactly one reviewed place it happens, not two.
- **Local logs and retention**: no log file currently written by Vyron Code's own application code contains anything sensitive (confirmed across every report in this engagement) — the only open item is making sure whatever launch model is finally adopted doesn't introduce a new, unreviewed log path. No retention policy is needed for logs that don't yet exist in a stable location.
- **SQLite backup/retention policy**: see section 3, below.
- **Responsive/mobile audit**: see section 4, below.
- **Accessibility pass**: baseline already exists (ARIA labels on ambiguous icon-only controls, `role="tree"`/`treeitem"` on the file tree, keyboard-operable Monaco selection-to-context flow) — a dedicated pass to verify tab order and screen-reader labelling across every panel (Git, Context Selector/Inspector, Chat) has not yet been done end-to-end and is proposed as a P1/P2 item.
- **Final acceptance test plan**: the core read-only chain (localhost-only bind ×2, real session.create, context select→attach→prompt with correct model usage, safe closure, zero write-capability anywhere) has now been verified live, end-to-end, exactly once. A repeatable, documented acceptance checklist (distinct from the unit/integration test suite) does not yet exist as its own artifact — proposed as a P3 documentation item.

## 2. Proposed implementation sequence

```text
P0 — Security/lifecycle blockers:
  - Resolve the external-launcher disposition (replace or formally document as accepted).
  - Formally adopt one documented launch model per audience (agent session vs. human daily use) rather than leaving it implicit.

P1 — Daily-use reliability:
  - Multi-sequential-turn durability test (only a single turn has been verified so far).
  - Preflight port-conflict check documented as a hard step (not yet automated).
  - Manual-restart-after-crash procedure exercised at least once for real, not just documented.
  - Accessibility tab-order/screen-reader pass across all panels.

P2 — Responsive/mobile and usability polish:
  - Actual responsive breakpoint(s) for the 3-column layout (currently a fixed-width desktop grid; already disclosed as a known limitation in the Git/Context implementation report).
  - Graceful shutdown with a bounded wait for an active turn, if daily use shows the current "just stops" behavior to be a real annoyance rather than a theoretical one.

P3 — Documentation, runbook, release checklist:
  - Promote this runbook draft from "draft" to a finalized operating document once P0/P1 items are actually implemented and re-verified against it.
  - A standalone, repeatable acceptance-test checklist document.

Deferred (explicitly out of scope, not merely low-priority):
  - Bridge read identity.
  - PROJECT_STATE/memory panels.
  - RAG / semantic search / embeddings / vector DB.
  - Real multimodel/deliberation start capability.
  - File write capability.
  - Terminal/shell execution capability.
  - Git write capability.
  - Desktop packaging (Electron or otherwise).
```

## 3. SQLite policy (design proposal only — no script or scheduled job created)

- **What local metadata is retained today**: projects (canonical root, display name, timestamps), sessions (local id, Hermes session id, status, title, message count, timestamps), context-selection metadata (project/session scoping, kind, relative path, serialized line-range/hunk-reference, a SHA-256 content fingerprint, character count, token estimate, attached flag, timestamps), and a coarse audit log (action kind, target, status, timestamp) — verified against the actual schema in `lib/db.ts` and `lib/contextSelections.ts`, not assumed.
- **How "no raw content/prompt/token/provider-secret is ever stored" is enforced today**: by construction, not by a filter — no code path in `lib/contextSelections.ts`, `lib/contextContent.ts`, `lib/contextPayload.ts`, or `app/api/hermes/prompt/route.ts` ever calls an `INSERT`/`UPDATE` with the actual snippet text, the assembled prompt, or a token value as a parameter; a dedicated test (`tests/contextSelections.test.ts`) already asserts a known content string never appears in a serialized row, as a regression guard. Any future schema change should keep this same "provably never touches the DB layer" property rather than relying on redaction after the fact.
- **Where a backup should live**: outside `D:\Vyron Code`'s own working tree entirely (e.g. a dedicated backup folder under the user's own profile, well away from anything that could ever become part of a future git repository for this project) — never inside `data/` itself if that folder is ever added to version control later.
- **Backups must never be Git-tracked**: `data/` (and any backup copy of it) should be confirmed present in `.gitignore` the moment this project is ever put under version control — it is not yet (no git repository exists for `D:\Vyron Code` at all today), so this is a forward-looking requirement to apply the day one is created, not a current gap.
- **Retention/rotation approach (proposed)**: a small fixed number of dated snapshots (e.g. the most recent 5–10), rotated on a simple age or count basis — this is local-only metadata (no raw content), so the cost of keeping a modest number of snapshots is low and the value is mainly "don't lose conversation/context-selection history across an accidental delete," not disaster recovery for sensitive data.
- **Restoring safely**: since the database never holds raw content, restoring an old snapshot only ever restores metadata (which conversations existed, what was selected, when) — never anything that could reintroduce a stale secret or stale file content, since none was ever stored to begin with.
- **Automatic vs. manual**: propose **manual** for v0.1 (a documented "copy the file" step in the runbook, run by the user when they choose to) rather than an automated scheduled job — an automated backup job is exactly the kind of new standing/scheduled capability that should get its own explicit authorization before being built, per this engagement's own established practice.

## 4. Responsive/mobile review plan (proposal only)

- **Minimum desktop viewport**: the current fixed `240px / 1fr / 360px` three-column grid implies a practical minimum around **~960–1024px** wide before panels become uncomfortably cramped; no lower bound is currently enforced.
- **Narrow-width graceful behavior**: currently, a narrow viewport does not reflow — it renders the same fixed grid and requires horizontal scrolling (already disclosed as a known limitation, not a new finding, in `VYRON_CODE_V01_GIT_CONTEXT_IMPLEMENTATION_REPORT.md`). Proposed target: at minimum, avoid horizontal page-level scroll by collapsing to a single active panel with a way to switch between Explorer/Editor/Chat/Context/Git, rather than a true multi-column responsive redesign (which is a larger effort than v0.1's remaining scope justifies).
- **Mobile browser support**: propose this be an **explicit non-goal** for v0.1 — Vyron Code is a desktop coding-workspace tool by nature (Monaco editor, multi-panel layout, keyboard-driven selection), and a genuine mobile experience would need a fundamentally different UI, not a responsive tweak. State this plainly rather than leaving it ambiguous.
- **Keyboard navigation**: largely present already (file tree `role="tree"`/`treeitem"` with `tabIndex`, Monaco's own keyboard selection, buttons as real `<button>` elements) — a dedicated pass to verify complete tab order across all five panels (Explorer, Editor, Chat, Context Inspector, Git) has not yet been done as its own exercise.
- **Focus management**: no explicit focus-trap or "return focus on panel switch" logic exists yet; propose verifying this specifically for the Context Selector's add-to-context flow and the Attach confirm/cancel flow, since those are the newest interactive surfaces.
- **Screen-reader/ARIA baseline**: ambiguous icon-only controls already carry `aria-label`s (verified in the Git/Context implementation work); a full pass with an actual screen reader (not just static code review) has not been done and is proposed as a P1/P2 item.
- **Per-surface responsive criteria** (targets, not yet implemented):
  - Chat: must remain usable and legible down to the minimum supported viewport; message text should wrap, never truncate silently.
  - Code viewer (Monaco): should degrade to horizontal-scroll-within-the-editor (Monaco's own native behavior) rather than the whole page scrolling.
  - Git diff view: hunks should remain readable at reduced width; currently rendered in a monospace `<pre>` with its own scroll — acceptable as a baseline, not yet stress-tested at narrow widths.
  - Context Inspector: the will-send/will-not-send lists and per-item metadata should remain fully readable without truncation at the minimum supported viewport.

## 5. v0.1 release gate

```text
Required before v0.1 local release:
  - External launcher disposition resolved (replaced or formally accepted as-is).
  - One documented, adopted launch model per audience (agent session vs. human use).
  - Preflight port-conflict check documented in the runbook (already done in this task).
  - Full test suite green, lint/typecheck/build clean (already true as of the last implementation report — re-verify if anything changes).

Recommended but non-blocking:
  - Multi-turn durability test.
  - Accessibility screen-reader pass.
  - Minimal single-panel-at-a-time narrow-width fallback.
  - A standalone, repeatable acceptance-test checklist document.

Deferred by design:
  - Full responsive/mobile redesign.
  - Automated SQLite backup job.
  - Auto-restart/process supervision beyond manual restart.
  - Windows Service / Scheduled Task / Docker / Electron packaging.
  - Bridge read identity, PROJECT_STATE/memory panels, RAG, real multimodel/deliberation start, file write, terminal, Git write.

Requires separate explicit authorization:
  - Any implementation of a P0/P1 item above.
  - Any change to the external launcher script or its replacement.
  - Any new dependency, database schema change, or scheduled/automated job.
  - Any further live Hermes smoke test (a repeatable acceptance-test run against a real provider).
```
