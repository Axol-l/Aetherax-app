/**
 * The plan's rooms: one derivation, for everyone who has to agree about which room is which.
 *
 * "Which regions are rooms" is answered in seven places — the placement domain, the coverage
 * sample set, the density map, the click guard, the worker's verifier, the worker's wall band
 * and the canvas's own room labels. They all ask the same question and they were answering it
 * with different parameters, which produced *different partitions of the same plan, numbered
 * differently*. `roomDensityOverrides` is keyed by those numbers, so a density the user set on
 * a room was read back by the optimiser against whatever room happened to carry that ordinal
 * in its own partition — or against nothing at all.
 *
 * The parameters live here now, once. What a caller may still choose is the one thing that
 * genuinely differs between them: whether the wall-adjacent pixels are trimmed. The placement
 * domain trims (an access point against a wall face is not a placement); the picture and the
 * density map do not (a room on screen is the room that was drawn, and the density of the
 * pixels hugging a wall is still the density of the room they are in). Everything else — the
 * working resolution, the close radius, the minimum room radius — is shared, because a
 * difference in any of them renumbers the plan.
 *
 * What this deliberately does not do: it does not make the ids *stable* across edits. They are
 * ordinals from a scan of the interior, so drawing a wall can renumber the rooms — that is what
 * the pixel-addressed `roomTypeMask` is for, and it is why an override belongs to a room rather
 * than to a position. Making them stable needs a geometric key and a change to the persisted
 * project format; nothing here does that.
 */
import { computeBuildingInterior } from './morphology.js';
import { labelRooms } from './region-labels.js';

export interface RoomDomain {
	/** Walkable floor: inside the building, cavities below the minimum radius removed. */
	interior: Uint8Array;
	/** Region id per pixel, or −1 outside every room. */
	labels: Int32Array;
	/** How many distinct rooms the labels contain. */
	regionCount: number;
}

export interface RoomDomainOptions {
	/**
	 * Smallest inscribed radius a region may have and still be a room, in mask pixels.
	 *
	 * Every caller converts the same metre figure (`MIN_ROOM_RADIUS_M`) with its own
	 * calibration, so this is the one parameter that legitimately differs with the scale of
	 * the drawing rather than with the caller.
	 */
	minRegionRadius: number;
	/**
	 * Whether to trim the pixels touching a wall.
	 *
	 * True for the placement domain and for anything that verifies a placement against it —
	 * false for the picture and for the density map, which are both about the room the user
	 * drew. The two families must each be internally consistent; mixing them renumbers rooms.
	 */
	trimWallAdjacent: boolean;
}

/** The rooms of one plan. */
export function buildRoomDomain(
	wallData: Uint8Array,
	width: number,
	height: number,
	options: RoomDomainOptions
): RoomDomain {
	const { interior } = computeBuildingInterior(wallData, width, height, {
		// The working resolution both detectors rasterise to, so the same plan gives the same
		// partition whatever it was read from.
		maxDim: 400,
		dilateRatio: 0.04,
		// Seals door-sized gaps in an outline without closing a real corridor.
		minDilateR: 4,
		trimWallAdjacent: options.trimWallAdjacent,
		minRegionRadius: Math.max(0, options.minRegionRadius)
	});
	const { labels, regionCount } = labelRooms(interior, width, height);
	return { interior, labels, regionCount };
}
