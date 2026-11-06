import { describe, expect, it } from 'vitest';
import { FloorCardCache, type FloorCardSource } from './floor-card.js';
import type { RenderContext } from '../types.js';
import {
	DEFAULT_STACK_CAMERA,
	MAX_PITCH,
	projectBox,
	projectPoint,
	slabAt,
	stackPivot,
	stackedBounds,
	stackedLayout,
	StackedFloorsLayer,
	storeyHeight,
	unprojectPoint,
	type StackCamera
} from './stacked-floors.js';

/**
 * 堆叠视图由相机与几何运算组成，本文件同时覆盖两者。
 * 视图的主张都是几何性的：楼层按真实层高分开、平面图被旋转与倾斜而非横向平移，
 * 某点处最上层的板面就是绘制在其上的那层。
 */

const WUPM = 33.05;
const DEG = Math.PI / 180;

const camera = (over: Partial<StackCamera> = {}): StackCamera => ({
	...DEFAULT_STACK_CAMERA,
	wupm: WUPM,
	...over
});

/** 掩码均为 800 x 600、层高为 3 米的楼层数据。 */
function sources(count = 2): FloorCardSource[] {
	const floor = (id: string, name: string, elevation: number): FloorCardSource => ({
		id,
		name,
		planUrl: null,
		planOffsetX: 0,
		planOffsetY: 0,
		maskUrl: `mask-${id}.png`,
		materialUrl: null,
		defaultMaterial: 0,
		maskOriginX: 0,
		maskOriginY: 0,
		maskWidth: 800,
		maskHeight: 600,
		wupm: WUPM,
		aps: [],
		elevation
	});
	const all = [floor('f1', 'Floor 1', 0), floor('f2', 'Floor 2', 3), floor('f3', 'Floor 3', 6)];
	// 故意按错误顺序排列：布局会按标高排序，依赖数组顺序的视图会把建筑画反。
	return count === 2 ? [all[1]!, all[0]!] : [all[2]!, all[0]!, all[1]!];
}

function layout(
	currentFloorId: string | null,
	over: Partial<StackCamera> & { focus?: boolean; hoverFloorId?: string | null; count?: number } = {}
) {
	const cards = new FloorCardCache();
	const list = sources(over.count ?? 2);
	const boxes = new Map(list.map((s) => [s.id, cards.contentBox(s)]));
	return stackedLayout(list, boxes, {
		...camera(over),
		currentFloorId,
		focus: over.focus ?? false,
		hoverFloorId: over.hoverFloorId ?? null
	});
}

describe('storeyHeight', () => {
	it('is metres in world units, scaled by the spread', () => {
		expect(storeyHeight(3, 33.05, 1)).toBeCloseTo(99.15, 9);
		expect(storeyHeight(3, 33.05, 1.5)).toBeCloseTo(148.725, 9);
		// 底层没有下方支撑，因此自身高度为 0。
		expect(storeyHeight(0, 33.05, 1)).toBe(0);
	});
});

describe('projectPoint', () => {
	it('is the plan unchanged in an unrotated top view', () => {
		const top = camera({ yaw: 0, pitch: 0 });
		expect(projectPoint(top, 100, 200, 0)).toEqual({ x: 100, y: 200 });
		// 高度不参与：垂直向下看时各层重合，这正是堆叠平面图应有的样子。
		expect(projectPoint(top, 100, 200, 50)).toEqual({ x: 100, y: 200 });
	});

	it('rotates the plan with yaw, which is what a viewpoint does', () => {
		const turned = camera({ yaw: 90 * DEG, pitch: 0 });
		// 旋转四分之一圈把 +x 映射到 +y：转动的是平面本身，而不是横向平移。
		const p = projectPoint(turned, 100, 0, 0);
		expect(p.x).toBeCloseTo(0, 9);
		expect(p.y).toBeCloseTo(100, 9);
	});

	it('foreshortens y with pitch and lifts a floor by its height', () => {
		const tilted = camera({ yaw: 0, pitch: 60 * DEG });
		const flat = projectPoint(tilted, 0, 100, 0);
		// cos(60°) = 0.5：远离观察者的距离减半。
		expect(flat.x).toBeCloseTo(0, 9);
		expect(flat.y).toBeCloseTo(100 * Math.cos(60 * DEG), 9);
		// sin(60°) 决定高度在屏幕上带来的上移量。
		expect(projectPoint(tilted, 0, 0, 100).y).toBeCloseTo(-100 * Math.sin(60 * DEG), 9);
	});

	it('loses no information: unprojecting returns the point it came from', () => {
		for (const yaw of [0, 30 * DEG, 90 * DEG, -135 * DEG]) {
			for (const pitch of [10 * DEG, 40 * DEG, MAX_PITCH]) {
				const c = camera({ yaw, pitch });
				const z = 137.5;
				const p = projectPoint(c, 321.25, -47.5, z);
				const back = unprojectPoint(c, p.x, p.y, z);
				expect(back.x).toBeCloseTo(321.25, 6);
				expect(back.y).toBeCloseTo(-47.5, 6);
			}
		}
	});
});

