import { describe, expect, it } from 'vitest';
import {
	DEFAULT_COVERAGE_SOFTNESS_DB,
	OPTIMIZER_FULL_MARGIN_DB,
	coverageHorizontalReach,
	coverageUtilityAboveThreshold,
	reachAtMargin
} from './propagation.js';

/**
 * 目标函数的覆盖核及其软阈值。
 *
 * `softnessDb = 0` 时退化为硬阈值核；软阈值在阈值附近给出连续斜率。
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
		// 斜坡范围是 [−softness, +FULL_MARGIN]，阈值恰在中点，斜率为 1/(10 + 10)。
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
		// 同一区间内硬阈值核为常数，这正是软化要修正的问题。
		const hard = [-10, -5, -1].map((m) => coverageUtilityAboveThreshold(m));
		expect(new Set(hard).size).toBe(1);
	});

	it('keeps the slope gentler above the threshold than the hard kernel', () => {
		// 软化后阈值上的样本只值 0.5，同样的 dB 增益换来更少的效用，
		// 因此改动前后的分数不能按绝对值比较，覆盖率与分布仍可比较。
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
		// 余量降低 10 dB 时，可达距离按 n = 4 的幂次关系放大。
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
