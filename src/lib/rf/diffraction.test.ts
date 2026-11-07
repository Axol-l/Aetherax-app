/**
 * 刀刃衍射模型，用例选取菲涅尔参数可直接推算的情形。
 */
import { describe, expect, it } from 'vitest';
import {
	bestDiffraction,
	edgesOf,
	knifeEdgeLossDb,
	wavelengthM,
	type DiffractionEdge
} from './diffraction.js';

const lambda5 = wavelengthM(5.5);

describe('knifeEdgeLossDb', () => {
	it('is zero when the path clears the edge', () => {
		expect(knifeEdgeLossDb(-2, 10, 10, lambda5)).toBe(0);
	});

	it('grows as the edge intrudes further into the path', () => {
		const small = knifeEdgeLossDb(0.5, 10, 10, lambda5);
		const large = knifeEdgeLossDb(5, 10, 10, lambda5);
		expect(small).toBeGreaterThan(0);
		expect(large).toBeGreaterThan(small);
	});

	it('grows with frequency for the same geometry', () => {
		const low = knifeEdgeLossDb(2, 10, 10, wavelengthM(2.447));
		const high = knifeEdgeLossDb(2, 10, 10, wavelengthM(6.53));
		expect(high).toBeGreaterThan(low);
	});

	it('matches the P.526 closed form at a known point', () => {
		// h = 1 m、d1 = d2 = 10 m、λ = 0.0545 m，据此算得 ν ≈ 2.71。
		const v = Math.sqrt((2 * 20) / (lambda5 * 100));
		const expected = 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1);
		expect(knifeEdgeLossDb(1, 10, 10, lambda5)).toBeCloseTo(expected, 6);
	});
});

describe('bestDiffraction', () => {
	const from = { x: 0, y: 0 };
	const to = { x: 100, y: 0 };
	const edges: DiffractionEdge[] = [
		{ x: 50, y: 1, material: 0 },
		{ x: 50, y: -20, material: 0 },
		{ x: -10, y: 0.5, material: 0 }, // 位于源之后
		{ x: 200, y: 0.5, material: 0 } // 位于接收端之外
	];

	it('prefers the edge nearest the path and ignores the ones outside it', () => {
		const best = bestDiffraction(from, to, edges, lambda5)!;
		expect(best).not.toBeNull();
		expect(best.x).toBeCloseTo(50, 6);
		expect(best.y).toBeCloseTo(1, 6);
	});

	it('returns null when there are no edges', () => {
		expect(bestDiffraction(from, to, [], lambda5)).toBeNull();
	});

	it('honours the clearance cull', () => {
		const far: DiffractionEdge[] = [{ x: 50, y: 30, material: 0 }];
		expect(bestDiffraction(from, to, far, lambda5, 10)).toBeNull();
	});

	it('converts world units to metres before applying the Fresnel limits', () => {
		// The same 100 m path expressed in 0.1 m world units must give the same loss.
		const scaled = bestDiffraction(
			{ x: 0, y: 0 },
			{ x: 1000, y: 0 },
			[{ x: 500, y: 10, material: 0 }],
			lambda5,
			40,
			60,
			0.1
		)!;
		const plain = bestDiffraction(
			{ x: 0, y: 0 },
			{ x: 100, y: 0 },
			[{ x: 50, y: 1, material: 0 }],
			lambda5
		)!;
		expect(scaled.lossDb).toBeCloseTo(plain.lossDb, 6);
	});

	it('finds both ends of every wall', () => {
		const edgesOfWalls = edgesOf([
			{ ax: 0, ay: 0, bx: 10, by: 0, material: 0 },
			{ ax: 20, ay: 5, bx: 20, by: 25, material: 3 }
		]);
		expect(edgesOfWalls).toHaveLength(4);
		expect(edgesOfWalls[2]).toMatchObject({ x: 20, y: 5, material: 3 });
	});
});
