/// <reference lib="webworker" />

import { buildRoomDomain } from '../canvas/rooms.js';
import { clipInteriorToPlanningArea } from '../state/planning-area.js';
import { isVoidRoomType } from '../canvas/room-types.js';
import {
	COVERAGE_MARGIN_DB,
	COVERAGE_THRESHOLD_DBM,
	DEFAULT_COVERAGE_SOFTNESS_DB,
	DEFAULT_PATH_LOSS_SCENARIO,
	coverageHorizontalReach,
	coverageMarginDb,
	ccaThresholdDbm,
	coverageUtilityAboveThreshold,
	rangeFromPower,
	rayMarchWallAtten,
	reachAtMargin,
	slabDbOf,
	setPathLossScenario,
	type PathLossScenario
} from '../rf/propagation.js';
import { crossFloorSegments, slabLossFactor } from '../rf/cross-floor.js';
import { splitWallRunLoss, wallRunLoss, type WallRun } from '../rf/link-budget.js';
import { deckCrossing, surfaceHeightAt } from '../rf/surface-height.js';
import {
	antennaProfileForMount,
	antennaRayLossDb,
	azimuthLossDb,
	type AntennaProfile
} from '../rf/antenna.js';
import {
	COCHANNEL_REUSE_DB,
	DEFAULT_INTERFERENCE_WEIGHT,
	colourConflicts,
	conflictMatrix,
	conflictWeights,
	interferenceAt,
	markSampleConflicts,
	resolveChannels
} from '../rf/interference.js';
import { makeOverlapLookup } from '../rf/channel-overlap.js';
import {
	getMaterialDbTable,
	registerCustomMaterials,
	type WallMaterialId
} from '../canvas/materials.js';
import {
	planningCandidates,
	type Band,
	type ChannelWidth,
	type RegulatoryDomain
} from '@aetherax/channels';
import {
	OPTIMIZER_PAYLOAD_VERSION,
	assertApPayload
} from './optimizer-protocol.js';
import { GeometryCache } from './optimizer/geometry.js';
import { mulberry32 } from './optimizer/random.js';
import {
	allowedForAp,
	buildInteriorField,
	buildSnapTarget,
	buildWallPlacement,
	createWallCache,
	facingAt,
	snapForAp,
	snapToInterior
} from './optimizer/placement.js';
import type {
	ApInput,
	EvalContext,
	ExactEval,
	FixedApInput,
	FixedPath,
	MarginField,
	Position,
	PowerChoice,
	WallCache,
	WallPlacement
} from './optimizer/types.js';

/**
 * The message this worker accepts.
 *
 * The AP shape is `optimizer-protocol.ts`'s `ApInput`, derived from the app's own
 * `AccessPoint`, so a payload that forgets the mounting or the facing does not compile;
 * `assertApPayload` catches a caller that bypasses the type. The fields are optional here
 * because the graph-only path and the tests build messages by hand.
 */

interface OptimizeMessage {
	type: 'optimize';
	/**
	 * Identity of this request, echoed on every reply it produces.
	 *
	 * Without it the bridge had no way to tell a reply from the run it is waiting on from a
	 * reply from an earlier run that outran its cancellation, and resolved whichever promise
	 * happened to be outstanding.
	 */
	runId: string;
	aps: ApInput[];
	fixedAps: FixedApInput[];
	wallMask: Uint8Array;
	maskWidth: number;
	maskHeight: number;
	wallAttenuation: number;
	/** Decoded per-pixel wall material ids, or null when unlabelled. */
	materialMask: Uint8Array | null;
	/** Material id used for pixels that carry no explicit material label. */
	defaultMaterial: number;
	/** World units per metre, for coverage and association ranges. 0 = uncalibrated. */
	metersPerPixel: number;
	/**
	 * When false (the default) APs are constrained to the detected building
	 * interior. When true they may sit anywhere on the plan.
	 */
	allowOutside: boolean;
	/** Per-pixel device density (devices/sqm). -1 = unlabeled. Null = no room data. */
	densityMap: Float32Array | null;
	/** Median density of labeled rooms — used as baseline for unlabeled pixels. */
	medianDensity: number;
	/**
	 * Raw room type ids, same dims as the wall mask. Carries the voids: a hole
	 * contributes no density, so it cannot be recovered from the density map.
	 */
	roomTypeMask: Uint8Array | null;
	/**
	 * PRNG seed. Omit to get a random one. Either way the seed that was used
	 * comes back on the result message, so a run is repeatable after the fact.
	 */
	seed?: number;
	/**
	 * Weight of the co-channel interference share in the objective:
	 * `score = coverageUtility − interferenceWeight · interferenceShare`.
	 *
	 * Zero reduces the objective to coverage alone, which is what the optimiser
	 * did before the term existed, so the setting doubles as the A/B switch for
	 * measuring what the term is worth.
	 */
	interferenceWeight?: number;
	/**
	 * Regulatory domain, so the worker can colour the layout itself.
	 *
	 * The interference term is only meaningful against a *plausible* assignment:
	 * scoring it against the channels the layout had before the search would ask
	 * the optimiser to avoid interference the new layout may not even have. With
	 * this, every evaluation re-colours the layout it is scoring (see
	 * `colourConflicts`), which is the alternating structure `MODEL_NOTES.md` §6
	 * describes. Omitted ⇒ the worker falls back to the assignment in the payload,
	 * or to the all-co-channel bound.
	 */
	regulatoryDomain?: RegulatoryDomain;
	/**
	 * How far below the coverage threshold a sample still earns utility, in dB.
	 * Omitted ⇒ `DEFAULT_COVERAGE_SOFTNESS_DB`. Zero is the old hard threshold.
	 */
	coverageSoftnessDb?: number;
	/**
	 * ITU-R P.1238 environment the distance term assumes for this run. Omitted means the
	 * default (`closedPlan`), which is what every figure recorded before the setting was
	 * taken with.
	 */
	pathLossScenario?: PathLossScenario;
	/**
	 * Transmit power levels this run may give each AP, in dBm, descending, one list
	 * per AP in payload order (see `ApInput`).
	 *
	 * Omitted ⇒ power is not a decision variable and every AP keeps the radius the
	 * payload gave it, which is the behaviour before B4. The caller builds the lists
	 * because it knows each AP's configured power: the first entry is that AP's own,
	 * so the pass can only *reduce* power — raising it above what the user configured
	 * would be inventing a device capability, and 802.11h's TPC is a reduction.
	 */
	powerLevelsDbm?: number[][];
	/**
	 * World units per metre, for turning a power level into a coverage radius.
	 *
	 * This is the reciprocal of the main thread's `metersPerPixel` and has to agree with
	 * `radiusFromPower`, or the plan would change shape the next time the app re-derives
	 * radii on load. Zero or absent ⇒ power is left alone.
	 */
	worldUnitsPerMeter?: number;
	/**
	 * Vertical drop of a same-floor path, world units: `(ceilingHeight − clientHeight) ×
	 * worldUnitsPerMeter`.
	 *
	 * A ray descending through a wall crosses `1/cos φ` as much material as its plan path, so
	 * a march handed plan coordinates only under-charges it — 1.8× at 1 m for a 3 m ceiling
	 * and a 1.5 m client, 1.04× at 5 m (`PHYSICAL_MODELS.md` §B1). The path *loss* treats a
	 * same-floor path as 2D on purpose; the wall march cannot. Zero leaves it uncorrected.
	 */
	localVerticalDrop?: number;
	/**
	 * How deep the band of floor along a wall is, in world units — the domain a
	 * wall-mounted AP may be placed in.
	 *
	 * Sent rather than assumed because it is a physical length and this realm has no
	 * calibration: four world units is a bracket's depth on a plan drawn at the default
	 * scale, and a plan calibrated differently would get a band of a different width.
	 * See `buildWallPlacement`.
	 */
	wallBandWu?: number;
	/**
	 * Smallest inscribed radius an enclosed region may have and still be placed in, in
	 * world units. See `computeBuildingInterior`'s `minRegionRadius` and `room-domain.ts`.
	 *
	 * Omitted means zero: every enclosed region counts, which is the behaviour before
	 * cavities were understood to be a bug — the domain then includes a plan's wall
	 * cavities and drawing gaps, and an access point placed in one is what a user sees as
	 * "outside the room". The caller sends a physical length because this realm has no
	 * calibration of its own.
	 */
	minRoomRadiusWu?: number;
	/**
	 * The planning area in mask coordinates, when the user has drawn one.
	 *
	 * The placement domain is clipped to it below the void exclusion — the same rule the
	 * app's own guard applies, on the same shape — so "draw where the floor is" reaches the
	 * optimiser instead of only silencing the warnings. Omitted means not drawn, which is
	 * the inferred-interior path every plan used before the polygon existed.
	 */
	planningArea?: Array<{ x: number; y: number }> | null;
	/**
	 * Raised walking surfaces on this floor, in mask coordinates.
	 *
	 * A mezzanine's client is closer to a ceiling-mounted AP than the floor's is, and a
	 * stair climbs between the two, so the vertical gap is per *sample* as well as per
	 * AP. Geometry rather than per-sample heights because the worker builds its own
	 * sample grid. See `rf/surface-height.ts`.
	 */
	surfaces?: Array<{
		ax: number;
		ay: number;
		bx: number;
		by: number;
		heightM: number;
		topHeightM: number;
		thicknessM?: number;
		attenuationDb?: number;
	}>;
	/**
	 * The user's custom wall materials.
	 *
	 * Registered at the start of every run — the worker is long-lived and serves whatever
	 * project is loaded — so a wall painted with one of them is charged the figure the user
	 * typed instead of the built-in fallback.
	 */
	customMaterials?: Array<{
		id: number;
		name: string;
		dbPerMeter: Record<string, number>;
		typicalThickness: number;
		color: [number, number, number];
	}>;
	/**
	 * The protocol version the message was built against. See `optimizer-protocol.ts`.
	 *
	 * Optional so a hand-built message in a test stays simple, and checked when present:
	 * a bundle left in a browser cache while the app around it moved on then fails
	 * loudly instead of scoring a different model.
	 */
	payloadVersion?: number;
	/**
	 * ε-constraint (F3): the covered share the result must reach, as a 0-1 fraction.
	 *
	 * A weighted sum walks the convex part of the coverage/interference front; a floor
	 * states the requirement the other way round, and is the only way to reach a
	 * non-convex stretch. Zero (the default) is no constraint, which is the objective
	 * every figure before this was measured on.
	 */
	coverageFloor?: number;
	/**
	 * Return the conflict graph instead of placing anything.
	 *
	 * Set by the main-thread solver, which has to colour the *same* graph the
	 * objective scores: the margins and the edges come from `fillMargins` either
	 * way, so the assignment the app hands the user cannot disagree with the
	 * figure the objective reports for it. Nothing is searched, nothing is
	 * applied, and the positions in the payload are read as given.
	 */
	graphOnly?: boolean;
}

interface CancelMessage {
	type: 'cancel';
	/** The run being cancelled. A cancel that names no run in flight is ignored. */
	runId: string;
}

type InMessage = OptimizeMessage | CancelMessage;

type Run = { runId: string; cancelled: boolean };

/**
 * The run this worker is executing, or null.
 *
 * A second `optimize` while a run is still executing is answered `busy` instead of quietly
 * taking over. That is what makes the module-level `random` and `runSeed` below
 * unambiguous — with two runs interleaved, the second one's seed became the first one's
 * PRNG and the first run's result came back labelled with it.
 *
 * A cancelled run may still be finishing, so it keeps its own `Run` object: a check inside
 * it reads *its* flag, not whichever run was started afterwards.
 */
let running: Run | null = null;

