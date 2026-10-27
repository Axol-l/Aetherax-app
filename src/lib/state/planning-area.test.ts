/**
 * The planning area: the polygon the user draws to say where the floor is.
 *
 * The point of the feature is that it beats inference on real plans, so these tests are
 * about the two ways inference fails: a room with a wide opening (outside everything) and a
 * cavity between two drawn lines (inside nothing).
 */
import { describe, expect, it } from 'vitest';
import {
	clipInteriorToPlanningArea,
	isUsablePlanningArea,
	pointInPlanningArea,
	type PlanningArea
} from './planning-area.js';

/** A 100 x 100 square from (0,0) to (100,100). */
const square: PlanningArea = [
	{ x: 0, y: 0 },
	{ x: 100, y: 0 },
	{ x: 100, y: 100 },
	{ x: 0, y: 100 }
];

describe('pointInPlanningArea', () => {
	it('knows inside from outside', () => {
		expect(pointInPlanningArea({ x: 50, y: 50 }, square)).toBe(true);
		expect(pointInPlanningArea({ x: -5, y: 50 }, square)).toBe(false);
		expect(pointInPlanningArea({ x: 50, y: 140 }, square)).toBe(false);
	});

	it('handles a concave area, which is what a real floor is', () => {
		// An L: the notch on the bottom-right is *not* part of the floor.
		const l: PlanningArea = [
			{ x: 0, y: 0 },
			{ x: 40, y: 0 },
			{ x: 40, y: 40 },
			{ x: 100, y: 40 },
			{ x: 100, y: 100 },
			{ x: 0, y: 100 }
		];
		expect(pointInPlanningArea({ x: 20, y: 20 }, l)).toBe(true);
		expect(pointInPlanningArea({ x: 70, y: 70 }, l)).toBe(true);
		// The notch: inside the bounding box, outside the polygon.
		expect(pointInPlanningArea({ x: 70, y: 20 }, l)).toBe(false);
	});

	it('treats a polygon of fewer than three points as no area at all', () => {
		expect(isUsablePlanningArea(null)).toBe(false);
		expect(isUsablePlanningArea([{ x: 0, y: 0 }])).toBe(false);
		expect(isUsablePlanningArea([{ x: 0, y: 0 }, { x: 10, y: 10 }])).toBe(false);
		expect(pointInPlanningArea({ x: 0, y: 0 }, [{ x: 0, y: 0 }])).toBe(false);
	});
});

describe('clipInteriorToPlanningArea', () => {
	/** A 20 x 20 interior mask whose pixel (0,0) sits at world (100,100). */
	function fullMask(size = 20): Uint8Array {
		return new Uint8Array(size * size).fill(1);
	}

	it('keeps only the part of the domain inside the area', () => {
		const interior = fullMask();
		// The square covers world x/y 100..110, i.e. mask columns 0..10.
		const area: PlanningArea = [
			{ x: 100, y: 100 },
			{ x: 110, y: 100 },
			{ x: 110, y: 110 },
			{ x: 100, y: 110 }
		];
		const kept = clipInteriorToPlanningArea(interior, 20, 20, 100, 100, area);
		// A ten-by-ten world square is ten-by-ten pixels here, so a tenth of the mask's
		// four hundred survive.
		expect(kept).toBe(100);
		expect(interior[0]).toBe(1);
		expect(interior[15]).toBe(0);
		expect(interior[19 * 20 + 19]).toBe(0);
	});

	it('leaves the mask alone when there is no usable area', () => {
		const interior = fullMask(4);
		const kept = clipInteriorToPlanningArea(interior, 4, 4, 0, 0, []);
		expect(kept).toBe(16);
		expect([...interior]).toEqual(new Array(16).fill(1));
	});

	it('reports an area drawn off the floor as keeping nothing', () => {
		const interior = fullMask(4);
		const kept = clipInteriorToPlanningArea(interior, 4, 4, 0, 0, [
			{ x: 500, y: 500 },
			{ x: 600, y: 500 },
			{ x: 600, y: 600 }
		]);
		expect(kept).toBe(0);
	});
});
