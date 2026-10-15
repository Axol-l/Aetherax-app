import type { Band, ChannelWidth, RegulatoryDomain } from '@aetherax/channels';
import { pushState } from './history.svelte.js';
import { scheduleSave } from './persistence.svelte.js';
import { rangeFromPower } from '../rf/propagation.js';
import { crossFloorSplitFor, crossFloorVerticalGap, floorState, getFloor } from './floor-state.svelte.js';
import { projectMeta } from './project-meta.svelte.js';
import {
	antennaFloorDb,
	antennaProfileForMount,
	defaultAntenna,
	normaliseBearing,
	type AntennaProfile
} from '../rf/antenna.js';

/**
 * Where an access point is mounted, as far as the *height* is concerned.
 *
 * Three values, and the third is not just another default height: a wall-mounted
 * unit radiates into the room from a wall, so it has a **plan direction** as well as
 * a height, and it has to sit on a wall to mean anything (`facingDeg`, and the
 * placement rule in the canvas). The other two are azimuth-free — an upright omni is
 * a doughnut about its own axis, so the direction it faces does not exist — which is
 * why `facingDeg` is only read for a wall mount.
 */
export type ApMount = 'ceiling' | 'floor' | 'wall';

/** A mounting height in metres above the floor it is mounted on. */
export interface MountPreset {
	mount: ApMount;
	label: string;
	/**
	 * Height of the preset, or null when it follows the storey — a ceiling mount is
	 * only meaningful relative to the ceiling it hangs from.
	 */
	metres: number | null;
}

/**
 * The mounting presets, in the order the interface lists them.
 *
 * A ceiling mount hangs just *below* the slab rather than inside it, so its
 * preset is the storey's own ceiling height less a drop. That is also what the
 * model assumed before mounting heights existed, which is why the ceiling is the
 * default: an access point sitting on a desk has to be stated by the user, and
 * one on the ceiling is the one they almost always mean.
 */
export const MOUNT_PRESETS: readonly MountPreset[] = [
	{ mount: 'ceiling', label: 'Ceiling mount', metres: null },
	{ mount: 'floor', label: 'Floor mount', metres: 0.8 },
	// A bracket on a wall, at the height brackets are normally fitted at — high enough
	// to clear furniture and the people who walk past it, below the ceiling. The height
	// stays editable; the direction is `facingDeg` and is not part of the preset.
	{ mount: 'wall', label: 'Wall mount', metres: 2 }
];

/** How far below the slab a ceiling-mounted access point hangs, in metres. */
export const CEILING_MOUNT_DROP_M = 0.1;

/**
 * The height a preset means on a storey of this ceiling height, in metres.
 *
 * A ceiling mount is the only preset that depends on the storey, so it is the
 * only one that needs the height passed in — and it is also why the stored
 * `mountHeightM` cannot be derived on the fly: a user who types 2.6 m into the
 * field means 2.6 m, not "the ceiling, whatever that turns out to be".
 */
export function defaultMountHeight(mount: ApMount, ceilingHeightM: number): number {
	const preset = MOUNT_PRESETS.find((p) => p.mount === mount) ?? MOUNT_PRESETS[0]!;
	const metres = preset.metres ?? ceilingHeightM - CEILING_MOUNT_DROP_M;
	// Never below the floor or through the slab above it.
	return Math.min(Math.max(metres, 0), Math.max(ceilingHeightM, 0));
}

