import { computeBuildingInterior, dilateMask, erodeMask } from './morphology.js';

export interface WallMask {
	dataUrl: string;
	width: number;
	height: number;
	originX: number;
	originY: number;
}

export interface DecodedWallMask {
	data: Uint8Array;
	width: number;
	height: number;
	/** World-space origin of the mask (default 0). */
	originX: number;
	originY: number;
}

/**
 * Detect walls from a floorplan image.
 * Pipeline: threshold -> remove small blobs -> remove exterior blobs -> binary mask.
 * Returns a wall mask at displayWidth resolution in world coordinates.
 *
 * There used to be an OCR step in front of this that masked room labels, and it is gone
 * rather than dormant: it loaded its model from a CDN, so the plan a laptop in a basement
 * could read was read differently from the one next to a router, and when the model failed
 * the step was skipped in silence. The job it was doing — keeping lettering out of the
 * mask — is `wall-trace.ts`'s now: a run of a letter is twenty-odd pixels long, and the
 * tracer drops runs that short. Doing it from the geometry instead of from a model is
 * also what made it work on labels the model could not read at all.
 */
export async function detectWalls(
	image: HTMLImageElement,
	displayWidth: number
): Promise<WallMask | null> {
	const displayScale = displayWidth / image.naturalWidth;
	const w = displayWidth;
	const h = Math.round(image.naturalHeight * displayScale);

	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext('2d')!;
	ctx.drawImage(image, 0, 0, w, h);

	// Decide which way round the plan is, and repair unpainted pixels, before
	// anything else reads them. See `resolveBackground`.
	const { darkBg } = resolveBackground(ctx, w, h);

	// Step 1: Grayscale + threshold to binary (1 = wall pixel)
	const imageData = ctx.getImageData(0, 0, w, h);
	const { data: pixels } = imageData;

	const gray = new Uint8Array(w * h);
	for (let i = 0; i < w * h; i++) {
		gray[i] = Math.round((pixels[i * 4]! + pixels[i * 4 + 1]! + pixels[i * 4 + 2]!) / 3);
	}

	// Adaptive local thresholding: compare each pixel to its neighborhood average.
	// Catches thin/faint wall lines that global threshold misses.
	let binary = adaptiveThreshold(gray, w, h, darkBg);

	// A floorplan is mostly floor, so more than half the sheet reading as wall means the
	// reading is the wrong way round — in the wrong orientation the "wall" is the paper,
	// and the paper is a majority by construction. One retry, and only when the first
	// attempt is absurd, so the ordinary case never pays for it. This is the safety net
	// under the polarity decision above: that one can still be fooled by a drawing whose
	// *ink* covers most of its area, which is what heavy poché looks like once flattened
	// to an image.
	let wallPixels = 0;
	for (let i = 0; i < w * h; i++) wallPixels += binary[i]!;
	if (wallPixels * 2 > w * h) {
		const flipped = adaptiveThreshold(gray, w, h, !darkBg);
		let flippedPixels = 0;
		for (let i = 0; i < w * h; i++) flippedPixels += flipped[i]!;
		if (flippedPixels < wallPixels) binary = flipped;
	}

	// Step 3: Fill the cavity inside a drawn wall.
	//
	// A wall on a printed plan is usually two strokes with a hatch or a lighter fill
	// between them, and the threshold keeps the strokes: what comes out is a **hollow**
	// outline — two thin lines with floor-coloured paper between them. The mask then looks
	// like a thin frame, and the interior test sees the inner stroke as an outer wall.
	//
	// A morphological close bridges a gap up to twice the radius, so it fills the cavity
	// between a wall's two strokes and leaves a room (hundreds of pixels across) untouched.
	// The radius scales with the sheet, and is capped both ways: too small leaves wide
	// poché hollow, too large starts eating narrow corridors.
	const closeRadius = Math.max(2, Math.min(6, Math.round(Math.min(w, h) * 0.004)));
	// `oob: 'solid'`: a wall that runs off the sheet edge is still a wall, so the erosion
	// must not shave the border ring off it.
	binary = erodeMask(dilateMask(binary, w, h, closeRadius), w, h, closeRadius, 'solid');

	// Step 4: Remove small disconnected blobs (noise, dots, thin text remnants)
	const minBlobPx = Math.max(30, Math.round(w * h * 0.0003));
	filterSmallBlobs(binary, w, h, minBlobPx);

	// Step 5: Remove blobs outside the building exterior
	removeExteriorBlobs(binary, w, h);

	let wallCount = 0;
	for (let i = 0; i < w * h; i++) wallCount += binary[i]!;
	if (wallCount < 50) return null;

	// Step 5: Encode binary mask as PNG data URL
	const maskCanvas = document.createElement('canvas');
	maskCanvas.width = w;
	maskCanvas.height = h;
	const maskCtx = maskCanvas.getContext('2d')!;
	const maskImg = maskCtx.createImageData(w, h);
	for (let i = 0; i < w * h; i++) {
		const j = i * 4;
		if (binary[i]) {
			maskImg.data[j] = 255;
			maskImg.data[j + 1] = 255;
			maskImg.data[j + 2] = 255;
			maskImg.data[j + 3] = 255;
		}
	}
	maskCtx.putImageData(maskImg, 0, 0);

	return {
		dataUrl: maskCanvas.toDataURL('image/png'),
		width: w,
		height: h,
		originX: 0,
		originY: 0
	};
}

