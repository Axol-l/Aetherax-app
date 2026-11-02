/**
 * Setting a floor's scale, and keeping its access points the physical size they were.
 *
 * Calibration is per floor now: one building can hold plans scanned at different
 * resolutions, and the project-wide setter it replaced made calibrating the second storey
 * overwrite the first. The scale itself is one field on the floor; the second half of the
 * job is the AP radii, which are stored in world units and would otherwise silently change
 * their real-world reach when the floor's units change.
 */
import { apState, DEFAULT_WUPM, wupmForFloor } from './ap-state.svelte.js';
import { getFloor } from './floor-state.svelte.js';
import { scheduleSave } from './persistence.svelte.js';

/** The radius an uncalibrated AP is drawn with, in world units (15 m at `DEFAULT_WUPM`). */
function uncalibratedRadius(): number {
	return Math.round(15 * DEFAULT_WUPM);
}

/**
 * The factor that converts a length from `fromFloorId`'s world units into `toFloorId`'s.
 *
 * A point at `x` on a floor calibrated at 40 units/m is `x / 40` metres from that floor's
 * origin; drawn in a frame calibrated at 20 units/m it is `(x / 40) * 20 = x * 0.5`. Every
 * place that combines two floors — the cross-floor optimiser paths, the channel solver and
 * the overview cards — needs this one number, and they must all compute it the same way.
 */
export function scaleBetween(fromFloorId: string, toFloorId: string): number {
	const to = wupmForFloor(toFloorId);
	const from = wupmForFloor(fromFloorId);
	return from > 0 ? to / from : 1;
}

/**
 * Resample a mask from one floor's units into another's.
 *
 * Masks are one byte per world unit, so a mask cannot simply be handed across floors when
 * the scales differ: the ray that indexes it would measure a wall in the wrong units. The
 * nearest-neighbour resample is the same convention the rest of the mask code uses (a pixel
 * is a world unit, and there is no interpolation between wall and floor).
 */
export function resampleRaster(
	data: Uint8Array,
	width: number,
	height: number,
	scale: number
): { data: Uint8Array; width: number; height: number } {
	if (Math.abs(scale - 1) < 1e-6) return { data, width, height };
	const w = Math.max(1, Math.round(width * scale));
	const h = Math.max(1, Math.round(height * scale));
	const out = new Uint8Array(w * h);
	for (let y = 0; y < h; y++) {
		const sy = Math.min(height - 1, Math.max(0, Math.floor(y / scale)));
		const row = sy * width;
		const outRow = y * w;
		for (let x = 0; x < w; x++) {
			const sx = Math.min(width - 1, Math.max(0, Math.floor(x / scale)));
			out[outRow + x] = data[row + sx]!;
		}
	}
	return { data: out, width: w, height: h };
}

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
			// Read at call time: this module can be evaluated inside a cycle (persistence
			// imports the optimiser), where `DEFAULT_WUPM` is not initialised yet — a
			// module-level constant became NaN and the placeholder was never promoted.
			if (ap.interferenceRadius === uncalibratedRadius()) {
				ap.interferenceRadius = Math.round(15 * worldUnitsPerMeter);
			}
		} else {
			ap.interferenceRadius = Math.round(ap.interferenceRadius * (worldUnitsPerMeter / old));
		}
	}

	scheduleSave();
}
