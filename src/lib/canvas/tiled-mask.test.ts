import { describe, expect, it } from 'vitest';
import { TiledMask } from './tiled-mask.js';

/**
 * Regression tests for the wall mask's raster bounds.
 *
 * These cover a bug that was reported as "erasing a wall makes the whole layer
 * disappear". It was not the erase: `materialize()` threw
 * `RangeError: offset is out of bounds` out of `blitTile`, so the edit never
 * committed and the layer rendered stale or empty. Two things had to be true at
 * once, which is why it only showed up on a floor that had been moved by an
 * alignment offset.
 */

const TILE = 256;

/** A 4x4 mask with one wall at its local (0, 0), placed at a world offset. */
function maskAt(originX: number, originY: number): TiledMask {
	const w = 4;
	const h = 4;
	const walls = new Uint8Array(w * h);
	walls[0] = 1;
	const materials = new Uint8Array(w * h);
	materials[0] = 3;
	return TiledMask.fromFlat(walls, w, h, materials, 0, originX, originY);
}

describe('TiledMask bounds', () => {
	it('starts at the first occupied tile, not the world origin', () => {
		const mask = maskAt(2000, 1200);
		const b = mask.bounds;
		expect(b).not.toBeNull();
		// The tile lattice is 256 px, so the box starts at the tile containing the
		// content. It used to start at 0, which for an offset floor meant a raster
		// thousands of pixels wide and almost entirely empty.
		expect(b!.originX).toBe(Math.floor(2000 / TILE) * TILE);
		expect(b!.originY).toBe(Math.floor(1200 / TILE) * TILE);
		expect(b!.width).toBeLessThanOrEqual(TILE * 2);
		expect(b!.height).toBeLessThanOrEqual(TILE * 2);
	});

	it('does not grow when clearing a pixel that was never set', () => {
		const mask = maskAt(2000, 1200);
		const before = mask.bounds!;
		// A brush far outside the drawn area, erasing. This allocated a tile for
		// every cleared pixel, so the raster grew with every stray stroke.
		mask.paintCircle(before.originX - 5000, before.originY - 5000, 5, 0);
		expect(mask.bounds).toEqual(before);
	});

	it('materialises a material tile that sits outside the wall tiles', () => {
		const mask = maskAt(2000, 1200);
		// A material where there is no wall. `setMaterial` allocates its own tiles
		// and never consults the wall grid, so the raster has to be sized to cover
		// both — sizing it from the wall tiles alone is what threw.
		const matX = 2000 + 4000;
		const matY = 1200 + 4000;
		mask.setMaterial(matX, matY, 4);

		let result: ReturnType<TiledMask['materialize']> = null;
		expect(() => {
			result = mask.materialize();
		}).not.toThrow();

		expect(result).not.toBeNull();
		const r = result!;
		const idx = (matY - r.originY) * r.width + (matX - r.originX);
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(idx).toBeLessThan(r.width * r.height);
		expect(r.materialData?.[idx]).toBe(4);
	});

	it('keeps the wall pixel at the same world position after a round trip', () => {
		const mask = maskAt(2000, 1200);
		const r = mask.materialize()!;
		const idx = (1200 - r.originY) * r.width + (2000 - r.originX);
		expect(r.data[idx]).toBe(1);
		expect(mask.getPixel(2000, 1200)).toBe(1);
		// And a pixel that was never a wall stays clear.
		expect(mask.getPixel(2001, 1200)).toBe(0);
	});
});

/**
 * A floor that has been aligned carries a fractional offset, and that offset is
 * used as the mask's pixel origin. Writing to a typed array with a fractional
 * index is silently discarded — the key becomes an expando property, not an
 * element — so every pixel of such a floor's detected walls was dropped and the
 * first edit then saved the resulting blank raster over them. Reported as "the
 * walls on floor 2 disappear as soon as I erase anything, and I cannot draw".
 */
describe('TiledMask with a fractional origin', () => {
	it('lands the pixels on the pixel grid instead of dropping them', () => {
		const mask = maskAt(0, 14.279614761037685);
		// Rounded, not truncated, and the pixel is really there.
		expect(mask.getPixel(0, 14)).toBe(1);
		expect(mask.getPixel(0, 15)).toBe(0);
	});

	it('materialises exactly one pixel, not an all-zero raster', () => {
		const mask = maskAt(0, 14.279614761037685);
		const r = mask.materialize()!;
		let set = 0;
		for (const v of r.data) if (v) set++;
		expect(set).toBe(1);
		expect(r.data[(14 - r.originY) * r.width + (0 - r.originX)]).toBe(1);
	});

	it('reports a whole-pixel box, so the raster and the numbers agree', () => {
		// A 526-tall mask on a floor aligned to y = 14.2796 — the shape the bug was
		// reported with. The box end was `origin + height` as a fractional number, so
		// the raster was allocated `256 * 540.2796` bytes (the typed array truncates)
		// while reporting a height of 540.2796, and `encodeMask` handed the same
		// fraction to a canvas, which truncates it again.
		const mask = maskAt(0, 14.279614761037685);
		mask.setFrame(0, 14.279614761037685, 4, 526);
		const r = mask.materialize()!;
		for (const v of [r.originX, r.originY, r.width, r.height]) {
			expect(Number.isInteger(v)).toBe(true);
		}
		expect(r.data.length).toBe(r.width * r.height);
		expect(r.height).toBe(540);
	});
});

/**
 * "Clear all walls" used to leave the editor with nothing to paint into: no
 * pixels means no bounds, `materialize()` returns null, and null reads as "this
 * floor has no floorplan". Every stroke drawn afterwards was dropped in silence.
 */
describe('TiledMask after clear()', () => {
	it('still materialises, so a cleared floor stays editable', () => {
		const mask = maskAt(2000, 1200);
		mask.clear();

		const cleared = mask.materialize();
		expect(cleared).not.toBeNull();
		// The mask shrinks back to its frame — clearing is the only way to reclaim
		// the tiles — and it is that frame that keeps the empty raster materialisable.
		expect(cleared!.originX).toBe(2000);
		expect(cleared!.originY).toBe(1200);
		expect(cleared!.width).toBe(4);
		expect(cleared!.height).toBe(4);
		expect(cleared!.data.some((v) => v !== 0)).toBe(false);

		// And the next stroke persists, which is the whole point.
		mask.paintCircle(2000, 1200, 1, 1);
		const after = mask.materialize()!;
		const idx = (1200 - after.originY) * after.width + (2000 - after.originX);
		expect(after.data[idx]).toBe(1);
	});

	it('reports no raster at all only once the frame is dropped too', () => {
		const mask = maskAt(2000, 1200);
		mask.clear();
		mask.setFrame(0, 0, 0, 0);
		expect(mask.materialize()).toBeNull();
	});
});
