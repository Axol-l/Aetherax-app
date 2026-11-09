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
		translateFloor
	} from '$state/floor-state.svelte.js';
	import { setFloorScale } from '$state/floor-scale.js';
	import { FLOOR_MATERIALS } from '$canvas/floor-materials.js';
	import Select from '$components/shared/Select.svelte';
	import ConfirmDialog from '$components/dialogs/ConfirmDialog.svelte';
	import CopyFloorLayoutDialog from '$components/dialogs/CopyFloorLayoutDialog.svelte';
	import FloorStrip from './FloorStrip.svelte';
	import FloorplanNotes from './FloorplanNotes.svelte';
	import FloorplanSurfaces from './FloorplanSurfaces.svelte';
	import Collapse from './Collapse.svelte';
	import { setCalibrateMode } from '$state/app.svelte';
	import { setPlanningDrawMode } from '$state/app.svelte';
	import { sidebarCards } from '$state/sidebar-cards.svelte';
	import { wupmFromSegment } from '$state/calibrate.js';
	import { forgetInterior } from '$state/ap-interior.js';
	import { getFloorMask } from '$state/floor-mask.js';
	import { compareWallModels, type WallModelComparison } from '$lib/rf/wall-model-compare.js';
	import { rasterRayLossDb } from '$lib/rf/raster-ray.js';
	import type { WallMaterialId } from '$lib/domain/materials.js';
	import { traceFloorWalls, setFloorWallsFromSegments } from '$state/wall-trace.js';
	import { rasteriseWalls as rasteriseWallsToMasks } from '$state/wall-raster.js';
	import { encodeMaterialMask } from '$canvas/region-labels.js';

	let confirmOpen = $state(false);
	let confirmMessage = $state('');
	let confirmAction = $state<(() => void) | null>(null);
	let confirmTitle = $state('Delete');
	let confirmLabel = $state('Delete');
	let copyLayoutOpen = $state(false);
	let copySourceId = $state('');

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
	import { encodeMask } from '$canvas/mask-codec.js';
	import { detectFloorplanMasks } from '$canvas/detect-floorplan.js';
	import { scheduleSave, forgetFloorplan } from '$state/persistence.svelte.js';
	import { pushState } from '$state/history.svelte.js';
	import Button from '$components/shared/Button.svelte';
	import Icon from '$components/shared/Icon.svelte';
	import Tooltip from '$components/shared/Tooltip.svelte';
	import WallDetectionPanel from '$components/sidebar/WallDetectionPanel.svelte';
	import { t } from '$state/i18n.svelte';
	import {
		areaUnit as areaUnitFor,
		displayArea,
		displayLength,
		lengthInputHints,
		lengthUnit,
		unitToMetres
	} from '$lib/units.js';

	const FLOORPLAN_TARGET_WIDTH = 800;


	let fileInput = $state<HTMLInputElement>();
	let dragOver = $state(false);
	let detecting = $state(false);
	let detectedWorldArea = $state<number | null>(null);

	/** The unit system the toolbar's ft/m button selects. */
	const unitSystem = $derived(floorplanState.unitSystem);
	/** The area unit, for the sample plans' own areas in their labels. */
	const areaUnit = $derived(areaUnitFor(unitSystem));

	/** The stated real length of the line the user measured, in the toolbar's unit. */
	let measureInput = $state('');
	let measureError = $state<string | null>(null);

	let hasFloorplan = $derived(floorplanState.floorplanUrl !== null || wallState.wallMask !== null);

	/**
	 * Whether there is anything for this floor to be aligned to.
	 */
	let canAlign = $derived(
		floorState.floors.length > 1 &&
			floorState.floors.findIndex((f) => f.id === floorState.currentFloorId) > 0 &&
			appState.floorView === 'single'
	);

	$effect(() => {
		if (!canAlign && appState.floorAlignMode) setFloorAlignMode(false);
	});

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
	 */
	const lengthDisplayUnit = $derived(lengthUnit(unitSystem));

	// The model's real bounds, in the unit on screen: a ceiling is 2–10 m whatever
	// the field says. See `lengthInputHints`.
	const ceilingHints = $derived(lengthInputHints(2, 10, 0.5, lengthDisplayUnit));
	const thicknessHints = $derived(lengthInputHints(0.05, 1, 0.05, lengthDisplayUnit));

	/**
	 * Where the current floor's underlay sits in world space.
	 */
	function underlayOffset(): { x: number; y: number } {
		const floor = currentFloor();
		return { x: floor?.floorplanOffsetX ?? 0, y: floor?.floorplanOffsetY ?? 0 };
	}

	/**
	 * Shift a freshly detected mask so it lands under the underlay.
	 */
	function anchorToUnderlay<T extends { originX: number; originY: number }>(mask: T): T {
		const off = underlayOffset();
		mask.originX += off.x;
		mask.originY += off.y;
		return mask;
	}

	/**
	 * Load a plan, detect its boundary and its walls.
	 */
	async function runBoundaryDetection(url: string, isSvg = false) {
		detecting = true;
		detectedWorldArea = null;
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
	 */
	function redetectFromPixels() {
		wallState.vectorReview = null;
		void redetectWalls(true);
	}

	/**
	 * Entry point for the Detect / Re-detect Walls button.
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
	 * Apply a scale to the current floor, keeping its AP radii real.
	 */
	function applyScale(worldUnitsPerMeter: number): void {
		setFloorScale(floorState.currentFloorId, worldUnitsPerMeter);
	}

	/**
	 * Calibrate from the line the user measured on the plan.
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

	/*
	 * 两张每层只设一次的卡片（比例、规划范围），以及会在其中来回操作的卡片（平面图、墙体），
	 * 折叠状态都放在 `sidebarCards` 里：切换 Floorplan / APs 面板会卸载本组件，局部状态会丢。
	 */

	/**
	 * Trace the painted mask into segments.
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
	 */
	async function startDrawingWalls(): Promise<void> {
		const floor = currentFloor();
		if (floor && (floor.walls ?? []).length === 0 && wallState.wallMask) {
			await traceWallsFromMaskOnFloor();
		}
		appState.wallVectorMode = true;
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

			// Auto-calibrate the bundled samples: their labels state a real area in square
			// metres, so the scale follows without asking the user to measure a line.
			if (knownAreaSqm && detectedWorldArea && detectedWorldArea > 0) {
				applyScale(Math.sqrt(detectedWorldArea / knownAreaSqm));
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
		showConfirm(
			'Remove this floor’s plan and all of its APs? This also clears its walls, planning area, raised surfaces, notes and scale.',
			doRemoveFloorplan
		);
	}

	function doRemoveFloorplan() {
		pushState();
		const floorId = floorState.currentFloorId;
		const floor = currentFloor();
		if (!floor) return;
		floorplanState.floorplanUrl = null;
		floorplanState.floorplanBoundary = null;
		floorplanState.calibration = null;
		floor.floorplanOffsetX = 0;
		floor.floorplanOffsetY = 0;
		wallState.wallMask = null;
		wallState.wallMaterial = 0;
		wallState.materialMask = null;
		wallState.roomTypeMask = null;
		// The plan is the frame every one of these was drawn in. Keeping them would leave
		// an invisible planning area clipping the next plan and stale surfaces/notes on a
		// floor whose controls are hidden until a new plan arrives.
		floor.planningArea = null;
		floor.surfaces = [];
		floor.notes = [];
		floor.walls = [];
		floor.columns = [];
		floor.roomDensityOverrides = {};
		floor.roomCustomLabels = {};
		apState.aps = apState.aps.filter((ap) => ap.floorId !== floorId);
		// The stored underlay outlives the plan it belongs to: its key is not derived from
		// anything the floor still has once the image is gone.
		void forgetFloorplan(floorId);
		detectedWorldArea = null;
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
		<div class="planning-area">
			<div class="planning-head">
				<button
					class="card-collapse"
					aria-expanded={!sidebarCards.floorplan}
					title={sidebarCards.floorplan ? t('Show the list') : t('Hide the list')}
					onclick={() => (sidebarCards.floorplan = !sidebarCards.floorplan)}
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
			<Collapse open={!sidebarCards.floorplan}>
		
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

			<WallDetectionPanel {redetectFromPixels} />

			<div class="planning-actions">
				<Button variant="secondary" size="sm" onclick={() => { copySourceId = currentFloor().id; copyLayoutOpen = true; }}>
					<Icon name="stack" size={14} />
					{t('Copy layout…')}
				</Button>
				<Tooltip text={t('Remove floorplan')} position="top">
					<button class="remove-plan" onclick={removeFloorplan} aria-label={t('Remove floorplan')}>
						<Icon name="trash" size={14} />
					</button>
				</Tooltip>
			</div>
			</Collapse>
		</div>

		{#if appState.floorView === 'single'}
		<div class="planning-area">
			<div class="planning-head">
				<button
					class="card-collapse"
					aria-expanded={!sidebarCards.scale}
					title={sidebarCards.scale ? t('Show the list') : t('Hide the list')}
					onclick={() => (sidebarCards.scale = !sidebarCards.scale)}
				>
					<Icon name="chevron-down" size={11} />
				</button>
				<span class="planning-title">
					<Icon name="ruler" size={13} />
					{t('Scale')}
				</span>
				<span class="planning-state">{scaleDisplay ?? t('Not set')}</span>
			</div>

			<Collapse open={!sidebarCards.scale}>
			{#if detecting}
				<span class="calibration-status">{t('Detecting boundary...')}</span>
			{:else if appState.calibrateMode}
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
			{:else if !floorplanState.calibration}
				<span class="calibration-label">{t('Set the scale by measuring one distance on the plan.')}</span>
				<div class="planning-actions">
					<Button
						variant="primary"
						size="sm"
						onclick={() => {
							measureError = null;
							setCalibrateMode(true);
						}}
					>
						{t('Measure a distance')}
					</Button>
				</div>
			{:else}
				<span class="calibration-label">{t('Scale:')} {scaleDisplay}</span>
				<div class="planning-actions">
					<Button
						variant="secondary"
						size="sm"
						onclick={() => {
							measureError = null;
							setCalibrateMode(true);
						}}
					>
						{t('Recalibrate')}
					</Button>
				</div>
			{/if}
			</Collapse>
		</div>
		{/if}
	{/if}

	{#if wallState.wallMask || floorplanState.floorplanUrl}
		{#if appState.floorView === 'single'}
			<div class="planning-area">
				<div class="planning-head">
					<button
						class="card-collapse"
						aria-expanded={!sidebarCards.planningArea}
						title={sidebarCards.planningArea ? t('Show the list') : t('Hide the list')}
						onclick={() => (sidebarCards.planningArea = !sidebarCards.planningArea)}
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

				<Collapse open={!sidebarCards.planningArea}>
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
							{t('Confirm area')}
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
					</div>
				{/if}
				</Collapse>
			</div>
		{/if}
	{/if}

	{#if floorState.floors.length > 1}
		<div class="planning-area">
			<div class="planning-head">
				<button
					class="card-collapse"
					aria-expanded={!sidebarCards.properties}
					title={sidebarCards.properties ? t('Show the list') : t('Hide the list')}
					onclick={() => (sidebarCards.properties = !sidebarCards.properties)}
				>
					<Icon name="chevron-down" size={11} />
				</button>
				<span class="planning-title">
					<Icon name="stack" size={13} />
					{t('Floor properties')}
				</span>
			</div>
			<Collapse open={!sidebarCards.properties}>
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
					options={FLOOR_MATERIALS.map(m => ({ value: String(m.id), label: t(m.name) }))}
					onchange={(v) => { pushState(); currentFloor().floorMaterial = Number(v) as any; scheduleSave(); }}
				/>
			</div>

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
			</Collapse>
		</div>
	{/if}

	{#if wallState.wallMask || floorplanState.floorplanUrl}
		<!-- Hidden while the tiled overview is up. -->
		{#if appState.floorView === 'single'}
			<div class="planning-area">
				<div class="planning-head">
					<button
						class="card-collapse"
						aria-expanded={!sidebarCards.walls}
						title={sidebarCards.walls ? t('Show the list') : t('Hide the list')}
						onclick={() => (sidebarCards.walls = !sidebarCards.walls)}
					>
						<Icon name="chevron-down" size={11} />
					</button>
					<span class="planning-title">
						<Icon name="arc" size={13} />
						{t('Walls')}
					</span>
					<span class="planning-state">{t('{count} drawn', { count: (currentFloor()?.walls ?? []).length })}</span>
				</div>
				<Collapse open={!sidebarCards.walls}>
				{#if appState.wallVectorMode}
					<p class="planning-hint">
						{appState.wallVectorDraft
							? t('Click the far end. Hold Shift to keep it straight, Escape to cancel.')
							: t('Click the start of a wall. Ends snap to walls already drawn.')}
					</p>
					<div class="planning-actions">
						<Button
							variant="primary"
							size="sm"
							onclick={() => {
								appState.wallVectorMode = false;
								appState.wallVectorDraft = null;
							}}
						>
							<Icon name="check" size={14} />
							{t('Done')}
						</Button>
					</div>
				{:else}
					<div class="planning-actions">
						<Button variant="secondary" size="sm" onclick={() => void startDrawingWalls()}>
							<Icon name="pencil" size={14} />
							{t('Draw wall')}
						</Button>
						<Button variant="secondary" size="sm" onclick={requestWallDetection} disabled={detecting}>
							<Icon name="sparkles" size={14} />
							{detecting
								? t('Detecting…')
								: wallState.wallMask
									? t('Re-detect walls')
									: t('Detect walls')}
						</Button>
					</div>
					{#if (currentFloor()?.walls ?? []).length === 0 && !wallState.wallMask}
						<span class="wall-hint">{t('Detect walls from the floorplan, or import one first')}</span>
					{/if}
				{/if}
				</Collapse>
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

<CopyFloorLayoutDialog bind:open={copyLayoutOpen} sourceId={copySourceId} />

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

	/* Copy layout takes the row; removing the plan is one icon at the end of it. */
	.planning-actions {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--space-2);
	}

	.remove-plan {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		padding: 0;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
		background: var(--bg-surface);
		color: var(--text-tertiary);
		cursor: pointer;
		transition: all var(--transition-fast);
	}

	.remove-plan:hover {
		color: var(--color-error, #ef4444);
		border-color: var(--color-error-dim, rgba(239, 68, 68, 0.45));
		background: var(--color-error-dim, rgba(239, 68, 68, 0.12));
	}

	.remove-plan:focus-visible {
		outline: 2px solid var(--accent-primary);
		outline-offset: 1px;
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

	.draw-scratch {
		margin-top: var(--space-2);
		padding-top: var(--space-2);
		border-top: 1px solid var(--border-subtle);
	}

	.draw-scratch :global(.btn) {
		width: 100%;
	}

</style>