describe('stackedLayout', () => {
	it('orders floors by elevation, not by array order', () => {
		expect(layout(null).map((s) => s.id)).toEqual(['f1', 'f2']);
	});

	it('separates the storeys by their real height', () => {
		const [ground, upper] = layout(null);
		expect(ground!.z).toBe(0);
		expect(upper!.z).toBeCloseTo(99.15, 6);
	});

	it('gives each upper floor walls down to the floor below it', () => {
		const [ground, upper] = layout(null);
		// 底层没有下方楼层：没有墙体，其命中区域就是自身包围盒。
		expect(ground!.depth).toBe(0);
		// 上层楼层对应一层的建筑高度。
		expect(upper!.depth).toBeCloseTo(99.15, 6);
	});

	it('spreads the storeys apart without changing the geometry it reports', () => {
		expect(layout(null, { spacing: 2 })[1]!.z).toBeCloseTo(198.3, 6);
	});

	it('draws the current floor nearly opaque and the others translucent', () => {
		// 平面图为全尺寸时，不透明的上层会遮住其下所有内容。
		expect(layout('f2')[1]!.alpha).toBeCloseTo(0.9, 6);
		expect(layout('f1')[1]!.alpha).toBeCloseTo(0.6, 6);
		// 底层上方没有遮挡，因此始终以不透明绘制。
		expect(layout('f2')[0]!.alpha).toBe(1);
		expect(layout('f2')[0]!.isCurrent).toBe(false);
		expect(layout('f2')[1]!.isCurrent).toBe(true);
	});

	it('reports each floor its own height, for the label', () => {
		expect(layout(null, { count: 3 }).map((s) => s.elevation)).toEqual([0, 3, 6]);
	});

	it('marks the floor the pointer is over', () => {
		const slabs = layout(null, { count: 3, hoverFloorId: 'f2' });
		expect(slabs.filter((s) => s.isHovered).map((s) => s.id)).toEqual(['f2']);
		expect(layout(null).every((s) => !s.isHovered)).toBe(true);
	});
});

describe('stackedLayout with focus', () => {
	it('keeps only the current floor', () => {
		// 与“当前楼层及其相邻楼层”的行为不同：两层平面图上过滤后只剩一层。
		expect(layout('f2', { count: 3, focus: true }).map((s) => s.id)).toEqual(['f2']);
		expect(layout('f3', { count: 3, focus: true }).map((s) => s.id)).toEqual(['f3']);
		expect(layout('f1', { count: 3, focus: true }).map((s) => s.id)).toEqual(['f1']);
		// 常见情形：只有两层，因此在这里也必须产生效果。
		expect(layout('f1', { focus: true }).map((s) => s.id)).toEqual(['f1']);
	});

	it('keeps every floor when nothing is selected', () => {
		// 空视图会像缺陷而不像过滤。
		expect(layout(null, { count: 3, focus: true })).toHaveLength(3);
	});

	it('still stands the isolated floor on the storey below it', () => {
		// 即使下方没有绘制任何楼层，其墙体仍有一层高：由整个建筑决定，而不是可见列表。
		const focused = layout('f3', { count: 3, focus: true });
		expect(focused).toHaveLength(1);
		expect(focused[0]!.depth).toBeCloseTo(99.15, 6);
		expect(focused[0]!.z).toBeCloseTo(198.3, 6);
	});
});

