<script lang="ts">
	/**
	 * Review what the vector reader made of this plan, and disagree with it.
	 */
	import { wallState, type WallMaskData } from '$state/wall-state.svelte';
	import { canvasState } from '$state/canvas.svelte';
	import { floorplanState } from '$state/floorplan-state.svelte';
	import { currentFloor } from '$state/floor-state.svelte';
	import { scheduleSave } from '$state/persistence.svelte';
	import { detectVectorFloorplan, type ReviewableElement } from '$canvas/vector-detect.js';
	import type { ElementRole } from '$canvas/vector-elements.js';
	import Icon from '$components/shared/Icon.svelte';
	import { t } from '$state/i18n.svelte';

	/** How many rows to render. A labelled plan can leave dozens of unknowns. */
	const MAX_ROWS = 24;

	let busy = $state(false);
	let failed = $state(false);

	const review = $derived(wallState.vectorReview);

	const rows = $derived(
		(review?.elements ?? []).filter(
			(e) => e.role === 'door' || e.role === 'window' || e.role === 'unknown'
		)
	);

	const shown = $derived(rows.slice(0, MAX_ROWS));

	/** Roles a row can be set to, and what clears the override. */
	const CHOICES: ReadonlyArray<{ role: ElementRole; label: string }> = [
		{ role: 'wall', label: 'Wall' },
		{ role: 'door', label: 'Door' },
		{ role: 'window', label: 'Window' },
		{ role: 'fixture', label: 'Not a barrier' }
	];

	function isOverridden(id: number): boolean {
		return review?.overrides.has(id) ?? false;
	}

	/** Re-read the drawing with one element's role replaced, and keep the new masks. */
	async function setRole(id: number, role: ElementRole): Promise<void> {
		if (!review || busy) return;
		busy = true;
		failed = false;
		try {
			const overrides = new Map(review.overrides);
			if (review.elements[id]?.role === role && !overrides.has(id)) {
				return;
			}
			overrides.set(id, role);
			await reRead(overrides);
		} finally {
			busy = false;
		}
	}

	/** Drop every override and go back to what the classifier said. */
	async function reset(): Promise<void> {
		if (!review || busy || review.overrides.size === 0) return;
		busy = true;
		failed = false;
		try {
			await reRead(new Map());
		} finally {
			busy = false;
		}
	}

	async function reRead(overrides: Map<number, ElementRole>): Promise<void> {
		if (!review) return;
		const detection = await detectVectorFloorplan(review.source, review.targetWidth, overrides);
		if (!detection) {
			// The edit removed the last wall-shaped element. Say so instead of leaving the
			// panel showing a state the mask does not have.
			failed = true;
			return;
		}
		// Masks come back anchored at the drawing's own origin; this floor may have been
		// moved, and the canvas reads the origin off the mask.
		const offset = underlayOffset();
		wallState.wallMask = offsetMask(detection.wallMask, offset);
		wallState.materialMask = detection.materialMask
			? offsetMask(detection.materialMask, offset)
			: null;
		wallState.vectorReview = {
			summary: detection.summary,
			elements: detection.elements,
			overrides,
			source: review.source,
			targetWidth: review.targetWidth
		};
		scheduleSave();
	}

	function underlayOffset(): { x: number; y: number } {
		const floor = currentFloor();
		return { x: floor?.floorplanOffsetX ?? 0, y: floor?.floorplanOffsetY ?? 0 };
	}

	function offsetMask(mask: WallMaskData, offset: { x: number; y: number }): WallMaskData {
		return { ...mask, originX: mask.originX + offset.x, originY: mask.originY + offset.y };
	}

	/** A row's label: what the file called it, or what it looks like. */
	function labelFor(element: ReviewableElement): string {
		return element.name ? `${element.name} · ${element.reason}` : element.reason;
	}

	/**
	 * Point at one element's place on the plan.
	 */
	function highlight(element: ReviewableElement | null): void {
		if (!element) {
			canvasState.reviewHighlight = null;
			return;
		}
		const origin = wallState.wallMask;
		canvasState.reviewHighlight = {
			x: element.box.x + (origin?.originX ?? 0),
			y: element.box.y + (origin?.originY ?? 0),
			w: element.box.w,
			h: element.box.h
		};
	}

	/** The pixels a plan was read from, given up for the pixel detector. */
	function usePixels(): void {
		canvasState.reviewHighlight = null;
		wallState.vectorReview = null;
		void redetectFromPixels?.();
	}

	/** Injected by the sidebar, which owns the mask-writing path for the tabs. */
	let { redetectFromPixels }: { redetectFromPixels?: () => void } = $props();

	/**
	 * What to say about a pixel read, per reason.
	 */
	const RASTER_REASONS = {
		'not-vector': 'This file is an image, so there are no drawing objects to classify.',
		'no-walls-found': 'The vector reader found nothing wall-shaped in this drawing.',
		'vector-failed': 'The vector reader could not handle this drawing.',
		forced: 'You chose the pixel detector for this plan.'
	} as const;

	let expanded = $state(false);
</script>

