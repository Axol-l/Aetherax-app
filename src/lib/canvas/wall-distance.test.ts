import { describe, expect, it } from 'vitest';
import {
	cachedWallDistanceTransform,
	createWallDistanceCache,
	firstWallAlong,
	nearestSideWall,
	wallDistanceTransform
} from './wall-distance.js';

/** 确定性的伪随机掩码，使对照比较可重复。 */
function randomMask(width: number, height: number, walls: number): Uint8Array {
	const data = new Uint8Array(width * height);
	let seed = 12345;
	for (let i = 0; i < walls; i++) {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		data[seed % (width * height)] = 1;
	}
	return data;
}

/** 穷举法答案：计算到每个墙体像素的距离并取最小值。 */
function bruteForce(
	data: Uint8Array,
	width: number,
	height: number,
	px: number,
	py: number
): { distance: number; x: number; y: number } | null {
	let best: { distance: number; x: number; y: number } | null = null;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (data[y * width + x] === 0) continue;
			const distance = Math.hypot(x - px, y - py);
			if (!best || distance < best.distance) best = { distance, x, y };
		}
	}
	return best;
}

describe('wallDistanceTransform', () => {
	it('matches the exhaustive distance to the nearest wall pixel', () => {
		const width = 37;
		const height = 23;
		const data = randomMask(width, height, 60);
		const transform = wallDistanceTransform(data, width, height)!;
		expect(transform).not.toBeNull();

		for (let py = 0; py < height; py++) {
			for (let px = 0; px < width; px++) {
				const expected = bruteForce(data, width, height, px, py)!;
				const actual = transform.query(px, py)!;
				expect(actual.distance).toBeCloseTo(expected.distance, 4);
				// 返回的墙体像素必须确实是墙，且距离与声称的一致。
				expect(data[actual.y * width + actual.x]).not.toBe(0);
				expect(Math.hypot(actual.x - px, actual.y - py)).toBeCloseTo(expected.distance, 4);
			}
		}
	});

	it('measures through a wall to the far side of a corridor', () => {
		// 两堵竖直墙相距 10 px，间隙中点与两者都相距 5 px。
		const width = 21;
		const height = 5;
		const data = new Uint8Array(width * height);
		for (let y = 0; y < height; y++) {
			data[y * width + 5] = 1;
			data[y * width + 15] = 1;
		}
		const transform = wallDistanceTransform(data, width, height)!;
		const middle = transform.query(10, 2)!;
		expect(middle.distance).toBe(5);
		expect([5, 15]).toContain(middle.x);
		expect(transform.query(5, 2)).toEqual({ distance: 0, x: 5, y: 2 });
		// 0 和 20 在墙外，因此最近的墙仍是两堵之一。
		expect(transform.query(0, 2)!.distance).toBe(5);
		expect(transform.query(20, 2)!.distance).toBe(5);
	});

	it('measures on the diagonal exactly, not by a chamfer approximation', () => {
		const width = 10;
		const height = 10;
		const data = new Uint8Array(width * height);
		data[0] = 1;
		const transform = wallDistanceTransform(data, width, height)!;
		expect(transform.query(3, 4)!.distance).toBeCloseTo(5, 6);
	});

	it('declines a mask with no walls, no extent, or outside its frame', () => {
		expect(wallDistanceTransform(new Uint8Array(100), 10, 10)).toBeNull();
		expect(wallDistanceTransform(new Uint8Array(0), 0, 0)).toBeNull();
		const transform = wallDistanceTransform(new Uint8Array([1]), 1, 1)!;
		expect(transform.query(-1, 0)).toBeNull();
		expect(transform.query(0, 1)).toBeNull();
		expect(transform.query(0, 0)).toEqual({ distance: 0, x: 0, y: 0 });
	});

	it('treats any non-zero pixel as a wall', () => {
		// 编辑器的光栅以 1 表示墙，但材质掩码共用几何代码，
		// 杂散的材质 id 不能读作空图纸。
		const transform = wallDistanceTransform(new Uint8Array([0, 0, 3, 0]), 4, 1)!;
		expect(transform.query(0, 0)).toEqual({ distance: 2, x: 2, y: 0 });
	});
});

describe('cachedWallDistanceTransform', () => {
	it('reuses the transform while the mask and version are unchanged', () => {
		const mask = { data: new Uint8Array([1, 0, 0, 0]), width: 4, height: 1, originX: 0, originY: 0 };
		const cache = createWallDistanceCache();
		const first = cachedWallDistanceTransform(cache, mask, 0);
		const second = cachedWallDistanceTransform(cache, mask, 0);
		expect(second).toBe(first);
	});

	it('rebuilds when the same array is patched in place and the version is bumped', () => {
		/*
		 * 墙体编辑器的 `materialize()` 在笔画后返回同一个数组，只改变其中的像素，
		 * 因此仅比较引用会返回基于已被擦除墙体的距离场。
		 */
		const data = new Uint8Array([1, 0, 0, 0, 0, 0]);
		const mask = { data, width: 6, height: 1, originX: 0, originY: 0 };
		const cache = createWallDistanceCache();
		expect(cachedWallDistanceTransform(cache, mask, 0)!.query(5, 0)!.distance).toBe(5);

		data[5] = 1;
		expect(cachedWallDistanceTransform(cache, mask, 1)!.query(5, 0)!.distance).toBe(0);
	});

	it('clears the slot when the floor has no mask', () => {
		const mask = { data: new Uint8Array([1]), width: 1, height: 1, originX: 0, originY: 0 };
		const cache = createWallDistanceCache();
		cachedWallDistanceTransform(cache, mask, 0);
		expect(cachedWallDistanceTransform(cache, null, 1)).toBeNull();
		expect(cache.data).toBeNull();
	});
});

