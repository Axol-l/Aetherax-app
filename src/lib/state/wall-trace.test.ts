/**
 * Tracing walls out of a painted mask.
 *
 * The property that makes this worth having is the one a hand-drawn set cannot offer: the
 * traced segments cover the same walls the mask does, so switching models does not change
 * the plan's coverage. These tests pin the three behaviours that decides:
 *
 *   a band becomes one segment (not one per row), a cross-section is ignored, and runs that
 *   are one wall interrupted by a gap merge back into one segment.
 */
import { describe, expect, it } from 'vitest';
import { traceWallsFromMask } from './wall-trace.js';
import type { WallMaterialId } from '../canvas/materials.js';

const DEFAULT = 0 as WallMaterialId;

/** Paint a filled rectangle into a mask. */
function paint(
	mask: Uint8Array,
	width: number,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	value = 1
): void {
	for (let y = y0; y <= y1; y++) {
		for (let x = x0; x <= x1; x++) mask[y * width + x] = value;
	}
}

describe('traceWallsFromMask', () => {
	it('turns a horizontal band into one segment along its middle', () => {
		const width = 100;
		const height = 40;
		const mask = new Uint8Array(width * height);
		// A wall 60 long and 6 thick, from y=10 to y=15.
		paint(mask, width, 20, 10, 80, 15);
		const walls = traceWallsFromMask(mask, null, width, height, DEFAULT);
		const horizontals = walls.filter((wall) => wall.ay === wall.by);
		expect(horizontals.length).toBe(1);
		expect(horizontals[0]!.ax).toBe(20);
		expect(horizontals[0]!.bx).toBe(80);
		// Mid-thickness, not one of the edges.
		expect(horizontals[0]!.ay).toBeGreaterThanOrEqual(10);
		expect(horizontals[0]!.ay).toBeLessThanOrEqual(15);
	});

	it('turns a vertical band into one vertical segment', () => {
		const width = 60;
		const height = 100;
		const mask = new Uint8Array(width * height);
		paint(mask, width, 30, 10, 35, 90);
		const walls = traceWallsFromMask(mask, null, width, height, DEFAULT);
		const verticals = walls.filter((wall) => wall.ax === wall.bx);
		expect(verticals.length).toBe(1);
		expect(verticals[0]!.ay).toBe(10);
		expect(verticals[0]!.by).toBe(90);
	});

	it('ignores a blob whose runs are all cross-section length', () => {
		const width = 40;
		const height = 40;
		const mask = new Uint8Array(width * height);
		// 6x6 speck: every run is six long, shorter than a wall.
		paint(mask, width, 10, 10, 15, 15);
		expect(traceWallsFromMask(mask, null, width, height, DEFAULT)).toEqual([]);
	});

	it('merges the two halves of a wall broken by a door frame', () => {
		const width = 120;
		const height = 30;
		const mask = new Uint8Array(width * height);
		paint(mask, width, 10, 10, 50, 13);
		// The gap a door frame leaves; the wall continues after it.
		paint(mask, width, 56, 10, 100, 13);
		const walls = traceWallsFromMask(mask, null, width, height, DEFAULT);
		const horizontals = walls.filter((wall) => wall.ay === wall.by);
		expect(horizontals.length).toBe(1);
		expect(horizontals[0]!.ax).toBe(10);
		expect(horizontals[0]!.bx).toBe(100);
	});

	it('takes each wall’s material from the mask', () => {
		const width = 100;
		const height = 40;
		const mask = new Uint8Array(width * height);
		const material = new Uint8Array(width * height);
		paint(mask, width, 10, 10, 80, 15);
		// Concrete (4) over the whole band.
		paint(material, width, 10, 10, 80, 15, 4);
		const walls = traceWallsFromMask(mask, material, width, height, DEFAULT);
		expect(walls.length).toBe(1);
		expect(walls[0]!.material).toBe(4);
	});

	it('falls back to the default material where none was painted', () => {
		const width = 100;
		const height = 40;
		const mask = new Uint8Array(width * height);
		paint(mask, width, 10, 10, 80, 15);
		const walls = traceWallsFromMask(mask, null, width, height, 3 as WallMaterialId);
		expect(walls[0]!.material).toBe(3);
	});

	it('traces a T junction as two segments', () => {
		const width = 120;
		const height = 120;
		const mask = new Uint8Array(width * height);
		paint(mask, width, 20, 50, 100, 55); // the bar
		paint(mask, width, 55, 55, 60, 100); // the stem
		const walls = traceWallsFromMask(mask, null, width, height, DEFAULT);
		expect(walls.filter((wall) => wall.ay === wall.by).length).toBe(1);
		expect(walls.filter((wall) => wall.ax === wall.bx).length).toBeGreaterThanOrEqual(1);
	});
});
