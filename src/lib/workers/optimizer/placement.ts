/**
 * Where an AP may sit, and what the walls between it and a sample cost.
 *
 * The wall cache, the wall-mount band and the interior snapping are geometry: they read a
 * mask and a context and return numbers, with no search state. They were the densest
 * cluster of helpers in the worker and the least dependent on it.
 */
import type { Band } from '@aetherax/channels';
import { getMaterialDbTable, isVirtualMaterial, type WallMaterialId } from '$canvas/materials.js';
import { rayMarchWallAtten } from '../../rf/propagation.js';
import type { InteriorField, WallCache, WallPlacement } from './types.js';

/** Source quantisation lattice, in mask pixels. */
const SOURCE_GRID = 8;

export function createWallCache(
	mask: Uint8Array,
	w: number,
	h: number,
	samples: Array<{ x: number; y: number }>,
	wallAttenuation: number,
	band: Band,
	materialMask: Uint8Array | null,
	defaultMaterial: number
): WallCache {
	// Per-band material tables: the figure for one crossing of each material, which is what
	// `rayMarchWallAtten` charges and what the heatmap's field charges for the same crossing.
	const materialDb = getMaterialDbTable(band);
	// Without a material mask every wall costs the same, so honour the project's
	// explicit wall attenuation rather than substituting Drywall's value.
	const defaultDb = materialMask
		? (materialDb[defaultMaterial] ?? wallAttenuation)
		: wallAttenuation;

	const numSamples = samples.length;
	const rows = new Map<string, Float32Array>();

	return {
		band,
		tableFor(x: number, y: number): Float32Array {
			const qx = Math.round(x / SOURCE_GRID);
			const qy = Math.round(y / SOURCE_GRID);
			const key = qx + ',' + qy;
			const hit = rows.get(key);
			if (hit) return hit;

			const sx = qx * SOURCE_GRID;
			const sy = qy * SOURCE_GRID;
			const row = new Float32Array(numSamples);
			for (let s = 0; s < numSamples; s++) {
				// Stride-3 DDA; this is the approximation stage 3 later redoes exactly.
				row[s] = rayMarchWallAtten(
					mask,
					w,
					h,
					materialMask,
					materialDb,
					defaultDb,
					sx,
					sy,
					samples[s]!.x,
					samples[s]!.y,
					3,
					defaultMaterial
				);
			}
			rows.set(key, row);
			return row;
		}
	};
}

/** Facing of a band pixel, in degrees, or null when it is not in the band. */
export function facingAt(placement: WallPlacement, x: number, y: number, w: number, h: number): number | null {
	const ix = Math.round(x);
	const iy = Math.round(y);
	if (ix < 0 || iy < 0 || ix >= w || iy >= h) return null;
	const step = placement.facingStep[iy * w + ix]!;
	return step === 255 ? null : step * 22.5;
}

/**
 * The band of floor beside the walls, and the facing each point on it looks in.
 *
 * `inside` is the *untrimmed* interior — the wall mask's complement within the
 * building — because the trimmed one has already given up the pixels this needs. The
 * flood is 8-connected and capped at `radiusWu` steps, so it costs one pass over the
 * band rather than a dilation of the whole mask.
 */
