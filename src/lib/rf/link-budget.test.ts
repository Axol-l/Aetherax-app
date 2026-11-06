/**
 * 校验穿墙步进外层的共享逻辑：掩码原点、材料表及其回退值，以及跨层射线在两套掩码上的切分。
 * 步进本身已在别处单测，这里只锁定调用方容易各自复制的部分。
 */
import { describe, expect, it } from 'vitest';
import { rayMarchWallAtten } from './propagation.js';
import { splitWallRunLoss, wallRunLoss, type WallRun } from './link-budget.js';

const WIDTH = 40;
const HEIGHT = 20;

/** [空、石膏板、混凝土、玻璃]：测试掩码使用的材质 id。 */
const MATERIAL_DB = [0, 7, 20, 40];

/** 在 `walls` 中每个 x 处生成一道竖直墙，并涂上对应的材质。 */
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

		// 同一路径算两次：一次用掩码像素坐标，一次带原点用世界坐标。
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
		// 没有材质图时，每次穿墙都按默认材质计费，此处为石膏板（id 1）。
		expect(wallRunLoss(run(mask, null), { x: 0, y: 0 }, { x: 40, y: 0 })).toBe(7 + 7);
	});
});

describe('split wall run loss', () => {
	it('charges each half against its own floor', () => {
		const source = maskWithWalls([{ x: 10, material: 2 }]);
		// 目标掩码使用同一网格，因此 y = 16 处的横墙就是一行。
		const targetMask = new Uint8Array(WIDTH * HEIGHT);
		const targetMaterials = new Uint8Array(WIDTH * HEIGHT);
		for (let x = 0; x < WIDTH; x++) {
			targetMask[16 * WIDTH + x] = 1;
			targetMaterials[16 * WIDTH + x] = 1;
		}
		const target = { mask: targetMask, materialMask: targetMaterials };

		// t = 0.3 时在 (12, 6) 离开源层，目标层从 (28, 14) 起步，
		// 并在飞向 (40, 20) 的途中经过 y = 16。
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
