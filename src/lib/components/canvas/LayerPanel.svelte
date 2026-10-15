<script lang="ts">
	import {
		appState,
		STACK_YAW_LIMIT_DEG,
		STACK_MIN_PITCH_DEG,
		STACK_MAX_PITCH_DEG
	} from '$state/app.svelte';
	import { floorState } from '$state/floor-state.svelte';
	import { floorplanState } from '$state/floorplan-state.svelte';
	import Icon from '$components/shared/Icon.svelte';
	import { t } from '$state/i18n.svelte';

	let collapsed = $state(typeof window !== 'undefined' && window.innerWidth <= 768);

	/**
	 * `singleViewOnly` marks the layers the tiled overview does not draw. Leaving
	 * them listed while tiled made the whole panel look broken: flipping them
	 * changed nothing, because the layers they control are switched off in that
	 * view. Hiding them keeps the panel honest about what it can currently do.
	 */
	const layers = [
		{ key: 'showHeatmap', label: 'Signal heatmap', singleViewOnly: false },
		{ key: 'showFloorplan', label: 'Floorplan', singleViewOnly: false },
		{ key: 'showAPs', label: 'Access points', singleViewOnly: false },
		{ key: 'showWalls', label: 'Walls', singleViewOnly: false },
		{ key: 'showRoomLabels', label: 'Room labels', singleViewOnly: true },
		{ key: 'showFloorBelow', label: 'Floor below', singleViewOnly: true },
		{ key: 'showLabels', label: 'Labels', singleViewOnly: true },
		{ key: 'showGrid', label: 'Grid', singleViewOnly: true }
	] as const;

	const visibleLayers = $derived(
		layers.filter((l) => !l.singleViewOnly || appState.floorView === 'single')
	);

	const legendItems = [
		{ color: 'rgb(40, 150, 40)', label: 'Excellent' },
		{ color: 'rgb(100, 180, 80)', label: 'Good' },
		{ color: 'rgb(210, 190, 30)', label: 'Fair' },
		{ color: 'rgb(220, 120, 20)', label: 'Poor' },
		{ color: 'rgb(180, 40, 40)', label: 'Dead' }
	];

	function toggleLayer(key: typeof layers[number]['key']) {
		appState[key] = !appState[key];
	}
</script>

