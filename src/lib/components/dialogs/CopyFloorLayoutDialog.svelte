<script lang="ts">
	import { fade, fly } from 'svelte/transition';
	import Button from '$components/shared/Button.svelte';
	import { t } from '$state/i18n.svelte';
	import { motionDuration } from '$lib/motion.js';
	import { addFloor, floorState, getFloor, switchFloor } from '$state/floor-state.svelte.js';
	import { pushState } from '$state/history.svelte.js';
	import { scheduleSave } from '$state/persistence.svelte.js';

	let {
		open = $bindable(false),
		sourceId = ''
	}: {
		open: boolean;
		sourceId: string;
	} = $props();

	let target = $state('new');
	let copyPlan = $state(true);
	let copyWalls = $state(true);
	let copyPlanningArea = $state(true);
	let copySurfaces = $state(true);
	let copyNotes = $state(true);

	const source = $derived(getFloor(sourceId) ?? null);
	const targets = $derived(floorState.floors.filter((floor) => floor.id !== sourceId));
	const canCopy = $derived(
		source !== null && (copyPlan || copyWalls || copyPlanningArea || copySurfaces || copyNotes)
	);

	$effect(() => {
		if (!open) return;
		target = targets[0]?.id ?? 'new';
	});

	function clone<T>(value: T): T {
		return value == null ? value : (JSON.parse(JSON.stringify(value)) as T);
	}

	function handleCopy() {
		const from = source;
		if (!from) return;
		pushState();
		const to = target === 'new' ? addFloor(`${from.name} copy`) : getFloor(target);
		if (!to) return;

		if (copyPlan) {
			to.floorplanUrl = from.floorplanUrl;
			to.floorplanScale = from.floorplanScale;
			to.floorplanOffsetX = from.floorplanOffsetX;
			to.floorplanOffsetY = from.floorplanOffsetY;
			to.calibration = clone(from.calibration);
			to.floorplanBoundary = clone(from.floorplanBoundary);
		}
		if (copyWalls) {
			to.walls = clone(from.walls ?? []);
			to.columns = clone(from.columns ?? []);
			to.wallMask = clone(from.wallMask);
			to.materialMask = clone(from.materialMask);
			to.roomTypeMask = clone(from.roomTypeMask);
			to.wallMaterial = from.wallMaterial;
			to.wallAttenuation = from.wallAttenuation;
			to.roomDensityOverrides = clone(from.roomDensityOverrides);
			to.roomCustomLabels = clone(from.roomCustomLabels);
		}
		if (copyPlanningArea) {
			to.planningArea = clone(from.planningArea);
		}
		if (copySurfaces) {
			to.surfaces = clone(from.surfaces ?? []);
		}
		if (copyNotes) {
			to.notes = clone(from.notes ?? []);
		}

		switchFloor(to.id);
		scheduleSave();
		open = false;
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if (open && e.key === 'Escape') open = false;
	}}
/>

{#if open}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_interactive_supports_focus -->
	<div
		class="overlay"
		role="dialog"
		aria-modal="true"
		aria-label={t('Copy floor layout')}
		onclick={(e) => {
			if (e.target === e.currentTarget) open = false;
		}}
		transition:fade={{ duration: motionDuration(120) }}
	>
		<div class="dialog" transition:fly={{ y: 8, duration: motionDuration(160), opacity: 0 }}>
			<h2 class="heading">{t('Copy floor layout')}</h2>
			<p class="hint">
				{t('Copies this floor’s layout to another floor. Access points are never copied.')}
			</p>

			<label class="field">
				<span class="field-label">{t('Target floor')}</span>
				<select class="target" bind:value={target}>
					{#each targets as floor}
						<option value={floor.id}>{floor.name}</option>
					{/each}
					<option value="new">{t('New floor')}</option>
				</select>
			</label>

			<div class="checks">
				<label><input type="checkbox" bind:checked={copyPlan} /> {t('Plan and scale')}</label>
				<label><input type="checkbox" bind:checked={copyWalls} /> {t('Walls, columns and rooms')}</label>
				<label><input type="checkbox" bind:checked={copyPlanningArea} /> {t('Planning area')}</label>
				<label><input type="checkbox" bind:checked={copySurfaces} /> {t('Raised surfaces')}</label>
				<label><input type="checkbox" bind:checked={copyNotes} /> {t('Notes')}</label>
			</div>

			<p class="hint">{t('Selected data on the target floor will be replaced.')}</p>

			<div class="actions">
				<Button variant="ghost" onclick={() => (open = false)}>{t('Cancel')}</Button>
				<Button variant="primary" disabled={!canCopy} onclick={handleCopy}>{t('Copy')}</Button>
			</div>
		</div>
	</div>
{/if}

<style>
	.overlay {
		position: fixed;
		inset: 0;
		background: rgba(var(--bg-primary-rgb, 10, 12, 16), 0.8);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: var(--z-modal, 1000);
	}

	.dialog {
		width: min(400px, calc(100vw - 32px));
		padding: var(--space-5, 20px);
		background: var(--bg-surface);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg, 8px);
		box-shadow: var(--shadow-xl, 0 20px 60px rgba(0, 0, 0, 0.5));
	}

	.heading {
		margin: 0 0 var(--space-2);
		font-size: var(--text-lg);
		color: var(--text-primary);
	}

	.hint {
		margin: 0 0 var(--space-3);
		color: var(--text-secondary);
		font-size: var(--text-xs);
		line-height: 1.5;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		margin-bottom: var(--space-3);
	}

	.field-label {
		font-size: var(--text-xs);
		color: var(--text-secondary);
	}

	.target {
		height: 30px;
		padding: 0 var(--space-2);
		color: var(--text-primary);
		background: var(--bg-primary);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
	}

	.checks {
		display: grid;
		gap: var(--space-2);
		margin-bottom: var(--space-3);
		color: var(--text-primary);
		font-size: var(--text-sm);
	}

	.checks label {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.checks input[type='checkbox'] {
		width: 15px;
		height: 15px;
		margin: 0;
		accent-color: var(--accent-primary);
		cursor: pointer;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2);
	}
</style>
