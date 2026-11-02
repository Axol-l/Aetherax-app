import type { CanvasEngine } from '../engine.js';
import { hitTest } from '../hit-test.js';
import { scheduleSave } from '$state/persistence.svelte.js';
import { canvasState, isSelected } from '$state/canvas.svelte.js';
import { facingFollowsWall, type WallSnap } from '$state/wall-snap.js';
import { apState, beginMove, faceAp, moveAp } from '$state/ap-state.svelte.js';

/**
 * The nearest wall to a world point, as the view can answer it on every frame.
 *
 * Handed in rather than looked up here: the view already builds the distance
 * transform for the caption under each access point's name, and a second one per
 * drag would cost eight bytes a mask pixel for no gain. Optional, so a view without
 * a mask (or a test) simply drags freely.
 */
export type WallProbe = (worldX: number, worldY: number) => WallSnap | null;

export class DragHandler {
	private engine: CanvasEngine;
	private wallProbe: WallProbe | undefined;
	private _isDragging = false;
	private dragApId: string | null = null;
	private startWorld = { x: 0, y: 0 };
	private apStartPositions: Map<string, { x: number; y: number }> = new Map();
	/**
	 * Whether each dragged wall mount's facing was the one its wall gave it, and so
	 * should follow the wall as it moves. A bracket the user has turned keeps its
	 * angle: the wall suggests a direction, it does not own it.
	 */
	private followsWall = new Map<string, boolean>();

	constructor(engine: CanvasEngine, wallProbe?: WallProbe) {
		this.engine = engine;
		this.wallProbe = wallProbe;
	}

	handlePointerDown(e: PointerEvent): boolean {
		const rect = this.engine.canvas.getBoundingClientRect();
		const screenPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top };
		const hit = hitTest(screenPoint, this.engine.camera, apState.aps);

		if (hit && isSelected(hit.id)) {
			beginMove();
			this._isDragging = true;
			this.dragApId = hit.id;
			canvasState.isDragging = true;
			this.startWorld = this.engine.camera.screenToWorld(screenPoint);

			// Store start positions of all selected APs
			this.apStartPositions.clear();
			this.followsWall.clear();
			for (const id of canvasState.selectedApIds) {
				const ap = apState.aps.find((a) => a.id === id);
				if (ap) {
					this.apStartPositions.set(id, { x: ap.x, y: ap.y });
					if (ap.mount === 'wall' && this.wallProbe) {
						const snap = this.wallProbe(ap.x, ap.y);
						this.followsWall.set(id, !!snap && facingFollowsWall(ap.facingDeg, snap));
					}
				}
			}
			return true;
		}
		return false;
	}

	/**
	 * The last pointer position, applied once per frame.
	 *
	 * A pointermove can arrive more often than the display refreshes (120 Hz trackpads,
	 * coalesced mouse events), and every application writes the AP's state — which re-runs
	 * the effects that watch it. One write per frame is the most the screen can show and the
	 * least the rest of the app can be asked to do.
	 */
	private pending: { x: number; y: number } | null = null;
	private frame: number | null = null;

	handlePointerMove(e: PointerEvent): void {
		if (!this._isDragging) return;

		const rect = this.engine.canvas.getBoundingClientRect();
		const screenPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top };
		const worldPoint = this.engine.camera.screenToWorld(screenPoint);
		this.pending = worldPoint;
		if (this.frame !== null) return;
		this.frame = requestAnimationFrame(() => {
			this.frame = null;
			const point = this.pending;
			this.pending = null;
			if (point) this.apply(point);
		});
	}

	private apply(worldPoint: { x: number; y: number }): void {
		const dx = worldPoint.x - this.startWorld.x;
		const dy = worldPoint.y - this.startWorld.y;

		// Move all selected APs by the delta
		for (const [id, start] of this.apStartPositions) {
			const ap = apState.aps.find((a) => a.id === id);
			const x = start.x + dx;
			const y = start.y + dy;
			/*
			 * A wall-mounted unit stays on a wall while it is dragged — that is what
			 * makes it one — so its position is the wall's, not the pointer's. The
			 * bracket's direction follows too, unless the user turned it.
			 */
			if (ap?.mount === 'wall' && this.wallProbe) {
				const snap = this.wallProbe(x, y);
				if (snap) {
					moveAp(id, snap.apX, snap.apY);
					if (this.followsWall.get(id)) faceAp(id, snap.facingDeg);
					continue;
				}
				/*
				 * Off the plan. There is no wall out there to measure to, and moving
				 * freely would take the bracket off its wall and leave it outside the
				 * building — which then shows the standing "outside the building"
				 * warning on every later edit. A wall mount that runs out of plan stays
				 * where it last was; dragging back in resumes the snap.
				 */
				continue;
			}
			moveAp(id, x, y);
		}

		this.engine.markDirty();
	}

	handlePointerUp(): void {
		// Apply the last position before the gesture ends, or a move made between the last
		// frame and the release is dropped.
		if (this.pending) {
			const point = this.pending;
			this.pending = null;
			this.apply(point);
		}
		if (this.frame !== null) {
			cancelAnimationFrame(this.frame);
			this.frame = null;
		}
		if (this._isDragging) {
			this._isDragging = false;
			this.dragApId = null;
			canvasState.isDragging = false;
			this.apStartPositions.clear();
			this.followsWall.clear();
			scheduleSave();
		}
	}

	get isDragging(): boolean {
		return this._isDragging;
	}
}
