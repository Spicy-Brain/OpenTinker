# Worker protocol (version 2)

OpenTinker talks to its PHP worker over newline-delimited JSON on stdin/stdout. Every
frame is one JSON object on one line, UTF-8. The worker starts every frame on a fresh line,
so bytes that bypass the protocol (a byte-order mark in an app file, `fwrite(STDOUT)`, a
child killed mid-write) end up on a line of their own instead of corrupting a frame.
Decoders skip empty lines, treat other non-JSON lines as stray output, and tolerate `\r\n`.

The TypeScript types in [`src/shared/protocol.ts`](../src/shared/protocol.ts) are the
reference. `PROTOCOL_VERSION` there must equal `Protocol::VERSION` in
[`worker/src/Protocol.php`](../worker/src/Protocol.php); a unit test checks this, and
the extension refuses a worker that reports a different version.

## Process model

```
extension ──stdin/stdout──▶ worker (boots the app once, stays pristine)
                              ├─ fork per run ──▶ fresh child: runs code, exits
                              └─ fork once ─────▶ kept-session child: runs code, stays
```

- The worker boots the project once (Laravel, plain Composer, or a custom bootstrap
  file) and never runs user code itself. If a child cannot be forked, the run fails with
  an error instead of running in the worker. Output printed while booting is captured and
  sent as an `output` frame.
- **Fresh runs** (`fresh: true`, the default) fork a child per run. The child starts
  from the booted app and is thrown away afterwards, so nothing leaks between runs:
  variables, imports, declared functions and classes, or container state.
- **Kept-session runs** (`fresh: false`) go to one long-lived child, so variables
  carry over. `reset` kills that child; Laravel does not boot again.
- While a child runs, the worker watches stdin. `cancel` with the running run's id kills
  the child and the worker stays warm; a late `cancel` for an earlier run is ignored. Other
  requests wait in a queue; `ping` is answered immediately.
- `modelHints` also runs in a throwaway child, so a model file with a fatal error cannot
  take the worker down.
- On end of input, `shutdown`, `SIGTERM`, `SIGHUP` or `SIGINT` the worker kills its
  children before exiting.
- If a child dies without finishing (a fatal error, `exit()` in app code, a kill), the
  worker reports it from the child's error log. The first logged fatal is used, because
  later ones come from shutdown handlers.
- Without `pcntl` (native Windows PHP) runs happen in the worker process. The extension
  restarts the worker before each fresh run instead.
- Database and Redis connections are closed before forking so parent and child never
  share a socket. Forked children exit with `SIGKILL`, which skips shutdown handlers
  inherited from the app, and they swap Laravel's exception handler for one that
  reports without writing to the console. Each child reseeds `mt_rand()`.
- PsySH's config, data and runtime directory, and the children's error logs, live in a
  fresh private directory (mode 0700, random name) created at boot and removed on exit.
  Nothing is read from a predictable path in the shared temp dir.

The extension uploads the worker to `/tmp/opentinker-<uid>/` inside containers (a
directory that must be owned by that user and not be a symlink) and to `~/.opentinker/`
over SSH, both through a private temporary file.

## Requests (extension → worker)

| Request      | Fields                                                | Notes                                              |
| ------------ | ----------------------------------------------------- | -------------------------------------------------- |
| `exec`       | `id`, `code`, `mode`, `fresh`, `rollback`, `imports?` | Runs code; see below                               |
| `cancel`     | `id`                                                  | Stops the running run with that id; others ignored |
| `reset`      | `id`                                                  | Clears the kept session (`ok: false` without fork) |
| `scope`      | `id`                                                  | Variables in the kept session                      |
| `imports`    | `id`, `source`, `line`                                | Top-level `use` statements visible at `line`       |
| `modelHints` | `id`                                                  | IDE stub describing each model's columns           |
| `log`        | `id`                                                  | Last 200 lines of the newest `storage/logs` file   |
| `ping`       | `id`                                                  | Liveness; the reply repeats the handshake          |
| `shutdown`   | —                                                     | Graceful exit                                      |

`mode` is `statements` (split into top-level statements, one card each) or `file` (one
card). `rollback: true` wraps the run in a transaction on the default database
connection and rolls it back, including nested transactions (see below).

## Frames (worker → extension)

