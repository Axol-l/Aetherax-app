/**
 * Ray-versus-segment crossings: the wall loss of the vector model.
 *
 * The raster model asks "how many wall pixels does this ray walk through", and every
 * awkward thing about it comes from that question: a wall's *drawn* width is a drawing
 * convention, two strokes make a hollow wall, and a pixel on the corner belongs to two
 * walls at once. The vector model asks the question the physics asks instead — does the ray
 * cross this segment — and the loss is the segment's material figure, once per crossing.
 *
 * That is why materials are stored as "dB per crossing at a stated thickness": this module
 * charges exactly the number the user typed, with no per-metre arithmetic and no dependence
 * on how thick the wall was drawn.
 *
 * Pure and allocation-light: the wall march calls this per sample point, so it is a loop
 * over segments and nothing else.
 */
import type { Band } from '@aetherax/channels';
import { getFlatAttenuation, type WallMaterialId } from '../canvas/materials.js';

export interface WallSegment {
	ax: number;
	ay: number;
	bx: number;
	by: number;
	material: WallMaterialId;
	/** Set by `rayWallCrossings`, so callers can identify which wall was hit. */
	id?: string;
}

export interface WallCrossing {
	wall: WallSegment;
	/** Position along the ray, 0 at `from` and 1 at `to`. */
	t: number;
	x: number;
	y: number;
}

/**
 * Where a ray crosses one segment, or null.
 *
 * Standard parametric intersection with a tolerance on the *ray* end so a wall that ends
 * exactly on the ray line still counts: a segment touching the ray at its own endpoint is a
 * wall the ray grazes, and treating that as a miss is how a corner develops a leak.
 */
export function raySegmentIntersection(
	from: { x: number; y: number },
	to: { x: number; y: number },
	wall: WallSegment
): WallCrossing | null {
	const rx = to.x - from.x;
	const ry = to.y - from.y;
	const sx = wall.bx - wall.ax;
	const sy = wall.by - wall.ay;

	const denominator = rx * sy - ry * sx;
	// Parallel: no crossing, and a collinear overlap is not a crossing either — a ray running
	// along a wall does not pass through it.
	if (Math.abs(denominator) < 1e-12) return null;

	const qpx = wall.ax - from.x;
	const qpy = wall.ay - from.y;

	const t = (qpx * sy - qpy * sx) / denominator;
	const u = (qpx * ry - qpy * rx) / denominator;

	// `u` on [0,1] is "on the segment"; `t` on [0,1] is "between the ray's ends". A small
	// margin on both so an endpoint hit is a hit.
	const margin = 1e-9;
	if (t < -margin || t > 1 + margin) return null;
	if (u < -margin || u > 1 + margin) return null;

	return {
		wall,
		t: Math.min(1, Math.max(0, t)),
		x: from.x + rx * t,
		y: from.y + ry * t
	};
}

/** Every wall the ray crosses, nearest first. */
export function rayWallCrossings(
	from: { x: number; y: number },
	to: { x: number; y: number },
	walls: readonly WallSegment[]
): WallCrossing[] {
	const out: WallCrossing[] = [];
	for (const wall of walls) {
		const hit = raySegmentIntersection(from, to, wall);
		if (hit) out.push(hit);
	}
	out.sort((a, b) => a.t - b.t);
	return out;
}

/**
 * Total wall loss along the ray, in dB.
 *
 * One figure per crossing, from the material's own row. A virtual partition contributes
 * nothing because its row is zero — which is exactly the behaviour the raster model needed a
 * special case for.
 */
export function rayWallLossDb(
	from: { x: number; y: number },
	to: { x: number; y: number },
	walls: readonly WallSegment[],
	band: Band
): number {
	let total = 0;
	for (const hit of rayWallCrossings(from, to, walls)) {
		total += getFlatAttenuation(hit.wall.material, band);
	}
	return total;
}

/** The crossings with their loss, for a report that has to show its working. */
export function rayWallBreakdown(
	from: { x: number; y: number },
	to: { x: number; y: number },
	walls: readonly WallSegment[],
	band: Band
): Array<{ wall: WallSegment; at: number; db: number }> {
	return rayWallCrossings(from, to, walls).map((hit) => ({
		wall: hit.wall,
		at: hit.t,
		db: getFlatAttenuation(hit.wall.material, band)
	}));
}
