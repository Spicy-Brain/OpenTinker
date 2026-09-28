# Changelog

## 0.3.0 (unreleased)

A rework around the Tinkerwell experience.

**Runs**

- Fresh session by default: every run starts from a freshly booted app, so re-running
  a file never fails on repeated or changed imports, redeclared functions or leftover
  state. Laravel boots once and each run forks from it (10–40 ms per run).
- Keep-session mode runs in a long-lived child process; resetting it is instant.
- Stop cancels a run without restarting PHP. Fatal errors, `exit()` in app code and
  crashes are reported cleanly instead of killing the worker.
- Optional database rollback after each run.
- `dd()` shows its values and ends the run cleanly.
- Statements are split with the app's own PHP parser: group imports, heredocs and
  closures split correctly, and syntax errors are reported with their line first.
- Plain Composer projects and custom bootstrap files are supported, not just Laravel.

**Targets**

- Saved targets (Compose, Docker, local PHP, SSH) replace the single runtime setting,
  which is migrated automatically. Targets can be set per scratch file.
- The first run detects the runtime from the Compose file (Sail and sub-folder mounts
  included) or local PHP, and only asks when there is a real choice.
- One target form with an inline connection test replaces the multi-step SSH prompts.
- Production guard: a red status bar item and scratch banner, and confirmation only
  when the code looks like it writes data or has side effects.
- Removed settings: `opentinker.transport`, `opentinker.docker.service` and
  `opentinker.ssh.workingDir` (targets replace them) and `opentinker.dumpTheme` (dumps
  follow the VS Code theme).

**Results**

- New results panel front end: model cards, tables, previews, dumps with
  expand/collapse, copy as text/JSON/PHP/CSV/Markdown, SQL with N+1 hints, errors with
  clickable app frames and hidden internals, and markers for what changed since the
  last run.
- Inline results at the end of each line.
- Results can sit beside the scratch file or in the bottom panel.
- Tinker's model and collection casters are used for dumps.

**Workflow**

- Open Tinker Window, Run Clipboard, Tinker This Model CodeLens, and a CodeLens strip
  on scratch files (run, target, session mode, rollback).
- Cmd/Ctrl+Enter only in scratch files; Cmd/Ctrl+Shift+Enter runs a selection or line
  in any PHP file; the editor run button runs scratch files.
- Snippets live in `.tinker/snippets/` as single PHP files that can be committed.
  Older `.opentinker/snippets` still load.
- Generate Model Hints for column autocomplete; Check Setup finds keymap conflicts and
  excluded scratch folders.

**Internals**

- Protocol version 2 with a handshake that reports the PHP, Laravel and PsySH versions
  and capabilities.
- The worker is split into classes under `worker/src` and built into `dist/worker.php`.
- `extension.ts` is split into a run controller, target store, session layer and UI
  modules; the results panel is a bundled, typed front end.
- Tests: unit tests for the controller, sessions, targets, guard and comparison; the
  front end in happy-dom; the real worker against Laravel and plain PHP projects; and
  a real VS Code end-to-end suite. CI runs these across PHP 8.2–8.4, Laravel 10–13 and
  PsySH before and after 0.12.22.

## Earlier unreleased work (0.2.x)

- Added SSH runtime import from OpenVSDB, with a separate Laravel execution host and path.
- Added strict host key verification, source revalidation, and production run confirmation.
- Reworked results around the displayed run: target and environment badges, reliable
  Run Again, Stop, source navigation, search, copy, collapse, and SQL summaries.
- Added distinct searchable run history, editable project snippets with parameter forms,
  runtime diagnostics, tables and CSV export, HTML/email previews, inline `//?`
  inspection, callable CodeLens actions, and Laravel log tailing.
- Added output and history retention limits and connected the VarDumper theme setting.
- Added a live Variables tab for the current PsySH session and automatic refresh after runs.
- Added active-file PHP imports for selected code and current-line runs, with import
  snapshots retained for consistent reruns.

## 0.2.0

- Runtime picker: choose a Docker Compose service, any running container, or local PHP
  from the OpenTinker sidebar, the view title, or the command palette
- New `docker exec` transport for containers that are not Compose services
- Service picker shows running/stopped state and offers to start a stopped service
- Selection is stored per workspace and restarts the session

## 0.1.0

- Tinker window: scratch files on the left, output cards on the right
- Statement-by-statement execution with `Line N` cards, values, dumps, echo output
- SQL insight via `DB::listen` on each statement
- Scratch file manager with `.gitignore` offer, sidebar view, recent runs
- Output panel toolbar: Run Again, Restart, Clear; per-file stored output
- `Ctrl+Enter` primary keybinding, CodeLens run button, `executionMode` setting

## 0.0.1

- Phase 0 scaffold: extension host, Docker Compose and local transports, persistent
  PsySH worker, HTML dumps, run selection/file commands, output webview.
