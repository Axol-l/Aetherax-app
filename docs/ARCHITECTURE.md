# Aetherax — architecture

A WiFi coverage and channel planner that runs as a desktop application. The frontend is a
static SvelteKit SPA; Tauri v2 is a window and a installer around it. There is no server,
no account, and no network dependency of any kind: the assets the interface needs ship in
the bundle, and nothing downloads a model at runtime.

This document is the map: what the layers are, which way dependencies point, how the three
or four non-obvious data flows work, and where a new piece of code belongs. It is kept in
step with the code by the refactors it describes — if a module moves, its section moves.

```
┌─ Tauri v2 shell (src-tauri/src/lib.rs) ──────────────────────────────────────────┐
│  one window, no commands yet; native file open/save is the next addition          │
│                                                                                  │
│  WebView2 / WebKit: the SvelteKit app                                            │
│    routes/+page → AppShell                                                       │
│      ├ Toolbar            ├ CanvasView (engine + layers + interactions)           │
│      ├ Sidebar            │   ├ FloorplanControls / ApEditor / ApList / …         │
│      └ StatusBar          └ dialogs (Welcome, Help, New project, …)               │
│                                                                                  │
│  state layer — *.svelte.ts $state modules                                        │
│    app / ap / floor / wall / floorplan / project-meta / canvas                   │
│    solver / optimizer-* / persistence / history / i18n                           │
│                                                                                  │
│  domain layer — pure functions, no app state                                     │
│    rf/*  canvas/{morphology,vector-*,wall-*,region-labels}  export/*  units      │
│                                                                                  │
│  workers                                                                         │
│    optimizer-worker.ts (placement search)   packages/solver worker (colouring)   │
│                                                                                  │
│  workspace packages: channels · geometry · solver · tsconfig · eslint-config     │
└──────────────────────────────────────────────────────────────────────────────────┘
```

## Dependency rules

These are the rules the refactors established; breaking one is how the codebase got its
earlier problems.

1. **`rf/` is pure.** No `$state`, no canvas, no DOM. It may import `canvas/room-types.js`
   (a data table) and nothing else from the app. Everything time-dependent or cacheable
   lives in the caller.
2. **Renderers draw, they do not decide.** `canvas/renderers/*` may import state for *types*
   and the current-floor views, but a click handler or a save belongs in `CanvasView`,
   `canvas/interactions/*` (controller-style) or the state layer.
3. **One owner per fact.** Floor data lives on `Floor` (`state/floor-state.svelte.ts`).
   `wallState` and `floorplanState` are getter/setter views over the *current* floor plus a
   few session-only fields — they are not a second copy. Do not reintroduce a mirror.
4. **State modules may import domain modules and each other; domain modules may not import
   state.** The one deliberate cycle is `ap-state → history → persistence → project-document
   → ap-state`; it is safe because every use is inside a function, never at module init.
5. **A mask change hands out a new object.** Cache keys are object identity
   (`canvas/mask-registry.ts`); an in-place edit keeps the old key and every derived cache
   lies. The same rule applies to `floor.walls` (a new array on every edit).
6. **Worker payloads are typed from the state, not restated.** `workers/optimizer-protocol.ts`
   derives `ApInput` from `AccessPoint` and versions the payload.

## Module map

| Area | Path | Notes |
| --- | --- | --- |
| Entry | `src/routes/` | `ssr = false`, prerendered shell, adapter-static fallback `index.html` |
| Shell | `src/lib/components/layout/AppShell.svelte` | grid: toolbar / canvas / sidebar / status bar |
| Canvas view | `src/lib/components/canvas/CanvasView.svelte` | engine wiring, effects, and the editing actions a gesture ends in |
| Gestures | `src/lib/canvas/gestures.svelte.ts` | pointer/touch/orbit/alignment state machine; the view supplies the actions |
| Sidebar | `src/lib/components/sidebar/` | `FloorStrip` (the floor list), `PanelCard` (card shell), `FloorplanNotes`, `FloorplanSurfaces`, `FloorplanControls` (import, calibration, walls, planning area), `ApList`/`ApEditor`, `CoveragePanel`, `ApAdvicePanel` |
| Canvas engine | `src/lib/canvas/engine.ts` | `Layer` interface + dirty flag + requestAnimationFrame |
| Mask pipeline | `src/lib/canvas/mask-pipeline.svelte.ts` | decode → labels/interior → layers; publish; reset on floor switch |
| Heatmap sources | `src/lib/canvas/heatmap-sources.ts` | this floor's APs + other floors' as cross-floor sources |
| Shortcuts | `src/lib/canvas/shortcuts.ts` | the keyboard map, with four view-owned hooks |
| State | `src/lib/state/*.svelte.ts` | see the list below |
| Project document | `src/lib/state/project-document.ts` | `toDocument` / `migrate` / `applyDocument` — the only schema |
| Physical model | `src/lib/rf/` | propagation, antenna, interference, cross-floor, surfaces, reflection, diffraction |
| Link budget glue | `src/lib/rf/link-budget.ts` | `wallRunLoss` / `splitWallRunLoss`, shared by all three evaluators |
| Optimiser | `src/lib/state/optimizer*.ts` | `optimizer.svelte.ts` (run), `-state`, `-support`, `-coverage` |
| Optimiser worker | `src/lib/workers/optimizer-worker.ts` | the search and its own evaluator |
| Worker helpers | `src/lib/workers/optimizer/` | `types.ts` (shared vocabulary), `placement.ts` (wall cache, wall band, interior snapping), `random.ts` |
| Solver | `packages/solver` + `state/solver.svelte.ts` | colouring algorithms; a separate worker |
| Channels | `packages/channels` | bands, regulatory rules, overlap, throughput |
| Geometry | `packages/geometry` | distance, intersection, transform, interference graph |
| Exports | `src/lib/export/` | JSON (project file), PDF (report), PNG (frame) |
| i18n | `src/lib/state/i18n.svelte.ts` | English source string is the key; `zh` catalogue |

