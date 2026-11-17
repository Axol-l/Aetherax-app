import { describe, expect, it } from 'vitest';
import { computeBuildingInterior, fillParallelGaps } from './morphology.js';

/**
 * 掩码边缘不是墙：闭运算半径可能吞掉图纸外边距，使边界上没有可通行像素为洪水填充播种、外边距被判为内部。
 * 以下用例在两个工作分辨率下固定这一几何约定。
 */

/** 一个闭合矩形轮廓：墙体一像素宽，位于掩码边缘内 `margin` 像素处。 */
function roomMask(
	w: number,
	h: number,
	margin: number,
	interiorGap: number
): Uint8Array {
	const mask = new Uint8Array(w * h);
	const x0 = margin;
	const y0 = margin;
	const x1 = w - margin - interiorGap;
	const y1 = h - margin - interiorGap;
	for (let x = x0; x <= x1; x++) {
		mask[y0 * w + x] = 1;
		mask[y1 * w + x] = 1;
	}
	for (let y = y0; y <= y1; y++) {
		mask[y * w + x0] = 1;
		mask[y * w + x1] = 1;
	}
	return mask;
}

describe('computeBuildingInterior', () => {
	/**
	 * 复现的几何：外边距小于闭运算半径（`maxDim: 0` 时半径由工作宽度与 `dilateRatio` 决定）。
	 * 无论外边距多薄，轮廓之外的像素都属于建筑外部。
	 */
	it('does not call the margin outside the walls interior', () => {
		const w = 300;
		const h = 200;
		const margin = 10;
		const mask = roomMask(w, h, margin, 10);
		const { interior, exterior } = computeBuildingInterior(mask, w, h, {
			maxDim: 0,
			dilateRatio: 0.04,
			minDilateR: 4
		});

		// 掩码边缘与墙体之间的条带。
		expect(exterior[2 * w + 2]).toBe(1);
		expect(interior[2 * w + 2]).toBe(0);
		expect(exterior[2 * w + 150]).toBe(1);
		expect(exterior[150 * w + 2]).toBe(1);
		// 而房间本身仍然是内部。
		expect(interior[100 * w + 150]).toBe(1);
		expect(exterior[100 * w + 150]).toBe(0);
	});

	/**
	 * 对每个像素而非采样点检查该不变量：被墙体围合的区域必然位于墙体包围盒内，
	 * 因此内部像素不得落在包围盒之外；两个工作分辨率都要检查。
	 */
	it('never reports interior pixels outside the wall bounding box', () => {
		for (const maxDim of [0, 400]) {
			const w = 512;
			const h = 384;
			const margin = 18;
			const mask = roomMask(w, h, margin, 20);
			const { interior } = computeBuildingInterior(mask, w, h, {
				maxDim,
				dilateRatio: 0.04,
				minDilateR: 4,
				// 优化器与覆盖率估算器所请求的放置域与采样域。
				trimWallAdjacent: true
			});

			let minX = Infinity;
			let minY = Infinity;
			let maxX = -1;
			let maxY = -1;
			for (let y = 0; y < h; y++) {
				for (let x = 0; x < w; x++) {
					if (!mask[y * w + x]) continue;
					if (x < minX) minX = x;
					if (y < minY) minY = y;
					if (x > maxX) maxX = x;
					if (y > maxY) maxY = y;
				}
			}

			let interiorPixels = 0;
			let outside = 0;
			for (let y = 0; y < h; y++) {
				for (let x = 0; x < w; x++) {
					if (!interior[y * w + x]) continue;
					interiorPixels++;
					if (x < minX || x > maxX || y < minY || y > maxY) outside++;
				}
			}
			// 两个分辨率下都能找到房间……
			expect(interiorPixels).toBeGreaterThan(0);
			// ……且找到的像素都不在墙体之外。
			expect(outside).toBe(0);
		}
	});

	/**
	 * 相反的约定：`wall-detect` 的外部块过滤仅在内部像素接触墙体时保留该块，
	 * 因此向外收缩必须是可选项；默认行为下墙体邻接的内部像素必须保留。
	 */
	it('leaves interior touching the walls unless the caller asks for the margin', () => {
		const w = 300;
		const h = 200;
		const margin = 20;
		const mask = roomMask(w, h, margin, 20);
		const options = { maxDim: 0, dilateRatio: 0.04, minDilateR: 4 } as const;

		const touchesWall = (interior: Uint8Array): boolean => {
			for (let y = 0; y < h; y++) {
				for (let x = 0; x < w; x++) {
					if (!interior[y * w + x]) continue;
					if (
						(x > 0 && mask[y * w + x - 1]) ||
						(x < w - 1 && mask[y * w + x + 1]) ||
						(y > 0 && mask[(y - 1) * w + x]) ||
						(y < h - 1 && mask[(y + 1) * w + x])
					) {
						return true;
					}
				}
			}
			return false;
		};

		// 默认情况下，墙体检测器的过滤能为墙块找到内部邻居……
		expect(touchesWall(computeBuildingInterior(mask, w, h, options).interior)).toBe(true);
		// ……而调用方要求放置域时，没有任何内部像素接触墙体。
		expect(
			touchesWall(
				computeBuildingInterior(mask, w, h, { ...options, trimWallAdjacent: true }).interior
			)
		).toBe(false);
	});

	/** 轮廓上的缺口仍会被封闭，这正是闭运算存在的目的。 */
	it('still seals a door-sized gap in the outline', () => {
		const w = 300;
		const h = 200;
		const mask = roomMask(w, h, 20, 20);
		// 顶墙上 6 px 的门口。
		for (let x = 140; x < 146; x++) mask[20 * w + x] = 0;
		const { interior } = computeBuildingInterior(mask, w, h, {
			maxDim: 0,
			dilateRatio: 0.04,
			minDilateR: 4
		});
		expect(interior[100 * w + 150]).toBe(1);
	});
});

