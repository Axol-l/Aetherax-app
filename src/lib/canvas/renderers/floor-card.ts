/**
 * The parts a per-floor thumbnail is made of, shared by the two overview views.
 *
 * `FloorTilesLayer` lays the floors out as a contact sheet and the stacked view
 * stacks them by elevation; everything else about a card — decoding and caching
 * the underlay and mask images, drawing the plan, the mask silhouette, the
 * per-floor coverage image and the AP dots — is the same work, and this is it.
 *
 * The *images* are shared on purpose, not just the code. The coverage image for a
 * floor is the expensive artefact in either view (it is a whole floor's field), so
 * one cache holding one canvas per floor means switching between the sheet and the
 * stack reuses what was already generated instead of rebuilding it, and the two
 * views can never show a floor at two different resolutions.
 */

import { apMarkerColor } from './ap.js';
import { colorizeWalls } from './walls.js';
import type { WallMaterialId } from '$lib/domain/materials.js';

/** Underlay width in world units. Matches `FloorplanLayer` so plans scale alike. */
export const CARD_PLAN_WIDTH = 800;

/**
 * Fallback box for a floor with neither a mask nor a loaded plan.
 *
 * Deliberately smaller than a real plan: an 800×600 empty rectangle in a sheet or a stack
 * reads as a floor-sized slab and covers the floors below it. A compact card still says the
 * floor exists without pretending it has a plan.
 */
const EMPTY_W = 320;
const EMPTY_H = 240;

export interface FloorCardSource {
	id: string;
	name: string;
	planUrl: string | null;
	planOffsetX: number;
	planOffsetY: number;
	maskUrl: string | null;
	/**
	 * This floor's painted material map, as stored — the same raster the plan colours
	 * its walls from.
	 *
	 * Without it an overview can only draw the wall mask, which is white walls on
	 * transparent: every material looked alike up there while the plan told a glass
	 * door from a brick wall. Null when nothing on the floor has been repainted.
	 */
	materialUrl: string | null;
	/** The material unpainted walls are drawn in, per floor. See `getFloorMask`. */
	defaultMaterial: number;
	maskOriginX: number;
	maskOriginY: number;
	maskWidth: number;
	maskHeight: number;
	/**
	 * This floor's calibration, world units per metre.
	 *
	 * A card draws its floor in the floor's own units and scales the whole drawing into the
	 * sheet's frame: two storeys calibrated at different resolutions are physically different
	 * sizes, and drawing them at one raw coordinate system made the one with the finer plan
	 * look bigger than it is.
	 */
	wupm: number;
	/**
	 * This floor's access points, as the single-floor view would draw them.
	 *
	 * The channel is carried so an overview can colour a marker the same way the
	 * plan does — green for an access point that holds a channel, grey for one that
	 * does not — rather than in a palette of its own. `mountHeightM` lets the
	 * stacked view lift a marker off its floor by where the AP actually hangs, and
	 * the mounting decides the marker's shape: a wall unit is drawn as a plate.
	 */
	aps: Array<{
		x: number;
		y: number;
		assignedChannel?: number | null;
		band?: string;
		mountHeightM?: number;
		mount?: string;
		facingDeg?: number;
	}>;
	/**
	 * Height of this floor's walking surface above the lowest floor, in metres.
	 *
	 * Only the stacked view reads it, and it is derived (`floorElevation`) rather
	 * than stored: `level` is already the ordering key and `ceilingHeight` already
	 * per floor, so a stored elevation could disagree with either.
	 */
	elevation: number;
}

/** A generated coverage image for one floor, in world units. */
export interface FloorHeatmap {
	canvas: HTMLCanvasElement;
	x0: number;
	y0: number;
	texel: number;
}

