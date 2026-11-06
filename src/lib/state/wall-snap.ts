/**
 * 找离某个点最近的墙，并给出这面墙的朝向。
 *
 * 壁挂 AP 的正面要背对安装面，所以「装在哪」和「朝哪」都来自一次测量：最近的墙体像素。
 * 朝向取墙点到放置点的方向（背离墙、指向房间）。
 */
import { normaliseBearing, wrap180 } from '../rf/antenna.js';
import { isVirtualMaterial, type WallMaterialId } from '$lib/domain/materials.js';
import { wallDistanceTransform, type WallDistanceTransform } from '$canvas/wall-distance.js';
import { getFloorMask } from './floor-mask.js';
import { floorState } from './floor-state.svelte.js';
import { wallState } from './wall-state.svelte.js';

export interface WallSnap {
	/** 量到的墙上那个点，世界坐标单位。 */
	x: number;
	y: number;
	/**
	 * AP 本身该放的位置：墙上那个点再往房间退一个支架的深度。AP 要是落在墙体像素里，它
	 * 每条射线（包括只离开正面的那些）都会多付一次穿墙损耗，所以要稍微让开墙面。
	 */
	apX: number;
	apY: number;
	/** 查询点到墙的距离，世界坐标单位。 */
	distanceW: number;
	/** 从 +x 转向 +y 的角度，方向背离墙。 */
	facingDeg: number;
}

/** 建模时 AP 离墙面多远，单位米。 */
export const WALL_MOUNT_OFFSET_M = 0.1;

/**
 * 优化器沿墙搜索的带宽，单位米。
 *
 * 故意比支架本身宽：搜索会让 AP 沿着墙、绕着拐角滑动，这个带是它能动的范围，不是摆放位置。
 * 最终位置之后再用编辑器那套测量贴回墙面。带宽要是比搜索的步长还窄（Lloyd 移动、PSO 抖动、
 * 精修的 5→1 单位步进），它就没地方可挪了。
 */
export const WALL_BAND_M = 0.5;

/**
 * 点击离墙多远之内还算「点在墙上」，单位米。
 *
 * 放宽一点，瞄墙时不用像素级精确；又收紧一点，点房间中间会被拒绝，而不是瞬移到最近的墙上
 * ——那样看起来像编辑器无视了用户点的位置。
 */
export const WALL_MOUNT_REACH_M = 1;

/**
 * 存下的朝向和墙自身朝向差多少以内，就当成是从墙推出来的、不是手转过的。
 *
 * 拖拽时用：本来正对墙的支架会跟着墙走；用户手动转过、想顺着走廊看的，则保留他给的角度。
 */
export const DERIVED_FACING_TOLERANCE_DEG = 15;

/**
 * 从已经建好的距离变换里，找离某个世界坐标点最近的墙。
 *
 * 纯函数、同步，所以拖拽时每次指针移动都能调。距离变换归调用方持有：每帧重建太浪费，视图
 * 那边本来就在为标注维护一份。
 */
export function wallSnapFrom(
	transform: WallDistanceTransform | null,
	originX: number,
	originY: number,
	worldX: number,
	worldY: number,
	wupm: number
): WallSnap | null {
	if (!transform) return null;
	const hit = transform.query(Math.round(worldX - originX), Math.round(worldY - originY));
	if (!hit) return null;
	const x = originX + hit.x;
	const y = originY + hit.y;
	const dx = worldX - x;
	const dy = worldY - y;
	const onTheWall = Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6;
	const facingDeg = onTheWall ? 0 : normaliseBearing((Math.atan2(dy, dx) * 180) / Math.PI);
	const offset = WALL_MOUNT_OFFSET_M * wupm;
	return {
		x,
		y,
		apX: x + Math.cos((facingDeg * Math.PI) / 180) * offset,
		apY: y + Math.sin((facingDeg * Math.PI) / 180) * offset,
		distanceW: hit.distance,
		facingDeg
	};
}

