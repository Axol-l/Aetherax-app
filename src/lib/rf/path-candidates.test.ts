import { describe, expect, it } from 'vitest';
import {
	diffractionCandidatesForAp,
	reflectionCandidates,
	scatterSamplesForAp,
	scatteringSegmentLengthM
} from './path-candidates.js';
import type { ReflectingWall } from './reflection.js';

const wall = (ax: number, ay: number, bx: number, by: number, material = 0): ReflectingWall => ({
	ax,
	ay,
	bx,
	by,
	material
});

describe('secondary path candidates', () => {
	it('keeps walls that can reflect and drops virtual partitions', () => {
		const candidates = reflectionCandidates(
			[wall(0, -10, 0, 10), wall(20, -10, 20, 10, 6)],
			'5ghz'
		);
		expect(candidates.walls).toHaveLength(1);
		expect(candidates.wallIndices).toEqual([0]);
	});

	it('precomputes AP-side visible diffraction edges', () => {
		const walls = [wall(0, -10, 0, 10)];
		const candidates = diffractionCandidatesForAp({ x: 10, y: 0 }, walls, '5ghz', 1);
		expect(candidates).toHaveLength(2);
		expect(candidates.every((edge) => edge.wallIndices?.includes(0))).toBe(true);
	});

	it('drops an edge whose AP leg is blocked by another wall', () => {
		const walls = [wall(0, -10, 0, 10), wall(5, -20, 5, 20)];
		const candidates = diffractionCandidatesForAp({ x: 10, y: 0 }, walls, '5ghz', 1);
		// 挡墙自己的端点是可见的；被它挡住的那面墙的端点不能进入候选。
		expect(candidates.some((edge) => edge.x === 0)).toBe(false);
	});

	it('indexes many candidate walls and only returns nearby ones', () => {
		const walls = Array.from({ length: 12 }, (_, i) =>
			wall(i * 100, 0, i * 100, 10)
		);
		const set = reflectionCandidates(walls, '5ghz', 50);
		expect(set.grid).not.toBeNull();
		const near = set.grid!.query(0, 5, 25);
		expect(near.length).toBeGreaterThan(0);
		expect(near.length).toBeLessThan(walls.length);
	});

	it('builds one-dimensional scatter samples with wall area', () => {
		const walls = [wall(0, 0, 0, 100)];
		const samples = scatterSamplesForAp({ x: 50, y: 50 }, walls, '5ghz', 1, 3);
		expect(samples.length).toBeGreaterThan(1);
		expect(samples[0]!.areaM2).toBeGreaterThan(0);
		expect(samples[0]!.d1M).toBeGreaterThan(0);
		expect(samples[0]!.z).toBe(0);
	});

	it('adds height samples only above the 2D threshold', () => {
		const walls = [wall(0, 0, 0, 100)];
		const low = scatterSamplesForAp({ x: 50, y: 50 }, walls, '5ghz', 1, 3);
		const tall = scatterSamplesForAp({ x: 50, y: 50 }, walls, '5ghz', 1, 5);
		expect(low[0]!.z).toBe(0);
		expect(tall.length).toBeGreaterThan(low.length);
		expect(tall.some((sample) => sample.z > 0)).toBe(true);
	});

	it('scales scattering segments with band and distance', () => {
		expect(scatteringSegmentLengthM('2.4ghz', 10)).toBeGreaterThan(
			scatteringSegmentLengthM('6ghz', 10)
		);
		expect(scatteringSegmentLengthM('5ghz', 2)).toBeLessThan(
			scatteringSegmentLengthM('5ghz', 30)
		);
	});
});
