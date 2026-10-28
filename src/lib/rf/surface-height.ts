/**
 * Raised walking surfaces — a mezzanine, a stair, a ramp — as a height field.
 *
 * A plan is flat, and the model has always treated every client on a floor as standing
 * on that floor: `clientHeight` above the slab, nothing else. That is right for a
 * single-level space and wrong for the two cases plans show constantly: a mezzanine
 * whose desks are two metres closer to the ceiling than the floor below, and a stair
 * that climbs from one to the other. The vertical gap is what the antenna's elevation
 * cut and the 3-D distance are made of, so on a six-metre atrium the error is not a
 * rounding — it is the difference between an AP overhead being at the weak end of its
 * doughnut and being near its peak.
 *
 * The shape is deliberately one rectangle with a height at each end:
 *
 * - a **platform** is level, so both heights are the same;
 * - a **ramp** rises linearly along its run;
 * - a **stair** rises along its run in the same field. A stair is a *flight* of steps,
 *   and a modelled step function would put a discontinuity through the sample grid —
 *   the continuous field is the mean of the treads, which is what a metre-scale
 *   propagation model can resolve anyway.
 *
 * The run is the rectangle's longer side. `ax, ay` → `bx, by` are opposite corners, and
 * the height goes from the edge nearest `a` to the edge nearest `b`: a ramp drawn from
 * the bottom of a stairwell to its top reads the way it was drawn.
 *
 * Nothing here knows about masks, bands or clients, so the heatmap, the coverage pass
 * and the optimiser worker can all use it.
 */

export type SurfaceKind = 'platform' | 'ramp' | 'stair';

/**
 * The geometry a height field needs — a rectangle and the height at each end.
 *
 * The worker is handed these without an id or a kind: it reads heights, not the list the
 * user edits, and a type that demanded fields the payload does not carry would push a
 * fake id through a message boundary.
 */
export interface SurfaceRect {
	/** Opposite corners of the rectangle the surface occupies. */
	ax: number;
	ay: number;
	bx: number;
	by: number;
	/** Height of the walking surface above the floor's own, in metres. */
	heightM: number;
	/**
	 * Height at the far end, metres. Equal to `heightM` for a platform; above it for a
	 * ramp or a stair, which is the whole point of drawing one.
	 */
	topHeightM: number;
}

/** One raised area, in world units for the rectangle and metres for the heights. */
export interface ElevatedSurface extends SurfaceRect {
	id: string;
	kind: SurfaceKind;
}

/** The rectangle normalised to left/right and top/bottom, in world units. */
export function surfaceBox(surface: SurfaceRect): {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	width: number;
	height: number;
} {
	const x0 = Math.min(surface.ax, surface.bx);
	const x1 = Math.max(surface.ax, surface.bx);
	const y0 = Math.min(surface.ay, surface.by);
	const y1 = Math.max(surface.ay, surface.by);
	return { x0, y0, x1, y1, width: x1 - x0, height: y1 - y0 };
}

/**
 * How far along the run a point is, from 0 at the low end to 1 at the high end.
 *
 * The run is the longer side of the rectangle, so a surface drawn as a wide, shallow
 * box climbs across its width. A degenerate rectangle (a click without a drag) has no
 * run at all and reports 0, which makes it level rather than dividing by zero.
 */
export function runFraction(surface: SurfaceRect, x: number, y: number): number {
	const { x0, y0, x1, y1, width, height } = surfaceBox(surface);
	if (width === 0 && height === 0) return 0;
	// A horizontal run is one that is wider than it is tall.
	if (width >= height) {
		const t = width === 0 ? 0 : (x - x0) / width;
		// The run runs from the corner nearest `a`, so a rectangle drawn right-to-left
		// must climb right-to-left rather than always left-to-right.
		const forward = surface.bx >= surface.ax;
		return clamp01(forward ? t : 1 - t);
	}
	const t = height === 0 ? 0 : (y - y0) / height;
	const forward = surface.by >= surface.ay;
	return clamp01(forward ? t : 1 - t);
}

function clamp01(value: number): number {
	return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** True when a world point lies inside the surface's rectangle. */
export function surfaceContains(surface: SurfaceRect, x: number, y: number): boolean {
	const { x0, y0, x1, y1 } = surfaceBox(surface);
	return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

/** Height of one surface at a point, in metres; 0 outside it. */
export function heightOf(surface: SurfaceRect, x: number, y: number): number {
	if (!surfaceContains(surface, x, y)) return 0;
	const low = Number.isFinite(surface.heightM) ? surface.heightM : 0;
	const high = Number.isFinite(surface.topHeightM) ? surface.topHeightM : low;
	if (low === high) return low;
	return low + (high - low) * runFraction(surface, x, y);
}

/**
 * Height of the walking surface at a point, metres above the floor's own.
 *
 * Overlapping surfaces take the highest, not the sum: they are surfaces, and two people
 * cannot stand on two mezzanines at once. A ramp that reaches a platform therefore
 * blends into it rather than doubling it.
 */
export function surfaceHeightAt(
	surfaces: readonly SurfaceRect[] | null | undefined,
	x: number,
	y: number
): number {
	if (!surfaces || surfaces.length === 0) return 0;
	let best = 0;
	for (const surface of surfaces) {
		const height = heightOf(surface, x, y);
		if (height > best) best = height;
	}
	return best;
}

/** The rectangle's four corners, in drawing order. */
export function surfaceCorners(surface: SurfaceRect): Array<{ x: number; y: number }> {
	const { x0, y0, x1, y1 } = surfaceBox(surface);
	return [
		{ x: x0, y: y0 },
		{ x: x1, y: y0 },
		{ x: x1, y: y1 },
		{ x: x0, y: y1 }
	];
}

/** Drop a rectangle too small to mean anything: a click without a drag makes one. */
export function isDegenerateSurface(surface: SurfaceRect, minSize = 3): boolean {
	const { width, height } = surfaceBox(surface);
	return width < minSize && height < minSize;
}
