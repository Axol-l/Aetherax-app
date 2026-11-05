/**
 * 实时覆盖估算：屏幕上这一层有多少在门限之上，供用户布点时看的那根条。
 *
 * 只做一次「计算」，不是一次「运行」：对当前楼层按房间密度采样，报一个百分比。它的缓存
 * （解码后的掩码、采样网格、密度图）也只有这里用，所以从优化器代码里拆了出来。
 */
import { debug } from '$lib/log.js';
import {
	apHeightAboveFloor,
	apSplitFor,
	apVerticalOffsetTo,
	antennaProfileFor,
	wupmForFloor
} from './ap-state.svelte.js';
import { scaleBetween } from './floor-scale.js';
import { antennaRayLossDb } from '$lib/rf/antenna.js';
import { surfaceHeightAt, deckCrossing } from '$lib/rf/surface-height.js';
import { bestReflection } from '$lib/rf/reflection.js';
import { diffractionLossDb, edgesOf } from '$lib/rf/diffraction.js';
import type { Band } from '@aetherax/channels';
import { decodeMask, type DecodedWallMask } from '$canvas/mask-codec.js';
import { decodeMaterialMask } from '$canvas/region-labels.js';
import { getMaterialDbTable } from '$lib/domain/materials.js';
import { buildRoomDomain } from '$canvas/rooms.js';
import { COVERAGE_MARGIN_DB, coverageMarginDb, coverageHorizontalReach, slabDbOf } from '$lib/rf/propagation.js';
import { violatesAt } from '$lib/rf/interference.js';
import { slabLossFactor, type SlabCrossing } from '$lib/rf/cross-floor.js';
import { splitWallRunLoss, wallRunLoss, type WallRun } from '$lib/rf/link-budget.js';
import { floorState, currentFloor, getFloorSlabAttenuation, type Floor } from './floor-state.svelte.js';
import { projectMeta } from './project-meta.svelte.js';
import { wallState } from './wall-state.svelte.js';
import { minRoomRadiusWu } from './room-domain.js';
import { clipInteriorToPlanningArea, isUsablePlanningArea } from './planning-area.js';
import { apState } from '$state/ap-state.svelte.js';
import { canvasState } from '$state/canvas.svelte.js';
import { coverageBasis, dropStaleCoverage, optimizerState, floorCoverage } from './optimizer-state.svelte.js';
import { buildDensityMap, crossingSlabsFor, sourceFloorMaskFor } from './optimizer-support.js';



/** 拖动时被推迟的那次计算，见 `updateCoverage`。 */
let coverageAfterDrag: ReturnType<typeof setTimeout> | null = null;

let cachedMaskUrl: string | null = null;
/** 缓存的掩码原点放在哪。楼层平移时 URL 不会变，所以要单独记。 */
let cachedMaskOriginX = 0;
let cachedMaskOriginY = 0;
let cachedMask: DecodedWallMask | null = null;
let cachedSamples: Array<{ x: number; y: number }> | null = null;
let cachedSamplePixelIdx: number[] | null = null;
/**
 * 密度图和它的输入。为什么缓存见使用处；缓存安不安全全靠这个 key。
 */
let densityCache: Awaited<ReturnType<typeof buildDensityMap>> | null = null;
let densityCacheKey = '';
/** 正在后台构建的那个 key，避免同一个请求重复起两次。 */
let densityBuilding: string | null = null;

/**
 * 在后台算某层的密度图，别卡住用户正在看的那个数字。
 *
 * 先让出一次事件循环——调用方刚跑完一次计算，正排队重渲染——然后再算，按 key 存起来，
 * 再重跑一遍覆盖，让数字变成加权后的结果。递归是安全的：重跑时缓存已经热了，不会再安排构建。
 */
