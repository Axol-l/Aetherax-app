import { SvelteMap } from 'svelte/reactivity';
import { updateAp, beginMove } from './project.svelte.js';
import { apHeightAboveFloor, apSplitFor, apVerticalOffsetTo, antennaProfileFor, getEffectiveWupm, type AccessPoint } from './ap-state.svelte.js';
import { antennaRayLossDb } from '$lib/rf/antenna.js';
import { surfaceHeightAt, deckCrossing } from '$lib/rf/surface-height.js';
import type { Band, ChannelWidth } from '@aetherax/channels';
import { scheduleSave } from './persistence.svelte.js';
import { t } from './i18n.svelte.js';
import { decodeMask, type DecodedWallMask } from '$canvas/wall-detect.js';
import { decodeMaterialMask } from '$canvas/region-labels.js';
import { getMaterialDbTable } from '$canvas/materials.js';
import { computeBuildingInterior } from '$canvas/morphology.js';
import {
	COVERAGE_MARGIN_DB,
	coverageMarginDb,
	coverageHorizontalReach,
		rayMarchWallAtten,
	slabDbOf
} from '$lib/rf/propagation.js';
import {
	crossFloorSegments,
	pointAlong,
	slabIsVoid,
	slabLossFactor,
	type SlabCrossing
} from '$lib/rf/cross-floor.js';
import { crossingSlabsFor as crossingSlabsForFloors } from '$lib/rf/slab-crossings.js';
import { labelRooms } from '$canvas/region-labels.js';
import { ROOM_TYPES, getRoomType, isVoidRoomType } from '$canvas/room-types.js';
import { OptimizerBridge, type OptimizeProgress } from '../workers/optimizer-bridge.js';
import {
	floorState,
	currentFloor,
	getFloor,
	getFloorSlabAttenuation,
	boundarySlabLossDb,
	crossFloorVerticalGap,
	crossFloorSplitFor,
	floorElevation,
	floorsByLevel,
	type Floor
} from './floor-state.svelte.js';
import { getFloorMask } from './floor-mask.js';
import { isInsideInterior } from './ap-interior.js';
import { projectMeta } from './project-meta.svelte.js';
import { wallState } from './wall-state.svelte.js';
import { WALL_BAND_M, wallSnapForFloor } from './wall-snap.js';
import { minRoomRadiusWu } from './room-domain.js';
import { clipInteriorToPlanningArea, isUsablePlanningArea, pointInPlanningArea } from './planning-area.js';
import { OPTIMIZER_PAYLOAD_VERSION, type ApInput } from '../workers/optimizer-protocol.js';
import { apState } from '$state/ap-state.svelte.js';
import { canvasState } from '$state/canvas.svelte.js';

/** The pass a drag deferred; see `updateCoverage`. */
let coverageAfterDrag: ReturnType<typeof setTimeout> | null = null;

const bridge = new OptimizerBridge();

/**
 * A second worker, used only for conflict-graph requests.
 *
 * The two must not share one: `OptimizerBridge` rejects a request that is still
 * pending when the next one arrives ("Superseded"), which is right for runs of the
 * same kind — a new placement run should replace an old one — and wrong across
 * kinds. Auto-assignment asks for a graph on every AP move, so a solve landing
 * while a run was in flight would kill the run, and the user would see a click on
 * Optimize Placement do nothing but report "Superseded".
 */
const graphBridge = new OptimizerBridge();

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
export const floorCoverage = new SvelteMap<string, { coverage: number; samples: number }>();

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

// Cached interior sample points and decoded mask for real-time coverage
let cachedMaskUrl: string | null = null;
let cachedMask: DecodedWallMask | null = null;
let cachedSamples: Array<{ x: number; y: number }> | null = null;
let cachedSamplePixelIdx: number[] | null = null;
/**
 * The density map and the inputs it was built from. See the use site for why this is
 * cached; the key is what makes the cache safe.
 */
let densityCache: Awaited<ReturnType<typeof buildDensityMap>> | null = null;
let densityCacheKey = '';
/** The key currently being built off the critical path, so a second request does not start it twice. */
let densityBuilding: string | null = null;

/**
 * Build a floor's density map without blocking the figure the user is watching.
 *
 * Yields to the event loop first — the caller has just finished a pass and a re-render is
 * queued — then builds, stores against its key, and re-runs the coverage so the number
 * ends up weighted. Recursion is safe: the re-run finds the cache warm and does not
 * schedule another build.
 */
function buildDensityInBackground(
	key: string,
	width: number,
	height: number,
	floor: Floor
): void {
	if (densityBuilding === key) return;
	densityBuilding = key;
	setTimeout(() => {
		void (async () => {
			try {
				const built = await buildDensityMap(width, height, floor);
				// The floor or its mask may have changed while this ran; only keep a result
				// that still describes what the key says.
				densityCache = built;
				densityCacheKey = key;
				await updateCoverage();
			} catch {
				// A failed density build leaves the uniform figure standing, which is a
				// slightly less precise number rather than a broken one.
			} finally {
				if (densityBuilding === key) densityBuilding = null;
			}
		})();
	}, 0);
}
/** Decoded per-pixel wall material ids for the cached mask, or null if none. */
let cachedMaterialData: Uint8Array | null = null;

async function ensureCoverageCache(): Promise<boolean> {
	const mask = wallState.wallMask;
	if (!mask) return false;
	if (mask.dataUrl === cachedMaskUrl && cachedMask && cachedSamples) return true;

	cachedMask = await decodeMask(mask.dataUrl, mask.width, mask.height);
	// decodeMask only turns a data URL back into pixels, so it always reports an
	// origin of (0,0). The real origin lives on the stored mask and is what the
	// canvas offsets everything by. Without copying it here this whole function
	// compares mask-space sample points against world-space AP coordinates, so
	// every distance comes out inflated by the origin, every sample falls outside
	// the 1.5x radius cutoff, and coverage reads as a flat 0.
	cachedMask.originX = mask.originX ?? 0;
	cachedMask.originY = mask.originY ?? 0;
	cachedMaskUrl = mask.dataUrl;

	// Decode wall materials too: without them the loss path cannot tell a real
	// wall from a zero-attenuation virtual partition.
	const matMask = wallState.materialMask;
	cachedMaterialData =
		matMask && matMask.width === mask.width && matMask.height === mask.height
			? await decodeMaterialMask(matMask.dataUrl, matMask.width, matMask.height)
			: null;

	const { interior } = computeBuildingInterior(cachedMask.data, mask.width, mask.height, {
		maxDim: 400,
		dilateRatio: 0.04,
		minDilateR: 4,
		// The coverage sample set: the same domain the optimiser places in — including
		// which regions count as rooms, so a cavity is not counted as floor area that
		// needs covering either. See `room-domain.ts`.
		trimWallAdjacent: true,
		minRegionRadius: minRoomRadiusWu()
	});

	/*
	 * And, if the user has drawn one, the planning area — the same authority the "is this
	 * point inside?" guard uses. Without this the coverage figure would still be measured
	 * over the inferred interior, so a plan whose outline has a wide opening would report
	 * coverage for floor the user has explicitly excluded, and the optimiser would be scored
	 * on a bigger area than the one being planned.
	 */
	const currentFloorForArea = floorState.floors.find((f) => f.id === floorState.currentFloorId);
	if (isUsablePlanningArea(currentFloorForArea?.planningArea)) {
		clipInteriorToPlanningArea(
			interior,
			mask.width,
			mask.height,
			mask.originX ?? 0,
			mask.originY ?? 0,
			currentFloorForArea!.planningArea!
		);
	}

	const interiorPixels: number[] = [];
	for (let i = 0; i < mask.width * mask.height; i++) {
		if (interior[i]) interiorPixels.push(i);
	}

	/*
	 * How many points the live coverage figure is sampled at.
	 *
	 * Two hundred was chosen when a plan had one or two access points; on a six-storey
	 * building every sample is scored against every unit in it, and the pass took about a
	 * second. A hundred and forty is a proportion to within a couple of percentage points —
	 * the figure is a live readout and the optimiser scores on its own larger sample set in
	 * the worker — for 30 % less work per run.
	 */
	const sampleCount = Math.min(140, interiorPixels.length);
	const step = interiorPixels.length / sampleCount;
	cachedSamples = [];
	cachedSamplePixelIdx = [];
	for (let i = 0; i < sampleCount; i++) {
		const idx = interiorPixels[Math.floor(i * step)]!;
		cachedSamples.push({ x: idx % mask.width, y: Math.floor(idx / mask.width) });
		cachedSamplePixelIdx.push(idx);
	}

	return cachedSamples.length > 0;
}

