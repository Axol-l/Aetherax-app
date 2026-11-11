<script lang="ts">
	import { fade, fly } from 'svelte/transition';
	import Button from '$components/shared/Button.svelte';
	import Icon from '$components/shared/Icon.svelte';
	import { t } from '$state/i18n.svelte';
	import { motionDuration } from '$lib/motion.js';

	let {
		open = $bindable(false),
		title = 'Warning',
		message = ''
	}: {
		open: boolean;
		title?: string;
		message: string;
	} = $props();
</script>

<svelte:window
	onkeydown={(e) => {
		if (open && e.key === 'Escape') open = false;
	}}
/>

{#if open}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_interactive_supports_focus -->
	<div
		class="overlay"
		role="dialog"
		aria-modal="true"
		aria-label={title}
		onclick={(e) => {
			if (e.target === e.currentTarget) open = false;
		}}
		transition:fade={{ duration: motionDuration(120) }}
	>
		<div class="dialog" transition:fly={{ y: 8, duration: motionDuration(160), opacity: 0 }}>
			<div class="head">
				<Icon name="warning" size={15} />
				<h2>{title}</h2>
			</div>
			<p>{message}</p>
			<div class="actions">
				<Button variant="primary" onclick={() => (open = false)}>{t('OK')}</Button>
			</div>
		</div>
	</div>
{/if}

<style>
	.overlay {
		position: fixed;
		inset: 0;
		z-index: var(--z-modal, 1000);
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(var(--bg-primary-rgb, 10, 12, 16), 0.8);
	}

	.dialog {
		width: min(440px, calc(100vw - 32px));
		padding: var(--space-5, 20px);
		background: var(--bg-surface);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg, 8px);
		box-shadow: var(--shadow-xl, 0 20px 60px rgba(0, 0, 0, 0.5));
	}

	.head {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin-bottom: var(--space-3);
		color: var(--color-warning);
	}

	.head h2 {
		margin: 0;
		font-size: var(--text-lg);
		color: var(--text-primary);
	}

	p {
		margin: 0 0 var(--space-4);
		color: var(--text-secondary);
		font-size: var(--text-sm);
		line-height: 1.55;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
	}
</style>
