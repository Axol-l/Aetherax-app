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
 * The co-channel interference term, as it is evaluated inside the optimiser's
 * sample loop. See `MODEL_NOTES.md` §6.
 *
 * The unit under test is the decision only: the sample loop itself is in the
 * worker, which is not importable here, so this pins the inequality and the
 * channel bookkeeping that loop relies on.
 */

describe('reachAtMargin', () => {
	it('agrees with coverageReach at 0 dB of margin', () => {
		// 5 GHz, 20 dBm: the association radius is ~29.9 m, so the coverage reach is
		// ~12.6 m — the same figure the ramp floor produces in rf/propagation.ts.
		expect(reachAtMargin(988, 0, 0)).toBeCloseTo(coverageReach(988), 9);
		expect(reachAtMargin(988, 0, 0)).toBeCloseTo(988 * Math.pow(10, -15 / 40), 6);
	});

	it('reaches further for a margin below the coverage threshold', () => {
		const atThreshold = reachAtMargin(988, 0, 0);
		const forInterference = reachAtMargin(988, 0, -COCHANNEL_REUSE_DB);
		// 10 dB further out at n = 4 is a factor of 10^(10/40) = 1.78: a source that
		// cannot cover the sample at all can still spoil it, which is exactly why the
		// coverage pass's reach test cannot decide what the interference pass marches.
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
		// Best at +5 dB, secondary 6 dB down: inside the 10 dB reuse distance.
		expect(violatesAt([5, -1], channels, 2)).toBe(true);
		// Secondary 12 dB down: outside it, and a secondary *above* the best server
		// is simply the best server.
		expect(violatesAt([5, -7], channels, 2)).toBe(false);
		expect(violatesAt([-1, 5], channels, 2)).toBe(true);
	});

	it('ignores a secondary on another channel', () => {
		expect(violatesAt([5, 4], [36, 40], 2)).toBe(false);
	});

	it('ignores a same-numbered channel in another band', () => {
		// 6 GHz uses 1/5/9/… and 2.4 GHz uses 1-13, so on channel numbers alone
		// these two look co-channel. Different bands do not interfere.
		expect(violatesAt([5, 4], [1, 1], 2, 0, ['6ghz', '6ghz'])).toBe(true);
		expect(violatesAt([5, 4], [1, 1], 2, 0, ['6ghz', '2.4ghz'])).toBe(false);
		// A same-band secondary still counts while a cross-band one is present.
		expect(violatesAt([5, 4, 4], [1, 1, 1], 3, 0, ['6ghz', '2.4ghz', '6ghz'])).toBe(true);
	});

	it('treats exactly the reuse distance as not a violation', () => {
		expect(violatesAt([10, 0], [36, 36], 2)).toBe(false);
		expect(violatesAt([10, 0.01], [36, 36], 2)).toBe(true);
	});

	it('counts a secondary below the coverage threshold, which is the point', () => {
		// Best server barely over the threshold: a second server 6 dB down is below
		// it too, and still spoils the sample. A term that only looked at covered
		// samples would miss exactly this case.
		expect(violatesAt([1, -5], [36, 36], 2)).toBe(true);
	});

	it('reads only the first count entries of a reused buffer', () => {
		// The evaluators reuse one margins array across samples; the tail holds the
		// previous sample's numbers and must not be read.
		expect(violatesAt([5, -1, 5, 5], [36, 36, 36, 36], 2)).toBe(true);
		expect(violatesAt([5, -1, 5, 5], [36, 40, 36, 36], 2)).toBe(false);
	});

	it('addresses a sample through an offset instead of a slice', () => {
		// The search loop keeps every sample's margins in one buffer, so a sample is
		// addressed by `offset` rather than by allocating a view per sample. Entry 0
		// is a decoy: reading it would flip both answers.
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
		// Every pair is co-channel in that case, so any secondary within the reuse
		// distance counts.
		expect(violatesAt([5, -1], resolved.channels, 2)).toBe(true);
	});

	it('treats an empty plan as known and empty', () => {
		expect(resolveChannels([])).toEqual({ channels: [], known: true });
	});
});

/**
 * The assignment half of the alternating loop: which pairs must not share a
 * channel, and what to give them. See MODEL_NOTES.md §6.
 */
