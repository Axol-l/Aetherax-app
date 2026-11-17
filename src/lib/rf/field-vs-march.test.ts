import { debug } from '$lib/log.js';
import { describe, expect, it } from 'vitest';
import { buildAttenField, lookupAtten, rayMarchWallAtten } from './propagation.js';

/**
 * 热力图的场与墙面步进必须对同一面墙收取相同的损耗。
 *
 * 二者是同一问题的两种实现，每次穿墙都应取材料表中的同一数值，因此实际穿墙的射线结果必须一致。
 */

const CONCRETE_DB = 32;
const MATERIAL_DB = [CONCRETE_DB];
const W = 200;
const H = 120;
/** 在 `x0` 处生成 `thickness` 像素宽的竖直条带。 */
function wallBand(x0: number, thickness: number): Uint8Array {
	const mask = new Uint8Array(W * H);
	for (let y = 0; y < H; y++) for (let x = x0; x < x0 + thickness; x++) mask[y * W + x] = 1;
	return mask;
}

describe('the field against the march', () => {
	it('agrees on a perpendicular crossing, thick or thin', () => {
		for (const thickness of [1, 7]) {
			const mask = wallBand(100, thickness);
			const marched = rayMarchWallAtten(
				mask,
				W,
				H,
				null,
				MATERIAL_DB,
				CONCRETE_DB,
				20,
				10,
				160,
				10,
				1
			);
			const field = buildAttenField(20, 10, 160, mask, W, H, null, MATERIAL_DB, CONCRETE_DB, 3);
			const fromField = lookupAtten(field, 150, 10);
			debug(
				`MEASURE_FIELD perpendicular ${thickness} px: march ${marched.toFixed(2)} dB, field ${fromField.toFixed(2)} dB`
			);
			expect(marched).toBeCloseTo(CONCRETE_DB, 9);
			expect(fromField).toBeCloseTo(marched, 6);
		}
	});

	it('agrees on a slanted ray, because the angle is geometry and not a cost', () => {
		const mask = wallBand(100, 7);
		for (const [x1, y1] of [
			[160, 10],
			[160, 60],
			[160, 110]
		] as const) {
			const marched = rayMarchWallAtten(mask, W, H, null, MATERIAL_DB, CONCRETE_DB, 20, 10, x1, y1, 1);
			const field = buildAttenField(20, 10, 160, mask, W, H, null, MATERIAL_DB, CONCRETE_DB, 3);
			// 场是极坐标的：沿自身 0.5° 的射线步进再插值，因此斜向查表只有小误差而非精确相等。
			const fromField = lookupAtten(field, x1, y1);
			expect(marched).toBeCloseTo(CONCRETE_DB, 9);
			expect(Math.abs(fromField - marched)).toBeLessThan(1);
		}
	});

	it('agrees that a wall the ray does not cross costs nothing', () => {
		const mask = wallBand(100, 7);
		const marched = rayMarchWallAtten(mask, W, H, null, MATERIAL_DB, CONCRETE_DB, 20, 10, 90, 10, 1);
		const field = buildAttenField(20, 10, 160, mask, W, H, null, MATERIAL_DB, CONCRETE_DB, 3);
		expect(marched).toBe(0);
		expect(lookupAtten(field, 90, 10)).toBeCloseTo(0, 6);
	});
});
