/**
 * Wall material definitions for RF attenuation modeling.
 * Values based on IEEE 802.11 propagation studies and ITU-R P.1238.
 */

import type { Band } from '@aetherax/channels';

export type WallMaterialId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface WallMaterial {
	id: WallMaterialId;
	name: string;
	dbPerMeter: Record<Band, number>; // dB per meter of material thickness, per band
	typicalThickness: number; // meters — used when calibration unavailable
	color: [number, number, number];
}

/**
 * Wall material definitions with per-metre, per-band attenuation.
 * Effective dB = dbPerMeter[band] * thickness (from a calibrated ray march,
 * i.e. the pixel run length) or * typicalThickness when uncalibrated.
 *
 * The 5 GHz column is the original anchor. 2.4 GHz is scaled by 1/1.9 and
 * 6 GHz by 1.2. The ~1.9x ratio between the 2.4 and 5 GHz transmission loss of
 * building materials is the figure reported by the iBwave material database
 * this table was originally sourced from (e.g. lime brick 4.30 dB @2.4 GHz vs
 * 7.80 dB @5 GHz, dry wall partition 5.39 vs 10.11, heavy concrete 22.79 vs
 * 44.77). Scaling the anchor preserves the measured cross-band ratios without
 * inventing new materials.
 *
 * Sanity check against those measurements: brick 18 dB/m * 0.23 m = 4.14 dB at
 * 2.4 GHz vs 4.30 dB measured.
 *
 * Sources: ITU-R P.1238-12, IEEE 802.11, iBwave material database.
 */
export const WALL_MATERIALS: readonly WallMaterial[] = [
	{
		id: 0,
		name: 'Drywall',
		dbPerMeter: { '2.4ghz': 13, '5ghz': 25, '6ghz': 30 },
		typicalThickness: 0.12,
		color: [200, 200, 210]
	},
	{
		id: 1,
		name: 'Wood',
		dbPerMeter: { '2.4ghz': 17, '5ghz': 33, '6ghz': 40 },
		typicalThickness: 0.15,
		color: [160, 130, 90]
	},
	{
		id: 2,
		name: 'Glass',
		dbPerMeter: { '2.4ghz': 105, '5ghz': 200, '6ghz': 240 },
		typicalThickness: 0.01,
		color: [140, 210, 230]
	},
	{
		id: 3,
		name: 'Brick',
		dbPerMeter: { '2.4ghz': 18, '5ghz': 35, '6ghz': 42 },
		typicalThickness: 0.23,
		color: [180, 80, 60]
	},
	{
		id: 4,
		name: 'Concrete',
		dbPerMeter: { '2.4ghz': 32, '5ghz': 60, '6ghz': 72 },
		typicalThickness: 0.2,
		color: [130, 130, 140]
	},
	{
		id: 5,
		name: 'Metal',
		dbPerMeter: { '2.4ghz': 63, '5ghz': 120, '6ghz': 144 },
		typicalThickness: 0.17,
		color: [90, 100, 120]
	},
	{
		/**
		 * Zero-attenuation partition.
		 *
		 * It lives in the wall mask so it divides space — `computeBuildingInterior`
		 * sees it as a wall, so rooms, labels and density regions stop at it — but
		 * every per-metre figure is zero, so no RF path loses anything crossing it.
		 * That is the whole point: an open-plan boundary you want for room
		 * detection without inventing attenuation that does not exist.
		 *
		 * This only holds if the loss path consults the material map. Any consumer
		 * still counting raw wall crossings would treat this as a real wall.
		 */
		id: 6,
		name: 'Virtual Partition',
		dbPerMeter: { '2.4ghz': 0, '5ghz': 0, '6ghz': 0 },
		typicalThickness: 0.12,
		color: [120, 200, 180]
	},
	{
		/**
		 * A closed timber door leaf.
		 *
		 * It exists as its own material because a door is not a wall and the two were
		 * the same thing until the vector detector learned to tell them apart: every
		 * door in a detected plan was charged drywall's figure and, worse, nothing
		 * could express the case the RF model actually cares about — a doorway that is
		 * **open**. That case is `Virtual Partition` (0 dB), and a door that is merely
		 * a hole in the wall is the wrong model for a plan being surveyed, because the
		 * door is usually shut as often as not.
		 *
		 * 5 GHz anchor 110 dB/m at a 45 mm leaf: **4.95 dB per crossing**, the middle
		 * of the 3–6 dB range indoor planning uses for a closed wooden door. The other
		 * two columns follow this table's own convention (2.4 GHz = anchor/1.9,
		 * 6 GHz = anchor x 1.2), so the cross-band ratios match every other row.
		 *
		 * It is an engineering choice, not a measurement: `docs/PHYSICAL_MODELS.md`
		 * records it as such, alongside the door detection that writes it.
		 */
		id: 7,
		name: 'Door',
		dbPerMeter: { '2.4ghz': 58, '5ghz': 110, '6ghz': 132 },
		typicalThickness: 0.045,
		color: [205, 160, 115]
	}
] as const;

