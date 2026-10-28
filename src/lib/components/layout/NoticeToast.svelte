<script lang="ts">
	/**
	 * The corner notice: placement warnings, where the plan is.
	 *
	 * These used to be a paragraph inside the coverage panel. That panel is only on screen
	 * while the Floorplan tab is open, the notice pushed its own content down when it
	 * appeared, and the thing it is about — an access point sitting in the margin outside
	 * the walls — is on the canvas. A corner notice is visible in every tab, moves nothing,
	 * and is where a reader looks for exactly this.
	 *
	 * Three slots behind one notice. The transient one is a refusal the user has just been
	 * shown (a click that placed nothing); the standing one is the "APs outside the
	 * building" check, recomputed whenever walls or access points move; the storage one
	 * says the project could not be written. Sharing a single slot meant the standing
	 * check wiped the refusal before it could be read.
	 *
	 * Storage comes first when it is set: a plan that is wrong can be fixed, a plan that
	 * was not saved is work to redo.
	 */
	import { appState } from '$state/app.svelte';
	import Icon from '$components/shared/Icon.svelte';

	const text = $derived(
		appState.storageNotice ?? appState.placementNotice ?? appState.outsideNotice
	);
	/**
	 * The save acknowledgment, which is not a warning: it gets a tick rather than the
	 * warning triangle, so "saved" never reads as "something is wrong".
	 *
	 * It is rendered *beside* the warnings rather than instead of them. Sharing the slot
	 * meant an export said nothing at all whenever a standing warning was up — which is
	 * exactly when a user is most likely to be pressing things.
	 */
	const saved = $derived(appState.savedNotice);
	/**
	 * A statement about the walls, e.g. that a detected plan was traced into segments.
	 *
	 * Ticked rather than warned: nothing went wrong, and the change is one the user asked
	 * for by pressing Draw wall. It expires — see `notifyWalls`.
	 */
	const walls = $derived(appState.wallNotice);
</script>

{#if text}
	<div class="notice" role="status" aria-live="polite">
		<Icon name="warning" size={15} />
		<p>{text}</p>
	</div>
{/if}

{#if walls}
	<div class="notice saved" class:stacked={text !== null || saved !== null} role="status" aria-live="polite">
		<Icon name="check" size={13} />
		<p>{walls}</p>
	</div>
{/if}

{#if saved}
	<div class="notice saved" class:stacked={text !== null} role="status" aria-live="polite">
		<Icon name="check" size={13} />
		<p>{saved}</p>
	</div>
{/if}

<style>
	.notice {
		position: fixed;
		right: var(--space-4);
		bottom: var(--space-4);
		/* Over the canvas and the toolbar, under a dialog: it must not cover a modal. */
		z-index: 90;
		display: flex;
		gap: var(--space-2);
		align-items: flex-start;
		max-width: min(380px, calc(100vw - 2 * var(--space-4)));
		padding: var(--space-3);
		color: var(--color-warning);
		background: var(--bg-elevated);
		border: 1px solid var(--border-default);
		border-left: 3px solid var(--color-warning);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-lg);
		pointer-events: none;
	}

	.notice p {
		font-size: var(--text-xs);
		line-height: 1.55;
		/* The message carries names of access points, so it can be long. */
		color: var(--text-primary);
	}

	/* A save is good news: the icon and the edge say so before the words are read. */
	.notice.saved {
		color: var(--color-success, #4ade80);
		border-left-color: var(--color-success, #4ade80);
		/* One short line, not a wrapped paragraph of prose: centred against the tick
		   rather than hung from the top of a tall box. */
		align-items: center;
	}

	/*
	 * ...and at the standard secondary size, not the smallest one. The warning notices are
	 * multi-line prose where the small size is right; a confirmation at 11 px next to a
	 * 15 px icon read as a different, and slightly broken, piece of UI.
	 */
	.notice.saved p {
		font-size: var(--text-sm);
		line-height: 1.4;
	}

	/* Above the warning when both are up, so neither hides the other. */
	.notice.stacked {
		bottom: calc(var(--space-4) + 46px);
	}
</style>
