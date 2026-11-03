<script lang="ts">
	import { onMount } from 'svelte';
	import { fade, fly } from 'svelte/transition';
	import Button from '$components/shared/Button.svelte';
	import { t } from '$state/i18n.svelte';
	import { motionDuration } from '$lib/motion.js';

	import { migrateLegacyStorageKeys, STORAGE_PREFIX } from '$state/persistence.svelte';

	const STORAGE_KEY = `${STORAGE_PREFIX}welcomed`;

	let open = $state(false);
	let dontShowAgain = $state(true);

	onMount(() => {
		// This dialog mounts before the app restores the project, so it runs the key
		// migration itself: otherwise a returning user is asked "seen this before?" again
		// and the answer is written over their own.
		migrateLegacyStorageKeys();
		if (localStorage.getItem(STORAGE_KEY)) return;
		setTimeout(() => {
			open = true;
		}, 500);
	});

	function handleGetStarted() {
		if (dontShowAgain) {
			localStorage.setItem(STORAGE_KEY, '1');
		}
		open = false;
	}

	function handleOverlayClick(e: MouseEvent) {
		if (e.target === e.currentTarget) {
			handleGetStarted();
		}
	}

	function handleKeyDown(e: KeyboardEvent) {
		if (!open) return;
		if (e.key === 'Escape' || e.key === 'Enter') {
			handleGetStarted();
		}
	}
</script>

<svelte:window onkeydown={handleKeyDown} />

{#if open}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_interactive_supports_focus -->
	<div
		class="overlay"
		role="dialog"
		aria-modal="true"
		aria-label="Welcome to Aetherax"
		onclick={handleOverlayClick}
		transition:fade={{ duration: motionDuration(120) }}
	>
		<div class="dialog" transition:fly={{ y: 10, duration: motionDuration(180), opacity: 0 }}>
			<div class="header">
				<!-- The app icon itself, so the dialog and the browser tab agree. -->
				<!-- The app icon itself, so the dialog and the browser tab agree. -->
				<!-- The app icon itself, so the dialog and the browser tab agree. -->
				<!-- The app icon itself, so the dialog and the browser tab agree. -->
				<svg class="favicon" width="56" height="56" viewBox="0 0 32 32" aria-hidden="true">
					<defs>
					<linearGradient id="ax-welcome" x1="0" y1="1" x2="0.35" y2="0">
							<stop offset="0" stop-color="#d9ff3d" />
							<stop offset="0.55" stop-color="#4be3a0" />
							<stop offset="1" stop-color="#00bfa6" />
					</linearGradient>
						<mask id="ax-welcome-cut">
							<!-- White keeps the letter; black takes the signal out of it. -->
							<rect width="32" height="32" fill="#fff" />
							<!-- The source dot *is* the A's enclosed part: the centre of its counter. -->
							<circle cx="16" cy="15" r="1.8" fill="#000" />
							<g fill="none" stroke="#000" stroke-width="1.15" stroke-linecap="round">
								<path d="M13.18 17.54 A3.8 3.8 0 0 0 18.82 17.54" />
								<path d="M11.69 18.88 A5.8 5.8 0 0 0 20.31 18.88" />
								<path d="M10.35 20.09 A7.6 7.6 0 0 0 21.65 20.09" />
							</g>
						</mask>
					</defs>
					<rect width="32" height="32" rx="7.5" fill="#0b0d14" />
					<path d="M13.4 5.4 h5.2 L26.4 26.6 h-4.6 l-1.5-3.2 h-8.6 l-1.5 3.2 H5.6 Z" fill="url(#ax-welcome)" stroke="url(#ax-welcome)" stroke-width="1" stroke-linejoin="round" mask="url(#ax-welcome-cut)" />
				</svg>
				<h2 class="title">Aetherax</h2>
				<p class="subtitle">{t('Wireless Channel Planner')}</p>
			</div>

			<p class="description">
				{t('Import a floorplan, place access points, and press')} <kbd>H</kbd> {t('to see the heatmap.')}
			</p>

			<div class="actions">
				<Button variant="primary" size="md" onclick={handleGetStarted}>
					{t('Get Started')}
				</Button>
			</div>

			<label class="checkbox-row">
				<input type="checkbox" bind:checked={dontShowAgain} />
				<span>{t("Don't show this again")}</span>
			</label>
		</div>
	</div>
{/if}

<style>
	.overlay {
		position: fixed;
		inset: 0;
		background: rgba(10, 12, 18, 0.85);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 9999;
	}

	.dialog {
		background: var(--bg-surface);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg, 8px);
		padding: var(--space-6, 24px);
		max-width: 480px;
		width: 90%;
		display: flex;
		flex-direction: column;
		gap: var(--space-4, 16px);
		box-shadow: var(--shadow-lg);
	}

	.header {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-2, 8px);
	}

	.favicon {
		flex-shrink: 0;
	}

	/*
	 * The same wordmark treatment the toolbar uses. The brand appears in two places, and two
	 * different logos for one name is one too many.
	 */
	.title {
		margin: 0;
		font-family: 'Palatino Linotype', 'Book Antiqua', Palatino, 'URW Palladio L', Georgia,
			serif;
		font-style: italic;
		font-size: 26px;
		font-weight: 700;
		letter-spacing: 0.015em;
		background: linear-gradient(100deg, #d9ff3d 0%, #4be3a0 55%, #00bfa6 100%);
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
	}

	.subtitle {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--text-secondary);
	}

	.description {
		margin: 0;
		font-size: var(--text-base);
		color: var(--text-secondary);
		line-height: 1.5;
		text-align: center;
	}

	.description kbd {
		display: inline-block;
		padding: 0 5px;
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		color: var(--text-primary);
		background: var(--bg-primary);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
	}

	.hint {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--text-tertiary);
		line-height: 1.6;
		text-align: center;
	}

	.hint kbd {
		display: inline-block;
		padding: 0 5px;
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		color: var(--text-primary);
		background: var(--bg-primary);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
	}

	.actions {
		display: flex;
		justify-content: center;
		margin-top: var(--space-1, 4px);
	}

	.actions :global(.btn) {
		min-width: 140px;
		height: 36px;
		font-size: var(--text-base);
	}

	.checkbox-row {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-2, 8px);
		font-size: var(--text-sm);
		color: var(--text-tertiary);
		cursor: pointer;
	}

	.checkbox-row input[type="checkbox"] {
		accent-color: var(--accent-primary);
		cursor: pointer;
	}
</style>
