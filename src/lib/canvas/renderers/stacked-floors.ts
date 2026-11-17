import type { Layer, RenderContext } from '../types.js';
import { ACCENT_STROKE, ACCENT_TEXT } from '../accents.js';
import { apMarkerColor } from './ap.js';
import type { FloorCardCache} from './floor-card.js';
import { type FloorCardSource } from './floor-card.js';

/**
 * 堆叠视图使用的平行投影相机：绕垂直轴偏航、向下俯仰看楼层，不做透视除法。
 * 仿射投影使每层平面只需一个 `ctx.transform`，层间的屏幕间距为 `z·sin(pitch)`；
 * 没有透视与墙体高度，原因见 `docs/ROADMAP.md` A3。
 */
export interface StackCamera {
	/** 绕垂直轴的旋转，单位弧度。为 0 时按平面图原样观察。 */
	yaw: number;
	/** 向下俯视楼层的角度，单位弧度。0 为垂直向下，π/2 为水平。 */
	pitch: number;
	/**
	 * 层间距的倍数。
	 * 仅影响屏幕显示：RF 模型读取 `floorElevation`，因此拉开堆叠不会改变规划报告的任何数值。
	 */
	spacing: number;
	/** 每米对应的世界坐标单位数，用于把标高换算成世界坐标高度。 */
	wupm: number;
}

/** 超过此值的俯仰已接近水平，楼层会退化成一条线而无法辨认。 */
export const MAX_PITCH = (78 * Math.PI) / 180;

export const DEFAULT_STACK_CAMERA: StackCamera = {
	yaw: 0,
	pitch: (40 * Math.PI) / 180,
	spacing: 1,
	wupm: 1
};

/** 判定命中时板面外仍视为命中的容差，单位是世界坐标单位。 */
const HIT_PAD = 10;

/** 一层楼在堆叠中的位置，单位是世界坐标单位。 */
export interface StackedSlab {
	id: string;
	name: string;
	/** 该层内容在其自身楼层平面上的世界坐标包围盒。 */
	boxX: number;
	boxY: number;
	boxW: number;
	boxH: number;
	/**
	 * 该层行走面的高度，单位是世界坐标单位：标高（米）乘以 `wupm` 与 `spacing`。
	 * 这是平面投影时使用的 z 值。
	 */
	z: number;
	/**
	 * 该层墙体向自身平面以下延伸的深度，单位是世界坐标单位，即它所在的层高。
	 * 最底层没有下方楼层，取值为 0。
	 */
	depth: number;
	/** 绘制该层内容时使用的透明度。 */
	alpha: number;
	/** 单层视图当前显示的楼层为 true。 */
	isCurrent: boolean;
	/** 指针位于该板面上时为 true。 */
	isHovered: boolean;
	/** 该层相对最低层的高度，单位米，用于标签显示。 */
	elevation: number;
}

export interface StackLayoutOptions extends StackCamera {
	currentFloorId: string | null;
	/**
	 * 仅绘制当前楼层及其相邻楼层。
	 * 过滤在布局阶段完成，因此缩放适配与命中测试也只看到缩减后的堆叠：未被绘制的板面不可点击。
	 */
	focus: boolean;
	/** 因指针悬停而高亮的楼层 id，没有时为 null。 */
	hoverFloorId: string | null;
}

/** 堆叠图层绘制平面上的一个点，坐标已投影。 */
export interface PlanePoint {
	x: number;
	y: number;
}

/**
 * 把楼层平面上的点投影到绘制平面：相对 `pivot` 平移后做偏航与俯仰，`Y` 向下增长，俯仰为 0 时各层重合。
 * dx = x − pivot.x, dy = y − pivot.y, dz = z − pivot.z
 * x1 = dx·cos(yaw) − dy·sin(yaw), y1 = dx·sin(yaw) + dy·cos(yaw)；X = x1, Y = y1·cos(pitch) − dz·sin(pitch)
 */
