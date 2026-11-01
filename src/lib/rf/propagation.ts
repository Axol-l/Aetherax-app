/**
 * Shared RF propagation module — imported by both heatmap and optimizer workers.
 * Pure computation, no DOM APIs.
 *
 * Provides:
 * - Indoor signal power model (inverse quartic path loss)
 * - DDA wall ray march (stride-configurable)
 * - Precomputed wall attenuation field (build once, O(1) lookup)
 * - Base rate lookup table
 */

// ─── Signal model ──────────────────────────────────────────────────

/**
 * Indoor propagation: inverse quartic falloff (path loss exponent n=4).
 * signal = 1 / (1 + (d²/r²)²).  No sqrt — pure multiply + divide.
 */
export function signalPower(distSq: number, radiusSq: number): number {
	if (radiusSq <= 0) return 0;
	const ratioSq = distSq / radiusSq;
	return 1 / (1 + ratioSq * ratioSq);
}

// ─── Wall ray march ────────────────────────────────────────────────

/**
 * DDA ray march with configurable stride.
 *
 * Charges **one figure per crossing, out of the material table**: `materialDb[matId]`, which
 * is `dbPerMeter(material, band) × typicalThickness(material)` — the table's own measured
 * figure for one wall of that material. `stride = 1` checks every pixel, `stride = 3` every
 * third. A wall painted in two materials is charged once per painted segment, because each
 * segment is a label somebody placed.
 *
 * ## Why the drawn thickness is not charged
 *
 * This used to accumulate `dbPerMeter × length of material walked`, reading "how many pixels
 * of this material the ray passes through" as the wall's thickness. A reported project showed
 * why that does not work, in both directions at once:
 *
 * 1. **The material mask is a painted label map, not a thickness map.** Painting stamps a disc
 *    of `wallBrushSize` radius — 15 px — so the run of one material a ray crosses is the
 *    brush's width, not the wall's. On that project one glass stroke over a thin wall came out
 *    as 30 px = 0.59 m of glass, and at 200 dB/m that is **117 dB for one partition**, where
 *    the table's figure for a glass pane is 2 dB.
 * 2. **A drawn band width is a drawing convention.** Concrete drawn 11 px happens to be 0.21 m
 *    at that project's scale and so matches its 0.20 m table entry, but a partition drawn just
 *    as wide and labelled glass is a pane, and nothing in the file says which convention the
 *    drawing used.
 *
 * The cost was visible as *disagreement between two consumers of the same model*: on that
 * project the coverage panel read **68 %** on a floor where the heatmap — which has always
 * charged the table, one figure per crossing — read **95 %**, and the optimiser's objective
 * was built on the same inflated losses. Charging the table puts them back together: measured
 * 94.6 % against 94.7 % on that floor, 90.2 % against 90.2 % on another (`rf/field-vs-march.test.ts`).
 *
 * The wall's *geometry* is still the drawn one: which walls a ray crosses, and at what angle,
 * comes from the mask. What is no longer taken from the drawing is how thick a wall is — that
 * is a property of the material, and the table already states it.
 */
export function rayMarchWallAtten(
	wallData: Uint8Array,
	w: number,
	h: number,
	materialMap: Uint8Array | null,
	materialDb: number[],
	defaultDb: number,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	stride = 3,
	defaultMaterialId = 0
): number {
	const ix0 = Math.round(x0),
		iy0 = Math.round(y0);
	const lenX = Math.round(x1) - ix0;
	const lenY = Math.round(y1) - iy0;
	const steps = Math.max(Math.abs(lenX), Math.abs(lenY));
	const n = Math.ceil(steps / stride);
	if (n <= 0) return 0;
	const dx = lenX / n;
	const dy = lenY / n;

	let total = 0;
	/** Material of the run currently being walked, or -1 outside a wall. */
	let runMaterial = -1;
	for (let s = 0; s <= n; s++) {
		const px = (ix0 + s * dx + 0.5) | 0;
		const py = (iy0 + s * dy + 0.5) | 0;
		if (px >= 0 && px < w && py >= 0 && py < h) {
			const idx = py * w + px;
			if (wallData[idx] === 1) {
				const matId = materialMap ? (materialMap[idx] ?? defaultMaterialId) : defaultMaterialId;
				// One charge per material segment: entering the wall, or crossing into a
				// differently painted part of it.
				if (matId !== runMaterial) {
					/*
					 * `defaultDb` is the cost of a wall whose material id no longer resolves —
					 * a custom material that has since been deleted, with its id still painted
					 * into the mask. It is not a floor-wide attenuation: a wall that has a
					 * material is charged that material's figure, always.
					 */
					total += materialDb[matId] ?? defaultDb;
					runMaterial = matId;
				}
			} else {
				runMaterial = -1;
			}
		} else {
			runMaterial = -1;
		}
	}
	return total;
}

/**
 * Count wall crossings (0→1 transitions) along a ray.
 * Used by optimizer for wall-crossing count (multiplied by flat dB).
 */
export function countWallCrossings(
	wallData: Uint8Array,
	w: number,
	h: number,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	stride = 1
): number {
	const ix0 = Math.round(x0),
		iy0 = Math.round(y0);
	const lenX = Math.round(x1) - ix0;
	const lenY = Math.round(y1) - iy0;
	const steps = Math.max(Math.abs(lenX), Math.abs(lenY));
	const n = stride > 1 ? Math.ceil(steps / stride) : steps;
	if (n <= 0) return 0;
	const dx = lenX / n;
	const dy = lenY / n;

	let count = 0;
	let wasWall = false;
	for (let s = 0; s <= n; s++) {
		const px = (ix0 + s * dx + 0.5) | 0;
		const py = (iy0 + s * dy + 0.5) | 0;
		if (px >= 0 && px < w && py >= 0 && py < h) {
			const isWall = wallData[py * w + px] === 1;
			if (isWall && !wasWall) count++;
			wasWall = isWall;
		} else {
			wasWall = false;
		}
	}
	return count;
}

