/**
 * The optimiser’s observable state.
 *
 * Its own module so the run and the real-time coverage pass can both read it without
 * importing each other: they are two consumers of the same numbers and nothing more.
 * The per-floor coverage cache lives here for the same reason.
 */
import { SvelteMap } from 'svelte/reactivity';
import { apState, wupmForFloor } from './ap-state.svelte.js';
import { currentFloor, floorState } from './floor-state.svelte.js';
import { isInsideInterior } from './ap-interior.js';
import { projectMeta } from './project-meta.svelte.js';
import { isUsablePlanningArea, pointInPlanningArea } from './planning-area.js';



export const optimizerState = $state({
	isRunning: false,
	progress: 0,
	score: 0,
	coverage: 0, // real-time coverage percentage, updated on AP/mask changes
	error: null as string | null,
	/** What a multi-floor run is doing right now, e.g. "Floor 2 of 3, pass 1". */
	status: '',
	/**
	 * Building-wide coverage from the last all-floor run, as a density-weighted
	 * mean over floors. Null when no all-floor run has happened.
	 */
	buildingCoverage: null as number | null,
	/** Weakest floor from the last all-floor run: its percentage and its name. */
	worstFloor: null as { id: string; name: string; coverage: number } | null,
	/**
	 * Co-channel interference share of the current layout, as a percentage, from
	 * the last run that evaluated it. The other half of what the objective trades
	 * off against coverage: the optimiser's score is
	 * `coverageUtility − interferenceWeight · interference`.
	 */
	interference: 0,
	/**
	 * Share of the floor where two APs on overlapping channels are both above the CCA
	 * threshold (≈ −82 dBm at 20 MHz), as a percentage.
	 *
	 * Airtime the plan shares, reported and **not** optimised. It is the half of
	 * "interference" a relative criterion cannot see: two co-channel APs can be far
	 * enough apart in level for the interference term to read 0% while every station
	 * between them still defers to the other. See `ROADMAP.md` B4/B5.
	 */
	contention: 0,
	/**
	 * True once a run has measured the interference figures for the layout on screen.
	 *
	 * Both bars read 0% before that, which is not a measurement but a default — and a
	 * panel that says "0% interference" about a plan nobody has scored is worse than one
	 * that shows nothing. The coverage bar is gated the same way (`coverage > 0`).
	 */
	interferenceMeasured: false,
	/**
	 * False when `interference` was measured against the all-co-channel bound
	 * because some AP had no channel yet. It is then an upper bound, not the
	 * current plan's figure.
	 */
	interferenceKnown: true,
	/** How many alternating passes the last all-floor run took. */
	passes: 0,
	/**
	 * How many times to run the optimiser on a floor and keep the best result.
	 *
	 * Default 1, which is the previous behaviour. Above 1 each run starts from a
	 * different seed, so the comparison is between genuinely different attempts
	 * rather than the same one repeated — the PRNG is seeded and deterministic.
	 */
	restarts: 1,
	/**
	 * When the last run finished, as an epoch millisecond, or null if none has.
	 *
	 * A timestamp rather than a boolean because the placement advice panel has to
	 * be able to tell one run from the next: it pops up on a completed run, is
	 * dismissible, and has to come back after the *next* one. Comparing the value
	 * is how "a new measurement arrived" is expressed without a second flag that
	 * can be left stale.
	 */
	lastRunAt: null as number | null
});

/**
 * Per-floor coverage cache: floorId →{ coverage %, sampleCount (proxy for area) }.
 *
 * A `SvelteMap` rather than a plain `Map`. The panel derives both the building mean and
 * the weakest floor from this cache, and a plain `Map` is not reactive: `$derived` saw
 * no dependency, so after "Optimise all floors" the per-floor rows were right while the
 * building row and the weakest-floor line kept the values from the first render.
 */
export const floorCoverage = new SvelteMap<string, FloorCoverageEntry>();

/**
 * A coverage figure and the plan it was measured on.
 *
 * `basis` is what makes the figure usable: without it the panel, the building mean and the
 * PDF report all keep printing a measurement of a plan that no longer exists. It is
 * deliberately not persisted (`toDocument` writes the figure and its sample count only), so a
 * figure that comes back from disk arrives without one and is dropped on the next pass —
 * which is the honest reading, because it was measured by a previous session against a state
 * this one has not verified.
 */
export interface FloorCoverageEntry {
	coverage: number;
	samples: number;
	/** The plan the figure describes. Absent on anything restored from a file. */
	basis?: string;
}

