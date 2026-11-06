/** 将跨层路径的楼层边界归属到对应楼层。 */

import type { Band } from '@aetherax/channels';
import type { SlabCrossing } from './cross-floor.js';

/** 独立像素网格上的房间类型掩码，坐标系由调用方决定。 */
export interface RoomTypeSlice {
	roomTypes: Uint8Array | null;
	width: number;
	height: number;
	originX: number;
	originY: number;
}

/** 本计算所需的一个楼层。 */
export interface FloorForSlab {
	id: string;
	/** 相对最低楼层的行走面高度，单位米。 */
	elevation: number;
	/** 层高；吊顶安装接入点的高度为 `elevation + ceilingHeight`。 */
	ceilingHeight: number;
	/** 该楼层所拥有楼板对应频段的材料损耗，单位 dB。 */
	slabLossDb: number;
	/** 该楼层的房间类型，使用调用方采样所在的坐标系。 */
	slice: RoomTypeSlice;
}

export interface CrossingSlabInput {
	/** 所有楼层，**从低到高**排列；`floorPlaneHeights` 依赖此顺序。 */
	floors: readonly FloorForSlab[];
	/** 客户端相对所在楼层的高度，单位米。 */
	clientHeight: number;
	/** 接入点相对**其所在楼层**的高度，单位米。 */
	apHeightM?: number;
	/** 频段，仅用于记录；损耗值已确定。 */
	band: Band;
}

/**
 * 从 `apFloorId` 到 `clientFloorId` 的路径所产生的楼层边界，可直接用于评分。
 */
export function crossingSlabsFor(
	input: CrossingSlabInput,
	apFloorId: string,
	clientFloorId: string
): SlabCrossing[] | null {
	const apIndex = input.floors.findIndex((f) => f.id === apFloorId);
	const clientIndex = input.floors.findIndex((f) => f.id === clientFloorId);
	if (apIndex < 0 || clientIndex < 0 || apIndex === clientIndex) return null;
	const ap = input.floors[apIndex]!;
	const client = input.floors[clientIndex]!;

	const apZ = ap.elevation + (input.apHeightM ?? ap.ceilingHeight);
	const clientZ = client.elevation + input.clientHeight;
	if (Math.abs(clientZ - apZ) < 1e-9) return null;

	// 路径穿越的楼板属于上下端点之间的楼层，按索引取 `(min, max]`：不含低端楼层，含高端楼层。
	// 楼层 `k` 的楼板是 `k - 1` 与 `k` 之间的边界，该半开区间对向上和向下路径都成立。
	// 向上路径中吊顶接入点位于上方楼板底面，射线在 `t = 0` 处即穿过该楼板。
	const loFloor = Math.min(apIndex, clientIndex) + 1;
	const hiFloor = Math.max(apIndex, clientIndex);

	// 汇总方式与 `getFloorSlabAttenuation` 一致：首个计入的楼层取全值，之后各层封顶。
	// 以楼层而非边界为索引，可使各份额之和等于路径实际计入的损耗。
	const applied: number[] = [];
	for (let k = loFloor; k <= hiFloor; k++) {
		const own = input.floors[k]?.slabLossDb ?? 0;
		applied.push(k === loFloor ? own : Math.min(own, ADDITIONAL_FLOOR_DB));
	}
	const total = applied.reduce((a, b) => a + b, 0);

	// **楼层与平面是不同索引，混用不会报错但会算错。** 平面 `p` 是楼层 `p` 的行走面，其楼板属于下方楼层。
	// 计入的楼层为 `loFloor .. hiFloor`，对应平面范围相同，`applied[p - loFloor]` 即该平面的份额。
	const out: SlabCrossing[] = [];
	for (let p = loFloor; p <= hiFloor; p++) {
		const planeZ = input.floors[p]!.elevation;
		const t = (planeZ - apZ) / (clientZ - apZ);
		// 平面落在路径上且 `0 <= t < 1` 时算穿越；吊顶接入点位于上方楼板底面，`t = 0` 仍在路径上。
		if (t < 0 || t >= 1) continue;
		// 空洞由平面 `p` 自身楼层判定：平面就是该层行走面，房间类型也画在该层。
		const owner = input.floors[p];
		if (!owner?.slice.roomTypes) continue;
		out.push({
			t,
			lossShare: total > 0 ? (applied[p - loFloor] ?? 0) / total : 0,
			roomTypes: owner.slice.roomTypes,
			width: owner.slice.width,
			height: owner.slice.height,
			originX: owner.slice.originX,
			originY: owner.slice.originY
		});
	}
	// 按射线遇到的先后排序，与 `crossFloorSplit` 两端顺序一致，向下为自上而下，向上为自下而上。
	out.sort((a, b) => a.t - b.t);
	return out.length > 0 ? out : null;
}

/** 首个之后的楼层边界最多只计入该值，单位 dB；须与 `state/floor-state.svelte.ts` 中的 `ADDITIONAL_FLOOR_DB` 一致。 */
export const ADDITIONAL_FLOOR_DB = 5;
