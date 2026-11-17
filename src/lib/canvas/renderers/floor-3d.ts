/**
 * 单层楼的三维视图：墙体按真实高度拉伸并使用材质颜色，平面图与覆盖图贴在楼板上。
 * 投影沿用堆叠视图的相机（`stacked-floors.ts`），平行投影加偏航与俯仰，不做透视除法，
 * 因此楼层平面是平面图的仿射映射，可经一个 `ctx.transform` 复用现有的卡片渲染器。只读，编辑仍在单层视图。
 *
 * 换层时整层楼先退场、下一层再入场。两段动画都需要整层一起变透明度，而卡片绘制会为自己的
 * 底图与掩膜重设 `globalAlpha`，外层传不进去，因此动画帧先画到离屏画布再按 `alpha` 合成。
 */
import type { Layer, RenderContext } from '../types.js';
import type { Camera } from '../camera.js';
import {
	DEFAULT_STACK_CAMERA,
	projectPoint,
	type StackCamera
} from './stacked-floors.js';
import type { FloorCardCache, FloorCardSource } from './floor-card.js';
import { apMarkerColor } from './ap.js';
import { motionDuration } from '$lib/motion.js';
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

/**
 * 三维视图要画的楼层内容。
 *
 * 场景与视图状态分开：换层时相机、图层开关都不变，只有这一组内容整体替换。
 * `wupm` 随场景保存，使换层动画期间退场的那层仍按它自己的标定绘制。
 */
export interface FloorScene {
	source: FloorCardSource;
	/** 楼层的墙体线段：拉伸所用的几何数据。 */
	walls: VectorWall[];
	/** 柱子：墙垛或圆柱，按无长度的墙进行拉伸。 */
	columns: VectorColumn[];
	/** 抬升表面，按其板体本身绘制。 */
	surfaces: ElevatedSurface[];
	/** 层高，单位米：没有独立高度的墙体按此值拉伸。 */
	ceilingHeightM: number;
	/** 该楼层的标定，世界单位/米。 */
	wupm: number;
}

/** 换层动画的总时长，毫秒：前一半旧楼层退场，后一半新楼层入场。 */
export const FLOOR_SWAP_MS = 400;

/** 位移距离的上下限，屏幕像素：太小看不出方向，太大像在整页翻滚。 */
const SWAP_MIN_PX = 20;
const SWAP_MAX_PX = 80;

/**
 * 换层时楼层在屏幕上的位移距离，单位 CSS 像素。
 *
 * 取一层楼在这台相机下的投影高度：新楼层从楼上那一层的位置落下来，旧楼层落到楼下那一层的位置。
 * 极端缩放与接近俯视时按上下限收住，避免位移与画面不成比例。
 */
export function floorSwapDistancePx(
	ceilingHeightM: number,
	wupm: number,
	pitch: number,
	zoom: number
): number {
	const projected =
		Math.max(0.1, ceilingHeightM) * Math.max(0, wupm) * Math.sin(pitch) * Math.max(0.01, zoom);
	return Math.min(SWAP_MAX_PX, Math.max(SWAP_MIN_PX, projected));
}

/** 一条换层动画的参数。 */
export interface FloorSwapMotion {
	/** 旧楼层开始退场时的不透明度。连续换层时取它当时的实际值，避免回跳。 */
	fromAlpha: number;
	/** 旧楼层开始退场时的屏幕偏移，单位像素，同上。 */
	fromOffset: number;
	/** 新楼层相对旧楼层的位置：+1 在上（上楼），-1 在下（下楼）。 */
	direction: 1 | -1;
	/** 位移距离，屏幕像素。 */
	distance: number;
}

