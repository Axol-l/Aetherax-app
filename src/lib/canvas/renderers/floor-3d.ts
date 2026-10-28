/**
 * One floor, in three dimensions: walls extruded to their real height, in their material's
 * colour, with the plan and the coverage lying on the slab.
 *
 * Why this exists at all is the wall. On a plan every wall is a line of the same weight,
 * so a glass partition, a brick wall and an open doorway look alike and a 2.4 m partition
 * next to a 6 m atrium is invisible. The model has known the materials and the storey
 * height all along; this is the view where that knowledge comes back as geometry.
 *
 * The projection is the stacked view's camera — a parallel projection with yaw and pitch
 * and no perspective divide (`stacked-floors.ts` owns that maths, and the two views share
 * the sliders so switching between them keeps the viewpoint). A floor's own plane is
 * therefore an *affine* map of the plan, which is what lets the existing card renderer
 * draw the plan, the coverage and the room labels through one `ctx.transform` — no
 * per-pixel warping, no second colourizer.
 *
 * Read-only, like the overviews: a wall is drawn where the model says it is, and editing
 * stays in the single-floor view.
 */
import type { Layer, RenderContext } from '../types.js';
import {
	DEFAULT_STACK_CAMERA,
	projectPoint,
	type StackCamera
} from './stacked-floors.js';
import type { FloorCardCache, FloorCardSource } from './floor-card.js';
import { apMarkerColor } from './ap.js';
import { getMaterial } from '../materials.js';
import { surfaceBox, type ElevatedSurface } from '$lib/rf/surface-height.js';
import type { VectorWall } from '$state/vector-walls.js';

/** One quad to fill, projected into the drawing plane. */
interface Face {
	points: Array<{ x: number; y: number }>;
	/** Screen-space depth: larger is nearer the viewer, so it is painted last. */
	depth: number;
	fill: string;
	stroke: string | null;
}

/** How much of the wall's colour survives in shadow, so a corner is visible. */
const SHADE_MIN = 0.45;

export class Floor3DLayer implements Layer {
	id = 'floor3d';
	visible = false;
	camera: StackCamera = { ...DEFAULT_STACK_CAMERA, wupm: 32.8 };
	source: FloorCardSource | null = null;
	/** The floor's walls as segments: the geometry the extrusion is made of. */
	walls: VectorWall[] = [];
	/** Raised surfaces, drawn as the slabs they are. */
	surfaces: ElevatedSurface[] = [];
	/** Storey height, metres: what a wall without its own height is extruded to. */
	ceilingHeightM = 3;
	planOpacity = 0.85;
	showPlan = true;
	showWalls = true;
	showAPs = true;
	showHeatmap = true;

	constructor(private readonly cards: FloorCardCache) {}

	/** The box this floor occupies, in world coordinates. */
	private contentBox(): { x: number; y: number; w: number; h: number } | null {
		if (!this.source) return null;
		const box = this.cards.contentBox(this.source);
		return { x: box.minX, y: box.minY, w: box.w, h: box.h };
	}

	/** Where the floor's centre is, so turning the view turns about the floor. */
	private pivot(): { x: number; y: number; z: number } {
		const box = this.contentBox();
		if (!box) return { x: 0, y: 0, z: 0 };
		return { x: box.x + box.w / 2, y: box.y + box.h / 2, z: 0 };
	}

	/** The projected corners of the floor's box, at the slab and at the ceiling. */
	contentBounds(): Array<{ x: number; y: number }> {
		const box = this.contentBox();
		if (!box) return [];
		const pivot = this.pivot();
		const ceiling = this.ceilingHeightM * this.camera.wupm;
		const points: Array<{ x: number; y: number }> = [];
		for (const z of [0, ceiling]) {
			for (const corner of [
				{ x: box.x, y: box.y },
				{ x: box.x + box.w, y: box.y },
				{ x: box.x + box.w, y: box.y + box.h },
				{ x: box.x, y: box.y + box.h }
			]) {
				points.push(projectPoint(this.camera, corner.x, corner.y, z, pivot));
			}
		}
		return points;
	}

