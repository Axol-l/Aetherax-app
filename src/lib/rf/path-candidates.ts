/**
 * 每个接入点的二级路径候选。
 *
 * 热力图每帧只建一次这些候选，纹素循环里不再反复遍历所有墙和所有刃峰。
 * 这里不是完整的射线追踪：反射候选仍交给 `reflections()` 做镜像法，绕射候选只保留
 * AP 一侧可见的刃峰，客户端一侧的可见性在纹素循环里检查。
 */
import type { Band } from '@aetherax/channels';
import { edgesOf, type DiffractionEdge } from './diffraction.js';
import { rayWallLossDb } from './wall-crossings.js';
import { getScatteringCoefficient, type WallMaterialId } from '$lib/domain/materials.js';
import { reflectionPowerRatio, type ReflectingWall } from './reflection.js';

/** 绕射距离和净空上限，单位米，与 `diffraction.ts` 的默认值一致。 */
export const DIFFRACTION_MAX_DISTANCE_M = 60;
export const DIFFRACTION_MAX_CLEARANCE_M = 40;

export interface ReflectionCandidateSet {
	/** 只保留至少存在一个有效入射角的墙。 */
	walls: ReflectingWall[];
	/** 每面候选墙在原始 `walls` 中的下标；反射点仍按候选墙计算。 */
	wallIndices: number[];
	/** 按墙中点建立的均匀网格；候选很少时为 null，直接线性扫描更便宜。 */
	grid: WallCandidateGrid | null;
}

/**
 * 按墙中点分格的均匀网格。反射点随客户端变化，但“哪面墙离 AP–客户端中点足够近”
 * 可以先由网格筛一遍，避免每个纹素都扫完候选墙。
 */
export class WallCandidateGrid {
	private readonly cells = new Map<string, number[]>();

	constructor(
		walls: readonly ReflectingWall[],
		private readonly cellSize: number
	) {
		if (!(cellSize > 0)) return;
		walls.forEach((wall, index) => {
			const key = this.key(
				Math.floor(((wall.ax + wall.bx) / 2) / cellSize),
				Math.floor(((wall.ay + wall.by) / 2) / cellSize)
			);
			const cell = this.cells.get(key);
			if (cell) cell.push(index);
			else this.cells.set(key, [index]);
		});
	}

	private key(ix: number, iy: number): string {
		return `${ix},${iy}`;
	}

	/** 中点落在这个圆内的候选墙下标，已去重。 */
	query(x: number, y: number, radius: number): number[] {
		if (!(this.cellSize > 0)) return [];
		const minX = Math.floor((x - radius) / this.cellSize);
		const maxX = Math.floor((x + radius) / this.cellSize);
		const minY = Math.floor((y - radius) / this.cellSize);
		const maxY = Math.floor((y + radius) / this.cellSize);
		const out = new Set<number>();
		for (let ix = minX; ix <= maxX; ix++) {
			for (let iy = minY; iy <= maxY; iy++) {
				const cell = this.cells.get(this.key(ix, iy));
				if (!cell) continue;
				for (const index of cell) out.add(index);
			}
		}
		return [...out];
	}
}

/**
 * 同一材质、同一频段下反射系数为 0 的墙不可能产生反射，直接排除。
 * 真正的反射点仍由镜像法按客户端位置计算。
 */
export function reflectionCandidates(
	walls: readonly ReflectingWall[],
	band: Band,
	cellSizeWu = 0
): ReflectionCandidateSet {
	const out: ReflectingWall[] = [];
	const indices: number[] = [];
	for (let i = 0; i < walls.length; i++) {
		const wall = walls[i]!;
		// 正入射的反射系数是这面墙能给出的上限；为 0 时任何角度都不会有反射。
		// 但漫散射仍可能有贡献，所以还要看材质的散射系数。
		if (
			reflectionPowerRatio(wall, band, 1) <= 0 &&
			getScatteringCoefficient(wall.material as WallMaterialId) <= 0
		) {
			continue;
		}
		out.push(wall);
		indices.push(i);
	}
	return {
		walls: out,
		wallIndices: indices,
		grid: cellSizeWu > 0 && out.length >= 12 ? new WallCandidateGrid(out, cellSizeWu) : null
	};
}

/**
 * 一维漫散射的面元。
 */
export interface ScatterSample {
	wall: ReflectingWall;
	wallIndex: number;
	x: number;
	y: number;
	/** AP 到该面元中心的距离，米。 */
	d1M: number;
	/** 该面元等效面积，平方米。 */
	areaM2: number;
}

/** 一维墙面积分的面元长度和每面墙的最大采样数。 */
export const SCATTER_SEGMENT_M = 1;
export const MAX_SCATTER_SAMPLES_PER_WALL = 16;

/**
 * 把墙按长度切成面元，保留 AP 一侧可见、且材质有散射系数的面元。
 * 客户端一侧的可见性仍由调用方逐纹素判断。
 */
export function scatterSamplesForAp(
	ap: { x: number; y: number },
	walls: readonly ReflectingWall[],
	band: Band,
	metersPerWorldUnit: number,
	wallHeightM: number
): ScatterSample[] {
	const out: ScatterSample[] = [];
	if (!(wallHeightM > 0)) return out;
	for (let wallIndex = 0; wallIndex < walls.length; wallIndex++) {
		const wall = walls[wallIndex]!;
		if (getScatteringCoefficient(wall.material as WallMaterialId) <= 0) continue;
		const lengthWu = Math.hypot(wall.bx - wall.ax, wall.by - wall.ay);
		const lengthM = lengthWu * metersPerWorldUnit;
		if (!(lengthM > 0)) continue;
		const count = Math.min(
			MAX_SCATTER_SAMPLES_PER_WALL,
			Math.max(1, Math.ceil(lengthM / SCATTER_SEGMENT_M))
		);
		const areaM2 = (lengthM / count) * wallHeightM;
		for (let i = 0; i < count; i++) {
			const t = (i + 0.5) / count;
			const x = wall.ax + (wall.bx - wall.ax) * t;
			const y = wall.ay + (wall.by - wall.ay) * t;
			const d1M = Math.hypot(x - ap.x, y - ap.y) * metersPerWorldUnit;
			const apLoss = rayWallLossDb(ap, { x, y }, walls, band, [wallIndex]);
			if (apLoss > 1e-9) continue;
			out.push({ wall, wallIndex, x, y, d1M, areaM2 });
		}
	}
	return out;
}

/**
 * AP 一侧的绕射候选：刃峰在 AP 的最大距离内，且 AP 到刃峰之间没有其他墙。
 * 客户端一侧的可见性仍取决于纹素位置，留给调用方逐点判断。
 */
export function diffractionCandidatesForAp(
	ap: { x: number; y: number },
	walls: readonly ReflectingWall[],
	band: Band,
	metersPerWorldUnit: number
): DiffractionEdge[] {
	const edges = edgesOf(walls);
	const out: DiffractionEdge[] = [];
	for (const edge of edges) {
		const d1 = Math.hypot(edge.x - ap.x, edge.y - ap.y);
		if (d1 * metersPerWorldUnit > DIFFRACTION_MAX_DISTANCE_M) continue;
		const apLoss = rayWallLossDb(ap, edge, walls, band, edge.wallIndices ?? []);
		if (apLoss > 1e-9) continue;
		out.push(edge);
	}
	return out;
}
