/**
 * 优化器
 */
import { debug } from '$lib/log.js';
import {
	apHeightAboveFloor,
	apSplitFor,
	apVerticalOffsetTo,
	wupmForFloor
} from './ap-state.svelte.js';
import { scaleBetween } from './floor-scale.js';
import type { Band, ChannelWidth } from '@aetherax/channels';
import { scheduleSave } from './persistence.svelte.js';
import { t } from './i18n.svelte.js';
import { buildRoomDomain } from '$canvas/rooms.js';
import type { SlabCrossing } from '$lib/rf/cross-floor.js';
import { isVoidRoomType } from '$lib/domain/room-types.js';
import { OptimizerBridge, type OptimizeProgress } from '../workers/optimizer-bridge.js';
import { floorState, getFloor, getFloorSlabAttenuation } from './floor-state.svelte.js';
import { getFloorMask } from './floor-mask.js';
import { projectMeta } from './project-meta.svelte.js';
import { WALL_BAND_M, wallSnapForFloor } from './wall-snap.js';
import { minRoomRadiusWu } from './room-domain.js';
import { isUsablePlanningArea } from './planning-area.js';
import type { ApInput } from '../workers/optimizer-protocol.js';
import { apState } from '$state/ap-state.svelte.js';
import { coverageBasis, optimizerState, floorCoverage, scoringSettingsSignature } from './optimizer-state.svelte.js';
import { MAX_FLOOR_PASSES, nextFloorPass } from './optimizer-floor-passes.js';
import { applyPositions, applyPowers, buildDensityMap, crossingSlabsFor, localVerticalDropFor, powerLevelsFor, sourceFloorMaskFor, toApInput, type FloorOutcome, type FloorRunOptions } from './optimizer-support.js';



const bridge = new OptimizerBridge();

/**
 * 第二个 Worker，只用来算冲突图。
 */
const graphBridge = new OptimizerBridge();
let runAbort: AbortController | null = null;

/**
 * 跑一层的优化。
 */
