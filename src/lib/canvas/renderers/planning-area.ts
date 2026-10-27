import type { Layer, RenderContext } from '../types.js';

/**
 * The planning area, drawn on the plan it describes.
 *
 * Two things share this layer: the polygon the user has committed (a dashed loop with a
 * translucent fill, so the walls under it stay readable) and the loop being drawn (a solid
 * line through the clicks so far, with a dot at each). They are one layer because they are
 * one statement — "this is the floor" — in two states, and a second layer would have to
 * repeat the coordinate transform and the dash/width arithmetic for no gain.
 *
 * Points are world coordinates, so the drawing stays inside the camera transform and grows
 * with the plan.
 */
export class PlanningAreaLayer implements Layer {
	id = 'planning-area';
	visible = true;

	/** The committed area, if the floor has one. */
	area: Array<{ x: number; y: number }> | null = null;
	/** The loop being drawn, before it is committed. */
	draft: Array<{ x: number; y: number }> = [];

	render(rc: RenderContext): void {
		const hasArea = this.area && this.area.length >= 3;
		if (!hasArea && this.draft.length === 0) return;

		const { ctx, camera } = rc;
		const [m0, m1, m2, m3, m4, m5] = camera.getTransform();
		ctx.transform(m0, m1, m2, m3, m4, m5);
		const zoom = camera.state.zoom;

		if (hasArea) {
			const area = this.area!;
			ctx.beginPath();
			ctx.moveTo(area[0]!.x, area[0]!.y);
			for (let i = 1; i < area.length; i++) ctx.lineTo(area[i]!.x, area[i]!.y);
			ctx.closePath();
			// A wash rather than a fill: this covers the part of the plan the user is saying
			// is the floor, and it must not hide the walls inside it.
			ctx.fillStyle = 'rgba(0, 200, 200, 0.06)';
			ctx.fill();
			ctx.strokeStyle = 'rgba(0, 200, 200, 0.55)';
			ctx.lineWidth = 1.5 / zoom;
			ctx.setLineDash([8 / zoom, 5 / zoom]);
			ctx.stroke();
			ctx.setLineDash([]);
		}

		if (this.draft.length > 0) {
			ctx.beginPath();
			ctx.moveTo(this.draft[0]!.x, this.draft[0]!.y);
			for (let i = 1; i < this.draft.length; i++) ctx.lineTo(this.draft[i]!.x, this.draft[i]!.y);
			ctx.strokeStyle = 'rgba(0, 220, 220, 0.95)';
			ctx.lineWidth = 2 / zoom;
			ctx.stroke();

			for (const point of this.draft) {
				ctx.beginPath();
				ctx.arc(point.x, point.y, 3.5 / zoom, 0, Math.PI * 2);
				ctx.fillStyle = 'rgba(0, 220, 220, 1)';
				ctx.fill();
				ctx.strokeStyle = 'rgba(10, 12, 18, 0.9)';
				ctx.lineWidth = 1 / zoom;
				ctx.stroke();
			}
		}
	}
}
