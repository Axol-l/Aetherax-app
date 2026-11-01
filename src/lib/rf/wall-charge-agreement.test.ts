/**
 * One plan, one answer: how a wall is charged, checked across the paths that charge it.
 *
 * Four places compute the loss along a ray through the same wall mask — the heatmap's field,
 * the coverage pass, the optimiser's fast pass and the solver — and they are allowed to differ
 * in *sampling* (stride 1, 2 or 3; a polar field read out at a point rather than marched), not
 * in what a crossing costs. When they differ in the second thing, no test notices that the
 * app's own numbers disagree with each other, because each of them is self-consistent.
 *
 * This is the fixture the plan (`docs/FIX-PLAN.zh-CN.md`, item 13) asked for: one small walled
 * plan, every route a ray can take through it, and the claims that must hold whichever route
 * computed the number. It pins `rf/link-budget.ts` — the one place the four are supposed to go
 * through — and the two things a call site can still get wrong on its own:
 *
 * - **the frame.** `wallRunLoss` subtracts the mask's origin; a call site that marches the mask
 *   itself has to do the same, and exactly one of them getting it wrong is invisible.
 * - **the stride.** A coarser march can miss a thin wall or land on it twice. That is a
 *   quantisation difference and is bounded here, rather than being allowed to be anything.
 */
import { describe, expect, it } from 'vitest';
import { wallRunLoss, splitWallRunLoss, type WallRun } from './link-budget.js';
import { rayMarchWallAtten } from './propagation.js';

/** Two vertical partitions: a stud wall at x = 12 and a concrete one at x = 26. */
const W = 40;
const H = 30;

const DRYWALL = 1;
const CONCRETE = 2;
const DB_BY_MATERIAL = [0, 3, 12];

function partitionedPlan(): { mask: Uint8Array; material: Uint8Array } {
	const mask = new Uint8Array(W * H);
	const material = new Uint8Array(W * H);
	for (let y = 0; y < H; y++) {
		mask[y * W + 12] = 1;
		material[y * W + 12] = DRYWALL;
		mask[y * W + 26] = 1;
		material[y * W + 26] = CONCRETE;
	}
	return { mask, material };
}

function run(overrides: Partial<WallRun> = {}): WallRun {
	const { mask, material } = partitionedPlan();
	return {
		mask,
		width: W,
		height: H,
		materialMask: material,
		materialDb: DB_BY_MATERIAL,
		fallbackDb: 99,
		originX: 0,
		originY: 0,
		defaultMaterialId: DRYWALL,
		...overrides
	};
}

/** Rays that cross neither wall, one of them, or both — straight and slanted. */
const RAYS: Array<{ from: { x: number; y: number }; to: { x: number; y: number }; walls: number }> = [
	{ from: { x: 2, y: 15 }, to: { x: 8, y: 15 }, walls: 0 },
	{ from: { x: 2, y: 15 }, to: { x: 20, y: 15 }, walls: 1 },
	{ from: { x: 2, y: 15 }, to: { x: 38, y: 15 }, walls: 2 },
	{ from: { x: 2, y: 2 }, to: { x: 38, y: 28 }, walls: 2 },
	{ from: { x: 30, y: 20 }, to: { x: 38, y: 25 }, walls: 0 },
	{ from: { x: 20, y: 15 }, to: { x: 22, y: 15 }, walls: 0 }
];

