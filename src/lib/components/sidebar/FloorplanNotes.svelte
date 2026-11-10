<script lang="ts">
	import { appState } from '$state/app.svelte.js';
	import { currentFloor } from '$state/floor-state.svelte.js';
	import { pushState } from '$state/history.svelte.js';
	import { scheduleSave } from '$state/persistence.svelte.js';
	import { t } from '$state/i18n.svelte';
	import Button from '$components/shared/Button.svelte';
	import Icon from '$components/shared/Icon.svelte';
	import PanelCard from './PanelCard.svelte';
	import { sidebarCards } from '$state/sidebar-cards.svelte';
	import { slide } from 'svelte/transition';
	import { motionDuration } from '$lib/motion.js';

	/** Whether the floor's notes are listed. Open on first use, collapsible after. */
	let notesOpen = $state(true);

	/** The row with the note's actions; selecting a note scrolls it into view. */
	let noteActions = $state<HTMLDivElement | null>(null);

	const notes = $derived(currentFloor()?.notes ?? []);

	/** The note being edited, on the floor on screen. */
	const selectedNote = $derived.by(() => {
		const id = appState.noteSelectedId;
		if (!id) return null;
		return notes.find((note) => note.id === id) ?? null;
	});

	/*
	 * The list can push the editor past the bottom of the sidebar. Scroll just enough to show
	 * the card's bottom edge when a note opens, so "Delete note" and "Done" are never out of
	 * sight.
	 */
	$effect(() => {
		if (!selectedNote || !noteActions) return;
		const scroller = noteActions.closest<HTMLElement>('.scroll-panel');
		const card = noteActions.closest<HTMLElement>('.planning-area');
		if (!scroller || !card) return;
		const overflow = card.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom;
		if (overflow > 0) scroller.scrollTop += overflow + 8;
	});

	function updateSelectedNote(text: string): void {
		const floor = currentFloor();
		const id = appState.noteSelectedId;
		if (!floor || !id) return;
		const note = (floor.notes ?? []).find((n) => n.id === id);
		if (!note) return;
		note.text = text;
		scheduleSave();
	}

	function deleteSelectedNote(): void {
		const floor = currentFloor();
		const id = appState.noteSelectedId;
		if (!floor || !id) return;
		pushState();
		floor.notes = (floor.notes ?? []).filter((note) => note.id !== id);
		appState.noteSelectedId = null;
		scheduleSave();
	}
</script>

