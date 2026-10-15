import { describe, expect, it } from 'vitest';
import { buildAttenField, lookupAtten, rayMarchWallAtten } from './propagation.js';

/**
 * The heatmap's field and the wall march must charge the same thing for the same wall.
 *
 * They are two constructions of one question — "how much wall loss between this AP and this
 * point" — and for a while they answered it differently: the march accumulated the *length of
 * material* the ray walked (which on a painted material mask is the width of the material
 * brush), while the field charged the table's figure per crossing. On a reported project that
 * read 68 % coverage from the panel against 95 % from the heatmap on the same floor.
 *
 * Now that both charge one figure per crossing, this file is the instrument that keeps them
 * together: for rays that actually cross the wall, the two must agree.
 */

const CONCRETE_DB = 32;
const MATERIAL_DB = [CONCRETE_DB];
const W = 200;
const H = 120;
/** A vertical band of `thickness` px at `x0`. */
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
			console.log(
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
			// The field is polar: it marches along its own 0.5° rays and interpolates, so a
			// slanted lookup is within a small tolerance rather than exact.
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