export function projectPoint(
	camera: Pick<StackCamera, 'yaw' | 'pitch'>,
	x: number,
	y: number,
	z: number,
	pivot: { x: number; y: number; z: number } = ORIGIN_PIVOT
): PlanePoint {
	const dx = x - pivot.x;
	const dy = y - pivot.y;
	const dz = z - pivot.z;
	const cosYaw = Math.cos(camera.yaw);
	const sinYaw = Math.sin(camera.yaw);
	const cosPitch = Math.cos(camera.pitch);
	const sinPitch = Math.sin(camera.pitch);
	return {
		x: cosYaw * dx - sinYaw * dy,
		y: (sinYaw * dx + cosYaw * dy) * cosPitch - dz * sinPitch
	};
}

const ORIGIN_PIVOT = { x: 0, y: 0, z: 0 };

/**
 * `projectPoint` 在单层平面上的逆变换：求绘制平面上的点来自该层哪个位置。
 * 俯仰以除以 `cos(pitch)` 的形式出现，因此接近水平的相机无法求逆，这也是 `MAX_PITCH` 小于 π/2 的原因。
 */
export function unprojectPoint(
	camera: Pick<StackCamera, 'yaw' | 'pitch'>,
	X: number,
	Y: number,
	z: number,
	pivot: { x: number; y: number; z: number } = ORIGIN_PIVOT
): PlanePoint {
	const cosPitch = Math.cos(camera.pitch);
	const cosYaw = Math.cos(camera.yaw);
	const sinYaw = Math.sin(camera.yaw);
	const dz = z - pivot.z;
	const y1 = cosPitch === 0 ? 0 : (Y + dz * Math.sin(camera.pitch)) / cosPitch;
	// 偏航旋转的逆即其转置矩阵，最后再把 pivot 的偏移加回去。
	return {
		x: cosYaw * X + sinYaw * y1 + pivot.x,
		y: -sinYaw * X + cosYaw * y1 + pivot.y
	};
}

/** 楼层内容包围盒的四个角，按该层高度投影后的坐标。 */
export function projectBox(
	camera: Pick<StackCamera, 'yaw' | 'pitch'>,
	box: { x: number; y: number; w: number; h: number },
	z: number,
	pivot: { x: number; y: number; z: number } = ORIGIN_PIVOT
): [PlanePoint, PlanePoint, PlanePoint, PlanePoint] {
	return [
		projectPoint(camera, box.x, box.y, z, pivot),
		projectPoint(camera, box.x + box.w, box.y, z, pivot),
		projectPoint(camera, box.x + box.w, box.y + box.h, z, pivot),
		projectPoint(camera, box.x, box.y + box.h, z, pivot)
	];
}

/** 各楼层在堆叠中的位置，按从下到上排序，该顺序也是绘制顺序。 */
export function stackedLayout(
	sources: FloorCardSource[],
	boxes: Map<string, { minX: number; minY: number; w: number; h: number }>,
	opts: StackLayoutOptions
): StackedSlab[] {
	// 按标高排序而非按数组顺序：本视图的核心主张是楼层位于建筑给定的高度，
	// 而 `floorElevation` 是唯一依据。
	const ordered = [...sources].sort((a, b) => a.elevation - b.elevation);
	const visible = opts.focus ? isolateCurrent(ordered, opts.currentFloorId) : ordered;
	return visible.map((s, i) => {
		const box = boxes.get(s.id) ?? { minX: 0, minY: 0, w: 0, h: 0 };
		const z = storeyHeight(s.elevation, opts.wupm, opts.spacing);
		// 下方楼层取自完整堆叠而非聚焦后的子集：隐藏中间某一层不应悄悄改变
		// 该层被绘制的高度。
		const below = storeyBelow(ordered, s.id);
		const belowZ = storeyHeight(below?.elevation ?? 0, opts.wupm, opts.spacing);
		const isCurrent = s.id === opts.currentFloorId;
		return {
			id: s.id,
			name: s.name,
			boxX: box.minX,
			boxY: box.minY,
			boxW: box.w,
			boxH: box.h,
			z,
			depth: below ? Math.max(0, z - belowZ) : 0,
			alpha: i === 0 ? 1 : isCurrent ? 0.9 : 0.6,
			isCurrent,
			isHovered: s.id === opts.hoverFloorId,
			elevation: s.elevation
		};
	});
}

