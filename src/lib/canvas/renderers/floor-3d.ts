/**
 * 单层楼的三维视图：墙体按真实高度拉伸并使用材质颜色，平面图与覆盖图贴在楼板上。
 * 投影沿用堆叠视图的相机（`stacked-floors.ts`），平行投影加偏航与俯仰，不做透视除法，
 * 因此楼层平面是平面图的仿射映射，可经一个 `ctx.transform` 复用现有的卡片渲染器。只读，编辑仍在单层视图。
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

/** 一个待填充的四边形，已投影到绘制平面。 */
interface Face {
	points: Array<{ x: number; y: number }>;
	/** 屏幕空间深度：值越大越靠近观察者，因此最后绘制。 */
	depth: number;
	fill: string;
	stroke: string | null;
}

/**
 * 墙体在平面图上占据的带宽，单位是世界坐标单位。
 *
 * 与 `wall-raster.ts` 绘制及矢量图层描边使用同一数值，使三维拉伸与平面图对墙厚的理解一致。
 */
const WALL_BAND_WU = 6;

export class Floor3DLayer implements Layer {
	id = 'floor3d';
	visible = false;
	camera: StackCamera = { ...DEFAULT_STACK_CAMERA, wupm: 32.8 };
	source: FloorCardSource | null = null;
	/** 楼层的墙体线段：拉伸所用的几何数据。 */
	walls: VectorWall[] = [];
	/** 柱子：墙垛或圆柱，按无长度的墙进行拉伸。 */
	columns: VectorColumn[] = [];
	/** 抬升表面，按其板体本身绘制。 */
	surfaces: ElevatedSurface[] = [];
	/** 层高，单位米：没有独立高度的墙体按此值拉伸。 */
	ceilingHeightM = 3;
	planOpacity = 0.85;
	showPlan = true;
	showWalls = true;
	showAPs = true;
	showHeatmap = true;

	constructor(private readonly cards: FloorCardCache) {}

	/** 该楼层占据的包围盒，使用世界坐标。 */
	private contentBox(): { x: number; y: number; w: number; h: number } | null {
		if (!this.source) return null;
		// 三维相机使用本楼层的单位，因此卡片缩放为 1。
		const box = this.cards.contentBox(this.source, this.camera.wupm);
		return { x: box.minX, y: box.minY, w: box.w, h: box.h };
	}

	/** 楼层的中心，使旋转视图时绕该楼层转动。 */
	private pivot(): { x: number; y: number; z: number } {
		const box = this.contentBox();
		if (!box) return { x: 0, y: 0, z: 0 };
		return { x: box.x + box.w / 2, y: box.y + box.h / 2, z: 0 };
	}

	/** 楼层包围盒在楼板与天花板两处的投影角点。 */
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

		/** 楼板在绘制平面上的轮廓，填充与标签共用。 */
		const slab = [
			projectPoint(view, box.x, box.y, 0, pivot),
			projectPoint(view, box.x + box.w, box.y, 0, pivot),
			projectPoint(view, box.x + box.w, box.y + box.h, 0, pivot),
			projectPoint(view, box.x, box.y + box.h, 0, pivot)
		];

		/*
		 * 楼板本身，先于其上的一切绘制。没有平面图也没有覆盖图的楼层在平面内无可绘制，
		 * 而悬空的墙会像漂浮物而不是房间，因此这一层需要自身的表面。
		 */
		ctx.globalAlpha = 1;
		ctx.fillStyle = 'rgba(38,42,54,0.55)';
		ctx.beginPath();
		ctx.moveTo(slab[0]!.x, slab[0]!.y);
		for (let i = 1; i < slab.length; i++) ctx.lineTo(slab[i]!.x, slab[i]!.y);
		ctx.closePath();
		ctx.fill();