describe('stackedBounds', () => {
	it('is centred on the pivot, and at a top view it is the plan\'s own box', () => {
		// 绘制平面以 pivot 为原点，因此 800 x 600 的楼层平面范围是 -400 到 400、-300 到 300，
		// 与视点无关。
		const bounds = stackedBounds(camera({ yaw: 0, pitch: 0 }), layout(null));
		expect(bounds[0]!.x).toBeCloseTo(-400, 6);
		expect(bounds[0]!.y).toBeCloseTo(-300, 6);
		expect(bounds[1]!.x).toBeCloseTo(400, 6);
		expect(bounds[1]!.y).toBeCloseTo(300, 6);
	});

	it('grows with the tilt, symmetrically about the pivot', () => {
		const view = camera({ yaw: 0, pitch: 30 * DEG });
		const bounds = stackedBounds(view, layout(null));
		// 平面图在中心两侧各被压缩到 300·cos(30°)，楼层围绕中心抬升 ±(99.15/2)·sin(30°)。
		const reach = 300 * Math.cos(30 * DEG) + (99.15 / 2) * Math.sin(30 * DEG);
		expect(bounds[0]!.y).toBeCloseTo(-reach, 6);
		expect(bounds[1]!.y).toBeCloseTo(reach, 6);
	});

	it('a yawed plan needs a wider box than the plan itself', () => {
		// 45° 下的矩形，其包围盒宽度等于两边之和乘以 cos(45°)，这是视图旋转而非平移的直接证据：
		// 横向平移楼层永远不会改变这一点。
		const straight = stackedBounds(camera({ yaw: 0, pitch: 0 }), layout(null));
		const turned = stackedBounds(camera({ yaw: 45 * DEG, pitch: 0 }), layout(null));
		const width = (b: Array<{ x: number; y: number }>) => b[1]!.x - b[0]!.x;
		expect(width(turned)).toBeCloseTo((800 + 600) * Math.cos(45 * DEG), 6);
		expect(width(turned)).toBeGreaterThan(width(straight) * 1.2);
	});

	it('is empty with no floors, so the camera fit falls through', () => {
		expect(stackedBounds(camera(), [])).toEqual([]);
	});
});

describe('slabAt', () => {
	const view = camera({ yaw: 0, pitch: 40 * DEG });

	it('picks the floor drawn over a point of the tilted view', () => {
		const slabs = layout(null);
		const ground = slabs[0]!;
		const upper = slabs[1]!;

		// 上层自身平面图的中部属于上层：它最后绘制，因此用户在那里看到的就是它。
		const upperCentre = projectPoint(view, 400, 300, upper.z, stackPivot(slabs));
		expect(slabAt(view, slabs, upperCentre.x, upperCentre.y)).toBe('f2');

		// 在地面平面图的很远处，上层的平面图已经结束：反投影到上层平面会落在其远端之外，
		// 因此该处属于地面楼层。
		const groundEdge = projectPoint(view, 400, 580, ground.z, stackPivot(slabs));
		expect(slabAt(view, slabs, groundEdge.x, groundEdge.y)).toBe('f1');
	});

	it('picks the top floor in a top view, where the storeys coincide', () => {
		// 垂直向下看时屏幕上只有一个平面图，即最后绘制的那层，下方楼层都在其后面。
		const top = camera({ yaw: 0, pitch: 0 });
		expect(slabAt(top, layout(null), 0, 0)).toBe('f2');
	});

	it('still picks the right floor when the view is rotated and tilted', () => {
		const turned = camera({ yaw: -40 * DEG, pitch: 35 * DEG });
		const slabs = layout(null);
		const upper = slabs[1]!;
		const p = projectPoint(turned, 400, 300, upper.z, stackPivot(slabs));
		expect(slabAt(turned, slabs, p.x, p.y)).toBe('f2');
	});

	it('ignores a point outside every slab', () => {
		const slabs = layout(null);
		expect(slabAt(view, slabs, -5000, -5000)).toBeNull();
		expect(slabAt(view, slabs, 5000, 5000)).toBeNull();
	});

	it('has no floors to pick from when there are none', () => {
		expect(slabAt(camera(), [], 0, 0)).toBeNull();
	});

	it('narrows with focus, so a floor that is not drawn is not clickable', () => {
		// 地面平面图同一远端边缘：绘制地面楼层时命中它，隔离其他楼层后则什么都不命中。
		const sprawling = layout('f2', { count: 3 });
		const focused = layout('f2', { count: 3, focus: true });
		const point = projectPoint(view, 400, 580, 0, stackPivot(sprawling));
		expect(slabAt(view, sprawling, point.x, point.y)).toBe('f1');
		const focusedPoint = projectPoint(view, 400, 580, 0, stackPivot(focused));
		expect(slabAt(view, focused, focusedPoint.x, focusedPoint.y)).toBeNull();
	});
});

