<script lang="ts">
	import { getFlatAttenuation, type WallMaterialId } from '$canvas/materials.js';
	import CanvasPopup from './CanvasPopup.svelte';
	import { t } from '$state/i18n.svelte';
	import { projectMeta } from '$state/project-meta.svelte';
	import { nextCustomMaterialId, allWallMaterials } from '$state/custom-materials.js';
	import { scheduleSave } from '$state/persistence.svelte.js';

	let {
		x,
		y,
		maxY,
		currentMaterial,
		onselect,
		onclose
	}: {
		x: number;
		y: number;
		maxY?: number;
		currentMaterial: WallMaterialId;
		onselect: (id: WallMaterialId) => void;
		onclose: () => void;
	} = $props();

	function handleSelect(id: WallMaterialId) {
		onselect(id);
		onclose();
	}

	/** Built-ins plus what the user has added, in one list. */
	const materials = $derived(allWallMaterials(projectMeta.customMaterials));

	let customOpen = $state(false);
	let customName = $state('');
	let customDb = $state('4');
	let customThickness = $state('0.045');

	/**
	 * Add the material and paint with it straight away.
	 *
	 * Selecting it is the whole reason the user typed it in: making them add it, then find
	 * it in the list and click it is a step nobody wants, and the new row is at the bottom
	 * where they would have to look for it.
	 */
	function addCustom() {
		const name = customName.trim();
		const db = Number(customDb);
		const thickness = Number(customThickness);
		if (!name || !Number.isFinite(db) || db < 0) return;
		if (!Number.isFinite(thickness) || thickness <= 0) return;
		const existing = projectMeta.customMaterials;
		const id = nextCustomMaterialId(existing);
		const palette = [
			[214, 122, 74],
			[122, 168, 214],
			[168, 122, 214],
			[122, 214, 150],
			[214, 196, 96],
			[196, 96, 150],
			[96, 196, 196],
			[150, 150, 160]
		] as const;
		projectMeta.customMaterials = [
			...existing,
			{
				id,
				name,
				dbPerCrossing: db,
				thicknessM: thickness,
				color: [...palette[existing.length % palette.length]!] as [number, number, number]
			}
		];
		scheduleSave();
		customOpen = false;
		customName = '';
		handleSelect(id as WallMaterialId);
	}
</script>

<CanvasPopup {x} {y} {maxY} {onclose} minWidth={150} maxWidth={180}>
	{#each materials as mat (mat.id)}
		{@const db = Number(getFlatAttenuation(mat.id).toFixed(1))}
		<button
			class="material-row"
			class:active={mat.id === currentMaterial}
			onclick={() => handleSelect(mat.id)}
		>
			<span
				class="swatch"
				style="background: rgb({mat.color[0]},{mat.color[1]},{mat.color[2]})"
			></span>
			<span class="mat-name">{t(mat.name)}</span>
			<span class="mat-db">{db} dB</span>
		</button>
	{/each}

	{#if customOpen}
		<!--
			A material the table does not have. Asked for the figure a datasheet states — the
			loss of one crossing at a stated thickness — because that is what a user can look
			up; the per-metre figure the model charges is derived from it.
		-->
		<div class="custom-form">
			<input class="custom-input" placeholder={t('Name')} bind:value={customName} />
			<div class="custom-row">
				<input
					class="custom-input small"
					type="number"
					step="0.1"
					min="0"
					placeholder="dB"
					bind:value={customDb}
				/>
				<input
					class="custom-input small"
					type="number"
					step="0.01"
					min="0.01"
					placeholder="m"
					bind:value={customThickness}
				/>
			</div>
			<div class="custom-actions">
				<button class="custom-add" onclick={addCustom}>{t('Add')}</button>
				<button class="custom-cancel" onclick={() => (customOpen = false)}>{t('Cancel')}</button>
			</div>
		</div>
	{:else}
		<button class="custom-open" onclick={() => (customOpen = true)}>
			+ {t('Custom material')}
		</button>
	{/if}
</CanvasPopup>

<style>
	.material-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-1) var(--space-2);
		border: none;
		background: none;
		border-radius: var(--radius-sm);
		cursor: pointer;
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		color: var(--text-primary);
		text-align: left;
		width: 100%;
	}

	.material-row:hover {
		background: var(--bg-hover);
	}

	.material-row.active {
		background: var(--accent-primary-glow);
	}

	.material-row:focus-visible {
		outline: 2px solid var(--accent-primary);
		outline-offset: 1px;
	}

	.swatch {
		width: 12px;
		height: 12px;
		border-radius: 2px;
		flex-shrink: 0;
	}

	.mat-name {
		flex: 1;
	}

	.mat-db {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		color: var(--text-tertiary);
	}

	/* Adding a material: a compact form, because it is a name and two numbers. */
	.custom-form {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		padding: var(--space-1) var(--space-2) var(--space-2);
		border-top: 1px solid var(--border-subtle);
	}

	.custom-row {
		display: flex;
		gap: var(--space-1);
	}

	.custom-input {
		min-width: 0;
		flex: 1 1 auto;
		padding: 2px var(--space-1);
		font-size: var(--text-xs);
		color: var(--text-primary);
		background: var(--bg-surface);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm);
	}

	.custom-input.small {
		flex: 0 0 46%;
	}

	.custom-actions {
		display: flex;
		gap: var(--space-2);
	}

	.custom-add,
	.custom-cancel,
	.custom-open {
		padding: 0;
		font-size: var(--text-xs);
		background: none;
		border: none;
		cursor: pointer;
	}

	.custom-add {
		color: var(--accent-primary);
	}

	.custom-cancel {
		color: var(--text-tertiary);
	}

	.custom-open {
		padding: var(--space-1) var(--space-2);
		color: var(--text-secondary);
		border-top: 1px solid var(--border-subtle);
		text-align: left;
	}

	.custom-open:hover {
		color: var(--text-primary);
	}
</style>
