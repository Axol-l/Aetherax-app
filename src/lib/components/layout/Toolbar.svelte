<script lang="ts">
	import { appState } from '$state/app.svelte';
	
	import { scheduleSave } from '$state/persistence.svelte';
	import { undo, redo, canUndo, canRedo } from '$state/history.svelte';
	import Icon from '$components/shared/Icon.svelte';
	import Dropdown from '$components/shared/Dropdown.svelte';
	import Tooltip from '$components/shared/Tooltip.svelte';
	import HelpDialog from '$components/dialogs/HelpDialog.svelte';
	import NewProjectDialog from '$components/dialogs/NewProjectDialog.svelte';
	import { downloadJson, importJson } from '$lib/export/json.js';
	import { exportPng } from '$lib/export/png.js';
	import { exportPdf } from '$lib/export/pdf.js';
	import { canvasEngineRef } from '$state/canvas.svelte';
	import { t, i18nState, toggleLocale } from '$state/i18n.svelte';
	import { projectMeta } from '$state/project-meta.svelte.js';
	import { floorplanState } from '$state/floorplan-state.svelte.js';

	let helpOpen = $state(false);
	let newProjectOpen = $state(false);
	let fileInputEl: HTMLInputElement;
	let importError = $state<string | null>(null);
	let editingName = $state(false);
	let nameInputEl = $state<HTMLInputElement>();

	function startRename() {
		editingName = true;
		// Focus after Svelte renders the input
		setTimeout(() => {
			nameInputEl?.select();
			nameInputEl?.focus();
		}, 0);
	}

	function commitRename() {
		const trimmed = projectMeta.name.trim();
		if (!trimmed) projectMeta.name = 'Untitled Project';
		editingName = false;
		scheduleSave();
	}

	function handleNameKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') commitRename();
		if (e.key === 'Escape') {
			editingName = false;
		}
	}

	/**
	 * Say that a file left the app.
	 *
	 * Every export here hands the user a file and nothing else: in the desktop window it
	 * lands in the download folder, which is somewhere they cannot see, so "Export as PNG"
	 * looked like a button that did nothing. One helper for all of them, so PNG, PDF and
	 * the project file cannot drift apart again — PNG and PDF were exactly that drift.
	 */
	let savedNoticeTimer: ReturnType<typeof setTimeout> | null = null;
	function announce(message: string): void {
		appState.savedNotice = message;
		if (savedNoticeTimer) clearTimeout(savedNoticeTimer);
		savedNoticeTimer = setTimeout(() => {
			appState.savedNotice = null;
			savedNoticeTimer = null;
		}, 3500);
	}

	async function handleSaveProject() {
		await downloadJson();
		announce(t('Project exported as a JSON file'));
	}

	function handleOpenClick() {
		importError = null;
		fileInputEl.click();
	}

	async function handleFileSelect(e: Event) {
		const target = e.target as HTMLInputElement;
		const file = target.files?.[0];
		if (!file) return;

		try {
			await importJson(file);
			importError = null;
		} catch (err) {
			importError = err instanceof Error ? err.message : 'Failed to import project';
		}

		target.value = '';
	}

	async function handleExportPng() {
		const engine = canvasEngineRef.engine;
		if (!engine) return;
		await exportPng(engine, { scale: 2, includeGrid: false });
		announce(t('Exported as a PNG file'));
	}

	async function handleExportPdf() {
		const engine = canvasEngineRef.engine;
		if (!engine) return;
		await exportPdf(engine);
		announce(t('Exported as a PDF file'));
	}

	const fileMenuItems = $derived([
		{ label: t('New Project'), action: () => { newProjectOpen = true; }, shortcut: '' },
		{ label: t('Open Project...'), action: handleOpenClick, shortcut: '' },
		// "Save" is Ctrl+S, which writes to the app's own store and answers visibly. This
		// item hands the user a file, which is a different thing, so it says which.
		{ label: t('Export Project File...'), action: handleSaveProject, shortcut: '' },
		{ separator: true, label: '', action: () => {} },
		{ label: t('Export as PNG'), action: handleExportPng, shortcut: '' },
		{ label: t('Export as PDF'), action: handleExportPdf, shortcut: '' }
	]);

</script>

