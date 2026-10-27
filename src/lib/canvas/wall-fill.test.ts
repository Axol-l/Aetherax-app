/**
 * A wall drawn as two strokes must come out of detection as a solid band.
 *
 * Reported from a real plan: the detected mask showed every wall as a hollow frame, one
 * thin line per side, because the threshold keeps the ink of the two strokes and the paper
 * between them stays "floor". The mask looked like a honeycomb of frames, and the interior
 * test then treated the inner stroke as the room's boundary.
 *
 * The fix is a morphological close in the detection pipeline: it bridges a gap up to twice
 * its radius, which is exactly the cavity between a wall's two strokes, and cannot bridge
 * a room. These tests pin the property rather than the numbers — a frame closes, a room
 * survives.
 */
import { describe, expect, it } from 'vitest';
import { dilateMask, erodeMask } from './morphology.js';

/** The close the detector applies, at a given radius. */
function close(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
	return erodeMask(dilateMask(mask, w, h, radius), w, h, radius, 'solid');
}

function frame(w: number, h: number, x0: number, y0: number, x1: number, y1: number, thickness = 1) {
	const mask = new Uint8Array(w * h);
	for (let t = 0; t < thickness; t++) {
		for (let x = x0; x <= x1; x++) {
			mask[(y0 + t) * w + x] = 1;
			mask[(y1 - t) * w + x] = 1;
		}
		for (let y = y0; y <= y1; y++) {
			mask[y * w + x0 + t] = 1;
			mask[y * w + x1 - t] = 1;
		}
	}
	return mask;
}

function count(mask: Uint8Array): number {
	let n = 0;
	for (const v of mask) n += v ? 1 : 0;
	return n;
}

describe('closing the cavity inside a drawn wall', () => {
	it('fills the gap between two strokes of one wall', () => {
		// A wall band four pixels apart: two strokes, nothing between them.
		const w = 60;
		const h = 40;
		const mask = new Uint8Array(w * h);
		for (let x = 10; x < 50; x++) {
			mask[12 * w + x] = 1;
			mask[16 * w + x] = 1;
		}
		const before = count(mask);
		const after = count(close(mask, w, h, 3));
		// The cavity (3 px tall, 40 wide) is filled, so the band is solid.
		expect(after).toBeGreaterThan(before + 100);
		for (let x = 10; x < 50; x++) expect(close(mask, w, h, 3)[14 * w + x]).toBe(1);
	});

	it('leaves a room alone', () => {
		// A 60 x 40 sheet with a 30 x 20 room outlined in the middle.
		const mask = frame(60, 40, 15, 10, 45, 30);
		const closed = close(mask, 60, 40, 3);
		// The room's inside is still empty: a close cannot bridge thirty pixels.
		expect(closed[20 * 60 + 30]).toBe(0);
		// ...and the outline is still there, in the same place.
		expect(closed[10 * 60 + 30]).toBe(1);
	});

	it('does not fatten a wall it does not need to fill', () => {
		// A solid three-pixel band: closing must return it unchanged, or every wall in the
		// mask would grow by the radius and the attenuation would double-count crossings.
		const w = 60;
		const h = 20;
		const mask = new Uint8Array(w * h);
		for (let y = 8; y <= 10; y++) for (let x = 10; x < 50; x++) mask[y * w + x] = 1;
		expect(count(close(mask, w, h, 3))).toBe(count(mask));
	});
});
