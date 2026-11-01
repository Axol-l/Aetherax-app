/**
 * How far a point is from the nearest wall, and which wall that is.
 *
 * The access-point annotation needs two answers the wall mask does not give
 * directly: the distance from an AP to the wall it sits next to, and the
 * *position* of that wall so a dashed connector can be drawn to it. Both come
 * out of one exact Euclidean distance transform over the mask.
 *
 * Exact rather than a chamfer approximation: this number is shown to the user as
 * a measurement ("1.2 m to wall"), and a 3-4 chamfer is 2-4% off, which is
 * visible at the precision the readout is rounded to. The transform is O(pixels)
 * once per mask, and every later query — one per AP, on every frame, including
 * the frames of a drag — is an array lookup.
 *
 * A **wall-mounted** access point gets a different question answered: it is *on*
 * a wall, so "how far to the nearest wall" is its own bracket depth and says
 * nothing. What matters for a unit that is screwed to a wall is how much wall it has
 * *beside* it — the first wall along `facing ± 90`, which is where the mounting wall
 * ends. See `firstWallAlong` and `nearestSideWall` at the foot of this file.
 *
 * Mask pixels are world units: the mask's origin is a world coordinate and its
 * width and height are world extents (see `DecodedWallMask`), so a distance in
 * mask pixels is a distance in world units and only the calibration turns it
 * into metres. Nothing here knows about metres.
 *
 * The two-pass Felzenszwalb–Huttenlocher transform below also carries each
 * pixel's nearest wall pixel through the passes, which is what makes the
 * connector endpoint available without a second pass over the mask.
 *
 * Field layout: the wall mask is 1 = wall, 0 = passable.
 */

import type { DecodedWallMask } from './mask-codec.js';

/** A point on the nearest wall, in mask pixels, and the distance to it. */
export interface NearestWallPixel {
	/** Distance in mask pixels, which are world units. */
	distance: number;
	/** The nearest wall pixel itself, in mask pixel coordinates. */
	x: number;
	y: number;
}

export interface WallDistanceTransform {
	readonly width: number;
	readonly height: number;
	/**
	 * The nearest wall pixel to a mask pixel, or null when there is no wall to
	 * measure to at all — an empty mask, or a mask too large to transform.
	 */
	query(px: number, py: number): NearestWallPixel | null;
}

/**
 * Above this many mask pixels the transform is skipped rather than attempted.
 *
 * A mask this size is already past the point where the rest of the application
 * gives up (the encode path warns above 8000 px a side), and the transient
 * arrays here are 8 bytes per pixel. Skipping costs an annotation, not a mask.
 */
const MAX_TRANSFORM_PIXELS = 16_000_000;

/**
 * "No wall in this column", as an integer.
 *
 * Distances are held squared, and squared distances between two pixels of a mask
 * are whole numbers, so an `Int32Array` carries them exactly and quickly — which
 * is why there is no `Infinity` here and no floating-point distance array. The
 * sentinel only has to beat every real squared distance (a 16M-pixel mask is at
 * most 4000² + 3000², 25 million) and leave room for `f + q²` to stay in range.
 */
const NO_WALL = 1 << 30;