/**
 * Send a message to the caller, tagged with the run it belongs to.
 *
 * Every reply goes through here, and the id is passed in rather than read from `running`:
 * a cancelled run that is still unwinding must answer with its *own* id, so the caller can
 * tell it apart from the run that replaced it. A reply without an id was the bug behind a
 * layout being reported with the next run's seed.
 */
function reply(runId: string, payload: Record<string, unknown>): void {
	self.postMessage({ ...payload, runId });
}

/**
 * Seed used when the caller does not supply one.
 *
 * Deliberately a constant. An unseeded default made two clicks on "Optimize
 * Placement" produce two different placements, which reads as a bug rather than
 * as stochastic search — and it made results impossible to compare. Pass an
 * explicit `seed` to vary it; the seed actually used is always reported back.
 */
const DEFAULT_OPTIMIZER_SEED = 20260921;

/**
 * The heavy half of a payload: the masks and the cross-floor sources.
 *
 * Sent once per plan and reused across the restarts of a floor and the repeats of a run; the
 * bridge identifies it by the identity of the arrays it is made of, so a changed plan is a
 * changed id and a fresh send.
 */
type WireGeometry = Pick<
	OptimizeMessage,
	| 'wallMask'
	| 'maskWidth'
	| 'maskHeight'
	| 'materialMask'
	| 'densityMap'
	| 'medianDensity'
	| 'roomTypeMask'
	| 'fixedAps'
>;

type WireMessage = Omit<OptimizeMessage, keyof WireGeometry> &
	Partial<WireGeometry> & { geometryId?: string; geometryReused?: boolean };

/**
 * The plan this worker was last sent.
 *
 * One slot, because one run executes at a time (see `running`) and the caller waits for each
 * result. The bridge clears its own idea of what is loaded whenever it creates or terminates a
 * worker, which is the only way the two can legitimately disagree — and a disagreement is
 * refused rather than scored, because a run against another plan's masks produces a believable
 * layout of the wrong floor. See `workers/optimizer/geometry.js`.
 */
const geometryCache = new GeometryCache<WireGeometry>();

/** The geometry a message needs, from the message itself or from what this worker holds. */
function geometryFor(msg: WireMessage): WireGeometry | null {
	const carried =
		msg.wallMask && msg.maskWidth !== undefined && msg.maskHeight !== undefined
			? {
					id: msg.geometryId ?? '',
					geometry: {
						wallMask: msg.wallMask,
						maskWidth: msg.maskWidth,
						maskHeight: msg.maskHeight,
						materialMask: msg.materialMask ?? null,
						densityMap: msg.densityMap ?? null,
						medianDensity: msg.medianDensity ?? 0,
						roomTypeMask: msg.roomTypeMask ?? null,
						fixedAps: msg.fixedAps ?? []
					}
				}
			: null;
	return geometryCache.resolve(carried, msg.geometryId, msg.geometryReused);
}
self.onmessage = (event: MessageEvent<InMessage | WireMessage>) => {
	const msg = event.data;
	if (msg.type === 'cancel') {
		// Only the run it names. A cancel can arrive after its run has already finished —
		// the caller aborted and moved on — and taking it would stop the run that replaced
		// it, which is a run the user has just asked for.
		if (running && running.runId === msg.runId) running.cancelled = true;
		return;
	}
	if (msg.type !== 'optimize') return;

	if (running && !running.cancelled) {
		reply(msg.runId, { type: 'busy' });
		return;
	}

	const run: Run = { runId: msg.runId, cancelled: false };
	const geometry = geometryFor(msg);
	if (!geometry) {
		// The message expected this worker to be holding a plan it is not. Reported rather than
		// scored: running against no masks would produce a believable layout of the wrong plan.
		reply(msg.runId, {
			type: 'result',
			positions: msg.aps.map((a) => ({ id: a.id, x: a.x, y: a.y })),
			score: 0,
			improvement: 0,
			error: 'the optimiser worker was not given this plan'
		});
		return;
	}
	running = run;
	runOptimization(msg, run, geometry)
		.catch((err) => {
			reply(msg.runId, {
				type: 'result',
				positions: msg.aps.map((a) => ({ id: a.id, x: a.x, y: a.y })),
				score: 0,
				improvement: 0,
				error: String(err)
			});
		})
		.finally(() => {
			// Only the run that still owns the slot clears it: a cancelled run finishing
			// after its replacement started must not make the worker look idle.
			if (running === run) running = null;
		});
};



// ─── Evaluation ─────────────────────────────────────────────────────────



/**
 * The antenna profile of every AP being placed, at one layout.
 *
 * A wall-mounted unit's pattern turns with the wall it is on, so its profile is a
 * function of *where it is*: the search slides it along a wall, around corners too, and
 * each of those positions has its own direction. Every other mounting's profile is
 * fixed for the run, so a run with no wall mounts gets the array built once and no
 * per-evaluation work at all.
 */
function resolveApProfiles(positions: Position[], ctx: EvalContext): AntennaProfile[] {
	if (!ctx.wallPlacement || !ctx.wallMounted.some(Boolean)) return ctx.apProfiles;
	const out = ctx.apProfiles.slice();
	for (let a = 0; a < positions.length; a++) {
		if (!ctx.wallMounted[a]) continue;
		const facing = facingAt(ctx.wallPlacement, positions[a]!.x, positions[a]!.y, ctx.w, ctx.h);
		// Off the band (the search has just moved it, or the mask has no wall there):
		// the profile the payload described still applies, which is where the run
		// started.
		if (facing === null) continue;
		out[a] = antennaProfile({ ...ctx.apSources[a]!, mount: 'wall', facingDeg: facing });
	}
	return out;
}

/**
 * An access point's antenna profile, from what the payload carries.
 *
 * The broadside floor is per band and not sent: it is a property of the antenna
 * class rather than a per-AP setting, and both ends read it from the same table. The
 * mount and the facing *are* sent, because a wall-mounted unit has a horizontal cut
 * and the rule that gives it one lives in `rf/antenna.ts` so that this worker and the
 * main thread cannot disagree about it.
 */
function antennaProfile(ap: {
	beamwidthDeg?: number;
	aimDeg?: number;
	mount?: string | null;
	facingDeg?: number;
	band: Band;
}): AntennaProfile {
	return antennaProfileForMount({
		band: ap.band,
		beamwidthDeg: ap.beamwidthDeg,
		aimDeg: ap.aimDeg,
		mount: ap.mount,
		facingDeg: ap.facingDeg
	});
}

/**
 * One access point's place in the search.
 *
 * `radius` is the association range, which is a 3D distance; the horizontal part
 * is what the search moves, so every evaluation converts back through
 * `sourceMargin`.
 */

/**
 * Build the per-sample path data for every fixed AP that has a mask for its own
 * floor, or room types for the slab it crosses.
 *
 * Computed once per run, alongside the per-band caches, and reused by every
 * evaluation — the search moves the optimised floor's APs, and none of this
 * depends on where they are.
 */
function buildFixedPaths(
	fixedAps: readonly FixedApInput[],
	samples: ReadonlyArray<{ x: number; y: number }>,
	mask: Uint8Array,
	w: number,
	h: number,
	materialMask: Uint8Array | null,
	defaultMaterial: number,
	wallAttenuation: number
): FixedPath[] {
	const numSamples = samples.length;
	return fixedAps.map((fap) => {
		// Slab loss can be waived at a hole even when there is no wall split to make
		// (an AP ceiling-mounted on the storey below crosses the slab at its own
		// position), so this is built independently of `source`.
		let slabFactor: Float32Array | null = null;
		const slabs = fap.slabs;
		if (slabs && slabs.length > 0) {
			slabFactor = new Float32Array(numSamples);
			for (let s = 0; s < numSamples; s++) {
				const sample = samples[s]!;
				// One multiplier per sample over *all* the crossings: each void share
				// is subtracted, so N storeys with k holes waive exactly k/N of a
				// uniform aggregate. See `slabLossFactor`.
				slabFactor[s] = slabLossFactor(slabs, fap.x, fap.y, sample.x, sample.y);
			}
		}

		const src = fap.source;
		if (!src) return { split: null, slabFactor };
		const sourceT = fap.sourceT ?? 0;
		const targetT = fap.targetT ?? 0;
		// Nothing to split: the AP is on this floor, or level with its client, so the
		// caller's single-floor path is already the right one.
		if (sourceT <= 0 && targetT <= 0) return { split: null, slabFactor };

		const db = getMaterialDbTable(fap.band);
		// Without a material map every wall costs the same, so honour each floor's
		// own project-level attenuation rather than substituting Drywall's value.
		const targetDefault = materialMask ? (db[defaultMaterial] ?? wallAttenuation) : wallAttenuation;
		const sourceDefault = src.materialMask
			? (db[src.defaultMaterial] ?? wallAttenuation)
			: wallAttenuation;

		const sourceRow = new Float32Array(numSamples);
		const suffixRow = new Float32Array(numSamples);
		for (let s = 0; s < numSamples; s++) {
			const sample = samples[s]!;
			const seg = crossFloorSegments(sourceT, targetT, fap.x, fap.y, sample.x, sample.y);
			if (!seg) continue;
			sourceRow[s] = rayMarchWallAtten(
				src.data,
				src.width,
				src.height,
				src.materialMask,
				db,
				sourceDefault,
				seg.source.from.x - src.originX,
				seg.source.from.y - src.originY,
				seg.source.to.x - src.originX,
				seg.source.to.y - src.originY,
				3,
				src.defaultMaterial
			);
			// Marched from the crossing rather than taken as "the whole run minus its
			// prefix": the marcher's step size follows the segment length, so a prefix
			// march is not a prefix of the full march and the subtraction could move a
			// thin wall across a step boundary.
			suffixRow[s] = rayMarchWallAtten(
				mask,
				w,
				h,
				materialMask,
				db,
				targetDefault,
				seg.target.from.x,
				seg.target.from.y,
				seg.target.to.x,
				seg.target.to.y,
				3,
				defaultMaterial
			);
		}
		return { split: { source: sourceRow, suffix: suffixRow }, slabFactor };
	});
}

/**
 * The loss a deck costs a path that crosses it.
 *
 * Shared by every evaluator for the same reason `sampleLift` is: one rule, so the fast
 * pass, the exact pass and the polishing pass cannot disagree about a mezzanine. The gap is
 * in world units and the deck's thickness is in metres, hence the scale.
 */
function deckLossAt(ctx: EvalContext, x: number, y: number, gapWu: number): number {
	if (ctx.surfaces.length === 0) return 0;
	const crossing = deckCrossing(ctx.surfaces, x, y, gapWu / (ctx.wupm || 1));
	return crossing ? crossing.lossDb : 0;
}

