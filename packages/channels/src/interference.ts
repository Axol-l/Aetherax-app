import type { Band, ChannelWidth, RegulatoryDomain } from './types.js';
import { CHANNELS_2_4GHZ } from './bands/band-2_4ghz.js';
import { CHANNELS_5GHZ } from './bands/band-5ghz.js';
import { CHANNELS_6GHZ } from './bands/band-6ghz.js';

/** 第一版工程默认值；不是芯片实测的 ACLR。 */
export const DEFAULT_ACIR_DB = 25;

/** 紧邻但不相交时仍给最低泄漏权重的最大边缘间隔，MHz。 */
export const ADJACENT_GAP_MHZ = 5;

export interface ChannelOccupancy {
	band: Band;
	primary: number;
	width: ChannelWidth;
	centerMhz: number;
	lowMhz: number;
	highMhz: number;
}

export interface ChannelRef {
	band: Band;
	assignedChannel: number | null;
	channelWidth: ChannelWidth;
}

interface Group5 {
	low: number;
	high: number;
	center: number;
}

const GROUPS_80_5GHZ: readonly Group5[] = [
	{ low: 36, high: 48, center: 5210 },
	{ low: 52, high: 64, center: 5290 },
	{ low: 100, high: 112, center: 5530 },
	{ low: 116, high: 128, center: 5610 },
	{ low: 132, high: 144, center: 5690 },
	{ low: 149, high: 161, center: 5775 }
];

const GROUPS_160_5GHZ: readonly Group5[] = [
	{ low: 36, high: 64, center: 5250 },
	{ low: 100, high: 128, center: 5570 },
	// UNII-3 没有连续的 160 MHz 组，149–161 只有 80 MHz。
];

const GROUPS_40_5GHZ: readonly Group5[] = [
	{ low: 36, high: 40, center: 5190 },
	{ low: 44, high: 48, center: 5230 },
	{ low: 52, high: 56, center: 5270 },
	{ low: 60, high: 64, center: 5310 },
	{ low: 100, high: 104, center: 5510 },
	{ low: 108, high: 112, center: 5550 },
	{ low: 116, high: 120, center: 5590 },
	{ low: 124, high: 128, center: 5630 },
	{ low: 132, high: 136, center: 5670 },
	{ low: 140, high: 144, center: 5710 },
	{ low: 149, high: 153, center: 5755 },
	{ low: 157, high: 161, center: 5795 }
];

function primaryFrequency(band: Band, primary: number): number | null {
	const list =
		band === '2.4ghz' ? CHANNELS_2_4GHZ : band === '5ghz' ? CHANNELS_5GHZ : CHANNELS_6GHZ;
	return list.find((channel) => channel.number === primary)?.frequency ?? null;
}

function groupFor(list: readonly Group5[], primary: number): Group5 | null {
	return list.find((group) => primary >= group.low && primary <= group.high) ?? null;
}

/**
 * 主信道号 → 实际信道中心。5 GHz 的 40/80/160 MHz 中心不是主信道中心；
 * 2.4/6 GHz 的 40 MHz 也使用分组中心。
 */
export function channelCenterMhz(
	band: Band,
	primary: number,
	width: ChannelWidth,
	_domain: RegulatoryDomain = 'fcc'
): number | null {
	const primaryMhz = primaryFrequency(band, primary);
	if (primaryMhz === null) return null;
	if (width === 20) return primaryMhz;

	if (band === '5ghz') {
		const group =
			width === 160
				? groupFor(GROUPS_160_5GHZ, primary)
				: width === 80
					? groupFor(GROUPS_80_5GHZ, primary)
					: width === 40
						? groupFor(GROUPS_40_5GHZ, primary)
						: null;
		if (group) return group.center;
		// 没有分组的组合退回主信道中心；调用方仍可据范围做保守判断。
		return primaryMhz;
	}

	/*
	 * 6 GHz 以 20 MHz 为步长，40/80/160/320 MHz 的中心就是分组的中点。
	 * 2.4 GHz 的 40 MHz 由两个相邻的 20 MHz 组成；没有分组时退回主信道中心。
	 */
	if (band === '6ghz') return primaryMhz + width / 2 - 10;
	if (band === '2.4ghz' && width === 40) return primaryMhz + 10;
	return primaryMhz;
}

export function channelOccupancy(
	band: Band,
	primary: number,
	width: ChannelWidth,
	domain: RegulatoryDomain = 'fcc'
): ChannelOccupancy | null {
	const centerMhz = channelCenterMhz(band, primary, width, domain);
	if (centerMhz === null) return null;
	return {
		band,
		primary,
		width,
		centerMhz,
		lowMhz: centerMhz - width / 2,
		highMhz: centerMhz + width / 2
	};
}

function occupancyOf(ref: ChannelRef, domain: RegulatoryDomain): ChannelOccupancy | null {
	if (ref.assignedChannel === null) return null;
	return channelOccupancy(ref.band, ref.assignedChannel, ref.channelWidth, domain);
}

function overlapMhz(a: ChannelOccupancy, b: ChannelOccupancy): number {
	return Math.max(0, Math.min(a.highMhz, b.highMhz) - Math.max(a.lowMhz, b.lowMhz));
}

function contains(outer: ChannelOccupancy, inner: ChannelOccupancy): boolean {
	return outer.lowMhz <= inner.lowMhz && outer.highMhz >= inner.highMhz;
}

function edgeGapMhz(a: ChannelOccupancy, b: ChannelOccupancy): number {
	if (a.highMhz <= b.lowMhz) return b.lowMhz - a.highMhz;
	if (b.highMhz <= a.lowMhz) return a.lowMhz - b.highMhz;
	return 0;
}

/**
 * 干扰 AP 对服务 AP 的功率权重。
 *
 * - 同中心或包含关系：只按服务带宽中被占用的比例，不再乘 ACIR；
 * - 部分重叠的邻道：比例 × 10^(-ACIR/10)；
 * - 不重叠但边缘间隔不超过 ADJACENT_GAP_MHZ：最低泄漏权重；
 * - 更远或不同频段：0；
 * - 缺少信道信息：1（保守地按同频处理，调用方应提示）。
 */
export function channelInterferenceWeight(
	server: ChannelRef,
	interferer: ChannelRef,
	acirDb = DEFAULT_ACIR_DB,
	domain: RegulatoryDomain = 'fcc'
): number {
	if (server.band !== interferer.band) return 0;
	const s = occupancyOf(server, domain);
	const i = occupancyOf(interferer, domain);
	if (!s || !i) return 1;

	const acir = 10 ** (-Math.max(0, acirDb) / 10);
	const overlap = overlapMhz(s, i);
	if (overlap > 0) {
		const fraction = Math.min(1, overlap / s.width);
		const sameCenter = Math.abs(s.centerMhz - i.centerMhz) < 1e-6;
		// A wider interferer covering the server is co-channel inside the server's
		// band; a wider server containing a narrow interferer only receives the
		// fraction of that interferer's power that falls inside its own band.
		if (sameCenter || contains(i, s) || contains(s, i)) return fraction;
		return fraction * acir;
	}

	return edgeGapMhz(s, i) <= ADJACENT_GAP_MHZ ? acir : 0;
}
