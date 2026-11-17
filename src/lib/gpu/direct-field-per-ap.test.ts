import { describe, expect, it } from 'vitest';
import { directFieldCpu, type DirectFieldInput } from './direct-field.js';
import { directFieldPerApCpu } from './direct-field-per-ap.js';

function input(): DirectFieldInput {
	return {
		width: 8,
		height: 8,
		originX: 0,
		originY: 0,
		texel: 10,
		worldUnitsPerMeter: 20,
		aps: [
			{ x: 5, y: 5, powerDbm: 20, frequencyMhz: 5180, verticalGapM: 1.5, slabLossDb: 0 },
			{ x: 75, y: 75, powerDbm: 18, frequencyMhz: 2437, verticalGapM: 2.5, slabLossDb: 0 }
		],
		wallMask: {
			data: new Uint8Array(64).fill(0),
			width: 8,
			height: 8,
			originX: 0,
			originY: 0,
			wallLossDb: 6
		}
	};
}

describe('per-AP direct field', () => {
	it('keeps one layer per AP and agrees with the strongest-AP reference', () => {
		const data = input();
		const perAp = directFieldPerApCpu(data);
		const strongest = directFieldCpu(data);
		expect(perAp.dbm).toHaveLength(perAp.pixels * perAp.apCount);
		for (let pixel = 0; pixel < perAp.pixels; pixel++) {
			const a = perAp.dbm[pixel]!;
			const b = perAp.dbm[perAp.pixels + pixel]!;
			expect(Math.max(a, b)).toBeCloseTo(strongest.dbm[pixel]!, 5);
		}
	});
});
