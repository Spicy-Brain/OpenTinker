# Changelog

## 0.3.0 — first public preview

OpenTinker is a scratchpad for Laravel and PHP: run code in your app's real runtime
and see what every line did.

**Runs**

- Fresh session per run: Laravel boots once and each run forks from it (10–40 ms), so
  nothing leaks between runs. Keep-session mode works like a REPL and resets instantly.
- Stop cancels a run without restarting PHP. Fatal errors, `exit()` in app code and
  crashes are reported cleanly.
- Optional database rollback after each run. `dd()` shows its values and ends the run.
- Fake side effects: mail, notifications, jobs and Laravel HTTP client calls are
  captured instead of sent, and each statement's card shows what it would have sent,
  with email previews.
- Statements are split with PHP's own parser, and syntax errors are reported with
  their line before anything runs.
- Laravel, plain Composer projects and custom bootstrap files.

**Targets**

- Docker Compose (Sail included), `docker exec`, local PHP and SSH targets, detected on
  the first run. Scratch files can remember their own target.
- One form for every kind of target, with a connection test.
- Production guard: a red status bar item and scratch banner, and confirmation before
  code that looks like it writes data or has side effects.

**Results**

- Results at the end of each line, and a card per statement with timing, SQL, N+1
  hints and a marker when the result changed since the last run.
- Eloquent model cards, tables, dumps, and previews of mailables, responses and HTML.
  Remote images in previews stay blocked until you load them.
- Copy values as text, JSON, a PHP array, CSV or a Markdown table.
- Errors lead with your scratch line; app frames open in the editor.
- A Variables tab for what a run left behind or the kept session holds.

**Workflow**

- Open Tinker Window, Run Selection or Line in any PHP file, Run Clipboard, and
  CodeLens to tinker a model or run a method (both can be turned off).
- Shareable snippets with inputs in `.tinker/snippets/`, and searchable run history.
- Generate Model Hints for column autocomplete, Check Setup, and Follow Laravel Log.
- A Get Started walkthrough for the first run.

Earlier versions (0.0.1–0.2.x) were internal previews and were not published.
