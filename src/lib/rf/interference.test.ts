import { describe, expect, it } from 'vitest';
import { planningCandidates } from '@aetherax/channels';
import { coverageReach, reachAtMargin } from './propagation.js';
import { makeOverlapLookup } from './channel-overlap.js';
import {
	COCHANNEL_REUSE_DB,
	COCHANNEL_UNKNOWN,
	balanceAssignment,
	colourConflicts,
	conflictMatrix,
	conflictWeights,
	interferenceAt,
	markSampleConflicts,
	resolveChannels,
	violatesAt,
	widenAssignment
} from './interference.js';

/**
 * 优化器采样循环中评估的同频干扰项，见 `MODEL_NOTES.md` §6。
 * 被测对象只是判定本身：采样循环在 worker 内无法在此导入，因此这里只校验它依赖的不等式与信道记账。
 */

describe('reachAtMargin', () => {
	it('agrees with coverageReach at 0 dB of margin', () => {
		// 5 GHz、20 dBm 下余量为 0 时的到达距离与 coverageReach 相同，
		// 也与 rf/propagation.ts 中斜坡下限给出的值一致。
		expect(reachAtMargin(988, 0, 0)).toBeCloseTo(coverageReach(988), 9);
		expect(reachAtMargin(988, 0, 0)).toBeCloseTo(988 * Math.pow(10, -15 / 40), 6);
	});

	it('reaches further for a margin below the coverage threshold', () => {
		const atThreshold = reachAtMargin(988, 0, 0);
		const forInterference = reachAtMargin(988, 0, -COCHANNEL_REUSE_DB);
		// 余量低于覆盖阈值时到达距离更远：覆盖不到采样点的源仍可能削弱它，
		// 因此覆盖的可达判定不能决定干扰的行进范围。
		expect(forInterference / atThreshold).toBeCloseTo(1.778, 3);
		expect(forInterference).toBeGreaterThan(atThreshold);
	});

	it('shrinks for a margin above the threshold', () => {
		expect(reachAtMargin(988, 0, 5)).toBeLessThan(reachAtMargin(988, 0, 0));
	});
});

describe('violatesAt', () => {
	it('flags a co-channel secondary within the reuse distance', () => {
		const channels = [36, 36];
		// 次服务器比最佳服务器低，但差距仍在复用距离之内。
		expect(violatesAt([5, -1], channels, 2)).toBe(true);
		// 次服务器低出复用距离则不计入；
		// 高于最佳服务器的次服务器本身就是最佳服务器。
		expect(violatesAt([5, -7], channels, 2)).toBe(false);
		expect(violatesAt([-1, 5], channels, 2)).toBe(true);
	});

	it('ignores a secondary on another channel', () => {
		expect(violatesAt([5, 4], [36, 40], 2)).toBe(false);
	});

	it('ignores a same-numbered channel in another band', () => {
		// 每个频段有自己的信道号，号码可以重复，只看信道号会误判为同频；
		// 不同频段之间并不干扰。
		expect(violatesAt([5, 4], [1, 1], 2, 0, ['6ghz', '6ghz'])).toBe(true);
		expect(violatesAt([5, 4], [1, 1], 2, 0, ['6ghz', '2.4ghz'])).toBe(false);
		// 存在跨频段次服务器时，同频段的次服务器仍然计入。
		expect(violatesAt([5, 4, 4], [1, 1, 1], 3, 0, ['6ghz', '2.4ghz', '6ghz'])).toBe(true);
	});

	it('treats exactly the reuse distance as not a violation', () => {
		expect(violatesAt([10, 0], [36, 36], 2)).toBe(false);
		expect(violatesAt([10, 0.01], [36, 36], 2)).toBe(true);
	});

	it('counts a secondary below the coverage threshold, which is the point', () => {
		// 最佳服务器刚过覆盖阈值，低几 dB 的次服务器同样低于阈值，却仍会削弱本采样点；
		// 只看已覆盖采样点的干扰项会漏掉这种情况。
		expect(violatesAt([1, -5], [36, 36], 2)).toBe(true);
	});

	it('reads only the first count entries of a reused buffer', () => {
		// 评估器跨采样点复用同一个 margins 数组，尾部残留上一采样点的数值，不应读取。
		expect(violatesAt([5, -1, 5, 5], [36, 36, 36, 36], 2)).toBe(true);
		expect(violatesAt([5, -1, 5, 5], [36, 40, 36, 36], 2)).toBe(false);
	});

	it('addresses a sample through an offset instead of a slice', () => {
		// 搜索循环把所有采样点的 margins 放在一个缓冲区里，用 `offset` 定位而不逐点分配视图；
		// 第 0 项是干扰项，读到它会使两个断言都翻转。
		const all = [5, 5, -1, 7, 7, 7, 7, 7];
		expect(violatesAt(all, [36, 36], 2, 1)).toBe(true);
		expect(violatesAt(all, [36, 40], 2, 1)).toBe(false);
		expect(violatesAt(all, [36, 36], 2, 3)).toBe(true);
	});

	it('needs a source to be there at all', () => {
		expect(violatesAt([], [], 0)).toBe(false);
		expect(violatesAt([-Infinity, -Infinity], [36, 36], 2)).toBe(false);
	});
});