describe('the pivot', () => {
	it('is the middle of the stack, in all three axes', () => {
		const pivot = stackPivot(layout(null));
		expect(pivot.x).toBeCloseTo(400, 6);
		expect(pivot.y).toBeCloseTo(300, 6);
		// 两层相距 3 米：中心位于一层高的位置。
		expect(pivot.z).toBeCloseTo(99.15 / 2, 6);
	});

	it('stays at the origin for every viewpoint, which is what needs no re-fit', () => {
		const slabs = layout(null);
		const pivot = stackPivot(slabs);
		for (const yaw of [0, 30 * DEG, 90 * DEG, -150 * DEG]) {
			for (const pitch of [5 * DEG, 40 * DEG, MAX_PITCH]) {
				const p = projectPoint(camera({ yaw, pitch }), pivot.x, pivot.y, pivot.z, pivot);
				expect(p.x).toBeCloseTo(0, 9);
				expect(p.y).toBeCloseTo(0, 9);
			}
		}
	});

	it('keeps the bounds centred on the pivot however the view is turned', () => {
		// 绕角落旋转会让堆叠在画布上横扫；本性质使旋转视图无需重新适配。
		const slabs = layout(null);
		for (const yaw of [0, 45 * DEG, 120 * DEG]) {
			const bounds = stackedBounds(camera({ yaw, pitch: 40 * DEG }), slabs);
			const centreX = (bounds[0]!.x + bounds[1]!.x) / 2;
			expect(centreX).toBeCloseTo(0, 6);
		}
	});

	it('grows the storeys apart symmetrically when spacing changes', () => {
		// 间距同样以 pivot 为中心施加，因此拉开堆叠不会跑出画布顶部。
		const slabs = layout(null, { spacing: 2 });
		const pivot = stackPivot(slabs);
		const zs = slabs.map((s) => s.z - pivot.z);
		expect(zs[0]!).toBeCloseTo(-zs[1]!, 6);
	});
});

describe('projectBox', () => {
	it('is the plan\'s own rectangle, unrotated and untilted', () => {
		const view = camera({ yaw: 0, pitch: 0 });
		const quad = projectBox(view, { x: 10, y: 20, w: 100, h: 50 }, 30);
		// 俯仰为 0 时高度不产生位移，见 `projectPoint`。
		expect(quad).toEqual([
			{ x: 10, y: 20 },
			{ x: 110, y: 20 },
			{ x: 110, y: 70 },
			{ x: 10, y: 70 }
		]);
	});

	it('turns into a parallelogram when the view is turned', () => {
		const view = camera({ yaw: 30 * DEG, pitch: 20 * DEG });
		const quad = projectBox(view, { x: 0, y: 0, w: 100, h: 100 }, 0);
		// 对边保持平行，这正是每层一个 `ctx.transform` 精确成立而非近似的原因。
		const d1 = { x: quad[1]!.x - quad[0]!.x, y: quad[1]!.y - quad[0]!.y };
		const d2 = { x: quad[2]!.x - quad[3]!.x, y: quad[2]!.y - quad[3]!.y };
		expect(d1.x).toBeCloseTo(d2.x, 9);
		expect(d1.y).toBeCloseTo(d2.y, 9);
	});
});

/**
 * 每个接入点获得的标记，使用记录型上下文而非像素：标记本身就是其几何形状，
 * 即按安装方式取平面图的形状，投影到楼层自身的平面。
 */
class RecordingContext {
	arcs: Array<{ x: number; y: number; r: number }> = [];
	moves: Array<{ x: number; y: number }> = [];
	lines: Array<{ x: number; y: number }> = [];

	arc(x: number, y: number, r: number) {
		this.arcs.push({ x, y, r });
	}
	moveTo(x: number, y: number) {
		this.moves.push({ x, y });
	}
	lineTo(x: number, y: number) {
		this.lines.push({ x, y });
	}
	beginPath() {}
	closePath() {}
	save() {}
	restore() {}
	transform() {}
	scale() {}
	rect() {}
	clip() {}
	fill() {}
	stroke() {}
	fillText() {}
	drawImage() {}
}

type MarkerAp = FloorCardSource['aps'][number];

