/**
 * SINR → MCS → PHY rate 的规划近似。
 *
 * 阈值按 802.11ax 20 MHz、2 条空间流的工程近似整理，不是芯片实测表；
 * 用于容量规划的“相对好坏”，不用于宣称某个 MCS 一定能协商成功。
 */

export interface McsStep {
	mcs: number;
	/** 20 MHz、单空间流速率，Mbps。 */
	rate20Mhz: number;
	/** 达到该 MCS 所需的最小 SNR，dB；不是接收灵敏度 dBm。 */
	minSnrDb: number;
}

export const MCS_TABLE: readonly McsStep[] = [
	{ mcs: 0, rate20Mhz: 8.6, minSnrDb: 2 },
	{ mcs: 1, rate20Mhz: 17.2, minSnrDb: 5 },
	{ mcs: 2, rate20Mhz: 25.9, minSnrDb: 8 },
	{ mcs: 3, rate20Mhz: 34.4, minSnrDb: 11 },
	{ mcs: 4, rate20Mhz: 51.6, minSnrDb: 15 },
	{ mcs: 5, rate20Mhz: 68.8, minSnrDb: 19 },
	{ mcs: 6, rate20Mhz: 77.4, minSnrDb: 22 },
	{ mcs: 7, rate20Mhz: 86.0, minSnrDb: 25 },
	{ mcs: 8, rate20Mhz: 103.2, minSnrDb: 27 },
	{ mcs: 9, rate20Mhz: 114.7, minSnrDb: 30 },
	{ mcs: 10, rate20Mhz: 129.0, minSnrDb: 32 },
	{ mcs: 11, rate20Mhz: 143.4, minSnrDb: 35 }
];

/** 第一版界面固定按 2 条空间流估算。 */
export const PHY_REFERENCE_STREAMS = 2;

export type PhyStandard = 'ac' | 'ax';

type WidthKey = 20 | 40 | 80 | 160;
type StreamTable = Readonly<Record<1 | 2, readonly number[]>>;

const AC_20_1 = [6.5, 13, 19.5, 26, 39, 52, 58.5, 65, 78, 86.7] as const;
const AC_40_1 = [13.5, 27, 40.5, 54, 81, 108, 121.5, 135, 180, 200] as const;
const AC_80_1 = [29.3, 58.5, 87.8, 117, 175.5, 234, 263.3, 292.5, 390, 433.3] as const;
const AC_160_1 = [58.5, 117, 175.5, 234, 351, 468, 526.5, 585, 780, 866.7] as const;

function twoStreams(one: readonly number[]): readonly number[] {
	return one.map((rate) => rate * 2);
}

function acWidth(one: readonly number[]): StreamTable {
	return { 1: one, 2: twoStreams(one) };
}

/** 802.11ac VHT、GI=800 ns、MCS 0–9（ac 没有 MCS10/11）。 */
export const PHY_RATE_TABLE_AC: Readonly<Record<WidthKey, StreamTable>> = {
	20: acWidth(AC_20_1),
	40: acWidth(AC_40_1),
	80: acWidth(AC_80_1),
	160: acWidth(AC_160_1)
};

/** 802.11ax、GI=800 ns、MCS 0–11。 */
export const PHY_RATE_TABLE_AX: Readonly<Record<WidthKey, StreamTable>> = {
	20: {
		1: MCS_TABLE.map((step) => step.rate20Mhz),
		2: MCS_TABLE.map((step) => step.rate20Mhz * 2)
	},
	40: {
		1: MCS_TABLE.map((step) => step.rate20Mhz * 2),
		2: MCS_TABLE.map((step) => step.rate20Mhz * 4)
	},
	80: {
		1: MCS_TABLE.map((step) => step.rate20Mhz * 4),
		2: MCS_TABLE.map((step) => step.rate20Mhz * 8)
	},
	160: {
		1: MCS_TABLE.map((step) => step.rate20Mhz * 8),
		2: MCS_TABLE.map((step) => step.rate20Mhz * 16)
	}
};

/** 兼容旧调用；默认 802.11ax 表。 */
export const PHY_RATE_TABLE = PHY_RATE_TABLE_AX;

/** 从 AP 型号的 WiFi 标准字符串选表；WiFi 5 用 ac，其余用 ax。 */
export function phyStandardForWifiStandard(wifiStandard: string | null | undefined): PhyStandard {
	const match = /WiFi\s*(\d)/i.exec(wifiStandard ?? '');
	return match && Number(match[1]) <= 5 ? 'ac' : 'ax';
}

/** 规划用的默认 MAC 折损。仅代表帧聚合充分、低碰撞时的理想上限。 */
export const DEFAULT_MAC_EFFICIENCY = 0.45;

function widthKey(channelWidthMhz: number): 20 | 40 | 80 | 160 {
	if (channelWidthMhz >= 160) return 160;
	if (channelWidthMhz >= 80) return 80;
	if (channelWidthMhz >= 40) return 40;
	return 20;
}

/** 给定 SINR 可用的最高 MCS；低于 MCS0 时返回 -1。 */
export function sinrToMcs(sinrDb: number): number {
	if (!Number.isFinite(sinrDb)) return -1;
	for (let i = MCS_TABLE.length - 1; i >= 0; i--) {
		if (sinrDb >= MCS_TABLE[i]!.minSnrDb) return MCS_TABLE[i]!.mcs;
	}
	return -1;
}

/** 查表得到 PHY 参考速率，Mbps。 */
export function phyRateMbps(
	mcs: number,
	channelWidthMhz = 20,
	spatialStreams = PHY_REFERENCE_STREAMS,
	standard: PhyStandard = 'ax'
): number {
	if (mcs < 0) return 0;
	const table = (standard === 'ac' ? PHY_RATE_TABLE_AC : PHY_RATE_TABLE_AX)[
		widthKey(channelWidthMhz)
	];
	const streams = Math.min(2, Math.max(1, Math.round(spatialStreams))) as 1 | 2;
	const maxMcs = table[streams].length - 1;
	return table[streams][Math.min(maxMcs, Math.round(mcs))] ?? 0;
}

/** 给定带宽/空间流时这套映射能达到的最高 PHY rate，Mbps。 */
export function maxPhyRateMbps(
	channelWidthMhz = 20,
	spatialStreams = PHY_REFERENCE_STREAMS,
	standard: PhyStandard = 'ax'
): number {
	return phyRateMbps(11, channelWidthMhz, spatialStreams, standard);
}

/** 估算 PHY 速率，Mbps；`channelWidthMhz` 取 20/40/80/160。 */
export function estimatedPhyRateMbps(
	sinrDb: number,
	channelWidthMhz = 20,
	spatialStreams = PHY_REFERENCE_STREAMS,
	standard: PhyStandard = 'ax'
): number {
	return phyRateMbps(sinrToMcs(sinrDb), channelWidthMhz, spatialStreams, standard);
}

/** PHY 参考速率折损 MAC 后的规划吞吐；不是实测吞吐。 */
export function estimatedThroughputMbps(
	phyMbps: number,
	macEfficiency = DEFAULT_MAC_EFFICIENCY
): number {
	return Math.max(0, phyMbps) * Math.min(0.5, Math.max(0.45, macEfficiency));
}
