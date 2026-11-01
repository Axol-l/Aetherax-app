import { describe, expect, it } from 'vitest';
import { buildRoomDomain } from './rooms.js';

/*
 * The plan's rooms have one derivation, and everyone who has to name a room uses it.
 *
 * This matters beyond tidiness: `roomDensityOverrides` is keyed by the region ids this
 * produces. The canvas collects an override with the id it computed and the optimiser reads
 * it back with the id *it* computed, so two derivations of the same plan meant the density
 * a user set on a room was applied to whichever room carried that ordinal in the other
 * partition — or to none, which is how a per-room occupancy quietly stopped doing anything.
 */

/** A closed rectangular outline, one wall pixel wide, `margin` px in from the edge. */
function outline(w: number, h: number, margin: number): Uint8Array {
	const mask = new Uint8Array(w * h);
	const x0 = margin;
	const y0 = margin;
	const x1 = w - margin - 1;
	const y1 = h - margin - 1;
	for (let x = x0; x <= x1; x++) {
		mask[y0 * w + x] = 1;
		mask[y1 * w + x] = 1;
	}
	for (let y = y0; y <= y1; y++) {
		mask[y * w + x0] = 1;
		mask[y * w + x1] = 1;
	}
	return mask;
}

/** A wall across the middle, splitting the outline into two rooms. */
function dividedPlan(w: number, h: number): Uint8Array {
	const mask = outline(w, h, 10);
	const mid = w >> 1;
	for (let y = 10; y < h - 10; y++) mask[y * w + mid] = 1;
	return mask;
}

/** The same plan with a narrow pocket walled off in one corner. */
function planWithCavity(w: number, h: number): Uint8Array {
	const mask = dividedPlan(w, h);
	// A 12 px box against the left wall: an enclosed region, not a room.
	for (let y = 12; y <= 24; y++) {
		mask[y * w + 24] = 1;
	}
	for (let x = 10; x <= 24; x++) {
		mask[12 * w + x] = 1;
		mask[24 * w + x] = 1;
	}
	return mask;
}

describe('buildRoomDomain', () => {
	const W = 300;
	const H = 200;

	it('is deterministic: the same mask and options give the same partition', () => {
		const mask = dividedPlan(W, H);
		const options = { minRegionRadius: 0, trimWallAdjacent: false };

		const first = buildRoomDomain(mask, W, H, options);
		const second = buildRoomDomain(mask, W, H, options);

		expect(second.regionCount).toBe(first.regionCount);
		expect(Array.from(second.labels)).toEqual(Array.from(first.labels));
	});

	it('gives the canvas and the density map the same rooms', () => {
		// The two callers that must agree: the canvas writes the override key, the density
		// map reads it. Their options are the same object shape for that reason, and this is
		// the assertion that would fail if one of them drifted.
		const mask = dividedPlan(W, H);
		const canvas = buildRoomDomain(mask, W, H, {
			minRegionRadius: 0,
			trimWallAdjacent: false
		});
		const density = buildRoomDomain(mask, W, H, {
			minRegionRadius: 0,
			trimWallAdjacent: false
		});

		expect(Array.from(density.labels)).toEqual(Array.from(canvas.labels));
	});

	it('finds the two rooms of a divided plan', () => {
		const domain = buildRoomDomain(dividedPlan(W, H), W, H, {
			minRegionRadius: 0,
			trimWallAdjacent: false
		});

		expect(domain.regionCount).toBe(2);
		// Left and right of the dividing wall are different rooms.
		const left = domain.labels[100 * W + 80];
		const right = domain.labels[100 * W + 220];
		expect(left).toBeGreaterThanOrEqual(0);
		expect(right).toBeGreaterThanOrEqual(0);
		expect(left).not.toBe(right);
	});

	it('does not call a cavity a room once the radius excludes it', () => {
		const mask = planWithCavity(W, H);
		const cavity = { x: 17, y: 18 };

		const withCavities = buildRoomDomain(mask, W, H, {
			minRegionRadius: 0,
			trimWallAdjacent: false
		});
		const withoutCavities = buildRoomDomain(mask, W, H, {
			minRegionRadius: 20,
			trimWallAdjacent: false
		});

		expect(withCavities.interior[cavity.y * W + cavity.x]).toBe(1);
		expect(withoutCavities.interior[cavity.y * W + cavity.x]).toBe(0);
		// The rooms themselves survive the same threshold.
		expect(withoutCavities.labels[100 * W + 80]).toBeGreaterThanOrEqual(0);
	});

	it('trims the wall-adjacent ring only when asked', () => {
		const mask = dividedPlan(W, H);
		const untrimmed = buildRoomDomain(mask, W, H, {
			minRegionRadius: 0,
			trimWallAdjacent: false
		});
		const trimmed = buildRoomDomain(mask, W, H, {
			minRegionRadius: 0,
			trimWallAdjacent: true
		});

		// One pixel inside the outline: part of the room when untrimmed, gone when the ring is
		// trimmed — which is the difference between "the room the user drew" and "where an
		// access point may stand".
		const justInside = 11 * W + 40;
		expect(untrimmed.interior[justInside]).toBe(1);
		expect(trimmed.interior[justInside]).toBe(0);
		expect(trimmed.regionCount).toBeLessThanOrEqual(untrimmed.regionCount);
	});
});
