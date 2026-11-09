import { describe, expect, it } from 'vitest';
import {
	cAdd,
	cFromPower,
	cMul,
	cPower,
	emptyPolarized,
	pathPhase,
	sinrDb
} from './field.js';

describe('complex field primitives', () => {
	it('round-trips power through amplitude and phase', () => {
		const field = cFromPower(0.25, Math.PI / 2);
		expect(cPower(field)).toBeCloseTo(0.25, 9);
		expect(field.im).toBeCloseTo(0.5, 9);
	});

	it('adds and multiplies complex values', () => {
		const sum = cAdd({ re: 1, im: 2 }, { re: 3, im: -1 });
		expect(sum).toEqual({ re: 4, im: 1 });
		const product = cMul({ re: 0, im: 1 }, { re: 0, im: 1 });
		expect(product.re).toBeCloseTo(-1, 9);
	});

	it('produces a negative propagation phase', () => {
		expect(pathPhase(1, 5e9)).toBeLessThan(0);
		expect(emptyPolarized().vertical.re).toBe(0);
	});

	it('computes SINR from signal, interference and noise', () => {
		// 0.5 mW signal against 0 dBm (1 mW) noise => -3.01 dB.
		expect(sinrDb(0.5, 0, 0)).toBeCloseTo(-3.0103, 3);
		expect(sinrDb(0, 1, -100)).toBe(-Infinity);
	});
});
