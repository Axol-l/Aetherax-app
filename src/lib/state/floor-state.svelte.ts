import type { FloorMaterialId } from '$canvas/floor-materials.js';
import type { WallMaterialId } from '$canvas/materials.js';
import { FLOOR_MATERIALS } from '$canvas/floor-materials.js';
import { crossFloorSplit } from '$lib/rf/cross-floor.js';
import type { Band } from '@aetherax/channels';

export interface Floor {
	id: string;
	name: string;
	level: number;
	ceilingHeight: number; // meters (default 3.0 residential, 3.5 commercial)
	floorThickness: number; // meters (slab thickness, default 0.2)
	floorMaterial: FloorMaterialId;
	floorplanUrl: string | null;
	floorplanScale: number;
	/**
	 * Where the underlay image is drawn in world space.
	 *
	 * The image used to be pinned to (0, 0), which meant two floors could only be
	 * aligned if their plans happened to share a margin. `translateFloor` moves
	 * this together with the masks and the APs, so a floor stays rigid.
	 */
	floorplanOffsetX: number;
	floorplanOffsetY: number;
	calibration: { worldUnitsPerMeter: number } | null;
	floorplanBoundary: Array<{ x: number; y: number }> | null;
	wallMask: {
		dataUrl: string;
		width: number;
		height: number;
		originX: number;
		originY: number;
	} | null;
	wallAttenuation: number;
	wallMaterial: WallMaterialId;
	materialMask: {
		dataUrl: string;
		width: number;
		height: number;
		originX: number;
		originY: number;
	} | null;
	roomTypeMask: {
		dataUrl: string;
		width: number;
		height: number;
		originX: number;
		originY: number;
	} | null;
	/** Per-region density overrides: regionId → devices/sqm (overrides room type default). */
	roomDensityOverrides: Record<string, number>;
	/** Per-region custom labels: regionId → label string (shown on canvas instead of type shortName). */
	roomCustomLabels: Record<string, string>;
	/**
	 * The area the user says this floor occupies, as a polygon in world coordinates.
	 *
	 * Null means "not drawn": the app then infers the interior from the walls, which is right
	 * for a clean plan and costs nothing. Drawn means the polygon is the authority for
	 * inside/outside — warnings, placement and (from the optimiser's side) the domain — which
	 * is the only reliable answer for a plan whose outline has wide openings, or whose walls
	 * enclose cavities that are not rooms. See `state/planning-area.ts`.
	 */
	planningArea?: Array<{ x: number; y: number }> | null;
	/**
	 * Notes pinned to this floor: a sentence about the plan that the drawing cannot say.
	 *
	 * Per floor because a note is about a place on a storey — "the lift lobby has a steel
	 * door" is meaningless on the floor above. World coordinates, so they pan and zoom with
	 * the plan, and they are persisted with the project.
	 */
	notes?: Array<{ id: string; x: number; y: number; text: string }>;
}

function createDefaultFloor(id?: string, name?: string): Floor {
	return {
		id: id ?? crypto.randomUUID(),
		name: name ?? 'Floor 1',
		level: 0,
		ceilingHeight: 3.0,
		floorThickness: 0.2,
		floorMaterial: 1, // Concrete Slab
		floorplanUrl: null,
		floorplanScale: 0.4,
		floorplanOffsetX: 0,
		floorplanOffsetY: 0,
		calibration: null,
		floorplanBoundary: null,
		wallMask: null,
		wallAttenuation: 5,
		wallMaterial: 0,
		materialMask: null,
		roomTypeMask: null,
		roomDensityOverrides: {},
		roomCustomLabels: {},
		planningArea: null
	};
}

const defaultFloor = createDefaultFloor();

export const floorState = $state({
	floors: [defaultFloor] as Floor[],
	currentFloorId: defaultFloor.id
});

/** Get the currently active floor. */
export function currentFloor(): Floor {
	return floorState.floors.find((f) => f.id === floorState.currentFloorId) ?? floorState.floors[0]!;
}

/** Get a floor by ID. */
export function getFloor(id: string): Floor | undefined {
	return floorState.floors.find((f) => f.id === id);
}

