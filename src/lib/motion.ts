/**
 * Motion that respects the operating system's reduced-motion preference.
 *
 * The CSS button press is disabled by a media query; Svelte transitions are JavaScript and
 * need the value here. A zero duration still runs the transition's cleanup, so the dialog
 * closes on the same tick in tests and for users who ask for less motion.
 */
export function motionDuration(milliseconds: number): number {
	if (typeof window === 'undefined') return 0;
	return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : milliseconds;
}