describe('what a wall costs, whichever path charged it', () => {
	it('charges the material table, once per crossing, through the shared helper', () => {
		// The reference: three dB for the stud wall, twelve for the concrete one.
		expect(wallRunLoss(run(), { x: 2, y: 15 }, { x: 8, y: 15 })).toBe(0);
		expect(wallRunLoss(run(), { x: 2, y: 15 }, { x: 20, y: 15 })).toBe(3);
		expect(wallRunLoss(run(), { x: 2, y: 15 }, { x: 38, y: 15 })).toBe(15);
	});

	it('is the same number whether the caller uses the helper or marches itself', () => {
		// `wallRunLoss` *is* the return value of `rayMarchWallAtten` — this pins that, because
		// the optimiser's fast pass calls the march directly and subtracts its own prefix. A
		// change to one that the other does not see shows up here.
		const plan = partitionedPlan();
		for (const ray of RAYS) {
			const viaHelper = wallRunLoss(run(), ray.from, ray.to, 1);
			const viaMarch = rayMarchWallAtten(
				plan.mask,
				W,
				H,
				plan.material,
				DB_BY_MATERIAL,
				99,
				ray.from.x,
				ray.from.y,
				ray.to.x,
				ray.to.y,
				1,
				DRYWALL
			);
			expect(viaMarch, `ray ${JSON.stringify(ray)}`).toBe(viaHelper);
		}
	});

	it('gives the same loss when the plan is drawn somewhere else on the sheet', () => {
		/*
		 * The hazard the helper exists for: every call site used to subtract the origin itself,
		 * and one of them getting it wrong moves the plan under the ray. Aligning a floor does
		 * exactly this — the mask does not change, its origin does.
		 */
		const shifted = run({ originX: 100, originY: 50 });
		for (const ray of RAYS) {
			const here = wallRunLoss(run(), ray.from, ray.to);
			const there = wallRunLoss(
				shifted,
				{ x: ray.from.x + 100, y: ray.from.y + 50 },
				{ x: ray.to.x + 100, y: ray.to.y + 50 }
			);
			expect(there, `shifted ray ${JSON.stringify(ray)}`).toBe(here);
		}
	});

	it('lets the stride round the answer but not invent or lose a wall', () => {
		/*
		 * The heatmap marches at 2 and the solver at 3, so the figures cannot be equal. What
		 * they must not do is disagree by a whole wall: a coarse march that steps over a 1 px
		 * partition would make the app's cheapest evaluator blind to it.
		 */
		for (const ray of RAYS) {
			const fine = wallRunLoss(run(), ray.from, ray.to, 1);
			for (const stride of [2, 3]) {
				const coarse = wallRunLoss(run(), ray.from, ray.to, stride);
				const costs = [...(ray.walls === 0 ? [0] : [3, 12])];
				const worst = Math.max(...costs) + 12;
				expect(Math.abs(coarse - fine), `stride ${stride}, ray ${JSON.stringify(ray)}`).toBeLessThanOrEqual(
					worst
				);
				// And a ray that crosses nothing stays free at every stride.
				if (ray.walls === 0) expect(coarse).toBe(0);
			}
		}
	});

	it('splits a cross-floor path at the storey and charges each half on its own plan', () => {
		/*
		 * The other half of the shared layer: a path that leaves the AP's floor through the slab
		 * and finishes on the client's. The two floors have different plans here, so a split
		 * that used one mask for both would be visible in the total.
		 */
		const upper: WallRun = run();
		// The lower floor has its own partition, at a different place.
		const lowerMask = new Uint8Array(W * H);
		const lowerMaterial = new Uint8Array(W * H);
		const lowerWallX = 30;
		for (let y = 0; y < H; y++) {
			lowerMask[y * W + lowerWallX] = 1;
			lowerMaterial[y * W + lowerWallX] = CONCRETE;
		}
		const lower: WallRun = {
			mask: lowerMask,
			width: W,
			height: H,
			materialMask: lowerMaterial,
			materialDb: DB_BY_MATERIAL,
			fallbackDb: 99,
			originX: 0,
			originY: 0,
			defaultMaterialId: DRYWALL
		};

		const from = { x: 2, y: 15 };
		const to = { x: 38, y: 15 };
		// Fractions along the ray where it leaves each floor. The source half ends at x = 16.4
		// (past the upper plan's 12 px wall) and the target half starts at x = 23.6 (before the
		// lower plan's 30 px wall), so each half crosses exactly one wall of its own floor.
		const sourceT = 0.4;
		const targetT = 0.6;
		const split = splitWallRunLoss(upper, lower, sourceT, targetT, from, to);
		expect(split).not.toBeNull();

		const sourceCross = { x: 2 + sourceT * 36, y: 15 };
		const targetCross = { x: 2 + targetT * 36, y: 15 };
		const upperHalf = wallRunLoss(upper, from, sourceCross);
		const lowerHalf = wallRunLoss(lower, targetCross, to);
		expect(upperHalf).toBe(3);
		expect(lowerHalf).toBe(12);
		expect(split).toBeCloseTo(upperHalf + lowerHalf, 6);
	});

	it('falls back to one run when the path stays on one floor', () => {
		const flat = run();
		// Both crossing fractions at zero is how `crossFloorSegments` says "this ray never
		// leaves the client's floor", and the caller keeps its single-run path.
		expect(splitWallRunLoss(flat, flat, 0, 0, { x: 2, y: 15 }, { x: 38, y: 15 })).toBeNull();
	});
});