async function optimizeFloor(
	floorId: string,
	opts: FloorRunOptions = {},
	signal?: AbortSignal
): Promise<FloorOutcome> {
	const apply = opts.apply !== false;
	const floor = getFloor(floorId);
	const nothing: FloorOutcome = {
		floorId,
		coverage: 0,
		interference: 0,
		contention: 0,
		interferenceKnown: true,
		samples: 0,
		score: 0,
		ok: false,
		positions: []
	};

	if (apState.aps.length === 0) return nothing;
	// 在耗时的部分之前先问一次——掩码解码、密度图、数据装配之后才检查，
	// 就会为一次已经取消的运行白干一层。
	if (signal?.aborted) return nothing;
	/*
	 * 这一层的户型几何，以当前最新的模型为准。
	 *
	 * 画了墙段的楼层就地生成掩码：墙段才是模型。Worker 的数据和求解器的图都走这里，
	 * 所以没打开过的楼层（存的还是画墙之前的旧掩码，或者根本没有）也会按墙段来优化。
	 * 存下来的掩码最多只当边框用。
	 */
	const hasWalls = (floor?.walls ?? []).length > 0;
	if (!floor || (!floor.wallMask && !hasWalls)) {
		// 只有屏幕上这层才值得报错；全楼运行时，没有户型的楼层直接跳过就行。
		if (!opts.graphOnly && floorId === floorState.currentFloorId) {
			optimizerState.error = t('Load a floorplan first');
		}
		return nothing;
	}

	try {
		const decodedFloor = await getFloorMask(floorId);
		if (!decodedFloor) return nothing;
		const mask = {
			width: decodedFloor.width,
			height: decodedFloor.height,
			originX: decodedFloor.originX,
			originY: decodedFloor.originY
		} as { width: number; height: number; originX: number; originY: number };
		const curFloorId = floorId;

		// 墙体掩码的原点在世界坐标的 (originX, originY)，不是 0：TiledMask 按 256 px
		// 的瓦片网格铺开，可能伸到负坐标。发给 Worker 的数据要先平移成掩码局部坐标，
		// 回来的结果再平移回去。热力图早就这么做了，优化器以前漏了，结果就整体偏了一段。
		const originX = mask.originX ?? 0;
		const originY = mask.originY ?? 0;

		// 只优化当前楼层的 AP；只有一层时就全算
		const singleFloor = floorState.floors.length === 1;
		const onThisFloor = apState.aps.filter((ap) => singleFloor || ap.floorId === curFloorId);
		/*
		 * 钉住的 AP 不由优化器移动，而是当成固定信号源传下去——形状和别的楼层的 AP 一样，
		 * 只是不跨楼板。它照样服务客户端、照样计分、照样参与配色，只是位置不动。
		 * 其余都是可移动的 AP，壁挂的也算：它们的可放范围是沿墙的一条带（见下面的 `wallBandWu`）。
		 */
		const pinnedAps = onThisFloor.filter((ap) => ap.pinned);
		const localAps: ApInput[] = onThisFloor
			.filter((ap) => !ap.pinned)
			.map((ap) => toApInput(ap, { originX, originY, floorId: curFloorId }));

		if (localAps.length === 0) {
			if (!opts.graphOnly && floorId === floorState.currentFloorId) {
				optimizerState.error =
					pinnedAps.length > 0
						? t(
								'Every access point on this floor is pinned in place: there is nothing for the optimiser to move.'
							)
						: t('No APs on this floor');
			}
			return nothing;
		}

		// 别的楼层的「虚拟 AP」——固定信号源，不移动
		const fixedAps: Array<{
			/** 带上它，算图时才知道一条边的两头是谁。 */
			id: string;
			x: number;
			y: number;
			interferenceRadius: number;
			signalScale: number;
			/** 到这一层的垂直距离，世界坐标单位。 */
			verticalGap: number;
			/** 这个 AP 的天线切角。见 Worker 里的 `ApInput.beamwidthDeg`。 */
			beamwidthDeg: number;
			aimDeg: number;
			mount: string;
			facingDeg: number;
			band: Band;
			/** 这个 AP 的信道，没有就是 null。干扰项要读它。 */
			assignedChannel: number | null;
			/** 用户钉死的信道，没钉就是 null。对配色来说是个约束。 */
			fixedChannel: number | null;
			/** 信道宽度，用来算不重叠的信道表。见 `planningChannels`。 */
			channelWidth: ChannelWidth;
			source?: {
				data: Uint8Array;
				width: number;
				height: number;
				materialMask: Uint8Array | null;
				defaultMaterial: number;
				originX: number;
				originY: number;
			} | null;
			sourceT?: number;
			targetT?: number;
			/** 这条路径穿过的每一道楼板；一道都测不了时是空数组。 */
			slabs: SlabCrossing[];
		}> = [];
		const wupmCur = wupmForFloor(curFloorId);
		/*
		 * 把这一层钉住的 AP 当成固定源。
		 *
		 * 同层的路径不穿楼板，所以它们没有 `source`、没有 `slabs`，`signalScale` 是 1——
		 * 和覆盖计算里本地 AP 的形状一样，区别只是 Worker 不许移动它。
		 * 配色器照样看得见它，因为钉住的 AP 一样抢空口时间。
		 */
		for (const ap of pinnedAps) {
			fixedAps.push({
				// 字段和可移动 AP 用同一个映射函数，只多两样固定源才有的：
				// 楼板系数 1（同层路径不穿楼板）和空的墙体切分数据。
				...toApInput(ap, { originX, originY, floorId: curFloorId }),
				signalScale: 1,
				slabs: []
			});
		}
		// 在循环之前就解码好：判断楼板时要这一层自己的房间类型（当 AP 在两层中较低那层时）。
		const densityResult = await buildDensityMap(mask.width, mask.height, floor);
		for (const otherFloor of floorState.floors) {
			if (otherFloor.id === curFloorId) continue;
			const otherAps = apState.aps.filter((ap) => ap.floorId === otherFloor.id);
			if (otherAps.length === 0) continue;
			// 每个别的楼层只解码一次，不要每个 AP 解一次：射线切分要的是 AP 所在层的墙，
			// 一个 AP 解一次 PNG 太离谱。
			const source = await sourceFloorMaskFor(otherFloor.id, originX, originY, curFloorId);
			// 空洞就是楼板上开了个洞，这条射线在这一道边界上少摊一份总损耗。路径每穿过一道
			// 边界就在自己的交点处单独判断，所以两层挑空只是免掉两道里的一道，不是全免也不是全收。
			//
			// 按频段分开算：分摊比例由楼板损耗推出来，而楼板损耗和频段有关（混凝土 2.4 GHz
			// 是 75 dB/m，5 GHz 是 100）。也按安装高度分：射线的斜率决定它碰到哪些平面、在哪碰。
			// 如果拿第一个 AP 算一份给所有 AP 用，其他 AP 就背上了它的几何，结果还会随列表顺序变。
			const slabsByKey = new Map<string, SlabCrossing[]>();
			// 垂直间距和分摊也按 AP 各算各的，同理：放桌上的 AP 比吊顶的低，到客户端的距离不一样。
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
							originX,
							originY,
							densityResult?.roomTypeData ?? null,
							apHeightM
						)) ?? []
					);
				}
			}
			// 别的楼层用的是它自己的单位，而 Worker 按本层的单位走，所以坐标、半径和上面的源掩码
			// 都要按两个标定之间的那个比例换算。
			const k = scaleBetween(otherFloor.id, curFloorId);
			for (const ap of otherAps) {
				const key = `${ap.band}|${apHeightAboveFloor(ap)}`;
				const split = apSplitFor(ap, curFloorId, projectMeta.clientHeight);
				const slabDb = getFloorSlabAttenuation(curFloorId, otherFloor.id, ap.band);
				fixedAps.push({
					id: ap.id,
					x: ap.x * k - originX,
					y: ap.y * k - originY,
					interferenceRadius: ap.interferenceRadius * k,
					signalScale: Math.pow(10, -slabDb / 10),
					verticalGap:
						apVerticalOffsetTo(ap, curFloorId, projectMeta.clientHeight) * wupmCur,
					// 固定 AP 的天线方向图也要算：正是它说明楼上的 AP 往侧面比往下更能打到下一层，
					// 而楼上壁挂的 AP 在这一层同样有正反两面。
					beamwidthDeg: ap.beamwidthDeg,
					aimDeg: ap.aimDeg,
					mount: ap.mount,
					facingDeg: ap.facingDeg,
					band: ap.band,
					assignedChannel: ap.assignedChannel,
					fixedChannel: ap.fixedChannel,
					channelWidth: ap.channelWidth,
					source,
					sourceT: split.sourceT,
					targetT: split.targetT,
					slabs: slabsByKey.get(key) ?? []
				});
			}
		}

		/*
		 * 掩码本身已经解好了：`getFloorMask` 要么从墙段现推，要么解开存的 PNG，这里不用再解一次。
		 * 这样 Worker 拿到的几何和别的调用方读到的是同一份。
		 */
		const decoded = { data: decodedFloor.wallData, width: decodedFloor.width, height: decodedFloor.height };

		// 按材质算墙体损耗：用本层网格上的逐像素材质图，让 Worker 按频段给每种材质算单次穿墙衰减。
		const materialMask = decodedFloor.materialMap;

		// 算图请求：把和一次真实运行完全一样的数据交给 Worker，换回冲突图，这样求解器配出来的颜色
		// 正好就是目标函数随后要量的东西。上面这些装配（掩码局部坐标、跨层固定 AP 及其分摊、密度图）
		// 走的都是真实运行的路径，这正是重点：另起一套装配算图，就是两个标准开始跑偏的原因。
		if (opts.graphOnly) {
			const graphResult = await graphBridge.optimize(
				localAps,
				decoded.data,
				mask.width,
				mask.height,
				floor.wallAttenuation,
				{
					fixedAps,
					densityMap: densityResult?.map ?? null,
					medianDensity: densityResult?.medianDensity ?? 0,
					materialMask,
					roomTypeMask: densityResult?.roomTypeData ?? null,
					defaultMaterial: floor.wallMaterial,
					metersPerPixel: 1 / wupmCur,
					allowOutside: projectMeta.allowOutsideRooms,
					regulatoryDomain: apState.regulatoryDomain,
					coverageSoftnessDb: projectMeta.coverageSoftnessDb,
					pathLossScenario: projectMeta.pathLossScenario,
					coverageThresholdDbm: projectMeta.coverageThresholdDbm,
					// 求解器配色的图必须和运行计分时用的是同一个客户高度，
					// 所以这部分几何也得传，不然有夹层的地方两边就会对不上。
					surfaces: (floor.surfaces ?? []).map((surface) => ({
						ax: surface.ax - originX,
						ay: surface.ay - originY,
						bx: surface.bx - originX,
						by: surface.by - originY,
						heightM: surface.heightM,
						topHeightM: surface.topHeightM
					})),
					graphOnly: true
				}
			);
			if (graphResult.error) {
				// The graph build also runs from the automatic channel solver. A failure there
				// is not a user-initiated placement attempt, so it must not open the placement
				// warning; the real optimize run reports the same problem when it is asked for.
				return nothing;
			}
			return {
				...nothing,
				ok: true,
				samples: graphResult.sampleCount ?? 0,
				graph: graphResult.graph,
				// 顺序跟 Worker 一致：先本层 AP，再固定 AP。
				sourceIds: [...localAps.map((a) => a.id), ...fixedAps.map((f) => f.id ?? '')]
			};
		}

		const result = await bridge.optimize(
			localAps,
			decoded.data,
			mask.width,
			mask.height,
			floor.wallAttenuation,
			{
				fixedAps,
				densityMap: densityResult?.map ?? null,
				medianDensity: densityResult?.medianDensity ?? 0,
				materialMask,
				roomTypeMask: densityResult?.roomTypeData ?? null,
				defaultMaterial: floor.wallMaterial,
				metersPerPixel: 1 / wupmCur,
				allowOutside: projectMeta.allowOutsideRooms,
				// B4：功率也是决策变量，以每个 AP 配置上限的「降低档」形式给出来。这一步只能降——
				// 升上去等于凭空多出用户没配的能力——而且只在精确目标函数严格变好时才降，所以
				// 降了也没好处的 AP 保持原样。见 `refinePower`。
				powerLevelsDbm: localAps.map((ap) =>
					powerLevelsFor(apState.aps.find((a) => a.id === ap.id)?.power ?? 20)
				),
				worldUnitsPerMeter: wupmCur,
				// 同层路径有、但路径损耗模型故意忽略的那部分衰减。墙体推进不能忽略它：
				// 射线穿过的材质是要计损耗的。
				localVerticalDrop: localVerticalDropFor(floor),
				// 壁挂 AP 的可用带，换成物理深度：Worker 按世界坐标索引掩码，自己不知道比例。
				// 最后贴到哪个墙面由 `wallSnapForFloor` 决定。
				wallBandWu: WALL_BAND_M * wupmCur,
				// 什么算一个房间，得和 App 自己的「这点在不在室内」判断一致。见 `room-domain.ts`——
				// 两边不共用同一套范围，优化出来的 AP 就会落进墙缝里。
				minRoomRadiusWu: minRoomRadiusWu(curFloorId),
				/*
				 * 用户画了规划区域的话，按掩码坐标传过去。Worker 会把布点范围裁剪到这块区域，
				 * 和 App 自己的判断用同一个裁剪——这样「画出楼层范围」对警告和优化器同时生效，
				 * 两边不会对「楼层在哪」有分歧。
				 */
				planningArea: isUsablePlanningArea(floor.planningArea)
					? floor.planningArea!.map((point) => ({
							x: point.x - originX,
							y: point.y - originY
						}))
					: null,
				/*
				 * 抬升面，坐标系和规划区域一样。Worker 自己生成采样网格，所以每个采样点上的
				 * 客户高度要从这里读——夹层会改变该点到各 AP 的垂直间距。
				 */
				surfaces: (floor.surfaces ?? []).map((surface) => ({
					ax: surface.ax - originX,
					ay: surface.ay - originY,
					bx: surface.bx - originX,
					by: surface.by - originY,
					heightM: surface.heightM,
					topHeightM: surface.topHeightM,
					thicknessM: surface.thicknessM,
					attenuationDb: surface.attenuationDb
				})),
				// 用户自定义材质，让 Worker 按用户填的数值算，而不是套内置的默认值。
				customMaterials: projectMeta.customMaterials.map((material) => ({
					id: material.id,
					name: material.name,
					dbPerMeter: {
						'2.4ghz': material.dbPerCrossing / Math.max(0.01, material.thicknessM),
						'5ghz': material.dbPerCrossing / Math.max(0.01, material.thicknessM),
						'6ghz': material.dbPerCrossing / Math.max(0.01, material.thicknessM)
					},
					typicalThickness: material.thicknessM,
					color: material.color
				})),
				// F3 的 ε-约束。0 表示不约束，也就是这个功能之前的那些数值所用的目标函数。
				// 每层的开关改的是「要求针对谁」，不是怎么执行：这里只给一层打分，所以填的永远是这层自己的数。
				coverageFloor: (opts.floorPct ?? projectMeta.coverageFloorPct) / 100,
				onProgress: (p: OptimizeProgress) => {
					/*
					 * 进度条跟着每一次搜索走，得分只跟最终留下的那次走。
					 *
					 * 重启是用 `apply: false` 跑的，以前的判断会直接 return，于是四次重启的运行里
					 * 进度条四个整搜索都不动，看起来像卡死而不是在干活。进度算整次运行的进度，
					 * 不管来自哪次重启；得分不能这么算，因为输掉的重启不是屏幕上这次运行的结果。
					 */
					optimizerState.progress = Math.round((p.iteration / p.totalIterations) * 100);
					if (!apply) return;
					optimizerState.score = Math.round(p.score * 100);
				},
				seed: opts.seed,
				// 整次运行只用一个权重，取自项目设置，这样一次运行和它的 A/B 对照只差这一项。
				interferenceWeight: projectMeta.interferenceWeight,
				// 目标函数的阈值：采样点比覆盖门限低多少以内还算有得分。见 `DEFAULT_COVERAGE_SOFTNESS_DB`。
				coverageSoftnessDb: projectMeta.coverageSoftnessDb,
				// 距离项用的传播环境。Worker 读不到项目状态，所以每次运行都得带上。
				pathLossScenario: projectMeta.pathLossScenario,
				// 覆盖门限同理：改变了这一项，运行结果和面板的那根条才会一致。
				coverageThresholdDbm: projectMeta.coverageThresholdDbm,
				// 把监管域传过去，Worker 才会重新配色：它由此知道各频段的信道表和所有钉死的信道，
				// 于是每个布局都按它自己当时最优的分配来评分，而不是沿用搜索挪动之前的旧分配。
				regulatoryDomain: apState.regulatoryDomain
			}
		);

		// Worker 放不下任何东西时会带一个原因回来（比如没识别出封闭的室内区域）。要显示出来：
		// 否则用户只看到 AP 停在原地，也没有任何解释。
		if (result.error) {
			if (floorId === floorState.currentFloorId) {
				optimizerState.error = result.error;
				optimizerState.progress = 0;
			}
			return nothing;
		}

		// 优化器是随机的，所以把它用的随机种子记下来。不然下次结果不同，你分不清是模型变了
		// 还是种子变了，前后对比就没意义了。
		debug(
			`[optimizer] seed ${result.seed}, score ${result.score.toFixed(4)}, improvement ${result.improvement.toFixed(2)}%` +
				`, coverage ${(result.coverage * 100).toFixed(1)}%` +
				`, co-channel interference ${((result.interference ?? 0) * 100).toFixed(1)}%` +
				`, contended (CCA) ${((result.contention ?? 0) * 100).toFixed(1)}%` +
				(result.channelsKnown === false ? ' (all-co-channel bound: no assignment yet)' : '') +
				(result.reverted ? ' — the search scored worse than its own input, input kept' : '')
		);
		// 设了 ε-约束就把它结果打出来：用户设了约束而运行完全不提，跟被忽略没区别。
		if (projectMeta.coverageFloorPct > 0) {
			const floor = projectMeta.coverageFloorPct;
			const covered = (result.coverage * 100).toFixed(1);
			debug(
				(result.shortfall ?? 0) > 0
					? `[optimizer] coverage floor ${floor}%, reached ${covered}% — short by ${((result.shortfall ?? 0) * 100).toFixed(1)} points`
					: `[optimizer] coverage floor ${floor}%, reached ${covered}% — met`
			);
		}
		// 发射功率那一步的结论，以及没改动时为什么没改。报「没降」和报「降了」一样重要：
		// 干扰准则是相对最强服务 AP 来比电平的，降功率往往只是把「两个 AP 落进复用距离内」
		// 的那段区间整体挪一挪，并不会让它变窄，所以降了没收益就应当拒绝。这里不出声会被当成没跑。
		{
			const powers = result.powers ?? [];
			const lowered = powers.filter((p) => {
				const ap = apState.aps.find((a) => a.id === p.id);
				return ap && p.power < ap.power;
			});
			if (powers.length === 0) {
				debug('[optimizer] transmit power: not offered to this run');
			} else if (lowered.length === 0) {
				debug(
					`[optimizer] transmit power: every level tested was a tie or worse, so all ` +
						`${powers.length} AP(s) keep their configured power`
				);
			} else {
				debug(
					`[optimizer] transmit power lowered on ${lowered.length} of ${powers.length} AP(s): ` +
						lowered.map((p) => `${p.id}→${p.power} dBm`).join(', ')
				);
			}
		}
		// 用来回答「这个覆盖率看着不对」的诊断：单个 AP 的覆盖圈和它所在的整层比有多大？
		// 如果半径跟整个户型差不多大，覆盖率虚高是算术结果而不是 bug——而户型没标定比例
		// 通常就是半径这么大的原因。
		{
			const wupm = wupmCur;
			const floorAps = apState.aps.filter((a) => a.floorId === curFloorId);
			const maxRadius = floorAps.length
				? Math.max(...floorAps.map((a) => a.interferenceRadius))
				: 0;
			debug(
				`[optimizer] ${floorAps.length} AP(s) on this floor; largest coverage radius ` +
					`${(maxRadius / (wupm || 1)).toFixed(1)} m = ${maxRadius} world units at ${wupm} units/m`
			);
		}

		// 拿 Worker 用的同一份室内区域再独立校验一遍，AP 落到外面时把几何信息报出来。
		// 这个失败模式平时看不出来：优化器说成功了，AP 却停在莫名其妙的地方。
		if (!projectMeta.allowOutsideRooms) {
			// 必须和 Worker 布点时的范围一样，否则这个检查就是拿 AP 和另一块室内区域比，
			// 连「哪些区域算房间」都可能不同。见 `canvas/rooms.ts`。
			const { interior: check } = buildRoomDomain(decoded.data, mask.width, mask.height, {
				minRegionRadius: minRoomRadiusWu(curFloorId),
				trimWallAdjacent: true
			});
			// 和 Worker 的排除规则保持一致，否则明明是 Worker 故意放进空洞的，
			// 这里会读成「AP 落到了室内区域外面」。
			const rtData = densityResult?.roomTypeData;
			if (rtData && rtData.length === check.length) {
				for (let i = 0; i < check.length; i++) {
					if (check[i] && isVoidRoomType(rtData[i]!)) check[i] = 0;
				}
			}
			let count = 0;
			let minX = Infinity;
			let minY = Infinity;
			let maxX = -1;
			let maxY = -1;
			for (let i = 0; i < check.length; i++) {
				if (!check[i]) continue;
				count++;
				const x = i % mask.width;
				const y = (i / mask.width) | 0;
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
			const outside = result.positions.filter((p) => {
				// 壁挂 AP 本来就该贴着墙，而检查用的室内区域恰好把贴墙那一圈削掉了。
				// 它的范围是墙边那条带，Worker 已经管过了。
				const ap = apState.aps.find((a) => a.id === p.id);
				if (ap?.mount === 'wall') return false;
				const ix = Math.round(p.x);
				const iy = Math.round(p.y);
				if (ix < 0 || ix >= mask.width || iy < 0 || iy >= mask.height) return true;
				return check[iy * mask.width + ix] !== 1;
			});
			if (outside.length > 0) {
				optimizerState.error =
					`${outside.length} of ${result.positions.length} AP(s) ended up outside the detected interior. ` +
					`Mask is ${mask.width}x${mask.height}; interior covers ${count} px` +
					(count > 0 ? ` in [${minX},${minY}]-[${maxX},${maxY}]` : '') +
					`. See the console for details.`;
			}
		}

		// 优化后的位置平移回世界坐标并取整，这样和原值明显不同，才能触发响应式更新。
		const worldPositions: Array<{ id: string; x: number; y: number; facingDeg?: number }> = [];
		for (const pos of result.positions) {
			const x = Math.round(pos.x) + originX;
			const y = Math.round(pos.y) + originY;
			/*
			 * 墙边带只是「范围」，不是落点，所以壁挂 AP 在这里被精确贴到墙面上——用的是编辑器
			 * 选安装方式时同一个测量，顺手也能得到朝向。这样优化器留下的位置和朝向，用户自己
			 * 手动也点得出来，而不会离墙差一个支架的厚度。
			 */
			const ap = apState.aps.find((a) => a.id === pos.id);
			if (ap?.mount === 'wall') {
				const snap = await wallSnapForFloor(floorId, x, y, wupmForFloor(floorId));
				if (snap) {
					worldPositions.push({
						id: pos.id,
						x: Math.round(snap.apX),
						y: Math.round(snap.apY),
						facingDeg: Math.round(snap.facingDeg)
					});
					continue;
				}
			}
			worldPositions.push({ id: pos.id, x, y });
		}

		// 多次重启的运行要先比较再选定，所以「应用」是调用方的决定，不是跑完的副作用。
		if (apply) {
			applyPositions(worldPositions);
			applyPowers(result.powers);
			optimizerState.score = Math.round(result.score * 100);
			scheduleSave();
		}

		return {
			floorId,
			coverage: result.coverage,
			interference: result.interference ?? 0,
			contention: result.contention ?? 0,
			interferenceKnown: result.channelsKnown ?? true,
			samples: result.sampleCount,
			score: result.score,
			ok: true,
			positions: worldPositions
		};
	} catch (err) {
		if (err instanceof Error && err.message === 'Cancelled') {
			// 用户主动取消，不算错误
		} else {
			optimizerState.error = err instanceof Error ? err.message : t('Optimization failed');
		}
		return nothing;
	}
}

