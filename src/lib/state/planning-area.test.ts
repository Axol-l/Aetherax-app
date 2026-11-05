/**
 * 规划区域：用户画出来、用来说明楼层范围的多边形。
 *
 * 这个功能的意义就是在真实图纸上比自动推断准，所以测试盯的是推断出错的两种情形：
 * 门洞开得宽的房间里全成了室外，两条墙线之间的墙腔里全成了室内。
 */
import { describe, expect, it } from 'vitest';
import {
	clipInteriorToPlanningArea,
	isUsablePlanningArea,
	pointInPlanningArea,
	type PlanningArea
} from './planning-area.js';

/** 从 (0,0) 到 (100,100) 的 100 x 100 正方形。 */
const square: PlanningArea = [
	{ x: 0, y: 0 },
	{ x: 100, y: 0 },
	{ x: 100, y: 100 },
	{ x: 0, y: 100 }
];

describe('pointInPlanningArea', () => {
	it('knows inside from outside', () => {
		expect(pointInPlanningArea({ x: 50, y: 50 }, square)).toBe(true);
		expect(pointInPlanningArea({ x: -5, y: 50 }, square)).toBe(false);
		expect(pointInPlanningArea({ x: 50, y: 140 }, square)).toBe(false);
	});

	it('handles a concave area, which is what a real floor is', () => {
		// 一个 L 形：右下角那块凹口不属于楼层。
		const l: PlanningArea = [
			{ x: 0, y: 0 },
			{ x: 40, y: 0 },
			{ x: 40, y: 40 },
			{ x: 100, y: 40 },
			{ x: 100, y: 100 },
			{ x: 0, y: 100 }
		];
		expect(pointInPlanningArea({ x: 20, y: 20 }, l)).toBe(true);
		expect(pointInPlanningArea({ x: 70, y: 70 }, l)).toBe(true);
		// 凹口里：在外接矩形内，但在多边形外。
		expect(pointInPlanningArea({ x: 70, y: 20 }, l)).toBe(false);
	});

	it('treats a polygon of fewer than three points as no area at all', () => {
		expect(isUsablePlanningArea(null)).toBe(false);
		expect(isUsablePlanningArea([{ x: 0, y: 0 }])).toBe(false);
		expect(isUsablePlanningArea([{ x: 0, y: 0 }, { x: 10, y: 10 }])).toBe(false);
		expect(pointInPlanningArea({ x: 0, y: 0 }, [{ x: 0, y: 0 }])).toBe(false);
	});
});

describe('clipInteriorToPlanningArea', () => {
	/** 20 x 20 的室内掩码，像素 (0,0) 对应世界坐标 (100,100)。 */
	function fullMask(size = 20): Uint8Array {
		return new Uint8Array(size * size).fill(1);
	}

	it('keeps only the part of the domain inside the area', () => {
		const interior = fullMask();
		// 正方形盖住世界坐标 x/y 100..110，也就是掩码的第 0..10 列。
		const area: PlanningArea = [
			{ x: 100, y: 100 },
			{ x: 110, y: 100 },
			{ x: 110, y: 110 },
			{ x: 100, y: 110 }
		];
		const kept = clipInteriorToPlanningArea(interior, 20, 20, 100, 100, area);
		// 十乘十的世界方块在这里也是十乘十像素，所以四百个像素里留下十分之一。
		expect(kept).toBe(100);
		expect(interior[0]).toBe(1);
		expect(interior[15]).toBe(0);
		expect(interior[19 * 20 + 19]).toBe(0);
	});

	it('leaves the mask alone when there is no usable area', () => {
		const interior = fullMask(4);
		const kept = clipInteriorToPlanningArea(interior, 4, 4, 0, 0, []);
		expect(kept).toBe(16);
		expect([...interior]).toEqual(new Array(16).fill(1));
	});

	it('reports an area drawn off the floor as keeping nothing', () => {
		const interior = fullMask(4);
		const kept = clipInteriorToPlanningArea(interior, 4, 4, 0, 0, [
			{ x: 500, y: 500 },
			{ x: 600, y: 500 },
			{ x: 600, y: 600 }
		]);
		expect(kept).toBe(0);
	});
});
