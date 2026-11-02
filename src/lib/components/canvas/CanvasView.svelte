<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { CanvasEngine } from '$canvas/engine.js';
	import { FloorplanLayer } from '$canvas/renderers/floorplan.js';
	import { GridLayer } from '$canvas/renderers/grid.js';
	import { HeatmapLayer } from '$canvas/renderers/heatmap.js';
	import { ApLayer } from '$canvas/renderers/ap.js';
	import type { WallDistanceAnnotation } from '$canvas/renderers/ap.js';
	import { WallLayer } from '$canvas/renderers/walls.js';
	import { decodeMask, encodeMask } from '$canvas/mask-codec.js';
	import type { DecodedWallMask } from '$canvas/mask-codec.js';
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
		wupmForFloor,
		radiusFromPower,
		apHeightAboveFloor,
		type AccessPoint
	} from '$state/ap-state.svelte.js';
	import {
		heatmapApsForFloor,
		trackHeatmapInputs,
		type HeatmapSourceAp
	} from '$canvas/heatmap-sources.js';
	import { handleShortcut } from '$canvas/shortcuts.js';
	import { chooseSurfaceKind, chooseSurfaceMaterial } from '$state/surface-defaults.js';
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
		invalidateSolverMaskCache
	} from '$state/solver.svelte.js';
	import { updateCoverage, optimizerState, floorCoverage, apsOutsideInterior } from '$state/optimizer.svelte.js';
	import { hitTest } from '$canvas/hit-test.js';
	import { fitCanvasToContent } from '$canvas/fit.js';
	import { restoreFromStorage, saveNow } from '$state/persistence.svelte.js';
	import { importFloorplanFile } from '$canvas/import-floorplan.js';
	import { labelWallBlobs, relabelBlob, labelRooms, fillRegion, encodeMaterialMask, decodeMaterialMask } from '$canvas/region-labels.js';
	import type { RegionLabels } from '$canvas/region-labels.js';
	import { WALL_MATERIALS, registerCustomMaterials, type WallMaterialId } from '$lib/domain/materials.js';
	import {
		floorState,
		currentFloor,
		floorElevation,
		translateFloor,
		switchFloor,
		type Floor
	} from '$state/floor-state.svelte.js';
	import { FLOOR_MATERIALS } from '$canvas/floor-materials.js';
	import type { Band } from '@aetherax/channels';
	import { scheduleSave } from '$state/persistence.svelte.js';
	import { computeBuildingInterior } from '$canvas/morphology.js';
	import { RoomLabelsLayer } from '$canvas/renderers/room-labels.js';
	import { ROOM_TYPES } from '$lib/domain/room-types.js';
	import LayerPanel from '$components/canvas/LayerPanel.svelte';
	import WallMaterialPopup from '$components/canvas/WallMaterialPopup.svelte';
	import WallToolbar from '$components/canvas/WallToolbar.svelte';
	import ApPlacementToolbar from '$components/canvas/ApPlacementToolbar.svelte';
	import SurfaceToolbar from '$components/canvas/SurfaceToolbar.svelte';
	import RoomTypePopup from '$components/canvas/RoomTypePopup.svelte';
	import ConfirmDialog from '$components/dialogs/ConfirmDialog.svelte';
	import { t, i18nState } from '$state/i18n.svelte';
	import { displayLength, formatMeasure, lengthUnit } from '$lib/units.js';

	import { MaskPipeline } from '$canvas/mask-pipeline.svelte.js';
	import { CanvasGestures } from '$canvas/gestures.svelte.js';

	const maskPipeline = new MaskPipeline({
		layers: () => ({ wallLayer, heatmapLayer, roomLabelsLayer }),
		markDirty: () => engine?.markDirty()
	});

	/**
	 * The gesture state machine: pointer, touch, orbit and alignment drags.
	 *
	 * It owns when a click becomes a drag and which mode receives the click; the view
	 * keeps what each of those actions *does* and hands them over as a GestureHost.
	 */
	const gestures = new CanvasGestures({
		engine: () => engine,
		select: () => selectHandler,
		drag: () => dragHandler,
		place: () => placeHandler,
		stacked: () => stackedFloorsLayer,
		tiles: () => floorTilesLayer,
		reference: () => referenceFloorLayer,
		wallClick: (x, y) => handleWallClick(x, y),
		contextAction: (x, y) => handleContextAction(x, y),
		commitSurface: (world) => commitSurfaceClick(world),
		vectorWallClick: (world, shiftKey) => handleVectorWallClick(world, shiftKey),
		addNote: (world) => addNoteAt(world),
		eraseWall: (world) => eraseAt(world),
		currentWalls: () => currentWalls(),
		currentNotes: () => currentNotes(),
		snapTolerance: () => snapToleranceWorld(),
		noteTolerance: () => noteToleranceWorld(),
		commitAlign: (dx, dy) => {
			translateFloor(floorState.currentFloorId, dx, dy, apState.aps);
			// An alignment is a project edit like any other: without this the floor moved on
			// screen and nowhere else, and the next save wrote the old offsets back.
			scheduleSave();
			// The mask was re-derived in the old frame by anything that ran in between; make
			// the derived geometry follow the segments now that they have moved.
			syncVectorWallsToMask();
			forgetInterior(floorState.currentFloorId);
		}
	});

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
	/**
	 * Remove every drawn wall on the floor.
	 *
	 * The wall toolbar's trash button. The wall card used to own this, which put a
	 * destructive action in the sidebar while the tool that draws walls floated over the
	 * canvas; it is a normal edit — undo puts the segments back, and the mask follows them —
	 * so it needs no confirmation.
	 */
	function clearFloorWalls(): void {
		const floor = currentFloor();
		if (!floor) return;
		pushState();
		floor.walls = [];
		appState.wallVectorSelected = null;
		/*
		 * Re-derive now, not on the effect's debounce.
		 *
		 * The wall-sync effect deliberately skips while the wall tool is armed (a run of
		 * segments should be one rasterise), and this button lives in that tool's bar — so
		 * waiting for the effect would leave the old mask in place until the user pressed
		 * Done. Clearing is explicit and final: empty the mask, drop the interior caches
		 * and save.
		 */
		syncVectorWallsToMask(true);
		forgetInterior(floor.id);
		scheduleSave();
	}

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
		maskPipeline.publish({
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

	// Room type popup state
	let roomPopup = $state<{ x: number; y: number; typeId: number; density: number; customLabel: string; regionId: number } | null>(null);

	function handleWallClick(screenX: number, screenY: number): boolean {
		if (!engine || !maskPipeline.wallData || !maskPipeline.wallLabels) return false;
		const world = engine.camera.screenToWorld({ x: screenX, y: screenY });
		const px = Math.round(world.x) - maskPipeline.originX;
		const py = Math.round(world.y) - maskPipeline.originY;
		const mask = wallState.wallMask;
		if (!mask || px < 0 || px >= mask.width || py < 0 || py >= mask.height) return false;
		const idx = py * mask.width + px;
		if (!maskPipeline.wallData[idx]) return false;

		const blobId = maskPipeline.wallLabels.labels[idx]!;
		if (blobId < 0) return false;

		const matId = maskPipeline.materialData ? (maskPipeline.materialData[idx] ?? wallState.wallMaterial) : wallState.wallMaterial;
		wallPopup = { x: screenX, y: screenY, material: matId as WallMaterialId, blobId };
		return true;
	}

	function handleRoomClick(screenX: number, screenY: number): boolean {
		if (!engine || !maskPipeline.interior || !maskPipeline.roomLabels) return false;
		const world = engine.camera.screenToWorld({ x: screenX, y: screenY });
		const px = Math.round(world.x) - maskPipeline.originX;
		const py = Math.round(world.y) - maskPipeline.originY;
		const mask = wallState.wallMask;
		if (!mask || px < 0 || px >= mask.width || py < 0 || py >= mask.height) return false;
		const idx = py * mask.width + px;

		// Must be an interior pixel (not a wall, not exterior)
		if (!maskPipeline.interior[idx]) return false;

		const regionId = maskPipeline.roomLabels.labels[idx]!;
		if (regionId < 0) return false;

		const typeId = maskPipeline.roomTypeData ? (maskPipeline.roomTypeData[idx] ?? 0) : 0;
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
			gestures.cancelAlignDrag();
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
		if (!roomPopup || !maskPipeline.roomLabels || !wallState.wallMask) return;
		pushState();
		const mask = wallState.wallMask;

		// Create or clone room type mask
		if (!maskPipeline.roomTypeData) {
			maskPipeline.roomTypeData = new Uint8Array(mask.width * mask.height);
		}

		fillRegion(maskPipeline.roomLabels.labels, maskPipeline.roomTypeData, roomPopup.regionId, typeId);

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
		roomLabelsLayer.roomTypeData = maskPipeline.roomTypeData;
		roomLabelsLayer.roomLabels = maskPipeline.roomLabels;
		roomLabelsLayer.densityOverrides = floor.roomDensityOverrides;
		roomLabelsLayer.customLabels = floor.roomCustomLabels ?? {};
		roomLabelsLayer.invalidateCache();
		engine.markDirty();

		// Encode and persist
		const dataUrl = encodeMaterialMask(maskPipeline.roomTypeData, mask.width, mask.height);
		wallState.roomTypeMask = { dataUrl, width: mask.width, height: mask.height, originX: maskPipeline.originX, originY: maskPipeline.originY };
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
		if (!maskPipeline.wallLabels || !wallState.wallMask || wallPopup.blobId === undefined) return;
		pushState(); // undo captures state before blob relabel
		const mask = wallState.wallMask;
		const blobId = wallPopup.blobId;

		// Create or clone material mask
		if (!maskPipeline.materialData) {
			maskPipeline.materialData = new Uint8Array(mask.width * mask.height);
			maskPipeline.materialData.fill(wallState.wallMaterial);
		}

		relabelBlob(maskPipeline.wallLabels.labels, maskPipeline.materialData, blobId, newMaterial);

		// Update renderers immediately
		wallLayer.materialMap = maskPipeline.materialData;
		wallLayer.invalidateCache();
		heatmapLayer.materialMap = maskPipeline.materialData;
		heatmapLayer.materialVersion++;
		heatmapLayer.markWallsDirty();
		engine.markDirty();

		// Trigger solver re-run
		maskPipeline.maskVersion++;
		invalidateSolverMaskCache();

		// Encode and persist
		const dataUrl = encodeMaterialMask(maskPipeline.materialData, mask.width, mask.height);
		wallState.materialMask = { dataUrl, width: mask.width, height: mask.height, originX: maskPipeline.originX, originY: maskPipeline.originY };
		scheduleSave();
	}

	let canvasEl: HTMLCanvasElement;
	let containerEl: HTMLDivElement;
	let engine: CanvasEngine;
	let panZoom: PanZoomHandler;
	let selectHandler: SelectHandler;
	let dragHandler: DragHandler;
	let placeHandler: PlaceHandler;
	/**
	 * Decoded images and per-floor coverage, held once for both overview views.
	 *
	 * One cache rather than one per view, because a floor's coverage image is the
	 * expensive artefact: sharing it means switching between the contact sheet and
	 * the stack never regenerates anything, and the two views cannot disagree about
	 * a floor's resolution or its cache key.
	 */
	const floorCards = new FloorCardCache();

	/*
	 * The layers are built with the component, not in `onMount`.
	 *
	 * They used to be `let …: Layer` assigned on mount, and every effect that syncs one opened
	 * with `if (!layer) return;` — a guard whose truth depended on `onMount` running before the
	 * first `$effect` flush. That ordering is Svelte's, not this file's, and a guard that fails
	 * is silent: the effect is dead for the rest of the session with nothing to show for it. A
	 * layer is a plain object and needs nothing from the DOM, so it exists from the start and
	 * the guards are gone.
	 */
	const floorplanLayer = new FloorplanLayer();
	const gridLayer = new GridLayer();
	const heatmapLayer = new HeatmapLayer();
	const wallLayer = new WallLayer();
	const roomLabelsLayer = new RoomLabelsLayer();
	const apLayer = new ApLayer();
	const selectionRectLayer = new SelectionRectLayer();
	const reviewHighlightLayer = new ReviewHighlightLayer();
	const referenceFloorLayer = new ReferenceFloorLayer();
	referenceFloorLayer.onLoad = () => engine?.markDirty();
	const floorTilesLayer = new FloorTilesLayer(floorCards);
	floorTilesLayer.onLoad = () => engine?.markDirty();
	const stackedFloorsLayer = new StackedFloorsLayer(floorCards);
	stackedFloorsLayer.onLoad = () => engine?.markDirty();
	const floor3DLayer = new Floor3DLayer(floorCards);
	const calibrationLineLayer = new CalibrationLineLayer();
	const planningAreaLayer = new PlanningAreaLayer();
	const surfacesLayer = new SurfacesLayer();
	const notesLayer = new NotesLayer();
	const vectorWallsLayer = new VectorWallsLayer();

	let autoSolveTimeout: ReturnType<typeof setTimeout> | null = null;

	/**
	 * Whether the layers that belong to *one* floor are on screen.
	 *
	 * The overviews (tiled, stacked, 3D) draw the building themselves; every editing layer
	 * hides in them, and each effect used to spell the test out for itself. One name for it,
	 * read in the effects, so "which views show this layer" is one decision rather than
	 * fourteen copies of a comparison.
	 */
	let singleFloorView = $derived(appState.floorView === 'single');

	let showEmptyHint = $derived(
		// Only in the view where the hint's advice can be acted on: the overviews are
		// read-only, and a "drop a floorplan here" over a 3D model is noise.
		singleFloorView && apState.aps.length === 0 && !floorplanState.floorplanUrl
	);

	/**
	 * The keyboard map itself is in `canvas/shortcuts.ts`: the four gestures only this
	 * view can perform are handed over, and everything else is a state a shortcut may touch.
	 */
	function handleKeyDown(e: KeyboardEvent) {
		handleShortcut(e, { stopWallMode, commitPlanningDraft, cancelAlignDrag: gestures.cancelAlignDrag.bind(gestures), syncVectorWallsToMask });
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

		// Add layers in draw order: the array is the order.
		engine.setLayers([
			floorplanLayer,
			gridLayer,
			heatmapLayer,
			wallLayer,
			// Above the current floor's plan and walls on purpose: the underlay is 80%
			// opaque, so a ghost drawn below it would be invisible exactly when it is
			// needed. Below the labels and APs, which belong to the current floor.
			referenceFloorLayer,
			// Last, so it covers everything: in tiled view the single-floor layers have
			// already switched themselves off, but the background is still theirs.
			floorTilesLayer,
			stackedFloorsLayer,
			roomLabelsLayer,
			apLayer,
			selectionRectLayer,
			reviewHighlightLayer,
			// The measured calibration line, over the plan it measures.
			calibrationLineLayer,
			planningAreaLayer,
			// Above the heatmap, under the walls and the labels: a raised area is a property
			// of the floor, and it has to be visible over the coverage it changes.
			surfacesLayer,
			notesLayer,
			vectorWallsLayer,
			// The 3D view draws the whole floor itself, so it goes on top: when it is visible
			// every layer beneath it has already switched itself off.
			floor3DLayer
		]);

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
		apLayer.selectedIds = canvasState.selectedApIds;
		engine.markDirty();
	});

	$effect(() => {
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
	 * Two dependencies, for two different arrivals. `maskPipeline.apWallMask` is the decoded
	 * raster and lands from the decode's promise; `wallState.wallMask` is the
	 * floor's declared mask and changes the moment a floor is switched or cleared,
	 * before any decode has run. A mask is only measured against when the two
	 * agree on the geometry, which is what keeps a floor switch from briefly
	 * measuring the incoming floor's access points against the outgoing floor's
	 * walls — and what clears the annotation when a floor has no walls at all,
	 * since the decode effect must not write this state itself.
	 */
	$effect(() => {
		const floorId = floorState.currentFloorId;
		const aps = apState.aps.filter((ap) => ap.floorId === floorId);
		for (const ap of aps) {
			void ap.x;
			void ap.y;
		}

		const declared = wallState.wallMask;
		const decoded = maskPipeline.apWallMask;
		const revision = maskPipeline.revision;
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

		const show = singleFloorView && appState.showAPs;
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
		gridLayer.visible = singleFloorView && appState.showGrid;
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
		reviewHighlightLayer.box =
			singleFloorView ? canvasState.reviewHighlight : null;
		engine.markDirty();
	});

	/**
	 * The calibration points, as the line they describe.
	 *
	 * Only in the single-floor view: the points are world coordinates on the floor being
	 * calibrated, and the overviews draw every storey at once.
	 */
	$effect(() => {
		const points = appState.calibrationPoints;
		const visible = singleFloorView;
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
		const visible = singleFloorView;
		const floor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
		planningAreaLayer.area = visible ? (floor?.planningArea ?? null) : null;
		planningAreaLayer.draft = visible ? appState.planningDraft : [];
		planningAreaLayer.cursor = appState.planningDrawMode ? gestures.planningCursor : null;
		engine.markDirty();
	});

	$effect(() => {
		const wupm = getEffectiveWupm();
		gridLayer.worldUnitsPerMeter = wupm;
		gridLayer.unitSystem = floorplanState.unitSystem;
		if (heatmapLayer) heatmapLayer.worldUnitsPerMeter = wupm;
		engine.markDirty();
	});

	$effect(() => {
		/*
		 * Hidden while an access point is being dragged. The layer rebuilds itself whenever
		 * an AP moves, and that rebuild is the expensive part of a drag frame; a heatmap that
		 * is sliding under the pointer is not being read anyway. It returns on pointer-up,
		 * rebuilt once from the final positions.
		 */
		heatmapLayer.visible =
			singleFloorView && appState.showHeatmap && !canvasState.isDragging;
		engine.markDirty();
	});

	// Sync heatmap APs — current floor plus every other floor's, as fixed sources.
	/** Guards the async mask lookup against a superseded run publishing late. */
	let heatmapApsVersion = 0;
	$effect(() => {
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
			// Same string the tiled overview uses for this floor, so the two views share
			// cached attenuation fields instead of invalidating each other's — and it
			// carries the mask's origin, so aligning the floor does not leave the fields
			// measured against where it used to be.
			heatmapLayer.maskTag = heatmapMaskTag(floorState.floors.find((f) => f.id === floorId) ?? {
				id: floorId,
				wallMask: null
			});
			engine.markDirty();
		})();
	});

	// Sync heatmap display settings — only tracks projectMeta
	$effect(() => {
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
		const floor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
		heatmapLayer.surfaces = floor?.surfaces ?? [];
		engine.markDirty();
	});

	// Coarser wall grid while dragging, for responsiveness
	$effect(() => {
		heatmapLayer.isDragging = canvasState.isDragging;
		engine.markDirty();
	});

	// What a floor switch does to the view, apart from the masks.
	//
	// There is nothing to copy here any more: `wallState` and `floorplanState` read through
	// the current floor (see `state/wall-state.ts`), so switching floors switches their
	// values. The decode caches are dropped by `MaskPipeline.syncWallMask` itself, which knows
	// which floor they belong to — that reset used to be the first line of this effect, and
	// "this effect runs before the decode effect" was an invariant held up by declaration
	// order alone.
	let lastSyncedFloorId = '';
	$effect(() => {
		const id = floorState.currentFloorId;
		if (id === lastSyncedFloorId) return;

		lastSyncedFloorId = id;
		clearSelection();

		// Immediately show cached coverage for this floor (recomputed after decode)
		const fc = floorCoverage.get(id);
		optimizerState.coverage = fc?.coverage ?? 0;

		engine?.markDirty();
	});

	// When wall mask changes, invalidate heatmap wall cache
	$effect(() => {
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
	$effect(() => {
		maskPipeline.syncWallMask();
	});

	$effect(() => {
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
			singleFloorView && appState.showWalls && !hasSegments;
		engine.markDirty();
	});

	$effect(() => {
		roomLabelsLayer.visible = singleFloorView && appState.showRoomLabels;
		engine.markDirty();
	});

	// Decode room type mask independently of wall mask (handles undo/redo, floor switch)
	$effect(() => {
		maskPipeline.syncRoomTypes();
	});

	$effect(() => {
		apLayer.showLabels = appState.showLabels;
		engine.markDirty();
	});

	$effect(() => {
		floorplanLayer.visible = singleFloorView && appState.showFloorplan;
		engine.markDirty();
	});

	$effect(() => {
		apLayer.visible = singleFloorView && appState.showAPs;
		engine.markDirty();
	});

	// Sync floorplan image to layer
	let lastFittedUrl: string | null = null;
	$effect(() => {
		const url = floorplanState.floorplanUrl;
		// Where this floor's underlay sits in the shared world frame. Read here
		// rather than inside loadImage because the offset can change without the
		// image changing (that is the whole point of aligning floors).
		const floor = currentFloor();
		floorplanLayer.offsetX = floor?.floorplanOffsetX ?? 0;
		floorplanLayer.offsetY = floor?.floorplanOffsetY ?? 0;
		if (url) {
			floorplanLayer.loadImage(url, () => {
				/*
				 * Auto-fit once per *image*, never per offset.
				 *
				 * This effect also re-runs when a floor is aligned (the offset is one of its
				 * inputs), and `loadImage` calls back on a cache hit too — so every alignment
				 * and every undo re-fitted the camera, which is precisely "the zoom went back
				 * to fit" on both. A new image is the only event that should re-frame the view;
				 * a moved one is a move the user just made.
				 */
				if (
					url !== lastFittedUrl &&
					singleFloorView &&
					floorplanLayer.imageWidth > 0
				) {
					lastFittedUrl = url;
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
		/*
		 * Turning "Allow APs outside rooms" on is an answer to the warning, not a reason
		 * to keep showing it: the notice exists to say the plan is wrong, and with the
		 * switch on an outside AP is what the user asked for. Without this dependency the
		 * warning stood after the switch and re-appeared on every later edit.
		 */
		void projectMeta.allowOutsideRooms;
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
		if (projectMeta.allowOutsideRooms) {
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
		referenceFloorLayer.visible = singleFloorView && !!below;
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
		stackedFloorsLayer.setFloors(sources, floorState.currentFloorId, projectWupm());
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
			wupm: projectWupm()
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
	 * The attenuation-field cache key for a floor's walls.
	 *
	 * The field is built in world coordinates with the mask's origin baked in, and the field
	 * cache is keyed on position, radius and this tag — so the tag has to carry the origin.
	 * It carried the floor's id alone, which meant that aligning a floor (which moves the
	 * origin and not a pixel) handed every later request the field measured against the
	 * position the floor had before it moved.
	 *
	 * The tiled overview and the single-floor view use the same string for the same floor, so
	 * the two still share fields rather than invalidating each other's.
	 */
	function heatmapMaskTag(floor: { id: string; wallMask: { originX?: number; originY?: number } | null }): string {
		return `floor:${floor.id}@${floor.wallMask?.originX ?? 0},${floor.wallMask?.originY ?? 0}`;
	}

	/**
	 * World units per metre for the coverage images: one scale for the sheet.
	 *
	 * Calibration is per floor, but the tiled and stacked sheets have to draw every card in
	 * one frame — so they use the bottom floor's scale, not the selected floor's. Reading
	 * the *selected* floor's scale here made every card's field depend on which card was
	 * selected: clicking one card rescaled the others' coverage (levels move by
	 * `40·log10(wupm ratio)` dB — 12 dB for a 2x difference), and because the image's bounds
	 * derive from the same scale the texel budget could be exceeded too, rendering that tile
	 * as flat colour blocks.
	 *
	 * A card drawn at another floor's scale is a uniformly scaled picture — the walls, the
	 * APs and their circles scale together, so the coverage *share* it reports is unchanged;
	 * only a physical readout in metres on that card would need its own floor's scale.
	 */
	function projectWupm(): number {
		return wupmForFloor(floorState.floors[0]?.id);
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
			// Which floor's walls these are, and where they sit: the attenuation-field cache
			// is keyed on position and radius, so without this a tile inherits whichever
			// floor's field was built first for that cell, and without the origin it keeps
			// the frame the floor had before it was aligned.
			maskTag: heatmapMaskTag(floor),
			// A mezzanine on that floor changes the picture even though nothing moved.
			surfaces: floor.surfaces ?? []
		});
	}

	async function warmTileHeatmaps(): Promise<void> {
		if (tileHeatWarming || !floorTilesLayer || !engine) return;
		tileHeatWarming = true;
		try {
			for (;;) {
				if (singleFloorView || !appState.showHeatmap) return;
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
		if (singleFloorView || !appState.showHeatmap) return;
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
		/*
		 * The walls, by mask identity rather than by a counter.
		 *
		 * `maskPipeline.maskVersion` was here and is not reactive on purpose (it is bumped
		 * inside the decode, so making it `$state` re-armed the solver on its own writes), which
		 * meant a drawn or erased wall changed the geometry and left the solver's channels where
		 * they were. The mask object is a `$state` read and changes exactly when the geometry
		 * does — a new object per edit, none per decode — so it re-arms on what it is supposed to
		 * and on nothing else. See `canvas/mask-registry.ts`.
		 */
		`|wm:${maskTag(wallState.wallMask)}:${wallState.wallMaterial}` +
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
		/*
		 * The channels are an input to the interference half of the figure, and they are
		 * deliberately not in `autoSolveKey` (the solver writes them, and a key that noticed
		 * would re-arm itself). Tracked here instead, so a channel set by hand in the AP editor
		 * re-measures the figure rather than leaving the number the last assignment produced.
		 */
		for (const ap of apState.aps) void ap.assignedChannel;
		if (apState.aps.length === 0 || !_mask) return;
		if (coverageTimeout) clearTimeout(coverageTimeout);
		coverageTimeout = setTimeout(() => updateCoverage(), 300);
	});

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
		const floor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
		vectorWallsLayer.visible = singleFloorView;
		vectorWallsLayer.walls = (floor?.walls ?? []) as VectorWall[];
		vectorWallsLayer.columns = (floor?.columns ?? []) as VectorColumn[];
		vectorWallsLayer.selectedId = appState.wallVectorSelected;
		vectorWallsLayer.selectedColumnId = appState.wallColumnSelected;
		vectorWallsLayer.draft = appState.wallVectorDraft;
		vectorWallsLayer.columnDraft = appState.columnDraft;
		vectorWallsLayer.cursor = appState.wallVectorMode ? gestures.vectorCursor : null;
		vectorWallsLayer.snapTarget = appState.wallVectorMode ? gestures.vectorSnap : null;
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
		const floor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
		surfacesLayer.visible = singleFloorView;
		surfacesLayer.surfaces = floor?.surfaces ?? [];
		surfacesLayer.selectedId = appState.surfaceSelected;
		surfacesLayer.draft = appState.surfaceDraft;
		surfacesLayer.draftKind = appState.surfaceKind;
		surfacesLayer.draftHeightM = appState.surfaceHeightM;
		surfacesLayer.draftMaterial = appState.surfaceMaterial;
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
			// The material is the preset the figure above came from, recorded so the plan
			// says what the deck is; absent when the loss was typed by hand.
			material: appState.surfaceMaterial ?? undefined,
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
		gestures.vectorCursor = null;
		gestures.vectorSnap = null;
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
	 * The eraser: one stroke removes whatever it passes over.
	 *
	 * It deletes **segments and columns**, not mask pixels: the segments are the model, and the
	 * mask is derived from them, so erasing the model is the only erase that every consumer sees.
	 * A floor whose walls are still a detected raster has no segments to delete — pressing Draw
	 * wall traces that raster into segments first, which is where the eraser becomes available.
	 */
	function eraseAt(world: { x: number; y: number }): boolean {
		const floor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
		if (!floor) return false;
		const radius = 12 / (engine?.camera.state.zoom || 1) + 4;
		const walls = (floor.walls ?? []) as VectorWall[];
		const keptWalls = walls.filter((wall) => distanceToSegment(world, wall) > radius);
		const columns = (floor.columns ?? []) as VectorColumn[];
		const keptColumns = columns.filter((column) => !columnHitsPoint(column, world, radius));
		if (keptWalls.length === walls.length && keptColumns.length === columns.length) return false;
		floor.walls = keptWalls;
		floor.columns = keptColumns;
		if (!keptWalls.some((wall) => wall.id === appState.wallVectorSelected)) {
			appState.wallVectorSelected = null;
		}
		if (!keptColumns.some((column) => column.id === appState.wallColumnSelected)) {
			appState.wallColumnSelected = null;
		}
		return true;
	}

	function distanceToSegment(
		point: { x: number; y: number },
		wall: { ax: number; ay: number; bx: number; by: number }
	): number {
		const dx = wall.bx - wall.ax;
		const dy = wall.by - wall.ay;
		const lengthSq = dx * dx + dy * dy;
		if (lengthSq < 1e-9) return Math.hypot(point.x - wall.ax, point.y - wall.ay);
		const t = Math.min(
			1,
			Math.max(0, ((point.x - wall.ax) * dx + (point.y - wall.ay) * dy) / lengthSq)
		);
		return Math.hypot(point.x - (wall.ax + dx * t), point.y - (wall.ay + dy * t));
	}

	function columnHitsPoint(
		column: { shape: 'rect' | 'circle'; ax: number; ay: number; bx: number; by: number },
		point: { x: number; y: number },
		radius: number
	): boolean {
		if (column.shape === 'circle') {
			const circle = Math.hypot(column.bx - column.ax, column.by - column.ay);
			return Math.hypot(point.x - column.ax, point.y - column.ay) <= circle + radius;
		}
		const x0 = Math.min(column.ax, column.bx) - radius;
		const x1 = Math.max(column.ax, column.bx) + radius;
		const y0 = Math.min(column.ay, column.by) - radius;
		const y1 = Math.max(column.ay, column.by) + radius;
		return point.x >= x0 && point.x <= x1 && point.y >= y0 && point.y <= y1;
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
		if (appState.wallTool === 'eraser') {
			pushState();
			eraseAt(world);
			return;
		}
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
		const floor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
		notesLayer.visible = appState.showNotes && singleFloorView;
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
		gestures.planningCursor = null;
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
		onpointerdown={(e) => gestures.handlePointerDown(e)}
		onpointermove={(e) => gestures.handlePointerMove(e)}
		ondblclick={handleCanvasDoubleClick}
		class:drawing-area={appState.planningDrawMode}
		onpointerup={(e) => gestures.handlePointerUp(e)}
		onpointerleave={() => gestures.handlePointerLeave()}
		oncontextmenu={handleContextMenu}
		ontouchstart={(e) => gestures.handleTouchStart(e)}
		ontouchmove={(e) => gestures.handleTouchMove(e)}
		ontouchend={(e) => gestures.handleTouchEnd(e)}
		ontouchcancel={(e) => gestures.handleTouchEnd(e)}
	></canvas>
	<LayerPanel />
	{#if appState.wallVectorMode}
		<WallToolbar
			tool={appState.wallTool}
			material={wallState.wallMaterial}
			ontool={(tool) => (appState.wallTool = tool)}
			onmaterial={openToolbarMaterial}
			onclear={clearFloorWalls}
			canClear={(currentFloor()?.walls ?? []).length > 0}
			ondone={stopWallMode}
		/>
	{/if}
	{#if appState.apPlaceMode && appState.floorView === 'single'}
		<ApPlacementToolbar
			mount={appState.apPlaceMount}
			lastMount={apState.aps.at(-1)?.mount ?? 'ceiling'}
			onmount={(mount) => (appState.apPlaceMount = mount)}
			ondone={() => (appState.apPlaceMode = false)}
		/>
	{/if}
	{#if appState.surfaceMode && appState.floorView === 'single'}
		<SurfaceToolbar
			kind={appState.surfaceKind}
			material={appState.surfaceMaterial}
			onkind={chooseSurfaceKind}
			onmaterial={chooseSurfaceMaterial}
			ondone={() => setSurfaceMode(false)}
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
