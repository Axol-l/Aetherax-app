import { describe, expect, it } from 'vitest';
import { reachAtLevel } from '$lib/rf/propagation.js';
import { heatmapRegion } from './heatmap-region.js';

/**
 * The heatmap image's bounds.
 *
 * The rectangle used to be the plan plus `1.5 x interferenceRadius`, i.e. sized
 * from the ASSOCIATION radius (~30 m at 5 GHz / 20 dBm) while the colour ramp
 * can only reach the COVERAGE distance for the user's ramp floor (~12.6 m at the
 * default -70 dBm). The image was therefore ~9x larger than any area it could
 * colour, which blew the cell budget and widened the texel — and a widened texel
 * is what renders as flat colour patches joined by short ramps.
 */

/** 5 GHz, 20 dBm: level at 1 m is 20 - 46 = -26 dBm. */
const REF_5GHZ_20DBM = -26;
const WUPM = 33.05; // the calibration of the screenshot this was diagnosed from
/** Mask built at FLOORPLAN_TARGET_WIDTH, i.e. 800 world units wide. */
const MASK = { originX: 0, originY: 0, width: 800, height: 627 };
const FINE = 4;
const BUDGET = 250_000;

const apAt = (x: number, y: number) => ({ x, y, power: 20, band: '5ghz' });

describe('reachAtLevel', () => {
	it('inverts the log-distance model for the level at 1 m', () => {
		// 20 dBm 5 GHz reaches ~12.6 m at the -70 dBm coverage threshold.
		expect(reachAtLevel(REF_5GHZ_20DBM, -70)).toBeCloseTo(12.58, 1);
		// 2.4 GHz at the same power: PL0 = 39.6, so -19.6 dBm at 1 m, 18.2 m at -70.
		expect(reachAtLevel(20 - 39.6, -70)).toBeCloseTo(18.2, 1);
	});

	it('grows when the ramp floor is lowered, and is zero at or above the 1 m level', () => {
		expect(reachAtLevel(REF_5GHZ_20DBM, -95)).toBeGreaterThan(
			reachAtLevel(REF_5GHZ_20DBM, -70)
		);
		expect(reachAtLevel(REF_5GHZ_20DBM, -26)).toBe(0);
		expect(reachAtLevel(REF_5GHZ_20DBM, -10)).toBe(0);
	});
});

describe('heatmapRegion', () => {
	it('keeps the fine texel for a normal plan, where the old radius margin did not', () => {
		const aps = [apAt(400, 313)];
		const region = heatmapRegion(aps, MASK, -70, WUPM, FINE, BUDGET)!;
		expect(region).not.toBeNull();

		// The fix: the budget is never reached, so no widening.
		expect(region.texel).toBe(FINE);
		expect(region.cols * region.rows).toBeLessThanOrEqual(BUDGET);

		// The old margin (1.5 x the association radius, 1.5 x 988 units) would have
		// asked for a 3764-unit span and widened the texel to 8.
		const oldRadius = 1.5 * Math.round(29.9 * WUPM);
		const oldSpan = 800 + 2 * oldRadius;
		expect(oldSpan).toBeGreaterThan(3000);
		expect(region.cols * region.texel).toBeLessThan(oldSpan);
	});

	it('always covers the plan mask', () => {
		const region = heatmapRegion([apAt(400, 313)], MASK, -70, WUPM, FINE, BUDGET)!;
		expect(region.x0).toBeLessThanOrEqual(MASK.originX);
		expect(region.y0).toBeLessThanOrEqual(MASK.originY);
		expect(region.x0 + region.cols * region.texel).toBeGreaterThanOrEqual(
			MASK.originX + MASK.width
		);
		expect(region.y0 + region.rows * region.texel).toBeGreaterThanOrEqual(
			MASK.originY + MASK.height
		);
	});

	it('covers each AP only as far as its own reach', () => {
		const near = heatmapRegion([apAt(400, 313)], MASK, -70, WUPM, FINE, BUDGET)!;
		const far = heatmapRegion([apAt(4000, 313)], MASK, -70, WUPM, FINE, BUDGET)!;
		// An AP dragged off the plan still counts, but only out to its reach. The
		// edge lands on the texel lattice, so it can overshoot by less than a texel.
		const reach = reachAtLevel(REF_5GHZ_20DBM, -70) * WUPM * 1.05;
		const farEdge = far.x0 + far.cols * far.texel;
		expect(farEdge).toBeGreaterThanOrEqual(4000 + reach);
		expect(farEdge).toBeLessThan(4000 + reach + far.texel);
		expect(near.x0 + near.cols * near.texel).toBeLessThan(4000);
	});

	it('widens the texel instead of overflowing the budget', () => {
		// A big plan at a -95 dBm floor: reach ~53 m, so the region is huge.
		const big = { originX: 0, originY: 0, width: 4000, height: 3000 };
		const region = heatmapRegion([apAt(2000, 1500)], big, -95, WUPM, FINE, BUDGET)!;
		expect(region.texel).toBeGreaterThan(FINE);
		expect(region.cols * region.rows).toBeLessThanOrEqual(BUDGET * 1.1);
	});

	it('falls back to the mask when no AP contributes any colour', () => {
		// AP at 0 dBm on 5 GHz: 1 m level is -46 dBm, below a -55 dBm floor.
		const weak = [{ x: 400, y: 313, power: 0, band: '5ghz' }];
		const region = heatmapRegion(weak, MASK, -55, WUPM, FINE, BUDGET)!;
		expect(region.x0).toBe(0);
		expect(region.y0).toBe(0);
		expect(region.cols * region.texel).toBe(800);
	});

	it('covers a drawn area that extends past the mask', () => {
		// A planning area is the user saying where the floor is; it can sit outside the
		// plan image's frame. The image used to stop at the mask, so the clip then trimmed
		// the field to a rectangle the area did not share.
		const clip = [
			{ x: 0, y: 0 },
			{ x: 1600, y: 0 },
			{ x: 1600, y: 1200 },
			{ x: 0, y: 1200 }
		];
		const region = heatmapRegion([apAt(400, 313)], MASK, -70, WUPM, FINE, BUDGET, clip)!;
		expect(region.x0 + region.cols * region.texel).toBeGreaterThanOrEqual(1600);
		expect(region.y0 + region.rows * region.texel).toBeGreaterThanOrEqual(1200);
	});

	it('returns null when there is nothing to draw', () => {
		expect(heatmapRegion([], null, -70, WUPM, FINE, BUDGET)).toBeNull();
	});
});
