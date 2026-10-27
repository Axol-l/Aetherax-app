/**
 * The geometry that makes drawing walls feel right: snapping, axis locking, picking.
 *
 * These are the parts a user notices immediately and that a canvas cannot be tested for, so
 * they are pure functions with the awkward cases pinned: a segment that is nearly axis
 * aligned gets locked, one that is genuinely diagonal stays diagonal, and snapping only
 * reaches as far as the caller allows.
 */
import { describe, expect, it } from 'vitest';
import {
	distanceToSegment,
	isDegenerate,
	lockToAxis,
	snapToEndpoint,
	wallLength,
	wallNearPoint,
	type VectorWall
} from './vector-walls.js';

function wall(ax: number, ay: number, bx: number, by: number): VectorWall {
	return { id: `${ax},${ay}-${bx},${by}`, ax, ay, bx, by, material: 0 };
}

describe('snapToEndpoint', () => {
	const walls = [wall(0, 0, 100, 0), wall(100, 0, 100, 80)];

	it('snaps to the nearest endpoint in reach', () => {
		expect(snapToEndpoint({ x: 103, y: 3 }, walls, 10)).toEqual({ x: 100, y: 0 });
		expect(snapToEndpoint({ x: -2, y: 1 }, walls, 10)).toEqual({ x: 0, y: 0 });
	});

	it('leaves a point alone when nothing is near', () => {
		expect(snapToEndpoint({ x: 50, y: 50 }, walls, 10)).toEqual({ x: 50, y: 50 });
	});

	it('respects the tolerance it is given', () => {
		expect(snapToEndpoint({ x: 100, y: 20 }, walls, 5)).toEqual({ x: 100, y: 20 });
		expect(snapToEndpoint({ x: 100, y: 20 }, walls, 25)).toEqual({ x: 100, y: 0 });
	});
});

describe('lockToAxis', () => {
	it('locks a nearly horizontal segment to horizontal', () => {
		const locked = lockToAxis({ x: 0, y: 0 }, { x: 100, y: 4 });
		expect(locked).toEqual({ x: 100, y: 0 });
	});

	it('locks a nearly vertical one to vertical', () => {
		const locked = lockToAxis({ x: 0, y: 0 }, { x: 3, y: 100 });
		expect(locked).toEqual({ x: 0, y: 100 });
	});

	it('leaves a real diagonal alone', () => {
		const target = { x: 100, y: 60 };
		expect(lockToAxis({ x: 0, y: 0 }, target)).toEqual(target);
	});

	it('does not divide by zero on a zero-length segment', () => {
		expect(lockToAxis({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 5, y: 5 });
	});
});

describe('picking a wall', () => {
	const walls = [wall(0, 0, 100, 0)];

	it('measures the distance to the segment, not to its ends', () => {
		expect(distanceToSegment({ x: 50, y: 7 }, walls[0]!)).toBeCloseTo(7);
		// Beyond the end, the nearest point is the end itself.
		expect(distanceToSegment({ x: 110, y: 0 }, walls[0]!)).toBeCloseTo(10);
	});

	it('finds the wall under a click', () => {
		expect(wallNearPoint({ x: 50, y: 3 }, walls, 8)?.id).toBe(walls[0]!.id);
		expect(wallNearPoint({ x: 50, y: 30 }, walls, 8)).toBeNull();
	});

	it('treats a zero-length segment as a point', () => {
		expect(wallLength(wall(4, 4, 4, 4))).toBe(0);
		expect(distanceToSegment({ x: 7, y: 8 }, wall(4, 4, 4, 4))).toBeCloseTo(5);
	});
});

describe('isDegenerate', () => {
	it('drops a double-click segment', () => {
		expect(isDegenerate(wall(10, 10, 10.5, 10))).toBe(true);
		expect(isDegenerate(wall(10, 10, 40, 10))).toBe(false);
	});
});