	render(rc: RenderContext): void {
		if (!this.visible) return;
		const src = this.source;
		const box = this.contentBox();
		if (!src || !box) return;
		const { ctx, camera } = rc;
		const zoom = camera.state.zoom || 1;
		const view = this.camera;
		const pivot = this.pivot();
		const cosYaw = Math.cos(view.yaw);
		const sinYaw = Math.sin(view.yaw);
		const cosPitch = Math.cos(view.pitch);
		const sinPitch = Math.sin(view.pitch);
		const [a, b, c, d, e, f] = camera.getTransform();

		ctx.save();
		ctx.transform(a, b, c, d, e, f);

		/** The slab's outline in the drawing plane, reused for the fill and the label. */
		const slab = [
			projectPoint(view, box.x, box.y, 0, pivot),
			projectPoint(view, box.x + box.w, box.y, 0, pivot),
			projectPoint(view, box.x + box.w, box.y + box.h, 0, pivot),
			projectPoint(view, box.x, box.y + box.h, 0, pivot)
		];

		/*
		 * The slab itself, before anything on it. A floor with no plan image and no
		 * coverage has nothing to draw in the plane, and walls standing on nothing read as
		 * floating rather than as a room — so the storey gets a surface of its own.
		 */
		ctx.globalAlpha = 1;
		ctx.fillStyle = 'rgba(38,42,54,0.55)';
		ctx.beginPath();
		ctx.moveTo(slab[0]!.x, slab[0]!.y);
		for (let i = 1; i < slab.length; i++) ctx.lineTo(slab[i]!.x, slab[i]!.y);
		ctx.closePath();
		ctx.fill();

		/*
		 * The slab: the plan, the coverage and the room labels, drawn through the floor's
		 * own affine transform. One transform for the whole plane is the reason this view
		 * can reuse the single-floor renderers at all — a perspective projection would
		 * need a warp, and a warp would need a second implementation of all of them.
		 *
		 * The walls are drawn as extrusions below, not as the raster, unless the floor has
		 * no segments at all: then the raster is the only statement of where its walls are
		 * and a flat plan is still better than a blank one.
		 */
		ctx.save();
		ctx.transform(
			cosYaw,
			sinYaw * cosPitch,
			-sinYaw,
			cosYaw * cosPitch,
			-cosYaw * pivot.x + sinYaw * pivot.y,
			-cosPitch * (sinYaw * pivot.x + cosYaw * pivot.y)
		);
		ctx.beginPath();
		ctx.rect(box.x, box.y, box.w, box.h);
		ctx.clip();
		ctx.globalAlpha = 1;
		this.cards.draw(ctx, src, {
			showPlan: this.showPlan,
			// A walled floor extrudes; a floor with no segments falls back to its raster.
			showWalls: this.showWalls && this.walls.length === 0,
			// Markers are drawn in the drawing plane below: a mounting height is not
			// expressible inside the floor's own transform.
			showAPs: false,
			showHeatmap: this.showHeatmap,
			planOpacity: this.planOpacity,
			zoom
		});
		ctx.restore();

		// The slab's own outline, in the drawing plane so it stays crisp at any yaw.
		ctx.globalAlpha = 1;
		ctx.strokeStyle = 'rgba(255,255,255,0.28)';
		ctx.lineWidth = 1 / zoom;
		ctx.beginPath();
		ctx.moveTo(slab[0]!.x, slab[0]!.y);
		for (let i = 1; i < slab.length; i++) ctx.lineTo(slab[i]!.x, slab[i]!.y);
		ctx.closePath();
		ctx.stroke();

		// Everything that stands up, painted back to front as one list: a wall behind a
		// mezzanine has to be behind it whether it was drawn first or not.
		const faces: Face[] = [];
		if (this.showWalls) faces.push(...this.wallFaces(view, pivot));
		faces.push(...this.surfaceFaces(view, pivot));
		faces.sort((l, r) => l.depth - r.depth);
		for (const face of faces) this.fillFace(ctx, face, zoom);

		if (this.showAPs) this.drawAccessPoints(ctx, src, view, pivot, zoom);

		// The floor's name, on the slab's topmost corner, so a reader knows what they are
		// looking at without the sidebar.
		ctx.font = `${13 / zoom}px sans-serif`;
		ctx.textBaseline = 'bottom';
		ctx.fillStyle = 'rgba(255,255,255,0.78)';
		const anchor = slab.reduce((best, p) => (p.y < best.y ? p : best), slab[0]!);
		ctx.fillText(src.name, anchor.x, anchor.y - 8 / zoom);

		ctx.restore();
	}

