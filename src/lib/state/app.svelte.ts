import type { SurfaceKind, SurfaceMaterialId } from '$lib/rf/surface-height.js';
import type { ApMount } from './ap-state.svelte.js';

export type SidebarPanel = 'floorplan' | 'aps';
export type FloorView = 'single' | 'tiled' | 'stacked' | 'floor3d';

/**
 * The editing tool, if one is armed.
 *
 * One value, so two tools cannot be armed at once — they all own the same bare-canvas click,
 * and two of them armed means one click doing two things.
 */
export type ToolKind =
	| 'none'
	| 'wall'
	| 'note'
	| 'align'
	| 'calibrate'
	| 'planning'
	| 'surface'
	| 'place-ap';

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
	 * The editing tool, if one is armed.
	 *
	 * One field rather than seven booleans, because the seven are mutually exclusive by
	 * nature: every one of them owns the same bare-canvas click, so two armed at once means
	 * one click doing two things. That used to be maintained by hand — each setter cleared
	 * the ones written before it, which is O(n) per mode and easy to forget — and two of the
	 * modes were written straight into the state by the components that toggled them, so
	 * they were never in that scheme at all: the wall tool and note mode could be armed on
	 * top of the planning area, and were.
	 *
	 * The `*Mode` accessors below are views over this field. Every existing reader and
	 * writer keeps working, and none of them can bypass the exclusivity any more:
	 * `appState.noteMode = true` *is* `setTool('note')`.
	 */
	tool: 'none' as ToolKind,

	/**
	 * Drawing walls as line segments.
	 *
	 * Its own tool, next to the raster brush, because the two are different models of the
	 * same thing and a plan should be drawn in one of them at a time. The first click of a
	 * wall lands in `wallVectorDraft`; the second commits the segment.
	 */
	get wallVectorMode(): boolean {
		return this.tool === 'wall';
	},
	set wallVectorMode(on: boolean) {
		if (on) setTool('wall');
		else if (this.tool === 'wall') setTool('none');
	},
	/**
	 * Which shape the wall tool draws: a line, a rectangular pier, or a round column.
	 *
	 * One mode with three tools rather than three modes: they share the gesture (two clicks),
	 * the material, and the layer, so switching between them must not drop the wall tool —
	 * a plan is drawn by alternating partition walls and the piers that break them.
	 */
	wallTool: 'line' as 'line' | 'rect' | 'circle' | 'eraser',
	/** The pier or column being drawn, as two opposite corners. */
	columnDraft: null as { shape: 'rect' | 'circle'; ax: number; ay: number; bx: number; by: number } | null,
	/** The column under the pointer or just drawn, for the delete key. */
	wallColumnSelected: null as string | null,
	wallVectorDraft: null as { x: number; y: number } | null,
	/** The segment under the pointer or the one just drawn, for the delete key. */
	wallVectorSelected: null as string | null,
	/**
	 * What just happened to the walls, in the corner for a few seconds.
	 *
	 * Its own slot rather than sharing the placement refusal: tracing a detected plan is
	 * neither a refusal nor a save, and it happens as a side effect of pressing Draw wall.
	 */
	wallNotice: null as string | null,
	/**
	 * Note editing: a click on the plan drops a note.
	 *
	 * A tool rather than a modifier key, because the canvas already uses ctrl/cmd for
	 * selection and alt for panning, and because leaving it on by accident would litter a
	 * plan with notes.
	 */
	get noteMode(): boolean {
		return this.tool === 'note';
	},
	set noteMode(on: boolean) {
		if (on) setTool('note');
		else if (this.tool === 'note') setTool('none');
	},
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
	get floorAlignMode(): boolean {
		return this.tool === 'align';
	},
	set floorAlignMode(on: boolean) {
		if (on) setTool('align');
		else if (this.tool === 'align') setTool('none');
	},
	/** Picking two points on the plan to calibrate the scale from a measured line. */
	get calibrateMode(): boolean {
		return this.tool === 'calibrate';
	},
	set calibrateMode(on: boolean) {
		if (on) setTool('calibrate');
		else if (this.tool === 'calibrate') setTool('none');
	},
	/**
	 * Drawing the planning area: a click adds a vertex, Enter closes it.
	 *
	 * Its own tool because it owns the bare-canvas click. The draft lives here rather than
	 * in the canvas so the sidebar can show what is being drawn and offer to finish it.
	 */
	get planningDrawMode(): boolean {
		return this.tool === 'planning';
	},
	set planningDrawMode(on: boolean) {
		if (on) setTool('planning');
		else if (this.tool === 'planning') setTool('none');
	},
	planningDraft: [] as Array<{ x: number; y: number }>,
	/**
	 * The draft loop has been closed on its first corner, but not confirmed yet.
	 *
	 * Clicking the first corner is a statement about the *shape*, not about the floor: the
	 * bar stays up with the green confirm so the area can still be undone or cancelled
	 * before it replaces the floor's area.
	 */
	planningDraftClosed: false,
	/**
	 * Drawing a raised surface: a mezzanine, a stair, a ramp.
	 *
	 * Two clicks, like a wall and unlike the planning area: a surface is a rectangle, and
	 * the height belongs to the end of it rather than to each corner. The kind and the two
	 * heights live here too, so the sidebar's controls and the canvas preview cannot
	 * disagree about what is about to be drawn.
	 */
	get surfaceMode(): boolean {
		return this.tool === 'surface';
	},
	set surfaceMode(on: boolean) {
		if (on) setTool('surface');
		else if (this.tool === 'surface') setTool('none');
	},
	surfaceDraft: null as { ax: number; ay: number; bx: number; by: number } | null,
	surfaceKind: 'platform' as SurfaceKind,
	/**
	 * The deck material picked for the next raised surface, or null for "type the loss".
	 *
	 * A preset for `surfaceAttenuationDb`, not a second source of truth: choosing one
	 * writes its figure into the field, and clearing back to null leaves whatever was typed.
	 */
	surfaceMaterial: null as SurfaceMaterialId | null,
	/** Height of the walking surface at the low end, metres above the floor's own. */
	surfaceHeightM: 2,
	/** Height at the high end, metres. A platform keeps this equal to `surfaceHeightM`. */
	surfaceTopHeightM: 2,
	/** Loss through the deck, dB: what a path from below pays for crossing it. */
	surfaceAttenuationDb: 15,
	/** The deck's own thickness, metres. 3D, and whether a path passes *through* it. */
	surfaceThicknessM: 0.2,
	/** Whether the volume under the deck is filled to the floor, in the 3D view. */
	surfaceSolidBase: false,
	/** The surface under the pointer or just drawn, for the delete key. */
	surfaceSelected: null as string | null,
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
	get apPlaceMode(): boolean {
		return this.tool === 'place-ap';
	},
	set apPlaceMode(on: boolean) {
		if (on) setTool('place-ap');
		else if (this.tool === 'place-ap') setTool('none');
	},
	/**
	 * The mounting the next placed AP uses, when the toolbar has picked one.
	 *
	 * Null means "the last AP's mounting", which is the behaviour that existed before the
	 * placement toolbar: a floor is normally described with one kind of hardware, and
	 * re-picking a mounting for every AP is the repetition that makes the setting go
	 * unused. The toolbar sets this, and it stays set for the session so a run of wall
	 * mounts does not need re-picking either.
	 */
	apPlaceMount: null as ApMount | null,
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
	stackFocus: false
});

