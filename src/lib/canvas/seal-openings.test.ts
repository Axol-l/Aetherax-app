/**
 * Sealing openings: the difference between "a room with a doorway" and "the way out".
 *
 * The guard that asks whether an access point is inside the building reads the interior the
 * flood fill infers from the walls. A doorway is a gap in those walls, so a room with one
 * read as connected to the outside and the room's own AP was reported as outside — the
 * complaint this change answers. Closing the wall mask by half the widest opening that
 * still counts as a room bridges the doorway and leaves a genuinely open side open.
 */
import { describe, expect, it } from 'vitest';
import { sealOpenings } from './morphology.js';

const W = 120;
const H = 120;

/** A room filling most of the sheet, with a gap of `gap` pixels in its right wall. */
function roomWithGap(gap: number): Uint8Array {
	const mask = new Uint8Array(W * H);
	for (let x = 20; x <= 100; x++) {
		mask[20 * W + x] = 1;
		mask[100 * W + x] = 1;
	}
	for (let y = 20; y <= 100; y++) {
		mask[y * W + 20] = 1;
		// The right wall, with a doorway in the middle.
		const inGap = y >= 60 - gap / 2 && y <= 60 + gap / 2;
		if (!inGap) mask[y * W + 100] = 1;
	}
	return mask;
}

/** True when the mask blocks a straight line from the room's middle to the sheet's edge. */
function sealed(mask: Uint8Array): boolean {
	// Flood the open space from the outside corner; if the middle is reached, the gap is open.
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
		const door = roomWithGap(6); // ~1.5 m at the radius below
		expect(sealed(door)).toBe(false);
		expect(sealed(sealOpenings(door, W, H, 4))).toBe(true);

		// A whole missing wall (a 40 px opening) is not a doorway, at the same radius.
		const open = roomWithGap(40);
		expect(sealed(sealOpenings(open, W, H, 4))).toBe(false);
	});

	it('does not fatten the walls it keeps', () => {
		const door = roomWithGap(6);
		const sealedMask = sealOpenings(door, W, H, 4);
		// The room's own inner corner is still open, and the wall still starts at x = 20.
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
});
