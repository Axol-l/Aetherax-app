/**
 * Shared building blocks of the placement optimiser.
 *
 * The payload conversions, the density map, the cross-floor slab list and the power
 * pass are used by both the search (`optimizer.svelte.ts`) and the real-time coverage
 * estimate (`optimizer-coverage.svelte.ts`); they are geometry and conversion, not
 * state, so they live here rather than in either consumer.
 */
import { updateAp, beginMove } from './ap-state.svelte.js';
import {
	apVerticalOffsetTo,
	DEFAULT_WUPM,
	wupmForFloor,
	type AccessPoint
} from './ap-state.svelte.js';
import { resampleRaster, scaleBetween } from './floor-scale.js';
import type { Band } from '@aetherax/channels';
import { decodeMask } from '$canvas/mask-codec.js';
import { decodeMaterialMask } from '$canvas/region-labels.js';
import { buildRoomDomain } from '$canvas/rooms.js';
import type { SlabCrossing } from '$lib/rf/cross-floor.js';
import { crossingSlabsFor as crossingSlabsForFloors } from '$lib/rf/slab-crossings.js';
import { ROOM_TYPES, isVoidRoomType } from '$lib/domain/room-types.js';
import { floorState, boundarySlabLossDb, floorElevation, floorsByLevel, type Floor } from './floor-state.svelte.js';
import { getFloorMask } from './floor-mask.js';
import { projectMeta } from './project-meta.svelte.js';
import { minRoomRadiusWu } from './room-domain.js';
import type { ApInput } from '../workers/optimizer-protocol.js';
import { apState } from '$state/ap-state.svelte.js';
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
// 鈹€鈹€鈹€ Density-map input caching 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
//
// Density overrides change on every slider tick, but the inputs they are
// combined with do not. Recomputing them per tick meant two PNG decodes, a
// morphological close, a connected-component labelling pass and a sort over
// every labelled pixel 鈥?that is what made dragging a density slider stutter.
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
	wallMask: { dataUrl: string; width: number; height: number } | null,
	floorId: string
): Promise<Int32Array | null> {
	// Taken as a parameter rather than read from `wallState`, which only ever holds
	// the *current* floor's mask, while an all-floor run optimises floors other
	// than the one on screen.
	const wm = wallMask;
	if (!wm) return null;
	if (densityWallMaskRef === wm && densityRoomLabels) return densityRoomLabels;
	const decoded = await decodeMask(wm.dataUrl, wm.width, wm.height);
	// Rooms, not cavities: this drives the per-room density the objective weights samples
	// by, and a wall cavity is not a room with an occupancy. Untrimmed, because the wall-
	// adjacent pixels are still part of the room the user drew 鈥?and because the canvas's own
	// labels, which key the overrides read below, are untrimmed too. See `canvas/rooms.ts`.
	const { labels } = buildRoomDomain(decoded.data, maskWidth, maskHeight, {
		minRegionRadius: minRoomRadiusWu(floorId),
		trimWallAdjacent: false
	});
	densityRoomLabels = labels;
	densityWallMaskRef = wm;
	return densityRoomLabels;
}

