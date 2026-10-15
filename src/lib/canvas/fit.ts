import { appState } from '$state/app.svelte';
import { floorState } from '$state/floor-state.svelte';
import { projectState } from '$state/project.svelte';
import { wallState } from '$state/wall-state.svelte';
import type { CanvasEngine } from '$canvas/engine.js';

/**
 * Frame the canvas on what the active view is actually showing.
 *
 * One implementation, because three callers ask the same question: the Fit button, the
 * floor-view switch, and the PDF export. The export is why this is a module rather than a
 * function inside `StatusBar` — a report that captures the canvas at whatever zoom and pan
 * the user happened to leave it at is a report of the user's screen, not of the plan.
 *
 * The overviews hide the floorplan layer and lay the storeys out in their own frame, so
 * the layout is asked for its bounds rather than the layers that are not being drawn.
 *
 * @param includeAps Union every access point into the framed bounds. The report wants
 *   this: an AP the optimiser put somewhere unexpected is exactly what a reader needs to
 *   see, and cropping it out of the page would hide it. The Fit button leaves it off so
 *   one stray AP cannot zoom the plan down to a postage stamp.
 * @returns False when there was nothing to frame, so the caller can decide what to do.
 */
export function fitCanvasToContent(engine: CanvasEngine, includeAps = false): boolean {
	const rect = engine.canvas.getBoundingClientRect();

	if (appState.floorView !== 'single') {
		const id = appState.floorView === 'stacked' ? 'stacked-floors' : 'floor-tiles';
		const overview = engine.layers.find((l) => l.id === id) as
			| { contentBounds?: () => Array<{ x: number; y: number }> }
			| undefined;
		const bounds = overview?.contentBounds?.() ?? [];
		if (bounds.length > 0) {
			engine.camera.fitToBounds(bounds, rect.width, rect.height);
			engine.markDirty();
			return true;
		}
	}

	const points: Array<{ x: number; y: number }> = [];

	// Priority 1: floorplan image bounds, at the offset this floor's underlay is drawn
	// with. Reading only the image size framed an aligned floor as if it sat at the
	// origin, which is where the plan is drawn only when its offset is zero.
	const fp = engine.layers.find((l) => l.id === 'floorplan') as
		| { imageWidth?: number; imageHeight?: number; offsetX?: number; offsetY?: number }
		| undefined;
	if (fp && fp.imageWidth && fp.imageWidth > 0) {
		const ox = fp.offsetX ?? 0;
		const oy = fp.offsetY ?? 0;
		points.push({ x: ox, y: oy });
		points.push({ x: ox + fp.imageWidth, y: oy + (fp.imageHeight ?? 0) });
	} else if (wallState.wallMask) {
		// Priority 2: wall mask bounds (draw-from-scratch)
		const ox = wallState.wallMask.originX ?? 0;
		const oy = wallState.wallMask.originY ?? 0;
		points.push({ x: ox, y: oy });
		points.push({ x: ox + wallState.wallMask.width, y: oy + wallState.wallMask.height });
	}

	// If no floorplan/walls, fit to AP centers (no radius inflation)
	if (points.length === 0 || includeAps) {
		for (const ap of projectState.aps) {
			if (appState.floorView === 'single' && ap.floorId !== floorState.currentFloorId) continue;
			points.push({ x: ap.x, y: ap.y });
		}
	}

	if (points.length === 0) return false;

	engine.camera.fitToBounds(points, rect.width, rect.height);
	engine.markDirty();
	return true;
}
