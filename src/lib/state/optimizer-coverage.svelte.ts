/**
 * The real-time coverage estimate: how much of the floor on screen is above the
 * threshold, for the bar the user watches while placing access points.
 *
 * It is a *pass*, not a run: it samples the current floor against every AP in the
 * building, weights the samples by room density, and reports a percentage. The
 * placement search in `optimizer.svelte.ts` is a different, far more expensive thing,
 * and it owns its own evaluator inside the worker.
 *
 * Split out because it shares the `optimizerState` with the run but almost none of its
 * code, and because its caches (decoded mask, sample grid, density map) are only ever
 * read here.
 */
import { debug } from '$lib/log.js';
import { apHeightAboveFloor, apSplitFor, apVerticalOffsetTo, antennaProfileFor, getEffectiveWupm } from './ap-state.svelte.js';
import { antennaRayLossDb } from '$lib/rf/antenna.js';
import { surfaceHeightAt, deckCrossing } from '$lib/rf/surface-height.js';
import { bestReflection } from '$lib/rf/reflection.js';
import { diffractionLossDb, edgesOf } from '$lib/rf/diffraction.js';
import type { Band } from '@aetherax/channels';
import { decodeMask, type DecodedWallMask } from '$canvas/wall-detect.js';
import { decodeMaterialMask } from '$canvas/region-labels.js';
import { getMaterialDbTable } from '$canvas/materials.js';
import { buildRoomDomain } from '$canvas/rooms.js';
import { COVERAGE_MARGIN_DB, coverageMarginDb, coverageHorizontalReach, slabDbOf } from '$lib/rf/propagation.js';
import { slabLossFactor, type SlabCrossing } from '$lib/rf/cross-floor.js';
import { splitWallRunLoss, wallRunLoss, type WallRun } from '$lib/rf/link-budget.js';
import { floorState, currentFloor, getFloorSlabAttenuation, type Floor } from './floor-state.svelte.js';
import { projectMeta } from './project-meta.svelte.js';
import { wallState } from './wall-state.svelte.js';
import { minRoomRadiusWu } from './room-domain.js';
import { clipInteriorToPlanningArea, isUsablePlanningArea } from './planning-area.js';
import { apState } from '$state/ap-state.svelte.js';
import { canvasState } from '$state/canvas.svelte.js';
import { optimizerState, floorCoverage } from './optimizer-state.svelte.js';
import { buildDensityMap, crossingSlabsFor, sourceFloorMaskFor } from './optimizer-support.js';



/** The pass a drag deferred; see `updateCoverage`. */
let coverageAfterDrag: ReturnType<typeof setTimeout> | null = null;

