<script lang="ts">
	/**
	 * Raised surfaces: a mezzanine, a stair, a ramp.
	 *
	 * A plan is flat and the model used to be too. What this card states is a fact the
	 * drawing cannot: the floor inside this rectangle is *not* the slab, so a client there is
	 * a different distance from the ceiling — and from every AP. A stair and a ramp are the
	 * same rectangle with two heights instead of one, which is why the second field appears
	 * only when it means something.
	 */
	import { appState, setSurfaceMode } from '$state/app.svelte.js';
	import { currentFloor } from '$state/floor-state.svelte.js';
	import { pushState } from '$state/history.svelte.js';
	import { scheduleSave } from '$state/persistence.svelte.js';
	import { updateCoverage } from '$state/optimizer.svelte.js';
	import { t } from '$state/i18n.svelte';
	import { stepCount, type SurfaceKind } from '$lib/rf/surface-height.js';
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
	 * Pick the kind a new surface will be.
	 *
	 * A platform is level by definition, so choosing it copies the low height to the high one
	 * rather than leaving a rise the drawing does not show; choosing a stair or a ramp leaves
	 * the pair alone, because it already means something.
	 */
	function chooseSurfaceKind(kind: SurfaceKind): void {
		appState.surfaceKind = kind;
		if (kind === 'platform') {
			appState.surfaceTopHeightM = appState.surfaceHeightM;
		} else if (appState.surfaceTopHeightM <= appState.surfaceHeightM) {
			// A stair with no rise is a platform with extra controls. Start it above the low
			// end so the first one drawn already says what it is.
			appState.surfaceTopHeightM = appState.surfaceHeightM + 1;
		}
	}

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

	function clearSurfaces(): void {
		const floor = currentFloor();
		if (!floor) return;
		pushState();
		floor.surfaces = [];
		appState.surfaceSelected = null;
		void updateCoverage();
		scheduleSave();
	}
</script>

<PanelCard title={t('Raised surfaces')} icon="stack" bind:collapsed>
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
		<span class="param-label">{t('Attenuation')}</span>
		<span class="param-control">
			<NumberInput bind:value={appState.surfaceAttenuationDb} min={0} max={120} step={1} />
			<span class="param-unit">dB</span>
		</span>
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
			{#if (currentFloor()?.surfaces ?? []).length > 0}
				<Button variant="ghost" size="sm" onclick={clearSurfaces}>
					{t('Clear raised areas')}
				</Button>
			{/if}
		</div>
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
