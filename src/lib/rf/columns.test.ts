import { describe, expect, it } from 'vitest';
import { getFlatAttenuation, getMaterial, getMaterialDbTable } from '$lib/domain/materials.js';
import { columnCrossings, columnLossDelta, type ColumnObstacle } from './columns.js';

const rect: ColumnObstacle = {
	shape: 'rect',
	ax: 0,
	ay: 0,
	bx: 10,
	by: 10,
	material: 1
};

describe('column direct-path loss', () => {
	it('uses the actual chord through a rectangular column', () => {
		const hits = columnCrossings([rect], { x: -5, y: 5 }, { x: 15, y: 5 });
		expect(hits).toHaveLength(1);
		expect(hits[0]!.chord).toBeCloseTo(10, 6);
		expect(hits[0]!.cosTheta).toBeCloseTo(1, 6);
	});

	it('is longer on an oblique path than through the short side', () => {
		const straight = columnCrossings([rect], { x: 5, y: -5 }, { x: 5, y: 15 })[0]!;
		const oblique = columnCrossings([rect], { x: -5, y: 5 }, { x: 15, y: 5 })[0]!;
		expect(oblique.chord).toBeGreaterThanOrEqual(straight.chord);
	});

	it('replaces the raster one-shot loss with chord and angle', () => {
		const table = getMaterialDbTable('5ghz');
		const base = table[1]!;
		const delta = columnLossDelta(
			[rect],
			{ x: -5, y: 5 },
			{ x: 15, y: 5 },
			'5ghz',
			table,
			40
		);
		const flat = getFlatAttenuation(1, '5ghz');
		expect(base).toBeCloseTo(flat, 6);
		expect(delta).toBeGreaterThan(0);
		expect(delta).toBeCloseTo(flat * (10 / 40) / getMaterial(1).typicalThickness - base, 5);
	});

	it('does not charge a ray that misses', () => {
		expect(
			columnLossDelta([rect], { x: -5, y: 20 }, { x: 15, y: 20 }, '5ghz', getMaterialDbTable('5ghz'), 40)
		).toBe(0);
	});
});
