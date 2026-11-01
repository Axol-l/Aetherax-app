/**
 * The fixed half of a run's geometry: one row per sample, per access point that does not move.
 *
 * Everything here depends only on the plan and the cross-floor sources, never on where the
 * optimiser has put the access points it is moving — so it is built once per run and read by
 * every evaluation. It lives in its own module because that is the only thing this file has to
 * know about it: the search, the exact pass and the report are what the worker is for, and
 * everything they do to a wall goes through `rf/link-budget.ts` from here.
 */
import { crossFloorSegments, slabLossFactor } from '../../rf/cross-floor.js';
import { wallRunLoss, type WallRun } from '../../rf/link-budget.js';
import { getMaterialDbTable } from '$lib/domain/materials.js';
import type { FixedApInput, FixedPath } from './types.js';
/**
 * Build the per-sample path data for every fixed AP that has a mask for its own
 * floor, or room types for the slab it crosses.
 *
 * Computed once per run, alongside the per-band caches, and reused by every
 * evaluation — the search moves the optimised floor's APs, and none of this
 * depends on where they are.
 */
export function buildFixedPaths(
	fixedAps: readonly FixedApInput[],
	samples: ReadonlyArray<{ x: number; y: number }>,
	mask: Uint8Array,
	w: number,
	h: number,
	materialMask: Uint8Array | null,
	defaultMaterial: number,
	wallAttenuation: number
): FixedPath[] {
	const numSamples = samples.length;
	return fixedAps.map((fap) => {
		// Slab loss can be waived at a hole even when there is no wall split to make
		// (an AP ceiling-mounted on the storey below crosses the slab at its own
		// position), so this is built independently of `source`.
		let slabFactor: Float32Array | null = null;
		const slabs = fap.slabs;
		if (slabs && slabs.length > 0) {
			slabFactor = new Float32Array(numSamples);
			for (let s = 0; s < numSamples; s++) {
				const sample = samples[s]!;
				// One multiplier per sample over *all* the crossings: each void share
				// is subtracted, so N storeys with k holes waive exactly k/N of a
				// uniform aggregate. See `slabLossFactor`.
				slabFactor[s] = slabLossFactor(slabs, fap.x, fap.y, sample.x, sample.y);
			}
		}

		const src = fap.source;
		if (!src) return { split: null, slabFactor };
		const sourceT = fap.sourceT ?? 0;
		const targetT = fap.targetT ?? 0;
		// Nothing to split: the AP is on this floor, or level with its client, so the
		// caller's single-floor path is already the right one.
		if (sourceT <= 0 && targetT <= 0) return { split: null, slabFactor };

		const db = getMaterialDbTable(fap.band);
		// Without a material map every wall costs the same, so honour each floor's
		// own project-level attenuation rather than substituting Drywall's value.
		const targetDefault = materialMask ? (db[defaultMaterial] ?? wallAttenuation) : wallAttenuation;
		const sourceDefault = src.materialMask
			? (db[src.defaultMaterial] ?? wallAttenuation)
			: wallAttenuation;

		const sourceRow = new Float32Array(numSamples);
		const suffixRow = new Float32Array(numSamples);
		/*
		 * Two runs, and the shared march charges them.
		 *
		 * This used to call `rayMarchWallAtten` twice, subtracting each mask's origin itself and
		 * picking the default material out of the table by hand — a copy of what
		 * `rf/link-budget.ts` does for the coverage pass, the heatmap and the solver. The numbers
		 * were the same; the arrangement was not, and a layer that four places re-implement is a
		 * layer where one of them eventually differs. Both halves are marched from the crossing
		 * rather than as "the whole run minus its prefix": the marcher's step follows the
		 * segment length, so a prefix march is not a prefix of the full one and the subtraction
		 * could move a thin wall across a step boundary.
		 */
		const sourceRun: WallRun = {
			mask: src.data,
			width: src.width,
			height: src.height,
			materialMask: src.materialMask,
			materialDb: db,
			fallbackDb: sourceDefault,
			originX: src.originX,
			originY: src.originY,
			defaultMaterialId: src.defaultMaterial
		};
		// The run's own mask is in the frame its positions are in, so its origin is zero here.
		const targetRun: WallRun = {
			mask,
			width: w,
			height: h,
			materialMask,
			materialDb: db,
			fallbackDb: targetDefault,
			originX: 0,
			originY: 0,
			defaultMaterialId: defaultMaterial
		};
		for (let s = 0; s < numSamples; s++) {
			const sample = samples[s]!;
			const seg = crossFloorSegments(sourceT, targetT, fap.x, fap.y, sample.x, sample.y);
			if (!seg) continue;
			sourceRow[s] = wallRunLoss(sourceRun, seg.source.from, seg.source.to, 3);
			suffixRow[s] = wallRunLoss(targetRun, seg.target.from, seg.target.to, 3);
		}
		return { split: { source: sourceRow, suffix: suffixRow }, slabFactor };
	});
}