describe('fillParallelGaps', () => {
	/**
	 * 两条长平行线之间留缝，即窗户的画法。
	 * 二维闭运算会加粗条带，而填充轮廓内部因两端敞开而无效。
	 */
	function band(gap: number, length = 40) {
		const w = length;
		const h = gap + 6;
		const mask = new Uint8Array(w * h);
		for (let x = 0; x < w; x++) {
			mask[2 * w + x] = 1;
			mask[(2 + gap + 1) * w + x] = 1;
		}
		return { mask, w, h, gap };
	}

	it('bridges the gap and leaves both lines where they were', () => {
		const { mask, w, h, gap } = band(8);
		const filled = fillParallelGaps(mask, w, h, 6);
		expect(filled[(2 + 1 + Math.floor(gap / 2)) * w + 20]).toBe(1);
		expect(filled[2 * w + 20]).toBe(1);
		expect(filled[(2 + gap + 1) * w + 20]).toBe(1);
		// 条带没有外扩：笔画之外的行仍然是背景。
		expect(filled[1 * w + 20]).toBe(0);
		expect(filled[(2 + gap + 2) * w + 20]).toBe(0);
	});

	it('leaves a gap wider than the radius alone', () => {
		const { mask, w, h, gap } = band(30);
		const filled = fillParallelGaps(mask, w, h, 6);
		expect(filled[(2 + 1 + Math.floor(gap / 2)) * w + 20]).toBe(0);
	});

	it('fills a vertical band the same way', () => {
		const w = 20;
		const h = 20;
		const mask = new Uint8Array(w * h);
		for (let y = 2; y < 18; y++) {
			mask[y * w + 5] = 1;
			mask[y * w + 11] = 1;
		}
		const filled = fillParallelGaps(mask, w, h, 6);
		expect(filled[10 * w + 8]).toBe(1);
		expect(filled[10 * w + 4]).toBe(0);
		expect(filled[10 * w + 12]).toBe(0);
	});
});

describe('minRegionRadius', () => {
	/**
	 * 一个房间，旁边有一个同样封闭的墙体空腔。
	 *
	 * 双线立面会画出两条平行线并留出间隙，洪水填充无法进入任一空间：两者都被判为内部，但只有一个是房间。
	 */
	function roomWithCavity(w = 120, h = 100) {
		const mask = new Uint8Array(w * h);
		const line = (x0: number, y0: number, x1: number, y1: number) => {
			for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) mask[y * w + x] = 1;
		};
		// 建筑：一个 4 px 厚的闭合方框。
		line(4, 4, w - 5, 8);
		line(4, h - 9, w - 5, h - 5);
		line(4, 4, 8, h - 5);
		line(w - 9, 4, w - 5, h - 5);
		// 空腔：两条相距 16 px 的平行线，两端封闭，位于方框内。
		line(20, 20, 100, 22);
		line(20, 39, 100, 41);
		line(20, 20, 22, 41);
		line(98, 20, 100, 41);
		return { mask, w, h, cavity: { x: 60, y: 30 }, room: { x: 60, y: 70 } };
	}

	it('drops a cavity and keeps the room around it', () => {
		const { mask, w, h, cavity, room } = roomWithCavity();
		const { interior } = computeBuildingInterior(mask, w, h, {
			maxDim: 0,
			dilateRatio: 0.04,
			minDilateR: 4,
			// 16 px 的缝隙内切半径约 8，房间的约 45。
			minRegionRadius: 20
		});
		expect(interior[cavity.y * w + cavity.x]).toBe(0);
		expect(interior[room.y * w + room.x]).toBe(1);
	});

	it('keeps every enclosed region when no threshold is given', () => {
		// 未设置阈值时，空腔也属于“填充无法到达”的区域，会一并保留。
		const { mask, w, h, cavity } = roomWithCavity();
		const { interior } = computeBuildingInterior(mask, w, h, {
			maxDim: 0,
			dilateRatio: 0.04,
			minDilateR: 4
		});
		expect(interior[cavity.y * w + cavity.x]).toBe(1);
	});

	it('keeps a narrow space when the threshold is below its radius', () => {
		// 阈值是半径，空腔的半径约为 8：阈值取 5 时它会被保留，真正狭窄的房间不会被误删。
		const { mask, w, h, cavity, room } = roomWithCavity();
		const { interior } = computeBuildingInterior(mask, w, h, {
			maxDim: 0,
			dilateRatio: 0.04,
			minDilateR: 4,
			minRegionRadius: 5
		});
		expect(interior[cavity.y * w + cavity.x]).toBe(1);
		expect(interior[room.y * w + room.x]).toBe(1);
	});
});