/** What a card draws, so both views keep the LAYERS panel meaning the same thing. */
export interface CardContentOptions {
	showPlan: boolean;
	showWalls: boolean;
	showAPs: boolean;
	showHeatmap: boolean;
	/** Underlay alpha, shared with the single-floor view. */
	planOpacity: number;
	/** Camera zoom, so screen-constant details stay screen-constant. */
	zoom: number;
	/** The sheet's reference scale, which the floor's own drawing is converted into. */
	wupm: number;
}

/** World-space box a card's content occupies. */
export interface CardBox {
	minX: number;
	minY: number;
	w: number;
	h: number;
}

/**
 * Decoded images and generated coverage for every floor, held once.
 *
 * `sync` is driven from `setFloors` in both views, so it also evicts: a URL that
 * is no longer wanted and a floor that no longer exists both drop their entries,
 * because a deleted floor's coverage canvas is the largest thing this holds.
 */
export class FloorCardCache {
	readonly images = new Map<string, HTMLImageElement>();
	/**
	 * Per-floor coverage images, keyed by floor id, filled in by the caller
	 * (`CanvasView`'s warm loop) rather than computed here, so the coverage
	 * colouring has exactly one implementation.
	 */
	readonly heatmaps = new Map<string, FloorHeatmap>();
	/**
	 * Per-floor walls, coloured by material, keyed by floor id.
	 *
	 * Built from the two rasters the floor already has (its wall mask and its material
	 * map) with the *plan's* own colourizer, so the sheet and the stack show what the
	 * plan shows. Kept as a canvas rather than rebuilt per frame: a full-resolution
	 * mask is millions of pixels and both views redraw on every camera move.
	 */
	private readonly wallCanvases = new Map<string, { signature: string; canvas: HTMLCanvasElement }>();
	/**
	 * The builds in flight, by floor id.
	 *
	 * A coloured raster needs both bitmaps decoded, and an image finishing its load is
	 * not a state change the views sync on — so the work waits on the images itself
	 * rather than hoping for another `sync`. This is what stops a second identical build
	 * from being started while the first is waiting.
	 */
	private readonly wallJobs = new Map<string, string>();
	/** Called once a plan image finishes loading, so the engine can repaint. */
	onLoad: (() => void) | null = null;

	/** Everything a coloured wall raster depends on, so a stale one is never drawn. */
	private wallSignature(s: FloorCardSource): string {
		return `${s.maskUrl ?? ''}|${s.materialUrl ?? ''}|${s.defaultMaterial}|${s.maskWidth}x${s.maskHeight}`;
	}

	/**
	 * Make sure this floor's coloured walls exist, and start building them if not.
	 *
	 * The two rasters are read from the bitmaps `sync` already loaded — the wall mask is
	 * white-on-transparent and the material map carries the material id in red, which is
	 * how the app's own decoders read them — and colourised with the *plan's* function,
	 * so the sheet and the stack show what the plan shows.
	 */
	private ensureWalls(s: FloorCardSource): void {
		if (!s.maskUrl || s.maskWidth <= 0 || s.maskHeight <= 0) {
			this.wallCanvases.delete(s.id);
			return;
		}
		const signature = this.wallSignature(s);
		if (this.wallCanvases.get(s.id)?.signature === signature) return;
		if (this.wallJobs.get(s.id) === signature) return;
		const maskImg = this.images.get(s.maskUrl);
		const materialImg = s.materialUrl ? this.images.get(s.materialUrl) : null;
		if (!maskImg) return;

		this.wallJobs.set(s.id, signature);
		void Promise.all([whenDecoded(maskImg), materialImg ? whenDecoded(materialImg) : null]).then(
			() => {
				this.wallJobs.delete(s.id);
				// A newer signature (the user painted another material) owns the slot now.
				if (this.wallSignature(s) !== signature) return;
				const mask = readRaster(maskImg, s.maskWidth, s.maskHeight);
				const materials = materialImg ? readRaster(materialImg, s.maskWidth, s.maskHeight) : null;
				this.wallCanvases.set(s.id, {
					signature,
					canvas: colorizeWalls(
						mask,
						s.maskWidth,
						s.maskHeight,
						materials,
						s.defaultMaterial as WallMaterialId
					)
				});
				this.onLoad?.();
			}
		);
	}

