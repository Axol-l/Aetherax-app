<script lang="ts">
	import { appState } from '$state/app.svelte';
	import type { SidebarPanel } from '$state/app.svelte';
	import { canvasState } from '$state/canvas.svelte';
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
</script>

{#if appState.sidebarOpen}
	<aside class="sidebar" aria-label={t('Sidebar')}>
		<div class="tab-bar" role="tablist">
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
					<div class="scroll-panel"><ApEditor /></div>
				{:else}
					<ApList />
				{/if}
			{/if}
		</div>
		<!--
			The reading order below is the order the work is done in: import the plan, say
			what its area is, line the floors up — then place access points and, last, run
			the optimiser over them.

			Coverage and the optimiser used to be pinned *above* the panel content, which put
			"Optimize all floors" on screen before the floorplan had been imported at all:
			the primary action for step five was the first thing in the panel, and the step
			one control was somewhere below the fold. They sit under the content now, which
			also means they stay visible while the steps above them scroll — they are the
			last thing reached and the thing a run is watched from.

			Both are outside the panel content rather than inside a tab, for the reason they
			always were: the APs tab swaps ApList for ApEditor when an AP is selected, and
			that must not take the coverage readout, the placement mode or the optimiser with
			it.
		-->
		<CoveragePanel />
		<ApAdvicePanel />
	</aside>
{/if}

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
		display: flex;
		padding: 0 var(--space-2);
		background: var(--bg-secondary);
		border-bottom: 1px solid var(--border-subtle);
		flex-shrink: 0;
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
		border-bottom-color: var(--accent-primary);
	}

	.tab:focus-visible {
		outline: 2px solid var(--accent-primary);
		outline-offset: -2px;
	}

	.panel-content {
		flex: 1;
		overflow: hidden;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	.scroll-panel {
		flex: 1;
		overflow-y: auto;
		overflow-x: hidden;
		min-height: 0;
		padding: var(--space-4);
	}
</style>
