/**
 * The canvas keyboard map.
 *
 * It used to live in `CanvasView`, which is where every handler it could reach happened to
 * be: the result was a 185-line `if`/`else` chain in the middle of a component that already
 * had forty effects, and no way to read the shortcut table without reading the view.
 *
 * Four things only the view can do are handed in as `hooks`; everything else is state that
 * a keyboard shortcut has as much right to touch as a click does. The **order** of the
 * branches is part of the behaviour and is preserved:
 *
 * 1. undo/redo, before any mode can consume the key (a tool must not own Ctrl+Z);
 * 2. mode exits (Escape) and mode-specific keys;
 * 3. deleting the selected object (wall/column, surface, AP), most specific first;
 * 4. global keys (Ctrl+S, layer toggles).
 */
import { removeAps } from '$state/ap-state.svelte.js';
import {
	appState,
	setApPlaceMode,
	setCalibrateMode,
	setFloorAlignMode,
	setPlanningDrawMode,
	setSurfaceMode
} from '$state/app.svelte.js';
import { canvasState, clearSelection } from '$state/canvas.svelte.js';
import { canvasEngineRef } from '$state/canvas.svelte.js';
import { floorState } from '$state/floor-state.svelte.js';
import { pushState, redo, undo } from '$state/history.svelte.js';
import { updateCoverage } from '$state/optimizer.svelte.js';
import { saveNow, scheduleSave } from '$state/persistence.svelte.js';

/** The four gestures the view owns, because they touch its layers. */
export interface ShortcutHooks {
	/** Leave the wall tool (and clear its draft selection). */
	stopWallMode(): void;
	/** Close the planning-area draft, if it has three corners. */
	commitPlanningDraft(): void;
	/** Abandon a floor-alignment drag in progress. */
	cancelAlignDrag(): void;
	/** Re-derive the mask from the floor's wall segments. */
	syncVectorWallsToMask(forceEmpty?: boolean): void;
}