{#if review}
	<div class="review">
		<button
			class="review-head"
			aria-expanded={expanded}
			title={t('Read from vector geometry')}
			onclick={() => (expanded = !expanded)}
		>
			<span class="review-title">
				<Icon name="sparkles" size={12} />
				{t('Read from vector geometry')}
			</span>
			<span class="counts">
				{t('{walls} walls · {windows} windows · {doors} doors', {
					walls: review.summary.walls,
					windows: review.summary.windows,
					doors: review.summary.doors
				})}
			</span>
			<span class="chev" class:open={expanded}>
				<Icon name="chevron-down" size={12} />
			</span>
		</button>

		{#if expanded}
			{#if rows.length > 0}
				<ul class="rows">
					{#each shown as element (element.id)}
						<li
							class="row"
							class:overridden={isOverridden(element.id)}
							onmouseenter={() => highlight(element)}
							onmouseleave={() => highlight(null)}
							onfocusin={() => highlight(element)}
							onfocusout={() => highlight(null)}
						>
							<span class="role" data-role={element.role}>{element.role}</span>
							<span class="label" title={labelFor(element)}>{labelFor(element)}</span>
							<span class="choices">
								{#each CHOICES as choice (choice.role)}
									<button
										class="choice"
										class:current={element.role === choice.role}
										disabled={busy}
										title={t('Treat this element as') + ' ' + t(choice.label)}
										onclick={() => setRole(element.id, choice.role)}
									>
										{t(choice.label)}
									</button>
								{/each}
							</span>
						</li>
					{/each}
				</ul>
			{/if}

			{#if failed}
				<span class="error">{t('That change left no walls at all — undo it or re-detect.')}</span>
			{/if}

			<div class="review-actions">
				{#if review.overrides.size > 0}
					<button class="link" onclick={reset} disabled={busy}>{t('Reset')}</button>
				{/if}
				<button class="link" data-action="raster-detect" onclick={usePixels} disabled={busy}>
					{t('Read walls from pixels instead')}
				</button>
			</div>
		{/if}
	</div>
{/if}

{#if !review && wallState.rasterReason && wallState.wallMask}
	<div class="raster-note">
		<span class="review-title">
			<Icon name="grid" size={12} />
			{t('Read from pixels')}
		</span>
	</div>
{/if}

<style>
	/* A bordered block, because it describes the mask the rest of the app is using. */
	.review {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin-top: var(--space-2);
		padding: var(--space-2);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm);
	}

	.raster-note {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin-top: var(--space-2);
		padding: var(--space-2);
		border: 1px dashed var(--border-subtle);
		border-radius: var(--radius-sm);
	}

	.review-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}

	button.review-head {
		width: 100%;
		padding: 0;
		font: inherit;
		color: inherit;
		text-align: left;
		background: none;
		border: 0;
		cursor: pointer;
	}

	.chev {
		flex: none;
		color: var(--text-tertiary);
		transition: transform 120ms ease;
	}

	.chev.open {
		transform: rotate(180deg);
	}

	.review-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-3);
		margin-top: var(--space-2);
		padding-top: var(--space-2);
		border-top: 1px solid var(--border-subtle);
	}

	button.review-head:hover .review-title {
		color: var(--text-primary);
	}

	.review-title {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		font-size: var(--text-xs);
		color: var(--text-secondary);
	}

	.counts {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		color: var(--text-primary);
	}

	.rows {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin: var(--space-1) 0 0;
		padding: 0;
		list-style: none;
	}

	.row {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 4px;
		padding-left: var(--space-1);
		border-left: 2px solid var(--border-default);
	}

	.row.overridden {
		border-left-color: var(--accent-primary);
	}

	.role {
		flex: 0 0 auto;
		font-family: var(--font-mono);
		font-size: 0.625rem;
		text-transform: uppercase;
		color: var(--text-tertiary);
	}

	.role[data-role='door'] {
		color: var(--color-warning, #ffb800);
	}

	.role[data-role='window'] {
		color: var(--accent-primary);
	}

	.label {
		flex: 1 1 100%;
		order: 3;
		font-size: var(--text-xs);
		color: var(--text-tertiary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.choices {
		display: flex;
		flex: 1 1 auto;
		gap: 2px;
		justify-content: flex-end;
	}

	.choice {
		padding: 1px 4px;
		font-family: var(--font-sans);
		font-size: 0.625rem;
		color: var(--text-tertiary);
		background: none;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	.choice:hover:not(:disabled) {
		color: var(--text-primary);
		background: var(--bg-hover);
	}

	.choice.current {
		color: var(--text-primary);
		border-color: var(--accent-primary-dim);
	}

	.choice:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.choice:focus-visible {
		outline: 2px solid var(--accent-primary);
		outline-offset: 1px;
	}

	.link {
		align-self: flex-start;
		margin-top: 0;
		padding: 3px 8px;
		font-family: inherit;
		font-size: var(--text-xs);
		color: var(--text-secondary);
		background: var(--bg-surface);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		text-decoration: none;
		cursor: pointer;
	}

	.link:hover:not(:disabled) {
		color: var(--text-secondary);
	}

	.error {
		margin-top: var(--space-1);
		font-size: var(--text-xs);
		color: var(--color-error);
	}
</style>
