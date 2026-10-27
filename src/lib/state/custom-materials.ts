/**
 * User-defined wall materials.
 *
 * The built-in table covers what a plan usually contains, but a survey is often about the
 * one thing the table does not have: a lead-lined door, a warehouse shelf, a glazed screen
 * whose datasheet somebody actually read. Ekahau lets you add materials for exactly this
 * reason, and so does this.
 *
 * The stored quantity is **dB per crossing plus a thickness**, because that is what a
 * datasheet states and what the user can check. The model charges per metre, so
 * `dbPerMeter = dbPerCrossing / thickness` — deriving instead of asking for both keeps the
 * two numbers from disagreeing, and a wall of that material costs exactly the figure the
 * user typed.
 */
import { WALL_MATERIALS, type WallMaterial, type WallMaterialId } from '$canvas/materials.js';

export interface CustomMaterial {
	/** Ids from 100 up, so they never collide with the built-in table. */
	id: number;
	name: string;
	/** Loss for one crossing at `thicknessM`, in dB — the number a datasheet gives. */
	dbPerCrossing: number;
	thicknessM: number;
	color: [number, number, number];
}

export const CUSTOM_MATERIAL_ID_BASE = 100;

/** The colours a new material cycles through, so two customs are told apart at a glance. */
const CUSTOM_COLORS: ReadonlyArray<[number, number, number]> = [
	[214, 122, 74],
	[122, 168, 214],
	[168, 122, 214],
	[122, 214, 150],
	[214, 196, 96],
	[196, 96, 150],
	[96, 196, 196],
	[150, 150, 160]
];

/** The next free id, given what is already taken. */
export function nextCustomMaterialId(existing: readonly CustomMaterial[]): number {
	let id = CUSTOM_MATERIAL_ID_BASE;
	const taken = new Set(existing.map((material) => material.id));
	while (taken.has(id)) id++;
	return id;
}

/**
 * The built-in table plus the user's, in the shape the rest of the app expects.
 *
 * One flat list, so a picker, a swatch and the physics table all see the same set — the
 * alternative, threading a "customs" argument through every caller, is how one of them ends
 * up not knowing about them.
 */
export function allWallMaterials(custom: readonly CustomMaterial[]): WallMaterial[] {
	const builtIns = WALL_MATERIALS as readonly WallMaterial[];
	if (custom.length === 0) return [...builtIns];
	return [
		...builtIns,
		...custom.map(
			(material): WallMaterial => ({
				id: material.id as WallMaterialId,
				name: material.name,
				dbPerMeter: {
					'2.4ghz': material.dbPerCrossing / Math.max(0.01, material.thicknessM),
					'5ghz': material.dbPerCrossing / Math.max(0.01, material.thicknessM),
					'6ghz': material.dbPerCrossing / Math.max(0.01, material.thicknessM)
				},
				typicalThickness: material.thicknessM,
				color: material.color
			})
		)
	];
}

/** One lookup for "what is this id", built-ins first. */
export function wallMaterialById(
	id: number,
	custom: readonly CustomMaterial[]
): WallMaterial | null {
	return allWallMaterials(custom).find((material) => material.id === id) ?? null;
}