/**
 * 楼层平面的高度，单位是世界坐标单位：`elevation` 已累计，`spacing` 只缩放视觉分离。
 */
export function storeyHeight(elevation: number, wupm: number, spacing: number): number {
	return elevation * wupm * spacing;
}

/** 完整堆叠中紧邻该层下方的楼层，没有则为 null。 */
function storeyBelow(ordered: FloorCardSource[], id: string): FloorCardSource | null {
	const i = ordered.findIndex((s) => s.id === id);
	return i > 0 ? ordered[i - 1]! : null;
}

/**
 * 隔离显示：只保留当前楼层。
 *
 * 没有当前楼层（尚未选中）时保留全部，因为空视图会像缺陷而不像过滤。
 */
function isolateCurrent(
	ordered: FloorCardSource[],
	currentFloorId: string | null
): FloorCardSource[] {
	const current = ordered.filter((s) => s.id === currentFloorId);
	return current.length > 0 ? current : ordered;
}

/**
 * 堆叠的中心，单位是世界坐标单位：视图绕该点旋转，由板面计算得出，旋转与缩放都相对它施加。
 */
export function stackPivot(slabs: StackedSlab[]): { x: number; y: number; z: number } {
	if (slabs.length === 0) return { x: 0, y: 0, z: 0 };
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	let minZ = Infinity;
	let maxZ = -Infinity;
	for (const s of slabs) {
		minX = Math.min(minX, s.boxX);
		minY = Math.min(minY, s.boxY);
		maxX = Math.max(maxX, s.boxX + s.boxW);
		maxY = Math.max(maxY, s.boxY + s.boxH);
		minZ = Math.min(minZ, s.z);
		maxZ = Math.max(maxZ, s.z);
	}
	return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 };
}

/**
 * 堆叠在绘制平面上的范围，用于适配相机：按构造以 pivot 为中心，故适配结果对任意偏航都成立。
 */
export function stackedBounds(
	camera: Pick<StackCamera, 'yaw' | 'pitch'>,
	slabs: StackedSlab[]
): Array<{ x: number; y: number }> {
	if (slabs.length === 0) return [];
	const pivot = stackPivot(slabs);
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const s of slabs) {
		const box = { x: s.boxX, y: s.boxY, w: s.boxW, h: s.boxH };
		for (const p of projectBox(camera, box, s.z, pivot)) {
			if (p.x < minX) minX = p.x;
			if (p.y < minY) minY = p.y;
			if (p.x > maxX) maxX = p.x;
			if (p.y > maxY) maxY = p.y;
		}
	}
	return [
		{ x: minX, y: minY },
		{ x: maxX, y: maxY }
	];
}

/**
 * 包含该绘制平面点的最前方楼层 id，没有则为 null：从顶到底反投影并检查内容包围盒，墙体不计入。
 */
export function slabAt(
	camera: Pick<StackCamera, 'yaw' | 'pitch'>,
	slabs: StackedSlab[],
	planeX: number,
	planeY: number
): string | null {
	const pivot = stackPivot(slabs);
	for (let i = slabs.length - 1; i >= 0; i--) {
		const s = slabs[i]!;
		const p = unprojectPoint(camera, planeX, planeY, s.z, pivot);
		if (
			p.x >= s.boxX - HIT_PAD &&
			p.x <= s.boxX + s.boxW + HIT_PAD &&
			p.y >= s.boxY - HIT_PAD &&
			p.y <= s.boxY + s.boxH + HIT_PAD
		) {
			return s.id;
		}
	}
	return null;
}

/** 楼层墙体的一个面，已投影为四边形。 */
interface WallFace {
	points: PlanePoint[];
	/** 明暗系数，使盒体可见的两侧看起来是不同的面。 */
	shade: number;
}

/**
 * 楼层自身平面下方的四面墙，已投影为四边形，由调用方按从后到前填充；明暗让转角可见。
 */
