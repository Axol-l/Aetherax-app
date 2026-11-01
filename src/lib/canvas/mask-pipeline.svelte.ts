/**
 * The wall/material/room raster the canvas draws and its click handling reads.
 *
 * Three things happen to a floor's masks, and all three used to live in `CanvasView`
 * between forty effects:
 *
 * - **decode**: a stored PNG data URL becomes pixels, blob labels, an interior and room
 *   labels — asynchronously, with a version guard so a superseded floor cannot publish;
 * - **publish**: the wall editor rasterises its segments and hands the result over — the
 *   pixels, not a data URL, because the decode effect would skip a URL it has already seen;
 * - **reset**: a floor switch drops everything so the previous floor's raster cannot be
 *   drawn or clicked for a frame.
 *
 * The component keeps the *effects* (it is the thing that knows when state changed) and
 * this class keeps the cache and the asynchronous work. `apWallMask` is `$state` because
 * the annotation effect reacts to it; the rest are plain fields, read by the click
 * handlers, and a change to them is always accompanied by a `markDirty()`.
 *
 * Not here: the distance transform for the AP annotations (`wall-distance.ts` is its own
 * cache, keyed on `revision`), and the wall-segment rasteriser (that is model work, in
 * `state/wall-raster.ts`).
 */
import { debug } from '$lib/log.js';
import type { HeatmapLayer } from './renderers/heatmap.js';
import type { RoomLabelsLayer } from './renderers/room-labels.js';
import type { WallLayer } from './renderers/walls.js';
import { buildRoomDomain } from './rooms.js';
import {
	decodeMaterialMask,
	encodeMaterialMask,
	labelWallBlobs,
	type RegionLabels
} from './region-labels.js';
import { encodeMask, decodeMask, type DecodedWallMask } from './wall-detect.js';
import { floorState, currentFloor } from '$state/floor-state.svelte.js';
import { floorplanState } from '$state/floorplan-state.svelte.js';
import { wallState } from '$state/wall-state.svelte.js';
import { invalidateSolverMaskCache } from '$state/floor-mask.js';
import { updateCoverage } from '$state/optimizer.svelte.js';
import { scheduleSave } from '$state/persistence.svelte.js';
import { minRoomRadiusWu } from '$state/room-domain.js';

/** A raster produced by the wall editor or the segment rasteriser. */
export interface MaterialisedMask {
	data: Uint8Array;
	materialData: Uint8Array | null;
	width: number;
	height: number;
	originX: number;
	originY: number;
}

export interface MaskLayers {
	wallLayer: WallLayer | null;
	heatmapLayer: HeatmapLayer | null;
	roomLabelsLayer: RoomLabelsLayer | null;
}

export interface MaskPipelineHost {
	/** The live layers; null until the canvas has mounted its engine. */
	layers(): MaskLayers;
	markDirty(): void;
}

export class MaskPipeline {
	/**
	 * The decoded raster the AP annotations measure against.
	 *
	 * `$state` because it lands from a promise: the annotation effect has to re-run when it
	 * arrives. It is written only from callbacks, never from inside the effect that reads
	 * it, or that effect would re-run itself.
	 */
	apWallMask = $state<DecodedWallMask | null>(null);
	/** Bumped on every publication: the distance transform's cache key. */
	revision = 0;

	/** The decoded rasters and labels, read by the wall/room click handlers. */
	wallData: Uint8Array | null = null;
	materialData: Uint8Array | null = null;
	wallLabels: RegionLabels | null = null;
	interior: Uint8Array | null = null;
	roomLabels: RegionLabels | null = null;
	roomTypeData: Uint8Array | null = null;
	originX = 0;
	originY = 0;

	/**
	 * Bumped whenever the wall mask is replaced.
	 *
	 * Read by the auto-solve key. Plain rather than `$state` on purpose: it is a cache
	 * invalidator read inside a derivation that already tracks the mask's own state, and
	 * making it reactive re-armed the solver on its own writes.
	 */
	maskVersion = 0;

