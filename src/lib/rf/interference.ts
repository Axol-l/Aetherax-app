/**
 * 目标函数中的同频干扰项：统计最佳服务器被同频次服务器削弱的采样点占比，见 `MODEL_NOTES.md` §6。
 * 在优化器既有的采样循环内用各源的 margin 直接计算，不新增传播计算，也不做 AP 间几何近似。
 */

/**
 * 同频次服务器算作干扰的 dB 窗口：比最佳服务器低多少以内仍会削弱它。
 */
export const COCHANNEL_REUSE_DB = 10;

/**
 * 目标函数中干扰占比的默认权重：`score = coverageUtility − interferenceWeight · interferenceShare`，
 * 两项均归一化到 0-1。
 */
export const DEFAULT_INTERFERENCE_WEIGHT = 0.2;

/**
 * 表示「尚未分配信道」的信道值。
 * 携带它的源与所有其他源互为同频，即规划的最坏情况。
 */
export const COCHANNEL_UNKNOWN = -1;

/** 一次运行的信道向量来源。 */
export interface ResolvedChannels {
	/** 每个信号源一项，顺序与评估器使用的源顺序一致。 */
	channels: number[];
	/** 为真实分配时为 true，全同频上界时为 false。 */
	known: boolean;
}

/**
 * 用于统计干扰的信道：所有源都有真实分配时用真实分配，否则一律按全同频最坏情况处理。
 * 全有或全无，避免结果取决于哪些 AP 恰好已被着色。
 */
export function resolveChannels(
	sources: ReadonlyArray<{ assignedChannel?: number | null }>
): ResolvedChannels {
	let known = true;
	for (const s of sources) {
		if (s.assignedChannel === null || s.assignedChannel === undefined) {
			known = false;
			break;
		}
	}
	if (!known) {
		return { channels: new Array<number>(sources.length).fill(COCHANNEL_UNKNOWN), known: false };
	}
	return { channels: sources.map((s) => s.assignedChannel as number), known: true };
}

/**
 * 两个源分配之间的频率重叠比例，以较窄信道的带宽为分母：不共享频谱为 0，完全同谱为 1。
 * `i`、`j` 是源下标，频段与带宽由实现自行闭包获取，见 `rf/channel-overlap.ts`。
 */
export type OverlapLookup = (
	i: number,
	channelI: number,
	j: number,
	channelJ: number
) => number;

/**
 * 默认的重叠模型：信道号相同即完全重叠，不同即完全不重叠。
 */
export const SAME_CHANNEL_OVERLAP: OverlapLookup = (_i, channelI, _j, channelJ) =>
	channelI === channelJ ? 1 : 0;

/**
 * 本采样点的最佳服务器是否被 `COCHANNEL_REUSE_DB` 以内的同频次服务器削弱，供冲突图使用。
 * `margins` 与 `channels` 按源同序索引，只读取从 `offset` 起的 `count` 项；
 * `bands` 把同频判定限制在同一频段内，省略时视为所有源同属一个频段。
 */
export function violatesAt(
	margins: ArrayLike<number>,
	channels: ArrayLike<number>,
	count: number,
	offset = 0,
	bands?: ArrayLike<string> | null
): boolean {
	return interferenceAt(margins, channels, count, offset, bands, SAME_CHANNEL_OVERLAP) > 0;
}

/**
 * 本采样点的最佳服务器被同频次服务器削弱多少，取值 0 到 1。
 * 判据与 `violatesAt` 相同，数值取与复用窗口内最差次服务器的频率重叠，`overlap` 决定折叠方式。
 */
export function interferenceAt(
	margins: ArrayLike<number>,
	channels: ArrayLike<number>,
	count: number,
	offset = 0,
	bands?: ArrayLike<string> | null,
	overlap: OverlapLookup = SAME_CHANNEL_OVERLAP
): number {
	let best = -Infinity;
	let bestIndex = -1;
	for (let i = 0; i < count; i++) {
		const m = margins[offset + i]!;
		if (m > best) {
			best = m;
			bestIndex = i;
		}
	}
	// 没有任何信号源到达该采样点，不存在干扰。
	if (bestIndex < 0 || best === -Infinity) return 0;

	const limit = best - COCHANNEL_REUSE_DB;
	const channel = channels[bestIndex]!;
	const band = bands ? bands[bestIndex] : null;
	let worst = 0;
	for (let i = 0; i < count; i++) {
		if (i === bestIndex) continue;
		if (bands && bands[i] !== band) continue;
		// 严格大于才计入：恰好落在复用距离上的次服务器属于阈值边界，不算违规。
		if (!(margins[offset + i]! > limit)) continue;
		const shared = overlap(bestIndex, channel, i, channels[i]!);
		if (shared > worst) worst = shared;
	}
	return worst;
}

// ─── 信道分配：哪些源对不能共用信道，以及各自分到什么 ──

/**
 * 大小为 `count x count` 的冲突矩阵，`[i * count + j]` 为 1 表示源 `i` 与 `j` 不能共用信道。
 */
