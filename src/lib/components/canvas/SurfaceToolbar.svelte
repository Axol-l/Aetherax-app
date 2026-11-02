<script lang="ts">
	/**
	 * The raised-surface tool's floating bar.
	 *
	 * Same shape as the wall tool's bar 鈥?a segmented group of what you are drawing, one
	 * material control, and Done 鈥?because the two are the same kind of mode. A surface is
	 * drawn with two clicks; the kind changes what those clicks mean and the deck material
	 * sets the loss, so both belong next to the pointer rather than in the sidebar.
	 *
	 * The material is one button opening a list, not a row of chips: the list is the four
	 * presets plus "Custom", and a row of five in a floating bar is the sidebar this bar
	 * exists to avoid.
	 */
	import { t } from '$state/i18n.svelte';
	import {
		DEFAULT_SURFACE_COLOR,
		SURFACE_MATERIALS,
		surfaceColor,
		surfaceMaterial,
		type SurfaceKind,
		type SurfaceMaterialId
	} from '$lib/rf/surface-height.js';
	import Icon from '$components/shared/Icon.svelte';

	let {
		kind,
		material,
		onkind,
		onmaterial,
		ondone
	}: {
		kind: SurfaceKind;
		/** The chosen deck material, or null while the loss is typed by hand. */
		material: SurfaceMaterialId | null;
		onkind: (kind: SurfaceKind) => void;
		onmaterial: (material: SurfaceMaterialId | null) => void;
		ondone: () => void;
	} = $props();

	const kinds = $derived<Array<{ id: SurfaceKind; label: string }>>([
		{ id: 'platform', label: t('Platform') },
		{ id: 'stair', label: t('Stair') },
		{ id: 'ramp', label: t('Ramp') }
	]);

	/** The swatches are the model's own colours, so the bar and the plan cannot disagree. */
	const css = (color: readonly [number, number, number]) =>
		`rgb(${color[0]},${color[1]},${color[2]})`;

	const active = $derived(
		material
			? { label: t(surfaceMaterial(material)?.label ?? material), color: surfaceColor(material) }
			: { label: t('Custom'), color: DEFAULT_SURFACE_COLOR }
	);

	let open = $state(false);

	function pick(id: SurfaceMaterialId | null): void {
		onmaterial(id);
		open = false;
	}
</script>

<svelte:window onkeydown={open ? (e) => { if (e.key === 'Escape') open = false; } : undefined} />

<div class="surface-toolbar" role="toolbar" aria-label={t('Raised surfaces')}>
	<div class="tool-group">
		{#each kinds as option (option.id)}
			<button
				class="tool"
				class:active={kind === option.id}
				aria-pressed={kind === option.id}
				onclick={() => onkind(option.id)}
			>
				{t(option.label)}
			</button>
		{/each}
	</div>

	<div class="material-wrap">
		<button
			class="material"
			aria-haspopup="listbox"
			aria-expanded={open}
			title={t('Material for the next raised surface')}
			onclick={() => (open = !open)}
		>
			<span class="swatch" style="background: {css(active.color)}"></span>
			<span class="material-name">{active.label}</span>
			<svg class="chevron" class:open width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
				<path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
			</svg>
		</button>
		{#if open}
			<div class="material-popup" role="listbox" aria-label={t('Material')}>
				<button
					class="option"
					class:selected={material === null}
					role="option"
					aria-selected={material === null}
					onclick={() => pick(null)}
				>
					<span class="swatch" style="background: {css(DEFAULT_SURFACE_COLOR)}"></span>
					{t('Custom')}
				</button>
				{#each SURFACE_MATERIALS as option (option.id)}
					<button
						class="option"
						class:selected={material === option.id}
						role="option"
						aria-selected={material === option.id}
						title={t('{attenuation} dB through the deck', { attenuation: option.attenuationDb })}
						onclick={() => pick(option.id)}
					>
						<span class="swatch" style="background: {css(surfaceColor(option.id))}"></span>
						{t(option.label)}
					</button>
				{/each}
			</div>
		{/if}
	</div>

	<button class="done" onclick={ondone}>
		<Icon name="check" size={13} />
		{t('Done')}
	</button>
</div>

<style>
	.surface-toolbar {
		position: absolute;
		top: var(--space-3, 12px);
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		/* One continuous strip, like the wall tool's: no gaps between controls. */
		gap: 0;
		padding: 4px 6px;
		background: var(--bg-elevated);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-lg);
		z-index: 30;
		max-width: calc(100% - 2 * var(--space-4, 16px));
	}

	.tool-group {
		display: flex;
		gap: 2px;
	}

	.tool {
		display: inline-flex;
		align-items: center;
		height: 26px;
		padding: 0 8px;
		font-size: var(--text-xs);
		color: var(--text-secondary);
		background: transparent;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		cursor: pointer;
		white-space: nowrap;
	}

	.tool:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.tool.active {
		background: var(--accent-primary);
		color: #0b0d12;
	}

	.material-wrap {
		position: relative;
		display: inline-flex;
	}

	.material {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 26px;
		margin-left: 6px;
		padding: 0 8px;
		font-size: var(--text-xs);
		color: var(--text-primary);
		background: var(--bg-surface);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	.material:hover {
		background: var(--bg-hover);
	}

	.swatch {
		width: 9px;
		height: 9px;
		border-radius: 2px;
		flex: none;
	}

	.material-name {
		max-width: 74px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.chevron {
		color: var(--text-tertiary);
		transition: transform var(--transition-fast);
	}

	.chevron.open {
		transform: rotate(180deg);
	}

	.material-popup {
		position: absolute;
		top: calc(100% + 4px);
		right: 0;
		min-width: 150px;
		padding: 2px;
		background: var(--bg-surface);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-md, 0 4px 12px rgba(0, 0, 0, 0.3));
		z-index: var(--z-dropdown, 100);
	}

	.option {
		display: flex;
		align-items: center;
		gap: 7px;
		width: 100%;
		padding: 5px var(--space-2);
		font-size: var(--text-xs);
		color: var(--text-secondary);
		background: none;
		border: none;
		border-radius: var(--radius-sm);
		text-align: left;
		cursor: pointer;
	}

	.option:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.option.selected {
		color: var(--accent-primary);
	}

	/* The one action that ends the mode: the accent, like the other toolbars' Done. */
	.done {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		height: 26px;
		margin-left: 4px;
		padding: 0 10px;
		font-size: var(--text-xs);
		font-weight: 500;
		color: #0b0d12;
		background: var(--accent-primary);
		border: 1px solid var(--accent-primary);
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	.done:hover {
		background: color-mix(in srgb, var(--accent-primary) 85%, white);
	}
</style>

