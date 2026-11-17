<script lang="ts">
	/**
	 * The corner notice: placement warnings, where the plan is.
	 */
	import { fly } from 'svelte/transition';
	import { appState } from '$state/app.svelte';
	import { t } from '$state/i18n.svelte';
	import Icon from '$components/shared/Icon.svelte';
	import { motionDuration } from '$lib/motion.js';

	/**
	 * Put the notice away.
	 */
	function dismiss(): void {
		if (appState.storageNotice) appState.storageNotice = null;
		else if (appState.placementNotice) appState.placementNotice = null;
		else if (appState.outsideNotice) appState.outsideNotice = null;
		else if (appState.columnNotice) appState.columnNotice = null;
		else appState.staleSettingsNotice = null;
	}

	const text = $derived(
		appState.storageNotice ??
			appState.placementNotice ??
			appState.columnNotice ??
			appState.outsideNotice ??
			appState.staleSettingsNotice
	);
	const saved = $derived(appState.savedNotice);
	const walls = $derived(appState.wallNotice);
</script>

{#if text}
	<div
		class="notice"
		role="status"
		aria-live="polite"
		transition:fly={{ y: 6, duration: motionDuration(160), opacity: 0 }}
	>
		<Icon name="warning" size={16} />
		<p>{text}</p>
		<button class="dismiss" title={t('Dismiss')} aria-label={t('Dismiss')} onclick={dismiss}>
			<Icon name="x" size={12} />
		</button>
	</div>
{/if}

{#if walls}
	<div
		class="notice saved"
		class:stacked={text !== null || saved !== null}
		role="status"
		aria-live="polite"
		transition:fly={{ y: 6, duration: motionDuration(160), opacity: 0 }}
	>
		<Icon name="check" size={13} />
		<p>{walls}</p>
	</div>
{/if}

{#if saved}
	<div
		class="notice saved"
		class:stacked={text !== null}
		role="status"
		aria-live="polite"
		transition:fly={{ y: 6, duration: motionDuration(160), opacity: 0 }}
	>
		<Icon name="check" size={13} />
		<p>{saved}</p>
	</div>
{/if}

<style>
	.notice {
		/* Absolute inside the canvas area: the canvas shrinks when the sidebar opens,
		   and the notice moves with it rather than landing under the panel. */
		position: absolute;
		right: var(--space-4);
		bottom: var(--space-4);
		/* Over the canvas and the toolbar, under a dialog: it must not cover a modal. */
		z-index: 90;
		display: flex;
		gap: var(--space-2);
		align-items: flex-start;
		max-width: min(380px, calc(100vw - 2 * var(--space-4)));
		padding: var(--space-3);
		color: var(--color-warning);
		background: var(--bg-elevated);
		border: 1px solid var(--border-default);
		border-left: 3px solid var(--color-warning);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-lg);
		pointer-events: none;
	}

	.notice p {
		font-size: var(--text-xs);
		line-height: 1.55;
		/* The message carries names of access points, so it can be long. */
		color: var(--text-primary);
	}

	/*
	 * A long message shrinks every flex item, and the icon was being squeezed to half its
	 * width while its height stayed 16 — which is why it read as a tiny triangle.
	 */
	.notice :global(svg) {
		flex: 0 0 auto;
	}

	.dismiss {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
		margin: -2px -2px 0 auto;
		padding: 0;
		flex: none;
		color: var(--text-tertiary);
		background: transparent;
		border: none;
		border-radius: var(--radius-sm);
		cursor: pointer;
		pointer-events: auto;
	}

	.dismiss:hover {
		color: var(--text-primary);
		background: var(--bg-hover);
	}

	/* A save is good news: the icon and the edge say so before the words are read. */
	.notice.saved {
		color: var(--color-success, #4ade80);
		border-left-color: var(--color-success, #4ade80);
		/* One short line, not a wrapped paragraph of prose: centred against the tick
		   rather than hung from the top of a tall box. */
		align-items: center;
	}

	.notice.saved p {
		font-size: var(--text-sm);
		line-height: 1.4;
	}

	/* Above the warning when both are up, so neither hides the other. */
	.notice.stacked {
		bottom: calc(var(--space-4) + 46px);
	}
</style>
