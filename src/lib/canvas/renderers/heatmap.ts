import type { Layer, RenderContext } from '../types.js';
import type { AccessPoint } from '$state/ap-state.svelte.js';

/** AP with optional cross-floor parameters for 3D propagation. */
type HeatmapAp = AccessPoint & {
	verticalOffset?: number; // meters — ceiling height × floor distance
	floorDbPerMeter?: number; // dB/m through the slab material
	floorThickness?: number; // slab thickness in meters
	/**
	 * The AP's own floor, for splitting the path at the slab.
	 *
	 * A cross-floor path is not attenuated by one floor's walls: the ray leaves the
	 * AP through its own storey, drops through the slab, and finishes in the storey
	 * below. Charging the whole horizontal run against this floor — which is what
	 * the heatmap did — puts two thirds of a typical run (an AP 4.5 m above its
	 * client, slab crossed two thirds along) against the wrong plan.
	 *
	 * Null or absent when the AP is on this floor, or when no mask is available for
	 * its floor; the path is then the single run it always was.
	 */
	crossFloor?: {
		mask: DecodedWallMask;
		materialMap: Uint8Array | null;
		defaultMaterial: WallMaterialId;
		/** Fraction along the ray where it leaves the AP's own floor. */
		sourceT: number;
		/** Fraction along the ray where it enters this floor. */
		targetT: number;
		/**
		 * Room types of the floor whose slab this path crosses — the upper of the two.
		 *
		 * A `Void / Atrium` label there is a hole in that slab, so a ray crossing at
		 * that point meets no concrete and pays no slab loss. Null leaves the loss in
		 * place everywhere, which is the conservative reading.
		 */
		slabRoomType?: {
			data: Uint8Array;
			width: number;
			height: number;
			originX: number;
			originY: number;
		} | null;
		/** Fraction along the ray at which the slab is crossed. */
		slabT?: number;
	} | null;
};
import type { DecodedWallMask } from '../wall-detect.js';
import type { WallMaterialId } from '../materials.js';
import { getMaterialDbTable, getFlatAttenuation } from '../materials.js';
import type { Band } from '@aetherax/channels';
import { crossFloorSegments, pointAlong, slabIsVoid } from '$lib/rf/cross-floor.js';
import { heatmapRegion } from './heatmap-region.js';
import {
	pathLossDb,
	relativePathLossDb,
	getAttenField,
	lookupAtten,
	rayMarchWallAtten,
	invalidateAttenCache,
	type AttenField
} from '../../rf/propagation.js';
import { antennaRayLossDb, antennaSignature, type AntennaProfile } from '../../rf/antenna.js';
import { surfaceHeightAt, deckCrossing, type ElevatedSurface as ElevatableSurface } from '../../rf/surface-height.js';
import { reflections, type ReflectingWall } from '../../rf/reflection.js';
import { diffractionLossDb, edgesOf, type DiffractionEdge } from '../../rf/diffraction.js';

/**
 * Wall loss above which the direct path counts as blocked.
 *
 * Kept for documentation: the gate is now a ramp from 3 dB to 9 dB (see the loop), and a hard
 * threshold at this figure drew the contour where it flipped as a visible notch.
 */
const DIFFRACTION_BLOCKED_DB = 6;
import { rampColorAt } from '../heatmap-ramp.js';
import { maskSignature } from '../mask-registry.js';
import { antennaProfileFor } from '$state/ap-state.svelte.js';

/**
 * World units per heatmap texel.
 *
 * The heatmap used to be generated in SCREEN space: one cell per 6 screen
 * pixels, with every cell's world position recovered through the inverse camera
 * transform. That made the camera part of the cache key, so every pan and every
 * zoom step re-ran the whole per-cell physics and rewrote every canvas pixel —
 * and the drag-time "fast mode" only reduced the cell count, not the rewrite.
 *
 * Generating in WORLD space instead means the image is a function of the APs
 * and the walls only. Panning and zooming become a single `drawImage` under the
 * camera transform, exactly as the wall layer already does.
 *
 * The trade is resolution: the image is upscaled when zoomed in rather than
 * recomputed, so a coarse texel shows as a staircase along the coverage contour —
 * which is what a 4-world-unit grid did at 100 % zoom. One unit is a screen pixel at
 * 1:1, so the contour is as smooth as the projector allows; the budget below is what
 * keeps the cost of that on a large plan. COARSE is used while an AP is dragged so
 * the rebuild stays inside a frame.
 */
/**
 * World units per heatmap texel.
 *
 * This was 1 — one world unit per texel — which is a screen pixel at 1:1 zoom and gave the
 * smoothest contour, but the cost of a texel is now a **wall march** rather than a field lookup
 * (the polar field's angular slices were what drew spikes, so the heatmap marches each texel's
 * own ray). At one unit a 900 × 700 plan is 630 000 texels and two APs is 1.3 M marches; at three
 * it is 70 000 and the level grid is blurred anyway (see `boxBlurLevels`), so the contour is
 * smoother rather than rougher for the same picture.
 */
