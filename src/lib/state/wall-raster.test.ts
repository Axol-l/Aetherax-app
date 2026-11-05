/**
 * 把线段变成应用其它部分读的掩码。
 *
 * 这是矢量模型唯一碰到栅格模型的地方，下游只读掩码、不关心来源。测试只盯两件事：几何落在
 * 画的位置上，材质 id 一路活下来。
 */
import { describe, expect, it } from 'vitest';
import { paintedPixels, rasteriseThin, rasteriseWalls } from './wall-raster.js';

describe('rasteriseWalls', () => {
	it('puts a horizontal wall on the row it was drawn on', () => {
		const masks = rasteriseWalls(
			[{ ax: 100, ay: 50, bx: 160, by: 50, material: 0 }],
			1,
			6
		)!;
		expect(masks).not.toBeNull();
		// 原点是包围盒减掉 padding，所以行号能倒推回来。
		const row = 50 - masks.originY;
		const col = 100 - masks.originX;
		expect(masks.wall[row * masks.width + col]).toBe(1);
		// 中间位置；再往后超出端点圆头就是空的。
		expect(masks.wall[row * masks.width + col + 30]).toBe(1);
		expect(masks.wall[row * masks.width + col + 63]).toBe(0);
	});

	it('records the material of each wall', () => {
		const masks = rasteriseWalls(
			[
				{ ax: 0, ay: 0, bx: 40, by: 0, material: 4 },
				{ ax: 0, ay: 20, bx: 40, by: 20, material: 3 }
			],
			1,
			2
		)!;
		const rowA = 0 - masks.originY;
		const rowB = 20 - masks.originY;
		expect(masks.material[rowA * masks.width + (0 - masks.originX)]).toBe(4);
		expect(masks.material[rowB * masks.width + (0 - masks.originX)]).toBe(3);
	});

	it('paints a band as wide as it is asked to', () => {
		const wide = rasteriseWalls([{ ax: 0, ay: 0, bx: 40, by: 0, material: 0 }], 9, 6)!;
		const thin = rasteriseThin([{ ax: 0, ay: 0, bx: 40, by: 0, material: 0 }], 4)!;
		expect(paintedPixels(wide)).toBeGreaterThan(paintedPixels(thin) * 2);
	});

	it('has nothing to paint for no walls', () => {
		expect(rasteriseWalls([])).toBeNull();
	});

	it('keeps the mask tight to the drawing', () => {
		const masks = rasteriseWalls([{ ax: 200, ay: 120, bx: 260, by: 120, material: 0 }], 1, 2)!;
		// 包围盒 60 x 0，加上两边 padding 和带子自身的宽度。
		expect(masks.width).toBeLessThan(70);
		expect(masks.height).toBeLessThan(10);
	});

	/**
	 * 柱是从圆心拖到边缘的，所以两点撑起的只是一个象限。照那个象限扫描只填了四分之一个
	 * 圆盘，而矢量层画的是整个圆：掩码和图纸对不上，热力图看着像柱只挡了一半。
	 */
	it('fills the whole disc of a circular column, not the quadrant it was dragged across', () => {
		const masks = rasteriseWalls(
			[],
			1,
			2,
			undefined,
			[{ shape: 'circle', ax: 100, ay: 100, bx: 120, by: 100, material: 0 }]
		)!;
		expect(paintedPixels(masks)).toBeGreaterThan(Math.PI * 20 * 20 * 0.85);

		const at = (wx: number, wy: number): number => {
			const x = wx - masks.originX;
			const y = wy - masks.originY;
			return masks.wall[y * masks.width + x]!;
		};
		// 圆心四周、半径一半处。
		expect(at(110, 100)).toBe(1);
		expect(at(90, 100)).toBe(1);
		expect(at(100, 110)).toBe(1);
		expect(at(100, 90)).toBe(1);
		// 圆外一点点。
		expect(at(121, 100)).toBe(0);
		expect(at(79, 100)).toBe(0);
	});
});
