/**
 * 楼层热力图所依据的信号源：其他楼层的每个 AP 也穿过楼板作为固定信号源参与计算。
 * `trackHeatmapInputs()` 读取全部依赖供 effect 追踪，`heatmapApsForFloor(id)` 构建单层信号源列表。
 * `HeatmapSourceAp` 为图层消费的形状：`AccessPoint` 加上跨楼层字段，除楼板数据外均为世界单位。
 */
import type { Band } from '@aetherax/channels';
import type { WallMaterialId } from '$lib/domain/materials.js';
import { apState, apSplitFor, apVerticalOffsetTo } from '$state/ap-state.svelte.js';
import { resampleRaster, scaleBetween } from '$state/floor-scale.js';
import { floorState, getFloorSlabAttenuation } from '$state/floor-state.svelte.js';
import { getFloorMask } from '$state/floor-mask.js';
import { projectMeta } from '$state/project-meta.svelte.js';

/** 热力图视角下的 AP：本楼层自己的，或其他楼层的固定信号源。 */
export type HeatmapSourceAp = (typeof apState.aps)[0] & {
	verticalOffset?: number;
	floorDbPerMeter?: number;
	floorThickness?: number;
	crossFloor?: {
		mask: { data: Uint8Array; width: number; height: number; originX: number; originY: number };
		materialMap: Uint8Array | null;
		defaultMaterial: WallMaterialId;
		sourceT: number;
		targetT: number;
		slabRoomType: {
			data: Uint8Array;
			width: number;
			height: number;
			originX: number;
			originY: number;
		} | null;
		slabT: number;
	} | null;
};

/**
 * 热力图 AP 列表读取的全部输入，两处 effect 都调用它，使依赖列表集中在一处。
 * 读取是刻意的：输入变化即重跑 effect，`void` 用于表达不带值的依赖。
 */
export function trackHeatmapInputs(): void {
	void floorState.currentFloorId;
	for (const f of floorState.floors) {
		void f.ceilingHeight;
		void f.floorThickness;
		void f.floorMaterial;
		void f.level;
		// 标定按楼层保存，覆盖图的世界单位与米换算来自它，
		// 因此任一楼层重新标定都会使瓦片失效。
		void f.calibration?.worldUnitsPerMeter;
		// 掩码也是输入：AP 所在楼层的墙体构成跨楼层路径的一半，
		// 编辑或对齐该楼层都会移动它们。
		void f.wallMask?.dataUrl;
		void f.wallMask?.originX;
		void f.wallMask?.originY;
		void f.materialMask?.dataUrl;
		// 房间类型携带空洞信息，空洞即楼板上的开口。
		void f.roomTypeMask?.dataUrl;
		void f.wallMaterial;
	}
	for (const ap of apState.aps) {
		void ap.x;
		void ap.y;
		void ap.band;
		void ap.channelWidth;
		void ap.interferenceRadius;
		void ap.assignedChannel;
		void ap.power;
		void ap.floorId;
		// 一旦项目建模了安装高度，它就参与每条路径的几何；
		// 图层的缓存键包含它产生的垂直偏移，所以这里的改动必须重建信号源列表，而不只是图像。
		void ap.mountHeightM;
		/*
		 * 天线本身的切分属于图层绘制的内容，改动后必须重建信号源列表：
		 * 图层缓存键包含 `antennaSignature`，但只有画布被标记为需要重绘时才会重新读取。
		 */
		void ap.beamwidthDeg;
		void ap.aimDeg;
		void ap.facingDeg;
	}
	void projectMeta.clientHeight;
}

/**
 * 贡献到某个楼层热力图的全部信号源：本层 AP 满功率，其他楼层 AP 按穿过的楼板衰减。
 * 路径在每次穿板处切分并附带所穿楼板的房间类型，空洞可免除该层损耗；楼层不存在时返回空数组。
 */