/** Decode a wall mask PNG data URL to a Uint8Array for fast pixel lookups */
export function decodeMask(
	dataUrl: string,
	width: number,
	height: number
): Promise<DecodedWallMask> {
	return new Promise((resolve) => {
		const img = new Image();
		img.onload = () => {
			const canvas = document.createElement('canvas');
			canvas.width = width;
			canvas.height = height;
			const ctx = canvas.getContext('2d')!;
			ctx.drawImage(img, 0, 0);
			const data = ctx.getImageData(0, 0, width, height).data;
			const mask = new Uint8Array(width * height);
			for (let i = 0; i < mask.length; i++) {
				mask[i] = data[i * 4]! > 128 ? 1 : 0;
			}
			resolve({ data: mask, width, height, originX: 0, originY: 0 });
		};
		img.onerror = () =>
			resolve({ data: new Uint8Array(width * height), width, height, originX: 0, originY: 0 });
		img.src = dataUrl;
	});
}

/** Encode a binary wall mask Uint8Array back to a PNG data URL. */
export function encodeMask(data: Uint8Array, w: number, h: number): string {
	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext('2d')!;
	const imgData = ctx.createImageData(w, h);
	for (let i = 0; i < data.length; i++) {
		const j = i * 4;
		if (data[i]) {
			imgData.data[j] = 255;
			imgData.data[j + 1] = 255;
			imgData.data[j + 2] = 255;
			imgData.data[j + 3] = 255;
		}
	}
	ctx.putImageData(imgData, 0, 0);
	return canvas.toDataURL('image/png');
}

function filterSmallBlobs(binary: Uint8Array, w: number, h: number, minSize: number): void {
	const labels = new Int32Array(w * h).fill(-1);
	const blobPixels: number[][] = [];
	let nextLabel = 0;

	for (let i = 0; i < w * h; i++) {
		if (!binary[i] || labels[i] !== -1) continue;

		const label = nextLabel++;
		const pixels: number[] = [];
		const queue = [i];
		labels[i] = label;

		while (queue.length > 0) {
			const idx = queue.pop()!;
			pixels.push(idx);
			const x = idx % w;
			const y = Math.floor(idx / w);

			if (y > 0 && binary[idx - w] && labels[idx - w] === -1) {
				labels[idx - w] = label;
				queue.push(idx - w);
			}
			if (y < h - 1 && binary[idx + w] && labels[idx + w] === -1) {
				labels[idx + w] = label;
				queue.push(idx + w);
			}
			if (x > 0 && binary[idx - 1] && labels[idx - 1] === -1) {
				labels[idx - 1] = label;
				queue.push(idx - 1);
			}
			if (x < w - 1 && binary[idx + 1] && labels[idx + 1] === -1) {
				labels[idx + 1] = label;
				queue.push(idx + 1);
			}
		}

		blobPixels.push(pixels);
	}

	for (const pixels of blobPixels) {
		if (pixels.length < minSize) {
			for (const idx of pixels) binary[idx] = 0;
		}
	}
}

