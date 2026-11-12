/**
 * 信道求解器状态。
 *
 * 负责建冲突图、调 worker 里的着色算法，把结果摊匀后落到各 AP 上，再估算吞吐。
 */
import { debug } from '$lib/log.js';
import { buildInterferenceGraph } from '@aetherax/geometry';
import { planningChannels, planningCandidates, estimateThroughput } from '@aetherax/channels';
import type { ChannelWidth, ThroughputEstimate, ThroughputInput } from '@aetherax/channels';
import type { Band } from '@aetherax/channels';
import type { SolverResult, ComparisonResult } from '@aetherax/solver';
import { updateAp, clearAssignments } from './ap-state.svelte.js';
import { SolverBridge } from '../workers/solver-bridge.js';
import { floorState, getFloorSlabAttenuation } from './floor-state.svelte.js';
import { getMaterialDbTable, getFlatAttenuation, type WallMaterialId } from '$lib/domain/materials.js';
import { rayMarchWallAtten } from '../rf/propagation.js';
import { balanceAssignment, widenAssignment } from '../rf/interference.js';
import { makeInterferenceLookup } from '../rf/channel-overlap.js';
import { wallState } from './wall-state.svelte.js';
import {
	getFloorMask,
	type DecodedFloorMask
} from './floor-mask.js';
import { buildAssignmentConflictEdges, updateCoverage } from './optimizer.svelte.js';
import { scheduleSave } from './persistence.svelte.js';
import { findModel } from '$lib/data/ap-models.js';

type Algorithm = 'greedy' | 'dsatur' | 'welsh-powell' | 'backtracking';

const bridge = new SolverBridge();

/**
 * 上一次的冲突图
 */
let lastGraph: { signature: string; graph: Awaited<ReturnType<typeof buildGraphUncached>> } | null =
	null;

/** 冲突图依赖的所有输入，拼成一个字符串。 */
function graphSignature(): string {
	const aps = apState.aps
		.map(
			(ap) =>
				`${ap.id}:${Math.round(ap.x)}:${Math.round(ap.y)}:${ap.floorId}:${ap.band}:${ap.interferenceRadius}:${ap.channelWidth}:${ap.mount ?? ''}:${ap.mountHeightM}:${ap.facingDeg ?? ''}`
		)
		.join('|');
	const walls = floorState.floors
		.map(
			(floor) =>
				`${floor.id}:${(floor.walls ?? [])
					.map((w) => `${Math.round(w.ax)},${Math.round(w.ay)},${Math.round(w.bx)},${Math.round(w.by)},${w.heightM ?? 0},${w.material}`)
					.join(';')}`
		)
		.join('|');
	return `${aps}##${walls}##${wallState.wallMaterial}##${projectMeta.clientHeight}`;
}

/** AP 两两之间的衰减后信号："apIdA:apIdB" → 信号（0-1）。 */
export const edgeSignals = new Map<string, number>();

export const solverState = $state({
	algorithm: 'dsatur' as Algorithm,
	isRunning: false,
	lastResult: null as SolverResult | null,
	comparisonResults: null as ComparisonResult | null,
	lastTiming: 0,
	error: null as string | null,
	autoSolve: true,
	throughputEstimates: [] as ThroughputEstimate[]
});

/** 算每层累计的 z 位置（世界单位）。 */
function getFloorZ(): Map<string, number> {
	const wupm = wupmForFloor(floorState.currentFloorId);
	const sorted = [...floorState.floors].sort((a, b) => a.level - b.level);
	const zMap = new Map<string, number>();
	let z = 0;
	for (const floor of sorted) {
		zMap.set(floor.id, z * wupm);
		z += floor.ceilingHeight;
	}
	return zMap;
}

function getApPositions() {
	const floorZ = getFloorZ();
	const reference = floorState.currentFloorId;
	return apState.aps.map((ap) => {
		// 位置、半径和 z 是要跨楼层比的，所以统一换算到当前楼层的单位：否则标定分辨率
		// 翻倍的那层会看着远一倍，它的 AP 也大一倍。
		const k = scaleBetween(ap.floorId, reference);
		return {
			id: ap.id,
			x: ap.x * k,
			y: ap.y * k,
			z: floorZ.get(ap.floorId) ?? 0,
			interferenceRadius: ap.interferenceRadius * k
		};
	});
}

