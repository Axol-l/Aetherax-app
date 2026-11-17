/**
 * 规划中的房间：所有需要就“哪个房间是哪个”达成一致的地方共用同一份推导结果。
 * `roomDensityOverrides` 以这里产生的区域 id 为键，调用方必须传入相同参数；
 * id 在编辑后不保证稳定，新增墙体可能使房间重排。
 */
import { computeBuildingInterior } from './morphology.js';
import { labelRooms } from './region-labels.js';

export interface RoomDomain {
	/** 可行走地面：位于建筑内部，且已移除小于最小半径的凹腔。 */
	interior: Uint8Array;
	/** 每个像素所属的区域 id，不属于任何房间时为 −1。 */
	labels: Int32Array;
	/** 标签中不同房间的数量。 */
	regionCount: number;
}

export interface RoomDomainOptions {
	/**
	 * 区域可成为房间的最小内切半径，单位为掩码像素。
	 * 各调用方用自身标定换算同一米制值（`MIN_ROOM_RADIUS_M`），因此该参数随图纸比例变化，
	 * 而不随调用方变化。
	 */
	minRegionRadius: number;
	/**
	 * 是否裁掉紧贴墙体的像素。
	 *
	 * 放置域及其校验传 true；画面和密度图传 false，两者都必须内部一致，混用会重新编号房间。
	 */
	trimWallAdjacent: boolean;
}

/** 构建单张平面图的房间。 */
export function buildRoomDomain(
	wallData: Uint8Array,
	width: number,
	height: number,
	options: RoomDomainOptions
): RoomDomain {
	const { interior } = computeBuildingInterior(wallData, width, height, {
		// 两个检测器共同栅格化到的工作分辨率，使同一平面图得到相同的分区。
		maxDim: 400,
		dilateRatio: 0.04,
		// 封闭轮廓上门宽大小的缺口，同时不封死真实走廊。
		minDilateR: 4,
		trimWallAdjacent: options.trimWallAdjacent,
		minRegionRadius: Math.max(0, options.minRegionRadius)
	});
	const { labels, regionCount } = labelRooms(interior, width, height);
	return { interior, labels, regionCount };
}
