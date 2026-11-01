<script lang="ts">
	import { debug } from '$lib/log.js';
import { wallState } from '$state/wall-state.svelte.js';
	import { floorplanState } from '$state/floorplan-state.svelte.js';
	import { apState, getEffectiveWupm } from '$state/ap-state.svelte.js';
	import {
		floorState,
		switchFloor,
		addFloor,
		removeFloor,
		currentFloor,
		translateFloor,
		setProjectCalibration
	} from '$state/floor-state.svelte.js';
	import { FLOOR_MATERIALS } from '$canvas/floor-materials.js';
	import Select from '$components/shared/Select.svelte';
	import ConfirmDialog from '$components/dialogs/ConfirmDialog.svelte';
	import FloorStrip from './FloorStrip.svelte';
	import FloorplanNotes from './FloorplanNotes.svelte';
	import FloorplanSurfaces from './FloorplanSurfaces.svelte';
	import { setCalibrateMode } from '$state/app.svelte';
	import { setPlanningDrawMode } from '$state/app.svelte';
	import { wupmFromSegment } from '$state/calibrate.js';
	import { forgetInterior } from '$state/ap-interior.js';
	import { getFloorMask } from '$state/floor-mask.js';
	import { compareWallModels, type WallModelComparison } from '$lib/rf/wall-model-compare.js';
	import { rasterRayLossDb } from '$lib/rf/raster-ray.js';
	import type { WallMaterialId } from '$canvas/materials.js';
	import { traceFloorWalls, setFloorWallsFromSegments } from '$state/wall-trace.js';
	import { rasteriseWalls as rasteriseWallsToMasks } from '$state/wall-raster.js';
	import { encodeMaterialMask } from '$canvas/region-labels.js';

	let confirmOpen = $state(false);
	let confirmMessage = $state('');
	let confirmAction = $state<(() => void) | null>(null);
	let confirmTitle = $state('Delete');
	let confirmLabel = $state('Delete');

	function showConfirm(
		message: string,
		action: () => void,
		title = 'Delete',
		label = 'Delete'
	) {
		confirmMessage = message;
		confirmAction = action;
		confirmTitle = title;
		confirmLabel = label;
		confirmOpen = true;
	}

	/**
	 * Shift the current floor so its plan lines up with the floors above and
	 * below it.
	 *
	 * The argument is in the project's *display* unit, rounded the way the field
	 * shows it, and is converted to metres before it reaches the model — the model
	 * is metric whatever the toolbar says. A display value of 0 ft is a real
	 * request to move the floor onto its neighbour, so it is honoured rather than
	 * treated as "no input"; only a non-finite one is ignored.
	 *
	 * The whole floor moves — underlay, masks and APs — so the floor stays rigid.
	 *
	 * `translateFloor` shifts the mask *origin* without touching a pixel, so the
	 * canvas's decode effect has to notice the origin too; see the origin
	 * tracking in CanvasView.
	 */
	function applyAlign(axis: 'x' | 'y', displayValue: number): void {
		const floor = currentFloor();
		if (!Number.isFinite(displayValue)) return;
		const metres = unitToMetres(displayValue, lengthUnit(unitSystem));
		const wupm = getEffectiveWupm();
		const target = metres * wupm;
		const current = axis === 'x' ? floor.floorplanOffsetX : floor.floorplanOffsetY;
		const delta = target - current;
		if (delta === 0) return;
		pushState();
		translateFloor(floor.id, axis === 'x' ? delta : 0, axis === 'y' ? delta : 0, apState.aps);
		scheduleSave();
	}

	/** World-unit offset shown as metres or feet, matching the toolbar. */
	function alignDisplay(worldUnits: number): number {
		const metres = worldUnits / (getEffectiveWupm() || 1);
		return displayLength(metres, lengthUnit(unitSystem)).value;
	}



	import { appState, setFloorAlignMode, notifyWalls, setSurfaceMode } from '$state/app.svelte.js';
	import { updateCoverage } from '$state/optimizer.svelte.js';
	import type { SurfaceKind } from '$lib/rf/surface-height.js';
	import { stepCount } from '$lib/rf/surface-height.js';
	import NumberInput from '$components/shared/NumberInput.svelte';
	import { detectBoundary, polygonArea } from '$canvas/boundary-detect.js';
	import { encodeMask } from '$canvas/wall-detect.js';
	import { detectFloorplanMasks } from '$canvas/detect-floorplan.js';
	import { scheduleSave, forgetFloorplan } from '$state/persistence.svelte.js';
	import { pushState } from '$state/history.svelte.js';
	import Button from '$components/shared/Button.svelte';
	import Icon from '$components/shared/Icon.svelte';
	import WallDetectionPanel from '$components/sidebar/WallDetectionPanel.svelte';
	import { t } from '$state/i18n.svelte';
	import {
		areaUnit as areaUnitFor,
		convertArea,
		displayArea,
		displayLength,
		lengthInputHints,
		lengthUnit,
		roundForDisplay,
		unitToMetres,
		unitToSqm,
		type AreaUnit
	} from '$lib/units.js';

	const FLOORPLAN_TARGET_WIDTH = 800;


	let fileInput = $state<HTMLInputElement>();
	let dragOver = $state(false);
	let detecting = $state(false);
	let detectedWorldArea = $state<number | null>(null);
	let calibrationDone = $state(false);

	/**
	 * The unit system the toolbar's ft/m button selects, and the area unit that
	 * follows from it.
	 *
	 * The area field used to carry its own sqm/sqft button, which meant a project
	 * could be shown in feet everywhere except the one field that decides its
	 * scale. It is derived now, so the two cannot disagree.
	 */
	const unitSystem = $derived(floorplanState.unitSystem);
	const areaUnit = $derived(areaUnitFor(unitSystem));

	/**
	 * The area the user has typed, as text, and the unit that text is in.
	 *
	 * Kept as the raw string rather than as a parsed number: the field has to
	 * survive a half-typed decimal ("1.") without the renderer rewriting it, and a
	 * parsed number round-tripped through the display formatter would eat the dot.
	 */
	let areaInput = $state('');
	/** The stated real length of the line the user measured, in the toolbar's unit. */
	let measureInput = $state('');
	let measureError = $state<string | null>(null);
	let areaInputUnit = $state<AreaUnit>(areaUnitFor(floorplanState.unitSystem));

	/**
	 * Re-express what the user typed in the newly selected unit.
	 *
	 * This is the "convert, don't reinterpret" half of the ft/m switch: an area
	 * typed as 200 sqm has to read as 2153 sqft afterwards, not stay 200 and
	 * silently become square feet. Values that are not a number — an empty field,
	 * or a half-typed one — are left exactly as they are.
	 */
	$effect(() => {
		const next = areaUnit;
		if (next === areaInputUnit) return;
		const typed = parseFloat(areaInput);
		if (Number.isFinite(typed) && typed > 0) {
			areaInput = String(roundForDisplay(convertArea(typed, areaInputUnit, next)));
		}
		areaInputUnit = next;
	});

	/** Write an area in square metres into the field, in the unit on screen. */
	function setAreaSqm(sqm: number): void {
		areaInputUnit = areaUnit;
		areaInput = displayArea(sqm, areaUnit).text;
	}

	/** What the field holds, in square metres, or null when it holds no area. */
	function areaInputSqm(): number | null {
		const typed = parseFloat(areaInput);
		if (!Number.isFinite(typed) || typed <= 0) return null;
		return unitToSqm(typed, areaInputUnit);
	}

	let hasFloorplan = $derived(floorplanState.floorplanUrl !== null || wallState.wallMask !== null);

	/**
	 * Whether there is anything for this floor to be aligned *to*.
	 *
	 * Alignment shifts the current floor onto the one below it, so the bottom
	 * floor has no counterpart: its offsets exist only because every floor carries
	 * them. Offering the control there invites a shift that lines the floor up with
	 * nothing.
	 *
	 * Tiled view cannot honour it either — a pointer down there picks a card and
	 * returns, so the drag the button asks for never reaches the alignment handler.
	 * That makes the button a mode the user can enter and not use, which is worse
	 * than not showing it.
	 */
	let canAlign = $derived(
		floorState.floors.length > 1 &&
			floorState.floors.findIndex((f) => f.id === floorState.currentFloorId) > 0 &&
			appState.floorView === 'single'
	);

	// Leaving align mode on the way out matters: the button that leaves it is the
	// one being hidden, and a mode with no visible escape reads as a stuck app.
	// (Escape and a right-click also leave it; this is the path that keeps the two
	// from disagreeing.)
	$effect(() => {
		if (!canAlign && appState.floorAlignMode) setFloorAlignMode(false);
	});

	/**
	 * The bundled sample plans, by name and true area.
	 *
	 * The area is stored in square metres — it is what the plan physically is, and
	 * what `loadSample` calibrates against — while the label is built for display,
	 * so a sample does not read "48sqm" in a column that is otherwise in feet.
	 */
	const sampleFloorplans = [
		{ name: 'Apartment', file: '/samples/apartment-48sqm.svg', areaSqm: 48 },
		{ name: 'House', file: '/samples/house-120sqm.svg', areaSqm: 120 },
		{ name: 'Office', file: '/samples/office-300sqm.svg', areaSqm: 300 }
	];

	/** The sample buttons, each with its area in the unit on screen. */
	const sampleOptions = $derived(
		sampleFloorplans.map((sample) => ({
			...sample,
			label: `${sample.name} (${displayArea(sample.areaSqm, areaUnit).text} ${areaUnit})`
		}))
	);

	/**
	 * The calibration scale, in the unit the toolbar selects.
	 *
	 * Two decimals whatever the unit: this is a ratio, not a length, and
	 * "1px = 0.07 ft" is the informative form of a figure whose whole point is the
	 * second decimal. `roundForDisplay`'s whole-number rule would flatten it to
	 * "0 ft".
	 */
	let scaleDisplay = $derived.by(() => {
		if (!floorplanState.calibration) return null;
		const mPerPx = 1 / floorplanState.calibration.worldUnitsPerMeter;
		if (unitSystem === 'imperial') {
			return `1px = ${(mPerPx * 3.28084).toFixed(2)}ft`;
		}
		return `1px = ${mPerPx.toFixed(2)}m`;
	});

	/**
	 * The unit every length in this panel is shown in — ceiling height, slab
	 * thickness and the two alignment offsets.
	 *
	 * One binding for all four, so they cannot disagree with each other or with
	 * the toolbar button that changes them.
	 */
	const lengthDisplayUnit = $derived(lengthUnit(unitSystem));

	// The model's real bounds, in the unit on screen: a ceiling is 2–10 m whatever
	// the field says. See `lengthInputHints`.
	const ceilingHints = $derived(lengthInputHints(2, 10, 0.5, lengthDisplayUnit));
	const thicknessHints = $derived(lengthInputHints(0.05, 1, 0.05, lengthDisplayUnit));

	/**
	 * Where the current floor's underlay sits in world space.
	 *
	 * Wall detection and boundary detection both measure in image pixels, so
	 * everything they return is anchored at the image's top-left. That used to be
	 * the world origin because the underlay was pinned there; now that a floor can
	 * be moved with `translateFloor`, their output has to move with it.
	 */
	function underlayOffset(): { x: number; y: number } {
		const floor = currentFloor();
		return { x: floor?.floorplanOffsetX ?? 0, y: floor?.floorplanOffsetY ?? 0 };
	}

	/**
	 * Shift a freshly detected mask so it lands under the underlay.
	 *
	 * `detectWalls` always reports an origin of (0, 0) — the image's top-left.
	 * Without this the detected walls come back offset from the plan by exactly
	 * the floor's alignment.
	 *
	 * Added rather than assigned, so it stays correct if detection ever reports a
	 * non-zero image-space origin.
	 */
	function anchorToUnderlay<T extends { originX: number; originY: number }>(mask: T): T {
		const off = underlayOffset();
		mask.originX += off.x;
		mask.originY += off.y;
		return mask;
	}

	/**
	 * Load a plan, detect its boundary and its walls.
	 *
	 * Detection itself is `detectFloorplanMasks`, which picks the vector reader or the
	 * pixel one on the file's *content*. The only thing decided here is how the result
	 * maps onto this floor — origin, calibration prompt, undo-free replace.
	 *
	 * `isSvg` is passed through for the fallback: a vector plan whose classifier finds
	 * no walls still falls back to pixels. See `detectFloorplanMasks`.
	 */
	async function runBoundaryDetection(url: string, isSvg = false) {
		detecting = true;
		calibrationDone = false;
		detectedWorldArea = null;
		areaInput = '';
		floorplanState.calibration = null;
		floorplanState.floorplanBoundary = null;
		floorplanState.sourceIsVector = isSvg;

		try {
			const detection = await detectFloorplanMasks(url, FLOORPLAN_TARGET_WIDTH);

			// Boundary detection for area calculation
			const result = detectBoundary(detection.image);
			if (result && result.polygon.length >= 3) {
				const cleanScaleFactor = FLOORPLAN_TARGET_WIDTH / detection.image.naturalWidth;
				const off = underlayOffset();
				const worldPolygon = result.polygon.map((p) => ({
					x: p.x * cleanScaleFactor + off.x,
					y: p.y * cleanScaleFactor + off.y
				}));
				floorplanState.floorplanBoundary = worldPolygon;

				// Use the actual pixel area from boundary detection, scaled to world coords.
				// Morphological close ensures door gaps don't leak flood fill but area
				// isn't inflated by the dilation step.
				detectedWorldArea = result.areaPx * cleanScaleFactor * cleanScaleFactor;
			}

			if (detection.wallMask) {
				wallState.wallMask = anchorToUnderlay(detection.wallMask);
				// A vector read knows which openings are doors and which are glass and
				// writes them into the material map; a pixel read cannot, and leaves
				// whatever was painted there rather than inventing an assignment.
				if (detection.materialMask) wallState.materialMask = anchorToUnderlay(detection.materialMask);
				// The same trace the import and Re-detect use: a mask alone leaves the floor
				// with no segments, and segments are what the drawing shows.
				const floor = currentFloor();
				if (floor) {
					floor.walls = [];
					floor.columns = [];
					// Exact geometry from the drawing first; the mask is traced only when the
					// elements were all curves, because that is the case a trace is for.
					const written = setFloorWallsFromSegments(floor.id, detection.segments ?? []);
					if (written === 0) await traceFloorWalls(floor.id);
				}
				scheduleSave();
			}
			wallState.vectorReview =
				detection.via === 'vector' && detection.summary && detection.elements && detection.source
					? {
							summary: detection.summary,
							elements: detection.elements,
							overrides: new Map(),
							source: detection.source,
							targetWidth: FLOORPLAN_TARGET_WIDTH
						}
					: null;
			wallState.rasterReason = detection.rasterReason;
		} catch (e) {
			console.warn('Detection failed:', e);
		}
		detecting = false;
	}

	/**
	 * Re-run detection against the current floorplan image.
	 *
	 * Deliberately NOT runBoundaryDetection: that also clears the calibration and
	 * replays the area prompt, which is wrong when the user just wants the walls
	 * redrawn on a plan they have already calibrated.
	 *
	 * This used to be the one path that could not tell an SVG from a raster — the
	 * underlay is a session blob URL by now — and it read those plans through the pixel
	 * detector, which measurably erases their walls. `detectFloorplanMasks` decides on
	 * the file's content instead, so Re-detect and the import path now agree.
	 */
	async function redetectWalls(forceRaster = false) {
		const url = floorplanState.floorplanUrl;
		if (!url || detecting) return;
		detecting = true;
		try {
			const detection = await detectFloorplanMasks(url, FLOORPLAN_TARGET_WIDTH, {
				forceRaster,
				// Which reader to use is a property of the *file*, not of the blob URL it is
				// displayed from. Re-detecting a vector plan used to fall through to the
				// pixel detector whenever the underlay had become a raster, which is the
				// difference between importing an SVG and pressing this button on it.
				assumeVector: !forceRaster && floorplanState.sourceIsVector
			});
			if (detection.wallMask) {
				wallState.wallMask = anchorToUnderlay(detection.wallMask);
				wallState.materialMask = detection.materialMask
					? anchorToUnderlay(detection.materialMask)
					: null;
				wallState.vectorReview =
					detection.via === 'vector' && detection.summary && detection.elements && detection.source
						? {
								summary: detection.summary,
								elements: detection.elements,
								overrides: new Map(),
								source: detection.source,
								targetWidth: FLOORPLAN_TARGET_WIDTH
							}
						: null;
				wallState.rasterReason = detection.rasterReason;
				/*
				 * Trace the detected mask into segments.
				 *
				 * Detection produces a mask, and walls are segments now: without this the drawing
				 * showed the raster band (or nothing), and the user was left with a picture they
				 * could not edit. The mask is then re-derived from the segments by the canvas's
				 * sync effect, which is what every consumer reads.
				 */
				const floor = currentFloor();
				if (floor) {
					// The trace reads the floor's current mask, so the old segments have to go first
					// (a floor with segments derives its mask from them, not from the detection).
					floor.walls = [];
					floor.columns = [];
					// Re-detect on a drawing with real geometry: read it, do not trace it.
					const written = setFloorWallsFromSegments(floor.id, detection.segments ?? []);
					if (written === 0) await traceWallsFromMaskOnFloor();
					debug(`[detect] ${floor.walls?.length ?? 0} segments`);
				}
				scheduleSave();
			}
		} catch (e) {
			console.warn('Wall detection failed:', e);
		}
		detecting = false;
	}

	/**
	 * Redo the walls from pixels, on a plan the vector reader handled.
	 *
	 * The escape hatch for a misclassification, and the only way to get the old
	 * behaviour back on a vector plan without re-importing it: a plan whose doors were
	 * read wrongly is often better served by the dumb threshold, which at least draws
	 * every drawn line.
	 */
	function redetectFromPixels() {
		wallState.vectorReview = null;
		void redetectWalls(true);
	}

	/**
	 * Entry point for the Detect / Re-detect Walls button.
	 *
	 * Detection replaces the entire wall mask and nulls the material mask, so on a
	 * plan that already has walls it silently discards everything hand-drawn or
	 * paint-edited. Ask first when there is something to lose. The very first
	 * detection (no wall mask yet) runs straight through, since prompting there
	 * would just add friction to the normal import path.
	 */
	function requestWallDetection() {
		if (!wallState.wallMask) {
			void redetectWalls();
			return;
		}
		const clearsMaterials = wallState.materialMask !== null;
		showConfirm(
			clearsMaterials
				? 'This replaces the current wall mask and clears every wall material assignment. Walls you drew or edited will be lost.'
				: 'This replaces the current wall mask. Walls you drew or edited will be lost.',
			() => void redetectWalls(),
			'Re-detect walls',
			'Re-detect'
		);
	}

	/**
	 * Apply a scale to the whole project, keeping the AP radii real.
	 *
	 * Shared by the two ways of calibrating — the stated area and the measured line — so a
	 * recalibration rescales the interference radii the same way whichever route produced
	 * the number. One scale for the whole project: every floor is drawn at the same scale
	 * in a real building, and a per-floor calibration would make two storeys disagree
	 * about how big a metre is.
	 */
	function applyScale(worldUnitsPerMeter: number): void {
		const oldCalibration = floorplanState.calibration;
		setProjectCalibration({ worldUnitsPerMeter });
		floorplanState.calibration = { worldUnitsPerMeter };

		if (oldCalibration === null) {
			// First calibration: set uncalibrated APs (radius=150) to real 15m
			const defaultRadiusWorld = Math.round(15 * worldUnitsPerMeter);
			for (const ap of apState.aps) {
				if (ap.interferenceRadius === 150) {
					ap.interferenceRadius = defaultRadiusWorld;
				}
			}
		} else {
			// Recalibration: scale all AP radii proportionally to preserve real-world meters
			const ratio = worldUnitsPerMeter / oldCalibration.worldUnitsPerMeter;
			for (const ap of apState.aps) {
				ap.interferenceRadius = Math.round(ap.interferenceRadius * ratio);
			}
		}

		calibrationDone = true;
		scheduleSave();
	}

	/**
	 * Calibrate from the line the user measured on the plan.
	 *
	 * Both ends are world coordinates, which are mask pixels, so the length of the segment
	 * is already a pixel count; dividing by the stated metres gives the scale directly.
	 * The area route has to trust the detected outline, and this one does not — which is
	 * the reason it exists.
	 */
	function applyMeasuredCalibration() {
		const [a, b] = appState.calibrationPoints;
		if (!a || !b) return;
		const typed = parseFloat(measureInput);
		if (!Number.isFinite(typed) || typed <= 0) return;
		const metres = unitToMetres(typed, lengthDisplayUnit);
		const wupm = wupmFromSegment({ a, b }, metres);
		if (!wupm) {
			measureError = t('That line has no length — click two different points.');
			return;
		}
		pushState();
		measureError = null;
		applyScale(wupm);
		measureInput = '';
		setCalibrateMode(false);
	}

	function cancelMeasuredCalibration() {
		measureError = null;
		setCalibrateMode(false);
	}

	/**
	 * Close the loop being drawn and make it this floor's planning area.
	 *
	 * Three corners is the minimum a polygon can have; the button is disabled below that, and
	 * this refuses again so a keyboard Enter cannot commit a line.
	 */
	function commitPlanningArea() {
		const draft = appState.planningDraft;
		if (draft.length < 3) return;
		const floor = currentFloor();
		if (!floor) return;
		pushState();
		floor.planningArea = draft.map((point) => ({ x: point.x, y: point.y }));
		setPlanningDrawMode(false);
		forgetInterior(floor.id);
		scheduleSave();
	}

	/** The area of the loop being drawn, in square metres, from the current calibration. */
	const draftAreaSqm = $derived.by(() => draftAreaOf(appState.planningDraft));

	/** The same figure for the committed area, so the header can state it. */
	const committedAreaSqm = $derived.by(() => draftAreaOf(currentFloor()?.planningArea ?? []));

	function draftAreaOf(points: Array<{ x: number; y: number }>): number {
		if (points.length < 3) return 0;
		let twiceArea = 0;
		for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
			twiceArea += points[j]!.x * points[i]!.y - points[i]!.x * points[j]!.y;
		}
		const wupm = getEffectiveWupm();
		if (!wupm) return 0;
		return Math.abs(twiceArea) / 2 / (wupm * wupm);
	}

	/**
	 * Whether the two once-per-floor cards are folded away.
	 *
	 * Scale and Planning area are set once and then read, so they take the most room while
	 * being the least used: folding them to a title row leaves the cards that are actually
	 * worked in — walls, raised surfaces, notes — above the fold.
	 */
	let scaleCollapsed = $state(false);
	let areaCollapsed = $state(false);
	/** The cards that are worked in fold too: the step in use is not always the tallest. */
	let floorplanCollapsed = $state(false);
	let wallsCollapsed = $state(false);
	/** The floor-properties card (multi-storey only): read once per floor, then left alone. */
	let propsCollapsed = $state(false);

	function clearVectorWalls(): void {
		const floor = currentFloor();
		if (!floor) return;
		pushState();
		floor.walls = [];
		appState.wallVectorSelected = null;
		scheduleSave();
	}

	/**
	 * Trace the painted mask into segments.
	 *
	 * The vector model is only usable if nobody has to redraw a building by hand, so this
	 * reads the mask detection already produced and takes its centre lines. The traced set
	 * covers the same walls the mask does — which is the point: switching models then does not
	 * change the plan's coverage, and the hand-drawn segments become corrections on top.
	 *
	 * The mask is not written here. The canvas re-derives it from the segments whenever they
	 * change, so committing a whole traced plan is one edit, not two.
	 */
	async function traceWallsFromMaskOnFloor(): Promise<void> {
		const floor = currentFloor();
		if (!floor) return;
		pushState();
		const count = await traceFloorWalls(floor.id);
		appState.wallVectorSelected = null;
		appState.wallColumnSelected = null;
		scheduleSave();
		if (count > 0) {
			notifyWalls(
				t('{count} walls were traced from the plan into segments, so they can be corrected one at a time.', {
					count
				})
			);
		}
	}

	/**
	 * Start drawing walls.
	 *
	 * A floor whose walls exist only as a detected raster is traced first. Otherwise the
	 * first segment drawn would *replace* the plan instead of correcting it — the mask is
	 * derived from the segments, so it would come back holding one wall — and the user
	 * would watch the detection vanish under their own click.
	 */
	async function startDrawingWalls(): Promise<void> {
		const floor = currentFloor();
		if (floor && (floor.walls ?? []).length === 0 && wallState.wallMask) {
			await traceWallsFromMaskOnFloor();
		}
		appState.wallVectorMode = true;
	}

	/** Back to the inferred interior. */	function clearPlanningArea() {
		const floor = currentFloor();
		if (!floor) return;
		pushState();
		floor.planningArea = null;
		forgetInterior(floor.id);
		scheduleSave();
	}

	function applyCalibration() {
		// The field is in whatever unit the toolbar selects; the model is metric.
		const realAreaSqm = areaInputSqm();
		if (!realAreaSqm) return;

		// Use detected area if available, otherwise compute from wall mask bounding box
		let worldArea = detectedWorldArea;
		if (!worldArea && wallState.wallMask) {
			const { width, height } = wallState.wallMask;
			// Use the mask dimensions as the world area (pixels squared)
			worldArea = width * height;
		}
		if (!worldArea) return;

		applyScale(Math.sqrt(worldArea / realAreaSqm));
	}

	function skipCalibration() {
		floorplanState.floorplanBoundary = null;
		detectedWorldArea = null;
		calibrationDone = true;
	}

	function handleAreaKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			applyCalibration();
		}
	}

	async function loadSample(url: string, knownAreaSqm?: number) {
		pushState();
		floorplanState.importNotice = null;
		try {
			const response = await fetch(url);
			const blob = await response.blob();
			const blobUrl = URL.createObjectURL(blob);
			floorplanState.floorplanUrl = blobUrl;
			await runBoundaryDetection(blobUrl, url.endsWith('.svg'));

			// Auto-calibrate if we know the area. The sample's area is stated in
			// square metres; the field shows it in the unit the toolbar selects.
			if (knownAreaSqm && detectedWorldArea && detectedWorldArea > 0) {
				setAreaSqm(knownAreaSqm);
				applyCalibration();
			}
		} catch {
			// Failed to load sample
		}
	}

	function handleFile(file: File) {
		const validTypes = ['image/png', 'image/jpeg', 'image/svg+xml'];
		if (!validTypes.includes(file.type)) {
			// Mirrors `importFloorplanFile`, which the canvas drop target uses. A PDF is
			// the format a real floorplan most often arrives in, and doing nothing at all
			// is indistinguishable from the app being broken.
			floorplanState.importNotice =
				file.type === 'application/pdf'
					? 'PDF plans are not supported yet — export the page as a PNG and drop that.'
					: 'That file type is not supported — use a PNG, JPEG or SVG.';
			return;
		}
		floorplanState.importNotice = null;
		pushState();
		const blobUrl = URL.createObjectURL(file);
		floorplanState.floorplanUrl = blobUrl;
		runBoundaryDetection(blobUrl, file.type === 'image/svg+xml');
	}

	function handleInputChange(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (file) handleFile(file);
		input.value = '';
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		const file = e.dataTransfer?.files[0];
		if (file) handleFile(file);
	}

	function handleDragOver(e: DragEvent) {
		e.preventDefault();
		dragOver = true;
	}

	function handleDragLeave() {
		dragOver = false;
	}

	function removeFloorplan() {
		showConfirm('Remove floorplan and all APs on this floor?', doRemoveFloorplan);
	}

	function doRemoveFloorplan() {
		pushState();
		const floorId = floorState.currentFloorId;
		floorplanState.floorplanUrl = null;
		floorplanState.floorplanBoundary = null;
		floorplanState.calibration = null;
		wallState.wallMask = null;
		wallState.wallMaterial = 0;
		wallState.materialMask = null;
		wallState.roomTypeMask = null;
		currentFloor().roomDensityOverrides = {};
		currentFloor().roomCustomLabels = {};
		apState.aps = apState.aps.filter((ap) => ap.floorId !== floorId);
		// The stored underlay outlives the plan it belongs to: its key is not derived from
		// anything the floor still has once the image is gone.
		void forgetFloorplan(floorId);
		detectedWorldArea = null;
		calibrationDone = false;
		areaInput = '';
		scheduleSave();
	}

	function handleOpacityChange(e: Event) {
		const input = e.target as HTMLInputElement;
		floorplanState.floorplanScale = parseFloat(input.value);
	}
