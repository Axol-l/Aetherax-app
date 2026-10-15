import { describe, expect, it } from 'vitest';
import { ROOM_TYPES } from '../canvas/room-types.js';
import { slabLossFactor } from './cross-floor.js';
import { ADDITIONAL_FLOOR_DB, crossingSlabsFor, type FloorForSlab } from './slab-crossings.js';

/**
 * D-prime's instrument: for a cross-floor path, *which* slab is waived, and by how
 * much?
 *
 * The first attempt at D-prime changed the waiver from `{0, 1}` to `1 - 1/slabCount`
 * and then measured a three-storey A/B that read identical coverage (26.3% against
 * 26.3%). The changes type-checked and the whole e2e suite was green, because the
 * crossing fraction had been computed from "the vertical distance from the AP to that
 * plane" — and the AP's own floor plane is at distance zero from the AP, so the void was
 * being tested at a point on the AP itself, nowhere near where the ray actually goes
 * through the slab.
 *
 * This is the read-out that would have caught it, and it is why the geometry lives in
 * `rf/slab-crossings.ts` rather than inside the optimiser's own loop. Written first, it
 * caught two further mistakes in the same change: the charged boundary range was derived
 * from the crossings *found* (which loses the `t = 0` crossing an upward path makes at
 * the AP), and the void was tested on the plan *below* the slab rather than on the one
 * the hole is painted on.
 *
 * Scene: three 3 m storeys, so floor 1's walking surface is 0 m, floor 2's is 3 m and
 * floor 3's is 6 m. A 5 GHz AP ceiling-mounted on floor 3 sits at 9 m; a client on floor
 * 1 sits at 1.5 m.
 *
 * The charged floors are 1 and 2 inclusive. Floor 1's own floor slab is the 3 m plane
 * (the boundary between floors 1 and 2) and floor 2's is the 6 m plane, so the ray meets
 * them at t = 0.8 and t = 0.4 respectively. The lowest charged floor takes its material
 * in full and the later one the capped increment, which puts the **0.75 share on the
 * crossing nearest the client**.
 *
 * The hole belongs to the floor *above* the slab: the 6 m crossing is the ceiling of
 * floor 2, so floor 3's plan is where a hole over it is painted.
 */

const VOID_ID = ROOM_TYPES.find((t) => t.isVoid)!.id;

/** 20 x 20 px of room types, all `Custom` except an optional void rectangle. */
function roomTypes(voidRect: { x0: number; y0: number; x1: number; y1: number } | null) {
	const data = new Uint8Array(20 * 20).fill(1);
	if (voidRect) {
		for (let y = voidRect.y0; y <= voidRect.y1; y++) {
			for (let x = voidRect.x0; x <= voidRect.x1; x++) data[y * 20 + x] = VOID_ID;
		}
	}
	return { roomTypes: data, width: 20, height: 20, originX: 0, originY: 0 };
}

/**
 * Three floors, with a void rectangle over world x 8..14 on the floors whose **level**
 * is in `voidLevels`.
 *
 * One floor at a time is the point: with the rectangle on every floor every crossing is a
 * hole and the waiver is total, which would let a broken attribution look correct.
 */
function scene(voidLevels: readonly number[], slabDb = 15): FloorForSlab[] {
	return [0, 1, 2].map((level) => ({
		id: `f${level + 1}`,
		elevation: level * 3,
		ceilingHeight: 3,
		// Every floor's own floor slab. Floor 1 has one (the slab between 1 and 2) whenever
		// there is a storey below it to be charged for, which for these scenes there is not
		// — the aggregate only ever charges floors 1 and 2 here.
		slabLossDb: level === 0 ? 0 : slabDb,
		slice: roomTypes(voidLevels.includes(level) ? { x0: 8, y0: 0, x1: 14, y1: 19 } : null)
	}));
}

const INPUT = (voidLevels: readonly number[], slabDb = 15) => ({
	floors: scene(voidLevels, slabDb),
	clientHeight: 1.5,
	band: '5ghz' as const
});

/**
 * The shares labelled by the floor whose **plan** each crossing tests, so a failure says
 * which storey got the loss rather than only that a number was wrong.
 */
function byPlannedFloor(input: ReturnType<typeof INPUT>, ap: string, client: string) {
	const slabs = crossingSlabsFor(input, ap, client) ?? [];
	return slabs.map((s) => {
		const owner = input.floors.find((f) => f.slice.roomTypes === s.roomTypes)!;
		return [`${owner.id}@t${s.t.toFixed(2)}`, Number(s.lossShare.toFixed(4))] as [string, number];
	});
}