export async function heatmapApsForFloor(floorId: string): Promise<HeatmapSourceAp[]> {
	const cur = floorState.floors.find((f) => f.id === floorId);
	if (!cur) return [];

	// 本楼层 AP，按全功率计算。安装高度未启用时同楼层路径是水平的，
	// `apVerticalOffsetTo` 返回 0；启用后则为 AP 到客户端的高差，
	// 与优化器和 worker 使用的是同一项。
	const localAps = apState.aps
		.filter((ap) => ap.floorId === floorId)
		.map((ap) => ({
			...ap,
			verticalOffset: apVerticalOffsetTo(ap, floorId, projectMeta.clientHeight)
		}));

	// 来自其他所有楼层的虚拟 AP，途经的每层楼板都会带来衰减。
	const otherFloors = floorState.floors.filter((f) => f.id !== floorId);
	const sortedFloors = [...floorState.floors].sort((a, b) => a.level - b.level);
	const virtualAps: Array<
		HeatmapSourceAp & {
			/** 该 AP 所在楼层；其掩码在第一次 await 之后获取。 */
			sourceFloorId: string;
			sourceT: number;
			targetT: number;
			/**
			 * 路径所穿楼板归属于两端楼层中的哪一层；
			 * 间隔超过一层（多块楼板且均未建模）时为 null。
			 */
			slabOwner: 'source' | 'target' | null;
			slabT: number;
		}
	> = [];
	for (const adj of otherFloors) {
		const adjAps = apState.aps.filter((ap) => ap.floorId === adj.id);
		if (adjAps.length === 0) continue;

		// 两层之间的楼板总厚度，用于换算每米 dB 值。
		// `apVerticalOffsetTo` 提供垂直项：它考虑 AP 的实际安装位置，
		// 以及客户端高出其所在楼层 `clientHeight` 的部分。
		const loLevel = Math.min(cur.level, adj.level);
		const hiLevel = Math.max(cur.level, adj.level);
		let totalSlabThickness = 0;
		for (const f of sortedFloors) {
			if (f.level < loLevel || f.level >= hiLevel) continue;
			const upperIdx = sortedFloors.findIndex((s) => s.level === f.level + 1);
			if (upperIdx >= 0) {
				// 厚度无论楼板为何种材质都计入：dB 值来自 `getFloorSlabAttenuation`，
				// 它对不认识的材质 id 有回退值，此处不因查询失败而跳过厚度。
				totalSlabThickness += sortedFloors[upperIdx]!.floorThickness;
			}
		}
		// 空洞是上层楼板上的开口。只有一层间隔才对应单块可检验的楼板；
		// 更高的间隔会穿过数块楼板，按累计 dB 计算。
		const oneStorey = Math.abs(adj.level - cur.level) === 1;
		const slabOwner: 'source' | 'target' | null = !oneStorey
			? null
			: adj.level > cur.level
				? 'source'
				: 'target';

		for (const ap of adjAps) {
			const totalDb = getFloorSlabAttenuation(floorId, adj.id, ap.band as Band);
			// 这两项都按 AP 计算：安装位置决定它到客户端的距离，
			// 以及射线与楼层平面的交点，同一楼层的两个 AP 安装方式可以不同。
			const totalVertGap = apVerticalOffsetTo(ap, floorId, projectMeta.clientHeight);
			// 本楼层射线换层的位置，使墙体损耗记到每段实际穿过的楼层上。
			const split = apSplitFor(ap, floorId, projectMeta.clientHeight);
			// 距客户端最近的那次穿越即穿板位置。
			const slabT = split.targetT > 0 ? split.targetT : split.sourceT;
			// 目标楼层的单位：该层的掩码和 AP 都以它为准，
			// 而这个 AP 的位置、覆盖半径和墙体用的是自己楼层的单位。
			const k = scaleBetween(adj.id, floorId);
			virtualAps.push({
				...ap,
				x: ap.x * k,
				y: ap.y * k,
				interferenceRadius: ap.interferenceRadius * k,
				id: `virtual-${ap.id}`,
				verticalOffset: totalVertGap,
				floorDbPerMeter: totalSlabThickness > 0 ? totalDb / totalSlabThickness : 0,
				floorThickness: totalSlabThickness,
				sourceFloorId: adj.id,
				sourceT: split.sourceT,
				targetT: split.targetT,
				slabOwner,
				slabT
			});
		}
	}

	const allAps: HeatmapSourceAp[] = [...localAps, ...virtualAps];

	// 本楼层自己的掩码：读取房间类型 id 所用的网格，
	// 以及本楼层作为穿板归属方时所需的房间类型。
	const self = await getFloorMask(floorId);

	// 解析信号源楼层的掩码需要一次解码，因此列表在解析完成后一次性发布。
	return Promise.all(
		allAps.map(async (ap) => {
			const extra = ap as HeatmapSourceAp & {
				sourceFloorId?: string;
				sourceT?: number;
				targetT?: number;
				slabOwner?: 'source' | 'target' | null;
				slabT?: number;
			};
			const sourceFloorId = extra.sourceFloorId;
			if (!sourceFloorId) return ap;
			const decoded = await getFloorMask(sourceFloorId);
			if (!decoded) return { ...ap, crossFloor: null };
			const srcFloor = floorState.floors.find((f) => f.id === sourceFloorId);
			// 路径以目标楼层的单位行进，因此信号源楼层的墙体和房间类型
			// 先重采样到该单位再交出。
			const k = scaleBetween(sourceFloorId, floorId);
			const walls = resampleRaster(decoded.wallData, decoded.width, decoded.height, k);
			const materials = decoded.materialMap
				? resampleRaster(decoded.materialMap, decoded.width, decoded.height, k)
				: null;
			// 路径所穿楼板归属楼层的房间类型。那里的空洞即开口，可免除穿板损耗。
			// AP 所在楼层为上层时由它拥有该楼板，否则归本楼层，
			// 其房间类型与本掩码共用同一网格。
			let slabRoomType: {
				data: Uint8Array;
				width: number;
				height: number;
				originX: number;
				originY: number;
			} | null = null;
			if (extra.slabOwner === 'source' && decoded.roomTypeData) {
				const roomTypes = resampleRaster(
					decoded.roomTypeData,
					decoded.width,
					decoded.height,
					k
				);
				slabRoomType = {
					data: roomTypes.data,
					width: roomTypes.width,
					height: roomTypes.height,
					originX: decoded.originX * k,
					originY: decoded.originY * k
				};
			} else if (extra.slabOwner === 'target' && self?.roomTypeData) {
				slabRoomType = {
					data: self.roomTypeData,
					width: self.width,
					height: self.height,
					originX: 0,
					originY: 0
				};
			}
			return {
				...ap,
				crossFloor: {
					mask: {
						data: walls.data,
						width: walls.width,
						height: walls.height,
						originX: decoded.originX * k,
						originY: decoded.originY * k
					},
					materialMap: materials?.data ?? null,
					defaultMaterial: (srcFloor?.wallMaterial ?? 0) as WallMaterialId,
					sourceT: extra.sourceT ?? 0,
					targetT: extra.targetT ?? 0,
					slabRoomType,
					slabT: extra.slabT ?? 0
				}
			};
		})
	);
}
