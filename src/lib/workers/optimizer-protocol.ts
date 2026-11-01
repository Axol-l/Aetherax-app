/**
 * What the main thread and the optimiser worker agree to send each other.
 *
 * The payload used to be declared twice — once in the worker, once implicitly by the
 * object literals the caller built — with every antenna field *optional*. That is a
 * payload that typechecks while saying nothing: forgetting `mount` or `facingDeg` was
 * not an error, it just meant "an upright omni", and the optimiser then scored a
 * different antenna from the one the panel showed. The bug class is the shape of the
 * declaration, so the declaration is derived from the state instead of restated.
 *
 * `ApInput` is therefore built from `AccessPoint`: add a field to the list below and
 * every construction site fails to compile until it supplies it, and change a field's
 * type on `AccessPoint` and this follows automatically. The type is erased at build
 * time, so importing it costs the worker nothing at run time.
 */
import type { RegulatoryDomain } from '@aetherax/channels';
import type { AccessPoint } from '../state/ap-state.svelte.js';
import type { PathLossScenario } from '../rf/propagation.js';
import type { FixedApInput } from './optimizer/types.js';

/**
 * Bumped when the payload's *meaning* changes, not when a field is added.
 *
 * The worker is a bundled asset and the main thread is the app around it, so during
 * development a cached worker can outlive the code that calls it. A mismatch is then
 * loud (`assertApPayload`) rather than a silently different model.
 */
export const OPTIMIZER_PAYLOAD_VERSION = 3;

/**
 * The state fields the search has to be told about.
 *
 * Everything here is a *model input*: geometry (`x`, `y`), the reach it implies
 * (`interferenceRadius`, `band`, `channelWidth`), the channels it may be given
 * (`assignedChannel`, `fixedChannel`) and the antenna (`beamwidthDeg`, `aimDeg`,
 * `mount`, `facingDeg`). Anything the worker does not read does not belong here — the
 * point of the list is that it is short enough to check by eye.
 */
type ApPayloadField =
	| 'id'
	| 'x'
	| 'y'
	| 'interferenceRadius'
	| 'band'
	| 'channelWidth'
	| 'assignedChannel'
	| 'fixedChannel'
	| 'beamwidthDeg'
	| 'aimDeg'
	| 'mount'
	| 'facingDeg';

/**
 * One placed access point, as the worker sees it.
 *
 * `verticalGap` is the one field the state does not hold, because it is geometry the
 * worker has no floors to derive: the caller measures it (see `apVerticalOffsetTo`).
 * It is required here for the same reason as the rest — a missing vertical term is a
 * different path loss, not a default.
 */
export type ApInput = { [K in ApPayloadField]: AccessPoint[K] } & {
	/** Vertical distance from this AP to the client, in world units. 0 is a flat path. */
	verticalGap: number;
};

/** The fields a caller must have filled in before a run may start. */
const REQUIRED_AP_FIELDS = [
	'id',
	'x',
	'y',
	'interferenceRadius',
	'band',
	'channelWidth',
	'assignedChannel',
	'fixedChannel',
	'beamwidthDeg',
	'aimDeg',
	'mount',
	'facingDeg',
	'verticalGap'
] as const;

/**
 * Fail loudly on a payload that is missing something the model reads.
 *
 * Only reachable if a caller bypasses the type — a stale cached worker bundle during
 * development, or a hand-built message in a test. It exists because the alternative is
 * the failure this module was written to prevent: `undefined` quietly becoming "no
 * antenna cut", and a scored layout that no longer matches the one on screen.
 */
export function assertApPayload(aps: ReadonlyArray<Record<string, unknown>>): void {
	for (const [index, ap] of aps.entries()) {
		for (const field of REQUIRED_AP_FIELDS) {
			if (ap[field] === undefined) {
				throw new Error(
					`optimiser payload ${OPTIMIZER_PAYLOAD_VERSION}: AP ${index} is missing "${field}"`
				);
			}
		}
	}
}

/*
 * The message itself, and the two shapes it travels in.
 *
 * These used to be declared in the worker, which meant the bridge built an untyped object literal
 * against a type nothing checked it with: a field the worker read but the caller stopped sending
 * was `undefined` at run time instead of a compile error. One declaration, read from both ends.
 */
/**
 * The message this worker accepts.
 *
 * The AP shape is `optimizer-protocol.ts`'s `ApInput`, derived from the app's own
 * `AccessPoint`, so a payload that forgets the mounting or the facing does not compile;
 * `assertApPayload` catches a caller that bypasses the type. The fields are optional here
 * because the graph-only path and the tests build messages by hand.
 */