	private wallUrl: string | null = null;
	private materialUrl: string | null = null;
	private keyOriginX = Number.NaN;
	private keyOriginY = Number.NaN;
	private roomTypeUrl: string | null = null;
	/** Guards the asynchronous decodes against a superseded floor or mask. */
	private version = 0;

	constructor(private readonly host: MaskPipelineHost) {}

	/**
	 * Decode the current floor's wall and material masks, if the state changed.
	 *
	 * Call from an `$effect` with no arguments: this method reads `wallState` synchronously
	 * before its first `await`, which is what makes the effect depend on it.
	 */
	syncWallMask(): void {
		const { wallLayer, heatmapLayer } = this.host.layers();
		if (!wallLayer || !heatmapLayer) return;

		const mask = wallState.wallMask;
		const materialMask = wallState.materialMask;

		// Skip re-decode if the data URLs and the origin are all unchanged. The origin
		// matters because aligning a floor moves the mask without changing a single pixel.
		const wallUrl = mask?.dataUrl ?? null;
		const materialUrl = materialMask?.dataUrl ?? null;
		const originX = mask?.originX ?? 0;
		const originY = mask?.originY ?? 0;
		if (
			wallUrl === this.wallUrl &&
			materialUrl === this.materialUrl &&
			originX === this.keyOriginX &&
			originY === this.keyOriginY &&
			this.wallData
		) {
			return;
		}
		this.wallUrl = wallUrl;
		this.materialUrl = materialUrl;
		this.keyOriginX = originX;
		this.keyOriginY = originY;

		debug(
			`[walls] decode start: mask ${mask?.width ?? 0}x${mask?.height ?? 0} at ${originX},${originY}`
		);

		this.maskVersion++;
		invalidateSolverMaskCache();
		const thisVersion = ++this.version;

		if (!mask) {
			wallLayer.mask = null;
			heatmapLayer.wallMask = null;
			// There is no mask coming: this floor has no plan, so a wall-less heatmap is
			// the real answer and must not be suppressed.
			heatmapLayer.maskPending = false;
			this.clearCaches();
			const { roomLabelsLayer } = this.host.layers();
			if (roomLabelsLayer) {
				roomLabelsLayer.roomTypeData = null;
				roomLabelsLayer.roomLabels = null;
				roomLabelsLayer.invalidateCache();
			}
			this.host.markDirty();
			return;
		}

		const wallPromise = decodeMask(mask.dataUrl, mask.width, mask.height);
		const materialPromise = materialMask
			? decodeMaterialMask(materialMask.dataUrl, materialMask.width, materialMask.height)
			: null;

		wallPromise
			.then(async (decoded) => {
				if (this.version !== thisVersion) return;
				const materialData = materialPromise ? await materialPromise : null;
				if (this.version !== thisVersion) return;

				// Propagate the stored origin to the decoded mask, snapped to whole pixels.
				// The origin comes from the alignment offset, which is
				// `dragDistance / zoom` and therefore fractional, but it is used as a pixel
				// address: the renderer places the raster at it and every kernel reads it at
				// it, so the two have to agree on one integer.
				decoded.originX = Math.round(mask.originX ?? 0);
				decoded.originY = Math.round(mask.originY ?? 0);

				const layers = this.host.layers();
				const defaultMaterial = wallState.wallMaterial;
				wallLayer.mask = decoded;
				wallLayer.materialMap = materialData ?? null;
				wallLayer.defaultMaterial = defaultMaterial;
				heatmapLayer.wallMask = decoded;
				heatmapLayer.materialMap = materialData ?? null;
				heatmapLayer.defaultMaterial = defaultMaterial;
				heatmapLayer.wallAttenuation = wallState.wallAttenuation;
				// The mask it was waiting for is here, so generation may proceed.
				heatmapLayer.maskPending = false;
				this.setApWallMask(decoded);

				this.wallData = decoded.data;
				this.originX = decoded.originX;
				this.originY = decoded.originY;
				this.wallLabels = labelWallBlobs(decoded.data, decoded.width, decoded.height);
				this.materialData = materialData ?? null;

				// The rooms of this plan, from the one derivation everyone shares. The ids this
				// produces are the ids a click on the canvas writes into `roomDensityOverrides`,
				// and the optimiser reads them back against its own copy of the same partition
				// — so these parameters are not a local choice. See `canvas/rooms.ts`.
				const domain = buildRoomDomain(
					decoded.data,
					decoded.width,
					decoded.height,
					{ minRegionRadius: minRoomRadiusWu(), trimWallAdjacent: false }
				);
				this.interior = domain.interior;
				this.roomLabels = { labels: domain.labels, regionCount: domain.regionCount };

				// Decode room type mask if persisted
				const roomTypeMask = wallState.roomTypeMask;
				if (
					roomTypeMask &&
					roomTypeMask.width === decoded.width &&
					roomTypeMask.height === decoded.height
				) {
					const roomTypeData = await decodeMaterialMask(
						roomTypeMask.dataUrl,
						roomTypeMask.width,
						roomTypeMask.height
					);
					if (this.version !== thisVersion) return;
					this.roomTypeData = roomTypeData;
				} else {
					this.roomTypeData = null;
				}

				// Feed room data to renderer
				if (layers.roomLabelsLayer) {
					layers.roomLabelsLayer.roomTypeData = this.roomTypeData;
					layers.roomLabelsLayer.roomLabels = this.roomLabels;
					layers.roomLabelsLayer.maskWidth = decoded.width;
					layers.roomLabelsLayer.maskHeight = decoded.height;
					layers.roomLabelsLayer.originX = decoded.originX;
					layers.roomLabelsLayer.originY = decoded.originY;
					layers.roomLabelsLayer.densityOverrides = currentFloor().roomDensityOverrides;
					layers.roomLabelsLayer.customLabels = currentFloor().roomCustomLabels ?? {};
					layers.roomLabelsLayer.invalidateCache();
				}

				this.host.markDirty();
			})
			.catch((err) => {
				// Without this the chain failed silently, so a plan whose walls never
				// appeared arrived with no explanation of why the decode never finished.
				console.error(
					'[walls] floorplan decode failed. The plan then has no walls to measure ' +
						'against, so coverage and the heatmap read as empty rather than as wrong.',
					err
				);
			});
	}

