/**
 * "Put it on the wall": the nearest wall to a point, and the direction that faces
 * away from it.
 *
 * The measurement itself is `canvas/wall-distance.ts` and is tested there. What is
 * tested here is the two things a wall-mounted access point is built from — where it
 * goes and which way it looks — because getting either wrong is invisible in a
 * picture: a unit on the wrong side of a wall still paints heat, just on the wrong
 * side of it.
 */
import { describe, expect, it } from 'vitest';
import { wallDistanceTransform } from '$canvas/wall-distance.js';
import {
	facingFollowsWall,
	WALL_MOUNT_OFFSET_M,
	wallSnapFrom
} from './wall-snap.js';

/** A 100×100 mask with one vertical wall, 4 px thick, at x = 20..23. */
function oneWallMask(): Uint8Array {
	const mask = new Uint8Array(100 * 100);
	for (let y = 0; y < 100; y++) {
		for (let x = 20; x < 24; x++) mask[y * 100 + x] = 1;
	}
	return mask;
}

const transform = wallDistanceTransform(oneWallMask(), 100, 100);
const WUPM = 32.8084; // a metre, at the default calibration

describe('wallSnapFrom', () => {
	it('measures to the nearest wall and faces away from it', () => {
		// The wall occupies x = 20..23, so its near face is x = 23 and a point at
		// x = 54 is 31 world units clear of it.
		const snap = wallSnapFrom(transform, 0, 0, 54, 50, WUPM);
		expect(snap).not.toBeNull();
		expect(snap!.x).toBe(23);
		expect(snap!.distanceW).toBe(31);
		// The wall is to the -x side, so the room — and the facing — is +x.
		expect(snap!.facingDeg).toBeCloseTo(0, 6);
	});

	it('puts the unit just off the face, not inside the wall', () => {
		const snap = wallSnapFrom(transform, 0, 0, 54, 50, WUPM)!;
		// A bracket's depth into the room, so the unit does not sit in the wall pixel
		// and pay that wall on every ray it radiates.
		expect(snap.apX - snap.x).toBeCloseTo(WALL_MOUNT_OFFSET_M * WUPM, 6);
		expect(snap.apY).toBeCloseTo(snap.y, 6);
	});

	it('faces the other way when the point is on the other side', () => {
		const snap = wallSnapFrom(transform, 0, 0, 5, 50, WUPM)!;
		expect(snap.x).toBe(20);
		expect(snap.facingDeg).toBeCloseTo(180, 6);
		// Backed off to the -x side, i.e. into the room it is actually in.
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
		// Turned by hand to look along the wall: it keeps that angle when dragged.
		expect(facingFollowsWall(90, snap)).toBe(false);
		expect(facingFollowsWall(180, snap)).toBe(false);
	});
});
