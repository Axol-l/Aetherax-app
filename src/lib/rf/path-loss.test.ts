import { describe, expect, it, afterEach } from 'vitest';
import {
	COVERAGE_MARGIN_DB,
	DEFAULT_PATH_LOSS_SCENARIO,
	PATH_LOSS_SCENARIOS,
	coverageMarginDb,
	coverageReach,
	coverageThresholdDbm,
	coverageThresholdMarginDb,
	pathLossN,
	rangeFromPower,
	relativePathLossDb,
	setCoverageThresholdDbm,
	setPathLossN,
	setPathLossScenario,
	type PathLossScenario
} from './propagation.js';

describe('configurable coverage threshold', () => {
	afterEach(() => setCoverageThresholdDbm(-70));

	it('projects the threshold onto the sensitivity-relative margin', () => {
		expect(coverageThresholdDbm()).toBe(-70);
		expect(coverageThresholdMarginDb()).toBe(COVERAGE_MARGIN_DB);
		const defaultReach = coverageReach(1000);
		setCoverageThresholdDbm(-60);
		expect(coverageThresholdMarginDb()).toBe(COVERAGE_MARGIN_DB + 10);
		// A stricter threshold shortens the reach.
		expect(coverageReach(1000)).toBeLessThan(defaultReach);
	});
});

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
		// @ts-expect-error 鏁呮剰浼犲叆鑱斿悎绫诲瀷涔嬪鐨勫€?
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

		// 宸插彂甯冪殑鍏宠仈璺濈锛?.4 GHz / 20 dBm / N = 40 鏃朵负 43.2 m锛堣 docs/PHYSICAL_MODELS.md 搂A3a锛夛紱
		// 鍚屼竴琛ㄦ牸涓殑 17.7 m 鏄?鈭?0 dBm 澶勭殑瑕嗙洊鍗婂緞锛屽搴?`coverageReach`锛屼笉鏄湰鍑芥暟銆?
		setPathLossScenario('closedPlan');
		expect(rangeFromPower(20, '2.4ghz')).toBeCloseTo(43.2, 1);
	});

	it('is exactly the single-coefficient form for the far-field environment', () => {
		// 榛樿鐜涓庢墍鏈夊凡璁板綍鏁板€间竴鑷达紝鍥犳涓€浣嶆暟瀛楅兘涓嶈兘鍙橈細鏂偣鎶婃枩鐜囪繃娓″埌 n = 4锛?
		// 鑰岃鐜鏈韩宸叉槸 4銆?
		setPathLossScenario('closedPlan');
		for (const d of [2, 5, 10, 20, 60]) {
			expect(relativePathLossDb(d)).toBeCloseTo(10 * 4 * Math.log10(d), 12);
		}
	});

	it('spreads at the near-field rate, then the far-field one', () => {
		setPathLossScenario('lineOfSight');
		// 鏂偣浠ュ唴锛岃“鍑忕郴鏁板氨鏄鐜鑷韩鐨勫彇鍊笺€?
		expect(relativePathLossDb(4)).toBeCloseTo(10 * 2 * Math.log10(4), 1);
		// 鏂偣浠ュ锛屾枩鐜囪浆涓鸿繙鍦哄彇鍊硷細姣忓崄鍊嶈窛绂荤殑 dB 鏁般€?
		const perDecade = (relativePathLossDb(60) - relativePathLossDb(20)) / Math.log10(3);
		expect(perDecade).toBeCloseTo(10 * 4, 0);
	});

	it('bounds a line-of-sight AP instead of extrapolating the near field', () => {
		setPathLossScenario('lineOfSight');
		const reach = coverageReach(rangeFromPower(20, "5ghz"));
		// 瑕嗙洊鑼冨洿琚檺鍒跺湪鏂偣闄勮繎锛岃€屼笉鏄部杩戝満鏂滅巼澶栨帹鍒?100 m銆?
		expect(reach).toBeLessThan(60);
		expect(reach).toBeGreaterThan(20);
	});

	it('keeps the coverage circle where the margin says it is', () => {
		for (const scenario of ['lineOfSight', 'office', 'closedPlan'] as const) {
			setPathLossScenario(scenario);
			const radius = rangeFromPower(20, '5ghz');
			const reach = coverageReach(radius);
			// 浣欓噺涓烘鏃舵伆濂借惤鍦ㄥ渾鍐咃紝鐑姏鍥俱€佷紭鍖栧櫒涓庣紪杈戝櫒涓殑瑕嗙洊鍦嗛兘渚濊禆杩欎竴鍏崇郴銆?
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
