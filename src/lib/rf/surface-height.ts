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
	/**
	 * How deep the deck is under its walking surface, metres.
	 *
	 * It matters twice: it is the slab drawn in 3D, and it decides whether a path from
	 * below actually passes *through* the deck rather than arriving under it. A client
	 * standing on a 2 m deck with a 0.2 m deck under them and an AP at 1.5 m has a path
	 * that crosses it; an AP at 2.4 m does not.
	 */
	thicknessM?: number;
	/**
	 * Loss through the deck, dB. Charged once to a path that crosses it.
	 *
	 * Ekahau's raised-surface figure: the deck is a slab, and a client on it is shielded
	 * from a source below it. The default is the value its own defaults use (15 dB).
	 */
	attenuationDb?: number;
	/** Whether the volume under the deck is filled to the floor, for the 3D drawing. */
	solidBase?: boolean;
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
	const { x0, y0, width, height } = surfaceBox(surface);
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

/** The deck's own default thickness, metres. */
export const DEFAULT_SURFACE_THICKNESS_M = 0.2;

/** The loss a path pays for crossing a deck, dB, when the user has not said otherwise. */
export const DEFAULT_SURFACE_ATTENUATION_DB = 15;

/** A stair's step depth, metres: the run of one tread. */
export const STEP_DEPTH_M = 0.3;

/** How thick this surface's deck is, metres. */
export function surfaceThickness(surface: SurfaceRect): number {
	return Math.max(0, surface.thicknessM ?? DEFAULT_SURFACE_THICKNESS_M);
}

/** The loss crossing this surface's deck, dB. */
export function surfaceAttenuationDb(surface: SurfaceRect): number {
	return Math.max(0, surface.attenuationDb ?? DEFAULT_SURFACE_ATTENUATION_DB);
}

/**
 * How many steps a stair has, from its rise and the tread depth.
 *
 * Derived rather than stored: a stair's run is its rectangle, so the number of treads
 * follows from the rise — that is what the reference's "Auto (step depth 0.3 m)" means, and
 * a stored count could disagree with the shape.
 */
export function stepCount(surface: SurfaceRect, stepDepthM = STEP_DEPTH_M): number {
	const rise = Math.abs((surface.topHeightM ?? 0) - (surface.heightM ?? 0));
	if (rise <= 0 || stepDepthM <= 0) return 1;
	return Math.max(1, Math.round(rise / stepDepthM));
}

/**
 * The surface whose deck a path at this point crosses, if any.
 *
 * A client standing on a surface has its feet on the top of the deck, so a source *below*
 * the deck's underside has to pass through it. The test is on the signed vertical gap
 * between source and client: negative means the source is below the client, and more than
 * the deck's thickness below means it is past the underside.
 *
 * Returns the loss to charge, and the surface, so a caller that wants to draw the crossing
 * can. `gateGapM` is the ap–client gap in metres, negative when the AP is below the client.
 */
export function deckCrossing(
	surfaces: readonly SurfaceRect[] | null | undefined,
	x: number,
	y: number,
	gateGapM: number
): { surface: SurfaceRect; lossDb: number } | null {
	if (!surfaces || surfaces.length === 0) return null;
	let best: SurfaceRect | null = null;
	let bestTop = -Infinity;
	for (const surface of surfaces) {
		if (!surfaceContains(surface, x, y)) continue;
		const top = heightOf(surface, x, y);
		if (top <= 0) continue;
		// The highest deck at this point is the one the client stands on.
		if (top > bestTop) {
			bestTop = top;
			best = surface;
		}
	}
	if (!best) return null;
	if (gateGapM >= -surfaceThickness(best)) return null;
	const lossDb = surfaceAttenuationDb(best);
	return lossDb > 0 ? { surface: best, lossDb } : null;
}

