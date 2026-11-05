/**
 * 楼层状态。
 *
 * 定义 Floor 的数据结构、楼层的增删与切换，以及楼层之间的楼板（层间）损耗和高度换算。
 */
import type { FloorMaterialId } from '$canvas/floor-materials.js';
import type { WallMaterialId } from '$lib/domain/materials.js';
import { FLOOR_MATERIALS } from '$canvas/floor-materials.js';
import { crossFloorSplit } from '$lib/rf/cross-floor.js';
import type { ElevatedSurface } from '$lib/rf/surface-height.js';
import type { Band } from '@aetherax/channels';

export interface Floor {
	id: string;
	name: string;
	level: number;
	ceilingHeight: number; // 米（住宅默认 3.0，商业 3.5）
	floorThickness: number; // 米（楼板厚度，默认 0.2）
	floorMaterial: FloorMaterialId;
	floorplanUrl: string | null;
	floorplanScale: number;
	/**
	 * 底图图片画在世界坐标里的哪个位置。
	 *
	 * 以前图片被钉在 (0, 0)，结果两层楼只有图纸外边距碰巧一致时才对得齐。
	 * `translateFloor` 会把这个偏移和掩码、AP 一起移动，所以整层楼是刚性平移。
	 */
	floorplanOffsetX: number;
	floorplanOffsetY: number;
	calibration: { worldUnitsPerMeter: number } | null;
	floorplanBoundary: Array<{ x: number; y: number }> | null;
	wallMask: {
		dataUrl: string;
		width: number;
		height: number;
		originX: number;
		originY: number;
	} | null;
	/**
	 * 墙底下的材料分辨不出来时，一面墙按多少 dB 算。
	 *
	 * 不是"这层每面墙的衰减"，虽然名字和几处传它的注释读起来像那个意思。墙的损耗
	 * 来自刷在它下面的材料（`canvas/materials.ts`），只有那个材料 id 在表里查不到
	 * 时才用这个数 —— 比如用户拿自定义材料刷墙、之后又把材料删了：id 还在材料掩码里，
	 * 没有兜底这些墙就一点都不衰减。
	 *
	 * 界面上已经没地方改它了；它跟着文档、载荷和覆盖计算一路传下去，是为了老项目
	 * 留住作者当初选的值。要删得先定"材料被删的墙该按多少算"，再做文档迁移，
	 * 不能直接删。
	 */
	wallAttenuation: number;
	wallMaterial: WallMaterialId;
	materialMask: {
		dataUrl: string;
		width: number;
		height: number;
		originX: number;
		originY: number;
	} | null;
	roomTypeMask: {
		dataUrl: string;
		width: number;
		height: number;
		originX: number;
		originY: number;
	} | null;
	/** 逐区域的密度覆盖：regionId → 台/平方米（盖掉房间类型的默认值）。 */
	roomDensityOverrides: Record<string, number>;
	/** 逐区域的自定义名称：regionId → 名称（画布上显示它，而不是类型简称）。 */
	roomCustomLabels: Record<string, string>;
	/**
	 * 用户指定的本层范围，世界坐标下的多边形。
	 *
	 * null 表示"没画"：这时由墙体推内部区域，干净的图纸这样又对又省事。画了就以
	 * 多边形为准判内外 —— 提示、布点、（优化器那边的）定义域都听它的 —— 轮廓上
	 * 有大开口，或者墙里围了不是房间的空腔时，只有这个办法靠得住。
	 * 见 `state/planning-area.ts`。
	 */
	planningArea?: Array<{ x: number; y: number }> | null;
	/**
	 * 钉在这层楼上的备注：图纸上说不出来的一句话。
	 *
	 * 按楼层存，因为备注说的是某层某个位置 —— "电梯厅那扇是钢门"放到楼上去就没意义了。
	 * 用世界坐标，所以跟着图纸一起平移缩放，也随项目一起保存。
	 */
	notes?: Array<{ id: string; x: number; y: number; text: string }>;
	/**
	 * 墙，用线段表示 —— 这才是模型（见 `state/vector-walls.ts`）。
	 *
	 * 栅格掩码是从这些线段派生的，所以它们才是楼层的几何：画、移、删一条线段，
	 * 掩码就重栅格化一次，其他东西读的都是那份掩码。
	 */
	walls?: Array<{
		id: string;
		ax: number;
		ay: number;
		bx: number;
		by: number;
		material: number;
		heightM?: number;
	}>;
	/** 柱子：一条线表达不了的承重障碍。 */
	columns?: Array<{
		id: string;
		shape: 'rect' | 'circle';
		/** 对角两点；圆的话 `a` 是圆心、`b` 是边上一点。 */
		ax: number;
		ay: number;
		bx: number;
		by: number;
		material: number;
	}>;
	/**
	 * 抬高的可行走面：夹层、楼梯、坡道。
	 *
	 * 户型图是平的，模型以前也是平的 —— 每个客户端都站在楼板上。这里是它高出楼板
	 * 多少，客户端到 AP 的垂直落差就由它构成。几何和缘由见 `rf/surface-height.ts`。
	 */
	surfaces?: ElevatedSurface[];
}