/** Compute real-time coverage score from current AP positions */
export async function updateCoverage(): Promise<void> {
	/*
	 * Not while an access point is being dragged.
	 *
	 * A pass samples the floor against every AP and marches walls for each pair — on a real
	 * plan that is tens of milliseconds to a second. The drag is already finished by then,
	 * so the figure was both late and expensive: it landed as a stall in the middle of the
	 * gesture. The move handler schedules the trailing pass (`canvasState.isDragging` goes
	 * false on pointer-up), so the number is still right the moment the drag ends.
	 */
	if (canvasState.isDragging) {
		if (coverageAfterDrag) clearTimeout(coverageAfterDrag);
		coverageAfterDrag = setTimeout(() => {
			coverageAfterDrag = null;
			if (!canvasState.isDragging) void updateCoverage();
		}, 300);
		return;
	}
	if (apState.aps.length === 0 || !wallState.wallMask) {
		optimizerState.coverage = 0;
		return;
	}

	if (!(await ensureCoverageCache()) || !cachedMask || !cachedSamples) {
		// Coverage silently reads 0 and the bar disappears when this fails, which
		// is indistinguishable from genuinely zero coverage. Say why.
		console.warn(
			'[optimizer] coverage unavailable:',
			cachedMask ? 'wall mask decoded' : 'wall mask NOT decoded',
			cachedSamples ? 'samples ready' : 'NO interior samples - is any room enclosed by walls?'
		);
		optimizerState.coverage = 0;
		return;
	}

	const { data, width, height } = cachedMask;
	const ox = cachedMask.originX ?? 0;
	const oy = cachedMask.originY ?? 0;
	const wallDb = wallState.wallAttenuation;

	// Per-band material tables. rayMarchWallAtten takes one table per call, so a
	// Map keyed by band is what lets each AP be evaluated on its own band. The table is the
	// flat per-crossing figure (`dbPerMeter × typicalThickness`): one wall costs what the
	// material says a wall costs, not how wide the drawing or the material brush happens to be.
	const materialTables = new Map<Band, number[]>();
	const tablesFor = (band: Band) => {
		let t = materialTables.get(band);
		if (!t) {
			t = getMaterialDbTable(band);
			materialTables.set(band, t);
		}
		return t;
	};

	/*
	 * The density map, cached rather than rebuilt — and built in the background the first
	 * time a floor is measured.
	 *
	 * `buildDensityMap` is a whole-mask pass: the interior, the room labels and a weight for
	 * every pixel. It used to run inside every coverage update on the theory that it was
	 * cheap; on a million-pixel plan it is the bulk of a pass that takes about a second, and
	 * the pass re-runs whenever an access point moves. Caching it made a drag cost 4 ms
	 * instead of a second, but the *first* pass over a floor still paid for it, which is the
	 * stall felt when a five-storey plan is opened with the heatmap on.
	 *
	 * So the first pass measures with uniform weights — which every consumer already
	 * supports, `densityResult` is allowed to be null — and the map is built afterwards,
	 * off the critical path, re-running the figure once so nothing is left silently
	 * unweighted. The key is exactly what the map reads: floor, raster, room types and the
	 * room overrides.
	 */
	const densityFloor = currentFloor();
	const densityKey = [
		densityFloor.id,
		`${width}x${height}`,
		cachedMaskUrl ?? '',
		wallState.roomTypeMask?.dataUrl ?? '',
		JSON.stringify(densityFloor.roomDensityOverrides ?? {}),
		JSON.stringify(densityFloor.roomCustomLabels ?? {})
	].join('|');
	if (densityKey !== densityCacheKey) {
		if (densityCache) densityCache = null;
		buildDensityInBackground(densityKey, width, height, densityFloor);
	}
	const densityResult = densityCache;
	const baseline = densityResult
		? densityResult.medianDensity > 0
			? densityResult.medianDensity
			: 0.3
		: 0.3;
	const sampleDensity: number[] = [];
	for (let i = 0; i < cachedSamples.length; i++) {
		if (densityResult && cachedSamplePixelIdx) {
			const raw = densityResult.map[cachedSamplePixelIdx[i]!]!;
			sampleDensity.push(raw >= 0 ? raw : baseline);
		} else {
			sampleDensity.push(1);
		}
	}
	// All-zero densities → fall back to uniform (avoids division by zero)
	if (Math.max(...sampleDensity) <= 0) {
		for (let i = 0; i < sampleDensity.length; i++) sampleDensity[i] = 1;
	}

	// Include virtual APs from other floors as fixed signal sources
	const curFloorId = floorState.currentFloorId;
	const localAps = apState.aps.filter((ap) => ap.floorId === curFloorId);
	const virtualAps: Array<
		(typeof apState.aps)[0] & {
			signalScale: number;
			verticalGapWu: number;
			source: Awaited<ReturnType<typeof sourceFloorMaskFor>>;
			sourceT: number;
			targetT: number;
			/**
			 * Every storey boundary this path crosses, with the room types of the
			 * floor that owns each slab and the share of the aggregate loss charged
			 * there. Empty when nothing can be tested.
			 *
			 * Per AP: the shares come from the slab loss, which is band dependent,
			 * and the crossing fractions come from the ray's slope, which depends on
			 * where the AP is mounted. Two APs on one floor therefore need two lists,
			 * and the shared ones are shared by reference.
			 */
			slabs: SlabCrossing[];
		}
	> = [];
	const wupmForGap = getEffectiveWupm();
	for (const otherFloor of floorState.floors) {
		if (otherFloor.id === curFloorId) continue;
		const otherAps = apState.aps.filter((ap) => ap.floorId === otherFloor.id);
		if (otherAps.length === 0) continue;
		// The vertical gap enters the *distance* as well as the loss: an AP two
		// storeys away is further away, not merely more attenuated. The heatmap has
		// always modelled that and the optimiser did not, so the two disagreed
		// about how far a cross-floor AP reaches.
		//
		// Per AP, because where the access point is mounted is a property of the AP:
		// one on a desk is a metre lower than one on the ceiling of the same storey,
		// and the two are not the same distance from the client. The path is split at
		// the slab, same as the optimiser worker and the heatmap: the AP's own
		// floor's walls to the crossing, then this floor's.
		//
		// Cached per floor, so this costs no extra decode on the drag path.
		const source = await sourceFloorMaskFor(otherFloor.id, ox, oy);
		// Slab loss is band dependent, so derive it per AP from its own band rather
		// than applying one 5 GHz figure to the whole floor. The crossing shares
		// depend on the band *and* on the mount height — the ray's slope decides
		// which planes it meets and where — so both go in the key and the list is
		// built once per pair rather than once per AP.
		const slabsByKey = new Map<string, SlabCrossing[]>();
		for (const ap of otherAps) {
			const apHeightM = apHeightAboveFloor(ap);
			const key = `${ap.band}|${apHeightM}`;
			if (!slabsByKey.has(key)) {
				slabsByKey.set(
					key,
					(await crossingSlabsFor(
						otherFloor.id,
						curFloorId,
						projectMeta.clientHeight,
						ap.band,
						ox,
						oy,
						densityResult?.roomTypeData ?? null,
						apHeightM
					)) ?? []
				);
			}
			const split = apSplitFor(ap, curFloorId, projectMeta.clientHeight);
			virtualAps.push({
				...ap,
				signalScale: Math.pow(10, -getFloorSlabAttenuation(curFloorId, otherFloor.id, ap.band) / 10),
				verticalGapWu: apVerticalOffsetTo(ap, curFloorId, projectMeta.clientHeight) * wupmForGap,
				source,
				sourceT: split.sourceT,
				targetT: split.targetT,
				slabs: slabsByKey.get(key) ?? []
			});
		}
	}
	const allAps = [
		...localAps.map((ap) => ({
			...ap,
			signalScale: 1,
			// A same-floor path is flat while mounting heights are off, and the
			// AP-to-client height difference once they are on.
			verticalGapWu: apVerticalOffsetTo(ap, curFloorId, projectMeta.clientHeight) * wupmForGap,
			source: null as Awaited<ReturnType<typeof sourceFloorMaskFor>>,
			sourceT: 0,
			targetT: 0,
			slabs: [] as SlabCrossing[]
		})),
		...virtualAps
	];

	// Coverage is the share of (density-weighted) floor area that lies inside at
	// least one AP's coverage circle, i.e. where the received margin is >= 0.
	//
	// It used to be the mean of the optimiser's utility, which is a different
	// quantity wearing the same label: the utility saturates 10 dB above the
	// threshold, so anywhere with signal to spare scored a full 1.0 and the
	// figure drifted up towards 100% without any change in geometry. "98%" now
	// means what it says — 98% of the sampled floor is within range — and it is
	// the same area the heatmap colours in at its default floor.
	let coveredWeight = 0;
	let totalWeight = 0;

	/*
	 * How high the client stands at each sample: a mezzanine's desks are two metres
	 * closer to a ceiling-mounted AP than the floor's are, and a stair climbs between
	 * the two. The field is in metres, the gap below is in world units, so the scale
	 * converts it once here rather than at every use.
	 */
	const surfaces = currentFloor().surfaces ?? [];
	const surfaceWupm = getEffectiveWupm();
	const sampleHeightWu = cachedSamples.map(
		(sample) => surfaceHeightAt(surfaces, sample.x + ox, sample.y + oy) * surfaceWupm
	);

	for (let i = 0; i < cachedSamples.length; i++) {
		const sample = cachedSamples[i]!;
		let bestMargin = -Infinity;
		for (const ap of allAps) {
			const dx = sample.x - (ap.x - ox);
			const dy = sample.y - (ap.y - oy);
			// The AP–client gap, less whatever the client is standing on. Signed: a
			// client two metres up a mezzanine can be *above* a desk-mounted AP.
			const vertical = ap.verticalGapWu - (sampleHeightWu[i] ?? 0);
			const horiz = Math.sqrt(dx * dx + dy * dy);
			/*
			 * Distance before anything else, and on the **best case**: the furthest a source
			 * could reach at all, with no slab in the way and no wall on the path.
			 *
			 * On a five-storey plan every sample used to pay for every access point in the
			 * building — the slab waiver, the cross-floor segment split and a wall march —
			 * including the units five floors away that cannot contribute anything. This
			 * test is a subtraction and two multiplications, and it discards those before
			 * the expensive part. It can only ever be conservative: the reach it compares
			 * against is the ceiling for zero loss, so a source that fails here cannot pass
			 * the real test further down.
			 */
			if (horiz > coverageHorizontalReach(ap.interferenceRadius, 0, 0)) continue;
			// Cross-floor paths are 3D, matching the heatmap. The gap is signed once a
			// client can be above the floor, and a distance is its magnitude.
			const dist = vertical !== 0 ? Math.hypot(horiz, vertical) : horiz;
			// Same dB-domain kernel as the optimiser worker. `coverageReach` is the
			// 3D distance at which the margin runs out, so the horizontal test has to
			// give up whatever the vertical gap already consumed.
			//
			// The waiver has to be decided *before* that test: with a full slab's loss
			// the 3D reach can be shorter than the vertical gap, and the source is then
			// discarded before anything gets a chance to notice the slab is a hole.
			const slabDb = slabDbOf(ap.signalScale);
			// A void is a hole in a slab, so a ray crossing one pays that boundary's
			// share less. A taller gap crosses several, which is why this is a
			// multiplier over the whole crossing list rather than a flag.
			const crossings = ap.slabs;
			const slabLoss =
				crossings && crossings.length > 0
					? slabDb * slabLossFactor(crossings, ap.x - ox, ap.y - oy, sample.x, sample.y)
					: slabDb;
			if (horiz >= coverageHorizontalReach(ap.interferenceRadius, slabLoss, vertical)) continue;
			// Material-aware, matching the optimiser worker and the heatmap: one flat figure
			// per crossing out of the material table, so a zero-attenuation virtual partition
			// costs nothing and a material costs what its own measured entry says.
			let dbLoss: number;
			const segments = ap.source
				? crossFloorSegments(ap.sourceT, ap.targetT, ap.x - ox, ap.y - oy, sample.x, sample.y)
				: null;
			if (ap.source && segments) {
				// Two runs on two plans: the AP's own floor up to the slab crossing, then
				// this floor's from the crossing to the sample.
				const src = ap.source;
				// The path descends by this AP's vertical gap, so its material path is longer
				// than its plan path by this factor. From the **whole** ray, not per segment:
				// one straight ray drops one gap, so both halves share one ratio.
				dbLoss =
					rayMarchWallAtten(
						src.data,
						src.width,
						src.height,
						src.materialMask,
						tablesFor(ap.band),
						src.materialMask ? (tablesFor(ap.band)[src.defaultMaterial] ?? wallDb) : wallDb,
						segments.source.from.x - src.originX,
						segments.source.from.y - src.originY,
						segments.source.to.x - src.originX,
						segments.source.to.y - src.originY,
						1,
						src.defaultMaterial
					) +
					rayMarchWallAtten(
						data,
						width,
						height,
						cachedMaterialData,
						tablesFor(ap.band),
						wallDb,
						segments.target.from.x,
						segments.target.from.y,
						segments.target.to.x,
						segments.target.to.y,
						1,
						wallState.wallMaterial
					);
			} else {
				// A same-floor path, marched against this floor's own material map.
				dbLoss = rayMarchWallAtten(
					data,
					width,
					height,
					cachedMaterialData,
					tablesFor(ap.band),
					wallDb,
					ap.x - ox,
					ap.y - oy,
					sample.x,
					sample.y,
					1,
					wallState.wallMaterial
				);
			}
			// A void is a hole in the slab, so a ray crossing there pays no slab loss.
			dbLoss += slabLoss;
			// A deck between this AP and a client standing on it: a path from below has to
			// pass through the slab, and that is what the surface's attenuation is for. Only
			// a sample that is on a deck can cross one, which is the cheap guard.
			const deck =
				(sampleHeightWu[i] ?? 0) > 0
					? deckCrossing(surfaces, sample.x + ox, sample.y + oy, vertical / surfaceWupm)
					: null;
			if (deck) dbLoss += deck.lossDb;
			// The antenna's cuts, from the geometry of this ray: an AP ten metres away
			// on the same floor is near the peak of an upright omni, one almost
			// overhead is in the weak part of its doughnut — and a wall-mounted unit
			// has a front and a back on top of that. Matches the heatmap.
			dbLoss += antennaRayLossDb(antennaProfileFor(ap), vertical, dx, dy);
			const margin = coverageMarginDb(dist, ap.interferenceRadius) - dbLoss;
			if (margin > bestMargin) bestMargin = margin;
		}
		const w = sampleDensity[i] ?? 1;
		// `coverageMarginDb` is measured over the association floor (-85 dBm), so
		// the coverage threshold (-70 dBm) has to be cleared explicitly.
		if (bestMargin >= COVERAGE_MARGIN_DB) coveredWeight += w;
		totalWeight += w;
	}

	optimizerState.coverage = totalWeight > 0 ? Math.round((coveredWeight / totalWeight) * 100) : 0;

	// Cache per-floor coverage (weighted by sample count as area proxy)
	floorCoverage.set(curFloorId, {
		coverage: optimizerState.coverage,
		samples: cachedSamples.length
	});
}