function evaluateCoverage(
	positions: Position[],
	caches: Map<Band, WallCache>,
	ctx: EvalContext
): number {
	const { samples, fixedAps, sampleDensity, fixedPaths } = ctx;
	// Resolve each source's attenuation row once per evaluation. The row depends
	// only on the source position, so it is invariant across samples; `tableFor`
	// memoises it across evaluations too.
	const emptyRow = new Float32Array(samples.length);
	const softness = ctx.coverageSoftnessDb;
	// A wall mount's pattern turns with the wall it is on, so the profiles are
	// resolved from this layout rather than read straight off the context.
	const apProfiles = resolveApProfiles(positions, ctx);
	const apRows: Float32Array[] = new Array(positions.length);
	for (let a = 0; a < positions.length; a++) {
		const c = caches.get(positions[a]!.band);
		apRows[a] = c ? c.tableFor(positions[a]!.x, positions[a]!.y) : emptyRow;
	}
	const fixedRows: Float32Array[] = new Array(fixedAps.length);
	const fixedSlabDb = new Float64Array(fixedAps.length);
	for (let f = 0; f < fixedAps.length; f++) {
		const c = caches.get(fixedAps[f]!.band);
		fixedRows[f] = c ? c.tableFor(fixedAps[f]!.x, fixedAps[f]!.y) : emptyRow;
		fixedSlabDb[f] = slabDbOf(fixedAps[f]!.signalScale);
	}

	let totalWeighted = 0;
	let totalWeight = 0;
	/** Density-weighted share that is covered, for the ε-constraint. See below. */
	let coveredWeighted = 0;
	const count = positions.length + fixedAps.length;
	// Every sample's margins are kept, and the conflict graph built from them,
	// because the channels can only be decided once the *whole* layout has been
	// seen: which pairs must not share a channel is a property of the layout, not
	// of one sample. Nothing extra is marched — the loss rows above are already
	// computed.
	const allMargins = new Float64Array(samples.length * count);
	const conflicts = conflictMatrix(count);
	/*
	 * How much each conflict costs, so the colourer can leave the cheapest one standing
	 * when the palette is short: one sample where two APs meet at a corridor corner is
	 * not the same edge as a whole room they both serve. See `conflictWeights`.
	 */
	const weights = conflictWeights(count);
	for (let s = 0; s < samples.length; s++) {
		// One margin per source, evaluated out to the *utility* horizon
		// (`coverageSoftnessDb` below the threshold). What the interference term and
		// the covered share see is that same number where it is positive and
		// -Infinity everywhere else, which is exactly the coverage circle — the
		// domain the interference model has always had, and it stays that way when
		// the objective's threshold is softened. `best` is the utility margin, and a
		// positive one is inside some circle, so it also decides "covered".
		let best = -Infinity;
		const base = s * count;
		let k = 0;
		for (let a = 0; a < positions.length; a++) {
			const ap = positions[a]!;
			const dx = samples[s]!.x - ap.x;
			const dy = samples[s]!.y - ap.y;
			const dist = Math.sqrt(dx * dx + dy * dy);
			// The AP's mounting gap less what the client stands on. Signed, and a
			// magnitude where a distance is wanted — see `sampleLift`.
			const gap = (ctx.apGaps[a] ?? 0) - (ctx.sampleLift?.[s] ?? 0);
			const profile = apProfiles[a]!;
			/*
			 * Past the utility horizon there is no margin to record: the row's own
			 * `sourceMargin` would return -Infinity for it a moment later, and the
			 * antenna's horizontal cut only ever removes margin, so asking the cut for
			 * its own reach first drops the far half of a wall mount's circle — and the
			 * trig that goes with it — before anything is evaluated.
			 */
			if (dist >= sourceHorizonToward(ap.radius, 0, gap, softness, profile, dx, dy)) {
				allMargins[base + k++] = -Infinity;
				continue;
			}
			const row = apRows[a]![s]!;
			// Same-floor, but not flat: the AP's own mounting height is part of the
			// distance, and its antenna's cuts are part of the loss. A deck between the
			// two is charged here, on the same rule as the heatmap and the live figure.
			const deckLoss = deckLossAt(ctx, samples[s]!.x, samples[s]!.y, gap);
			const wide =
				sourceMargin(dist, ap.radius, row + deckLoss, gap, -softness) -
				antennaRayLossDb(profile, gap, dx, dy);
			allMargins[base + k++] = wide > 0 ? wide : -Infinity;
			if (wide > best) best = wide;
		}
		// Include fixed APs from other floors (attenuated by floor slab)
		for (let f = 0; f < fixedAps.length; f++) {
			const fap = fixedAps[f]!;
			const dx = samples[s]!.x - fap.x;
			const dy = samples[s]!.y - fap.y;
			const dist = Math.sqrt(dx * dx + dy * dy);
			// Both runs when the floor is split, the projected run otherwise.
			const path = fixedPaths[f];
			const split = path?.split;
			const wallDb = split ? split.source[s]! + split.suffix[s]! : fixedRows[f]![s]!;
			// A hole in the slab costs nothing there.
			const slabDb =
				path?.slabFactor != null ? fixedSlabDb[f]! * path.slabFactor[s]! : fixedSlabDb[f]!;
			const loss = wallDb + slabDb;
			// A fixed AP's gap is measured to this floor's floor; the client may be
			// standing higher than that.
			const fixedGap = fap.verticalGap - (ctx.sampleLift?.[s] ?? 0);
			const wide =
				sourceMargin(
					dist,
					fap.interferenceRadius,
					loss + deckLossAt(ctx, samples[s]!.x, samples[s]!.y, fixedGap),
					fixedGap,
					-softness
				) - antennaRayLossDb(ctx.fixedProfiles[f]!, fixedGap, dx, dy);
			allMargins[base + k++] = wide > 0 ? wide : -Infinity;
			if (wide > best) best = wide;
		}
		const w = sampleDensity[s] ?? 1;
		totalWeighted += coverageUtilityAboveThreshold(best, ctx.coverageSoftnessDb) * w;
		if (best > 0) coveredWeighted += w;
		totalWeight += w;
		// The sample's density is its cost as a conflict: the edges that matter are the
		// ones over floor somebody is on.
		markSampleConflicts(conflicts, allMargins, k, base, ctx.sourceBands, weights, w);
	}
	const interference = interferenceShare(allMargins, conflicts, samples.length, count, ctx, weights);
	const utility = totalWeight > 0 ? totalWeighted / totalWeight : 0;
	// The ε-constraint has to be visible to *every* stage that scores a candidate, not
	// only to the exact polish at the end. Lloyd's and PSO call this evaluator, so
	// without the term here the bulk of the search would hill-climb a different objective
	// from the one that accepts the result — and a floor set to pull a plan *up* to a
	// coverage level would mostly be acting after the search had already committed.
	//
	// The penalty is exactly zero when no floor is set, so this is a no-op on the
	// objective every figure before the constraint was recorded on.
	const covered = totalWeight > 0 ? coveredWeighted / totalWeight : 0;
	const shortfall = ctx.coverageFloor > 0 ? Math.max(0, ctx.coverageFloor - covered) : 0;
	return utility - ctx.interferenceWeight * interference - COVERAGE_FLOOR_MULTIPLIER * shortfall;
}

/**
 * Share of the density-weighted samples whose best server is degraded by a
 * co-channel secondary, under the channels this layout would be given.
 *
 * Colouring here rather than once per run is the alternating structure
 * `MODEL_NOTES.md` §6 describes: the optimiser never scores a layout against the
 * channels it happened to have before the search, which is what would ask it to
 * avoid interference the new layout may not even produce. `sourceAllowed` is null
 * when the caller supplied no regulatory domain, and then the assignment in the
 * payload is used as given.
 */
function interferenceShare(
	allMargins: Float64Array,
	conflicts: Uint8Array,
	sampleCount: number,
	count: number,
	ctx: EvalContext,
	weights: Float32Array | null = null
): number {
	if (count === 0 || sampleCount === 0) return 0;
	const channels = ctx.sourceAllowed
		? colourConflicts(conflicts, count, ctx.sourceAllowed, ctx.overlap, weights)
		: ctx.sourceChannels;
	let interferingWeight = 0;
	let totalWeight = 0;
	for (let i = 0; i < sampleCount; i++) {
		const w = ctx.sampleDensity[i] ?? 1;
		totalWeight += w;
		// Graded, not a count: the figure is "how much of the floor's best server is
		// spoiled", so two partially overlapping 80 MHz channels cost less than a full
		// reuse. With `ctx.overlap` at its default this is the old yes/no term
		// exactly — see `interferenceAt`.
		interferingWeight +=
			w * interferenceAt(allMargins, channels, count, i * count, ctx.sourceBands, ctx.overlap);
	}
	return totalWeight > 0 ? interferingWeight / totalWeight : 0;
}

/**
 * Margin in dB of one source at one sample, above the coverage threshold.
 *
 * This is the quantity both the coverage utility and the interference term are
 * built from: utility is the margin clamped and scaled, and interference compares
 * two sources' margins at the same sample. Splitting it out is what lets the
 * evaluators derive both from one pass instead of scoring the same sample twice.
 *
 * `horizonDb` is how far below the threshold the caller still cares. It is 0 for
 * the coverage/interference margin, which exists only inside the coverage circle,
 * and `-coverageSoftnessDb` for the utility, which keeps a gradient out there —
 * see `DEFAULT_COVERAGE_SOFTNESS_DB`. Returns -Infinity past that horizon.
 *
 * `lossDb` must be the loss that actually applies — a slab waived at a hole
 * included.
 */
function sourceMargin(
	dist: number,
	radius: number,
	lossDb: number,
	verticalGap = 0,
	horizonDb = 0
): number {
	// `dist` is the horizontal run; the reach is measured in 3D, so a vertical gap
	// eats into it before the horizontal part starts.
	if (dist >= coverageHorizontalReach(radius, lossDb, verticalGap, horizonDb)) return -Infinity;
	const d3 = verticalGap > 0 ? Math.hypot(dist, verticalGap) : dist;
	return coverageMarginDb(d3, radius) - lossDb - COVERAGE_MARGIN_DB;
}

/**
 * Horizontal distance out to which a source has to be marched at all.
 *
 * The widest of the two horizons the evaluators read from a source: the
 * interference one (a co-channel secondary counts while it is within
 * `COCHANNEL_REUSE_DB` of the best server) and the utility one (a sample still
 * earns a little utility `coverageSoftnessDb` below the threshold). Skipping a
 * source before this leaves a sample with no margin where the caller needed one.
 *
 * Wider than the coverage reach on purpose: both horizons are *below* the
 * coverage threshold, so a source that cannot cover the sample can still spoil it
 * (or be worth placing for). Ten dB further out at n = 4 is 1.78x the coverage
 * reach. The result is horizontal — a source on another floor has spent part of
 * the budget travelling vertically.
 */
function sourceHorizon(
	radius: number,
	lossDb: number,
	verticalGap: number,
	softnessDb: number
): number {
	const reach = reachAtMargin(radius, lossDb, -Math.max(COCHANNEL_REUSE_DB, softnessDb));
	if (verticalGap <= 0) return reach;
	return Math.sqrt(Math.max(0, reach * reach - verticalGap * verticalGap));
}

/**
 * The same horizon, tightened by the antenna's horizontal cut in the sample's own
 * direction.
 *
 * A wall-mounted unit's cut is a *direction*: the back of its coverage circle carries
 * the front-to-back loss, so whether a sample can matter at all is decided by a fold
 * and a comparison rather than by a ray march. For an upright omni there is no cut and
 * this is the plain horizon — one extra comparison, which is why the evaluators can
 * afford to ask per sample instead of budgeting for the worst case.
 *
 * Exact, not conservative: the cut only ever removes margin, so a sample past the
 * reach this returns cannot produce a margin that either the utility or the
 * interference term reads, whatever lies between the two points.
 */
function sourceHorizonToward(
	radius: number,
	lossDb: number,
	verticalGap: number,
	horizonDb: number,
	profile: AntennaProfile,
	dx: number,
	dy: number
): number {
	if (profile.azBeamwidthDeg === undefined) {
		return sourceHorizon(radius, lossDb, verticalGap, horizonDb);
	}
	const bearing = (Math.atan2(dy, dx) * 180) / Math.PI;
	const cut = azimuthLossDb(bearing, profile);
	// `azimuthLossDb` returns a plain number: 0 is the common case even for a wall
	// mount, and it wants the cheap path.
	return cut === 0
		? sourceHorizon(radius, lossDb, verticalGap, horizonDb)
		: sourceHorizon(radius, lossDb + cut, verticalGap, horizonDb);
}

