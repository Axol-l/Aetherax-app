/**
 * A signature for a mask *object*, for cache invalidation.
 *
 * Every consumer here caches derived work — the heatmap's attenuation field, the decoded
 * interior, the coloured wall raster — and every one of those caches used to key on things
 * that do not change when the mask's *content* does: its width, its height, its origin, a
 * counter somebody has to remember to bump. Replacing a floor's mask with one of the same
 * size therefore left every consumer showing the previous geometry, which looks exactly like
 * a broken drag.
 *
 * The object identity is the honest signal: every path that changes a mask assigns a new
 * object (`wallState.wallMask = {...}`), including undo and detection, and none of them
 * mutate a mask in place. A WeakMap turns that identity into a string, so a cache key can
 * carry it without keeping the mask alive.
 *
 * The rule this encodes, for the next person: **anything that writes a mask hands out a new
 * object, and nothing may rely on a version counter to notice.**
 */
const signatures = new WeakMap<object, string>();
let next = 0;

export function maskSignature(mask: object | null | undefined): string {
	if (!mask) return 'none';
	const existing = signatures.get(mask);
	if (existing !== undefined) return existing;
	const signature = `m${++next}`;
	signatures.set(mask, signature);
	return signature;
}
