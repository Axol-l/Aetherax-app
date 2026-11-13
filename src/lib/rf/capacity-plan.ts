/**
 * 粗粒度容量规划：按终端类型分档，按房间类型给业务需求。
 *
 * 这是规划假设，不是逐终端仿真：第一版只启用 1/2 空间流，4 流字段保留但
 * 不参与计算；房间需求只给出低/标准/高三档。
 */
import { DEFAULT_MAC_EFFICIENCY, phyRateMbps, sinrToMcs } from './mcs.js';

export interface TerminalProfile {
	id: '1ss' | '2ss' | '4ss';
	label: string;
	streams: number;
	maxMcs: number;
	/** 终端构成占比；4 流暂不参与计算。 */
	share: number;
	enabled: boolean;
}

export const TERMINAL_PROFILES: readonly TerminalProfile[] = [
	{ id: '1ss', label: '1-stream', streams: 1, maxMcs: 9, share: 0.6, enabled: true },
	{ id: '2ss', label: '2-stream', streams: 2, maxMcs: 11, share: 0.35, enabled: true },
	{ id: '4ss', label: '4-stream', streams: 4, maxMcs: 11, share: 0.05, enabled: false }
];

/** 规划可用率：给突发/竞争留的余量，不是实测效率。 */
export const CAPACITY_UTILIZATION = 0.7;

/**
 * 并发率/活动因子。
 *
 * 思科高密度设计指南给出办公场景约 1 人/8 m² 的平均占用，并把
 * “20–30% concurrent use”列为低到中等密度活动的参考值；这里取 0.3，
 * 表示只有约三成终端在同一时刻产生业务。
 */
export const DEFAULT_ACTIVITY_FACTOR = 0.3;

/** 业务量档位，Mbps/终端；20 是高档，25 留给 4K/高码率专用场景。 */
export const ROOM_DEMAND_MBPS = {
	low: 2,
	standard: 10,
	high: 20
} as const;

const HIGH_ROOMS = new Set([8, 11, 20, 21, 23, 43]);
const LOW_ROOMS = new Set([2, 3, 4, 5, 6, 7, 35, 36, 37, 38, 39, 45, 46, 48]);

export function roomDemandMbps(roomTypeId: number): number {
	// 未标注（0）的区域不应当被当成标准办公室，否则整层未分类面积会凭空变成
	// 大量业务需求。容量只统计有房间类型标签的面积。
	if (roomTypeId === 0) return 0;
	if (HIGH_ROOMS.has(roomTypeId)) return ROOM_DEMAND_MBPS.high;
	if (LOW_ROOMS.has(roomTypeId)) return ROOM_DEMAND_MBPS.low;
	return ROOM_DEMAND_MBPS.standard;
}

/**
 * 终端构成下的等效 PHY：每个终端占用的空口比例按占比加权，
 * 再取倒数，得到“一个混合终端平均能拿到的 PHY”。
 */
export function effectivePhyMbps(sinrDb: number, channelWidthMhz: number): number {
	const active = TERMINAL_PROFILES.filter((profile) => profile.enabled);
	const shareTotal = active.reduce((sum, profile) => sum + profile.share, 0);
	if (shareTotal <= 0) return 0;
	const mcs = sinrToMcs(sinrDb);
	if (mcs < 0) return 0;
	let airtimePerDevice = 0;
	for (const profile of active) {
		const rate = phyRateMbps(Math.min(mcs, profile.maxMcs), channelWidthMhz, profile.streams);
		if (rate <= 0) return 0;
		airtimePerDevice += (profile.share / shareTotal) / rate;
	}
	return airtimePerDevice > 0 ? 1 / airtimePerDevice : 0;
}

/** 单个 AP 在给定中位 SINR 下的规划容量，Mbps。 */
export function apCapacityMbps(sinrDb: number, channelWidthMhz: number): number {
	return effectivePhyMbps(sinrDb, channelWidthMhz) * DEFAULT_MAC_EFFICIENCY * CAPACITY_UTILIZATION;
}

export function requiredAps(demandMbps: number, perApCapacityMbps: number): number {
	if (!(demandMbps > 0) || !(perApCapacityMbps > 0)) return 0;
	return Math.ceil(demandMbps / perApCapacityMbps);
}