	private fillFace(ctx: CanvasRenderingContext2D, face: Face, zoom: number): void {
		ctx.beginPath();
		ctx.moveTo(face.points[0]!.x, face.points[0]!.y);
		for (let i = 1; i < face.points.length; i++) ctx.lineTo(face.points[i]!.x, face.points[i]!.y);
		ctx.closePath();
		ctx.fillStyle = face.fill;
		ctx.fill();
		if (face.stroke) {
			ctx.strokeStyle = face.stroke;
			ctx.lineWidth = 1 / zoom;
			ctx.stroke();
		}
	}

	/**
	 * Each wall as a quad from the slab to its top, in its material's colour.
	 *
	 * The shading is the angle between the wall and the view: a wall seen face-on keeps its
	 * colour, one seen edge-on darkens. That is what makes a corner read as a corner
	 * instead of two colours meeting at a line.
	 */
	private wallFaces(
		view: StackCamera,
		pivot: { x: number; y: number; z: number }
	): Face[] {
		const faces: Face[] = [];
		const cosYaw = Math.cos(view.yaw);
		const sinYaw = Math.sin(view.yaw);
		for (const wall of this.walls) {
			const dx = wall.bx - wall.ax;
			const dy = wall.by - wall.ay;
			const length = Math.hypot(dx, dy);
			if (length < 1) continue;
			const heightM = wall.heightM ?? this.ceilingHeightM;
			const top = Math.max(0.1, heightM) * view.wupm;
			const material = getMaterial(wall.material);
			// The wall's normal, in the floor's plane, against the viewing direction.
			const nx = -dy / length;
			const ny = dx / length;
			const facing = Math.abs(nx * sinYaw + ny * cosYaw);
			const shade = SHADE_MIN + (1 - SHADE_MIN) * facing;
			const [r, g, b] = material.color;
			const midX = (wall.ax + wall.bx) / 2 - pivot.x;
			const midY = (wall.ay + wall.by) / 2 - pivot.y;
			faces.push({
				points: [
					projectPoint(view, wall.ax, wall.ay, 0, pivot),
					projectPoint(view, wall.bx, wall.by, 0, pivot),
					projectPoint(view, wall.bx, wall.by, top, pivot),
					projectPoint(view, wall.ax, wall.ay, top, pivot)
				],
				// Screen y before the pitch is the depth ordering of a parallel projection.
				depth: sinYaw * midX + cosYaw * midY,
				fill: `rgba(${Math.round(r * shade)},${Math.round(g * shade)},${Math.round(b * shade)},0.92)`,
				stroke: 'rgba(0,0,0,0.35)'
			});
		}
		return faces;
	}

