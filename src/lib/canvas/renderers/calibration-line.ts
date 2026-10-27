import type { Layer, RenderContext } from '../types.js';

/**
 * The measured line, drawn while the user calibrates.
 *
 * Two clicks and a straight line between them: the whole point of calibrating this way is
 * that the user is matching a drawn segment against a stated distance, so the segment has
 * to be visible on the plan they are matching it against. A dashed line with a tick at
 * each end reads as a measurement rather than as an object on the drawing.
 */
export class CalibrationLineLayer implements Layer {
	id = 'calibration-line';
	visible = true;

	/** World coordinates of the first and second click. */
	a: { x: number; y: number } | null = null;
	b: { x: number; y: number } | null = null;

	render(rc: RenderContext): void {
		if (!this.a) return;
		const { ctx, camera } = rc;
		const [m0, m1, m2, m3, m4, m5] = camera.getTransform();
		ctx.transform(m0, m1, m2, m3, m4, m5);

		const zoom = camera.state.zoom;
		const end = this.b ?? this.a;

		ctx.strokeStyle = 'rgba(0, 200, 200, 0.95)';
		ctx.lineWidth = 2 / zoom;
		ctx.setLineDash([6 / zoom, 4 / zoom]);
		ctx.beginPath();
		ctx.moveTo(this.a.x, this.a.y);
		ctx.lineTo(end.x, end.y);
		ctx.stroke();
		ctx.setLineDash([]);

		// Ends: a solid dot at each, so a short segment is still visible at any zoom.
		for (const point of [this.a, this.b]) {
			if (!point) continue;
			ctx.beginPath();
			ctx.arc(point.x, point.y, 3.5 / zoom, 0, Math.PI * 2);
			ctx.fillStyle = 'rgba(0, 200, 200, 1)';
			ctx.fill();
			ctx.strokeStyle = 'rgba(10, 12, 18, 0.9)';
			ctx.lineWidth = 1 / zoom;
			ctx.stroke();
		}
	}
}