		/*
		 * 楼板：平面图、覆盖图与房间标签，经楼层自身的仿射变换绘制。
		 *
		 * 整个平面只用一个变换，因此可复用单层渲染器；墙体在下方以拉伸形式绘制，无线段时才用栅格。
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
			// 有墙的楼层使用拉伸；没有线段的楼层回退到栅格。
			showWalls: this.showWalls && this.walls.length === 0,
			// 标记在下方于绘制平面中绘制：安装高度无法在楼层自身的变换中表达。
			showAPs: false,
			showHeatmap: this.showHeatmap,
			planOpacity: this.planOpacity,
			zoom,
			wupm: this.camera.wupm
		});
		ctx.restore();

		// 楼板自身的轮廓绘制在绘制平面中，使任意偏航下都保持清晰。
		ctx.globalAlpha = 1;
		ctx.strokeStyle = 'rgba(255,255,255,0.28)';
		ctx.lineWidth = 1 / zoom;
		ctx.beginPath();
		ctx.moveTo(slab[0]!.x, slab[0]!.y);
		for (let i = 1; i < slab.length; i++) ctx.lineTo(slab[i]!.x, slab[i]!.y);
		ctx.closePath();
		ctx.stroke();

		// 所有竖直物体合并为一个列表并按从后到前绘制：夹层之后的墙必须位于其后，与绘制先后无关。
		const faces: Face[] = [];
		if (this.showWalls) faces.push(...this.wallFaces(view, pivot), ...this.columnFaces(view, pivot));
		faces.push(...this.surfaceFaces(view, pivot));
		faces.sort((l, r) => l.depth - r.depth);
		for (const face of faces) this.fillFace(ctx, face, zoom);

		if (this.showAPs) this.drawAccessPoints(ctx, src, view, pivot, zoom);

		// 楼层名称绘制在楼板最靠上的角，使读者无需侧栏也知道看的是什么。
		ctx.font = `${13 / zoom}px sans-serif`;
		ctx.textBaseline = 'bottom';
		ctx.fillStyle = 'rgba(255,255,255,0.78)';
		const anchor = slab.reduce((best, p) => (p.y < best.y ? p : best), slab[0]!);
		ctx.fillText(src.name, anchor.x, anchor.y - 8 / zoom);

		ctx.restore();
	}

	/**
	 * 柱子按其棱柱绘制：矩形为盒体，圆形为八边形。
	 *
	 * 柱子是没有长度的墙，因此按相同高度拉伸并以相同方式绘制，模型也这样处理（掩码中的填充轮廓）。
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
				// 只绘制背面：棱柱是闭合的，一半侧面背向观察者。
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
			// 顶盖：缺少它棱柱顶部开口，会看起来像一根管。
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
	 * 每面墙作为从楼板到墙顶的四边形，使用其材质的颜色。
	 * 明暗取决于墙与视线的夹角：正对观察者的墙保留原色，侧对观察者的墙变暗，使转角可辨。
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
			// 墙体在楼层平面内的法线，与观察方向比较用于判断朝向。
			const nx = -dy / length;
			const ny = dx / length;
			const facing = Math.abs(nx * sinYaw + ny * cosYaw);
			/*
			 * 所有墙统一色调，不按朝向分别着色：逐墙着色会让转角相接的两面墙在接缝处颜色不同，
			 * 使接缝和墙一样显眼；统一色调后重叠不可见，转角由顶面较亮的边缘体现。
			 */
			const shade = facing >= 0 ? 0.82 : 0.82;
			const [r, g, b] = material.color;
			const midX = (wall.ax + wall.bx) / 2 - pivot.x;
			const midY = (wall.ay + wall.by) / 2 - pivot.y;
			const depth = sinYaw * midX + cosYaw * midY;
			/*
			 * 每面墙只绘制一个可见面加顶面，而不是五面的盒体。
			 *
			 * 剔除背向观察者的面并以单一色调无描边填充，相邻墙在相接处同色，剩余边缘即真实轮廓。
			 */
			const half = WALL_BAND_WU / 2;
			/*
			 * 每面墙两端各延伸半个带宽。
			 *
			 * 以线段为中心的盒体在转角处相交会留下背景缺口；两端延伸使它们重叠，重叠处因同色而不可见。
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
				// 不描边：填充即轮廓，描边正是产生接缝的原因。
				stroke: null
			});
			// 只绘制顶面并描边，使墙从上方看是实心的，且只在转角处出现边缘。
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
	 * 抬升表面按其实体绘制：带厚度的平台、顶面倾斜的坡道、由踏步组成的楼梯。
	 * 厚度是“彩色矩形”与“夹层”的区别；踏步按面板报告的 0.3 m 深度绘制，模型保留连续等价表示。
	 */
	private surfaceFaces(
		view: StackCamera,
		pivot: { x: number; y: number; z: number }
	): Face[] {
		const faces: Face[] = [];

		for (const surface of this.surfaces) {
			/*
			 * 平台自身的颜色：钢制夹层与木质回廊是不同的障碍物，颜色因此不同。
			 * 顶面用材质半强度，侧面稍暗，边缘稍亮，使板体在斜视图中显得实心且不丢失色相。
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
				 * 沿坡向逐级绘制踏步，每级是小板体加一个踢面，使梯段从两侧看都是楼梯；
				 * 绘制用的 0.3 m 踏步深度与面板报告一致，而模型保留连续高度场。
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
					// 该踏步低边缘的踢面，从下方踏步延伸到该踏步。
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
					// 两侧面：板体自身的厚度，从踏面延伸到其底面。
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

			// 水平平台或坡道：一个顶面、其下 `thickness` 处的底面以及若干侧面。
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
				// 实心底座即基座：其侧面从地面开始。
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
				// 底面只在从下方观察时可见，常规俯仰下看不到。
				faces.push(quad(topPoints.map(bottomOf).reverse(), SIDE_FILL, -0.01));
			}
		}
		return faces;
	}

	/**
	 * 接入点，位于其安装高度，并有一段竖线连到地面。
	 *
	 * 这是本视图在标记上新增的信息：桌上的 AP 与天花板上的 AP 在平面图上是同一个点，在房间里却相距两米。
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
