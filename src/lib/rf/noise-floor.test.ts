/**
 * The zero point: one physical anchor, three thresholds stated on top of it.
 *
 * Before this the model had three independently typed dBm figures — −85 (sensitivity),
 * −70 (coverage), −82 (CCA) — with nothing tying them together. These tests pin BOTH
 * properties that matter: that the *numbers do not move* at 20 MHz (so every recorded
 * measurement still stands), and that each one is now derived from the thermal floor in a
 * way a reader can check.
 */
import { describe, expect, it } from 'vitest';
import {
	COVERAGE_MARGIN_DB,
	COVERAGE_SNR_DB,
	COVERAGE_THRESHOLD_DBM,
	RECEIVER_SENSITIVITY_DBM,
	ccaThresholdDbm,
	sensitivityDbm,
	thermalNoiseFloorDbm
} from './propagation.js';

describe('the thermal noise floor', () => {
	it('is kTB + NF at every width', () => {
		// −173.98 dBm/Hz + 10log10(20e6) + NF, with NF solved so this is exactly −85.
		expect(thermalNoiseFloorDbm(20)).toBeCloseTo(-85, 6);
		// Four times the bandwidth integrates 10·log10(4) = 6.0206 dB more noise — not a
		// tidy 6. The difference from the CCA threshold's integer 3 dB steps is real: the
		// floor is a continuous function of bandwidth, CCA is a standard's quoted table.
		expect(thermalNoiseFloorDbm(80) - thermalNoiseFloorDbm(20)).toBeCloseTo(10 * Math.log10(4), 10);
		expect(thermalNoiseFloorDbm(40) - thermalNoiseFloorDbm(20)).toBeCloseTo(10 * Math.log10(2), 10);
		expect(thermalNoiseFloorDbm(160) - thermalNoiseFloorDbm(20)).toBeCloseTo(
			10 * Math.log10(8),
			10
		);
	});

	it('falls back to 20 MHz for a width it cannot use', () => {
		expect(thermalNoiseFloorDbm(0)).toBeCloseTo(thermalNoiseFloorDbm(20), 10);
		expect(thermalNoiseFloorDbm(-5)).toBeCloseTo(thermalNoiseFloorDbm(20), 10);
	});

	it('is the sensitivity, so the two are one statement rather than two constants', () => {
		for (const width of [20, 40, 80, 160]) {
			expect(sensitivityDbm(width)).toBeCloseTo(thermalNoiseFloorDbm(width), 10);
		}
	});
});

describe('the 20 MHz figures do not move', () => {
	it('keeps the sensitivity at −85 dBm, which every coverage radius depends on', () => {
		// This is the whole reason the noise figure is 16 rather than a receiver's 4–7:
		// changing it retunes every range, coverage and interference figure on record.
		expect(RECEIVER_SENSITIVITY_DBM).toBeCloseTo(-85, 6);
	});

	it('keeps the coverage threshold at −70 dBm and therefore the margin at 15 dB', () => {
		expect(COVERAGE_THRESHOLD_DBM).toBe(-70);
		expect(COVERAGE_MARGIN_DB).toBeCloseTo(15, 6);
	});

	it('keeps the CCA threshold at −82 dBm, which is 12 dB below the coverage line', () => {
		expect(ccaThresholdDbm(20)).toBeCloseTo(-82, 10);
		// The relationship the two criteria exist for: a co-channel signal is deferrable
		// 12 dB before it stops being usable. Related through the floor, which is what the
		// anchor buys — these were three unrelated typed-in numbers before.
		expect(ccaThresholdDbm(20) - COVERAGE_THRESHOLD_DBM).toBeCloseTo(-12, 10);
		expect(COVERAGE_SNR_DB).toBeCloseTo(15, 6);
		expect(COVERAGE_SNR_DB + (ccaThresholdDbm(20) - COVERAGE_THRESHOLD_DBM)).toBeCloseTo(3, 10);
	});
});

describe('the CCA threshold scales with channel width', () => {
	it('rises 3 dB per doubling, per the standard', () => {
		expect(ccaThresholdDbm(40)).toBeCloseTo(-79, 10);
		expect(ccaThresholdDbm(80)).toBeCloseTo(-76, 10);
		expect(ccaThresholdDbm(160)).toBeCloseTo(-73, 10);
	});

	it('never goes below the standard figure for a narrower channel', () => {
		// A 10 MHz channel would give −85 by the same formula; the standard does not quote
		// one below 20 MHz, and reading *more* sensitive would over-report contention.
		expect(ccaThresholdDbm(10)).toBeCloseTo(-82, 10);
		expect(ccaThresholdDbm(5)).toBeCloseTo(-82, 10);
	});

	it('moves in the opposite direction from the noise floor, which is the point', () => {
		// A wider channel hears *more* noise but defers *less*: two different mechanisms,
		// which is exactly why CCA is quoted rather than derived from the floor.
		expect(thermalNoiseFloorDbm(80)).toBeGreaterThan(thermalNoiseFloorDbm(20));
		expect(ccaThresholdDbm(80)).toBeGreaterThan(ccaThresholdDbm(20));
	});
});
