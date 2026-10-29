/**
 * One specular reflection, as a power term.
 *
 * The propagation model is a power sum (each wall costs a figure, terms add in dB), not a
 * coherent field, so a reflection enters the same way a transmission does: the reflected path is
 * a second way to reach the texel, and its level is added as a power ratio. That choice is
 * deliberate — coherent summation needs phase, produces interference nulls and would move every
 * number in the app — and it is what indoor planning tools report.
 *
 * The geometry is the image-source method: mirror the access point in the wall's own line, and
 * the straight line from the image to the texel crosses that line exactly at the specular
 * reflection point. The point has to lie **on the segment** for the reflection to exist. The
 * coefficient comes from the same P.2040 slab model the transmission figure does
 * (`rf/material-itu.ts`), evaluated at the angle of incidence this path actually has and at the
 * material's own thickness.
 *
 * What this module does not do, on purpose: multiple bounces (a second-order image is a
 * reflection of a reflection — that belongs with a workload that can afford it) and diffraction
 * (a different coefficient; see the UTD in Sionna's `utils/electromagnetics.py`). One bounce is
 * where most of the energy in a room is after the direct ray.
 */
import type { Band } from '@aetherax/channels';
import { getMaterial, type WallMaterialId } from '$canvas/materials.js';
import {
	BAND_FREQUENCY_GHZ,
	ituEpsilon,
	slabTransmission
} from './material-itu.js';

export interface ReflectingWall {
	ax: number;
	ay: number;
	bx: number;
	by: number;
	material: number;
}

export interface Reflection {
	/** Where the ray meets the wall, in world units. */
	x: number;
	y: number;
	/** Total path length, access point → wall → point. */
	length: number;
	/** Cosine of the incidence angle at the wall (1 = head-on). */
	cosTheta: number;
	/** Reflected power as a fraction of the incident power (≤ 1). */
	powerRatio: number;
}

/** A reflection quieter than this is not worth the arithmetic or the texel's time. */
const MIN_REFLECTION_DB = -25;

/**
 * The specular reflection of `from` in `wall` that reaches `to`, or null.
 *
 * Null covers every reason it cannot exist: a degenerate wall, both points on the same side (a
 * reflection that would have to pass through the wall), a bounce beyond the segment's ends (a
 * wall is finite; light does not reflect off the air beside it).
 */
export function specularReflection(
	from: { x: number; y: number },
	to: { x: number; y: number },
	wall: ReflectingWall
): { x: number; y: number; length: number; cosTheta: number } | null {
	const dx = wall.bx - wall.ax;
	const dy = wall.by - wall.ay;
	const lenSq = dx * dx + dy * dy;
	if (lenSq < 1e-9) return null;

	const len = Math.sqrt(lenSq);
	const nx = -dy / len;
	const ny = dx / len;
	const sideFrom = (from.x - wall.ax) * nx + (from.y - wall.ay) * ny;
	const sideTo = (to.x - wall.ax) * nx + (to.y - wall.ay) * ny;
	/*
	 * The two ends must be on the **same** side of the wall's line.
	 *
	 * A reflection off a wall to the right of both points is fine; a "reflection" between two
	 * points on opposite sides is not — that ray passes through the wall, and the wall's own
	 * transmission figure is what charges it. This is the image-source precondition, and getting
	 * it backwards silently turns every crossing into a bounce.
	 */
	if (sideFrom * sideTo <= 0) return null;

	// f' = f − 2·(f·n̂)n̂
	const imageX = from.x - 2 * sideFrom * nx;
	const imageY = from.y - 2 * sideFrom * ny;

	// Intersection of image→to with the wall's line.
	const ix = to.x - imageX;
	const iy = to.y - imageY;
	const denom = ix * dy - iy * dx;
	let hitX: number;
	let hitY: number;
	if (Math.abs(denom) < 1e-9) {
		/*
		 * Head-on: the receiver lies on the reflected ray, so the image, the receiver and the
		 * wall are collinear and "where the line meets the wall" has no unique answer. The
		 * specular point is then the foot of the perpendicular from the source, which is where
		 * an exactly mirrored ray bounces.
		 */
		if (Math.abs(ix) > 1e-9 || Math.abs(iy) > 1e-9) return null;
		hitX = from.x - sideFrom * nx;
		hitY = from.y - sideFrom * ny;
	} else {
		const t = ((wall.ax - imageX) * dy - (wall.ay - imageY) * dx) / denom;
		if (t <= 0 || t >= 1) return null;
		hitX = imageX + ix * t;
		hitY = imageY + iy * t;
	}

	// On the segment, not on its extension.
	const along = ((hitX - wall.ax) * dx + (hitY - wall.ay) * dy) / lenSq;
	if (along < 0 || along > 1) return null;

	const d1 = Math.hypot(hitX - from.x, hitY - from.y);
	const d2 = Math.hypot(to.x - hitX, to.y - hitY);
	if (d1 < 1e-9) return null;
	const incident = Math.abs(((hitX - from.x) * nx + (hitY - from.y) * ny) / d1);
	return {
		x: hitX,
		y: hitY,
		length: d1 + d2,
		cosTheta: Math.min(1, Math.max(0, incident))
	};
}

/**
 * Reflected power as a fraction of the incident power, from the material's own coefficients.
 *
 * Zero for a material with no ITU equivalent. The virtual partition is a line in the mask that
 * divides rooms — it is not a surface, so it reflects nothing; the closed door is modelled by a
 * flat loss, so it has no coefficient to reflect with either.
 */
export function reflectionPowerRatio(
	wall: ReflectingWall,
	band: Band,
	cosTheta: number
): number {
	const material = getMaterial(wall.material as WallMaterialId);
	if (!material.itu) return 0;
	const frequencyGhz = BAND_FREQUENCY_GHZ[band];
	const { epsR, sigma } = ituEpsilon(material.itu, frequencyGhz);
	const { rTe, rTm } = slabTransmission(
		epsR,
		sigma,
		frequencyGhz,
		material.typicalThickness,
		cosTheta
	);
	const power = (rTe.re * rTe.re + rTe.im * rTe.im + rTm.re * rTm.re + rTm.im * rTm.im) / 2;
	return Math.min(1, Math.max(0, power));
}

/**
 * The strongest single reflection reaching `to` from an access point, or null.
 *
 * `maxDistance` culls walls too far from the path to matter: a reflection's only hope is a short
 * detour, and per-texel cost has to stay bounded on a real plan. Walls are not sorted by
 * distance (that would cost more than it saves at these counts), so the cull is a plain
 * midpoint test.
 */
export function bestReflection(
	from: { x: number; y: number },
	to: { x: number; y: number },
	walls: readonly ReflectingWall[],
	band: Band,
	maxDistance = Infinity
): Reflection | null {
	let best: Reflection | null = null;
	let bestDb = MIN_REFLECTION_DB;
	const midX = (from.x + to.x) / 2;
	const midY = (from.y + to.y) / 2;

	for (const wall of walls) {
		const wallX = (wall.ax + wall.bx) / 2;
		const wallY = (wall.ay + wall.by) / 2;
		if (Math.hypot(wallX - midX, wallY - midY) > maxDistance) continue;

		const hit = specularReflection(from, to, wall);
		if (!hit) continue;
		const ratio = reflectionPowerRatio(wall, band, hit.cosTheta);
		if (ratio <= 0) continue;
		const db = 10 * Math.log10(ratio);
		if (db > bestDb) {
			bestDb = db;
			best = { ...hit, powerRatio: ratio };
		}
	}
	return best;
}
