/**
 * 在答案已知的几何上比较两种墙体模型。
 * 用例分别覆盖几何完全一致（差值为零）、一方看到而另一方漏掉的墙（记为分歧而非舍入差）
 * 以及系统性偏差（均值偏离而绝对差较小）。
 */
import { describe, expect, it } from 'vitest';
import { getFlatAttenuation } from '$lib/domain/materials.js';
import { compareWallModels } from './wall-model-compare.js';
import type { WallSegment } from './wall-crossings.js';

const BAND = '5ghz' as const;
const from = { x: 0, y: 0 };

/**
 * 该频段下石膏板一次穿越的损耗。
 * 数值取自模型所用的材质表，而不是写死常数。
 */
const DRYWALL_DB = getFlatAttenuation(0, BAND);

/** x = 5 处的一道竖直石膏板墙，穿过它即承担一次穿越损耗。 */
const wall: WallSegment = { ax: 5, ay: -50, bx: 5, by: 50, material: 0 as WallSegment['material'] };

/** 位于墙同一侧的若干采样点。 */
const points = [
	{ x: 10, y: 0 },
	{ x: 10, y: 10 },
	{ x: -10, y: 0 },
	{ x: 10, y: -10 }
];

describe('compareWallModels', () => {
	it('reports zero difference when both models agree', () => {
		const result = compareWallModels({
			walls: [wall],
			band: BAND,
			from,
			points,
			// 两条穿墙的射线各计一次穿越，另外两条不计。
			rasterLoss: (_from, to) => (to.x > 5 ? DRYWALL_DB : 0)
		});
		expect(result.samples).toBe(4);
		expect(result.meanAbsDb).toBeCloseTo(0);
		expect(result.maxAbsDb).toBeCloseTo(0);
		expect(result.disagreements).toBe(0);
		expect(result.rasterMeanDb).toBeCloseTo(result.vectorMeanDb);
	});

	it('counts a wall one model misses as a disagreement, not a rounding error', () => {
		const result = compareWallModels({
			walls: [wall],
			band: BAND,
			from,
			points,
			// 完全看不到墙体的栅格步进：正是矢量模型要消除的漏计。
			rasterLoss: () => 0
		});
		// 四个采样点中有三个位于墙的另一侧，第四个在源的后方。
		expect(result.disagreements).toBe(3);
		expect(result.maxAbsDb).toBeCloseTo(DRYWALL_DB);
		expect(result.vectorMeanDb).toBeCloseTo((DRYWALL_DB * 3) / 4);
		expect(result.rasterMeanDb).toBe(0);
	});

	it('reports a systematic bias through the means', () => {
		const result = compareWallModels({
			walls: [wall],
			band: BAND,
			from,
			points,
			// 每条穿墙射线都偏大 1 dB：平均绝对差为 0.75，两均值相差 1 dB。
			rasterLoss: (_from, to) => (to.x > 5 ? DRYWALL_DB + 1 : 0)
		});
		expect(result.meanAbsDb).toBeCloseTo(0.75);
		expect(result.vectorMeanDb - result.rasterMeanDb).toBeCloseTo(-0.75);
		expect(result.disagreements).toBe(0);
	});

	it('is safe on no samples', () => {
		const result = compareWallModels({
			walls: [wall],
			band: BAND,
			from,
			points: [],
			rasterLoss: () => 0
		});
		expect(result.samples).toBe(0);
		expect(result.meanAbsDb).toBe(0);
		expect(result.maxAt).toBeNull();
	});
});
