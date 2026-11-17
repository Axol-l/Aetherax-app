/**
 * 跨层射线在何处换层。
 *
 * 射线从接入点所在楼层穿到客户端所在楼层，水平段需在楼板穿越处拆分，两段分别按各自楼层的墙体掩码计算。
 */

import { isVoidRoomType } from '$lib/domain/room-types.js';

/**
 * AP -> 客户端射线上发生换层的比例位置。
 *
 * `sourceT`、`targetT` 分别为离开接入点楼层与进入客户端楼层的比例，未跨层时均为 0；`apZ`、`clientZ` 为相对最低楼层的高度，`planes` 为各层行走面高度，单位均为米。
 */
export function crossFloorSplit(
	apZ: number,
	clientZ: number,
	planes: readonly number[]
): { sourceT: number; targetT: number } {
	const all = floorPlaneCrossings(apZ, clientZ, planes);
	if (all.length === 0) return { sourceT: 0, targetT: 0 };
	return { sourceT: all[0]!.t, targetT: all[all.length - 1]!.t };
}

/**
 * 射线穿过的一个楼层平面，以几何量而非端点对表示。
 *
 * `t` 为沿 AP -> 客户端射线的比例，`planeZ` 为平面高度，`planeIndex` 为该平面在 `planes` 中的索引。
 */
export interface FloorPlaneCrossing {
	t: number;
	planeZ: number;
	/** 所穿平面在 `planes` 中的索引。 */
	planeIndex: number;
}

/**
 * AP -> 客户端射线**严格在两端点之间**穿过的所有楼层平面，按从接入点向外的顺序排列。
 *
 * 射线高度在两端点间线性插值，平面 `z` 的穿越位置为 `t = (z - apZ) / (clientZ - apZ)`；端点不含在内，因为端点处不拆分路径。
 */
export function floorPlaneCrossings(
	apZ: number,
	clientZ: number,
	planes: readonly number[]
): FloorPlaneCrossing[] {
	const dz = clientZ - apZ;
	// 接入点与客户端等高时位于同一平面，不穿越任何平面。
	if (Math.abs(dz) < 1e-9) return [];

	const out: FloorPlaneCrossing[] = [];
	for (let i = 0; i < planes.length; i++) {
		const planeZ = planes[i]!;
		const t = (planeZ - apZ) / dz;
		// 严格位于两端点之间，端点落在平面上时不算拆分。
		if (t <= 0 || t >= 1) continue;
		out.push({ t, planeZ, planeIndex: i });
	}
	// 按射线遇到的先后排序（而不是按高度），`sourceT`/`targetT` 取该顺序的首尾。
	out.sort((a, b) => a.t - b.t);
	return out;
}

/** 线段 (ax, ay) 到 (bx, by) 上比例 `t` 处的点。 */
export function pointAlong(
	ax: number,
	ay: number,
	bx: number,
	by: number,
	t: number
): { x: number; y: number } {
	return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t };
}

export interface Segment {
	from: { x: number; y: number };
	to: { x: number; y: number };
}

export interface CrossFloorSegments {
	/** 接入点楼层上：从接入点到射线穿过楼板处。 */
	source: Segment;
	/** 客户端楼层上：从射线穿出楼板处到客户端。 */
	target: Segment;
}

/**
 * 跨层路径的两段水平路径。
 *
 * 路径保持在客户端楼层内时返回 null，调用方沿用单层路径。
 */
export function crossFloorSegments(
	sourceT: number,
	targetT: number,
	ax: number,
	ay: number,
	bx: number,
	by: number
): CrossFloorSegments | null {
	if (sourceT <= 0 && targetT <= 0) return null;
	const sourceCross = pointAlong(ax, ay, bx, by, sourceT);
	const targetCross = pointAlong(ax, ay, bx, by, targetT);
	return {
		source: { from: { x: ax, y: ay }, to: sourceCross },
		target: { from: targetCross, to: { x: bx, y: by } }
	};
}

/**
 * 跨层路径的墙体损耗，按单层测量函数分别计算两段。
 *
 * `lossOn(floor, from, to)` 返回某层掩码上直线段的墙体损耗，几何拆分由本模块负责。
 */
export function crossFloorLoss(
	segments: CrossFloorSegments,
	lossOn: (
		floor: 'source' | 'target',
		from: { x: number; y: number },
		to: { x: number; y: number }
	) => number
): number {
	return (
		lossOn('source', segments.source.from, segments.source.to) +
		lossOn('target', segments.target.from, segments.target.to)
	);
}

/**
 * 射线穿过楼板处是否存在空洞。
 *
 * `Void / Atrium` 表示该层楼板开洞，此处不计楼板损耗；楼板属于上方楼层，调用方需传入**上层**的房间类型掩码，坐标原点在此减去。
 */
export function slabIsVoid(
	roomType: Uint8Array | null,
	width: number,
	height: number,
	originX: number,
	originY: number,
	wx: number,
	wy: number
): boolean {
	if (!roomType) return false;
	const x = Math.round(wx - originX);
	const y = Math.round(wy - originY);
	if (x < 0 || y < 0 || x >= width || y >= height) return false;
	return isVoidRoomType(roomType[y * width + x]!);
}

/** 跨层射线经过的一个楼层边界。 */
export interface SlabCrossing {
	/** 射线与楼板相交处沿 AP -> 客户端射线的比例。 */
	t: number;
	/**
	 * 该边界分摊的路径总楼板损耗比例。
	 *
	 * 各边界比例按 `getFloorSlabAttenuation` 的计费方式得出，总损耗大于 0 时总和为 1；豁免部分边界时按比例缩减总损耗。
	 */
	lossShare: number;
	/** 该楼板所属楼层的房间类型掩码，即两层中的上层。 */
	roomTypes: Uint8Array | null;
	width: number;
	height: number;
	originX: number;
	originY: number;
}

/**
 * 跨层路径的楼板损耗系数，每个采样点一个值。
 *
 * `slabIsVoid` 判断单个穿越点是否为空洞，本函数按各边界的分摊比例扣减；结果始终在 `[0, 1]`，只能降低损耗，穿越列表为空时返回 1。
 */
export function slabLossFactor(
	crossings: readonly SlabCrossing[],
	apX: number,
	apY: number,
	sampleX: number,
	sampleY: number
): number {
	let factor = 1;
	for (const c of crossings) {
		const cross = pointAlong(apX, apY, sampleX, sampleY, c.t);
		if (slabIsVoid(c.roomTypes, c.width, c.height, c.originX, c.originY, cross.x, cross.y)) {
			factor -= c.lossShare;
		}
	}
	// 两端截断：比例本应合计为 1，但厚度可由用户输入，负值会在空洞处放大损耗；系数只允许降低损耗。
	return factor < 0 ? 0 : factor > 1 ? 1 : factor;
}
