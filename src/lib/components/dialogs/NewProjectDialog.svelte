<script lang="ts">
	import Button from '$components/shared/Button.svelte';
	
	import { clearHistory } from '$state/history.svelte';
	import { clearSavedState } from '$state/persistence.svelte';
	import { floorState } from '$state/floor-state.svelte';
	import { DEFAULT_COVERAGE_SOFTNESS_DB } from '../../rf/propagation.js';
	import { t } from '$state/i18n.svelte';
	import { floorplanState } from '$state/floorplan-state.svelte.js';
	import { projectMeta } from '$state/project-meta.svelte.js';
	import { apState } from '$state/ap-state.svelte.js';
	import { wallState } from '$state/wall-state.svelte.js';

	let {
		open = $bindable(false),
		onconfirm
	}: {
		open: boolean;
		onconfirm?: () => void;
	} = $props();

	let projectName = $state('Untitled Project');

	function handleConfirm() {
		if (floorplanState.floorplanUrl?.startsWith('blob:')) {
			URL.revokeObjectURL(floorplanState.floorplanUrl);
		}
		projectMeta.name = projectName;
		apState.band = '5ghz';
		apState.channelWidth = 20;
		apState.regulatoryDomain = 'fcc';
		apState.aps = [];
		floorplanState.floorplanUrl = null;
		floorplanState.floorplanScale = 0.4;
		wallState.wallMask = null;
		wallState.wallMaterial = 0;
		wallState.materialMask = null;
		wallState.roomTypeMask = null;
		floorplanState.calibration = null;
		floorplanState.floorplanBoundary = null;
		projectMeta.ispSpeed = 0;
		projectMeta.targetThroughput = 25;
		projectMeta.allowOutsideRooms = false;
		projectMeta.heatmapRssiFloor = -70;
		// Default weight of the co-channel interference term in the objective.
		projectMeta.interferenceWeight = 0.2;
		// And the objective's threshold softness, back to the shipped default.
		projectMeta.coverageSoftnessDb = DEFAULT_COVERAGE_SOFTNESS_DB;

		// Reset floor state to a single default floor
		const newFloorId = crypto.randomUUID();
		floorState.floors = [{
			id: newFloorId,
			name: 'Floor 1',
			level: 0,
			ceilingHeight: 3.0,
			floorThickness: 0.2,
			floorMaterial: 1,
			floorplanUrl: null,
			floorplanScale: 0.4,
			floorplanOffsetX: 0,
			floorplanOffsetY: 0,
			calibration: null,
			floorplanBoundary: null,
			wallMask: null,
			wallAttenuation: 5,
			wallMaterial: 0,
			materialMask: null,
			roomTypeMask: null,
			roomDensityOverrides: {},
			roomCustomLabels: {}
		}];
		floorState.currentFloorId = newFloorId;

		clearHistory();
		clearSavedState();

		open = false;
		onconfirm?.();
	}

	function handleCancel() {
		open = false;
	}

	function handleOverlayClick(e: MouseEvent) {
		if (e.target === e.currentTarget) {
			open = false;
		}
	}

	function handleKeyDown(e: KeyboardEvent) {
		if (!open) return;
		if (e.key === 'Escape') {
			open = false;
		} else if (e.key === 'Enter') {
			e.preventDefault();
			handleConfirm();
		}
	}

	$effect(() => {
		if (open) {
			projectName = 'Untitled Project';
		}
	});
</script>

<svelte:window onkeydown={handleKeyDown} />

{#if open}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_interactive_supports_focus -->
	<div
		class="overlay"
		role="dialog"
		aria-modal="true"
		aria-label={t('New Project')}
		onclick={handleOverlayClick}
	>
		<form class="dialog" onsubmit={(e) => { e.preventDefault(); handleConfirm(); }}>
			<h2 class="heading">{t('New Project')}</h2>
			<p class="warning">{t('This will clear the current layout.')}</p>

			<label class="field">
				<span class="field-label">{t('Project name')}</span>
				<input
					type="text"
					class="field-input"
					bind:value={projectName}
					placeholder={t('Untitled Project')}
				/>
			</label>

			<div class="actions">
				<Button variant="ghost" onclick={handleCancel}>{t('Cancel')}</Button>
				<button class="submit-btn" type="submit">{t('Create')}</button>
			</div>
		</form>
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
		z-index: 9999;
	}

	.dialog {
		background: var(--bg-surface);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg, 8px);
		padding: var(--space-5, 20px);
		max-width: 400px;
		width: 90%;
		display: flex;
		flex-direction: column;
		gap: var(--space-3, 12px);
	}

	.heading {
		margin: 0;
		font-family: var(--font-sans);
		font-size: var(--text-lg, 18px);
		font-weight: 600;
		color: var(--text-primary);
	}

	.warning {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--text-tertiary);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--space-1, 4px);
	}

	.field-label {
		font-size: var(--text-sm);
		color: var(--text-secondary);
	}

	.field-input {
		background: var(--bg-primary);
		color: var(--text-primary);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		padding: var(--space-1) var(--space-2);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		height: 32px;
	}

	.field-input:focus {
		outline: none;
		border-color: var(--accent-primary);
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2, 8px);
		margin-top: var(--space-2, 8px);
	}

	.submit-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		height: 32px;
		padding: 0 14px;
		background: var(--accent-primary);
		color: var(--bg-primary);
		border: 1px solid var(--accent-primary);
		border-radius: var(--radius-md);
		font-family: var(--font-sans);
		font-size: var(--text-base);
		font-weight: 500;
		cursor: pointer;
		transition: all var(--transition-fast);
		white-space: nowrap;
		line-height: 1;
	}

	.submit-btn:hover {
		background: color-mix(in srgb, var(--accent-primary) 85%, white);
		border-color: color-mix(in srgb, var(--accent-primary) 85%, white);
	}

	.submit-btn:focus-visible {
		outline: 2px solid var(--accent-primary);
		outline-offset: 1px;
	}
</style>