/** 绘制带这些接入点的一层楼，不旋转也不俯仰。 */
function markers(aps: MarkerAp[], over: Partial<StackCamera> = {}): RecordingContext {
	const ctx = new RecordingContext();
	const layer = new StackedFloorsLayer(new FloorCardCache());
	layer.visible = true;
	// 没有平面图与掩码：本测试只关心标记，而掩码 URL 会让卡片缓存构造 `Image`，
	// 单元测试环境没有该对象。
	const floor: FloorCardSource = {
		id: 'f1',
		name: 'Floor 1',
		planUrl: null,
		planOffsetX: 0,
		planOffsetY: 0,
		maskUrl: null,
		materialUrl: null,
		defaultMaterial: 0,
		maskOriginX: 0,
		maskOriginY: 0,
		maskWidth: 0,
		maskHeight: 0,
		wupm: WUPM,
		aps,
		elevation: 0
	};
	layer.setFloors([floor], floor.id, WUPM);
	layer.camera = camera({ yaw: 0, pitch: 0, ...over });
	layer.render({
		ctx: ctx as unknown as CanvasRenderingContext2D,
		camera: {
			getTransform: () => [1, 0, 0, 1, 0, 0],
			state: { zoom: 1 }
		}
	} as unknown as RenderContext);
	return ctx;
}

/**
 * 标记实际绘制的内容：用不含接入点的相同渲染结果做减法得到。
 *
 * 楼层自身的轮廓与标签也是路径，计入它们会使关于标记形状的断言整体偏移一个常量。
 */
function markerDrawing(aps: MarkerAp[], over: Partial<StackCamera> = {}) {
	const full = markers(aps, over);
	const bare = markers([], over);
	return {
		arcs: full.arcs.length - bare.arcs.length,
		moves: full.moves.length - bare.moves.length,
		lines: full.lines.length - bare.lines.length,
		/** 最后绘制的路径，即标记，因为标记最后绘制。 */
		first: full.moves[full.moves.length - 1]!,
		rest: full.lines.slice(full.lines.length - 3)
	};
}

const ap = (over: Partial<MarkerAp>): MarkerAp => ({
	x: 100,
	y: 100,
	band: '5ghz',
	assignedChannel: 36,
	...over
});

describe('stacked view: access point markers', () => {
	it('draws a ceiling unit as the dot it is, with no plate', () => {
		const drawn = markerDrawing([ap({ mount: 'ceiling', mountHeightM: 0 })]);
		expect(drawn.arcs).toBe(1);
		expect(drawn.moves).toBe(0);
		expect(drawn.lines).toBe(0);
	});

	it('draws a wall unit as a plate, not a circle', () => {
		const drawn = markerDrawing([ap({ mount: 'wall', mountHeightM: 0, facingDeg: 0 })]);
		expect(drawn.arcs).toBe(0);
		// 一个四边形：一次 move 与三条线，最后闭合回第一个角。
		expect(drawn.moves).toBe(1);
		expect(drawn.lines).toBe(3);
	});

	it('lies the plate along the wall, so the facing turns it', () => {
		const extents = (drawn: ReturnType<typeof markerDrawing>) => {
			const xs = [drawn.first, ...drawn.rest].map((p) => p.x);
			const ys = [drawn.first, ...drawn.rest].map((p) => p.y);
			return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
		};

		// 朝向 +x：在 x 方向很薄，沿墙方向（y）较长。
		const alongX = extents(markerDrawing([ap({ mount: 'wall', mountHeightM: 0, facingDeg: 0 })]));
		expect(alongX.h).toBeGreaterThan(alongX.w * 2);

		// 朝向 +y：同一面板旋转四分之一圈。
		const alongY = extents(markerDrawing([ap({ mount: 'wall', mountHeightM: 0, facingDeg: 90 })]));
		expect(alongY.w).toBeGreaterThan(alongY.h * 2);
	});

	it('turns the plate with the room, not with the screen', () => {
		// 偏航会旋转楼层平面。在屏幕空间绘制的四边形会保持第一条边水平，而这个四边形随平面一起转动。
		const level = markerDrawing([ap({ mount: 'wall', mountHeightM: 0, facingDeg: 0 })]);
		expect(Math.abs(level.rest[0]!.y - level.first.y)).toBeCloseTo(0, 6);

		const turned = markerDrawing([ap({ mount: 'wall', mountHeightM: 0, facingDeg: 0 })], {
			yaw: 30 * DEG
		});
		expect(Math.abs(turned.rest[0]!.y - turned.first.y)).toBeGreaterThan(0.5);
	});
});


describe('empty floor cards', () => {
	it('uses a compact box instead of a plan-sized blank slab', () => {
		const cards = new FloorCardCache();
		const empty = { ...sources(1)[0]!, maskUrl: null, maskWidth: 0, maskHeight: 0, aps: [] };
		expect(cards.contentBox(empty)).toEqual({ minX: 0, minY: 0, w: 320, h: 240 });
	});
});
