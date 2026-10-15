/**
 * The four state atoms, and the access-point mutators, re-exported under one name.
 *
 * There is deliberately **no `projectState` here any more**. It used to be a
 * hand-written mirror of the atoms — a getter and a setter per field — and a mirror is
 * a thing that goes stale: adding a field to an atom and forgetting its pair left
 * callers reading `undefined` with no compile error, and every refactor had to chase
 * both spellings of the same state. Import the atom you need instead:
 *
 *   apState        — access points, band, channel width, regulatory domain
 *   floorplanState — underlay, calibration, units
 *   wallState      — wall mask, materials, room types
 *   projectMeta    — name, ISP speed, target throughput, optimiser settings
 *
 * This module stays as a re-export while the last importers migrate, so a file that
 * only wants `addAp` or the `AccessPoint` type does not have to know which atom owns
 * them.
 */

// Re-export atoms
export { apState } from './ap-state.svelte.js';
export { floorplanState } from './floorplan-state.svelte.js';
export { wallState } from './wall-state.svelte.js';
export { projectMeta } from './project-meta.svelte.js';

// Re-export types and functions
export type { AccessPoint } from './ap-state.svelte.js';
export {
	addAp,
	removeAp,
	removeAps,
	updateAp,
	moveAp,
	faceAp,
	beginMove,
	clearAssignments,
	resetApNumbering,
	getEffectiveWupm,
	radiusFromPower,
	DEFAULT_WUPM
} from './ap-state.svelte.js';