function createDefaultFloor(id?: string, name?: string): Floor {
	return {
		id: id ?? crypto.randomUUID(),
		name: name ?? 'Floor 1',
		level: 0,
		ceilingHeight: 3.0,
		floorThickness: 0.2,
		floorMaterial: 1, // 混凝土楼板
		floorplanUrl: null,
		floorplanScale: 0.4,
		floorplanOffsetX: 0,
		floorplanOffsetY: 0,
		calibration: null,
		floorplanBoundary: null,
		wallMask: null,
		wallAttenuation: 5,
		wallMaterial: 0,
		materialMask: null,
		roomTypeMask: null,
		roomDensityOverrides: {},
		roomCustomLabels: {},
		planningArea: null,
		surfaces: []
	};
}

const defaultFloor = createDefaultFloor();

export const floorState = $state({
	floors: [defaultFloor] as Floor[],
	currentFloorId: defaultFloor.id
});

/** 取当前选中的楼层。 */
export function currentFloor(): Floor {
	return floorState.floors.find((f) => f.id === floorState.currentFloorId) ?? floorState.floors[0]!;
}

/** 按 id 取楼层。 */
export function getFloor(id: string): Floor | undefined {
	return floorState.floors.find((f) => f.id === id);
}

/**
 * 按当前数组顺序，把 level 重排成连续的 0..n-1。
 *
 * `level` 是算楼板衰减用的竖向排序键。一旦它不连续（比如删掉中间一层留下空档），
 * 像 `findIndex(s => s.level === f.level + 1)` 这种查找会静默地找不到东西，两层之间
 * 的楼板损耗直接塌成 0 dB。所以要一直维持这个不变式。
 */
function renumberFloors(): void {
	floorState.floors.forEach((f, i) => {
		f.level = i;
	});
}

/** 新增一层楼，返回这层新楼层。 */
export function addFloor(name?: string): Floor {
	const level = floorState.floors.length;
	const floor = createDefaultFloor(undefined, name ?? `Floor ${level + 1}`);
	floor.level = level;
	// 新楼层是从当前这层加出来的，属于同一栋楼、同一个比例尺，所以继承那层的标定，
	// 而不是用没标定的默认值。标定本身是按楼层存的：不同分辨率导进来的图纸可以单独
	// 标定，不影响已经量好的其他楼层。
	const current = floorState.floors.find((f) => f.id === floorState.currentFloorId);
	floor.calibration = current?.calibration ?? null;
	floorState.floors.push(floor);
	renumberFloors();
	return floor;
}

/**
 * 楼层被删时，模块外面得有人知道。
 *
 * 删一层还有第二件事：该楼层自己那个 key 下存的底图。只有存储层知道 key 的规矩，
 * 但它不能在这里 import（`persistence` 读了本模块，再 import 就成环），所以改成它
 * 往这里注册，由 `removeFloor` 回调。以前是两个 UI 调用点各自记着清理 ——
 * 那就是两处都可能忘。
 */
type FloorRemovedHook = (floorId: string) => void;
let floorRemovedHook: FloorRemovedHook | null = null;

export function onFloorRemoved(hook: FloorRemovedHook): void {
	floorRemovedHook = hook;
}

/** 按 id 删除楼层。最后一层删不掉。调用方要自己清理相关 AP。 */
export function removeFloor(id: string): void {
	if (floorState.floors.length <= 1) return;
	floorState.floors = floorState.floors.filter((f) => f.id !== id);
	renumberFloors();
	if (floorState.currentFloorId === id) {
		floorState.currentFloorId = floorState.floors[0]!.id;
	}
	floorRemovedHook?.(id);
}

