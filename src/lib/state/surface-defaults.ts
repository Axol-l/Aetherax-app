/**
 * 抬升面卡片
 */
import { appState } from './app.svelte.js';
import { surfaceMaterial, type SurfaceKind, type SurfaceMaterialId } from '$lib/rf/surface-height.js';

/**
 * 选下一个抬升面用哪种类型。
 *
 * 高台按定义是平的，所以选它就把低端高度复制到高端，免得留下图上根本没画出来的高度差；
 * 选台阶或坡道则不动这一对数值，因为它们本身就有高度差含义。
 */
export function chooseSurfaceKind(kind: SurfaceKind): void {
	appState.surfaceKind = kind;
	if (kind === 'platform') {
		appState.surfaceTopHeightM = appState.surfaceHeightM;
	} else if (appState.surfaceTopHeightM <= appState.surfaceHeightM) {
		// 没有高度差的台阶只是个多了几个控件的高台。开局就让它高过低端，
		// 这样刚画出来的第一个就能看出自己是什么。
		appState.surfaceTopHeightM = appState.surfaceHeightM + 1;
	}
}

/**
 * 选下一个抬升面用的面层材质。
 *
 * 材质只是损耗的预设值，不是另一套并行的设置：选了它就把对应数值写进 `surfaceAttenuationDb`，
 * 模型和文档带的就是这个字段。传 `null` 只清掉预设，手填的数值不动。
 */
export function chooseSurfaceMaterial(id: SurfaceMaterialId | null): void {
	appState.surfaceMaterial = id;
	const material = id ? surfaceMaterial(id) : null;
	if (material) appState.surfaceAttenuationDb = material.attenuationDb;
}