// ─── Precomputed attenuation field ────────────────────────────────

/** Grid spacing for the precomputed attenuation field (in wall-mask pixels). */
export const ATTEN_GRID_STEP = 6;

/**
 * Polar attenuation field — cumulative wall dB stored by angle and distance
 * from the AP. Built by marching outward in radial slices (720 angles = 0.5°).
 * 55× faster than the old Cartesian grid (360K vs 20M DDA steps).
 *
 * Lookup: atan2 → angle bucket, distance → distance bucket. O(1).
 * No field boundary artifacts. Wall shadows extend naturally in all directions.
 */
export interface AttenField {
	/** Cumulative dB at [angle * distBuckets + distIdx]. */
	data: Float32Array;
	angles: number;
	distBuckets: number;
	distStep: number; // world units per distance bucket
	apX: number;
	apY: number;
	/** Final (edge) attenuation per angle — used for pixels beyond maxDist. */
	edgeAtten: Float32Array;
}

const POLAR_ANGLES_FULL = 720; // 0.5° per slice
const POLAR_ANGLES_FAST = 360; // 1° per slice (drag mode)

/**
 * Build a polar attenuation field by marching outward from the AP in radial slices.
 * Each slice accumulates wall dB incrementally — no redundant ray marching.
 */
export function buildAttenField(
	apX: number,
	apY: number,
	maxDist: number,
	wallData: Uint8Array,
	wallW: number,
	wallH: number,
	materialMap: Uint8Array | null,
	materialDb: number[],
	defaultDb: number,
	gridStep = ATTEN_GRID_STEP,
	maskOriginX = 0,
	maskOriginY = 0
): AttenField {
	const fast = gridStep > ATTEN_GRID_STEP;
	const angles = fast ? POLAR_ANGLES_FAST : POLAR_ANGLES_FULL;
	const distStep = fast ? 6 : 3; // world units per distance bucket
	const distBuckets = Math.ceil(maxDist / distStep);
	const data = new Float32Array(angles * distBuckets);
	const edgeAtten = new Float32Array(angles);

	// AP in mask-local coords
	const apLX = apX - maskOriginX;
	const apLY = apY - maskOriginY;
	const angleStep = (2 * Math.PI) / angles;

	for (let a = 0; a < angles; a++) {
		const theta = a * angleStep;
		const cosT = Math.cos(theta);
		const sinT = Math.sin(theta);

		let cumDb = 0;
		let wasWall = false;
		const base = a * distBuckets;

		// Step pixel-by-pixel to never miss thin walls.
		// Store cumulative dB at bucket resolution for compact lookup.
		let nextBucket = 0;
		const totalPixels = Math.ceil(maxDist);
		for (let p = 0; p < totalPixels; p++) {
			const px = (apLX + cosT * p + 0.5) | 0;
			const py = (apLY + sinT * p + 0.5) | 0;

			if (px >= 0 && px < wallW && py >= 0 && py < wallH) {
				const idx = py * wallW + px;
				const isWall = wallData[idx] === 1;
				if (isWall && !wasWall) {
					if (materialMap) {
						const matId = materialMap[idx] ?? 0;
						cumDb += materialDb[matId] ?? defaultDb;
					} else {
						cumDb += defaultDb;
					}
				}
				wasWall = isWall;
			} else {
				wasWall = false;
			}

			// Write to bucket when we cross the boundary
			while (nextBucket < distBuckets && p >= (nextBucket + 0.5) * distStep) {
				data[base + nextBucket] = cumDb;
				nextBucket++;
			}
		}
		// Fill remaining buckets
		while (nextBucket < distBuckets) {
			data[base + nextBucket] = cumDb;
			nextBucket++;
		}
		edgeAtten[a] = cumDb;
	}

	/*
	 * A single-slice leak is not a shadow boundary: it is a hole.
	 *
	 * The march steps one pixel at a time along each 0.5° ray, so a one-pixel gap where two
	 * walls meet — or a wall pixel the line pass rounded away — lets exactly one slice through
	 * unattenuated. Interpolated between its two neighbours, that slice paints a thin bright
	 * spike out of a corner, which is what the picture showed. A median of three neighbouring
	 * angles removes a lone slice and leaves a real shadow, which is many slices wide, intact.
	 */
	const smoothed = new Float32Array(data.length);
	for (let a = 0; a < angles; a++) {
		const prev = (a + angles - 1) % angles;
		const next = (a + 1) % angles;
		const base = a * distBuckets;
		const basePrev = prev * distBuckets;
		const baseNext = next * distBuckets;
		for (let d = 0; d < distBuckets; d++) {
			const v0 = data[basePrev + d]!;
			const v1 = data[base + d]!;
			const v2 = data[baseNext + d]!;
			// Median of three: min(max(a,b), max(min(a,b), c)).
			const lo = v0 < v1 ? v0 : v1;
			const hi = v0 < v1 ? v1 : v0;
			smoothed[base + d] = v2 < lo ? lo : v2 > hi ? hi : v2;
		}
	}
	data.set(smoothed);

	return { data, angles, distBuckets, distStep, apX, apY, edgeAtten };
}