interface DensityMapResult {
	map: Float32Array;
	medianDensity: number;
	/**
	 * The raw room type ids the density map was built from.
	 *
	 * Needed because a void contributes no density but does change the geometry:
	 * the optimiser has to know which pixels are holes, and it cannot recover that
	 * from a density of zero, which is also a legitimate density for a room.
	 */
	roomTypeData: Uint8Array;
}

/**
 * Build a per-pixel device density map (Float32Array, same dims as wall mask).
 * Combines room type default densities with per-region overrides.
 * Returns null if no room type data is available.
 */
// ─── Density-map input caching ─────────────────────────────────────
//
// Density overrides change on every slider tick, but the inputs they are
// combined with do not. Recomputing them per tick meant two PNG decodes, a
// morphological close, a connected-component labelling pass and a sort over
// every labelled pixel — that is what made dragging a density slider stutter.
//
// Cached against the object identity of the stored mask wrappers. Those are
// replaced wholesale whenever their contents change, so identity is a sound key
// and avoids comparing multi-megabyte data URLs on every call.

let densityRtMaskRef: unknown = null;
let densityRtData: Uint8Array | null = null;

async function getRoomTypeData(rtMask: {
	dataUrl: string;
	width: number;
	height: number;
}): Promise<Uint8Array> {
	if (densityRtMaskRef === rtMask && densityRtData) return densityRtData;
	densityRtData = await decodeMaterialMask(rtMask.dataUrl, rtMask.width, rtMask.height);
	densityRtMaskRef = rtMask;
	return densityRtData;
}

let densityWallMaskRef: unknown = null;
let densityRoomLabels: Int32Array | null = null;

async function getDensityRoomLabels(
	maskWidth: number,
	maskHeight: number,
	wallMask: { dataUrl: string; width: number; height: number } | null
): Promise<Int32Array | null> {
	// Taken as a parameter rather than read from `wallState`, which only ever holds
	// the *current* floor's mask, while an all-floor run optimises floors other
	// than the one on screen.
	const wm = wallMask;
	if (!wm) return null;
	if (densityWallMaskRef === wm && densityRoomLabels) return densityRoomLabels;
	const decoded = await decodeMask(wm.dataUrl, wm.width, wm.height);
	const { interior } = computeBuildingInterior(decoded.data, maskWidth, maskHeight, {
		maxDim: 400,
		dilateRatio: 0.04,
		minDilateR: 4,
		// Rooms, not cavities: this drives the per-room density the objective weights
		// samples by, and a wall cavity is not a room with an occupancy. See `room-domain.ts`.
		minRegionRadius: minRoomRadiusWu()
	});
	densityRoomLabels = labelRooms(interior, maskWidth, maskHeight).labels;
	densityWallMaskRef = wm;
	return densityRoomLabels;
}

async function buildDensityMap(
	maskWidth: number,
	maskHeight: number,
	floor: Floor
): Promise<DensityMapResult | null> {
	const rtMask = floor.roomTypeMask;
	if (!rtMask || rtMask.width !== maskWidth || rtMask.height !== maskHeight) return null;

	const rtData = await getRoomTypeData(rtMask);
	const overrides = floor.roomDensityOverrides ?? {};

	// -1 = unlabeled (use median baseline), >= 0 = explicit density (including 0)
	const densityMap = new Float32Array(maskWidth * maskHeight).fill(-1);
	let hasAnyLabeled = false;

	// Type ID -> default density lookup
	const typeDensity = new Map<number, number>();
	for (const t of ROOM_TYPES) typeDensity.set(t.id, t.defaultDensity);

	// Histogram of labelled densities. The median is only used as a baseline for
	// unlabelled pixels, so counting distinct values avoids sorting up to a few
	// million entries on every rebuild.
	const counts = new Map<number, number>();
	let labeledCount = 0;

	for (let i = 0; i < rtData.length; i++) {
		const typeId = rtData[i]!;
		if (typeId === 0) continue;
		// A void is a hole, not a room. Counting it as a zero-density room would
		// drag the median baseline down and make every unlabelled pixel count for
		// less, which is the opposite of what a hole should do.
		if (isVoidRoomType(typeId)) continue;
		const d = typeDensity.get(typeId) ?? 0;
		densityMap[i] = d;
		counts.set(d, (counts.get(d) ?? 0) + 1);
		labeledCount++;
		hasAnyLabeled = true;
	}

	// Apply per-region density overrides if we have room labels
	if (Object.keys(overrides).length > 0) {
		const labels = await getDensityRoomLabels(maskWidth, maskHeight, floor.wallMask);
		if (labels) {
			for (let i = 0; i < labels.length; i++) {
				const regionId = labels[i]!;
				if (regionId < 0) continue;
				const override = overrides[String(regionId)];
				if (override === undefined) continue;
				const prev = densityMap[i]!;
				if (prev >= 0) counts.set(prev, (counts.get(prev) ?? 0) - 1);
				else labeledCount++;
				densityMap[i] = override;
				counts.set(override, (counts.get(override) ?? 0) + 1);
				hasAnyLabeled = true;
			}
		}
	}

	if (!hasAnyLabeled) return null;

	// Median of labelled densities, taken from the histogram.
	let medianDensity = 0.3;
	if (labeledCount > 0) {
		const target = labeledCount >> 1;
		let acc = 0;
		for (const [value, count] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
			if (count <= 0) continue;
			acc += count;
			if (acc > target) {
				medianDensity = value;
				break;
			}
		}
	}

	return { map: densityMap, medianDensity, roomTypeData: rtData };
}

