/**
 * 判断一个点是否在楼内。
 */
import { debug } from '$lib/log.js';
import { sealOpenings } from '$canvas/morphology.js';
import { buildRoomDomain } from '$canvas/rooms.js';
import { maskContentSignature } from '$canvas/mask-registry.js';
import { isVoidRoomType } from '$lib/domain/room-types.js';
import { wupmForFloor } from './ap-state.svelte.js';
import { getFloorMask } from './floor-mask.js';
import { minRoomRadiusWu } from './room-domain.js';
import { isUsablePlanningArea, pointInPlanningArea } from './planning-area.js';
import { floorState } from './floor-state.svelte.js';

/**
 * 仍算作房间的最宽开口的一半，单位米。
 */
const SEAL_RADIUS_M = 0.75;

interface CachedInterior {
	/** 算出这份结果时用的掩码标识；重新检测过的平面图会因它而失效。 */
	key: string;
	width: number;
	height: number;
	/** 掩码像素 (0,0) 对应的世界坐标；换算时像素坐标 = 世界坐标减 origin。 */
	originX: number;
	originY: number;
	interior: Uint8Array;
}

const cache = new Map<string, CachedInterior>();

/**
 * 每个楼层正在进行中的计算
 */
const inFlight = new Map<string, Promise<CachedInterior | null>>();

async function interiorFor(floorId: string): Promise<CachedInterior | null> {
	const pending = inFlight.get(floorId);
	if (pending) return pending;
	const run = computeInterior(floorId).finally(() => inFlight.delete(floorId));
	inFlight.set(floorId, run);
	return run;
}

async function computeInterior(floorId: string): Promise<CachedInterior | null> {
	const decoded = await getFloorMask(floorId);
	if (!decoded) return null;
	const cached = cache.get(floorId);
	const maskKey = maskContentSignature(decoded);
	if (cached && cached.key === maskKey) return cached;

	/*
	 * 半径由项目比例算出；重新标定后比例会变，
	 * 所以它既通过掩码进了上面的缓存键，也直接参与这里的计算。
	 */
	const wupm = wupmForFloor(floorId);
	const sealRadius = Math.max(1, Math.round(SEAL_RADIUS_M * wupm));
	const interiorStarted = performance.now();
	const sealed = sealOpenings(decoded.wallData, decoded.width, decoded.height, sealRadius);
	const { interior } = buildRoomDomain(sealed, decoded.width, decoded.height, {
		minRegionRadius: minRoomRadiusWu(floorId),
		trimWallAdjacent: true
	});
	debug(
		`[interior] ${decoded.width}×${decoded.height} in ${Math.round(performance.now() - interiorStarted)} ms`
	);
	const roomTypes = decoded.roomTypeData;
	if (roomTypes && roomTypes.length === interior.length) {
		for (let i = 0; i < interior.length; i++) {
			if (interior[i] && isVoidRoomType(roomTypes[i]!)) interior[i] = 0;
		}
	}

	const entry: CachedInterior = {
		key: `${maskKey}:seal${sealRadius}`,
		width: decoded.width,
		height: decoded.height,
		originX: decoded.originX,
		originY: decoded.originY,
		interior
	};
	cache.set(floorId, entry);
	return entry;
}

/**
 * 世界坐标点是否在该楼层检测出的室内。
 * 没有墙体掩码的楼层无从判断，一律算在室内。
 */
export async function isInsideInterior(floorId: string, x: number, y: number): Promise<boolean> {
	/*
	 * 手画过规划区域就以它为准
	 */
	const planned = floorState.floors.find((f) => f.id === floorId)?.planningArea;
	if (isUsablePlanningArea(planned)) return pointInPlanningArea({ x, y }, planned);

	const entry = await interiorFor(floorId);
	if (!entry) return true;
	const ix = Math.round(x - entry.originX);
	const iy = Math.round(y - entry.originY);
	if (ix < 0 || ix >= entry.width || iy < 0 || iy >= entry.height) return false;
	return entry.interior[iy * entry.width + ix] === 1;
}

/** 丢掉某楼层缓存的内域；掩码被替换或楼层被删除时用。 */
export function forgetInterior(floorId: string): void {
	cache.delete(floorId);
}

