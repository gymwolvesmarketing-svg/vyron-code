# Vyron Code v0.1 — Security Threat Model

Scope: Vyron Code's own new filesystem/Git/terminal layer. Does not change Hermes Agent, Bridge, deliberation-service, Vyron Pro, or Open WebUI (all untouched, per product direction).

## Trust boundaries

1. **Browser ↔ Vyron Code backend** — browser is untrusted input (same posture as Vyron Pro's existing `app/api/*` pattern). No secret, no Hermes/Bridge/deliberation token ever reaches the browser.
2. **Vyron Code backend ↔ local filesystem** — the new, highest-risk boundary this document is about.
3. **Vyron Code backend ↔ Hermes Agent (`tui_gateway` WS)** — reuses Hermes Agent's own existing auth (whatever session/profile token Vyron Pro already uses; no new privilege here since Vyron Code speaks the same protocol Vyron Pro does).
4. **Vyron Code backend ↔ Git/terminal** — subprocess execution boundary, separate from but adjacent to the filesystem boundary.

## Canonical-path resolution algorithm (required for every filesystem operation)

```
requested_path (from browser, untrusted)
  → normalize (resolve "..", ".", redundant separators)
  → resolve to canonical path (Windows: resolve symlinks AND junctions/reparse points —
     os.path.realpath is insufficient alone on Windows for junctions; must additionally
     resolve via GetFinalPathNameByHandle-equivalent or os.stat + junction detection)
  → re-verify the canonical result is a descendant of the project's own canonical root
    (string-prefix compare on ALREADY-canonicalized paths only, never on the raw input —
    naive StartsWith on non-canonicalized paths is the exact class of bug this replaces)
  → deny (403-equivalent, logged) if outside root, or if the root itself cannot be canonicalized
```

This must run on every path-accepting operation (read, write, list, diff, delete, rename, Git operations scoped to a path, terminal `cwd`), not just once at project-open time — a session's project root is fixed at open time, but every individual request must still be re-verified, since a symlink/junction could be created *after* the project was opened (TOCTOU).

## Deny-by-default file classes (never readable or writable by Vyron Code, regardless of project root)

- `.env`, `.env.*`, `*.pem`, `*.key`, `*.pfx`, `id_rsa*`, `id_ed25519*` and other private-key patterns
- Anything under `%LOCALAPPDATA%\hermes\` (the actual secret store this whole engagement has been careful never to expose)
- `.git/config` (may contain credential helpers/tokens) — `.git/` internals in general are Git-operation-only, never raw-file-read/write targets
- Any path outside the active project's canonical root, full stop — including the user's home directory, other projects, and OS/system directories, even if a relative `..` sequence could technically resolve there
- Symlink/junction targets that resolve outside the canonical root (denied by the algorithm above, not a separate list, but called out explicitly since it's the most likely bypass class)

This list is a **starting minimum**, not exhaustive — the implementation should also support a per-project `.vyroncodeignore`-style user-configurable deny list (secrets scanning heuristic as defense-in-depth, not a replacement for the hard-coded list above).

## Cross-project isolation

Each open project gets its own canonical root, established once at project-open time and cached. No operation may accept a path that escapes that root, even via an explicit `../other-project` from the browser — this is enforced by the canonical-path algorithm above, not by trusting the browser to not ask. Multiple simultaneously-open projects (if/when v0.2+ supports that) must not share any implicit path resolution state (no process-wide "current directory" — every operation must carry and re-verify its own explicit root).

## Terminal / Git risk boundary

Terminal and Git are process-execution primitives, categorically higher-risk than file read/write:
- Terminal `cwd` must be pinned to the canonical project root (or a canonical descendant) at spawn time, re-verified the same way as file paths — never trust a client-supplied `cwd` string directly.
- No terminal command should be silently auto-approved by default for v0.1 — every terminal execution is a "propose → show the exact command → explicit user approval → run" flow (the "Read ≠ Write" governance principle applied to process execution, not just files). This is stricter than Hermes Agent's own `shell.exec` (which only blocks a hardline/dangerous-command denylist and otherwise runs immediately) — Vyron Code's terminal should default to allow-list-of-approved-commands-this-session plus explicit approval for anything new, since the whole product's premise is "propose, don't auto-act."
- Git operations follow the same propose → diff/preview → explicit approval → apply pattern already established for PROJECT_STATE/memory writes elsewhere in this engagement — `git status`/`git log`/`git diff` (read-only) may run without approval; `git add`/`commit`/`push`/`checkout -b`/anything that mutates repo or remote state requires explicit per-action approval, never a standing "always allow" default in v0.1.

## Read ≠ Write governance (reused principle)

Every mutating filesystem/Git/terminal action follows: propose → diff/preview → explicit user approval → apply. This is the same principle already enforced for Bridge's PROJECT_STATE/memory writes throughout this engagement, extended to Vyron Code's own new surfaces. No "auto-apply" mode in v0.1.

## Explicit non-goals for v0.1 security (deferred, not forgotten)

- No multi-user/multi-tenant isolation (single local operator, same trust model as Hermes Agent/Vyron Pro today).
- No sandboxed/containerized code execution for the terminal (runs with the same OS-user privileges as Vyron Code's backend process itself) — a real risk, accepted for v0.1 as consistent with Hermes Agent's own `shell.exec` risk posture, revisit before any multi-user future.
- No network-level access control (still a localhost-only tool, same posture as every other service in this engagement).
