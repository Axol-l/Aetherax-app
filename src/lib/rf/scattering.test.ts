import { describe, expect, it } from 'vitest';
import {
	diffuseLevelDb,
	directiveNormalization,
	directivePatternFactor,
	wallNormal
} from './scattering.js';
import { getScatteringCoefficient } from '$lib/domain/materials.js';

describe('single-bounce diffuse scattering', () => {
	it('reads the wall normal and the material coefficient', () => {
		const normal = wallNormal({ ax: 0, ay: 0, bx: 0, by: 10 });
		expect(Math.abs(normal.x)).toBeCloseTo(1);
		expect(normal.y).toBeCloseTo(0);
		expect(getScatteringCoefficient(0)).toBeGreaterThan(0);
		expect(getScatteringCoefficient(6)).toBe(0);
		expect(getScatteringCoefficient(4, '6ghz')).toBeCloseTo(0.3, 6);
		expect(getScatteringCoefficient(0)).toBeCloseTo(0.1, 6);
		expect(getScatteringCoefficient(0, '2.4ghz')).toBeCloseTo(0.05, 6);
	});

	it('peaks around the specular direction', () => {
		const wall = { ax: 0, ay: 0, bx: 0, by: 10, material: 0 };
		const specular = directivePatternFactor({
			wall,
			ap: { x: 5, y: 5 },
			hit: { x: 0, y: 5 },
			target: { x: 5, y: 5 }
		});
		const off = directivePatternFactor({
			wall,
			ap: { x: 5, y: 5 },
			hit: { x: 0, y: 5 },
			target: { x: 5, y: 9 }
		});
		expect(directiveNormalization(1)).toBeGreaterThan(0);
		expect(specular).toBeGreaterThan(off);
	});

	it('is a finite, weaker path than the incident reference', () => {
		const wall = { ax: 0, ay: 0, bx: 0, by: 10, material: 0 };
		const level = diffuseLevelDb({
			apRefDb: -26,
			pathLengthM: 10,
			antennaLossDb: 0,
			wallLossDb: 0,
			wall,
			ap: { x: 5, y: 5 },
			hit: { x: 0, y: 5 },
			target: { x: 5, y: 4 },
			material: 0,
			band: '5ghz'
		});
		expect(Number.isFinite(level)).toBe(true);
		expect(level).toBeLessThan(-26);
	});
});