| Frame         | Fields                                                                                                   | Notes                                         |
| ------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `ready`       | `protocol`, `php`, `framework`, `laravel`, `psysh`, `env`, `basePath`, `pid`, `capabilities`             | Handshake after boot                          |
| `output`      | `id`, `text`, `stmt`, `line`                                                                             | `echo`, PHP warnings and PsySH text           |
| `dump`        | `id`, `html`, `short`, `stmt`, `line`, views                                                             | Each `dump()` argument                        |
| `value`       | `id`, `html`, `short`, `stmt`, `line`, views                                                             | A statement's returned value                  |
| `inline`      | `id`, `stmt`, `line`, `text`, `html`                                                                     | Value requested by a trailing `//?`           |
| `error`       | `id`, `stmt`, `line`, `errorClass`, `message`, `scratchLine`, `file`, `errorLine`, `frames[]`, `ms`      | A statement failed; the run stops             |
| `statement`   | `id`, `stmt`, `line`, `endLine`, `ok`, `ms`, `memory`, `short?`, `exit?`, `import?`, `queries[]`, `sql`  | Finalises one card                            |
| `scope`       | `id`, `vars[]`, `truncated?`                                                                             | Sent before `result` with the run's variables |
| `result`      | `id`, `ok`, `failed`, `statements`, `ms`, `memory`, `rolledBack?`, `ended?`, `stopped?`, `sessionReset?` | Last frame of a run                           |
| `pong`        | `id` + the handshake fields                                                                              | Reply to `ping`                               |
| `reset`       | `id`, `ok`                                                                                               | Reply to `reset`                              |
| `imports`     | `id`, `statements[]`                                                                                     | Reply to `imports`                            |
| `modelHints`  | `id`, `php`, `count`, `skipped[]`                                                                        | Reply to `modelHints`                         |
| `log`         | `id`, `path`, `lines`                                                                                    | Reply to `log`                                |
| `unsupported` | `id`, `request`                                                                                          | Unknown request type                          |
| `fatal`       | `message`                                                                                                | The worker could not boot                     |

`capabilities` is `{ fork, parser, database }`. `framework` is `laravel`, `composer` or
`custom`. `short` is a one-line summary used for inline editor results and run
comparison.

**Views** on `dump` and `value` frames are optional and bounded. `html` cuts strings
after 100,000 characters and falls back to a compact rendering above 1 MB. Generators,
`LazyCollection`s, cursors and other iterators are shown by type: nothing counts or
iterates them, since that would run their source and use them up.

- `table`: up to 500 rows, 30 columns and 500 KB of cells for lists of arrays,
  Arrayables or objects.
- `preview`: up to 200 KB of HTML from a Mailable, an HTML HTTP response, an Htmlable,
  or a string that starts with an HTML tag. Shown in a sandboxed iframe.
- `model`: an Eloquent model card with class, key, table, attributes (value, type,
  cast, hidden, dirty), loaded relations and unsaved changes.
- `copy`: `json` and `php` (short array syntax) renderings, each up to 200 KB; larger
  values get none rather than a partial copy.

**Errors** carry `frames[]` of `{ file, line, call, kind }` where `kind` is `scratch`,
`app`, `vendor` or `internal`. PsySH, php-parser and OpenTinker frames are removed.
Frames in eval'd code map to `scratchLine`, the statement's line in the scratch file
(PsySH pretty-prints code before running it, so finer positions are not reliable).

**SQL**: `queries[]` lists up to 100 `{ sql, bindings, time }` per statement, with SQL cut
at 10,000 characters and up to 100 bindings of 1,000 characters each. `sql` is
`{ total, time, repeated[] }`, where `repeated` lists query shapes that ran three or
more times, a likely N+1.

## Execution semantics

- Statements are split with the app's own php-parser (a PsySH dependency), so every PHP
  construct splits correctly and a syntax error is reported with its line before
  anything runs. A final expression without a semicolon is accepted, as in PsySH.
  Files containing `namespace`, `declare`, inline HTML or `__halt_compiler` run as one
  card. A tokenizer fallback is used only if php-parser is missing.
- `use` statements run on their own and produce no card unless they fail.
- `dd()` in the scratch file dumps each argument and ends the run cleanly
  (`ended: 'dd'`). `exit`/`die` in the scratch file are rewritten the same way; a bare
  `exit` takes no argument. They throw an `Error`, so `catch (Exception)` in scratch code
  does not stop them, and one caught by `catch (Throwable)` still ends the run after that
  statement. `exit()` in app or vendor code ends a fresh run with `ended: 'exit'`.
- PHP warnings and notices raised by a run are sent as `output` frames. Deprecations are
  not shown, so vendor deprecations on new PHP versions do not flood the results.
- `rollback: true` begins the transaction before anything runs; if it cannot begin, the
  run fails and nothing runs. Afterwards it rolls back to where the run started, on the
  same connection, and reports `rolledBack: false` (with an `output` notice) when that
  cannot be promised: the run ended the transaction itself (`DB::commit()`, a
  disconnect) or the database committed implicitly (a schema change on MySQL).
- Kept sessions tolerate re-declared imports: PsySH 0.12.22+ rejects a second `use`
  of an alias, so the worker drops imports the session already has with the same
  target. Changing what an alias points to needs a fresh run or a reset.
- A selection or line from a regular PHP file can carry `imports` extracted from that
  file (top-level `use` statements only, excluding trait uses and closure captures).

## Worker source

The worker is written as separate classes in [`worker/src`](../worker/src) plus
[`worker/main.php`](../worker/main.php). `scripts/build-worker.mjs` concatenates them
into `dist/worker.php`, one braced `namespace OpenTinker { … }` block per file, which
the extension uploads to each runtime. Classes that extend host-app classes are
declared in `main.php` after the autoloader loads.
