/**
 * Morphological operations and building interior detection.
 * Used by boundary-detect, wall-detect, optimizer-worker, and room detection.
 * No DOM dependencies — safe for Web Workers.
 */

export interface InteriorResult {
	/** 1 = interior (inside building, not wall), 0 = exterior or wall */
	interior: Uint8Array;
	/** 1 = exterior (reachable from border), 0 = not exterior */
	exterior: Uint8Array;
}

export interface BuildingInteriorOptions {
	/** Downsample to this max dimension before morph close. 0 = no downsample. */
	maxDim?: number;
	/** Dilation radius as fraction of (downsampled) width. Default 0.04. */
	dilateRatio?: number;
	/** Minimum dilation radius in pixels. Default 10. */
	minDilateR?: number;
	/**
	 * Pull the interior one pixel back from every wall (eight-neighbourhood).
	 *
	 * Who wants this: the two consumers where the interior *is* the answer — the optimiser's
	 * placement domain and the coverage sample set. A working cell that holds wall pixels is a
	 * wall cell, so at a coarse working resolution its non-wall full-resolution pixels come back
	 * as interior even where they sit on the building's outside face (a one-pixel ring, 2 cm of
	 * floor at 51 px/m). No AP belongs against a wall face and no coverage sample is wanted there.
	 *
	 * Who must **not** want this: `wall-detect`'s exterior-blob filter, which keeps a wall blob
	 * only when an interior pixel touches it. Trimming every wall-adjacent pixel there removes
	 * *every wall on the plan*. Default off, so that filter keeps working unchanged.
	 */
	trimWallAdjacent?: boolean;
	/**
	 * Drop enclosed regions too narrow to hold an access point, in mask pixels.
	 *
	 * The interior is "everything the flood fill could not reach from the border", which
	 * is not the same as "rooms". A plan drawn with double lines — a facade with a cavity,
	 * a wall with an air gap, two parallel partitions a few centimetres apart — encloses
	 * slivers that the fill cannot enter, and an optimiser given those as placement domain
	 * will use them: an access point 3 cm from a wall, in a 0.6 m² pocket, is what a user
	 * sees as "the optimiser put it outside the room".
	 *
	 * A region's **largest inscribed circle** is what tells a room from a cavity: a
	 * 1.2 m-wide corridor has a 0.6 m one, a drawing gap has centimetres. Regions below
	 * this radius are removed whole, so what survives keeps its full extent — a wall mount
	 * still has the wall it needs.
	 *
	 * Mask pixels are world units, so this is a physical length: multiply metres by
	 * worldUnitsPerMeter. Zero (the default) keeps every enclosed region, which is what
	 * wall detection's blob filter wants.
	 */
	minRegionRadius?: number;
}

// ─── Reusable morphological operations ─────────────────────────────

/**
 * Dilate truthy pixels in a binary mask by a square radius.
 * Each truthy pixel expands to fill a (2r+1)×(2r+1) square.
 * Returns a new mask (does not mutate input).
 */
export function dilateMask(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
	const out = new Uint8Array(mask);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			if (!mask[y * w + x]) continue;
			const ylo = Math.max(0, y - radius);
			const yhi = Math.min(h - 1, y + radius);
			const xlo = Math.max(0, x - radius);
			const xhi = Math.min(w - 1, x + radius);
			for (let ny = ylo; ny <= yhi; ny++) {
				for (let nx = xlo; nx <= xhi; nx++) {
					out[ny * w + nx] = 1;
				}
			}
		}
	}
	return out;
}

/**
 * Erode: expand truthy pixels in a binary mask by a square radius.
 * The inverse of dilate — each truthy pixel spreads its value to neighbors.
 * Used to restore wall thickness after dilation.
 */
export function erodeMask(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
	const out = new Uint8Array(mask);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			if (mask[y * w + x] !== 1) continue;
			const ylo = Math.max(0, y - radius);
			const yhi = Math.min(h - 1, y + radius);
			const xlo = Math.max(0, x - radius);
			const xhi = Math.min(w - 1, x + radius);
			for (let ny = ylo; ny <= yhi; ny++) {
				for (let nx = xlo; nx <= xhi; nx++) {
					out[ny * w + nx] = 1;
				}
			}
		}
	}
	return out;
}

/**
 * Flood fill from all border pixels through passable (truthy) pixels.
 * Returns a mask where 1 = reachable from border (exterior).
 */
