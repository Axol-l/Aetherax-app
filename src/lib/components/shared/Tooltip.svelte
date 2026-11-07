<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		text,
		position = 'top',
		wrap = false,
		block = false,
		children
	}: {
		text: string;
		position?: 'top' | 'bottom' | 'left' | 'right';
		/** Allow multi-line text. Default is single-line (nowrap). */
		wrap?: boolean;
		/** Fill the parent instead of shrinking to the child (for full-width buttons). */
		block?: boolean;
		children: Snippet;
	} = $props();

	let visible = $state(false);
	let timeout: ReturnType<typeof setTimeout> | null = null;
	let tooltipEl: HTMLDivElement;

	const displayText = $derived.by(() => {
		const cjk = text.match(/^.*?[。！？]/s);
		if (cjk) return cjk[0].trim();
		const match = text.match(/^.*?[.!?](?=\s+[A-Z0-9(“"']|\s*$)/s);
		return match ? match[0].trim() : text;
	});

	function show() {
		timeout = setTimeout(() => {
			visible = true;
			requestAnimationFrame(clampToViewport);
		}, 400);
	}

	function clampToViewport() {
		if (!tooltipEl) return;
		const rect = tooltipEl.getBoundingClientRect();
		if (rect.right > window.innerWidth - 8) {
			tooltipEl.style.left = 'auto';
			tooltipEl.style.right = '0';
			tooltipEl.style.transform = position === 'top' || position === 'bottom' ? 'none' : tooltipEl.style.transform;
		}
		if (rect.left < 8) {
			tooltipEl.style.left = '0';
			tooltipEl.style.right = 'auto';
			tooltipEl.style.transform = position === 'top' || position === 'bottom' ? 'none' : tooltipEl.style.transform;
		}
	}

	function hide() {
		if (timeout) {
			clearTimeout(timeout);
			timeout = null;
		}
		visible = false;
	}
</script>

<div
	class="tooltip-wrapper"
	class:block
	role="group"
	onmouseenter={show}
	onmouseleave={hide}
	onfocusin={show}
	onfocusout={hide}
>
	{@render children()}
	{#if visible}
		<div class="tooltip tooltip-{position}" class:wrap role="tooltip" bind:this={tooltipEl}>
			{displayText}
		</div>
	{/if}
</div>

<style>
	.tooltip-wrapper {
		position: relative;
		display: inline-flex;
		/* An icon and a label in one tooltip are centred on each other rather than
		   stretched: the wrapper's own inline-flex made the taller of the two the
		   row's height, so a small icon sat high beside its text. */
		align-items: center;
	}

	.tooltip-wrapper.block {
		display: flex;
		width: 100%;
	}

	.tooltip {
		position: absolute;
		z-index: var(--z-tooltip);
		background: var(--bg-elevated);
		color: var(--text-secondary);
		font-size: var(--text-xs);
		line-height: 1.4;
		padding: var(--space-1) var(--space-2);
		border-radius: var(--radius-sm);
		box-shadow: var(--shadow-md);
		white-space: nowrap;
		max-width: 220px;
		pointer-events: none;
	}

	/* Multi-line variant: allow wrapping and keep the bubble near the anchor. */
	.tooltip.wrap {
		white-space: normal;
		width: max-content;
		max-width: 240px;
	}

	@media (max-width: 768px) {
		.tooltip {
			display: none;
		}
	}

	.tooltip-top {
		bottom: calc(100% + 6px);
		left: 50%;
		transform: translateX(-50%);
	}

	.tooltip-bottom {
		top: calc(100% + 6px);
		left: 50%;
		transform: translateX(-50%);
	}

	.tooltip-left {
		right: calc(100% + 6px);
		top: 50%;
		transform: translateY(-50%);
	}

	.tooltip-right {
		left: calc(100% + 6px);
		top: 50%;
		transform: translateY(-50%);
	}
</style>
