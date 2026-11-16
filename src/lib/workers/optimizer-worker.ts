// AP 位置优化器的真正执行入口，运行在浏览器 Web Worker 中

/// <reference lib="webworker" />

import { buildRoomDomain } from '../canvas/rooms.js';
import { clipInteriorToPlanningArea } from '../state/planning-area.js';
import { isVoidRoomType } from '$lib/domain/room-types.js';
import {
	COVERAGE_THRESHOLD_DBM,
	DEFAULT_COVERAGE_SOFTNESS_DB,
	DEFAULT_PATH_LOSS_SCENARIO,
	coverageHorizontalReach,
	coverageMarginDb,
	coverageThresholdDbm,
	coverageThresholdMarginDb,
	ccaThresholdDbm,
	coverageUtilityAboveThreshold,
	rangeFromPower,
	reachAtMargin,
	slabDbOf,
	setCoverageThresholdDbm,
	setPathLossScenario
} from '../rf/propagation.js';
import { slabLossFactor } from '../rf/cross-floor.js';
import { splitWallRunLoss, wallRunLoss, type WallRun } from '../rf/link-budget.js';
import { columnLossDelta } from '../rf/columns.js';
import { rayWallLossDb } from '../rf/wall-crossings.js';
import { secondOrderReflection } from '../rf/reflection.js';
import { reflectionPairsForAp } from '../rf/path-candidates.js';
import { surfaceHeightAt } from '../rf/surface-height.js';
import {
	antennaRayLossDb,
	azimuthLossDb,
	type AntennaProfile
} from '../rf/antenna.js';
import {
	COCHANNEL_REUSE_DB,
	DEFAULT_INTERFERENCE_WEIGHT,
	colourConflicts,
	conflictMatrix,
	conflictWeights,
	interferenceAt,
	markSampleConflicts,
	resolveChannels
} from '../rf/interference.js';
import { makeInterferenceLookup } from '../rf/channel-overlap.js';
import {
	getMaterialDbTable,
	registerCustomMaterials,
	type WallMaterialId
} from '$lib/domain/materials.js';
import {
	getAvailableChannels,
	planningCandidates,
	type Band,
	type ChannelWidth
} from '@aetherax/channels';
import {
	OPTIMIZER_PAYLOAD_VERSION,
	assertApPayload,
	type OptimizeMessage,
	type WireGeometry,
	type WireMessage
} from './optimizer-protocol.js';
import { deckLossAt } from './optimizer/deck.js';
import { buildFixedPaths } from './optimizer/fixed-paths.js';
import { antennaProfile, resolveApProfiles } from './optimizer/profiles.js';
import { GeometryCache } from './optimizer/geometry.js';
import { mulberry32 } from './optimizer/random.js';
import {
	allowedForAp,
	buildInteriorField,
	buildSnapTarget,
	buildWallPlacement,
	createWallCache,
	snapForAp,
	snapToInterior
} from './optimizer/placement.js';
import type {
	ApInput,
	EvalContext,
	ExactEval,
	FixedApInput,
	MarginField,
	Position,
	PowerChoice,
	WallCache,
	WallPlacement
} from './optimizer/types.js';



interface CancelMessage {
	type: 'cancel';
	/** 要取消的那次运行。没指定正在跑的任务就忽略。 */
	runId: string;
}

type InMessage = OptimizeMessage | CancelMessage;

type Run = { runId: string; cancelled: boolean };

/**
 * 当前正在跑的那次运行，空闲时为 null。
 * 一次运行还没结束时又收到 `optimize`，直接回 busy。
 */
let running: Run | null = null;

/**
 * 给调用方回一条消息，并带上这条消息属于哪次运行。
 */
function reply(runId: string, payload: Record<string, unknown>): void {
	self.postMessage({ ...payload, runId });
}

/**
 * 调用方没给随机种子时用的默认值。
 */
const DEFAULT_OPTIMIZER_SEED = 20260921;


/**
 * 这个 Worker 最后一次收到的户型几何。
 */
const geometryCache = new GeometryCache<WireGeometry>();

/** 取消息要用的户型几何，没带就用 Worker 缓存的。 */
function geometryFor(msg: WireMessage): WireGeometry | null {
	const carried =
		msg.wallMask && msg.maskWidth !== undefined && msg.maskHeight !== undefined
			? {
					id: msg.geometryId ?? '',
					geometry: {
						wallMask: msg.wallMask,
						maskWidth: msg.maskWidth,
						maskHeight: msg.maskHeight,
						materialMask: msg.materialMask ?? null,
						densityMap: msg.densityMap ?? null,
						medianDensity: msg.medianDensity ?? 0,
						roomTypeMask: msg.roomTypeMask ?? null,
						fixedAps: msg.fixedAps ?? []
					}
				}
			: null;
	return geometryCache.resolve(carried, msg.geometryId, msg.geometryReused);
}
self.onmessage = (event: MessageEvent<InMessage | WireMessage>) => {
	const msg = event.data;
	if (msg.type === 'cancel') {
		// 只取消它点名的那次运行。取消消息可能在它要取消的运行结束后才到（调用方已经放弃并往下走了），
		if (running && running.runId === msg.runId) running.cancelled = true;
		return;
	}
	if (msg.type !== 'optimize') return;

	if (running && !running.cancelled) {
		reply(msg.runId, { type: 'busy' });
		return;
	}

	const run: Run = { runId: msg.runId, cancelled: false };
	const geometry = geometryFor(msg);
	if (!geometry) {
		reply(msg.runId, {
			type: 'result',
			positions: msg.aps.map((a) => ({ id: a.id, x: a.x, y: a.y })),
			score: 0,
			improvement: 0,
			error: 'the optimiser worker was not given this plan'
		});
		return;
	}
	running = run;
	runOptimization(msg, run, geometry)
		.catch((err) => {
			reply(msg.runId, {
				type: 'result',
				positions: msg.aps.map((a) => ({ id: a.id, x: a.x, y: a.y })),
				score: 0,
				improvement: 0,
				error: String(err)
			});
		})
		.finally(() => {
			// 只有还占着位置的那次运行才能清空
			if (running === run) running = null;
		});
};

// ─── 评估 ───────────────────────────────────────────────────────────────

/**
 * 快速评估一套布局，返回目标函数值。搜索阶段每一步都调用。
 * 把每个采样点上各信号源的余量算出来，覆盖效用、干扰项和冲突图都用这一份。
 */
