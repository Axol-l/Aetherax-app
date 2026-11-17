/**
 * 抬升面（平台、坡道、楼梯）的高度场。
 *
 * 用一个矩形及两端各自的高度表示：平台两端等高，坡道与楼梯沿走向升高。
 */

export type SurfaceKind = 'platform' | 'ramp' | 'stair';

/** 抬升面甲板所用的材质。 */
export type SurfaceMaterialId = 'concrete' | 'timber' | 'steel' | 'glass';

export interface SurfaceMaterial {
	id: SurfaceMaterialId;
	label: string;
	/** 每次穿越该面计一次的损耗，dB。 */
	attenuationDb: number;
	/** 平面图与 3D 视图绘制该甲板所用的颜色。 */
	color: readonly [number, number, number];
}

/** 未选择材质时甲板的默认颜色。 */
export const DEFAULT_SURFACE_COLOR: readonly [number, number, number] = [196, 132, 74];

/** 工具栏提供的预设材质，按列表顺序排列。 */
export const SURFACE_MATERIALS: readonly SurfaceMaterial[] = [
	{ id: 'concrete', label: 'Concrete', attenuationDb: 20, color: [166, 170, 176] },
	{ id: 'timber', label: 'Timber', attenuationDb: 10, color: [176, 123, 79] },
	{ id: 'steel', label: 'Steel', attenuationDb: 30, color: [124, 138, 154] },
	{ id: 'glass', label: 'Glass', attenuationDb: 6, color: [111, 199, 216] }
];

/** 按 id 查找材质预设；id 未知时返回 null。 */
export function surfaceMaterial(id: SurfaceMaterialId | undefined): SurfaceMaterial | null {
	return SURFACE_MATERIALS.find((material) => material.id === id) ?? null;
}

/** 绘制甲板所用的颜色：材质自带颜色，无材质时为默认颜色。 */
export function surfaceColor(id: SurfaceMaterialId | undefined): readonly [number, number, number] {
	return surfaceMaterial(id)?.color ?? DEFAULT_SURFACE_COLOR;
}

/** 高度场所需的几何：一个矩形和两端各自的高度。 */
export interface SurfaceRect {
	/** 面所占矩形的两个对角点。 */
	ax: number;
	ay: number;
	bx: number;
	by: number;
	/** 可行走面高出本层地面的高度，单位米。 */
	heightM: number;
	/**
	 * 远端高度，单位米。平台时与 `heightM` 相等，坡道与楼梯时高于它。
	 */
	topHeightM: number;
	/**
	 * 甲板在可行走面以下的厚度，单位米。
	 */
	thicknessM?: number;
	/**
	 * 穿越甲板的损耗，dB；路径每次穿越计一次。
	 */
	attenuationDb?: number;
	/**
	 * 甲板材质，作为 `attenuationDb` 的预设；手填损耗的面没有该字段。
	 */
	material?: SurfaceMaterialId;
	/** 甲板下方的空间是否填至地面，供 3D 绘制使用。 */
	solidBase?: boolean;
}

/** 一个抬升区域；矩形用世界坐标单位，高度用米。 */
export interface ElevatedSurface extends SurfaceRect {
	id: string;
	kind: SurfaceKind;
}

/** 归一化为左右、上下边界的矩形，单位是世界坐标单位。 */
export function surfaceBox(surface: SurfaceRect): {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	width: number;
	height: number;
} {
	const x0 = Math.min(surface.ax, surface.bx);
	const x1 = Math.max(surface.ax, surface.bx);
	const y0 = Math.min(surface.ay, surface.by);
	const y1 = Math.max(surface.ay, surface.by);
	return { x0, y0, x1, y1, width: x1 - x0, height: y1 - y0 };
}

/**
 * 点沿走向的位置：低端为 0，高端为 1。
 */
export function runFraction(surface: SurfaceRect, x: number, y: number): number {
	const { x0, y0, width, height } = surfaceBox(surface);
	if (width === 0 && height === 0) return 0;
	// 横向走向指宽度大于高度的走向。
	if (width >= height) {
		const t = width === 0 ? 0 : (x - x0) / width;
		// 走向从靠近 a 的角开始，因此从右向左画的矩形沿该方向升高。
		const forward = surface.bx >= surface.ax;
		return clamp01(forward ? t : 1 - t);
	}
	const t = height === 0 ? 0 : (y - y0) / height;
	const forward = surface.by >= surface.ay;
	return clamp01(forward ? t : 1 - t);
}