function wallFaces(
	camera: Pick<StackCamera, 'yaw' | 'pitch'>,
	slab: StackedSlab,
	pivot: { x: number; y: number; z: number }
): WallFace[] {
	if (slab.depth <= 0) return [];
	const top = slab.z;
	const bottom = slab.z - slab.depth;
	const corners: Array<[number, number]> = [
		[slab.boxX, slab.boxY],
		[slab.boxX + slab.boxW, slab.boxY],
		[slab.boxX + slab.boxW, slab.boxY + slab.boxH],
		[slab.boxX, slab.boxY + slab.boxH]
	];
	const faces: WallFace[] = [];
	for (let i = 0; i < 4; i++) {
		const a = corners[i]!;
		const b = corners[(i + 1) % 4]!;
		faces.push({
			points: [
				projectPoint(camera, a[0], a[1], top, pivot),
				projectPoint(camera, b[0], b[1], top, pivot),
				projectPoint(camera, b[0], b[1], bottom, pivot),
				projectPoint(camera, a[0], a[1], bottom, pivot)
			],
			// 相对的墙使用同一明暗系数，使转角成为可见的棱边，两对墙面读作同一表面。
			shade: i % 2 === 0 ? 0.42 : 0.28
		});
	}
	return faces;
}

/**
 * 一次绘制所有楼层，按真实标高堆叠，并从可旋转的视点观察；只读，编辑需按各层自身原点进行。
 */
export class StackedFloorsLayer implements Layer {
	id = 'stacked-floors';
	visible = false;
	currentFloorId: string | null = null;
	showPlan = true;
	showWalls = true;
	showAPs = true;
	showHeatmap = false;
	planOpacity = 0.8;
	/** 视点，见 `StackCamera`。 */
	camera: StackCamera = { ...DEFAULT_STACK_CAMERA };
	/** 仅绘制当前楼层及其相邻楼层。 */
	focus = false;
	/** 指针悬停的楼层，绘制时高亮，由调用方设置。 */
	hoverFloorId: string | null = null;

	private sources: FloorCardSource[] = [];

	constructor(private readonly cards: FloorCardCache) {}

	/** 平面图加载完成后调用，以便引擎重绘。 */
	set onLoad(fn: (() => void) | null) {
		this.cards.onLoad = fn;
	}

	setFloors(
		sources: FloorCardSource[],
		currentFloorId: string | null,
		wupm: number
	): void {
		this.currentFloorId = currentFloorId;
		this.camera.wupm = wupm;
		this.cards.sync(sources);
		this.sources = sources;
	}

	/** 各板面的位置，按从下到上排序，该顺序也是绘制顺序。 */
	layout(): StackedSlab[] {
		if (this.sources.length === 0) return [];
		const boxes = new Map(
			this.sources.map((s) => [s.id, this.cards.contentBox(s, this.camera.wupm)])
		);
		return stackedLayout(this.sources, boxes, {
			...this.camera,
			currentFloorId: this.currentFloorId,
			focus: this.focus,
			hoverFloorId: this.hoverFloorId
		});
	}

	/**
	 * 绘制平面上的点落在哪一层，没有则为 null：反投影由本图层负责，上层无需知道视图可旋转。
	 */
	floorAt(planeX: number, planeY: number): string | null {
		return slabAt(this.camera, this.layout(), planeX, planeY);
	}

	/** 整个堆叠的边界，用于适配相机。 */
	contentBounds(): Array<{ x: number; y: number }> {
		return stackedBounds(this.camera, this.layout());
	}

