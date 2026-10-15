import type { Channel, ChannelWidth } from './types.js';

export function getFrequencyRange(ch: Channel, width: ChannelWidth): { low: number; high: number } {
	return {
		low: ch.frequency - width / 2,
		high: ch.frequency + width / 2
	};
}

export function channelsInterfere(
	a: Channel,
	b: Channel,
	widthA: ChannelWidth,
	widthB: ChannelWidth
): boolean {
	if (a.band !== b.band) {
		return false;
	}

	if (a.number === b.number) {
		return true;
	}

	if (a.band === '2.4ghz' && widthA === 20 && widthB === 20) {
		return Math.abs(a.number - b.number) < 5;
	}

	const rangeA = getFrequencyRange(a, widthA);
	const rangeB = getFrequencyRange(b, widthB);

	return rangeA.low < rangeB.high && rangeB.low < rangeA.high;
}

/**
 * How much of the narrower channel's bandwidth two assignments share, 0 to 1.
 *
 * `channelsInterfere` answers "may these two be planned together", which is a
 * yes/no question with a deliberately conservative answer: at 2.4 GHz it treats a
 * 5 MHz-spaced pair such as 1 and 5 as interfering even though their 20 MHz
 * intervals merely touch. This answers a different one — "how much do they
 * actually overlap" — and is the quantity an interval model needs, because a
 * partially overlapping pair is a *cost*, not a forbidden identity. The two can
 * therefore disagree in the safe direction: a pair this returns 0 for can still be
 * an edge in the planner's conflict graph.
 *
 * The denominator is the narrower of the two widths, so the figure is symmetrical
 * and 1 means "one is entirely inside the other": a 20 MHz channel inside an 80 MHz
 * one is 1, and two 80 MHz channels sharing half their spectrum are 0.5. Different
 * bands never overlap, whatever their channel numbers say.
 *
 * This is the primitive B3's second stage is built on (`ROADMAP.md`): once the
 * overlap is a number, "reuse the channel" and "sit next to it" are different
 * outcomes rather than the same one.
 */
export function overlapFraction(
	a: Channel,
	b: Channel,
	widthA: ChannelWidth,
	widthB: ChannelWidth
): number {
	if (a.band !== b.band) return 0;
	const rangeA = getFrequencyRange(a, widthA);
	const rangeB = getFrequencyRange(b, widthB);
	const shared = Math.min(rangeA.high, rangeB.high) - Math.max(rangeA.low, rangeB.low);
	if (shared <= 0) return 0;
	const narrower = Math.min(widthA, widthB);
	return narrower > 0 ? Math.min(1, shared / narrower) : 0;
}
