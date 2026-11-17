import { describe, expect, it } from 'vitest';
import { directFieldCpu, type DirectFieldInput } from './direct-field.js';

function baseInput(overrides: Partial<DirectFieldInput> = {}): DirectFieldInput {
	return {
		width: 8,
		height: 8,
		originX: 0,
		originY: 0,
		texel: 10,
		worldUnitsPerMeter: 20,
		aps: [{ x: 5, y: 5, powerDbm: 20, frequencyMhz: 5180, verticalGapM: 1.5, slabLossDb: 0 }],
		...overrides
	};
}

describe('WebGPU direct-field CPU reference', () => {
	it('fills every pixel with the strongest AP', () => {
		const result = directFieldCpu(baseInput());
		expect(result.apIndex).toHaveLength(64);
		expect([...result.apIndex].every((index) => index === 0)).toBe(true);
		expect([...result.dbm].every((level) => Number.isFinite(level))).toBe(true);
	});

	it('counts a wall crossing as additional loss', () => {
		const mask = new Uint8Array(8 * 8);
		for (let y = 0; y < 8; y++) mask[y * 8 + 6] = 255;
		const withoutWall = directFieldCpu(baseInput());
		const withWall = directFieldCpu(
			baseInput({
				wallMask: {
					data: mask,
					width: 8,
					height: 8,
					originX: 0,
					originY: 0,
					wallLossDb: 6
				}
			})
		);
		const rightPixel = 3 * 8 + 6;
		expect(withWall.dbm[rightPixel]!).toBeLessThan(withoutWall.dbm[rightPixel]! - 4);
	});

	it('prefers the stronger AP', () => {
		const result = directFieldCpu(
			baseInput({
				aps: [
					{ x: 5, y: 5, powerDbm: 20, frequencyMhz: 5180, verticalGapM: 1.5, slabLossDb: 0 },
					{ x: 75, y: 75, powerDbm: 20, frequencyMhz: 5180, verticalGapM: 1.5, slabLossDb: 0 }
				]
			})
		);
		expect(result.apIndex[0]).toBe(0);
		expect(result.apIndex[63]).toBe(1);
	});
});
