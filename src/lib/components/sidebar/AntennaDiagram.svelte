<script lang="ts">
	import { antennaProfileForMount, azimuthGainDb, elevationGainDb } from '$lib/rf/antenna.js';
	import { rampCss } from '$lib/canvas/heatmap-ramp.js';
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
	const H = 210;
	const CX = W / 2;
	const CY = 98;
	const R = 58;

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

	function project(thetaDeg: number, bearingDeg: number, radius: number) {
		const theta = (thetaDeg * Math.PI) / 180;
		const bearing = (bearingDeg * Math.PI) / 180;
		const x = Math.cos(theta) * Math.cos(bearing);
		const y = Math.cos(theta) * Math.sin(bearing);
		const z = Math.sin(theta);
		return {
			x: CX + (x - y) * R * radius,
			y: CY + (x + y) * R * 0.34 * radius + z * R * 0.82 * radius
		};
	}

	/** Constant-elevation rings of the 3D pattern; radius is linear field strength. */
	const rings = $derived.by(() => {
		const out: Array<{ d: string; color: string; key: number }> = [];
		for (let theta = -80; theta <= 80; theta += 16) {
			let d = '';
			let peak = -Infinity;
			for (let bearing = 0; bearing <= 360; bearing += 12) {
				const gain =
					elevationGainDb(theta, profile) + azimuthGainDb(bearing, profile);
				peak = Math.max(peak, gain);
				const radius = Math.pow(10, Math.max(-24, gain) / 20);
				const point = project(theta, bearing, radius);
				d += `${d ? 'L' : 'M'} ${point.x.toFixed(1)} ${point.y.toFixed(1)} `;
			}
			const band = Math.max(0, Math.min(1, (peak + 12) / 12));
			out.push({ d: `${d}Z`, color: rampCss(band), key: theta });
		}
		return out;
	});

	/** Longitude lines make the surface read as 3D even at the back. */
	const meridians = $derived.by(() => {
		const out: Array<{ d: string; color: string; key: number }> = [];
		for (let bearing = 0; bearing < 360; bearing += 30) {
			let d = '';
			let peak = -Infinity;
			for (let theta = -80; theta <= 80; theta += 10) {
				const gain =
					elevationGainDb(theta, profile) + azimuthGainDb(bearing, profile);
				peak = Math.max(peak, gain);
				const radius = Math.pow(10, Math.max(-24, gain) / 20);
				const point = project(theta, bearing, radius);
				d += `${d ? 'L' : 'M'} ${point.x.toFixed(1)} ${point.y.toFixed(1)} `;
			}
			const band = Math.max(0, Math.min(1, (peak + 12) / 12));
			out.push({ d, color: rampCss(band), key: bearing });
		}
		return out;
	});

	const halfH = Math.min(180, Math.max(1, (horizontalBeamwidthDeg ?? 360) / 2));
	const planPath = $derived.by(() => {
		const planW = 260;
		const planH = 132;
		const cx = planW / 2;
		const cy = planH / 2;
		const r = 52;
		if ((horizontalBeamwidthDeg ?? 360) >= 360) {
			return `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0`;
		}
		const start = ((facingDeg - halfH) * Math.PI) / 180;
		const end = ((facingDeg + halfH) * Math.PI) / 180;
		const p1 = [cx + r * Math.cos(start), cy + r * Math.sin(start)];
		const p2 = [cx + r * Math.cos(end), cy + r * Math.sin(end)];
		const large = halfH > 90 ? 1 : 0;
		return `M ${cx} ${cy} L ${p1[0]} ${p1[1]} A ${r} ${r} 0 ${large} 1 ${p2[0]} ${p2[1]} Z`;
	});

	const planCenter = { x: 130, y: 66 };
	const planR = 52;
	const ceiling = Math.min(Math.max(ceilingHeightM, 1.8), 6);
	const heightM = Math.min(Math.max(mountHeightM, 0), ceiling);
</script>