/**
 * Everything an evaluator needs besides the AP positions.
 *
 * Bundled deliberately. These used to be eleven positional parameters, the last
 * three of them optional. A call site that omitted the optional ones did not
 * fail to compile — it silently scored against a DIFFERENT model. That is
 * exactly what happened when material-aware scoring reached one call site but
 * not the others: the coordinate-descent baseline and its candidates were
 * measured with two different models, so `improved` stayed true on every sweep
 * and the loop never terminated.
 *
 * With a single context object there is no way to supply part of the
 * configuration: either the whole thing is passed, or it does not typecheck.
 */

function fillMargins(positions: Position[], ctx: EvalContext): MarginField {
	const {
		samples,
		mask,
		w,
		h,
		wallAttenuation,
		fixedAps,
		materialMask,
		defaultMaterial
	} = ctx;
	// Material tables are per band; build each band's tables at most once.
	const dbByBand = new Map<Band, number[]>();
	const tablesFor = (band: Band): number[] => {
		let db = dbByBand.get(band);
		if (!db) {
			db = getMaterialDbTable(band);
			dbByBand.set(band, db);
		}
		return db;
	};
	// Without a material map every wall costs the same, so honour the project's
	// explicit wall attenuation rather than silently substituting Drywall.
	const defaultDbFor = (band: Band): number =>
		materialMask ? (tablesFor(band)[defaultMaterial] ?? wallAttenuation) : wallAttenuation;


	/** This worker's own mask, in its own coordinates, as a run the march takes. */
	const targetRun = (band: Band): WallRun => ({
		mask,
		width: w,
		height: h,
		materialMask,
		materialDb: tablesFor(band),
		fallbackDb: defaultDbFor(band),
		originX: 0,
		originY: 0,
		defaultMaterialId: defaultMaterial
	});

	const lossFor = (band: Band, x0: number, y0: number, x1: number, y1: number): number =>
		wallRunLoss(targetRun(band), { x: x0, y: y0 }, { x: x1, y: y1 }, 1);

	/**
	 * Wall loss from a fixed AP to one sample, split at the slab when the AP's own
	 * floor's mask is available.
	 *
	 * Marched at stride 1 like everything else in this pass, so the split is as
	 * exact as the single-floor path it replaces rather than inheriting the fast
	 * pass's stride-3 approximation. The split itself (`splitWallRunLoss`) is shared
	 * with the coverage pass and the heatmap.
	 */
	const fixedLossFor = (fap: FixedApInput, sx: number, sy: number): number => {
		const src = fap.source;
		if (!src) return lossFor(fap.band, fap.x, fap.y, sx, sy);

		const tables = tablesFor(fap.band);
		const sourceDefault = src.materialMask
			? (tables[src.defaultMaterial] ?? wallAttenuation)
			: wallAttenuation;
		const split = splitWallRunLoss(
			{
				mask: src.data,
				width: src.width,
				height: src.height,
				materialMask: src.materialMask,
				materialDb: tables,
				fallbackDb: sourceDefault,
				originX: src.originX,
				originY: src.originY,
				defaultMaterialId: src.defaultMaterial
			},
			targetRun(fap.band),
			fap.sourceT ?? 0,
			fap.targetT ?? 0,
			{ x: fap.x, y: fap.y },
			{ x: sx, y: sy },
			1
		);
		return split ?? lossFor(fap.band, fap.x, fap.y, sx, sy);
	};

	// Density weighting is the scorer's business, not the field's: the margins and
	// the graph are the same whatever weight a sample carries, which is why
	// `sampleDensity` is read in `scoreMargins` and not here.
	const fixedSlabDb = fixedAps.map((fap) => slabDbOf(fap.signalScale));
	const softness = ctx.coverageSoftnessDb;
	// A wall mount's profile depends on where it is, so it is resolved per layout —
	// see `evaluateCoverage`.
	const apProfiles = resolveApProfiles(positions, ctx);
	// How far below the coverage threshold a source is still marched, and how deep a
	// margin is still kept for the *contention* figure (B4/B5). A station defers to
	// co-channel energy above the CCA preamble-detect threshold, −82 dBm at 20 MHz,
	// which is 12 dB below the −70 dBm coverage threshold this model counts from. The
	// objective's own margins stay clipped at the coverage circle; this second array
	// is what lets the report say how much airtime a plan actually shares.
	const horizon = Math.max(softness, CCA_BELOW_THRESHOLD_DB);
	// Every sample's margins are kept, exactly as in `evaluateCoverage`: the
	// conflict graph and the colouring are properties of the whole layout, so they
	// cannot be finished before the last sample has been marched. This pass
	// already marches every source at every sample, so keeping the numbers costs
	// memory and no propagation.
	const count = positions.length + fixedAps.length;
	const allMargins = new Float64Array(samples.length * count);
	const ccaMargins = new Float64Array(samples.length * count);
	const conflicts = conflictMatrix(count);
	// The same weighting as the fast pass: the graph the objective scores and the graph
	// the solver colours agree about how much each edge costs, not only about where it
	// is. See `conflictWeights`.
	const weights = conflictWeights(count);
	const bestBySample = new Float64Array(samples.length);
	const utilityMargin = new Float64Array(samples.length);
	for (let si = 0; si < samples.length; si++) {
		const sample = samples[si]!;
		const base = si * count;
		// Best margin, for the reason given in `evaluateCoverage`: the utility is a
		// monotone function of it, and a positive one is inside a coverage circle —
		// so one number per sample yields the utility, the covered flag and the
		// interference input (`best > 0 ? best : -Infinity`).
		let best = -Infinity;
		let k = 0;
		// What the client is standing on, in world units. Zero without raised surfaces.
		const lift = ctx.sampleLift?.[si] ?? 0;
		for (let ai = 0; ai < positions.length; ai++) {
			const ap = positions[ai]!;
			const gap = (ctx.apGaps[ai] ?? 0) - lift;
			const dx = sample.x - ap.x;
			const dy = sample.y - ap.y;
			const dist = Math.sqrt(dx * dx + dy * dy);
			// Skip the ray march entirely when no horizon can reach. The widest is
			// whichever of the interference distance (a co-channel secondary counts
			// while it is within `COCHANNEL_REUSE_DB` of the best server) and the
			// utility horizon (`coverageSoftnessDb` below the threshold) reaches
			// further. A same-floor AP's vertical gap eats into that reach first, and a
			// wall mount's horizontal cut eats into it in the sample's own direction —
			// see `sourceHorizonToward`.
			if (
				dist >=
				sourceHorizonToward(ap.radius, 0, gap, horizon, apProfiles[ai]!, dx, dy)
			) {
				allMargins[base + k] = -Infinity;
				ccaMargins[base + k] = -Infinity;
				k++;
				continue;
			}
			const loss = lossFor(ap.band, ap.x, ap.y, sample.x, sample.y);
			// The pruning test above stays at the *best case* on the wall loss on
			// purpose: it can only remove margin, so a source that cannot reach without
			// it cannot reach with it either, and the horizon stays conservative.
			const margin =
				sourceMargin(
					dist,
					ap.radius,
					loss + deckLossAt(ctx, sample.x, sample.y, gap),
					gap,
					-horizon
				) - antennaRayLossDb(apProfiles[ai]!, gap, dx, dy);
			allMargins[base + k] = margin > 0 ? margin : -Infinity;
			ccaMargins[base + k] = margin > -CCA_BELOW_THRESHOLD_DB ? margin : -Infinity;
			k++;
			if (margin > best) best = margin;
		}
		for (let fi = 0; fi < fixedAps.length; fi++) {
			const fap = fixedAps[fi]!;
			const dx = sample.x - fap.x;
			const dy = sample.y - fap.y;
			const dist = Math.sqrt(dx * dx + dy * dy);
			const slabDb = fixedSlabDb[fi]!;
			// A hole in the slab costs nothing there. Decided before the reach test:
			// with a full slab's loss the 3D reach can be shorter than the vertical gap,
			// and the source would then be discarded before anything noticed the hole.
			//
			// Computed here rather than read from `fixedPaths` because the walls this pass
			// uses are marched at stride 1 while `fixedPaths` holds stride-3 rows: mixing
			// the two would put the exact margin next to an approximate one. The slab
			// factor itself is an exact point sample along the ray in both places, so this
			// is about the wall term, not about the slab.
			const slabs = fap.slabs;
			let slabLoss = slabDb;
			if (slabs && slabs.length > 0) {
				// One multiplier over every crossing: a gap of more than one storey waives
				// only the shares whose own slab is a hole.
				slabLoss = slabDb * slabLossFactor(slabs, fap.x, fap.y, sample.x, sample.y);
			}
			// A fixed AP's gap is measured to this floor's floor; the client may be
			// standing higher than that.
			const fixedGap = fap.verticalGap - lift;
			if (
				!(slabDb < Infinity) ||
				dist >=
					sourceHorizonToward(
						fap.interferenceRadius,
						slabLoss,
						fixedGap,
						horizon,
						ctx.fixedProfiles[fi]!,
						dx,
						dy
					)
			) {
				allMargins[base + k] = -Infinity;
				ccaMargins[base + k] = -Infinity;
				k++;
				continue;
			}
			const loss = fixedLossFor(fap, sample.x, sample.y) + slabLoss;
			const margin =
				sourceMargin(
					dist,
					fap.interferenceRadius,
					loss + deckLossAt(ctx, sample.x, sample.y, fixedGap),
					fixedGap,
					-horizon
				) - antennaRayLossDb(ctx.fixedProfiles[fi]!, fixedGap, dx, dy);
			allMargins[base + k] = margin > 0 ? margin : -Infinity;
			ccaMargins[base + k] = margin > -CCA_BELOW_THRESHOLD_DB ? margin : -Infinity;
			k++;
			if (margin > best) best = margin;
		}
		bestBySample[si] = best;
		utilityMargin[si] = best;
		markSampleConflicts(
			conflicts,
			allMargins,
			k,
			base,
			ctx.sourceBands,
			weights,
			ctx.sampleDensity[si] ?? 1
		);
	}
	return { allMargins, ccaMargins, conflicts, weights, bestBySample, utilityMargin, count };
}

/**
 * How far below the coverage threshold the contention figure looks, in dB, **at the
 * narrowest channel width in the run**.
 *
 * 802.11's clear-channel assessment defers to co-channel energy above the preamble detect
 * threshold: −82 dBm for a 20 MHz channel, 3 dB higher per doubling of width. The model's
 * levels are margins above the −70 dBm coverage threshold, so 20 MHz is −12 dB and 80 MHz
 * is −6 dB. This used to be a constant at the 20 MHz value, which made a wide-channel plan
 * read its contention share high; it now comes from `ccaThresholdDbm` per run.
 *
 * **Known gap: this is the 20 MHz figure and it does not scale with channel width.** The
 * preamble-detect threshold rises 3 dB per doubling of width (−82 / −79 / −76 / −73 dBm
 * for 20 / 40 / 80 / 160 MHz), so an 80 MHz plan should be using −6 dB here rather than
 * −12 dB and this figure reads *high* for wide channels. Every measurement scenario is
 * 20 MHz, which is why it has not mattered yet; the width scaling belongs with the
 * criterion rather than with the instrument that reports it, and it is the first thing to
 * fix when the term is promoted from a report into the objective.
 *
 * This is a *modelling assumption* like `COCHANNEL_REUSE_DB`, and it is what makes
 * transmit power a lever at all: cutting power moves the relative band where two APs
 * are within 10 dB of each other without narrowing it, but it does shrink the region
 * above this absolute threshold. See `ROADMAP.md` B4/B5.
 */
const CCA_BELOW_THRESHOLD_DB = 12;

