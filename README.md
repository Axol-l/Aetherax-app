# Aetherax

WiFi coverage and channel planner, packaged as a desktop application.

The frontend is the SvelteKit planner (static, no server, no account) and Tauri v2 is
the shell around it: one window, one process, everything local.

The layering, the data flows and where new code belongs are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

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
asserts the result came back. Run `pnpm tauri:build` first; a screenshot of the window
lands in `test-results/desktop-window.png`.

## Layout

```
src/                 the planner: routes, lib/{state,canvas,components,rf,workers,…}
static/              favicon, manifest, sample floorplans, bundled fonts
tests/e2e/           Playwright specs
packages/            the workspace packages the app imports
  channels/          bands, channels, regulatory domains, channel width rules
  geometry/          wall detection and the interference graph
  solver/            channel-assignment solver (runs in a worker)
  tsconfig/          shared TypeScript configs
tooling/eslint-config/  shared ESLint config
src-tauri/           the Rust shell: window, icons, bundle metadata
scripts/bundle-fonts.ps1  re-fetches the two web fonts into static/fonts
```

## Notes on the port

- **No service worker.** The web build precached itself for offline use; a desktop app
  already *is* offline, and a cache that survives an application update would serve the
  previous version's chunks. `src/service-worker.ts` was left behind deliberately.
- **Fonts are bundled.** `app.html` used to link fonts.googleapis.com; `static/fonts`
  now holds the latin and latin-ext subsets of Inter and JetBrains Mono, and
  `scripts/bundle-fonts.ps1` is what put them there. Nothing in the interface needs the
  network to look right.
- **The solver worker is reached by a relative path** (`src/lib/workers/solver-bridge.ts`),
  because it is compiled from the workspace package's source rather than from a build
  output. The path's depth differs from the monorepo this was ported from — three levels
  to the repository root here.
- **Persistence is still the browser's.** Projects live in `localStorage` of the webview's
  own profile directory, plus JSON/PDF/PNG export. Native file open/save through Tauri is
  the next step, not done yet.
- **Nothing reaches the network.** Wall detection thresholds pixels and traces them into
  segments locally; there is no model to download and no CDN for the app to be behind.