	/**
	 * Decode the room type mask on its own.
	 *
	 * Its own effect because it changes independently of the wall mask — assigning a room
	 * type, undo/redo, a floor switch that restores it — and re-decoding the whole wall
	 * raster for a label change would cost far more than it is worth.
	 */
	syncRoomTypes(): void {
		const { roomLabelsLayer } = this.host.layers();
		if (!roomLabelsLayer) return;

		const roomTypeMask = wallState.roomTypeMask;
		const roomTypeUrl = roomTypeMask?.dataUrl ?? null;
		if (roomTypeUrl === this.roomTypeUrl) return;
		this.roomTypeUrl = roomTypeUrl;

		const mask = wallState.wallMask;
		if (
			!roomTypeMask ||
			!mask ||
			roomTypeMask.width !== mask.width ||
			roomTypeMask.height !== mask.height
		) {
			this.roomTypeData = null;
			roomLabelsLayer.roomTypeData = null;
			roomLabelsLayer.invalidateCache();
			this.host.markDirty();
			return;
		}

		decodeMaterialMask(roomTypeMask.dataUrl, roomTypeMask.width, roomTypeMask.height).then(
			(roomTypeData) => {
				// Stale: a newer mask arrived while this one was decoding.
				if (wallState.roomTypeMask?.dataUrl !== roomTypeMask.dataUrl) return;
				this.roomTypeData = roomTypeData;
				roomLabelsLayer.roomTypeData = roomTypeData;
				roomLabelsLayer.roomLabels = this.roomLabels;
				roomLabelsLayer.densityOverrides = currentFloor().roomDensityOverrides;
				roomLabelsLayer.customLabels = currentFloor().roomCustomLabels ?? {};
				roomLabelsLayer.invalidateCache();
				this.host.markDirty();
			}
		);
	}

