/**
 * "Is this point inside the building?" — the same question the optimiser's verifier asks,
 * answered for the paths that never touch the optimiser.
 *
 * With `Allow APs outside rooms` off, the optimiser keeps its access points inside the
 * detected interior. Two other paths could still put one in the margin outside the walls
 * and did so silently: a click on the canvas in placement mode, and a project saved by a
 * build whose detection disagreed with the current one. Both are checked against the same
 * interior domain the optimiser uses — same morphological options, same void exclusion —
 * so "inside" means one thing everywhere in the app.
 *
 * Pure with respect to app state beyond the mask lookup, so it can be awaited from an
 * event handler without ordering surprises.
 */
import { computeBuildingInterior } from '$canvas/morphology.js';
import { isVoidRoomType } from '$canvas/room-types.js';
import { getFloorMask } from './floor-mask.js';
import { minRoomRadiusWu } from './room-domain.js';

interface CachedInterior {
	/** Identity of the mask this was computed from, so a re-detected plan invalidates it. */
	key: string;
	width: number;
	height: number;
	/** Mask pixel (0,0) sits at this world coordinate: `pixel = world − origin`. */
	originX: number;
	originY: number;
	interior: Uint8Array;
}

const cache = new Map<string, CachedInterior>();

async function interiorFor(floorId: string): Promise<CachedInterior | null> {
	const decoded = await getFloorMask(floorId);
	if (!decoded) return null;
	const cached = cache.get(floorId);
	if (cached && cached.key === decoded.sourceKey) return cached;

	const { interior } = computeBuildingInterior(decoded.wallData, decoded.width, decoded.height, {
		// The optimiser's own options, verbatim: a different domain here would mean an AP
		// this guard rejects and the optimiser happily places, or the other way round.
		maxDim: 400,
		dilateRatio: 0.04,
		minDilateR: 4,
		trimWallAdjacent: true,
		// ...including which regions count as rooms. See `room-domain.ts`.
		minRegionRadius: minRoomRadiusWu()
	});
	const roomTypes = decoded.roomTypeData;
	if (roomTypes && roomTypes.length === interior.length) {
		for (let i = 0; i < interior.length; i++) {
			if (interior[i] && isVoidRoomType(roomTypes[i]!)) interior[i] = 0;
		}
	}

	const entry: CachedInterior = {
		key: decoded.sourceKey,
		width: decoded.width,
		height: decoded.height,
		originX: decoded.originX,
		originY: decoded.originY,
		interior
	};
	cache.set(floorId, entry);
	return entry;
}

/**
 * True when the world point is inside the floor's detected interior.
 *
 * A floor with no wall mask has nothing to judge against, so every point counts as inside —
 * the guard is about walls the app knows about, not about refusing to work.
 */
export async function isInsideInterior(floorId: string, x: number, y: number): Promise<boolean> {
	const entry = await interiorFor(floorId);
	if (!entry) return true;
	const ix = Math.round(x - entry.originX);
	const iy = Math.round(y - entry.originY);
	if (ix < 0 || ix >= entry.width || iy < 0 || iy >= entry.height) return false;
	return entry.interior[iy * entry.width + ix] === 1;
}

/** Drop a floor's cached interior — used when its mask is replaced or the floor is deleted. */
export function forgetInterior(floorId: string): void {
	cache.delete(floorId);
}