function evaluateCoverage(
	positions: Position[],
	caches: Map<Band, WallCache>,
	ctx: EvalContext
): number {
	const { samples, fixedAps, sampleDensity, fixedPaths } = ctx;
	// 每次评估只取一次每个信号源的衰减行。这一行只跟信号源位置有关，
	// 对所有采样点都一样；`tableFor` 还会跨评估做缓存。
	const emptyRow = new Float32Array(samples.length);
	const softness = ctx.coverageSoftnessDb;
	// 壁挂的天线方向图会跟着它所在的墙转，所以方向图要从当前布局解出来。
	const apProfiles = resolveApProfiles(positions, ctx);
	const apRows: Float32Array[] = new Array(positions.length);
	for (let a = 0; a < positions.length; a++) {
		const c = caches.get(positions[a]!.band);
		apRows[a] = c ? c.tableFor(positions[a]!.x, positions[a]!.y) : emptyRow;
	}
	const fixedRows: Float32Array[] = new Array(fixedAps.length);
	const fixedSlabDb = new Float64Array(fixedAps.length);
	for (let f = 0; f < fixedAps.length; f++) {
		const c = caches.get(fixedAps[f]!.band);
		fixedRows[f] = c ? c.tableFor(fixedAps[f]!.x, fixedAps[f]!.y) : emptyRow;
		fixedSlabDb[f] = slabDbOf(fixedAps[f]!.signalScale);
	}

	let totalWeighted = 0;
	let totalWeight = 0;
	/** 按密度加权的已覆盖比例。 */
	let coveredWeighted = 0;
	const count = positions.length + fixedAps.length;
	// 每个采样点的余量全留着，并据此建冲突图：信道要等整个布局算完才能定，
	// 因为哪些接入点不能同信道是布局整体的性质，单个采样点看不出来。
	const allMargins = new Float64Array(samples.length * count);
	const conflicts = conflictMatrix(count);
	/*
	 * 每条冲突的代价，信道不够时着色器就留下最便宜的那条。
	 */
	const weights = conflictWeights(count);
	for (let s = 0; s < samples.length; s++) {
		// 每个信号源记一个余量，一直算到「效用」边界（比阈值低 `coverageSoftnessDb`）。
		// 干扰项和覆盖比例看到的都是这个数：正数就用它，其余地方当 -Infinity，
		// 这正好是覆盖圆的范围。
		// `best` 就是效用余量，大于 0 说明落在某个圆内，所以也用它判断「已覆盖」。
		let best = -Infinity;
		const base = s * count;
		let k = 0;
		for (let a = 0; a < positions.length; a++) {
			const ap = positions[a]!;
			const dx = samples[s]!.x - ap.x;
			const dy = samples[s]!.y - ap.y;
			const dist = Math.sqrt(dx * dx + dy * dy);
			// 接入点的安装高度差减去客户端所在的高度。带正负号；要距离时取绝对值，
			const gap = (ctx.apGaps[a] ?? 0) - (ctx.sampleLift?.[s] ?? 0);
			const profile = apProfiles[a]!;
			/*
			 * 超出效用边界不用记余量
			 */
			if (dist >= sourceHorizonToward(ap.radius, 0, gap, softness, profile, dx, dy)) {
				allMargins[base + k++] = -Infinity;
				continue;
			}
			const row =
				apRows[a]![s]! +
				columnLossDelta(
					ctx.columns ?? [],
					{ x: ap.x, y: ap.y },
					{ x: samples[s]!.x, y: samples[s]!.y },
					ap.band,
					getMaterialDbTable(ap.band),
					1 / Math.max(1e-9, ctx.wupm ?? 1)
				);
			// 同一层，但不是纯平面：接入点自己的安装高度要算进距离，天线切面要算进损耗。
			// 两点之间有抬升面也在这里扣，规则和热力图、实时数值一致。
			const deckLoss = deckLossAt(ctx, samples[s]!.x, samples[s]!.y, gap);
			const wide =
				sourceMargin(dist, ap.radius, row + deckLoss, gap, -softness) -
				antennaRayLossDb(profile, gap, dx, dy);
			allMargins[base + k++] = wide > 0 ? wide : -Infinity;
			if (wide > best) best = wide;
		}
		// 其他楼层的固定接入点也要算（要穿楼板，按楼板衰减）
		for (let f = 0; f < fixedAps.length; f++) {
			const fap = fixedAps[f]!;
			const dx = samples[s]!.x - fap.x;
			const dy = samples[s]!.y - fap.y;
			const dist = Math.sqrt(dx * dx + dy * dy);
			// 楼层被拆开时两段都要加，没拆就只用投影后的那一整条。
			const path = fixedPaths[f];
			const split = path?.split;
			const wallDb = split ? split.source[s]! + split.suffix[s]! : fixedRows[f]![s]!;
			const columnDb = columnLossDelta(
				ctx.columns ?? [],
				{ x: fap.x, y: fap.y },
				{ x: samples[s]!.x, y: samples[s]!.y },
				fap.band,
				getMaterialDbTable(fap.band),
				1 / Math.max(1e-9, ctx.wupm ?? 1)
			);
			// 楼板上有洞的地方，楼板损耗算 0。
			const slabDb =
				path?.slabFactor != null ? fixedSlabDb[f]! * path.slabFactor[s]! : fixedSlabDb[f]!;
			const loss = wallDb + slabDb + columnDb;
			// 固定接入点的高度差是相对本层地面量的；客户端可能比地面高。
			const fixedGap = fap.verticalGap - (ctx.sampleLift?.[s] ?? 0);
			const wide =
				sourceMargin(
					dist,
					fap.interferenceRadius,
					loss + deckLossAt(ctx, samples[s]!.x, samples[s]!.y, fixedGap),
					fixedGap,
					-softness
				) - antennaRayLossDb(ctx.fixedProfiles[f]!, fixedGap, dx, dy);
			allMargins[base + k++] = wide > 0 ? wide : -Infinity;
			if (wide > best) best = wide;
		}
		const w = sampleDensity[s] ?? 1;
		totalWeighted += coverageUtilityAboveThreshold(best, ctx.coverageSoftnessDb) * w;
		if (best > 0) coveredWeighted += w;
		totalWeight += w;
		markSampleConflicts(conflicts, allMargins, k, base, ctx.sourceBands, weights, w);
	}
	const interference = interferenceShare(allMargins, conflicts, samples.length, count, ctx, weights);
	const utility = totalWeight > 0 ? totalWeighted / totalWeight : 0;

	const covered = totalWeight > 0 ? coveredWeighted / totalWeight : 0;
	const shortfall = ctx.coverageFloor > 0 ? Math.max(0, ctx.coverageFloor - covered) : 0;
	return utility - ctx.interferenceWeight * interference - COVERAGE_FLOOR_MULTIPLIER * shortfall;
}

/**
 * 按密度加权后，主服务被同频次强信号拉低的采样点占比。
 */
function interferenceShare(
	allMargins: Float64Array,
	conflicts: Uint8Array,
	sampleCount: number,
	count: number,
	ctx: EvalContext,
	weights: Float32Array | null = null
): number {
	if (count === 0 || sampleCount === 0) return 0;
	const channels = ctx.sourceAllowed
		? colourConflicts(conflicts, count, ctx.sourceAllowed, ctx.overlap, weights)
		: ctx.sourceChannels;
	let interferingWeight = 0;
	let totalWeight = 0;
	for (let i = 0; i < sampleCount; i++) {
		const w = ctx.sampleDensity[i] ?? 1;
		totalWeight += w;
		// `ctx.overlap` 取默认值时，这就等价于以前的「有/没有」判断。
		interferingWeight +=
			w * interferenceAt(allMargins, channels, count, i * count, ctx.sourceBands, ctx.overlap);
	}
	return totalWeight > 0 ? interferingWeight / totalWeight : 0;
}

/**
 * 某个信号源在某个采样点上高出覆盖阈值的余量，单位 dB。
 *
 * 覆盖效用和干扰项都基于它：效用是把它截断再缩放，干扰则是比较同一点上两个信号源的余量。
 * 单独拆出来，评估器就能一趟同时算出两者，不用把同一个采样点算两遍。
 */
function sourceMargin(
	dist: number,
	radius: number,
	lossDb: number,
	verticalGap = 0,
	horizonDb = 0
): number {
	// `dist` 只是水平距离；可达范围按 3D 算，所以需要竖直高度差的绝对值。
	// 方向本身留给后面的天线方向图，不能用绝对值。
	const verticalDistance = Math.abs(verticalGap);
	if (dist >= coverageHorizontalReach(radius, lossDb, verticalDistance, horizonDb)) return -Infinity;
	const d3 = verticalDistance > 0 ? Math.hypot(dist, verticalDistance) : dist;
	return coverageMarginDb(d3, radius) - lossDb - coverageThresholdMarginDb();
}

/**
 * 二次反射在采样点上的余量；没有墙段或没有候选时返回 -Infinity。
 */
