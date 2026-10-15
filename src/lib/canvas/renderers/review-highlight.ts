import type { Layer, RenderContext } from '../types.js';

/**
 * One rectangle over the plan, for the vector review panel.
 *
 * The panel lists classified elements by their bounding box, and a list of
 * `path3603 · thin curved line` rows is not something a user can check against a
 * drawing. Pointing at a row draws that element's box, which is what makes "is this
 * curve a door or a stair rail" a question somebody can answer.
 *
 * Deliberately a plain rectangle rather than a highlight of the element's own geometry:
 * re-rendering one element of one role means another SVG pass, and the box is the thing
 * the classifier actually reasoned about — a reviewer checking the classifier should see
 * the classifier's own evidence.
 */
export class ReviewHighlightLayer implements Layer {
	id = 'review-highlight';
	visible = true;

	/** World-space box, or null for nothing to draw. */
	box: { x: number; y: number; w: number; h: number } | null = null;

	render(rc: RenderContext): void {
		if (!this.box) return;
		const { ctx, camera } = rc;
		const [a, b, c, d, e, f] = camera.getTransform();
		ctx.save();
		ctx.transform(a, b, c, d, e, f);

		const zoom = camera.state.zoom || 1;
		// A wall line is a degenerate box — zero height, or zero width — and a rectangle
		// with no area draws nothing. Padding by a few *screen* pixels makes every element
		// visible at any zoom, and turns a thin door arc into a legible band.
		const pad = 4 / zoom;
		const x = this.box.x - pad;
		const y = this.box.y - pad;
		const w = this.box.w + pad * 2;
		const h = this.box.h + pad * 2;

		ctx.fillStyle = 'rgba(255, 176, 32, 0.18)';
		ctx.fillRect(x, y, w, h);
		ctx.strokeStyle = 'rgba(255, 176, 32, 0.85)';
		ctx.lineWidth = 1.5 / zoom;
		ctx.strokeRect(x, y, w, h);
		ctx.restore();
	}
}
