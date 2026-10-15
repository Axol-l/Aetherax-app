import {
	CHANNELS_2_4GHZ,
	CHANNELS_5GHZ,
	CHANNELS_6GHZ,
	overlapFraction,
	type Band,
	type Channel,
	type ChannelWidth
} from '@aetherax/channels';

/**
 * Frequency overlap between two sources' assignments, as a fraction of the
 * narrower channel's bandwidth.
 *
 * `i` and `j` are source indices, `channelI` and `channelJ` the channel numbers
 * they currently hold (or a candidate one, when an assigner is asking what a swap
 * would cost). The bands and widths are not arguments because they do not change
 * during a run: they are what the lookup is built from.
 */
export type OverlapLookup = (
	i: number,
	channelI: number,
	j: number,
	channelJ: number
) => number;

/**
 * The model that predates B3's second stage: two sources overlap completely when
 * their channel numbers are equal, and not at all otherwise. Correct only while
 * every assignment is drawn from a non-overlapping palette.
 */
export const SAME_CHANNEL_OVERLAP: OverlapLookup = (_i, channelI, _j, channelJ) =>
	channelI === channelJ ? 1 : 0;

/** Channel tables by band, built at most once per band. */
const tables = new Map<Band, Map<number, Channel>>();

function tableFor(band: Band): Map<number, Channel> {
	let table = tables.get(band);
	if (!table) {
		const list =
			band === '2.4ghz' ? CHANNELS_2_4GHZ : band === '5ghz' ? CHANNELS_5GHZ : CHANNELS_6GHZ;
		table = new Map(list.map((ch) => [ch.number, ch]));
		tables.set(band, table);
	}
	return table;
}

/**
 * Build the overlap lookup for one run's sources.
 *
 * `bands[i]` and `widths[i]` describe source `i` — its band and the channel width
 * it is configured for. A channel number that is not in its band's table (a pin the
 * domain does not permit, or a source with no band) contributes no overlap, which
 * is the conservative reading: an unknown assignment cannot be shown to be clean.
 */
export function makeOverlapLookup(
	bands: readonly string[],
	widths: readonly number[]
): OverlapLookup {
	const bandOf = (i: number): Band => bands[i] as Band;
	return (i, channelI, j, channelJ) => {
		const band = bandOf(i);
		// A pair in different bands cannot share spectrum, whatever the numbers say:
		// 6 GHz channel 1 and 2.4 GHz channel 1 are 3.5 GHz apart.
		if (band !== bandOf(j)) return 0;
		const a = tableFor(band).get(channelI);
		const b = tableFor(band).get(channelJ);
		if (!a || !b) return 0;
		return overlapFraction(
			a,
			b,
			(widths[i] ?? 20) as ChannelWidth,
			(widths[j] ?? 20) as ChannelWidth
		);
	};
}
