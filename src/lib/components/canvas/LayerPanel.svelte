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
	import { slide } from 'svelte/transition';
	import { motionDuration } from '$lib/motion.js';
	import { rampCss } from '$canvas/heatmap-ramp.js';
	import { heatmapDisplayFloorDbm } from '$canvas/heatmap-display.js';
	import { projectMeta } from '$state/project-meta.svelte';
	import { apState } from '$state/ap-state.svelte';
	import { maxPhyRateMbps, phyStandardForWifiStandard } from '$lib/rf/mcs.js';
	import { findModel } from '$lib/data/ap-models.js';

	let collapsed = $state(typeof window !== 'undefined' && window.innerWidth <= 768);

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

	// 色阶下限由覆盖门限推出（见 `heatmap-display.ts`）；读一下门限让图例跟着它更新。
	const floorDb = $derived.by(() => {
		void projectMeta.coverageThresholdDbm;
		return heatmapDisplayFloorDbm();
	});
	const rateTop = $derived(
		Math.max(
			300,
			...apState.aps.map((ap) =>
				maxPhyRateMbps(
					ap.channelWidth ?? 20,
					2,
					phyStandardForWifiStandard(findModel(ap.modelId ?? '')?.wifiStandard)
				)
			)
		)
	);
	const legendFloor = $derived(
		appState.heatmapMetric === 'sinr' ? -5 : appState.heatmapMetric === 'rate' ? 0 : floorDb
	);
	const legendTop = $derived(
		appState.heatmapMetric === 'sinr' ? 30 : appState.heatmapMetric === 'rate' ? rateTop : 0
	);
	const legendUnit = $derived(
		appState.heatmapMetric === 'rate' ? 'Mbps' : appState.heatmapMetric === 'sinr' ? 'dB' : 'dBm'
	);
	const LEGEND_BAND_DB = $derived(
		appState.heatmapMetric === 'rate' ? Math.max(25, rateTop / 12) : 5
	);
	const metricName = $derived(
		appState.heatmapMetric === 'rssi'
			? 'RSSI'
			: appState.heatmapMetric === 'sinr'
				? 'SINR'
				: t('Rate')
	);
	const legendBands = $derived.by(() => {
		const span = Math.max(LEGEND_BAND_DB, legendTop - legendFloor);
		const count = Math.max(1, Math.ceil(span / LEGEND_BAND_DB));
		return Array.from({ length: count }, (_, i) => ({
			key: i,
			color: rampCss((i + 0.5) / count),
			from: Math.round(legendFloor + i * LEGEND_BAND_DB)
		}));
	});
	const legendTicks = $derived(
		[0, 0.25, 0.5, 0.75, 1].map((r) => ({
			key: r,
			label: Math.round(legendFloor + r * (legendTop - legendFloor))
		}))
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
		<div class="panel-body" transition:slide={{ duration: motionDuration(180) }}>
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

			{#if appState.showHeatmap}
				<button
					class="layer-row"
					title={t('Cycle heatmap view')}
					aria-label="{t('Heatmap view')}: {metricName}"
					onclick={() =>
						(appState.heatmapMetric =
							appState.heatmapMetric === 'rssi'
								? 'sinr'
								: appState.heatmapMetric === 'sinr'
									? 'rate'
									: 'rssi')}
				>
					<span class="eye-icon"><Icon name="sparkles" size={14} /></span>
					<span class="layer-label">{t('Heatmap view')}: {metricName}</span>
				</button>
			{/if}

			{#if appState.showHeatmap}
				<div class="opacity-row">
					<span class="layer-label">{t('Heatmap opacity')}</span>
					<input
						type="range"
						min="0.1"
						max="1"
						step="0.05"
						value={appState.heatmapOpacity}
						oninput={(e) =>
							(appState.heatmapOpacity = Number((e.currentTarget as HTMLInputElement).value))}
						aria-label={t('Heatmap opacity')}
					/>
					<span class="opacity-value">{Math.round(appState.heatmapOpacity * 100)}%</span>
				</div>
			{/if}

			<!-- Underlay opacity for the tiled overview. -->
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

			<!-- Viewpoint of the 3D and stacked views. -->
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
						<span>
							{appState.heatmapMetric === 'rate'
								? `${t('PHY reference rate')} · Mbps`
								: t('Signal strength')}
						</span>
						{#if appState.heatmapMetric !== 'rate'}
							<span class="scale-unit">{legendUnit}</span>
						{/if}
					</div>
					<div
						class="scale-bar"
						role="img"
						aria-label={appState.heatmapMetric === 'rate'
							? t('Estimated PHY rate scale in Mbps')
							: t('Signal strength scale in dBm')}
					>
						<span
							class="scale-cell dead"
							title={t('Below the floor: no usable signal')}></span>
						{#each legendBands as band (band.key)}
							<span
								class="scale-cell band"
								style:background={band.color}
								title="{band.from} {legendUnit}"></span>
						{/each}
					</div>
					<div class="scale-ticks">
						{#each legendTicks as tick (tick.key)}
							<span>{tick.label}</span>
						{/each}
					</div>
					{#if appState.heatmapMetric === 'rate' && appState.heatmapProbe}
						<div class="rate-probe-min">
							MCS {appState.heatmapProbe.mcs} · PHY {Math.round(appState.heatmapProbe.phyMbps)} · ≈{Math.round(
								appState.heatmapProbe.throughputMbps
							)} Mbps
						</div>
					{/if}
				</div>
				{#if (floorState.floors.find((f) => f.id === floorState.currentFloorId)?.walls?.length ?? 0) === 0}
					<p class="no-vector-walls">
						{t('No vector walls on this floor: reflections and scattering need wall segments.')}
					</p>
				{/if}
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
		box-sizing: border-box;
		width: min(248px, calc(100vw - 24px));
		max-height: calc(100% - 80px);
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

	.no-vector-walls {
		margin: 6px 0 0;
		font-size: var(--text-xs);
		line-height: 1.35;
		color: var(--text-tertiary);
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

	.rate-probe-min {
		margin-top: 3px;
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		color: var(--text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