/** Remove wall blobs that are outside the building.
 *  Morphological close seals door gaps, flood fill identifies exterior,
 *  then wall blobs with no interior-adjacent pixels are removed. */
function removeExteriorBlobs(binary: Uint8Array, w: number, h: number): void {
	const { interior: fullInterior } = computeBuildingInterior(binary, w, h, {
		maxDim: 400,
		dilateRatio: 0.03,
		minDilateR: 5
	});

	// Label wall blobs at full resolution and check if they touch interior
	const labels = new Int32Array(w * h).fill(-1);
	const blobPixels: number[][] = [];
	const blobTouchesInterior: boolean[] = [];
	let nextLabel = 0;

	for (let i = 0; i < w * h; i++) {
		if (!binary[i] || labels[i] !== -1) continue;

		const label = nextLabel++;
		const pixels: number[] = [];
		let touches = false;
		const bq = [i];
		labels[i] = label;

		while (bq.length > 0) {
			const idx = bq.pop()!;
			pixels.push(idx);
			const x = idx % w,
				y = Math.floor(idx / w);

			// Check 4-connected neighbors for interior
			if (y > 0 && fullInterior[idx - w]) touches = true;
			if (y < h - 1 && fullInterior[idx + w]) touches = true;
			if (x > 0 && fullInterior[idx - 1]) touches = true;
			if (x < w - 1 && fullInterior[idx + 1]) touches = true;

			if (y > 0 && binary[idx - w] && labels[idx - w] === -1) {
				labels[idx - w] = label;
				bq.push(idx - w);
			}
			if (y < h - 1 && binary[idx + w] && labels[idx + w] === -1) {
				labels[idx + w] = label;
				bq.push(idx + w);
			}
			if (x > 0 && binary[idx - 1] && labels[idx - 1] === -1) {
				labels[idx - 1] = label;
				bq.push(idx - 1);
			}
			if (x < w - 1 && binary[idx + 1] && labels[idx + 1] === -1) {
				labels[idx + 1] = label;
				bq.push(idx + 1);
			}
		}

		blobPixels.push(pixels);
		blobTouchesInterior.push(touches);
	}

	// Remove blobs that don't touch interior (exterior decorations, legends)
	for (let b = 0; b < blobPixels.length; b++) {
		if (!blobTouchesInterior[b]) {
			for (const idx of blobPixels[b]!) binary[idx] = 0;
		}
	}
}

