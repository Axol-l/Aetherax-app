/**
 * 共用的色阶：热力图与天线面板都使用它。
 *
 * 这些测试确认色阶在所有位置上语义一致：信号越强越偏绿。
 */
import { describe, expect, it } from 'vitest';
import { rampColorAt, rampCss, RAMP_STOPS } from './heatmap-ramp.js';

describe('signal ramp', () => {
	it('starts at the weakest stop and ends at the strongest', () => {
		const weak = rampColorAt(0);
		const strong = rampColorAt(1);
		expect([weak.r, weak.g, weak.b]).toEqual([100, 35, 35]);
		expect([strong.r, strong.g, strong.b]).toEqual([40, 150, 40]);
	});

	it('runs from red at the weak end to green at the strong one', () => {
		// 不能只看绿通道：色阶中段偏黄，绿色先升后降，
		// 观者读到的是红到绿的相对关系。
		const weak = rampColorAt(0.05);
		const strong = rampColorAt(0.95);
		expect(weak.r).toBeGreaterThan(weak.g);
		expect(strong.g).toBeGreaterThan(strong.r);
		// 色阶中段偏黄，对应热力图中「可用」的区间。
		expect(rampColorAt(0.35).r).toBeGreaterThan(180);
		expect(rampColorAt(0.35).g).toBeGreaterThan(170);
	});

	it('interpolates between the stops rather than snapping to them', () => {
		// 位于红色色标到橙色色标的中点，因此不等于任一端的值。
		const middle = rampColorAt(0.075);
		expect(middle.r).toBeGreaterThan(100);
		expect(middle.r).toBeLessThan(220);
		expect(middle.g).toBeGreaterThan(35);
		expect(middle.g).toBeLessThan(120);
	});

	it('clamps outside the ramp, including a value that is not a number', () => {
		expect(rampColorAt(-5)).toEqual(rampColorAt(0));
		expect(rampColorAt(9)).toEqual(rampColorAt(1));
		expect(rampColorAt(Number.NaN)).toEqual(rampColorAt(0));
	});

	it('reads out as a CSS colour', () => {
		expect(rampCss(0, 0.5)).toBe('rgba(100, 35, 35, 0.5)');
	});

	it('has stops in ascending order, which the interpolation assumes', () => {
		for (let i = 1; i < RAMP_STOPS.length; i++) {
			expect(RAMP_STOPS[i]![0]).toBeGreaterThan(RAMP_STOPS[i - 1]![0]);
		}
	});
});
