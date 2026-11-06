/**
 * 用独立算出的数值校验 ITU-R P.2040 模型；期望值在本模块之外按 §2.1.4 式 43–44 计算。
 */
import { describe, expect, it } from 'vitest';
import {
	BAND_FREQUENCY_GHZ,
	ituEpsilon,
	ituWallLossDb,
	MAX_MATERIAL_LOSS_DB,
	slabLossDb
} from './material-itu.js';

describe('P.2040 material loss', () => {
	it('matches the reference figures for a crossing', () => {
		const loss = (key: Parameters<typeof ituWallLossDb>[0], band: keyof typeof BAND_FREQUENCY_GHZ, t: number) =>
			ituWallLossDb(key, BAND_FREQUENCY_GHZ[band], t);

		// 典型厚度：混凝土 0.20 m、石膏板 0.12 m、玻璃 0.01 m、砖 0.23 m。
		expect(loss('concrete', '2.4ghz', 0.2)).toBeCloseTo(14.6, 0);
		// 按频段中心 5.5 GHz 而非 5.0 GHz 计算，20 cm 厚板在该处约多 2 dB。
		expect(loss('concrete', '5ghz', 0.2)).toBeCloseTo(26.5, 0);
		expect(loss('concrete', '6ghz', 0.2)).toBeCloseTo(30.1, 0);
		expect(loss('plasterboard', '2.4ghz', 0.12)).toBeCloseTo(2.7, 0);
		expect(loss('glass', '2.4ghz', 0.01)).toBeCloseTo(3.1, 0);
		expect(loss('glass', '6ghz', 0.01)).toBeCloseTo(0.4, 0);
		expect(loss('brick', '2.4ghz', 0.23)).toBeCloseTo(6.3, 0);
		expect(loss('wood', '5ghz', 0.15)).toBeCloseTo(5.3, 0);
	});

	it('makes thin glass less lossy at 6 GHz than at 2.4, as physics does', () => {
		// 薄玻璃在 6 GHz 的损耗低于 2.4 GHz。
		const low = ituWallLossDb('glass', BAND_FREQUENCY_GHZ['2.4ghz'], 0.01);
		const high = ituWallLossDb('glass', BAND_FREQUENCY_GHZ['6ghz'], 0.01);
		expect(high).toBeLessThan(low);
	});

	it('treats metal as opaque rather than infinite', () => {
		const loss = ituWallLossDb('metal', BAND_FREQUENCY_GHZ['5ghz'], 0.01);
		expect(loss).toBe(MAX_MATERIAL_LOSS_DB);
		expect(Number.isFinite(loss)).toBe(true);
	});

	it('grows with thickness and frequency on a real material', () => {
		const thin = ituWallLossDb('concrete', BAND_FREQUENCY_GHZ['5ghz'], 0.1);
		const thick = ituWallLossDb('concrete', BAND_FREQUENCY_GHZ['5ghz'], 0.3);
		expect(thick).toBeGreaterThan(thin);

		const low = ituEpsilon('concrete', BAND_FREQUENCY_GHZ['2.4ghz']);
		const high = ituEpsilon('concrete', BAND_FREQUENCY_GHZ['6ghz']);
		expect(
			slabLossDb(high.epsR, high.sigma, BAND_FREQUENCY_GHZ['6ghz'], 0.2)
		).toBeGreaterThan(slabLossDb(low.epsR, low.sigma, BAND_FREQUENCY_GHZ['2.4ghz'], 0.2));
	});

	it('is zero for no thickness and never negative', () => {
		expect(ituWallLossDb('concrete', 5.5, 0)).toBe(0);
		expect(ituWallLossDb('plasterboard', 2.447, 0.001)).toBeGreaterThanOrEqual(0);
	});
});
