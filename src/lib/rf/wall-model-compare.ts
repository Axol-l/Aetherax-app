/** 两种穿墙模型的相互对比测量。 */
import type { Band } from '@aetherax/channels';
import { rayWallLossDb, type WallSegment } from './wall-crossings.js';

export interface WallModelComparison {
	/** 参与对比的射线数量。 */
	samples: number;
	/** 平均绝对差值，单位 dB，为主要指标。 */
	meanAbsDb: number;
	/** 最大绝对差值及其发生位置。 */
	maxAbsDb: number;
	maxAt: { x: number; y: number; from: { x: number; y: number } } | null;
	/** 两个模型各自的均值，用于看出系统性偏差。 */
	rasterMeanDb: number;
	vectorMeanDb: number;
	/** 一个模型计了墙、另一个未计墙的射线数量。 */
	disagreements: number;
}

/**
 * 在一组射线上对比两种模型。
 * `rasterLoss` 与矢量模型拿到相同的端点，保证同一条射线得到两种可比的答案。
 */
export function compareWallModels(input: {
	walls: readonly WallSegment[];
	band: Band;
	from: { x: number; y: number };
	points: ReadonlyArray<{ x: number; y: number }>;
	rasterLoss: (from: { x: number; y: number }, to: { x: number; y: number }) => number;
}): WallModelComparison {
	const { walls, band, from, points, rasterLoss } = input;
	let sumAbs = 0;
	let maxAbs = 0;
	let maxAt: WallModelComparison['maxAt'] = null;
	let rasterSum = 0;
	let vectorSum = 0;
	let disagreements = 0;

	for (const point of points) {
		const raster = rasterLoss(from, point);
		const vector = rayWallLossDb(from, point, walls, band);
		const difference = Math.abs(vector - raster);
		sumAbs += difference;
		rasterSum += raster;
		vectorSum += vector;
		if (difference > maxAbs) {
			maxAbs = difference;
			maxAt = { x: point.x, y: point.y, from };
		}
		// 一个模型穿过墙而另一个没有：微小差异属于算术，整面墙的差距则是几何判断的分歧。
		if ((raster > 0.5 && vector < 0.5) || (vector > 0.5 && raster < 0.5)) disagreements++;
	}

	const samples = points.length;
	return {
		samples,
		meanAbsDb: samples > 0 ? sumAbs / samples : 0,
		maxAbsDb: maxAbs,
		maxAt,
		rasterMeanDb: samples > 0 ? rasterSum / samples : 0,
		vectorMeanDb: samples > 0 ? vectorSum / samples : 0,
		disagreements
	};
}
