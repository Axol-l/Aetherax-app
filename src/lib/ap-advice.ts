// 根据优化器运行结果生成用户可操作的 AP 建议

/** What a finding is about. The renderer owns the wording, this owns the rule. */
export type AdviceKind =
	| 'calibrate'
	| 'capacity'
	| 'add-aps'
	| 'remove-aps'
	| 'assign-channels'
	| 'interference'
	| 'rebalance-floor'
	| 'meets-target';

export type AdviceSeverity = 'action' | 'info' | 'good';

export interface AdviceFinding {
	kind: AdviceKind;
	severity: AdviceSeverity;
	params: Record<string, string | number>;
}

export const DEFAULT_COVERAGE_TARGET = 80;

/** Points above the target before an AP looks redundant rather than load-bearing.*/
const SURPLUS_FOR_REMOVAL = 12;

/** Co-channel interference share, in percent, at which the plan is worth reworking. */
const INTERFERENCE_HIGH = 20;

/** Contended-airtime share (CCA), in percent, at which the same is true. */
const CONTENTION_HIGH = 35;

/** Points between the building mean and its weakest floor before that floor is the story. */
const FLOOR_SPREAD = 15;

/** Never suggest more than this many new APs at once: the estimate is first-order. */
const MAX_ADD = 4;

/** Never suggest removing more than this many at once, for the same reason. */
const MAX_REMOVE = 3;

/** Everything the rules read. Assembled by the panel from live state. */
export interface AdviceContext {
	/** Access points the run arranged on the floor on screen. */
	apsOnFloor: number;
	/** That floor's covered share, 0..100, from the last completed run. */
	coverage: number;
	/** Co-channel interference share, 0..100. */
	interference: number;
	/** Contended airtime share, 0..100. */
	contention: number;
	/** Estimated concurrent devices on the floor, from room density. 0 when unknown. */
	devices: number;
	/** Concurrent clients one AP is planned to carry. 0 disables the capacity check. */
	clientsPerAp: number;
	/** The requirement: the ε-constraint when set, otherwise the default target. */
	target: number;
	/** Access points with no channel from the solver. */
	unassigned: number;
	/** False until the plan has a scale. */
	calibrated: boolean;
	/** Usable area of this floor in m², or null when it cannot be measured. */
	floorAreaSqm: number | null;
	/** True when the project has more than one storey. */
	multiFloor: boolean;
	/** Density-weighted building mean, or null when no all-floor run has happened. */
	buildingCoverage: number | null;
	/** Weakest measured floor, or null. */
	worstFloor: { name: string; coverage: number } | null;
}

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

/** How many access points the coverage shortfall looks like.*/
function estimateAdditionalAps(apsOnFloor: number, coverage: number, target: number): number {
	const share = Math.max(coverage, 5);
	return clamp(Math.ceil((apsOnFloor * (target - coverage)) / share), 1, MAX_ADD);
}

/** How many access points a coverage surplus looks like.*/
function estimateRedundantAps(apsOnFloor: number, coverage: number, target: number): number {
	return clamp(
		Math.round((apsOnFloor * (coverage - target)) / Math.max(coverage, 1)),
		1,
		MAX_REMOVE
	);
}

/** Evaluate every rule against one context, in display order.*/
export function evaluateApAdvice(ctx: AdviceContext): AdviceFinding[] {
	const findings: AdviceFinding[] = [];
	const target = ctx.target > 0 ? ctx.target : DEFAULT_COVERAGE_TARGET;
	const base = { coverage: Math.round(ctx.coverage), target: Math.round(target) };
	const requiredAps =
		ctx.clientsPerAp > 0 && ctx.devices > 0 ? Math.ceil(ctx.devices / ctx.clientsPerAp) : 0;
	const capacityShortfall = requiredAps > ctx.apsOnFloor;

	if (!ctx.calibrated) {
		findings.push({ kind: 'calibrate', severity: 'info', params: {} });
	}

	if (capacityShortfall) {
		findings.push({
			kind: 'capacity',
			severity: 'action',
			params: {
				devices: Math.round(ctx.devices),
				perAp: ctx.clientsPerAp,
				required: requiredAps,
				current: ctx.apsOnFloor
			}
		});
	}

	if (ctx.apsOnFloor > 0 && ctx.coverage < target) {
		const count = estimateAdditionalAps(ctx.apsOnFloor, ctx.coverage, target);
		const params: Record<string, string | number> = { ...base, count };

		if (ctx.floorAreaSqm && ctx.floorAreaSqm > 0) {
			params.areaPerAp = Math.round(ctx.floorAreaSqm / ctx.apsOnFloor);
		}
		findings.push({ kind: 'add-aps', severity: 'action', params });
	} else if (
		!capacityShortfall &&
		(requiredAps === 0 || ctx.apsOnFloor > requiredAps) &&
		ctx.apsOnFloor >= 2 &&
		ctx.coverage - target >= SURPLUS_FOR_REMOVAL &&
		ctx.coverage > 0
	) {
		findings.push({
			kind: 'remove-aps',
			severity: 'action',
			params: {
				...base,
				count: estimateRedundantAps(ctx.apsOnFloor, ctx.coverage, target)
			}
		});
	}

	if (ctx.unassigned > 0) {
		findings.push({
			kind: 'assign-channels',
			severity: 'action',
			params: { count: ctx.unassigned }
		});
	}

	if (ctx.interference >= INTERFERENCE_HIGH || ctx.contention >= CONTENTION_HIGH) {
		findings.push({
			kind: 'interference',
			// Below target the honest reading is "this will get worse if you add
			// APs"; at or above it, the interference is what is left to fix.
			severity: ctx.coverage >= target ? 'action' : 'info',
			params: {
				interference: Math.round(ctx.interference),
				contention: Math.round(ctx.contention)
			}
		});
	}

	if (
		ctx.multiFloor &&
		ctx.buildingCoverage !== null &&
		ctx.worstFloor &&
		ctx.buildingCoverage - ctx.worstFloor.coverage >= FLOOR_SPREAD &&
		ctx.worstFloor.coverage < target
	) {
		findings.push({
			kind: 'rebalance-floor',
			severity: 'action',
			params: {
				building: Math.round(ctx.buildingCoverage),
				coverage: Math.round(ctx.worstFloor.coverage),
				floor: ctx.worstFloor.name
			}
		});
	}

	if (findings.length === 0 && ctx.coverage >= target) {
		findings.push({
			kind: 'meets-target',
			severity: 'good',
			params: { ...base, count: ctx.apsOnFloor }
		});
	}

	return findings;
}
