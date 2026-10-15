<script lang="ts">
	/**
	 * Placement advice.
	 *
	 * The readout the optimiser cannot give: it arranges the access points you
	 * have, and holds that count fixed, so "you are one AP short" is a sentence no
	 * run produces. This panel produces it from the run's own figures.
	 *
	 * It appears when a run completes rather than being always present, because
	 * every rule reads a *measurement*: before a run, coverage is the default 0 and
	 * the advice would be about a plan nobody has scored. See `docs/AP_ADVICE.md`
	 * for the conditions, their thresholds and what each estimate assumes.
	 */
	import { projectState } from '$state/project.svelte';
	import { projectMeta } from '$state/project-meta.svelte';
	import { optimizerState, floorCoverage } from '$state/optimizer.svelte';
	import { floorState, currentFloor } from '$state/floor-state.svelte';
	import type { AdviceFinding } from '$lib/ap-advice.js';
	import { DEFAULT_COVERAGE_TARGET, evaluateApAdvice } from '$lib/ap-advice.js';
	import { polygonArea } from '$canvas/boundary-detect.js';
	import { areaUnit as areaUnitFor, sqmToUnit } from '$lib/units.js';
	import Icon from '$components/shared/Icon.svelte';
	import { t } from '$state/i18n.svelte';

	/**
	 * Dismissal, and which run it applied to.
	 *
	 * A dismissed panel has to stay dismissed while the user reads the plan, and
	 * has to come back when the next run produces new numbers — so what is
	 * remembered is the run it was dismissed for, not a bare boolean that would
	 * either nag on every interaction or never return.
	 *
	 * `$state`, not a plain `let`: it is read by a `$derived`, and a plain binding
	 * would leave the dismiss button changing a value nothing re-renders on.
	 */
	let dismissedRun = $state<number | null>(null);

	/** The APs the run arranged: every AP on a single-storey project, else the floor's. */
	const apsOnFloor = $derived.by(() => {
		if (floorState.floors.length <= 1) return projectState.aps;
		return projectState.aps.filter((ap) => ap.floorId === floorState.currentFloorId);
	});

	/** The requirement the advice measures against: the ε floor, else the default. */
	const target = $derived(
		projectMeta.coverageFloorPct > 0 ? projectMeta.coverageFloorPct : DEFAULT_COVERAGE_TARGET
	);

	/**
	 * Usable floor area, in square metres, from the detected boundary.
	 *
	 * The polygon is in world units, so it divides by the scale squared. Null when
	 * the boundary was never detected (a hand-drawn plan, or one whose calibration
	 * was skipped), in which case the area-per-AP detail is left out rather than
	 * guessed from the mask's bounding box — a rectangle around an L-shaped plan
	 * overstates it, and an overstated area argues for an AP that is not needed.
	 */
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

	const findings = $derived(
		evaluateApAdvice({
			apsOnFloor: apsOnFloor.length,
			coverage: optimizerState.coverage,
			interference: optimizerState.interference,
			contention: optimizerState.contention,
			target,
			unassigned: projectState.aps.filter((ap) => ap.assignedChannel === null).length,
			calibrated: floorState.floors[0]?.calibration != null,
			floorAreaSqm,
			multiFloor: floorState.floors.length > 1,
			buildingCoverage: optimizerState.buildingCoverage,
			worstFloor
		})
	);

	/**
	 * Whether there is a measurement worth advising on.
	 *
	 * Both halves matter: without a completed run the coverage figure is a default,
	 * and with coverage at zero there is nothing to count APs against — the run
	 * either found no enclosing walls or has not measured this floor yet, and
	 * "add four APs" would be advice about the wrong problem.
	 */
	const hasAdvice = $derived(
		optimizerState.lastRunAt !== null &&
			optimizerState.coverage > 0 &&
			apsOnFloor.length > 0 &&
			findings.length > 0
	);

	const visible = $derived(hasAdvice && dismissedRun !== optimizerState.lastRunAt);

	/** An area-per-AP figure with its unit, in whatever unit the toolbar selects. */
	function areaPerApLabel(sqmPerAp: number): string {
		const unit = areaUnitFor(projectState.unitSystem);
		return `${Math.round(sqmToUnit(sqmPerAp, unit))} ${unit}`;
	}

	/**
	 * A finding's parameter, as a value `t()` can substitute.
	 *
	 * The index is typed `| undefined` (the project typechecks with
	 * `noUncheckedIndexedAccess`), and the rules always set what their own renderer
	 * reads — so the fallback is for the type, not for a case that can happen. It
	 * is 0 rather than an empty string because every parameter is a number.
	 */
	function param(finding: AdviceFinding, key: string): string | number {
		return finding.params[key] ?? 0;
	}

	/** Headings per kind, so the panel reads as a list of statements, not one blob. */
	function titleFor(finding: AdviceFinding): string {
		switch (finding.kind) {
			case 'calibrate':
				return t('Set the scale');
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
				<Icon name="sparkles" size={12} />
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
							{t('The building average is {building}% but {floor} is at {coverage}% — move an access point there, or run Optimize all floors with the per-floor minimum enabled.', {
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
