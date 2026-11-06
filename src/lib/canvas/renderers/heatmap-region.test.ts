import { describe, expect, it } from 'vitest';
import { reachAtLevel } from '$lib/rf/propagation.js';
import { heatmapRegion } from './heatmap-region.js';

/**
 * 热力图图像的边界。
 * 矩形按各 AP 的可绘制覆盖半径而非关联半径计算，半径取信号降到色阶下限的距离，
 * 因此不会因范围过大而放大纹素。
 */

/** 5 GHz、20 dBm：1 m 处电平为 20 - 46 = -26 dBm。 */
const REF_5GHZ_20DBM = -26;
const WUPM = 33.05; // 世界单位与米的换算系数
/** 按 FLOORPLAN_TARGET_WIDTH 生成的掩码，宽 800 世界单位。 */
const MASK = { originX: 0, originY: 0, width: 800, height: 627 };
const FINE = 4;
const BUDGET = 250_000;

const apAt = (x: number, y: number) => ({ x, y, power: 20, band: '5ghz' });

describe('reachAtLevel', () => {
	it('inverts the log-distance model for the level at 1 m', () => {
		// 20 dBm、5 GHz 在 -70 dBm 覆盖门限下的可达距离约为 12.6 m。
		expect(reachAtLevel(REF_5GHZ_20DBM, -70)).toBeCloseTo(12.58, 1);
		// 2.4 GHz 同功率下 PL0 = 39.6，1 m 处为 -19.6 dBm，-70 dBm 门限下约 18.2 m。
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

		// 预算未被触及，因此不会放大纹素。
		expect(region.texel).toBe(FINE);
		expect(region.cols * region.rows).toBeLessThanOrEqual(BUDGET);

		// 旧的余量按关联半径的 1.5 倍计算，会要求 3764 单位的跨度，
		// 并把纹素放大到 8。
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
		// 拖到平面图之外的 AP 仍计入，但只到其覆盖半径为止；
		// 边界落在纹素格点上，因此最多超出不到一个纹素。
		const reach = reachAtLevel(REF_5GHZ_20DBM, -70) * WUPM * 1.05;
		const farEdge = far.x0 + far.cols * far.texel;
		expect(farEdge).toBeGreaterThanOrEqual(4000 + reach);
		expect(farEdge).toBeLessThan(4000 + reach + far.texel);
		expect(near.x0 + near.cols * near.texel).toBeLessThan(4000);
	});

	it('widens the texel instead of overflowing the budget', () => {
		// 大平面图配 -95 dBm 下限：覆盖半径约 53 m，区域因此很大。
		const big = { originX: 0, originY: 0, width: 4000, height: 3000 };
		const region = heatmapRegion([apAt(2000, 1500)], big, -95, WUPM, FINE, BUDGET)!;
		expect(region.texel).toBeGreaterThan(FINE);
		expect(region.cols * region.rows).toBeLessThanOrEqual(BUDGET * 1.1);
	});

	it('falls back to the mask when no AP contributes any colour', () => {
		// 5 GHz 上 0 dBm 的 AP：1 m 处电平为 -46 dBm，低于 -55 dBm 下限。
		const weak = [{ x: 400, y: 313, power: 0, band: '5ghz' }];
		const region = heatmapRegion(weak, MASK, -55, WUPM, FINE, BUDGET)!;
		expect(region.x0).toBe(0);
		expect(region.y0).toBe(0);
		expect(region.cols * region.texel).toBe(800);
	});

	it('covers a drawn area that extends past the mask', () => {
		// 规划区域可能位于平面图图像范围之外，图像必须覆盖它，
		// 否则裁剪会裁到不含该区域的矩形。
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
