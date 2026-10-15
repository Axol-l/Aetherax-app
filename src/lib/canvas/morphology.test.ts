import { describe, expect, it } from 'vitest';
import { computeBuildingInterior } from './morphology.js';

/**
 * The mask's edge is not a wall.
 *
 * A reported plan had its outer wall drawn 36 px from the edge of a 1027x790 mask, while
 * the morphological close at the working resolution used a radius of 16 — so the whole
 * margin strip along the top and left was swallowed by the close, no passable border pixel
 * was left to seed the flood fill there, and the strip came back as *interior*. The
 * consequences were not cosmetic: 11 % of the "interior" was outside the building, the
 * optimiser parked its only AP in the corner of it, and the coverage estimator counted that
 * strip as floor area — 90 % coverage on a floor the heatmap showed mostly uncovered.
 *
 * These cases pin the geometry, at both working resolutions the app uses.
 */

/** A closed rectangular outline: one wall pixel wide, `margin` px in from the mask edge. */
function roomMask(
	w: number,
	h: number,
	margin: number,
	interiorGap: number
): Uint8Array {
	const mask = new Uint8Array(w * h);
	const x0 = margin;
	const y0 = margin;
	const x1 = w - margin - interiorGap;
	const y1 = h - margin - interiorGap;
	for (let x = x0; x <= x1; x++) {
		mask[y0 * w + x] = 1;
		mask[y1 * w + x] = 1;
	}
	for (let y = y0; y <= y1; y++) {
		mask[y * w + x0] = 1;
		mask[y * w + x1] = 1;
	}
	return mask;
}

describe('computeBuildingInterior', () => {
	/**
	 * The reported geometry: margin 10 px, closing radius 12 px (`maxDim: 0`, so the radius
	 * is `round(300 * 0.04) = 12`). Every pixel outside the outline is outside the building,
	 * however thin the margin is.
	 */
	it('does not call the margin outside the walls interior', () => {
		const w = 300;
		const h = 200;
		const margin = 10;
		const mask = roomMask(w, h, margin, 10);
		const { interior, exterior } = computeBuildingInterior(mask, w, h, {
			maxDim: 0,
			dilateRatio: 0.04,
			minDilateR: 4
		});

		// The strip between the mask edge and the wall.
		expect(exterior[2 * w + 2]).toBe(1);
		expect(interior[2 * w + 2]).toBe(0);
		expect(exterior[2 * w + 150]).toBe(1);
		expect(exterior[150 * w + 2]).toBe(1);
		// ... and the room itself is still interior.
		expect(interior[100 * w + 150]).toBe(1);
		expect(exterior[100 * w + 150]).toBe(0);
	});

	/**
	 * The invariant, checked over every pixel rather than at sampled points: a region enclosed
	 * by walls is by definition inside the walls' bounding box, so no interior pixel may lie
	 * outside it. This is what makes "the AP is inside the building" a meaningful test, and it
	 * is checked at both working resolutions because the coarse one is where it broke.
	 */
	it('never reports interior pixels outside the wall bounding box', () => {
		for (const maxDim of [0, 400]) {
			const w = 512;
			const h = 384;
			const margin = 18;
			const mask = roomMask(w, h, margin, 20);
			const { interior } = computeBuildingInterior(mask, w, h, {
				maxDim,
				dilateRatio: 0.04,
				minDilateR: 4,
				// The placement and sampling domain, as the optimiser and the estimator ask for it.
				trimWallAdjacent: true
			});

			let minX = Infinity;
			let minY = Infinity;
			let maxX = -1;
			let maxY = -1;
			for (let y = 0; y < h; y++) {
				for (let x = 0; x < w; x++) {
					if (!mask[y * w + x]) continue;
					if (x < minX) minX = x;
					if (y < minY) minY = y;
					if (x > maxX) maxX = x;
					if (y > maxY) maxY = y;
				}
			}

			let interiorPixels = 0;
			let outside = 0;
			for (let y = 0; y < h; y++) {
				for (let x = 0; x < w; x++) {
					if (!interior[y * w + x]) continue;
					interiorPixels++;
					if (x < minX || x > maxX || y < minY || y > maxY) outside++;
				}
			}
			// The room is found at both resolutions...
			expect(interiorPixels).toBeGreaterThan(0);
			// ... and none of what was found is outside the walls.
			expect(outside).toBe(0);
		}
	});

	/**
	 * The opposite contract, and it has to be a test: `wall-detect`'s exterior-blob filter
	 * keeps a wall blob only when an interior pixel touches it, so the margin off the walls
	 * must stay opt-in. Making it unconditional deleted **every wall on the plan** — 21 e2e
	 * failures, walls invisible after loading a floorplan — because no blob had an interior
	 * neighbour any more.
	 */
	it('leaves interior touching the walls unless the caller asks for the margin', () => {
		const w = 300;
		const h = 200;
		const margin = 20;
		const mask = roomMask(w, h, margin, 20);
		const options = { maxDim: 0, dilateRatio: 0.04, minDilateR: 4 } as const;

		const touchesWall = (interior: Uint8Array): boolean => {
			for (let y = 0; y < h; y++) {
				for (let x = 0; x < w; x++) {
					if (!interior[y * w + x]) continue;
					if (
						(x > 0 && mask[y * w + x - 1]) ||
						(x < w - 1 && mask[y * w + x + 1]) ||
						(y > 0 && mask[(y - 1) * w + x]) ||
						(y < h - 1 && mask[(y + 1) * w + x])
					) {
						return true;
					}
				}
			}
			return false;
		};

		// Default: the wall detector's filter can find an interior neighbour for a wall blob...
		expect(touchesWall(computeBuildingInterior(mask, w, h, options).interior)).toBe(true);
		// ... and when the caller asks for the placement domain, nothing touches a wall.
		expect(
			touchesWall(
				computeBuildingInterior(mask, w, h, { ...options, trimWallAdjacent: true }).interior
			)
		).toBe(false);
	});

	/** A gap in the outline is still sealed, which is the reason the close exists at all. */
	it('still seals a door-sized gap in the outline', () => {
		const w = 300;
		const h = 200;
		const mask = roomMask(w, h, 20, 20);
		// A 6 px doorway in the top wall.
		for (let x = 140; x < 146; x++) mask[20 * w + x] = 0;
		const { interior } = computeBuildingInterior(mask, w, h, {
			maxDim: 0,
			dilateRatio: 0.04,
			minDilateR: 4
		});
		expect(interior[100 * w + 150]).toBe(1);
	});
});

