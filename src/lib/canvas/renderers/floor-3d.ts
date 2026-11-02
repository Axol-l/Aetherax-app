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
import { getMaterial, type WallMaterialId } from '$lib/domain/materials.js';
import { surfaceBox, surfaceColor, surfaceThickness, stepCount, type ElevatedSurface } from '$lib/rf/surface-height.js';
import type { VectorColumn, VectorWall } from '$state/vector-walls.js';

/** One quad to fill, projected into the drawing plane. */
interface Face {
	points: Array<{ x: number; y: number }>;
	/** Screen-space depth: larger is nearer the viewer, so it is painted last. */
	depth: number;
	fill: string;
	stroke: string | null;
}

/**
 * The band a wall occupies on the plan, in world units.
 *
 * The same figure `wall-raster.ts` paints and the vector layer strokes with, so the 3D
 * extrusion and the plan agree about how thick a wall is.
 */
const WALL_BAND_WU = 6;

export class Floor3DLayer implements Layer {
	id = 'floor3d';
	visible = false;
	camera: StackCamera = { ...DEFAULT_STACK_CAMERA, wupm: 32.8 };
	source: FloorCardSource | null = null;
	/** The floor's walls as segments: the geometry the extrusion is made of. */
	walls: VectorWall[] = [];
	/** Columns: a pier or a round pillar, extruded like a wall with no length. */
	columns: VectorColumn[] = [];
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
		if (this.showWalls) faces.push(...this.wallFaces(view, pivot), ...this.columnFaces(view, pivot));
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

