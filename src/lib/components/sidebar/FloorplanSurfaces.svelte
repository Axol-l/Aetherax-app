<script lang="ts">
	/**
	 * Raised surfaces: a mezzanine, a stair, a ramp.
	 *
	 * A plan is flat and the model used to be too. What this card states is a fact the
	 * drawing cannot: the floor inside this rectangle is *not* the slab, so a client there is
	 * a different distance from the ceiling — and from every AP. A stair and a ramp are the
	 * same rectangle with two heights instead of one, which is why the second field appears
	 * only when it means something.
	 *
	 * The same card edits the surface the canvas has selected. Selecting one used to leave
	 * only Delete: the fields still described the *next* surface, so the only way to change a
	 * material or a height was to remove the deck and draw it again. A selected surface is a
	 * selected object like a wall or an access point, and its parameters belong here, next to
	 * the ones it will be drawn with.
	 */
	import { appState, setSurfaceMode } from '$state/app.svelte.js';
	import { canvasEngineRef } from '$state/canvas.svelte.js';
	import { currentFloor } from '$state/floor-state.svelte.js';
	import { pushState } from '$state/history.svelte.js';
	import { scheduleSave } from '$state/persistence.svelte.js';
	import { updateCoverage } from '$state/optimizer.svelte.js';
	import { t } from '$state/i18n.svelte';
	import {
		DEFAULT_SURFACE_ATTENUATION_DB,
		DEFAULT_SURFACE_THICKNESS_M,
		stepCount,
		SURFACE_MATERIALS,
		surfaceMaterial,
		type SurfaceKind,
		type SurfaceMaterialId
	} from '$lib/rf/surface-height.js';
	import { chooseSurfaceKind, chooseSurfaceMaterial } from '$state/surface-defaults.js';
	import Select from '$components/shared/Select.svelte';
	import Button from '$components/shared/Button.svelte';
	import Icon from '$components/shared/Icon.svelte';
	import NumberInput from '$components/shared/NumberInput.svelte';
	import PanelCard from './PanelCard.svelte';

	let collapsed = $state(false);

	/** The three kinds of raised surface, in the order a plan usually needs them. */
	const surfaceKinds = $derived<Array<{ id: SurfaceKind; label: string }>>([
		{ id: 'platform', label: t('Platform') },
		{ id: 'stair', label: t('Stair') },
		{ id: 'ramp', label: t('Ramp') }
	]);

	/**
	 * The selected surface, when it belongs to the floor on screen.
	 *
	 * Null while the tool is armed: drawing is about the *next* surface, and the card is the
	 * only place its kind and heights can be set. After Done the just-drawn deck is still
	 * selected, so the same card turns into its editor without another click.
	 */
	const selected = $derived.by(() => {
		if (appState.surfaceMode) return null;
		const id = appState.surfaceSelected;
		if (!id) return null;
		return (currentFloor()?.surfaces ?? []).find((surface) => surface.id === id) ?? null;
	});

	/**
	 * Pick the kind a new surface will be.
	 *
	 * The rule lives in `state/surface-defaults.ts`, shared with the floating toolbar — a card
	 * and a bar that each implement "a platform copies its low height" are two rules that will
	 * disagree.
	 */

	/** The material list: the presets, plus the "no preset" row that keeps a typed loss. */
	const materialOptions = $derived([
		{ value: 'custom', label: t('Custom') },
		...SURFACE_MATERIALS.map((material) => ({ value: material.id, label: t(material.label) }))
	]);

	function handleMaterialChange(value: string): void {
		chooseSurfaceMaterial(value === 'custom' ? null : (value as SurfaceMaterialId));
	}

	/** The preset's own loss, or null while the deck is a custom figure. */
	const presetAttenuation = $derived(
		appState.surfaceMaterial ? (surfaceMaterial(appState.surfaceMaterial)?.attenuationDb ?? null) : null
	);

	/** The step count a stair drawn now would get, from its rise at the standard tread. */
	const previewStepCount = $derived(
		stepCount({
			ax: 0,
			ay: 0,
			bx: 0,
			by: 0,
			heightM: appState.surfaceHeightM,
			topHeightM:
				appState.surfaceKind === 'platform'
					? appState.surfaceHeightM
					: appState.surfaceTopHeightM
		})
	);

	/** The selected deck's own preset, if it was drawn from one. */
	const selectedPresetAttenuation = $derived(
		selected?.material ? (surfaceMaterial(selected.material)?.attenuationDb ?? null) : null
	);

	/** The loss the selected deck charges: its preset's figure, or the number it carries. */
	const selectedAttenuation = $derived(
		selected?.attenuationDb ?? selectedPresetAttenuation ?? DEFAULT_SURFACE_ATTENUATION_DB
	);

	/** A selected deck's stored thickness, with the model's default for older projects. */
	const selectedThickness = $derived(selected?.thicknessM ?? DEFAULT_SURFACE_THICKNESS_M);

	/** The selected stair's treads, derived from its rise exactly as the preview's are. */
	const selectedStepCount = $derived(selected ? stepCount(selected) : 1);

	/**
	 * A surface edit changed what the model measures and what the plan draws.
	 *
	 * One commit point for every field: the heights change the client's vertical gap, the
	 * material changes the deck's loss, and the plan's tint and label follow the height. The
	 * canvas holds the surface objects by reference, so it needs to be told to redraw; the
	 * project needs a save; and the coverage figure is stale until it is re-measured.
	 */
	function commitSurfaceEdit(): void {
		scheduleSave();
		void updateCoverage();
		canvasEngineRef.engine?.markDirty();
	}

	/** Re-arm the fields for creating the next surface, leaving the selected one alone. */
	function closeSelectedSurface(): void {
		appState.surfaceSelected = null;
		canvasEngineRef.engine?.markDirty();
	}

	function setSelectedKind(kind: SurfaceKind): void {
		const surface = selected;
		if (!surface || surface.kind === kind) return;
		pushState();
		surface.kind = kind;
		if (kind === 'platform') {
			// A platform is level: one height, not two that happen to be equal.
			surface.topHeightM = surface.heightM;
		} else if (surface.topHeightM <= surface.heightM) {
			// A stair with no rise is a platform with extra controls.
			surface.topHeightM = surface.heightM + 1;
		}
		commitSurfaceEdit();
	}

	function setSelectedMaterial(value: string): void {
		const surface = selected;
		if (!surface) return;
		pushState();
		const id = value === 'custom' ? null : (value as SurfaceMaterialId);
		surface.material = id ?? undefined;
		const preset = id ? surfaceMaterial(id) : null;
		if (preset) surface.attenuationDb = preset.attenuationDb;
		commitSurfaceEdit();
	}

	function setSelectedNumber(
		field: 'heightM' | 'topHeightM' | 'thicknessM' | 'attenuationDb',
		value: number
	): void {
		const surface = selected;
		if (!surface) return;
		pushState();
		surface[field] = Math.max(0, value);
		// Keep the platform's pair together when its one height moves.
		if (field === 'heightM' && surface.kind === 'platform') {
			surface.topHeightM = surface.heightM;
		}
		commitSurfaceEdit();
	}

	function toggleSelectedSolidBase(): void {
		const surface = selected;
		if (!surface) return;
		pushState();
		surface.solidBase = !surface.solidBase;
		commitSurfaceEdit();
	}

	function deleteSelectedSurface(): void {
		const floor = currentFloor();
		const id = appState.surfaceSelected;
		if (!floor || !id) return;
		pushState();
		floor.surfaces = (floor.surfaces ?? []).filter((surface) => surface.id !== id);
		appState.surfaceSelected = null;
		commitSurfaceEdit();
	}