export interface AccessPoint {
	id: string;
	name: string;
	x: number;
	y: number;
	band: Band;
	channelWidth: ChannelWidth;
	fixedChannel: number | null;
	assignedChannel: number | null;
	interferenceRadius: number;
	power: number;
	modelId: string | null;
	modelLabel: string | null;
	floorId: string;
	/**
	 * Where the AP is mounted, and how high above its floor's walking surface.
	 *
	 * Both are stored, and always modelled: the height is the AP's own position in
	 * the building, not an optional refinement. `mount` is the preset it was last
	 * set from and drives which label the editor shows; the height is what the
	 * models read.
	 */
	mount: ApMount;
	mountHeightM: number;
	/**
	 * The antenna's vertical cut: its −3 dB beamwidth and where its peak points.
	 *
	 * Two numbers rather than a named antenna, because an indoor access point is an
	 * upright omni whose horizontal plane is nearly flat — the vertical plane is the
	 * one that decides anything (see `rf/antenna.ts`). Both are stored per AP: the
	 * band sets what a new one starts at, and a user who knows their hardware can
	 * say what it really is. A beamwidth of 180° is a flat profile, which is how
	 * "no vertical pattern" is expressed without a mode.
	 */
	beamwidthDeg: number;
	aimDeg: number;
	/**
	 * Which way a **wall-mounted** unit faces, in degrees in the plan: 0 is +x,
	 * positive turns towards +y (the same sense as `atan2`). Ignored by the other two
	 * mounts, which have no direction to have.
	 *
	 * Stored, not derived, for the same reason the height is: the nearest wall can
	 * suggest a direction (and does, when a wall-mounted AP is placed or dragged), but
	 * a user who knows the unit looks down the corridor means that, not whatever wall
	 * happens to be nearest.
	 */
	facingDeg: number;
	/**
	 * Whether the optimiser must leave this access point exactly where it is.
	 *
	 * A placement is sometimes not the optimiser's to choose: an AP that is already
	 * installed, one on a listed mounting point, or the one a survey was taken around.
	 * A pinned AP is still a full part of the model — it is scored, it serves clients,
	 * it is coloured — it just does not move. Distinct from `fixedChannel`, which pins
	 * a *channel*: the two are independent, and pinning one says nothing about the
	 * other.
	 */
	pinned: boolean;
}

let nextApNumber = 1;

function createId(): string {
	return crypto.randomUUID();
}

/** Default scale when no floorplan is calibrated (~10 world units per foot). */
export const DEFAULT_WUPM = 10 * 3.28084;

/**
 * World units per metre for the **project**.
 *
 * One scale for every floor, taken from the first floor. Floors of one building
 * share a footprint, so a per-floor scale bought nothing and cost a lot: every
 * consumer (the grid, the AP radii, the coverage image's metres-per-world-unit)
 * had to be told *which* floor's scale to use, and any site that took the
 * selected floor's while rendering another floor produced a different picture
 * per selection. Reads go through here and ignore the other floors' stored
 * values, so an existing project with mismatched floors is unified the moment it
 * loads; writes go through `setProjectCalibration` so the stored data agrees.
 */
export function getEffectiveWupm(): number {
	return floorState.floors[0]?.calibration?.worldUnitsPerMeter ?? DEFAULT_WUPM;
}

/** Derive interference radius (world units) from TX power and band. */
export function radiusFromPower(power: number, band: string): number {
	const meters = rangeFromPower(power, band);
	return Math.round(meters * getEffectiveWupm());
}

/**
 * Recompute every AP's interference radius from its power and band.
 *
 * `interferenceRadius` is a pure function of power, band and world-units-per-metre
 * — every path that sets it goes through `radiusFromPower` — so the stored copy is
 * a cache and refreshing it cannot lose information.
 *
 * It does have to be refreshed on load, because the stored value was computed
 * under whatever the propagation model was at the time, and when the model changes
 * the radii silently keep describing the old one. That happened with the ITU
 * reference-loss correction: a 5 GHz AP's stored radius was 5.6% short of what the
 * new `PL0` implies, which is 1 dB of margin — exactly cancelling the 1 dB the
 * correction was meant to add, so existing APs saw no change at all.
 *
 * Also wanted after a calibration change or a floor switch, since world units per
 * metre is part of the derivation.
 */
export function refreshApRanges(): void {
	for (const ap of apState.aps) {
		ap.interferenceRadius = radiusFromPower(ap.power, ap.band);
	}
}

export const apState = $state({
	band: '5ghz' as Band,
	channelWidth: 20 as ChannelWidth,
	regulatoryDomain: 'fcc' as RegulatoryDomain,
	aps: [] as AccessPoint[]
});

/**
 * The height an access point is modelled at, above its own floor's walking surface.
 *
 * This is the AP's own figure, clamped to its storey — an AP cannot be under the
 * floor or through the slab above it, and both are typos rather than models. Every
 * AP has one: a ceiling mount is not a special case but the preset a new AP
 * starts at, so there is no separate "flat path" model to switch between.
 */
export function apHeightAboveFloor(ap: Pick<AccessPoint, 'floorId' | 'mountHeightM'>): number {
	const ceiling = getFloor(ap.floorId)?.ceilingHeight ?? 0;
	return Math.min(Math.max(ap.mountHeightM, 0), Math.max(ceiling, 0));
}

