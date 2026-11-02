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
	/**
	 * The draft has been closed on its first corner and is waiting for the bar's confirm.
	 *
	 * It is still a draft: the old area is on the floor until the confirm replaces it, and
	 * the label says so.
	 */
	draftClosed = false;
	/**
	 * Where the pointer is while drawing, in world coordinates.
	 *
	 * The rubber band from the last corner to the cursor is what makes this a drawing tool
	 * rather than a click-counter: with it the next edge is visible before it is committed,
	 * and the closing edge is previewed too, so the shape can be judged as a room and not as
	 * a list of points.
	 */
	cursor: { x: number; y: number } | null = null;

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

		if (this.draft.length > 0 && this.draftClosed && this.draft.length >= 3) {
			// Closed shape, waiting for confirmation: a dashed cyan loop over the committed
			// one, so it reads as a proposal rather than as the new floor already.
			ctx.beginPath();
			ctx.moveTo(this.draft[0]!.x, this.draft[0]!.y);
			for (let i = 1; i < this.draft.length; i++) {
				ctx.lineTo(this.draft[i]!.x, this.draft[i]!.y);
			}
			ctx.closePath();
			ctx.fillStyle = 'rgba(0, 220, 220, 0.05)';
			ctx.fill();
			ctx.strokeStyle = 'rgba(0, 220, 220, 0.95)';
			ctx.lineWidth = 2 / zoom;
			ctx.setLineDash([8 / zoom, 5 / zoom]);
			ctx.stroke();
			ctx.setLineDash([]);
			for (const point of this.draft) {
				ctx.beginPath();
				ctx.arc(point.x, point.y, 3.5 / zoom, 0, Math.PI * 2);
				ctx.fillStyle = 'rgba(0, 220, 220, 1)';
				ctx.fill();
				ctx.strokeStyle = 'rgba(10, 12, 18, 0.9)';
				ctx.lineWidth = 1 / zoom;
				ctx.stroke();
			}
			return;
		}

		if (this.draft.length > 0) {
			const last = this.draft[this.draft.length - 1]!;
			const target = this.cursor ?? last;

			// The committed edges.
			ctx.beginPath();
			ctx.moveTo(this.draft[0]!.x, this.draft[0]!.y);
			for (let i = 1; i < this.draft.length; i++) ctx.lineTo(this.draft[i]!.x, this.draft[i]!.y);
			ctx.strokeStyle = 'rgba(0, 220, 220, 0.95)';
			ctx.lineWidth = 2 / zoom;
			ctx.stroke();

			// The edge being drawn, and the one that would close the loop.
			if (this.cursor && this.draft.length >= 2) {
				ctx.beginPath();
				ctx.moveTo(last.x, last.y);
				ctx.lineTo(target.x, target.y);
				ctx.lineTo(this.draft[0]!.x, this.draft[0]!.y);
				ctx.strokeStyle = 'rgba(0, 220, 220, 0.45)';
				ctx.lineWidth = 1.5 / zoom;
				ctx.setLineDash([6 / zoom, 5 / zoom]);
				ctx.stroke();
				ctx.setLineDash([]);
			} else if (this.cursor) {
				ctx.beginPath();
				ctx.moveTo(last.x, last.y);
				ctx.lineTo(target.x, target.y);
				ctx.strokeStyle = 'rgba(0, 220, 220, 0.45)';
				ctx.lineWidth = 1.5 / zoom;
				ctx.setLineDash([6 / zoom, 5 / zoom]);
				ctx.stroke();
				ctx.setLineDash([]);
			}

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
