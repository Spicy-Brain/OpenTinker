# Worker protocol

OpenTinker communicates with the PHP worker over newline-delimited JSON (NDJSON) on
stdin/stdout. Every frame is a single-line JSON object. UTF-8 only; decoders must
tolerate `\r\n` so Windows/WSL transports can be added without changes.

## Lifecycle

1. The extension spawns the worker and waits for a `ready` frame (15s timeout).
2. An `exec` request runs a snippet. In `statements` mode the worker splits it into
   top-level statements and executes them one by one in the same PsySH scope.
3. Streaming frames (`output`, `dump`, `value`, `error`) carry `stmt` (1-based
   statement index) and `line` (source line) so the panel can group them into cards.
4. Each statement is finalized with a `statement` frame. The run ends with a `result`
   frame, which is the only terminal frame (besides `pong`).
5. `shutdown` asks the worker to exit; the extension kills the process if it does not
   exit promptly.

## Requests (extension → worker)

| Frame      | Fields               | Notes                                 |
| ---------- | -------------------- | ------------------------------------- |
| `exec`     | `id`, `code`, `mode` | `mode` is `statements` or `file`      |
| `scope`    | `id`                 | Returns the current session variables |
| `ping`     | `id`                 | Liveness check                        |
| `shutdown` | —                    | Graceful exit                         |

## Frames (worker → extension)

| Frame       | Fields                                                                            | Notes                                     |
| ----------- | --------------------------------------------------------------------------------- | ----------------------------------------- |
| `ready`     | `php`, `laravel`, `env`, `basePath`, `pid`                                        | Sent once after Laravel boots             |
| `output`    | `id`, `text`, `stmt`, `line`                                                      | `echo`, warnings, PsySH text              |
| `dump`      | `id`, `html`, `stmt`, `line`                                                      | Streaming `dump()` output                 |
| `value`     | `id`, `html`, `stmt`, `line`                                                      | Statement value, rendered with HtmlDumper |
| `error`     | `id`, `stmt`, `line`, `errorClass`, `message`, `file`, `errorLine`, `trace`, `ms` | Statement failed; execution halts         |
| `statement` | `id`, `stmt`, `line`, `ok`, `ms`, `memory`, `exit?`, `queries?`                   | Finalizes one card                        |
| `result`    | `id`, `ok`, `failed`, `statements`, `ms`, `memory`                                | Terminal frame for a run                  |
| `scope`     | `id`, `vars[]`                                                                    | `{ name, html }` entries, capped at 50    |
| `pong`      | `id`                                                                              | Reply to `ping`                           |
| `fatal`     | `message`                                                                         | Boot failure or worker crash              |

`queries` entries are `{ sql, bindings: string[], time: number|null }`, captured with
`DB::listen` between statement boundaries (max 50).

## Execution semantics

- `use` statements are executed on their own and persist through PsySH's
  `UseStatementPass`; they do not produce cards.
- Statement splitting falls back to executing the whole snippet as one statement when
  the tokenizer sees constructs it cannot split safely (alternative syntax, inline
  HTML, `declare`, `namespace`, `<?=`). A note is emitted as an `output` frame.
- A thrown error stops the run; the `result` frame has `failed: true`.
- PsySH's `NoReturnValue` marker is suppressed, so statements without a value produce
  no `value` frame.

## Code rewriting

The worker rewrites two language constructs before evaluation so they cannot terminate
the process:

- `dd(...)` (including `\dd(...)`) → `dump(...)`
- `exit` / `die`, with or without an expression → `throw new \OpenTinker\ExitCalledException(...)`

`<?php` and `?>` tags are stripped.

## Transports

The protocol is transport-agnostic. Current implementations:

- `docker compose exec -T <service> php /tmp/opentinker/worker.php --base-path=<dir>`
- `php <storage>/worker.php --base-path=<workspace>`

WSL transport requirements and path translation are described in
[wsl-support.md](wsl-support.md).
