<script lang="ts">
	/**
	 * Placement advice
	 */
	
	import { projectMeta } from '$state/project-meta.svelte';
	import { optimizerState, floorCoverage, measuredBuildingCoverage } from '$state/optimizer.svelte';
	import { floorState, currentFloor } from '$state/floor-state.svelte';
	import type { AdviceFinding } from '$lib/ap-advice.js';
	import { evaluateApAdvice } from '$lib/ap-advice.js';
	import { polygonArea } from '$canvas/boundary-detect.js';
	import { areaUnit as areaUnitFor, sqmToUnit } from '$lib/units.js';
	import { t } from '$state/i18n.svelte';
	import { apState } from '$state/ap-state.svelte.js';
	import { floorplanState } from '$state/floorplan-state.svelte.js';
	import { DEFAULT_CLIENTS_PER_AP } from '$lib/domain/client-capacity.js';

	let dismissedRun = $state<number | null>(null);

	/** The APs the run arranged: every AP on a single-storey project, else the floor's. */
	const apsOnFloor = $derived.by(() => {
		if (floorState.floors.length <= 1) return apState.aps;
		return apState.aps.filter((ap) => ap.floorId === floorState.currentFloorId);
	});

	/**
	 * The requirement the advice measures against: the ε floor, 0 when none is set.
	 *
	 * 没设要求时不要替用户挑一个目标：面板只报不依赖目标的问题（容量、信道、干扰），
	 * 增删 AP 的数量估计没有依据，就不报。
	 */
	const target = $derived(projectMeta.coverageFloorPct);

	const deviceLoad = $derived(floorCoverage.get(floorState.currentFloorId)?.devices ?? 0);
	const clientCapacity = $derived(
		apsOnFloor.reduce(
			(sum, ap) => sum + (ap.clients ?? DEFAULT_CLIENTS_PER_AP),
			0
		)
	);

	const floorAreaSqm = $derived.by(() => {
		const polygon = currentFloor()?.floorplanBoundary;
		const calibration = currentFloor()?.calibration;
		if (!polygon || polygon.length < 3 || !calibration) return null;
		const wupm = calibration.worldUnitsPerMeter;
		if (!(wupm > 0)) return null;
		return polygonArea(polygon) / (wupm * wupm);
	});

	/** The weakest floor with data, named, from the same cache the panel shows. */
	const worstFloor = $derived.by(() => {
		let worst: { name: string; coverage: number } | null = null;
		for (const floor of floorState.floors) {
			const entry = floorCoverage.get(floor.id);
			if (!entry) continue;
			if (!worst || entry.coverage < worst.coverage) {
				worst = { name: floor.name, coverage: entry.coverage };
			}
		}
		return worst;
	});

	/**
	 * 整栋均值，现读 `floorCoverage`。
	 *
	 * 以前读的是运行时抄下的快照：最弱层补跑改完某一层之后，快照还停在最后一整轮，
	 * 于是建议里的“整栋 X%”和面板上的整栋数字说的是两个时刻，15 个点的差距判据也会
	 * 跟着判错。
	 */
	const buildingCoverage = $derived(measuredBuildingCoverage());

	const findings = $derived(
		evaluateApAdvice({
			apsOnFloor: apsOnFloor.length,
			coverage: optimizerState.coverage,
			interference: optimizerState.interference,
			contention: optimizerState.contention,
			devices: deviceLoad,
			clientCapacity,
			target,
			unassigned: apState.aps.filter((ap) => ap.assignedChannel === null).length,
			calibrated: floorState.floors[0]?.calibration != null,
			floorAreaSqm,
			multiFloor: floorState.floors.length > 1,
			buildingCoverage,
			worstFloor
		})
	);

	const hasAdvice = $derived(
		optimizerState.lastRunAt !== null &&
			optimizerState.coverage > 0 &&
			apsOnFloor.length > 0 &&
			findings.length > 0
	);

	const visible = $derived(hasAdvice && dismissedRun !== optimizerState.lastRunAt);

	/** An area-per-AP figure with its unit, in whatever unit the toolbar selects. */
	function areaPerApLabel(sqmPerAp: number): string {
		const unit = areaUnitFor(floorplanState.unitSystem);
		return `${Math.round(sqmToUnit(sqmPerAp, unit))} ${unit}`;
	}

	function param(finding: AdviceFinding, key: string): string | number {
		return finding.params[key] ?? 0;
	}

	/** Headings per kind, so the panel reads as a list of statements, not one blob. */
	function titleFor(finding: AdviceFinding): string {
		switch (finding.kind) {
			case 'calibrate':
				return t('Set the scale');
			case 'capacity':
				return t('Client capacity');
			case 'add-aps':
				return t('Add access points');
			case 'remove-aps':
				return t('Remove access points');
			case 'assign-channels':
				return t('Assign channels');
			case 'interference':
				return t('Co-channel interference');
			case 'rebalance-floor':
				return t('Rebalance the floors');
			case 'meets-target':
				return t('Coverage is on target');
		}
	}
</script>

