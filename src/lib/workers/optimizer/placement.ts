/**
 * AP 能放在哪，以及它和采样点之间的墙要多少损耗。
 *
 * 穿墙缓存、壁挂带、内部吸附都是纯几何：读掩码和上下文，返回数字，不含搜索状态。
 */
import type { Band } from '@aetherax/channels';
import { getMaterialDbTable, isVirtualMaterial, type WallMaterialId } from '$lib/domain/materials.js';
import { rayMarchWallAtten } from '../../rf/propagation.js';
import type { InteriorField, WallCache, WallPlacement } from './types.js';

/** 源的位置量化网格，单位是掩码像素。 */
const SOURCE_GRID = 8;

export function createWallCache(
	mask: Uint8Array,
	w: number,
	h: number,
	samples: Array<{ x: number; y: number }>,
	wallAttenuation: number,
	band: Band,
	materialMask: Uint8Array | null,
	defaultMaterial: number
): WallCache {
	// 按频段取材料表：每种材料穿一次多少 dB。`rayMarchWallAtten` 和热力图算的是同一张。
	const materialDb = getMaterialDbTable(band);
	// 没有材料掩码时每面墙损耗一样，就用项目自己设的穿墙损耗，别拿石膏板的值顶。
	const defaultDb = materialMask
		? (materialDb[defaultMaterial] ?? wallAttenuation)
		: wallAttenuation;

	const numSamples = samples.length;
	const rows = new Map<string, Float32Array>();

	return {
		band,
		tableFor(x: number, y: number): Float32Array {
			const qx = Math.round(x / SOURCE_GRID);
			const qy = Math.round(y / SOURCE_GRID);
			const key = qx + ',' + qy;
			const hit = rows.get(key);
			if (hit) return hit;

			const sx = qx * SOURCE_GRID;
			const sy = qy * SOURCE_GRID;
			const row = new Float32Array(numSamples);
			for (let s = 0; s < numSamples; s++) {
				// 步长 3 的 DDA，粗算用；第 3 阶段会精确重算。
				row[s] = rayMarchWallAtten(
					mask,
					w,
					h,
					materialMask,
					materialDb,
					defaultDb,
					sx,
					sy,
					samples[s]!.x,
					samples[s]!.y,
					3,
					defaultMaterial
				);
			}
			rows.set(key, row);
			return row;
		}
	};
}

/** 带内像素的朝向，单位度；不在带内返回 null。 */
export function facingAt(placement: WallPlacement, x: number, y: number, w: number, h: number): number | null {
	const ix = Math.round(x);
	const iy = Math.round(y);
	if (ix < 0 || iy < 0 || ix >= w || iy >= h) return null;
	const step = placement.facingStep[iy * w + ix]!;
	return step === 255 ? null : step * 22.5;
}

/**
 * 靠墙那一圈地面，以及每个点朝哪个方向。
 *
 * `inside` 要用*没修剪过*的内部区域——修剪过的已经把这一圈让出去了。扩散是 8 邻域、
 * 最多 `radiusWu` 步，所以只扫一遍带子，不用把整张掩码做膨胀。
 */
