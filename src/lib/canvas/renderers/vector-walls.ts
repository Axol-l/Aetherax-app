import type { Layer, RenderContext } from '../types.js';
import type { VectorColumn, VectorWall } from '../../state/vector-walls.js';
import { getMaterial, type WallMaterialId } from '$lib/domain/materials.js';

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
	/**
	 * Columns: a pier or a round pillar. Filled in their material's colour, because what
	 * they obstruct is their footprint rather than a line.
	 */
	columns: readonly VectorColumn[] = [];
	selectedId: string | null = null;
	/** The selected column, when a column is what is selected. */
	selectedColumnId: string | null = null;
	/** The first click of the wall being drawn, and where the pointer is now. */
	draft: { x: number; y: number } | null = null;
	/** The rectangle or circle being drawn, as two opposite corners (a circle's centre + rim). */
	columnDraft: { shape: 'rect' | 'circle'; ax: number; ay: number; bx: number; by: number } | null =
		null;
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
		if (this.walls.length === 0 && this.columns.length === 0 && !this.draft && !this.columnDraft)
			return;
		const { ctx, camera } = rc;
		const [m0, m1, m2, m3, m4, m5] = camera.getTransform();
		ctx.transform(m0, m1, m2, m3, m4, m5);
		const zoom = camera.state.zoom;

		// The drawing colour: green, the same accent the app uses for "this is going right".
		const DRAW = 'rgba(74, 222, 128, ';

		/*
		 * The stroke width, in **world** units: the smallest brush the raster tool offers
		 * (radius 3, so 6 units across). A vector wall and a painted one then have the same
		 * thickness on the plan, and the line grows with the zoom instead of staying a
		 * hairline on top of a thick wall. The floor of one screen pixel keeps it visible when
		 * the plan is zoomed far out.
		 */
		const stroke = Math.max(1 / zoom, 6);

		for (const wall of this.walls) {
			const material = getMaterial(wall.material);
			const selected = wall.id === this.selectedId;
			ctx.beginPath();
			ctx.moveTo(wall.ax, wall.ay);
			ctx.lineTo(wall.bx, wall.by);
			ctx.strokeStyle = `rgba(${material.color[0]}, ${material.color[1]}, ${material.color[2]}, ${selected ? 1 : 0.9})`;
			ctx.lineWidth = selected ? stroke * 1.4 : stroke;
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
				ctx.arc(point.x, point.y, (selected ? 1.4 : 1) * stroke * 0.55, 0, Math.PI * 2);
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

		// Columns, under the segments: a wall that meets a pier should be drawn over it.
		for (const column of this.columns) {
			this.drawColumn(
				ctx,
				column.shape,
				column.ax,
				column.ay,
				column.bx,
				column.by,
				column.material,
				column.id === this.selectedColumnId,
				stroke,
				zoom,
				false
			);
		}
		if (this.columnDraft) {
			this.drawColumn(
				ctx,
				this.columnDraft.shape,
				this.columnDraft.ax,
				this.columnDraft.ay,
				this.columnDraft.bx,
				this.columnDraft.by,
				0,
				false,
				stroke,
				zoom,
				true
			);
		}

		if (this.draft) {
			const end = this.cursor ?? this.draft;
			ctx.beginPath();
			ctx.moveTo(this.draft.x, this.draft.y);
			ctx.lineTo(end.x, end.y);
			ctx.strokeStyle = `${DRAW}0.95)`;
			ctx.lineWidth = stroke;
			ctx.setLineDash([6 / zoom, 4 / zoom]);
			ctx.stroke();
			ctx.setLineDash([]);

			ctx.beginPath();
			ctx.arc(this.draft.x, this.draft.y, stroke * 0.6, 0, Math.PI * 2);
			ctx.fillStyle = `${DRAW}1)`;
			ctx.fill();
		}

		// The endpoint this click would land on, ringed before it lands.
		if (this.snapTarget) {
			ctx.beginPath();
			ctx.arc(this.snapTarget.x, this.snapTarget.y, stroke * 1.6, 0, Math.PI * 2);
			ctx.strokeStyle = `${DRAW}0.95)`;
			ctx.lineWidth = Math.max(1 / zoom, stroke * 0.25);
			ctx.stroke();
		}
	}

	/**
	 * One column: a filled rectangle or circle in its material's colour.
	 *
	 * The draft is drawn with the same green as a wall being drawn, dashed, so an
	 * uncommitted shape cannot be mistaken for an obstruction the model already has.
	 */
	private drawColumn(
		ctx: CanvasRenderingContext2D,
		shape: 'rect' | 'circle',
		ax: number,
		ay: number,
		bx: number,
		by: number,
		material: number,
		selected: boolean,
		stroke: number,
		zoom: number,
		isDraft: boolean
	): void {
		const colour = getMaterial(material as WallMaterialId).color;
		ctx.beginPath();
		if (shape === 'circle') {
			const radius = Math.hypot(bx - ax, by - ay);
			ctx.arc(ax, ay, Math.max(radius, 0.5), 0, Math.PI * 2);
		} else {
			ctx.rect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
		}
		ctx.fillStyle = isDraft ? 'rgba(74, 222, 128, 0.22)' : `rgba(${colour[0]}, ${colour[1]}, ${colour[2]}, ${selected ? 0.55 : 0.4})`;
		ctx.fill();
		ctx.strokeStyle = isDraft
			? 'rgba(74, 222, 128, 0.95)'
			: `rgba(${colour[0]}, ${colour[1]}, ${colour[2]}, ${selected ? 1 : 0.9})`;
		ctx.lineWidth = selected ? stroke * 0.6 : stroke * 0.4;
		ctx.setLineDash(isDraft ? [6 / zoom, 4 / zoom] : []);
		ctx.stroke();
		ctx.setLineDash([]);
	}
}