/**
 * Vertical distance from an access point to a client on `clientFloorId`, metres.
 *
 * One function for both cases, because the two rules are the same rule read at
 * two scales, and having them in one place is what keeps the heatmap, the
 * optimiser and the worker from disagreeing about how far apart two points are:
 *
 * - **Same floor**: the height difference between the AP and the client. A
 *   same-floor path is therefore not flat, and for a ceiling-mounted AP it never
 *   was in reality — only in the model that ignored where the AP hangs.
 * - **Another floor**: the whole geometric gap, from the AP's own height to the
 *   client above its floor, which is what `crossFloorVerticalGap` measures.
 */
export function apVerticalOffsetTo(
	ap: Pick<AccessPoint, 'floorId' | 'mountHeightM'>,
	clientFloorId: string,
	clientHeight: number
): number {
	if (ap.floorId === clientFloorId) {
		return Math.abs(apHeightAboveFloor(ap) - clientHeight);
	}
	return crossFloorVerticalGap(
		ap.floorId,
		clientFloorId,
		clientHeight,
		apHeightAboveFloor(ap)
	);
}

/**
 * Where an access point's cross-floor path changes storeys.
 *
 * The same two fractions `crossFloorSplitFor` computes, from the same geometry,
 * with the AP's own mounting height rather than its storey's ceiling. Kept beside
 * `apVerticalOffsetTo` so every consumer of the vertical geometry — the heatmap,
 * the optimiser, the worker payload — gets both halves of it from one place.
 */
export function apSplitFor(
	ap: Pick<AccessPoint, 'floorId' | 'mountHeightM'>,
	clientFloorId: string,
	clientHeight: number
): { sourceT: number; targetT: number } {
	return crossFloorSplitFor(
		ap.floorId,
		clientFloorId,
		clientHeight,
		apHeightAboveFloor(ap)
	);
}

/**
 * The height a new access point starts at.
 *
 * Carried over from the last AP the user placed, mount and all: a plan is
 * normally described one storey at a time with the same mounting throughout, and
 * re-picking "wall at 1.5 m" for every AP is the kind of repetition that makes a
 * setting go unused.
 */
function initialMount(prev: AccessPoint | null): { mount: ApMount; mountHeightM: number } {
	const mount = prev?.mount ?? 'ceiling';
	const ceiling = getFloor(floorState.currentFloorId)?.ceilingHeight ?? 3;
	return {
		mount,
		mountHeightM: prev ? prev.mountHeightM : defaultMountHeight(mount, ceiling)
	};
}

/**
 * The antenna profile the models use for one access point.
 *
 * The AP stores the numbers a planner can know or look up; the broadside floor comes
 * from the band, because it is a property of the antenna class rather than a knob.
 * The **horizontal** cut comes from the mount: a wall-mounted unit has one, an
 * upright omni does not. One function, so the heatmap, the coverage pass and the
 * worker cannot disagree about an AP's pattern — and so that "a wall mount has a
 * front and a back" is decided in exactly one place.
 */
export function antennaProfileFor(ap: {
	band: string;
	beamwidthDeg: number;
	aimDeg: number;
	mount: ApMount;
	facingDeg: number;
}): AntennaProfile {
	// The mount → horizontal cut rule itself lives in the pure layer, because the
	// optimiser's worker needs it too and cannot import this module.
	return antennaProfileForMount(ap);
}

/**
 * The antenna a new access point starts with: the band's own defaults, level.
 *
 * Carried over from the previous AP when one exists, for the same reason the
 * mounting is: a plan is described with one kind of hardware throughout, and
 * re-typing a beamwidth per AP is how a parameter ends up never being set.
 */
function initialAntenna(
	prev: AccessPoint | null,
	band: string
): { beamwidthDeg: number; aimDeg: number; facingDeg: number } {
	if (prev) {
		return { beamwidthDeg: prev.beamwidthDeg, aimDeg: prev.aimDeg, facingDeg: prev.facingDeg };
	}
	const defaults = defaultAntenna(null, band);
	return { beamwidthDeg: defaults.beamwidthDeg, aimDeg: defaults.aimDeg, facingDeg: 0 };
}

