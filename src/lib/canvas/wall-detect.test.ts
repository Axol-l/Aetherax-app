import { describe, expect, it } from 'vitest';
import { isPlausibleTextbox } from './wall-detect.js';

/**
 * The text-masking guard.
 *
 * The numbers are the real ones: a 2997 px Chinese CAD plan read at 800 px wide with the
 * English tesseract model, which hallucinates boxes over regions it cannot read.
 */
describe('isPlausibleTextbox', () => {
	const W = 800;
	const H = 634;
	const box = (x0: number, y0: number, w: number, h: number) => ({
		x0,
		y0,
		x1: x0 + w,
		y1: y0 + h
	});

	it('accepts the boxes the same plan produced for real labels', () => {
		// Measured: 24x41 ("ry"), 86x22 ("S|"), 110x35 ("NN."), 104x34 ("CoD").
		for (const [w, h] of [
			[24, 41],
			[86, 22],
			[110, 35],
			[104, 34]
		]) {
			expect(isPlausibleTextbox(box(10, 10, w!, h!), W, H), `${w}x${h}`).toBe(true);
		}
	});

	it('rejects the hallucinated box that covered 18 % of the drawing', () => {
		// `599x155` read as "EEE" — 75 % of the drawing's width.
		expect(isPlausibleTextbox(box(10, 10, 599, 155), W, H)).toBe(false);
	});

	it('rejects the rest of that run', () => {
		// `450x89` ("Ar") off the width, `161x172` ("BE") off the height.
		expect(isPlausibleTextbox(box(0, 0, 450, 89), W, H)).toBe(false);
		expect(isPlausibleTextbox(box(0, 0, 161, 172), W, H)).toBe(false);
	});

	it('rejects a box that is over half the height but narrow', () => {
		// A tall strip is a column of the drawing, not a word.
		expect(isPlausibleTextbox(box(0, 0, 60, H * 0.6), W, H)).toBe(false);
	});

	it('rejects a degenerate or inverted box', () => {
		expect(isPlausibleTextbox({ x0: 10, y0: 10, x1: 10, y1: 40 }, W, H)).toBe(false);
		expect(isPlausibleTextbox({ x0: 40, y0: 10, x1: 10, y1: 40 }, W, H)).toBe(false);
		expect(isPlausibleTextbox({ x0: 10, y0: 40, x1: 60, y1: 10 }, W, H)).toBe(false);
	});
});
