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
import { detectWalls, type WallMask } from './wall-detect.js';
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
	/**
	 * The walls as geometry, when the vector reader could read them.
	 *
	 * Preferred over tracing the mask: exact, diagonals included, and each segment carries the
	 * material its role gives it. Empty or null means the mask is all there is, and the caller
	 * traces it as before.
	 */
	segments:
		| Array<{ ax: number; ay: number; bx: number; by: number; material: number }>
		| null;
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
		/**
		 * The plan is known to be a vector drawing, whatever the fetched bytes look like.
		 *
		 * Sniffing the content is right on import, where the file's own data is at hand,
		 * and unreliable on a *re-detect*: the underlay is a session blob URL by then, and
		 * a vector plan may have been handed to the image path on the way in, so its bytes
		 * are a PNG of a drawing that is still a drawing. `floorplanState.sourceIsVector`
		 * records what the file actually was, and this is how that record reaches here.
		 *
		 * A claim that turns out to be wrong is not a trap: the vector reader throws, the
		 * raster path takes over and `rasterReason` says why.
		 */
		assumeVector?: boolean;
	} = {}
): Promise<FloorplanDetection> {
	const markup = await fetchText(url);
	const isSvgMarkup =
		options.assumeVector ?? (markup.trim().startsWith('<') && markup.includes('<svg'));
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
					segments: vector.segments,
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
	/*
	 * No text masking on the default path.
	 *
	 * OCR existed to stop room labels being read as walls, and it loads its model from the
	 * network — a planner that runs on a laptop in a basement never got it, and the failure was
	 * silent. The tracing that now reads the mask keeps runs of a wall's length and drops the
	 * twenty-odd-pixel strokes that lettering makes, which is the same job done locally. The code
	 * is still there for a future "clean labels" pass; it is not on this path.
	 */
	const wallMask = await detectWalls(image, targetWidth, { skipOcr: true });
	return {
		image,
		wallMask,
		materialMask: null,
		via: 'raster',
		summary: null,
		elements: null,
		segments: null,
		source: null,
		rasterReason: reason,
		textMaskingFailed: false
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
