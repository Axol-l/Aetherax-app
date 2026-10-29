/**
 * The ITU-R P.2040 model against numbers computed independently.
 *
 * The expected figures below come from Sionna RT's own equations (P.2040 §2.1.4 eqs. 43–44)
 * evaluated at normal incidence for the table's typical thickness — the same computation, done
 * outside this module, so a transcription slip in the complex algebra shows up as a wrong
 * number rather than as a plausible one.
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

		// concrete 0.20 m, plasterboard 0.12 m, glass 0.01 m, brick 0.23 m
		expect(loss('concrete', '2.4ghz', 0.2)).toBeCloseTo(14.6, 0);
		// Evaluated at the band centre (5.5 GHz), not at 5.0 — a 20 cm slab gains ~2 dB there.
		expect(loss('concrete', '5ghz', 0.2)).toBeCloseTo(26.5, 0);
		expect(loss('concrete', '6ghz', 0.2)).toBeCloseTo(30.1, 0);
		expect(loss('plasterboard', '2.4ghz', 0.12)).toBeCloseTo(2.7, 0);
		expect(loss('glass', '2.4ghz', 0.01)).toBeCloseTo(3.1, 0);
		expect(loss('glass', '6ghz', 0.01)).toBeCloseTo(0.4, 0);
		expect(loss('brick', '2.4ghz', 0.23)).toBeCloseTo(6.3, 0);
		expect(loss('wood', '5ghz', 0.15)).toBeCloseTo(5.3, 0);
	});

	it('makes thin glass less lossy at 6 GHz than at 2.4, as physics does', () => {
		// The hand-tuned table had it the other way round, because it scaled every material
		// by the same 6 GHz factor.
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