/**
 * Decide which way round the plan is drawn, and repair its unpainted pixels.
 * Returns the polarity `adaptiveThreshold` needs: true when walls are the
 * *brighter* pixels.
 *
 * Why this is not simply "is the border dark". `drawImage` writes only where the
 * source has coverage, so any part of an SVG without a full-canvas background
 * rect — or of a PNG with an alpha channel — stays transparent, and
 * `getImageData` reports those pixels as (0, 0, 0, 0). Every read in this file
 * takes RGB and ignores alpha, so transparency presents itself as **black**: a
 * light plan with a transparent border reads as a dark-background plan, walls are
 * then taken to be the bright pixels, and the detector returns the paper, the
 * room fills and the lettering as walls while the drawn walls become holes. On
 * `static/samples/state-floor.svg` that was 0 % of border pixels opaque, border
 * luminance 0, and 24 % of the image returned as wall — none of it on a drawn
 * line. It also gave `sampleBorderRgb` a black "background" to judge the paper
 * against, so both symptoms have this one cause.
 *
 * The repair is to fill the unpainted area with a paper colour, so no later read
 * ever sees a phantom black. `destination-over` draws *behind* the existing
 * pixels, so every opaque pixel stays exactly as the source rendered it.
 *
 * **What colour**, though, is the part that is easy to get wrong. Taking the
 * modal opaque colour — the obvious choice — fails on `state-floor.svg`, whose
 * walls are a thick filled poché in one flat brown and whose rooms are a dozen
 * different fills: the single most common colour in that file is the *wall*, so
 * the paper became brown, the border read at luminance 119, and the plan was
 * still judged dark-on-light. What actually distinguishes the two cases is
 * whether the plan painted a paper at all:
 *
 * - **It did** (an opaque border, which is what every sample that draws its own
 *   background gives): keep the existing border-luminance rule, now over opaque
 *   pixels only.
 * - **It did not** (a transparent border): the unpainted area *is* the paper. Its
 *   colour is not in the file, so the only question is which way round the
 *   drawing is, and the drawing answers that itself — a predominantly light
 *   drawing wanted light paper, a predominantly dark one wanted dark paper. The
 *   median luminance of its own pixels decides, and white is used for the light
 *   case because a local-mean threshold only needs the paper to be *lighter*,
 *   not to be an exact tone.
 */
function resolveBackground(
	ctx: CanvasRenderingContext2D,
	w: number,
	h: number
): { darkBg: boolean; paper: [number, number, number] } {
	const pixels = ctx.getImageData(0, 0, w, h).data;

	let borderLumSum = 0;
	let borderRSum = 0;
	let borderGSum = 0;
	let borderBSum = 0;
	let borderOpaque = 0;
	let borderTotal = 0;
	const borderAdd = (i: number): void => {
		borderTotal++;
		if (pixels[i + 3]! < 250) return;
		borderRSum += pixels[i]!;
		borderGSum += pixels[i + 1]!;
		borderBSum += pixels[i + 2]!;
		borderLumSum += (pixels[i]! + pixels[i + 1]! + pixels[i + 2]!) / 3;
		borderOpaque++;
	};
	for (let x = 0; x < w; x++) {
		borderAdd(x * 4);
		borderAdd(((h - 1) * w + x) * 4);
	}
	for (let y = 1; y < h - 1; y++) {
		borderAdd(y * w * 4);
		borderAdd((y * w + w - 1) * 4);
	}

	const lumHistogram = new Uint32Array(256);
	const colourCounts = new Map<number, number>();
	let opaque = 0;
	for (let i = 0; i < pixels.length; i += 4) {
		if (pixels[i + 3]! < 250) continue;
		opaque++;
		lumHistogram[Math.round((pixels[i]! + pixels[i + 1]! + pixels[i + 2]!) / 3)]!++;
		const key = ((pixels[i]! >> 3) << 10) | ((pixels[i + 1]! >> 3) << 5) | (pixels[i + 2]! >> 3);
		colourCounts.set(key, (colourCounts.get(key) ?? 0) + 1);
	}

	// Not one opaque pixel: a blank canvas rather than a floorplan. Light paper is
	// the harmless answer — the threshold then finds nothing and `detectWalls`
	// returns null on the wall-count check below.
	if (opaque === 0) return { darkBg: false, paper: [255, 255, 255] };

	// The plan painted its own paper, and the border is it: the border names the
	// background directly, and that is the answer for every plan that draws a
	// background rectangle.
	//
	// The border is only *evidence* of the paper when it is the same tone as it. On a
	// scan it is routinely the darkest thing in the image — the scanner's shadow, the
	// lid, a frame, the table the page sat on — and reading that as the paper decides
	// the polarity backwards: with a dark "background" the threshold hunts for pixels
	// *brighter* than their neighbourhood, so the sheet itself becomes wall. Measured
	// on the shipped sample with a black edge added: 26.7 % of the image as wall
	// against 4.9 % read the right way round, with every wall doubled and its own
	// outline drawn a second time. So an edge that disagrees with the paper loses to
	// the paper, which the drawing states plainly by being mostly one tone.
	const modeLum = modalLuminance(lumHistogram);
	if (borderOpaque >= borderTotal * 0.1) {
		const borderLum = borderLumSum / borderOpaque;
		if (Math.abs(borderLum - modeLum) <= BORDER_AGREEMENT) {
			return {
				darkBg: borderLum < 128,
				paper: [
					Math.round(borderRSum / borderOpaque),
					Math.round(borderGSum / borderOpaque),
					Math.round(borderBSum / borderOpaque)
				]
			};
		}
		// The edge is something else — a shadow, a frame, a table. The paper is the
		// tone the drawing is mostly made of.
		return { darkBg: modeLum < 128, paper: modalColour(colourCounts) };
	}

	// No paper was painted. The unpainted area *is* the paper. Its colour is not in
	// the file, so the only question is which way round the drawing is, and the
	// drawing answers that itself — a predominantly light drawing wanted light
	// paper, a predominantly dark one wanted dark paper. The median luminance of its
	// own pixels decides, and white is used for the light case because a local-mean
	// threshold only needs the paper to be *lighter*, not to be an exact tone.
	const medianLum = medianFromHistogram(lumHistogram, opaque);
	if (medianLum >= 128) {
		compositeOntoPaper(ctx, w, h, [255, 255, 255]);
		return { darkBg: false, paper: [255, 255, 255] };
	}

	// A predominantly dark drawing was made to sit on a dark canvas; follow it, and
	// use its own darkest common colour so the polarity reads consistently.
	const paper = darkestModalColour(colourCounts);
	compositeOntoPaper(ctx, w, h, paper);
	return { darkBg: true, paper };
}