/**
 * How far below the coverage threshold **this run's** stations defer at, in dB.
 *
 * Deliberately a second thing from the constant above. The *horizon* a source is marched
 * to has to be settled before any pair is looked at, because the margins are computed
 * once and shared, so it uses the 20 MHz floor - the most sensitive case, therefore the
 * longest reach, so nothing that should be counted is left unmargined. The *comparison*
 * then asks each pair against the width actually in use, which is what makes an 80 MHz
 * plan read its contention honestly instead of 6 dB high.
 */
function ccaBelowCoverageDb(ctx: EvalContext): number {
	return COVERAGE_THRESHOLD_DBM - ccaThresholdDbm(ctx.minChannelWidthMhz);
}

/**
 * Share of the floor where **a client would hear two overlapping-channel APs** above the
 * CCA threshold — airtime the plan shares whether or not their levels are far enough
 * apart for the interference term to care.
 *
 * Whose clear-channel assessment this is matters, because every device runs one and they
 * are not the same measurement:
 *
 * - `ccaMargins` are the **APs' levels at a floor location**, so this models the client's
 *   side: a station associated with one of these APs hears the other above the threshold
 *   and defers. In a co-channel multi-AP deployment that is the dominant way airtime gets
 *   split, and it is what this figure is for.
 * - It does **not** model an AP hearing a neighbour's *clients* on the uplink, nor an AP
 *   hearing a neighbour AP's beacons. Both are real; neither is derivable from
 *   AP-to-location levels alone, and the uplink one needs a client-association model that
 *   does not exist yet. See `docs/PHYSICAL_MODELS.md` §E3–E4.
 *
 * A *report*, not a term in the objective: it is computed only for the final
 * evaluation (`evaluateExactDetailed(..., true)`), because it costs a pair scan per
 * sample and the search calls the same evaluator thousands of times. That is also
 * what keeps every figure recorded before it unchanged — the score, the coverage and
 * the interference share are all computed from the coverage-domain margins, exactly
 * as before.
 */
function contentionShare(field: MarginField, ctx: EvalContext): number {
	const { ccaMargins, count } = field;
	const sampleCount = ccaMargins.length / Math.max(1, count);
	let contendedWeight = 0;
	let totalWeight = 0;
	const limit = -ccaBelowCoverageDb(ctx);
	for (let i = 0; i < sampleCount; i++) {
		const w = ctx.sampleDensity[i] ?? 1;
		totalWeight += w;
		const base = i * count;
		let contended = false;
		for (let i = 0; i < count && !contended; i++) {
			const mi = ccaMargins[base + i]!;
			if (!(mi > limit)) continue;
			for (let j = i + 1; j < count; j++) {
				const mj = ccaMargins[base + j]!;
				if (!(mj > limit)) continue;
				// Overlapping channels, by the same lookup the interference term uses:
				// with the default model that is equality, and with the interval model it
				// includes partial overlap.
				if (ctx.overlap(i, ctx.sourceChannels[i] ?? 0, j, ctx.sourceChannels[j] ?? 0) > 0) {
					contended = true;
					break;
				}
			}
		}
		if (contended) contendedWeight += w;
	}
	return totalWeight > 0 ? contendedWeight / totalWeight : 0;
}

/**
 * How hard the ε-constraint pushes, per unit of missing coverage.
 *
 * The penalty is `multiplier · max(0, floor − coverage)`, so it is zero everywhere the
 * constraint holds — the feasible region is untouched and a plan inside it is scored
 * exactly as it was before the floor existed. Below the floor a point of missing
 * coverage costs three times what a point of interference costs at the default λ of
 * 0.2, which is enough to make the search climb out while still leaving the
 * interference term something to trade: a constraint that dominated every other term
 * would just be a coverage-only objective wearing a floor.
 */
const COVERAGE_FLOOR_MULTIPLIER = 3;

/**
 * The objective's three figures, read off a `MarginField`.
 *
 * Density-weighted, matching `evaluateCoverage`. When no density data is supplied
 * every sample weighs 1, which reduces to the plain mean.
 *
 * `report` adds the contention figure, which the objective does not use and the
 * search therefore must not pay for.
 */
function scoreMargins(field: MarginField, ctx: EvalContext, report = false): ExactEval {
	const { allMargins, conflicts, bestBySample, utilityMargin, count } = field;
	const sampleCount = bestBySample.length;
	let totalWeighted = 0;
	let coveredWeighted = 0;
	let totalWeight = 0;

	for (let si = 0; si < sampleCount; si++) {
		const best = bestBySample[si]!;
		const wt = ctx.sampleDensity[si] ?? 1;
		totalWeighted +=
			coverageUtilityAboveThreshold(utilityMargin[si]!, ctx.coverageSoftnessDb) * wt;
		if (best > 0) coveredWeighted += wt;
		totalWeight += wt;
	}
	const interference = interferenceShare(allMargins, conflicts, sampleCount, count, ctx, field.weights);
	const utility = totalWeight > 0 ? totalWeighted / totalWeight : 0;
	// The floor is a constraint on the *result*, and the search has to see it or it
	// would spend its budget below it. Zero everywhere the constraint holds, so the
	// feasible region is scored exactly as before; see `COVERAGE_FLOOR_MULTIPLIER`.
	const covered = totalWeight > 0 ? coveredWeighted / totalWeight : 0;
	const shortfall = ctx.coverageFloor > 0 ? Math.max(0, ctx.coverageFloor - covered) : 0;
	return {
		score: utility - ctx.interferenceWeight * interference - COVERAGE_FLOOR_MULTIPLIER * shortfall,
		shortfall,
		interference,
		coverage: totalWeight > 0 ? coveredWeighted / totalWeight : 0,
		samples: sampleCount,
		contention: report ? contentionShare(field, ctx) : 0
	};
}

function evaluateExactDetailed(positions: Position[], ctx: EvalContext, report = false): ExactEval {
	return scoreMargins(fillMargins(positions, ctx), ctx, report);
}


/**
 * Lower transmit power where that pays, one AP at a time (B4).
 *
 * Power is the second lever on interference, and it works on a different axis from
 * placement: shrinking a coverage circle can remove the band where two APs are
 * within the reuse distance of each other *without moving anything*, which is
 * exactly what a plan needs when the coverage-optimal placement is already settled
 * and the interference sits between two APs that are where they have to be.
 *
 * It is deliberately a **pass after placement** rather than a third search
 * dimension. The search's stages are built around two-dimensional moves — a PSO
 * velocity, a Lloyd centroid, a coordinate-descent step — and a discrete third
 * coordinate would have to be threaded through all of them, including the seeding,
 * for a gain this pass already captures: F3's measurement showed the two axes'
 * trade is convex over the range that matters, and a convex front is reachable by
 * alternating the blocks (which is what A2 says the multi-floor run does anyway).
 * Joint optimisation of power and placement is the natural next step, not this one.
 *
 * Levels come from the caller, descending from each AP's own configured power, and
 * a level is only taken on a **strict** improvement in the exact objective — so an
 * AP whose power buys nothing keeps it, and the pass cannot lower a plan's coverage
 * for a tie. Two sweeps at most: one to move, one to confirm nothing else moved.
 */
function refinePower(
	positions: Position[],
	aps: ApInput[],
	ctx: EvalContext,
	msg: Pick<OptimizeMessage, 'powerLevelsDbm' | 'worldUnitsPerMeter'>
): PowerChoice[] | null {
	const levels = msg.powerLevelsDbm;
	const wupm = msg.worldUnitsPerMeter ?? 0;
	if (!levels || wupm <= 0 || levels.length !== positions.length) return null;

	// The radius each AP's power implies, as the main thread derives it: same
	// function, same rounding, so a reload does not reshape the plan.
	const radiusFor = (index: number, power: number): number =>
		Math.round(rangeFromPower(power, positions[index]!.band) * wupm);

	let chosen = positions.map((p, i) => ({
		power: levels[i]?.[0] ?? 0,
		radius: p.radius
	}));

	for (let sweep = 0; sweep < 2; sweep++) {
		let moved = false;
		for (let i = 0; i < positions.length; i++) {
			const options = levels[i];
			if (!options || options.length <= 1) continue;
			const current = chosen[i]!;
			let bestScore = evaluateExactDetailed(positions, ctx).score;
			let bestPower = current.power;
			let bestRadius = current.radius;
			const restore = positions[i]!.radius;
			for (const power of options) {
				if (power === current.power) continue;
				const radius = radiusFor(i, power);
				if (radius === current.radius) continue;
				positions[i]!.radius = radius;
				const score = evaluateExactDetailed(positions, ctx).score;
				if (score > bestScore) {
					bestScore = score;
					bestPower = power;
					bestRadius = radius;
				}
			}
			if (bestRadius !== current.radius) {
				positions[i]!.radius = bestRadius;
				chosen[i] = { power: bestPower, radius: bestRadius };
				moved = true;
			} else {
				positions[i]!.radius = restore;
			}
		}
		if (!moved) break;
	}

	return positions.map((p, i) => ({
		id: p.id,
		power: chosen[i]!.power,
		radius: p.radius
	}));
}

/** Score only, for the search stages that call this in a tight loop. */
function evaluateExact(positions: Position[], ctx: EvalContext): number {
	return evaluateExactDetailed(positions, ctx).score;
}

/**
 * Nearest-interior-pixel lookup field.
 *
 * `snapToInterior` used to scan every interior pixel on each call, which is
 * O(P) with P routinely in the tens to hundreds of thousands, and it is called
 * on the order of `PSO_ITERS * SWARM * numAps` times. A multi-source BFS over
 * the wall mask builds an O(1) lookup instead.
 *
 * The BFS uses an 8-connected neighbourhood, so the distance it implies is a
 * Chebyshev-like approximation rather than exact Euclidean. That is fine here:
 * snapping only decides where a search step lands when it leaves the building,
 * and stage 3 re-validates every candidate exactly against `interior`.
 */


// ─── Yield to event loop for cancel checks ──────────────────────────────

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

// ─── Main optimization pipeline ─────────────────────────────────────────

