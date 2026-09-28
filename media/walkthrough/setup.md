# Check your setup

**OpenTinker: Check Setup** starts the worker on your target and writes a report to the
OpenTinker output channel:

```text
OpenTinker setup check

✓ Workspace is trusted
✓ Target: app (compose · app)
  ✓ Connected in 0.8 s
  PHP 8.4.12 · Laravel 12.28.1 · PsySH v0.12.24
  APP_ENV: local
  Project: /var/www
  Fresh sessions: fast (each run forks from the booted app)
  Database: available (rollback supported)
✓ Intelephense indexes scratch files
```

It also spots keymap extensions that take **Cmd/Ctrl+Enter**, and copies a keybinding
for you to paste into `keybindings.json`.

Include this report when you [open an issue](https://github.com/Spicy-Brain/OpenTinker/issues).
