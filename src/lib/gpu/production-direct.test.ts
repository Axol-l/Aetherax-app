import { describe, expect, it } from 'vitest';
import { productionDirectCpu, type ProductionDirectInput } from './production-direct.js';

function input(): ProductionDirectInput {
	return {
		width: 8,
		height: 8,
		originX: 0,
		originY: 0,
		texel: 10,
		worldUnitsPerMeter: 20,
		aps: [
			{ x: 5, y: 5, referenceDbm: 20, pathLossExponent: 4, verticalGapM: 1.5, slabLossDb: 0 }
		],
		wallMask: {
			data: new Uint8Array(64),
			width: 8,
			height: 8,
			originX: 0,
			originY: 0,
			materialMap: null,
			materialDb: [],
			fallbackDb: 0,
			defaultMaterialId: 0,
			stride: 2
		}
	};
}

describe('production direct field', () => {
	it('returns one layer per AP', () => {
		const result = productionDirectCpu(input());
		expect(result.dbm).toHaveLength(64);
		expect(result.apCount).toBe(1);
		expect([...result.dbm].every(Number.isFinite)).toBe(true);
	});

	it('counts a material wall crossing', () => {
		const mask = new Uint8Array(64);
		const material = new Uint8Array(64);
		for (let y = 0; y < 8; y++) {
			mask[y * 8 + 6] = 1;
			material[y * 8 + 6] = 2;
		}
		const base = productionDirectCpu(input());
		const withWall = productionDirectCpu({
			...input(),
			wallMask: {
				...input().wallMask!,
				data: mask,
				materialMap: material,
				materialDb: [0, 4, 9, 0],
				stride: 1
			}
		});
		const pixel = 3 * 8 + 7;
		expect(withWall.dbm[pixel]!).toBeLessThan(base.dbm[pixel]! - 4);
	});
});
