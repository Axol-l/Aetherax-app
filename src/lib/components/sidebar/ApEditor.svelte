<script lang="ts">
	import {
		MOUNT_PRESETS,
		CEILING_DOWNTILT_DEG,
		apHeightAboveFloor,
		defaultMountHeight,
		wupmForFloor,
		radiusFromPower,
		removeAp,
		removeAps,
		updateAp,
		type ApMount
	} from '$state/ap-state.svelte.js';
	import { MAX_BEAMWIDTH_DEG, MAX_AIM_DEG, normaliseBearing } from '$lib/rf/antenna.js';
	import AntennaDiagram from './AntennaDiagram.svelte';
	import { wallSnapForFloor } from '$state/wall-snap.js';
	import { DEFAULT_CLIENTS_PER_AP } from '$lib/domain/client-capacity.js';
	import { floorState } from '$state/floor-state.svelte.js';
	import { canvasState, clearSelection, selectAp } from '$state/canvas.svelte';
	import { pushState } from '$state/history.svelte';
	import { getAvailableChannels } from '@aetherax/channels';
	import type { Band, ChannelWidth } from '@aetherax/channels';
	import { solverState, edgeSignals } from '$state/solver.svelte.js';
	import { findModel, getBandSpec, recommendedClients, type ApModel } from '$lib/data/ap-models.js';
	import Select from '$components/shared/Select.svelte';
	import Button from '$components/shared/Button.svelte';
	import Icon from '$components/shared/Icon.svelte';
	import NumberInput from '$components/shared/NumberInput.svelte';
	import Tooltip from '$components/shared/Tooltip.svelte';
	import ModelPicker from '$components/shared/ModelPicker.svelte';
	import { t } from '$state/i18n.svelte';
	import { displayLength, lengthInputHints, lengthUnit, unitToMetres } from '$lib/units.js';
	import { apState } from '$state/ap-state.svelte.js';
	import { floorplanState } from '$state/floorplan-state.svelte.js';

	/** Narrowest beam the field accepts: below this the pattern is a pencil. */
	const MIN_BEAMWIDTH_DEG = 10;

	const allBandOptions = [
		{ value: '2.4ghz', label: '2.4 GHz' },
		{ value: '5ghz', label: '5 GHz' },
		{ value: '6ghz', label: '6 GHz' }
	];

	// Constrain band options to what the selected model supports
	let bandOptions = $derived.by(() => {
		if (!singleAp?.modelId) return allBandOptions;
		const model = findModel(singleAp.modelId);
		if (!model) return allBandOptions;
		const supportedBands = new Set(model.bands.map((b) => b.band));
		return allBandOptions.filter((o) => supportedBands.has(o.value as Band));
	});

	const widthsByBand: Record<string, Array<{ value: string; label: string }>> = {
		'2.4ghz': [
			{ value: '20', label: '20 MHz' },
			{ value: '40', label: '40 MHz' }
		],
		'5ghz': [
			{ value: '20', label: '20 MHz' },
			{ value: '40', label: '40 MHz' },
			{ value: '80', label: '80 MHz' },
			{ value: '160', label: '160 MHz' }
		],
		'6ghz': [
			{ value: '20', label: '20 MHz' },
			{ value: '40', label: '40 MHz' },
			{ value: '80', label: '80 MHz' },
			{ value: '160', label: '160 MHz' },
			{ value: '320', label: '320 MHz' }
		]
	};

	const defaultWidths = [{ value: '20', label: '20 MHz' }];

	function getWidths(band: string): Array<{ value: string; label: string }> {
		return widthsByBand[band as keyof typeof widthsByBand] ?? defaultWidths;
	}

	let selectedAps = $derived(
		apState.aps.filter((a) => canvasState.selectedApIds.includes(a.id))
	);
	let singleAp = $derived(selectedAps.length === 1 ? selectedAps[0] : null);
	let multiSelect = $derived(selectedAps.length > 1);
	let nameInput: HTMLInputElement;

	let batchPower = $state(20);

	const lengthDisplayUnit = $derived(lengthUnit(floorplanState.unitSystem));

	const mountOptions = $derived(
		MOUNT_PRESETS.map((preset) => ({ value: preset.mount, label: t(preset.label) }))
	);

	const apCeilingHeight = $derived(
		singleAp ? (floorState.floors.find((f) => f.id === singleAp.floorId)?.ceilingHeight ?? 3) : 3
	);

	/** Metres shown in the project's own unit, with the storey as the bound. */
	const mountHeightDisplay = $derived.by(() => {
		if (!singleAp) return 0;
		return displayLength(singleAp.mountHeightM, lengthDisplayUnit).value;
	});
	const mountHeightHints = $derived(
		lengthInputHints(0, apCeilingHeight, 0.1, lengthDisplayUnit)
	);

	async function handleMountChange(value: string): Promise<void> {
		if (!singleAp) return;
		pushState();
		const mount = value as ApMount;
		const wasCeiling = singleAp.mount === 'ceiling';
		updateAp(singleAp.id, {
			mount,
			mountHeightM: defaultMountHeight(mount, apCeilingHeight),
			aimDeg: mount === 'ceiling' ? (wasCeiling ? singleAp.aimDeg : CEILING_DOWNTILT_DEG) : wasCeiling ? 0 : singleAp.aimDeg
		});
		if (mount !== 'wall') return;

		const snap = await wallSnapForFloor(
			singleAp.floorId,
			singleAp.x,
			singleAp.y,
			wupmForFloor(singleAp.floorId)
		);
		if (!snap) return;
		updateAp(singleAp.id, { x: snap.apX, y: snap.apY, facingDeg: snap.facingDeg });
	}

	/** A wall mount's direction in the plan, in whole degrees. */
	function handleFacingChange(e: Event): void {
		if (!singleAp) return;
		pushState();
		const typed = Number((e.target as HTMLInputElement).value);
		updateAp(singleAp.id, { facingDeg: Math.round(normaliseBearing(typed)) });
	}

	/** Pin the AP's position for the optimiser, or let it move again. */
	function handlePinnedChange(e: Event): void {
		if (!singleAp) return;
		pushState();
		updateAp(singleAp.id, { pinned: (e.target as HTMLInputElement).checked });
	}

	function handleMountHeightChange(e: Event): void {
		if (!singleAp) return;
		pushState();
		const typed = unitToMetres(Number((e.target as HTMLInputElement).value), lengthDisplayUnit);
		updateAp(singleAp.id, {
			mountHeightM: Math.min(Math.max(typed, 0), apCeilingHeight)
		});
	}

	/** A beam of no width is a beam that covers nothing; 180° is the flat profile. */
	function handleBeamwidthChange(e: Event): void {
		if (!singleAp) return;
		pushState();
		const typed = Number((e.target as HTMLInputElement).value);
		updateAp(singleAp.id, {
			beamwidthDeg: Math.min(Math.max(typed, MIN_BEAMWIDTH_DEG), MAX_BEAMWIDTH_DEG)
		});
	}

	/** Sign is the direction: positive aims the peak down, negative aims it up. */
	function handleAimChange(e: Event): void {
		if (!singleAp) return;
		pushState();
		const typed = Number((e.target as HTMLInputElement).value);
		updateAp(singleAp.id, {
			aimDeg: Math.min(Math.max(typed, -MAX_AIM_DEG), MAX_AIM_DEG)
		});
	}

	/** 0° is vertical, 90° is horizontal. */
	function handlePolarizationChange(e: Event): void {
		if (!singleAp) return;
		pushState();
		const typed = Number((e.target as HTMLInputElement).value);
		updateAp(singleAp.id, {
			polarizationAngleDeg: Math.min(90, Math.max(0, typed))
		});
	}

	$effect(() => {
		if (selectedAps.length > 0) {
			batchPower = selectedAps[0]?.power ?? 20;
		}
	});

	// Auto-derive interference radius from power for single AP
	$effect(() => {
		if (singleAp) {
			const derived = radiusFromPower(singleAp.power, singleAp.band);
			if (singleAp.interferenceRadius !== derived) {
				updateAp(singleAp.id, { interferenceRadius: derived });
			}
		}
	});

	// Apply batch power to all selected APs
	$effect(() => {
		if (multiSelect) {
			for (const ap of selectedAps) {
				if (ap.power !== batchPower) {
					const radius = radiusFromPower(batchPower, ap.band);
					updateAp(ap.id, { power: batchPower, interferenceRadius: radius });
				}
			}
		}
	});

	/** APs the solver identified as co-channel conflicts, with real attenuated signal. */
	let interferers = $derived.by(() => {
		if (!singleAp || !solverState.lastResult) return [];
		const conflicts = solverState.lastResult.conflicts;
		const results: Array<{ id: string; name: string; signalPct: number }> = [];
		for (const [a, b] of conflicts) {
			const otherId = a === singleAp.id ? b : b === singleAp.id ? a : null;
			if (!otherId) continue;
			const other = apState.aps.find((ap) => ap.id === otherId);
			if (!other) continue;
			const pairKey = [singleAp.id, other.id].sort().join(':');
			const signal = edgeSignals.get(pairKey) ?? 0;
			results.push({ id: other.id, name: other.name, signalPct: Math.round(signal * 100) });
		}
		return results.sort((a, b) => b.signalPct - a.signalPct);
	});

	let channelOptions = $derived.by(() => {
		if (!singleAp) return [];
		const channels = getAvailableChannels(
			singleAp.band,
			apState.regulatoryDomain
		);
		const opts: Array<{ value: string; label: string }> = [
			{ value: '', label: 'Auto' }
		];
		for (const ch of channels) {
			opts.push({ value: String(ch.number), label: String(ch.number) });
		}
		return opts;
	});

	function handleBandChange(val: string) {
		pushState();
		const band = val as Band;
		if (singleAp) {
			const interferenceRadius = radiusFromPower(singleAp.power, band);
			updateAp(singleAp.id, { band, interferenceRadius, fixedChannel: null, assignedChannel: null });
		} else if (multiSelect) {
			for (const ap of selectedAps) {
				const interferenceRadius = radiusFromPower(ap.power, band);
				updateAp(ap.id, { band, interferenceRadius, fixedChannel: null, assignedChannel: null });
			}
		}
	}

	function handleWidthChange(val: string) {
		pushState();
		const channelWidth = Number(val) as ChannelWidth;
		if (singleAp) {
			updateAp(singleAp.id, { channelWidth });
		} else if (multiSelect) {
			for (const ap of selectedAps) {
				updateAp(ap.id, { channelWidth });
			}
		}
	}

	function handleChannelChange(val: string) {
		pushState();
		if (!singleAp) return;
		const fixedChannel = val === '' ? null : Number(val);
		updateAp(singleAp.id, { fixedChannel, assignedChannel: fixedChannel });
	}

	function handleClientsChange(value: number) {
		if (!singleAp) return;
		pushState();
		updateAp(singleAp.id, { clients: value > 0 ? value : null });
	}

	function handleModelChange(model: ApModel | null) {
		pushState();
		if (!singleAp) return;
		if (!model) {
			updateAp(singleAp.id, { modelId: null, modelLabel: null, clients: null });
			return;
		}
		const spec =
			getBandSpec(model, singleAp.band) ?? getBandSpec(model, apState.band) ?? model.bands[0];
		if (!spec) return;

		// Set power from model spec — radius is auto-derived by the $effect
		updateAp(singleAp.id, {
			modelId: model.id,
			modelLabel: `${model.vendor} ${model.model}`,
			band: spec.band,
			channelWidth: spec.maxChannelWidth,
			power: spec.maxTxPower,
			interferenceRadius: radiusFromPower(spec.maxTxPower, spec.band),
			fixedChannel: null,
			assignedChannel: null,
			clients: recommendedClients(model)
		});
	}

	function handleNameFocus() {
		pushState();
	}

	function handleNameInput(e: Event) {
		if (!singleAp) return;
		const target = e.target as HTMLInputElement;
		updateAp(singleAp.id, { name: target.value });
	}

	function handleDelete() {
		if (singleAp) {
			removeAp(singleAp.id);
			clearSelection();
		}
	}

	function handleDeleteAll() {
		if (multiSelect) {
			removeAps(canvasState.selectedApIds);
			clearSelection();
		}
	}
