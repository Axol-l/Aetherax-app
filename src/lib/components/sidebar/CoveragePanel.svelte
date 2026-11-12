<script lang="ts">

	import { projectMeta } from '$state/project-meta.svelte';
	import {
		optimizerState,
		runOptimizer,
		optimizeAllFloors,
		cancelOptimizer,
		floorCoverage,
		getBuildingCoverage,
		updateCoverage,
		resultIsStale
	} from '$state/optimizer.svelte';
	import { floorState } from '$state/floor-state.svelte';
	import { appState, setApPlaceMode } from '$state/app.svelte';
	import { getAvailableChannels, nonOverlappingChannels } from '@aetherax/channels';
	import Button from '$components/shared/Button.svelte';
	import Icon from '$components/shared/Icon.svelte';
	import Select from '$components/shared/Select.svelte';
	import Tooltip from '$components/shared/Tooltip.svelte';
	import { t } from '$state/i18n.svelte';
	import { slide } from 'svelte/transition';
	import { motionDuration } from '$lib/motion.js';
	import { wallState } from '$state/wall-state.svelte';
	import { applyPathLossScenario } from '$state/path-loss-state.svelte';
	import { scheduleSave } from '$state/persistence.svelte.js';
	import { decodeMask } from '$canvas/mask-codec.js';
	import { computeBuildingInterior } from '$canvas/morphology.js';
	import {
		PATH_LOSS_SCENARIOS,
		pathLossScenario,
		setCoverageThresholdDbm,
		type PathLossScenario
	} from '$lib/rf/propagation.js';
	import {
		displayLength,
		lengthInputHints,
		lengthUnit,
		unitToMetres
	} from '$lib/units.js';
	import { apState } from '$state/ap-state.svelte.js';
	import { floorplanState } from '$state/floorplan-state.svelte.js';
	import { DEFAULT_CLIENTS_PER_AP } from '$lib/domain/client-capacity.js';
	import WarningDialog from '$components/dialogs/WarningDialog.svelte';

	let settingsOpen = $state(false);
	let optimizerErrorOpen = $state(false);

	/*
	 * 设置改过、但还没重跑时，布局是旧设置选出来的。
	 *
	 * 这里只负责“变旧的那一刻”弹一次：把答案留在评分状态里（`settingsAtRun`），
	 * 用户关掉提示之后不再反复打扰——他改的就是设置，自己知道。
	 */
	const staleResult = $derived(resultIsStale());
	let staleNotifiedFor: string | null = null;
	$effect(() => {
		if (!staleResult) {
			staleNotifiedFor = null;
			return;
		}
		const run = `${optimizerState.lastRunAt}:${optimizerState.settingsAtRun}`;
		if (staleNotifiedFor === run) return;
		staleNotifiedFor = run;
		appState.staleSettingsNotice = t(
			'Optimiser settings changed since the last run — the layout on screen was chosen with the old values. Run the optimiser again to apply them.'
		);
	});

	$effect(() => {
		optimizerErrorOpen = Boolean(optimizerState.error);
	});

	let channelCount = $derived.by(() => {
		try {
			const available = getAvailableChannels(apState.band, apState.regulatoryDomain);
			return nonOverlappingChannels(available, apState.channelWidth).length;
		} catch {
			return 0;
		}
	});

	const multiFloor = $derived(floorState.floors.length > 1);

	const scenarioOptions = $derived(
		(Object.keys(PATH_LOSS_SCENARIOS) as PathLossScenario[]).map((value) => ({
			value,
			label: t(
				{
					lineOfSight: 'Walls drawn in full',
					office: 'Walls partly drawn',
					closedPlan: 'Walls barely drawn'
				}[value]
			)
		}))
	);

	const lengthDisplayUnit = $derived(lengthUnit(floorplanState.unitSystem));
	const clientHeightHints = $derived(lengthInputHints(0.5, 3, 0.1, lengthDisplayUnit));

	function applyCoverageThreshold(value: number): void {
		const threshold = Math.min(-55, Math.max(-85, Number(value)));
		if (!Number.isFinite(threshold)) return;
		projectMeta.coverageThresholdDbm = threshold;
		setCoverageThresholdDbm(threshold);
		scheduleSave();
		void updateCoverage();
	}

	const buildingPct = $derived(getBuildingCoverage());
	const deviceLoad = $derived(floorCoverage.get(floorState.currentFloorId)?.devices ?? 0);
	const clientCapacity = $derived(
		(floorState.floors.length <= 1
			? apState.aps
			: apState.aps.filter((ap) => ap.floorId === floorState.currentFloorId)
		).reduce((sum, ap) => sum + (ap.clients ?? DEFAULT_CLIENTS_PER_AP), 0)
	);
	const apsOnFloor = $derived(
		floorState.floors.length <= 1
			? apState.aps.length
			: apState.aps.filter((ap) => ap.floorId === floorState.currentFloorId).length
	);
	const capacityAps = $derived(
		deviceLoad > 0 && clientCapacity > 0 && apsOnFloor > 0
			? Math.ceil(deviceLoad / (clientCapacity / apsOnFloor))
			: 0
	);

	const worstFloor = $derived.by(() => {
		let worst: { id: string; name: string; coverage: number } | null = null;
		for (const floor of floorState.floors) {
			const entry = floorCoverage.get(floor.id);
			if (!entry) continue;
			if (!worst || entry.coverage < worst.coverage) {
				worst = { id: floor.id, name: floor.name, coverage: entry.coverage };
			}
		}
		return worst;
	});

	const buildingStats = $derived.by(() => {
		let measured = 0;
		let belowHalf = 0;
		for (const entry of floorCoverage.values()) {
			measured++;
			if (entry.coverage < 50) belowHalf++;
		}
		return { measured, belowHalf };
	});

	$effect(() => {
		if (appState.floorView !== 'single' && appState.apPlaceMode) setApPlaceMode(false);
	});