<div class="layer-panel">
	<button class="panel-header" onclick={() => collapsed = !collapsed}>
		<span class="panel-title">{t('Layers')}</span>
		<span class="collapse-icon" class:collapsed>
			<Icon name="chevron-down" size={12} />
		</span>
	</button>

	{#if !collapsed}
		<div class="panel-body">
			{#each visibleLayers as layer}
				<button
					class="layer-row"
					onclick={() => toggleLayer(layer.key)}
				>
					<span class="eye-icon" class:hidden={!appState[layer.key]}>
						<Icon name={appState[layer.key] ? 'eye' : 'eye-off'} size={14} />
					</span>
					<span class="layer-label">{t(layer.label)}</span>
				</button>
			{/each}

			<!-- Underlay opacity for the tiled overview.
			     The single-floor view has its own row in the sidebar and each shows in
			     exactly one view, so there is never a second slider for the same
			     property on screen. Both write the same value. -->
			{#if appState.floorView === 'tiled'}
				<div class="opacity-row">
					<span class="layer-label">{t('Plan opacity')}</span>
					<input
						type="range"
						min="0.1"
						max="1"
						step="0.1"
						value={floorplanState.floorplanScale}
						oninput={(e) =>
							(floorplanState.floorplanScale = Number(
								(e.currentTarget as HTMLInputElement).value
							))}
						aria-label={t('Floor plan opacity')}
					/>
					<span class="opacity-value"
						>{Math.round(floorplanState.floorplanScale * 100)}%</span
					>
				</div>
			{/if}

			<!-- Viewpoint of the stacked overview. Like the opacity row above, these
			     belong to a view rather than to the plan, so they are shown only where
			     they do something: dragging on the canvas turns the view too, and these
			     are the same two numbers for when a precise angle is wanted. Pitch is
			     what separates the storeys on screen (`z·sin(pitch)`), and spacing pulls
			     them apart without touching the geometry. -->
			{#if appState.floorView === 'stacked'}
				<div class="opacity-row">
					<span class="layer-label">{t('Rotate')}</span>
					<input
						type="range"
						min={-STACK_YAW_LIMIT_DEG}
						max={STACK_YAW_LIMIT_DEG}
						step="15"
						value={appState.stackYaw}
						oninput={(e) => (appState.stackYaw = Number((e.currentTarget as HTMLInputElement).value))}
						aria-label={t('Stack rotation')}
					/>
					<span class="opacity-value">{Math.round(appState.stackYaw)}&deg;</span>
				</div>
				<div class="opacity-row">
					<span class="layer-label">{t('Tilt')}</span>
					<input
						type="range"
						min={STACK_MIN_PITCH_DEG}
						max={STACK_MAX_PITCH_DEG}
						step="5"
						value={appState.stackPitch}
						oninput={(e) => (appState.stackPitch = Number((e.currentTarget as HTMLInputElement).value))}
						aria-label={t('Stack tilt')}
					/>
					<span class="opacity-value">{Math.round(appState.stackPitch)}&deg;</span>
				</div>
				<div class="opacity-row">
					<span class="layer-label">{t('Spacing')}</span>
					<input
						type="range"
						min="0.5"
						max="2"
						step="0.1"
						value={appState.stackSpread}
						oninput={(e) =>
							(appState.stackSpread = Number((e.currentTarget as HTMLInputElement).value))}
						aria-label={t('Stack spacing')}
					/>
					<span class="opacity-value">{appState.stackSpread.toFixed(1)}&times;</span>
				</div>
				<!-- Hidden on a single-floor plan, where isolating the only floor is the
				     same as not isolating it. It used to keep the current floor and its
				     neighbours, which on the common two-storey plan kept everything and
				     looked broken. -->
				{#if floorState.floors.length > 1}
					<button
						class="layer-row"
						onclick={() => (appState.stackFocus = !appState.stackFocus)}
					>
						<span class="eye-icon" class:hidden={!appState.stackFocus}>
							<Icon name={appState.stackFocus ? 'eye' : 'eye-off'} size={14} />
						</span>
						<span class="layer-label">{t('Only this floor')}</span>
					</button>
				{/if}
			{/if}

			{#if appState.showHeatmap}
				<div class="legend-divider"></div>
				<div class="legend">
					{#each legendItems as item}
						<div class="legend-row">
							<span class="legend-swatch" style:background={item.color}></span>
							<span class="legend-label">{t(item.label)}</span>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.layer-panel {
		position: absolute;
		bottom: 32px;
		left: var(--space-3, 12px);
		z-index: 5;
		min-width: 140px;		max-height: calc(100% - 80px);
		overflow-y: auto;
		background: var(--bg-secondary, #1e2130);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-md);
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		color: var(--text-primary);
		user-select: none;
	}


	.panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		padding: var(--space-2) var(--space-2);
		border: none;
		background: none;
		color: var(--text-secondary);
		cursor: pointer;
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		font-weight: 500;
	}

	.panel-header:hover {
		color: var(--text-primary);
	}

	.collapse-icon {
		display: flex;
		align-items: center;
		transition: transform var(--transition-fast);
	}

	.collapse-icon.collapsed {
		transform: rotate(-90deg);
	}

	.panel-body {
		padding: 0 var(--space-2) var(--space-2);
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.layer-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		height: 22px;
		padding: 0 var(--space-1);
		border: none;
		background: none;
		color: var(--text-primary);
		cursor: pointer;
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		border-radius: var(--radius-sm);
		width: 100%;
		text-align: left;
	}

	.layer-row:hover {
		background: var(--bg-hover);
	}

	.eye-icon {
		display: flex;
		align-items: center;
		color: var(--accent-primary);
		flex-shrink: 0;
	}

	.eye-icon.hidden {
		color: var(--text-disabled);
	}

	.layer-label {
		white-space: nowrap;
	}

	.opacity-row {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 8px 2px;
		font-size: var(--text-xs);
		color: var(--text-secondary);
	}

	.opacity-row input[type='range'] {
		flex: 1 1 auto;
		min-width: 0;
		accent-color: var(--accent-primary);
	}

	.opacity-value {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--text-tertiary);
		min-width: 30px;
		text-align: right;
	}

	.legend-divider {
		height: 1px;
		background: var(--border-subtle);
		margin: var(--space-1) 0;
	}

	.legend {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 0 var(--space-1);
	}

	.legend-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		height: 18px;
	}

	.legend-swatch {
		width: 10px;
		height: 10px;
		border-radius: 2px;
		flex-shrink: 0;
	}

	.legend-label {
		color: var(--text-secondary);
		font-size: var(--text-xs);
	}
</style>
