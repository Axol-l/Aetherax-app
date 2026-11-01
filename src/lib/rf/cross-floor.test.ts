import { describe, expect, it } from 'vitest';
import { ROOM_TYPES } from '$lib/domain/room-types.js';
import {
	crossFloorLoss,
	crossFloorSegments,
	crossFloorSplit,
	floorPlaneCrossings,
	pointAlong,
	slabIsVoid
} from './cross-floor.js';

/**
 * The cross-floor ray split.
 *
 * These pin the geometry behind a model correction: the wall loss along a path between
 * two floors used to be charged entirely against the client's floor, so a ray that
 * spends two thirds of its horizontal run above the client's ceiling was attenuated by
 * the wrong plan for two thirds of its length.
 */

/** Floor planes at 0, 3 and 6 m (three storeys of 3 m). */
const PLANES = [0, 3, 6];

describe('crossFloorSplit', () => {
	it('puts the crossing two thirds along an adjacent-floor ray', () => {
		// AP at 6 m (ceiling of storey 2), client at 1.5 m on storey 1. The slab between
		// them is at 3 m, i.e. (3 - 6) / (1.5 - 6) = 2/3 of the way.
		const { sourceT, targetT } = crossFloorSplit(6, 1.5, PLANES);
		expect(sourceT).toBeCloseTo(2 / 3, 10);
		expect(targetT).toBeCloseTo(2 / 3, 10);
	});

	it('finds both crossings when the ray passes a whole storey', () => {
		// AP on storey 3 down to a client on storey 1: crosses 6 m at 0.4 and 3 m at 0.8.
		const { sourceT, targetT } = crossFloorSplit(9, 1.5, PLANES);
		expect(sourceT).toBeCloseTo(0.4, 10);
		expect(targetT).toBeCloseTo(0.8, 10);
	});

	it('does not split when the ray never leaves the client floor', () => {
		// An AP on the storey below is ceiling-mounted *at* the client's floor plane, so
		// every metre of the run is inside the client's floor volume. The plane is listed
		// as a crossing — the slab above the AP is in the path — but it is at `t = 0`,
		// which splits nothing.
		expect(crossFloorSplit(3, 4.5, PLANES)).toEqual({ sourceT: 0, targetT: 0 });
		// Same floor.
		expect(crossFloorSplit(1.5, 1.5, PLANES)).toEqual({ sourceT: 0, targetT: 0 });
		// A plane exactly at the AP or at the client is not crossed.
		expect(crossFloorSplit(3, 3, PLANES)).toEqual({ sourceT: 0, targetT: 0 });
	});
});

/**
 * The instrument the first D-prime attempt lacked: **which slab is each crossing?**
 *
 * D-prime's per-slab waiver waives a *share* of the aggregate slab loss, and the share
 * has to be attributed to the right storey boundary or the waiver lands on the wrong
 * floor. The first attempt computed the fraction from "the vertical distance from the AP
 * to that plane", which for the AP's own floor plane is zero — so it tested a point at
 * the AP itself and the three-storey A/B read identical coverage.
 *
 * Planes at 0, 3 and 6 m: storey boundaries at 3 m (floors 1|2) and 6 m (floors 2|3).
 */
describe('floorPlaneCrossings', () => {
	it('names one slab for an adjacent-floor ray, and the same one the split uses', () => {
		// AP ceiling-mounted on floor 2 (z = 6), client on floor 1 (z = 1.5).
		const crossings = floorPlaneCrossings(6, 1.5, PLANES);
		expect(crossings).toHaveLength(1);
		// 3 m is the boundary floors 1|2.
		expect(crossings[0]!.planeZ).toBe(3);
		expect(crossings[0]!.planeIndex).toBe(1);
		// (3 - 6) / (1.5 - 6) = 2/3, and the split's two ends are this one crossing.
		expect(crossings[0]!.t).toBeCloseTo(2 / 3, 10);
		const { sourceT, targetT } = crossFloorSplit(6, 1.5, PLANES);
		expect(sourceT).toBeCloseTo(crossings[0]!.t, 10);
		expect(targetT).toBeCloseTo(crossings[0]!.t, 10);
	});

	it('lists both slabs of a two-storey gap, outermost first', () => {
		// AP ceiling-mounted on floor 3 (z = 9), client on floor 1 (z = 1.5).
		const crossings = floorPlaneCrossings(9, 1.5, PLANES);
		expect(crossings.map((c) => c.planeZ)).toEqual([6, 3]);
		// 6 m: (6 - 9) / (1.5 - 9) = 0.4. 3 m: (3 - 9) / (1.5 - 9) = 0.8.
		expect(crossings[0]!.t).toBeCloseTo(0.4, 10);
		expect(crossings[1]!.t).toBeCloseTo(0.8, 10);
		expect(crossings.map((c) => c.planeIndex)).toEqual([2, 1]);
	});

	it('lists nothing for an upward adjacent-floor ray, whose only plane is at the AP', () => {
		// AP on floor 1 (z = 3) up to a client on floor 2 (z = 4.5): the plane between the
		// two storeys is the 3 m one, which is exactly where the AP is. That slab *is* in
		// the path — it is the slab the AP is mounted under — but this is the list of
		// planes a run gets **split** at, and a crossing at the AP splits the run into
		// nothing. The slab-loss waiver does not read this list for that reason: it derives
		// the charged planes from the floor range. See `slab-crossings.test.ts`.
		expect(floorPlaneCrossings(3, 4.5, PLANES)).toEqual([]);
		expect(floorPlaneCrossings(1.5, 1.5, PLANES)).toEqual([]);
	});
});

