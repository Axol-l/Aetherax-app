/**
 * The shared wall-run boundary between the three propagation consumers.
 *
 * The march itself (`rayMarchWallAtten`) is already unit-tested where it lives; what this
 * file pins is the plumbing around it, which is what used to be copied: the mask origin,
 * the material table and its fallback, and the split of a cross-floor ray into two runs on
 * two masks. If these drift, the heatmap and the optimiser disagree about the same plan —
 * which is the failure the module exists to prevent.
 */
import { describe, expect, it } from 'vitest';
import { rayMarchWallAtten } from './propagation.js';
import { splitWallRunLoss, wallRunLoss, type WallRun } from './link-budget.js';

const WIDTH = 40;
const HEIGHT = 20;

/** [empty, drywall, concrete, glass] — the ids the fixtures paint. */
const MATERIAL_DB = [0, 7, 20, 40];

/** A mask with a vertical wall at each x in `walls`, painted with `material`. */
function maskWithWalls(walls: Array<{ x: number; material: number }>): {
	mask: Uint8Array;
	materialMask: Uint8Array;
} {
	const mask = new Uint8Array(WIDTH * HEIGHT);
	const materialMask = new Uint8Array(WIDTH * HEIGHT);
	for (const wall of walls) {
		for (let y = 0; y < HEIGHT; y++) {
			const idx = y * WIDTH + wall.x;
			mask[idx] = 1;
			materialMask[idx] = wall.material;
		}
	}
	return { mask, materialMask };
}

function run(
	mask: Uint8Array,
	materialMask: Uint8Array | null,
	originX = 0,
	originY = 0,
	defaultMaterialId = 1
): WallRun {
	return {
		mask,
		width: WIDTH,
		height: HEIGHT,
		materialMask,
		materialDb: MATERIAL_DB,
		fallbackDb: 99,
		originX,
		originY,
		defaultMaterialId
	};
}

describe('wall run loss', () => {
	it('charges the table once per crossing, in the mask frame', () => {
		const { mask, materialMask } = maskWithWalls([
			{ x: 10, material: 2 },
			{ x: 30, material: 1 }
		]);

		// The same path twice: once in mask pixels, once in world units with an origin.
		const expected = rayMarchWallAtten(mask, WIDTH, HEIGHT, materialMask, MATERIAL_DB, 99, 0, 0, 40, 0, 1, 1);
		const shifted = wallRunLoss(run(mask, materialMask, 100, 200), { x: 100, y: 200 }, { x: 140, y: 200 });

		expect(expected).toBe(20 + 7);
		expect(shifted).toBe(expected);
	});

	it('charges the default material when the floor has no material map', () => {
		const { mask } = maskWithWalls([
			{ x: 10, material: 2 },
			{ x: 30, material: 2 }
		]);
		// No map: every crossing is the run's default material, here drywall (id 1).
		expect(wallRunLoss(run(mask, null), { x: 0, y: 0 }, { x: 40, y: 0 })).toBe(7 + 7);
	});
});

describe('split wall run loss', () => {
	it('charges each half against its own floor', () => {
		const source = maskWithWalls([{ x: 10, material: 2 }]);
		// The target mask is the same grid, so a wall across y = 16 is a row.
		const targetMask = new Uint8Array(WIDTH * HEIGHT);
		const targetMaterials = new Uint8Array(WIDTH * HEIGHT);
		for (let x = 0; x < WIDTH; x++) {
			targetMask[16 * WIDTH + x] = 1;
			targetMaterials[16 * WIDTH + x] = 1;
		}
		const target = { mask: targetMask, materialMask: targetMaterials };

		// t = 0.3 leaves the source at (12, 6); the target entry is (28, 14), and the
		// target run reaches y = 16 on its way to (40, 20).
		const loss = splitWallRunLoss(
			run(source.mask, source.materialMask),
			run(target.mask, target.materialMask),
			0.3,
			0.7,
			{ x: 0, y: 0 },
			{ x: 40, y: 20 }
		);

		expect(loss).toBe(20 + 7);
	});

	it('returns null when the ray never changes floor', () => {
		const { mask, materialMask } = maskWithWalls([{ x: 10, material: 2 }]);
		const same = run(mask, materialMask);
		expect(splitWallRunLoss(same, same, 0, 0, { x: 0, y: 0 }, { x: 40, y: 0 })).toBeNull();
	});
});
