/**
 * "Put it on the wall": the nearest wall to a point, and which way that wall faces.
 *
 * A wall-mounted access point only means anything against a wall. Its pattern has a
 * front and a back, and the front is the direction away from the surface it is
 * screwed to — so both of the things a wall mount needs, *where* it goes and *which
 * way* it points, come out of one measurement: the nearest wall pixel. That
 * measurement already exists for the distance caption drawn under an access point's
 * name (`canvas/wall-distance.ts`); this module turns it into the placement and the
 * bearing.
 *
 * The facing is the direction from that wall pixel to the point being placed, i.e.
 * away from the wall and into the room the unit is in. That is right for a unit on a
 * room's wall and for one in a corridor. A unit that looks *along* a wall is a turned
 * bracket, which is exactly why the facing is stored per access point and editable:
 * the wall suggests a direction, it does not own it.
 */
import { normaliseBearing, wrap180 } from '../rf/antenna.js';
import { isVirtualMaterial, type WallMaterialId } from '$canvas/materials.js';
import { wallDistanceTransform, type WallDistanceTransform } from '$canvas/wall-distance.js';
import { getFloorMask } from './floor-mask.js';
import { floorState } from './floor-state.svelte.js';
import { wallState } from './wall-state.svelte.js';

export interface WallSnap {
	/** The point on the wall this was measured to, in world units. */
	x: number;
	y: number;
	/**
	 * Where the unit itself belongs: that point, backed off the wall by a bracket's
	 * depth. An access point sitting *inside* the wall pixel would pay that wall on
	 * every ray it radiates — including the ones that only leave the face — so the
	 * unit goes just clear of it.
	 */
	apX: number;
	apY: number;
	/** Distance from the queried point to the wall, in world units. */
	distanceW: number;
	/** Degrees from +x towards +y, away from the wall. */
	facingDeg: number;
}

/** How far off the wall face the unit is modelled as sitting, in metres. */
export const WALL_MOUNT_OFFSET_M = 0.1;

/**
 * How deep the optimiser's band along a wall is, in metres.
 *
 * Wider than the bracket itself on purpose: the search slides a unit *along* a wall and
 * around corners, and the band is the domain it may do that in rather than a placement.
 * The exact position is put on the face afterwards, by the same measurement the editor
 * uses. A band narrower than the step sizes the search takes (Lloyd's move, PSO's
 * jitter, the polish's 5→1 unit walk) would leave it nothing legal to move to.
 */
export const WALL_BAND_M = 0.5;

/**
 * How far from a wall a click may be and still count as "on a wall", in metres.
 *
 * Generous enough that aiming at a wall does not demand pixel accuracy, tight enough
 * that a click in the middle of a room is refused rather than teleported to the
 * nearest wall — which would look like the editor ignoring where the user clicked.
 */
export const WALL_MOUNT_REACH_M = 1;

/**
 * How close a stored facing has to be to the wall's own to be treated as derived
 * from it rather than turned by hand.
 *
 * Used while dragging: a bracket that was left pointing away from its wall follows
 * the wall as it is moved, and one the user has turned to look down a corridor keeps
 * the angle they gave it.
 */
export const DERIVED_FACING_TOLERANCE_DEG = 15;

/**
 * The nearest wall to a world point, from an already-built distance transform.
 *
 * Pure and synchronous, so a drag can call it on every pointer move; the transform
 * is the caller's, because building one per frame would be absurd and the view
 * already owns one for the caption.
 */
export function wallSnapFrom(
	transform: WallDistanceTransform | null,
	originX: number,
	originY: number,
	worldX: number,
	worldY: number,
	wupm: number
): WallSnap | null {
	if (!transform) return null;
	const hit = transform.query(Math.round(worldX - originX), Math.round(worldY - originY));
	if (!hit) return null;
	const x = originX + hit.x;
	const y = originY + hit.y;
	const dx = worldX - x;
	const dy = worldY - y;
	const onTheWall = Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6;
	const facingDeg = onTheWall ? 0 : normaliseBearing((Math.atan2(dy, dx) * 180) / Math.PI);
	const offset = WALL_MOUNT_OFFSET_M * wupm;
	return {
		x,
		y,
		apX: x + Math.cos((facingDeg * Math.PI) / 180) * offset,
		apY: y + Math.sin((facingDeg * Math.PI) / 180) * offset,
		distanceW: hit.distance,
		facingDeg
	};
}