export async function buildDensityMap(
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
		const labels = await getDensityRoomLabels(maskWidth, maskHeight, floor.wallMask, floor.id);
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
export interface FloorOutcome {
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
	 * worker's order 鈥?its APs first, then the fixed APs 鈥?so `pairs` can be read
	 * as AP ids. See `buildAssignmentConflictEdges`.
	 */
	graph?: { pairs: Array<[number, number]>; count: number; weights?: number[] };
	sourceIds?: string[];
}

/** How one floor run should behave. */
export interface FloorRunOptions {
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
export function applyPositions(
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

export function powerLevelsFor(configuredPower: number): number[] {
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
 * derives it, so writing both keeps the stored cache and the power in agreement 鈥?
 * `refreshApRanges` on the next load is then a no-op.
 */
export function applyPowers(
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
export async function sourceFloorMaskFor(
	floorId: string,
	targetOriginX: number,
	targetOriginY: number,
	/**
	 * The floor whose units the result must be in. Masks are one byte per world unit, so a
	 * source on a different calibration has to be resampled into this floor's pixels 鈥?the
	 * worker marches one frame and cannot tell that the walls it indexes were measured in a
	 * different one.
	 */
	targetFloorId: string
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
	const k = scaleBetween(floorId, targetFloorId);
	const walls = resampleRaster(decoded.wallData, decoded.width, decoded.height, k);
	const materials = decoded.materialMap
		? resampleRaster(decoded.materialMap, decoded.width, decoded.height, k)
		: null;
	const roomTypes = decoded.roomTypeData
		? resampleRaster(decoded.roomTypeData, decoded.width, decoded.height, k)
		: null;
	return {
		data: walls.data,
		width: walls.width,
		height: walls.height,
		materialMask: materials?.data ?? null,
		roomTypeData: roomTypes?.data ?? null,
		defaultMaterial: floor?.wallMaterial ?? 0,
		// The two floors' masks do not share an origin once either has been aligned, and
		// the offset itself is in the source's units 鈥?so the source origin is converted
		// first, then expressed relative to the target's.
		originX: decoded.originX * k - targetOriginX,
		originY: decoded.originY * k - targetOriginY
	};
}

/**
 * Storey-boundary data for one cross-floor path, in the optimised floor's frame.
 *
 * Only the parts that need this module's state live here: each floor's decoded
 * room-type mask, and its origin shifted so the worker can index the mask in the
 * frame it marches in. The geometry 鈥?which crossing tests which plan, and how much
 * of the aggregate slab loss each one carries 鈥?is in `rf/slab-crossings.ts`, where
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
 * The path *loss* deliberately treats a same-floor path as 2D 鈥?over metres of plan a 1.2 m
 * drop is a few percent of distance 鈥?but the wall march cannot: it charges the length of
 * material the ray passes through 鈥?which is why the wall charge is one flat figure per
 */
export function localVerticalDropFor(floor: Floor | undefined): number {
	if (!floor) return 0;
	// The floor object is the authority here: an all-floor run may hold a floor that is not
	// the selected one, and looking its id up in state would read the wrong storey's scale
	// if the list has been replaced under the run.
	const wupm = floor.calibration?.worldUnitsPerMeter ?? DEFAULT_WUPM;
	return Math.abs(floor.ceilingHeight - projectMeta.clientHeight) * wupm;
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
export function toApInput(
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
			apVerticalOffsetTo(ap, frame.floorId, projectMeta.clientHeight) *
			wupmForFloor(frame.floorId),
		beamwidthDeg: ap.beamwidthDeg,
		aimDeg: ap.aimDeg,
		mount: ap.mount,
		facingDeg: ap.facingDeg
	};
}

export async function crossingSlabsFor(
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
	 * existed; the ray's slope 鈥?and so which planes it meets and where 鈥?follows
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
					// The client's frame is in the optimised floor's units; this floor's
					// room-type raster is in its own, so it is resampled and its origin
					// scaled before the slab geometry indexes it.
					const k = scaleBetween(floor.id, clientFloorId);
					const roomTypes = decoded?.roomTypeData
						? resampleRaster(
								decoded.roomTypeData,
								decoded.width,
								decoded.height,
								k
							)
						: null;
					slice = {
						roomTypes: roomTypes?.data ?? null,
						width: roomTypes?.width ?? 0,
						height: roomTypes?.height ?? 0,
						// Both origins are world coordinates 鈥?in their own units 鈥?so this
						// one is converted to the client's before the difference is taken.
						originX: (decoded?.originX ?? 0) * k - clientOriginX,
						originY: (decoded?.originY ?? 0) * k - clientOriginY
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
