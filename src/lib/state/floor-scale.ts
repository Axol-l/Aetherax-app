/**
 * 设置楼层比例，同时让这层的 AP 保住原来的物理尺寸。
 */
import { apState, DEFAULT_WUPM, wupmForFloor } from './ap-state.svelte.js';
import { getFloor } from './floor-state.svelte.js';
import { scheduleSave } from './persistence.svelte.js';

/** 未标定楼层的 AP 用这个半径画，世界单位（`DEFAULT_WUPM` 下是 15 米）。 */
function uncalibratedRadius(): number {
	return Math.round(15 * DEFAULT_WUPM);
}

/**
 * 把长度从 `fromFloorId` 的世界单位换算成 `toFloorId` 的世界单位。
 */
export function scaleBetween(fromFloorId: string, toFloorId: string): number {
	const to = wupmForFloor(toFloorId);
	const from = wupmForFloor(fromFloorId);
	return from > 0 ? to / from : 1;
}

/**
 * 把一个掩码从某层楼的比例重采样到另一层的比例。
 */
export function resampleRaster(
	data: Uint8Array,
	width: number,
	height: number,
	scale: number
): { data: Uint8Array; width: number; height: number } {
	if (Math.abs(scale - 1) < 1e-6) return { data, width, height };
	const w = Math.max(1, Math.round(width * scale));
	const h = Math.max(1, Math.round(height * scale));
	const out = new Uint8Array(w * h);
	for (let y = 0; y < h; y++) {
		const sy = Math.min(height - 1, Math.max(0, Math.floor(y / scale)));
		const row = sy * width;
		const outRow = y * w;
		for (let x = 0; x < w; x++) {
			const sx = Math.min(width - 1, Math.max(0, Math.floor(x / scale)));
			out[outRow + x] = data[row + sx]!;
		}
	}
	return { data: out, width: w, height: h };
}

/**
 * 设置某楼层比例，并按比例缩放该层 AP 半径，让它们代表的米数不变。
 */
export function setFloorScale(floorId: string, worldUnitsPerMeter: number): void {
	if (!Number.isFinite(worldUnitsPerMeter) || worldUnitsPerMeter <= 0) return;
	const floor = getFloor(floorId);
	if (!floor) return;
	const old = floor.calibration?.worldUnitsPerMeter ?? null;
	floor.calibration = { worldUnitsPerMeter };

	for (const ap of apState.aps) {
		if (ap.floorId !== floorId) continue;
		if (old === null) {
			// 调用时才读：本模块可能处在循环依赖里（persistence 引了优化器），那时 `DEFAULT_WUPM` 还没初始化 ——
			// 以前写成模块级常量，结果算成 NaN，占位半径一直没被提升。
			if (ap.interferenceRadius === uncalibratedRadius()) {
				ap.interferenceRadius = Math.round(15 * worldUnitsPerMeter);
			}
		} else {
			ap.interferenceRadius = Math.round(ap.interferenceRadius * (worldUnitsPerMeter / old));
		}
	}

	scheduleSave();
}
