import type { CanvasEngine } from '$canvas/engine.js';

/**
 * 当前挂载在视图里的画布引擎。
 */
export const canvasEngineRef = $state({ engine: null as CanvasEngine | null });

export const canvasState = $state({
	zoom: 1,
	selectedApIds: [] as string[],
	hoveredApId: null as string | null,
	isDragging: false,
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
