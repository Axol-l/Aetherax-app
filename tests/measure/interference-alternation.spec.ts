import { test, expect, type Page } from '@playwright/test';
import { planningChannels } from '@aetherax/channels';
import { setupCleanState } from '../e2e/helpers';
import { violatesAt } from '../../src/lib/rf/interference';
import { COVERAGE_MARGIN_DB, coverageMarginDb } from '../../src/lib/rf/propagation';

/**
 * Measurement, not a check: how much room does the optimiser actually have?
 *
 * Run with `MEASURE_INTERFERENCE=1` (the name predates the second and third
 * scenarios). It is opt-in because the point is the numbers, which are recorded in
 * `MODEL_NOTES.md` §6 and `docs/ROADMAP.md` F1/B1, and each scenario runs the
 * optimiser several times. It is skipped in the normal gate.
 *
 * The families, all with a synthetic open floor and no interior walls, so the only
 * thing being measured is the search:
 *
 * - `pair`: two APs **both pinned to channel 1** on the saturated 18 x 12 m floor.
 *   No assignment can separate them, so the interference term has real work to do
 *   and the only lever is placement.
 * - `free`: four APs, none pinned, same floor. Every conflicting pair can be
 *   separated by a channel change, so the alternating model measures no
 *   interference at all and the objective collapses back to coverage. `free6` is
 *   the same floor with six APs — more sources than the post-B3 palette has
 *   channels — and `free-soft` the four-AP case under F2's softened threshold, so
 *   the three separate "no layout can avoid this" from "no palette can".
 * - `limited`: two APs on a 30 x 20 m floor with a coverage reach of ~9 m, i.e.
 *   not enough APs to cover it. This is the scenario `docs/ROADMAP.md` F1 asks for
 *   after the first measurement: coverage saturates in the other two, so the
 *   coverage objective is flat there and the spread across restarts says nothing
 *   about the *search*. Here it has a gradient, and the spread is the headroom.
 *   `limited6` is the same idea with six APs on a larger floor, and the `-soft`
 *   twins are the F2 A/B controls.
 *
 * The exhaustive-lattice baseline that goes with `limited` is
 * `tests/measure/lattice-optimum.mjs`; it scores the same objective over every
 * AP placement on a lattice and is what turns the spread into "how far from
 * optimal".
 */

