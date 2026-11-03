/**
 * The canvas gesture state machine: pointer, touch, orbit and alignment drags.
 *
 * Every one of these is a small state machine with the same shape — "record where the
 * pointer went down, decide on release whether it was a click or a drag, and route the
 * click to whatever mode is armed". They were interleaved with the view's forty effects
 * and its editing helpers, which made a gesture change a change to the largest file in
 * the app.
 *
 * The component keeps the *actions* (what a click on a wall means, what committing a
 * surface means); this class owns when they happen. `GestureHost` is the seam: eighteen
 * small functions the view provides, most of them one line forwarding to an existing
 * helper. Everything else — the thresholds, the long-press timer, the pinch baseline, the
 * orbit angles, the alignment deltas — lives here, where it can be read in one place.
 *
 * Three fields are `$state` because the renderer draws from them: the wall cursor, its
 * snap target and the planning cursor are rubber bands, and they have to repaint without
 * a gesture event.
 */
import type { CanvasEngine } from './engine.js';
import type { DragHandler } from './interactions/drag.js';
import type { PlaceHandler } from './interactions/place.js';
import type { SelectHandler } from './interactions/select.js';
import type { FloorTilesLayer } from './renderers/floor-tiles.js';
import type { ReferenceFloorLayer } from './renderers/reference-floor.js';
import type { StackedFloorsLayer } from './renderers/stacked-floors.js';
import { hitTest } from './hit-test.js';
import { noteAtPoint } from './renderers/notes.js';
import { surfaceEdgeNear } from './renderers/surfaces.js';
import {
	columnAtPoint,
	snapToWalls,
	wallNearPoint,
	type VectorColumn,
	type VectorWall
} from '$state/vector-walls.js';
import {
	STACK_MAX_PITCH_DEG,
	STACK_MIN_PITCH_DEG,
	STACK_YAW_LIMIT_DEG,
	addCalibrationPoint,
	addPlanningPoint,
	appState,
	closePlanningDraft
} from '$state/app.svelte.js';
import { apState } from '$state/ap-state.svelte.js';
import { floorState, switchFloor } from '$state/floor-state.svelte.js';
import { pushState } from '$state/history.svelte.js';

interface Point {
	x: number;
	y: number;
}

/** The actions a gesture can end in, provided by the view. */
export interface GestureHost {
	engine(): CanvasEngine | undefined;
	select(): SelectHandler;
	drag(): DragHandler;
	place(): PlaceHandler;
	stacked(): StackedFloorsLayer | undefined;
	tiles(): FloorTilesLayer | undefined;
	reference(): ReferenceFloorLayer | undefined;
	/** A click on the wall/room raster, in canvas pixels; true when handled. */
	wallClick(screenX: number, screenY: number): boolean;
	/** A right-click or long-press context action, in canvas pixels; true when a popup opened. */
	contextAction(screenX: number, screenY: number): boolean;
	/** Close the planning loop being drawn and make it the floor's area. */
	commitPlanningDraft(): void;
	commitSurface(world: Point): void;
	vectorWallClick(world: Point, shiftKey: boolean): void;
	addNote(world: Point): void;
	eraseWall(world: Point): boolean;
	currentWalls(): VectorWall[];
	currentNotes(): ReadonlyArray<{ id: string; x: number; y: number; text: string }>;
	snapTolerance(): number;
	noteTolerance(): number;
	/** Apply a finished alignment drag, in world units. */
	commitAlign(dxWorld: number, dyWorld: number): void;
}

/** How far a pointer may move and still count as a click rather than a drag, in pixels. */
const DRAG_THRESHOLD = 5;
/** Long-press delay for a touch context action, in milliseconds. */
const LONG_PRESS_MS = 500;
/** Degrees of view rotation per pointer pixel in the stacked / 3D overviews. */
const ORBIT_DEG_PER_PX = 0.4;

export class CanvasGestures {
	/** Pointer position while drawing a wall, for the rubber band. */
	vectorCursor = $state<Point | null>(null);
	/** The endpoint a click would snap to, ringed while the pointer is near it. */
	vectorSnap = $state<Point | null>(null);
	/** Pointer position while drawing the planning area; drives the rubber band. */
	planningCursor = $state<Point | null>(null);