export function addAp(
	x: number,
	y: number,
	/**
	 * Which way the new unit faces, when the mounting it inherits is a wall mount and
	 * the caller could work it out from the wall it was dropped against. Ignored by
	 * the other mounts, and 0 when the caller knows nothing.
	 */
	facingDeg = 0
): AccessPoint {
	pushState();
	const prev: AccessPoint | null =
		apState.aps.length > 0 ? (apState.aps[apState.aps.length - 1] ?? null) : null;
	const mount = initialMount(prev);
	const band = prev?.band ?? apState.band;
	const antenna = initialAntenna(prev, band);

	const ap: AccessPoint = {
		id: createId(),
		name: `AP-${nextApNumber++}`,
		x,
		y,
		band,
		channelWidth: prev?.channelWidth ?? apState.channelWidth,
		fixedChannel: null,
		assignedChannel: null,
		interferenceRadius:
			prev?.interferenceRadius ?? radiusFromPower(prev?.power ?? 20, prev?.band ?? apState.band),
		power: prev?.power ?? 20,
		modelId: prev?.modelId ?? null,
		modelLabel: prev?.modelLabel ?? null,
		floorId: floorState.currentFloorId,
		mount: mount.mount,
		mountHeightM: mount.mountHeightM,
		beamwidthDeg: antenna.beamwidthDeg,
		aimDeg: antenna.aimDeg,
		// A new wall mount on a wall the caller measured takes that wall's direction;
		// otherwise the previous AP's, which is what a run of wall mounts along one
		// corridor wants anyway.
		facingDeg: normaliseBearing(
			mount.mount === 'wall' && facingDeg !== 0 ? facingDeg : antenna.facingDeg
		),
		// A new AP is the optimiser's to place. Pinning is a decision about an AP that
		// already exists, so it is never inherited — carrying it over would silently
		// freeze the next AP the user drops.
		pinned: false
	};
	apState.aps.push(ap);
	scheduleSave();
	return ap;
}

export function removeAp(id: string): void {
	const idx = apState.aps.findIndex((ap) => ap.id === id);
	if (idx !== -1) {
		pushState();
		apState.aps.splice(idx, 1);
		if (apState.aps.length === 0) {
			nextApNumber = 1;
		}
		scheduleSave();
	}
}

export function removeAps(ids: string[]): void {
	pushState();
	const idSet = new Set(ids);
	apState.aps = apState.aps.filter((ap) => !idSet.has(ap.id));
	if (apState.aps.length === 0) {
		nextApNumber = 1;
	}
	scheduleSave();
}

/**
 * Change properties on one access point, and make sure they reach storage.
 *
 * The save is here rather than at the call sites because there are a dozen of
 * them — the editor's fields, the solver's channel assignment, the optimiser's
 * power pass — and none of them is a place where "and remember it" can be
 * forgotten. It used to be missing entirely: an AP's band, power or mounting
 * reached storage only when something *else* happened to save, which in practice
 * meant the auto-solver. Turn that off, or edit while a solve is in flight, and
 * the change was in the session and gone at the next reload.
 *
 * `keep` rather than a plain schedule, because most of those callers are
 * *background* writers: the automatic solver assigns channels on every solve, and
 * a plain schedule there restarts the timer a user's own edit set, which is how a
 * freshly placed access point stayed unsaved for as long as the solver kept
 * running. A pending save reads the live state when it fires, so letting it stand
 * still persists this change — it just does not push the write back.
 */
export function updateAp(id: string, changes: Partial<AccessPoint>): void {
	const ap = apState.aps.find((a) => a.id === id);
	if (ap) {
		Object.assign(ap, changes);
		scheduleSave(true);
	}
}

export function beginMove(): void {
	pushState();
}

export function moveAp(id: string, x: number, y: number): void {
	const ap = apState.aps.find((a) => a.id === id);
	if (ap) {
		ap.x = x;
		ap.y = y;
	}
}

/**
 * Turn an access point, without scheduling a save.
 *
 * The companion of `moveAp`, and for the same reason: a drag writes both on every
 * pointer move — a wall-mounted unit follows the wall it is on — and the save is
 * scheduled once, when the pointer comes up.
 */
export function faceAp(id: string, facingDeg: number): void {
	const ap = apState.aps.find((a) => a.id === id);
	if (ap) ap.facingDeg = normaliseBearing(facingDeg);
}

export function clearAssignments(): void {
	for (const ap of apState.aps) {
		ap.assignedChannel = null;
	}
}

/** Reset AP numbering (called on project clear). */
export function resetApNumbering(): void {
	nextApNumber = 1;
}
