<script lang="ts">
	/**
	 * The floor strip: switch, rename, reorder, add and delete storeys.
	 *
	 * It used to be the first block of `FloorplanControls`, whose script is otherwise about
	 * the *current* floor's plan — import, detection, calibration, walls, surfaces, notes.
	 * The list of floors is the one thing in the panel that is about the building instead,
	 * and it is self-contained: five handlers, two pieces of local state and its own CSS.
	 *
	 * The delete confirmation lives here rather than in the parent: the parent's dialog is
	 * shared by every destructive action in the panel, and a floor deletion is the one that
	 * does not need to be routed through it.
	 */
	import { floorState, addFloor, removeFloor, switchFloor } from '$state/floor-state.svelte.js';
	import { apState } from '$state/ap-state.svelte.js';
	import { pushState } from '$state/history.svelte.js';
	import { scheduleSave } from '$state/persistence.svelte.js';
	import { t } from '$state/i18n.svelte';
	import ConfirmDialog from '$components/dialogs/ConfirmDialog.svelte';

	let editingFloorId = $state<string | null>(null);
	let editingFloorName = $state('');

	let confirmOpen = $state(false);
	let confirmMessage = $state('');
	let confirmAction = $state<(() => void) | null>(null);

	function showConfirm(message: string, action: () => void) {
		confirmMessage = message;
		confirmAction = action;
		confirmOpen = true;
	}

	function handleAddFloor() {
		pushState();
		const floor = addFloor();
		switchFloor(floor.id);
		scheduleSave();
	}

	function startRenameFloor(id: string, name: string) {
		editingFloorId = id;
		editingFloorName = name;
	}

	function commitRenameFloor() {
		if (editingFloorId) {
			const floor = floorState.floors.find((f) => f.id === editingFloorId);
			if (floor) {
				floor.name = editingFloorName.trim() || floor.name;
				scheduleSave();
			}
		}
		editingFloorId = null;
	}

	function moveFloor(id: string, direction: -1 | 1) {
		const idx = floorState.floors.findIndex((f) => f.id === id);
		const newIdx = idx + direction;
		if (newIdx < 0 || newIdx >= floorState.floors.length) return;
		// Swap levels
		const a = floorState.floors[idx]!;
		const b = floorState.floors[newIdx]!;
		const tmpLevel = a.level;
		a.level = b.level;
		b.level = tmpLevel;
		// Swap positions in array
		floorState.floors[idx] = b;
		floorState.floors[newIdx] = a;
		floorState.floors = [...floorState.floors]; // trigger reactivity
		scheduleSave();
	}

	function handleDeleteFloor(id: string) {
		if (floorState.floors.length <= 1) return;
		showConfirm('Delete this floor and all its access points?', () => {
			pushState();
			apState.aps = apState.aps.filter((ap) => ap.floorId !== id);
			removeFloor(id);
			scheduleSave();
		});
	}
</script>

<div class="floor-manager">
	<div class="floor-strip">
		{#each floorState.floors as floor}
			{#if editingFloorId === floor.id}
				<input
					class="floor-name-input"
					type="text"
					bind:value={editingFloorName}
					onblur={commitRenameFloor}
					onkeydown={(e) => {
						if (e.key === 'Enter') commitRenameFloor();
						if (e.key === 'Escape') {
							editingFloorId = null;
						}
					}}
					autofocus
				/>
			{:else}
				<button
					class="floor-pill"
					class:active={floor.id === floorState.currentFloorId}
					onclick={() => switchFloor(floor.id)}
					ondblclick={() => startRenameFloor(floor.id, floor.name)}
					title={t('Click to switch, double-click to rename')}
				>
					{floor.name}
					{#if floor.id === floorState.currentFloorId && floorState.floors.length > 1}
						{#if floorState.floors.indexOf(floor) > 0}
							<span
								class="floor-action"
								role="button"
								tabindex="0"
								onclick={(e) => {
									e.stopPropagation();
									moveFloor(floor.id, -1);
								}}
								onkeydown={(e) => {
									if (e.key === 'Enter' || e.key === ' ') {
										e.preventDefault();
										e.stopPropagation();
										moveFloor(floor.id, -1);
									}
								}}>&#9664;</span
							>
						{/if}
						{#if floorState.floors.indexOf(floor) < floorState.floors.length - 1}
							<span
								class="floor-action"
								role="button"
								tabindex="0"
								onclick={(e) => {
									e.stopPropagation();
									moveFloor(floor.id, 1);
								}}
								onkeydown={(e) => {
									if (e.key === 'Enter' || e.key === ' ') {
										e.preventDefault();
										e.stopPropagation();
										moveFloor(floor.id, 1);
									}
								}}>&#9654;</span
							>
						{/if}
						<span
							class="floor-action delete"
							role="button"
							tabindex="0"
							onclick={(e) => {
								e.stopPropagation();
								handleDeleteFloor(floor.id);
							}}
							onkeydown={(e) => {
								if (e.key === 'Enter' || e.key === ' ') {
									e.preventDefault();
									e.stopPropagation();
									handleDeleteFloor(floor.id);
								}
							}}>&times;</span
						>
					{/if}
				</button>
			{/if}
		{/each}
		<button class="floor-pill add" onclick={handleAddFloor} aria-label={t('Add floor')}>+</button>
	</div>
</div>

<ConfirmDialog
	bind:open={confirmOpen}
	title={t('Delete')}
	message={confirmMessage}
	confirmLabel={t('Delete')}
	onconfirm={() => {
		confirmAction?.();
	}}
/>

<style>
	.floor-manager {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.floor-strip {
		display: flex;
		gap: 4px;
		overflow-x: auto;
		overflow-y: hidden;
		padding-bottom: var(--space-2);
		border-bottom: 1px solid var(--border-subtle);
		flex-wrap: nowrap;
		min-width: 0;
	}

	.floor-pill {
		padding: 4px 10px;
		border: 1px solid var(--border-default);
		border-radius: 999px;
		background: var(--bg-surface);
		color: var(--text-secondary);
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		cursor: pointer;
		white-space: nowrap;
		flex: 0 0 auto;
		transition: all var(--transition-fast);
	}

	.floor-pill:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.floor-pill.active {
		border-color: var(--accent-primary);
		color: var(--accent-primary);
		background: var(--accent-primary-glow);
	}

	.floor-pill.add {
		border-style: dashed;
		color: var(--text-tertiary);
		min-width: 28px;
		text-align: center;
	}

	.floor-pill.add:hover {
		border-color: var(--accent-primary-dim);
		color: var(--accent-primary);
	}

	.floor-action {
		margin-left: 2px;
		font-size: 10px;
		line-height: 1;
		opacity: 0.4;
		cursor: pointer;
		padding: 2px;
	}

	.floor-action:hover {
		opacity: 1;
	}

	.floor-action.delete:hover {
		color: var(--danger, #ef4444);
	}

	.floor-name-input {
		padding: 3px 8px;
		border: 1px solid var(--accent-primary);
		border-radius: 999px;
		background: var(--bg-surface);
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		width: 80px;
		outline: none;
	}
</style>
