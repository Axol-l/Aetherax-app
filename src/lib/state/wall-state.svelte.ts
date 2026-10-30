import type { WallMaterialId } from '$canvas/materials.js';
import type { RasterReason } from '$canvas/detect-floorplan.js';
import type { ElementRole } from '$canvas/vector-elements.js';
import type { ReviewableElement, VectorDetectionSummary } from '$canvas/vector-detect.js';
import { currentFloor, type Floor } from './floor-state.svelte.js';

export interface WallMaskData {
	dataUrl: string;
	width: number;
	height: number;
	originX: number;
	originY: number;
}

/**
 * What the vector detector made of the current plan, and what the user has since said
 * about it.
 *
 * Session state, not project state: it describes one detection run, and a plan reloaded
 * from storage has masks but no memory of how they were made. Counts are of *elements*,
 * not pixels — that is the useful quantity for "did it find my doors".
 *
 * It holds the **source markup** as well as the result because an override has to be
 * answered by re-reading the drawing: the classifier's verdict for one element cannot be
 * undone in the mask it produced, and an element the reader called a fixture is not in
 * the mask at all. The markup is a string in memory for the life of the session; the
 * blob URL it came from may be revoked by then.
 */
export interface VectorReview {
	summary: VectorDetectionSummary;
	/** Every element the reader looked at, in the drawing's order. */
	elements: ReviewableElement[];
	/** Overrides the user has made, by element id. */
	overrides: Map<number, ElementRole>;
	/** The drawing, as it was handed to the reader. */
	source: string;
	/** The working width the masks are rasterised at. */
	targetWidth: number;
}

/**
 * The session-only wall state: what a detection made of the plan, and how it failed.
 *
 * None of this belongs to a floor — a plan reloaded from storage has masks but no memory of
 * the run that produced them — so it is the only thing `wallState` still stores.
 */
const session = $state({
	vectorReview: null as VectorReview | null,
	/**
	 * Why the pixel detector ran, when it did.
	 *
	 * The sidebar reports it. A mask that came from thresholds and a mask that came from
	 * reading the drawing's own objects are different claims about the same plan, and the
	 * user is the only one who can say which is wrong — but only if they are told which
	 * one they are looking at.
	 */
	rasterReason: null as RasterReason | null,
	/**
	 * Set when the pixel path could not load its text model.
	 *
	 * This is the difference between a usable mask and a mess on any raster plan: OCR is
	 * what removes the room labels before thresholding, and without it every word becomes
	 * a barrier. The failure is a network fetch, so it comes and goes — which is exactly
	 * why it has to be said out loud rather than left to look like a bad detector.
	 */
	textMaskingFailed: false
});

/**
 * The current floor's wall data, read and written through the floor itself.
 *
 * These used to be a second copy of five `Floor` fields, kept in step by hand: save,
 * restore, floor switch, undo and import each copied all nine `wallState`/`floorplanState`
 * fields in both directions, and a missed copy showed up as a mask from the wrong floor.
 * The copy is gone — each getter reads the current floor and each setter writes it — so
 * there is one owner and no synchronisation to forget.
 *
 * Reading through a getter stays reactive: the getter reads `$state` inside the effect that
 * called it, which is exactly what a plain property read did. Writing assigns a new object
 * to `floor.wallMask`, which is the rule `mask-registry.ts` documents for cache keys.
 */
export const wallState = {
	get wallMask(): Floor['wallMask'] {
		return currentFloor().wallMask;
	},
	set wallMask(mask: Floor['wallMask']) {
		currentFloor().wallMask = mask;
	},

	get wallAttenuation(): number {
		return currentFloor().wallAttenuation;
	},
	set wallAttenuation(db: number) {
		currentFloor().wallAttenuation = db;
	},

	get wallMaterial(): WallMaterialId {
		return currentFloor().wallMaterial;
	},
	set wallMaterial(material: WallMaterialId) {
		currentFloor().wallMaterial = material;
	},

	get materialMask(): Floor['materialMask'] {
		return currentFloor().materialMask;
	},
	set materialMask(mask: Floor['materialMask']) {
		currentFloor().materialMask = mask;
	},

	get roomTypeMask(): Floor['roomTypeMask'] {
		return currentFloor().roomTypeMask;
	},
	set roomTypeMask(mask: Floor['roomTypeMask']) {
		currentFloor().roomTypeMask = mask;
	},

	get vectorReview(): VectorReview | null {
		return session.vectorReview;
	},
	set vectorReview(review: VectorReview | null) {
		session.vectorReview = review;
	},

	get rasterReason(): RasterReason | null {
		return session.rasterReason;
	},
	set rasterReason(reason: RasterReason | null) {
		session.rasterReason = reason;
	},

	get textMaskingFailed(): boolean {
		return session.textMaskingFailed;
	},
	set textMaskingFailed(failed: boolean) {
		session.textMaskingFailed = failed;
	}
};