/**
 * Reassign contiguous levels (0..n-1) following the current array order.
 *
 * `level` is the vertical ordering key used for slab attenuation. If it is
 * allowed to drift (e.g. a gap after removing a middle floor), lookups such as
 * `findIndex(s => s.level === f.level + 1)` silently find nothing and the slab
 * loss between two floors collapses to 0 dB. Keep the invariant instead.
 */
function renumberFloors(): void {
	floorState.floors.forEach((f, i) => {
		f.level = i;
	});
}

/** Add a new floor. Returns the new floor. */
export function addFloor(name?: string): Floor {
	const level = floorState.floors.length;
	const floor = createDefaultFloor(undefined, name ?? `Floor ${level + 1}`);
	floor.level = level;
	// A new floor is part of the same building, so it starts on the project scale
	// rather than on the uncalibrated default.
	floor.calibration = floorState.floors[0]?.calibration ?? null;
	floorState.floors.push(floor);
	renumberFloors();
	return floor;
}

/**
 * Set the project-wide scale on every floor.
 *
 * Floors of one building share a footprint and the scale is derived from the
 * plan's area, so calibrating one floor calibrates them all. Keeping the value
 * on every floor (rather than in one project field) means the per-floor records
 * stay self-describing, and a floor that is added later starts from the plan's
 * scale instead of the uncalibrated default. `getEffectiveWupm` reads floor 1's
 * copy, so a project whose floors disagree is unified on load.
 */
export function setProjectCalibration(calibration: { worldUnitsPerMeter: number } | null): void {
	for (const f of floorState.floors) f.calibration = calibration;
}

/** Remove a floor by ID. Cannot remove the last floor. Caller should clean up APs. */
export function removeFloor(id: string): void {
	if (floorState.floors.length <= 1) return;
	floorState.floors = floorState.floors.filter((f) => f.id !== id);
	renumberFloors();
	if (floorState.currentFloorId === id) {
		floorState.currentFloorId = floorState.floors[0]!.id;
	}
}

/** Switch to a floor. */
export function switchFloor(id: string): void {
	if (floorState.floors.some((f) => f.id === id)) {
		floorState.currentFloorId = id;
	}
}

/**
 * Compute total floor slab attenuation (dB) between two floors for a given band.
 *
 * Walks the floors in vertical order and accumulates slab loss. Index-based
 * rather than level-arithmetic based so that it stays correct even if levels
 * are ever non-contiguous.
 *
 * Multi-storey isolation does NOT grow linearly with the number of slabs.
 * ITU-R P.1238-12 states the isolation expected from penetrating several floor
 * slabs has a limit, because the signal can find external paths around the
 * building whose total loss is lower than the summed slab losses. Its measured
 * office figures show this clearly:
 *
 *   1.8-2 GHz : Lf = 15 + 4(n-1) dB   (a 4 dB step, not another 15 dB slab)
 *   5.8 GHz   : 22 dB for 1 floor, 28 dB for 2   (a 6 dB step)
 *
 * So the first slab contributes its full material loss and each additional
 * storey contributes only a small increment. Summing a full slab per storey
 * (the previous behaviour) gave 40 dB for two concrete slabs at 5 GHz where
 * ITU measures 28 dB.
 */
const ADDITIONAL_FLOOR_DB = 5;

export function getFloorSlabAttenuation(floorIdA: string, floorIdB: string, band: Band): number {
	if (floorIdA === floorIdB) return 0;
	const sorted = floorsByLevel();
	const ia = sorted.findIndex((f) => f.id === floorIdA);
	const ib = sorted.findIndex((f) => f.id === floorIdB);
	if (ia < 0 || ib < 0 || ia === ib) return 0;

	const lo = Math.min(ia, ib);
	const hi = Math.max(ia, ib);
	let totalDb = 0;
	// Each storey boundary crossed is the slab of the upper floor, i.e. the floor
	// at index `i` while the loop runs from `lo` to `hi - 1`. `boundarySlabLossDb`
	// is the same material lookup the waiver's shares are built from, so the two
	// cannot drift apart.
	for (let i = lo; i < hi; i++) {
		// The boundary between floors `i` and `i + 1` is floor `i + 1`'s own floor slab:
		// the slab between two storeys belongs to the upper one, which is where its
		// material and thickness live. Getting this index wrong charges the boundary to
		// the floor below it, and every consumer moves together, so a uniform-material
		// project cannot see the difference.
		const slabDb = boundarySlabLossDb(i + 1, band);
		// First storey: full slab loss. Later storeys: capped increment.
		totalDb += i === lo ? slabDb : Math.min(slabDb, ADDITIONAL_FLOOR_DB);
	}
	return totalDb;
}

