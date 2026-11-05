/**
 * 一轮里固定不变的那半几何：每个不动的 AP、每个采样点一行。
 *
 * 这里只依赖户型和跨层源，跟优化器把 AP 挪到哪无关，所以每轮建一次、每次评估复用。
 * 单独一个模块是因为它只关心这一件事；搜索、精确评估和报表都得从这儿走 `rf/link-budget.ts`。
 */
import { crossFloorSegments, slabLossFactor } from '../../rf/cross-floor.js';
import { wallRunLoss, type WallRun } from '../../rf/link-budget.js';
import { getMaterialDbTable } from '$lib/domain/materials.js';
import type { FixedApInput, FixedPath } from './types.js';
/**
 * 给每个固定 AP 生成逐采样点的路径数据——前提是它有自己那层的掩码，或者知道穿过的楼板类型。
 *
 * 每轮和按频段的缓存一起算一次，之后每次评估复用：搜索动的是被优化楼层的 AP，
 * 这些数据跟它们在哪无关。
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
		// 就算没有墙体拆分也得能免掉洞处的楼板损耗（比如楼下吊顶的 AP 在自己
		// 位置上就穿了楼板），所以这段和 `source` 独立算。
		let slabFactor: Float32Array | null = null;
		const slabs = fap.slabs;
		if (slabs && slabs.length > 0) {
			slabFactor = new Float32Array(numSamples);
			for (let s = 0; s < numSamples; s++) {
				const sample = samples[s]!;
				// 每个采样点一个系数，作用在*所有*交点上：每份 void 的份额都减掉，
				// 所以隔 N 层、有 k 个洞，就正好免掉均匀总和里的 k/N。见 `slabLossFactor`。
				slabFactor[s] = slabLossFactor(slabs, fap.x, fap.y, sample.x, sample.y);
			}
		}

		const src = fap.source;
		if (!src) return { split: null, slabFactor };
		const sourceT = fap.sourceT ?? 0;
		const targetT = fap.targetT ?? 0;
		// 不用拆：AP 就在这层，或者和客户端同高，调用方给的单层路径就是对的。
		if (sourceT <= 0 && targetT <= 0) return { split: null, slabFactor };

		const db = getMaterialDbTable(fap.band);
		// 没有材料掩码时每面墙损耗一样，就用各层自己的项目级损耗，别拿石膏板的值顶。
		const targetDefault = materialMask ? (db[defaultMaterial] ?? wallAttenuation) : wallAttenuation;
		const sourceDefault = src.materialMask
			? (db[src.defaultMaterial] ?? wallAttenuation)
			: wallAttenuation;

		const sourceRow = new Float32Array(numSamples);
		const suffixRow = new Float32Array(numSamples);
		/*
		 * 两段路径，共用同一次步进。
		 *
		 * 以前这里调两次 `rayMarchWallAtten`，自己减掩码原点、自己查材料表——等于把
		 * `rf/link-budget.ts` 里覆盖评估、热力图和求解器用的那套又抄了一遍。数一样，
		 * 写法不一样，四处重写的层早晚有一处会走偏。两段都从交点起算，而不是
		 * 「整段减去前缀」：步进器按线段长度定步长，前缀步进不是整段步进的前缀，
		 * 相减可能让一堵薄墙跨过步长边界。
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
		// 目标段的掩码就是位置所在的坐标系，所以原点记 0。
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