/**
 * 规划区域：用户亲手指出这一层到底在哪。
 *
 * 「室内」原本靠墙线掩码填充猜出来，真实图纸上两个方向都会错：门洞开得宽的房间里会被判成室外，
 * 两条墙线之间的墙腔反而被判成室内。所以允许用户自己画；自动识别仍是默认，但画了就以多边形为准，
 * 告警、放置和优化器范围都看它。坐标是世界坐标，少于三个点一律当没有。
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
 * 判断点是否在多边形内（奇偶规则，世界坐标）。
 *
 * 用射线法而不是绕数法：大家画的区域都是简单闭合环，奇偶规则结果一样，还不用管顶点顺序。
 *
 * 正好落在边上的点可能判里也可能判外——边界线两侧都说得过去，判错的代价只是告警里差一个像素。
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
 * 把室内掩码和规划区域求交，就地改。
 *
 * 掩码本身已经是应用的适用范围——墙排除了、中空也挖掉了——这里只留下用户画的那部分。
 * worker 两侧都会调，用的是同一个多边形按掩码像素表示，这样优化器和应用的检查不会各说各话。
 *
 * 返回留下的像素数，调用方在「什么都不剩」时就报这个数。
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
