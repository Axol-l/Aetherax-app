/**
 * 链路预算中穿墙损耗部分的统一入口：把楼层掩膜与路径转换为一次或两次穿墙路径。
 * 只负责这一层公共流程，自由空间损耗、天线、楼板、绕射与反射仍由各调用方自行处理。
 */
import { crossFloorLoss, crossFloorSegments } from './cross-floor.js';
import { rayMarchWallAtten } from './propagation.js';

export interface Point {
	x: number;
	y: number;
}

/**
 * 射线可以穿越的一张掩膜，以及行进所需的全部参数。
 * `originX`/`originY` 是掩膜像素 (0, 0) 的世界坐标；行进按像素进行，调用方需先减去原点。
 */
export interface WallRun {
	mask: Uint8Array;
	width: number;
	height: number;
	/** 每个像素的材质 id，该楼层没有材质时为 null。 */
	materialMask: Uint8Array | null;
	/** 本路径所在频段下按材质 id 索引的每次穿越损耗，单位 dB。 */
	materialDb: number[];
	/** 材质表中不存在该 id 时所计的损耗。 */
	fallbackDb: number;
	/** 掩膜像素 (0, 0) 的世界坐标。 */
	originX: number;
	originY: number;
	/** 没有材质掩膜时使用的材质。 */
	defaultMaterialId: number;
}

/**
 * 同一楼层上两个世界坐标点之间墙体产生的损耗，单位 dB。
 * `stride` 是行进的像素步长，默认 1。
 */
export function wallRunLoss(run: WallRun, from: Point, to: Point, stride = 1): number {
	return rayMarchWallAtten(
		run.mask,
		run.width,
		run.height,
		run.materialMask,
		run.materialDb,
		run.fallbackDb,
		from.x - run.originX,
		from.y - run.originY,
		to.x - run.originX,
		to.y - run.originY,
		stride,
		run.defaultMaterialId
	);
}

/**
 * 跨楼层路径的损耗，按穿过的楼层分段计算，单位 dB。
 * 没有可拆分的位置（两段比例相等或几何退化）时返回 null，由调用方退回单段计算。
 */
export function splitWallRunLoss(
	source: WallRun,
	target: WallRun,
	sourceT: number,
	targetT: number,
	from: Point,
	to: Point,
	stride = 1
): number | null {
	const split = crossFloorSegments(sourceT, targetT, from.x, from.y, to.x, to.y);
	if (!split) return null;
	return crossFloorLoss(split, (floor, runFrom, runTo) =>
		wallRunLoss(floor === 'source' ? source : target, runFrom, runTo, stride)
	);
}