export function buildWallPlacement(
	wallMask: Uint8Array,
	inside: Uint8Array,
	w: number,
	h: number,
	radiusWu: number,
	/**
	 * 墙体像素的材料和楼层默认值，调用方给了才用。
	 *
	 * **虚拟隔断**只是建模线，不挡信号也拧不上支架。这些像素不作为种子，带子就不会
	 * 贴着它生成。见 `wall-snap.ts`，应用侧用的是同一条规则。
	 */
	materialMap: Uint8Array | null = null,
	defaultMaterial = 0
): WallPlacement | null {
	const n = w * h;
	const radius = Math.max(1, Math.min(64, Math.round(radiusWu)));
	const band = new Uint8Array(n);
	const facingStep = new Uint8Array(n).fill(255);
	const dist = new Int16Array(n).fill(-1);
	const seedX = new Int16Array(n);
	const seedY = new Int16Array(n);
	const queue = new Int32Array(n);
	let head = 0;
	let tail = 0;

	for (let i = 0; i < n; i++) {
		if (!wallMask[i]) continue;
		if (materialMap) {
			const material = materialMap[i] ?? defaultMaterial;
			if (isVirtualMaterial(material as WallMaterialId)) continue;
		}
		dist[i] = 0;
		queue[tail++] = i;
	}
	if (tail === 0) return null;

	while (head < tail) {
		const idx = queue[head++]!;
		const d = dist[idx]!;
		if (d >= radius) continue;
		const x = idx % w;
		const y = (idx / w) | 0;
		for (let dy = -1; dy <= 1; dy++) {
			const ny = y + dy;
			if (ny < 0 || ny >= h) continue;
			for (let dx = -1; dx <= 1; dx++) {
				if (dx === 0 && dy === 0) continue;
				const nx = x + dx;
				if (nx < 0 || nx >= w) continue;
				const nIdx = ny * w + nx;
				if (dist[nIdx] !== -1) continue;
				// 扩散只在地面里走：墙像素是种子、不是通道，
				// 从另一面墙起走会把带子推过厚墙进到后面的房间。
				if (!inside[nIdx]) continue;
				dist[nIdx] = d + 1;
				// 种子像素跟着一起传，朝向才是背离真正够到它的那面墙，
				// 而不是背离别的墙。
				const sx0 = d === 0 ? x : seedX[idx]!;
				const sy0 = d === 0 ? y : seedY[idx]!;
				seedX[nIdx] = sx0;
				seedY[nIdx] = sy0;
				band[nIdx] = 1;
				const vx = nx - sx0;
				const vy = ny - sy0;
				if (vx !== 0 || vy !== 0) {
					const deg = (Math.atan2(vy, vx) * 180) / Math.PI;
					facingStep[nIdx] = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
				}
				queue[tail++] = nIdx;
			}
		}
	}

	let any = false;
	for (let i = 0; i < n; i++) {
		if (band[i]) {
			any = true;
			break;
		}
	}
	if (!any) return null;
	return { band, field: buildInteriorField(band, w, h), facingStep };
}

/**
 * 最近室内像素的查找场。
 *
 * `snapToInterior` 以前每次调用都要扫一遍所有室内像素，是 O(P)，而 P 常在几万到几十万，
 * 这个查找又要被调 `PSO_ITERS * SWARM * numAps` 量级的次数。改成在掩码上跑多源 BFS，
 * 查一次就是 O(1)。
 *
 * BFS 用 8 邻域，所以给出的距离是切比雪夫式的近似，不是精确欧氏距离。这里够用：
 * 吸附只在搜索步子迈出建筑时才决定落到哪，而且第 3 阶段还会拿 `interior` 把候选再校验一遍。
 */
export function buildInteriorField(interior: Uint8Array, w: number, h: number): InteriorField {
	const n = w * h;
	const nearest = new Int32Array(n).fill(-1);
	const queue = new Int32Array(n);
	let head = 0;
	let tail = 0;

	// 初始化：每个内部像素先指向自己。
	for (let i = 0; i < n; i++) {
		if (interior[i]) {
			nearest[i] = i;
			queue[tail++] = i;
		}
	}

	// 多源 BFS。每个像素最多入队一次，队列开 n 就够。
	while (head < tail) {
		const idx = queue[head++]!;
		const src = nearest[idx]!;
		const x = idx % w;
		const y = (idx / w) | 0;
		for (let dy = -1; dy <= 1; dy++) {
			const ny = y + dy;
			if (ny < 0 || ny >= h) continue;
			for (let dx = -1; dx <= 1; dx++) {
				if (dx === 0 && dy === 0) continue;
				const nx = x + dx;
				if (nx < 0 || nx >= w) continue;
				const nIdx = ny * w + nx;
				if (nearest[nIdx] !== -1) continue;
				nearest[nIdx] = src;
				queue[tail++] = nIdx;
			}
		}
	}

	return { nearest, w, h };
}

/**
 * 把位置吸附到建筑内部。
 *
 * 先夹到掩码范围内，这一步不能省：BFS 场覆盖掩码内每个像素，夹过再查表一定落在内部。
 * 以前不夹，掩码外的点原样返回，而 PSO 的初始抖动（`+/- max(w,h) * 0.2`，可能加在靠边的
 * 位置上）很容易造出这种点；第 3 阶段只接受落在内部的移动、也跳过越界候选，
 * 于是被 PSO 放到外面的 AP 再也回不来。
 */
