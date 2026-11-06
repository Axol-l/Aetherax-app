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
	let kept = 0;
	for (let y = 0; y < height; y++) {
		const worldY = originY + y;
		for (let x = 0; x < width; x++) {
			const index = y * width + x;
			if (!interior[index]) continue;
			if (!pointInPlanningArea({ x: originX + x, y: worldY }, area)) {
				interior[index] = 0;
				continue;
			}
			kept++;
		}
	}
	return kept;
}