/** 切到某一层。 */
export function switchFloor(id: string): void {
	if (floorState.floors.some((f) => f.id === id)) {
		floorState.currentFloorId = id;
	}
}

/**
 * 算两层之间、某个频段的楼板总衰减（dB）。
 *
 * 按竖向顺序走一遍楼层、累加楼板损耗。用下标而不是拿 level 做算术，这样即使 level
 * 哪天不连续也算得对。
 *
 * 多层隔离并不随楼板数量线性增长。ITU-R P.1238-12 说穿过多层楼板的隔离有个上限，
 * 因为信号能沿楼外绕过去，绕行总损耗比各层楼板相加还低。它实测的办公场景数字很直观：
 *
 *   1.8-2 GHz : Lf = 15 + 4(n-1) dB   （每多一层加 4 dB，不是再加 15 dB）
 *   5.8 GHz   : 1 层 22 dB，2 层 28 dB   （多一层加 6 dB）
 *
 * 所以第一块楼板算全损耗，之后每多一层只加一小截。以前每层都按整块楼板相加，
 * 5 GHz 下两块混凝土楼板算出 40 dB，而 ITU 量的是 28 dB。
 */
const ADDITIONAL_FLOOR_DB = 5;

export function getFloorSlabAttenuation(floorIdA: string, floorIdB: string, band: Band): number {
	if (floorIdA === floorIdB) return 0;
	const sorted = floorsByLevel();
	const ia = sorted.findIndex((f) => f.id === floorIdA);
	const ib = sorted.findIndex((f) => f.id === floorIdB);
	if (ia < 0 || ib < 0 || ia === ib) return 0;

	const lo = Math.min(ia, ib);
	const hi = Math.max(ia, ib);
	let totalDb = 0;
	// 每跨一层，用的都是上面那层楼的楼板，也就是循环从 `lo` 走到 `hi - 1` 时下标为
	// `i` 的那层。`boundarySlabLossDb` 和豁免份额是同一次材料查表，两边不会各算各的。
	for (let i = lo; i < hi; i++) {
		// 第 `i` 层和第 `i + 1` 层之间的层间，是第 `i + 1` 层自己的楼板：两层之间的
		// 楼板归上面那层，材料和厚度都存在那层。下标搞错就会把层间算到底下那层头上，
		// 而且所有调用方会一起错，全楼同材料的项目根本看不出来。
		const slabDb = boundarySlabLossDb(i + 1, band);
		// 第一层：算整块楼板损耗。之后每层：只加有上限的一小截。
		totalDb += i === lo ? slabDb : Math.min(slabDb, ADDITIONAL_FLOOR_DB);
	}
	return totalDb;
}

/**
 * 某层可行走面高出最低层的距离，米。
 *
 * 算出来而不是存下来：`level` 已经负责排序，`ceilingHeight` 已经是每层自己的，
 * 再存一个高程就可能跟它们对不上。按层序，第 k 层的楼板平面就在第 k-1 层天花板顶上。
 */
export function floorElevation(floorId: string): number {
	const sorted = [...floorState.floors].sort((a, b) => a.level - b.level);
	let z = 0;
	for (const f of sorted) {
		if (f.id === floorId) return z;
		z += f.ceilingHeight;
	}
	return z;
}

/**
 * 一层楼上的 AP 到另一层客户端之间的垂直距离，米。
 *
 * 第 i 层的 AP 在该层行走面上方 `apHeightM` 处 —— `elevation(i) + apHeightM` ——
 * 客户端在它所在楼层上方 `clientHeight` 处。项目建模了挂高时，`apHeightM` 就是 AP
 * 自己的安装高度；没建模就取该层天花板，也就是下面这套天花板安装几何一直假设的值。
 * 调用方从 `apHeightAboveFloor` 拿。
 *
 * 以前的做法是把中间几层的 ceilingHeight 加起来，结果 AP 落在上层楼板平面上而不是
 * 天花板，客户端也贴在楼板上而不是上方。漏掉的正巧是这里要建模的天花板安装几何，
 * 三层楼里合起来差了 1.5 m 左右。
 *
 * 同层返回 0：同层路径按平层处理，挂高要不要改这一点，由调用方决定。
 */
