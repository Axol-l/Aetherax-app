/**
 * The planning area: where the user says the floor actually is.
 *
 * Everything about "inside" in this app has been inferred — from the wall mask, by
 * flood-filling what the walls enclose. That inference is a guess, and it is wrong in both
 * directions on real plans: a room whose outline has a wide opening reads as *outside*
 * (which is how an access point standing in the middle of an office came to be reported as
 * outside the building), while a wall cavity between two drawn lines reads as *inside*.
 *
 * So the user can draw the area instead. Automatic detection stays the default — it is
 * right for a clean plan and it costs nothing — but once a polygon exists it is the
 * authority: warnings, placement and the optimiser's domain all use it. This is the same
 * reason site-survey tools have you draw the planning area by hand.
 *
 * Points are world coordinates. A polygon needs at least three; fewer is a line, not an
 * area, and every consumer treats it as absent.
 */

export interface PlanningPoint {
	x: number;
	y: number;
}

export type PlanningArea = PlanningPoint[];

/** The smallest polygon worth acting on. */
export const MIN_PLANNING_POINTS = 3;

/** Whether a polygon can be used as an area at all. */
export function isUsablePlanningArea(area: PlanningArea | null | undefined): area is PlanningArea {
	return !!area && area.length >= MIN_PLANNING_POINTS;
}

/**
 * Even-odd point-in-polygon, on world coordinates.
 *
 * Ray casting rather than a winding rule: the areas people draw are simple loops, and
 * even-odd gives the same answer for them while needing no orientation.
 *
 * A point exactly on an edge may come out either way — the two sides of a boundary line are
 * both defensible answers and the cost of being wrong is one pixel of a warning.
 */
export function pointInPlanningArea(point: PlanningPoint, area: PlanningArea): boolean {
	if (!isUsablePlanningArea(area)) return false;
	let inside = false;
	for (let i = 0, j = area.length - 1; i < area.length; j = i++) {
		const a = area[i]!;
		const b = area[j]!;
		const straddles = a.y > point.y !== b.y > point.y;
		if (!straddles) continue;
		const x = a.x + ((point.y - a.y) / (b.y - a.y)) * (b.x - a.x);
		if (point.x < x) inside = !inside;
	}
	return inside;
}

/**
 * Intersect an interior mask with the planning area, in place.
 *
 * The mask is the app's own domain — walls already excluded, voids already removed — and
 * this keeps only the part the user drew. Called on both sides of the worker boundary, from
 * the same polygon expressed in mask pixels, so the optimiser and the app's guard cannot
 * disagree about what is inside.
 *
 * Returns how many pixels were kept, which is what the callers report when the answer is
 * "nothing left".
 */
export function clipInteriorToPlanningArea(
	interior: Uint8Array,
	width: number,
	height: number,
	originX: number,
	originY: number,
	area: PlanningArea
): number {
	if (!isUsablePlanningArea(area)) {
		let kept = 0;
		for (let i = 0; i < interior.length; i++) if (interior[i]) kept++;
		return kept;
	}
	let kept = 0;
	for (let y = 0; y < height; y++) {
		const worldY = originY + y;
		for (let x = 0; x < width; x++) {
			const index = y * width + x;
			if (!interior[index]) continue;
			if (!pointInPlanningArea({ x: originX + x, y: worldY }, area)) {
				interior[index] = 0;
				continue;
			}
			kept++;
		}
	}
	return kept;
}
