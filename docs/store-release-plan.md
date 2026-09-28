# Store release plan

OpenTinker is published by hand: this repository builds and verifies a `.vsix`, and a
maintainer uploads that file to the Visual Studio Marketplace and Open VSX from their
own machine and account. Nothing in CI publishes or holds registry credentials.

The first release goes out as a **preview** (`"preview": true` in `package.json`, shown
as a Preview badge on the listing). Reserve 1.0 for when the runtime matrix below is
fully verified.

## Status

Done:

- [x] Marketplace metadata: icon (`media/icon.png`, 256×256), gallery banner, bugs and
      homepage links, keywords, `preview`, `extensionKind`, and explicit workspace-trust
      and virtual-workspace declarations.
- [x] The VSIX is built from an allowlist (`.vscodeignore`), and
      `scripts/check-vsix.mjs` fails if a runtime file is missing or anything else is
      included.
- [x] `@types/vscode` is pinned to the `engines.vscode` floor (1.90), so the build
      can't use newer APIs by accident.
- [x] README for Marketplace readers (requirements, screenshots, privacy, limitations),
      a user-facing CHANGELOG, CONTRIBUTING.md and SECURITY.md.
- [x] Screenshots in `docs/images/`, captured from the packaged extension in a real VS
      Code against a Laravel 13 app.
- [x] CI covers PHP 8.1–8.5 with Laravel 10–13; the release workflow verifies the VSIX
      and runs the end-to-end suite against the unzipped package.
- [x] Verified locally on macOS: unit tests, worker integration (PHP 8.1, 8.4, 8.5) and
      the VS Code end-to-end suite with local PHP.

## Before the first upload

Decisions and account steps only a maintainer can do:

- [x] **Publisher ID:** `snitzle`, the Marketplace publisher that already publishes
      OpenVSDB (`snitzle.openvsdb`), so the extension ID is `snitzle.opentinker`.
      OpenTinker's SSH import finds OpenVSDB by that published ID.
- [ ] **Set up Open VSX**: sign in at <https://open-vsx.org> with GitHub, sign the
      Eclipse Publisher Agreement in your profile, create an access token, and create
      the `snitzle` namespace (OpenVSDB isn't on Open VSX yet, so it doesn't exist
      there). Open VSX shows a namespace as verified once its ownership is confirmed;
      unverified namespaces still publish.
- [ ] **Push this branch to GitHub before uploading.** The listing's images and links
      point at the repository's default branch.
- [ ] **Enable private vulnerability reporting** (repository Settings → Code security),
      which SECURITY.md relies on.
- [ ] **Check the version.** If the internal `opentinker-0.3.0.vsix` was shared with
      anyone, bump to 0.3.1 so their VS Code picks up the store build.

Runtime checks still to record (see the matrix below):

- [ ] Docker Compose target on macOS or Linux (detection, run, stop, restart).
- [ ] SSH target against a disposable host (strict host key, upload, run, stop).
- [ ] Decide whether to advertise WSL. The README currently says "use it in a WSL
      window" and calls native Windows experimental; test a WSL window before release
      or soften that line.
- [ ] Install the exact VSIX in a clean profile and check the first run, the sidebar,
      light, dark and high contrast themes, and the keyboard shortcuts.

## Runtime matrix

| Runtime                        | Status                                                 |
| ------------------------------ | ------------------------------------------------------ |
| Local PHP, macOS               | Verified (e2e suite, 2026-09-25)                       |
| Local PHP, Linux               | Covered by CI (integration and e2e on Ubuntu)          |
| Docker Compose / `docker exec` | Not yet recorded                                       |
| SSH                            | Command construction unit-tested; not yet run for real |
| WSL window (Remote - WSL)      | Not yet tested                                         |
| Native Windows PHP             | Experimental                                           |

## Building the VSIX

Either push a tag and download the artifact:

```bash
git tag v0.3.0 && git push origin v0.3.0
```

The **Release** workflow checks that the tag matches `package.json`, runs every check,
packages `opentinker-<version>.vsix`, verifies its contents, runs the end-to-end suite
against the unzipped package, and attaches the VSIX to the run as an artifact.

Or build locally (Node.js 22+):

```bash
npm ci
npm run package
node scripts/check-vsix.mjs opentinker-0.3.0.vsix
```

## Uploading

**Visual Studio Marketplace:** at <https://marketplace.visualstudio.com/manage>, open
the publisher, choose **New extension → Visual Studio Code**, and upload the VSIX. For
later versions, use **Update** on the extension's menu. Alternatively, on the
publishing machine: `npx @vscode/vsce publish --packagePath opentinker-0.3.0.vsix`
after `vsce login <publisher>`.

**Open VSX** (on the publishing machine, Node.js 22+):

```bash
npx ovsx create-namespace <publisher> -p <token>   # first release only
npx ovsx publish opentinker-0.3.0.vsix -p <token>
```

Upload the same VSIX to both registries.

## After uploading

- [ ] Open both listing pages and check the README images, links, icon and changelog.
- [ ] Install from each registry in a clean profile (VS Code, and Cursor or VSCodium
      for Open VSX) and do a first run.
- [ ] Watch issues for the first week before promoting anything beyond preview.

## Later releases

1. Update `CHANGELOG.md` and bump `version` in `package.json`.
2. Push a `v<version>` tag and download the VSIX from the Release run.
3. Upload it to both registries as above.