</script>

<PanelCard title={t('Raised surfaces')} icon="stack" bind:collapsed>
	{#if selected}
		<!-- A selected deck: the same fields the next one is drawn with, bound to it. -->
		<p class="planning-hint">{t('Editing the selected raised area')}</p>
		<div class="surface-kinds" role="group" aria-label={t('Surface kind')}>
			{#each surfaceKinds as option (option.id)}
				<button
					class="surface-kind"
					class:active={selected.kind === option.id}
					onclick={() => setSelectedKind(option.id)}
				>
					{option.label}
				</button>
			{/each}
		</div>
		<div class="param-row">
			<span class="param-label">{t('Material')}</span>
			<Select
				value={selected.material ?? 'custom'}
				options={materialOptions}
				onchange={setSelectedMaterial}
				aria-label={t('Material')}
			/>
		</div>
		<div class="param-row">
			<span class="param-label">{t('Attenuation')}</span>
			{#if selectedPresetAttenuation !== null}
				<span class="param-value" title={t('Set by the material')}
					>{selectedPresetAttenuation} dB</span
				>
			{:else}
				<span class="param-control">
					<NumberInput
						value={selectedAttenuation}
						min={0}
						max={120}
						step={1}
						onchange={(value) => setSelectedNumber('attenuationDb', value)}
					/>
					<span class="param-unit">dB</span>
				</span>
			{/if}
		</div>
		{#if selected.kind === 'platform'}
			<div class="param-row">
				<span class="param-label">{t('Height')}</span>
				<span class="param-control">
					<NumberInput
						value={selected.heightM}
						min={0}
						max={12}
						step={0.1}
						onchange={(value) => setSelectedNumber('heightM', value)}
					/>
					<span class="param-unit">m</span>
				</span>
			</div>
		{:else}
			<div class="param-row">
				<span class="param-label">{t('Upper height')}</span>
				<span class="param-control">
					<NumberInput
						value={selected.topHeightM}
						min={0}
						max={12}
						step={0.1}
						onchange={(value) => setSelectedNumber('topHeightM', value)}
					/>
					<span class="param-unit">m</span>
				</span>
			</div>
			<div class="param-row">
				<span class="param-label">{t('Lower height')}</span>
				<span class="param-control">
					<NumberInput
						value={selected.heightM}
						min={0}
						max={12}
						step={0.1}
						onchange={(value) => setSelectedNumber('heightM', value)}
					/>
					<span class="param-unit">m</span>
				</span>
			</div>
		{/if}
		<div class="param-row">
			<span class="param-label">{t('Thickness')}</span>
			<span class="param-control">
				<NumberInput
					value={selectedThickness}
					min={0}
					max={2}
					step={0.05}
					onchange={(value) => setSelectedNumber('thicknessM', value)}
				/>
				<span class="param-unit">m</span>
			</span>
		</div>
		{#if selected.kind === 'stair'}
			<div class="param-row readonly">
				<span class="param-label">{t('N of steps')}</span>
				<span class="param-value">
					{t('Auto ({count} × 0.3 m)', { count: selectedStepCount })}
				</span>
			</div>
		{:else}
			<button
				class="param-toggle"
				class:on={selected.solidBase}
				role="switch"
				aria-checked={selected.solidBase}
				onclick={toggleSelectedSolidBase}
			>
				<span>{t('Solid base floor')}</span>
				<span class="toggle-track"><span class="toggle-knob"></span></span>
			</button>
		{/if}
		<div class="planning-actions">
			<Button variant="secondary" size="sm" onclick={deleteSelectedSurface}>
				<Icon name="trash" size={14} />
				{t('Delete raised area')}
			</Button>
			<Button variant="primary" size="sm" onclick={closeSelectedSurface}>
				{t('Done')}
			</Button>
		</div>
	{:else}
		<div class="surface-kinds" role="group" aria-label={t('Surface kind')}>
			{#each surfaceKinds as option (option.id)}
				<button
					class="surface-kind"
					class:active={appState.surfaceKind === option.id}
					onclick={() => chooseSurfaceKind(option.id)}
				>
					{option.label}
				</button>
			{/each}
		</div>
		<!--
			The parameters, in full-width rows. Two number fields side by side in a 320 px
			sidebar did not fit — the second one ran past the card's border — and the reference
			tool puts every figure on its own row for the same reason: a value with a unit is read
			once, not scanned in a grid.
		-->
		<!--
			Rows are divs, not labels. A label forwards every click inside it to its control, so
			pressing "−" also focused the input and lit the whole row — the "both buttons glow"
			report. Nothing here needs label semantics: the number field carries its own accessible
			name.
		-->
		<div class="param-row">
			<span class="param-label">{t('Material')}</span>
			<Select
				value={appState.surfaceMaterial ?? 'custom'}
				options={materialOptions}
				onchange={handleMaterialChange}
				aria-label={t('Material')}
			/>
		</div>
		<div class="param-row">
			<span class="param-label">{t('Attenuation')}</span>
			{#if presetAttenuation !== null}
				<!--
					A preset's loss is its own number, so the field is a readout, not an input: a
					deck cannot be "steel, but 12 dB". Choosing Custom hands the field back with
					the figure the preset last wrote, and from there it is the user's.
				-->
				<span class="param-value" title={t('Set by the material')}>{presetAttenuation} dB</span>
			{:else}
				<span class="param-control">
					<NumberInput bind:value={appState.surfaceAttenuationDb} min={0} max={120} step={1} />
					<span class="param-unit">dB</span>
				</span>
			{/if}
		</div>
		<div class="param-row">
			<span class="param-label">{t('Upper height')}</span>
			<span class="param-control">
				<NumberInput bind:value={appState.surfaceTopHeightM} min={0} max={12} step={0.1} />
				<span class="param-unit">m</span>
			</span>
		</div>
		<div class="param-row">
			<span class="param-label">{t('Thickness')}</span>
			<span class="param-control">
				<NumberInput bind:value={appState.surfaceThicknessM} min={0} max={2} step={0.05} />
				<span class="param-unit">m</span>
			</span>
		</div>
		<div class="param-row">
			<span class="param-label">{appState.surfaceKind === 'platform' ? t('Height') : t('Lower height')}</span>
			<span class="param-control">
				<NumberInput bind:value={appState.surfaceHeightM} min={0} max={12} step={0.1} />
				<span class="param-unit">m</span>
			</span>
		</div>
		{#if appState.surfaceKind === 'stair'}
			<!--
				Derived, not stored: a stair's run is its rectangle, so the treads follow from the
				rise at the standard 0.3 m depth. The reference's "Auto" is the same number, and a
				stored count could disagree with the shape.
			-->
			<div class="param-row readonly">
				<span class="param-label">{t('N of steps')}</span>
				<span class="param-value">
					{t('Auto ({count} × 0.3 m)', { count: previewStepCount })}
				</span>
			</div>
		{:else}
			<button
				class="param-toggle"
				class:on={appState.surfaceSolidBase}
				role="switch"
				aria-checked={appState.surfaceSolidBase}
				onclick={() => (appState.surfaceSolidBase = !appState.surfaceSolidBase)}
			>
				<span>{t('Solid base floor')}</span>
				<span class="toggle-track"><span class="toggle-knob"></span></span>
			</button>
		{/if}
		{#if appState.surfaceMode}
			<p class="planning-hint">
				{appState.surfaceDraft
					? t('Click the opposite corner. Escape cancels.')
					: t('Click one corner of the raised area, then the other.')}
			</p>
			<div class="planning-actions">
				<Button variant="primary" size="sm" onclick={() => setSurfaceMode(false)}>
					{t('Done')}
				</Button>
			</div>
		{:else}
			<div class="planning-actions">
				<Button variant="secondary" size="sm" onclick={() => setSurfaceMode(true)}>
					<Icon name="pencil" size={14} />
					{t('Draw raised area')}
				</Button>
			</div>
		{/if}
	{/if}
</PanelCard>

<style>
	.surface-kinds {
		display: flex;
		width: 100%;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		overflow: hidden;
	}

	.surface-kind {
		flex: 1;
		padding: 5px 0;
		font-size: var(--text-xs);
		color: var(--text-secondary);
		background: transparent;
		border: none;
		cursor: pointer;
	}

	.surface-kind + .surface-kind {
		border-left: 1px solid var(--border-subtle);
	}

	.surface-kind:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.surface-kind.active {
		background: var(--accent-primary);
		color: #0b0d12;
	}

	.param-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		min-height: 26px;
	}

	.param-label {
		font-size: var(--text-xs);
		color: var(--text-secondary);
		white-space: nowrap;
	}

	.param-control {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		flex: none;
		min-width: 0;
	}

	/*
	 * The stepper is a whole control (minus, field, plus), and at its natural width it ran
	 * past the card's right edge. Given the row a fixed budget it fits beside the label even
	 * in a 320 px sidebar, and the unit stays on the line.
	 */
	.param-control :global(.number-input) {
		width: 104px;
		flex: none;
	}

	.param-control :global(.number-input input) {
		width: 100%;
		min-width: 0;
		text-align: right;
	}

	.param-unit {
		width: 18px;
		font-size: var(--text-xs);
		color: var(--text-tertiary, var(--text-secondary));
	}

	.param-value {
		font-size: var(--text-xs);
		color: var(--text-primary);
	}

	.param-row.readonly .param-label {
		color: var(--text-secondary);
	}

	.param-toggle {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		width: 100%;
		padding: 4px 0;
		font-size: var(--text-xs);
		color: var(--text-secondary);
		background: transparent;
		border: none;
		cursor: pointer;
	}

	.toggle-track {
		position: relative;
		width: 28px;
		height: 16px;
		border-radius: 8px;
		background: var(--bg-surface);
		border: 1px solid var(--border-default);
		flex: none;
	}

	.toggle-knob {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: var(--text-secondary);
		transition: transform var(--transition-fast), background var(--transition-fast);
	}

	.param-toggle.on .toggle-knob {
		transform: translateX(12px);
		background: var(--accent-primary);
	}

	.param-toggle.on {
		color: var(--text-primary);
	}

	/* Body helpers, repeated until the remaining cards share one home for them. */
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
</style>
