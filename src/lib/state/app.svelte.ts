export type SidebarPanel = 'floorplan' | 'aps';
export type FloorView = 'single' | 'tiled' | 'stacked';

/**
 * Limits of the stacked view's angles, in degrees.
 *
 * Shared by the panel's sliders and the canvas drag so the two cannot drift: the
 * sliders' range *is* the drag's clamp, which is what lets a drag stop at the limit
 * instead of winding up slack behind it. Yaw is clamped at ±180 rather than allowed
 * to run on, because ±180 is the same orientation and a value outside the slider's
 * range would leave the control unable to show where the view is.
 */
export const STACK_YAW_LIMIT_DEG = 180;
export const STACK_MIN_PITCH_DEG = 5;
export const STACK_MAX_PITCH_DEG = 75;
export type WallEditMode = 'erase' | 'draw' | 'line' | 'rect' | 'arc' | 'material' | null;

export const appState = $state({
	/**
	 * Why the last click on the canvas did not place anything, if it did not.
	 *
	 * Rendered in the corner notice. Transient by nature: it belongs to one click, and
	 * the next successful placement clears it.
	 */
	placementNotice: null as string | null,
	/**
	 * Why the project could not be written to the browser's storage, if it could not.
	 *
	 * Its own slot, and the most important of the three: the other two are about the plan
	 * being wrong, this one is about work being lost. The save path used to swallow the
	 * failure — a quota of about five megabytes with a PNG mask per floor is easy to
	 * reach — so the first sign of trouble was a project that came back short after a
	 * reload.
	 */
	storageNotice: null as string | null,
	/**
	 * The acknowledgment of a save the user asked for, briefly.
	 *
	 * Autosave is silent by design — the work is saved two seconds after an edit and the
	 * status bar carries the timestamp — but a save the user *asked* for has to answer, or
	 * the shortcut and the menu item both look broken. Cleared by `saveNow`'s own timer.
	 */
	savedNotice: null as string | null,
	/**
	 * The standing warning about access points that sit outside the building, if any.
	 *
	 * Kept in a slot of its own rather than sharing `placementNotice`, because the two
	 * are written by different things at different times: this one is recomputed
	 * whenever walls or access points move, and while it shared the slot every such
	 * recomputation wiped a refusal the user had just been shown.
	 */
	outsideNotice: null as string | null,
	sidebarPanel: 'floorplan' as SidebarPanel,
	sidebarOpen: true,
	showGrid: true,
	showLabels: true,
	showHeatmap: false,
	/** Notes left on the plan: pins anyone can read, in the layer switch like any other. */
	showNotes: true,
	/**
	 * Note editing: a click on the plan drops a note.
	 *
	 * A mode rather than a modifier key, because the canvas already uses ctrl/cmd for
	 * selection and alt for panning, and because leaving it on by accident would litter a
	 * plan with notes.
	 */
	noteMode: false,
	/** The note under the pointer, for the hover bubble. */
	noteHoverId: null as string | null,
	/** The note being edited, if any. */
	noteSelectedId: null as string | null,
	showFloorplan: true,
	showAPs: true,
	showWalls: true,
	showRoomLabels: true,
	/** Ghost of the floor below, for checking that two floors line up. */
	showFloorBelow: false,
	/**
	 * Drag on the canvas moves the whole current floor instead of panning or
	 * selecting. Used to bring one floor onto another.
	 */
	floorAlignMode: false,
	/** Picking two points on the plan to calibrate the scale from a measured line. */
	calibrateMode: false,
	/**
	 * Drawing the planning area: a click adds a vertex, Enter closes it.
	 *
	 * A mode like the others, and exclusive with them, because it owns the bare-canvas
	 * click. The draft lives here rather than in the canvas so the sidebar can show what is
	 * being drawn and offer to finish it.
	 */
	planningDrawMode: false,
	planningDraft: [] as Array<{ x: number; y: number }>,
	/** The clicks collected so far while calibrating, in world coordinates. */
	calibrationPoints: [] as Array<{ x: number; y: number }>,
	/**
	 * A click on empty canvas adds an access point.
	 *
	 * Off by default: with it on, the canvas is in "add" mode all the time, so a
	 * click meant to deselect, or a drag meant to pan, leaves a stray AP behind.
	 * Selecting and dragging APs is unaffected — this only decides what a click on
	 * *nothing* does.
	 */
	apPlaceMode: false,
	/**
	 * `single` draws the current floor on its own, `tiled` draws a read-only card
	 * per floor side by side, and `stacked` draws the same cards stacked by their
	 * real elevation in an oblique projection. Both overviews hide the editing
	 * layers rather than trying to run the wall editor and the heatmap once per
	 * floor; `stacked` is the one that answers "how do the storeys line up".
	 */
	floorView: 'single' as FloorView,
	/**
	 * Where the stacked overview is being looked at from.
	 *
	 * `stackYaw` spins the building about its vertical axis and `stackPitch` tilts
	 * down onto the floors; the two together are the whole viewpoint. Pitching is
	 * also what separates the storeys on screen (`z·sin(pitch)`), which is why the
	 * default looks down at 40° rather than straight down — from straight above, a
	 * stack is indistinguishable from one floor. `stackSpread` multiplies the storey
	 * spacing *on screen only*, so a stack can be pulled apart to see into it without
	 * touching the geometry the RF model reads. View settings, not project settings:
	 * they change nothing about the plan, so they are not persisted.
	 */
	stackYaw: 0,
	stackPitch: 40,
	stackSpread: 1,
	/** Draw only the current floor and the one either side of it. */
	stackFocus: false,
	wallEditMode: null as WallEditMode,
	wallEditLastMode: 'erase' as Exclude<WallEditMode, null>,
	wallBrushSize: 15
});

