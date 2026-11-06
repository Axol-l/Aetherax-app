import { decodeMask } from '$canvas/mask-codec.js';
import { decodeMaterialMask } from '$canvas/region-labels.js';
import { rasteriseWalls, DEFAULT_WALL_BAND } from './wall-raster.js';
import { floorState } from './floor-state.svelte.js';

/**
 * 按楼层缓存的已解码墙体掩码。
 */

export interface DecodedFloorMask {
	wallData: Uint8Array;
	materialMap: Uint8Array | null;
	/**
	 * 同一像素网格上的房间类型 id；楼层没有就为 null。
	 */
	roomTypeData: Uint8Array | null;
	width: number;
	height: number;
	originX: number;
	originY: number;
	sourceKey: string; // 用来判断缓存是否失效
}

/**
 * 存储掩码的身份标识，让缓存键能看出它被换掉了。
 */
const maskIds = new WeakMap<object, number>();
let nextMaskId = 1;
function maskId(mask: object | null | undefined): number {
	if (!mask) return 0;
	let id = maskIds.get(mask);
	if (id === undefined) {
		id = nextMaskId++;
		maskIds.set(mask, id);
	}
	return id;
}

const floorMaskCache = new Map<string, DecodedFloorMask>();

/**
 * 楼层墙线段数组的身份标识，用来缓存推导出的掩码。
 */
const wallsIds = new WeakMap<object, number>();
let nextWallsId = 1;
function wallsId(walls: object | null | undefined): number {
	if (!walls) return 0;
	let id = wallsIds.get(walls);
	if (id === undefined) {
		id = nextWallsId++;
		wallsIds.set(walls, id);
	}
	return id;
}

/**
 * 取某个楼层解码后的墙体掩码。
 */
export async function getFloorMask(floorId: string): Promise<DecodedFloorMask | null> {
	const floor = floorState.floors.find((f) => f.id === floorId);

	/*
	 * 有存储掩码就沿用它的坐标系；没有就用线段自己的包围盒，那是这种没有图纸的楼层最早
	 * 写掩码时用的坐标系。
	 */
	const walls = floor?.walls ?? [];
	const columns = floor?.columns ?? [];
	if (walls.length > 0 || columns.length > 0) {
		const stored = floor?.wallMask;
		const rtMask = floor?.roomTypeMask;
		// 空数组不算一种身份：`floor.columns ?? []` 每次调用都是新数组，拿它做键会永远
		// 命中不了缓存。
		const key = `${floorId}:walls${wallsId(walls)}:cols${columns.length > 0 ? wallsId(columns) : 0}:${stored ? `${stored.width}x${stored.height}@${stored.originX ?? 0},${stored.originY ?? 0}` : 'own'}:rt${maskId(rtMask)}`;
		const cached = floorMaskCache.get(floorId);
		if (cached && cached.sourceKey === key) return cached;

		const masks = rasteriseWalls(
			walls.map((wall) => ({
				ax: wall.ax,
				ay: wall.ay,
				bx: wall.bx,
				by: wall.by,
				material: wall.material
			})),
			DEFAULT_WALL_BAND,
			8,
			stored
				? {
						width: stored.width,
						height: stored.height,
						originX: stored.originX ?? 0,
						originY: stored.originY ?? 0
					}
				: undefined,
			columns.map((column) => ({
				shape: column.shape,
				ax: column.ax,
				ay: column.ay,
				bx: column.bx,
				by: column.by,
				material: column.material
			}))
		);
		if (masks) {
			const entry: DecodedFloorMask = {
				wallData: masks.wall,
				materialMap: masks.material,
				roomTypeData: await decodeRoomTypes(rtMask, masks.width, masks.height),
				width: masks.width,
				height: masks.height,
				originX: masks.originX,
				originY: masks.originY,
				sourceKey: key
			};
			floorMaskCache.set(floorId, entry);
			return entry;
		}
	}

	/*
	 * 墙不是线段的楼层，用它存着的掩码。
	 */
	if (!floor?.wallMask) return null;
	const wm = floor.wallMask;
	const rtMask = floor.roomTypeMask;
	const key = `${floorId}:${wm.width}x${wm.height}:${wm.originX ?? 0},${wm.originY ?? 0}:${floor.wallMaterial}:rt${maskId(rtMask)}`;
	const cached = floorMaskCache.get(floorId);
	if (cached && cached.sourceKey === key) return cached;

	const decoded = await decodeMask(wm.dataUrl, wm.width, wm.height);
	const mm = floor.materialMask;
	const matMask = mm ? await decodeMaterialMask(mm.dataUrl, mm.width, mm.height) : null;
	const entry: DecodedFloorMask = {
		wallData: decoded.data,
		materialMap: matMask,
		roomTypeData: await decodeRoomTypes(rtMask, wm.width, wm.height),
		width: decoded.width,
		height: decoded.height,
		originX: wm.originX ?? 0,
		originY: wm.originY ?? 0,
		sourceKey: key
	};
	floorMaskCache.set(floorId, entry);
	return entry;
}

/**
 * 解码存储的房间类型掩码，前提是它和墙掩码在同一张网格上。不满足就当成「没有房间数据」。
 */
async function decodeRoomTypes(
	rtMask: { dataUrl: string; width: number; height: number } | null | undefined,
	width: number,
	height: number
): Promise<Uint8Array | null> {
	if (!rtMask || rtMask.width !== width || rtMask.height !== height) return null;
	return decodeMaterialMask(rtMask.dataUrl, rtMask.width, rtMask.height);
}

/** 墙体变化时让掩码缓存失效。 */
export function invalidateSolverMaskCache(): void {
	floorMaskCache.clear();
}
