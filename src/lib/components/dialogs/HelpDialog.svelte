<script lang="ts">
	import { t } from '$state/i18n.svelte';
	let {
		open = $bindable(false)
	}: {
		open: boolean;
	} = $props();

	function handleOverlayClick(e: MouseEvent) {
		if (e.target === e.currentTarget) {
			open = false;
		}
	}

	function handleKeyDown(e: KeyboardEvent) {
		if (!open) return;
		if (e.key === 'Escape') {
			open = false;
		}
	}
</script>

<svelte:window onkeydown={handleKeyDown} />

<!--
	Short enough to be read once. Everything here is checked against the code it
	describes: the shortcut table against `CanvasView`'s key handler, the wall tools
	against `WallEditToolbar`, the settings against the popup in `CoveragePanel`, and
	the two interference readings against where they are actually printed (the
	optimiser's log line and the PDF cover, not the panel).

	`docs/MANUAL.zh-CN.md` is the long-form version and is the user's file — keep the
	two in step when the interface moves, and correct this one first if they disagree.
-->
{#if open}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_interactive_supports_focus -->
	<div
		class="overlay"
		role="dialog"
		aria-modal="true"
		aria-label={t('Help')}
		onclick={handleOverlayClick}
	>
		<div class="dialog">
			<div class="dialog-header">
				<h2 class="heading">{t('About Aetherax')}</h2>
				<button class="close-btn" onclick={() => { open = false; }} aria-label={t('Close')}>
					&times;
				</button>
			</div>

			<div class="dialog-body">
				<p class="intro">
					{t('Drop a floorplan, place APs, get optimal channels. Multi-floor, with physics-based propagation through walls and floor slabs.')}
				</p>

				<section class="section desktop-only">
					<h3 class="section-heading">{t('SHORTCUTS')}</h3>
					<div class="shortcuts">
						<div class="shortcut-row"><kbd>H</kbd><span>{t('Heatmap')}</span></div>
						<div class="shortcut-row"><kbd>G</kbd><span>{t('Grid')}</span></div>
						<div class="shortcut-row"><kbd>W</kbd><span>{t('Walls')}</span></div>
						<div class="shortcut-row"><kbd>{t('Ctrl/⌘+Z')}</kbd><span>{t('Undo')}</span></div>
						<div class="shortcut-row"
							><kbd>{t('Ctrl/⌘+Shift+Z')}</kbd><span>{t('Redo')}</span></div
						>
						<div class="shortcut-row"
							><kbd>{t('Delete')}</kbd><span>{t('Remove selected APs (Backspace too)')}</span></div
						>
						<div class="shortcut-row"><kbd>{t('Escape')}</kbd><span>{t('Leave place or align mode')}</span></div>
						<div class="shortcut-row"
							><kbd>{t('Shift')}</kbd><span>{t('Hold Shift to keep a new wall straight')}</span></div
						>
					</div>
				</section>

				<section class="section">
					<h3 class="section-heading">{t('GETTING STARTED')}</h3>
					<ul class="quick-start">
						<li>
							<strong>{t('Place APs')}</strong>
							{t('is a mode, off by default: turn it on (top of the sidebar), click the plan,')}
							<kbd>{t('Esc')}</kbd> {t('to leave.')}
							{t('A selected access point also has its mount height and its antenna — the beam width and where the beam points — drawn as a bar chart of what they do to the floor.')}
						</li>
						<li class="desktop-only">
							<strong>{t('Click a wall')}</strong> {t('for its material;')}
							<strong>{t('right-click a room')}</strong> {t('for its type and density.')}
						</li>
						<li class="mobile-only">{t('Tap a wall for its material; long-press a room for its type.')}</li>
						<li>
							<strong>{t('Draw wall')}</strong> {t('is two clicks: the start and the end. Ends and sides snap,')}
							<kbd>{t('Shift')}</kbd> {t('holds it straight, and')}
							<strong>{t('Delete')}</strong> {t('removes the selected one. The mask, the interior and the coverage are derived from the walls you draw.')}
						</li>
						<li>
							<strong>{t('Detect Walls')}</strong> {t('turns the imported plan into a wall mask;')}
							<strong>{t('Re-detect')}</strong> {t('replaces it and clears every material you painted, so it asks first.')}
						</li>
						<li>
							<strong>{t('Add floors')}</strong> {t('in the Floorplan tab. The status bar holds zoom,')}
							<em>{t('Fit')}</em> {t('and the single / tiled / stacked / 3D views.')}
						</li>
						<li>
							<strong>{t('Optimize placement')}</strong> {t('works on the floor on screen;')}
							<strong>{t('Optimize all floors')}</strong> {t('does every storey and moves the building figure;')}
							<strong>{t('Export PDF')}</strong> {t('writes the report.')}
						</li>
					</ul>
				</section>

				<section class="section">
					<h3 class="section-heading">{t('SETTINGS')}</h3>
					<p class="credit">
						{t('Behind the gear next to')} <em>{t('Placement optimiser')}</em>: <strong>{t('Interference')}</strong>
						{t('(how much co-channel is traded against coverage; 0 scores coverage alone) ·')}
						<strong>{t('Min coverage')}</strong> {t('(ε-constraint: the result must cover at least this much; 0 = off) ·')}
						<strong>{t('Restarts')}</strong> {t('(how many seeds to try, best kept) ·')}
						<strong>{t('Min signal')}</strong> {t('(heatmap floor; below it stays transparent) ·')}
						<strong>{t('Client height')}</strong> {t('and')} <strong>{t('Allow APs outside rooms')}</strong>.
					</p>
				</section>
			</div>
		</div>
	</div>
{/if}

<style>
	.overlay {
		position: fixed;
		inset: 0;
		background: rgba(10, 12, 18, 0.8);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 9999;
	}

	.dialog {
		background: var(--bg-surface);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg, 8px);
		max-width: 520px;
		width: 90%;
		max-height: 80vh;
		display: flex;
		flex-direction: column;
		box-shadow: var(--shadow-lg);
	}

	.dialog-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-5, 20px) var(--space-5, 20px) 0;
	}

	.heading {
		margin: 0;
		font-family: var(--font-sans);
		font-size: var(--text-lg, 18px);
		font-weight: 600;
		color: var(--text-primary);
	}

	.close-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border: none;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text-tertiary);
		font-size: var(--text-xl);
		cursor: pointer;
		transition: all var(--transition-fast);
	}

	.close-btn:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.dialog-body {
		padding: var(--space-5, 20px);
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: var(--space-5, 20px);
	}

	.intro {
		margin: 0;
		font-size: var(--text-base);
		color: var(--text-secondary);
		line-height: 1.5;
	}

	.section {
		display: flex;
		flex-direction: column;
		gap: var(--space-2, 8px);
	}

	.section-heading {
		margin: 0;
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		font-weight: 600;
		color: var(--text-tertiary);
		letter-spacing: 0.08em;
	}

	.quick-start {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-1, 4px);
	}

	.quick-start li {
		font-size: var(--text-sm);
		color: var(--text-secondary);
		line-height: 1.6;
	}

	.quick-start li::before {
		content: '-';
		margin-right: var(--space-2, 8px);
		color: var(--text-tertiary);
	}

	kbd {
		display: inline-block;
		padding: 1px 6px;
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		color: var(--text-primary);
		background: var(--bg-primary);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		line-height: 1.6;
	}

	.shortcut-note {
		margin: var(--space-2) 0 0;
		font-size: var(--text-xs);
		line-height: 1.5;
		color: var(--text-tertiary);
	}
	.shortcuts {
		display: flex;
		flex-direction: column;
		gap: var(--space-1, 4px);
	}

	.shortcut-row {
		display: flex;
		align-items: center;
		gap: var(--space-3, 12px);
	}

	.shortcut-row kbd {
		min-width: 100px;
		text-align: center;
	}

	.shortcut-row span {
		font-size: var(--text-sm);
		color: var(--text-secondary);
	}

	.footer-section {
		border-top: 1px solid var(--border-subtle);
		padding-top: var(--space-3, 12px);
	}

	.credit {
		font-size: var(--text-xs);
		color: var(--text-tertiary);
		margin: 0;
		line-height: 1.6;
	}

	.credit a {
		color: var(--accent-primary);
		text-decoration: none;
	}

	.credit a:hover {
		text-decoration: underline;
	}

	.mobile-only {
		display: none;
	}

	@media (max-width: 768px) {
		.desktop-only {
			display: none;
		}

		.mobile-only {
			display: list-item;
		}

		.dialog {
			max-width: 100%;
			max-height: 90vh;
			margin: 0 var(--space-3);
		}
	}
</style>
