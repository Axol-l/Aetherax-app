/** Measuring the two wall models against each other. */
import type { Band } from '@aetherax/channels';
import { rayWallLossDb, type WallSegment } from './wall-crossings.js';

export interface WallModelComparison {
	/** How many rays were compared. */
	samples: number;
	/** Mean absolute difference, in dB — the headline number. */
	meanAbsDb: number;
	/** Largest absolute difference, and where it happened. */
	maxAbsDb: number;
	maxAt: { x: number; y: number; from: { x: number; y: number } } | null;
	/** Means of each model, so a systematic bias is visible rather than averaged away. */
	rasterMeanDb: number;
	vectorMeanDb: number;
	/** Rays where one model charges a wall and the other charges none: the dangerous ones. */
	disagreements: number;
}

/**
 * Compare the two models over a set of rays.
 *
 * `rasterLoss` is handed the same endpoints the vector model gets, so the comparison is
 * apples to apples: one ray, two answers. A ray that one model blocks and the other does not
 * is called out separately because it is not a rounding difference — it is a wall one model
 * sees and the other misses, and on a heatmap it is a stripe of coverage that should not be
 * there.
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
		// One model crossed a wall, the other did not. A tenth of a dB is arithmetic; a
		// whole wall's figure is a disagreement about the geometry.
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