/**
 * O(1) polar attenuation lookup, bilinear over the angle and distance buckets.
 *
 * Snapping to the nearest bucket (the previous behaviour) looks right only near
 * the AP. A slice is 0.5° wide, so 10 m out it is 9 cm — a couple of pixels — and
 * because one slice can cross a wall while its neighbour misses it, a wall shadow
 * stops being a wedge and becomes a **thin dark spoke**: a two-to-three pixel
 * line of heavy attenuation radiating from the AP, with hard edges. Where that
 * spoke falls below the ramp floor it renders as an uncoloured dashed line
 * through the heat, which reads as a rendering fault rather than as a shadow.
 *
 * Interpolating between the two neighbouring slices — and between the two
 * distance buckets, which are `distStep` apart — restores a gradient across the
 * shadow boundary. Only the heatmap uses this lookup (the optimiser and the
 * reported coverage march their own rays), so this changes the picture and no
 * number.
 */
export function lookupAtten(field: AttenField, wx: number, wy: number): number {
	const dx = wx - field.apX;
	const dy = wy - field.apY;
	const dist = Math.sqrt(dx * dx + dy * dy);
	if (dist < 0.5) return 0;

	// Angle: atan2 → [0, 2π) → [0, angles), plus the fraction into that slice.
	let theta = Math.atan2(dy, dx);
	if (theta < 0) theta += 2 * Math.PI;
	const anglePos = (theta / (2 * Math.PI)) * field.angles;
	const a0 = Math.min(field.angles - 1, anglePos | 0);
	const a1 = (a0 + 1) % field.angles;
	const at = anglePos - a0;

	// Distance: bucket index plus the fraction into that bucket.
	const distPos = dist / field.distStep;
	const d0 = distPos | 0;
	if (d0 + 1 >= field.distBuckets) {
		return field.edgeAtten[a0]! * (1 - at) + field.edgeAtten[a1]! * at;
	}
	const dt = distPos - d0;
	const base0 = a0 * field.distBuckets + d0;
	const base1 = a1 * field.distBuckets + d0;
	const near = field.data[base0]! * (1 - dt) + field.data[base0 + 1]! * dt;
	const far = field.data[base1]! * (1 - dt) + field.data[base1 + 1]! * dt;
	return near * (1 - at) + far * at;
}

// ─── Attenuation field cache ──────────────────────────────────────

const attenCache = new Map<string, AttenField>();
let wallGeneration = 0;
let cachedGeneration = -1;

/** Maximum number of cached fields. Each is ~720 x distBuckets floats. */
const ATTEN_CACHE_MAX = 10;

/**
 * Call when wall/material data changes to invalidate cached fields.
 *
 * NOTE: this is a single global generation counter, so it clears fields for
 * every floor at once. In practice the renderer only ever builds fields from
 * the wall mask of the floor currently on screen, so the coarse scope mostly
 * costs a redundant rebuild after a wall edit rather than cross-floor churn.
 * Scoping per floor would need the caller to supply a floor key here and in
 * `getAttenField`.
 */
export function invalidateAttenCache(): void {
	wallGeneration++;
}

/**
 * Get or build a cached attenuation field for an AP.
 * `fast` mode: coarser grid (12px) + bigger quantization (12px) for drag responsiveness.
 * `full` mode: fine grid (6px) + small quantization (4px) for accuracy when placed.
 */
export function getAttenField(
	apX: number,
	apY: number,
	radius: number,
	wallData: Uint8Array,
	wallW: number,
	wallH: number,
	materialMap: Uint8Array | null,
	materialDb: number[],
	defaultDb: number,
	fast = false,
	maskOriginX = 0,
	maskOriginY = 0,
	/**
	 * Cache discriminator for everything the cache key does not already carry.
	 *
	 * The key is position and radius. Fields also depend on the material tables
	 * (which are per band) and on *which* mask was marched — and with the
	 * cross-floor ray split the same AP legitimately has two fields, one per floor.
	 * Without a tag the first one built was handed to every later caller, so an AP
	 * on 2.4 GHz could be attenuated with 5 GHz wall losses and a cross-floor AP
	 * could be given a field from the wrong plan.
	 */
	cacheTag = '',
	/**
	 * How far the field is marched, as a multiple of `radius`. Three by default.
	 *
	 * Marching is the cost of a field, and its length is linear in this factor. The
	 * heatmap only ever reads out to 1.5 radii, so marching to 3 doubled the cost of
	 * every regeneration — which is the entire cost of dragging an AP. Callers that
	 * read further out keep the default.
	 */
	maxDistFactor = 3
): AttenField {
	if (cachedGeneration !== wallGeneration) {
		attenCache.clear();
		cachedGeneration = wallGeneration;
	}

	const q = fast ? 12 : 4;
	const qx = (apX / q) | 0;
	const qy = (apY / q) | 0;
	const key = `${fast ? 'f' : 'a'}:${qx}:${qy}:${(radius / 4) | 0}:${maxDistFactor}:${cacheTag}`;

	const hit = attenCache.get(key);
	if (hit) {
		// Refresh recency. `Map` preserves insertion order, so without this the
		// eviction below is FIFO and a frequently reused field can be dropped
		// while a stale one survives.
		attenCache.delete(key);
		attenCache.set(key, hit);
		return hit;
	}

	const gridStep = fast ? 12 : ATTEN_GRID_STEP;
	const field = buildAttenField(
		apX,
		apY,
		radius * maxDistFactor,
		wallData,
		wallW,
		wallH,
		materialMap,
		materialDb,
		defaultDb,
		gridStep,
		maskOriginX,
		maskOriginY
	);
	attenCache.set(key, field);
	while (attenCache.size > ATTEN_CACHE_MAX) {
		const oldest = attenCache.keys().next().value!;
		attenCache.delete(oldest);
	}
	return field;
}

