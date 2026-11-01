/**
 * The sources a floor's heatmap is drawn from.
 *
 * A heatmap is not only the floor's own access points: every AP on every other storey
 * contributes through the slab, as a fixed source with its path split at the crossing and
 * the crossed slab's room types attached. That assembly used to live inside `CanvasView`,
 * where the single-floor view and the tiled overview could not both reach it, and where the
 * dependency list that has to invalidate it sat next to forty effects that did not.
 *
 * It is a function of the floor state and the AP list only, so it lives here:
 *
 *   `trackHeatmapInputs()`   reads everything the result depends on, for an effect to track
 *   `heatmapApsForFloor(id)` builds the source list for one floor
 *
 * `HeatmapSourceAp` is the shape the layer consumes — an `AccessPoint` with the extra terms
 * a cross-floor source needs, all in world units except the slab figures.
 */
import type { Band } from '@aetherax/channels';
import type { WallMaterialId } from '$lib/domain/materials.js';
import { apState, apSplitFor, apVerticalOffsetTo } from '$state/ap-state.svelte.js';
import { floorState, getFloorSlabAttenuation } from '$state/floor-state.svelte.js';
import { getFloorMask } from '$state/floor-mask.js';
import { projectMeta } from '$state/project-meta.svelte.js';

/** An AP as the heatmap takes it: this floor's own, or another floor's as a fixed source. */
export type HeatmapSourceAp = (typeof apState.aps)[0] & {
	verticalOffset?: number;
	floorDbPerMeter?: number;
	floorThickness?: number;
	crossFloor?: {
		mask: { data: Uint8Array; width: number; height: number; originX: number; originY: number };
		materialMap: Uint8Array | null;
		defaultMaterial: WallMaterialId;
		sourceT: number;
		targetT: number;
		slabRoomType: {
			data: Uint8Array;
			width: number;
			height: number;
			originX: number;
			originY: number;
		} | null;
		slabT: number;
	} | null;
};

/**
 * Everything the heatmap's AP list reads.
 *
 * Both effects that must re-run when any of it changes call this, so the dependency list
 * lives in one place rather than being spread over two. The reads are deliberate: an
 * effect that calls this re-runs when any of them changes, and `void` is how a dependency
 * is expressed without a value.
 */
export function trackHeatmapInputs(): void {
	void floorState.currentFloorId;
	for (const f of floorState.floors) {
		void f.ceilingHeight;
		void f.floorThickness;
		void f.floorMaterial;
		void f.level;
		// Calibration is per floor and the coverage image's metres-per-world-unit
		// comes from it, so re-calibrating any floor invalidates the tiles.
		void f.calibration?.worldUnitsPerMeter;
		// Masks are inputs too: an AP's own floor's walls are half of a
		// cross-floor path, and editing or aligning that floor moves them.
		void f.wallMask?.dataUrl;
		void f.wallMask?.originX;
		void f.wallMask?.originY;
		void f.materialMask?.dataUrl;
		// Room types carry the voids, and a void is a hole in the slab.
		void f.roomTypeMask?.dataUrl;
		void f.wallMaterial;
	}
	for (const ap of apState.aps) {
		void ap.x;
		void ap.y;
		void ap.band;
		void ap.channelWidth;
		void ap.interferenceRadius;
		void ap.assignedChannel;
		void ap.power;
		void ap.floorId;
		// Where the AP is mounted is part of every path's geometry once the
		// project models it, and the layer's own cache key carries the vertical
		// offset it produces — so a change here has to rebuild the source list,
		// not just the image.
		void ap.mountHeightM;
		/*
		 * The antenna's own cuts are part of the pattern the layer draws, so a
		 * change to them has to rebuild the source list: the layer's cache key
		 * carries `antennaSignature`, but a key is only re-read when something
		 * marks the canvas dirty.
		 */
		void ap.beamwidthDeg;
		void ap.aimDeg;
		void ap.facingDeg;
	}
	void projectMeta.clientHeight;
}

/**
 * Every source that contributes to one floor's heatmap.
 *
 * The floor's own APs at full power, plus each other floor's APs as fixed sources
 * attenuated by the slab(s) between — with the wall split at each slab crossing
 * and the crossed slab's room types attached, so a void can waive the slab loss.
 *
 * Shared by the single-floor view and the tiled overview, which is the point: the
 * tiled overview used to hand `generateFor` only the floor's own APs, so a storey
 * with none of its own — an empty floor above a busy one — drew no heat at all
 * even with APs directly below it, and a floor with APs ignored every neighbour.
 */
