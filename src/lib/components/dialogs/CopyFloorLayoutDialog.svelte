<script lang="ts">
	import { fade, fly, slide } from 'svelte/transition';
	import Button from '$components/shared/Button.svelte';
	import Icon from '$components/shared/Icon.svelte';
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
	let targetOpen = $state(false);
	/** Matches the target trigger's `aria-controls` to the listbox it opens. */
	const targetListId = $props.id();
	let copyPlan = $state(true);
	let copyWalls = $state(true);
	let copyPlanningArea = $state(true);
	let copySurfaces = $state(true);
	let copyNotes = $state(true);

	const source = $derived(getFloor(sourceId) ?? null);
	const targets = $derived(floorState.floors.filter((floor) => floor.id !== sourceId));
	const targetOptions = $derived([
		...targets.map((floor) => ({
			value: floor.id,
			label: floor.name,
			meta: `L${floor.level}`,
			isNew: false
		})),
		{ value: 'new', label: t('New floor'), meta: '+', isNew: true }
	]);
	const selectedTarget = $derived(
		targetOptions.find((option) => option.value === target) ?? targetOptions.at(-1)!
	);
	const canCopy = $derived(
		source !== null && (copyPlan || copyWalls || copyPlanningArea || copySurfaces || copyNotes)
	);

	$effect(() => {
		if (!open) return;
		target = targets[0]?.id ?? 'new';
		targetOpen = false;
	});

	function chooseTarget(value: string) {
		target = value;
		targetOpen = false;
	}

	function handleTargetKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.stopPropagation();
			targetOpen = false;
		} else if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			targetOpen = true;
		}
	}

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
		if (!open) return;
		if (e.key === 'Escape') {
			if (targetOpen) targetOpen = false;
			else open = false;
		}
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

			<div class="field">
				<span class="field-label">{t('Target floor')}</span>
				<button
					class="target-trigger no-press-scale"
					type="button"
					aria-haspopup="listbox"
					aria-expanded={targetOpen}
					aria-controls={targetListId}
					onclick={() => (targetOpen = !targetOpen)}
					onkeydown={handleTargetKeydown}
				>
					<span>{selectedTarget.label}</span>
					<Icon name="chevron-down" size={12} />
				</button>

				{#if targetOpen}
					<button
						class="target-backdrop"
						aria-label={t('Close')}
						onclick={() => (targetOpen = false)}
					></button>
					<div
						class="target-menu"
						id={targetListId}
						role="listbox"
						aria-label={t('Target floor')}
						transition:slide={{ duration: motionDuration(160) }}
					>
						{#each targetOptions as option (option.value)}
							<button
								class="target-row"
								class:active={option.value === target}
								role="option"
								aria-selected={option.value === target}
								onclick={() => chooseTarget(option.value)}
							>
								<span class="target-dot" class:new={option.isNew}></span>
								<span>{option.label}</span>
								<span class="target-meta">{option.meta}</span>
							</button>
						{/each}
					</div>
				{/if}
			</div>

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
		position: relative;
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		margin-bottom: var(--space-3);
	}

	.field-label {
		font-size: var(--text-xs);
		color: var(--text-secondary);
	}

	.target-trigger {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		width: 100%;
		height: 32px;
		padding: 0 var(--space-2);
		color: var(--text-primary);
		background: var(--bg-secondary);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		text-align: left;
		cursor: pointer;
	}

	.target-trigger:hover {
		border-color: var(--accent-primary-dim);
	}

	.target-trigger:focus-visible {
		outline: 2px solid var(--accent-primary);
		outline-offset: 1px;
	}

	.target-trigger :global(svg) {
		color: var(--text-tertiary);
		transition: transform var(--transition-fast);
	}

	.target-trigger[aria-expanded='true'] :global(svg) {
		transform: rotate(180deg);
	}

	/* Same shell as the wall-material popup: secondary surface, large radius, one-pixel gap. */
	.target-backdrop {
		position: fixed;
		inset: 0;
		z-index: 10;
		padding: 0;
		background: transparent;
		border: none;
	}

	.target-menu {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		right: 0;
		z-index: 11;
		max-height: 220px;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 1px;
		padding: var(--space-1);
		background: var(--bg-elevated);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-lg);
	}

	.target-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		width: 100%;
		padding: var(--space-1) var(--space-2);
		color: var(--text-primary);
		background: transparent;
		border: none;
		border-radius: var(--radius-sm);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		text-align: left;
		cursor: pointer;
	}

	.target-row:hover {
		background: var(--bg-hover);
	}

	.target-row.active {
		background: var(--accent-primary-glow);
	}

	.target-dot {
		width: 12px;
		height: 12px;
		flex: none;
		background: var(--border-strong);
		border-radius: 2px;
	}

	.target-row.active .target-dot {
		background: var(--accent-primary);
	}

	.target-dot.new {
		background: transparent;
		border: 1px dashed var(--border-strong);
	}

	.target-meta {
		margin-left: auto;
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		color: var(--text-tertiary);
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