export function floodFillExterior(passable: Uint8Array, w: number, h: number): Uint8Array {
	const exterior = new Uint8Array(w * h);
	const queue: number[] = [];

	// Seed from all border pixels
	for (let x = 0; x < w; x++) {
		if (passable[x]) queue.push(x);
		if (passable[(h - 1) * w + x]) queue.push((h - 1) * w + x);
	}
	for (let y = 0; y < h; y++) {
		if (passable[y * w]) queue.push(y * w);
		if (passable[y * w + w - 1]) queue.push(y * w + w - 1);
	}

	while (queue.length > 0) {
		const idx = queue.pop()!;
		if (exterior[idx]) continue;
		exterior[idx] = 1;
		const x = idx % w;
		const y = Math.floor(idx / w);
		if (y > 0 && !exterior[idx - w] && passable[idx - w]) queue.push(idx - w);
		if (y < h - 1 && !exterior[idx + w] && passable[idx + w]) queue.push(idx + w);
		if (x > 0 && !exterior[idx - 1] && passable[idx - 1]) queue.push(idx - 1);
		if (x < w - 1 && !exterior[idx + 1] && passable[idx + 1]) queue.push(idx + 1);
	}

	return exterior;
}

// ─── Building interior detection ───────────────────────────────────

/**
 * Compute building interior from a binary wall mask.
 * Pipeline: optional downsample → morph close (dilate+erode) → flood fill exterior → interior.
 *
 * @param wallMask Binary mask: 1 = wall pixel, 0 = passable
 * @param w Mask width
 * @param h Mask height
 * @param options Tuning parameters
 * @returns Interior and exterior masks at the ORIGINAL (w x h) resolution
 */
