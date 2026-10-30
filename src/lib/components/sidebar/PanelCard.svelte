<script lang="ts">
	/**
	 * One card of the floorplan panel: a fold control, a title, an optional state line and a
	 * body.
	 *
	 * The cards used to repeat this head — outer border, chevron, icon, title, hidden state
	 * slot — in the parent, and their fold state was a `$state` per card in a 2 000-line
	 * script. The wrapper owns the shell so a card is its body: the markup, the fold state
	 * and the styles of what it shows.
	 *
	 * The state snippet is for the one state worth showing while it matters (the planning
	 * area being drawn); every other card's state line is hidden by the shared CSS.
	 */
	import type { Snippet } from 'svelte';
	import Icon from '$components/shared/Icon.svelte';
	import { t } from '$state/i18n.svelte';

	let {
		title,
		icon,
		collapsed = $bindable(false),
		state,
		children
	}: {
		title: string;
		icon: string;
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
			<Icon name={icon} size={13} />
			{title}
		</span>
		{#if state}{@render state()}{/if}
	</div>
	{#if !collapsed}
		{@render children()}
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
		font-size: var(--text-xs);
		font-weight: 500;
		color: var(--text-secondary);
	}

	/*
	 * The state line is the card's own markup, passed as a snippet: its styles therefore
	 * belong to the card that defines it, not here. The wrapper only lays the head out.
	 */

	/*
	 * A card's fold control: a chevron on the left of its title, pointing down when the card
	 * is open and right when it is folded.
	 */
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
