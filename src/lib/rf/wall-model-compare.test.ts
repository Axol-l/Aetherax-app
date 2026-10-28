/**
 * Comparing the two wall models, on geometry where the right answer is known.
 *
 * A comparison harness is only worth trusting if it reports what it claims, so these tests
 * feed it cases with an obvious truth: identical geometry (difference zero), a wall one
 * model sees and the other does not (a disagreement, counted separately from a rounding
 * difference), and a systematic bias (means apart, absolute difference small).
 */
import { describe, expect, it } from 'vitest';
import { compareWallModels } from './wall-model-compare.js';
import type { WallSegment } from './wall-crossings.js';

const BAND = '5ghz' as const;
const from = { x: 0, y: 0 };

/** A vertical drywall wall at x = 5, three dB per crossing. */
const wall: WallSegment = { ax: 5, ay: -50, bx: 5, by: 50, material: 0 as WallSegment['material'] };

/** Points on one side of the wall, spread out. */
const points = [
	{ x: 10, y: 0 },
	{ x: 10, y: 10 },
	{ x: -10, y: 0 },
	{ x: 10, y: -10 }
];

describe('compareWallModels', () => {
	it('reports zero difference when both models agree', () => {
		const result = compareWallModels({
			walls: [wall],
			band: BAND,
			from,
			points,
			// The two rays that cross the wall pay 3 dB each, the two that do not pay nothing.
			rasterLoss: (_from, to) => (to.x > 5 ? 3 : 0)
		});
		expect(result.samples).toBe(4);
		expect(result.meanAbsDb).toBeCloseTo(0);
		expect(result.maxAbsDb).toBeCloseTo(0);
		expect(result.disagreements).toBe(0);
		expect(result.rasterMeanDb).toBeCloseTo(result.vectorMeanDb);
	});

	it('counts a wall one model misses as a disagreement, not a rounding error', () => {
		const result = compareWallModels({
			walls: [wall],
			band: BAND,
			from,
			points,
			// A raster march that never sees the wall: exactly the leak the vector model exists
			// to fix, and the case a "looks similar" review would wave through.
			rasterLoss: () => 0
		});
		// Three of the four sample points sit across the wall; the fourth is behind the source.
		expect(result.disagreements).toBe(3);
		expect(result.maxAbsDb).toBeCloseTo(3);
		expect(result.vectorMeanDb).toBeCloseTo((3 + 3 + 3) / 4);
		expect(result.rasterMeanDb).toBe(0);
	});

	it('reports a systematic bias through the means', () => {
		const result = compareWallModels({
			walls: [wall],
			band: BAND,
			from,
			points,
			// Off by 1 dB on every ray that crosses: mean difference 1, means 1 dB apart.
			rasterLoss: (_from, to) => (to.x > 5 ? 4 : 0)
		});
		expect(result.meanAbsDb).toBeCloseTo(0.75);
		expect(result.vectorMeanDb - result.rasterMeanDb).toBeCloseTo(-0.75);
		expect(result.disagreements).toBe(0);
	});

	it('is safe on no samples', () => {
		const result = compareWallModels({
			walls: [wall],
			band: BAND,
			from,
			points: [],
			rasterLoss: () => 0
		});
		expect(result.samples).toBe(0);
		expect(result.meanAbsDb).toBe(0);
		expect(result.maxAt).toBeNull();
	});
});
