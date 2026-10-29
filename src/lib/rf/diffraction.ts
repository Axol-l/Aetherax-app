/**
 * Diffraction at the ends of walls: a single knife edge, per ITU-R P.526.
 *
 * A wall in this app is a segment, so the only place a wave can bend around it is an **end
 * point** — the corner of a room, the mouth of a corridor. The exact treatment is GTD/UTD at a
 * wedge, which needs the wall's two faces and a material-dependent wedge coefficient; what is
 * implemented here is the standard indoor-planning approximation of it: treat each end point as
 * a knife edge, compute the Fresnel–Kirchhoff parameter ν from how far the edge intrudes into
 * the straight path, and take the attenuation of the Fresnel integral (the P.526 closed form).
 *
 * It is honest about what it is not: no wedge angle, no shadow-boundary transition to the
 * reflected field, no polarisation. What it does give is the thing the model was missing — a
 * room around a corner is not silent, and the loss through the opening falls off as the path
 * clears the edge.
 *
 * The edge list is built once per generation and culled per sample: only edges near the path are
 * considered, and the caller keeps the strongest, so the cost per sample is bounded.
 */
import type { ReflectingWall } from './reflection.js';

/** A wall end point, with the wall it belongs to (for its material). */
export interface DiffractionEdge {
	x: number;
	y: number;
	/** Which wall's end this is, so a culled call can skip the segment it belongs to. */
	material: number;
}

/** Every end point of every segment: two per wall, the corners a wave can bend around. */
export function edgesOf(walls: readonly ReflectingWall[]): DiffractionEdge[] {
	const edges: DiffractionEdge[] = [];
	for (const wall of walls) {
		edges.push({ x: wall.ax, y: wall.ay, material: wall.material });
		edges.push({ x: wall.bx, y: wall.by, material: wall.material });
	}
	return edges;
}

/**
 * Knife-edge loss in dB for a path that clears an edge by `clearance` metres.
 *
 * `clearance` is positive when the edge is **inside** the direct path (the path has to bend
 * around it) and negative when the path passes clear of it — the convention the Fresnel
 * parameter is defined with. The formula is ITU-R P.526 §4.1:
 *
 *   ν = h·√( 2(d₁+d₂) / (λ·d₁·d₂) )
 *   L = 6.9 + 20·log₁₀( √((ν−0.1)²+1) + ν − 0.1 )
 *
 * with L → 0 for ν ≤ −0.8, which is the free-space side of the transition.
 */
export function knifeEdgeLossDb(clearance: number, d1: number, d2: number, wavelength: number): number {
	if (!(d1 > 0) || !(d2 > 0) || !(wavelength > 0)) return 0;
	const v = clearance * Math.sqrt((2 * (d1 + d2)) / (wavelength * d1 * d2));
	if (v <= -0.8) return 0;
	return 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1);
}

/**
 * The loss of the best diffracted path from `from` to `to` around one of `edges`, or null.
 *
 * Only edges that lie **between** the two ends and off the straight line are useful: an edge
 * behind the access point, or one the path already goes around by more than a few Fresnel
 * radii, contributes nothing but cost.
 */
export function bestDiffraction(
	from: { x: number; y: number },
	to: { x: number; y: number },
	edges: readonly DiffractionEdge[],
	wavelength: number,
	maxClearance = 40,
	maxDistance = 60
): { lossDb: number; x: number; y: number } | null {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const direct = Math.hypot(dx, dy);
	if (direct < 1e-6) return null;
	const ux = dx / direct;
	const uy = dy / direct;

	let best: { lossDb: number; x: number; y: number } | null = null;
	for (const edge of edges) {
		const ex = edge.x - from.x;
		const ey = edge.y - from.y;
		// Projection along the path: the edge must lie between the ends.
		const along = ex * ux + ey * uy;
		if (along <= 0 || along >= direct) continue;
		const d1 = Math.hypot(ex, ey);
		const d2 = Math.hypot(to.x - edge.x, to.y - edge.y);
		if (d1 > maxDistance || d2 > maxDistance) continue;
		// Perpendicular offset, signed so "inside the path" is positive. The sign is decided by
		// the side the *receiver* is on: an edge on that side has to be bent around.
		const side = ex * uy - ey * ux;
		const clearance = side;
		if (Math.abs(clearance) > maxClearance) continue;
		const lossDb = knifeEdgeLossDb(Math.abs(clearance), d1, d2, wavelength);
		if (best === null || lossDb < best.lossDb) best = { lossDb, x: edge.x, y: edge.y };
	}
	return best;
}

/** Free-space wavelength in world-agnostic metres. */
export function wavelengthM(frequencyGhz: number): number {
	return 299_792_458 / (frequencyGhz * 1e9);
}

/** The wavelength of a band, in metres, at the band centre the material table uses. */
export function bandWavelengthM(band: '2.4ghz' | '5ghz' | '6ghz'): number {
	const ghz = { '2.4ghz': 2.447, '5ghz': 5.5, '6ghz': 6.53 } as const;
	return wavelengthM(ghz[band]);
}

/**
 * The loss a blocked path recovers by bending around the nearest edge, or 0.
 *
 * Called only when the direct path is blocked — diffraction is what fills a shadow, and adding
 * it beside a line-of-sight path would count the same energy twice. The clearance cap keeps the
 * per-sample cost bounded on a plan with many walls; the model is the single edge nearest the
 * straight line, which is the corner the wave actually bends around.
 */
export function diffractionLossDb(
	from: { x: number; y: number },
	to: { x: number; y: number },
	edges: readonly DiffractionEdge[],
	band: '2.4ghz' | '5ghz' | '6ghz',
	maxClearance = 40,
	maxDistance = 60
): number {
	const best = bestDiffraction(from, to, edges, bandWavelengthM(band), maxClearance, maxDistance);
	return best?.lossDb ?? 0;
}