const TEXEL_FINE = 3;
const TEXEL_COARSE = 12;
/**
 * Upper bound on the number of texels one regeneration may fill.
 *
 * The displayed image is a smooth ramp, so its resolution only has to be fine
 * enough to look continuous — and the per-texel work is the bulk of the cost.
 * A million cells keeps the full `TEXEL_FINE` spacing on a plan up to ~2000 × 2000
 * world units (~28 m square here) and widens the texel beyond that rather than
 * cropping. The rebuild is cached and only runs when the APs or the walls change.
 */
const MAX_TEXELS = 1_000_000;

/**
 * How far past each AP's association radius its attenuation field is marched.
 *
 * The field has to cover every texel the image can draw plus the crossing points
 * a split cross-floor path reads, so it is sized from the radius rather than from
 * the image's own (smaller) rectangle. That over-covers on purpose: `lookupAtten`
 * returns the field's far-edge value beyond its last bucket, so a field that
 * stopped inside the drawn area would silently flatten the outer rings.
 */
const FIELD_MARGIN_FACTOR = 1.65;

/**
 * Default lowest received level the ramp shows, in dBm.
 *
 * -85 dBm is the receiver sensitivity the range model already uses
 * (`RECEIVER_SENSITIVITY_DBM` in rf/propagation.ts), so the default shows
 * exactly the region where a link could still be established — which is the
 * same extent as the coverage circle drawn around each AP.
 *
 * This replaced an abstract "dB window below the 1 m reference". That number
 * had no physical meaning on its own: a 20 dB window sounds modest but is only
 * a 3.2 m radius, and it bore no visible relation to the AP's coverage circle.
 */
const DEFAULT_RSSI_FLOOR = -85;

// Color LUT — 256 entries, built once, from the shared ramp (`canvas/heatmap-ramp.ts`).
function packColor(r: number, g: number, b: number, a: number): number {
	return ((a & 0xff) << 24) | ((b & 0xff) << 16) | ((g & 0xff) << 8) | (r & 0xff);
}

const LUT = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
	const c = rampColorAt(i / 255);
	LUT[i] = packColor(c.r, c.g, c.b, c.a);
}
// LUT[0] must be exactly 0 so the `!color` skip works for transparent pixels
LUT[0] = 0;

/**
 * Point in a closed polygon, by the crossing-number test.
 *
 * The clip is a floor's outline — a handful of corners — so the linear scan is the right
 * algorithm: a spatial index would cost more than it saves at this vertex count.
 */
function pointInPolygon(
	x: number,
	y: number,
	polygon: ReadonlyArray<{ x: number; y: number }>
): boolean {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const xi = polygon[i]!.x;
		const yi = polygon[i]!.y;
		const xj = polygon[j]!.x;
		const yj = polygon[j]!.y;
		const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
		if (intersects) inside = !inside;
	}
	return inside;
}

/**
 * Separable 3×3 box blur over a level grid, twice, ignoring missing texels.
 *
 * The field the loop computes is exact per texel, which also means its shadow boundaries are
 * exact lines and its colouring is piecewise constant: on a plan that reads as hard wedges and a
 * staircase along every contour. Smoothing the levels — not the colours, which would blend
 * across the ramp's hue wheel — is what makes the picture continuous, and NaN (a texel below the
 * ramp floor) is skipped rather than averaged in as a level, so no bright fringe appears around
 * the covered area.
 */
function boxBlurLevels(levels: Float32Array, cols: number, rows: number): Float32Array {
	let source = levels;
	for (let pass = 0; pass < 2; pass++) {
		const target = new Float32Array(cols * rows).fill(Number.NaN);
		for (let y = 0; y < rows; y++) {
			const y0 = y > 0 ? y - 1 : 0;
			const y1 = y < rows - 1 ? y + 1 : rows - 1;
			for (let x = 0; x < cols; x++) {
				const x0 = x > 0 ? x - 1 : 0;
				const x1 = x < cols - 1 ? x + 1 : cols - 1;
				let sum = 0;
				let count = 0;
				for (let sy = y0; sy <= y1; sy++) {
					const row = sy * cols;
					for (let sx = x0; sx <= x1; sx++) {
						const value = source[row + sx]!;
						if (!Number.isNaN(value)) {
							sum += value;
							count++;
						}
					}
				}
				target[y * cols + x] = count > 0 ? sum / count : Number.NaN;
			}
		}
		source = target;
	}
	return source;
}

/**
 * Heatmap layer — synchronous main-thread rendering.
 *
 * Wall attenuation uses precomputed fields from rf/propagation.ts (O(1) lookup).
 * No Web Worker, no async state. Renders in the same frame as everything else.
 * Typical render time: 2-7ms (well within 16ms frame budget).
 */
/**
 * Everything `generateWorld` reads off the layer, so a generation can be run for
 * a floor other than the one the layer is currently showing.
 */
export interface HeatmapInput {
	aps: HeatmapAp[];
	wallMask: DecodedWallMask | null;
	materialMap: Uint8Array | null;
	defaultMaterial: WallMaterialId;
	worldUnitsPerMeter: number;
	rssiFloor: number;
	/** Identity of `wallMask` for the attenuation-field cache. See `maskTag`. */
	maskTag?: string;
	/**
	 * Raised walking surfaces on this floor: a mezzanine, a stair, a ramp.
	 *
	 * The level a client receives depends on the vertical gap to the AP, and a client
	 * two metres up a mezzanine is two metres closer to a ceiling-mounted one. Each
	 * texel reads this field, so a raised area is coloured as the raised place it is
	 * rather than as the slab underneath it.
	 */
	surfaces?: ElevatableSurface[];
}

