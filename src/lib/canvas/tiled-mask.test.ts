import { describe, expect, it } from 'vitest';
import { TiledMask } from './tiled-mask.js';

/**
 * 墙体掩码光栅包围盒的回归测试。
 * 覆盖“擦除一堵墙会导致整个图层消失”的问题：实际是 `blitTile` 抛出
 * `RangeError: offset is out of bounds`，编辑未能提交，图层于是渲染出陈旧或空的内容。
 */

const TILE = 256;

/** 一个 4x4 掩码，局部 (0, 0) 处有一堵墙，并放在给定的世界坐标偏移上。 */
function maskAt(originX: number, originY: number): TiledMask {
	const w = 4;
	const h = 4;
	const walls = new Uint8Array(w * h);
	walls[0] = 1;
	const materials = new Uint8Array(w * h);
	materials[0] = 3;
	return TiledMask.fromFlat(walls, w, h, materials, 0, originX, originY);
}

describe('TiledMask bounds', () => {
	it('starts at the first occupied tile, not the world origin', () => {
		const mask = maskAt(2000, 1200);
		const b = mask.bounds;
		expect(b).not.toBeNull();
		// 瓦片网格为 256 px，因此包围盒从包含内容的瓦片开始，
		// 而不是从 0 开始，以免带偏移的楼层生成几乎全空的光栅。
		expect(b!.originX).toBe(Math.floor(2000 / TILE) * TILE);
		expect(b!.originY).toBe(Math.floor(1200 / TILE) * TILE);
		expect(b!.width).toBeLessThanOrEqual(TILE * 2);
		expect(b!.height).toBeLessThanOrEqual(TILE * 2);
	});

	it('does not grow when clearing a pixel that was never set', () => {
		const mask = maskAt(2000, 1200);
		const before = mask.bounds!;
		// 在绘制区域外很远处用笔刷擦除，验证包围盒不会增大。
		mask.paintCircle(before.originX - 5000, before.originY - 5000, 5, 0);
		expect(mask.bounds).toEqual(before);
	});

	it('materialises a material tile that sits outside the wall tiles', () => {
		const mask = maskAt(2000, 1200);
		// 在没有墙的位置放一个材质。`setMaterial` 会独立分配瓦片，从不查询墙体网格，
		// 因此光栅必须同时覆盖两者。
		const matX = 2000 + 4000;
		const matY = 1200 + 4000;
		mask.setMaterial(matX, matY, 4);

		let result: ReturnType<TiledMask['materialize']> = null;
		expect(() => {
			result = mask.materialize();
		}).not.toThrow();

		expect(result).not.toBeNull();
		const r = result!;
		const idx = (matY - r.originY) * r.width + (matX - r.originX);
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(idx).toBeLessThan(r.width * r.height);
		expect(r.materialData?.[idx]).toBe(4);
	});

	it('keeps the wall pixel at the same world position after a round trip', () => {
		const mask = maskAt(2000, 1200);
		const r = mask.materialize()!;
		const idx = (1200 - r.originY) * r.width + (2000 - r.originX);
		expect(r.data[idx]).toBe(1);
		expect(mask.getPixel(2000, 1200)).toBe(1);
		// 且从未是墙的像素保持干净。
		expect(mask.getPixel(2001, 1200)).toBe(0);
	});
});

/**
 * 对齐后的楼层带有小数偏移，该偏移被用作掩码的像素原点。
 * 以小数索引写入类型化数组会被静默丢弃，因此这类楼层的墙体像素会全部丢失，首次编辑还会把空白光栅覆盖回去。
 */
describe('TiledMask with a fractional origin', () => {
	it('lands the pixels on the pixel grid instead of dropping them', () => {
		const mask = maskAt(0, 14.279614761037685);
		// 采用四舍五入而非截断，且像素确实存在。
		expect(mask.getPixel(0, 14)).toBe(1);
		expect(mask.getPixel(0, 15)).toBe(0);
	});

	it('materialises exactly one pixel, not an all-zero raster', () => {
		const mask = maskAt(0, 14.279614761037685);
		const r = mask.materialize()!;
		let set = 0;
		for (const v of r.data) if (v) set++;
		expect(set).toBe(1);
		expect(r.data[(14 - r.originY) * r.width + (0 - r.originX)]).toBe(1);
	});

	it('reports a whole-pixel box, so the raster and the numbers agree', () => {
		// 对齐楼层的小数偏移会让包围盒终点成为小数，而光栅分配与画布编码各自截断，
		// 导致报告高度与实际尺寸不一致。
		const mask = maskAt(0, 14.279614761037685);
		mask.setFrame(0, 14.279614761037685, 4, 526);
		const r = mask.materialize()!;
		for (const v of [r.originX, r.originY, r.width, r.height]) {
			expect(Number.isInteger(v)).toBe(true);
		}
		expect(r.data.length).toBe(r.width * r.height);
		expect(r.height).toBe(540);
	});
});

/**
 * “清除所有墙体”后空掩码仍需可物化：没有像素就没有包围盒，`materialize()` 返回 null，
 * 而 null 被读作“该楼层没有户型图”，之后每次笔画都会被静默丢弃。
 */
describe('TiledMask after clear()', () => {
	it('still materialises, so a cleared floor stays editable', () => {
		const mask = maskAt(2000, 1200);
		mask.clear();

		const cleared = mask.materialize();
		expect(cleared).not.toBeNull();
		// 掩码收缩回它的框，清除是回收瓦片的唯一方式，而正是这个框让空光栅仍可物化。
		expect(cleared!.originX).toBe(2000);
		expect(cleared!.originY).toBe(1200);
		expect(cleared!.width).toBe(4);
		expect(cleared!.height).toBe(4);
		expect(cleared!.data.some((v) => v !== 0)).toBe(false);

		// 之后的一次笔画能够保留，这正是关键。
		mask.paintCircle(2000, 1200, 1, 1);
		const after = mask.materialize()!;
		const idx = (1200 - after.originY) * after.width + (2000 - after.originX);
		expect(after.data[idx]).toBe(1);
	});

	it('reports no raster at all only once the frame is dropped too', () => {
		const mask = maskAt(2000, 1200);
		mask.clear();
		mask.setFrame(0, 0, 0, 0);
		expect(mask.materialize()).toBeNull();
	});
});