export const DEFAULT_MATERIAL: WallMaterialId = 0;

/**
 * Materials that actually attenuate RF.
 *
 * Excludes zero-attenuation partitions, so a picker that sets the DEFAULT
 * material cannot accidentally make every unpainted wall transparent.
 */
export const ATTENUATING_MATERIAL_IDS: readonly WallMaterialId[] = WALL_MATERIALS.filter((m) =>
	Object.values(m.dbPerMeter).some((db) => db > 0)
).map((m) => m.id);

/** True for partitions that divide space but absorb nothing. */
export function isVirtualMaterial(id: WallMaterialId): boolean {
	const m = WALL_MATERIALS[id];
	return m != null && Object.values(m.dbPerMeter).every((db) => db === 0);
}

/** Default band used wherever a call site has no per-AP band available. */
export const DEFAULT_BAND: Band = '5ghz';

/**
 * Materials the user added, in the shape this module's lookups already speak.
 *
 * A registry rather than a parameter on every function: the table is consulted from the
 * renderer, the solver, the optimiser's main thread and the worker, and threading a list
 * through all four is how one of them ends up not knowing about the user's material and
 * charging the built-in fallback instead. Whoever owns the project's materials registers
 * them once — on mount and whenever they change — and every lookup here sees them.
 *
 * Nothing persists here; the list lives in the project (`projectMeta.customMaterials`) and
 * is handed over in the worker's payload, so the two realms agree.
 */
let customMaterials: WallMaterial[] = [];

export function registerCustomMaterials(materials: readonly WallMaterial[]): void {
	customMaterials = [...materials];
}

/** Built-ins plus the registry, which is what every lookup and picker should use. */
export function wallMaterialTable(): WallMaterial[] {
	return customMaterials.length === 0
		? [...(WALL_MATERIALS as readonly WallMaterial[])]
		: [...(WALL_MATERIALS as readonly WallMaterial[]), ...customMaterials];
}

export function getMaterial(id: WallMaterialId): WallMaterial {
	const found = wallMaterialTable().find((material) => material.id === id);
	return found ?? WALL_MATERIALS[0]!;
}

/** Flat dB for one typical crossing at the given band: dbPerMeter * typicalThickness. */
export function getFlatAttenuation(id: WallMaterialId, band: Band = DEFAULT_BAND): number {
	const m = WALL_MATERIALS[id] ?? customMaterials.find((material) => material.id === id);
	return m ? m.dbPerMeter[band] * m.typicalThickness : 3;
}

/**
 * Per-band lookup table indexed by material id: **the figure for one crossing of that
 * material**, `dbPerMeter(band) × typicalThickness`.
 *
 * This is what the wall march and the heatmap's field both charge, one per crossing. It is the
 * table's own measured figure — the per-metre column in `WALL_MATERIALS` multiplied by the
 * material's typical construction thickness — and deliberately not anything measured off the
 * drawing: a material mask is painted with a brush, and a drawn band width is a drawing
 * convention. See the march's doc comment in `rf/propagation.ts` for the measurements.
 */
export function getMaterialDbTable(band: Band = DEFAULT_BAND): number[] {
	const table = wallMaterialTable();
	const out: number[] = [];
	// Indexed by id, so a custom material's row lands where a painted mask pixel points.
	// An id nothing answers for costs what a plain drywall wall costs, not zero: a deleted
	// material must not make the walls painted with it transparent.
	const fallback = WALL_MATERIALS[0]!.dbPerMeter[band] * WALL_MATERIALS[0]!.typicalThickness;
	for (const material of table) {
		if (material.id >= 0 && material.id < 256) {
			out[material.id] = material.dbPerMeter[band] * material.typicalThickness;
		}
	}
	for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = fallback;
	return out;
}

export function getMaterialByName(name: string): WallMaterial | undefined {
	return WALL_MATERIALS.find((m) => m.name.toLowerCase() === name.toLowerCase());
}
