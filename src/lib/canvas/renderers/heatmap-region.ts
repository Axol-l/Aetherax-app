import { pathLossDb, reachAtLevel } from '$lib/rf/propagation.js';

/** 图像边界所依赖的 AP 字段。 */
export interface RegionAp {
	x: number;
	y: number;
	power: number;
	band: string;
}

export interface RegionMask {
	originX: number;
	originY: number;
	width: number;
	height: number;
}

export interface HeatmapRegion {
	x0: number;
	y0: number;
	cols: number;
	rows: number;
	texel: number;
}

/**
 * 各 AP 覆盖半径的余量，使跨越着色区域边缘的纹素完整落在图像内。
 */
const REACH_MARGIN = 1.05;

/**
 * 覆盖图必须覆盖的世界矩形，以及使单元数不超出预算的纹素尺寸。
 * 矩形由掩码、裁剪轮廓与各 AP 可绘制覆盖半径（降到 `rssiFloor` 的距离）决定，
 * 始终是着色区域的超集；过大时放大纹素；无法得到有效边界时返回 null。
 */
export function heatmapRegion(
	aps: readonly RegionAp[],
	mask: RegionMask | null,
	rssiFloor: number,
	worldUnitsPerMeter: number,
	texelFine: number,
	maxTexels: number,
	/**
	 * 场被裁剪到的轮廓（若存在）。
	 *
	 * 规划区域可能位于平面图掩码之外，图像必须覆盖它，否则裁剪会裁到不含该区域的矩形。
	 */
	clip: ReadonlyArray<{ x: number; y: number }> | null = null
): HeatmapRegion | null {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;

	if (mask) {
		minX = mask.originX;
		minY = mask.originY;
		maxX = mask.originX + mask.width;
		maxY = mask.originY + mask.height;
	}

	if (clip && clip.length >= 3) {
		for (const point of clip) {
			if (point.x < minX) minX = point.x;
			if (point.y < minY) minY = point.y;
			if (point.x > maxX) maxX = point.x;
			if (point.y > maxY) maxY = point.y;
		}
	}

	for (const ap of aps) {
		// pathLossDb(band, 1) 即该频段 1 m 处的参考损耗 PL0。
		const referenceDbm = ap.power - pathLossDb(ap.band, 1);
		const reachInMeters = reachAtLevel(referenceDbm, rssiFloor);
		const reach = reachInMeters * worldUnitsPerMeter * REACH_MARGIN;
		// 电平不高于下限的 AP 不会着色，也不应撑大图像。
		if (!(reach > 0)) continue;
		if (ap.x - reach < minX) minX = ap.x - reach;
		if (ap.y - reach < minY) minY = ap.y - reach;
		if (ap.x + reach > maxX) maxX = ap.x + reach;
		if (ap.y + reach > maxY) maxY = ap.y + reach;
	}

	if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return null;

	// 区域确实超出预算时放大纹素而不是增加分配；
	// 放大只损失细节，不会损失覆盖范围。
	let texel = texelFine;
	const spanX = maxX - minX;
	const spanY = maxY - minY;
	if (spanX * spanY > maxTexels * texel * texel) {
		texel = Math.ceil(Math.sqrt((spanX * spanY) / maxTexels));
	}

	// 把原点向下对齐到纹素格点，避免 AP 轻微移动时图像产生亚纹素位移。
	const x0 = Math.floor(minX / texel) * texel;
	const y0 = Math.floor(minY / texel) * texel;

	return {
		x0,
		y0,
		cols: Math.max(1, Math.ceil((maxX - x0) / texel)),
		rows: Math.max(1, Math.ceil((maxY - y0) / texel)),
		texel
	};
}
