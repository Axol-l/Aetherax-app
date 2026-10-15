import type { CanvasEngine } from '$canvas/engine.js';

/**
 * The live canvas engine, once a view has mounted one.
 *
 * The components outside the canvas — the toolbar and the status bar — have to act on
 * it ("redraw now", "fit the plan", "export this frame"), and importing the canvas view
 * would be an import cycle. This used to be a module-level `let` with `set`/`get`
 * helpers in `canvas/engine-ref.ts`; a store does the same job in the state layer the
 * rest of the app already reads, and a reader that mounts before the canvas exists is
 * notified when it arrives instead of quietly holding `null` forever.
 *
 * Null is legitimate rather than an error: there is no engine until a floorplan view is
 * on screen, so callers check.
 */
export const canvasEngineRef = $state({ engine: null as CanvasEngine | null });

export const canvasState = $state({
	zoom: 1,
	selectedApIds: [] as string[],
	hoveredApId: null as string | null,
	isDragging: false,
	/**
	 * A world-space rectangle to draw over the plan, or null.
	 *
	 * Set by the vector review panel when the user points at an element, so "this row"
	 * has a location on the drawing. It is a rectangle rather than the element itself
	 * because the classifier works from bounding boxes, and a box is what a reviewer
	 * needs to see to answer "is that curve a door or a stair rail".
	 *
	 * A fresh object on every change, so the canvas effect that watches it can compare
	 * by identity rather than by value.
	 */
	reviewHighlight: null as { x: number; y: number; w: number; h: number } | null
});

export function selectAp(id: string, addToSelection = false): void {
	if (addToSelection) {
		if (canvasState.selectedApIds.includes(id)) {
			canvasState.selectedApIds = canvasState.selectedApIds.filter((i) => i !== id);
		} else {
			canvasState.selectedApIds = [...canvasState.selectedApIds, id];
		}
	} else {
		canvasState.selectedApIds = [id];
	}
}

export function selectAps(ids: string[]): void {
	canvasState.selectedApIds = ids;
}

export function clearSelection(): void {
	canvasState.selectedApIds = [];
}

export function isSelected(id: string): boolean {
	return canvasState.selectedApIds.includes(id);
}
