import { describe, expect, it } from 'vitest';
import { makeOverlapLookup, SAME_CHANNEL_OVERLAP } from './channel-overlap.js';

/**
 * 干扰模型的频率侧：给定两源的频段与带宽，计算其信道的共享频谱比例。
 *
 * 同信道为 1，部分重叠按共享频谱折算，跨频段或频段内不存在的信道号为 0。
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
		// 源 2 位于 2.4 GHz 频段：跨频段的重叠恒为 0，与信道编号无关。
		expect(five(0, 36, 2, 1)).toBe(0);
		expect(five(2, 1, 0, 36)).toBe(0);
	});

	it('is 0 for a channel number its band does not have', () => {
		// 频段不允许的信道号或缺失频段的源无法证明无重叠，因此贡献为 0。
		expect(five(0, 999, 1, 36)).toBe(0);
		expect(five(0, 36, 1, 999)).toBe(0);
	});

	it('uses the narrower width as the denominator', () => {
		const mixed = makeOverlapLookup(['5ghz', '5ghz'], [20, 80]);
		// 20 MHz 信道完全落在 80 MHz 信道内，共享其全部频谱。
		expect(mixed(0, 40, 1, 36)).toBe(1);
		// 较窄信道只有一半频谱与较宽信道重叠。
		expect(mixed(0, 48, 1, 40)).toBeCloseTo(0.5, 6);
		// 两者频谱完全不相交时为 0。
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