// ─── 解码后的墙体掩码缓存（按楼层） ──────────────────────────────────────

/**
 * 缓存现在住在 `floor-mask.ts`：优化器的载荷也要用它。放在这儿的时候，
 * `optimizer.svelte.ts` 得反过来 import 本模块，而 solver 又需要优化器的边缘评估来
 * 建冲突图（见 `buildAssignmentConflictEdges`），方向就反了。这里再导出一次，
 * 原来那些 import 都不用改。
 */
export {
	getFloorMask,
	invalidateSolverMaskCache,
	type DecodedFloorMask
} from './floor-mask.js';
import { apState, wupmForFloor } from '$state/ap-state.svelte.js';
import { scaleBetween } from './floor-scale.js';
import { projectMeta } from '$state/project-meta.svelte.js';


// ─── 衰减相关的辅助函数 ──────────────────────────────────────────────────

/** 按 id 查楼层，每次求解建一次。 */
let floorByIdCache = new Map<string, (typeof floorState.floors)[0]>();

function prepareSortedFloors(): void {
	floorByIdCache = new Map(floorState.floors.map((f) => [f.id, f]));
}

/** 同一层两个 AP 之间的墙体衰减：每次穿墙按材料表给一个固定值，
 *  口径和目标函数、热力图完全一致。 */
function getWallLoss(
	mask: DecodedFloorMask,
	ax: number,
	ay: number,
	bx: number,
	by: number,
	defaultMaterial: number,
	wupm: number,
	band: Band
): number {
	const matDb = getMaterialDbTable(band);
	const defaultDb = getFlatAttenuation(defaultMaterial as WallMaterialId, band) || 5;
	// 世界坐标转成掩码局部坐标，再走射线步进
	const ox = mask.originX ?? 0;
	const oy = mask.originY ?? 0;
	return rayMarchWallAtten(
		mask.wallData,
		mask.width,
		mask.height,
		mask.materialMap,
		matDb,
		defaultDb,
		ax - ox,
		ay - oy,
		bx - ox,
		by - oy,
		3,
		defaultMaterial
	);
}

// ─── 建冲突图 ────────────────────────────────────────────────────────────

/**
 * 谁不能和谁共用信道，以及每一对之间的耦合强度。
 */
async function buildSerializedGraph() {
	const signature = graphSignature();
	if (lastGraph && lastGraph.signature === signature) return lastGraph.graph;
	const graph = await buildGraphUncached();
	lastGraph = { signature, graph };
	return graph;
}

