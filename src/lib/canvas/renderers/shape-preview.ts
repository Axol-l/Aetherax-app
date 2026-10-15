import type { Layer, RenderContext } from '../types.js';

/**
 * Outline of the line, rectangle or arc currently being dragged.
 *
 * Shape tools rasterise on release, so while the pointer is down there is
 * nothing in the wall mask to show. Drawing the pending geometry here keeps the
 * mask untouched until commit, which avoids snapshotting and restoring mask
 * tiles on every pointer move.
 */
export class ShapePreviewLayer implements Layer {
	id = 'shape-preview';
	visible = true;

	active = false;
	kind: 'line' | 'rect' | 'arc' = 'line';

	// Line / rect endpoints.
	startX = 0;
	startY = 0;
	endX = 0;
	endY = 0;

	// Arc: centre, radius and a signed sweep in radians. A sweep of a full turn
	// means a closed circle.
	centerX = 0;
	centerY = 0;
	radius = 0;
	startAngle = 0;
	sweep = 0;

	/** Full stroke width in world units, so the preview matches what gets painted. */
	strokeWidth = 30;

	render(rc: RenderContext): void {
		if (!this.active) return;
		const { ctx, camera } = rc;
		const [a, b, c, d, e, f] = camera.getTransform();
		const zoom = camera.state.zoom;

		ctx.save();
		ctx.transform(a, b, c, d, e, f);

		const path = new Path2D();
		if (this.kind === 'line') {
			path.moveTo(this.startX, this.startY);
			path.lineTo(this.endX, this.endY);
		} else if (this.kind === 'rect') {
			path.rect(
				Math.min(this.startX, this.endX),
				Math.min(this.startY, this.endY),
				Math.abs(this.endX - this.startX),
				Math.abs(this.endY - this.startY)
			);
		} else if (this.radius > this.strokeWidth / 2) {
			path.arc(this.centerX, this.centerY, this.radius, this.startAngle, this.startAngle + this.sweep);
		}

		// Filled band showing the actual brush footprint...
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		ctx.lineWidth = Math.max(1, this.strokeWidth);
		ctx.strokeStyle = 'rgba(75, 227, 160, 0.28)';
		ctx.stroke(path);

		// ...with a thin dashed centreline so the exact position stays readable no
		// matter how wide the brush is.
		ctx.lineWidth = 1 / zoom;
		ctx.setLineDash([5 / zoom, 5 / zoom]);
		ctx.strokeStyle = 'rgba(214, 255, 235, 0.85)';
		ctx.stroke(path);
		ctx.setLineDash([]);

		// Arc guides: show the centre and radius so the geometry is unambiguous.
		if (this.kind === 'arc' && this.radius > this.strokeWidth / 2) {
			ctx.beginPath();
			ctx.moveTo(this.centerX, this.centerY);
			ctx.lineTo(
				this.centerX + Math.cos(this.startAngle) * this.radius,
				this.centerY + Math.sin(this.startAngle) * this.radius
			);
			ctx.lineWidth = 1 / zoom;
			ctx.setLineDash([3 / zoom, 3 / zoom]);
			ctx.strokeStyle = 'rgba(75, 227, 160, 0.5)';
			ctx.stroke();
			ctx.setLineDash([]);
		}

		ctx.restore();
	}
}
