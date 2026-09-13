# Roadmap

Status legend: `[x]` shipped, `[~]` in progress, `[ ]` planned.

## Phase 0 — Foundation

- [x] Repo scaffold: esbuild, ESLint, Prettier, VS Code launch config, CI
- [x] Protocol spec (see [protocol.md](protocol.md))
- [x] Persistent PHP worker with PsySH, HtmlDumper dumps, token rewriter
- [x] Docker Compose and local transports
- [x] Run selection/file commands, output webview, status bar
- [x] Publish pipeline stubs for Marketplace and Open VSX

## Phase 1 — Tinker window (current)

- [x] Scratch files under `.tinker/` with gitignore offer
- [x] Statement-by-statement execution with per-line result cards
- [x] SQL insight via `DB::listen` attached to each statement
- [x] Sidebar view: scratch files, recent runs, session status
- [x] Per-file stored output, Run Again / Restart / Clear toolbar
- [x] `Ctrl+Enter` primary keybinding, CodeLens run button
- [x] Runtime picker: Compose service, running container, or local PHP
- [ ] History search across runs
- [ ] Boot script per connection (`auth()->loginUsingId(1)`, etc.)

## Phase 2 — Insight

- [ ] Variable inspector panel backed by `scope` frames
- [ ] Magic comments (`//?` expected values, live coverage)
- [ ] Table rendering for arrays/collections
- [ ] Email and HTTP response previews
- [ ] File context: inject `use` statements from the active file
- [ ] Output polish: collapse, search, copy

## Phase 3 — Library

- [ ] Snippet library with folders, search, import/export
- [ ] Laravel log tail panel
- [ ] Dump theme picker and custom themes

## Phase 4 — Remote

- [ ] SSH transport and remote boot scripts
- [ ] SSH connection manager UX
- [ ] Optional Laravel Boost MCP interoperability

## Phase 5 — Windows / WSL

- [ ] `WslTransport` for UNC workspaces (`\\wsl.localhost\...`)
- [ ] Remote-WSL verification (extension host runs inside the distro)
- [ ] Distro picker, path translation, `WSL_UTF8` handling

See [wsl-support.md](wsl-support.md) for the full plan.

## Phase 6 — Hardening

- [ ] Timeout/crash-recovery test matrix (PHP 8.2–8.4, Laravel 11–13)
- [ ] Output size limits, memory pressure behaviour
- [ ] Marketplace/Open VSX listing assets, icon, demo GIF
- [ ] 1.0 release
