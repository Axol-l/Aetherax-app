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

/** Underlay width in world units. Matches `FloorplanLayer` so plans scale alike. */
export const CARD_PLAN_WIDTH = 800;

/** Fallback box for a floor with neither a mask nor a loaded plan. */
const EMPTY_W = 800;
const EMPTY_H = 600;

export interface FloorCardSource {
	id: string;
	name: string;
	planUrl: string | null;
	planOffsetX: number;
	planOffsetY: number;
	maskUrl: string | null;
	maskOriginX: number;
	maskOriginY: number;
	maskWidth: number;
	maskHeight: number;
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
	/** Called once a plan image finishes loading, so the engine can repaint. */
	onLoad: (() => void) | null = null;

	/** Load what is wanted, drop what is not. */
	sync(sources: FloorCardSource[]): void {
		const wanted = new Set<string>();
		const liveFloors = new Set<string>();
		for (const s of sources) {
			liveFloors.add(s.id);
			for (const url of [s.planUrl, s.maskUrl]) {
				if (!url) continue;
				wanted.add(url);
				if (this.images.has(url)) continue;
				const img = new Image();
				img.onload = () => this.onLoad?.();
				img.src = url;
				this.images.set(url, img);
			}
		}
		for (const url of [...this.images.keys()]) {
			if (!wanted.has(url)) this.images.delete(url);
		}
		for (const id of [...this.heatmaps.keys()]) {
			if (!liveFloors.has(id)) this.heatmaps.delete(id);
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
	contentBox(s: FloorCardSource): CardBox {
		if (s.maskUrl && s.maskWidth > 0 && s.maskHeight > 0) {
			return { minX: s.maskOriginX, minY: s.maskOriginY, w: s.maskWidth, h: s.maskHeight };
		}
		const plan = s.planUrl ? this.images.get(s.planUrl) : null;
		if (plan?.complete && plan.naturalWidth > 0) {
			return {
				minX: s.planOffsetX,
				minY: s.planOffsetY,
				w: CARD_PLAN_WIDTH,
				h: (plan.naturalHeight / plan.naturalWidth) * CARD_PLAN_WIDTH
			};
		}
		if (s.planUrl) {
			return { minX: s.planOffsetX, minY: s.planOffsetY, w: EMPTY_W, h: EMPTY_H };
		}
		return { minX: 0, minY: 0, w: EMPTY_W, h: EMPTY_H };
	}

	/**
	 * Draw one floor's content into the current transform.
	 *
	 * The caller has already clipped and translated into place, and owns the frame,
	 * the label and any depth decoration: what is here is exactly the floor's own
	 * drawing, so the two views cannot drift.
	 */
	draw(ctx: CanvasRenderingContext2D, src: FloorCardSource, opts: CardContentOptions): void {
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
			const maskImg = this.images.get(src.maskUrl);
			if (maskImg?.complete && maskImg.naturalWidth > 0) {
				ctx.globalAlpha = 0.5;
				ctx.drawImage(maskImg, src.maskOriginX, src.maskOriginY);
			}
		}

		if (opts.showAPs) {
			ctx.globalAlpha = 1;
			const dotR = 4 / opts.zoom;
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
	}
}
