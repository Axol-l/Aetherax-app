<script lang="ts">
	/**
	 * Review what the vector reader made of this plan, and disagree with it.
	 *
	 * The classifier is confidently wrong sometimes — a thin curved line is a door swing
	 * in most plans and a curved stair rail in some, and a word of lettering is big
	 * enough to look like a block of wall poché — and a mask built from the wrong rule
	 * looks exactly like one built from the right one. Before this panel the only
	 * recourse was the escape hatch back to the pixel detector, which throws away
	 * everything the reader got right along with the one thing it got wrong.
	 *
	 * So: the elements the reader was unsure about (*openings and unknowns*, since a wall
	 * and a fixture are the two answers it is confident in), each with the rule that
	 * decided it and a way to say otherwise. An override re-reads the drawing rather than
	 * patching the mask, because an element the reader called a fixture was never drawn
	 * into the mask in the first place and no amount of patching would add it.
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

	/**
	 * The rows worth a decision: the openings, and everything the reader could not place.
	 *
	 * Walls and fixtures are excluded on purpose. They are the two verdicts the
	 * classifier is sure of — a stroke above the width cut, and a filled shape that is
	 * neither dark nor thin — and listing 22 walls to say "these are walls" would bury
	 * the three rows that need an answer.
	 */
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
			// Choosing what the classifier already said clears the override rather than
			// recording a no-op, so "reset" and "agree with it" end in the same state.
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
	 *
	 * The box is measured in the mask's own pixels and the mask is drawn 1:1 in world
	 * units, so the only conversion is the mask's origin — which is the floor's alignment
	 * offset, added when the mask was anchored to the underlay.
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
	 *
	 * The distinction matters to the user, not to the code: a photograph of a plan has no
	 * objects to classify and never will, while a *vector* plan this reader could not see
	 * is a drawing it got wrong — and that one is worth re-detecting, hand-editing or
	 * reporting.
	 */
	const RASTER_REASONS = {
		'not-vector': 'This file is an image, so there are no drawing objects to classify.',
		'no-walls-found': 'The vector reader found nothing wall-shaped in this drawing.',
		'vector-failed': 'The vector reader could not handle this drawing.',
		forced: 'You chose the pixel detector for this plan.'
	} as const;
</script>

{#if review}
	<div class="review">
		<div class="review-head">
			<span class="review-title">
				<Icon name="sparkles" size={12} />
				{t('Read from vector geometry')}
			</span>
			{#if review.overrides.size > 0}
				<button class="link" onclick={reset} disabled={busy}>{t('Reset')}</button>
			{/if}
		</div>

		<span class="counts">
			{t('{walls} walls · {windows} windows · {doors} doors', {
				walls: review.summary.walls,
				windows: review.summary.windows,
				doors: review.summary.doors
			})}
		</span>
		<span class="meta">
			{t('{count} fixtures and labels left out of the mask', { count: review.summary.ignored })}
			{#if review.overrides.size > 0}
				<!-- An override usually moves an element out of this list (a door that is
				     now a wall is not an opening), so without this the only sign that
				     something changed is a count in a line above. -->
				· {t('{count} changed by you', { count: review.overrides.size })}
			{/if}
		</span>

		{#if rows.length > 0}
			<span class="review-sub">
				{t('Check the openings and anything unclassified')}
				{#if rows.length > shown.length}
					· {t('showing {shown} of {total}', { shown: shown.length, total: rows.length })}
				{/if}
			</span>
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

		<button class="link" data-action="raster-detect" onclick={usePixels} disabled={busy}>
			{t('Read walls from pixels instead')}
		</button>
	</div>
{/if}

<!--
	The other half of the same report: what ran instead, and why.

	Deliberately a different class from `.review`. The escape hatch polls for `.review`
	disappearing to know the vector read is gone, and the specs do the same; a raster
	note wearing that class would make "the vector read is over" unobservable.
-->
{#if !review && wallState.rasterReason && wallState.wallMask}
	<div class="raster-note">
		<span class="review-title">
			<Icon name="grid" size={12} />
			{t('Read from pixels')}
		</span>
		<span class="meta">{t(RASTER_REASONS[wallState.rasterReason])}</span>
		{#if wallState.textMaskingFailed}
			<!-- The single most useful sentence this panel can say on a raster plan: it is
			     the difference between a wall mask and a mask with the room labels
			     thickened into walls, and it is a network failure, not a bad drawing. -->
			<span class="meta warn">
				{t(
					'Text masking is unavailable, so labels are being read as walls. Re-detect when the text model can be downloaded.'
				)}
			</span>
		{/if}
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

	/* Same shell as `.review`, muted: it explains a mask rather than offering to change
	   one, and it must not read as an error — a raster plan is a legitimate plan. */
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

	.meta,
	.review-sub {
		font-size: var(--text-xs);
		color: var(--text-tertiary);
	}

	/* A caveat about the mask, not a decoration: it says the numbers above are wrong. */
	.meta.warn {
		color: var(--color-warning, #ffb800);
	}

	.review-sub {
		margin-top: var(--space-1);
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

	/* An override is a deliberate act; it should be visible at a glance. */
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

	/* The reason is long and the panel is 300 px wide; one line, clipped, with the full
	   text in the tooltip. */
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
		margin-top: var(--space-1);
		padding: 0;
		font-size: var(--text-xs);
		color: var(--text-tertiary);
		background: none;
		border: none;
		text-decoration: underline;
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
