/**
 * Placement advice: what the last optimisation's own numbers imply should change.
 *
 * The optimiser answers "where should these APs go". It deliberately does not
 * answer "how many should there be" — that count is the user's input, held fixed
 * through the whole search (`optimizeFloor`'s comment on the single-floor button
 * says so: "keeping how many you placed"). So a plan can be optimally arranged
 * and still be wrong by one access point in either direction, and nothing in the
 * interface said which way.
 *
 * This module is that missing sentence, derived from figures the run already
 * produced. It is a pure function over a small context object: no state, no
 * canvas, no worker, so the rules can be read and tested on their own — and the
 * thresholds below can be argued with in `docs/AP_ADVICE.md` rather than
 * reverse-engineered from a component.
 *
 * Every rule here is a **first-order estimate**, not an optimisation. The count
 * rules assume each AP contributes an equal share of the covered area, which is
 * false in detail (an AP in a corridor covers more than one in a corner) and
 * close enough to be worth saying. They are worded as "about N" for that reason,
 * and `docs/AP_ADVICE.md` records what each one assumes.
 */

/** What a finding is about. The renderer owns the wording, this owns the rule. */
export type AdviceKind =
	| 'calibrate'
	| 'add-aps'
	| 'remove-aps'
	| 'assign-channels'
	| 'interference'
	| 'rebalance-floor'
	| 'meets-target';

/**
 * How strongly to say it.
 *
 * `action` is something to do now; `info` is worth knowing but not necessarily
 * wrong; `good` is the positive close — a plan with nothing to change should say
 * so rather than showing an empty box.
 */
export type AdviceSeverity = 'action' | 'info' | 'good';

export interface AdviceFinding {
	kind: AdviceKind;
	severity: AdviceSeverity;
	/**
	 * Values the renderer substitutes into its own translated strings.
	 *
	 * Strings, not numbers: an area-per-AP figure has already been converted to
	 * the project's display unit and formatted by the caller, and re-formatting it
	 * here would put the unit logic in two places.
	 */
	params: Record<string, string | number>;
}

/**
 * The covered share a plan is expected to reach when the user has not said.
 *
 * 80% rather than 100%: a floor's covered share counts the whole interior,
 * including the inside of cupboards and plant rooms, and an objective that
 * demands 100% of that spends access points on area nobody sits in. The number
 * is a *default* and the ε-constraint overrides it — a user who sets "no less
 * than 90%" gets advice against 90%.
 */
export const DEFAULT_COVERAGE_TARGET = 80;

/**
 * Points above the target before an AP looks redundant rather than load-bearing.
 *
 * Twelve rather than "any surplus at all": the coverage share moves by a few
 * points between otherwise identical runs (the optimiser is stochastic behind a
 * seed, and the sample set is a 200-point subsample of the interior), so a rule
 * that fired at target + 1 would be reading noise as headroom.
 */
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

/**
 * How many access points the coverage shortfall looks like.
 *
 * The linear model: `n` APs covered `c` percent, so they covered `c/n` points
 * each, and closing a `target − c` gap needs that many more of them. Written as
 * one expression rather than iterated, because iterating would dress the same
 * assumption up as a simulation.
 *
 * `coverage` is floored at 5 to keep a nearly-uncovered floor from reporting an
 * absurd count — at 0% the formula has no per-AP share to divide by, and the
 * honest answer there is "start with several", which is what the clamp and the
 * floor produce. Zero APs is not a case: the panel is not shown without them.
 */
function estimateAdditionalAps(apsOnFloor: number, coverage: number, target: number): number {
	const share = Math.max(coverage, 5);
	return clamp(Math.ceil((apsOnFloor * (target - coverage)) / share), 1, MAX_ADD);
}

/**
 * How many access points a coverage surplus looks like.
 *
 * The same model inverted: `n` APs produced `c` points of coverage from a target
 * of `target`, so `n · (c − target) / c` of them are the part above the target.
 * Rounded rather than floored so that a large surplus on a large plan can suggest
 * two, while a plan at target + 10 always suggests at least the one the clamp
 * guarantees — the point of the rule is to prompt a re-run, not to be exact.
 */
function estimateRedundantAps(apsOnFloor: number, coverage: number, target: number): number {
	return clamp(
		Math.round((apsOnFloor * (coverage - target)) / Math.max(coverage, 1)),
		1,
		MAX_REMOVE
	);
}

/**
 * Evaluate every rule against one context, in display order.
 *
 * Order is by what to do about it, not by severity: fix the scale before
 * believing any distance, then the AP count, then the channels, then the
 * interference, then the floors. The positive close is emitted only when nothing
 * else was.
 */
export function evaluateApAdvice(ctx: AdviceContext): AdviceFinding[] {
	const findings: AdviceFinding[] = [];
	const target = ctx.target > 0 ? ctx.target : DEFAULT_COVERAGE_TARGET;
	const base = { coverage: Math.round(ctx.coverage), target: Math.round(target) };

	// Nothing below is trustworthy without a scale: world units are meaningful
	// only relative to the metres-per-unit the calibration supplies, and an
	// uncalibrated project's "15 m" default radius is a guess the app made.
	if (!ctx.calibrated) {
		findings.push({ kind: 'calibrate', severity: 'info', params: {} });
	}

	if (ctx.apsOnFloor > 0 && ctx.coverage < target) {
		const count = estimateAdditionalAps(ctx.apsOnFloor, ctx.coverage, target);
		const params: Record<string, string | number> = { ...base, count };
		// The area-per-AP figure is what makes "add two" checkable against a design
		// guide, and it is only available when the boundary polygon was detected.
		if (ctx.floorAreaSqm && ctx.floorAreaSqm > 0) {
			params.areaPerAp = Math.round(ctx.floorAreaSqm / ctx.apsOnFloor);
		}
		findings.push({ kind: 'add-aps', severity: 'action', params });
	} else if (
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

	// Channels before interference: an interference figure measured against the
	// all-co-channel bound (`interferenceKnown === false`) is an upper bound, and
	// assigning channels is what turns it into a measurement.
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

	// A building mean is a mean: it can be respectable while one storey is not,
	// and the per-floor run that could fix it is a different button.
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

	// The positive close is for a panel that would otherwise be empty. Emitting it
	// beside a finding would read as "nothing to do — except this".
	if (findings.length === 0 && ctx.coverage >= target) {
		findings.push({
			kind: 'meets-target',
			severity: 'good',
			params: { ...base, count: ctx.apsOnFloor }
		});
	}

	return findings;
}
