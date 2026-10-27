<script lang="ts">
	import { getFlatAttenuation, type WallMaterialId } from '$canvas/materials.js';
	import CanvasPopup from './CanvasPopup.svelte';
	import Icon from '$components/shared/Icon.svelte';
	import { t } from '$state/i18n.svelte';
	import { projectMeta } from '$state/project-meta.svelte';
	import { nextCustomMaterialId, allWallMaterials, CUSTOM_MATERIAL_ID_BASE } from '$state/custom-materials.js';
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

	/**
	 * Delete one of the user's materials.
	 *
	 * Walls already painted with it stay painted and keep a real figure: the table answers an
	 * id it no longer knows with the plain-drywall cost, rather than with nothing, so a
	 * deletion cannot quietly make part of a plan transparent.
	 */
	function removeCustom(id: number) {
		projectMeta.customMaterials = projectMeta.customMaterials.filter(
			(material) => material.id !== id
		);
		scheduleSave();
	}
</script>

<CanvasPopup {x} {y} {maxY} {onclose} minWidth={150} maxWidth={180}>
	{#each materials as mat (mat.id)}
		{@const db = Number(getFlatAttenuation(mat.id).toFixed(1))}
		{@const custom = mat.id >= CUSTOM_MATERIAL_ID_BASE}
		<div class="material-line">
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
			{#if custom}
				<!--
					Deleting one of the user's own. Walls painted with it are left painted: the
					material table answers an id it no longer knows with the plain-drywall figure,
					so those walls keep a real attenuation instead of becoming transparent.
				-->
				<button
					class="custom-delete"
					title={t('Delete material')}
					aria-label={t('Delete material')}
					onclick={() => removeCustom(mat.id)}
				>
					<Icon name="trash" size={12} />
				</button>
			{/if}
		</div>
	{/each}

	{#if customOpen}
		<!--
			A material the table does not have. Two labelled fields rather than two bare boxes:
			"4" and "0.045" mean nothing without knowing that one is decibels and the other is
			metres, and the placeholder disappears the moment the field is filled.
		-->
		<div class="custom-form">
			<label class="custom-field">
				<span class="custom-label">{t('Name')}</span>
				<input class="custom-input" placeholder={t('e.g. Lead-lined door')} bind:value={customName} />
			</label>
			<label class="custom-field">
				<span class="custom-label">{t('Loss per crossing')}</span>
				<input
					class="custom-input"
					type="number"
					step="0.1"
					min="0"
					bind:value={customDb}
				/>
				<span class="custom-unit">dB</span>
			</label>
			<label class="custom-field">
				<span class="custom-label">{t('Thickness')}</span>
				<input
					class="custom-input"
					type="number"
					step="0.01"
					min="0.01"
					bind:value={customThickness}
				/>
				<span class="custom-unit">m</span>
			</label>
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

	/* A row and its delete affordance on one line: the × used to sit under the row in a
	   browser-default button box, which looked like a bug rather than a control. */
	.material-line {
		display: flex;
		align-items: center;
		gap: 2px;
	}

	.material-line .material-row {
		flex: 1 1 auto;
		min-width: 0;
	}

	.custom-delete {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		padding: 0;
		color: var(--text-tertiary);
		background: none;
		border: none;
		border-radius: var(--radius-sm);
		cursor: pointer;
		opacity: 0.55;
	}

	.material-line:hover .custom-delete {
		opacity: 1;
	}

	.custom-delete:hover {
		color: var(--color-warning, #ffb800);
		background: var(--bg-surface);
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

	.custom-field {
		display: flex;
		align-items: center;
		gap: var(--space-1);
	}

	.custom-label {
		flex: 0 0 44%;
		font-size: var(--text-xs);
		color: var(--text-tertiary);
	}

	.custom-unit {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		color: var(--text-tertiary);
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
