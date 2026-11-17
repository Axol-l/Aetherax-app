/**
 * 布点优化器共用的基础件。
 */
import { updateAp, beginMove } from './ap-state.svelte.js';
import {
	apVerticalOffsetTo,
	DEFAULT_WUPM,
	wupmForFloor,
	type AccessPoint
} from './ap-state.svelte.js';
import { resampleRaster, scaleBetween } from './floor-scale.js';
import type { Band } from '@aetherax/channels';
import { decodeMask } from '$canvas/mask-codec.js';
import { decodeMaterialMask } from '$canvas/region-labels.js';
import { buildRoomDomain } from '$canvas/rooms.js';
import type { SlabCrossing } from '$lib/rf/cross-floor.js';
import { crossingSlabsFor as crossingSlabsForFloors } from '$lib/rf/slab-crossings.js';
import { ROOM_TYPES, isVoidRoomType } from '$lib/domain/room-types.js';
import { floorState, boundarySlabLossDb, floorElevation, floorsByLevel, type Floor } from './floor-state.svelte.js';
import { getFloorMask } from './floor-mask.js';
import { projectMeta } from './project-meta.svelte.js';
import { minRoomRadiusWu } from './room-domain.js';
import type { ApInput } from '../workers/optimizer-protocol.js';
import { apState } from '$state/ap-state.svelte.js';
interface DensityMapResult {
	map: Float32Array;
	medianDensity: number;
	/**
	 * 密度图用的原始房间类型 id。
	 */
	roomTypeData: Uint8Array;
}

/**
 * 逐像素生成设备密度图（Float32Array，尺寸与墙体掩码一致）。
 * 把房间类型的默认密度和逐区域覆盖设置合在一起。
 * 没有房间类型数据时返回 null。
 */

let densityRtMaskRef: unknown = null;
let densityRtData: Uint8Array | null = null;

async function getRoomTypeData(rtMask: {
	dataUrl: string;
	width: number;
	height: number;
}): Promise<Uint8Array> {
	if (densityRtMaskRef === rtMask && densityRtData) return densityRtData;
	densityRtData = await decodeMaterialMask(rtMask.dataUrl, rtMask.width, rtMask.height);
	densityRtMaskRef = rtMask;
	return densityRtData;
}

let densityWallMaskRef: unknown = null;
let densityRoomLabels: Int32Array | null = null;

async function getDensityRoomLabels(
	maskWidth: number,
	maskHeight: number,
	wallMask: { dataUrl: string; width: number; height: number } | null,
	floorId: string
): Promise<Int32Array | null> {

	const wm = wallMask;
	if (!wm) return null;
	if (densityWallMaskRef === wm && densityRoomLabels) return densityRoomLabels;
	const decoded = await decodeMask(wm.dataUrl, wm.width, wm.height);
	const { labels } = buildRoomDomain(decoded.data, maskWidth, maskHeight, {
		minRegionRadius: minRoomRadiusWu(floorId),
		trimWallAdjacent: false
	});
	densityRoomLabels = labels;
	densityWallMaskRef = wm;
	return densityRoomLabels;
}