/** Build the transform, or null when there is nothing to measure from. */
export function wallDistanceTransform(
	data: Uint8Array,
	width: number,
	height: number
): WallDistanceTransform | null {
	if (width <= 0 || height <= 0) return null;
	if (width * height > MAX_TRANSFORM_PIXELS) return null;
	if (data.length < width * height) return null;
	if (!data.some((v) => v !== 0)) return null;

	// Squared distance to the nearest wall in the same column, and that wall's
	// row. Pass one is a plain nearest-neighbour scan down and back up a column,
	// so it needs none of the envelope machinery of pass two.
	const columnDistance = new Int32Array(width * height);
	const columnSource = new Int32Array(width * height);
	for (let x = 0; x < width; x++) {
		let last = -1;
		for (let y = 0; y < height; y++) {
			const i = y * width + x;
			if (data[i] !== 0) last = y;
			columnDistance[i] = last < 0 ? NO_WALL : (y - last) * (y - last);
			columnSource[i] = last;
		}
		last = -1;
		for (let y = height - 1; y >= 0; y--) {
			const i = y * width + x;
			if (data[i] !== 0) last = y;
			if (last < 0) continue;
			const d = (y - last) * (y - last);
			if (d < columnDistance[i]!) {
				columnDistance[i] = d;
				columnSource[i] = last;
			}
		}
	}

	/*
	 * Pass two: combine the columns within each row.
	 *
	 * For every pixel the answer is min over x' of (x - x')² + columnDistance(x'),
	 * the lower envelope of a set of parabolas. `source` carries the column-pass
	 * wall row along with each parabola, so the winner also names the wall pixel.
	 */
	const distance = new Int32Array(width * height);
	const source = new Int32Array(width * height);
	const vertices = new Int32Array(width);
	const boundaries = new Float64Array(width + 1);
	const rowInput = new Int32Array(width);
	const rowSource = new Int32Array(width);

	for (let y = 0; y < height; y++) {
		const row = y * width;
		for (let x = 0; x < width; x++) {
			rowInput[x] = columnDistance[row + x]!;
			rowSource[x] = columnSource[row + x]!;
		}

		let k = -1;
		for (let q = 0; q < width; q++) {
			const fq = rowInput[q]!;
			if (fq >= NO_WALL) continue;
			if (k < 0) {
				k = 0;
				vertices[0] = q;
				boundaries[0] = -Infinity;
				boundaries[1] = Infinity;
				continue;
			}
			let s = 0;
			for (;;) {
				const p = vertices[k]!;
				s = (fq + q * q - (rowInput[p]! + p * p)) / (2 * (q - p));
				if (s > boundaries[k]!) break;
				k--;
				if (k < 0) break;
			}
			if (k < 0) {
				k = 0;
				vertices[0] = q;
				boundaries[0] = -Infinity;
				boundaries[1] = Infinity;
			} else {
				k++;
				vertices[k] = q;
				boundaries[k] = s;
				boundaries[k + 1] = Infinity;
			}
		}

		if (k < 0) {
			// Not one column of this row met a wall.
			for (let x = 0; x < width; x++) {
				distance[row + x] = NO_WALL;
				source[row + x] = -1;
			}
			continue;
		}

		let j = 0;
		for (let x = 0; x < width; x++) {
			while (boundaries[j + 1]! < x) j++;
			const p = vertices[j]!;
			distance[row + x] = (x - p) * (x - p) + rowInput[p]!;
			// The winning parabola is at column p and carries the wall row it was
			// measured from, so together they name the wall pixel.
			source[row + x] = rowSource[p]! * width + p;
		}
	}

	return {
		width,
		height,
		query(px: number, py: number): NearestWallPixel | null {
			if (px < 0 || py < 0 || px >= width || py >= height) return null;
			const i = py * width + px;
			const squared = distance[i]!;
			const wallIndex = source[i]!;
			if (squared >= NO_WALL || wallIndex < 0) return null;
			const x = wallIndex % width;
			return { distance: Math.sqrt(squared), x, y: (wallIndex - x) / width };
		}
	};
}

/**
 * A transform for a mask, cached across calls.
 *
 * `version` is the caller's invalidation counter, and it is not optional: the
 * wall editor's `materialize()` patches its raster **in place** and hands back
 * the same `Uint8Array` after every stroke, so identity alone would serve a
 * distance field measured from walls that are no longer there. The tap that
 * republishes the mask has to bump the version.
 */
export interface WallDistanceCache {
	transform: WallDistanceTransform | null;
	data: Uint8Array | null;
	width: number;
	height: number;
	version: number;
}

/** An empty cache slot for a view to own. */
export function createWallDistanceCache(): WallDistanceCache {
	return { transform: null, data: null, width: 0, height: 0, version: -1 };
}