// ─── Range from TX power ──────────────────────────────────────────

/**
 * Reference path loss at 1 m (dB), by band.
 *
 * From the ITU-R P.1238 site-general form, `PL0 = 20·log10(f_MHz) − 28`:
 *
 *   2400 MHz -> 39.60    5000 MHz -> 45.98    5925 MHz -> 47.46
 *
 * All three now follow the formula. They previously read 40 / 47 / 49, which was
 * each band rounded up and 6 GHz rounded up twice — 1.4 dB above the formula,
 * making 6 GHz pessimistic relative to the other two for no stated reason.
 *
 * **This moves existing results.** 5 GHz is the default band and its reference
 * loss drops by 1 dB, so every 5 GHz level, range and coverage figure shifts
 * slightly more optimistic than before. That is the correction, not a side
 * effect, but it means numbers recorded before this commit are not comparable
 * with numbers after it. Reverting is this one table.
 */
const PL0: Record<string, number> = {
	'2.4ghz': 39.6,
	'5ghz': 46,
	'6ghz': 47.5
};

/**
 * Thermal noise density at 290 K: `k·T` in dBm per Hz, −173.98.
 *
 * The one **physical** number every level in this model is ultimately measured against.
 * Everything else is a requirement stated on top of it, which is what keeps the thresholds
 * from drifting apart: changing the receiver, the bandwidth or the design target moves an
 * *offset*, not a typed-in absolute dBm figure.
 */
const THERMAL_NOISE_DBM_PER_HZ = -173.98;

/**
 * Sensitivity at 20 MHz, which is the model's historical — and now derived — zero point.
 *
 * Held as the target rather than as a loose constant: the noise figure below is solved from
 * it, so this value is exact and every other width is exact to its 3 dB-per-doubling offset.
 * An integer noise figure would give −84.97 dBm and move recorded coverage radii in the
 * fourth significant figure for no reason.
 */
const SENSITIVITY_20MHZ_DBM = -85;

/**
 * Effective noise figure at 20 MHz, **solved** so the floor comes out at exactly −85 dBm:
 * 16.03 dB (the floor alone is −101.0 dBm).
 *
 * That is not a documented receiver's noise figure — a good client is 4–7 dB — and the
 * difference is the point of writing it down. This is a *system* figure: 6–7 dB of receiver
 * noise plus the ~9 dB implementation margin a real sensitivity spec carries over an ideal
 * `kTB + NF` calculation. Keeping the margin inside the figure is what lets the floor
 * become the anchor without retuning every recorded number; splitting it out is the honest
 * follow-up, and it would move the sensitivity to about −94 dBm and every coverage radius
 * with it. See `docs/PHYSICAL_MODELS.md` §A4.
 */
const NOISE_FIGURE_DB = SENSITIVITY_20MHZ_DBM - (THERMAL_NOISE_DBM_PER_HZ + 10 * Math.log10(20e6));

/**
 * Thermal noise floor at a channel width, in dBm: `k·T·B + NF`.
 *
 * Bandwidth-dependent, which is the point: an 80 MHz channel integrates four times the
 * noise of a 20 MHz one, so its floor is 6 dB higher and every threshold expressed as a
 * requirement above the floor moves with it.
 *
 *   20 MHz → −101.0 + 16 = −85.0 dBm   (= the sensitivity, see below)
 *   80 MHz → −95.0 + 16 = −79.0 dBm
 */
export function thermalNoiseFloorDbm(
	channelWidthMhz: number,
	noiseFigureDb = NOISE_FIGURE_DB
): number {
	const width = channelWidthMhz > 0 ? channelWidthMhz : 20;
	return THERMAL_NOISE_DBM_PER_HZ + 10 * Math.log10(width * 1e6) + noiseFigureDb;
}

/**
 * Receiver sensitivity threshold (dBm) at a channel width.
 *
 * Equal to the thermal floor at 20 MHz by construction of `NOISE_FIGURE_DB` — so this
 * model's sensitivity *is* its noise floor, which is a legitimate posture (the association
 * boundary is where a receiver stops hearing) and is now visible rather than being an
 * unexplained agreement between two typed-in constants.
 *
 * At a wider channel the floor rises, so the sensitivity gets worse: the physically right
 * direction, and the reason an 80 MHz radio associates over a shorter distance.
 */
export function sensitivityDbm(channelWidthMhz = 20, noiseFigureDb = NOISE_FIGURE_DB): number {
	return thermalNoiseFloorDbm(channelWidthMhz, noiseFigureDb);
}

/** Receiver sensitivity at 20 MHz, the width every recorded figure was taken at. */
const SENSITIVITY = sensitivityDbm(20);

/**
 * Indoor distance power loss coefficient, expressed as N = 10·n.
 *
 * n = 4.0 means N = 40, which is ITU-R P.1238-13's figure for paths "around
 * obstacles and through walls" in a closed-plan office building. The same
 * document gives N ≈ 20 for line-of-sight and large open rooms and N ≈ 18 for
 * corridors, so applying 4.0 everywhere over-attenuates open areas by up to
 * ~20 dB per decade of distance. See docs/PHYSICAL_MODELS.md §A3.
 *
 * Note also the standard's warning that N already contains an implicit
 * allowance for transmission through walls, which this project additionally
 * charges explicitly in the ray march. That is a known double-count.
 *
 * The earlier comment here claimed this was "consistent with the quartic signal
 * model used by the heatmap renderer". That model no longer exists: the heatmap
 * uses log-distance in the dB domain, the same formula as `pathLossDb`.
 */

