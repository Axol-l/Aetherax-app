import { appState } from '$state/app.svelte';
import { floorState } from '$state/floor-state.svelte';

import { wallState } from '$state/wall-state.svelte';
import type { CanvasEngine } from '$canvas/engine.js';
import { apState } from '$state/ap-state.svelte.js';

/**
 * 让画布适配当前视图实际显示的内容；总览视图下向布局请求内容边界。
 * `includeAps` 为 true 时把所有接入点并入取景范围，默认 false；没有可适配内容时返回 false。
 */
export function fitCanvasToContent(engine: CanvasEngine, includeAps = false): boolean {
	const rect = engine.canvas.getBoundingClientRect();

	if (appState.floorView !== 'single') {
		const id =
			appState.floorView === 'stacked'
				? 'stacked-floors'
				: appState.floorView === 'floor3d'
					? 'floor3d'
					: 'floor-tiles';
		const overview = engine.layers.find((l) => l.id === id) as
			| { contentBounds?: () => Array<{ x: number; y: number }> }
			| undefined;
		const bounds = overview?.contentBounds?.() ?? [];
		if (bounds.length > 0) {
			engine.camera.fitToBounds(bounds, rect.width, rect.height);
			engine.markDirty();
			return true;
		}
	}

	const points: Array<{ x: number; y: number }> = [];

	// 优先级 1：平面图图像边界，按本层底图绘制时的偏移计算。
	// 只读图像尺寸会把已对齐的楼层当作位于原点。
	const fp = engine.layers.find((l) => l.id === 'floorplan') as
		| { imageWidth?: number; imageHeight?: number; offsetX?: number; offsetY?: number }
		| undefined;
	if (fp && fp.imageWidth && fp.imageWidth > 0) {
		const ox = fp.offsetX ?? 0;
		const oy = fp.offsetY ?? 0;
		points.push({ x: ox, y: oy });
		points.push({ x: ox + fp.imageWidth, y: oy + (fp.imageHeight ?? 0) });
	} else if (wallState.wallMask) {
		// 优先级 2：墙体掩码边界（从零绘制时）
		const ox = wallState.wallMask.originX ?? 0;
		const oy = wallState.wallMask.originY ?? 0;
		points.push({ x: ox, y: oy });
		points.push({ x: ox + wallState.wallMask.width, y: oy + wallState.wallMask.height });
	}

	// 没有平面图或墙体时，按 AP 中心适配，不放大半径。
	if (points.length === 0 || includeAps) {
		for (const ap of apState.aps) {
			if (appState.floorView === 'single' && ap.floorId !== floorState.currentFloorId) continue;
			points.push({ x: ap.x, y: ap.y });
		}
	}

	if (points.length === 0) return false;

	engine.camera.fitToBounds(points, rect.width, rect.height);
	engine.markDirty();
	return true;
}