export async function heatmapApsForFloor(floorId: string): Promise<HeatmapSourceAp[]> {
	const cur = floorState.floors.find((f) => f.id === floorId);
	if (!cur) return [];

	// Current floor's APs (full power). A same-floor path is flat while the
	// project leaves mounting heights off — `apVerticalOffsetTo` returns 0 — and
	// the AP-to-client height difference once they are on, which is the same
	// term the optimiser and the worker use.
	const localAps = apState.aps
		.filter((ap) => ap.floorId === floorId)
		.map((ap) => ({
			...ap,
			verticalOffset: apVerticalOffsetTo(ap, floorId, projectMeta.clientHeight)
		}));

	// Virtual APs from ALL other floors (attenuated through each slab between)
	const otherFloors = floorState.floors.filter((f) => f.id !== floorId);
	const sortedFloors = [...floorState.floors].sort((a, b) => a.level - b.level);
	const virtualAps: Array<
		HeatmapSourceAp & {
			/** Floor this AP sits on; its mask is fetched after the first await. */
			sourceFloorId: string;
			sourceT: number;
			targetT: number;
			/**
			 * Which of the two floors owns the slab this path crosses, or null when
			 * the gap is more than one storey (several slabs, none modelled).
			 */
			slabOwner: 'source' | 'target' | null;
			slabT: number;
		}
	> = [];
	for (const adj of otherFloors) {
		const adjAps = apState.aps.filter((ap) => ap.floorId === adj.id);
		if (adjAps.length === 0) continue;

		// Total slab thickness between the two floors, so the heatmap can be
		// handed a dB-per-metre figure. `apVerticalOffsetTo` supplies the vertical
		// term: it accounts for where the AP is actually mounted and the client
		// being `clientHeight` above its floor, which the hand-rolled sum that
		// used to be here did not.
		const loLevel = Math.min(cur.level, adj.level);
		const hiLevel = Math.max(cur.level, adj.level);
		let totalSlabThickness = 0;
		for (const f of sortedFloors) {
			if (f.level < loLevel || f.level >= hiLevel) continue;
			const upperIdx = sortedFloors.findIndex((s) => s.level === f.level + 1);
			if (upperIdx >= 0) {
				// The thickness counts whichever material the slab is: the dB figure
				// comes from `getFloorSlabAttenuation`, which has its own fallback for
				// a material id it does not know. Skipping the thickness when that
				// lookup failed left the heatmap with no slab loss at all while the
				// optimiser charged its fallback 20 dB.
				totalSlabThickness += sortedFloors[upperIdx]!.floorThickness;
			}
		}
		// A void is a hole in the *upper* floor's slab. Only a one-storey gap has a
		// single slab to test; a taller one crosses several and the aggregate dB
		// stands.
		const oneStorey = Math.abs(adj.level - cur.level) === 1;
		const slabOwner: 'source' | 'target' | null = !oneStorey
			? null
			: adj.level > cur.level
				? 'source'
				: 'target';

		for (const ap of adjAps) {
			const totalDb = getFloorSlabAttenuation(floorId, adj.id, ap.band as Band);
			// Both of these are per AP: where the access point is mounted decides
			// how far it is from the client and where its ray meets the floor
			// planes, and two APs on one storey need not be mounted alike.
			const totalVertGap = apVerticalOffsetTo(ap, floorId, projectMeta.clientHeight);
			// Where this floor's rays change floors, so the wall loss can be charged
			// to the floor each run actually passes through.
			const split = apSplitFor(ap, floorId, projectMeta.clientHeight);
			// The crossing nearest the client is where the slab is penetrated.
			const slabT = split.targetT > 0 ? split.targetT : split.sourceT;
			virtualAps.push({
				...ap,
				id: `virtual-${ap.id}`,
				verticalOffset: totalVertGap,
				floorDbPerMeter: totalSlabThickness > 0 ? totalDb / totalSlabThickness : 0,
				floorThickness: totalSlabThickness,
				sourceFloorId: adj.id,
				sourceT: split.sourceT,
				targetT: split.targetT,
				slabOwner,
				slabT
			});
		}
	}

	const allAps: HeatmapSourceAp[] = [...localAps, ...virtualAps];

	// This floor's own masks: the grid the room type ids are read on, and the room
	// types themselves for the case where this floor owns the crossed slab.
	const self = await getFloorMask(floorId);

	// Resolving a source floor's mask needs a decode, so the list is published once
	// it is resolved rather than twice.
	return Promise.all(
		allAps.map(async (ap) => {
			const extra = ap as HeatmapSourceAp & {
				sourceFloorId?: string;
				sourceT?: number;
				targetT?: number;
				slabOwner?: 'source' | 'target' | null;
				slabT?: number;
			};
			const sourceFloorId = extra.sourceFloorId;
			if (!sourceFloorId) return ap;
			const decoded = await getFloorMask(sourceFloorId);
			if (!decoded) return { ...ap, crossFloor: null };
			const srcFloor = floorState.floors.find((f) => f.id === sourceFloorId);
			// Room types of the floor whose slab the path crosses. A void there
			// is a hole, so the slab loss is waived at that crossing. The AP's
			// floor owns the slab when it is the upper one; otherwise it is this
			// floor's own, whose room types share this mask's grid.
			let slabRoomType: {
				data: Uint8Array;
				width: number;
				height: number;
				originX: number;
				originY: number;
			} | null = null;
			if (extra.slabOwner === 'source' && decoded.roomTypeData) {
				slabRoomType = {
					data: decoded.roomTypeData,
					width: decoded.width,
					height: decoded.height,
					originX: decoded.originX,
					originY: decoded.originY
				};
			} else if (extra.slabOwner === 'target' && self?.roomTypeData) {
				slabRoomType = {
					data: self.roomTypeData,
					width: self.width,
					height: self.height,
					originX: 0,
					originY: 0
				};
			}
			return {
				...ap,
				crossFloor: {
					mask: {
						data: decoded.wallData,
						width: decoded.width,
						height: decoded.height,
						originX: decoded.originX,
						originY: decoded.originY
					},
					materialMap: decoded.materialMap,
					defaultMaterial: (srcFloor?.wallMaterial ?? 0) as WallMaterialId,
					sourceT: extra.sourceT ?? 0,
					targetT: extra.targetT ?? 0,
					slabRoomType,
					slabT: extra.slabT ?? 0
				}
			};
		})
	);
}
