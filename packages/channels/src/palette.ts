import type { Band } from './types.js';

/**
 * The colour every access point is drawn in.
 *
 * Green, and one colour for all of them: the channel is already on the marker as a number,
 * and colouring by channel would make the marker compete with the heatmap underneath it —
 * which is where colour carries a real reading. The function keeps its signature because
 * callers ask "what colour is this AP", not "what colour is this AP's channel".
 *
 * It used to return the pre-citrus brand cyan (`#00d4ff`), which was the last hard-coded
 * copy of the old palette in the tree — the components were swept when the accent moved,
 * this package was not.
 */
export function channelColor(_channelNumber: number, _band: Band): string {
	return '#22c55e';
}
