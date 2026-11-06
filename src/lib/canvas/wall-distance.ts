/**
 * 计算某点到最近墙体的距离以及该墙体的位置，供接入点标注使用。
 * 使用精确欧氏距离变换；掩码像素即世界单位，字段布局为 1 = 墙体、0 = 可通行。
 */

import type { DecodedWallMask } from './mask-codec.js';

/** 最近墙体上的一点（掩码像素坐标）及其距离。 */
export interface NearestWallPixel {
	/** 距离，单位是掩码像素，也就是世界单位。 */
	distance: number;
	/** 最近的墙体像素本身，使用掩码像素坐标。 */
	x: number;
	y: number;
}

export interface WallDistanceTransform {
	readonly width: number;
	readonly height: number;
	/**
	 * 查询某个掩码像素最近的墙体像素；空掩码或大到无法变换的掩码没有墙体可测量，返回 null。
	 */
	query(px: number, py: number): NearestWallPixel | null;
}

/**
 * 掩码像素数超过该值时跳过变换而不尝试。
 * 此尺寸已超出应用其余部分的承受范围，变换所需的临时数组每像素占 8 字节。
 */
const MAX_TRANSFORM_PIXELS = 16_000_000;

/**
 * “该列没有墙”的整数哨兵值。
 * 距离以平方形式保存，平方距离是整数，因此用 `Int32Array` 精确承载；该值只需大于所有真实平方距离，
 * 并留出 `f + q²` 不越界的余量。
 */
const NO_WALL = 1 << 30;

/** 构建变换；没有可供测量的墙体时返回 null。 */
export function wallDistanceTransform(
	data: Uint8Array,
	width: number,
	height: number
): WallDistanceTransform | null {
	if (width <= 0 || height <= 0) return null;
	if (width * height > MAX_TRANSFORM_PIXELS) return null;
	if (data.length < width * height) return null;
	if (!data.some((v) => v !== 0)) return null;

	// 同一列内到最近墙体的平方距离，以及该墙体的行号。
	// 第一遍沿列向下再向上做最近邻扫描，不需要第二遍的包络结构。
	const columnDistance = new Int32Array(width * height);
	const columnSource = new Int32Array(width * height);
	for (let x = 0; x < width; x++) {
		let last = -1;
		for (let y = 0; y < height; y++) {
			const i = y * width + x;
			if (data[i] !== 0) last = y;
			columnDistance[i] = last < 0 ? NO_WALL : (y - last) * (y - last);
			columnSource[i] = last;
		}
		last = -1;
		for (let y = height - 1; y >= 0; y--) {
			const i = y * width + x;
			if (data[i] !== 0) last = y;
			if (last < 0) continue;
			const d = (y - last) * (y - last);
			if (d < columnDistance[i]!) {
				columnDistance[i] = d;
				columnSource[i] = last;
			}
		}
	}

	/*
	 * 第二遍：在每一行内合并各列，每个像素的答案是 x' 上 (x - x')² + columnDistance(x') 的最小值。
	 * 这是一组抛物线的下包络；`source` 随每条抛物线携带墙体行，因此获胜的抛物线也给出墙体像素。
	 */
	const distance = new Int32Array(width * height);
	const source = new Int32Array(width * height);
	const vertices = new Int32Array(width);
	const boundaries = new Float64Array(width + 1);
	const rowInput = new Int32Array(width);
	const rowSource = new Int32Array(width);

	for (let y = 0; y < height; y++) {
		const row = y * width;
		for (let x = 0; x < width; x++) {
			rowInput[x] = columnDistance[row + x]!;
			rowSource[x] = columnSource[row + x]!;
		}

		let k = -1;
		for (let q = 0; q < width; q++) {
			const fq = rowInput[q]!;
			if (fq >= NO_WALL) continue;
			if (k < 0) {
				k = 0;
				vertices[0] = q;
				boundaries[0] = -Infinity;
				boundaries[1] = Infinity;
				continue;
			}
			let s = 0;
			for (;;) {
				const p = vertices[k]!;
				s = (fq + q * q - (rowInput[p]! + p * p)) / (2 * (q - p));
				if (s > boundaries[k]!) break;
				k--;
				if (k < 0) break;
			}
			if (k < 0) {
				k = 0;
				vertices[0] = q;
				boundaries[0] = -Infinity;
				boundaries[1] = Infinity;
			} else {
				k++;
				vertices[k] = q;
				boundaries[k] = s;
				boundaries[k + 1] = Infinity;
			}
		}

		if (k < 0) {
			// 该行没有任何一列碰到墙。
			for (let x = 0; x < width; x++) {
				distance[row + x] = NO_WALL;
				source[row + x] = -1;
			}
			continue;
		}

		let j = 0;
		for (let x = 0; x < width; x++) {
			while (boundaries[j + 1]! < x) j++;
			const p = vertices[j]!;
			distance[row + x] = (x - p) * (x - p) + rowInput[p]!;
			// 获胜的抛物线位于列 p，并携带它测得的墙体行，二者合起来给出墙体像素。
			source[row + x] = rowSource[p]! * width + p;
		}
	}

	return {
		width,
		height,
		query(px: number, py: number): NearestWallPixel | null {
			if (px < 0 || py < 0 || px >= width || py >= height) return null;
			const i = py * width + px;
			const squared = distance[i]!;
			const wallIndex = source[i]!;
			if (squared >= NO_WALL || wallIndex < 0) return null;
			const x = wallIndex % width;
			return { distance: Math.sqrt(squared), x, y: (wallIndex - x) / width };
		}
	};
}