describe('pointAlong', () => {
	it('interpolates in both axes', () => {
		expect(pointAlong(0, 0, 100, 200, 0.5)).toEqual({ x: 50, y: 100 });
		expect(pointAlong(0, 0, 100, 200, 0)).toEqual({ x: 0, y: 0 });
		expect(pointAlong(0, 0, 100, 200, 1)).toEqual({ x: 100, y: 200 });
	});
});

describe('crossFloorSegments', () => {
	it('splits an adjacent-floor path at two thirds', () => {
		const { sourceT, targetT } = crossFloorSplit(6, 1.5, PLANES);
		const seg = crossFloorSegments(sourceT, targetT, 0, 0, 300, 0)!;
		expect(seg).not.toBeNull();
		expect(seg.source.from).toEqual({ x: 0, y: 0 });
		expect(seg.source.to.x).toBeCloseTo(200, 10);
		expect(seg.target.from.x).toBeCloseTo(200, 10);
		expect(seg.target.to).toEqual({ x: 300, y: 0 });
	});

	it('is null when there is nothing to split', () => {
		expect(crossFloorSegments(0, 0, 0, 0, 300, 0)).toBeNull();
	});
});

describe('crossFloorLoss', () => {
	/** One wall per floor, at a given x, costing a given number of dB. */
	function wallLoss(byFloor: Record<'source' | 'target', { wallX: number; db: number }>) {
		return (
			floor: 'source' | 'target',
			from: { x: number; y: number },
			to: { x: number; y: number }
		): number => {
			const w = byFloor[floor];
			const crossed =
				(from.x < w.wallX && to.x >= w.wallX) || (to.x < w.wallX && from.x >= w.wallX);
			return crossed ? w.db : 0;
		};
	}

	it('charges each half of the run to the floor it passes through', () => {
		// AP at (0,0) on the upper floor, client at (300,0) one storey down. The crossing
		// is at two thirds, i.e. x = 200. The upper floor has a wall at x = 50 (crossed,
		// 5 dB); the lower floor's wall at x = 50 is *behind* the crossing, so the ray
		// never meets it. The old model charged 7 dB — the wrong floor's wall — for a path
		// that meets only the upper one.
		const { sourceT, targetT } = crossFloorSplit(6, 1.5, PLANES);
		const seg = crossFloorSegments(sourceT, targetT, 0, 0, 300, 0)!;
		expect(
			crossFloorLoss(seg, wallLoss({ source: { wallX: 50, db: 5 }, target: { wallX: 50, db: 7 } }))
		).toBe(5);
	});

	it('adds a wall that only the client floor reaches', () => {
		const { sourceT, targetT } = crossFloorSplit(6, 1.5, PLANES);
		const seg = crossFloorSegments(sourceT, targetT, 0, 0, 300, 0)!;
		// Target floor: one wall behind the crossing (x = 50, in the prefix the ray never
		// sees) and one beyond it (x = 250). Only the second counts.
		expect(
			crossFloorLoss(seg, wallLoss({ source: { wallX: 50, db: 5 }, target: { wallX: 250, db: 3 } }))
		).toBe(5 + 3);
	});
});

/**
 * An atrium is a hole in the slab, so a ray crossing there meets no concrete. The slab
 * between two storeys belongs to the upper floor, which is why the caller has to pass
 * *that* floor's room-type mask.
 */
describe('slabIsVoid', () => {
	const W = 10;
	const H = 10;
	/** The void's real id, so this test cannot drift from the room type table. */
	const VOID_ID = ROOM_TYPES.find((t) => t.isVoid)!.id;
	/** Room types: the void's own id, and 1 for a normal room. */
	function roomTypes(voidFrom: number, voidTo: number): Uint8Array {
		const data = new Uint8Array(W * H).fill(1);
		for (let y = 0; y < H; y++) {
			for (let x = voidFrom; x <= voidTo; x++) data[y * W + x] = VOID_ID;
		}
		return data;
	}

	it('is true inside the hole and false beside it', () => {
		const data = roomTypes(2, 4);
		expect(slabIsVoid(data, W, H, 0, 0, 3, 5)).toBe(true);
		expect(slabIsVoid(data, W, H, 0, 0, 6, 5)).toBe(false);
	});

	it('respects the mask origin', () => {
		const data = roomTypes(2, 4);
		// The hole covers world x 102..104 when the mask starts at 100.
		expect(slabIsVoid(data, W, H, 100, 100, 103, 105)).toBe(true);
		expect(slabIsVoid(data, W, H, 100, 100, 3, 5)).toBe(false);
	});

	it('is false outside the mask and with no room data at all', () => {
		const data = roomTypes(2, 4);
		expect(slabIsVoid(data, W, H, 0, 0, -5, 5)).toBe(false);
		expect(slabIsVoid(data, W, H, 0, 0, 50, 5)).toBe(false);
		expect(slabIsVoid(null, W, H, 0, 0, 3, 5)).toBe(false);
	});
});