describe('resolveChannels', () => {
	it('uses the real assignment when every source has one', () => {
		const resolved = resolveChannels([{ assignedChannel: 36 }, { assignedChannel: 40 }]);
		expect(resolved.known).toBe(true);
		expect(resolved.channels).toEqual([36, 40]);
	});

	it('falls back to the all-co-channel bound when any source is unassigned', () => {
		const resolved = resolveChannels([{ assignedChannel: 36 }, { assignedChannel: null }]);
		expect(resolved.known).toBe(false);
		expect(resolved.channels).toEqual([COCHANNEL_UNKNOWN, COCHANNEL_UNKNOWN]);
		// 此时任意两源都互为同频，复用距离内的次服务器一律计入。
		expect(violatesAt([5, -1], resolved.channels, 2)).toBe(true);
	});

	it('treats an empty plan as known and empty', () => {
		expect(resolveChannels([])).toEqual({ channels: [], known: true });
	});
});

/**
 * 交替循环中信道分配的一半：哪些源对不能共用信道，以及各自分到什么，见 MODEL_NOTES.md §6。
 */
describe('conflict matrix and colouring', () => {
	const N = 3;
	/** 一个采样点上三个信号源的 margin，单位 dB。 */
	function sample(): Float64Array {
		return new Float64Array([5, 2, -20]);
	}

	it('marks a pair only when both are within the reuse distance', () => {
		const conflicts = conflictMatrix(N);
		markSampleConflicts(conflicts, sample(), N);
		// 前两个源相差在复用距离内，构成冲突；第三个远低于它们，与两者都不成边。
		expect(conflicts[0 * N + 1]).toBe(1);
		expect(conflicts[1 * N + 0]).toBe(1);
		expect(conflicts[0 * N + 2]).toBe(0);
		expect(conflicts[1 * N + 2]).toBe(0);
	});

	it('marks the sample at an offset, ignoring an unrelated sample before it', () => {
		// 一个缓冲区里存放两个采样点：第一个只有单个服务器，第二个含同频对。
		const conflicts = conflictMatrix(N);
		const all = Float64Array.from([5, -30, -30, /* 采样点 1 */ 1, 0, -25]);
		markSampleConflicts(conflicts, all, N, 0);
		expect(conflicts[0 * N + 1]).toBe(0);
		markSampleConflicts(conflicts, all, N, N);
		expect(conflicts[0 * N + 1]).toBe(1);
		// 在偏移处的采样点上第三个源远低于其余源，仍不构成边。
		expect(conflicts[0 * N + 2]).toBe(0);
	});

	it('never marks an edge across bands, however close the levels are', () => {
		// 该源对差距极小，在同一频段内必然成边；跨频段则无需规避，
		// 不能因为信道号相同就把一个 AP 挤下该信道。
		const sameBand = conflictMatrix(2);
		markSampleConflicts(sameBand, new Float64Array([5, 4]), 2, 0, ['2.4ghz', '2.4ghz']);
		expect(sameBand[0 * 2 + 1]).toBe(1);

		const mixed = conflictMatrix(2);
		markSampleConflicts(mixed, new Float64Array([5, 4]), 2, 0, ['2.4ghz', '6ghz']);
		expect(mixed[0 * 2 + 1]).toBe(0);
		expect(mixed[1 * 2 + 0]).toBe(0);
	});

	it('colours conflicting sources apart when channels allow it', () => {
		const margins = sample();
		const conflicts = conflictMatrix(N);
		markSampleConflicts(conflicts, margins, N);
		const channels = colourConflicts(conflicts, N, [
			[1, 6, 11],
			[1, 6, 11],
			[1, 6, 11]
		]);
		expect(channels[0]).not.toBe(channels[1]);
		// 第三个源没有冲突，因而取列表中的第一个信道。
		expect(channels[2]).toBe(1);
	});

	it('reuses a channel only when the conflict graph forces it, lowest free first', () => {
		// 三个源都落在最强源的复用距离内，冲突图呈星形：0 与两者都冲突，另两者互不冲突。
		// 两个信道因此并不紧缺，0 取首个可用信道，
		// 其余两个各取 0 未占用的最小信道。
		const conflicts = conflictMatrix(3);
		markSampleConflicts(conflicts, new Float64Array([5, 4, 3]), 3);
		const channels = colourConflicts(conflicts, 3, [
			[1, 6],
			[1, 6],
			[1, 6]
		]);
		expect(channels).toEqual([1, 6, 6]);
	});

	it('weighs a conflict by how many samples it spoils', () => {
		const conflicts = conflictMatrix(N);
		const weights = conflictWeights(N);
		// 源 0 在两个采样点都最强，源 1 两点都在复用距离内，
		// 源 2 只在第二个采样点进入，故 0–1 这条边的代价是 0–2 的两倍。
		markSampleConflicts(conflicts, new Float64Array([5, 2, -30]), N, 0, null, weights, 1);
		markSampleConflicts(conflicts, new Float64Array([5, 2, 0]), N, 0, null, weights, 1);
		expect(weights[0 * N + 1]).toBe(2);
		expect(weights[0 * N + 2]).toBe(1);
		// 冲突没有方向，因此矩阵对称。
		expect(weights[1 * N + 0]).toBe(2);
		// 未被标记的源对不累计权重。
		expect(weights[1 * N + 2]).toBe(0);
	});

	it('leaves the cheaper conflict standing when only one channel is left', () => {
		/*
		 * 三个互相冲突的源只有两个信道，因此必然有一对共用。
		 * 三条边中两条代价高、一条代价低，
		 * 着色的目标是让代价低的那一对共用。
		 */
		const conflicts = conflictMatrix(3);
		conflicts[0 * 3 + 1] = conflicts[1 * 3 + 0] = 1;
		conflicts[0 * 3 + 2] = conflicts[2 * 3 + 0] = 1;
		conflicts[1 * 3 + 2] = conflicts[2 * 3 + 1] = 1;
		const weights = conflictWeights(3);
		weights[0 * 3 + 1] = weights[1 * 3 + 0] = 3;
		weights[0 * 3 + 2] = weights[2 * 3 + 0] = 3;
		weights[1 * 3 + 2] = weights[2 * 3 + 1] = 1;
		const allowed = [
			[1, 6],
			[1, 6],
			[1, 6]
		];
		const weighted = colourConflicts(conflicts, 3, allowed, undefined, weights);
		// 1 与 2 共用，两条高代价边都被拆开。
		expect(weighted[1]).toBe(weighted[2]);
		expect(weighted[0]).not.toBe(weighted[1]);

		// 不带权重时同一张图改为共用一条高代价边，因为着色无法区分配对；
		// 这一差别正是权重的作用。
		const plain = colourConflicts(conflicts, 3, allowed);
		expect(plain[0]).toBe(plain[2]);
		expect(plain[1]).not.toBe(plain[0]);
	});

	it('honours a pinned channel as a constraint, and leaves an unsatisfiable pin alone', () => {
		const margins = sample();
		const conflicts = conflictMatrix(N);
		markSampleConflicts(conflicts, margins, N);
		// 源 1 固定在某信道上，即使该信道排在首位，源 0 也不能取它。
		const channels = colourConflicts(conflicts, N, [[1, 6, 11], [1], [1, 6, 11]]);
		expect(channels[1]).toBe(1);
		expect(channels[0]).not.toBe(1);
		// 两个互相冲突的源被固定到同一信道时，着色按用户要求返回，不会私自挪动其中一个。
		const pinned = colourConflicts(conflictMatrix(N), 2, [[1], [1]]);
		expect(pinned).toEqual([1, 1]);
	});

	it('is deterministic for the same layout', () => {
		const build = () => {
			const conflicts = conflictMatrix(4);
			markSampleConflicts(conflicts, new Float64Array([5, 6, -1, -2]), 4);
			markSampleConflicts(conflicts, new Float64Array([-3, -4, 7, 6]), 4);
			return colourConflicts(conflicts, 4, [
				[1, 6, 11],
				[1, 6, 11],
				[1, 6, 11],
				[1, 6, 11]
			]);
		};
		expect(build()).toEqual(build());
	});

	it('leaves a source with no allowed channel unknown, i.e. co-channel with all', () => {
		const channels = colourConflicts(conflictMatrix(2), 2, [[], [1]]);
		expect(channels[0]).toBe(COCHANNEL_UNKNOWN);
		expect(channels[1]).toBe(1);
	});

	describe('grading the interference at a sample', () => {
		// 最佳与次服务器都高于覆盖阈值且差距在复用窗口内，二者共用的频谱全部计入。
		const margins = [5, 4];

		it('is 1 for two sources on one channel, and 0 when they are apart', () => {
			expect(interferenceAt(margins, [1, 1], 2)).toBe(1);
			expect(interferenceAt(margins, [1, 6], 2)).toBe(0);
		});

		it('is the overlap fraction when the model grades it', () => {
			const half = (): number => 0.5;
			expect(interferenceAt(margins, [36, 40], 2, 0, null, half)).toBe(0.5);
			const threeQuarters = (): number => 0.75;
			expect(interferenceAt(margins, [36, 40], 2, 0, null, threeQuarters)).toBe(0.75);
		});

		it('takes the worst secondary, not the sum', () => {
			// 两个次服务器的重叠比例不同，取较强者；几个弱的相加也不能盖过它。
			const byChannel = (_i: number, _ci: number, _j: number, cj: number): number =>
				cj === 40 ? 0.9 : 0.2;
			expect(interferenceAt([5, 4, 4], [36, 40, 44], 3, 0, null, byChannel)).toBe(0.9);
		});

		it('ignores a secondary outside the reuse window, and a band mismatch', () => {
			// 低出 `COCHANNEL_REUSE_DB` 的次服务器不计入。
			expect(interferenceAt([5, -6], [1, 1], 2)).toBe(0);
			// 信道号相同但频段不同，不算同一段频谱。
			expect(interferenceAt([5, 4], [1, 1], 2, 0, ['2.4ghz', '6ghz'])).toBe(0);
		});
	});

	describe('choosing centres across the whole band', () => {
		// 该频段允许的信道，按偏好顺序排列：常用信道表在前，其余在后，见 `planningCandidates`。
		const five80 = planningCandidates('5ghz', 'fcc', 80).map((c) => c.number);
		const five20 = planningCandidates('5ghz', 'fcc', 20).map((c) => c.number);
		const two20 = planningCandidates('2.4ghz', 'fcc', 20).map((c) => c.number);

		it('finds a clear narrower centre where the palette ran out', () => {
			// 5 GHz 80 MHz 只有 36 和 149 两个非重叠信道；第三个 80 MHz 只能复用。
			// 扩宽候选集后，窄信道仍能找到与各 80 MHz 跨度都不重叠的中心。
			const k4 = conflictMatrix(4);
			for (let i = 0; i < 4; i++)
				for (let j = 0; j < 4; j++) if (i !== j) k4[i * 4 + j] = 1;
			const widths = [80, 80, 80, 20];
			const overlap = makeOverlapLookup(['5ghz', '5ghz', '5ghz', '5ghz'], widths);
			const channels = colourConflicts(
				k4,
				4,
				[five80, five80, five80, five20],
				overlap
			);
			expect(channels.slice(0, 3)).toEqual([36, 149, 36]);
			expect(channels[3]).toBe(48);
			// 结果确实无重叠，这正是取它的意义。
			for (let i = 0; i < 3; i++) expect(overlap(3, channels[3]!, i, channels[i]!)).toBe(0);
		});

		it('reuses a centre rather than inventing a partial overlap', () => {
			// 四个互相冲突的 2.4 GHz AP：前三个取常用信道，第四个本可选部分重叠的新信道，
			// 但复用已有信道干扰相同而占用频谱更少，因此复用胜出。
			const k4 = conflictMatrix(4);
			for (let i = 0; i < 4; i++)
				for (let j = 0; j < 4; j++) if (i !== j) k4[i * 4 + j] = 1;
			const overlap = makeOverlapLookup(
				['2.4ghz', '2.4ghz', '2.4ghz', '2.4ghz'],
				[20, 20, 20, 20]
			);
			const channels = colourConflicts(
				k4,
				4,
				[two20, two20, two20, two20],
				overlap
			);
			expect(channels).toEqual([1, 6, 11, 1]);
		});

		it('leaves a source with nothing to avoid on the first candidate', () => {
			// 完全没有边时没有干扰可权衡，着色对每个源都取第一个候选；
			// 按空口时间铺开信道是 `balanceAssignment` 的职责，且只在常用信道表内进行。
			const none = conflictMatrix(4);
			const overlap = makeOverlapLookup(
				['2.4ghz', '2.4ghz', '2.4ghz', '2.4ghz'],
				[20, 20, 20, 20]
			);
			const coloured = colourConflicts(none, 4, [two20, two20, two20, two20], overlap);
			expect(coloured).toEqual([1, 1, 1, 1]);
			const palette = planningCandidates('2.4ghz', 'fcc', 20)
				.map((c) => c.number)
				.slice(0, 3);
			expect(palette).toEqual([1, 6, 11]);
			const spread = balanceAssignment(
				coloured,
				[[], [], [], []],
				Array.from({ length: 4 }, () => palette),
				Array.from({ length: 4 }, () => false),
				overlap
			);
			// 常用信道表被用满，且没有信道过度拥挤；具体哪个源落在哪个信道由贪心决定。
			expect(new Set(spread)).toEqual(new Set(palette));
			const counts = palette.map((c) => spread.filter((x) => x === c).length);
			expect(Math.max(...counts)).toBeLessThanOrEqual(2);
		});
	});

	describe('widening an assignment the solver already made', () => {
		const five80 = planningCandidates('5ghz', 'fcc', 80).map((c) => c.number);
		const five20 = planningCandidates('5ghz', 'fcc', 20).map((c) => c.number);
		const overlap = makeOverlapLookup(
			['5ghz', '5ghz', '5ghz', '5ghz'],
			[80, 80, 80, 20]
		);
		// 四个互相冲突的 AP 只用常用信道表着色时，20 MHz 的那个没有表项可用，
		// 只能与已有信道完全共用。
		const adjacency = [
			[1, 2, 3],
			[0, 2, 3],
			[0, 1, 3],
			[0, 1, 2]
		];

		it('moves a forced overlap onto a clear centre', () => {
			// 两个源共用一个信道（20 MHz 的那个没有表项可用），其中任一移到更窄的空闲信道即可解决；
			// 移动哪一个取决于遍历顺序而非建模选择，结果才重要。
			const widened = widenAssignment(
				[36, 149, 165, 36],
				adjacency,
				[five80, five80, five80, five20],
				overlap
			);
			expect(widened).toContain(48);
			expect(widened).toHaveLength(4);
			for (let i = 0; i < 4; i++) {
				for (const j of adjacency[i]!) {
					expect(overlap(i, widened[i]!, j, widened[j]!)).toBe(0);
				}
			}
			// 结果已不同于原分配，必然有源被挪动。
			expect(widened).not.toEqual([36, 149, 165, 36]);
		});

		it('leaves an assignment alone when it is already clear', () => {
			const already = [36, 149, 165, 48];
			expect(widenAssignment(already, adjacency, [five80, five80, five80, five20], overlap)).toEqual(
				already
			);
		});

		it('does not touch a pinned source', () => {
			const widened = widenAssignment(
				[36, 149, 165, 36],
				adjacency,
				[five80, five80, five80, five20],
				overlap,
				[false, false, false, true]
			);
			expect(widened[3]).toBe(36);
		});
	});

	describe('balancing the assignment', () => {
		const PALETTE = [1, 6, 11];
		const free = (n: number): number[][] => Array.from({ length: n }, () => []);

		it('spreads a palette over sources the graph does not separate', () => {
			// 没有边时贪心着色会把所有源放在同一信道；此时虽无实测干扰可权衡，
			// 但空口时间仍需分摊，常用信道表应当被用起来。
			const balanced = balanceAssignment(
				[1, 1, 1, 1, 1, 1],
				free(6),
				Array.from({ length: 6 }, () => PALETTE),
				Array.from({ length: 6 }, () => false)
			);
			const counts = PALETTE.map((c) => balanced.filter((x) => x === c).length);
			expect(counts).toEqual([2, 2, 2]);
			expect(new Set(balanced).size).toBe(3);
		});

		it('never creates a conflict the colouring did not have', () => {
			// 三角形加一个悬挂点：输入在三信道上已是正常着色，均衡之后仍须保持不冲突。
			const adjacency = [
				[1, 2],
				[0, 2],
				[0, 1, 3],
				[2]
			];
			const balanced = balanceAssignment(
				[1, 6, 11, 1],
				adjacency,
				Array.from({ length: 4 }, () => PALETTE),
				Array.from({ length: 4 }, () => false)
			);
			for (let i = 0; i < adjacency.length; i++) {
				for (const j of adjacency[i]!) expect(balanced[i]).not.toBe(balanced[j]);
			}
		});

		it('moves a source to a less-used channel, and never to a more-used one', () => {
			const adjacency = [[], [], [], []];
			const balanced = balanceAssignment(
				[1, 1, 1, 6],
				adjacency,
				Array.from({ length: 4 }, () => PALETTE),
				Array.from({ length: 4 }, () => false)
			);
			const counts = PALETTE.map((c) => balanced.filter((x) => x === c).length);
			// 原本三个源同信道、一个源另一信道，均衡后任一信道最多被两个源占用。
			expect(Math.max(...counts)).toBeLessThanOrEqual(2);
		});

		it('leaves a pinned source where the user put it, and counts it as used', () => {
			const balanced = balanceAssignment(
				[1, 1, 1],
				[[], [], []],
				Array.from({ length: 3 }, () => PALETTE),
				[true, false, false]
			);
			expect(balanced[0]).toBe(1);
			// 其余两个源仍会分散，两个空闲信道都被用上。
			expect(new Set(balanced.slice(1)).size).toBe(2);
		});

		it('is deterministic and does not mutate its input', () => {
			const input = [1, 1, 6, 11];
			const adjacency = [[1], [0], [], []];
			const args = [adjacency, Array.from({ length: 4 }, () => PALETTE), Array.from({ length: 4 }, () => false)] as const;
			const once = balanceAssignment(input, ...args);
			expect(balanceAssignment(input, ...args)).toEqual(once);
			expect(input).toEqual([1, 1, 6, 11]);
		});
	});
});