export function conflictMatrix(count: number): Uint8Array {
	return new Uint8Array(count * count);
}

/**
 * 与 `conflictMatrix` 配套的冲突代价：按密度加权的采样点数量，即该源对实际造成的损害。
 * 全为 1 时等价于不带权重。
 */
export function conflictWeights(count: number): Float32Array {
	return new Float32Array(count * count);
}

/**
 * 标记本采样点内互相处于复用距离的源对，以最强源为基准并双向写入。
 * `weights` 非空时按 `weight`（密度）累加；`bands` 把边限制在同一频段内。
 */
export function markSampleConflicts(
	conflicts: Uint8Array,
	margins: ArrayLike<number>,
	count: number,
	offset = 0,
	bands?: ArrayLike<string> | null,
	weights: Float32Array | null = null,
	weight = 1
): void {
	let best = -Infinity;
	let bestIndex = -1;
	for (let i = 0; i < count; i++) {
		const m = margins[offset + i]!;
		if (m > best) {
			best = m;
			bestIndex = i;
		}
	}
	if (bestIndex < 0 || best === -Infinity) return;

	const limit = best - COCHANNEL_REUSE_DB;
	const band = bands ? bands[bestIndex] : null;
	for (let i = 0; i < count; i++) {
		if (i === bestIndex) continue;
		if (bands && bands[i] !== band) continue;
		if (!(margins[offset + i]! > limit)) continue;
		conflicts[bestIndex * count + i] = 1;
		conflicts[i * count + bestIndex] = 1;
		if (weights) {
			weights[bestIndex * count + i] = (weights[bestIndex * count + i] ?? 0) + weight;
			weights[i * count + bestIndex] = (weights[i * count + bestIndex] ?? 0) + weight;
		}
	}
}

/**
 * 在冲突图未作约束处，把信道均衡地铺开到可用信道表上，减少同频争用。
 * 逐个源移到占用严格更少的可用信道，且只选不与相邻源重叠的信道；`pinned` 为 true 的源不动，
 * 返回新数组，不修改入参。
 */
export function balanceAssignment(
	channels: readonly number[],
	adjacency: ReadonlyArray<readonly number[]>,
	allowed: ReadonlyArray<readonly number[]>,
	pinned: ReadonlyArray<boolean>,
	overlap: OverlapLookup = SAME_CHANNEL_OVERLAP
): number[] {
	const out = [...channels];
	const usage = new Map<number, number>();
	for (const channel of out) usage.set(channel, (usage.get(channel) ?? 0) + 1);

	for (let i = 0; i < out.length; i++) {
		if (pinned[i]) continue;
		const options = allowed[i];
		if (!options || options.length === 0) continue;
		const current = out[i]!;
		let best = current;
		// 只在占用严格更少时改选，平局保留先出现的候选，结果可复现。
		let bestUse = usage.get(current) ?? 0;
		for (const candidate of options) {
			if (candidate === current) continue;
			// 不迁到冲突邻居已占用的信道：均衡只负责铺开信道，不能制造干扰。
			let taken = false;
			for (const j of adjacency[i] ?? []) {
				if (overlap(i, candidate, j, out[j]!) > 0) {
					taken = true;
					break;
				}
			}
			if (taken) continue;
			const use = usage.get(candidate) ?? 0;
			if (use < bestUse) {
				best = candidate;
				bestUse = use;
			}
		}
		if (best === current) continue;
		usage.set(current, (usage.get(current) ?? 1) - 1);
		usage.set(best, (usage.get(best) ?? 0) + 1);
		out[i] = best;
	}
	return out;
}

/**
 * 候选信道的排序键，越小越好：与冲突邻居无重叠为 0，复用已被占用的中心为 1，
 * 新中心且与冲突邻居部分重叠为 2；同层内重叠越小越优，平局保留调用方给出的顺序。
 */
function rankCandidate(shared: number, used: boolean): [number, number] {
	return [shared === 0 ? 0 : used ? 1 : 2, shared];
}

/** 仅在严格更优时为真，平局保留先出现的候选。 */
function isBetterRank(a: readonly number[], b: readonly number[]): boolean {
	for (let i = 0; i < a.length; i++) {
		if (a[i]! !== b[i]!) return a[i]! < b[i]!;
	}
	return false;
}

/**
 * 一个候选信道在与它冲突的邻居上造成的损害。
 * 不带权重时取最大重叠，带权重时取各源对按权重加权的重叠之和。
 */
function damageOf(
	i: number,
	candidate: number,
	assigned: ReadonlyArray<number>,
	neighbours: Iterable<number>,
	overlap: OverlapLookup,
	weights: Float32Array | null,
	count: number
): number {
	if (!weights) {
		let worst = 0;
		for (const j of neighbours) {
			const s = overlap(i, candidate, j, assigned[j]!);
			if (s > worst) worst = s;
		}
		return worst;
	}
	let total = 0;
	for (const j of neighbours) {
		const s = overlap(i, candidate, j, assigned[j]!);
		if (s > 0) total += s * weights[i * count + j]!;
	}
	return total;
}

