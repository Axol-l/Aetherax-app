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
 * 两个信号源信道分配之间的频率重叠，取较窄信道带宽的比例。
 * `i`、`j` 为信号源下标，信道号可以是候选值；频段与带宽在一次运行中固定，不走参数。
 */
export type OverlapLookup = (
	i: number,
	channelI: number,
	j: number,
	channelJ: number
) => number;

/**
 * 简化模型：信道号相同即完全重叠，否则不重叠，仅适用于互不重叠的信道集合。
 */
export const SAME_CHANNEL_OVERLAP: OverlapLookup = (_i, channelI, _j, channelJ) =>
	channelI === channelJ ? 1 : 0;

/** 各频段的信道表，每个频段最多构建一次。 */
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
 * 为一次运行中的信号源构建信道重叠查找函数。
 *
 * `bands[i]` 与 `widths[i]` 描述信号源 `i` 的频段与信道带宽；信道号不在所属频段表中时按零重叠处理。
 */
export function makeOverlapLookup(
	bands: readonly string[],
	widths: readonly number[]
): OverlapLookup {
	const bandOf = (i: number): Band => bands[i] as Band;
	return (i, channelI, j, channelJ) => {
		const band = bandOf(i);
		// 不同频段的两个信号源不共享频谱，直接按零重叠处理。
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
