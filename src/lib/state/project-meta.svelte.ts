import {
	DEFAULT_COVERAGE_SOFTNESS_DB,
	DEFAULT_PATH_LOSS_SCENARIO,
	type PathLossScenario
} from '../rf/propagation.js';

export const projectMeta = $state({
	name: 'Untitled Project',
	ispSpeed: 0 as number,
	targetThroughput: 25 as number,
	/**
	 * Placement optimiser policy. When false (default) optimised APs are
	 * constrained to the detected building interior; when true they may be
	 * placed anywhere on the plan.
	 */
	allowOutsideRooms: false as boolean,
	/**
	 * Lowest received level the heatmap colours, in dBm. Everything below is
	 * transparent, so this is the coverage threshold being displayed: -85 dBm is
	 * the receiver sensitivity the range model uses, and therefore matches the
	 * coverage circle drawn around each AP. Raising it narrows the visible area
	 * and increases contrast.
	 */
	// Matches COVERAGE_THRESHOLD_DBM in rf/propagation.ts, so the coloured area and
	// the reported coverage percentage describe the same region.
	heatmapRssiFloor: -70 as number,
	/**
	 * Height above the floor at which a client is assumed to sit, in metres.
	 *
	 * APs are modelled as ceiling-mounted — at `elevation + ceilingHeight` of
	 * their own floor — so this is the other end of every cross-floor path. It is
	 * a project-wide assumption rather than per-floor because it describes the
	 * client devices, not the building.
	 *
	 * The vertical gap between an AP and a client only reaches the models as a
	 * distance term (both the heatmap and the optimiser use the 3D distance), so
	 * this is a small correction: changing it by a metre moves a cross-floor level
	 * by roughly 1 dB at the path loss exponent in use. It matters for the
	 * ceiling-mount case the multi-floor work is about, and for nothing else.
	 */
	clientHeight: 1.5 as number,
	/**
	 * Weight of the co-channel interference share in the placement objective:
	 * `score = coverageUtility − interferenceWeight · interferenceShare`.
	 *
	 * Both terms are on a 0-1 scale. Zero restores the coverage-only objective the
	 * optimiser had before the term existed, which makes this the A/B switch for
	 * measuring what the term is worth, and the reason it is a project setting and
	 * not a constant: the trade is a Pareto curve, not one operating point.
	 *
	 * Default matches `DEFAULT_INTERFERENCE_WEIGHT` in rf/interference.ts (IJEAT's
	 * aggregate penalty coefficient).
	 */
	interferenceWeight: 0.2 as number,
	/**
	 * How far below the coverage threshold a sample still earns utility, in dB.
	 *
	 * The optimiser used to treat the threshold as a hard edge: a sample just
	 * outside every coverage circle and one far outside both scored 0, so it had
	 * no way to tell "nearly covered" from "not covered at all". On the
	 * coverage-limited floors the measurement was taken on that turned into real
	 * coverage — 5.3 points between restarts while the objective differed by 0.9%
	 * (`docs/ROADMAP.md` F1, second measurement).
	 *
	 * Zero restores the hard threshold exactly, which is the A/B switch. The
	 * default matches `DEFAULT_COVERAGE_SOFTNESS_DB` in rf/propagation.ts. It only
	 * changes the optimiser's landscape: the reported coverage share is still
	 * "margin above the threshold", not a sum of utilities.
	 */
	coverageSoftnessDb: DEFAULT_COVERAGE_SOFTNESS_DB as number,
	/**
	 * ε-constraint (F3): the minimum covered share the optimiser must reach, as a
	 * percentage, or 0 for no constraint.
	 *
	 * `score = coverageUtility − interferenceWeight · interference` is a weighted sum,
	 * and a weighted sum can only walk the **convex** part of the coverage/interference
	 * front — F3's sweep measured that the λ 0→0.8 stretch is convex, which is why this
	 * is not the default tool. A floor states the requirement the other way round
	 * ("this plan must cover at least X%") and is the only thing that reaches a
	 * non-convex stretch, which is also what A1's "every floor at least X%" would need.
	 *
	 * Enforced as a one-sided penalty that is exactly zero when the floor is met, so
	 * setting it back to 0 restores the objective every recorded figure was measured on.
	 */
	coverageFloorPct: 0 as number,
	/**
	 * Apply the coverage floor to **every** floor rather than to the one being optimised.
	 *
	 * Off: `coverageFloorPct` is the requirement on the floor you pressed Optimize for, which
	 * is what a single-floor run can check at all.
	 *
	 * On: an all-floor run treats it as a guarantee about the building — A1's "no floor below
	 * X%". It is enforced as one extra block: the alternating loop runs as usual, and if the
	 * weakest floor is short, that floor gets one more optimisation with the floor as its own
	 * ε. A1 notes that a weighted sum cannot express this; the reason it can be done here is
	 * that a block only ever scores one floor, so a per-floor constraint is the form that
	 * survives the decomposition.
	 */
	coverageFloorEveryFloor: false as boolean,
	/**
	 * Which ITU-R P.1238 environment the distance term is modelled for.
	 *
	 * Not a tuning knob: the tabulated coefficient already contains an average allowance
	 * for walls, and this app *also* charges every wall crossing explicitly, so a high
	 * value with fully drawn walls double-counts (20 dB at 10 m, 26 dB at 20 m —
	 * `docs/PHYSICAL_MODELS.md` §A3a). The default is the environment every figure recorded
	 * before this setting existed was taken with; the panel says which way to go in one line.
	 *
	 * Changing it moves association ranges, AP radii, coverage and every reported
	 * figure, so it is saved with the project and printed with every run.
	 */
	pathLossScenario: DEFAULT_PATH_LOSS_SCENARIO as PathLossScenario
});
