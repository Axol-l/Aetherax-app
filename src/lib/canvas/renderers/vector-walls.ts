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

	render(rc: RenderContext): void {
		if (this.walls.length === 0 && !this.draft) return;
		const { ctx, camera } = rc;
		const [m0, m1, m2, m3, m4, m5] = camera.getTransform();
		ctx.transform(m0, m1, m2, m3, m4, m5);
		const zoom = camera.state.zoom;

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
		}

		if (this.draft) {
			const end = this.cursor ?? this.draft;
			ctx.beginPath();
			ctx.moveTo(this.draft.x, this.draft.y);
			ctx.lineTo(end.x, end.y);
			ctx.strokeStyle = 'rgba(120, 220, 255, 0.95)';
			ctx.lineWidth = 2 / zoom;
			ctx.setLineDash([6 / zoom, 4 / zoom]);
			ctx.stroke();
			ctx.setLineDash([]);

			ctx.beginPath();
			ctx.arc(this.draft.x, this.draft.y, 3.5 / zoom, 0, Math.PI * 2);
			ctx.fillStyle = 'rgba(120, 220, 255, 1)';
			ctx.fill();
		}
	}
}
