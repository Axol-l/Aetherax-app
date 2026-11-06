import type { Point, Matrix2D } from '@aetherax/geometry';
import { identity, translate, scale, invert, applyToPoint } from '@aetherax/geometry';

export interface CameraState {
	x: number; // 平移偏移，世界坐标
	y: number;
	zoom: number; // 缩放系数，1.0 表示 100%
}

/**
 * 平面图允许的最大缩放倍数：倍数过高时掩码像素被明显放大，由像素推导的吸附与朝向会逐像素跳变。
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

	/** 世界坐标到屏幕坐标的变换矩阵（CSS 像素空间，不含 DPR）。 */
	getTransform(): Matrix2D {
		if (this._transform) return this._transform;
		let m = identity();
		m = scale(m, this.state.zoom, this.state.zoom);
		m = translate(m, this.state.x, this.state.y);
		this._transform = m;
		return m;
	}

	/** 屏幕坐标到世界坐标的变换矩阵（逆矩阵）。 */
	getInverseTransform(): Matrix2D {
		if (this._inverse) return this._inverse;
		this._inverse = invert(this.getTransform());
		return this._inverse;
	}

	/** 把屏幕坐标转换为世界坐标。 */
	screenToWorld(screen: Point): Point {
		return applyToPoint(this.getInverseTransform(), screen);
	}

	/** 把世界坐标转换为屏幕坐标。 */
	worldToScreen(world: Point): Point {
		return applyToPoint(this.getTransform(), world);
	}

	pan(dx: number, dy: number): void {
		this.state.x += dx;
		this.state.y += dy;
		this.invalidateCache();
	}

	/** 以屏幕空间中的某点为锚点缩放。 */
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
	 * 恢复相机到此前的取景；直接赋值 `state` 会让缓存的变换停在旧取景，因此失效逻辑放在这里。
	 */
	setState(next: CameraState): void {
		this.state = { x: next.x, y: next.y, zoom: next.zoom };
		this.invalidateCache();
	}

	/** 当前取景的副本，用于之后还原。 */
	getState(): CameraState {
		return { x: this.state.x, y: this.state.y, zoom: this.state.zoom };
	}

	/** 调整相机，使全部点在给定视口尺寸内可见；内边距默认为 60。 */
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
