
import { floorplanState } from '$state/floorplan-state.svelte.js';
import { floorState } from '$state/floor-state.svelte.js';
import { wallState } from '$state/wall-state.svelte.js';
import { scheduleSave } from '$state/persistence.svelte.js';
import { traceFloorWalls } from '$state/wall-trace.js';
import { detectBoundary } from '$canvas/boundary-detect.js';
import { detectFloorplanMasks } from '$canvas/detect-floorplan.js';

const FLOORPLAN_TARGET_WIDTH = 800;

/**
 * Import a floorplan file, run boundary + wall detection, and update project state.
 * Called from both the sidebar drop zone and the canvas drop target.
 */
export async function importFloorplanFile(file: File): Promise<void> {
	const validTypes = ['image/png', 'image/jpeg', 'image/svg+xml'];
	if (!validTypes.includes(file.type)) {
		// Silence here was the worst possible answer: a PDF floorplan is the most common
		// thing to drop on a planner and the drop simply did nothing.
		floorplanState.importNotice =
			file.type === 'application/pdf'
				? 'PDF plans are not supported yet — export the page as a PNG and drop that.'
				: 'That file type is not supported — use a PNG, JPEG or SVG.';
		return;
	}
	floorplanState.importNotice = null;

	const blobUrl = URL.createObjectURL(file);
	floorplanState.floorplanUrl = blobUrl;
	floorplanState.sourceIsVector = file.type === 'image/svg+xml';

	try {
		// Which detector runs is decided on the file's content, not its extension.
		const detection = await detectFloorplanMasks(blobUrl, FLOORPLAN_TARGET_WIDTH);
		const { image, wallMask, materialMask } = detection;

		// Boundary detection
		const result = detectBoundary(image);
		if (result && result.polygon.length >= 3) {
			const scaleFactor = FLOORPLAN_TARGET_WIDTH / image.naturalWidth;
			floorplanState.floorplanBoundary = result.polygon.map((p) => ({
				x: p.x * scaleFactor,
				y: p.y * scaleFactor
			}));
			// Area for calibration (stored but not auto-applied without user input)
		}

		if (wallMask) {
			wallState.wallMask = wallMask;
			// A vector detection knows what each opening is; a raster one cannot, so it
			// leaves the material map alone rather than half-filling it.
			if (materialMask) wallState.materialMask = materialMask;
			/*
			 * Trace the mask into the segments the drawing actually shows.
			 *
			 * Walls are segments, and this import path sets the mask directly, so without this
			 * an imported plan arrived as a raster band that could not be edited — the mask was
			 * there, the model had no walls, and the vector layer (which paints segments) had
			 * nothing to paint. Re-detect traced; the import did not.
			 */
			const floor = floorState.floors.find((candidate) => candidate.id === floorState.currentFloorId);
			if (floor) {
				floor.walls = [];
				floor.columns = [];
				await traceFloorWalls(floor.id);
			}
		}
		// What the vector reader saw, for the review panel. Cleared by a raster run so a
		// stale report cannot describe a mask that has since been replaced.
		const { summary, elements, source } = detection;
		wallState.vectorReview =
			detection.via === 'vector' && summary && elements && source
				? {
						summary,
						elements,
						overrides: new Map(),
						source,
						targetWidth: FLOORPLAN_TARGET_WIDTH
					}
				: null;

		scheduleSave();
	} catch (e) {
		console.warn('Floorplan detection failed:', e);
	}
}