/**
 * The environments ITU-R P.1238-13 tabulates a distance power loss coefficient for.
 *
 * `N` is not a tuning knob: each figure belongs to an environment, and — the part that
 * decides which one this project should use — the tabulated `N` already contains an
 * average allowance for transmission through walls and over obstacles. So the value has
 * to match what the *plan* already accounts for explicitly:
 *
 *   - Walls drawn in full (the ray march charges every crossing) -> `lineOfSight`. This
 *     is the self-consistent ray-tracing configuration: the distance
 *     term is spreading, and the geometry carries the obstacle loss.
 *   - Only the major walls drawn -> `office`.
 *   - Barely any walls drawn, so the coefficient has to stand in for them ->
 *     `closedPlan`.
 *
 * Choosing a high value *and* drawing every wall double-counts, because ITU-R P.1238-13
 * states that `N` "include[s] an implicit allowance for transmission through walls", and
 * that ray tracing "would have the option of explicitly accounting for the loss due to
 * each wall instead of including it in the distance model". Those are alternatives in the
 * standard, not complements. On this project's own numbers the double count is worth
 * 20 dB at 10 m and 26 dB at 20 m — see `docs/PHYSICAL_MODELS.md` §A3a.
 */
export type PathLossScenario = 'lineOfSight' | 'office' | 'closedPlan';

export interface PathLossScenarioInfo {
	/** `n` in `PL(d) = PL0 + 10·n·log10(d)`, i.e. the ITU `N` divided by ten. */
	n: number;
	/** The tabulated `N` itself, quoted so a reader can check the table. */
	ituN: number;
	/**
	 * True when the ITU figure already contains the wall allowance — the cases where
	 * charging the ray march as well double-counts.
	 */
	includesWallAllowance: boolean;
}

export const PATH_LOSS_SCENARIOS: Record<PathLossScenario, PathLossScenarioInfo> = {
	lineOfSight: { n: 2.0, ituN: 20, includesWallAllowance: false },
	office: { n: 3.0, ituN: 30, includesWallAllowance: true },
	closedPlan: { n: 4.0, ituN: 40, includesWallAllowance: true }
};

/**
 * The environment assumed when a project does not say.
 *
 * Deliberately the one every figure recorded before this setting existed was taken with:
 * a project that never touches the control keeps the model it was planned under.
 */
export const DEFAULT_PATH_LOSS_SCENARIO: PathLossScenario = 'closedPlan';

let currentScenario: PathLossScenario = DEFAULT_PATH_LOSS_SCENARIO;
let currentN: number = PATH_LOSS_SCENARIOS[DEFAULT_PATH_LOSS_SCENARIO].n;

/**
 * The environment every function in this module is currently modelling.
 *
 * Module scope rather than a parameter, because the coefficient is read inside the
 * propagation hot loops on both threads and threading it through every signature would
 * touch every caller for a value that changes once per project. Each realm has its own
 * copy: the app sets it when the project loads or the setting changes, and the optimiser
 * worker sets it from the run message before it evaluates anything.
 */
export function pathLossN(): number {
	return currentN;
}

/** The named environment behind `pathLossN()`. */
export function pathLossScenario(): PathLossScenario {
	return currentScenario;
}

/**
 * Select an environment. Callers that cache anything derived from it — AP radii, a
 * rendered field — must rebuild that cache; `setPathLossScenario` cannot reach it.
 */
export function setPathLossScenario(scenario: PathLossScenario): void {
	if (!(scenario in PATH_LOSS_SCENARIOS)) {
		throw new Error(`unknown path loss scenario: ${scenario}`);
	}
	currentScenario = scenario;
	currentN = PATH_LOSS_SCENARIOS[scenario].n;
}

/** Set `n` directly, for tests and the measurement harnesses. */
export function setPathLossN(n: number): void {
	if (!(n > 0)) throw new Error(`path loss coefficient must be positive, got ${n}`);
	currentN = n;
}

/**
 * The first Fresnel zone breakpoint, in metres.
 *
 * ITU-R P.1238-13, in the note under the coefficient table: "For long unobstructed paths,
 * the first Fresnel zone breakpoint may occur. At this distance, the distance power loss
 * coefficient may change from about 20 to about 40." The standard does not say where it is —
 * it depends on the ceiling, the frequency and the clutter — so this is the order indoor
 * measurements put it at for an ordinary ceiling, and it exists because leaving it out is
 * not a neutral choice: with a single n = 2 the distance term keeps spreading at the
 * line-of-sight rate for ever, and a 20 dBm 5 GHz AP then carries a **158 m** coverage
 * radius and a plan reads as one AP per floor. Beyond it the floor and ceiling reflections
 * that made the near field cheap stop helping, which is the 20 → 40 the note describes.
 */
const FRESNEL_BREAKPOINT_M = 10;

/** The coefficient beyond the breakpoint: through walls, closed plan (ITU N = 40). */
const FAR_FIELD_N = 4.0;

/**
 * Half-width of the transition, in decades of distance.
 *
 * A breakpoint applied as a step gives the curve a corner at the knee; ramping the
 * coefficient over ±0.2 decades (a factor of 1.6 either side) spreads it over a few metres,
 * which is also what the measurement looks like.
 */
const BREAKPOINT_BLEND_DECADES = 0.2;

const BREAKPOINT_LOG10 = Math.log10(FRESNEL_BREAKPOINT_M);

