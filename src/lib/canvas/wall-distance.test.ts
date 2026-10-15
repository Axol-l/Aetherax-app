import { describe, expect, it } from 'vitest';
import {
	cachedWallDistanceTransform,
	createWallDistanceCache,
	firstWallAlong,
	nearestSideWall,
	wallDistanceTransform
} from './wall-distance.js';

/** A deterministic pseudo-random mask, so the reference comparison is repeatable. */
function randomMask(width: number, height: number, walls: number): Uint8Array {
	const data = new Uint8Array(width * height);
	let seed = 12345;
	for (let i = 0; i < walls; i++) {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		data[seed % (width * height)] = 1;
	}
	return data;
}

/** The answer by exhaustion: the distance to every wall pixel, minimised. */
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
				// The named wall pixel has to be a wall, and at the distance claimed.
				expect(data[actual.y * width + actual.x]).not.toBe(0);
				expect(Math.hypot(actual.x - px, actual.y - py)).toBeCloseTo(expected.distance, 4);
			}
		}
	});

	it('measures through a wall to the far side of a corridor', () => {
		// Two vertical walls 10 px apart; the middle of the gap is 5 px from both.
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
		// 0 and 20 are outside the walls, so the nearest wall is still one of the two.
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
		// The editor's raster is 1 = wall, but the material mask shares the geometry
		// code and a stray material id must not read as an empty plan.
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
		 * The wall editor's `materialize()` returns the same array after a stroke,
		 * with the pixels changed inside it, so identity alone would hand back a
		 * field measured from walls the user has since erased.
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
	/** A 60×60 room: walls on the border, plus a partition at x = 40..41. */
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
		// From (20, 30) facing +x: the partition at x = 40, twenty units away — while
		// the *nearest* wall is the border ten units behind it.
		const hit = firstWallAlong(data, 60, 60, 0, 0, 20, 30, 0, 60);
		expect(hit).not.toBeNull();
		expect(hit!.distanceW).toBeCloseTo(20, 6);
		expect(hit!.x).toBe(40);
		expect(hit!.y).toBe(30);
	});

	it('follows the bearing, in world units with the mask origin subtracted', () => {
		const data = roomMask();
		// The same room, five world units up and to the right of the mask's origin:
		// mask (20, 30) is world (25, 35), and the border wall is at mask x = 0, i.e.
		// world x = 5.
		const hit = firstWallAlong(data, 60, 60, 5, 5, 25, 35, 180, 60);
		expect(hit!.x).toBeCloseTo(5, 6);
		expect(hit!.y).toBeCloseTo(35, 6);
		expect(hit!.distanceW).toBeCloseTo(20, 6);
	});

	it('returns null when the ray leaves the plan before meeting a wall', () => {
		const data = roomMask();
		// A gap in the right-hand border, with the ray starting clear of the
		// partition: nothing to measure to out there.
		for (let i = 0; i < 60; i++) data[30 * 60 + 59] = 0;
		expect(firstWallAlong(data, 60, 60, 0, 0, 50, 30, 0, 60)).toBeNull();
	});

	it('returns null for an empty mask, or one that does not match its size', () => {
		expect(firstWallAlong(new Uint8Array(4), 2, 2, 0, 0, 0, 0, 0, 10)).toBeNull();
		expect(firstWallAlong(new Uint8Array(4), 2, 3, 0, 0, 0, 0, 0, 10)).toBeNull();
	});
});

describe('nearestSideWall', () => {
	/** A 60×60 room: walls on the border, plus a partition at x = 40..41. */
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
		// At (20, 30) facing +x — the room's depth — so the walls beside it are the
		// top and bottom borders: 30 up and 29 down.
		const hit = nearestSideWall(data, 60, 60, 0, 0, 20, 30, 0, 60);
		expect(hit).not.toBeNull();
		expect(hit!.distanceW).toBeCloseTo(29, 6);
		expect(hit!.y).toBe(59);
		// Directly below the unit, not on the partition twenty units ahead of it.
		expect(hit!.x).toBe(20);
	});

	it('never measures the wall the unit is mounted on', () => {
		const data = roomMask();
		// At (50, 30) facing −x, i.e. mounted on the partition: the answer is the
		// border above and below, not the 9 units of partition behind it.
		const hit = nearestSideWall(data, 60, 60, 0, 0, 50, 30, 180, 60);
		expect(hit!.distanceW).toBeCloseTo(29, 6);
		expect(hit!.x).toBe(50);
	});

	it('reports a corner as near zero, and tolerates one side running out', () => {
		const data = roomMask();
		// Two units from the top border, facing +x: the unit is in a corner.
		expect(nearestSideWall(data, 60, 60, 0, 0, 20, 2, 0, 60)!.distanceW).toBeCloseTo(2, 6);

		// Both sides open (a gap in the top and bottom border at this column): nothing
		// to measure to, so nothing is drawn.
		for (let i = 0; i < 60; i++) {
			data[0 * 60 + 20] = 0;
			data[59 * 60 + 20] = 0;
		}
		expect(nearestSideWall(data, 60, 60, 0, 0, 20, 30, 0, 60)).toBeNull();
	});
});