export interface OptimizeMessage {
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
/**
 * The heavy half of a payload: the masks and the cross-floor sources.
 *
 * Sent once per plan and reused across the restarts of a floor and the repeats of a run; the
 * bridge identifies it by the identity of the arrays it is made of, so a changed plan is a
 * changed id and a fresh send.
 */
export type WireGeometry = Pick<
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

export type WireMessage = Omit<OptimizeMessage, keyof WireGeometry> &
	Partial<WireGeometry> & { geometryId?: string; geometryReused?: boolean };

/*
 * The other direction: what the run sends back.
 *
 * These were declared in the bridge, which meant the worker's reply literals were checked against
 * nothing — a field the bridge read but the worker stopped sending was `undefined` at run time.
 * The worker's `reply` is typed with them now, so both ends read one declaration.
 */
export interface OptimizeResult {
	positions: Array<{ id: string; x: number; y: number }>;
	score: number;
	improvement: number;
	/**
	 * Set when the run could not do its job (for example no enclosed interior was
	 * detected). The positions are then the inputs, unchanged. Callers must
	 * surface this — silently keeping the old positions looks like the optimiser
	 * simply did nothing.
	 */
	error?: string;
	/**
	 * PRNG seed this run actually used. Pass it back through `options.seed` to
	 * repeat the run exactly — the optimiser is stochastic, so without this an
	 * A/B comparison of two model versions cannot be distinguished from noise.
	 */
	seed: number;
	/**
	 * Share of density-weighted floor area that is covered, on the same definition
	 * the coverage readout uses. Reported per floor so a multi-floor run can build
	 * a building-wide figure and name the weakest floor without a second
	 * implementation of that definition.
	 */
	coverage: number;
	/**
	 * Share of density-weighted floor area whose best server is degraded by a
	 * co-channel secondary within `COCHANNEL_REUSE_DB` of it. The complement of
	 * coverage in "quality" terms: the objective trades the two off. Absent on the
	 * error paths, which report no layout.
	 */
	interference?: number;
	/**
	 * Share of the floor where two APs on overlapping channels are both above the CCA
	 * threshold (≈ −82 dBm at 20 MHz): airtime the plan shares, whatever the
	 * signal-to-interference ratios are. Reported, not optimised — it is the half of
	 * "interference" a purely relative criterion cannot see. See `ROADMAP.md` B4/B5.
	 */
	contention?: number;
	/**
	 * How far below the ε-constraint's floor the chosen plan fell, as a 0-1 fraction.
	 * Zero when no floor was set, or when the floor was met. See
	 * `projectMeta.coverageFloorPct`.
	 */
	shortfall?: number;
	/**
	 * False when `interference` was measured against the all-co-channel bound
	 * because some AP has no channel yet. The figure is then an upper bound.
	 */
	channelsKnown?: boolean;
	/** How many samples the coverage figure came from, used to weight floors. */
	sampleCount: number;
	/**
	 * True when the search produced a layout scoring worse than its input on the
	 * exact evaluator, so the input was kept instead. Stages 1 and 2 optimise a
	 * grid-snapped approximation, so this does happen; without the guard the worse
	 * layout would be applied and the run would report a negative improvement.
	 */
	reverted: boolean;
	/**
	 * The conflict graph the payload's own positions imply, present only on a
	 * `graphOnly` request. Edge indices are the payload's sources in order — its
	 * `aps` first, then its `fixedAps` — so the caller can name both ends.
	 *
	 * The graph is the one the objective scores, built by the same margin pass
	 * (`fillMargins`), which is what lets the main-thread solver colour what the
	 * optimiser will afterwards measure. See `optimizer-worker.ts`.
	 */
	graph?: {
		pairs: Array<[number, number]>;
		count: number;
		/**
		 * How much each pair costs, row-major `count × count`, the same indexing as the
		 * pairs: the density-weighted number of samples at which one source is within
		 * the reuse threshold of the other. See `conflictWeights`.
		 */
		weights?: number[];
	};
	/**
	 * Transmit power the run settled on, per AP, when the caller offered power
	 * levels. See `refinePower`; a caller that applies positions must apply these
	 * too, or the plan it shows is not the one that was scored.
	 */
	powers?: Array<{ id: string; power: number; radius: number }>;
}

export interface OptimizeProgress {
	positions: Array<{ id: string; x: number; y: number }>;
	score: number;
	iteration: number;
	totalIterations: number;
}

/**
 * What the worker sends back.
 *
 * Every reply carries the id of the run that produced it. Before it did, the bridge resolved
 * whichever promise happened to be outstanding when a message arrived, so a run that outran
 * its cancellation delivered its layout into the next run's promise — and the layout came
 * back labelled with the next run's seed.
 */
export type WorkerReply =
	| ({ type: 'progress'; runId: string } & OptimizeProgress)
	| ({ type: 'result'; runId: string } & OptimizeResult)
	| { type: 'cancelled'; runId: string }
	| { type: 'busy'; runId: string };