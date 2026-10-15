/**
 * The colour ramp the interface uses for signal strength.
 *
 * It lives on its own because two very different drawings now speak with it: the heatmap
 * paints the floor with it, and the access point panel's antenna bars are coloured by it.
 * A second copy of these stops would drift, and then the panel would be describing the
 * same radio in a different language from the map it sits next to.
 *
 * The stops are the heatmap's own, moved here unchanged: cold red at the weak end,
 * through orange and yellow, to green where the signal is strong. The alpha column is the
 * heatmap's too — it fades the bottom of the ramp out rather than colouring it — so a
 * caller that wants a solid colour reads the red/green/blue part and ignores it.
 */
export type RampColor = { r: number; g: number; b: number; a: number };

/** Position 0-1, red, green, blue, alpha. The positions must ascend. */
export const RAMP_STOPS: ReadonlyArray<readonly [number, number, number, number, number]> = [
	[0.0, 100, 35, 35, 0],
	[0.15, 220, 120, 20, 115],
	[0.35, 210, 190, 30, 102],
	[0.55, 130, 190, 60, 94],
	[0.75, 80, 170, 80, 89],
	[1.0, 40, 150, 40, 89]
];

/**
 * The ramp's colour at a 0-1 position, interpolated between the two stops it falls
 * between and clamped outside them.
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

/** The same colour as a CSS `rgb()`, for the drawings that are SVG rather than pixels. */
export function rampCss(ratio: number, alpha = 1): string {
	const c = rampColorAt(ratio);
	return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${alpha})`;
}
