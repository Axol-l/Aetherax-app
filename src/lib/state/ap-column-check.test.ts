import { describe, expect, it } from 'vitest';
import { pointInsideColumn } from './ap-column-check.js';

describe('AP inside a column', () => {
	it('detects a point inside a rectangle', () => {
		const rect = { shape: 'rect' as const, ax: 10, ay: 10, bx: 30, by: 20 };
		expect(pointInsideColumn(rect, 20, 15)).toBe(true);
		expect(pointInsideColumn(rect, 31, 15)).toBe(false);
	});

	it('detects a point inside a circle using the drag radius', () => {
		const circle = { shape: 'circle' as const, ax: 10, ay: 10, bx: 15, by: 10 };
		expect(pointInsideColumn(circle, 13, 10)).toBe(true);
		expect(pointInsideColumn(circle, 16, 16)).toBe(false);
	});
});
