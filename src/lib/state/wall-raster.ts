/**
 * Rasterising the vector walls, so the rest of the app can be driven by them today.
 *
 * The plan has always been "the segments are the truth, the mask is derived". The cheap way
 * to get there is not to rewrite the march and the attenuation field — it is to make the mask
 * *be* the derivation. Every consumer the app already has (the heatmap's field, the
 * optimiser's domain, the coverage samples, the interior test) reads a wall mask and a
 * material mask; feed those from the segments and they are vector-driven with no change to
 * any of their own maths.
 *
 * That also makes the change reversible in one action: re-detect to go back to the drawing.
 */
import type { WallMaterialId } from '../canvas/materials.js';

export interface RasterWall {
	ax: number;
	ay: number;
	bx: number;
	by: number;
	material: number;
}

export interface RasterisedMasks {
	wall: Uint8Array;
	material: Uint8Array;
	width: number;
	height: number;
	originX: number;
	originY: number;
}

/**
 * Paint the segments into a wall mask and a material mask.
 *
 * The band is the same width the vector layer draws and the smallest brush the raster tool
 * offers — six units across — so a plan looks and behaves the same whichever way it was
 * entered. Material ids go into their own array: zero there means "unpainted" and the floor's
 * default applies, which is the distinction the comparison proved matters.
 */
export function rasteriseWalls(
	walls: readonly RasterWall[],
	bandWidth = 6,
	padding = 8,
	extent?: { width: number; height: number; originX: number; originY: number }
): RasterisedMasks | null {
	if (walls.length === 0) return null;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const wall of walls) {
		minX = Math.min(minX, wall.ax, wall.bx);
		minY = Math.min(minY, wall.ay, wall.by);
		maxX = Math.max(maxX, wall.ax, wall.bx);
		maxY = Math.max(maxY, wall.ay, wall.by);
	}
	if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;

	/*
	 * The extent is the *existing* mask's when there is one, and that is not a detail.
	 *
	 * Everything downstream — the sample grid, the heatmap's texels, the interior test, the
	 * coverage figure — addresses the mask the plan was drawn in. A mask sized to the walls'
	 * bounding box is a different frame: samples fall outside it, the field is generated for
	 * the wrong rectangle, and the heatmap comes out as a fan of colour around the AP rather
	 * than over the floor.
	 */
	const originX = extent ? extent.originX : Math.floor(minX) - padding;
	const originY = extent ? extent.originY : Math.floor(minY) - padding;
	const width = extent ? extent.width : Math.max(1, Math.ceil(maxX - originX) + padding);
	const height = extent ? extent.height : Math.max(1, Math.ceil(maxY - originY) + padding);
	// A cap on the working size: a stray far-out segment would otherwise allocate a mask of
	// millions of pixels and stall the tab.
	if (width * height > 16_000_000) return null;

	const wall = new Uint8Array(width * height);
	const material = new Uint8Array(width * height);
	const radius = Math.max(1, Math.round(bandWidth / 2));

	for (const segment of walls) {
		const length = Math.hypot(segment.bx - segment.ax, segment.by - segment.ay);
		const steps = Math.max(1, Math.ceil(length));
		for (let i = 0; i <= steps; i++) {
			const t = i / steps;
			const cx = Math.round(segment.ax + (segment.bx - segment.ax) * t - originX);
			const cy = Math.round(segment.ay + (segment.by - segment.ay) * t - originY);
			for (let dy = -radius; dy <= radius; dy++) {
				for (let dx = -radius; dx <= radius; dx++) {
					const x = cx + dx;
					const y = cy + dy;
					if (x < 0 || y < 0 || x >= width || y >= height) continue;
					const index = y * width + x;
					wall[index] = 1;
					material[index] = segment.material;
				}
			}
		}
	}

	return { wall, material, width, height, originX, originY };
}

/** A band one pixel wide, for tests and for reasoning about the geometry alone. */
export function rasteriseThin(walls: readonly RasterWall[], padding = 2): RasterisedMasks | null {
	return rasteriseWalls(walls, 1, padding);
}

/** How many pixels the segments cover, for a caller that wants to sanity-check the result. */
export function paintedPixels(masks: RasterisedMasks): number {
	let count = 0;
	for (let i = 0; i < masks.wall.length; i++) if (masks.wall[i]) count++;
	return count;
}

export const DEFAULT_WALL_BAND = 6;

export type { WallMaterialId };
