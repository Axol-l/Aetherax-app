/**
 * Setting a floor's scale, and keeping its access points the physical size they were.
 *
 * Calibration is per floor now: one building can hold plans scanned at different
 * resolutions, and the project-wide setter it replaced made calibrating the second storey
 * overwrite the first. The scale itself is one field on the floor; the second half of the
 * job is the AP radii, which are stored in world units and would otherwise silently change
 * their real-world reach when the floor's units change.
 */
import { apState, DEFAULT_WUPM } from './ap-state.svelte.js';
import { getFloor } from './floor-state.svelte.js';
import { scheduleSave } from './persistence.svelte.js';

/** The radius an uncalibrated AP is drawn with, in world units (15 m at `DEFAULT_WUPM`). */
const UNCALIBRATED_RADIUS = Math.round(15 * DEFAULT_WUPM);

/**
 * Set one floor's scale and rescale that floor's AP radii to preserve their metres.
 *
 * Only APs on this floor are touched: a floor's units are its own, and scaling a unit on a
 * storey whose scale did not change would change its real reach. The first calibration of a
 * floor also promotes the uncalibrated placeholder radius to a real 15 m, which is the
 * number the editor shows before the plan says what a metre is.
 */
export function setFloorScale(floorId: string, worldUnitsPerMeter: number): void {
	if (!Number.isFinite(worldUnitsPerMeter) || worldUnitsPerMeter <= 0) return;
	const floor = getFloor(floorId);
	if (!floor) return;
	const old = floor.calibration?.worldUnitsPerMeter ?? null;
	floor.calibration = { worldUnitsPerMeter };

	for (const ap of apState.aps) {
		if (ap.floorId !== floorId) continue;
		if (old === null) {
			if (ap.interferenceRadius === UNCALIBRATED_RADIUS) {
				ap.interferenceRadius = Math.round(15 * worldUnitsPerMeter);
			}
		} else {
			ap.interferenceRadius = Math.round(ap.interferenceRadius * (worldUnitsPerMeter / old));
		}
	}

	scheduleSave();
}
