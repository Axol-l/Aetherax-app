import { describe, expect, it } from 'vitest';
import { getAttenField, invalidateAttenCache, lookupAtten } from './propagation.js';

/**
 * The attenuation field cache.
 *
 * A field is built from a wall mask and a band's material tables, but the cache
 * key is position and radius. Two APs close enough to quantise to the same cell
 * therefore shared whichever field was built first — across bands, and across the
 * two masks a cross-floor path is split between. The second case is why the split
 * at first looked like it did nothing: the AP's own floor's field came back as a
 * copy of this floor's, so both halves of the path charged the same walls.
 */

const W = 100;
const H = 100;
const AP_X = 10;
const AP_Y = 50;

/** A mask with one vertical wall at `wallX`. */
function wallAt(wallX: number): Uint8Array {
	const data = new Uint8Array(W * H);
	for (let y = 0; y < H; y++) data[y * W + wallX] = 1;
	return data;
}

describe('getAttenField cache tags', () => {
	it('keeps fields built from different masks apart', () => {
		invalidateAttenCache();
		const db = [5];
		const probe = { x: 90, y: 50 };
		const fieldFor = (mask: Uint8Array, tag: string) =>
			getAttenField(AP_X, AP_Y, 40, mask, W, H, null, db, 5, true, 0, 0, tag);

		const walled = fieldFor(wallAt(20), '5ghz:tgt');
		const empty = fieldFor(new Uint8Array(W * H), '5ghz:src');

		// Same position, same radius, same band — only the mask and the tag differ.
		expect(lookupAtten(walled, probe.x, probe.y)).toBe(5);
		expect(lookupAtten(empty, probe.x, probe.y)).toBe(0);
	});

	it('reuses a field for the same tag and position', () => {
		invalidateAttenCache();
		const db = [5];
		const mask = new Uint8Array(W * H);
		const first = getAttenField(AP_X, AP_Y, 40, mask, W, H, null, db, 5, true, 0, 0, 'a');
		const again = getAttenField(AP_X, AP_Y, 40, mask, W, H, null, db, 5, true, 0, 0, 'a');
		expect(again).toBe(first);
	});

	it('keeps bands apart even at the same position', () => {
		invalidateAttenCache();
		const probe = { x: 90, y: 50 };
		const mask = wallAt(20);
		// Drywall at 2.4 GHz against concrete at 5 GHz, at the same quantised cell.
		const low = getAttenField(AP_X, AP_Y, 40, mask, W, H, null, [3], 3, true, 0, 0, '2.4ghz:tgt');
		const high = getAttenField(AP_X, AP_Y, 40, mask, W, H, null, [12], 12, true, 0, 0, '5ghz:tgt');
		expect(lookupAtten(low, probe.x, probe.y)).toBe(3);
		expect(lookupAtten(high, probe.x, probe.y)).toBe(12);
	});

	/**
	 * Two floors, one AP each, at the same place — the usual multi-floor plan.
	 *
	 * The cache key is position and radius, so the masks have to be distinguished
	 * by the tag or the two APs share one field and the second floor is marched
	 * against the first floor's walls. In the tiled overview that is the card that
	 * is *not* selected, because the selected floor warms the cache first — the
	 * reported symptom was "single view on floor 1, then the tiled view shows floor
	 * 2 wrong", and mirrored.
	 */
	it('keeps two floors\u2019 fields apart when their APs share a cell', () => {
		invalidateAttenCache();
		const db = [5];
		const probe = { x: 90, y: 50 };
		const fieldFor = (mask: Uint8Array, tag: string) =>
			getAttenField(AP_X, AP_Y, 40, mask, W, H, null, db, 5, true, 0, 0, tag);

		// Both floors' APs sit in the same quantised cell and share a radius.
		const floor1 = fieldFor(new Uint8Array(W * H), '5ghz:tgt:floor:f1');
		const floor2 = fieldFor(wallAt(20), '5ghz:tgt:floor:f2');

		expect(lookupAtten(floor1, probe.x, probe.y)).toBe(0);
		expect(lookupAtten(floor2, probe.x, probe.y)).toBe(5);

		// And each floor still reuses its own field.
		expect(fieldFor(new Uint8Array(W * H), '5ghz:tgt:floor:f1')).toBe(floor1);
	});
});

/**
 * The lookup interpolates between slices, so a wall shadow is a gradient rather
 * than a one-slice-wide dark spoke.
 *
 * The mask has a single wall pixel column, which from the AP shadows a very
 * narrow range of angles: snapping to the nearest slice turned that into a
 * 2-3 px line of heavy attenuation with hard edges, which the heatmap rendered
 * as an uncoloured dashed line through the coverage.
 */
describe('lookupAtten interpolates across a shadow boundary', () => {
	const AP = { x: 10, y: 50 };
	/** One wall pixel at x = 30, y = 50: only the rays through it are shadowed. */
	function pinWall(): Uint8Array {
		const mask = new Uint8Array(W * H);
		mask[50 * W + 30] = 1;
		return mask;
	}

	it('never steps by the full wall loss between neighbouring samples', () => {
		invalidateAttenCache();
		const db = [20];
		const field = getAttenField(AP.x, AP.y, 120, pinWall(), W, H, null, db, 20, true, 0, 0, 't');

		// Sweep a small arc at a fixed radius, past the shadowed direction.
		const radius = 60;
		let previous: number | null = null;
		let maxStep = 0;
		for (let i = -40; i <= 40; i++) {
			const theta = (i * Math.PI) / 18000; // 0.01° steps
			const v = lookupAtten(field, AP.x + radius * Math.cos(theta), AP.y + radius * Math.sin(theta));
			if (previous !== null) maxStep = Math.max(maxStep, Math.abs(v - previous));
			previous = v;
		}
		// A snapped lookup would jump the whole 20 dB between two adjacent samples.
		expect(maxStep).toBeLessThan(2);
	});

	it('still returns the full shadow close to the shadowed direction', () => {
		invalidateAttenCache();
		const db = [20];
		const field = getAttenField(AP.x, AP.y, 120, pinWall(), W, H, null, db, 20, true, 0, 0, 't');
		// Dead on the wall's direction, well past it.
		expect(lookupAtten(field, 70, 50)).toBeCloseTo(20, 0);
		// And nothing away from it.
		expect(lookupAtten(field, 10, 110)).toBe(0);
	});
});
