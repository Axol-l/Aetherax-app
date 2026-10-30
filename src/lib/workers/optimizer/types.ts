/**
 * The shapes the optimiser's search, evaluator and placement helpers exchange.
 *
 * One module because they are one vocabulary: `EvalContext` alone mentions the AP payload,
 * the fixed sources, the slab paths and the wall band, and the worker, the evaluator and
 * the placement helpers all speak it. Keeping the declarations here is what lets those
 * three be separate files without one importing another's runtime code.
 */
import type { Band, ChannelWidth } from '@aetherax/channels';
import type { AntennaProfile } from '../../rf/antenna.js';
import type { SlabCrossing } from '../../rf/cross-floor.js';
import type { OverlapLookup } from '../../rf/interference.js';
import type { SurfaceRect } from '../../rf/surface-height.js';

export interface ApInput {
	id: string;
	x: number;
	y: number;
	interferenceRadius: number;
	band: Band;
	/**
	 * The channel the solver gave this AP, or null when it has none.
	 *
	 * Used only by the interference term (see `rf/interference.ts`): placement and
	 * assignment are physically coupled, and the coverage objective alone cannot
	 * see a co-channel second server. When any source is unassigned the term falls
	 * back to the all-co-channel worst case, which is what the plan is in until the
	 * solver has run.
	 */
	assignedChannel?: number | null;
	/**
	 * A channel the user pinned. Pins are constraints on the in-worker colouring
	 * rather than suggestions, so a pinned AP keeps its channel however the search
	 * moves it — the same rule the main-thread solver applies.
	 */
	fixedChannel?: number | null;
	/**
	 * Channel width, for building the non-overlapping palette this AP may be given.
	 * See `planningChannels`. Omitted ⇒ 20 MHz, the narrowest and the only width at
	 * which every band's channels are mutually non-overlapping.
	 */
	channelWidth?: ChannelWidth;
	/**
	 * Vertical distance from this AP to the client, in world units.
	 *
	 * A same-floor path is not flat once the project models mounting heights: an AP
	 * on a desk is 0.7 m below a client at 1.5 m, and the path loss reads the 3D
	 * distance. The caller computes it — the worker has no floor geometry — and it
	 * is index-aligned with this array, because the search moves a position but
	 * never changes where its access point is mounted.
	 *
	 * Zero leaves the path flat, which is the model every figure recorded before
	 * mounting heights existed was taken with.
	 */
	verticalGap?: number;
	/**
	 * −3 dB beamwidth of this AP's vertical antenna cut, in degrees.
	 *
	 * The pattern is a function of the ray's elevation, which changes per sample, so
	 * the worker resolves it per sample from this and `aimDeg` — the same rolloff
	 * the heatmap and the coverage pass use (`rf/antenna.ts`). Absent ⇒ the band's
	 * default is *not* guessed here: the caller sends what the AP says.
	 */
	beamwidthDeg?: number;
	aimDeg?: number;
	/**
	 * The mounting and, for a wall mount, which way it faces.
	 *
	 * Sent rather than inferred: a wall-mounted AP has a horizontal cut and an upright
	 * omni does not, and the rule that decides it (`rf/antenna.ts`) has to see the
	 * mount. Absent means an omni, which is what every caller before wall mounts sent.
	 */
	mount?: string;
	facingDeg?: number;
}

/**
 * The wall mask of the floor an AP sits on, when that is not the floor being
 * optimised.
 *
 * A cross-floor path is two runs, not one: the ray leaves the AP through its own
 * storey, drops through the slab, and finishes in the storey below. Charging the
 * whole horizontal run against the client's floor — which is what the model did —
 * puts two thirds of a typical path (an AP 4.5 m above its client, slab crossed
 * two thirds along) against the wrong plan entirely.
 */