export function snapToInterior(
	x: number,
	y: number,
	field: InteriorField,
	allowOutside: boolean
): { x: number; y: number } {
	if (allowOutside) return { x: Math.round(x), y: Math.round(y) };

	const ix = Math.min(field.w - 1, Math.max(0, Math.round(x)));
	const iy = Math.min(field.h - 1, Math.max(0, Math.round(y)));
	const src = field.nearest[iy * field.w + ix]!;
	if (src >= 0) return { x: src % field.w, y: (src / field.w) | 0 };
	// 只有掩码里完全没有内部区域才会走到这儿，调用方开始前会拦住这种情况。
	return { x: ix, y: iy };
}

/**
 * 判断一个 AP 能不能占这个位置的唯一入口。
 *
 * 边界判断故意留着，虽然 `interior` 也能挡住大部分：x 为负时 `y * w + x` 会串到上一行，
 * 可能正好读到一个真正的内部像素，去掉边界检查就会把越界坐标当合法。
 * 集中到这里，替掉搜索里到处散落的 `nx < 0 || nx >= w`。
 */
export function isPositionAllowed(
	x: number,
	y: number,
	interior: Uint8Array | null,
	w: number,
	h: number,
	allowOutside: boolean,
	voidMask: Uint8Array | null = null
): boolean {
	if (x < 0 || x >= w || y < 0 || y >= h) return false;
	// void 是楼板上的洞——中庭、楼梯井——没地方装 AP。这是物理事实不是房间偏好，
	// 所以即使用户允许 AP 放在楼层边界外，这里也不放行。
	if (voidMask && voidMask[y * w + x] === 1) return false;
	if (allowOutside || !interior) return true;
	return interior[y * w + x] === 1;
}

/**
 * 把某个 AP 的候选位置吸附到它被允许的区域里。
 *
 * 壁挂 AP 的可用区域是沿墙一圈，而不是内部：靠墙的位置正是内部区域特意剔掉的。
 * 带子约一个支架深，搜索放进去的位置本来就在墙上，调用方应用结果时再精确贴到墙面。
 */
export function snapForAp(
	a: number,
	x: number,
	y: number,
	wallMounted: boolean[],
	snapTarget: { field: InteriorField; free: boolean },
	wallPlacement: WallPlacement | null
): { x: number; y: number } {
	if (wallMounted[a] && wallPlacement) return snapToInterior(x, y, wallPlacement.field, false);
	return snapToInterior(x, y, snapTarget.field, snapTarget.free);
}

/** 这个 AP 能不能占这个位置——拆分规则和 `snapForAp` 一样。 */
export function allowedForAp(
	a: number,
	x: number,
	y: number,
	wallMounted: boolean[],
	wallPlacement: WallPlacement | null,
	interior: Uint8Array | null,
	w: number,
	h: number,
	allowOutside: boolean,
	voidMask: Uint8Array | null
): boolean {
	if (wallMounted[a] && wallPlacement) {
		if (x < 0 || x >= w || y < 0 || y >= h) return false;
		// void 是楼板上的洞：井道上方没有墙可装，掩码说旁边有墙也不行。
		if (voidMask && voidMask[y * w + x] === 1) return false;
		return wallPlacement.band[y * w + x] === 1;
	}
	return isPositionAllowed(x, y, interior, w, h, allowOutside, voidMask);
}

/**
 * AP 能吸附到哪儿，以及到底要不要吸附。
 *
 * 以前 `allowOutside` 的答案是「随便放」，结果 AP 落到中庭上。有 void 时改成
 * 「除了洞以外都行」：找最近的实地像素，可能落在房间外。
 */
export function buildSnapTarget(
	interior: Uint8Array,
	voidMask: Uint8Array | null,
	w: number,
	h: number,
	allowOutside: boolean
): { field: InteriorField; free: boolean } {
	if (!allowOutside) return { field: buildInteriorField(interior, w, h), free: false };
	if (!voidMask) return { field: buildInteriorField(interior, w, h), free: true };
	const solid = new Uint8Array(w * h);
	for (let i = 0; i < solid.length; i++) solid[i] = voidMask[i] === 1 ? 0 : 1;
	return { field: buildInteriorField(solid, w, h), free: false };
}
