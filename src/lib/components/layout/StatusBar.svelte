<script lang="ts">
	import { wallState } from '$state/wall-state.svelte';
	import { canvasEngineRef, canvasState } from '$state/canvas.svelte';
	import { appState, type FloorView } from '$state/app.svelte';
	import { fitCanvasToContent } from '$canvas/fit.js';
	import Icon from '$components/shared/Icon.svelte';
	import { t } from '$state/i18n.svelte';

	/**
	 * Nothing here reports autosaves.
	 *
	 * The bar used to flash "Saved" two seconds after every edit, on the theory that the user
	 * likes to know. What it actually reported was the *autosave timer*: move an access point,
	 * "Saved"; scroll, "Saved" — noise that reads as the app doing expensive work (and every
	 * one of those writes serialises the masks). Autosave is silent by design; a save the user
	 * asked for (Ctrl+S, an export) answers in the corner notice, which is where an answer to
	 * a key press belongs.
	 */

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
	 *
	 * Re-frames on the way through: the views have nothing in common spatially, so
	 * keeping the camera would land on empty canvas either way.
	 */
	function setView(v: FloorView) {
		if (appState.floorView === v) return;
		appState.floorView = v;
		/*
		 * The 3D view opens at an angle, not head-on.
		 *
		 * A box seen at zero yaw is a rectangle: two of its four walls are exactly edge-on
		 * and vanish, which is correct geometry and a useless first impression — it reads as
		 * a flat plan with a thick border. The first look is therefore oblique, and only
		 * when the viewpoint is still the default, so an angle the user chose is never
		 * overwritten.
		 */
		if (v === 'floor3d' && appState.stackYaw === 0) {
			appState.stackYaw = 30;
		}
		// Frame on the next frame, not now.
		//
		// The overview layers are handed their floors by an effect, and `setFloors`
		// only runs while an overview is active — so at this moment `contentBounds()`
		// is still empty and the synchronous fit fell through to the floorplan/AP
		// bounds, framing one floor instead of the layout. That is what made the
		// first switch into the tiled view land at the wrong zoom, with the cards
		// half off-screen.
		requestAnimationFrame(() => handleFit());
	}
</script>

<footer class="status-bar">
	<div class="status-left">
		<span class="status-item zoom"
			>{canvasState.zoom === 1 ? '100' : Math.round(canvasState.zoom * 100)}%</span
		>
		<button class="zoom-btn" onclick={handleFit} aria-label={t('Fit to view')}>{t('Fit')}</button>
		<div class="view-switch" role="group" aria-label={t('Floor view')}>
			<button
				class="view-btn"
				class:active={appState.floorView === 'single'}
				aria-pressed={appState.floorView === 'single'}
				title={t('Show the current floor only')}
				onclick={() => setView('single')}
			>
				<Icon name="square" size={12} />
			</button>
			<button
				class="view-btn"
				class:active={appState.floorView === 'tiled'}
				aria-pressed={appState.floorView === 'tiled'}
				title={t('Tile every floor side by side. Click a floor to select it.')}
				onclick={() => setView('tiled')}
			>
				<Icon name="grid" size={12} />
			</button>
			<button
				class="view-btn"
				class:active={appState.floorView === 'stacked'}
				aria-pressed={appState.floorView === 'stacked'}
				title={t('Stack every floor by its height. Click a floor to select it.')}
				onclick={() => setView('stacked')}
			>
				<Icon name="stack" size={12} />
			</button>
			<button
				class="view-btn"
				class:active={appState.floorView === 'floor3d'}
				aria-pressed={appState.floorView === 'floor3d'}
				title={t('The current floor in 3D: walls at their real height, in their material colours. Drag to turn the view.')}
				onclick={() => setView('floor3d')}
			>
				<Icon name="cube" size={12} />
			</button>
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