export interface SourceFloorMask {
	data: Uint8Array;
	width: number;
	height: number;
	materialMask: Uint8Array | null;
	/** Material id this floor's unlabelled wall pixels carry. */
	defaultMaterial: number;
	/**
	 * This mask's origin expressed in the optimised floor's mask frame.
	 *
	 * Everything the worker handles is in the optimised floor's mask pixels, and
	 * the two floors' masks do not share an origin once a floor has been aligned,
	 * so the source mask is handed over pre-shifted rather than making the worker
	 * carry a second coordinate frame.
	 */
	originX: number;
	originY: number;
}

export interface FixedApInput {
	x: number;
	y: number;
	interferenceRadius: number;
	signalScale: number; // floor slab attenuation factor (0-1)
	/**
	 * Vertical distance from this AP to the floor being optimised, in world units.
	 *
	 * Cross-floor paths are 3D: an AP two storeys away is further away, not just
	 * more attenuated. The heatmap always modelled this; the optimiser did not, so
	 * the two disagreed about how far a cross-floor AP reaches.
	 */
	verticalGap: number;
	band: Band;
	/**
	 * The antenna's vertical cut, in degrees. See `ApInput.beamwidthDeg`.
	 *
	 * A fixed AP's pattern matters as much as a placed one's: it is the term that
	 * says an AP on the storey above reaches the floor below better out to the side
	 * than straight down.
	 */
	beamwidthDeg?: number;
	aimDeg?: number;
	/** The mounting and facing of this fixed AP. See `ApInput.mount`. */
	mount?: string;
	facingDeg?: number;
	/** Channel of this fixed AP, or null. See `ApInput.assignedChannel`. */
	assignedChannel?: number | null;
	/** Pinned channel, if the user set one. See `ApInput.fixedChannel`. */
	fixedChannel?: number | null;
	/**
	 * Channel width, for building the non-overlapping palette this AP may be given.
	 * See `planningChannels`. Omitted ⇒ 20 MHz, the narrowest and the only width at
	 * which every band's channels are mutually non-overlapping.
	 */
	channelWidth?: ChannelWidth;
	/**
	 * The AP's own floor's wall mask, for splitting the path at the slab.
	 *
	 * Omitted (or null) when the caller has no mask for that floor; the path is
	 * then charged against the optimised floor's walls alone, as it was before.
	 */
	source?: SourceFloorMask | null;
	/** Fraction along the ray where it leaves the AP's own floor. See `cross-floor.ts`. */
	sourceT?: number;
	/** Fraction along the ray where it enters the optimised floor. */
	targetT?: number;
	/**
	 * Every storey boundary this path crosses, with the room types of the floor
	 * that owns each slab.
	 *
	 * A `Void / Atrium` label there is a hole in that slab, so the ray meets no
	 * concrete at that crossing. Each entry carries the share of the path's
	 * aggregate slab loss charged at that boundary, so a taller gap whose middle
	 * storey is void waives that share rather than the whole figure. An empty list
	 * leaves the slab loss in place everywhere, which is the conservative reading.
	 */
	slabs?: SlabCrossing[] | null;
}

// ─── Precomputed wall-crossing cache ────────────────────────────────────
// Built ONCE before optimization. Maps from a fixed grid of source
// positions to sample points. AP positions snap to nearest grid source
// via O(1) grid lookup (no linear scan).

/**
 * Lazily-built wall attenuation cache.
 *
 * The previous implementation precomputed a row for EVERY interior grid cell
 * (a 8 px lattice, so interiorPixels/64 of them) crossed with every sample
 * point, iterating `for si ... for sj` before the search even started. On a
 * 1500x1200 floorplan that is several million full ray marches up front, which
 * is what parked the progress bar at 0 for so long.
 *
 * The search only ever visits a few hundred distinct quantised positions, so
 * rows are now computed on demand and memoised. Output is unchanged: the
 * position is still floored onto the same 8 px lattice before marching, and the
 * same stride-3 ray march is used.
 */
export interface WallCache {
	/** dB from each sample to a source at (x, y), quantised to the source lattice. */
	tableFor(x: number, y: number): Float32Array;
	band: Band;
}

