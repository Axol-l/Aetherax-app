import { describe, expect, it } from 'vitest';
import { makeOverlapLookup, SAME_CHANNEL_OVERLAP } from './channel-overlap.js';

/**
 * The frequency side of the interference model: how much two sources' channels
 * share, given their bands and widths.
 *
 * B3's first stage made the *palette* non-overlapping so that "same number" and
 * "overlaps" were the same question. This is the second stage: the question is
 * answered directly, so a plan pinned or hand-edited onto overlapping channels is
 * measured rather than assumed clean, and a partially overlapping pair is a cost
 * rather than an identity.
 */
describe('channel overlap lookup', () => {
	const five = makeOverlapLookup(['5ghz', '5ghz', '2.4ghz'], [80, 80, 20]);

	it('is 1 for one channel, whatever its width', () => {
		expect(five(0, 36, 1, 36)).toBe(1);
	});

	it('grades two 80 MHz channels by the spectrum they share', () => {
		expect(five(0, 36, 1, 40)).toBeCloseTo(0.75, 6);
		expect(five(0, 36, 1, 44)).toBeCloseTo(0.5, 6);
		expect(five(0, 36, 1, 48)).toBeCloseTo(0.25, 6);
		expect(five(0, 36, 1, 149)).toBe(0);
	});

	it('is 0 across bands, even when the numbers are the same', () => {
		// Source 2 is 2.4 GHz channel 1; 5 GHz has no channel 1 at all, and even a
		// shared number would be 3.5 GHz of spectrum apart.
		expect(five(0, 36, 2, 1)).toBe(0);
		expect(five(2, 1, 0, 36)).toBe(0);
	});

	it('is 0 for a channel number its band does not have', () => {
		// A pin the domain does not permit, or a source with no band: an unknown
		// assignment cannot be shown to be clean, so it contributes nothing.
		expect(five(0, 999, 1, 36)).toBe(0);
		expect(five(0, 36, 1, 999)).toBe(0);
	});

	it('uses the narrower width as the denominator', () => {
		const mixed = makeOverlapLookup(['5ghz', '5ghz'], [20, 80]);
		// The 20 MHz channel sits inside the 80 MHz one: all of its own spectrum.
		expect(mixed(0, 40, 1, 36)).toBe(1);
		// 20 MHz at 48 shares 10 of its 20 MHz with 80 MHz at 40.
		expect(mixed(0, 48, 1, 40)).toBeCloseTo(0.5, 6);
		// And nothing at all with 80 MHz at 36, whose band ends at 5220.
		expect(mixed(0, 48, 1, 36)).toBe(0);
	});

	it('treats a missing width as 20 MHz, the only universally clean width', () => {
		const sparse = makeOverlapLookup(['5ghz', '5ghz'], []);
		expect(sparse(0, 36, 1, 40)).toBe(0);
		expect(sparse(0, 36, 1, 36)).toBe(1);
	});

	it('the pre-stage-two default still rounds to "same number or nothing"', () => {
		expect(SAME_CHANNEL_OVERLAP(0, 36, 1, 40)).toBe(0);
		expect(SAME_CHANNEL_OVERLAP(0, 36, 1, 36)).toBe(1);
	});
});