export class HeatmapLayer implements Layer {
	id = 'heatmap';
	visible = false;
	aps: HeatmapAp[] = [];
	/**
	 * Retained for API compatibility but no longer affects the heatmap: the ramp
	 * is a signal-level (dB) scale now, so a throughput cap has nothing to clamp.
	 * The throughput panel still uses it.
	 */
	ispSpeed = 0;
	wallMask: DecodedWallMask | null = null;
	wallAttenuation = 5;
	materialMap: Uint8Array | null = null;
	materialVersion = 0;
	defaultMaterial: WallMaterialId = 0;
	/** Raised walking surfaces on the floor this image is for. See `HeatmapInput`. */
	surfaces: ElevatableSurface[] = [];
	/**
	 * Wall segments, for the one specular reflection this renderer carries.
	 *
	 * Separate from `wallMask` on purpose: the mask is what blocks, the segments are what
	 * reflects, and a reflection needs the segment's own line (a mask pixel has no normal).
	 * Empty means no reflection, which is what a floor whose walls are still only a detected
	 * raster gets — and what a drag gets, since a coarse image does not need the term.
	 */
	reflectingWalls: ReflectingWall[] = [];
	/**
	 * The building's outline, when the plan has one, so the picture stops at the walls.
	 *
	 * Without it the field is painted over the whole sheet: every interior wall throws its shadow
	 * across the margin *outside* the building, which reads as a row of dark spikes leaving the
	 * plan — the wedges that were reported. A planning tool clips its coverage to the floor it is
	 * about, and this is that clip: the detected boundary at import, or the planning area when the
	 * user has drawn one.
	 */
	clipPolygon: Array<{ x: number; y: number }> | null = null;
	isDragging = false;
	/**
	 * A wall mask is on its way for the floor now showing.
	 *
	 * Set when a floor switch clears `wallMask` because the incoming floor's stored
	 * mask still has to be decoded. Generating in that window marches every field and
	 * fills every texel against no walls at all, and the decode throws the result away
	 * — a whole generation of work, on the main thread, for nothing.
	 */
	maskPending = false;
	/**
	 * Identity of the wall mask currently loaded, for the attenuation-field cache.
	 *
	 * `getAttenField`'s key is position, radius and this tag — the mask *contents*
	 * are not in it. Without a per-mask tag two floors that have an AP in the same
	 * 4-unit cell (stacked APs, the normal case) share one field, so whichever
	 * floor is generated second is marched against the **other** floor's walls.
	 * In the tiled overview that is the card that is not selected: the selected
	 * floor warms the cache first and the other card inherits its walls.
	 */
	maskTag = '';
	worldUnitsPerMeter = 32.8; // updated from getEffectiveWupm()
	/**
	 * Lowest received level the ramp shows, in dBm. Anything below is transparent.
	 *
	 * The ramp runs from this floor up to the strongest AP's level at 1 m
	 * (`P_tx - PL0` for its band), so the whole colour range always spans the
	 * usable coverage band and raising the floor both narrows the visible area
	 * and increases contrast.
	 */
	rssiFloor = DEFAULT_RSSI_FLOOR;

	private cache: HTMLCanvasElement | null = null;
	private cacheKey = '';
	/** Where `cache` sits in world space, and its world units per texel. */
	private cacheX0 = 0;
	private cacheY0 = 0;
	private cacheTexel = TEXEL_FINE;

	markWallsDirty(): void {
		this.cacheKey = '';
		invalidateAttenCache();
	}

	/**
	 * Build the cached world-space image if the inputs have changed.
	 *
	 * Split out of `render` so the tiled floor overview can obtain the image
	 * without this layer drawing itself. That view hides this layer, and a hidden
	 * layer is never asked to render, so its cache would otherwise stay empty and
	 * the tile would have nothing to show.
	 *
	 * Synchronous and identical in cost to what a single-floor render already
	 * pays, so calling it from the tile view does not add a second generation
	 * per frame — the cache key absorbs it.
	 */
	ensureGenerated(): void {
		if (this.aps.length === 0) {
			this.cache = null;
			this.cacheKey = '';
			return;
		}
		const key = this.getCacheKey();
		if (key === this.cacheKey) return;
		this.cacheKey = key;
		const started = performance.now();
		const generated = this.generateWorld();
		this.cache = generated?.canvas ?? null;
		this.cacheX0 = generated?.x0 ?? 0;
		this.cacheY0 = generated?.y0 ?? 0;
		this.cacheTexel = generated?.texel ?? TEXEL_FINE;
		// Timed: a generation is a full field sweep over the plan, and it runs on the frame a
		// gesture ends — the one place a stall is felt as "the app froze when I let go".
		console.info(`[heatmap] ${generated ? 'generated' : 'skipped'} in ${Math.round(performance.now() - started)} ms`);
	}