/** 动画在某一时刻画哪一层、用多少不透明度与偏移。 */
export interface FloorSwapFrame {
	phase: 'out' | 'in';
	alpha: number;
	offset: number;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** 旧楼层加速离开：起步慢，越淡走得越快。 */
const easeInQuad = (t: number): number => t * t;

/** 新楼层先缓起再减速落位：整段位移都发生在淡入过程里，看得见它从上方下来。 */
const easeInOutQuad = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/**
 * 某一时刻的换层画面。
 *
 * 前半段旧楼层向楼下（或楼上）淡出至消失，后半段新楼层从另一侧淡入到位。两段不重叠，
 * 任一帧只需要画一层楼。`offset` 为绘制时的竖直偏移，正值向下。
 *
 * 透明度在整段上线性变化，位移则各有缓动：淡出时加速离开，淡入时减速落位。
 */
export function floorSwapFrame(
	elapsedMs: number,
	motion: FloorSwapMotion,
	durationMs: number = FLOOR_SWAP_MS
): FloorSwapFrame {
	const half = Math.max(1, durationMs / 2);
	const elapsed = Math.max(0, elapsedMs);
	if (elapsed < half) {
		const t = clamp01(elapsed / half);
		const end = motion.direction * motion.distance;
		return {
			phase: 'out',
			alpha: motion.fromAlpha * (1 - t),
			offset: motion.fromOffset + (end - motion.fromOffset) * easeInQuad(t)
		};
	}
	const t = clamp01((elapsed - half) / half);
	const eased = easeInOutQuad(t);
	return {
		phase: 'in',
		alpha: t,
		/*
		 * 终点偏移为 `distance × (eased − 1) = 0`；末尾的 `+ 0` 把负方向时的 `-0`
		 * 归一成 `0`，使「终点一定在 0」可以按值比较。
		 */
		offset: motion.direction * motion.distance * (eased - 1) + 0
	};
}

export class Floor3DLayer implements Layer {
	id = 'floor3d';
	visible = false;
	camera: StackCamera = { ...DEFAULT_STACK_CAMERA, wupm: 32.8 };
	planOpacity = 0.85;
	showPlan = true;
	showWalls = true;
	showAPs = true;
	showHeatmap = true;
	/**
	 * 动画期间由视图请求下一帧。
	 * 引擎只在有脏标记时重绘，所以动画必须自己续上每一帧。
	 */
	onFrame: (() => void) | null = null;

	/** 当前楼层的场景，没有楼层时为 null。 */
	private scene: FloorScene | null = null;
	/** 正在播放的换层动画，没有时为 null。 */
	private swap:
		| (Omit<FloorSwapMotion, 'distance'> & {
				from: FloorScene;
				to: FloorScene;
				startedAt: number;
		  })
		| null = null;
	/** 上一帧画的是哪一层、用多少不透明度与偏移：连续换层时从这里接着走。 */
	private lastFrame: { id: string; alpha: number; offset: number } | null = null;
	/** 整层淡入淡出用的离屏画布，按需分配并随画布尺寸复用。 */
	private scratch: HTMLCanvasElement | null = null;

	constructor(private readonly cards: FloorCardCache) {}

	/** 是否正在播放换层动画：视图据此把取景推迟到旧楼层退出之后。 */
	get swapping(): boolean {
		return this.swap !== null;
	}

