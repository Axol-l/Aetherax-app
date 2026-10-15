import type { Point, Matrix2D } from '@aetherax/geometry';
import { identity, translate, scale, invert, applyToPoint } from '@aetherax/geometry';

export interface CameraState {
	x: number; // pan offset in world coords
	y: number;
	zoom: number; // scale factor (1.0 = 100%)
}

/**
 * How far in the plan may be magnified.
 *
 * It used to be ten, which is past the point where the drawing has any more detail to
 * show: mask pixels are world units, so at 10x a single pixel of a wall covers ten screen
 * pixels and everything derived from it — the nearest-wall snap a wall-mounted access
 * point follows, the facing that comes out of it — visibly steps from one pixel to the
 * next. Four keeps a comfortable working zoom and keeps those steps at the scale the
 * plan was drawn at.
 */
export const MAX_ZOOM = 4;
export const MIN_ZOOM = 0.1;

export class Camera {
	state: CameraState = { x: 0, y: 0, zoom: 1 };

	private _transform: Matrix2D | null = null;
	private _inverse: Matrix2D | null = null;

	private invalidateCache(): void {
		this._transform = null;
		this._inverse = null;
	}

	/** Get the world-to-screen transform matrix (in CSS-pixel space, no DPR). */
	getTransform(): Matrix2D {
		if (this._transform) return this._transform;
		let m = identity();
		m = scale(m, this.state.zoom, this.state.zoom);
		m = translate(m, this.state.x, this.state.y);
		this._transform = m;
		return m;
	}

	/** Get screen-to-world transform (inverse) */
	getInverseTransform(): Matrix2D {
		if (this._inverse) return this._inverse;
		this._inverse = invert(this.getTransform());
		return this._inverse;
	}

	/** Convert screen coordinates to world coordinates */
	screenToWorld(screen: Point): Point {
		return applyToPoint(this.getInverseTransform(), screen);
	}

	/** Convert world coordinates to screen coordinates */
	worldToScreen(world: Point): Point {
		return applyToPoint(this.getTransform(), world);
	}

	pan(dx: number, dy: number): void {
		this.state.x += dx;
		this.state.y += dy;
		this.invalidateCache();
	}

	/** Zoom centered on a screen-space point */
	zoomAt(screenPoint: Point, factor: number): void {
		const worldBefore = this.screenToWorld(screenPoint);
		this.state.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.state.zoom * factor));
		this.invalidateCache();
		const worldAfter = this.screenToWorld(screenPoint);
		this.state.x += worldAfter.x - worldBefore.x;
		this.state.y += worldAfter.y - worldBefore.y;
		this.invalidateCache();
	}

	reset(): void {
		this.state = { x: 0, y: 0, zoom: 1 };
		this.invalidateCache();
	}

	/**
	 * Put the camera back where it was.
	 *
	 * Needed by anything that moves the camera on the user's behalf and must hand the
	 * view back unchanged — the PDF export fits every floor before it screenshots it,
	 * and leaving the user zoomed to the last page's framing is not acceptable. Assigning
	 * `state` directly would leave the cached transform pointing at the old framing, so
	 * the invalidation has to live here.
	 */
	setState(next: CameraState): void {
		this.state = { x: next.x, y: next.y, zoom: next.zoom };
		this.invalidateCache();
	}

	/** A copy of the current framing, for restoring it later. */
	getState(): CameraState {
		return { x: this.state.x, y: this.state.y, zoom: this.state.zoom };
	}

	/** Fit the camera to show all points within the given viewport size */
	fitToBounds(points: Point[], viewWidth: number, viewHeight: number, padding = 60): void {
		if (points.length === 0) {
			this.reset();
			return;
		}

		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;

		for (const p of points) {
			if (p.x < minX) minX = p.x;
			if (p.y < minY) minY = p.y;
			if (p.x > maxX) maxX = p.x;
			if (p.y > maxY) maxY = p.y;
		}

		const boundsWidth = maxX - minX || 1;
		const boundsHeight = maxY - minY || 1;
		const centerX = (minX + maxX) / 2;
		const centerY = (minY + maxY) / 2;

		const scaleX = (viewWidth - padding * 2) / boundsWidth;
		const scaleY = (viewHeight - padding * 2) / boundsHeight;
		const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(scaleX, scaleY)));

		this.state.zoom = zoom;
		this.state.x = viewWidth / (2 * zoom) - centerX;
		this.state.y = viewHeight / (2 * zoom) - centerY;
		this.invalidateCache();
	}

	getZoomPercent(): number {
		return Math.round(this.state.zoom * 100);
	}
}