describe('conflict matrix and colouring', () => {
	const N = 3;
	/** Margins of three sources at one sample: 5, 2 and -20 dB. */
	function sample(): Float64Array {
		return new Float64Array([5, 2, -20]);
	}

	it('marks a pair only when both are within the reuse distance', () => {
		const conflicts = conflictMatrix(N);
		markSampleConflicts(conflicts, sample(), N);
		// 5 and 2 are 3 dB apart: conflict. -20 is 25 dB down: no edge to either.
		expect(conflicts[0 * N + 1]).toBe(1);
		expect(conflicts[1 * N + 0]).toBe(1);
		expect(conflicts[0 * N + 2]).toBe(0);
		expect(conflicts[1 * N + 2]).toBe(0);
	});

	it('marks the sample at an offset, ignoring an unrelated sample before it', () => {
		// Two samples in one buffer, as the evaluators hold them. The first is a
		// single-server sample (no edges), the second has a co-channel pair.
		const conflicts = conflictMatrix(N);
		const all = Float64Array.from([5, -30, -30, /* sample 1 */ 1, 0, -25]);
		markSampleConflicts(conflicts, all, N, 0);
		expect(conflicts[0 * N + 1]).toBe(0);
		markSampleConflicts(conflicts, all, N, N);
		expect(conflicts[0 * N + 1]).toBe(1);
		// The third source is 26 dB down at the offset sample: still no edge.
		expect(conflicts[0 * N + 2]).toBe(0);
	});

	it('never marks an edge across bands, however close the levels are', () => {
		// The pair is 1 dB apart, so it would be an edge within one band. Across
		// bands there is nothing to avoid, and a 6 GHz AP must not be pushed off
		// channel 1 by a 2.4 GHz AP holding the same number.
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
		// The third source conflicts with nothing, so it takes the lowest channel.
		expect(channels[2]).toBe(1);
	});

	it('reuses a channel only when the conflict graph forces it, lowest free first', () => {
		// Three sources all within the reuse distance of the strongest one, so the
		// graph is a star: 0 conflicts with both, 1 and 2 conflict with neither of
		// each other. Two channels are therefore not scarce here — 0 takes 1, and
		// both others take the lowest channel 0 does not hold.
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
		// Source 0 leads at both samples, source 1 is within the reuse distance at
		// both, source 2 only at the second: the 0–1 edge is twice as expensive.
		markSampleConflicts(conflicts, new Float64Array([5, 2, -30]), N, 0, null, weights, 1);
		markSampleConflicts(conflicts, new Float64Array([5, 2, 0]), N, 0, null, weights, 1);
		expect(weights[0 * N + 1]).toBe(2);
		expect(weights[0 * N + 2]).toBe(1);
		// Symmetric, since a conflict is not directed.
		expect(weights[1 * N + 0]).toBe(2);
		// An unmarked pair carries no weight, whatever the samples said.
		expect(weights[1 * N + 2]).toBe(0);
	});

	it('leaves the cheaper conflict standing when only one channel is left', () => {
		/*
		 * Three mutually conflicting sources and two channels, so one pair must share.
		 * Two of the three edges are expensive (three samples) and one is cheap (one):
		 * the colourer's job is to make the *cheap* pair share.
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
		// 1 and 2 share, and both heavy edges are broken.
		expect(weighted[1]).toBe(weighted[2]);
		expect(weighted[0]).not.toBe(weighted[1]);

		// Unweighted, the same graph shares a *heavy* edge instead — 0 and 2 — because
		// the colourer cannot tell the pairs apart. That difference is the point.
		const plain = colourConflicts(conflicts, 3, allowed);
		expect(plain[0]).toBe(plain[2]);
		expect(plain[1]).not.toBe(plain[0]);
	});

	it('honours a pinned channel as a constraint, and leaves an unsatisfiable pin alone', () => {
		const margins = sample();
		const conflicts = conflictMatrix(N);
		markSampleConflicts(conflicts, margins, N);
		// Source 1 is pinned to 1, so source 0 cannot have it even though 1 is first.
		const channels = colourConflicts(conflicts, N, [[1, 6, 11], [1], [1, 6, 11]]);
		expect(channels[1]).toBe(1);
		expect(channels[0]).not.toBe(1);
		// Two conflicting sources both pinned to 1: the colouring reports the plan
		// as asked for rather than silently moving one.
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
		// Best server 5 dB above the threshold, secondary 4 dB above it: inside the
		// 10 dB reuse window, so whatever they share counts.
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
			// Two secondaries at 0.2 and 0.9: the strongest competitor decides, so a
			// pair of weak ones cannot outrank it.
			const byChannel = (_i: number, _ci: number, _j: number, cj: number): number =>
				cj === 40 ? 0.9 : 0.2;
			expect(interferenceAt([5, 4, 4], [36, 40, 44], 3, 0, null, byChannel)).toBe(0.9);
		});

		it('ignores a secondary outside the reuse window, and a band mismatch', () => {
			// 11 dB below the best is past `COCHANNEL_REUSE_DB`, so it does not count.
			expect(interferenceAt([5, -6], [1, 1], 2)).toBe(0);
			// Same number, different band: not the same spectrum.
			expect(interferenceAt([5, 4], [1, 1], 2, 0, ['2.4ghz', '6ghz'])).toBe(0);
		});
	});

	describe('choosing centres across the whole band', () => {
		// The band's permitted channels in preference order: the conventional
		// palette first, then the rest. See `planningCandidates`.
		const five80 = planningCandidates('5ghz', 'fcc', 80).map((c) => c.number);
		const five20 = planningCandidates('5ghz', 'fcc', 20).map((c) => c.number);
		const two20 = planningCandidates('2.4ghz', 'fcc', 20).map((c) => c.number);

		it('finds a clear narrower centre where the palette ran out', () => {
			// Four mutually conflicting APs: three 80 MHz (which take the whole
			// non-DFS 5 GHz palette, 36/149/165) and one 20 MHz. The palette cannot
			// serve the fourth — every entry is held by an AP it conflicts with — but
			// channel 48 at 20 MHz sits clear of both 80 MHz spans, so a widened
			// candidate set gives it zero overlap instead of a full reuse.
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
			expect(channels.slice(0, 3)).toEqual([36, 149, 165]);
			expect(channels[3]).toBe(48);
			// And it really is clear: the whole point of taking it.
			for (let i = 0; i < 3; i++) expect(overlap(3, channels[3]!, i, channels[i]!)).toBe(0);
		});

		it('reuses a centre rather than inventing a partial overlap', () => {
			// Four 2.4 GHz APs, all conflicting. Three take 1/6/11; the fourth could
			// move to channel 2 (75% overlap with 1) or 3, but reusing 1 costs the same
			// interference and occupies less spectrum, so reuse wins.
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
			// No edges at all: there is no interference to trade away, so the colourer
			// takes the first candidate for everyone. Spreading the palette for airtime
			// is `balanceAssignment`'s job, and it works over the palette alone — using
			// the widened tail there would put neighbouring APs on overlapping channels
			// for no gain.
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
			// The palette is in use and no channel is more crowded than it has to be;
			// which source lands where is the greedy's business.
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
		// The palette-only colouring of four mutually conflicting APs: the 20 MHz one
		// has no palette entry left, so it shares 36 completely.
		const adjacency = [
			[1, 2, 3],
			[0, 2, 3],
			[0, 1, 3],
			[0, 1, 2]
		];

		it('moves a forced overlap onto a clear centre', () => {
			// Two sources share 36 (the 20 MHz one had no palette entry left). Either of
			// them can move to 48 to fix it — 48 at 80 MHz starts at 5200 and 36 at
			// 20 MHz ends at 5190, so the two are disjoint — and which one moves is the
			// walk order, not a modelling choice. What matters is the outcome.
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
			// And it is not the old assignment: something had to give.
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
			// What a greedy colourer does with no edges at all: everything on channel
			// 1. There is no measured interference to trade away, but there is airtime
			// to share, so the palette should be in use.
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
			// A triangle plus a pendant: 0-1-2 is a triangle, 3 hangs off 2. The input
			// is proper on three channels; whatever balancing does, it stays proper.
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
			// Three 1s and one 6 become at most two of anything: the worst channel is
			// no more crowded than it has to be.
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
			// The other two still spread: 6 and 11 both end up in use.
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