export function computeBuildingInterior(
	wallMask: Uint8Array,
	w: number,
	h: number,
	options?: BuildingInteriorOptions
): InteriorResult {
	const maxDim = options?.maxDim ?? 0;
	const dilateRatio = options?.dilateRatio ?? 0.04;
	const minDilateR = options?.minDilateR ?? 10;

	// Determine working resolution
	const needsDownsample = maxDim > 0 && Math.max(w, h) > maxDim;
	const rs = needsDownsample ? maxDim / Math.max(w, h) : 1;
	const sw0 = Math.round(w * rs);
	const sh0 = Math.round(h * rs);

	// The closing radius, measured on the *unpadded* working mask.
	const dilateR = Math.max(minDilateR, Math.round(sw0 * dilateRatio));

	/*
	 * Work on a mask grown by the closing radius on every side.
	 *
	 * **The mask edge is not a wall**, and the closing does not know that. A plan is drawn
	 * with whatever margin it has, and when that margin is thinner than the closing radius
	 * the close swallows it whole: no passable pixel is left on the border there, so
	 * `floodFillExterior` has nothing to start from and the margin comes back as
	 * *interior*. That is not cosmetic — the optimiser may hang an AP outside the building
	 * (it is "inside" by the only test there is), and the coverage estimate counts the strip
	 * outside the walls as floor area. A reported plan did exactly this: its outer wall sat
	 * 14 working pixels from the edge while the closing radius was 16, so 11 % of the
	 * "interior" was the margin outside the building, the optimiser parked its only AP in
	 * the corner of it, and the panel read 90 % coverage that the heatmap contradicted.
	 *
	 * Padding gives the closing the room it assumes it has, which is what makes the
	 * documented contract hold: a room counts as inside once walls form a closed outline
	 * around it, and the image boundary is not part of that outline.
	 */
	const pad = dilateR;
	const sw = sw0 + pad * 2;
	const sh = sh0 + pad * 2;

	/*
	 * Downsample the wall mask if needed, into the padded working array, with **a wall
	 * winning its cell**.
	 *
	 * Nearest-neighbour sampling drops whatever falls between sample points, and what falls
	 * between them on a traced plan is the wall line itself: at 1024 px downsampled to 400 a
	 * one-pixel outline loses whole rows, so the building is open at the working resolution
	 * and the flood fill walks in — the room comes back *exterior*, and the optimiser is told
	 * there is nowhere inside to put an access point. Taking the cell's maximum instead can
	 * only thicken a wall, never lose one.
	 */
	const small = new Uint8Array(sw * sh);
	if (needsDownsample) {
		for (let sy = 0; sy < sh0; sy++) {
			const oy0 = Math.min(h - 1, Math.floor(sy / rs));
			const oy1 = Math.min(h, Math.max(oy0 + 1, Math.ceil((sy + 1) / rs)));
			for (let sx = 0; sx < sw0; sx++) {
				const ox0 = Math.min(w - 1, Math.floor(sx / rs));
				const ox1 = Math.min(w, Math.max(ox0 + 1, Math.ceil((sx + 1) / rs)));
				let wall = 0;
				for (let oy = oy0; oy < oy1 && !wall; oy++) {
					for (let ox = ox0; ox < ox1; ox++) {
						if (wallMask[oy * w + ox]) {
							wall = 1;
							break;
						}
					}
				}
				small[(sy + pad) * sw + (sx + pad)] = wall;
			}
		}
	} else {
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				small[(y + pad) * sw + (x + pad)] = wallMask[y * w + x]!;
			}
		}
	}

	// Morphological close: dilate walls (shrink passable) then erode back
	const dilated = dilateMask(small, sw, sh, dilateR);
	const closedPass = new Uint8Array(sw * sh);
	for (let i = 0; i < sw * sh; i++) closedPass[i] = dilated[i] ? 0 : 1;
	const eroded = erodeMask(closedPass, sw, sh, dilateR);

	// Flood fill exterior from border
	const smallExterior = floodFillExterior(eroded, sw, sh);

	// Upsample to original resolution
	const exterior = new Uint8Array(w * h);
	const interior = new Uint8Array(w * h);

	for (let y = 0; y < h; y++) {
		const sy = Math.min(sh0 - 1, Math.round(y * rs)) + pad;
		for (let x = 0; x < w; x++) {
			const sx = Math.min(sw0 - 1, Math.round(x * rs)) + pad;
			const ext = smallExterior[sy * sw + sx] === 1;
			if (ext) exterior[y * w + x] = 1;
			// The wall test reads the full-resolution mask, which is not padded: a wall
			// pixel is never interior, whatever the coarse pass concluded about its cell.
			if (!ext && !wallMask[y * w + x]) interior[y * w + x] = 1;
		}
	}

	// Off the walls by one pixel, when the caller's interior is a placement or sampling
	// domain. See `trimWallAdjacent` for who asks and who must not.
	if (options?.trimWallAdjacent) {
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const i = y * w + x;
				if (!interior[i]) continue;
				const up = y > 0;
				const down = y < h - 1;
				const left = x > 0;
				const right = x < w - 1;
				// Diagonals too: at a corner the only wall pixel in reach is diagonal.
				if (
					(left && wallMask[i - 1]) ||
					(right && wallMask[i + 1]) ||
					(up && wallMask[i - w]) ||
					(down && wallMask[i + w]) ||
					(up && left && wallMask[i - w - 1]) ||
					(up && right && wallMask[i - w + 1]) ||
					(down && left && wallMask[i + w - 1]) ||
					(down && right && wallMask[i + w + 1])
				) {
					interior[i] = 0;
				}
			}
		}
	}

	// Cavities and drawing gaps out. See `minRegionRadius` for why this is a region test
	// rather than an erosion: an eroded domain would take the wall away from a wall mount.
	if (options?.minRegionRadius && options.minRegionRadius > 0) {
		dropThinRegions(interior, wallMask, w, h, options.minRegionRadius);
	}

	return { interior, exterior };
}

/**
 * Fill the gap between two parallel strokes, without moving either of them.
 *
 * A window band in an architectural drawing is two lines. The raster of the "window" role
 * therefore holds two lines and nothing between them, and the RF model charges the wall's
 * material in the middle of the window.
 *
 * Two earlier attempts are worth recording, because both fail on a real plan:
 *
 * - A 2-D closing (dilate then erode) grows the band outward as well as inward, so the
 *   window ends up **thicker than the wall it sits in**.
 * - Filling the outline's enclosed interior works only when the band is *closed*. Real
 *   windows run the length of a facade, so the gap is open at both ends, the flood fill
 *   gets in and nothing is filled — the drawn result is a sandwich, glass on two edges.
 *
 * So the closing is done **one axis at a time**: a 1-D closing along y bridges the gap
 * between two horizontal lines and leaves their y positions untouched, which is exactly
 * the thickness that must not change; the same along x handles a vertical band. Neither
 * pass touches its perpendicular extent, so nothing grows.
 */
