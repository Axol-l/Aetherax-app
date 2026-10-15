<script lang="ts">
	import { projectState } from '$state/project.svelte';
	import { projectMeta } from '$state/project-meta.svelte';
	import {
		optimizerState,
		runOptimizer,
		optimizeAllFloors,
		cancelOptimizer,
		floorCoverage,
		getBuildingCoverage
	} from '$state/optimizer.svelte';
	import { floorState } from '$state/floor-state.svelte';
	import { appState, setApPlaceMode } from '$state/app.svelte';
	import { getAvailableChannels, nonOverlappingChannels } from '@aetherax/channels';
	import Button from '$components/shared/Button.svelte';
	import Icon from '$components/shared/Icon.svelte';
	import Tooltip from '$components/shared/Tooltip.svelte';
	import { t } from '$state/i18n.svelte';
	import { wallState } from '$state/wall-state.svelte';
	import { applyPathLossScenario } from '$state/path-loss-state.svelte';
	import { scheduleSave } from '$state/persistence.svelte.js';
	import { decodeMask } from '$canvas/wall-detect.js';
	import { computeBuildingInterior } from '$canvas/morphology.js';
	import {
		PATH_LOSS_SCENARIOS,
		pathLossScenario,
		type PathLossScenario
	} from '$lib/rf/propagation.js';
	import {
		displayLength,
		lengthInputHints,
		lengthUnit,
		unitToMetres
	} from '$lib/units.js';

	/**
	 * Coverage readout plus the placement optimiser's primary action.
	 *
	 * This lives outside ApList and is mounted by Sidebar directly. It used to
	 * sit inside ApList, which Sidebar swaps out for ApEditor as soon as an AP is
	 * selected — so the coverage figure vanished exactly when you were editing an
	 * AP's power and most wanted to watch it.
	 */
	let settingsOpen = $state(false);

	/**
	 * How many **non-overlapping** channels the current band, width and regulatory
	 * domain allow.
	 *
	 * Non-overlapping, not "available": 2.4 GHz permits eleven channels and only
	 * three of them do not overlap, while the solver will happily colour four APs
	 * with four of the eleven and treat them as non-conflicting. Three is the
	 * number the literature is about.
	 *
	 * Oustry et al. (Networks 81(1), 2023) measure the gain from alternating
	 * placement and assignment at a median of **zero**, with the improvements
	 * concentrated in instances that have only three channels — and Gondran et al.
	 * reach the same conclusion from a testbed: it pays *"only if all available
	 * channels are used"*. So a plan with channels to spare is a plan where this
	 * tool's place-then-colour pipeline is already the right shape, and a plan
	 * without them is one where it may be materially suboptimal. That is worth
	 * saying out loud, and it is the whole of the "budget" for joint optimisation
	 * at 5 GHz and above.
	 */
	let channelCount = $derived.by(() => {
		try {
			const available = getAvailableChannels(projectState.band, projectState.regulatoryDomain);
			return nonOverlappingChannels(available, projectState.channelWidth).length;
		} catch {
			return 0;
		}
	});
/**
	 * Which reading's explanation is open, if any.
	 *
	 * One at a time: the notes are alternatives to each other, and opening both turns a
	 * compact readout into a wall of text. Only the building card carries a note now
	 * that the two interference readings have left the panel.
	 */
	let openNote = $state<'building' | null>(null);
	function toggleNote(which: 'building'): void {
		openNote = openNote === which ? null : which;
	}

	const multiFloor = $derived(floorState.floors.length > 1);

	/*
	 * The environments are the ones the standard tabulates for how completely the walls are
	 * drawn; the numbers live in `PATH_LOSS_SCENARIOS` and the docs, not in the interface.
	 */
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


	/**
	 * The unit the client height is shown in, following the toolbar's ft/m switch.
	 *
	 * The value itself stays metric in `projectMeta`: it is the other end of every
	 * cross-floor path, and the models take metres. Only the field and its readout
	 * convert.
	 */
	const lengthDisplayUnit = $derived(lengthUnit(projectState.unitSystem));
	const clientHeightHints = $derived(lengthInputHints(0.5, 3, 0.1, lengthDisplayUnit));

	/**
	 * The building-wide mean, from the same per-floor figures the panel shows.
	 *
	 * Computed here rather than read from `optimizerState.buildingCoverage`, which is only
	 * written by an all-floor run — and a mean that disagrees with the floors it is a mean
	 * of is worse than no figure at all.
	 */
	const buildingPct = $derived(getBuildingCoverage());

	/**
	 * The weakest floor with data, named.
	 *
	 * A floor nobody has measured yet is not a candidate: its 0% is an absence, and
	 * calling that the weakest would put an unmeasured storey at the top of a warning.
	 */
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

	/**
	 * How many floors have been measured, and how many sit below half.
	 *
	 * The count and the margin are what make an average actionable — "3 floors, one at
	 * 41%" says where to look, while a bare "88%" does not.
	 */
	const buildingStats = $derived.by(() => {
		let measured = 0;
		let belowHalf = 0;
		for (const entry of floorCoverage.values()) {
			measured++;
			if (entry.coverage < 50) belowHalf++;
		}
		return { measured, belowHalf };
	});