	render(rc: RenderContext): void {
		if (!this.visible) return;
		const { ctx, camera } = rc;
		const slabs = this.layout();
		if (slabs.length === 0) return;

		const [a, b, c, d, e, f] = camera.getTransform();
		const zoom = camera.state.zoom || 1;
		const view = this.camera;
		// 所有内容都相对堆叠中心投影，因此旋转视图时堆叠留在原处，
		// 而不是在画布上横扫过去。
		const pivot = stackPivot(slabs);
		const cosYaw = Math.cos(view.yaw);
		const sinYaw = Math.sin(view.yaw);
		const cosPitch = Math.cos(view.pitch);
		const sinPitch = Math.sin(view.pitch);

		ctx.save();
		ctx.transform(a, b, c, d, e, f);

		/** 标记延后到所有楼层绘制完毕，以免被上层楼层遮挡。 */
		const markers: Array<{ src: FloorCardSource; slab: StackedSlab }> = [];

		for (const slab of slabs) {
			const src = this.sources.find((s) => s.id === slab.id);
			if (!src) continue;

			// 先绘制墙体，再在其上绘制该层平面，使楼层盖住它所在的层。
			for (const face of wallFaces(view, slab, pivot)) {
				ctx.globalAlpha = 1;
				ctx.fillStyle = `rgba(0,0,0,${face.shade})`;
				ctx.beginPath();
				ctx.moveTo(face.points[0]!.x, face.points[0]!.y);
				for (let i = 1; i < face.points.length; i++) {
					ctx.lineTo(face.points[i]!.x, face.points[i]!.y);
				}
				ctx.closePath();
				ctx.fill();
			}

			// 一层楼对应一次仿射变换：先移出 pivot，再偏航、俯仰，最后加上自身高度。
			// 通过该变换绘制内容，旋转的是平面而不是平移它，因此现有的各层绘制流程无需改动。
			// 平移项即 pivot 自身的投影，使 pivot 在任何偏航与俯仰下都保持在原点。
			const dz = slab.z - pivot.z;
			ctx.save();
			ctx.transform(
				cosYaw,
				sinYaw * cosPitch,
				-sinYaw,
				cosYaw * cosPitch,
				-cosYaw * pivot.x + sinYaw * pivot.y,
				-cosPitch * (sinYaw * pivot.x + cosYaw * pivot.y) - sinPitch * dz
			);
			// 裁剪范围是该层自身坐标下的包围盒，因此超出平面图生成的覆盖图不会溢出到下层。
			ctx.beginPath();
			ctx.rect(slab.boxX, slab.boxY, slab.boxW, slab.boxH);
			ctx.clip();
			ctx.globalAlpha = slab.alpha;
			this.cards.draw(ctx, src, {
				showPlan: this.showPlan,
				showWalls: this.showWalls,
				// 标记改为稍后在绘制平面上绘制：它们在本视图中的意义就是带有自身高度，
				// 而高度无法在单层自身的变换中表达。
				showAPs: false,
				showHeatmap: this.showHeatmap,
				planOpacity: this.planOpacity,
				zoom,
				wupm: this.camera.wupm
			});
			ctx.restore();

			// 轮廓与标签绘制在绘制平面上，即不随视图旋转，使任意偏航下文字都保持可读、
			// 边缘都保持清晰。
			const quad = projectBox(
				view,
				{ x: slab.boxX, y: slab.boxY, w: slab.boxW, h: slab.boxH },
				slab.z,
				pivot
			);
			ctx.globalAlpha = 1;
			ctx.strokeStyle = slab.isHovered
				? 'rgba(255,255,255,0.95)'
				: slab.isCurrent
					? ACCENT_STROKE
					: 'rgba(255,255,255,0.22)';
			ctx.lineWidth = (slab.isHovered ? 3 : slab.isCurrent ? 2 : 1) / zoom;
			ctx.beginPath();
			ctx.moveTo(quad[0]!.x, quad[0]!.y);
			for (let i = 1; i < quad.length; i++) ctx.lineTo(quad[i]!.x, quad[i]!.y);
			ctx.closePath();
			ctx.stroke();

			// 标签携带高度，这是堆叠能表达而接触表无法表达的信息：楼层所处的位置。
			ctx.font = `${13 / zoom}px sans-serif`;
			ctx.fillStyle = slab.isHovered
				? 'rgba(255,255,255,0.95)'
				: slab.isCurrent
					? ACCENT_TEXT
					: 'rgba(255,255,255,0.6)';
			ctx.textBaseline = 'bottom';
			// 锚定在屏幕上最靠上的那个角，避免标签绘制在它所标注的楼层内部。
			const anchor = quad.reduce((best, p) => (p.y < best.y ? p : best), quad[0]!);
			ctx.fillText(`${slab.name} · +${slab.elevation.toFixed(1)} m`, anchor.x, anchor.y - 6 / zoom);

			// 接入点在此处只收集而不绘制，见 `markers`。
			if (this.showAPs) markers.push({ src, slab });
		}

		// 所有楼层已绘制完毕，因此标记可以覆盖在所有楼层之上。
		for (const marker of markers) {
			this.drawAccessPoints(ctx, marker.src, marker.slab, view, pivot, zoom);
		}

		ctx.restore();
	}

