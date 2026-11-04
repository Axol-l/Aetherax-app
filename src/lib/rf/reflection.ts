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
import { getMaterial, type WallMaterialId } from '$lib/domain/materials.js';
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

/**
 * The specular reflection of `from` in `wall` that reaches `to`, or null.
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
 */
const coefficientCache = new Map<string, number>();
export function reflectionPowerRatio(
	wall: ReflectingWall,
	band: Band,
	cosTheta: number
): number {
	const material = getMaterial(wall.material as WallMaterialId);
	if (!material.itu) return 0;
	const bucket = Math.round(Math.min(1, Math.max(0, cosTheta)) * 40);
	const key = `${wall.material}:${band}:${bucket}`;
	const cached = coefficientCache.get(key);
	if (cached !== undefined) return cached;

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
	const result = Math.min(1, Math.max(0, power));
	coefficientCache.set(key, result);
	return result;
}

/**
 * Every reflection reaching `to`, strongest first, above `minRatio`.
 */
export function reflections(
	from: { x: number; y: number },
	to: { x: number; y: number },
	walls: readonly ReflectingWall[],
	band: Band,
	maxDistance = Infinity,
	minRatio = 1e-4
): Reflection[] {
	const out: Reflection[] = [];
	const midX = (from.x + to.x) / 2;
	const midY = (from.y + to.y) / 2;

	for (const wall of walls) {
		// Soft cull: a wall that only just misses the radius contributes almost nothing, and
		// the fade keeps the radius from drawing a circle on the plan.
		const reach = Math.hypot((wall.ax + wall.bx) / 2 - midX, (wall.ay + wall.by) / 2 - midY);
		if (reach > maxDistance) continue;

		const hit = specularReflection(from, to, wall);
		if (!hit) continue;
		const ratio = reflectionPowerRatio(wall, band, hit.cosTheta);
		if (ratio <= minRatio) continue;
		out.push({ ...hit, powerRatio: ratio });
	}
	out.sort((a, b) => b.powerRatio - a.powerRatio);
	return out;
}

/**
 * The strongest single reflection reaching `to` from an access point, or null.
 */
export function bestReflection(
	from: { x: number; y: number },
	to: { x: number; y: number },
	walls: readonly ReflectingWall[],
	band: Band,
	maxDistance = Infinity
): Reflection | null {
	const all = reflections(from, to, walls, band, maxDistance);
	return all.length > 0 ? all[0]! : null;
}