/**
 * 自动分配信道时要配色的那张冲突图。
 *
 * 逐层用优化器自己的数据、走它自己的余量计算（`optimizer-worker.ts` 里的 `fillMargins`）建出来，
 * 这样求解器看到的边，就是目标函数随后要量的边。这正是重点：求解器以前自己按覆盖圆重叠加
 * 一个 AP 间距离经验公式建图，在实测的四 AP 楼层上两边对不上——求解器配出来的方案在目标函数的
 * 图上算出 14.75% 干扰，而同一张图正经配色是 0%。
 *
 * 建不出图的楼层（没有可采样的封闭室内、没有户型图）报 `complete: false`，由调用方决定怎么办；
 * 这里不会凭空造一张量不出来的图。
 *
 * 边是无向的，用 AP id 标识。没有 AP 的楼层不贡献任何东西：优化器从来不给它打分，
 * 把它算进来，分配用的图就又和目标函数的图不是同一张了。
 */
export async function buildAssignmentConflictEdges(): Promise<{
	edges: Array<[string, string]>;
	/**
	 * 每条边的代价，键和边一样（id 排序后用 `"a:b"`）。
	 *
	 * 只在走廊一角相遇的一对，和整片服务区都重叠的一对，都算一条边，配色器以前分不出轻重。
	 * 这里补的就是这个数：一个源的采样点里，有多少同时落在另一个源的复用门限内（按密度加权）。
	 * 见 `conflictWeights`。
	 */
	weights: Map<string, number>;
	complete: boolean;
	floors: number;
	samples: number;
}> {
	const edges = new Map<string, [string, string]>();
	const weights = new Map<string, number>();
	let complete = true;
	let floors = 0;
	let samples = 0;
	const multiFloor = floorState.floors.length > 1;
	for (const floor of floorState.floors) {
		// 单层项目一次就把所有 AP 优化完（见 `optimizeFloor`），所以第一层就是整张图。
		// 多层项目是一层一层打分的，没有 AP 的楼层根本不会打分。
		if (multiFloor && !apState.aps.some((ap) => ap.floorId === floor.id)) continue;
		const outcome = await optimizeFloor(floor.id, { apply: false, graphOnly: true });
		if (!outcome.ok || !outcome.graph || !outcome.sourceIds) {
			complete = false;
			if (!multiFloor) break;
			continue;
		}
		floors++;
		samples += outcome.samples;
		const ids = outcome.sourceIds;
		const pairWeights = outcome.graph.weights;
		const count = outcome.graph.count;
		for (const [i, j] of outcome.graph.pairs) {
			const a = ids[i];
			const b = ids[j];
			if (!a || !b) continue;
			const key = [a, b].sort().join(':');
			edges.set(key, [a, b]);
			// 跨两层的一对会在两层的图里各出现一次；取较大的那个，而不是相加，
			// 相加会把两层共用的采样点算两遍。
			const w = pairWeights ? (pairWeights[i * count + j] ?? 0) : 1;
			weights.set(key, Math.max(weights.get(key) ?? 0, w));
		}
		if (!multiFloor) break;
	}
	return { edges: [...edges.values()], weights, complete, floors, samples };
}