/** Handle one keydown for the canvas. */
export function handleShortcut(e: KeyboardEvent, hooks: ShortcutHooks): void {
	const target = e.target as HTMLElement;
	const isInput =
		target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
	const mod = e.metaKey || e.ctrlKey;
	const markDirty = () => canvasEngineRef.engine?.markDirty();

	/*
	 * Undo and redo first, in every mode.
	 *
	 * They used to sit below the mode-specific branches, and a mode that consumed the key
	 * first won: with the wall tool open, Ctrl+Z did nothing, and the workaround was to press
	 * Done and then undo. Undo is a property of the project, not of the tool that happens to
	 * be open, so it is handled before anything looks at the key for its own purposes.
	 */
	if (mod && (e.key === 'z' || e.key === 'Z')) {
		e.preventDefault();
		if (e.shiftKey) redo();
		else undo();
		// An undo changes the project, so it has to be written like any other edit —
		// otherwise the storage still holds the state that was undone and the next reload
		// brings it back.
		scheduleSave();
		markDirty();
		return;
	}

	if (!isInput && appState.wallVectorMode && e.key === 'Escape') {
		hooks.stopWallMode();
		return;
	}

	if (
		!isInput &&
		(appState.wallVectorSelected || appState.wallColumnSelected) &&
		(e.key === 'Delete' || e.key === 'Backspace')
	) {
		// A selected segment or column is a selected object: the same key that deletes an
		// access point deletes it, and it must be consumed before the AP branch below.
		const floor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
		const wallSelected =
			!!appState.wallVectorSelected &&
			!!floor?.walls?.some((wall) => wall.id === appState.wallVectorSelected);
		const columnSelected =
			!!appState.wallColumnSelected &&
			!!floor?.columns?.some((column) => column.id === appState.wallColumnSelected);
		if (wallSelected || columnSelected) {
			e.preventDefault();
			pushState();
			if (wallSelected) {
				floor!.walls = (floor!.walls ?? []).filter(
					(wall) => wall.id !== appState.wallVectorSelected
				);
				appState.wallVectorSelected = null;
			} else {
				floor!.columns = (floor!.columns ?? []).filter(
					(column) => column.id !== appState.wallColumnSelected
				);
				appState.wallColumnSelected = null;
			}
			// The last obstruction on the floor: the mask has to be emptied with it, in the
			// frame it already has, or the model keeps charging a wall that no longer exists.
			const segmentsLeft = (floor!.walls ?? []).length + (floor!.columns ?? []).length === 0;
			if (segmentsLeft) hooks.syncVectorWallsToMask(true);
			scheduleSave();
			markDirty();
			return;
		}
	}

	if (!isInput && appState.planningDrawMode && e.key === 'Enter') {
		hooks.commitPlanningDraft();
		return;
	}

	if (!isInput && appState.planningDrawMode && (e.key === 'Backspace' || e.key === 'Delete')) {
		// Before the AP delete below: in this mode Backspace means "that corner was
		// wrong", which is the correction the user reaches for most often.
		e.preventDefault();
		if (appState.planningDraft.length > 0) {
			appState.planningDraft = appState.planningDraft.slice(0, -1);
			// Undoing a corner reopens a loop that was closed on its first corner.
			appState.planningDraftClosed = false;
		}
		return;
	}

	if (!isInput && e.key === 'Escape' && appState.planningDrawMode) {
		// Abandoning the loop: an unfinished outline is not a statement about the floor.
		setPlanningDrawMode(false);
		return;
	}

	if (!isInput && e.key === 'Escape' && appState.surfaceMode) {
		// A half-drawn rectangle is not a surface; leaving the mode drops it.
		setSurfaceMode(false);
		return;
	}

	if (!isInput && appState.surfaceSelected && (e.key === 'Delete' || e.key === 'Backspace')) {
		// A selected surface is a selected object, like a wall and like an AP.
		const floor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
		if (floor?.surfaces?.some((surface) => surface.id === appState.surfaceSelected)) {
			e.preventDefault();
			pushState();
			floor.surfaces = (floor.surfaces ?? []).filter(
				(surface) => surface.id !== appState.surfaceSelected
			);
			appState.surfaceSelected = null;
			void updateCoverage();
			markDirty();
			scheduleSave();
			return;
		}
	}

	if (!isInput && e.key === 'Escape' && appState.calibrateMode) {
		// The measured line belongs to the mode, so leaving the mode drops it; the
		// sidebar keeps the typed distance but not a line to apply it to.
		setCalibrateMode(false);
		return;
	}

	if (!isInput && e.key === 'Escape' && appState.floorAlignMode) {
		// Escape is the conventional way out of a mode, and leaving it to the
		// sidebar toggle alone makes a mode that looks stuck.
		hooks.cancelAlignDrag();
		setFloorAlignMode(false);
		return;
	}

	if (!isInput && e.key === 'Escape' && appState.apPlaceMode) {
		// Same reasoning: a mode that owns the canvas has to be escapable without
		// reaching for the sidebar.
		setApPlaceMode(false);
		return;
	}

	if (mod && (e.key === 's' || e.key === 'S')) {
		// The browser's own save dialog has nothing to do with a project: intercept it,
		// write the project to the app's store, and answer visibly. Autosave is silent
		// by design, but a key the user pressed has to say something.
		e.preventDefault();
		void saveNow();
		return;
	}

	if (e.key === 'Delete' || e.key === 'Backspace') {
		if (canvasState.selectedApIds.length > 0) {
			e.preventDefault();
			removeAps([...canvasState.selectedApIds]);
			clearSelection();
		}
	}

	if (isInput || mod) return;

	switch (e.key) {
		case 'g':
		case 'G':
			appState.showGrid = !appState.showGrid;
			break;
		case 'w':
		case 'W':
			appState.showWalls = !appState.showWalls;
			break;
		case 'h':
		case 'H':
			appState.showHeatmap = !appState.showHeatmap;
			break;
	}
}
