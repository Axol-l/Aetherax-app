/**
 * The image-source geometry, on cases whose answer can be seen without running anything.
 */
import { describe, expect, it } from 'vitest';
import { bestReflection, reflectionPowerRatio, reflections, specularReflection } from './reflection.js';

/** A vertical wall at x = 100 spanning y ∈ [0, 200], concrete (id 4). */
const wall = { ax: 100, ay: 0, bx: 100, by: 200, material: 4 };

describe('specularReflection', () => {
	it('bounces halfway for points at equal distances, and the path is longer than direct', () => {
		// Both ends to the left of the wall: the specular bounce is at the middle of it.
		const from = { x: 0, y: 100 };
		const to = { x: 60, y: 100 };
		const hit = specularReflection(from, to, wall)!;
		expect(hit).not.toBeNull();
		expect(hit.x).toBeCloseTo(100, 6);
		expect(hit.y).toBeCloseTo(100, 6);
		expect(hit.cosTheta).toBeCloseTo(1, 6);
		expect(hit.length).toBeCloseTo(140, 6);
	});

	it('keeps the angle equal on both sides, with the bounce off centre', () => {
		// Both ends on the same side of the wall: that is when a reflection exists at all.
		const tall = { ax: 100, ay: 0, bx: 100, by: 600, material: 4 };
		const from = { x: 0, y: 50 };
		const to = { x: 60, y: 550 };
		const hit = specularReflection(from, to, tall)!;
		expect(hit.x).toBeCloseTo(100, 6);
		// Where the mirrored source (200, 50) meets the receiver at x = 60.
		const t = (100 - 200) / (60 - 200);
		expect(hit.y).toBeCloseTo(50 + 500 * t, 6);
		// Both legs make the same angle with the wall's normal.
		const left = Math.atan2(Math.abs(hit.y - from.y), Math.abs(hit.x - from.x));
		const right = Math.atan2(Math.abs(to.y - hit.y), Math.abs(to.x - hit.x));
		expect(left).toBeCloseTo(right, 6);
		// And the total path is the two legs, longer than the direct one.
		expect(hit.length).toBeGreaterThan(Math.hypot(to.x - from.x, to.y - from.y));
	});

	it('refuses a reflection between two points on opposite sides of the wall', () => {
		// That ray goes through the wall; transmission is what charges it, not a bounce.
		expect(specularReflection({ x: 10, y: 100 }, { x: 120, y: 100 }, wall)).toBeNull();
	});

	it('refuses a bounce beyond the end of a finite wall', () => {
		// The specular point for these points is far below y = 0, off the segment.
		expect(specularReflection({ x: 0, y: 400 }, { x: 200, y: 420 }, wall)).toBeNull();
	});

	it('refuses a degenerate wall', () => {
		expect(
			specularReflection({ x: 0, y: 0 }, { x: 10, y: 0 }, { ax: 5, ay: 5, bx: 5, by: 5, material: 4 })
		).toBeNull();
	});
});

describe('reflectionPowerRatio', () => {
	it('is large for concrete at a grazing angle and smaller head-on', () => {
		const headOn = reflectionPowerRatio(wall, '5ghz', 1);
		const grazing = reflectionPowerRatio(wall, '5ghz', 0.1);
		expect(headOn).toBeGreaterThan(0);
		expect(headOn).toBeLessThan(0.98);
		expect(grazing).toBeGreaterThan(headOn);
	});

	it('is zero for a material that is not a surface (virtual partition)', () => {
		expect(reflectionPowerRatio({ ...wall, material: 6 }, '5ghz', 1)).toBe(0);
		expect(reflectionPowerRatio({ ...wall, material: 7 }, '5ghz', 1)).toBe(0);
	});

	it('reflects a 10 mm glass pane more at 2.4 GHz than at 6.5', () => {
		// The same physics that makes glass a *better wall* at lower frequency makes it a
		// better mirror there: the pane is a larger fraction of the wavelength.
		const low = reflectionPowerRatio({ ...wall, material: 2 }, '2.4ghz', 1);
		const high = reflectionPowerRatio({ ...wall, material: 2 }, '6ghz', 1);
		expect(low).toBeGreaterThan(high);
	});
});

describe('bestReflection', () => {
	it('picks the wall with the strongest return', () => {
		const from = { x: 0, y: 100 };
		const to = { x: 60, y: 100 };
		// The same wall, made of two materials: concrete reflects more than glass.
		const concrete = bestReflection(from, to, [wall], '5ghz')!;
		const glass = bestReflection(from, to, [{ ...wall, material: 2 }], '5ghz')!;
		expect(concrete).not.toBeNull();
		expect(glass).not.toBeNull();
		expect(concrete.powerRatio).toBeGreaterThan(glass.powerRatio);
	});

	it('honours the distance cull the caller passes', () => {
		const far = { ax: 5000, ay: 0, bx: 5000, by: 200, material: 4 };
		// Twenty-four metres at a typical scale, which a wall 5 km away fails.
		expect(bestReflection({ x: 0, y: 100 }, { x: 60, y: 100 }, [far], '5ghz', 24)).toBeNull();
		// Without the cull the geometry is valid: the wall is behind both points, which is a
		// real reflection (it arrives from behind), not an error.
		expect(bestReflection({ x: 0, y: 100 }, { x: 60, y: 100 }, [far], '5ghz')).not.toBeNull();
	});

	it('finds nothing when there are no walls', () => {
		expect(bestReflection({ x: 0, y: 100 }, { x: 60, y: 100 }, [], '5ghz')).toBeNull();
	});

	/**
	 * The picture is summed, not chosen.
	 *
	 * "Strongest only" switched walls across a line in the room — the crease and the notches the
	 * heatmap showed — so the module returns every return and the caller sums their power.
	 */
	it('returns every wall that reflects, strongest first', () => {
		const from = { x: 0, y: 100 };
		const to = { x: 60, y: 100 };
		// Two walls on the same side, both with a valid specular point.
		const all = reflections(from, to, [wall, { ...wall, ax: 100, ay: 300, bx: 100, by: 600 }], '5ghz');
		expect(all.length).toBe(1); // the second wall has no point between these ends
		expect(all[0]!.powerRatio).toBeGreaterThan(0);

		const pair = reflections(
			from,
			to,
			[wall, { ...wall, material: 2 }],
			'5ghz'
		);
		expect(pair.length).toBe(2);
		expect(pair[0]!.powerRatio).toBeGreaterThanOrEqual(pair[1]!.powerRatio);
	});
});
