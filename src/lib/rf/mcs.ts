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
	/** 达到该 MCS 所需的最小 SINR，dB。 */
	minSinrDb: number;
}

export const MCS_TABLE: readonly McsStep[] = [
	{ mcs: 0, rate20Mhz: 8.6, minSinrDb: -82 },
	{ mcs: 1, rate20Mhz: 17.2, minSinrDb: -79 },
	{ mcs: 2, rate20Mhz: 25.9, minSinrDb: -77 },
	{ mcs: 3, rate20Mhz: 34.4, minSinrDb: -74 },
	{ mcs: 4, rate20Mhz: 51.6, minSinrDb: -70 },
	{ mcs: 5, rate20Mhz: 68.8, minSinrDb: -66 },
	{ mcs: 6, rate20Mhz: 77.4, minSinrDb: -62 },
	{ mcs: 7, rate20Mhz: 86.0, minSinrDb: -59 },
	{ mcs: 8, rate20Mhz: 103.2, minSinrDb: -57 },
	{ mcs: 9, rate20Mhz: 114.7, minSinrDb: -54 },
	{ mcs: 10, rate20Mhz: 129.0, minSinrDb: -52 },
	{ mcs: 11, rate20Mhz: 143.4, minSinrDb: -49 }
];

/** 给定 SINR 可用的最高 MCS；低于 MCS0 时返回 -1。 */
export function sinrToMcs(sinrDb: number): number {
	if (!Number.isFinite(sinrDb)) return -1;
	for (let i = MCS_TABLE.length - 1; i >= 0; i--) {
		if (sinrDb >= MCS_TABLE[i]!.minSinrDb) return MCS_TABLE[i]!.mcs;
	}
	return -1;
}

/** 给定带宽/空间流时这套映射能达到的最高 PHY rate，Mbps。 */
export function maxPhyRateMbps(channelWidthMhz = 20, spatialStreams = 2): number {
	const widthFactor = Math.max(1, Math.round(channelWidthMhz / 20));
	return MCS_TABLE[MCS_TABLE.length - 1]!.rate20Mhz * widthFactor * Math.max(1, spatialStreams);
}

/** 估算 PHY 速率，Mbps；`channelWidthMhz` 取 20/40/80/160。 */
export function estimatedPhyRateMbps(
	sinrDb: number,
	channelWidthMhz = 20,
	spatialStreams = 2
): number {
	const mcs = sinrToMcs(sinrDb);
	if (mcs < 0) return 0;
	const step = MCS_TABLE[mcs]!;
	const widthFactor = Math.max(1, Math.round(channelWidthMhz / 20));
	return step.rate20Mhz * widthFactor * Math.max(1, spatialStreams);
}