/**
 * 单层运行和全楼运行共用的防重入与进度清理。
 *
 * `isRunning` 放在这里而不是 `optimizeFloor` 里面：全楼运行会反复调用它，
 * 放到里面的话第二次调用就会把整次运行掐掉。
 */
async function withOptimizerRun(body: (signal: AbortSignal) => Promise<unknown>): Promise<void> {
	if (optimizerState.isRunning) return;
	optimizerState.isRunning = true;
	optimizerState.progress = 0;
	optimizerState.score = 0;
	optimizerState.error = null;
	optimizerState.status = '';
	const abort = new AbortController();
	runAbort = abort;
	try {
		await body(abort.signal);
		// 时间戳打在这里而不是 `body` 里面，这样单层按钮和全楼按钮跑完都会记上。
		// 布点建议面板靠它判断有没有新的测量结果可用。取消的运行不算：它停在半路，
		// 留在图上的东西不是最后一个数字描述的样子。
		if (!abort.signal.aborted) {
			optimizerState.lastRunAt = Date.now();
			// 同一个时刻记下评分设置：之后再改设置，面板就能说清屏幕上的布局是按旧值选的。
			optimizerState.settingsAtRun = scoringSettingsSignature();
		}
	} finally {
		if (runAbort === abort) runAbort = null;
		optimizerState.isRunning = false;
		optimizerState.status = '';
	}
}

