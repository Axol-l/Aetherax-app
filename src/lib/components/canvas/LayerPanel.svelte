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
	import { rampCss } from '$canvas/heatmap-ramp.js';
	import { projectMeta } from '$state/project-meta.svelte';

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
		{ key: 'showNotes', label: 'Notes', singleViewOnly: true },
		{ key: 'showGrid', label: 'Grid', singleViewOnly: true }
	] as const;

	const visibleLayers = $derived(
		layers.filter((l) => !l.singleViewOnly || appState.floorView === 'single')
	);

	/**
	 * The scale, as the map paints it — in dBm.
	 *
	 * Five words ("Excellent … Dead") said how the map felt; the numbers say what it means,
	 * and a planner reads a survey in dBm. The bar runs from the project's own floor to
	 * 0 dBm, which is the range the heatmap maps onto the ramp, and each cell is the ramp's
	 * colour at that position — so the legend cannot drift from the map it describes.
	 *
	 * The grey cell at the left is the part the map does not paint at all: below the floor
	 * there is nothing to show, which is exactly the information "no usable signal" carries.
	 */
	const floorDb = $derived(projectMeta.heatmapRssiFloor ?? -85);
	/**
	 * The scale as bands, because the map is drawn as bands.
	 *
	 * A continuous bar next to a stepped map describes something the map is not. The bar is
	 * divided every `LEGEND_BAND_DB` from the floor to 0 dBm and each block takes the ramp's colour
	 * at its own middle — the same rule the heatmap uses for its bands, so a colour on the plan can
	 * be found on the legend.
	 */
	const LEGEND_BAND_DB = 5;
	const legendBands = $derived.by(() => {
		const span = Math.max(LEGEND_BAND_DB, 0 - floorDb);
		const count = Math.max(1, Math.ceil(span / LEGEND_BAND_DB));
		return Array.from({ length: count }, (_, i) => ({
			key: i,
			color: rampCss((i + 0.5) / count),
			from: Math.round(floorDb + i * LEGEND_BAND_DB)
		}));
	});
	const legendTicks = $derived(
		[0, 0.25, 0.5, 0.75, 1].map((r) => ({ key: r, label: Math.round(floorDb + r * (0 - floorDb)) }))
	);

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

			<!-- Viewpoint of the 3D and stacked views. Like the opacity row above, these
			     belong to a view rather than to the plan, so they are shown only where
			     they do something: dragging on the canvas turns the view too, and these
			     are the same two numbers for when a precise angle is wanted. Pitch is
			     what separates the storeys on screen (`z·sin(pitch)`), and spacing pulls
			     them apart without touching the geometry. -->
			{#if appState.floorView === 'stacked' || appState.floorView === 'floor3d'}
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
				<!-- The storey spacing and the isolation are properties of a *stack*: one
				     floor pulled away from itself is not a view, and the 3D view shows the
				     current floor at its own height. -->
				{#if appState.floorView === 'stacked'}
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
			{/if}

			{#if appState.showHeatmap}
				<div class="legend-divider"></div>
				<div class="legend">
					<div class="scale-head">
						<span>{t('Signal strength')}</span>
						<span class="scale-unit">dBm</span>
					</div>
					<div class="scale-bar" role="img" aria-label={t('Signal strength scale in dBm')}>
						<span
							class="scale-cell dead"
							title={t('Below the floor: no usable signal')}></span>
						{#each legendBands as band (band.key)}
							<span
								class="scale-cell band"
								style:background={band.color}
								title="{band.from} dBm"></span>
						{/each}
					</div>
					<div class="scale-ticks">
						{#each legendTicks as tick (tick.key)}
							<span>{tick.label}</span>
						{/each}
					</div>
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

	/*
	 * The scale bar: a head with the unit, a stepped ramp, and the numbers under it. The
	 * cells are separated by a hairline rather than blended into a gradient — the same reason
	 * a printed scale has ticks, it lets the eye read a value off the map instead of only
	 * ordering two colours.
	 */
	.scale-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		font-size: var(--text-xs);
		color: var(--text-secondary);
		margin-bottom: var(--space-1);
	}

	.scale-unit {
		font-family: var(--font-mono);
		color: var(--text-tertiary);
	}

	.scale-bar {
		display: flex;
		gap: 1px;
		height: 11px;
		border-radius: 2px;
		overflow: hidden;
	}

	.scale-cell {
		flex: 1 1 0;
		min-width: 0;
	}

	/* A band, not a gradient: the map paints bands, so the legend shows bands. */
	.scale-cell.band {
		border-right: 1px solid rgba(0, 0, 0, 0.35);
	}

	/* Below the floor the map paints nothing, so the legend shows nothing to paint. */
	.scale-cell.dead {
		flex: 0 0 6%;
		background: repeating-linear-gradient(
			45deg,
			var(--bg-elevated) 0 3px,
			var(--border-subtle) 3px 4px
		);
	}

	.scale-ticks {
		display: flex;
		justify-content: space-between;
		margin-top: 3px;
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		color: var(--text-tertiary);
	}
</style>
