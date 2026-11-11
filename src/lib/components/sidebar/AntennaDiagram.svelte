<script lang="ts">
	import {
		antennaProfileForMount,
		azimuthLossDb,
		elevationGainDb
	} from '$lib/rf/antenna.js';
	import { rampCss } from '$lib/canvas/heatmap-ramp.js';
	// The client plane a low-mounted unit is measured against is the project's own client
	// height — the height the coverage figure is computed at, so the two agree.
	import { projectMeta } from '$state/project-meta.svelte';
	import { t } from '$state/i18n.svelte.js';

	let {
		beamwidthDeg,
		horizontalBeamwidthDeg = 360,
		aimDeg,
		mountHeightM,
		ceilingHeightM,
		band,
		mount = 'ceiling',
		facingDeg = 0,
		polarizationMode = 'single'
	}: {
		beamwidthDeg: number;
		horizontalBeamwidthDeg?: number;
		aimDeg: number;
		mountHeightM: number;
		ceilingHeightM: number;
		band: string;
		mount?: string;
		facingDeg?: number;
		polarizationMode?: 'single' | 'dual';
	} = $props();

	const W = 260;
	const PAD = 10;
	/** Metres of floor across the box; one scale for both axes, so it sets the height too. */
	const SPAN_X = 13.5;
	const SCALE = W / SPAN_X;
	const CEILING_MAX_M = 6;
	const BAR_STEP = 8;
	const BAR_W = 4.5;
	const GROUND = 4;
	const ceilingM = $derived(clamp(ceilingHeightM, 1.8, CEILING_MAX_M));
	const CEILING_Y = PAD;
	const FLOOR_Y = $derived(Math.round(CEILING_Y + ceilingM * SCALE));
	const H = $derived(FLOOR_Y + GROUND + PAD);
	const AP_X = W / 2;

	function clamp(value: number, lo: number, hi: number): number {
		return Math.min(Math.max(value, lo), hi);
	}

	/** The AP's own mounting height above the floor, in drawing units. */
	const apY = $derived(FLOOR_Y - clamp(mountHeightM, 0, ceilingM) * SCALE);

	const serveAbove = $derived(mount === 'floor');
	const clientPlaneM = $derived(clamp(projectMeta.clientHeight, mountHeightM + 0.2, ceilingM));
	const serveY = $derived(serveAbove ? FLOOR_Y - clientPlaneM * SCALE : FLOOR_Y);
	const profile = $derived(
		antennaProfileForMount({
			band,
			beamwidthDeg,
			horizontalBeamwidthDeg,
			aimDeg,
			mount,
			facingDeg
		})
	);
	const bars = $derived.by(() => {
		// The vertical drop from the unit to the plane it is measured on: for a ceiling
		// mount that is its height above the floor, for a low mount the clients' height
		// above it.
		const drop = Math.abs(serveY - apY);
		const full = (FLOOR_Y - CEILING_Y) * 0.78;
		const out: Array<{ x: number; h: number; color: string }> = [];
		for (let x = BAR_STEP / 2; x < W; x += BAR_STEP) {
			const offset = x - AP_X;
			const horizontal = Math.abs(offset) / SCALE;
			const angle = (Math.atan2(drop / SCALE, Math.max(horizontal, 0.01)) * 180) / Math.PI;
			const bearing = facingDeg + (offset < 0 ? 180 : 0);
			const loss =
				-elevationGainDb(angle, profile) + azimuthLossDb(bearing, profile);
			const strength = 1 - clamp(loss / profile.floorDb, 0, 1);
			out.push({ x, h: Math.max(3, strength * full), color: rampCss(strength) });
		}
		return out;
	});

	/** The best-served patch of floor: the spot a change of aim moves. */
	const bestX = $derived.by(() => {
		const usable = bars.filter((bar) => bar.x >= PAD + 16 && bar.x <= W - PAD - 26);
		if (usable.length === 0) return null;
		return usable.reduce((best, bar) => (bar.h > best.h ? bar : best)).x;
	});

	const PLAN_W = 260;
	const PLAN_H = 140;
	const PLAN_CX = PLAN_W / 2;
	const PLAN_CY = PLAN_H / 2;
	const PLAN_R = 58;
	const halfHorizontal = $derived(
		Math.min(180, Math.max(1, (horizontalBeamwidthDeg ?? 360) / 2))
	);
	const planPath = $derived.by(() => {
		if ((horizontalBeamwidthDeg ?? 360) >= 360) {
			return `M ${PLAN_CX - PLAN_R} ${PLAN_CY} a ${PLAN_R} ${PLAN_R} 0 1 0 ${PLAN_R * 2} 0 a ${PLAN_R} ${PLAN_R} 0 1 0 ${-PLAN_R * 2} 0`;
		}
		const start = ((facingDeg - halfHorizontal) * Math.PI) / 180;
		const end = ((facingDeg + halfHorizontal) * Math.PI) / 180;
		const p1 = [PLAN_CX + PLAN_R * Math.cos(start), PLAN_CY + PLAN_R * Math.sin(start)];
		const p2 = [PLAN_CX + PLAN_R * Math.cos(end), PLAN_CY + PLAN_R * Math.sin(end)];
		const large = halfHorizontal > 90 ? 1 : 0;
		return `M ${PLAN_CX} ${PLAN_CY} L ${p1[0]} ${p1[1]} A ${PLAN_R} ${PLAN_R} 0 ${large} 1 ${p2[0]} ${p2[1]} Z`;
	});