/**
 * Where a wall-mounted access point may sit, and which way the wall faces there.
 *
 * A wall mount is not a smaller interior — it is a different one. The placement
 * domain for the other mountings deliberately trims the ring of pixels against every
 * wall ("an AP against a wall face is not a placement", `computeBuildingInterior`),
 * which is exactly the ring a wall mount belongs in. So the band is built separately:
 * a breadth-first flood out of the wall pixels into the floor beside them, a bracket's
 * depth deep, carrying each pixel's direction *away* from the wall that reached it.
 *
 * That direction is the facing, quantised to one byte of 22.5° steps. It is what makes
 * a wall mount a search rather than a point: as the optimiser slides a unit along a
 * wall — and around its corners — the horizontal cut of its pattern turns with it, so
 * its profile has to be rebuilt from where it landed (`resolveApProfiles`).
 */
export interface WallPlacement {
	/** 1 where a wall-mounted AP may sit. */
	band: Uint8Array;
	/** Snaps a stray position onto that band. */
	field: InteriorField;
	/** Facing in 22.5° steps, per mask pixel; 255 where the pixel is not in the band. */
	facingStep: Uint8Array;
}

export interface Position {
	id: string;
	x: number;
	y: number;
	radius: number;
	band: Band;
}

/**
 * The two runs a cross-floor AP's path is split into, per sample.
 *
 * A fixed AP never moves, so both runs are constant for a whole run: `source` is
 * the AP's own floor from the AP down to the slab crossing, `suffix` is the
 * optimised floor from the crossing to the sample. They are per *sample* rather
 * than per AP because the crossing moves with the sample.
 */
export interface SplitRows {
	source: Float32Array;
	suffix: Float32Array;
}

/** Everything about a fixed AP's path that does not depend on the search. */
export interface FixedPath {
	/** Wall loss rows when the path is split at the slab; null = use the projected run. */
	split: SplitRows | null;
	/**
	 * Multiplier on the aggregate slab loss, per sample: 1 everywhere by default,
	 * less where a crossing is a hole. A share rather than a flag because a taller
	 * gap crosses several slabs and only some of them may be void.
	 */
	slabFactor: Float32Array | null;
}