</script>

{#if !optimizerState.isRunning}
	<!--
		Placement mode sits outside the coverage guard below, because the moment you
		most need it is when the floor has no access points yet — which is exactly when
		that whole block is hidden.

		Off by default: with it on, the canvas adds an AP to every stray click, so
		clicking to deselect or fumbling a pan leaves one behind.
	-->
	<button
		class="place-toggle"
		class:active={appState.apPlaceMode}
		aria-pressed={appState.apPlaceMode}
		title={t('While this is on, a click on the canvas adds an access point. Escape stops.')}
		onclick={() => setApPlaceMode(!appState.apPlaceMode)}
	>
		<Icon name="plus" size={14} />
		{t('Place APs')}
		{#if appState.apPlaceMode}
			<span class="place-hint">{t('click the canvas')}</span>
		{/if}
	</button>
{/if}

{#if projectState.aps.length >= 1}
	<div class="coverage-panel">
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

			<!--
				The two interference readings are deliberately **not** on this panel.

				They are per-plan model outputs, not things you steer while placing access
				points: the weight that trades them against coverage lives in the optimiser
				settings, and what a plan scored is written into the PDF report's cover and
				printed to the console by every run. Putting them here made the panel carry
				three figures whose two smaller ones were zero on most plans, which reads as
				"nothing to see" rather than "nothing wrong".

				The optimiser still scores them — `projectMeta.interferenceWeight` is
				unchanged, and the CCA half is what `ROADMAP.md` B4/B5 is about — so this is a
				display decision, not a modelling one.
			-->
		{/if}

		<!--
			The building block. Only meaningful for a stack, and only once there is
			something to average: every floor's figure comes from the same per-floor
			measurement the panel's own Coverage row uses, so the two cannot disagree
			by a rounding step the way a separately-rounded second pipeline can.
		-->
		{#if multiFloor && buildingStats.measured > 0}
			<div class="building">
				<div class="building-head">
					<button
						type="button"
						class="building-title as-button"
						aria-expanded={openNote === 'building'}
						onclick={() => toggleNote('building')}
					>
						{t('Whole building')}
					</button>
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
				{#if openNote === 'building'}
					<p class="metric-note">
						{t('The building figure is each measured floor’s coverage weighted by that floor’s sample count, so a small storey does not count as much as a large one. Optimising it means optimising the floors in turn and repeating until the building-wide number stops improving — "passes" counts those rounds, and the weakest floor is named rather than folded in, because a mean hides exactly the storey you would want to know about. It is never optimised *for*: a min-max objective is far sharper to search and buys little on average.')}
					</p>
				{/if}
			</div>
		{/if}

		{#if channelCount > 0 && channelCount <= 4}
			<!--
				The scarce-channel warning. Placement and assignment are solved
				sequentially here, which the literature says is fine when channels are
				plentiful and materially suboptimal when they are not — see the comment
				on `channelCount`.
			-->
			<div class="channel-warning">
				{t('Only')} {channelCount}
				{t('non-overlapping channels on this band. Placement and channel assignment are solved one after the other, so on a plan this tight the result may be well short of optimal — try a different Optimize Placement result, or widen the band.')}
			</div>
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
				<button
					class="settings-btn"
					class:active={settingsOpen}
					onclick={() => (settingsOpen = !settingsOpen)}
					title={t('Placement optimiser settings')}
					aria-label={t('Placement optimiser settings')}
					aria-expanded={settingsOpen}
				>
					<Icon name="settings" size={14} />
				</button>
			</div>

			<!--
				One primary action for the shape of the project, and the other as a
				second-tier button. Which one is primary is not cosmetic: on a single
				storey "optimize all floors" and "optimize placement" are the same run,
				so offering both as equals was offering the same button twice; on a
				stacked project the building-wide run is the one that moves the figure
				the user is looking at, and the single-floor run is the targeted tool.
			-->
			{#if multiFloor}
				<Tooltip
					wrap
					position="top"
					text={t('Optimise every floor in turn with the others held fixed, and repeat until the building-wide coverage stops improving. Each floor\'s APs stay on their own storey.')}
				>
					<Button variant="primary" size="md" onclick={optimizeAllFloors}>
						<Icon name="grid" size={14} />
						{t('Optimize all floors')}
					</Button>
				</Tooltip>
				<Tooltip
					wrap
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
					wrap
					position="top"
					text={t('Find the best positions for the access points on this floor, keeping how many you placed. The score trades coverage against co-channel interference; both weights are in the optimiser settings.')}
				>
					<Button variant="primary" size="md" onclick={runOptimizer}>
						<Icon name="sparkles" size={14} />
						{t('Optimize placement')}
					</Button>
				</Tooltip>
			{/if}

			{#if settingsOpen}
				<div class="settings-popup">
					<Tooltip
						wrap
						position="top"
						text={t('Off by default: optimised APs stay inside the detected building interior. Turn on to let them land anywhere, walls included.')}
					>
						<label class="setting-row">
							<input
								type="checkbox"
								checked={projectState.allowOutsideRooms}
								onchange={(e) =>
									(projectState.allowOutsideRooms = (
										e.currentTarget as HTMLInputElement
									).checked)}
							/>
							<span class="setting-title">{t('Allow APs outside rooms')}</span>
						</label>
					</Tooltip>

					<Tooltip
						wrap
						position="top"
						text={t('Signal below this is left transparent, so the coloured area lines up with the coverage circle around each AP. Raise it (e.g. -70 dBm) to show only the strong core.')}
					>
						<label class="setting-row slider-row">
							<span class="setting-title">{t('Min signal')}</span>
							<input
								type="range"
								min="-95"
								max="-55"
								step="5"
								value={projectState.heatmapRssiFloor}
								oninput={(e) =>
									(projectState.heatmapRssiFloor = Number(
										(e.currentTarget as HTMLInputElement).value
									))}
							/>
							<span class="setting-value">{projectState.heatmapRssiFloor} dBm</span>
						</label>
					</Tooltip>

					<Tooltip
						wrap
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
						wrap
						position="top"
						text={t('ε-constraint: the minimum share of the floor the optimiser\'s result must cover. 0 is no constraint, which is the plain coverage-minus-interference trade. Setting a floor makes the requirement explicit — a weighted sum can only walk the convex part of the coverage/interference front, so a floor is how a non-convex stretch, or a guarantee like \'no less than 90%\', gets expressed.')}
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

					<!--
						Only meaningful once a floor is set, and only on a stack: it is a guarantee
						about the building, which a single-storey project cannot have a weakest floor
						in. Shown next to the figure it qualifies rather than in a section of its own.
					-->
					{#if multiFloor && projectMeta.coverageFloorPct > 0}
						<Tooltip
							wrap
							position="top"
							text={t('Apply the floor to every storey, not just the one you optimise: an all-floors run gives the weakest floor that falls short one more pass with the floor as its own constraint. A1\'s "no floor below X%", which a weighted sum cannot express.')}
						>
							<label class="setting-row">
								<input
									type="checkbox"
									checked={projectMeta.coverageFloorEveryFloor}
									onchange={(e) =>
										(projectMeta.coverageFloorEveryFloor = (
											e.currentTarget as HTMLInputElement
										).checked)}
								/>
								<span class="setting-title">{t('Every floor')}</span>
							</label>
						</Tooltip>
					{/if}

					<Tooltip
						wrap
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
							<!--
								The unit only: the field already shows the number, and printing it
								again beside the field read as two conflicting values.
							-->
							<span class="setting-value">{lengthDisplayUnit}</span>
						</label>
					</Tooltip>

					<Tooltip
						wrap
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

					<!--
						The distance term's environment. The ITU coefficient already contains an
						average allowance for walls, and this app also charges every crossing, so the
						value has to match what the plan accounts for — which is why the panel says
						which one the detected walls justify instead of leaving a bare number.
					-->
					<Tooltip
						wrap
						position="top"
						text={t('How much wall loss the distance model already contains. The tabulated value does include a wall allowance and this app also charges every wall the ray crosses, so the more completely the walls are drawn, the lower the value should be: too high makes coverage radii too small and the plan look like it needs more APs.')}
					>
						<label class="setting-row slider-row">
							<span class="setting-title">{t('Propagation')}</span>
							<select
								class="env-select"
								aria-label={t('Propagation environment')}
								value={projectMeta.pathLossScenario}
								onchange={(e) =>
									applyPathLossScenario((e.currentTarget as HTMLSelectElement).value as PathLossScenario)}
							>
								{#each scenarioOptions as option (option.value)}
									<option value={option.value}>{option.label}</option>
								{/each}
							</select>
						</label>
					</Tooltip>
				</div>
			{/if}
		{/if}


		{#if optimizerState.error}
			<span class="optimize-error">{optimizerState.error}</span>
		{/if}
	</div>
{/if}

<style>
	/*
	 * Placement mode. Primary styling when on, because the mode changes what a click
	 * on the canvas does and has to be visible at a glance — and it is off by default,
	 * so the button also has to read as an invitation when it is not.
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

	/*
	 * Metric rows. The name and the number share a line, the bar sits under them, and the
	 * explanation is a disclosure rather than a hover bubble: these labels live inside the
	 * sidebar's scroll container, where a bubble anchored to them is clipped, and a
	 * paragraph that vanishes when the pointer moves is the wrong affordance for text you
	 * are meant to read while looking at the number.
	 */
	.metric {
		display: flex;
		flex-direction: column;
		gap: 4px;
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

	/*
	 * The clickable name is the disclosure: the whole label, not a stray icon.
	 *
	 * It used to carry a circled "?" after the text. That mark is gone — the note
	 * it opens reads as ordinary panel prose, and a permanent question mark beside
	 * a figure the panel is confident about implied the number was in doubt. The
	 * label still opens and closes the note; `aria-expanded` is what says so to a
	 * screen reader.
	 */
	.as-button {
		padding: 0;
		background: none;
		border: none;
		cursor: pointer;
		text-align: left;
	}

	.as-button:hover {
		color: var(--text-secondary);
	}

	.as-button[aria-expanded='true'] {
		color: var(--text-primary);
	}

	.as-button:focus-visible {
		outline: 2px solid var(--accent-primary);
		outline-offset: 2px;
	}

	.metric-value {
		font-family: var(--font-mono);
		color: var(--text-secondary);
	}

	.env-select {
		flex: 1;
		min-width: 0;
		padding: 3px 6px;
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		color: var(--text-primary);
		background: var(--bg-primary);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
	}



	.metric-note {
		margin: 2px 0 0;
		font-size: var(--text-xs);
		line-height: 1.5;
		color: var(--text-tertiary);
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

	/* The building card. Headed, so it reads as a section rather than as a stranded
	   sentence, and the weakest floor is a named status rather than a colour. */
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

	.setting-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		width: 100%;
		font-family: var(--font-sans);
		cursor: pointer;
	}

	.setting-row input[type='checkbox'] {
		flex: 0 0 auto;
		accent-color: var(--accent-primary);
	}

	/*
	 * One line, always. The row used to wrap, which put the slider on a second
	 * line as soon as the label and value together exceeded the popup width.
	 * The slider absorbs the remaining space instead, and the label is kept short
	 * enough that it never needs to steal a line.
	 */
	.slider-row {
		flex-wrap: nowrap;
		cursor: default;
	}

	.slider-row input[type='range'] {
		flex: 1 1 40px;
		min-width: 0;
		accent-color: var(--accent-primary);
	}

	/* The height field is a number, not a slider: it is a modelling assumption to
	   be typed, and the exact value matters more than the ability to scrub it. */
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

	.optimize-error {
		font-size: var(--text-xs);
		color: var(--color-error);
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
