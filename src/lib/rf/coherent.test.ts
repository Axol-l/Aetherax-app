import { describe, expect, it } from 'vitest';
import { coherentPower, fieldPower, sumCoherent } from './coherent.js';
import { cPower } from './field.js';

describe('coherent path summation', () => {
	it('adds in-phase paths and cancels opposite-phase paths', () => {
		const inPhase = coherentPower([
			{ power: 1, phase: 0 },
			{ power: 1, phase: 0 }
		]);
		expect(inPhase).toBeCloseTo(4, 9);

		const opposite = coherentPower([
			{ power: 1, phase: 0 },
			{ power: 1, phase: Math.PI }
		]);
		expect(opposite).toBeCloseTo(0, 9);
	});

	it('projects linear polarization onto V/H', () => {
		const field = sumCoherent([{ power: 4, phase: 0, polarizationAngle: Math.PI / 2 }]);
		expect(cPower(field.vertical)).toBeCloseTo(0, 9);
		expect(cPower(field.horizontal)).toBeCloseTo(4, 9);
		expect(fieldPower(field)).toBeCloseTo(4, 9);
	});

	it('applies a complex reflection coefficient', () => {
		const field = sumCoherent([
			{ power: 1, phase: 0, coefficient: { re: 0, im: 1 } }
		]);
		expect(cPower(field.vertical)).toBeCloseTo(1, 9);
	});
});