/** What one floor's optimisation produced, for the caller to aggregate. */
interface FloorOutcome {
	floorId: string;
	/** Covered share of the floor, 0..1, on the same definition the panel shows. */
	coverage: number;
	/** Co-channel interference share, 0..1. See `optimizerState.interference`. */
	interference: number;
	/**
	 * Airtime share with two overlapping-channel APs above the CCA threshold, 0..1.
	 * Reported, not optimised. See `optimizerState.contention`.
	 */
	contention: number;
	/** False when the interference share was measured against the worst case. */
	interferenceKnown: boolean;
	/** Samples it was computed from, used to weight floors against each other. */
	samples: number;
	score: number;
	ok: boolean;
	/** Where the APs would go, in world coordinates. */
	positions: Array<{ id: string; x: number; y: number }>;
	/**
	 * The conflict graph of the floor's own plan, present only on a graph request
	 * (`{ graphOnly: true }`). `sourceIds` names the payload's sources in the
	 * worker's order — its APs first, then the fixed APs — so `pairs` can be read
	 * as AP ids. See `buildAssignmentConflictEdges`.
	 */
	graph?: { pairs: Array<[number, number]>; count: number; weights?: number[] };
	sourceIds?: string[];
}

/** How one floor run should behave. */
interface FloorRunOptions {
	/** PRNG seed. Omit for the worker's fixed default, which is deterministic. */
	seed?: number;
	/**
	 * False to score a result without moving anything. The multi-start run needs
	 * to compare several attempts before committing to one, and applying on the
	 * way would leave the plan oscillating through the losers.
	 */
	apply?: boolean;
	/**
	 * Ask the worker for the floor's conflict graph instead of a placement. Used by
	 * the solver, which has to colour the same graph the objective scores. Nothing
	 * is searched and nothing is applied whatever `apply` says.
	 */
	graphOnly?: boolean;
	/**
	 * Coverage floor for this block, in percent, overriding the project setting.
	 *
	 * Only the all-floor run sets it: A1's building guarantee is enforced one *block* at a
	 * time, so the floor has to be attached to the block rather than to the project.
	 */
	floorPct?: number;
}

/** Move the given APs to the given world positions, as one undoable step. */
function applyPositions(
	positions: Array<{ id: string; x: number; y: number; facingDeg?: number }>
): void {
	beginMove();
	for (const pos of positions) {
		// A wall mount's direction is part of where it was put: the wall it landed on
		// decides which way it looks, so the two are written together.
		updateAp(
			pos.id,
			pos.facingDeg === undefined
				? { x: pos.x, y: pos.y }
				: { x: pos.x, y: pos.y, facingDeg: pos.facingDeg }
		);
	}
	// Force a small state mutation to guarantee canvas reactivity triggers.
	apState.aps = [...apState.aps];
}

/**
 * Transmit power levels to offer one AP, in dBm, descending.
 *
 * 3 dB steps down to 12 dB below the configured power, and never below 5 dBm: the
 * pass is a *transmit power control* pass (802.11h), so its job is to spend range
 * the plan does not need, not to search a device's whole capability envelope. A
 * coarser step would miss the range where the reuse band disappears; a finer one
 * multiplies the evaluations for a difference the objective cannot resolve.
 */
const POWER_STEP_DB = 3;
const POWER_STEPS = 4;
const MIN_POWER_DBM = 5;

function powerLevelsFor(configuredPower: number): number[] {
	const levels: number[] = [];
	for (let i = 0; i < POWER_STEPS; i++) {
		const level = configuredPower - i * POWER_STEP_DB;
		if (i > 0 && level < MIN_POWER_DBM) break;
		levels.push(level);
	}
	return levels;
}

/**
 * Commit the transmit power the run settled on.
 *
 * Applied together with the positions, in the same undoable step conceptually: a
 * plan scored with 14 dBm and shown at 20 dBm would not be the plan the objective
 * measured. The radius comes back from the worker already derived the way the app
 * derives it, so writing both keeps the stored cache and the power in agreement —
 * `refreshApRanges` on the next load is then a no-op.
 */
function applyPowers(
	powers: Array<{ id: string; power: number; radius: number }> | undefined
): void {
	if (!powers || powers.length === 0) return;
	beginMove();
	for (const entry of powers) {
		updateAp(entry.id, { power: entry.power, interferenceRadius: entry.radius });
	}
	apState.aps = [...apState.aps];
}

/**
 * One other floor's wall mask, decoded, in the optimised floor's mask frame.
 *
 * Needed because a cross-floor path is two runs on two different plans: the AP's
 * own floor's walls up to the slab crossing, then the client's floor's walls. The
 * optimiser used to charge the whole run against the client's floor, so on a
 * three-metre storey two thirds of every cross-floor path was attenuated by the
 * wrong plan.
 *
 * Returns null when that floor has no mask, which leaves the path unsplit and the
 * model exactly as it was. Goes through the shared per-floor cache, so hanging
 * this off the real-time coverage estimate costs no extra PNG decodes.
 */
async function sourceFloorMaskFor(
	floorId: string,
	targetOriginX: number,
	targetOriginY: number
): Promise<{
	data: Uint8Array;
	width: number;
	height: number;
	materialMask: Uint8Array | null;
	roomTypeData: Uint8Array | null;
	defaultMaterial: number;
	originX: number;
	originY: number;
} | null> {
	const decoded = await getFloorMask(floorId);
	if (!decoded) return null;
	const floor = floorState.floors.find((f) => f.id === floorId);
	return {
		data: decoded.wallData,
		width: decoded.width,
		height: decoded.height,
		materialMask: decoded.materialMap,
		roomTypeData: decoded.roomTypeData,
		defaultMaterial: floor?.wallMaterial ?? 0,
		// The two floors' masks do not share an origin once either has been aligned,
		// so the source mask is handed over pre-shifted into the target's frame.
		originX: decoded.originX - targetOriginX,
		originY: decoded.originY - targetOriginY
	};
}

/**
 * Storey-boundary data for one cross-floor path, in the optimised floor's frame.
 *
 * Only the parts that need this module's state live here: each floor's decoded
 * room-type mask, and its origin shifted so the worker can index the mask in the
 * frame it marches in. The geometry — which crossing tests which plan, and how much
 * of the aggregate slab loss each one carries — is in `rf/slab-crossings.ts`, where
 * a unit test can read it without a browser.
 *
 * Returns null when nothing can be tested, in which case the caller leaves the
 * aggregate slab loss in place: the conservative reading, and the behaviour before
 * voids existed.
 */
/**
 * Vertical drop of a path from an AP on `floor` to a client, in world units: the AP hangs at
 * the floor's ceiling and the client sits `clientHeight` above the floor's plane.
 *
 * The path *loss* deliberately treats a same-floor path as 2D — over metres of plan a 1.2 m
 * drop is a few percent of distance — but the wall march cannot: it charges the length of
 * material the ray passes through — which is why the wall charge is one flat figure per
 */
function localVerticalDropFor(floor: Floor | undefined): number {
	if (!floor) return 0;
	return Math.abs(floor.ceilingHeight - projectMeta.clientHeight) * getEffectiveWupm();
}

/**
 * One access point, as the worker's payload wants it.
 *
 * The body of this function used to be an object literal inlined at each construction
 * site, which is how a payload ends up missing a field the model reads: forgetting
 * `mount` did not fail to compile, it silently meant "an upright omni". The type is
 * `ApInput`, derived in `optimizer-protocol.ts` from the app's own `AccessPoint`, so a
 * new antenna field is a compile error here and at every other caller.
 *
 * Two things happen that the worker cannot do for itself, both of them coordinate
 * conversions rather than copies:
 *  - the AP is stored in **world** coordinates and the worker indexes the floor's own
 *    mask, which starts at `(originX, originY)` because a tiled mask materialises on a
 *    256 px lattice that can extend into negative space;
 *  - the vertical gap to the client is floor geometry, which this side has and the
 *    worker does not (`apVerticalOffsetTo`, in world units).
 *
 * The antenna fields travel as they are: they are properties of the hardware, and the
 * worker resolves the pattern from them per sample.
 */
function toApInput(
	ap: AccessPoint,
	frame: { originX: number; originY: number; floorId: string }
): ApInput {
	return {
		id: ap.id,
		x: ap.x - frame.originX,
		y: ap.y - frame.originY,
		interferenceRadius: ap.interferenceRadius,
		band: ap.band,
		// Channels are per AP and survive the move: the interference term scores the
		// layout the solver last coloured, and null means "no assignment yet", which the
		// worker reads as the all-co-channel bound.
		assignedChannel: ap.assignedChannel,
		// A pin is a constraint rather than a starting point: the worker re-colours every
		// layout it scores, so it must treat a pinned channel as fixed.
		fixedChannel: ap.fixedChannel,
		// The palette the colourer may use has to be non-overlapping at the width actually
		// in use, and it has to be the same palette the solver uses. See `planningChannels`.
		channelWidth: ap.channelWidth,
		verticalGap:
			apVerticalOffsetTo(ap, frame.floorId, projectMeta.clientHeight) * getEffectiveWupm(),
		beamwidthDeg: ap.beamwidthDeg,
		aimDeg: ap.aimDeg,
		mount: ap.mount,
		facingDeg: ap.facingDeg
	};
}