/**
 * The integral of the coefficient ramp, from 1 m out to `u = log10(d)`.
 *
 * The loss is `10 · ∫ n(x) dx` over log-distance, so a piecewise-linear `n` gives a
 * continuous, monotone loss with a continuous slope — the coefficient itself has a corner,
 * the curve a plan is scored on does not.
 */
function rampIntegral(u: number): number {
	const lo = BREAKPOINT_LOG10 - BREAKPOINT_BLEND_DECADES;
	const hi = BREAKPOINT_LOG10 + BREAKPOINT_BLEND_DECADES;
	if (u <= lo) return 0;
	if (u >= hi) return BREAKPOINT_BLEND_DECADES + (u - hi);
	const t = (u - lo) / (2 * BREAKPOINT_BLEND_DECADES);
	return t * t * BREAKPOINT_BLEND_DECADES;
}

/** `relativePathLossDb` at `u = log10(d)`, so the inverse can bisect on `u`. */
function relativeLossAtLog10(u: number): number {
	const n = pathLossN();
	if (n >= FAR_FIELD_N) return 10 * n * u;
	return 10 * (n * u + (FAR_FIELD_N - n) * rampIntegral(u));
}

/**
 * The distance at which the relative loss reaches `lossDb`, in metres.
 *
 * Bisection rather than a closed form: the loss is monotone in log-distance, and a
 * three-branch inverse is a place for a silent sign error to live. It runs per AP per
 * frame, not per sample — the per-sample path only ever *differences* the loss, which is
 * what `coverageMarginDb` does.
 */
function distanceForRelativeLoss(lossDb: number): number {
	if (!(lossDb > 0)) return 1;
	let lo = 0; // log10(1 m)
	let hi = 8; // log10(100 km): far past anything the model is asked about indoors
	for (let i = 0; i < 60; i++) {
		const mid = (lo + hi) / 2;
		if (relativeLossAtLog10(mid) < lossDb) lo = mid;
		else hi = mid;
	}
	return Math.pow(10, (lo + hi) / 2);
}

/**
 * Compute estimated indoor coverage range from TX power and band.
 * Uses log-distance path loss model: PL(d) = PL₀ + 10·n·log₁₀(d)
 * Returns range in meters.
 */
export function rangeFromPower(txPowerDbm: number, band: string): number {
	const pl0 = PL0[band] ?? 47;
	const budget = txPowerDbm - pl0 - SENSITIVITY; // link budget in dB
	return distanceForRelativeLoss(budget);
}


/**
 * Path loss in dB at a distance, using the same log-distance model as
 * `rangeFromPower`: PL(d) = PL₀ + 10·n·log₁₀(d).
 *
 * The heatmap colours cells by received LEVEL, so it needs this directly. Its
 * previous model, `signalPower = 1/(1+(d/r)^4)`, is normalised to the coverage
 * radius and is therefore almost perfectly flat near the AP: with r = 34 m the
 * level at 1 m and at 5 m differs by 0.002 dB, where the log-distance model
 * differs by 28 dB. That flatness is why a well-covered room rendered as a
 * single uniform colour with no visible intensity distribution.
 *
 * Distance is clamped to 1 m because the 1 m reference loss PL₀ is only valid
 * from there outwards.
 */
export function pathLossDb(band: string, distanceMeters: number): number {
	const pl0 = PL0[band] ?? 47;
	return pl0 + relativePathLossDb(distanceMeters);
}

/** Receiver sensitivity used by the range model, in dBm. */
export const RECEIVER_SENSITIVITY_DBM = SENSITIVITY;

/**
 * Received margin above the coverage threshold at a distance, in dB.
 *
 * `interferenceRadius` is not an arbitrary constant. `radiusFromPower` defines it
 * as the distance at which the free-space level equals the receiver sensitivity,
 *
 *   R = 10^((P − PL0 − SENSITIVITY) / 10n),
 *
 * so for a sample at distance d the level sits `10·n·log10(R/d)` dB above that
 * threshold. Walls and floor slabs only subtract from it, which the caller does.
 *
 * The useful consequence is that a sample is inside the AP's coverage circle
 * **exactly** when this margin is non-negative — the same boundary the heatmap
 * draws and the same circle the editor shows around an AP. The previous kernel
 * had no such correspondence.
 *
 * Returns +Infinity at zero distance and -Infinity for a degenerate radius.
 */
export function coverageMarginDb(distance: number, radius: number): number {
	if (radius <= 0) return -Infinity;
	if (distance <= 0) return Infinity;
	// The difference of two relative losses, so the margin is still exactly zero at the
	// coverage radius whatever the coefficient does with distance.
	return relativePathLossDb(radius) - relativePathLossDb(distance);
}

/**
 * Signal level at which a client is considered **covered**, in dBm.
 *
 * This is deliberately NOT `SENSITIVITY` (−85 dBm). That figure is the level at
 * which a receiver can barely associate; a client sitting on it has essentially
 * no throughput. Using it as the coverage boundary produced a 42 m coverage
 * radius for a single 20 dBm 2.4 GHz AP, which made almost any floor plan read
 * as ~98% covered and left the placement optimiser nothing to optimise.
 *
 * −70 dBm is a conventional indoor design threshold for data coverage (voice
 * design is stricter still, around −67 dBm). At this threshold a 20 dBm AP
 * reaches about 17.7 m at 2.4 GHz and 11.8 m at 5 GHz, which is the right order
 * for indoor planning.
 *
 * The two radii stay distinct on purpose:
 *   - `interferenceRadius` (from `rangeFromPower`) is the ASSOCIATION range and
 *     remains the right input for the interference graph, because radios
 *     interfere wherever they can hear each other at all.
 *   - `coverageReach` is the COVERAGE range, and is what the reported coverage
 *     percentage and the optimiser's objective are measured against.
 */