function secondReflectionMargin(
	ap: { x: number; y: number; band: Band; radius: number },
	sx: number,
	sy: number,
	profile: AntennaProfile,
	gap: number,
	ctx: EvalContext
): number {
	const walls = ctx.reflectingWalls;
	if (!walls || walls.length === 0) return -Infinity;
	let pairs = ctx.secondPairsByBand?.get(ap.band);
	if (!pairs) {
		pairs = reflectionPairsForAp(walls, ap.band, 8);
		ctx.secondPairsByBand?.set(ap.band, pairs);
	}
	let best = -Infinity;
	for (const pair of pairs) {
		const second = secondOrderReflection({ x: ap.x, y: ap.y }, { x: sx, y: sy }, walls, pair, ap.band);
		if (!second) continue;
		const legLoss =
			rayWallLossDb({ x: ap.x, y: ap.y }, { x: second.x, y: second.y }, walls, ap.band, [
				second.wallIndex
			]) +
			rayWallLossDb(
				{ x: second.x, y: second.y },
				{ x: second.x2, y: second.y2 },
				walls,
				ap.band,
				[second.wallIndex, second.wallIndex2]
			) +
			rayWallLossDb(
				{ x: second.x2, y: second.y2 },
				{ x: sx, y: sy },
				walls,
				ap.band,
				[second.wallIndex2]
			);
		const margin =
			sourceMargin(second.length, ap.radius, legLoss, gap, -ctx.coverageSoftnessDb) +
			10 * Math.log10(second.powerRatio * second.powerRatio2) -
			antennaRayLossDb(profile, gap, second.x - ap.x, second.y - ap.y);
		if (margin > best) best = margin;
	}
	return best;
}

/**
 * 一个信号源至少要往外算到多远的水平距离。
 * 取评估器要用的两个边界里更大的那个：干扰边界和效用边界。
 */
function sourceHorizon(
	radius: number,
	lossDb: number,
	verticalGap: number,
	softnessDb: number
): number {
	const verticalDistance = Math.abs(verticalGap);
	const reach = reachAtMargin(radius, lossDb, -Math.max(COCHANNEL_REUSE_DB, softnessDb));
	if (verticalDistance <= 0) return reach;
	return Math.sqrt(Math.max(0, reach * reach - verticalDistance * verticalDistance));
}

/**
 * 壁挂设备的切面是有方向的，同样的边界，再按采样点所在方向、被天线水平切面收紧一次。
 */
function sourceHorizonToward(
	radius: number,
	lossDb: number,
	verticalGap: number,
	horizonDb: number,
	profile: AntennaProfile,
	dx: number,
	dy: number
): number {
	if (profile.azBeamwidthDeg === undefined) {
		return sourceHorizon(radius, lossDb, verticalGap, horizonDb);
	}
	const bearing = (Math.atan2(dy, dx) * 180) / Math.PI;
	const cut = azimuthLossDb(bearing, profile);
	return cut === 0
		? sourceHorizon(radius, lossDb, verticalGap, horizonDb)
		: sourceHorizon(radius, lossDb + cut, verticalGap, horizonDb);
}

function fillMargins(positions: Position[], ctx: EvalContext): MarginField {
	const {
		samples,
		mask,
		w,
		h,
		wallAttenuation,
		fixedAps,
		materialMask,
		defaultMaterial
	} = ctx;
	// 材质表是按频段分的；每个频段的表最多建一次。
	const dbByBand = new Map<Band, number[]>();
	const tablesFor = (band: Band): number[] => {
		let db = dbByBand.get(band);
		if (!db) {
			db = getMaterialDbTable(band);
			dbByBand.set(band, db);
		}
		return db;
	};
	// 没有材质掩码时所有墙一样，所以用项目里明确给的穿墙损耗
	const defaultDbFor = (band: Band): number =>
		materialMask ? (tablesFor(band)[defaultMaterial] ?? wallAttenuation) : wallAttenuation;


	/** 本 Worker 自己的掩码，用它自己的坐标，包成一次走线能吃的格式。 */
	const targetRun = (band: Band): WallRun => ({
		mask,
		width: w,
		height: h,
		materialMask,
		materialDb: tablesFor(band),
		fallbackDb: defaultDbFor(band),
		originX: 0,
		originY: 0,
		defaultMaterialId: defaultMaterial
	});

	const lossFor = (band: Band, x0: number, y0: number, x1: number, y1: number): number =>
		wallRunLoss(targetRun(band), { x: x0, y: y0 }, { x: x1, y: y1 }, 1);

	/**
	 * 从固定接入点到某个采样点的穿墙损耗；拿到该接入点所在楼层的掩码时，在楼板处切开算。
	 */
	const fixedLossFor = (fap: FixedApInput, sx: number, sy: number): number => {
		const src = fap.source;
		if (!src) return lossFor(fap.band, fap.x, fap.y, sx, sy);

		const tables = tablesFor(fap.band);
		const sourceDefault = src.materialMask
			? (tables[src.defaultMaterial] ?? wallAttenuation)
			: wallAttenuation;
		const split = splitWallRunLoss(
			{
				mask: src.data,
				width: src.width,
				height: src.height,
				materialMask: src.materialMask,
				materialDb: tables,
				fallbackDb: sourceDefault,
				originX: src.originX,
				originY: src.originY,
				defaultMaterialId: src.defaultMaterial
			},
			targetRun(fap.band),
			fap.sourceT ?? 0,
			fap.targetT ?? 0,
			{ x: fap.x, y: fap.y },
			{ x: sx, y: sy },
			1
		);
		return split ?? lossFor(fap.band, fap.x, fap.y, sx, sy);
	};

	const fixedSlabDb = fixedAps.map((fap) => slabDbOf(fap.signalScale));
	const softness = ctx.coverageSoftnessDb;
	// 壁挂的天线方向图跟它装在哪有关，所以按布局逐个解——见 `evaluateCoverage`。
	const apProfiles = resolveApProfiles(positions, ctx);
	// 终端只要同频能量高于 CCA 前导检测门限就会让路：20 MHz 下是 −82 dBm
	const horizon = Math.max(softness, CCA_BELOW_THRESHOLD_DB);
	// 每个采样点的余量都留着，做法和 `evaluateCoverage` 一样。
	const count = positions.length + fixedAps.length;
	const allMargins = new Float64Array(samples.length * count);
	const ccaMargins = new Float64Array(samples.length * count);
	const conflicts = conflictMatrix(count);
	// 加权方式和快速评估一致：目标函数打分的图和求解器着色的图，不只是边的位置一致，
	// 连每条边的代价也得一致。
	const weights = conflictWeights(count);
	const bestBySample = new Float64Array(samples.length);
	const utilityMargin = new Float64Array(samples.length);
	for (let si = 0; si < samples.length; si++) {
		const sample = samples[si]!;
		const base = si * count;
		// 取最大余量，理由同 `evaluateCoverage`：效用是它的单调函数，正数说明落在覆盖圆内。
		// 所以每个采样点一个数，就能得到效用、是否覆盖，以及干扰项的输入
		// （`best > 0 ? best : -Infinity`）。
		let best = -Infinity;
		let k = 0;
		// 客户端脚下的高度，用世界坐标单位。没有抬升面时是 0。
		const lift = ctx.sampleLift?.[si] ?? 0;
		for (let ai = 0; ai < positions.length; ai++) {
			const ap = positions[ai]!;
			const gap = (ctx.apGaps[ai] ?? 0) - lift;
			const dx = sample.x - ap.x;
			const dy = sample.y - ap.y;
			const dist = Math.sqrt(dx * dx + dy * dy);
			// 任何边界都够不着，整条射线就不用走。两个边界取更远的那个：
			// 干扰距离和效用边界（阈值以下 `coverageSoftnessDb`）。
			// 同层接入点的竖直高度差会先吃掉一部分可达距离，壁挂的水平切面再按采样点方向吃掉一部分，
			if (
				dist >=
				sourceHorizonToward(ap.radius, 0, gap, horizon, apProfiles[ai]!, dx, dy)
			) {
				allMargins[base + k] = -Infinity;
				ccaMargins[base + k] = -Infinity;
				k++;
				continue;
			}
			const loss = lossFor(ap.band, ap.x, ap.y, sample.x, sample.y);
			// 上面的剪枝判定故意按穿墙损耗的「最好情况」来：损耗只会扣余量，
			// 不算损耗都够不着，算上更够不着，所以这个边界是保守的。
			const margin =
				sourceMargin(
					dist,
					ap.radius,
					loss + deckLossAt(ctx, sample.x, sample.y, gap),
					gap,
					-horizon
				) - antennaRayLossDb(apProfiles[ai]!, gap, dx, dy);
			const reflected = secondReflectionMargin(
				{ x: ap.x, y: ap.y, band: ap.band, radius: ap.radius },
				sample.x,
				sample.y,
				apProfiles[ai]!,
				gap,
				ctx
			);
			const bestMargin = reflected > margin ? reflected : margin;
			allMargins[base + k] = bestMargin > 0 ? bestMargin : -Infinity;
			ccaMargins[base + k] = bestMargin > -CCA_BELOW_THRESHOLD_DB ? bestMargin : -Infinity;
			k++;
			if (bestMargin > best) best = bestMargin;
		}
		for (let fi = 0; fi < fixedAps.length; fi++) {
			const fap = fixedAps[fi]!;
			const dx = sample.x - fap.x;
			const dy = sample.y - fap.y;
			const dist = Math.sqrt(dx * dx + dy * dy);
			const slabDb = fixedSlabDb[fi]!;
			// 楼板上有洞的地方，楼板损耗算 0。这个判定放在可达性测试之前：
			// 按整块楼板的损耗算，3D 可达距离可能比竖直高度差还短，
			// 信号源就会在发现洞之前被丢掉。

			const slabs = fap.slabs;
			let slabLoss = slabDb;
			if (slabs && slabs.length > 0) {
				// 所有穿越乘同一个系数：跨过不止一层时，只有自己那块楼板是洞的那部分才免掉。
				slabLoss = slabDb * slabLossFactor(slabs, fap.x, fap.y, sample.x, sample.y);
			}
			// 固定接入点的高度差是相对本层地面量的；客户端可能站得比地面高。
			const fixedGap = fap.verticalGap - lift;
			if (
				!(slabDb < Infinity) ||
				dist >=
					sourceHorizonToward(
						fap.interferenceRadius,
						slabLoss,
						fixedGap,
						horizon,
						ctx.fixedProfiles[fi]!,
						dx,
						dy
					)
			) {
				allMargins[base + k] = -Infinity;
				ccaMargins[base + k] = -Infinity;
				k++;
				continue;
			}
			const loss = fixedLossFor(fap, sample.x, sample.y) + slabLoss;
			const margin =
				sourceMargin(
					dist,
					fap.interferenceRadius,
					loss + deckLossAt(ctx, sample.x, sample.y, fixedGap),
					fixedGap,
					-horizon
				) - antennaRayLossDb(ctx.fixedProfiles[fi]!, fixedGap, dx, dy);
			allMargins[base + k] = margin > 0 ? margin : -Infinity;
			ccaMargins[base + k] = margin > -CCA_BELOW_THRESHOLD_DB ? margin : -Infinity;
			k++;
			if (margin > best) best = margin;
		}
		bestBySample[si] = best;
		utilityMargin[si] = best;
		markSampleConflicts(
			conflicts,
			allMargins,
			k,
			base,
			ctx.sourceBands,
			weights,
			ctx.sampleDensity[si] ?? 1
		);
	}
	return { allMargins, ccaMargins, conflicts, weights, bestBySample, utilityMargin, count };
}

