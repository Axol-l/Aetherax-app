<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { CanvasEngine } from '$canvas/engine.js';
	import { FloorplanLayer } from '$canvas/renderers/floorplan.js';
	import { GridLayer } from '$canvas/renderers/grid.js';
	import { HeatmapLayer } from '$canvas/renderers/heatmap.js';
	import { ApLayer } from '$canvas/renderers/ap.js';
	import type { WallDistanceAnnotation } from '$canvas/renderers/ap.js';
	import { WallLayer } from '$canvas/renderers/walls.js';
	import { decodeMask, encodeMask } from '$canvas/wall-detect.js';
	import type { DecodedWallMask } from '$canvas/wall-detect.js';
	import {
		cachedWallDistanceTransform,
		createWallDistanceCache,
		nearestSideWall
	} from '$canvas/wall-distance.js';
	import { PanZoomHandler } from '$canvas/interactions/pan-zoom.js';
	import { SelectHandler } from '$canvas/interactions/select.js';
	import { SelectionRectLayer } from '$canvas/renderers/selection-rect.js';
	import { ReviewHighlightLayer } from '$canvas/renderers/review-highlight.js';
	import { CalibrationLineLayer } from '$canvas/renderers/calibration-line.js';
	import { PlanningAreaLayer } from '$canvas/renderers/planning-area.js';
	import { SurfacesLayer, surfaceAtPoint, surfaceEdgeNear } from '$canvas/renderers/surfaces.js';
	import { isDegenerateSurface } from '$lib/rf/surface-height.js';
	import { NotesLayer, noteAtPoint, NOTE_HIT_PX } from '$canvas/renderers/notes.js';
	import { VectorWallsLayer } from '$canvas/renderers/vector-walls.js';
	import {
		snapToEndpoint,
		snapToWalls,
		lockToAxis,
		wallNearPoint,
		isDegenerate,
		isDegenerateColumn,
		columnAtPoint,
		type VectorWall,
		type VectorColumn
	} from '$state/vector-walls.js';
	import {
		rasteriseWalls as rasteriseWallsToMasks,
		emptyWallMasks,
		DEFAULT_WALL_BAND
	} from '$state/wall-raster.js';
	import { forgetInterior } from '$state/ap-interior.js';
	import { ReferenceFloorLayer } from '$canvas/renderers/reference-floor.js';
	import { FloorTilesLayer } from '$canvas/renderers/floor-tiles.js';
	import { StackedFloorsLayer, MAX_PITCH } from '$canvas/renderers/stacked-floors.js';
	import { Floor3DLayer } from '$canvas/renderers/floor-3d.js';
	import { FloorCardCache } from '$canvas/renderers/floor-card.js';
	import { DragHandler, type WallProbe } from '$canvas/interactions/drag.js';
	import { PlaceHandler } from '$canvas/interactions/place.js';
	import { wallSnapFrom } from '$state/wall-snap.js';
	import { antennaSignature } from '$lib/rf/antenna.js';
	import {
		apState,
		removeAps,
		getEffectiveWupm,
		radiusFromPower,
		apHeightAboveFloor,
		apSplitFor,
		apVerticalOffsetTo,
		type AccessPoint
	} from '$state/ap-state.svelte.js';
	import { floorplanState } from '$state/floorplan-state.svelte.js';
	
