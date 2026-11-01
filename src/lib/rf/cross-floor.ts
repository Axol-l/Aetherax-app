/**
 * Where a cross-floor ray has to change floors.
 *
 * A ray from an AP to a client on another floor is not attenuated by one floor's
 * walls. It travels through the AP's own storey down to the slab it penetrates,
 * and then through the storey below to the client — so the horizontal run has to
 * be split at the crossing, each half charged against the wall mask of the floor
 * it is actually passing through.
 *
 * The model this replaces charged the whole run against the *client's* floor. On a
 * three-metre storey with a client at 1.5 m, an AP on the floor above is 4.5 m
 * above the client and the slab is crossed two thirds of the way along the ray,
 * so two thirds of the wall attenuation came from the wrong plan — a bedroom wall
 * upstairs cost the same as a wall downstairs that the ray never passes.
 *
 * Walls are still treated as full-height within their storey (the 2D-mask
 * premise), so this needs nothing but the two masks that already exist.
 */

import { isVoidRoomType } from '$lib/domain/room-types.js';

/**
 * Fractions along the AP -> client ray at which the path changes floor.
 *
 * `sourceT` is where the ray leaves the AP's own storey (the *first* plane it
 * crosses) and `targetT` is where it enters the client's floor (the *last* one).
 * With one storey between the two floors they are equal, which is the common case.
 * With more, the storeys in between still have no wall model, but they are no
 * longer invisible: `floorPlaneCrossings` lists every plane, which is what the
 * per-slab void waiver needs.
 *
 * Both are 0 when the ray never leaves the client's floor's volume — the AP is on
 * the same floor, or sits on the floor below at the plane itself — in which case
 * the whole run belongs to the client's mask and nothing is split.
 *
 * @param apZ     AP height above the lowest floor's plane, in metres.
 * @param clientZ Client height above the lowest floor's plane, in metres.
 * @param planes  Height of every floor plane (each floor's walking surface), metres.
 */
export function crossFloorSplit(
	apZ: number,
	clientZ: number,
	planes: readonly number[]
): { sourceT: number; targetT: number } {
	const all = floorPlaneCrossings(apZ, clientZ, planes);
	if (all.length === 0) return { sourceT: 0, targetT: 0 };
	return { sourceT: all[0]!.t, targetT: all[all.length - 1]!.t };
}

/**
 * One floor plane the ray crosses, as geometry rather than as a pair of endpoints.
 *
 * `t` is the fraction along the AP -> client ray, `planeZ` the elevation of the
 * plane, and `owner` the index of the floor whose slab it is — the floor *below*
 * the plane, which is the floor material `getFloorSlabAttenuation` charges for
 * that storey boundary.
 *
 * Both the ray split and the slab-loss waiver need this list; the split only ever
 * asked for its first and last entry, which is why a taller gap used to be
 * indistinguishable from a one-storey one.
 */
export interface FloorPlaneCrossing {
	t: number;
	planeZ: number;
	/** Index into `planes` of the plane crossed. */
	planeIndex: number;
}

/**
 * Every floor plane the AP -> client ray crosses **strictly between** its endpoints,
 * ordered from the AP outward.
 *
 * The ray's height is a linear interpolation between the two endpoints, so the crossing
 * of the plane at `z` sits at `t = (z - apZ) / (clientZ - apZ)`.
 *
 * This is the list of planes a run is **split** at, which is why the endpoints are
 * excluded. A ceiling-mounted AP does sit under the slab above it, so a plane at
 * `t = 0` is genuinely in the path — but it splits the run into nothing, and the whole
 * run already belongs to the client's floor. The slab-loss waiver therefore does not
 * read this list; it derives the charged planes from the floor range, which is the only
 * way an upward path's `t = 0` slab gets its hole tested. See `rf/slab-crossings.ts`.
 */
export function floorPlaneCrossings(
	apZ: number,
	clientZ: number,
	planes: readonly number[]
): FloorPlaneCrossing[] {
	const dz = clientZ - apZ;
	// An AP and a client at the same height are on one plane: nothing is crossed.
	if (Math.abs(dz) < 1e-9) return [];

	const out: FloorPlaneCrossing[] = [];
	for (let i = 0; i < planes.length; i++) {
		const planeZ = planes[i]!;
		const t = (planeZ - apZ) / dz;
		// Strictly between, so an endpoint on a plane is not a split.
		if (t <= 0 || t >= 1) continue;
		out.push({ t, planeZ, planeIndex: i });
	}
	// Ordered from the AP outward rather than by elevation, because that is the
	// order the ray meets them — downwards the AP starts high, upwards it starts
	// low — and `sourceT`/`targetT` are its ends in this order.
	out.sort((a, b) => a.t - b.t);
	return out;
}

/** Point at fraction `t` of the segment from (ax, ay) to (bx, by). */
export function pointAlong(
	ax: number,
	ay: number,
	bx: number,
	by: number,
	t: number
): { x: number; y: number } {
	return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t };
}

export interface Segment {
	from: { x: number; y: number };
	to: { x: number; y: number };
}

