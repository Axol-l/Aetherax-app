/**
 * 柱子的直射路径穿透损耗。
 *
 * 墙体走栅格掩码的“一次材质穿越”，柱子有真实矩形/圆形几何。这里按射线在柱子
 * 内的实际弦长和入射角给出损耗，再扣除栅格已经计过的一次材质损耗，得到修正量。
 */
import type { Band } from '@aetherax/channels';
import { getMaterial, getWallLossDbAtAngle, type WallMaterialId } from '$lib/domain/materials.js';

export interface ColumnObstacle {
	shape: 'rect' | 'circle';
	ax: number;
	ay: number;
	bx: number;
	by: number;
	material: number;
}

export interface ColumnCrossing {
	material: number;
	/** 射线在柱内走过的世界长度。 */
	chord: number;
	/** 入射角余弦，1 为正入射。 */
	cosTheta: number;
}

const EPSILON = 1e-9;

function rectCrossing(
	column: ColumnObstacle,
	from: { x: number; y: number },
	dx: number,
	dy: number,
	length: number
): { t0: number; t1: number; cosTheta: number } | null {
	const minX = Math.min(column.ax, column.bx);
	const maxX = Math.max(column.ax, column.bx);
	const minY = Math.min(column.ay, column.by);
	const maxY = Math.max(column.ay, column.by);
	let enter = -Infinity;
	let exit = Infinity;
	const axes: Array<[number, number, number, number]> = [
		[from.x, dx, minX, maxX],
		[from.y, dy, minY, maxY]
	];
	for (const [origin, direction, min, max] of axes) {
		if (Math.abs(direction) < EPSILON) {
			if (origin < min || origin > max) return null;
			continue;
		}
		const t1 = (min - origin) / direction;
		const t2 = (max - origin) / direction;
		enter = Math.max(enter, Math.min(t1, t2));
		exit = Math.min(exit, Math.max(t1, t2));
	}
	if (!Number.isFinite(enter) || !Number.isFinite(exit)) return null;
	// The segment is [0, 1]; an interval entirely before or after it is a miss.
	if (enter > 1 || exit < 0) return null;
	const entry = Math.max(0, enter);
	const finalExit = Math.min(1, exit);
	if (finalExit <= entry) return null;
	const px = from.x + dx * entry;
	const py = from.y + dy * entry;
	const distanceToLeft = Math.abs(px - minX);
	const distanceToRight = Math.abs(maxX - px);
	const distanceToTop = Math.abs(py - minY);
	const distanceToBottom = Math.abs(maxY - py);
	const nearest = Math.min(distanceToLeft, distanceToRight, distanceToTop, distanceToBottom);
	let nx = 0;
	let ny = 0;
	if (nearest === distanceToLeft) nx = -1;
	else if (nearest === distanceToRight) nx = 1;
	else if (nearest === distanceToTop) ny = -1;
	else ny = 1;
	const cosTheta = Math.abs((dx / length) * nx + (dy / length) * ny);
	return { t0: entry, t1: finalExit, cosTheta };
}

function circleCrossing(
	column: ColumnObstacle,
	from: { x: number; y: number },
	dx: number,
	dy: number,
	length: number
): { t0: number; t1: number; cosTheta: number } | null {
	const cx = column.ax;
	const cy = column.ay;
	const radius = Math.hypot(column.bx - column.ax, column.by - column.ay);
	if (!(radius > 0)) return null;
	const ox = from.x - cx;
	const oy = from.y - cy;
	const a = dx * dx + dy * dy;
	const b = 2 * (ox * dx + oy * dy);
	const c = ox * ox + oy * oy - radius * radius;
	const discriminant = b * b - 4 * a * c;
	if (discriminant <= 0 || a < EPSILON) return null;
	const root = Math.sqrt(discriminant);
	const t1 = (-b - root) / (2 * a);
	const t2 = (-b + root) / (2 * a);
	const entry = Math.max(0, Math.min(t1, t2));
	const exit = Math.min(1, Math.max(t1, t2));
	if (exit <= entry) return null;
	const px = from.x + dx * entry;
	const py = from.y + dy * entry;
	let nx = (px - cx) / radius;
	let ny = (py - cy) / radius;
	const normalLength = Math.hypot(nx, ny);
	if (normalLength < EPSILON) return null;
	nx /= normalLength;
	ny /= normalLength;
	const cosTheta = Math.abs((dx / length) * nx + (dy / length) * ny);
	return { t0: entry, t1: exit, cosTheta };
}

/** 射线与柱子的所有交点，按世界弦长返回。 */
export function columnCrossings(
	columns: readonly ColumnObstacle[],
	from: { x: number; y: number },
	to: { x: number; y: number }
): ColumnCrossing[] {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const length = Math.hypot(dx, dy);
	if (!(length > EPSILON)) return [];
	const out: ColumnCrossing[] = [];
	for (const column of columns) {
		const hit =
			column.shape === 'circle'
				? circleCrossing(column, from, dx, dy, length)
				: rectCrossing(column, from, dx, dy, length);
		if (!hit) continue;
		out.push({
			material: column.material,
			chord: (hit.t1 - hit.t0) * length,
			cosTheta: hit.cosTheta
		});
	}
	return out;
}

/**
 * 栅格墙损已经按“一次材质穿越”计过柱子；这里返回把柱子替换成实际弦长/入射角
 * 后的差值。调用方直接加到 wallRunLoss 上即可。
 */
export function columnLossDelta(
	columns: readonly ColumnObstacle[],
	from: { x: number; y: number },
	to: { x: number; y: number },
	band: Band,
	materialDb: readonly number[],
	wupm: number
): number {
	if (columns.length === 0 || !(wupm > 0)) return 0;
	const hits = columnCrossings(columns, from, to);
	let delta = 0;
	for (const hit of hits) {
		const materialId = hit.material as WallMaterialId;
		const material = getMaterial(materialId);
		const thickness = material.typicalThickness;
		if (!(thickness > 0)) continue;
		const base = materialDb[hit.material] ?? getWallLossDbAtAngle(materialId, band, 1);
		const chordM = hit.chord / wupm;
		const desired =
			getWallLossDbAtAngle(materialId, band, hit.cosTheta) * (chordM / thickness);
		delta += desired - base;
	}
	return delta;
}