async function crossingSlabsFor(
	apFloorId: string,
	clientFloorId: string,
	clientHeight: number,
	band: Band,
	clientOriginX: number,
	clientOriginY: number,
	clientRoomTypes: Uint8Array | null,
	/**
	 * The AP's own height above its floor, metres. Omitted means the ceiling of its
	 * storey, which is the mount this geometry assumed before mounting heights
	 * existed; the ray's slope — and so which planes it meets and where — follows
	 * from it.
	 */
	apHeightM?: number
): Promise<SlabCrossing[] | null> {
	if (apFloorId === clientFloorId) return null;
	const owners = floorsByLevel();
	const decodedByFloor = new Map<
		string,
		{
			roomTypes: Uint8Array | null;
			width: number;
			height: number;
			originX: number;
			originY: number;
		}
	>();
	const floors = await Promise.all(
		owners.map(async (floor) => {
			let slice: {
				roomTypes: Uint8Array | null;
				width: number;
				height: number;
				originX: number;
				originY: number;
			};
			if (floor.id === clientFloorId) {
				// The client floor's own mask is already in its own frame, so its origin is
				// the identity: the caller works in the optimised floor's pixels.
				slice = {
					roomTypes: clientRoomTypes,
					width: floor.wallMask?.width ?? 0,
					height: floor.wallMask?.height ?? 0,
					originX: 0,
					originY: 0
				};
			} else {
				const cached = decodedByFloor.get(floor.id);
				if (cached) {
					slice = cached;
				} else {
					const decoded = await getFloorMask(floor.id);
					slice = {
						roomTypes: decoded?.roomTypeData ?? null,
						width: decoded?.width ?? 0,
						height: decoded?.height ?? 0,
						// Both origins are world coordinates, so subtracting the optimised
						// floor's puts this mask in the frame the worker marches in.
						originX: (decoded?.originX ?? 0) - clientOriginX,
						originY: (decoded?.originY ?? 0) - clientOriginY
					};
					decodedByFloor.set(floor.id, slice);
				}
			}
			return {
				id: floor.id,
				elevation: floorElevation(floor.id),
				ceilingHeight: floor.ceilingHeight,
				slabLossDb: boundarySlabLossDb(owners.indexOf(floor), band),
				slice
			};
		})
	);
	return crossingSlabsForFloors({ floors, clientHeight, band, apHeightM }, apFloorId, clientFloorId);
}

/**
 * Run one floor's optimisation.
 *
 * `floorId` is explicit rather than read from `floorState.currentFloorId`
 * because the all-floor run optimises floors other than the one on screen. Every
 * per-floor input — wall mask, material mask, default material, wall
 * attenuation, room types, density overrides — is read from that floor rather
 * than from the flat `wallState`/`projectState` proxies, which only ever mirror
 * the current one.
 */
