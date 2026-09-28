# WSL support plan

Most of the team runs Windows + WSL, so OpenTinker must work in all three common
setups. This document designs the transport work required and the test matrix to
validate it.

## Scenarios

| #   | Setup                                                         | Extension host     | Project path                           | Docker                                                    | Work required                                |
| --- | ------------------------------------------------------------- | ------------------ | -------------------------------------- | --------------------------------------------------------- | -------------------------------------------- |
| A   | VS Code + Remote - WSL, project inside the distro             | Linux (inside WSL) | `/home/user/app`                       | Docker Desktop WSL integration or Docker Engine in distro | Verify only; existing transports should work |
| B   | VS Code on Windows, folder opened via UNC path                | Windows            | `\\wsl.localhost\Ubuntu\home\user\app` | Docker Desktop (Windows)                                  | `WslTransport` + path translation            |
| C   | VS Code + Remote - WSL, Docker only available on Windows side | Linux (inside WSL) | `/home/user/app`                       | `docker.exe` via interop                                  | Fallback command resolution                  |

Scenario A is the lowest-effort and should be verified first because it likely covers
the majority of the office. Scenario B is where the real engineering is.

## Scenario A — Remote-WSL (priority 1)

When VS Code uses Remote - WSL, the extension host already runs inside the distro, so
`docker` and `php` are Linux binaries and the existing transports work. Work items:

- Assert the environment in the worker handshake (`php_uname('s')`, `docker --version`)
  so support requests include the right context.
- Handle a workspace opened at `/mnt/c/...` (Windows filesystem) as well as `/home/...`;
  no path translation is needed inside the host, but inotify/file-watching is degraded
  on DrvFs and should not be relied on.
- Verify `docker compose exec` from a WSL-hosted extension against Docker Desktop's WSL
  integration and against a distro-installed Docker Engine.
- Verify the output webview and `dump()` rendering with UTF-8 and emoji output.

No worker changes expected beyond telemetry in the ready frame.

## Scenario B — Windows-hosted extension over UNC (priority 2)

`WslTransport implements Transport` uses `wsl.exe` as the process launcher. The worker
still runs inside the distro; only the transport changes.

### Spawning

```
wsl.exe --distribution <distro> --cd <linux-cwd> --exec <program> <args...>
```

- `--exec` bypasses the login shell banner, which would otherwise corrupt the NDJSON
  stream. Fall back to `-- sh -c 'cd <cwd> && exec <program> <args>'` on older builds
  where `--cd` is unavailable.
- Prefer `--distribution` by name; expose `opentinker.wsl.distro` and default to the
  `WSL_DISTRO_NAME` environment variable when set, otherwise the default distro from
  `wsl.exe --list --quiet`.
- Detect the mode with `vscode.env.remoteName`:
    - `wsl` → extension host is inside the distro (Scenario A).
    - undefined + Windows + UNC workspace path → Scenario B.

### Path translation

| Windows path                             | Linux path         |
| ---------------------------------------- | ------------------ |
| `\\wsl.localhost\<distro>\home\user\app` | `/home/user/app`   |
| `\\wsl$\<distro>\home\user\app`          | `/home/user/app`   |
| `C:\Users\...`                           | `/mnt/c/Users/...` |

Implement a single `toWslPath(uri, distro): string` helper with unit tests. URI authority
carries the distro name for `\\wsl.localhost\...` paths; VS Code may hand the extension
`vscode.Uri` with `scheme: 'vscode-remote'` or `'file'` depending on version, so handle
both.

### Worker delivery

Same approach as Docker Compose: write the worker through a one-shot WSL command that
runs `buildContainerUploadCommand` (`src/session/sshArgs.ts`), so it lands in the
private per-user `/tmp/opentinker-<uid>/` directory:

```
wsl.exe -d <distro> --exec sh -c "<buildContainerUploadCommand(hash)>"
```

with the worker source on stdin. Hash the source and skip the write when unchanged
(implemented once for all transports in `ensureWorker`).

