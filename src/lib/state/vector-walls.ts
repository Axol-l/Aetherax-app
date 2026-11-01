/**
 * Walls as line segments — the model the app is moving to.
 *
 * Today a wall is a band of pixels: the mask is painted with a brush, the interior is
 * inferred by flood fill, and the attenuation is charged by counting crossings. Every
 * class of bug the last months produced came from that: a wall drawn as two strokes comes
 * out hollow, a cavity between strokes reads as a room, an outline with a wide opening
 * reads as outside.
 *
 * A wall is a segment with a material. There is no inside to a line, so none of those can
 * happen; a ray either crosses it or does not; and drawing one is two clicks instead of a
 * brush stroke.
 *
 * This module is the model and the small geometry that makes drawing feel right — snapping
 * to an existing endpoint, locking to an axis. Nothing here touches the raster mask
 * machinery, so the two can coexist while the propagation is moved over.
 */
import type { WallMaterialId } from '$lib/domain/materials.js';

export interface VectorWall {
	id: string;
	ax: number;
	ay: number;
	bx: number;
	by: number;
	material: WallMaterialId;
	/** Wall height above the floor, in metres. Absent means "the floor's ceiling". */
	heightM?: number;
}

export interface VectorColumn {
	id: string;
	/**
	 * A rectangle for a pier, a circle for a round column. Both are obstructions: a pillar
	 * casts the same shadow a wall does, so they are rasterised into the mask the
	 * propagation reads rather than being a drawing of one.
	 */
	shape: 'rect' | 'circle';
	/** Opposite corners of the rectangle; for a circle, `a` is the centre and `b` a rim point. */
	ax: number;
	ay: number;
	bx: number;
	by: number;
	material: WallMaterialId;
}

export interface Point {
	x: number;
	y: number;
}

/** How close, in screen pixels, a click has to be to an endpoint to snap to it. */
export const SNAP_PX = 12;

/** Length of a wall, in world units. */
export function wallLength(wall: VectorWall): number {
	return Math.hypot(wall.bx - wall.ax, wall.by - wall.ay);
}

/**
 * Snap a point to the nearest endpoint within `tolerance`, in world units.
 *
 * Snapping is what makes a drawn plan watertight: two walls that meet *near* each other are
 * two walls with a gap that a ray slips through, and the plan then behaves differently in
 * the model than it looks on the drawing. The tolerance is handed in world units so the
 * caller can keep it constant on screen at any zoom.
 */
export function snapToEndpoint(
	point: Point,
	walls: readonly VectorWall[],
	tolerance: number
): Point {
	let best: Point = point;
	let bestDistance = tolerance;
	for (const wall of walls) {
		for (const end of [
			{ x: wall.ax, y: wall.ay },
			{ x: wall.bx, y: wall.by }
		]) {
			const distance = Math.hypot(end.x - point.x, end.y - point.y);
			if (distance <= bestDistance) {
				best = end;
				bestDistance = distance;
			}
		}
	}
	return best;
}

/**
 * Lock the segment from `from` to `to` onto an axis when it is nearly horizontal or
 * vertical, which is what a drawn plan almost always wants.
 *
 * The test is on the *ratio*, not on an angle in degrees: a wall 100 px long and 3 px off is
 * worth locking, the same 3 px offset on a 10 px wall is a diagonal.
 */
export function lockToAxis(from: Point, to: Point, ratio = 0.12): Point {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	if (dx === 0 && dy === 0) return to;
	if (Math.abs(dy) <= Math.abs(dx) * ratio) return { x: to.x, y: from.y };
	if (Math.abs(dx) <= Math.abs(dy) * ratio) return { x: from.x, y: to.y };
	return to;
}

/**
 * The closest point on any wall — an endpoint or anywhere along its length.
 *
 * Endpoint snapping alone leaves the commonest gesture in a plan impossible: running a
 * partition *into* the middle of a wall (a T-junction). The drawing then has two walls that
 * look joined and a model with a gap, which is the class of bug this model exists to remove.
 * So a point snaps to any wall within reach, and to the nearer of "an end" and "the side"
 * when both are close.
 *
 * The kind is returned so the drawing can say which happened.
 */
