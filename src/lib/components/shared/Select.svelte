<script lang="ts">
	import { slide } from 'svelte/transition';
	import { motionDuration } from '$lib/motion.js';

	let {
		value = $bindable(''),
		options,
		onchange,
		class: className = '',
		'aria-label': ariaLabel = undefined
	}: {
		value?: string;
		options: Array<{ value: string; label: string }>;
		onchange?: (value: string) => void;
		class?: string;
		'aria-label'?: string;
	} = $props();

	let open = $state(false);
	let triggerEl = $state<HTMLButtonElement>();
	let dropdownEl = $state<HTMLDivElement>();
	let highlightedIndex = $state(-1);
	/** The list opens upwards when the trigger sits near the bottom of its panel. */
	let flipped = $state(false);
	/** Matches the trigger's `aria-controls` to the listbox it opens. */
	const listboxId = $props.id();

	let selectedLabel = $derived(
		options.find((o) => o.value === value)?.label ?? options[0]?.label ?? ''
	);

	function toggle() {
		open = !open;
		if (open) {
			// Initialize highlight to current selection
			const idx = options.findIndex((o) => o.value === value);
			highlightedIndex = idx >= 0 ? idx : 0;
		}
	}

	/** The nearest ancestor that clips its content, or the window when there is none. */
	function clippingRect(el: HTMLElement): DOMRect {
		let node: HTMLElement | null = el.parentElement;
		while (node && node !== document.body) {
			const style = getComputedStyle(node);
			if (style.overflowY !== 'visible' || style.overflowX !== 'visible') return node.getBoundingClientRect();
			node = node.parentElement;
		}
		return new DOMRect(0, 0, window.innerWidth, window.innerHeight);
	}

	/*
	 * A list that opens downward can fall out of the sidebar (the optimiser settings sit near
	 * its bottom). Measure the room on both sides once the list is in the DOM and flip it up
	 * when below is the tighter side.
	 */
	$effect(() => {
		if (!open) {
			flipped = false;
			return;
		}
		const trigger = triggerEl?.getBoundingClientRect();
		if (!trigger || !dropdownEl) return;
		const clip = clippingRect(triggerEl!);
		const needed = Math.min(dropdownEl.scrollHeight, 200) + 6;
		const below = clip.bottom - trigger.bottom;
		const above = trigger.top - clip.top;
		flipped = below < needed && above > below;
	});

	function select(val: string) {
		value = val;
		onchange?.(val);
		open = false;
		highlightedIndex = -1;
		triggerEl?.focus();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			open = false;
			highlightedIndex = -1;
			triggerEl?.focus();
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			if (!open) {
				open = true;
				const idx = options.findIndex((o) => o.value === value);
				highlightedIndex = idx >= 0 ? idx : 0;
			} else {
				highlightedIndex = (highlightedIndex + 1) % options.length;
			}
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			if (open) {
				highlightedIndex = (highlightedIndex - 1 + options.length) % options.length;
			}
		} else if (e.key === 'Enter') {
			e.preventDefault();
			if (open && highlightedIndex >= 0 && highlightedIndex < options.length) {
				select(options[highlightedIndex]!.value);
			}
		}
	}
</script>

<svelte:window onkeydown={open ? handleKeydown : undefined} />

<div class="select-wrapper {className}">
	<button
		bind:this={triggerEl}
		class="trigger no-press-scale"
		type="button"
		onclick={toggle}
		onkeydown={handleKeydown}
		aria-label={ariaLabel}
		aria-expanded={open}
		aria-haspopup="listbox"
		aria-controls={listboxId}
	>
		<span class="trigger-label">{selectedLabel}</span>
		<svg class="chevron" class:open width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
		</svg>
	</button>

	{#if open}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="backdrop" onclick={() => { open = false; }}></div>
		<div
			class="dropdown"
			class:flipped
			id={listboxId}
			role="listbox"
			bind:this={dropdownEl}
			transition:slide={{ duration: motionDuration(160) }}
		>
			{#each options as opt, i}
				<button
					class="option"
					class:selected={opt.value === value}
					class:highlighted={i === highlightedIndex}
					role="option"
					aria-selected={opt.value === value}
					onclick={() => select(opt.value)}
				>
					{opt.label}
				</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.select-wrapper {
		position: relative;
		display: flex;
	}

	.trigger {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		width: 100%;
		background: var(--bg-surface);
		color: var(--text-primary);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		padding: var(--space-1) var(--space-2);
		padding-right: var(--space-5);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		height: 28px;
		cursor: pointer;
		transition: border-color var(--transition-fast);
		line-height: 1;
		white-space: nowrap;
		text-align: left;
		box-sizing: border-box;
	}

	.trigger:hover {
		border-color: var(--accent-primary-dim);
	}

	.trigger:focus-visible {
		outline: 2px solid var(--accent-primary);
		outline-offset: 1px;
	}

	.chevron {
		position: absolute;
		right: var(--space-2);
		color: var(--text-tertiary);
		transition: transform var(--transition-fast);
	}

	.chevron.open {
		transform: rotate(180deg);
	}

	.backdrop {
		position: fixed;
		inset: 0;
		z-index: var(--z-dropdown, 100);
	}

	.dropdown {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		min-width: 100%;
		background: var(--bg-elevated);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-md, 0 4px 12px rgba(0, 0, 0, 0.3));
		z-index: var(--z-dropdown, 100);
		padding: 2px;
		max-height: 200px;
		overflow-y: auto;
	}

	.dropdown.flipped {
		top: auto;
		bottom: calc(100% + 4px);
	}

	.option {
		display: block;
		width: 100%;
		padding: var(--space-1) var(--space-2);
		background: none;
		border: none;
		border-radius: var(--radius-sm);
		color: var(--text-secondary);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		text-align: left;
		cursor: pointer;
		transition: all var(--transition-fast);
		white-space: nowrap;
	}

	.option:hover,
	.option.highlighted {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.option.selected {
		color: var(--accent-primary);
		font-weight: 500;
	}
</style>
