# OpenTinker

A Tinkerwell-style scratchpad for Laravel and PHP inside VS Code. Write code in a
scratch file, press **Cmd/Ctrl+Enter**, and see what every line did: values at the end
of each line, and a results panel with model cards, tables, dumps, SQL and errors.
Code runs in your app's real runtime: Docker, local PHP or SSH.

> Status: 0.3.0, not yet published. See the [roadmap](docs/roadmap.md).

## Getting started

1. Open your project and run **OpenTinker: Open Tinker Window** (the flask icon in the
   activity bar, or the command palette). It opens a scratch file on the left and
   results on the right.
2. Write PHP and press **Cmd+Enter** (macOS) or **Ctrl+Enter**, or click **▶ Run**:
   the orange button at the left of the status bar, the button at the top right of the
   editor, or the Run button in the results panel.

The first run finds where your app runs by itself. It reads your Compose file
(including Sail, and projects that mount sub-folders such as `./app`), checks which
services are running, and falls back to local PHP (Herd, Valet or Homebrew). It only
asks when there is more than one real option. The chosen target shows in the status
bar; click it to change.

```
.tinker/scratch-1.php                         OpenTinker · scratch-1.php
┌──────────────────────────────────────┐     ┌───────────────────────────────────┐
│ ▶ Run  ⌂ app · local  Fresh  Rollback│     │ LOCAL  app ▾  Fresh session       │
│ use App\Models\User;                 │     │ Line 3  $user = User::first();    │
│ $user = User::first();  = User #1    │     │   User #1 · users                 │
│ $user->posts()->count(); = 12        │     │   name   Ada Lovelace             │
│                                      │     │   SQL 1 query · 0.4 ms            │
└──────────────────────────────────────┘     └───────────────────────────────────┘
```

## How runs work

- **Fresh by default.** Every run starts from a freshly booted app, like running a
  script. Nothing carries over: variables, imports, functions or classes you declare,
  or changes to the service container. Laravel boots once and each run forks from it,
  so a run typically takes 10–40 ms.
- **Keep session** (status bar, CodeLens or panel toggle) makes variables carry over
  between runs, like `artisan tinker`. **Reset session** clears it instantly.
- **Stop** ends a run right away, and the app stays booted for the next run.
- **Roll back database changes** (toggle) runs code in a transaction and undoes it,
  so you can try `update()` or `delete()` safely. Mail, queues, files and external
  calls are not rolled back.
- `dd()` shows its values and ends the run cleanly. So do `exit()` and `die`, including
  when they come from app code.

## Results

- **Inline results** at the end of each line: the value it returned, `dump()`
  output, or the error in red. Hover for the full text. Edits move or clear them.
- **Result cards** in source order, one per statement. Each card shows its timing,
  query count and whether the result changed since the last run of the file.
- **Eloquent models** render as cards: attributes with casts, hidden fields, loaded
  relations and unsaved changes. Switch to the raw dump at any time.
- **Tables** for collections and lists of arrays, with filtering.
- **Copy** any value as text, JSON, a PHP array, CSV or a Markdown table.
- **SQL** per statement with bindings and timings. Repeated query shapes are flagged
  as a possible N+1.
- **Errors** lead with the message and your scratch line. App frames open in the
  editor; vendor frames are collapsed and PsySH/OpenTinker internals are hidden.
- **HTML, mailables and HTTP responses** preview in a sandboxed frame.
- **Variables** tab: what the last run left behind, or the kept session's variables.
- End a line with `//?` to show that value inline even when it is not the last
  statement.

Results open beside the scratch file by default. Set `opentinker.results.location` to
`panel` to put them in the bottom panel next to Terminal.

## Running code from anywhere

- **Cmd/Ctrl+Shift+Enter** runs the selection, or the current line, in any PHP file.
  Earlier top-level `use` statements from that file are applied without running the
  rest of it.