import { wallState } from '$state/wall-state.svelte.js';
	import { projectMeta } from '$state/project-meta.svelte.js';
	import { canvasEngineRef, canvasState, clearSelection } from '$state/canvas.svelte.js';
	import {
		appState,
		setFloorAlignMode,
		setApPlaceMode,
		setCalibrateMode,
		setPlanningDrawMode,
		setSurfaceMode,
		addCalibrationPoint,
		addPlanningPoint,
		STACK_YAW_LIMIT_DEG,
		STACK_MIN_PITCH_DEG,
		STACK_MAX_PITCH_DEG
	} from '$state/app.svelte.js';
	import { undo, redo, pushState } from '$state/history.svelte.js';
	import {
		solverState,
		runSolver,
		invalidateSolverMaskCache,
		getFloorMask
	} from '$state/solver.svelte.js';
	import { updateCoverage, optimizerState, floorCoverage, apsOutsideInterior } from '$state/optimizer.svelte.js';
	import { hitTest } from '$canvas/hit-test.js';
	import { fitCanvasToContent } from '$canvas/fit.js';
	import { restoreFromStorage, saveNow } from '$state/persistence.svelte.js';
	import { importFloorplanFile } from '$canvas/import-floorplan.js';
	import { labelWallBlobs, relabelBlob, labelRooms, fillRegion, encodeMaterialMask, decodeMaterialMask } from '$canvas/region-labels.js';
	import type { RegionLabels } from '$canvas/region-labels.js';
	import { WALL_MATERIALS, registerCustomMaterials, type WallMaterialId } from '$canvas/materials.js';
	import {
		floorState,
		currentFloor,
		floorElevation,
		getFloorSlabAttenuation,
		translateFloor,
		switchFloor,
		type Floor
	} from '$state/floor-state.svelte.js';
	import { FLOOR_MATERIALS } from '$canvas/floor-materials.js';
	import type { Band } from '@aetherax/channels';
	import { scheduleSave } from '$state/persistence.svelte.js';
	import { computeBuildingInterior } from '$canvas/morphology.js';
	import { RoomLabelsLayer } from '$canvas/renderers/room-labels.js';
	import { ROOM_TYPES } from '$canvas/room-types.js';
	import LayerPanel from '$components/canvas/LayerPanel.svelte';
	import WallMaterialPopup from '$components/canvas/WallMaterialPopup.svelte';
	import WallToolbar from '$components/canvas/WallToolbar.svelte';
	import RoomTypePopup from '$components/canvas/RoomTypePopup.svelte';
	import ConfirmDialog from '$components/dialogs/ConfirmDialog.svelte';
	import { t, i18nState } from '$state/i18n.svelte';
	import { displayLength, formatMeasure, lengthUnit } from '$lib/units.js';

	/**
	 * The decoded wall mask the AP annotations are measured against.
	 *
	 * `$state` because the mask arrives asynchronously: the decode effect hands it
	 * over from a promise callback, and that assignment is what tells the
	 * annotation effect to measure again. It is assigned **only** from callbacks
	 * and event handlers, never from an effect's own body — a reactive write
	 * inside an effect re-runs that effect, and this one's "no mask" path has no
	 * guard that could stop it, which is 1000 iterations of
	 * `effect_update_depth_exceeded` rather than a wrong pixel. That is also why
	 * the counter below is deliberately *not* reactive.
	 */
	let apWallMask = $state<DecodedWallMask | null>(null);
	/**
	 * A plain counter, bumped whenever the mask is republished, for the distance
	 * transform's cache key.
	 *
	 * Identity is not enough. The wall editor's `materialize()` patches one raster
	 * in place and hands back the same `Uint8Array` after every stroke and every
	 * clear, so a brush stroke that erases a wall leaves the array looking exactly
	 * as it did — and the transform measured from the walls that are no longer
	 * there would be reused. The bump makes the annotation effect re-read this and
	 * rebuild; being plain, it notifies nobody and cannot close a cycle.
	 */
	let apWallMaskRevision = 0;
	const wallDistanceCache = createWallDistanceCache();
	/**
	 * The mask the cache above was last built for.
	 *
	 * Held beside it so a drag can ask "where is the nearest wall?" without decoding
	 * anything: the annotation effect rebuilds the transform when the mask changes,
	 * and both are written there together.
	 */
	let wallProbeMask: { originX: number; originY: number } | null = null;

	/**
	 * The nearest wall to a world point, from the transform the caption already built.
	 *
	 * Null when there is no mask to measure against, which leaves a drag unsnapped
	 * rather than stuck.
	 */
	const wallProbe: WallProbe = (x, y) =>
		wallProbeMask
			? wallSnapFrom(wallDistanceCache.transform, wallProbeMask.originX, wallProbeMask.originY, x, y, getEffectiveWupm())
			: null;

	/** Publish a wall mask for the AP annotations, and invalidate their cache. */
	function setApWallMask(mask: DecodedWallMask | null): void {
		apWallMask = mask;
		apWallMaskRevision++;
	}

	/**
	 * Hand a materialised raster to the layers that draw walls.
	 *
	 * The decode effect does this for a mask that came off disk, but a mask the
	 * user just edited never needs decoding — and after a clear it must not rely on
	 * the decode effect firing at all, because that effect skips itself whenever the
	 * URL and origin are unchanged and the decoded pixels are cached. The wall layer
	 * would then keep drawing the raster it was handed before the clear.
	 */
	function applyMaskToRenderers(mat: {
		data: Uint8Array;
		materialData: Uint8Array | null;
		width: number;
		height: number;
		originX: number;
		originY: number;
	}) {
		const maskRef = {
			data: mat.data,
			width: mat.width,
			height: mat.height,
			originX: mat.originX,
			originY: mat.originY
		};
		wallLayer.mask = maskRef;
		heatmapLayer.wallMask = maskRef;
		/*
		 * The segments, for the one specular reflection the heatmap carries.
		 *
		 * The mask blocks, the segments reflect: a reflection needs the segment's own line,
		 * and a mask pixel has no normal. A floor whose walls are still a detected raster has
		 * no segments, so it gets the direct field only — which is also what its edit path
		 * used to do for walls in general.
		 */
		heatmapLayer.reflectingWalls = (currentFloor()?.walls ?? []).map((wall) => ({
			ax: wall.ax,
			ay: wall.ay,
			bx: wall.bx,
			by: wall.by,
			material: wall.material
		}));
		cachedWallData = mat.data;
		cachedMaterialData = mat.materialData;
		cachedMaskOriginX = mat.originX;
		cachedMaskOriginY = mat.originY;
		wallLayer.materialMap = mat.materialData;
		heatmapLayer.materialMap = mat.materialData;
		heatmapLayer.materialVersion++;
		wallLayer.invalidateCache();

		setApWallMask(maskRef);
	}

	/**
	 * Publish a materialised raster as the floor's wall mask.
	 *
	 * There is one way a mask changes now: the segments are rasterised and the result
	 * becomes the mask. That used to be the wall editor's job, and it is kept as one
	 * routine because the mask is not just a data URL: the layers draw the pixels that
	 * were just written (the decode effect would skip a URL it has already seen), the
	 * material popup needs the blob labels, the room types need the interior, and the
	 * solver's decoded copy is now stale.
	 */
	function publishWallRaster(mat: {
		data: Uint8Array;
		materialData: Uint8Array | null;
		width: number;
		height: number;
		originX: number;
		originY: number;
	}): boolean {
		const { data, materialData, width, height, originX, originY } = mat;

		// The mask is encoded whole on every edit, so its extent is worth watching.
		// A mask far larger than any building is a bounds bug, not a large plan, and
		// the symptom is the whole layer disappearing once the canvas size limit is
		// passed.
		if (width > 8000 || height > 8000) {
			console.warn(
				`[walls] mask is ${width}x${height} at origin ${originX},${originY}. ` +
					'That is larger than any floorplan; expect slow edits and, past the ' +
					'canvas size limit, a failed encode that wipes the layer.'
			);
		}

		applyMaskToRenderers(mat);

		const newWallUrl = encodeMask(data, width, height);
		const newMatUrl = materialData ? encodeMaterialMask(materialData, width, height) : null;

		// Update URLs and pre-set lastUrls so the async decode effect skips re-decode
		wallState.wallMask = { dataUrl: newWallUrl, width, height, originX, originY };
		lastWallMaskUrl = newWallUrl;
		if (newMatUrl) {
			wallState.materialMask = { dataUrl: newMatUrl, width, height, originX, originY };
			lastMatMaskUrl = newMatUrl;
		} else if (wallState.materialMask) {
			// No material pixels left. Keeping the old material mask around means
			// the next decode reads it back and the assignments reappear.
			wallState.materialMask = null;
			lastMatMaskUrl = null;
		}

		// Recompute blob labels so click-to-override works on the edited walls
		cachedWallLabels = labelWallBlobs(data, width, height);

		// Recompute interior + room labels for room type detection
		const interiorResult = computeBuildingInterior(data, width, height, { maxDim: 400 });
		cachedInterior = interiorResult.interior;
		cachedRoomLabels = labelRooms(cachedInterior, width, height);

		// Room type data may need resizing if mask dimensions changed
		if (cachedRoomTypeData && cachedRoomTypeData.length !== width * height) {
			cachedRoomTypeData = null;
			wallState.roomTypeMask = null;
		}
		if (roomLabelsLayer) {
			roomLabelsLayer.roomLabels = cachedRoomLabels;
			roomLabelsLayer.roomTypeData = cachedRoomTypeData;
			roomLabelsLayer.maskWidth = width;
			roomLabelsLayer.maskHeight = height;
			roomLabelsLayer.originX = originX;
			roomLabelsLayer.originY = originY;
			roomLabelsLayer.invalidateCache();
		}

		// Trigger re-solve (wallMaskVersion drives auto-solve key)
		wallMaskVersion++;
		invalidateSolverMaskCache();

		heatmapLayer.markWallsDirty();
		engine.markDirty();
		// The walls are what decides what the floor covers, so the figure is re-measured
		// rather than left standing from the geometry that was just replaced.
		void updateCoverage();
		scheduleSave();
		return true;
	}

	/**
	 * Make the drawn segments the floor's mask.
	 *
	 * Everything downstream — the heatmap's attenuation field, the optimiser's domain, the
	 * coverage samples, the interior test, the worker's payload — reads a wall mask and a
	 * material mask. Deriving those from the segments therefore makes the whole app
	 * vector-driven with no change to any of its own maths.
	 *
	 * Nothing calls this by hand any more: a wall that is drawn, moved or deleted moves the
	 * mask with it (see the effect below). The frame is always the mask's own, never the
	 * segments' bounding box — samples, texels and the interior are addressed in the plan's
	 * frame, and a mask sized to the walls puts every one of them outside it.
	 */
	function syncVectorWallsToMask(forceEmpty = false): void {
		const floor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
		if (!floor) return;
		const walls = floor.walls ?? [];
		const columns = floor.columns ?? [];
		const frame = wallState.wallMask;
		const noSegments = walls.length === 0 && columns.length === 0;
		/*
		 * No segments is not the same thing as no walls.
		 *
		 * The mask may be a *detected* raster — an imported plan, or Re-detect walls — which is
		 * the only geometry that floor has. Emptying it here because the segment list is empty
		 * threw the detection away, which is why an import stopped drawing walls and the
		 * Re-detect button appeared to do nothing. The segment list is empty until the user draws
		 * or traces; the detection owns the mask until then.
		 *
		 * `forceEmpty` is the caller saying the last segment was just deleted: then the mask must
		 * be emptied, because otherwise every consumer keeps measuring a wall that is gone.
		 */
		if (noSegments && !forceEmpty) return;
		const extent = frame
			? {
					width: frame.width,
					height: frame.height,
					originX: frame.originX,
					originY: frame.originY
				}
			: undefined;
		const masks = noSegments
			? frame
				? emptyWallMasks(extent!)
				: null
			: rasteriseWallsToMasks(
					walls.map((wall) => ({
						ax: wall.ax,
						ay: wall.ay,
						bx: wall.bx,
						by: wall.by,
						material: wall.material
					})),
					DEFAULT_WALL_BAND,
					8,
					extent,
					columns.map((column) => ({
						shape: column.shape,
						ax: column.ax,
						ay: column.ay,
						bx: column.bx,
						by: column.by,
						material: column.material
					}))
				);
		if (!masks) return;
		publishWallRaster({
			data: masks.wall,
			materialData: masks.material,
			width: masks.width,
			height: masks.height,
			originX: masks.originX,
			originY: masks.originY
		});
	}

	let canvasDragOver = $state(false);

	function handleCanvasDrop(e: DragEvent) {
		e.preventDefault();
		canvasDragOver = false;
		const file = e.dataTransfer?.files[0];
		if (file) {
			pushState();
			importFloorplanFile(file);
			appState.sidebarPanel = 'floorplan';
			appState.sidebarOpen = true;
		}
	}

	function handleCanvasDragOver(e: DragEvent) {
		e.preventDefault();
		canvasDragOver = true;
	}

	function handleCanvasDragLeave() {
		canvasDragOver = false;
	}

	// Wall material popup state
	let wallPopup = $state<{
		x: number;
		y: number;
		material: WallMaterialId;
		/** The raster blob it was opened on, when it was a detected wall. */
		blobId?: number;
		/** The drawn segment it was opened on, when it was one. */
		wallId?: string;
		/** The column it was opened on, when it was one. */
		columnId?: string;
		/** Opened from the wall toolbar: the choice sets the material for what is drawn next. */
		tool?: boolean;
	} | null>(null);
	let cachedWallLabels: ReturnType<typeof labelWallBlobs> | null = null;
	let cachedMaterialData: Uint8Array | null = null;
	let cachedWallData: Uint8Array | null = null;
	let cachedMaskOriginX = 0;
	let cachedMaskOriginY = 0;

	// Room type popup state
	let roomPopup = $state<{ x: number; y: number; typeId: number; density: number; customLabel: string; regionId: number } | null>(null);
	let cachedInterior: Uint8Array | null = null;
	let cachedRoomLabels: RegionLabels | null = null;
	let cachedRoomTypeData: Uint8Array | null = null;
	let roomLabelsLayer: RoomLabelsLayer;

	// Long-press detection for mobile contextual actions
	let longPressTimer: ReturnType<typeof setTimeout> | null = null;
	const LONG_PRESS_MS = 500;
	let longPressFired = false;

	function handleWallClick(screenX: number, screenY: number): boolean {
		if (!engine || !cachedWallData || !cachedWallLabels) return false;
		const world = engine.camera.screenToWorld({ x: screenX, y: screenY });
		const px = Math.round(world.x) - cachedMaskOriginX;
		const py = Math.round(world.y) - cachedMaskOriginY;
		const mask = wallState.wallMask;
		if (!mask || px < 0 || px >= mask.width || py < 0 || py >= mask.height) return false;
		const idx = py * mask.width + px;
		if (!cachedWallData[idx]) return false;

		const blobId = cachedWallLabels.labels[idx]!;
		if (blobId < 0) return false;

		const matId = cachedMaterialData ? (cachedMaterialData[idx] ?? wallState.wallMaterial) : wallState.wallMaterial;
		wallPopup = { x: screenX, y: screenY, material: matId as WallMaterialId, blobId };
		return true;
	}

	function handleRoomClick(screenX: number, screenY: number): boolean {
		if (!engine || !cachedInterior || !cachedRoomLabels) return false;
		const world = engine.camera.screenToWorld({ x: screenX, y: screenY });
		const px = Math.round(world.x) - cachedMaskOriginX;
		const py = Math.round(world.y) - cachedMaskOriginY;
		const mask = wallState.wallMask;
		if (!mask || px < 0 || px >= mask.width || py < 0 || py >= mask.height) return false;
		const idx = py * mask.width + px;

		// Must be an interior pixel (not a wall, not exterior)
		if (!cachedInterior[idx]) return false;

		const regionId = cachedRoomLabels.labels[idx]!;
		if (regionId < 0) return false;

		const typeId = cachedRoomTypeData ? (cachedRoomTypeData[idx] ?? 0) : 0;
		const floor = currentFloor();
		const densityOverride = floor.roomDensityOverrides[String(regionId)];
		const roomType = ROOM_TYPES.find(t => t.id === typeId);
		const density = densityOverride ?? roomType?.defaultDensity ?? 0;
		const customLabel = floor.roomCustomLabels?.[String(regionId)] ?? '';

		roomPopup = { x: screenX, y: screenY, typeId, density, customLabel, regionId };
		return true;
	}

	/** Right-click / long-press contextual handler: wall, column, raster or room popup. */
	function handleContextAction(screenX: number, screenY: number): boolean {
		// A drawn segment first: it is the model, and the raster blob under it is only
		// its shadow. A column is the same kind of thing — a pier is a wall with no length —
		// so it comes before the raster too. Then the raster, then a room.
		if (handleVectorColumnContext(screenX, screenY)) return true;
		if (handleVectorWallContext(screenX, screenY)) return true;
		if (handleWallClick(screenX, screenY)) return true;
		if (handleRoomClick(screenX, screenY)) return true;
		return false;
	}

	/**
	 * Right-click on a drawn wall: the popup edits *that segment's* material.
	 *
	 * This is how a wall's material is set now that the paint brush is gone, so it has to
	 * outrank the blob behind it — the segment is the wall, the blob is its rasterisation.
	 */
	/**
	 * Right-click on a column: the popup edits *that column's* material.
	 *
	 * A column is drawn in the toolbar's current material and, until now, had no way back: a
	 * pier drawn as drywall could not be made concrete without deleting and redrawing it. It is
	 * the same popup as a wall's, keyed on the column instead.
	 */
	function handleVectorColumnContext(screenX: number, screenY: number): boolean {
		if (!engine) return false;
		const floor = currentFloor();
		const columns = (floor?.columns ?? []) as VectorColumn[];
		if (columns.length === 0) return false;
		const world = engine.camera.screenToWorld({ x: screenX, y: screenY });
		const column = columnAtPoint(columns, world);
		if (!column) return false;
		appState.wallColumnSelected = column.id;
		appState.wallVectorSelected = null;
		wallPopup = {
			x: screenX,
			y: screenY,
			material: column.material as WallMaterialId,
			columnId: column.id
		};
		engine.markDirty();
		return true;
	}

	function handleVectorWallContext(screenX: number, screenY: number): boolean {
		if (!engine) return false;
		const floor = currentFloor();
		const walls = (floor?.walls ?? []) as VectorWall[];
		if (walls.length === 0) return false;
		const world = engine.camera.screenToWorld({ x: screenX, y: screenY });
		const tolerance = 12 / (engine.camera.state.zoom || 1);
		const wall = wallNearPoint(world, walls, tolerance);
		if (!wall) return false;
		appState.wallVectorSelected = wall.id;
		wallPopup = {
			x: screenX,
			y: screenY,
			material: wall.material as WallMaterialId,
			wallId: wall.id
		};
		engine.markDirty();
		return true;
	}

	function handleContextMenu(e: MouseEvent) {
		if (appState.floorAlignMode) {
			e.preventDefault();
			cancelAlignDrag();
			setFloorAlignMode(false);
			return;
		}
		if (!engine) return;
		e.preventDefault();
		// Close any existing popups before opening a new one
		wallPopup = null;
		roomPopup = null;
		const rect = engine.canvas.getBoundingClientRect();
		const sx = e.clientX - rect.left;
		const sy = e.clientY - rect.top;
		handleContextAction(sx, sy);
	}

	async function handleRoomTypeSelect(typeId: number, density: number, customLabel?: string) {
		if (!roomPopup || !cachedRoomLabels || !wallState.wallMask) return;
		pushState();
		const mask = wallState.wallMask;

		// Create or clone room type mask
		if (!cachedRoomTypeData) {
			cachedRoomTypeData = new Uint8Array(mask.width * mask.height);
		}

		fillRegion(cachedRoomLabels.labels, cachedRoomTypeData, roomPopup.regionId, typeId);

		// Save per-region density override and custom label
		const floor = currentFloor();
		const regionKey = String(roomPopup.regionId);
		if (typeId === 0) {
			delete floor.roomDensityOverrides[regionKey];
			delete floor.roomCustomLabels[regionKey];
		} else {
			floor.roomDensityOverrides[regionKey] = density;
			if (customLabel) {
				if (!floor.roomCustomLabels) floor.roomCustomLabels = {};
				floor.roomCustomLabels[regionKey] = customLabel;
			} else {
				delete floor.roomCustomLabels?.[regionKey];
			}
		}

		// Update renderer
		roomLabelsLayer.roomTypeData = cachedRoomTypeData;
		roomLabelsLayer.roomLabels = cachedRoomLabels;
		roomLabelsLayer.densityOverrides = floor.roomDensityOverrides;
		roomLabelsLayer.customLabels = floor.roomCustomLabels ?? {};
		roomLabelsLayer.invalidateCache();
		engine.markDirty();

		// Encode and persist
		const dataUrl = encodeMaterialMask(cachedRoomTypeData, mask.width, mask.height);
		wallState.roomTypeMask = { dataUrl, width: mask.width, height: mask.height, originX: cachedMaskOriginX, originY: cachedMaskOriginY };
		scheduleSave();

		// Update coverage with new density weights
		updateCoverage();
	}

	async function handleMaterialSelect(newMaterial: WallMaterialId) {
		if (!wallPopup) return;
		/*
		 * The choice came from the wall toolbar: it is the material the *next* wall or column
		 * is drawn in, not a change to anything that exists. The sidebar's wall card shows the
		 * same value, because `wallState.wallMaterial` is what both read.
		 */
		if (wallPopup.tool) {
			wallState.wallMaterial = newMaterial;
			scheduleSave();
			return;
		}
		/*
		 * A drawn segment: the material is a property of *the wall*, not of the pixels
		 * under it. Writing it here and re-deriving the mask is what keeps the two
		 * models from drifting — the segment stays the truth and the mask follows.
		 */
		if (wallPopup.wallId) {
			const floor = currentFloor();
			const wall = floor?.walls?.find((candidate) => candidate.id === wallPopup!.wallId);
			if (!floor || !wall) return;
			pushState();
			floor.walls = (floor.walls ?? []).map((candidate) =>
				candidate.id === wall.id ? { ...candidate, material: newMaterial } : candidate
			);
			syncVectorWallsToMask();
			scheduleSave();
			return;
		}
		/*
		 * A column: the same rule as a wall — the material is the column's own, and the mask is
		 * re-derived from it. The drawing shows it as the column's fill colour, so "assign a
		 * material to a pier" is one action rather than delete-and-redraw.
		 */
		if (wallPopup.columnId) {
			const floor = currentFloor();
			const column = floor?.columns?.find((candidate) => candidate.id === wallPopup!.columnId);
			if (!floor || !column) return;
			pushState();
			floor.columns = (floor.columns ?? []).map((candidate) =>
				candidate.id === column.id ? { ...candidate, material: newMaterial } : candidate
			);
			syncVectorWallsToMask();
			scheduleSave();
			return;
		}
		if (!cachedWallLabels || !wallState.wallMask || wallPopup.blobId === undefined) return;
		pushState(); // undo captures state before blob relabel
		const mask = wallState.wallMask;
		const blobId = wallPopup.blobId;

		// Create or clone material mask
		if (!cachedMaterialData) {
			cachedMaterialData = new Uint8Array(mask.width * mask.height);
			cachedMaterialData.fill(wallState.wallMaterial);
		}

		relabelBlob(cachedWallLabels.labels, cachedMaterialData, blobId, newMaterial);

		// Update renderers immediately
		wallLayer.materialMap = cachedMaterialData;
		wallLayer.invalidateCache();
		heatmapLayer.materialMap = cachedMaterialData;
		heatmapLayer.materialVersion++;
		heatmapLayer.markWallsDirty();
		engine.markDirty();

		// Trigger solver re-run
		wallMaskVersion++;
		invalidateSolverMaskCache();

		// Encode and persist
		const dataUrl = encodeMaterialMask(cachedMaterialData, mask.width, mask.height);
		wallState.materialMask = { dataUrl, width: mask.width, height: mask.height, originX: cachedMaskOriginX, originY: cachedMaskOriginY };
		scheduleSave();
	}

	let canvasEl: HTMLCanvasElement;
	let containerEl: HTMLDivElement;
	let engine: CanvasEngine;
	let panZoom: PanZoomHandler;
	let selectHandler: SelectHandler;
	let dragHandler: DragHandler;
	let placeHandler: PlaceHandler;
	let floorplanLayer: FloorplanLayer;
	let gridLayer: GridLayer;
	let heatmapLayer: HeatmapLayer;
	let selectionRectLayer: SelectionRectLayer;
	let reviewHighlightLayer: ReviewHighlightLayer;
	let calibrationLineLayer: CalibrationLineLayer;
	let planningAreaLayer: PlanningAreaLayer;
	let surfacesLayer: SurfacesLayer;
	let notesLayer: NotesLayer;
	let vectorWallsLayer: VectorWallsLayer;
	/** Pointer position while drawing a wall, for the rubber band. */
	let vectorCursor = $state<{ x: number; y: number } | null>(null);
	/** The endpoint that click would snap to, ringed while the pointer is near it. */
	let vectorSnap = $state<{ x: number; y: number } | null>(null);
	/** Pointer position while drawing the planning area; drives the rubber band. */
	let planningCursor = $state<{ x: number; y: number } | null>(null);
	let referenceFloorLayer: ReferenceFloorLayer;
	let floorTilesLayer: FloorTilesLayer;
	let stackedFloorsLayer: StackedFloorsLayer;
	let floor3DLayer: Floor3DLayer;
	/**
	 * Decoded images and per-floor coverage, held once for both overview views.
	 *
	 * One cache rather than one per view, because a floor's coverage image is the
	 * expensive artefact: sharing it means switching between the contact sheet and
	 * the stack never regenerates anything, and the two views cannot disagree about
	 * a floor's resolution or its cache key.
	 */
	const floorCards = new FloorCardCache();

	// Floor-alignment drag. Screen-space deltas are kept because the camera works
	// in screen space while `translateFloor` works in world units; the zoom is
	// the conversion, and it can change mid-drag if the user scrolls.
	let alignDragging = false;
	let alignStartClientX = 0;
	let alignStartClientY = 0;
	let alignStartX = 0;
	let alignStartY = 0;
	let alignDxScreen = 0;
	let alignDyScreen = 0;
	let apLayer: ApLayer;
	let wallLayer: WallLayer;
	let autoSolveTimeout: ReturnType<typeof setTimeout> | null = null;
	let showEmptyHint = $derived(
		// Only in the view where the hint's advice can be acted on: the overviews are
		// read-only, and a "drop a floorplan here" over a 3D model is noise.
		appState.floorView === 'single' &&
			apState.aps.length === 0 &&
			!floorplanState.floorplanUrl
	);

	function handleKeyDown(e: KeyboardEvent) {
		const target = e.target as HTMLElement;
		const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
		const mod = e.metaKey || e.ctrlKey;

		if (!isInput && appState.wallVectorMode && e.key === 'Escape') {
			stopWallMode();
			return;
		}

		if (
			!isInput &&
			(appState.wallVectorSelected || appState.wallColumnSelected) &&
			(e.key === 'Delete' || e.key === 'Backspace')
		) {
			// A selected segment or column is a selected object: the same key that deletes an
			// access point deletes it, and it must be consumed before the AP branch below.
			const floor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
			const wallSelected =
				!!appState.wallVectorSelected &&
				!!floor?.walls?.some((wall) => wall.id === appState.wallVectorSelected);
			const columnSelected =
				!!appState.wallColumnSelected &&
				!!floor?.columns?.some((column) => column.id === appState.wallColumnSelected);
			if (wallSelected || columnSelected) {
				e.preventDefault();
				pushState();
				if (wallSelected) {
					floor!.walls = (floor!.walls ?? []).filter(
						(wall) => wall.id !== appState.wallVectorSelected
					);
					appState.wallVectorSelected = null;
				} else {
					floor!.columns = (floor!.columns ?? []).filter(
						(column) => column.id !== appState.wallColumnSelected
					);
					appState.wallColumnSelected = null;
				}
				// The last obstruction on the floor: the mask has to be emptied with it, in the
				// frame it already has, or the model keeps charging a wall that no longer exists.
				const segmentsLeft =
					(floor!.walls ?? []).length + (floor!.columns ?? []).length === 0;
				if (segmentsLeft) syncVectorWallsToMask(true);
				scheduleSave();
				engine.markDirty();
				return;
			}
		}

		if (!isInput && appState.planningDrawMode && e.key === 'Enter') {
			commitPlanningDraft();
			return;
		}

		if (!isInput && appState.planningDrawMode && (e.key === 'Backspace' || e.key === 'Delete')) {
			// Before the AP delete below: in this mode Backspace means "that corner was
			// wrong", which is the correction the user reaches for most often.
			e.preventDefault();
			if (appState.planningDraft.length > 0) {
				appState.planningDraft = appState.planningDraft.slice(0, -1);
			}
			return;
		}

		if (!isInput && e.key === 'Escape' && appState.planningDrawMode) {
			// Abandoning the loop: an unfinished outline is not a statement about the floor.
			setPlanningDrawMode(false);
			return;
		}

		if (!isInput && e.key === 'Escape' && appState.surfaceMode) {
			// A half-drawn rectangle is not a surface; leaving the mode drops it.
			setSurfaceMode(false);
			return;
		}

		if (!isInput && appState.surfaceSelected && (e.key === 'Delete' || e.key === 'Backspace')) {
			// A selected surface is a selected object, like a wall and like an AP.
			const floor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
			if (floor?.surfaces?.some((surface) => surface.id === appState.surfaceSelected)) {
				e.preventDefault();
				pushState();
				floor.surfaces = (floor.surfaces ?? []).filter(
					(surface) => surface.id !== appState.surfaceSelected
				);
				appState.surfaceSelected = null;
				void updateCoverage();
				engine?.markDirty();
				scheduleSave();
				return;
			}
		}

		if (!isInput && e.key === 'Escape' && appState.calibrateMode) {
			// The measured line belongs to the mode, so leaving the mode drops it; the
			// sidebar keeps the typed distance but not a line to apply it to.
			setCalibrateMode(false);
			return;
		}

		if (!isInput && e.key === 'Escape' && appState.floorAlignMode) {
			// Escape is the conventional way out of a mode, and leaving it to the
			// sidebar toggle alone makes a mode that looks stuck.
			cancelAlignDrag();
			setFloorAlignMode(false);
			return;
		}

		if (!isInput && e.key === 'Escape' && appState.apPlaceMode) {
			// Same reasoning: a mode that owns the canvas has to be escapable without
			// reaching for the sidebar.
			setApPlaceMode(false);
			return;
		}

		if (mod && (e.key === 's' || e.key === 'S')) {
			// The browser's own save dialog has nothing to do with a project: intercept it,
			// write the project to the app's store, and answer visibly. Autosave is silent
			// by design, but a key the user pressed has to say something.
			e.preventDefault();
			void saveNow();
			return;
		}

		if (mod && e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
			e.preventDefault();
			redo();
			engine?.markDirty();
			return;
		}

		if (mod && (e.key === 'z' || e.key === 'Z')) {
			e.preventDefault();
			undo();
			engine?.markDirty();
			return;
		}

		if (e.key === 'Delete' || e.key === 'Backspace') {
			if (canvasState.selectedApIds.length > 0) {
				e.preventDefault();
				removeAps([...canvasState.selectedApIds]);
				clearSelection();
			}
		}

		if (isInput || mod) return;

		switch (e.key) {
			case 'g':
			case 'G':
				appState.showGrid = !appState.showGrid;
				break;
			case 'w':
			case 'W':
				appState.showWalls = !appState.showWalls;
				break;
			case 'h':
			case 'H':
				appState.showHeatmap = !appState.showHeatmap;
				break;
		}
	}

	/** The floor directly below the current one, by level. */
	function floorBelowCurrent() {
		const cur = currentFloor();
		if (!cur) return null;
		const sorted = [...floorState.floors].sort((a, b) => a.level - b.level);
		const i = sorted.findIndex((f) => f.id === cur.id);
		return i > 0 ? sorted[i - 1]! : null;
	}

	/**
	 * Move one storey up or down, from the 3D view's arrows.
	 *
	 * By level rather than by array position: the array is kept in level order, but the
	 * arrows say "the floor above" and a reordered array must not turn them into "the next
	 * one". A step past the end is a no-op rather than a clamp, so the arrows do not
	 * silently stop responding at the top of a building.
	 */
	function stepFloor(direction: 1 | -1): void {
		const sorted = [...floorState.floors].sort((a, b) => a.level - b.level);
		const index = sorted.findIndex((f) => f.id === floorState.currentFloorId);
		if (index < 0) return;
		const target = sorted[index + direction];
		if (!target) return;
		switchFloor(target.id);
		// Frame the storey that just came into view; its plan may be a different size.
		requestAnimationFrame(() => {
			if (engine) fitCanvasToContent(engine);
			engine?.markDirty();
		});
	}

	onMount(() => {
		// Asynchronous since the project moved to a store seam: this opens it, carries any
		// record that only exists in localStorage into it, and loads the project. The
		// canvas draws the empty plan until it lands, which is what it did before.
		void restoreFromStorage();
		window.addEventListener('keydown', handleKeyDown);
		engine = new CanvasEngine(canvasEl);
		// Published so the toolbar and the status bar can act on the live view: they
		// export the frame, fit the plan and reset the camera. See `canvasEngineRef`.
		canvasEngineRef.engine = engine;
		// Create layers
		floorplanLayer = new FloorplanLayer();
		gridLayer = new GridLayer();
		heatmapLayer = new HeatmapLayer();
		wallLayer = new WallLayer();
		roomLabelsLayer = new RoomLabelsLayer();
		apLayer = new ApLayer();
		selectionRectLayer = new SelectionRectLayer();
		reviewHighlightLayer = new ReviewHighlightLayer();
		referenceFloorLayer = new ReferenceFloorLayer();
		referenceFloorLayer.onLoad = () => engine?.markDirty();
		floorTilesLayer = new FloorTilesLayer(floorCards);
		floorTilesLayer.onLoad = () => engine?.markDirty();
		stackedFloorsLayer = new StackedFloorsLayer(floorCards);
		stackedFloorsLayer.onLoad = () => engine?.markDirty();
		floor3DLayer = new Floor3DLayer(floorCards);

		// Add layers in draw order: floorplan, grid, heatmap, walls, room labels, APs, selection rect
		engine.addLayer(floorplanLayer);
		engine.addLayer(gridLayer);
		engine.addLayer(heatmapLayer);
		engine.addLayer(wallLayer);
		// Above the current floor's plan and walls on purpose: the underlay is 80%
		// opaque, so a ghost drawn below it would be invisible exactly when it is
		// needed. Below the labels and APs, which belong to the current floor.
		engine.addLayer(referenceFloorLayer);
		// Last, so it covers everything: in tiled view the single-floor layers have
		// already switched themselves off, but the background is still theirs.
		engine.addLayer(floorTilesLayer);
		engine.addLayer(stackedFloorsLayer);
		engine.addLayer(roomLabelsLayer);
		engine.addLayer(apLayer);
		engine.addLayer(selectionRectLayer);
		engine.addLayer(reviewHighlightLayer);
		// The measured calibration line, over the plan it measures.
		calibrationLineLayer = new CalibrationLineLayer();
		engine.addLayer(calibrationLineLayer);
		planningAreaLayer = new PlanningAreaLayer();
		engine.addLayer(planningAreaLayer);
		// Above the heatmap, under the walls and the labels: a raised area is a property
		// of the floor, and it has to be visible over the coverage it changes.
		surfacesLayer = new SurfacesLayer();
		engine.addLayer(surfacesLayer);
		notesLayer = new NotesLayer();
		engine.addLayer(notesLayer);
		vectorWallsLayer = new VectorWallsLayer();
		engine.addLayer(vectorWallsLayer);
		// The 3D view draws the whole floor itself, so it goes on top: when it is visible
		// every layer beneath it has already switched itself off.
		engine.addLayer(floor3DLayer);

		// Create interaction handlers
		panZoom = new PanZoomHandler(engine);
		panZoom.attach();
		selectHandler = new SelectHandler(engine, selectionRectLayer);
		dragHandler = new DragHandler(engine, wallProbe);
		placeHandler = new PlaceHandler(engine);

		// Set up resize observer
		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const { width, height } = entry.contentRect;
				engine.resize(width, height);
			}
		});
		observer.observe(containerEl);

		// Initial size
		const rect = containerEl.getBoundingClientRect();
		engine.resize(rect.width, rect.height);
		engine.start();

		// Track zoom for status bar
		const zoomInterval = setInterval(() => {
			canvasState.zoom = engine.camera.state.zoom;
		}, 100);

		return () => {
			window.removeEventListener('keydown', handleKeyDown);
			engine.stop();
			panZoom.detach();
			observer.disconnect();
			clearInterval(zoomInterval);
		};
	});

	// Sync AP layer — only tracks apState, not wall/floorplan state
	// Filter APs to current floor only
	$effect(() => {
		if (!apLayer) return;
		const floorId = floorState.currentFloorId;
		const aps = apState.aps.filter((ap) => ap.floorId === floorId);
		for (const ap of aps) {
			void ap.x;
			void ap.y;
			void ap.assignedChannel;
			void ap.band;
			void ap.name;
		}
		apLayer.aps = aps;
		engine.markDirty();
	});

	$effect(() => {
		if (!apLayer) return;
		apLayer.selectedIds = canvasState.selectedApIds;
		engine.markDirty();
	});

	$effect(() => {
		if (!apLayer) return;
		apLayer.hoveredId = canvasState.hoveredApId;
		engine.markDirty();
	});

	/**
	 * How far each access point on this floor sits from the nearest wall.
	 *
	 * The measurement is the exact distance to the nearest wall *pixel*, and the
	 * caption is converted here rather than in the renderer, because this is where
	 * the calibration (world units per metre) and the project's unit system are
	 * both in scope — the one place that can turn a distance in mask pixels into
	 * the figure the rest of the interface would show for it.
	 *
	 * The distance transform behind it costs tens of milliseconds on a full-size
	 * plan, so it is built only when the mask changes, never per frame: an AP
	 * being dragged re-reads a cached transform, which is one array lookup per
	 * access point. Wall editing is excluded outright — every brush dab republishes
	 * the mask, and the annotation is not what anyone is reading mid-stroke.
	 *
	 * Two dependencies, for two different arrivals. `apWallMask` is the decoded
	 * raster and lands from the decode's promise; `wallState.wallMask` is the
	 * floor's declared mask and changes the moment a floor is switched or cleared,
	 * before any decode has run. A mask is only measured against when the two
	 * agree on the geometry, which is what keeps a floor switch from briefly
	 * measuring the incoming floor's access points against the outgoing floor's
	 * walls — and what clears the annotation when a floor has no walls at all,
	 * since the decode effect must not write this state itself.
	 */
	$effect(() => {
		if (!apLayer) return;
		const floorId = floorState.currentFloorId;
		const aps = apState.aps.filter((ap) => ap.floorId === floorId);
		for (const ap of aps) {
			void ap.x;
			void ap.y;
		}

		const declared = wallState.wallMask;
		const decoded = apWallMask;
		const revision = apWallMaskRevision;
		// The origin is compared rounded because that is what the decode does to
		// it: the stored value is an alignment offset and can be fractional, while
		// the raster it addresses is made of whole pixels. Comparing the raw value
		// would silently drop the annotation on every aligned floor.
		const mask =
			declared &&
			decoded &&
			decoded.width === declared.width &&
			decoded.height === declared.height &&
			decoded.originX === Math.round(declared.originX ?? 0) &&
			decoded.originY === Math.round(declared.originY ?? 0)
				? decoded
				: null;

		const show = appState.floorView === 'single' && appState.showAPs;
		const unit = lengthUnit(floorplanState.unitSystem);
		const wupm = getEffectiveWupm();

		const annotations = new Map<string, WallDistanceAnnotation>();
		if (show && mask && wupm > 0) {
			const transform = cachedWallDistanceTransform(wallDistanceCache, mask, revision);
			// Published with the transform it belongs to, so the drag probe and the
			// caption can never be measuring different masks.
			wallProbeMask = transform ? { originX: mask.originX, originY: mask.originY } : null;
			if (transform) {
				for (const ap of aps) {
					/*
					 * A wall-mounted unit is measured sideways instead: it is *on* a
					 * wall, so its nearest wall is the bracket it hangs on — the same
					 * 0.1 m for every one of them, which is a reading that says nothing.
					 * What it has instead is wall beside it, which is where that
					 * mounting wall ends: a corner, a partition, the end of the room. A
					 * reading near zero means the unit is in a corner.
					 */
					const measured =
						ap.mount === 'wall'
							? nearestSideWall(
									mask.data,
									mask.width,
									mask.height,
									mask.originX,
									mask.originY,
									ap.x,
									ap.y,
									ap.facingDeg,
									// No further than the plan is big: past that the ray has
									// left the drawing and the answer is "nothing beside it".
									Math.max(mask.width, mask.height)
								)
							: (() => {
									// Mask pixels are world units, so this is a rounding of the
									// access point's own position, not a rescale.
									const hit = transform.query(
										Math.round(ap.x - mask.originX),
										Math.round(ap.y - mask.originY)
									);
									return hit
										? {
												x: mask.originX + hit.x,
												y: mask.originY + hit.y,
												distanceW: hit.distance
											}
										: null;
								})();
					if (!measured) continue;
					annotations.set(ap.id, {
						x: measured.x,
						y: measured.y,
						// The bare figure, unit and all: the dashed connector beside it
						// already says what it measures to, and "2.9 m" under an access
						// point's name reads faster than a sentence.
						text: formatMeasure(displayLength(measured.distanceW / wupm, unit).value, unit)
					});
				}
			}
		}

		apLayer.wallDistances = annotations;
		engine.markDirty();
	});

	$effect(() => {
		if (!gridLayer) return;
		gridLayer.visible = appState.floorView === 'single' && appState.showGrid;
		engine.markDirty();
	});

	/**
	 * The vector review panel's pointer, drawn over the plan.
	 *
	 * Only in the single-floor view: the element boxes are the current floor's, and the
	 * overviews draw every floor as a read-only card, so a highlight there would point at
	 * one storey's coordinates on another storey's picture.
	 */
	$effect(() => {
		if (!reviewHighlightLayer) return;
		reviewHighlightLayer.box =
			appState.floorView === 'single' ? canvasState.reviewHighlight : null;
		engine.markDirty();
	});

	/**
	 * The calibration points, as the line they describe.
	 *
	 * Only in the single-floor view: the points are world coordinates on the floor being
	 * calibrated, and the overviews draw every storey at once.
	 */
	$effect(() => {
		if (!calibrationLineLayer) return;
		const points = appState.calibrationPoints;
		const visible = appState.floorView === 'single';
		calibrationLineLayer.a = visible && points[0] ? points[0] : null;
		calibrationLineLayer.b = visible && points[1] ? points[1] : null;
		engine.markDirty();
	});

	/**
	 * The planning area: the committed polygon and the loop being drawn.
	 *
	 * Single-floor view only, like the other plan annotations: the polygon is one floor's
	 * coordinates and the overviews draw every storey at once.
	 */
	$effect(() => {
		if (!planningAreaLayer) return;
		const visible = appState.floorView === 'single';
		const floor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
		planningAreaLayer.area = visible ? (floor?.planningArea ?? null) : null;
		planningAreaLayer.draft = visible ? appState.planningDraft : [];
		planningAreaLayer.cursor = appState.planningDrawMode ? planningCursor : null;
		engine.markDirty();
	});

	$effect(() => {
		if (!gridLayer) return;
		const wupm = getEffectiveWupm();
		gridLayer.worldUnitsPerMeter = wupm;
		gridLayer.unitSystem = floorplanState.unitSystem;
		if (heatmapLayer) heatmapLayer.worldUnitsPerMeter = wupm;
		engine.markDirty();
	});

	$effect(() => {
		if (!heatmapLayer) return;
		/*
		 * Hidden while an access point is being dragged. The layer rebuilds itself whenever
		 * an AP moves, and that rebuild is the expensive part of a drag frame; a heatmap that
		 * is sliding under the pointer is not being read anyway. It returns on pointer-up,
		 * rebuilt once from the final positions.
		 */
		heatmapLayer.visible =
			appState.floorView === 'single' && appState.showHeatmap && !canvasState.isDragging;
		engine.markDirty();
	});

	/**
	 * Everything the heatmap's AP list reads.
	 *
	 * Both effects that must re-run when any of it changes call this, so the
	 * dependency list lives in one place rather than being spread over two.
	 */
	function trackHeatmapInputs(): void {
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
		}
		void projectMeta.clientHeight;
	}

	/** An AP as the heatmap takes it: this floor's own, or another floor's as a fixed source. */
	type HeatmapSourceAp = (typeof apState.aps)[0] & {
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
	async function heatmapApsForFloor(floorId: string): Promise<HeatmapSourceAp[]> {
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

	// Sync heatmap APs — current floor plus every other floor's, as fixed sources.
	/** Guards the async mask lookup against a superseded run publishing late. */
	let heatmapApsVersion = 0;
	$effect(() => {
		if (!heatmapLayer) return;
		trackHeatmapInputs();
		const floorId = floorState.currentFloorId;
		const version = ++heatmapApsVersion;
		void (async () => {
			let resolved: HeatmapSourceAp[];
			try {
				resolved = await heatmapApsForFloor(floorId);
			} catch (err) {
				// A floor whose mask cannot be read must not take the heatmap down with
				// it: fall back to this floor's own APs, which is what the layer drew
				// before any of this existed.
				console.warn(
					'[heatmap] could not read a floor\'s wall mask; those cross-floor paths ' +
						"fall back to this floor's walls, which is the old single-run model.",
					err
				);
				resolved = apState.aps.filter((ap) => ap.floorId === floorId);
			}
			if (version !== heatmapApsVersion) return;
			heatmapLayer.aps = resolved;
			// Same mask identity the tiled overview uses for this floor, so the two
			// views share cached attenuation fields instead of invalidating each
			// other's. A stale value here is harmless: a wall edit clears the cache.
			heatmapLayer.maskTag = `floor:${floorId}`;
			engine.markDirty();
		})();
	});

	// Sync heatmap display settings — only tracks projectMeta
	$effect(() => {
		if (!heatmapLayer) return;
		heatmapLayer.ispSpeed = projectMeta.ispSpeed;
		heatmapLayer.rssiFloor = projectMeta.heatmapRssiFloor;
		engine.markDirty();
	});

	/**
	 * Raised surfaces of the floor on screen, for the heatmap's height field.
	 *
	 * Its own effect rather than part of the decode: a surface can be drawn or edited
	 * without the walls changing at all, and the layer's cache key carries them, so the
	 * image is rebuilt on the next frame rather than on the next decode.
	 */
	$effect(() => {
		if (!heatmapLayer) return;
		const floor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
		heatmapLayer.surfaces = floor?.surfaces ?? [];
		engine.markDirty();
	});

	// Coarser wall grid while dragging, for responsiveness
	$effect(() => {
		if (!heatmapLayer) return;
		heatmapLayer.isDragging = canvasState.isDragging;
		engine.markDirty();
	});

	// Floor → legacy atoms: load current floor's data into legacy atoms on switch
	let lastSyncedFloorId = '';
	$effect(() => {
		const id = floorState.currentFloorId;
		if (id === lastSyncedFloorId) return;

		// Before switching: save current legacy state back to the outgoing floor
		if (lastSyncedFloorId) {
			const outgoing = floorState.floors.find((f) => f.id === lastSyncedFloorId);
			if (outgoing) {
				outgoing.floorplanUrl = floorplanState.floorplanUrl;
				outgoing.floorplanScale = floorplanState.floorplanScale;
				outgoing.calibration = floorplanState.calibration;
				outgoing.floorplanBoundary = floorplanState.floorplanBoundary;
				outgoing.wallMask = wallState.wallMask;
				outgoing.wallAttenuation = wallState.wallAttenuation;
				outgoing.wallMaterial = wallState.wallMaterial;
				outgoing.materialMask = wallState.materialMask;
				outgoing.roomTypeMask = wallState.roomTypeMask;
			}
		}

		// Load incoming floor's data into legacy atoms
		const floor = currentFloor();
		floorplanState.floorplanUrl = floor.floorplanUrl;
		floorplanState.floorplanScale = floor.floorplanScale;
		floorplanState.calibration = floor.calibration;
		floorplanState.floorplanBoundary = floor.floorplanBoundary;
		wallState.wallMask = floor.wallMask;
		wallState.wallAttenuation = floor.wallAttenuation;
		wallState.wallMaterial = floor.wallMaterial;
		wallState.materialMask = floor.materialMask;
		wallState.roomTypeMask = floor.roomTypeMask;

		// Force wall mask re-decode on floor switch (prevent stale cache).
		// Clear renderer references immediately so stale wall data from
		// the previous floor doesn't render while the decode is in-flight.
		lastWallMaskUrl = null;
		lastMatMaskUrl = null;
		lastRoomTypeMaskUrl = null;
		// The origin markers are part of the same cache key and have to be cleared
		// with the URLs, or the decode effect compares a fresh mask's origin
		// against the previous floor's.
		lastWallMaskOriginX = Number.NaN;
		lastWallMaskOriginY = Number.NaN;
		cachedWallData = null;
		cachedMaterialData = null;
		cachedWallLabels = null;
		cachedInterior = null;
		cachedRoomLabels = null;
		cachedRoomTypeData = null;
		if (wallLayer) {
			wallLayer.mask = null;
			wallLayer.materialMap = null;
			wallLayer.invalidateCache();
		}
		if (heatmapLayer) {
			heatmapLayer.wallMask = null;
			heatmapLayer.materialMap = null;
			// The incoming floor's mask is about to be decoded. Generating a heatmap
			// against no walls in the meantime is a full, expensive image that the
			// decode immediately replaces — see `maskPending` in the layer.
			heatmapLayer.maskPending = floorState.floors.some((f) => f.id === id && !!f.wallMask);
			heatmapLayer.markWallsDirty();
		}
		if (roomLabelsLayer) {
			roomLabelsLayer.roomTypeData = null;
			roomLabelsLayer.roomLabels = null;
			roomLabelsLayer.invalidateCache();
		}

		lastSyncedFloorId = id;
		clearSelection();

		// Immediately show cached coverage for this floor (recomputed after decode)
		const fc = floorCoverage.get(id);
		optimizerState.coverage = fc?.coverage ?? 0;

		engine?.markDirty();
	});

	// When wall mask changes, invalidate heatmap wall cache
	$effect(() => {
		if (!heatmapLayer) return;
		wallState.wallMask; // track
		heatmapLayer.markWallsDirty();
		engine.markDirty();
	});

	// Sync wall material to renderers — only tracks wallState.wallMaterial
	$effect(() => {
		if (!wallLayer || !heatmapLayer) return;
		const id = wallState.wallMaterial;
		wallLayer.defaultMaterial = id;
		wallLayer.invalidateCache();
		heatmapLayer.defaultMaterial = id;
		heatmapLayer.materialVersion++;
		heatmapLayer.markWallsDirty();
		engine.markDirty();
	});

	// Decode wall mask + material mask — tracks wallState URLs
	let wallMaskVersion = 0;
	let lastWallMaskUrl: string | null = null;
	let lastMatMaskUrl: string | null = null;
	// The decode effect used to key on the data URLs alone, so moving a floor
	// (`translateFloor` shifts the mask origin without touching the pixels) left
	// the wall layer rendering at the old origin. Track the origin too.
	let lastWallMaskOriginX = Number.NaN;
	let lastWallMaskOriginY = Number.NaN;
	$effect(() => {
		if (!wallLayer || !heatmapLayer) return;
		const mask = wallState.wallMask;
		const matMask = wallState.materialMask;

		// Skip re-decode if the data URLs and the origin are all unchanged. The
		// origin matters because aligning a floor moves the mask without changing
		// a single pixel.
		const wallUrl = mask?.dataUrl ?? null;
		const matUrl = matMask?.dataUrl ?? null;
		const originX = mask?.originX ?? 0;
		const originY = mask?.originY ?? 0;
		if (
			wallUrl === lastWallMaskUrl &&
			matUrl === lastMatMaskUrl &&
			originX === lastWallMaskOriginX &&
			originY === lastWallMaskOriginY &&
			cachedWallData
		)
			return;
		lastWallMaskUrl = wallUrl;
		lastMatMaskUrl = matUrl;
		lastWallMaskOriginX = originX;
		lastWallMaskOriginY = originY;

		console.info(
			`[walls] decode start: mask ${mask?.width ?? 0}x${mask?.height ?? 0} at ${originX},${originY}`
		);

		wallMaskVersion++;
		invalidateSolverMaskCache();
		const thisVersion = wallMaskVersion;

		if (!mask) {
			wallLayer.mask = null;
			heatmapLayer.wallMask = null;
			// There is no mask coming: this floor has no plan, so a wall-less heatmap is
			// the real answer and must not be suppressed.
			heatmapLayer.maskPending = false;
			cachedWallData = null;
			cachedWallLabels = null;
			cachedMaterialData = null;
			cachedInterior = null;
			cachedRoomLabels = null;
			cachedRoomTypeData = null;
			if (roomLabelsLayer) {
				roomLabelsLayer.roomTypeData = null;
				roomLabelsLayer.roomLabels = null;
				roomLabelsLayer.invalidateCache();
			}
			engine.markDirty();
			return;
		}

		const wallPromise = decodeMask(mask.dataUrl, mask.width, mask.height);
		const matPromise = matMask ? decodeMaterialMask(matMask.dataUrl, matMask.width, matMask.height) : null;

		wallPromise.then(async (decoded) => {
			if (wallMaskVersion !== thisVersion) return;
			const matData = matPromise ? await matPromise : null;
			if (wallMaskVersion !== thisVersion) return;

			// Propagate the stored origin to the decoded mask, snapped to whole
			// pixels. The origin comes from the alignment offset, which is
			// `dragDistance / zoom` and therefore fractional, but it is used as a
			// pixel address: the renderer places the raster at it and every kernel
			// reads it at it, so the two have to agree on one integer.
			decoded.originX = Math.round(mask.originX ?? 0);
			decoded.originY = Math.round(mask.originY ?? 0);

			const defaultMat = wallState.wallMaterial;

			wallLayer.mask = decoded;
			wallLayer.materialMap = matData ?? null;
			wallLayer.defaultMaterial = defaultMat;
			heatmapLayer.wallMask = decoded;
			heatmapLayer.materialMap = matData ?? null;
			heatmapLayer.defaultMaterial = defaultMat;
			heatmapLayer.wallAttenuation = wallState.wallAttenuation;
			// The mask it was waiting for is here, so generation may proceed.
			heatmapLayer.maskPending = false;
			setApWallMask(decoded);

			cachedWallData = decoded.data;
			cachedMaskOriginX = decoded.originX;
			cachedMaskOriginY = decoded.originY;
			cachedWallLabels = labelWallBlobs(decoded.data, decoded.width, decoded.height);
			cachedMaterialData = matData ?? null;

			// Compute building interior + room labels for room type detection
			const interiorResult = computeBuildingInterior(decoded.data, decoded.width, decoded.height, { maxDim: 400 });
			cachedInterior = interiorResult.interior;
			cachedRoomLabels = labelRooms(cachedInterior, decoded.width, decoded.height);

			// Decode room type mask if persisted
			const rtMask = wallState.roomTypeMask;
			if (rtMask && rtMask.width === decoded.width && rtMask.height === decoded.height) {
				const rtData = await decodeMaterialMask(rtMask.dataUrl, rtMask.width, rtMask.height);
				if (wallMaskVersion !== thisVersion) return;
				cachedRoomTypeData = rtData;
			} else {
				cachedRoomTypeData = null;
			}

			// Feed room data to renderer
			if (roomLabelsLayer) {
				roomLabelsLayer.roomTypeData = cachedRoomTypeData;
				roomLabelsLayer.roomLabels = cachedRoomLabels;
				roomLabelsLayer.maskWidth = decoded.width;
				roomLabelsLayer.maskHeight = decoded.height;
				roomLabelsLayer.originX = decoded.originX;
				roomLabelsLayer.originY = decoded.originY;
				roomLabelsLayer.densityOverrides = currentFloor().roomDensityOverrides;
				roomLabelsLayer.customLabels = currentFloor().roomCustomLabels ?? {};
				roomLabelsLayer.invalidateCache();
			}

			engine.markDirty();
		}).catch((err) => {
			// Without this the chain failed silently, so a plan whose walls never
			// appeared arrived with no explanation of why the decode never finished.
			console.error(
				'[walls] floorplan decode failed. The plan then has no walls to measure ' +
					'against, so coverage and the heatmap read as empty rather than as wrong.',
				err
			);
		});
	});


	$effect(() => {
		if (!wallLayer) return;
		/*
		 * The raster wall layer is the *derived* band, so it is only drawn when the segments
		 * are not — a floor whose walls are still only a detected raster.
		 *
		 * With segments it was a second copy of the same walls under the vector layer: a
		 * full-resolution coloured raster blitted on every frame, and the thing the user saw
		 * as "a hand-drawn layer under the wall lines". It was also most of the cost of a
		 * drag — the raster is a whole-plan image, the segments are a handful of strokes.
		 */
		const floor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
		const hasSegments = (floor?.walls ?? []).length > 0 || (floor?.columns ?? []).length > 0;
		wallLayer.visible =
			appState.floorView === 'single' && appState.showWalls && !hasSegments;
		engine.markDirty();
	});

	$effect(() => {
		if (!roomLabelsLayer) return;
		roomLabelsLayer.visible = appState.floorView === 'single' && appState.showRoomLabels;
		engine.markDirty();
	});

	// Decode room type mask independently of wall mask (handles undo/redo, floor switch)
	let lastRoomTypeMaskUrl: string | null = null;
	$effect(() => {
		if (!roomLabelsLayer) return;
		const rtMask = wallState.roomTypeMask;
		const rtUrl = rtMask?.dataUrl ?? null;
		if (rtUrl === lastRoomTypeMaskUrl) return;
		lastRoomTypeMaskUrl = rtUrl;

		const mask = wallState.wallMask;
		if (!rtMask || !mask || rtMask.width !== mask.width || rtMask.height !== mask.height) {
			cachedRoomTypeData = null;
			roomLabelsLayer.roomTypeData = null;
			roomLabelsLayer.invalidateCache();
			engine.markDirty();
			return;
		}

		decodeMaterialMask(rtMask.dataUrl, rtMask.width, rtMask.height).then((rtData) => {
			if (wallState.roomTypeMask?.dataUrl !== rtMask.dataUrl) return; // stale
			cachedRoomTypeData = rtData;
			roomLabelsLayer.roomTypeData = rtData;
			roomLabelsLayer.roomLabels = cachedRoomLabels;
			roomLabelsLayer.densityOverrides = currentFloor().roomDensityOverrides;
			roomLabelsLayer.customLabels = currentFloor().roomCustomLabels ?? {};
			roomLabelsLayer.invalidateCache();
			engine.markDirty();
		});
	});


	$effect(() => {
		if (!apLayer) return;
		apLayer.showLabels = appState.showLabels;
		engine.markDirty();
	});

	$effect(() => {
		if (!floorplanLayer) return;
		floorplanLayer.visible = appState.floorView === 'single' && appState.showFloorplan;
		engine.markDirty();
	});

	$effect(() => {
		if (!apLayer) return;
		apLayer.visible = appState.floorView === 'single' && appState.showAPs;
		engine.markDirty();
	});

	// Sync floorplan image to layer
	$effect(() => {
		if (!floorplanLayer) return;
		const url = floorplanState.floorplanUrl;
		// Where this floor's underlay sits in the shared world frame. Read here
		// rather than inside loadImage because the offset can change without the
		// image changing (that is the whole point of aligning floors).
		const floor = currentFloor();
		floorplanLayer.offsetX = floor?.floorplanOffsetX ?? 0;
		floorplanLayer.offsetY = floor?.floorplanOffsetY ?? 0;
		if (url) {
			floorplanLayer.loadImage(url, () => {
				// Auto-fit to floorplan bounds on load — single-floor view only.
				//
				// Switching floors re-runs this effect, so the callback fires again
				// with the new floor's plan. In the tiled overview the floors are laid
				// out in one world frame starting at the origin, which is also where
				// every floor's own plan is drawn, so fitting here sent the camera
				// onto the first tile's corner whichever card was clicked. The tiled
				// view does its own fit, in `StatusBar`, from the sheet's bounds.
				if (appState.floorView === 'single' && floorplanLayer.imageWidth > 0) {
					const rect = engine.canvas.getBoundingClientRect();
					engine.camera.fitToBounds(
						[
							{ x: floorplanLayer.offsetX, y: floorplanLayer.offsetY },
							{
								x: floorplanLayer.offsetX + floorplanLayer.imageWidth,
								y: floorplanLayer.offsetY + floorplanLayer.imageHeight
							}
						],
						rect.width,
						rect.height
					);
				}
				engine.markDirty();
			});
		} else {
			floorplanLayer.clearImage();
		}
		engine.markDirty();
	});

	/*
	 * Redraw on a language change: the canvas draws room pills and the empty-state hint
	 * itself, so nothing else would tell the engine that its pixels are stale.
	 */
	$effect(() => {
		void i18nState.locale;
		engine.markDirty();
	});

	/*
	 * Same for the propagation environment: the heatmap's levels, every coverage circle and
	 * every AP radius are drawn from the distance term, so switching it makes every cached
	 * pixel stale and nothing else would say so.
	 */
	$effect(() => {
		void projectMeta.pathLossScenario;
		engine.markDirty();
	});

	/*
	 * The project can arrive with an access point outside the walls, and the check needs the
	 * mask — which is not decoded yet when the project is restored. This runs it once the
	 * mask is there, and again whenever the walls or any access point's position changes:
	 * the notice is about where an access point sits, so dragging one back inside has to
	 * clear it, and reading the coordinates is what makes that a dependency.
	 */
	$effect(() => {
		void wallState.wallMask;
		// The verdict is about every floor's mask, not the one on screen: an access point on
		// Floor 4 is judged against Floor 4's, which a re-detect replaces without the live
		// mask changing at all. Without these dependencies the notice could stand from a
		// geometry that no longer exists — which is how a point that the app itself now
		// calls inside was still being reported as outside the building.
		void floorState.currentFloorId;
		for (const floor of floorState.floors) void floor.wallMask;
		for (const ap of apState.aps) {
			void ap.x;
			void ap.y;
			void ap.floorId;
		}
		// While a wall is being drawn the mask is a draft. Judging against a half-drawn
		// wall accuses points that are inside the moment the segment is committed, and the
		// notice is not worth showing for a geometry the user has not finished describing.
		if (appState.wallVectorDraft) {
			appState.outsideNotice = null;
			return;
		}
		/*
		 * Not on every frame of a drag either.
		 *
		 * This is an async pass over every access point (mask lookup, interior cache, the
		 * planning area) and it re-runs on each position write — thirty to a hundred times a
		 * second. Its answer cannot change meaningfully between two frames of one drag, and
		 * `canvasState.isDragging` is reactive, so the check runs once when the pointer comes
		 * up and the notice is right by the time the user looks at it.
		 */
		if (canvasState.isDragging) return;
		let cancelled = false;
		void (async () => {
			const outside = await apsOutsideInterior();
			if (cancelled) return;
			// The state module must not import app state — that path is a cycle through
			// persistence — so the notice is set here, where it can also be rendered.
			// Its own slot: this runs whenever walls or access points move, and the
			// transient refusal a click produces must survive that.
			appState.outsideNotice =
				outside.length === 0
					? null
					: t(
							'{count} access point(s) are outside the building: {names}. Re-run the optimiser, move them, or turn on "Allow APs outside rooms".',
							{ count: outside.length, names: outside.join(', ') }
						);
		})();
		return () => {
			cancelled = true;
		};
	});

	// Ghost of the floor below.
	//
	// Two floors live in the same world frame, so if their plans disagree there
	// is no way to notice while looking at one floor on its own. This overlays
	// the reference floor's underlay and wall silhouette so the disagreement is
	// visible while the alignment is nudged.
	//
	// The reference floor's *current* offsets are read here rather than the
	// stored ones: translating a floor mutates the stored mask origin and the
	// underlay offset in place, and those are `$state`, so this re-runs.
	$effect(() => {
		if (!referenceFloorLayer || !engine) return;
		const show = appState.showFloorBelow;
		const below = show ? floorBelowCurrent() : null;
		referenceFloorLayer.visible = appState.floorView === 'single' && !!below;
		if (!below) {
			referenceFloorLayer.setPlan(null, 0, 0);
			referenceFloorLayer.setMask(null, 0, 0);
			engine.markDirty();
			return;
		}
		referenceFloorLayer.setPlan(
			below.floorplanUrl,
			below.floorplanOffsetX,
			below.floorplanOffsetY
		);
		const mask = below.wallMask;
		referenceFloorLayer.setMask(mask?.dataUrl ?? null, mask?.originX ?? 0, mask?.originY ?? 0);
		engine.markDirty();
	});

	// Tiled overview: one read-only card per floor.
	//
	// Rebuilt from state every time anything about a floor changes, so a card
	// cannot show stale geometry. The layout is recomputed inside the layer on
	// each render for the same reason.
	$effect(() => {
		if (!floorTilesLayer || !stackedFloorsLayer || !engine || !floor3DLayer) return;
		// Both overviews are read-only layouts of the same cards, so they share the
		// layer toggles, the underlay alpha and the source list; only one is visible
		// at a time.
		const overview = appState.floorView !== 'single';
		const stacked = appState.floorView === 'stacked';
		floorTilesLayer.visible = appState.floorView === 'tiled';
		stackedFloorsLayer.visible = stacked;
		floor3DLayer.visible = appState.floorView === 'floor3d';
		if (!overview) return;
		// One opacity value for the whole app. It lives on `floorplanScale`, which
		// the single-floor view already used for it, and the cards borrow the
		// current floor's setting so the views stay in step. Two sliders used
		// to write two different variables and fight over the layer's alpha.
		const sources = floorState.floors.map((f) => ({
			id: f.id,
			name: f.name,
			planUrl: f.floorplanUrl,
			planOffsetX: f.floorplanOffsetX,
			planOffsetY: f.floorplanOffsetY,
			maskUrl: f.wallMask?.dataUrl ?? null,
			// The overviews colour walls from the same two rasters the plan does: without
			// the material map they could only draw the mask, which is white walls on
			// transparent, and every material looked alike up there.
			materialUrl: f.materialMask?.dataUrl ?? null,
			defaultMaterial: f.wallMaterial ?? 0,
			maskOriginX: f.wallMask?.originX ?? 0,
			maskOriginY: f.wallMask?.originY ?? 0,
			maskWidth: f.wallMask?.width ?? 0,
			maskHeight: f.wallMask?.height ?? 0,
			aps: apState.aps
				.filter((ap) => ap.floorId === f.id)
				.map((ap) => ({
					x: ap.x,
					y: ap.y,
					// Carried so an overview can colour the marker the way the plan does,
					// shape it the way the plan does, and lift it off the floor by where
					// the AP actually hangs.
					assignedChannel: ap.assignedChannel,
					band: ap.band,
					mountHeightM: apHeightAboveFloor(ap),
					mount: ap.mount,
					facingDeg: ap.facingDeg
				})),
			// Only the stacked view uses this, and it is derived rather than stored:
			// see `floorElevation`.
			elevation: floorElevation(f.id)
		}));
		for (const layer of [floorTilesLayer, stackedFloorsLayer]) {
			layer.planOpacity = floorplanState.floorplanScale;
			// The LAYERS panel has to mean the same thing in every view. The
			// single-floor layers are hidden here, so without this the toggles changed
			// nothing on screen and the panel looked broken.
			layer.showPlan = appState.showFloorplan;
			layer.showWalls = appState.showWalls;
			layer.showAPs = appState.showAPs;
			layer.showHeatmap = appState.showHeatmap;
		}
		floorTilesLayer.setFloors(sources, floorState.currentFloorId);
		stackedFloorsLayer.setFloors(sources, floorState.currentFloorId, getEffectiveWupm());
		/*
		 * The 3D view is one floor, so it takes its card source and the geometry that floor
		 * stands up: its wall segments and its raised surfaces. The camera is the same
		 * object the stacked view uses, so a viewpoint chosen in one is the viewpoint in
		 * the other — switching between them does not throw the user's orientation away.
		 */
		const view3dFloor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
		floor3DLayer.source = sources.find((s) => s.id === floorState.currentFloorId) ?? null;
		floor3DLayer.walls = (view3dFloor?.walls ?? []) as VectorWall[];
		floor3DLayer.columns = (view3dFloor?.columns ?? []) as VectorColumn[];
		floor3DLayer.surfaces = view3dFloor?.surfaces ?? [];
		floor3DLayer.ceilingHeightM = view3dFloor?.ceilingHeight ?? 3;
		floor3DLayer.planOpacity = floorplanState.floorplanScale;
		floor3DLayer.showPlan = appState.showFloorplan;
		floor3DLayer.showWalls = appState.showWalls;
		floor3DLayer.showAPs = appState.showAPs;
		floor3DLayer.showHeatmap = appState.showHeatmap;
		// Where the stack is being looked at from. Handed over here so the layer has
		// no opinion about where the sliders live; the camera object is replaced
		// rather than mutated so the layer cannot be left half-updated.
		const stackCamera = {
			yaw: (appState.stackYaw * Math.PI) / 180,
			pitch: Math.min((appState.stackPitch * Math.PI) / 180, MAX_PITCH),
			spacing: appState.stackSpread,
			wupm: getEffectiveWupm()
		};
		stackedFloorsLayer.camera = stackCamera;
		floor3DLayer.camera = stackCamera;
		// Focusing hides floors, and a hidden slab must not stay clickable — the
		// filter runs in the layout the hit test reads, so the hover has to be
		// dropped with it rather than left pointing at a floor that is gone.
		if (stackedFloorsLayer.focus !== appState.stackFocus) {
			stackedFloorsLayer.focus = appState.stackFocus;
			stackedFloorsLayer.hoverFloorId = null;
		}
		engine.markDirty();
	});

	// Sync floorplan opacity (stored in floorplanScale)
	$effect(() => {
		if (!floorplanLayer) return;
		floorplanLayer.opacity = floorplanState.floorplanScale;
		engine.markDirty();
	});

	/**
	 * Per-floor coverage for the overview views.
	 *
	 * `generateWorld` is synchronous and covers a whole floor, so generating every
	 * floor in one pass would freeze the frame for as long as there are floors.
	 * One floor per animation frame fills the overview in progressively instead, and
	 * each result is kept until its inputs change. Both the contact sheet and the
	 * stack read the same map, so switching between them regenerates nothing.
	 *
	 * The masks are decoded per floor on demand rather than kept around: a floor's
	 * heatmap is one canvas, but its decoded mask is a byte per pixel, so holding
	 * every floor's would cost far more than the thing being cached.
	 */
	const tileHeatKeys = new Map<string, string>();
	let tileHeatWarming = false;

	/**
	 * Identity for a stored mask, so a cache key can notice it was replaced.
	 *
	 * The key used to concatenate the masks' data URLs, which are megabytes: every
	 * key build copied all of them. Nothing about the *contents* is needed, only
	 * "is this the same mask as last time", and an edited mask is a new object.
	 */
	const tileMaskIds = new WeakMap<object, number>();
	let nextTileMaskId = 0;
	function maskTag(mask: object | null | undefined): number {
		if (!mask) return 0;
		let id = tileMaskIds.get(mask);
		if (id === undefined) {
			id = ++nextTileMaskId;
			tileMaskIds.set(mask, id);
		}
		return id;
	}

	/**
	 * World units per metre for the coverage images: one scale for the project.
	 *
	 * The project has a single scale, floor 1's (see `getEffectiveWupm`), and a
	 * coverage image's level model converts world distance to metres with it.
	 * Reading the *selected* floor's scale here made every card's field depend on
	 * which card was selected: clicking one card rescaled the others' coverage
	 * (levels move by `40·log10(wupm ratio)` dB — 12 dB for a 2x difference), and
	 * because the image's bounds derive from the same scale the texel budget could
	 * be exceeded too, rendering that tile as flat colour blocks.
	 */
	function projectWupm(): number {
		return getEffectiveWupm();
	}

	/**
	 * What one floor's thumbnail depends on.
	 *
	 * Every AP, not just this floor's: a neighbouring floor's AP shows up on this
	 * tile, so moving it has to invalidate this tile too. And every floor's masks,
	 * for the same reason — they are the cross-floor path's other half, and any of
	 * them can be the one whose slab the ray crosses.
	 */
	function tileHeatKey(floor: Floor): string {
		const aps = apState.aps
			.map(
				(a) =>
					`${a.id}:${Math.round(a.x)}:${Math.round(a.y)}:${a.interferenceRadius}:${a.band}:${a.channelWidth}:${a.power}:${a.floorId}:` +
					// Where the AP is mounted is part of the geometry, so a tile built
					// under one mounting must not stand in for another — and the antenna's
					// own cuts belong in the key for the same reason, including the
					// mounting that decides whether there is a horizontal cut at all.
					`${a.mountHeightM}:${antennaSignature(a)}`
			)
			.join('|');
		const floors = floorState.floors
			.map(
				(f) =>
					`${f.id}:${f.level}:${f.ceilingHeight}:${f.floorThickness}:${f.floorMaterial}:${f.wallMaterial}` +
					`:w${maskTag(f.wallMask)}:m${maskTag(f.materialMask)}:r${maskTag(f.roomTypeMask)}`
			)
			.join('|');
		return (
			`${aps}|${floors}` +
			`|self:${maskTag(floor.wallMask)}:${floor.wallMask?.originX ?? 0},${floor.wallMask?.originY ?? 0}` +
			// This floor's own scale, not the selected floor's.
			`|rssi:${projectMeta.heatmapRssiFloor}|wupm:${projectWupm()}|ch:${projectMeta.clientHeight}`
		);
	}

	/**
	 * One floor's thumbnail.
	 *
	 * The sources are assembled by the same function the single-floor view uses, so a
	 * floor with no APs of its own still shows the floors around it.
	 */
	async function buildTileHeatmap(
		floor: Floor
	): Promise<{ canvas: HTMLCanvasElement; x0: number; y0: number; texel: number } | null> {
		if (!heatmapLayer) return null;
		const stored = floor.wallMask;
		if (!stored) return null;
		// `decodeMask` only turns a data URL back into pixels, so it always
		// reports origin (0, 0); the stored origin is what places it in the world.
		const mask = await decodeMask(stored.dataUrl, stored.width, stored.height);
		mask.originX = stored.originX ?? 0;
		mask.originY = stored.originY ?? 0;
		let material: Uint8Array | null = null;
		const matMask = floor.materialMask;
		if (matMask && matMask.width === mask.width && matMask.height === mask.height) {
			material = await decodeMaterialMask(matMask.dataUrl, matMask.width, matMask.height);
		}
		const aps = await heatmapApsForFloor(floor.id);
		if (aps.length === 0) return null;
		return heatmapLayer.generateFor({
			aps,
			wallMask: mask,
			materialMap: material,
			defaultMaterial: floor.wallMaterial,
			// This floor's own calibration: the image is in its world units.
			worldUnitsPerMeter: projectWupm(),
			rssiFloor: projectMeta.heatmapRssiFloor,
			// Which floor's walls these are: the attenuation-field cache is keyed on
			// position and radius, so without this a tile inherits whichever floor's
			// field was built first for that cell.
			maskTag: `floor:${floor.id}`,
			// A mezzanine on that floor changes the picture even though nothing moved.
			surfaces: floor.surfaces ?? []
		});
	}

	async function warmTileHeatmaps(): Promise<void> {
		if (tileHeatWarming || !floorTilesLayer || !engine) return;
		tileHeatWarming = true;
		try {
			for (;;) {
				if (appState.floorView === 'single' || !appState.showHeatmap) return;
				let nextFloor: Floor | null = null;
				for (const f of floorState.floors) {
					// A floor with no APs of its own still shows the ones around it, so
					// the only floors with nothing to draw are those with no plan.
					if (!f.wallMask) continue;
					if (tileHeatKeys.get(f.id) === tileHeatKey(f)) continue;
					nextFloor = f;
					break;
				}
				if (!nextFloor) return;
				// Recorded before the await, so a re-entrant call does not queue the
				// same floor twice.
				tileHeatKeys.set(nextFloor.id, tileHeatKey(nextFloor));
				const image = await buildTileHeatmap(nextFloor);
				if (image) floorTilesLayer.heatmaps.set(nextFloor.id, image);
				else floorTilesLayer.heatmaps.delete(nextFloor.id);
				engine?.markDirty();
				// Yield a frame so the sheet stays interactive between floors.
				await new Promise((r) => requestAnimationFrame(() => r(null)));
			}
		} finally {
			tileHeatWarming = false;
		}
	}

	$effect(() => {
		// Read everything the cache key depends on, so any change restarts the
		// warm and the affected cards refresh.
		if (appState.floorView === 'single' || !appState.showHeatmap) return;
		trackHeatmapInputs();
		void projectMeta.heatmapRssiFloor;
		void getEffectiveWupm();
		// Drop keys for floors that no longer exist, for the same reason the layer
		// drops their canvases: otherwise a deleted floor's key keeps its entry for
		// the rest of the session.
		const live = new Set(floorState.floors.map((f) => f.id));
		for (const id of [...tileHeatKeys.keys()]) {
			if (!live.has(id)) tileHeatKeys.delete(id);
		}
		void warmTileHeatmaps();
	});


	// Auto-solve: debounce solver runs when AP layout, RF params, or walls change.
	// Excludes assignedChannel to avoid infinite loops (solver writes channels).
	const wupm = getEffectiveWupm();
	let autoSolveKey = $derived(
		apState.aps
			.map(
				(ap) =>
					/*
					 * The AP's position, quantised to two metres.
					 *
					 * The solver assigns channels to avoid co-channel interference, so a
					 * position does belong in the key — but a drag writes a new position on
					 * every frame, and each solve builds its graph on the main thread
					 * (`[solve] graph built in 320–516 ms`, measured). Quantising means a
					 * one-pixel nudge does not re-solve, while moving a unit to the other end
					 * of the floor does.
					 */
					`${ap.id}:${Math.round(ap.x / (2 * wupm))}:${Math.round(ap.y / (2 * wupm))}:${ap.floorId}:${ap.interferenceRadius}:${ap.band}:${ap.channelWidth}:` +
					// Where the AP is mounted is part of the geometry, so it belongs in
					// the key: a change here moves the coverage figure and, with
					// auto-solve on, the placement the solver would choose. The antenna's
					// cuts move it too — a wall mount's facing decides which half of the
					// floor it reaches. See `antennaSignature`.
					`${ap.mountHeightM}:${antennaSignature(ap)}`
			)
			.join('|') +
		`|wm:${wallMaskVersion}:${wallState.wallMaterial}` +
		// The client's height is the other end of every vertical term.
		`|mh:${projectMeta.clientHeight}`
	);

	let solverPending = false;
	$effect(() => {
		const auto = solverState.autoSolve;
		// The **only** reactive input is the key. Everything else is read untracked, and
		// that is the whole point: a solve ends by replacing `apState.aps` (to force the
		// canvas to redraw) and by flipping `isRunning`, so an effect that *depended* on
		// either re-armed another solve as soon as the previous one finished — the app
		// re-solved about twice a second, forever, with or without a change. It surfaced
		// as "nothing is ever persisted": once the solver started scheduling a save of
		// its own (the assignment is project state and has to be saved), that save was
		// cancelled by the next loop iteration every time. The key already covers the AP
		// list and the walls, so a real change still schedules exactly one solve, and a
		// change that lands during a solve is what `solverPending` records.
		const _key = autoSolveKey;
		const running = untrack(() => solverState.isRunning);
		const hasAps = untrack(() => apState.aps.length > 0);
		if (!auto || !hasAps) return;

		if (autoSolveTimeout) clearTimeout(autoSolveTimeout);
		if (running) {
			// Queue a re-run after current solve completes
			solverPending = true;
			return;
		}
		autoSolveTimeout = setTimeout(() => {
			/*
			 * On an idle frame: the solve builds its conflict graph on the main thread
			 * (measured at 344–512 ms before the graph was cached), and the debounce alone
			 * still landed it on a frame the user was about to need.
			 */
			if (typeof requestIdleCallback === 'function') {
				requestIdleCallback(() => runSolver(), { timeout: 2000 });
			} else {
				runSolver();
			}
		}, 1200);
	});

	// Re-run solver when a queued solve was pending
	$effect(() => {
		if (!solverState.isRunning && solverPending) {
			solverPending = false;
			if (autoSolveTimeout) clearTimeout(autoSolveTimeout);
			autoSolveTimeout = setTimeout(() => {
				runSolver();
			}, 200);
		}
	});


	// Update coverage score when APs or wall mask change
	let coverageTimeout: ReturnType<typeof setTimeout> | null = null;
	$effect(() => {
		const _key = autoSolveKey;
		const _mask = wallState.wallMask;
		const _rtMask = wallState.roomTypeMask;
		if (apState.aps.length === 0 || !_mask) return;
		if (coverageTimeout) clearTimeout(coverageTimeout);
		coverageTimeout = setTimeout(() => updateCoverage(), 300);
	});

	// Track pending placement vs pan gesture
	const DRAG_THRESHOLD = 5;
	let pendingPlace = false;
	let pendingPan = false;
	let pointerStartX = 0;
	let pointerStartY = 0;
	let activeTouches = 0;

	// Single-finger state
	let touchStartX = 0;
	let touchStartY = 0;
	let touchMoved = false;
	let touchStartedOnAp = false;

	// Two-finger pinch state
	let pinchLastDist = 0;
	let pinchLastCx = 0;
	let pinchLastCy = 0;
	let pinchFrames = 0;

	function handleTouchStart(e: TouchEvent) {
		activeTouches = e.touches.length;

		if (activeTouches === 1) {
			const t = e.touches[0]!;
			touchStartX = t.clientX;
			touchStartY = t.clientY;
			touchMoved = false;
			touchStartedOnAp = false;
			pendingPan = false;
			longPressFired = false;

			// Start long-press timer for contextual wall/room actions
			if (longPressTimer) clearTimeout(longPressTimer);
			const lpX = t.clientX;
			const lpY = t.clientY;
			longPressTimer = setTimeout(() => {
				longPressTimer = null;
				if (touchMoved || activeTouches !== 1) return;
				if (!engine) return;
				const rect = engine.canvas.getBoundingClientRect();
				const sx = lpX - rect.left;
				const sy = lpY - rect.top;
				if (handleContextAction(sx, sy)) {
					longPressFired = true;
				}
			}, LONG_PRESS_MS);
		} else if (activeTouches >= 2) {
			e.preventDefault();
			// Cancel long-press and single-finger state
			if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
			pendingPan = false;
			touchStartedOnAp = false;
			touchMoved = true;
			dragHandler.handlePointerUp();
			// Initialize pinch
			pinchFrames = 0;
			pinchLastDist = 0;
		}
	}

	function handleTouchMove(e: TouchEvent) {
		if (!engine) return;

		// Two-finger: pinch zoom + pan
		if (e.touches.length === 2) {
			e.preventDefault();
			const t0 = e.touches[0]!;
			const t1 = e.touches[1]!;
			const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
			const cx = (t0.clientX + t1.clientX) / 2;
			const cy = (t0.clientY + t1.clientY) / 2;

			pinchFrames++;
			if (pinchFrames <= 2) {
				// Baseline frames: record, don't apply
				pinchLastDist = dist;
				pinchLastCx = cx;
				pinchLastCy = cy;
				return;
			}

			// Zoom
			if (pinchLastDist > 0) {
				const factor = dist / pinchLastDist;
				const rect = engine.canvas.getBoundingClientRect();
				engine.camera.zoomAt({ x: cx - rect.left, y: cy - rect.top }, factor);
			}

			// Pan
			engine.camera.pan(
				(cx - pinchLastCx) / engine.camera.state.zoom,
				(cy - pinchLastCy) / engine.camera.state.zoom
			);

			pinchLastDist = dist;
			pinchLastCx = cx;
			pinchLastCy = cy;
			engine.markDirty();
			return;
		}

		// Single-finger
		if (e.touches.length !== 1) return;
		const t = e.touches[0]!;

		const dx = t.clientX - touchStartX;
		const dy = t.clientY - touchStartY;

		if (!touchMoved && !touchStartedOnAp && !pendingPan && dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) {
			touchMoved = true;
			if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
			const rect = engine.canvas.getBoundingClientRect();
			const hit = hitTest({ x: touchStartX - rect.left, y: touchStartY - rect.top }, engine.camera, apState.aps.filter(ap => ap.floorId === floorState.currentFloorId));

			if (hit) {
				touchStartedOnAp = true;
				const synth = new PointerEvent('pointerdown', { clientX: touchStartX, clientY: touchStartY, button: 0 });
				selectHandler.handlePointerDown(synth);
				dragHandler.handlePointerDown(synth);
			} else {
				pendingPan = true;
				pointerStartX = touchStartX;
				pointerStartY = touchStartY;
			}
		}

		if (touchStartedOnAp && dragHandler.isDragging) {
			dragHandler.handlePointerMove(new PointerEvent('pointermove', { clientX: t.clientX, clientY: t.clientY }));
		} else if (pendingPan) {
			engine.camera.pan(
				(t.clientX - pointerStartX) / engine.camera.state.zoom,
				(t.clientY - pointerStartY) / engine.camera.state.zoom
			);
			pointerStartX = t.clientX;
			pointerStartY = t.clientY;
			engine.markDirty();
		}
	}

	function handleTouchEnd(e: TouchEvent) {
		if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }

		if (activeTouches === 1 && e.touches.length === 0) {
			// Skip tap action if long-press already fired a contextual popup
			if (!touchMoved && !longPressFired && engine) {
				const rect = engine.canvas.getBoundingClientRect();
				const sx = touchStartX - rect.left;
				const sy = touchStartY - rect.top;
				const hit = hitTest({ x: sx, y: sy }, engine.camera, apState.aps.filter(ap => ap.floorId === floorState.currentFloorId));

				if (hit) {
					selectHandler.handlePointerDown(new PointerEvent('pointerdown', { clientX: touchStartX, clientY: touchStartY, button: 0 }));
				} else if (appState.apPlaceMode && !handleWallClick(sx, sy)) {
					// Not an AP, not a wall — place AP. Touch follows the same mode as the
					// mouse: a tap that was meant to dismiss something must not leave an AP.
					placeHandler.handlePointerDown(new PointerEvent('pointerdown', { clientX: touchStartX, clientY: touchStartY, button: 0 }));
				}
			}
			pendingPan = false;
			touchStartedOnAp = false;
			dragHandler.handlePointerUp();
			selectHandler.handlePointerUp(new PointerEvent('pointerup'));
		}
		activeTouches = e.touches.length;
		if (activeTouches === 0) {
			pinchFrames = 0;
			pinchLastDist = 0;
		}
	}

	function processPointerDown(e: PointerEvent) {
		if (!engine) return;
		if (activeTouches >= 2) return;

		const rect = engine.canvas.getBoundingClientRect();
		const screenPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top };
		const hit = hitTest(screenPoint, engine.camera, apState.aps.filter(ap => ap.floorId === floorState.currentFloorId));

		if (hit) {
			selectHandler.handlePointerDown(e);
			dragHandler.handlePointerDown(e);
			pendingPlace = false;
			pendingPan = false;
		} else if (e.shiftKey) {
			selectHandler.handlePointerDown(e);
			pendingPlace = false;
			pendingPan = false;
		} else {
			// A drawn wall is an object: a click near one selects it — Delete removes it,
			// right-click changes its material — instead of starting a marquee. Without
			// this the only way to reach a wall was to have just drawn it.
			const floor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
			const walls = (floor?.walls ?? []) as VectorWall[];
			// A surface edge first: the outline is the only part of a mezzanine that is
			// unambiguous, and the canvas inside it stays free for placing access points.
			if (floor?.surfaces?.length) {
				const world = engine.camera.screenToWorld(screenPoint);
				const surface = surfaceEdgeNear(
					floor.surfaces,
					world.x,
					world.y,
					10 / (engine.camera.state.zoom || 1)
				);
				if (surface) {
					appState.surfaceSelected = surface.id;
					appState.wallVectorSelected = null;
					pendingPlace = false;
					pendingPan = false;
					engine.markDirty();
					return;
				}
			}
			if (walls.length > 0) {
				const world = engine.camera.screenToWorld(screenPoint);
				const wall = wallNearPoint(world, walls, 12 / (engine.camera.state.zoom || 1));
				if (wall) {
					appState.wallVectorSelected = wall.id;
					appState.wallColumnSelected = null;
					pendingPlace = false;
					pendingPan = false;
					engine.markDirty();
					return;
				}
			}
			if ((floor?.columns ?? []).length > 0) {
				const world = engine.camera.screenToWorld(screenPoint);
				const column = columnAtPoint((floor?.columns ?? []) as VectorColumn[], world);
				if (column) {
					appState.wallColumnSelected = column.id;
					appState.wallVectorSelected = null;
					pendingPlace = false;
					pendingPan = false;
					engine.markDirty();
					return;
				}
			}
			if (appState.wallVectorSelected || appState.wallColumnSelected) {
				appState.wallVectorSelected = null;
				appState.wallColumnSelected = null;
				engine.markDirty();
			}
			if (appState.surfaceSelected) {
				appState.surfaceSelected = null;
				engine.markDirty();
			}
			// A click on empty canvas adds an AP only in placement mode; otherwise it is
			// a selection gesture (click to clear, drag to marquee), which is the same
			// thing Shift+click does.
			pointerStartX = e.clientX;
			pointerStartY = e.clientY;
			pendingPan = false;
			if (appState.apPlaceMode) {
				pendingPlace = true;
			} else {
				pendingPlace = false;
				selectHandler.handlePointerDown(e);
			}
		}
	}

	/**
	 * Abandon an alignment drag without moving the floor.
	 *
	 * During the drag the movement lives entirely in the camera, so undoing it is
	 * just putting the camera back: the floor's own coordinates were never
	 * touched. The ghost's compensation is cleared with it.
	 */
	function cancelAlignDrag(): void {
		if (!alignDragging) return;
		alignDragging = false;
		if (engine) {
			engine.camera.pan(
				alignStartX - engine.camera.state.x,
				alignStartY - engine.camera.state.y
			);
			engine.markDirty();
		}
		if (referenceFloorLayer) {
			referenceFloorLayer.compensateX = 0;
			referenceFloorLayer.compensateY = 0;
		}
	}

	// Viewpoint drag for the stacked overview.
	//
	// A drag turns the view and a click picks a floor, so which one it was is decided
	// on release by how far the pointer travelled — the same threshold the canvas
	// already uses to tell a placement click from a pan.
	//
	// The angle is accumulated **incrementally**, one pointer step at a time, and
	// clamped at each step. Accumulating from the drag's origin and clamping only the
	// result looks identical until a limit is reached, and then it is wrong in a way
	// that is easy to see and hard to place: the overshoot is remembered, so pulling
	// back does nothing until the pointer has retraced it. Dragging past the limit now
	// simply stops.
	//
	// 0.4°/px, and the plan **follows the pointer** on both axes: dragging right
	// turns it with the hand (its front swings right, showing the left side), and
	// dragging down brings its near edge down the screen, which means tilting *away*
	// from the level view and back toward a plan view. That is the sign the yaw
	// already used; having the two disagree made the same gesture turn one way and
	// tilt the other.
	const ORBIT_DEG_PER_PX = 0.4;
	let orbitPointerId: number | null = null;
	let orbitStartX = 0;
	let orbitStartY = 0;
	let orbitLastX = 0;
	let orbitLastY = 0;
	let orbitYaw = 0;
	let orbitPitch = 0;
	let orbitMoved = false;

	/** Clamp to a range, for the drag's per-step limits. */
	function clamp(value: number, lo: number, hi: number): number {
		return Math.max(lo, Math.min(hi, value));
	}

	function handlePointerDown(e: PointerEvent) {
		if (!engine) return;
		if (e.button !== 0) return; // Only handle primary (left) button
		if (e.pointerType === 'touch') return;
		// In the overview views a click picks a floor; nothing edits geometry there,
		// and a *drag* turns the view rather than picking.
		if (appState.floorView !== 'single') {
			orbitPointerId = e.pointerId;
			orbitStartX = e.clientX;
			orbitStartY = e.clientY;
			orbitLastX = e.clientX;
			orbitLastY = e.clientY;
			orbitYaw = appState.stackYaw;
			orbitPitch = appState.stackPitch;
			orbitMoved = false;
			return;
		}
		// Drawing vector walls: the first click starts a segment, the second commits it.
		if (appState.wallVectorMode) {			const rect = engine.canvas.getBoundingClientRect();
			const world = engine.camera.screenToWorld({
				x: e.clientX - rect.left,
				y: e.clientY - rect.top
			});
			handleVectorWallClick(world, e.shiftKey);
			engine.markDirty();
			e.preventDefault();
			return;
		}
		// A note pin is a small target and it sits above everything: it takes the click before
		// the selection logic, whether or not note mode is on, because clicking a pin to read
		// it is the obvious gesture.
		{
			const world = engine.camera.screenToWorld({
				x: e.clientX - engine.canvas.getBoundingClientRect().left,
				y: e.clientY - engine.canvas.getBoundingClientRect().top
			});
			if (appState.noteMode) {
				addNoteAt(world);
				engine.markDirty();
				e.preventDefault();
				return;
			}
			const hit = appState.showNotes
				? noteAtPoint(currentNotes(), world, noteToleranceWorld())
				: null;
			if (hit) {
				appState.noteSelectedId = hit.id;
				engine.markDirty();
				e.preventDefault();
				return;
			}
			// A click on the plan itself drops the note selection, like every other selection.
			if (appState.noteSelectedId) appState.noteSelectedId = null;
		}
		// Drawing the planning area intercepts the primary click: each click is a corner of
		// the loop the user is stating, and nothing else uses that gesture while it is on.
		if (appState.planningDrawMode) {
			const world = engine.camera.screenToWorld({
				x: e.clientX - engine.canvas.getBoundingClientRect().left,
				y: e.clientY - engine.canvas.getBoundingClientRect().top
			});
			addPlanningPoint({ x: world.x, y: world.y });
			engine.markDirty();
			e.preventDefault();
			return;
		}
		// Drawing a raised surface: two clicks, opposite corners. The first states where it
		// starts and the second commits it, exactly like a wall — the two gestures that
		// shape the model should feel the same.
		if (appState.surfaceMode) {
			const world = engine.camera.screenToWorld({
				x: e.clientX - engine.canvas.getBoundingClientRect().left,
				y: e.clientY - engine.canvas.getBoundingClientRect().top
			});
			commitSurfaceClick(world);
			engine.markDirty();
			e.preventDefault();
			return;
		}
		// Calibrating by measurement intercepts the primary click, before placement and
		// before selection: while the mode is on, a click is a point of the measured line
		// and nothing else.
		if (appState.calibrateMode) {
			const world = engine.camera.screenToWorld({
				x: e.clientX - engine.canvas.getBoundingClientRect().left,
				y: e.clientY - engine.canvas.getBoundingClientRect().top
			});
			addCalibrationPoint({ x: world.x, y: world.y });
			engine.markDirty();
			e.preventDefault();
			return;
		}
		// Align mode intercepts the primary pointer. PanZoomHandler only pans on
		// the middle button, so a left drag here does not fight it.
		if (appState.floorAlignMode) {
			alignDragging = true;
			alignDxScreen = 0;
			alignDyScreen = 0;
			alignStartClientX = e.clientX;
			alignStartClientY = e.clientY;
			alignStartX = engine.camera.state.x;
			alignStartY = engine.camera.state.y;
			pushState();
			e.preventDefault();
			return;
		}
		processPointerDown(e);
	}

	/**
	 * Register the project's custom wall materials with the material table.
	 *
	 * One place hands the user's materials to the lookups the renderer, the march and the
	 * solver use — and the same list travels in the optimiser's payload so the worker
	 * registers its own copy. Without this a wall painted with a custom material would be
	 * charged the built-in fallback figure.
	 */
	$effect(() => {
		registerCustomMaterials(
			projectMeta.customMaterials.map((material) => ({
				id: material.id as WallMaterialId,
				name: material.name,
				dbPerMeter: {
					'2.4ghz': material.dbPerCrossing / Math.max(0.01, material.thicknessM),
					'5ghz': material.dbPerCrossing / Math.max(0.01, material.thicknessM),
					'6ghz': material.dbPerCrossing / Math.max(0.01, material.thicknessM)
				},
				typicalThickness: material.thicknessM,
				color: material.color
			}))
		);
		engine.markDirty();
	});

	/**
	 * The vector walls of the floor on screen, the one being drawn and the selected one.
	 *
	 * They are drawn *over* the mask they produce, so the model and the raster it derives
	 * can be seen together: a wall whose band looks wrong against the drawing is a
	 * rasterisation problem, and one that looks wrong against its own position is not.
	 */
	$effect(() => {
		if (!vectorWallsLayer) return;
		const floor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
		vectorWallsLayer.visible = appState.floorView === 'single';
		vectorWallsLayer.walls = (floor?.walls ?? []) as VectorWall[];
		vectorWallsLayer.columns = (floor?.columns ?? []) as VectorColumn[];
		vectorWallsLayer.selectedId = appState.wallVectorSelected;
		vectorWallsLayer.selectedColumnId = appState.wallColumnSelected;
		vectorWallsLayer.draft = appState.wallVectorDraft;
		vectorWallsLayer.columnDraft = appState.columnDraft;
		vectorWallsLayer.cursor = appState.wallVectorMode ? vectorCursor : null;
		vectorWallsLayer.snapTarget = appState.wallVectorMode ? vectorSnap : null;
		vectorWallsLayer.wupm = getEffectiveWupm();
		engine.markDirty();
	});

	/**
	 * The segments are the model, so a change to them re-derives the floor's mask.
	 *
	 * This is the whole of the merge: the drawn walls are what the app measures against,
	 * and the raster is their shadow. Debounced because tracing a plan commits dozens of
	 * segments at once and each pass is a full rasterise plus a PNG encode; the signature
	 * is what the rasterisation reads, so it is also exactly what decides whether another
	 * pass is needed.
	 */
	let wallsSyncTimer: ReturnType<typeof setTimeout> | null = null;
	let lastWallsKey = { floorId: '', signature: '' };
	$effect(() => {
		const floor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
		if (!floor) return;
		const wallsSig = (floor?.walls ?? [])
			.map((wall) => `${wall.ax},${wall.ay},${wall.bx},${wall.by},${wall.material}`)
			.join(';');
		// Columns are obstructions in the same mask, so they re-derive it too.
		const colsSig = (floor?.columns ?? [])
			.map((column) => `${column.shape},${column.ax},${column.ay},${column.bx},${column.by},${column.material}`)
			.join(';');
		const signature = `${wallsSig}|${colsSig}`;
		const sameFloor = lastWallsKey.floorId === floor.id;
		// `|` is what two empty lists make: a floor with nothing drawn is not a change.
		const hadWalls = sameFloor && lastWallsKey.signature !== '|';
		lastWallsKey = { floorId: floor.id, signature };
		// Nothing drawn and nothing was: the floor's mask is whatever detection produced,
		// and it must be left alone.
		if (signature === '|' && !hadWalls) return;
		// While a shape is being drawn, nothing is re-derived: a plan is drawn in runs of a
		// dozen walls, and each pass is a full rasterise, a PNG encode, the interior, the
		// room labels and a save. Skipping the pass until the tool is left turns a drag that
		// stalled every segment into one pass at the end.
		if (appState.wallVectorMode) return;
		if (wallsSyncTimer) clearTimeout(wallsSyncTimer);
		// A floor that had segments and now has none: the last obstruction was deleted, and the
		// mask has to be emptied with it — in the frame it already has, so the plan's coordinate
		// system does not move. (A floor that never had segments keeps its detected mask; the
		// early return above is what tells the two apart.)
		const emptied = hadWalls && signature === '|';
		wallsSyncTimer = setTimeout(() => {
			wallsSyncTimer = null;
			syncVectorWallsToMask(emptied);
		}, 120);
	});

	/** Walls on the floor on screen, in the shapes the geometry helpers expect. */
	function currentWalls(): VectorWall[] {
		const floor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
		return (floor?.walls ?? []) as VectorWall[];
	}

	/**
	 * The raised surfaces of the floor on screen.
	 *
	 * Drawn from the floor, not from a copy: the height field the model reads and the
	 * rectangle on the canvas have to be the same object, or a surface can be moved in the
	 * picture and stay where it was in the maths.
	 */
	$effect(() => {
		if (!surfacesLayer) return;
		const floor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
		surfacesLayer.visible = appState.floorView === 'single';
		surfacesLayer.surfaces = floor?.surfaces ?? [];
		surfacesLayer.selectedId = appState.surfaceSelected;
		surfacesLayer.draft = appState.surfaceDraft;
		surfacesLayer.draftKind = appState.surfaceKind;
		surfacesLayer.draftHeightM = appState.surfaceHeightM;
		surfacesLayer.draftTopHeightM =
			appState.surfaceKind === 'platform' ? appState.surfaceHeightM : appState.surfaceTopHeightM;
		engine.markDirty();
	});

	/**
	 * One click of the raised-surface tool: the first corner, then the opposite one.
	 *
	 * The kind and the heights come from the panel, not from the gesture: a stair and a
	 * platform are the same rectangle, and what makes one a stair is the pair of heights on
	 * it. A platform therefore ignores the second height rather than keeping a stale one.
	 */
	function commitSurfaceClick(world: { x: number; y: number }): void {
		const floor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
		if (!floor) return;
		if (!appState.surfaceDraft) {
			appState.surfaceDraft = { ax: world.x, ay: world.y, bx: world.x, by: world.y };
			return;
		}
		const draft = appState.surfaceDraft;
		appState.surfaceDraft = null;
		const surface = {
			id: crypto.randomUUID(),
			kind: appState.surfaceKind,
			ax: draft.ax,
			ay: draft.ay,
			bx: world.x,
			by: world.y,
			heightM: Math.max(0, appState.surfaceHeightM),
			// A level surface has one height, and saying so twice is how the two fields
			// drift on a platform the user later changes to a ramp.
			topHeightM:
				appState.surfaceKind === 'platform'
					? Math.max(0, appState.surfaceHeightM)
					: Math.max(0, appState.surfaceTopHeightM),
			attenuationDb: Math.max(0, appState.surfaceAttenuationDb),
			thicknessM: Math.max(0, appState.surfaceThicknessM),
			solidBase: appState.surfaceSolidBase
		};
		if (isDegenerateSurface(surface)) return;
		pushState();
		floor.surfaces = [...(floor.surfaces ?? []), surface];
		appState.surfaceSelected = surface.id;
		scheduleSave();
		// The client's height changes what is covered, so the figure is re-measured rather
		// than left standing from the flat floor.
		void updateCoverage();
	}

	/** A snap tolerance that stays the same size on screen as the plan is zoomed. */
	function snapToleranceWorld(): number {
		return 12 / (engine?.camera.state.zoom ?? 1);
	}

	/** Leave the wall tool, dropping whatever was half drawn. */
	function stopWallMode(): void {
		appState.wallVectorMode = false;
		appState.wallVectorDraft = null;
		appState.columnDraft = null;
		vectorCursor = null;
		vectorSnap = null;
		engine?.markDirty();
	}

	/** The material button in the wall toolbar: choose what the next shape is drawn in. */
	function openToolbarMaterial(event: MouseEvent): void {
		const rect = engine?.canvas.getBoundingClientRect();
		wallPopup = {
			x: event.clientX - (rect?.left ?? 0),
			// Under the toolbar rather than over it.
			y: event.clientY - (rect?.top ?? 0) + 18,
			material: wallState.wallMaterial,
			tool: true
		};
	}

	/**
	 * One click of the wall tool.
	 *
	 * A line is two clicks — start, end — snapping to walls first so a plan grows watertight.
	 * A pier or a column is also two clicks, its opposite corners, because that is the same
	 * gesture for a shape you size rather than trace; a circle uses the first click as its
	 * centre and the second as a point on its rim.
	 */
	function handleVectorWallClick(world: { x: number; y: number }, shiftKey: boolean): void {
		const floor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
		if (!floor) return;
		if (appState.wallTool !== 'line') {
			commitColumnClick(floor, world);
			return;
		}
		const walls = currentWalls();
		const tolerance = snapToleranceWorld();
		// Ends *and* sides: a partition running into the middle of a wall is the commonest
		// gesture on a plan, and without it the drawing has two walls that look joined while
		// the model has a gap between them.
		const snapped = snapToWalls(world, walls, tolerance).point;

		if (!appState.wallVectorDraft) {
			appState.wallVectorDraft = snapped;
			return;
		}

		const from = appState.wallVectorDraft;
		const to = shiftKey ? lockToAxis(from, snapped) : snapped;
		const wall: VectorWall = {
			id: crypto.randomUUID(),
			ax: from.x,
			ay: from.y,
			bx: to.x,
			by: to.y,
			material: wallState.wallMaterial as WallMaterialId
		};
		appState.wallVectorDraft = null;
		if (isDegenerate(wall)) return;
		pushState();
		floor.walls = [...walls, wall];
		appState.wallVectorSelected = wall.id;
		scheduleSave();
	}

	/** The second click of a pier or a column: commits it in the current material. */
	function commitColumnClick(
		floor: (typeof floorState.floors)[number],
		world: { x: number; y: number }
	): void {
		const shape = appState.wallTool === 'rect' ? 'rect' : 'circle';
		if (!appState.columnDraft) {
			appState.columnDraft = { shape, ax: world.x, ay: world.y, bx: world.x, by: world.y };
			return;
		}
		const draft = appState.columnDraft;
		appState.columnDraft = null;
		const column: VectorColumn = {
			id: crypto.randomUUID(),
			shape: draft.shape,
			ax: draft.ax,
			ay: draft.ay,
			bx: world.x,
			by: world.y,
			material: wallState.wallMaterial as WallMaterialId
		};
		if (isDegenerateColumn(column)) return;
		pushState();
		floor.columns = [...(floor.columns ?? []), column];
		appState.wallColumnSelected = column.id;
		appState.wallVectorSelected = null;
		scheduleSave();
	}

	/**
	 * The notes on this floor, and which is hovered or selected.
	 *
	 * Drawn above everything: a note is an annotation about the plan, and an annotation under
	 * the thing it annotates is unreadable. Visibility follows the layer switch, and the
	 * hover/selection state lives in app state rather than here so the sidebar editor can
	 * see it.
	 */
	$effect(() => {
		if (!notesLayer) return;
		const floor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
		notesLayer.visible = appState.showNotes && appState.floorView === 'single';
		notesLayer.notes = floor?.notes ?? [];
		notesLayer.hoverId = appState.noteHoverId;
		notesLayer.selectedId = appState.noteSelectedId;
		engine.markDirty();
	});

	/** Notes are per floor; the ones the pointer can hit are the current floor's. */
	function currentNotes() {
		const floor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
		return floor?.notes ?? [];
	}

	/** Screen pixels → world tolerance for the pin hit test. */
	function noteToleranceWorld(): number {
		return NOTE_HIT_PX / (engine?.camera.state.zoom ?? 1);
	}

	function addNoteAt(world: { x: number; y: number }): void {
		const floor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
		if (!floor) return;
		pushState();
		const note = { id: crypto.randomUUID(), x: world.x, y: world.y, text: '' };
		floor.notes = [...(floor.notes ?? []), note];
		appState.noteSelectedId = note.id;
		appState.noteMode = false;
		scheduleSave();
	}

	/**
	 * Close the planning area from the canvas: Enter, a double-click, or the sidebar button.
	 *
	 * A double-click arrives after its two clicks have already added their corners, so the
	 * duplicate is dropped before closing — otherwise every double-clicked loop ends with a
	 * zero-length edge, which the geometry tolerates and the user does not expect.
	 */
	function commitPlanningDraft(): void {
		const draft = appState.planningDraft;
		if (draft.length < 3) return;
		const floor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
		if (!floor) return;
		pushState();
		/*
		 * Re-fetched after the history snapshot, because `pushState` restores the previous
		 * state before recording the new one: the `floor` captured above can be a detached
		 * object by the time this writes, and the area then lands on a floor nobody is
		 * looking at — which is why the card kept saying "Auto-detected" after drawing one.
		 */
		const target = floorState.floors.find((f) => f.id === floor.id);
		if (!target) return;
		target.planningArea = draft.map((point) => ({ x: point.x, y: point.y }));
		setPlanningDrawMode(false);
		planningCursor = null;
		forgetInterior(target.id);
		scheduleSave();
	}

	/**
	 * A double-click on the same spot closes the loop — and nothing else does.
	 *
	 * It used to commit on *every* double-click, which made the gesture unusable: two quick
	 * corners are a double-click, and so is a click near the first corner, so the area
	 * closed itself while it was still being drawn. Now the last two corners have to be the
	 * same place (a real double-click on the spot) before it closes; otherwise the click
	 * that arrived is just another corner, and Enter or the sidebar closes the loop.
	 */
	function handleCanvasDoubleClick(event: MouseEvent): void {
		if (!appState.planningDrawMode) return;
		event.preventDefault();
		const draft = appState.planningDraft;
		if (draft.length < 4) return;
		const last = draft[draft.length - 1]!;
		const previous = draft[draft.length - 2]!;
		const tolerance = 4 / (engine?.camera.state.zoom ?? 1);
		if (Math.hypot(last.x - previous.x, last.y - previous.y) > tolerance) return;
		// The two clicks of the double-click are both corners; the second is the duplicate.
		appState.planningDraft = draft.slice(0, -1);
		commitPlanningDraft();
	}

	function handlePointerMove(e: PointerEvent) {
		if (!engine) return;
		// Hovering a note pin shows its text, in every mode: reading a note is never the
		// gesture the current mode is about.
		if (appState.showNotes && appState.floorView === 'single') {
			const rect = engine.canvas.getBoundingClientRect();
			const world = engine.camera.screenToWorld({
				x: e.clientX - rect.left,
				y: e.clientY - rect.top
			});
			const hovered = noteAtPoint(currentNotes(), world, noteToleranceWorld());
			if ((hovered?.id ?? null) !== appState.noteHoverId) {
				appState.noteHoverId = hovered?.id ?? null;
				engine.markDirty();
			}
		}
		if (appState.wallVectorMode) {
			const rect = engine.canvas.getBoundingClientRect();
			vectorCursor = engine.camera.screenToWorld({
				x: e.clientX - rect.left,
				y: e.clientY - rect.top
			});
			if (appState.wallTool === 'line') {
				// Where the click would land, so the ring can say "this will meet that wall".
				const snapped = snapToWalls(vectorCursor, currentWalls(), snapToleranceWorld());
				vectorSnap =
					snapped.point.x !== vectorCursor.x || snapped.point.y !== vectorCursor.y
						? snapped.point
						: null;
			} else {
				vectorSnap = null;
				// The pier or column follows the pointer from the first click, like a wall.
				if (appState.columnDraft) {
					appState.columnDraft = {
						...appState.columnDraft,
						bx: vectorCursor.x,
						by: vectorCursor.y
					};
				}
			}
			engine.markDirty();
			return;
		}
		if (appState.noteMode) return;
		// Drawing a raised surface: the second corner follows the pointer, so the rectangle
		// can be judged before the click that commits it.
		if (appState.surfaceMode) {
			const rect = engine.canvas.getBoundingClientRect();
			const world = engine.camera.screenToWorld({
				x: e.clientX - rect.left,
				y: e.clientY - rect.top
			});
			if (appState.surfaceDraft) {
				appState.surfaceDraft = { ...appState.surfaceDraft, bx: world.x, by: world.y };
				engine.markDirty();
			}
			return;
		}
		// While drawing the planning area the pointer drives the rubber band: the next edge
		// and the closing edge are previewed, so the shape can be judged before it is closed.
		if (appState.planningDrawMode) {
			const rect = engine.canvas.getBoundingClientRect();
			planningCursor = engine.camera.screenToWorld({
				x: e.clientX - rect.left,
				y: e.clientY - rect.top
			});
			engine.markDirty();
			return;
		}
		if (e.pointerType === 'touch') return;
		// Turning the viewpoint of an overview, and which slab is under the pointer in the
		// stacked one. Read-only and cheap: the layout is a few floors of arithmetic, and
		// only a *change* marks the canvas dirty, so a moving pointer does not repaint per
		// pixel.
		if (appState.floorView === 'stacked' || appState.floorView === 'floor3d') {
			// While the view is being dragged there is no hovering to report: the
			// pointer is holding the camera, not pointing at a floor.
			if (orbitPointerId === e.pointerId) {
				const dx = e.clientX - orbitStartX;
				const dy = e.clientY - orbitStartY;
				if (!orbitMoved && Math.hypot(dx, dy) >= DRAG_THRESHOLD) {
					orbitMoved = true;
					if (stackedFloorsLayer) stackedFloorsLayer.hoverFloorId = null;
					// Start accumulating from here, not from where the drag began:
					// otherwise the threshold distance itself is applied as a turn on
					// the first step, which reads as a small jump.
					orbitLastX = e.clientX;
					orbitLastY = e.clientY;
				}
				if (orbitMoved) {
					orbitYaw = clamp(
						orbitYaw - (e.clientX - orbitLastX) * ORBIT_DEG_PER_PX,
						-STACK_YAW_LIMIT_DEG,
						STACK_YAW_LIMIT_DEG
					);
					orbitPitch = clamp(
						orbitPitch - (e.clientY - orbitLastY) * ORBIT_DEG_PER_PX,
						STACK_MIN_PITCH_DEG,
						STACK_MAX_PITCH_DEG
					);
					orbitLastX = e.clientX;
					orbitLastY = e.clientY;
					appState.stackYaw = orbitYaw;
					appState.stackPitch = orbitPitch;
					return;
				}
			}
			if (appState.floorView === 'stacked' && stackedFloorsLayer) {
				const rect = engine.canvas.getBoundingClientRect();
				const world = engine.camera.screenToWorld({
					x: e.clientX - rect.left,
					y: e.clientY - rect.top
				});
				const hovered = stackedFloorsLayer.floorAt(world.x, world.y);
				if (hovered !== stackedFloorsLayer.hoverFloorId) {
					stackedFloorsLayer.hoverFloorId = hovered;
					engine.markDirty();
				}
			}
		}
		if (alignDragging) {
			// The camera carries the current floor, and the ghost is pushed back by
			// the same amount so it stays anchored to the floor it belongs to. On
			// release the camera returns and the floor's own coordinates take over
			// the movement, so nothing jumps.
			alignDxScreen = e.clientX - alignStartClientX;
			alignDyScreen = e.clientY - alignStartClientY;
			const cam = engine.camera;
			cam.pan(alignStartX + alignDxScreen - cam.state.x, alignStartY + alignDyScreen - cam.state.y);
			const zoom = cam.state.zoom || 1;
			referenceFloorLayer.compensateX = -alignDxScreen / zoom;
			referenceFloorLayer.compensateY = -alignDyScreen / zoom;
			engine.markDirty();
			return;
		}
		if (dragHandler.isDragging) {
			dragHandler.handlePointerMove(e);
			return;
		}

		if (pendingPlace) {
			const dx = e.clientX - pointerStartX;
			const dy = e.clientY - pointerStartY;
			if (dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) {
				// Moved beyond threshold: this is a pan, not a tap-to-place
				pendingPlace = false;
				pendingPan = true;
				// Start panning from the original position
				engine.canvas.style.cursor = 'grabbing';
			}
		}

		if (pendingPan) {
			const dx = (e.clientX - pointerStartX) / engine.camera.state.zoom;
			const dy = (e.clientY - pointerStartY) / engine.camera.state.zoom;
			engine.camera.pan(dx, dy);
			pointerStartX = e.clientX;
			pointerStartY = e.clientY;
			engine.markDirty();
			return;
		}

		selectHandler.handlePointerMove(e);
	}

	function handlePointerUp(e: PointerEvent) {
		if (!engine) return;
		if (e.button !== 0) return; // Only handle primary (left) button
		// The overview's drag-vs-click decision, made on release.
		if (orbitPointerId === e.pointerId) {
			orbitPointerId = null;
			if (!orbitMoved && appState.floorView !== 'single') {
				const r = engine.canvas.getBoundingClientRect();
				const world = engine.camera.screenToWorld({
					x: e.clientX - r.left,
					y: e.clientY - r.top
				});
				const picked =
					appState.floorView === 'stacked'
						? stackedFloorsLayer?.floorAt(world.x, world.y)
						: floorTilesLayer?.tileAt(world.x, world.y);
				if (picked) switchFloor(picked);
			}
			return;
		}
		if (alignDragging) {
			alignDragging = false;
			const zoom = engine.camera.state.zoom || 1;
			const dxWorld = alignDxScreen / zoom;
			const dyWorld = alignDyScreen / zoom;
			// Restore the camera before moving the floor. The floor is about to
			// carry the movement in its own coordinates, and the camera has been
			// carrying it until now — leaving both in place would double it.
			engine.camera.pan(
				alignStartX - engine.camera.state.x,
				alignStartY - engine.camera.state.y
			);
			referenceFloorLayer.compensateX = 0;
			referenceFloorLayer.compensateY = 0;
			if (dxWorld !== 0 || dyWorld !== 0) {
				translateFloor(floorState.currentFloorId, dxWorld, dyWorld, apState.aps);
			}
			engine.markDirty();
			return;
		}
		if (pendingPlace) {
			pendingPlace = false;
			// Check if click was on a wall pixel first (for material popup)
			const rect = engine.canvas.getBoundingClientRect();
			const sx = e.clientX - rect.left;
			const sy = e.clientY - rect.top;
			if (!handleWallClick(sx, sy)) {
				// Not a wall click — place an AP
				placeHandler.handlePointerDown(e);
			}
		}

		if (pendingPan) {
			pendingPan = false;
			engine.canvas.style.cursor = '';
		}

		selectHandler.handlePointerUp(e);
		dragHandler.handlePointerUp();
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="canvas-container"
	class:drag-over={canvasDragOver}
	bind:this={containerEl}
	ondrop={handleCanvasDrop}
	ondragover={handleCanvasDragOver}
	ondragleave={handleCanvasDragLeave}
>
	<canvas
		bind:this={canvasEl}
		role="application"
		aria-label={t('Channel planning canvas')}
		onpointerdown={handlePointerDown}
		onpointermove={handlePointerMove}
		ondblclick={handleCanvasDoubleClick}
		class:drawing-area={appState.planningDrawMode}
		onpointerup={handlePointerUp}
		onpointerleave={() => {
			// Leaving the canvas has to drop the stack highlight: the pointer move
			// that would clear it never arrives.
			if (stackedFloorsLayer?.hoverFloorId) {
				stackedFloorsLayer.hoverFloorId = null;
				engine?.markDirty();
			}
			if (vectorCursor) {
				vectorCursor = null;
				vectorSnap = null;
				engine?.markDirty();
			}
		}}
		oncontextmenu={handleContextMenu}
		ontouchstart={handleTouchStart}
		ontouchmove={handleTouchMove}
		ontouchend={handleTouchEnd}
		ontouchcancel={handleTouchEnd}
	></canvas>
	<LayerPanel />
	{#if appState.wallVectorMode}
		<WallToolbar
			tool={appState.wallTool}
			material={wallState.wallMaterial}
			ontool={(tool) => (appState.wallTool = tool)}
			onmaterial={openToolbarMaterial}
			ondone={stopWallMode}
		/>
	{/if}
	<!--
		Floor stepping in the 3D view. The sidebar's floor pills are still there, but in this
		view the storeys are a place you are looking *at*, not a list you are picking from,
		and two arrows next to the plan are the gesture that matches.
	-->
	{#if appState.floorView === 'floor3d'}
		<div class="floor-nav" role="group" aria-label={t('Floor')}>
			<button
				class="floor-nav-btn"
				onclick={() => stepFloor(1)}
				aria-label={t('Floor above')}
				title={t('Floor above')}
			>↑</button>
			<span class="floor-nav-name">
				{floorState.floors.find((f) => f.id === floorState.currentFloorId)?.name ?? ''}
			</span>
			<button
				class="floor-nav-btn"
				onclick={() => stepFloor(-1)}
				aria-label={t('Floor below')}
				title={t('Floor below')}
			>↓</button>
		</div>
	{/if}
	{#if showEmptyHint}
		<div class="empty-hint">
			<p>{t('Drop a floorplan image here')}</p>
			<!-- Placement is a mode, off by default, so the hint has to say which of the
			     two things a click will do right now. -->
			<p>
				{appState.apPlaceMode
					? t('or click the canvas to place access points')
					: t('or turn on Place APs to add access points')}
			</p>
		</div>
	{/if}
</div>

{#if wallPopup}
	<WallMaterialPopup
		x={wallPopup.x}
		y={wallPopup.y}
		maxY={containerEl?.getBoundingClientRect().bottom ?? window.innerHeight}
		currentMaterial={wallPopup.material}
		onselect={handleMaterialSelect}
		onclose={() => { wallPopup = null; }}
	/>
{/if}

{#if roomPopup}
	<RoomTypePopup
		x={roomPopup.x}
		y={roomPopup.y}
		maxY={containerEl?.getBoundingClientRect().bottom ?? window.innerHeight}
		currentTypeId={roomPopup.typeId}
		currentDensity={roomPopup.density}
		currentLabel={roomPopup.customLabel}
		onselect={handleRoomTypeSelect}
		onclose={() => { roomPopup = null; }}
	/>
{/if}

<style>
	.canvas-container {
		width: 100%;
		height: 100%;
		overflow: hidden;
		background: var(--canvas-bg);
		position: relative;
		-webkit-user-select: none;
		user-select: none;
		-webkit-touch-callout: none;
	}

	.canvas-container.drag-over {
		outline: 3px dashed var(--accent-primary);
		outline-offset: -3px;
	}

	canvas {
		display: block;
		touch-action: none;
	}

	/* Drawing a polygon: the cursor has to say that a click places a corner. */
	canvas.drawing-area {
		cursor: crosshair;
	}

	/* Floor stepping in the 3D view: a small HUD, out of the plan's way at the top. */
	.floor-nav {
		position: absolute;
		top: var(--space-3, 12px);
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		gap: var(--space-2, 8px);
		padding: 3px var(--space-2, 8px);
		background: rgba(16, 18, 26, 0.82);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		color: var(--text-primary);
		font-size: var(--text-xs);
		z-index: 20;
	}

	.floor-nav-btn {
		width: 22px;
		height: 22px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: transparent;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm);
		color: var(--text-primary);
		cursor: pointer;
		line-height: 1;
	}

	.floor-nav-btn:hover {
		background: var(--bg-hover);
	}

	.floor-nav-name {
		min-width: 64px;
		text-align: center;
	}

	.empty-hint {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		pointer-events: none;
		gap: var(--space-1, 4px);
	}

	.empty-hint p {
		margin: 0;
		font-size: var(--text-base);
		color: var(--text-tertiary);
		opacity: 0.6;
	}

</style>
