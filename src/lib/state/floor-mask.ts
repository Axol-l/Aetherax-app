import { decodeMask } from '$canvas/wall-detect.js';
import { decodeMaterialMask } from '$canvas/region-labels.js';
import { floorState } from './floor-state.svelte.js';
import { wallState } from './wall-state.svelte.js';

/**
 * Decoded wall masks, cached per floor.
 *
 * Extracted from `solver.svelte.ts`, where the solver's graph and the optimiser's
 * payload both used to reach in for it. That made `optimizer.svelte.ts` import
 * `solver.svelte.ts` while the solver was about to need the optimiser's own
 * margin pass for its conflict graph — a cycle between two `$state` modules, which
 * is the kind of thing that works until someone adds a top-level read. The cache
 * belongs to neither of them: it is "the floorplan as a raster", which both want.
 *
 * PNG decode is expensive (megabytes of data URL per floor) and the optimiser asks
 * for the same floor repeatedly, so this is a cache rather than a function.
 */

export interface DecodedFloorMask {
	wallData: Uint8Array;
	materialMap: Uint8Array | null;
	/**
	 * Room type ids on the same pixel grid, or null when the floor has none.
	 *
	 * Carried here because a void is a hole in the slab, and whether a cross-floor
	 * ray passes through one is decided at the point it crosses — see
	 * `slabIsVoid` in `rf/cross-floor.ts`.
	 */
	roomTypeData: Uint8Array | null;
	width: number;
	height: number;
	originX: number;
	originY: number;
	sourceKey: string; // for cache invalidation
}

/**
 * Identity for a stored mask, so a cache key can notice it was replaced.
 *
 * The data URLs are megabytes, and concatenating one into a key copies all of it;
 * object identity is what actually changes when a mask is edited.
 */
const maskIds = new WeakMap<object, number>();
let nextMaskId = 1;
function maskId(mask: object | null | undefined): number {
	if (!mask) return 0;
	let id = maskIds.get(mask);
	if (id === undefined) {
		id = nextMaskId++;
		maskIds.set(mask, id);
	}
	return id;
}

const floorMaskCache = new Map<string, DecodedFloorMask>();

/** Live mask override: set during wall editing so the solver skips PNG decode. */
let liveMask: DecodedFloorMask | null = null;

/** Set the live decoded mask during wall editing (call with null when done). */
export function setLiveSolverMask(
	wallData: Uint8Array | null,
	materialData: Uint8Array | null,
	width: number,
	height: number
): void {
	if (wallData) {
		liveMask = {
			wallData,
			materialMap: materialData,
			width,
			height,
			originX: 0,
			originY: 0,
			// The live mask is a wall/material pair handed over mid-edit, with no room
			// types. The void test then simply finds none, which is the conservative
			// reading; the figure is recomputed from the stored masks on Done.
			roomTypeData: null,
			sourceKey: 'live'
		};
	} else {
		liveMask = null;
	}
}

/**
 * Get decoded wall mask for a floor. Uses current wallState for active floor.
 *
 * The cache key carries the mask's origin as well as its size. Aligning a floor
 * moves the origin without touching a single pixel, so a size-and-material key
 * kept handing out the pre-alignment origin — and everything that converts world
 * coordinates into mask pixels then read the wrong part of the raster.
 */
export async function getFloorMask(floorId: string): Promise<DecodedFloorMask | null> {
	const floor = floorState.floors.find((f) => f.id === floorId);

	// During wall editing, use the live decoded mask (no PNG round-trip)
	if (liveMask && floorId === floorState.currentFloorId) {
		return liveMask;
	}

	// For current floor, prefer wallState (always up-to-date) over floor entity (synced on switch)
	if (floorId === floorState.currentFloorId && wallState.wallMask) {
		const wm = wallState.wallMask;
		const rtMask = wallState.roomTypeMask;
		const key = `${floorId}:${wm.width}x${wm.height}:${wm.originX ?? 0},${wm.originY ?? 0}:${wallState.wallMaterial}:rt${maskId(rtMask)}`;
		const cached = floorMaskCache.get(floorId);
		if (cached && cached.sourceKey === key) return cached;

		const decoded = await decodeMask(wm.dataUrl, wm.width, wm.height);
		const mm = wallState.materialMask;
		const matMask = mm ? await decodeMaterialMask(mm.dataUrl, mm.width, mm.height) : null;
		const entry: DecodedFloorMask = {
			wallData: decoded.data,
			materialMap: matMask,
			roomTypeData: await decodeRoomTypes(rtMask, wm.width, wm.height),
			width: decoded.width,
			height: decoded.height,
			originX: wm.originX ?? 0,
			originY: wm.originY ?? 0,
			sourceKey: key
		};
		floorMaskCache.set(floorId, entry);
		return entry;
	}

	// Other floors: decode from floor entity
	if (!floor?.wallMask) return null;
	const wm = floor.wallMask;
	const rtMask = floor.roomTypeMask;
	const key = `${floorId}:${wm.width}x${wm.height}:${wm.originX ?? 0},${wm.originY ?? 0}:${floor.wallMaterial}:rt${maskId(rtMask)}`;
	const cached = floorMaskCache.get(floorId);
	if (cached && cached.sourceKey === key) return cached;

	const decoded = await decodeMask(wm.dataUrl, wm.width, wm.height);
	const mm = floor.materialMask;
	const matMask = mm ? await decodeMaterialMask(mm.dataUrl, mm.width, mm.height) : null;
	const entry: DecodedFloorMask = {
		wallData: decoded.data,
		materialMap: matMask,
		roomTypeData: await decodeRoomTypes(rtMask, wm.width, wm.height),
		width: decoded.width,
		height: decoded.height,
		originX: wm.originX ?? 0,
		originY: wm.originY ?? 0,
		sourceKey: key
	};
	floorMaskCache.set(floorId, entry);
	return entry;
}

/**
 * Decode a stored room type mask, if it is on the same grid as the wall mask.
 *
 * Anything else is treated as "no room data": a mask of the wrong size would be
 * read at the wrong stride, and the only thing it feeds is the void test.
 */
async function decodeRoomTypes(
	rtMask: { dataUrl: string; width: number; height: number } | null | undefined,
	width: number,
	height: number
): Promise<Uint8Array | null> {
	if (!rtMask || rtMask.width !== width || rtMask.height !== height) return null;
	return decodeMaterialMask(rtMask.dataUrl, rtMask.width, rtMask.height);
}

/** Invalidate mask cache when walls change. */
export function invalidateSolverMaskCache(): void {
	floorMaskCache.clear();
}
