<script lang="ts">
	/**
	 * Notes pinned to the current floor.
	 *
	 * Half of what decides where an access point goes never made it into the CAD file — the
	 * lift lobby's steel door, the rack that will be installed next month. A pin holds that
	 * next to the place it is about, and the layer switch can take them off the plan for a
	 * screenshot or a print.
	 *
	 * The list is collapsed by default once there are notes: annotations are something you
	 * consult, not something that has to take six rows of the sidebar while placing APs.
	 */
	import { appState } from '$state/app.svelte.js';
	import { currentFloor } from '$state/floor-state.svelte.js';
	import { pushState } from '$state/history.svelte.js';
	import { scheduleSave } from '$state/persistence.svelte.js';
	import { t } from '$state/i18n.svelte';
	import Button from '$components/shared/Button.svelte';
	import Icon from '$components/shared/Icon.svelte';
	import PanelCard from './PanelCard.svelte';

	let collapsed = $state(false);
	/** Whether the floor's notes are listed. Open on first use, collapsible after. */
	let notesOpen = $state(true);

	const notes = $derived(currentFloor()?.notes ?? []);

	/** The note being edited, on the floor on screen. */
	const selectedNote = $derived.by(() => {
		const id = appState.noteSelectedId;
		if (!id) return null;
		return notes.find((note) => note.id === id) ?? null;
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

<PanelCard title={t('Notes')} icon="tag" bind:collapsed>
	{#if notes.length > 0}
		<button class="notes-toggle" onclick={() => (notesOpen = !notesOpen)} aria-expanded={notesOpen}>
			<Icon name="chevron-down" size={12} />
			{notesOpen ? t('Hide the list') : t('Show the list')}
		</button>
		{#if notesOpen}
			<ul class="notes-list">
				{#each notes as note (note.id)}
					<li>
						<button
							class="note-row"
							class:active={appState.noteSelectedId === note.id}
							onclick={() => (appState.noteSelectedId = note.id)}
						>
							{note.text.trim() || t('(empty note)')}
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
		<div class="planning-actions">
			<Button variant="secondary" size="sm" onclick={deleteSelectedNote}>{t('Delete note')}</Button>
			<button class="skip-link" onclick={() => (appState.noteSelectedId = null)}>{t('Done')}</button>
		</div>
	{:else}
		<div class="planning-actions">
			<Button variant="secondary" size="sm" onclick={() => (appState.noteMode = true)}>
				<Icon name="tag" size={14} />
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
		padding: 2px 6px;
		font-size: var(--text-xs);
		color: var(--text-secondary);
		background: transparent;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	.notes-toggle:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.notes-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
		max-height: 140px;
		margin: 0;
		padding: 0;
		overflow-y: auto;
		list-style: none;
	}

	.note-row {
		width: 100%;
		padding: 3px 6px;
		font-size: var(--text-xs);
		text-align: left;
		color: var(--text-secondary);
		background: transparent;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		cursor: pointer;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.note-row:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.note-row.active {
		border-color: var(--accent-primary);
		color: var(--text-primary);
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

	/*
	 * The body helpers are repeated from the panel's stylesheet while the remaining cards
	 * are still in `FloorplanControls`: scoped CSS does not cross the component boundary,
	 * and the shared card wrapper (`PanelCard`) only owns the shell, not the body's chips.
	 */
	.planning-hint {
		margin: 0;
		font-size: var(--text-xs);
		line-height: 1.5;
		color: var(--text-secondary);
	}

	.planning-actions {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
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
