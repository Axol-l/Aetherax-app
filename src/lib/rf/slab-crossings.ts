/**
 * Attributing a cross-floor path's storey boundaries to the floors that own them.
 */

import type { Band } from '@aetherax/channels';
import type { SlabCrossing } from './cross-floor.js';

/** A room-type mask on its own pixel grid, in whatever frame the caller works in. */
export interface RoomTypeSlice {
	roomTypes: Uint8Array | null;
	width: number;
	height: number;
	originX: number;
	originY: number;
}

/** One floor, as this computation needs it. */
export interface FloorForSlab {
	id: string;
	/** Walking-surface elevation above the lowest floor, in metres. */
	elevation: number;
	/** Ceiling height, so a ceiling-mounted AP's height is `elevation + ceilingHeight`. */
	ceilingHeight: number;
	/** Material loss of the slab owned by this floor, for the band in question. */
	slabLossDb: number;
	/** This floor's room types, in the frame the caller's samples are in. */
	slice: RoomTypeSlice;
}

export interface CrossingSlabInput {
	/** Every floor, **lowest first**. `floorPlaneHeights` uses this order. */
	floors: readonly FloorForSlab[];
	/** Client height above its own floor, metres. */
	clientHeight: number;
	/**
	 * The access point's own height above *its* floor, metres.
	 */
	apHeightM?: number;
	/** Band, carried only for the doc trail: the loss is already resolved. */
	band: Band;
}

/**
 * The crossings a path from `apFloorId` to `clientFloorId` makes, ready to score.
 */
export function crossingSlabsFor(
	input: CrossingSlabInput,
	apFloorId: string,
	clientFloorId: string
): SlabCrossing[] | null {
	const apIndex = input.floors.findIndex((f) => f.id === apFloorId);
	const clientIndex = input.floors.findIndex((f) => f.id === clientFloorId);
	if (apIndex < 0 || clientIndex < 0 || apIndex === clientIndex) return null;
	const ap = input.floors[apIndex]!;
	const client = input.floors[clientIndex]!;

	const apZ = ap.elevation + (input.apHeightM ?? ap.ceilingHeight);
	const clientZ = client.elevation + input.clientHeight;
	if (Math.abs(clientZ - apZ) < 1e-9) return null;

	// The floors whose own floor slabs the path crosses are the ones **between** the two
	// endpoints, inclusive — and this comes from the floor *indices*, not from a list of
	// crossings. Deriving it from the crossings was wrong for an upward path: a
	// ceiling-mounted AP sits on the underside of the slab above it, so the ray crosses
	// that slab at `t = 0`, and a list that held only strictly-interior planes silently
	// charged the whole aggregate to some further crossing instead.
	//
	// Floor `k`'s own floor slab is the boundary between floors `k - 1` and `k`, so it is
	// in the path exactly when `k` is strictly between the two endpoints (or at the lower
	// one, for an upward path that starts under it) — which is the half-open range below,
	// written so it holds whichever endpoint is higher.
	const loFloor = Math.min(apIndex, clientIndex) + 1;
	const hiFloor = Math.max(apIndex, clientIndex);

	// The aggregate, built exactly the way `getFloorSlabAttenuation` builds it: the first
	// charged floor in full, every later one capped. `floors[k].slabLossDb` is floor
	// `k`'s own floor slab, which is the boundary between floors `k - 1` and `k` — so
	// indexing the charged floors by **floor** rather than by boundary is what keeps
	// these shares summing to the figure the path is actually charged.
	const applied: number[] = [];
	for (let k = loFloor; k <= hiFloor; k++) {
		const own = input.floors[k]?.slabLossDb ?? 0;
		applied.push(k === loFloor ? own : Math.min(own, ADDITIONAL_FLOOR_DB));
	}
	const total = applied.reduce((a, b) => a + b, 0);

	// **Floor and plane are different indices, and mixing them is silent.** Plane `p` is
	// the walking surface of floor `p`, so a plane carries the slab of the floor *below*
	// it: plane `p` is floor `p - 1`'s own floor slab. The charged floors are
	// `loFloor .. hiFloor`, so the charged planes are the same range — plane `p` takes
	// `applied[p - loFloor]`, and with that index the shares sum to exactly the number
	// `getFloorSlabAttenuation` charges.
	const out: SlabCrossing[] = [];
	for (let p = loFloor; p <= hiFloor; p++) {
		const planeZ = input.floors[p]!.elevation;
		const t = (planeZ - apZ) / (clientZ - apZ);
		// The ray crosses this plane if the plane lies between the endpoints, endpoints
		// **included**: a ceiling-mounted AP sits on the underside of the slab above it, so
		// a plane at `t = 0` is in the path even though it splits the run into nothing.
		if (t < 0 || t >= 1) continue;
		// **Which plan has the hole?** Plane `p`'s own floor, because the plane *is* that
		// floor's walking surface and the hole is painted there. A void is an atrium drawn
		// on a storey's plan, which is where the heatmap reads it and what `slabIsVoid`'s
		// own comment states; reading the floor *below* the slab instead tests a plan the
		// user never painted.
		const owner = input.floors[p];
		if (!owner?.slice.roomTypes) continue;
		out.push({
			t,
			lossShare: total > 0 ? (applied[p - loFloor] ?? 0) / total : 0,
			roomTypes: owner.slice.roomTypes,
			width: owner.slice.width,
			height: owner.slice.height,
			originX: owner.slice.originX,
			originY: owner.slice.originY
		});
	}
	// Ordered as the ray meets them — the order `crossFloorSplit`'s two ends are in, and
	// the order a reader expects: downward that is top-down, upward bottom-up.
	out.sort((a, b) => a.t - b.t);
	return out.length > 0 ? out : null;
}

/**
 * A storey boundary past the first contributes only this much, however thick its slab
 * is — ITU-R P.1238 measures multi-slab isolation levelling off, because signal
 * escapes around the building. Mirrors `ADDITIONAL_FLOOR_DB` in
 * `state/floor-state.svelte.ts`; the two have to agree or the shares would not sum to
 * the loss the path is charged.
 */
export const ADDITIONAL_FLOOR_DB = 5;
