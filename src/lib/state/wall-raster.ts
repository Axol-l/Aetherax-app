/**
 * 把矢量墙栅格化成掩码，让应用现有逻辑直接吃上矢量数据。
 *
 * 下游（热力图、优化器、覆盖采样、室内判定）都只读墙掩码和材质掩码，于是「线段是真相、
 * 掩码是推导」就落在这里：从线段喂给它们，它们不改算法就变成矢量驱动，而且一步能回退。
 */
import type { WallMaterialId } from '$lib/domain/materials.js';

export interface RasterWall {
	ax: number;
	ay: number;
	bx: number;
	by: number;
	material: number;
}

/** 栅格化时的柱：一个占地形状加一种材质。 */
export interface RasterColumn {
	shape: 'rect' | 'circle';
	ax: number;
	ay: number;
	bx: number;
	by: number;
	material: number;
}

export interface RasterisedMasks {
	wall: Uint8Array;
	material: Uint8Array;
	width: number;
	height: number;
	originX: number;
	originY: number;
}

/**
 * 把线段画进墙掩码和材质掩码。
 *
 * 带宽就是矢量层绘制时用的宽度，所以模型算的和图纸画的一致，不管墙是哪种方式录入的。材质
 * id 单独放一个数组：那里 0 表示「没画」，改用楼层默认材质——这个区分实测很关键。
 */