/**
 * Height of a floor's walking surface above the lowest floor, in metres.
 *
 * Derived rather than stored: `level` is already the ordering key and
 * `ceilingHeight` is already per floor, so a stored elevation could disagree with
 * either. In level order, storey k's floor plane sits at the top of storey k-1's
 * ceiling.
 */
export function floorElevation(floorId: string): number {
	const sorted = [...floorState.floors].sort((a, b) => a.level - b.level);
	let z = 0;
	for (const f of sorted) {
		if (f.id === floorId) return z;
		z += f.ceilingHeight;
	}
	return z;
}

/**
 * Vertical distance between an AP on one floor and a client on another, metres.
 *
 * An AP on storey i sits `apHeightM` above that storey's walking surface —
 * `elevation(i) + apHeightM` — and a client sits `clientHeight` above the floor it
 * is on. `apHeightM` is the AP's own mounting height when the project models
 * them, and the storey's ceiling otherwise, which is what the ceiling-mount
 * geometry below always assumed; callers get it from `apHeightAboveFloor`.
 *
 * The calculation this replaces summed the ceiling heights of the storeys
 * *between* the two, which put the AP at the upper floor's floor plane instead of
 * its ceiling and put the client on the floor instead of above it. Both omissions
 * are precisely the ceiling-mount geometry this is meant to model, and together
 * they were worth about 1.5 m on a three-metre storey.
 *
 * Returns 0 for the same floor: a same-floor path is treated as flat, and the
 * caller decides whether mounting heights change that.
 */
export function crossFloorVerticalGap(
	apFloorId: string,
	clientFloorId: string,
	clientHeight: number,
	apHeightM?: number
): number {
	if (apFloorId === clientFloorId) return 0;
	const apFloor = getFloor(apFloorId);
	const clientFloor = getFloor(clientFloorId);
	if (!apFloor || !clientFloor) return 0;
	const apZ = floorElevation(apFloorId) + (apHeightM ?? apFloor.ceilingHeight);
	const clientZ = floorElevation(clientFloorId) + clientHeight;
	return Math.abs(apZ - clientZ);
}

/**
 * Height of every floor plane (each floor's walking surface) above the lowest
 * floor's, in metres, lowest first.
 *
 * The same accumulation `floorElevation` performs, exposed as a set because the
 * cross-floor ray split needs *all* the planes a ray can cross, not just the two
 * it starts and ends on.
 */
export function floorPlaneHeights(): number[] {
	const sorted = [...floorState.floors].sort((a, b) => a.level - b.level);
	const planes: number[] = [];
	let z = 0;
	for (const f of sorted) {
		planes.push(z);
		z += f.ceilingHeight;
	}
	return planes;
}

/**
 * Where a path from an AP on one floor to a client on another changes floors.
 *
 * `apHeightM` is the AP's own height above its floor — see
 * `crossFloorVerticalGap` for what it is when the project does not model mounting
 * heights, which is the storey's ceiling this always assumed.
 *
 * Both fractions are 0 when the path never leaves the client's floor — the AP is
 * on that floor, or is ceiling-mounted on the storey below and therefore starts
 * at the client's floor plane. See `rf/cross-floor.ts`.
 */