/**
 * 针对某个掩码的变换缓存，跨调用复用。
 * `version` 是调用方的失效计数器，不可省略：光栅会被原地修补并返回同一个 `Uint8Array`，
 * 只比较引用会复用已经过期的距离场。
 */
export interface WallDistanceCache {
	transform: WallDistanceTransform | null;
	data: Uint8Array | null;
	width: number;
	height: number;
	version: number;
}

/** 供视图持有的空缓存槽。 */
export function createWallDistanceCache(): WallDistanceCache {
	return { transform: null, data: null, width: 0, height: 0, version: -1 };
}

/** 返回 `mask` 在 `version` 下的变换，仅在任一者变化时重建。 */
export function cachedWallDistanceTransform(
	cache: WallDistanceCache,
	mask: DecodedWallMask | null,
	version: number
): WallDistanceTransform | null {
	if (!mask) {
		cache.transform = null;
		cache.data = null;
		cache.width = 0;
		cache.height = 0;
		cache.version = version;
		return null;
	}
	if (
		cache.data === mask.data &&
		cache.width === mask.width &&
		cache.height === mask.height &&
		cache.version === version
	) {
		return cache.transform;
	}
	cache.transform = wallDistanceTransform(mask.data, mask.width, mask.height);
	cache.data = mask.data;
	cache.width = mask.width;
	cache.height = mask.height;
	cache.version = version;
	return cache.transform;
}

/**
 * 朝面向方向两侧最近的一堵墙；图纸先到头时返回 null。
 * 测量壁挂接入点旁边还有多少墙：沿 `facingDeg ± 90` 前进，取较近的一侧，正前方的对墙不测量。
 */
export function nearestSideWall(
	data: Uint8Array,
	width: number,
	height: number,
	originX: number,
	originY: number,
	worldX: number,
	worldY: number,
	facingDeg: number,
	maxW: number
): FirstWallHit | null {
	const right = firstWallAlong(
		data,
		width,
		height,
		originX,
		originY,
		worldX,
		worldY,
		facingDeg + 90,
		maxW
	);
	const left = firstWallAlong(
		data,
		width,
		height,
		originX,
		originY,
		worldX,
		worldY,
		facingDeg - 90,
		maxW
	);
	if (!right) return left;
	if (!left) return right;
	return left.distanceW < right.distanceW ? left : right;
}

/** 从某点出发的射线首次碰到墙体的位置，单位是世界单位。 */
export interface FirstWallHit {
	x: number;
	y: number;
	/** 从起点到该墙体的距离，单位是世界单位。 */
	distanceW: number;
}

/**
 * 沿某个方位角遇到的第一堵墙；射线先离开图纸时返回 null。
 * 这是壁挂接入点所需的投射距离；每半个世界单位采样一次，避免斜向射线从像素间穿过而误报。
 */
export function firstWallAlong(
	data: Uint8Array,
	width: number,
	height: number,
	originX: number,
	originY: number,
	worldX: number,
	worldY: number,
	bearingDeg: number,
	maxW: number
): FirstWallHit | null {
	if (width <= 0 || height <= 0 || data.length < width * height) return null;
	const rad = (bearingDeg * Math.PI) / 180;
	const dx = Math.cos(rad);
	const dy = Math.sin(rad);
	const step = 0.5;
	for (let d = 0; d <= maxW; d += step) {
		const px = Math.round(worldX - originX + dx * d);
		const py = Math.round(worldY - originY + dy * d);
		// 离开图纸：没有可继续测量的对象。
		if (px < 0 || py < 0 || px >= width || py >= height) return null;
		if (data[py * width + px] === 1) {
			const x = originX + px;
			const y = originY + py;
			// 返回到命中的像素而非发现它的步进点，因为两者最多相差半步，
			// 而返回的点正是标注连接线指向的位置。
			return { x, y, distanceW: Math.hypot(x - worldX, y - worldY) };
		}
	}
	return null;
}
