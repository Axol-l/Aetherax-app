/**
 * 矢量墙体模型用于计损的射线—线段求交内核。
 * 重点覆盖栅格步进容易出错的情形：沿墙而行的射线不计穿越、恰好终止于墙上的射线计一次、
 * 墙角处两道墙各计一次，以及按信号遇到墙体的先后排序。
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
		// 该点处有两个表面，因此计两次穿越，且结果是确定的；栅格模型的结果则取决于掩码的绘制方式。
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
		// 该频段下石膏板每次穿越 5.6 dB，数值由 P.2040 平板模型（5.5 GHz、12 mm 板厚）算出，而非查表。
		const walls = [wall(3, -5, 3, 5, 0), wall(7, -5, 7, 5, 0)];
		expect(rayWallLossDb({ x: 0, y: 0 }, { x: 10, y: 0 }, walls, BAND)).toBeCloseTo(11.2, 1);
	});

	it('charges nothing for a virtual partition', () => {
		// 材质 id 6 是零衰减隔断：只划分房间，不是实体表面。
		const walls = [wall(5, -5, 5, 5, 6)];
		expect(rayWallLossDb({ x: 0, y: 0 }, { x: 10, y: 0 }, walls, BAND)).toBeCloseTo(0);
	});

	it('charges nothing when the ray crosses nothing', () => {
		expect(rayWallLossDb({ x: 0, y: 0 }, { x: 10, y: 0 }, [], BAND)).toBe(0);
	});

	it('can exclude the reflecting surface from a reflected leg', () => {
		const walls = [wall(3, -5, 3, 5, 0), wall(7, -5, 7, 5, 0)];
		expect(rayWallLossDb({ x: 0, y: 0 }, { x: 10, y: 0 }, walls, BAND, [0])).toBeCloseTo(5.6, 1);
	});

	it('reports the breakdown in the order the signal meets the walls', () => {
		const walls = [wall(3, -5, 3, 5, 0), wall(7, -5, 7, 5, 4)];
		const breakdown = rayWallBreakdown({ x: 0, y: 0 }, { x: 10, y: 0 }, walls, BAND);
		expect(breakdown.length).toBe(2);
		expect(breakdown[0]!.at).toBeLessThan(breakdown[1]!.at);
		expect(breakdown[0]!.db).toBeCloseTo(5.6, 1);
		expect(breakdown[1]!.db).toBeGreaterThan(breakdown[0]!.db);
	});
});
