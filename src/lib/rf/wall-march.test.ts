import { describe, expect, it } from 'vitest';
import { rayMarchWallAtten } from './propagation.js';

/**
 * What the wall march charges for a crossing: **one figure per crossing, out of the material
 * table** — `dbPerMeter(material, band) × typicalThickness(material)`.
 *
 * This file used to measure the opposite: the length of material the ray walked, scaled by an
 * obliquity factor the caller supplied. A reported project showed why that cannot work, and the
 * numbers are in the march's own doc comment — the material mask is a *painted label* map, so a
 * single 15 px material-brush stroke over a thin glass wall read as 0.59 m of glass and came out
 * as **117 dB** for one partition, against the table's own 2 dB for a glass pane. The coverage
 * panel and the heatmap, which charges the table, then disagreed by **27 points** on a floor
 * (68 % against 95 %), and the optimiser's objective was built on the inflated figure.
 *
 * These cases pin the rule that replaced it, at the scale the multi-floor scenes use
 * (32.7 world units/m).
 */

/** One vertical wall in plan: a band of `thickness` px at x, spanning the whole mask. */
function wallBand(width: number, height: number, x0: number, thickness: number): Uint8Array {
	const mask = new Uint8Array(width * height);
	for (let y = 0; y < height; y++) {
		for (let x = x0; x < x0 + thickness; x++) mask[y * width + x] = 1;
	}
	return mask;
}

const W = 100;
const H = 100;
/** The material table's own figure for one crossing of the test material. */
const CONCRETE_DB = 32;
const GLASS_DB = 105;

function march(
	mask: Uint8Array,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	opts: { stride?: number; materialMap?: Uint8Array | null; materialDb?: number[] } = {}
) {
	return rayMarchWallAtten(
		mask,
		W,
		H,
		opts.materialMap ?? null,
		opts.materialDb ?? [CONCRETE_DB, GLASS_DB],
		CONCRETE_DB,
		x0,
		y0,
		x1,
		y1,
		opts.stride ?? 1
	);
}

describe('what the wall march charges for a crossing', () => {
	it('charges the material table figure, whatever the drawn thickness is', () => {
		// A wall drawn as a line and the same wall drawn as a slab are one wall: the table says
		// what a wall of that material costs, and the drawing does not get a vote.
		const thin = wallBand(W, H, 47, 1);
		const thick = wallBand(W, H, 40, 14);
		expect(march(thin, 10, 50, 90, 50)).toBeCloseTo(CONCRETE_DB, 9);
		expect(march(thick, 10, 50, 90, 50)).toBeCloseTo(CONCRETE_DB, 9);
	});

	it('charges a crossing at 45° the same as one straight through', () => {
		// Path length used to scale this (√2 for a 45° crossing). With one figure per crossing,
		// the angle is geometry, not a cost — which is also what the heatmap has always done.
		const mask = wallBand(W, H, 47, 6);
		const straight = march(mask, 10, 50, 90, 50);
		const diagonal = march(mask, 10, 10, 90, 90);
		expect(diagonal).toBeCloseTo(straight, 9);
		expect(diagonal).toBeCloseTo(CONCRETE_DB, 9);
	});

	it('charges each painted material segment once', () => {
		// A wall painted in two materials is two labels, so it is charged twice — but a ray that
		// stays inside one painted segment is charged once however wide the brush was.
		const mask = wallBand(W, H, 40, 14);
		const materialMap = new Uint8Array(W * H);
		for (let y = 0; y < H; y++) {
			for (let x = 40; x < 47; x++) materialMap[y * W + x] = 1;
			for (let x = 47; x < 54; x++) materialMap[y * W + x] = 0;
		}
		expect(march(mask, 10, 50, 90, 50, { materialMap })).toBeCloseTo(CONCRETE_DB + GLASS_DB, 9);
		// Without the map every wall pixel is the default material: one crossing, one charge.
		expect(march(mask, 10, 50, 90, 50)).toBeCloseTo(CONCRETE_DB, 9);
	});

	it('charges nothing for a zero-attenuation material', () => {
		// A virtual partition divides space without attenuating: it is in the wall mask, so it
		// has to be crossed, and it must not cost anything when it is the labelled material.
		const mask = wallBand(W, H, 47, 6);
		const materialMap = new Uint8Array(W * H);
		for (let y = 0; y < H; y++) for (let x = 47; x < 53; x++) materialMap[y * W + x] = 2;
		expect(march(mask, 10, 50, 90, 50, { materialMap, materialDb: [CONCRETE_DB, GLASS_DB, 0] })).toBe(
			0
		);
	});

	it('does not charge for a ray that never meets a wall, at any stride', () => {
		const mask = wallBand(W, H, 47, 6);
		expect(march(mask, 10, 10, 10, 90)).toBe(0);
		expect(march(mask, 10, 10, 10, 90, { stride: 3 })).toBe(0);
		// …and a coarse stride still finds a wall it steps into: a 6 px band is wider than the
		// 3 px steps, so no sampled pixel can jump it.
		expect(march(mask, 10, 50, 90, 50, { stride: 3 })).toBeCloseTo(CONCRETE_DB, 9);
	});
});