<PanelCard title={t('Notes')} bind:collapsed={sidebarCards.notes}>
	{#if notes.length > 0}
		<button class="notes-toggle" onclick={() => (notesOpen = !notesOpen)} aria-expanded={notesOpen}>
			<span class="notes-chevron" class:collapsed={!notesOpen}>
				<Icon name="chevron-down" size={11} />
			</span>
			{notesOpen ? t('Hide the list') : t('Show the list')}
		</button>
		{#if notesOpen}
			<ul class="notes-list" transition:slide={{ duration: motionDuration(180) }}>
				{#each notes as note (note.id)}
					<li>
						<button
							class="note-row"
							class:active={appState.noteSelectedId === note.id}
							onclick={() => (appState.noteSelectedId = note.id)}
						>
							<span class="note-dot" aria-hidden="true"></span>
							<span class="note-text" class:empty={!note.text.trim()}>
								{note.text.trim() || t('(empty note)')}
							</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}

	{#if appState.noteMode}
		<p class="planning-hint">{t('Click on the plan to place a note. Escape cancels.')}</p>
		<div class="planning-actions">
			<button class="skip-link" onclick={() => (appState.noteMode = false)}>{t('Cancel')}</button>
		</div>
	{:else if selectedNote}
		<textarea
			class="note-input"
			rows="3"
			placeholder={t('What should a reader know about this spot?')}
			value={selectedNote.text}
			oninput={(e) => updateSelectedNote((e.target as HTMLTextAreaElement).value)}
		></textarea>
		<div class="planning-actions" bind:this={noteActions}>
			<Button variant="secondary" size="sm" onclick={deleteSelectedNote}>
				<Icon name="trash" size={14} />
				{t('Delete note')}
			</Button>
			<Button variant="primary" size="sm" onclick={() => (appState.noteSelectedId = null)}>
				<Icon name="check" size={14} />
				{t('Done')}
			</Button>
		</div>
	{:else}
		<div class="planning-actions">
			<Button variant="secondary" size="sm" onclick={() => (appState.noteMode = true)}>
				<Icon name="plus" size={14} />
				{t('Add note')}
			</Button>
		</div>
	{/if}
</PanelCard>

<style>
	.notes-toggle {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		align-self: flex-start;
		padding: 0;
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		color: var(--text-secondary);
		background: none;
		border: none;
		cursor: pointer;
	}

	.notes-toggle:hover {
		color: var(--text-primary);
	}

	.notes-toggle:focus-visible {
		outline: 2px solid var(--accent-primary);
		outline-offset: 2px;
	}

	.notes-chevron {
		display: inline-flex;
		color: var(--text-tertiary);
		transition: transform var(--transition-fast);
	}

	.notes-chevron.collapsed {
		transform: rotate(-90deg);
	}

	.notes-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		max-height: 168px;
		margin: 0;
		padding: 0;
		overflow-y: auto;
		list-style: none;
	}

	/* Each note is a small field, not a line of text: a marked row that clamps to two lines. */
	.note-row {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
		width: 100%;
		padding: 6px var(--space-2);
		text-align: left;
		background: var(--bg-surface);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm);
		cursor: pointer;
		transition:
			background var(--transition-fast),
			border-color var(--transition-fast);
	}

	.note-row:hover {
		background: var(--bg-hover);
		border-color: var(--border-default);
	}

	.note-row.active {
		background: var(--accent-primary-glow);
		border-color: var(--accent-primary);
	}

	.note-row:focus-visible {
		outline: 2px solid var(--accent-primary);
		outline-offset: 1px;
	}

	.note-dot {
		flex: 0 0 auto;
		width: 5px;
		height: 5px;
		margin-top: 5px;
		border-radius: 50%;
		background: var(--text-tertiary);
	}

	.note-row.active .note-dot {
		background: var(--accent-primary);
	}

	.note-text {
		flex: 1 1 auto;
		min-width: 0;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		overflow-wrap: anywhere;
		font-size: var(--text-xs);
		line-height: 1.45;
		color: var(--text-secondary);
	}

	.note-row:hover .note-text {
		color: var(--text-primary);
	}

	.note-row.active .note-text {
		color: var(--text-primary);
	}

	.note-text.empty {
		font-style: italic;
		color: var(--text-tertiary);
	}

	.note-input {
		width: 100%;
		padding: 6px 8px;
		font-family: inherit;
		font-size: var(--text-xs);
		line-height: 1.5;
		color: var(--text-primary);
		background: var(--bg-surface);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		resize: vertical;
	}

	.note-input::placeholder {
		color: var(--text-disabled);
	}

	.note-input:focus-visible {
		outline: 2px solid var(--accent-primary);
		outline-offset: 1px;
	}

	.planning-hint {
		margin: 0;
		font-size: var(--text-xs);
		line-height: 1.5;
		color: var(--text-secondary);
	}

	/* One action fills the card; a pair shares the row, like the other cards. */
	.planning-actions {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--space-2);
	}

	.skip-link {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-1);
		padding: 3px var(--space-2);
		min-height: 24px;
		font-size: var(--text-xs);
		color: var(--text-secondary);
		background: transparent;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		cursor: pointer;
		text-decoration: none;
	}

	.skip-link:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.skip-link:disabled {
		opacity: 0.45;
		cursor: default;
	}

	.skip-link:focus-visible {
		outline: 2px solid var(--accent-primary);
		outline-offset: 1px;
	}
</style>
