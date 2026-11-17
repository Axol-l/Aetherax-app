import { describe, expect, it } from 'vitest';
import {
	CAPACITY_UTILIZATION,
	DEFAULT_ACTIVITY_FACTOR,
	ROOM_DEMAND_MBPS,
	apCapacityMbps,
	effectivePhyMbps,
	requiredAps,
	roomDemandMbps
} from './capacity-plan.js';

describe('coarse capacity plan', () => {
	it('uses a 30% activity factor for the coarse plan', () => {
		expect(DEFAULT_ACTIVITY_FACTOR).toBe(0.3);
	});

	it('does not invent demand for unlabelled area', () => {
		expect(roomDemandMbps(0)).toBe(0);
	});

	it('weights room demand in three tiers', () => {
		expect(roomDemandMbps(2)).toBe(ROOM_DEMAND_MBPS.low);
		expect(roomDemandMbps(10)).toBe(ROOM_DEMAND_MBPS.standard);
		expect(roomDemandMbps(20)).toBe(ROOM_DEMAND_MBPS.high);
	});

	it('makes the 1-stream share lower the effective PHY', () => {
		const mixed = effectivePhyMbps(40, 20);
		expect(mixed).toBeGreaterThan(0);
		expect(mixed).toBeLessThan(243);
	});

	it('applies MAC efficiency and utilisation to AP supply', () => {
		const phy = effectivePhyMbps(40, 20);
		expect(apCapacityMbps(40, 20)).toBeCloseTo(phy * 0.45 * CAPACITY_UTILIZATION, 6);
	});

	it('rounds required APs up', () => {
		expect(requiredAps(1000, 300)).toBe(4);
		expect(requiredAps(0, 300)).toBe(0);
		expect(requiredAps(1000, 0)).toBe(0);
	});
});
