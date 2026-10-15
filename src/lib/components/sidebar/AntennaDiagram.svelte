<script lang="ts">
	/**
	 * What the antenna's beam and aim do to the floor, drawn.
	 *
	 * The picture is a row of bars standing on the floor, and the height of each is the
	 * antenna's own strength at that patch of it — the same elevation cut the heatmap
	 * uses, and the same colour ramp, so the bars cannot disagree with the map they sit
	 * next to. Height and colour are the one encoding that needs no vocabulary: nobody
	 * has to be taught that the tall green ones are the good ones, or that the gap under
	 * the AP is where the signal is weakest. A pattern shape was tried first and had to
	 * be explained, which is the same as not working.
	 *
	 * The two settings are visible as the profile they produce, which is why there are no
	 * arrows on the AP any more: a level omni leaves the floor under itself weak and the
	 * far floor strong, tilting brings the tall bars in towards the AP, and narrowing the
	 * beam flattens all of them, since the strongest direction has moved off the angles
	 * this floor is seen at. The device stands on the tallest bar: the spot a change of
	 * aim moves.
	 *
	 * A **wall mount** is drawn as the section through the direction it faces: the wall
	 * is the line the AP sits on, the half behind it is at the front-to-back figure, and
	 * the picture stops being symmetric — which is the whole difference between the two
	 * mountings.
	 */
	import {
		antennaProfileForMount,
		azimuthLossDb,
		elevationGainDb
	} from '$lib/rf/antenna.js';
	import { rampCss } from '$lib/canvas/heatmap-ramp.js';
	// The client plane a low-mounted unit is measured against is the project's own client
	// height — the height the coverage figure is computed at, so the two agree.
	import { projectMeta } from '$state/project-meta.svelte';

	let {
		beamwidthDeg,
		aimDeg,
		mountHeightM,
		ceilingHeightM,
		band,
		mount = 'ceiling',
		facingDeg = 0
	}: {
		beamwidthDeg: number;
		aimDeg: number;
		mountHeightM: number;
		ceilingHeightM: number;
		band: string;
		mount?: string;
		facingDeg?: number;
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

	/**
	 * The plane this picture measures the pattern on, and which way the bars grow.
	 *
	 * A ceiling-mounted unit radiates down at the floor beneath it, so the floor is the
	 * surface to draw: reddest where the beam lands, weakest at the edges. A low-mounted
	 * one is the other way round — it sits *under* the clients and radiates up at them —
	 * and drawing the floor two metres below it showed the back of the antenna instead,
	 * which is why the two mounts' pictures looked the same.
	 *
	 * So a floor mount is measured against the client plane above it, and the drawing is
	 * mirrored about that plane, so the bars hang from it towards the unit and the beam
	 * visibly points up.
	 */
	const serveAbove = $derived(mount === 'floor');
	const clientPlaneM = $derived(clamp(projectMeta.clientHeight, mountHeightM + 0.2, ceilingM));
	const serveY = $derived(serveAbove ? FLOOR_Y - clientPlaneM * SCALE : FLOOR_Y);

	/**
	 * The band's pattern, with the edited numbers in it — the same profile the models use.
	 *
	 * Including the mount: a wall-mounted unit has a horizontal cut, and this picture
	 * would otherwise show a front and a back as equal.
	 */
	const profile = $derived(
		antennaProfileForMount({ band, beamwidthDeg, aimDeg, mount, facingDeg })
	);

	/**
	 * The bars: the antenna's loss under each patch of floor, as height.
	 *
	 * A metre more or less of floor is a couple of degrees of depression angle at this
	 * range, so sampling every 0.4 m is far finer than the curve can move.
	 *
	 * The section is drawn *along the facing direction* of a wall mount, so the half to
	 * the right of the AP is the part it was pointed at and the half to the left is
	 * behind it, at the front-to-back figure. For an upright omni the two are the same
	 * ray and the term is zero, which is why the picture has always looked symmetric.
	 */
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
</script>

<svg viewBox="0 0 {W} {H}" class="diagram" role="img" aria-label="Antenna strength across the floor">
	<rect x="0" y={FLOOR_Y} width={W} height={GROUND} class="ground" />
	<line x1="0" y1={FLOOR_Y} x2={W} y2={FLOOR_Y} class="floor" />

	<!--
		The bars and the client are drawn against the served plane; for a low mount the
		whole group is mirrored about it, so the antenna's beam points up at the clients
		without either shape being written twice.
	-->
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

<style>
	.diagram {
		display: block;
		width: 100%;
		height: auto;
		background: var(--bg-surface);
		border: 1px solid var(--border-subtle);
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
</style>
