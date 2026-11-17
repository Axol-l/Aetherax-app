import { describe, it, expect } from 'vitest';
import { channelsInterfere, overlapFraction } from '../src/overlap.js';
import { CHANNELS_2_4GHZ } from '../src/bands/band-2_4ghz.js';
import { CHANNELS_5GHZ } from '../src/bands/band-5ghz.js';
import { CHANNELS_6GHZ } from '../src/bands/band-6ghz.js';

function ch24(num: number) {
	const found = CHANNELS_2_4GHZ.find((c) => c.number === num);
	if (!found) throw new Error(`Channel ${num} not found`);
	return found;
}

function ch5(num: number) {
	const found = CHANNELS_5GHZ.find((c) => c.number === num);
	if (!found) throw new Error(`Channel ${num} not found`);
	return found;
}

describe('channelsInterfere', () => {
	it('2.4 GHz ch1 and ch6 do NOT interfere at 20 MHz', () => {
		expect(channelsInterfere(ch24(1), ch24(6), 20, 20)).toBe(false);
	});

	it('2.4 GHz ch1 and ch2 DO interfere at 20 MHz', () => {
		expect(channelsInterfere(ch24(1), ch24(2), 20, 20)).toBe(true);
	});

	it('2.4 GHz ch1 and ch5 DO interfere at 20 MHz (within 4)', () => {
		expect(channelsInterfere(ch24(1), ch24(5), 20, 20)).toBe(true);
	});

	it('5 GHz ch36 and ch40 DO interfere at 40 MHz', () => {
		expect(channelsInterfere(ch5(36), ch5(40), 40, 40)).toBe(true);
	});

	it('5 GHz ch36 and ch40 do NOT interfere at 20 MHz', () => {
		expect(channelsInterfere(ch5(36), ch5(40), 20, 20)).toBe(false);
	});

	it('same channel always interferes', () => {
		expect(channelsInterfere(ch24(1), ch24(1), 20, 20)).toBe(true);
		expect(channelsInterfere(ch5(36), ch5(36), 20, 20)).toBe(true);
	});
});

function ch6(num: number) {
	const found = CHANNELS_6GHZ.find((c) => c.number === num);
	if (!found) throw new Error(`Channel ${num} not found`);
	return found;
}

describe('overlapFraction', () => {
	it('is 1 for the same channel, at any width', () => {
		expect(overlapFraction(ch24(1), ch24(1), 20, 20)).toBe(1);
		expect(overlapFraction(ch5(36), ch5(36), 80, 80)).toBe(1);
		expect(overlapFraction(ch5(36), ch5(36), 160, 160)).toBe(1);
	});

	it('is 0 for channels that do not share spectrum, even at the same number across bands', () => {
		expect(overlapFraction(ch24(1), ch24(11), 20, 20)).toBe(0);
		expect(overlapFraction(ch5(36), ch5(40), 20, 20)).toBe(0);
		// 6 GHz channel 1 and 2.4 GHz channel 1 are different spectrum entirely.
		expect(overlapFraction(ch6(1), ch24(1), 20, 20)).toBe(0);
	});

	it('grades a partial overlap of equal widths by the shared bandwidth', () => {
		// 2.4 GHz channels are 5 MHz apart with 20 MHz width: 1 and 4 share 5 MHz.
		expect(overlapFraction(ch24(1), ch24(4), 20, 20)).toBeCloseTo(0.25, 6);
		expect(overlapFraction(ch24(1), ch24(2), 20, 20)).toBeCloseTo(0.75, 6);
		// 5 GHz channels are 20 MHz apart: two 80 MHz channels 20 MHz apart share 60.
		expect(overlapFraction(ch5(36), ch5(40), 80, 80)).toBeCloseTo(0.75, 6);
		expect(overlapFraction(ch5(36), ch5(44), 80, 80)).toBeCloseTo(0.5, 6);
		expect(overlapFraction(ch5(36), ch5(48), 80, 80)).toBeCloseTo(0.25, 6);
	});

	it('divides by the narrower width, so a narrow channel inside a wide one is 1', () => {
		// A 20 MHz channel centred inside an 80 MHz one shares all 20 of its own MHz.
		expect(overlapFraction(ch5(40), ch5(36), 20, 80)).toBe(1);
		expect(overlapFraction(ch5(36), ch5(40), 80, 20)).toBe(1);
		// Two 40 MHz channels 20 MHz apart share 20 of their 40.
		expect(overlapFraction(ch5(36), ch5(40), 40, 40)).toBeCloseTo(0.5, 6);
	});

	it('can be 0 where channelsInterfere says yes: the graph is the stricter rule', () => {
		// 2.4 GHz 1 and 5 have touching 20 MHz intervals — no shared spectrum — but
		// the planner's binary rule treats a 5 MHz-spaced pair as interfering. That
		// direction is safe: the planner avoids a pair the measurement calls clean.
		expect(overlapFraction(ch24(1), ch24(5), 20, 20)).toBe(0);
		expect(channelsInterfere(ch24(1), ch24(5), 20, 20)).toBe(true);
	});

	it('is symmetric', () => {
		expect(overlapFraction(ch5(36), ch5(44), 80, 40)).toBe(
			overlapFraction(ch5(44), ch5(36), 40, 80)
		);
	});
});