async function buildGraphUncached() {
	prepareSortedFloors();
	edgeSignals.clear();
	const aps = getApPositions();
	const apMap = new Map(apState.aps.map((ap) => [ap.id, ap]));

	// 先把有 AP 的那些楼层的墙体掩码并行解码
	const apFloorIds = new Set(apState.aps.map((ap) => ap.floorId));
	const maskPromises = [...apFloorIds].map(async (fid) => [fid, await getFloorMask(fid)] as const);
	const masks = new Map(await Promise.all(maskPromises));

	// 建 z 位置查找表，循环里 O(1) 取值
	const apZMap = new Map(aps.map((a) => [a.id, a.z ?? 0]));

	// 不管冲突图怎么判，每一对都算一个耦合值，先无条件算完：它喂给 AP 编辑器和吞吐
	// 模型，而这两者都需要那些不是边的对的数值。
	for (let i = 0; i < aps.length; i++) {
		for (let j = i + 1; j < aps.length; j++) {
			const apA = aps[i]!;
			const apB = aps[j]!;
			const entityA = apMap.get(apA.id);
			const entityB = apMap.get(apB.id);
			if (!entityA || !entityB) continue;

			let totalDb = 0;
			if (entityA.floorId === entityB.floorId) {
				// 同层：算墙体衰减
				const mask = masks.get(entityA.floorId);
				if (mask) {
					// 当前楼层用 wallState（永远是最新的），其他楼层用楼层对象
					const defMat =
						entityA.floorId === floorState.currentFloorId
							? wallState.wallMaterial
							: (floorByIdCache.get(entityA.floorId)?.wallMaterial ?? 0);
					totalDb = getWallLoss(
						mask,
						entityA.x,
						entityA.y,
						entityB.x,
						entityB.y,
						defMat,
						// 掩码是这层楼的，用的是这层的像素。
						wupmForFloor(entityA.floorId),
						entityA.band as Band
					);
				}
			} else {
				// 跨楼层：算楼板衰减（取最坏频段，偏保守）
				totalDb = getFloorSlabAttenuation(entityA.floorId, entityB.floorId, entityA.band as Band);
			}

			// 这对 AP 之间的衰减后信号：距离上按四次方反比，再乘上墙体/楼板损耗这个功率因子。
			const dx = apA.x - apB.x;
			const dy = apA.y - apB.y;
			const dz = (apZMap.get(apA.id) ?? 0) - (apZMap.get(apB.id) ?? 0);
			const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
			const r = Math.max(entityA.interferenceRadius, entityB.interferenceRadius);
			const ratio = dist / r;
			const r4 = ratio * ratio * ratio * ratio;
			const signal = 1 / (1 + r4);
			const attenFactor = totalDb > 0 ? Math.pow(10, -totalDb / 10) : 1;
			edgeSignals.set([apA.id, apB.id].sort().join(':'), signal * attenFactor);
		}
	}

	const graph = await buildAssignmentConflictEdges();
	let conflicting: Array<[string, string]>;
	/** 每一对冲突要付多少代价。见 `buildAssignmentConflictEdges`。 */
	let conflictWeights: Map<string, number>;
	if (graph.complete) {
		conflicting = graph.edges;
		conflictWeights = graph.weights;
	} else {
		// 没有可采样的内部。退回老过滤器留下的那些圆重叠对，这样墙不闭合的方案也还能分到信道。
		console.warn(
			'[solver] no enclosed interior to build a conflict graph from; ' +
				'falling back to circle overlap. Coverage and interference are not ' +
				'measurable on this plan until the walls close.'
		);
		const { edges } = buildInterferenceGraph(aps);
		conflicting = edges
			.filter((edge) => (edgeSignals.get([edge.a, edge.b].sort().join(':')) ?? 0) >= 0.005)
			.map((edge) => [edge.a, edge.b] as [string, string]);
		// 退回的图背后没有采样计数，所以每条边权重一样 —— 正好就是不加权的行为。
		conflictWeights = new Map();
	}

	// 转成 worker 要的邻接表格式
	const nodes = aps.map((ap) => ap.id);
	const adjacency = new Map<string, string[]>();
	for (const node of nodes) {
		adjacency.set(node, []);
	}
	for (const [a, b] of conflicting) {
		adjacency.get(a)?.push(b);
		adjacency.get(b)?.push(a);
	}

	return {
		nodes,
		edges: Array.from(adjacency.entries()),
		// 每条边的代价跟图一起带出去：下面几个着色器要靠它知道哪个冲突该留着。
		// 见 `buildAssignmentConflictEdges`。
		weights: conflictWeights
	};
}

/**
 * 某个频段上实际在用的最大信道宽度，非重叠的信道集合得按它来建：在 80 MHz 下都不
 * 重叠的一组，在 20 MHz 下更不会重叠。见 `planningChannels`。
 */
function widestWidthOn(band: Band): ChannelWidth {
	const widths = apState.aps.filter((ap) => ap.band === band).map((ap) => ap.channelWidth);
	return (widths.length > 0 ? Math.max(...widths) : 20) as ChannelWidth;
}

/** 规划器在某频段可以分配的信道：互不重叠，所以 `number_a === number_b` 就等于"互相干扰"。 */
function planningChannelNumbers(band: Band): number[] {
	return planningChannels(band, apState.regulatoryDomain, widestWidthOn(band)).map(
		(ch) => ch.number
	);
}

