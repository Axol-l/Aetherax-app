import { describe, expect, it } from 'vitest';
import { estimatedPhyRateMbps, sinrToMcs } from './mcs.js';

describe('SINR to MCS/rate mapping', () => {
	it('selects higher MCS as SINR improves', () => {
		expect(sinrToMcs(-90)).toBe(-1);
		expect(sinrToMcs(-70)).toBe(4);
		expect(sinrToMcs(-49)).toBe(11);
	});

	it('scales rate by channel width and streams', () => {
		const rate20 = estimatedPhyRateMbps(-49, 20, 1);
		expect(rate20).toBeCloseTo(143.4, 3);
		expect(estimatedPhyRateMbps(-49, 80, 2)).toBeCloseTo(rate20 * 8, 3);
		expect(estimatedPhyRateMbps(-90, 80, 2)).toBe(0);
	});
});
