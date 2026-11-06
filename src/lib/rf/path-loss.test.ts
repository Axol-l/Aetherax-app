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
		// @ts-expect-error 故意传入联合类型之外的值
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

		// 已发布的关联距离：2.4 GHz / 20 dBm / N = 40 时为 43.2 m（见 docs/PHYSICAL_MODELS.md §A3a）；
		// 同一表格中的 17.7 m 是 −70 dBm 处的覆盖半径，对应 `coverageReach`，不是本函数。
		setPathLossScenario('closedPlan');
		expect(rangeFromPower(20, '2.4ghz')).toBeCloseTo(43.2, 1);
	});

	it('is exactly the single-coefficient form for the far-field environment', () => {
		// 默认环境与所有已记录数值一致，因此一位数字都不能变：断点把斜率过渡到 n = 4，
		// 而该环境本身已是 4。
		setPathLossScenario('closedPlan');
		for (const d of [2, 5, 10, 20, 60]) {
			expect(relativePathLossDb(d)).toBeCloseTo(10 * 4 * Math.log10(d), 12);
		}
	});

	it('spreads at the near-field rate, then the far-field one', () => {
		setPathLossScenario('lineOfSight');
		// 断点以内，衰减系数就是该环境自身的取值。
		expect(relativePathLossDb(4)).toBeCloseTo(10 * 2 * Math.log10(4), 1);
		// 断点以外，斜率转为远场取值：每十倍距离的 dB 数。
		const perDecade = (relativePathLossDb(60) - relativePathLossDb(20)) / Math.log10(3);
		expect(perDecade).toBeCloseTo(10 * 4, 0);
	});

	it('bounds a line-of-sight AP instead of extrapolating the near field', () => {
		setPathLossScenario('lineOfSight');
		const reach = coverageReach(rangeFromPower(20, "5ghz"));
		// 覆盖范围被限制在断点附近，而不是沿近场斜率外推到 100 m。
		expect(reach).toBeLessThan(60);
		expect(reach).toBeGreaterThan(20);
	});

	it('keeps the coverage circle where the margin says it is', () => {
		for (const scenario of ['lineOfSight', 'office', 'closedPlan'] as const) {
			setPathLossScenario(scenario);
			const radius = rangeFromPower(20, '5ghz');
			const reach = coverageReach(radius);
			// 余量为正时恰好落在圆内，热力图、优化器与编辑器中的覆盖圆都依赖这一关系。
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