<header class="toolbar" class:disabled={!!appState.wallEditMode}>
	<div class="toolbar-left">
		<span class="logo">
			<!--
				A solid "A", lit from below like a coverage map: the letter is the name, the glow
				is what the tool measures. One path, so it stays legible at 16 px.
			-->
			<!--
				The signal is cut *out* of the letter: the Wi-Fi glyph is the mask, upside down,
				and its source dot is the A's enclosed part, so the counter and the dot are one
				shape. Flat colour — the wordmark next to it carries the gradient.
			-->
			<!--
				The signal is cut *out* of the letter: the Wi-Fi glyph is the mask, upside
				down, and its source dot is the A's enclosed part. Flat colour — the wordmark
				beside it carries the gradient.
			-->
			<!--
				The signal is cut *out* of the letter: the Wi-Fi glyph is the mask, upside
				down, and its source dot is the A's enclosed part, so the counter and the dot
				are one shape. Flat colour — the wordmark beside it carries the gradient.
			-->
			<svg class="logo-mark" viewBox="0 0 32 32" aria-hidden="true">
				<defs>
				<linearGradient id="ax-logo" x1="0" y1="1" x2="0.35" y2="0">
						<stop offset="0" stop-color="#d9ff3d" />
						<stop offset="0.55" stop-color="#4be3a0" />
						<stop offset="1" stop-color="#00bfa6" />
				</linearGradient>
					<mask id="ax-logo-cut">
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
				<path d="M13.4 5.4 h5.2 L26.4 26.6 h-4.6 l-1.5-3.2 h-8.6 l-1.5 3.2 H5.6 Z" fill="url(#ax-logo)" stroke="url(#ax-logo)" stroke-width="1" stroke-linejoin="round" mask="url(#ax-logo-cut)" />
			</svg>
			<span class="logo-text">Aetherax</span>
		</span>

		<span class="separator">/</span>

		{#if editingName}
			<input
				bind:this={nameInputEl}
				class="project-name-input"
				type="text"
				bind:value={projectMeta.name}
				onblur={commitRename}
				onkeydown={handleNameKeydown}
			/>
		{:else}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<span
				class="project-name"
				ondblclick={startRename}
				title={t('Double-click to rename')}
			>{projectMeta.name}</span>
		{/if}

		<Dropdown items={fileMenuItems}>
			<Icon name="file" size={14} />
			<span class="dropdown-label">{t('File')}</span>
		</Dropdown>

		<div class="undo-redo">
			<Tooltip text={t('Undo')} position="bottom">
				<button
					class="tool-btn"
					onclick={undo}
					disabled={!canUndo()}
					aria-label={t('Undo')}
				>
					<Icon name="undo" size={14} />
				</button>
			</Tooltip>
			<Tooltip text={t('Redo')} position="bottom">
				<button
					class="tool-btn"
					onclick={redo}
					disabled={!canRedo()}
					aria-label={t('Redo')}
				>
					<Icon name="redo" size={14} />
				</button>
			</Tooltip>
		</div>

		<Tooltip text={t('Toggle between imperial (ft) and metric (m) units')} position="bottom">
			<button
				class="unit-btn"
				onclick={() => {
					floorplanState.unitSystem = floorplanState.unitSystem === 'imperial' ? 'metric' : 'imperial';
					scheduleSave();
				}}
				aria-label={t('Toggle units')}
			>
				{floorplanState.unitSystem === 'imperial' ? 'ft' : 'm'}
			</button>
		</Tooltip>
	</div>

	<div class="toolbar-right">
		<Tooltip text={t('Interface language')} position="bottom">
			<button
				class="lang-btn"
				onclick={toggleLocale}
				aria-label={t('Interface language')}
				data-locale={i18nState.locale}
			>
				<span class="lang-on">EN</span>
				<span class="lang-off">中</span>
			</button>
		</Tooltip>
		<Tooltip text={t('Help')} position="bottom">
			<button
				class="tool-btn"
				onclick={() => { helpOpen = true; }}
				aria-label={t('Help')}
			>
				<Icon name="help" size={14} />
			</button>
		</Tooltip>
		<Tooltip text={t('Toggle sidebar')} position="bottom">
			<button
				class="tool-btn"
				class:active={appState.sidebarOpen}
				onclick={() => { appState.sidebarOpen = !appState.sidebarOpen; }}
				aria-label={t('Toggle sidebar')}
			>
				<Icon name="sidebar" size={14} />
			</button>
		</Tooltip>
	</div>
</header>

<input
	bind:this={fileInputEl}
	type="file"
	accept=".json,.aetherax.json,.deconflict.json"
	class="hidden-input"
	onchange={handleFileSelect}
/>
<HelpDialog bind:open={helpOpen} />
<NewProjectDialog bind:open={newProjectOpen} />

<style>
	.toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 40px;
		padding: 0 var(--space-3);
		background: var(--bg-secondary);
		border-bottom: 1px solid var(--border-subtle);
		z-index: var(--z-toolbar);
	}

	.toolbar-left {
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
	}

	.toolbar-right {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 2px;
		flex-shrink: 0;
	}

	.logo {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		user-select: none;
	}

	.logo-mark {
		width: 19px;
		height: 19px;
		flex-shrink: 0;
		transition: filter 160ms ease;
	}

	/*
	 * The wordmark reads as a light travelling along a fibre: a cyan-to-violet gradient that
	 * pans slowly, clipped to the text. Two effects, both cheap: a background-position shift
	 * across a 200 %-wide gradient, plus a soft glow. Neither animates if the user asked for
	 * less motion.
	 */
	.logo-text {
		/*
		 * A calligraphic serif, not the interface's mono face: the wordmark is the one
		 * place in the interface that is allowed to be a brand rather than a label. The
		 * stack is Windows-first (Palatino Linotype ships with it) and falls back through
		 * the clone-friendly names to Georgia, so the *shape* survives on a machine with
		 * none of them.
		 */
		font-family: 'Palatino Linotype', 'Book Antiqua', Palatino, 'URW Palladio L', Georgia,
			serif;
		font-style: italic;
		font-size: 17px;
		font-weight: 700;
		letter-spacing: 0.015em;
		line-height: 1;
		background: linear-gradient(100deg, #d9ff3d 0%, #4be3a0 55%, #00bfa6 100%);
		background-size: 220% 100%;
		background-position: 0% 50%;
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
		transition: filter 160ms ease;
		animation: brand-sweep 7s ease-in-out infinite;
	}

	/*
	 * Hover brightens the mark and the text, and touches **nothing** the animation
	 * reads. Changing `animation-duration` here — which is what this used to do — was
	 * read as a restart: the phase is elapsed-time over duration, so halving the
	 * duration threw the gradient back to a different point of the sweep every time
	 * the pointer crossed the logo.
	 */
	.logo:hover .logo-mark {
		filter: drop-shadow(0 0 8px rgba(75, 227, 160, 0.75));
	}

	.logo:hover .logo-text {
		filter: brightness(1.18);
	}

	@keyframes brand-sweep {
		0%,
		100% {
			background-position: 0% 50%;
		}
		50% {
			background-position: 100% 50%;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.logo-text {
			animation: none;
		}
	}

	/* EN / 中 switch: which half is bright is which language is on, so the button never needs
	   a label of its own. */
	.lang-btn {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		padding: 3px 7px;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm, 4px);
		background: transparent;
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		line-height: 1;
		cursor: pointer;
		transition: border-color var(--transition-fast), background var(--transition-fast);
	}

	.lang-btn:hover {
		border-color: var(--border-default);
		background: var(--bg-hover);
	}

	.lang-btn .lang-on,
	.lang-btn .lang-off {
		color: var(--text-disabled);
		transition: color var(--transition-fast);
	}

	.lang-btn[data-locale='en'] .lang-on,
	.lang-btn[data-locale='zh'] .lang-off {
		color: var(--accent-primary);
		font-weight: 600;
	}

	.lang-btn .lang-off {
		font-family: var(--font-sans);
	}

	.separator {
		color: var(--text-disabled);
		font-size: var(--text-base);
		margin: 0 4px;
		user-select: none;
	}

	.project-name {
		font-family: var(--font-sans);
		font-size: var(--text-base);
		color: var(--text-secondary);
		cursor: default;
		max-width: 180px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		padding: 2px 4px;
		border-radius: var(--radius-sm);
		margin-right: 4px;
	}

	.project-name:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.project-name-input {
		font-family: var(--font-sans);
		font-size: var(--text-base);
		color: var(--text-primary);
		background: var(--bg-surface);
		border: 1px solid var(--accent-primary);
		border-radius: var(--radius-sm);
		padding: 2px 6px;
		height: 24px;
		width: 160px;
		outline: none;
		margin-right: 4px;
	}

	.dropdown-label {
		font-size: var(--text-sm);
	}

	.undo-redo {
		display: flex;
		gap: 1px;
	}

.unit-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 28px;
		height: 28px;
		padding: 0 6px;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm);
		background: var(--bg-surface);
		color: var(--text-secondary);
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		font-weight: 600;
		cursor: pointer;
		transition: all var(--transition-fast);
		margin-left: 4px;
	}

	.unit-btn:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
		border-color: var(--accent-primary-dim);
	}

	.unit-btn:focus-visible {
		outline: 2px solid var(--accent-primary);
		outline-offset: 1px;
	}

	.tool-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border: none;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;
		transition: all var(--transition-fast);
	}

	.tool-btn:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.tool-btn:disabled {
		opacity: 0.3;
		cursor: default;
	}

	.tool-btn.active {
		background: var(--accent-primary-glow);
		color: var(--accent-primary);
		box-shadow: 0 0 8px var(--accent-primary-glow);
	}

	.tool-btn:focus-visible {
		outline: 2px solid var(--accent-primary);
		outline-offset: 1px;
	}

	.hidden-input {
		display: none;
	}

	@media (max-width: 768px) {
		.logo,
		.separator {
			display: none;
		}

		.dropdown-label {
			display: none;
		}

		.project-name {
			max-width: 100px;
		}

		.toolbar-left {
			gap: 2px;
		}
	}

	.toolbar.disabled {
		pointer-events: none;
		opacity: 0.4;
	}
</style>
