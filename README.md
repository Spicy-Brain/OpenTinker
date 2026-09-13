# OpenTinker

A Tinkerwell-style scratchpad for Laravel inside VS Code. Write code on the left, get
per-statement results, dumps and SQL on the right — all running in a persistent
[PsySH](https://psysh.org) session inside your application runtime.

> Status: 0.1.0 — Tinker window with per-line cards. Snippet library, history search,
> table/email rendering and SSH live on the [roadmap](docs/roadmap.md).

## How it works

```
Scratch file (left editor)                    Output panel (right editor)
┌──────────────────────────────┐             ┌──────────────────────────────┐
│ $user = User::find(42);      │             │ Line 3  12.4 ms              │
│ $user->name;                 │  Ctrl+Enter │   = "Marcel"                 │
│ dump($user->fresh());        │────────────▶│   SELECT * FROM users …      │
│                              │             │ Line 4  0.8 ms               │
└──────────────────────────────┘             └──────────────────────────────┘
                    │
                    ▼  docker compose exec -T app php /tmp/opentinker/worker.php
        Persistent PsySH session · statement-by-statement execution · DB::listen
```

- `OpenTinker: New Scratch File` creates `.tinker/scratch-1.php` (offered to be
  gitignored), opens it on the left and the output panel on the right.
- Scratch files run statement by statement, so each line gets its own result card:
  return values, `dump()` output, `echo`, errors and SQL queries with timings.
- Variables, defines and imports persist between statements and between runs. Restart
  clears state.
- `dd()` is rewritten to `dump()` and `exit`/`die` become catchable exceptions, so a
  snippet cannot kill the session.

## Requirements

- VS Code 1.90+
- A Laravel 11+ application
- Docker Compose (default) or a local PHP binary with the app's dependencies installed

## Usage

1. Open the OpenTinker view in the activity bar (flask icon) and press **New Scratch
   File**, or run `OpenTinker: New Scratch File` from the command palette.
2. Choose where code should run: click the **Session** item in the sidebar (or run
   `OpenTinker: Select Runtime`). Pick a Docker Compose service, any running
   container, or local PHP. The choice is stored per workspace and restarts the
   session.
3. Write PHP on the left.
4. Press `Ctrl+Enter` (`Cmd+Enter` as an alternate) or click **▶ Run scratch file**
   above the file. Results appear on the right.

In regular PHP files, a selection runs as one snippet; with no selection the current
line runs.

| Command                          | Description                                      |
| -------------------------------- | ------------------------------------------------ |
| `OpenTinker: Run`                | Selection, scratch file, or current line         |
| `OpenTinker: Select Runtime`     | Pick a Compose service, container, or local PHP  |
| `OpenTinker: New Scratch File`   | Create and open the next `.tinker/scratch-N.php` |
| `OpenTinker: Open Scratch File…` | Quick pick over `.tinker/`                       |
| `OpenTinker: Restart Session`    | Kill the worker and clear state                  |
| `OpenTinker: Clear Output`       | Clear the panel view                             |
| `OpenTinker: Show Output`        | Reveal the output panel                          |

## Settings

| Setting                        | Default      | Description                                        |
| ------------------------------ | ------------ | -------------------------------------------------- |
| `opentinker.transport`         | `auto`       | `auto`, `docker-compose` or `local`                |
| `opentinker.docker.service`    | `app`        | Compose service running the app                    |
| `opentinker.docker.workingDir` | `/var/www`   | Mount path inside the container                    |
| `opentinker.php.binary`        | `php`        | PHP binary for the local transport                 |
| `opentinker.scratchDir`        | `.tinker`    | Scratch file directory                             |
| `opentinker.executionMode`     | `statements` | Per-line cards (`statements`) or one card (`file`) |
| `opentinker.timeoutMs`         | `30000`      | Snippet timeout before the session restarts        |
| `opentinker.dumpTheme`         | `dark`       | `dark` or `light` VarDumper theme                  |

### Keybinding conflicts

The IntelliJ IDEA Keybindings extension maps `Cmd+Enter` in editors, so `Ctrl+Enter` is
the primary binding. If anything still steals a shortcut, override it in
`keybindings.json`:

```json
{
    "key": "ctrl+enter",
    "command": "opentinker.run",
    "when": "editorTextFocus && editorLangId == php"
}
```

## Development

```bash
npm install
npm run watch      # esbuild in watch mode
# press F5 to launch the Extension Development Host
```

Useful scripts: `npm run typecheck`, `npm run lint`, `npm test`, `npm run package`.

## Security

OpenTinker executes arbitrary PHP in your application context. It refuses to run in
untrusted workspaces and never auto-runs snippets. Treat a session with the same care
as `php artisan tinker`.

## License

MIT
