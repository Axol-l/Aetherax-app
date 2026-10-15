import { pathLossDb, reachAtLevel } from '$lib/rf/propagation.js';

/** The AP fields the image bounds depend on. */
export interface RegionAp {
	x: number;
	y: number;
	power: number;
	band: string;
}

export interface RegionMask {
	originX: number;
	originY: number;
	width: number;
	height: number;
}

export interface HeatmapRegion {
	x0: number;
	y0: number;
	cols: number;
	rows: number;
	texel: number;
}

/**
 * Slack on each AP's reach, so the texel that straddles the edge of the coloured
 * area is inside the image rather than half outside it.
 */
const REACH_MARGIN = 1.05;

/**
 * World rectangle the coverage image has to cover, and the texel size that keeps
 * it inside the cell budget.
 *
 * Two things set the rectangle: the plan's own mask (so the image always covers
 * the floor plan, whatever the APs are doing) and each AP's **drawable reach** —
 * the distance at which its level falls to the ramp floor, `rssiFloor`. Past
 * that distance a texel cannot be anything but transparent, so covering it only
 * spends the cell budget.
 *
 * That last part is the fix for a rendering bug. The rectangle used to be the
 * plan plus `1.5 × interferenceRadius`, i.e. 1.5 × the ASSOCIATION radius. At
 * 5 GHz / 20 dBm that is 1.5 × 29.9 m ≈ 45 m of margin per side, while the ramp
 * floor (−70 dBm) puts the last visible metre at about 12.6 m — so the image was
 * asked for roughly 3× the span it could ever colour, ~9× the area. Past
 * `maxTexels` the texel was widened to fit, and the widened texel is what the
 * user sees: at the tiled overview's ~1 px per world unit an 8–12 unit texel is
 * an 8–12 px cell, and because the ramp quantises to 256 levels over ~46 dB,
 * runs of neighbouring cells share a level and render as flat colour patches
 * joined by short ramps — "no gradient, very chopped up".
 *
 * With the rectangle sized by the reach instead, a plan of 1000 × 784 world
 * units with 5 GHz APs at the default −70 dBm floor fits the fine texel
 * (1832 × 1616 units ≈ 185 000 cells at 4 units, under the 250 000 budget), so
 * the widening no longer triggers at all.
 *
 * The rectangle is a superset of the coloured area, never a subset: the reach is
 * free space, and walls, slabs and the 1 m distance clamp only reduce the level.
 */
export function heatmapRegion(
	aps: readonly RegionAp[],
	mask: RegionMask | null,
	rssiFloor: number,
	worldUnitsPerMeter: number,
	texelFine: number,
	maxTexels: number
): HeatmapRegion | null {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;

	if (mask) {
		minX = mask.originX;
		minY = mask.originY;
		maxX = mask.originX + mask.width;
		maxY = mask.originY + mask.height;
	}

	for (const ap of aps) {
		// pathLossDb(band, 1) is the 1 m reference loss PL0 for the band.
		const referenceDbm = ap.power - pathLossDb(ap.band, 1);
		const reachInMeters = reachAtLevel(referenceDbm, rssiFloor);
		const reach = reachInMeters * worldUnitsPerMeter * REACH_MARGIN;
		// An AP at or below the floor colours nothing, so it must not stretch the
		// image either.
		if (!(reach > 0)) continue;
		if (ap.x - reach < minX) minX = ap.x - reach;
		if (ap.y - reach < minY) minY = ap.y - reach;
		if (ap.x + reach > maxX) maxX = ap.x + reach;
		if (ap.y + reach > maxY) maxY = ap.y + reach;
	}

	if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return null;

	// Widen the texel rather than the allocation when a region is genuinely too
	// large for the budget (a big plan, many APs, or a floor set at −95 dBm).
	// Widening counts on the ramp being smooth: it costs detail, never coverage.
	let texel = texelFine;
	const spanX = maxX - minX;
	const spanY = maxY - minY;
	if (spanX * spanY > maxTexels * texel * texel) {
		texel = Math.ceil(Math.sqrt((spanX * spanY) / maxTexels));
	}

	// Snap the origin down to the texel lattice so the image does not shift by a
	// sub-texel amount every time an AP moves slightly.
	const x0 = Math.floor(minX / texel) * texel;
	const y0 = Math.floor(minY / texel) * texel;

	return {
		x0,
		y0,
		cols: Math.max(1, Math.ceil((maxX - x0) / texel)),
		rows: Math.max(1, Math.ceil((maxY - y0) / texel)),
		texel
	};
}