</script>

<div class="floorplan-controls">
	<FloorStrip />

	{#if floorplanState.importNotice}
		<!-- A dropped file this app cannot read. Said out loud, because a silent no-op on
		     a dropped PDF is indistinguishable from the app being broken. -->
		<div class="import-notice" role="status">{t(floorplanState.importNotice)}</div>
	{/if}

	{#if !hasFloorplan}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="drop-zone"
			class:drag-over={dragOver}
			ondrop={handleDrop}
			ondragover={handleDragOver}
			ondragleave={handleDragLeave}
		>
			<Button variant="secondary" onclick={() => fileInput?.click()}>
				<Icon name="upload" size={14} />
				{t('Import Floorplan')}
			</Button>
			<input
				bind:this={fileInput}
				type="file"
				accept=".png,.jpg,.jpeg,.svg"
				onchange={handleInputChange}
				hidden
			/>
		</div>
		<div class="samples">
			<span class="samples-label">{t('or try a sample:')}</span>
			<div class="sample-buttons">
				{#each sampleOptions as sample}
					<button class="sample-btn" onclick={() => loadSample(sample.file, sample.areaSqm)}>
						{sample.label}
					</button>
				{/each}
			</div>
		</div>
		<div class="draw-scratch">
			<Button variant="secondary" size="sm" onclick={() => {
				pushState();
				/*
				 * A blank frame to draw into. A floor with no plan still needs a coordinate
				 * system: every consumer — the samples, the heatmap's texels, the interior,
				 * the room labels — addresses a mask, so this creates the frame and the wall
				 * tool then fills it. It used to create the frame and hand over a brush.
				 */
				const w = 2000;
				const h = 1500;
				const emptyData = new Uint8Array(w * h);
				const dataUrl = encodeMask(emptyData, w, h);
				wallState.wallMask = { dataUrl, width: w, height: h, originX: 0, originY: 0 };
				appState.wallVectorMode = true;
				if (window.innerWidth < 768) appState.sidebarOpen = false;
				scheduleSave();
			}}>
				<Icon name="pencil" size={14} />
				{t('Draw from Scratch')}
			</Button>
		</div>
	{:else}
		<!--
			The plan, as a card like everything below it.

			It used to be a loose header with a trash icon and an opacity slider, which read
			as chrome rather than as a step: the sidebar's real controls are cards, and the
			first thing in the panel was the one exception.
		-->
		<div class="planning-area">
			<div class="planning-head">
				<button
					class="card-collapse"
					aria-expanded={!floorplanCollapsed}
					title={floorplanCollapsed ? t('Show the list') : t('Hide the list')}
					onclick={() => (floorplanCollapsed = !floorplanCollapsed)}
				>
					<Icon name="chevron-down" size={11} />
				</button>
				<span class="planning-title">
					<Icon name="file" size={13} />
					{t('Floorplan')}
				</span>
				<span class="planning-state">
					{floorplanState.floorplanUrl ? t('Loaded') : t('Walls drawn')}
				</span>
			</div>
			<!-- Underlay opacity for the single-floor view. The tiled overview has its
			     own slider in the LAYERS panel, and each shows in exactly one view, so
			     there is never a second slider for the same property on screen.
			     Showing it here while tiled would also be a lie: this row writes the
			     current floor's value, which the tiles only borrow. -->
			{#if appState.floorView === 'single'}
				<div class="opacity-row">
					<label class="opacity-label" for="floorplan-opacity">{t('Opacity')}</label>
					<input
						id="floorplan-opacity"
						type="range"
						min="0.1"
						max="1"
						step="0.1"
						value={floorplanState.floorplanScale}
						oninput={handleOpacityChange}
						class="opacity-slider"
					/>
					<span class="opacity-value">{Math.round(floorplanState.floorplanScale * 100)}%</span>
				</div>
			{/if}

			<!--
				What the vector reader made of this plan, with a way to disagree with it.
				The panel owns its own re-read; this passes it the one thing it cannot
				reach — the pixel fallback, which belongs to the panel that also owns
				`runBoundaryDetection`.
			-->
			<WallDetectionPanel {redetectFromPixels} />

			<div class="planning-actions">
				<Button variant="ghost" size="sm" onclick={removeFloorplan}>
					<Icon name="trash" size={14} />
					{t('Remove floorplan')}
				</Button>
			</div>
		</div>

		<!--
			Calibration: what a world unit is worth.

			Also a card now, and for the same reason as the plan above — it is a step in the
			work (import, calibrate, draw walls, place APs), not a footnote under the header.
			The area route and the measured route are the two answers to the same question,
			so they live together with the current scale as the card's state.

			Single-floor view only: the scale is a property of one plan, and in the tiled or
			stacked views there is no single plan to calibrate against — the card there was a
			button that could only be wrong.
		-->
		{#if appState.floorView === 'single'}
		<div class="planning-area">
			<div class="planning-head">
				<button
					class="card-collapse"
					aria-expanded={!scaleCollapsed}
					title={scaleCollapsed ? t('Show the list') : t('Hide the list')}
					onclick={() => (scaleCollapsed = !scaleCollapsed)}
				>
					<Icon name="chevron-down" size={11} />
				</button>
				<span class="planning-title">
					<Icon name="ruler" size={13} />
					{t('Scale')}
				</span>
				<span class="planning-state">{scaleDisplay ?? t('Not set')}</span>
			</div>

			{#if detecting}
				<span class="calibration-status">{t('Detecting boundary...')}</span>
			{:else if (detectedWorldArea || wallState.wallMask) && !calibrationDone}
				{#if appState.calibrateMode}
					<!--
						Measuring instead of stating an area.

						The area route divides the stated area into the outline the detector
						found, so it is only as good as that outline and says nothing about
						whether the drawing is square. This asks for something the user can
						read off the plan itself — click the two ends of a wall they know the
						length of — which also works when the outline is open or the plan is a
						detail of one room.
					-->
					<span class="calibration-label">{t('Click the two ends of a distance you know')}</span>
					<span class="measure-hint">
						{appState.calibrationPoints.length === 0
							? t('First point: click on the plan.')
							: appState.calibrationPoints.length === 1
								? t('Second point: click the other end.')
								: t('Now type the real length of that line.')}
					</span>
					{#if appState.calibrationPoints.length >= 2}
						<div class="calibration-input-row">
							<input
								type="number"
								class="area-input"
								placeholder={t('e.g. 12')}
								bind:value={measureInput}
								onkeydown={(e) => { if (e.key === 'Enter') applyMeasuredCalibration(); }}
								min="0.1"
								step="any"
							/>
							<span
								class="unit-toggle"
								title={t('Set by the ft/m switch in the toolbar.')}>{lengthDisplayUnit}</span
							>
							<Button variant="primary" size="sm" onclick={applyMeasuredCalibration}>
								{t('Apply')}
							</Button>
						</div>
						{#if measureError}
							<span class="measure-error">{measureError}</span>
						{/if}
					{/if}
					<div class="planning-actions">
						<button class="skip-link" onclick={cancelMeasuredCalibration}>{t('Cancel')}</button>
					</div>
				{:else}
					<span class="calibration-label">{t('What is the total area of the floorplan?')}</span>
					<div class="calibration-input-row">
						<input
							type="number"
							class="area-input"
							placeholder={t('e.g. 200')}
							bind:value={areaInput}
							onkeydown={handleAreaKeydown}
							min="1"
							step="any"
						/>
						<!--
							The unit is a readout, not a control: it follows the
							toolbar's ft/m button and converts what is already typed.
							A button here would be a second, independent answer to
							"which units is this project in" — and the one place it
							would disagree with the toolbar is the field that sets the
							scale of everything else.
						-->
						<span
							class="unit-toggle"
							title={t('Set by the ft/m switch in the toolbar, which converts what is already typed.')}
							>{areaUnit}</span
						>
						<Button variant="primary" size="sm" onclick={applyCalibration}>
							{t('Apply')}
						</Button>
					</div>
					<div class="planning-actions">
						<button class="skip-link" onclick={skipCalibration}>{t('Skip')}</button>
						<button class="skip-link" onclick={() => { measureError = null; setCalibrateMode(true); }}>
							{t('Measure a distance')}
						</button>
					</div>
				{/if}
			{:else}
				<!--
					Nothing to calibrate right now — either the scale is set, or it was
					skipped. Both still need the two routes back: skipping used to fall
					through every branch, so the card went empty and the only way to measure a
					distance was to reload the project.
				-->
				{#if scaleDisplay}
					<span class="calibration-label">{t('Scale:')} {scaleDisplay}</span>
				{/if}
				<div class="planning-actions">
					<button class="skip-link" onclick={() => { calibrationDone = false; }}>
						{t('Recalibrate')}
					</button>
					<button class="skip-link" onclick={() => { measureError = null; setCalibrateMode(true); }}>
						{t('Measure a distance')}
					</button>
				</div>
			{/if}
		</div>
		{/if}
	{/if}

	<!--
		Floor properties, after the steps they belong to: the ceiling and the slab are what
		the propagation model charges, and the alignment rows are meaningless until there is a
		plan to line them up. So they follow the import and the calibration, in the order the
		work is done — import, calibrate, align, then place access points and optimise.

		A card like every other step, and collapsible like them: on a multi-storey plan these
		rows are read once per floor and then left alone, and they used to sit loose between two
		cards with no heading at all.
	-->
	{#if floorState.floors.length > 1}
		<div class="planning-area">
			<div class="planning-head">
				<button
					class="card-collapse"
					aria-expanded={!propsCollapsed}
					title={propsCollapsed ? t('Show the list') : t('Hide the list')}
					onclick={() => (propsCollapsed = !propsCollapsed)}
				>
					<Icon name="chevron-down" size={11} />
				</button>
				<span class="planning-title">
					<Icon name="stack" size={13} />
					{t('Floor properties')}
				</span>
			</div>
			<div class="floor-props">
			<div class="prop-row">
				<span class="prop-label">{t('Ceiling height')}</span>
				<input
					type="number"
					class="prop-input"
					value={displayLength(currentFloor().ceilingHeight, lengthDisplayUnit).value}
					min={ceilingHints.min} max={ceilingHints.max} step={ceilingHints.step}
					onchange={(e) => { pushState(); currentFloor().ceilingHeight = unitToMetres(Number((e.target as HTMLInputElement).value), lengthDisplayUnit); scheduleSave(); }}
				/>
				<span class="prop-unit">{lengthDisplayUnit}</span>
			</div>
			<div class="prop-row">
				<span class="prop-label">{t('Floor thickness')}</span>
				<input
					type="number"
					class="prop-input"
					value={displayLength(currentFloor().floorThickness, lengthDisplayUnit).value}
					min={thicknessHints.min} max={thicknessHints.max} step={thicknessHints.step}
					onchange={(e) => { pushState(); currentFloor().floorThickness = unitToMetres(Number((e.target as HTMLInputElement).value), lengthDisplayUnit); scheduleSave(); }}
				/>
				<span class="prop-unit">{lengthDisplayUnit}</span>
			</div>
			<div class="prop-row">
				<span class="prop-label">{t('Floor material')}</span>
				<Select
					value={String(currentFloor().floorMaterial)}
					options={FLOOR_MATERIALS.map(m => ({ value: String(m.id), label: m.name }))}
					onchange={(v) => { pushState(); currentFloor().floorMaterial = Number(v) as any; scheduleSave(); }}
				/>
			</div>
			<!--
				Alignment. Two floors only line up if their plans happen to share a
				margin; these shift the whole floor, so a floor that was drawn or
				auto-detected off-position can be brought onto the one below. Hidden on
				the bottom floor and in the tiled overview, where there is no floor
				below to align to and no canvas drag to give the mode — see `canAlign`.
			-->
			{#if canAlign}
				<div class="prop-row">
					<span class="prop-label">{t('Align X')}</span>
					<input
						type="number"
						class="prop-input"
						value={alignDisplay(currentFloor().floorplanOffsetX)}
						step="0.1"
						title={t('Shift this floor sideways to line it up with the floor below. Moves the plan, the walls and the APs together.')}
						onchange={(e) => applyAlign('x', Number((e.target as HTMLInputElement).value))}
					/>
					<span class="prop-unit">{lengthDisplayUnit}</span>
				</div>
				<div class="prop-row">
					<span class="prop-label">{t('Align Y')}</span>
					<input
						type="number"
						class="prop-input"
						value={alignDisplay(currentFloor().floorplanOffsetY)}
						step="0.1"
						title={t('Shift this floor to line it up with the floor below. Moves the plan, the walls and the APs together.')}
						onchange={(e) => applyAlign('y', Number((e.target as HTMLInputElement).value))}
					/>
					<span class="prop-unit">{lengthDisplayUnit}</span>
				</div>
				<div class="prop-row align-row">
					<span
						class="prop-label"
						title={t('Drag on the canvas to move this floor onto the one below. Moves the plan, the walls and the APs together.')}
					>{t('Align')}</span>
					<Button
						size="sm"
						variant={appState.floorAlignMode ? 'primary' : 'secondary'}
						onclick={() => setFloorAlignMode(!appState.floorAlignMode)}
					>
						{appState.floorAlignMode ? t('Drag on canvas…') : t('Drag to align')}
					</Button>
				</div>
			{/if}
			</div>
		</div>
	{/if}

	{#if wallState.wallMask || floorplanState.floorplanUrl}
		<!-- Hidden while the tiled overview is up. Both actions edit or replace the
		     current floor's wall mask, and that view draws every floor as a
		     read-only card, so pressing them there would change something the user
		     cannot see or aim at. -->
		{#if appState.floorView === 'single'}
			<!--
				The planning area: where this floor actually is.

				Everything about "inside" is otherwise inferred from the walls, which is right
				for a clean plan and wrong for one whose outline has a wide opening — a room
				then reads as outside the building, and an access point standing in the middle
				of it gets reported as outside. Drawing the area says it outright, and once it
				exists it is what the warnings, the placement guard and the optimiser use.
			-->
			<div class="planning-area">
				<div class="planning-head">
					<button
						class="card-collapse"
						aria-expanded={!areaCollapsed}
						title={areaCollapsed ? t('Show the list') : t('Hide the list')}
						onclick={() => (areaCollapsed = !areaCollapsed)}
					>
						<Icon name="chevron-down" size={11} />
					</button>
					<span class="planning-title">
						<Icon name="crosshair" size={13} />
						{t('Planning area')}
					</span>
					{#if appState.planningDrawMode}
						<span class="planning-state drawing">{t('Drawing')}</span>
					{:else if currentFloor()?.planningArea}
						<span class="planning-state drawn">
							{t('{count} corners · {area} m²', { count: currentFloor()!.planningArea!.length, area: committedAreaSqm.toFixed(1) })}
						</span>
					{:else}
						<span class="planning-state">{t('Auto-detected')}</span>
					{/if}
				</div>

				{#if !areaCollapsed}
				{#if appState.planningDrawMode}
					<p class="planning-hint">
						{#if appState.planningDraft.length < 3}
							{t('Click the corners of this floor (at least three), then press Enter.')}
						{:else}
							{t('{count} corners · {area} m² — press Enter to close, Backspace to undo the last corner.', { count: appState.planningDraft.length, area: draftAreaSqm.toFixed(1) })}
						{/if}
					</p>
					<div class="planning-actions">
						<Button
							variant="primary"
							size="sm"
							disabled={appState.planningDraft.length < 3}
							onclick={commitPlanningArea}
						>
							{t('Close area')}
						</Button>
						<button
							class="skip-link"
							disabled={appState.planningDraft.length === 0}
							onclick={() => (appState.planningDraft = appState.planningDraft.slice(0, -1))}
						>
							{t('Undo corner')}
						</button>
						<button class="skip-link" onclick={() => setPlanningDrawMode(false)}>{t('Cancel')}</button>
					</div>
				{:else}
					<div class="planning-actions">
						<Button variant="secondary" size="sm" onclick={() => setPlanningDrawMode(true)}>
							<Icon name="pencil" size={14} />
							{currentFloor()?.planningArea ? t('Redraw planning area') : t('Draw planning area')}
						</Button>
						{#if currentFloor()?.planningArea}
							<button class="skip-link" onclick={clearPlanningArea}>{t('Use the detected area')}</button>
						{/if}
					</div>
				{/if}
				{/if}
			</div>

			<!--
				Walls as line segments — the only way walls are drawn now.

				The raster brush painted a band of pixels and everything downstream had to
				infer what that band meant, which is where a hollow wall, a cavity read as a
				room and an outline with an opening read as "outside" all came from. A segment
				says what it is, and the mask the propagation reads is derived from it: draw,
				move or delete a wall and the mask follows without a second action.
			-->
			<div class="planning-area">
				<div class="planning-head">
					<button
						class="card-collapse"
						aria-expanded={!wallsCollapsed}
						title={wallsCollapsed ? t('Show the list') : t('Hide the list')}
						onclick={() => (wallsCollapsed = !wallsCollapsed)}
					>
						<Icon name="chevron-down" size={11} />
					</button>
					<span class="planning-title">
						<Icon name="arc" size={13} />
						{t('Walls')}
					</span>
					<span class="planning-state">{t('{count} drawn', { count: (currentFloor()?.walls ?? []).length })}</span>
				</div>
				{#if appState.wallVectorMode}
					<p class="planning-hint">
						{appState.wallVectorDraft
							? t('Click the far end. Hold Shift to keep it straight, Escape to cancel.')
							: t('Click the start of a wall. Ends snap to walls already drawn.')}
					</p>
					<div class="planning-actions">
						<button class="skip-link" onclick={() => { appState.wallVectorMode = false; appState.wallVectorDraft = null; }}>
							{t('Done')}
						</button>
					</div>
				{:else}
					<div class="planning-actions">
						<Button variant="secondary" size="sm" onclick={() => void startDrawingWalls()}>
							<Icon name="pencil" size={14} />
							{t('Draw wall')}
						</Button>
						<!--
							Re-detecting belongs to the walls, not to the plan: it replaces the
							wall mask (and the material painted on it), which is what this card
							is about. It used to sit above every card as a loose row.
						-->
						<Button variant="ghost" size="sm" onclick={requestWallDetection} disabled={detecting}>
							<Icon name="sparkles" size={14} />
							{detecting
								? t('Detecting…')
								: wallState.wallMask
									? t('Re-detect walls')
									: t('Detect walls')}
						</Button>
						{#if (currentFloor()?.walls ?? []).length > 0}
							<button class="skip-link" onclick={clearVectorWalls}>{t('Clear walls')}</button>
						{/if}
					</div>
					{#if (currentFloor()?.walls ?? []).length === 0 && !wallState.wallMask}
						<span class="wall-hint">{t('Detect walls from the floorplan, or import one first')}</span>
					{/if}
				{/if}
			</div>

			<FloorplanSurfaces />

						<FloorplanNotes />
		{/if}
	{/if}

</div>

<ConfirmDialog
	bind:open={confirmOpen}
	title={confirmTitle}
	message={confirmMessage}
	confirmLabel={confirmLabel}
	onconfirm={() => { confirmAction?.(); }}
/>

<style>
	.floorplan-controls {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.floor-props {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding-bottom: var(--space-2);
		border-bottom: 1px solid var(--border-subtle);
	}

	.prop-row {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.prop-label {
		font-size: var(--text-xs);
		color: var(--text-tertiary);
		min-width: 80px;
		flex-shrink: 0;
	}

	.prop-input {
		width: 60px;
		height: 24px;
		background: var(--bg-surface);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		color: var(--text-primary);
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		text-align: center;
		padding: 0 4px;
	}

	.prop-input:focus {
		outline: none;
		border-color: var(--accent-primary);
	}

	.prop-unit {
		font-size: var(--text-xs);
		color: var(--text-tertiary);
	}

	/* The shared Button is sized for toolbars and is inline-flex; in a property
	   row it should fill the same slot as the controls above it, with the toggle
	   state carried by the variant rather than by bespoke CSS. */
	.align-row :global(.btn) {
		flex: 1 1 auto;
		min-width: 0;
		height: 24px;
		justify-content: center;
	}

	.drop-zone {
		display: flex;
		width: 100%;
	}

	.drop-zone :global(.btn) {
		width: 100%;
	}

	.import-notice {
		margin-top: var(--space-2);
		padding: var(--space-2);
		font-size: var(--text-xs);
		color: var(--text-secondary);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
	}

	.drop-zone.drag-over {
		outline: 2px dashed var(--accent-primary);
		outline-offset: 2px;
		border-radius: var(--radius-md);
	}

	.samples {
		margin-top: var(--space-2);
		text-align: center;
	}

	.samples-label {
		font-size: var(--text-xs);
		color: var(--text-tertiary);
	}

	.sample-buttons {
		display: flex;
		gap: var(--space-1);
		margin-top: var(--space-1);
		justify-content: center;
	}

	.sample-btn {
		font-size: var(--text-xs);
		color: var(--accent-primary);
		background: none;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm);
		padding: 2px 8px;
		cursor: pointer;
		transition: all var(--transition-fast);
	}

	.sample-btn:hover {
		background: var(--bg-hover);
		border-color: var(--accent-primary-dim);
	}

	.sample-btn:focus-visible {
		outline: 2px solid var(--accent-primary);
		outline-offset: 1px;
	}

	.opacity-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.opacity-label {
		font-size: var(--text-sm);
		color: var(--text-tertiary);
		flex-shrink: 0;
	}

	.opacity-slider {
		flex: 1;
		accent-color: var(--accent-primary);
		height: 4px;
	}

	.opacity-value {
		font-size: var(--text-sm);
		color: var(--text-tertiary);
		min-width: 36px;
		text-align: right;
	}

	.calibration-status {
		font-size: var(--text-xs);
		color: var(--text-tertiary);
		font-style: italic;
	}

	.calibration-label {
		font-size: var(--text-xs);
		color: var(--text-secondary);
		line-height: 1.4;
	}

	.calibration-input-row {
		display: flex;
		gap: var(--space-1);
		align-items: center;
	}

	.area-input {
		flex: 1;
		height: 28px;
		background: var(--bg-surface);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		color: var(--text-primary);
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		padding: 0 var(--space-2);
		outline: none;
		min-width: 0;
	}

	.area-input:focus {
		border-color: var(--accent-primary);
	}

	/* The unit beside the area field. A readout now, not a button: it shows what
	   the toolbar's ft/m switch selected, so it must not look pressable. */
	.unit-toggle {
		display: inline-flex;
		align-items: center;
		height: 28px;
		padding: 0 var(--space-2);
		background: var(--bg-surface);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		color: var(--text-tertiary);
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		white-space: nowrap;
	}

	/*
	 * The planning area block.
	 *
	 * It had no styling at all at first — a title-less run of hint text and buttons, which is
	 * why it read as raw markup next to the panels around it. A bordered card, a title row
	 * that names the thing and states its status, then the guidance and the actions: the same
	 * shape as the vector-read panel above it, so the sidebar has one way of saying "here is
	 * a thing, here is what state it is in, here is what you can do".
	 */
	.planning-area {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-3);
		background: var(--bg-elevated);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm);
	}

	.planning-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-2);
	}

	/*
	 * Heads are a title and a fold control, nothing else. The right-aligned state text ("12
	 * drawn", "1 px = 0.10m") made every head a two-column table and pushed the title off the
	 * left edge; the one state worth showing while it matters — that the area is being drawn —
	 * keeps its badge.
	 */
	.planning-head .planning-state {
		display: none;
	}

	.planning-head .planning-state.drawing {
		display: inline;
	}

	.planning-title {
		flex: 1;
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		font-size: var(--text-xs);
		font-weight: 500;
		color: var(--text-secondary);
	}

	/* State: quiet when automatic, the accent when the user's own area is in force. */
	.planning-state {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		color: var(--text-tertiary);
		white-space: nowrap;
	}

	.planning-state.drawn {
		color: var(--accent-primary);
	}

	.planning-state.drawing {
		color: var(--color-warning, #ffb800);
	}

	.planning-hint {
		margin: 0;
		font-size: var(--text-xs);
		line-height: 1.5;
		color: var(--text-secondary);
	}

	.planning-actions {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
	}

	/* Raised surfaces: a segmented kind switch and one row per parameter. */
	.measure-hint {
		font-size: var(--text-xs);
		color: var(--text-secondary);
	}

	.measure-error {
		font-size: var(--text-xs);
		color: var(--color-warning, #ffb800);
	}

	/*
	 * The quiet actions: secondary, but still buttons.
	 *
	 * They used to be underlined text, which read as a link and — with four of them in a row
	 * — as a paragraph of links rather than as the controls of the card they sit in. A
	 * bordered chip is the smallest thing that still says "press me", and it lines up with
	 * the `Button`s beside it because it shares their height and radius.
	 */
	.skip-link {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-1);
		padding: 3px var(--space-2);
		min-height: 24px;
		font-size: var(--text-xs);
		color: var(--text-secondary);
		background: transparent;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		cursor: pointer;
		text-decoration: none;
	}

	.skip-link:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.skip-link:disabled {
		opacity: 0.45;
		cursor: default;
	}

	.skip-link:focus-visible {
		outline: 2px solid var(--accent-primary);
		outline-offset: 1px;
	}

	.wall-hint {
		font-size: var(--text-xs);
		color: var(--text-disabled);
	}

	/*
	 * A card's fold control: a chevron on the left of its title, pointing down when the card
	 * is open and right when it is folded. Scale and Planning area are set once and then read,
	 * so they can be put away — the cards that get worked in stay.
	 */
	.card-collapse {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		padding: 0;
		color: var(--text-tertiary);
		background: transparent;
		border: none;
		border-radius: var(--radius-sm);
		cursor: pointer;
		transition: transform var(--transition-fast);
	}

	.card-collapse[aria-expanded='false'] {
		transform: rotate(-90deg);
	}

	.card-collapse:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	/*
	 * Every card folds from its own head: the chevron's `aria-expanded` is the state, and a
	 * folded card keeps its title and state line while its body — every child that is not the
	 * head — is hidden. One rule rather than a wrapper per card, so a card added later folds
	 * by putting the button in its head.
	 */
	.planning-area:has(.card-collapse[aria-expanded='false']) > :not(.planning-head) {
		display: none;
	}

	.draw-scratch {
		margin-top: var(--space-2);
		padding-top: var(--space-2);
		border-top: 1px solid var(--border-subtle);
	}

	.draw-scratch :global(.btn) {
		width: 100%;
	}

</style>