export interface CrossFloorSegments {
	/** On the AP's floor: the AP to the point where the ray drops through the slab. */
	source: Segment;
	/** On the client's floor: from where the ray emerges to the client. */
	target: Segment;
}

/**
 * The two runs a cross-floor path is made of.
 *
 * Split into segments rather than "the whole run minus a prefix" on purpose. The
 * ray marcher divides a segment into a fixed number of steps, so its sampling
 * lattice depends on the segment's length: the prefix of a march is not the march
 * of the prefix, and subtracting two of them can move a thin wall across a step
 * boundary and produce a difference that is off by a whole wall. Marching each
 * segment directly avoids that entirely — and a loss field, which is sampled by
 * angle and distance, gives the same answer either way.
 *
 * Returns null when the path stays inside the client's floor, so callers keep
 * their single-floor path unchanged.
 */
export function crossFloorSegments(
	sourceT: number,
	targetT: number,
	ax: number,
	ay: number,
	bx: number,
	by: number
): CrossFloorSegments | null {
	if (sourceT <= 0 && targetT <= 0) return null;
	const sourceCross = pointAlong(ax, ay, bx, by, sourceT);
	const targetCross = pointAlong(ax, ay, bx, by, targetT);
	return {
		source: { from: { x: ax, y: ay }, to: sourceCross },
		target: { from: targetCross, to: { x: bx, y: by } }
	};
}

/**
 * Wall loss for a path that changes floors, given how to measure one floor.
 *
 * `lossOn(floor, from, to)` is the wall loss along a straight run on one floor's
 * mask. Callers pass a ray march, or a field lookup difference, so the geometry
 * lives here and the discretisation stays with the consumer that already has one.
 */
export function crossFloorLoss(
	segments: CrossFloorSegments,
	lossOn: (
		floor: 'source' | 'target',
		from: { x: number; y: number },
		to: { x: number; y: number }
	) => number
): number {
	return (
		lossOn('source', segments.source.from, segments.source.to) +
		lossOn('target', segments.target.from, segments.target.to)
	);
}

/**
 * Whether the floor slab is missing where the ray crosses it.
 *
 * A `Void / Atrium` label means a hole in *that floor's* slab, so a ray passing
 * through the crossing there meets no concrete and pays no slab loss. The slab
 * between two storeys belongs to the upper one — that is the material and
 * thickness `getFloorSlabAttenuation` charges — so the caller has to hand over the
 * room-type mask of the **upper** floor, not the client's.
 *
 * Coordinates are world (or any one consistent frame): the mask origin is
 * subtracted here.
 */
export function slabIsVoid(
	roomType: Uint8Array | null,
	width: number,
	height: number,
	originX: number,
	originY: number,
	wx: number,
	wy: number
): boolean {
	if (!roomType) return false;
	const x = Math.round(wx - originX);
	const y = Math.round(wy - originY);
	if (x < 0 || y < 0 || x >= width || y >= height) return false;
	return isVoidRoomType(roomType[y * width + x]!);
}

/** One storey boundary a cross-floor ray passes through. */
export interface SlabCrossing {
	/** Fraction along the AP -> client ray where the ray meets the slab. */
	t: number;
	/**
	 * Share of this path's aggregate slab loss charged at this boundary.
	 *
	 * The aggregate is not "one slab per storey": `getFloorSlabAttenuation` charges
	 * the first boundary in full and caps every later one at `ADDITIONAL_FLOOR_DB`,
	 * because ITU-R P.1238 measures multi-slab isolation levelling off (signal
	 * escapes around the building). The shares come from there and sum to 1, so
	 * waiving a subset scales the whole figure by exactly the fraction waived.
	 */
	lossShare: number;
	/** Room-type mask of the floor that owns this slab — the upper of the two. */
	roomTypes: Uint8Array | null;
	width: number;
	height: number;
	originX: number;
	originY: number;
}

/**
 * Slab-loss multiplier for a cross-floor path, one value per sample.
 *
 * `slabIsVoid` decides *whether* one crossing is a hole; this decides how much of
 * the aggregate that is worth. A three-storey atrium whose middle storey is void
 * waives that boundary's share and pays the rest, instead of the all-or-nothing
 * `{0, 1}` a one-storey gap could express.
 *
 * The result is always in `[0, 1]` because the shares sum to 1, so this can only
 * ever reduce the loss. Returning 1 for an empty crossing list is what keeps the
 * single-storey and same-floor cases byte-identical to the model before this.
 */
export function slabLossFactor(
	crossings: readonly SlabCrossing[],
	apX: number,
	apY: number,
	sampleX: number,
	sampleY: number
): number {
	let factor = 1;
	for (const c of crossings) {
		const cross = pointAlong(apX, apY, sampleX, sampleY, c.t);
		if (slabIsVoid(c.roomTypes, c.width, c.height, c.originX, c.originY, cross.x, cross.y)) {
			factor -= c.lossShare;
		}
	}
	// Clamped at both ends: the shares sum to 1 for any sane building, but they are built
	// from material thicknesses that a user can type, and a negative one would otherwise
	// *amplify* the slab loss at a hole. A multiplier is only ever allowed to waive.
	return factor < 0 ? 0 : factor > 1 ? 1 : factor;
}
