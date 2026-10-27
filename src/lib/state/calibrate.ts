/**
 * Calibrating from a measured line instead of a stated area.
 *
 * The area route asks "what is the total area of this floorplan?" and divides it into the
 * boundary the detector found — which is only as trustworthy as the boundary, and says
 * nothing about whether the drawing is square. Measuring a line asks something the user
 * can answer from the plan itself: this wall is 12 m long. It is also the only route that
 * works when the outline is not closed or the drawing is a detail of one room.
 *
 * Mask pixels are world units, so the length of the segment in world coordinates *is* a
 * pixel count; the calibration is simply that count divided by the real length.
 */

/** The two ends of a measured segment, in world coordinates. */
export interface CalibrationSegment {
	a: { x: number; y: number };
	b: { x: number; y: number };
}

/** Length of the segment in world units (mask pixels), or 0 if it is degenerate. */
export function segmentLengthWorld(segment: CalibrationSegment): number {
	const dx = segment.b.x - segment.a.x;
	const dy = segment.b.y - segment.a.y;
	return Math.hypot(dx, dy);
}

/**
 * World units per metre implied by a measured segment.
 *
 * Null rather than Infinity for a usable-looking input, because both degenerate cases are
 * things the caller has to say out loud: a segment of no length carries no scale, and a
 * real length of zero would divide by it.
 */
export function wupmFromSegment(segment: CalibrationSegment, realMetres: number): number | null {
	if (!Number.isFinite(realMetres) || realMetres <= 0) return null;
	const world = segmentLengthWorld(segment);
	if (!Number.isFinite(world) || world < 1) return null;
	return world / realMetres;
}

/**
 * The real length a segment implies at a given scale, for showing the user what they drew
 * before they commit to it.
 */
export function segmentLengthMetres(segment: CalibrationSegment, wupm: number): number | null {
	if (!Number.isFinite(wupm) || wupm <= 0) return null;
	const world = segmentLengthWorld(segment);
	if (world <= 0) return null;
	return world / wupm;
}
