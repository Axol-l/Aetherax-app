/**
 * 校验噪声零点：一个物理锚点，以及以它为基准的三个门限。
 * 同时锁定 20 MHz 下各项数值不变，且每个门限都由热噪声底推算得到、可供核对。
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
		// −173.98 dBm/Hz + 10log10(20e6) + NF，NF 的取值使结果恰为 −85。
		expect(thermalNoiseFloorDbm(20)).toBeCloseTo(-85, 6);
		// 带宽增至四倍，积分多出 10·log10(4) = 6.0206 dB 的噪声，并非常见的整数 6 dB；
		// 噪声底随带宽连续变化，CCA 门限则是标准给出的整数步进表。
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
		// 覆盖半径都依赖这个灵敏度取值；改动噪声系数会重新标定所有已记录的距离与干扰数值。
		expect(RECEIVER_SENSITIVITY_DBM).toBeCloseTo(-85, 6);
	});

	it('keeps the coverage threshold at −70 dBm and therefore the margin at 15 dB', () => {
		expect(COVERAGE_THRESHOLD_DBM).toBe(-70);
		expect(COVERAGE_MARGIN_DB).toBeCloseTo(15, 6);
	});

	it('keeps the CCA threshold at −82 dBm, which is 12 dB below the coverage line', () => {
		expect(ccaThresholdDbm(20)).toBeCloseTo(-82, 10);
		// 两条准则共同表达的关系：同频信号在不可用之前 12 dB 即可被推迟接入，
		// 两者经由噪声底相互关联。
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
		// 标准未给出 20 MHz 以下的取值；若按公式外推得更灵敏，会高估信道竞争程度。
		expect(ccaThresholdDbm(10)).toBeCloseTo(-82, 10);
		expect(ccaThresholdDbm(5)).toBeCloseTo(-82, 10);
	});

	it('moves in the opposite direction from the noise floor, which is the point', () => {
		// 更宽的信道噪声更大、接入门限反而更低：两种机制不同，因此 CCA 单独取值而非由噪声底推算。
		expect(thermalNoiseFloorDbm(80)).toBeGreaterThan(thermalNoiseFloorDbm(20));
		expect(ccaThresholdDbm(80)).toBeGreaterThan(ccaThresholdDbm(20));
	});
});