export function buildWallPlacement(
	wallMask: Uint8Array,
	inside: Uint8Array,
	w: number,
	h: number,
	radiusWu: number,
	/**
	 * Materials per wall pixel and the floor's default, when the caller sent them.
	 *
	 * A **virtual partition** is a modelling line, not a surface: it attenuates nothing,
	 * and a bracket cannot be screwed to it. Such pixels are not seeds here, so the band
	 * never forms against one and a wall-mounted AP is never placed facing a line that
	 * radiates both ways. See `wall-snap.ts`, which applies the same rule on the app side.
	 */
	materialMap: Uint8Array | null = null,
	defaultMaterial = 0
): WallPlacement | null {
	const n = w * h;
	const radius = Math.max(1, Math.min(64, Math.round(radiusWu)));
	const band = new Uint8Array(n);
	const facingStep = new Uint8Array(n).fill(255);
	const dist = new Int16Array(n).fill(-1);
	const seedX = new Int16Array(n);
	const seedY = new Int16Array(n);
	const queue = new Int32Array(n);
	let head = 0;
	let tail = 0;

	for (let i = 0; i < n; i++) {
		if (!wallMask[i]) continue;
		if (materialMap) {
			const material = materialMap[i] ?? defaultMaterial;
			if (isVirtualMaterial(material as WallMaterialId)) continue;
		}
		dist[i] = 0;
		queue[tail++] = i;
	}
	if (tail === 0) return null;

	while (head < tail) {
		const idx = queue[head++]!;
		const d = dist[idx]!;
		if (d >= radius) continue;
		const x = idx % w;
		const y = (idx / w) | 0;
		for (let dy = -1; dy <= 1; dy++) {
			const ny = y + dy;
			if (ny < 0 || ny >= h) continue;
			for (let dx = -1; dx <= 1; dx++) {
				if (dx === 0 && dy === 0) continue;
				const nx = x + dx;
				if (nx < 0 || nx >= w) continue;
				const nIdx = ny * w + nx;
				if (dist[nIdx] !== -1) continue;
				// The flood runs through floor only: a wall pixel is a seed, not a
				// corridor, and starting one from another wall pixel would push the
				// band through a thick wall into the room behind it.
				if (!inside[nIdx]) continue;
				dist[nIdx] = d + 1;
				// The seed travels with the pixel, so the facing is away from the wall
				// that actually reached it rather than away from some other wall.
				const sx0 = d === 0 ? x : seedX[idx]!;
				const sy0 = d === 0 ? y : seedY[idx]!;
				seedX[nIdx] = sx0;
				seedY[nIdx] = sy0;
				band[nIdx] = 1;
				const vx = nx - sx0;
				const vy = ny - sy0;
				if (vx !== 0 || vy !== 0) {
					const deg = (Math.atan2(vy, vx) * 180) / Math.PI;
					facingStep[nIdx] = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
				}
				queue[tail++] = nIdx;
			}
		}
	}

	let any = false;
	for (let i = 0; i < n; i++) {
		if (band[i]) {
			any = true;
			break;
		}
	}
	if (!any) return null;
	return { band, field: buildInteriorField(band, w, h), facingStep };
}

export function buildInteriorField(interior: Uint8Array, w: number, h: number): InteriorField {
	const n = w * h;
	const nearest = new Int32Array(n).fill(-1);
	const queue = new Int32Array(n);
	let head = 0;
	let tail = 0;

	// Seed: every interior pixel is its own nearest neighbour.
	for (let i = 0; i < n; i++) {
		if (interior[i]) {
			nearest[i] = i;
			queue[tail++] = i;
		}
	}

	// Multi-source BFS. Each pixel is enqueued at most once, so a queue of size
	// n is sufficient.
	while (head < tail) {
		const idx = queue[head++]!;
		const src = nearest[idx]!;
		const x = idx % w;
		const y = (idx / w) | 0;
		for (let dy = -1; dy <= 1; dy++) {
			const ny = y + dy;
			if (ny < 0 || ny >= h) continue;
			for (let dx = -1; dx <= 1; dx++) {
				if (dx === 0 && dy === 0) continue;
				const nx = x + dx;
				if (nx < 0 || nx >= w) continue;
				const nIdx = ny * w + nx;
				if (nearest[nIdx] !== -1) continue;
				nearest[nIdx] = src;
				queue[tail++] = nIdx;
			}
		}
	}

	return { nearest, w, h };
}

/**
 * Snap a position onto the building interior.
 *
 * The clamp is essential. The BFS field covers every in-mask pixel, so a
 * *clamped* lookup always resolves to an interior pixel. Without the clamp, a
 * point outside the mask was returned unchanged — and PSO's initial jitter
 * (`+/- max(w,h) * 0.2`, applied to positions that may already sit near an
 * edge) produces such points readily. Stage 3 only accepts moves that land on
 * an interior pixel and skips out-of-bounds candidates, so an AP placed outside
 * by PSO could never move back in. That is how optimised APs ended up off-plan.
 */
