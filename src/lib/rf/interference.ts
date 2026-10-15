/**
 * Co-channel interference in the placement objective.
 *
 * Placement and channel assignment are physically coupled: moving an AP changes
 * the conflict graph and therefore the best assignment. The coverage objective on
 * its own is blind to that — each sample takes the `max` over APs, so a second,
 * co-channel AP covering an already-covered area costs exactly nothing, and the
 * search is actively rewarded for clustering. This module is the term that makes
 * a co-channel second server cost something. See `MODEL_NOTES.md` §6.
 *
 * The measurement is taken inside the optimiser's existing sample loop, from the
 * per-source margins that loop already produces, so it adds no propagation runs
 * and makes no AP-to-AP geometry approximation (which is what a circle-overlap
 * graph would do):
 *
 *     s*_i   = max_j s_ij                     (margin in dB: the best server)
 *     viol_i = 1[ ∃ j ≠ argmax: channel_j == channel_best && s_ij > s*_i − DELTA ]
 *     term   = (Σ_i viol_i) / |I|
 *
 * `DELTA` is a **reuse threshold, not a sensitivity**: it says how far below the
 * best server a co-channel second server still degrades it. 802.11g design
 * practice uses a 10 dB SIR target; Juniper Mist's published requirement is 25 dB
 * SNR. It is a modelling assumption, so it is named here rather than inlined, and
 * the number is reported alongside the coverage figure it trades against.
 *
 * The penalty form is a synthesis, not a formula lifted from one source: the
 * papers model interference as a constraint (Oustry eq. 18/19) or as a sum over
 * AP pairs (IJEAT eq. 4), and rewriting a constraint as an additive penalty is
 * what IJEAT itself does. `DEFAULT_INTERFERENCE_WEIGHT` is IJEAT's aggregate
 * coefficient.
 *
 * It is deliberately **not** summed over AP pairs: counting the samples whose
 * best server is spoiled measures the thing that matters (lost airtime where a
 * client actually is), it needs no pair geometry, and the number of APs falls out
 * of it instead of being double-counted.
 */

/**
 * dB below the best server within which a co-channel secondary server counts as
 * interference. See the module comment for why 10.
 */
export const COCHANNEL_REUSE_DB = 10;

/**
 * Default weight of the interference share in the objective:
 * `score = coverageUtility − interferenceWeight · interferenceShare`, both terms
 * on a 0-1 scale. IJEAT's aggregate penalty coefficient — a starting point, not a
 * result: the trade is a Pareto curve, so this is a project setting.
 */
export const DEFAULT_INTERFERENCE_WEIGHT = 0.2;

/**
 * Channel value standing for "no assignment yet".
 *
 * Every source carrying it is co-channel with every other source, which is the
 * worst case a plan can be in: the optimiser then spreads APs as if they all
 * shared one channel. The main thread re-solves after a placement change, so a
 * real assignment is usually available by the next run; the alternating
 * re-colouring *inside* the optimiser loop is the next step in `MODEL_NOTES` §6.
 */
export const COCHANNEL_UNKNOWN = -1;

/** What a run's channel vector was derived from. */
export interface ResolvedChannels {
	/** One entry per source, in the source order the evaluator uses. */
	channels: number[];
	/** True when these are real assignments, false for the all-co-channel bound. */
	known: boolean;
}

/**
 * Channels to measure against: the real assignment when **every** source has one,
 * the all-co-channel worst case otherwise.
 *
 * All-or-nothing on purpose. A mixed vector would need a per-*pair* notion of
 * "unknown", and treating an unassigned AP as co-channel with everything while
 * the assigned ones keep their channels would quietly make the answer depend on
 * which APs happened to have been coloured.
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
 * Frequency overlap between two sources' assignments, as a fraction of the
 * narrower channel's bandwidth: 0 when they share no spectrum, 1 when they are the
 * same spectrum.
 *
 * `i` and `j` are source indices, so an implementation can close over each
 * source's band and width; nothing in this module knows about either. See
 * `rf/channel-overlap.ts` for the lookup the app builds from the channel tables,
 * and `SAME_CHANNEL_OVERLAP` for the model this generalises.
 */
export type OverlapLookup = (
	i: number,
	channelI: number,
	j: number,
	channelJ: number
) => number;