function buildDensityInBackground(
	key: string,
	width: number,
	height: number,
	floor: Floor
): void {
	if (densityBuilding === key) return;
	densityBuilding = key;
	setTimeout(() => {
		void (async () => {
			try {
				const built = await buildDensityMap(width, height, floor);
				// 算的时候楼层或掩码可能已经变了；只保留仍然符合 key 的结果。
				densityCache = built;
				densityCacheKey = key;
				await updateCoverage();
			} catch {
				// 密度图算失败就继续用均匀的那份，数字稍微不准，但不至于坏掉。
			} finally {
				if (densityBuilding === key) densityBuilding = null;
			}
		})();
	}, 0);
}
/** 缓存掩码的逐像素材质 id，没有就是 null。 */
let cachedMaterialData: Uint8Array | null = null;

async function ensureCoverageCache(): Promise<boolean> {
	const mask = wallState.wallMask;
	if (!mask) return false;
	/*
	 * 原点是 key 的一部分，不只是解码副本的一部分。
	 *
	 * 平移楼层会改写掩码原点，像素一个都不变，所以只用 data URL 做 key 会说「什么都没变」，
	 * 采样点还留着对齐前的坐标，而 AP 全都挪过了。这里比的是*存下来的*原点，因为下面给
	 * 副本的正是它。
	 */
	if (
		mask.dataUrl === cachedMaskUrl &&
		(mask.originX ?? 0) === cachedMaskOriginX &&
		(mask.originY ?? 0) === cachedMaskOriginY &&
		cachedMask &&
		cachedSamples
	) {
		return true;
	}

	cachedMask = await decodeMask(mask.dataUrl, mask.width, mask.height);
	// decodeMask 只把 data URL 还原成像素，所以它报的原点永远是 (0,0)。真正的原点存在
	// 存下来的掩码上，画布也是按它偏移的。这里不复制过来，整个函数就是拿掩码坐标的采样点
	// 去比世界坐标的 AP，每个距离都被原点撑大，采样点全都超出 1.5 倍半径的截断，覆盖恒为 0。
	cachedMask.originX = mask.originX ?? 0;
	cachedMask.originY = mask.originY ?? 0;
	cachedMaskUrl = mask.dataUrl;
	cachedMaskOriginX = mask.originX ?? 0;
	cachedMaskOriginY = mask.originY ?? 0;

	// 墙体材质也一起解：没有它，损耗计算分不出真墙和零衰减的虚拟隔断。
	const matMask = wallState.materialMask;
	cachedMaterialData =
		matMask && matMask.width === mask.width && matMask.height === mask.height
			? await decodeMaterialMask(matMask.dataUrl, matMask.width, matMask.height)
			: null;

	// 覆盖采样集：和优化器布点用同一个范围——连哪些区域算房间都一样，所以墙缝不会被当成
	// 需要覆盖的楼面。取的是削过贴墙一圈的版本，因为布点范围就是那样。见 `canvas/rooms.ts`。
	const { interior } = buildRoomDomain(cachedMask.data, mask.width, mask.height, {
		minRegionRadius: minRoomRadiusWu(floorState.currentFloorId),
		trimWallAdjacent: true
	});

	/*
	 * 还有用户画过的规划区域——和「这点在不在里面」那个判断同一个权威来源。少了它，覆盖率
	 * 还是按推断出来的室内区域算，于是轮廓有个大开口的户型会把用户明确排除掉的面积也算进覆盖，
	 * 优化器也会在一块比实际规划更大的区域上被打分。
	 */
	const currentFloorForArea = floorState.floors.find((f) => f.id === floorState.currentFloorId);
	if (isUsablePlanningArea(currentFloorForArea?.planningArea)) {
		clipInteriorToPlanningArea(
			interior,
			mask.width,
			mask.height,
			mask.originX ?? 0,
			mask.originY ?? 0,
			currentFloorForArea!.planningArea!
		);
	}

	const interiorPixels: number[] = [];
	for (let i = 0; i < mask.width * mask.height; i++) {
		if (interior[i]) interiorPixels.push(i);
	}

	/*
	 * 实时覆盖在多少个点上采样。
	 *
	 * 当初一个户型只有一两个 AP，取两百没问题；六层楼时每个采样点都要和楼里每个单元算一遍，
	 * 一次就要一秒左右。一百四十个点在几个百分点内的比例上是够准的——这里本来就是实时读数，
	 * 优化器在 Worker 里用的是自己更大的采样集——工作量却少 30%。
	 */
	const sampleCount = Math.min(140, interiorPixels.length);
	const step = interiorPixels.length / sampleCount;
	cachedSamples = [];
	cachedSamplePixelIdx = [];
	for (let i = 0; i < sampleCount; i++) {
		const idx = interiorPixels[Math.floor(i * step)]!;
		cachedSamples.push({ x: idx % mask.width, y: Math.floor(idx / mask.width) });
		cachedSamplePixelIdx.push(idx);
	}

	return cachedSamples.length > 0;
}