### Encoding and line endings

- Set `WSL_UTF8=1` in the child environment; otherwise `wsl.exe` may emit UTF-16LE
  output on Windows and the JSON decoder will see interleaved null bytes.
- `wsl.exe` can translate `\n` to `\r\n` on stdio. `LineDecoder` already strips `\r`
  (see `test/protocol.test.ts`); keep that guarantee under test.
- Never rely on `process.cwd()` for the worker directory — always pass
  `--base-path=<linux path>` explicitly.

### Docker resolution inside the transport

1. If `docker` resolves inside the distro (`wsl.exe ... --exec sh -c "command -v docker"`)
   use `wsl.exe -d <distro> --cd <linux-cwd> --exec docker compose ...`.
2. Otherwise try `docker.exe` through Windows interop. Note that a Windows Docker
   Desktop mount must also expose the project path; surface a clear error frame when it
   does not (`docker: invalid mount path`).
3. Surface a "Docker is not available in <distro>" message with a link to enable WSL
   integration in Docker Desktop settings.

## Scenario C — Remote-WSL with Windows-only Docker

The transport runs inside WSL but invokes `docker.exe`. Paths passed to `docker.exe`
must be Windows paths for bind mounts, while the compose file itself is in the distro.
This mostly works because Docker Desktop handles the translation. Work items:

- Detect `docker.exe` availability when `docker` is missing.
- Document the performance caveat (project files cross the 9p boundary).
- Add a health check that fails fast with an actionable message.

## Configuration additions

| Setting                       | Default | Description                                                    |
| ----------------------------- | ------- | -------------------------------------------------------------- |
| `opentinker.wsl.distro`       | `auto`  | Distro name, or `auto` to detect                               |
| `opentinker.wsl.mode`         | `auto`  | `auto`, `remote` (host inside distro), `unc` (host on Windows) |
| `opentinker.wsl.dockerBinary` | `auto`  | `docker`, `docker.exe`, or an absolute path                    |

## Milestones

| Step | Work                                                                                     | Estimate |
| ---- | ---------------------------------------------------------------------------------------- | -------- |
| W1   | Scenario A verification, health-check frames, docs                                       | 2–3 days |
| W2   | `toWslPath` helper + unit tests, distro detection, `WslTransport` for local PHP over UNC | 3–4 days |
| W3   | Docker resolution over WSL (Docker Desktop integration, `docker.exe` fallback)           | 2–3 days |
| W4   | Manual test matrix, error messaging, README updates                                      | 2 days   |

Total: roughly 1.5–2 weeks, sequenced after the SSH transport (roadmap Phase 5).

## Test matrix

| Windows | Distro       | VS Code mode        | Docker                     | Expected transport               |
| ------- | ------------ | ------------------- | -------------------------- | -------------------------------- |
| 11      | Ubuntu 24.04 | Remote - WSL        | Docker Desktop integration | `docker-compose` (inside distro) |
| 11      | Ubuntu 24.04 | Remote - WSL        | Docker Engine in distro    | `docker-compose` (inside distro) |
| 11      | Ubuntu 24.04 | Windows, UNC folder | Docker Desktop             | `wsl` + compose                  |
| 11      | Ubuntu 24.04 | Windows, UNC folder | none                       | `wsl` + local PHP                |
| 11      | Debian 12    | Remote - WSL        | Docker Desktop             | `docker-compose` (inside distro) |

Each run should confirm: ready handshake, `dump()` rendering, `exit` interception,
timeout kill/restart, and UTF-8 output.

## Risks

- `wsl.exe` stdio encoding varies by Windows build — pinned by `WSL_UTF8=1` plus
  decoder tolerance tests.
- UNC workspaces have slower file operations; avoid per-request worker rewrites.
- Docker Desktop's WSL integration can be enabled per distro; error messages must say
  exactly which distro is missing it.
- `vscode.env.remoteName` and URI shapes change between VS Code releases; keep
  detection isolated in one module with unit tests.