	private pendingPlace = false;
	private pendingPan = false;
	private pointerStartX = 0;
	private pointerStartY = 0;
	private activeTouches = 0;

	// Single-finger state
	private touchStartX = 0;
	private touchStartY = 0;
	private touchMoved = false;
	private touchStartedOnAp = false;

	// Two-finger pinch state
	private pinchLastDist = 0;
	private pinchLastCx = 0;
	private pinchLastCy = 0;
	private pinchFrames = 0;

	// Long-press state
	private longPressTimer: ReturnType<typeof setTimeout> | null = null;
	private longPressFired = false;

	// Viewpoint drag for the stacked overview
	private orbitPointerId: number | null = null;
	private orbitStartX = 0;
	private orbitStartY = 0;
	private orbitLastX = 0;
	private orbitLastY = 0;
	private orbitYaw = 0;
	private orbitPitch = 0;
	private orbitMoved = false;

	// Floor-alignment drag. Screen-space deltas are kept because the camera works in
	// screen space while `translateFloor` works in world units; the zoom is the conversion,
	// and it can change mid-drag if the user scrolls.
	private alignDragging = false;
	private alignStartClientX = 0;
	private alignStartClientY = 0;
	private alignStartX = 0;
	private alignStartY = 0;
	private alignDxScreen = 0;
	private alignDyScreen = 0;

	/** True once the current eraser stroke has pushed its undo state. */
	private eraserStrokePushed = false;

	constructor(private readonly host: GestureHost) {}

	/** Abandon an alignment drag without moving the floor. */
	cancelAlignDrag(): void {
		const engine = this.host.engine();
		if (!this.alignDragging) return;
		this.alignDragging = false;
		if (engine) {
			engine.camera.pan(
				this.alignStartX - engine.camera.state.x,
				this.alignStartY - engine.camera.state.y
			);
			engine.markDirty();
		}
		const reference = this.host.reference();
		if (reference) {
			reference.compensateX = 0;
			reference.compensateY = 0;
		}
	}

	/**
	 * The pointer left the canvas.
	 *
	 * A pointer move that would clear the stack highlight or the wall cursor never arrives,
	 * so both are dropped here.
	 */
	handlePointerLeave(): void {
		const stacked = this.host.stacked();
		if (stacked?.hoverFloorId) {
			stacked.hoverFloorId = null;
			this.host.engine()?.markDirty();
		}
		if (this.vectorCursor) {
			this.vectorCursor = null;
			this.vectorSnap = null;
			// A stroke that leaves the canvas has ended; the next one is its own undo step.
			this.eraserStrokePushed = false;
			this.host.engine()?.markDirty();
		}
	}

	handleTouchStart(e: TouchEvent): void {
		this.activeTouches = e.touches.length;

		if (this.activeTouches === 1) {
			const t = e.touches[0]!;
			this.touchStartX = t.clientX;
			this.touchStartY = t.clientY;
			this.touchMoved = false;
			this.touchStartedOnAp = false;
			this.pendingPan = false;
			this.longPressFired = false;

			// Start long-press timer for contextual wall/room actions
			if (this.longPressTimer) clearTimeout(this.longPressTimer);
			const lpX = t.clientX;
			const lpY = t.clientY;
			this.longPressTimer = setTimeout(() => {
				this.longPressTimer = null;
				if (this.touchMoved || this.activeTouches !== 1) return;
				const engine = this.host.engine();
				if (!engine) return;
				const rect = engine.canvas.getBoundingClientRect();
				if (this.host.contextAction(lpX - rect.left, lpY - rect.top)) {
					this.longPressFired = true;
				}
			}, LONG_PRESS_MS);
		} else if (this.activeTouches >= 2) {
			e.preventDefault();
			// Cancel long-press and single-finger state
			if (this.longPressTimer) {
				clearTimeout(this.longPressTimer);
				this.longPressTimer = null;
			}
			this.pendingPan = false;
			this.touchStartedOnAp = false;
			this.touchMoved = true;
			this.host.drag().handlePointerUp();
			// Initialize pinch
			this.pinchFrames = 0;
			this.pinchLastDist = 0;
		}
	}