/**
 * The model that predates B3's second stage: two sources overlap completely when
 * their channel numbers are equal, and not at all otherwise.
 *
 * Kept as the default so every existing caller keeps exactly the behaviour it had.
 * With a non-overlapping palette — what the planner hands out — the two models
 * agree on every pair, so the default is not a fallback but the same answer; the
 * interval model differs precisely where a plan is pinned or hand-edited into
 * partially overlapping channels, which is where the old one reported 0%.
 */
export const SAME_CHANNEL_OVERLAP: OverlapLookup = (_i, channelI, _j, channelJ) =>
	channelI === channelJ ? 1 : 0;

/**
 * Does this sample's best server have a co-channel secondary within
 * `COCHANNEL_REUSE_DB` of it?
 *
 * `margins` and `channels` are indexed over the same sources, in any order, and
 * only the `count` entries starting at `offset` are read — the evaluators keep
 * every sample's margins in one buffer, and `offset` is how a sample's slice is
 * addressed without allocating a view per sample in the search loop.
 *
 * `bands` carries each source's band. Two sources can only be co-channel if they
 * are in the **same band**: channel numbers are only unique within a band, and
 * 6 GHz uses 1/5/9/… while 2.4 GHz uses 1-13, so on channel *numbers* alone a
 * 6 GHz AP on 1 would be read as co-channel with a 2.4 GHz AP on 1. Nothing
 * about that pair interferes — the solver colours each band independently for
 * the same reason. Omit `bands` only when every source is genuinely one band.
 *
 * `margin` is the source's margin in dB above the coverage threshold (the same
 * quantity `coverageUtility` consumes), so the comparison is a difference of
 * levels: every term in the path is a dB term.
 *
 * This is `interferenceAt` reduced to a yes/no, and exists for the conflict graph,
 * where the question really is binary ("must these two be given different
 * channels"). The *reported* figure is graded — see `interferenceAt`.
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
 * How much of this sample's best server is spoiled by a co-channel secondary, 0 to
 * 1.
 *
 * The same test as `violatesAt`, with the overlap graded instead of rounded to a
 * yes: the figure is the frequency overlap between the best server and the *worst*
 * secondary inside the reuse window. `overlap` is where the interval model enters
 * (B3's second stage): with the default `SAME_CHANNEL_OVERLAP` this is exactly the
 * old boolean — two APs on one channel overlap completely — and with a real lookup
 * two 80 MHz APs 20 MHz apart come out at 0.75 rather than "not interfering",
 * which is what a pinned or hand-edited plan needs to be told.
 *
 * The worst secondary rather than the sum: interference at a sample is decided by
 * the dominant competing signal, and summing would let three weak ones outrank one
 * strong one.
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
	// No source reaches the sample at all: nothing to interfere with.
	if (bestIndex < 0 || best === -Infinity) return 0;

	const limit = best - COCHANNEL_REUSE_DB;
	const channel = channels[bestIndex]!;
	const band = bands ? bands[bestIndex] : null;
	let worst = 0;
	for (let i = 0; i < count; i++) {
		if (i === bestIndex) continue;
		if (bands && bands[i] !== band) continue;
		// Strictly greater: a secondary exactly at the reuse distance is the
		// boundary case the threshold is defined *at*, so it does not count.
		if (!(margins[offset + i]! > limit)) continue;
		const shared = overlap(bestIndex, channel, i, channels[i]!);
		if (shared > worst) worst = shared;
	}
	return worst;
}

// ─── Assignment: which pairs must not share a channel, and what to give them ──

/**
 * An `count x count` conflict matrix, 1 at `[i * count + j]` when sources `i` and
 * `j` must not share a channel.
 *
 * Built from the same margins the interference term uses, not from circle
 * overlap: two sources conflict when one is within `COCHANNEL_REUSE_DB` of the
 * other *at a sample*, which is the "actual interference events" criterion
 * `MODEL_NOTES.md` §6 asks for. A dense but single-server-dominated layout
 * therefore produces no edges, and the AP-count effect falls out instead of being
 * assumed.
 */
export function conflictMatrix(count: number): Uint8Array {
	return new Uint8Array(count * count);
}

/**
 * How much each conflicting pair actually costs, alongside `conflictMatrix`.
 *
 * The matrix says *whether* a pair must not share a channel; this says how much of the
 * plan that pair spoils — the density-weighted number of samples at which one is
 * within the reuse threshold of the other. It is the difference between a pair that
 * meets at one corner of a corridor and a pair whose whole served area overlaps, and a
 * colourer that has to leave one of them sharing a channel should leave the cheap one.
 *
 * Unweighted, every marked pair counts 1, which is exactly the behaviour the colourers
 * had before this existed.
 */