/** Identity of a mask object, for the basis below. */
const maskIds = new WeakMap<object, number>();
let nextMaskId = 1;
function maskId(mask: object | null | undefined): string {
	if (!mask) return '0';
	let id = maskIds.get(mask);
	if (id === undefined) {
		id = nextMaskId++;
		maskIds.set(mask, id);
	}
	return String(id);
}

/**
 * The plan a floor's coverage figure is a measurement *of*.
 *
 * Everything the pass reads, in one string: the walls and the mask they were rasterised into,
 * where that mask sits, the materials, the calibration (the figure is an area share, and the
 * area comes from the scale), and every access point on the floor with the power and channel
 * the pass scored it at. Two states with the same basis produce the same figure, which is the
 * whole point — a changed one produces a new string and the old figure is dropped.
 */
export function coverageBasis(floorId: string): string {
	const floor = floorState.floors.find((f) => f.id === floorId);
	if (!floor) return 'missing';
	const aps = apState.aps
		.filter((ap) => ap.floorId === floorId)
		.map(
			(ap) =>
				`${ap.id}:${Math.round(ap.x)},${Math.round(ap.y)}:${ap.power}:` +
				`${ap.band}:${ap.channelWidth}:${ap.assignedChannel ?? ''}:${ap.mount}`
		)
		.sort()
		.join('|');
	const mask = floor.wallMask;
	return [
		maskId(mask),
		mask ? `${mask.width}x${mask.height}@${mask.originX ?? 0},${mask.originY ?? 0}` : 'no-mask',
		maskId(floor.materialMask),
		maskId(floor.roomTypeMask),
		floor.wallMaterial,
		Math.round(wupmForFloor(floorId) * 100),
		aps
	].join('~');
}

/**
 * Forget every coverage figure that no longer describes the plan.
 *
 * Called at the start of each pass. Only the current floor can be edited — its walls, its
 * calibration, the access points standing on it — so a sweep at every recomputation covers
 * every floor that could have changed, and a floor that was never visited has no entry to
 * drop.
 */
export function dropStaleCoverage(): void {
	for (const [floorId, entry] of floorCoverage) {
		if (entry.basis !== coverageBasis(floorId)) floorCoverage.delete(floorId);
	}
}

/**
 * The access points that sit outside their floor's detected interior, by name.
 *
 * A plan saved before the detection agreed with itself — or one whose access point was
 * dropped in by hand — can carry an AP in the margin outside the walls, and nothing used to
 * say so. The callers are the components that can show it: the state module must not import
 * app state, because `app.svelte.ts` reaches this module through persistence and the cycle
 * leaves the optimiser half-initialised at load.
 *
 * Returns an empty list while a floor's mask is still undecoded: the check is meaningless
 * before there are walls to judge against, and it is re-run when the mask arrives.
 */
export async function apsOutsideInterior(): Promise<string[]> {
	if (projectMeta.allowOutsideRooms) return [];
	const outside: string[] = [];
	/*
	 * The drawn planning area decides, when there is one.
	 *
	 * It is the user's own statement of where the floor is, so a point outside it is outside
	 * the floor by definition — no inference about whether a doorway means "outside", no
	 * morphology, nothing to argue with. Without one the detected interior is still the only
	 * answer there is, and that is where the walls' sealing applies.
	 */
	const planned = currentFloor().planningArea;
	const hasPlan = isUsablePlanningArea(planned);
	for (const ap of apState.aps) {
		/*
		 * A wall mount is on a wall by construction, and the inferred interior
		 * deliberately trims the ring of pixels against every wall (`trimWallAdjacent`) —
		 * so judging one there reports every bracket in the building as outside. That is
		 * what made the warning stand on a wall mount and re-appear on every later edit,
		 * including a facing change. Placement already refuses to put a wall mount away
		 * from a wall, so there is nothing left for this check to add.
		 */
		if (ap.mount === 'wall') continue;
		const inside = hasPlan
			? pointInPlanningArea({ x: ap.x, y: ap.y }, planned!)
			: await isInsideInterior(ap.floorId, ap.x, ap.y);
		if (!inside) outside.push(ap.name);
	}
	return outside;
}

/** Weighted average coverage across all floors with data. */
export function getBuildingCoverage(): number {
	if (floorCoverage.size === 0) return 0;
	let totalWeighted = 0;
	let totalSamples = 0;
	for (const { coverage, samples } of floorCoverage.values()) {
		totalWeighted += coverage * samples;
		totalSamples += samples;
	}
	return totalSamples > 0 ? Math.round(totalWeighted / totalSamples) : 0;
}