/**
 * 争用指标往下看到覆盖阈值以下多少 dB，按本次运行最窄的信道宽度算。
 */
const CCA_BELOW_THRESHOLD_DB = 12;

/**
 * 本次运行的终端会让路到覆盖阈值以下多少 dB。
 */
function ccaBelowCoverageDb(ctx: EvalContext): number {
	return coverageThresholdDbm() - ccaThresholdDbm(ctx.minChannelWidthMhz);
}

/**
 * 地面上终端能同时听到两个信道重叠的接入点、且都高于 CCA 门限的比例
 *
 * - `ccaMargins` 是接入点在地面某点上的电平，所以这里模拟的是终端侧：
 *   终端连上其中一个，听到另一个高于门限就让路。同频多 AP 部署里，
 *   空口时间主要就是这么被分掉的，这个指标就是为它准备的。
 */
function contentionShare(field: MarginField, ctx: EvalContext): number {
	const { ccaMargins, count } = field;
	const sampleCount = ccaMargins.length / Math.max(1, count);
	let contendedWeight = 0;
	let totalWeight = 0;
	const limit = -ccaBelowCoverageDb(ctx);
	for (let i = 0; i < sampleCount; i++) {
		const w = ctx.sampleDensity[i] ?? 1;
		totalWeight += w;
		const base = i * count;
		let contended = false;
		for (let i = 0; i < count && !contended; i++) {
			const mi = ccaMargins[base + i]!;
			if (!(mi > limit)) continue;
			for (let j = i + 1; j < count; j++) {
				const mj = ccaMargins[base + j]!;
				if (!(mj > limit)) continue;
				// 用和干扰项同一个查表判断信道是否重叠：默认模型下就是相等，
				// 区间模型下部分重叠也算。
				if (ctx.overlap(i, ctx.sourceChannels[i] ?? 0, j, ctx.sourceChannels[j] ?? 0) > 0) {
					contended = true;
					break;
				}
			}
		}
		if (contended) contendedWeight += w;
	}
	return totalWeight > 0 ? contendedWeight / totalWeight : 0;
}

/**
 * ε-约束每单位覆盖缺口的惩罚力度。
 *
 * 惩罚是 `multiplier · max(0, floor − coverage)`
 */
const COVERAGE_FLOOR_MULTIPLIER = 3;

/**
 * 目标函数的三个数字，从 `MarginField` 上读出来。
 *
 * 按密度加权，和 `evaluateCoverage` 一致。没给密度数据时每个采样点权重都是 1，退化成普通平均。
 */
function scoreMargins(field: MarginField, ctx: EvalContext, report = false): ExactEval {
	const { allMargins, conflicts, bestBySample, utilityMargin, count } = field;
	const sampleCount = bestBySample.length;
	let totalWeighted = 0;
	let coveredWeighted = 0;
	let totalWeight = 0;

	for (let si = 0; si < sampleCount; si++) {
		const best = bestBySample[si]!;
		const wt = ctx.sampleDensity[si] ?? 1;
		totalWeighted +=
			coverageUtilityAboveThreshold(utilityMargin[si]!, ctx.coverageSoftnessDb) * wt;
		if (best > 0) coveredWeighted += wt;
		totalWeight += wt;
	}
	const interference = interferenceShare(allMargins, conflicts, sampleCount, count, ctx, field.weights);
	const utility = totalWeight > 0 ? totalWeighted / totalWeight : 0;
	// 约束满足时惩罚恒为 0，可行域的得分和以前完全一样。
	const covered = totalWeight > 0 ? coveredWeighted / totalWeight : 0;
	const shortfall = ctx.coverageFloor > 0 ? Math.max(0, ctx.coverageFloor - covered) : 0;
	return {
		score: utility - ctx.interferenceWeight * interference - COVERAGE_FLOOR_MULTIPLIER * shortfall,
		shortfall,
		interference,
		coverage: totalWeight > 0 ? coveredWeighted / totalWeight : 0,
		samples: sampleCount,
		contention: report ? contentionShare(field, ctx) : 0
	};
}

function evaluateExactDetailed(positions: Position[], ctx: EvalContext, report = false): ExactEval {
	return scoreMargins(fillMargins(positions, ctx), ctx, report);
}


/**
 * 可选功率由调用方给，从每个接入点自己配置的功率往下排；只有在精确目标上有严格提升才采纳。
 */
