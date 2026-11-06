/**
 * 封堵洞口：区分“带门洞的房间”与真正的出口。
 * 内部区域由墙体推断，门洞是墙上的缺口，会让房间被判为连通外部；
 * 按仍算洞口的最宽宽度的一半做闭运算可连接门洞，同时保留真正的开口。
 */
import { describe, expect, it } from 'vitest';
import { sealOpenings } from './morphology.js';

const W = 120;
const H = 120;

/** 占满图纸大部分区域的房间，右墙上有 `gap` 像素宽的缺口。 */
function roomWithGap(gap: number): Uint8Array {
	const mask = new Uint8Array(W * H);
	for (let x = 20; x <= 100; x++) {
		mask[20 * W + x] = 1;
		mask[100 * W + x] = 1;
	}
	for (let y = 20; y <= 100; y++) {
		mask[y * W + 20] = 1;
		// 右墙，中间留出门洞。
		const inGap = y >= 60 - gap / 2 && y <= 60 + gap / 2;
		if (!inGap) mask[y * W + 100] = 1;
	}
	return mask;
}

/** 掩码挡住从房间中心到图纸边缘的直线时返回 true。 */
function sealed(mask: Uint8Array): boolean {
	// 从外侧角点对空白区域做泛洪；若能到达中心，说明缺口是通的。
	const seen = new Uint8Array(W * H);
	const stack = [0];
	seen[0] = 1;
	while (stack.length > 0) {
		const index = stack.pop()!;
		const x = index % W;
		const y = Math.floor(index / W);
		for (const [nx, ny] of [
			[x + 1, y],
			[x - 1, y],
			[x, y + 1],
			[x, y - 1]
		] as const) {
			if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
			const next = ny * W + nx;
			if (seen[next] || mask[next]) continue;
			seen[next] = 1;
			stack.push(next);
		}
	}
	return seen[60 * W + 60] === 0;
}

describe('sealOpenings', () => {
	it('closes a doorway and leaves a genuine opening open', () => {
		const door = roomWithGap(6); // 按下面的半径约合 1.5 m
		expect(sealed(door)).toBe(false);
		expect(sealed(sealOpenings(door, W, H, 4))).toBe(true);

		// 整段缺失的墙（40 px 开口）在同半径下不算门洞。
		const open = roomWithGap(40);
		expect(sealed(sealOpenings(open, W, H, 4))).toBe(false);
	});

	it('does not fatten the walls it keeps', () => {
		const door = roomWithGap(6);
		const sealedMask = sealOpenings(door, W, H, 4);
		// 房间内角仍为空，墙体仍从 x = 20 开始。
		expect(sealedMask[21 * W + 21]).toBe(0);
		expect(sealedMask[20 * W + 19]).toBe(0);
		expect(sealedMask[21 * W + 20]).toBe(1);
	});

	it('is a no-op at radius zero, and does not mutate its input', () => {
		const door = roomWithGap(6);
		const copy = new Uint8Array(door);
		expect(sealOpenings(door, W, H, 0)).toEqual(door);
		sealOpenings(door, W, H, 4);
		expect(door).toEqual(copy);
	});

	/**
	 * 真实平面图的尺寸与半径：确认闭运算没有退回到按像素逐一涂正方形的二次实现。
	 * 阈值宽松，只用于捕捉性能回退，不考核具体毫秒数。
	 */
	it('closes a plan-sized mask in the time a gesture can afford', () => {
		const w = 820;
		const h = 839;
		const mask = new Uint8Array(w * h);
		for (let y = 40; y < h - 40; y += 60) {
			for (let x = 40; x < w - 40; x++) mask[y * w + x] = 1;
		}
		const started = performance.now();
		sealOpenings(mask, w, h, 22);
		const elapsed = performance.now() - started;
		expect(elapsed).toBeLessThan(200);
	});
});
