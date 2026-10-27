import type { Layer, RenderContext } from '../types.js';
import type { VectorWall } from '../../state/vector-walls.js';
import { getMaterial } from '../materials.js';

/**
 * Walls drawn as line segments, over the plan.
 *
 * Each segment is stroked in its material's colour, so the drawing itself says what the
 * model will charge: red for brick, blue-grey for concrete, green dashed for a virtual
 * partition that attenuates nothing. The line is a couple of pixels wide regardless of
 * zoom — it is a schematic, not a plan of the wall's thickness — and a selected wall is
 * drawn thicker and lighter so a delete has something to aim at.
 *
 * The draft segment follows the pointer, so the wall being drawn is visible before the
 * second click commits it.
 */
export class VectorWallsLayer implements Layer {
	id = 'vector-walls';
	visible = true;

	walls: readonly VectorWall[] = [];
	selectedId: string | null = null;
	/** The first click of the wall being drawn, and where the pointer is now. */
	draft: { x: number; y: number } | null = null;
	cursor: { x: number; y: number } | null = null;
	/**
	 * The endpoint the next click will snap to, if any.
	 *
	 * Drawn as a ring before the click lands, which is the whole point: snapping that happens
	 * silently is a wall that was *going* to meet another one and did not, and the user only
	 * finds out later, when the model leaks through the gap.
	 */
	snapTarget: { x: number; y: number } | null = null;
	/** World units per metre, for the length readout on the selected wall. */
	wupm = 1;

	render(rc: RenderContext): void {
		if (this.walls.length === 0 && !this.draft) return;
		const { ctx, camera } = rc;
		const [m0, m1, m2, m3, m4, m5] = camera.getTransform();
		ctx.transform(m0, m1, m2, m3, m4, m5);
		const zoom = camera.state.zoom;

		// The drawing colour: green, the same accent the app uses for "this is going right".
		const DRAW = 'rgba(74, 222, 128, ';

		for (const wall of this.walls) {
			const material = getMaterial(wall.material);
			const selected = wall.id === this.selectedId;
			ctx.beginPath();
			ctx.moveTo(wall.ax, wall.ay);
			ctx.lineTo(wall.bx, wall.by);
			ctx.strokeStyle = `rgba(${material.color[0]}, ${material.color[1]}, ${material.color[2]}, ${selected ? 1 : 0.9})`;
			ctx.lineWidth = (selected ? 3.5 : 2) / zoom;
			// A virtual partition is a modelling line rather than a surface: dashed says so
			// without a legend.
			ctx.setLineDash(material.dbPerMeter['5ghz'] === 0 ? [5 / zoom, 4 / zoom] : []);
			ctx.stroke();
			ctx.setLineDash([]);

			// Endpoints, so a wall that meets another one visibly meets it.
			for (const point of [
				{ x: wall.ax, y: wall.ay },
				{ x: wall.bx, y: wall.by }
			]) {
				ctx.beginPath();
				ctx.arc(point.x, point.y, (selected ? 3 : 2.2) / zoom, 0, Math.PI * 2);
				ctx.fillStyle = `rgba(${material.color[0]}, ${material.color[1]}, ${material.color[2]}, 1)`;
				ctx.fill();
			}

			// The selected wall's length: the confirmation that the segment went where it was
			// meant to, and the number a plan is checked against.
			if (selected) {
				const metres = Math.hypot(wall.bx - wall.ax, wall.by - wall.ay) / (this.wupm || 1);
				const label = `${metres.toFixed(2)} m`;
				ctx.font = `${11 / zoom}px 'Inter', system-ui, sans-serif`;
				const midX = (wall.ax + wall.bx) / 2;
				const midY = (wall.ay + wall.by) / 2;
				const width = ctx.measureText(label).width;
				const padX = 4 / zoom;
				const padY = 3 / zoom;
				ctx.beginPath();
				ctx.roundRect(
					midX - width / 2 - padX,
					midY - 9 / zoom - padY,
					width + padX * 2,
					13 / zoom + padY,
					3 / zoom
				);
				ctx.fillStyle = 'rgba(16, 20, 28, 0.9)';
				ctx.fill();
				ctx.fillStyle = `${DRAW}0.98)`;
				ctx.textBaseline = 'middle';
				ctx.fillText(label, midX - width / 2, midY - 2 / zoom);
			}
		}

		if (this.draft) {
			const end = this.cursor ?? this.draft;
			ctx.beginPath();
			ctx.moveTo(this.draft.x, this.draft.y);
			ctx.lineTo(end.x, end.y);
			ctx.strokeStyle = `${DRAW}0.95)`;
			ctx.lineWidth = 2 / zoom;
			ctx.setLineDash([6 / zoom, 4 / zoom]);
			ctx.stroke();
			ctx.setLineDash([]);

			ctx.beginPath();
			ctx.arc(this.draft.x, this.draft.y, 3.5 / zoom, 0, Math.PI * 2);
			ctx.fillStyle = `${DRAW}1)`;
			ctx.fill();
		}

		// The endpoint this click would land on, ringed before it lands.
		if (this.snapTarget) {
			ctx.beginPath();
			ctx.arc(this.snapTarget.x, this.snapTarget.y, 7 / zoom, 0, Math.PI * 2);
			ctx.strokeStyle = `${DRAW}0.95)`;
			ctx.lineWidth = 1.5 / zoom;
			ctx.stroke();
		}
	}
}