	/**
	 * Generate a world-space coverage image for an arbitrary floor.
	 *
	 * The tiled overview needs one image per floor, and writing a second coverage
	 * renderer for it would guarantee the two drift apart. So this swaps the
	 * layer's inputs for the duration of one generation and restores them.
	 *
	 * Safe because `generateWorld` neither awaits nor touches the layer's own
	 * cache — it only reads these inputs — so nothing can observe the swap.
	 */
	generateFor(
		input: HeatmapInput
	): { canvas: HTMLCanvasElement; x0: number; y0: number; texel: number } | null {
		if (input.aps.length === 0) return null;

		const savedAps = this.aps;
		const savedMask = this.wallMask;
		const savedMaterial = this.materialMap;
		const savedDefaultMaterial = this.defaultMaterial;
		const savedWupm = this.worldUnitsPerMeter;
		const savedRssiFloor = this.rssiFloor;
		const savedDragging = this.isDragging;
		const savedMaskTag = this.maskTag;
		const savedSurfaces = this.surfaces;

		try {
			this.aps = input.aps;
			this.wallMask = input.wallMask;
			this.materialMap = input.materialMap;
			this.defaultMaterial = input.defaultMaterial;
			this.worldUnitsPerMeter = input.worldUnitsPerMeter;
			this.rssiFloor = input.rssiFloor;
			// Which floor's walls these are, so the field cache cannot hand this
			// floor's APs another floor's attenuation. See `maskTag`.
			this.maskTag = input.maskTag ?? '';
			this.surfaces = input.surfaces ?? [];
			// Full resolution: a tile is a still comparison, never a drag.
			this.isDragging = false;
			return this.generateWorld();
		} finally {
			this.aps = savedAps;
			this.wallMask = savedMask;
			this.materialMap = savedMaterial;
			this.defaultMaterial = savedDefaultMaterial;
			this.worldUnitsPerMeter = savedWupm;
			this.rssiFloor = savedRssiFloor;
			this.isDragging = savedDragging;
			this.maskTag = savedMaskTag;
			this.surfaces = savedSurfaces;
		}
	}

	render(rc: RenderContext): void {
		this.ensureGenerated();
		if (!this.cache) return;

		// Blit under the camera transform: this is the whole per-frame cost now,
		// and it is independent of how many APs or cells the image contains.
		const { ctx, camera, dpr } = rc;
		const [a, b, c, d, e, f] = camera.getTransform();
		ctx.save();
		ctx.setTransform(a * dpr, b * dpr, c * dpr, d * dpr, e * dpr, f * dpr);
		// The image is generated in world space and upscaled here; the default filter is
		// the cheapest one, and this layer is the only one that is upscaled at all.
		const smoothing = ctx.imageSmoothingEnabled;
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = 'high';
		ctx.drawImage(
			this.cache,
			this.cacheX0,
			this.cacheY0,
			this.cache.width * this.cacheTexel,
			this.cache.height * this.cacheTexel
		);
		ctx.imageSmoothingEnabled = smoothing;
		ctx.restore();
	}

	/**
	 * Cache key for the generated heatmap.
	 *
	 * The camera is deliberately absent: the image lives in world space, so pan
	 * and zoom do not invalidate it. `texel` is present because drag mode
	 * regenerates at a coarser resolution.
	 *
	 * NOTE: the heatmap renders *coverage* only — a per-pixel max over APs of
	 * (path loss + wall loss + slab loss). It does NOT model co-channel
	 * interference, so `assignedChannel` deliberately does not appear here.
	 */
	private getCacheKey(): string {
		// While dragging, positions are quantised to the coarse texel. The image's
		// origin snaps to that lattice anyway, so a step of a few pixels cannot change
		// the picture — but an exact key regenerated for every one of them, and each
		// regeneration is the whole cost of the drag. The drop lands on the fine key and
		// redraws exactly.
		const step = this.isDragging ? TEXEL_COARSE : 1;
		const snap = (v: number) => Math.round(v / step) * step;
		return (
			this.aps
				.map(
					(ap) =>
						`${ap.id}:${snap(ap.x)}:${snap(ap.y)}:${ap.interferenceRadius}:${ap.band}:${ap.channelWidth}:${ap.power}:${ap.verticalOffset ?? 0}:${ap.floorDbPerMeter ?? 0}:${ap.floorThickness ?? 0}:` +
						// The whole pattern, from the one function that lists what a pattern
						// depends on: a wall mount's facing changes the picture without moving
						// the AP, and a change of mounting adds or removes the horizontal cut
						// entirely. See `antennaSignature`.
						antennaSignature(ap) +
						// The AP's own floor's mask, when the path is split at the slab:
						// editing that floor's walls changes this image too.
						(ap.crossFloor
							? `:cf${ap.crossFloor.mask.width}x${ap.crossFloor.mask.height}@${ap.crossFloor.mask.originX},${ap.crossFloor.mask.originY}:${ap.crossFloor.sourceT.toFixed(4)},${ap.crossFloor.targetT.toFixed(4)}:${ap.crossFloor.defaultMaterial}`
							: '')
				)
				.join('|') +
			`|floor:${this.rssiFloor}|t:${this.isDragging ? 'c' : 'f'}` +
			`|wm:${this.wallMask?.width ?? 0}x${this.wallMask?.height ?? 0}:${this.wallMask?.originX ?? 0},${this.wallMask?.originY ?? 0}` +
			// The mask *objects*, not only their geometry: replacing a floor's mask with one of
			// the same size — deriving it from the drawn walls, or undoing an edit — otherwise
			// left every cached field showing the previous geometry, which reads as a redraw
			// that never happened.
			`|wms:${maskSignature(this.wallMask)}:${maskSignature(this.materialMap)}` +
			`|mat:${this.defaultMaterial}|mv:${this.materialVersion}|wupm:${this.worldUnitsPerMeter}` +
			// Raised surfaces move the client, not the AP: the same plan with a mezzanine
			// added is a different picture.
			`|surf:${this.surfaces
				.map((s) => `${s.kind}:${s.ax},${s.ay},${s.bx},${s.by}:${s.heightM}/${s.topHeightM}`)
				.join(';')}` +
			// The reflecting segments: their lines decide the bounce, so an edit moves the
			// reflected term even when the derived mask happens to keep the same frame.
			`|rw:${this.reflectingWalls
				.map((w) => `${w.ax},${w.ay},${w.bx},${w.by}:${w.material}`)
				.join(';')}` +
			// The clip decides which texels exist at all, so it is part of the picture.
			`|clip:${this.clipPolygon?.map((p) => `${p.x},${p.y}`).join(';') ?? ''}`
		);
	}