function refinePower(
	positions: Position[],
	aps: ApInput[],
	ctx: EvalContext,
	msg: Pick<OptimizeMessage, 'powerLevelsDbm' | 'worldUnitsPerMeter'>
): PowerChoice[] | null {
	const levels = msg.powerLevelsDbm;
	const wupm = msg.worldUnitsPerMeter ?? 0;
	if (!levels || wupm <= 0 || levels.length !== positions.length) return null;

	// 每个接入点的功率对应的半径，按主线程的算法来：同一个函数、同样的取整，
	// 重新载入时布局不会变形。
	const radiusFor = (index: number, power: number): number =>
		Math.round(rangeFromPower(power, positions[index]!.band) * wupm);

	let chosen = positions.map((p, i) => ({
		power: levels[i]?.[0] ?? 0,
		radius: p.radius
	}));

	for (let sweep = 0; sweep < 2; sweep++) {
		let moved = false;
		for (let i = 0; i < positions.length; i++) {
			const options = levels[i];
			if (!options || options.length <= 1) continue;
			const current = chosen[i]!;
			let bestScore = evaluateExactDetailed(positions, ctx).score;
			let bestPower = current.power;
			let bestRadius = current.radius;
			const restore = positions[i]!.radius;
			for (const power of options) {
				if (power === current.power) continue;
				const radius = radiusFor(i, power);
				if (radius === current.radius) continue;
				positions[i]!.radius = radius;
				const score = evaluateExactDetailed(positions, ctx).score;
				if (score > bestScore) {
					bestScore = score;
					bestPower = power;
					bestRadius = radius;
				}
			}
			if (bestRadius !== current.radius) {
				positions[i]!.radius = bestRadius;
				chosen[i] = { power: bestPower, radius: bestRadius };
				moved = true;
			} else {
				positions[i]!.radius = restore;
			}
		}
		if (!moved) break;
	}

	return positions.map((p, i) => ({
		id: p.id,
		power: chosen[i]!.power,
		radius: p.radius
	}));
}

/** 只取分数，给那些在紧循环里反复调用的搜索阶段用。 */
function evaluateExact(positions: Position[], ctx: EvalContext): number {
	return evaluateExactDetailed(positions, ctx).score;
}

// ─── 让出事件循环，好检查取消 ───────────────────────────────

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

// ─── 优化主流程 ─────────────────────────────────────────────

