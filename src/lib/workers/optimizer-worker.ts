/// <reference lib="webworker" />

import { computeBuildingInterior } from '../canvas/morphology.js';
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
import { crossFloorSegments, slabLossFactor, type SlabCrossing } from '../rf/cross-floor.js';
import {
	antennaLossDb,
	antennaProfileForMount,
	antennaRayLossDb,
	azimuthLossDb,
	defaultAntenna,
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
	resolveChannels,
	type OverlapLookup
} from '../rf/interference.js';
import { makeOverlapLookup } from '../rf/channel-overlap.js';
import {
	getMaterialDbTable,
	isVirtualMaterial,
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

/**
 * One placed access point, as this worker reads it.
 *
 * The shape the *caller* is held to is `optimizer-protocol.ts`'s `ApInput`, derived
 * from the app's own `AccessPoint` so that a payload which forgets the mounting or the
 * facing does not compile. This declaration stays here as the receiving contract, with
 * the fields optional because the graph-only path and the tests build messages by hand;
 * `assertApPayload` is what catches a caller that bypasses the type.
 */
interface ApInput {
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
interface SourceFloorMask {
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

interface FixedApInput {
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

interface OptimizeMessage {
	type: 'optimize';
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
}

type InMessage = OptimizeMessage | CancelMessage;

let cancelled = false;

/**
 * Seeded PRNG (mulberry32).
 *
 * The optimiser used bare `Math.random()` in three places — the k-means++ seed
 * pick, the PSO position jitter and the PSO velocity update — with no way to
 * set or recover the stream. Two runs on identical input could therefore return
 * different placements, which makes every before/after comparison of a model
 * change meaningless: you cannot tell an improvement from a lucky draw.
 *
 * The seed actually used is reported back in the result message, so a run can be
 * repeated exactly by passing that seed in again.
 */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Random source for the current run; replaced at the start of every run. */
let random: () => number = Math.random;

/**
 * Seed used when the caller does not supply one.
 *
 * Deliberately a constant. An unseeded default made two clicks on "Optimize
 * Placement" produce two different placements, which reads as a bug rather than
 * as stochastic search — and it made results impossible to compare. Pass an
 * explicit `seed` to vary it; the seed actually used is always reported back.
 */
const DEFAULT_OPTIMIZER_SEED = 20260921;

/** Seed of the run in flight, echoed back on the result message. */
let runSeed = 0;

self.onmessage = (event: MessageEvent<InMessage>) => {
	const msg = event.data;
	if (msg.type === 'cancel') {
		cancelled = true;
		return;
	}
	if (msg.type === 'optimize') {
		cancelled = false;
		runSeed = (msg.seed ?? DEFAULT_OPTIMIZER_SEED) >>> 0;
		random = mulberry32(runSeed);
		runOptimization(msg).catch((err) => {
			self.postMessage({
				type: 'result',
				positions: msg.aps.map((a) => ({ id: a.id, x: a.x, y: a.y })),
				score: 0,
				improvement: 0,
				error: String(err)
			});
		});
	}
};

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
interface WallCache {
	/** dB from each sample to a source at (x, y), quantised to the source lattice. */
	tableFor(x: number, y: number): Float32Array;
	band: Band;
}

/** Source quantisation lattice, in mask pixels. */
const SOURCE_GRID = 8;

function createWallCache(
	mask: Uint8Array,
	w: number,
	h: number,
	samples: Array<{ x: number; y: number }>,
	wallAttenuation: number,
	band: Band,
	materialMask: Uint8Array | null,
	defaultMaterial: number
): WallCache {
	// Per-band material tables: the figure for one crossing of each material, which is what
	// `rayMarchWallAtten` charges and what the heatmap's field charges for the same crossing.
	const materialDb = getMaterialDbTable(band);
	// Without a material mask every wall costs the same, so honour the project's
	// explicit wall attenuation rather than substituting Drywall's value.
	const defaultDb = materialMask
		? (materialDb[defaultMaterial] ?? wallAttenuation)
		: wallAttenuation;

	const numSamples = samples.length;
	const rows = new Map<string, Float32Array>();

	return {
		band,
		tableFor(x: number, y: number): Float32Array {
			const qx = Math.round(x / SOURCE_GRID);
			const qy = Math.round(y / SOURCE_GRID);
			const key = qx + ',' + qy;
			const hit = rows.get(key);
			if (hit) return hit;

			const sx = qx * SOURCE_GRID;
			const sy = qy * SOURCE_GRID;
			const row = new Float32Array(numSamples);
			for (let s = 0; s < numSamples; s++) {
				// Stride-3 DDA; this is the approximation stage 3 later redoes exactly.
				row[s] = rayMarchWallAtten(
					mask,
					w,
					h,
					materialMask,
					materialDb,
					defaultDb,
					sx,
					sy,
					samples[s]!.x,
					samples[s]!.y,
					3,
					defaultMaterial
				);
			}
			rows.set(key, row);
			return row;
		}
	};
}

// ─── Evaluation ─────────────────────────────────────────────────────────

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
interface WallPlacement {
	/** 1 where a wall-mounted AP may sit. */
	band: Uint8Array;
	/** Snaps a stray position onto that band. */
	field: InteriorField;
	/** Facing in 22.5° steps, per mask pixel; 255 where the pixel is not in the band. */
	facingStep: Uint8Array;
}

/** Facing of a band pixel, in degrees, or null when it is not in the band. */
function facingAt(placement: WallPlacement, x: number, y: number, w: number, h: number): number | null {
	const ix = Math.round(x);
	const iy = Math.round(y);
	if (ix < 0 || iy < 0 || ix >= w || iy >= h) return null;
	const step = placement.facingStep[iy * w + ix]!;
	return step === 255 ? null : step * 22.5;
}

/**
 * The band of floor beside the walls, and the facing each point on it looks in.
 *
 * `inside` is the *untrimmed* interior — the wall mask's complement within the
 * building — because the trimmed one has already given up the pixels this needs. The
 * flood is 8-connected and capped at `radiusWu` steps, so it costs one pass over the
 * band rather than a dilation of the whole mask.
 */
function buildWallPlacement(
	wallMask: Uint8Array,
	inside: Uint8Array,
	w: number,
	h: number,
	radiusWu: number,
	/**
	 * Materials per wall pixel and the floor's default, when the caller sent them.
	 *
	 * A **virtual partition** is a modelling line, not a surface: it attenuates nothing,
	 * and a bracket cannot be screwed to it. Such pixels are not seeds here, so the band
	 * never forms against one and a wall-mounted AP is never placed facing a line that
	 * radiates both ways. See `wall-snap.ts`, which applies the same rule on the app side.
	 */
	materialMap: Uint8Array | null = null,
	defaultMaterial = 0
): WallPlacement | null {
	const n = w * h;
	const radius = Math.max(1, Math.min(64, Math.round(radiusWu)));
	const band = new Uint8Array(n);
	const facingStep = new Uint8Array(n).fill(255);
	const dist = new Int16Array(n).fill(-1);
	const seedX = new Int16Array(n);
	const seedY = new Int16Array(n);
	const queue = new Int32Array(n);
	let head = 0;
	let tail = 0;

	for (let i = 0; i < n; i++) {
		if (!wallMask[i]) continue;
		if (materialMap) {
			const material = materialMap[i] ?? defaultMaterial;
			if (isVirtualMaterial(material as WallMaterialId)) continue;
		}
		dist[i] = 0;
		queue[tail++] = i;
	}
	if (tail === 0) return null;

	while (head < tail) {
		const idx = queue[head++]!;
		const d = dist[idx]!;
		if (d >= radius) continue;
		const x = idx % w;
		const y = (idx / w) | 0;
		for (let dy = -1; dy <= 1; dy++) {
			const ny = y + dy;
			if (ny < 0 || ny >= h) continue;
			for (let dx = -1; dx <= 1; dx++) {
				if (dx === 0 && dy === 0) continue;
				const nx = x + dx;
				if (nx < 0 || nx >= w) continue;
				const nIdx = ny * w + nx;
				if (dist[nIdx] !== -1) continue;
				// The flood runs through floor only: a wall pixel is a seed, not a
				// corridor, and starting one from another wall pixel would push the
				// band through a thick wall into the room behind it.
				if (!inside[nIdx]) continue;
				dist[nIdx] = d + 1;
				// The seed travels with the pixel, so the facing is away from the wall
				// that actually reached it rather than away from some other wall.
				const sx0 = d === 0 ? x : seedX[idx]!;
				const sy0 = d === 0 ? y : seedY[idx]!;
				seedX[nIdx] = sx0;
				seedY[nIdx] = sy0;
				band[nIdx] = 1;
				const vx = nx - sx0;
				const vy = ny - sy0;
				if (vx !== 0 || vy !== 0) {
					const deg = (Math.atan2(vy, vx) * 180) / Math.PI;
					facingStep[nIdx] = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
				}
				queue[tail++] = nIdx;
			}
		}
	}

	let any = false;
	for (let i = 0; i < n; i++) {
		if (band[i]) {
			any = true;
			break;
		}
	}
	if (!any) return null;
	return { band, field: buildInteriorField(band, w, h), facingStep };
}

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
interface Position {
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
interface SplitRows {
	source: Float32Array;
	suffix: Float32Array;
}

/** Everything about a fixed AP's path that does not depend on the search. */
interface FixedPath {
	/** Wall loss rows when the path is split at the slab; null = use the projected run. */
	split: SplitRows | null;
	/**
	 * Multiplier on the aggregate slab loss, per sample: 1 everywhere by default,
	 * less where a crossing is a hole. A share rather than a flag because a taller
	 * gap crosses several slabs and only some of them may be void.
	 */
	slabFactor: Float32Array | null;
}

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
			const gap = ctx.apGaps[a] ?? 0;
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
			// distance, and its antenna's cuts are part of the loss.
			const wide =
				sourceMargin(dist, ap.radius, row, gap, -softness) -
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
			const wide =
				sourceMargin(dist, fap.interferenceRadius, loss, fap.verticalGap, -softness) -
				antennaRayLossDb(ctx.fixedProfiles[f]!, fap.verticalGap, dx, dy);
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
interface EvalContext {
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
interface ExactEval {
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
interface MarginField {
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


	const lossFor = (band: Band, x0: number, y0: number, x1: number, y1: number): number =>
		rayMarchWallAtten(
			mask,
			w,
			h,
			materialMask,
			tablesFor(band),
			defaultDbFor(band),
			x0,
			y0,
			x1,
			y1,
			1,
			defaultMaterial
		);

	/**
	 * Wall loss from a fixed AP to one sample, split at the slab when the AP's own
	 * floor's mask is available.
	 *
	 * Marched at stride 1 like everything else in this pass, so the split is as
	 * exact as the single-floor path it replaces rather than inheriting the fast
	 * pass's stride-3 approximation.
	 */
	const fixedLossFor = (fap: FixedApInput, sx: number, sy: number): number => {
		const src = fap.source;
		const seg = src
			? crossFloorSegments(fap.sourceT ?? 0, fap.targetT ?? 0, fap.x, fap.y, sx, sy)
			: null;
		if (!src || !seg) return lossFor(fap.band, fap.x, fap.y, sx, sy);

		const tables = tablesFor(fap.band);
		const sourceDefault = src.materialMask
			? (tables[src.defaultMaterial] ?? wallAttenuation)
			: wallAttenuation;
		return (
			rayMarchWallAtten(
				src.data,
				src.width,
				src.height,
				src.materialMask,
				tables,
				sourceDefault,
				seg.source.from.x - src.originX,
				seg.source.from.y - src.originY,
				seg.source.to.x - src.originX,
				seg.source.to.y - src.originY,
				1,
				src.defaultMaterial
			) +
			rayMarchWallAtten(
				mask,
				w,
				h,
				materialMask,
				tables,
				defaultDbFor(fap.band),
				seg.target.from.x,
				seg.target.from.y,
				seg.target.to.x,
				seg.target.to.y,
				1,
				defaultMaterial
			)
		);
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
		for (let ai = 0; ai < positions.length; ai++) {
			const ap = positions[ai]!;
			const gap = ctx.apGaps[ai] ?? 0;
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
				sourceMargin(dist, ap.radius, loss, gap, -horizon) -
				antennaRayLossDb(apProfiles[ai]!, gap, dx, dy);
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
			if (
				!(slabDb < Infinity) ||
				dist >=
					sourceHorizonToward(
						fap.interferenceRadius,
						slabLoss,
						fap.verticalGap,
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
				sourceMargin(dist, fap.interferenceRadius, loss, fap.verticalGap, -horizon) -
				antennaRayLossDb(ctx.fixedProfiles[fi]!, fap.verticalGap, dx, dy);
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

/** One AP's power after the TPC pass, in dBm, with the radius it implies. */
interface PowerChoice {
	id: string;
	power: number;
	radius: number;
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
	msg: OptimizeMessage
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
interface InteriorField {
	nearest: Int32Array; // pixel index of the nearest interior pixel, or -1
	w: number;
	h: number;
}

function buildInteriorField(interior: Uint8Array, w: number, h: number): InteriorField {
	const n = w * h;
	const nearest = new Int32Array(n).fill(-1);
	const queue = new Int32Array(n);
	let head = 0;
	let tail = 0;

	// Seed: every interior pixel is its own nearest neighbour.
	for (let i = 0; i < n; i++) {
		if (interior[i]) {
			nearest[i] = i;
			queue[tail++] = i;
		}
	}

	// Multi-source BFS. Each pixel is enqueued at most once, so a queue of size
	// n is sufficient.
	while (head < tail) {
		const idx = queue[head++]!;
		const src = nearest[idx]!;
		const x = idx % w;
		const y = (idx / w) | 0;
		for (let dy = -1; dy <= 1; dy++) {
			const ny = y + dy;
			if (ny < 0 || ny >= h) continue;
			for (let dx = -1; dx <= 1; dx++) {
				if (dx === 0 && dy === 0) continue;
				const nx = x + dx;
				if (nx < 0 || nx >= w) continue;
				const nIdx = ny * w + nx;
				if (nearest[nIdx] !== -1) continue;
				nearest[nIdx] = src;
				queue[tail++] = nIdx;
			}
		}
	}

	return { nearest, w, h };
}

/**
 * Snap a position onto the building interior.
 *
 * The clamp is essential. The BFS field covers every in-mask pixel, so a
 * *clamped* lookup always resolves to an interior pixel. Without the clamp, a
 * point outside the mask was returned unchanged — and PSO's initial jitter
 * (`+/- max(w,h) * 0.2`, applied to positions that may already sit near an
 * edge) produces such points readily. Stage 3 only accepts moves that land on
 * an interior pixel and skips out-of-bounds candidates, so an AP placed outside
 * by PSO could never move back in. That is how optimised APs ended up off-plan.
 */
function snapToInterior(
	x: number,
	y: number,
	field: InteriorField,
	allowOutside: boolean
): { x: number; y: number } {
	if (allowOutside) return { x: Math.round(x), y: Math.round(y) };

	const ix = Math.min(field.w - 1, Math.max(0, Math.round(x)));
	const iy = Math.min(field.h - 1, Math.max(0, Math.round(y)));
	const src = field.nearest[iy * field.w + ix]!;
	if (src >= 0) return { x: src % field.w, y: (src / field.w) | 0 };
	// Only reachable when the mask has no interior at all, which the caller
	// guards against before starting.
	return { x: ix, y: iy };
}

/**
 * The single place that decides whether an AP may occupy a position.
 *
 * The bounds test is deliberately kept even though `interior` is available:
 * for a negative x, `y * w + x` aliases into the previous row and can read a
 * genuine interior pixel, so an out-of-range coordinate would be accepted as
 * legal if the bounds check were dropped. Centralising the policy here replaces
 * the ad-hoc `nx < 0 || nx >= w` tests that were scattered through the search.
 */
function isPositionAllowed(
	x: number,
	y: number,
	interior: Uint8Array | null,
	w: number,
	h: number,
	allowOutside: boolean,
	voidMask: Uint8Array | null = null
): boolean {
	if (x < 0 || x >= w || y < 0 || y >= h) return false;
	// A void is a hole in the floor — an atrium, a stairwell — with nothing to mount
	// an AP to. That is a physical fact rather than a preference about rooms, so it
	// does not become legal because the user allowed APs outside rooms.
	if (voidMask && voidMask[y * w + x] === 1) return false;
	if (allowOutside || !interior) return true;
	return interior[y * w + x] === 1;
}

/**
 * Snap a candidate position for one AP into the domain that AP is allowed in.
 *
 * A wall-mounted AP's domain is the band along the walls rather than the interior: an
 * AP against a wall face is exactly what the interior was trimmed to exclude. The band
 * is a bracket's depth wide, so a position the search puts there is already on a wall;
 * the caller then puts it exactly on the face when it applies the result.
 */
function snapForAp(
	a: number,
	x: number,
	y: number,
	wallMounted: boolean[],
	snapTarget: { field: InteriorField; free: boolean },
	wallPlacement: WallPlacement | null
): { x: number; y: number } {
	if (wallMounted[a] && wallPlacement) return snapToInterior(x, y, wallPlacement.field, false);
	return snapToInterior(x, y, snapTarget.field, snapTarget.free);
}

/** Whether an AP may occupy a position — the same split as `snapForAp`. */
function allowedForAp(
	a: number,
	x: number,
	y: number,
	wallMounted: boolean[],
	wallPlacement: WallPlacement | null,
	interior: Uint8Array | null,
	w: number,
	h: number,
	allowOutside: boolean,
	voidMask: Uint8Array | null
): boolean {
	if (wallMounted[a] && wallPlacement) {
		if (x < 0 || x >= w || y < 0 || y >= h) return false;
		// A void is a hole in the floor: there is no wall to mount to over a shaft,
		// whatever the mask says around it.
		if (voidMask && voidMask[y * w + x] === 1) return false;
		return wallPlacement.band[y * w + x] === 1;
	}
	return isPositionAllowed(x, y, interior, w, h, allowOutside, voidMask);
}

/**
 * Where an AP may be snapped to, and whether snapping happens at all.
 *
 * With `allowOutside` the answer used to be "anywhere", which put APs over atriums.
 * When the floor has voids the target becomes "anywhere that is not a hole"
 * instead: the nearest pixel with a floor, which may well be outside a room.
 */
function buildSnapTarget(
	interior: Uint8Array,
	voidMask: Uint8Array | null,
	w: number,
	h: number,
	allowOutside: boolean
): { field: InteriorField; free: boolean } {
	if (!allowOutside) return { field: buildInteriorField(interior, w, h), free: false };
	if (!voidMask) return { field: buildInteriorField(interior, w, h), free: true };
	const solid = new Uint8Array(w * h);
	for (let i = 0; i < solid.length; i++) solid[i] = voidMask[i] === 1 ? 0 : 1;
	return { field: buildInteriorField(solid, w, h), free: false };
}

// ─── Yield to event loop for cancel checks ──────────────────────────────

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

// ─── Main optimization pipeline ─────────────────────────────────────────

async function runOptimization(msg: OptimizeMessage): Promise<void> {
	const {
		aps,
		fixedAps,
		wallMask: mask,
		maskWidth: w,
		maskHeight: h,
		wallAttenuation,
		materialMask,
		defaultMaterial,
		allowOutside,
		densityMap,
		medianDensity,
		roomTypeMask
	} = msg;

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

	// maxDim 400 matches the resolution the real-time coverage cache and the
	// canvas use. At 200 the interior boundary was quantised twice as coarsely
	// (about 7.5 full-resolution pixels on a 1500 px plan instead of 3.75),
	// which let the optimiser accept positions that visibly sat outside a room.
	const { interior } = computeBuildingInterior(mask, w, h, {
		maxDim: 400,
		dilateRatio: 0.04,
		minDilateR: 4,
		// This mask is the placement domain: an AP against a wall face is not a placement.
		trimWallAdjacent: true,
		// ...and a wall cavity is not a room. Without this the domain includes every
		// sliver a plan encloses between two drawn lines, which the search then uses —
		// an AP 3 cm from a wall, in a 0.6 m² pocket. See `minRoomRadiusWu`.
		minRegionRadius: msg.minRoomRadiusWu ?? 0
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

	if (cancelled) {
		self.postMessage({ type: 'cancelled' });
		return;
	}

	const interiorPixels: number[] = [];
	for (let i = 0; i < w * h; i++) {
		if (interior[i]) interiorPixels.push(i);
	}

	if (aps.length === 0) {
		self.postMessage({ type: 'result', positions: [], score: 0, improvement: 0, seed: runSeed });
		return;
	}

	// No enclosed space detected. This is not a rare edge case in practice: walls
	// that do not form a CLOSED outline leave the flood fill nothing to be
	// enclosed by, so `interior` comes back empty. This branch used to return the
	// APs untouched and report nothing, so the user saw "the optimiser left my
	// APs outside" with no explanation. Say so instead.
	if (interiorPixels.length === 0 && !allowOutside) {
		self.postMessage({
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
		const { interior: untrimmed } = computeBuildingInterior(mask, w, h, {
			maxDim: 400,
			dilateRatio: 0.04,
			minDilateR: 4,
			// The band has to obey the same room test as the domain: a wall mount in a
			// cavity between two drawn lines is the same complaint as a ceiling one there.
			minRegionRadius: msg.minRoomRadiusWu ?? 0
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
	self.postMessage({
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
	if (cancelled) {
		self.postMessage({ type: 'cancelled' });
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
		self.postMessage({
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
		if (cancelled) {
			self.postMessage({ type: 'cancelled' });
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
			for (let a = 0; a < numAps; a++) {
				const dx = samples[s]!.x - positions[a]!.x;
				const dy = samples[s]!.y - positions[a]!.y;
				const dist = Math.sqrt(dx * dx + dy * dy);
				const margin =
					sourceMargin(
						dist,
						positions[a]!.radius,
						iterApRows[a]![s]!,
						ctx.apGaps[a] ?? 0,
						-ctx.coverageSoftnessDb
					) -
					antennaRayLossDb(iterApProfiles[a]!, ctx.apGaps[a] ?? 0, dx, dy);
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
						wallDb + slabDb,
						fap.verticalGap,
						-ctx.coverageSoftnessDb
					) -
					antennaRayLossDb(ctx.fixedProfiles[f]!, fap.verticalGap, dx, dy);
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
	self.postMessage({
		type: 'progress',
		positions: positions.map((p) => ({ id: p.id, x: p.x, y: p.y })),
		score: lloydsScore,
		iteration: 25,
		totalIterations: 100,
		stage: "Lloyd's complete"
	});

	await yieldToEventLoop();
	if (cancelled) {
		self.postMessage({ type: 'cancelled' });
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
			if (cancelled) {
				self.postMessage({ type: 'cancelled' });
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
			self.postMessage({
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
	if (cancelled) {
		self.postMessage({ type: 'cancelled' });
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
		if (cancelled) {
			self.postMessage({ type: 'cancelled' });
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
		self.postMessage({
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

	self.postMessage({
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