	/**
	 * Generate the heatmap as a world-space image.
	 *
	 * Returns the canvas together with the world rectangle it covers, so the
	 * renderer can blit it under the camera transform without recomputing
	 * anything. Nothing here depends on the camera or the viewport.
	 */
	private generateWorld(): { canvas: HTMLCanvasElement; x0: number; y0: number; texel: number } | null {
		const n = this.aps.length;
		if (n === 0) return null;
		// A mask is on its way (the floor's stored mask is being decoded), so
		// generating now would march every field and fill every texel against no walls
		// at all — a full generation, thrown away the moment the decode lands. A floor
		// switch did exactly that: three to four generations, one of them wasted.
		if (!this.wallMask && this.maskPending) return null;

		const wupm = this.worldUnitsPerMeter;
		const metersPerWorldUnit = wupm > 0 ? 1 / wupm : 0;
		const fast = this.isDragging;

		// Region to cover: the plan, plus everywhere this AP set can put colour —
		// see `heatmapRegion`. Sized from the ramp floor rather than from the
		// association radius, which is what used to force the texel to be widened.
		const wm = this.wallMask;
		const region = heatmapRegion(
			this.aps,
			wm
				? { originX: wm.originX, originY: wm.originY, width: wm.width, height: wm.height }
				: null,
			this.rssiFloor,
			wupm,
			this.isDragging ? TEXEL_COARSE : TEXEL_FINE,
			MAX_TEXELS
		);
		if (!region) return null;
		const { x0, y0, cols, rows, texel } = region;

		// Wall attenuation is band dependent, so build one material table per band
		// actually in use instead of a single 5 GHz table for every AP.
		const matDbByBand = new Map<Band, number[]>();
		const defaultDbByBand = new Map<Band, number>();
		for (const ap of this.aps) {
			if (matDbByBand.has(ap.band)) continue;
			matDbByBand.set(ap.band, getMaterialDbTable(ap.band));
			defaultDbByBand.set(ap.band, getFlatAttenuation(this.defaultMaterial, ap.band));
		}

		// Per-AP cross-floor parameters
		/** The vertical offset in world units, for the antenna's elevation angle. */
		const vertWu = new Float64Array(n);
		/** Each AP's vertical antenna pattern. See `rf/antenna.ts`. */
		const apProfiles: AntennaProfile[] = [];
		const floorDbThickness = new Float64Array(n); // ITU aggregate floor isolation (dB)
		const apX = new Float64Array(n);
		const apY = new Float64Array(n);
		/**
		 * Level at 1 m from each AP, in dBm: P_tx - PL0(band).
		 *
		 * The heatmap previously ignored AP power entirely and coloured cells by
		 * path loss relative to 1 m, so a 30 dBm AP and a 10 dBm AP painted an
		 * identical picture even though their coverage differs by 20 dB. Anchoring
		 * each AP's contribution at its own 1 m level makes the cell value an
		 * actual received level, so power and band affect the result as they
		 * should, and the colour floor can be expressed in dBm.
		 */
		const apRefDb = new Float64Array(n);
		/** Each AP's band, for the reflection coefficient's frequency. */
		const bands: Band[] = [];
		let rampTop = -Infinity;

		const fields: (AttenField | null)[] = [];
		/**
		 * Field for the AP's *own* floor, when its path is split at the slab.
		 *
		 * Only the run from the AP down to the crossing is charged against it, which
		 * is a field lookup at the crossing point — the same polar field the client's
		 * floor uses, built from the other floor's mask.
		 */
		const sourceFields: (AttenField | null)[] = [];
		for (let i = 0; i < n; i++) {
			const ap = this.aps[i]!;
			apX[i] = ap.x;
			apY[i] = ap.y;
			const vo = ap.verticalOffset ?? 0;
			vertWu[i] = vo * wupm;
			// The antenna's vertical cut. It is a function of the ray's elevation, which
			// is per texel, so only the profile is resolved here.
			apProfiles.push(antennaProfileFor(ap));
			bands.push(ap.band);
			floorDbThickness[i] = (ap.floorDbPerMeter ?? 0) * (ap.floorThickness ?? 0);
			// pathLossDb(band, 1) is the 1 m reference loss PL0 for the band.
			apRefDb[i] = ap.power - pathLossDb(ap.band, 1);
			if (apRefDb[i]! > rampTop) rampTop = apRefDb[i]!;
			// interferenceRadius still sets how far the wall attenuation field is
			// marched, so it is kept even though the signal model no longer uses it
			// directly — but only as far as this image can read (`FIELD_MARGIN_FACTOR`,
			// just past the drawn margin). The default march is twice that.
			//
			// The cache tag carries the band, the role, and which mask was marched.
			// Fields are built from material tables and *a* mask, while the cache key
			// is position and radius alone — so without a tag two APs on different
			// bands close enough to quantise to the same cell shared one AP's
			// attenuation, and a cross-floor AP's two fields (its own floor's and this
			// one's) shared a single entry, which made the split read this floor's
			// walls from *both* sides and cancel out to no change at all.
			//
			// `maskTag` is the same problem one level up: two floors with an AP in the
			// same cell share the entry unless the mask is in the tag, and the second
			// one generated — in the tiled view, whichever card is not selected — is
			// then drawn from the other floor's walls.
			const bandTag = `${ap.band}:tgt:${this.maskTag}`;
			fields.push(
				this.wallMask
					? getAttenField(
							ap.x,
							ap.y,
							ap.interferenceRadius,
							this.wallMask.data,
							this.wallMask.width,
							this.wallMask.height,
							this.materialMap,
							matDbByBand.get(ap.band)!,
							defaultDbByBand.get(ap.band)!,
							fast,
							this.wallMask.originX,
							this.wallMask.originY,
							bandTag,
							FIELD_MARGIN_FACTOR
						)
					: null
			);
			const cf = ap.crossFloor;
			sourceFields.push(
				cf
					? getAttenField(
							ap.x,
							ap.y,
							ap.interferenceRadius,
							cf.mask.data,
							cf.mask.width,
							cf.mask.height,
							cf.materialMap,
							matDbByBand.get(ap.band)!,
							getFlatAttenuation(cf.defaultMaterial, ap.band),
							fast,
							cf.mask.originX,
							cf.mask.originY,
							`${ap.band}:src:${cf.mask.width}x${cf.mask.height}@${cf.mask.originX},${cf.mask.originY}`,
							FIELD_MARGIN_FACTOR
						)
					: null
			);
		}

		// The ramp spans from the floor up to the strongest AP's 1 m level. If
		// every AP sits at or below the floor there is nothing to draw at all.
		const span = rampTop - this.rssiFloor;
		if (!(span > 0)) return null;

		const startedAt = performance.now();
		const canvas = document.createElement('canvas');
		canvas.width = cols;
		canvas.height = rows;
		const cctx = canvas.getContext('2d')!;
		const imgData = cctx.createImageData(cols, rows);
		const u32 = new Uint32Array(imgData.data.buffer);
		/** Received level per texel, in dBm; NaN where the texel is below the ramp floor. */
		const levels = new Float32Array(cols * rows).fill(Number.NaN);
		// The raised-surface field, in the units this loop works in. Resolved once so the
		// inner loop is a multiply and a lookup rather than a conversion per texel.
		const surfaces = this.surfaces;
		const surfaceScale = this.worldUnitsPerMeter;
		// The outline the picture is clipped to, resolved once for the loop.
		const clip =
			this.clipPolygon && this.clipPolygon.length >= 3 && !this.isDragging
				? this.clipPolygon
				: null;
		/*
		 * One specular reflection per access point, as a power term.
		 *
		 * Off while dragging: the coarse image a drag draws is about where the colour is, and
		 * the reflection pass is the most expensive thing in this loop. Off too when the floor
		 * has no segments — a mask-only floor has no wall lines to reflect off.
		 */
		const walls = this.isDragging ? [] : this.reflectingWalls;
		const reflectionReach = 24 * this.worldUnitsPerMeter;
		// Every wall end is a knife edge; computed once per image.
		const edges: DiffractionEdge[] = walls.length > 0 ? edgesOf(walls) : [];

		for (let ty = 0; ty < rows; ty++) {
			const wy = y0 + (ty + 0.5) * texel;
			const rowOff = ty * cols;

			for (let tx = 0; tx < cols; tx++) {
				const wx = x0 + (tx + 0.5) * texel;
				// Outside the building's own outline there is no floor to report a level for:
				// the field would paint every wall's shadow across the margin instead.
				if (clip && !pointInPolygon(wx, wy, clip)) continue;

				/*
				 * How high the client is here, in world units. Zero on the floor; a
				 * mezzanine's height over one; interpolated across a stair or a ramp. Only
				 * computed when the floor has any, so a flat plan pays nothing for the
				 * feature.
				 */
				const liftWu = surfaces.length > 0 ? surfaceHeightAt(surfaces, wx, wy) * surfaceScale : 0;

				// Strongest received level at this texel, in dBm. Every term is
				// already in dB so they simply add; there is no conversion to a
				// linear power ratio anywhere in this loop — except for the reflected
				// term below, which is a power *sum* and has to be converted once.
				let bestDb = -Infinity;
				let reflectedMw = 0;
				let wallLoss = 0;
				for (let i = 0; i < n; i++) {
					wallLoss = 0;
					const dx = wx - apX[i]!;
					const dy = wy - apY[i]!;
					// The AP–client gap, less what the client stands on. Signed: a client
					// up a mezzanine can be above a desk-mounted AP.
					const gap = vertWu[i]! - liftWu;
					const dWu = Math.sqrt(dx * dx + dy * dy + gap * gap);
					// Start from this AP's 1 m level and subtract the excess path
					// loss. relativePathLossDb clamps distances below 1 m, where the
					// log-distance model is not valid.
					let level = apRefDb[i]! - relativePathLossDb(dWu * metersPerWorldUnit);

					/*
					 * The antenna's own cuts, from the geometry of this ray.
					 *
					 * The vertical cut: an upright omni is peaked near the horizon, so a
					 * texel 10 m out is close to its peak and one almost under the AP is
					 * at the weak end of the doughnut — which is the whole reason this
					 * term exists. The horizontal cut is added for a wall-mounted unit,
					 * whose pattern has a front and a back; one call, so neither can be
					 * applied without the other.
					 */
					level -= antennaRayLossDb(apProfiles[i]!, gap, dx, dy);

					// A deck between the AP and a client standing on it: the path from below
					// has to pass through the slab, and that is what the surface's own
					// attenuation figure is for. Guarded on `liftWu` because a texel off any
					// deck cannot cross one, and that is most of the plan — the contains test
					// per surface per texel per AP was measurable in a drag.
					if (liftWu > 0) {
						const deck = deckCrossing(surfaces, wx, wy, gap / surfaceScale);
						if (deck) level -= deck.lossDb;
					}

					// Wall attenuation (precomputed field, O(1) lookup).
					const field = fields[i];
					const crossFloor = this.aps[i]!.crossFloor;
					if (field) {
						// Kept separate from `level`: it is also the test for whether this ray is
						// blocked, which is when diffraction has something to fill.
						/*
						 * Exact march, not the polar lookup, for a same-floor path.
						 *
						 * The polar field stores attenuation per 0.5° slice, so a wall shadow's
						 * boundary is quantised to slices: at a hundred metres out a slice is
						 * several metres wide, and the interpolated result is the tapered spike
						 * out of every corner that no amount of smoothing removed. Marching this
						 * texel's own ray costs a pixel walk instead of a lookup, and it has no
						 * angular quantisation at all. Cross-floor paths keep the field: their
						 * split needs the prefix at the crossing, which is the field's own value.
						 */
						const mask = this.wallMask;
						if (mask && !this.isDragging) {
							wallLoss = rayMarchWallAtten(
								mask.data,
								mask.width,
								mask.height,
								this.materialMap,
								matDbByBand.get(bands[i]!) ?? getMaterialDbTable(bands[i]!),
								defaultDbByBand.get(bands[i]!) ?? getFlatAttenuation(this.defaultMaterial, bands[i]!),
								apX[i]! - mask.originX,
								apY[i]! - mask.originY,
								wx - mask.originX,
								wy - mask.originY,
								/*
								 * Two pixels per step, not one.
								 *
								 * The walls are a six-pixel band, so a two-pixel stride cannot step
								 * over one, and it halves the cost of what is now a per-texel walk:
								 * a 40 000-texel image with two APs is 80 000 marches, which at one
								 * pixel per step is half a second on the frame the pointer is
								 * released in.
								 */
								2,
								this.defaultMaterial
							);
						} else {
							wallLoss = lookupAtten(field, wx, wy);
						}
						level -= wallLoss;
						if (crossFloor) {
							// Split at the slab: undo the part of this floor's run that
							// happens above the crossing, and charge that part to the
							// AP's own floor instead. The crossing lies *on* this ray,
							// so the field lookup at that distance is exactly the prefix
							// being removed.
							const seg = crossFloorSegments(
								crossFloor.sourceT,
								crossFloor.targetT,
								apX[i]!,
								apY[i]!,
								wx,
								wy
							);
							if (seg) {
								level += lookupAtten(field, seg.target.from.x, seg.target.from.y);
								const srcField = sourceFields[i];
								if (srcField) {
									level -= lookupAtten(srcField, seg.source.to.x, seg.source.to.y);
								}
							}
						}
					}

					// Floor slab attenuation (ITU-R P.1238 empirical model): measured
					// aggregate floor isolation covering direct penetration,
					// diffraction and multipath, applied as flat dB. The 3D distance
					// above already captures the oblique geometry.
					//
					// Unless the slab is missing where this ray crosses it: an atrium or
					// stairwell is a hole in the upper floor's slab, and a hole costs
					// nothing.
					let slabDb = floorDbThickness[i]!;
					const slabTypes = crossFloor?.slabRoomType;
					if (slabTypes) {
						const slabCross = pointAlong(apX[i]!, apY[i]!, wx, wy, crossFloor!.slabT ?? 0);
						if (
							slabIsVoid(
								slabTypes.data,
								slabTypes.width,
								slabTypes.height,
								slabTypes.originX,
								slabTypes.originY,
								slabCross.x,
								slabCross.y
							)
						) {
							slabDb = 0;
						}
					}
					level -= slabDb;

					if (level > bestDb) bestDb = level;

					/*
					 * The wall's mirror image: one specular bounce, added as power.
					 *
					 * The reflected ray travels access point → wall → texel, so it pays the
					 * path loss of that longer distance and the wall's own reflection
					 * coefficient (already a power ratio, ≤ 1). It does **not** pay the walls
					 * between: both legs are on the same side of the reflecting wall by
					 * construction, and charging crossings here would double-count the wall
					 * the ray bounced off.
					 */
					if (walls.length > 0) {
						/*
						 * Every return that reaches here, not just the strongest.
						 *
						 * "Strongest only" switched walls across a line in the room and left a
						 * crease there, plus a ring where the distance cull began; summing what
						 * exists is continuous where the physics is continuous and only costs
						 * a memoised coefficient per wall.
						 */
						const returns = reflections(
							{ x: apX[i]!, y: apY[i]! },
							{ x: wx, y: wy },
							walls,
							bands[i]!,
							reflectionReach
						);
						for (const bounce of returns) {
							const reflected =
								apRefDb[i]! -
								relativePathLossDb(bounce.length * metersPerWorldUnit) -
								antennaRayLossDb(
									apProfiles[i]!,
									gap,
									bounce.x - apX[i]!,
									bounce.y - apY[i]!
								) +
								10 * Math.log10(bounce.powerRatio);
							if (reflected > this.rssiFloor) reflectedMw += 10 ** (reflected / 10);
						}
					}

					/*
					 * Diffraction, ramped in as the wall blocks more.
					 *
					 * A hard "blocked at 6 dB" gate drew the contour where it flipped as a
					 * visible notch: on one side the shadow was filled, on the other it was
					 * not. The weight ramps from nothing at 3 dB to full at 9 dB, so the term
					 * grows where the wall starts to occlude instead of appearing at a line.
					 */
					const diffractionGate = Math.min(1, Math.max(0, (wallLoss - 3) / 6));
					if (diffractionGate > 0 && edges.length > 0) {
						const loss = diffractionLossDb(
							{ x: apX[i]!, y: apY[i]! },
							{ x: wx, y: wy },
							edges,
							bands[i]!
						);
						if (loss > 0) {
							const diffracted =
								apRefDb[i]! - relativePathLossDb(dWu * metersPerWorldUnit) - loss -
								antennaRayLossDb(apProfiles[i]!, gap, dx, dy);
							if (diffracted > this.rssiFloor) {
								reflectedMw += diffractionGate * 10 ** (diffracted / 10);
							}
						}
					}
				}

				// Power sum: the texel hears the direct ray and the reflected one.
				const totalDb =
					reflectedMw > 0 ? 10 * Math.log10(10 ** (bestDb / 10) + reflectedMw) : bestDb;
				/*
				 * The level is stored, not coloured, so it can be smoothed first.
				 *
				 * A per-texel field is piecewise constant and its shadow boundaries are exact
				 * lines: colouring it directly gives the hard wedges and steps the picture showed.
				 * Blurring the *levels* (below) is what turns those into gradients, and it is
				 * what a planning tool's image looks like — no staircase, no seam between two
				 * neighbouring slices of the same shadow.
				 */
				levels[rowOff + tx] = totalDb;
			}
		}

		/*
		 * Two box-blur passes over the level grid.
		 *
		 * Separable and small: a 3×3 kernel twice is nine reads per texel, which is nothing next
		 * to the field march, and it removes the texel staircase as well as the seams between
		 * adjacent angular slices. Missing levels (below the ramp floor) are left out of the
		 * averages rather than treated as zero dBm, which would draw a bright fringe around the
		 * covered area.
		 */
		const smooth = boxBlurLevels(levels, cols, rows);

		for (let ty = 0; ty < rows; ty++) {
			const rowOff = ty * cols;
			for (let tx = 0; tx < cols; tx++) {
				const totalDb = smooth[rowOff + tx]!;
				const norm = (totalDb - this.rssiFloor) / span;
				if (!Number.isFinite(totalDb) || norm <= 0) continue;
				const color = LUT[Math.min(255, (norm * 255) | 0)]!;
				if (!color) continue;
				u32[rowOff + tx] = color;
			}
		}

		cctx.putImageData(imgData, 0, 0);
		console.info(
			`[heatmap] ${cols}x${rows} texels at ${texel} world units ` +
				`(${((performance.now() - startedAt) | 0)} ms)`
		);
		return { canvas, x0, y0, texel };
	}
}
