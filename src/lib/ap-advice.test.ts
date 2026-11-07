/**
 * The advice rules decide what the sidebar tells a user to change about their
 * plan, so each threshold is pinned here: a rule that fires on the wrong side of
 * its own number is worse than no rule, because the panel reads as authoritative.
 *
 * The contexts are written out in full rather than spread from a default, so a
 * new field on `AdviceContext` shows up as a compile error in every case that has
 * to think about it.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_COVERAGE_TARGET, evaluateApAdvice, type AdviceContext } from './ap-advice.js';

/** A calibrated, measured, single-storey plan sitting on its coverage target. */
function context(overrides: Partial<AdviceContext> = {}): AdviceContext {
	return {
		apsOnFloor: 3,
		coverage: 85,
		interference: 5,
		contention: 5,
		devices: 0,
		clientsPerAp: 25,
		target: DEFAULT_COVERAGE_TARGET,
		unassigned: 0,
		calibrated: true,
		floorAreaSqm: 300,
		multiFloor: false,
		buildingCoverage: null,
		worstFloor: null,
		...overrides
	};
}

const kinds = (ctx: AdviceContext) => evaluateApAdvice(ctx).map((f) => f.kind);

describe('scale', () => {
	it('asks for a scale before anything else can be trusted', () => {
		const findings = evaluateApAdvice(context({ calibrated: false }));
		expect(findings[0]?.kind).toBe('calibrate');
		expect(findings[0]?.severity).toBe('info');
	});
});

describe('coverage shortfall', () => {
	it('suggests adding APs when coverage is below target', () => {
		const findings = evaluateApAdvice(context({ coverage: 50, apsOnFloor: 3 }));
		const add = findings.find((f) => f.kind === 'add-aps');
		expect(add?.severity).toBe('action');
		// 3 APs covered 50 points, so 30 more points is 1.8 APs → 2.
		expect(add?.params.count).toBe(2);
		expect(add?.params.areaPerAp).toBe(100);
	});

	it('omits the area detail when the boundary was never detected', () => {
		const add = evaluateApAdvice(context({ coverage: 60, floorAreaSqm: null })).find(
			(f) => f.kind === 'add-aps'
		);
		expect(add?.params.areaPerAp).toBeUndefined();
	});

	it('never suggests more than four APs at once', () => {
		const add = evaluateApAdvice(context({ coverage: 1, apsOnFloor: 1 })).find(
			(f) => f.kind === 'add-aps'
		);
		expect(add?.params.count).toBe(4);
	});

	it('does not suggest removing APs while coverage is short', () => {
		expect(kinds(context({ coverage: 70 }))).not.toContain('remove-aps');
	});
});

describe('coverage surplus', () => {
	it('suggests removing an AP only once the surplus is worth acting on', () => {
		// Five points over target is inside the run-to-run noise: no advice.
		expect(kinds(context({ coverage: 85 }))).not.toContain('remove-aps');
		// Twelve points is the threshold, and the boundary is inclusive.
		expect(kinds(context({ coverage: 92 }))).toContain('remove-aps');
	});

	it('suggests removing APs when coverage is well past target', () => {
		const remove = evaluateApAdvice(context({ coverage: 98, apsOnFloor: 6 })).find(
			(f) => f.kind === 'remove-aps'
		);
		expect(remove?.severity).toBe('action');
		// 6 APs produced 98 points against a target of 80: 18/98 of them are surplus.
		expect(remove?.params.count).toBe(1);
	});

	it('does not suggest removing the last access point', () => {
		expect(kinds(context({ coverage: 99, apsOnFloor: 1 }))).not.toContain('remove-aps');
	});

	it('measures against the user floor when one is set', () => {
		// 90% clears the default target, and is short against a 95% requirement.
		expect(kinds(context({ coverage: 90, target: 80 }))).toEqual(['meets-target']);
		expect(kinds(context({ coverage: 90, target: 95 }))).toContain('add-aps');
	});
});

describe('client capacity', () => {
	it('asks for enough APs to carry the estimated devices', () => {
		const finding = evaluateApAdvice(
			context({ devices: 100, clientsPerAp: 25, apsOnFloor: 2, coverage: 98 })
		).find((f) => f.kind === 'capacity');
		expect(finding?.severity).toBe('action');
		expect(finding?.params.required).toBe(4);
		expect(finding?.params.current).toBe(2);
	});

	it('does not call APs redundant while the capacity requirement still needs them', () => {
		const findings = evaluateApAdvice(
			context({ devices: 100, clientsPerAp: 25, apsOnFloor: 4, coverage: 98 })
		);
		expect(findings.map((f) => f.kind)).not.toContain('remove-aps');
	});

	it('turns the check off when clientsPerAp is zero', () => {
		expect(
			kinds(context({ devices: 500, clientsPerAp: 0, apsOnFloor: 1, coverage: 85 }))
		).not.toContain('capacity');
	});
});

describe('channels and interference', () => {
	it('asks for an assignment before reporting interference', () => {
		const findings = evaluateApAdvice(context({ unassigned: 2 }));
		expect(findings.map((f) => f.kind)).toContain('assign-channels');
		expect(findings.find((f) => f.kind === 'assign-channels')?.params.count).toBe(2);
	});

	it('reports interference as an action when coverage is met', () => {
		const finding = evaluateApAdvice(context({ interference: 25 })).find(
			(f) => f.kind === 'interference'
		);
		expect(finding?.severity).toBe('action');
		expect(finding?.params.interference).toBe(25);
	});

	it('reports interference as context while coverage is short', () => {
		const finding = evaluateApAdvice(context({ coverage: 60, contention: 40 })).find(
			(f) => f.kind === 'interference'
		);
		expect(finding?.severity).toBe('info');
		expect(finding?.params.contention).toBe(40);
	});

	it('stays quiet when neither interference reading is high', () => {
		expect(kinds(context({ interference: 19, contention: 34 }))).not.toContain('interference');
	});
});

describe('multi-floor spread', () => {
	it('names the weakest floor when the mean hides it', () => {
		const finding = evaluateApAdvice(
			context({
				multiFloor: true,
				buildingCoverage: 88,
				worstFloor: { name: 'Level 2', coverage: 60 }
			})
		).find((f) => f.kind === 'rebalance-floor');
		expect(finding?.params.floor).toBe('Level 2');
	});

	it('leaves a spread inside the threshold alone', () => {
		expect(
			kinds(
				context({
					multiFloor: true,
					buildingCoverage: 88,
					worstFloor: { name: 'Level 2', coverage: 75 }
				})
			)
		).not.toContain('rebalance-floor');
	});

	it('is not a single-storey concern', () => {
		expect(
			kinds(context({ buildingCoverage: 88, worstFloor: { name: 'Level 2', coverage: 40 } }))
		).not.toContain('rebalance-floor');
	});
});

describe('the positive close', () => {
	it('says so when there is nothing to change', () => {
		const findings = evaluateApAdvice(context());
		expect(findings.map((f) => f.kind)).toEqual(['meets-target']);
		expect(findings[0]?.severity).toBe('good');
		expect(findings[0]?.params.count).toBe(3);
	});

	it('is withheld whenever the panel has something else to say', () => {
		expect(kinds(context({ coverage: 98, apsOnFloor: 6 }))).not.toContain('meets-target');
		expect(kinds(context({ calibrated: false }))).not.toContain('meets-target');
	});
});