/** 按当前 AP 位置算实时覆盖率 */
export async function updateCoverage(): Promise<void> {
	/*
	 * 在这次计算加上自己那个数之前，先把每个存下来的数字和它声称描述的方案对一遍。
	 *
	 * 覆盖率是一次测量，不是项目的属性，而以前没有任何东西让它失效：挪墙、删 AP 或者撤销，
	 * 面板、整栋楼均值、PDF 报告还是印着上一次的测量值——存盘再打开也一样，因为数字是跟着
	 * 文档一起存的。现在只要依据对不上就丢掉（见 `coverageBasis`），而从文件里恢复的数字
	 * 根本没有依据，所以项目打开时没有覆盖率数字，而不是带着一个过期的，等第一次计算再给出真的。
	 */
	dropStaleCoverage();

	/*
	 * 拖动 AP 的时候不跑。
	 *
	 * 一次计算要拿整层对每个 AP 采样、每一对都推进墙体——真实户型上几十毫秒到一秒。
	 * 等它出来时拖动早就结束了，所以这个数字既迟到又贵：它落在手势中间，造成一次卡顿。
	 * 移动的处理函数里会安排最后一次计算（松手时 `canvasState.isDragging` 变 false），
	 * 所以拖完那一刻数字还是对的。
	 */
	if (canvasState.isDragging) {
		if (coverageAfterDrag) clearTimeout(coverageAfterDrag);
		coverageAfterDrag = setTimeout(() => {
			coverageAfterDrag = null;
			if (canvasState.isDragging) return;
			// 挑空闲帧再算，和存盘一样：这是应用在主线程上最贵的活，
			// 不能压在用户松手的那一帧上。
			if (typeof requestIdleCallback === 'function') {
				requestIdleCallback(() => void updateCoverage(), { timeout: 1200 });
			} else {
				void updateCoverage();
			}
		}, 600);
		return;
	}
	if (apState.aps.length === 0 || !wallState.wallMask) {
		optimizerState.coverage = 0;
		return;
	}

	if (!(await ensureCoverageCache()) || !cachedMask || !cachedSamples) {
		// 这一步失败时覆盖率会静默读成 0、条也消失，跟真的零覆盖分不出来。所以要说清原因。
		console.warn(
			'[optimizer] coverage unavailable:',
			cachedMask ? 'wall mask decoded' : 'wall mask NOT decoded',
			cachedSamples ? 'samples ready' : 'NO interior samples - is any room enclosed by walls?'
		);
		optimizerState.coverage = 0;
		return;
	}

	const { data, width, height } = cachedMask;
	const ox = cachedMask.originX ?? 0;
	const oy = cachedMask.originY ?? 0;
	const wallDb = wallState.wallAttenuation;

	// 各频段的材质表。rayMarchWallAtten 每次调用只收一张表，所以按频段建 Map，
	// 才能让每个 AP 按自己的频段算。表里是「单次穿墙」的固定值（`dbPerMeter × typicalThickness`）：
	// 一堵墙就按材质说的那个损耗算，不取决于图上画多宽、笔刷多宽。
	const materialTables = new Map<Band, number[]>();
	const tablesFor = (band: Band) => {
		let t = materialTables.get(band);
		if (!t) {
			t = getMaterialDbTable(band);
			materialTables.set(band, t);
		}
		return t;
	};

	/*
	 * 密度图缓存起来，不每次重算；某层第一次测量时放到后台去建。
	 *
	 * `buildDensityMap` 要扫整张掩码：室内区域、房间标签、每个像素一个权重。以前以为它便宜，
	 * 就在每次覆盖更新里跑；在百万像素的户型上，它占了那次一秒计算的大头，而 AP 一动就要重算。
	 * 缓存之后拖动从一秒降到 4 ms，但一层楼的*第一次*计算还是要付这笔钱，这就是打开五层楼
	 * 户型并开着热力图时卡一下的原因。
	 *
	 * 所以第一次先用均匀权重量——所有使用方本来就支持，`densityResult` 允许是 null——
	 * 之后再在后台建图，建完重算一次，免得有数字悄悄没加权。key 就是这张图真正读的东西：
	 * 楼层、栅格、房间类型和房间覆盖项。
	 */
	const densityFloor = currentFloor();
	const densityKey = [
		densityFloor.id,
		`${width}x${height}`,
		cachedMaskUrl ?? '',
		wallState.roomTypeMask?.dataUrl ?? '',
		JSON.stringify(densityFloor.roomDensityOverrides ?? {}),
		JSON.stringify(densityFloor.roomCustomLabels ?? {})
	].join('|');
	if (densityKey !== densityCacheKey) {
		if (densityCache) densityCache = null;
		buildDensityInBackground(densityKey, width, height, densityFloor);
	}
	const densityResult = densityCache;
	const baseline = densityResult
		? densityResult.medianDensity > 0
			? densityResult.medianDensity
			: 0.3
		: 0.3;
	const sampleDensity: number[] = [];
	for (let i = 0; i < cachedSamples.length; i++) {
		if (densityResult && cachedSamplePixelIdx) {
			const raw = densityResult.map[cachedSamplePixelIdx[i]!]!;
			sampleDensity.push(raw >= 0 ? raw : baseline);
		} else {
			sampleDensity.push(1);
		}
	}
	// 密度全为 0 就退回均匀权重（免得除零）
	if (Math.max(...sampleDensity) <= 0) {
		for (let i = 0; i < sampleDensity.length; i++) sampleDensity[i] = 1;
	}

	// 把别的楼层的虚拟 AP 也当成固定信号源
	const curFloorId = floorState.currentFloorId;
	const localAps = apState.aps.filter((ap) => ap.floorId === curFloorId);
	const virtualAps: Array<
		(typeof apState.aps)[0] & {
			signalScale: number;
			verticalGapWu: number;
			source: Awaited<ReturnType<typeof sourceFloorMaskFor>>;
			sourceT: number;
			targetT: number;
			/**
			 * 这条路径穿过的每道楼板，带每道楼板所属楼层的房间类型，以及在这里摊掉的总损耗份额。
			 * 什么都测不了时是空数组。
			 *
			 * 按 AP 分开：份额由楼板损耗推出来（与频段有关），穿过的比例由射线斜率决定
			 * （与 AP 装在哪有关）。所以同一层的两个 AP 需要两份列表，相同的部分按引用共用。
			 */
			slabs: SlabCrossing[];
		}
	> = [];
	const wupmForGap = wupmForFloor(curFloorId);
	for (const otherFloor of floorState.floors) {
		if (otherFloor.id === curFloorId) continue;
		const otherAps = apState.aps.filter((ap) => ap.floorId === otherFloor.id);
		if (otherAps.length === 0) continue;
		// 垂直间距既进*距离*也进损耗：隔两层的 AP 是更远，不只是衰减更多。热力图一直是这么算的，
		// 优化器以前没有，两边对「跨层 AP 能打多远」说法不一样。
		//
		// 按 AP 分开，因为装在哪是 AP 的属性：同一层里放桌上的比吊顶的低一米，
		// 到客户端的距离就不一样。路径在楼板处切开，和优化器 Worker、热力图一致：
		// 先走 AP 自己那层的墙到交点，再走本层的墙。
		//
		// 按楼层缓存，所以拖动时不会多解一次图。
		const source = await sourceFloorMaskFor(otherFloor.id, ox, oy, curFloorId);
		// 别的楼层的 AP 坐标和覆盖范围是它自己的单位，而下面的采样点是本层掩码像素，
		// 所以先换算再算距离。
		const k = scaleBetween(otherFloor.id, curFloorId);
		// 楼板损耗和频段有关，所以按每个 AP 自己的频段推，而不是整层套一个 5 GHz 的数。
		// 穿过份额既看频段也看安装高度（射线斜率决定碰到哪些平面、在哪碰），
		// 所以两样都放进 key，一对只建一次列表。
		const slabsByKey = new Map<string, SlabCrossing[]>();
		for (const ap of otherAps) {
			const apHeightM = apHeightAboveFloor(ap);
			const key = `${ap.band}|${apHeightM}`;
			if (!slabsByKey.has(key)) {
				slabsByKey.set(
					key,
					(await crossingSlabsFor(
						otherFloor.id,
						curFloorId,
						projectMeta.clientHeight,
						ap.band,
						ox,
						oy,
						densityResult?.roomTypeData ?? null,
						apHeightM
					)) ?? []
				);
			}
			const split = apSplitFor(ap, curFloorId, projectMeta.clientHeight);
			virtualAps.push({
				...ap,
				x: ap.x * k,
				y: ap.y * k,
				interferenceRadius: ap.interferenceRadius * k,
				signalScale: Math.pow(10, -getFloorSlabAttenuation(curFloorId, otherFloor.id, ap.band) / 10),
				verticalGapWu: apVerticalOffsetTo(ap, curFloorId, projectMeta.clientHeight) * wupmForGap,
				source,
				sourceT: split.sourceT,
				targetT: split.targetT,
				slabs: slabsByKey.get(key) ?? []
			});
		}
	}
	const allAps = [
		...localAps.map((ap) => ({
			...ap,
			signalScale: 1,
			// 同层路径在「安装高度」关掉时是平的，开了之后就是 AP 与客户端的高度差。
			verticalGapWu: apVerticalOffsetTo(ap, curFloorId, projectMeta.clientHeight) * wupmForGap,
			source: null as Awaited<ReturnType<typeof sourceFloorMaskFor>>,
			sourceT: 0,
			targetT: 0,
			slabs: [] as SlabCrossing[]
		})),
		...virtualAps
	];

	// 覆盖就是（按密度加权的）楼面里，落在至少一个 AP 覆盖圈内的比例，也就是接收余量 >= 0 的地方。
	//
	// 以前用的是优化器效用的平均值，那是另一个量却挂着同一个名字：效用会在门限之上 10 dB 处封顶，
	// 所以信号有余量的地方都算满分 1.0，几何一点没变数字也会往 100% 飘。现在「98%」就是字面意思——
	// 采样到的楼面有 98% 在范围内——和热力图按默认门限涂色的那块面积是同一块。
	let coveredWeight = 0;
	let totalWeight = 0;

	/*
	 * 每个采样点上客户端站多高：夹层的桌子比楼面的桌子离吊顶 AP 近两米，楼梯在两者之间爬。
	 * 这个字段单位是米，下面的间距是世界坐标单位，所以在这里换算一次，别到处换。
	 */
	const surfaces = currentFloor().surfaces ?? [];
	const surfaceWupm = wupmForFloor(curFloorId);
	/*
	 * 射线能反射的墙段，以及反射值得找多远。
	 *
	 * 项、模块、频段都跟热力图一样（`rf/reflection.ts`）：每个 AP 一次镜面反射，
	 * 和直射路径按功率相加。墙还是识别出来的栅格的楼层这里为空，因为没有线段可反射。
	 */
	const reflectingWalls = (currentFloor().walls ?? []).map((wall) => ({
		ax: wall.ax,
		ay: wall.ay,
		bx: wall.bx,
		by: wall.by,
		material: wall.material
	}));
	const reflectionReach = 24 * surfaceWupm;
	/** 每个墙头都是刀锋，用来算墙后面的阴影。 */
	const diffractionEdges = reflectingWalls.length > 0 ? edgesOf(reflectingWalls) : [];
	const coverageStarted = performance.now();
	const sampleHeightWu = cachedSamples.map(
		(sample) => surfaceHeightAt(surfaces, sample.x + ox, sample.y + oy) * surfaceWupm
	);

	/*
	 * 干扰在这里按这个方案实际的信道量出来。
	 *
	 * 以前只用优化器运行出来的那个数，而运行是按它自己的一套配色给候选布局打分的——
	 * 运行定好位置之后，求解器用它的调色板（2.4 GHz 三个不重叠信道）重新配了色，
	 * 面板却还在报*上一次*分配下量出来的数。AP 比信道多的户型上，这会读出 0%，
	 * 而实际上有两个单元共用一个信道：这量的是一个根本不存在的方案。
	 *
	 * 干扰项需要每个采样点上各源的余量，而这次计算本来就逐个源算了一份。留着它只多一个
	 * 长度 `allAps.length` 的数组，合并判断每采样点是 O(AP 数²)——跟上面的墙体推进比可以忽略。
	 */
	const channels = allAps.map((ap) => ap.assignedChannel ?? 0);
	/** 每个 AP 都有信道，所以这是个实测值，不是上界。 */
	const channelsKnown = channels.every((channel) => channel > 0);
	const margins = new Float64Array(allAps.length);
	let degradedWeight = 0;

	for (let i = 0; i < cachedSamples.length; i++) {
		const sample = cachedSamples[i]!;
		let bestMargin = -Infinity;
		margins.fill(-Infinity);
		let sourceIndex = 0;
		for (const ap of allAps) {
			// 这个源在 `margins` 里的下标，要在循环体能 `continue` 之前先取好：
			// 被跳过的源保持 -Infinity，目标函数存的也是这个值。
			const index = sourceIndex++;
			const dx = sample.x - (ap.x - ox);
			const dy = sample.y - (ap.y - oy);
			// AP 和客户端的高度差，再减掉客户端脚下踩的东西。带符号：站在夹层上两米的客户端，
			// 可能比放桌上的 AP 还*高*。
			const vertical = ap.verticalGapWu - (sampleHeightWu[i] ?? 0);
			const horiz = Math.sqrt(dx * dx + dy * dy);
			/*
			 * 先看距离，而且按**最好情况**：一个源在没有任何楼板、没有墙的理想条件下最远能到哪。
			 *
			 * 五层楼的户型上，每个采样点以前都要为全楼每个 AP 掏钱——楼板豁免、跨层分段、
			 * 墙体推进——连隔了五层、根本贡献不了什么的单元也不例外。这个判断只是一次减法两次乘法，
			 * 能在最贵的那部分之前把它们剔掉。它只会偏保守：比的是零损耗时的上限，
			 * 这里过不了的源，后面真正的判断也过不了。
			 */
			if (horiz > coverageHorizontalReach(ap.interferenceRadius, 0, 0)) continue;
			// 跨层路径按三维算，和热力图一致。客户端可以站在楼面之上，所以高度差带符号，
			// 距离取它的绝对值。
			const dist = vertical !== 0 ? Math.hypot(horiz, vertical) : horiz;
			// 和优化器 Worker 同一个 dB 域核。`coverageReach` 是余量耗尽的 3D 距离，
			// 所以水平距离的判断要把垂直间距已经吃掉的那部分扣掉。
			//
			// 豁免必须在那个判断*之前*定：按整块楼板的损耗算，3D 可达距离可能比垂直间距还短，
			// 于是源在还没人发现楼板是个洞之前就被扔了。
			const slabDb = slabDbOf(ap.signalScale);
			// 空洞就是楼板上开了个洞，穿过的射线在这一道边界少摊一份。间距越大穿过的边界越多，
			// 所以这是对整张穿越列表的一个系数，不是一个是非标记。
			const crossings = ap.slabs;
			const slabLoss =
				crossings && crossings.length > 0
					? slabDb * slabLossFactor(crossings, ap.x - ox, ap.y - oy, sample.x, sample.y)
					: slabDb;
			if (horiz >= coverageHorizontalReach(ap.interferenceRadius, slabLoss, vertical)) continue;
			// 按材质算，和优化器 Worker、热力图一致：每次穿墙从材质表里取一个固定值，
			// 所以零衰减的虚拟隔断不花损耗，有材质的就按它自己测出来的数。建两段路径、
			// 在楼板处切开，用的是 Worker 和热力图同一段推进代码（`rf/link-budget.ts`）。
			const targetRun: WallRun = {
				mask: data,
				width,
				height,
				materialMask: cachedMaterialData,
				materialDb: tablesFor(ap.band),
				fallbackDb: wallDb,
				originX: ox,
				originY: oy,
				defaultMaterialId: wallState.wallMaterial
			};
			const sourceRun: WallRun | null = ap.source
				? {
						mask: ap.source.data,
						width: ap.source.width,
						height: ap.source.height,
						materialMask: ap.source.materialMask,
						materialDb: tablesFor(ap.band),
						// 路径按这个 AP 的垂直间距往下走，所以它穿材质的那条路比平面路径长。
						// 比例按**整条**射线算，不是分段算：一条直线只落一个间距，两半共用一个比例。
						fallbackDb: ap.source.materialMask
							? (tablesFor(ap.band)[ap.source.defaultMaterial] ?? wallDb)
							: wallDb,
						originX: ap.source.originX,
						originY: ap.source.originY,
						defaultMaterialId: ap.source.defaultMaterial
					}
				: null;
			// 路径离开本层时要在两张图上各推进一段：先走 AP 自己那层到楼板交点，
			// 再从交点走本层到采样点。
			const splitLoss = sourceRun
				? splitWallRunLoss(
						sourceRun,
						targetRun,
						ap.sourceT,
						ap.targetT,
						{ x: ap.x - ox, y: ap.y - oy },
						{ x: sample.x, y: sample.y },
						1
					)
				: null;
			let dbLoss =
				splitLoss ??
				wallRunLoss(targetRun, { x: ap.x - ox, y: ap.y - oy }, { x: sample.x, y: sample.y }, 1);
			// 单看墙那部分：它既是 `dbLoss` 的一项，也是「这条路径被挡住了吗」的判断，
			// 而挡住的时候才轮到绕射来补。
			const wallLossDb = dbLoss;
			// 空洞就是楼板上的洞，射线从那儿过就不付楼板损耗。
			dbLoss += slabLoss;
			// AP 和站在平台上的客户端之间隔了一个平台：从下面过来的路径要穿过它，
			// 平台的衰减就是干这个的。只有站在平台上的采样点才可能穿，先拿这个挡一下省算。
			const deck =
				(sampleHeightWu[i] ?? 0) > 0
					? deckCrossing(surfaces, sample.x + ox, sample.y + oy, vertical / surfaceWupm)
					: null;
			if (deck) dbLoss += deck.lossDb;
			// 天线的方向图，从这条射线的几何算：同层十米外的 AP 大致在直立全向天线的峰值方向，
			// 正上方的则落在甜甜圈的弱区——壁挂的还多一个正反面。和热力图一致。
			dbLoss += antennaRayLossDb(antennaProfileFor(ap), vertical, dx, dy);
			const margin = coverageMarginDb(dist, ap.interferenceRadius) - dbLoss;
			if (margin > bestMargin) bestMargin = margin;
			if (margin > margins[index]!) margins[index] = margin;
			/*
			 * 绕过墙头的绕射，墙挡得越多它的分量越大。
			 *
			 * 和热力图同一套刀锋模型、同一条斜坡、同一份记忆化的系数（`rf/diffraction.ts`）：
			 * 以前用一个「挡住 / 没挡住」的硬阈值，图上就会画出一道台阶，因为这一项是突然出现的，
			 * 不是渐变的。
			 */
			const diffractionGate = Math.min(1, Math.max(0, (wallLossDb - 3) / 6));
			if (diffractionGate > 0 && diffractionEdges.length > 0) {
				const loss = diffractionLossDb(
					{ x: ap.x - ox, y: ap.y - oy },
					{ x: sample.x, y: sample.y },
					diffractionEdges,
					ap.band as '2.4ghz' | '5ghz' | '6ghz'
				);
				if (loss > 0) {
					const diffractedMargin =
						coverageMarginDb(dist, ap.interferenceRadius) -
						(wallLossDb + loss) +
						(dbLoss - wallLossDb);
					const blended = margin + diffractionGate * (diffractedMargin - margin);
					if (blended > bestMargin) bestMargin = blended;
					if (blended > margins[index]!) margins[index] = blended;
				}
			}
			/*
			 * 墙的镜像，热力图也是这么加的。
			 *
			 * 先折射再反射的路径没有建模；反射光线是到达采样点的第二条路，所以单独算它的余量，
			 * 采样点取两条里更好的那个——「任一条过门限就算覆盖」，对连最强服务 AP 的客户端来说就是这个意思。
			 */
			if (reflectingWalls.length > 0) {
				const bounce = bestReflection(
					{ x: ap.x - ox, y: ap.y - oy },
					{ x: sample.x, y: sample.y },
					reflectingWalls,
					ap.band as Band,
					reflectionReach
				);
				if (bounce) {
					const reflectedMargin =
						coverageMarginDb(bounce.length, ap.interferenceRadius) +
						10 * Math.log10(bounce.powerRatio);
					if (reflectedMargin > bestMargin) bestMargin = reflectedMargin;
					if (reflectedMargin > margins[index]!) margins[index] = reflectedMargin;
				}
			}
		}
		const w = sampleDensity[i] ?? 1;
		// `coverageMarginDb` 是相对关联门限（-85 dBm）量的，所以覆盖门限（-70 dBm）
		// 还得单独卡一道。
		if (bestMargin >= COVERAGE_MARGIN_DB) coveredWeight += w;
		/*
		 * 和目击函数打分用的范围一样：超出范围的源，客户端根本听不到，算不上干扰。
		 * 见 Worker 里的 `fillMargins`。
		 */
		for (let k = 0; k < margins.length; k++) {
			if (!(margins[k]! > 0)) margins[k] = -Infinity;
		}
		if (channelsKnown && violatesAt(margins, channels, allAps.length, 0, null)) degradedWeight += w;
		totalWeight += w;
	}

	optimizerState.coverage = totalWeight > 0 ? Math.round((coveredWeight / totalWeight) * 100) : 0;
	/*
	 * 干扰数字说的是*这个*方案、用*这些*信道。
	 *
	 * 它和覆盖率由同一次计算刷新，所以不会描述一个后来已经变掉的布局或分配——而从优化器运行
	 * 带过来的数字就会。还没有分配时没什么可量，就告诉面板没有，而不是显示一个 0。
	 */
	optimizerState.interferenceMeasured = channelsKnown && totalWeight > 0;
	optimizerState.interferenceKnown = channelsKnown;
	if (channelsKnown && totalWeight > 0) {
		optimizerState.interference = Math.round((degradedWeight / totalWeight) * 100);
	}
	// 计时：这次计算是本应用主线程上最重的活，而判断要不要搬到 Worker，唯一依据就是它在真实户型上花多久。
	debug(
		`[coverage] ${cachedSamples.length} samples × ${apState.aps.length} APs in ${Math.round(performance.now() - coverageStarted)} ms`
	);

	// 缓存每层的覆盖率（用采样点数当面积权重）
	floorCoverage.set(curFloorId, {
		coverage: optimizerState.coverage,
		samples: cachedSamples.length,
		// 这个数字描述的是哪套方案：有了依据，后来的计算才能扔掉按已经挪过的墙量出来的数。
		// 见 `coverageBasis`。
		basis: coverageBasis(curFloorId)
	});
}