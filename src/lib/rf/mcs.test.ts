import { describe, expect, it } from 'vitest';
import { estimatedPhyRateMbps, maxPhyRateMbps, sinrToMcs } from './mcs.js';

describe('SINR to MCS/rate mapping', () => {
	it('selects higher MCS as SNR improves', () => {
		expect(sinrToMcs(-90)).toBe(-1);
		expect(sinrToMcs(0)).toBe(-1);
		expect(sinrToMcs(25)).toBe(7);
		expect(sinrToMcs(35)).toBe(11);
	});

	it('scales rate by channel width and streams', () => {
		const rate20 = estimatedPhyRateMbps(40, 20, 1);
		expect(rate20).toBeCloseTo(143.4, 3);
		expect(estimatedPhyRateMbps(40, 80, 2)).toBeCloseTo(rate20 * 8, 3);
		expect(estimatedPhyRateMbps(-90, 80, 2)).toBe(0);
	});

	it('reports the scale top for the current width', () => {
		expect(maxPhyRateMbps(20, 2)).toBeCloseTo(286.8, 3);
		expect(maxPhyRateMbps(80, 2)).toBeCloseTo(1147.2, 3);
	});
});
