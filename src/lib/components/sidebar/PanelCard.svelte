<script lang="ts">
	/**
	 * One card of the floorplan panel: a fold control, a title, an optional state line and a
	 * body.
	 */
	import type { Snippet } from 'svelte';
	import { slide } from 'svelte/transition';
	import Icon from '$components/shared/Icon.svelte';
	import { t } from '$state/i18n.svelte';
	import { motionDuration } from '$lib/motion.js';

	let {
		title,
		collapsed = $bindable(false),
		state,
		children
	}: {
		title: string;
		collapsed?: boolean;
		state?: Snippet;
		children: Snippet;
	} = $props();
</script>

<div class="planning-area">
	<div class="planning-head">
		<button
			class="card-collapse"
			aria-expanded={!collapsed}
			title={collapsed ? t('Show the list') : t('Hide the list')}
			onclick={() => (collapsed = !collapsed)}
		>
			<Icon name="chevron-down" size={11} />
		</button>
		<span class="planning-title">
			{title}
		</span>
		{#if state}{@render state()}{/if}
	</div>
	{#if !collapsed}
		<div class="card-body" transition:slide={{ duration: motionDuration(180) }}>
			{@render children()}
		</div>
	{/if}
</div>

<style>
	.planning-area {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-3);
		background: var(--bg-elevated);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm);
	}

	.card-body {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.planning-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-2);
	}

	.planning-title {
		flex: 1;
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		font-size: var(--text-sm);
		font-weight: 500;
		color: var(--text-secondary);
	}

	.card-collapse {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		padding: 0;
		color: var(--text-tertiary);
		background: transparent;
		border: none;
		border-radius: var(--radius-sm);
		cursor: pointer;
		transition: transform var(--transition-fast);
	}

	.card-collapse[aria-expanded='false'] {
		transform: rotate(-90deg);
	}

	.card-collapse:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}
</style>