export interface EvalContext {
	samples: Array<{ x: number; y: number }>;
	mask: Uint8Array;
	w: number;
	h: number;
	wallAttenuation: number;
	fixedAps: FixedApInput[];
	sampleDensity: number[];
	materialMask: Uint8Array | null;
	defaultMaterial: number;
	/**
	 * Per-fixed-AP path data: the wall split, and whether the slab loss applies at
	 * each sample (a void is a hole in the slab).
	 *
	 * Built once per run by `buildFixedPaths` and carried here so every evaluation —
	 * the Lloyd's loop, the PSO scoring, the final exact pass — reads the same
	 * numbers instead of each deriving its own.
	 */
	fixedPaths: FixedPath[];
	/**
	 * Channels of every source the evaluators see, in the order they see them:
	 * the candidate positions first, then `fixedAps`.
	 *
	 * Only the interference term reads these. `resolveChannels` has already
	 * collapsed "any source unassigned" into the all-co-channel bound, so the
	 * evaluators never branch on it.
	 */
	sourceChannels: number[];
	/**
	 * Channels each source may take, when the worker is to colour the layout
	 * itself: candidates first, then `fixedAps`, matching `sourceChannels`. A
	 * single-element list is a pin. Null when no regulatory domain was supplied,
	 * in which case `sourceChannels` as given is used instead.
	 */
	sourceAllowed: number[][] | null;
	/**
	 * Band of every source, in the same order as `sourceChannels`.
	 *
	 * The interference term is per band: channel numbers repeat across bands (6
	 * GHz uses 1/5/9/…, 2.4 GHz uses 1-13), so a pair can only be co-channel when
	 * it is in the same band. See `violatesAt`.
	 */
	sourceBands: string[];
	/**
	 * Vertical distance from each access point being placed to the client, world
	 * units, index-aligned with `positions`. Zero for every AP while the project
	 * leaves mounting heights off. See `ApInput.verticalGap`.
	 */
	apGaps: Float64Array;
	/**
	 * How high the client stands at each sample, world units, index-aligned with
	 * `samples`. Null when the floor has no raised surfaces, so a flat plan pays
	 * nothing for the feature.
	 *
	 * This is the half of the gap that belongs to the *sample* rather than to the AP: a
	 * mezzanine's client is closer to a ceiling-mounted unit than the floor's is, and a
	 * stair climbs between the two. See `rf/surface-height.ts`.
	 */
	sampleLift: Float64Array | null;
	/**
	 * The raised surfaces themselves, for the deck test.
	 *
	 * `sampleLift` says how high the client is; this says whether the path from a source
	 * below had to pass through a deck to reach it (and what that costs). Kept as geometry
	 * because the answer depends on the *source's* height as well as the sample's.
	 */
	surfaces: SurfaceRect[];
	/** World units per metre, for the deck's thickness against a gap in world units. */
	wupm: number;
	/**
	 * Each placed access point's vertical antenna cut, index-aligned with
	 * `positions` and `apGaps`. See `ApInput.beamwidthDeg`.
	 */
	apProfiles: AntennaProfile[];
	/** The same, for the fixed APs, in `fixedAps` order. */
	fixedProfiles: AntennaProfile[];
	/**
	 * Weight of the interference share in the objective. Zero restores the
	 * coverage-only objective exactly, which is what the A/B measurement uses.
	 */
	interferenceWeight: number;
	/**
	 * How far below the coverage threshold a sample still earns utility, in dB.
	 *
	 * Zero is the hard threshold every measurement before 2026-09-23 was taken
	 * with; see `DEFAULT_COVERAGE_SOFTNESS_DB` for why the objective wants a
	 * transition there and what the measurement showed.
	 */
	coverageSoftnessDb: number;
	/**
	 * Vertical drop of a same-floor path, world units. The path *loss* treats a same-floor
	 * path as 2D on purpose; the wall march cannot, because it charges the length of material
	 * the ray passes through. See `OptimizeMessage.localVerticalDrop`.
	 */
	localVerticalDropWu: number;
	/**
	 * Covered share the result must reach, as a 0-1 fraction. Zero is no constraint.
	 * See `COVERAGE_FLOOR_MULTIPLIER`.
	 */
	coverageFloor: number;
	/**
	 * Narrowest channel width in the run, in MHz.
	 *
	 * Sets the CCA threshold, because preamble detect scales with the width a receiver is
	 * listening on: a station on a 20 MHz channel defers at −82 dBm regardless of what its
	 * neighbours do with 80 MHz, so a mixed-width run is scored at the most sensitive
	 * threshold present. See `ccaThresholdDbm`.
	 */
	minChannelWidthMhz: number;
	/** True when `sourceChannels` are real assignments rather than the worst case. */
	channelsKnown: boolean;
	/**
	 * Frequency overlap between two sources' assignments, for the graded
	 * interference figure. Built once per run from the sources' bands and widths;
	 * see `makeOverlapLookup` and `interferenceAt`.
	 */
	overlap: OverlapLookup;
	/**
	 * The APs as the caller sent them, index-aligned with `positions`.
	 *
	 * Kept so a wall-mounted unit's profile can be rebuilt from its own numbers when
	 * the search moves it: see `resolveApProfiles`.
	 */
	apSources: ApInput[];
	/**
	 * Which of the placed APs are wall-mounted, index-aligned with `positions`.
	 *
	 * A wall mount is a different search: its positions are the band of floor along
	 * the walls rather than the whole interior, and its pattern turns with the wall it
	 * is on, so its antenna profile is a function of where it is.
	 */
	wallMounted: boolean[];
	/**
	 * The wall band: where a wall-mounted AP may sit, and which way the wall faces
	 * there. Null when the run has no wall mounts, or the floor has no walls.
	 */
	wallPlacement: WallPlacement | null;
}