describe('crossingSlabsFor', () => {
	it('names both storey boundaries of a two-storey gap, with the right shares', () => {
		const slabs = crossingSlabsFor(INPUT([]), 'f3', 'f1')!;
		expect(slabs.map((s) => Number(s.t.toFixed(3)))).toEqual([0.4, 0.8]);
		// 15 dB for the lowest charged floor plus a 5 dB capped increment = 20 dB
		// aggregate, so the shares are 0.25 on the crossing nearest the AP (whose hole is
		// painted on floor 3's plan) and 0.75 on the one nearest the client (floor 2's).
		expect(byPlannedFloor(INPUT([]), 'f3', 'f1')).toEqual([
			['f3@t0.40', 0.25],
			['f2@t0.80', 0.75]
		]);
		expect(slabs.reduce((sum, s) => sum + s.lossShare, 0)).toBeCloseTo(1, 10);
	});

	it('waives the boundary whose own plan carries the void', () => {
		// A vertical ray down the void corridor, x = 10: both crossings land inside the
		// rectangle, so whichever plan carries the void is the one that loses its share.
		//
		// Floor 3's plan is over the 6 m crossing, i.e. the 0.25 share.
		expect(slabLossFactor(crossingSlabsFor(INPUT([2]), 'f3', 'f1')!, 10, 10, 10, 10)).toBeCloseTo(
			1 - 0.25,
			10
		);
		// Floor 2's plan is over the 3 m crossing, i.e. the 0.75 share.
		expect(slabLossFactor(crossingSlabsFor(INPUT([1]), 'f3', 'f1')!, 10, 10, 10, 10)).toBeCloseTo(
			1 - 0.75,
			10
		);
		// The lowest floor's plan is not over any slab in this path, so a void painted
		// there waives nothing — the material owner and the plan owner are different floors.
		expect(slabLossFactor(crossingSlabsFor(INPUT([0]), 'f3', 'f1')!, 10, 10, 10, 10)).toBeCloseTo(
			1,
			10
		);
	});

	it('does not waive a boundary the ray only crosses obliquely', () => {
		// AP at x = 10, sample at x = 18. The 6 m crossing (t = 0.4) lands at x = 13.2,
		// inside the rectangle; the 3 m crossing (t = 0.8) lands at x = 16.4, outside it.
		// So a void on floor 3 waives and a void on floor 2 does not.
		expect(slabLossFactor(crossingSlabsFor(INPUT([2]), 'f3', 'f1')!, 10, 10, 18, 10)).toBeCloseTo(
			1 - 0.25,
			10
		);
		expect(slabLossFactor(crossingSlabsFor(INPUT([1]), 'f3', 'f1')!, 10, 10, 18, 10)).toBeCloseTo(
			1,
			10
		);
	});

	it('includes the slab an upward path crosses at the AP itself', () => {
		// AP ceiling-mounted on floor 1 (z = 3), client on floor 2 (z = 4.5). The ray
		// crosses the 3 m plane at t = 0 — exactly at the AP, because a ceiling-mounted AP
		// sits on the underside of the slab above it — so that slab is in the path. A list
		// of strictly-interior planes finds nothing here, which would mean no void could
		// ever be waived for an upward path.
		const slabs = crossingSlabsFor(INPUT([1]), 'f1', 'f2')!;
		expect(slabs).toHaveLength(1);
		expect(slabs[0]!.t).toBeCloseTo(0, 10);
		// The charged floor is floor 2, whose own floor slab is the 3 m plane. Floor 1
		// carries 0 in this scene, so the aggregate is the 5 dB cap on floor 2 alone and
		// its share is the whole of it.
		expect(slabs[0]!.lossShare).toBeCloseTo(1, 10);
		// The hole is painted on floor 2's plan — the floor the client is on — and the
		// crossing is at the AP's own position, because a ceiling-mounted AP is mounted
		// under the slab it crosses. So the void is waived exactly when the **AP** is inside
		// it, not when the client is: a ray down the corridor is waived whole, and one from
		// outside the corridor into it keeps the whole 5 dB.
		const inside = INPUT([1]);
		expect(slabLossFactor(crossingSlabsFor(inside, 'f1', 'f2')!, 10, 10, 10, 10)).toBeCloseTo(
			0,
			10
		);
		expect(slabLossFactor(crossingSlabsFor(inside, 'f1', 'f2')!, 18, 10, 10, 10)).toBeCloseTo(
			1,
			10
		);
	});

	it('spans both slabs of a two-storey gap when one endpoint is in the middle', () => {
		// AP on floor 1 up to a client on floor 3: floors 1 and 2 are charged. The 3 m
		// crossing is at t = (3 - 3) / (7.5 - 3) = 0 and the 6 m one at 0.667, so the
		// aggregate is charged in full to the 6 m crossing and the 3 m one gets the cap.
		const slabs = crossingSlabsFor(INPUT([]), 'f1', 'f3')!;
		expect(slabs.map((s) => Number(s.t.toFixed(3)))).toEqual([0, 0.667]);
		expect(slabs.map((s) => Number(s.lossShare.toFixed(3)))).toEqual([0.75, 0.25]);
		// t = 0.667 is the 6 m plane, whose hole is painted on floor 3's plan.
		expect(byPlannedFloor(INPUT([]), 'f1', 'f3')).toEqual([
			['f2@t0.00', 0.75],
			['f3@t0.67', 0.25]
		]);
	});

	it('is the same all-or-nothing waiver as before when the gap is one storey, downward', () => {
		// Floor 2's AP down to floor 1 crosses one plane: the 3 m boundary, which is floor
		// 1's own floor slab. The hole is painted on floor 2's plan — the AP's own floor.
		const slabs = crossingSlabsFor(INPUT([1]), 'f2', 'f1')!;
		expect(slabs).toHaveLength(1);
		expect(slabs[0]!.lossShare).toBeCloseTo(1, 10);
		// The crossing sits at (3 - 6) / (1.5 - 6) = 2/3 along the ray.
		expect(slabs[0]!.t).toBeCloseTo(2 / 3, 10);
		expect(slabLossFactor(slabs, 10, 10, 10, 10)).toBeCloseTo(0, 10);
		// With the void on floor 1 instead — the client's floor, which owns the *material*
		// but not the plan the hole is painted on — nothing is waived.
		expect(slabLossFactor(crossingSlabsFor(INPUT([0]), 'f2', 'f1')!, 10, 10, 10, 10)).toBeCloseTo(
			1,
			10
		);
	});

	it('scales shares so that they always sum to the aggregate', () => {
		// Two 15 dB slabs: 15 + 5 = 20, so the shares are 0.25 and 0.75 and the cap is what
		// makes them sum to the figure the path is charged.
		expect(ADDITIONAL_FLOOR_DB).toBe(5);
		// A thin slab makes the cap irrelevant: both boundaries are 0.5 of 8 dB.
		expect(byPlannedFloor(INPUT([], 4), 'f3', 'f1')).toEqual([
			['f3@t0.40', 0.5],
			['f2@t0.80', 0.5]
		]);
	});

	it('never lets a multiplier exceed 1, even with a nonsense thickness', () => {
		// The shares come from material thicknesses a user can type. A negative one would
		// otherwise make a share negative, and a void at that crossing would *amplify* the
		// slab loss. `slabLossFactor` is clamped at both ends so a waiver can only waive.
		const floors = scene([]);
		floors[2]!.slabLossDb = 20;
		floors[1]!.slabLossDb = -1;
		const slabs = crossingSlabsFor({ floors, clientHeight: 1.5, band: '5ghz' }, 'f3', 'f1')!;
		// A ray that misses the void rectangle entirely: nothing is waived.
		expect(slabLossFactor(slabs, 18, 10, 18, 10)).toBeLessThanOrEqual(1);
		expect(slabLossFactor(slabs, 18, 10, 18, 10)).toBeGreaterThanOrEqual(0);
	});

	it('has nothing to test when the two paths share a floor', () => {
		expect(crossingSlabsFor(INPUT([1]), 'f1', 'f1')).toBeNull();
	});

	it('moves the crossings when the access point is not on the ceiling', () => {
		/*
		 * Where the AP is mounted decides the ray's slope, so a floor-mounted one on
		 * the third storey meets the same two planes at different fractions than a
		 * ceiling-mounted one — and the void at a given world point is then tested
		 * somewhere else along the ray. This is the same instrument the file was
		 * written for, one dimension up.
		 */
		// Ceiling: AP at 9 m, client at 1.5 m, crossings at 0.4 and 0.8 (as above).
		const ceiling = crossingSlabsFor(INPUT([]), 'f3', 'f1')!;
		expect(ceiling.map((s) => Number(s.t.toFixed(3)))).toEqual([0.4, 0.8]);

		// Floor-mounted at 0.8 m, i.e. 6.8 m up on the third storey, down to a client at
		// 1.5 m: the same two planes, met at 0.15 and 0.72 — nearer the client than the
		// ceiling-mounted ray meets them, because the ray starts lower and so is
		// shallower.
		const low = crossingSlabsFor({ ...INPUT([]), apHeightM: 0.8 }, 'f3', 'f1')!;
		expect(low.map((s) => Number(s.t.toFixed(3)))).toEqual([0.151, 0.717]);

		// Wall-mounted at 4.5 m, i.e. 10.5 m up on the third storey: the 6 m plane is met
		// at (6 - 10.5) / (1.5 - 10.5) = 0.5 and the 3 m one at 0.833 — further from the
		// client than the ceiling-mounted ray, because this one starts higher.
		const wall = crossingSlabsFor({ ...INPUT([]), apHeightM: 4.5 }, 'f3', 'f1')!;
		expect(wall.map((s) => Number(s.t.toFixed(3)))).toEqual([0.5, 0.833]);
		// The shares are unchanged: they are built from the slab losses, not the slope.
		expect(wall.map((s) => Number(s.lossShare.toFixed(3)))).toEqual([0.25, 0.75]);
	});

	it('omitting the mount height is the ceiling-mounted path it always was', () => {
		const withoutHeight = crossingSlabsFor(INPUT([]), 'f3', 'f1')!;
		const withCeiling = crossingSlabsFor({ ...INPUT([]), apHeightM: 3 }, 'f3', 'f1')!;
		expect(withCeiling.map((s) => s.t)).toEqual(withoutHeight.map((s) => s.t));
	});
});