</script>

{#if singleAp}
	<div class="editor">
		<div class="back-row">
			<Tooltip text={t('All APs ({count})', { count: apState.aps.length })} position="right">
				<button
					class="back-btn"
					aria-label={t('All APs ({count})', { count: apState.aps.length })}
					onclick={() => clearSelection()}
				>
					<Icon name="chevron-left" size={15} />
				</button>
			</Tooltip>
		</div>
		<div class="section-header">{t('PROPERTIES')}</div>

		<div class="field">
			<Tooltip text={t('Pick a model to fill in band, power and range.')} position="top">
				<span class="field-label">{t('Model')}</span>
			</Tooltip>
			<ModelPicker value={singleAp.modelId} onchange={handleModelChange} />
		</div>

		<div class="field">
			<Tooltip text={t('A label for this access point.')} position="top">
				<span class="field-label">{t('Name')}</span>
			</Tooltip>
			<div class="input-with-clear">
				<input
					bind:this={nameInput}
					class="text-input"
					type="text"
					value={singleAp.name}
					oninput={handleNameInput}
					onfocus={handleNameFocus}
					aria-label={t('AP name')}
				/>
				{#if singleAp.name}
					<button class="clear-input-btn" onclick={() => { pushState(); updateAp(singleAp.id, { name: '' }); nameInput?.focus(); }} aria-label={t('Clear name')}>&times;</button>
				{/if}
			</div>
		</div>

		<div class="field">
			<Tooltip text={t('2.4 GHz reaches further; 5 and 6 GHz have more channels.')} position="top">
				<span class="field-label">{t('Band')}</span>
			</Tooltip>
			<Select
				value={singleAp.band}
				options={bandOptions}
				onchange={handleBandChange}
			/>
		</div>

		<div class="field">
			<Tooltip text={t('Wider is faster, but more prone to interference.')} position="top">
				<span class="field-label">{t('Channel Width')}</span>
			</Tooltip>
			<Select
				value={String(singleAp.channelWidth)}
				options={getWidths(singleAp.band)}
				onchange={handleWidthChange}
			/>
		</div>

		<div class="field">
			<Tooltip text={t('Auto lets the solver choose.')} position="top">
				<span class="field-label">{t('Channel')}</span>
			</Tooltip>
			<Select
				value={singleAp.fixedChannel != null ? String(singleAp.fixedChannel) : ''}
				options={channelOptions}
				onchange={handleChannelChange}
			/>
		</div>

		<div class="field">
			<Tooltip text={t('Transmit power, in dBm.')} position="top">
				<span class="field-label">{t('TX Power')}</span>
			</Tooltip>
			<NumberInput
				bind:value={singleAp.power}
				min={1}
				max={36}
				step={1}
				label="dBm"
			/>
		</div>

		<div class="field">
			<Tooltip text={t('Concurrent clients this AP is planned to carry.')} position="top">
				<span class="field-label">{t('Clients')}</span>
			</Tooltip>
			<NumberInput
				value={singleAp.clients ?? DEFAULT_CLIENTS_PER_AP}
				min={1}
				max={500}
				step={1}
				onchange={handleClientsChange}
			/>
		</div>

		<div class="field">
			<Tooltip
				text={t('How high the AP is above this floor.')}
				position="top"
			>
				<span class="field-label">{t('Mounting')}</span>
			</Tooltip>
			<div class="mount-row">
				<Select value={singleAp.mount} options={mountOptions} onchange={handleMountChange} />
				<input
					class="mount-height"
					type="number"
					aria-label={t('Mount height')}
					value={mountHeightDisplay}
					min={mountHeightHints.min}
					max={mountHeightHints.max}
					step={mountHeightHints.step}
					onchange={handleMountHeightChange}
				/>
				<span class="mount-unit">{lengthDisplayUnit}</span>
			</div>
		</div>

		<div class="field">
			<Tooltip
				text={t('Beam: the -3 dB width of the pattern. Aim: where its peak points — positive down, negative up, 0 level.')}
				position="top"
			>
				<span class="field-label">{t('Antenna')}</span>
			</Tooltip>
			<div class="mount-row">
				<input
					class="mount-height"
					type="number"
					aria-label={t('Vertical beamwidth')}
					value={singleAp.beamwidthDeg}
					min={MIN_BEAMWIDTH_DEG}
					max={MAX_BEAMWIDTH_DEG}
					step={5}
					onchange={handleBeamwidthChange}
				/>
				<span class="mount-unit">{t('° beam')}</span>
				<input
					class="mount-height"
					type="number"
					aria-label={t('Aim')}
					value={singleAp.aimDeg}
					min={-MAX_AIM_DEG}
					max={MAX_AIM_DEG}
					step={5}
					onchange={handleAimChange}
				/>
				<span class="mount-unit">{t('° aim')}</span>
			</div>
			<div class="mount-row">
				<Tooltip position="top" text={t('Transmit polarization: 0° is vertical, 90° is horizontal.')}>
					<span class="field-label">{t('Polarization')}</span>
				</Tooltip>
				<input
					class="mount-height"
					type="number"
					aria-label={t('Polarization')}
					value={singleAp.polarizationAngleDeg ?? 0}
					min="0"
					max="90"
					step={5}
					onchange={handlePolarizationChange}
				/>
				<span class="mount-unit">{t('°')}</span>
			</div>
			{#if singleAp.mount === 'wall'}
				<!--
					Only a wall mount has a direction in the plan: an upright omni is a
					doughnut about its own axis, so for the other two mountings the number
					would be a setting that does nothing.
				-->
				<div class="facing-row">
					<Tooltip
						position="top"
						text={t('Which way the unit looks in the plan: 0° is +x (right), 90° is +y (down). A wall mount radiates forwards and is attenuated behind, so this is the direction its coverage goes.')}
					>
						<span class="field-label">{t('Facing')}</span>
					</Tooltip>
					<input
						class="mount-height"
						type="number"
						aria-label={t('Facing')}
						value={Math.round(singleAp.facingDeg)}
						min="0"
						max="359"
						step="5"
						onchange={handleFacingChange}
					/>
					<span class="mount-unit">{t('° in plan')}</span>
				</div>
			{/if}
			<AntennaDiagram
				beamwidthDeg={singleAp.beamwidthDeg}
				aimDeg={singleAp.aimDeg}
				mountHeightM={apHeightAboveFloor(singleAp)}
				ceilingHeightM={apCeilingHeight}
				band={singleAp.band}
				mount={singleAp.mount}
				facingDeg={singleAp.facingDeg}
			/>
		</div>

		<div class="field">
			<span class="field-label">{t('Position')}</span>
			<div class="position-row">
				<div class="position-field">
					<span class="pos-label">X</span>
					<span class="pos-value">{Math.round(singleAp.x)}</span>
				</div>
				<div class="position-field">
					<span class="pos-label">Y</span>
					<span class="pos-value">{Math.round(singleAp.y)}</span>
				</div>
			</div>
			<!--
				The pin is a constraint on the optimiser, not on the user.
			-->
			<button
				class="pin-row"
				class:on={singleAp.pinned}
				role="switch"
				aria-checked={singleAp.pinned}
				onclick={() => {
					pushState();
					updateAp(singleAp.id, { pinned: !singleAp.pinned });
				}}
			>
				<Tooltip
					position="top"
					text={t('The optimiser leaves this access point exactly where it is. It still counts for coverage, interference and channel planning — it is only its position that is fixed.')}
				>
					<span>{t('Pin position')}</span>
				</Tooltip>
				<span class="toggle-track"><span class="toggle-knob"></span></span>
			</button>
		</div>

		{#if interferers.length > 0}
			<div class="section-header">{t('CO-CHANNEL CONFLICTS ({count})', { count: interferers.length })}</div>
			<div class="neighbors">
				{#each interferers.slice(0, 5) as n}
					<button class="neighbor-row clickable" onclick={() => selectAp(n.id)}>
						<span class="neighbor-name">{n.name}</span>
						<span class="neighbor-overlap" class:low={n.signalPct < 20} class:med={n.signalPct >= 20 && n.signalPct < 50} class:high={n.signalPct >= 50}>
							{n.signalPct}%
						</span>
					</button>
				{/each}
			</div>
		{/if}

		<div class="delete-section">
			<Button variant="danger" size="sm" onclick={handleDelete}>
				<Icon name="trash" size={14} />
				{t('Delete Access Point')}
			</Button>
		</div>
	</div>
{:else if multiSelect}
	<div class="editor">
		<div class="multi-header">
			<div class="section-header">{selectedAps.length} APs SELECTED</div>
			<button class="deselect-link" onclick={() => clearSelection()}>{t('Deselect')}</button>
		</div>

		<div class="field">
			<Tooltip text={t('2.4 GHz reaches further; 5 and 6 GHz have more channels.')} position="top">
				<span class="field-label">{t('Band')}</span>
			</Tooltip>
			<Select
				value={selectedAps[0]?.band ?? '5ghz'}
				options={bandOptions}
				onchange={handleBandChange}
			/>
		</div>

		<div class="field">
			<Tooltip text={t('Wider is faster, but more prone to interference.')} position="top">
				<span class="field-label">{t('Channel Width')}</span>
			</Tooltip>
			<Select
				value={String(selectedAps[0]?.channelWidth ?? 20)}
				options={getWidths(selectedAps[0]?.band ?? '5ghz')}
				onchange={handleWidthChange}
			/>
		</div>

		<div class="field">
			<Tooltip text={t('Transmit power, in dBm.')} position="top">
				<span class="field-label">{t('TX Power')}</span>
			</Tooltip>
			<NumberInput
				bind:value={batchPower}
				min={1}
				max={36}
				step={1}
				label="dBm"
			/>
		</div>

		<div class="delete-section">
			<Button variant="danger" size="sm" onclick={handleDeleteAll}>
				<Icon name="trash" size={14} />
				{t('Delete All')}
			</Button>
		</div>
	</div>
{/if}

<style>
	.editor {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		padding-top: var(--space-3);
		border-top: 1px solid var(--border-subtle);
	}

	.section-header {
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		color: var(--text-tertiary);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		font-weight: 500;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.field-label {
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		color: var(--text-tertiary);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.input-with-clear {
		position: relative;
		display: flex;
		align-items: center;
	}

	.input-with-clear .text-input {
		padding-right: 24px;
	}

	.clear-input-btn {
		position: absolute;
		right: 4px;
		width: 18px;
		height: 18px;
		padding: 0;
		border: none;
		background: none;
		color: var(--text-tertiary);
		font-size: 14px;
		line-height: 1;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 50%;
	}

	.clear-input-btn:hover {
		color: var(--text-primary);
		background: var(--bg-hover);
	}

	.text-input {
		width: 100%;
		height: 28px;
		background: var(--bg-surface);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		padding: 0 var(--space-2);
		outline: none;
		transition: border-color var(--transition-fast);
		box-sizing: border-box;
	}

	.text-input:focus {
		border-color: var(--accent-primary);
	}

	.position-row {
		display: flex;
		gap: var(--space-2);
	}

	.position-field {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		flex: 1;
		height: 28px;
		padding: 0 var(--space-2);
		background: var(--bg-surface);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
	}

	.pos-label {
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		color: var(--text-tertiary);
		text-transform: uppercase;
	}

	.pos-value {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		color: var(--text-secondary);
	}

	.neighbors {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.neighbor-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-1) var(--space-2);
		background: var(--bg-surface);
		border: none;
		border-radius: var(--radius-md);
		font-size: var(--text-sm);
		font-family: var(--font-sans);
		width: 100%;
		text-align: left;
	}

	.neighbor-row.clickable {
		cursor: pointer;
	}

	.neighbor-row.clickable:hover {
		background: var(--bg-hover);
	}

	.neighbor-name {
		flex: 1;
		color: var(--text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.neighbor-overlap {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		white-space: nowrap;
	}

	.neighbor-overlap.low {
		color: var(--color-success);
	}

	.neighbor-overlap.med {
		color: var(--color-warning);
	}

	.neighbor-overlap.high {
		color: var(--color-error);
	}

	.conflict-badge {
		font-size: var(--text-xs);
		font-weight: 500;
		color: var(--color-error);
		background: var(--color-error-dim);
		padding: 0 var(--space-1);
		border-radius: var(--radius-full, 9999px);
		white-space: nowrap;
	}

	.delete-section {
		padding-top: var(--space-3);
		border-top: 1px solid var(--border-subtle);
	}

	.field-hint {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		color: var(--text-tertiary);
		margin-top: 2px;
	}

	.mount-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	/* The facing row sits under the beam/aim row, in the same rhythm. */
	.facing-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin-top: var(--space-2);
	}

	.facing-row .field-label {
		flex: 1;
	}

	.pin-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		width: 100%;
		margin-top: var(--space-2);
		padding: 4px 6px;
		font-family: inherit;
		font-size: var(--text-sm);
		color: var(--text-secondary);
		background: transparent;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	.pin-row:hover {
		background: var(--bg-hover);
	}

	.pin-row.on {
		color: var(--text-primary);
	}

	/* The same switch the raised-surface card draws, so "a state" looks the same everywhere. */
	.toggle-track {
		position: relative;
		width: 28px;
		height: 16px;
		border-radius: 999px;
		background: var(--bg-surface);
		border: 1px solid var(--border-default);
		transition: background var(--transition-fast), border-color var(--transition-fast);
	}

	.pin-row.on .toggle-track {
		background: var(--accent-primary);
		border-color: var(--accent-primary);
	}

	.toggle-knob {
		position: absolute;
		top: 1px;
		left: 1px;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: var(--text-secondary);
		transition: transform var(--transition-fast), background var(--transition-fast);
	}

	.pin-row.on .toggle-knob {
		transform: translateX(12px);
		background: #0b0d12;
	}

	.mount-height {
		width: 64px;
		height: 28px;
		background: var(--bg-surface);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		color: var(--text-primary);
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		padding: 0 var(--space-2);
		outline: none;
		box-sizing: border-box;
	}

	.mount-height:focus {
		border-color: var(--accent-primary);
	}

	.mount-height:disabled {
		cursor: not-allowed;
	}

	.mount-unit {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		color: var(--text-tertiary);
		/* "° in plan" is two words: without this the unit wraps under the field. */
		white-space: nowrap;
	}


	.back-row {
		display: flex;
		align-self: flex-start;
	}

	/* A framed square like the toolbar controls: the label is gone, the tooltip keeps it. */
	.back-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		padding: 0;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm);
		background: var(--bg-surface);
		color: var(--text-secondary);
		cursor: pointer;
		transition: all var(--transition-fast);
	}

	.back-btn:hover {
		color: var(--text-primary);
		background: var(--bg-hover);
		border-color: var(--border-default);
	}

	.back-btn:focus-visible {
		outline: 2px solid var(--accent-primary);
		outline-offset: 1px;
	}

	.multi-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.deselect-link {
		background: none;
		border: none;
		color: var(--accent-primary);
		font-size: var(--text-xs);
		cursor: pointer;
		padding: 0;
	}

	.deselect-link:hover {
		text-decoration: underline;
	}

	.deselect-link:focus-visible {
		outline: 2px solid var(--accent-primary);
		outline-offset: 1px;
	}

	.field :global(.tooltip-wrapper) {
		display: flex;
		width: 100%;
	}
</style>
