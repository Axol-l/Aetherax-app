/**
 * Turning segments into the masks the rest of the app reads.
 *
 * The point of this module is that it is the only place the vector model touches the raster
 * one: everything downstream reads masks and nothing downstream needs to know where they came
 * from. So these tests are about the two properties that matter for that to be true — the
 * geometry lands where it was drawn, and the material ids survive the trip.
 */
import { describe, expect, it } from 'vitest';
import { paintedPixels, rasteriseThin, rasteriseWalls } from './wall-raster.js';

describe('rasteriseWalls', () => {
	it('puts a horizontal wall on the row it was drawn on', () => {
		const masks = rasteriseWalls(
			[{ ax: 100, ay: 50, bx: 160, by: 50, material: 0 }],
			1,
			6
		)!;
		expect(masks).not.toBeNull();
		// The origin is the bounding box minus padding, so the row is recoverable.
		const row = 50 - masks.originY;
		const col = 100 - masks.originX;
		expect(masks.wall[row * masks.width + col]).toBe(1);
		// Halfway along, and past the end cap the stroke leaves at the endpoint.
		expect(masks.wall[row * masks.width + col + 30]).toBe(1);
		expect(masks.wall[row * masks.width + col + 63]).toBe(0);
	});

	it('records the material of each wall', () => {
		const masks = rasteriseWalls(
			[
				{ ax: 0, ay: 0, bx: 40, by: 0, material: 4 },
				{ ax: 0, ay: 20, bx: 40, by: 20, material: 3 }
			],
			1,
			2
		)!;
		const rowA = 0 - masks.originY;
		const rowB = 20 - masks.originY;
		expect(masks.material[rowA * masks.width + (0 - masks.originX)]).toBe(4);
		expect(masks.material[rowB * masks.width + (0 - masks.originX)]).toBe(3);
	});

	it('paints a band as wide as it is asked to', () => {
		const wide = rasteriseWalls([{ ax: 0, ay: 0, bx: 40, by: 0, material: 0 }], 9, 6)!;
		const thin = rasteriseThin([{ ax: 0, ay: 0, bx: 40, by: 0, material: 0 }], 4)!;
		expect(paintedPixels(wide)).toBeGreaterThan(paintedPixels(thin) * 2);
	});

	it('has nothing to paint for no walls', () => {
		expect(rasteriseWalls([])).toBeNull();
	});

	it('keeps the mask tight to the drawing', () => {
		const masks = rasteriseWalls([{ ax: 200, ay: 120, bx: 260, by: 120, material: 0 }], 1, 2)!;
		// Bounding box 60 x 0, plus padding on both sides and the band's own width.
		expect(masks.width).toBeLessThan(70);
		expect(masks.height).toBeLessThan(10);
	});

	/**
	 * A column is dragged from its centre to its edge, so the two points span one quadrant.
	 * Scanning that quadrant filled a quarter of the disc while the vector layer drew the
	 * whole ring: the mask and the drawing disagreed, and the heatmap looked like the column
	 * only blocked half of it.
	 */
	it('fills the whole disc of a circular column, not the quadrant it was dragged across', () => {
		const masks = rasteriseWalls(
			[],
			1,
			2,
			undefined,
			[{ shape: 'circle', ax: 100, ay: 100, bx: 120, by: 100, material: 0 }]
		)!;
		expect(paintedPixels(masks)).toBeGreaterThan(Math.PI * 20 * 20 * 0.85);

		const at = (wx: number, wy: number): number => {
			const x = wx - masks.originX;
			const y = wy - masks.originY;
			return masks.wall[y * masks.width + x]!;
		};
		// All four sides of the centre, at half the radius.
		expect(at(110, 100)).toBe(1);
		expect(at(90, 100)).toBe(1);
		expect(at(100, 110)).toBe(1);
		expect(at(100, 90)).toBe(1);
		// And just outside the rim.
		expect(at(121, 100)).toBe(0);
		expect(at(79, 100)).toBe(0);
	});
});