/** True when alignment mode is what switched the ghost on, so it can undo it. */
let alignOwnsGhost = false;

/**
 * Arm one tool, or none.
 *
 * The single place that decides what is armed, so exclusivity is a property of the type
 * rather than a list every setter has to repeat. It also owns the two things a tool can
 * drag along with it: floor alignment switches the ghost of the floor below on (it is the
 * only way to see what you are aligning to) and puts it back on the way out unless the user
 * had it on for their own reasons, and a tool that collects a draft drops it when the tool
 * changes — an abandoned loop or half-drawn rectangle is not a decision.
 */
export function setTool(tool: ToolKind): void {
	const current = appState.tool;
	if (current === tool) return;

	if (current === 'align' && alignOwnsGhost) {
		appState.showFloorBelow = false;
		alignOwnsGhost = false;
	}
	if (current === 'calibrate') appState.calibrationPoints = [];
	if (current === 'planning') {
		appState.planningDraft = [];
		appState.planningDraftClosed = false;
	}
	if (current === 'surface') appState.surfaceDraft = null;

	appState.tool = tool;

	if (tool === 'align') {
		alignOwnsGhost = !appState.showFloorBelow;
		appState.showFloorBelow = true;
	}
	if (tool === 'calibrate') appState.calibrationPoints = [];
}

