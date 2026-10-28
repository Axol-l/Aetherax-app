<script lang="ts">
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
	import { setCalibrateMode } from '$state/app.svelte';
	import { setPlanningDrawMode } from '$state/app.svelte';
	import { wupmFromSegment } from '$state/calibrate.js';
	import { forgetInterior } from '$state/ap-interior.js';
	import { getFloorMask } from '$state/floor-mask.js';
	import { compareWallModels, type WallModelComparison } from '$lib/rf/wall-model-compare.js';
	import { rasterRayLossDb } from '$lib/rf/raster-ray.js';
	import type { WallMaterialId } from '$canvas/materials.js';
	import { traceWallsFromMask } from '$state/wall-trace.js';

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

	let editingFloorId = $state<string | null>(null);
	let editingFloorName = $state('');

	function handleAddFloor() {
		pushState();
		const floor = addFloor();
		switchFloor(floor.id);
		scheduleSave();
	}

	function startRenameFloor(id: string, name: string) {
		editingFloorId = id;
		editingFloorName = name;
	}

	function commitRenameFloor() {
		if (editingFloorId) {
			const floor = floorState.floors.find((f) => f.id === editingFloorId);
			if (floor) {
				floor.name = editingFloorName.trim() || floor.name;
				scheduleSave();
			}
		}
		editingFloorId = null;
	}

	function moveFloor(id: string, direction: -1 | 1) {
		const idx = floorState.floors.findIndex((f) => f.id === id);
		const newIdx = idx + direction;
		if (newIdx < 0 || newIdx >= floorState.floors.length) return;
		// Swap levels
		const a = floorState.floors[idx]!;
		const b = floorState.floors[newIdx]!;
		const tmpLevel = a.level;
		a.level = b.level;
		b.level = tmpLevel;
		// Swap positions in array
		floorState.floors[idx] = b;
		floorState.floors[newIdx] = a;
		floorState.floors = [...floorState.floors]; // trigger reactivity
		scheduleSave();
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

	function handleDeleteFloor(id: string) {
		if (floorState.floors.length <= 1) return;
		showConfirm('Delete this floor and all its access points?', () => {
			pushState();
			apState.aps = apState.aps.filter((ap) => ap.floorId !== id);
			removeFloor(id);
			scheduleSave();
		});
	}
	import { appState, setFloorAlignMode } from '$state/app.svelte.js';
	import { detectBoundary, polygonArea } from '$canvas/boundary-detect.js';
	import { encodeMask } from '$canvas/wall-detect.js';
	import { detectFloorplanMasks } from '$canvas/detect-floorplan.js';
	import { scheduleSave } from '$state/persistence.svelte.js';
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
	 * no walls still falls back to pixels, and OCR is skipped there for the reason
	 * measured on the samples — see `detectFloorplanMasks`.
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
			wallState.textMaskingFailed = detection.textMaskingFailed;
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
	 * underlay is a session blob URL by now — so it ran OCR on vector plans, which
	 * measurably erases their walls. `detectFloorplanMasks` decides on the file's
	 * content instead, so Re-detect and the import path now agree.
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
				wallState.textMaskingFailed = detection.textMaskingFailed;
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

	/** Enter wall editing, remembering the last tool used. */
	function startWallEdit() {
		pushState();
		appState.wallEditMode = appState.wallEditLastMode;
		if (window.innerWidth < 768) appState.sidebarOpen = false;
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

	/** The note being edited, on the floor on screen. */
	const selectedNote = $derived.by(() => {
		const id = appState.noteSelectedId;
		if (!id) return null;
		return (currentFloor()?.notes ?? []).find((note) => note.id === id) ?? null;
	});

	function updateSelectedNote(text: string): void {
		const floor = currentFloor();
		const id = appState.noteSelectedId;
		if (!floor || !id) return;
		const note = (floor.notes ?? []).find((n) => n.id === id);
		if (!note) return;
		note.text = text;
		scheduleSave();
	}

	function deleteSelectedNote(): void {
		const floor = currentFloor();
		const id = appState.noteSelectedId;
		if (!floor || !id) return;
		pushState();
		floor.notes = (floor.notes ?? []).filter((note) => note.id !== id);
		appState.noteSelectedId = null;
		scheduleSave();
	}

	function clearVectorWalls(): void {
		const floor = currentFloor();
		if (!floor) return;
		pushState();
		floor.walls = [];
		appState.wallVectorSelected = null;
		scheduleSave();
	}

	/**
	 * Rasterise the drawn walls into a material mask, so the two kernels can be compared on
	 * the *same* geometry.
	 *
	 * The comparison against the floor's own mask measures coverage as much as it measures
	 * agreement: twenty-two hand-drawn segments cannot stand in for every wall in a detected
	 * plan, so the raster side legitimately charges more. Painting the segments into a mask
	 * removes that variable — both sides then see exactly the same walls, and any difference
	 * left is the two algorithms disagreeing rather than the drawing being incomplete.
	 *
	 * The band is six units wide, the same stroke the vector layer draws and the smallest
	 * brush the raster tool offers.
	 */
	function rasteriseWalls(
		walls: readonly { ax: number; ay: number; bx: number; by: number; material: number }[]
	): {
		wall: Uint8Array;
		material: Uint8Array;
		width: number;
		height: number;
		originX: number;
		originY: number;
	} | null {
		if (walls.length === 0) return null;
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const wall of walls) {
			minX = Math.min(minX, wall.ax, wall.bx);
			minY = Math.min(minY, wall.ay, wall.by);
			maxX = Math.max(maxX, wall.ax, wall.bx);
			maxY = Math.max(maxY, wall.ay, wall.by);
		}
		const pad = 6;
		const originX = Math.floor(minX) - pad;
		const originY = Math.floor(minY) - pad;
		const width = Math.max(1, Math.ceil(maxX - originX) + pad);
		const height = Math.max(1, Math.ceil(maxY - originY) + pad);
		// A cap on the working size: a stray far-out segment would otherwise allocate a mask
		// of a million pixels to compare a handful of rays.
		if (width * height > 4_000_000) return null;
		const material = new Uint8Array(width * height);
		// Occupancy as well as id: id 0 is Drywall, which is also what an unpainted pixel
		// reads as, so the id alone cannot say whether there is a wall there.
		const occupied = new Uint8Array(width * height);
		const radius = 3;
		for (const wall of walls) {
			const length = Math.hypot(wall.bx - wall.ax, wall.by - wall.ay);
			const steps = Math.max(1, Math.ceil(length));
			for (let i = 0; i <= steps; i++) {
				const t = i / steps;
				const cx = Math.round(wall.ax + (wall.bx - wall.ax) * t - originX);
				const cy = Math.round(wall.ay + (wall.by - wall.ay) * t - originY);
				for (let dy = -radius; dy <= radius; dy++) {
					for (let dx = -radius; dx <= radius; dx++) {
						const x = cx + dx;
						const y = cy + dy;
						if (x < 0 || y < 0 || x >= width || y >= height) continue;
						material[y * width + x] = wall.material;
						occupied[y * width + x] = 1;
					}
				}
			}
		}
		return { wall: occupied, material, width, height, originX, originY };
	}

	/**
	 * Measure the two wall models against each other on this floor.
	 *
	 * Two answers, because they answer different questions:
	 *
	 * - **on the floor's own mask**: how much geometry the drawn walls represent, which is
	 *   what the coverage figure will change by when the vector model takes over;
	 * - **on the drawn geometry rasterised**: whether the two kernels agree when they see the
	 *   same walls. This one should be near zero, and if it is not, the kernel is wrong —
	 *   which is exactly what the first number cannot tell you.
	 */
	let wallModelComparison = $state<WallModelComparison | null>(null);
	let wallModelSameGeometry = $state<WallModelComparison | null>(null);

	async function compareWallModelsOnFloor(): Promise<void> {
		const floor = currentFloor();
		const ap = apState.aps.find((candidate) => candidate.floorId === floor?.id);
		const decoded = floor ? await getFloorMask(floor.id) : null;
		if (!floor || !ap || !decoded) return;
		const walls = (floor.walls ?? []).map((wall) => ({
			ax: wall.ax,
			ay: wall.ay,
			bx: wall.bx,
			by: wall.by,
			material: wall.material as WallMaterialId
		}));
		const points: Array<{ x: number; y: number }> = [];
		const stepX = Math.max(1, Math.floor(decoded.width / 24));
		const stepY = Math.max(1, Math.floor(decoded.height / 24));
		for (let py = 0; py < decoded.height; py += stepY) {
			for (let px = 0; px < decoded.width; px += stepX) {
				points.push({ x: decoded.originX + px, y: decoded.originY + py });
			}
		}
		const band = apState.band;
		const from = { x: ap.x, y: ap.y };

		wallModelComparison = compareWallModels({
			walls,
			band,
			from,
			points,
			rasterLoss: (a, b) =>
				rasterRayLossDb(
					a,
					b,
					decoded.wallData,
					decoded.materialMap,
					decoded.width,
					decoded.height,
					decoded.originX,
					decoded.originY,
					band,
					floor.wallMaterial as WallMaterialId
				)
		});

		// The same walls, seen by both kernels.
		const synthetic = rasteriseWalls(walls);
		wallModelSameGeometry = synthetic
			? compareWallModels({
					walls,
					band,
					from,
					points,
					rasterLoss: (a, b) =>
						rasterRayLossDb(
							a,
							b,
							synthetic.wall,
							synthetic.material,
							synthetic.width,
							synthetic.height,
							synthetic.originX,
							synthetic.originY,
							band,
							floor.wallMaterial as WallMaterialId
						)
				})
			: null;
	}

	/**
	 * Trace the painted mask into segments.
	 *
	 * The vector model is only usable if nobody has to redraw a building by hand, so this
	 * reads the mask detection already produced and takes its centre lines. The traced set
	 * covers the same walls the mask does — which is the point: switching models then does not
	 * change the plan's coverage, and the hand-drawn segments become corrections on top.
	 */
	async function traceWallsFromMaskOnFloor(): Promise<void> {
		const floor = currentFloor();
		const decoded = floor ? await getFloorMask(floor.id) : null;
		if (!floor || !decoded) return;
		const traced = traceWallsFromMask(
			decoded.wallData,
			decoded.materialMap,
			decoded.width,
			decoded.height,
			floor.wallMaterial as WallMaterialId
		);
		pushState();
		floor.walls = traced.map((wall) => ({
			id: crypto.randomUUID(),
			ax: wall.ax + decoded.originX,
			ay: wall.ay + decoded.originY,
			bx: wall.bx + decoded.originX,
			by: wall.by + decoded.originY,
			material: wall.material
		}));
		appState.wallVectorSelected = null;
		scheduleSave();
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
		floorplanState.floorplanUrl = null;
		floorplanState.floorplanBoundary = null;
		floorplanState.calibration = null;
		wallState.wallMask = null;
		wallState.wallMaterial = 0;
		wallState.materialMask = null;
		wallState.roomTypeMask = null;
		currentFloor().roomDensityOverrides = {};
		currentFloor().roomCustomLabels = {};
		apState.aps = apState.aps.filter((ap) => ap.floorId !== floorState.currentFloorId);
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
	<div class="floor-manager">
		<div class="floor-strip">
			{#each floorState.floors as floor}
				{#if editingFloorId === floor.id}
					<input
						class="floor-name-input"
						type="text"
						bind:value={editingFloorName}
						onblur={commitRenameFloor}
						onkeydown={(e) => { if (e.key === 'Enter') commitRenameFloor(); if (e.key === 'Escape') { editingFloorId = null; } }}
						autofocus
					/>
				{:else}
					<button
						class="floor-pill"
						class:active={floor.id === floorState.currentFloorId}
						onclick={() => switchFloor(floor.id)}
						ondblclick={() => startRenameFloor(floor.id, floor.name)}
						title={t('Click to switch, double-click to rename')}
					>
						{floor.name}
						{#if floor.id === floorState.currentFloorId && floorState.floors.length > 1}
							{#if floorState.floors.indexOf(floor) > 0}
								<span class="floor-action" role="button" tabindex="0" onclick={(e) => { e.stopPropagation(); moveFloor(floor.id, -1); }} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); moveFloor(floor.id, -1); } }}>&#9664;</span>
							{/if}
							{#if floorState.floors.indexOf(floor) < floorState.floors.length - 1}
								<span class="floor-action" role="button" tabindex="0" onclick={(e) => { e.stopPropagation(); moveFloor(floor.id, 1); }} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); moveFloor(floor.id, 1); } }}>&#9654;</span>
							{/if}
							<span class="floor-action delete" role="button" tabindex="0" onclick={(e) => { e.stopPropagation(); handleDeleteFloor(floor.id); }} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); handleDeleteFloor(floor.id); } }}>&times;</span>
						{/if}
					</button>
				{/if}
			{/each}
			<button class="floor-pill add" onclick={handleAddFloor} aria-label={t('Add floor')}>+</button>
		</div>
	</div>

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
				const w = 2000;
				const h = 1500;
				const emptyData = new Uint8Array(w * h);
				const dataUrl = encodeMask(emptyData, w, h);
				wallState.wallMask = { dataUrl, width: w, height: h, originX: 0, originY: 0 };
				appState.wallEditMode = 'draw';
				if (window.innerWidth < 768) appState.sidebarOpen = false;
				scheduleSave();
			}}>
				<Icon name="pencil" size={14} />
				{t('Draw from Scratch')}
			</Button>
		</div>
	{:else}
		<div class="loaded-controls">
			<div class="loaded-header">
				<span class="loaded-label">
					<Icon name="file" size={14} />
					{floorplanState.floorplanUrl ? t('Floorplan loaded') : t('Walls drawn')}
				</span>
				<Button variant="ghost" size="sm" onclick={removeFloorplan}>
					<Icon name="trash" size={14} />
				</Button>
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

			{#if detecting}
				<div class="calibration-section">
					<span class="calibration-status">{t('Detecting boundary...')}</span>
				</div>
			{:else if (detectedWorldArea || wallState.wallMask) && !calibrationDone}
				<div class="calibration-section">
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
								<button class="apply-btn" onclick={applyMeasuredCalibration}>{t('Apply')}</button>
							</div>
							{#if measureError}
								<span class="measure-error">{measureError}</span>
							{/if}
						{/if}
						<button class="skip-link" onclick={cancelMeasuredCalibration}>{t('Cancel')}</button>
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
							<button class="apply-btn" onclick={applyCalibration}>{t('Apply')}</button>
						</div>
						<div class="calibration-alternatives">
							<button class="skip-link" onclick={skipCalibration}>{t('Skip')}</button>
							<button class="skip-link" onclick={() => { measureError = null; setCalibrateMode(true); }}>
								{t('or measure a distance on the plan')}
							</button>
						</div>
					{/if}
				</div>
			{:else if scaleDisplay}
				<div class="calibration-section">
					<span class="calibration-confirmed">{t('Scale:')} {scaleDisplay}</span>
					<div class="calibration-alternatives">
						<button class="skip-link" onclick={() => { calibrationDone = false; }}>{t('Recalibrate')}</button>
						<button class="skip-link" onclick={() => { measureError = null; setCalibrateMode(true); }}>
							{t('or measure a distance instead')}
						</button>
					</div>
				</div>
			{/if}

		</div>
	{/if}

	<!--
		Floor properties, after the steps they belong to: the ceiling and the slab are what
		the propagation model charges, and the alignment rows are meaningless until there is a
		plan to line them up. So they follow the import and the calibration, in the order the
		work is done — import, calibrate, align, then place access points and optimise.
	-->
	{#if floorState.floors.length > 1}
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
	{/if}

	{#if wallState.wallMask || floorplanState.floorplanUrl}
		<!-- Hidden while the tiled overview is up. Both actions edit or replace the
		     current floor's wall mask, and that view draws every floor as a
		     read-only card, so pressing them there would change something the user
		     cannot see or aim at. -->
		{#if appState.floorView === 'single'}
			<div class="wall-actions">
				{#if wallState.wallMask}
					<Button variant="secondary" size="sm" onclick={startWallEdit}>
						<Icon name="eraser" size={14} />
						{t('Edit Walls')}
					</Button>
				{/if}
				<Button variant="secondary" size="sm" onclick={requestWallDetection} disabled={detecting}>
					<Icon name="sparkles" size={14} />
					{detecting ? t('Detecting…') : wallState.wallMask ? t('Re-detect Walls') : t('Detect Walls')}
				</Button>
				{#if !wallState.wallMask}
					<span class="wall-hint">{t('Detect walls from the floorplan, or import one first')}</span>
				{/if}
			</div>

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
			</div>

			<!--
				Walls as line segments.

				The raster brush paints a band of pixels and everything downstream has to infer
				what that band means; a segment says it. This is the drawing half only — the
				propagation still reads the mask, so nothing about coverage or the optimiser
				changes while the two exist side by side.
			-->
			<div class="planning-area">
				<div class="planning-head">
					<span class="planning-title">
						<Icon name="arc" size={13} />
						{t('Vector walls')}
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
						<Button variant="secondary" size="sm" onclick={() => (appState.wallVectorMode = true)}>
							<Icon name="pencil" size={14} />
							{t('Draw wall')}
						</Button>
						{#if (currentFloor()?.walls ?? []).length > 0}
							<button class="skip-link" onclick={clearVectorWalls}>{t('Clear walls')}</button>
						{/if}
						{#if wallState.wallMask}
							<button class="skip-link" onclick={() => void traceWallsFromMaskOnFloor()}>
								{t('Trace from mask')}
							</button>
						{/if}
						<button class="skip-link" onclick={() => void compareWallModelsOnFloor()}>
							{t('Compare wall models')}
						</button>
					</div>
					{#if wallModelComparison}
						<!--
							The measured difference, not a claim. Mean and worst-case loss difference in
							dB, and how many rays one model walls off while the other does not — the last
							number is the one that matters, because a whole wall's figure is a difference
							of geometry rather than of arithmetic.
						-->
						<p class="planning-hint">
							{t('Δ {mean} dB mean · {max} dB worst · {count} rays where one model has a wall and the other does not', {
								mean: wallModelComparison.meanAbsDb.toFixed(2),
								max: wallModelComparison.maxAbsDb.toFixed(2),
								count: wallModelComparison.disagreements
							})}
						</p>
						<!--
							The inputs, not just the answer. Numbers that do not move after a redraw
							mean the comparison is measuring the same geometry twice or measuring
							nothing at all, and the deltas cannot say which. These can: they show what
							each side actually charged, and over how many walls and rays.
						-->
						<p class="planning-hint">
							{t('{walls} walls · {samples} rays · raster {raster} dB · vector {vector} dB', {
								walls: (currentFloor()?.walls ?? []).length,
								samples: wallModelComparison.samples,
								raster: wallModelComparison.rasterMeanDb.toFixed(2),
								vector: wallModelComparison.vectorMeanDb.toFixed(2)
							})}
						</p>
						{#if wallModelSameGeometry}
							<!--
								The same walls through both kernels: this is the number that says whether
								the new model is correct. The one above says how much of the floor the
								drawing represents, which is a different question and moves with the
								drawing rather than with the code.
							-->
							<p class="planning-hint">
								{t('Same walls, both kernels: Δ {mean} dB mean · {count} disagreements', {
									mean: wallModelSameGeometry.meanAbsDb.toFixed(2),
									count: wallModelSameGeometry.disagreements
								})}
							</p>
						{/if}
					{/if}
				{/if}
			</div>

			<!--
				Notes: pins with a sentence attached.

				Half of what decides where an access point goes never made it into the CAD file
				— the lift lobby's steel door, the rack that will be installed next month. A pin
				holds that next to the place it is about, and the layer switch can take them off
				the plan for a screenshot or a print.
			-->
			<div class="planning-area notes-block">
				<div class="planning-head">
					<span class="planning-title">
						<Icon name="tag" size={13} />
						{t('Notes')}
					</span>
					<span class="planning-state">{t('{count} on this floor', { count: (currentFloor()?.notes ?? []).length })}</span>
				</div>

				{#if appState.noteMode}
					<p class="planning-hint">{t('Click on the plan to place a note. Escape cancels.')}</p>
					<div class="planning-actions">
						<button class="skip-link" onclick={() => (appState.noteMode = false)}>{t('Cancel')}</button>
					</div>
				{:else if selectedNote}
					<textarea
						class="note-input"
						rows="3"
						placeholder={t('What should a reader know about this spot?')}
						value={selectedNote.text}
						oninput={(e) => updateSelectedNote((e.target as HTMLTextAreaElement).value)}
					></textarea>
					<div class="planning-actions">
						<Button variant="secondary" size="sm" onclick={deleteSelectedNote}>{t('Delete note')}</Button>
						<button class="skip-link" onclick={() => (appState.noteSelectedId = null)}>{t('Done')}</button>
					</div>
				{:else}
					<div class="planning-actions">
						<Button variant="secondary" size="sm" onclick={() => (appState.noteMode = true)}>
							<Icon name="tag" size={14} />
							{t('Add note')}
						</Button>
					</div>
				{/if}
			</div>
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

	.floor-strip {
		display: flex;
		gap: 4px;
		overflow-x: auto;
		overflow-y: hidden;
		padding-bottom: var(--space-2);
		border-bottom: 1px solid var(--border-subtle);
		flex-wrap: nowrap;
		min-width: 0;
	}

	.floor-pill {
		padding: 4px 10px;
		border: 1px solid var(--border-default);
		border-radius: 999px;
		background: var(--bg-surface);
		color: var(--text-secondary);
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		cursor: pointer;
		white-space: nowrap;
		flex: 0 0 auto;
		transition: all var(--transition-fast);
	}

	.floor-pill:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.floor-pill.active {
		border-color: var(--accent-primary);
		color: var(--accent-primary);
		background: var(--accent-primary-glow);
	}

	.floor-pill.add {
		border-style: dashed;
		color: var(--text-tertiary);
		min-width: 28px;
		text-align: center;
	}

	.floor-pill.add:hover {
		border-color: var(--accent-primary-dim);
		color: var(--accent-primary);
	}

	.floor-manager {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
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

	.floor-action {
		margin-left: 2px;
		font-size: 10px;
		line-height: 1;
		opacity: 0.4;
		cursor: pointer;
		padding: 2px;
	}

	.floor-action:hover {
		opacity: 1;
	}

	.floor-action.delete:hover {
		color: var(--danger, #ef4444);
	}

	.floor-name-input {
		padding: 3px 8px;
		border: 1px solid var(--accent-primary);
		border-radius: 999px;
		background: var(--bg-surface);
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		width: 80px;
		outline: none;
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

	.loaded-controls {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.loaded-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.loaded-label {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		font-size: var(--text-sm);
		color: var(--text-secondary);
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

	.calibration-section {		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		margin-top: var(--space-2);
		padding-top: var(--space-2);
		border-top: 1px solid var(--border-subtle);
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

	.apply-btn {
		height: 28px;
		padding: 0 var(--space-2);
		background: var(--accent-primary);
		border: none;
		border-radius: var(--radius-md);
		color: var(--text-on-accent, #fff);
		font-size: var(--text-xs);
		font-weight: 500;
		cursor: pointer;
		white-space: nowrap;
	}

	.apply-btn:hover {
		opacity: 0.9;
	}

	/* The two calibration routes side by side: state an area, or measure a line. */
	.calibration-alternatives {
		display: flex;
		gap: var(--space-3);
		flex-wrap: wrap;
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

	.planning-title {
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

	.measure-hint {
		font-size: var(--text-xs);
		color: var(--text-secondary);
	}

	.measure-error {
		font-size: var(--text-xs);
		color: var(--color-warning, #ffb800);
	}

	.apply-btn:focus-visible {
		outline: 2px solid var(--accent-primary);
		outline-offset: 1px;
	}

	.skip-link {
		background: none;
		border: none;
		color: var(--text-tertiary);
		font-size: var(--text-xs);
		cursor: pointer;
		padding: 0;
		text-decoration: underline;
		align-self: flex-start;
	}

	.skip-link:hover {
		color: var(--text-secondary);
	}

	.skip-link:focus-visible {
		outline: 2px solid var(--accent-primary);
		outline-offset: 1px;
	}

	.calibration-confirmed {
		font-size: var(--text-xs);
		color: var(--color-success, #4ade80);
		font-family: var(--font-mono);
	}

	.wall-actions {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		margin-top: var(--space-2);
		padding-top: var(--space-2);
		border-top: 1px solid var(--border-subtle);
	}

	.wall-actions :global(.btn) {
		width: 100%;
	}

	.wall-hint {
		font-size: var(--text-xs);
		color: var(--text-disabled);
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
