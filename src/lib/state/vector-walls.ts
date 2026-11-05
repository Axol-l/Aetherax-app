/**
 * 把墙表示成线段——应用正在过渡到的模型。
 *
 * 以前墙是像素带，空心墙、缝被当房间、开口被当室外这些问题都从那儿来；线段没有「内部」，
 * 射线要么穿过要么不穿。这里只有模型和让画墙手感正常的几何（吸附、锁轴），不碰栅格那套。
 */
import type { WallMaterialId } from '$lib/domain/materials.js';

export interface VectorWall {
	id: string;
	ax: number;
	ay: number;
	bx: number;
	by: number;
	material: WallMaterialId;
	/** 墙高出地面的高度，单位米。不填就取楼层的层高。 */
	heightM?: number;
}

export interface VectorColumn {
	id: string;
	/**
	 * 墙墩用矩形，圆柱用圆形。两者都是障碍：柱子投的影子和墙一样，所以它们会被栅格化进
	 * 传播读的掩码里，而不是只画个样子。
	 */
	shape: 'rect' | 'circle';
	/** 矩形的两个对角；圆形时 `a` 是圆心、`b` 是圆周上一点。 */
	ax: number;
	ay: number;
	bx: number;
	by: number;
	material: WallMaterialId;
}

export interface Point {
	x: number;
	y: number;
}

/** 点击离端点多少屏幕像素内就吸附过去。 */
export const SNAP_PX = 12;

/** 墙的长度，世界坐标单位。 */
export function wallLength(wall: VectorWall): number {
	return Math.hypot(wall.bx - wall.ax, wall.by - wall.ay);
}

/**
 * 把点吸附到 `tolerance` 范围内最近的端点，单位是世界坐标。
 *
 * 吸附是图纸能严丝合缝的关键：两面墙只是*差不多*接上，中间就有一条射线能钻的缝，模型里的
 * 表现和图纸上看到的不一样。容差传世界坐标单位，调用方可以按缩放换算，保证屏幕上看着一样。
 */
export function snapToEndpoint(
	point: Point,
	walls: readonly VectorWall[],
	tolerance: number
): Point {
	let best: Point = point;
	let bestDistance = tolerance;
	for (const wall of walls) {
		for (const end of [
			{ x: wall.ax, y: wall.ay },
			{ x: wall.bx, y: wall.by }
		]) {
			const distance = Math.hypot(end.x - point.x, end.y - point.y);
			if (distance <= bestDistance) {
				best = end;
				bestDistance = distance;
			}
		}
	}
	return best;
}

/**
 * 线段接近水平或垂直时，把它锁到坐标轴上——画平面图几乎总是想要这个。
 *
 * 判断用的是*比例*，不是角度：100 px 长的墙偏 3 px 值得锁，10 px 长的墙偏同样 3 px 就是
 * 根斜线了。
 */
export function lockToAxis(from: Point, to: Point, ratio = 0.12): Point {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	if (dx === 0 && dy === 0) return to;
	if (Math.abs(dy) <= Math.abs(dx) * ratio) return { x: to.x, y: from.y };
	if (Math.abs(dx) <= Math.abs(dy) * ratio) return { x: from.x, y: to.y };
	return to;
}

/**
 * 任意墙上的最近点——可以是端点，也可以是线身任意位置。
 *
 * 只吸端点，平面图里最常见的一个动作就做不了：把隔断插到另一面墙*中间*（T 形接头）。那样
 * 图纸上看着是接上的，模型里却有条缝，正是这套模型要消灭的那类 bug。所以点会吸到够得着的
 * 任意墙，而「端点」和「线身」都近时取更近的那个。
 *
 * 返回类型是给图纸提示用的，说明吸到的是哪一种。
 */