/** 提交某一层胜出的结果，并刷新描述它的那些数字。 */
function commitFloorOutcome(floorId: string, outcome: FloorOutcome): void {
	applyPositions(outcome.positions);
	optimizerState.score = Math.round(outcome.score * 100);
	// 面板上的数字说的是屏幕上这一层。交替运行时大多数楼层不是它，
	// 把别的层的数写进来，面板就会标错楼层。
	if (floorId === floorState.currentFloorId) {
		optimizerState.coverage = Math.round(outcome.coverage * 100);
		optimizerState.interference = Math.round(outcome.interference * 100);
		optimizerState.contention = Math.round(outcome.contention * 100);
		optimizerState.interferenceKnown = outcome.interferenceKnown;
		optimizerState.interferenceMeasured = true;
	}
	floorCoverage.set(floorId, {
		coverage: Math.round(outcome.coverage * 100),
		samples: outcome.samples,
		// Keep the measured device load; the optimizer only replaces the coverage number.
		devices: floorCoverage.get(floorId)?.devices,
		devicesSource: floorCoverage.get(floorId)?.devicesSource,
		// 这次运行量过这一层，所以这个数字说的是它刚提交的方案。
		basis: coverageBasis(floorId)
	});
	scheduleSave();
}

/**
 * 优化一层，可以换几个随机种子重复跑，取最好的那个。
 *
 * 这是性价比最高的一项改进。Oustry 等人（Networks 81(1), 2023）的报告说，光是给贪心布点器
 * 加重启（他们的 GH1 换 GH2，纯机械改动，不含任何建模内容）就带来均值 11%、中位数 6% 的提升；
 * 而贵得多的「布点与信道分配交替迭代」只有均值 7%、**中位数 0%**。在他们结果里重启比模型更值钱。
 * 这个优化器在固定种子下是随机的，所以换种子重跑就是同一招。
 *
 * 各次重启的分布也要打出来，不能只报冠军。这是本项目唯一能衡量「还剩多少空间」的指标：
 * 没有它，重启次数就是瞎猜——如果每次都落在同一个得分上，多跑几遍纯属浪费；如果散得开，
 * 说明搜索还有东西没捞到。
 *
 * `seedBase` 让补跑接着上一轮的种子区间往下排。同一个布局配同一组种子是确定性的，不换种子
 * 的话这一轮只会原样重放上一轮选中的方案，那个块就白花了（见 `runAlternatingPasses` 里补跑那段）。
 *
 * 两个入口都走这里，所以单层按钮和交替运行里的「优化一层」是同一回事。
 */