	handleTouchMove(e: TouchEvent): void {
		const engine = this.host.engine();
		if (!engine) return;

		// Two-finger: pinch zoom + pan
		if (e.touches.length === 2) {
			e.preventDefault();
			const t0 = e.touches[0]!;
			const t1 = e.touches[1]!;
			const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
			const cx = (t0.clientX + t1.clientX) / 2;
			const cy = (t0.clientY + t1.clientY) / 2;

			this.pinchFrames++;
			if (this.pinchFrames <= 2) {
				// Baseline frames: record, don't apply
				this.pinchLastDist = dist;
				this.pinchLastCx = cx;
				this.pinchLastCy = cy;
				return;
			}

			// Zoom
			if (this.pinchLastDist > 0) {
				const factor = dist / this.pinchLastDist;
				const rect = engine.canvas.getBoundingClientRect();
				engine.camera.zoomAt({ x: cx - rect.left, y: cy - rect.top }, factor);
			}

			// Pan
			engine.camera.pan(
				(cx - this.pinchLastCx) / engine.camera.state.zoom,
				(cy - this.pinchLastCy) / engine.camera.state.zoom
			);

			this.pinchLastDist = dist;
			this.pinchLastCx = cx;
			this.pinchLastCy = cy;
			engine.markDirty();
			return;
		}

		// Single-finger
		if (e.touches.length !== 1) return;
		const t = e.touches[0]!;

		const dx = t.clientX - this.touchStartX;
		const dy = t.clientY - this.touchStartY;

		if (
			!this.touchMoved &&
			!this.touchStartedOnAp &&
			!this.pendingPan &&
			dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD
		) {
			this.touchMoved = true;
			if (this.longPressTimer) {
				clearTimeout(this.longPressTimer);
				this.longPressTimer = null;
			}
			const rect = engine.canvas.getBoundingClientRect();
			const hit = hitTest(
				{ x: this.touchStartX - rect.left, y: this.touchStartY - rect.top },
				engine.camera,
				apState.aps.filter((ap) => ap.floorId === floorState.currentFloorId)
			);

			if (hit) {
				this.touchStartedOnAp = true;
				const synth = new PointerEvent('pointerdown', {
					clientX: this.touchStartX,
					clientY: this.touchStartY,
					button: 0
				});
				this.host.select().handlePointerDown(synth);
				this.host.drag().handlePointerDown(synth);
			} else {
				this.pendingPan = true;
				this.pointerStartX = this.touchStartX;
				this.pointerStartY = this.touchStartY;
			}
		}

		if (this.touchStartedOnAp && this.host.drag().isDragging) {
			this.host
				.drag()
				.handlePointerMove(
					new PointerEvent('pointermove', { clientX: t.clientX, clientY: t.clientY })
				);
		} else if (this.pendingPan) {
			engine.camera.pan(
				(t.clientX - this.pointerStartX) / engine.camera.state.zoom,
				(t.clientY - this.pointerStartY) / engine.camera.state.zoom
			);
			this.pointerStartX = t.clientX;
			this.pointerStartY = t.clientY;
			engine.markDirty();
		}
	}