<div class="antenna-figure">
	<div class="figure-head">
		<span>{t('3D lobe')}</span>
		<span class="figure-meta">
			V {Math.round(beamwidthDeg)}° · H {Math.round(horizontalBeamwidthDeg ?? 360)}° ·
			{t('Aim')} {Math.round(aimDeg)}°
			{#if mount === 'wall' || (horizontalBeamwidthDeg ?? 360) < 360}
				· {t('Facing')} {Math.round(facingDeg)}°
			{/if}
		</span>
	</div>

	<svg viewBox="0 0 {W} {H}" class="lobe" role="img" aria-label="Antenna 3D lobe">
		<ellipse cx={CX} cy={CY + R * 0.9} rx={R * 0.95} ry={R * 0.32} class="ground-plane" />
		<line x1={CX} y1={CY - R * 0.8} x2={CX} y2={CY + R * 1.1} class="axis" />
		<line x1={CX - R} y1={CY} x2={CX + R} y2={CY} class="axis" />

		{#each rings as ring (ring.key)}
			<path d={ring.d} fill="none" stroke={ring.color} stroke-width="1.35" opacity="0.92" />
		{/each}
		{#each meridians as meridian (meridian.key)}
			<path d={meridian.d} fill="none" stroke={meridian.color} stroke-width="0.7" opacity="0.5" />
		{/each}

		<circle cx={CX} cy={CY} r="4" class="ap" />
		<line
			x1={CX}
			y1={CY}
			x2={CX + Math.cos((aimDeg * Math.PI) / 180) * R * 0.82}
			y2={CY + Math.sin((aimDeg * Math.PI) / 180) * R * 0.82}
			class="aim-line"
		/>
	</svg>

	<div class="figure-foot">
		<span>{mount === 'ceiling' ? `${heightM.toFixed(1)} m` : ''}</span>
		<span>{t('Pol')} {polarizationMode === 'dual' ? 'V+H' : 'single'}</span>
	</div>
</div>

<div class="plan-wrap">
	<div class="plan-label">{t('Plan view')}</div>
	<svg viewBox="0 0 260 132" class="plan-diagram" role="img" aria-label="Antenna coverage in plan">
		<path d={planPath} class="plan-lobe" />
		<circle cx={planCenter.x} cy={planCenter.y} r="4" class="ap" />
		{#if (horizontalBeamwidthDeg ?? 360) < 360}
			<line
				x1={planCenter.x}
				y1={planCenter.y}
				x2={planCenter.x + planR * Math.cos((facingDeg * Math.PI) / 180)}
				y2={planCenter.y + planR * Math.sin((facingDeg * Math.PI) / 180)}
				class="facing-line"
			/>
		{/if}
	</svg>
</div>

<style>
	.antenna-figure {
		margin-top: var(--space-2);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm);
		background: var(--bg-surface);
		padding: var(--space-1) var(--space-2) 0;
	}
	.figure-head,
	.figure-foot {
		display: flex;
		justify-content: space-between;
		gap: var(--space-2);
		font-size: var(--text-xs);
		color: var(--text-tertiary);
	}
	.figure-head {
		padding-top: var(--space-1);
	}
	.figure-meta {
		color: var(--text-secondary);
		text-align: right;
	}
	.lobe {
		display: block;
		width: 100%;
		height: auto;
	}
	.ground-plane {
		fill: rgba(255, 255, 255, 0.04);
		stroke: var(--border-subtle);
		stroke-width: 1;
	}
	.axis {
		stroke: var(--border-subtle);
		stroke-width: 0.8;
		stroke-dasharray: 3 4;
	}
	.aim-line {
		stroke: rgba(234, 255, 246, 0.45);
		stroke-width: 1;
		stroke-dasharray: 3 3;
	}
	.ap {
		fill: #22c55e;
		stroke: rgba(255, 255, 255, 0.75);
		stroke-width: 1;
	}
	.figure-foot {
		padding-bottom: var(--space-1);
	}
	.plan-wrap {
		margin-top: var(--space-2);
		border-top: 1px solid var(--border-subtle);
		padding-top: var(--space-1);
	}
	.plan-label {
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