{#if visible}
	<section class="advice" aria-label={t('Placement advice')}>
		<div class="advice-head">
			<span class="advice-title">
				{t('Placement advice')}
			</span>
			<button
				class="dismiss-btn"
				onclick={() => (dismissedRun = optimizerState.lastRunAt)}
				aria-label={t('Dismiss')}
				title={t('Dismiss')}
			>
				&times;
			</button>
		</div>

		<ul class="advice-list">
			{#each findings.slice(0, 3) as finding (finding.kind)}
				<li class="finding" data-severity={finding.severity}>
					<span class="finding-title">{titleFor(finding)}</span>
					<p class="finding-text">
						{#if finding.kind === 'calibrate'}
							{t('Until the plan has a scale, every distance here and every AP range is in world units. Set the floorplan area in the Floorplan tab.')}
						{:else if finding.kind === 'capacity'}
							{t('Capacity covers {capacity} of {devices} clients — add {count} AP(s) at about {perAp} clients each.', {
								capacity: param(finding, 'capacity'),
								devices: param(finding, 'devices'),
								count: param(finding, 'count'),
								perAp: param(finding, 'perAp')
							})}
						{:else if finding.kind === 'add-aps'}
							{t('Coverage {coverage}% against a {target}% target — about {count} more AP(s) would close the gap.', {
								coverage: param(finding, 'coverage'),
								target: param(finding, 'target'),
								count: param(finding, 'count')
							})}
							{#if finding.params.areaPerAp}
								{t('One access point currently covers {area} on average.', {
									area: areaPerApLabel(Number(finding.params.areaPerAp))
								})}
							{/if}
						{:else if finding.kind === 'remove-aps'}
							{t('Coverage {coverage}%, well past the {target}% target — {count} AP(s) look redundant. Remove one and re-run to confirm the figure holds.', {
								coverage: param(finding, 'coverage'),
								target: param(finding, 'target'),
								count: param(finding, 'count')
							})}
						{:else if finding.kind === 'assign-channels'}
							{t('No channel assigned to {count} AP(s) yet — run the channel solver so the interference figure describes this plan.', {
								count: param(finding, 'count')
							})}
						{:else if finding.kind === 'interference'}
							{t('Co-channel interference {interference}% and contended airtime {contention}% — lower TX power on the overlapping APs, or space them further apart.', {
								interference: param(finding, 'interference'),
								contention: param(finding, 'contention')
							})}
						{:else if finding.kind === 'rebalance-floor'}
							{t('The building average is {building}% but {floor} is at {coverage}% — move an access point there, or run Optimize all floors, which retries the weakest floor when it falls short.', {
								building: param(finding, 'building'),
								floor: param(finding, 'floor'),
								coverage: param(finding, 'coverage')
							})}
						{:else if finding.kind === 'meets-target'}
							{t('{count} AP(s) cover {coverage}% of this floor — no change suggested.', {
								count: param(finding, 'count'),
								coverage: param(finding, 'coverage')
							})}
						{/if}
					</p>
				</li>
			{/each}
		</ul>

		<span class="advice-foot">{t('Based on the last optimisation run.')}</span>
	</section>
{/if}

<style>
	.advice {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		flex-shrink: 0;
		padding: var(--space-3) var(--space-4);
		background: var(--bg-secondary);
		border-bottom: 1px solid var(--border-subtle);
		/* It arrives rather than being there: the panel is the one part of the
		   sidebar that answers to a finished run, and a section appearing without
		   motion in a column the user is reading is easy to miss entirely. */
		animation: advice-in 200ms ease-out;
	}

	@keyframes advice-in {
		from {
			opacity: 0;
			transform: translateY(-4px);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}

	/* The animation carries the same information as the appearance, so removing it
	   costs nothing. */
	@media (prefers-reduced-motion: reduce) {
		.advice {
			animation: none;
		}
	}

	.advice-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}

	.advice-title {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		font-weight: 500;
		color: var(--text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.dismiss-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		padding: 0;
		background: none;
		border: none;
		border-radius: var(--radius-sm);
		color: var(--text-tertiary);
		font-size: 14px;
		line-height: 1;
		cursor: pointer;
	}

	.dismiss-btn:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.dismiss-btn:focus-visible {
		outline: 2px solid var(--accent-primary);
		outline-offset: 1px;
	}

	.advice-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/* The left edge is the severity: a border in the accent colour for something to
	   do, a muted one for context, and a success colour for the positive close. */
	.finding {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding-left: var(--space-2);
		border-left: 2px solid var(--border-default);
	}

	.finding[data-severity='action'] {
		border-left-color: var(--color-warning, #ffb800);
	}

	.finding[data-severity='good'] {
		border-left-color: var(--color-success, #4ade80);
	}

	.finding-title {
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		font-weight: 600;
		color: var(--text-secondary);
	}

	.finding-text {
		margin: 0;
		font-size: var(--text-xs);
		line-height: 1.45;
		color: var(--text-tertiary);
	}

	.advice-foot {
		font-size: var(--text-xs);
		color: var(--text-disabled);
	}
</style>
