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

/** A column as the rasteriser takes it: a footprint and a material. */
export interface RasterColumn {
	shape: 'rect' | 'circle';
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
 * The band is the width the vector layer draws with, so what the model charges is what the
 * plan shows, whichever way the walls were entered. Material ids go into their own array:
 * zero there means "unpainted" and the floor's default applies, which is the distinction
 * the comparison proved matters.
 */
export function rasteriseWalls(
	walls: readonly RasterWall[],
	bandWidth = 6,
	padding = 8,
	extent?: { width: number; height: number; originX: number; originY: number },
	/**
	 * Columns to paint as solid obstruction: a pier is a wall with no length to draw, and a
	 * round column is one with no line at all. They are filled rather than stroked, because
	 * what they obstruct is their footprint.
	 */
	columns: readonly RasterColumn[] = []
): RasterisedMasks | null {
	if (walls.length === 0 && columns.length === 0) return null;
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
	for (const column of columns) {
		// A circle reaches its radius past the point it was dragged to, so the frame has to
		// grow by that much on every side or the disc is cropped by the mask it lives in.
		const r =
			column.shape === 'circle' ? Math.hypot(column.bx - column.ax, column.by - column.ay) : 0;
		minX = Math.min(minX, column.ax - r, column.bx - r);
		minY = Math.min(minY, column.ay - r, column.by - r);
		maxX = Math.max(maxX, column.ax + r, column.bx + r);
		maxY = Math.max(maxY, column.ay + r, column.by + r);
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

	// Columns are filled, not stroked: their whole footprint is obstruction.
	for (const column of columns) {
		const cx = column.ax - originX;
		const cy = column.ay - originY;
		/*
		 * A circle's bounds are the circle, not the drag box.
		 *
		 * A column is dragged from its centre to its edge, so the box between the two points
		 * is one quadrant — scanning it filled a quarter of the disc while the vector layer
		 * drew the whole ring, which read as "the column only blocks half the heatmap". The
		 * circle scans its own square now.
		 */
		const circle = column.shape === 'circle';
		const radius = circle ? Math.hypot(column.bx - column.ax, column.by - column.ay) : 0;
		const x0 = circle ? cx - radius : Math.min(column.ax, column.bx) - originX;
		const x1 = circle ? cx + radius : Math.max(column.ax, column.bx) - originX;
		const y0 = circle ? cy - radius : Math.min(column.ay, column.by) - originY;
		const y1 = circle ? cy + radius : Math.max(column.ay, column.by) - originY;
		for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(height - 1, Math.ceil(y1)); y++) {
			for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(width - 1, Math.ceil(x1)); x++) {
				if (circle) {
					const px = x + 0.5;
					const py = y + 0.5;
					if ((px - cx) ** 2 + (py - cy) ** 2 > radius * radius) continue;
				}
				const index = y * width + x;
				wall[index] = 1;
				material[index] = column.material;
			}
		}
	}

	return { wall, material, width, height, originX, originY };
}

/**
 * A mask that says "no walls here", in a frame the caller already knows.
 *
 * Deleting the last wall has to empty the mask without moving the frame: every label,
 * sample and room type on the floor is addressed in that frame, and dropping the mask
 * entirely would read as "this floor has no plan" rather than "this floor has no walls".
 */
export function emptyWallMasks(extent: {
	width: number;
	height: number;
	originX: number;
	originY: number;
}): RasterisedMasks {
	const { width, height, originX, originY } = extent;
	return {
		wall: new Uint8Array(width * height),
		material: new Uint8Array(width * height),
		width,
		height,
		originX,
		originY
	};
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