async function runOptimization(
	msg: WireMessage,
	run: Run,
	geometry: WireGeometry
): Promise<void> {
	const { aps, wallAttenuation, defaultMaterial, allowOutside } = msg;
	/*
	 * The plan comes from the geometry the worker holds, not from this message: it was sent
	 * once and reused. Anything reading the masks reads them here.
	 */
	const {
		fixedAps,
		wallMask: mask,
		maskWidth: w,
		maskHeight: h,
		materialMask,
		densityMap,
		medianDensity,
		roomTypeMask
	} = geometry;

	/*
	 * This run's seed and PRNG, owned by the run rather than by the worker.
	 *
	 * A cancelled run is not stopped dead: it notices at its next yield point and unwinds. If
	 * the seed and the PRNG were module state, the run that replaced it would have its draws
	 * consumed by the old one's last chunk — the same seed then produces a different layout,
	 * which is exactly the guarantee the reported seed is supposed to give.
	 */
	const runSeed = (msg.seed ?? DEFAULT_OPTIMIZER_SEED) >>> 0;
	const random = mulberry32(runSeed);

	/*
	 * The payload's shape is declared in `optimizer-protocol.ts` and derived from the
	 * app's own `AccessPoint`, so the caller cannot build a message that omits a field
	 * the model reads. This check is for everything the type cannot cover: a hand-built
	 * message in a test, or a worker bundle left in a browser cache while the app around
	 * it moved on. It throws rather than scoring a different antenna than the one on
	 * screen.
	 */
	if (msg.payloadVersion !== undefined && msg.payloadVersion !== OPTIMIZER_PAYLOAD_VERSION) {
		throw new Error(
			`optimiser payload version ${msg.payloadVersion} does not match this worker's ${OPTIMIZER_PAYLOAD_VERSION}`
		);
	}
	if (msg.payloadVersion !== undefined) assertApPayload(aps as unknown as Array<Record<string, unknown>>);

	// One coefficient per run, selected before anything is evaluated: every propagation
	// function in this realm reads it. See `setPathLossScenario`.
	setPathLossScenario(msg.pathLossScenario ?? DEFAULT_PATH_LOSS_SCENARIO);

	// The user's materials, before anything is scored: the wall march reads the table through
	// `getMaterialDbTable`, and a custom id would otherwise fall back to the built-in figure.
	registerCustomMaterials(
		(msg.customMaterials ?? []).map((material) => ({
			id: material.id as WallMaterialId,
			name: material.name,
			dbPerMeter: material.dbPerMeter as Record<Band, number>,
			typicalThickness: material.typicalThickness,
			color: material.color
		}))
	);

	// maxDim 400 matches the resolution the real-time coverage cache and the
	// canvas use. At 200 the interior boundary was quantised twice as coarsely
	// (about 7.5 full-resolution pixels on a 1500 px plan instead of 3.75),
	// which let the optimiser accept positions that visibly sat outside a room.
	// The shared derivation, so the search and the app draw the same rooms — see
	// `canvas/rooms.ts`. Trimmed: this mask is the placement domain, and an AP against a
	// wall face is not a placement.
	const { interior } = buildRoomDomain(mask, w, h, {
		// A wall cavity is not a room. Without this the domain includes every sliver a plan
		// encloses between two drawn lines, which the search then uses — an AP 3 cm from a
		// wall, in a 0.6 m² pocket. See `minRoomRadiusWu`.
		minRegionRadius: msg.minRoomRadiusWu ?? 0,
		trimWallAdjacent: true
	});

	// Voids are holes in the floor, so they come out of the interior an AP may be
	// placed in. Done here rather than in `computeBuildingInterior`, which only
	// sees the wall mask and cannot know what a region was labelled as.
	//
	// Note this is geometry only. A void does not yet change propagation: that
	// needs the cross-floor ray split, so the slab loss can be dropped at the
	// point the ray actually crosses it. Until then a void stops an AP being
	// hung over the shaft and does nothing else.
	if (roomTypeMask && roomTypeMask.length === w * h) {
		for (let i = 0; i < w * h; i++) {
			if (interior[i] && isVoidRoomType(roomTypeMask[i]!)) interior[i] = 0;
		}
	}

	/*
	 * The user's own statement about where the floor is, when they have made one.
	 *
	 * The same clip the app's "is this point inside?" guard applies — the polygon arrives in
	 * mask coordinates, so the worker does not need to know about origins or calibration.
	 * Without it, drawing the area would silence the warnings while the optimiser kept
	 * placing access points in the part of the drawing the user had excluded.
	 */
	const planningArea = msg.planningArea;
	if (planningArea && planningArea.length >= 3) {
		clipInteriorToPlanningArea(interior, w, h, 0, 0, planningArea);
	}

	if (run.cancelled) {
		reply(msg.runId, { type: 'cancelled' });
		return;
	}

	const interiorPixels: number[] = [];
	for (let i = 0; i < w * h; i++) {
		if (interior[i]) interiorPixels.push(i);
	}

	if (aps.length === 0) {
		reply(msg.runId, { type: 'result', positions: [], score: 0, improvement: 0, seed: runSeed });
		return;
	}

	// No enclosed space detected. This is not a rare edge case in practice: walls
	// that do not form a CLOSED outline leave the flood fill nothing to be
	// enclosed by, so `interior` comes back empty. This branch used to return the
	// APs untouched and report nothing, so the user saw "the optimiser left my
	// APs outside" with no explanation. Say so instead.
	if (interiorPixels.length === 0 && !allowOutside) {
		reply(msg.runId, {
			type: 'result',
			positions: aps.map((a) => ({ id: a.id, x: a.x, y: a.y })),
			score: 0,
			improvement: 0,
			seed: runSeed,
			error:
				'No enclosed interior found, so APs were left where they are. A room only counts as inside once walls form a closed outline around it. Close the outlines, or turn on "Allow APs outside rooms".'
		});
		return;
	}

	const numAps = aps.length;
	const baseline = medianDensity > 0 ? medianDensity : 0.3;

	// O(1) nearest-interior lookup, built once and reused by every snap.
	const interiorField = buildInteriorField(interior, w, h);
	// Voids are holes in the floor. They are already out of `interior`, but with
	// `allowOutside` the snap has no field to consult at all, so a separate one is
	// built over "everywhere that is not a hole".
	const voidMask =
		roomTypeMask && roomTypeMask.length === w * h
			? (() => {
					const v = new Uint8Array(w * h);
					let any = false;
					for (let i = 0; i < v.length; i++) {
						if (interior[i] === 0 && isVoidRoomType(roomTypeMask[i]!)) {
							v[i] = 1;
							any = true;
						}
					}
					return any ? v : null;
				})()
			: null;
	const snapTarget = buildSnapTarget(interior, voidMask, w, h, allowOutside);

	/*
	 * Wall-mounted APs search a domain of their own: the band of floor beside the walls.
	 *
	 * `interior` above is trimmed one pixel off every wall on purpose — an AP against a
	 * wall face was not a placement before wall mounts existed — so the band is built
	 * from a *second*, untrimmed reading of the mask. It is null when the run has no
	 * wall mounts, which is the usual case and costs nothing.
	 */
	const wallMounted = aps.map((ap) => ap.mount === 'wall');
	const wantsWallBand = wallMounted.some(Boolean);
	let wallPlacement: WallPlacement | null = null;
	if (wantsWallBand) {
		// Untrimmed on purpose: the band is walked out from the wall, so the pixels touching
		// it are the ones it needs. The room test is still the shared one — a wall mount in a
		// cavity between two drawn lines is the same complaint as a ceiling one there.
		const { interior: untrimmed } = buildRoomDomain(mask, w, h, {
			minRegionRadius: msg.minRoomRadiusWu ?? 0,
			trimWallAdjacent: false
		});
		if (roomTypeMask && roomTypeMask.length === w * h) {
			for (let i = 0; i < w * h; i++) {
				if (untrimmed[i] && isVoidRoomType(roomTypeMask[i]!)) untrimmed[i] = 0;
			}
		}
		wallPlacement = buildWallPlacement(
			mask,
			untrimmed,
			w,
			h,
			msg.wallBandWu ?? 4,
			materialMask && materialMask.length === w * h ? materialMask : null,
			defaultMaterial
		);
	}
	/** Band pixels, for the initial seeding of a wall-mounted AP. */
	const bandPixels: number[] = [];
	if (wallPlacement) {
		for (let i = 0; i < w * h; i++) {
			if (wallPlacement.band[i]) bandPixels.push(i);
		}
	}

	// Sample points — density-weighted if room type data is available
	const sampleCount = Math.min(400, interiorPixels.length);
	const samples: Array<{ x: number; y: number }> = [];
	/** Per-sample density weight (1.0 = unassigned/default). */
	const sampleDensity: number[] = [];

	let sampled = false;

	// Weighted sampling when density data exists, uniform otherwise.
	//
	// The weighted branch is only entered when there is actual weight to
	// distribute. Running it with totalWeight = 0 does not fail loudly: stepW
	// becomes 0, the inner `cum + weights[pi] < nextThreshold` test is never
	// true, so `pi` advances by exactly one per iteration and the samples become
	// the FIRST sampleCount interior pixels in raster order — a small patch in
	// the top-left corner of the building. The optimiser would then maximise
	// coverage of that patch alone, which is why dragging every density to zero
	// produced an arbitrary-looking layout.
	if (!sampled && densityMap && densityMap.length === w * h) {
		const weights = new Float32Array(interiorPixels.length);
		let totalWeight = 0;
		for (let i = 0; i < interiorPixels.length; i++) {
			const raw = densityMap[interiorPixels[i]!]!;
			// -1 = unlabeled — use baseline; >= 0 = explicit (including 0)
			const d = raw >= 0 ? raw : baseline;
			weights[i] = d;
			totalWeight += d;
		}

		if (totalWeight > 0) {
			sampled = true;
			// Systematic weighted resampling (deterministic, no randomness)
			const stepW = totalWeight / sampleCount;
			let cum = 0;
			let nextThreshold = stepW * 0.5; // start at half-step for centering
			let pi = 0;
			for (let s = 0; s < sampleCount && pi < interiorPixels.length; s++) {
				while (pi < interiorPixels.length - 1 && cum + weights[pi]! < nextThreshold) {
					cum += weights[pi]!;
					pi++;
				}
				const idx = interiorPixels[pi]!;
				samples.push({ x: idx % w, y: Math.floor(idx / w) });
				const raw = densityMap[idx]!;
				sampleDensity.push(raw >= 0 ? raw : baseline);
				nextThreshold += stepW;
				cum += weights[pi]!;
				pi++;
			}
		}
	}

	if (!sampled) {
		// Uniform sampling (no density data, or every density is zero)
		const step = interiorPixels.length / sampleCount;
		for (let i = 0; i < sampleCount; i++) {
			const idx = interiorPixels[Math.floor(i * step)]!;
			samples.push({ x: idx % w, y: Math.floor(idx / w) });
			sampleDensity.push(0);
		}
	}

	// If all sample densities are 0 (every room set to zero), fall back to uniform
	const maxDensity = Math.max(...sampleDensity);
	if (maxDensity <= 0) {
		for (let i = 0; i < sampleDensity.length; i++) sampleDensity[i] = 1;
	}

	/*
	 * How high the client stands at each sample.
	 *
	 * The surfaces arrive in the mask's own coordinates — the same frame the samples are
	 * in — so the field is read directly and converted once: the height is metres, every
	 * gap below is world units. Null on a floor with no raised surface, which is the case
	 * that has to cost nothing.
	 */
	const sampleLift =
		(msg.surfaces?.length ?? 0) > 0
			? Float64Array.from(samples, (sample) =>
					surfaceHeightAt(msg.surfaces!, sample.x, sample.y) * (msg.worldUnitsPerMeter ?? 1)
				)
			: null;

	// Built once, after the sample set is final, and handed to every evaluator.
	// Constructing it here is what makes it impossible for one call site to be
	// scored with a different model than another.
	//
	// Channels are resolved here for the same reason: candidates first, then the
	// fixed APs, matching the order both evaluators walk their sources in.
	const resolvedChannels = resolveChannels([...aps, ...fixedAps]);
	// The allowed list per source, when the worker is to colour the layout itself.
	// A pinned AP's list is the pin, which is how `colourConflicts` takes
	// constraints — no special case in either place.
	// The width each band's palette has to be non-overlapping at: the widest in use
	// there, because a set that does not overlap at 80 MHz does not overlap at 20
	// either. Per band rather than per AP so a band gets one palette, matching the
	// solver; mixing widths within a band is the pairwise case the interval model
	// (B3's second stage) would handle.
	const widthByBand = new Map<string, number>();
	for (const ap of [...aps, ...fixedAps]) {
		widthByBand.set(ap.band, Math.max(widthByBand.get(ap.band) ?? 20, ap.channelWidth ?? 20));
	}
	const paletteWidth = (band: Band): ChannelWidth => (widthByBand.get(band) ?? 20) as ChannelWidth;
	const sourceAllowed: number[][] | null = msg.regulatoryDomain
		? [...aps, ...fixedAps].map((ap) => {
				if (ap.fixedChannel !== null && ap.fixedChannel !== undefined) return [ap.fixedChannel];
				// `planningCandidates`, not `planningChannels`: the widest-width palette
				// first (so the conventional 1/6/11 wins wherever it can serve), then the
				// rest of the band, which the colourer only reaches for when no candidate
				// from the palette is clear of the APs this source actually conflicts
				// with. Pins aside, that is the whole candidate set the band permits — the
				// palette was an approximation of the feasible set, not the set itself.
				return planningCandidates(ap.band, msg.regulatoryDomain!, paletteWidth(ap.band)).map(
					(c) => c.number
				);
			})
		: null;
	// Read by the interference term, and only meaningful next to `sourceAllowed`:
	// `getAvailableChannels` answers per band, so without the band the colourer
	// would read a 6 GHz channel 1 and a 2.4 GHz channel 1 as the same channel.
	const sourceBands = [...aps, ...fixedAps].map((ap) => ap.band as string);
	// The interval model, in the form the interference term wants: "how much of the
	// narrower channel do sources i and j share". Widths are per source, and an AP
	// with none is 20 MHz — the narrowest, and the only width at which every band's
	// channels are mutually non-overlapping.
	const sourceWidths = [...aps, ...fixedAps].map((ap) => ap.channelWidth ?? 20);
	const overlap = makeOverlapLookup(sourceBands, sourceWidths);
	// Per AP, index-aligned with `positions`: the vertical distance from where it is
	// mounted to the client. The caller supplies it because the worker has no floor
	// geometry, and it does not change as the search moves a position.
	const apGaps = new Float64Array(aps.length);
	for (let i = 0; i < aps.length; i++) apGaps[i] = aps[i]!.verticalGap ?? 0;
	const apProfiles = aps.map((ap) => antennaProfile(ap));
	const fixedProfiles = fixedAps.map((ap) => antennaProfile(ap));
	const ctx: EvalContext = {
		samples,
		mask,
		w,
		h,
		wallAttenuation,
		fixedAps,
		sampleDensity,
		materialMask,
		defaultMaterial,
		sourceChannels: resolvedChannels.channels,
		sourceAllowed,
		sourceBands,
		apGaps,
		sampleLift,
		surfaces: msg.surfaces ?? [],
		wupm: msg.worldUnitsPerMeter ?? 1,
		apProfiles,
		fixedProfiles,
		overlap,
		channelsKnown: resolvedChannels.known || sourceAllowed !== null,
		interferenceWeight: msg.interferenceWeight ?? DEFAULT_INTERFERENCE_WEIGHT,
		coverageSoftnessDb: msg.coverageSoftnessDb ?? DEFAULT_COVERAGE_SOFTNESS_DB,
		localVerticalDropWu: msg.localVerticalDrop ?? 0,
		coverageFloor: Math.max(0, msg.coverageFloor ?? 0),
		// The narrowest channel in the run: a station on 20 MHz defers at -82 dBm whatever
		// its neighbours do with 80 MHz, so a mixed-width run is scored at the most sensitive
		// threshold present rather than at an average. sourceWidths is already built for the
		// overlap lookup, and a run has at least one AP.
		minChannelWidthMhz: sourceWidths.length > 0 ? Math.min(...sourceWidths) : 20,
		// Built once here rather than per evaluation: a fixed AP does not move, so the
		// runs its cross-floor path splits into, and whether its slab is a hole at
		// each sample, are constant for the whole run.
		fixedPaths: buildFixedPaths(
			fixedAps,
			samples,
			mask,
			w,
			h,
			materialMask,
			defaultMaterial,
			wallAttenuation
		),
		apSources: aps,
		wallMounted,
		wallPlacement
	};

	// One lazy cache per band in use. Construction performs no ray marching;
	// attenuation rows are computed on demand and memoised, so the "precomputing"
	// stage is now O(1) instead of millions of ray marches.
	// Material losses are band dependent, so a single 5 GHz table would be wrong
	// for any AP on another band.
	reply(msg.runId, {
		type: 'progress',
		positions: [],
		score: 0,
		iteration: 0,
		totalIterations: 100,
		stage: 'Precomputing...'
	});
	const caches = new Map<Band, WallCache>();
	const makeCache = (band: Band): WallCache =>
		createWallCache(
			mask,
			w,
			h,
			samples,
			wallAttenuation,
			band,
			materialMask,
			defaultMaterial
		);
	for (const ap of aps) {
		if (!caches.has(ap.band)) caches.set(ap.band, makeCache(ap.band));
	}
	for (const fap of fixedAps) {
		if (!caches.has(fap.band)) caches.set(fap.band, makeCache(fap.band));
	}

	// Yield to let cancel message arrive
	await yieldToEventLoop();
	if (run.cancelled) {
		reply(msg.runId, { type: 'cancelled' });
		return;
	}

	// Graph-only request: the main-thread solver is about to colour this floor and
	// has to see the same edges the objective scores. Nothing below this point
	// runs — no Lloyd's, no PSO, no coordinate descent — so the answer describes
	// the payload's own positions rather than a layout this run would have chosen.
	// Edge indices are positions first, then fixed APs, matching `fillMargins`.
	if (msg.graphOnly) {
		const positions: Position[] = aps.map((a) => ({
			id: a.id,
			x: a.x,
			y: a.y,
			radius: a.interferenceRadius,
			band: a.band
		}));
		const field = fillMargins(positions, ctx);
		const pairs: Array<[number, number]> = [];
		for (let i = 0; i < field.count; i++) {
			for (let j = i + 1; j < field.count; j++) {
				if (field.conflicts[i * field.count + j]) pairs.push([i, j]);
			}
		}
		reply(msg.runId, {
			type: 'result',
			positions: aps.map((a) => ({ id: a.id, x: a.x, y: a.y })),
			score: 0,
			improvement: 0,
			seed: runSeed,
			sampleCount: samples.length,
			graph: { pairs, count: field.count, weights: Array.from(field.weights) }
		});
		return;
	}

	// ─── Stage 1: Signal-Weighted Lloyd's ───────────────────────────────────

	const positions: Position[] = [];

	/*
	 * K-means++ init, over the domain each AP is allowed in: the interior for a
	 * ceiling or floor mounting, the wall band for a wall mount. Seeding a wall mount
	 * from the interior would start the search in the middle of a room and leave the
	 * projection in `snapForAp` to drag it to a wall on the first Lloyd step.
	 */
	const pixelsFor = (a: number): number[] =>
		wallMounted[a] && bandPixels.length > 0 ? bandPixels : interiorPixels;
	const firstSet = pixelsFor(0);
	const firstIdx = firstSet[Math.floor(random() * firstSet.length)]!;
	positions.push({
		id: aps[0]!.id,
		x: firstIdx % w,
		y: Math.floor(firstIdx / w),
		radius: aps[0]!.interferenceRadius,
		band: aps[0]!.band
	});

	for (let k = 1; k < numAps; k++) {
		const candidates = pixelsFor(k);
		let bestDist = -1;
		let bestPx = candidates[0]!;
		for (const px of candidates) {
			const px_x = px % w;
			const px_y = Math.floor(px / w);
			let minD = Infinity;
			for (const p of positions) {
				const d = (px_x - p.x) ** 2 + (px_y - p.y) ** 2;
				if (d < minD) minD = d;
			}
			if (minD > bestDist) {
				bestDist = minD;
				bestPx = px;
			}
		}
		positions.push({
			id: aps[k]!.id,
			x: bestPx % w,
			y: Math.floor(bestPx / w),
			radius: aps[k]!.interferenceRadius,
			band: aps[k]!.band
		});
	}

	// Lloyd's iterations
	for (let iter = 0; iter < 30; iter++) {
		if (run.cancelled) {
			reply(msg.runId, { type: 'cancelled' });
			return;
		}

		const buckets: Array<{ sumX: number; sumY: number; sumW: number }> = positions.map(() => ({
			sumX: 0,
			sumY: 0,
			sumW: 0
		}));

		// Attenuation rows depend only on the current AP positions, which are fixed
		// for the duration of this sample loop, so resolve them once per iteration.
		const iterApRows: Float32Array[] = new Array(numAps);
		for (let a = 0; a < numAps; a++) {
			iterApRows[a] = caches.get(positions[a]!.band)!.tableFor(positions[a]!.x, positions[a]!.y);
		}
		const iterFixedRows: Float32Array[] = new Array(fixedAps.length);
		const iterFixedSlabDb = new Float64Array(fixedAps.length);
		for (let f = 0; f < fixedAps.length; f++) {
			iterFixedRows[f] = caches.get(fixedAps[f]!.band)!.tableFor(fixedAps[f]!.x, fixedAps[f]!.y);
			iterFixedSlabDb[f] = slabDbOf(fixedAps[f]!.signalScale);
		}
		// The attribution is a best-server decision, so it reads the same patterns the
		// objective does — a wall mount's included, which is why it is resolved from
		// the iteration's own positions rather than from the context.
		const iterApProfiles = resolveApProfiles(positions, ctx);

		for (let s = 0; s < samples.length; s++) {
			let bestAp = 0;
			// Best margin, as in the evaluators: the seeding weights samples by their
			// deficit, and that has to be the same deficit the objective sees.
			let bestMargin = -Infinity;
			const lift = ctx.sampleLift?.[s] ?? 0;
			for (let a = 0; a < numAps; a++) {
				const dx = samples[s]!.x - positions[a]!.x;
				const dy = samples[s]!.y - positions[a]!.y;
				const dist = Math.sqrt(dx * dx + dy * dy);
				const gap = (ctx.apGaps[a] ?? 0) - lift;
				const margin =
					sourceMargin(
						dist,
						positions[a]!.radius,
						iterApRows[a]![s]! + deckLossAt(ctx, samples[s]!.x, samples[s]!.y, gap),
						gap,
						-ctx.coverageSoftnessDb
					) -
					antennaRayLossDb(iterApProfiles[a]!, gap, dx, dy);
				if (margin > bestMargin) {
					bestMargin = margin;
					bestAp = a;
				}
			}
			// Fixed APs contribute signal but don't claim samples
			for (let f = 0; f < fixedAps.length; f++) {
				const fap = fixedAps[f]!;
				const dx = samples[s]!.x - fap.x;
				const dy = samples[s]!.y - fap.y;
				const dist = Math.sqrt(dx * dx + dy * dy);
				const path = ctx.fixedPaths[f];
				const split = path?.split;
				const wallDb = split ? split.source[s]! + split.suffix[s]! : iterFixedRows[f]![s]!;
				// A hole in the slab costs nothing there.
				const slabDb =
					path?.slabFactor != null
						? iterFixedSlabDb[f]! * path.slabFactor[s]!
						: iterFixedSlabDb[f]!;
				const margin =
					sourceMargin(
						dist,
						fap.interferenceRadius,
						wallDb + slabDb + deckLossAt(ctx, samples[s]!.x, samples[s]!.y, fap.verticalGap - lift),
						fap.verticalGap - lift,
						-ctx.coverageSoftnessDb
					) -
					antennaRayLossDb(ctx.fixedProfiles[f]!, fap.verticalGap - lift, dx, dy);
				if (margin > bestMargin) bestMargin = margin;
			}
			const deficit = 1.0 - coverageUtilityAboveThreshold(bestMargin, ctx.coverageSoftnessDb);
			// Density-proportional: conference room (0.8) pulls ~3x harder than stairwell (0.03)
			const densityW = sampleDensity[s] ?? baseline;
			const weight = (1 + deficit * 3) * densityW;
			buckets[bestAp]!.sumX += samples[s]!.x * weight;
			buckets[bestAp]!.sumY += samples[s]!.y * weight;
			buckets[bestAp]!.sumW += weight;
		}

		let maxMove = 0;
		for (let a = 0; a < numAps; a++) {
			const b = buckets[a]!;
			if (b.sumW === 0) continue;
			const nx = b.sumX / b.sumW;
			const ny = b.sumY / b.sumW;
			maxMove = Math.max(maxMove, Math.hypot(nx - positions[a]!.x, ny - positions[a]!.y));
			const snapped = snapForAp(a, nx, ny, wallMounted, snapTarget, wallPlacement);
			positions[a]!.x = snapped.x;
			positions[a]!.y = snapped.y;
		}
		if (maxMove < 1.0) break;
	}

	const lloydsScore = evaluateCoverage(positions, caches, ctx);
	reply(msg.runId, {
		type: 'progress',
		positions: positions.map((p) => ({ id: p.id, x: p.x, y: p.y })),
		score: lloydsScore,
		iteration: 25,
		totalIterations: 100,
		stage: "Lloyd's complete"
	});

	await yieldToEventLoop();
	if (run.cancelled) {
		reply(msg.runId, { type: 'cancelled' });
		return;
	}

	// ─── Stage 2: PSO Refinement ────────────────────────────────────────────

	const SWARM = 20;
	const PSO_ITERS = 60;
	const dim = numAps * 2;

	const pos = new Float32Array(SWARM * dim);
	const vel = new Float32Array(SWARM * dim);
	const pBest = new Float32Array(SWARM * dim);
	const pBestScore = new Float32Array(SWARM);
	const gBest = new Float32Array(dim);
	let gBestScore = -Infinity;

	for (let a = 0; a < numAps; a++) {
		pos[a * 2] = positions[a]!.x;
		pos[a * 2 + 1] = positions[a]!.y;
	}
	pBest.set(pos.subarray(0, dim));

	const jitterRadius = Math.max(w, h) * 0.2;
	for (let p = 1; p < SWARM; p++) {
		for (let a = 0; a < numAps; a++) {
			const bx = positions[a]!.x + (random() - 0.5) * jitterRadius;
			const by = positions[a]!.y + (random() - 0.5) * jitterRadius;
			const snapped = snapForAp(a, bx, by, wallMounted, snapTarget, wallPlacement);
			pos[p * dim + a * 2] = snapped.x;
			pos[p * dim + a * 2 + 1] = snapped.y;
		}
		pBest.set(pos.subarray(p * dim, (p + 1) * dim), p * dim);
	}

	function evalParticle(pIdx: number): number {
		const tempPositions: Position[] = [];
		for (let a = 0; a < numAps; a++) {
			tempPositions.push({
				id: aps[a]!.id,
				x: pos[pIdx * dim + a * 2]!,
				y: pos[pIdx * dim + a * 2 + 1]!,
				radius: aps[a]!.interferenceRadius,
				band: aps[a]!.band
			});
		}
		return evaluateCoverage(tempPositions, caches, ctx);
	}

	for (let p = 0; p < SWARM; p++) {
		pBestScore[p] = evalParticle(p);
		if (pBestScore[p]! > gBestScore) {
			gBestScore = pBestScore[p]!;
			gBest.set(pos.subarray(p * dim, (p + 1) * dim));
		}
	}

	for (let iter = 0; iter < PSO_ITERS; iter++) {
		// Yield every 5 iterations so cancel messages can arrive
		if (iter % 5 === 0) {
			await yieldToEventLoop();
			if (run.cancelled) {
				reply(msg.runId, { type: 'cancelled' });
				return;
			}
		}

		const inertia = 0.9 - 0.5 * (iter / PSO_ITERS);
		const c1 = 1.5;
		const c2 = 1.5;

		for (let p = 0; p < SWARM; p++) {
			for (let d = 0; d < dim; d++) {
				const r1 = random();
				const r2 = random();
				const off = p * dim + d;
				vel[off] =
					inertia * vel[off]! +
					c1 * r1 * (pBest[off]! - pos[off]!) +
					c2 * r2 * (gBest[d]! - pos[off]!);
				pos[off] = pos[off]! + vel[off]!;
			}
			for (let a = 0; a < numAps; a++) {
				const px = pos[p * dim + a * 2]!;
				const py = pos[p * dim + a * 2 + 1]!;
				if (
					!allowedForAp(
						a,
						Math.round(px),
						Math.round(py),
						wallMounted,
						wallPlacement,
						interior,
						w,
						h,
						allowOutside,
						voidMask
					)
				) {
					const snapped = snapForAp(a, px, py, wallMounted, snapTarget, wallPlacement);
					pos[p * dim + a * 2] = snapped.x;
					pos[p * dim + a * 2 + 1] = snapped.y;
				}
			}

			const score = evalParticle(p);
			if (score > pBestScore[p]!) {
				pBestScore[p] = score;
				pBest.set(pos.subarray(p * dim, (p + 1) * dim), p * dim);
				if (score > gBestScore) {
					gBestScore = score;
					gBest.set(pos.subarray(p * dim, (p + 1) * dim));
				}
			}
		}

		// Report every few iterations, plus always the final one, so the bar
		// reaches the end of this stage's range instead of stalling part-way.
		if (iter % 5 === 0 || iter === PSO_ITERS - 1) {
			const gPositions: Array<{ id: string; x: number; y: number }> = [];
			for (let a = 0; a < numAps; a++) {
				gPositions.push({ id: aps[a]!.id, x: gBest[a * 2]!, y: gBest[a * 2 + 1]! });
			}
			reply(msg.runId, {
				type: 'progress',
				positions: gPositions,
				score: gBestScore,
				iteration: 25 + Math.round(((iter + 1) / PSO_ITERS) * 55),
				totalIterations: 100,
				stage: 'PSO refining'
			});
		}
	}

	// ─── Stage 3: Coordinate Descent Polish ─────────────────────────────────

	await yieldToEventLoop();
	if (run.cancelled) {
		reply(msg.runId, { type: 'cancelled' });
		return;
	}

	const finalPositions: Position[] = [];
	for (let a = 0; a < numAps; a++) {
		finalPositions.push({
			id: aps[a]!.id,
			x: Math.round(gBest[a * 2]!),
			y: Math.round(gBest[a * 2 + 1]!),
			radius: aps[a]!.interferenceRadius,
			band: aps[a]!.band
		});
	}

	const DIRS = [
		[1, 0],
		[-1, 0],
		[0, 1],
		[0, -1],
		[1, 1],
		[-1, 1],
		[1, -1],
		[-1, -1]
	];
	let polishStep = 5;
	const minStep = 0.5;
	let polishPass = 0;

	// Hard bound on polish passes. polishStep only halves when a full sweep fails
	// to improve, so any scoring inconsistency (or a pathological landscape) can
	// otherwise spin here indefinitely — and because a worker processes one
	// message at a time, that wedges every later optimize request too.
	const MAX_POLISH_PASSES = 40;
	while (polishStep >= minStep && polishPass < MAX_POLISH_PASSES) {
		await yieldToEventLoop();
		if (run.cancelled) {
			reply(msg.runId, { type: 'cancelled' });
			return;
		}
		let improved = false;
		// NOTE: every evaluateExact call in this loop MUST pass the identical
		// configuration. These parameters are optional, so a call site that omits
		// them silently scores against a different model — which makes the
		// comparison meaningless and can keep `improved` true forever.
		let bestScore = evaluateExact(finalPositions, ctx);

		for (let a = 0; a < numAps; a++) {
			for (const [ddx, ddy] of DIRS) {
				const oldX = finalPositions[a]!.x;
				const oldY = finalPositions[a]!.y;
				const nx = Math.round(oldX + ddx! * polishStep);
				const ny = Math.round(oldY + ddy! * polishStep);
				// `allowedForAp` is what keeps a wall mount on its wall: a step off the
				// band is not a candidate.
				if (
					!allowedForAp(
						a,
						nx,
						ny,
						wallMounted,
						wallPlacement,
						interior,
						w,
						h,
						allowOutside,
						voidMask
					)
				) {
					continue;
				}
				finalPositions[a]!.x = nx;
				finalPositions[a]!.y = ny;
				const score = evaluateExact(finalPositions, ctx);
				if (score > bestScore) {
					bestScore = score;
					improved = true;
				} else {
					finalPositions[a]!.x = oldX;
					finalPositions[a]!.y = oldY;
				}
			}
		}

		// Stage 3 previously reported no progress at all, so the bar stalled at
		// the end of stage 2 for the whole (slowest) polish phase.
		reply(msg.runId, {
			type: 'progress',
			positions: finalPositions.map((p) => ({ id: p.id, x: Math.round(p.x), y: Math.round(p.y) })),
			score: bestScore,
			iteration: Math.min(98, 80 + polishPass * 6),
			totalIterations: 100,
			stage: 'Polishing'
		});
		polishPass++;

		if (!improved) polishStep *= 0.5;
	}

	// Enforce the placement policy on the OUTPUT rather than trusting every stage
	// to have upheld it on the way through. Each stage does constrain its own
	// moves, but "no AP outside the interior" is a postcondition of the whole
	// run, and making it explicit here means a leak anywhere upstream can no
	// longer reach the user. This is O(numAps) against a prebuilt lookup.
	if (!allowOutside) {
		for (const p of finalPositions) {
			const s = snapToInterior(p.x, p.y, interiorField, false);
			p.x = s.x;
			p.y = s.y;
		}
	}

	// Transmit power, when the caller offered levels: block coordinate descent on the
	// last block, after placement has settled. See `refinePower`.
	const powerReport = refinePower(finalPositions, aps, ctx, msg);

	// Score the start and the finish through the same context, so the comparison
	// cannot involve two different models. The detailed form also carries the
	// covered-area share, on the same definition the coverage readout uses, which
	// is what the multi-floor objective needs.
	const inputPositions = aps.map((a) => ({
		id: a.id,
		x: a.x,
		y: a.y,
		radius: a.interferenceRadius,
		band: a.band
	}));
	// Scored with `report`, so the two figures the user sees — interference and the
	// contention share — describe the layout that is being handed back. The search's
	// own evaluations leave it at zero: it is not part of the objective.
	const initialEval = evaluateExactDetailed(inputPositions, ctx, true);
	const finalEval = evaluateExactDetailed(finalPositions, ctx, true);

	// Never hand back something worse than what came in.
	//
	// Stages 1 and 2 optimise a grid-snapped approximation of the objective, so
	// the arrangement they settle on can score *worse* than the starting layout
	// once stage 3 rescores it exactly. The run then reported a negative
	// improvement and the caller applied it anyway, which means pressing Optimize
	// could make a plan measurably worse. Observed in practice: two of five
	// restarts came back at -0.47%.
	//
	// Keeping the input as a candidate costs one evaluation and makes the whole
	// operation monotone by construction, which is the property the coordinate
	// descent already tries to guarantee internally.
	const reverted = finalEval.score < initialEval.score;
	const chosen = reverted ? inputPositions : finalPositions;
	const chosenEval = reverted ? initialEval : finalEval;
	const improvement =
		initialEval.score > 0 ? ((chosenEval.score - initialEval.score) / initialEval.score) * 100 : 0;

	reply(msg.runId, {
		type: 'result',
		positions: chosen.map((p) => ({ id: p.id, x: Math.round(p.x), y: Math.round(p.y) })),
		score: chosenEval.score,
		coverage: chosenEval.coverage,
		/** Co-channel interference share of the chosen layout. See `ExactEval`. */
		interference: chosenEval.interference,
		/** Airtime share with two overlapping-channel APs above the CCA threshold. */
		contention: chosenEval.contention,
		/**
		 * How far below the ε-constraint's floor the chosen plan fell, as a 0-1
		 * fraction. Zero when no floor was set or the floor was met.
		 */
		shortfall: chosenEval.shortfall,
		/** False when the share was measured against the all-co-channel bound. */
		channelsKnown: ctx.channelsKnown,
		sampleCount: chosenEval.samples,
		improvement,
		/** True when the search lost and the input layout was kept instead. */
		reverted,
		seed: runSeed,
		/**
		 * Transmit power the TPC pass settled on, per AP, when the caller offered
		 * levels. Absent ⇒ power was not a decision variable for this run.
		 */
		powers: powerReport ?? undefined
	});
}