export async function buildDensityMap(
	maskWidth: number,
	maskHeight: number,
	floor: Floor
): Promise<DensityMapResult | null> {
	const rtMask = floor.roomTypeMask;
	if (!rtMask || rtMask.width !== maskWidth || rtMask.height !== maskHeight) return null;

	const rtData = await getRoomTypeData(rtMask);
	const overrides = floor.roomDensityOverrides ?? {};

	// -1 表示未标注（用中位数当基准），>= 0 表示显式密度（含 0）
	const densityMap = new Float32Array(maskWidth * maskHeight).fill(-1);
	let hasAnyLabeled = false;

	// 房间类型 id -> 默认密度 的查表
	const typeDensity = new Map<number, number>();
	for (const t of ROOM_TYPES) typeDensity.set(t.id, t.defaultDensity);

	// 已标注密度的直方图。中位数只用来给未标注像素当基准，所以只统计不同取值的
	// 个数，就免了每次重建都排序几百万条数据。
	const counts = new Map<number, number>();
	let labeledCount = 0;

	for (let i = 0; i < rtData.length; i++) {
		const typeId = rtData[i]!;
		if (typeId === 0) continue;
		if (isVoidRoomType(typeId)) continue;
		const d = typeDensity.get(typeId) ?? 0;
		densityMap[i] = d;
		counts.set(d, (counts.get(d) ?? 0) + 1);
		labeledCount++;
		hasAnyLabeled = true;
	}

	// 有房间标签时，应用逐区域的密度覆盖
	if (Object.keys(overrides).length > 0) {
		const labels = await getDensityRoomLabels(maskWidth, maskHeight, floor.wallMask, floor.id);
		if (labels) {
			/*
			 * 先按数字建表。逐像素 `overrides[String(regionId)]` 会为六十多万个像素各分配一个
			 * 字符串，一次切到带密度覆盖的楼层就会多花上百毫秒。
			 */
			const overrideByRegion = new Map<number, number>();
			for (const [key, value] of Object.entries(overrides)) overrideByRegion.set(Number(key), value);
			for (let i = 0; i < labels.length; i++) {
				const regionId = labels[i]!;
				if (regionId < 0) continue;
				const override = overrideByRegion.get(regionId);
				if (override === undefined) continue;
				const prev = densityMap[i]!;
				if (prev >= 0) counts.set(prev, (counts.get(prev) ?? 0) - 1);
				else labeledCount++;
				densityMap[i] = override;
				counts.set(override, (counts.get(override) ?? 0) + 1);
				hasAnyLabeled = true;
			}
		}
	}

	if (!hasAnyLabeled) return null;

	// 已标注密度的中位数，从直方图里取。
	let medianDensity = 0.3;
	if (labeledCount > 0) {
		const target = labeledCount >> 1;
		let acc = 0;
		for (const [value, count] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
			if (count <= 0) continue;
			acc += count;
			if (acc > target) {
				medianDensity = value;
				break;
			}
		}
	}

	return { map: densityMap, medianDensity, roomTypeData: rtData };
}

/** 单层优化的产出，交给调用方汇总。 */
export interface FloorOutcome {
	floorId: string;
	/** 该楼层被覆盖的比例，0..1，口径和面板上显示的一样。 */
	coverage: number;
	/** 同频干扰占比，0..1。见 `optimizerState.interference`。 */
	interference: number;
	contention: number;
	/** 干扰占比是按最坏情况估的时候为 false。 */
	interferenceKnown: boolean;
	/** 算它用了多少个采样点，用来给各楼层加权。 */
	samples: number;
	score: number;
	ok: boolean;
	/** AP 会放到哪里，世界坐标。 */
	positions: Array<{ id: string; x: number; y: number }>;
	/**
	 * 该楼层自己方案的冲突图，只在请求图时（`{ graphOnly: true }`）才有。
	 */
	graph?: { pairs: Array<[number, number]>; count: number; weights?: number[] };
	sourceIds?: string[];
}

/** 单层一次运行的行为选项。 */
export interface FloorRunOptions {
	/** PRNG 种子。不填就用 worker 的固定默认值，结果可复现。 */
	seed?: number;
	/**
	 * 设成 false 就是只打分、不落地。多次重启的跑法要先比完几次尝试再定用哪个，
	 * 边算边落地会让方案在几次失败的尝试之间来回跳。
	 */
	apply?: boolean;
	/**
	 * 让 worker 只返回该楼层的冲突图，不做布点。
	 */
	graphOnly?: boolean;
	/**
	 * 这一段用的覆盖率下限，百分比，会盖掉项目设置。
	 */
	floorPct?: number;
	/**
	 * 重启种子从这里往后排：第 i 个重启用 `seedBase + i + 1`。
	 *
	 * 补跑最弱层要用它接着往后走。同一个布局配同一组种子跑出来是同一个结果，所以
	 * 照着重跑只会重放上一轮选中的方案——那一轮就白花了（见 `optimizer-floor-passes.ts`）。
	 * 0 表示还按老样子：单次运行不传 seed，用 Worker 的默认种子。
	 */
	seedBase?: number;
}

