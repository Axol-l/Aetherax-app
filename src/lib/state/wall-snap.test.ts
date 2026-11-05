/**
 * 「贴到墙上」：最近墙的测量，以及背离它的朝向。
 *
 * 测量本身在 `canvas/wall-distance.ts` 里测；这里测壁挂 AP 的「装在哪、朝哪边」——弄错
 * 哪个在图上都看不出来，AP 装到墙另一侧照样画热力图，只是画错了边。
 */
import { describe, expect, it } from 'vitest';
import { wallDistanceTransform } from '$canvas/wall-distance.js';
import {
	facingFollowsWall,
	WALL_MOUNT_OFFSET_M,
	wallSnapFrom
} from './wall-snap.js';

/** 100×100 的掩码，x = 20..23 处一道 4 px 厚的竖墙。 */
function oneWallMask(): Uint8Array {
	const mask = new Uint8Array(100 * 100);
	for (let y = 0; y < 100; y++) {
		for (let x = 20; x < 24; x++) mask[y * 100 + x] = 1;
	}
	return mask;
}

const transform = wallDistanceTransform(oneWallMask(), 100, 100);
const WUPM = 32.8084; // 默认校准下一米等于多少世界单位

describe('wallSnapFrom', () => {
	it('measures to the nearest wall and faces away from it', () => {
		// 墙占 x = 20..23，所以近侧表面是 x = 23，x = 54 的点离它 31 个世界单位。
		const snap = wallSnapFrom(transform, 0, 0, 54, 50, WUPM);
		expect(snap).not.toBeNull();
		expect(snap!.x).toBe(23);
		expect(snap!.distanceW).toBe(31);
		// 墙在 -x 一侧，所以房间、也就是朝向，是 +x。
		expect(snap!.facingDeg).toBeCloseTo(0, 6);
	});

	it('puts the unit just off the face, not inside the wall', () => {
		const snap = wallSnapFrom(transform, 0, 0, 54, 50, WUPM)!;
		// 往房间里退一个支架的深度，AP 就不会落在墙体像素里、每条射线都多付一次穿墙。
		expect(snap.apX - snap.x).toBeCloseTo(WALL_MOUNT_OFFSET_M * WUPM, 6);
		expect(snap.apY).toBeCloseTo(snap.y, 6);
	});

	it('faces the other way when the point is on the other side', () => {
		const snap = wallSnapFrom(transform, 0, 0, 5, 50, WUPM)!;
		expect(snap.x).toBe(20);
		expect(snap.facingDeg).toBeCloseTo(180, 6);
		// 退到了 -x 一侧，也就是它真正所在的那个房间。
		expect(snap.apX).toBeLessThan(snap.x);
	});

	it('has nothing to say without a wall, or without a transform', () => {
		expect(wallSnapFrom(null, 0, 0, 54, 50, WUPM)).toBeNull();
		const empty = wallDistanceTransform(new Uint8Array(100 * 100), 100, 100);
		expect(wallSnapFrom(empty, 0, 0, 54, 50, WUPM)).toBeNull();
	});
});

describe('facingFollowsWall', () => {
	it('treats a facing near the wall’s own as derived from it', () => {
		const snap = wallSnapFrom(transform, 0, 0, 54, 50, WUPM)!;
		expect(snap.facingDeg).toBeCloseTo(0, 6);
		expect(facingFollowsWall(10, snap)).toBe(true);
		expect(facingFollowsWall(-10, snap)).toBe(true);
		expect(facingFollowsWall(350, snap)).toBe(true);
		// 手动转成顺着墙看：拖拽时会保留这个角度。
		expect(facingFollowsWall(90, snap)).toBe(false);
		expect(facingFollowsWall(180, snap)).toBe(false);
	});
});