	/**
	 * Publish a materialised raster as the floor's wall mask.
	 *
	 * One routine because the mask is not just a data URL: the layers draw the pixels that
	 * were just written (the decode effect would skip a URL it has already seen), the
	 * material popup needs the blob labels, the room types need the interior, and the
	 * solver's decoded copy is now stale.
	 */
	publish(mat: MaterialisedMask): boolean {
		const { data, materialData, width, height, originX, originY } = mat;

		// The mask is encoded whole on every edit, so its extent is worth watching. A mask
		// far larger than any building is a bounds bug, not a large plan, and the symptom is
		// the whole layer disappearing once the canvas size limit is passed.
		if (width > 8000 || height > 8000) {
			console.warn(
				`[walls] mask is ${width}x${height} at origin ${originX},${originY}. ` +
					'That is larger than any floorplan; expect slow edits and, past the ' +
					'canvas size limit, a failed encode that wipes the layer.'
			);
		}

		this.apply(mat);

		const wallUrl = encodeMask(data, width, height);
		const materialUrl = materialData ? encodeMaterialMask(materialData, width, height) : null;

		// Update URLs and pre-set the decode keys so the async decode effect skips a
		// re-decode of work that is already on screen.
		wallState.wallMask = { dataUrl: wallUrl, width, height, originX, originY };
		this.wallUrl = wallUrl;
		if (materialUrl) {
			wallState.materialMask = { dataUrl: materialUrl, width, height, originX, originY };
			this.materialUrl = materialUrl;
		} else if (wallState.materialMask) {
			// No material pixels left. Keeping the old material mask around means the next
			// decode reads it back and the assignments reappear.
			wallState.materialMask = null;
			this.materialUrl = null;
		}

		// Recompute blob labels so click-to-override works on the edited walls
		this.wallLabels = labelWallBlobs(data, width, height);

		// Rooms, from the same derivation as the decode path above — the ids a click writes
		// into `roomDensityOverrides` have to be the ids the optimiser reads them back with.
		const domain = buildRoomDomain(data, width, height, {
			minRegionRadius: minRoomRadiusWu(),
			trimWallAdjacent: false
		});
		this.interior = domain.interior;
		this.roomLabels = { labels: domain.labels, regionCount: domain.regionCount };

		// Room type data may need resizing if the mask dimensions changed
		if (this.roomTypeData && this.roomTypeData.length !== width * height) {
			this.roomTypeData = null;
			wallState.roomTypeMask = null;
		}

		const { roomLabelsLayer } = this.host.layers();
		if (roomLabelsLayer) {
			roomLabelsLayer.roomLabels = this.roomLabels;
			roomLabelsLayer.roomTypeData = this.roomTypeData;
			roomLabelsLayer.maskWidth = width;
			roomLabelsLayer.maskHeight = height;
			roomLabelsLayer.originX = originX;
			roomLabelsLayer.originY = originY;
			roomLabelsLayer.invalidateCache();
		}

		// Trigger a re-solve: `maskVersion` is part of the auto-solve key.
		this.maskVersion++;
		invalidateSolverMaskCache();

		this.host.layers().heatmapLayer?.markWallsDirty();
		this.host.markDirty();
		// The walls are what decides what the floor covers, so the figure is re-measured
		// rather than left standing from the geometry that was just replaced.
		void updateCoverage();
		scheduleSave();
		return true;
	}