/** 把指定 AP 挪到指定世界坐标，整个动作算一步可撤销操作。 */
export function applyPositions(
	positions: Array<{ id: string; x: number; y: number; facingDeg?: number }>
): void {
	beginMove();
	for (const pos of positions) {
		updateAp(
			pos.id,
			pos.facingDeg === undefined
				? { x: pos.x, y: pos.y }
				: { x: pos.x, y: pos.y, facingDeg: pos.facingDeg }
		);
	}
	// 故意改一下状态，保证画布的响应式能触发。
	apState.aps = [...apState.aps];
}

/**
 * 一个 AP 可以用的发射功率（dBm），从高到低。
 */
const POWER_STEP_DB = 3;
const POWER_STEPS = 4;
const MIN_POWER_DBM = 5;

export function powerLevelsFor(configuredPower: number): number[] {
	const levels: number[] = [];
	for (let i = 0; i < POWER_STEPS; i++) {
		const level = configuredPower - i * POWER_STEP_DB;
		if (i > 0 && level < MIN_POWER_DBM) break;
		levels.push(level);
	}
	return levels;
}

/**
 * 把这次运行定下来的发射功率写回去。
 */
export function applyPowers(
	powers: Array<{ id: string; power: number; radius: number }> | undefined
): void {
	if (!powers || powers.length === 0) return;
	beginMove();
	for (const entry of powers) {
		updateAp(entry.id, { power: entry.power, interferenceRadius: entry.radius });
	}
	apState.aps = [...apState.aps];
}

/**
 * 另一层楼的墙体掩码，已解码，并对齐到被优化楼层的掩码坐标系。
 */
export async function sourceFloorMaskFor(
	floorId: string,
	targetOriginX: number,
	targetOriginY: number,
	/**
	 * 结果要用哪个楼层自己的单位。掩码是一个世界单位一个字节，所以标定不同的源楼层
	 * 要重采样到这一层的像素里 —— worker 只走一个坐标系，它不知道索引到的墙是按
	 * 另一套单位量的。
	 */
	targetFloorId: string
): Promise<{
	data: Uint8Array;
	width: number;
	height: number;
	materialMask: Uint8Array | null;
	roomTypeData: Uint8Array | null;
	defaultMaterial: number;
	originX: number;
	originY: number;
} | null> {
	const decoded = await getFloorMask(floorId);
	if (!decoded) return null;
	const floor = floorState.floors.find((f) => f.id === floorId);
	const k = scaleBetween(floorId, targetFloorId);
	const walls = resampleRaster(decoded.wallData, decoded.width, decoded.height, k);
	const materials = decoded.materialMap
		? resampleRaster(decoded.materialMap, decoded.width, decoded.height, k)
		: null;
	const roomTypes = decoded.roomTypeData
		? resampleRaster(decoded.roomTypeData, decoded.width, decoded.height, k)
		: null;
	return {
		data: walls.data,
		width: walls.width,
		height: walls.height,
		materialMask: materials?.data ?? null,
		roomTypeData: roomTypes?.data ?? null,
		defaultMaterial: floor?.wallMaterial ?? 0,
		originX: decoded.originX * k - targetOriginX,
		originY: decoded.originY * k - targetOriginY
	};
}

/**
 * 从 `floor` 层的 AP 到客户端，路径要下降的垂直距离（世界单位）
 */
export function localVerticalDropFor(floor: Floor | undefined): number {
	if (!floor) return 0;
	// 这里以 floor 对象为准：全楼层运行手上可能是个不是当前选中的楼层，
	// 而按 id 去 state 里查，万一列表在运行期间被整个换掉，读到的就是别的楼层的比例尺。
	const wupm = floor.calibration?.worldUnitsPerMeter ?? DEFAULT_WUPM;
	return Math.abs(floor.ceilingHeight - projectMeta.clientHeight) * wupm;
}