export function crossFloorVerticalGap(
	apFloorId: string,
	clientFloorId: string,
	clientHeight: number,
	apHeightM?: number
): number {
	if (apFloorId === clientFloorId) return 0;
	const apFloor = getFloor(apFloorId);
	const clientFloor = getFloor(clientFloorId);
	if (!apFloor || !clientFloor) return 0;
	const apZ = floorElevation(apFloorId) + (apHeightM ?? apFloor.ceilingHeight);
	const clientZ = floorElevation(clientFloorId) + clientHeight;
	return Math.abs(apZ - clientZ);
}

/**
 * 每个楼层平面（各层行走面）高出最低层多少，米，最低的在前。
 *
 * 就是 `floorElevation` 那套累加，这里一次性给整组：跨楼层射线分段需要射线可能穿过的
 * *所有*平面，不只是起点和终点那两层。
 */
export function floorPlaneHeights(): number[] {
	const sorted = [...floorState.floors].sort((a, b) => a.level - b.level);
	const planes: number[] = [];
	let z = 0;
	for (const f of sorted) {
		planes.push(z);
		z += f.ceilingHeight;
	}
	return planes;
}

/**
 * 一层楼上的 AP 到另一层客户端，路径在哪一层换层。
 *
 * `apHeightM` 是 AP 高出它自己那层楼板的高度 —— 项目没建模挂高时取什么值，见
 * `crossFloorVerticalGap`，就是一直假设的该层天花板。
 *
 * 路径根本没离开客户端那层时，两个比例都是 0 —— AP 就在那层，或者在下面那层吸顶、
 * 起点本来就在客户端的楼板平面上。见 `rf/cross-floor.ts`。
 */
export function crossFloorSplitFor(
	apFloorId: string,
	clientFloorId: string,
	clientHeight: number,
	apHeightM?: number
): { sourceT: number; targetT: number } {
	if (apFloorId === clientFloorId) return { sourceT: 0, targetT: 0 };
	const apFloor = getFloor(apFloorId);
	const clientFloor = getFloor(clientFloorId);
	if (!apFloor || !clientFloor) return { sourceT: 0, targetT: 0 };
	const apZ = floorElevation(apFloorId) + (apHeightM ?? apFloor.ceilingHeight);
	const clientZ = floorElevation(clientFloorId) + clientHeight;
	return crossFloorSplit(apZ, clientZ, floorPlaneHeights());
}

/** 取与给定楼层相邻的楼层（level 上下差 1）。 */
export function adjacentFloors(floorId: string): Floor[] {
	const floor = getFloor(floorId);
	if (!floor) return [];
	return floorState.floors.filter((f) => f.id !== floorId && Math.abs(f.level - floor.level) === 1);
}

/**
 * 按竖向顺序排列楼层，最低的在前 —— 就是 `floorPlaneHeights` 用的那个顺序。
 * 之所以暴露出来，是因为把一次楼板跨越归到某层时，要的是那层的*下标*，不只是高程。
 */
export function floorsByLevel(): Floor[] {
	return [...floorState.floors].sort((a, b) => a.level - b.level);
}

/**
 * 层序里第 `index` 层楼**自己的**那块楼板的材料损耗。
 *
 * 按楼层索引，不按层间索引：第 `index - 1` 层和第 `index` 层之间的楼板是第 `index`
 * 层自己的楼板，材料和厚度都存在那层。调用方要传它想算的那个层间的上面那层。
 */
export function boundarySlabLossDb(index: number, band: Band): number {
	const owner = floorsByLevel()[index];
	if (!owner) return 0;
	const mat = FLOOR_MATERIALS[owner.floorMaterial];
	// 厚度这个判断必须有，因为 `slabLossFactor` 会拿它当分母：厚度为 0 或负数，
	// 总损耗就不为正，分出来的份额也不成比例。`getFloorAttenuation` 也这么防。
	const thickness = owner.floorThickness > 0 ? owner.floorThickness : 0.2;
	return mat ? (mat.dbPerMeter[band] ?? 100) * thickness : 20;
}

