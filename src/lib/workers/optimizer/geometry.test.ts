import { describe, expect, it } from 'vitest';
import { GeometryCache } from './geometry.js';

/*
 * What the worker has been sent, and what it is allowed to answer with.
 *
 * A run's payload is mostly geometry — tens of megabytes of masks on a real plan — and one
 * floor's geometry does not change between its restarts or between the passes of an all-floor
 * run. Reusing it is worth a lot; reusing it *wrongly* is silent, because a run against another
 * plan's masks produces a layout that looks perfectly believable and is of the wrong floor.
 */

const A = { id: 'a', geometry: { name: 'plan A' } };
const B = { id: 'b', geometry: { name: 'plan B' } };

describe('GeometryCache', () => {
	it('takes the geometry a message carries, and remembers it', () => {
		const cache = new GeometryCache<{ name: string }>();

		expect(cache.resolve(A, 'a', false)).toBe(A.geometry);
		// The next message names it instead of repeating it.
		expect(cache.resolve(null, 'a', true)).toBe(A.geometry);
	});

	it('replaces what it holds when another plan arrives', () => {
		const cache = new GeometryCache<{ name: string }>();
		cache.resolve(A, 'a', false);
		cache.resolve(B, 'b', false);

		expect(cache.resolve(null, 'b', true)).toBe(B.geometry);
		// The old plan is gone: naming it must not hand back the new one.
		expect(cache.resolve(null, 'a', true)).toBeNull();
	});

	it('refuses a message that names a plan it does not hold', () => {
		const cache = new GeometryCache<{ name: string }>();

		// The case this exists for: the bridge believed a worker was loaded, and the worker is a
		// new one that has been sent nothing.
		expect(cache.resolve(null, 'a', true)).toBeNull();

		cache.resolve(A, 'a', false);
		expect(cache.resolve(null, 'b', true)).toBeNull();
	});

	it('refuses a message that carries no plan and asks for none', () => {
		const cache = new GeometryCache<{ name: string }>();
		cache.resolve(A, 'a', false);

		// No geometry, no claim that any is loaded: refusing is what turns a caller's bug into
		// an error instead of a run on stale masks.
		expect(cache.resolve(null, 'a', false)).toBeNull();
		expect(cache.resolve(null, undefined, true)).toBe(A.geometry);
	});
});