describe('firstWallAlong', () => {
	/** 一个 60×60 的房间：边框为墙，另在 x = 40..41 处有一道隔断。 */
	function roomMask(): Uint8Array {
		const data = new Uint8Array(60 * 60);
		for (let i = 0; i < 60; i++) {
			data[i] = 1;
			data[59 * 60 + i] = 1;
			data[i * 60] = 1;
			data[i * 60 + 59] = 1;
		}
		for (let y = 0; y < 60; y++) {
			data[y * 60 + 40] = 1;
			data[y * 60 + 41] = 1;
		}
		return data;
	}

	it('measures to the first wall along the bearing, not the nearest one', () => {
		const data = roomMask();
		// 从 (20, 30) 朝 +x：隔断在 x = 40，距离二十个单位，
		// 而最近的墙是其后方十个单位的边框。
		const hit = firstWallAlong(data, 60, 60, 0, 0, 20, 30, 0, 60);
		expect(hit).not.toBeNull();
		expect(hit!.distanceW).toBeCloseTo(20, 6);
		expect(hit!.x).toBe(40);
		expect(hit!.y).toBe(30);
	});

	it('follows the bearing, in world units with the mask origin subtracted', () => {
		const data = roomMask();
		// 同一个房间，整体位于掩码原点右上方五个世界单位：
		// 掩码 (20, 30) 对应世界 (25, 35)，边框在掩码 x = 0，即世界 x = 5。
		const hit = firstWallAlong(data, 60, 60, 5, 5, 25, 35, 180, 60);
		expect(hit!.x).toBeCloseTo(5, 6);
		expect(hit!.y).toBeCloseTo(35, 6);
		expect(hit!.distanceW).toBeCloseTo(20, 6);
	});

	it('returns null when the ray leaves the plan before meeting a wall', () => {
		const data = roomMask();
		// 右侧边框有一个缺口，射线起点避开了隔断，那一侧没有可测量的对象。
		for (let i = 0; i < 60; i++) data[30 * 60 + 59] = 0;
		expect(firstWallAlong(data, 60, 60, 0, 0, 50, 30, 0, 60)).toBeNull();
	});

	it('returns null for an empty mask, or one that does not match its size', () => {
		expect(firstWallAlong(new Uint8Array(4), 2, 2, 0, 0, 0, 0, 0, 10)).toBeNull();
		expect(firstWallAlong(new Uint8Array(4), 2, 3, 0, 0, 0, 0, 0, 10)).toBeNull();
	});
});

describe('nearestSideWall', () => {
	/** 一个 60×60 的房间：边框为墙，另在 x = 40..41 处有一道隔断。 */
	function roomMask(): Uint8Array {
		const data = new Uint8Array(60 * 60);
		for (let i = 0; i < 60; i++) {
			data[i] = 1;
			data[59 * 60 + i] = 1;
			data[i * 60] = 1;
			data[i * 60 + 59] = 1;
		}
		for (let y = 0; y < 60; y++) {
			data[y * 60 + 40] = 1;
			data[y * 60 + 41] = 1;
		}
		return data;
	}

	it('measures across the facing direction, not down it', () => {
		const data = roomMask();
		// 在 (20, 30) 朝 +x——即房间的进深方向——两侧的墙是上下边框：
		// 向上 30、向下 29。
		const hit = nearestSideWall(data, 60, 60, 0, 0, 20, 30, 0, 60);
		expect(hit).not.toBeNull();
		expect(hit!.distanceW).toBeCloseTo(29, 6);
		expect(hit!.y).toBe(59);
		// 落点在设备正下方，而不是前方二十个单位处的隔断。
		expect(hit!.x).toBe(20);
	});

	it('never measures the wall the unit is mounted on', () => {
		const data = roomMask();
		// 在 (50, 30) 朝 −x，即安装在隔断上：答案是上下的边框，
		// 而不是身后九个单位的隔断。
		const hit = nearestSideWall(data, 60, 60, 0, 0, 50, 30, 180, 60);
		expect(hit!.distanceW).toBeCloseTo(29, 6);
		expect(hit!.x).toBe(50);
	});

	it('reports a corner as near zero, and tolerates one side running out', () => {
		const data = roomMask();
		// 距上边框两个单位、朝 +x：设备位于角落。
		expect(nearestSideWall(data, 60, 60, 0, 0, 20, 2, 0, 60)!.distanceW).toBeCloseTo(2, 6);

		// 两侧都敞开（该列上下边框各有一个缺口）：没有可测量的对象，因此不绘制。
		for (let i = 0; i < 60; i++) {
			data[0 * 60 + 20] = 0;
			data[59 * 60 + 20] = 0;
		}
		expect(nearestSideWall(data, 60, 60, 0, 0, 20, 30, 0, 60)).toBeNull();
	});
});