export function fillParallelGaps(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
	if (radius <= 0) return new Uint8Array(mask);
	const maxGap = radius * 2;
	/*
	 * A span fill rather than a dilate-then-erode: walk each line and, wherever two ink
	 * pixels are at most `maxGap` apart, make the background between them ink. It needs no
	 * margin around the shape — a facade window often sits a few pixels from the raster's
	 * edge, where a morphological closing has nothing to erode against and loses the fill —
	 * and it can only ever turn a 0 into a 1 *inside* a gap, so the band cannot grow.
	 */
	const along = (input: Uint8Array, axis: 'x' | 'y'): Uint8Array => {
		const out = new Uint8Array(input);
		const lineLength = axis === 'x' ? w : h;
		const lineCount = axis === 'x' ? h : w;
		const indexOf = (line: number, at: number) => (axis === 'x' ? line * w + at : at * w + line);
		for (let line = 0; line < lineCount; line++) {
			let lastInk = -1;
			for (let at = 0; at < lineLength; at++) {
				if (!input[indexOf(line, at)]) continue;
				if (lastInk >= 0 && at - lastInk - 1 <= maxGap) {
					for (let p = lastInk + 1; p < at; p++) out[indexOf(line, p)] = 1;
				}
				lastInk = at;
			}
		}
		return out;
	};
	// y first: most bands run across a facade. Then x, for the ones that run up it.
	return along(along(mask, 'y'), 'x');
}

/**
 * Remove every enclosed region whose largest inscribed circle is under `minRadius`.
 *
 * Two passes: a distance transform of the walls gives each interior pixel its clearance
 * (an approximation on the coarse grid, which is all this needs), and a connected
 * labelling walks the regions. A region is kept or dropped as a whole, so a room keeps
 * the pixels against its walls.
 *
 * Mutates `interior`.
 */
export function dropThinRegions(
	interior: Uint8Array,
	wallMask: Uint8Array,
	w: number,
	h: number,
	minRadius: number
): void {
	const n = w * h;
	const clearance = new Float32Array(n);
	// Chebyshev distance to the nearest wall by two sweeps: close enough to tell a room
	// from a gap, and it avoids pulling a Euclidean transform into the worker's hot path.
	const INF = 1e9;
	for (let i = 0; i < n; i++) clearance[i] = wallMask[i] ? 0 : INF;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			if (clearance[i] === 0) continue;
			let best = clearance[i]!;
			if (y > 0) best = Math.min(best, clearance[i - w]! + 1);
			if (x > 0) best = Math.min(best, clearance[i - 1]! + 1);
			if (y > 0 && x > 0) best = Math.min(best, clearance[i - w - 1]! + 1);
			if (y > 0 && x < w - 1) best = Math.min(best, clearance[i - w + 1]! + 1);
			clearance[i] = best;
		}
	}
	for (let y = h - 1; y >= 0; y--) {
		for (let x = w - 1; x >= 0; x--) {
			const i = y * w + x;
			if (clearance[i] === 0) continue;
			let best = clearance[i]!;
			if (y < h - 1) best = Math.min(best, clearance[i + w]! + 1);
			if (x < w - 1) best = Math.min(best, clearance[i + 1]! + 1);
			if (y < h - 1 && x < w - 1) best = Math.min(best, clearance[i + w + 1]! + 1);
			if (y < h - 1 && x > 0) best = Math.min(best, clearance[i + w - 1]! + 1);
			clearance[i] = best;
		}
	}

	const label = new Int32Array(n).fill(-1);
	const queue = new Int32Array(n);
	/** The pixels of each region, so a dropped one can be cleared without a rescan. */
	const pixelsOf: number[][] = [];

	for (let start = 0; start < n; start++) {
		if (!interior[start] || label[start] !== -1) continue;
		const id = pixelsOf.length;
		const pixels: number[] = [];
		pixelsOf.push(pixels);
		let head = 0;
		let tail = 0;
		queue[tail++] = start;
		label[start] = id;
		let maxClearance = 0;
		while (head < tail) {
			const i = queue[head++]!;
			pixels.push(i);
			const c = clearance[i]!;
			if (c > maxClearance) maxClearance = c;
			const x = i % w;
			const y = (i / w) | 0;
			for (let dy = -1; dy <= 1; dy++) {
				const ny = y + dy;
				if (ny < 0 || ny >= h) continue;
				for (let dx = -1; dx <= 1; dx++) {
					const nx = x + dx;
					if (nx < 0 || nx >= w) continue;
					const ni = ny * w + nx;
					if (!interior[ni] || label[ni] !== -1) continue;
					label[ni] = id;
					queue[tail++] = ni;
				}
			}
		}
		// `maxClearance` is the radius of the largest circle that fits in this region.
		if (maxClearance < minRadius) {
			for (const i of pixels) interior[i] = 0;
		}
	}
}
