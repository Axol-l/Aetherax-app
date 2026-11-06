<script lang="ts">
	import { fly } from 'svelte/transition';
	import { motionDuration } from '$lib/motion.js';
	import { t } from '$state/i18n.svelte';
	import { getMaterial, type WallMaterialId } from '$lib/domain/materials.js';
	import { allWallMaterials } from '$state/custom-materials.js';
	import { projectMeta } from '$state/project-meta.svelte';
	import Icon from '$components/shared/Icon.svelte';

	let {
		tool,
		material,
		ontool,
		onmaterial,
		onclear,
		canClear,
		ondone
	}: {
		tool: 'line' | 'rect' | 'circle' | 'eraser';
		material: WallMaterialId;
		ontool: (tool: 'line' | 'rect' | 'circle' | 'eraser') => void;
		onmaterial: (event: MouseEvent) => void;
		/** Remove every drawn wall on the floor. Undoable, like any other wall edit. */
		onclear: () => void;
		canClear: boolean;
		ondone: () => void;
	} = $props();

	const chips = $derived(allWallMaterials(projectMeta.customMaterials));
	const current = $derived(getMaterial(material));

	const tools = $derived<Array<{ id: 'line' | 'rect' | 'circle' | 'eraser'; label: string }>>([
		{ id: 'line', label: t('Walls') },
		{ id: 'rect', label: t('Columns') },
		{ id: 'circle', label: t('Columns') }
	]);
</script>

<div
	class="wall-toolbar"
	role="toolbar"
	aria-label={t('Wall tools')}
	transition:fly={{ y: -6, duration: motionDuration(150), opacity: 0 }}
>
	<div class="tool-group">
		<!-- Two things a plan is made of: walls, and the columns that break them. -->
		<button
			class="tool"
			class:active={tool === 'line'}
			aria-pressed={tool === 'line'}
			onclick={() => ontool('line')}
		>
			<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
				<path d="M2 13L14 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
			</svg>
			{t('Walls')}
		</button>
		<button
			class="tool"
			class:active={tool !== 'line' && tool !== 'eraser'}
			aria-pressed={tool !== 'line' && tool !== 'eraser'}
			onclick={() => ontool(tool === 'rect' || tool === 'circle' ? tool : 'rect')}
		>
			<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
				<rect x="3" y="3" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1.5" />
			</svg>
			{t('Columns')}
		</button>
		<!-- The eraser: strokes over the drawing, removing what they pass. -->
		<button
			class="tool"
			class:active={tool === 'eraser'}
			aria-pressed={tool === 'eraser'}
			onclick={() => ontool('eraser')}
		>
			<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
				<path d="M2 11l6.5-6.5 3.5 3.5L5.5 14.5H2zM9 2.5L13.5 7" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" fill="none" />
			</svg>
			{t('Erase')}
		</button>
		<!-- The column's geometry, only while the column tool is the one in use. -->
		{#if tool === 'rect' || tool === 'circle'}
			<span class="shapes" role="group" aria-label={t('Column shape')}>
				<button
					class="shape"
					class:active={tool === 'rect'}
					aria-pressed={tool === 'rect'}
					title={t('Rectangle')}
					onclick={() => ontool('rect')}
				>
					<svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
						<rect x="2.5" y="3.5" width="11" height="9" fill="none" stroke="currentColor" stroke-width="1.5" />
					</svg>
				</button>
				<button
					class="shape"
					class:active={tool === 'circle'}
					aria-pressed={tool === 'circle'}
					title={t('Circle')}
					onclick={() => ontool('circle')}
				>
					<svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
						<circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.5" />
					</svg>
				</button>
			</span>
		{/if}
	</div>

	<button class="material" onclick={onmaterial} title={t('Material for the next wall or column')}>
		<span class="swatch" style="background: rgb({current.color[0]},{current.color[1]},{current.color[2]})"
		></span>
		<span class="material-name">{t(current.name) || current.name}</span>
	</button>

	<button
		class="clear"
		title={t('Clear walls')}
		aria-label={t('Clear walls')}
		disabled={!canClear}
		onclick={onclear}
	>
		<Icon name="trash" size={13} />
	</button>

	<button class="done" onclick={ondone}>
		<Icon name="check" size={13} />
		{t('Done')}
	</button>
</div>

<style>
	.wall-toolbar {
		position: absolute;
		top: var(--space-3, 12px);
		left: 50%;
		translate: -50% 0;
		display: flex;
		align-items: center;
		gap: 0;
		padding: 4px 6px;
		background: var(--bg-elevated);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-lg);
		z-index: 30;
		max-width: calc(100% - 2 * var(--space-4, 16px));
	}

	.tool-group {
		display: flex;
		gap: 2px;
	}

	.tool {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		height: 26px;
		padding: 0 8px;
		font-size: var(--text-xs);
		color: var(--text-secondary);
		background: transparent;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	.tool:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.tool.active {
		background: var(--accent-primary);
		color: #0b0d12;
	}

	.divider {
		width: 1px;
		height: 18px;
		background: var(--border-subtle);
	}

	.shapes {
		display: inline-flex;
		gap: 2px;
		margin-left: 2px;
		padding-left: 4px;
		border-left: 1px solid var(--border-subtle);
	}

	.shape {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		color: var(--text-secondary);
		background: transparent;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	.shape:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.shape.active {
		border-color: var(--accent-primary);
		color: var(--accent-primary);
	}

	.material {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 26px;
		margin-left: 6px;
		padding: 0 8px;
		font-size: var(--text-xs);
		color: var(--text-primary);
		background: var(--bg-surface);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	.material:hover {
		background: var(--bg-hover);
	}

	/* The clear action sits with the material and Done: the wall card no longer owns it. */
	.clear {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		margin-left: 4px;
		color: var(--text-tertiary);
		background: transparent;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	.clear:hover:not(:disabled) {
		color: var(--danger, #ef4444);
		background: var(--bg-hover);
	}

	.clear:disabled {
		opacity: 0.35;
		cursor: default;
	}

	.swatch {
		width: 10px;
		height: 10px;
		border-radius: 2px;
		flex: none;
	}

	.material-name {
		white-space: nowrap;
	}

	.material-db {
		color: var(--text-secondary);
	}

	.done {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		height: 26px;
		margin-left: 4px;
		padding: 0 10px;
		font-size: var(--text-xs);
		font-weight: 500;
		color: #0b0d12;
		background: var(--accent-primary);
		border: 1px solid var(--accent-primary);
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	.done:hover {
		background: color-mix(in srgb, var(--accent-primary) 85%, white);
	}
</style>