/** Whether a stored facing looks like the one this wall gives, i.e. was not turned. */
export function facingFollowsWall(facingDeg: number, wall: WallSnap): boolean {
	return Math.abs(wrap180(facingDeg - wall.facingDeg)) <= DERIVED_FACING_TOLERANCE_DEG;
}

/**
 * One distance transform, kept for the mask it was built from.
 *
 * The transform is 8 bytes a mask pixel, so rebuilding it per call is not an option
 * and keeping many is not one either. `sourceKey` identifies the raster; the live
 * mask of a wall edit carries the constant key `'live'` while its pixels change, so
 * that case is never cached.
 */
let cache: { key: string; transform: WallDistanceTransform | null } | null = null;

function transformFor(key: string, data: Uint8Array, width: number, height: number) {
	if (key === 'live') return wallDistanceTransform(data, width, height);
	if (cache && cache.key === key) return cache.transform;
	const transform = wallDistanceTransform(data, width, height);
	cache = { key, transform };
	return transform;
}

/**
 * The walls a wall mount may attach to: walls, minus the ones that are not surfaces.
 *
 * A **virtual partition** is a modelling device — a boundary that attenuates nothing, for
 * separating areas of one open plan. There is no surface to screw a bracket to, so a wall
 * mount must not attach to one: its facing would be derived from a line that radiates both
 * ways, and the unit would sit in the middle of a room pointing at nothing.
 *
 * Exported so the rule can be read on its own; the transform below is built from it.
 */
export function attachableWallMask(
	wallData: Uint8Array,
	materialMap: Uint8Array | null,
	defaultMaterial: number
): Uint8Array {
	if (!materialMap) return wallData;
	const attachable = new Uint8Array(wallData.length);
	for (let i = 0; i < wallData.length; i++) {
		if (!wallData[i]) continue;
		const material = materialMap[i] ?? defaultMaterial;
		if (isVirtualMaterial(material as WallMaterialId)) continue;
		attachable[i] = 1;
	}
	return attachable;
}

/**
 * The distance transform of those walls.
 *
 * Built as its own raster because the transform answers "the nearest wall" and cannot be
 * asked for "the nearest wall that is not virtual": the line has to not be there in the
 * first place. Cached per mask-and-material identity, like the plain transform.
 */
let attachableCache: {
	key: string;
	transform: WallDistanceTransform | null;
} | null = null;

function attachableTransformFor(
	key: string,
	wallData: Uint8Array,
	materialMap: Uint8Array | null,
	defaultMaterial: number,
	width: number,
	height: number
) {
	if (!materialMap) return transformFor(key, wallData, width, height);
	const materialKey = `${key}|mat|${defaultMaterial}`;
	if (materialKey !== 'live' && attachableCache && attachableCache.key === materialKey) {
		return attachableCache.transform;
	}
	const transform = wallDistanceTransform(
		attachableWallMask(wallData, materialMap, defaultMaterial),
		width,
		height
	);
	if (materialKey !== 'live') attachableCache = { key: materialKey, transform };
	return transform;
}

/** The nearest wall of a floor to a world point, decoding that floor's mask if needed. */
export async function wallSnapForFloor(
	floorId: string,
	x: number,
	y: number,
	wupm: number
): Promise<WallSnap | null> {
	const mask = await getFloorMask(floorId);
	if (!mask) return null;
	// The floor's own default material, with the live value for the floor on screen: the
	// same choice the canvas makes when it colours the walls.
	const floor = floorState.floors.find((f) => f.id === floorId);
	const defaultMaterial =
		floorId === floorState.currentFloorId
			? (wallState.wallMaterial ?? floor?.wallMaterial ?? 0)
			: (floor?.wallMaterial ?? 0);
	const transform = attachableTransformFor(
		mask.sourceKey,
		mask.wallData,
		mask.materialMap,
		defaultMaterial,
		mask.width,
		mask.height
	);
	return wallSnapFrom(transform, mask.originX, mask.originY, x, y, wupm);
}