describe('minRegionRadius', () => {
	/**
	 * A room with a wall cavity beside it, both enclosed.
	 *
	 * Two parallel lines with a 16 px gap between them are exactly what a plan drawn with
	 * a doubled facade produces, and the flood fill cannot enter either space: to the
	 * interior they are both "inside". Only one of them is a room.
	 */
	function roomWithCavity(w = 120, h = 100) {
		const mask = new Uint8Array(w * h);
		const line = (x0: number, y0: number, x1: number, y1: number) => {
			for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) mask[y * w + x] = 1;
		};
		// The building: a closed box, 4 px thick.
		line(4, 4, w - 5, 8);
		line(4, h - 9, w - 5, h - 5);
		line(4, 4, 8, h - 5);
		line(w - 9, 4, w - 5, h - 5);
		// The cavity: two lines with a 16 px gap, closed at both ends, inside the box.
		line(20, 20, 100, 22);
		line(20, 39, 100, 41);
		line(20, 20, 22, 41);
		line(98, 20, 100, 41);
		return { mask, w, h, cavity: { x: 60, y: 30 }, room: { x: 60, y: 70 } };
	}

	it('drops a cavity and keeps the room around it', () => {
		const { mask, w, h, cavity, room } = roomWithCavity();
		const { interior } = computeBuildingInterior(mask, w, h, {
			maxDim: 0,
			dilateRatio: 0.04,
			minDilateR: 4,
			// A 16 px gap has an inscribed radius of ~8, the room's is ~45.
			minRegionRadius: 20
		});
		expect(interior[cavity.y * w + cavity.x]).toBe(0);
		expect(interior[room.y * w + room.x]).toBe(1);
	});

	it('keeps every enclosed region when no threshold is given', () => {
		// The behaviour before cavities were understood to be a placement bug: the domain
		// was "everything the fill could not reach", cavity included.
		const { mask, w, h, cavity } = roomWithCavity();
		const { interior } = computeBuildingInterior(mask, w, h, {
			maxDim: 0,
			dilateRatio: 0.04,
			minDilateR: 4
		});
		expect(interior[cavity.y * w + cavity.x]).toBe(1);
	});

	it('keeps a narrow space when the threshold is below its radius', () => {
		// The threshold is a radius, and the cavity's is about 8: at 5 it stays, which is
		// what keeps a genuinely narrow room — a 1.2 m corridor — out of the filter's way
		// at the real threshold of 0.3 m.
		const { mask, w, h, cavity, room } = roomWithCavity();
		const { interior } = computeBuildingInterior(mask, w, h, {
			maxDim: 0,
			dilateRatio: 0.04,
			minDilateR: 4,
			minRegionRadius: 5
		});
		expect(interior[cavity.y * w + cavity.x]).toBe(1);
		expect(interior[room.y * w + room.x]).toBe(1);
	});
});

