/**
 * Height-only collapse for an inline fold.
 *
 * Svelte's `slide` also animates opacity and the element's padding, which on a short row
 * reads as the content shrinking rather than a section unfolding. This animates the height
 * alone, so the row below slides down as the fold opens. Reduced motion gives a duration of
 * 0, which makes the fold instant.
 */
export function collapseHeight(
	node: HTMLElement,
	{ duration = 180 }: { duration?: number } = {}
): { duration: number; css: (t: number) => string } {
	const target = node.scrollHeight;
	return {
		duration,
		css: (t) => `overflow: hidden; height: ${target * t}px;`
	};
}
