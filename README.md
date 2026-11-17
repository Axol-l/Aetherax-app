# Aetherax

WiFi coverage and channel planner, packaged as a desktop application.

The frontend is the SvelteKit planner and Tauri v2 is
the shell around it: one window, one process, everything local.

Every propagation, PHY and capacity parameter, with its source and confidence
level, is listed in
[docs/MODEL-PARAMETERS.zh-CN.md](docs/MODEL-PARAMETERS.zh-CN.md).

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

`pnpm test:e2e` needs Playwright's browsers once per machine.

`pnpm verify:desktop` is the one that checks the application rather than the browser
build.
