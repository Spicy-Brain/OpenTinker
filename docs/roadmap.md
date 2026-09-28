# Roadmap

Status legend: `[x]` implemented, `[~]` partly implemented, `[ ]` planned.

## Done in 0.3

- [x] Fresh session per run (fork from the booted app), with keep-session as an option
- [x] Stop without restarting PHP; clean reporting of fatals, `exit()` and crashes
- [x] Statement splitting with the app's php-parser; syntax errors before running
- [x] Protocol v2 handshake with versions and capabilities
- [x] Worker split into classes and built into one file
- [x] Integration tests against real apps in CI (PHP 8.2–8.4, Laravel 10–13, PsySH
      before and after 0.12.22) and a real VS Code end-to-end suite
- [x] Run controller with explicit states; `extension.ts` split into modules
- [x] Saved targets with per-file targets, auto-detection and a single target form
- [x] Bundled results front end with typed messages and happy-dom tests
- [x] Status bar target (red on production), inline results, results beside or in panel
- [x] Scratch-only Cmd/Ctrl+Enter, Cmd/Ctrl+Shift+Enter for selections, editor ▶
- [x] Run comparison markers
- [x] Error display: scratch line first, clickable app frames, hidden internals
- [x] `dd()`/`exit()` end runs cleanly
- [x] Eloquent model cards
- [x] Database rollback toggle; production guard for writes
- [x] Per-statement timing and N+1 hints
- [x] Model hints for autocomplete; Intelephense check
- [x] Tinker This Model, Run Clipboard, Run Selection in any PHP file
- [x] Copy as text, JSON, PHP array, CSV and Markdown
- [x] Shared snippets in `.tinker/snippets/`
- [x] Plain PHP and custom bootstrap files

## Next

- [ ] Auto-run on save or after typing stops (deliberately left for later)
- [ ] Boot script per target (`auth()->loginUsingId(1)`, feature flags)
- [ ] Snippet folders and import/export
- [ ] Richer `//?` probes (loop iterations, timing)
- [ ] Finer error positions inside multi-line statements (PsySH pretty-prints code)
- [ ] Dump theme options beyond the VS Code colours

## Windows / WSL

- [ ] `WslTransport` for UNC workspaces (`\\wsl.localhost\...`)
- [ ] Remote-WSL verification (extension host runs inside the distro)
- [ ] Native Windows PHP: fresh runs restart PHP each time (no `pcntl`); measure and
      consider a warm spare process

See [wsl-support.md](wsl-support.md) for the full plan.

## Release

- [x] Marketplace/Open VSX listing assets: PNG icon, screenshots, README, changelog
- [x] Release checklist and a release workflow that verifies and packages the VSIX (see
      [store-release-plan.md](store-release-plan.md))
- [ ] Demo GIF
- [ ] First store upload (preview), by hand
- [ ] Optional Laravel Boost MCP interoperability
- [ ] 1.0