export function crossFloorSplitFor(
	apFloorId: string,
	clientFloorId: string,
	clientHeight: number,
	apHeightM?: number
): { sourceT: number; targetT: number } {
	if (apFloorId === clientFloorId) return { sourceT: 0, targetT: 0 };
	const apFloor = getFloor(apFloorId);
	const clientFloor = getFloor(clientFloorId);
	if (!apFloor || !clientFloor) return { sourceT: 0, targetT: 0 };
	const apZ = floorElevation(apFloorId) + (apHeightM ?? apFloor.ceilingHeight);
	const clientZ = floorElevation(clientFloorId) + clientHeight;
	return crossFloorSplit(apZ, clientZ, floorPlaneHeights());
}

/** Get floors adjacent to the given floor (level +/- 1). */
export function adjacentFloors(floorId: string): Floor[] {
	const floor = getFloor(floorId);
	if (!floor) return [];
	return floorState.floors.filter((f) => f.id !== floorId && Math.abs(f.level - floor.level) === 1);
}

/**
 * Floors in vertical order, lowest first — the array order `floorPlaneHeights`
 * uses, exposed because attributing a slab crossing to a floor needs the *index*
 * of that floor, not just its elevation.
 */
export function floorsByLevel(): Floor[] {
	return [...floorState.floors].sort((a, b) => a.level - b.level);
}

/**
 * Material loss of the floor slab **owned by** the floor at `index` in level order.
 *
 * Indexed by *floor*, not by boundary: the slab between floors `index - 1` and
 * `index` is floor `index`'s own floor slab, which is where its material and thickness
 * live. Callers must pass the upper floor of the boundary they mean.
 */
export function boundarySlabLossDb(index: number, band: Band): number {
	const owner = floorsByLevel()[index];
	if (!owner) return 0;
	const mat = FLOOR_MATERIALS[owner.floorMaterial];
	// The thickness guard matters because `slabLossFactor` divides by the sum of these:
	// a zero or negative thickness would produce a non-positive total and shares that do
	// not describe a proportion. `getFloorAttenuation` guards the same way.
	const thickness = owner.floorThickness > 0 ? owner.floorThickness : 0.2;
	return mat ? (mat.dbPerMeter[band] ?? 100) * thickness : 20;
}

/**
 * Move an entire floor by a world-space delta.
 *
 * Alignment between floors is a rigid translation: the underlay, the wall mask
 * and everything derived from it, and the APs all move together. Doing it as a
 * bake rather than as a per-consumer offset is deliberate. An offset applied at
 * read time would have to be threaded through the heatmap, the optimiser worker,
 * the solver, the wall editor and every export, and any site that forgot it
 * would silently compare shifted geometry against unshifted geometry — which is
 * exactly the class of bug that produced the mask-origin defect fixed earlier.
 * Baking keeps one world frame, so no consumer changes.
 *
 * Safe to bake because `TiledMask.fromFlat` accepts an arbitrary origin, so the
 * mask does not need to stay on the 256 px tile lattice. The origin *is* snapped
 * to a whole pixel on the way in — a mask is a pixel raster and a fractional
 * origin silently voids every write into it — so an alignment drag cannot leave
 * the walls half a pixel off the grid.
 *
 * `aps` is passed in rather than imported: `ap-state` already imports this
 * module, so reaching back for `apState` would close a cycle. The caller is also
 * responsible for pushing undo state first.
 */
export function translateFloor(
	floorId: string,
	dx: number,
	dy: number,
	aps: Array<{ floorId: string; x: number; y: number }>
): void {
	if (dx === 0 && dy === 0) return;
	const floor = getFloor(floorId);
	if (!floor) return;

	floor.floorplanOffsetX += dx;
	floor.floorplanOffsetY += dy;

	// The three masks are produced together and share a pixel grid, so the same
	// shift keeps them registered with each other.
	for (const mask of [floor.wallMask, floor.materialMask, floor.roomTypeMask]) {
		if (!mask) continue;
		mask.originX += dx;
		mask.originY += dy;
	}

	if (floor.floorplanBoundary) {
		for (const p of floor.floorplanBoundary) {
			p.x += dx;
			p.y += dy;
		}
	}

	for (const ap of aps) {
		if (ap.floorId !== floorId) continue;
		ap.x += dx;
		ap.y += dy;
	}
}
