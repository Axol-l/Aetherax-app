/**
 * Calibration from a measured line.
 *
 * The area route divides the stated area into the boundary the detector found, so it is
 * only as trustworthy as that boundary; measuring a line asks for something the user can
 * read off the plan, and works when the outline is open or the drawing is one room.
 */
import { describe, expect, it } from 'vitest';
import { segmentLengthMetres, segmentLengthWorld, wupmFromSegment } from './calibrate.js';

describe('wupmFromSegment', () => {
	it('turns a measured line into a scale', () => {
		// A 520 px segment that is really 10 m long is 52 px per metre.
		expect(wupmFromSegment({ a: { x: 0, y: 0 }, b: { x: 520, y: 0 } }, 10)).toBeCloseTo(52);
	});

	it('measures diagonals, not just horizontal runs', () => {
		// 3-4-5 triangle: 5 units of world length against 2.5 m is 2 px/m.
		expect(wupmFromSegment({ a: { x: 0, y: 0 }, b: { x: 3, y: 4 } }, 2.5)).toBeCloseTo(2);
	});

	it('refuses inputs that carry no scale', () => {
		const point = { x: 10, y: 10 };
		// Same point twice: the user clicked once per end of nothing.
		expect(wupmFromSegment({ a: point, b: { ...point } }, 5)).toBeNull();
		// A real length of zero would divide by it, and a negative one is a typo.
		expect(wupmFromSegment({ a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }, 0)).toBeNull();
		expect(wupmFromSegment({ a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }, -3)).toBeNull();
		expect(wupmFromSegment({ a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }, Number.NaN)).toBeNull();
	});
});

describe('segmentLengthMetres', () => {
	it('reads a line back as a length at a known scale', () => {
		expect(segmentLengthMetres({ a: { x: 0, y: 0 }, b: { x: 0, y: 260 } }, 52)).toBeCloseTo(5);
	});

	it('has nothing to say without a scale', () => {
		expect(segmentLengthMetres({ a: { x: 0, y: 0 }, b: { x: 0, y: 260 } }, 0)).toBeNull();
	});

	it('agrees with segmentLengthWorld on the raw length', () => {
		const segment = { a: { x: 12, y: 30 }, b: { x: 312, y: 30 } };
		expect(segmentLengthWorld(segment)).toBeCloseTo(300);
	});
});
