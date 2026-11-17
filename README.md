# Aetherax

WiFi coverage and channel planner, packaged as a desktop application.

The frontend is the SvelteKit planner and Tauri v2 is
the shell around it: one window, one process, everything local.

The layering, the data flows and where new code belongs are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Every propagation, PHY and capacity parameter, with its source and confidence
level, is listed in
[docs/MODEL-PARAMETERS.zh-CN.md](docs/MODEL-PARAMETERS.zh-CN.md). The model
boundary and known approximations are in
[docs/RF-SECONDARY-PATHS.zh-CN.md](docs/RF-SECONDARY-PATHS.zh-CN.md).

## Requirements

| Need | Notes |
| --- | --- |
| Node.js ≥ 22 | Developed on 24.x |
| pnpm | `corepack enable`, or any pnpm ≥ 10 |
| Rust (stable) + the Tauri prerequisites for your platform | `cargo --version`; see <https://v2.tauri.app/start/prerequisites/> |
| Chromium-based browser | Only for the Playwright e2e tests |

## Commands

```bash
pnpm install

# Desktop: this is the application
pnpm tauri:dev        # dev window, frontend hot-reloading on 1420
pnpm tauri:build      # installer + executable in src-tauri/target/release

# Frontend on its own, exactly as the desktop build uses it
pnpm dev              # browser at http://localhost:1420
pnpm build            # static bundle in build/ (what Tauri embeds)
pnpm preview

# Checks
pnpm check            # svelte-check, expect 0 errors
pnpm test             # everything: app + workspace package unit tests (vitest)
pnpm test:packages    # only the workspace packages' own tests
pnpm lint             # eslint over src/ and tests/, expect 0 problems
pnpm test:e2e         # Playwright, builds and previews on 4183 first
pnpm verify:desktop   # drives the built application over the WebView2 debugger

# Maintenance
pnpm fonts            # re-fetch the bundled web fonts into static/fonts
pnpm tauri icon static/favicon.svg   # regenerate src-tauri/icons from the app mark
```

`pnpm test:e2e` needs Playwright's browsers once per machine:
`pnpm exec playwright install chromium`. `@playwright/test` is pinned to the version the
suite was written against, whose browser build is the one already on a machine that has
run the monorepo's tests.

`pnpm verify:desktop` is the one that checks the *application* rather than the browser
build: it launches `src-tauri/target/release/aetherax.exe` with WebView2's debugger port
open, seeds a project into the webview's own storage, runs the optimiser — a module
worker compiled from a workspace package, the riskiest part of a Tauri port — and
asserts the result came back. Run `pnpm tauri:build` first.

## Releases

`.github/workflows/release.yml` builds the Windows bundle on GitHub Actions, so a
distributable does not depend on which machine happened to run `pnpm tauri:build`:

- every push to `main` and every pull request installs, builds and keeps the bundle as a
  workflow artifact (14 days; a PR run is named `Aetherax-windows-pr-<number>`);
- a `v*` tag does the same and publishes a GitHub Release with
  `Aetherax_<version>_x64-setup.exe` (NSIS installer), `Aetherax_<version>_x64_portable.zip`
  (the bare `aetherax.exe`) and `SHA256SUMS.txt`.

The version is written in three files, and the workflow fails before building unless they
agree:

| File | What it versions |
| --- | --- |
| `package.json` | the npm workspace package |
| `src-tauri/Cargo.toml` | the Rust crate (the bundle's file version comes from `tauri.conf.json`) |
| `src-tauri/tauri.conf.json` | the bundle: installer and executable names, and the release tag |

`src-tauri/Cargo.lock` records the same version for the `aetherax` crate; the next
`pnpm tauri:build` refreshes it, so commit that too. A tag has to match the version:

```bash
# bump 0.1.0 -> 0.2.0 in all three files, commit, then
git tag v0.2.0
git push origin v0.2.0
```

The binaries are unsigned, so Windows SmartScreen warns on first run. Signing needs a
certificate configured under `bundle.windows` in `src-tauri/tauri.conf.json`; it is not set
up here.