export function conflictWeights(count: number): Float32Array {
	return new Float32Array(count * count);
}

/**
 * Mark every pair that is within the reuse distance of each other at this sample.
 *
 * The sample's strongest source is the reference; a weaker one within
 * `COCHANNEL_REUSE_DB` of it must not share its channel *here*, so the pair is
 * marked. Called once per sample with the same margins `violatesAt` reads.
 *
 * `weights`, when given, accumulates the sample's own `weight` (its density) on each
 * marked pair. `bands` restricts edges to same-band pairs, for the reason spelled out
 * on `violatesAt`: without it a 6 GHz AP would be pushed off a channel merely because
 * a 2.4 GHz AP holds the same *number*.
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
 * Spread a proper colouring over the palette wherever the graph leaves the choice
 * free.
 *
 * A proper colouring is not the only thing an assignment has to be. When the
 * conflict graph is silent about a source — no sample puts it within
 * `COCHANNEL_REUSE_DB` of another AP's signal — every allowed channel is equally
 * correct for *interference*, and they are not equally correct for *airtime*:
 * co-channel APs contend for the medium even when they do not degrade each other's
 * SNR, so a greedy colourer that always takes the lowest free channel puts a whole
 * band on channel 1 and trades nothing away. This walks the sources once and moves
 * each to a strictly less-used allowed channel when one is free, which never
 * creates a conflict the colouring did not already have (a candidate is taken only
 * if no neighbour holds it).
 *
 * Balance is the cheapest honest tie-break, not a throughput model: it treats the
 * channels as equally valuable, whereas real contention depends on how much traffic
 * each AP carries. Minimising measured coupling instead is the open question in
 * `ROADMAP.md` B5.
 *
 * `channels[i]` is the current assignment, `adjacency[i]` the indices that must not
 * share it, `allowed[i]` the channels source `i` may take (in preference order),
 * and `pinned[i]` true when the user chose it and it must not move. Returns a new
 * array; the input is left alone.
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
		// Strictly less used, so ties keep the earlier candidate and the result stays
		// reproducible.
		let bestUse = usage.get(current) ?? 0;
		for (const candidate of options) {
			if (candidate === current) continue;
			// Never move onto something a conflicting neighbour shares: balancing is
			// not allowed to create interference, only to spread the palette.
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
 * Ranking for candidate channels: lower is better.
 *
 * Tiers, in order:
 *
 * 0. **no overlap** with any conflicting neighbour — always right, and what makes
 *    the widened tail of a candidate list useful;
 * 1. an overlap that **reuses a centre someone already holds**;
 * 2. a **new** centre that partially overlaps a conflicting neighbour.
 *
 * Tier 1 before tier 2 is a modelling call, not an optimisation: partial overlap is
 * not a gentler co-channel, it is a second channel that also collides, so inventing
 * one occupies more spectrum for the same interference. Reuse first, widen only into
 * genuinely clear spectrum — which is why four 2.4 GHz APs on three channels come out
 * 1, 6, 11, 1 and not 1, 6, 11, 2.
 *
 * Within a tier, less overlap wins and ties keep the caller's order — and the caller
 * puts the conventional palette first, so a source with nothing to avoid takes the
 * first palette channel rather than wandering up the band. Spreading the palette for
 * *airtime* is a separate pass over the palette alone (`balanceAssignment`); this one
 * is about interference, and reaching into the widened tail whenever a free channel
 * exists would put neighbouring APs on overlapping channels for no gain.
 */
function rankCandidate(shared: number, used: boolean): [number, number] {
	return [shared === 0 ? 0 : used ? 1 : 2, shared];
}

/** Strictly better, so ties keep whichever candidate came first. */
function isBetterRank(a: readonly number[], b: readonly number[]): boolean {
	for (let i = 0; i < a.length; i++) {
		if (a[i]! !== b[i]!) return a[i]! < b[i]!;
	}
	return false;
}