export const COVERAGE_THRESHOLD_DBM = -70;

/**
 * How far above `SENSITIVITY` the coverage threshold sits, in dB. A sample is
 * covered when its received margin (see `coverageMarginDb`) reaches this.
 */
export const COVERAGE_MARGIN_DB = COVERAGE_THRESHOLD_DBM - SENSITIVITY;

/**
 * How far above the **thermal floor** the coverage threshold sits, in dB: **15 dB**.
 *
 * This is the model's real design statement, and stating it as an SNR is what makes it
 * checkable. 15 dB above a −85 dBm floor is a mid-table MCS requirement — comfortably
 * enough for multi-stream high-order modulation, short of the top of the table — which is
 * a sensible place to put a *coverage* boundary that is meant to mean "usable data
 * service" rather than "can associate".
 *
 * It is also the number that should survive if the noise figure is ever split into receiver
 * noise plus implementation margin: the 15 dB is a design target, while the two figures
 * under it are not.
 */
export const COVERAGE_SNR_DB = COVERAGE_THRESHOLD_DBM - thermalNoiseFloorDbm(20);

/**
 * The clear-channel-assessment preamble-detect threshold at a channel width, in dBm.
 *
 * **Quoted from the standard, not derived from the floor**, and the distinction matters:
 * CCA is a regulatory receiver requirement (−82 dBm at 20 MHz, +3 dB per doubling of width
 * because the preamble detect integrates over more subcarriers), whereas a sensitivity is a
 * link-closing requirement. Deriving CCA from the floor would give −85 dBm here — close
 * enough to look right and wrong in a way that would be blamed on something else.
 *
 * What the anchor *does* buy is the ability to say where it sits: at 20 MHz it is
 * `-COVERAGE_SNR_DB` = 12 dB *below* the coverage threshold, so this model treats a
 * co-channel signal as deferrable well before it stops being usable — which is the whole
 * reason both criteria exist. See `docs/PHYSICAL_MODELS.md` §E3.
 */
export function ccaThresholdDbm(channelWidthMhz: number): number {
	const width = channelWidthMhz > 0 ? channelWidthMhz : 20;
	// −82 dBm at 20 MHz, +3 dB per doubling, never below the standard's own figure.
	const doublings = Math.max(0, Math.log2(width / 20));
	return -82 + 3 * doublings;
}

/**
 * Margin in dB at which a sample counts as fully covered. Ten dB above the
 * coverage threshold is a defensible "strong signal" line, and it keeps a real
 * gradient across the cell instead of collapsing to a covered/not-covered step.
 */
export const OPTIMIZER_FULL_MARGIN_DB = 10;

/**
 * How far below the coverage threshold a sample still earns a little utility.
 *
 * This is the F2 fix, and it is measured rather than assumed: with a hard
 * threshold, a sample one metre outside the coverage circle and a sample fifteen
 * metres outside both contribute exactly 0, so the objective cannot see the
 * difference. On a coverage-limited floor that cost real coverage — eight restarts
 * reached 66.5% to 71.8% coverage while their objective differed by 0.9% — because
 * every uncovered sample is a plateau, and the plateau is most of a
 * coverage-limited plan.
 *
 * With a softness of `S`, the utility ramps linearly from 0 at `S` dB below the
 * threshold to 1 at {@link OPTIMIZER_FULL_MARGIN_DB} above it. `S = 0` is the old
 * hard threshold exactly, which is what makes the A/B possible.
 *
 * 10 dB is chosen to match `COCHANNEL_REUSE_DB`: the shell around an AP in which a
 * co-channel neighbour still counts as interference is then the same shell in
 * which a sample still counts as worth placing for. The cost is that the reported
 * *score* is no longer comparable to the hard-threshold one (a sample sitting on
 * the threshold scores 0.5 instead of 0), which is why the recorded measurements
 * are compared within one softness value, on coverage and on spread.
 */
export const DEFAULT_COVERAGE_SOFTNESS_DB = 10;

/**
 * Distance from a source beyond which nothing can be covered, allowing for a
 * fixed extra loss. Used to skip work: losses only shrink the margin, so any
 * sample past this is known to be uncovered before the ray is marched.
 */
export function coverageReach(radius: number, lossDb = 0): number {
	if (radius <= 0) return 0;
	return distanceForRelativeLoss(relativePathLossDb(radius) - COVERAGE_MARGIN_DB - lossDb);
}


/**
 * Horizontal distance at which a source's margin falls to `marginDb` above the
 * coverage threshold.
 *
 * `coverageReach` answers this in 3D at 0 dB. A source on another floor has
 * already spent part of that budget travelling vertically, so its horizontal reach
 * is shorter by exactly that much. Without this the cross-floor cutoff would let
 * through samples whose 3D distance is past the reach, which the margin check
 * then rejects anyway — the work is simply wasted.
 *
 * A *negative* `marginDb` reaches further, which is what a softened objective
 * needs: a sample `S` dB below the threshold still earns a little utility, so it
 * has to be marched for even though it is not covered.
 */
export function coverageHorizontalReach(
	radius: number,
	lossDb = 0,
	verticalGap = 0,
	marginDb = 0
): number {
	const reach = reachAtMargin(radius, lossDb, marginDb);
	if (verticalGap <= 0) return reach;
	return Math.sqrt(Math.max(0, reach * reach - verticalGap * verticalGap));
}

