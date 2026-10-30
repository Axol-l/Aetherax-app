/**
 * The wall-loss half of a link budget, in one place.
 *
 * Every consumer of the RF model has to answer the same two questions about a path:
 * "what do the walls on this floor charge?" and "what do they charge when the path leaves
 * one storey and arrives on another?". The answer is a march through a mask that charges
 * the material table once per crossing — but each consumer kept its own copy of the
 * plumbing around the march: which table belongs to which band, which figure to charge for
 * an id the table does not have, the mask's origin subtracted from both ends, and the
 * split of a cross-floor ray at the slab.
 *
 * That plumbing is what drifted: the heatmap, the coverage pass and the optimiser worker
 * are three copies of the same sequence, and each one can be edited without the others.
 * The march itself was already shared (`rayMarchWallAtten`); this module shares the layer
 * that turns a floor's mask into a *run* and a path into one or two runs.
 *
 * Deliberately not here: the rest of the budget (free-space loss, the antenna cuts, the
 * slab figure, diffraction, reflection). Those still differ per consumer by design — the
 * heatmap marches at a coarser stride and uses a polar field, the worker has no fields at
 * all — and folding them in would be a rewrite, not a deduplication.
 */
import { crossFloorLoss, crossFloorSegments } from './cross-floor.js';
import { rayMarchWallAtten } from './propagation.js';

export interface Point {
	x: number;
	y: number;
}

/**
 * One mask a ray can be marched through, with everything the march needs.
 *
 * `originX`/`originY` are the world coordinates of mask pixel (0, 0). The march works in
 * mask pixels, so a caller that has world points subtracts the origin — one pair of
 * subtractions that used to be written out at every call site, and that is easy to get
 * wrong in exactly one of them.
 */
export interface WallRun {
	mask: Uint8Array;
	width: number;
	height: number;
	/** Painted material id per pixel, or null when the floor has none. */
	materialMask: Uint8Array | null;
	/** dB per crossing, indexed by material id, for this run's band. */
	materialDb: number[];
	/** Charged for a material id the table does not contain. */
	fallbackDb: number;
	/** World coordinates of mask pixel (0, 0). */
	originX: number;
	originY: number;
	/** Material that counts when there is no material mask. */
	defaultMaterialId: number;
}

/**
 * dB charged by the walls between two world points, on one floor.
 *
 * `stride` is the march's step in pixels: the heatmap uses 2 because the wall band is six
 * pixels wide and it regenerates an image, while the evaluators march at 1.
 */
export function wallRunLoss(run: WallRun, from: Point, to: Point, stride = 1): number {
	return rayMarchWallAtten(
		run.mask,
		run.width,
		run.height,
		run.materialMask,
		run.materialDb,
		run.fallbackDb,
		from.x - run.originX,
		from.y - run.originY,
		to.x - run.originX,
		to.y - run.originY,
		stride,
		run.defaultMaterialId
	);
}

/**
 * dB charged by a cross-floor path, split at the storey it crosses.
 *
 * The ray leaves the AP through its own floor's plan, drops through the slab, and finishes
 * on the client's floor; each half is marched against the mask of the floor it actually
 * passes through. Returns null when there is no split to build — the two fractions are
 * equal, or the geometry is degenerate — so the caller can fall back to a single run, which
 * is what every hand-written copy of this did.
 */
export function splitWallRunLoss(
	source: WallRun,
	target: WallRun,
	sourceT: number,
	targetT: number,
	from: Point,
	to: Point,
	stride = 1
): number | null {
	const split = crossFloorSegments(sourceT, targetT, from.x, from.y, to.x, to.y);
	if (!split) return null;
	return crossFloorLoss(split, (floor, runFrom, runTo) =>
		wallRunLoss(floor === 'source' ? source : target, runFrom, runTo, stride)
	);
}