	/** Load what is wanted, drop what is not. */
	sync(sources: FloorCardSource[]): void {
		const wanted = new Set<string>();
		const liveFloors = new Set<string>();
		for (const s of sources) {
			liveFloors.add(s.id);
			for (const url of [s.planUrl, s.maskUrl, s.materialUrl]) {
				if (!url) continue;
				wanted.add(url);
				if (this.images.has(url)) continue;
				const img = new Image();
				img.onload = () => this.onLoad?.();
				img.src = url;
				this.images.set(url, img);
			}
			// The material map is wanted as an image for its pixels, so the coloured
			// walls can be built from the same bitmaps the plan reads.
			this.ensureWalls(s);
		}
		for (const url of [...this.images.keys()]) {
			if (!wanted.has(url)) this.images.delete(url);
		}
		for (const id of [...this.heatmaps.keys()]) {
			if (!liveFloors.has(id)) this.heatmaps.delete(id);
		}
		for (const id of [...this.wallCanvases.keys()]) {
			if (!liveFloors.has(id)) this.wallCanvases.delete(id);
		}
	}

	/**
	 * This floor's own content box, in world units — the mask, when it has one.
	 *
	 * Both views need it and for the same reason: a layout gives every card one
	 * cell or one slab, and a floor smaller than the largest one leaves empty
	 * margin inside it. Content is clipped to this box rather than to the cell, or
	 * the coverage image (generated for the plan plus each AP's reach) spills into
	 * the margin as a hard-edged rectangle floating outside the plan it belongs to.
	 */
	contentBox(s: FloorCardSource, sheetWupm = s.wupm): CardBox {
		const k = s.wupm > 0 ? sheetWupm / s.wupm : 1;
		const scaled = (box: CardBox): CardBox => ({
			minX: box.minX * k,
			minY: box.minY * k,
			w: box.w * k,
			h: box.h * k
		});
		if (s.maskUrl && s.maskWidth > 0 && s.maskHeight > 0) {
			return scaled({
				minX: s.maskOriginX,
				minY: s.maskOriginY,
				w: s.maskWidth,
				h: s.maskHeight
			});
		}
		const plan = s.planUrl ? this.images.get(s.planUrl) : null;
		if (plan?.complete && plan.naturalWidth > 0) {
			return scaled({
				minX: s.planOffsetX,
				minY: s.planOffsetY,
				w: CARD_PLAN_WIDTH,
				h: (plan.naturalHeight / plan.naturalWidth) * CARD_PLAN_WIDTH
			});
		}
		if (s.planUrl) {
			return scaled({ minX: s.planOffsetX, minY: s.planOffsetY, w: EMPTY_W, h: EMPTY_H });
		}
		return scaled({ minX: 0, minY: 0, w: EMPTY_W, h: EMPTY_H });
	}