/**
 * Distance at which a source's margin falls to `marginDb` dB above the coverage
 * threshold. `coverageReach` is this at 0 dB; a *negative* `marginDb` reaches
 * further, which is what the interference model needs.
 *
 * A co-channel secondary server keeps degrading the best server while it is
 * within `COCHANNEL_REUSE_DB` of it (10 dB) — and that is *below* the coverage
 * threshold: a sample whose best server sits 2 dB over the threshold can still be
 * spoiled by a second server 6 dB down. So the coverage pass's reach test cannot
 * decide which sources have to be marched for interference;
 * `reachAtMargin(radius, loss, -COCHANNEL_REUSE_DB)` is the bound that can.
 */
export function reachAtMargin(radius: number, lossDb = 0, marginDb = 0): number {
	if (radius <= 0) return 0;
	return distanceForRelativeLoss(
		relativePathLossDb(radius) - COVERAGE_MARGIN_DB - marginDb - lossDb
	);
}

/**
 * Distance at which an AP's free-space level falls to `floorDbm`, in metres.
 *
 * `referenceDbm` is that AP's level at 1 m, i.e. `P_tx − PL0` (see `pathLossDb`).
 * This inverts the same log-distance model the heatmap colours with, so it
 * answers "how far from this AP can any colour still appear" for an arbitrary
 * ramp floor.
 *
 * `coverageReach` deliberately cannot be used for that: it is pinned to
 * `COVERAGE_THRESHOLD_DBM`, while the heatmap's floor is the user's
 * `heatmapRssiFloor` and can sit anywhere between −95 and −55 dBm. Sizing the
 * heatmap's image from the ASSOCIATION radius instead (1.5 × ~30 m at 5 GHz)
 * asked for an image several times larger than any texel can be coloured in,
 * which pushed the cell budget into widening the texel and made the whole map
 * render as flat colour patches. See `heatmap-region.ts`.
 *
 * Walls and slabs only ever subtract from the level, so the area that can show
 * colour is always inside this distance.
 */
export function reachAtLevel(referenceDbm: number, floorDbm: number): number {
	const headroomDb = referenceDbm - floorDbm;
	if (!(headroomDb > 0)) return 0;
	return distanceForRelativeLoss(headroomDb);
}

/**
 * Map a received margin **above sensitivity** to a [0, 1] utility for the
 * placement optimiser.
 *
 * `coverageMarginDb` returns the margin over the association floor, so the
 * coverage threshold is subtracted here rather than at every call site. Linear
 * in dB on purpose: the optimiser, the reported coverage percentage and the
 * heatmap then all measure the same quantity, so a plan the optimiser likes is a
 * plan the heatmap shows as covered.
 */
export function coverageUtility(marginAboveSensitivityDb: number, softnessDb = 0): number {
	return coverageUtilityAboveThreshold(marginAboveSensitivityDb - COVERAGE_MARGIN_DB, softnessDb);
}

/**
 * Utility for a margin already expressed above the coverage threshold.
 *
 * `softnessDb` widens the transition below the threshold so that an uncovered
 * sample still says *how far* outside it is — see
 * {@link DEFAULT_COVERAGE_SOFTNESS_DB}. Zero keeps the hard threshold, which is
 * the behaviour every measurement before 2026-09-23 was taken with.
 *
 * Note what this deliberately does **not** change: whether a sample counts as
 * covered. That is `margin > 0`, and the reported coverage percentage is a share
 * of samples, not a sum of utilities. The optimiser's landscape is the only thing
 * that moves.
 */
export function coverageUtilityAboveThreshold(marginDb: number, softnessDb = 0): number {
	if (softnessDb > 0) {
		const value = (marginDb + softnessDb) / (OPTIMIZER_FULL_MARGIN_DB + softnessDb);
		if (value <= 0) return 0;
		return value >= 1 ? 1 : value;
	}
	if (!(marginDb > 0)) return 0;
	if (marginDb >= OPTIMIZER_FULL_MARGIN_DB) return 1;
	return marginDb / OPTIMIZER_FULL_MARGIN_DB;
}

/**
 * Floor-slab loss in dB, recovered from the linear power factor (`10^(-db/10)`)
 * that the state layer hands to the workers for APs on other floors.
 *
 * Recovering the dB value lets cross-floor contributions be subtracted from the
 * coverage margin like any other loss, instead of being multiplied into a
 * separate linear scale, so one kernel handles both.
 */
export function slabDbOf(signalScale: number): number {
	return signalScale > 0 ? -10 * Math.log10(signalScale) : Infinity;
}

/**
 * Path loss in excess of the 1 m reference, in dB.
 *
 * This is the quantity a coverage ramp wants. Using the full `pathLossDb`
 * instead would fold in PL₀ (47 dB at 5 GHz), so a 60 dB colour window would
 * only span about 2 m because the first metre alone already "costs" 47 dB.
 * Referenced this way, 0 dB is the level at 1 m from the AP.
 *
 * With a single coefficient this is `10·n·log10(d)`; from the Fresnel breakpoint on it is
 * the integral of a coefficient that ramps from the environment's value to `FAR_FIELD_N`,
 * which is the 20 → 40 the standard's note describes. Distance is clamped to 1 m because
 * the 1 m reference is only valid from there outwards.
 */
export function relativePathLossDb(distanceMeters: number): number {
	const d = distanceMeters > 1 ? distanceMeters : 1;
	return relativeLossAtLog10(Math.log10(d));
}