/**
 * Fill the transparent parts of the canvas with `paper`, leaving opaque pixels
 * untouched (`destination-over` draws behind them). A no-op when nothing is
 * transparent, which is every plan that paints its own background.
 */
function compositeOntoPaper(
	ctx: CanvasRenderingContext2D,
	w: number,
	h: number,
	paper: [number, number, number]
): void {
	const pixels = ctx.getImageData(0, 0, w, h).data;
	let transparent = 0;
	for (let i = 3; i < pixels.length; i += 4) {
		if (pixels[i]! < 250) transparent++;
	}
	if (transparent === 0) return;

	ctx.save();
	ctx.globalCompositeOperation = 'destination-over';
	ctx.fillStyle = `rgb(${paper[0]}, ${paper[1]}, ${paper[2]})`;
	ctx.fillRect(0, 0, w, h);
	ctx.restore();
}

/**
 * How far a border's luminance may sit from the image's most common tone and still be
 * taken for the paper.
 *
 * Wide enough to survive a gradient, JPEG ringing or a slightly off-white background
 * rectangle; narrow enough that a scanner shadow (near black against white paper) is
 * not mistaken for it.
 */
const BORDER_AGREEMENT = 48;

/**
 * The most common colour among the opaque pixels, quantised to 5 bits per channel.
 *
 * Quantised because a plan with gradients or anti-aliasing has no two pixels in exactly
 * the same colour, and an exact histogram would then have no useful mode. Falls back to
 * white, the tone a raster plan is overwhelmingly drawn on.
 */
function modalColour(colourCounts: Map<number, number>): [number, number, number] {
	let best: [number, number, number] = [255, 255, 255];
	let bestCount = 0;
	for (const [key, count] of colourCounts) {
		if (count <= bestCount) continue;
		bestCount = count;
		best = [(((key >> 10) & 31) << 3) + 4, (((key >> 5) & 31) << 3) + 4, ((key & 31) << 3) + 4];
	}
	return best;
}

/**
 * The most common luminance, in 8-wide buckets.
 *
 * Buckets because a scan has no two pixels at exactly the same level: its paper is a
 * narrow *range*, and an exact histogram would have no useful peak.
 */