async function optimizeFloorBest(
	floorId: string,
	restarts: number,
	apply: boolean,
	extra: FloorRunOptions = {},
	signal?: AbortSignal
): Promise<FloorOutcome | null> {
	const n = Math.max(1, Math.floor(restarts));
	const seedBase = Math.max(0, Math.floor(extra.seedBase ?? 0));

	if (n === 1) {
		// 没有指定种子区间时保持老路径：不传 seed，用 Worker 的默认种子。
		const one = await optimizeFloor(
			floorId,
			seedBase > 0 ? { ...extra, seed: seedBase + 1, apply } : { ...extra, apply },
			signal
		);
		if (!one.ok) return null;
		if (apply) commitFloorOutcome(floorId, one);
		return one;
	}

	const scores: number[] = [];
	let best: FloorOutcome | null = null;
	for (let i = 0; i < n; i++) {
		if (signal?.aborted) break;
		optimizerState.status = t('Restart {index} of {count}', { index: i + 1, count: n });
		// 种子取 1..n（加上 `seedBase`）而不是随机的，这样多次重启和单次运行一样可复现。
		const outcome = await optimizeFloor(
			floorId,
			{ ...extra, seed: seedBase + i + 1, apply: false },
			signal
		);
		if (!outcome.ok) continue;
		scores.push(outcome.score);
		if (!best || outcome.score > best.score) best = outcome;
	}

	if (scores.length > 0) {
		const lo = Math.min(...scores);
		const hi = Math.max(...scores);
		const spread = lo > 0 ? ((hi - lo) / lo) * 100 : 0;
		debug(
			`[optimizer] ${scores.length} restarts: ${scores.map((s) => s.toFixed(4)).join(', ')}` +
				` — best ${hi.toFixed(4)}, spread ${spread.toFixed(2)}%`
		);
	}

	if (best && apply) commitFloorOutcome(floorId, best);
	return best;
}

