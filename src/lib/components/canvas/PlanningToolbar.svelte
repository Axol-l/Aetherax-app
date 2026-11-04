<script lang="ts">
	/**
	 * The planning-area tool's floating bar.
	 *
	 * Same strip as the wall and surface tools: what is being drawn, the actions that only
	 * make sense while it is being drawn, and a green action that ends the mode. The sidebar
	 * card can still close the loop, but drawing happens over the canvas 閳?reaching for the
	 * panel between two corners is the step this bar removes.
	 */
	import { fly } from 'svelte/transition';
	import { motionDuration } from '$lib/motion.js';
	import { t } from '$state/i18n.svelte';
	import Icon from '$components/shared/Icon.svelte';

	let {
		corners,
		onclose,
		onundo,
		oncancel
	}: {
		/** How many corners have been placed, for the enabled states. */
		corners: number;
		onclose: () => void;
		onundo: () => void;
		oncancel: () => void;
	} = $props();
</script>

<div
	class="planning-toolbar"
	role="toolbar"
	aria-label={t('Planning area')}
	transition:fly={{ y: -6, duration: motionDuration(150), opacity: 0 }}
>
	<span class="label">{t('Planning area')}</span>
	<span class="count">{corners}</span>
	<span class="divider"></span>
	<button class="tool" onclick={onundo} disabled={corners === 0}>{t('Undo corner')}</button>
	<button class="tool" onclick={oncancel}>{t('Cancel')}</button>
	{#if corners >= 3}
		<!--
			The confirm only exists once there is a polygon to confirm. Before the third
			corner the bar is "what you are drawing" and the way out; after it, the green
			action that closes the loop appears.
		-->
		<span class="divider"></span>
		<button class="done" onclick={onclose}>
			<Icon name="check" size={13} />
			{t('Confirm area')}
		</button>
	{/if}
</div>

<style>
	.planning-toolbar {
		position: absolute;
		top: var(--space-3, 12px);
		left: 50%;
		translate: -50% 0;
		display: flex;
		align-items: center;
		gap: 2px;
		padding: 4px 6px;
		background: var(--bg-elevated);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-lg);
		z-index: 30;
		max-width: calc(100% - 2 * var(--space-4, 16px));
	}

	.label {
		padding: 0 6px 0 4px;
		font-size: var(--text-xs);
		color: var(--text-secondary);
		white-space: nowrap;
	}

	.count {
		min-width: 16px;
		padding: 1px 5px;
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		text-align: center;
		color: var(--accent-primary);
		background: var(--accent-primary-glow);
		border-radius: 999px;
	}

	.divider {
		width: 1px;
		height: 18px;
		margin: 0 4px;
		background: var(--border-subtle);
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

	.tool:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.tool:disabled {
		opacity: 0.4;
		cursor: default;
	}

	/* The action that ends the mode, in the accent like the other tools' Done. */
	.done {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		height: 26px;
		padding: 0 10px;
		font-size: var(--text-xs);
		font-weight: 500;
		color: #0b0d12;
		background: var(--accent-primary);
		border: 1px solid var(--accent-primary);
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	.done:hover:not(:disabled) {
		background: color-mix(in srgb, var(--accent-primary) 85%, white);
	}

	.done:disabled {
		opacity: 0.45;
		cursor: default;
	}
</style>


