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
	import { WallEditHandler } from '$canvas/interactions/wall-edit.js';
	import { PanZoomHandler } from '$canvas/interactions/pan-zoom.js';
	import { SelectHandler } from '$canvas/interactions/select.js';
	import { SelectionRectLayer } from '$canvas/renderers/selection-rect.js';
	import { ReviewHighlightLayer } from '$canvas/renderers/review-highlight.js';
	import { ShapePreviewLayer } from '$canvas/renderers/shape-preview.js';
	import { ReferenceFloorLayer } from '$canvas/renderers/reference-floor.js';
	import { FloorTilesLayer } from '$canvas/renderers/floor-tiles.js';
	import { StackedFloorsLayer, MAX_PITCH } from '$canvas/renderers/stacked-floors.js';
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
	import { canvasState, clearSelection } from '$state/canvas.svelte.js';
	import {
		appState,
		setFloorAlignMode,
		setApPlaceMode,
		STACK_YAW_LIMIT_DEG,
		STACK_MIN_PITCH_DEG,
		STACK_MAX_PITCH_DEG
	} from '$state/app.svelte.js';
	import { undo, redo, pushState } from '$state/history.svelte.js';
	import {
		solverState,
		runSolver,
		invalidateSolverMaskCache,
		setLiveSolverMask,
		getFloorMask
	} from '$state/solver.svelte.js';
	import { updateCoverage, optimizerState, floorCoverage, apsOutsideInterior } from '$state/optimizer.svelte.js';
	import { hitTest } from '$canvas/hit-test.js';
	import { setEngineRef } from '$canvas/engine-ref.js';
	import { restoreFromStorage } from '$state/persistence.svelte.js';
	import { importFloorplanFile } from '$canvas/import-floorplan.js';
	import { labelWallBlobs, relabelBlob, labelRooms, fillRegion, encodeMaterialMask, decodeMaterialMask } from '$canvas/region-labels.js';
	import type { RegionLabels } from '$canvas/region-labels.js';
	import { WALL_MATERIALS, type WallMaterialId } from '$canvas/materials.js';
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
	import { TiledMask } from '$canvas/tiled-mask.js';
	import { scheduleSave } from '$state/persistence.svelte.js';
	import { computeBuildingInterior } from '$canvas/morphology.js';
	import { RoomLabelsLayer } from '$canvas/renderers/room-labels.js';
	import { ROOM_TYPES } from '$canvas/room-types.js';
	import LayerPanel from '$components/canvas/LayerPanel.svelte';
	import WallMaterialPopup from '$components/canvas/WallMaterialPopup.svelte';
	import RoomTypePopup from '$components/canvas/RoomTypePopup.svelte';
	import WallEditToolbar from '$components/canvas/WallEditToolbar.svelte';
	import ConfirmDialog from '$components/dialogs/ConfirmDialog.svelte';
	import { t, i18nState } from '$state/i18n.svelte';
	import { displayLength, formatMeasure, lengthUnit } from '$lib/units.js';

	let wallEditMaterial = $state<WallMaterialId>(0);
	let clearWallsConfirmOpen = $state(false);
	let brushCursorX = $state(0);
	let brushCursorY = $state(0);
	let brushCursorSize = $state(0);
	let brushCursorVisible = $state(false);

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
	 * Encode the editor's mask and publish it as the floor's wall mask.
	 *
	 * Returns false when there is no raster at all — no pixels and no frame — which
	 * is the same statement as "this floor has no floorplan".
	 */
	function persistWallMaskFromEditor(): boolean {
		const mat = wallEditHandler?.tiledMask?.materialize();
		if (!mat) return false;

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
		scheduleSave();
		return true;
	}

	function handleWallEditDone() {
		appState.wallEditMode = null;
		brushCursorVisible = false;
		// A shape can still be mid-drag when the mode is torn down, and the preview
		// layer draws independently of the handler, so clear it explicitly.
		if (shapePreviewLayer) shapePreviewLayer.active = false;
		heatmapLayer.isDragging = false; // restore full-resolution grid
		setLiveSolverMask(null, null, 0, 0); // clear live mask override

		persistWallMaskFromEditor();
	}

	let canvasDragOver = $state(false);

	/**
	 * Wipe every wall on the current floor.
	 *
	 * The mask survives as an empty raster of the same size. Drop it entirely and
	 * `materialize()` returns null (no pixels, no frame), which every consumer reads
	 * as "no floorplan here" — the wall editor included, so clearing the walls also
	 * ended the drawing session and the next stroke went nowhere. A zeroed mask of a
	 * known size is a state the rest of the app already handles, because it is
	 * exactly what an imported plan whose detection found no walls looks like.
	 */
	function handleClearWalls() {
		clearWallsConfirmOpen = false;
		const tm = wallEditHandler?.tiledMask;
		if (!tm) return;

		pushState();

		// Keep the raster frame across the clear. `bounds` is the box the raster was
		// last materialised at, so pinning it means the mask keeps its size and
		// origin — room type labels, which are indexed by the same raster, stay put.
		const frame = tm.bounds;
		tm.clear();
		if (frame) tm.setFrame(frame.originX, frame.originY, frame.width, frame.height);

		if (persistWallMaskFromEditor()) return;

		// Nothing to persist even with the frame: this floor genuinely has no
		// floorplan. Drop the mask everywhere, as the old code always did.
		wallState.wallMask = null;
		wallState.materialMask = null;
		cachedWallData = null;
		cachedMaterialData = null;
		cachedWallLabels = null;
		cachedInterior = null;
		cachedRoomLabels = null;
		lastWallMaskUrl = null;
		lastMatMaskUrl = null;

		wallMaskVersion++;
		invalidateSolverMaskCache();

		wallLayer.mask = null;
		wallLayer.materialMap = null;
		wallLayer.invalidateCache();
		heatmapLayer.wallMask = null;
		heatmapLayer.materialMap = null;
		heatmapLayer.markWallsDirty();
		heatmapLayer.materialVersion++;
		setApWallMask(null);
		if (roomLabelsLayer) {
			roomLabelsLayer.roomLabels = null;
			roomLabelsLayer.roomTypeData = null;
			roomLabelsLayer.invalidateCache();
		}

		engine.markDirty();
		scheduleSave();
	}

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
	let wallPopup = $state<{ x: number; y: number; material: WallMaterialId; blobId: number } | null>(null);
	let cachedWallLabels: ReturnType<typeof labelWallBlobs> | null = null;
	let cachedMaterialData: Uint8Array | null = null;
	let cachedWallData: Uint8Array | null = null;
	let cachedTiledMask: TiledMask | null = null;
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

	/** Right-click / long-press contextual handler: wall popup or room popup. */
	function handleContextAction(screenX: number, screenY: number): boolean {
		// Try wall first, then room
		if (handleWallClick(screenX, screenY)) return true;
		if (handleRoomClick(screenX, screenY)) return true;
		return false;
	}

	function handleContextMenu(e: MouseEvent) {
		if (appState.floorAlignMode) {
			e.preventDefault();
			cancelAlignDrag();
			setFloorAlignMode(false);
			return;
		}
		if (appState.wallEditMode) {
			// Right-click abandons the shape being dragged. preventDefault is
			// required: otherwise the native menu opens over the canvas and the
			// drag stays live underneath it until the button is released.
			e.preventDefault();
			wallEditHandler?.cancelEdit();
			brushCursorVisible = false;
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
		if (!wallPopup || !cachedWallLabels || !wallState.wallMask) return;
		pushState(); // undo captures state before blob relabel
		const mask = wallState.wallMask;

		// Create or clone material mask
		if (!cachedMaterialData) {
			cachedMaterialData = new Uint8Array(mask.width * mask.height);
			cachedMaterialData.fill(wallState.wallMaterial);
		}

		relabelBlob(cachedWallLabels.labels, cachedMaterialData, wallPopup.blobId, newMaterial);

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
	let wallEditHandler: WallEditHandler;
	let floorplanLayer: FloorplanLayer;
	let gridLayer: GridLayer;
	let heatmapLayer: HeatmapLayer;
	let selectionRectLayer: SelectionRectLayer;
	let reviewHighlightLayer: ReviewHighlightLayer;
	let shapePreviewLayer: ShapePreviewLayer;
	let referenceFloorLayer: ReferenceFloorLayer;
	let floorTilesLayer: FloorTilesLayer;
	let stackedFloorsLayer: StackedFloorsLayer;
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
	let showEmptyHint = $derived(apState.aps.length === 0 && !floorplanState.floorplanUrl);

	function handleKeyDown(e: KeyboardEvent) {
		const target = e.target as HTMLElement;
		const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
		const mod = e.metaKey || e.ctrlKey;

		// Shape tools constrain on Shift, and the key can be pressed without any
		// pointer movement in between, so forward it to the handler directly.
		if (!isInput && e.key === 'Shift' && wallEditHandler) {
			wallEditHandler.setShift(true);
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

		if (mod && e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
			if (appState.wallEditMode) return; // no undo during wall drawing
			e.preventDefault();
			redo();
			engine?.markDirty();
			return;
		}

		if (mod && (e.key === 'z' || e.key === 'Z')) {
			if (appState.wallEditMode) return; // no undo during wall drawing
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

	function handleKeyUp(e: KeyboardEvent) {
		if (e.key === 'Shift' && wallEditHandler) wallEditHandler.setShift(false);
	}

	onMount(() => {
		restoreFromStorage();
		window.addEventListener('keydown', handleKeyDown);
		window.addEventListener('keyup', handleKeyUp);
		engine = new CanvasEngine(canvasEl);
		setEngineRef(engine);
		// Create layers
		floorplanLayer = new FloorplanLayer();
		gridLayer = new GridLayer();
		heatmapLayer = new HeatmapLayer();
		wallLayer = new WallLayer();
		roomLabelsLayer = new RoomLabelsLayer();
		apLayer = new ApLayer();
		selectionRectLayer = new SelectionRectLayer();
		reviewHighlightLayer = new ReviewHighlightLayer();
		shapePreviewLayer = new ShapePreviewLayer();
		referenceFloorLayer = new ReferenceFloorLayer();
		referenceFloorLayer.onLoad = () => engine?.markDirty();
		floorTilesLayer = new FloorTilesLayer(floorCards);
		floorTilesLayer.onLoad = () => engine?.markDirty();
		stackedFloorsLayer = new StackedFloorsLayer(floorCards);
		stackedFloorsLayer.onLoad = () => engine?.markDirty();

		// Add layers in draw order: floorplan, grid, heatmap, walls, room labels, APs, selection rect, shape preview
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
		// Above everything, including the shape preview: it answers a question about the
		// mask underneath it and has to stay legible while the user edits walls.
		engine.addLayer(reviewHighlightLayer);
		engine.addLayer(shapePreviewLayer);

		// Create interaction handlers
		panZoom = new PanZoomHandler(engine);
		panZoom.attach();
		selectHandler = new SelectHandler(engine, selectionRectLayer);
		dragHandler = new DragHandler(engine, wallProbe);
		placeHandler = new PlaceHandler(engine);
		wallEditHandler = new WallEditHandler(engine);
		wallEditHandler.preview = shapePreviewLayer;
		wallEditHandler.onEdit = () => {
			// Materialize tiled mask to flat arrays for renderers
			const mat = wallEditHandler.tiledMask?.materialize();
			if (mat) applyMaskToRenderers(mat);
			// Don't rebuild attenuation fields per stroke — too expensive.
			// Wall overlay updates live; heatmap uses stale field until Done.
			engine.markDirty();

			// Defer solver to Done — per-stroke solve is too expensive
		};

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
			window.removeEventListener('keyup', handleKeyUp);
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

		const show = appState.floorView === 'single' && appState.showAPs && !appState.wallEditMode;
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

	// Coarser wall grid during drag or wall editing for responsiveness
	$effect(() => {
		if (!heatmapLayer) return;
		heatmapLayer.isDragging = canvasState.isDragging || !!appState.wallEditMode;
		engine.markDirty();
	});

	/**
	 * The heatmap stands down while walls are being edited.
	 *
	 * Every dab rewrites the wall mask, and the heatmap is rebuilt from it — one
	 * attenuation field marched per AP over the whole plan, on the main thread, in
	 * the same frame as the stroke. Coarsening the grid during edits (above) was not
	 * enough; drawing with the heatmap on stutters badly. So it is switched off for
	 * the duration, and switched back on afterwards if it was on before — the user
	 * asked for it off while drawing, not off for good.
	 *
	 * Turning it back on *during* an edit is respected: the flag is only set when
	 * this effect is the one switching it off.
	 */
	let heatmapWasOnBeforeEdit = false;
	$effect(() => {
		if (appState.wallEditMode) {
			if (appState.showHeatmap) {
				heatmapWasOnBeforeEdit = true;
				appState.showHeatmap = false;
			}
		} else if (heatmapWasOnBeforeEdit) {
			heatmapWasOnBeforeEdit = false;
			appState.showHeatmap = true;
		}
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

		// Cancel wall edit mode on floor switch to prevent editing the wrong floor
		if (appState.wallEditMode) {
			appState.wallEditMode = null;
			if (shapePreviewLayer) shapePreviewLayer.active = false;
		}

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
		cachedTiledMask = null;
		cachedInterior = null;
		cachedRoomLabels = null;
		cachedRoomTypeData = null;
		// And the editor's copy with them. Clearing only `cachedTiledMask` left the
		// handler holding the *previous* floor's mask, so strokes landed in the
		// wrong coordinate frame — and with an alignment offset between the two
		// floors that is off the mask entirely, which makes editing look like it
		// does nothing. If a decode is slow or gets superseded, that stale mask is
		// what the next stroke uses.
		if (wallEditHandler) wallEditHandler.tiledMask = null;
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
			// The editor's mask too, or a floor with no walls leaves the handler
			// painting into whatever mask it was last handed.
			cachedTiledMask = null;
			if (wallEditHandler) wallEditHandler.tiledMask = null;
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
			// pixel address: the renderer places the raster at it, the editor writes
			// into the raster at it, and the two have to agree on one integer. A
			// fractional address also makes `fromFlat` drop every pixel it writes
			// (see tiled-mask.ts), which loaded an offset floor's detected walls as
			// a blank raster that the first edit then saved over them.
			decoded.originX = Math.round(mask.originX ?? 0);
			decoded.originY = Math.round(mask.originY ?? 0);

			const defaultMat = wallState.wallMaterial;

			// Build the wall editor's mask FIRST, before anything that can throw.
			//
			// This used to sit after `labelWallBlobs` and the interior/room
			// detection, so a failure anywhere in that decoration left the editor
			// holding no mask at all — every stroke returned early and the canvas
			// simply did not respond, with nothing in the console to say why
			// because the chain had no catch. Editing being dead is a far worse
			// failure than a stale room label, so the critical artefact goes first
			// and the decoration is allowed to fail on its own.
			cachedTiledMask = TiledMask.fromFlat(
				decoded.data, decoded.width, decoded.height,
				matData, defaultMat,
				decoded.originX, decoded.originY
			);
			if (wallEditHandler) wallEditHandler.tiledMask = cachedTiledMask;

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
			console.info(
				'[walls] decode complete; editor mask ready' +
					(cachedTiledMask ? ` (bounds ${JSON.stringify(cachedTiledMask.bounds)})` : ' (none)')
			);
		}).catch((err) => {
			// Without this the chain failed silently, so "the editor has no mask"
			// arrived with no explanation of why the decode never finished.
			console.error(
				'[walls] floorplan decode failed. The editor keeps whatever mask it last had, so ' +
					'if this is the first decode for this floor, editing will not respond at all.',
				err
			);
		});
	});


	$effect(() => {
		if (!wallLayer) return;
		wallLayer.visible = appState.floorView === 'single' && appState.showWalls;
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
		for (const ap of apState.aps) {
			void ap.x;
			void ap.y;
			void ap.floorId;
		}
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
		if (!floorTilesLayer || !stackedFloorsLayer || !engine) return;
		// Both overviews are read-only layouts of the same cards, so they share the
		// layer toggles, the underlay alpha and the source list; only one is visible
		// at a time.
		const overview = appState.floorView !== 'single';
		const stacked = appState.floorView === 'stacked';
		floorTilesLayer.visible = appState.floorView === 'tiled';
		stackedFloorsLayer.visible = stacked;
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
		// Where the stack is being looked at from. Handed over here so the layer has
		// no opinion about where the sliders live; the camera object is replaced
		// rather than mutated so the layer cannot be left half-updated.
		stackedFloorsLayer.camera = {
			yaw: (appState.stackYaw * Math.PI) / 180,
			pitch: Math.min((appState.stackPitch * Math.PI) / 180, MAX_PITCH),
			spacing: appState.stackSpread,
			wupm: getEffectiveWupm()
		};
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
			maskTag: `floor:${floor.id}`
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
	let autoSolveKey = $derived(
		apState.aps
			.map(
				(ap) =>
					`${ap.id}:${Math.round(ap.x)}:${Math.round(ap.y)}:${ap.floorId}:${ap.interferenceRadius}:${ap.band}:${ap.channelWidth}:` +
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
			runSolver();
		}, 500);
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

			// Wall edit mode: single touch draws
			if (appState.wallEditMode) {
				e.preventDefault();
				wallEditHandler.activeMaterial = wallEditMaterial;
				wallEditHandler.defaultMaterial = wallState.wallMaterial;
				wallEditHandler.handlePointerDown(
					new PointerEvent('pointerdown', { clientX: t.clientX, clientY: t.clientY, button: 0 })
				);
				return;
			}

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
			if (appState.wallEditMode) {
				wallEditHandler.handlePointerUp();
				brushCursorVisible = false;
			}
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

		// Wall edit mode: single touch draws
		if (appState.wallEditMode) {
			e.preventDefault();
			wallEditHandler.handlePointerMove(
				new PointerEvent('pointermove', { clientX: t.clientX, clientY: t.clientY })
			);
			const rect = engine.canvas.getBoundingClientRect();
			brushCursorX = t.clientX - rect.left;
			brushCursorY = t.clientY - rect.top;
			brushCursorVisible = true;
			return;
		}

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
			// Wall edit mode: end stroke
			if (appState.wallEditMode) {
				wallEditHandler.handlePointerUp();
				brushCursorVisible = false;
				activeTouches = 0;
				return;
			}

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
		// Wall edit mode intercepts primary pointer
		if (appState.wallEditMode) {
			wallEditHandler.activeMaterial = wallEditMaterial;
			wallEditHandler.defaultMaterial = wallState.wallMaterial;
			// Self-heal before handing the stroke over.
			//
			// The editor's mask is normally built by the async decode effect. When
			// that chain fails, is superseded, or simply has not finished, the
			// handler is left with no mask and every stroke returns at its first
			// line — editing is dead, silently, with no way back short of a reload.
			// If the decoded pixels are here, build the mask now: it is a
			// synchronous copy of an array that already exists, and it turns a
			// permanent failure into a single skipped frame.
			if (!wallEditHandler.tiledMask && cachedWallData && wallLayer?.mask) {
				const dm = wallLayer.mask;
				wallEditHandler.tiledMask = TiledMask.fromFlat(
					cachedWallData,
					dm.width,
					dm.height,
					cachedMaterialData,
					wallState.wallMaterial,
					dm.originX,
					dm.originY
				);
				console.info('[walls] rebuilt the editor mask from the decoded pixels');
			}
			wallEditHandler.handlePointerDown(e);
			return;
		}
		processPointerDown(e);
	}

	function handlePointerMove(e: PointerEvent) {
		if (!engine) return;
		if (e.pointerType === 'touch') return;
		// Which slab is under the pointer, in the stacked overview. Read-only and
		// cheap: the layout is a few floors of arithmetic, and only a *change* marks
		// the canvas dirty, so a moving pointer does not repaint per pixel.
		if (appState.floorView === 'stacked' && stackedFloorsLayer) {
			// While the view is being dragged there is no hovering to report: the
			// pointer is holding the camera, not pointing at a floor.
			if (orbitPointerId === e.pointerId) {
				const dx = e.clientX - orbitStartX;
				const dy = e.clientY - orbitStartY;
				if (!orbitMoved && Math.hypot(dx, dy) >= DRAG_THRESHOLD) {
					orbitMoved = true;
					stackedFloorsLayer.hoverFloorId = null;
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
		if (appState.wallEditMode) {
			const rect = engine.canvas.getBoundingClientRect();
			brushCursorX = e.clientX - rect.left;
			brushCursorY = e.clientY - rect.top;
			brushCursorSize = appState.wallBrushSize * 2 * engine.camera.state.zoom;
			brushCursorVisible = true;
			wallEditHandler.handlePointerMove(e);
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
		if (appState.wallEditMode) {
			// Pass the event so the handler can read Shift at release time — the
			// last modifier state is what constrains the committed shape.
			wallEditHandler.handlePointerUp(e);
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
		onpointerup={handlePointerUp}
		onpointerleave={() => {
			brushCursorVisible = false;
			// Leaving the canvas has to drop the stack highlight: the pointer move
			// that would clear it never arrives.
			if (stackedFloorsLayer?.hoverFloorId) {
				stackedFloorsLayer.hoverFloorId = null;
				engine?.markDirty();
			}
		}}
		oncontextmenu={handleContextMenu}
		ontouchstart={handleTouchStart}
		ontouchmove={handleTouchMove}
		ontouchend={handleTouchEnd}
		ontouchcancel={handleTouchEnd}
	></canvas>
	{#if !appState.wallEditMode}
		<LayerPanel />
	{/if}
	{#if appState.wallEditMode}
		<WallEditToolbar
			bind:activeMaterial={wallEditMaterial}
			ondone={handleWallEditDone}
			onclear={() => (clearWallsConfirmOpen = true)}
		/>
		{#if brushCursorVisible}
			<div
				class="brush-cursor"
				style="left: {brushCursorX - brushCursorSize / 2}px; top: {brushCursorY - brushCursorSize / 2}px; width: {brushCursorSize}px; height: {brushCursorSize}px"
			></div>
		{/if}
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

<ConfirmDialog
	bind:open={clearWallsConfirmOpen}
	title={t('Clear all walls')}
	message="This removes every wall on this floor, including wall material assignments. Access points and room type labels are not affected. You can undo this with Cmd/Ctrl+Z."
	confirmLabel="Clear walls"
	onconfirm={handleClearWalls}
/>

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

	.brush-cursor {
		position: absolute;
		border: 1.5px solid var(--accent-primary);
		border-radius: 50%;
		pointer-events: none;
		z-index: 15;
		opacity: 0.7;
	}

	.canvas-container.drag-over {
		outline: 3px dashed var(--accent-primary);
		outline-offset: -3px;
	}

	canvas {
		display: block;
		touch-action: none;
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