	/**
	 * Draw one floor's content into the current transform.
	 *
	 * The caller has already clipped and translated into place, and owns the frame,
	 * the label and any depth decoration: what is here is exactly the floor's own
	 * drawing, so the two views cannot drift.
	 */
	draw(ctx: CanvasRenderingContext2D, src: FloorCardSource, opts: CardContentOptions): void {
		const k = src.wupm > 0 ? opts.wupm / src.wupm : 1;
		ctx.save();
		// The floor is drawn in its own units; the sheet is in the reference floor's.
		ctx.scale(k, k);
		const plan = src.planUrl ? this.images.get(src.planUrl) : null;
		if (opts.showPlan && plan?.complete && plan.naturalWidth > 0) {
			ctx.globalAlpha = opts.planOpacity;
			const h = (plan.naturalHeight / plan.naturalWidth) * CARD_PLAN_WIDTH;
			ctx.drawImage(plan, src.planOffsetX, src.planOffsetY, CARD_PLAN_WIDTH, h);
		}

		// Coverage for every floor, which is the point of both views: comparing
		// where the APs are thin across storeys.
		const hm = opts.showHeatmap ? this.heatmaps.get(src.id) : undefined;
		if (hm) {
			ctx.globalAlpha = 1;
			ctx.drawImage(
				hm.canvas,
				hm.x0,
				hm.y0,
				hm.canvas.width * hm.texel,
				hm.canvas.height * hm.texel
			);
		}

		if (opts.showWalls && src.maskUrl) {
			const coloured = this.wallCanvases.get(src.id)?.canvas;
			ctx.globalAlpha = 0.5;
			if (coloured) {
				// The plan's own colouring — see `colorizeWalls`. Falls back to the raw
				// mask below while the two rasters are still decoding.
				ctx.drawImage(coloured, src.maskOriginX, src.maskOriginY);
			} else {
				const maskImg = this.images.get(src.maskUrl);
				if (maskImg?.complete && maskImg.naturalWidth > 0) {
					ctx.drawImage(maskImg, src.maskOriginX, src.maskOriginY);
				}
			}
		}

		if (opts.showAPs) {
			ctx.globalAlpha = 1;
			// The marker is a screen-constant annotation, so the card's own scale is
			// divided out of it (a finer plan must not get bigger dots).
			const dotR = 4 / (opts.zoom * Math.max(0.0001, k));
			for (const ap of src.aps) {
				// The same colour the plan gives it — see `apMarkerColor`. The overview
				// used to have a palette of its own, so an access point that was green
				// on the plan was blue here.
				ctx.fillStyle = apMarkerColor({ assignedChannel: ap.assignedChannel ?? null, band: ap.band ?? '5ghz' });
				// And the same shape: a wall-mounted unit is the plate it is on the plan,
				// or an overview would be showing a different kind of object.
				if (ap.mount === 'wall') {
					ctx.save();
					ctx.translate(ap.x, ap.y);
					ctx.rotate(((ap.facingDeg ?? 0) * Math.PI) / 180);
					ctx.beginPath();
					ctx.roundRect(-dotR, -dotR * 2.2, dotR * 2, dotR * 4.4, dotR * 0.6);
					ctx.fill();
					ctx.restore();
					continue;
				}
				ctx.beginPath();
				ctx.arc(ap.x, ap.y, dotR, 0, Math.PI * 2);
				ctx.fill();
			}
		}
		ctx.restore();
	}
}

/**
 * One raster's pixels, as bytes: red channel, so both mask conventions read alike.
 *
 * The wall mask is white walls on transparent and the material map carries the material
 * id in red (`encodeMask`, `encodeMaterialMask`), which is exactly how the two decoders
 * in `wall-detect.ts` and `region-labels.ts` read them — the same numbers, from images
 * that are already loaded rather than from a second decode of the same data URL.
 */
function readRaster(img: HTMLImageElement, width: number, height: number): Uint8Array {
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d')!;
	ctx.drawImage(img, 0, 0, width, height);
	const data = ctx.getImageData(0, 0, width, height).data;
	const out = new Uint8Array(width * height);
	for (let i = 0; i < out.length; i++) out[i] = data[i * 4]!;
	return out;
}

/** Resolve when an image is decodable, immediately if it already is. */
function whenDecoded(img: HTMLImageElement): Promise<void> {
	if (img.complete && img.naturalWidth > 0) return Promise.resolve();
	return new Promise((resolve) => {
		// Both outcomes resolve: a mask that failed to load leaves the raw silhouette
		// drawn, which is what the views showed before the material colouring existed.
		img.addEventListener('load', () => resolve(), { once: true });
		img.addEventListener('error', () => resolve(), { once: true });
	});
}