/**
 * 给每个信号源分配信道，遵守 `allowed` 与冲突矩阵。
 * 按受约束程度排序后逐个着色，取与冲突邻居重叠最小、占用最少、在 `allowed` 中靠前的候选；
 * 单元素列表视为固定信道，空列表的源保持 `COCHANNEL_UNKNOWN`（与所有源同频）。
 */
export function colourConflicts(
	conflicts: Uint8Array,
	count: number,
	allowed: ReadonlyArray<readonly number[]>,
	overlap: OverlapLookup = SAME_CHANNEL_OVERLAP,
	weights: Float32Array | null = null
): number[] {
	const channels = new Array<number>(count).fill(COCHANNEL_UNKNOWN);
	const done = new Array<boolean>(count).fill(false);
	const usage = new Map<number, number>();

	// 固定信道（单元素列表）的源先占位，并按已着色处理，使固定值对邻居构成约束。
	for (let i = 0; i < count; i++) {
		const options = allowed[i];
		if (options && options.length === 1) {
			channels[i] = options[0]!;
			done[i] = true;
			usage.set(channels[i]!, (usage.get(channels[i]!) ?? 0) + 1);
		}
	}

	for (let step = 0; step < count; step++) {
		// 选取下一个源：已着色邻居种类最多者优先，其次边权和最大者，仍并列时取下标小者以保证可复现。
		let pick = -1;
		let bestSaturation = -1;
		let bestMass = -1;
		for (let i = 0; i < count; i++) {
			if (done[i]) continue;
			let saturation = 0;
			let mass = 0;
			for (let j = 0; j < count; j++) {
				if (i === j || !conflicts[i * count + j]) continue;
				mass += weights ? weights[i * count + j]! : 1;
				if (done[j] && channels[j] !== COCHANNEL_UNKNOWN) saturation++;
			}
			if (
				saturation > bestSaturation ||
				(saturation === bestSaturation && mass > bestMass)
			) {
				pick = i;
				bestSaturation = saturation;
				bestMass = mass;
			}
		}
		if (pick < 0) break;
		done[pick] = true;

		const options = allowed[pick];
		if (!options || options.length === 0) continue;
		// 候选真正可能损害的邻居：只算已着色的源，未着色者还没有信道可重叠。
		const neighbours: number[] = [];
		for (let j = 0; j < count; j++) {
			if (j === pick || !conflicts[pick * count + j]) continue;
			if (!done[j] || channels[j] === COCHANNEL_UNKNOWN) continue;
			neighbours.push(j);
		}
		let chosen = options[0]!;
		let bestRank: number[] | null = null;
		for (const candidate of options) {
			const damage = damageOf(pick, candidate, channels, neighbours, overlap, weights, count);
			const used = usage.get(candidate) ?? 0;
			const rank = rankCandidate(damage, used > 0);
			if (bestRank === null || isBetterRank(rank, bestRank)) {
				chosen = candidate;
				bestRank = rank;
			}
		}
		channels[pick] = chosen;
		usage.set(chosen, (usage.get(chosen) ?? 0) + 1);
	}

	return channels;
}

/**
 * 用整个频段把受信道表所限而重叠的源移开：按与 `colourConflicts` 相同的排序，为每个源找重叠更小的候选。
 * 不会增加任何一对的重叠，`pinned[i]` 为 true 的源不动；`adjacency[i]` 是冲突邻居，`allowed[i]` 按偏好排序。
 */
export function widenAssignment(
	channels: readonly number[],
	adjacency: ReadonlyArray<readonly number[]>,
	allowed: ReadonlyArray<readonly number[]>,
	overlap: OverlapLookup = SAME_CHANNEL_OVERLAP,
	pinned: ReadonlyArray<boolean> = [],
	weights: Float32Array | null = null
): number[] {
	const out = [...channels];
	const count = out.length;
	const usage = new Map<number, number>();
	for (const channel of out) usage.set(channel, (usage.get(channel) ?? 0) + 1);
	const rankAt = (i: number, candidate: number): [number, number] => {
		const damage = damageOf(i, candidate, out, adjacency[i] ?? [], overlap, weights, count);
		const use = usage.get(candidate) ?? 0;
		return rankCandidate(damage, use > 0);
	};
	for (let i = 0; i < out.length; i++) {
		if (pinned[i]) continue;
		const options = allowed[i];
		if (!options || options.length === 0) continue;
		const current = out[i]!;
		let best = current;
		let bestRank = rankAt(i, current);
		// 只有严格更优的候选才会改动，求解器给出的可接受位置保持原样。
		if (bestRank[0] === 0) continue;
		for (const candidate of options) {
			if (candidate === current) continue;
			const rank = rankAt(i, candidate);
			if (isBetterRank(rank, bestRank)) {
				bestRank = rank;
				best = candidate;
			}
		}
		out[i] = best;
	}
	return out;
}
