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
import { computeBuildingInterior, sealOpenings } from '$canvas/morphology.js';
import { maskSignature } from '$canvas/mask-registry.js';
import { isVoidRoomType } from '$canvas/room-types.js';
import { getEffectiveWupm } from './ap-state.svelte.js';
import { getFloorMask } from './floor-mask.js';
import { minRoomRadiusWu } from './room-domain.js';
import { isUsablePlanningArea, pointInPlanningArea } from './planning-area.js';
import { floorState } from './floor-state.svelte.js';

/**
 * Half the widest opening that still counts as a room, in metres.
 *
 * A doorway is about a metre, a double door under two; a room whose whole side is missing
 * is not a room. Closing the walls by this radius bridges the first and leaves the second
 * open, which is the difference this guard was getting wrong — an office with a 1 m doorway
 * was reported as "outside the building" and its access point flagged.
 *
 * **Only this guard uses it.** The coverage figure and the optimiser's domain keep the
 * unsealed interior: sealing there would move every sampled square metre and every
 * placement candidate, which is a model change, not a warning fix.
 */
const SEAL_RADIUS_M = 0.75;

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
	/*
	 * Keyed on the mask *object*, not on `sourceKey`.
	 *
	 * The live mask reports the constant key `'live'` — it is handed over mid-edit, when its
	 * pixels are still changing — so a cache keyed on it never invalidated, and the interior
	 * (and with it the "outside the building" warning) kept answering from the geometry of
	 * whenever it was first computed. Deriving a mask from the drawn walls hit exactly that.
	 */
	const maskKey = maskSignature(decoded);
	if (cached && cached.key === maskKey) return cached;

	/*
	 * The walls are closed first, so a doorway does not read as the way out.
	 *
	 * The radius is in world units — the mask's own pixels — and derives from the project's
	 * scale, which can change on recalibration, so it is part of the cache key above by way
	 * of the mask and here by the radius itself.
	 */
	const wupm = getEffectiveWupm();
	const sealRadius = Math.max(1, Math.round(SEAL_RADIUS_M * wupm));
	const sealed = sealOpenings(decoded.wallData, decoded.width, decoded.height, sealRadius);
	const { interior } = computeBuildingInterior(sealed, decoded.width, decoded.height, {
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
		key: `${maskKey}:seal${sealRadius}`,
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
	/*
	 * A drawn planning area is the authority, and it is checked first.
	 *
	 * The inferred interior is a guess about a drawing: a room with a wide opening reads as
	 * "outside" (which is how an AP standing in the middle of an office was reported as
	 * outside the building) and a wall cavity reads as inside. When the user has said where
	 * the floor is, that answer is used instead — this is the same reason survey tools make
	 * you draw the area by hand.
	 */
	const planned = floorState.floors.find((f) => f.id === floorId)?.planningArea;
	if (isUsablePlanningArea(planned)) return pointInPlanningArea({ x, y }, planned);

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