	/**
	 * 交出当前楼层要画的内容；`animate` 为真时从上一楼层动画过渡过去。
	 *
	 * 同一楼层的重复调用（图层开关、视角、墙体编辑）只更新内容，不打断正在播放的动画；
	 * 换到另一层但没有要求动画时立即切换。返回值表示是否真的开始了一段动画。
	 */
	setFloor(scene: FloorScene | null, options: { animate?: boolean } = {}): boolean {
		const previous = this.scene;
		const running = this.swap;
		if (!scene) {
			this.scene = null;
			this.swap = null;
			return false;
		}
		if (previous && previous.source.id === scene.source.id) {
			this.scene = scene;
			if (running && running.to.source.id === scene.source.id) running.to = scene;
			return false;
		}
		this.scene = scene;
		this.swap = null;
		if (!options.animate || !previous || !this.visible) return false;
		// 系统要求减少动态效果时直接切换，不播动画。
		if (motionDuration(FLOOR_SWAP_MS) <= 0) return false;

		/*
		 * 连续按箭头时从画面上还看得见的那层接着走：否则正在淡出的楼层会突然跳回不透明。
		 * 目标正是这一层时（例如退场途中又切回原楼层）没有可播的过渡，直接停在它上面。
		 */
		let from = previous;
		let fromAlpha = 1;
		let fromOffset = 0;
		if (running) {
			// 还没有画过一帧时，屏幕上仍是退场的那层。
			const visible = this.lastFrame
				? this.lastFrame.id === running.from.source.id
					? running.from
					: running.to
				: running.from;
			if (visible.source.id === scene.source.id) return false;
			from = visible;
			if (this.lastFrame && this.lastFrame.id === visible.source.id) {
				fromAlpha = this.lastFrame.alpha;
				fromOffset = this.lastFrame.offset;
			}
		}
		this.swap = {
			from,
			to: scene,
			startedAt: performance.now(),
			fromAlpha,
			fromOffset,
			// 新楼层相对旧楼层在上还是在下：+1 向下走（上楼），-1 向上走（下楼）。
			direction: scene.source.elevation >= from.source.elevation ? 1 : -1
		};
		this.onFrame?.();
		return true;
	}

	/** 该楼层场景占据的包围盒，使用世界坐标。 */
	private contentBox(scene: FloorScene): { x: number; y: number; w: number; h: number } {
		// 三维相机使用该楼层自己的单位，因此卡片缩放的参考比例就是它自己的标定。
		const box = this.cards.contentBox(scene.source, scene.wupm);
		return { x: box.minX, y: box.minY, w: box.w, h: box.h };
	}

	/** 楼层的中心，使旋转视图时绕该楼层转动。 */
	private pivot(scene: FloorScene): { x: number; y: number; z: number } {
		const box = this.contentBox(scene);
		return { x: box.x + box.w / 2, y: box.y + box.h / 2, z: 0 };
	}

	/** 动画此刻画的是哪一层：前半段是退场的旧楼层，之后是新楼层。 */
	private visibleScene(): FloorScene | null {
		const swap = this.swap;
		if (!swap || !this.scene) return this.scene;
		const elapsed = performance.now() - swap.startedAt;
		return elapsed < FLOOR_SWAP_MS / 2 ? swap.from : this.scene;
	}

	/**
	 * 当前画面上那层楼的包围盒投影角点，用于取景。
	 *
	 * 换层动画期间只取可见的那层：旧楼层退场时取景不变，等新楼层开始入场才换成它的取景，
	 * 缩放变化因此发生在一张空画面上，看不见。
	 */
	contentBounds(): Array<{ x: number; y: number }> {
		const scene = this.visibleScene();
		if (!scene) return [];
		const box = this.contentBox(scene);
		const pivot = this.pivot(scene);
		const ceiling = Math.max(0.1, scene.ceilingHeightM) * scene.wupm;
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
		const scene = this.scene;
		if (!scene) return;
		const swap = this.swap;
		if (!swap) {
			this.paint(rc, scene, 1, 0);
			return;
		}
		const elapsed = performance.now() - swap.startedAt;
		if (elapsed >= FLOOR_SWAP_MS) {
			this.swap = null;
			this.paint(rc, scene, 1, 0);
			return;
		}
		const zoom = rc.camera.state.zoom || 1;
		const frame = floorSwapFrame(elapsed, {
			fromAlpha: swap.fromAlpha,
			fromOffset: swap.fromOffset,
			direction: swap.direction,
			distance: floorSwapDistancePx(scene.ceilingHeightM, scene.wupm, this.camera.pitch, zoom)
		});
		this.paint(rc, frame.phase === 'out' ? swap.from : scene, frame.alpha, frame.offset);
		// 引擎只在有脏标记时画下一帧，动画因此要自己续帧。
		this.onFrame?.();
	}

