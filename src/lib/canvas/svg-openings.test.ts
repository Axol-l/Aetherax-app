/** 窗户在图纸上是两条线，在模型里是一次材质变化。 */
import { describe, expect, it } from 'vitest';
import { collapseOpenings, mergeOpeningsIntoWalls } from './svg-walls.js';

const wall = { ax: 0, ay: 0, bx: 100, by: 0, material: 0 };
const glass = 2;
const window1 = { ax: 40, ay: 1, bx: 60, by: 1, material: glass };
const window2 = { ax: 40, ay: 5, bx: 60, by: 5, material: glass };

describe('collapseOpenings', () => {
	it('turns the two parallel strokes of one window into one line', () => {
		const collapsed = collapseOpenings([window1, window2], 10);
		expect(collapsed).toHaveLength(1);
		expect(collapsed[0]!.material).toBe(glass);
	});

	it('leaves two openings apart in the wall alone', () => {
		const other = { ax: 40, ay: 40, bx: 60, by: 40, material: glass };
		expect(collapseOpenings([window1, other], 10)).toHaveLength(2);
	});

	it('does not touch openings at right angles', () => {
		const crossing = { ax: 50, ay: -20, bx: 50, by: 20, material: glass };
		expect(collapseOpenings([window1, crossing], 10)).toHaveLength(2);
	});
});

describe('mergeOpeningsIntoWalls', () => {
	it('cuts the wall and marks the piece as glass, leaving wall on both sides', () => {
		const merged = mergeOpeningsIntoWalls([wall], [collapseOpenings([window1, window2], 10)[0]!], 10);
		// 三段：墙、玻璃、墙，而不是墙外加一条重叠线。
		expect(merged).toHaveLength(3);
		const materials = merged.map((segment) => segment.material);
		expect(materials).toEqual([0, glass, 0]);
		expect(merged[0]!.ax).toBeCloseTo(0, 6);
		expect(merged[0]!.bx).toBeCloseTo(40, 6);
		expect(merged[1]!.ax).toBeCloseTo(40, 6);
		expect(merged[1]!.bx).toBeCloseTo(60, 6);
		expect(merged[2]!.ax).toBeCloseTo(60, 6);
		expect(merged[2]!.bx).toBeCloseTo(100, 6);
	});

	it('keeps an opening that sits on no wall', () => {
		const freestanding = { ax: 40, ay: 40, bx: 60, by: 40, material: glass };
		const merged = mergeOpeningsIntoWalls([wall], [freestanding], 10);
		expect(merged).toHaveLength(2);
		expect(merged.some((segment) => segment.material === glass)).toBe(true);
	});

	it('leaves a wall with no openings exactly as it was', () => {
		const merged = mergeOpeningsIntoWalls([wall], [], 10);
		expect(merged).toHaveLength(1);
		expect(merged[0]).toEqual(wall);
	});
});