/** 存下的朝向是否和这面墙给的一致，也就是没被手动转过。 */
export function facingFollowsWall(facingDeg: number, wall: WallSnap): boolean {
	return Math.abs(wrap180(facingDeg - wall.facingDeg)) <= DERIVED_FACING_TOLERANCE_DEG;
}

/**
 * 一份距离变换缓存，按它来源的掩码区分。
 *
 * 距离变换每个掩码像素占 8 字节，每次调用重建不现实，缓存很多份也不现实。`sourceKey` 标识
 * 栅格；墙体编辑中的实时掩码固定用 `'live'`，因为它的像素一直在变，这种情况不缓存。
 */
let cache: { key: string; transform: WallDistanceTransform | null } | null = null;

function transformFor(key: string, data: Uint8Array, width: number, height: number) {
	if (key === 'live') return wallDistanceTransform(data, width, height);
	if (cache && cache.key === key) return cache.transform;
	const transform = wallDistanceTransform(data, width, height);
	cache = { key, transform };
	return transform;
}

/**
 * 壁挂 AP 能贴的墙：所有墙，去掉不是表面的那些。
 *
 * **虚拟隔断**只是建模用的——它不衰减任何东西，只用来划分同一开放空间里的区域。它没有
 * 可拧支架的表面，所以壁挂 AP 不能贴上去：朝向会从一条两边都辐射的线推出来，AP 会站在
 * 房间中间对着空气。
 *
 * 单独导出，方便直接看这条规则；下面的距离变换就是基于它建的。
 */
export function attachableWallMask(
	wallData: Uint8Array,
	materialMap: Uint8Array | null,
	defaultMaterial: number
): Uint8Array {
	if (!materialMap) return wallData;
	const attachable = new Uint8Array(wallData.length);
	for (let i = 0; i < wallData.length; i++) {
		if (!wallData[i]) continue;
		const material = materialMap[i] ?? defaultMaterial;
		if (isVirtualMaterial(material as WallMaterialId)) continue;
		attachable[i] = 1;
	}
	return attachable;
}

/**
 * 这些墙的距离变换。
 *
 * 单独栅格化一份，因为距离变换只会回答「最近的墙」，没法问「最近的、不是虚拟隔断的墙」：
 * 那条线必须一开始就不存在。和普通变换一样，按掩码+材质的身份缓存。
 */
let attachableCache: {
	key: string;
	transform: WallDistanceTransform | null;
} | null = null;

function attachableTransformFor(
	key: string,
	wallData: Uint8Array,
	materialMap: Uint8Array | null,
	defaultMaterial: number,
	width: number,
	height: number
) {
	if (!materialMap) return transformFor(key, wallData, width, height);
	const materialKey = `${key}|mat|${defaultMaterial}`;
	if (materialKey !== 'live' && attachableCache && attachableCache.key === materialKey) {
		return attachableCache.transform;
	}
	const transform = wallDistanceTransform(
		attachableWallMask(wallData, materialMap, defaultMaterial),
		width,
		height
	);
	if (materialKey !== 'live') attachableCache = { key: materialKey, transform };
	return transform;
}

/** 楼层里离某个世界坐标点最近的墙；需要时顺带解码该楼层的掩码。 */
export async function wallSnapForFloor(
	floorId: string,
	x: number,
	y: number,
	wupm: number
): Promise<WallSnap | null> {
	const mask = await getFloorMask(floorId);
	if (!mask) return null;
	// 楼层自己的默认材质，当前在看的楼层用实时值：和画布给墙着色时的选择一致。
	const floor = floorState.floors.find((f) => f.id === floorId);
	const defaultMaterial =
		floorId === floorState.currentFloorId
			? (wallState.wallMaterial ?? floor?.wallMaterial ?? 0)
			: (floor?.wallMaterial ?? 0);
	const transform = attachableTransformFor(
		mask.sourceKey,
		mask.wallData,
		mask.materialMap,
		defaultMaterial,
		mask.width,
		mask.height
	);
	return wallSnapFrom(transform, mask.originX, mask.originY, x, y, wupm);
}