function getColorOptions(): number[] {
	// 用 AP 里最常见的频段，没有就退回项目默认值
	const bandCounts = new Map<string, number>();
	for (const ap of apState.aps) {
		bandCounts.set(ap.band, (bandCounts.get(ap.band) ?? 0) + 1);
	}
	let primaryBand = apState.band;
	let maxCount = 0;
	for (const [band, count] of bandCounts) {
		if (count > maxCount) {
			maxCount = count;
			primaryBand = band as typeof apState.band;
		}
	}
	return planningChannelNumbers(primaryBand);
}

function getFixedAssignments(): [string, number][] {
	const fixed: [string, number][] = [];
	for (const ap of apState.aps) {
		if (ap.fixedChannel !== null) {
			fixed.push([ap.id, ap.fixedChannel]);
		}
	}
	return fixed;
}

function applyAssignments(assignment: Map<string, number>): void {
	for (const [apId, channel] of assignment) {
		updateAp(apId, { assignedChannel: channel });
	}
	void updateCoverage();
}

function computeThroughput(): void {
	const inputs: ThroughputInput[] = apState.aps.map((ap) => {
		// 用 edgeSignals 里真实的衰减后信号（建图时算了墙体和楼板衰减），不用几何重叠
		const coChannelOverlaps: number[] = [];
		for (const other of apState.aps) {
			if (other.id === ap.id) continue;
			if (other.assignedChannel !== ap.assignedChannel || ap.assignedChannel === null) continue;
			const pairKey = [ap.id, other.id].sort().join(':');
			const signal = edgeSignals.get(pairKey);
			if (signal !== undefined && signal > 0) {
				coChannelOverlaps.push(signal);
			}
		}
		// 查设备型号参数，好把 PHY 速率算准
		const model = ap.modelId ? findModel(ap.modelId) : null;
		const bandSpec = model?.bands.find((b) => b.band === ap.band);
		return {
			apId: ap.id,
			band: ap.band,
			channelWidth: ap.channelWidth,
			assignedChannel: ap.assignedChannel,
			coChannelOverlaps,
			wifiStandard: model?.wifiStandard,
			streams: bandSpec?.streams
		};
	});

	solverState.throughputEstimates = estimateThroughput(inputs, {
		ispSpeed: projectMeta.ispSpeed,
		targetThroughput: projectMeta.targetThroughput
	});
}

