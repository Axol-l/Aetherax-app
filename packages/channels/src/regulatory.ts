import type { Band, Channel, ChannelWidth, RegulatoryDomain } from './types.js';
import { CHANNELS_2_4GHZ } from './bands/band-2_4ghz.js';
import { CHANNELS_5GHZ } from './bands/band-5ghz.js';
import { CHANNELS_6GHZ } from './bands/band-6ghz.js';
import { channelsInterfere } from './overlap.js';

export interface AvailableChannelsOptions {
	includeDfs?: boolean;
}

export function getAvailableChannels(
	band: Band,
	domain: RegulatoryDomain,
	options?: AvailableChannelsOptions
): Channel[] {
	const includeDfs = options?.includeDfs ?? false;

	switch (band) {
		case '2.4ghz': {
			const maxChannel = domain === 'fcc' ? 11 : 13;
			return CHANNELS_2_4GHZ.filter((ch) => ch.number <= maxChannel);
		}
		case '5ghz': {
			if (includeDfs) {
				return [...CHANNELS_5GHZ];
			}
			return CHANNELS_5GHZ.filter((ch) => !ch.dfs);
		}
		case '6ghz': {
			return [...CHANNELS_6GHZ];
		}
	}
}

/**
 * The subset of `channels` that do not overlap each other, taken greedily from
 * the low end.
 *
 * `getAvailableChannels` returns every channel a domain permits — eleven of them
 * at 2.4 GHz — while only three of those (1, 6 and 11) do not overlap. The
 * difference matters wherever a *count* of usable channels is the input to a
 * decision: Oustry et al. (Networks 81(1), 2023) find that alternating placement
 * and assignment mainly pays off "for cases with 3 available channels", and 3 is
 * this number, not the length of the list.
 *
 * `channels` is expected in ascending order, which is how the band tables are
 * written.
 */
export function nonOverlappingChannels(channels: Channel[], width: ChannelWidth): Channel[] {
	const chosen: Channel[] = [];
	for (const candidate of channels) {
		if (chosen.every((c) => !channelsInterfere(c, candidate, width, width))) chosen.push(candidate);
	}
	return chosen;
}

/**
 * The channels an **automatic** assignment may use: the non-overlapping subset.
 *
 * This is the B3 fix, and it is deliberately the cruder of the two ways to model
 * partial overlap. Everything downstream — the colouring solver, the optimiser's
 * interference term — tests a pair's channels with `number_a === number_b`, which is
 * only the same question as "do they interfere" when the palette is
 * non-overlapping. Handing out all eleven 2.4 GHz channels therefore did not just
 * lose information, it asserted something false: two APs on 1 and 2 were treated as
 * independent when they overlap almost completely. On a plan with no pinned channels
 * that made the interference term unreachable, because the solver would give four
 * APs four *distinct* numbers and never reuse one (see `ROADMAP.md` B1/B3).
 *
 * Restricting the palette makes the equality test correct again, at the cost of the
 * overlap channels a real deployment may well use. The honest fix is an interval
 * model — every AP requests a width and is given a start, overlapping is a partial
 * cost rather than a forbidden identity — which is B3's second stage and does not
 * need this function. Pins are unaffected: a user may still pin any channel the
 * domain permits, overlapping or not, and `planningChannels` is only what the
 * planner chooses for itself.
 *
 * The width is the *widest* in use on that band, since a set that does not overlap at
 * 80 MHz does not overlap at 20 either: mixing widths is exactly the pairwise case
 * the interval model would handle and this one cannot.
 */
export function planningChannels(
	band: Band,
	domain: RegulatoryDomain,
	width: ChannelWidth,
	options?: AvailableChannelsOptions
): Channel[] {
	return nonOverlappingChannels(getAvailableChannels(band, domain, options), width);
}

/**
 * Every channel the planner may put a source on, in the order it should prefer
 * them: the non-overlapping palette first, then the rest.
 *
 * `planningChannels` alone was B3's first stage, and it was an approximation of
 * the feasible set rather than the set itself. It answers "which centres can all
 * be used *together* at this width"; a source that only has to keep clear of the
 * APs it actually conflicts with has more room than that, and the difference is
 * real once widths are mixed: three mutually conflicting 80 MHz APs fill the whole
 * non-DFS 5 GHz palette, and a 20 MHz AP that conflicts with all three can still
 * take a centre 50 MHz from the nearest 80 MHz span — zero overlap — where the
 * palette would have forced it to share a channel completely. The palette is still
 * first in the order, so nothing conventional is given up: with 4 APs on 2.4 GHz
 * the fourth reuses 1/6/11 rather than moving next to it (see `ROADMAP.md` B3).
 *
 * Ordering, not filtering, is what carries that preference: an assigner walks this
 * list and takes the first candidate that is *feasible*, so "conventional first"
 * and "widen only when the conventional set cannot serve this source" are the same
 * instruction.
 */
export function planningCandidates(
	band: Band,
	domain: RegulatoryDomain,
	width: ChannelWidth,
	options?: AvailableChannelsOptions
): Channel[] {
	const available = getAvailableChannels(band, domain, options);
	const palette = nonOverlappingChannels(available, width);
	const inPalette = new Set(palette.map((ch) => ch.number));
	return [...palette, ...available.filter((ch) => !inPalette.has(ch.number))];
}