/**
 * How much damage one candidate channel would do, over the neighbours it conflicts
 * with.
 *
 * Without weights this is the worst single overlap the candidate creates, which is
 * what both colourers have always ranked by. With them it is the *sum* of the overlaps
 * each weighted by what that pair costs, so a candidate that shares spectrum with
 * three cheap neighbours can rank worse than one that shares with a single expensive
 * one — which is the decision the weights exist to inform.
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
 * Give every source a channel, respecting `allowed` and the conflict matrix.
 *
 * A dedicated, deterministic DSatur-lite: sources are coloured in order of how
 * constrained they are (most differently-coloured neighbours first, then lowest
 * index), each taking the best allowed channel no conflicting neighbour shares
 * with it. Determinism matters more than optimality here — the optimiser runs this
 * inside its own search, where a colouring that changed between two evaluations of
 * the *same* layout would turn the objective into noise.
 *
 * `allowed[i]` is the list of channels source `i` may take, **in preference order**
 * (see `planningCandidates`: the conventional non-overlapping palette first, then
 * the rest of the band). `overlap` says how much two assignments share — with the
 * default, only the same channel number does, which is the pre-B3 model.
 *
 * Candidates are ranked by, in order:
 *
 * 1. **the worst overlap** with a conflicting neighbour — zero wins, and that is
 *    what makes the widened tail of `allowed` useful rather than dangerous: a
 *    source the palette cannot serve takes a centre that is genuinely clear of the
 *    APs it conflicts with, not one next to them;
 * 2. **how many sources already hold it** — with no interference to trade away the
 *    channels are still not equivalent for airtime, so the least-used one wins
 *    (see `balanceAssignment`, which does the same for an existing assignment);
 * 3. **its position in `allowed`** — so ties keep the conventional channel, which
 *    is why four 2.4 GHz APs come out 1, 6, 11, 1 rather than 1, 6, 11, 2.
 *
 * A pinned source gets a single-element list, so pins are constraints like any
 * other rather than a special case — and an unsatisfiable one (two pinned
 * neighbours on one channel) is left alone, because the point of the colouring is
 * to measure interference, not to forbid a plan the user asked for.
 *
 * A source with an empty list is left as `COCHANNEL_UNKNOWN`, i.e. co-channel
 * with everything, which is the conservative reading.
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

	// Pinned sources first, and treated as already coloured. A pin is a constraint
	// on its neighbours; deciding it in index order instead would let a neighbour
	// take the pinned channel before the pin was ever looked at, and the colourer
	// would then report a conflict the user did not create.
	for (let i = 0; i < count; i++) {
		const options = allowed[i];
		if (options && options.length === 1) {
			channels[i] = options[0]!;
			done[i] = true;
			usage.set(channels[i]!, (usage.get(channels[i]!) ?? 0) + 1);
		}
	}

	for (let step = 0; step < count; step++) {
		// Pick the next source: the one with the most distinctly coloured neighbours,
		// and among those the one whose edges are heaviest — ties broken by index, so
		// the result is reproducible. Without weights "heaviest" is simply "most
		// neighbours", which is the order this colourer has always used.
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
		// The neighbours this candidate can actually damage: the ones already coloured,
		// since an uncoloured source has no channel to overlap with.
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
 * Move sources off overlaps the palette forced on them, using the whole band.
 *
 * The main-thread solver colours a graph with channel *numbers* and so must be
 * given a mutually non-overlapping palette — it has no way to tell 36 from 40 at
 * 80 MHz. That leaves one case stuck: when more APs conflict with each other than
 * the palette has channels, the extra ones share a channel completely, even though
 * the band may hold a narrower centre that is genuinely clear of everything they
 * conflict with. Three mutually conflicting 80 MHz APs take the whole non-DFS
 * 5 GHz palette (36, 149, 165); a 20 MHz AP that conflicts with all three can still
 * have 48 to itself, 50 MHz away from the nearest 80 MHz span, and the palette
 * alone would have made it reuse one of the three.
 *
 * So this walks an existing assignment and, for every source that shares spectrum
 * with something it conflicts with, looks for a candidate with *less* overlap —
 * same ranking as `colourConflicts`, so the two agree about what "better" means.
 * It never increases any pair's overlap, and a source whose assignment is already
 * clear is left exactly where the solver put it, which keeps the algorithm the user
 * selected meaningful.
 *
 * `adjacency[i]` are the indices source `i` conflicts with, `allowed[i]` its
 * candidates in preference order, `pinned[i]` true when the user chose it.
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
		// Only a strictly better candidate moves it, so a source the solver placed
		// somewhere acceptable stays exactly where the algorithm the user chose put it.
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