async function optimizeFloor(floorId: string, opts: FloorRunOptions = {}): Promise<FloorOutcome> {
	const apply = opts.apply !== false;
	const floor = getFloor(floorId);
	const nothing: FloorOutcome = {
		floorId,
		coverage: 0,
		interference: 0,
		contention: 0,
		interferenceKnown: true,
		samples: 0,
		score: 0,
		ok: false,
		positions: []
	};

	if (apState.aps.length === 0) return nothing;
	/*
	 * The floor's geometry, from whichever model states it.
	 *
	 * A floor with drawn segments has its mask derived on the spot — the segments are the
	 * model, and this is the one accessor the worker's payload and the solver's graph both
	 * go through, so a floor that was never opened (and therefore has a stored mask from
	 * before its walls were drawn, or none at all) is optimised against its *segments*.
	 * The stored mask, when there is one, is only the frame.
	 */
	const hasWalls = (floor?.walls ?? []).length > 0;
	if (!floor || (!floor.wallMask && !hasWalls)) {
		// Only worth surfacing when it is the floor on screen; during an all-floor
		// run a floor that has no plan is simply skipped.
		if (floorId === floorState.currentFloorId) optimizerState.error = t('Load a floorplan first');
		return nothing;
	}

	try {
		const decodedFloor = await getFloorMask(floorId);
		if (!decodedFloor) return nothing;
		const mask = {
			width: decodedFloor.width,
			height: decodedFloor.height,
			originX: decodedFloor.originX,
			originY: decodedFloor.originY
		} as { width: number; height: number; originX: number; originY: number };
		const curFloorId = floorId;

		// The wall mask is indexed from (originX, originY) in world space, not from
		// zero: TiledMask materialises on a 256 px tile lattice which can extend
		// into negative coordinates. Everything handed to the worker must be
		// shifted into mask-local space, and everything coming back shifted out.
		// The heatmap already does this; the optimiser did not, so its results were
		// offset from the geometry the canvas draws by exactly this amount.
		const originX = mask.originX ?? 0;
		const originY = mask.originY ?? 0;

		// Only optimize APs on the current floor (or all APs if single floor)
		const singleFloor = floorState.floors.length === 1;
		const onThisFloor = apState.aps.filter((ap) => singleFloor || ap.floorId === curFloorId);
		/*
		 * A **pinned** AP is not the optimiser's to move. It is handed over as a fixed
		 * source instead — the same shape another floor's AP arrives in, minus the slab
		 * crossing — so it still serves clients, is still scored, and is still coloured;
		 * it simply keeps its place. Everything else is a movable AP, wall mounts
		 * included: their domain is the band along the walls (`wallBandWu` below).
		 */
		const pinnedAps = onThisFloor.filter((ap) => ap.pinned);
		const localAps: ApInput[] = onThisFloor
			.filter((ap) => !ap.pinned)
			.map((ap) => toApInput(ap, { originX, originY, floorId: curFloorId }));

		if (localAps.length === 0) {
			if (floorId === floorState.currentFloorId) {
				optimizerState.error =
					pinnedAps.length > 0
						? t(
								'Every access point on this floor is pinned in place: there is nothing for the optimiser to move.'
							)
						: t('No APs on this floor');
			}
			return nothing;
		}

		// Virtual APs from other floors — fixed signal sources (not moved)
		const fixedAps: Array<{
			/** Carried so a graph request can name both ends of an edge. */
			id: string;
			x: number;
			y: number;
			interferenceRadius: number;
			signalScale: number;
			/** Vertical distance to this floor, in world units. */
			verticalGap: number;
			/** This AP's antenna cuts. See `ApInput.beamwidthDeg` in the worker. */
			beamwidthDeg: number;
			aimDeg: number;
			mount: string;
			facingDeg: number;
			band: Band;
			/** Channel of this AP, or null. Read by the interference term. */
			assignedChannel: number | null;
			/** Pinned channel, if the user set one. A constraint on the colouring. */
			fixedChannel: number | null;
			/** Channel width, for the non-overlapping palette. See `planningChannels`. */
			channelWidth: ChannelWidth;
			source?: {
				data: Uint8Array;
				width: number;
				height: number;
				materialMask: Uint8Array | null;
				defaultMaterial: number;
				originX: number;
				originY: number;
			} | null;
			sourceT?: number;
			targetT?: number;
			/** Every storey boundary this path crosses; empty when none can be tested. */
			slabs: SlabCrossing[];
		}> = [];
		const wupmForGap = getEffectiveWupm();
		/*
		 * This floor's pinned APs, as fixed sources.
		 *
		 * A same-floor path crosses no slab, so these carry no `source`, no `slabs` and a
		 * `signalScale` of 1 — the shape a local AP has in the coverage pass, with the one
		 * difference that the worker may not move it. The colourer still sees it, because
		 * a pinned AP competes for airtime exactly like any other.
		 */
		for (const ap of pinnedAps) {
			fixedAps.push({
				// The same fields, from the same mapper the movable APs use, plus the ones
				// that only a fixed source carries: a slab factor of 1 (a same-floor path
				// crosses nothing) and no wall-split data.
				...toApInput(ap, { originX, originY, floorId: curFloorId }),
				signalScale: 1,
				slabs: []
			});
		}
		// Decoded before the loop: the slab check needs this floor's own room types
		// when the AP is the lower of the two floors.
		const densityResult = await buildDensityMap(mask.width, mask.height, floor);
		for (const otherFloor of floorState.floors) {
			if (otherFloor.id === curFloorId) continue;
			const otherAps = apState.aps.filter((ap) => ap.floorId === otherFloor.id);
			if (otherAps.length === 0) continue;
			// Decoded once per other floor, not once per AP: the ray split needs the
			// AP's own floor's walls, and a PNG decode per AP would be absurd.
			const source = await sourceFloorMaskFor(otherFloor.id, originX, originY);
			// A void is a hole in a slab, so the ray pays that boundary's share of the
			// aggregate loss less. Every boundary the path crosses is tested at its
			// own crossing point, so a two-storey atrium waives one of the two rather
			// than all or nothing.
			//
			// Per band, because the shares are built from the slab loss and that is band
			// dependent — concrete reads 75 dB/m at 2.4 GHz and 100 at 5 GHz. Per mount
			// height too, because the ray's slope decides which planes it meets and
			// where. Building them once from the first AP would charge every other AP
			// that AP's geometry, and make the result depend on the order of the list.
			const slabsByKey = new Map<string, SlabCrossing[]>();
			// The vertical gap and the split are per AP for the same reason: an AP on
			// a desk is lower than one on the ceiling, and the two are not the same
			// distance from the client.
			for (const ap of otherAps) {
				const apHeightM = apHeightAboveFloor(ap);
				const key = `${ap.band}|${apHeightM}`;
				if (!slabsByKey.has(key)) {
					slabsByKey.set(
						key,
						(await crossingSlabsFor(
							otherFloor.id,
							curFloorId,
							projectMeta.clientHeight,
							ap.band,
							originX,
							originY,
							densityResult?.roomTypeData ?? null,
							apHeightM
						)) ?? []
					);
				}
			}
			for (const ap of otherAps) {
				const key = `${ap.band}|${apHeightAboveFloor(ap)}`;
				const split = apSplitFor(ap, curFloorId, projectMeta.clientHeight);
				const slabDb = getFloorSlabAttenuation(curFloorId, otherFloor.id, ap.band);
				fixedAps.push({
					id: ap.id,
					x: ap.x - originX,
					y: ap.y - originY,
					interferenceRadius: ap.interferenceRadius,
					signalScale: Math.pow(10, -slabDb / 10),
					verticalGap:
						apVerticalOffsetTo(ap, curFloorId, projectMeta.clientHeight) * wupmForGap,
					// A fixed AP's pattern counts as much as a placed one's: it is what
					// says an AP on the storey above reaches the floor below better out
					// to the side than straight down — and a wall-mounted one on that
					// storey has a front and a back on this floor too.
					beamwidthDeg: ap.beamwidthDeg,
					aimDeg: ap.aimDeg,
					mount: ap.mount,
					facingDeg: ap.facingDeg,
					band: ap.band,
					assignedChannel: ap.assignedChannel,
					fixedChannel: ap.fixedChannel,
					channelWidth: ap.channelWidth,
					source,
					sourceT: split.sourceT,
					targetT: split.targetT,
					slabs: slabsByKey.get(key) ?? []
				});
			}
		}

		/*
		 * The mask itself, already decoded: `getFloorMask` either derived it from the
		 * segments or decoded the stored PNG, so there is no second decode here — and the
		 * geometry the worker receives is the same one every other consumer reads.
		 */
		const decoded = { data: decodedFloor.wallData, width: decodedFloor.width, height: decodedFloor.height };

		// Material-aware wall loss: the per-pixel material map on this floor's own grid,
		// so the worker applies each material's per-crossing attenuation for the band.
		const materialMask = decodedFloor.materialMap;

		// Graph request: hand the worker the same payload a run would get and take
		// back the conflict graph, so the solver colours exactly what the objective
		// will afterwards measure. Everything above this line — the mask-local
		// positions, the cross-floor fixed APs and their splits, the density map —
		// is the assembly a real run uses, which is the point: a graph built from a
		// second, parallel construction is how the two criteria drifted apart.
		if (opts.graphOnly) {
			const graphResult = await graphBridge.optimize(
				localAps,
				decoded.data,
				mask.width,
				mask.height,
				floor.wallAttenuation,
				{
					fixedAps,
					densityMap: densityResult?.map ?? null,
					medianDensity: densityResult?.medianDensity ?? 0,
					materialMask,
					roomTypeMask: densityResult?.roomTypeData ?? null,
					defaultMaterial: floor.wallMaterial,
					metersPerPixel: 1 / getEffectiveWupm(),
					allowOutside: projectMeta.allowOutsideRooms,
					regulatoryDomain: apState.regulatoryDomain,
					coverageSoftnessDb: projectMeta.coverageSoftnessDb,
					pathLossScenario: projectMeta.pathLossScenario,
					// The graph the solver colours is built from the same margins the run
					// will score, so the geometry a client's height depends on belongs here
					// too — otherwise the two disagree exactly where a mezzanine is.
					surfaces: (floor.surfaces ?? []).map((surface) => ({
						ax: surface.ax - originX,
						ay: surface.ay - originY,
						bx: surface.bx - originX,
						by: surface.by - originY,
						heightM: surface.heightM,
						topHeightM: surface.topHeightM
					})),
					graphOnly: true
				}
			);
			if (graphResult.error) {
				if (floorId === floorState.currentFloorId) optimizerState.error = graphResult.error;
				return nothing;
			}
			return {
				...nothing,
				ok: true,
				samples: graphResult.sampleCount ?? 0,
				graph: graphResult.graph,
				// The worker's source order: this floor's APs, then the fixed APs.
				sourceIds: [...localAps.map((a) => a.id), ...fixedAps.map((f) => f.id ?? '')]
			};
		}

		const result = await bridge.optimize(
			localAps,
			decoded.data,
			mask.width,
			mask.height,
			floor.wallAttenuation,
			{
				fixedAps,
				densityMap: densityResult?.map ?? null,
				medianDensity: densityResult?.medianDensity ?? 0,
				materialMask,
				roomTypeMask: densityResult?.roomTypeData ?? null,
				defaultMaterial: floor.wallMaterial,
				metersPerPixel: 1 / getEffectiveWupm(),
				allowOutside: projectMeta.allowOutsideRooms,
				// B4: power is a decision variable, offered as reductions from each AP's
				// configured maximum. The pass can only lower it — raising it would
				// invent a capability the user did not configure — and only when the
				// exact objective strictly improves, so an AP whose power buys nothing
				// keeps it. See `refinePower`.
				powerLevelsDbm: localAps.map((ap) =>
					powerLevelsFor(apState.aps.find((a) => a.id === ap.id)?.power ?? 20)
				),
				worldUnitsPerMeter: getEffectiveWupm(),
				// The drop a same-floor path has and the path loss deliberately ignores. The
				// wall march cannot ignore it: it charges the material the ray walks through.
				localVerticalDrop: localVerticalDropFor(floor),
				// The band a wall-mounted AP is placed in, as a physical depth: the worker
				// indexes the mask in world units and has no calibration of its own. The
				// face itself is where `wallSnapForFloor` puts the AP afterwards.
				wallBandWu: WALL_BAND_M * getEffectiveWupm(),
				// What counts as a room, so the worker's placement domain agrees with the
				// app's own "is this point inside?" guard. See `room-domain.ts` — a domain
				// the two do not share is how an optimised AP ends up in a wall cavity.
				minRoomRadiusWu: minRoomRadiusWu(),
				/*
				 * The planning area, in the mask's own coordinates, when the user has drawn
				 * one. The worker clips its placement domain to it — the same clip the app's
				 * guard applies — so "draw the floor" reaches the optimiser as well as the
				 * warnings, and the two cannot disagree about where the floor is.
				 */
				planningArea: isUsablePlanningArea(floor.planningArea)
					? floor.planningArea!.map((point) => ({
							x: point.x - originX,
							y: point.y - originY
						}))
					: null,
				/*
				 * Raised surfaces, in the same mask frame as the planning area. The worker
				 * reads the client's height at each of its own samples from this, because
				 * a mezzanine changes a sample's vertical gap to every AP and it builds the
				 * sample grid itself.
				 */
				surfaces: (floor.surfaces ?? []).map((surface) => ({
					ax: surface.ax - originX,
					ay: surface.ay - originY,
					bx: surface.bx - originX,
					by: surface.by - originY,
					heightM: surface.heightM,
					topHeightM: surface.topHeightM,
					thicknessM: surface.thicknessM,
					attenuationDb: surface.attenuationDb
				})),
				// The user's own materials, so the worker charges their figures rather than the
				// built-in fallback for an id it has never seen.
				customMaterials: projectMeta.customMaterials.map((material) => ({
					id: material.id,
					name: material.name,
					dbPerMeter: {
						'2.4ghz': material.dbPerCrossing / Math.max(0.01, material.thicknessM),
						'5ghz': material.dbPerCrossing / Math.max(0.01, material.thicknessM),
						'6ghz': material.dbPerCrossing / Math.max(0.01, material.thicknessM)
					},
					typicalThickness: material.thicknessM,
					color: material.color
				})),
				// F3's ε-constraint. Zero means no constraint, which is the objective every
				// figure recorded before it was measured on. The per-floor switch changes who
				// the requirement is about, not how it is enforced: this block scores one
				// floor's samples, so the number here is always that floor's own.
				coverageFloor: (opts.floorPct ?? projectMeta.coverageFloorPct) / 100,
				onProgress: (p: OptimizeProgress) => {
					if (!apply) return; // a restart being scored is not the run on screen
					optimizerState.progress = Math.round((p.iteration / p.totalIterations) * 100);
					optimizerState.score = Math.round(p.score * 100);
				},
				seed: opts.seed,
				// One weight for the whole run, from the project settings, so a run
				// and its A/B twin differ in nothing else.
				interferenceWeight: projectMeta.interferenceWeight,
				// The objective's threshold: how far below the coverage threshold a
				// sample still earns utility. See `DEFAULT_COVERAGE_SOFTNESS_DB`.
				coverageSoftnessDb: projectMeta.coverageSoftnessDb,
				// The distance term's environment. The worker cannot read project state, so
				// every run carries it.
				pathLossScenario: projectMeta.pathLossScenario,
				// Handing the domain over is what makes the worker re-colour: it then
				// knows every band's channel list and every pin, so each layout it
				// scores is measured under its own best assignment rather than under
				// the assignment left over from before the search moved anything.
				regulatoryDomain: apState.regulatoryDomain
			}
		);

		// The worker reports a reason when it could not place anything (for
		// example no enclosed interior was detected). Surface it: without this the
		// user just sees the APs sitting where they were and no explanation.
		if (result.error) {
			if (floorId === floorState.currentFloorId) {
				optimizerState.error = result.error;
				optimizerState.progress = 0;
			}
			return nothing;
		}

		// The optimiser is stochastic, so record the seed it ran with. Without it
		// a different result on the next run is indistinguishable from a change
		// in the model, which makes before/after comparisons meaningless.
		console.info(
			`[optimizer] seed ${result.seed}, score ${result.score.toFixed(4)}, improvement ${result.improvement.toFixed(2)}%` +
				`, coverage ${(result.coverage * 100).toFixed(1)}%` +
				`, co-channel interference ${((result.interference ?? 0) * 100).toFixed(1)}%` +
				`, contended (CCA) ${((result.contention ?? 0) * 100).toFixed(1)}%` +
				(result.channelsKnown === false ? ' (all-co-channel bound: no assignment yet)' : '') +
				(result.reverted ? ' — the search scored worse than its own input, input kept' : '')
		);
		// The ε-constraint's outcome, when one was set: a constraint the user set but
		// the run says nothing about is indistinguishable from one that was ignored.
		if (projectMeta.coverageFloorPct > 0) {
			const floor = projectMeta.coverageFloorPct;
			const covered = (result.coverage * 100).toFixed(1);
			console.info(
				(result.shortfall ?? 0) > 0
					? `[optimizer] coverage floor ${floor}%, reached ${covered}% — short by ${((result.shortfall ?? 0) * 100).toFixed(1)} points`
					: `[optimizer] coverage floor ${floor}%, reached ${covered}% — met`
			);
		}
		// What the transmit-power pass decided, and why nothing changed when nothing
		// did. Reporting the *declined* case matters as much as the applied one: the
		// interference criterion compares levels *relative* to the best server, so
		// lowering power slides the band where two APs are within the reuse distance of
		// each other rather than narrowing it, and a cut that buys nothing is correctly
		// refused. Silence here would look like the pass did not run.
		{
			const powers = result.powers ?? [];
			const lowered = powers.filter((p) => {
				const ap = apState.aps.find((a) => a.id === p.id);
				return ap && p.power < ap.power;
			});
			if (powers.length === 0) {
				console.info('[optimizer] transmit power: not offered to this run');
			} else if (lowered.length === 0) {
				console.info(
					`[optimizer] transmit power: every level tested was a tie or worse, so all ` +
						`${powers.length} AP(s) keep their configured power`
				);
			} else {
				console.info(
					`[optimizer] transmit power lowered on ${lowered.length} of ${powers.length} AP(s): ` +
						lowered.map((p) => `${p.id}→${p.power} dBm`).join(', ')
				);
			}
		}
		// The diagnostic that answers "this coverage number looks wrong": how big
		// is one AP's coverage circle compared with the floor it sits on? If the
		// radius is comparable to the whole plan, a high coverage figure is
		// arithmetic, not a bug — and an uncalibrated plan is the usual cause of a
		// radius that large.
		{
			const wupm = getEffectiveWupm();
			const floorAps = apState.aps.filter((a) => a.floorId === curFloorId);
			const maxRadius = floorAps.length
				? Math.max(...floorAps.map((a) => a.interferenceRadius))
				: 0;
			console.info(
				`[optimizer] ${floorAps.length} AP(s) on this floor; largest coverage radius ` +
					`${(maxRadius / (wupm || 1)).toFixed(1)} m = ${maxRadius} world units at ${wupm} units/m`
			);
		}

		// Independently verify the result against the same interior the worker
		// used, and report the geometry when an AP lands outside it. The failure
		// mode this guards against is invisible otherwise: the optimiser reports
		// success and the APs simply sit somewhere unexpected.
		if (!projectMeta.allowOutsideRooms) {
			const check = computeBuildingInterior(decoded.data, mask.width, mask.height, {
				maxDim: 400,
				dilateRatio: 0.04,
				minDilateR: 4,
				// Same domain the worker placed into, or this check would be comparing an AP
				// against a different interior from the one it was placed in — including
				// which regions count as rooms. See `room-domain.ts`.
				trimWallAdjacent: true,
				minRegionRadius: minRoomRadiusWu()
			});
			// Mirror the worker's void exclusion, or a void reads as "AP landed
			// outside the interior" when the worker deliberately placed it there.
			const rtData = densityResult?.roomTypeData;
			if (rtData && rtData.length === check.interior.length) {
				for (let i = 0; i < check.interior.length; i++) {
					if (check.interior[i] && isVoidRoomType(rtData[i]!)) check.interior[i] = 0;
				}
			}
			let count = 0;
			let minX = Infinity;
			let minY = Infinity;
			let maxX = -1;
			let maxY = -1;
			for (let i = 0; i < check.interior.length; i++) {
				if (!check.interior[i]) continue;
				count++;
				const x = i % mask.width;
				const y = (i / mask.width) | 0;
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
			const outside = result.positions.filter((p) => {
				// A wall-mounted AP is *meant* to be against a wall, and the trimmed
				// interior the check reads excludes exactly that ring. Its domain is the
				// band, which the worker enforced.
				const ap = apState.aps.find((a) => a.id === p.id);
				if (ap?.mount === 'wall') return false;
				const ix = Math.round(p.x);
				const iy = Math.round(p.y);
				if (ix < 0 || ix >= mask.width || iy < 0 || iy >= mask.height) return true;
				return check.interior[iy * mask.width + ix] !== 1;
			});
			if (outside.length > 0) {
				optimizerState.error =
					`${outside.length} of ${result.positions.length} AP(s) ended up outside the detected interior. ` +
					`Mask is ${mask.width}x${mask.height}; interior covers ${count} px` +
					(count > 0 ? ` in [${minX},${minY}]-[${maxX},${maxY}]` : '') +
					`. See the console for details.`;
			}
		}

		// Optimized positions, shifted back out of mask-local space into world
		// coordinates and rounded, so they clearly differ from the originals and
		// trigger reactive updates.
		const worldPositions: Array<{ id: string; x: number; y: number; facingDeg?: number }> = [];
		for (const pos of result.positions) {
			const x = Math.round(pos.x) + originX;
			const y = Math.round(pos.y) + originY;
			/*
			 * The band is a *domain* rather than a placement, so a wall-mounted AP is put
			 * exactly on the wall face here — by the same measurement the editor uses when
			 * the mounting is chosen, which gives it the direction as well. What the
			 * optimiser leaves behind is then a position and a facing the user could have
			 * picked by hand, rather than a spot a bracket's depth off a wall.
			 */
			const ap = apState.aps.find((a) => a.id === pos.id);
			if (ap?.mount === 'wall') {
				const snap = await wallSnapForFloor(floorId, x, y, getEffectiveWupm());
				if (snap) {
					worldPositions.push({
						id: pos.id,
						x: Math.round(snap.apX),
						y: Math.round(snap.apY),
						facingDeg: Math.round(snap.facingDeg)
					});
					continue;
				}
			}
			worldPositions.push({ id: pos.id, x, y });
		}

		// A multi-start run scores several restarts before committing to one, so
		// applying is the caller's decision rather than a side effect of running.
		if (apply) {
			applyPositions(worldPositions);
			applyPowers(result.powers);
			optimizerState.score = Math.round(result.score * 100);
			scheduleSave();
		}

		return {
			floorId,
			coverage: result.coverage,
			interference: result.interference ?? 0,
			contention: result.contention ?? 0,
			interferenceKnown: result.channelsKnown ?? true,
			samples: result.sampleCount,
			score: result.score,
			ok: true,
			positions: worldPositions
		};
	} catch (err) {
		if (err instanceof Error && err.message === 'Cancelled') {
			// User cancelled - no error
		} else {
			optimizerState.error = err instanceof Error ? err.message : t('Optimization failed');
		}
		return nothing;
	}
}

/**
 * The conflict graph the automatic channel assignment must colour.
 *
 * Built one floor at a time through the optimiser's own payload and its own
 * margin pass (`fillMargins` in `optimizer-worker.ts`), so the edges the solver
 * sees are the edges the objective will afterwards measure against. That is the
 * whole point: the solver used to build its own graph from circle overlap plus an
 * AP-to-AP distance heuristic, and on the measured four-AP floor the two
 * disagreed — the solver's assignment scored 14.75% interference on the
 * objective's graph while a proper colouring of that same graph scored 0%.
 *
 * A floor whose graph cannot be built (no enclosed interior to sample, no
 * floorplan) is reported as `complete: false`, and the caller decides what to do;
 * this does not invent a graph it could not measure.
 *
 * Edges are undirected and named by AP id. A floor with no APs on it contributes
 * nothing: it is not a floor the optimiser ever scores, so including it would make
 * the assignment graph a different graph from the objective's again.
 */
export async function buildAssignmentConflictEdges(): Promise<{
	edges: Array<[string, string]>;
	/**
	 * What each edge costs, keyed as the edges are (`"a:b"` with the ids sorted).
	 *
	 * A pair that meets at one corner of a corridor and a pair whose whole served area
	 * overlaps are both edges, and the colourers had no way to tell them apart. This is
	 * the missing number: the density-weighted count of samples at which one source is
	 * within the reuse threshold of the other. See `conflictWeights`.
	 */
	weights: Map<string, number>;
	complete: boolean;
	floors: number;
	samples: number;
}> {
	const edges = new Map<string, [string, string]>();
	const weights = new Map<string, number>();
	let complete = true;
	let floors = 0;
	let samples = 0;
	const multiFloor = floorState.floors.length > 1;
	for (const floor of floorState.floors) {
		// Single-floor plans optimise every AP in one pass (see `optimizeFloor`), so
		// the first floor is the whole graph. Multi-floor plans are scored a floor at
		// a time, and a floor with no APs on it is never scored at all.
		if (multiFloor && !apState.aps.some((ap) => ap.floorId === floor.id)) continue;
		const outcome = await optimizeFloor(floor.id, { apply: false, graphOnly: true });
		if (!outcome.ok || !outcome.graph || !outcome.sourceIds) {
			complete = false;
			if (!multiFloor) break;
			continue;
		}
		floors++;
		samples += outcome.samples;
		const ids = outcome.sourceIds;
		const pairWeights = outcome.graph.weights;
		const count = outcome.graph.count;
		for (const [i, j] of outcome.graph.pairs) {
			const a = ids[i];
			const b = ids[j];
			if (!a || !b) continue;
			const key = [a, b].sort().join(':');
			edges.set(key, [a, b]);
			// A pair on two floors appears in both floors' graphs; the heavier reading
			// wins rather than the two being added, which would double-count the shared
			// samples between them.
			const w = pairWeights ? (pairWeights[i * count + j] ?? 0) : 1;
			weights.set(key, Math.max(weights.get(key) ?? 0, w));
		}
		if (!multiFloor) break;
	}
	return { edges: [...edges.values()], weights, complete, floors, samples };
}

/**
 * Guard and progress bookkeeping shared by the single-floor and all-floor runs.
 *
 * `isRunning` is set here rather than inside `optimizeFloor` because the
 * all-floor run calls that repeatedly — a guard down there would abort the run
 * on its second floor.
 */
async function withOptimizerRun(body: () => Promise<unknown>): Promise<void> {
	if (optimizerState.isRunning) return;
	optimizerState.isRunning = true;
	optimizerState.progress = 0;
	optimizerState.score = 0;
	optimizerState.error = null;
	optimizerState.status = '';
	try {
		await body();
		// Stamped here rather than inside `body`, so it dates *any* completed run —
		// the single-floor button and the all-floor one alike. The placement advice
		// panel keys off this to know a fresh measurement exists to advise on.
		optimizerState.lastRunAt = Date.now();
	} finally {
		optimizerState.isRunning = false;
		optimizerState.status = '';
	}
}

/** Commit a floor's winning outcome and refresh the figures that describe it. */
function commitFloorOutcome(floorId: string, outcome: FloorOutcome): void {
	applyPositions(outcome.positions);
	optimizerState.score = Math.round(outcome.score * 100);
	// The panel's figure describes the floor on screen. During an alternating run
	// most floors are not that one, and writing their numbers here would label the
	// panel with the wrong storey.
	if (floorId === floorState.currentFloorId) {
		optimizerState.coverage = Math.round(outcome.coverage * 100);
		optimizerState.interference = Math.round(outcome.interference * 100);
		optimizerState.contention = Math.round(outcome.contention * 100);
		optimizerState.interferenceKnown = outcome.interferenceKnown;
		optimizerState.interferenceMeasured = true;
	}
	floorCoverage.set(floorId, {
		coverage: Math.round(outcome.coverage * 100),
		samples: outcome.samples
	});
	scheduleSave();
}

/**
 * Optimise one floor, optionally repeating from several seeds and keeping the
 * best.
 *
 * This is the cheapest improvement on the table. Oustry et al. (Networks 81(1),
 * 2023) report that merely *restarting* a greedy placer — their GH1 to GH2, a
 * mechanical change carrying no modelling content at all — gained 11% mean and
 * 6% median, against 7% mean and **0% median** for the far more expensive
 * business of alternating placement with channel assignment. In their results the
 * restart was worth more than the model. This optimiser is stochastic behind a
 * fixed seed, so repeating it from other seeds is the same trick.
 *
 * The spread across restarts is printed, not just the winner. It is the only
 * headroom measurement this project has, and without it a restart count is a
 * guess: if every restart lands on the same score the extra runs buy nothing, and
 * if they scatter, the search is leaving something on the table.
 *
 * Both entry points go through here, so a per-floor optimise means the same thing
 * whether it was asked for by the single-floor button or by the alternating run.
 */
async function optimizeFloorBest(
	floorId: string,
	restarts: number,
	apply: boolean,
	extra: FloorRunOptions = {}
): Promise<FloorOutcome | null> {
	const n = Math.max(1, Math.floor(restarts));

	if (n === 1) {
		const one = await optimizeFloor(floorId, { ...extra, apply });
		if (!one.ok) return null;
		if (apply) commitFloorOutcome(floorId, one);
		return one;
	}

	const scores: number[] = [];
	let best: FloorOutcome | null = null;
	for (let i = 0; i < n; i++) {
		optimizerState.status = t('Restart {index} of {count}', { index: i + 1, count: n });
		// Seeds are 1..n rather than random, so a multi-start run is exactly as
		// reproducible as a single-start one.
		const outcome = await optimizeFloor(floorId, { ...extra, seed: i + 1, apply: false });
		if (!outcome.ok) continue;
		scores.push(outcome.score);
		if (!best || outcome.score > best.score) best = outcome;
	}

	if (scores.length > 0) {
		const lo = Math.min(...scores);
		const hi = Math.max(...scores);
		const spread = lo > 0 ? ((hi - lo) / lo) * 100 : 0;
		console.info(
			`[optimizer] ${scores.length} restarts: ${scores.map((s) => s.toFixed(4)).join(', ')}` +
				` — best ${hi.toFixed(4)}, spread ${spread.toFixed(2)}%`
		);
	}

	if (best && apply) commitFloorOutcome(floorId, best);
	return best;
}

/** Optimise the floor currently on screen. */
export async function runOptimizer(): Promise<void> {
	await withOptimizerRun(() =>
		optimizeFloorBest(floorState.currentFloorId, optimizerState.restarts, true)
	);
}

/**
 * Optimise every floor in turn, repeating until the building figure stops
 * improving.
 *
 * Floors go one at a time with the others held fixed — block coordinate descent.
 * Each pass leaves every floor at least as good as it was, so the sequence is
 * monotone and the run can stop when a pass stops gaining. There is no
 * convergence guarantee beyond that: the objective is not convex, and a later
 * pass may move APs to a different, equally good arrangement.
 *
 * The building figure is the density-weighted mean of the floors' covered-area
 * shares, weighted by the samples each floor contributed, so a small floor does
 * not count for as much as a large one.
 */
async function runAlternatingPasses(): Promise<void> {
	const order = [...floorState.floors].sort((a, b) => a.level - b.level);
	const runnable = order.filter(
		(f) => f.wallMask && apState.aps.some((ap) => ap.floorId === f.id)
	);
	if (runnable.length === 0) {
		optimizerState.error = t('No floors with both a floorplan and APs to place');
		return;
	}

	/** Gain below which another pass is not worth the time it costs, as a fraction. */
	const MIN_GAIN = 0.002;
	/** Hard stop. Each pass is a full optimisation per floor, so this bounds the wait. */
	const MAX_PASSES = 4;

	let best = -1;
	let passes = 0;

	for (let pass = 1; pass <= MAX_PASSES; pass++) {
		let weighted = 0;
		let weight = 0;
		const perFloor: Array<{ id: string; name: string; coverage: number }> = [];

		for (let i = 0; i < runnable.length; i++) {
			const f = runnable[i]!;
			optimizerState.status = t('Pass {pass}/{total} · {floor} ({index}/{count})', {
				pass,
				total: MAX_PASSES,
				floor: f.name,
				index: i + 1,
				count: runnable.length
			});
			// The same per-floor path the single-floor button uses, so restarts apply
			// here too. The readout is refreshed by `commitFloorOutcome` from the very
			// figure the objective uses, so the panel and the run cannot disagree.
			const outcome = await optimizeFloorBest(f.id, optimizerState.restarts, true);
			if (!outcome) continue;

			perFloor.push({ id: f.id, name: f.name, coverage: outcome.coverage });
			weighted += outcome.coverage * outcome.samples;
			weight += outcome.samples;
		}

		passes = pass;
		if (weight <= 0) break;
		const building = weighted / weight;
		optimizerState.buildingCoverage = Math.round(building * 100);

		// Name the weakest floor. Reported, never optimised for: a min-max objective
		// is far sharper to search and buys little, while the mean is what the
		// per-floor runs actually improve.
		if (perFloor.length > 0) {
			const worst = perFloor.reduce((a, b) => (b.coverage < a.coverage ? b : a));
			optimizerState.worstFloor = {
				id: worst.id,
				name: worst.name,
				coverage: Math.round(worst.coverage * 100)
			};
		}

		if (building - best < MIN_GAIN) break;
		best = building;
	}

	// A1's per-floor guarantee, as one extra block.
	//
	// The loop above names the weakest floor and never optimises for it, which is right for
	// the *objective* — min-max is far sharper to search and buys little on average — but it
	// means a floor can sit arbitrarily far below a requirement with nothing acting on it.
	// When the user asks for a per-floor floor, the weakest floor gets one more pass with
	// that floor as its own ε-constraint: the same F3 mechanism, on the one block that needs
	// it, with the others held where they are.
	//
	// One extra block rather than a constraint inside every block, on purpose: the constraint
	// has to be the *building's* weakest floor to mean anything, and inside a pass nobody
	// knows which floor that is until every floor has been scored.
	if (
		projectMeta.coverageFloorEveryFloor &&
		projectMeta.coverageFloorPct > 0 &&
		optimizerState.worstFloor
	) {
		const worst = optimizerState.worstFloor;
		if (worst.coverage < projectMeta.coverageFloorPct) {
			const target = runnable.find((f) => f.id === worst.id);
			if (target) {
				console.info(
					`[optimizer] per-floor floor: ${target.name} is at ${worst.coverage}%, below the ` +
						`${projectMeta.coverageFloorPct}% requirement — one more pass with it as the ε`
				);
				optimizerState.status = t('Per-floor floor · {floor}', { floor: target.name });
				const outcome = await optimizeFloorBest(target.id, optimizerState.restarts, true, {
					floorPct: projectMeta.coverageFloorPct
				});
				if (outcome) {
					optimizerState.worstFloor = {
						id: target.id,
						name: target.name,
						coverage: Math.round(outcome.coverage * 100)
					};
					console.info(
						`[optimizer] per-floor floor: ${target.name} now at ${Math.round(outcome.coverage * 100)}%`
					);
				}
			}
		} else {
			console.info(
				`[optimizer] per-floor floor: weakest floor is ${worst.name} at ${worst.coverage}%, ` +
					`at or above the ${projectMeta.coverageFloorPct}% requirement — no extra pass`
			);
		}
	}

	optimizerState.passes = passes;
	optimizerState.progress = 100;
	scheduleSave();
}

/** Optimise every floor, alternating until the building figure stops improving. */
export async function optimizeAllFloors(): Promise<void> {
	await withOptimizerRun(() => runAlternatingPasses());
}

export function cancelOptimizer(): void {
	bridge.cancel();
}
