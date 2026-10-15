import { describe, expect, it } from 'vitest';
import {
	COVERAGE_MARGIN_DB,
	DEFAULT_PATH_LOSS_SCENARIO,
	PATH_LOSS_SCENARIOS,
	coverageMarginDb,
	coverageReach,
	pathLossN,
	rangeFromPower,
	relativePathLossDb,
	setPathLossN,
	setPathLossScenario,
	type PathLossScenario
} from './propagation.js';

describe('path loss scenarios', () => {
	it('quotes n = N/10 for every environment', () => {
		for (const [name, info] of Object.entries(PATH_LOSS_SCENARIOS)) {
			expect(info.n, name).toBeCloseTo(info.ituN / 10, 10);
		}
	});

	it('starts on the environment every recorded figure was taken with', () => {
		setPathLossScenario(DEFAULT_PATH_LOSS_SCENARIO);
		expect(DEFAULT_PATH_LOSS_SCENARIO).toBe('closedPlan');
		expect(pathLossN()).toBe(4.0);
	});

	it('follows the environment it is set to', () => {
		setPathLossScenario('lineOfSight');
		expect(pathLossN()).toBe(2.0);
		setPathLossScenario('closedPlan');
		expect(pathLossN()).toBe(4.0);
	});

	it('rejects an environment it does not know', () => {
		// @ts-expect-error deliberately outside the union
		expect(() => setPathLossScenario('basement')).toThrow();
	});

	it('gives a longer range for a smaller coefficient', () => {
		const at = (scenario: PathLossScenario): number => {
			setPathLossScenario(scenario);
			return rangeFromPower(20, '5ghz');
		};
		const los = at('lineOfSight');
		const office = at('office');
		const closed = at('closedPlan');
		expect(los).toBeGreaterThan(office);
		expect(office).toBeGreaterThan(closed);

		// The published association range: 43.2 m at 2.4 GHz / 20 dBm / N = 40
		// (`docs/PHYSICAL_MODELS.md` §A3a). The 17.7 m figure in the same table is the
		// coverage radius at −70 dBm, which is `coverageReach`, not this.
		setPathLossScenario('closedPlan');
		expect(rangeFromPower(20, '2.4ghz')).toBeCloseTo(43.2, 1);
	});

	it('is exactly the single-coefficient form for the far-field environment', () => {
		// The default is the environment every recorded figure was taken with, so it must not
		// move by a digit: the breakpoint ramps *towards* n = 4 and this one already is.
		setPathLossScenario('closedPlan');
		for (const d of [2, 5, 10, 20, 60]) {
			expect(relativePathLossDb(d)).toBeCloseTo(10 * 4 * Math.log10(d), 12);
		}
	});

	it('spreads at the near-field rate, then the far-field one', () => {
		setPathLossScenario('lineOfSight');
		// Well inside the breakpoint the coefficient is the environment's own.
		expect(relativePathLossDb(4)).toBeCloseTo(10 * 2 * Math.log10(4), 1);
		// Well past it the slope is the far-field one: dB per decade.
		const perDecade = (relativePathLossDb(60) - relativePathLossDb(20)) / Math.log10(3);
		expect(perDecade).toBeCloseTo(10 * 4, 0);
	});

	it('bounds a line-of-sight AP instead of extrapolating the near field', () => {
		setPathLossScenario('lineOfSight');
		const reach = coverageReach(rangeFromPower(20, "5ghz"));
		// 158 m before the breakpoint existed: the near-field slope carried to 100 m.
		expect(reach).toBeLessThan(60);
		expect(reach).toBeGreaterThan(20);
	});

	it('keeps the coverage circle where the margin says it is', () => {
		for (const scenario of ['lineOfSight', 'office', 'closedPlan'] as const) {
			setPathLossScenario(scenario);
			const radius = rangeFromPower(20, '5ghz');
			const reach = coverageReach(radius);
			// Inside the circle exactly when the margin is positive, which is what the
			// heatmap, the optimiser and the editor’s circle all rely on.
			expect(coverageMarginDb(reach, radius), scenario).toBeCloseTo(COVERAGE_MARGIN_DB, 6);
			expect(coverageMarginDb(reach * 0.9, radius), scenario).toBeGreaterThan(COVERAGE_MARGIN_DB);
		}
		setPathLossScenario(DEFAULT_PATH_LOSS_SCENARIO);
	});

	it('takes a raw coefficient for the measurement harnesses', () => {
		setPathLossN(2.5);
		expect(pathLossN()).toBe(2.5);
		expect(() => setPathLossN(0)).toThrow();
		setPathLossN(4);
		expect(pathLossN()).toBe(4);
	});
});