</script>

{#if !optimizerState.isRunning && appState.floorView === 'single'}
	<Tooltip
		text={t('While this is on, a click on the canvas adds an access point. Escape stops.')}
		position="top"
		block
	>
		<button
			class="place-toggle"
			class:active={appState.apPlaceMode}
			aria-pressed={appState.apPlaceMode}
			onclick={() => setApPlaceMode(!appState.apPlaceMode)}
		>
			<Icon name="plus" size={14} />
			{t('Place APs')}
			{#if appState.apPlaceMode}
				<span class="place-hint">{t('click the canvas')}</span>
			{/if}
		</button>
	</Tooltip>
{/if}

<div class="coverage-panel">
	{#if apState.aps.length >= 1}
		{#if optimizerState.coverage > 0}
			<div class="metric">
				<div class="metric-head">
					<span class="metric-name">{t('Coverage')}</span>
					<span class="metric-value">{optimizerState.coverage}%</span>
				</div>
				<div class="coverage-bar-track">
					<div
						class="coverage-bar-fill"
						class:low={optimizerState.coverage < 30}
						class:med={optimizerState.coverage >= 30 && optimizerState.coverage < 60}
						class:high={optimizerState.coverage >= 60}
						style="width: {optimizerState.coverage}%"
					></div>
				</div>
			</div>
		{/if}

		{#if capacityAps > 0}			<div class="metric capacity-metric">
				<div class="metric-head">
					<span class="metric-name">{t('Capacity')}</span>
					<span class="metric-value">{apsOnFloor} / {capacityAps} APs</span>
				</div>
				<div class="coverage-bar-track">
					<div
						class="coverage-bar-fill"
						class:low={apsOnFloor < capacityAps * 0.5}
						class:med={apsOnFloor >= capacityAps * 0.5 && apsOnFloor < capacityAps}
						class:high={apsOnFloor >= capacityAps}
						style="width: {Math.min(100, (apsOnFloor / capacityAps) * 100)}%"
					></div>
				</div>
			</div>
		{/if}

		{#if multiFloor && buildingStats.measured > 0}
			<div class="building">
				<div class="building-head">
					<span class="building-title">{t('Whole building')}</span>
					<span class="building-value">{buildingPct}%</span>
				</div>
				<div class="building-detail">
					{#if worstFloor}
						<span class="worst" class:ok={worstFloor.coverage >= 70}>
							{t('Weakest')} {worstFloor.name} at {worstFloor.coverage}%
						</span>
					{/if}
					<span class="building-meta">
						{buildingStats.measured === 1
							? t('{count} floor measured', { count: buildingStats.measured })
							: t('{count} floors measured', { count: buildingStats.measured })}{#if buildingStats.belowHalf > 0}
							· {t('{count} below 50%', { count: buildingStats.belowHalf })}{/if}
					</span>
				</div>
			</div>
		{/if}

		{#if channelCount > 0 && channelCount <= 4}
			<div class="channel-warning">
				{t('Only')} {channelCount}
				{t('non-overlapping channels on this band. Placement and channel assignment are solved one after the other, so on a plan this tight the result may be well short of optimal — try a different Optimize Placement result, or widen the band.')}
			</div>
		{/if}
	{/if}

	{#if optimizerState.isRunning}
		<div class="optimize-progress">
			<span class="optimize-status">
				{optimizerState.status || t('Optimizing…')} {optimizerState.progress}%
			</span>
			<button class="action-btn" onclick={cancelOptimizer}>{t('Cancel')}</button>
		</div>
	{:else}
		<div class="settings-head">
			<span class="settings-title">{t('Placement optimiser')}</span>
			<Tooltip text={t('Placement optimiser settings')} position="top">
				<button
					class="settings-btn"
					class:active={settingsOpen}
					onclick={() => (settingsOpen = !settingsOpen)}
					aria-label={t('Placement optimiser settings')}
					aria-expanded={settingsOpen}
				>
					<Icon name="settings" size={14} />
				</button>
			</Tooltip>
		</div>

		{#if apState.aps.length >= 1}
			{#if multiFloor}
				<Tooltip
					position="top"
					text={t('Optimise every floor in turn with the others held fixed, and repeat until the building-wide coverage stops improving. Each floor\'s APs stay on their own storey.')}
				>
					<Button variant="primary" size="md" onclick={optimizeAllFloors}>
						<Icon name="grid" size={14} />
						{t('Optimize all floors')}
					</Button>
				</Tooltip>
				<Tooltip
					position="top"
					text={t('Optimise only the floor on screen, leaving every other storey exactly where it is. Cheaper than the all-floor run, but its result is scored without the floors it cannot see.')}
				>
					<Button variant="secondary" size="sm" onclick={runOptimizer}>
						<Icon name="sparkles" size={14} />
						{t('Optimize this floor')}
					</Button>
				</Tooltip>
			{:else}
				<Tooltip
					position="top"
					text={t('Find the best positions for the access points on this floor, keeping how many you placed. The score trades coverage against co-channel interference; both weights are in the optimiser settings.')}
				>
					<Button variant="primary" size="md" onclick={runOptimizer}>
						<Icon name="sparkles" size={14} />
						{t('Optimize placement')}
					</Button>
				</Tooltip>
			{/if}
		{/if}

		{#if settingsOpen}
			<div class="settings-popup" transition:slide={{ duration: motionDuration(180) }}>
				<Tooltip
					position="top"
					text={t('On lets APs land anywhere, walls included; off keeps them inside the floor boundary — the planning area if one is drawn, otherwise the detected building interior.')}
				>
					<button
						class="setting-row switch-row"
						class:on={projectMeta.allowOutsideRooms}
						role="switch"
						aria-checked={projectMeta.allowOutsideRooms}
						aria-label={t('Allow APs outside the floor boundary')}
						onclick={() => {
							projectMeta.allowOutsideRooms = !projectMeta.allowOutsideRooms;
							scheduleSave();
						}}
					>
						<span class="setting-title">{t('Allow APs outside the floor boundary')}</span>
						<span class="toggle-track"><span class="toggle-knob"></span></span>
					</button>
				</Tooltip>

				<Tooltip
					position="top"
					text={t('The signal level used to decide whether a sample counts as covered. The heatmap is painted from 10 dB below it, so the edge of the covered area still has a gradient. Raise it to −65 or −60 for high-density offices.')}
				>
					<label class="setting-row slider-row">
						<span class="setting-title">{t('Coverage threshold')}</span>
						<input
							type="number"
							min="-85"
							max="-55"
							step="1"
							value={projectMeta.coverageThresholdDbm}
							onchange={(e) => applyCoverageThreshold(Number(e.currentTarget.value))}
						/>
						<span class="setting-value">dBm</span>
					</label>
				</Tooltip>

				<Tooltip
					position="top"
					text={t('How much co-channel interference the optimiser trades against coverage: the score is coverage minus this weight times the share of the floor whose best access point is degraded by a co-channel second one. 0 scores coverage alone — the behaviour before the term existed — so it doubles as the A/B switch.')}
				>
					<label class="setting-row slider-row">
						<span class="setting-title">{t('Interference')}</span>
						<input
							type="range"
							min="0"
							max="1"
							step="0.05"
							value={projectMeta.interferenceWeight}
							oninput={(e) =>
								(projectMeta.interferenceWeight = Number(
									(e.currentTarget as HTMLInputElement).value
								))}
						/>
						<span class="setting-value">{projectMeta.interferenceWeight.toFixed(2)}</span>
					</label>
				</Tooltip>

				<Tooltip
					position="top"
					text={t('The share the optimiser\'s result must cover; 0 leaves the search unconstrained, and the placement advice then has no target to measure against.')}
				>
					<label class="setting-row slider-row">
						<span class="setting-title">{t('Min coverage')}</span>
						<input
							type="number"
							min="0"
							max="100"
							step="1"
							value={projectMeta.coverageFloorPct}
							onchange={(e) =>
								(projectMeta.coverageFloorPct = Math.min(
									100,
									Math.max(0, Number((e.currentTarget as HTMLInputElement).value))
								))}
						/>
						<span class="setting-value"
							>{projectMeta.coverageFloorPct > 0
								? `${projectMeta.coverageFloorPct}%`
								: 'off'}</span
						>
					</label>
				</Tooltip>

				<Tooltip
					position="top"
					text={t('Height of the client devices above the floor. APs are modelled as ceiling-mounted, so this is the other end of every cross-floor path: it changes both the vertical distance and, through it, the cross-floor loss.')}
				>
					<label class="setting-row slider-row">
						<span class="setting-title">{t('Client height')}</span>
						<input
							type="number"
							min={clientHeightHints.min}
							max={clientHeightHints.max}
							step={clientHeightHints.step}
							value={displayLength(projectMeta.clientHeight, lengthDisplayUnit).value}
							onchange={(e) =>
								(projectMeta.clientHeight = unitToMetres(
									Number((e.currentTarget as HTMLInputElement).value),
									lengthDisplayUnit
								))}
						/>
						<span class="setting-value">{lengthDisplayUnit}</span>
					</label>
				</Tooltip>

				<Tooltip
					position="top"
					text={t('How many times to run the optimiser on this floor, keeping the best result. Each run starts from a different seed. 1 is fastest; the browser console prints the spread across runs, which says whether the extra ones are buying anything.')}
				>
					<label class="setting-row slider-row">
						<span class="setting-title">{t('Restarts')}</span>
						<input
							type="number"
							min="1"
							max="8"
							step="1"
							value={optimizerState.restarts}
							onchange={(e) =>
								(optimizerState.restarts = Math.max(
									1,
									Math.min(
										8,
										Math.round(Number((e.currentTarget as HTMLInputElement).value))
									)
								))}
						/>
						<span class="setting-value">{t('run(s)')}</span>
					</label>
				</Tooltip>

				<div class="setting-row slider-row">
					<!--
						The tooltip wraps the label only: wrapping the whole row meant it stayed under
						the cursor and covered the list when the select opened upwards.
					-->
					<span class="prop-label">
						<Tooltip
							position="top"
							text={t('How much wall loss the distance model already contains. The tabulated value does include a wall allowance and this app also charges every wall the ray crosses, so the more completely the walls are drawn, the lower the value should be: too high makes coverage radii too small and the plan look like it needs more APs.')}
						>
							<span class="setting-title">{t('Propagation')}</span>
						</Tooltip>
					</span>
					<div class="env-select">
						<Select
							value={projectMeta.pathLossScenario}
							options={scenarioOptions}
							aria-label={t('Propagation environment')}
							onchange={(value) => applyPathLossScenario(value as PathLossScenario)}
						/>
					</div>
				</div>
			</div>
		{/if}
	{/if}
</div>

<WarningDialog
	bind:open={optimizerErrorOpen}
	title={t('Placement warning')}
	message={optimizerState.error ?? ''}
/>

<style>
	/*
	 * Placement mode
	 */
	.place-toggle {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		width: calc(100% - var(--space-4) * 2);
		margin: var(--space-3) var(--space-4) 0;
		padding: 6px var(--space-2);
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		color: var(--text-secondary);
		background: var(--bg-surface);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		cursor: pointer;
		transition: all var(--transition-fast);
	}

	.place-toggle:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.place-toggle.active {
		color: var(--text-on-accent, #fff);
		background: var(--accent-primary);
		border-color: var(--accent-primary);
	}

	.place-hint {
		opacity: 0.75;
		font-size: var(--text-xs);
	}

	.place-toggle:focus-visible {
		outline: 2px solid var(--accent-primary);
		outline-offset: 1px;
	}

	.metric {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.capacity-metric {
		margin-top: 2px;
	}

	.metric-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-2);
		font-size: var(--text-xs);
		color: var(--text-tertiary);
	}

	.metric-name {
		display: inline-flex;
		align-items: baseline;
		gap: var(--space-2);
		font: inherit;
		color: inherit;
	}

	.metric-value {
		font-family: var(--font-mono);
		color: var(--text-secondary);
	}

	/* The shared Select, sized like the popup's other fields. */
	.env-select {
		display: block;
		flex: 1 1 auto;
		min-width: 0;
	}

	.env-select :global(.trigger) {
		height: 24px;
		font-size: var(--text-xs);
	}



	.settings-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}

	.settings-title {
		font-size: var(--text-xs);
		color: var(--text-tertiary);
	}

	.building {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: var(--space-2) var(--space-2);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm);
	}

	.building-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-2);
	}

	.building-title {
		font-size: var(--text-xs);
		color: var(--text-secondary);
	}

	.building-value {
		font-family: var(--font-mono);
		font-size: var(--text-base, 0.8125rem);
		color: var(--text-primary);
	}

	.building-detail {
		display: flex;
		flex-direction: column;
		gap: 2px;
		font-size: var(--text-xs);
		color: var(--text-tertiary);
	}

	.building-detail .worst {
		color: var(--color-warning, #ffb800);
	}

	/* A weakest floor that is genuinely fine should not read as a warning. */
	.building-detail .worst.ok {
		color: var(--text-tertiary);
	}

	.building-meta {
		opacity: 0.75;
	}

	.coverage-panel {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		flex-shrink: 0;
		padding: var(--space-3) var(--space-4);
		border-bottom: 1px solid var(--border-subtle);
		background: var(--bg-secondary);
	}

	.coverage-panel :global(.btn) {
		width: 100%;
	}

	.coverage-bar-track {
		height: 6px;
		background: var(--bg-surface);
		border-radius: 3px;
		overflow: hidden;
	}

	.coverage-bar-fill {
		height: 100%;
		border-radius: 3px;
		transition: width 0.3s ease;
	}

	.coverage-bar-fill.low {
		background: var(--color-error, #ff4444);
	}

	.coverage-bar-fill.med {
		background: var(--color-warning, #ffb800);
	}

	.coverage-bar-fill.high {
		background: var(--color-success, #4ade80);
	}

	.channel-warning {
		border: 1px solid var(--color-warning, #ffb800);
		border-radius: var(--radius-sm);
		padding: var(--space-2);
		font-size: var(--text-xs);
		line-height: 1.4;
		color: var(--text-secondary);
	}


	/* The panel-wide rule above forces .btn to full width; inside the row the
	   button shares space with the settings toggle instead. */

	.settings-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 30px;
		color: var(--text-tertiary);
		background: none;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm);
		cursor: pointer;
		transition: all var(--transition-fast);
	}

	.settings-btn:hover,
	.settings-btn.active {
		background: var(--bg-hover);
		color: var(--text-secondary);
	}

	.settings-btn:focus-visible {
		outline: 2px solid var(--accent-primary);
		outline-offset: 1px;
	}

	.settings-popup {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm);
		padding: var(--space-3);
	}

	.settings-popup :global(.tooltip-wrapper) {
		width: 100%;
	}

	/*
	 * Every other row is a tooltip wrapper stretched across the popup; the propagation label
	 * must keep its own width so the select beside it gets the rest of the row.
	 */
	.prop-label :global(.tooltip-wrapper) {
		width: auto;
	}

	.setting-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		width: 100%;
		font-family: var(--font-sans);
		cursor: pointer;
	}

	/* The switch the AP editor uses for "Pin position": the track turns accent when on. */
	.switch-row {
		justify-content: space-between;
		padding: 2px 0;
		background: none;
		border: none;
		color: var(--text-secondary);
	}

	.switch-row:hover,
	.switch-row.on {
		color: var(--text-primary);
	}

	.switch-row.on .setting-title {
		color: var(--text-primary);
	}

	.toggle-track {
		position: relative;
		flex: 0 0 auto;
		width: 28px;
		height: 16px;
		border-radius: 999px;
		background: var(--bg-surface);
		border: 1px solid var(--border-default);
		transition:
			background var(--transition-fast),
			border-color var(--transition-fast);
	}

	.switch-row.on .toggle-track {
		background: var(--accent-primary);
		border-color: var(--accent-primary);
	}

	.toggle-knob {
		position: absolute;
		top: 1px;
		left: 1px;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: var(--text-secondary);
		transition:
			transform var(--transition-fast),
			background var(--transition-fast);
	}

	.switch-row.on .toggle-knob {
		transform: translateX(12px);
		background: #0b0d12;
	}

	.slider-row {
		flex-wrap: nowrap;
		cursor: default;
	}

	.slider-row input[type='range'] {
		flex: 1 1 40px;
		min-width: 0;
		accent-color: var(--accent-primary);
	}

	.slider-row input[type='number'] {
		flex: 0 0 52px;
		min-width: 0;
		height: 20px;
		background: var(--bg-surface);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		color: var(--text-primary);
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		padding: 0 4px;
	}

	.setting-title {
		flex: 0 0 auto;
		font-size: var(--text-xs);
		color: var(--text-secondary);
		white-space: nowrap;
	}

	.setting-value {
		flex: 0 0 auto;
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		color: var(--text-tertiary);
		white-space: nowrap;
	}

	.optimize-progress {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}

	.optimize-status {
		font-size: var(--text-xs);
		color: var(--text-tertiary);
		font-style: italic;
	}

	.action-btn {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		font-size: var(--text-xs);
		font-family: var(--font-sans);
		color: var(--text-tertiary);
		background: none;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm);
		padding: 2px 6px;
		cursor: pointer;
		transition: all var(--transition-fast);
	}

	.action-btn:hover {
		background: var(--bg-hover);
		color: var(--text-secondary);
	}
</style>
