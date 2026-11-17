/**
 * 从画好的掩码里描墙。
 *
 * 值得做的是手画墙做不到的：描出的线段和掩码覆盖同一批墙，换模型不改变覆盖率。测试盯住
 * 三个行为：一条墙带出一根线、横截面被忽略、被缺口打断的同一道墙会合回一根。
 */
import { describe, expect, it } from 'vitest';
import { traceWallsFromMask } from './wall-trace.js';
import type { WallMaterialId } from '$lib/domain/materials.js';

const DEFAULT = 0 as WallMaterialId;

/** 把一块实心矩形画进掩码。 */
function paint(
	mask: Uint8Array,
	width: number,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	value = 1
): void {
	for (let y = y0; y <= y1; y++) {
		for (let x = x0; x <= x1; x++) mask[y * width + x] = value;
	}
}

describe('traceWallsFromMask', () => {
	it('turns a horizontal band into one segment along its middle', () => {
		const width = 100;
		const height = 40;
		const mask = new Uint8Array(width * height);
		// 一道 60 长、6 厚的墙，y 从 10 到 15。
		paint(mask, width, 20, 10, 80, 15);
		const walls = traceWallsFromMask(mask, null, width, height, DEFAULT);
		const horizontals = walls.filter((wall) => wall.ay === wall.by);
		expect(horizontals.length).toBe(1);
		expect(horizontals[0]!.ax).toBe(20);
		expect(horizontals[0]!.bx).toBe(80);
		// 在厚度中间，不是某条边上。
		expect(horizontals[0]!.ay).toBeGreaterThanOrEqual(10);
		expect(horizontals[0]!.ay).toBeLessThanOrEqual(15);
	});

	it('turns a vertical band into one vertical segment', () => {
		const width = 60;
		const height = 100;
		const mask = new Uint8Array(width * height);
		paint(mask, width, 30, 10, 35, 90);
		const walls = traceWallsFromMask(mask, null, width, height, DEFAULT);
		const verticals = walls.filter((wall) => wall.ax === wall.bx);
		expect(verticals.length).toBe(1);
		expect(verticals[0]!.ay).toBe(10);
		expect(verticals[0]!.by).toBe(90);
	});

	it('ignores a blob whose runs are all cross-section length', () => {
		const width = 40;
		const height = 40;
		const mask = new Uint8Array(width * height);
		// 6x6 的小块：每段都只有 6 长，比墙短。
		paint(mask, width, 10, 10, 15, 15);
		expect(traceWallsFromMask(mask, null, width, height, DEFAULT)).toEqual([]);
	});

	it('merges the two halves of a wall broken by a door frame', () => {
		const width = 120;
		const height = 30;
		const mask = new Uint8Array(width * height);
		paint(mask, width, 10, 10, 50, 13);
		// 门框留下的缺口，之后墙接着走。
		paint(mask, width, 56, 10, 100, 13);
		const walls = traceWallsFromMask(mask, null, width, height, DEFAULT);
		const horizontals = walls.filter((wall) => wall.ay === wall.by);
		expect(horizontals.length).toBe(1);
		expect(horizontals[0]!.ax).toBe(10);
		expect(horizontals[0]!.bx).toBe(100);
	});

	it('takes each wall’s material from the mask', () => {
		const width = 100;
		const height = 40;
		const mask = new Uint8Array(width * height);
		const material = new Uint8Array(width * height);
		paint(mask, width, 10, 10, 80, 15);
		// 整条带都刷成混凝土（4）。
		paint(material, width, 10, 10, 80, 15, 4);
		const walls = traceWallsFromMask(mask, material, width, height, DEFAULT);
		expect(walls.length).toBe(1);
		expect(walls[0]!.material).toBe(4);
	});

	it('falls back to the default material where none was painted', () => {
		const width = 100;
		const height = 40;
		const mask = new Uint8Array(width * height);
		paint(mask, width, 10, 10, 80, 15);
		const walls = traceWallsFromMask(mask, null, width, height, 3 as WallMaterialId);
		expect(walls[0]!.material).toBe(3);
	});

	it('traces a T junction as two segments', () => {
		const width = 120;
		const height = 120;
		const mask = new Uint8Array(width * height);
		paint(mask, width, 20, 50, 100, 55); // 横杆
		paint(mask, width, 55, 55, 60, 100); // 竖杆
		const walls = traceWallsFromMask(mask, null, width, height, DEFAULT);
		expect(walls.filter((wall) => wall.ay === wall.by).length).toBe(1);
		expect(walls.filter((wall) => wall.ax === wall.bx).length).toBeGreaterThanOrEqual(1);
	});
});
