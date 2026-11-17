/**
 * 补跑最弱层的规则：最多两轮、只在这层真的抬高时续、每轮换一段种子。
 *
 * 最后一条是这个机制以前空转的原因：同一个布局配同一组种子是确定性的，照着重跑只会
 * 重放出同一个方案。所以这里的断言一半在种子区间上。
 */
import { describe, expect, it } from 'vitest';
import { MAX_FLOOR_PASSES, nextFloorPass } from './optimizer-floor-passes.js';

/** 一轮补跑的输入，默认是“还差得远、但这一轮抬了 5 个点”。 */
function state(over: Partial<Parameters<typeof nextFloorPass>[0]> = {}) {
	return { pass: 1, before: 40, after: 45, target: 75, restarts: 1, ...over };
}

describe('nextFloorPass', () => {
	it('runs again while the floor is short and the last pass lifted it', () => {
		const next = nextFloorPass(state());
		expect(next.run).toBe(true);
		expect(next.stop).toBeNull();
	});

	it('stops once the floor reaches the requirement', () => {
		expect(nextFloorPass(state({ after: 75 }))).toEqual({
			run: false,
			seedBase: 0,
			stop: 'met'
		});
		// Above the requirement is the same case: there is nothing left to lift.
		expect(nextFloorPass(state({ after: 88 })).stop).toBe('met');
	});

	it('stops when the pass did not move the floor', () => {
		expect(nextFloorPass(state({ after: 40 })).stop).toBe('no-gain');
		// A floor that went *down* is also no reason to spend another block: the
		// committed layout is the one with the better score, so this only happens
		// on a tie in the panel's integer percent.
		expect(nextFloorPass(state({ after: 39 })).stop).toBe('no-gain');
	});

	it('stops at the budget even when the floor is still climbing', () => {
		const next = nextFloorPass(state({ pass: MAX_FLOOR_PASSES, before: 50, after: 60 }));
		expect(next).toEqual({ run: false, seedBase: 0, stop: 'budget' });
	});

	it('hands the next pass seeds the alternating loop has not used', () => {
		// The loop tried seeds 1..n for this floor. A retry must not replay them.
		expect(nextFloorPass(state({ restarts: 1 }))).toMatchObject({ run: true, seedBase: 2 });
		expect(nextFloorPass(state({ restarts: 4 }))).toMatchObject({ run: true, seedBase: 8 });
		// And a third retry (when the budget allows one) continues after the second one's
		// range, still without overlap.
		expect(
			nextFloorPass(state({ pass: 2, restarts: 4, after: 50, maxPasses: 3 }))
		).toMatchObject({
			run: true,
			seedBase: 12
		});
	});

	it('clamps a nonsense budget to one pass rather than zero', () => {
		// A budget of 0 would mean "never retry", which is not what the switch says;
		// the clamp keeps the first retry and drops the second.
		expect(nextFloorPass(state({ pass: 0, maxPasses: 0 })).run).toBe(true);
		expect(nextFloorPass(state({ pass: 1, maxPasses: 0 })).stop).toBe('budget');
		expect(nextFloorPass(state({ pass: MAX_FLOOR_PASSES })).stop).toBe('budget');
	});
});
