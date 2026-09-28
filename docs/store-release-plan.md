# Store release plan

This is the release checklist for the first public OpenTinker build. The first
submission should be a pre-release while the runtime compatibility matrix is being
verified; reserve 1.0 for the tested support promise.

## Current position

- `package.json` has a publisher ID, version, description, categories, repository,
  VS Code engine range, build hook, and MIT license. `vsce ls --no-dependencies`
  currently includes the manifest, README, license, worker, activity-bar SVG, and
  bundled JavaScript.
- The activity-bar SVG is suitable for the VS Code UI. The Marketplace listing still
  needs a separate PNG icon of at least 128×128 pixels; Marketplace package icons
  cannot be SVGs. A screenshot or short demo and a concise first-run guide are also
  needed. [VS Code publishing guidance](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- `.github/workflows/release.yml` currently publishes on every `v*` tag with no
  verification job, uses `npm install`, depends on an unpinned `npx ovsx`, and uses
  a Marketplace PAT. Microsoft's current guidance recommends Entra ID-based
  publishing and states that global Azure DevOps PATs retire on 1 December 2026.
  [VS Code publishing guidance](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- The repository has no Laravel fixture or VS Code extension-host integration test.
  Pure PHP worker checks and TypeScript tests pass, but local, Docker, SSH, and UI
  workflows still need real-app smoke tests.

## Gate 1: Product and runtime verification

1. Build a small, disposable Laravel fixture with a model, migration, Mailable,
   HTML response, and log output. Exercise selection, current line, scratch, Run
   File, imports and aliases, variables, SQL, table/CSV, preview, stop, restart,
   history, snippets, and production confirmation.
2. Run the fixture on the PHP/Laravel versions we promise to support. Record the
   exact combinations that passed; adjust README requirements to match evidence.
3. Smoke-test local PHP and Docker Compose on macOS and Linux, plus SSH against a
   disposable host. Test VS Code Remote SSH and WSL if those environments are
   advertised. Document Windows as experimental until it has a verified path.
4. Install the built VSIX in a clean VS Code profile and check the first-run path,
   command names, keyboard shortcut, sidebar, output layout, empty states, and
   accessibility in light and dark themes.

**Exit condition:** Every advertised runtime has a recorded successful run and
restart, and no known data-loss or process-lifecycle issue remains.

## Gate 2: Listing and package

1. Confirm ownership and exact spelling of the `open-tinker` publisher in the
   Visual Studio Marketplace and Open VSX; choose a different ID before release
   if either registry cannot grant it. Publisher IDs are part of extension URLs.
2. Add a PNG Marketplace icon, a product screenshot or short demo, support and
   issue links, and a clear README section on prerequisites, SSH limitations,
   privacy of run history, and the first successful run. Keep listing claims
   aligned with Gate 1 results. Include a user-facing changelog in the package.
3. Build with a clean install, package one VSIX, inspect its file list and size,
   and install that exact artifact in a clean profile. Confirm no local files,
   credentials, test fixtures, or development-only assets are bundled.

**Exit condition:** The packaged VSIX installs and its listing accurately describes
the tested product. [Manifest and listing guidance](https://code.visualstudio.com/api/references/extension-manifest)

## Gate 3: Reliable publication

1. Change the tag workflow to run typecheck, lint, worker tests, unit tests, build,
   package inspection, and VSIX smoke checks before any upload. Use `npm ci` and
   pin the publishing tools. Publish the same verified VSIX to both registries.
2. Configure Marketplace publisher access. Prefer Entra ID/workload federation for
   automated publishing; if a PAT is used for the first release, plan its removal
   before the December 2026 deadline. Keep credentials in the CI secret store.
3. For Open VSX, create an Eclipse account, sign its Publisher Agreement, generate
   a token, and create the namespace matching `package.json` before upload.
   [Open VSX publishing guide](https://github.com/eclipse-openvsx/openvsx/wiki/Publishing-Extensions)
4. Publish a pre-release version, verify both listing pages and install from each
   registry, then watch installation failures and issue reports before promoting a
   stable release. Do not tag a release until the workflow has passed on the exact
   commit to publish.

**Exit condition:** The same tested artifact is installable from both registries,
and the release workflow can be repeated without manual packaging changes.

## After the first store upload

Prioritize boot scripts, clearer saved SSH profiles, WSL support, and broader
response previews using feedback from the first users. Those are product roadmap
items, not prerequisites for a clearly scoped first pre-release.
