<script lang="ts">
	/**
	 * The placement tool's floating bar.
	 */
	import { fly } from 'svelte/transition';
	import { motionDuration } from '$lib/motion.js';
	import { t } from '$state/i18n.svelte';
	import { MOUNT_PRESETS, type ApMount } from '$state/ap-state.svelte.js';

	let {
		mount,
		lastMount,
		onmount,
		ondone
	}: {
		/** The mounting picked here, or null while the last AP's is still being followed. */
		mount: ApMount | null;
		/** The mounting the last placed AP has, shown as the inherited default. */
		lastMount: ApMount;
		onmount: (mount: ApMount) => void;
		ondone: () => void;
	} = $props();

	const active = $derived(mount ?? lastMount);
</script>

<div
	class="place-toolbar"
	role="toolbar"
	aria-label={t('Access point placement')}
	transition:fly={{ y: -6, duration: motionDuration(150), opacity: 0 }}
>
	<span class="label">{t('Mounting')}</span>
	<div class="tool-group">
		{#each MOUNT_PRESETS as preset (preset.mount)}
			<button
				class="tool"
				class:active={active === preset.mount}
				aria-pressed={active === preset.mount}
				onclick={() => onmount(preset.mount)}
			>
				{t(preset.label)}
			</button>
		{/each}
	</div>
	<span class="hint">
		{active === 'wall' ? t('Click within 1 m of a wall') : t('Click the plan to place')}
	</span>
	<span class="divider"></span>
	<button class="tool done" onclick={ondone}>{t('Done')}</button>
</div>

<style>
	.place-toolbar {
		position: absolute;
		top: var(--space-3, 12px);
		left: 50%;
		translate: -50% 0;
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 6px;
		background: var(--bg-elevated);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-lg);
		z-index: 30;
		max-width: calc(100% - 2 * var(--space-4, 16px));
	}

	.label {
		padding-left: 4px;
		font-size: var(--text-xs);
		color: var(--text-tertiary);
		white-space: nowrap;
	}

	.tool-group {
		display: flex;
		gap: 2px;
	}

	.tool {
		display: inline-flex;
		align-items: center;
		height: 26px;
		padding: 0 8px;
		font-size: var(--text-xs);
		color: var(--text-secondary);
		background: transparent;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		cursor: pointer;
		white-space: nowrap;
	}

	.tool:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.tool.active {
		background: var(--accent-primary);
		color: #0b0d12;
	}

	.hint {
		font-size: var(--text-xs);
		color: var(--text-tertiary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.divider {
		width: 1px;
		height: 18px;
		background: var(--border-subtle);
	}

	/* The one action that ends the mode: the accent, like the wall tool's Done. */
	.done {
		font-weight: 500;
		color: #0b0d12;
		background: var(--accent-primary);
		border-color: var(--accent-primary);
	}

	.done:hover {
		background: color-mix(in srgb, var(--accent-primary) 85%, white);
		color: #0b0d12;
	}
</style>