/**
 * 一个接入点，按 worker 载荷要的样子拼出来。
 */
export function toApInput(
	ap: AccessPoint,
	frame: { originX: number; originY: number; floorId: string }
): ApInput {
	return {
		id: ap.id,
		x: ap.x - frame.originX,
		y: ap.y - frame.originY,
		interferenceRadius: ap.interferenceRadius,
		band: ap.band,
		// 信道是每个 AP 自己的，移动后要保留：干扰项打的是 solver 上次着色的布局，
		// null 表示"还没分配"，worker 按全部同频（最坏情况）处理。
		assignedChannel: ap.assignedChannel,
		// 锁定信道是约束，不是起点：worker 给每个打分的布局都要重新着色，
		// 所以它必须把锁定的信道当成不能改的。
		fixedChannel: ap.fixedChannel,
		// 着色能用的信道集合，在实际用的带宽上必须互不重叠，而且要和 solver 用同一套。
		channelWidth: ap.channelWidth,
		verticalGap:
			apVerticalOffsetTo(ap, frame.floorId, projectMeta.clientHeight) *
			wupmForFloor(frame.floorId),
		beamwidthDeg: ap.beamwidthDeg,
		horizontalBeamwidthDeg: ap.horizontalBeamwidthDeg,
		aimDeg: ap.aimDeg,
		mount: ap.mount,
		facingDeg: ap.facingDeg
	};
}

export async function crossingSlabsFor(
	apFloorId: string,
	clientFloorId: string,
	clientHeight: number,
	band: Band,
	clientOriginX: number,
	clientOriginY: number,
	clientRoomTypes: Uint8Array | null,
	apHeightM?: number
): Promise<SlabCrossing[] | null> {
	if (apFloorId === clientFloorId) return null;
	const owners = floorsByLevel();
	const decodedByFloor = new Map<
		string,
		{
			roomTypes: Uint8Array | null;
			width: number;
			height: number;
			originX: number;
			originY: number;
		}
	>();
	const floors = await Promise.all(
		owners.map(async (floor) => {
			let slice: {
				roomTypes: Uint8Array | null;
				width: number;
				height: number;
				originX: number;
				originY: number;
			};
			if (floor.id === clientFloorId) {
				// 客户端那层的掩码本来就在自己的坐标系里，所以原点是恒等：
				// 调用方用的是被优化楼层的像素坐标。
				slice = {
					roomTypes: clientRoomTypes,
					width: floor.wallMask?.width ?? 0,
					height: floor.wallMask?.height ?? 0,
					originX: 0,
					originY: 0
				};
			} else {
				const cached = decodedByFloor.get(floor.id);
				if (cached) {
					slice = cached;
				} else {
					const decoded = await getFloorMask(floor.id);
					// 客户端的坐标系用的是被优化楼层的单位；这层的房间类型栅格用的是
					// 自己的单位，所以先重采样、再缩放原点，楼板几何再来索引它。
					const k = scaleBetween(floor.id, clientFloorId);
					const roomTypes = decoded?.roomTypeData
						? resampleRaster(
								decoded.roomTypeData,
								decoded.width,
								decoded.height,
								k
							)
						: null;
					slice = {
						roomTypes: roomTypes?.data ?? null,
						width: roomTypes?.width ?? 0,
						height: roomTypes?.height ?? 0,
						// 两个原点都是世界坐标，各用各的单位 —— 所以先把这个换算成客户端
						// 的单位，再求差。
						originX: (decoded?.originX ?? 0) * k - clientOriginX,
						originY: (decoded?.originY ?? 0) * k - clientOriginY
					};
					decodedByFloor.set(floor.id, slice);
				}
			}
			return {
				id: floor.id,
				elevation: floorElevation(floor.id),
				ceilingHeight: floor.ceilingHeight,
				slabLossDb: boundarySlabLossDb(owners.indexOf(floor), band),
				slice
			};
		})
	);
	return crossingSlabsForFloors({ floors, clientHeight, band, apHeightM }, apFloorId, clientFloorId);
}
