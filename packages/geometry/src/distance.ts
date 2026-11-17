// 提供距离计算

import type { Point } from './types.js';

// 两点之间的欧几里得距离
export function euclidean(a: Point, b: Point): number {
	return Math.sqrt(squaredEuclidean(a, b));
}

// 距离平方，通常用于只比较远近时，性能更好
export function squaredEuclidean(a: Point, b: Point): number {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	return dx * dx + dy * dy;
}

// 点到线段的最短距离
export function pointToSegment(p: Point, a: Point, b: Point): number {
	const abx = b.x - a.x;
	const aby = b.y - a.y;
	const lengthSq = abx * abx + aby * aby;

	if (lengthSq === 0) {
		return euclidean(p, a);
	}

	const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lengthSq));
	const proj: Point = {
		x: a.x + t * abx,
		y: a.y + t * aby
	};

	return euclidean(p, proj);
}
