/**
 * 用一条量出来的线做标定，而不是填面积。
 *
 * 按面积算要拿检测出的轮廓去除总面积，轮廓不准结果就不准，也判断不了图纸画得正不正；
 * 量线问的是图上能直接读出的尺寸（这面墙 12 米），轮廓没闭合或只画了一个房间时也只有这条路能走。
 * 掩码像素就是世界单位，所以比例 = 线段像素数 / 实际米数。
 */

/** 量出的线段两端，用世界坐标。 */
export interface CalibrationSegment {
	a: { x: number; y: number };
	b: { x: number; y: number };
}

/** 线段的世界长度（掩码像素）；退化线段返回 0。 */
export function segmentLengthWorld(segment: CalibrationSegment): number {
	const dx = segment.b.x - segment.a.x;
	const dy = segment.b.y - segment.a.y;
	return Math.hypot(dx, dy);
}

/**
 * 由量出的线段换算出 wupm（世界坐标单位每米）。
 *
 * 两种情况都返回 null 而不是 Infinity，让调用方自己报错：线段没有长度就无从定比例，实际长度为 0 会除爆。
 */
export function wupmFromSegment(segment: CalibrationSegment, realMetres: number): number | null {
	if (!Number.isFinite(realMetres) || realMetres <= 0) return null;
	const world = segmentLengthWorld(segment);
	if (!Number.isFinite(world) || world < 1) return null;
	return world / realMetres;
}

/**
 * 按给定比例反算线段代表多少米，用于用户确认前先给他看画了多长。
 */
export function segmentLengthMetres(segment: CalibrationSegment, wupm: number): number | null {
	if (!Number.isFinite(wupm) || wupm <= 0) return null;
	const world = segmentLengthWorld(segment);
	if (world <= 0) return null;
	return world / wupm;
}
