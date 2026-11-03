<script lang="ts">
	import { fade, fly } from 'svelte/transition';
	import { t } from '$state/i18n.svelte';
	import { motionDuration } from '$lib/motion.js';

	let {
		open = $bindable(false)
	}: {
		open: boolean;
	} = $props();

	function handleKeydown(e: KeyboardEvent): void {
		if (open && e.key === 'Escape') open = false;
	}
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_click_events_have_key_events -->
	<div
		class="overlay"
		role="dialog"
		aria-modal="true"
		aria-label={t('Aetherax 使用手册')}
		tabindex="-1"
		onkeydown={(e) => {
			if (e.key === 'Escape') open = false;
		}}
		onclick={(e) => {
			if (e.target === e.currentTarget) open = false;
		}}
		transition:fade={{ duration: motionDuration(120) }}
	>
		<div class="panel" transition:fly={{ y: 8, duration: motionDuration(160), opacity: 0 }}>
			<header class="panel-head">
				<span class="title">{t('Aetherax 使用手册')}</span>
				<button class="close" onclick={() => (open = false)} aria-label={t('Close')}>
					&times;
				</button>
			</header>
			<iframe
				id="help-manual-frame"
				title={t('Aetherax 使用手册')}
				src="/manual.html"
			></iframe>
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
		padding: 24px;
		background: rgba(4, 6, 10, 0.72);
	}

	.panel {
		display: flex;
		flex-direction: column;
		width: min(1100px, 96vw);
		height: min(860px, 92vh);
		overflow: hidden;
		background: #ffffff;
		border: 1px solid var(--border-default, #333a46);
		border-radius: var(--radius-md, 8px);
		box-shadow: 0 24px 80px rgba(0, 0, 0, 0.55);
	}

	.panel-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 14px;
		background: #f3f4f6;
		border-bottom: 1px solid #d1d5db;
	}

	.title {
		font-family: var(--font-sans);
		font-size: var(--text-base, 14px);
		font-weight: 600;
		color: #111827;
	}

	.close {
		width: 28px;
		height: 28px;
		padding: 0;
		border: 1px solid #d1d5db;
		border-radius: 6px;
		background: #ffffff;
		color: #374151;
		font-size: 18px;
		line-height: 1;
		cursor: pointer;
	}

	.close:hover {
		background: #e5e7eb;
	}

	iframe {
		flex: 1;
		width: 100%;
		border: 0;
		background: #ffffff;
	}
</style>
