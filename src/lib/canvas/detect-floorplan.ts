/**
 * Pick the right detector for a plan and return its masks.
 *
 * Two detectors exist now and they answer different questions:
 *
 * - **Vector** (`vector-detect.ts`) reads the file's own objects and classifies them.
 *   Exact where it applies, and it is the only one that can tell a door from a wall.
 * - **Raster** (`wall-detect.ts`) thresholds pixels. The only option once a plan has
 *   been flattened to an image, and it stays the fallback even for SVG: a vector file
 *   this project's classifier finds no walls in is precisely the file the pixel path
 *   was written for.
 *
 * The choice is made **per plan, on evidence**, not on the file extension: an SVG
 * whose classification comes back empty falls through to the pixels rather than
 * producing an empty mask and leaving the user to wonder.
 *
 * This lives apart from both detectors so the sidebar, the file-drop path and the
 * Re-detect button all make the same decision — they were three call sites of
 * `detectWalls` before, with one of them (Re-detect) unable to tell an SVG from a
 * PNG because the underlay is a session blob URL by then.
 */

import { prepareSvgForDetection } from './boundary-detect.js';
import { detectWalls, isOcrUnavailable, type WallMask } from './wall-detect.js';
import type { ElementRole } from './vector-elements.js';
import {
	detectVectorFloorplan,
	type ReviewableElement,
	type VectorDetectionSummary
} from './vector-detect.js';

/**
 * Why the pixel detector ran, and not the vector reader.
 *
 * Reported rather than left implicit, because the two answers need different things
 * from the user: a raster plan cannot be read as objects at all — "read from pixels"
 * is the whole story, and the way forward is a better pixel detector — while a vector
 * plan the reader could not see is a drawing it got wrong, and an override or a
 * hand-edit may fix it. A sidebar that says nothing in either case is what makes a
 * wrong mask feel like the tool ignoring you.
 */
export type RasterReason =
	/** The file is not vector markup: a PNG, a JPEG, a screenshot. */
	| 'not-vector'
	/** It is vector markup, and the reader found nothing wall-shaped in it. */
	| 'no-walls-found'
	/** It is vector markup, and the reader threw on it. */
	| 'vector-failed'
	/** The user pressed the escape hatch. */
	| 'forced';

/** Which detector produced the masks, and what the vector one saw. */
export interface FloorplanDetection {
	/** The drawing, rendered — the input the boundary pass expects. */
	image: HTMLImageElement;
	wallMask: WallMask | null;
	materialMask: WallMask | null;
	via: 'vector' | 'raster';
	/** Present only when `via === 'vector'`. */
	summary: VectorDetectionSummary | null;
	/** Present only when `via === 'vector'`; everything the review panel needs. */
	elements: ReviewableElement[] | null;
	/** The markup the vector reader was given, kept so an override can re-read it. */
	source: string | null;
	/** Present only when `via === 'raster'`: why the reader did not run. */
	rasterReason: RasterReason | null;
	/**
	 * Present only on a raster path that wanted OCR: the text model could not be loaded,
	 * so room labels are in the mask as walls.
	 */
	textMaskingFailed: boolean;
}

/**
 * Detect the masks for the plan at `url`.
 *
 * `targetWidth` is the working resolution both detectors rasterise to, so the masks
 * they return are interchangeable. `forceRaster` skips the vector reader entirely,
 * which is the escape hatch the sidebar offers when it has classified a plan wrongly
 * — the pixel path draws every drawn line, which is a worse map but never a wrong
 * one. `overrides` carries the reader's per-element corrections.
 */
export async function detectFloorplanMasks(
	url: string,
	targetWidth: number,
	options: {
		forceRaster?: boolean;
		overrides?: ReadonlyMap<number, ElementRole>;
	} = {}
): Promise<FloorplanDetection> {
	const markup = await fetchText(url);
	const isSvgMarkup = markup.trim().startsWith('<') && markup.includes('<svg');
	let reason: RasterReason = 'not-vector';
	if (isSvgMarkup) {
		reason = options.forceRaster ? 'forced' : 'no-walls-found';
	}

	if (isSvgMarkup && !options.forceRaster) {
		try {
			const vector = await detectVectorFloorplan(markup, targetWidth, options.overrides);
			if (vector) {
				return {
					// The boundary pass gets the same image it always has: the drawing at its
					// own intrinsic size, text stripped. Not the vector reader's own render,
					// which is 800 px wide and has the fills removed — `detectBoundary`
					// derives its working scale from `naturalWidth` and its caller then scales
					// the polygon by `targetWidth / naturalWidth`, so a render at target width
					// halves the polygon, and removing the fills lost the outline entirely on
					// `office-300sqm.svg`.
					image: await prepareSvgForDetection(url),
					wallMask: vector.wallMask,
					materialMask: vector.materialMask,
					via: 'vector',
					summary: vector.summary,
					elements: vector.elements,
					source: markup,
					rasterReason: null,
					textMaskingFailed: false
				};
			}
		} catch (e) {
			// A malformed or exotic SVG: fall through to the pixels rather than failing
			// the import. The user still gets walls, and the reason says which of the two
			// it was.
			reason = 'vector-failed';
			console.warn('[detect] vector detection failed, using pixels:', e);
		}
	}

	const image = await prepareSvgForDetection(url);
	// OCR is for plans whose text is drawn pixels. An SVG's is either `<text>` (which
	// `prepareSvgForDetection` strips, so OCR would find nothing) or outlines, where
	// OCR damages the walls — measured at 90.6 % of wall pixels landing on ink without
	// it and 0 % with it.
	const wallMask = await detectWalls(image, targetWidth, { skipOcr: isSvgMarkup });
	return {
		image,
		wallMask,
		materialMask: null,
		via: 'raster',
		summary: null,
		elements: null,
		source: null,
		rasterReason: reason,
		// Only meaningful when OCR was asked for: it loads its model from the network, and
		// when that fails the text-masking step is skipped in silence and the room labels
		// stay in the mask as walls. Reported so the sidebar can say exactly that.
		textMaskingFailed: !isSvgMarkup && isOcrUnavailable()
	};
}

/** The file's text, or empty when it cannot be read as text (a PNG, a dead blob URL). */
async function fetchText(url: string): Promise<string> {
	try {
		const response = await fetch(url);
		const type = response.headers.get('content-type') ?? '';
		// A raster under a text-ish content type would decode to megabytes of mojibake;
		// the length guard keeps a truncated read cheap.
		if (type.startsWith('image/') && !type.includes('svg')) return '';
		const text = await response.text();
		return text.length > 8_000_000 ? '' : text;
	} catch {
		return '';
	}
}