	/**
	 * Drop everything derived from the current floor's masks.
	 *
	 * Called on a floor switch: the incoming floor's mask is about to be decoded, and the
	 * outgoing floor's raster must not be drawn — or clicked — in the meantime. The
	 * renderer references are cleared eagerly for that reason.
	 */
	reset(): void {
		this.wallUrl = null;
		this.materialUrl = null;
		this.roomTypeUrl = null;
		// The origin markers are part of the same cache key and have to be cleared with the
		// URLs, or the decode compares a fresh mask's origin against the previous floor's.
		this.keyOriginX = Number.NaN;
		this.keyOriginY = Number.NaN;
		this.version++;
		this.clearCaches();

		const { wallLayer, heatmapLayer, roomLabelsLayer } = this.host.layers();
		if (wallLayer) {
			wallLayer.mask = null;
			wallLayer.materialMap = null;
			wallLayer.invalidateCache();
		}
		if (heatmapLayer) {
			heatmapLayer.wallMask = null;
			heatmapLayer.materialMap = null;
			// Generating a heatmap against no walls while the decode is in flight is a full,
			// expensive image that the decode immediately replaces — see `maskPending`.
			heatmapLayer.maskPending = floorState.floors.some(
				(f) => f.id === floorState.currentFloorId && !!f.wallMask
			);
			heatmapLayer.markWallsDirty();
		}
		if (roomLabelsLayer) {
			roomLabelsLayer.roomTypeData = null;
			roomLabelsLayer.roomLabels = null;
			roomLabelsLayer.invalidateCache();
		}
	}

	/** The decoded raster for the AP annotations, and its revision for the transform cache. */
	private setApWallMask(mask: DecodedWallMask | null): void {
		this.apWallMask = mask;
		this.revision++;
	}

	/** Write a decoded raster into the layers that draw it. */
	private apply(mat: MaterialisedMask): void {
		const { wallLayer, heatmapLayer } = this.host.layers();
		const maskRef = {
			data: mat.data,
			width: mat.width,
			height: mat.height,
			originX: mat.originX,
			originY: mat.originY
		};
		if (wallLayer) wallLayer.mask = maskRef;
		if (heatmapLayer) {
			heatmapLayer.wallMask = maskRef;
			/*
			 * The segments, for the one specular reflection the heatmap carries.
			 *
			 * The mask blocks, the segments reflect: a reflection needs the segment's own
			 * line, and a mask pixel has no normal. A floor whose walls are still a detected
			 * raster has no segments, so it gets the direct field only — which is also what
			 * its edit path used to do for walls in general.
			 */
			heatmapLayer.reflectingWalls = (currentFloor()?.walls ?? []).map((wall) => ({
				ax: wall.ax,
				ay: wall.ay,
				bx: wall.bx,
				by: wall.by,
				material: wall.material
			}));
			/*
			 * The outline the heatmap is clipped to: the drawn planning area when there is
			 * one, the detected boundary otherwise. Without it the field covers the whole
			 * sheet and every interior wall throws its shadow into the margin outside the
			 * building, which is the row of dark wedges that was reported as spikes.
			 */
			heatmapLayer.clipPolygon =
				currentFloor()?.planningArea ?? floorplanState.floorplanBoundary ?? null;
			heatmapLayer.materialMap = mat.materialData;
			heatmapLayer.materialVersion++;
		}
		if (wallLayer) {
			wallLayer.materialMap = mat.materialData;
			wallLayer.invalidateCache();
		}

		this.wallData = mat.data;
		this.materialData = mat.materialData;
		this.originX = mat.originX;
		this.originY = mat.originY;
		this.setApWallMask(maskRef);
	}

	private clearCaches(): void {
		this.wallData = null;
		this.materialData = null;
		this.wallLabels = null;
		this.interior = null;
		this.roomLabels = null;
		this.roomTypeData = null;
	}
}