let cachedMaskUrl: string | null = null;
/** Where the cached mask sits, because the URL does not change when the floor is moved. */
let cachedMaskOriginX = 0;
let cachedMaskOriginY = 0;
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
	/*
	 * The origin is part of the key, not just of the decoded copy.
	 *
	 * Moving a floor rewrites the mask's origin and leaves every pixel identical, so a key
	 * made of the data URL alone said "nothing changed" and the sample set kept the frame
	 * the floor had before it was aligned — while every AP had moved. The comparison is on
	 * the *stored* origin because that is what the copy is given below.
	 */
	if (
		mask.dataUrl === cachedMaskUrl &&
		(mask.originX ?? 0) === cachedMaskOriginX &&
		(mask.originY ?? 0) === cachedMaskOriginY &&
		cachedMask &&
		cachedSamples
	) {
		return true;
	}

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
	cachedMaskOriginX = mask.originX ?? 0;
	cachedMaskOriginY = mask.originY ?? 0;

	// Decode wall materials too: without them the loss path cannot tell a real
	// wall from a zero-attenuation virtual partition.
	const matMask = wallState.materialMask;
	cachedMaterialData =
		matMask && matMask.width === mask.width && matMask.height === mask.height
			? await decodeMaterialMask(matMask.dataUrl, matMask.width, matMask.height)
			: null;

	// The coverage sample set: the same domain the optimiser places in — including which
	// regions count as rooms, so a cavity is not counted as floor area that needs covering
	// either. Trimmed, because that is what the placement domain is. See `canvas/rooms.ts`.
	const { interior } = buildRoomDomain(cachedMask.data, mask.width, mask.height, {
		minRegionRadius: minRoomRadiusWu(),
		trimWallAdjacent: true
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
			if (canvasState.isDragging) return;
			// On an idle frame, like the save: a pass is the most expensive thing the app
			// does on the main thread, and it must not land on the frame the pointer is
			// released in.
			if (typeof requestIdleCallback === 'function') {
				requestIdleCallback(() => void updateCoverage(), { timeout: 1200 });
			} else {
				void updateCoverage();
			}
		}, 600);
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
	/*
	 * The segments a ray can reflect off, and how far a reflection is worth looking for.
	 *
	 * Same term, same module, same band as the heatmap (`rf/reflection.ts`): one specular
	 * bounce per access point, power-summed with the direct path. Empty for a floor whose
	 * walls are still a detected raster, which has no segment lines to reflect off.
	 */
	const reflectingWalls = (currentFloor().walls ?? []).map((wall) => ({
		ax: wall.ax,
		ay: wall.ay,
		bx: wall.bx,
		by: wall.by,
		material: wall.material
	}));
	const reflectionReach = 24 * surfaceWupm;
	/** Every wall end is a knife edge, for the shadow a wall casts. */
	const diffractionEdges = reflectingWalls.length > 0 ? edgesOf(reflectingWalls) : [];
	const coverageStarted = performance.now();
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
			// costs nothing and a material costs what its own measured entry says. Building
			// the two runs and splitting the ray at the slab is the same code the worker and
			// the heatmap march (`rf/link-budget.ts`).
			const targetRun: WallRun = {
				mask: data,
				width,
				height,
				materialMask: cachedMaterialData,
				materialDb: tablesFor(ap.band),
				fallbackDb: wallDb,
				originX: ox,
				originY: oy,
				defaultMaterialId: wallState.wallMaterial
			};
			const sourceRun: WallRun | null = ap.source
				? {
						mask: ap.source.data,
						width: ap.source.width,
						height: ap.source.height,
						materialMask: ap.source.materialMask,
						materialDb: tablesFor(ap.band),
						// The path descends by this AP's vertical gap, so its material path is
						// longer than its plan path. From the **whole** ray, not per segment:
						// one straight ray drops one gap, so both halves share one ratio.
						fallbackDb: ap.source.materialMask
							? (tablesFor(ap.band)[ap.source.defaultMaterial] ?? wallDb)
							: wallDb,
						originX: ap.source.originX,
						originY: ap.source.originY,
						defaultMaterialId: ap.source.defaultMaterial
					}
				: null;
			// Two runs on two plans when the path leaves this storey: the AP's own floor up
			// to the slab crossing, then this floor's from the crossing to the sample.
			const splitLoss = sourceRun
				? splitWallRunLoss(
						sourceRun,
						targetRun,
						ap.sourceT,
						ap.targetT,
						{ x: ap.x - ox, y: ap.y - oy },
						{ x: sample.x, y: sample.y },
						1
					)
				: null;
			let dbLoss =
				splitLoss ??
				wallRunLoss(targetRun, { x: ap.x - ox, y: ap.y - oy }, { x: sample.x, y: sample.y }, 1);
			// The wall part on its own: it is both a term of `dbLoss` and the test for whether
			// this path is blocked, which is when diffraction has something to fill.
			const wallLossDb = dbLoss;
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
			/*
			 * Diffraction around a wall end, ramped in as the wall blocks more.
			 *
			 * The same knife-edge model, the same ramp and the same memoised coefficients as
			 * the heatmap (`rf/diffraction.ts`): a hard "blocked" threshold drew its contour
			 * as a step in the figure, because the term appeared at a line instead of growing.
			 */
			const diffractionGate = Math.min(1, Math.max(0, (wallLossDb - 3) / 6));
			if (diffractionGate > 0 && diffractionEdges.length > 0) {
				const loss = diffractionLossDb(
					{ x: ap.x - ox, y: ap.y - oy },
					{ x: sample.x, y: sample.y },
					diffractionEdges,
					ap.band as '2.4ghz' | '5ghz' | '6ghz'
				);
				if (loss > 0) {
					const diffractedMargin =
						coverageMarginDb(dist, ap.interferenceRadius) -
						(wallLossDb + loss) +
						(dbLoss - wallLossDb);
					const blended = margin + diffractionGate * (diffractedMargin - margin);
					if (blended > bestMargin) bestMargin = blended;
				}
			}
			/*
			 * The wall's mirror image, as the heatmap adds it.
			 *
			 * A refracted-then-reflected path is not modelled; the reflected ray is a second way
			 * to reach the sample, so it is judged on its own margin and the sample takes the
			 * better of the two — which is what "covered if either path clears the threshold"
			 * means for a client associating with the strongest server.
			 */
			if (reflectingWalls.length > 0) {
				const bounce = bestReflection(
					{ x: ap.x - ox, y: ap.y - oy },
					{ x: sample.x, y: sample.y },
					reflectingWalls,
					ap.band as Band,
					reflectionReach
				);
				if (bounce) {
					const reflectedMargin =
						coverageMarginDb(bounce.length, ap.interferenceRadius) +
						10 * Math.log10(bounce.powerRatio);
					if (reflectedMargin > bestMargin) bestMargin = reflectedMargin;
				}
			}
		}
		const w = sampleDensity[i] ?? 1;
		// `coverageMarginDb` is measured over the association floor (-85 dBm), so
		// the coverage threshold (-70 dBm) has to be cleared explicitly.
		if (bestMargin >= COVERAGE_MARGIN_DB) coveredWeight += w;
		totalWeight += w;
	}

	optimizerState.coverage = totalWeight > 0 ? Math.round((coveredWeight / totalWeight) * 100) : 0;
	// Timed: this pass is the app's heaviest main-thread work, and the only way to decide
	// whether it needs a worker is to know what it costs on a real plan.
	debug(
		`[coverage] ${cachedSamples.length} samples × ${apState.aps.length} APs in ${Math.round(performance.now() - coverageStarted)} ms`
	);

	// Cache per-floor coverage (weighted by sample count as area proxy)
	floorCoverage.set(curFloorId, {
		coverage: optimizerState.coverage,
		samples: cachedSamples.length
	});
}