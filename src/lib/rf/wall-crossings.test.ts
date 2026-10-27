/**
 * The ray-versus-segment kernel that the vector wall model charges loss with.
 *
 * The cases worth pinning are the ones a raster march gets wrong: a ray that runs *along* a
 * wall (not a crossing), a ray that ends exactly on one (a grazing hit, which counts), a
 * corner where two walls meet at the same point (both count — there are two surfaces there),
 * and the ordering, because a breakdown is read in the order the signal meets things.
 */
import { describe, expect, it } from 'vitest';
import {
	raySegmentIntersection,
	rayWallCrossings,
	rayWallLossDb,
	rayWallBreakdown,
	type WallSegment
} from './wall-crossings.js';

function wall(ax: number, ay: number, bx: number, by: number, material = 0): WallSegment {
	return { ax, ay, bx, by, material: material as WallSegment['material'] };
}

const BAND = '5ghz' as const;

describe('raySegmentIntersection', () => {
	it('finds a perpendicular crossing and where it is', () => {
		const hit = raySegmentIntersection({ x: 0, y: 0 }, { x: 10, y: 0 }, wall(5, -5, 5, 5));
		expect(hit).not.toBeNull();
		expect(hit!.t).toBeCloseTo(0.5);
		expect(hit!.x).toBeCloseTo(5);
		expect(hit!.y).toBeCloseTo(0);
	});

	it('misses a wall the ray does not reach', () => {
		expect(raySegmentIntersection({ x: 0, y: 0 }, { x: 4, y: 0 }, wall(5, -5, 5, 5))).toBeNull();
	});

	it('misses a wall beside the ray', () => {
		expect(
			raySegmentIntersection({ x: 0, y: 0 }, { x: 10, y: 0 }, wall(5, 1, 5, 5))
		).toBeNull();
	});

	it('does not count a ray running along a wall', () => {
		expect(
			raySegmentIntersection({ x: 0, y: 0 }, { x: 10, y: 0 }, wall(2, 0, 8, 0))
		).toBeNull();
	});

	it('counts a ray that ends exactly on a wall', () => {
		const hit = raySegmentIntersection({ x: 0, y: 0 }, { x: 5, y: 0 }, wall(5, -5, 5, 5));
		expect(hit).not.toBeNull();
		expect(hit!.t).toBeCloseTo(1);
	});
});

describe('rayWallCrossings', () => {
	it('returns crossings nearest first', () => {
		const near = wall(3, -5, 3, 5);
		const far = wall(7, -5, 7, 5);
		const hits = rayWallCrossings({ x: 0, y: 0 }, { x: 10, y: 0 }, [far, near]);
		expect(hits.map((hit) => hit.wall)).toEqual([near, far]);
	});

	it('counts both walls where they meet at a corner', () => {
		// Two surfaces at that point, so two crossings — deterministically, which is the
		// difference from the raster model, where which pixels belong to which wall (and
		// whether a corner is charged twice) depends on how the mask was painted.
		const hits = rayWallCrossings(
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			[wall(5, 0, 5, 5), wall(5, 0, 10, 5)]
		);
		expect(hits.length).toBe(2);
	});

	it('handles a diagonal ray', () => {
		const hits = rayWallCrossings({ x: 0, y: 0 }, { x: 10, y: 10 }, [wall(0, 10, 10, 0)]);
		expect(hits.length).toBe(1);
		expect(hits[0]!.x).toBeCloseTo(5);
		expect(hits[0]!.y).toBeCloseTo(5);
	});
});

describe('loss', () => {
	it('adds one figure per crossing, from the material row', () => {
		// Drywall is 3 dB per crossing; two walls cost six.
		const walls = [wall(3, -5, 3, 5, 0), wall(7, -5, 7, 5, 0)];
		expect(rayWallLossDb({ x: 0, y: 0 }, { x: 10, y: 0 }, walls, BAND)).toBeCloseTo(6);
	});

	it('charges nothing for a virtual partition', () => {
		// Id 6 is the zero-attenuation partition: a line that divides rooms, not a surface.
		const walls = [wall(5, -5, 5, 5, 6)];
		expect(rayWallLossDb({ x: 0, y: 0 }, { x: 10, y: 0 }, walls, BAND)).toBeCloseTo(0);
	});

	it('charges nothing when the ray crosses nothing', () => {
		expect(rayWallLossDb({ x: 0, y: 0 }, { x: 10, y: 0 }, [], BAND)).toBe(0);
	});

	it('reports the breakdown in the order the signal meets the walls', () => {
		const walls = [wall(3, -5, 3, 5, 0), wall(7, -5, 7, 5, 4)];
		const breakdown = rayWallBreakdown({ x: 0, y: 0 }, { x: 10, y: 0 }, walls, BAND);
		expect(breakdown.length).toBe(2);
		expect(breakdown[0]!.at).toBeLessThan(breakdown[1]!.at);
		expect(breakdown[0]!.db).toBeCloseTo(3);
		expect(breakdown[1]!.db).toBeGreaterThan(breakdown[0]!.db);
	});
});