function modalLuminance(histogram: Uint32Array): number {
	const buckets = new Uint32Array(32);
	for (let lum = 0; lum < histogram.length; lum++) {
		buckets[lum >> 3]! += histogram[lum]!;
	}
	let bestBucket = 0;
	let bestCount = -1;
	for (let b = 0; b < buckets.length; b++) {
		if (buckets[b]! > bestCount) {
			bestCount = buckets[b]!;
			bestBucket = b;
		}
	}
	// The centre of the winning bucket, so a peak sitting on a bucket edge is not
	// reported as its darkest level.
	return bestBucket * 8 + 4;
}

/** The luminance below which half the opaque pixels sit. */
function medianFromHistogram(histogram: Uint32Array, total: number): number {
	let seen = 0;
	for (let lum = 0; lum < histogram.length; lum++) {
		seen += histogram[lum]!;
		if (seen * 2 >= total) return lum;
	}
	return 255;
}

/**
 * The most common colour among the opaque pixels that are dark, quantised to 5
 * bits per channel.
 *
 * Quantised because a plan with gradients or anti-aliasing has no two pixels in
 * exactly the same colour, and an exact histogram would then have no useful mode.
 * Falls back to black, which is the colour a "dark canvas" plan is drawn against.
 */
function darkestModalColour(colourCounts: Map<number, number>): [number, number, number] {
	let bestKey = -1;
	let bestCount = 0;
	for (const [key, count] of colourCounts) {
		const r = (((key >> 10) & 31) << 3) + 4;
		const g = (((key >> 5) & 31) << 3) + 4;
		const b = ((key & 31) << 3) + 4;
		if ((r + g + b) / 3 >= 128) continue;
		if (count > bestCount) {
			bestCount = count;
			bestKey = key;
		}
	}
	if (bestKey < 0) return [0, 0, 0];
	return [
		(((bestKey >> 10) & 31) << 3) + 4,
		(((bestKey >> 5) & 31) << 3) + 4,
		((bestKey & 31) << 3) + 4
	];
}

/** Adaptive local threshold using integral image for O(1) per-pixel mean.
 *  Each pixel is compared to the mean of a KxK neighborhood.
 *  For dark backgrounds: pixel brighter than localMean + C → wall.
 *  For light backgrounds: pixel darker than localMean - C → wall. */
function adaptiveThreshold(gray: Uint8Array, w: number, h: number, darkBg: boolean): Uint8Array {
	// Build integral image for fast local mean computation
	const integral = new Float64Array((w + 1) * (h + 1));
	for (let y = 0; y < h; y++) {
		let rowSum = 0;
		for (let x = 0; x < w; x++) {
			rowSum += gray[y * w + x]!;
			integral[(y + 1) * (w + 1) + (x + 1)] = rowSum + integral[y * (w + 1) + (x + 1)]!;
		}
	}

	function localMean(x: number, y: number, r: number): number {
		const x0 = Math.max(0, x - r);
		const y0 = Math.max(0, y - r);
		const x1 = Math.min(w, x + r + 1);
		const y1 = Math.min(h, y + r + 1);
		const stride = w + 1;
		const sum =
			integral[y1 * stride + x1]! -
			integral[y0 * stride + x1]! -
			integral[y1 * stride + x0]! +
			integral[y0 * stride + x0]!;
		return sum / ((x1 - x0) * (y1 - y0));
	}

	const binary = new Uint8Array(w * h);
	const radius = Math.max(8, Math.round(Math.max(w, h) * 0.03));
	// C: how much a pixel must differ from local mean to be "wall"
	const C = darkBg ? 15 : -15;

	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const val = gray[y * w + x]!;
			const mean = localMean(x, y, radius);
			if (darkBg) {
				binary[y * w + x] = val > mean + C ? 1 : 0;
			} else {
				binary[y * w + x] = val < mean + C ? 1 : 0;
			}
		}
	}

	return binary;
}