	/**
	 * 该层的接入点，各自位于其安装高度：按 `slab.z + height` 投影并用竖线连到楼层。
	 * 高度按相机 `spacing` 缩放，全部标记最后绘制，因此不会被上层楼板遮挡。
	 */
	private drawAccessPoints(
		ctx: CanvasRenderingContext2D,
		src: FloorCardSource,
		slab: StackedSlab,
		view: StackCamera,
		pivot: { x: number; y: number; z: number },
		zoom: number
	): void {
		const dotR = 4 / zoom;
		// 标记绘制在图纸平面上，因此先把楼层自身的坐标换算过去，
		// 面板尺寸也按同一换算缩放。
		const k = src.wupm > 0 ? view.wupm / src.wupm : 1;
		for (const ap of src.aps) {
			const ax = ap.x * k;
			const ay = ap.y * k;
			const heightWu = (ap.mountHeightM ?? 0) * view.wupm * view.spacing;
			const onFloor = projectPoint(view, ax, ay, slab.z, pivot);
			const at = projectPoint(view, ax, ay, slab.z + heightWu, pivot);
			ctx.globalAlpha = 1;
			// 竖线：楼层一端较淡，标记一端为实心圆点，使线段表达出该点上方的高度。
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
			if (ap.mount === 'wall') {
				this.drawWallPlate(ctx, view, ap, ax, ay, slab.z + heightWu, pivot, dotR, zoom);
				continue;
			}
			ctx.beginPath();
			ctx.arc(at.x, at.y, dotR, 0, Math.PI * 2);
			ctx.fill();
			// 加一圈描边，使标记在浅色平面图上仍然可辨。
			ctx.strokeStyle = 'rgba(255,255,255,0.6)';
			ctx.lineWidth = 1 / zoom;
			ctx.stroke();
		}
	}

	/**
	 * 壁挂单元在此视图中的绘制：平面图的面板躺在楼层自身平面内，坐标轴参与投影，旋转时仍贴墙。
	 * 这里使用四边形；局部 +x 为朝向方向，面板在朝向上很薄、沿墙方向较长。
	 */
	private drawWallPlate(
		ctx: CanvasRenderingContext2D,
		view: StackCamera,
		ap: FloorCardSource['aps'][number],
		x: number,
		y: number,
		z: number,
		pivot: { x: number; y: number; z: number },
		dotR: number,
		zoom: number
	): void {
		const facing = ((ap.facingDeg ?? 0) * Math.PI) / 180;
		const fx = Math.cos(facing);
		const fy = Math.sin(facing);
		// 与 `ap.ts` 及总览视图相同的比例：横向 2×dotR，纵向 4.4×dotR。
		const HALF_ACROSS = dotR;
		const HALF_ALONG = dotR * 2.2;
		/** 面板的一个角，位于楼层平面内，已投影到绘制平面。 */
		const corner = (across: number, along: number) =>
			projectPoint(
				view,
				x + across * fx - along * fy,
				y + across * fy + along * fx,
				z,
				pivot
			);

		const corners = [
			corner(-HALF_ACROSS, -HALF_ALONG),
			corner(HALF_ACROSS, -HALF_ALONG),
			corner(HALF_ACROSS, HALF_ALONG),
			corner(-HALF_ACROSS, HALF_ALONG)
		];
		ctx.beginPath();
		ctx.moveTo(corners[0]!.x, corners[0]!.y);
		for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i]!.x, corners[i]!.y);
		ctx.closePath();
		ctx.fill();
		ctx.strokeStyle = 'rgba(255,255,255,0.6)';
		ctx.lineWidth = 1 / zoom;
		ctx.lineJoin = 'round';
		ctx.stroke();
	}
}