/** True when alignment mode is what switched the ghost on, so it can undo it. */
let alignOwnsGhost = false;

/**
 * Enter or leave floor-alignment mode.
 *
 * Owns the ghost as well as the mode. The ghost is the only way to see what you
 * are aligning to, so entering the mode switches it on; leaving switches it back
 * off — unless the user had already turned it on for their own reasons, in which
 * case it is left alone.
 *
 * This lives here rather than in the sidebar because the mode can also be left
 * with Escape or a right-click on the canvas, and every exit path has to put the
 * ghost back. Having only the sidebar know about it was the bug: the mode closed
 * and the ghost of the floor below stayed on the canvas with nothing to explain
 * it.
 */
export function setFloorAlignMode(on: boolean): void {
	if (appState.floorAlignMode === on) return;
	appState.floorAlignMode = on;
	if (on) {
		// Both modes own what a bare canvas drag does, so they cannot both be on.
		appState.apPlaceMode = false;
		alignOwnsGhost = !appState.showFloorBelow;
		appState.showFloorBelow = true;
	} else if (alignOwnsGhost) {
		appState.showFloorBelow = false;
		alignOwnsGhost = false;
	}
}

/**
 * Turn AP placement on or off.
 *
 * A mode rather than a permanent state of the canvas: while it is on, a click on
 * empty canvas creates an AP and nothing else uses that gesture. Leaving it on by
 * default meant every stray click — deselecting, starting a marquee, fumbling a
 * pan — dropped an AP on the plan.
 *
 * Exclusive with floor alignment, which also owns the bare-canvas drag.
 */
export function setApPlaceMode(on: boolean): void {
	if (appState.apPlaceMode === on) return;
	appState.apPlaceMode = on;
	if (on) setFloorAlignMode(false);
}

/**
 * Calibrating by measuring a line on the plan.
 *
 * The area route asks for the floorplan's total area and divides it into the outline the
 * detector found, which is only as good as that outline. Measuring asks something the user
 * can read off the drawing — this wall is twelve metres — and works on a plan whose
 * outline is open or which is a detail of one room.
 *
 * The mode owns the same bare-canvas click that placement mode does, so it is exclusive
 * with both other modes; the points live here rather than in the panel because the canvas
 * is what collects them and the panel is what consumes them.
 */
export function setCalibrateMode(on: boolean): void {
	if (appState.calibrateMode === on) return;
	appState.calibrateMode = on;
	appState.calibrationPoints = [];
	if (on) {
		setApPlaceMode(false);
		setFloorAlignMode(false);
	}
}

/**
 * Record a click while calibrating: the first point, then the second.
 *
 * A third click starts over rather than being ignored — the user's second point is
 * usually the one they got wrong, and having to leave the mode to correct it is worse than
 * losing the first point.
 */
export function addCalibrationPoint(point: { x: number; y: number }): void {
	if (appState.calibrationPoints.length >= 2) appState.calibrationPoints = [point];
	else appState.calibrationPoints = [...appState.calibrationPoints, point];
}

/**
 * Drawing the planning area, one click per corner.
 *
 * Exclusive with the other modes for the same reason they are exclusive with each other:
 * they all own the bare-canvas click, and two of them armed at once means one click does two
 * things. Leaving the mode throws the draft away — an abandoned loop is not a decision.
 */
export function setPlanningDrawMode(on: boolean): void {
	if (appState.planningDrawMode === on) return;
	appState.planningDrawMode = on;
	appState.planningDraft = [];
	if (on) {
		setApPlaceMode(false);
		setFloorAlignMode(false);
		setCalibrateMode(false);
	}
}

export function addPlanningPoint(point: { x: number; y: number }): void {
	appState.planningDraft = [...appState.planningDraft, point];
}