export function rasteriseWalls(
	walls: readonly RasterWall[],
	bandWidth = 6,
	padding = 8,
	extent?: { width: number; height: number; originX: number; originY: number },
	/**
	 * 要画成实心障碍的柱：墙墩是长度画不出来的墙，圆柱是一根线都没有的柱。它们要填充，
	 * 不是描边，因为挡路的是整个占地。
	 */
	columns: readonly RasterColumn[] = []
): RasterisedMasks | null {
	if (walls.length === 0 && columns.length === 0) return null;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const wall of walls) {
		minX = Math.min(minX, wall.ax, wall.bx);
		minY = Math.min(minY, wall.ay, wall.by);
		maxX = Math.max(maxX, wall.ax, wall.bx);
		maxY = Math.max(maxY, wall.ay, wall.by);
	}
	for (const column of columns) {
		// 圆会从拖到的那个点再往外伸一个半径，所以包围框每边都得加这么多，否则圆盘会被
		// 自己所在的掩码裁掉。
		const r =
			column.shape === 'circle' ? Math.hypot(column.bx - column.ax, column.by - column.ay) : 0;
		minX = Math.min(minX, column.ax - r, column.bx - r);
		minY = Math.min(minY, column.ay - r, column.by - r);
		maxX = Math.max(maxX, column.ax + r, column.bx + r);
		maxY = Math.max(maxY, column.ay + r, column.by + r);
	}
	if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;

	/*
	 * 有现成掩码时，尺寸就用*现有*掩码的，这点不是小事。
	 *
	 * 下游的一切——采样网格、热力图纹理、室内判定、覆盖率数值——都按图纸当初的掩码坐标系
	 * 定位。按墙的包围盒另起一个尺寸就是换了坐标系：采样点落到外面、场按错误的矩形生成，
	 * 热力图会变成 AP 周围一扇彩色，而不是铺在地板上。
	 */
	const originX = extent ? extent.originX : Math.floor(minX) - padding;
	const originY = extent ? extent.originY : Math.floor(minY) - padding;
	const width = extent ? extent.width : Math.max(1, Math.ceil(maxX - originX) + padding);
	const height = extent ? extent.height : Math.max(1, Math.ceil(maxY - originY) + padding);
	// 给工作尺寸封顶：否则一根跑得很远的杂散线段会分配几百万像素的掩码，把标签页卡死。
	if (width * height > 16_000_000) return null;

	const wall = new Uint8Array(width * height);
	const material = new Uint8Array(width * height);
	const radius = Math.max(1, Math.round(bandWidth / 2));

	for (const segment of walls) {
		const length = Math.hypot(segment.bx - segment.ax, segment.by - segment.ay);
		const steps = Math.max(1, Math.ceil(length));
		for (let i = 0; i <= steps; i++) {
			const t = i / steps;
			const cx = Math.round(segment.ax + (segment.bx - segment.ax) * t - originX);
			const cy = Math.round(segment.ay + (segment.by - segment.ay) * t - originY);
			for (let dy = -radius; dy <= radius; dy++) {
				for (let dx = -radius; dx <= radius; dx++) {
					const x = cx + dx;
					const y = cy + dy;
					if (x < 0 || y < 0 || x >= width || y >= height) continue;
					const index = y * width + x;
					wall[index] = 1;
					material[index] = segment.material;
				}
			}
		}

		/*
		 * 圆头：两端各补一个圆盘。
		 *
		 * 上面的方块是按四舍五入后的像素中心盖的，所以两根线段端点相距不到一个像素时，拐角
		 * 仍可能留个斜着的一像素小孔——一像素的孔射线就能穿过去，每个交点都会画出一道亮
		 * 刺。在端点补一个同半径的圆盘能把接头封上，又不改变别处的带宽。
		 */
		for (const end of [
			{ x: segment.ax - originX, y: segment.ay - originY },
			{ x: segment.bx - originX, y: segment.by - originY }
		]) {
			const ex = Math.round(end.x);
			const ey = Math.round(end.y);
			for (let dy = -radius; dy <= radius; dy++) {
				for (let dx = -radius; dx <= radius; dx++) {
					if (dx * dx + dy * dy > radius * radius) continue;
					const x = ex + dx;
					const y = ey + dy;
					if (x < 0 || y < 0 || x >= width || y >= height) continue;
					const index = y * width + x;
					wall[index] = 1;
					material[index] = segment.material;
				}
			}
		}
	}

	// 柱是填充的，不是描边：整个占地都算障碍。
	for (const column of columns) {
		const cx = column.ax - originX;
		const cy = column.ay - originY;
		/*
		 * 圆的边界是圆本身，不是拖拽框。
		 *
		 * 柱是从圆心拖到边缘的，两点之间的框只是一个象限——照它扫描只填了四分之一个圆盘，
		 * 而矢量层画的是整个圆，看起来就像「这根柱只挡了一半热力图」。现在按圆自己的外接
		 * 正方形扫。
		 */
		const circle = column.shape === 'circle';
		const radius = circle ? Math.hypot(column.bx - column.ax, column.by - column.ay) : 0;
		const x0 = circle ? cx - radius : Math.min(column.ax, column.bx) - originX;
		const x1 = circle ? cx + radius : Math.max(column.ax, column.bx) - originX;
		const y0 = circle ? cy - radius : Math.min(column.ay, column.by) - originY;
		const y1 = circle ? cy + radius : Math.max(column.ay, column.by) - originY;
		for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(height - 1, Math.ceil(y1)); y++) {
			for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(width - 1, Math.ceil(x1)); x++) {
				if (circle) {
					const px = x + 0.5;
					const py = y + 0.5;
					if ((px - cx) ** 2 + (py - cy) ** 2 > radius * radius) continue;
				}
				const index = y * width + x;
				wall[index] = 1;
				material[index] = column.material;
			}
		}
	}

	return { wall, material, width, height, originX, originY };
}

/**
 * 一张「这里没有墙」的掩码，坐标系用调用方已经知道的那个。
 *
 * 删掉最后一面墙时，必须清空掩码但不能挪坐标系：楼层上的每个标注、采样和房间类型都按那个
 * 坐标系定位，把掩码整个丢掉会被读成「这层没有图纸」，而不是「这层没有墙」。
 */
export function emptyWallMasks(extent: {
	width: number;
	height: number;
	originX: number;
	originY: number;
}): RasterisedMasks {
	const { width, height, originX, originY } = extent;
	return {
		wall: new Uint8Array(width * height),
		material: new Uint8Array(width * height),
		width,
		height,
		originX,
		originY
	};
}

/** 一像素宽的带，给测试用，也方便只关心几何时推理。 */
export function rasteriseThin(walls: readonly RasterWall[], padding = 2): RasterisedMasks | null {
	return rasteriseWalls(walls, 1, padding);
}

/** 线段一共盖了多少像素，调用方想粗略校验时用。 */
export function paintedPixels(masks: RasterisedMasks): number {
	let count = 0;
	for (let i = 0; i < masks.wall.length; i++) if (masks.wall[i]) count++;
	return count;
}

export const DEFAULT_WALL_BAND = 6;

export type { WallMaterialId };
