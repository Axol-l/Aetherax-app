/**
 * 用线段做标定的测试。
 *
 * 按面积算依赖检测出的轮廓，轮廓不准结果就不准；量线问的是图上能直接读出的尺寸，
 * 轮廓没闭合或只画了一个房间时也能用。
 */
import { describe, expect, it } from 'vitest';
import { segmentLengthMetres, segmentLengthWorld, wupmFromSegment } from './calibrate.js';

describe('wupmFromSegment', () => {
	it('turns a measured line into a scale', () => {
		// 520 像素实际是 10 米，就是 52 像素每米。
		expect(wupmFromSegment({ a: { x: 0, y: 0 }, b: { x: 520, y: 0 } }, 10)).toBeCloseTo(52);
	});

	it('measures diagonals, not just horizontal runs', () => {
		// 3-4-5 直角三角形：世界长度 5 对应 2.5 米，即 2 像素每米。
		expect(wupmFromSegment({ a: { x: 0, y: 0 }, b: { x: 3, y: 4 } }, 2.5)).toBeCloseTo(2);
	});

	it('refuses inputs that carry no scale', () => {
		const point = { x: 10, y: 10 };
		// 两端点了同一个点：等于没量。
		expect(wupmFromSegment({ a: point, b: { ...point } }, 5)).toBeNull();
		// 实际长度为 0 会除爆，负数显然是填错了。
		expect(wupmFromSegment({ a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }, 0)).toBeNull();
		expect(wupmFromSegment({ a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }, -3)).toBeNull();
		expect(wupmFromSegment({ a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }, Number.NaN)).toBeNull();
	});
});

describe('segmentLengthMetres', () => {
	it('reads a line back as a length at a known scale', () => {
		expect(segmentLengthMetres({ a: { x: 0, y: 0 }, b: { x: 0, y: 260 } }, 52)).toBeCloseTo(5);
	});

	it('has nothing to say without a scale', () => {
		expect(segmentLengthMetres({ a: { x: 0, y: 0 }, b: { x: 0, y: 260 } }, 0)).toBeNull();
	});

	it('agrees with segmentLengthWorld on the raw length', () => {
		const segment = { a: { x: 12, y: 30 }, b: { x: 312, y: 30 } };
		expect(segmentLengthWorld(segment)).toBeCloseTo(300);
	});
});
