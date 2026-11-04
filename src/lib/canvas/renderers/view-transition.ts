import type { Layer, RenderContext } from '../types.js';

/**
 * Cross-fade the previously rendered view over the new one.
 *
 * The four floor views have nothing in common spatially, so a CSS transition on the canvas
 * would fade the *new* pixels in from nothing rather than from the old picture. This layer
 * keeps one snapshot of the canvas taken before the switch and fades it over the frames the
 * new view draws, which is the overview change with no layout morph and no second renderer.
 *
 * It is an overlay, not part of the picture, so exports skip it.
 */
export class ViewTransitionLayer implements Layer {
	id = 'view-transition';
	visible = true;
	readonly exportable = false;

	private snapshot: HTMLCanvasElement | null = null;
	private startedAt = 0;
	private duration = 0;
	private frameRequested = false;

	/** Calling this asks the engine for the next frame while the fade is still running. */
	constructor(private readonly requestFrame: () => void) {}

	start(snapshot: HTMLCanvasElement, duration: number): void {
		if (duration <= 0) {
			this.snapshot = null;
			return;
		}
		this.snapshot = snapshot;
		this.startedAt = performance.now();
		this.duration = duration;
	}

	render(rc: RenderContext): void {
		if (!this.snapshot) return;

		const elapsed = performance.now() - this.startedAt;
		const alpha = Math.max(0, 1 - elapsed / this.duration);
		if (alpha <= 0) {
			this.snapshot = null;
			return;
		}

		rc.ctx.save();
		rc.ctx.globalAlpha = alpha;
		// The snapshot is device pixels, so it is scaled to the CSS-sized frame here. The
		// context already carries the DPR transform.
		rc.ctx.drawImage(this.snapshot, 0, 0, rc.width, rc.height);
		rc.ctx.restore();

		if (!this.frameRequested) {
			this.frameRequested = true;
			requestAnimationFrame(() => {
				this.frameRequested = false;
				this.requestFrame();
			});
		}
	}
}
