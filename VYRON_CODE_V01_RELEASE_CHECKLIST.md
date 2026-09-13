# VYRON_CODE_V01_RELEASE_CHECKLIST

## Required before v0.1 local release

- [x] Localhost-only bind for Vyron Code (`127.0.0.1:3055`), verified with no wildcard/IPv6/LAN listener.
- [x] Localhost-only bind for Hermes serve (`127.0.0.1:9130`), verified read-only.
- [x] Official manual-foreground launch model documented and implemented (`npm run start:local`, preflight fail-closed on port conflict).
- [x] External launcher disposition resolved for now (`NO_CHANGE_NOW`, `SAFE_SERVER_ENV_ONLY`) — not modified further in this task.
- [x] Server-side-only token-loading boundary re-verified (never in `.env.local`, source, command line, logs, or browser).
- [x] Passive Hermes/Vyron Code health indicator in the UI, refresh-only (no restart/reconnect/retry control).
- [x] SQLite metadata backup + bounded retention (manual, on-demand; schema-checked before keeping a backup).
- [x] `data/` and `data/backups/` confirmed `.gitignore`d.
- [x] Responsive narrow-viewport fallback (single-panel tabbed layout, no page-level horizontal scroll) down to a real mobile width.
- [x] Full test suite green (62/62), lint clean, `tsc --noEmit` clean, production build clean.
- [x] Production-build localhost smoke check (fresh tab, zero console errors).

## Recommended but non-blocking

- [ ] Multi-sequential-turn durability test (only one full turn has been verified end-to-end so far).
- [ ] Dedicated screen-reader pass across all five panels.
- [ ] Graceful shutdown with a bounded wait for an in-progress turn.
- [ ] Replace the external launcher script with an in-project equivalent (or retire it in favor of the documented manual procedure alone).

## Deferred by design

- Full responsive/mobile redesign beyond the current graceful fallback.
- Automated/scheduled SQLite backup.
- Auto-restart / process supervision beyond "the user restarts it."
- Windows Service / Scheduled Task / Docker / Electron packaging.
- Bridge read identity, PROJECT_STATE/memory panels, RAG, real multimodel/deliberation start, file write, terminal, Git write.

## Requires separate explicit authorization

- Any further change to the external launcher script, or its replacement.
- Any new dependency, database schema change, or scheduled/automated job.
- Any additional live Hermes smoke test.
- Any process-supervision or auto-restart implementation.
