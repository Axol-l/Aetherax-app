/** 射线与线段的交叉：矢量模型的穿墙损耗。 */
import type { Band } from '@aetherax/channels';
import { getFlatAttenuation, type WallMaterialId } from '$lib/domain/materials.js';

export interface WallSegment {
	ax: number;
	ay: number;
	bx: number;
	by: number;
	material: number;
	/** 由 `rayWallCrossings` 填入，便于调用方识别命中的墙。 */
	id?: string;
}

export interface WallCrossing {
	wall: WallSegment;
	/** 沿射线的位置，`from` 处为 0，`to` 处为 1。 */
	t: number;
	x: number;
	y: number;
}

/**
 * 射线与一条线段的交点，无交点时返回 null。
 * 采用参数化求交，并在线段与射线两端各留容差，使恰好落在端点上的接触也算命中。
 */
export function raySegmentIntersection(
	from: { x: number; y: number },
	to: { x: number; y: number },
	wall: WallSegment
): WallCrossing | null {
	const rx = to.x - from.x;
	const ry = to.y - from.y;
	const sx = wall.bx - wall.ax;
	const sy = wall.by - wall.ay;

	const denominator = rx * sy - ry * sx;
	// 平行则无交点；共线重叠也不算交点，沿墙行进的射线并不穿过墙。
	if (Math.abs(denominator) < 1e-12) return null;

	const qpx = wall.ax - from.x;
	const qpy = wall.ay - from.y;

	const t = (qpx * sy - qpy * sx) / denominator;
	const u = (qpx * ry - qpy * rx) / denominator;

	// `u` 落在 [0, 1] 表示位于线段上，`t` 落在 [0, 1] 表示位于射线两端之间；两者都留少量容差，使端点命中算命中。
	const margin = 1e-9;
	if (t < -margin || t > 1 + margin) return null;
	if (u < -margin || u > 1 + margin) return null;

	return {
		wall,
		t: Math.min(1, Math.max(0, t)),
		x: from.x + rx * t,
		y: from.y + ry * t
	};
}

/** 射线穿过的所有墙，由近到远排序。 */
export function rayWallCrossings(
	from: { x: number; y: number },
	to: { x: number; y: number },
	walls: readonly WallSegment[]
): WallCrossing[] {
	const out: WallCrossing[] = [];
	for (const wall of walls) {
		const hit = raySegmentIntersection(from, to, wall);
		if (hit) out.push(hit);
	}
	out.sort((a, b) => a.t - b.t);
	return out;
}

/**
 * 射线沿途的墙体总损耗，单位 dB。
 * 每个交点按其材质对应的损耗计一次。
 */
export function rayWallLossDb(
	from: { x: number; y: number },
	to: { x: number; y: number },
	walls: readonly WallSegment[],
	band: Band,
	skipIndices: readonly number[] = []
): number {
	const skip = new Set(skipIndices);
	let total = 0;
	for (let i = 0; i < walls.length; i++) {
		if (skip.has(i)) continue;
		const hit = raySegmentIntersection(from, to, walls[i]!);
		if (hit) total += getFlatAttenuation(hit.wall.material as WallMaterialId, band);
	}
	return total;
}

/** 交点及其对应损耗，供需要展示计算过程的报告使用。 */
export function rayWallBreakdown(
	from: { x: number; y: number },
	to: { x: number; y: number },
	walls: readonly WallSegment[],
	band: Band
): Array<{ wall: WallSegment; at: number; db: number }> {
	return rayWallCrossings(from, to, walls).map((hit) => ({
		wall: hit.wall,
		at: hit.t,
		db: getFlatAttenuation(hit.wall.material as WallMaterialId, band)
	}));
}
