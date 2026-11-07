import { describe, expect, it } from 'vitest';
import { diffractionCandidatesForAp, reflectionCandidates } from './path-candidates.js';
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
});