State modules, and what owns what:

| Module | Owns |
| --- | --- |
| `app.svelte.ts` | UI modes (wall tool, planning area, calibration, AP placement, floor view), notices |
| `floor-state.svelte.ts` | floors, current floor, elevations, slab loss, `translateFloor` |
| `wall-state.svelte.ts` | current floor's masks/material (views) + detection session fields |
| `floorplan-state.svelte.ts` | current floor's underlay (views) + unit system / import session |
| `ap-state.svelte.ts` | APs (all floors), band/width/domain, mounting, `updateAp`/`addAp` |
| `project-meta.svelte.ts` | name, ISP speed, optimiser policy, custom materials |
| `canvas.svelte.ts` | live engine ref, selection, review highlight |
| `solver.svelte.ts` | channel assignment run, conflict graph, comparison |
| `optimizer.svelte.ts` | placement run, worker protocol, public re-exports |
| `optimizer-state.svelte.ts` | `optimizerState`, per-floor coverage cache |
| `optimizer-support.ts` | payload conversion, density map, slab list, power pass |
| `optimizer-coverage.svelte.ts` | the real-time coverage pass and its caches |
| `persistence.svelte.ts` | the store, autosave, restore, floorplan image keys |
| `history.svelte.ts` | undo/redo snapshots (floors + APs) |
| `i18n.svelte.ts` | locale + catalogue |

## The flows worth knowing

### Walls: segments are the model, the mask is derived

```
floor.walls / floor.columns  ──rasterise──▶  wall mask (per floor)
        │                                       │
        │                                       ├─▶ heatmap (world-space texels)
        │                                       ├─▶ solver conflict graph
        │                                       ├─▶ optimiser payload
        │                                       ├─▶ interior / room labels
        │                                       └─▶ coverage samples
        └───────────────────────────────────────┘
             (the mask is a cache of the segments)
```

`getFloorMask(floorId)` (`state/floor-mask.ts`) is the single seam every consumer goes
through: it derives the mask from the segments when there are any, otherwise decodes the
stored PNG, and caches by mask identity + origin. A floor that is not on screen is served
from its stored mask; the current floor's live edits are published through
`MaskPipeline.publish()`.

The raster editor (`CanvasView` + `canvas/mask-pipeline.svelte.ts`) still exists for plans
that arrive as pixels; drawing a segment hands the rasterised result through the same
publish path, so there is one mask, not two.

### Three evaluators, one wall-loss layer

| Evaluator | Where | Purpose |
| --- | --- | --- |
| heatmap | `canvas/renderers/heatmap.ts` | the picture; per texel, world-space, cached |
| coverage pass | `optimizer-coverage.svelte.ts` | the percentage bar, on the main thread |
| optimiser worker | `workers/optimizer-worker.ts` | the placement search's own scores |

They deliberately differ in resolution and strategy (polar field vs marches, stride 2 vs 1,
grid search vs sampling), so they are not one function. What they share is the wall and slab
*geometry*: `rf/link-budget.ts` turns a floor's mask into a `WallRun` and a cross-floor path
into two runs, and all three call it. When one of them disagrees with the others about a
plan, the difference is in the evaluator, not in how a wall is charged.

### The project document

One schema and three functions, in `state/project-document.ts`:

```
toDocument()    state → document     persistence save, JSON export
migrate(raw)    any version → document
applyDocument() document → state     restore, import
```

`persistence.svelte.ts` writes the document to the store and keeps each floor's underlay
under its own key; `export/json.ts` inlines the underlay as a data URL and pretty-prints.
`history.svelte.ts` is *not* a document: it snapshots only floors + APs (masks are shared by
string identity), because an undo step is not a file.

A field added to a floor must be added to `DocumentFloor` (derived from `Floor`), the two
conversions, and the round-trip test in `state/project-document.test.ts`. The test is the
guard: the earlier JSON format dropped five fields because it had its own copy of the schema.

### Current-floor views

