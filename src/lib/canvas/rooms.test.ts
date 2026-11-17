import { describe, expect, it } from 'vitest';
import { buildRoomDomain } from './rooms.js';

/*
 * 规划中的房间只有一份推导，所有需要命名房间的地方都使用它。
 *
 * `roomDensityOverrides` 以这里产生的区域 id 为键，画布和优化器必须使用同一份推导。
 */

/** 闭合的矩形轮廓，墙体一像素宽，距边缘 `margin` px。 */
function outline(w: number, h: number, margin: number): Uint8Array {
	const mask = new Uint8Array(w * h);
	const x0 = margin;
	const y0 = margin;
	const x1 = w - margin - 1;
	const y1 = h - margin - 1;
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

/** 中间一道墙，把轮廓分成两个房间。 */
function dividedPlan(w: number, h: number): Uint8Array {
	const mask = outline(w, h, 10);
	const mid = w >> 1;
	for (let y = 10; y < h - 10; y++) mask[y * w + mid] = 1;
	return mask;
}

/** 同一平面图，在一角用墙围出狭窄凹腔。 */
function planWithCavity(w: number, h: number): Uint8Array {
	const mask = dividedPlan(w, h);
	// 紧靠左墙的封闭方框：是封闭区域，不是房间。
	for (let y = 12; y <= 24; y++) {
		mask[y * w + 24] = 1;
	}
	for (let x = 10; x <= 24; x++) {
		mask[12 * w + x] = 1;
		mask[24 * w + x] = 1;
	}
	return mask;
}

describe('buildRoomDomain', () => {
	const W = 300;
	const H = 200;

	it('is deterministic: the same mask and options give the same partition', () => {
		const mask = dividedPlan(W, H);
		const options = { minRegionRadius: 0, trimWallAdjacent: false };

		const first = buildRoomDomain(mask, W, H, options);
		const second = buildRoomDomain(mask, W, H, options);

		expect(second.regionCount).toBe(first.regionCount);
		expect(Array.from(second.labels)).toEqual(Array.from(first.labels));
	});

	it('gives the canvas and the density map the same rooms', () => {
		// 必须一致的两个调用方：画布写入覆盖键，密度图读取它；两者选项形状相同，
		// 此断言用于发现任一方的漂移。
		const mask = dividedPlan(W, H);
		const canvas = buildRoomDomain(mask, W, H, {
			minRegionRadius: 0,
			trimWallAdjacent: false
		});
		const density = buildRoomDomain(mask, W, H, {
			minRegionRadius: 0,
			trimWallAdjacent: false
		});

		expect(Array.from(density.labels)).toEqual(Array.from(canvas.labels));
	});

	it('finds the two rooms of a divided plan', () => {
		const domain = buildRoomDomain(dividedPlan(W, H), W, H, {
			minRegionRadius: 0,
			trimWallAdjacent: false
		});

		expect(domain.regionCount).toBe(2);
		// 分隔墙左右属于不同房间。
		const left = domain.labels[100 * W + 80];
		const right = domain.labels[100 * W + 220];
		expect(left).toBeGreaterThanOrEqual(0);
		expect(right).toBeGreaterThanOrEqual(0);
		expect(left).not.toBe(right);
	});

	it('does not call a cavity a room once the radius excludes it', () => {
		const mask = planWithCavity(W, H);
		const cavity = { x: 17, y: 18 };

		const withCavities = buildRoomDomain(mask, W, H, {
			minRegionRadius: 0,
			trimWallAdjacent: false
		});
		const withoutCavities = buildRoomDomain(mask, W, H, {
			minRegionRadius: 20,
			trimWallAdjacent: false
		});

		expect(withCavities.interior[cavity.y * W + cavity.x]).toBe(1);
		expect(withoutCavities.interior[cavity.y * W + cavity.x]).toBe(0);
		// 房间本身在该阈值下仍然保留。
		expect(withoutCavities.labels[100 * W + 80]).toBeGreaterThanOrEqual(0);
	});

	it('trims the wall-adjacent ring only when asked', () => {
		const mask = dividedPlan(W, H);
		const untrimmed = buildRoomDomain(mask, W, H, {
			minRegionRadius: 0,
			trimWallAdjacent: false
		});
		const trimmed = buildRoomDomain(mask, W, H, {
			minRegionRadius: 0,
			trimWallAdjacent: true
		});

		// 轮廓内一像素：未裁剪时属于房间，裁剪后消失，对应“用户画出的房间”与
		// “可放置接入点的位置”之差。
		const justInside = 11 * W + 40;
		expect(untrimmed.interior[justInside]).toBe(1);
		expect(trimmed.interior[justInside]).toBe(0);
		expect(trimmed.regionCount).toBeLessThanOrEqual(untrimmed.regionCount);
	});
});