const MEASURE =
	(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
		?.MEASURE_INTERFERENCE === '1';

/** The only channel the pinned scenarios use. */
const CHANNEL = 1;

interface Scenario {
	/** Where the APs start. The optimiser may move all of them. */
	points: Array<{ x: number; y: number }>;
	/** True when every AP is pinned to `CHANNEL`, so no assignment can help. */
	pinned: boolean;
	width: number;
	height: number;
	/** Association radius in px; the coverage reach is 0.42x this (see H1). */
	radius: number;
	/**
	 * AP transmit power, in dBm. This is what actually sets the radius: the app
	 * re-derives `interferenceRadius` from the power on load (`refreshApRanges`),
	 * so a seeded radius is only a note of what the power is expected to give.
	 */
	power: number;
	weight: number;
	restarts: number;
	/**
	 * How far below the coverage threshold a sample still earns utility, in dB.
	 * Zero is the hard threshold every measurement before 2026-09-23 was taken
	 * with; 10 is the new default, so the scenario pairs are A/B controls.
	 */
	softness: number;
	/**
	 * F3's ε-constraint: the covered share the optimiser must reach, in percent. Absent
	 * or 0 means no constraint.
	 */
	floorPct?: number;
}

/**
 * 600 x 400 px at the app's default 32.7 px/m is 18 x 12 m, and 1000 x 667 is
 * 30 x 20 m. 20 dBm at 2.4 GHz derives a 1414 px association radius, which covers
 * either floor from anywhere (the saturated scenarios); 8 dBm derives ~700 px,
 * whose 9 m coverage reach is under half of the big floor.
 */
const SCENARIOS: Record<string, Scenario> = {
	// Saturated floor, interference a placement problem.
	pair: {
		points: [
			{ x: 220, y: 300 },
			{ x: 280, y: 320 }
		],
		pinned: true,
		width: 600,
		height: 400,
		radius: 1414,
		power: 20,
		weight: 0.2,
		restarts: 4,
		softness: 0
	},
	// Saturated floor, interference an assignment problem.
	free: {
		points: [
			{ x: 260, y: 180 },
			{ x: 320, y: 200 },
			{ x: 280, y: 240 },
			{ x: 340, y: 220 }
		],
		pinned: false,
		width: 600,
		height: 400,
		radius: 1414,
		power: 20,
		weight: 0.2,
		restarts: 4,
		softness: 0
	},
	// Coverage-limited: two APs, a floor three times their reach in area. Weight 0
	// so the figure compared against the exhaustive baseline is the plain utility.
	limited: {
		points: [
			{ x: 100, y: 100 },
			{ x: 150, y: 150 }
		],
		pinned: false,
		width: 1000,
		height: 667,
		radius: 700,
		power: 8,
		weight: 0,
		restarts: 8,
		softness: 0
	},
	// The same floor and seeds with the softened threshold: the F2 A/B.
	'limited-soft': {
		points: [
			{ x: 100, y: 100 },
			{ x: 150, y: 150 }
		],
		pinned: false,
		width: 1000,
		height: 667,
		radius: 700,
		power: 8,
		weight: 0,
		restarts: 8,
		softness: 10
	},
	// The same short reach on a bigger floor, with six APs: twelve dimensions to search
	// instead of four, and still not enough coverage to be saturated. Exhaustive
	// enumeration is out of reach here; the spread across restarts is what this one
	// is for, and this is the case the softening is meant to help.
	limited6: {
		points: [
			{ x: 100, y: 100 },
			{ x: 150, y: 100 },
			{ x: 200, y: 100 },
			{ x: 100, y: 150 },
			{ x: 150, y: 150 },
			{ x: 200, y: 150 }
		],
		pinned: false,
		width: 1400,
		height: 900,
		radius: 504,
		power: 2,
		weight: 0,
		restarts: 8,
		softness: 0
	},
	// Its A/B twin: same floor, same APs, same seeds, softened threshold.
	'limited6-soft': {
		points: [
			{ x: 100, y: 100 },
			{ x: 150, y: 100 },
			{ x: 200, y: 100 },
			{ x: 100, y: 150 },
			{ x: 150, y: 150 },
			{ x: 200, y: 150 }
		],
		pinned: false,
		width: 1400,
		height: 900,
		radius: 504,
		power: 2,
		weight: 0,
		restarts: 8,
		softness: 10
	},
	// The saturated scenarios with the new default, which should change nothing:
	// every sample is already at or above the full-margin line, where both kernels
	// return 1. A softening that moved these would be changing something else.
	'pair-soft': {
		points: [
			{ x: 220, y: 300 },
			{ x: 280, y: 320 }
		],
		pinned: true,
		width: 600,
		height: 400,
		radius: 1414,
		power: 20,
		weight: 0.2,
		restarts: 4,
		softness: 10
	},
	'free-soft': {
		points: [
			{ x: 260, y: 180 },
			{ x: 320, y: 200 },
			{ x: 280, y: 240 },
			{ x: 340, y: 220 }
		],
		pinned: false,
		width: 600,
		height: 400,
		radius: 1414,
		power: 20,
		weight: 0.2,
		restarts: 4,
		softness: 10
	},
	// Six APs, no pins, on the same saturated floor: twice as many sources as the
	// non-overlapping 2.4 GHz palette has channels, and all six cover the whole
	// floor, so the sample conflict graph is far denser than `free`'s five edges.
	// This is the case B3 is meant to make visible, where the palette can no longer
	// avoid every reuse; `free` is the control — four APs, three channels, and a
	// layout whose graph happens to be 3-colourable, so it reads 0%.
	free6: {
		points: [
			{ x: 260, y: 180 },
			{ x: 320, y: 200 },
			{ x: 280, y: 240 },
			{ x: 340, y: 220 },
			{ x: 300, y: 160 },
			{ x: 300, y: 260 }
		],
		pinned: false,
		width: 600,
		height: 400,
		radius: 1414,
		power: 20,
		weight: 0.2,
		restarts: 4,
		softness: 0
	},
	// Coverage-limited *and* forced co-channel: the F3 sweep geometry at the default
	// weight. This is where a transmit-power cut is supposed to pay — shrinking a
	// circle can take a sample out of the band where two APs are within the reuse
	// distance of each other — and it is the scenario that says whether B4's pass does
	// anything at all. The saturated floors cannot show it: the reuse threshold is a
	// *relative* 10 dB, so cutting every AP's power by the same amount leaves every
	// pairwise level difference exactly where it was, and only the coverage edge moves.
	trade: {
		points: [
			{ x: 100, y: 100 },
			{ x: 150, y: 150 }
		],
		pinned: true,
		width: 1000,
		height: 667,
		radius: 700,
		power: 8,
		weight: 0.2,
		restarts: 4,
		softness: 0
	},
	// The same floor with interference weighted at the top of F3's range. A power cut
	// trades coverage for interference, so it can only be worth taking where the
	// weight says interference is worth coverage — which is what this scenario is for:
	// it is the control that shows the TPC pass is able to act, rather than declining
	// everything the way it does at the default weight.
	'trade-weighted': {
		points: [
			{ x: 100, y: 100 },
			{ x: 150, y: 150 }
		],
		pinned: true,
		width: 1000,
		height: 667,
		radius: 700,
		power: 8,
		weight: 1,
		restarts: 4,
		softness: 0
	}
};

async function seed(page: Page, s: Scenario): Promise<void> {
	const { width, height, points } = s;
	await page.addInitScript(
		(arg: {
			points: Array<{ x: number; y: number }>;
			pinned: boolean;
			channel: number;
			weight: number;
			softness: number;
			width: number;
			height: number;
			radius: number;
			power: number;
			floorPct?: number;
		}) => {
			const { width, height } = arg;
			localStorage.setItem('aetherax:welcomed', '1');
			localStorage.removeItem('aetherax:project');
			// An empty room: a walled border and nothing else, so nothing the search
			// does can be attributed to the wall model.
			const c = document.createElement('canvas');
			c.width = width;
			c.height = height;
			const ctx = c.getContext('2d')!;
			ctx.fillStyle = '#ffffff';
			ctx.fillRect(0, 0, width, 8);
			ctx.fillRect(0, height - 8, width, 8);
			ctx.fillRect(0, 0, 8, height);
			ctx.fillRect(width - 8, 0, 8, height);
			const floorId = 'f1';
			localStorage.setItem(
				'aetherax:project',
				JSON.stringify({
					version: 3,
					name: 'Measurement',
					band: '2.4ghz',
					channelWidth: 20,
					regulatoryDomain: 'fcc',
					unitSystem: 'metric',
					ispSpeed: 0,
					targetThroughput: 25,
					allowOutsideRooms: false,
					clientHeight: 1.5,
					heatmapRssiFloor: -70,
					interferenceWeight: arg.weight,
					coverageSoftnessDb: arg.softness,
					// Only when the scenario asks for a floor; otherwise the app's own default
					// applies, which is what a user gets.
					...(arg.floorPct === undefined ? {} : { coverageFloorPct: arg.floorPct }),
					floors: [
						{
							id: floorId,
							name: 'Floor 1',
							level: 0,
							ceilingHeight: 3,
							floorMaterial: 1,
							floorThickness: 0.2,
							floorplanScale: 1,
							floorplanOffsetX: 0,
							floorplanOffsetY: 0,
							calibration: null,
							floorplanBoundary: null,
							wallMask: {
								dataUrl: c.toDataURL('image/png'),
								width,
								height,
								originX: 0,
								originY: 0
							},
							wallAttenuation: 5,
							wallMaterial: 0,
							materialMask: null,
							roomTypeMask: null,
							roomDensityOverrides: {},
							roomCustomLabels: {}
						}
					],
					aps: arg.points.map((p, i) => ({
						id: `ap${i + 1}`,
						name: `AP-${i + 1}`,
						x: p.x,
						y: p.y,
						floorId,
						band: '2.4ghz',
						channelWidth: 20,
						// A pinned AP is one the colourer may not move.
						fixedChannel: arg.pinned ? arg.channel : null,
						assignedChannel: arg.pinned ? arg.channel : null,
						// Rewritten from the power on load; set here to the value the
						// power is expected to derive, so a mismatch is visible in the
						// run's own readout.
						interferenceRadius: arg.radius,
						power: arg.power,
						modelId: null,
						modelLabel: null
					}))
				})
			);
		},
		{
			points,
			pinned: s.pinned,
			channel: CHANNEL,
			weight: s.weight,
			softness: s.softness,
			width,
			height,
			radius: s.radius,
			power: s.power,
			floorPct: s.floorPct
		}
	);
}

interface Restart {
	seed: number;
	score: number;
	coverage: number;
	interference: number;
	/** Airtime share with two overlapping-channel APs above the CCA threshold. */
	contention: number;
	/** Percent the run gained over its own input, on the same objective. */
	improvement: number;
	known: boolean;
}

/** Collect the optimiser's per-run console lines and press the button. */
async function measure(page: Page, restarts: number): Promise<Restart[]> {
	const runs: Restart[] = [];
	page.on('console', (m) => {
		const text = m.text();
		// The transmit-power pass's decision, printed as it happens: B4's evidence is
		// as much about the cuts it *declines* as about the ones it makes, and silence
		// would be indistinguishable from the pass not running.
		if (text.startsWith('[optimizer] transmit power')) console.log(text);
		const hit =
			/\[optimizer\] seed (\d+), score ([\d.]+), improvement (-?[\d.]+)%, coverage ([\d.]+)%, co-channel interference ([\d.]+)%, contended \(CCA\) ([\d.]+)%/.exec(
				text
			);
		if (!hit) return;
		runs.push({
			seed: Number(hit[1]),
			score: Number(hit[2]),
			coverage: Number(hit[4]),
			interference: Number(hit[5]),
			contention: Number(hit[6]),
			improvement: Number(hit[3]),
			known: !text.includes('all-co-channel bound')
		});
	});

	const all = new Promise<void>((resolve) => {
		page.on('console', (m) => {
			if (new RegExp(`\\[optimizer\\] ${restarts} restarts:`).test(m.text())) resolve();
		});
	});

	await page.getByRole('button', { name: 'Placement optimiser settings' }).click();
	const restartRow = page
		.locator('.settings-popup .slider-row', { hasText: 'Restarts' })
		.locator('input');
	await restartRow.click();
	await restartRow.press('Control+a');
	await restartRow.type(String(restarts));
	await restartRow.press('Tab');
	await page.getByRole('button', { name: 'Placement optimiser settings' }).click();

	await page.getByRole('button', { name: /optimize (placement|all floors)/i }).click();
	await all;
	return runs;
}

/** What the app persisted: the channels, positions and derived radius of the run. */
async function persistedAps(page: Page): Promise<unknown> {
	return page.evaluate(() => {
		const raw = localStorage.getItem('aetherax:project');
		if (!raw) return null;
		const data = JSON.parse(raw) as {
			aps?: Array<{
				id: string;
				x: number;
				y: number;
				interferenceRadius: number;
				fixedChannel: number | null;
				assignedChannel: number | null;
			}>;
		};
		return (data.aps ?? []).map((a) => ({
			id: a.id,
			x: Math.round(a.x),
			y: Math.round(a.y),
			// The app derives this from the power on load, so reading it back is how
			// the run says which coverage reach it was actually measured with.
			radius: Math.round(a.interferenceRadius),
			fixed: a.fixedChannel,
			assigned: a.assignedChannel
		}));
	});
}

/**
 * The third instrument: coverage of a layout, at every interior pixel.
 *
 * F1 has been unable to settle two questions because every instrument it had shared
 * the optimiser's sample set. This one does not sample at all — it walks the interior
 * pixel by pixel — so it is independent of the *first* thing that could be wrong, and
 * it recomputes the margin from the documented constants rather than calling the
 * app's function, so it is independent of the second:
 *
 *     margin(d) = 10·n·log10(radius/d) − COVERAGE_MARGIN_DB,  n = 4
 *     covered   ⟺ margin > 0          (the coverage threshold, −70 dBm)
 *
 * `radius` is the association radius at the receiver sensitivity (−85 dBm), which is
 * what the app stores as `interferenceRadius`; the margin is how far above the
 * coverage threshold the level is, so the coverage reach comes out at 0.42·radius —
 * the factor `RF/propagation.ts` documents.
 *
 * Exact for these scenarios and not in general: the floors are a border ring, so no
 * interior ray crosses a wall and the loss term is zero. A real floorplan would need
 * the wall march, which is the app's job, not a cross-check's.
 */
function denseCoverage(
	positions: Array<{ x: number; y: number }>,
	radius: number,
	width: number,
	height: number
): number {
	const PATH_LOSS_N = 4;
	// COVERAGE_THRESHOLD_DBM − SENSITIVITY: −70 − (−85).
	const COVERAGE_MARGIN = 15;
	// The app's `computeBuildingInterior` insets the interior behind the drawn wall
	// ring; 16 px is its dilation at these floor sizes.
	const inset = 16;
	let covered = 0;
	let total = 0;
	for (let y = inset; y < height - inset; y++) {
		for (let x = inset; x < width - inset; x++) {
			total++;
			for (const p of positions) {
				const d = Math.max(Math.hypot(x - p.x, y - p.y), 1e-6);
				if (10 * PATH_LOSS_N * Math.log10(radius / d) - COVERAGE_MARGIN > 0) {
					covered++;
					break;
				}
			}
		}
	}
	return total > 0 ? covered / total : 0;
}

/** Spread of a set of numbers, as a percentage of the lowest. */
function spread(values: number[]): string {
	const lo = Math.min(...values);
	const hi = Math.max(...values);
	return lo > 0 ? (((hi - lo) / lo) * 100).toFixed(2) : '0.00';
}

/**
 * How far below the coverage threshold the absolute (CCA) criterion reaches.
 *
 * 802.11's clear-channel assessment is a *preamble detect* at −82 dBm for a 20 MHz
 * channel: a station defers to co-channel energy above that, whatever its own
 * signal-to-interference ratio is. The model's levels are margins above the −70 dBm
 * coverage threshold, so −82 dBm is a margin of −12 dB. Bonded channels raise the
 * threshold by 3 dB per doubling of width, which this ignores: every measurement
 * scenario is 20 MHz, and the width scaling belongs with the criterion itself when
 * it is implemented rather than with the instrument that is sizing it.
 */
const CCA_HORIZON_DB = -12;

/**
 * The interference share of the assignment the app actually kept, recomputed from
 * outside the app.
 *
 * This is the cross-check for the *unification* of the two conflict graphs
 * (`ROADMAP.md` B5): the solver used to colour a graph built from circle overlap
 * while the optimiser scored the plan on sample-level margins, and the two
 * disagreed — on the four-AP `free` layout the assignment in the AP list scored
 * 14.75% on the objective's graph while a proper colouring of it scored 0%. The
 * claim afterwards is that the plan the app hands the user is interference-free on
 * the graph the objective uses, and only an instrument outside the app can check
 * that the two paths really meet.
 *
 * Two things have to match the worker for the figure to be comparable, and both
 * are reproduced deliberately rather than approximated:
 *
 * - **The sample set.** The worker's uniform branch takes every `step`-th interior
 *   pixel in raster order. An evenly spaced grid instead would be a *different*
 *   graph — usually a superset — and the check would then be measuring its own
 *   sampling rather than the app's.
 * - **The margin.** `coverageMarginDb(d, radius) − COVERAGE_MARGIN_DB`, with no wall
 *   loss: the seeded floor is a border ring and the APs and the samples are all well
 *   inside it, so no ray crosses a wall. That is exact here, not an approximation.
 *   Margins are kept out to `CCA_HORIZON_DB` rather than clipped at the coverage
 *   threshold, because the second figure this returns is about a signal 12 dB below
 *   it.
 */
function keptAssignmentShare(
	positions: Array<{ x: number; y: number }>,
	channels: number[],
	radius: number,
	width: number,
	height: number
): { share: number; ccaShare: number } {
	const count = positions.length;
	// One set of margins, two figures. `wide` reaches `CCA_HORIZON_DB` because the
	// absolute criterion is about a signal below the coverage threshold; the SIR figure
	// is computed from the *clipped* copy, because that is the domain the app's term
	// has — feeding it the wide set would count samples the objective never sees (and
	// did: `trade` read 25% against the optimiser's 2.3% until this was split).
	const wideAt = (x: number, y: number): number[] =>
		positions.map((p) => {
			const d = Math.hypot(x - p.x, y - p.y);
			const m = coverageMarginDb(Math.max(d, 1e-6), radius) - COVERAGE_MARGIN_DB;
			return m > CCA_HORIZON_DB ? m : -Infinity;
		});

	// The interior as the seed draws it: everything inside the 8 px border ring.
	const interior: Array<{ x: number; y: number }> = [];
	for (let y = 8; y <= height - 9; y++)
		for (let x = 8; x <= width - 9; x++) interior.push({ x, y });

	const total = Math.min(400, interior.length);
	const step = interior.length / total;
	let violating = 0;
	let cca = 0;
	for (let i = 0; i < total; i++) {
		const s = interior[Math.floor(i * step)]!;
		const wide = wideAt(s.x, s.y);
		// The coverage domain, as `fillMargins` stores it for the objective.
		const clipped = wide.map((m) => (m > 0 ? m : -Infinity));
		if (violatesAt(clipped, channels, count, 0, null)) violating++;

		// B4/B5's open question, measured rather than assumed: two APs on overlapping
		// channels both above the CCA threshold take airtime from each other whatever
		// their own signal-to-interference ratio is. A station defers to co-channel
		// energy above that threshold, which is an *absolute* criterion — the term in
		// use is purely relative (10 dB below the best server), so this counts the
		// samples the current model does not charge for.
		let hit = false;
		for (let a = 0; a < count && !hit; a++) {
			for (let b = a + 1; b < count; b++) {
				if (channels[a] !== channels[b]) continue;
				if (wide[a]! > CCA_HORIZON_DB && wide[b]! > CCA_HORIZON_DB) {
					hit = true;
					break;
				}
			}
		}
		if (hit) cca++;
	}
	return { share: violating / total, ccaShare: cca / total };
}

/**
 * The two layouts the softened objective and the hard one landed on, on the
 * two-AP limited floor.
 *
 * Scored by the *app's own* live estimator, with no optimiser run: the run's
 * console figure and an independent dense-sample model of the same formula
 * disagreed about which of these two covers more floor, and only the app's own
 * instrument can settle it. `hard` is what the hard kernel chose, `soft` what the
 * softened one did.
 */
const TWO_AP_LAYOUTS: Record<string, Array<{ x: number; y: number }>> = {
	'layout-hard': [
		{ x: 249, y: 288 },
		{ x: 746, y: 376 }
	],
	'layout-soft': [
		{ x: 253, y: 330 },
		{ x: 742, y: 334 }
	],
	// The starting cluster, which the independent model puts at 27% covered. A
	// third point calibrates the two instruments against each other: if the app
	// agrees here, its 86% for the soft layout is a real difference between the
	// layouts and not a property of its estimator.
	'layout-cluster': [
		{ x: 100, y: 100 },
		{ x: 150, y: 150 }
	]
};

test.describe('optimiser measurement', () => {
	test.skip(!MEASURE, 'set MEASURE_INTERFERENCE=1 to run the measurements');

	// The panel's own coverage figure, for a layout placed by hand: no optimiser
	// run, so the number describes the layout and nothing else.
	for (const name of Object.keys(TWO_AP_LAYOUTS)) {
		test(`${name}: what the app's own coverage estimator says`, async ({ page }) => {
			test.setTimeout(120_000);
			await setupCleanState(page);
			await seed(page, {
				points: TWO_AP_LAYOUTS[name]!,
				pinned: false,
				width: 1000,
				height: 667,
				radius: 700,
				power: 8,
				weight: 0,
				restarts: 1,
				softness: 0
			});
			await page.goto('/');
			await page.waitForSelector('canvas');
			// The live estimator is debounced (300 ms) and runs on a worker-sized
			// sample set; give it the same margin the other measurements wait for.
			await page.waitForTimeout(6000);

			// The panel's coverage row is `.metric` > `.metric-head` > name + value. Read by
			// the row's own name rather than by position, because the panel has carried more
			// than one reading before and will again.
			const coverage = await page
				.locator('.metric', { hasText: 'Coverage' })
				.locator('.metric-value')
				.innerText();
			console.log(`MEASURE ${JSON.stringify({ scenario: name, panelCoverage: coverage })}\n`);
			expect(Number(coverage.replace('%', ''))).toBeGreaterThan(0);
		});
	}

	for (const name of Object.keys(SCENARIOS)) {
		const scenario = SCENARIOS[name]!;
		test(`${name}: ${scenario.restarts} restarts`, async ({ page }) => {
			test.setTimeout(600_000);
			await setupCleanState(page);
			await seed(page, scenario);
			await page.goto('/');
			await page.waitForSelector('canvas');
			// The solver colours the plan on load; waiting for it means the runs score
			// against a real assignment rather than the all-co-channel bound.
			await page.waitForTimeout(4000);

			const runs = await measure(page, scenario.restarts);
			// The project is saved on a debounce, so give it a moment before reading
			// back where the APs actually ended up.
			await page.waitForTimeout(2500);
			const aps = await persistedAps(page);
			// The assignment the app kept, scored on the objective's own graph by an
			// instrument outside the app. See `keptAssignmentShare`.
			const kept = aps as Array<{
				x: number;
				y: number;
				assigned: number | null;
				fixed: number | null;
			}>;
			const { share: keptShare, ccaShare: keptCcaShare } = keptAssignmentShare(
				kept.map((a) => ({ x: a.x, y: a.y })),
				kept.map((a) => a.fixed ?? a.assigned ?? 1),
				scenario.radius,
				scenario.width,
				scenario.height
			);
			// The numbers the docs quote, with the spread computed the same way the
			// app's own console line computes it.
			console.log(
				`MEASURE ${JSON.stringify({
					scenario: name,
					radius: scenario.radius,
					size: [scenario.width, scenario.height],
					weight: scenario.weight,
					softness: scenario.softness,
					scores: runs.map((r) => r.score),
					coverage: runs.map((r) => r.coverage),
					interference: runs.map((r) => r.interference),
					contention: runs.map((r) => r.contention),
					improvement: runs.map((r) => r.improvement),
					scoreSpread: spread(runs.map((r) => r.score)),
					coverageSpread: spread(runs.map((r) => r.coverage)),
					keptAssignmentShare: Number(keptShare.toFixed(4)),
					keptCcaShare: Number(keptCcaShare.toFixed(4)),
					aps
				})}\n`
			);

			expect(runs).toHaveLength(scenario.restarts);
			expect(runs.every((r) => r.known)).toBe(true);
			// The contention figure is the app's own, and the instrument outside it
			// recomputes the same thing (`keptCcaShare`) from the persisted layout. They
			// agree on what matters — both 0 for a plan with no shared channel (`limited`),
			// both 100% for the saturated ones — but not to the point: this figure is
			// threshold-sensitive, so a sample sitting near the −82 dBm line flips it,
			// and the two instruments pick different samples (the worker walks the
			// interior `computeBuildingInterior` finds; the instrument uses its own inset
			// grid). Ten points is the honest bound for a cross-instrument check; the
			// agreement at the ends is the strong claim.
			const appContention = runs[0]!.contention / 100;
			// The figure is threshold-sensitive near the −82 dBm line and the two
			// instruments sample differently, so on floors where the reuse band is
			// marginal they can differ by more than the bound below. Tightening this is
			// what a shared sample set would buy.
			expect(Math.abs(appContention - keptCcaShare)).toBeLessThanOrEqual(0.1);

			// And the third instrument, on the same layout: what fraction of the interior
			// is actually covered, pixel by pixel. Reported beside the run's own figure,
			// because the difference between them is the whole point of measuring it.
			const dense = denseCoverage(
				kept.map((a) => ({ x: a.x, y: a.y })),
				scenario.radius,
				scenario.width,
				scenario.height
			);
			const appCoverage = runs.reduce((sum, r) => sum + r.coverage, 0) / Math.max(1, runs.length);
			console.log(
				`MEASURE_DENSE ${JSON.stringify({
					scenario: name,
					app: Number(appCoverage.toFixed(1)),
					dense: Number((dense * 100).toFixed(1)),
					delta: Number((dense * 100 - appCoverage).toFixed(1))
				})}\n`
			);
			if (name.startsWith('pair')) {
				// The pair cannot be separated by any assignment, so the term keeps
				// something to score however the search places them. The same figure
				// recomputed outside the app is the calibration for the instrument the
				// `free` branch leans on: if it did not agree here, its zero there would
				// mean nothing.
				expect(runs.every((r) => r.interference > 5)).toBe(true);
				expect(keptShare).toBeGreaterThan(0.05);
			} else if (name.startsWith('free')) {
				// No pins, and a palette of three non-overlapping channels (B3) against four (or
				// six) APs whose circles all overlap: **every** pair conflicts somewhere, so a
				// repeat is forced and "interference-free" is not a state this scenario has.
				//
				// What is achievable, and what this asserts: the solver uses every channel it
				// has before it repeats one. The old assertion here was `keptShare === 0`, which
				// was unsatisfiable for exactly that reason — and it failed identically on the
				// tree before the refactors, which is how it was noticed.
				expect(runs.every((r) => r.interference === 0)).toBe(true);
				const palette = planningChannels('2.4ghz', 'fcc', 20).length;
				const distinct = new Set(kept.map((a) => a.fixed ?? a.assigned ?? 1)).size;
				expect(distinct).toBe(Math.min(kept.length, palette));
				expect(keptShare).toBeGreaterThan(0);
				expect(runs.every((r) => r.coverage > 99)).toBe(true);
			} else {
				// The point of these scenarios is that coverage is *not* saturated: if
				// it were, the spread below would be measuring a flat objective again.
				// Softening the threshold must not change that — it changes what the
				// optimiser can see, not how much of the floor is covered.
				expect(runs.every((r) => r.coverage < 95)).toBe(true);
				expect(runs.every((r) => r.coverage > 20)).toBe(true);
				// The app derives the radius from the power, so the scenario really is
				// only coverage-limited if that derivation lands where it was planned.
				const radii = (aps as Array<{ radius: number }>).map((a) => a.radius);
				expect(radii.every((r) => Math.abs(r - scenario.radius) < 20)).toBe(true);
			}
		});
	}

	/**
	 * F3's ε-constraint: does a coverage floor actually bind, and is it reported?
	 *
	 * The weighted sum cannot state "cover at least X%": it can only trade. This runs
	 * the same floor and seeds twice — once unconstrained, once with a floor above
	 * where the unconstrained run lands — because a floor that is never reached changes
	 * nothing, and a floor already met by the unconstrained optimum would also change
	 * nothing. The pair is what makes the test mean something.
	 */
	test('F3: a coverage floor binds the result, and is reported', async ({ page }) => {
		test.skip(!MEASURE, 'set MEASURE_INTERFERENCE=1 to run the measurements');
		test.setTimeout(900_000);
		const base = SCENARIOS['limited']!;
		const restarts = 4;
		const floorPct = 80;
		const mean = (values: number[]): number =>
			values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

		const runsFor = async (withFloor: boolean): Promise<Restart[]> => {
			await setupCleanState(page);
			await seed(page, {
				...base,
				pinned: false,
				restarts,
				...(withFloor ? { floorPct } : {})
			});
			await page.goto('/');
			await page.waitForSelector('canvas');
			await page.waitForTimeout(4000);
			return measure(page, restarts);
		};

		const free = await runsFor(false);
		const floored = await runsFor(true);

		const report = {
			floorPct,
			freeCoverage: Number(mean(free.map((r) => r.coverage)).toFixed(1)),
			flooredCoverage: Number(mean(floored.map((r) => r.coverage)).toFixed(1)),
			freeInterference: Number(mean(free.map((r) => r.interference)).toFixed(1)),
			flooredInterference: Number(mean(floored.map((r) => r.interference)).toFixed(1))
		};
		console.log(`MEASURE_FLOOR ${JSON.stringify(report)}\n`);

		// Without a floor this scenario lands around 77%, so a 80% floor has to move it.
		// Measured on the *mean* rather than on every restart: the search is stochastic
		// and a floor is a target for the search, not a guarantee it can always reach —
		// which is exactly why the run reports the shortfall rather than staying silent.
		expect(report.flooredCoverage).toBeGreaterThan(report.freeCoverage);
	});

	/**
	 * F3: does the interference weight actually move the operating point, and what
	 * does it cost?
	 *
	 * The weighted sum `coverage − λ · interference` is only worth sweeping if some λ
	 * buys something. On the saturated floors nothing can: coverage is 100% wherever
	 * the APs go, so λ is free to push interference down at no cost. This scenario is
	 * built to be the other case — two APs pinned to one channel (so no assignment can
	 * separate them), on a floor three times their joint coverage, so covering more of
	 * it means spreading them apart, and spreading is exactly what puts their signals
	 * within the reuse distance of each other over a wide band.
	 *
	 * Fixed across the sweep, as `ROADMAP.md` F3 requires: the softness (or every point
	 * would be a different objective), the seeds (or the curve would be noise) and the
	 * geometry. λ is the only thing that changes.
	 */
	test('F3: the interference weight buys coverage — λ sweep', async ({ page }) => {
		test.skip(!MEASURE, 'set MEASURE_INTERFERENCE=1 to run the measurements');
		test.setTimeout(1_800_000);
		const base = SCENARIOS['limited']!;
		const restarts = 4;
		const lambdas = Array.from({ length: 21 }, (_, i) => Number((i * 0.05).toFixed(2)));
		const mean = (values: number[]): number =>
			values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

		const front: Array<{
			lambda: number;
			coverage: number;
			interference: number;
			coverageSpread: number;
			interferenceSpread: number;
		}> = [];

		for (const lambda of lambdas) {
			await setupCleanState(page);
			await seed(page, { ...base, pinned: true, weight: lambda, restarts });
			await page.goto('/');
			await page.waitForSelector('canvas');
			// The solver colours the plan on load; the runs should score against a real
			// assignment, and pinned channels make that assignment co-channel whatever
			// the colourer would prefer.
			await page.waitForTimeout(4000);
			const runs = await measure(page, restarts);
			front.push({
				lambda,
				coverage: Number(mean(runs.map((r) => r.coverage)).toFixed(1)),
				interference: Number(mean(runs.map((r) => r.interference)).toFixed(1)),
				coverageSpread: Number(spread(runs.map((r) => r.coverage))),
				interferenceSpread: Number(spread(runs.map((r) => r.interference)))
			});
		}

		console.log(`MEASURE_FRONT ${JSON.stringify(front)}\n`);

		// A front that never moves is not a front: the weight has to buy *something*,
		// or F3's two axes are the same axis on this scenario and the honest answer is
		// to say so rather than to draw a line through a single point.
		const interferenceRange =
			Math.max(...front.map((f) => f.interference)) - Math.min(...front.map((f) => f.interference));
		const coverageRange =
			Math.max(...front.map((f) => f.coverage)) - Math.min(...front.map((f) => f.coverage));
		expect(interferenceRange + coverageRange).toBeGreaterThan(1);
	});
});