export function snapToWalls(
	point: Point,
	walls: readonly VectorWall[],
	tolerance: number
): { point: Point; kind: 'endpoint' | 'edge' } {
	let best: Point = point;
	let bestDistance = tolerance;
	let kind: 'endpoint' | 'edge' = 'edge';

	// Ends first: two walls meeting at a corner should snap to the corner, not to the
	// nearest spot on one of its sides.
	for (const wall of walls) {
		for (const end of [
			{ x: wall.ax, y: wall.ay },
			{ x: wall.bx, y: wall.by }
		]) {
			const distance = Math.hypot(end.x - point.x, end.y - point.y);
			if (distance <= bestDistance) {
				best = end;
				bestDistance = distance;
				kind = 'endpoint';
			}
		}
	}

	// Then the sides, which may be closer than either end on a long wall.
	for (const wall of walls) {
		const dx = wall.bx - wall.ax;
		const dy = wall.by - wall.ay;
		const lengthSquared = dx * dx + dy * dy;
		if (lengthSquared === 0) continue;
		let t = ((point.x - wall.ax) * dx + (point.y - wall.ay) * dy) / lengthSquared;
		t = Math.max(0, Math.min(1, t));
		const candidate = { x: wall.ax + t * dx, y: wall.ay + t * dy };
		const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y);
		// Strictly closer, so an endpoint found at the same distance keeps winning.
		if (distance < bestDistance) {
			best = candidate;
			bestDistance = distance;
			kind = 'edge';
		}
	}

	return { point: best, kind };
}

/** Distance from a point to a segment, for selecting a wall by clicking near it. */
export function distanceToSegment(point: Point, wall: VectorWall): number {
	const dx = wall.bx - wall.ax;
	const dy = wall.by - wall.ay;
	const lengthSquared = dx * dx + dy * dy;
	if (lengthSquared === 0) return Math.hypot(point.x - wall.ax, point.y - wall.ay);
	let t = ((point.x - wall.ax) * dx + (point.y - wall.ay) * dy) / lengthSquared;
	t = Math.max(0, Math.min(1, t));
	return Math.hypot(point.x - (wall.ax + t * dx), point.y - (wall.ay + t * dy));
}

/** The wall nearest to `point` within `tolerance`, or null. */
export function wallNearPoint(
	point: Point,
	walls: readonly VectorWall[],
	tolerance: number
): VectorWall | null {
	let best: VectorWall | null = null;
	let bestDistance = tolerance;
	for (const wall of walls) {
		const distance = distanceToSegment(point, wall);
		if (distance <= bestDistance) {
			best = wall;
			bestDistance = distance;
		}
	}
	return best;
}

/** Drop walls shorter than a pixel or two: a double-click through the same spot makes one. */
export function isDegenerate(wall: VectorWall, minLength = 2): boolean {
	return wallLength(wall) < minLength;
}

/** A column's bounding box, in world units. */
export function columnBox(column: VectorColumn): {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	width: number;
	height: number;
} {
	const x0 = Math.min(column.ax, column.bx);
	const x1 = Math.max(column.ax, column.bx);
	const y0 = Math.min(column.ay, column.by);
	const y1 = Math.max(column.ay, column.by);
	return { x0, y0, x1, y1, width: x1 - x0, height: y1 - y0 };
}

/** A column too small to obstruct anything: a click without a drag makes one. */
export function isDegenerateColumn(column: VectorColumn, minSize = 2): boolean {
	if (column.shape === 'circle') {
		return Math.hypot(column.bx - column.ax, column.by - column.ay) < minSize;
	}
	const { width, height } = columnBox(column);
	return width < minSize && height < minSize;
}

/** The column under a point, or null. Circles test their radius, rectangles their box. */
export function columnAtPoint(
	columns: readonly VectorColumn[],
	point: Point
): VectorColumn | null {
	// Last drawn wins, which is what the user just placed when two overlap.
	for (let i = columns.length - 1; i >= 0; i--) {
		const column = columns[i]!;
		if (column.shape === 'circle') {
			const radius = Math.hypot(column.bx - column.ax, column.by - column.ay);
			if (Math.hypot(point.x - column.ax, point.y - column.ay) <= radius) return column;
			continue;
		}
		const { x0, y0, x1, y1 } = columnBox(column);
		if (point.x >= x0 && point.x <= x1 && point.y >= y0 && point.y <= y1) return column;
	}
	return null;
}