export function snapToWalls(
	point: Point,
	walls: readonly VectorWall[],
	tolerance: number
): { point: Point; kind: 'endpoint' | 'edge' } {
	let best: Point = point;
	let bestDistance = tolerance;
	let kind: 'endpoint' | 'edge' = 'edge';

	// 先看端点：两面墙在拐角相接时应该吸到拐角，而不是某条边的最近点。
	for (const wall of walls) {
		for (const end of [
			{ x: wall.ax, y: wall.ay },
			{ x: wall.bx, y: wall.by }
		]) {
			const distance = Math.hypot(end.x - point.x, end.y - point.y);
			if (distance <= bestDistance) {
				best = end;
				bestDistance = distance;
				kind = 'endpoint';
			}
		}
	}

	// 再看线身：长墙上它可能比两端都近。
	for (const wall of walls) {
		const dx = wall.bx - wall.ax;
		const dy = wall.by - wall.ay;
		const lengthSquared = dx * dx + dy * dy;
		if (lengthSquared === 0) continue;
		let t = ((point.x - wall.ax) * dx + (point.y - wall.ay) * dy) / lengthSquared;
		t = Math.max(0, Math.min(1, t));
		const candidate = { x: wall.ax + t * dx, y: wall.ay + t * dy };
		const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y);
		// 必须严格更近，这样同样距离下找到的端点仍然优先。
		if (distance < bestDistance) {
			best = candidate;
			bestDistance = distance;
			kind = 'edge';
		}
	}

	return { point: best, kind };
}

/** 点到线段的距离，用来按点击位置选墙。 */
export function distanceToSegment(point: Point, wall: VectorWall): number {
	const dx = wall.bx - wall.ax;
	const dy = wall.by - wall.ay;
	const lengthSquared = dx * dx + dy * dy;
	if (lengthSquared === 0) return Math.hypot(point.x - wall.ax, point.y - wall.ay);
	let t = ((point.x - wall.ax) * dx + (point.y - wall.ay) * dy) / lengthSquared;
	t = Math.max(0, Math.min(1, t));
	return Math.hypot(point.x - (wall.ax + t * dx), point.y - (wall.ay + t * dy));
}

/** `tolerance` 范围内离 `point` 最近的墙，没有就返回 null。 */
export function wallNearPoint(
	point: Point,
	walls: readonly VectorWall[],
	tolerance: number
): VectorWall | null {
	let best: VectorWall | null = null;
	let bestDistance = tolerance;
	for (const wall of walls) {
		const distance = distanceToSegment(point, wall);
		if (distance <= bestDistance) {
			best = wall;
			bestDistance = distance;
		}
	}
	return best;
}

/** 丢掉短于一两个像素的墙：在同一处双击一下就会生成一根。 */
export function isDegenerate(wall: VectorWall, minLength = 2): boolean {
	return wallLength(wall) < minLength;
}

/** 柱的包围盒，世界坐标单位。 */
export function columnBox(column: VectorColumn): {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	width: number;
	height: number;
} {
	const x0 = Math.min(column.ax, column.bx);
	const x1 = Math.max(column.ax, column.bx);
	const y0 = Math.min(column.ay, column.by);
	const y1 = Math.max(column.ay, column.by);
	return { x0, y0, x1, y1, width: x1 - x0, height: y1 - y0 };
}

/** 小到挡不住任何东西的柱：只点一下、没拖动，就会生成一个。 */
export function isDegenerateColumn(column: VectorColumn, minSize = 2): boolean {
	if (column.shape === 'circle') {
		return Math.hypot(column.bx - column.ax, column.by - column.ay) < minSize;
	}
	const { width, height } = columnBox(column);
	return width < minSize && height < minSize;
}

/** 点在哪个柱下面，没有就返回 null。圆看半径，矩形看包围盒。 */
export function columnAtPoint(
	columns: readonly VectorColumn[],
	point: Point
): VectorColumn | null {
	// 后画的优先：两个重叠时，用户刚放下的那个赢。
	for (let i = columns.length - 1; i >= 0; i--) {
		const column = columns[i]!;
		if (column.shape === 'circle') {
			const radius = Math.hypot(column.bx - column.ax, column.by - column.ay);
			if (Math.hypot(point.x - column.ax, point.y - column.ay) <= radius) return column;
			continue;
		}
		const { x0, y0, x1, y1 } = columnBox(column);
		if (point.x >= x0 && point.x <= x1 && point.y >= y0 && point.y <= y1) return column;
	}
	return null;
}