export function snapToInterior(
	x: number,
	y: number,
	field: InteriorField,
	allowOutside: boolean
): { x: number; y: number } {
	if (allowOutside) return { x: Math.round(x), y: Math.round(y) };

	const ix = Math.min(field.w - 1, Math.max(0, Math.round(x)));
	const iy = Math.min(field.h - 1, Math.max(0, Math.round(y)));
	const src = field.nearest[iy * field.w + ix]!;
	if (src >= 0) return { x: src % field.w, y: (src / field.w) | 0 };
	// Only reachable when the mask has no interior at all, which the caller
	// guards against before starting.
	return { x: ix, y: iy };
}

/**
 * The single place that decides whether an AP may occupy a position.
 *
 * The bounds test is deliberately kept even though `interior` is available:
 * for a negative x, `y * w + x` aliases into the previous row and can read a
 * genuine interior pixel, so an out-of-range coordinate would be accepted as
 * legal if the bounds check were dropped. Centralising the policy here replaces
 * the ad-hoc `nx < 0 || nx >= w` tests that were scattered through the search.
 */
export function isPositionAllowed(
	x: number,
	y: number,
	interior: Uint8Array | null,
	w: number,
	h: number,
	allowOutside: boolean,
	voidMask: Uint8Array | null = null
): boolean {
	if (x < 0 || x >= w || y < 0 || y >= h) return false;
	// A void is a hole in the floor — an atrium, a stairwell — with nothing to mount
	// an AP to. That is a physical fact rather than a preference about rooms, so it
	// does not become legal because the user allowed APs outside rooms.
	if (voidMask && voidMask[y * w + x] === 1) return false;
	if (allowOutside || !interior) return true;
	return interior[y * w + x] === 1;
}

/**
 * Snap a candidate position for one AP into the domain that AP is allowed in.
 *
 * A wall-mounted AP's domain is the band along the walls rather than the interior: an
 * AP against a wall face is exactly what the interior was trimmed to exclude. The band
 * is a bracket's depth wide, so a position the search puts there is already on a wall;
 * the caller then puts it exactly on the face when it applies the result.
 */
export function snapForAp(
	a: number,
	x: number,
	y: number,
	wallMounted: boolean[],
	snapTarget: { field: InteriorField; free: boolean },
	wallPlacement: WallPlacement | null
): { x: number; y: number } {
	if (wallMounted[a] && wallPlacement) return snapToInterior(x, y, wallPlacement.field, false);
	return snapToInterior(x, y, snapTarget.field, snapTarget.free);
}

/** Whether an AP may occupy a position — the same split as `snapForAp`. */
export function allowedForAp(
	a: number,
	x: number,
	y: number,
	wallMounted: boolean[],
	wallPlacement: WallPlacement | null,
	interior: Uint8Array | null,
	w: number,
	h: number,
	allowOutside: boolean,
	voidMask: Uint8Array | null
): boolean {
	if (wallMounted[a] && wallPlacement) {
		if (x < 0 || x >= w || y < 0 || y >= h) return false;
		// A void is a hole in the floor: there is no wall to mount to over a shaft,
		// whatever the mask says around it.
		if (voidMask && voidMask[y * w + x] === 1) return false;
		return wallPlacement.band[y * w + x] === 1;
	}
	return isPositionAllowed(x, y, interior, w, h, allowOutside, voidMask);
}

/**
 * Where an AP may be snapped to, and whether snapping happens at all.
 *
 * With `allowOutside` the answer used to be "anywhere", which put APs over atriums.
 * When the floor has voids the target becomes "anywhere that is not a hole"
 * instead: the nearest pixel with a floor, which may well be outside a room.
 */
export function buildSnapTarget(
	interior: Uint8Array,
	voidMask: Uint8Array | null,
	w: number,
	h: number,
	allowOutside: boolean
): { field: InteriorField; free: boolean } {
	if (!allowOutside) return { field: buildInteriorField(interior, w, h), free: false };
	if (!voidMask) return { field: buildInteriorField(interior, w, h), free: true };
	const solid = new Uint8Array(w * h);
	for (let i = 0; i < solid.length; i++) solid[i] = voidMask[i] === 1 ? 0 : 1;
	return { field: buildInteriorField(solid, w, h), free: false };
}