- **Tinker this model** (CodeLens on Eloquent models) opens a scratch file that loads
  the model and runs it.
- **Run method / Run function** (CodeLens) calls public methods and functions that
  take no required arguments.
- **OpenTinker: Run Clipboard** runs whatever you copied.
- **Snippets** are PHP files in `.tinker/snippets/` with a small header, so a team can
  commit and share them. Inputs such as `{{userId:number}}`, `{{email}}`,
  `{{active:bool}}` and `{{payload:json}}` open a form before the snippet runs.

## Targets

A target is a saved place to run code: a **Docker Compose** service, a **Docker
container**, **local PHP**, or an **SSH** server. Each target has a name, the project
path inside the runtime, an optional PHP binary and bootstrap, and a declared
environment. Manage targets with **OpenTinker: Choose Target…**; the gear opens a
single form with a **Test connection** button.

Scratch files can remember their own target (**Choose Target for This File…**), so a
production scratch and a local scratch can be open side by side. The CodeLens on line
1 always shows which target a file runs on.

### Production safety

A target counts as production when the app reports `APP_ENV=production` or the target
is declared as production. Then:

- the status bar item turns red, and scratch files get a red **PRODUCTION** band on
  line 1;
- runs ask first when the code looks like it changes data or has side effects (saves,
  updates, deletes, jobs, mail, Artisan commands, cache and file writes). Set
  `opentinker.production.confirm` to `always` or `never` to change this.

### SSH

OpenTinker uses the system `ssh` command with key or agent authentication and strict
host key checking. It never accepts a new host key automatically, so connect once in a
terminal first. It uploads its worker to a private folder under the remote user's home.
SSH details can be imported from a compatible OpenVSDB extension; imported targets are
re-checked against OpenVSDB before every run. A database tunnel host is often only a
bastion, so set the host that actually runs the app.

### Other frameworks and plain PHP

The worker boots Laravel when `bootstrap/app.php` exists and otherwise loads Composer's
autoloader. For other frameworks, set the target's (or `opentinker.bootstrap`)
bootstrap to a PHP file that boots your app. PsySH must be installed
(`composer require --dev psy/psysh`; Laravel apps get it from `laravel/tinker`).

## Autocomplete in scratch files

Scratch files are ordinary PHP files, so Intelephense and other PHP extensions complete
them. **OpenTinker: Generate Model Hints** writes `.tinker/_ide_helper_models.php`
from your database schema, so `$user->` completes real columns. It uses the same
approach as `barryvdh/laravel-ide-helper`. **Check Setup** warns if Intelephense
excludes the scratch folder.

## Commands

| Command                              | What it does                                          |
| ------------------------------------ | ----------------------------------------------------- |
| Open Tinker Window                   | Latest scratch file on the left, results on the right |
| Run (Cmd/Ctrl+Enter in scratch)      | Run the scratch file, or the selection                |
| Run Selection or Line (+Shift)       | Run the selection or current line of any PHP file     |
| Run Clipboard                        | Run the clipboard contents                            |
| Stop Run                             | Stop the current run; the app stays booted            |
| Choose Target… / … for This File     | Pick, detect, add or edit targets                     |
| Toggle Fresh / Keep Session          | Switch how runs share state                           |
| Toggle Database Rollback             | Roll back database changes after each run             |
| Reset Kept Session                   | Clear the kept session's variables                    |
| New Scratch File / Open Scratch File | Scratch files live in `.tinker/`                      |
| Save Snippet / Run Snippet…          | Shareable snippets in `.tinker/snippets/`             |
| Search Run History                   | Search earlier runs by code, file, target or env      |
| Generate Model Hints                 | Column autocomplete for Eloquent models               |
| Follow Laravel Log                   | Tail the newest log file in an output channel         |
| Check Setup                          | Test the target and look for common problems          |

## Settings

