// 按国家/监管规则筛选可用频道

import type { Band, Channel, ChannelWidth, RegulatoryDomain } from './types.js';
import { CHANNELS_2_4GHZ } from './bands/band-2_4ghz.js';
import { CHANNELS_5GHZ } from './bands/band-5ghz.js';
import { CHANNELS_6GHZ } from './bands/band-6ghz.js';
import { channelsInterfere } from './overlap.js';
import { channelOccupancy } from './interference.js';

export interface AvailableChannelsOptions {
	includeDfs?: boolean;
}

// 获取某频段、FCC/ETSI 规则下可用的频道
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

// 按实际信道分组中心判断是否重叠；40/80/160 MHz 不能再用主信道中心。
function planningChannelsOverlap(a: Channel, b: Channel, width: ChannelWidth): boolean {
	if (a.band !== b.band) return false;
	// 2.4 GHz 20 MHz has the legacy “five channel numbers” rule; spectral
	// ranges that merely touch still interfere in the real channel plan.
	if (a.band === '2.4ghz' && width === 20) {
		return channelsInterfere(a, b, width, width);
	}
	const ocA = channelOccupancy(a.band, a.number, width);
	const ocB = channelOccupancy(b.band, b.number, width);
	if (!ocA || !ocB) return channelsInterfere(a, b, width, width);
	return ocA.lowMhz < ocB.highMhz && ocB.lowMhz < ocA.highMhz;
}

//  筛选互不重叠的频道
export function nonOverlappingChannels(channels: Channel[], width: ChannelWidth): Channel[] {
	const chosen: Channel[] = [];
	for (const candidate of channels) {
		if (chosen.every((c) => !planningChannelsOverlap(c, candidate, width))) chosen.push(candidate);
	}
	return chosen;
}

// 自动规划优先使用的无重叠频道
export function planningChannels(
	band: Band,
	domain: RegulatoryDomain,
	width: ChannelWidth,
	options?: AvailableChannelsOptions
): Channel[] {
	const available = getAvailableChannels(band, domain, options).filter(
		(channel) => channel.maxWidth >= width
	);
	return nonOverlappingChannels(available, width);
}

// 优先返回无重叠频道，再补充其它可用频道
export function planningCandidates(
	band: Band,
	domain: RegulatoryDomain,
	width: ChannelWidth,
	options?: AvailableChannelsOptions
): Channel[] {
	const available = getAvailableChannels(band, domain, options).filter(
		(channel) => channel.maxWidth >= width
	);
	const palette = nonOverlappingChannels(available, width);
	const inPalette = new Set(palette.map((ch) => ch.number));
	return [...palette, ...available.filter((ch) => !inPalette.has(ch.number))];
}