	/**
	 * A raised surface as the box it is: its top at the surface height, its sides down to
	 * the slab. A ramp's top is a sloping quad, which is exactly what its height field is.
	 */
	private surfaceFaces(
		view: StackCamera,
		pivot: { x: number; y: number; z: number }
	): Face[] {
		const faces: Face[] = [];
		for (const surface of this.surfaces) {
			const { x0, y0, x1, y1 } = surfaceBox(surface);
			if (x1 - x0 < 1 || y1 - y0 < 1) continue;
			const low = surface.heightM * view.wupm;
			const high = surface.topHeightM * view.wupm;
			const { ax, ay, bx, by } = surface;
			const horizontal = Math.abs(bx - ax) >= Math.abs(by - ay);
			const forward = horizontal ? bx >= ax : by >= ay;
			// The height at each of the four corners, from which end of the run it is on.
			const zAt = (x: number, y: number): number => {
				const t = horizontal
					? (x - x0) / (x1 - x0)
					: (y - y0) / (y1 - y0);
				return low + (high - low) * (forward ? t : 1 - t);
			};
			const corners = [
				{ x: x0, y: y0 },
				{ x: x1, y: y0 },
				{ x: x1, y: y1 },
				{ x: x0, y: y1 }
			];
			const top = corners.map((corner) =>
				projectPoint(view, corner.x, corner.y, Math.max(0, zAt(corner.x, corner.y)), pivot)
			);
			const midX = (x0 + x1) / 2 - pivot.x;
			const midY = (y0 + y1) / 2 - pivot.y;
			const depth = Math.cos(view.yaw) * midY + Math.sin(view.yaw) * midX;
			// The top of the box, then the four sides down to the slab. The sides are what
			// make it a raised surface rather than a tinted rectangle.
			faces.push({
				points: top,
				depth: depth + 0.01,
				fill: 'rgba(214,150,86,0.42)',
				stroke: 'rgba(255,214,170,0.8)'
			});
			for (let i = 0; i < corners.length; i++) {
				const a = corners[i]!;
				const b = corners[(i + 1) % corners.length]!;
				const aTop = Math.max(0, zAt(a.x, a.y));
				const bTop = Math.max(0, zAt(b.x, b.y));
				faces.push({
					points: [
						projectPoint(view, a.x, a.y, 0, pivot),
						projectPoint(view, b.x, b.y, 0, pivot),
						projectPoint(view, b.x, b.y, bTop, pivot),
						projectPoint(view, a.x, a.y, aTop, pivot)
					],
					depth,
					fill: 'rgba(150,104,58,0.55)',
					stroke: 'rgba(255,214,170,0.45)'
				});
			}
		}
		return faces;
	}

	/**
	 * Access points, at their mounting height with a stem down to the floor.
	 *
	 * The one thing this view adds to a marker: an AP on a desk and one on the ceiling are
	 * the same dot on a plan, and two metres apart in the room.
	 */
	private drawAccessPoints(
		ctx: CanvasRenderingContext2D,
		src: FloorCardSource,
		view: StackCamera,
		pivot: { x: number; y: number; z: number },
		zoom: number
	): void {
		const dotR = 4 / zoom;
		for (const ap of src.aps) {
			const heightWu = (ap.mountHeightM ?? 0) * view.wupm;
			const onFloor = projectPoint(view, ap.x, ap.y, 0, pivot);
			const at = projectPoint(view, ap.x, ap.y, heightWu, pivot);
			ctx.globalAlpha = 1;
			if (heightWu > 0) {
				ctx.strokeStyle = 'rgba(255,255,255,0.35)';
				ctx.lineWidth = 1 / zoom;
				ctx.beginPath();
				ctx.moveTo(onFloor.x, onFloor.y);
				ctx.lineTo(at.x, at.y);
				ctx.stroke();
			}
			ctx.fillStyle = apMarkerColor({
				assignedChannel: ap.assignedChannel ?? null,
				band: ap.band ?? '5ghz'
			});
			ctx.beginPath();
			ctx.arc(at.x, at.y, dotR, 0, Math.PI * 2);
			ctx.fill();
			ctx.strokeStyle = 'rgba(255,255,255,0.6)';
			ctx.lineWidth = 1 / zoom;
			ctx.stroke();
		}
	}
}
