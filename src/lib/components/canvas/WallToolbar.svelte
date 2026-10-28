<script lang="ts">
	/**
	 * The wall tool's floating bar.
	 *
	 * Three shapes and a material, because that is what a plan is made of: partition walls,
	 * the piers that break them, and round columns. They share the same two-click gesture and
	 * the same material, so they are one tool with a shape switch — switching must not drop
	 * the mode, since a plan is drawn by alternating them.
	 *
	 * It floats over the canvas rather than living in the sidebar: the canvas is what the
	 * next click lands on, and a sidebar section you have to find while drawing is a step
	 * between the two clicks.
	 */
	import { t } from '$state/i18n.svelte';
	import { getMaterial, type WallMaterialId } from '$canvas/materials.js';
	import { allWallMaterials } from '$state/custom-materials.js';
	import { projectMeta } from '$state/project-meta.svelte';
	import Icon from '$components/shared/Icon.svelte';

	let {
		tool,
		material,
		ontool,
		onmaterial,
		ondone
	}: {
		tool: 'line' | 'rect' | 'circle';
		material: WallMaterialId;
		ontool: (tool: 'line' | 'rect' | 'circle') => void;
		onmaterial: (event: MouseEvent) => void;
		ondone: () => void;
	} = $props();

	const chips = $derived(allWallMaterials(projectMeta.customMaterials));
	const current = $derived(getMaterial(material));

	const tools = $derived<Array<{ id: 'line' | 'rect' | 'circle'; label: string }>>([
		{ id: 'line', label: t('Line') },
		{ id: 'rect', label: t('Rectangle') },
		{ id: 'circle', label: t('Circle') }
	]);
</script>

<div class="wall-toolbar" role="toolbar" aria-label={t('Wall tools')}>
	<div class="tool-group">
		{#each tools as option (option.id)}
			<button
				class="tool"
				class:active={tool === option.id}
				aria-pressed={tool === option.id}
				onclick={() => ontool(option.id)}
			>
				{#if option.id === 'line'}
					<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
						<path d="M2 13L14 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
					</svg>
				{:else if option.id === 'rect'}
					<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
						<rect
							x="2.5"
							y="3.5"
							width="11"
							height="9"
							fill="none"
							stroke="currentColor"
							stroke-width="1.5"
						/>
					</svg>
				{:else}
					<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
						<circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.5" />
					</svg>
				{/if}
				{option.label}
			</button>
		{/each}
	</div>

	<span class="divider"></span>

	<!--
		The material for whatever is drawn next. One button rather than a row of chips: the
		list includes the user's own materials and grows, and a row of eight in a floating bar
		is the sidebar this bar exists to avoid.
	-->
	<button class="material" onclick={onmaterial} title={t('Material for the next wall or column')}>
		<span class="swatch" style="background: rgb({current.color[0]},{current.color[1]},{current.color[2]})"
		></span>
		<span class="material-name">{t(current.name)}</span>
		<span class="material-db">{chips.length > 8 ? t('More…') : ''}</span>
	</button>

	<span class="divider"></span>

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
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		gap: var(--space-2, 8px);
		padding: 4px var(--space-2, 8px);
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

	.material {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 26px;
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

	.swatch {
		width: 10px;
		height: 10px;
		border-radius: 2px;
		flex: none;
	}

	.material-name {
		max-width: 96px;
		overflow: hidden;
		text-overflow: ellipsis;
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
		padding: 0 10px;
		font-size: var(--text-xs);
		color: var(--bg-primary);
		background: var(--accent-primary);
		border: none;
		border-radius: var(--radius-sm);
		cursor: pointer;
	}
</style>
