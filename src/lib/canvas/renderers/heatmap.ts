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
	invalidateAttenCache,
	type AttenField
} from '../../rf/propagation.js';
import { antennaRayLossDb, antennaSignature, type AntennaProfile } from '../../rf/antenna.js';
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
const TEXEL_FINE = 1;
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
		const generated = this.generateWorld();
		this.cache = generated?.canvas ?? null;
		this.cacheX0 = generated?.x0 ?? 0;
		this.cacheY0 = generated?.y0 ?? 0;
		this.cacheTexel = generated?.texel ?? TEXEL_FINE;
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
			`|mat:${this.defaultMaterial}|mv:${this.materialVersion}|wupm:${this.worldUnitsPerMeter}`
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
		const wupmSq = wupm * wupm;
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
		const vertOffSq = new Float64Array(n); // vertical offset² in world units²
		/** The same offset in world units, for the antenna's elevation angle. */
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
			vertOffSq[i] = vo * vo * wupmSq;
			vertWu[i] = vo * wupm;
			// The antenna's vertical cut. It is a function of the ray's elevation, which
			// is per texel, so only the profile is resolved here.
			apProfiles.push(antennaProfileFor(ap));
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

		for (let ty = 0; ty < rows; ty++) {
			const wy = y0 + (ty + 0.5) * texel;
			const rowOff = ty * cols;

			for (let tx = 0; tx < cols; tx++) {
				const wx = x0 + (tx + 0.5) * texel;

				// Strongest received level at this texel, in dBm. Every term is
				// already in dB so they simply add; there is no conversion to a
				// linear power ratio anywhere in this loop.
				let bestDb = -Infinity;
				for (let i = 0; i < n; i++) {
					const dx = wx - apX[i]!;
					const dy = wy - apY[i]!;
					const dWu = Math.sqrt(dx * dx + dy * dy + vertOffSq[i]!);
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
					level -= antennaRayLossDb(apProfiles[i]!, vertWu[i]!, dx, dy);

					// Wall attenuation (precomputed field, O(1) lookup).
					const field = fields[i];
					const crossFloor = this.aps[i]!.crossFloor;
					if (field) {
						level -= lookupAtten(field, wx, wy);
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
				}

				// bestDb is the strongest received level here in dBm. Map
				// [rssiFloor, rampTop] onto the ramp; below the floor is transparent.
				const norm = (bestDb - this.rssiFloor) / span;
				if (norm <= 0) continue;
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