	/**
	 * Columns, as the prisms they are: a rectangle is a box, a circle an octagon.
	 *
	 * A pillar is a wall with no length, so it is extruded to the same height and painted the
	 * same way — which is also how the model treats it (a filled footprint in the mask).
	 */
	private columnFaces(
		view: StackCamera,
		pivot: { x: number; y: number; z: number }
	): Face[] {
		const faces: Face[] = [];
		const top = Math.max(0.1, this.ceilingHeightM) * view.wupm;
		const cosYaw = Math.cos(view.yaw);
		const sinYaw = Math.sin(view.yaw);
		for (const column of this.columns) {
			const material = getMaterial(column.material as WallMaterialId);
			const [r, g, b] = material.color;
			const points: Array<{ x: number; y: number }> =
				column.shape === 'circle'
					? Array.from({ length: 8 }, (_, i) => {
							const angle = (i / 8) * Math.PI * 2;
							const radius = Math.hypot(column.bx - column.ax, column.by - column.ay);
							return {
								x: column.ax + Math.cos(angle) * radius,
								y: column.ay + Math.sin(angle) * radius
							};
						})
					: [
							{ x: Math.min(column.ax, column.bx), y: Math.min(column.ay, column.by) },
							{ x: Math.max(column.ax, column.bx), y: Math.min(column.ay, column.by) },
							{ x: Math.max(column.ax, column.bx), y: Math.max(column.ay, column.by) },
							{ x: Math.min(column.ax, column.bx), y: Math.max(column.ay, column.by) }
						];
			const midX = (points.reduce((s, p) => s + p.x, 0) / points.length) - pivot.x;
			const midY = (points.reduce((s, p) => s + p.y, 0) / points.length) - pivot.y;
			const depth = sinYaw * midX + cosYaw * midY;
			for (let i = 0; i < points.length; i++) {
				const p1 = points[i]!;
				const p2 = points[(i + 1) % points.length]!;
				const nx = p2.y - p1.y;
				const ny = p1.x - p2.x;
				const norm = Math.max(1e-6, Math.hypot(nx, ny));
				// Back faces only: the prism is closed, so half its sides point away.
				if ((nx / norm) * sinYaw + (ny / norm) * cosYaw < 0) continue;
				const shade = 0.8;
				faces.push({
					points: [
						projectPoint(view, p1.x, p1.y, 0, pivot),
						projectPoint(view, p2.x, p2.y, 0, pivot),
						projectPoint(view, p2.x, p2.y, top, pivot),
						projectPoint(view, p1.x, p1.y, top, pivot)
					],
					depth: depth + 0.001 * i,
					fill: `rgba(${Math.round(r * shade)},${Math.round(g * shade)},${Math.round(b * shade)},0.94)`,
					stroke: null
				});
			}
			// The cap: without it the prism is open at the top and reads as a tube.
			faces.push({
				points: points.map((p) => projectPoint(view, p.x, p.y, top, pivot)),
				depth: depth + 0.02,
				fill: `rgba(${Math.round(r * 0.95)},${Math.round(g * 0.95)},${Math.round(b * 0.95)},0.96)`,
				stroke: 'rgba(0,0,0,0.22)'
			});
		}
		return faces;
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
			/*
			 * One tone for every wall, not a shade per orientation.
			 *
			 * Shading each wall by how it faces the viewer made two walls that overlap at a
			 * corner *different colours* exactly where they meet, so the seam was as visible
			 * as the wall — which is what "the walls look overlapping" was. All walls the same
			 * tone means an overlap is invisible; the top face's lighter edge is what gives a
			 * corner its definition.
			 */
			const shade = facing >= 0 ? 0.82 : 0.82;
			const [r, g, b] = material.color;
			const midX = (wall.ax + wall.bx) / 2 - pivot.x;
			const midY = (wall.ay + wall.by) / 2 - pivot.y;
			const depth = sinYaw * midX + cosYaw * midY;
			/*
			 * One visible face per wall, plus its top — not a five-sided box.
			 *
			 * The raster band is what the plan shows, so the extrusion keeps its width, but
			 * drawing both long faces and both end caps put a stroked edge *inside* every
			 * junction: two walls meeting at a corner each drew the cap the other one covered,
			 * and the seams read as overlapping slabs. Culling to the face that points at the
			 * viewer — and filling it in one tone with no stroke — makes two adjacent walls
			 * the same colour where they meet, so the only edges left are real silhouettes.
			 */
			const half = WALL_BAND_WU / 2;
			/*
			 * Each wall is extended by half its band at both ends.
			 *
			 * Two boxes centred on their segments meet at a corner at an angle, and between
			 * them is a notch of background — the dark strip through every junction in the
			 * 3D view. Extending each end by half a band makes the two overlap instead, and
			 * because every wall is one tone the overlap is invisible.
			 */
			const ux = dx / length;
			const uy = dy / length;
			const ax2 = wall.ax - ux * half;
			const ay2 = wall.ay - uy * half;
			const bx2 = wall.bx + ux * half;
			const by2 = wall.by + uy * half;
			const viewerFacing = nx * sinYaw + ny * cosYaw;
			const a1 = { x: ax2 + nx * half, y: ay2 + ny * half };
			const a2 = { x: ax2 - nx * half, y: ay2 - ny * half };
			const b1 = { x: bx2 + nx * half, y: by2 + ny * half };
			const b2 = { x: bx2 - nx * half, y: by2 - ny * half };
			const near = viewerFacing >= 0 ? { a: a1, b: b1 } : { a: a2, b: b2 };
			const fill = (tone: number) =>
				`rgba(${Math.round(r * tone)},${Math.round(g * tone)},${Math.round(b * tone)},0.94)`;
			faces.push({
				points: [
					projectPoint(view, near.a.x, near.a.y, 0, pivot),
					projectPoint(view, near.b.x, near.b.y, 0, pivot),
					projectPoint(view, near.b.x, near.b.y, top, pivot),
					projectPoint(view, near.a.x, near.a.y, top, pivot)
				],
				depth,
				fill: fill(shade),
				// No stroke: the fill is the silhouette, and a stroke is what drew the seams.
				stroke: null
			});
			// The top face only, outlined, so a wall reads as solid from above and a corner has
			// an edge without every junction drawing one.
			faces.push({
				points: [
					projectPoint(view, a1.x, a1.y, top, pivot),
					projectPoint(view, b1.x, b1.y, top, pivot),
					projectPoint(view, b2.x, b2.y, top, pivot),
					projectPoint(view, a2.x, a2.y, top, pivot)
				],
				depth: depth + 0.03,
				fill: fill(Math.min(1, shade + 0.15)),
				stroke: 'rgba(0,0,0,0.22)'
			});
		}
		return faces;
	}

	/**
	 * A raised surface as the solid it is: a deck with thickness, a ramp with a sloping
	 * top, a stair as its treads.
	 *
	 * The thickness is the difference between "a coloured rectangle" and "a mezzanine": a
	 * deck has an underside, and a stair is a *flight* — drawing it as one sloping plane
	 * would say the thing the model deliberately does not (a step function through the
	 * sample grid). The treads are therefore drawn, at the same 0.3 m depth the panel
	 * reports, and the model keeps its continuous equivalent.
	 */
	private surfaceFaces(
		view: StackCamera,
		pivot: { x: number; y: number; z: number }
	): Face[] {
		const faces: Face[] = [];

		for (const surface of this.surfaces) {
			/*
			 * The deck's own colour: a steel mezzanine and a timber gallery are different
			 * obstacles and now look it. The top is the material at half strength, the sides
			 * a shade darker and the edge lighter, so the slab reads as solid in the oblique
			 * view without losing the hue.
			 */
			const [sr, sg, sb] = surfaceColor(surface.material);
			const shade = (channel: number, factor: number) =>
				Math.round(Math.min(255, channel * factor));
			const TOP_FILL = `rgba(${sr},${sg},${sb},0.5)`;
			const SIDE_FILL = `rgba(${shade(sr, 0.72)},${shade(sg, 0.72)},${shade(sb, 0.72)},0.62)`;
			const EDGE = `rgba(${shade(sr, 1.25)},${shade(sg, 1.25)},${shade(sb, 1.25)},0.75)`;

			const { x0, y0, x1, y1 } = surfaceBox(surface);
			if (x1 - x0 < 1 || y1 - y0 < 1) continue;
			const low = Math.max(0, surface.heightM) * view.wupm;
			const high = Math.max(0, surface.topHeightM) * view.wupm;
			const thickness = Math.max(0.02, surfaceThickness(surface)) * view.wupm;
			const base = surface.solidBase ? 0 : null;
			const { ax, ay, bx, by } = surface;
			const horizontal = Math.abs(bx - ax) >= Math.abs(by - ay);
			const forward = horizontal ? bx >= ax : by >= ay;
			const runFrac = (x: number, y: number): number => {
				const t = horizontal ? (x - x0) / (x1 - x0) : (y - y0) / (y1 - y0);
				return Math.min(1, Math.max(0, forward ? t : 1 - t));
			};
			const heightAt = (x: number, y: number): number => low + (high - low) * runFrac(x, y);

			const midX = (x0 + x1) / 2 - pivot.x;
			const midY = (y0 + y1) / 2 - pivot.y;
			const depth = Math.cos(view.yaw) * midY + Math.sin(view.yaw) * midX;
			const quad = (
				points: Array<{ x: number; y: number; z: number }>,
				fill: string,
				order: number
			): Face => ({
				points: points.map((p) => projectPoint(view, p.x, p.y, p.z, pivot)),
				depth: depth + order,
				fill,
				stroke: EDGE
			});
			const corners = [
				{ x: x0, y: y0 },
				{ x: x1, y: y0 },
				{ x: x1, y: y1 },
				{ x: x0, y: y1 }
			];

			const isStair = surface.kind === 'stair' && high - low > 1;
			if (isStair) {
				/*
				 * Treads along the run, each as its own small slab plus a riser: a flight
				 * reads as a staircase from either side, and the 0.3 m tread depth it is
				 * drawn with is the same one the panel reports. The model keeps its
				 * continuous height field — a step function through the sample grid would
				 * make coverage jump at every tread edge.
				 */
				const steps = stepCount(surface);
				const across = horizontal
					? [
							{ x: x0, y: y0 },
							{ x: x0, y: y1 }
						]
					: [
							{ x: x0, y: y0 },
							{ x: x1, y: y0 }
						];
				const at = (t: number, side: { x: number; y: number }) =>
					horizontal
						? { x: x0 + (x1 - x0) * (forward ? t : 1 - t), y: side.y }
						: { x: side.x, y: y0 + (y1 - y0) * (forward ? t : 1 - t) };
				for (let i = 0; i < steps; i++) {
					const t0 = i / steps;
					const t1 = (i + 1) / steps;
					const topI = low + (high - low) * t1;
					const prevTop = i === 0 ? low : low + (high - low) * t0;
					const bottom = Math.max(0, topI - thickness);
					const a0 = at(t0, across[0]!);
					const a1 = at(t0, across[1]!);
					const b0 = at(t1, across[0]!);
					const b1 = at(t1, across[1]!);
					faces.push(
						quad(
							[
								{ ...a0, z: topI },
								{ ...b0, z: topI },
								{ ...b1, z: topI },
								{ ...a1, z: topI }
							],
							TOP_FILL,
							0.02 + t1
						)
					);
					// The riser at the low edge of this tread, from the tread below to it.
					faces.push(
						quad(
							[
								{ ...a0, z: prevTop },
								{ ...a1, z: prevTop },
								{ ...a1, z: topI },
								{ ...a0, z: topI }
							],
							SIDE_FILL,
							t0
						)
					);
					// Its two sides: the slab's own depth, from the tread down to its underside.
					faces.push(
						quad(
							[
								{ ...a0, z: bottom },
								{ ...b0, z: bottom },
								{ ...b0, z: topI },
								{ ...a0, z: topI }
							],
							SIDE_FILL,
							t0 + 0.01
						)
					);
					faces.push(
						quad(
							[
								{ ...b1, z: bottom },
								{ ...a1, z: bottom },
								{ ...a1, z: topI },
								{ ...b1, z: topI }
							],
							SIDE_FILL,
							t1 + 0.01
						)
					);
				}
				continue;
			}

			// A level deck or a ramp: one top, an underside `thickness` below it, and sides.
			const topPoints = corners.map((corner) => ({
				...corner,
				z: heightAt(corner.x, corner.y)
			}));
			faces.push(quad(topPoints, TOP_FILL, 0.02));
			const bottomOf = (p: { x: number; y: number; z: number }) => ({
				x: p.x,
				y: p.y,
				z: base !== null ? base : Math.max(0, p.z - thickness)
			});
			if (base !== null) {
				// A solid base is a plinth: its sides start at the floor.
				for (let i = 0; i < topPoints.length; i++) {
					const a = topPoints[i]!;
					const b = topPoints[(i + 1) % topPoints.length]!;
					faces.push(quad([bottomOf(a), bottomOf(b), b, a], SIDE_FILL, 0));
				}
			} else {
				for (let i = 0; i < topPoints.length; i++) {
					const a = topPoints[i]!;
					const b = topPoints[(i + 1) % topPoints.length]!;
					faces.push(quad([bottomOf(a), bottomOf(b), b, a], SIDE_FILL, 0));
				}
				// The underside, visible only from below — which at a normal pitch is not.
				faces.push(quad(topPoints.map(bottomOf).reverse(), SIDE_FILL, -0.01));
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
