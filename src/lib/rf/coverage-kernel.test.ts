import { describe, expect, it } from 'vitest';
import {
	DEFAULT_COVERAGE_SOFTNESS_DB,
	OPTIMIZER_FULL_MARGIN_DB,
	coverageHorizontalReach,
	coverageUtilityAboveThreshold,
	reachAtMargin
} from './propagation.js';

/**
 * The objective's coverage kernel, and the softness the F2 measurement added.
 *
 * The optimiser used to treat the coverage threshold as a hard edge. On a
 * coverage-limited floor that made every uncovered sample a plateau — a sample one
 * metre outside the circle and one fifteen metres outside both scored 0 — and
 * eight restarts differed by 5.3 points of coverage while their objective differed
 * by 0.9% (`docs/ROADMAP.md` F1, second measurement). Softness puts a slope back
 * into that region.
 *
 * The load-bearing property is that `softnessDb = 0` is the *old* kernel exactly:
 * that is what makes the before/after comparison a real A/B rather than two
 * models, and what lets every measurement taken before this change stand.
 */

describe('coverageUtilityAboveThreshold', () => {
	it('is the hard threshold at zero softness', () => {
		expect(coverageUtilityAboveThreshold(-1)).toBe(0);
		expect(coverageUtilityAboveThreshold(0)).toBe(0);
		expect(coverageUtilityAboveThreshold(5)).toBe(0.5);
		expect(coverageUtilityAboveThreshold(OPTIMIZER_FULL_MARGIN_DB)).toBe(1);
		expect(coverageUtilityAboveThreshold(30)).toBe(1);
	});

	it('ramps from zero below the threshold to full above it', () => {
		const softness = 10;
		// The ramp spans [-softness, +FULL_MARGIN], so the threshold itself is the
		// midpoint and the slope is 1/(10 + 10).
		expect(coverageUtilityAboveThreshold(-softness, softness)).toBe(0);
		expect(coverageUtilityAboveThreshold(-softness - 0.1, softness)).toBe(0);
		expect(coverageUtilityAboveThreshold(0, softness)).toBe(0.5);
		expect(coverageUtilityAboveThreshold(OPTIMIZER_FULL_MARGIN_DB, softness)).toBe(1);
		expect(coverageUtilityAboveThreshold(100, softness)).toBe(1);
	});

	it('is strictly increasing across the threshold, which is the point', () => {
		const softness = DEFAULT_COVERAGE_SOFTNESS_DB;
		const values = [-10, -7.5, -5, -2.5, 0, 2.5, 5].map((m) =>
			coverageUtilityAboveThreshold(m, softness)
		);
		for (let i = 1; i < values.length; i++) {
			expect(values[i]!).toBeGreaterThan(values[i - 1]!);
		}
		// And the hard kernel is flat over the same range, which is what it fixes.
		const hard = [-10, -5, -1].map((m) => coverageUtilityAboveThreshold(m));
		expect(new Set(hard).size).toBe(1);
	});

	it('keeps the slope gentler above the threshold than the hard kernel', () => {
		// Not a defect but a consequence worth pinning: with softness the sample that
		// sits on the threshold is worth half, so the same absolute gain in dB buys
		// less utility. Scores from before and after the change are therefore not
		// comparable in absolute terms; coverage and spread are.
		expect(coverageUtilityAboveThreshold(0, 10)).toBeGreaterThan(coverageUtilityAboveThreshold(0));
		expect(coverageUtilityAboveThreshold(10, 10)).toBe(coverageUtilityAboveThreshold(10));
	});
});

describe('coverageHorizontalReach with a negative margin', () => {
	it('reaches further below the threshold, by the same 1.78x the interference term uses', () => {
		const radius = 1414;
		const coverage = coverageHorizontalReach(radius);
		const soft = coverageHorizontalReach(radius, 0, 0, -10);
		expect(soft).toBeCloseTo(coverage * Math.pow(10, 10 / 40), 6);
		// At n = 4 a 10 dB reduction in the required margin is 1.78x the distance.
		expect(soft / coverage).toBeCloseTo(1.7783, 3);
	});

	it('shrinks the horizontal reach by the vertical gap, as the coverage one does', () => {
		const radius = 1414;
		const flat = coverageHorizontalReach(radius, 0, 0, -10);
		const withGap = coverageHorizontalReach(radius, 0, 300, -10);
		expect(withGap).toBeCloseTo(Math.sqrt(flat * flat - 300 * 300), 6);
	});

	it('agrees with reachAtMargin, which is what the worker skips on', () => {
		const radius = 900;
		expect(coverageHorizontalReach(radius, 4, 0, 0)).toBeCloseTo(reachAtMargin(radius, 4, 0), 9);
		expect(coverageHorizontalReach(radius, 4, 0, -10)).toBeCloseTo(
			reachAtMargin(radius, 4, -10),
			9
		);
	});
});
