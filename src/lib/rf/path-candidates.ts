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
import { reflectionPowerRatio, type ReflectingWall } from './reflection.js';

/** 绕射距离和净空上限，单位米，与 `diffraction.ts` 的默认值一致。 */
export const DIFFRACTION_MAX_DISTANCE_M = 60;
export const DIFFRACTION_MAX_CLEARANCE_M = 40;

export interface ReflectionCandidateSet {
	/** 只保留至少存在一个有效入射角的墙。 */
	walls: ReflectingWall[];
	/** 每面候选墙在原始 `walls` 中的下标；反射点仍按候选墙计算。 */
	wallIndices: number[];
}

/**
 * 同一材质、同一频段下反射系数为 0 的墙不可能产生反射，直接排除。
 * 真正的反射点仍由镜像法按客户端位置计算。
 */
export function reflectionCandidates(
	walls: readonly ReflectingWall[],
	band: Band
): ReflectionCandidateSet {
	const out: ReflectingWall[] = [];
	const indices: number[] = [];
	for (let i = 0; i < walls.length; i++) {
		const wall = walls[i]!;
		// 正入射的反射系数是这面墙能给出的上限；为 0 时任何角度都不会有反射。
		if (reflectionPowerRatio(wall, band, 1) <= 0) continue;
		out.push(wall);
		indices.push(i);
	}
	return { walls: out, wallIndices: indices };
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
