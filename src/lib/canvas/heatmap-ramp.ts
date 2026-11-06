/**
 * 界面用于表示信号强度的色阶：热力图底色与接入点面板的天线柱共用，避免两处各自维护而出现偏差。
 * 弱端为红，经橙、黄过渡到强端的绿；alpha 列用于淡出弱端，需要纯色时忽略它。
 */
export type RampColor = { r: number; g: number; b: number; a: number };

/** 位置 0-1、红、绿、蓝、alpha；位置必须递增。 */
export const RAMP_STOPS: ReadonlyArray<readonly [number, number, number, number, number]> = [
	[0.0, 100, 35, 35, 0],
	[0.15, 220, 120, 20, 115],
	[0.35, 210, 190, 30, 102],
	[0.55, 130, 190, 60, 94],
	[0.75, 80, 170, 80, 89],
	[1.0, 40, 150, 40, 89]
];

/**
 * 取 0-1 位置处的色阶颜色，在相邻色标之间插值，超出范围时取端点值。
 */
export function rampColorAt(ratio: number): RampColor {
	const position = Number.isFinite(ratio) ? Math.min(Math.max(ratio, 0), 1) : 0;
	for (let s = 1; s < RAMP_STOPS.length; s++) {
		const lo = RAMP_STOPS[s - 1]!;
		const hi = RAMP_STOPS[s]!;
		if (position <= hi[0]) {
			const t = (position - lo[0]) / (hi[0] - lo[0]);
			return {
				r: lo[1] + t * (hi[1] - lo[1]),
				g: lo[2] + t * (hi[2] - lo[2]),
				b: lo[3] + t * (hi[3] - lo[3]),
				a: lo[4] + t * (hi[4] - lo[4])
			};
		}
	}
	const last = RAMP_STOPS[RAMP_STOPS.length - 1]!;
	return { r: last[1], g: last[2], b: last[3], a: last[4] };
}

/** 同一颜色以 CSS 颜色字符串表示，供 SVG 绘制使用。 */
export function rampCss(ratio: number, alpha = 1): string {
	const c = rampColorAt(ratio);
	return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${alpha})`;
}
