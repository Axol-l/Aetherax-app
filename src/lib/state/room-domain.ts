/**
 * What counts as a room, for everyone who has to agree about it.
 *
 * The optimiser's placement domain, the coverage sample set, the "is this point inside?"
 * guard behind a click, and the worker's own verifier all reduce to one question: which
 * enclosed regions is an access point allowed in? They used to answer it with "everything
 * the flood fill could not reach from the border", which is not rooms — it is rooms *plus*
 * every cavity and drawing gap a plan happens to enclose. A user reported the result as
 * "the optimiser put my AP outside the room again": the point was in a 0.6 m² pocket
 * between two drawn lines, 3 cm from a wall, and every check in the app agreed it was
 * inside.
 *
 * So the threshold lives here, in metres, and each side converts it with its own scale —
 * mask pixels are world units, and the worker is told the calibration in its payload.
 * They must not each invent one: a domain here that the worker does not share is exactly
 * the disagreement `ap-interior.ts` exists to prevent.
 */
import { getEffectiveWupm, wupmForFloor } from './ap-state.svelte.js';

/**
 * Smallest inscribed radius a region may have and still count as a room, in metres.
 *
 * 0.3 m keeps a 0.6 m-wide space: narrower than that is a gap between lines rather than
 * somewhere a person stands, and an access point there reaches almost nothing. The
 * narrowest real space in the plan that prompted this was a 1.2 m corridor (0.6 m
 * radius), so the margin below it is a factor of two; the cavity that caused the report
 * measured 0.06 m.
 */
export const MIN_ROOM_RADIUS_M = 0.3;

/**
 * The same threshold in mask pixels, for a floor's calibration.
 *
 * Pass the floor whose mask is being built: the threshold is in metres, and a mask's pixels
 * are that floor's world units. Using the *selected* floor's scale while building another
 * floor's domain made a room on a differently-calibrated storey count as several rooms — or
 * as none.
 */
export function minRoomRadiusWu(floorId?: string): number {
	return MIN_ROOM_RADIUS_M * (floorId ? wupmForFloor(floorId) : getEffectiveWupm());
}