async function runOptimization(
	msg: WireMessage,
	run: Run,
	geometry: WireGeometry
): Promise<void> {
	const { aps, wallAttenuation, defaultMaterial, allowOutside } = msg;

	const {
		fixedAps,
		wallMask: mask,
		maskWidth: w,
		maskHeight: h,
		materialMask,
		densityMap,
		medianDensity,
		roomTypeMask
	} = geometry;

	/*
	 * 这次运行的种子和随机数发生器，不属于 Worker。
	 */
	const runSeed = (msg.seed ?? DEFAULT_OPTIMIZER_SEED) >>> 0;
	const random = mulberry32(runSeed);

	if (msg.payloadVersion !== undefined && msg.payloadVersion !== OPTIMIZER_PAYLOAD_VERSION) {
		throw new Error(
			`optimiser payload version ${msg.payloadVersion} does not match this worker's ${OPTIMIZER_PAYLOAD_VERSION}`
		);
	}
	if (msg.payloadVersion !== undefined) assertApPayload(aps as unknown as Array<Record<string, unknown>>);

	setPathLossScenario(msg.pathLossScenario ?? DEFAULT_PATH_LOSS_SCENARIO);
	setCoverageThresholdDbm(msg.coverageThresholdDbm ?? COVERAGE_THRESHOLD_DBM);

	// 用户自定义材质要在打分之前注册：墙的走线通过 `getMaterialDbTable` 读表
	registerCustomMaterials(
		(msg.customMaterials ?? []).map((material) => ({
			id: material.id as WallMaterialId,
			name: material.name,
			dbPerMeter: material.dbPerMeter as Record<Band, number>,
			typicalThickness: material.typicalThickness,
			color: material.color
		}))
	);

	const { interior } = buildRoomDomain(mask, w, h, {
		// 墙缝不算房间。不加这条，平面上两条线夹出来的每条细缝都会进范围，
		minRegionRadius: msg.minRoomRadiusWu ?? 0,
		trimWallAdjacent: true
	});

	// 空洞是楼板上的洞，所以要从可布点的室内范围里去掉。
	if (roomTypeMask && roomTypeMask.length === w * h) {
		for (let i = 0; i < w * h; i++) {
			if (interior[i] && isVoidRoomType(roomTypeMask[i]!)) interior[i] = 0;
		}
	}

	/*
	 * 用户自己画的楼面范围
	 */
	const planningArea = msg.planningArea;
	if (planningArea && planningArea.length >= 3) {
		clipInteriorToPlanningArea(interior, w, h, 0, 0, planningArea);
	}

	if (run.cancelled) {
		reply(msg.runId, { type: 'cancelled' });
		return;
	}

	const interiorPixels: number[] = [];
	for (let i = 0; i < w * h; i++) {
		if (interior[i]) interiorPixels.push(i);
	}

	if (aps.length === 0) {
		reply(msg.runId, { type: 'result', positions: [], score: 0, improvement: 0, seed: runSeed });
		return;
	}

	// 没找到封闭的室内区域
	if (interiorPixels.length === 0 && !allowOutside) {
		reply(msg.runId, {
			type: 'result',
			positions: aps.map((a) => ({ id: a.id, x: a.x, y: a.y })),
			score: 0,
			improvement: 0,
			seed: runSeed,
			error:
				'No enclosed interior found, so APs were left where they are. A room only counts as inside once walls form a closed outline around it. Close the outlines, or turn on "Allow APs outside the floor boundary".'
		});
		return;
	}

	const numAps = aps.length;
	const baseline = medianDensity > 0 ? medianDensity : 0.3;

	// O(1) 的最近室内像素查找，建一次，每次吸附都复用。
	const interiorField = buildInteriorField(interior, w, h);
	// 空洞是楼板上的洞。它们已经从 `interior` 里排掉了，但开 `allowOutside` 时
	// 吸附根本没有场可查，所以另建一个查「所有不是洞的地方」的场。
	const voidMask =
		roomTypeMask && roomTypeMask.length === w * h
			? (() => {
					const v = new Uint8Array(w * h);
					let any = false;
					for (let i = 0; i < v.length; i++) {
						if (interior[i] === 0 && isVoidRoomType(roomTypeMask[i]!)) {
							v[i] = 1;
							any = true;
						}
					}
					return any ? v : null;
				})()
			: null;
	const snapTarget = buildSnapTarget(interior, voidMask, w, h, allowOutside);

	/*
	 * 壁挂接入点的一块搜索范围：贴着墙的那条地面带。
	 */
	const wallMounted = aps.map((ap) => ap.mount === 'wall');
	const wantsWallBand = wallMounted.some(Boolean);
	let wallPlacement: WallPlacement | null = null;
	if (wantsWallBand) {
		const { interior: untrimmed } = buildRoomDomain(mask, w, h, {
			minRegionRadius: msg.minRoomRadiusWu ?? 0,
			trimWallAdjacent: false
		});
		if (roomTypeMask && roomTypeMask.length === w * h) {
			for (let i = 0; i < w * h; i++) {
				if (untrimmed[i] && isVoidRoomType(roomTypeMask[i]!)) untrimmed[i] = 0;
			}
		}
		wallPlacement = buildWallPlacement(
			mask,
			untrimmed,
			w,
			h,
			msg.wallBandWu ?? 4,
			materialMask && materialMask.length === w * h ? materialMask : null,
			defaultMaterial
		);
	}
	/** 带子里的像素，用来给壁挂接入点做初始播种。 */
	const bandPixels: number[] = [];
	if (wallPlacement) {
		for (let i = 0; i < w * h; i++) {
			if (wallPlacement.band[i]) bandPixels.push(i);
		}
	}

	// 采样点——有房间类型数据就按密度加权。
	const sampleCount = Math.min(400, interiorPixels.length);
	const samples: Array<{ x: number; y: number }> = [];
	/** 每个采样点的密度权重（1.0 表示未标注/默认）。 */
	const sampleDensity: number[] = [];

	let sampled = false;

	// 有密度数据就按权重采样，否则均匀采样。
	if (!sampled && densityMap && densityMap.length === w * h) {
		const weights = new Float32Array(interiorPixels.length);
		let totalWeight = 0;
		for (let i = 0; i < interiorPixels.length; i++) {
			const raw = densityMap[interiorPixels[i]!]!;
			// -1 表示未标注，用基准值；>= 0 表示明确给了（包括 0）
			const d = raw >= 0 ? raw : baseline;
			weights[i] = d;
			totalWeight += d;
		}

		if (totalWeight > 0) {
			sampled = true;
			// 系统化的加权重采样
			const stepW = totalWeight / sampleCount;
			let cum = 0;
			let nextThreshold = stepW * 0.5; // 从半步开始，让采样点居中
			let pi = 0;
			for (let s = 0; s < sampleCount && pi < interiorPixels.length; s++) {
				while (pi < interiorPixels.length - 1 && cum + weights[pi]! < nextThreshold) {
					cum += weights[pi]!;
					pi++;
				}
				const idx = interiorPixels[pi]!;
				samples.push({ x: idx % w, y: Math.floor(idx / w) });
				const raw = densityMap[idx]!;
				sampleDensity.push(raw >= 0 ? raw : baseline);
				nextThreshold += stepW;
				cum += weights[pi]!;
				pi++;
			}
		}
	}

	if (!sampled) {
		// 均匀采样（没有密度数据，或者所有密度都是 0）
		const step = interiorPixels.length / sampleCount;
		for (let i = 0; i < sampleCount; i++) {
			const idx = interiorPixels[Math.floor(i * step)]!;
			samples.push({ x: idx % w, y: Math.floor(idx / w) });
			sampleDensity.push(0);
		}
	}

	// 所有采样点的密度都是 0（每个房间都被设成 0）时，退回均匀权重。
	const maxDensity = Math.max(...sampleDensity);
	if (maxDensity <= 0) {
		for (let i = 0; i < sampleDensity.length; i++) sampleDensity[i] = 1;
	}

	/*
	 * 每个采样点上客户端站得多高
	 */
	const sampleLift =
		(msg.surfaces?.length ?? 0) > 0
			? Float64Array.from(samples, (sample) =>
					surfaceHeightAt(msg.surfaces!, sample.x, sample.y) * (msg.worldUnitsPerMeter ?? 1)
				)
			: null;

	// 采样点定下来之后建一次，交给每个评估器。
	// 信道也在这里解
	// 和两个评估器遍历信号源的顺序一致。
	const resolvedChannels = resolveChannels([...aps, ...fixedAps]);
	// 每个信号源可用的信道列表，Worker 自己给布局着色时才用。
	// 每个频段的调色板按「互不重叠」来定的宽度：取该频段在用的最宽值。
	const widthByBand = new Map<string, number>();
	for (const ap of [...aps, ...fixedAps]) {
		widthByBand.set(ap.band, Math.max(widthByBand.get(ap.band) ?? 20, ap.channelWidth ?? 20));
	}
	const paletteWidth = (band: Band): ChannelWidth => (widthByBand.get(band) ?? 20) as ChannelWidth;
	const sourceAllowed: number[][] | null = msg.regulatoryDomain
		? [...aps, ...fixedAps].map((ap) => {
				if (ap.fixedChannel !== null && ap.fixedChannel !== undefined) {
					const valid = getAvailableChannels(ap.band, msg.regulatoryDomain!, {
						includeDfs: true
					}).some(
						(channel) =>
							channel.number === ap.fixedChannel &&
							channel.maxWidth >= (ap.channelWidth ?? 20)
					);
					if (valid) return [ap.fixedChannel];
				}
				const width = paletteWidth(ap.band);
				return planningCandidates(ap.band, msg.regulatoryDomain!, width, {
					includeDfs: width >= 160
				}).map((c) => c.number);
			})
		: null;
	const sourceBands = [...aps, ...fixedAps].map((ap) => ap.band as string);
	// 区间模型，整理成干扰项要的形式：「i 和 j 两个信号源共用较窄那个信道的比例」。
	const sourceWidths = [...aps, ...fixedAps].map((ap) => ap.channelWidth ?? 20);
	const overlap = makeInterferenceLookup(sourceBands, sourceWidths);
	// 从安装位置到客户端的竖直距离
	const apGaps = new Float64Array(aps.length);
	for (let i = 0; i < aps.length; i++) apGaps[i] = aps[i]!.verticalGap ?? 0;
	const apProfiles = aps.map((ap) => antennaProfile(ap));
	const fixedProfiles = fixedAps.map((ap) => antennaProfile(ap));
	/**
	 * 评估器需要的一切（接入点位置除外），打包成一个对象。
	 */
	const ctx: EvalContext = {
		samples,
		mask,
		w,
		h,
		wallAttenuation,
		fixedAps,
		sampleDensity,
		materialMask,
		columns: msg.columns ?? [],
		reflectingWalls: msg.reflectingWalls ?? [],
		secondPairsByBand: new Map(),
		defaultMaterial,
		sourceChannels: resolvedChannels.channels,
		sourceAllowed,
		sourceBands,
		apGaps,
		sampleLift,
		surfaces: msg.surfaces ?? [],
		wupm: msg.worldUnitsPerMeter ?? 1,
		apProfiles,
		fixedProfiles,
		overlap,
		channelsKnown: resolvedChannels.known || sourceAllowed !== null,
		interferenceWeight: msg.interferenceWeight ?? DEFAULT_INTERFERENCE_WEIGHT,
		coverageSoftnessDb: msg.coverageSoftnessDb ?? DEFAULT_COVERAGE_SOFTNESS_DB,
		localVerticalDropWu: msg.localVerticalDrop ?? 0,
		coverageFloor: Math.max(0, msg.coverageFloor ?? 0),
		// 取这次运行里最窄的信道
		// sourceWidths 已经为重叠查表建好了，而且一次运行至少有一个接入点。
		minChannelWidthMhz: sourceWidths.length > 0 ? Math.min(...sourceWidths) : 20,
		// 在这里建一次，而不是每次评估都建：固定接入点不移动，
		// 它跨层路径切成哪几段、每个采样点上它那块楼板是不是洞，整个运行期间都不变。
		fixedPaths: buildFixedPaths(
			fixedAps,
			samples,
			mask,
			w,
			h,
			materialMask,
			defaultMaterial,
			wallAttenuation
		),
		apSources: aps,
		wallMounted,
		wallPlacement
	};

	// 每个用到的频段一个懒缓存。构造时不走任何射线
	reply(msg.runId, {
		type: 'progress',
		positions: [],
		score: 0,
		iteration: 0,
		totalIterations: 100,
		stage: 'Precomputing...'
	});
	const caches = new Map<Band, WallCache>();
	const makeCache = (band: Band): WallCache =>
		createWallCache(
			mask,
			w,
			h,
			samples,
			wallAttenuation,
			band,
			materialMask,
			defaultMaterial
		);
	for (const ap of aps) {
		if (!caches.has(ap.band)) caches.set(ap.band, makeCache(ap.band));
	}
	for (const fap of fixedAps) {
		if (!caches.has(fap.band)) caches.set(fap.band, makeCache(fap.band));
	}

	await yieldToEventLoop();
	if (run.cancelled) {
		reply(msg.runId, { type: 'cancelled' });
		return;
	}

	if (msg.graphOnly) {
		const positions: Position[] = aps.map((a) => ({
			id: a.id,
			x: a.x,
			y: a.y,
			radius: a.interferenceRadius,
			band: a.band
		}));
		const field = fillMargins(positions, ctx);
		const pairs: Array<[number, number]> = [];
		for (let i = 0; i < field.count; i++) {
			for (let j = i + 1; j < field.count; j++) {
				if (field.conflicts[i * field.count + j]) pairs.push([i, j]);
			}
		}
		reply(msg.runId, {
			type: 'result',
			positions: aps.map((a) => ({ id: a.id, x: a.x, y: a.y })),
			score: 0,
			improvement: 0,
			seed: runSeed,
			sampleCount: samples.length,
			graph: { pairs, count: field.count, weights: Array.from(field.weights) }
		});
		return;
	}

	// ─── 第 1 阶段：信号加权的 Lloyd 迭代 ────────────────────────────

	const positions: Position[] = [];

	/*
	 * k-means++ 初始化，在每个接入点允许的范围内取点：吊顶或地装取室内，壁挂取贴墙的带子。
	 */
	const pixelsFor = (a: number): number[] =>
		wallMounted[a] && bandPixels.length > 0 ? bandPixels : interiorPixels;
	const firstSet = pixelsFor(0);
	const firstIdx = firstSet[Math.floor(random() * firstSet.length)]!;
	positions.push({
		id: aps[0]!.id,
		x: firstIdx % w,
		y: Math.floor(firstIdx / w),
		radius: aps[0]!.interferenceRadius,
		band: aps[0]!.band
	});

	for (let k = 1; k < numAps; k++) {
		const candidates = pixelsFor(k);
		let bestDist = -1;
		let bestPx = candidates[0]!;
		for (const px of candidates) {
			const px_x = px % w;
			const px_y = Math.floor(px / w);
			let minD = Infinity;
			for (const p of positions) {
				const d = (px_x - p.x) ** 2 + (px_y - p.y) ** 2;
				if (d < minD) minD = d;
			}
			if (minD > bestDist) {
				bestDist = minD;
				bestPx = px;
			}
		}
		positions.push({
			id: aps[k]!.id,
			x: bestPx % w,
			y: Math.floor(bestPx / w),
			radius: aps[k]!.interferenceRadius,
			band: aps[k]!.band
		});
	}

	// Lloyd 迭代
	for (let iter = 0; iter < 30; iter++) {
		if (run.cancelled) {
			reply(msg.runId, { type: 'cancelled' });
			return;
		}

		const buckets: Array<{ sumX: number; sumY: number; sumW: number }> = positions.map(() => ({
			sumX: 0,
			sumY: 0,
			sumW: 0
		}));

		const iterApRows: Float32Array[] = new Array(numAps);
		for (let a = 0; a < numAps; a++) {
			iterApRows[a] = caches.get(positions[a]!.band)!.tableFor(positions[a]!.x, positions[a]!.y);
		}
		const iterFixedRows: Float32Array[] = new Array(fixedAps.length);
		const iterFixedSlabDb = new Float64Array(fixedAps.length);
		for (let f = 0; f < fixedAps.length; f++) {
			iterFixedRows[f] = caches.get(fixedAps[f]!.band)!.tableFor(fixedAps[f]!.x, fixedAps[f]!.y);
			iterFixedSlabDb[f] = slabDbOf(fixedAps[f]!.signalScale);
		}

		const iterApProfiles = resolveApProfiles(positions, ctx);

		for (let s = 0; s < samples.length; s++) {
			let bestAp = 0;
			// 最大余量
			let bestMargin = -Infinity;
			const lift = ctx.sampleLift?.[s] ?? 0;
			for (let a = 0; a < numAps; a++) {
				const dx = samples[s]!.x - positions[a]!.x;
				const dy = samples[s]!.y - positions[a]!.y;
				const dist = Math.sqrt(dx * dx + dy * dy);
				const gap = (ctx.apGaps[a] ?? 0) - lift;
				const margin =
					sourceMargin(
						dist,
						positions[a]!.radius,
						iterApRows[a]![s]! + deckLossAt(ctx, samples[s]!.x, samples[s]!.y, gap),
						gap,
						-ctx.coverageSoftnessDb
					) -
					antennaRayLossDb(iterApProfiles[a]!, gap, dx, dy);
				if (margin > bestMargin) {
					bestMargin = margin;
					bestAp = a;
				}
			}
			// 固定接入点只贡献信号，不认领采样点
			for (let f = 0; f < fixedAps.length; f++) {
				const fap = fixedAps[f]!;
				const dx = samples[s]!.x - fap.x;
				const dy = samples[s]!.y - fap.y;
				const dist = Math.sqrt(dx * dx + dy * dy);
				const path = ctx.fixedPaths[f];
				const split = path?.split;
				const wallDb = split ? split.source[s]! + split.suffix[s]! : iterFixedRows[f]![s]!;
				// 楼板上有洞的地方，楼板损耗算 0。
				const slabDb =
					path?.slabFactor != null
						? iterFixedSlabDb[f]! * path.slabFactor[s]!
						: iterFixedSlabDb[f]!;
				const margin =
					sourceMargin(
						dist,
						fap.interferenceRadius,
						wallDb + slabDb + deckLossAt(ctx, samples[s]!.x, samples[s]!.y, fap.verticalGap - lift),
						fap.verticalGap - lift,
						-ctx.coverageSoftnessDb
					) -
					antennaRayLossDb(ctx.fixedProfiles[f]!, fap.verticalGap - lift, dx, dy);
				if (margin > bestMargin) bestMargin = margin;
			}
			const deficit = 1.0 - coverageUtilityAboveThreshold(bestMargin, ctx.coverageSoftnessDb);
			const densityW = sampleDensity[s] ?? baseline;
			const weight = (1 + deficit * 3) * densityW;
			buckets[bestAp]!.sumX += samples[s]!.x * weight;
			buckets[bestAp]!.sumY += samples[s]!.y * weight;
			buckets[bestAp]!.sumW += weight;
		}

		let maxMove = 0;
		for (let a = 0; a < numAps; a++) {
			const b = buckets[a]!;
			if (b.sumW === 0) continue;
			const nx = b.sumX / b.sumW;
			const ny = b.sumY / b.sumW;
			maxMove = Math.max(maxMove, Math.hypot(nx - positions[a]!.x, ny - positions[a]!.y));
			const snapped = snapForAp(a, nx, ny, wallMounted, snapTarget, wallPlacement);
			positions[a]!.x = snapped.x;
			positions[a]!.y = snapped.y;
		}
		if (maxMove < 1.0) break;
	}

	const lloydsScore = evaluateCoverage(positions, caches, ctx);
	reply(msg.runId, {
		type: 'progress',
		positions: positions.map((p) => ({ id: p.id, x: p.x, y: p.y })),
		score: lloydsScore,
		iteration: 25,
		totalIterations: 100,
		stage: "Lloyd's complete"
	});

	await yieldToEventLoop();
	if (run.cancelled) {
		reply(msg.runId, { type: 'cancelled' });
		return;
	}

	// ─── 第 2 阶段：PSO 粒子群细化 ────────────────────────────────

	const SWARM = 20;
	const PSO_ITERS = 60;
	const dim = numAps * 2;

	const pos = new Float32Array(SWARM * dim);
	const vel = new Float32Array(SWARM * dim);
	const pBest = new Float32Array(SWARM * dim);
	const pBestScore = new Float32Array(SWARM);
	const gBest = new Float32Array(dim);
	let gBestScore = -Infinity;

	for (let a = 0; a < numAps; a++) {
		pos[a * 2] = positions[a]!.x;
		pos[a * 2 + 1] = positions[a]!.y;
	}
	pBest.set(pos.subarray(0, dim));

	const jitterRadius = Math.max(w, h) * 0.2;
	for (let p = 1; p < SWARM; p++) {
		for (let a = 0; a < numAps; a++) {
			const bx = positions[a]!.x + (random() - 0.5) * jitterRadius;
			const by = positions[a]!.y + (random() - 0.5) * jitterRadius;
			const snapped = snapForAp(a, bx, by, wallMounted, snapTarget, wallPlacement);
			pos[p * dim + a * 2] = snapped.x;
			pos[p * dim + a * 2 + 1] = snapped.y;
		}
		pBest.set(pos.subarray(p * dim, (p + 1) * dim), p * dim);
	}

	function evalParticle(pIdx: number): number {
		const tempPositions: Position[] = [];
		for (let a = 0; a < numAps; a++) {
			tempPositions.push({
				id: aps[a]!.id,
				x: pos[pIdx * dim + a * 2]!,
				y: pos[pIdx * dim + a * 2 + 1]!,
				radius: aps[a]!.interferenceRadius,
				band: aps[a]!.band
			});
		}
		return evaluateCoverage(tempPositions, caches, ctx);
	}

	for (let p = 0; p < SWARM; p++) {
		pBestScore[p] = evalParticle(p);
		if (pBestScore[p]! > gBestScore) {
			gBestScore = pBestScore[p]!;
			gBest.set(pos.subarray(p * dim, (p + 1) * dim));
		}
	}

	for (let iter = 0; iter < PSO_ITERS; iter++) {
		// 每 5 次迭代让出一次，好让取消消息进来
		if (iter % 5 === 0) {
			await yieldToEventLoop();
			if (run.cancelled) {
				reply(msg.runId, { type: 'cancelled' });
				return;
			}
		}

		const inertia = 0.9 - 0.5 * (iter / PSO_ITERS);
		const c1 = 1.5;
		const c2 = 1.5;

		for (let p = 0; p < SWARM; p++) {
			for (let d = 0; d < dim; d++) {
				const r1 = random();
				const r2 = random();
				const off = p * dim + d;
				vel[off] =
					inertia * vel[off]! +
					c1 * r1 * (pBest[off]! - pos[off]!) +
					c2 * r2 * (gBest[d]! - pos[off]!);
				pos[off] = pos[off]! + vel[off]!;
			}
			for (let a = 0; a < numAps; a++) {
				const px = pos[p * dim + a * 2]!;
				const py = pos[p * dim + a * 2 + 1]!;
				if (
					!allowedForAp(
						a,
						Math.round(px),
						Math.round(py),
						wallMounted,
						wallPlacement,
						interior,
						w,
						h,
						allowOutside,
						voidMask
					)
				) {
					const snapped = snapForAp(a, px, py, wallMounted, snapTarget, wallPlacement);
					pos[p * dim + a * 2] = snapped.x;
					pos[p * dim + a * 2 + 1] = snapped.y;
				}
			}

			const score = evalParticle(p);
			if (score > pBestScore[p]!) {
				pBestScore[p] = score;
				pBest.set(pos.subarray(p * dim, (p + 1) * dim), p * dim);
				if (score > gBestScore) {
					gBestScore = score;
					gBest.set(pos.subarray(p * dim, (p + 1) * dim));
				}
			}
		}

		// 每几轮报一次，最后一轮必报，进度条才能走完这一阶段的区间，不会卡在中间。
		if (iter % 5 === 0 || iter === PSO_ITERS - 1) {
			const gPositions: Array<{ id: string; x: number; y: number }> = [];
			for (let a = 0; a < numAps; a++) {
				gPositions.push({ id: aps[a]!.id, x: gBest[a * 2]!, y: gBest[a * 2 + 1]! });
			}
			reply(msg.runId, {
				type: 'progress',
				positions: gPositions,
				score: gBestScore,
				iteration: 25 + Math.round(((iter + 1) / PSO_ITERS) * 55),
				totalIterations: 100,
				stage: 'PSO refining'
			});
		}
	}

	// ─── 第 3 阶段：坐标下降精修 ─────────────────────────────

	await yieldToEventLoop();
	if (run.cancelled) {
		reply(msg.runId, { type: 'cancelled' });
		return;
	}

	const finalPositions: Position[] = [];
	for (let a = 0; a < numAps; a++) {
		finalPositions.push({
			id: aps[a]!.id,
			x: Math.round(gBest[a * 2]!),
			y: Math.round(gBest[a * 2 + 1]!),
			radius: aps[a]!.interferenceRadius,
			band: aps[a]!.band
		});
	}

	const DIRS = [
		[1, 0],
		[-1, 0],
		[0, 1],
		[0, -1],
		[1, 1],
		[-1, 1],
		[1, -1],
		[-1, -1]
	];
	let polishStep = 5;
	const minStep = 0.5;
	let polishPass = 0;

	// 精修轮数的硬上限
	const MAX_POLISH_PASSES = 40;
	while (polishStep >= minStep && polishPass < MAX_POLISH_PASSES) {
		await yieldToEventLoop();
		if (run.cancelled) {
			reply(msg.runId, { type: 'cancelled' });
			return;
		}
		let improved = false;
		let bestScore = evaluateExact(finalPositions, ctx);

		for (let a = 0; a < numAps; a++) {
			for (const [ddx, ddy] of DIRS) {
				const oldX = finalPositions[a]!.x;
				const oldY = finalPositions[a]!.y;
				const nx = Math.round(oldX + ddx! * polishStep);
				const ny = Math.round(oldY + ddy! * polishStep);
				if (
					!allowedForAp(
						a,
						nx,
						ny,
						wallMounted,
						wallPlacement,
						interior,
						w,
						h,
						allowOutside,
						voidMask
					)
				) {
					continue;
				}
				finalPositions[a]!.x = nx;
				finalPositions[a]!.y = ny;
				const score = evaluateExact(finalPositions, ctx);
				if (score > bestScore) {
					bestScore = score;
					improved = true;
				} else {
					finalPositions[a]!.x = oldX;
					finalPositions[a]!.y = oldY;
				}
			}
		}

		reply(msg.runId, {
			type: 'progress',
			positions: finalPositions.map((p) => ({ id: p.id, x: Math.round(p.x), y: Math.round(p.y) })),
			score: bestScore,
			iteration: Math.min(98, 80 + polishPass * 6),
			totalIterations: 100,
			stage: 'Polishing'
		});
		polishPass++;

		if (!improved) polishStep *= 0.5;
	}

	// 在输出上再执行一次布点策略
	if (!allowOutside) {
		for (const p of finalPositions) {
			const s = snapToInterior(p.x, p.y, interiorField, false);
			p.x = s.x;
			p.y = s.y;
		}
	}

	// 调用方给了可选功率时就调发射功率：布点定下来之后，在最后一块上做块坐标下降。
	const powerReport = refinePower(finalPositions, aps, ctx, msg);

	// 起点和终点都用同一个 context 打分，比较才不会牵扯两套模型。
	const inputPositions = aps.map((a) => ({
		id: a.id,
		x: a.x,
		y: a.y,
		radius: a.interferenceRadius,
		band: a.band
	}));

	const initialEval = evaluateExactDetailed(inputPositions, ctx, true);
	const finalEval = evaluateExactDetailed(finalPositions, ctx, true);
	const reverted = finalEval.score < initialEval.score;
	const chosen = reverted ? inputPositions : finalPositions;
	const chosenEval = reverted ? initialEval : finalEval;
	const improvement =
		initialEval.score > 0 ? ((chosenEval.score - initialEval.score) / initialEval.score) * 100 : 0;

	reply(msg.runId, {
		type: 'result',
		positions: chosen.map((p) => ({ id: p.id, x: Math.round(p.x), y: Math.round(p.y) })),
		score: chosenEval.score,
		coverage: chosenEval.coverage,
		/** 选中布局的同频干扰占比。 */
		interference: chosenEval.interference,
		/** 两个信道重叠的接入点都高于 CCA 门限的那部分空口时间占比。 */
		contention: chosenEval.contention,
		/**
		 * 选中方案比 ε-约束的下限还差多少，按 0-1 的比例。
		 */
		shortfall: chosenEval.shortfall,
		channelsKnown: ctx.channelsKnown,
		sampleCount: chosenEval.samples,
		improvement,
		reverted,
		seed: runSeed,
		powers: powerReport ?? undefined
	});
}