</script>

<svg viewBox="0 0 {W} {H}" class="diagram" role="img" aria-label="Antenna strength across the floor">
	<rect x="0" y={FLOOR_Y} width={W} height={GROUND} class="ground" />
	<line x1="0" y1={FLOOR_Y} x2={W} y2={FLOOR_Y} class="floor" />

	<g transform={serveAbove ? `translate(0 ${2 * serveY}) scale(1 -1)` : undefined}>
		{#each bars as bar, i (i)}
			<rect
				x={bar.x - BAR_W / 2}
				y={serveY - bar.h}
				width={BAR_W}
				height={bar.h}
				rx="1"
				fill={bar.color}
			/>
		{/each}

		{#if bestX !== null}
			<!-- A client, on the strongest patch: the spot a change of aim moves. -->
			<rect x={bestX - 4.5} y={serveY - 10} width="9" height="7" rx="1" class="client" />
			<path
				d={`M ${bestX - 6},${serveY - 3} L ${bestX + 6},${serveY - 3} L ${bestX + 7},${serveY} L ${bestX - 7},${serveY} Z`}
				class="client"
			/>
		{/if}
	</g>

	<line x1="0" y1={CEILING_Y} x2={W} y2={CEILING_Y} class="ceiling" />
	{#if mount === 'wall'}
		<!--
			The wall it is on, and the bracket itself. The section runs through the wall's
			normal, so the half to the left of that line is the floor behind the unit.
		-->
		<line x1={AP_X} y1={CEILING_Y} x2={AP_X} y2={FLOOR_Y} class="wall" />
		<rect x={AP_X - 3} y={apY - 7} width="6" height="14" rx="2" class="ap" />
	{:else}
		<circle cx={AP_X} cy={apY} r="3.5" class="ap" />
	{/if}
</svg>

<div class="plan-wrap">
	<div class="plan-label">{t('Plan view')}</div>
	<svg viewBox="0 0 {PLAN_W} {PLAN_H}" class="plan-diagram" role="img" aria-label="Antenna coverage in plan">
		<path d={planPath} class="plan-lobe" />
		<circle cx={PLAN_CX} cy={PLAN_CY} r="4" class="ap" />
		{#if (horizontalBeamwidthDeg ?? 360) < 360}
			<line
				x1={PLAN_CX}
				y1={PLAN_CY}
				x2={PLAN_CX + PLAN_R * Math.cos((facingDeg * Math.PI) / 180)}
				y2={PLAN_CY + PLAN_R * Math.sin((facingDeg * Math.PI) / 180)}
				class="facing-line"
			/>
		{/if}
	</svg>
	<div class="plan-meta">
		H {Math.round(horizontalBeamwidthDeg ?? 360)}° · V {Math.round(beamwidthDeg)}° · Pol
		{polarizationMode === 'dual' ? 'V+H' : 'single'}
	</div>
</div>

<style>
	.diagram {
		display: block;
		width: 100%;
		height: auto;
		background: var(--bg-surface);		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm);
	}

	/* The bars take their colour from the ramp, so their height and colour agree. */

	.floor {
		stroke: var(--border-default);
		stroke-width: 1;
	}

	.ground {
		fill: rgba(255, 255, 255, 0.05);
	}

	.ceiling {
		stroke: var(--border-subtle);
		stroke-width: 1;
		stroke-dasharray: 4 4;
	}

	/* The wall a wall-mounted unit is on: the section runs through its normal. */
	.wall {
		stroke: var(--border-default);
		stroke-width: 2;
	}

	.client {
		fill: #eafff6;
	}

	.ap {
		fill: #22c55e;
		stroke: rgba(255, 255, 255, 0.75);
		stroke-width: 1;
	}

	.plan-wrap {
		margin-top: var(--space-2);
		border-top: 1px solid var(--border-subtle);
		padding-top: var(--space-1);
	}
	.plan-label,
	.plan-meta {
		font-size: var(--text-xs);
		color: var(--text-tertiary);
	}
	.plan-diagram {
		display: block;
		width: 100%;
		height: auto;
	}
	.plan-lobe {
		fill: rgba(34, 197, 94, 0.16);
		stroke: rgba(34, 197, 94, 0.75);
		stroke-width: 1;
	}
	.facing-line {
		stroke: rgba(234, 255, 246, 0.7);
		stroke-width: 1;
		stroke-dasharray: 3 3;
	}
</style>
