# Contributing

Thanks for helping with OpenTinker. Bug reports with the output of **OpenTinker: Check
Setup** and the **OpenTinker** output channel are the most useful thing you can send.

## Setup

You need Node.js 22 or later and PHP 8.2 or later with Composer.

```bash
npm install
npm run watch        # extension, results front end and dist/worker.php
# press F5 to launch the Extension Development Host
```

## Checks

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
is given, so only point it at a throwaway app:

```bash
composer create-project laravel/laravel /tmp/ot-app
cd /tmp/ot-app && php artisan migrate --force && cd -
node test/e2e/run.mjs /tmp/ot-app --reset
```

CI runs all of these on every push, across PHP 8.2–8.5, Laravel 10–13 and PsySH
before and after 0.12.22.

## Code layout

- [`src/run`](src/run): the run controller (states, stop, timeouts, production guard,
  comparison).
- [`src/targets`](src/targets): targets and runtime detection.
- [`src/session`](src/session): the worker session and its transports (local, Docker
  Compose, docker exec, SSH).
- [`src/ui`](src/ui) and [`src/views`](src/views): the VS Code surfaces.
- [`src/webview/results`](src/webview/results): the results front end, bundled on its
  own and tested in happy-dom.
- [`worker/`](worker): the PHP worker. `scripts/build-worker.mjs` joins its classes into
  `dist/worker.php`, which the extension copies into each runtime.

The [protocol](docs/protocol.md) connects the extension and the worker; bump
`PROTOCOL_VERSION` on both sides when it changes.

## Pull requests

- Keep changes focused, and add or update tests for behaviour changes.
- Run `npm run format` before committing; CI checks formatting.
- Worker changes should keep working on the oldest PHP version in the CI matrix.

## Releases

See [docs/store-release-plan.md](docs/store-release-plan.md). Pushing a `v*` tag runs
the release workflow, which verifies and packages the VSIX without publishing it.
