/**
 * 设置楼层比例，同时让这层的 AP 保住原来的物理尺寸。
 *
 * 标定按楼层来：一栋楼里可能混着不同分辨率的图纸，以前项目级设置会在标定二层时覆盖一层。
 * 比例本身只是楼层上的一个字段；另一半工作是 AP 半径 —— 它按世界单位存，单位一变实际覆盖范围就会悄悄变。
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
 *
 * 比例 40 单位/米的楼层上，x 点离原点 x/40 米；画在 20 单位/米的坐标里就是 (x/40)*20 = x*0.5。
 * 凡是把两层放在一起算的地方（跨层优化路径、信道求解、总览卡片）都要这个系数，且必须算法一致。
 */
export function scaleBetween(fromFloorId: string, toFloorId: string): number {
	const to = wupmForFloor(toFloorId);
	const from = wupmForFloor(fromFloorId);
	return from > 0 ? to / from : 1;
}

/**
 * 把一个掩码从某层楼的比例重采样到另一层的比例。
 *
 * 掩码每个世界单位一个字节，两层比例不同时不能直接混用：按它索引的射线会用错单位来量墙。
 * 用最近邻，和掩码其余部分的约定一致（一个像素就是一个世界单位，墙和地面之间不做插值）。
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
 *
 * 只动这一层的 AP：单位是各层自己的，去缩放没改比例的楼层反而会改它的实际覆盖。
 * 楼层第一次标定时还会把占位半径换成真实的 15 米 —— 就是图纸还没说明一米多长时编辑器显示的那个数。
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
