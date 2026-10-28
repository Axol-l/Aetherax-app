/**
 * The raised-surface height field: what a platform, a stair and a ramp are worth.
 *
 * The numbers here are the vertical gap a client two metres up a mezzanine actually has, so
 * the tests are about the geometry rather than about arithmetic: a level surface is level,
 * the run climbs the way it was drawn, two overlapping surfaces do not add up to a third,
 * and a source below a deck is shielded by it.
 */
import { describe, expect, it } from 'vitest';
import {
	deckCrossing,
	heightOf,
	isDegenerateSurface,
	runFraction,
	stepCount,
	surfaceContains,
	surfaceCorners,
	surfaceHeightAt,
	surfaceThickness,
	STEP_DEPTH_M,
	type ElevatedSurface
} from './surface-height.js';

function surface(over: Partial<ElevatedSurface> = {}): ElevatedSurface {
	return {
		id: 's1',
		kind: 'platform',
		ax: 0,
		ay: 0,
		bx: 100,
		by: 50,
		heightM: 2,
		topHeightM: 2,
		...over
	};
}

describe('a raised surface', () => {
	it('is its own height everywhere inside a platform', () => {
		const platform = surface();
		expect(heightOf(platform, 10, 10)).toBeCloseTo(2);
		expect(heightOf(platform, 90, 40)).toBeCloseTo(2);
		// Outside the rectangle there is no surface at all, which is the floor's own
		// height — zero above it, so the vertical gap is the plain one.
		expect(heightOf(platform, 101, 10)).toBe(0);
		expect(heightOf(platform, -1, 10)).toBe(0);
	});

	it('climbs along its longer side, from the corner nearest a to the corner nearest b', () => {
		const ramp = surface({ kind: 'ramp', ax: 0, ay: 0, bx: 100, by: 50, heightM: 0, topHeightM: 4 });
		expect(runFraction(ramp, 0, 25)).toBeCloseTo(0);
		expect(runFraction(ramp, 50, 25)).toBeCloseTo(0.5);
		expect(heightOf(ramp, 50, 25)).toBeCloseTo(2);
		expect(runFraction(ramp, 100, 25)).toBeCloseTo(1);
		expect(heightOf(ramp, 100, 25)).toBeCloseTo(4);
	});

	it('climbs the other way when it was drawn the other way', () => {
		const ramp = surface({ kind: 'ramp', ax: 100, ay: 0, bx: 0, by: 50, heightM: 0, topHeightM: 3 });
		expect(heightOf(ramp, 0, 25)).toBeCloseTo(3);
		expect(heightOf(ramp, 100, 25)).toBeCloseTo(0);
	});

	it('takes the vertical run when the rectangle is taller than it is wide', () => {
		const stair = surface({ kind: 'stair', ax: 0, ay: 0, bx: 40, by: 200, heightM: 0, topHeightM: 3.2 });
		expect(heightOf(stair, 20, 0)).toBeCloseTo(0);
		expect(heightOf(stair, 20, 100)).toBeCloseTo(1.6);
		expect(heightOf(stair, 20, 200)).toBeCloseTo(3.2);
		// Across the run it does not change: the treads span the full width.
		expect(heightOf(stair, 0, 100)).toBeCloseTo(1.6);
	});

	it('takes the highest of two overlapping surfaces rather than their sum', () => {
		const low = surface({ id: 'low', heightM: 1, topHeightM: 1 });
		const high = surface({ id: 'high', ax: 20, ay: 10, bx: 60, by: 30, heightM: 2.5, topHeightM: 2.5 });
		expect(surfaceHeightAt([low, high], 40, 20)).toBeCloseTo(2.5);
		expect(surfaceHeightAt([high, low], 40, 20)).toBeCloseTo(2.5);
		// And where only the low one reaches, the low one.
		expect(surfaceHeightAt([low, high], 5, 5)).toBeCloseTo(1);
	});

	it('is zero with no surfaces, and does not divide by zero on a click', () => {
		expect(surfaceHeightAt(null, 5, 5)).toBe(0);
		expect(surfaceHeightAt([], 5, 5)).toBe(0);
		const dot = surface({ ax: 10, ay: 10, bx: 10, by: 10, heightM: 1.5, topHeightM: 1.5 });
		expect(heightOf(dot, 10, 10)).toBeCloseTo(1.5);
		expect(isDegenerateSurface(dot)).toBe(true);
		expect(isDegenerateSurface(surface())).toBe(false);
	});

	it('normalises a rectangle drawn in any direction', () => {
		const reversed = surface({ ax: 100, ay: 50, bx: 0, by: 0 });
		expect(surfaceContains(reversed, 50, 25)).toBe(true);
		expect(surfaceCorners(reversed)[0]).toEqual({ x: 0, y: 0 });
		expect(surfaceCorners(reversed)[2]).toEqual({ x: 100, y: 50 });
	});
});

describe('the deck of a raised surface', () => {
	it('has a thickness and a default loss', () => {
		const platform = surface();
		expect(surfaceThickness(platform)).toBeCloseTo(0.2);
		expect(surfaceThickness({ ...platform, thicknessM: 0.4 })).toBeCloseTo(0.4);
		expect(surfaceThickness({ ...platform, thicknessM: -1 })).toBe(0);
	});

	it('shields a client standing on it from a source below its underside', () => {
		const deck = surface({ heightM: 2, topHeightM: 2, thicknessM: 0.2, attenuationDb: 15 });
		// An AP 0.5 m below the client's feet is under the deck's underside (2 − 0.2 = 1.8).
		const crossing = deckCrossing([deck], 50, 25, -0.5);
		expect(crossing?.lossDb).toBe(15);
		// An AP just under the client's feet, but inside the deck's own thickness: the path
		// never leaves the deck, so nothing is charged.
		expect(deckCrossing([deck], 50, 25, -0.1)).toBeNull();
		// And a source above the deck is not shielded at all.
		expect(deckCrossing([deck], 50, 25, 1)).toBeNull();
		// Off the deck there is nothing to cross.
		expect(deckCrossing([deck], 150, 25, -3)).toBeNull();
		// A deck with no loss is not a crossing worth reporting.
		expect(deckCrossing([surface({ attenuationDb: 0 })], 50, 25, -3)).toBeNull();
	});

	it('uses the highest deck when two overlap, because that is the one walked on', () => {
		const low = surface({ id: 'low', heightM: 1, topHeightM: 1, attenuationDb: 5 });
		const high = surface({ id: 'high', ax: 10, ay: 0, bx: 90, by: 50, heightM: 2, topHeightM: 2, attenuationDb: 20 });
		expect(deckCrossing([low, high], 50, 25, -1.5)?.lossDb).toBe(20);
		expect(deckCrossing([low, high], 5, 25, -1.5)?.lossDb).toBe(5);
	});

	it('counts a stair from its rise and the tread depth', () => {
		const stair = surface({ kind: 'stair', heightM: 0, topHeightM: 3 });
		expect(stepCount(stair)).toBe(10);
		expect(stepCount(stair, 0.5)).toBe(6);
		expect(stepCount(surface({ kind: 'stair', heightM: 2, topHeightM: 2 }))).toBe(1);
		expect(STEP_DEPTH_M).toBeCloseTo(0.3);
	});
});