/** 优化屏幕上当前这一层。 */
export async function runOptimizer(): Promise<void> {
	await withOptimizerRun((signal) =>
		optimizeFloorBest(floorState.currentFloorId, optimizerState.restarts, true, {}, signal)
	);
}

/**
 * 逐层优化，一层优化时其他层固定不动，反复几轮直到整栋楼的数字不再上升。
 *
 * 一层一次、其余层冻结，就是块坐标下降。每一轮都不会让任何一层变差，所以序列是单调的，
 * 一轮不再有收益就可以停。除此之外没有收敛保证：目标函数不是凸的，后面的轮次可能把 AP
 * 挪到另一个同样好的排布上去。
 *
 * 整栋楼的数字是各层覆盖比例的密度加权平均，权重是各层贡献的采样点数，
 * 这样小楼层不会和大楼层占一样的分量。
 */
async function runAlternatingPasses(signal: AbortSignal): Promise<void> {
	const order = [...floorState.floors].sort((a, b) => a.level - b.level);
	const runnable = order.filter(
		(f) => f.wallMask && apState.aps.some((ap) => ap.floorId === f.id)
	);
	if (runnable.length === 0) {
		optimizerState.error = t('No floors with both a floorplan and APs to place');
		return;
	}

	/** 收益低于这个比例就不值得再跑一轮了。 */
	const MIN_GAIN = 0.002;
	/** 硬上限。每轮都要把每层完整优化一遍，用它兜住等待时间。 */
	const MAX_PASSES = 4;

	let best = -1;
	let passes = 0;

	for (let pass = 1; pass <= MAX_PASSES; pass++) {
		if (signal.aborted) break;
		let weighted = 0;
		let weight = 0;
		const perFloor: Array<{ id: string; name: string; coverage: number }> = [];

		for (let i = 0; i < runnable.length; i++) {
			if (signal.aborted) break;
			const f = runnable[i]!;
			optimizerState.status = t('Pass {pass}/{total} · {floor} ({index}/{count})', {
				pass,
				total: MAX_PASSES,
				floor: f.name,
				index: i + 1,
				count: runnable.length
			});
			// 和单层按钮走同一条按层路径，所以重启次数在这里同样生效。面板数字由
			// `commitFloorOutcome` 用目标函数同一个数刷新，两边不会打架。
			const outcome = await optimizeFloorBest(
				f.id,
				optimizerState.restarts,
				true,
				{},
				signal
			);
			if (!outcome) continue;

			perFloor.push({ id: f.id, name: f.name, coverage: outcome.coverage });
			weighted += outcome.coverage * outcome.samples;
			weight += outcome.samples;
		}

		passes = pass;
		if (weight <= 0) break;
		const building = weighted / weight;
		optimizerState.buildingCoverage = Math.round(building * 100);

		// 把最弱的那层点出来。只报告，不为它单独优化：min-max 目标函数难搜得多，
		// 收益却很小，而按层跑真正提升的是平均值。
		if (perFloor.length > 0) {
			const worst = perFloor.reduce((a, b) => (b.coverage < a.coverage ? b : a));
			optimizerState.worstFloor = {
				id: worst.id,
				name: worst.name,
				coverage: Math.round(worst.coverage * 100)
			};
		}

		if (building - best < MIN_GAIN) break;
		best = building;
	}

	// A1 的逐层保证，作为额外的一块。
	//
	// 上面的循环只会点出最弱的楼层，从不为它单独优化——这对*目标函数*是对的（min-max 难搜、
	// 平均收益小），但后果是某层可能远远低于要求却没人管它。设了覆盖率下限时，最弱的那层
	// 再跑，把它自己的要求当 ε-约束：同一套 F3 机制，只用在这块上，其他层不动。
	//
	// 特意做成额外一块而不是塞进每一块里：约束必须针对*整栋楼*最弱的那层才有意义，
	// 而一轮里面，所有楼层都打过分之前没人知道最弱的是谁。
	//
	// 补跑是一个有预算的上限循环（`MAX_FLOOR_PASSES`），只在这层真的往上走时才续——判据
	// 全在 `nextFloorPass` 里。每轮还必须换一段种子：同一个布局配同一组种子是确定性的，
	// 照着重跑只会把上一轮选中的方案原样重放，那个块从来不改变任何东西。所以第一轮就从
	// 交替循环用过的 `1…restarts` 之后起步。
	if (
		!signal.aborted &&
		projectMeta.coverageFloorPct > 0 &&
		optimizerState.worstFloor
	) {
		const worst = optimizerState.worstFloor;
		const target = projectMeta.coverageFloorPct;
		if (worst.coverage < target) {
			const floor = runnable.find((f) => f.id === worst.id);
			if (floor) {
				const restarts = Math.max(1, Math.floor(optimizerState.restarts));
				/** 这一轮开始时面板上的覆盖率；续跑时换成上一轮结束的值。 */
				let before = worst.coverage;
				let after = before;
				let seedBase = restarts;
				/** 为什么停下来。取消不进这里：那不算跑完。 */
				let stopped: 'met' | 'no-gain' | 'budget' | 'aborted' | 'failed' = 'budget';

				for (let pass = 1; pass <= MAX_FLOOR_PASSES; pass++) {
					if (signal.aborted) {
						stopped = 'aborted';
						break;
					}
					debug(
						`[optimizer] per-floor floor: ${floor.name} is at ${before}%, below the ` +
							`${target}% requirement — pass ${pass}/${MAX_FLOOR_PASSES} with it as the ε`
					);
					optimizerState.status = t('Per-floor floor · {floor}', { floor: floor.name });
					const outcome = await optimizeFloorBest(
						floor.id,
						restarts,
						true,
						{ floorPct: target, seedBase },
						signal
					);
					if (!outcome) {
						stopped = signal.aborted ? 'aborted' : 'failed';
						break;
					}

					// 达标与否、有没有进步，都按面板上的整数百分比说：那才是用户和要求共用的刻度。
					after = Math.round(outcome.coverage * 100);
					optimizerState.worstFloor = { id: floor.id, name: floor.name, coverage: after };
					debug(
						`[optimizer] per-floor floor: ${floor.name} now at ${after}% ` +
							`(pass ${pass}/${MAX_FLOOR_PASSES})`
					);

					const next = nextFloorPass({ pass, before, after, target, restarts });
					if (!next.run) {
						stopped = next.stop;
						break;
					}
					before = after;
					seedBase = next.seedBase;
				}

				if (stopped === 'met') {
					debug(
						`[optimizer] per-floor floor: ${floor.name} reached ${after}% — the ` +
							`${target}% requirement is met`
					);
				} else if (stopped === 'no-gain') {
					debug(
						`[optimizer] per-floor floor: ${floor.name} stayed at ${after}% ` +
							`(${before}% before the pass) — no gain, stopping`
					);
				} else if (stopped === 'budget') {
					debug(
						`[optimizer] per-floor floor: ${floor.name} still ${target - after} points ` +
							`short of ${target}% after ${MAX_FLOOR_PASSES} passes — budget spent`
					);
				} else if (stopped === 'failed') {
					debug(
						`[optimizer] per-floor floor: ${floor.name} — a pass produced no result, stopping`
					);
				}
			}
		} else {
			debug(
				`[optimizer] per-floor floor: weakest floor is ${worst.name} at ${worst.coverage}%, ` +
					`at or above the ${projectMeta.coverageFloorPct}% requirement — no extra pass`
			);
		}
	}

	// 取消也在这里停：面板上的数字说的是屏幕上的方案，跑到一半停下的运行还没算完。
	if (signal.aborted) return;
	optimizerState.passes = passes;
	optimizerState.progress = 100;
	scheduleSave();
}

/** 优化所有楼层，逐轮交替，直到整栋楼的数字不再上升。 */
export async function optimizeAllFloors(): Promise<void> {
	await withOptimizerRun((signal) => runAlternatingPasses(signal));
}

/**
 * 停掉正在跑的那次运行。
 *
 * 要动三处，因为取消有三个层级：正在搜的 Worker；本线程上的循环（否则它会把取消掉的楼层
 * 当成「这次重启没收获」，接着跑下一次）；以及运行可能正在等的那个算图请求。
 */
export function cancelOptimizer(): void {
	runAbort?.abort();
	bridge.cancel();
	graphBridge.cancel();
}


// 对外导出保持不变：状态和覆盖计算以前就住在这个文件里，调用方不该关心某个数字搬去了哪个模块。
export { optimizerState, floorCoverage };
export {
	apsOutsideInterior,
	getBuildingCoverage,
	resultIsStale
} from './optimizer-state.svelte.js';
export { updateCoverage } from './optimizer-coverage.svelte.js';