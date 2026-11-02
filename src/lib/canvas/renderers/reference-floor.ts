import type { Layer, RenderContext } from '../types.js';

/** Underlay width in world units. Matches `FloorplanLayer` so both scale alike. */
const TARGET_WIDTH = 800;

/**
 * Translucent ghost of another floor, drawn over the current one.
 *
 * Each floor is drawn in the same world frame, so if two plans disagree about
 * where the building sits there is no way to see it while looking at one floor
 * alone. This overlays the reference floor's underlay and wall mask so the
 * disagreement is visible while the alignment is adjusted.
 *
 * The wall mask needs no decoding. `encodeMask` writes walls as opaque white on
 * a fully transparent background, so the stored PNG draws directly. A silhouette
 * is also the right representation: material colours would compete with the
 * current floor's walls rather than sit behind them.
 *
 * Drawn above the current floor's plan and walls on purpose. The current
 * underlay is 80% opaque, so a ghost underneath it would be invisible exactly
 * when it is needed.
 */
export class ReferenceFloorLayer implements Layer {
	id = 'reference-floor';
	visible = false;
	opacity = 0.3;

	/**
	 * Called once an image has loaded, so the engine can repaint. Without it the
	 * ghost would stay blank until something else marked the canvas dirty.
	 */
	onLoad: (() => void) | null = null;

	/**
	 * Extra world-space shift added to the ghost only.
	 *
	 * Used while dragging an alignment: the camera carries the current floor, and
	 * the ghost has to be pushed back by the same amount so it stays visually
	 * anchored to the floor it belongs to.
	 */
	compensateX = 0;
	compensateY = 0;

	/**
	 * Reference floor's units → the current floor's.
	 *
	 * The ghost is drawn in the current floor's world frame, so a reference plan
	 * calibrated at a different resolution is scaled into it (and its offsets with it).
	 * Without this the overlay only lined up when both floors shared a calibration.
	 */
	scale = 1;

	private planImage: HTMLImageElement | null = null;
	private planKey: string | null = null;
	private planX = 0;
	private planY = 0;
	private planW = 0;
	private planH = 0;

	private maskImage: HTMLImageElement | null = null;
	private maskKey: string | null = null;
	private maskX = 0;
	private maskY = 0;

	/** Show the reference floor's underlay. Pass null to clear it. */
	setPlan(url: string | null, offsetX: number, offsetY: number): void {
		const key = url ? `${url}|${offsetX}|${offsetY}` : null;
		if (key === this.planKey) return;
		this.planKey = key;
		if (!url) {
			this.planImage = null;
			this.planW = 0;
			this.planH = 0;
			return;
		}
		this.planX = offsetX;
		this.planY = offsetY;
		if (this.planImage?.src !== url) {
			const img = new Image();
			img.onload = () => {
				const natW = img.naturalWidth || 1;
				const natH = img.naturalHeight || 1;
				this.planW = TARGET_WIDTH;
				this.planH = (natH / natW) * TARGET_WIDTH;
				this.onLoad?.();
			};
			img.src = url;
			this.planImage = img;
		}
	}

	/** Show the reference floor's wall silhouette. Pass null to clear it. */
	setMask(url: string | null, originX: number, originY: number): void {
		const key = url ? `${url}|${originX}|${originY}` : null;
		if (key === this.maskKey) return;
		this.maskKey = key;
		if (!url) {
			this.maskImage = null;
			return;
		}
		this.maskX = originX;
		this.maskY = originY;
		if (this.maskImage?.src !== url) {
			const img = new Image();
			img.onload = () => this.onLoad?.();
			img.src = url;
			this.maskImage = img;
		}
	}

	render(rc: RenderContext): void {
		if (!this.visible) return;
		const { ctx, camera } = rc;
		const [a, b, c, d, e, f] = camera.getTransform();

		ctx.save();
		ctx.transform(a, b, c, d, e, f);
		ctx.globalAlpha = this.opacity;
		if (this.planImage && this.planW > 0) {
			ctx.drawImage(
				this.planImage,
				this.planX * this.scale + this.compensateX,
				this.planY * this.scale + this.compensateY,
				this.planW * this.scale,
				this.planH * this.scale
			);
		}
		if (this.maskImage) {
			ctx.drawImage(
				this.maskImage,
				this.maskX * this.scale + this.compensateX,
				this.maskY * this.scale + this.compensateY,
				(this.maskImage.naturalWidth || 0) * this.scale,
				(this.maskImage.naturalHeight || 0) * this.scale
			);
		}
		ctx.restore();
	}
}
