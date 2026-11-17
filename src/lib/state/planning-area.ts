/**
 * 规划区域
 */

export interface PlanningPoint {
	x: number;
	y: number;
}

export type PlanningArea = PlanningPoint[];

/** 少于这个点数的多边形没法当区域用。 */
export const MIN_PLANNING_POINTS = 3;

/** 这个多边形到底能不能当区域用。 */
export function isUsablePlanningArea(area: PlanningArea | null | undefined): area is PlanningArea {
	return !!area && area.length >= MIN_PLANNING_POINTS;
}

/**
 * 判断点是否在多边形内
 */
export function pointInPlanningArea(point: PlanningPoint, area: PlanningArea): boolean {
	if (!isUsablePlanningArea(area)) return false;
	let inside = false;
	for (let i = 0, j = area.length - 1; i < area.length; j = i++) {
		const a = area[i]!;
		const b = area[j]!;
		const straddles = a.y > point.y !== b.y > point.y;
		if (!straddles) continue;
		const x = a.x + ((point.y - a.y) / (b.y - a.y)) * (b.x - a.x);
		if (point.x < x) inside = !inside;
	}
	return inside;
}

/**
 * 把室内掩码和规划区域求交
 *
 * 按扫描线逐行处理，而不是对每个像素调用 `pointInPlanningArea`：一张 800×836 的掩码有
 * 六十多万个像素，而 `area` 常常是 `$state` 代理，逐像素读它的点会为每个像素付出几十次代理
 * 读取，一次裁剪能拖到几秒。这里先把多边形抄成普通数组，每行只求一次交点，再按奇偶规则扫过。
 */
export function clipInteriorToPlanningArea(
	interior: Uint8Array,
	width: number,
	height: number,
	originX: number,
	originY: number,
	area: PlanningArea
): number {
	if (!isUsablePlanningArea(area)) {
		let kept = 0;
		for (let i = 0; i < interior.length; i++) if (interior[i]) kept++;
		return kept;
	}

	const count = area.length;
	const xs = new Float64Array(count);
	const ys = new Float64Array(count);
	let minY = Infinity;
	let maxY = -Infinity;
	for (let i = 0; i < count; i++) {
		const point = area[i]!;
		xs[i] = point.x;
		ys[i] = point.y;
		if (point.y < minY) minY = point.y;
		if (point.y > maxY) maxY = point.y;
	}

	const crossings: number[] = [];
	let kept = 0;
	for (let y = 0; y < height; y++) {
		const worldY = originY + y;
		const row = y * width;
		crossings.length = 0;
		// 多边形高度之外的扫描线不会与任何边相交，整行都在区域外。
		if (worldY >= minY && worldY <= maxY) {
			for (let i = 0, j = count - 1; i < count; j = i++) {
				if (ys[i]! > worldY === ys[j]! > worldY) continue;
				crossings.push(xs[i]! + ((worldY - ys[i]!) / (ys[j]! - ys[i]!)) * (xs[j]! - xs[i]!));
			}
			crossings.sort((a, b) => a - b);
		}
		/*
		 * 与 `pointInPlanningArea` 同一套奇偶规则：点在区域内，当且仅当它右侧的交点数为奇数。
		 * 从左向右扫时每越过一个交点就翻转一次；行首左侧的交点数就是全部交点数。
		 */
		let inside = (crossings.length & 1) === 1;
		let next = 0;
		for (let x = 0; x < width; x++) {
			const worldX = originX + x;
			while (next < crossings.length && crossings[next]! <= worldX) {
				inside = !inside;
				next++;
			}
			const index = row + x;
			if (!interior[index]) continue;
			if (inside) kept++;
			else interior[index] = 0;
		}
	}
	return kept;
}
