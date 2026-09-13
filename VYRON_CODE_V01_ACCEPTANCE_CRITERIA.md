# Vyron Code v0.1 — Acceptance Criteria & Non-Goals

## In scope for v0.1 (must all be true to call v0.1 "done") — read-only project-aware workspace

1. A user can add a local folder to a project allowlist/registry; the canonical root is resolved and persisted (`projects` table).
2. The selected project's canonical root is what every subsequent operation is checked against.
3. File tree renders only entries under the canonical root — nothing above or outside it, ever.
4. A real symlink/junction test, created under the project root and pointing outside it, is attempted and confirmed **blocked** by `lib/canonicalPath.ts` (not just a code-review claim — an actual test that creates the junction and calls the API).
5. `.env*`, key/credential patterns, `.git/` internals, `node_modules/`, binaries, and the rest of the deny-list are invisible to the file tree, search, preview, and any automatic context selection.
6. A user can open and view a file read-only (Monaco viewer).
7. Literal/grep search works within the canonical root, respecting the same deny-list.
8. A Hermes Agent session is created with the correct project `cwd` (verified via the real `tui_gateway` `session.create` call, not a mock).
9. Chat/Cowork streams real responses in the correct project context, including `approval.respond`/`clarify.respond` prompts rendering correctly and a task/tool progress timeline from `tool.started`/`tool.completed` event frames.
10. `git status`/`diff` render real, read-only output for the open project.
11. PROJECT_STATE and scoped memory are viewable read-only (via the new `vyron_code` Bridge client identity's read-only scopes); no propose/commit affordance exists anywhere in the UI.
12. File write, terminal execution, Git stage/commit/push, and multimodel session start are not just hidden in the UI — they do not exist as callable backend capabilities in v0.1's code at all. The UI may show them as visibly-disabled affordances (per the Product Blueprint's component map) so the product's full shape is legible, but there is no route, handler, or code path that could execute them even if the disabled state were bypassed client-side.
13. Every request (fs, search, git, hermes-proxy, project-state/memory) passes server-side canonical-root/scope validation — never trusting a client-supplied path or project id without re-verifying it belongs to a registered, still-valid project.
14. No secret (Hermes/Bridge token, `%LOCALAPPDATA%\hermes\.env` contents, deliberation token) is ever sent to the browser or written to `audit_log`.

## Explicitly excluded from v0.1 (not deferred by accident — deliberate scope cuts, recorded so nobody re-litigates them mid-build)

- RAG / vector search / embeddings.
- Semantic search (literal/grep only).
- File write of any kind (including the propose/apply flow — deferred to v0.4, not v0.1; v0.1 has no write route at all).
- Patch application.
- Terminal (no execution capability exists in v0.1's backend, not merely gated).
- Test/build execution, package installation, process management.
- Git stage, commit, push, or any mutating Git action.
- Deploy.
- PROJECT_STATE write, memory write, decision archive write.
- A real, callable multimodel/deliberation session start (`START_MULTIMODEL` is a disabled UI affordance with a context-preview mockup only; no backend route exists to actually start a session — see v0.2 in the Roadmap).
- Multiple simultaneously-open projects in one session.
- Docker/container packaging of Vyron Code itself.
- Any multi-user, remote-access, or non-localhost mode.
- Voice, orb, or any Three.js presence UI (Vyron Pro's domain, not Vyron Code's).
- Any change to Hermes Agent, Bridge, deliberation-service, Vyron Pro, or Open WebUI source code.
- Creating the new Bridge `vyron_code` client identity (registry entry + token) is a change to an existing repo (`hermes-core-bridge/config.py`) and, consistent with every other existing-repo change in this engagement, requires its own explicit, separate authorization before it is made — it is NOT authorized by this document or by the general "start writing Vyron Code" go-ahead. Until that authorization is given, items #11 above (PROJECT_STATE/memory read views) are built against a documented, mocked/stubbed Bridge response shape and are wired to the real Bridge endpoint only once the identity exists. The deliberation-service per-client registry change is the same category of blocked-pending-separate-authorization item, tracked as the v0.2 prerequisite.

## Test strategy summary (detail in Product Blueprint)

Priority order: (1) `canonicalPath.ts` escape-attempt unit tests — highest priority, this is the entire security boundary; (2) propose/apply staleness/replay integration tests; (3) real `tui_gateway` round-trip verification (session.create → prompt.submit → a real response), done manually first the same way Vyron Pro's own integration was verified earlier in this engagement, before broader automated coverage.

## Rollback strategy

Additive-only footprint (new directory, new port, read-only consumer of Hermes Agent's existing protocol). Rollback = stop the process. No migration, no shared schema, no touched config in any existing repo to undo.