/**
 * 把整层楼按世界坐标的位移平移。
 *
 * 楼层对齐就是一次刚性平移：底图、墙体掩码和由它派生的一切、AP，全都一起动。这里是
 * 把位移直接烘进数据，而不是每个读取方各自加偏移，这是故意的。读取时才加偏移，就得
 * 让它穿过热力图、优化 worker、solver、墙体编辑器和每一种导出；哪一处漏了，就会拿
 * 平移后的几何去跟没平移的比 —— 之前那个掩码原点的 bug 正属于这一类。烘进去只留
 * 一个世界坐标系，所有读取方都不用改。
 *
 * 之所以敢烘，是因为 `TiledMask.fromFlat` 接受任意原点，掩码不必卡在 256 px 的
 * 分块网格上。原点写进去时会吸附到整像素 —— 掩码是像素栅格，原点带小数会让每次
 * 写入都静默失效 —— 所以对齐拖拽不会把墙留在半个像素的错位上。
 *
 * `aps` 是传进来的，不是 import 的：`ap-state` 已经 import 了本模块，反过来再拿
 * `apState` 就成环。撤销状态也得调用方先压好。
 */
/**
 * 原点挪过的掩码，返回**新对象**。
 *
 * 原点也是掩码含义的一部分，而应用里每个由掩码派生的缓存都按对象做键
 * （见 `canvas/mask-registry.ts`）：原点原地改过的掩码，在它们看来还是移动前那个。
 */
function shiftMask<T extends { originX: number; originY: number }>(
	mask: T | null,
	dx: number,
	dy: number
): T | null {
	if (!mask) return null;
	return { ...mask, originX: mask.originX + dx, originY: mask.originY + dy };
}

export function translateFloor(
	floorId: string,
	dx: number,
	dy: number,
	aps: Array<{ floorId: string; x: number; y: number }>
): void {
	if (dx === 0 && dy === 0) return;
	const floor = getFloor(floorId);
	if (!floor) return;

	floor.floorplanOffsetX += dx;
	floor.floorplanOffsetY += dy;

	/*
	 * 三张掩码是一起产出的、共用一个像素网格，所以同一个位移能让它们互相对得上。
	 *
	 * 换成新对象而不是原地改，原因跟下面那些线段一样：原点烘进了每个字段，而存这些
	 * 掩码的内部派生缓存是按掩码*身份*做键的。原地改的话对象没变，那些缓存就会一直
	 * 吐出按移动前位置量出来的几何 —— 只栅格化的楼层做过对齐后，热力图和覆盖率一直
	 * 读旧坐标系，就是这个毛病。见 `canvas/mask-registry.ts`。
	 */
	floor.wallMask = shiftMask(floor.wallMask, dx, dy);
	floor.materialMask = shiftMask(floor.materialMask, dx, dy);
	floor.roomTypeMask = shiftMask(floor.roomTypeMask, dx, dy);

	if (floor.floorplanBoundary) {
		for (const p of floor.floorplanBoundary) {
			p.x += dx;
			p.y += dy;
		}
	}

	/*
	 * 线段、柱子和图纸上其他画出来的东西也要跟着动。
	 *
	 * 现在掩码是从线段*派生*出来的，只移掩码不移线段，下次派生就把移动抹掉了：拖拽
	 * 对齐看着像弹回去，而叠层图和 3D 图 —— 它们画的是线段，不是掩码 —— 也一直停在
	 * 原地。
	 *
	 * 每个列表都换成新数组而不是原地改，因为派生掩码的缓存是按数组身份做键的：原地改
	 * 键没变，`getFloorMask` 就会还给你移动前那份掩码。
	 */
	if (floor.walls) {
		floor.walls = floor.walls.map((wall) => ({
			...wall,
			ax: wall.ax + dx,
			ay: wall.ay + dy,
			bx: wall.bx + dx,
			by: wall.by + dy
		}));
	}
	if (floor.columns) {
		floor.columns = floor.columns.map((column) => ({
			...column,
			ax: column.ax + dx,
			ay: column.ay + dy,
			bx: column.bx + dx,
			by: column.by + dy
		}));
	}
	if (floor.planningArea) {
		floor.planningArea = floor.planningArea.map((point) => ({
			x: point.x + dx,
			y: point.y + dy
		}));
	}
	if (floor.surfaces) {
		floor.surfaces = floor.surfaces.map((surface) => ({
			...surface,
			ax: surface.ax + dx,
			ay: surface.ay + dy,
			bx: surface.bx + dx,
			by: surface.by + dy
		}));
	}
	if (floor.notes) {
		floor.notes = floor.notes.map((note) => ({ ...note, x: note.x + dx, y: note.y + dy }));
	}

	for (const ap of aps) {
		if (ap.floorId !== floorId) continue;
		ap.x += dx;
		ap.y += dy;
	}
}