`wallState` and `floorplanState` are objects of getters and setters over `currentFloor()`.
Reading them in an effect tracks the floor fields they read (Svelte signals are tracked at
read time, through the getter). Writing assigns to the floor — always a new object for a
mask. There is no synchronisation step to forget; `state/floor-view.test.ts` pins both
directions.

### Persistence and undo

- Autosave: `scheduleSave()` debounces 5 s, then writes on an idle callback; `saveNow()`
  writes immediately (Ctrl+S and the menu) and shows a notice.
- Storage: localStorage today, IndexedDB implemented behind `BACKEND` in
  `persistence.svelte.ts`; the seam exists so the switch is one line.
- Undo: 50 snapshots of floors + APs, taken at the start of every gesture.

## Workers

- **Optimiser** (`optimizer-worker.ts` + `workers/optimizer/`): module worker compiled from
  source. The payload is versioned and validated; buffers are copied before transfer because
  the caller caches decoded masks. It owns its evaluator and its PRNG (seeded, returned so a
  run is repeatable). The shared vocabulary is in `types.ts`, and the wall cache, wall band
  and interior snapping — the parts with no search state — in `placement.ts`; what is left
  in the worker is the evaluator and the search itself.
- **Solver** (`packages/solver/src/worker.ts`): compaction-free colouring algorithms over a
  serialised graph; the main thread applies the assignment.

Both bridges live in `src/lib/workers/`.

## Where to put new code

| Adding… | Goes in |
| --- | --- |
| a new physical term | `rf/<topic>.ts`, with a test; wire it via `link-budget.ts` if it is wall geometry |
| a new floor field | `Floor` + `DocumentFloor` + the document conversions + round-trip test |
| a new optimiser input | `optimizer-protocol.ts` (type derived from state) → `optimizer-support.ts` → worker |
| a new renderer | `canvas/renderers/*` implementing `Layer`; register in `CanvasView`'s onMount |
| a new plan-editing tool | `app.svelte.ts` (mode + exclusivity) + `canvas/interactions/*` + a toolbar entry |
| a new UI string | wrap the English literal in `t('…')`; the catalogue test fails until `zh` has it |
| a new API response | `export/json.ts` via `toDocument`, never a second schema |

## Tests and gates

| Command | What it checks |
| --- | --- |
| `pnpm check` | svelte-check (expect 0 errors) |
| `pnpm test` | Vitest: the app's unit tests **and** the three workspace packages |
| `pnpm lint` | ESLint over `src/` and `tests/` |
| `pnpm build` | the static bundle Tauri embeds |
| `pnpm test:e2e` | Playwright, 105 tests against a preview build |
| `pnpm test:visual` | golden-image tests for the detectors |
| `pnpm verify:desktop` | drives the built exe over the WebView2 debugger |

CI (`.github/workflows/ci.yml`) runs the first four. The e2e and desktop checks are local
because they need Chromium and a built executable.

The e2e build is the one build that keeps debug lines: several specs detect the end of an
optimiser run by counting its `[optimizer] seed …` lines in the page console, so
`playwright.config.ts` passes `VITE_DEBUG_LOGS=1` to the web server. `pnpm build` and
`tauri build` do not, so a shipped app logs nothing (see `src/lib/log.ts`).

Tests live next to what they test in `src/` (unit) and in `tests/` (e2e, visual, measure).
`tests/e2e/helpers.ts` owns the seeding and the "wait for the debounced save" helpers — use
them instead of `waitForTimeout` when the assertion is about stored state.

## Referenced design notes that are not in this repository

Code comments cite `docs/PHYSICAL_MODELS.md`, `docs/ROADMAP.md` and `docs/AP_ADVICE.md` for
the measurements behind specific thresholds (the ITU slab figures, the optimiser's recorded
runs, the advice rules). Those notes lived in the monorepo this app was ported from and were
not carried over; the comments are kept because they name the figure and the source, but the
documents themselves are absent. Treat a citation as a pointer to a measurement that still
has to be re-derived, not as a file to read.

## Known debt

- `CanvasView.svelte` (~2 250 lines) still owns ~40 layer-sync effects and the editing
  actions (wall/room clicks, surface and note commits); the gesture state machine, mask
  pipeline, heatmap sources and keyboard map have been extracted.
- `optimizer-worker.ts` (~2 200 lines) is still one file: the evaluator and the search
  share one scope. Its vocabulary, placement helpers and PRNG are already in
  `workers/optimizer/`.
- `FloorplanControls.svelte` (~1 690 lines) still holds the import, calibration, planning
  area, walls and floor-properties cards. The floor strip, the notes card and the raised
  surfaces card are out (`FloorStrip`, `FloorplanNotes`, `FloorplanSurfaces`, the last two on
  the shared `PanelCard`); the remaining cards can follow one at a time, and the duplicate
  shell styles in `FloorplanControls` can be deleted once the last one has moved.
- `app.css`, `i18n.svelte.ts`'s catalogue and the vendor AP tables are data-heavy files that
  are edited often and reviewed rarely.
