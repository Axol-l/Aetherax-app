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
	 * Two slots behind one notice. The transient one is a refusal the user has just been
	 * shown (a click that placed nothing); the standing one is the "APs outside the
	 * building" check, recomputed whenever walls or access points move. Sharing a single
	 * slot meant that check wiped the refusal before it could be read, so the notice
	 * shows the transient one when there is one and the standing one otherwise.
	 */
	import { appState } from '$state/app.svelte';
	import Icon from '$components/shared/Icon.svelte';

	const text = $derived(appState.placementNotice ?? appState.outsideNotice);
</script>

{#if text}
	<div class="notice" role="status" aria-live="polite">
		<Icon name="warning" size={15} />
		<p>{text}</p>
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
</style>