	handleTouchEnd(e: TouchEvent): void {
		const engine = this.host.engine();
		if (this.longPressTimer) {
			clearTimeout(this.longPressTimer);
			this.longPressTimer = null;
		}

		if (this.activeTouches === 1 && e.touches.length === 0) {
			// Skip tap action if long-press already fired a contextual popup
			if (!this.touchMoved && !this.longPressFired && engine) {
				const rect = engine.canvas.getBoundingClientRect();
				const sx = this.touchStartX - rect.left;
				const sy = this.touchStartY - rect.top;
				const hit = hitTest(
					{ x: sx, y: sy },
					engine.camera,
					apState.aps.filter((ap) => ap.floorId === floorState.currentFloorId)
				);

				if (hit) {
					this.host.select().handlePointerDown(
						new PointerEvent('pointerdown', {
							clientX: this.touchStartX,
							clientY: this.touchStartY,
							button: 0
						})
					);
				} else if (appState.apPlaceMode) {
					// Touch follows the mouse: a tap while placing is an AP, including on a wall.
					this.host.place().handlePointerDown(
						new PointerEvent('pointerdown', {
							clientX: this.touchStartX,
							clientY: this.touchStartY,
							button: 0
						})
					);
				}
			}
			this.pendingPan = false;
			this.touchStartedOnAp = false;
			this.host.drag().handlePointerUp();
			this.host.select().handlePointerUp(new PointerEvent('pointerup'));
		}
		this.activeTouches = e.touches.length;
		if (this.activeTouches === 0) {
			this.pinchFrames = 0;
			this.pinchLastDist = 0;
		}
	}

	handlePointerDown(e: PointerEvent): void {
		const engine = this.host.engine();
		if (!engine) return;
		if (e.button !== 0) return; // Only handle primary (left) button
		if (e.pointerType === 'touch') return;
		// In the overview views a click picks a floor; nothing edits geometry there,
		// and a *drag* turns the view rather than picking.
		if (appState.floorView !== 'single') {
			this.orbitPointerId = e.pointerId;
			this.orbitStartX = e.clientX;
			this.orbitStartY = e.clientY;
			this.orbitLastX = e.clientX;
			this.orbitLastY = e.clientY;
			this.orbitYaw = appState.stackYaw;
			this.orbitPitch = appState.stackPitch;
			this.orbitMoved = false;
			return;
		}
		// Drawing vector walls: the first click starts a segment, the second commits it.
		if (appState.wallVectorMode) {
			const rect = engine.canvas.getBoundingClientRect();
			const world = engine.camera.screenToWorld({
				x: e.clientX - rect.left,
				y: e.clientY - rect.top
			});
			this.host.vectorWallClick(world, e.shiftKey);
			engine.markDirty();
			e.preventDefault();
			return;
		}
		// A note pin is a small target and it sits above everything: it takes the click before
		// the selection logic, whether or not note mode is on, because clicking a pin to read
		// it is the obvious gesture.
		{
			const rect = engine.canvas.getBoundingClientRect();
			const world = engine.camera.screenToWorld({
				x: e.clientX - rect.left,
				y: e.clientY - rect.top
			});
			if (appState.noteMode) {
				this.host.addNote(world);
				engine.markDirty();
				e.preventDefault();
				return;
			}
			const hit = appState.showNotes
				? noteAtPoint(this.host.currentNotes(), world, this.host.noteTolerance())
				: null;
			if (hit) {
				appState.noteSelectedId = hit.id;
				engine.markDirty();
				e.preventDefault();
				return;
			}
			// A click on the plan itself drops the note selection, like every other selection.
			if (appState.noteSelectedId) appState.noteSelectedId = null;
		}
		// Drawing the planning area intercepts the primary click: each click is a corner of
		// the loop the user is stating, and nothing else uses that gesture while it is on.
		if (appState.planningDrawMode) {
			const rect = engine.canvas.getBoundingClientRect();
			const world = engine.camera.screenToWorld({
				x: e.clientX - rect.left,
				y: e.clientY - rect.top
			});
			// The shape is closed and waiting for the bar's confirm: further clicks must not
			// add corners behind the confirm's back.
			if (appState.planningDraftClosed) {
				e.preventDefault();
				return;
			}
			// A corner snaps to the drawn walls, and the snapped point is placed at once:
			// there is no second click or confirm button between aiming and committing it.
			const point = this.planningPoint(world);
			const draft = appState.planningDraft;
			/*
			 * Clicking the first corner closes the loop — the shape, not the decision.
			 *
			 * The bar stays up with the green confirm, so the area can still be undone or
			 * cancelled before it replaces the floor's. Committing here used to hide the
			 * bar mid-gesture, which left no way to confirm and the old outline on screen.
			 */
			const closes =
				draft.length >= 3 &&
				Math.hypot(point.x - draft[0]!.x, point.y - draft[0]!.y) <= this.host.snapTolerance();
			if (closes) {
				closePlanningDraft();
				this.planningCursor = null;
			} else addPlanningPoint(point);
			engine.markDirty();
			e.preventDefault();
			return;
		}
		// Drawing a raised surface: two clicks, opposite corners. The first states where it
		// starts and the second commits it, exactly like a wall — the two gestures that
		// shape the model should feel the same.
		if (appState.surfaceMode) {
			const rect = engine.canvas.getBoundingClientRect();
			const world = engine.camera.screenToWorld({
				x: e.clientX - rect.left,
				y: e.clientY - rect.top
			});
			this.host.commitSurface(world);
			engine.markDirty();
			e.preventDefault();
			return;
		}
		// Calibrating by measurement intercepts the primary click, before placement and
		// before selection: while the mode is on, a click is a point of the measured line
		// and nothing else.
		if (appState.calibrateMode) {
			const rect = engine.canvas.getBoundingClientRect();
			const world = engine.camera.screenToWorld({
				x: e.clientX - rect.left,
				y: e.clientY - rect.top
			});
			addCalibrationPoint({ x: world.x, y: world.y });
			engine.markDirty();
			e.preventDefault();
			return;
		}
		// Align mode intercepts the primary pointer. PanZoomHandler only pans on
		// the middle button, so a left drag here does not fight it.
		if (appState.floorAlignMode) {
			this.alignDragging = true;
			this.alignDxScreen = 0;
			this.alignDyScreen = 0;
			this.alignStartClientX = e.clientX;
			this.alignStartClientY = e.clientY;
			this.alignStartX = engine.camera.state.x;
			this.alignStartY = engine.camera.state.y;
			pushState();
			e.preventDefault();
			return;
		}
		this.processPointerDown(e);
	}

