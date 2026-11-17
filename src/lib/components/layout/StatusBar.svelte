<script lang="ts">
	import { wallState } from '$state/wall-state.svelte';
	import { canvasEngineRef, canvasState } from '$state/canvas.svelte';
	import { appState, type FloorView } from '$state/app.svelte';
	import { fitCanvasToContent } from '$canvas/fit.js';
	import { viewTransition } from '$state/view-transition.svelte.js';
	import Icon from '$components/shared/Icon.svelte';
	import Tooltip from '$components/shared/Tooltip.svelte';
	import { t } from '$state/i18n.svelte';

	function handleFit() {
		const engine = canvasEngineRef.engine;
		if (!engine) return;
		// One implementation, shared with the PDF export, which has to frame each page the
		// same way before it screenshots it.
		if (!fitCanvasToContent(engine)) engine.camera.reset();
		engine.markDirty();
	}

	function handleReset() {
		const engine = canvasEngineRef.engine;
		if (!engine) return;
		engine.camera.reset();
		engine.markDirty();
	}

	/**
	 * Switch between the single-floor view and the two overviews.
	 */
	function setView(v: FloorView) {
		if (appState.floorView === v || viewTransition.active) return;
		void viewTransition.run(() => {
			appState.floorView = v;
			/*
			 * The 3D view opens at an angle, not head-on.
			 */
			if (v === 'floor3d' && appState.stackYaw === 0) {
				appState.stackYaw = 30;
			}
			// Frame on the next frame, not now.
			requestAnimationFrame(() => handleFit());
		});
	}
</script>

<footer class="status-bar">
	<div class="status-left">
		<span class="status-item zoom"
			>{canvasState.zoom === 1 ? '100' : Math.round(canvasState.zoom * 100)}%</span
		>
		<button class="zoom-btn" onclick={handleFit} aria-label={t('Fit to view')}>{t('Fit')}</button>
		<div class="view-switch" role="group" aria-label={t('Floor view')}>
			<Tooltip text={t('Show the current floor only')} position="top">
				<button
					class="view-btn"
					class:active={appState.floorView === 'single'}
					aria-pressed={appState.floorView === 'single'}
					aria-label={t('Show the current floor only')}
					disabled={viewTransition.active}
					onclick={() => setView('single')}
				>
					<Icon name="square" size={12} />
				</button>
			</Tooltip>
			<Tooltip text={t('Tile every floor side by side. Click a floor to select it.')} position="top">
				<button
					class="view-btn"
					class:active={appState.floorView === 'tiled'}
					aria-pressed={appState.floorView === 'tiled'}
					aria-label={t('Tile every floor side by side. Click a floor to select it.')}
					disabled={viewTransition.active}
					onclick={() => setView('tiled')}
				>
					<Icon name="grid" size={12} />
				</button>
			</Tooltip>
			<Tooltip text={t('Stack every floor by its height. Click a floor to select it.')} position="top">
				<button
					class="view-btn"
					class:active={appState.floorView === 'stacked'}
					aria-pressed={appState.floorView === 'stacked'}
					aria-label={t('Stack every floor by its height. Click a floor to select it.')}
					disabled={viewTransition.active}
					onclick={() => setView('stacked')}
				>
					<Icon name="stack" size={12} />
				</button>
			</Tooltip>
			<Tooltip
				text={t('The current floor in 3D: walls at their real height, in their material colours. Drag to turn the view.')}
				position="top"
			>
				<button
					class="view-btn"
					class:active={appState.floorView === 'floor3d'}
					aria-pressed={appState.floorView === 'floor3d'}
					aria-label={t('The current floor in 3D: walls at their real height, in their material colours. Drag to turn the view.')}
					disabled={viewTransition.active}
					onclick={() => setView('floor3d')}
				>
					<Icon name="cube" size={12} />
				</button>
			</Tooltip>
		</div>
	</div>
	<div class="status-right"></div>
</footer>

<style>
	.status-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 24px;
		padding: 0 var(--space-3);
		background: var(--bg-secondary);
		border-top: 1px solid var(--border-subtle);
	}

	.status-left {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.status-right {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 80px;
		justify-content: flex-end;
	}

	.status-item {
		font-size: var(--text-xs);
		color: var(--text-tertiary);
	}

	.zoom {
		font-family: var(--font-mono);
		min-width: 32px;
	}

	.zoom-btn {
		font-size: var(--text-xs);
		color: var(--text-tertiary);
		background: none;
		border: 1px solid var(--border-subtle);
		border-radius: 3px;
		padding: 0 4px;
		cursor: pointer;
		line-height: 16px;
		transition: all var(--transition-fast);
	}

	.zoom-btn:hover {
		color: var(--text-secondary);
		background: var(--bg-hover);
	}

	.view-switch {
		display: flex;
		align-items: center;
		gap: 2px;
		margin-left: 4px;
	}

	.view-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 16px;
		padding: 0;
		color: var(--text-tertiary);
		background: none;
		border: 1px solid transparent;
		border-radius: 3px;
		cursor: pointer;
		transition: all var(--transition-fast);
	}

	.view-btn:hover {
		color: var(--text-secondary);
		background: var(--bg-hover);
	}

	.view-btn.active {
		color: var(--accent-primary);
		border-color: var(--accent-primary);
		background: var(--accent-primary-glow);
	}

	.view-btn:focus-visible {
		outline: 2px solid var(--accent-primary);
		outline-offset: 1px;
	}
</style>