export async function runSolver(): Promise<void> {
	if (apState.aps.length === 0) return;
	if (solverState.isRunning) return;

	solverState.isRunning = true;
	solverState.error = null;
	const started = performance.now();

	try {
		const graph = await buildSerializedGraph();
		const fixedAssignments = getFixedAssignments();
		debug(`[solve] graph built in ${Math.round(performance.now() - started)} ms`);

		// 各个频段分开解 —— 不同频段互不干扰
		const bands = new Set(apState.aps.map((ap) => ap.band));
		const mergedAssignment = new Map<string, number>();
		let totalConflicts: [string, string][] = [];
		let totalColors = 0;
		let totalTime = 0;

		for (const band of bands) {
			const bandApIds = new Set(
				apState.aps.filter((ap) => ap.band === band).map((ap) => ap.id)
			);
			// 把图裁到只剩这个频段的 AP
			const bandNodes = graph.nodes.filter((id) => bandApIds.has(id));
			const bandEdges = graph.edges
				.filter(([id]) => bandApIds.has(id))
				.map(
					([id, neighbors]) => [id, neighbors.filter((n) => bandApIds.has(n))] as [string, string[]]
				);

			const availableColors = planningChannelNumbers(band as Band);
			const bandFixed = fixedAssignments.filter(([id]) => bandApIds.has(id));

			const result = await bridge.solve(
				{ nodes: bandNodes, edges: bandEdges },
				{
					algorithm: solverState.algorithm,
					availableColors,
					fixedAssignments: bandFixed.length > 0 ? bandFixed : undefined,
					timeout: 5000
				}
			);

			const bandIndex = new Map(bandNodes.map((id, i) => [id, i]));
			const neighbours = new Map(bandEdges);
			const pinnedIds = new Set(bandFixed.map(([id]) => id));
			const adjacency = bandNodes.map((id) =>
				(neighbours.get(id) ?? [])
					.map((n) => bandIndex.get(n))
					.filter((n): n is number => n !== undefined)
			);
			const bandNames = bandNodes.map(() => band as string);
			const widths = bandNodes.map(
				(id) => apState.aps.find((ap) => ap.id === id)?.channelWidth ?? 20
			);
			const overlap = makeInterferenceLookup(bandNames, widths);
			// 图的权重，放在这个频段自己的下标空间里，加宽那一趟才分得清共用一个信道是便宜
			// 还是贵。完全不冲突的位置是 0，也就是所有不是边的对。
			const weightMatrix = new Float32Array(bandNodes.length * bandNodes.length);
			for (let i = 0; i < bandNodes.length; i++) {
				for (const j of adjacency[i] ?? []) {
					const key = [bandNodes[i]!, bandNodes[j]!].sort().join(':');
					weightMatrix[i * bandNodes.length + j] = graph.weights.get(key) ?? 0;
				}
			}
			const pinnedFlags = bandNodes.map((id) => pinnedIds.has(id));
			const candidates = bandNodes.map((id) => {
				const ap = apState.aps.find((a) => a.id === id);
				// 锁定的 AP 就是单元素列表，跟 worker 里的着色器完全一致。
				if (!ap || ap.fixedChannel !== null) return [ap?.fixedChannel ?? availableColors[0]!];
				return planningCandidates(
					ap.band,
					apState.regulatoryDomain,
					ap.channelWidth
				).map((ch) => ch.number);
			});
			const order = bandNodes.map((id) => result.assignment.get(id) ?? availableColors[0]!);
			const widened = widenAssignment(order, adjacency, candidates, overlap, pinnedFlags, weightMatrix);
			// 只在信道集合内做均衡，跟以前一样：加宽后的候选是用来逃出被迫重叠的，
			// 不是用来把流量往频段上方摊的。
			const spread = balanceAssignment(
				widened,
				adjacency,
				bandNodes.map(() => availableColors),
				pinnedFlags,
				overlap
			);
			bandNodes.forEach((id, i) => mergedAssignment.set(id, spread[i]!));
			for (const [id, ch] of result.assignment) {
				// 锁定的 AP 保持 worker 被告知的那个信道，一个不改。
				if (pinnedIds.has(id)) mergedAssignment.set(id, ch);
			}
			totalConflicts = [...totalConflicts, ...result.conflicts];
			totalColors += result.colorCount;
			totalTime += result.timeMs;
		}

		solverState.lastResult = {
			assignment: mergedAssignment,
			colorCount: totalColors,
			conflicts: totalConflicts,
			timeMs: totalTime
		};
		solverState.lastTiming = totalTime;
		clearAssignments();
		applyAssignments(mergedAssignment);
		apState.aps = [...apState.aps];
		scheduleSave(true);
		computeThroughput();
		debug(`[solve] done in ${Math.round(performance.now() - started)} ms`);
	} catch (err) {
		solverState.error = err instanceof Error ? err.message : 'Solver failed';
	} finally {
		solverState.isRunning = false;
	}
}

export async function runComparison(): Promise<void> {
	if (apState.aps.length === 0) return;
	if (solverState.isRunning) return;

	solverState.isRunning = true;
	solverState.error = null;

	try {
		const graph = await buildSerializedGraph();
		const availableColors = getColorOptions();
		const fixedAssignments = getFixedAssignments();

		const result = await bridge.compare(graph, {
			availableColors,
			fixedAssignments: fixedAssignments.length > 0 ? fixedAssignments : undefined,
			timeout: 5000
		});

		solverState.comparisonResults = result;

		// 用最好的那次结果（信道最少、最快）
		if (result.results.length > 0) {
			const best = result.results[0]!;
			solverState.lastResult = best;
			solverState.lastTiming = best.timeMs;
			solverState.algorithm = best.algorithm as Algorithm;
			clearAssignments();
			applyAssignments(best.assignment);
			apState.aps = [...apState.aps];
			scheduleSave(true);
			computeThroughput();
		}
	} catch (err) {
		solverState.error = err instanceof Error ? err.message : 'Comparison failed';
	} finally {
		solverState.isRunning = false;
	}
}