/**
 * Enter or leave floor-alignment mode.
 *
 * Kept as a named entry point because the mode can also be left with Escape or a
 * right-click on the canvas, and every exit path has to put the ghost back. Having only the
 * sidebar know about it was the bug: the mode closed and the ghost of the floor below
 * stayed on the canvas with nothing to explain it.
 */
export function setFloorAlignMode(on: boolean): void {
	if (on) setTool('align');
	else if (appState.tool === 'align') setTool('none');
}

/**
 * Turn AP placement on or off.
 *
 * A tool rather than a permanent state of the canvas: while it is on, a click on empty
 * canvas creates an AP and nothing else uses that gesture. Leaving it on by default meant
 * every stray click — deselecting, starting a marquee, fumbling a pan — dropped an AP on
 * the plan.
 */
export function setApPlaceMode(on: boolean): void {
	if (on) setTool('place-ap');
	else if (appState.tool === 'place-ap') setTool('none');
}

/**
 * Calibrating by measuring a line on the plan.
 *
 * The area route asks for the floorplan's total area and divides it into the outline the
 * detector found, which is only as good as that outline. Measuring asks something the user
 * can read off the drawing — this wall is twelve metres — and works on a plan whose
 * outline is open or which is a detail of one room. The points live here rather than in the
 * panel because the canvas is what collects them and the panel is what consumes them.
 */
export function setCalibrateMode(on: boolean): void {
	if (on) setTool('calibrate');
	else if (appState.tool === 'calibrate') setTool('none');
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
 * Leaving the mode throws the draft away — an abandoned loop is not a decision. See
 * `setTool`, which also drops the draft.
 */
export function setPlanningDrawMode(on: boolean): void {
	if (on) setTool('planning');
	else if (appState.tool === 'planning') setTool('none');
}

export function addPlanningPoint(point: { x: number; y: number }): void {
	appState.planningDraft = [...appState.planningDraft, point];
}

/**
 * Close the loop being drawn, without confirming it.
 *
 * The first corner is where a polygon tool closes the shape; here that is a preview the bar
 * can still undo or cancel. Only the green confirm replaces the floor's area.
 */
export function closePlanningDraft(): void {
	if (appState.planningDraft.length >= 3) appState.planningDraftClosed = true;
}

/**
 * Drawing a raised surface.
 *
 * Leaving the mode drops a half-drawn rectangle rather than keeping it — an unfinished
 * shape is not a statement about the floor. See `setTool`.
 */
export function setSurfaceMode(on: boolean): void {
	if (on) setTool('surface');
	else if (appState.tool === 'surface') setTool('none');
}

/**
 * Say something that happened to the walls, briefly.
 *
 * The messages are not warnings and not the save acknowledgment: they explain a change
 * the user did not ask for in those words — "the detected plan was traced into segments
 * so your new wall sits on top of it". They expire on their own, so the canvas does not
 * carry a permanent sentence about an action that is already visible on it.
 */
let wallsNoticeTimer: ReturnType<typeof setTimeout> | null = null;
export function notifyWalls(message: string): void {
	appState.wallNotice = message;
	if (wallsNoticeTimer) clearTimeout(wallsNoticeTimer);
	wallsNoticeTimer = setTimeout(() => {
		wallsNoticeTimer = null;
		appState.wallNotice = null;
	}, 7000);
}
