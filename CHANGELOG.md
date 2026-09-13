# Changelog

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
