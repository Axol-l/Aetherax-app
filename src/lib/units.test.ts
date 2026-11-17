/**
 * The unit layer is small and every error it can make is a silently wrong number
 * in a panel, so it is checked rather than eyeballed: the conversions are exact
 * in both directions, and the rounding rule is pinned so a later "just show more
 * decimals" change has to be a deliberate one.
 */
import { describe, expect, it } from 'vitest';
import {
	areaUnit,
	convertArea,
	convertLength,
	displayArea,
	displayLength,
	displayDecimals,
	formatMeasure,
	lengthInputHints,
	lengthUnit,
	roundForDisplay,
	sqmToUnit,
	unitToMetres,
	unitToSqm
} from './units.js';

describe('unit selection', () => {
	it('maps a unit system onto its units', () => {
		expect(lengthUnit('imperial')).toBe('ft');
		expect(lengthUnit('metric')).toBe('m');
		expect(areaUnit('imperial')).toBe('sqft');
		expect(areaUnit('metric')).toBe('sqm');
	});
});

describe('conversion', () => {
	it('converts lengths both ways', () => {
		expect(convertLength(1, 'm', 'ft')).toBeCloseTo(3.2808, 3);
		expect(convertLength(3.280839895013123, 'ft', 'm')).toBeCloseTo(1, 9);
		expect(convertLength(5, 'm', 'm')).toBe(5);
	});

	it('converts areas both ways', () => {
		expect(convertArea(1, 'sqm', 'sqft')).toBeCloseTo(10.7639, 3);
		expect(convertArea(10.763910416709722, 'sqft', 'sqm')).toBeCloseTo(1, 9);
		// The figure the sidebar shows for a 200 m² floor.
		expect(convertArea(200, 'sqm', 'sqft')).toBeCloseTo(2152.78, 1);
	});

	it('round-trips a stored metric value without drift', () => {
		for (const metres of [0.05, 0.2, 1.5, 2.5, 3, 10, 42.7]) {
			expect(unitToMetres(convertLength(metres, 'm', 'ft'), 'ft')).toBeCloseTo(metres, 9);
		}
		for (const sqm of [12, 48, 200, 1234.5]) {
			expect(unitToSqm(sqmToUnit(sqm, 'sqft'), 'sqft')).toBeCloseTo(sqm, 9);
		}
	});
});

describe('rounding for display', () => {
	it('keeps whole numbers from ten up and one decimal below', () => {
		expect(displayDecimals(49.2)).toBe(0);
		expect(displayDecimals(10)).toBe(0);
		expect(displayDecimals(9.9)).toBe(1);
		expect(displayDecimals(-49.2)).toBe(0);
		expect(displayDecimals(0)).toBe(1);
	});

	it('rounds a converted value rather than printing its float tail', () => {
		// 15 m of range, in feet: the figure the AP editor shows.
		expect(roundForDisplay(convertLength(15, 'm', 'ft'))).toBe(49);
		// 0.2 m of slab is 0.66 ft, and a whole-number rule would call that 1.
		expect(roundForDisplay(convertLength(0.2, 'm', 'ft'))).toBe(0.7);
		// 0.1 m of alignment offset.
		expect(roundForDisplay(convertLength(0.1, 'm', 'ft'))).toBe(0.3);
		// 2.5 m of ceiling.
		expect(roundForDisplay(convertLength(2.5, 'm', 'ft'))).toBe(8.2);
		// 200 m² of floor area.
		expect(roundForDisplay(convertArea(200, 'sqm', 'sqft'))).toBe(2153);
	});

	it('formats a measurement with its unit', () => {
		expect(formatMeasure(49.2, 'ft')).toBe('49 ft');
		expect(formatMeasure(2.5, 'm')).toBe('2.5 m');
	});

	it('describes a length and an area as one value, text and unit', () => {
		expect(displayLength(2.5, 'ft')).toEqual({ value: 8.2, text: '8.2', unit: 'ft' });
		expect(displayLength(2.5, 'm')).toEqual({ value: 2.5, text: '2.5', unit: 'm' });
		expect(displayArea(200, 'sqft')).toEqual({ value: 2153, text: '2153', unit: 'sqft' });
	});
});

describe('input hints', () => {
	it('leaves metric bounds alone', () => {
		expect(lengthInputHints(2, 10, 0.5, 'm')).toEqual({ min: 2, max: 10, step: 0.5 });
	});

	it('converts the model bounds with the field', () => {
		const hints = lengthInputHints(2, 10, 0.5, 'ft');
		expect(hints.min).toBeCloseTo(6.56, 2);
		expect(hints.max).toBeCloseTo(32.81, 2);
		// A 0.5 m step is 1.64 ft; rounding it to 2 would make the spinner lie.
		expect(hints.step).toBeCloseTo(1.64, 2);
	});
});