/** What one exact evaluation produces. */
export interface ExactEval {
	/**
	 * Density-weighted mean coverage utility *minus*
	 * `interferenceWeight · interference` — the quantity being optimised.
	 */
	score: number;
	/**
	 * Density-weighted share of samples whose best server is degraded by a
	 * co-channel secondary within `COCHANNEL_REUSE_DB` of it. Zero when no AP is
	 * co-channel with any other, and zero-weighting it leaves `score` unchanged.
	 */
	interference: number;
	/**
	 * Density-weighted share of samples that are *covered*, i.e. whose best
	 * source reached the coverage threshold.
	 *
	 * Counted as `best > 0` rather than by re-deriving the margin:
	 * `coverageUtility` returns 0 at or below the threshold and rises above it,
	 * so a positive best is exactly "covered". That keeps this figure on the same
	 * definition `updateCoverage` reports without a second margin pipeline that
	 * could drift from it.
	 */
	coverage: number;
	/**
	 * How far below the ε-constraint's floor the plan fell, as a 0-1 fraction. Zero
	 * when there is no floor or the floor is met.
	 */
	shortfall: number;
	/** Samples the figure was computed from, before density weighting. */
	samples: number;
	/**
	 * Share of the floor where two APs on overlapping channels are both above the CCA
	 * threshold — airtime the plan shares, whether or not their levels are far enough
	 * apart for the interference term to care. Reported, not optimised, and zero
	 * unless the caller asked for it. See `contentionShare`, `ROADMAP.md` B4/B5.
	 */
	contention: number;
}

/**
 * Every source's margin at every sample, and the conflict graph those margins
 * imply. One definition, two consumers.
 *
 * Split out of `evaluateExactDetailed` for the assignment graph
 * (`buildConflictGraph`): the main-thread solver has to colour the *same* graph
 * the objective scores, and the only way to guarantee that is for both to read
 * this one field. Duplicating the loop instead would let the margin formula, the
 * horizon test or the band filter drift between the two paths, which is exactly
 * the fault this split exists to fix — the solver used to build its edges from
 * circle overlap plus an AP-to-AP distance heuristic while the objective used
 * these margins, and the two disagreed about the same placement.
 *
 * A margin is `-Infinity` outside its source's coverage reach, so a source that
 * cannot serve a sample cannot be its interference either.
 */
export interface MarginField {
	/** `samples.length * count`, one row of `count` per sample, in the coverage domain. */
	allMargins: Float64Array;
	/**
	 * The same margins, kept down to `CCA_BELOW_THRESHOLD_DB` below the coverage
	 * threshold instead of clipped at it.
	 *
	 * Only the contention figure reads this. The objective's domain is the coverage
	 * circle — a sample nobody covers earns no utility and no interference term — but
	 * airtime is shared outside it, so the report needs the wider set and the score
	 * must not have it.
	 */
	ccaMargins: Float64Array;
	/** `count x count`, 1 where a pair must not share a channel. See `markSampleConflicts`. */
	conflicts: Uint8Array;
	/**
	 * The same pairs, weighted by how many density-weighted samples they spoil.
	 *
	 * Read by the colourer, which has to decide *which* conflict to leave standing when
	 * the palette is short. See `conflictWeights`.
	 */
	weights: Float32Array;
	/** Best margin at each sample, i.e. the best server. */
	bestBySample: Float64Array;
	/**
	 * Margin the coverage utility reads at each sample; the same value as
	 * `bestBySample`.
	 */
	utilityMargin: Float64Array;
	/** Sources the field covers: the positions, then the fixed APs. */
	count: number;
}

/** One AP's power after the TPC pass, in dBm, with the radius it implies. */
export interface PowerChoice {
	id: string;
	power: number;
	radius: number;
}

export interface InteriorField {
	nearest: Int32Array; // pixel index of the nearest interior pixel, or -1
	w: number;
	h: number;
}
