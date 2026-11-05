/**
 * 布点优化器共用的基础件。
 *
 * 载荷转换、密度图、跨楼层楼板列表、功率下调，搜索（`optimizer.svelte.ts`）和实时覆盖
 * 估算（`optimizer-coverage.svelte.ts`）都要用；这些都是几何和换算，不是状态，
 * 所以放在这里，两个调用方都不用背。
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
	 *
	 * 空洞不贡献密度，但会改变几何：优化器得知道哪些像素是洞，而密度 0 本身
	 * 也是房间的合法取值，光看密度分不出来。
	 */
	roomTypeData: Uint8Array;
}

/**
 * 逐像素生成设备密度图（Float32Array，尺寸与墙体掩码一致）。
 * 把房间类型的默认密度和逐区域覆盖设置合在一起。
 * 没有房间类型数据时返回 null。
 */
// ─── 密度图输入的缓存 ────────────────────────────────────────────────────
//
// 密度覆盖值每拖一次滑块就变，但跟它一起算的输入不变。每拖一次都重算，意味着
// 两次 PNG 解码、一次形态学闭运算、一次连通域标记，再对每个标记过的像素排序
// —— 滑块卡顿就是这么来的。
//
// 按存储的掩码包装对象的引用缓存。内容一变整个对象就换掉，所以用引用当键是
// 可靠的，也省得每次都比较几 MB 的 data URL。

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
	// 从参数传进来，而不是去读 `wallState`：它只存*当前*楼层的掩码，
	// 而全楼层运行会算到屏幕上没显示的那些楼层。
	const wm = wallMask;
	if (!wm) return null;
	if (densityWallMaskRef === wm && densityRoomLabels) return densityRoomLabels;
	const decoded = await decodeMask(wm.dataUrl, wm.width, wm.height);
	// 要房间，不要空腔：这份结果决定目标函数怎么给采样点加权，而墙体夹缝不是
	// 有人活动的房间。这里不裁掉墙边像素，因为墙边像素仍属于用户画的那个房间，
	// 而且下面读覆盖设置用的画布标签也没裁。见 `canvas/rooms.ts`。
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
		// 空洞是个洞，不是房间。把它当成密度 0 的房间会把中位数基准压低，
		// 让所有未标注像素都变得更不值钱 —— 跟洞该起的作用正好相反。
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
			for (let i = 0; i < labels.length; i++) {
				const regionId = labels[i]!;
				if (regionId < 0) continue;
				const override = overrides[String(regionId)];
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
	/**
	 * 有两个重叠信道的 AP 都超过 CCA 门限时的空中时间占比，0..1。
	 * 只上报，不参与优化。见 `optimizerState.contention`。
	 */
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
	 * `sourceIds` 按 worker 的顺序给出载荷里各源的 id —— 先是自带 AP，再是锁定 AP ——
	 * 这样 `pairs` 就能当 AP id 读。见 `buildAssignmentConflictEdges`。
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
	 * 让 worker 只返回该楼层的冲突图，不做布点。给 solver 用：它要给着色和
	 * 目标函数打分用同一张图。这时不搜索、也不落地，`apply` 写什么都不管。
	 */
	graphOnly?: boolean;
	/**
	 * 这一段用的覆盖率下限，百分比，会盖掉项目设置。
	 *
	 * 只有全楼层运行会设：A1 的整栋保证是按 *block* 逐块保证的，
	 * 所以下限要挂在 block 上，不能挂在项目上。
	 */
	floorPct?: number;
}

/** 把指定 AP 挪到指定世界坐标，整个动作算一步可撤销操作。 */
export function applyPositions(
	positions: Array<{ id: string; x: number; y: number; facingDeg?: number }>
): void {
	beginMove();
	for (const pos of positions) {
		// 壁挂的朝向也是"放在哪"的一部分：落在哪面墙决定它朝哪边看，
		// 所以位置和朝向一起写。
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
 *
 * 从配置功率往下每 3 dB 一档，最多降 12 dB，且不低于 5 dBm。这趟是*发射功率控制*
 * （802.11h）：只为把方案用不上的覆盖收回来，不是把设备的能力全试一遍。步长再粗会
 * 跳过复用带消失的那段区间，再细只会成倍增加评估，而这点差别目标函数分不出来。
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
 *
 * 要和位置一起、当成同一步撤销操作落地：按 14 dBm 打分、却按 20 dBm 显示，那就不是
 * 目标函数量过的那个方案。worker 回来的半径已经按本应用的口径算好，两个一起写，
 * 存下来的缓存和功率才一致，下次加载时 `refreshApRanges` 就什么都不用做。
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
 *
 * 跨楼层路径其实是两段、两个户型：先是 AP 自己那层从 AP 到穿楼板处，然后才是客户端
 * 那层的墙。以前优化器整段都按客户端的户型算，三层楼里每段跨层路径有三分之二被
 * 错的户型衰减掉了。
 *
 * 那层楼没有掩码时返回 null，路径就不分段，模型和原来一样。走的是共用的每层缓存，
 * 所以实时覆盖估算挂上它也不会多解一次 PNG。
 *
 * 路径几何（哪次跨越量哪个户型、各自分摊多少楼板损耗）在 `rf/slab-crossings.ts` 里，
 * 单测不用浏览器就能跑。
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
		// 任一层做过对齐之后，两层掩码的原点就不在一起了；而且这个偏移量本身是
		// 源楼层单位下的 —— 所以先把源原点换算过来，再表示成相对目标原点的值。
		originX: decoded.originX * k - targetOriginX,
		originY: decoded.originY * k - targetOriginY
	};
}

/**
 * 从 `floor` 层的 AP 到客户端，路径要下降的垂直距离（世界单位）：AP 挂在该层天花板，
 * 客户端在楼层平面上方 `clientHeight` 处。
 *
 * 链路*损耗*故意把同层路径按 2D 算 —— 几十米的水平距离上 1.2 m 落差只占百分之几 ——
 * 但墙体步进不能这么算：它计的是射线穿过材料的长度，所以墙体那份按固定值给，
 * 不跟着落差变。
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
 *
 * 以前这段是各处复制的对象字面量，载荷很容易漏掉模型要读的字段：漏了 `mount` 不会
 * 编译报错，只会悄悄变成"竖直全向天线"。类型 `ApInput` 在 `optimizer-protocol.ts`
 * 里从应用自己的 `AccessPoint` 派生，所以天线字段一改，这里和别的调用方都会编译报错。
 *
 * 有两件事 worker 自己做不了，都是坐标换算，不是拷贝：
 *  - AP 按**世界**坐标存，而 worker 索引的是楼层自己的掩码，掩码从 `(originX, originY)`
 *    开始（掩码按 256 px 分块生成，可能伸进负坐标区）；
 *  - 到客户端的垂直落差是楼层几何，只有这边有（`apVerticalOffsetTo`，世界单位）。
 *
 * 天线字段原样传过去：那是硬件属性，worker 按采样点自己算方向图。
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
		// 见 `planningChannels`。
		channelWidth: ap.channelWidth,
		verticalGap:
			apVerticalOffsetTo(ap, frame.floorId, projectMeta.clientHeight) *
			wupmForFloor(frame.floorId),
		beamwidthDeg: ap.beamwidthDeg,
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
	/**
	 * AP 在它自己那层楼上的高度，米。不填就按该层天花板算，也就是有挂高概念之前
	 * 这套几何假设的挂法；射线的斜率 —— 因而它撞上哪些平面、撞在哪 —— 由它决定。
	 */
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
