import type { CanvasEngine } from '../engine.js';
import { hitTest } from '../hit-test.js';
import { projectState, moveAp, faceAp, beginMove } from '$state/project.svelte.js';
import { scheduleSave } from '$state/persistence.svelte.js';
import { canvasState, isSelected } from '$state/canvas.svelte.js';
import { facingFollowsWall, type WallSnap } from '$state/wall-snap.js';

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
		const hit = hitTest(screenPoint, this.engine.camera, projectState.aps);

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
				const ap = projectState.aps.find((a) => a.id === id);
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

	handlePointerMove(e: PointerEvent): void {
		if (!this._isDragging) return;

		const rect = this.engine.canvas.getBoundingClientRect();
		const screenPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top };
		const worldPoint = this.engine.camera.screenToWorld(screenPoint);

		const dx = worldPoint.x - this.startWorld.x;
		const dy = worldPoint.y - this.startWorld.y;

		// Move all selected APs by the delta
		for (const [id, start] of this.apStartPositions) {
			const ap = projectState.aps.find((a) => a.id === id);
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
			}
			moveAp(id, x, y);
		}

		this.engine.markDirty();
	}

	handlePointerUp(): void {
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
