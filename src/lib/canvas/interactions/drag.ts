import type { CanvasEngine } from '../engine.js';
import { hitTest } from '../hit-test.js';
import { scheduleSave } from '$state/persistence.svelte.js';
import { canvasState, isSelected } from '$state/canvas.svelte.js';
import { facingFollowsWall, type WallSnap } from '$state/wall-snap.js';
import { apState, beginMove, faceAp, moveAp } from '$state/ap-state.svelte.js';

/**
 * 世界坐标点附近最近的墙体，由视图按帧提供。
 * 由外部传入而非在此查询，因此可选；未提供或无掩码时自由拖拽。
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
	 * 每个被拖拽壁挂设备的朝向是否来自墙体，若是则随墙移动而转向。
	 * 用户手动改过的朝向保持原角度。
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
			this.startWorld = this.engine.camera.screenToWorld(screenPoint);

			// 记录所有选中 AP 的起始位置
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
	 * 最后一次指针位置，每帧应用一次。
	 * pointermove 可能比屏幕刷新更频繁，每帧只写一次状态可避免重复触发监听它的响应式逻辑。
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

		// A plain click selects an AP but must not enter the drag/loading path.
		if (!canvasState.isDragging && dx === 0 && dy === 0) return;
		canvasState.isDragging = true;

		// 按位移量移动所有选中的 AP
		for (const [id, start] of this.apStartPositions) {
			const ap = apState.aps.find((a) => a.id === id);
			const x = start.x + dx;
			const y = start.y + dy;
			/*
			 * 壁挂设备拖拽时始终贴墙，位置取墙体而非指针；除非用户转过朝向，否则方向也随墙变化。
			 */
			if (ap?.mount === 'wall' && this.wallProbe) {
				const snap = this.wallProbe(x, y);
				if (snap) {
					moveAp(id, snap.apX, snap.apY);
					if (this.followsWall.get(id)) faceAp(id, snap.facingDeg);
					continue;
				}
				/*
				 * 越出平面图后没有墙可测量，壁挂设备停在最后位置；拖回范围内恢复贴墙。
				 */
				continue;
			}
			moveAp(id, x, y);
		}

		this.engine.markDirty();
	}

	handlePointerUp(): void {
		// 手势结束前先应用最后位置，否则最后一帧到抬起之间的移动会丢失。
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