/** The transform for `mask` at `version`, rebuilt only when either has moved. */
export function cachedWallDistanceTransform(
	cache: WallDistanceCache,
	mask: DecodedWallMask | null,
	version: number
): WallDistanceTransform | null {
	if (!mask) {
		cache.transform = null;
		cache.data = null;
		cache.width = 0;
		cache.height = 0;
		cache.version = version;
		return null;
	}
	if (
		cache.data === mask.data &&
		cache.width === mask.width &&
		cache.height === mask.height &&
		cache.version === version
	) {
		return cache.transform;
	}
	cache.transform = wallDistanceTransform(mask.data, mask.width, mask.height);
	cache.data = mask.data;
	cache.width = mask.width;
	cache.height = mask.height;
	cache.version = version;
	return cache.transform;
}

/**
 * The nearest wall to either **side** of a facing direction, or null if the plan
 * runs out first.
 *
 * What a wall-mounted access point is actually up against. It is screwed to a wall
 * whose normal is `facingDeg`, so that wall runs away to both sides of it: marching
 * along `facingDeg ± 90` stays clear of the mounting wall and meets whatever ends it
 * — a corner, a perpendicular partition, the far end of the room. The nearer of the
 * two is the binding one, and it is the number a planner wants: it says how much wall
 * the unit has beside it, and a value near zero says it is in a corner.
 *
 * The opposite wall — straight ahead — is deliberately *not* measured: a unit that
 * radiates forwards is not helped by knowing how deep the room is, and the depth is
 * already visible on the plan.
 */
export function nearestSideWall(
	data: Uint8Array,
	width: number,
	height: number,
	originX: number,
	originY: number,
	worldX: number,
	worldY: number,
	facingDeg: number,
	maxW: number
): FirstWallHit | null {
	const right = firstWallAlong(
		data,
		width,
		height,
		originX,
		originY,
		worldX,
		worldY,
		facingDeg + 90,
		maxW
	);
	const left = firstWallAlong(
		data,
		width,
		height,
		originX,
		originY,
		worldX,
		worldY,
		facingDeg - 90,
		maxW
	);
	if (!right) return left;
	if (!left) return right;
	return left.distanceW < right.distanceW ? left : right;
}

/** Where a ray from a point first meets a wall, in world units. */
export interface FirstWallHit {
	x: number;
	y: number;
	/** Distance from the starting point to that wall, in world units. */
	distanceW: number;
}

/**
 * The first wall along a bearing, or null when the ray leaves the plan first.
 *
 * The measurement a **wall-mounted** access point needs. It is on a wall already,
 * so its distance to the nearest one is the bracket it hangs on; what a unit that
 * radiates in one direction has instead is a *throw* — how much room is in front of
 * it before a wall stops it. That is this: a march along the facing direction until
 * the mask says wall.
 *
 * Sampled every half world unit rather than every one, because a diagonal ray
 * stepping a whole unit can pass between two pixels of a thin partition and report
 * a room twice as deep as it is. The mask is world units, so the step is 0.5 of one
 * — about 1.5 cm at the default calibration, which is finer than the reading's own
 * rounding.
 *
 * A ray that leaves the mask before meeting a wall returns null: the plan does not
 * say what is out there, and a number invented at the mask's edge would read as a
 * measurement.
 */
export function firstWallAlong(
	data: Uint8Array,
	width: number,
	height: number,
	originX: number,
	originY: number,
	worldX: number,
	worldY: number,
	bearingDeg: number,
	maxW: number
): FirstWallHit | null {
	if (width <= 0 || height <= 0 || data.length < width * height) return null;
	const rad = (bearingDeg * Math.PI) / 180;
	const dx = Math.cos(rad);
	const dy = Math.sin(rad);
	const step = 0.5;
	for (let d = 0; d <= maxW; d += step) {
		const px = Math.round(worldX - originX + dx * d);
		const py = Math.round(worldY - originY + dy * d);
		// Off the plan: there is nothing further to measure against.
		if (px < 0 || py < 0 || px >= width || py >= height) return null;
		if (data[py * width + px] === 1) {
			const x = originX + px;
			const y = originY + py;
			// Measured to the pixel that was hit rather than to the step that found
			// it: the two differ by up to half a step, and the point returned is the
			// one the caption draws its connector to.
			return { x, y, distanceW: Math.hypot(x - worldX, y - worldY) };
		}
	}
	return null;
}
