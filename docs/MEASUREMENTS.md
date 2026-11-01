# Measurements

The numbers the models produce, kept so a change can be compared against what came before it.
`pnpm test:measure` prints them; this file is the reference they are compared to.

Everything here is **an instrument, not a gate**: the specs print figures and a few loose bounds,
and the numbers are the output. Read the date and the commit with each block — the app's physics is
still moving, so a difference between two blocks is only meaningful if the commits between them are
known.

## How to reproduce

```bash
# the optimiser scenarios, about four minutes
$env:MEASURE_INTERFERENCE = '1'; pnpm test:measure -- tests/measure/interference-alternation.spec.ts

# the drag cost (opt-in, one scenario)
$env:MEASURE_DRAG = '1'; pnpm test:measure -- tests/measure/drag-cost.spec.ts
```

Keep the output: Playwright clears `test-results/` on every run, so a capture written there does not
survive the next one. Copy it somewhere before running anything else.

## 2026-11-01 · `3835032` (wall charge through one helper)

`seeds` are 1..n; `coverage` and `interference` are percentages; every scenario is an open rectangle
with no interior walls, so none of these figures exercises wall loss at all — that is what
`src/lib/rf/wall-charge-agreement.test.ts` is for.

| scenario | scores | coverage | interference |
| --- | --- | --- | --- |
| `pair` | 0.95 ×4 | 100 ×4 | 25 ×4 |
| `pair-soft` | 0.95 ×4 | 100 ×4 | 25 ×4 |
| `free` | 1 ×4 | 100 ×4 | 0 ×4 |
| `free-soft` | 1 ×4 | 100 ×4 | 0 ×4 |
| `free6` | 1 ×4 | 100 ×4 | 0 ×4 |
| `limited` | 0.4903, 0.4901, 0.4904, 0.4904, 0.4903, 0.4903, 0.4904, 0.4901 | 77, 77.3, 77.8, 77, 77, 77, 77.8, 77.3 | 0 ×8 |
| `limited6` | 0.3715, 0.3727, 0.3724, 0.3727, 0.372, 0.3727, 0.3726, 0.3728 | 64.5, 65.5, 65.3, 65.8, 64.8, 65.5, 65.3, 66 | 0 ×8 |
| `limited-soft` | 0.7252 ×8 | 80.8 ×8 | 0 ×8 |
| `limited6-soft` | 0.6417, 0.642, 0.6418, 0.642, 0.642, 0.6416, 0.642, 0.6419 | 66, 65, 66.8, 64.8, 64.5, 66, 64.8, 65.3 | 0 ×8 |
| `trade` | 0.4857, 0.4856, 0.4856, 0.486 | 77.3, 78.8, 78.3, 77.8 | 1.3, 1.8, 1.8, 1.5 |
| `trade-weighted` | 0.4813, 0.4818, 0.4813, 0.4819 | 77.3, 77.8, 77.3, 78.3 | 0, 0.3, 0, 0.3 |
| `layout-hard` / `layout-soft` / `layout-cluster` | (panel coverage only) | 80% / 78% / 26% | — |

`keptAssignmentShare` on `free` is **29.25%** and `keptCcaShare` **100%**: `free` seeds four access
points on 2.4 GHz, where the non-overlapping palette is three channels, so the kept assignment
repeats one — `6, 11, 11, 1`. That is the best colouring available, not a defect; see the comment at
the assertion in `tests/measure/interference-alternation.spec.ts`.

The same block was measured before the wall-charge refactor (`ff58679`) and is **identical, figure
for figure** — the refactor replaced two hand-written marches in the worker with the shared
`wallRunLoss`, passing the same arguments, so no number could move. That is what the comparison
was for.