function clamp01(value: number): number {
	return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** 世界坐标点位于面矩形内时返回 true。 */
export function surfaceContains(surface: SurfaceRect, x: number, y: number): boolean {
	const { x0, y0, x1, y1 } = surfaceBox(surface);
	return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

/** 单个面在某点的高度，单位米；点在面外时为 0。 */
export function heightOf(surface: SurfaceRect, x: number, y: number): number {
	if (!surfaceContains(surface, x, y)) return 0;
	const low = Number.isFinite(surface.heightM) ? surface.heightM : 0;
	const high = Number.isFinite(surface.topHeightM) ? surface.topHeightM : low;
	if (low === high) return low;
	return low + (high - low) * runFraction(surface, x, y);
}

/**
 * 某点处可行走面的高度，相对本层地面，单位米。
 */
export function surfaceHeightAt(
	surfaces: readonly SurfaceRect[] | null | undefined,
	x: number,
	y: number
): number {
	if (!surfaces || surfaces.length === 0) return 0;
	let best = 0;
	for (const surface of surfaces) {
		const height = heightOf(surface, x, y);
		if (height > best) best = height;
	}
	return best;
}

/** 矩形的四个角点，按绘制顺序排列。 */
export function surfaceCorners(surface: SurfaceRect): Array<{ x: number; y: number }> {
	const { x0, y0, x1, y1 } = surfaceBox(surface);
	return [
		{ x: x0, y: y0 },
		{ x: x1, y: y0 },
		{ x: x1, y: y1 },
		{ x: x0, y: y1 }
	];
}

/** 矩形过小、无实际意义时返回 true；阈值默认 3。 */
export function isDegenerateSurface(surface: SurfaceRect, minSize = 3): boolean {
	const { width, height } = surfaceBox(surface);
	return width < minSize && height < minSize;
}

/** 甲板的默认厚度，单位米。 */
export const DEFAULT_SURFACE_THICKNESS_M = 0.2;

/** 用户未指定时，路径穿越甲板所付的默认损耗，dB。 */
export const DEFAULT_SURFACE_ATTENUATION_DB = 15;

/** 楼梯的踏步深度，即单级踏板的走向长度，单位米。 */
export const STEP_DEPTH_M = 0.3;

/** 该面甲板的厚度，单位米。 */
export function surfaceThickness(surface: SurfaceRect): number {
	return Math.max(0, surface.thicknessM ?? DEFAULT_SURFACE_THICKNESS_M);
}

/** 穿越该面甲板的损耗，dB。 */
export function surfaceAttenuationDb(surface: SurfaceRect): number {
	if (surface.attenuationDb !== undefined) return Math.max(0, surface.attenuationDb);
	return surfaceMaterial(surface.material)?.attenuationDb ?? DEFAULT_SURFACE_ATTENUATION_DB;
}

/**
 * 由升高量与踏步深度算出的楼梯级数，最少为 1。
 */
export function stepCount(surface: SurfaceRect, stepDepthM = STEP_DEPTH_M): number {
	const rise = Math.abs((surface.topHeightM ?? 0) - (surface.heightM ?? 0));
	if (rise <= 0 || stepDepthM <= 0) return 1;
	return Math.max(1, Math.round(rise / stepDepthM));
}

/**
 * 路径在该点穿越的甲板所在面；没有穿越时返回 null。
 */
export function deckCrossing(
	surfaces: readonly SurfaceRect[] | null | undefined,
	x: number,
	y: number,
	gateGapM: number
): { surface: SurfaceRect; lossDb: number } | null {
	if (!surfaces || surfaces.length === 0) return null;
	let best: SurfaceRect | null = null;
	let bestTop = -Infinity;
	for (const surface of surfaces) {
		if (!surfaceContains(surface, x, y)) continue;
		const top = heightOf(surface, x, y);
		if (top <= 0) continue;
		// 该点最高的甲板即客户端所站的面。
		if (top > bestTop) {
			bestTop = top;
			best = surface;
		}
	}
	if (!best) return null;
	if (gateGapM >= -surfaceThickness(best)) return null;
	const lossDb = surfaceAttenuationDb(best);
	return lossDb > 0 ? { surface: best, lossDb } : null;
}

