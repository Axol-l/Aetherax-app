<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { CanvasEngine } from '$canvas/engine.js';
	import { FloorplanLayer } from '$canvas/renderers/floorplan.js';
	import { GridLayer } from '$canvas/renderers/grid.js';
	import HeatmapWorker from '$lib/workers/heatmap-worker.ts?worker';
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
	import { Floor3DLayer, FLOOR_SWAP_MS, type FloorScene } from '$canvas/renderers/floor-3d.js';
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
	import { viewTransition } from '$state/view-transition.svelte.js';
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
	import PlanningToolbar from '$components/canvas/PlanningToolbar.svelte';
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
		commitPlanningDraft: () => commitPlanningDraft(),
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

	let wallProbeMask: { originX: number; originY: number } | null = null;

	const wallProbe: WallProbe = (x, y) =>
		wallProbeMask
			? wallSnapFrom(wallDistanceCache.transform, wallProbeMask.originX, wallProbeMask.originY, x, y, getEffectiveWupm())
			: null;

	/**
	 * Remove every drawn wall on the floor.
	 */
	function clearFloorWalls(): void {
		const floor = currentFloor();
		if (!floor) return;
		pushState();
		floor.walls = [];
		appState.wallVectorSelected = null;
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

	/**
	 * Right-click / long-press on a half-finished drawing cancels the draft and stays in the
	 * tool, so the next click starts a new shape.
	 */
	function cancelDrawingDraft(): boolean {
		if (appState.wallVectorMode) {
			if (appState.wallVectorDraft) {
				appState.wallVectorDraft = null;
				engine?.markDirty();
			}
			return true;
		}
		if (appState.planningDrawMode) {
			if (appState.planningDraft.length > 0 || appState.planningDraftClosed) {
				appState.planningDraft = [];
				appState.planningDraftClosed = false;
				engine?.markDirty();
			}
			return true;
		}
		if (appState.surfaceMode) {
			if (appState.surfaceDraft) {
				appState.surfaceDraft = null;
				engine?.markDirty();
			}
			return true;
		}
		if (appState.calibrateMode) {
			if (appState.calibrationPoints.length > 0) {
				appState.calibrationPoints = [];
				engine?.markDirty();
			}
			return true;
		}
		return false;
	}

	/** Right-click / long-press contextual handler: wall, column, raster or room popup. */
	function handleContextAction(screenX: number, screenY: number): boolean {
		if (cancelDrawingDraft()) return true;
		if (handleVectorColumnContext(screenX, screenY)) return true;
		if (handleVectorWallContext(screenX, screenY)) return true;
		if (handleWallClick(screenX, screenY)) return true;
		if (handleRoomClick(screenX, screenY)) return true;
		return false;
	}

	/**
	 * Right-click on a column
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
		if (wallPopup.tool) {
			wallState.wallMaterial = newMaterial;
			scheduleSave();
			return;
		}
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

	const floorCards = new FloorCardCache();
	const floorplanLayer = new FloorplanLayer();
	const gridLayer = new GridLayer();
	const heatmapLayer = new HeatmapLayer();
	if (typeof Worker !== 'undefined') {
		const worker = new HeatmapWorker();
		heatmapLayer.attachWorker(worker);
		heatmapLayer.onGenerated = () => engine?.markDirty();
	}
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
	// 换层动画每帧画完后请求下一帧：引擎只在有脏标记时重绘。
	floor3DLayer.onFrame = () => engine?.markDirty();
	/** 3D 视图顶部的 ↑↓ 请求的换层动画：下一次场景同步时消费一次。 */
	let animateFloorSwap = false;
	const calibrationLineLayer = new CalibrationLineLayer();
	const planningAreaLayer = new PlanningAreaLayer();
	const surfacesLayer = new SurfacesLayer();
	const notesLayer = new NotesLayer();
	const vectorWallsLayer = new VectorWallsLayer();

	let autoSolveTimeout: ReturnType<typeof setTimeout> | null = null;
	let singleFloorView = $derived(appState.floorView === 'single');

	let showEmptyHint = $derived(
		singleFloorView && apState.aps.length === 0 && !floorplanState.floorplanUrl
	);

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
	 */
	function stepFloor(direction: 1 | -1): void {
		const sorted = [...floorState.floors].sort((a, b) => a.level - b.level);
		const index = sorted.findIndex((f) => f.id === floorState.currentFloorId);
		if (index < 0) return;
		const target = sorted[index + direction];
		if (!target) return;
		/*
		 * The arrows play the storey change: the old floor leaves, the new one follows.
		 * Clicking a floor in the strip stays immediate — it names the floor you want, and
		 * animating that would make a direct jump look like a sequence of storeys.
		 */
		animateFloorSwap = true;
		switchFloor(target.id);
		/*
		 * Frame the storey that just came into view; its plan may be a different size.
		 * An animated change frames itself halfway through instead — see the scene effect —
		 * so that the zoom change lands on an empty screen rather than on the floor leaving.
		 */
		requestAnimationFrame(() => {
			if (engine && !floor3DLayer.swapping) fitCanvasToContent(engine);
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

	$effect(() => {
		reviewHighlightLayer.box =
			singleFloorView ? canvasState.reviewHighlight : null;
		engine.markDirty();
	});

	$effect(() => {
		const points = appState.calibrationPoints;
		const visible = singleFloorView;
		calibrationLineLayer.a = visible && points[0] ? points[0] : null;
		calibrationLineLayer.b = visible && points[1] ? points[1] : null;
		engine.markDirty();
	});

	$effect(() => {
		if (!appState.planningDrawMode) return;
		selectionRectLayer.active = false;
		clearSelection();
		engine.markDirty();
	});

	$effect(() => {
		const visible = singleFloorView;
		const floor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
		planningAreaLayer.area =
			visible && appState.planningDrawMode ? (floor?.planningArea ?? null) : null;
		planningAreaLayer.draft = visible ? appState.planningDraft : [];
		planningAreaLayer.draftClosed = visible && appState.planningDraftClosed;
		planningAreaLayer.cursor = appState.planningDrawMode ? gestures.planningCursor : null;
		engine.markDirty();
	});

	$effect(() => {
		const floor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
		const planned = floor?.planningArea ?? null;
		const clip = planned ?? floorplanState.floorplanBoundary ?? null;
		if (!heatmapLayer) return;
		heatmapLayer.clipPolygon = clip;
		heatmapLayer.clipStrict = !!planned && planned.length >= 3;
		engine?.markDirty();
	});

	$effect(() => {
		const wupm = getEffectiveWupm();
		gridLayer.worldUnitsPerMeter = wupm;
		gridLayer.unitSystem = floorplanState.unitSystem;
		if (heatmapLayer) heatmapLayer.worldUnitsPerMeter = wupm;
		engine.markDirty();
	});

	$effect(() => {
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
				console.warn(
					'[heatmap] could not read a floor\'s wall mask; those cross-floor paths ' +
						"fall back to this floor's walls, which is the old single-run model.",
					err
				);
				resolved = apState.aps.filter((ap) => ap.floorId === floorId);
			}
			if (version !== heatmapApsVersion) return;
			heatmapLayer.aps = resolved;
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
		heatmapLayer.metric = appState.heatmapMetric;
		heatmapLayer.receiverPolarizationAngleDeg = projectMeta.receiverPolarizationAngleDeg;
		engine.markDirty();
	});

	$effect(() => {
		const floor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
		heatmapLayer.surfaces = floor?.surfaces ?? [];
		heatmapLayer.wallHeightM = floor?.ceilingHeight ?? 3;
		engine.markDirty();
	});

	$effect(() => {
		heatmapLayer.isDragging = canvasState.isDragging;
		engine.markDirty();
	});

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
		const floor = currentFloor();
		floorplanLayer.offsetX = floor?.floorplanOffsetX ?? 0;
		floorplanLayer.offsetY = floor?.floorplanOffsetY ?? 0;
		if (url) {
			floorplanLayer.loadImage(url, () => {
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

	$effect(() => {
		void i18nState.locale;
		engine.markDirty();
	});

	$effect(() => {
		void projectMeta.pathLossScenario;
		engine.markDirty();
	});

	$effect(() => {
		void wallState.wallMask;
		void projectMeta.allowOutsideRooms;
		void floorState.currentFloorId;
		for (const floor of floorState.floors) void floor.wallMask;
		for (const ap of apState.aps) {
			void ap.x;
			void ap.y;
			void ap.floorId;
		}
		if (appState.wallVectorDraft) {
			appState.outsideNotice = null;
			return;
		}
		if (projectMeta.allowOutsideRooms) {
			appState.outsideNotice = null;
			return;
		}
		if (canvasState.isDragging) return;
		let cancelled = false;
		void (async () => {
			const outside = await apsOutsideInterior();
			if (cancelled) return;
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
		referenceFloorLayer.scale =
			wupmForFloor(floorState.currentFloorId) / (wupmForFloor(below.id) || 1);
		const mask = below.wallMask;
		referenceFloorLayer.setMask(mask?.dataUrl ?? null, mask?.originX ?? 0, mask?.originY ?? 0);
		engine.markDirty();
	});

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
		const sources = floorState.floors.map((f) => ({
			id: f.id,
			name: f.name,
			planUrl: f.floorplanUrl,
			planOffsetX: f.floorplanOffsetX,
			planOffsetY: f.floorplanOffsetY,
			maskUrl: f.wallMask?.dataUrl ?? null,
			materialUrl: f.materialMask?.dataUrl ?? null,
			defaultMaterial: f.wallMaterial ?? 0,
			maskOriginX: f.wallMask?.originX ?? 0,
			maskOriginY: f.wallMask?.originY ?? 0,
			maskWidth: f.wallMask?.width ?? 0,
			maskHeight: f.wallMask?.height ?? 0,
			planningArea: f.planningArea ?? null,
			wupm: wupmForFloor(f.id),
			aps: apState.aps
				.filter((ap) => ap.floorId === f.id)
				.map((ap) => ({
					x: ap.x,
					y: ap.y,
					assignedChannel: ap.assignedChannel,
					band: ap.band,
					mountHeightM: apHeightAboveFloor(ap),
					mount: ap.mount,
					facingDeg: ap.facingDeg
				})),
			elevation: floorElevation(f.id)
		}));
		for (const layer of [floorTilesLayer, stackedFloorsLayer]) {
			layer.planOpacity = floorplanState.floorplanScale;
			layer.showPlan = appState.showFloorplan;
			layer.showWalls = appState.showWalls;
			layer.showAPs = appState.showAPs;
			layer.showHeatmap = appState.showHeatmap;
		}
		floorTilesLayer.setFloors(sources, floorState.currentFloorId, projectWupm());
		stackedFloorsLayer.setFloors(sources, floorState.currentFloorId, projectWupm());

		const view3dFloor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
		const view3dSource = sources.find((s) => s.id === floorState.currentFloorId) ?? null;
		floor3DLayer.planOpacity = floorplanState.floorplanScale;
		floor3DLayer.showPlan = appState.showFloorplan;
		floor3DLayer.showWalls = appState.showWalls;
		floor3DLayer.showAPs = appState.showAPs;
		floor3DLayer.showHeatmap = appState.showHeatmap;
		// Where the stack is being looked at from. Handed over here so the layer has
		// no opinion about where the sliders live; the camera object is replaced
		// rather than mutated so the layer cannot be left half-updated.
		const viewAngles = {
			yaw: (appState.stackYaw * Math.PI) / 180,
			pitch: Math.min((appState.stackPitch * Math.PI) / 180, MAX_PITCH),
			spacing: appState.stackSpread
		};

		stackedFloorsLayer.camera = { ...viewAngles, wupm: projectWupm() };
		floor3DLayer.camera = {
			...viewAngles,
			wupm: wupmForFloor(view3dFloor?.id ?? floorState.currentFloorId)
		};

		// What the 3D view draws. Built here so the layer holds one floor, not the app's state.
		const scene3d: FloorScene | null =
			view3dSource && view3dFloor
				? {
						source: view3dSource,
						walls: (view3dFloor.walls ?? []) as VectorWall[],
						columns: (view3dFloor.columns ?? []) as VectorColumn[],
						surfaces: view3dFloor.surfaces ?? [],
						ceilingHeightM: view3dFloor.ceilingHeight ?? 3,
						wupm: view3dSource.wupm
					}
				: null;
		// Consume the arrow's request once: any other path switches floors without animating.
		const animate = animateFloorSwap && appState.floorView === 'floor3d';
		animateFloorSwap = false;
		const swapping = floor3DLayer.setFloor(scene3d, { animate });
		/*
		 * Frame the new floor once the old one has faded out, not while it is still visible:
		 * the zoom change then happens on an empty screen. `contentBounds` reports the floor
		 * that is currently drawn, so this is a fit for the incoming floor. A later run of
		 * this effect (an orbit, a layer toggle) does not disturb that pending fit, and a
		 * second arrow press simply schedules its own.
		 */
		if (swapping) {
			setTimeout(() => {
				if (engine && appState.floorView === 'floor3d') fitCanvasToContent(engine);
			}, FLOOR_SWAP_MS / 2);
		}

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

	const tileHeatKeys = new Map<string, string>();
	let tileHeatWarming = false;

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

	function heatmapMaskTag(floor: { id: string; wallMask: { originX?: number; originY?: number } | null }): string {
		return `floor:${floor.id}@${floor.wallMask?.originX ?? 0},${floor.wallMask?.originY ?? 0}`;
	}

	/**
	 * World units per metre for the coverage images: one scale for the sheet.
	 */
	function projectWupm(): number {
		return wupmForFloor(floorState.floors[0]?.id);
	}

	/**
	 * What one floor's thumbnail depends on.
	 */
	function tileHeatKey(floor: Floor): string {
		const aps = apState.aps
			.map(
				(a) =>
					`${a.id}:${Math.round(a.x)}:${Math.round(a.y)}:${a.interferenceRadius}:${a.band}:${a.channelWidth}:${a.power}:${a.floorId}:` +
					`${a.mountHeightM}:${antennaSignature(a)}`
			)
			.join('|');
		const floors = floorState.floors
			.map(
				(f) =>
					`${f.id}:${f.level}:${f.ceilingHeight}:${f.floorThickness}:${f.floorMaterial}:${f.wallMaterial}` +
					`:u${f.calibration?.worldUnitsPerMeter ?? 0}` +
					`:p${f.planningArea?.map((p) => `${p.x},${p.y}`).join(';') ?? ''}` +
					`:w${maskTag(f.wallMask)}:m${maskTag(f.materialMask)}:r${maskTag(f.roomTypeMask)}`
			)
			.join('|');
		return (
			`${aps}|${floors}` +
			`|self:${maskTag(floor.wallMask)}:${floor.wallMask?.originX ?? 0},${floor.wallMask?.originY ?? 0}` +
			// The floor's own scale: the image is generated in its units, and every
			// cross-floor source is converted into them by `heatmapApsForFloor`.
			`|rssi:${projectMeta.heatmapRssiFloor}|wupm:${wupmForFloor(floor.id)}|ch:${projectMeta.clientHeight}` +
			`|metric:${appState.heatmapMetric}|rxpol:${projectMeta.receiverPolarizationAngleDeg}`
		);
	}

	/**
	 * One floor's thumbnail.
	 */
	async function buildTileHeatmap(
		floor: Floor
	): Promise<{ canvas: HTMLCanvasElement; x0: number; y0: number; texel: number } | null> {
		if (!heatmapLayer) return null;
		const stored = floor.wallMask;
		if (!stored) return null;
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
			worldUnitsPerMeter: wupmForFloor(floor.id),
			rssiFloor: projectMeta.heatmapRssiFloor,
			maskTag: heatmapMaskTag(floor),
			surfaces: floor.surfaces ?? [],
			clipPolygon: floor.planningArea ?? floorplanState.floorplanBoundary ?? null,
			clipStrict: !!floor.planningArea && floor.planningArea.length >= 3
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
					`${ap.id}:${Math.round(ap.x / (2 * wupm))}:${Math.round(ap.y / (2 * wupm))}:${ap.floorId}:${ap.interferenceRadius}:${ap.band}:${ap.channelWidth}:` +
					`${ap.mountHeightM}:${antennaSignature(ap)}`
			)
			.join('|') +
		`|wm:${maskTag(wallState.wallMask)}:${wallState.wallMaterial}` +
		// The client's height is the other end of every vertical term.
		`|mh:${projectMeta.clientHeight}`
	);

	let solverPending = false;
	$effect(() => {
		const auto = solverState.autoSolve;
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
		
		for (const ap of apState.aps) void ap.assignedChannel;
		if (apState.aps.length === 0 || !_mask) return;
		if (coverageTimeout) clearTimeout(coverageTimeout);
		coverageTimeout = setTimeout(() => updateCoverage(), 300);
	});

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

	$effect(() => {
		const floor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
		vectorWallsLayer.visible = singleFloorView && appState.showWalls;
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

	let wallsSyncTimer: ReturnType<typeof setTimeout> | null = null;
	let lastWallsKey = { floorId: '', signature: '' };
	$effect(() => {
		const floor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
		if (!floor) return;
		const wallsSig = (floor?.walls ?? [])
			.map((wall) => `${wall.ax},${wall.ay},${wall.bx},${wall.by},${wall.material}`)
			.join(';');
		const colsSig = (floor?.columns ?? [])
			.map((column) => `${column.shape},${column.ax},${column.ay},${column.bx},${column.by},${column.material}`)
			.join(';');
		const signature = `${wallsSig}|${colsSig}`;
		const sameFloor = lastWallsKey.floorId === floor.id;
		const hadWalls = sameFloor && lastWallsKey.signature !== '|';
		/*
		 * While the wall tool is open the drawing can be many strokes long; the mask is
		 * derived when the tool closes. Do not move `lastWallsKey` forward here: if the
		 * eraser removes the last wall and the effect records an empty signature, closing
		 * the tool would see "it was already empty" and leave the old mask on screen.
		 */
		if (appState.wallVectorMode) return;
		if (signature === '|' && !hadWalls) return;
		if (sameFloor && signature === lastWallsKey.signature) return;
		lastWallsKey = { floorId: floor.id, signature };
		if (wallsSyncTimer) clearTimeout(wallsSyncTimer);
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
			topHeightM:
				appState.surfaceKind === 'platform'
					? Math.max(0, appState.surfaceHeightM)
					: Math.max(0, appState.surfaceTopHeightM),
			attenuationDb: Math.max(0, appState.surfaceAttenuationDb),
			material: appState.surfaceMaterial ?? undefined,
			thicknessM: Math.max(0, appState.surfaceThicknessM),
			solidBase: appState.surfaceSolidBase
		};
		if (isDegenerateSurface(surface)) return;
		pushState();
		floor.surfaces = [...(floor.surfaces ?? []), surface];
		appState.surfaceSelected = surface.id;
		scheduleSave();
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
		// Clear the derived mask at the moment the last obstruction goes, rather than
		// waiting for the wall tool to close and leaving stale walls visible in the meantime.
		if (keptWalls.length === 0 && keptColumns.length === 0) {
			syncVectorWallsToMask(true);
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
	 */
	function commitPlanningDraft(): void {
		const draft = appState.planningDraft;
		if (draft.length < 3) return;
		const floor = floorState.floors.find((f) => f.id === floorState.currentFloorId);
		if (!floor) return;
		pushState();
		
		const target = floorState.floors.find((f) => f.id === floor.id);
		if (!target) return;
		target.planningArea = draft.map((point) => ({ x: point.x, y: point.y }));
		
		if (heatmapLayer) {
			heatmapLayer.clipPolygon = target.planningArea;
			heatmapLayer.clipStrict = true;
		}
		setPlanningDrawMode(false);
		gestures.planningCursor = null;
		forgetInterior(target.id);
		engine?.markDirty();
		scheduleSave();
	}

	/**
	 * A double-click on the same spot closes the loop — and nothing else does.
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
	
	<div
		class="view-fade"
		class:covering={viewTransition.covering}
		class:active={viewTransition.active}
		aria-hidden="true"
	></div>
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
	{#if appState.planningDrawMode && appState.floorView === 'single'}
		<PlanningToolbar
			corners={appState.planningDraft.length}
			onclose={commitPlanningDraft}
			onundo={() => {
				appState.planningDraft = appState.planningDraft.slice(0, -1);
				appState.planningDraftClosed = false;
			}}
			oncancel={() => {
				appState.planningDraft = [];
				appState.planningDraftClosed = false;
				setPlanningDrawMode(false);
			}}
		/>
	{/if}
	
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

	.view-fade {
		position: absolute;
		inset: 0;
		z-index: 5;
		background: var(--canvas-bg);
		opacity: 0;
		pointer-events: none;
		transition: opacity 160ms cubic-bezier(0.2, 0.8, 0.2, 1);
	}

	.view-fade.covering {
		opacity: 1;
	}

	.view-fade.active {
		pointer-events: auto;
	}

	@media (prefers-reduced-motion: reduce) {
		.view-fade {
			transition: none;
		}
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
