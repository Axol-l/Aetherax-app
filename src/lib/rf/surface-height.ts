/**
 * Raised walking surfaces — a mezzanine, a stair, a ramp — as a height field.
 * 
 * The shape is deliberately one rectangle with a height at each end:
 *
 * - a **platform** is level, so both heights are the same;
 * - a **ramp** rises linearly along its run;
 * - a **stair** rises along its run in the same field.
 */

export type SurfaceKind = 'platform' | 'ramp' | 'stair';

/** What a raised deck is made of. */
export type SurfaceMaterialId = 'concrete' | 'timber' | 'steel' | 'glass';

export interface SurfaceMaterial {
	id: SurfaceMaterialId;
	label: string;
	/** Per-crossing loss at the band the model charges, dB. */
	attenuationDb: number;
	/** The colour the plan and the 3D view draw the deck in, so it reads as its material. */
	color: readonly [number, number, number];
}

/** The colour of a deck whose material nobody has picked: the amber it always was. */
export const DEFAULT_SURFACE_COLOR: readonly [number, number, number] = [196, 132, 74];

/** The presets the toolbar offers, in the order it lists them. */
export const SURFACE_MATERIALS: readonly SurfaceMaterial[] = [
	{ id: 'concrete', label: 'Concrete', attenuationDb: 20, color: [166, 170, 176] },
	{ id: 'timber', label: 'Timber', attenuationDb: 10, color: [176, 123, 79] },
	{ id: 'steel', label: 'Steel', attenuationDb: 30, color: [124, 138, 154] },
	{ id: 'glass', label: 'Glass', attenuationDb: 6, color: [111, 199, 216] }
];

/** A material preset by id, or null for an id a document no longer knows. */
export function surfaceMaterial(id: SurfaceMaterialId | undefined): SurfaceMaterial | null {
	return SURFACE_MATERIALS.find((material) => material.id === id) ?? null;
}

/** The colour to draw a deck in: its material's, or the custom amber. */
export function surfaceColor(id: SurfaceMaterialId | undefined): readonly [number, number, number] {
	return surfaceMaterial(id)?.color ?? DEFAULT_SURFACE_COLOR;
}

/** The geometry a height field needs — a rectangle and the height at each end. */
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
	 */
	thicknessM?: number;
	/**
	 * Loss through the deck, dB. Charged once to a path that crosses it.
	 */
	attenuationDb?: number;
	/**
	 * What the deck is made of. A preset for `attenuationDb`; absent in projects saved
	 * before surfaces had a material, and in surfaces whose loss was typed by hand.
	 */
	material?: SurfaceMaterialId;
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
	if (surface.attenuationDb !== undefined) return Math.max(0, surface.attenuationDb);
	return surfaceMaterial(surface.material)?.attenuationDb ?? DEFAULT_SURFACE_ATTENUATION_DB;
}

/**
 * How many steps a stair has, from its rise and the tread depth.
 */
export function stepCount(surface: SurfaceRect, stepDepthM = STEP_DEPTH_M): number {
	const rise = Math.abs((surface.topHeightM ?? 0) - (surface.heightM ?? 0));
	if (rise <= 0 || stepDepthM <= 0) return 1;
	return Math.max(1, Math.round(rise / stepDepthM));
}

/**
 * The surface whose deck a path at this point crosses, if any.
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

