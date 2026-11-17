<script lang="ts">
	import { appState } from '$state/app.svelte';
	import type { SidebarPanel } from '$state/app.svelte';
	import { canvasState } from '$state/canvas.svelte';
	import { fly } from 'svelte/transition';
	import { motionDuration } from '$lib/motion.js';
	import ApList from '$components/sidebar/ApList.svelte';
	import ApEditor from '$components/sidebar/ApEditor.svelte';
	import CoveragePanel from '$components/sidebar/CoveragePanel.svelte';
	import ApAdvicePanel from '$components/sidebar/ApAdvicePanel.svelte';
	import FloorplanControls from '$components/sidebar/FloorplanControls.svelte';
	import { t } from '$state/i18n.svelte';

	const tabs = $derived<Array<{ id: SidebarPanel; label: string }>>([
		{ id: 'floorplan', label: t('Floorplan') },
		{ id: 'aps', label: t('APs') }
	]);

	let hasSelection = $derived(canvasState.selectedApIds.length > 0);
	let activeTabIndex = $derived(Math.max(0, tabs.findIndex((tab) => tab.id === appState.sidebarPanel)));
</script>

<aside class="sidebar" aria-label={t('Sidebar')}>
	<div class="tab-bar" role="tablist">
		<span
			class="tab-indicator"
			style:transform={`translateX(${activeTabIndex * 100}%)`}
			aria-hidden="true"
		></span>
		{#each tabs as tab}
			<button
				class="tab"
				class:active={appState.sidebarPanel === tab.id}
				role="tab"
				aria-selected={appState.sidebarPanel === tab.id}
				onclick={() => { appState.sidebarPanel = tab.id; }}
			>
				{tab.label}
			</button>
		{/each}
	</div>
	<div class="panel-content">
		{#if appState.sidebarPanel === 'floorplan'}
			<div class="scroll-panel"><FloorplanControls /></div>
		{:else if appState.sidebarPanel === 'aps'}
			{#if hasSelection}
				<div
					class="panel-view"
					in:fly={{ x: 18, duration: motionDuration(180) }}
					out:fly={{ x: 18, duration: motionDuration(140) }}
				>
					<div class="scroll-panel"><ApEditor /></div>
				</div>
			{:else}
				<div
					class="panel-view"
					in:fly={{ x: -18, duration: motionDuration(180) }}
					out:fly={{ x: -18, duration: motionDuration(140) }}
				>
					<ApList />
				</div>
			{/if}
		{/if}
	</div>
	<CoveragePanel />
	<ApAdvicePanel />
</aside>

<style>
	.sidebar {
		width: 320px;
		height: 100%;
		display: flex;
		flex-direction: column;
		background: var(--bg-secondary);
		border-left: 1px solid var(--border-subtle);
		z-index: var(--z-sidebar);
		overflow: hidden;
		min-height: 0;
	}

	.tab-bar {
		position: relative;
		display: flex;
		padding: 0 var(--space-2);
		background: var(--bg-secondary);
		border-bottom: 1px solid var(--border-subtle);
		flex-shrink: 0;
	}

	.tab-indicator {
		position: absolute;
		left: var(--space-2);
		bottom: 0;
		width: calc(50% - var(--space-2));
		height: 2px;
		background: var(--accent-primary);
		border-radius: 2px;
		pointer-events: none;
		transition: transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
	}

	@media (prefers-reduced-motion: reduce) {
		.tab-indicator {
			transition: none;
		}
	}

	.tab {
		flex: 1;
		padding: var(--space-2) var(--space-2);
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		color: var(--text-tertiary);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		font-weight: 500;
		cursor: pointer;
		transition: all var(--transition-fast);
		text-align: center;
	}

	.tab:hover {
		color: var(--text-secondary);
	}

	.tab.active {
		color: var(--text-primary);
	}

	.tab:focus-visible {
		outline: 2px solid var(--accent-primary);
		outline-offset: -2px;
	}

	.panel-content {
		position: relative;
		flex: 1;
		overflow: hidden;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	/*
	 * The AP list and the AP editor slide past each other. They overlap while doing so, so
	 * they are taken out of the column; otherwise both would split the height.
	 */
	.panel-view {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		min-height: 0;
	}

	.scroll-panel {
		flex: 1;
		overflow-y: auto;
		overflow-x: hidden;
		min-height: 0;
		padding: var(--space-4);
	}
</style>
