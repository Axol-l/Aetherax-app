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
	/** 逐区域的自定义名称：regionId → 名称（画布上显示）。 */
	roomCustomLabels: Record<string, string>;
	/**
	 * 用户指定的本层范围，世界坐标下的多边形。
	 */
	planningArea?: Array<{ x: number; y: number }> | null;
	/**
	 * 钉在这层楼上的备注
	 */
	notes?: Array<{ id: string; x: number; y: number; text: string }>;
	/**
	 * 墙
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
	/** 柱子 */
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
	 * 抬高的可行走面：夹层、楼梯、坡道
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
	// 新楼层继承当前楼层的标定
	const current = floorState.floors.find((f) => f.id === floorState.currentFloorId);
	floor.calibration = current?.calibration ?? null;
	floorState.floors.push(floor);
	renumberFloors();
	return floor;
}

type FloorRemovedHook = (floorId: string) => void;
let floorRemovedHook: FloorRemovedHook | null = null;

export function onFloorRemoved(hook: FloorRemovedHook): void {
	floorRemovedHook = hook;
}

/** 按 id 删除楼层 */
export function removeFloor(id: string): void {
	if (floorState.floors.length <= 1) return;
	floorState.floors = floorState.floors.filter((f) => f.id !== id);
	renumberFloors();
	if (floorState.currentFloorId === id) {
		floorState.currentFloorId = floorState.floors[0]!.id;
	}
	floorRemovedHook?.(id);
}

/** 切到某一层 */
export function switchFloor(id: string): void {
	if (floorState.floors.some((f) => f.id === id)) {
		floorState.currentFloorId = id;
	}
}

/**
 * 算两层之间、某个频段的楼板总衰减（dB）。
 *
 * 多层隔离并不随楼板数量线性增长。ITU-R P.1238-12 说穿过多层楼板的隔离有个上限，
 * 因为信号能沿楼外绕过去，绕行总损耗比各层楼板相加还低。
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
	for (let i = lo; i < hi; i++) {
		// 第 `i` 层和第 `i + 1` 层之间的层间，是第 `i + 1` 层自己的楼板
		const slabDb = boundarySlabLossDb(i + 1, band);
		totalDb += i === lo ? slabDb : Math.min(slabDb, ADDITIONAL_FLOOR_DB);
	}
	return totalDb;
}

/**
 * 某层可行走面高出最低层的距离，米。
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
 * 一层楼上的 AP 到另一层客户端之间的垂直距离，米
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
 * 一层楼上的 AP 到另一层客户端，路径在哪一层换层
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
 * 按竖向顺序排列楼层，最低的在前
 */
export function floorsByLevel(): Floor[] {
	return [...floorState.floors].sort((a, b) => a.level - b.level);
}

/**
 * 层序里第 `index` 层楼楼板的材料损耗。
 */
export function boundarySlabLossDb(index: number, band: Band): number {
	const owner = floorsByLevel()[index];
	if (!owner) return 0;
	const mat = FLOOR_MATERIALS[owner.floorMaterial];
	// 厚度这个判断必须有，厚度为 0 或负数，总损耗就不为正
	const thickness = owner.floorThickness > 0 ? owner.floorThickness : 0.2;
	return mat ? (mat.dbPerMeter[band] ?? 100) * thickness : 20;
}

/**
 * 把整层楼按世界坐标的位移平移
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