| Setting                             | Default      | Description                                                  |
| ----------------------------------- | ------------ | ------------------------------------------------------------ |
| `opentinker.session.mode`           | `fresh`      | `fresh`: each run starts clean. `keep`: variables carry over |
| `opentinker.database.rollback`      | `false`      | Roll back database changes after each run                    |
| `opentinker.production.confirm`     | `writes`     | When to confirm production runs: `writes`, `always`, `never` |
| `opentinker.results.location`       | `beside`     | `beside` the scratch file or in the bottom `panel`           |
| `opentinker.inlineResults`          | `true`       | Show results at the end of each line                         |
| `opentinker.bootstrap`              | `auto`       | `auto`, `laravel`, `composer` or a bootstrap file path       |
| `opentinker.timeoutMs`              | `30000`      | Stop runs after this long (0 disables)                       |
| `opentinker.executionMode`          | `statements` | A card per statement, or one card for the whole file         |
| `opentinker.scratchDir`             | `.tinker`    | Scratch folder (snippets live in its `snippets/` folder)     |
| `opentinker.docker.workingDir`      | `/var/www`   | Default project path for new container targets               |
| `opentinker.php.binary`             | `php`        | PHP binary for local targets                                 |
| `opentinker.ssh.phpBinary`          | `php`        | PHP binary on SSH targets                                    |
| `opentinker.maxOutputBytes`         | `2097152`    | Output kept per run                                          |
| `opentinker.history.maxEntries`     | `50`         | Runs kept in history                                         |
| `opentinker.history.persistResults` | `false`      | Keep results across reloads (they may contain app data)      |

### Keyboard shortcuts

Cmd/Ctrl+Enter is bound only in scratch files, and Cmd/Ctrl+Shift+Enter in any PHP
file. Other keymap extensions can take these keys (the IntelliJ IDEA keymap binds
Cmd/Ctrl+Enter to "insert line break"). **Check Setup** detects this and copies a
keybinding for you to paste into `keybindings.json`:

```json
{
    "key": "cmd+enter",
    "command": "opentinker.run",
    "when": "editorTextFocus && opentinker.isScratch"
}
```

The Xdebug extension's "Run PHP File" button runs host PHP without your app. In scratch
files, OpenTinker adds its own Run button to the editor toolbar and is also the first
entry in the editor's run menu.

## Development

```bash
npm install
npm run watch        # extension, results front end and dist/worker.php
# press F5 to launch the Extension Development Host
```

| Script                                                      | What it checks                                   |
| ----------------------------------------------------------- | ------------------------------------------------ |
| `npm run typecheck`, `npm run lint`, `npm run format:check` | Types (extension and front end), lint, format    |
| `npm test`                                                  | Unit tests, including the front end in happy-dom |
| `php test/workerFeatures.php`                               | Worker transforms without an app                 |
| `php test/integration/worker.php --base-path=/path/to/app`  | The real worker against an app                   |
| `node test/e2e/run.mjs /path/to/throwaway-app --reset`      | A real VS Code driving the extension             |

`test/integration/worker.php` also accepts `--command="docker compose exec -T app php
/tmp/worker.php --base-path=/var/www"` and `--no-writes` for a real database. The
end-to-end suite writes settings, scratch files and a rolled-back row into the app it
is given, so only point it at a throwaway app.

Code layout: [`src/run`](src/run) holds the run controller (states, stop, timeouts,
production guard, comparison), [`src/targets`](src/targets) targets and detection,
[`src/session`](src/session) the worker session and transports, [`src/ui`](src/ui) the
VS Code surfaces, [`src/webview/results`](src/webview/results) the results front end,
and [`worker/`](worker) the PHP worker. The [protocol](docs/protocol.md) connects them.

## Security

OpenTinker runs arbitrary PHP in your application, with the same power as
`php artisan tinker`. It refuses to run in untrusted workspaces and never runs code
without an explicit action. Result history stays in workspace storage, and keeping
results across reloads is off by default.

## License

MIT