	private processPointerDown(e: PointerEvent): void {
		const engine = this.host.engine();
		if (!engine) return;
		if (this.activeTouches >= 2) return;

		const rect = engine.canvas.getBoundingClientRect();
		const screenPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top };
		const hit = hitTest(
			screenPoint,
			engine.camera,
			apState.aps.filter((ap) => ap.floorId === floorState.currentFloorId)
		);

		if (hit) {
			this.host.select().handlePointerDown(e);
			this.host.drag().handlePointerDown(e);
			this.pendingPlace = false;
			this.pendingPan = false;
		} else if (e.shiftKey) {
			this.host.select().handlePointerDown(e);
			this.pendingPlace = false;
			this.pendingPan = false;
		} else if (appState.apPlaceMode) {
			/*
			 * Placement owns the bare-canvas click, including the wall band.
			 *
			 * Wall and column selection used to run first, so a click near a wall selected
			 * that wall and returned before `pendingPlace` was set. A wall mount has to be
			 * clicked within a metre of a wall, so the one gesture the mode exists for was
			 * the one gesture it could never reach.
			 */
			this.pointerStartX = e.clientX;
			this.pointerStartY = e.clientY;
			this.pendingPlace = true;
			this.pendingPan = false;
		} else {
			// A drawn wall is an object: a click near one selects it — Delete removes it,
			// right-click changes its material — instead of starting a marquee. Without
			// this the only way to reach a wall was to have just drawn it.
			const floor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
			// A surface edge first: the outline is the only part of a mezzanine that is
			// unambiguous, and the canvas inside it stays free for placing access points.
			if (floor?.surfaces?.length) {
				const world = engine.camera.screenToWorld(screenPoint);
				const surface = surfaceEdgeNear(
					floor.surfaces,
					world.x,
					world.y,
					10 / (engine.camera.state.zoom || 1)
				);
				if (surface) {
					appState.surfaceSelected = surface.id;
					appState.wallVectorSelected = null;
					this.pendingPlace = false;
					this.pendingPan = false;
					engine.markDirty();
					return;
				}
			}
			const walls = (floor?.walls ?? []) as VectorWall[];
			if (walls.length > 0) {
				const world = engine.camera.screenToWorld(screenPoint);
				const wall = wallNearPoint(world, walls, 12 / (engine.camera.state.zoom || 1));
				if (wall) {
					appState.wallVectorSelected = wall.id;
					appState.wallColumnSelected = null;
					this.pendingPlace = false;
					this.pendingPan = false;
					engine.markDirty();
					return;
				}
			}
			if ((floor?.columns ?? []).length > 0) {
				const world = engine.camera.screenToWorld(screenPoint);
				const column = columnAtPoint((floor?.columns ?? []) as VectorColumn[], world);
				if (column) {
					appState.wallColumnSelected = column.id;
					appState.wallVectorSelected = null;
					this.pendingPlace = false;
					this.pendingPan = false;
					engine.markDirty();
					return;
				}
			}
			if (appState.wallVectorSelected || appState.wallColumnSelected) {
				appState.wallVectorSelected = null;
				appState.wallColumnSelected = null;
				engine.markDirty();
			}
			if (appState.surfaceSelected) {
				appState.surfaceSelected = null;
				engine.markDirty();
			}
			// A click on empty canvas adds an AP only in placement mode; otherwise it is
			// a selection gesture (click to clear, drag to marquee), which is the same
			// thing Shift+click does.
			this.pointerStartX = e.clientX;
			this.pointerStartY = e.clientY;
			this.pendingPan = false;
			if (appState.apPlaceMode) {
				this.pendingPlace = true;
			} else {
				this.pendingPlace = false;
				this.host.select().handlePointerDown(e);
			}
		}
	}

	/**
	 * The point a planning click means.
	 *
	 * Corners snap to the drawn walls — an endpoint first, then an edge, the same rule the
	 * wall tool uses — so a planning area can follow a room that was traced rather than
	 * clicked by eye. The snapped point is what gets placed: no confirm step.
	 */
	private planningPoint(world: Point): Point {
		const walls = this.host.currentWalls();
		if (walls.length === 0) return world;
		return snapToWalls(world, walls, this.host.snapTolerance()).point;
	}

	handlePointerMove(e: PointerEvent): void {
		const engine = this.host.engine();
		if (!engine) return;
		// Hovering a note pin shows its text, in every mode: reading a note is never the
		// gesture the current mode is about.
		if (appState.showNotes && appState.floorView === 'single') {
			const rect = engine.canvas.getBoundingClientRect();
			const world = engine.camera.screenToWorld({
				x: e.clientX - rect.left,
				y: e.clientY - rect.top
			});
			const hovered = noteAtPoint(this.host.currentNotes(), world, this.host.noteTolerance());
			if ((hovered?.id ?? null) !== appState.noteHoverId) {
				appState.noteHoverId = hovered?.id ?? null;
				engine.markDirty();
			}
		}
		if (appState.wallVectorMode) {
			const rect = engine.canvas.getBoundingClientRect();
			this.vectorCursor = engine.camera.screenToWorld({
				x: e.clientX - rect.left,
				y: e.clientY - rect.top
			});
			/*
			 * The eraser works as a stroke, not a click: whatever the brush passes over goes,
			 * and one undo puts the whole stroke back. `buttons` is what says the pointer is
			 * down — a move without it is a hover and must not delete anything.
			 */
			if (appState.wallTool === 'eraser') {
				if ((e.buttons & 1) !== 0) {
					if (!this.eraserStrokePushed) {
						pushState();
						this.eraserStrokePushed = true;
					}
					if (this.host.eraseWall(this.vectorCursor)) engine.markDirty();
				}
				this.vectorSnap = null;
				engine.markDirty();
				return;
			}
			if (appState.wallTool === 'line') {
				// Where the click would land, so the ring can say "this will meet that wall".
				const snapped = snapToWalls(
					this.vectorCursor,
					this.host.currentWalls(),
					this.host.snapTolerance()
				);
				this.vectorSnap =
					snapped.point.x !== this.vectorCursor.x || snapped.point.y !== this.vectorCursor.y
						? snapped.point
						: null;
			} else {
				this.vectorSnap = null;
				// The pier or column follows the pointer from the first click, like a wall.
				if (appState.columnDraft) {
					appState.columnDraft = {
						...appState.columnDraft,
						bx: this.vectorCursor.x,
						by: this.vectorCursor.y
					};
				}
			}
			engine.markDirty();
			return;
		}
		if (appState.noteMode) return;
		// Drawing a raised surface: the second corner follows the pointer, so the rectangle
		// can be judged before the click that commits it.
		if (appState.surfaceMode) {
			const rect = engine.canvas.getBoundingClientRect();
			const world = engine.camera.screenToWorld({
				x: e.clientX - rect.left,
				y: e.clientY - rect.top
			});
			if (appState.surfaceDraft) {
				appState.surfaceDraft = { ...appState.surfaceDraft, bx: world.x, by: world.y };
				engine.markDirty();
			}
			return;
		}
		// While drawing the planning area the pointer drives the rubber band: the next edge
		// and the closing edge are previewed, so the shape can be judged before it is closed.
		if (appState.planningDrawMode) {
			// A closed loop has no rubber band: there is no next corner until it is undone.
			if (appState.planningDraftClosed) {
				if (this.planningCursor !== null) {
					this.planningCursor = null;
					engine.markDirty();
				}
				return;
			}
			const rect = engine.canvas.getBoundingClientRect();
			const world = engine.camera.screenToWorld({
				x: e.clientX - rect.left,
				y: e.clientY - rect.top
			});
			// The rubber band ends on the wall the click would snap to, so the corner is
			// previewed where it will actually land.
			this.planningCursor = this.planningPoint(world);
			engine.markDirty();
			return;
		}
		if (e.pointerType === 'touch') return;
		// Turning the viewpoint of an overview, and which slab is under the pointer in the
		// stacked one. Read-only and cheap: the layout is a few floors of arithmetic, and
		// only a *change* marks the canvas dirty, so a moving pointer does not repaint per
		// pixel.
		if (appState.floorView === 'stacked' || appState.floorView === 'floor3d') {
			// While the view is being dragged there is no hovering to report: the
			// pointer is holding the camera, not pointing at a floor.
			if (this.orbitPointerId === e.pointerId) {
				const dx = e.clientX - this.orbitStartX;
				const dy = e.clientY - this.orbitStartY;
				if (!this.orbitMoved && Math.hypot(dx, dy) >= DRAG_THRESHOLD) {
					this.orbitMoved = true;
					const stacked = this.host.stacked();
					if (stacked) stacked.hoverFloorId = null;
					// Start accumulating from here, not from where the drag began:
					// otherwise the threshold distance itself is applied as a turn on
					// the first step, which reads as a small jump.
					this.orbitLastX = e.clientX;
					this.orbitLastY = e.clientY;
				}
				if (this.orbitMoved) {
					this.orbitYaw = clamp(
						this.orbitYaw - (e.clientX - this.orbitLastX) * ORBIT_DEG_PER_PX,
						-STACK_YAW_LIMIT_DEG,
						STACK_YAW_LIMIT_DEG
					);
					this.orbitPitch = clamp(
						this.orbitPitch - (e.clientY - this.orbitLastY) * ORBIT_DEG_PER_PX,
						STACK_MIN_PITCH_DEG,
						STACK_MAX_PITCH_DEG
					);
					this.orbitLastX = e.clientX;
					this.orbitLastY = e.clientY;
					appState.stackYaw = this.orbitYaw;
					appState.stackPitch = this.orbitPitch;
					return;
				}
			}
			const stacked = this.host.stacked();
			if (appState.floorView === 'stacked' && stacked) {
				const rect = engine.canvas.getBoundingClientRect();
				const world = engine.camera.screenToWorld({
					x: e.clientX - rect.left,
					y: e.clientY - rect.top
				});
				const hovered = stacked.floorAt(world.x, world.y);
				if (hovered !== stacked.hoverFloorId) {
					stacked.hoverFloorId = hovered;
					engine.markDirty();
				}
			}
		}
		if (this.alignDragging) {
			// The camera carries the current floor, and the ghost is pushed back by
			// the same amount so it stays anchored to the floor it belongs to. On
			// release the camera returns and the floor's own coordinates take over
			// the movement, so nothing jumps.
			this.alignDxScreen = e.clientX - this.alignStartClientX;
			this.alignDyScreen = e.clientY - this.alignStartClientY;
			const cam = engine.camera;
			cam.pan(
				this.alignStartX + this.alignDxScreen - cam.state.x,
				this.alignStartY + this.alignDyScreen - cam.state.y
			);
			const reference = this.host.reference();
			if (reference) {
				const zoom = cam.state.zoom || 1;
				reference.compensateX = -this.alignDxScreen / zoom;
				reference.compensateY = -this.alignDyScreen / zoom;
			}
			engine.markDirty();
			return;
		}
		if (this.host.drag().isDragging) {
			this.host.drag().handlePointerMove(e);
			return;
		}

		if (this.pendingPlace) {
			const dx = e.clientX - this.pointerStartX;
			const dy = e.clientY - this.pointerStartY;
			if (dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) {
				// Moved beyond threshold: this is a pan, not a tap-to-place
				this.pendingPlace = false;
				this.pendingPan = true;
				// Start panning from the original position
				engine.canvas.style.cursor = 'grabbing';
			}
		}

		if (this.pendingPan) {
			const dx = (e.clientX - this.pointerStartX) / engine.camera.state.zoom;
			const dy = (e.clientY - this.pointerStartY) / engine.camera.state.zoom;
			engine.camera.pan(dx, dy);
			this.pointerStartX = e.clientX;
			this.pointerStartY = e.clientY;
			engine.markDirty();
			return;
		}

		this.host.select().handlePointerMove(e);
	}

	handlePointerUp(e: PointerEvent): void {
		const engine = this.host.engine();
		if (!engine) return;
		if (e.button !== 0) return; // Only handle primary (left) button
		// An eraser stroke ends with the pointer: the next one is its own undo step.
		this.eraserStrokePushed = false;
		// The overview's drag-vs-click decision, made on release.
		if (this.orbitPointerId === e.pointerId) {
			this.orbitPointerId = null;
			if (!this.orbitMoved && appState.floorView !== 'single') {
				const r = engine.canvas.getBoundingClientRect();
				const world = engine.camera.screenToWorld({
					x: e.clientX - r.left,
					y: e.clientY - r.top
				});
				const picked =
					appState.floorView === 'stacked'
						? this.host.stacked()?.floorAt(world.x, world.y)
						: this.host.tiles()?.tileAt(world.x, world.y);
				if (picked) switchFloor(picked);
			}
			return;
		}
		if (this.alignDragging) {
			this.alignDragging = false;
			const zoom = engine.camera.state.zoom || 1;
			const dxWorld = this.alignDxScreen / zoom;
			const dyWorld = this.alignDyScreen / zoom;
			// Restore the camera before moving the floor. The floor is about to
			// carry the movement in its own coordinates, and the camera has been
			// carrying it until now — leaving both in place would double it.
			engine.camera.pan(
				this.alignStartX - engine.camera.state.x,
				this.alignStartY - engine.camera.state.y
			);
			const reference = this.host.reference();
			if (reference) {
				reference.compensateX = 0;
				reference.compensateY = 0;
			}
			if (dxWorld !== 0 || dyWorld !== 0) this.host.commitAlign(dxWorld, dyWorld);
			engine.markDirty();
			return;
		}
		if (this.pendingPlace) {
			this.pendingPlace = false;
			// Placement owns the click: a wall under the pointer is where a wall mount goes,
			// not a material popup. The mount test inside PlaceHandler rejects a wall mount
			// that is too far from a wall.
			this.host.place().handlePointerDown(e);
		}

		if (this.pendingPan) {
			this.pendingPan = false;
			engine.canvas.style.cursor = '';
		}

		this.host.select().handlePointerUp(e);
		this.host.drag().handlePointerUp();
	}
}

/** Clamp to a range, for the orbit drag's per-step limits. */
function clamp(value: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, value));
}