	/**
	 * 画一层楼，可以整层淡出或上下平移。
	 *
	 * 需要淡出或位移时先画到离屏画布再合成：卡片绘制会为自己的底图与掩膜重设
	 * `globalAlpha`，外层的整层透明度传不进去。
	 */
	private paint(rc: RenderContext, scene: FloorScene, alpha: number, offset: number): void {
		this.lastFrame = { id: scene.source.id, alpha, offset };
		if (alpha <= 0) return;
		if (alpha >= 1 && offset === 0) {
			this.drawScene(rc.ctx, rc.camera, scene);
			return;
		}
		const { width, height, dpr } = rc;
		const canvas = this.offscreen(width, height, dpr);
		const scratchCtx = canvas.getContext('2d')!;
		scratchCtx.setTransform(1, 0, 0, 1, 0, 0);
		scratchCtx.clearRect(0, 0, canvas.width, canvas.height);
		scratchCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.drawScene(scratchCtx, rc.camera, scene);

		const ctx = rc.ctx;
		ctx.save();
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.globalAlpha = Math.min(1, alpha);
		ctx.drawImage(canvas, 0, offset, width, height);
		ctx.restore();
	}

	/** 整层淡入淡出用的离屏画布，按画布的 CSS 尺寸与 DPR 分配一次后复用。 */
	private offscreen(width: number, height: number, dpr: number): HTMLCanvasElement {
		const pixelWidth = Math.max(1, Math.round(width * dpr));
		const pixelHeight = Math.max(1, Math.round(height * dpr));
		if (!this.scratch) this.scratch = document.createElement('canvas');
		if (this.scratch.width !== pixelWidth || this.scratch.height !== pixelHeight) {
			this.scratch.width = pixelWidth;
			this.scratch.height = pixelHeight;
		}
		return this.scratch;
	}

	/** 把一层楼画到给定上下文：墙体拉伸、楼板、已抬升的台面与接入点。 */
	private drawScene(ctx: CanvasRenderingContext2D, camera: Camera, scene: FloorScene): void {
		const src = scene.source;
		const box = this.contentBox(scene);
		const zoom = camera.state.zoom || 1;
		// 墙体高度与 AP 安装高度按该楼层自己的标定换算；偏航与俯仰来自本视图的相机。
		const view: StackCamera = { ...this.camera, wupm: scene.wupm };
		const pivot = this.pivot(scene);
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
			showWalls: this.showWalls && scene.walls.length === 0,
			// 标记在下方于绘制平面中绘制：安装高度无法在楼层自身的变换中表达。
			showAPs: false,
			showHeatmap: this.showHeatmap,
			planOpacity: this.planOpacity,
			zoom,
			wupm: scene.wupm
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
		if (this.showWalls) {
			faces.push(...this.wallFaces(view, pivot, scene), ...this.columnFaces(view, pivot, scene));
		}
		faces.push(...this.surfaceFaces(view, pivot, scene));
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
		pivot: { x: number; y: number; z: number },
		scene: FloorScene
	): Face[] {
		const faces: Face[] = [];
		const top = Math.max(0.1, scene.ceilingHeightM) * view.wupm;
		const cosYaw = Math.cos(view.yaw);
		const sinYaw = Math.sin(view.yaw);
		for (const column of scene.columns) {
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
		pivot: { x: number; y: number; z: number },
		scene: FloorScene
	): Face[] {
		const faces: Face[] = [];
		const cosYaw = Math.cos(view.yaw);
		const sinYaw = Math.sin(view.yaw);
		for (const wall of scene.walls) {
			const dx = wall.bx - wall.ax;
			const dy = wall.by - wall.ay;
			const length = Math.hypot(dx, dy);
			if (length < 1) continue;
			const heightM = wall.heightM ?? scene.ceilingHeightM;
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
		pivot: { x: number; y: number; z: number },
		scene: FloorScene
	): Face[] {
		const faces: Face[] = [];

		for (const surface of scene.surfaces) {
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
