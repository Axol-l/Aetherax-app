/**
 * 用一条量出来的线做标定
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
 */
export function wupmFromSegment(segment: CalibrationSegment, realMetres: number): number | null {
	if (!Number.isFinite(realMetres) || realMetres <= 0) return null;
	const world = segmentLengthWorld(segment);
	if (!Number.isFinite(world) || world < 1) return null;
	return world / realMetres;
}

/**
 * 按给定比例反算线段代表多少米
 */
export function segmentLengthMetres(segment: CalibrationSegment, wupm: number): number | null {
	if (!Number.isFinite(wupm) || wupm <= 0) return null;
	const world = segmentLengthWorld(segment);
	if (world <= 0) return null;
	return world / wupm;
}
